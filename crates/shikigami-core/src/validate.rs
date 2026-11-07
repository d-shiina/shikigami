//! Flow validation.
//!
//! Validation never mutates and never fails fast: it returns every issue so
//! that Studio can highlight them and AI clients can fix them in one round.
//! Errors block execution; warnings are advisory.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::expr::{self, Expr};
use crate::ids::StepId;
use crate::model::{Flow, SCHEMA_VERSION, Step, VarFormat, VarType, VariableDef};
use crate::registry::{StepRegistry, StepTypeDef, control, is_identifier};
use crate::requires::{self, PLUGIN_PREFIX};
use crate::secret::{self, SecretRef};

/// Name of the implicit variable holding the last error when `onError: continue`.
pub const LAST_ERROR_VAR: &str = "lastError";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ValidationIssue {
    pub severity: Severity,
    /// Stable machine-readable code, e.g. `UNKNOWN_STEP_TYPE`.
    pub code: String,
    pub message: String,
    /// JSON Pointer into the flow document.
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_id: Option<StepId>,
    /// How to fix it, written for AI clients (and shown to humans in Studio).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ValidationReport {
    pub valid: bool,
    pub issues: Vec<ValidationIssue>,
}

impl ValidationReport {
    pub fn error_count(&self) -> usize {
        self.issues
            .iter()
            .filter(|i| i.severity == Severity::Error)
            .count()
    }

    pub fn errors(&self) -> impl Iterator<Item = &ValidationIssue> {
        self.issues.iter().filter(|i| i.severity == Severity::Error)
    }
}

/// Validates flows against a step registry. Compiled parameter schemas
/// are cached, so keep one validator around rather than creating one per call.
pub struct Validator {
    registry: StepRegistry,
    schemas: HashMap<String, Result<jsonschema::Validator, String>>,
}

impl Validator {
    pub fn new(registry: StepRegistry) -> Self {
        let schemas = registry
            .iter()
            .map(|def| {
                let compiled =
                    jsonschema::validator_for(&def.params_schema).map_err(|e| e.to_string());
                (def.step_type.clone(), compiled)
            })
            .collect();
        Self { registry, schemas }
    }

    pub fn registry(&self) -> &StepRegistry {
        &self.registry
    }

    pub fn validate(&self, flow: &Flow) -> ValidationReport {
        let mut cx = Cx {
            validator: self,
            issues: Vec::new(),
            seen_ids: HashSet::new(),
            in_cases: false,
            known_vars: known_variables(flow, &self.registry),
            declared_vars: flow.variables.iter().map(|v| v.name.clone()).collect(),
            requires: flow.requires.clone(),
            parts: flow.parts.clone(),
        };
        cx.flow(flow);
        for issue in &mut cx.issues {
            if issue.hint.is_none() {
                issue.hint = generic_hint(&issue.code).map(str::to_owned);
            }
        }
        let valid = !cx.issues.iter().any(|i| i.severity == Severity::Error);
        ValidationReport {
            valid,
            issues: cx.issues,
        }
    }

    /// [`Self::validate`] plus the checks that need the flows it calls
    /// (`flow.call`): that they exist, are valid, do not call back, and
    /// take the inputs and give the outputs the call maps.
    pub fn validate_with_calls(
        &self,
        flow: &Flow,
        lookup: &dyn Fn(&crate::ids::FlowId) -> Option<Flow>,
    ) -> ValidationReport {
        let mut report = self.validate(flow);
        report
            .issues
            .extend(crate::call::check_calls(self, flow, lookup));
        report.valid = !report.issues.iter().any(|i| i.severity == Severity::Error);
        report
    }

    /// Structural integrity only (IDs and tree shape). Edits that break these
    /// invariants are rejected; other issues are allowed in drafts.
    pub fn structural_errors(&self, flow: &Flow) -> Vec<ValidationIssue> {
        self.validate(flow)
            .issues
            .into_iter()
            .filter(|i| {
                i.severity == Severity::Error && STRUCTURAL_CODES.contains(&i.code.as_str())
            })
            .collect()
    }
}

/// Issue codes that indicate a broken document rather than an incomplete one.
pub const STRUCTURAL_CODES: &[&str] = &["MISSING_STEP_ID", "INVALID_STEP_ID", "DUPLICATE_STEP_ID"];

/// Every variable name that can be in scope somewhere in the flow.
/// Scoping is intentionally flat (like most RPA tools): a name bound anywhere
/// is considered known everywhere; the Runtime reports actual undefined uses.
fn known_variables(flow: &Flow, registry: &StepRegistry) -> BTreeSet<String> {
    let mut names: BTreeSet<String> = flow.variables.iter().map(|v| v.name.clone()).collect();
    names.insert(LAST_ERROR_VAR.to_owned());
    names.insert("error".to_owned());
    for step in flow.walk() {
        if let Some(save_as) = &step.save_as {
            names.insert(save_as.clone());
        }
        if let Some(def) = registry.get(&step.step_type) {
            for key in &def.binds_variables {
                if let Some(Value::String(name)) = step.params.get(key) {
                    names.insert(name.clone());
                }
            }
        }
        names.extend(call_output_targets(step));
    }
    names
}

/// Variables of the calling flow that a `flow.call` writes (the
/// values of its `outputs` map).
pub(crate) fn call_output_targets(step: &Step) -> impl Iterator<Item = String> + '_ {
    (step.step_type == crate::registry::flow::CALL)
        .then(|| step.params.get("outputs").and_then(Value::as_object))
        .flatten()
        .into_iter()
        .flat_map(|map| map.values().filter_map(Value::as_str).map(str::to_owned))
}

struct Cx<'a> {
    validator: &'a Validator,
    issues: Vec<ValidationIssue>,
    seen_ids: HashSet<StepId>,
    known_vars: BTreeSet<String>,
    declared_vars: BTreeSet<String>,
    requires: BTreeMap<String, String>,
    parts: BTreeMap<String, crate::model::Part>,
    /// The steps being checked are the `cases` of a `control.switch`.
    in_cases: bool,
}

impl Cx<'_> {
    fn push(
        &mut self,
        severity: Severity,
        code: &str,
        message: String,
        path: String,
        step: Option<&StepId>,
    ) {
        self.issues.push(ValidationIssue {
            severity,
            code: code.to_owned(),
            message,
            path,
            step_id: step.filter(|id| !id.is_empty()).cloned(),
            hint: None,
        });
    }

    /// Attaches a context-specific hint to the issue pushed last.
    /// `format` and `choices`: how the run window asks for the variable.
    fn check_input_form(&mut self, var: &VariableDef, path: &str) {
        if let Some(format) = var.format {
            if !matches!(var.var_type, VarType::String | VarType::Any) {
                self.error(
                    "INVALID_VARIABLE_FORMAT",
                    format!(
                        "format of '{}' needs type string, not {:?}",
                        var.name, var.var_type
                    ),
                    format!("{path}/format"),
                    None,
                );
            } else if let Some(Value::String(text)) = &var.default
                && !text.is_empty()
                && !format_accepts(format, text)
            {
                self.error(
                    "INVALID_VARIABLE_FORMAT",
                    format!("default of '{}' is not a {}", var.name, format_name(format)),
                    format!("{path}/default"),
                    None,
                );
            }
        }
        if var.choices.is_empty() {
            return;
        }
        let choices = format!("{path}/choices");
        if !matches!(var.var_type, VarType::String | VarType::Number) {
            self.error(
                "INVALID_VARIABLE_CHOICES",
                format!(
                    "choices of '{}' need type string or number, not {:?}",
                    var.name, var.var_type
                ),
                choices,
                None,
            );
            return;
        }
        if var.secret || var.format.is_some() {
            self.error(
                "INVALID_VARIABLE_CHOICES",
                format!(
                    "'{}' has choices, so it cannot also be secret or have a format",
                    var.name
                ),
                choices.clone(),
                None,
            );
        }
        for (i, choice) in var.choices.iter().enumerate() {
            if !var.var_type.accepts(choice) {
                self.error(
                    "INVALID_VARIABLE_CHOICES",
                    format!(
                        "choice {choice} of '{}' does not match type {:?}",
                        var.name, var.var_type
                    ),
                    format!("{choices}/{i}"),
                    None,
                );
            } else if var.choices[..i].contains(choice) {
                self.error(
                    "INVALID_VARIABLE_CHOICES",
                    format!("choice {choice} of '{}' is listed twice", var.name),
                    format!("{choices}/{i}"),
                    None,
                );
            }
        }
        if let Some(default) = &var.default
            && !var.choices.contains(default)
        {
            self.error(
                "INVALID_VARIABLE_CHOICES",
                format!("default of '{}' is not one of its choices", var.name),
                format!("{path}/default"),
                None,
            );
        }
    }

    fn hint(&mut self, hint: impl Into<String>) {
        if let Some(issue) = self.issues.last_mut() {
            issue.hint = Some(hint.into());
        }
    }

    fn error(&mut self, code: &str, message: String, path: String, step: Option<&StepId>) {
        self.push(Severity::Error, code, message, path, step);
    }

    fn warn(&mut self, code: &str, message: String, path: String, step: Option<&StepId>) {
        self.push(Severity::Warning, code, message, path, step);
    }

    /// `requires`: well-formed, and satisfied by the installed plugins.
    /// Plugins that are missing altogether are reported on the steps that
    /// use them (`PLUGIN_NOT_INSTALLED`).
    fn requirements(&mut self) {
        let entries: Vec<(String, String)> = self
            .requires
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        for (key, range) in entries {
            let path = format!("/requires/{}", key.replace('~', "~0").replace('/', "~1"));
            match requires::check(&key, &range, &self.validator.registry) {
                requires::Check::Ok | requires::Check::Missing => {}
                requires::Check::BadKey => {
                    self.error(
                        "INVALID_REQUIREMENT",
                        format!("'{key}' is not a plugin requirement"),
                        path,
                        None,
                    );
                    self.hint("Keys are `plugin:<name>`. Core fills `requires` from the steps; remove this entry.");
                }
                requires::Check::BadRange(reason) => {
                    self.error(
                        "INVALID_REQUIREMENT",
                        format!("version range '{range}' of '{key}' is invalid: {reason}"),
                        path,
                        None,
                    );
                    self.hint("Write a semver range such as ^0.3.1 or >=1.2, <3.");
                }
                requires::Check::Mismatch { installed } => {
                    let name = key.trim_start_matches(PLUGIN_PREFIX);
                    self.error(
                        "PLUGIN_VERSION_MISMATCH",
                        format!(
                            "the flow needs plugin '{name}' {range}, but {installed} is installed"
                        ),
                        path,
                        None,
                    );
                    self.hint(format!(
                        "Install a version of '{name}' that matches {range}. If you checked that the steps work with {installed}, change the range with update_flow (patch.requires)."
                    ));
                }
            }
        }
    }

    fn flow(&mut self, flow: &Flow) {
        if flow.schema_version > SCHEMA_VERSION || flow.schema_version == 0 {
            self.error(
                "UNSUPPORTED_SCHEMA_VERSION",
                format!(
                    "schemaVersion {} is not supported (current: {SCHEMA_VERSION})",
                    flow.schema_version
                ),
                "/schemaVersion".into(),
                None,
            );
        }
        if !flow.id.is_well_formed() {
            self.error(
                "INVALID_FLOW_ID",
                "flow id must match [A-Za-z0-9_-]{1,128}".into(),
                "/id".into(),
                None,
            );
        }
        if flow.name.trim().is_empty() {
            self.error(
                "EMPTY_NAME",
                "flow name must not be empty".into(),
                "/name".into(),
                None,
            );
        }

        self.requirements();

        for (name, part) in &flow.parts {
            let path = format!("/parts/{name}");
            if !is_identifier(name) {
                self.error(
                    "INVALID_PART_NAME",
                    format!("part name '{name}' is not a valid identifier"),
                    path.clone(),
                    None,
                );
                self.hint("Use letters, digits and _ like a variable name (saveButton); put the words people use in `label`.".to_owned());
            }
            if part.target.is_null() {
                // The nodes that use it say so; an unused one only reminds.
                if !flow
                    .walk()
                    .any(|s| crate::model::target_part(s) == Some(name.as_str()))
                {
                    self.warn(
                        "PART_NOT_PICKED",
                        format!("part '{name}' has no target yet and no node uses it"),
                        format!("{path}/target"),
                        None,
                    );
                    self.hint("Pick it on the screen in Studio, or remove the part.".to_owned());
                }
            } else if !part.target.is_object() {
                self.error(
                    "INVALID_PART",
                    format!("part '{name}' needs a target object"),
                    format!("{path}/target"),
                    None,
                );
            }
        }

        let mut var_names = HashSet::new();
        for (i, var) in flow.variables.iter().enumerate() {
            let path = format!("/variables/{i}");
            if !is_identifier(&var.name) {
                self.error(
                    "INVALID_VARIABLE_NAME",
                    format!("'{}' is not a valid identifier", var.name),
                    format!("{path}/name"),
                    None,
                );
            }
            if !var_names.insert(var.name.as_str()) {
                self.error(
                    "DUPLICATE_VARIABLE",
                    format!("variable '{}' is declared twice", var.name),
                    format!("{path}/name"),
                    None,
                );
            }
            if var.secret && var.default.is_some() {
                self.error(
                    "SECRET_DEFAULT",
                    format!(
                        "secret variable '{}' has a default value, which is stored as plain text in the flow",
                        var.name
                    ),
                    format!("{path}/default"),
                    None,
                );
                self.hint("Remove `default`. For passwords, register a secret (Studio → シークレット) and type it with { \"secret\": \"<name>\", \"field\": \"password\" } as the value of browser.fill.");
            }
            if let Some(default) = &var.default
                && !var.var_type.accepts(default)
            {
                self.error(
                    "VARIABLE_TYPE_MISMATCH",
                    format!(
                        "default of '{}' does not match type {:?}",
                        var.name, var.var_type
                    ),
                    format!("{path}/default"),
                    None,
                );
            }
            self.check_input_form(var, &path);
        }

        if let Some(retry) = &flow.settings.default_retry
            && retry.max_attempts == 0
        {
            self.error(
                "INVALID_RETRY",
                "maxAttempts must be at least 1".into(),
                "/settings/defaultRetry/maxAttempts".into(),
                None,
            );
        }

        self.steps(&flow.steps, "/steps", 0);
    }

    fn steps(&mut self, steps: &[Step], path: &str, loop_depth: usize) {
        let in_cases = self.in_cases;
        for (i, step) in steps.iter().enumerate() {
            self.in_cases = in_cases;
            self.step(step, &format!("{path}/{i}"), loop_depth);
        }
        self.in_cases = false;
    }

    fn step(&mut self, step: &Step, path: &str, loop_depth: usize) {
        let in_cases = std::mem::take(&mut self.in_cases);
        let id = Some(&step.id);
        if step.id.is_empty() {
            self.error(
                "MISSING_STEP_ID",
                "step has no id".into(),
                format!("{path}/id"),
                None,
            );
        } else if !step.id.is_well_formed() {
            self.error(
                "INVALID_STEP_ID",
                format!("step id '{}' must match [A-Za-z0-9_-]{{1,128}}", step.id),
                format!("{path}/id"),
                None,
            );
        } else if !self.seen_ids.insert(step.id.clone()) {
            self.error(
                "DUPLICATE_STEP_ID",
                format!("step id '{}' is used more than once", step.id),
                format!("{path}/id"),
                id,
            );
        }

        if let Some(retry) = &step.retry
            && retry.max_attempts == 0
        {
            self.error(
                "INVALID_RETRY",
                "maxAttempts must be at least 1".into(),
                format!("{path}/retry/maxAttempts"),
                id,
            );
        }

        let namespace = requires::namespace(&step.step_type);
        let required = self
            .requires
            .get(&format!("{PLUGIN_PREFIX}{namespace}"))
            .cloned();
        if self.validator.registry.get(&step.step_type).is_none()
            && let Some(range) = required
            && self.validator.registry.plugin(namespace).is_none()
        {
            let message = format!(
                "step type '{}' comes from the plugin '{namespace}' ({range}), which is not installed on this PC",
                step.step_type
            );
            self.error("PLUGIN_NOT_INSTALLED", message, format!("{path}/type"), id);
            self.hint(format!(
                "Ask the user to install (or turn on) the '{namespace}' extension ({range}) in Studio (拡張機能), or run `shikigami plugin install <zip | URL | GitHub repository>`, then restart; `shikigami plugin list` shows what is installed and turned off. The step is kept as it is until then."
            ));
            for (name, children) in &step.blocks {
                self.steps(children, &format!("{path}/blocks/{name}"), loop_depth);
            }
            return;
        }

        let Some(def) = self.validator.registry.get(&step.step_type) else {
            self.error(
                "UNKNOWN_STEP_TYPE",
                format!("unknown step type '{}'", step.step_type),
                format!("{path}/type"),
                id,
            );
            let names: Vec<&str> = self
                .validator
                .registry
                .iter()
                .map(|d| d.step_type.as_str())
                .collect();
            self.hint(match closest(&step.step_type, names.iter().copied()) {
                Some(near) => {
                    format!("Did you mean '{near}'? Call list_step_types for every available type.")
                }
                None => "Call list_step_types for every available type.".to_owned(),
            });
            // Still descend so nested IDs are checked.
            for (name, children) in &step.blocks {
                self.steps(children, &format!("{path}/blocks/{name}"), loop_depth);
            }
            return;
        };

        if let Some(deprecated) = &def.deprecated {
            self.warn(
                "DEPRECATED_STEP_TYPE",
                format!("step type '{}' is deprecated", step.step_type),
                format!("{path}/type"),
                id,
            );
            self.hint(match &deprecated.replacement {
                Some(replacement) => format!("Use '{replacement}' instead. {}", deprecated.note),
                None => deprecated.note.clone(),
            });
        }

        self.params(step, def, path);
        self.file_paths(step, def, path);

        if step.step_type == crate::registry::flow::CALL {
            self.call_options(step, path);
        }
        if let Some(save_as) = &step.save_as {
            if !is_identifier(save_as) {
                self.error(
                    "INVALID_VARIABLE_NAME",
                    format!("saveAs '{save_as}' is not a valid identifier"),
                    format!("{path}/saveAs"),
                    id,
                );
            }
            if !def.has_output && step.step_type != crate::registry::flow::CALL {
                self.warn(
                    "NO_OUTPUT",
                    format!("'{}' produces no output for saveAs", def.step_type),
                    format!("{path}/saveAs"),
                    id,
                );
            }
        }

        self.switch_case(step, path, in_cases);

        if matches!(step.step_type.as_str(), control::BREAK | control::CONTINUE) && loop_depth == 0
        {
            self.error(
                "NOT_IN_LOOP",
                format!("'{}' must be inside a loop", step.step_type),
                format!("{path}/type"),
                id,
            );
        }

        if step.step_type == control::PARALLEL {
            self.parallel_writes(step, path);
        }
        if step.step_type == control::FOR_EACH {
            self.for_each(step, path);
        }

        if step.step_type == control::WAIT_UNTIL && step.retry.is_some() {
            self.warn(
                "REDUNDANT_RETRY",
                "wait.until already repeats its check; `retry` is not used".into(),
                format!("{path}/retry"),
                Some(&step.id),
            );
            self.hint("Remove `retry` and set `timeoutMs` to the longest time to wait.");
        }

        // A branch of `control.parallel` (or the check of `wait.until`)
        // cannot break out of an enclosing loop.
        let child_depth = if matches!(
            step.step_type.as_str(),
            control::PARALLEL | control::WAIT_UNTIL
        ) {
            0
        } else {
            loop_depth + usize::from(def.is_loop())
        };
        for (name, children) in &step.blocks {
            let block_path = format!("{path}/blocks/{name}");
            if !def.allows_block(name) {
                self.error(
                    "UNKNOWN_BLOCK",
                    format!("'{}' has no block named '{name}'", def.step_type),
                    block_path.clone(),
                    id,
                );
                let allowed: Vec<&str> = def.blocks.iter().map(|b| b.name.as_str()).collect();
                self.hint(if allowed.is_empty() {
                    format!("'{}' has no child blocks; remove `blocks`.", def.step_type)
                } else {
                    format!(
                        "Allowed blocks of '{}': {}.",
                        def.step_type,
                        allowed.join(", ")
                    )
                });
            }
            self.in_cases = step.step_type == control::SWITCH && name == "cases";
            self.steps(children, &block_path, child_depth);
        }
    }

    /// `control.case` steps live in the `cases` of a `control.switch`, and
    /// nothing else does.
    fn switch_case(&mut self, step: &Step, path: &str, in_cases: bool) {
        let is_case = step.step_type == control::CASE;
        if is_case && !in_cases {
            self.error(
                "CASE_OUTSIDE_SWITCH",
                "'control.case' must be in the `cases` block of a control.switch".into(),
                format!("{path}/type"),
                Some(&step.id),
            );
        } else if !is_case && in_cases {
            self.error(
                "NOT_A_CASE",
                format!(
                    "the `cases` of control.switch hold only control.case steps, not '{}'",
                    step.step_type
                ),
                format!("{path}/type"),
                Some(&step.id),
            );
        }
    }

    /// A call returns values only through `outputs`, and is not retried as
    /// a whole (its steps have their own retries).
    fn call_options(&mut self, step: &Step, path: &str) {
        if step.save_as.is_some() {
            self.error(
                "CALL_SAVE_AS",
                "flow.call returns values through `outputs`, not `saveAs`".into(),
                format!("{path}/saveAs"),
                Some(&step.id),
            );
            self.hint("Remove `saveAs` and add \"outputs\": { \"<output of the called flow>\": \"<variable here>\" }.");
        }
        if step.retry.is_some() {
            self.error(
                "CALL_RETRY",
                "a sub-flow call is not retried as a whole".into(),
                format!("{path}/retry"),
                Some(&step.id),
            );
            self.hint("Remove `retry`. Put `retry` on the steps inside the called flow that may fail, or wrap the call in control.try.");
        }
    }

    /// `collect` / `concurrency` rules of `control.forEach`. With
    /// `concurrency`, each iteration works on its own copy of the variables,
    /// so writes inside the body are lost and `collect` is the only way out.
    fn for_each(&mut self, step: &Step, path: &str) {
        if step.params.contains_key("collect") && step.save_as.is_none() {
            self.warn(
                "FOREACH_COLLECT_WITHOUT_SAVE_AS",
                "`collect` is evaluated but its results are not saved".into(),
                format!("{path}/params/collect"),
                Some(&step.id),
            );
            self.hint(
                "Add `saveAs` to receive the array of collected values (same order as `items`).",
            );
        }
        if !step.params.contains_key("concurrency") {
            return;
        }
        let body = step.block("body");
        let body_path = format!("{path}/blocks/body");

        let mut breaks = Vec::new();
        find_own_breaks(body, &mut breaks);
        for id in breaks {
            self.error(
                "FOREACH_BREAK_IN_CONCURRENT",
                "control.break cannot stop a forEach that runs iterations at the same time".into(),
                body_path.clone(),
                Some(&id),
            );
            self.hint("Remove `concurrency` to run one item at a time, or filter `items` before the loop (control.continue skips one item).");
        }

        let bound: Vec<&str> = ["itemVar", "indexVar"]
            .iter()
            .filter_map(|k| step.params.get(*k).and_then(Value::as_str))
            .collect();
        let mut writes = BTreeSet::new();
        for child in body {
            collect_writes(child, &self.validator.registry, &mut writes);
        }
        for name in &writes {
            if self.declared_vars.contains(name) && !bound.contains(&name.as_str()) {
                self.error(
                    "FOREACH_SHARED_WRITE",
                    format!(
                        "iterations run in parallel, so writing '{name}' inside the body is lost"
                    ),
                    body_path.clone(),
                    Some(&step.id),
                );
                self.hint(format!(
                    "Return each item's value with `collect` (e.g. \"collect\": \"[item.no, status]\") and `saveAs: \"results\"`, then use the array after the loop instead of writing '{name}'."
                ));
            }
        }

        let mut accumulators = BTreeSet::new();
        find_accumulators(body, &mut accumulators);
        for name in accumulators {
            if self.declared_vars.contains(&name) {
                continue; // already FOREACH_SHARED_WRITE
            }
            self.warn(
                "FOREACH_ACCUMULATOR",
                format!("'{name}' is updated from its own value, but each parallel iteration starts from the same copy"),
                body_path.clone(),
                Some(&step.id),
            );
            self.hint("Return each item's value with `collect` + `saveAs: \"amounts\"` and add them up after the loop with sum(amounts).");
        }
    }

    /// Relative paths are resolved from the flow's folder; one that
    /// climbs out of it with `..` depends on where the folder sits, and is
    /// left behind when the flow is exported.
    fn file_paths(&mut self, step: &Step, def: &StepTypeDef, path: &str) {
        for key in &def.path_params {
            let values: Vec<&str> = match step.params.get(key) {
                Some(Value::String(value)) => vec![value.as_str()],
                Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).collect(),
                _ => continue,
            };
            let Some(value) = values.into_iter().find(|v| {
                !v.contains("{{")
                    && crate::project::is_relative(v)
                    && v.trim()
                        .replace('\\', "/")
                        .split('/')
                        .any(|part| part == "..")
            }) else {
                continue;
            };
            self.warn(
                "PATH_OUTSIDE_PROJECT",
                format!("'{key}' leaves the flow's folder: {value}"),
                format!("{path}/params/{key}"),
                Some(&step.id),
            );
            self.hint(
                "Put the file in the flow's folder (input/, config/, templates/) and write e.g. input/orders.xlsx, or use an absolute path (C:\\work\\orders.xlsx).".to_owned(),
            );
        }
    }

    /// Two branches writing the same variable would make the result depend
    /// on timing (or fail at run time), so it is rejected up front.
    fn parallel_writes(&mut self, step: &Step, path: &str) {
        let mut owner: HashMap<String, usize> = HashMap::new();
        for (index, branch) in step.block("branches").iter().enumerate() {
            let mut names = BTreeSet::new();
            collect_writes(branch, &self.validator.registry, &mut names);
            for name in names {
                match owner.get(&name) {
                    Some(&other) if other != index => {
                        self.error(
                            "PARALLEL_VARIABLE_CONFLICT",
                            format!(
                                "parallel branches {other} and {index} both write variable '{name}'"
                            ),
                            format!("{path}/blocks/branches/{index}"),
                            Some(&step.id),
                        );
                        self.hint(format!(
                            "Give each branch its own variable (e.g. {name}A / {name}B) and combine them after the parallel step."
                        ));
                    }
                    Some(_) => {}
                    None => {
                        owner.insert(name, index);
                    }
                }
            }
        }
    }

    /// The step's params with `{ "part": … }` replaced by the part's target
    /// (as the Runtime runs them), after checking each reference.
    fn inlined_params(
        &mut self,
        step: &Step,
        path: &str,
    ) -> (serde_json::Map<String, Value>, bool) {
        let id = Some(&step.id);
        let mut params = step.params.clone();
        let mut broken = false;
        let app = step.step_type.split('.').next().unwrap_or_default();
        for (key, value) in &mut params {
            if !crate::model::takes_part(&step.step_type, key) {
                continue;
            }
            let param_path = format!("{path}/params/{key}");
            if let Some(obj) = value.as_object()
                && obj.contains_key("part")
                && obj.len() > 1
            {
                broken = true;
                self.error(
                    "PART_WITH_FIELDS",
                    format!("'{key}' names a part and also has other fields"),
                    param_path,
                    id,
                );
                self.hint("Write only { \"part\": \"<name>\" }. For a part that differs a little, add another part to `parts`.".to_owned());
                continue;
            }
            let Some(name) = crate::model::part_ref(value) else {
                continue;
            };
            let Some(part) = self.parts.get(name).cloned() else {
                broken = true;
                let known: Vec<String> = self.parts.keys().cloned().collect();
                self.error(
                    "UNKNOWN_PART",
                    format!("part '{name}' is not in the flow's parts"),
                    param_path,
                    id,
                );
                self.hint(if known.is_empty() {
                    "Add it with the setPart edit op first, or write the target itself.".to_owned()
                } else {
                    format!("Use one of: {}, or add it with setPart.", known.join(", "))
                });
                continue;
            };
            if part.target.is_null() {
                broken = true;
                let label = if part.label.is_empty() {
                    name
                } else {
                    part.label.as_str()
                };
                self.error(
                    "PART_NOT_PICKED",
                    format!("part '{name}' ({label}) has not been picked on the screen yet"),
                    param_path,
                    id,
                );
                self.hint(format!(
                    "A person picks it in Studio (select the part '{name}' and press 画面から選ぶ). Leave the node as it is."
                ));
                continue;
            }
            if part.app.as_str() != app {
                broken = true;
                self.error(
                    "PART_APP_MISMATCH",
                    format!(
                        "part '{name}' is a {} part; {} steps cannot use it",
                        part.app.as_str(),
                        step.step_type
                    ),
                    param_path,
                    id,
                );
                continue;
            }
            *value = part.target;
        }
        (params, broken)
    }

    fn params(&mut self, step: &Step, def: &StepTypeDef, path: &str) {
        let id = Some(&step.id);
        let (inlined, broken) = self.inlined_params(step, path);
        let instance = Value::Object(inlined.clone());
        match self.validator.schemas.get(&def.step_type) {
            // A broken part reference is the error to fix; the schema would
            // only repeat it.
            Some(Ok(_)) if broken => {}
            Some(Ok(schema)) => {
                let errors: Vec<(String, String)> = schema
                    .iter_errors(&instance)
                    .map(|e| (e.instance_path().to_string(), e.to_string()))
                    .collect();
                let hint = params_hint(def);
                for (pointer, message) in errors {
                    self.error(
                        "INVALID_PARAMS",
                        message,
                        format!("{path}/params{pointer}"),
                        id,
                    );
                    self.hint(hint.clone());
                }
            }
            Some(Err(message)) => {
                self.error(
                    "INVALID_STEP_DEFINITION",
                    message.clone(),
                    format!("{path}/type"),
                    id,
                );
            }
            None => {}
        }

        self.secrets(step, def, path);

        for (key, value) in &inlined {
            let param_path = format!("{path}/params/{key}");
            if def.expression_params.contains(key) {
                if let Value::String(src) = value {
                    match Expr::parse(src) {
                        Ok(expr) => self.check_vars(expr.variables(), &param_path, id),
                        Err(e) => {
                            self.error(e.code(), e.to_string(), param_path, id);
                            if src.contains("{{") {
                                self.hint(format!(
                                    "'{key}' is an expression param: write the bare expression without {{{{ }}}}, e.g. \"count > 3\"."
                                ));
                            } else {
                                self.expr_hint(&e);
                            }
                        }
                    }
                }
                continue;
            }
            let mut results = Vec::new();
            expr::visit_templates(value, &mut |r| results.push(r));
            for result in results {
                match result {
                    Ok(template) => self.check_vars(template.variables(), &param_path, id),
                    Err(e) => {
                        self.error(e.code(), e.to_string(), param_path.clone(), id);
                        self.expr_hint(&e);
                    }
                }
            }
        }
    }

    /// Secret references are only allowed as the whole value of the params
    /// a step type lists in `secretParams`, and must name a secret literally.
    fn secrets(&mut self, step: &Step, def: &StepTypeDef, path: &str) {
        let id = Some(&step.id);
        for (key, value) in &step.params {
            let param_path = format!("{path}/params/{key}");
            if def.secret_params.contains(key)
                && let Some(reference) = SecretRef::from_value(value)
            {
                match reference {
                    Ok(r) => {
                        if let Err(message) = secret::check_name(&r.secret) {
                            self.error(
                                "INVALID_SECRET_REF",
                                message,
                                format!("{param_path}/secret"),
                                id,
                            );
                            self.hint("Write the registered name as it is, e.g. \"受注システム\" (list_secrets shows the names).");
                        }
                    }
                    Err(message) => {
                        self.error("INVALID_SECRET_REF", message, param_path, id);
                        self.hint("Write { \"secret\": \"<registered name>\", \"field\": \"username\" | \"password\" | \"totp\" }, or \"accessToken\" in http.request auth.");
                    }
                }
                continue;
            }
            let mut found = Vec::new();
            find_secret_refs(value, &param_path, &mut found);
            for pointer in found {
                self.error(
                    "SECRET_NOT_ALLOWED",
                    format!("'{}' cannot take a secret here", def.step_type),
                    pointer,
                    id,
                );
                self.hint(if def.secret_params.is_empty() {
                    format!(
                        "Secrets can only be typed into input fields (e.g. the `value` of browser.fill), never used in '{}'.",
                        def.step_type
                    )
                } else {
                    format!(
                        "Use the secret as the whole value of {} only.",
                        def.secret_params.join(", ")
                    )
                });
            }
        }
    }

    fn expr_hint(&mut self, error: &expr::ExprError) {
        if let expr::ExprError::UnknownFunction(name) = error {
            let near = closest(name, expr::function_names());
            self.hint(format!(
                "{}Available functions: {}.",
                near.map(|n| format!("Did you mean '{n}'? "))
                    .unwrap_or_default(),
                expr::function_names().collect::<Vec<_>>().join(", ")
            ));
        }
    }

    fn check_vars(&mut self, names: BTreeSet<String>, path: &str, id: Option<&StepId>) {
        for name in names {
            if !self.known_vars.contains(&name) {
                self.warn(
                    "UNDEFINED_VARIABLE",
                    format!("variable '{name}' is never declared or assigned"),
                    path.to_owned(),
                    id,
                );
                let near =
                    closest(&name, self.known_vars.iter().map(String::as_str)).map(str::to_owned);
                self.hint(match near {
                    Some(near) => format!("Did you mean '{near}'? Otherwise declare '{name}' in `variables` or assign it first (variable.set or saveAs)."),
                    None => format!("Declare '{name}' in `variables` (inputs need direction \"input\") or assign it first with variable.set or saveAs."),
                });
            }
        }
    }
}

fn find_secret_refs(value: &Value, path: &str, out: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            if map.contains_key("secret") && map.contains_key("field") {
                out.push(path.to_owned());
                return;
            }
            for (key, child) in map {
                find_secret_refs(child, &format!("{path}/{key}"), out);
            }
        }
        Value::Array(items) => {
            for (i, child) in items.iter().enumerate() {
                find_secret_refs(child, &format!("{path}/{i}"), out);
            }
        }
        _ => {}
    }
}

/// Variables one step assigns itself (not counting its children).
pub(crate) fn own_writes(step: &Step, registry: &StepRegistry, out: &mut BTreeSet<String>) {
    if let Some(save_as) = &step.save_as {
        out.insert(save_as.clone());
    }
    if step.on_error == Some(crate::model::OnError::Continue) {
        out.insert(LAST_ERROR_VAR.to_owned());
    }
    if let Some(def) = registry.get(&step.step_type) {
        for key in &def.binds_variables {
            if let Some(Value::String(name)) = step.params.get(key) {
                out.insert(name.clone());
            }
        }
    }
    out.extend(call_output_targets(step));
}

/// Variables a step and its children may assign.
pub(crate) fn collect_writes(step: &Step, registry: &StepRegistry, out: &mut BTreeSet<String>) {
    own_writes(step, registry, out);
    if step.step_type == control::FOR_EACH && step.params.contains_key("concurrency") {
        return; // iterations work on copies; only `saveAs` leaves the loop
    }
    for children in step.blocks.values() {
        for child in children {
            collect_writes(child, registry, out);
        }
    }
}

/// `control.break` steps that would leave this loop (not a nested one).
fn find_own_breaks(steps: &[Step], out: &mut Vec<StepId>) {
    for step in steps {
        if step.step_type == control::BREAK {
            out.push(step.id.clone());
        }
        let nested_loop = matches!(
            step.step_type.as_str(),
            control::WHILE
                | control::REPEAT
                | control::FOR_EACH
                | control::PARALLEL
                | control::WAIT_UNTIL
        );
        if !nested_loop {
            for children in step.blocks.values() {
                find_own_breaks(children, out);
            }
        }
    }
}

/// Variables set from an expression or template that reads them
/// (`total = total + x`).
fn find_accumulators(steps: &[Step], out: &mut BTreeSet<String>) {
    for step in steps {
        if step.step_type == crate::registry::builtin::VARIABLE_SET
            && let Some(Value::String(name)) = step.params.get("name")
        {
            let reads = match (step.params.get("expression"), step.params.get("value")) {
                (Some(Value::String(e)), _) => {
                    Expr::parse(e).map(|e| e.variables()).unwrap_or_default()
                }
                (_, Some(Value::String(t))) => expr::Template::parse(t)
                    .map(|t| t.variables())
                    .unwrap_or_default(),
                _ => BTreeSet::new(),
            };
            if reads.contains(name) {
                out.insert(name.clone());
            }
        }
        for children in step.blocks.values() {
            find_accumulators(children, out);
        }
    }
}

fn format_name(format: VarFormat) -> &'static str {
    match format {
        VarFormat::File => "file path",
        VarFormat::Folder => "folder path",
        VarFormat::Date => "date (YYYY-MM-DD)",
        VarFormat::Month => "month (YYYY-MM)",
    }
}

/// Whether a default fits `format`. Paths are not checked: the file may
/// only exist on the PC that runs the flow.
fn format_accepts(format: VarFormat, text: &str) -> bool {
    let num =
        |part: &str, len: usize| part.len() == len && part.bytes().all(|b| b.is_ascii_digit());
    let month_ok = |m: &str| num(m, 2) && (1..=12).contains(&m.parse::<u8>().unwrap_or(0));
    match format {
        VarFormat::File | VarFormat::Folder => true,
        VarFormat::Month => {
            matches!(text.split('-').collect::<Vec<_>>()[..], [y, m] if num(y, 4) && month_ok(m))
        }
        VarFormat::Date => matches!(
            text.split('-').collect::<Vec<_>>()[..],
            [y, m, d] if num(y, 4) && month_ok(m) && num(d, 2) && (1..=31).contains(&d.parse::<u8>().unwrap_or(0))
        ),
    }
}

/// Fix instructions for issues without a more specific hint.
fn generic_hint(code: &str) -> Option<&'static str> {
    Some(match code {
        "MISSING_STEP_ID" | "INVALID_STEP_ID" | "DUPLICATE_STEP_ID" => {
            "Omit `id` when adding steps (Core assigns unique IDs); use existing IDs only to refer to steps from get_flow."
        }
        "NOT_IN_LOOP" => {
            "Put break/continue inside control.while, control.repeat or control.forEach. A control.parallel branch cannot leave an outer loop; end the branch or use control.fail."
        }
        "NO_OUTPUT" => "Remove `saveAs`: this step type returns no value.",
        "CASE_OUTSIDE_SWITCH" => {
            "Put the control.case into `blocks.cases` of a control.switch, or use control.if for a single condition."
        }
        "NOT_A_CASE" => {
            "Wrap the step in a control.case (`params.values` or `params.condition`, the step in `blocks.body`), or move it to the switch's `default` block."
        }
        "INVALID_VARIABLE_NAME" => {
            "Use letters, digits and '_' and start with a letter or '_' (e.g. invoiceTotal)."
        }
        "DUPLICATE_VARIABLE" => "Keep one declaration per variable name.",
        "VARIABLE_TYPE_MISMATCH" => {
            "Make `default` match `type`, or change `type` (any accepts every value)."
        }
        "INVALID_VARIABLE_FORMAT" => {
            "`format` (file, folder, date, month) is for string variables; a date default is YYYY-MM-DD and a month YYYY-MM."
        }
        "INVALID_VARIABLE_CHOICES" => {
            "`choices` lists the values a string or number input takes, each once and of the variable's type; `default` must be one of them."
        }
        "INVALID_RETRY" => "Set retry.maxAttempts to 1 or more (1 means no retry).",
        "EMPTY_NAME" => "Give the flow a short descriptive name.",
        "INVALID_FLOW_ID" => "Omit `id` when creating a flow; Core assigns one.",
        "UNSUPPORTED_SCHEMA_VERSION" => {
            "Omit schemaVersion (Core writes the current one). A file from a newer Shikigami needs that newer version to open."
        }
        "EXPR_SYNTAX" => {
            "Check quotes and brackets. Strings use '...', comparisons ==, !=, <, >, logic &&, ||, !. In template params wrap expressions in {{ }}."
        }
        "INVALID_STEP_DEFINITION" => {
            "The step type itself is broken; report it instead of changing the flow."
        }
        _ => return None,
    })
}

/// Required and allowed params of a step type, from its schema.
fn params_hint(def: &StepTypeDef) -> String {
    let schema = &def.params_schema;
    let names = |key: &str| -> Vec<String> {
        match schema.get(key) {
            Some(Value::Object(map)) => map.keys().cloned().collect(),
            Some(Value::Array(items)) => items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
            _ => Vec::new(),
        }
    };
    let allowed = names("properties");
    let required = names("required");
    let mut hint = String::new();
    if def.step_type == crate::registry::builtin::VARIABLE_SET {
        hint.push_str(
            "Give exactly one of `value` (literal or template) or `expression` (bare expression). ",
        );
    }
    if let Some(Value::Object(props)) = schema.get("properties")
        && props.values().any(|p| {
            p.pointer("/oneOf/1/pattern").and_then(Value::as_str)
                == Some(crate::registry::SINGLE_TEMPLATE_PATTERN)
        })
    {
        hint.push_str("Numeric params take an integer or exactly one {{ expr }} template, e.g. 3 or \"{{ retryCount }}\". ");
    }
    if !required.is_empty() {
        hint.push_str(&format!("Required params: {}. ", required.join(", ")));
    }
    if !allowed.is_empty() {
        hint.push_str(&format!("Allowed params: {}. ", allowed.join(", ")));
    }
    hint.push_str(&format!(
        "Call get_step_schema(\"{}\") for the schema and a working example.",
        def.step_type
    ));
    hint
}

/// The candidate closest to `name` by edit distance, if reasonably close.
pub(crate) fn closest<'a>(
    name: &str,
    candidates: impl Iterator<Item = &'a str>,
) -> Option<&'a str> {
    let max = (name.chars().count() / 3).max(2);
    candidates
        .map(|c| (edit_distance(&name.to_lowercase(), &c.to_lowercase()), c))
        .filter(|(d, _)| *d <= max)
        .min_by_key(|(d, _)| *d)
        .map(|(_, c)| c)
}

/// Edit distance counting a swap of two adjacent characters as one edit
/// (optimal string alignment), so typos like `control.fi` → `control.if` rank first.
fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut d = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for (i, row) in d.iter_mut().enumerate() {
        row[0] = i;
    }
    for (j, cell) in d[0].iter_mut().enumerate() {
        *cell = j;
    }
    for i in 1..=a.len() {
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            let mut best = (d[i - 1][j] + 1)
                .min(d[i][j - 1] + 1)
                .min(d[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                best = best.min(d[i - 2][j - 2] + 1);
            }
            d[i][j] = best;
        }
    }
    d[a.len()][b.len()]
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::model::{VarType, VariableDef};
    use crate::resource::ResourceDef;
    use serde_json::json;

    fn validator() -> Validator {
        Validator::new(StepRegistry::with_builtins())
    }

    fn codes(report: &ValidationReport) -> Vec<&str> {
        report.issues.iter().map(|i| i.code.as_str()).collect()
    }

    fn typing_registry() -> StepRegistry {
        let mut registry = StepRegistry::with_builtins();
        registry.register(crate::registry::StepTypeDef {
            targets: Vec::new(),
            step_type: "test.type".into(),
            category: crate::registry::StepCategory::Other,
            label: "type".into(),
            description: String::new(),
            params_schema: json!({
                "type": "object",
                "properties": {
                    "value": crate::secret::text_or_secret_schema("text"),
                    "label": { "type": "string" }
                },
                "additionalProperties": false
            }),
            blocks: vec![],
            has_output: false,
            expression_params: vec![],
            binds_variables: vec![],
            risk: crate::registry::RiskLevel::Interactive,
            examples: vec![],
            resources: vec![],
            secret_params: vec!["value".into()],
            default_timeout_ms: None,
            deprecated: None,
            plugin: None,
            path_params: Vec::new(),
        });
        registry
    }

    #[test]
    fn secrets_are_only_typed_and_never_stored() {
        let v = Validator::new(typing_registry());
        let mut s = Flow::new("t");
        let mut pw = VariableDef::new("pw", VarType::String);
        pw.secret = true;
        pw.default = Some(json!("hunter2"));
        s.variables.push(pw);
        s.steps = vec![
            Step::new("test.type")
                .with_param("value", json!({ "secret": "受注", "field": "password" })),
            Step::new("test.type").with_param(
                "value",
                json!({ "secret": "{{ name }}", "field": "password" }),
            ),
            Step::new("test.type").with_param("value", json!({ "secret": "受注", "field": "pin" })),
            Step::new("log.message")
                .with_param("message", json!({ "secret": "受注", "field": "password" })),
        ];
        for (i, step) in s.steps.iter_mut().enumerate() {
            step.id = format!("s{i}").into();
        }
        let report = v.validate(&s);
        let found: Vec<(&str, Option<&str>)> = report
            .issues
            .iter()
            .filter(|i| i.code.starts_with("SECRET") || i.code == "INVALID_SECRET_REF")
            .map(|i| (i.code.as_str(), i.step_id.as_ref().map(|id| id.as_str())))
            .collect();
        assert_eq!(
            found,
            [
                ("SECRET_DEFAULT", None),
                ("INVALID_SECRET_REF", Some("s1")),
                ("INVALID_SECRET_REF", Some("s2")),
                ("SECRET_NOT_ALLOWED", Some("s3")),
            ]
        );
        assert!(hint_of(&report, "SECRET_DEFAULT").contains("browser.fill"));
        assert!(hint_of(&report, "SECRET_NOT_ALLOWED").contains("input fields"));
        // The well-formed reference on s0 is accepted.
        assert!(
            !report
                .issues
                .iter()
                .any(|i| i.step_id.as_ref().is_some_and(|id| id.as_str() == "s0"))
        );
    }

    #[test]
    fn input_formats_and_choices_are_checked() {
        let v = Validator::new(typing_registry());
        let var = |name: &str, ty, f: &dyn Fn(&mut VariableDef)| {
            let mut var = VariableDef::new(name, ty);
            f(&mut var);
            var
        };
        let mut s = Flow::new("t");
        s.variables = vec![
            // Fine: a file, a month with a default, choices with one picked.
            var("book", VarType::String, &|v| {
                v.format = Some(VarFormat::File)
            }),
            var("month", VarType::String, &|v| {
                v.format = Some(VarFormat::Month);
                v.default = Some(json!("2026-11"));
            }),
            var("branch", VarType::String, &|v| {
                v.choices = vec![json!("東京"), json!("大阪")];
                v.default = Some(json!("大阪"));
            }),
            var("count", VarType::Number, &|v| {
                v.format = Some(VarFormat::Date)
            }),
            var("day", VarType::String, &|v| {
                v.format = Some(VarFormat::Date);
                v.default = Some(json!("2026/11/06"));
            }),
            var("flag", VarType::Boolean, &|v| v.choices = vec![json!(true)]),
            var("size", VarType::Number, &|v| {
                v.choices = vec![json!(1), json!("2"), json!(1)];
                v.default = Some(json!(3));
            }),
        ];
        let report = v.validate(&s);
        let found: Vec<_> = report
            .issues
            .iter()
            .map(|i| (i.code.as_str(), i.path.as_str()))
            .collect();
        assert_eq!(
            found,
            [
                ("INVALID_VARIABLE_FORMAT", "/variables/3/format"),
                ("INVALID_VARIABLE_FORMAT", "/variables/4/default"),
                ("INVALID_VARIABLE_CHOICES", "/variables/5/choices"),
                ("INVALID_VARIABLE_CHOICES", "/variables/6/choices/1"),
                ("INVALID_VARIABLE_CHOICES", "/variables/6/choices/2"),
                ("INVALID_VARIABLE_CHOICES", "/variables/6/default"),
            ]
        );
        assert!(hint_of(&report, "INVALID_VARIABLE_FORMAT").contains("YYYY-MM"));
        assert!(format_accepts(VarFormat::Date, "2026-02-28"));
        assert!(!format_accepts(VarFormat::Month, "2026-13"));
    }

    #[test]
    fn valid_flow_passes() {
        let mut s = Flow::new("ok");
        s.variables.push(VariableDef::new("count", VarType::Number));
        s.steps = vec![
            Step::new("variable.set")
                .with_id("s1")
                .with_param("name", "count")
                .with_param("value", 1),
            Step::new("control.while")
                .with_id("s2")
                .with_param("condition", "count < 3")
                .with_block(
                    "body",
                    vec![
                        Step::new("variable.set")
                            .with_id("s3")
                            .with_param("name", "count")
                            .with_param("expression", "count + 1"),
                        Step::new("control.break").with_id("s4"),
                    ],
                ),
            Step::new("log.message")
                .with_id("s5")
                .with_param("message", "count={{ count }}"),
        ];
        let report = validator().validate(&s);
        assert!(report.valid, "{:?}", report.issues);
        assert!(report.issues.is_empty(), "{:?}", report.issues);
    }

    #[test]
    fn reports_all_problems_with_paths() {
        let mut s = Flow::new("bad");
        s.steps = vec![
            Step::new("nope.unknown").with_id("a"),
            Step::new("log.message").with_id("a"),
            Step::new("control.if")
                .with_id("b")
                .with_param("condition", "x >")
                .with_block("body", vec![]),
            Step::new("control.break").with_id("c"),
            Step::new("log.message")
                .with_id("d")
                .with_param("message", "{{ ghost }}"),
        ];
        let report = validator().validate(&s);
        assert!(!report.valid);
        let c = codes(&report);
        for expected in [
            "UNKNOWN_STEP_TYPE",
            "DUPLICATE_STEP_ID",
            "INVALID_PARAMS",
            "EXPR_SYNTAX",
            "UNKNOWN_BLOCK",
            "NOT_IN_LOOP",
            "UNDEFINED_VARIABLE",
        ] {
            assert!(c.contains(&expected), "missing {expected} in {c:?}");
        }
        let dup = report
            .issues
            .iter()
            .find(|i| i.code == "DUPLICATE_STEP_ID")
            .expect("dup");
        assert_eq!(dup.path, "/steps/1/id");
        let undefined = report
            .issues
            .iter()
            .find(|i| i.code == "UNDEFINED_VARIABLE")
            .expect("undef");
        assert_eq!(undefined.severity, Severity::Warning);
    }

    #[test]
    fn missing_required_param_is_reported() {
        let mut s = Flow::new("t");
        s.steps = vec![Step::new("log.message").with_id("a")];
        let report = validator().validate(&s);
        assert_eq!(codes(&report), ["INVALID_PARAMS"]);
        assert_eq!(report.issues[0].path, "/steps/0/params");
    }

    #[test]
    fn variable_set_requires_exactly_one_source() {
        let mut s = Flow::new("t");
        s.steps = vec![
            Step::new("variable.set")
                .with_id("a")
                .with_param("name", "x")
                .with_param("value", 1)
                .with_param("expression", "2"),
        ];
        assert!(!validator().validate(&s).valid);
    }

    #[test]
    fn bad_variable_defaults_are_errors() {
        let mut s = Flow::new("t");
        let mut v = VariableDef::new("n", VarType::Number);
        v.default = Some(json!("text"));
        s.variables.push(v);
        s.variables.push(VariableDef::new("n", VarType::Any));
        let c = codes(&validator().validate(&s)).join(",");
        assert!(
            c.contains("VARIABLE_TYPE_MISMATCH") && c.contains("DUPLICATE_VARIABLE"),
            "{c}"
        );
    }

    fn hint_of<'a>(report: &'a ValidationReport, code: &str) -> &'a str {
        report
            .issues
            .iter()
            .find(|i| i.code == code)
            .and_then(|i| i.hint.as_deref())
            .unwrap_or_else(|| panic!("no hint for {code}: {report:?}"))
    }

    #[test]
    fn cases_belong_to_a_switch() {
        let log = |id: &str| {
            Step::new("log.message")
                .with_id(id)
                .with_param("message", "x")
        };
        let case = |id: &str, body: &str| {
            Step::new(control::CASE)
                .with_id(id)
                .with_param("values", json!(["A"]))
                .with_block("body", vec![log(body)])
        };
        let mut s = Flow::new("switch");
        s.steps = vec![
            Step::new(control::SWITCH)
                .with_id("sw")
                .with_param("value", "'A'")
                .with_block("cases", vec![case("c1", "l1"), log("stray")])
                .with_block("default", vec![case("lost", "l2")]),
            case("top", "l3"),
        ];
        let report = validator().validate(&s);
        let found: Vec<(&str, &str)> = report
            .issues
            .iter()
            .map(|i| {
                (
                    i.code.as_str(),
                    i.step_id.as_ref().map_or("", |id| id.as_str()),
                )
            })
            .collect();
        assert_eq!(
            found,
            [
                ("NOT_A_CASE", "stray"),
                ("CASE_OUTSIDE_SWITCH", "lost"),
                ("CASE_OUTSIDE_SWITCH", "top"),
            ],
            "{:?}",
            report.issues
        );

        // A case needs `values` or `condition`.
        let mut empty = Flow::new("switch");
        empty.steps = vec![
            Step::new(control::SWITCH)
                .with_id("sw")
                .with_param("value", "1")
                .with_block("cases", vec![Step::new(control::CASE).with_id("c")]),
        ];
        assert!(codes(&validator().validate(&empty)).contains(&"INVALID_PARAMS"));
    }

    #[test]
    fn concurrent_for_each_rules() {
        let body = vec![
            Step::new("variable.set")
                .with_id("s1")
                .with_param("name", "total")
                .with_param("expression", "total + item"),
            Step::new("variable.set")
                .with_id("s2")
                .with_param("name", "count")
                .with_param("expression", "count + 1"),
            Step::new("control.break").with_id("b"),
        ];
        let mut s = Flow::new("each");
        s.variables.push(VariableDef::new("total", VarType::Number));
        s.steps = vec![
            Step::new("control.forEach")
                .with_id("f")
                .with_param("items", "[1, 2]")
                .with_param("itemVar", "item")
                .with_param("concurrency", 2)
                .with_param("collect", "item")
                .with_block("body", body.clone()),
        ];
        let report = validator().validate(&s);
        let c = codes(&report).join(",");
        for code in [
            "FOREACH_SHARED_WRITE",
            "FOREACH_BREAK_IN_CONCURRENT",
            "FOREACH_ACCUMULATOR",
            "FOREACH_COLLECT_WITHOUT_SAVE_AS",
        ] {
            assert!(c.contains(code), "{code} missing: {c}");
            hint_of(&report, code);
        }
        // `total` is declared, so it is a shared write rather than an accumulator.
        assert_eq!(c.matches("FOREACH_ACCUMULATOR").count(), 1, "{c}");

        // Without `concurrency` the same loop is ordinary sequential code.
        s.steps[0].params.remove("concurrency");
        let c = codes(&validator().validate(&s)).join(",");
        assert!(
            !c.contains("FOREACH_SHARED_WRITE") && !c.contains("FOREACH_BREAK"),
            "{c}"
        );
    }

    #[test]
    fn retry_on_wait_until_is_redundant() {
        let mut wait = Step::new(control::WAIT_UNTIL)
            .with_id("w")
            .with_param("condition", "true");
        wait.retry = Some(crate::model::RetryPolicy {
            max_attempts: 3,
            backoff_ms: 100,
            backoff_multiplier: 1.0,
        });
        let mut s = Flow::new("wait");
        s.steps = vec![wait];
        let report = validator().validate(&s);
        assert_eq!(report.error_count(), 0, "{report:?}");
        assert!(hint_of(&report, "REDUNDANT_RETRY").contains("timeoutMs"));
    }

    #[test]
    fn paths_leaving_the_project_are_warned() {
        let mut registry = StepRegistry::with_builtins();
        let mut def = registry.get("log.message").unwrap().clone();
        def.step_type = "test.write".into();
        def.resources = vec![ResourceDef::file("message")];
        registry.register(def);
        let write = |id: &str, path: &str| {
            Step::new("test.write")
                .with_id(id)
                .with_param("message", path)
        };
        let mut s = Flow::new("paths");
        s.steps = vec![
            write("a", "input/book.xlsx"),
            write("b", r"C:\work\book.xlsx"),
            write("c", "{{ dir }}\\..\\book.xlsx"),
            write("d", r"..\other\book.xlsx"),
        ];
        s.variables.push(VariableDef::new("dir", VarType::String));
        let report = Validator::new(registry).validate(&s);
        assert_eq!(report.error_count(), 0, "{report:?}");
        let warned: Vec<_> = report
            .issues
            .iter()
            .filter(|i| i.code == "PATH_OUTSIDE_PROJECT")
            .map(|i| i.step_id.as_ref().map(ToString::to_string))
            .collect();
        assert_eq!(warned, [Some("d".to_owned())]);
        assert!(hint_of(&report, "PATH_OUTSIDE_PROJECT").contains("input/"));
    }

    #[test]
    fn issues_carry_fix_hints() {
        let mut s = Flow::new("hints");
        s.variables.push(VariableDef::new("total", VarType::Number));
        s.steps = vec![
            Step::new("control.fi").with_id("a"),
            Step::new("log.message")
                .with_id("b")
                .with_param("message", "{{ totl }}"),
            Step::new("log.message").with_id("c").with_param("msg", "x"),
            Step::new("control.if")
                .with_id("d")
                .with_param("condition", "{{ total > 1 }}"),
            Step::new("log.message")
                .with_id("e")
                .with_param("message", "{{ lne(total) }}"),
        ];
        let report = validator().validate(&s);
        assert!(hint_of(&report, "UNKNOWN_STEP_TYPE").contains("'control.if'"));
        assert!(hint_of(&report, "UNDEFINED_VARIABLE").contains("'total'"));
        let params = hint_of(&report, "INVALID_PARAMS");
        assert!(params.contains("Required params: message"), "{params}");
        assert!(params.contains("get_step_schema"));
        assert!(hint_of(&report, "EXPR_SYNTAX").contains("without {{ }}"));
        assert!(hint_of(&report, "EXPR_UNKNOWN_FUNCTION").contains("'len'"));
        // Every error gets some hint.
        for issue in report.errors() {
            assert!(issue.hint.is_some(), "{issue:?}");
        }
    }

    #[test]
    fn every_builtin_example_is_a_valid_step() {
        let v = validator();
        for def in v.registry().iter() {
            assert!(!def.examples.is_empty(), "{} has no example", def.step_type);
            for example in &def.examples {
                let mut step: Step = serde_json::from_value(example.clone())
                    .unwrap_or_else(|e| panic!("{}: {e}", def.step_type));
                assert_eq!(step.step_type, def.step_type);
                crate::ops::assign_missing_ids(&mut step);
                // break/continue are only valid inside a loop.
                let step = if matches!(def.step_type.as_str(), control::BREAK | control::CONTINUE) {
                    Step::new(control::REPEAT)
                        .with_id("loop")
                        .with_param("count", 1)
                        .with_block("body", vec![step])
                } else if def.step_type == control::CASE {
                    Step::new(control::SWITCH)
                        .with_id("switch")
                        .with_param("value", "'東京'")
                        .with_block("cases", vec![step])
                } else {
                    step
                };
                let mut s = Flow::new("example");
                s.steps = vec![step];
                let report = v.validate(&s);
                assert!(report.valid, "{}: {:?}", def.step_type, report.issues);
            }
        }
    }

    fn plugin_registry(version: &str) -> StepRegistry {
        let mut registry = StepRegistry::with_builtins();
        let mut def = registry.get("log.message").unwrap().clone();
        def.step_type = "hello.greet".into();
        def.plugin = Some(crate::registry::PluginInfo {
            name: "hello".into(),
            version: version.into(),
            ..Default::default()
        });
        registry.register(def);
        registry
    }

    fn greet_flow(range: &str) -> Flow {
        let mut s = Flow::new("plugins");
        s.steps = vec![
            Step::new("hello.greet")
                .with_id("a")
                .with_param("message", "hi"),
        ];
        s.requires.insert("plugin:hello".into(), range.into());
        s
    }

    #[test]
    fn missing_plugins_name_the_plugin_and_version() {
        let report = validator().validate(&greet_flow("^0.3.1"));
        assert_eq!(codes(&report), ["PLUGIN_NOT_INSTALLED"]);
        assert!(report.issues[0].message.contains("'hello' (^0.3.1)"));
        assert!(hint_of(&report, "PLUGIN_NOT_INSTALLED").contains("the 'hello' extension"));
    }

    #[test]
    fn plugin_versions_are_checked_against_requires() {
        let ok = Validator::new(plugin_registry("0.3.4")).validate(&greet_flow("^0.3.1"));
        assert!(ok.valid, "{ok:?}");
        let newer = Validator::new(plugin_registry("1.0.0")).validate(&greet_flow("^0.3.1"));
        assert_eq!(codes(&newer), ["PLUGIN_VERSION_MISMATCH"]);
        assert_eq!(newer.issues[0].path, "/requires/plugin:hello");
        let bad = Validator::new(plugin_registry("0.3.4")).validate(&greet_flow("latest"));
        assert_eq!(codes(&bad), ["INVALID_REQUIREMENT"]);
    }

    #[test]
    fn deprecated_step_types_warn_with_the_replacement() {
        let mut registry = StepRegistry::with_builtins();
        let mut def = registry.get("log.message").unwrap().clone();
        def.step_type = "test.old".into();
        def.deprecated = Some(crate::registry::Deprecation {
            note: "It ignores `level`.".into(),
            replacement: Some("log.message".into()),
        });
        registry.register(def);
        let mut s = Flow::new("old");
        s.steps = vec![
            Step::new("test.old")
                .with_id("a")
                .with_param("message", "hi"),
        ];
        let report = Validator::new(registry).validate(&s);
        assert!(report.valid, "{report:?}");
        assert_eq!(codes(&report), ["DEPRECATED_STEP_TYPE"]);
        assert!(hint_of(&report, "DEPRECATED_STEP_TYPE").starts_with("Use 'log.message' instead."));
    }

    #[test]
    fn nodes_can_name_a_part_instead_of_the_target() {
        use crate::model::{Part, PartApp};
        let mut registry = StepRegistry::with_builtins();
        let mut def = registry.get("log.message").unwrap().clone();
        def.step_type = "desktop.poke".into();
        def.params_schema = json!({
            "type": "object",
            "required": ["target"],
            "properties": { "target": {
                "type": "object",
                "required": ["window"],
                "properties": { "window": { "type": "object" } },
                "additionalProperties": false
            } },
            "additionalProperties": false
        });
        registry.register(def);
        let poke = |id: &str, target: Value| {
            Step::new("desktop.poke")
                .with_id(id)
                .with_param("target", target)
        };
        let mut s = Flow::new("parts");
        s.parts.insert(
            "saveButton".into(),
            Part {
                label: "保存ボタン".into(),
                app: PartApp::Desktop,
                target: json!({ "window": { "process": "billing.exe" } }),
            },
        );
        s.parts.insert(
            "searchBox".into(),
            Part {
                label: String::new(),
                app: PartApp::Browser,
                target: json!({ "label": "検索" }),
            },
        );
        s.steps = vec![poke("a", json!({ "part": "saveButton" }))];
        let validator = Validator::new(registry);
        let report = validator.validate(&s);
        assert_eq!(report.error_count(), 0, "{report:?}");

        s.steps = vec![
            poke("b", json!({ "part": "nope" })),
            poke("c", json!({ "part": "searchBox" })),
            poke("d", json!({ "part": "saveButton", "nth": 1 })),
        ];
        let report = validator.validate(&s);
        assert_eq!(
            codes(&report),
            ["UNKNOWN_PART", "PART_APP_MISMATCH", "PART_WITH_FIELDS"]
        );
        assert!(hint_of(&report, "UNKNOWN_PART").contains("saveButton"));

        // A part the author could not see waits for a person to pick it:
        // each node that uses it says so, an unused one only reminds.
        s.parts.insert(
            "okButton".into(),
            Part {
                label: "OK ボタン".into(),
                app: PartApp::Desktop,
                target: Value::Null,
            },
        );
        s.steps = vec![
            poke("e", json!({ "part": "okButton" })),
            poke("f", json!({ "part": "okButton" })),
        ];
        let report = validator.validate(&s);
        assert_eq!(codes(&report), ["PART_NOT_PICKED", "PART_NOT_PICKED"]);
        assert!(
            report
                .issues
                .iter()
                .all(|i| i.severity == Severity::Error && i.step_id.is_some())
        );
        s.steps = vec![poke("a", json!({ "part": "saveButton" }))];
        let report = validator.validate(&s);
        assert!(report.valid, "{report:?}");
        assert_eq!(codes(&report), ["PART_NOT_PICKED"]);
        s.parts.remove("okButton");

        // The Runtime runs the part's target.
        s.steps = vec![poke("a", json!({ "part": "saveButton" }))];
        s.inline_parts();
        assert_eq!(
            s.steps[0].params["target"],
            json!({ "window": { "process": "billing.exe" } })
        );

        // Only a browser or desktop target names a part: other params may
        // carry their own `part` field (an HTTP body, say).
        assert!(crate::model::takes_part("browser.click", "target"));
        assert!(!crate::model::takes_part("http.request", "json"));
        assert!(!crate::model::takes_part("desktop.poke", "json"));
        let body = json!({ "part": "saveButton" });
        s.steps = vec![
            Step::new("http.request")
                .with_id("e")
                .with_param("json", body.clone()),
        ];
        s.inline_parts();
        assert_eq!(s.steps[0].params["json"], body);
    }
}

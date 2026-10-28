//! Scenario validation.
//!
//! Validation never mutates and never fails fast: it returns every issue so
//! that Studio can highlight them and AI clients can fix them in one round.
//! Errors block execution; warnings are advisory.

use std::collections::{BTreeSet, HashMap, HashSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::expr::{self, Expr};
use crate::ids::StepId;
use crate::model::{SCHEMA_VERSION, Scenario, Step};
use crate::registry::{StepRegistry, StepTypeDef, control, is_identifier};

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
    /// JSON Pointer into the scenario document.
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_id: Option<StepId>,
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

/// Validates scenarios against a step registry. Compiled parameter schemas
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

    pub fn validate(&self, scenario: &Scenario) -> ValidationReport {
        let mut cx = Cx {
            validator: self,
            issues: Vec::new(),
            seen_ids: HashSet::new(),
            known_vars: known_variables(scenario, &self.registry),
        };
        cx.scenario(scenario);
        let valid = !cx.issues.iter().any(|i| i.severity == Severity::Error);
        ValidationReport {
            valid,
            issues: cx.issues,
        }
    }

    /// Structural integrity only (IDs and tree shape). Edits that break these
    /// invariants are rejected; other issues are allowed in drafts.
    pub fn structural_errors(&self, scenario: &Scenario) -> Vec<ValidationIssue> {
        self.validate(scenario)
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

/// Every variable name that can be in scope somewhere in the scenario.
/// Scoping is intentionally flat (like most RPA tools): a name bound anywhere
/// is considered known everywhere; the Runtime reports actual undefined uses.
fn known_variables(scenario: &Scenario, registry: &StepRegistry) -> BTreeSet<String> {
    let mut names: BTreeSet<String> = scenario.variables.iter().map(|v| v.name.clone()).collect();
    names.insert(LAST_ERROR_VAR.to_owned());
    names.insert("error".to_owned());
    for step in scenario.walk() {
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
    }
    names
}

struct Cx<'a> {
    validator: &'a Validator,
    issues: Vec<ValidationIssue>,
    seen_ids: HashSet<StepId>,
    known_vars: BTreeSet<String>,
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
        });
    }

    fn error(&mut self, code: &str, message: String, path: String, step: Option<&StepId>) {
        self.push(Severity::Error, code, message, path, step);
    }

    fn warn(&mut self, code: &str, message: String, path: String, step: Option<&StepId>) {
        self.push(Severity::Warning, code, message, path, step);
    }

    fn scenario(&mut self, scenario: &Scenario) {
        if scenario.schema_version > SCHEMA_VERSION || scenario.schema_version == 0 {
            self.error(
                "UNSUPPORTED_SCHEMA_VERSION",
                format!(
                    "schemaVersion {} is not supported (current: {SCHEMA_VERSION})",
                    scenario.schema_version
                ),
                "/schemaVersion".into(),
                None,
            );
        }
        if !scenario.id.is_well_formed() {
            self.error(
                "INVALID_SCENARIO_ID",
                "scenario id must match [A-Za-z0-9_-]{1,128}".into(),
                "/id".into(),
                None,
            );
        }
        if scenario.name.trim().is_empty() {
            self.error(
                "EMPTY_NAME",
                "scenario name must not be empty".into(),
                "/name".into(),
                None,
            );
        }

        let mut var_names = HashSet::new();
        for (i, var) in scenario.variables.iter().enumerate() {
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
        }

        if let Some(retry) = &scenario.settings.default_retry
            && retry.max_attempts == 0
        {
            self.error(
                "INVALID_RETRY",
                "maxAttempts must be at least 1".into(),
                "/settings/defaultRetry/maxAttempts".into(),
                None,
            );
        }

        self.steps(&scenario.steps, "/steps", 0);
    }

    fn steps(&mut self, steps: &[Step], path: &str, loop_depth: usize) {
        for (i, step) in steps.iter().enumerate() {
            self.step(step, &format!("{path}/{i}"), loop_depth);
        }
    }

    fn step(&mut self, step: &Step, path: &str, loop_depth: usize) {
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

        let Some(def) = self.validator.registry.get(&step.step_type) else {
            self.error(
                "UNKNOWN_STEP_TYPE",
                format!("unknown step type '{}'", step.step_type),
                format!("{path}/type"),
                id,
            );
            // Still descend so nested IDs are checked.
            for (name, children) in &step.blocks {
                self.steps(children, &format!("{path}/blocks/{name}"), loop_depth);
            }
            return;
        };

        self.params(step, def, path);

        if let Some(save_as) = &step.save_as {
            if !is_identifier(save_as) {
                self.error(
                    "INVALID_VARIABLE_NAME",
                    format!("saveAs '{save_as}' is not a valid identifier"),
                    format!("{path}/saveAs"),
                    id,
                );
            }
            if !def.has_output {
                self.warn(
                    "NO_OUTPUT",
                    format!("'{}' produces no output for saveAs", def.step_type),
                    format!("{path}/saveAs"),
                    id,
                );
            }
        }

        if matches!(step.step_type.as_str(), control::BREAK | control::CONTINUE) && loop_depth == 0
        {
            self.error(
                "NOT_IN_LOOP",
                format!("'{}' must be inside a loop", step.step_type),
                format!("{path}/type"),
                id,
            );
        }

        // A branch of `control.parallel` cannot break out of an enclosing loop.
        let child_depth = if step.step_type == control::PARALLEL {
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
            }
            self.steps(children, &block_path, child_depth);
        }
    }

    fn params(&mut self, step: &Step, def: &StepTypeDef, path: &str) {
        let id = Some(&step.id);
        let instance = Value::Object(step.params.clone());
        match self.validator.schemas.get(&def.step_type) {
            Some(Ok(schema)) => {
                let errors: Vec<(String, String)> = schema
                    .iter_errors(&instance)
                    .map(|e| (e.instance_path().to_string(), e.to_string()))
                    .collect();
                for (pointer, message) in errors {
                    self.error(
                        "INVALID_PARAMS",
                        message,
                        format!("{path}/params{pointer}"),
                        id,
                    );
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

        for (key, value) in &step.params {
            let param_path = format!("{path}/params/{key}");
            if def.expression_params.contains(key) {
                if let Value::String(src) = value {
                    match Expr::parse(src) {
                        Ok(expr) => self.check_vars(expr.variables(), &param_path, id),
                        Err(e) => self.error(e.code(), e.to_string(), param_path, id),
                    }
                }
                continue;
            }
            let mut results = Vec::new();
            expr::visit_templates(value, &mut |r| results.push(r));
            for result in results {
                match result {
                    Ok(template) => self.check_vars(template.variables(), &param_path, id),
                    Err(e) => self.error(e.code(), e.to_string(), param_path.clone(), id),
                }
            }
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
            }
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::model::{VarType, VariableDef};
    use serde_json::json;

    fn validator() -> Validator {
        Validator::new(StepRegistry::with_builtins())
    }

    fn codes(report: &ValidationReport) -> Vec<&str> {
        report.issues.iter().map(|i| i.code.as_str()).collect()
    }

    #[test]
    fn valid_scenario_passes() {
        let mut s = Scenario::new("ok");
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
        let mut s = Scenario::new("bad");
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
        let mut s = Scenario::new("t");
        s.steps = vec![Step::new("log.message").with_id("a")];
        let report = validator().validate(&s);
        assert_eq!(codes(&report), ["INVALID_PARAMS"]);
        assert_eq!(report.issues[0].path, "/steps/0/params");
    }

    #[test]
    fn variable_set_requires_exactly_one_source() {
        let mut s = Scenario::new("t");
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
        let mut s = Scenario::new("t");
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
}

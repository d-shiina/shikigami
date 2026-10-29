//! Sub-scenarios: one scenario running another as a single step.
//!
//! A `scenario.call` step names the called scenario by ID and maps its
//! variables explicitly: `inputs` (called scenario's input → value) and
//! `outputs` (called scenario's output → variable of the caller). Nothing
//! else crosses the boundary. This module holds the checks that need the
//! called scenarios ([`check_calls`]) and the extraction of existing steps
//! into a new sub-scenario ([`extract`]).

use std::collections::{BTreeSet, HashMap, HashSet};

use serde_json::{Map, Value};

use crate::error::{CoreError, CoreResult};
use crate::expr::{self, Expr};
use crate::ids::{ScenarioId, StepId};
use crate::model::{Scenario, Step, VarDirection, VarType, VariableDef};
use crate::ops::Position;
use crate::registry::{StepRegistry, control, is_control_type, scenario::CALL};
use crate::validate::{Severity, ValidationIssue, Validator, closest, collect_writes, own_writes};

/// Deepest chain of nested calls a scenario may start.
pub const MAX_CALL_DEPTH: usize = 16;

/// A scenario a run may call, with the named version its content matches
/// (recorded in the run report).
#[derive(Debug, Clone, PartialEq)]
pub struct Subscenario {
    pub scenario: Scenario,
    pub version: Option<u32>,
    /// Its folder: relative paths in its steps are resolved from here.
    pub project_dir: Option<std::path::PathBuf>,
}

/// The scenario a call step names, if it names one.
pub fn call_target(step: &Step) -> Option<ScenarioId> {
    if step.step_type != CALL {
        return None;
    }
    step.params
        .get("scenario")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(ScenarioId::new)
}

/// Every scenario this one calls directly.
pub fn called_ids(scenario: &Scenario) -> BTreeSet<ScenarioId> {
    scenario.walk().filter_map(call_target).collect()
}

/// Steps with their JSON Pointer, in document order.
fn steps_with_paths<'a>(steps: &'a [Step], prefix: &str, out: &mut Vec<(&'a Step, String)>) {
    for (i, step) in steps.iter().enumerate() {
        let path = format!("{prefix}/{i}");
        for (name, children) in &step.blocks {
            steps_with_paths(children, &format!("{path}/blocks/{name}"), out);
        }
        out.push((step, path));
    }
}

/// Issues of the `scenario.call` steps in `scenario` that need the called
/// scenarios. `lookup` loads a scenario by ID (`None` when it does not exist).
pub fn check_calls(
    validator: &Validator,
    scenario: &Scenario,
    lookup: &dyn Fn(&ScenarioId) -> Option<Scenario>,
) -> Vec<ValidationIssue> {
    if !scenario.walk().any(|s| s.step_type == CALL) {
        return Vec::new();
    }
    let mut checker = Checker {
        validator,
        lookup,
        loaded: HashMap::new(),
        error_counts: HashMap::new(),
    };
    let mut stack = vec![scenario.id.clone()];
    checker.issues(scenario, &mut stack)
}

struct Checker<'a> {
    validator: &'a Validator,
    lookup: &'a dyn Fn(&ScenarioId) -> Option<Scenario>,
    loaded: HashMap<ScenarioId, Option<Scenario>>,
    error_counts: HashMap<ScenarioId, usize>,
}

fn issue(
    code: &str,
    message: String,
    path: String,
    step: &Step,
    hint: impl Into<String>,
) -> ValidationIssue {
    ValidationIssue {
        severity: Severity::Error,
        code: code.to_owned(),
        message,
        path,
        step_id: (!step.id.is_empty()).then(|| step.id.clone()),
        hint: Some(hint.into()),
    }
}

impl Checker<'_> {
    fn load(&mut self, id: &ScenarioId) -> Option<Scenario> {
        if let Some(found) = self.loaded.get(id) {
            return found.clone();
        }
        let found = (self.lookup)(id);
        self.loaded.insert(id.clone(), found.clone());
        found
    }

    /// Whether `from` calls (directly or through others) any of `targets`.
    fn reaches(&mut self, from: &ScenarioId, targets: &[ScenarioId]) -> bool {
        let mut seen = HashSet::new();
        let mut queue = vec![from.clone()];
        while let Some(id) = queue.pop() {
            if !seen.insert(id.clone()) {
                continue;
            }
            let Some(scenario) = self.load(&id) else {
                continue;
            };
            for next in called_ids(&scenario) {
                if targets.contains(&next) {
                    return true;
                }
                queue.push(next);
            }
        }
        false
    }

    /// Errors that would stop `callee` from running when called from the
    /// end of `stack`.
    fn error_count(&mut self, callee: &Scenario, stack: &mut Vec<ScenarioId>) -> usize {
        if let Some(count) = self.error_counts.get(&callee.id) {
            return *count;
        }
        let own = self.validator.validate(callee).error_count();
        stack.push(callee.id.clone());
        let nested = self
            .issues(callee, stack)
            .iter()
            .filter(|i| i.severity == Severity::Error)
            .count();
        stack.pop();
        self.error_counts.insert(callee.id.clone(), own + nested);
        own + nested
    }

    fn issues(&mut self, scenario: &Scenario, stack: &mut Vec<ScenarioId>) -> Vec<ValidationIssue> {
        let mut all = Vec::new();
        steps_with_paths(&scenario.steps, "/steps", &mut all);
        let mut out = Vec::new();
        for (step, path) in all {
            let Some(target) = call_target(step) else {
                continue;
            };
            let scenario_path = format!("{path}/params/scenario");
            if stack.contains(&target) || self.reaches(&target, stack) {
                out.push(issue(
                    "CALL_CYCLE",
                    format!("calling '{target}' leads back to a scenario that is already running"),
                    scenario_path,
                    step,
                    "A scenario cannot call itself, directly or through others. Move the shared steps into another scenario and call that one from both.",
                ));
                continue;
            }
            let Some(callee) = self.load(&target) else {
                out.push(issue(
                    "CALL_TARGET_NOT_FOUND",
                    format!("no scenario with id '{target}'"),
                    scenario_path,
                    step,
                    "Use the `id` of an existing scenario from list_scenarios. A deleted scenario can be restored from the workspace trash.",
                ));
                continue;
            };
            if stack.len() >= MAX_CALL_DEPTH {
                out.push(issue(
                    "CALL_TOO_DEEP",
                    format!("calls are nested more than {MAX_CALL_DEPTH} deep"),
                    scenario_path,
                    step,
                    "Flatten the chain: call the deepest scenarios directly from fewer levels.",
                ));
                continue;
            }
            let errors = self.error_count(&callee, stack);
            if errors > 0 {
                out.push(issue(
                    "CALL_TARGET_INVALID",
                    format!(
                        "the called scenario '{}' has {errors} validation error(s)",
                        callee.name
                    ),
                    scenario_path,
                    step,
                    format!(
                        "Fix the called scenario first: validate_scenario(\"{}\").",
                        callee.id
                    ),
                ));
            }
            self.inputs(step, &path, &callee, &mut out);
            self.outputs(step, &path, &callee, &mut out);
        }
        out
    }

    fn inputs(&self, step: &Step, path: &str, callee: &Scenario, out: &mut Vec<ValidationIssue>) {
        let declared: Vec<&VariableDef> = callee
            .variables
            .iter()
            .filter(|v| v.direction.is_input())
            .collect();
        let list = describe(&declared, true);
        let given = step.params.get("inputs").and_then(Value::as_object);
        for (key, value) in given.into_iter().flatten() {
            let pointer = format!("{path}/params/inputs/{key}");
            let Some(var) = declared.iter().find(|v| &v.name == key) else {
                let near = closest(key, declared.iter().map(|v| v.name.as_str()));
                out.push(issue(
                    "CALL_UNKNOWN_INPUT",
                    format!("'{}' has no input variable '{key}'", callee.name),
                    pointer,
                    step,
                    format!(
                        "{}Inputs of '{}': {list}.",
                        near.map(|n| format!("Did you mean '{n}'? "))
                            .unwrap_or_default(),
                        callee.name
                    ),
                ));
                continue;
            };
            let is_template = value.as_str().is_some_and(|s| s.contains("{{"));
            if var.secret && value.is_string() && !is_template {
                out.push(issue(
                    "CALL_SECRET_LITERAL",
                    format!("secret input '{key}' is written as plain text"),
                    pointer,
                    step,
                    "Pass a secret variable of this scenario instead, e.g. \"{{ password }}\".",
                ));
            } else if !is_template && !var.var_type.accepts(value) {
                out.push(issue(
                    "CALL_INPUT_TYPE",
                    format!("input '{key}' must be of type {:?}", var.var_type),
                    pointer,
                    step,
                    format!(
                        "Give a {} value, or a template such as \"{{{{ {key} }}}}\".",
                        type_name(var.var_type)
                    ),
                ));
            }
        }
        for var in &declared {
            if var.default.is_none() && !given.is_some_and(|g| g.contains_key(&var.name)) {
                out.push(issue(
                    "CALL_MISSING_INPUT",
                    format!("input '{}' of '{}' is required", var.name, callee.name),
                    format!("{path}/params/inputs"),
                    step,
                    format!(
                        "Add \"{}\": \"{{{{ … }}}}\" to `inputs`. Inputs of '{}': {list}.",
                        var.name, callee.name
                    ),
                ));
            }
        }
    }

    fn outputs(&self, step: &Step, path: &str, callee: &Scenario, out: &mut Vec<ValidationIssue>) {
        let declared: Vec<&VariableDef> = callee
            .variables
            .iter()
            .filter(|v| v.direction.is_output())
            .collect();
        let given = step.params.get("outputs").and_then(Value::as_object);
        for key in given.into_iter().flat_map(Map::keys) {
            if declared.iter().any(|v| &v.name == key) {
                continue;
            }
            let near = closest(key, declared.iter().map(|v| v.name.as_str()));
            out.push(issue(
                "CALL_UNKNOWN_OUTPUT",
                format!("'{}' has no output variable '{key}'", callee.name),
                format!("{path}/params/outputs/{key}"),
                step,
                if declared.is_empty() {
                    format!(
                        "'{}' returns nothing; remove `outputs` or give it an output variable (direction \"output\").",
                        callee.name
                    )
                } else {
                    format!(
                        "{}Outputs of '{}': {}.",
                        near.map(|n| format!("Did you mean '{n}'? "))
                            .unwrap_or_default(),
                        callee.name,
                        describe(&declared, false)
                    )
                },
            ));
        }
    }
}

fn type_name(t: VarType) -> &'static str {
    match t {
        VarType::String => "string",
        VarType::Number => "number",
        VarType::Boolean => "boolean",
        VarType::Object => "object",
        VarType::Array => "array",
        VarType::Any => "any",
    }
}

fn describe(vars: &[&VariableDef], inputs: bool) -> String {
    if vars.is_empty() {
        return "(none)".into();
    }
    vars.iter()
        .map(|v| {
            let optional = if inputs && v.default.is_some() {
                ", optional"
            } else {
                ""
            };
            format!("{} ({}{optional})", v.name, type_name(v.var_type))
        })
        .collect::<Vec<_>>()
        .join(", ")
}

// ---------------------------------------------------------------------------
// Extraction

/// Steps turned into a new scenario and the call that replaces them.
#[derive(Debug, Clone)]
pub struct Extraction {
    /// The new scenario (fresh ID, not stored yet).
    pub subscenario: Scenario,
    /// Where the call goes in the calling scenario (where the first
    /// extracted step was).
    pub position: Position,
    /// The extracted steps, to remove from the calling scenario.
    pub removed: Vec<StepId>,
    pub call: Step,
    /// Local variables to declare in the calling scenario (inputs it only
    /// assigned so far), so they always have a value to pass.
    pub declare: Vec<VariableDef>,
}

/// Variables a step's own params read (not its children's).
pub(crate) fn own_reads(step: &Step, registry: &StepRegistry, out: &mut BTreeSet<String>) {
    let def = registry.get(&step.step_type);
    for (key, value) in &step.params {
        let is_expression = def.is_some_and(|d| d.expression_params.contains(key));
        match value {
            Value::String(src) if is_expression => {
                if let Ok(e) = Expr::parse(src) {
                    out.extend(e.variables());
                }
            }
            _ => expr::visit_templates(value, &mut |t| {
                if let Ok(t) = t {
                    out.extend(t.variables());
                }
            }),
        }
    }
}

/// Names a control step binds for its own children (loop elements,
/// `errorVar`); they do not exist outside it.
fn scoped_binders(step: &Step, registry: &StepRegistry, out: &mut BTreeSet<String>) {
    if is_control_type(&step.step_type)
        && let Some(def) = registry.get(&step.step_type)
    {
        for key in &def.binds_variables {
            if let Some(Value::String(name)) = step.params.get(key) {
                out.insert(name.clone());
            }
        }
    }
    if step.step_type == control::TRY && !step.params.contains_key("errorVar") {
        out.insert("error".into());
    }
}

/// `break` / `continue` that would leave the given steps for an outer loop.
fn leaves_loop(steps: &[Step]) -> bool {
    steps.iter().any(|step| {
        if matches!(step.step_type.as_str(), control::BREAK | control::CONTINUE) {
            return true;
        }
        let is_loop = matches!(
            step.step_type.as_str(),
            control::WHILE | control::REPEAT | control::FOR_EACH
        );
        !is_loop && step.blocks.values().any(|children| leaves_loop(children))
    })
}

/// The step owning a list and the block name (`None` for the top level).
type Parent<'a> = Option<(&'a StepId, &'a str)>;

/// The list holding `id`, with its parent and the step's index in it.
fn locate<'a>(
    steps: &'a [Step],
    id: &StepId,
    parent: Parent<'a>,
) -> Option<(Parent<'a>, &'a [Step], usize)> {
    for (index, step) in steps.iter().enumerate() {
        if &step.id == id {
            return Some((parent, steps, index));
        }
        for (name, children) in &step.blocks {
            if let Some(found) = locate(children, id, Some((&step.id, name.as_str()))) {
                return Some(found);
            }
        }
    }
    None
}

/// Plans moving `step_ids` (next to each other in one block) into a new
/// scenario named `name`, called from where they were.
///
/// The call reads and writes the same variables the steps did, so the
/// calling scenario behaves as before: inputs are the variables the steps
/// read that the caller has (declared, or set earlier); outputs are the
/// variables they write that the caller has or reads elsewhere. An output
/// the caller already has is an input too (`inOut`), so a write that does
/// not happen leaves the caller's value as it was.
pub fn extract(
    caller: &Scenario,
    step_ids: &[StepId],
    name: &str,
    registry: &StepRegistry,
) -> CoreResult<Extraction> {
    let Some(first) = step_ids.first() else {
        return Err(CoreError::InvalidEdit("no steps to extract".into()));
    };
    let (parent, list, _) =
        locate(&caller.steps, first, None).ok_or_else(|| CoreError::StepNotFound(first.clone()))?;
    let mut indexes = Vec::with_capacity(step_ids.len());
    for id in step_ids {
        match locate(&caller.steps, id, None) {
            None => return Err(CoreError::StepNotFound(id.clone())),
            Some((p, _, index)) if p == parent => indexes.push(index),
            Some(_) => {
                return Err(CoreError::InvalidEdit(
                    "steps to extract must be in the same block".into(),
                ));
            }
        }
    }
    indexes.sort_unstable();
    indexes.dedup();
    let (start, end) = (indexes[0], indexes[indexes.len() - 1]);
    if end - start + 1 != indexes.len() {
        return Err(CoreError::InvalidEdit(
            "steps to extract must be next to each other".into(),
        ));
    }
    let steps = list[start..=end].to_vec();
    if leaves_loop(&steps) {
        return Err(CoreError::InvalidEdit(
            "the steps contain control.break or control.continue for a loop outside them".into(),
        ));
    }
    let removed: Vec<StepId> = steps.iter().map(|s| s.id.clone()).collect();

    // Inside the extracted steps.
    let (mut reads_in, mut writes_in, mut binders) =
        (BTreeSet::new(), BTreeSet::new(), BTreeSet::new());
    for step in &steps {
        collect_writes(step, registry, &mut writes_in);
        for s in step.walk() {
            own_reads(s, registry, &mut reads_in);
            scoped_binders(s, registry, &mut binders);
        }
    }

    // Everywhere else, in document order.
    let (mut reads_out, mut writes_before, mut writes_after) =
        (BTreeSet::new(), BTreeSet::new(), BTreeSet::new());
    let mut before = true;
    let mut stack: Vec<&Step> = caller.steps.iter().rev().collect();
    while let Some(step) = stack.pop() {
        if removed.contains(&step.id) {
            before = false;
            continue;
        }
        own_reads(step, registry, &mut reads_out);
        own_writes(
            step,
            registry,
            if before {
                &mut writes_before
            } else {
                &mut writes_after
            },
        );
        for children in step.blocks.values().rev() {
            stack.extend(children.iter().rev());
        }
    }

    let declared: BTreeSet<&str> = caller.variables.iter().map(|v| v.name.as_str()).collect();
    let returned: BTreeSet<&str> = caller
        .variables
        .iter()
        .filter(|v| v.direction.is_output())
        .map(|v| v.name.as_str())
        .collect();
    let has_value = |v: &str| declared.contains(v) || writes_before.contains(v);

    // Loop variables and `errorVar` are only local when nothing outside
    // sees them: variables are flat, so a loop leaves its last item behind.
    let outputs: BTreeSet<String> = writes_in
        .iter()
        .filter(|v| {
            declared.contains(v.as_str())
                || returned.contains(v.as_str())
                || reads_out.contains(*v)
                || writes_before.contains(*v)
                || writes_after.contains(*v)
        })
        .cloned()
        .collect();
    let inputs: BTreeSet<String> = reads_in
        .iter()
        .chain(outputs.iter())
        .filter(|v| !binders.contains(*v) && has_value(v))
        .cloned()
        .collect();
    // An input is passed as "{{ name }}", which fails when the variable was
    // never assigned (a branch that did not run). Declaring it in the caller
    // gives it a starting value (null) like every declared variable.
    let declare: Vec<VariableDef> = inputs
        .iter()
        .filter(|v| !declared.contains(v.as_str()))
        .map(|v| VariableDef::new(v.clone(), VarType::Any))
        .collect();

    let mut variables = Vec::new();
    for name in inputs.union(&outputs) {
        let direction = match (inputs.contains(name), outputs.contains(name)) {
            (true, true) => VarDirection::InOut,
            (true, false) => VarDirection::Input,
            _ => VarDirection::Output,
        };
        let var = match caller.variable(name) {
            Some(v) => VariableDef {
                direction,
                default: None,
                // A declared variable without a value starts as null, which
                // only `any` accepts as an input.
                var_type: if v.direction.is_input() || v.default.is_some() {
                    v.var_type
                } else {
                    VarType::Any
                },
                ..v.clone()
            },
            None => VariableDef {
                direction,
                ..VariableDef::new(name.clone(), VarType::Any)
            },
        };
        variables.push(var);
    }

    let name = if name.trim().is_empty() {
        steps
            .iter()
            .map(|s| s.name.trim())
            .find(|n| !n.is_empty())
            .unwrap_or("サブシナリオ")
            .to_owned()
    } else {
        name.trim().to_owned()
    };
    let mut subscenario = Scenario::new(name.clone());
    subscenario.description = format!("「{}」から切り出した処理", caller.name);
    subscenario.variables = variables;
    subscenario.steps = steps;
    // Same defaults, so the steps time out, retry and fail as before.
    subscenario.settings = caller.settings.clone();

    let mut call = Step::new(CALL)
        .with_name(name)
        .with_param("scenario", subscenario.id.as_str());
    if !inputs.is_empty() {
        let map: Map<String, Value> = inputs
            .iter()
            .map(|v| (v.clone(), Value::String(format!("{{{{ {v} }}}}"))))
            .collect();
        call = call.with_param("inputs", Value::Object(map));
    }
    if !outputs.is_empty() {
        let map: Map<String, Value> = outputs
            .iter()
            .map(|v| (v.clone(), Value::String(v.clone())))
            .collect();
        call = call.with_param("outputs", Value::Object(map));
    }

    let position = match parent {
        None => Position::root(Some(start)),
        Some((id, block)) => Position::in_block(id.clone(), block, Some(start)),
    };
    Ok(Extraction {
        subscenario,
        position,
        removed,
        call,
        declare,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::model::OnError;
    use serde_json::json;

    fn var(name: &str, ty: VarType, dir: VarDirection) -> VariableDef {
        VariableDef {
            direction: dir,
            ..VariableDef::new(name, ty)
        }
    }

    fn scenario(id: &str, variables: Vec<VariableDef>, steps: Vec<Step>) -> Scenario {
        let mut s = Scenario::new(id);
        s.id = id.into();
        s.variables = variables;
        s.steps = steps;
        let mut n = 0;
        fn ids(steps: &mut [Step], id: &str, n: &mut u32) {
            for step in steps {
                *n += 1;
                step.id = format!("{id}_{n}").into();
                for children in step.blocks.values_mut() {
                    ids(children, id, n);
                }
            }
        }
        ids(&mut s.steps, id, &mut n);
        s
    }

    fn call(target: &str, inputs: Value, outputs: Value) -> Step {
        Step::new(CALL)
            .with_param("scenario", target)
            .with_param("inputs", inputs)
            .with_param("outputs", outputs)
    }

    fn set(name: &str, expression: &str) -> Step {
        Step::new("variable.set")
            .with_param("name", name)
            .with_param("expression", expression)
    }

    fn tax() -> Scenario {
        scenario(
            "tax",
            vec![
                var("amount", VarType::Number, VarDirection::Input),
                VariableDef {
                    default: Some(json!(0.1)),
                    ..var("rate", VarType::Number, VarDirection::Input)
                },
                VariableDef {
                    secret: true,
                    ..var("pin", VarType::String, VarDirection::Input)
                },
                var("taxed", VarType::Number, VarDirection::Output),
            ],
            vec![set("taxed", "amount * (1 + rate)")],
        )
    }

    fn codes(validator: &Validator, s: &Scenario, others: &[Scenario]) -> Vec<String> {
        let lookup = |id: &ScenarioId| others.iter().find(|o| &o.id == id).cloned();
        validator
            .validate_with_calls(s, &lookup)
            .issues
            .into_iter()
            .map(|i| i.code)
            .collect()
    }

    #[test]
    fn calls_are_checked_against_the_called_scenario() {
        let validator = Validator::new(StepRegistry::with_builtins());
        let main = scenario(
            "main",
            vec![VariableDef::new("pinVar", VarType::String)],
            vec![
                call(
                    "tax",
                    json!({ "amount": 100, "pin": "{{ pinVar }}" }),
                    json!({ "taxed": "total" }),
                ),
                call(
                    "tax",
                    json!({ "amount": "高い", "amonut": 1, "pin": "1234" }),
                    json!({ "taxd": "total" }),
                ),
                call("nope", json!({}), json!({})),
            ],
        );
        let found = codes(&validator, &main, &[tax()]);
        for code in [
            "CALL_INPUT_TYPE",
            "CALL_UNKNOWN_INPUT",
            "CALL_SECRET_LITERAL",
            "CALL_UNKNOWN_OUTPUT",
            "CALL_TARGET_NOT_FOUND",
        ] {
            assert!(found.iter().any(|c| c == code), "{code} missing: {found:?}");
        }
        // `rate` has a default, `amount` and `pin` were given in the first call.
        assert!(
            !found.iter().any(|c| c == "CALL_MISSING_INPUT"),
            "{found:?}"
        );

        let missing = scenario("m", vec![], vec![call("tax", json!({}), json!({}))]);
        let found = codes(&validator, &missing, &[tax()]);
        assert_eq!(
            found.iter().filter(|c| *c == "CALL_MISSING_INPUT").count(),
            2,
            "{found:?}"
        );

        let report = validator.validate_with_calls(&main, &|_| Some(tax()));
        let hint = report
            .issues
            .iter()
            .find(|i| i.code == "CALL_UNKNOWN_INPUT")
            .and_then(|i| i.hint.clone())
            .unwrap();
        assert!(hint.contains("Did you mean 'amount'?"), "{hint}");
    }

    #[test]
    fn cycles_and_broken_targets_are_errors() {
        let validator = Validator::new(StepRegistry::with_builtins());
        let a = scenario("a", vec![], vec![call("b", json!({}), json!({}))]);
        let b = scenario("b", vec![], vec![call("a", json!({}), json!({}))]);
        assert!(codes(&validator, &a, &[a.clone(), b.clone()]).contains(&"CALL_CYCLE".into()));
        let selfish = scenario("s", vec![], vec![call("s", json!({}), json!({}))]);
        assert!(
            codes(&validator, &selfish, std::slice::from_ref(&selfish))
                .contains(&"CALL_CYCLE".into())
        );

        let broken = scenario("x", vec![], vec![Step::new("control.nope")]);
        let main = scenario("main", vec![], vec![call("x", json!({}), json!({}))]);
        assert!(codes(&validator, &main, &[broken]).contains(&"CALL_TARGET_INVALID".into()));
    }

    #[test]
    fn save_as_and_retry_are_rejected_and_outputs_count_as_writes() {
        let validator = Validator::new(StepRegistry::with_builtins());
        let mut with_save = call("tax", json!({ "amount": 1 }), json!({}));
        with_save.save_as = Some("x".into());
        with_save.retry = Some(crate::model::RetryPolicy {
            max_attempts: 2,
            backoff_ms: 0,
            backoff_multiplier: 1.0,
        });
        let branches = Step::new(control::PARALLEL).with_block(
            "branches",
            vec![
                call("tax", json!({ "amount": 1 }), json!({ "taxed": "total" })),
                set("total", "2"),
            ],
        );
        let main = scenario(
            "main",
            vec![],
            vec![
                with_save,
                branches,
                Step::new("log.message").with_param("message", "{{ total }}"),
            ],
        );
        let found = codes(&validator, &main, &[]);
        assert!(found.contains(&"CALL_SAVE_AS".into()), "{found:?}");
        assert!(found.contains(&"CALL_RETRY".into()), "{found:?}");
        assert!(
            found.contains(&"PARALLEL_VARIABLE_CONFLICT".into()),
            "{found:?}"
        );
        assert!(!found.contains(&"UNDEFINED_VARIABLE".into()), "{found:?}");
    }

    #[test]
    fn extraction_keeps_the_variables_flowing() {
        let registry = StepRegistry::with_builtins();
        let mut tolerant = set("note", "'ok'");
        tolerant.on_error = Some(OnError::Continue);
        let caller = scenario(
            "main",
            vec![
                VariableDef {
                    default: Some(json!([1, 2])),
                    ..var("items", VarType::Array, VarDirection::Input)
                },
                var("total", VarType::Number, VarDirection::Output),
            ],
            vec![
                set("total", "0"),
                set("rate", "2"),
                Step::new(control::FOR_EACH)
                    .with_param("items", "items")
                    .with_param("itemVar", "item")
                    .with_block(
                        "body",
                        vec![set("double", "item * rate"), set("total", "total + double")],
                    ),
                tolerant,
                Step::new("log.message").with_param("message", "{{ total }} {{ note }}"),
            ],
        );
        let ids: Vec<StepId> = caller.steps[2..4].iter().map(|s| s.id.clone()).collect();
        let plan = extract(&caller, &ids, "合計する", &registry).unwrap();

        let dirs: Vec<(String, VarDirection)> = plan
            .subscenario
            .variables
            .iter()
            .map(|v| (v.name.clone(), v.direction))
            .collect();
        assert_eq!(
            dirs,
            vec![
                ("items".to_owned(), VarDirection::Input),
                ("note".to_owned(), VarDirection::Output),
                ("rate".to_owned(), VarDirection::Input),
                ("total".to_owned(), VarDirection::InOut),
            ]
        );
        // `rate` was only assigned before; it is declared so it always has a value.
        assert_eq!(
            plan.declare
                .iter()
                .map(|v| v.name.as_str())
                .collect::<Vec<_>>(),
            ["rate"]
        );
        assert_eq!(plan.call.params["inputs"]["total"], json!("{{ total }}"));
        assert_eq!(plan.call.params["outputs"]["note"], json!("note"));
        assert_eq!(plan.position, Position::root(Some(2)));
        assert_eq!(plan.removed, ids);
        // `item` and `double` stay inside.
        assert!(plan.subscenario.variable("item").is_none());
        assert!(plan.subscenario.variable("double").is_none());
    }

    #[test]
    fn a_loop_variable_read_after_the_loop_comes_back_out() {
        let registry = StepRegistry::with_builtins();
        let caller = scenario(
            "main",
            vec![var("items", VarType::Array, VarDirection::Input)],
            vec![
                Step::new(control::FOR_EACH)
                    .with_param("items", "items")
                    .with_param("itemVar", "item")
                    .with_block("body", vec![set("seen", "item")]),
                Step::new("log.message").with_param("message", "last: {{ item }}"),
            ],
        );
        let plan = extract(&caller, &[caller.steps[0].id.clone()], "x", &registry).unwrap();
        assert_eq!(plan.call.params["outputs"]["item"], json!("item"));
        assert!(plan.call.params.get("inputs").unwrap()["item"].is_null());
        let report = Validator::new(StepRegistry::with_builtins()).validate(&plan.subscenario);
        assert!(report.valid, "{report:?}");
    }

    #[test]
    fn extraction_needs_neighbouring_steps_in_one_block() {
        let registry = StepRegistry::with_builtins();
        let caller = scenario(
            "main",
            vec![],
            vec![
                set("a", "1"),
                set("b", "2"),
                set("c", "3"),
                Step::new(control::REPEAT)
                    .with_param("count", 2)
                    .with_block("body", vec![Step::new(control::BREAK)]),
            ],
        );
        let id = |i: usize| caller.steps[i].id.clone();
        assert!(extract(&caller, &[id(0), id(2)], "x", &registry).is_err());
        let inner = caller.steps[3].block("body")[0].id.clone();
        assert!(extract(&caller, &[id(2), inner.clone()], "x", &registry).is_err());
        assert!(
            extract(&caller, &[inner], "x", &registry).is_err(),
            "break leaves"
        );
        assert!(extract(&caller, &[id(3)], "x", &registry).is_ok());
    }
}

//! Edit operations: the only way scenarios change.
//!
//! Studio, MCP tools and the CLI all express changes as [`EditOp`]s. Applying
//! an op returns its exact inverse, which powers undo/redo and makes every
//! change reviewable as a diff (AI repair proposals are just op lists).

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

use crate::error::{CoreError, CoreResult};
use crate::ids::StepId;
use crate::model::{Metadata, OnError, RetryPolicy, Scenario, ScenarioSettings, Step, VariableDef};

/// Where a step lives (or should be inserted).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    /// Parent control-flow step; omit for the top level.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<StepId>,
    /// Block of the parent (`then`, `else`, `body`, `try`, `catch`, `finally`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub block: Option<String>,
    /// Index in the target list (after removing the moved step). Omit to append.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<usize>,
}

impl Position {
    pub fn root(index: Option<usize>) -> Self {
        Self {
            parent_id: None,
            block: None,
            index,
        }
    }

    pub fn in_block(
        parent: impl Into<StepId>,
        block: impl Into<String>,
        index: Option<usize>,
    ) -> Self {
        Self {
            parent_id: Some(parent.into()),
            block: Some(block.into()),
            index,
        }
    }
}

/// Partial update of a step. Absent fields are left unchanged; for optional
/// fields, an explicit `null` clears the value.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StepPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// JSON Merge Patch (RFC 7386) applied to `params`: keys set to `null` are removed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Map<String, Value>>,
    /// Replaces `params` entirely. Mutually exclusive with `params`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replace_params: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled: Option<bool>,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Option<u64>")]
    pub timeout_ms: Option<Option<u64>>,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Option<RetryPolicy>")]
    pub retry: Option<Option<RetryPolicy>>,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Option<OnError>")]
    pub on_error: Option<Option<OnError>>,
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    #[schemars(with = "Option<String>")]
    pub save_as: Option<Option<String>>,
    /// Replaces `meta` entirely.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<Map<String, Value>>,
}

/// Partial update of scenario-level fields.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScenarioPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<ScenarioSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    /// Replaces `requires` (plugin version ranges). Core still adds plugins
    /// that steps use and drops unused ones afterwards.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum EditOp {
    /// Inserts a step (and its children). Missing IDs are generated.
    AddStep {
        step: Step,
        #[serde(default)]
        position: Position,
    },
    UpdateStep {
        step_id: StepId,
        patch: StepPatch,
    },
    /// Removes a step and all of its children.
    RemoveStep {
        step_id: StepId,
    },
    MoveStep {
        step_id: StepId,
        position: Position,
    },
    UpdateScenario {
        patch: ScenarioPatch,
    },
    /// Adds or replaces (by name) a variable declaration.
    SetVariable {
        variable: VariableDef,
        /// Position in the variable list when adding; ignored when replacing.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<usize>,
    },
    RemoveVariable {
        name: String,
    },
    /// Replaces the whole step tree (bulk edits by AI, imports).
    ReplaceSteps {
        steps: Vec<Step>,
    },
}

impl EditOp {
    /// Short English label for history entries.
    pub fn label(&self) -> String {
        match self {
            Self::AddStep { step, .. } => format!("add step {}", step.step_type),
            Self::UpdateStep { step_id, .. } => format!("update step {step_id}"),
            Self::RemoveStep { step_id } => format!("remove step {step_id}"),
            Self::MoveStep { step_id, .. } => format!("move step {step_id}"),
            Self::UpdateScenario { .. } => "update scenario".into(),
            Self::SetVariable { variable, .. } => format!("set variable {}", variable.name),
            Self::RemoveVariable { name } => format!("remove variable {name}"),
            Self::ReplaceSteps { .. } => "replace steps".into(),
        }
    }
}

fn double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// Applies `op` to `scenario` in place and returns the inverse op.
/// On error the scenario may be partially modified; callers apply batches to
/// a clone (see [`apply_all`]).
pub fn apply(scenario: &mut Scenario, op: EditOp) -> CoreResult<EditOp> {
    let inverse = apply_inner(scenario, op)?;
    // Empty blocks carry no meaning; dropping them keeps documents canonical
    // so that an op followed by its inverse restores an identical document.
    scenario.steps.iter_mut().for_each(prune_empty_blocks);
    Ok(inverse)
}

fn prune_empty_blocks(step: &mut Step) {
    step.blocks.retain(|_, children| !children.is_empty());
    for children in step.blocks.values_mut() {
        children.iter_mut().for_each(prune_empty_blocks);
    }
}

fn apply_inner(scenario: &mut Scenario, op: EditOp) -> CoreResult<EditOp> {
    match op {
        EditOp::AddStep { mut step, position } => {
            assign_missing_ids(&mut step);
            for s in step.walk() {
                if scenario.find_step(&s.id).is_some() {
                    return Err(CoreError::DuplicateStepId(s.id.clone()));
                }
            }
            let id = step.id.clone();
            insert(scenario, step, &position)?;
            Ok(EditOp::RemoveStep { step_id: id })
        }
        EditOp::RemoveStep { step_id } => {
            let (step, position) = take(scenario, &step_id)?;
            Ok(EditOp::AddStep { step, position })
        }
        EditOp::MoveStep { step_id, position } => {
            if let Some(parent) = &position.parent_id {
                let moving = scenario
                    .find_step(&step_id)
                    .ok_or_else(|| CoreError::StepNotFound(step_id.clone()))?;
                if moving.walk().any(|s| &s.id == parent) {
                    return Err(CoreError::InvalidEdit(
                        "cannot move a step into itself or its descendants".into(),
                    ));
                }
            }
            let (step, original) = take(scenario, &step_id)?;
            insert(scenario, step, &position)?;
            Ok(EditOp::MoveStep {
                step_id,
                position: original,
            })
        }
        EditOp::UpdateStep { step_id, patch } => {
            let step = find_step_mut(&mut scenario.steps, &step_id)
                .ok_or_else(|| CoreError::StepNotFound(step_id.clone()))?;
            let inverse = patch_step(step, patch)?;
            Ok(EditOp::UpdateStep {
                step_id,
                patch: inverse,
            })
        }
        EditOp::UpdateScenario { patch } => {
            let mut inverse = ScenarioPatch::default();
            if let Some(name) = patch.name {
                if name.trim().is_empty() {
                    return Err(CoreError::InvalidEdit(
                        "scenario name must not be empty".into(),
                    ));
                }
                inverse.name = Some(std::mem::replace(&mut scenario.name, name));
            }
            if let Some(description) = patch.description {
                inverse.description =
                    Some(std::mem::replace(&mut scenario.description, description));
            }
            if let Some(settings) = patch.settings {
                inverse.settings = Some(std::mem::replace(&mut scenario.settings, settings));
            }
            if let Some(tags) = patch.tags {
                inverse.tags = Some(std::mem::replace(&mut scenario.metadata.tags, tags));
            }
            if let Some(requires) = patch.requires {
                inverse.requires = Some(std::mem::replace(&mut scenario.requires, requires));
            }
            Ok(EditOp::UpdateScenario { patch: inverse })
        }
        EditOp::SetVariable { variable, index } => {
            if let Some(pos) = scenario
                .variables
                .iter()
                .position(|v| v.name == variable.name)
            {
                let old = std::mem::replace(&mut scenario.variables[pos], variable);
                Ok(EditOp::SetVariable {
                    variable: old,
                    index: None,
                })
            } else {
                let name = variable.name.clone();
                let at = index
                    .unwrap_or(scenario.variables.len())
                    .min(scenario.variables.len());
                scenario.variables.insert(at, variable);
                Ok(EditOp::RemoveVariable { name })
            }
        }
        EditOp::RemoveVariable { name } => {
            let pos = scenario
                .variables
                .iter()
                .position(|v| v.name == name)
                .ok_or_else(|| {
                    CoreError::InvalidEdit(format!("variable '{name}' does not exist"))
                })?;
            let variable = scenario.variables.remove(pos);
            Ok(EditOp::SetVariable {
                variable,
                index: Some(pos),
            })
        }
        EditOp::ReplaceSteps { mut steps } => {
            steps.iter_mut().for_each(assign_missing_ids);
            let old = std::mem::replace(&mut scenario.steps, steps);
            Ok(EditOp::ReplaceSteps { steps: old })
        }
    }
}

/// Applies a batch atomically. Returns the modified scenario and the inverse
/// ops in the order they must be applied to undo the batch.
pub fn apply_all(scenario: &Scenario, ops: Vec<EditOp>) -> CoreResult<(Scenario, Vec<EditOp>)> {
    let mut working = scenario.clone();
    let mut inverses = Vec::with_capacity(ops.len());
    for op in ops {
        inverses.push(apply(&mut working, op)?);
    }
    inverses.reverse();
    Ok((working, inverses))
}

/// Gives every step without an ID (recursively) a freshly generated one.
pub fn assign_missing_ids(step: &mut Step) {
    if step.id.is_empty() {
        step.id = StepId::generate();
    }
    for children in step.blocks.values_mut() {
        children.iter_mut().for_each(assign_missing_ids);
    }
}

fn find_step_mut<'a>(steps: &'a mut [Step], id: &StepId) -> Option<&'a mut Step> {
    for step in steps {
        if &step.id == id {
            return Some(step);
        }
        for children in step.blocks.values_mut() {
            if let Some(found) = find_step_mut(children, id) {
                return Some(found);
            }
        }
    }
    None
}

/// Resolves a position to the target list, validating the block name against
/// existing blocks or the caller-supplied name.
fn target_list<'a>(
    scenario: &'a mut Scenario,
    position: &Position,
) -> CoreResult<&'a mut Vec<Step>> {
    match &position.parent_id {
        None => {
            if position.block.is_some() {
                return Err(CoreError::InvalidEdit("block requires parentId".into()));
            }
            Ok(&mut scenario.steps)
        }
        Some(parent_id) => {
            let block = position
                .block
                .as_deref()
                .ok_or_else(|| CoreError::InvalidEdit("parentId requires block".into()))?;
            if block.is_empty() {
                return Err(CoreError::InvalidEdit("block must not be empty".into()));
            }
            let parent = find_step_mut(&mut scenario.steps, parent_id)
                .ok_or_else(|| CoreError::StepNotFound(parent_id.clone()))?;
            Ok(parent.blocks.entry(block.to_owned()).or_default())
        }
    }
}

fn insert(scenario: &mut Scenario, step: Step, position: &Position) -> CoreResult<()> {
    let list = target_list(scenario, position)?;
    let index = position.index.unwrap_or(list.len());
    if index > list.len() {
        return Err(CoreError::InvalidEdit(format!(
            "index {index} is out of range (list has {} step(s))",
            list.len()
        )));
    }
    list.insert(index, step);
    Ok(())
}

/// Removes a step and returns it together with its exact original position.
fn take(scenario: &mut Scenario, id: &StepId) -> CoreResult<(Step, Position)> {
    /// (removed step, parent id and block if nested, index in its list)
    type Taken = (Step, Option<(StepId, String)>, usize);
    fn take_from(steps: &mut Vec<Step>, id: &StepId) -> Option<Taken> {
        if let Some(index) = steps.iter().position(|s| &s.id == id) {
            return Some((steps.remove(index), None, index));
        }
        for step in steps.iter_mut() {
            let parent_id = step.id.clone();
            for (name, children) in step.blocks.iter_mut() {
                if let Some((found, parent, index)) = take_from(children, id) {
                    let parent = parent.or_else(|| Some((parent_id.clone(), name.clone())));
                    return Some((found, parent, index));
                }
            }
        }
        None
    }
    let (step, parent, index) =
        take_from(&mut scenario.steps, id).ok_or_else(|| CoreError::StepNotFound(id.clone()))?;
    let position = match parent {
        None => Position::root(Some(index)),
        Some((parent_id, block)) => Position::in_block(parent_id, block, Some(index)),
    };
    Ok((step, position))
}

fn merge_patch(target: &mut Map<String, Value>, patch: Map<String, Value>) {
    for (key, value) in patch {
        match value {
            Value::Null => {
                target.remove(&key);
            }
            Value::Object(sub) => {
                let entry = target
                    .entry(key)
                    .or_insert_with(|| Value::Object(Map::new()));
                if let Value::Object(existing) = entry {
                    merge_patch(existing, sub);
                } else {
                    let mut fresh = Map::new();
                    merge_patch(&mut fresh, sub);
                    *entry = Value::Object(fresh);
                }
            }
            other => {
                target.insert(key, other);
            }
        }
    }
}

fn patch_step(step: &mut Step, patch: StepPatch) -> CoreResult<StepPatch> {
    if patch.params.is_some() && patch.replace_params.is_some() {
        return Err(CoreError::InvalidEdit(
            "params and replaceParams are mutually exclusive".into(),
        ));
    }
    let mut inverse = StepPatch::default();
    if let Some(name) = patch.name {
        inverse.name = Some(std::mem::replace(&mut step.name, name));
    }
    if let Some(description) = patch.description {
        inverse.description = Some(std::mem::replace(&mut step.description, description));
    }
    if let Some(params) = patch.params {
        inverse.replace_params = Some(step.params.clone());
        merge_patch(&mut step.params, params);
    }
    if let Some(params) = patch.replace_params {
        inverse.replace_params = Some(std::mem::replace(&mut step.params, params));
    }
    if let Some(disabled) = patch.disabled {
        inverse.disabled = Some(std::mem::replace(&mut step.disabled, disabled));
    }
    if let Some(timeout) = patch.timeout_ms {
        inverse.timeout_ms = Some(std::mem::replace(&mut step.timeout_ms, timeout));
    }
    if let Some(retry) = patch.retry {
        inverse.retry = Some(std::mem::replace(&mut step.retry, retry));
    }
    if let Some(on_error) = patch.on_error {
        inverse.on_error = Some(std::mem::replace(&mut step.on_error, on_error));
    }
    if let Some(save_as) = patch.save_as {
        inverse.save_as = Some(std::mem::replace(&mut step.save_as, save_as));
    }
    if let Some(meta) = patch.meta {
        inverse.meta = Some(std::mem::replace(&mut step.meta, meta));
    }
    Ok(inverse)
}

/// Keeps metadata timestamps current after an edit.
pub(crate) fn touch(metadata: &mut Metadata) {
    metadata.updated_at = Some(crate::model::now());
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Scenario {
        let mut s = Scenario::new("t");
        s.steps = vec![
            Step::new("log.message")
                .with_id("a")
                .with_param("message", "1"),
            Step::new("control.if")
                .with_id("if")
                .with_param("condition", "true")
                .with_block("then", vec![Step::new("log.message").with_id("b")]),
            Step::new("log.message").with_id("c"),
        ];
        s
    }

    fn ids(s: &Scenario) -> Vec<String> {
        s.walk().map(|x| x.id.to_string()).collect()
    }

    /// Applies ops, then their inverses, and checks we are back to the start.
    fn assert_round_trip(ops: Vec<EditOp>) -> Scenario {
        let original = sample();
        let (edited, inverses) = apply_all(&original, ops).expect("apply");
        let (restored, _) = apply_all(&edited, inverses).expect("undo");
        assert_eq!(restored, original);
        edited
    }

    #[test]
    fn add_step_assigns_ids_and_inverts() {
        let edited = assert_round_trip(vec![EditOp::AddStep {
            step: Step::new("control.repeat")
                .with_param("count", 2)
                .with_block("body", vec![Step::new("log.message")]),
            position: Position::in_block("if", "else", Some(0)),
        }]);
        assert_eq!(edited.walk().count(), 6);
        assert!(edited.walk().all(|s| !s.id.is_empty()));
    }

    #[test]
    fn duplicate_ids_are_rejected() {
        let err = apply_all(
            &sample(),
            vec![EditOp::AddStep {
                step: Step::new("log.message").with_id("b"),
                position: Position::default(),
            }],
        )
        .expect_err("dup");
        assert_eq!(err.code(), "DUPLICATE_STEP_ID");
    }

    #[test]
    fn remove_restores_exact_position() {
        let edited = assert_round_trip(vec![EditOp::RemoveStep {
            step_id: "b".into(),
        }]);
        assert_eq!(ids(&edited), ["a", "if", "c"]);
    }

    #[test]
    fn move_between_blocks_and_back() {
        let edited = assert_round_trip(vec![EditOp::MoveStep {
            step_id: "a".into(),
            position: Position::in_block("if", "then", Some(1)),
        }]);
        assert_eq!(ids(&edited), ["if", "b", "a", "c"]);

        let edited = assert_round_trip(vec![EditOp::MoveStep {
            step_id: "a".into(),
            position: Position::root(None),
        }]);
        assert_eq!(ids(&edited), ["if", "b", "c", "a"]);
    }

    #[test]
    fn cannot_move_into_own_descendant() {
        let err = apply_all(
            &sample(),
            vec![EditOp::MoveStep {
                step_id: "if".into(),
                position: Position::in_block("b", "body", None),
            }],
        )
        .expect_err("cycle");
        assert_eq!(err.code(), "INVALID_EDIT");
        let err = apply_all(
            &sample(),
            vec![EditOp::MoveStep {
                step_id: "if".into(),
                position: Position::in_block("if", "then", None),
            }],
        )
        .expect_err("self");
        assert_eq!(err.code(), "INVALID_EDIT");
    }

    #[test]
    fn update_step_with_merge_patch_inverts() {
        let patch: StepPatch = serde_json::from_value(json!({
            "name": "挨拶",
            "params": { "message": "hi", "level": "warn" },
            "timeoutMs": 5000,
            "saveAs": null,
        }))
        .expect("patch");
        assert_eq!(patch.save_as, Some(None));
        let edited = assert_round_trip(vec![EditOp::UpdateStep {
            step_id: "a".into(),
            patch,
        }]);
        let a = edited.find_step(&"a".into()).expect("a");
        assert_eq!(a.params.get("level"), Some(&json!("warn")));
        assert_eq!(a.timeout_ms, Some(5000));

        let remove_key: StepPatch =
            serde_json::from_value(json!({ "params": { "message": null } })).expect("patch");
        let edited = assert_round_trip(vec![EditOp::UpdateStep {
            step_id: "a".into(),
            patch: remove_key,
        }]);
        assert!(edited.find_step(&"a".into()).expect("a").params.is_empty());
    }

    #[test]
    fn batches_are_atomic() {
        let original = sample();
        let result = apply_all(
            &original,
            vec![
                EditOp::RemoveStep {
                    step_id: "a".into(),
                },
                EditOp::RemoveStep {
                    step_id: "missing".into(),
                },
            ],
        );
        assert!(result.is_err());
        assert_eq!(original.walk().count(), 4);
    }

    #[test]
    fn variables_and_scenario_fields_invert() {
        let mut v = VariableDef::new("x", crate::model::VarType::Number);
        v.default = Some(json!(1));
        assert_round_trip(vec![
            EditOp::SetVariable {
                variable: v.clone(),
                index: None,
            },
            EditOp::SetVariable {
                variable: VariableDef {
                    default: Some(json!(2)),
                    ..v
                },
                index: None,
            },
            EditOp::UpdateScenario {
                patch: ScenarioPatch {
                    name: Some("新しい名前".into()),
                    tags: Some(vec!["x".into()]),
                    ..Default::default()
                },
            },
            EditOp::ReplaceSteps {
                steps: vec![Step::new("log.message")],
            },
        ]);
    }

    #[test]
    fn ops_have_stable_json_shape() {
        let op: EditOp = serde_json::from_value(json!({
            "op": "moveStep",
            "stepId": "a",
            "position": { "parentId": "if", "block": "then", "index": 0 }
        }))
        .expect("parse");
        assert_eq!(
            op,
            EditOp::MoveStep {
                step_id: "a".into(),
                position: Position::in_block("if", "then", Some(0))
            }
        );
    }
}

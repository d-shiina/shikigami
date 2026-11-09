//! What each node is called where people read about a run: its name, else
//! its type's label. The run log (`logs/`) and the final error (report,
//! notifications, the CLI) say where something happened in these words;
//! the step ID stays beside them as the key that finds the node.

use std::collections::HashMap;

use serde_json::Value;
use spellsheet_core::{Flow, FlowId, StepId, StepRegistry};

use crate::event::RunError;

#[derive(Debug, Default, Clone)]
pub struct StepNames {
    /// Copies of a flow share step IDs, so a step is known by its flow.
    by_flow: HashMap<(FlowId, StepId), String>,
    /// For events, which carry only the step ID (the run's own flow wins).
    by_step: HashMap<StepId, String>,
}

impl StepNames {
    /// The names of every step of `flows`; the first flow is the run's own.
    pub fn new<'a>(flows: impl IntoIterator<Item = &'a Flow>, registry: &StepRegistry) -> Self {
        let mut names = Self::default();
        for flow in flows {
            for step in flow.walk() {
                let name = if step.name.trim().is_empty() {
                    registry
                        .get(&step.step_type)
                        .map_or_else(|| step.step_type.clone(), |d| d.label.clone())
                } else {
                    step.name.trim().to_owned()
                };
                names
                    .by_step
                    .entry(step.id.clone())
                    .or_insert_with(|| name.clone());
                names
                    .by_flow
                    .insert((flow.id.clone(), step.id.clone()), name);
            }
        }
        names
    }

    /// The step's name, "" when it is not known.
    pub fn step(&self, id: &StepId) -> &str {
        self.by_step.get(id).map_or("", String::as_str)
    }

    fn in_flow(&self, flow: &str, step: &str) -> Option<&String> {
        self.by_flow.get(&(FlowId::from(flow), StepId::from(step)))
    }

    /// Fills `stepLabel` of the error `flow` ended with, and of the place
    /// inside a called flow (`details.subFlow`) it came from.
    pub fn label(&self, flow: &FlowId, error: &mut RunError) {
        if error.step_label.is_none()
            && let Some(step) = &error.step_id
        {
            error.step_label = self.in_flow(flow.as_str(), step.as_str()).cloned();
        }
        let Some(Value::Object(sub)) = error.details.as_mut().and_then(|d| d.get_mut("subFlow"))
        else {
            return;
        };
        if sub.contains_key("stepLabel") {
            return;
        }
        let place = (
            sub.get("flowId").and_then(Value::as_str),
            sub.get("stepId").and_then(Value::as_str),
        );
        if let (Some(f), Some(s)) = place
            && let Some(name) = self.in_flow(f, s)
        {
            sub.insert("stepLabel".to_owned(), Value::String(name.clone()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn flow(value: Value) -> Flow {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn names_steps_by_name_else_type_label() {
        let main = flow(json!({
            "schemaVersion": 1, "id": "main", "name": "main", "revision": 1,
            "steps": [
                { "id": "a", "type": "log.message", "name": " 請求書の保存 ", "params": { "message": "x" } },
                { "id": "b", "type": "log.message", "params": { "message": "x" } },
                { "id": "c", "type": "plugin.unknown" },
                { "id": "call", "type": "flow.call", "params": { "flow": "sub" } }
            ]
        }));
        let sub = flow(json!({
            "schemaVersion": 1, "id": "sub", "name": "sub", "revision": 1,
            "steps": [{ "id": "a", "type": "log.message", "name": "出荷", "params": { "message": "x" } }]
        }));
        let registry = StepRegistry::with_builtins();
        let names = StepNames::new([&main, &sub], &registry);
        assert_eq!(names.step(&"a".into()), "請求書の保存");
        let label = registry.get("log.message").unwrap().label.clone();
        assert_eq!(names.step(&"b".into()), label);
        assert_eq!(names.step(&"c".into()), "plugin.unknown");

        let mut error =
            RunError::new("ELEMENT_NOT_FOUND", "no button").at_step(&"call".into(), "flow.call");
        error.details = Some(json!({ "subFlow": { "flowId": "sub", "stepId": "a" } }));
        names.label(&"main".into(), &mut error);
        assert_eq!(
            error.step_label.as_deref(),
            Some(registry.get("flow.call").unwrap().label.as_str())
        );
        assert_eq!(error.details.unwrap()["subFlow"]["stepLabel"], "出荷");
    }
}

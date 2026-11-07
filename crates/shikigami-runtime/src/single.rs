//! Running one step on its own: the AI's `test_step` and Studio's
//! 「ノードの単体実行」 both build the same one-step flow here, so a node
//! tried alone behaves the same whoever tries it.
//!
//! Only the step runs. The values it reads (`{{ customer }}`, a repeat's
//! `item`) are given as `inputs`: Studio passes what the last run left, the
//! AI passes literal params. Nothing before the step runs again.

use serde_json::{Map, Value};
use shikigami_core::registry::flow::CALL;
use shikigami_core::{Flow, FlowId, Part, Step, StepRegistry, VarDirection, VarType, VariableDef};

/// The variable a step's result is saved to when it names none.
pub const OUTPUT: &str = "output";

/// A one-step flow, ready for [`crate::Runtime::start`].
#[derive(Debug, Clone)]
pub struct SingleStep {
    pub flow: Flow,
    /// The variable holding the step's result, when it has one.
    pub output: Option<String>,
    /// The variables a `flow.call` maps its outputs to, returned together.
    pub call_outputs: Vec<String>,
}

impl SingleStep {
    /// The step's result from the run's outputs: the saved value, or for a
    /// `flow.call` an object of its outputs.
    pub fn result(&self, outputs: &Map<String, Value>) -> Value {
        if !self.call_outputs.is_empty() {
            let picked = self
                .call_outputs
                .iter()
                .filter_map(|name| outputs.get(name).map(|v| (name.clone(), v.clone())))
                .collect();
            return Value::Object(picked);
        }
        self.output
            .as_ref()
            .and_then(|name| outputs.get(name).cloned())
            .unwrap_or(Value::Null)
    }
}

/// What to build the one-step flow from, besides the step.
#[derive(Debug, Default)]
pub struct Context<'a> {
    /// Run events carry this id, so a client can match them to its flow.
    pub flow_id: Option<FlowId>,
    /// Named screen parts the step's target may refer to.
    pub parts: Option<&'a std::collections::BTreeMap<String, Part>>,
}

/// Builds the flow that runs `step` alone, with `inputs` (the values it
/// reads, by variable name) declared as input variables: pass the same map
/// as the run's `RunOptions::inputs`. A step its registry does not know is
/// returned as an error message.
pub fn flow_for(
    mut step: Step,
    registry: &StepRegistry,
    inputs: &Map<String, Value>,
    ctx: Context<'_>,
) -> Result<SingleStep, String> {
    let def = registry
        .get(&step.step_type)
        .ok_or_else(|| format!("unknown step type '{}'", step.step_type))?;
    let name = if step.name.trim().is_empty() {
        step.step_type.clone()
    } else {
        step.name.clone()
    };
    let mut flow = Flow::new(name);
    if let Some(id) = ctx.flow_id {
        flow.id = id;
    }
    if let Some(parts) = ctx.parts {
        flow.parts = parts.clone();
    }
    step.disabled = false;
    shikigami_core::ops::assign_missing_ids(&mut step);

    let mut output = None;
    if def.has_output {
        let name = step
            .save_as
            .clone()
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| OUTPUT.to_owned());
        step.save_as = Some(name.clone());
        flow.variables.push(output_var(&name));
        output = Some(name);
    } else {
        step.save_as = None;
    }
    // A call's outputs become outputs of the test run.
    let call_outputs: Vec<String> = if step.step_type == CALL {
        step.params
            .get("outputs")
            .and_then(Value::as_object)
            .map(|m| {
                m.values()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    for name in &call_outputs {
        if !flow.variables.iter().any(|v| &v.name == name) {
            flow.variables.push(output_var(name));
        }
    }
    for name in inputs.keys() {
        if flow.variables.iter().any(|v| &v.name == name) {
            continue;
        }
        flow.variables.push(VariableDef {
            direction: VarDirection::Input,
            ..VariableDef::new(name.clone(), VarType::Any)
        });
    }
    flow.steps = vec![step];
    Ok(SingleStep {
        flow,
        output,
        call_outputs,
    })
}

fn output_var(name: &str) -> VariableDef {
    VariableDef {
        direction: VarDirection::Output,
        ..VariableDef::new(name, VarType::Any)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::{RunOptions, RunStatus, Runtime};
    use serde_json::json;

    fn inputs(v: Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap_or_default()
    }

    #[tokio::test]
    async fn runs_only_the_step_with_the_given_values() {
        let runtime = Runtime::builder().build();
        let mut step = Step::new("variable.set")
            .with_param("name", "total")
            .with_param("expression", "price * 2");
        step.save_as = Some("doubled".into());
        let values = inputs(json!({ "price": 21 }));
        let id = FlowId::new("scn_x");
        let one = flow_for(
            step,
            runtime.registry(),
            &values,
            Context {
                flow_id: Some(id.clone()),
                ..Context::default()
            },
        )
        .unwrap();
        assert_eq!(one.flow.id, id);
        assert_eq!(one.output.as_deref(), Some("doubled"));
        let report = runtime
            .start(
                one.flow.clone(),
                RunOptions {
                    inputs: values,
                    ..RunOptions::default()
                },
            )
            .expect("start")
            .wait()
            .await
            .expect("wait");
        assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
        assert_eq!(one.result(&report.outputs), json!(42));
    }

    #[test]
    fn names_a_result_variable_when_the_step_has_none() {
        let runtime = Runtime::builder().build();
        let step = Step::new("variable.set")
            .with_param("name", "x")
            .with_param("value", 1);
        let values = Map::new();
        let one = flow_for(step, runtime.registry(), &values, Context::default()).unwrap();
        assert_eq!(one.output.as_deref(), Some(OUTPUT));
        assert!(!one.flow.steps[0].id.as_str().is_empty());
    }

    #[test]
    fn rejects_unknown_step_types() {
        let runtime = Runtime::builder().build();
        let values = Map::new();
        let err = flow_for(
            Step::new("nope.nothing"),
            runtime.registry(),
            &values,
            Context::default(),
        );
        assert!(err.is_err());
    }
}

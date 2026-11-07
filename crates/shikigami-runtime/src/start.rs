//! 「ここから実行」: a run that starts at a chosen step instead of the first.
//! The steps before it do not run; the run's flow is the same flow with
//! them taken away, so step IDs, the log and Studio's chart stay as they
//! are. The step may be inside groups and try blocks (entered as if their
//! earlier steps were done), not inside a repeat or a branch: which round
//! or which branch it would be is not known.

use shikigami_core::registry::control;
use shikigami_core::{Step, StepId};

use crate::RunError;

/// `steps` from `start` on: at each level, the block that holds it with
/// the steps before it taken away.
pub fn steps_from(steps: &[Step], start: &StepId) -> Result<Vec<Step>, RunError> {
    match find(steps, start)? {
        Some(trimmed) => Ok(trimmed),
        None => Err(RunError::new(
            "START_STEP_NOT_FOUND",
            format!("there is no step {start} in the flow"),
        )),
    }
}

fn find(steps: &[Step], start: &StepId) -> Result<Option<Vec<Step>>, RunError> {
    for (index, step) in steps.iter().enumerate() {
        if &step.id == start {
            return Ok(Some(steps[index..].to_vec()));
        }
        for (name, block) in &step.blocks {
            let enterable = match step.step_type.as_str() {
                control::GROUP => name == "body",
                control::TRY => name == "try",
                _ => false,
            };
            let Some(inner) = find(block, start)? else {
                continue;
            };
            if !enterable {
                return Err(RunError {
                    details: Some(
                        serde_json::json!({ "inside": step.id, "insideType": step.step_type }),
                    ),
                    ..RunError::new(
                        "START_INSIDE_BLOCK",
                        "a run cannot start inside a repeat, a branch or a catch / finally block",
                    )
                });
            }
            let mut entered = step.clone();
            entered.blocks.insert(name.clone(), inner);
            let mut rest = vec![entered];
            rest.extend_from_slice(&steps[index + 1..]);
            return Ok(Some(rest));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(id: &str) -> Step {
        Step::new("test.ok").with_id(id)
    }

    fn with_block(mut parent: Step, name: &str, children: Vec<Step>) -> Step {
        parent.blocks.insert(name.into(), children);
        parent
    }

    fn ids(steps: &[Step]) -> Vec<String> {
        steps.iter().map(|s| s.id.to_string()).collect()
    }

    #[test]
    fn starts_at_a_step_inside_groups_and_try() {
        let flow = vec![
            step("a"),
            with_block(
                Step::new(control::GROUP).with_id("g"),
                "body",
                vec![
                    step("b"),
                    with_block(
                        Step::new(control::TRY).with_id("t"),
                        "try",
                        vec![step("c"), step("d")],
                    ),
                    step("e"),
                ],
            ),
            step("f"),
        ];
        assert_eq!(ids(&steps_from(&flow, &StepId::from("f")).unwrap()), ["f"]);
        let from_d = steps_from(&flow, &StepId::from("d")).unwrap();
        assert_eq!(ids(&from_d), ["g", "f"]);
        assert_eq!(ids(&from_d[0].blocks["body"]), ["t", "e"]);
        assert_eq!(ids(&from_d[0].blocks["body"][0].blocks["try"]), ["d"]);
        assert_eq!(
            steps_from(&flow, &StepId::from("x")).unwrap_err().code,
            "START_STEP_NOT_FOUND"
        );
    }

    #[test]
    fn not_inside_a_repeat() {
        let flow = vec![with_block(
            Step::new(control::FOR_EACH).with_id("l"),
            "body",
            vec![step("b")],
        )];
        assert_eq!(
            steps_from(&flow, &StepId::from("b")).unwrap_err().code,
            "START_INSIDE_BLOCK"
        );
        // The repeat itself is a fine place to start.
        assert_eq!(ids(&steps_from(&flow, &StepId::from("l")).unwrap()), ["l"]);
    }
}

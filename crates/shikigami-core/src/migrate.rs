//! Flow format versioning.
//!
//! Documents are read as raw JSON first, upgraded one version at a time to
//! [`SCHEMA_VERSION`], and only then deserialized. Newer documents than this
//! build understands are rejected instead of being silently truncated.
//!
//! Every place that reads a flow (files, named versions, bundles, the
//! flows a bundle carries) goes through [`from_value`], so a migration
//! written here applies everywhere. The rules for when to bump the version
//! are in docs/compatibility.md.
//!
//! Built-in step types ship with this binary, so a change to their `params`
//! that old files cannot satisfy is also a format change: bump
//! [`SCHEMA_VERSION`] and rewrite the old params in the migration, using
//! [`for_each_step`]. Plugins version their steps themselves (`requires`).

use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value};

use crate::error::{CoreError, CoreResult};
use crate::model::{Flow, SCHEMA_VERSION};

/// One upgrade step: turns a document of version `from` into `from + 1`.
struct Migration {
    from: u32,
    apply: fn(&mut Value),
}

/// Every migration, oldest first. Each one only has to know the version
/// right before it.
const MIGRATIONS: &[Migration] = &[
    Migration {
        from: 1,
        apply: v1_to_v2,
    },
    Migration {
        from: 2,
        apply: v2_to_v3,
    },
    Migration {
        from: 3,
        apply: v3_to_v4,
    },
];

/// Parses flow JSON text, applying migrations when needed.
pub fn parse_flow(text: &str) -> CoreResult<Flow> {
    let value: Value = serde_json::from_str(text)?;
    from_value(value)
}

pub fn from_value(mut value: Value) -> CoreResult<Flow> {
    upgrade(&mut value)?;
    Ok(serde_json::from_value(value)?)
}

/// Brings a flow document up to [`SCHEMA_VERSION`] in place.
pub fn upgrade(value: &mut Value) -> CoreResult<()> {
    let found = check_supported(value)?;
    for migration in MIGRATIONS.iter().filter(|m| m.from >= found) {
        (migration.apply)(value);
    }
    if let Some(obj) = value.as_object_mut() {
        obj.insert("schemaVersion".into(), Value::from(SCHEMA_VERSION));
    }
    Ok(())
}

/// The document's format version, or an error when it is newer than this
/// build. A missing version counts as the current one.
pub fn check_supported(value: &Value) -> CoreResult<u32> {
    let found = value
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .map_or(SCHEMA_VERSION, |v| u32::try_from(v).unwrap_or(u32::MAX));
    if found > SCHEMA_VERSION {
        return Err(CoreError::UnsupportedSchemaVersion {
            found,
            supported: SCHEMA_VERSION,
        });
    }
    Ok(found)
}

/// For `#[serde(deserialize_with)]` on fields that hold a whole flow
/// (named versions, bundles), so they are migrated like files.
pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Flow, D::Error> {
    let value = Value::deserialize(deserializer)?;
    from_value(value).map_err(serde::de::Error::custom)
}

/// Like [`deserialize`], for a list of flows.
pub fn deserialize_vec<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<Flow>, D::Error> {
    Vec::<Value>::deserialize(deserializer)?
        .into_iter()
        .map(|value| from_value(value).map_err(serde::de::Error::custom))
        .collect()
}

/// Calls `f` with every step object of a not-yet-deserialized flow,
/// nested ones included. Migrations of step params use it.
pub(crate) fn for_each_step(value: &mut Value, f: &mut dyn FnMut(&mut Map<String, Value>)) {
    fn visit(steps: &mut Value, f: &mut dyn FnMut(&mut Map<String, Value>)) {
        let Some(steps) = steps.as_array_mut() else {
            return;
        };
        for step in steps {
            let Some(obj) = step.as_object_mut() else {
                continue;
            };
            f(obj);
            if let Some(blocks) = obj.get_mut("blocks").and_then(Value::as_object_mut) {
                for children in blocks.values_mut() {
                    visit(children, f);
                }
            }
        }
    }
    if let Some(steps) = value.get_mut("steps") {
        visit(steps, f);
    }
}

/// 1 → 2: adds `requires` (plugins a flow needs). Nothing to rewrite;
/// the bump makes older builds say "update Shikigami" instead of failing
/// on an unknown field.
fn v1_to_v2(_value: &mut Value) {}

/// 2 → 3: adds `settings.keepWork`. Relative paths in path params now
/// resolve from the flow's folder; before they depended on the folder
/// the process started in (and validation warned against them), so there
/// is nothing to rewrite.
fn v2_to_v3(_value: &mut Value) {}

/// 3 → 4: scenarios were renamed to flows. The call step
/// `scenario.call { scenario }` becomes `flow.call { flow }`.
fn v3_to_v4(value: &mut Value) {
    for_each_step(value, &mut |step| {
        if step.get("type").and_then(Value::as_str) != Some("scenario.call") {
            return;
        }
        step.insert("type".into(), Value::from("flow.call"));
        if let Some(params) = step.get_mut("params").and_then(Value::as_object_mut)
            && let Some(target) = params.remove("scenario")
        {
            params.entry("flow").or_insert(target);
        }
    });
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_future_versions() {
        let err =
            parse_flow(r#"{"schemaVersion": 99, "id": "scn_x", "name": "x"}"#).expect_err("future");
        assert_eq!(err.code(), "UNSUPPORTED_SCHEMA_VERSION");
    }

    #[test]
    fn defaults_missing_version() {
        let s = parse_flow(r#"{"id": "scn_x", "name": "x"}"#).expect("parse");
        assert_eq!(s.schema_version, SCHEMA_VERSION);
    }

    #[test]
    fn reads_version_1_files() {
        let s = parse_flow(
            r#"{"schemaVersion": 1, "id": "scn_x", "name": "x",
                "steps": [{"id": "a", "type": "log.message", "params": {"message": "hi"}}]}"#,
        )
        .expect("parse");
        assert_eq!(s.schema_version, SCHEMA_VERSION);
        assert!(s.requires.is_empty());
        assert_eq!(s.steps.len(), 1);
    }

    #[test]
    fn renames_scenario_calls_to_flow_calls() {
        let s = parse_flow(
            r#"{"schemaVersion": 3, "id": "scn_x", "name": "x",
                "steps": [{"id": "a", "type": "control.if", "params": {"condition": "true"},
                  "blocks": {"then": [{"id": "b", "type": "scenario.call",
                    "params": {"scenario": "scn_child", "inputs": {"n": "1"}}}]}}]}"#,
        )
        .expect("parse");
        let inner = &s.steps[0].blocks["then"][0];
        assert_eq!(inner.step_type, "flow.call");
        assert_eq!(inner.params.get("flow"), Some(&json!("scn_child")));
        assert!(!inner.params.contains_key("scenario"));
        assert_eq!(inner.params.get("inputs"), Some(&json!({"n": "1"})));
    }

    #[test]
    fn migrations_form_an_unbroken_chain() {
        for (i, m) in MIGRATIONS.iter().enumerate() {
            assert_eq!(
                m.from,
                u32::try_from(i).unwrap() + 1,
                "gap before {}",
                m.from
            );
        }
        assert_eq!(
            MIGRATIONS.last().map_or(1, |m| m.from + 1),
            SCHEMA_VERSION,
            "SCHEMA_VERSION was bumped without a migration"
        );
    }

    #[test]
    fn for_each_step_reaches_nested_steps() {
        let mut doc = json!({
            "steps": [
                {"type": "control.if", "blocks": {"then": [{"type": "log.message"}], "else": []}},
                {"type": "log.message"}
            ]
        });
        let mut seen = Vec::new();
        for_each_step(&mut doc, &mut |step| {
            seen.push(step["type"].as_str().unwrap_or_default().to_owned());
            step.insert("touched".into(), Value::Bool(true));
        });
        assert_eq!(seen, ["control.if", "log.message", "log.message"]);
        assert_eq!(doc["steps"][0]["blocks"]["then"][0]["touched"], true);
    }
}

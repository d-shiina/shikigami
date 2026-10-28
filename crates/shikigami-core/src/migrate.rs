//! Scenario format versioning.
//!
//! Documents are read as raw JSON first, upgraded step by step to
//! [`SCHEMA_VERSION`], and only then deserialized. Newer documents than this
//! build understands are rejected instead of being silently truncated.

use serde_json::Value;

use crate::error::{CoreError, CoreResult};
use crate::model::{SCHEMA_VERSION, Scenario};

/// Parses scenario JSON text, applying migrations when needed.
pub fn parse_scenario(text: &str) -> CoreResult<Scenario> {
    let value: Value = serde_json::from_str(text)?;
    from_value(value)
}

pub fn from_value(mut value: Value) -> CoreResult<Scenario> {
    let found = value
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .and_then(|v| u32::try_from(v).ok())
        .unwrap_or(SCHEMA_VERSION);
    if found > SCHEMA_VERSION {
        return Err(CoreError::UnsupportedSchemaVersion {
            found,
            supported: SCHEMA_VERSION,
        });
    }
    // Future: `if found < 2 { value = v1_to_v2(value) }` etc.
    if let Some(obj) = value.as_object_mut() {
        obj.insert("schemaVersion".into(), Value::from(SCHEMA_VERSION));
    }
    Ok(serde_json::from_value(value)?)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn rejects_future_versions() {
        let err = parse_scenario(r#"{"schemaVersion": 99, "id": "scn_x", "name": "x"}"#)
            .expect_err("future");
        assert_eq!(err.code(), "UNSUPPORTED_SCHEMA_VERSION");
    }

    #[test]
    fn defaults_missing_version() {
        let s = parse_scenario(r#"{"id": "scn_x", "name": "x"}"#).expect("parse");
        assert_eq!(s.schema_version, SCHEMA_VERSION);
    }
}

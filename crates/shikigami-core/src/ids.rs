//! Stable identifiers for scenarios, steps and runs.
//!
//! IDs are prefixed UUIDv7 strings (`scn_…`, `stp_…`, `run_…`, `obs_…`). The prefix makes
//! them self-describing for AI clients and logs; UUIDv7 keeps them sortable by
//! creation time. Parsing is lenient (any non-empty string without whitespace or
//! path separators is accepted) so hand-written or imported scenarios still load.

use std::fmt;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

macro_rules! define_id {
    ($(#[$meta:meta])* $name:ident, $prefix:literal) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Default, Serialize, Deserialize, JsonSchema)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub const PREFIX: &'static str = $prefix;

            /// Generates a new unique ID.
            pub fn generate() -> Self {
                Self(format!("{}_{}", $prefix, uuid::Uuid::now_v7().simple()))
            }

            /// Wraps an existing string without validation.
            pub fn new(value: impl Into<String>) -> Self {
                Self(value.into())
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            pub fn is_empty(&self) -> bool {
                self.0.is_empty()
            }

            /// Returns true when the ID is safe to use as a file name and in logs.
            pub fn is_well_formed(&self) -> bool {
                is_well_formed(&self.0)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self(value.to_owned())
            }
        }

        impl From<String> for $name {
            fn from(value: String) -> Self {
                Self(value)
            }
        }
    };
}

define_id!(
    /// Identifier of a scenario. Also used as its file name in the store.
    ScenarioId,
    "scn"
);
define_id!(
    /// Identifier of a step. Unique within a scenario and stable across edits.
    StepId,
    "stp"
);
define_id!(
    /// Identifier of a single scenario execution.
    RunId,
    "run"
);
define_id!(
    /// Identifier of a screen an AI looked at (review evidence).
    ObservationId,
    "obs"
);

fn is_well_formed(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn generated_ids_are_prefixed_and_unique() {
        let a = StepId::generate();
        let b = StepId::generate();
        assert!(a.as_str().starts_with("stp_"));
        assert_ne!(a, b);
        assert!(a.is_well_formed());
    }

    #[test]
    fn path_like_ids_are_rejected() {
        assert!(!ScenarioId::new("../etc/passwd").is_well_formed());
        assert!(!ScenarioId::new("").is_well_formed());
        assert!(!ScenarioId::new("a b").is_well_formed());
        assert!(ScenarioId::new("scn_login-flow").is_well_formed());
    }
}

//! Adapters: what it takes to let scenarios operate one more application.
//!
//! An adapter bundles the step types for one target (`browser.*`,
//! `excel.*`, ...) with their handlers and any per-run cleanup. Step types
//! of an adapter are named `<adapter name>.<action>`. Everything else is
//! derived from the step type definitions: validation and fix hints, the
//! step list and examples AI clients read over MCP, Studio's property forms
//! and automatic locking (`StepTypeDef.resources`).
//!
//! Adapters that use a library from another language run it as a
//! [`crate::sidecar::SidecarClient`] child process.

use serde_json::Value;

use crate::RuntimeBuilder;
use crate::handler::{BoxFuture, StepError};

pub trait Adapter: Send + Sync + 'static {
    /// Prefix of this adapter's step types, e.g. `"browser"` for `browser.click`.
    fn name(&self) -> &'static str;

    /// Registers the step types and handlers (and run-finished hooks).
    fn install(&self, builder: RuntimeBuilder) -> RuntimeBuilder;

    /// Describes what the target application shows now, for AI clients
    /// choosing targets (e.g. a page's accessibility tree). `session` is the
    /// run ID whose state to look at.
    fn inspect<'a>(
        &'a self,
        _session: &'a str,
        _params: Value,
    ) -> BoxFuture<'a, Result<Value, StepError>> {
        let name = self.name();
        Box::pin(async move {
            Err(StepError::permanent(
                "NOT_SUPPORTED",
                format!("the {name} adapter cannot be inspected"),
            ))
        })
    }
}

impl std::fmt::Debug for dyn Adapter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Adapter({})", self.name())
    }
}

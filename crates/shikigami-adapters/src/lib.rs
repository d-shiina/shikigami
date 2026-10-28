//! Every application adapter Shikigami ships, in one place.
//!
//! The CLI, the MCP server and Studio all build their Runtime from
//! [`all`], so a new adapter (Excel, a business app, ...) is added here once
//! and appears everywhere: see docs/adapters.md.

use std::sync::Arc;

use shikigami_runtime::{Adapter, Runtime};

/// The adapters available in this build.
pub fn all() -> Vec<Arc<dyn Adapter>> {
    vec![
        Arc::new(shikigami_browser::BrowserAdapter::discover()),
        Arc::new(shikigami_desktop::DesktopAdapter::new()),
    ]
}

/// A Runtime with the built-in steps plus every adapter's steps.
pub fn runtime(adapters: &[Arc<dyn Adapter>]) -> Runtime {
    adapters
        .iter()
        .fold(Runtime::builder(), |builder, adapter| {
            builder.adapter(adapter.as_ref())
        })
        .build()
}

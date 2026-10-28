//! Every application adapter Shikigami ships, plus the installed plugins.
//!
//! The CLI, the MCP server and Studio all build their Runtime from
//! [`all`], so a new built-in adapter (Excel, ...) is added here once and
//! appears everywhere: see docs/adapters.md. Node plugins found on this PC
//! (docs/design/plugins.md) are appended after the built-ins.

use std::sync::Arc;

use shikigami_plugins::PluginProblem;
use shikigami_runtime::{Adapter, Runtime};

/// The adapters built into Shikigami.
pub fn builtin() -> Vec<Arc<dyn Adapter>> {
    let mut adapters: Vec<Arc<dyn Adapter>> = vec![
        Arc::new(shikigami_browser::BrowserAdapter::discover()),
        Arc::new(shikigami_desktop::DesktopAdapter::new()),
        Arc::new(shikigami_files::FileAdapter::new()),
        Arc::new(shikigami_excel::ExcelAdapter::new()),
    ];
    adapters.extend(shikigami_system::adapters());
    adapters
}

/// Built-in adapters and installed plugins, with the plugins that could not
/// be loaded.
pub struct Loaded {
    pub adapters: Vec<Arc<dyn Adapter>>,
    pub plugins: Vec<serde_json::Value>,
    pub problems: Vec<PluginProblem>,
}

/// Built-in adapters plus the plugins in [`shikigami_plugins::default_dirs`].
pub fn load() -> Loaded {
    let mut adapters = builtin();
    let taken: Vec<String> = adapters.iter().map(|a| a.name().to_owned()).collect();
    let taken: Vec<&str> = taken.iter().map(String::as_str).collect();
    let found = shikigami_plugins::discover(&shikigami_plugins::default_dirs(), &taken);
    let plugins = found.plugins.iter().map(|p| p.summary()).collect();
    adapters.extend(
        found
            .plugins
            .into_iter()
            .map(|p| Arc::new(p) as Arc<dyn Adapter>),
    );
    Loaded {
        adapters,
        plugins,
        problems: found.problems,
    }
}

/// The adapters available in this build and on this PC.
pub fn all() -> Vec<Arc<dyn Adapter>> {
    load().adapters
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

//! Every application adapter SpellSheet ships, plus the installed plugins.
//!
//! The CLI, the MCP server and Studio all build their Runtime from
//! [`all`], so a new built-in adapter (Excel, ...) is added here once and
//! appears everywhere: see docs/adapters.md. Node plugins found on this PC
//! (docs/design/plugins.md) are appended after the built-ins.

use std::sync::Arc;

pub mod preview;

use spellsheet_plugins::PluginProblem;
use spellsheet_runtime::{Adapter, Runtime};

/// The adapters built into SpellSheet.
pub fn builtin() -> Vec<Arc<dyn Adapter>> {
    let mut adapters: Vec<Arc<dyn Adapter>> = vec![
        Arc::new(spellsheet_browser::BrowserAdapter::discover()),
        Arc::new(spellsheet_desktop::DesktopAdapter::new()),
        Arc::new(spellsheet_files::FileAdapter::new()),
        Arc::new(spellsheet_excel::ExcelAdapter::new()),
        Arc::new(spellsheet_pdf::PdfAdapter::new()),
        Arc::new(spellsheet_word::WordAdapter::new()),
        Arc::new(spellsheet_mail::MailAdapter::new()),
        Arc::new(spellsheet_db::DbAdapter::new()),
    ];
    adapters.extend(spellsheet_system::adapters());
    adapters
}

/// Built-in adapters and installed plugins, with the plugins that could not
/// be loaded.
pub struct Loaded {
    pub adapters: Vec<Arc<dyn Adapter>>,
    pub plugins: Vec<serde_json::Value>,
    pub problems: Vec<PluginProblem>,
}

/// Built-in adapters plus the plugins in [`spellsheet_plugins::default_dirs`].
pub fn load() -> Loaded {
    let mut adapters = builtin();
    let taken: Vec<String> = adapters.iter().map(|a| a.name().to_owned()).collect();
    let taken: Vec<&str> = taken.iter().map(String::as_str).collect();
    let found = spellsheet_plugins::discover(&spellsheet_plugins::default_dirs(), &taken);
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

/// A Runtime with the built-in steps plus every adapter's steps. The mouse
/// and keyboard (`desktop.input`) are shared with every other SpellSheet
/// process of this Windows user (Studio, the MCP server, the CLI).
pub fn runtime(adapters: &[Arc<dyn Adapter>]) -> Runtime {
    adapters
        .iter()
        .fold(Runtime::builder(), |builder, adapter| {
            builder.adapter(adapter.as_ref())
        })
        .build()
        .with_pc_locks(spellsheet_runtime::default_pc_lock_dir())
}

/// The columns a table-reading node will give, read from its file now, so
/// the columns can be offered before the flow has run. The adapter that
/// owns the step type answers ([`Adapter::table_columns`]), so a plugin or
/// a new built-in adapter needs no change here. A relative `path` is read
/// from `folder` (the flow's folder). None when the node reads no table or
/// the file cannot be read yet.
pub fn table_columns(
    adapters: &[Arc<dyn Adapter>],
    step_type: &str,
    params: &serde_json::Value,
    folder: &std::path::Path,
) -> Option<Vec<String>> {
    let (prefix, _) = step_type.split_once('.')?;
    let adapter = adapters.iter().find(|a| a.name() == prefix)?;
    let mut params = params.clone();
    if let Some(path) = params.get("path").and_then(serde_json::Value::as_str) {
        if path.contains("{{") {
            return None;
        }
        params["path"] = folder.join(path).to_string_lossy().into_owned().into();
    }
    adapter.table_columns(step_type, &params)
}

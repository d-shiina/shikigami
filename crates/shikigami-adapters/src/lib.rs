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
        Arc::new(shikigami_pdf::PdfAdapter::new()),
        Arc::new(shikigami_word::WordAdapter::new()),
        Arc::new(shikigami_mail::MailAdapter::new()),
        Arc::new(shikigami_db::DbAdapter::new()),
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

/// A Runtime with the built-in steps plus every adapter's steps. The mouse
/// and keyboard (`desktop.input`) are shared with every other Shikigami
/// process of this Windows user (Studio, the MCP server, the CLI).
pub fn runtime(adapters: &[Arc<dyn Adapter>]) -> Runtime {
    adapters
        .iter()
        .fold(Runtime::builder(), |builder, adapter| {
            builder.adapter(adapter.as_ref())
        })
        .build()
        .with_pc_locks(shikigami_runtime::default_pc_lock_dir())
}

/// The columns a table-reading node (`excel.readRows`, `file.readCsv`) will
/// give, read from its file now, so the columns can be offered before the
/// flow has run. A relative path is read from `folder` (the flow's folder).
/// None when the node reads no table or the file cannot be read yet.
pub fn table_columns(
    step_type: &str,
    params: &serde_json::Value,
    folder: &std::path::Path,
) -> Option<Vec<String>> {
    let path = params.get("path")?.as_str()?;
    if path.contains("{{") {
        return None;
    }
    let mut params = params.clone();
    params["path"] = folder.join(path).to_string_lossy().into_owned().into();
    match step_type {
        shikigami_excel::types::READ_ROWS => shikigami_excel::read_rows_columns(&params).ok(),
        shikigami_files::types::READ_CSV => shikigami_files::read_csv_columns(&params).ok(),
        _ => None,
    }
}

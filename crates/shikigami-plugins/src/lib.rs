//! Node plugins: step types provided by programs outside Shikigami.
//!
//! A plugin is a folder with a `shikigami-plugin.json` manifest and a
//! program the Runtime starts as a child process and speaks newline JSON-RPC
//! with ([`shikigami_runtime::sidecar`], like the browser adapter). The
//! manifest declares the step types; each one becomes a regular
//! [`StepTypeDef`], so validation, `list_step_types` / `get_step_schema`,
//! Studio's forms, locking, timeouts, retries and secret masking work as for
//! built-in steps. A crashing plugin fails its step, never the Runtime.
//! See docs/design/plugins.md.

// StepError is the Runtime's handler error type; boxing it here would only
// move the allocation.
#![allow(clippy::result_large_err)]

pub mod manifest;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Map, Value, json};
use shikigami_core::registry::StepTypeDef;
use shikigami_runtime::sidecar::{SidecarClient, SidecarConfig};
use shikigami_runtime::{
    ActionHandler, ActionInput, Adapter, BoxFuture, RuntimeBuilder, StepError,
};
use tokio_util::sync::CancellationToken;

pub use manifest::{MANIFEST_FILE, Manifest, RESERVED_NAMES};

/// How much earlier than the step timeout the plugin is asked to stop.
const TIMEOUT_MARGIN_MS: u64 = 500;

/// How long a run's end waits for a plugin to answer `closeRun`.
const CLOSE_RUN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Secret sites a plugin is written as: `plugin:kintone`.
pub const PLUGIN_SITE_PREFIX: &str = "plugin:";

/// A loaded plugin: its manifest, step types and process.
pub struct Plugin {
    manifest: Manifest,
    dir: PathBuf,
    defs: Vec<StepTypeDef>,
    client: Arc<SidecarClient>,
}

impl std::fmt::Debug for Plugin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Plugin")
            .field("name", &self.manifest.name)
            .field("dir", &self.dir)
            .finish_non_exhaustive()
    }
}

/// A plugin folder that could not be loaded, and why.
#[derive(Debug, Clone, PartialEq)]
pub struct PluginProblem {
    pub dir: PathBuf,
    pub problems: Vec<String>,
}

impl PluginProblem {
    pub fn to_json(&self) -> Value {
        json!({ "dir": self.dir.display().to_string(), "problems": self.problems })
    }
}

/// What [`discover`] found.
#[derive(Debug, Default)]
pub struct Discovery {
    pub plugins: Vec<Plugin>,
    pub problems: Vec<PluginProblem>,
}

impl Plugin {
    /// Loads the plugin in `dir`. `taken` are adapter names already in use.
    pub fn load(dir: &Path, taken: &[&str]) -> Result<Self, PluginProblem> {
        // The process starts in `dir`, so a relative program path must not
        // be resolved against it a second time.
        let dir = &std::path::absolute(dir).unwrap_or_else(|_| dir.to_path_buf());
        let problem = |problems: Vec<String>| PluginProblem {
            dir: dir.to_path_buf(),
            problems,
        };
        let path = dir.join(MANIFEST_FILE);
        let text = std::fs::read_to_string(&path)
            .map_err(|e| problem(vec![format!("{}: {e}", path.display())]))?;
        let manifest = Manifest::parse(&text).map_err(problem)?;
        if taken.contains(&manifest.name.as_str()) {
            return Err(problem(vec![format!(
                "name: '{}' is already used by another adapter or plugin (rename one of them)",
                manifest.name
            )]));
        }
        let defs = manifest.step_defs().map_err(problem)?;
        let program = if manifest.command.program.contains(['/', '\\']) {
            dir.join(&manifest.command.program)
        } else {
            PathBuf::from(&manifest.command.program)
        };
        let client = Arc::new(SidecarClient::new(SidecarConfig {
            name: manifest.name.clone(),
            program,
            args: manifest.command.args.iter().map(Into::into).collect(),
            cwd: Some(dir.to_path_buf()),
            unavailable: None,
            setup_hint: format!(
                "Check that `{}` can be started (installed, on PATH) and that the plugin folder {} is complete; `shikigami plugin check` tests the manifest.",
                manifest.command.program,
                dir.display()
            ),
        }));
        Ok(Self {
            manifest,
            dir: dir.to_path_buf(),
            defs,
            client,
        })
    }

    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn step_defs(&self) -> &[StepTypeDef] {
        &self.defs
    }

    /// Name, version, folder and step types, for `shikigami plugin list`.
    pub fn summary(&self) -> Value {
        json!({
            "name": self.manifest.name,
            "version": self.manifest.version,
            "label": self.manifest.label,
            "dir": self.dir.display().to_string(),
            "steps": self.defs.iter().map(|d| d.step_type.as_str()).collect::<Vec<_>>(),
        })
    }
}

/// Where plugins are looked for: each folder in `SHIKIGAMI_PLUGINS`, then
/// `%LOCALAPPDATA%\Shikigami\plugins`. Never the workspace: a shared
/// workspace must not start programs on everyone's PC.
pub fn default_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("SHIKIGAMI_PLUGINS")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    if let Some(local) = dirs::data_local_dir() {
        dirs.push(local.join("Shikigami").join("plugins"));
    }
    dirs
}

/// Loads every plugin in `roots`. A root is a plugin folder itself or a
/// folder of plugin folders; missing roots are skipped. Plugins whose name
/// is in `taken` or was loaded before are reported, not loaded.
pub fn discover(roots: &[PathBuf], taken: &[&str]) -> Discovery {
    let mut found = Discovery::default();
    let mut names: Vec<String> = taken.iter().map(|s| (*s).to_owned()).collect();
    for dir in roots.iter().flat_map(|root| plugin_dirs(root)) {
        let taken: Vec<&str> = names.iter().map(String::as_str).collect();
        match Plugin::load(&dir, &taken) {
            Ok(plugin) => {
                names.push(plugin.manifest.name.clone());
                found.plugins.push(plugin);
            }
            Err(problem) => {
                tracing::warn!(dir = %problem.dir.display(), problems = ?problem.problems, "plugin not loaded");
                found.problems.push(problem);
            }
        }
    }
    found
}

fn plugin_dirs(root: &Path) -> Vec<PathBuf> {
    if root.join(MANIFEST_FILE).is_file() {
        return vec![root.to_path_buf()];
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return vec![];
    };
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.join(MANIFEST_FILE).is_file())
        .collect();
    dirs.sort();
    dirs
}

impl Adapter for Plugin {
    fn name(&self) -> &str {
        &self.manifest.name
    }

    fn install(&self, mut builder: RuntimeBuilder) -> RuntimeBuilder {
        let name = self.manifest.name.as_str();
        for def in &self.defs {
            let action = def
                .step_type
                .strip_prefix(&format!("{name}."))
                .unwrap_or(&def.step_type)
                .to_owned();
            builder = builder.register(
                def.clone(),
                PluginStep {
                    client: self.client.clone(),
                    plugin: name.to_owned(),
                    action,
                    secret_params: def.secret_params.clone(),
                },
            );
        }
        let client = self.client.clone();
        builder.on_run_finished(Arc::new(move |end| {
            let client = client.clone();
            Box::pin(async move {
                if client.is_running().await {
                    // A plugin that never answers must not hold the run open.
                    let cancel = CancellationToken::new();
                    let call =
                        client.call("closeRun", json!({ "runId": end.run_id.as_str() }), &cancel);
                    if tokio::time::timeout(CLOSE_RUN_TIMEOUT, call).await.is_err() {
                        tracing::warn!("a plugin did not answer closeRun");
                    }
                }
            })
        }))
    }

    fn inspect<'a>(
        &'a self,
        session: &'a str,
        params: Value,
    ) -> BoxFuture<'a, Result<Value, StepError>> {
        Box::pin(async move {
            if !self.manifest.inspect {
                return Err(StepError::permanent(
                    "NOT_SUPPORTED",
                    format!("the {} plugin cannot be inspected", self.manifest.name),
                ));
            }
            let mut params = match params {
                Value::Object(map) => map,
                _ => Map::new(),
            };
            params.insert("runId".into(), Value::String(session.to_owned()));
            self.client
                .call("inspect", Value::Object(params), &CancellationToken::new())
                .await
        })
    }
}

struct PluginStep {
    client: Arc<SidecarClient>,
    plugin: String,
    action: String,
    secret_params: Vec<String>,
}

impl ActionHandler for PluginStep {
    fn execute<'a>(&'a self, input: ActionInput) -> BoxFuture<'a, Result<Value, StepError>> {
        Box::pin(async move {
            let mut params = match input.params.clone() {
                Value::Object(map) => map,
                _ => Map::new(),
            };
            for key in &self.secret_params {
                if let Some(value) = params.get(key).cloned()
                    && let Some(text) = self.secret_text(&input, &value)?
                {
                    params.insert(key.clone(), Value::String(text));
                }
            }
            params.insert("runId".into(), Value::String(input.run_id.to_string()));
            let limit = input.timeout_ms.saturating_sub(TIMEOUT_MARGIN_MS).max(1);
            params.insert("timeoutMs".into(), Value::from(limit));
            self.client
                .call(&self.action, Value::Object(params), &input.cancel)
                .await
        })
    }
}

impl PluginStep {
    /// The value of a secret reference, when the secret lists this plugin
    /// (`plugin:<name>`) among the places it may be used.
    fn secret_text(&self, input: &ActionInput, value: &Value) -> Result<Option<String>, StepError> {
        let Some(secret) = input.resolve_secret(value)? else {
            return Ok(None);
        };
        let site = format!("{PLUGIN_SITE_PREFIX}{}", self.plugin);
        if !secret.sites.iter().any(|s| s.eq_ignore_ascii_case(&site)) {
            return Err(StepError::permanent(
                "SECRET_PLUGIN_NOT_ALLOWED",
                format!("secret '{}' may not be passed to the {} plugin", secret.name, self.plugin),
            )
            .with_details(json!({
                "hint": format!("Ask the user to add {site} to this secret's sites in Studio (シークレット) if this plugin may use it.")
            })));
        }
        // Masked in the plugin's own diagnostics too.
        self.client.mask(&secret.value);
        Ok(Some(secret.value))
    }
}

#[cfg(test)]
mod tests;

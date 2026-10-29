//! `shikigami-plugin.json`: what a plugin declares, and the checks that
//! turn it into step type definitions (docs/design/plugins.md §3).

use std::collections::BTreeSet;

use serde::Deserialize;
use serde_json::{Value, json};
use shikigami_core::registry::{
    Deprecation, PluginInfo, RiskLevel, StepCategory, StepRegistry, StepTypeDef,
};
use shikigami_core::resource::{DESKTOP_INPUT, ResourceDef};
use shikigami_core::secret::text_or_secret_schema;
use shikigami_core::{Scenario, Step, Validator};

/// File name of the manifest inside a plugin folder.
pub const MANIFEST_FILE: &str = "shikigami-plugin.json";

/// The manifest format this build reads.
pub const MANIFEST_VERSION: u32 = 1;

/// Prefixes plugins cannot take: built-in steps, shipped adapters and
/// adapters planned for the core.
pub const RESERVED_NAMES: &[&str] = &[
    "control",
    "variable",
    "log",
    "flow",
    "scenario",
    "wait",
    "browser",
    "desktop",
    "excel",
    "word",
    "outlook",
    "office",
    "file",
    "http",
    "process",
    "clipboard",
    "dialog",
    "mail",
    "pdf",
    "sap",
    "shikigami",
];

/// Methods the Runtime calls on every plugin besides its actions.
const RESERVED_ACTIONS: &[&str] = &["closeRun", "inspect", "shutdown"];

/// Keys the Runtime adds to every call's params.
const RESERVED_PARAMS: &[&str] = &["runId", "timeoutMs"];

const MAX_NAME_LEN: usize = 32;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub manifest_version: u32,
    pub name: String,
    pub version: String,
    pub label: String,
    #[serde(default)]
    pub description: String,
    pub command: CommandManifest,
    /// Whether the plugin answers `inspect` (what the application shows now).
    #[serde(default)]
    pub inspect: bool,
    pub steps: Vec<StepManifest>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandManifest {
    /// Relative to the plugin folder when it contains a path separator,
    /// otherwise looked up on PATH (`node`, `python`, ...). `node` is the
    /// Node.js shipped with Shikigami when there is one.
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StepManifest {
    pub action: String,
    pub label: String,
    pub description: String,
    pub params: Value,
    #[serde(default)]
    pub has_output: bool,
    #[serde(default = "interactive")]
    pub risk: RiskLevel,
    pub examples: Vec<Value>,
    #[serde(default)]
    pub secret_params: Vec<String>,
    #[serde(default)]
    pub resources: Vec<ResourceManifest>,
    #[serde(default)]
    pub default_timeout_ms: Option<u64>,
    /// Marks the step as one to stop using (it keeps working).
    #[serde(default)]
    pub deprecated: Option<Deprecation>,
}

fn interactive() -> RiskLevel {
    RiskLevel::Interactive
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ResourceManifest {
    /// The file a param names.
    File { param: String },
    /// The window of a desktop target param.
    Window { param: String },
    /// The mouse and keyboard (shared with `desktop.*`).
    DesktopInput,
    /// The whole plugin: one step at a time.
    Plugin,
}

fn is_name(s: &str) -> bool {
    let mut chars = s.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && s.len() <= MAX_NAME_LEN
}

fn is_action(s: &str) -> bool {
    let mut chars = s.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_alphanumeric())
        && s.len() <= 64
}

/// Collects manifest problems as "where: what (how to fix)" lines.
#[derive(Default)]
struct Problems(Vec<String>);

impl Problems {
    fn add(&mut self, at: &str, message: impl std::fmt::Display, hint: &str) {
        self.0.push(format!("{at}: {message} ({hint})"));
    }
}

impl Manifest {
    pub fn parse(text: &str) -> Result<Self, Vec<String>> {
        serde_json::from_str(text).map_err(|e| {
            vec![format!(
                "{MANIFEST_FILE}: {e} (see docs/design/plugins.md for the fields)"
            )]
        })
    }

    /// Checks the manifest and returns the step type definitions it
    /// declares, or every problem found.
    pub fn step_defs(&self) -> Result<Vec<StepTypeDef>, Vec<String>> {
        let mut p = Problems::default();
        if self.manifest_version != MANIFEST_VERSION {
            p.add(
                "manifestVersion",
                format!("version {} is not supported", self.manifest_version),
                "write 1",
            );
        }
        if !is_name(&self.name) {
            p.add(
                "name",
                format!("'{}' is not a plugin name", self.name),
                "use lowercase letters and digits, starting with a letter, up to 32 characters, e.g. kintone",
            );
        } else if RESERVED_NAMES.contains(&self.name.as_str()) {
            p.add(
                "name",
                format!("'{}' is reserved for built-in steps", self.name),
                "choose a name of your own, e.g. the system's name",
            );
        }
        if let Err(e) = semver::Version::parse(&self.version) {
            p.add(
                "version",
                format!("'{}' is not a semver version ({e})", self.version),
                "write major.minor.patch, e.g. 0.1.0; raise major when params change incompatibly",
            );
        }
        if self.label.trim().is_empty() {
            p.add("label", "is empty", "write the name people see in Studio");
        }
        if self.command.program.trim().is_empty() {
            p.add(
                "command.program",
                "is empty",
                "write the program to start, e.g. node",
            );
        }
        if self.steps.is_empty() {
            p.add("steps", "no steps", "declare at least one step");
        }

        let mut seen = BTreeSet::new();
        let mut defs = Vec::new();
        for (i, step) in self.steps.iter().enumerate() {
            let at = format!("steps/{i}");
            if !is_action(&step.action) {
                p.add(
                    &format!("{at}/action"),
                    format!("'{}' is not an action name", step.action),
                    "use camelCase letters and digits, e.g. getRecord",
                );
            } else if RESERVED_ACTIONS.contains(&step.action.as_str()) {
                p.add(
                    &format!("{at}/action"),
                    format!("'{}' is used by the Runtime", step.action),
                    "choose another action name",
                );
            } else if !seen.insert(step.action.as_str()) {
                p.add(
                    &format!("{at}/action"),
                    format!("'{}' is declared twice", step.action),
                    "give every step its own action",
                );
            }
            if let Some(def) = self.step_def(step, &at, &mut p) {
                defs.push(def);
            }
        }
        if !p.0.is_empty() {
            return Err(p.0);
        }

        // Examples must pass the same validation scenarios get, so AI
        // clients can copy them as they are.
        let mut registry = StepRegistry::with_builtins();
        for def in &defs {
            registry.register(def.clone());
        }
        let validator = Validator::new(registry);
        for (i, def) in defs.iter().enumerate() {
            if def.examples.is_empty() {
                p.add(
                    &format!("steps/{i}/examples"),
                    "no examples",
                    "add at least one complete step, e.g. { \"type\": \"<name>.<action>\", \"params\": { … } }",
                );
            }
            for (j, example) in def.examples.iter().enumerate() {
                let at = format!("steps/{i}/examples/{j}");
                let mut step: Step = match serde_json::from_value(example.clone()) {
                    Ok(step) => step,
                    Err(e) => {
                        p.add(
                            &at,
                            e,
                            "write a step object: { \"type\", \"params\", \"saveAs\"? }",
                        );
                        continue;
                    }
                };
                if step.step_type != def.step_type {
                    p.add(
                        &at,
                        format!("type '{}' is not this step", step.step_type),
                        &format!("write \"type\": \"{}\"", def.step_type),
                    );
                    continue;
                }
                shikigami_core::ops::assign_missing_ids(&mut step);
                let mut scenario = Scenario::new("example");
                scenario.steps = vec![step];
                for issue in validator.validate(&scenario).errors() {
                    p.add(
                        &at,
                        format!("{} {}", issue.code, issue.message),
                        issue.hint.as_deref().unwrap_or("fix the example"),
                    );
                }
            }
        }
        if p.0.is_empty() { Ok(defs) } else { Err(p.0) }
    }

    fn step_def(&self, step: &StepManifest, at: &str, p: &mut Problems) -> Option<StepTypeDef> {
        let mut schema = step.params.clone();
        let Some(map) = schema.as_object_mut() else {
            p.add(
                &format!("{at}/params"),
                "is not an object",
                "write a JSON Schema with \"type\": \"object\"",
            );
            return None;
        };
        if map.get("type") != Some(&json!("object")) {
            p.add(
                &format!("{at}/params"),
                "must have \"type\": \"object\"",
                "params are always an object",
            );
        }
        let properties = map
            .get("properties")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        for key in RESERVED_PARAMS {
            if properties.contains_key(*key) {
                p.add(
                    &format!("{at}/params/properties/{key}"),
                    "is added by the Runtime",
                    "rename the param; every call already gets runId and timeoutMs",
                );
            }
        }
        let mut secret_properties = properties.clone();
        for key in &step.secret_params {
            match properties.get(key) {
                Some(property) => {
                    let description = property
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("text, or a registered secret { \"secret\": \"<name>\", \"field\": \"password\" }");
                    secret_properties.insert(key.clone(), text_or_secret_schema(description));
                }
                None => p.add(
                    &format!("{at}/secretParams"),
                    format!("'{key}' is not a param"),
                    "list params declared in params.properties",
                ),
            }
        }
        if !step.secret_params.is_empty() {
            map.insert("properties".into(), Value::Object(secret_properties));
        }
        if let Err(e) = jsonschema::validator_for(&schema) {
            p.add(
                &format!("{at}/params"),
                format!("invalid JSON Schema: {e}"),
                "fix the schema",
            );
        }

        let mut resources = Vec::new();
        for (i, resource) in step.resources.iter().enumerate() {
            let param = match resource {
                ResourceManifest::File { param } | ResourceManifest::Window { param } => {
                    Some(param)
                }
                _ => None,
            };
            if let Some(param) = param
                && !properties.contains_key(param)
            {
                p.add(
                    &format!("{at}/resources/{i}/param"),
                    format!("'{param}' is not a param"),
                    "name a param declared in params.properties",
                );
            }
            resources.push(match resource {
                ResourceManifest::File { param } => ResourceDef::file(param),
                ResourceManifest::Window { param } => ResourceDef::window(param),
                ResourceManifest::DesktopInput => ResourceDef::Static(DESKTOP_INPUT.into()),
                ResourceManifest::Plugin => ResourceDef::Static(format!("plugin:{}", self.name)),
            });
        }
        if step.label.trim().is_empty() || step.description.trim().is_empty() {
            p.add(
                at,
                "label or description is empty",
                "describe the step for people (label) and AI clients (description)",
            );
        }

        Some(StepTypeDef {
            step_type: format!("{}.{}", self.name, step.action),
            category: StepCategory::Other,
            label: step.label.clone(),
            description: step.description.clone(),
            params_schema: schema,
            blocks: vec![],
            has_output: step.has_output,
            expression_params: vec![],
            binds_variables: vec![],
            risk: step.risk,
            examples: step.examples.clone(),
            resources,
            secret_params: step.secret_params.clone(),
            default_timeout_ms: step.default_timeout_ms,
            deprecated: step.deprecated.clone(),
            plugin: Some(PluginInfo {
                name: self.name.clone(),
                version: self.version.clone(),
            }),
            path_params: Vec::new(),
        })
    }
}

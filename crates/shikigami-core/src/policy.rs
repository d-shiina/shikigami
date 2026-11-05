//! Workspace policy (`policy.json`): what scenarios may reach and what an AI
//! may do without a person's approval.
//!
//! The file sits in the shared part of the workspace and only people change
//! it (Studio, the CLI, a text editor); no MCP tool writes it. Every
//! interface reads the same file and asks the same questions here, so a run
//! started from Studio, the CLI or an AI client is checked alike:
//!
//! - `sites` / `apps`: allow-lists for the steps that open a page, call a web
//!   API or start a program (the params a [`TargetDef`] names). The Runtime
//!   checks them on every step, after templates are rendered.
//! - `ai`: per AI action and step risk, `allow` / `ask` (a person approves in
//!   Studio first) / `deny`.
//! - `scenarios`: per-scenario overrides (may an AI run it, may it run
//!   unattended).
//!
//! A missing file means the defaults ([`Policy::default`]); an unreadable one
//! stops runs (`POLICY_INVALID`) rather than silently allowing everything.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{CoreError, CoreResult};
use crate::registry::RiskLevel;

pub const POLICY_FILE: &str = "policy.json";
pub const POLICY_FORMAT_VERSION: u32 = 1;

/// What happens when an AI asks for an action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Decision {
    Allow,
    /// A person approves (or refuses) the exact request in Studio first.
    Ask,
    Deny,
}

/// A decision for each step risk level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ByRisk {
    #[serde(default = "allow")]
    pub safe: Decision,
    #[serde(default = "allow")]
    pub interactive: Decision,
    #[serde(default = "ask")]
    pub dangerous: Decision,
}

impl Default for ByRisk {
    fn default() -> Self {
        Self {
            safe: Decision::Allow,
            interactive: Decision::Allow,
            dangerous: Decision::Ask,
        }
    }
}

impl ByRisk {
    pub fn get(&self, risk: RiskLevel) -> Decision {
        match risk {
            RiskLevel::Safe => self.safe,
            RiskLevel::Interactive => self.interactive,
            RiskLevel::Dangerous => self.dangerous,
        }
    }
}

fn allow() -> Decision {
    Decision::Allow
}

fn ask() -> Decision {
    Decision::Ask
}

/// What an AI client (MCP) may do. Studio and the CLI are people and are not
/// asked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiPolicy {
    /// `run_scenario`, by the riskiest step the run may execute (including
    /// the scenarios it calls).
    #[serde(default)]
    pub run_scenario: ByRisk,
    /// `test_step`, by the step's risk (a `scenario.call` counts as the
    /// riskiest step of the scenarios it calls).
    #[serde(default)]
    pub test_step: ByRisk,
    /// `delete_scenario` (moves to the trash).
    #[serde(default = "ask")]
    pub delete_scenario: Decision,
}

impl Default for AiPolicy {
    fn default() -> Self {
        Self {
            run_scenario: ByRisk::default(),
            test_step: ByRisk::default(),
            delete_scenario: Decision::Ask,
        }
    }
}

/// Settings for one scenario.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScenarioPolicy {
    /// Whether an AI may run or test this scenario. Overrides `ai.runScenario`
    /// (and `ai.testStep` for calls of it) when it is stricter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_run: Option<Decision>,
    /// `false`: `shikigami run` (scheduled, unattended) refuses it; it only
    /// runs from Studio. Default `true`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unattended: Option<bool>,
}

/// `policy.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    #[serde(default = "format_version")]
    pub format_version: u32,
    /// Sites `browser.open`, `http.request` (and plugin steps that declare a
    /// site param) may reach: origins such as `https://order.example.co.jp`,
    /// or `https://*.example.co.jp` for every subdomain. Empty: any site.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sites: Vec<String>,
    /// Programs `desktop.launch` and `process.run` may start: a full path
    /// (`C:\Program Files\Billing\billing.exe`) or a file name that matches
    /// in any folder (`notepad.exe`). Empty: any program.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub apps: Vec<String>,
    #[serde(default)]
    pub ai: AiPolicy,
    /// Per-scenario settings, keyed by scenario ID.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub scenarios: BTreeMap<String, ScenarioPolicy>,
}

fn format_version() -> u32 {
    POLICY_FORMAT_VERSION
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            format_version: POLICY_FORMAT_VERSION,
            sites: Vec::new(),
            apps: Vec::new(),
            ai: AiPolicy::default(),
            scenarios: BTreeMap::new(),
        }
    }
}

/// What kind of target a step param names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TargetKind {
    /// A URL, checked against `sites`.
    Site,
    /// A program (path or file name), checked against `apps`.
    App,
}

/// A step param that names something outside the run, checked against the
/// policy before the step executes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TargetDef {
    pub param: String,
    pub kind: TargetKind,
}

impl TargetDef {
    pub fn site(param: &str) -> Self {
        Self {
            param: param.into(),
            kind: TargetKind::Site,
        }
    }

    pub fn app(param: &str) -> Self {
        Self {
            param: param.into(),
            kind: TargetKind::App,
        }
    }
}

/// A target the policy refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    /// `SITE_NOT_ALLOWED` or `APP_NOT_ALLOWED`.
    pub code: &'static str,
    pub message: String,
    pub details: Value,
}

impl Policy {
    /// Where the policy of the workspace at `root` lives.
    pub fn path(root: &Path) -> PathBuf {
        root.join(POLICY_FILE)
    }

    /// Reads `policy.json`; a missing file is the default policy. A broken
    /// file is an error (`POLICY_INVALID`), never "allow everything".
    pub fn load(path: &Path) -> CoreResult<Self> {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(e.into()),
        };
        let invalid = |message: String| CoreError::Rejected {
            code: "POLICY_INVALID",
            message: format!("{}: {message}", path.display()),
            hint: Some(
                "Fix policy.json (see docs/policy.md) or check it with `shikigami policy check`."
                    .into(),
            ),
        };
        let policy: Self = serde_json::from_slice(&bytes).map_err(|e| invalid(e.to_string()))?;
        if policy.format_version > POLICY_FORMAT_VERSION {
            return Err(invalid(format!(
                "formatVersion {} is newer than this Shikigami understands ({POLICY_FORMAT_VERSION})",
                policy.format_version
            )));
        }
        let problems = policy.problems();
        if !problems.is_empty() {
            return Err(invalid(problems.join("; ")));
        }
        Ok(policy)
    }

    /// Writes `policy.json` (people only: Studio's settings, the CLI). A
    /// policy with problems is refused, so the file always loads.
    pub fn save(&self, path: &Path) -> CoreResult<()> {
        let problems = self.problems();
        if !problems.is_empty() {
            return Err(CoreError::Rejected {
                code: "POLICY_INVALID",
                message: problems.join("; "),
                hint: None,
            });
        }
        let mut json = serde_json::to_vec_pretty(self)?;
        json.push(b'\n');
        crate::store::write_atomic(path, &json)
    }

    /// Entries that can never match, e.g. a site that is not a web address.
    pub fn problems(&self) -> Vec<String> {
        let mut out = Vec::new();
        for site in &self.sites {
            if SitePattern::parse(site).is_none() {
                out.push(format!(
                    "sites: '{site}' is not an origin (write e.g. https://example.com or https://*.example.com)"
                ));
            }
        }
        for app in &self.apps {
            if app.trim().is_empty() {
                out.push("apps: empty entry".into());
            }
        }
        out
    }

    fn scenario(&self, id: &str) -> Option<&ScenarioPolicy> {
        self.scenarios.get(id)
    }

    /// May `shikigami run` start this scenario without a person?
    pub fn allows_unattended(&self, scenario_id: &str) -> bool {
        self.scenario(scenario_id)
            .and_then(|s| s.unattended)
            .unwrap_or(true)
    }

    /// The scenario's own `aiRun` setting combined with `by_risk`: the
    /// stricter of the two wins.
    fn with_scenario(&self, decision: Decision, scenario_ids: &[&str]) -> Decision {
        scenario_ids
            .iter()
            .filter_map(|id| self.scenario(id).and_then(|s| s.ai_run))
            .fold(decision, stricter)
    }

    /// Decision for an AI's `run_scenario`. `scenario_ids` are the scenario
    /// and every scenario it calls.
    pub fn ai_run(&self, risk: RiskLevel, scenario_ids: &[&str]) -> Decision {
        self.with_scenario(self.ai.run_scenario.get(risk), scenario_ids)
    }

    /// Decision for an AI's `test_step`. `scenario_ids` are the scenarios a
    /// tested `scenario.call` reaches.
    pub fn ai_test_step(&self, risk: RiskLevel, scenario_ids: &[&str]) -> Decision {
        self.with_scenario(self.ai.test_step.get(risk), scenario_ids)
    }

    pub fn ai_delete(&self) -> Decision {
        self.ai.delete_scenario
    }

    /// Checks one rendered param value against the allow-lists. Values that
    /// are not strings are left to validation.
    pub fn check_target(&self, def: &TargetDef, value: &Value) -> Result<(), Refusal> {
        let Some(text) = value.as_str() else {
            return Ok(());
        };
        match def.kind {
            TargetKind::Site => self.check_site(text),
            TargetKind::App => self.check_app(text),
        }
    }

    /// Checks every target param of a step (rendered params).
    pub fn check_targets(&self, defs: &[TargetDef], params: &Value) -> Result<(), Refusal> {
        for def in defs {
            if let Some(value) = params.get(&def.param) {
                self.check_target(def, value)?;
            }
        }
        Ok(())
    }

    pub fn check_site(&self, url: &str) -> Result<(), Refusal> {
        if self.sites.is_empty() || url.trim() == "about:blank" {
            return Ok(());
        }
        let origin = origin(url);
        let allowed = origin.as_ref().is_some_and(|(scheme, host, port)| {
            self.sites
                .iter()
                .filter_map(|s| SitePattern::parse(s))
                .any(|p| p.matches(scheme, host, port.as_deref()))
        });
        if allowed {
            return Ok(());
        }
        let shown = origin.map_or_else(
            || url.trim().to_owned(),
            |(scheme, host, port)| match port {
                Some(port) => format!("{scheme}://{host}:{port}"),
                None => format!("{scheme}://{host}"),
            },
        );
        Err(Refusal {
            code: "SITE_NOT_ALLOWED",
            message: format!("{shown} is not in the workspace's allowed sites"),
            details: serde_json::json!({
                "site": shown,
                "allowed": self.sites,
                "hint": "A person adds the site to \"sites\" in policy.json (Studio: 許可と承認). Do not work around it with another step.",
            }),
        })
    }

    pub fn check_app(&self, program: &str) -> Result<(), Refusal> {
        if self.apps.is_empty() {
            return Ok(());
        }
        let wanted = AppName::new(program);
        if self.apps.iter().any(|a| AppName::new(a).allows(&wanted)) {
            return Ok(());
        }
        Err(Refusal {
            code: "APP_NOT_ALLOWED",
            message: format!(
                "'{}' is not in the workspace's allowed apps",
                program.trim()
            ),
            details: serde_json::json!({
                "app": program.trim(),
                "allowed": self.apps,
                "hint": "A person adds the program to \"apps\" in policy.json (Studio: 許可と承認).",
            }),
        })
    }
}

fn rank(d: Decision) -> u8 {
    match d {
        Decision::Allow => 0,
        Decision::Ask => 1,
        Decision::Deny => 2,
    }
}

fn stricter(a: Decision, b: Decision) -> Decision {
    if rank(b) > rank(a) { b } else { a }
}

/// `(scheme, host, port)` of an http(s) URL, lowercased, default ports
/// dropped. Other schemes (`file:`, `data:`, ...) have no origin here.
fn origin(url: &str) -> Option<(String, String, Option<String>)> {
    let (scheme, rest) = url.trim().split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let authority = rest.split(['/', '?', '#', '\\']).next()?;
    let host_port = authority.rsplit('@').next()?.to_ascii_lowercase();
    let (host, port) = match host_port.rsplit_once(':') {
        // IPv6 literals keep their colons inside brackets.
        Some((host, port)) if !port.contains(']') => (host.to_owned(), Some(port.to_owned())),
        _ => (host_port, None),
    };
    let port = match (scheme.as_str(), port.as_deref()) {
        ("https", Some("443")) | ("http", Some("80")) => None,
        _ => port,
    };
    let host = host.trim_end_matches('.').to_owned();
    if host.is_empty() {
        return None;
    }
    Some((scheme, host, port))
}

/// One `sites` entry: `https://example.com`, `https://*.example.com`,
/// optionally with a port.
struct SitePattern {
    scheme: String,
    /// Host without the `*.`.
    host: String,
    any_subdomain: bool,
    port: Option<String>,
}

impl SitePattern {
    fn parse(text: &str) -> Option<Self> {
        let trimmed = text.trim();
        let (scheme, rest) = trimmed.split_once("://")?;
        let wildcard = rest.starts_with("*.");
        let without = if wildcard { &rest[2..] } else { rest };
        let (scheme, host, port) = origin(&format!("{scheme}://{without}"))?;
        if host.contains('*') {
            return None;
        }
        Some(Self {
            scheme,
            host,
            any_subdomain: wildcard,
            port,
        })
    }

    fn matches(&self, scheme: &str, host: &str, port: Option<&str>) -> bool {
        if scheme != self.scheme || port != self.port.as_deref() {
            return false;
        }
        host == self.host || (self.any_subdomain && host.ends_with(&format!(".{}", self.host)))
    }
}

/// A program as written in a step or in `apps`: compared case-insensitively,
/// `/` and `\` alike, `.exe` optional.
struct AppName {
    /// Full path when the text has a folder in it.
    path: Option<String>,
    file: String,
}

impl AppName {
    fn new(text: &str) -> Self {
        let text = text
            .trim()
            .trim_matches('"')
            .replace('/', "\\")
            .to_lowercase();
        let with_exe = |s: &str| {
            let name = s.rsplit('\\').next().unwrap_or(s);
            if name.contains('.') {
                s.to_owned()
            } else {
                format!("{s}.exe")
            }
        };
        let full = with_exe(&text);
        let file = full.rsplit('\\').next().unwrap_or(&full).to_owned();
        Self {
            path: text.contains('\\').then_some(full),
            file,
        }
    }

    /// Whether this `apps` entry allows `wanted`. An entry with a folder
    /// needs the same full path; a bare file name matches in any folder.
    fn allows(&self, wanted: &Self) -> bool {
        match &self.path {
            Some(path) => wanted.path.as_ref() == Some(path),
            None => self.file == wanted.file,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn policy(value: Value) -> Policy {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn empty_lists_allow_everything() {
        let p = Policy::default();
        assert!(p.check_site("https://anything.example").is_ok());
        assert!(p.check_app("C:\\x\\y.exe").is_ok());
        assert_eq!(p.ai_run(RiskLevel::Interactive, &[]), Decision::Allow);
        assert_eq!(p.ai_test_step(RiskLevel::Dangerous, &[]), Decision::Ask);
        assert_eq!(p.ai_delete(), Decision::Ask);
        assert!(p.allows_unattended("scn_a"));
    }

    #[test]
    fn sites_match_origin_and_subdomains() {
        let p = policy(json!({
            "sites": ["https://order.example.co.jp", "https://*.corp.example", "http://localhost:8080"]
        }));
        assert!(
            p.check_site("https://order.example.co.jp/login?x=1")
                .is_ok()
        );
        assert!(p.check_site("HTTPS://Order.Example.co.jp:443/").is_ok());
        assert!(p.check_site("https://a.b.corp.example/x").is_ok());
        assert!(p.check_site("https://corp.example/").is_ok());
        assert!(p.check_site("http://localhost:8080/").is_ok());
        assert!(p.check_site("about:blank").is_ok());
        for bad in [
            "http://order.example.co.jp/",
            "https://order.example.co.jp.evil.test/",
            "https://evil.test/?u=https://order.example.co.jp",
            "https://order.example.co.jp@evil.test/",
            "http://localhost:9090/",
            "file:///C:/secret.txt",
            "https://notcorp.example/",
        ] {
            let e = p.check_site(bad).unwrap_err();
            assert_eq!(e.code, "SITE_NOT_ALLOWED", "{bad}");
        }
    }

    #[test]
    fn apps_match_full_path_or_file_name() {
        let p = policy(json!({
            "apps": ["C:\\Program Files\\Billing\\billing.exe", "notepad"]
        }));
        assert!(p.check_app("c:/program files/billing/BILLING.EXE").is_ok());
        assert!(p.check_app("notepad.exe").is_ok());
        assert!(p.check_app("C:\\Windows\\notepad.exe").is_ok());
        assert!(p.check_app("D:\\copy\\billing.exe").is_err());
        assert_eq!(p.check_app("cmd").unwrap_err().code, "APP_NOT_ALLOWED");
    }

    #[test]
    fn scenario_settings_only_tighten() {
        let p = policy(json!({
            "ai": { "runScenario": { "interactive": "allow" } },
            "scenarios": {
                "scn_pay": { "aiRun": "deny", "unattended": false },
                "scn_open": { "aiRun": "allow" }
            }
        }));
        assert_eq!(
            p.ai_run(RiskLevel::Interactive, &["scn_x", "scn_pay"]),
            Decision::Deny
        );
        // "allow" on a scenario never loosens the risk rule.
        assert_eq!(p.ai_run(RiskLevel::Dangerous, &["scn_open"]), Decision::Ask);
        assert!(!p.allows_unattended("scn_pay"));
    }

    #[test]
    fn broken_files_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = Policy::path(dir.path());
        assert_eq!(Policy::load(&path).unwrap(), Policy::default());
        std::fs::write(&path, r#"{ "sites": ["example.com"] }"#).unwrap();
        assert_eq!(Policy::load(&path).unwrap_err().code(), "POLICY_INVALID");
        std::fs::write(&path, r#"{ "ai": { "runScenario": "allow" } }"#).unwrap();
        assert_eq!(Policy::load(&path).unwrap_err().code(), "POLICY_INVALID");
        std::fs::write(&path, r#"{ "sitez": [] }"#).unwrap();
        assert_eq!(Policy::load(&path).unwrap_err().code(), "POLICY_INVALID");
    }
}

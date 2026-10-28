//! `requires`: the plugins a scenario's steps need, and which versions.
//!
//! A scenario that uses `kintone.addRecord` records
//! `"plugin:kintone": "^0.3.1"` (the version installed when the step was
//! added). Another PC can then say "install the kintone plugin 0.3.1 or a
//! compatible later version" instead of "unknown step type", and a plugin
//! update that breaks its params (a new major version) is caught before the
//! scenario runs. Core keeps the map in sync with the steps on every edit;
//! authors only touch it to loosen or tighten a range.

use std::collections::{BTreeMap, BTreeSet};

use semver::{Version, VersionReq};

use crate::model::Scenario;
use crate::registry::StepRegistry;

/// Key prefix of a plugin requirement: `plugin:<name>`.
pub const PLUGIN_PREFIX: &str = "plugin:";

/// Namespace of a step type (`kintone` for `kintone.addRecord`).
pub fn namespace(step_type: &str) -> &str {
    step_type.split_once('.').map_or(step_type, |(ns, _)| ns)
}

/// The requirement for a freshly added step of a plugin at `version`:
/// that version or any later compatible one.
pub fn default_requirement(version: &str) -> String {
    format!("^{version}")
}

/// Brings `scenario.requires` in line with its steps: adds plugins used by
/// steps but not listed (at the installed version) and drops plugins no step
/// uses any more. Listed plugins keep their range, also when the plugin is
/// not installed here. Keys that are not `plugin:` entries are left for
/// validation to report.
pub fn sync(scenario: &mut Scenario, registry: &StepRegistry) {
    let used: BTreeSet<String> = scenario
        .walk()
        .map(|step| namespace(&step.step_type).to_owned())
        .collect();
    scenario
        .requires
        .retain(|key, _| match key.strip_prefix(PLUGIN_PREFIX) {
            Some(name) => used.contains(name),
            None => true,
        });
    let mut added = BTreeMap::new();
    for step in scenario.walk() {
        let Some(plugin) = registry
            .get(&step.step_type)
            .and_then(|def| def.plugin.as_ref())
        else {
            continue;
        };
        let key = format!("{PLUGIN_PREFIX}{}", plugin.name);
        if !scenario.requires.contains_key(&key) {
            added
                .entry(key)
                .or_insert_with(|| default_requirement(&plugin.version));
        }
    }
    scenario.requires.extend(added);
}

/// Checks one `requires` entry against what is installed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Check {
    /// Installed and in range.
    Ok,
    /// The key is not `plugin:<name>`.
    BadKey,
    /// The range does not parse as a semver requirement.
    BadRange(String),
    /// Not installed on this PC.
    Missing,
    /// Installed, but at a version outside the range.
    Mismatch { installed: String },
}

pub fn check(key: &str, range: &str, registry: &StepRegistry) -> Check {
    let Some(name) = key.strip_prefix(PLUGIN_PREFIX).filter(|n| !n.is_empty()) else {
        return Check::BadKey;
    };
    let req = match VersionReq::parse(range) {
        Ok(req) => req,
        Err(e) => return Check::BadRange(e.to_string()),
    };
    let Some(plugin) = registry.plugin(name) else {
        return Check::Missing;
    };
    match Version::parse(&plugin.version) {
        Ok(installed) if req.matches(&installed) => Check::Ok,
        _ => Check::Mismatch {
            installed: plugin.version.clone(),
        },
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::model::Step;
    use crate::registry::{PluginInfo, StepRegistry};

    fn registry_with(name: &str, version: &str) -> StepRegistry {
        let mut registry = StepRegistry::with_builtins();
        let mut def = registry.get("log.message").unwrap().clone();
        def.step_type = format!("{name}.greet");
        def.plugin = Some(PluginInfo {
            name: name.into(),
            version: version.into(),
        });
        registry.register(def);
        registry
    }

    #[test]
    fn sync_adds_used_and_drops_unused_plugins() {
        let registry = registry_with("hello", "0.3.1");
        let mut s = Scenario::new("x");
        s.steps = vec![Step::new("hello.greet"), Step::new("log.message")];
        s.requires.insert("plugin:old".into(), "^1".into());
        sync(&mut s, &registry);
        assert_eq!(
            s.requires,
            BTreeMap::from([("plugin:hello".into(), "^0.3.1".into())])
        );
    }

    #[test]
    fn sync_keeps_ranges_of_plugins_not_installed() {
        let registry = StepRegistry::with_builtins();
        let mut s = Scenario::new("x");
        s.steps = vec![Step::new("kintone.addRecord")];
        s.requires
            .insert("plugin:kintone".into(), ">=0.2, <2".into());
        sync(&mut s, &registry);
        assert_eq!(s.requires["plugin:kintone"], ">=0.2, <2");
    }

    #[test]
    fn check_compares_with_the_installed_version() {
        let registry = registry_with("hello", "1.2.0");
        assert_eq!(check("plugin:hello", "^1.1", &registry), Check::Ok);
        assert_eq!(
            check("plugin:hello", "^0.3", &registry),
            Check::Mismatch {
                installed: "1.2.0".into()
            }
        );
        assert_eq!(check("plugin:other", "^1", &registry), Check::Missing);
        assert_eq!(check("hello", "^1", &registry), Check::BadKey);
        assert!(matches!(
            check("plugin:hello", "one", &registry),
            Check::BadRange(_)
        ));
    }
}

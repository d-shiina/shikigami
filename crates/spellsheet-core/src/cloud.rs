//! Where a flow's `input/` comes from and its `output/` goes to, when that is
//! cloud storage reached through its API (Box, Google Drive, OneDrive /
//! SharePoint): a setting of the flow's folder, not nodes in the flow.
//!
//! `config/cloud.json` names, for `input` and `output`, the plugin that
//! talks to the storage (`box`: its `box.downloadFolder` and `box.upload`),
//! the OAuth secret it signs in with and the folder. Input and output may
//! name different storages or accounts. A whole
//! run then fetches the folder's files into `input/` before the first node,
//! and after the last one sends the files written to `output/` during the
//! run. The nodes keep reading `input/受注.xlsx`, so the same flow runs with
//! the files put in its folder by hand, and whoever receives it changes only
//! this setting.

use std::fs;
use std::path::Path;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Where the setting is kept, in the flow's folder.
pub const CLOUD_PATH: &str = "config/cloud.json";

/// `format` of [`CloudFile`].
pub const CLOUD_FORMAT: &str = "spellsheet.cloud";

/// `config/cloud.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CloudFile {
    /// Always `spellsheet.cloud`.
    pub format: String,
    /// Fetched into `input/` before the run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<CloudPlace>,
    /// Where the files the run writes to `output/` are sent after it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<CloudPlace>,
}

/// A folder in cloud storage, and how to reach it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CloudPlace {
    /// The plugin that reaches the storage (`box`, `googledrive`,
    /// `onedrive`): its `<service>.downloadFolder` and `<service>.upload`
    /// do the work.
    pub service: String,
    /// The storage's name in the run's log (`Box`). Defaults to `service`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub label: String,
    /// The OAuth secret the plugin signs in with (its access token is
    /// passed as `{ "secret": …, "field": "accessToken" }`).
    pub secret: String,
    /// `oauth.signIn` params besides `secret` (`authorizeUrl`, `tokenUrl`,
    /// `redirectUrl`, `scope`, `authorizeParams`): the run signs in first,
    /// asking a person only when there is no sign-in to refresh yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sign_in: Option<Map<String, Value>>,
    /// The folder: a path from the storage's top (`経理/受注`), its ID or a
    /// link to it, as the plugin takes them.
    pub folder: String,
    /// The folder as people know it (`経理/受注`), for the log and Writer,
    /// when `folder` is an ID or a link. Defaults to `folder`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub folder_name: String,
    /// Input only: fetch the files whose names match (`*.xlsx`). Empty:
    /// every file directly in the folder.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub pattern: String,
    /// Input only: fetch just these files of the folder, by name; a missing
    /// one fails the run. Empty: every file (that matches `pattern`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
}

impl CloudPlace {
    /// The storage's name for people (`Box`).
    pub fn name(&self) -> &str {
        if self.label.trim().is_empty() {
            &self.service
        } else {
            &self.label
        }
    }

    /// The folder for people (`経理/受注`).
    pub fn folder_name(&self) -> &str {
        if self.folder_name.trim().is_empty() {
            &self.folder
        } else {
            &self.folder_name
        }
    }

    /// The node type of one of the plugin's actions (`box.download`).
    pub fn step_type(&self, action: &str) -> String {
        format!("{}.{action}", self.service)
    }

    /// The account param the plugin's nodes take.
    pub fn account(&self) -> Value {
        serde_json::json!({ "secret": self.secret, "field": "accessToken" })
    }
}

impl CloudFile {
    /// The setting of the flow in `project_dir`: `None` when there is none
    /// (or it names neither input nor output).
    pub fn read(project_dir: &Path) -> Result<Option<Self>, String> {
        let path = project_dir.join(CLOUD_PATH);
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("{CLOUD_PATH} could not be read: {e}")),
        };
        Self::parse(&text)
    }

    /// Parses the text of `config/cloud.json`.
    pub fn parse(text: &str) -> Result<Option<Self>, String> {
        let file: Self = serde_json::from_str(text.trim_start_matches('\u{feff}'))
            .map_err(|e| format!("{CLOUD_PATH} is not a cloud storage setting: {e}"))?;
        if file.format != CLOUD_FORMAT {
            return Err(format!("{CLOUD_PATH}: format must be \"{CLOUD_FORMAT}\""));
        }
        for place in file.input.iter().chain(&file.output) {
            if place.service.trim().is_empty()
                || place.secret.trim().is_empty()
                || place.folder.trim().is_empty()
            {
                return Err(format!(
                    "{CLOUD_PATH}: service, secret and folder are needed"
                ));
            }
        }
        Ok((file.input.is_some() || file.output.is_some()).then_some(file))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_setting_and_names_the_nodes() {
        let file = CloudFile::parse(
            r#"{"format":"spellsheet.cloud","input":{"service":"box","label":"Box","secret":"Box","folder":"経理/受注","pattern":"*.xlsx"}}"#,
        )
        .unwrap()
        .unwrap();
        let input = file.input.unwrap();
        assert_eq!(input.step_type("download"), "box.download");
        assert_eq!(input.name(), "Box");
        assert_eq!(input.account()["field"], "accessToken");
        assert!(file.output.is_none());
    }

    #[test]
    fn refuses_a_setting_without_its_folder() {
        assert!(CloudFile::parse(r#"{"format":"spellsheet.cloud","output":{"service":"box","secret":"Box","folder":""}}"#).is_err());
        assert!(CloudFile::parse(r#"{"format":"spellsheet.config","items":[]}"#).is_err());
        assert_eq!(
            CloudFile::parse(r#"{"format":"spellsheet.cloud"}"#).unwrap(),
            None
        );
    }

    #[test]
    fn a_folder_without_the_setting_has_none() {
        let dir = std::env::temp_dir().join(format!("cloud-none-{}", std::process::id()));
        assert_eq!(CloudFile::read(&dir).unwrap(), None);
    }
}

//! A whole run of a flow whose folder is set to cloud storage
//! (`config/cloud.json`, see [`spellsheet_core::cloud`]): before the first
//! node the input folder's files are fetched into `input/`, and after the
//! last one the files the run wrote to `output/` are sent to the output
//! folder. The custom node that reaches the storage does the work
//! (`box.downloadFolder`, `box.upload`), signed in with `oauth.signIn` first
//! when the setting says how.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::SystemTime;

use serde_json::{Value, json};
use spellsheet_core::StepId;
use spellsheet_core::cloud::{CLOUD_PATH, CloudPlace};

use crate::event::{LogLevel, RunError, RunEvent};
use crate::exec::{Executor, Interrupt};

/// What the handlers see as the step: the transfers are not nodes of the flow.
const STEP_ID: &str = "cloud";

const SIGN_IN: &str = "oauth.signIn";

/// The files directly in `output/` and when each was last written: taken
/// when the run starts, so only what the run writes is sent.
pub(crate) type Snapshot = BTreeMap<String, (Option<SystemTime>, u64)>;

pub(crate) fn snapshot(project_dir: &Path) -> Snapshot {
    let Ok(entries) = fs::read_dir(project_dir.join("output")) else {
        return Snapshot::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            let name = e.file_name().to_string_lossy().into_owned();
            (meta.is_file() && !hidden(&name)).then(|| (name, (meta.modified().ok(), meta.len())))
        })
        .collect()
}

/// Office's lock files, temporary and hidden files are never sent.
fn hidden(name: &str) -> bool {
    name.starts_with('.')
        || name.starts_with("~$")
        || name.eq_ignore_ascii_case("desktop.ini")
        || name.to_ascii_lowercase().ends_with(".tmp")
}

/// Fetches the input folder's files into `input/`, replacing files of the
/// same name.
pub(crate) async fn fetch(executor: &Executor, place: &CloudPlace) -> Result<(), Interrupt> {
    let what = format!("{} の {} から input/ に取得", place.name(), place.folder);
    sign_in(executor, place, &what).await?;
    let mut params = json!({
        "account": place.account(),
        "folder": place.folder,
        "to": "input",
        "overwrite": true,
    });
    if !place.pattern.trim().is_empty() {
        params["pattern"] = Value::String(place.pattern.trim().to_owned());
    }
    let result = call(executor, place, "downloadFolder", params, &what).await?;
    let names: Vec<String> = result
        .get("files")
        .and_then(Value::as_array)
        .map(|files| {
            files
                .iter()
                .filter_map(|f| f.get("name").and_then(Value::as_str).map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    log(
        executor,
        LogLevel::Info,
        if names.is_empty() {
            format!(
                "{} の {} に取得するファイルがありませんでした",
                place.name(),
                place.folder
            )
        } else {
            format!(
                "{} の {} から input/ に {} ファイルを取得しました（{}）",
                place.name(),
                place.folder,
                names.len(),
                names.join("、")
            )
        },
    );
    Ok(())
}

/// Sends the files the run wrote to `output/` (new or changed since
/// `before`) to the output folder, replacing files of the same name there.
pub(crate) async fn send(
    executor: &Executor,
    place: &CloudPlace,
    project_dir: &Path,
    before: &Snapshot,
) -> Result<(), Interrupt> {
    let written: Vec<String> = snapshot(project_dir)
        .into_iter()
        .filter(|(name, now)| before.get(name) != Some(now))
        .map(|(name, _)| name)
        .collect();
    if written.is_empty() {
        log(
            executor,
            LogLevel::Info,
            format!(
                "output/ に書き出したファイルがないため、{} には送りませんでした",
                place.name()
            ),
        );
        return Ok(());
    }
    let what = format!(
        "output/ のファイルを {} の {} に送信",
        place.name(),
        place.folder
    );
    sign_in(executor, place, &what).await?;
    for name in &written {
        let params = json!({
            "account": place.account(),
            "path": format!("output/{name}"),
            "folder": place.folder,
            "overwrite": true,
        });
        call(executor, place, "upload", params, &what).await?;
    }
    log(
        executor,
        LogLevel::Info,
        format!(
            "output/ の {} ファイルを {} の {} に送りました（{}）",
            written.len(),
            place.name(),
            place.folder,
            written.join("、")
        ),
    );
    Ok(())
}

/// Signs in when the setting says how (asking a person only when there is
/// no sign-in to refresh yet).
async fn sign_in(executor: &Executor, place: &CloudPlace, what: &str) -> Result<(), Interrupt> {
    let Some(sign_in) = &place.sign_in else {
        return Ok(());
    };
    let mut params = sign_in.clone();
    params.insert("secret".into(), Value::String(place.secret.clone()));
    executor
        .run_action(&StepId::new(STEP_ID), SIGN_IN, Value::Object(params))
        .await
        .map(|_| ())
        .map_err(|e| labelled(e, what, None))
}

async fn call(
    executor: &Executor,
    place: &CloudPlace,
    action: &str,
    params: Value,
    what: &str,
) -> Result<Value, Interrupt> {
    let step_type = place.step_type(action);
    if !executor.handlers.contains_key(&step_type) {
        return Err(labelled(
            RunError {
                details: Some(json!({
                    "hint": format!(
                        "Install the {} custom node (Writer: 拡張機能), or remove the setting in {CLOUD_PATH}.",
                        place.service
                    ),
                })),
                ..RunError::new(
                    "CLOUD_NODE_MISSING",
                    format!(
                        "{} のカスタム ノード（{}）が入っていないため、{what}できません",
                        place.name(),
                        place.service
                    ),
                )
            }
            .into(),
            what,
            Some(&step_type),
        ));
    }
    executor
        .run_action(&StepId::new(STEP_ID), &step_type, params)
        .await
        .map_err(|e| labelled(e, what, Some(&step_type)))
}

/// Names the transfer in the run's error, as a node's name would be.
fn labelled(interrupt: Interrupt, what: &str, step_type: Option<&str>) -> Interrupt {
    match interrupt {
        Interrupt::Failed(mut e) => {
            e.step_label = Some(what.to_owned());
            if e.step_type.is_none() {
                e.step_type = step_type.map(str::to_owned);
            }
            Interrupt::Failed(e)
        }
        cancelled @ Interrupt::Cancelled => cancelled,
    }
}

fn log(executor: &Executor, level: LogLevel, message: String) {
    executor.emitter.emit(RunEvent::Log {
        level,
        message,
        step_id: None,
    });
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn a_snapshot_leaves_out_lock_and_hidden_files() {
        let dir = std::env::temp_dir().join(format!("cloud-snap-{}", std::process::id()));
        let output = dir.join("output");
        fs::create_dir_all(output.join("sub")).unwrap();
        fs::write(output.join("請求書.pdf"), "a").unwrap();
        fs::write(output.join("~$請求書.xlsx"), "a").unwrap();
        fs::write(output.join(".hidden"), "a").unwrap();
        let names: Vec<String> = snapshot(&dir).into_keys().collect();
        assert_eq!(names, ["請求書.pdf"]);
        fs::remove_dir_all(&dir).unwrap();
    }
}

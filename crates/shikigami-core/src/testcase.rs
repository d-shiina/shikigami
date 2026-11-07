//! Test cases of a flow: inputs to run it with and what should come out.
//!
//! ```text
//! flows/<flow-id>/tests/<name>.json
//! ```
//!
//! ```json
//! {
//!   "description": "3 件の受注を集計する",
//!   "inputs": { "month": "2026-11" },
//!   "expect": { "status": "succeeded", "outputs": { "total": 3 } }
//! }
//! ```
//!
//! `expect.outputs` is a subset: only the outputs (and, inside an object,
//! only the keys) it names are compared, so a case keeps passing when the
//! flow gains an output. Lists must have the same length, each item
//! compared the same way. Numbers compare by value (`3` = `3.0`).
//!
//! The folder is not one of the standard ones (`project::FOLDERS`), so it
//! travels in bundles with the flow, like `input/`.

use std::fs;
use std::path::{Path, PathBuf};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::{CoreError, CoreResult};

/// Folder of a flow's test cases, inside its project folder.
pub const TESTS_FOLDER: &str = "tests";

/// One test case, `tests/<name>.json`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestCase {
    /// `https://…/test-case.schema.json`, for editors (optional, not used).
    #[serde(rename = "$schema", default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    /// What the case is about, in the author's words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Values of the flow's input variables, as `shikigami run -i` takes them.
    #[serde(default)]
    pub inputs: Map<String, Value>,
    #[serde(default)]
    pub expect: Expect,
}

/// What should come out of the run.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Expect {
    /// How the run ends. `failed` for a case that checks an error is raised.
    #[serde(default)]
    pub status: ExpectedStatus,
    /// Output variables to compare (a subset, see the module docs).
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub outputs: Map<String, Value>,
    /// The error's code, when `status` is `failed` (e.g. `ELEMENT_NOT_FOUND`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    /// The node the run should stop at, when `status` is `failed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_step: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ExpectedStatus {
    #[default]
    Succeeded,
    Failed,
    Cancelled,
}

impl ExpectedStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

/// How a run ended, as far as a test case looks at it.
#[derive(Debug, Clone, Copy)]
pub struct Outcome<'a> {
    /// `succeeded`, `failed` or `cancelled`.
    pub status: &'a str,
    pub outputs: &'a Map<String, Value>,
    pub error_code: Option<&'a str>,
    pub error_step: Option<&'a str>,
}

/// One difference between what the case expects and what the run did.
/// `actual` is `null` when the run had no such value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Mismatch {
    /// `status`, `outputs.total`, `outputs.rows[2].金額`, `errorCode`, `errorStep`.
    pub at: String,
    pub expected: Value,
    pub actual: Value,
}

impl Expect {
    /// The differences; empty when the run did what the case expects.
    pub fn check(&self, outcome: &Outcome<'_>) -> Vec<Mismatch> {
        let mut out = Vec::new();
        if outcome.status != self.status.as_str() {
            out.push(Mismatch {
                at: "status".into(),
                expected: self.status.as_str().into(),
                actual: outcome.status.into(),
            });
        }
        for (name, expected) in &self.outputs {
            let at = format!("outputs.{name}");
            match outcome.outputs.get(name) {
                Some(actual) => compare(&at, expected, actual, &mut out),
                None => out.push(Mismatch {
                    at,
                    expected: expected.clone(),
                    actual: Value::Null,
                }),
            }
        }
        let mut exact = |at: &str, expected: &Option<String>, actual: Option<&str>| {
            if let Some(expected) = expected
                && actual != Some(expected.as_str())
            {
                out.push(Mismatch {
                    at: at.into(),
                    expected: expected.as_str().into(),
                    actual: actual.map_or(Value::Null, Value::from),
                });
            }
        };
        exact("errorCode", &self.error_code, outcome.error_code);
        exact("errorStep", &self.error_step, outcome.error_step);
        out
    }
}

fn compare(at: &str, expected: &Value, actual: &Value, out: &mut Vec<Mismatch>) {
    let differ = || Mismatch {
        at: at.to_owned(),
        expected: expected.clone(),
        actual: actual.clone(),
    };
    match (expected, actual) {
        (Value::Object(want), Value::Object(got)) => {
            for (key, value) in want {
                let at = format!("{at}.{key}");
                match got.get(key) {
                    Some(got) => compare(&at, value, got, out),
                    None => out.push(Mismatch {
                        at,
                        expected: value.clone(),
                        actual: Value::Null,
                    }),
                }
            }
        }
        (Value::Array(want), Value::Array(got)) => {
            if want.len() != got.len() {
                out.push(differ());
                return;
            }
            for (i, (want, got)) in want.iter().zip(got).enumerate() {
                compare(&format!("{at}[{i}]"), want, got, out);
            }
        }
        (Value::Number(want), Value::Number(got)) => {
            if !same_number(want, got) {
                out.push(differ());
            }
        }
        _ if expected == actual => {}
        _ => out.push(differ()),
    }
}

/// `3` = `3.0`, but whole numbers past 2^53 compare exactly, not as f64.
fn same_number(a: &serde_json::Number, b: &serde_json::Number) -> bool {
    let whole = |n: &serde_json::Number| {
        n.as_i64()
            .map(i128::from)
            .or_else(|| n.as_u64().map(i128::from))
    };
    match (whole(a), whole(b)) {
        (Some(a), Some(b)) => a == b,
        _ => a.as_f64() == b.as_f64(),
    }
}

/// The tests folder of a project folder.
pub fn tests_dir(project_dir: &Path) -> PathBuf {
    project_dir.join(TESTS_FOLDER)
}

/// The cases in `tests/`, by name (the file name without `.json`), in name
/// order. No folder means no cases.
pub fn load_all(project_dir: &Path) -> CoreResult<Vec<(String, TestCase)>> {
    let dir = tests_dir(project_dir);
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut names = Vec::new();
    for entry in entries {
        let path = entry?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") || !path.is_file() {
            continue;
        }
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            names.push(stem.to_owned());
        }
    }
    names.sort();
    names
        .into_iter()
        .map(|name| load(project_dir, &name).map(|case| (name, case)))
        .collect()
}

/// One case by name.
pub fn load(project_dir: &Path, name: &str) -> CoreResult<TestCase> {
    let path = case_path(project_dir, name)?;
    let text = fs::read_to_string(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => CoreError::Rejected {
            code: "TEST_CASE_NOT_FOUND",
            message: format!("no test case '{name}' ({})", path.display()),
            hint: Some(format!(
                "Test cases are {TESTS_FOLDER}/<name>.json in the flow's folder."
            )),
        },
        _ => e.into(),
    })?;
    serde_json::from_str(&text).map_err(|e| CoreError::Rejected {
        code: "TEST_CASE_INVALID",
        message: format!("{}: {e}", path.display()),
        hint: Some(
            "A case has description, inputs and expect { status, outputs, errorCode, errorStep }."
                .into(),
        ),
    })
}

/// Write a case (the folder is made when missing).
pub fn save(project_dir: &Path, name: &str, case: &TestCase) -> CoreResult<PathBuf> {
    let path = case_path(project_dir, name)?;
    fs::create_dir_all(tests_dir(project_dir))?;
    fs::write(&path, serde_json::to_string_pretty(case)? + "\n")?;
    Ok(path)
}

/// Whether a file for this case name is there (readable or not).
pub fn exists(project_dir: &Path, name: &str) -> CoreResult<bool> {
    Ok(case_path(project_dir, name)?.exists())
}

/// Delete a case. One that is not there is not an error.
pub fn remove(project_dir: &Path, name: &str) -> CoreResult<()> {
    match fs::remove_file(case_path(project_dir, name)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

fn case_path(project_dir: &Path, name: &str) -> CoreResult<PathBuf> {
    let bad = name.is_empty()
        || name.starts_with('.')
        || name.chars().any(|c| {
            matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control()
        });
    if bad {
        return Err(CoreError::Rejected {
            code: "TEST_CASE_NAME",
            message: format!("'{name}' cannot be a test case name"),
            hint: Some("Use a file name without folders, e.g. 3件の受注.".into()),
        });
    }
    Ok(tests_dir(project_dir).join(format!("{name}.json")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn outcome<'a>(status: &'a str, outputs: &'a Map<String, Value>) -> Outcome<'a> {
        Outcome {
            status,
            outputs,
            error_code: None,
            error_step: None,
        }
    }

    #[test]
    fn outputs_are_compared_as_a_subset() {
        let expect: Expect = serde_json::from_value(json!({
            "outputs": { "total": 3, "summary": { "count": 2 }, "rows": [{ "金額": 100 }] }
        }))
        .unwrap();
        let outputs = json!({
            "total": 3.0, "extra": true,
            "summary": { "count": 2, "note": "x" },
            "rows": [{ "金額": 100, "品名": "a" }]
        });
        let outputs = outputs.as_object().unwrap();
        assert!(expect.check(&outcome("succeeded", outputs)).is_empty());

        let outputs =
            json!({ "total": 4, "summary": {}, "rows": [{ "金額": 100 }, { "金額": 1 }] });
        let found = expect.check(&outcome("failed", outputs.as_object().unwrap()));
        let at: Vec<_> = found.iter().map(|m| m.at.as_str()).collect();
        assert_eq!(
            at,
            [
                "status",
                "outputs.total",
                "outputs.summary.count",
                "outputs.rows"
            ]
        );
        assert_eq!(found[2].actual, Value::Null);
    }

    #[test]
    fn whole_numbers_compare_exactly() {
        let expect: Expect =
            serde_json::from_value(json!({ "outputs": { "id": 9007199254740992u64 } })).unwrap();
        let outputs = json!({ "id": 9007199254740993u64 });
        assert_eq!(
            expect
                .check(&outcome("succeeded", outputs.as_object().unwrap()))
                .len(),
            1
        );
        let outputs = json!({ "id": 9007199254740992.0 });
        assert!(
            expect
                .check(&outcome("succeeded", outputs.as_object().unwrap()))
                .is_empty()
        );
    }

    #[test]
    fn a_case_can_expect_an_error() {
        let expect: Expect = serde_json::from_value(json!({
            "status": "failed", "errorCode": "ELEMENT_NOT_FOUND", "errorStep": "click_save"
        }))
        .unwrap();
        let none = Map::new();
        let mut got = outcome("failed", &none);
        got.error_code = Some("ELEMENT_NOT_FOUND");
        got.error_step = Some("click_save");
        assert!(expect.check(&got).is_empty());
        got.error_code = Some("STEP_TIMEOUT");
        assert_eq!(expect.check(&got)[0].at, "errorCode");
    }

    #[test]
    fn cases_are_read_from_the_tests_folder_in_name_order() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load_all(dir.path()).unwrap().is_empty());
        let case = TestCase {
            schema: None,
            description: Some("空の月".into()),
            inputs: json!({ "month": "2026-02" }).as_object().unwrap().clone(),
            expect: Expect::default(),
        };
        save(dir.path(), "b_空の月", &case).unwrap();
        save(dir.path(), "a_通常", &TestCase::default()).unwrap();
        fs::write(tests_dir(dir.path()).join("memo.txt"), "x").unwrap();
        let all = load_all(dir.path()).unwrap();
        let names: Vec<_> = all.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["a_通常", "b_空の月"]);
        assert_eq!(all[1].1, case);
        assert!(save(dir.path(), "../x", &case).is_err());
        assert!(load(dir.path(), "無い").is_err());
        remove(dir.path(), "a_通常").unwrap();
        remove(dir.path(), "a_通常").unwrap();
        assert_eq!(load_all(dir.path()).unwrap().len(), 1);
        fs::write(tests_dir(dir.path()).join("bad.json"), r#"{"expected":{}}"#).unwrap();
        assert!(load_all(dir.path()).is_err());
    }
}

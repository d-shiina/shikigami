//! File and folder steps (`file.*`) for the Shikigami Runtime: text and CSV
//! files (UTF-8 or Shift_JIS), copy / move / delete, folder listings and
//! zip archives.
//!
//! Each step names its files by params (`path`, `from`, `to`), which are
//! also its locks: steps on the same file take turns, steps on different
//! files run side by side. Values are handled by expression functions
//! (`pathJoin`, `fileName`, `filter`, …), not by more steps.

// StepError is the Runtime's handler error type; boxing it here would only
// move the allocation.
#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{Value, json};
use shikigami_core::registry::{RiskLevel, StepCategory, StepTypeDef};
use shikigami_core::resource::{ResourceDef, resource_keys};
use shikigami_runtime::{
    ActionHandler, ActionInput, Adapter, BoxFuture, RuntimeBuilder, StepError,
};
use tokio_util::sync::CancellationToken;

pub mod encoding;
pub mod ops;

#[cfg(test)]
mod tests;

pub mod types {
    pub const READ_TEXT: &str = "file.readText";
    pub const WRITE_TEXT: &str = "file.writeText";
    pub const READ_CSV: &str = "file.readCsv";
    pub const WRITE_CSV: &str = "file.writeCsv";
    pub const EXISTS: &str = "file.exists";
    pub const LIST: &str = "file.list";
    pub const COPY: &str = "file.copy";
    pub const MOVE: &str = "file.move";
    pub const DELETE: &str = "file.delete";
    pub const CREATE_FOLDER: &str = "file.createFolder";
    pub const ZIP: &str = "file.zip";
    pub const UNZIP: &str = "file.unzip";
    pub const CONFIG_READ: &str = "config.read";
}

/// File steps; needs nothing installed.
#[derive(Debug, Clone, Default)]
pub struct FileAdapter;

impl FileAdapter {
    pub fn new() -> Self {
        Self
    }
}

impl Adapter for FileAdapter {
    fn name(&self) -> &'static str {
        "file"
    }

    fn install(&self, mut builder: RuntimeBuilder) -> RuntimeBuilder {
        for (def, kind) in step_defs() {
            builder = builder.register(def, FileStep { kind });
        }
        builder
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    ReadText,
    WriteText,
    ReadCsv,
    WriteCsv,
    Exists,
    List,
    Copy,
    Move,
    Delete,
    CreateFolder,
    Zip,
    Unzip,
    ConfigRead,
}

struct FileStep {
    kind: Kind,
}

impl ActionHandler for FileStep {
    fn execute<'a>(&'a self, input: ActionInput) -> BoxFuture<'a, Result<Value, StepError>> {
        let kind = self.kind;
        let params = input.params;
        let cancel = input.cancel;
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let locks = file_locks(&params);
                let _held: Vec<_> = locks
                    .iter()
                    .map(|l| l.lock().unwrap_or_else(|e| e.into_inner()))
                    .collect();
                run_step(kind, &params, &cancel)
            })
            .await
            .map_err(|e| StepError::permanent("INTERNAL", e.to_string()))?
        })
    }
}

fn string(params: &Value, key: &str) -> Result<String, StepError> {
    match params.get(key) {
        Some(Value::String(s)) if !s.trim().is_empty() => Ok(s.clone()),
        Some(other) if !other.is_null() && !other.is_string() => Err(StepError::permanent(
            "INVALID_PARAMS",
            format!("'{key}' must be text, got {other}"),
        )),
        _ => Err(StepError::permanent(
            "INVALID_PARAMS",
            format!("'{key}' is required"),
        )),
    }
}

fn optional_string(params: &Value, key: &str) -> Option<String> {
    params.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn flag(params: &Value, key: &str, default: bool) -> bool {
    params.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn path(params: &Value, key: &str) -> Result<PathBuf, StepError> {
    string(params, key).map(PathBuf::from)
}

fn shown(path: &Path) -> Value {
    json!(path.display().to_string())
}

use ops::check_cancel;

/// Locks for the files a step names, held by the blocking task itself: an
/// attempt that timed out keeps running in the background until its next
/// cancellation check, and must not overlap the retry on the same files.
fn file_locks(params: &Value) -> Vec<Arc<Mutex<()>>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let keys = resource_keys(
        &[
            ResourceDef::file("path"),
            ResourceDef::file("from"),
            ResourceDef::file("to"),
        ],
        params,
    );
    let mut locks = LOCKS
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    // resource_keys sorts and dedups, so every step locks in the same order.
    keys.into_iter()
        .map(|key| locks.entry(key).or_default().clone())
        .collect()
}

fn run_step(kind: Kind, params: &Value, cancel: &CancellationToken) -> Result<Value, StepError> {
    let read_encoding = optional_string(params, "encoding").unwrap_or_else(|| "auto".into());
    let write_encoding = optional_string(params, "encoding").unwrap_or_else(|| "utf-8".into());
    match kind {
        Kind::ReadText => {
            let path = path(params, "path")?;
            let bytes = ops::read_bytes(&path)?;
            encoding::decode(&bytes, &read_encoding, &path.display().to_string()).map(Value::String)
        }
        Kind::ConfigRead => {
            let path = path(params, "path")?;
            let bytes = ops::read_bytes(&path)?;
            let shown = path.display().to_string();
            let text = encoding::decode(&bytes, "auto", &shown)?;
            let invalid = |why: String| {
                StepError::permanent("CONFIG_INVALID", format!("{shown}: {why}")).with_details(json!({
                    "hint": "A settings file is a JSON object, or a shikigami.config file made in Studio (config/ in the scenario's folder → New settings file).",
                }))
            };
            let json: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
                .map_err(|e| invalid(e.to_string()))?;
            shikigami_core::ConfigFile::values(&json)
                .map(Value::Object)
                .map_err(invalid)
        }
        Kind::WriteText => {
            let path = path(params, "path")?;
            let text = params
                .get("text")
                .map(shikigami_core::expr::to_display)
                .unwrap_or_default();
            check_cancel(cancel)?;
            ops::write_text(
                &path,
                &text,
                &write_encoding,
                flag(params, "append", false),
                cancel,
            )?;
            Ok(shown(&path))
        }
        Kind::ReadCsv => {
            let path = path(params, "path")?;
            let shown_path = path.display().to_string();
            let text = encoding::decode(&ops::read_bytes(&path)?, &read_encoding, &shown_path)?;
            ops::read_csv(
                &text,
                optional_string(params, "delimiter").as_deref(),
                flag(params, "header", true),
                &shown_path,
            )
        }
        Kind::WriteCsv => {
            let path = path(params, "path")?;
            let rows = match params.get("rows") {
                Some(Value::Array(rows)) => rows.clone(),
                Some(Value::Null) | None => Vec::new(),
                Some(other) => {
                    return Err(StepError::permanent(
                        "INVALID_PARAMS",
                        format!("'rows' must be a list of records, got {other}"),
                    ));
                }
            };
            let columns = params
                .get("columns")
                .and_then(Value::as_array)
                .map(|c| c.iter().map(shikigami_core::expr::to_display).collect());
            let delimiter = optional_string(params, "delimiter");
            check_cancel(cancel)?;
            let written = ops::write_csv(&ops::CsvWrite {
                path: &path,
                rows: &rows,
                columns,
                delimiter: delimiter.as_deref(),
                header: flag(params, "header", true),
                append: flag(params, "append", false),
                encoding: &write_encoding,
                cancel,
            })?;
            Ok(json!(written))
        }
        Kind::Exists => Ok(json!(path(params, "path")?.exists())),
        Kind::List => {
            let folder = path(params, "folder")?;
            let pattern = optional_string(params, "pattern").unwrap_or_else(|| "*".into());
            let kind = optional_string(params, "type").unwrap_or_else(|| "file".into());
            ops::list(
                &folder,
                &ops::ListOptions {
                    pattern: &pattern,
                    recursive: flag(params, "recursive", false),
                    kind: &kind,
                },
            )
        }
        Kind::Copy | Kind::Move => {
            let from = path(params, "from")?;
            let to = path(params, "to")?;
            check_cancel(cancel)?;
            let overwrite = flag(params, "overwrite", false);
            if kind == Kind::Copy {
                ops::copy(&from, &to, overwrite, cancel)?;
            } else {
                ops::rename(&from, &to, overwrite, cancel)?;
            }
            Ok(shown(&to))
        }
        Kind::Delete => {
            let path = path(params, "path")?;
            check_cancel(cancel)?;
            Ok(json!(ops::remove(&path, flag(params, "recursive", false))?))
        }
        Kind::CreateFolder => {
            let path = path(params, "path")?;
            check_cancel(cancel)?;
            std::fs::create_dir_all(&path).map_err(|e| ops::io_error(&e, &path))?;
            Ok(shown(&path))
        }
        Kind::Zip => {
            let sources: Vec<PathBuf> = match params.get("from") {
                Some(Value::Array(items)) if !items.is_empty() => items
                    .iter()
                    .map(|v| shikigami_core::expr::to_display(v).into())
                    .collect(),
                _ => vec![path(params, "from")?],
            };
            let to = path(params, "to")?;
            check_cancel(cancel)?;
            ops::zip(&sources, &to, flag(params, "overwrite", false), cancel)?;
            Ok(shown(&to))
        }
        Kind::Unzip => {
            let path = path(params, "path")?;
            let to = self::path(params, "to")?;
            check_cancel(cancel)?;
            ops::unzip(&path, &to, flag(params, "overwrite", false), cancel)
        }
    }
}

fn object_schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

fn def(
    step_type: &str,
    label: &str,
    description: &str,
    params_schema: Value,
    risk: RiskLevel,
    resources: Vec<ResourceDef>,
    examples: Vec<Value>,
) -> StepTypeDef {
    StepTypeDef {
        step_type: step_type.into(),
        category: StepCategory::File,
        label: label.into(),
        description: description.into(),
        blocks: vec![],
        has_output: true,
        expression_params: vec![],
        binds_variables: vec![],
        risk,
        examples,
        resources,
        secret_params: vec![],
        default_timeout_ms: None,
        deprecated: None,
        plugin: None,
        // Every path-like param, written or only read.
        path_params: ["path", "from", "to", "folder"]
            .into_iter()
            .filter(|key| params_schema["properties"].get(key).is_some())
            .map(Into::into)
            .collect(),
        params_schema,
    }
}

#[allow(clippy::too_many_lines)]
fn step_defs() -> Vec<(StepTypeDef, Kind)> {
    let path = json!({ "type": "string", "minLength": 1, "description": "シナリオのフォルダーからの相対パス（例: input/in.csv、output/result.csv）、または絶対パス（C:\\work\\in.csv）" });
    let folder = json!({ "type": "string", "minLength": 1, "description": "フォルダー：シナリオのフォルダーからの相対パス（例: input）、または絶対パス" });
    let read_encoding = json!({ "enum": encoding::READ_ENCODINGS, "description": "auto (default): BOM, then UTF-8, else Shift_JIS" });
    let write_encoding = json!({ "enum": encoding::WRITE_ENCODINGS, "description": "utf-8 (default). For files opened in Excel use utf-8-bom or shift_jis" });
    let flag = json!({ "type": "boolean" });
    let delimiter = json!({ "type": "string", "minLength": 1, "maxLength": 2, "description": "区切り文字（既定 \",\"。TSV は \"\\t\"）" });
    let any = json!({});
    vec![
        (
            def(
                types::CONFIG_READ,
                "設定ファイルを読む",
                "Reads a settings file (usually config/settings.json in the scenario's folder, made as a form in Studio) into an object of its values, e.g. { 締め日: 25, 送り先: \"...\" }; use them as {{ settings.締め日 }}. A plain JSON object file is returned as it is. Keep values people change (dates, recipients, folders) here instead of in the steps.",
                object_schema(json!({ "path": path }), &["path"]),
                RiskLevel::Safe,
                vec![ResourceDef::file("path")],
                vec![
                    json!({ "type": types::CONFIG_READ, "params": { "path": "config/settings.json" }, "saveAs": "settings" }),
                ],
            ),
            Kind::ConfigRead,
        ),
        (
            def(
                types::READ_TEXT,
                "テキストファイルを読む",
                "Reads a whole text file into a string. `encoding` auto-detects UTF-8 (with or without BOM) and Shift_JIS. Split it with lines() or split().",
                object_schema(
                    json!({ "path": path, "encoding": read_encoding }),
                    &["path"],
                ),
                RiskLevel::Safe,
                vec![ResourceDef::file("path")],
                vec![
                    json!({ "type": types::READ_TEXT, "params": { "path": "input/memo.txt" }, "saveAs": "memo" }),
                ],
            ),
            Kind::ReadText,
        ),
        (
            def(
                types::WRITE_TEXT,
                "テキストファイルに書く",
                "Writes `text` to a file, replacing it (or adding to its end with `append: true`). Missing folders are created. Output: the path.",
                object_schema(
                    json!({ "path": path, "text": any, "append": flag, "encoding": write_encoding }),
                    &["path", "text"],
                ),
                RiskLevel::Interactive,
                vec![ResourceDef::file("path")],
                vec![
                    json!({ "type": types::WRITE_TEXT, "params": { "path": "output/report.txt", "text": "合計 {{ total }} 円" } }),
                    json!({ "type": types::WRITE_TEXT, "params": { "path": "work/log.txt", "text": "{{ now() }} 完了\r\n", "append": true } }),
                ],
            ),
            Kind::WriteText,
        ),
        (
            def(
                types::READ_CSV,
                "CSV を読む",
                "Reads a CSV (or TSV with delimiter \"\\t\") into a list of records keyed by the header row; every cell is text (use num() for amounts). Blank header cells become 列N, repeated ones get _2. With `header: false` each row is a list of cells. Encoding is auto-detected (UTF-8 / Shift_JIS).",
                object_schema(
                    json!({ "path": path, "encoding": read_encoding, "delimiter": delimiter, "header": flag }),
                    &["path"],
                ),
                RiskLevel::Safe,
                vec![ResourceDef::file("path")],
                vec![
                    json!({ "type": types::READ_CSV, "params": { "path": "input/orders.csv" }, "saveAs": "orders" }),
                ],
            ),
            Kind::ReadCsv,
        ),
        (
            def(
                types::WRITE_CSV,
                "CSV に書く",
                "Writes `rows` (records, or lists of cells) to a CSV with a header row. `columns` sets which keys and in what order (default: every key, in order of appearance). `append: true` adds rows to the end of an existing file and follows its header. Lines end with CRLF. Output: the number of rows written.",
                object_schema(
                    json!({
                        "path": path,
                        "rows": { "description": "レコードの配列。例: \"{{ results }}\"" },
                        "columns": { "type": "array", "items": { "type": "string" } },
                        "append": flag,
                        "header": flag,
                        "encoding": write_encoding,
                        "delimiter": delimiter,
                    }),
                    &["path", "rows"],
                ),
                RiskLevel::Interactive,
                vec![ResourceDef::file("path")],
                vec![json!({
                    "type": types::WRITE_CSV,
                    "params": { "path": "output/result.csv", "rows": "{{ results }}", "columns": ["注文番号", "金額", "状態"], "encoding": "utf-8-bom" }
                })],
            ),
            Kind::WriteCsv,
        ),
        (
            def(
                types::EXISTS,
                "ファイルの有無を確認",
                "Outputs true when the file or folder exists. To wait for a file (e.g. a download), use wait.until with this step in its check block.",
                object_schema(json!({ "path": path }), &["path"]),
                RiskLevel::Safe,
                vec![],
                vec![
                    json!({ "type": types::EXISTS, "params": { "path": "work/done.flag" }, "saveAs": "done" }),
                ],
            ),
            Kind::Exists,
        ),
        (
            def(
                types::LIST,
                "フォルダーの中を一覧",
                "Lists the files in `folder` whose name matches `pattern` (wildcards * and ?, case-insensitive; default *). `type`: file (default), folder or all. `recursive` includes subfolders. Output: records { path, name, isFolder, size, modified } sorted by path; pick with filter() / sortBy().",
                object_schema(
                    json!({
                        "folder": folder,
                        "pattern": { "type": "string", "minLength": 1 },
                        "recursive": flag,
                        "type": { "enum": ["file", "folder", "all"] },
                    }),
                    &["folder"],
                ),
                RiskLevel::Safe,
                vec![],
                vec![
                    json!({ "type": types::LIST, "params": { "folder": "C:\\work\\inbox", "pattern": "*.csv" }, "saveAs": "csvFiles" }),
                ],
            ),
            Kind::List,
        ),
        (
            def(
                types::COPY,
                "コピー",
                "Copies a file or folder to `to` (the full new path, not the destination folder: use pathJoin(folder, fileName(from))). Fails with FILE_EXISTS unless `overwrite` is true. Output: the new path.",
                object_schema(
                    json!({ "from": path, "to": path, "overwrite": flag }),
                    &["from", "to"],
                ),
                RiskLevel::Interactive,
                vec![ResourceDef::file("from"), ResourceDef::file("to")],
                vec![
                    json!({ "type": types::COPY, "params": { "from": "templates/template.xlsx", "to": "output/{{ formatDate(today(), 'yyyyMMdd') }}.xlsx" } }),
                ],
            ),
            Kind::Copy,
        ),
        (
            def(
                types::MOVE,
                "移動・名前の変更",
                "Moves or renames a file or folder to `to` (the full new path). Fails with FILE_EXISTS unless `overwrite` is true. Output: the new path.",
                object_schema(
                    json!({ "from": path, "to": path, "overwrite": flag }),
                    &["from", "to"],
                ),
                RiskLevel::Interactive,
                vec![ResourceDef::file("from"), ResourceDef::file("to")],
                vec![
                    json!({ "type": types::MOVE, "params": { "from": "{{ file.path }}", "to": "{{ pathJoin('C:\\\\work\\\\done', file.name) }}" } }),
                ],
            ),
            Kind::Move,
        ),
        (
            def(
                types::DELETE,
                "削除",
                "Deletes a file, or a folder (a folder with contents needs `recursive: true`). Not moved to the Recycle Bin. A path that does not exist is not an error. Output: whether something was deleted.",
                object_schema(json!({ "path": path, "recursive": flag }), &["path"]),
                RiskLevel::Dangerous,
                vec![ResourceDef::file("path")],
                vec![json!({ "type": types::DELETE, "params": { "path": "work/{{ name }}.csv" } })],
            ),
            Kind::Delete,
        ),
        (
            def(
                types::CREATE_FOLDER,
                "フォルダーを作成",
                "Creates a folder and any missing parent folders; an existing folder is fine. Output: the path.",
                object_schema(json!({ "path": folder }), &["path"]),
                RiskLevel::Interactive,
                vec![],
                vec![
                    json!({ "type": types::CREATE_FOLDER, "params": { "path": "output/{{ formatDate(today(), 'yyyyMM') }}" } }),
                ],
            ),
            Kind::CreateFolder,
        ),
        (
            def(
                types::ZIP,
                "zip に圧縮",
                "Compresses a file or folder (or a list of them) into the zip file `to`. Fails with FILE_EXISTS unless `overwrite` is true. Output: the zip path.",
                object_schema(
                    json!({
                        "from": { "oneOf": [path, { "type": "array", "items": path, "minItems": 1 }] },
                        "to": path,
                        "overwrite": flag,
                    }),
                    &["from", "to"],
                ),
                RiskLevel::Interactive,
                vec![ResourceDef::file("to")],
                vec![
                    json!({ "type": types::ZIP, "params": { "from": "output", "to": "work/output.zip" } }),
                ],
            ),
            Kind::Zip,
        ),
        (
            def(
                types::UNZIP,
                "zip を展開",
                "Extracts the zip file `path` into the folder `to` (Japanese names from Windows-made zips are read correctly). Fails with FILE_EXISTS before extracting anything if a file would be replaced, unless `overwrite` is true. Output: the extracted file paths.",
                object_schema(
                    json!({ "path": path, "to": folder, "overwrite": flag }),
                    &["path", "to"],
                ),
                RiskLevel::Interactive,
                vec![ResourceDef::file("path")],
                vec![
                    json!({ "type": types::UNZIP, "params": { "path": "input/download.zip", "to": "work/unzipped" }, "saveAs": "files" }),
                ],
            ),
            Kind::Unzip,
        ),
    ]
}

/// Definitions of every `file.*` step.
pub fn definitions() -> Vec<StepTypeDef> {
    step_defs().into_iter().map(|(def, _)| def).collect()
}

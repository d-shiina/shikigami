//! Word document steps (`word.*`) for the SpellSheet Runtime.
//!
//! The steps work on `.docx` files directly, so Word does not need to be
//! installed: `word.fillTemplate` fills `{{ 名前 }}` placeholders (and
//! repeats table rows for lists) to make a new document from a template,
//! `word.readText` reads a document's text. Both lock the files they name,
//! and new documents are written next to the target first and then renamed
//! into place, so a failed step never leaves half a file.

// StepError is the Runtime's handler error type; boxing it here would only
// move the allocation.
#![allow(clippy::result_large_err)]

use std::collections::BTreeSet;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{Map, Value, json};
use spellsheet_core::registry::{RiskLevel, SINGLE_TEMPLATE_PATTERN, StepCategory, StepTypeDef};
use spellsheet_core::resource::{ResourceDef, resource_keys};
use spellsheet_runtime::{
    ActionHandler, ActionInput, Adapter, BoxFuture, RuntimeBuilder, StepError,
};
use tokio_util::sync::CancellationToken;

pub mod docx;
mod pdf;

pub mod types {
    pub const FILL_TEMPLATE: &str = "word.fillTemplate";
    pub const READ_TEXT: &str = "word.readText";
    pub const REPLACE_TEXT: &str = "word.replaceText";
    pub const READ_TABLES: &str = "word.readTables";
    pub const EXPORT_PDF: &str = "word.exportPdf";
}

/// Document file steps; needs nothing installed.
#[derive(Debug, Clone, Default)]
pub struct WordAdapter;

impl WordAdapter {
    pub fn new() -> Self {
        Self
    }
}

impl Adapter for WordAdapter {
    fn name(&self) -> &'static str {
        "word"
    }

    fn install(&self, mut builder: RuntimeBuilder) -> RuntimeBuilder {
        for (def, kind) in step_defs() {
            builder = builder.register(def, WordStep { kind });
        }
        builder
    }

    /// The placeholders of the document `path` and the start of its text,
    /// so an AI client can see what a template expects.
    fn inspect<'a>(
        &'a self,
        _session: &'a str,
        params: Value,
    ) -> BoxFuture<'a, Result<Value, StepError>> {
        Box::pin(async move {
            let path = string(&params, "path")?;
            blocking(move || {
                let parts = read_parts(&path)?;
                let mut names = BTreeSet::new();
                for (_, xml) in &parts {
                    names.extend(docx::names(xml));
                }
                let text: String = body(&parts).chars().take(2_000).collect();
                Ok(json!({ "path": path, "placeholders": names, "text": text }))
            })
            .await
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    FillTemplate,
    ReadText,
    ReplaceText,
    ReadTables,
    ExportPdf,
}

struct WordStep {
    kind: Kind,
}

impl ActionHandler for WordStep {
    fn execute<'a>(&'a self, input: ActionInput) -> BoxFuture<'a, Result<Value, StepError>> {
        let kind = self.kind;
        let params = input.params;
        let cancel = input.cancel;
        let timeout =
            std::time::Duration::from_millis(input.timeout_ms.saturating_sub(1_000).max(1_000));
        Box::pin(async move {
            blocking(move || match kind {
                Kind::ReadText => Ok(Value::String(body(&read_parts(&string(&params, "path")?)?))),
                Kind::ReadTables => read_tables(&params),
                Kind::ExportPdf => pdf::export(&params, timeout, &cancel),
                Kind::ReplaceText => {
                    let lock = target_lock(&params);
                    let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
                    replace_text(&params, &cancel)
                }
                Kind::FillTemplate => {
                    // The Runtime's lock on the target ends with this future,
                    // but a timed-out attempt's file work goes on in the
                    // background: this lock keeps it and the next attempt apart.
                    let lock = target_lock(&params);
                    let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
                    fill_template(&params, &cancel)
                }
            })
            .await
        })
    }
}

/// One lock per target document (by its resource key), held while a
/// `word.fillTemplate` writes it.
fn target_lock(params: &Value) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let key = resource_keys(&[ResourceDef::file("path")], params)
        .pop()
        .unwrap_or_default();
    let mut locks = LOCKS
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    locks.entry(key).or_default().clone()
}

async fn blocking(
    work: impl FnOnce() -> Result<Value, StepError> + Send + 'static,
) -> Result<Value, StepError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| StepError::permanent("INTERNAL", e.to_string()))?
}

fn string(params: &Value, key: &str) -> Result<String, StepError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| StepError::invalid_params(format!("'{key}' is required")))
}

// -- files --------------------------------------------------------------------

/// Parts that hold the document's visible text.
fn is_text_part(name: &str) -> bool {
    name == "word/document.xml"
        || (name.starts_with("word/header") || name.starts_with("word/footer"))
            && name.ends_with(".xml")
}

fn check_format(path: &Path) -> Result<(), StepError> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match ext.as_str() {
        "docx" | "docm" | "dotx" | "dotm" => Ok(()),
        "doc" => Err(StepError::permanent(
            "UNSUPPORTED_FORMAT",
            format!("{} is an old .doc document", path.display()),
        )
        .with_details(json!({ "hint": "word.* steps work on .docx. Ask the user to save the file as .docx (Word: 名前を付けて保存 → Word 文書)." }))),
        _ => Err(StepError::permanent(
            "UNSUPPORTED_FORMAT",
            format!("{} is not a Word document (.docx)", path.display()),
        )
        .with_details(json!({ "hint": "Give the full path of a .docx file, e.g. C:\\work\\請求書テンプレート.docx." }))),
    }
}

fn io_error(path: &Path, e: &std::io::Error) -> StepError {
    match e.kind() {
        std::io::ErrorKind::NotFound => StepError::permanent(
            "FILE_NOT_FOUND",
            format!("{}: {e}", path.display()),
        )
        .with_details(json!({ "path": path.display().to_string(), "hint": "Check the path (use the full path). The folder of a new document must exist." })),
        std::io::ErrorKind::PermissionDenied => in_use(path),
        // Windows reports a file locked by Word as a sharing violation (32).
        _ if matches!(e.raw_os_error(), Some(32 | 33)) => in_use(path),
        _ => StepError::new("FILE_ERROR", format!("{}: {e}", path.display())),
    }
}

fn in_use(path: &Path) -> StepError {
    StepError::new(
        "FILE_IN_USE",
        format!("{} is open in another program (probably Word)", path.display()),
    )
    .with_details(json!({ "path": path.display().to_string(), "hint": "Close the document in Word and run again. The step is retried when it has a retry policy." }))
}

fn unreadable(path: &Path, e: impl std::fmt::Display) -> StepError {
    StepError::permanent(
        "DOCUMENT_UNREADABLE",
        format!("could not read {}: {e}", path.display()),
    )
    .with_details(json!({ "hint": "The file may be damaged or password-protected. Open it in Word and save it again as .docx." }))
}

/// The text parts of a document, in archive order (document first).
fn read_parts(path: &str) -> Result<Vec<(String, String)>, StepError> {
    let file = Path::new(path);
    check_format(file)?;
    let reader = std::fs::File::open(file).map_err(|e| io_error(file, &e))?;
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| unreadable(file, e))?;
    let mut parts = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| unreadable(file, e))?;
        let name = entry.name().map_err(|e| unreadable(file, e))?.into_owned();
        if is_text_part(&name) {
            let mut xml = String::new();
            entry
                .read_to_string(&mut xml)
                .map_err(|e| unreadable(file, e))?;
            parts.push((name, xml));
        }
    }
    if !parts.iter().any(|(name, _)| name == "word/document.xml") {
        return Err(unreadable(file, "word/document.xml is missing"));
    }
    parts.sort_by_key(|(name, _)| name != "word/document.xml");
    Ok(parts)
}

fn body(parts: &[(String, String)]) -> String {
    parts
        .iter()
        .find(|(name, _)| name == "word/document.xml")
        .map(|(_, xml)| docx::plain_text(xml))
        .unwrap_or_default()
}

fn fill_template(params: &Value, cancel: &CancellationToken) -> Result<Value, StepError> {
    let template = string(params, "template")?;
    let path = string(params, "path")?;
    let values: Map<String, Value> = match params.get("values") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(values)) => values.clone(),
        Some(_) => return Err(StepError::invalid_params("'values' must be a record")),
    };
    let source = Path::new(&template);
    let target = Path::new(&path);
    check_format(source)?;
    check_format(target)?;

    let reader = std::fs::File::open(source).map_err(|e| io_error(source, &e))?;
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| unreadable(source, e))?;
    let mut replaced = 0;
    let mut missing = BTreeSet::new();
    let mut filled: Vec<(String, String)> = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| unreadable(source, e))?;
        let name = entry
            .name()
            .map_err(|e| unreadable(source, e))?
            .into_owned();
        if !is_text_part(&name) {
            continue;
        }
        let mut xml = String::new();
        entry
            .read_to_string(&mut xml)
            .map_err(|e| unreadable(source, e))?;
        let (xml, n, gone) = docx::fill_part(&xml, &values);
        replaced += n;
        missing.extend(gone);
        filled.push((name, xml));
    }
    if !missing.is_empty() {
        return Err(StepError::permanent(
            "TEMPLATE_VALUE_MISSING",
            format!("no value for {}", missing.iter().map(|m| format!("{{{{ {m} }}}}")).collect::<Vec<_>>().join(", ")),
        )
        .with_details(json!({
            "missing": missing,
            "hint": "Give every placeholder a text, number, true/false or null in `values` (keys exactly as in the template). A list fills table rows only: put {{ 明細.品名 }} in a table row and pass \"明細\": [ { \"品名\": … } ].",
        })));
    }

    save_document(&mut archive, &filled, target, cancel)?;
    Ok(json!({ "path": path, "replaced": replaced }))
}

/// Saves `parts` (changed text parts) into a copy of `archive` at `target`:
/// written next to it first and then renamed into place, never when the
/// step was stopped meanwhile.
fn save_document(
    archive: &mut zip::ZipArchive<std::fs::File>,
    parts: &[(String, String)],
    target: &Path,
    cancel: &CancellationToken,
) -> Result<(), StepError> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("document.docx");
    let temp = target.with_file_name(format!(
        ".{name}.spellsheet-{}-{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let written = write_document(archive, parts, &temp);
    let result = written.and_then(|()| {
        if cancel.is_cancelled() {
            return Err(StepError::new(
                "CANCELLED",
                "the step was stopped before the document was saved",
            ));
        }
        std::fs::rename(&temp, target).map_err(|e| io_error(target, &e))
    });
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

/// `word.replaceText`: every `find` in the text, headers and footers of
/// `path` becomes `replace`, keeping the formatting; saved in place.
fn replace_text(params: &Value, cancel: &CancellationToken) -> Result<Value, StepError> {
    let path = string(params, "path")?;
    let find = params
        .get("find")
        .and_then(Value::as_str)
        .filter(|f| !f.is_empty())
        .ok_or_else(|| StepError::invalid_params("'find' is required"))?
        .to_owned();
    let with = match params.get("replace") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => spellsheet_core::expr::to_display(other),
    };
    let match_case = params.get("matchCase").and_then(Value::as_bool) != Some(false);
    let file = Path::new(&path);
    check_format(file)?;
    let reader = std::fs::File::open(file).map_err(|e| io_error(file, &e))?;
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| unreadable(file, e))?;
    let mut replaced = 0;
    let mut changed = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| unreadable(file, e))?;
        let name = entry.name().map_err(|e| unreadable(file, e))?.into_owned();
        if !is_text_part(&name) {
            continue;
        }
        let mut xml = String::new();
        entry
            .read_to_string(&mut xml)
            .map_err(|e| unreadable(file, e))?;
        let (xml, n) = docx::replace_text(&xml, &find, &with, match_case);
        if n > 0 {
            replaced += n;
            changed.push((name, xml));
        }
    }
    // Nothing found: the file is left as it was.
    if replaced > 0 {
        save_document(&mut archive, &changed, file, cancel)?;
    }
    Ok(json!({ "path": path, "replaced": replaced }))
}
/// The keys of a table's records: its headings, an empty one named by its
/// column (列3), a repeated one numbered after it with a number no other
/// heading has (名前, 名前, 名前_2 → 名前, 名前_3, 名前_2).
pub(crate) fn heading_keys(names: &[String]) -> Vec<String> {
    let bases: Vec<String> = names
        .iter()
        .enumerate()
        .map(|(i, n)| {
            let n = n.trim().replace('\n', " ");
            if n.is_empty() {
                format!("列{}", i + 1)
            } else {
                n
            }
        })
        .collect();
    let mut taken: HashSet<String> = HashSet::new();
    let mut keys: Vec<String> = Vec::with_capacity(bases.len());
    for (i, base) in bases.iter().enumerate() {
        let mut key = base.clone();
        let mut n = 1;
        while taken.contains(&key) || (key != *base && bases[i + 1..].contains(&key)) {
            n += 1;
            key = format!("{base}_{n}");
        }
        taken.insert(key.clone());
        keys.push(key);
    }
    keys
}

/// `word.readTables`: the tables of the body as rows.
fn read_tables(params: &Value) -> Result<Value, StepError> {
    let path = string(params, "path")?;
    let parts = read_parts(&path)?;
    let xml = &parts[0].1;
    let header = params.get("header").and_then(Value::as_bool) != Some(false);
    let shaped = |rows: Vec<Vec<String>>| -> Value {
        if !header || rows.is_empty() {
            return json!(rows);
        }
        let mut rows = rows.into_iter();
        let names = rows.next().unwrap_or_default();
        let keys = heading_keys(&names);
        Value::Array(
            rows.map(|row| {
                let mut record = Map::new();
                for (i, key) in keys.iter().enumerate() {
                    record.insert(
                        key.clone(),
                        Value::String(row.get(i).cloned().unwrap_or_default()),
                    );
                }
                Value::Object(record)
            })
            .collect(),
        )
    };
    let tables = docx::tables(xml);
    match params.get("table").and_then(Value::as_u64) {
        Some(n) => {
            let count = tables.len();
            let table = usize::try_from(n)
                .ok()
                .filter(|n| *n >= 1)
                .and_then(|n| tables.into_iter().nth(n - 1))
                .ok_or_else(|| {
                    StepError::permanent(
                        "TABLE_NOT_FOUND",
                        format!("{path} has {count} table(s), not a table {n}"),
                    )
                    .with_details(json!({ "tables": count, "hint": "Tables are numbered from 1 in the order they appear. Leave out `table` to read them all." }))
                })?;
            Ok(shaped(table))
        }
        None => Ok(Value::Array(tables.into_iter().map(shaped).collect())),
    }
}

/// Copies the template to `temp` with the filled parts swapped in.
fn write_document(
    archive: &mut zip::ZipArchive<std::fs::File>,
    filled: &[(String, String)],
    temp: &Path,
) -> Result<(), StepError> {
    let file = std::fs::File::create(temp).map_err(|e| io_error(temp, &e))?;
    let mut writer = zip::ZipWriter::new(file);
    let fail = |e: zip::result::ZipError| StepError::new("FILE_ERROR", e.to_string());
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for i in 0..archive.len() {
        let entry = archive.by_index_raw(i).map_err(fail)?;
        let entry_name = entry.name().map_err(fail)?.into_owned();
        match filled.iter().find(|(name, _)| *name == entry_name) {
            Some((name, xml)) => {
                drop(entry);
                writer.start_file(name, options).map_err(fail)?;
                writer
                    .write_all(xml.as_bytes())
                    .map_err(|e| io_error(temp, &e))?;
            }
            None => writer.raw_copy_file(entry).map_err(fail)?,
        }
    }
    writer.finish().map_err(fail)?;
    Ok(())
}

// -- step type definitions ----------------------------------------------------

fn schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

/// Step type definitions with the operation each one performs.
fn step_defs() -> Vec<(StepTypeDef, Kind)> {
    use types::*;
    let path =
        |description: &str| json!({ "type": "string", "minLength": 1, "description": description });
    vec![
        (
            StepTypeDef {
                targets: Vec::new(),
                step_type: FILL_TEMPLATE.into(),
                category: StepCategory::Office,
                label: "Word 差し込み".into(),
                description: "Makes the document `path` from the .docx template `template` (the template is not changed): every {{ 名前 }} in the text, headers and footers is replaced by `values`[名前] (text, number, true/false, null for empty; \\n starts a new line), keeping the formatting of the template. {{ 顧客.氏名 }} reads a field of a record. A table row containing {{ 明細.品名 }} is repeated once per record of the list `values`.明細 (an empty list removes the row). Fails with TEMPLATE_VALUE_MISSING (listing the names) when a placeholder has no value. Output: { path, replaced }.".into(),
                params_schema: schema(
                    json!({
                        "template": path("テンプレートの .docx（フルパス）。{{ 名前 }} を書いておく"),
                        "path": path("作る .docx（フルパス）。あれば上書き"),
                        "values": {
                            "oneOf": [
                                { "type": "object" },
                                { "type": "string", "pattern": SINGLE_TEMPLATE_PATTERN }
                            ],
                            "description": "差し込む値。キーはテンプレートの {{ }} の名前（レコードの変数 \"{{ order }}\" も可）"
                        }
                    }),
                    &["template", "path", "values"],
                ),
                blocks: vec![],
                has_output: true,
                expression_params: vec![],
                binds_variables: vec![],
                risk: RiskLevel::Interactive,
                examples: vec![
                    json!({ "type": FILL_TEMPLATE, "name": "請求書を作る", "params": {
                        "template": "templates/請求書.docx",
                        "path": "output/請求書_{{ 受注.受注番号 }}.docx",
                        "values": { "宛名": "{{ 受注.顧客名 }}", "金額": "{{ 受注.金額 }}", "明細": "{{ 受注.明細 }}" }
                    } }),
                ],
                resources: vec![ResourceDef::file("template"), ResourceDef::file("path")],
                secret_params: vec![],
                default_timeout_ms: None,
                deprecated: None,
                plugin: None,
                path_params: Vec::new(),
            },
            Kind::FillTemplate,
        ),
        (
            StepTypeDef {
                targets: Vec::new(),
                step_type: READ_TEXT.into(),
                category: StepCategory::Office,
                label: "Word 読み取り".into(),
                description: "Output: the body text of the .docx `path`, one paragraph per line (table cells are paragraphs too; tabs and line breaks kept). Headers and footers are not included.".into(),
                params_schema: schema(json!({ "path": path("読む .docx（フルパス）") }), &["path"]),
                blocks: vec![],
                has_output: true,
                expression_params: vec![],
                binds_variables: vec![],
                risk: RiskLevel::Safe,
                examples: vec![
                    json!({ "type": READ_TEXT, "params": { "path": "input/契約書.docx" }, "saveAs": "契約書の本文" }),
                ],
                resources: vec![ResourceDef::file("path")],
                secret_params: vec![],
                default_timeout_ms: None,
                deprecated: None,
                plugin: None,
                path_params: Vec::new(),
            },
            Kind::ReadText,
        ),
        (
            StepTypeDef {
                targets: Vec::new(),
                step_type: REPLACE_TEXT.into(),
                category: StepCategory::Office,
                label: "Word 文字の置換".into(),
                description: "Replaces every `find` in the text, tables, headers and footers of the .docx `path` with `replace` (a template; empty removes it) and saves the document in place, keeping the formatting (the replacement takes the formatting where the found text starts). Matches text Word split over runs too; upper / lower case must match unless `matchCase` is false. Does not change the file when nothing is found. To keep the original, copy it first (file.copy) or use word.fillTemplate. Output: { path, replaced } (how many were replaced).".into(),
                params_schema: schema(
                    json!({
                        "path": path("変える .docx（フルパス）。上書き保存する"),
                        "find": { "type": "string", "minLength": 1, "description": "探す文字" },
                        "replace": { "type": "string", "description": "置き換える文字（空なら消す）" },
                        "matchCase": { "type": "boolean", "description": "大文字と小文字を区別する（既定 true）" }
                    }),
                    &["path", "find", "replace"],
                ),
                blocks: vec![],
                has_output: true,
                expression_params: vec![],
                binds_variables: vec![],
                risk: RiskLevel::Interactive,
                examples: vec![
                    json!({ "type": REPLACE_TEXT, "name": "年度を書き換える", "params": { "path": "output/契約書.docx", "find": "令和7年度", "replace": "令和8年度" } }),
                ],
                resources: vec![ResourceDef::file("path")],
                secret_params: vec![],
                default_timeout_ms: None,
                deprecated: None,
                plugin: None,
                path_params: Vec::new(),
            },
            Kind::ReplaceText,
        ),
        (
            StepTypeDef {
                targets: Vec::new(),
                step_type: READ_TABLES.into(),
                category: StepCategory::Office,
                label: "Word 表の読み取り".into(),
                description: "Reads the tables in the body of the .docx `path`. With `header` (the default) each table is a list of records keyed by its first row (an empty or repeated heading becomes 列1, 名前_2 …); with header: false a list of rows of cell texts. Without `table` the output is a list of all tables in order; with `table` (1 = the first) only that table's rows (TABLE_NOT_FOUND when there is none). A cell's paragraphs are joined with line breaks; a table inside a cell is part of that cell's text.".into(),
                params_schema: schema(
                    json!({
                        "path": path("読む .docx（フルパス）"),
                        "table": { "type": "integer", "minimum": 1, "description": "読む表の番号（1 から。省略するとすべての表）" },
                        "header": { "type": "boolean", "description": "1 行目を見出しにする（既定 true）" }
                    }),
                    &["path"],
                ),
                blocks: vec![],
                has_output: true,
                expression_params: vec![],
                binds_variables: vec![],
                risk: RiskLevel::Safe,
                examples: vec![
                    json!({ "type": READ_TABLES, "name": "見積書の明細を読む", "params": { "path": "input/見積書.docx", "table": 1 }, "saveAs": "明細一覧" }),
                ],
                resources: vec![ResourceDef::file("path")],
                secret_params: vec![],
                default_timeout_ms: None,
                deprecated: None,
                plugin: None,
                path_params: Vec::new(),
            },
            Kind::ReadTables,
        ),
        (
            StepTypeDef {
                targets: Vec::new(),
                step_type: EXPORT_PDF.into(),
                category: StepCategory::Office,
                label: "Word PDF 出力".into(),
                description: "Saves the Word document `path` (.docx, .doc, .rtf) as the PDF `to`, laid out as Word prints it. Opens the file read-only in a hidden Word (changes not yet saved in an open Word are not in the PDF; macros do not run). Fails with FILE_EXISTS when `to` exists unless `overwrite` is true. Needs Windows with desktop Word (WORD_NOT_INSTALLED). Output: { path }.".into(),
                params_schema: schema(
                    json!({
                        "path": path("元の文書（.docx・.doc・.rtf、フルパス）"),
                        "to": path("保存する PDF（フルパス、.pdf）"),
                        "overwrite": { "type": "boolean", "description": "同じ名前のファイルがあれば上書きする（既定 false）" }
                    }),
                    &["path", "to"],
                ),
                blocks: vec![],
                has_output: true,
                expression_params: vec![],
                binds_variables: vec![],
                risk: RiskLevel::Interactive,
                examples: vec![
                    json!({ "type": EXPORT_PDF, "name": "請求書を PDF にする", "params": { "path": "output/請求書.docx", "to": "output/請求書.pdf", "overwrite": true } }),
                ],
                resources: vec![ResourceDef::file("path"), ResourceDef::file("to")],
                secret_params: vec![],
                default_timeout_ms: Some(120_000),
                deprecated: None,
                plugin: None,
                path_params: Vec::new(),
            },
            Kind::ExportPdf,
        ),
    ]
}

/// The step type definitions (for docs and tests).
pub fn definitions() -> Vec<StepTypeDef> {
    step_defs().into_iter().map(|(def, _)| def).collect()
}

#[cfg(test)]
mod tests;

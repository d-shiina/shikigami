//! Word document steps (`word.*`) for the Shikigami Runtime.
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
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Map, Value, json};
use shikigami_core::registry::{RiskLevel, SINGLE_TEMPLATE_PATTERN, StepCategory, StepTypeDef};
use shikigami_core::resource::ResourceDef;
use shikigami_runtime::{
    ActionHandler, ActionInput, Adapter, BoxFuture, RuntimeBuilder, StepError,
};

pub mod docx;

pub mod types {
    pub const FILL_TEMPLATE: &str = "word.fillTemplate";
    pub const READ_TEXT: &str = "word.readText";
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
}

struct WordStep {
    kind: Kind,
}

impl ActionHandler for WordStep {
    fn execute<'a>(&'a self, input: ActionInput) -> BoxFuture<'a, Result<Value, StepError>> {
        let kind = self.kind;
        let params = input.params;
        Box::pin(async move {
            blocking(move || match kind {
                Kind::ReadText => Ok(Value::String(body(&read_parts(&string(&params, "path")?)?))),
                Kind::FillTemplate => fill_template(&params),
            })
            .await
        })
    }
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
        .with_details(json!({ "hint": "Check the path (use the full path). The folder of a new document must exist." })),
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
    .with_details(json!({ "hint": "Close the document in Word and run again. The step is retried when it has a retry policy." }))
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

fn fill_template(params: &Value) -> Result<Value, StepError> {
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
        let xml = docx::expand_rows(&xml, &values, &mut replaced, &mut missing);
        let (xml, n, gone) = docx::fill(&xml, &|name| docx::lookup(&values, name));
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

    static NEXT: AtomicU64 = AtomicU64::new(0);
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("document.docx");
    let temp = target.with_file_name(format!(
        ".{name}.shikigami-{}-{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let written = write_document(&mut archive, &filled, &temp);
    let result =
        written.and_then(|()| std::fs::rename(&temp, target).map_err(|e| io_error(target, &e)));
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result?;
    Ok(json!({ "path": path, "replaced": replaced }))
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
                step_type: FILL_TEMPLATE.into(),
                category: StepCategory::Office,
                label: "Word に差し込む".into(),
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
                        "template": "C:\\work\\請求書テンプレート.docx",
                        "path": "C:\\work\\請求書\\{{ order.受注番号 }}.docx",
                        "values": { "宛名": "{{ order.顧客名 }}", "金額": "{{ order.金額 }}", "明細": "{{ order.明細 }}" }
                    } }),
                ],
                resources: vec![ResourceDef::file("template"), ResourceDef::file("path")],
                secret_params: vec![],
                default_timeout_ms: None,
                deprecated: None,
                plugin: None,
            },
            Kind::FillTemplate,
        ),
        (
            StepTypeDef {
                step_type: READ_TEXT.into(),
                category: StepCategory::Office,
                label: "Word の文章を読む".into(),
                description: "Output: the body text of the .docx `path`, one paragraph per line (table cells are paragraphs too; tabs and line breaks kept). Headers and footers are not included.".into(),
                params_schema: schema(json!({ "path": path("読む .docx（フルパス）") }), &["path"]),
                blocks: vec![],
                has_output: true,
                expression_params: vec![],
                binds_variables: vec![],
                risk: RiskLevel::Safe,
                examples: vec![
                    json!({ "type": READ_TEXT, "params": { "path": "C:\\work\\契約書.docx" }, "saveAs": "contractText" }),
                ],
                resources: vec![ResourceDef::file("path")],
                secret_params: vec![],
                default_timeout_ms: None,
                deprecated: None,
                plugin: None,
            },
            Kind::ReadText,
        ),
    ]
}

/// The step type definitions (for docs and tests).
pub fn definitions() -> Vec<StepTypeDef> {
    step_defs().into_iter().map(|(def, _)| def).collect()
}

#[cfg(test)]
mod tests;

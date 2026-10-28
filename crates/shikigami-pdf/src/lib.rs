//! PDF steps (`pdf.*`) for the Shikigami Runtime. `pdf.readText` reads the
//! text layer of a PDF, page by page; a scanned PDF has none and needs OCR.
//! Picking values out of the text is left to expression functions
//! (`regexFind`, `lines`, …). See docs/pdf.md.

// StepError is the Runtime's handler error type; boxing it here would only
// move the allocation.
#![allow(clippy::result_large_err)]

use std::path::PathBuf;

use pdf_extract::{Document, LoadOptions, OutputError, PlainTextOutput};
use serde_json::{Value, json};
use shikigami_core::registry::{RiskLevel, StepCategory, StepTypeDef};
use shikigami_core::resource::ResourceDef;
use shikigami_core::secret::text_or_secret_schema;
use shikigami_runtime::{
    ActionHandler, ActionInput, Adapter, BoxFuture, RuntimeBuilder, StepError,
};

#[cfg(test)]
mod tests;

pub mod types {
    pub const READ_TEXT: &str = "pdf.readText";
}

/// PDF steps; needs nothing installed.
#[derive(Debug, Clone, Default)]
pub struct PdfAdapter;

impl PdfAdapter {
    pub fn new() -> Self {
        Self
    }
}

impl Adapter for PdfAdapter {
    fn name(&self) -> &'static str {
        "pdf"
    }

    fn install(&self, builder: RuntimeBuilder) -> RuntimeBuilder {
        builder.register(read_text_def(), ReadText)
    }
}

struct ReadText;

impl ActionHandler for ReadText {
    fn execute<'a>(&'a self, input: ActionInput) -> BoxFuture<'a, Result<Value, StepError>> {
        Box::pin(async move {
            let path = match input.params.get("path") {
                Some(Value::String(p)) if !p.trim().is_empty() => PathBuf::from(p),
                _ => return Err(StepError::permanent("INVALID_PARAMS", "'path' is required")),
            };
            let password = match input.params.get("password").filter(|v| !v.is_null()) {
                None => None,
                Some(value) => Some(match input.resolve_secret(value)? {
                    Some(secret) => secret.value,
                    None => shikigami_core::expr::to_display(value),
                }),
            };
            // Parsing is CPU-bound; a malformed file that makes the parser
            // panic ends only this task, reported as PDF_UNREADABLE.
            let shown = path.display().to_string();
            tokio::task::spawn_blocking(move || {
                let bytes = shikigami_files::ops::read_bytes(&path)?;
                read_pages(&bytes, password.as_deref(), &shown)
            })
            .await
            .map_err(|_| unreadable(&input.params, "the PDF could not be parsed"))?
            .map(|pages| json!({ "text": pages.concat(), "pages": pages }))
        })
    }
}

fn unreadable(params: &Value, reason: &str) -> StepError {
    let path = params.get("path").map(shikigami_core::expr::to_display);
    StepError::permanent(
        "PDF_UNREADABLE",
        format!("{}: {reason}", path.unwrap_or_default()),
    )
}

/// The text of every page, in page order.
fn read_pages(bytes: &[u8], password: Option<&str>, shown: &str) -> Result<Vec<String>, StepError> {
    let fail =
        |reason: String| StepError::permanent("PDF_UNREADABLE", format!("{shown}: {reason}"));
    // An empty password opens the many PDFs that only restrict printing or
    // copying (an owner password) without a password to open them.
    let options = LoadOptions::with_password(password.unwrap_or(""));
    let doc = match Document::load_mem_with_options(bytes, options) {
        Ok(doc) => doc,
        Err(pdf_extract::Error::InvalidPassword) => {
            let (code, message) = if password.is_some() {
                ("PDF_WRONG_PASSWORD", "the password does not open this PDF")
            } else {
                (
                    "PDF_PASSWORD_REQUIRED",
                    "this PDF is protected by a password",
                )
            };
            return Err(StepError::permanent(code, format!("{shown}: {message}"))
                .with_details(json!({
                    "hint": "Register the password as a secret and pass it as password: { \"secret\": \"<name>\", \"field\": \"password\" }.",
                })));
        }
        Err(e) => return Err(fail(e.to_string())),
    };
    let pages: Vec<u32> = doc.get_pages().into_keys().collect();
    pages
        .into_iter()
        .map(|number| {
            let mut text = String::new();
            pdf_extract::output_doc_page(&doc, &mut PlainTextOutput::new(&mut text), number)
                .map_err(|e: OutputError| fail(format!("page {number}: {e}")))?;
            Ok(text)
        })
        .collect()
}

fn read_text_def() -> StepTypeDef {
    StepTypeDef {
        step_type: types::READ_TEXT.into(),
        category: StepCategory::File,
        label: "PDF の文字を読む".into(),
        description: "Reads the text of a PDF and outputs { text, pages }: `text` is the whole document, `pages` the text of each page (pages[0] is page 1). Only PDFs with a text layer (made by Word, Excel, a printer driver, a web system, …) have text; a scanned image gives empty text. Pick values out with expression functions such as regexFind(res.text, '請求金額\\\\s*([\\\\d,]+)', 1). A password-protected PDF takes `password`, best as a registered secret.".into(),
        params_schema: json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "minLength": 1, "description": "PDF の絶対パス" },
                "password": text_or_secret_schema("開くためのパスワード。登録済みのシークレット { \"secret\": \"名前\", \"field\": \"password\" } を使う"),
            },
            "required": ["path"],
            "additionalProperties": false,
        }),
        blocks: vec![],
        has_output: true,
        expression_params: vec![],
        binds_variables: vec![],
        risk: RiskLevel::Safe,
        examples: vec![
            json!({ "type": types::READ_TEXT, "params": { "path": "C:\\work\\請求書.pdf" }, "saveAs": "invoice" }),
            json!({ "type": types::READ_TEXT, "params": { "path": "{{ pdfPath }}", "password": { "secret": "請求書PDF", "field": "password" } }, "saveAs": "invoice" }),
        ],
        resources: vec![ResourceDef::file("path")],
        secret_params: vec!["password".into()],
        default_timeout_ms: None,
    }
}

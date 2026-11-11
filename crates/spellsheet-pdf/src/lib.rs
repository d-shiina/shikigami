//! PDF steps (`pdf.*`) for the SpellSheet Runtime. `pdf.readText` reads the
//! text layer of a PDF, page by page; a scanned PDF has none and needs OCR.
//! Picking values out of the text is left to expression functions
//! (`regexFind`, `lines`, …). `pdf.merge`, `pdf.extractPages` and
//! `pdf.split` put pages together into new files. See docs/pdf.md.

// StepError is the Runtime's handler error type; boxing it here would only
// move the allocation.
#![allow(clippy::result_large_err)]

use std::path::{Path, PathBuf};

use pdf_extract::{Document, LoadOptions, OutputError, PlainTextOutput};
use serde_json::{Value, json};
use spellsheet_core::registry::{RiskLevel, StepCategory, StepTypeDef};
use spellsheet_core::resource::ResourceDef;
use spellsheet_core::secret::text_or_secret_schema;
use spellsheet_runtime::{
    ActionHandler, ActionInput, Adapter, BoxFuture, RuntimeBuilder, StepError,
};

mod pages;
#[cfg(test)]
mod tests;

pub mod types {
    pub const READ_TEXT: &str = "pdf.readText";
    pub const MERGE: &str = "pdf.merge";
    pub const EXTRACT_PAGES: &str = "pdf.extractPages";
    pub const SPLIT: &str = "pdf.split";
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

    fn install(&self, mut builder: RuntimeBuilder) -> RuntimeBuilder {
        builder = builder.register(read_text_def(), ReadText);
        for (def, kind) in page_defs() {
            builder = builder.register(def, PageStep { kind });
        }
        builder
    }
}

/// The password param as text: a registered secret or plain text.
fn password(input: &ActionInput) -> Result<Option<String>, StepError> {
    match input.params.get("password").filter(|v| !v.is_null()) {
        None => Ok(None),
        Some(value) => Ok(Some(match input.resolve_secret(value)? {
            Some(secret) => secret.value,
            None => spellsheet_core::expr::to_display(value),
        })),
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
            let password = password(&input)?;
            // Parsing is CPU-bound; a malformed file that makes the parser
            // panic ends only this task, reported as PDF_UNREADABLE.
            let shown = path.display().to_string();
            tokio::task::spawn_blocking(move || {
                let bytes = spellsheet_files::ops::read_bytes(&path)?;
                read_pages(&bytes, password.as_deref(), &shown)
            })
            .await
            .map_err(|_| unreadable(&input.params, "the PDF could not be parsed"))?
            .map(|pages| json!({ "text": pages.concat(), "pages": pages }))
        })
    }
}

fn unreadable(params: &Value, reason: &str) -> StepError {
    let path = params.get("path").map(spellsheet_core::expr::to_display);
    StepError::permanent(
        "PDF_UNREADABLE",
        format!("{}: {reason}", path.unwrap_or_default()),
    )
}

/// Loads a PDF, opening it with `password` when it is protected.
fn load(bytes: &[u8], password: Option<&str>, shown: &str) -> Result<Document, StepError> {
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
        Err(e) => {
            return Err(StepError::permanent(
                "PDF_UNREADABLE",
                format!("{shown}: {e}"),
            ));
        }
    };
    Ok(doc)
}

/// The text of every page, in page order.
fn read_pages(bytes: &[u8], password: Option<&str>, shown: &str) -> Result<Vec<String>, StepError> {
    let fail =
        |reason: String| StepError::permanent("PDF_UNREADABLE", format!("{shown}: {reason}"));
    let doc = load(bytes, password, shown)?;
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
        label: "PDF 読み取り".into(),
        description: "Reads the text of a PDF and outputs { text, pages }: `text` is the whole document, `pages` the text of each page (pages[0] is page 1). Only PDFs with a text layer (made by Word, Excel, a printer driver, a web system, …) have text; a scanned image gives empty text. Pick values out with expression functions such as regexFind(res.text, '請求金額\\\\s*([\\\\d,]+)', 1). A password-protected PDF takes `password`, best as a registered secret.".into(),
        params_schema: json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "minLength": 1, "description": "PDF：フローのフォルダーからの相対パス（例 input/請求書.pdf）か絶対パス" },
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
            json!({ "type": types::READ_TEXT, "params": { "path": "input/請求書.pdf" }, "saveAs": "請求書" }),
            json!({ "type": types::READ_TEXT, "params": { "path": "{{ PDFの場所 }}", "password": { "secret": "請求書PDF", "field": "password" } }, "saveAs": "請求書" }),
        ],
        resources: vec![ResourceDef::file("path")],
        secret_params: vec!["password".into()],
        default_timeout_ms: None,
        deprecated: None,
        plugin: None,
        targets: Vec::new(),
        path_params: Vec::new(),
    }
}

// -- putting pages together ---------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PageKind {
    Merge,
    Extract,
    Split,
}

struct PageStep {
    kind: PageKind,
}

/// What one page step was asked to do, read before any file is touched.
enum PageJob {
    Merge {
        files: Vec<PathBuf>,
        to: PathBuf,
    },
    Extract {
        path: PathBuf,
        pages: String,
        to: PathBuf,
    },
    Split {
        path: PathBuf,
        folder: PathBuf,
        pages_per_file: u32,
    },
}

fn path_param(params: &Value, key: &str) -> Result<PathBuf, StepError> {
    match params.get(key) {
        Some(Value::String(p)) if !p.trim().is_empty() => Ok(PathBuf::from(p.trim())),
        _ => Err(StepError::invalid_params(format!("'{key}' is required"))),
    }
}

fn page_job(kind: PageKind, params: &Value) -> Result<PageJob, StepError> {
    Ok(match kind {
        PageKind::Merge => {
            let files: Vec<PathBuf> = match params.get("files") {
                Some(Value::Array(items)) => items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(PathBuf::from)
                    .collect(),
                _ => Vec::new(),
            };
            if files.is_empty() {
                return Err(StepError::invalid_params("'files' has no PDF").with_details(json!({
                    "hint": "List the PDFs in the order they go into the new file, e.g. [\"input/表紙.pdf\", \"{{ invoice.path }}\"]; a list variable works too: \"{{ pdfs }}\".",
                })));
            }
            PageJob::Merge {
                files,
                to: path_param(params, "to")?,
            }
        }
        PageKind::Extract => PageJob::Extract {
            path: path_param(params, "path")?,
            pages: match params.get("pages") {
                Some(Value::String(s)) if !s.trim().is_empty() => s.trim().to_owned(),
                Some(Value::Number(n)) => n.to_string(),
                _ => return Err(StepError::invalid_params("'pages' is required")),
            },
            to: path_param(params, "to")?,
        },
        PageKind::Split => PageJob::Split {
            path: path_param(params, "path")?,
            folder: path_param(params, "folder")?,
            pages_per_file: match params.get("pagesPerFile") {
                None | Some(Value::Null) => 1,
                Some(v) => v
                    .as_u64()
                    .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
                    .filter(|n| *n >= 1)
                    .and_then(|n| u32::try_from(n).ok())
                    .ok_or_else(|| {
                        StepError::invalid_params(
                            "'pagesPerFile' must be a whole number, 1 or more",
                        )
                    })?,
            },
        },
    })
}

impl ActionHandler for PageStep {
    fn execute<'a>(&'a self, input: ActionInput) -> BoxFuture<'a, Result<Value, StepError>> {
        let kind = self.kind;
        Box::pin(async move {
            let job = page_job(kind, &input.params)?;
            let password = password(&input)?;
            let overwrite = input
                .params
                .get("overwrite")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let cancel = input.cancel.clone();
            // A malformed file that makes the parser panic ends only this task.
            tokio::task::spawn_blocking(move || {
                run_page_job(job, password.as_deref(), overwrite, &cancel)
            })
            .await
            .map_err(|_| StepError::permanent("PDF_UNREADABLE", "the PDF could not be parsed"))?
        })
    }
}

fn open(path: &Path, password: Option<&str>) -> Result<Document, StepError> {
    let bytes = spellsheet_files::ops::read_bytes(path)?;
    load(&bytes, password, &path.display().to_string())
}

fn page_count(doc: &Document) -> u32 {
    u32::try_from(doc.get_pages().len()).unwrap_or(u32::MAX)
}

/// Refuses to replace `to` unless asked to.
fn check_free(to: &Path, overwrite: bool) -> Result<(), StepError> {
    if !overwrite && to.exists() {
        return Err(spellsheet_files::ops::io_error(
            &std::io::Error::from(std::io::ErrorKind::AlreadyExists),
            to,
        ));
    }
    Ok(())
}

fn run_page_job(
    job: PageJob,
    password: Option<&str>,
    overwrite: bool,
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<Value, StepError> {
    use spellsheet_files::ops::write_atomic;
    match job {
        PageJob::Merge { files, to } => {
            check_free(&to, overwrite)?;
            let mut sources = Vec::new();
            for path in &files {
                let doc = open(path, None)?;
                let count = page_count(&doc);
                sources.push(pages::Source {
                    doc,
                    pages: (1..=count).collect(),
                });
            }
            let total: u32 = sources.iter().map(|s| page_count(&s.doc)).sum();
            let bytes = pages::to_bytes(pages::assemble(sources))?;
            write_atomic(&to, &bytes, cancel)?;
            Ok(json!({ "path": to.display().to_string(), "pageCount": total }))
        }
        PageJob::Extract { path, pages, to } => {
            check_free(&to, overwrite)?;
            let doc = open(&path, password)?;
            let chosen = pages::parse_pages(&pages, page_count(&doc))?;
            let count = chosen.len();
            let bytes =
                pages::to_bytes(pages::assemble(vec![pages::Source { doc, pages: chosen }]))?;
            write_atomic(&to, &bytes, cancel)?;
            Ok(json!({ "path": to.display().to_string(), "pageCount": count }))
        }
        PageJob::Split {
            path,
            folder,
            pages_per_file,
        } => {
            let doc = open(&path, password)?;
            let count = page_count(&doc);
            let stem = path
                .file_stem()
                .map_or_else(|| "page".into(), |s| s.to_string_lossy().into_owned());
            let chunks: Vec<Vec<u32>> = (1..=count)
                .collect::<Vec<_>>()
                .chunks(pages_per_file as usize)
                .map(<[u32]>::to_vec)
                .collect();
            let width = chunks.len().to_string().len().max(2);
            let targets: Vec<PathBuf> = (1..=chunks.len())
                .map(|n| folder.join(format!("{stem}_{n:0width$}.pdf")))
                .collect();
            // Nothing is written when any file would be replaced.
            for target in &targets {
                check_free(target, overwrite)?;
            }
            let mut written = Vec::new();
            for (chunk, target) in chunks.into_iter().zip(&targets) {
                let bytes = pages::to_bytes(pages::assemble(vec![pages::Source {
                    doc: doc.clone(),
                    pages: chunk,
                }]))?;
                write_atomic(target, &bytes, cancel)?;
                written.push(target.display().to_string());
            }
            Ok(json!(written))
        }
    }
}

fn page_defs() -> Vec<(StepTypeDef, PageKind)> {
    let pdf_path =
        |description: &str| json!({ "type": "string", "minLength": 1, "description": description });
    let overwrite = json!({ "type": "boolean", "description": "あるファイルを置き換える（既定は FILE_EXISTS で止まる）" });
    let password = text_or_secret_schema(
        "開くためのパスワード。登録済みのシークレット { \"secret\": \"名前\", \"field\": \"password\" } を使う",
    );
    let schema = |properties: Value, required: &[&str]| {
        json!({
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": false,
        })
    };
    let def = |step_type: &str,
               label: &str,
               description: &str,
               params_schema: Value,
               lock: &str,
               paths: &[&str],
               secret: bool,
               examples: Vec<Value>| StepTypeDef {
        step_type: step_type.into(),
        category: StepCategory::File,
        label: label.into(),
        description: description.into(),
        params_schema,
        blocks: vec![],
        has_output: true,
        expression_params: vec![],
        binds_variables: vec![],
        risk: RiskLevel::Interactive,
        examples,
        resources: vec![ResourceDef::file(lock)],
        secret_params: if secret {
            vec!["password".into()]
        } else {
            vec![]
        },
        default_timeout_ms: None,
        deprecated: None,
        plugin: None,
        targets: Vec::new(),
        path_params: paths.iter().map(|p| (*p).into()).collect(),
    };
    const KEPT: &str = "Only the pages and what they show are kept: bookmarks, form fields and links to pages left out are not carried over. A protected PDF is written without its password.";
    vec![
        (
            def(
                types::MERGE,
                "PDF 結合",
                &format!(
                    "Joins PDFs into one new PDF `to`, in the order of `files` (each file's pages in their order). Fails with FILE_EXISTS when `to` exists unless `overwrite` is true. {KEPT} Output: {{ path, pageCount }}."
                ),
                schema(
                    json!({
                        "files": {
                            "type": "array",
                            "items": pdf_path("PDF：フローのフォルダーからの相対パスか絶対パス"),
                            "minItems": 1,
                            "description": "結合する PDF（この順につなぐ）"
                        },
                        "to": pdf_path("作る PDF（例 output/請求書まとめ.pdf）"),
                        "overwrite": overwrite,
                    }),
                    &["files", "to"],
                ),
                "to",
                &["files", "to"],
                false,
                vec![
                    json!({ "type": types::MERGE, "params": { "files": ["input/表紙.pdf", "{{ 請求書.path }}"], "to": "output/請求書一式.pdf" }, "saveAs": "結合したPDF" }),
                ],
            ),
            PageKind::Merge,
        ),
        (
            def(
                types::EXTRACT_PAGES,
                "PDF ページ抽出",
                &format!(
                    "Makes a new PDF `to` from some pages of the PDF `path`. `pages` names them like \"1-3,5\" or \"2-\" (page 2 to the last); page 1 is the first page, and the pages go out in the order written. A page past the end gives PDF_PAGE_OUT_OF_RANGE. Fails with FILE_EXISTS when `to` exists unless `overwrite` is true. {KEPT} Output: {{ path, pageCount }}."
                ),
                schema(
                    json!({
                        "path": pdf_path("PDF：フローのフォルダーからの相対パスか絶対パス"),
                        "pages": { "type": "string", "minLength": 1, "description": "ページ（例 1-3,5 / 2- は 2 ページ目から最後まで）" },
                        "to": pdf_path("作る PDF（例 output/1ページ目.pdf）"),
                        "password": password.clone(),
                        "overwrite": overwrite,
                    }),
                    &["path", "pages", "to"],
                ),
                "to",
                &["path", "to"],
                true,
                vec![
                    json!({ "type": types::EXTRACT_PAGES, "params": { "path": "input/請求書.pdf", "pages": "1", "to": "output/請求書_1枚目.pdf" } }),
                ],
            ),
            PageKind::Extract,
        ),
        (
            def(
                types::SPLIT,
                "PDF 分割",
                &format!(
                    "Splits the PDF `path` into files of `pagesPerFile` pages each (default 1) in the folder `folder` (created if missing), named after it: 請求書_01.pdf, 請求書_02.pdf, …. Fails with FILE_EXISTS before writing anything if a file would be replaced, unless `overwrite` is true. {KEPT} Output: the new files' full paths, in page order."
                ),
                schema(
                    json!({
                        "path": pdf_path("PDF：フローのフォルダーからの相対パスか絶対パス"),
                        "folder": pdf_path("保存先フォルダー（例 work/分割）"),
                        "pagesPerFile": { "type": "integer", "minimum": 1, "description": "1 ファイルあたりのページ数（既定 1）" },
                        "password": password,
                        "overwrite": overwrite,
                    }),
                    &["path", "folder"],
                ),
                "folder",
                &["path", "folder"],
                true,
                vec![
                    json!({ "type": types::SPLIT, "params": { "path": "input/まとめて読み取り.pdf", "folder": "work/分割" }, "saveAs": "ファイル一覧" }),
                ],
            ),
            PageKind::Split,
        ),
    ]
}

/// The step type definitions (for docs and tests).
pub fn definitions() -> Vec<StepTypeDef> {
    let mut defs = vec![read_text_def()];
    defs.extend(page_defs().into_iter().map(|(def, _)| def));
    defs
}

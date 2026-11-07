//! Excel workbook steps (`excel.*`) for the Shikigami Runtime.
//!
//! The steps read and write `.xlsx` / `.xlsm` files directly, so Excel
//! does not need to be installed or running: they are fast, run unattended
//! and in parallel. Each step names its workbook by `path`, which is also
//! its lock: steps on the same workbook take turns, steps on different
//! workbooks run side by side. Writes are saved before the step ends.
//!
//! When the workbook is open in Excel on this PC, the steps work on the
//! open workbook through COM instead (live.rs): reads see what is on the
//! screen, writes go into it and it is saved. Running macros,
//! recalculating, sorting and saving as PDF need Excel itself; those are
//! Windows-only steps on top of COM (see docs/office.md).

// StepError is the Runtime's handler error type; boxing it here would only
// move the allocation.
#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{Value, json};
use shikigami_core::registry::{RiskLevel, SINGLE_TEMPLATE_PATTERN, StepCategory, StepTypeDef};
use shikigami_core::resource::{ResourceDef, resource_keys};
use shikigami_runtime::{
    ActionHandler, ActionInput, Adapter, BoxFuture, RuntimeBuilder, StepError,
};
use tokio_util::sync::CancellationToken;

pub mod a1;
pub mod book;
#[cfg(windows)]
mod com;
pub mod date;
#[cfg(windows)]
mod live;
pub mod macros;
#[cfg(any(windows, test))]
mod shape;
#[cfg(any(windows, test))]
mod table;

use a1::Range;

pub mod types {
    pub const READ_CELL: &str = "excel.readCell";
    pub const WRITE_CELL: &str = "excel.writeCell";
    pub const READ_RANGE: &str = "excel.readRange";
    pub const WRITE_RANGE: &str = "excel.writeRange";
    pub const READ_ROWS: &str = "excel.readRows";
    pub const APPEND_ROWS: &str = "excel.appendRows";
    pub const LIST_SHEETS: &str = "excel.listSheets";
    pub const ADD_SHEET: &str = "excel.addSheet";
    pub const RUN_MACRO: &str = "excel.runMacro";
    pub const RECALCULATE: &str = "excel.recalculate";
    pub const SORT: &str = "excel.sort";
    pub const EXPORT_PDF: &str = "excel.exportPdf";
    pub const FORMAT: &str = "excel.format";
    pub const FILTER: &str = "excel.filter";
    pub const PIVOT: &str = "excel.pivot";
}

/// Workbook file steps; needs nothing installed.
#[derive(Debug, Clone, Default)]
pub struct ExcelAdapter;

impl ExcelAdapter {
    pub fn new() -> Self {
        Self
    }
}

impl Adapter for ExcelAdapter {
    fn name(&self) -> &'static str {
        "excel"
    }

    fn install(&self, mut builder: RuntimeBuilder) -> RuntimeBuilder {
        for (def, kind) in step_defs() {
            builder = builder.register(def, ExcelStep { kind });
        }
        builder
    }

    /// The sheets of the workbook `path` with their used ranges and first
    /// rows, so an AI client can see the layout before writing steps.
    fn inspect<'a>(
        &'a self,
        _session: &'a str,
        params: Value,
    ) -> BoxFuture<'a, Result<Value, StepError>> {
        Box::pin(async move {
            let path = string(&params, "path")?;
            blocking(move || {
                let workbook = book::open(&path)?;
                let date1904 = workbook.date1904();
                let sheets: Vec<Value> = workbook
                    .sheet_collection()
                    .iter()
                    .map(|sheet| {
                        let used = book::used_range(sheet);
                        let preview = used.map(|r| {
                            let end = a1::Cell {
                                column: r.end.column.min(20),
                                row: r.end.row.min(5),
                            };
                            book::read_range(
                                sheet,
                                Range {
                                    start: r.start,
                                    end,
                                },
                                date1904,
                            )
                        });
                        json!({
                            "name": sheet.name(),
                            "usedRange": used.map(Range::name),
                            "firstRows": preview.unwrap_or(json!([])),
                        })
                    })
                    .collect();
                Ok(json!({ "path": path, "sheets": sheets }))
            })
            .await
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    ReadCell,
    WriteCell,
    ReadRange,
    WriteRange,
    ReadRows,
    AppendRows,
    ListSheets,
    AddSheet,
    RunMacro,
    Recalculate,
    Sort,
    ExportPdf,
    Format,
    Filter,
    Pivot,
}

impl Kind {
    /// Steps only Excel itself can do.
    #[cfg_attr(not(windows), allow(dead_code))]
    fn needs_excel(self) -> bool {
        matches!(
            self,
            Kind::Recalculate
                | Kind::Sort
                | Kind::ExportPdf
                | Kind::Format
                | Kind::Filter
                | Kind::Pivot
        )
    }
}

struct ExcelStep {
    kind: Kind,
}

impl ActionHandler for ExcelStep {
    fn execute<'a>(&'a self, input: ActionInput) -> BoxFuture<'a, Result<Value, StepError>> {
        let kind = self.kind;
        let params = input.params;
        let cancel = input.cancel;
        // Excel is ended a little before the Runtime gives up on the step.
        let timeout =
            std::time::Duration::from_millis(input.timeout_ms.saturating_sub(1_000).max(1_000));
        Box::pin(async move {
            blocking(move || {
                // The Runtime's lock on the workbook ends with this future,
                // but a timed-out attempt's file work goes on in the
                // background: this lock keeps it and the next attempt apart.
                let lock = workbook_lock(&params);
                let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
                if kind == Kind::RunMacro {
                    return macros::run(macros::request(&params)?, timeout, &cancel);
                }
                #[cfg(windows)]
                {
                    if kind.needs_excel() {
                        return live::run_excel_only(kind, &params, timeout, &cancel);
                    }
                    let path = string(&params, "path")?;
                    if book::open_in_excel(std::path::Path::new(&path))
                        && let Some(result) = live::try_run(kind, &params, timeout, &cancel)
                    {
                        return result;
                    }
                }
                run_step(kind, &params, &cancel)
            })
            .await
        })
    }
}

/// One lock per workbook file (by its resource key), held while a step
/// works on the file.
fn workbook_lock(params: &Value) -> Arc<Mutex<()>> {
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

/// Saves unless the step was stopped or timed out meanwhile, so an attempt
/// that has already failed never changes the file afterwards.
fn save(
    workbook: &umya_spreadsheet::Workbook,
    path: &str,
    cancel: &CancellationToken,
) -> Result<(), StepError> {
    if cancel.is_cancelled() {
        return Err(StepError::new(
            "CANCELLED",
            "the step was stopped before the workbook was saved",
        ));
    }
    book::save(workbook, path)
}

/// Runs file work off the async threads.
async fn blocking(
    work: impl FnOnce() -> Result<Value, StepError> + Send + 'static,
) -> Result<Value, StepError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| StepError::permanent("INTERNAL", e.to_string()))?
}

fn run_step(kind: Kind, params: &Value, cancel: &CancellationToken) -> Result<Value, StepError> {
    let path = string(params, "path")?;
    let sheet_name = optional_string(params, "sheet")?;
    let sheet_name = sheet_name.as_deref();
    match kind {
        Kind::ListSheets => Ok(json!(book::sheet_names(&book::open(&path)?))),
        Kind::ReadCell => {
            let workbook = book::open(&path)?;
            let cell = book::cell_address(&string(params, "cell")?)?;
            let sheet = book::sheet(&workbook, sheet_name)?;
            Ok(book::read(sheet, cell, workbook.date1904()))
        }
        Kind::ReadRange => {
            let workbook = book::open(&path)?;
            let range = optional_string(params, "range")?
                .map(|r| book::range_address(&r))
                .transpose()?;
            let sheet = book::sheet(&workbook, sheet_name)?;
            match range.or_else(|| book::used_range(sheet)) {
                Some(range) => Ok(book::read_range(sheet, range, workbook.date1904())),
                None => Ok(json!([])),
            }
        }
        Kind::ReadRows => {
            let workbook = book::open(&path)?;
            let sheet = book::sheet(&workbook, sheet_name)?;
            Ok(book::read_rows(
                sheet,
                header_row(params)?,
                workbook.date1904(),
            ))
        }
        Kind::WriteCell => {
            let cell = book::cell_address(&string(params, "cell")?)?;
            let value = params.get("value").cloned().unwrap_or(Value::Null);
            change(&path, sheet_name, cancel, |sheet, date1904| {
                book::write(sheet, cell, &value, date1904).map(|()| Value::Null)
            })
        }
        Kind::WriteRange => {
            let start = book::cell_address(&string(params, "cell")?)?;
            let Some(Value::Array(values)) = params.get("values") else {
                return Err(StepError::invalid_params("'values' must be a list of rows"));
            };
            change(&path, sheet_name, cancel, |sheet, date1904| {
                let range = book::write_range(sheet, start, values, date1904)?;
                Ok(json!({ "range": range.name() }))
            })
        }
        Kind::AppendRows => {
            let header_row = header_row(params)?;
            let Some(Value::Array(rows)) = params.get("rows") else {
                return Err(StepError::invalid_params(
                    "'rows' must be a list of records",
                ));
            };
            change(&path, sheet_name, cancel, |sheet, date1904| {
                book::append_rows(sheet, header_row, rows, date1904)
            })
        }
        Kind::RunMacro => Err(StepError::permanent(
            "INTERNAL",
            "runMacro is run by the handler",
        )),
        Kind::Recalculate
        | Kind::Sort
        | Kind::ExportPdf
        | Kind::Format
        | Kind::Filter
        | Kind::Pivot => Err(StepError::permanent(
            "PLATFORM_UNSUPPORTED",
            "recalculating, sorting, formatting, filtering, pivot tables and saving as PDF need Windows with Excel installed",
        )),
        Kind::AddSheet => {
            let name = string(params, "sheet")?;
            let mut workbook = book::open_or_create(&path, Some(&name))?;
            let created = !std::path::Path::new(&path).exists();
            if book::add_sheet(&mut workbook, &name)? || created {
                save(&workbook, &path, cancel)?;
            }
            Ok(Value::Null)
        }
    }
}

/// Opens (or creates) the workbook, changes one sheet and saves it.
fn change(
    path: &str,
    sheet: Option<&str>,
    cancel: &CancellationToken,
    edit: impl FnOnce(&mut umya_spreadsheet::Worksheet, bool) -> Result<Value, StepError>,
) -> Result<Value, StepError> {
    let mut workbook = book::open_or_create(path, sheet)?;
    let date1904 = workbook.date1904();
    let output = edit(book::sheet_mut(&mut workbook, sheet)?, date1904)?;
    save(&workbook, path, cancel)?;
    Ok(output)
}

fn string(params: &Value, key: &str) -> Result<String, StepError> {
    optional_string(params, key)?
        .ok_or_else(|| StepError::invalid_params(format!("'{key}' is required")))
}

fn optional_string(params: &Value, key: &str) -> Result<Option<String>, StepError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(Value::Number(n)) => Ok(Some(n.to_string())),
        Some(_) => Err(StepError::invalid_params(format!(
            "'{key}' must be a string"
        ))),
    }
}

fn header_row(params: &Value) -> Result<u32, StepError> {
    match params.get("headerRow") {
        None | Some(Value::Null) => Ok(1),
        Some(value) => value
            .as_u64()
            .filter(|n| (1..u64::from(a1::MAX_ROW)).contains(n))
            .map(|n| n as u32)
            .ok_or_else(|| StepError::invalid_params("'headerRow' must be a row number from 1")),
    }
}

/// The column names `excel.readRows` would give with these params (path
/// already resolved), for offering them while the flow is being built.
pub fn read_rows_columns(params: &Value) -> Result<Vec<String>, StepError> {
    let workbook = book::open(&string(params, "path")?)?;
    let sheet = book::sheet(&workbook, optional_string(params, "sheet")?.as_deref())?;
    Ok(
        book::headers(sheet, header_row(params)?, workbook.date1904())
            .into_iter()
            .map(|(_, name)| name)
            .collect(),
    )
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

fn props(extra: Value) -> Value {
    let mut properties = json!({
        "path": { "type": "string", "minLength": 1, "description": "ブック（.xlsx / .xlsm）：フローのフォルダーからの相対パス（例 input/受注.xlsx）か絶対パス（C:\\work\\受注.xlsx）" },
        "sheet": { "type": "string", "minLength": 1, "description": "シート名（完全一致）。省略すると先頭のシート" }
    });
    if let (Value::Object(map), Value::Object(extra)) = (&mut properties, extra) {
        map.extend(extra);
    }
    properties
}

fn cell_value_schema() -> Value {
    json!({
        "description": "セルに入れる値：文字・数値・true/false・null（空にする）・{ \"date\": \"2026-10-28\" }・{ \"formula\": \"SUM(B2:B9)\" }",
        "anyOf": [
            { "type": ["string", "number", "boolean", "null"] },
            {
                "type": "object",
                "properties": { "date": { "type": "string", "minLength": 1 } },
                "required": ["date"],
                "additionalProperties": false
            },
            {
                "type": "object",
                "properties": { "formula": { "type": "string", "minLength": 1 } },
                "required": ["formula"],
                "additionalProperties": false
            }
        ]
    })
}

/// A list written out, or one `{{ variable }}` holding it.
fn list_or_template(items: Value, description: &str) -> Value {
    json!({
        "oneOf": [
            { "type": "array", "items": items },
            { "type": "string", "pattern": SINGLE_TEMPLATE_PATTERN }
        ],
        "description": description
    })
}

struct Def {
    step_type: &'static str,
    kind: Kind,
    label: &'static str,
    description: &'static str,
    params: Value,
    required: &'static [&'static str],
    has_output: bool,
    writes: bool,
    /// Runs code in Excel (macros): dangerous, slower default timeout.
    excel_app: bool,
    /// Needs Excel itself (COM): Windows only, slower default timeout.
    needs_excel: bool,
    /// More path parameters than `path` (files the step writes).
    more_paths: &'static [&'static str],
    examples: Vec<Value>,
}

const PATH: &str = "input/受注.xlsx";

/// Step type definitions with the operation each one performs.
fn step_defs() -> Vec<(StepTypeDef, Kind)> {
    use types::*;
    let header_row = json!({
        "oneOf": [
            { "type": "integer", "minimum": 1 },
            { "type": "string", "pattern": SINGLE_TEMPLATE_PATTERN }
        ],
        "description": "見出しの行番号（既定 1）"
    });
    let defs = vec![
        Def {
            step_type: READ_ROWS,
            kind: Kind::ReadRows,
            label: "表を行ごとに読む",
            description: "Reads the table on `sheet` as a list of records, one per row below the header row `headerRow` (default 1), keyed by the header texts. Each record also has `_row`, its row number, for writing back to the same row (cell \"E{{ row._row }}\"). Empty rows are skipped. Use with control.forEach. Values are text, numbers, true/false, dates as \"2026-10-28\" (\"2026-10-28T09:30:00\" with a time) or null. When the workbook is open in Excel on this PC, reads what is on the screen, unsaved changes included.",
            params: props(json!({ "headerRow": header_row })),
            required: &["path"],
            has_output: true,
            writes: false,
            excel_app: false,
            needs_excel: false,
            more_paths: &[],
            examples: vec![
                json!({ "type": READ_ROWS, "name": "受注一覧を読む", "params": { "path": PATH, "sheet": "受注" }, "saveAs": "orders" }),
                json!({ "type": "control.forEach", "params": { "items": "orders", "itemVar": "order" }, "blocks": { "body": [
                    { "type": WRITE_CELL, "name": "状態を書く", "params": { "path": PATH, "sheet": "受注", "cell": "F{{ order._row }}", "value": "完了" } }
                ] } }),
            ],
        },
        Def {
            step_type: APPEND_ROWS,
            kind: Kind::AppendRows,
            label: "表に行を追加",
            description: "Adds `rows` (records keyed by the header texts of `headerRow`, default 1) below the last row of the table on `sheet`. Keys must match the headers exactly (`_row` is ignored); missing keys leave the cell empty. On a new workbook or empty sheet the header row is written from the records' keys first. Creates the workbook if the file does not exist. Output: { firstRow, count }. When the workbook is open in Excel on this PC, the step writes into the open workbook and saves it (the person's Excel stays open).",
            params: props(json!({
                "rows": list_or_template(json!({ "type": "object" }), "追加する行。見出し名をキーにしたレコードの配列、または {{ 変数 }}"),
                "headerRow": header_row
            })),
            required: &["path", "rows"],
            has_output: true,
            writes: true,
            excel_app: false,
            needs_excel: false,
            more_paths: &[],
            examples: vec![
                json!({ "type": APPEND_ROWS, "name": "結果を 1 行追加", "params": { "path": "output/結果.xlsx", "rows": [ { "受注番号": "{{ order.受注番号 }}", "金額": "{{ order.金額 }}", "受注日": { "date": "{{ order.受注日 }}" } } ] } }),
                json!({ "type": APPEND_ROWS, "params": { "path": "output/結果.xlsx", "sheet": "集計", "rows": "{{ results }}" } }),
            ],
        },
        Def {
            step_type: READ_CELL,
            kind: Kind::ReadCell,
            label: "セルを読む",
            description: "Reads one cell (`cell`, e.g. B3) of `sheet`: text, a number, true/false, a date as \"2026-10-28\", an error such as \"#DIV/0!\", or null when empty. A formula gives the result Excel last calculated. Use saveAs to keep it.",
            params: props(
                json!({ "cell": { "type": "string", "minLength": 2, "description": "セル番地（例 B3）" } }),
            ),
            required: &["path", "cell"],
            has_output: true,
            writes: false,
            excel_app: false,
            needs_excel: false,
            more_paths: &[],
            examples: vec![
                json!({ "type": READ_CELL, "name": "締め日を読む", "params": { "path": PATH, "sheet": "設定", "cell": "B2" }, "saveAs": "closingDate" }),
            ],
        },
        Def {
            step_type: WRITE_CELL,
            kind: Kind::WriteCell,
            label: "セルに書く",
            description: "Puts `value` in `cell` of `sheet` and saves the workbook, keeping the cell's formatting. `value`: text (always stays text), a number, true/false, null to empty the cell, { \"date\": \"2026-10-28\" } for a date, or { \"formula\": \"SUM(B2:B9)\" }. Creates the workbook if the file does not exist. A formula's result is calculated when the workbook is next opened in Excel. When the workbook is open in Excel on this PC, the step writes into the open workbook and saves it (the person's Excel stays open).",
            params: props(json!({
                "cell": { "type": "string", "minLength": 2, "description": "セル番地（例 B3）" },
                "value": cell_value_schema()
            })),
            required: &["path", "cell", "value"],
            has_output: false,
            writes: true,
            excel_app: false,
            needs_excel: false,
            more_paths: &[],
            examples: vec![
                json!({ "type": WRITE_CELL, "name": "処理日を書く", "params": { "path": PATH, "sheet": "受注", "cell": "G{{ order._row }}", "value": { "date": "{{ processedAt }}" } } }),
                json!({ "type": WRITE_CELL, "params": { "path": PATH, "sheet": "集計", "cell": "B10", "value": { "formula": "SUM(B2:B9)" } } }),
            ],
        },
        Def {
            step_type: READ_RANGE,
            kind: Kind::ReadRange,
            label: "範囲を読む",
            description: "Reads `range` (e.g. A1:D20) of `sheet` as a list of rows, each a list of cell values (null for empty cells). Without `range`, reads from A1 to the last cell in use. For tables with a header row, excel.readRows is easier to use.",
            params: props(
                json!({ "range": { "type": "string", "minLength": 2, "description": "範囲（例 A1:D20）。省略すると使われている範囲全体" } }),
            ),
            required: &["path"],
            has_output: true,
            writes: false,
            excel_app: false,
            needs_excel: false,
            more_paths: &[],
            examples: vec![
                json!({ "type": READ_RANGE, "params": { "path": PATH, "sheet": "単価表", "range": "A2:C50" }, "saveAs": "prices" }),
            ],
        },
        Def {
            step_type: WRITE_RANGE,
            kind: Kind::WriteRange,
            label: "範囲に書く",
            description: "Writes `values` (a list of rows, each a list of cell values as in excel.writeCell) with its top-left at `cell`, and saves the workbook. Cells outside `values` are left as they are. Creates the workbook if the file does not exist. Output: { range } written. When the workbook is open in Excel on this PC, the step writes into the open workbook and saves it (the person's Excel stays open).",
            params: props(json!({
                "cell": { "type": "string", "minLength": 2, "description": "書き始める左上のセル（例 A1）" },
                "values": list_or_template(json!({ "type": "array", "items": cell_value_schema() }), "行の配列。各行はセル値の配列、または {{ 変数 }}")
            })),
            required: &["path", "cell", "values"],
            has_output: true,
            writes: true,
            excel_app: false,
            needs_excel: false,
            more_paths: &[],
            examples: vec![
                json!({ "type": WRITE_RANGE, "name": "見出しを書く", "params": { "path": "output/結果.xlsx", "cell": "A1", "values": [["受注番号", "金額", "状態"]] } }),
            ],
        },
        Def {
            step_type: LIST_SHEETS,
            kind: Kind::ListSheets,
            label: "シート一覧",
            description: "Output: the names of the workbook's sheets, in order.",
            params: json!({ "path": props(json!({}))["path"] }),
            required: &["path"],
            has_output: true,
            writes: false,
            excel_app: false,
            needs_excel: false,
            more_paths: &[],
            examples: vec![
                json!({ "type": LIST_SHEETS, "params": { "path": PATH }, "saveAs": "sheets" }),
            ],
        },
        Def {
            step_type: ADD_SHEET,
            kind: Kind::AddSheet,
            label: "シートを追加",
            description: "Adds an empty sheet named `sheet` at the end and saves the workbook; does nothing when a sheet with that name exists, so re-running is safe. Creates the workbook if the file does not exist.",
            params: props(json!({})),
            required: &["path", "sheet"],
            has_output: false,
            writes: true,
            excel_app: false,
            needs_excel: false,
            more_paths: &[],
            examples: vec![
                json!({ "type": ADD_SHEET, "params": { "path": "output/結果.xlsx", "sheet": "{{ month }}月" } }),
            ],
        },
        Def {
            step_type: RUN_MACRO,
            kind: Kind::RunMacro,
            label: "マクロを実行",
            description: "Runs the VBA macro `macro` (e.g. 集計 or Module1.集計; a Function's return value is the output) of the workbook `path` with `args`, in a separate, hidden Excel that never touches the user's open Excel windows, then saves the workbook (`save: false` to discard its changes) and closes it. Needs Windows with desktop Excel; macros must be enabled for the workbook on this PC. Use only for what other excel.* steps cannot do: read and write cells with them. A macro that shows a MsgBox waits forever and is ended at the step's timeoutMs (default 300000).",
            params: json!({
                "path": props(json!({}))["path"],
                "macro": { "type": "string", "minLength": 1, "description": "マクロ名（例 集計、Module1.集計）" },
                "args": { "type": "array", "maxItems": macros::MAX_ARGS, "items": { "type": ["string", "number", "boolean", "null"] }, "description": "マクロの引数（順番どおり）" },
                "save": { "type": "boolean", "description": "実行後にブックを保存する（既定 true）" }
            }),
            required: &["path", "macro"],
            has_output: true,
            writes: true,
            excel_app: true,
            needs_excel: true,
            more_paths: &[],
            examples: vec![
                json!({ "type": RUN_MACRO, "name": "集計マクロを実行", "params": { "path": "templates/集計.xlsm", "macro": "Module1.集計" } }),
                json!({ "type": RUN_MACRO, "params": { "path": "templates/集計.xlsm", "macro": "月次レポート", "args": ["{{ month }}", 2026] }, "saveAs": "result" }),
            ],
        },
        Def {
            step_type: RECALCULATE,
            kind: Kind::Recalculate,
            label: "再計算",
            description: "Has Excel recalculate every formula of the workbook `path` and saves it, so formulas written by excel.writeCell show their results and later reads get them. Uses the workbook open in Excel on this PC when it is open, otherwise a separate, hidden Excel. Needs Windows with desktop Excel.",
            params: json!({ "path": props(json!({}))["path"] }),
            required: &["path"],
            has_output: false,
            writes: true,
            excel_app: false,
            needs_excel: true,
            more_paths: &[],
            examples: vec![
                json!({ "type": RECALCULATE, "name": "数式を計算し直す", "params": { "path": "output/集計.xlsx" } }),
            ],
        },
        Def {
            step_type: SORT,
            kind: Kind::Sort,
            label: "表を並べ替え",
            description: "Sorts the table on `sheet` (header row `headerRow`, default 1, and the rows below it down to the last row in use) by `by`, a list of { column: header text, order: \"asc\" | \"desc\" } (the first is the main key), and saves the workbook. Uses Excel's own sort, so formatting moves with the rows. Uses the workbook open in Excel on this PC when it is open, otherwise a separate, hidden Excel. Needs Windows with desktop Excel. Output: { count } rows sorted.",
            params: props(json!({
                "headerRow": header_row,
                "by": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 64,
                    "items": {
                        "type": "object",
                        "properties": {
                            "column": { "type": "string", "minLength": 1, "description": "見出しの文字（完全一致）" },
                            "order": { "enum": ["asc", "desc"], "description": "asc＝小さい順（既定）、desc＝大きい順" }
                        },
                        "required": ["column"],
                        "additionalProperties": false
                    },
                    "description": "並べ替えの基準（先頭が優先）"
                }
            })),
            required: &["path", "by"],
            has_output: true,
            writes: true,
            excel_app: false,
            needs_excel: true,
            more_paths: &[],
            examples: vec![
                json!({ "type": SORT, "name": "金額の大きい順に並べる", "params": { "path": PATH, "sheet": "受注", "by": [ { "column": "金額", "order": "desc" }, { "column": "受注日" } ] } }),
            ],
        },
        Def {
            step_type: EXPORT_PDF,
            kind: Kind::ExportPdf,
            label: "PDF で保存",
            description: "Saves the workbook `path` (or only `sheet`) as the PDF `to`, laid out as Excel prints it (print area, page setup). Fails with FILE_EXISTS when `to` exists unless `overwrite` is true. Uses the workbook open in Excel on this PC when it is open (what is on the screen), otherwise opens the file read-only in a separate, hidden Excel. Needs Windows with desktop Excel. Output: { path }.",
            params: props(json!({
                "to": { "type": "string", "minLength": 1, "description": "保存する PDF：フローのフォルダーからの相対パス（例 output/請求書.pdf）か絶対パス" },
                "overwrite": { "type": "boolean", "description": "同じ名前のファイルがあれば上書きする（既定 false）" }
            })),
            required: &["path", "to"],
            has_output: true,
            writes: true,
            excel_app: false,
            needs_excel: true,
            more_paths: &["to"],
            examples: vec![
                json!({ "type": EXPORT_PDF, "name": "請求書を PDF にする", "params": { "path": "output/請求書.xlsx", "sheet": "請求書", "to": "output/請求書_{{ customer.コード }}.pdf" } }),
            ],
        },
        Def {
            step_type: FORMAT,
            kind: Kind::Format,
            label: "書式を設定",
            description: "Formats the cells `range` (e.g. \"A1:D1\", \"B2:B100\") on `sheet` and saves the workbook. Give only what to change: `bold`, `italic`, `fontColor` and `fillColor` as \"#RRGGBB\" (`fillColor: null` takes the fill away), `numberFormat` as in Excel (\"#,##0\", \"yyyy/mm/dd\", \"0.0%\"), `align` (left / center / right), `wrapText`, `borders` (true: thin lines around every cell, false: none), `columnWidth` (characters) or `autoFit` (fit the columns to their contents). Uses the workbook open in Excel on this PC when it is open, otherwise a separate, hidden Excel. Needs Windows with desktop Excel.",
            params: props(json!({
                "range": { "type": "string", "minLength": 1, "description": "書式を変えるセル（例 A1:D1、B2:B100）" },
                "bold": { "type": "boolean", "description": "太字" },
                "italic": { "type": "boolean", "description": "斜体" },
                "fontColor": { "type": "string", "pattern": "^#?[0-9A-Fa-f]{6}$", "description": "文字の色（例 #C00000）" },
                "fillColor": { "type": ["string", "null"], "pattern": "^#?[0-9A-Fa-f]{6}$", "description": "塗りつぶしの色（例 #FFF2CC）。null で塗りつぶしなし" },
                "numberFormat": { "type": "string", "minLength": 1, "description": "表示形式（例 #,##0、yyyy/mm/dd、0.0%）" },
                "align": { "enum": ["left", "center", "right"], "description": "横の配置" },
                "wrapText": { "type": "boolean", "description": "折り返して全体を表示する" },
                "borders": { "type": "boolean", "description": "true で各セルに細い罫線、false で罫線なし" },
                "columnWidth": { "type": "number", "minimum": 0, "maximum": 255, "description": "列の幅（文字数）" },
                "autoFit": { "type": "boolean", "description": "列の幅を中身に合わせる" }
            })),
            required: &["path", "range"],
            has_output: false,
            writes: true,
            excel_app: false,
            needs_excel: true,
            more_paths: &[],
            examples: vec![
                json!({ "type": FORMAT, "name": "見出しを太字・水色にする", "params": { "path": PATH, "sheet": "受注", "range": "A1:F1", "bold": true, "fillColor": "#DDEBF7", "align": "center" } }),
                json!({ "type": FORMAT, "name": "金額を 3 桁区切りにする", "params": { "path": PATH, "sheet": "受注", "range": "E2:E1000", "numberFormat": "#,##0", "autoFit": true } }),
            ],
        },
        Def {
            step_type: FILTER,
            kind: Kind::Filter,
            label: "フィルター",
            description: "Sets the filter of the table on `sheet` (header row `headerRow`, default 1), so only the rows whose `column` shows one of `values` stay visible: `filters` is a list of { column: header text, values: [...] }, all of which must hold. Values are matched as Excel shows them (\"1,200\" for a number shown with a separator). `clear: true` shows every row again. Saves the workbook. Uses the workbook open in Excel on this PC when it is open, otherwise a separate, hidden Excel. Needs Windows with desktop Excel. Output: { visible } rows left showing.",
            params: props(json!({
                "headerRow": header_row,
                "filters": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 64,
                    "items": {
                        "type": "object",
                        "properties": {
                            "column": { "type": "string", "minLength": 1, "description": "見出しの文字（完全一致）" },
                            "values": { "type": "array", "minItems": 1, "items": { "type": ["string", "number", "boolean"] }, "description": "表示する値（どれかに一致する行を残す）" }
                        },
                        "required": ["column", "values"],
                        "additionalProperties": false
                    },
                    "description": "絞り込みの条件（すべてを満たす行を残す）"
                },
                "clear": { "type": "boolean", "description": "true で絞り込みを解除してすべての行を表示する" }
            })),
            required: &["path"],
            has_output: true,
            writes: true,
            excel_app: false,
            needs_excel: true,
            more_paths: &[],
            examples: vec![
                json!({ "type": FILTER, "name": "未処理だけ表示する", "params": { "path": PATH, "sheet": "受注", "filters": [ { "column": "状態", "values": ["未処理", "保留"] } ] } }),
                json!({ "type": FILTER, "name": "絞り込みを解除する", "params": { "path": PATH, "sheet": "受注", "clear": true } }),
            ],
        },
        Def {
            step_type: PIVOT,
            kind: Kind::Pivot,
            label: "ピボットテーブル",
            description: "Builds a pivot table from the table on `sheet` (header row `headerRow`, default 1) on a new sheet `toSheet` (SHEET_EXISTS when there is one already), and saves the workbook. `rows` and `columns` are header texts to group by; `values` lists what to total, { column: header text, function: \"sum\" (default) | \"count\" | \"average\" | \"max\" | \"min\" }. Read the result with excel.readRange on `toSheet`. Uses the workbook open in Excel on this PC when it is open, otherwise a separate, hidden Excel. Needs Windows with desktop Excel. Output: { sheet }.",
            params: props(json!({
                "headerRow": header_row,
                "toSheet": { "type": "string", "minLength": 1, "maxLength": 31, "description": "ピボットテーブルを置く新しいシートの名前" },
                "rows": { "type": "array", "items": { "type": "string", "minLength": 1 }, "description": "行に並べる見出し（例 [\"担当\"]）" },
                "columns": { "type": "array", "items": { "type": "string", "minLength": 1 }, "description": "列に並べる見出し（例 [\"月\"]）" },
                "values": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "type": "object",
                        "properties": {
                            "column": { "type": "string", "minLength": 1, "description": "集計する列の見出し" },
                            "function": { "enum": ["sum", "count", "average", "max", "min"], "description": "集計方法（既定 sum）" }
                        },
                        "required": ["column"],
                        "additionalProperties": false
                    },
                    "description": "集計する値"
                }
            })),
            required: &["path", "toSheet", "values"],
            has_output: true,
            writes: true,
            excel_app: false,
            needs_excel: true,
            more_paths: &[],
            examples: vec![
                json!({ "type": PIVOT, "name": "担当ごとの金額を集計する", "params": { "path": PATH, "sheet": "受注", "toSheet": "担当別集計", "rows": ["担当"], "values": [ { "column": "金額", "function": "sum" }, { "column": "受注番号", "function": "count" } ] } }),
            ],
        },
    ];

    defs.into_iter()
        .map(|d| {
            let def = StepTypeDef {
                targets: Vec::new(),
                step_type: d.step_type.into(),
                category: StepCategory::Office,
                label: d.label.into(),
                description: d.description.into(),
                params_schema: schema(d.params, d.required),
                blocks: vec![],
                has_output: d.has_output,
                expression_params: vec![],
                binds_variables: vec![],
                risk: if d.excel_app {
                    RiskLevel::Dangerous
                } else if d.writes {
                    RiskLevel::Interactive
                } else {
                    RiskLevel::Safe
                },
                examples: d.examples,
                // Files the step writes (exportPdf's `to`) are locked too,
                // so two steps never write the same file at once.
                resources: std::iter::once("path")
                    .chain(d.more_paths.iter().copied())
                    .map(ResourceDef::file)
                    .collect(),
                secret_params: vec![],
                default_timeout_ms: d.needs_excel.then_some(300_000),
                deprecated: None,
                plugin: None,
                path_params: std::iter::once("path")
                    .chain(d.more_paths.iter().copied())
                    .map(Into::into)
                    .collect(),
            };
            (def, d.kind)
        })
        .collect()
}

/// The step type definitions (for docs and tests).
pub fn definitions() -> Vec<StepTypeDef> {
    step_defs().into_iter().map(|(def, _)| def).collect()
}

#[cfg(test)]
mod tests;

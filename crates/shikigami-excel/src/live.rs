//! Excel itself, through COM: the workbook a person has open in Excel, and
//! the steps only Excel can do (recalculating, sorting, saving as PDF).
//!
//! - When a workbook is open in the person's Excel, the read and write
//!   steps work on that open workbook instead of the file: reads see what
//!   is on screen (unsaved changes, recalculated formulas), writes go into
//!   it and the workbook is saved. The person's Excel is never closed.
//! - `excel.recalculate`, `excel.sort` and `excel.exportPdf` use the open
//!   workbook too, or else open the file in an Excel of their own (ended
//!   when the step's time is up, like `excel.runMacro`).

use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};
use shikigami_com::{GaveUp, Object, Session, Var, kill_process, run_on_sta};
use shikigami_runtime::StepError;
use tokio_util::sync::CancellationToken;

use crate::a1::{Cell, Range};
use crate::{Kind, book, date, table};

/// `C:\Work\受注.xlsx` and `c:/work/受注.XLSX` name the same workbook.
fn same_file(full_name: &str, path: &Path) -> bool {
    let normal = |s: &str| {
        s.replace('/', "\\")
            .trim_start_matches(r"\\?\")
            .to_lowercase()
    };
    let wanted = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    normal(full_name) == normal(&wanted.to_string_lossy())
}

/// The workbook at `path` among those open in the person's Excel.
fn open_book(path: &Path) -> Result<Option<(Object, Object)>, StepError> {
    let Some(app) = Object::running("Excel.Application") else {
        return Ok(None);
    };
    let books = app.get("Workbooks")?.object("Workbooks")?;
    let count = books.get("Count")?.to_i64().unwrap_or(0);
    for n in 1..=count {
        let book = books.object("Item", vec![Var::i32(n as i32)])?;
        if same_file(&book.get("FullName")?.to_text(), path) {
            return Ok(Some((app, book)));
        }
    }
    Ok(None)
}

fn busy(e: StepError) -> StepError {
    if e.code != "COM_ERROR" {
        return e;
    }
    StepError::new("EXCEL_BUSY", format!("Excel did not take the request: {}", e.message))
        .with_details(json!({ "hint": "Excel may be editing a cell or showing a dialog on the person's screen. Ask them to finish it (Enter or Esc), then run again; the step is retried when it has a retry policy." }))
}

/// Runs a read or write step on the workbook open in Excel. `None` when
/// the workbook is not open in this user's Excel (the step then works on
/// the file as usual).
pub fn try_run(
    kind: Kind,
    params: &Value,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Option<Result<Value, StepError>> {
    let params = params.clone();
    let result = run_on_sta(
        "shikigami-excel-live",
        timeout,
        cancel,
        move |session| {
            let path = crate::string(&params, "path")?;
            let Some((_app, book)) = open_book(Path::new(&path))? else {
                return Ok(None);
            };
            step(kind, &params, &book, session).map(Some).map_err(busy)
        },
        |gave_up| {
            match gave_up.reason {
            GaveUp::Cancelled => StepError::new("CANCELLED", "the step was stopped"),
            GaveUp::TimedOut => StepError::new("EXCEL_TIMEOUT", "Excel did not answer in time")
                .with_details(json!({ "hint": "Excel may be showing a dialog or editing a cell on the person's screen. Ask them to check the Excel window, then run again." })),
        }
        },
    );
    match result {
        Ok(None) => None,
        Ok(Some(value)) => Some(Ok(value)),
        Err(e) => Some(Err(e)),
    }
}

fn sheet(book: &Object, name: Option<&str>) -> Result<Object, StepError> {
    let sheets = book.get("Worksheets")?.object("Worksheets")?;
    match name {
        None => sheets.object("Item", vec![Var::i32(1)]),
        Some(name) => sheets.object("Item", vec![Var::str(name)]).map_err(|_| {
            StepError::permanent("SHEET_NOT_FOUND", format!("there is no sheet named '{name}'"))
                .with_details(json!({
                    "sheets": sheet_names(book).unwrap_or_default(),
                    "hint": "Use one of `sheets` (exact name), omit `sheet` for the first sheet, or add the sheet first with excel.addSheet.",
                }))
        }),
    }
}

fn sheet_names(book: &Object) -> Result<Vec<String>, StepError> {
    let sheets = book.get("Worksheets")?.object("Worksheets")?;
    let count = sheets.get("Count")?.to_i64().unwrap_or(0);
    (1..=count)
        .map(|n| {
            sheets
                .object("Item", vec![Var::i32(n as i32)])?
                .get("Name")
                .map(|v| v.to_text())
        })
        .collect()
}

/// Excel's error values as they show in a cell.
fn error_text(code: i32) -> &'static str {
    match code {
        2000 => "#NULL!",
        2007 => "#DIV/0!",
        2015 => "#VALUE!",
        2023 => "#REF!",
        2029 => "#NAME?",
        2036 => "#NUM!",
        2042 => "#N/A",
        _ => "#ERROR",
    }
}

/// A cell as the file steps give it, from its `Value` (which tells dates
/// apart) and its `Value2` (numbers at full precision: `Value` turns
/// currency-formatted numbers into Currency, four decimals only).
fn value(var: &Var, raw: &Var) -> Value {
    if let Some(code) = var.error_code() {
        return json!(error_text(code));
    }
    if var.is_date() {
        let serial = var.to_f64().unwrap_or(0.0);
        let kind = if serial < 1.0 {
            date::Kind::Time
        } else if serial.fract() == 0.0 {
            date::Kind::Date
        } else {
            date::Kind::DateTime
        };
        return date::to_text(serial, kind, false).map_or(Value::Null, Value::String);
    }
    match raw.to_json() {
        Value::String(s) if s.is_empty() => Value::Null,
        other => other,
    }
}

fn cells(sheet: &Object, range: Range) -> Result<Object, StepError> {
    let corner = |cell: Cell| {
        sheet.object(
            "Cells",
            vec![Var::i32(cell.row as i32), Var::i32(cell.column as i32)],
        )
    };
    sheet.object(
        "Range",
        vec![
            Var::from_object(&corner(range.start)?),
            Var::from_object(&corner(range.end)?),
        ],
    )
}

/// From A1 to the last cell in use (`None` for an empty sheet).
fn used(sheet: &Object) -> Result<Option<Range>, StepError> {
    let used = sheet.get("UsedRange")?.object("UsedRange")?;
    let row = used.get("Row")?.to_i64()? as u32;
    let column = used.get("Column")?.to_i64()? as u32;
    let rows = used.get("Rows")?.object("Rows")?.get("Count")?.to_i64()? as u32;
    let columns = used
        .get("Columns")?
        .object("Columns")?
        .get("Count")?
        .to_i64()? as u32;
    let end = Cell {
        column: column + columns - 1,
        row: row + rows - 1,
    };
    if end == (Cell { column: 1, row: 1 }) && used.get("Value")?.to_json().is_null() {
        return Ok(None);
    }
    Ok(Some(Range {
        start: Cell { column: 1, row: 1 },
        end,
    }))
}

fn grid(sheet: &Object, range: Option<Range>) -> Result<Vec<Vec<Value>>, StepError> {
    let Some(range) = range else {
        return Ok(Vec::new());
    };
    let range = cells(sheet, range)?;
    let values = range.get("Value")?.to_grid();
    let raw = range.get("Value2")?.to_grid();
    Ok(values
        .iter()
        .zip(&raw)
        .map(|(row, raw)| row.iter().zip(raw).map(|(v, r)| value(v, r)).collect())
        .collect())
}

/// `grid` for finding the last row in use: a formula whose result is ""
/// still holds its cell (as on the file), so it shows as its formula.
fn occupied_grid(sheet: &Object, range: Option<Range>) -> Result<Vec<Vec<Value>>, StepError> {
    let mut values = grid(sheet, range)?;
    let Some(range) = range else {
        return Ok(values);
    };
    let formulas = cells(sheet, range)?.get("Formula")?.to_grid();
    for (row, formulas) in values.iter_mut().zip(&formulas) {
        for (value, formula) in row.iter_mut().zip(formulas) {
            if value.is_null()
                && let Value::String(formula) = formula.to_json()
                && formula.starts_with('=')
            {
                *value = Value::String(formula);
            }
        }
    }
    Ok(values)
}

/// Puts `value` in a cell with the same rules as the file steps: text stays
/// text, `{ "date": … }` and `{ "formula": … }`, null empties the cell.
fn write(sheet: &Object, cell: Cell, value: &Value, date1904: bool) -> Result<(), StepError> {
    let target = sheet.object(
        "Cells",
        vec![Var::i32(cell.row as i32), Var::i32(cell.column as i32)],
    )?;
    match value {
        Value::Null => {
            target.call("ClearContents", vec![])?;
        }
        Value::Bool(_) | Value::Number(_) => target.put("Value2", Var::from_json(value)?)?,
        Value::String(s) => {
            // A leading ' keeps 001 and 2026-10-28 as text, as on the file.
            let text_format = target.get("NumberFormat")?.to_text() == "@";
            let text = if text_format {
                s.clone()
            } else {
                format!("'{s}")
            };
            target.put("Value2", Var::str(&text))?;
        }
        Value::Object(map) if map.len() == 1 => {
            if let Some(Value::String(formula)) = map.get("formula") {
                let formula = formula.trim();
                let formula = formula.strip_prefix('=').unwrap_or(formula);
                target.put("Formula", Var::str(&format!("={formula}")))?;
            } else if let Some(Value::String(text)) = map.get("date") {
                let (serial, has_time) = date::from_text(text, date1904).ok_or_else(|| {
                    StepError::permanent("INVALID_DATE", format!("'{text}' is not a date"))
                        .with_details(json!({ "hint": "Write dates as { \"date\": \"2026-10-28\" } or { \"date\": \"2026-10-28T09:30:00\" }." }))
                })?;
                let format = target.get("NumberFormat")?.to_text();
                if date::format_kind(0, &format).is_none() {
                    target.put(
                        "NumberFormat",
                        Var::str(if has_time {
                            "yyyy/mm/dd hh:mm:ss"
                        } else {
                            "yyyy/mm/dd"
                        }),
                    )?;
                }
                target.put("Value2", Var::f64(serial))?;
            } else {
                return Err(invalid(value));
            }
        }
        _ => return Err(invalid(value)),
    }
    Ok(())
}

fn invalid(value: &Value) -> StepError {
    StepError::permanent("INVALID_VALUE", format!("cannot put {value} in a cell"))
        .with_details(json!({ "hint": "A cell value is text, a number, true/false, null (empties the cell), { \"date\": \"2026-10-28\" } or { \"formula\": \"SUM(B2:B9)\" }." }))
}

/// Fails as `write` would, without touching the workbook.
fn check_value(value: &Value) -> Result<(), StepError> {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => Ok(()),
        Value::Object(map) if map.len() == 1 => match (map.get("formula"), map.get("date")) {
            (Some(Value::String(_)), _) => Ok(()),
            (_, Some(Value::String(text))) => date::from_text(text, false)
                .map(drop)
                .ok_or_else(|| {
                    StepError::permanent("INVALID_DATE", format!("'{text}' is not a date"))
                        .with_details(json!({ "hint": "Write dates as { \"date\": \"2026-10-28\" } or { \"date\": \"2026-10-28T09:30:00\" }." }))
                }),
            _ => Err(invalid(value)),
        },
        _ => Err(invalid(value)),
    }
}

fn write_all(sheet: &Object, writes: &[(Cell, Value)], session: &Session) -> Result<(), StepError> {
    session.check()?;
    // Check every value before the first cell changes: the open workbook
    // keeps whatever was written before a failure.
    for (_, value) in writes {
        check_value(value)?;
    }
    // Dates are serials counted from the workbook's own start (1900 or 1904).
    let date1904 = sheet
        .get("Parent")?
        .object("Parent")?
        .get("Date1904")?
        .to_bool();
    for (cell, value) in writes {
        // Stop as soon as the step is given up on, so a retry or the next
        // step never races with writes still going into the open workbook.
        session.check()?;
        write(sheet, *cell, value, date1904)?;
    }
    Ok(())
}

/// Refuses a read-only workbook before anything in it changes: Excel lets
/// a read-only workbook be edited, it only cannot save it.
fn writable(book: &Object) -> Result<(), StepError> {
    if book.get("ReadOnly")?.to_bool() {
        return Err(StepError::permanent(
            "WORKBOOK_READ_ONLY",
            "the workbook is open read-only in Excel, so it cannot be changed",
        )
        .with_details(json!({ "hint": "Ask the user to open the workbook for editing (or close it) and run again." })));
    }
    Ok(())
}

fn save(book: &Object, session: &Session) -> Result<(), StepError> {
    session.check()?;
    writable(book)?;
    book.call("Save", vec![]).map(drop)
}

fn step(kind: Kind, params: &Value, book: &Object, session: &Session) -> Result<Value, StepError> {
    if matches!(
        kind,
        Kind::WriteCell | Kind::WriteRange | Kind::AppendRows | Kind::AddSheet
    ) {
        writable(book)?;
    }
    let sheet_name = crate::optional_string(params, "sheet")?;
    let sheet_name = sheet_name.as_deref();
    match kind {
        Kind::ListSheets => Ok(json!(sheet_names(book)?)),
        Kind::ReadCell => {
            let cell = book::cell_address(&crate::string(params, "cell")?)?;
            let sheet = sheet(book, sheet_name)?;
            let target = sheet.object(
                "Cells",
                vec![Var::i32(cell.row as i32), Var::i32(cell.column as i32)],
            )?;
            Ok(value(&target.get("Value")?, &target.get("Value2")?))
        }
        Kind::ReadRange => {
            let sheet = sheet(book, sheet_name)?;
            let range = match crate::optional_string(params, "range")? {
                Some(r) => Some(book::range_address(&r)?),
                None => used(&sheet)?,
            };
            Ok(json!(grid(&sheet, range)?))
        }
        Kind::ReadRows => {
            let sheet = sheet(book, sheet_name)?;
            Ok(table::rows(
                &grid(&sheet, used(&sheet)?)?,
                crate::header_row(params)?,
            ))
        }
        Kind::WriteCell => {
            let cell = book::cell_address(&crate::string(params, "cell")?)?;
            let value = params.get("value").cloned().unwrap_or(Value::Null);
            let sheet = sheet(book, sheet_name)?;
            write_all(&sheet, &[(cell, value)], session)?;
            save(book, session)?;
            Ok(Value::Null)
        }
        Kind::WriteRange => {
            let start = book::cell_address(&crate::string(params, "cell")?)?;
            let Some(Value::Array(values)) = params.get("values") else {
                return Err(StepError::invalid_params("'values' must be a list of rows"));
            };
            let writes = table::range_writes(start, values)?;
            let sheet = sheet(book, sheet_name)?;
            write_all(&sheet, &writes, session)?;
            save(book, session)?;
            let end = writes.iter().fold(start, |end, (cell, _)| Cell {
                column: end.column.max(cell.column),
                row: end.row.max(cell.row),
            });
            Ok(json!({ "range": Range { start, end }.name() }))
        }
        Kind::AppendRows => {
            let Some(Value::Array(rows)) = params.get("rows") else {
                return Err(StepError::invalid_params(
                    "'rows' must be a list of records",
                ));
            };
            let sheet = sheet(book, sheet_name)?;
            let plan = table::append(
                &occupied_grid(&sheet, used(&sheet)?)?,
                crate::header_row(params)?,
                rows,
            )?;
            write_all(&sheet, &plan.writes, session)?;
            save(book, session)?;
            Ok(json!({ "firstRow": plan.first_row, "count": plan.count }))
        }
        Kind::AddSheet => {
            let name = crate::string(params, "sheet")?;
            if sheet_names(book)?.contains(&name) {
                return Ok(Value::Null);
            }
            session.check()?;
            let sheets = book.get("Worksheets")?.object("Worksheets")?;
            let count = sheets.get("Count")?.to_i64().unwrap_or(1);
            let last = sheets.object("Item", vec![Var::i32(count as i32)])?;
            let added = sheets.object("Add", vec![Var::missing(), Var::from_object(&last)])?;
            added.put("Name", Var::str(&name)).map_err(|e| {
                let _ = added.call("Delete", vec![]);
                StepError::permanent("INVALID_SHEET_NAME", format!("cannot add sheet '{name}': {}", e.message))
                    .with_details(json!({ "hint": "Sheet names have at most 31 characters and no \\ / ? * [ ] :" }))
            })?;
            save(book, session)?;
            Ok(Value::Null)
        }
        Kind::Recalculate | Kind::Sort | Kind::ExportPdf => work(kind, params, book, session),
        Kind::RunMacro => Err(StepError::permanent(
            "INTERNAL",
            "runMacro has its own Excel",
        )),
    }
}

// -- steps only Excel can do --------------------------------------------------

const XL_ASCENDING: i32 = 1;
const XL_DESCENDING: i32 = 2;
const XL_SORT_ON_VALUES: i32 = 0;
const XL_YES: i32 = 1;
const XL_TYPE_PDF: i32 = 0;

fn work(kind: Kind, params: &Value, book: &Object, session: &Session) -> Result<Value, StepError> {
    if matches!(kind, Kind::Recalculate | Kind::Sort) {
        writable(book)?;
    }
    match kind {
        Kind::Recalculate => {
            session.check()?;
            let app = book.get("Application")?.object("Application")?;
            app.call("CalculateFull", vec![])?;
            save(book, session)?;
            Ok(Value::Null)
        }
        Kind::Sort => {
            let sheet_name = crate::optional_string(params, "sheet")?;
            let sheet = sheet(book, sheet_name.as_deref())?;
            let header_row = crate::header_row(params)?;
            let grid = grid(&sheet, used(&sheet)?)?;
            let by = params
                .get("by")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let keys = table::sort_keys(&grid, header_row, &by)?;
            let Some((first, last_column, last_row)) = table::extent(&grid, header_row) else {
                return Ok(json!({ "count": 0 }));
            };
            session.check()?;
            let sort = sheet.get("Sort")?.object("Sort")?;
            let fields = sort.get("SortFields")?.object("SortFields")?;
            fields.call("Clear", vec![])?;
            for (column, descending) in keys {
                let key = cells(
                    &sheet,
                    Range {
                        start: Cell {
                            column,
                            row: header_row + 1,
                        },
                        end: Cell {
                            column,
                            row: last_row,
                        },
                    },
                )?;
                fields.call(
                    "Add",
                    vec![
                        Var::from_object(&key),
                        Var::i32(XL_SORT_ON_VALUES),
                        Var::i32(if descending {
                            XL_DESCENDING
                        } else {
                            XL_ASCENDING
                        }),
                    ],
                )?;
            }
            let whole = cells(
                &sheet,
                Range {
                    start: Cell {
                        column: first,
                        row: header_row,
                    },
                    end: Cell {
                        column: last_column,
                        row: last_row,
                    },
                },
            )?;
            sort.call("SetRange", vec![Var::from_object(&whole)])?;
            sort.put("Header", Var::i32(XL_YES))?;
            sort.put("MatchCase", Var::bool(false))?;
            sort.call("Apply", vec![])?;
            save(book, session)?;
            Ok(json!({ "count": last_row - header_row }))
        }
        Kind::ExportPdf => {
            let to = crate::string(params, "to")?;
            let overwrite = params
                .get("overwrite")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !overwrite && Path::new(&to).exists() {
                return Err(
                    StepError::permanent("FILE_EXISTS", format!("{to} already exists"))
                        .with_details(json!({ "hint": "Set overwrite: true to replace it." })),
                );
            }
            if let Some(parent) = Path::new(&to)
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
            {
                std::fs::create_dir_all(parent).map_err(|e| {
                    StepError::permanent(
                        "FILE_ERROR",
                        format!("cannot create {}: {e}", parent.display()),
                    )
                })?;
            }
            session.check()?;
            let what = match crate::optional_string(params, "sheet")? {
                Some(name) => sheet(book, Some(&name))?,
                None => book.clone(),
            };
            what.call("ExportAsFixedFormat", vec![Var::i32(XL_TYPE_PDF), Var::str(&to)])
                .map_err(|e| {
                    StepError::permanent("PDF_EXPORT_FAILED", format!("Excel could not save {to} as PDF: {}", e.message))
                        .with_details(json!({ "hint": "Check that the folder can be written to, that the file is not open in a PDF viewer, and that the sheet has something to print." }))
                })?;
            Ok(json!({ "path": to }))
        }
        _ => Err(StepError::permanent("INTERNAL", "not an Excel-only step")),
    }
}

/// `excel.recalculate`, `excel.sort` and `excel.exportPdf`: on the open
/// workbook, or else in an Excel of the step's own.
pub fn run_excel_only(
    kind: Kind,
    params: &Value,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<Value, StepError> {
    if let Some(result) = try_run(kind, params, timeout, cancel) {
        return result;
    }
    let path = crate::string(params, "path")?;
    if !Path::new(&path).is_file() {
        return Err(StepError::permanent(
            "FILE_NOT_FOUND",
            format!("{path} does not exist"),
        ));
    }
    if kind != Kind::ExportPdf && book::open_in_excel(Path::new(&path)) {
        // Open somewhere this Excel cannot reach (another user, another
        // Excel instance): saving would fail or clash.
        return Err(book::in_use(Path::new(&path)));
    }
    let params = params.clone();
    run_on_sta(
        "shikigami-excel-com",
        timeout,
        cancel,
        move |session| {
            let app = Object::create("Excel.Application", || {
                StepError::permanent("EXCEL_NOT_INSTALLED", "Excel is not installed on this PC")
                    .with_details(json!({ "hint": "excel.recalculate, excel.sort and excel.exportPdf need desktop Excel. Reading and writing cells works without it." }))
            })?;
            if let Some(id) = app.window_process() {
                session.report_process(id);
            }
            let result = (|| {
                // These steps run no code of the workbook: Workbooks.Open
                // would otherwise run Workbook_Open of an .xlsm
                // (msoAutomationSecurityForceDisable = 3).
                app.put("AutomationSecurity", Var::i32(3))?;
                app.put("DisplayAlerts", Var::bool(false))?;
                let _ = app.put("AskToUpdateLinks", Var::bool(false));
                let books = app.get("Workbooks")?.object("Workbooks")?;
                // Workbooks.Open(Filename, UpdateLinks:=0, ReadOnly)
                let read_only = kind == Kind::ExportPdf;
                let book = books.object(
                    "Open",
                    vec![Var::str(&path), Var::i32(0), Var::bool(read_only)],
                )?;
                let result = work(kind, &params, &book, session);
                let _ = book.call("Close", vec![Var::bool(false)]);
                result
            })();
            let _ = app.call("Quit", vec![]);
            result
        },
        |gave_up| {
            if let Some(pid) = gave_up.pid {
                kill_process(pid);
            }
            match gave_up.reason {
                GaveUp::Cancelled => StepError::new(
                    "CANCELLED",
                    "the step was stopped; Excel was closed without saving",
                ),
                GaveUp::TimedOut => StepError::new(
                    "EXCEL_TIMEOUT",
                    "Excel did not finish in time; it was closed without saving",
                )
                .with_details(json!({ "hint": "A large workbook may need a longer timeoutMs." })),
            }
        },
    )
}

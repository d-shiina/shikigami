//! Excel itself, through COM: the workbook a person has open in Excel, and
//! the steps only Excel can do (recalculating, sorting, saving as PDF).
//!
//! - When a workbook is open in the person's Excel, the read and write
//!   steps work on that open workbook instead of the file: reads see what
//!   is on screen (unsaved changes, recalculated formulas), writes go into
//!   it and the workbook is saved. The person's Excel is never closed.
//! - `excel.recalculate`, `excel.sort`, `excel.format`, `excel.filter`,
//!   `excel.pivot` and `excel.exportPdf` use the open workbook too, or else
//!   open the file in an Excel of their own (ended when the step's time is
//!   up, like `excel.runMacro`).

use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};
use spellsheet_com::{GaveUp, Object, Session, Var, kill_process, run_on_sta};
use spellsheet_runtime::StepError;
use tokio_util::sync::CancellationToken;

use crate::a1::{Cell, Range};
use crate::{Kind, book, date, shape, table};

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

static LIVE: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
        "spellsheet-excel-live",
        timeout,
        cancel,
        move |session| {
            let path = crate::string(&params, "path")?;
            // EnableEvents belongs to the whole Excel, not the workbook: one
            // live step at a time, held by this worker until it really ends
            // (even after the step was given up on), so no step ever puts
            // events back on while another is still writing.
            let _one_at_a_time = LIVE
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let Some((app, book)) = open_book(Path::new(&path))? else {
                return Ok(None);
            };
            // The workbook's event code (Worksheet_Change, BeforeSave) does
            // not run for these steps, as it would not on the file; the
            // person's setting is put back afterwards.
            let events = app.get("EnableEvents").map_err(busy)?.to_bool();
            app.put("EnableEvents", Var::bool(false)).map_err(busy)?;
            let result = step(kind, &params, &book, session).map(Some).map_err(busy);
            if events {
                let _ = app.put("EnableEvents", Var::bool(true));
            }
            result
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
/// `format` gives the cell's number format, asked only for dates: the
/// format, not the serial, says date or date and time (midnight shows
/// as 00:00:00 when the format has a time), as on the file.
fn value(var: &Var, raw: &Var, format: impl FnOnce() -> Option<String>) -> Value {
    if let Some(code) = var.error_code() {
        return json!(error_text(code));
    }
    if var.is_date() {
        let serial = var.to_f64().unwrap_or(0.0);
        let kind = if let Some(kind) = format().and_then(|f| date::format_kind(0, &f)) {
            kind
        } else if serial < 1.0 {
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

fn number_format(sheet: &Object, cell: Cell) -> Option<String> {
    let target = sheet
        .object(
            "Cells",
            vec![Var::i32(cell.row as i32), Var::i32(cell.column as i32)],
        )
        .ok()?;
    Some(target.get("NumberFormat").ok()?.to_text())
}

fn grid(sheet: &Object, range: Option<Range>) -> Result<Vec<Vec<Value>>, StepError> {
    let Some(range) = range else {
        return Ok(Vec::new());
    };
    let start = range.start;
    let range = cells(sheet, range)?;
    let values = range.get("Value")?.to_grid();
    let raw = range.get("Value2")?.to_grid();
    Ok(values
        .iter()
        .zip(&raw)
        .enumerate()
        .map(|(r, (row, raw))| {
            row.iter()
                .zip(raw)
                .enumerate()
                .map(|(c, (v, raw))| {
                    value(v, raw, || {
                        number_format(
                            sheet,
                            Cell {
                                column: start.column + c as u32,
                                row: start.row + r as u32,
                            },
                        )
                    })
                })
                .collect()
        })
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
        Kind::WriteCell
            | Kind::WriteRange
            | Kind::AppendRows
            | Kind::AddSheet
            | Kind::InsertRows
            | Kind::DeleteRows
            | Kind::ClearRange
            | Kind::DeleteSheet
            | Kind::RenameSheet
            | Kind::CopySheet
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
            Ok(value(&target.get("Value")?, &target.get("Value2")?, || {
                number_format(&sheet, cell)
            }))
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
            session.check()?;
            let added = sheets.object("Add", vec![Var::missing(), Var::from_object(&last)])?;
            added.put("Name", Var::str(&name)).map_err(|e| {
                let _ = added.call("Delete", vec![]);
                StepError::permanent("INVALID_SHEET_NAME", format!("cannot add sheet '{name}': {}", e.message))
                    .with_details(json!({ "hint": "Sheet names have at most 31 characters and no \\ / ? * [ ] :" }))
            })?;
            save(book, session)?;
            Ok(Value::Null)
        }
        Kind::InsertRows | Kind::DeleteRows => {
            let row = crate::sheets::row_number(params, "row", None)?;
            let count = crate::sheets::row_number(params, "count", Some(1))?;
            let sheet = sheet(book, sheet_name)?;
            let last = row.saturating_add(count - 1).min(crate::a1::MAX_ROW);
            session.check()?;
            let rows = sheet.object("Range", vec![Var::str(&format!("{row}:{last}"))])?;
            rows.call(
                if kind == Kind::InsertRows {
                    "Insert"
                } else {
                    "Delete"
                },
                vec![],
            )?;
            save(book, session)?;
            Ok(Value::Null)
        }
        Kind::ClearRange => {
            let range = book::range_address(&crate::string(params, "range")?)?;
            let sheet = sheet(book, sheet_name)?;
            session.check()?;
            cells(&sheet, range)?.call("ClearContents", vec![])?;
            save(book, session)?;
            Ok(Value::Null)
        }
        Kind::DeleteSheet => {
            let name = crate::string(params, "sheet")?;
            let names = sheet_names(book)?;
            if !names.contains(&name) {
                return Ok(Value::Null);
            }
            if names.len() == 1 {
                return Err(StepError::permanent(
                    "LAST_SHEET",
                    format!("'{name}' is the only sheet, and a workbook needs one"),
                ));
            }
            session.check()?;
            discard_sheet(book, &sheet(book, Some(&name))?);
            if sheet_names(book)?.contains(&name) {
                return Err(StepError::permanent(
                    "SHEET_NOT_DELETED",
                    format!("Excel did not delete the sheet '{name}'"),
                )
                .with_details(json!({ "hint": "The workbook structure may be protected (Review > Protect Workbook)." })));
            }
            save(book, session)?;
            Ok(Value::Null)
        }
        Kind::RenameSheet | Kind::CopySheet => {
            let from = crate::string(params, "sheet")?;
            let to = crate::string(params, "name")?;
            crate::sheets::check_name(&to)?;
            let names = sheet_names(book)?;
            if kind == Kind::RenameSheet && !names.contains(&from) && names.contains(&to) {
                return Ok(Value::Null);
            }
            if from == to && kind == Kind::RenameSheet {
                return sheet(book, Some(&from)).map(|_| Value::Null);
            }
            let source = sheet(book, Some(&from))?;
            if names
                .iter()
                .any(|n| n.to_lowercase() == to.to_lowercase() && *n != from)
            {
                return Err(StepError::permanent(
                    "SHEET_EXISTS",
                    format!("there is already a sheet named '{to}'"),
                ));
            }
            session.check()?;
            let target = if kind == Kind::CopySheet {
                // Worksheet.Copy(Before, After): the copy comes right after.
                source.call("Copy", vec![Var::missing(), Var::from_object(&source)])?;
                let index = source.get("Index")?.to_i64()?;
                book.get("Sheets")?
                    .object("Sheets")?
                    .object("Item", vec![Var::i32(index as i32 + 1)])?
            } else {
                source
            };
            target.put("Name", Var::str(&to))?;
            save(book, session)?;
            Ok(Value::Null)
        }
        Kind::Recalculate
        | Kind::Sort
        | Kind::ExportPdf
        | Kind::Format
        | Kind::Filter
        | Kind::Pivot
        | Kind::SaveAs => work(kind, params, book, session),
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
const XL_NONE: i32 = -4142;
const XL_CONTINUOUS: i32 = 1;
const XL_THIN: i32 = 2;
const XL_FILTER_VALUES: i32 = 7;
const XL_CELL_TYPE_VISIBLE: i32 = 12;
const XL_DATABASE: i32 = 1;
const XL_ROW_FIELD: i32 = 1;
const XL_COLUMN_FIELD: i32 = 2;

/// The table (Format as Table, a ListObject) whose cells include `cell`.
fn list_object(sheet: &Object, cell: Cell) -> Option<Object> {
    sheet
        .object(
            "Cells",
            vec![Var::i32(cell.row as i32), Var::i32(cell.column as i32)],
        )
        .ok()?
        .get("ListObject")
        .ok()
        .and_then(|v| v.object("ListObject").ok())
}

/// The header row and the rows below it, by the header texts: (headers,
/// whole range). `EMPTY_TABLE` when the header row is empty.
fn header_table(sheet: &Object, header_row: u32) -> Result<(Vec<(u32, String)>, Range), StepError> {
    let grid = grid(sheet, used(sheet)?)?;
    let headers = table::headers(&grid, header_row);
    let (Some((first, _)), Some((last_column, _))) = (headers.first(), headers.last()) else {
        return Err(StepError::permanent(
            "EMPTY_TABLE",
            format!("row {header_row} has no headers"),
        )
        .with_details(
            json!({ "hint": "Point `headerRow` at the row that holds the column headers." }),
        ));
    };
    let last_row = table::extent(&grid, header_row).map_or(header_row, |(_, _, row)| row);
    Ok((
        headers.clone(),
        Range {
            start: Cell {
                column: *first,
                row: header_row,
            },
            end: Cell {
                column: *last_column,
                row: last_row,
            },
        },
    ))
}

/// The cells of a table (ListObject): header, body and totals row.
fn table_range(table: &Object) -> Result<Range, StepError> {
    let range = table.get("Range")?.object("Range")?;
    let row = range.get("Row")?.to_i64()? as u32;
    let column = range.get("Column")?.to_i64()? as u32;
    let rows = range.get("Rows")?.object("Rows")?.get("Count")?.to_i64()? as u32;
    let columns = range
        .get("Columns")?
        .object("Columns")?
        .get("Count")?
        .to_i64()? as u32;
    Ok(Range {
        start: Cell { column, row },
        end: Cell {
            column: column + columns - 1,
            row: row + rows - 1,
        },
    })
}

/// The rows of `range` left showing, whatever columns are hidden: the
/// distinct rows of its visible cells, area by area.
fn visible_rows(range: &Object) -> Result<usize, StepError> {
    let Ok(cells) = range.object("SpecialCells", vec![Var::i32(XL_CELL_TYPE_VISIBLE)]) else {
        // Nothing visible at all.
        return Ok(0);
    };
    let areas = cells.get("Areas")?.object("Areas")?;
    let mut rows = std::collections::BTreeSet::new();
    for n in 1..=areas.get("Count")?.to_i64()? {
        let area = areas.object("Item", vec![Var::i32(n as i32)])?;
        let first = area.get("Row")?.to_i64()?;
        let count = area.get("Rows")?.object("Rows")?.get("Count")?.to_i64()?;
        rows.extend(first..first + count);
    }
    Ok(rows.len())
}

/// Deletes a sheet the step added, without Excel asking about it.
fn discard_sheet(book: &Object, added: &Object) {
    let app = book
        .get("Application")
        .and_then(|v| v.object("Application"));
    let alerts = app
        .as_ref()
        .ok()
        .and_then(|app| app.get("DisplayAlerts").ok())
        .map(|v| v.to_bool());
    if let Ok(app) = &app {
        let _ = app.put("DisplayAlerts", Var::bool(false));
    }
    let _ = added.call("Delete", vec![]);
    if let (Ok(app), Some(alerts)) = (&app, alerts) {
        let _ = app.put("DisplayAlerts", Var::bool(alerts));
    }
}

fn format_cells(params: &Value, book: &Object, session: &Session) -> Result<Value, StepError> {
    let format = shape::format(params)?;
    let sheet_name = crate::optional_string(params, "sheet")?;
    let sheet = sheet(book, sheet_name.as_deref())?;
    let Some(range) = format.range else {
        return Err(StepError::invalid_params("'range' is required"));
    };
    let target = cells(&sheet, range)?;
    session.check()?;
    if format.bold.is_some() || format.italic.is_some() || format.font_color.is_some() {
        let font = target.get("Font")?.object("Font")?;
        if let Some(bold) = format.bold {
            font.put("Bold", Var::bool(bold))?;
        }
        if let Some(italic) = format.italic {
            font.put("Italic", Var::bool(italic))?;
        }
        if let Some(color) = format.font_color {
            font.put("Color", Var::i32(color))?;
        }
    }
    if let Some(fill) = format.fill {
        let interior = target.get("Interior")?.object("Interior")?;
        match fill {
            Some(color) => interior.put("Color", Var::i32(color))?,
            None => interior.put("ColorIndex", Var::i32(XL_NONE))?,
        }
    }
    if let Some(number_format) = &format.number_format {
        target
            .put("NumberFormat", Var::str(number_format))
            .map_err(|e| {
                StepError::permanent(
                    "INVALID_NUMBER_FORMAT",
                    format!("Excel does not take the number format '{number_format}': {}", e.message),
                )
                .with_details(json!({ "hint": "Write it as in Excel's Format Cells > Custom, e.g. #,##0 or yyyy/mm/dd." }))
            })?;
    }
    if let Some(align) = format.align {
        target.put("HorizontalAlignment", Var::i32(align))?;
    }
    if let Some(wrap) = format.wrap {
        target.put("WrapText", Var::bool(wrap))?;
    }
    if let Some(borders) = format.borders {
        // The edges and the lines inside, never the diagonals.
        let all = target.get("Borders")?.object("Borders")?;
        if borders {
            all.put("LineStyle", Var::i32(XL_CONTINUOUS))?;
            all.put("Weight", Var::i32(XL_THIN))?;
        } else {
            all.put("LineStyle", Var::i32(XL_NONE))?;
        }
    }
    if let Some(width) = format.column_width {
        target
            .get("EntireColumn")?
            .object("EntireColumn")?
            .put("ColumnWidth", Var::f64(width))?;
    }
    if format.auto_fit {
        target
            .get("Columns")?
            .object("Columns")?
            .call("AutoFit", vec![])?;
    }
    save(book, session)?;
    Ok(Value::Null)
}

fn filter(params: &Value, book: &Object, session: &Session) -> Result<Value, StepError> {
    let filters = shape::filters(params)?;
    let sheet_name = crate::optional_string(params, "sheet")?;
    let sheet = sheet(book, sheet_name.as_deref())?;
    let header_row = crate::header_row(params)?;
    let (headers, mut whole) = header_table(&sheet, header_row)?;
    let fields = match &filters {
        None => Vec::new(),
        Some(filters) => filters
            .iter()
            .map(|f| Ok((shape::column(&headers, header_row, &f.column)?, &f.values)))
            .collect::<Result<Vec<_>, StepError>>()?,
    };
    // A table filters through its own AutoFilter, over its own columns.
    let table = list_object(&sheet, whole.start);
    if let Some(table) = &table {
        whole = table_range(table)?;
    }
    let target = cells(&sheet, whole)?;
    session.check()?;
    match &table {
        Some(table) => {
            if let Ok(auto) = table.get("AutoFilter").and_then(|v| v.object("AutoFilter"))
                && auto.get("FilterMode")?.to_bool()
            {
                auto.call("ShowAllData", vec![])?;
            }
        }
        None => {
            // A filter set before (maybe on other cells) goes first.
            if sheet.get("AutoFilterMode")?.to_bool() {
                sheet.put("AutoFilterMode", Var::bool(false))?;
            }
        }
    }
    if filters.is_some() {
        for (column, values) in &fields {
            session.check()?;
            target.call(
                "AutoFilter",
                vec![
                    Var::i32((column - whole.start.column + 1) as i32),
                    Var::str_array(values),
                    Var::i32(XL_FILTER_VALUES),
                ],
            )?;
        }
    }
    let visible = visible_rows(&target)? as i64 - 1;
    // A table's totals row is in its range but is not a record.
    let totals = table
        .as_ref()
        .and_then(|t| t.get("ShowTotals").ok())
        .is_some_and(|v| v.to_bool());
    let visible = if totals { visible - 1 } else { visible };
    save(book, session)?;
    Ok(json!({ "visible": visible.max(0) }))
}

fn pivot(params: &Value, book: &Object, session: &Session) -> Result<Value, StepError> {
    let pivot = shape::pivot(params)?;
    let sheet_name = crate::optional_string(params, "sheet")?;
    let source = sheet(book, sheet_name.as_deref())?;
    let header_row = crate::header_row(params)?;
    let (headers, mut whole) = header_table(&source, header_row)?;
    // A table's totals row is not a record: total only its header and body.
    if let Some(table) = list_object(&source, whole.start) {
        whole = table_range(&table)?;
        if table.get("ShowTotals")?.to_bool() {
            whole.end.row = (whole.end.row - 1).max(whole.start.row);
        }
    }
    if whole.end.row == whole.start.row {
        return Err(StepError::permanent(
            "EMPTY_TABLE",
            format!("there are no rows below the header row {header_row}"),
        ));
    }
    // Fields by their position in the source, not by name: Excel's field
    // names keep spaces and repeats that the header texts here do not.
    let index = |name: &str| {
        shape::column(&headers, header_row, name)
            .map(|column| (column - whole.start.column + 1) as i32)
    };
    let rows = pivot
        .rows
        .iter()
        .map(|n| index(n))
        .collect::<Result<Vec<_>, _>>()?;
    let columns = pivot
        .columns
        .iter()
        .map(|n| index(n))
        .collect::<Result<Vec<_>, _>>()?;
    let values = pivot
        .values
        .iter()
        .map(|(n, function)| Ok((index(n)?, *function)))
        .collect::<Result<Vec<_>, StepError>>()?;
    if sheet_names(book)?.contains(&pivot.to_sheet) {
        return Err(StepError::permanent(
            "SHEET_EXISTS",
            format!("there is already a sheet named '{}'", pivot.to_sheet),
        )
        .with_details(json!({ "hint": "Give `toSheet` a new name; a pivot table is always built on a sheet of its own." })));
    }
    // R1C1 works whatever reference style the person's Excel uses.
    let source_name = source.get("Name")?.to_text().replace('\'', "''");
    let source_data = format!(
        "'{source_name}'!R{}C{}:R{}C{}",
        whole.start.row, whole.start.column, whole.end.row, whole.end.column
    );
    session.check()?;
    let sheets = book.get("Worksheets")?.object("Worksheets")?;
    let count = sheets.get("Count")?.to_i64().unwrap_or(1);
    let last = sheets.object("Item", vec![Var::i32(count as i32)])?;
    session.check()?;
    let added = sheets.object("Add", vec![Var::missing(), Var::from_object(&last)])?;
    let built = (|| {
        added.put("Name", Var::str(&pivot.to_sheet)).map_err(|e| {
            StepError::permanent(
                "INVALID_SHEET_NAME",
                format!("cannot add sheet '{}': {}", pivot.to_sheet, e.message),
            )
            .with_details(
                json!({ "hint": "Sheet names have at most 31 characters and no \\ / ? * [ ] :" }),
            )
        })?;
        session.check()?;
        let cache = book.object("PivotCaches", vec![])?.object(
            "Create",
            vec![Var::i32(XL_DATABASE), Var::str(&source_data)],
        )?;
        let corner = added.object("Range", vec![Var::str("A3")])?;
        let table = cache.object("CreatePivotTable", vec![Var::from_object(&corner)])?;
        let field = |n: i32| table.object("PivotFields", vec![Var::i32(n)]);
        for (fields, orientation) in [(&rows, XL_ROW_FIELD), (&columns, XL_COLUMN_FIELD)] {
            for (i, n) in fields.iter().enumerate() {
                session.check()?;
                let f = field(*n)?;
                f.put("Orientation", Var::i32(orientation))?;
                f.put("Position", Var::i32(i as i32 + 1))?;
            }
        }
        for (n, function) in &values {
            session.check()?;
            table.call(
                "AddDataField",
                vec![
                    Var::from_object(&field(*n)?),
                    Var::missing(),
                    Var::i32(*function),
                ],
            )?;
        }
        Ok::<_, StepError>(())
    })();
    if let Err(e) = built {
        discard_sheet(book, &added);
        return Err(match e.code.as_str() {
            "COM_ERROR" => StepError::permanent(
                "PIVOT_FAILED",
                format!("Excel could not build the pivot table: {}", e.message),
            )
            .with_details(json!({ "hint": "Check that every column of the table has a header and that the header texts are what `rows`, `columns` and `values` name." })),
            _ => e,
        });
    }
    save(book, session)?;
    Ok(json!({ "sheet": pivot.to_sheet }))
}

fn work(kind: Kind, params: &Value, book: &Object, session: &Session) -> Result<Value, StepError> {
    if matches!(
        kind,
        Kind::Recalculate | Kind::Sort | Kind::Format | Kind::Filter | Kind::Pivot
    ) {
        writable(book)?;
    }
    match kind {
        Kind::Recalculate => {
            session.check()?;
            let app = book.get("Application")?.object("Application")?;
            session.check()?;
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
            // A table (Format as Table, a ListObject) is sorted through its
            // own Sort: the sheet's Sort.SetRange refuses ranges in a table.
            let table = sheet
                .object(
                    "Cells",
                    vec![Var::i32(header_row as i32), Var::i32(first as i32)],
                )?
                .get("ListObject")
                .ok()
                .and_then(|v| v.object("ListObject").ok());
            let sort = match &table {
                Some(table) => table.get("Sort")?.object("Sort")?,
                None => sheet.get("Sort")?.object("Sort")?,
            };
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
            if table.is_none() {
                sort.call("SetRange", vec![Var::from_object(&whole)])?;
            }
            sort.put("Header", Var::i32(XL_YES))?;
            // Rows, whatever the person last sorted by (xlTopToBottom).
            sort.put("Orientation", Var::i32(1))?;
            sort.put("MatchCase", Var::bool(false))?;
            // Last chance to stop before the rows move.
            session.check()?;
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
            session.check()?;
            what.call("ExportAsFixedFormat", vec![Var::i32(XL_TYPE_PDF), Var::str(&to)])
                .map_err(|e| {
                    StepError::permanent("PDF_EXPORT_FAILED", format!("Excel could not save {to} as PDF: {}", e.message))
                        .with_details(json!({ "hint": "Check that the folder can be written to, that the file is not open in a PDF viewer, and that the sheet has something to print." }))
                })?;
            Ok(json!({ "path": to }))
        }
        Kind::SaveAs => save_as(params, book, session),
        Kind::Format => format_cells(params, book, session),
        Kind::Filter => filter(params, book, session),
        Kind::Pivot => pivot(params, book, session),
        _ => Err(StepError::permanent("INTERNAL", "not an Excel-only step")),
    }
}

// Workbooks.SaveAs FileFormat values.
const XL_OPEN_XML_WORKBOOK: i32 = 51;
const XL_OPEN_XML_MACRO: i32 = 52;
const XL_BINARY: i32 = 50;
const XL_EXCEL8: i32 = 56;
const XL_CSV: i32 = 6;
const XL_CSV_UTF8: i32 = 62;

/// Where `to` goes, after checking it may be written.
fn output_file(params: &Value) -> Result<String, StepError> {
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
    Ok(to)
}

fn save_as(params: &Value, book: &Object, session: &Session) -> Result<Value, StepError> {
    let to = output_file(params)?;
    let extension = Path::new(&to)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let format = match extension.as_str() {
        "xlsx" => XL_OPEN_XML_WORKBOOK,
        "xlsm" => XL_OPEN_XML_MACRO,
        "xlsb" => XL_BINARY,
        "xls" => XL_EXCEL8,
        "csv" if params.get("encoding").and_then(Value::as_str) == Some("shift_jis") => XL_CSV,
        "csv" => XL_CSV_UTF8,
        "pdf" => return work(Kind::ExportPdf, params, book, session),
        _ => {
            return Err(StepError::permanent(
                "UNSUPPORTED_FORMAT",
                format!("cannot save as .{extension}"),
            )
            .with_details(
                json!({ "hint": "End `to` with .xlsx, .xlsm, .xlsb, .xls, .csv or .pdf." }),
            ));
        }
    };
    // A CSV holds the active sheet.
    let sheet_name = crate::optional_string(params, "sheet")?;
    if format == XL_CSV || format == XL_CSV_UTF8 || sheet_name.is_some() {
        sheet(book, sheet_name.as_deref())?.call("Activate", vec![])?;
    }
    session.check()?;
    // The copy has no password to open it.
    let _ = book.put("Password", Var::str(""));
    let full = std::path::absolute(&to).unwrap_or_else(|_| Path::new(&to).to_path_buf());
    book.call(
        "SaveAs",
        vec![Var::str(&full.to_string_lossy()), Var::i32(format)],
    )
    .map_err(|e| {
        StepError::permanent("SAVE_FAILED", format!("Excel could not save {to}: {}", e.message))
            .with_details(json!({ "hint": "Check that the folder can be written to and that the file is not open in another program. A workbook with macros needs .xlsm (or .xls / .xlsb) to keep them." }))
    })?;
    Ok(json!({ "path": to }))
}

/// The steps only Excel can do: on the open workbook, or else in an Excel
/// of the step's own.
pub fn run_excel_only(
    kind: Kind,
    params: &Value,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<Value, StepError> {
    // Saving a copy works on the file as saved, so the person's open
    // workbook is never switched to the new file.
    if kind != Kind::SaveAs
        && let Some(result) = try_run(kind, params, timeout, cancel)
    {
        return result;
    }
    let path = crate::string(params, "path")?;
    if !Path::new(&path).is_file() {
        return Err(StepError::permanent(
            "FILE_NOT_FOUND",
            format!("{path} does not exist"),
        ));
    }
    let read_only = matches!(kind, Kind::ExportPdf | Kind::SaveAs);
    if !read_only && book::open_in_excel(Path::new(&path)) {
        // Open somewhere this Excel cannot reach (another user, another
        // Excel instance): saving would fail or clash.
        return Err(book::in_use(Path::new(&path)));
    }
    let params = params.clone();
    run_on_sta(
        "spellsheet-excel-com",
        timeout,
        cancel,
        move |session| {
            let app = Object::create("Excel.Application", || {
                StepError::permanent("EXCEL_NOT_INSTALLED", "Excel is not installed on this PC")
                    .with_details(json!({ "hint": "excel.recalculate, excel.sort, excel.format, excel.filter, excel.pivot and excel.exportPdf need desktop Excel. Reading and writing cells works without it." }))
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
                // Workbooks.Open(Filename, UpdateLinks:=0, ReadOnly, Format,
                // Password): a password (even an empty one) keeps Excel from
                // asking for it on a screen nobody may be watching.
                let password = crate::optional_string(&params, "password")?.unwrap_or_default();
                let full =
                    std::path::absolute(&path).unwrap_or_else(|_| Path::new(&path).to_path_buf());
                let book = books
                    .object(
                        "Open",
                        vec![
                            Var::str(&full.to_string_lossy()),
                            Var::i32(0),
                            Var::bool(read_only),
                            Var::missing(),
                            Var::str(&password),
                        ],
                    )
                    .map_err(|e| {
                        StepError::permanent("WORKBOOK_UNREADABLE", format!("Excel could not open {path}: {}", e.message))
                            .with_details(json!({ "hint": "If the workbook has a password to open it, give `password` (a registered secret) to excel.saveAs; check that it is right." }))
                    })?;
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

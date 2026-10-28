//! The workbook operations behind the `excel.*` steps, on the file itself.
//!
//! Every step opens the file, does one thing and (for writes) saves it
//! again before it ends, so a scenario never holds a workbook open and a
//! failed run leaves no half-written file: saving writes a temporary file
//! next to the workbook and renames it over the original.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};
use shikigami_runtime::StepError;
use umya_spreadsheet::{CellRawValue, Workbook, Worksheet};

use crate::a1::{self, Cell, Range};
use crate::date;

/// Key added to each record of `excel.readRows`: the record's row number.
pub const ROW_KEY: &str = "_row";

// -- files --------------------------------------------------------------------

fn check_format(path: &Path) -> Result<(), StepError> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match ext.as_str() {
        "xlsx" | "xlsm" => Ok(()),
        "xls" => Err(StepError::permanent(
            "UNSUPPORTED_FORMAT",
            format!("{} is an old .xls workbook", path.display()),
        )
        .with_details(json!({ "hint": "excel.* steps read and write .xlsx / .xlsm. Ask the user to save the file as .xlsx (Excel: 名前を付けて保存 → Excel ブック)." }))),
        _ => Err(StepError::permanent(
            "UNSUPPORTED_FORMAT",
            format!("{} is not an Excel workbook (.xlsx / .xlsm)", path.display()),
        )
        .with_details(json!({ "hint": "Give the full path of an .xlsx or .xlsm file, e.g. C:\\work\\orders.xlsx." }))),
    }
}

/// Opens an existing workbook.
pub fn open(path: &str) -> Result<Workbook, StepError> {
    let path = Path::new(path);
    check_format(path)?;
    if !path.is_file() {
        return Err(StepError::permanent(
            "FILE_NOT_FOUND",
            format!("{} does not exist", path.display()),
        )
        .with_details(json!({ "hint": "Check the path (use the full path, e.g. C:\\work\\orders.xlsx). Steps that write create a missing workbook; steps that read do not." })));
    }
    umya_spreadsheet::reader::xlsx::read(path).map_err(|e| match e {
        umya_spreadsheet::XlsxError::Io(io) => io_error(path, &io),
        other => StepError::permanent(
            "WORKBOOK_UNREADABLE",
            format!("could not read {}: {other}", path.display()),
        )
        .with_details(json!({ "hint": "The file may be damaged or password-protected. Open it in Excel and save it again as .xlsx." })),
    })
}

/// Opens a workbook to change it, or starts a new one (its first sheet
/// named `sheet`, else Sheet1) when the file does not exist yet.
pub fn open_or_create(path: &str, sheet: Option<&str>) -> Result<Workbook, StepError> {
    let file = Path::new(path);
    check_format(file)?;
    if file.exists() {
        return open(path);
    }
    let mut book = umya_spreadsheet::new_file();
    if let Some(name) = sheet
        && let Ok(first) = book.sheet_mut(0)
    {
        first.set_name(name);
    }
    Ok(book)
}

/// `C:\work\~$orders.xlsx`: the owner file Excel keeps while the workbook is open.
fn owner_file(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?.to_str()?;
    Some(path.with_file_name(format!("~${name}")))
}

fn in_use(path: &Path) -> StepError {
    StepError::new(
        "FILE_IN_USE",
        format!("{} is open in another program (probably Excel)", path.display()),
    )
    .with_details(json!({ "hint": "Close the workbook in Excel and run again. The step is retried when it has a retry policy." }))
}

fn io_error(path: &Path, e: &std::io::Error) -> StepError {
    match e.kind() {
        std::io::ErrorKind::PermissionDenied => in_use(path),
        std::io::ErrorKind::NotFound => StepError::permanent(
            "FILE_NOT_FOUND",
            format!("{}: {e}", path.display()),
        )
        .with_details(json!({ "hint": "Check that the folder exists; steps create the workbook but not its folder." })),
        // Windows reports a file locked by Excel as a sharing violation (32).
        _ if e.raw_os_error() == Some(32) || e.raw_os_error() == Some(33) => in_use(path),
        _ => StepError::new("FILE_ERROR", format!("{}: {e}", path.display())),
    }
}

/// Saves the workbook in place: written next to the file first, then
/// renamed over it, so the original stays intact if anything fails.
pub fn save(book: &Workbook, path: &str) -> Result<(), StepError> {
    let path = Path::new(path);
    if let Some(owner) = owner_file(path)
        && owner.exists()
    {
        return Err(in_use(path));
    }
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("workbook.xlsx");
    let temp = path.with_file_name(format!(".{name}.shikigami-{}.tmp", std::process::id()));
    umya_spreadsheet::writer::xlsx::write(book, &temp).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        match e {
            umya_spreadsheet::XlsxError::Io(io) => io_error(path, &io),
            other => StepError::permanent(
                "WORKBOOK_UNWRITABLE",
                format!("could not write {}: {other}", path.display()),
            ),
        }
    })?;
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        io_error(path, &e)
    })
}

// -- sheets -------------------------------------------------------------------

pub fn sheet_names(book: &Workbook) -> Vec<String> {
    book.sheet_collection()
        .iter()
        .map(|s| s.name().to_owned())
        .collect()
}

fn sheet_not_found(book: &Workbook, name: &str) -> StepError {
    StepError::permanent("SHEET_NOT_FOUND", format!("there is no sheet named '{name}'"))
        .with_details(json!({
            "sheets": sheet_names(book),
            "hint": "Use one of `sheets` (exact name), omit `sheet` for the first sheet, or add the sheet first with excel.addSheet.",
        }))
}

/// The sheet named `name`, or the first sheet.
pub fn sheet<'a>(book: &'a Workbook, name: Option<&str>) -> Result<&'a Worksheet, StepError> {
    match name {
        Some(name) => book
            .sheet_by_name(name)
            .map_err(|_| sheet_not_found(book, name)),
        None => book
            .sheet(0)
            .map_err(|_| StepError::permanent("SHEET_NOT_FOUND", "the workbook has no sheets")),
    }
}

pub fn sheet_mut<'a>(
    book: &'a mut Workbook,
    name: Option<&str>,
) -> Result<&'a mut Worksheet, StepError> {
    let index = match name {
        Some(name) => book
            .sheet_collection()
            .iter()
            .position(|s| s.name() == name)
            .ok_or_else(|| sheet_not_found(book, name))?,
        None => 0,
    };
    book.sheet_mut(index)
        .map_err(|_| StepError::permanent("SHEET_NOT_FOUND", "the workbook has no sheets"))
}

/// Adds a sheet unless one with that name exists. Returns whether it was added.
pub fn add_sheet(book: &mut Workbook, name: &str) -> Result<bool, StepError> {
    if book.sheet_by_name(name).is_ok() {
        return Ok(false);
    }
    book.new_sheet(name).map_err(|e| {
        StepError::permanent(
            "INVALID_SHEET_NAME",
            format!("cannot add sheet '{name}': {e}"),
        )
        .with_details(
            json!({ "hint": "Sheet names have at most 31 characters and no \\ / ? * [ ] :" }),
        )
    })?;
    Ok(true)
}

// -- addresses ----------------------------------------------------------------

pub fn cell_address(text: &str) -> Result<Cell, StepError> {
    Cell::parse(text).ok_or_else(|| {
        StepError::permanent("INVALID_CELL", format!("'{text}' is not a cell address"))
            .with_details(json!({ "hint": "Write a cell like B3 (column letters, then the row number from 1). Build it from a row number with a template: \"E{{ row._row }}\"." }))
    })
}

pub fn range_address(text: &str) -> Result<Range, StepError> {
    Range::parse(text).ok_or_else(|| {
        StepError::permanent("INVALID_RANGE", format!("'{text}' is not a range"))
            .with_details(json!({ "hint": "Write a range like A1:D20, or omit `range` for everything in use on the sheet." }))
    })
}

/// From A1 to the last cell in use (`None` for an empty sheet).
pub fn used_range(sheet: &Worksheet) -> Option<Range> {
    let (column, row) = sheet.highest_column_and_row();
    (column > 0 && row > 0).then_some(Range {
        start: Cell { column: 1, row: 1 },
        end: Cell { column, row },
    })
}

// -- values -------------------------------------------------------------------

fn number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

/// The value shown in a cell: text, a number, true/false, a date as
/// `2026-10-28` (or `2026-10-28T09:30:00` with a time), an error such as
/// `#DIV/0!` as text, or null when empty. Formulas give their last
/// calculated result.
pub fn read(sheet: &Worksheet, cell: Cell, date1904: bool) -> Value {
    let Some(found) = sheet.cell((cell.column, cell.row)) else {
        return Value::Null;
    };
    match found.raw_value() {
        CellRawValue::String(s) | CellRawValue::Lazy(s) => Value::String(s.to_string()),
        CellRawValue::RichText(r) => Value::String(r.text().to_string()),
        CellRawValue::Bool(b) => Value::Bool(*b),
        CellRawValue::Error(e) => Value::String(e.to_string()),
        CellRawValue::Empty => Value::Null,
        CellRawValue::Numeric(n) => {
            let format = found.style().number_format();
            let (id, code) = format.map_or((0, ""), |f| (f.number_format_id(), f.format_code()));
            match date::format_kind(id, code) {
                Some(kind) => date::to_text(*n, kind, date1904).map_or(number(*n), Value::String),
                None => number(*n),
            }
        }
    }
}

fn invalid_value(value: &Value) -> StepError {
    StepError::permanent(
        "INVALID_VALUE",
        format!("cannot put {value} in a cell"),
    )
    .with_details(json!({ "hint": "A cell value is text, a number, true/false, null (empties the cell), { \"date\": \"2026-10-28\" } or { \"formula\": \"SUM(B2:B9)\" }." }))
}

/// Puts `value` in a cell, keeping the cell's formatting. Text stays text
/// (never turned into a number or formula).
pub fn write(
    sheet: &mut Worksheet,
    cell: Cell,
    value: &Value,
    date1904: bool,
) -> Result<(), StepError> {
    let target = sheet.cell_mut((cell.column, cell.row));
    match value {
        Value::Null => {
            target.set_blank();
        }
        Value::Bool(b) => {
            target.set_value_bool(*b);
        }
        Value::Number(n) => {
            target.set_value_number(n.as_f64().ok_or_else(|| invalid_value(value))?);
        }
        Value::String(s) => {
            target.set_value_string(s.as_str());
        }
        Value::Object(map) if map.len() == 1 => {
            if let Some(Value::String(formula)) = map.get("formula") {
                let formula = formula.trim();
                target.set_formula(formula.strip_prefix('=').unwrap_or(formula));
            } else if let Some(Value::String(text)) = map.get("date") {
                let (serial, has_time) = date::from_text(text, date1904).ok_or_else(|| {
                    StepError::permanent("INVALID_DATE", format!("'{text}' is not a date"))
                        .with_details(json!({ "hint": "Write dates as { \"date\": \"2026-10-28\" } or { \"date\": \"2026-10-28T09:30:00\" }." }))
                })?;
                target.set_value_number(serial);
                let style = target.style_mut();
                let current = style
                    .number_format()
                    .map(|f| (f.number_format_id(), f.format_code().to_owned()));
                let is_date =
                    current.is_some_and(|(id, code)| date::format_kind(id, &code).is_some());
                if !is_date {
                    style.number_format_mut().set_format_code(if has_time {
                        "yyyy/mm/dd hh:mm:ss"
                    } else {
                        "yyyy/mm/dd"
                    });
                }
            } else {
                return Err(invalid_value(value));
            }
        }
        _ => return Err(invalid_value(value)),
    }
    Ok(())
}

// -- ranges and rows ----------------------------------------------------------

pub fn read_range(sheet: &Worksheet, range: Range, date1904: bool) -> Value {
    let rows = (range.start.row..=range.end.row)
        .map(|row| {
            let cells = (range.start.column..=range.end.column)
                .map(|column| read(sheet, Cell { column, row }, date1904))
                .collect();
            Value::Array(cells)
        })
        .collect();
    Value::Array(rows)
}

pub fn write_range(
    sheet: &mut Worksheet,
    start: Cell,
    values: &[Value],
    date1904: bool,
) -> Result<Range, StepError> {
    let mut end = start;
    for (r, row) in values.iter().enumerate() {
        let Value::Array(cells) = row else {
            return Err(StepError::permanent(
                "INVALID_VALUES",
                format!("values[{r}] is not a list of cells"),
            )
            .with_details(json!({ "hint": "`values` is a list of rows, each a list of cells: [[\"品番\", \"数量\"], [\"A-1\", 3]]." })));
        };
        for (c, value) in cells.iter().enumerate() {
            let cell = Cell {
                column: start.column + c as u32,
                row: start.row + r as u32,
            };
            if cell.column > a1::MAX_COLUMN || cell.row > a1::MAX_ROW {
                return Err(StepError::permanent(
                    "RANGE_TOO_LARGE",
                    "the values go past the last row or column of a sheet",
                ));
            }
            write(sheet, cell, value, date1904)?;
            end.column = end.column.max(cell.column);
            end.row = end.row.max(cell.row);
        }
    }
    Ok(Range { start, end })
}

/// The table's columns: (column number, header text) for each non-empty
/// header cell. Repeated headers get `_2`, `_3`, ...
pub fn headers(sheet: &Worksheet, header_row: u32, date1904: bool) -> Vec<(u32, String)> {
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for column in 1..=sheet.highest_column() {
        let text = match read(
            sheet,
            Cell {
                column,
                row: header_row,
            },
            date1904,
        ) {
            Value::Null => continue,
            Value::String(s) => s.trim().to_owned(),
            other => other.to_string(),
        };
        if text.is_empty() {
            continue;
        }
        let mut name = text.clone();
        let mut n = 1;
        while seen.contains(&name) {
            n += 1;
            name = format!("{text}_{n}");
        }
        seen.push(name.clone());
        out.push((column, name));
    }
    out
}

/// One record per row below the header row, keyed by header, plus
/// [`ROW_KEY`]. Rows with nothing in the table's columns are skipped.
pub fn read_rows(sheet: &Worksheet, header_row: u32, date1904: bool) -> Value {
    let columns = headers(sheet, header_row, date1904);
    let mut records = Vec::new();
    for row in header_row + 1..=sheet.highest_row() {
        let mut record = Map::new();
        let mut empty = true;
        for (column, name) in &columns {
            let value = read(
                sheet,
                Cell {
                    column: *column,
                    row,
                },
                date1904,
            );
            empty &= value.is_null();
            record.insert(name.clone(), value);
        }
        if !empty {
            record.insert(ROW_KEY.into(), json!(row));
            records.push(Value::Object(record));
        }
    }
    Value::Array(records)
}

/// Last row with a value or formula in the table's columns (the header
/// row if none). A formula not yet calculated still takes its row.
fn last_row(sheet: &Worksheet, columns: &[(u32, String)], header_row: u32) -> u32 {
    (header_row + 1..=sheet.highest_row())
        .rev()
        .find(|row| {
            columns.iter().any(|(column, _)| {
                sheet
                    .cell((*column, *row))
                    .is_some_and(|c| c.is_formula() || !c.raw_value().is_empty())
            })
        })
        .unwrap_or(header_row)
}

/// Adds records below the table. On a sheet without a header row yet, the
/// header row is written from the records' keys first.
pub fn append_rows(
    sheet: &mut Worksheet,
    header_row: u32,
    rows: &[Value],
    date1904: bool,
) -> Result<Value, StepError> {
    let mut records = Vec::with_capacity(rows.len());
    for (i, row) in rows.iter().enumerate() {
        let Value::Object(record) = row else {
            return Err(StepError::permanent(
                "INVALID_ROWS",
                format!("rows[{i}] is not a record"),
            )
            .with_details(json!({ "hint": "`rows` is a list of records keyed by the header row's names: [{ \"品番\": \"A-1\", \"数量\": 3 }]." })));
        };
        records.push(record);
    }

    let mut columns = headers(sheet, header_row, date1904);
    if columns.is_empty() {
        let mut names: Vec<&String> = Vec::new();
        for key in records.iter().flat_map(|r| r.keys()) {
            if key != ROW_KEY && !names.contains(&key) {
                names.push(key);
            }
        }
        for (i, name) in names.iter().enumerate() {
            let column = i as u32 + 1;
            sheet
                .cell_mut((column, header_row))
                .set_value_string(name.as_str());
            columns.push((column, (*name).clone()));
        }
    }

    for (i, record) in records.iter().enumerate() {
        if let Some(key) = record
            .keys()
            .find(|k| *k != ROW_KEY && !columns.iter().any(|(_, name)| name == *k))
        {
            return Err(StepError::permanent(
                "UNKNOWN_COLUMN",
                format!("rows[{i}] has '{key}', which is not in the header row {header_row}"),
            )
            .with_details(json!({
                "columns": columns.iter().map(|(_, name)| name).collect::<Vec<_>>(),
                "hint": "Use the header names in `columns` as keys (exact text), or point `headerRow` at the row that holds the headers.",
            })));
        }
    }

    let first = last_row(sheet, &columns, header_row) + 1;
    if first as usize + records.len() > a1::MAX_ROW as usize + 1 {
        return Err(StepError::permanent(
            "RANGE_TOO_LARGE",
            "the rows go past the last row of the sheet",
        ));
    }
    for (i, record) in records.iter().enumerate() {
        let row = first + i as u32;
        for (column, name) in &columns {
            if let Some(value) = record.get(name) {
                write(
                    sheet,
                    Cell {
                        column: *column,
                        row,
                    },
                    value,
                    date1904,
                )?;
            }
        }
    }
    Ok(json!({ "firstRow": first, "count": records.len() }))
}

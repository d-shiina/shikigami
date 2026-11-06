//! Tables on a grid of cell values (row 1 first, column A first), for the
//! workbook open in Excel: the same rules as `excel.readRows` and
//! `excel.appendRows` on the file (book.rs), worked out before any cell is
//! changed.

use serde_json::{Map, Value, json};
use shikigami_runtime::StepError;

use crate::a1::{self, Cell};
use crate::book::ROW_KEY;

fn at(grid: &[Vec<Value>], row: u32, column: u32) -> &Value {
    grid.get(row as usize - 1)
        .and_then(|cells| cells.get(column as usize - 1))
        .unwrap_or(&Value::Null)
}

fn width(grid: &[Vec<Value>]) -> u32 {
    grid.iter().map(Vec::len).max().unwrap_or(0) as u32
}

/// (column, header) for each non-empty cell of the header row; repeated
/// headers get `_2`, `_3`, ...
pub fn headers(grid: &[Vec<Value>], header_row: u32) -> Vec<(u32, String)> {
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for column in 1..=width(grid) {
        let text = match at(grid, header_row, column) {
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

/// One record per row below the header row (rows empty in the table's
/// columns are skipped), with `_row`.
pub fn rows(grid: &[Vec<Value>], header_row: u32) -> Value {
    let columns = headers(grid, header_row);
    let mut records = Vec::new();
    for row in header_row + 1..=grid.len() as u32 {
        let mut record = Map::new();
        let mut empty = true;
        for (column, name) in &columns {
            let value = at(grid, row, *column).clone();
            empty &= value.is_null() || value == json!("");
            record.insert(name.clone(), value);
        }
        if !empty {
            record.insert(ROW_KEY.into(), json!(row));
            records.push(Value::Object(record));
        }
    }
    Value::Array(records)
}

/// The cells `excel.appendRows` writes, and where the rows start.
#[derive(Debug, PartialEq)]
pub struct Append {
    pub writes: Vec<(Cell, Value)>,
    pub first_row: u32,
    pub count: usize,
}

pub fn append(grid: &[Vec<Value>], header_row: u32, rows: &[Value]) -> Result<Append, StepError> {
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
    let mut writes = Vec::new();
    let mut columns = headers(grid, header_row);
    if columns.is_empty() {
        let mut names: Vec<&String> = Vec::new();
        for key in records.iter().flat_map(|r| r.keys()) {
            if key != ROW_KEY && !names.contains(&key) {
                names.push(key);
            }
        }
        for (i, name) in names.iter().enumerate() {
            let column = i as u32 + 1;
            writes.push((
                Cell {
                    column,
                    row: header_row,
                },
                Value::String((*name).clone()),
            ));
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
    let last = (header_row + 1..=grid.len() as u32)
        .rev()
        .find(|row| {
            columns.iter().any(|(column, _)| {
                let value = at(grid, *row, *column);
                !value.is_null() && *value != json!("")
            })
        })
        .unwrap_or(header_row);
    let first_row = last + 1;
    if first_row as usize + records.len() > a1::MAX_ROW as usize + 1 {
        return Err(StepError::permanent(
            "RANGE_TOO_LARGE",
            "the rows go past the last row of the sheet",
        ));
    }
    for (i, record) in records.iter().enumerate() {
        let row = first_row + i as u32;
        for (column, name) in &columns {
            if let Some(value) = record.get(name) {
                writes.push((
                    Cell {
                        column: *column,
                        row,
                    },
                    value.clone(),
                ));
            }
        }
    }
    Ok(Append {
        writes,
        first_row,
        count: records.len(),
    })
}

/// The cells `excel.writeRange` writes from `start`.
pub fn range_writes(start: Cell, values: &[Value]) -> Result<Vec<(Cell, Value)>, StepError> {
    let mut writes = Vec::new();
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
            writes.push((cell, value.clone()));
        }
    }
    Ok(writes)
}

/// The sort keys of `excel.sort`: (column, descending) for each `by`.
pub fn sort_keys(
    grid: &[Vec<Value>],
    header_row: u32,
    by: &[Value],
) -> Result<Vec<(u32, bool)>, StepError> {
    let columns = headers(grid, header_row);
    let unknown = |name: &str| {
        StepError::permanent(
            "UNKNOWN_COLUMN",
            format!("'{name}' is not in the header row {header_row}"),
        )
        .with_details(json!({
            "columns": columns.iter().map(|(_, n)| n).collect::<Vec<_>>(),
            "hint": "Name columns by their header text (exact), e.g. by: [{ \"column\": \"金額\", \"order\": \"desc\" }].",
        }))
    };
    if by.is_empty() || by.len() > 64 {
        return Err(StepError::invalid_params(
            "'by' names 1 or more columns to sort by",
        ));
    }
    by.iter()
        .map(|key| {
            let name = key
                .get("column")
                .and_then(Value::as_str)
                .map(str::trim)
                .ok_or_else(|| StepError::invalid_params("each 'by' item needs 'column'"))?;
            let descending = match key.get("order").and_then(Value::as_str) {
                None | Some("asc") => false,
                Some("desc") => true,
                Some(other) => {
                    return Err(StepError::invalid_params(format!(
                        "order '{other}' is not asc or desc"
                    )));
                }
            };
            let column = columns
                .iter()
                .find(|(_, n)| n == name)
                .map(|(c, _)| *c)
                .ok_or_else(|| unknown(name))?;
            Ok((column, descending))
        })
        .collect()
}

/// The table's extent for sorting: first and last column of the headers,
/// and the last row with something in them.
pub fn extent(grid: &[Vec<Value>], header_row: u32) -> Option<(u32, u32, u32)> {
    let columns = headers(grid, header_row);
    let first = columns.first()?.0;
    let last_column = columns.last()?.0;
    let last_row = (header_row + 1..=grid.len() as u32).rev().find(|row| {
        columns
            .iter()
            .any(|(column, _)| !at(grid, *row, *column).is_null())
    })?;
    Some((first, last_column, last_row))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid() -> Vec<Vec<Value>> {
        vec![
            vec![json!("請求書一覧"), Value::Null, Value::Null],
            vec![json!("品番"), json!("数量"), json!("品番")],
            vec![json!("A-1"), json!(3), json!("x")],
            vec![Value::Null, Value::Null, Value::Null],
            vec![json!("B-2"), json!(5), Value::Null],
        ]
    }

    #[test]
    fn rows_match_the_file_rules() {
        assert_eq!(
            rows(&grid(), 2),
            json!([
                { "品番": "A-1", "数量": 3, "品番_2": "x", "_row": 3 },
                { "品番": "B-2", "数量": 5, "品番_2": null, "_row": 5 },
            ])
        );
    }

    #[test]
    fn appends_below_the_last_row_and_checks_names() {
        let plan = append(&grid(), 2, &[json!({ "品番": "C-3", "数量": 1 })]).unwrap();
        assert_eq!(plan.first_row, 6);
        assert_eq!(
            plan.writes,
            vec![
                (Cell { column: 1, row: 6 }, json!("C-3")),
                (Cell { column: 2, row: 6 }, json!(1)),
            ]
        );
        let e = append(&grid(), 2, &[json!({ "単価": 1 })]).unwrap_err();
        assert_eq!(e.code, "UNKNOWN_COLUMN");
        // A sheet without headers gets them from the records.
        let plan = append(&[], 1, &[json!({ "a": 1, "b": 2 })]).unwrap();
        assert_eq!(plan.first_row, 2);
        assert_eq!(plan.writes.len(), 4);
    }

    #[test]
    fn sort_keys_name_header_columns() {
        let keys = sort_keys(
            &grid(),
            2,
            &[
                json!({ "column": "数量", "order": "desc" }),
                json!({ "column": "品番" }),
            ],
        )
        .unwrap();
        assert_eq!(keys, [(2, true), (1, false)]);
        assert_eq!(
            sort_keys(&grid(), 2, &[json!({ "column": "単価" })])
                .unwrap_err()
                .code,
            "UNKNOWN_COLUMN"
        );
        assert_eq!(extent(&grid(), 2), Some((1, 3, 5)));
    }

    #[test]
    fn range_writes_start_at_the_corner() {
        let writes = range_writes(
            Cell { column: 2, row: 3 },
            &[json!(["a", 1]), json!([null])],
        )
        .unwrap();
        assert_eq!(
            writes,
            vec![
                (Cell { column: 2, row: 3 }, json!("a")),
                (Cell { column: 3, row: 3 }, json!(1)),
                (Cell { column: 2, row: 4 }, Value::Null),
            ]
        );
        assert_eq!(
            range_writes(Cell { column: 1, row: 1 }, &[json!("x")])
                .unwrap_err()
                .code,
            "INVALID_VALUES"
        );
    }
}

//! The parameters of `excel.format`, `excel.filter` and `excel.pivot`,
//! read and checked before Excel is touched, so a mistake never leaves the
//! workbook half changed.

use serde_json::{Value, json};
use shikigami_runtime::StepError;

use crate::a1::Range;

/// Excel's `XlHAlign`.
const XL_LEFT: i32 = -4131;
const XL_CENTER: i32 = -4108;
const XL_RIGHT: i32 = -4152;

/// What `excel.format` changes; `None` leaves that part as it is.
#[derive(Debug, Default, PartialEq)]
pub struct Format {
    pub range: Option<Range>,
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    /// Excel's colour number (red + green × 256 + blue × 65536).
    pub font_color: Option<i32>,
    /// `Some(None)` takes the fill away.
    pub fill: Option<Option<i32>>,
    pub number_format: Option<String>,
    pub align: Option<i32>,
    pub wrap: Option<bool>,
    pub borders: Option<bool>,
    pub column_width: Option<f64>,
    pub auto_fit: bool,
}

/// `"#RRGGBB"` as Excel's colour number.
pub fn color(key: &str, text: &str) -> Result<i32, StepError> {
    let hex = text.trim().trim_start_matches('#');
    let bad =
        || StepError::invalid_params(format!("'{key}' is not a colour like \"#FFF2CC\": {text}"));
    if hex.len() != 6 {
        return Err(bad());
    }
    let n = u32::from_str_radix(hex, 16).map_err(|_| bad())?;
    let (r, g, b) = ((n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF);
    i32::try_from(r | (g << 8) | (b << 16)).map_err(|_| bad())
}

fn flag(params: &Value, key: &str) -> Result<Option<bool>, StepError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        Some(_) => Err(StepError::invalid_params(format!(
            "'{key}' must be true or false"
        ))),
    }
}

fn text<'a>(params: &'a Value, key: &str) -> Result<Option<&'a str>, StepError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.as_str())),
        Some(_) => Err(StepError::invalid_params(format!("'{key}' must be text"))),
    }
}

pub fn format(params: &Value) -> Result<Format, StepError> {
    let range = text(params, "range")?
        .map(|r| {
            Range::parse(r).ok_or_else(|| {
                StepError::invalid_params(format!("'{r}' is not a range like A1:D1 or B2"))
            })
        })
        .transpose()?;
    let fill = match params.get("fillColor") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(s)) if s.trim().eq_ignore_ascii_case("none") => Some(None),
        Some(Value::String(s)) => Some(Some(color("fillColor", s)?)),
        Some(_) => {
            return Err(StepError::invalid_params(
                "'fillColor' is a colour like \"#FFF2CC\", or null to take the fill away",
            ));
        }
    };
    let align = match text(params, "align")? {
        None => None,
        Some("left") => Some(XL_LEFT),
        Some("center") => Some(XL_CENTER),
        Some("right") => Some(XL_RIGHT),
        Some(other) => {
            return Err(StepError::invalid_params(format!(
                "align '{other}' is not left, center or right"
            )));
        }
    };
    let column_width = match params.get("columnWidth") {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => match n.as_f64() {
            Some(w) if (0.0..=255.0).contains(&w) => Some(w),
            _ => {
                return Err(StepError::invalid_params(
                    "'columnWidth' is a width from 0 to 255 (characters)",
                ));
            }
        },
        Some(_) => {
            return Err(StepError::invalid_params(
                "'columnWidth' is a width from 0 to 255 (characters)",
            ));
        }
    };
    let format = Format {
        range,
        bold: flag(params, "bold")?,
        italic: flag(params, "italic")?,
        font_color: text(params, "fontColor")?
            .map(|c| color("fontColor", c))
            .transpose()?,
        fill,
        number_format: text(params, "numberFormat")?.map(str::to_owned),
        align,
        wrap: flag(params, "wrapText")?,
        borders: flag(params, "borders")?,
        column_width,
        auto_fit: flag(params, "autoFit")?.unwrap_or(false),
    };
    if format.range.is_none() {
        return Err(StepError::invalid_params(
            "'range' names the cells to format, e.g. A1:D1",
        ));
    }
    if format
        == (Format {
            range: format.range,
            ..Format::default()
        })
    {
        return Err(StepError::invalid_params(
            "say what to change: bold, italic, fontColor, fillColor, numberFormat, align, wrapText, borders, columnWidth or autoFit",
        ));
    }
    Ok(format)
}

/// The column `name` among `headers` (column, header text), or
/// `UNKNOWN_COLUMN` listing them.
pub fn column(headers: &[(u32, String)], header_row: u32, name: &str) -> Result<u32, StepError> {
    headers
        .iter()
        .find(|(_, n)| n == name.trim())
        .map(|(c, _)| *c)
        .ok_or_else(|| {
            StepError::permanent(
                "UNKNOWN_COLUMN",
                format!("'{name}' is not in the header row {header_row}"),
            )
            .with_details(json!({
                "columns": headers.iter().map(|(_, n)| n).collect::<Vec<_>>(),
                "hint": "Name columns by their header text (exact).",
            }))
        })
}

/// One condition of `excel.filter`: keep the rows whose `column` shows
/// one of `values`.
#[derive(Debug, PartialEq)]
pub struct Filter {
    pub column: String,
    pub values: Vec<String>,
}

/// The filters to set, or `None` to show every row again (`clear: true`).
pub fn filters(params: &Value) -> Result<Option<Vec<Filter>>, StepError> {
    let clear = flag(params, "clear")?.unwrap_or(false);
    let list = params.get("filters").filter(|v| !v.is_null());
    match (clear, list) {
        (true, None) => return Ok(None),
        (true, Some(_)) => {
            return Err(StepError::invalid_params(
                "give either 'filters' or 'clear: true', not both",
            ));
        }
        (false, None) => {
            return Err(StepError::invalid_params(
                "'filters' lists the conditions, e.g. [{ \"column\": \"状態\", \"values\": [\"未処理\"] }]; 'clear: true' shows every row again",
            ));
        }
        (false, Some(_)) => {}
    }
    let Some(Value::Array(items)) = list else {
        return Err(StepError::invalid_params("'filters' must be a list"));
    };
    if items.is_empty() || items.len() > 64 {
        return Err(StepError::invalid_params(
            "'filters' has 1 to 64 conditions",
        ));
    }
    items
        .iter()
        .map(|item| {
            let column = item
                .get("column")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|c| !c.is_empty())
                .ok_or_else(|| StepError::invalid_params("each filter needs 'column'"))?;
            let Some(Value::Array(values)) = item.get("values") else {
                return Err(StepError::invalid_params(format!(
                    "filter on '{column}' needs 'values', a list of what to keep"
                )));
            };
            if values.is_empty() {
                return Err(StepError::invalid_params(format!(
                    "filter on '{column}' keeps nothing: give at least one value"
                )));
            }
            let values = values
                .iter()
                .map(|v| match v {
                    Value::String(s) => Ok(s.clone()),
                    Value::Number(n) => Ok(n.to_string()),
                    Value::Bool(b) => Ok(if *b { "TRUE" } else { "FALSE" }.to_owned()),
                    _ => Err(StepError::invalid_params(format!(
                        "filter on '{column}': values are text or numbers"
                    ))),
                })
                .collect::<Result<_, _>>()?;
            Ok(Filter {
                column: column.to_owned(),
                values,
            })
        })
        .collect::<Result<_, _>>()
        .map(Some)
}

/// What `excel.pivot` builds.
#[derive(Debug, PartialEq)]
pub struct Pivot {
    pub rows: Vec<String>,
    pub columns: Vec<String>,
    /// (column, Excel's `XlConsolidationFunction`).
    pub values: Vec<(String, i32)>,
    pub to_sheet: String,
}

fn names(params: &Value, key: &str) -> Result<Vec<String>, StepError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| {
                v.as_str()
                    .map(|s| s.trim().to_owned())
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| StepError::invalid_params(format!("'{key}' lists header texts")))
            })
            .collect(),
        Some(_) => Err(StepError::invalid_params(format!(
            "'{key}' lists header texts"
        ))),
    }
}

pub fn pivot(params: &Value) -> Result<Pivot, StepError> {
    let to_sheet = text(params, "toSheet")?
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            StepError::invalid_params("'toSheet' names the new sheet for the pivot table")
        })?
        .to_owned();
    let Some(Value::Array(items)) = params.get("values") else {
        return Err(StepError::invalid_params(
            "'values' lists what to total, e.g. [{ \"column\": \"金額\", \"function\": \"sum\" }]",
        ));
    };
    if items.is_empty() {
        return Err(StepError::invalid_params(
            "'values' needs at least one column to total",
        ));
    }
    let values = items
        .iter()
        .map(|item| {
            let column = item
                .get("column")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|c| !c.is_empty())
                .ok_or_else(|| StepError::invalid_params("each 'values' item needs 'column'"))?;
            let function = match item.get("function").and_then(Value::as_str) {
                None | Some("sum") => -4157,
                Some("count") => -4112,
                Some("average") => -4106,
                Some("max") => -4136,
                Some("min") => -4139,
                Some(other) => {
                    return Err(StepError::invalid_params(format!(
                        "function '{other}' is not sum, count, average, max or min"
                    )));
                }
            };
            Ok((column.to_owned(), function))
        })
        .collect::<Result<_, StepError>>()?;
    let pivot = Pivot {
        rows: names(params, "rows")?,
        columns: names(params, "columns")?,
        values,
        to_sheet,
    };
    if pivot.rows.is_empty() && pivot.columns.is_empty() {
        return Err(StepError::invalid_params(
            "give 'rows' (and/or 'columns'): the header texts to group by",
        ));
    }
    Ok(pivot)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_are_read_as_excel_numbers() {
        assert_eq!(color("c", "#FF0000").unwrap(), 0x0000FF);
        assert_eq!(color("c", "#0000ff").unwrap(), 0xFF0000);
        assert_eq!(color("c", "FFF2CC").unwrap(), 0xCCF2FF);
        assert!(color("c", "#FFF").is_err());
        assert!(color("c", "#GGGGGG").is_err());
    }

    #[test]
    fn format_needs_a_range_and_something_to_change() {
        assert!(format(&json!({ "bold": true })).is_err());
        assert!(format(&json!({ "range": "A1:D1" })).is_err());
        assert!(format(&json!({ "range": "A1:", "bold": true })).is_err());
        assert!(format(&json!({ "range": "A1", "align": "middle" })).is_err());
        let f = format(&json!({
            "range": "A1:D1", "bold": true, "fillColor": "#DDEBF7", "align": "center", "autoFit": true
        }))
        .unwrap();
        assert_eq!(f.bold, Some(true));
        assert_eq!(f.fill, Some(Some(0xF7EBDD)));
        assert_eq!(f.align, Some(XL_CENTER));
        assert!(f.auto_fit);
        let f = format(&json!({ "range": "B2:B9", "fillColor": null })).unwrap();
        assert_eq!(f.fill, Some(None));
    }

    #[test]
    fn filters_or_clear() {
        assert_eq!(filters(&json!({ "clear": true })).unwrap(), None);
        assert!(filters(&json!({})).is_err());
        assert!(filters(&json!({ "clear": true, "filters": [] })).is_err());
        assert!(filters(&json!({ "filters": [{ "column": "状態", "values": [] }] })).is_err());
        let f = filters(&json!({ "filters": [{ "column": " 状態 ", "values": ["未処理", 3] }] }))
            .unwrap()
            .unwrap();
        assert_eq!(
            f,
            vec![Filter {
                column: "状態".into(),
                values: vec!["未処理".into(), "3".into()]
            }]
        );
    }

    #[test]
    fn pivots_group_and_total() {
        assert!(pivot(&json!({ "toSheet": "集計", "values": [{ "column": "金額" }] })).is_err());
        assert!(pivot(&json!({ "rows": ["担当"], "values": [{ "column": "金額" }] })).is_err());
        assert!(
            pivot(&json!({ "toSheet": "集計", "rows": ["担当"], "values": [{ "column": "金額", "function": "median" }] }))
                .is_err()
        );
        let p = pivot(&json!({
            "toSheet": "集計", "rows": ["担当"], "columns": ["月"],
            "values": [{ "column": "金額" }, { "column": "受注番号", "function": "count" }]
        }))
        .unwrap();
        assert_eq!(p.rows, ["担当"]);
        assert_eq!(
            p.values,
            [("金額".into(), -4157), ("受注番号".into(), -4112)]
        );
    }

    #[test]
    fn columns_are_found_by_header_text() {
        let headers = vec![(2, "担当".to_owned()), (3, "金額".to_owned())];
        assert_eq!(column(&headers, 1, "金額").unwrap(), 3);
        let e = column(&headers, 1, "合計").unwrap_err();
        assert_eq!(e.code, "UNKNOWN_COLUMN");
    }
}

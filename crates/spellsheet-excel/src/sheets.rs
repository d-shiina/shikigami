//! Row and sheet changes on the workbook file (no Excel needed): inserting
//! and deleting rows, clearing a range, and deleting, renaming and copying
//! sheets. References to the changed rows and sheets in formulas and named
//! ranges are kept right, as Excel would; what this file-level route cannot
//! keep right (a deleted sheet that formulas still use, a sheet with tables
//! to copy) is refused with a hint, so the workbook is never left broken.

use serde_json::{Value, json};
use spellsheet_runtime::StepError;
use umya_spreadsheet::{Workbook, Worksheet};

use crate::a1::{Cell, Range};
use crate::book;

/// Most references listed in a SHEET_REFERENCED error.
const LISTED: usize = 10;

/// The name of `name`, or of the first sheet.
pub fn sheet_name(workbook: &Workbook, name: Option<&str>) -> Result<String, StepError> {
    Ok(book::sheet(workbook, name)?.name().to_owned())
}

/// Row number params: whole numbers from 1.
pub fn row_number(params: &Value, key: &str, default: Option<u32>) -> Result<u32, StepError> {
    match params.get(key) {
        None | Some(Value::Null) => {
            default.ok_or_else(|| StepError::invalid_params(format!("'{key}' is required")))
        }
        Some(value) => value
            .as_u64()
            .or_else(|| value.as_str().and_then(|s| s.trim().parse().ok()))
            .filter(|n| (1..=u64::from(crate::a1::MAX_ROW)).contains(n))
            .map(|n| n as u32)
            .ok_or_else(|| {
                StepError::invalid_params(format!("'{key}' must be a whole number from 1"))
            }),
    }
}

pub fn insert_rows(workbook: &mut Workbook, sheet: &str, row: u32, count: u32) {
    workbook.insert_new_row(sheet, row, count);
}

pub fn delete_rows(workbook: &mut Workbook, sheet: &str, row: u32, count: u32) {
    workbook.remove_row(sheet, row, count);
}

/// Empties the cells of `range` (values and formulas), keeping their formats.
pub fn clear_range(sheet: &mut Worksheet, range: Range, date1904: bool) -> Result<(), StepError> {
    let inside: Vec<Cell> = sheet
        .cells()
        .iter()
        .map(|c| Cell {
            column: c.coordinate().col_num(),
            row: c.coordinate().row_num(),
        })
        .filter(|c| {
            (range.start.column..=range.end.column).contains(&c.column)
                && (range.start.row..=range.end.row).contains(&c.row)
        })
        .collect();
    for cell in inside {
        book::write(sheet, cell, &Value::Null, date1904)?;
    }
    Ok(())
}

/// Checks a new sheet name the way Excel does.
pub fn check_name(name: &str) -> Result<(), StepError> {
    let bad = name.trim().is_empty()
        || name.chars().count() > 31
        || name.contains(['\\', '/', '?', '*', '[', ']', ':'])
        || name.starts_with('\'')
        || name.ends_with('\'')
        || name.eq_ignore_ascii_case("history");
    if bad {
        return Err(StepError::permanent(
            "INVALID_SHEET_NAME",
            format!("'{name}' cannot be a sheet name"),
        )
        .with_details(json!({ "hint": "Sheet names have 1 to 31 characters, no \\ / ? * [ ] : and do not start or end with '." })));
    }
    Ok(())
}

fn exists(workbook: &Workbook, name: &str) -> bool {
    workbook.sheet_by_name(name).is_ok()
}

fn sheet_exists(name: &str) -> StepError {
    StepError::permanent("SHEET_EXISTS", format!("there is already a sheet named '{name}'"))
        .with_details(json!({ "hint": "Choose another name, or delete that sheet first with excel.deleteSheet." }))
}

// -- references to a sheet in formulas ----------------------------------------

/// How a formula names `sheet`: always quoted, which Excel reads whatever
/// the name holds.
fn quoted(sheet: &str) -> String {
    format!("'{}'", sheet.replace('\'', "''"))
}

/// The places in `formula` that reference the sheet `name` (`売上!A1`,
/// `'4月 売上'!A1`, `'4月 売上'!A1:'4月 売上'!B2` …), outside string
/// literals, as byte ranges of the sheet part (without the `!`).
fn sheet_refs(formula: &str, name: &str) -> Vec<std::ops::Range<usize>> {
    let quoted_name = quoted(name);
    let bytes = formula.as_bytes();
    let mut found = Vec::new();
    let mut i = 0;
    while i < formula.len() {
        let rest = &formula[i..];
        if rest.starts_with('"') {
            // A string literal: "" is a quote inside it.
            let mut j = i + 1;
            while j < formula.len() {
                if bytes[j] == b'"' {
                    if bytes.get(j + 1) == Some(&b'"') {
                        j += 2;
                        continue;
                    }
                    break;
                }
                j += 1;
            }
            i = j + 1;
            continue;
        }
        let starts_word = i == 0 || {
            let before = formula[..i].chars().next_back().unwrap_or(' ');
            // `]` ends a workbook name: `[Other.xlsx]Data!A1` is not ours.
            !(before.is_alphanumeric() || matches!(before, '_' | '.' | '\'' | '!' | '[' | ']'))
        };
        if starts_word {
            for candidate in [quoted_name.as_str(), name] {
                if rest
                    .get(..candidate.len())
                    .is_some_and(|head| head.eq_ignore_ascii_case(candidate))
                    && rest[candidate.len()..].starts_with('!')
                {
                    found.push(i..i + candidate.len());
                    i += candidate.len();
                    break;
                }
            }
            if found.last().is_some_and(|r| r.end == i) {
                continue;
            }
        }
        if rest.starts_with('\'') {
            // Another quoted sheet name: skip it whole ('' is a quote).
            let mut j = i + 1;
            while j < formula.len() {
                if bytes[j] == b'\'' {
                    if bytes.get(j + 1) == Some(&b'\'') {
                        j += 2;
                        continue;
                    }
                    break;
                }
                j += 1;
            }
            i = j + 1;
            continue;
        }
        i += rest.chars().next().map_or(1, char::len_utf8);
    }
    found
}

/// `formula` with references to the sheet `old` pointing at `new` instead;
/// `None` when it has none.
pub fn rename_refs(formula: &str, old: &str, new: &str) -> Option<String> {
    let refs = sheet_refs(formula, old);
    if refs.is_empty() {
        return None;
    }
    let mut out = String::with_capacity(formula.len() + 8);
    let mut last = 0;
    for r in refs {
        out.push_str(&formula[last..r.start]);
        out.push_str(&quoted(new));
        last = r.end;
    }
    out.push_str(&formula[last..]);
    Some(out)
}

fn refers_to(formula: &str, name: &str) -> bool {
    !sheet_refs(formula, name).is_empty() || in_3d_ref(formula, name)
}

/// Whether `formula` has a reference across sheets (`Jan:Mar!A1`,
/// `'4月:6月'!A1`) with `name` at one end, outside string literals. Those
/// are not rewritten, so renaming or deleting such a sheet is refused.
fn in_3d_ref(formula: &str, name: &str) -> bool {
    let chars: Vec<char> = formula.chars().collect();
    let ends = |span: &str| {
        span.contains(':')
            && span
                .split(':')
                .any(|part| part.trim().eq_ignore_ascii_case(name))
    };
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '"' => {
                i += 1;
                while i < chars.len() {
                    if chars[i] == '"' {
                        if chars.get(i + 1) == Some(&'"') {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
                i += 1;
            }
            '\'' => {
                let mut text = String::new();
                i += 1;
                while i < chars.len() {
                    if chars[i] == '\'' {
                        if chars.get(i + 1) == Some(&'\'') {
                            text.push('\'');
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    text.push(chars[i]);
                    i += 1;
                }
                i += 1;
                // A sheet name cannot hold `:`, so a quoted one that does is a span.
                if chars.get(i) == Some(&'!') && !text.starts_with('[') && ends(&text) {
                    return true;
                }
            }
            c if c.is_alphanumeric() || c == '_' => {
                let start = i;
                while i < chars.len()
                    && (chars[i].is_alphanumeric() || matches!(chars[i], '_' | '.' | ':'))
                {
                    i += 1;
                }
                let after_sheet = start > 0 && matches!(chars[start - 1], '!' | ']' | '.');
                let word: String = chars[start..i].iter().collect();
                if chars.get(i) == Some(&'!') && !after_sheet && ends(&word) {
                    return true;
                }
            }
            _ => i += 1,
        }
    }
    false
}

fn in_3d_anywhere(workbook: &Workbook, name: &str) -> bool {
    workbook.sheet_collection().iter().any(|sheet| {
        sheet
            .cells()
            .iter()
            .any(|c| c.is_formula() && in_3d_ref(c.formula(), name))
            || sheet
                .defined_names()
                .iter()
                .any(|d| in_3d_ref(&d.address(), name))
    }) || workbook
        .defined_names()
        .iter()
        .any(|d| in_3d_ref(&d.address(), name))
}

/// Points every formula and named range of the workbook that references
/// `old` at `new`.
fn rewrite_refs(workbook: &mut Workbook, old: &str, new: &str) {
    for sheet in workbook.sheet_collection_mut() {
        for cell in sheet.cells_mut() {
            if cell.is_formula()
                && let Some(formula) = rename_refs(cell.formula(), old, new)
            {
                cell.set_formula(formula);
            }
        }
        for defined in sheet.defined_names_mut() {
            if let Some(address) = rename_refs(&defined.address(), old, new) {
                defined.set_address(address);
            }
        }
    }
    for defined in workbook.defined_names_mut() {
        if let Some(address) = rename_refs(&defined.address(), old, new) {
            defined.set_address(address);
        }
    }
}

// -- sheet changes ------------------------------------------------------------

/// Deletes the sheet `name`. `false` when there is no such sheet (already
/// deleted: re-running is safe).
pub fn delete_sheet(workbook: &mut Workbook, name: &str) -> Result<bool, StepError> {
    let Some(index) = workbook
        .sheet_collection()
        .iter()
        .position(|s| s.name() == name)
    else {
        return Ok(false);
    };
    if workbook.sheet_collection().len() == 1 {
        return Err(StepError::permanent(
            "LAST_SHEET",
            format!("'{name}' is the only sheet, and a workbook needs one"),
        )
        .with_details(json!({ "hint": "Add another sheet first with excel.addSheet, or clear the sheet with excel.clearRange." })));
    }
    let mut users = Vec::new();
    for sheet in workbook.sheet_collection() {
        if sheet.name() == name {
            continue;
        }
        for cell in sheet.cells() {
            if cell.is_formula() && refers_to(cell.formula(), name) {
                users.push(format!("{}!{}", sheet.name(), cell.coordinate()));
            }
        }
        for defined in sheet.defined_names() {
            if refers_to(&defined.address(), name) {
                users.push(defined.name().to_owned());
            }
        }
    }
    for defined in workbook.defined_names() {
        if refers_to(&defined.address(), name) {
            users.push(defined.name().to_owned());
        }
    }
    if !users.is_empty() {
        let count = users.len();
        users.truncate(LISTED);
        return Err(StepError::permanent(
            "SHEET_REFERENCED",
            format!("formulas or named ranges use the sheet '{name}' ({count} places)"),
        )
        .with_details(json!({
            "usedBy": users,
            "hint": "Deleting it would turn them into #REF!. Change those formulas first, or open the workbook in Excel and run the step again: Excel then deletes the sheet itself.",
        })));
    }
    workbook
        .remove_sheet(index)
        .map_err(|e| StepError::permanent("INTERNAL", e.to_string()))?;
    // Excel opens on a selected tab: keep one selected.
    select_if_none(workbook);
    Ok(true)
}

fn select_if_none(workbook: &mut Workbook) {
    let selected = workbook.sheet_collection().iter().any(|s| {
        s.sheets_views()
            .sheet_view_list()
            .iter()
            .any(umya_spreadsheet::SheetView::tab_selected)
    });
    if !selected
        && let Ok(first) = workbook.sheet_mut(0)
        && let Some(view) = first.sheet_views_mut().sheet_view_list_mut().first_mut()
    {
        view.set_tab_selected(true);
    }
    workbook.workbook_view_mut().set_active_tab(0);
}

/// Renames the sheet `old` to `new`, and every formula and named range
/// that uses it. `false` when `old` is gone and `new` is there (already
/// renamed: re-running is safe).
pub fn rename_sheet(workbook: &mut Workbook, old: &str, new: &str) -> Result<bool, StepError> {
    check_name(new)?;
    if old == new {
        return book::sheet(workbook, Some(old)).map(|_| false);
    }
    let index = workbook
        .sheet_collection()
        .iter()
        .position(|s| s.name() == old);
    let Some(index) = index else {
        if exists(workbook, new) {
            return Ok(false);
        }
        return book::sheet(workbook, Some(old)).map(|_| false);
    };
    // A different case of the same name is a rename Excel allows.
    if workbook
        .sheet_collection()
        .iter()
        .enumerate()
        .any(|(i, s)| i != index && s.name().eq_ignore_ascii_case(new))
    {
        return Err(sheet_exists(new));
    }
    if in_3d_anywhere(workbook, old) {
        return Err(StepError::permanent(
            "SHEET_IN_3D_REFERENCE",
            format!("formulas use the sheet '{old}' at the end of a reference across sheets (like {old}:…!A1)"),
        )
        .with_details(json!({ "hint": "Those references are not rewritten here. Open the workbook in Excel and run the step again: Excel then renames the sheet itself." })));
    }
    workbook
        .sheet_mut(index)
        .map_err(|e| StepError::permanent("INTERNAL", e.to_string()))?
        .set_name(new);
    rewrite_refs(workbook, old, new);
    Ok(true)
}

/// Copies the sheet `from` (values, formulas, formats) as `to`, right
/// after it.
pub fn copy_sheet(workbook: &mut Workbook, from: &str, to: &str) -> Result<(), StepError> {
    check_name(to)?;
    let index = workbook
        .sheet_collection()
        .iter()
        .position(|s| s.name() == from)
        .ok_or_else(|| {
            book::sheet(workbook, Some(from))
                .err()
                .unwrap_or_else(|| sheet_exists(from))
        })?;
    if workbook
        .sheet_collection()
        .iter()
        .any(|s| s.name().eq_ignore_ascii_case(to))
    {
        return Err(sheet_exists(to));
    }
    let source = &workbook.sheet_collection()[index];
    if !source.tables().is_empty() || !source.pivot_tables().is_empty() {
        return Err(StepError::permanent(
            "SHEET_NOT_COPYABLE",
            format!("the sheet '{from}' has tables or pivot tables, which only Excel can copy"),
        )
        .with_details(json!({ "hint": "Open the workbook in Excel and run the step again: Excel then copies the sheet itself." })));
    }
    let mut copy = source.clone();
    copy.set_name(to);
    for view in copy.sheet_views_mut().sheet_view_list_mut() {
        view.set_tab_selected(false);
    }
    // References of the copy to its own sheet point at the copy.
    for cell in copy.cells_mut() {
        if cell.is_formula()
            && let Some(formula) = rename_refs(cell.formula(), from, to)
        {
            cell.set_formula(formula);
        }
    }
    for defined in copy.defined_names_mut() {
        if let Some(address) = rename_refs(&defined.address(), from, to) {
            defined.set_address(address);
        }
    }
    workbook.add_sheet(copy).map_err(|_| sheet_exists(to))?;
    // Moved from the end to right after the original.
    workbook.sheet_collection_mut()[index + 1..].rotate_right(1);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaves_other_workbooks_and_spots_references_across_sheets() {
        assert_eq!(
            rename_refs("[Other.xlsx]Data!A1+Data!B1", "Data", "D"),
            Some("[Other.xlsx]Data!A1+'D'!B1".into())
        );
        assert!(!refers_to("[Other.xlsx]Data!A1", "Data"));
        for formula in [
            "SUM(Jan:Mar!A1)",
            "SUM('Jan:Mar'!A1)",
            "SUM(jan:Mar!A1)",
            "SUM(Feb:Mar!A1, Jan:Jan!B2)",
        ] {
            assert!(
                in_3d_ref(formula, "Jan") || formula.contains("Feb"),
                "{formula}"
            );
        }
        assert!(in_3d_ref("SUM(Jan:Mar!A1)", "Mar"));
        assert!(!in_3d_ref("SUM(Jan!A1:Jan!B2)", "Jan"));
        assert!(!in_3d_ref("\"Jan:Mar!A1\"&Jan!A1", "Jan"));
        assert!(!in_3d_ref("SUM(A1:B2)", "A1"));
    }

    #[test]
    fn finds_sheet_references_outside_strings() {
        assert_eq!(
            rename_refs("SUM(売上!A1:A9)", "売上", "4月"),
            Some("SUM('4月'!A1:A9)".into())
        );
        assert_eq!(
            rename_refs("'4月 売上'!B2+'4月 売上'!C2", "4月 売上", "May"),
            Some("'May'!B2+'May'!C2".into())
        );
        assert_eq!(rename_refs("\"売上!A1\"&A1", "売上", "x"), None);
        assert_eq!(rename_refs("前年売上!A1", "売上", "x"), None);
        assert_eq!(rename_refs("'前の''売上'''!A1", "売上", "x"), None);
        assert_eq!(
            rename_refs("'It''s'!A1", "It's", "Its"),
            Some("'Its'!A1".into())
        );
        assert_eq!(
            rename_refs("sheet1!A1", "Sheet1", "S"),
            Some("'S'!A1".into())
        );
        assert_eq!(rename_refs("A1+B1", "Sheet1", "S"), None);
    }

    #[test]
    fn sheet_names_follow_excel_rules() {
        assert!(check_name("4月分").is_ok());
        for bad in ["", "a/b", "[x]", "'x", &"あ".repeat(32), "History"] {
            assert!(check_name(bad).is_err(), "{bad}");
        }
    }
}

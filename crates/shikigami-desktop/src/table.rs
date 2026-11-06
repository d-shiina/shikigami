//! A grid read from an app, as the list of objects every table in a
//! scenario is (`browser.getTable`, `excel.readRows`, `file.readCsv`).

use serde_json::{Map, Value, json};
use shikigami_runtime::StepError;

use crate::target::NodeInfo;

/// The most rows `desktop.getTable` reads when `maxRows` is not given.
pub const DEFAULT_MAX_ROWS: usize = 10_000;

/// Cells as the backend read them: header texts and rows of cell texts.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Grid {
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    /// More rows were there than were read (`maxRows`).
    pub truncated: bool,
}

impl Grid {
    pub fn to_json(&self) -> Value {
        json!({ "headers": self.headers, "rows": self.rows, "truncated": self.truncated })
    }

    pub fn from_json(value: &Value) -> Result<Self, StepError> {
        let texts = |v: &Value| -> Vec<String> {
            v.as_array()
                .map(|a| a.iter().map(cell_text).collect())
                .unwrap_or_default()
        };
        let rows = value
            .get("rows")
            .and_then(Value::as_array)
            .ok_or_else(|| StepError::new("TABLE_UNREADABLE", "the backend returned no rows"))?;
        Ok(Self {
            headers: value.get("headers").map(texts).unwrap_or_default(),
            rows: rows.iter().map(texts).collect(),
            truncated: value
                .get("truncated")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    }

    /// One object per row, keyed by the header texts: an empty header is
    /// `列1`, `列2`... (as `browser.getTable`), a repeated one gets ` 2`,
    /// ` 3`... so no cell is lost. Rows with every cell empty (the new-row
    /// line at the bottom of many grids) are left out.
    pub fn records(&self) -> Vec<Value> {
        let width = self
            .rows
            .iter()
            .map(Vec::len)
            .chain([self.headers.len()])
            .max()
            .unwrap_or(0);
        let mut keys: Vec<String> = Vec::with_capacity(width);
        for i in 0..width {
            let base = self
                .headers
                .get(i)
                .map(|h| h.trim().to_owned())
                .filter(|h| !h.is_empty())
                .unwrap_or_else(|| format!("列{}", i + 1));
            let mut key = base.clone();
            let mut n = 2;
            while keys.contains(&key) {
                key = format!("{base} {n}");
                n += 1;
            }
            keys.push(key);
        }
        self.rows
            .iter()
            .filter(|row| row.iter().any(|c| !c.trim().is_empty()))
            .map(|row| {
                let mut record = Map::new();
                for (i, key) in keys.iter().enumerate() {
                    let cell = row.get(i).cloned().unwrap_or_default();
                    record.insert(key.clone(), Value::String(cell));
                }
                Value::Object(record)
            })
            .collect()
    }
}

/// A cell's text. WinForms grids report an empty cell as "(null)".
pub fn clean_cell(text: &str) -> String {
    let text = text.trim();
    if text == "(null)" {
        String::new()
    } else {
        text.to_owned()
    }
}

fn cell_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Roles that hold a table's rows.
pub const GRID_ROLES: &[&str] = &["table", "grid", "list", "tree"];
const ROW_ROLES: &[&str] = &["row", "listitem", "treeitem"];
const HEADER_ROLES: &[&str] = &["columnheader", "header"];

/// A grid read from its element tree (`nodes[0]` is the grid, in document
/// order, as inspect_ui lists it), for grids that cannot be read cell by
/// cell. Rows are the shallowest row-like elements; their children are
/// the cells. A row of header cells (WinForms) or a header bar (list
/// views) gives the column names.
pub fn grid_from_nodes(nodes: &[NodeInfo], max_rows: usize) -> Grid {
    let text = |n: &NodeInfo| {
        clean_cell(
            n.value
                .as_deref()
                .filter(|v| !v.trim().is_empty())
                .unwrap_or(&n.name),
        )
    };
    let children = |i: usize| -> Vec<usize> {
        let depth = nodes[i].depth;
        nodes[i + 1..]
            .iter()
            .enumerate()
            .take_while(|(_, n)| n.depth > depth)
            .filter(|(_, n)| n.depth == depth + 1)
            .map(|(j, _)| i + 1 + j)
            .collect()
    };
    let row_depth = nodes
        .iter()
        .skip(1)
        .filter(|n| ROW_ROLES.contains(&n.role))
        .map(|n| n.depth)
        .min();
    let mut headers: Vec<String> = Vec::new();
    // (the row's own text, its cells)
    let mut rows: Vec<(String, Vec<String>)> = Vec::new();
    let mut truncated = false;
    if let Some(depth) = row_depth {
        for i in 1..nodes.len() {
            let n = &nodes[i];
            if n.depth != depth || !ROW_ROLES.contains(&n.role) {
                continue;
            }
            let cells: Vec<usize> = children(i)
                .into_iter()
                .filter(|&c| !matches!(nodes[c].role, "scrollbar" | "thumb"))
                .collect();
            if headers.is_empty()
                && !cells.is_empty()
                && cells.iter().all(|&c| HEADER_ROLES.contains(&nodes[c].role))
            {
                headers = cells.iter().map(|&c| text(&nodes[c])).collect();
                continue;
            }
            if rows.len() == max_rows {
                truncated = true;
                break;
            }
            let mut row: Vec<String> = cells.iter().map(|&c| text(&nodes[c])).collect();
            if cells.is_empty() {
                row = vec![text(n)];
            }
            rows.push((text(n), row));
        }
    }
    if headers.is_empty() {
        // A header bar outside the rows (list views): its items in order.
        if let Some(first) = nodes
            .iter()
            .position(|n| n.role == "columnheader" && n.depth > 0)
        {
            let depth = nodes[first].depth;
            headers = nodes[first..]
                .iter()
                .take_while(|n| n.depth >= depth)
                .filter(|n| n.depth == depth && n.role == "columnheader")
                .map(text)
                .collect();
        }
    }
    // A list view row gives its first column as its own name, the others
    // as children.
    let rows = rows
        .into_iter()
        .map(|(name, mut row)| {
            if row.len() + 1 == headers.len() {
                row.insert(0, name);
            }
            row
        })
        .collect();
    let mut grid = Grid {
        headers,
        rows,
        truncated,
    };
    grid.drop_blank_columns();
    grid
}

impl Grid {
    /// Drops columns with no header and no text in any row (row-header
    /// cells, spacers).
    pub fn drop_blank_columns(&mut self) {
        let width = self
            .rows
            .iter()
            .map(Vec::len)
            .chain([self.headers.len()])
            .max()
            .unwrap_or(0);
        let keep: Vec<bool> = (0..width)
            .map(|c| {
                self.headers.get(c).is_some_and(|h| !h.trim().is_empty())
                    || self
                        .rows
                        .iter()
                        .any(|r| r.get(c).is_some_and(|v| !v.trim().is_empty()))
            })
            .collect();
        let filter = |cells: &mut Vec<String>| {
            let mut c = 0;
            cells.retain(|_| {
                let k = keep.get(c).copied().unwrap_or(true);
                c += 1;
                k
            });
        };
        if self.headers.len() == width {
            filter(&mut self.headers);
        }
        for row in &mut self.rows {
            row.resize(width, String::new());
            filter(row);
        }
    }
}

//! Reading tables and grids.

use super::*;

impl Uia {
    // -- tables -----------------------------------------------------------------------

    /// Reads a grid cell by cell where it supports the Grid pattern (all
    /// rows, also those scrolled out of view), otherwise from its element
    /// tree.
    pub(super) fn get_table(&self, target: &Target, max_rows: usize) -> Result<Value, StepError> {
        let found = self.resolve(target)?;
        let el = self.find_grid(&found)?;
        // SAFETY: UIA calls on the UIA thread.
        unsafe {
            if let Ok(grid) = pattern::<IUIAutomationGridPattern>(&el, UIA_GridPatternId) {
                let rows = grid.CurrentRowCount().or_fail()?.max(0) as usize;
                let cols = grid.CurrentColumnCount().or_fail()?.max(0) as usize;
                if cols > 0 {
                    let take = rows.min(max_rows);
                    let mut cells = Vec::with_capacity(take);
                    for r in 0..take {
                        let row: Vec<String> = (0..cols)
                            .map(|c| {
                                grid.GetItem(r as i32, c as i32)
                                    .map(|cell| cell_text(&cell))
                                    .unwrap_or_default()
                            })
                            .collect();
                        cells.push(row);
                    }
                    let mut grid = Grid {
                        headers: self.column_headers(&el, cols)?,
                        rows: cells,
                        truncated: rows > max_rows,
                    };
                    grid.drop_blank_columns();
                    return Ok(grid.to_json());
                }
            }
        }
        let nodes: Vec<NodeInfo> = self
            .tree(&el, FIND_LIMIT)?
            .into_iter()
            .map(|(_, n)| n)
            .collect();
        let mut grid = table::grid_from_nodes(&nodes, max_rows);
        if nodes.len() >= FIND_LIMIT && !grid.truncated {
            // The walk stopped before the table's end: the last row may be
            // cut short, and more rows were left out.
            grid.rows.pop();
            grid.truncated = true;
        }
        Ok(grid.to_json())
    }

    /// The grid the target names, or the first one in it (tables and grids
    /// before lists).
    pub(super) fn find_grid(&self, found: &Found) -> Result<IUIAutomationElement, StepError> {
        if found.is_element && GRID_ROLES.contains(&found.node.role) {
            return Ok(found.el.clone());
        }
        let tree = self.tree(&found.el, FIND_LIMIT)?;
        let first = |roles: &[&str]| {
            tree.iter()
                .find(|(_, n)| roles.contains(&n.role) && !n.offscreen)
                .map(|(el, _)| el.clone())
        };
        first(&["table", "grid"])
            .or_else(|| first(&["list"]))
            .ok_or_else(|| {
                StepError::new("ELEMENT_NOT_FOUND", "no table, grid or list is shown there")
                    .with_details(json!({
                        "hint": "Check inspect_ui for an element with role table, grid or list and target it with element. Grids drawn by the app itself can only be read with desktop.readText."
                    }))
            })
    }

    /// Column names from the Table pattern, or the header items in the
    /// grid's tree.
    pub(super) fn column_headers(
        &self,
        el: &IUIAutomationElement,
        cols: usize,
    ) -> Result<Vec<String>, StepError> {
        // SAFETY: UIA calls on the UIA thread.
        let from_pattern: Vec<String> = unsafe {
            pattern::<IUIAutomationTablePattern>(el, UIA_TablePatternId)
                .and_then(|t| t.GetCurrentColumnHeaders())
                .map(|headers| {
                    (0..headers.Length().unwrap_or(0))
                        .filter_map(|i| headers.GetElement(i).ok())
                        .map(|h| h.CurrentName().map(|n| n.to_string()).unwrap_or_default())
                        .collect()
                })
                .unwrap_or_default()
        };
        if from_pattern.iter().any(|h| !h.trim().is_empty()) {
            return Ok(from_pattern);
        }
        let headers: Vec<String> = self
            .tree(el, FIND_LIMIT)?
            .into_iter()
            .filter(|(_, n)| n.role == "columnheader")
            .map(|(_, n)| n.name)
            .take(cols)
            .collect();
        Ok(headers)
    }

    /// The scroll pattern of `el` or of the nearest element around it that
    /// can scroll.
    pub(super) fn scroller(&self, el: &IUIAutomationElement) -> Option<IUIAutomationScrollPattern> {
        // SAFETY: UIA calls on the UIA thread.
        unsafe {
            let walker = self.automation.ControlViewWalker().ok()?;
            let mut current = el.clone();
            for _ in 0..32 {
                if let Ok(p) = pattern::<IUIAutomationScrollPattern>(&current, UIA_ScrollPatternId)
                    && (p.CurrentVerticallyScrollable().is_ok_and(|b| b.as_bool())
                        || p.CurrentHorizontallyScrollable().is_ok_and(|b| b.as_bool()))
                {
                    return Some(p);
                }
                current = walker.GetParentElement(&current).ok()?;
            }
            None
        }
    }
}

/// A cell's text: its value where it has one, otherwise its name.
pub(super) fn cell_text(cell: &IUIAutomationElement) -> String {
    // SAFETY: UIA calls on the UIA thread.
    unsafe {
        let value = pattern::<IUIAutomationValuePattern>(cell, UIA_ValuePatternId)
            .and_then(|p| p.CurrentValue())
            .map(|v| v.to_string())
            .ok()
            .filter(|v| !v.trim().is_empty())
            .or_else(|| {
                pattern::<IUIAutomationLegacyIAccessiblePattern>(
                    cell,
                    UIA_LegacyIAccessiblePatternId,
                )
                .and_then(|p| p.CurrentValue())
                .map(|v| v.to_string())
                .ok()
                .filter(|v| !v.trim().is_empty())
            });
        let text = value.unwrap_or_else(|| {
            cell.CurrentName()
                .map(|n| n.to_string())
                .unwrap_or_default()
        });
        table::clean_cell(&text)
    }
}

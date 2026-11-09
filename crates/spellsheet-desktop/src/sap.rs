//! SAP GUI for Windows through SAP GUI Scripting.
//!
//! UI Automation sees only part of a SAP GUI window, so when a target's
//! window belongs to SAP GUI and scripting is on, the `desktop.*` steps
//! act through the scripting API instead: elements are SAP components
//! (`wnd[0]/usr/txtRSYST-BNAME`), found by id or by role + name like any
//! other element. Called from the UI Automation thread; the scripting
//! objects are reached late-bound through `IDispatch` (`spellsheet-com`).
//!
//! Scripting must be allowed on the SAP server (`sapgui/user_scripting`)
//! and in SAP GUI's options; without it the window is driven through UI
//! Automation as before.

use serde_json::{Value, json};
use spellsheet_com::{Object, Var};
use spellsheet_runtime::StepError;

use crate::backend::Text;
use crate::bridge::AppBridge;
use crate::keys::Chord;
use crate::menu;
use crate::sapgui::{self, component_id};
use crate::table::{self, Grid};
use crate::target::{ElementQuery, NodeInfo, pick_element};

/// Most components read from one SAP window.
const TREE_LIMIT: usize = 3_000;

/// A SAP GUI window reached through scripting.
pub struct SapWindow {
    session: Object,
    window: Object,
    /// `wnd[0]`, `wnd[1]`...
    window_id: String,
}

/// A component found in the window.
pub struct Component {
    pub object: Object,
    pub node: NodeInfo,
    pub kind: String,
}

fn count(collection: &Object) -> i32 {
    collection
        .get("Count")
        .and_then(|v| v.to_i64())
        .map_or(0, |n| n as i32)
}

fn item(collection: &Object, i: i32) -> Result<Object, StepError> {
    collection.object("Item", vec![Var::i32(i)])
}

fn text(object: &Object, name: &str) -> String {
    object.get(name).map(|v| v.to_text()).unwrap_or_default()
}

fn children(object: &Object) -> Vec<Object> {
    let Ok(list) = object.object("Children", vec![]) else {
        return Vec::new();
    };
    (0..count(&list))
        .filter_map(|i| item(&list, i).ok())
        .collect()
}

impl SapWindow {
    /// The scripting session showing the window `hwnd`, or `None` when SAP
    /// GUI Scripting cannot reach it (scripting off, or not SAP GUI).
    pub fn attach(hwnd: isize) -> Option<Self> {
        let gui = Object::bind("SAPGUI", || StepError::new("SAP", "no SAP GUI")).ok()?;
        let app = gui.object("GetScriptingEngine", vec![]).ok()?;
        for connection in children(&app) {
            for session in children(&connection) {
                for window in children(&session) {
                    let handle = window.get("Handle").and_then(|v| v.to_i64()).ok();
                    if handle == Some(hwnd as i64) {
                        let window_id = component_id("", &text(&window, "Id"));
                        return Some(Self {
                            session,
                            window,
                            window_id,
                        });
                    }
                }
            }
        }
        None
    }

    fn node(&self, object: &Object, depth: usize) -> (NodeInfo, String) {
        let kind = text(object, "Type");
        let sub_type = if kind == "GuiShell" {
            text(object, "SubType")
        } else {
            String::new()
        };
        let role = sapgui::role(&kind, &sub_type);
        let label = text(object, "Text");
        let name = if label.trim().is_empty() || kind == "GuiPasswordField" {
            text(object, "Tooltip")
        } else {
            label.clone()
        };
        let selected = || object.get("Selected").map(|v| v.to_bool()).ok();
        let node = NodeInfo {
            depth,
            id: component_id("", &text(object, "Id")),
            name: name.trim().to_owned(),
            role,
            class_name: kind.clone(),
            enabled: object
                .get("Changeable")
                .map(|v| v.to_bool())
                .unwrap_or(true)
                || !sapgui::is_input(&kind),
            offscreen: false,
            password: kind == "GuiPasswordField",
            value: (sapgui::is_input(&kind) && kind != "GuiPasswordField").then_some(label),
            checked: match kind.as_str() {
                "GuiCheckBox" | "GuiRadioButton" => selected(),
                _ => None,
            },
        };
        (node, kind)
    }

    /// The window's components in document order (the window first).
    pub fn tree(&self, limit: usize) -> Vec<NodeInfo> {
        let mut out = Vec::new();
        self.walk(&self.window, 0, limit, &mut out);
        out
    }

    fn walk(&self, object: &Object, depth: usize, limit: usize, out: &mut Vec<NodeInfo>) {
        if out.len() >= limit {
            return;
        }
        let (node, _) = self.node(object, depth);
        out.push(node);
        // Shells (grids, trees, text editors) keep their contents inside.
        let container = object
            .get("ContainerType")
            .map(|v| v.to_bool())
            .unwrap_or(false);
        if container && text(object, "Type") != "GuiShell" {
            for child in children(object) {
                self.walk(&child, depth + 1, limit, out);
            }
        }
    }

    fn by_id(&self, id: &str) -> Result<Object, StepError> {
        let full = component_id(&self.window_id, id);
        self.session
            .call("findById", vec![Var::str(&full), Var::bool(false)])
            .ok()
            .and_then(|v| v.object("findById").ok())
            .ok_or_else(|| {
                StepError::new("ELEMENT_NOT_FOUND", format!("SAP GUI has no component {full}"))
                    .with_details(json!({ "hint": "Copy the id from inspect_ui (it lists SAP component ids such as wnd[0]/usr/txtRSYST-BNAME), or use role + name." }))
            })
    }

    /// The component `query` names.
    pub fn find(&self, query: &ElementQuery) -> Result<Component, StepError> {
        // An id is the component's full path, unless within / after narrow
        // the search: then they must hold too.
        let direct = query.within.is_none() && query.after.is_none();
        let id = match &query.id {
            Some(id) if direct => id.clone(),
            _ => {
                let nodes = self.tree(TREE_LIMIT);
                nodes[pick_element(query, &nodes)?].id.clone()
            }
        };
        let object = self.by_id(&id)?;
        let (node, kind) = self.node(&object, 0);
        if direct
            && query.id.is_some()
            && (query.role.is_some() || query.name.is_some())
            && !query.matches(&node)
        {
            return Err(StepError::new(
                "ELEMENT_NOT_FOUND",
                format!(
                    "{id} is a {} named '{}', not what the target says",
                    node.role, node.name
                ),
            ));
        }
        Ok(Component { object, node, kind })
    }

    pub fn inspect(
        &self,
        max_nodes: usize,
        root: Option<&ElementQuery>,
    ) -> Result<Value, StepError> {
        let nodes = match root {
            None => self.tree(TREE_LIMIT),
            Some(query) => {
                let found = self.find(query)?;
                let mut out = Vec::new();
                self.walk(&found.object, 0, TREE_LIMIT, &mut out);
                out
            }
        };
        Ok(json!({
            "backend": "sapgui",
            "snapshot": crate::target::render_tree(&nodes, max_nodes),
            "hint": "Target a SAP component as { \"window\": …, \"element\": { \"id\": \"wnd[0]/usr/txtRSYST-BNAME\" } } (ids as listed), or role + name. sap.runTransaction starts a transaction.",
        }))
    }

    pub fn probe(&self, query: &ElementQuery) -> Value {
        match self.find(query) {
            Ok(c) => json!({ "found": true, "visible": true, "enabled": c.node.enabled }),
            Err(_) => json!({ "found": false, "visible": false, "enabled": false }),
        }
    }

    pub fn click(&self, query: &ElementQuery) -> Result<Value, StepError> {
        let c = self.find(query)?;
        match c.kind.as_str() {
            "GuiButton" => c.object.call("press", vec![]).map(drop)?,
            "GuiCheckBox" => {
                let on = c
                    .object
                    .get("Selected")
                    .map(|v| v.to_bool())
                    .unwrap_or(false);
                c.object.put("Selected", Var::bool(!on))?;
            }
            "GuiRadioButton" | "GuiTab" | "GuiMenu" => c.object.call("select", vec![]).map(drop)?,
            // Lists and fields with a value help: choosing is F2 on the
            // focused component (as a double click does).
            "GuiLabel" | "GuiTextField" | "GuiCTextField" => {
                c.object.call("SetFocus", vec![])?;
                self.window.call("sendVKey", vec![Var::i32(2)])?;
            }
            _ => {
                return Err(StepError::permanent(
                    "NOT_CLICKABLE",
                    format!(
                        "the SAP component {} ({}) cannot be clicked",
                        c.node.id, c.kind
                    ),
                ));
            }
        }
        Ok(Value::Null)
    }

    pub fn set_value(&self, query: &ElementQuery, value: &Text) -> Result<Value, StepError> {
        let c = self.find(query)?;
        if c.kind == "GuiComboBox" {
            return self.choose(&c, &value.value);
        }
        if !sapgui::is_input(&c.kind) {
            return Err(StepError::permanent(
                "NOT_SUPPORTED",
                format!(
                    "the SAP component {} ({}) does not take a value",
                    c.node.id, c.kind
                ),
            ));
        }
        if !c.node.enabled {
            return Err(StepError::permanent("READ_ONLY", "the field is read-only"));
        }
        c.object.put("Text", Var::str(&value.value))?;
        Ok(Value::Null)
    }

    pub fn get_value(&self, query: &ElementQuery) -> Result<Value, StepError> {
        let c = self.find(query)?;
        if c.node.password {
            return Err(StepError::permanent(
                "PASSWORD_FIELD",
                "password fields cannot be read",
            ));
        }
        if let Some(checked) = c.node.checked {
            return Ok(Value::Bool(checked));
        }
        Ok(Value::String(text(&c.object, "Text").trim().to_owned()))
    }

    pub fn select(&self, query: &ElementQuery, option: &str) -> Result<Value, StepError> {
        let c = self.find(query)?;
        if c.kind != "GuiComboBox" {
            return Err(StepError::permanent(
                "NOT_SUPPORTED",
                format!(
                    "the SAP component {} ({}) has no options",
                    c.node.id, c.kind
                ),
            ));
        }
        self.choose(&c, option)
    }

    /// Picks a combo box entry by its text (or key).
    fn choose(&self, c: &Component, option: &str) -> Result<Value, StepError> {
        let entries = c.object.object("Entries", vec![])?;
        let mut keys = Vec::new();
        let mut items = Vec::new();
        for i in 0..count(&entries) {
            let entry = item(&entries, i)?;
            keys.push(text(&entry, "Key"));
            items.push(menu::Item {
                name: text(&entry, "Value"),
                popup: false,
                enabled: true,
            });
        }
        let index = keys.iter().position(|k| k == option).map_or_else(
            || {
                menu::pick(option, &items).map_err(|_| {
                    StepError::new("OPTION_NOT_FOUND", format!("no option named '{option}'"))
                        .with_details(json!({
                            "options": items.iter().map(|i| i.name.clone()).collect::<Vec<_>>(),
                            "hint": "Use one of the options listed (its text or its key)."
                        }))
                })
            },
            Ok,
        )?;
        c.object.put("Key", Var::str(&keys[index]))?;
        Ok(Value::Null)
    }

    /// `None` when SAP has no virtual key for it (the real keyboard is
    /// used instead).
    pub fn press(&self, chord: &Chord) -> Option<Result<Value, StepError>> {
        let key = sapgui::vkey(chord)?;
        Some(
            self.window
                .call("sendVKey", vec![Var::i32(key)])
                .map(|_| Value::Null),
        )
    }

    /// Focuses a component (before typing with the real keyboard).
    pub fn focus(&self, query: &ElementQuery) -> Result<(), StepError> {
        self.find(query)?.object.call("SetFocus", vec![]).map(drop)
    }

    /// The component's place on the screen: (left, top, width, height).
    pub fn screen_rect(&self, query: &ElementQuery) -> Result<(i32, i32, i32, i32), StepError> {
        let c = self.find(query)?;
        let n = |name: &str| c.object.get(name).and_then(|v| v.to_i64()).unwrap_or(0) as i32;
        Ok((n("ScreenLeft"), n("ScreenTop"), n("Width"), n("Height")))
    }

    pub fn menu(&self, path: &[String]) -> Result<Value, StepError> {
        let mut current = self.by_id(&format!("{}/mbar", self.window_id))?;
        for (i, name) in path.iter().enumerate() {
            let options = children(&current);
            let items: Vec<menu::Item> = options
                .iter()
                .map(|o| menu::Item {
                    name: text(o, "Text"),
                    popup: false,
                    enabled: true,
                })
                .collect();
            let chosen = menu::pick(name, &items)?;
            current = options[chosen].clone();
            if i + 1 == path.len() {
                current.call("select", vec![])?;
            }
        }
        Ok(Value::Null)
    }

    /// Starts a transaction and returns what the status bar says then.
    pub fn transaction(&self, code: &str) -> Result<Value, StepError> {
        self.session
            .call("StartTransaction", vec![Var::str(code)])
            .map_err(|e| {
                StepError::new(
                    "SAP_TRANSACTION_FAILED",
                    format!("could not start {code}: {}", e.message),
                )
            })?;
        Ok(self.status())
    }

    /// The status bar of the main window: `{ type, text }` (type S, W, E,
    /// A, I or empty).
    pub fn status(&self) -> Value {
        match self
            .session
            .call("findById", vec![Var::str("wnd[0]/sbar"), Var::bool(false)])
        {
            Ok(v) => match v.object("sbar") {
                Ok(bar) => json!({ "type": text(&bar, "MessageType"), "text": text(&bar, "Text") }),
                Err(_) => json!({ "type": "", "text": "" }),
            },
            Err(_) => json!({ "type": "", "text": "" }),
        }
    }

    /// Reads an ALV grid (GridView) or a table control, scrolling through
    /// it so every row is loaded.
    pub fn table(&self, query: Option<&ElementQuery>, max_rows: usize) -> Result<Value, StepError> {
        let c = match query {
            Some(q) => self.find(q)?,
            None => {
                let nodes = self.tree(TREE_LIMIT);
                let id = nodes
                    .iter()
                    .find(|n| matches!(n.role, "table" | "grid"))
                    .map(|n| n.id.clone())
                    .ok_or_else(|| {
                        StepError::new(
                            "ELEMENT_NOT_FOUND",
                            "no table or grid is shown in this SAP window",
                        )
                    })?;
                self.find(&ElementQuery {
                    id: Some(id),
                    ..ElementQuery::default()
                })?
            }
        };
        let grid = match c.node.role {
            "grid" => self.grid_view(&c.object, max_rows)?,
            "table" => self.table_control(&c.node.id, max_rows)?,
            _ => {
                return Err(StepError::permanent(
                    "NOT_SUPPORTED",
                    format!(
                        "the SAP component {} ({}) is not a table",
                        c.node.id, c.kind
                    ),
                ));
            }
        };
        Ok(grid.to_json())
    }

    fn grid_view(&self, grid: &Object, max_rows: usize) -> Result<Grid, StepError> {
        let rows = grid.get("RowCount")?.to_i64()?.max(0) as usize;
        let order = grid.object("ColumnOrder", vec![])?;
        let columns: Vec<String> = (0..count(&order))
            .map(|i| order.call("Item", vec![Var::i32(i)]).map(|v| v.to_text()))
            .collect::<Result<_, _>>()?;
        let headers = columns
            .iter()
            .map(|col| {
                grid.call("GetDisplayedColumnTitle", vec![Var::str(col)])
                    .map(|v| v.to_text())
                    .ok()
                    .filter(|t| !t.trim().is_empty())
                    .unwrap_or_else(|| col.clone())
            })
            .collect();
        let visible = grid
            .get("VisibleRowCount")
            .and_then(|v| v.to_i64())
            .unwrap_or(20)
            .max(1) as usize;
        let take = rows.min(max_rows);
        let mut cells = Vec::with_capacity(take);
        for r in 0..take {
            // The grid loads rows as they are scrolled to.
            if r % visible == 0 {
                let _ = grid.put("FirstVisibleRow", Var::i32(r as i32));
            }
            let row = columns
                .iter()
                .map(|col| {
                    grid.call("GetCellValue", vec![Var::i32(r as i32), Var::str(col)])
                        .map(|v| table::clean_cell(&v.to_text()))
                        .unwrap_or_default()
                })
                .collect();
            cells.push(row);
        }
        Ok(Grid {
            headers,
            rows: cells,
            truncated: rows > max_rows,
        })
    }

    fn table_control(&self, id: &str, max_rows: usize) -> Result<Grid, StepError> {
        let mut table = self.by_id(id)?;
        let rows = table.get("RowCount")?.to_i64()?.max(0) as usize;
        let columns = table.object("Columns", vec![])?;
        let width = count(&columns);
        let headers = (0..width)
            .map(|c| item(&columns, c).map(|col| text(&col, "Title")))
            .collect::<Result<Vec<_>, _>>()?;
        let visible = table
            .get("VisibleRowCount")
            .and_then(|v| v.to_i64())
            .unwrap_or(10)
            .max(1) as usize;
        let take = rows.min(max_rows);
        let mut cells = Vec::with_capacity(take);
        // Start from the first row even when the table is already scrolled.
        let scrolled = table
            .object("VerticalScrollbar", vec![])
            .and_then(|bar| bar.get("Position"))
            .and_then(|v| v.to_i64())
            .unwrap_or(0)
            != 0;
        let mut top = 0;
        while top < take {
            if top > 0 || scrolled {
                // Scrolling rebuilds the screen: find the table again.
                table
                    .object("VerticalScrollbar", vec![])?
                    .put("Position", Var::i32(top as i32))?;
                table = self.by_id(id)?;
            }
            for i in 0..visible.min(take - top) {
                let row = (0..width)
                    .map(|c| {
                        table
                            .object("GetCell", vec![Var::i32(i as i32), Var::i32(c)])
                            .map(|cell| table::clean_cell(&text(&cell, "Text")))
                            .unwrap_or_default()
                    })
                    .collect();
                cells.push(row);
            }
            top += visible;
        }
        Ok(Grid {
            headers,
            rows: cells,
            truncated: rows > max_rows,
        })
    }
}

impl AppBridge for SapWindow {
    fn app(&self) -> &'static str {
        "sapgui"
    }
    fn inspect(&self, max_nodes: usize, root: Option<&ElementQuery>) -> Result<Value, StepError> {
        SapWindow::inspect(self, max_nodes, root)
    }
    fn probe(&self, element: &ElementQuery) -> Value {
        SapWindow::probe(self, element)
    }
    fn click(&self, element: &ElementQuery) -> Result<Value, StepError> {
        SapWindow::click(self, element)
    }
    fn set_value(&self, element: &ElementQuery, value: &Text) -> Result<Value, StepError> {
        SapWindow::set_value(self, element, value)
    }
    fn get_value(&self, element: &ElementQuery) -> Result<Value, StepError> {
        SapWindow::get_value(self, element)
    }
    fn select(&self, element: &ElementQuery, option: &str) -> Result<Value, StepError> {
        SapWindow::select(self, element, option)
    }
    fn press(&self, chord: &Chord) -> Option<Result<Value, StepError>> {
        SapWindow::press(self, chord)
    }
    fn focus(&self, element: &ElementQuery) -> Result<(), StepError> {
        SapWindow::focus(self, element)
    }
    fn screen_rect(&self, element: &ElementQuery) -> Result<(i32, i32, i32, i32), StepError> {
        SapWindow::screen_rect(self, element)
    }
    fn menu(&self, path: &[String]) -> Result<Value, StepError> {
        SapWindow::menu(self, path)
    }
    fn table(&self, element: Option<&ElementQuery>, max_rows: usize) -> Result<Value, StepError> {
        SapWindow::table(self, element, max_rows)
    }
    fn transaction(&self, code: &str) -> Result<Value, StepError> {
        SapWindow::transaction(self, code)
    }
}

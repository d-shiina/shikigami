//! Acting on elements without the mouse (click, value, select, window
//! state), scrolling, and menus.

use super::input::{mouse, send};
use super::*;

impl Uia {
    // -- acting without the mouse -------------------------------------------------

    pub(super) fn click(&self, target: &Target) -> Result<Value, StepError> {
        let found = self.resolve_enabled(target)?;
        let el = &found.el;
        // SAFETY: UIA / Win32 calls on the UIA thread.
        unsafe {
            // A classic Win32 button runs its handler inside the click, so a
            // dialog it opens would block UIA until it closes; posting the
            // click returns at once.
            if found.node.class_name == "Button"
                && found.node.role == "button"
                && let Ok(hwnd) = el.CachedNativeWindowHandle()
                && !hwnd.0.is_null()
            {
                PostMessageW(Some(hwnd), BM_CLICK, WPARAM(0), LPARAM(0)).or_fail()?;
                return Ok(Value::Null);
            }
            let acted = if let Ok(p) =
                pattern::<IUIAutomationInvokePattern>(el, UIA_InvokePatternId)
            {
                p.Invoke()
            } else if let Ok(p) = pattern::<IUIAutomationTogglePattern>(el, UIA_TogglePatternId) {
                p.Toggle()
            } else if let Ok(p) =
                pattern::<IUIAutomationSelectionItemPattern>(el, UIA_SelectionItemPatternId)
            {
                p.Select()
            } else if let Ok(p) =
                pattern::<IUIAutomationExpandCollapsePattern>(el, UIA_ExpandCollapsePatternId)
            {
                if p.CurrentExpandCollapseState() == Ok(ExpandCollapseState_Expanded) {
                    p.Collapse()
                } else {
                    p.Expand()
                }
            } else if let Ok(p) =
                pattern::<IUIAutomationLegacyIAccessiblePattern>(el, UIA_LegacyIAccessiblePatternId)
            {
                p.DoDefaultAction()
            } else {
                return Err(StepError::permanent(
                    "NOT_CLICKABLE",
                    format!(
                        "the {} cannot be clicked without the mouse",
                        found.node.role
                    ),
                )
                .with_details(json!({ "hint": "Use desktop.mouseClick with the same target." })));
            };
            acted.map_err(action_error)?;
        }
        Ok(Value::Null)
    }

    pub(super) fn set_value(&self, target: &Target, text: &Text) -> Result<Value, StepError> {
        let found = self.resolve_enabled(target)?;
        check_app(text, &found.window)?;
        // SAFETY: UIA calls on the UIA thread.
        unsafe {
            let p = pattern::<IUIAutomationValuePattern>(&found.el, UIA_ValuePatternId).map_err(
                |_| {
                    StepError::permanent(
                        "NOT_SUPPORTED",
                        format!("the {} does not take a value", found.node.role),
                    )
                    .with_details(
                        json!({ "hint": "Use desktop.type to type into it with the keyboard." }),
                    )
                },
            )?;
            if p.CurrentIsReadOnly().is_ok_and(|r| r.as_bool()) {
                return Err(StepError::permanent("READ_ONLY", "the field is read-only"));
            }
            p.SetValue(&BSTR::from(text.value.as_str()))
                .map_err(action_error)?;
        }
        Ok(Value::Null)
    }

    pub(super) fn get_value(&self, target: &Target) -> Result<Value, StepError> {
        let found = self.resolve(target)?;
        let node = &found.node;
        if node.password {
            return Err(StepError::permanent(
                "PASSWORD_FIELD",
                "password fields cannot be read",
            ));
        }
        if let Some(checked) = node.checked {
            // A three-state checkbox that is neither on nor off reads null.
            // SAFETY: UIA calls on the UIA thread.
            let mixed = node.role == "checkbox"
                && unsafe {
                    pattern::<IUIAutomationTogglePattern>(&found.el, UIA_TogglePatternId)
                        .and_then(|p| p.CurrentToggleState())
                        .is_ok_and(|state| state == ToggleState_Indeterminate)
                };
            return Ok(if mixed {
                Value::Null
            } else {
                Value::Bool(checked)
            });
        }
        // SAFETY: UIA calls on the UIA thread.
        let value = unsafe {
            pattern::<IUIAutomationValuePattern>(&found.el, UIA_ValuePatternId)
                .and_then(|p| p.CurrentValue())
                .map(|v| v.to_string())
                .ok()
        };
        Ok(Value::String(value.unwrap_or_else(|| node.name.clone())))
    }

    pub(super) fn select(&self, target: &Target, option: &str) -> Result<Value, StepError> {
        let found = self.resolve_enabled(target)?;
        let el = &found.el;
        // SAFETY: UIA calls on the UIA thread.
        unsafe {
            let expander =
                pattern::<IUIAutomationExpandCollapsePattern>(el, UIA_ExpandCollapsePatternId).ok();
            if let Some(p) = &expander {
                let _ = p.Expand();
            }
            let options: Vec<(IUIAutomationElement, NodeInfo)> = self
                .tree(el, FIND_LIMIT)?
                .into_iter()
                .skip(1)
                .filter(|(_, n)| {
                    matches!(
                        n.role,
                        "listitem" | "treeitem" | "row" | "tab" | "menuitem" | "radio"
                    )
                })
                .collect();
            let exact: Vec<usize> = (0..options.len())
                .filter(|&i| options[i].1.name == option)
                .collect();
            let partial: Vec<usize> = (0..options.len())
                .filter(|&i| {
                    options[i]
                        .1
                        .name
                        .to_lowercase()
                        .contains(&option.to_lowercase())
                })
                .collect();
            let chosen = match (exact.as_slice(), partial.as_slice()) {
                ([i, ..], _) | ([], [i]) => Some(*i),
                _ => None,
            };
            let result = match chosen {
                Some(i) => {
                    let item = &options[i].0;
                    if let Ok(p) =
                        pattern::<IUIAutomationSelectionItemPattern>(item, UIA_SelectionItemPatternId)
                    {
                        p.Select().map_err(action_error)
                    } else if let Ok(p) = pattern::<IUIAutomationInvokePattern>(item, UIA_InvokePatternId) {
                        p.Invoke().map_err(action_error)
                    } else {
                        Err(StepError::permanent("NOT_SUPPORTED", "the option cannot be selected"))
                    }
                }
                None => match pattern::<IUIAutomationValuePattern>(el, UIA_ValuePatternId) {
                    // An editable combo box with no list: type the value.
                    Ok(p) if options.is_empty() && !p.CurrentIsReadOnly().is_ok_and(|r| r.as_bool()) => {
                        p.SetValue(&BSTR::from(option)).map_err(action_error)
                    }
                    _ => Err(StepError::new(
                        "OPTION_NOT_FOUND",
                        format!("no option named '{option}'"),
                    )
                    .with_details(json!({
                        "hint": if partial.len() > 1 { "Several options contain this text: write the full name." } else { "Use one of the options listed." },
                        "options": options.iter().take(50).map(|(_, n)| n.name.clone()).collect::<Vec<_>>(),
                    }))),
                },
            };
            if let Some(p) = &expander
                && p.CurrentExpandCollapseState() == Ok(ExpandCollapseState_Expanded)
            {
                let _ = p.Collapse();
            }
            result?;
        }
        Ok(Value::Null)
    }

    pub(super) fn close_window(&self, target: &Target) -> Result<Value, StepError> {
        let (window_el, window, _) = self.find_window(&target.window)?;
        // SAFETY: UIA / Win32 calls on the UIA thread.
        unsafe {
            match pattern::<IUIAutomationWindowPattern>(&window_el, UIA_WindowPatternId) {
                Ok(p) => p.Close().map_err(action_error)?,
                Err(_) => PostMessageW(Some(hwnd(window.handle)), WM_CLOSE, WPARAM(0), LPARAM(0))
                    .or_fail()?,
            }
        }
        Ok(Value::Null)
    }

    pub(super) fn set_window(
        &self,
        target: &Target,
        state: Option<WindowState>,
        front: bool,
        bounds: Bounds,
    ) -> Result<Value, StepError> {
        let (_, window, _) = self.find_window(&target.window)?;
        let h = hwnd(window.handle);
        if h.0.is_null() {
            return Err(StepError::permanent(
                "NOT_SUPPORTED",
                "this window cannot be moved or sized",
            ));
        }
        // SAFETY: Win32 calls on the UIA thread, on a window handle UIA gave.
        unsafe {
            match state {
                Some(WindowState::Maximized) => {
                    let _ = ShowWindow(h, SW_MAXIMIZE);
                }
                Some(WindowState::Minimized) => {
                    let _ = ShowWindow(h, SW_MINIMIZE);
                }
                Some(WindowState::Normal) => {
                    let _ = ShowWindow(h, SW_RESTORE);
                }
                None => {}
            }
            if !bounds.is_empty() {
                // A maximized or minimized window keeps its size: restore it first.
                if IsZoomed(h).as_bool() || IsIconic(h).as_bool() {
                    let _ = ShowWindow(h, SW_RESTORE);
                }
                let mut r = RECT::default();
                GetWindowRect(h, &raw mut r).or_fail()?;
                SetWindowPos(
                    h,
                    None,
                    bounds.x.unwrap_or(r.left),
                    bounds.y.unwrap_or(r.top),
                    bounds.width.unwrap_or(r.right - r.left).max(1),
                    bounds.height.unwrap_or(r.bottom - r.top).max(1),
                    SWP_NOZORDER | SWP_NOACTIVATE,
                )
                .or_fail()?;
            }
            if front {
                if IsIconic(h).as_bool() {
                    let _ = ShowWindow(h, SW_RESTORE);
                }
                if GetForegroundWindow() != h {
                    // Windows lets the process that sent the last input
                    // choose the foreground window.
                    let _ = send(&[mouse(MOUSEEVENTF_MOVE)]);
                    let _ = SetForegroundWindow(h);
                }
                if foreground_pid() != window.pid {
                    return Err(StepError::new(
                        "FOREGROUND_DENIED",
                        "Windows did not let SpellSheet bring the window to the front",
                    )
                    .with_details(json!({
                        "hint": "Keep the screen unlocked and do not use the PC while desktop steps run."
                    })));
                }
            }
            let mut r = RECT::default();
            GetWindowRect(h, &raw mut r).or_fail()?;
            let now = if IsIconic(h).as_bool() {
                WindowState::Minimized
            } else if IsZoomed(h).as_bool() {
                WindowState::Maximized
            } else {
                WindowState::Normal
            };
            Ok(json!({
                "state": now.name(),
                "x": r.left,
                "y": r.top,
                "width": r.right - r.left,
                "height": r.bottom - r.top,
            }))
        }
    }

    // -- scrolling and menus --------------------------------------------------------

    pub(super) fn scroll(
        &self,
        target: &Target,
        direction: Option<Direction>,
        amount: u32,
        unit: ScrollUnit,
    ) -> Result<Value, StepError> {
        let found = self.resolve(target)?;
        // SAFETY: UIA calls on the UIA thread.
        unsafe {
            let Some(direction) = direction else {
                if !found.is_element {
                    return Err(StepError::invalid_params(
                        "without direction, target.element names what to bring into view; add direction (up, down, top, bottom, ...) to scroll the window",
                    ));
                }
                let p = pattern::<IUIAutomationScrollItemPattern>(
                    &found.el,
                    UIA_ScrollItemPatternId,
                )
                .map_err(|_| {
                    StepError::permanent(
                        "NOT_SUPPORTED",
                        format!("the {} cannot be scrolled into view", found.node.role),
                    )
                    .with_details(json!({
                        "hint": "Scroll its list or pane instead: target that and add direction (e.g. down), or use desktop.mouseScroll."
                    }))
                })?;
                p.ScrollIntoView().map_err(action_error)?;
                return Ok(match self.scroller(&found.el) {
                    Some(s) => scroll_state(&s, None),
                    None => {
                        json!({ "verticalPercent": null, "horizontalPercent": null, "atEnd": false })
                    }
                });
            };
            let scroller = self.scroller(&found.el).ok_or_else(|| {
                StepError::permanent(
                    "NOT_SUPPORTED",
                    format!("the {} has nothing to scroll", found.node.role),
                )
                .with_details(json!({
                    "hint": "Target the list, table or pane that scrolls (inspect_ui), or use desktop.mouseScroll or desktop.press with PageDown."
                }))
            })?;
            match direction {
                Direction::Top | Direction::Bottom => {
                    if scroller
                        .CurrentVerticallyScrollable()
                        .is_ok_and(|b| b.as_bool())
                    {
                        let to = if direction == Direction::Top {
                            0.0
                        } else {
                            100.0
                        };
                        scroller
                            .SetScrollPercent(UIA_ScrollPatternNoScroll, to)
                            .map_err(action_error)?;
                    }
                }
                _ => {
                    let (forward, backward) = match unit {
                        ScrollUnit::Page => {
                            (ScrollAmount_LargeIncrement, ScrollAmount_LargeDecrement)
                        }
                        ScrollUnit::Line => {
                            (ScrollAmount_SmallIncrement, ScrollAmount_SmallDecrement)
                        }
                    };
                    let percent = || scroll_percent(&scroller, direction.is_vertical());
                    for _ in 0..amount {
                        if scroll_state(&scroller, Some(direction))["atEnd"] == json!(true) {
                            break;
                        }
                        let before = percent();
                        let (h, v) = match direction {
                            Direction::Down => (ScrollAmount_NoAmount, forward),
                            Direction::Up => (ScrollAmount_NoAmount, backward),
                            Direction::Right => (forward, ScrollAmount_NoAmount),
                            _ => (backward, ScrollAmount_NoAmount),
                        };
                        scroller.Scroll(h, v).map_err(action_error)?;
                        // A scroll that moved nothing is at its end, whatever
                        // percentage the app reports there.
                        if percent() == before {
                            let mut state = scroll_state(&scroller, Some(direction));
                            state["atEnd"] = json!(true);
                            return Ok(state);
                        }
                    }
                }
            }
            Ok(scroll_state(&scroller, Some(direction)))
        }
    }

    pub(super) fn menu(&self, target: &Target, path: &[String]) -> Result<Value, StepError> {
        let found = self.resolve_enabled(target)?;
        // SAFETY: UIA calls on the UIA thread.
        unsafe {
            if found.is_element {
                let opened = found
                    .el
                    .cast::<IUIAutomationElement3>()
                    .and_then(|el| el.ShowContextMenu());
                if opened.is_err() {
                    return Err(StepError::permanent(
                        "NOT_SUPPORTED",
                        format!("the {} does not open its context menu without the mouse", found.node.role),
                    )
                    .with_details(json!({
                        "hint": "Open it with desktop.mouseClick (button: right) on the same target, then desktop.selectMenu with only target.window and the same path."
                    })));
                }
            }
            let mut parent: Option<IUIAutomationElement> = None;
            for (i, name) in path.iter().enumerate() {
                let (item, info) = self.wait_menu_item(&found, name, parent.as_ref())?;
                let last = i + 1 == path.len();
                activate_menu_item(&item, &info, last)?;
                parent = Some(item);
            }
        }
        Ok(Value::Null)
    }

    /// The shown menu item `name`, waiting a little for its menu to open.
    pub(super) fn wait_menu_item(
        &self,
        found: &Found,
        name: &str,
        parent: Option<&IUIAutomationElement>,
    ) -> Result<(IUIAutomationElement, NodeInfo), StepError> {
        let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let mut items = self.menu_items(found, parent)?;
            let infos: Vec<menu::Item> = items.iter().map(|(_, _, item)| item.clone()).collect();
            match menu::pick(name, &infos) {
                Ok(i) if !items[i].2.enabled => {
                    return Err(StepError::permanent(
                        "ELEMENT_DISABLED",
                        format!("the menu item '{}' is greyed out", items[i].2.name),
                    )
                    .with_details(json!({ "hint": "The app does not allow it on this screen now; check the state before this step." })));
                }
                Ok(i) => {
                    let (el, node, _) = items.swap_remove(i);
                    return Ok((el, node));
                }
                Err(e) if e.code == "MENU_ITEM_NOT_FOUND" && std::time::Instant::now() < until => {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(e) => return Err(e),
            }
        }
    }

    /// The menu items shown now: in menus that popped up (other top-level
    /// windows of the app, and under the item just opened) and in the
    /// window itself (its menu bar), without duplicates.
    pub(super) fn menu_items(
        &self,
        found: &Found,
        parent: Option<&IUIAutomationElement>,
    ) -> Result<Vec<(IUIAutomationElement, NodeInfo, menu::Item)>, StepError> {
        let mut roots: Vec<(IUIAutomationElement, bool)> = self
            .windows()?
            .into_iter()
            // Only the app's open popup menus (Win32 menus, WinForms and
            // WPF drop-downs), not its other windows with their own menu
            // bars.
            .filter(|(_, w, node)| {
                w.pid == found.window.pid
                    && w.handle != found.window.handle
                    && (node.role == "menu" || matches!(w.class_name.as_str(), "#32768" | "Popup"))
            })
            .map(|(el, _, _)| (el, true))
            .collect();
        if let Some(parent) = parent {
            roots.push((parent.clone(), true));
        }
        roots.push((found.window_el.clone(), false));
        let mut out: Vec<(IUIAutomationElement, NodeInfo, menu::Item)> = Vec::new();
        for (root, popup) in roots {
            for (el, node) in self.tree(&root, FIND_LIMIT)? {
                if node.role != "menuitem" || node.offscreen || node.name.trim().is_empty() {
                    continue;
                }
                // SAFETY: UIA calls on the UIA thread.
                let seen = out.iter().any(|(other, _, _)| unsafe {
                    self.automation
                        .CompareElements(other, &el)
                        .is_ok_and(|same| same.as_bool())
                });
                if seen {
                    continue;
                }
                let item = menu::Item {
                    name: node.name.clone(),
                    popup,
                    enabled: node.enabled,
                };
                out.push((el, node, item));
            }
        }
        Ok(out)
    }
}

/// Opens a menu item that leads to a submenu, or carries out the last one.
pub(super) fn activate_menu_item(
    item: &IUIAutomationElement,
    node: &NodeInfo,
    last: bool,
) -> Result<(), StepError> {
    // SAFETY: UIA calls on the UIA thread.
    unsafe {
        if !last
            && let Ok(p) =
                pattern::<IUIAutomationExpandCollapsePattern>(item, UIA_ExpandCollapsePatternId)
        {
            return p.Expand().map_err(action_error);
        }
        let acted = if let Ok(p) = pattern::<IUIAutomationInvokePattern>(item, UIA_InvokePatternId)
        {
            p.Invoke()
        } else if let Ok(p) = pattern::<IUIAutomationTogglePattern>(item, UIA_TogglePatternId) {
            p.Toggle()
        } else if let Ok(p) =
            pattern::<IUIAutomationExpandCollapsePattern>(item, UIA_ExpandCollapsePatternId)
        {
            p.Expand()
        } else if let Ok(p) =
            pattern::<IUIAutomationLegacyIAccessiblePattern>(item, UIA_LegacyIAccessiblePatternId)
        {
            p.DoDefaultAction()
        } else {
            return Err(StepError::permanent(
                "NOT_CLICKABLE",
                format!("the menu item '{}' cannot be chosen without the mouse", node.name),
            )
            .with_details(json!({ "hint": "Open the menu and click the item with desktop.mouseClick (target its role menuitem and name)." })));
        };
        acted.map_err(action_error)
    }
}

/// Where a scrollable area stands: percents (null when it cannot scroll
/// that way) and whether it can go no further in `direction`.
/// How far a scroller is scrolled (0–100), or None when it does not scroll
/// that way.
pub(super) fn scroll_percent(p: &IUIAutomationScrollPattern, vertical: bool) -> Option<f64> {
    // SAFETY: UIA calls on the UIA thread.
    let (scrollable, percent) = unsafe {
        if vertical {
            (
                p.CurrentVerticallyScrollable(),
                p.CurrentVerticalScrollPercent(),
            )
        } else {
            (
                p.CurrentHorizontallyScrollable(),
                p.CurrentHorizontalScrollPercent(),
            )
        }
    };
    match (scrollable, percent) {
        (Ok(s), Ok(p)) if s.as_bool() && p >= 0.0 => Some(p),
        _ => None,
    }
}

pub(super) fn scroll_state(p: &IUIAutomationScrollPattern, direction: Option<Direction>) -> Value {
    let (v, h) = (scroll_percent(p, true), scroll_percent(p, false));
    let at_end = match direction {
        None => false,
        Some(d) => {
            let percent = if d.is_vertical() { v } else { h };
            let forward = matches!(d, Direction::Down | Direction::Bottom | Direction::Right);
            match percent {
                None => true,
                // Only the very end: on a long list the last 0.1% can
                // still hide rows (a scroll that moves nothing is caught
                // by the caller).
                Some(p) if forward => p >= 100.0 - 1e-6,
                Some(p) => p <= 1e-6,
            }
        }
    };
    let round = |p: Option<f64>| p.map(|p| (p * 10.0).round() / 10.0);
    json!({ "verticalPercent": round(v), "horizontalPercent": round(h), "atEnd": at_end })
}

//! Pointing on screen: letting the user pick an element or a window,
//! cutting out a picture, recording what they do, and highlighting a target.

use super::input::{key_event, keyboard, mouse, send, tap};
use super::*;

impl Uia {
    // -- pointing on screen ----------------------------------------------------------

    /// Lets the user point at an element (see `Op::Pick`).
    ///
    /// What is under the mouse is looked up on a thread of its own
    /// ([`Looker`]): an app that answers UI Automation slowly (a browser,
    /// Office, an app that is busy) then only makes the frame lag, and the
    /// click or Esc is taken at once. Looked up here, each slow answer held
    /// the click back (the hooks had already taken it from the app), so the
    /// screen seemed frozen.
    pub(super) fn pick(
        &self,
        message: Option<String>,
        hint: Option<String>,
        timeout_ms: u64,
        labels: &Value,
        window_only: bool,
    ) -> Result<Value, StepError> {
        let message = message.unwrap_or_else(|| {
            if window_only {
                "Click the window to pick (Esc to cancel)".into()
            } else {
                "Click the part to pick (Esc to cancel)".into()
            }
        });
        let overlay = Overlay::pick(message, hint)?;
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        // SAFETY: plain Win32 call.
        let own = unsafe { GetCurrentProcessId() };
        let mut shown: Option<(i32, i32, i32, i32)> = None;
        // The window frame on screen: its handle, place and title.
        let mut shown_window: Option<TopWindow> = None;
        let mut hover = Hover::new();
        let looker = Looker::start();
        // A look-up sent and not answered yet: where and when.
        let mut asked: Option<((i32, i32), Instant)> = None;
        // Where the mouse was last told to the overlay (its banner keeps out of the way).
        let mut told: Option<(i32, i32)> = None;
        // How the window under the mouse would be found, by its handle (the
        // windows open do not change while the user points).
        let mut phrases: HashMap<isize, String> = HashMap::new();
        let mut phrase = |w: &TopWindow| -> String {
            phrases
                .entry(w.hwnd.0 as isize)
                .or_insert_with(|| window_phrase(w, labels))
                .clone()
        };
        let clicked = loop {
            match overlay.take_input() {
                Some(Input::Clicked(pt)) => break pt,
                Some(Input::Cancelled) => return Ok(json!({ "cancelled": true })),
                None => {}
            }
            if Instant::now() >= deadline {
                return Ok(json!({ "cancelled": true, "timedOut": true }));
            }
            if let Some(look) = looker.as_ref().and_then(Looker::answer)
                && let Some((at, started)) = asked.take()
            {
                hover.looked(at, started, started.elapsed());
                if let Some((_, rect, part)) = look.filter(|(pid, _, _)| *pid != own) {
                    // The window the node will act on: framed too, with a
                    // tag saying how it will be found next time.
                    let window = top_window_at(POINT { x: at.0, y: at.1 }).filter(|w| w.pid != own);
                    let window_changed = window.as_ref().map(TopWindow::key)
                        != shown_window.as_ref().map(TopWindow::key);
                    if window_changed {
                        overlay.window(window.as_ref().map(|w| w.rect));
                        overlay.window_tag(window.as_ref().map(|w| (w.rect, phrase(w))));
                        shown_window = window;
                    }
                    let key = rect_key(rect);
                    if shown != Some(key) || window_changed {
                        shown = Some(key);
                        overlay.frame(Some(rect));
                        overlay.part_tag(Some((rect, part)));
                    }
                }
            }
            let mut pt = POINT::default();
            // SAFETY: plain Win32 call.
            let moved = unsafe { GetCursorPos(&mut pt) }.is_ok();
            if moved && told != Some((pt.x, pt.y)) {
                told = Some((pt.x, pt.y));
                overlay.mouse(pt);
                // The window alone: plain Win32 calls that never wait for
                // the app, so no look-up on the UIA thread.
                if window_only {
                    let window = top_window_at(pt).filter(|w| w.pid != own);
                    if window.as_ref().map(TopWindow::key)
                        != shown_window.as_ref().map(TopWindow::key)
                    {
                        overlay.window(window.as_ref().map(|w| w.rect));
                        overlay.window_tag(window.as_ref().map(|w| (w.rect, phrase(w))));
                        shown_window = window;
                    }
                }
            }
            if window_only {
                std::thread::sleep(hover::TICK);
                continue;
            }
            let now = Instant::now();
            // Ask the app under the mouse only when it moved (or now and
            // then while it rests), never faster than the app answers, and
            // one question at a time.
            if moved
                && asked.is_none()
                && hover.due((pt.x, pt.y), now)
                && let Some(looker) = &looker
                && looker.ask(pt)
            {
                asked = Some(((pt.x, pt.y), now));
            }
            std::thread::sleep(hover::TICK);
        };
        drop(looker);
        // The frame must not be under the click when it is looked up.
        drop(overlay);
        if window_only {
            std::thread::sleep(Duration::from_millis(60));
            let mut picked = self.window_at(clicked)?;
            picked["how"] = json!("window");
            if let Some(title) = picked.pointer("/window/title").cloned() {
                picked["label"] = title;
            }
            return Ok(picked);
        }
        self.picked_at(clicked)
    }

    /// Lets the user cut a picture out of the screen (see `Op::Snip`).
    pub(super) fn snip(
        &self,
        message: Option<String>,
        timeout_ms: u64,
    ) -> Result<Value, StepError> {
        use base64::Engine as _;
        let message = message.unwrap_or_else(|| {
            "Drag over the part of the screen to cut out (Esc to cancel)".into()
        });
        let screen = snip::virtual_screen();
        let shot = capture::copy_screen(screen)?;
        let Some(cut) = snip::snip(
            shot.clone(),
            screen,
            message,
            Duration::from_millis(timeout_ms),
        )?
        else {
            return Ok(json!({ "cancelled": true }));
        };
        let Some(image) = shot.crop(cut) else {
            return Ok(json!({ "cancelled": true }));
        };
        // The window the picture belongs to: the one under its middle, now
        // that the cutter is gone.
        std::thread::sleep(Duration::from_millis(60));
        let (cx, cy) = cut.center();
        let middle = POINT {
            x: screen.left + cx,
            y: screen.top + cy,
        };
        let picked = self.window_at(middle)?;
        Ok(json!({
            "target": picked.get("target").cloned().unwrap_or(Value::Null),
            "window": picked.get("window").cloned().unwrap_or(Value::Null),
            "png": base64::engine::general_purpose::STANDARD.encode(image.to_png()),
            "width": image.width,
            "height": image.height,
            "rect": {
                "x": screen.left + cut.x,
                "y": screen.top + cut.y,
                "width": cut.width,
                "height": cut.height,
            },
        }))
    }

    /// The target of the top-level window at `pt` (only the window, no
    /// part of it), for a picture cut out of the screen.
    ///
    /// Unlike `picked_at`, it never reads the window's element tree: for a
    /// browser, Excel or a business app that takes UI Automation many
    /// seconds (a minute or more for a large page), and Studio stayed
    /// minimised and looked frozen the whole time after the cut.
    pub(super) fn window_at(&self, pt: POINT) -> Result<Value, StepError> {
        let not_found = || {
            StepError::new(
                "WINDOW_NOT_FOUND",
                "the place cut out is not in an app window",
            )
        };
        let windows = self.windows()?;
        let infos: Vec<WindowInfo> = windows.iter().map(|(_, w, _)| w.clone()).collect();
        // The window under the point by its handle: plain Win32 calls that
        // never wait for the app.
        let by_handle = top_window_at(pt).and_then(|top| {
            let handle = top.hwnd.0 as isize;
            infos
                .iter()
                .position(|w| w.handle != 0 && w.handle == handle)
        });
        let index = match by_handle {
            Some(index) => index,
            // A window UI Automation lists without its handle: walk up from
            // the element under the point (its parents only, no tree).
            None => {
                // SAFETY: UIA calls on the UIA thread.
                unsafe {
                    let el = self.automation.ElementFromPoint(pt).or_fail()?;
                    let root = self.automation.GetRootElement().or_fail()?;
                    let walker = self.automation.ControlViewWalker().or_fail()?;
                    let same = |a: &IUIAutomationElement, b: &IUIAutomationElement| {
                        self.automation
                            .CompareElements(a, b)
                            .map(|b| b.as_bool())
                            .unwrap_or(false)
                    };
                    let mut top = el;
                    for _ in 0..200 {
                        let Ok(parent) = walker.GetParentElement(&top) else {
                            break;
                        };
                        if same(&parent, &root) {
                            break;
                        }
                        top = parent;
                    }
                    windows
                        .iter()
                        .position(|(w, _, _)| same(w, &top))
                        .ok_or_else(not_found)?
                }
            }
        };
        let info = &infos[index];
        if !self.elevated && is_elevated(info.pid) == Some(true) {
            return Err(elevation_error());
        }
        let picked = picked_target(&infos, index, &[], None, Point { x: 0, y: 0 });
        Ok(json!({
            "target": picked.target,
            "window": { "title": info.title, "process": info.process },
            "app": app_label(&info.title, &info.process),
            "windowChoices": window_choices(&infos, index),
        }))
    }

    /// The target for the element at `pt` on screen.
    pub(super) fn picked_at(&self, pt: POINT) -> Result<Value, StepError> {
        // SAFETY: UIA call on the UIA thread.
        let el = unsafe { self.automation.ElementFromPoint(pt).or_fail()? };
        self.picked(&el, pt)
    }

    /// The target for `el`; `pt` (on screen) is where to point when it has
    /// nothing better.
    pub(super) fn picked(&self, el: &IUIAutomationElement, pt: POINT) -> Result<Value, StepError> {
        // SAFETY: UIA calls on the UIA thread.
        unsafe {
            let root = self.automation.GetRootElement().or_fail()?;
            let walker = self.automation.ControlViewWalker().or_fail()?;
            // The top-level window: the last element before the desktop.
            let mut top = el.clone();
            let mut chain = vec![el.clone()];
            for _ in 0..200 {
                let Ok(parent) = walker.GetParentElement(&top) else {
                    break;
                };
                if self
                    .automation
                    .CompareElements(&parent, &root)
                    .map(|b| b.as_bool())
                    .unwrap_or(true)
                {
                    break;
                }
                chain.push(parent.clone());
                top = parent;
            }
            let windows = self.windows()?;
            let same = |a: &IUIAutomationElement, b: &IUIAutomationElement| {
                self.automation
                    .CompareElements(a, b)
                    .map(|b| b.as_bool())
                    .unwrap_or(false)
            };
            let Some(window) = windows.iter().position(|(w, _, _)| same(w, &top)) else {
                return Err(StepError::new(
                    "WINDOW_NOT_FOUND",
                    "the place clicked is not in an app window",
                ));
            };
            let (window_el, info, _) = &windows[window];
            if !self.elevated && is_elevated(info.pid) == Some(true) {
                return Err(elevation_error());
            }
            // An app that does not hand over its tree in time (UI
            // Automation's timeout) is pointed at by the place clicked,
            // rather than the pick failing after the wait.
            let tree = match self.tree(window_el, FIND_LIMIT) {
                Ok(tree) => tree,
                Err(e) => {
                    tracing::warn!(error = %e.message, "the picked window's tree could not be read");
                    Vec::new()
                }
            };
            let point_only = tree.is_empty();
            // The element itself, else its nearest ancestor in the tree.
            let element = chain
                .iter()
                .find_map(|link| tree.iter().position(|(t, _)| same(t, link)))
                .filter(|&i| i > 0);
            let window_rect = window_el.CurrentBoundingRectangle().or_fail()?;
            let point = Point {
                x: pt.x - window_rect.left,
                y: pt.y - window_rect.top,
            };
            let infos: Vec<WindowInfo> = windows.iter().map(|(_, w, _)| w.clone()).collect();
            let nodes: Vec<NodeInfo> = tree.iter().map(|(_, n)| n.clone()).collect();
            let mut picked = picked_target(&infos, window, &nodes, element, point);
            if point_only {
                let window_json = picked.target.get("window").cloned().unwrap_or(Value::Null);
                picked.target =
                    json!({ "window": window_json, "point": { "x": point.x, "y": point.y } });
                picked.how = "point";
            }
            let rect = match element {
                Some(i) => tree[i].0.CurrentBoundingRectangle().unwrap_or(window_rect),
                None => window_rect,
            };
            let label = element.map_or_else(|| info.title.clone(), |i| describe(&nodes[i]));
            let mut result = json!({
                "target": picked.target,
                "how": picked.how,
                "label": label,
                "window": { "title": info.title, "process": info.process },
                "app": app_label(&info.title, &info.process),
                "windowChoices": window_choices(&infos, window),
                "rect": { "x": rect.left, "y": rect.top, "width": rect.right - rect.left, "height": rect.bottom - rect.top },
            });
            if picked.how == "point" {
                result["note"] = json!(
                    "The part has no id or name, so it is pointed at by its place in the window: it breaks if the layout changes."
                );
            }
            Ok(result)
        }
    }

    /// Records what the user does (see `Op::Record`). Each click and
    /// command key is held back by the hooks until the screen is read (so
    /// the target is the thing clicked, not what the click opened), then
    /// sent on to the app.
    pub(super) fn record(
        &self,
        title: &str,
        hint: String,
        timeout_ms: u64,
    ) -> Result<Value, StepError> {
        let life = Duration::from_millis(timeout_ms);
        let titled = |n: usize| title.replace("{n}", &n.to_string());
        let overlay = Overlay::record(titled(0), hint, life + Duration::from_secs(60))?;
        let deadline = Instant::now() + life;
        // SAFETY: plain Win32 calls.
        let (own, double_ms, slop) = unsafe {
            (
                GetCurrentProcessId(),
                GetDoubleClickTime(),
                (GetSystemMetrics(SM_CXDOUBLECLK) / 2).max(2),
            )
        };
        let mut rec = Recorder {
            actions: Vec::new(),
            field: None,
            last_click: None,
        };
        let mut timed_out = false;
        loop {
            // The last held-back event has been sent on.
            overlay.processing(false);
            overlay.beat();
            if overlay.typed() {
                self.note_typing(&mut rec, own);
            }
            let Some(raw) = overlay.next_raw() else {
                if Instant::now() >= deadline {
                    timed_out = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(8));
                continue;
            };
            let before = rec.actions.len();
            overlay.processing(matches!(raw, Raw::Down { .. } | Raw::Key { .. }));
            match raw {
                Raw::Stop => break,
                Raw::Up { .. } => {}
                Raw::Pass {
                    vk,
                    scan,
                    extended,
                    up,
                } => {
                    replay_raw_key(vk, scan, extended, up);
                    if !up && !keys::is_modifier(vk) {
                        self.note_typing(&mut rec, own);
                    }
                }
                Raw::Down { button, at, time } => {
                    let up = loop {
                        if let Some(up) = overlay.take_up(button) {
                            break up;
                        }
                        overlay.beat();
                        if Instant::now() >= deadline + Duration::from_secs(30) {
                            break at;
                        }
                        std::thread::sleep(Duration::from_millis(4));
                    };
                    // The second click of a double click: sent on at once,
                    // so the app sees a double click.
                    if let Some(last) = rec.last_click.take()
                        && last.button == button
                        && time.wrapping_sub(last.time) <= double_ms
                        && (at.x - last.at.x).abs() <= slop
                        && (at.y - last.at.y).abs() <= slop
                    {
                        replay_click(button, at, up);
                        if let Some(action) = last.action.and_then(|i| rec.actions.get_mut(i)) {
                            action["double"] = json!(true);
                        }
                        continue;
                    }
                    self.flush_field(&mut rec);
                    let action = self.clicked(own, button, at, up, slop);
                    replay_click(button, at, up);
                    let index = action.map(|a| {
                        rec.actions.push(a);
                        rec.actions.len() - 1
                    });
                    rec.last_click = Some(LastClick {
                        button,
                        at,
                        time,
                        action: index,
                    });
                }
                Raw::Key { vk, extended, held } => {
                    // SAFETY: UIA call on the UIA thread.
                    let focused = unsafe { self.automation.GetFocusedElement().ok() };
                    let theirs = focused.as_ref().filter(|el| element_pid(el) != own);
                    let field = theirs.filter(|el| editable(el));
                    let typing_here = field
                        .is_some_and(|el| rec.field.as_ref().is_some_and(|f| self.same(f, el)));
                    if let Some(el) = field
                        && (keys::is_text_edit(vk, held)
                            || (typing_here && keys::is_ime_key(vk, held, ime_open())))
                    {
                        // Paste, undo, kana conversion…: part of the typing,
                        // whose text is read when it ends.
                        replay_key(vk, extended, held);
                        self.keep_field(&mut rec, el.clone());
                        continue;
                    }
                    if let Some(el) = field
                        && typing_here
                        && vk == 0x0D
                        && held == keys::Held::default()
                    {
                        // Enter while typing: confirming the IME's conversion
                        // changes the text (still typing); otherwise it is
                        // the Enter key, after the text typed so far.
                        let typed = self.field_action(el);
                        let mut press = self.element_action(el);
                        let ime = ime_open();
                        replay_key(vk, extended, held);
                        std::thread::sleep(Duration::from_millis(80));
                        // Confirming adds the converted text to what was
                        // there; a submit that clears or closes the field
                        // does not.
                        let grew = match (typed["value"].as_str(), value_of(el)) {
                            (Some(before), Some(after)) => {
                                after.chars().count() > before.chars().count()
                            }
                            _ => false,
                        };
                        if ime && grew {
                            continue;
                        }
                        rec.field = None;
                        push_field(&mut rec, typed);
                        press["kind"] = json!("press");
                        press["key"] = json!("Enter");
                        rec.actions.push(press);
                        overlay.title(titled(rec.actions.len()));
                        continue;
                    }
                    self.flush_field(&mut rec);
                    if let (Some(el), Some(name)) = (theirs, keys::name(vk, held)) {
                        let mut action = self.element_action(el);
                        action["kind"] = json!("press");
                        action["key"] = json!(name);
                        rec.actions.push(action);
                    }
                    replay_key(vk, extended, held);
                }
            }
            if rec.actions.len() != before {
                overlay.title(titled(rec.actions.len()));
            }
        }
        self.flush_field(&mut rec);
        drop(overlay);
        Ok(json!({
            "status": if timed_out { "timedOut" } else { "stopped" },
            "actions": rec.actions,
        }))
    }

    /// What a click at `at` (released at `up`) was, before the app sees it:
    /// `None` for a click on Studio itself.
    pub(super) fn clicked(
        &self,
        own: u32,
        button: MouseButton,
        at: POINT,
        up: POINT,
        slop: i32,
    ) -> Option<Value> {
        // SAFETY: UIA call on the UIA thread.
        let el = unsafe { self.automation.ElementFromPoint(at).ok()? };
        if element_pid(&el) == own {
            return None;
        }
        let button = match button {
            MouseButton::Left => "left",
            MouseButton::Right => "right",
        };
        if (up.x - at.x).abs() > slop * 2 || (up.y - at.y).abs() > slop * 2 {
            return Some(json!({
                "kind": "drag",
                "button": button,
                "from": { "x": at.x, "y": at.y },
                "to": { "x": up.x, "y": up.y },
            }));
        }
        let mut action = match self.picked(&el, at) {
            Ok(picked) => picked,
            Err(e) => json!({ "failed": { "code": e.code, "message": e.message } }),
        };
        action["kind"] = json!("click");
        action["button"] = json!(button);
        action["double"] = json!(false);
        if editable(&el) {
            action["editable"] = json!(true);
        }
        Some(action)
    }

    /// `{ target, how, label, window, rect }` for an element (a field, the
    /// focus when a key was pressed).
    pub(super) fn element_action(&self, el: &IUIAutomationElement) -> Value {
        // SAFETY: UIA call on the UIA thread.
        let rect = unsafe { el.CurrentBoundingRectangle().ok() };
        let pt = rect.and_then(|r| center(r).ok()).unwrap_or_default();
        self.picked(el, pt)
            .unwrap_or_else(|e| json!({ "failed": { "code": e.code, "message": e.message } }))
    }

    /// A typing key went down: the focused field is the one being typed in.
    pub(super) fn note_typing(&self, rec: &mut Recorder, own: u32) {
        // SAFETY: UIA call on the UIA thread.
        let Some(el) = (unsafe { self.automation.GetFocusedElement().ok() }) else {
            return;
        };
        if element_pid(&el) != own {
            self.keep_field(rec, el);
        }
    }

    pub(super) fn keep_field(&self, rec: &mut Recorder, el: IUIAutomationElement) {
        let same = rec.field.as_ref().is_some_and(|f| self.same(f, &el));
        if !same {
            self.flush_field(rec);
            rec.field = Some(el);
        }
    }

    /// The text typed into the field so far, as one `setValue`.
    pub(super) fn flush_field(&self, rec: &mut Recorder) {
        let Some(el) = rec.field.take() else {
            return;
        };
        let action = self.field_action(&el);
        push_field(rec, action);
    }

    /// `setValue` with the field's text now (never a password's).
    pub(super) fn field_action(&self, el: &IUIAutomationElement) -> Value {
        let mut action = self.element_action(el);
        // SAFETY: UIA call on the UIA thread.
        let password = unsafe { el.CurrentIsPassword().map(|b| b.as_bool()).unwrap_or(false) };
        if password {
            action["password"] = json!(true);
        } else {
            match value_of(el) {
                Some(value) => action["value"] = json!(value),
                None => action["unread"] = json!(true),
            }
        }
        action["kind"] = json!("setValue");
        action
    }

    pub(super) fn same(&self, a: &IUIAutomationElement, b: &IUIAutomationElement) -> bool {
        // SAFETY: UIA call on the UIA thread.
        unsafe {
            self.automation
                .CompareElements(a, b)
                .map(|b| b.as_bool())
                .unwrap_or(false)
        }
    }

    /// Frames the target on screen (see `Op::Highlight`).
    pub(super) fn highlight(&self, target: &Target, ms: u64) -> Result<Value, StepError> {
        let found = match self.resolve(&target.window_part()) {
            Ok(found) => found,
            Err(e)
                if matches!(
                    e.code.as_str(),
                    "WINDOW_NOT_FOUND" | "ELEMENT_NOT_FOUND" | "ELEMENT_GONE"
                ) =>
            {
                return Ok(json!({ "found": false, "code": e.code, "message": e.message }));
            }
            Err(e) => return Err(e),
        };
        // SAFETY: UIA calls on the UIA thread.
        let rect = unsafe {
            let window = found.window_el.CurrentBoundingRectangle().or_fail()?;
            if let Some(p) = target.point {
                const HALF: i32 = 12;
                let (x, y) = (window.left + p.x, window.top + p.y);
                RECT {
                    left: x - HALF,
                    top: y - HALF,
                    right: x + HALF,
                    bottom: y + HALF,
                }
            } else if let Some(r) = &target.region {
                let (x, y) = (window.left + r.x, window.top + r.y);
                RECT {
                    left: x,
                    top: y,
                    right: x + r.width as i32,
                    bottom: y + r.height as i32,
                }
            } else {
                found.el.CurrentBoundingRectangle().or_fail()?
            }
        };
        if rect.right <= rect.left || rect.bottom <= rect.top {
            return Ok(json!({ "found": true, "visible": false }));
        }
        Overlay::flash(rect, Duration::from_millis(ms))?;
        Ok(json!({
            "found": true,
            "visible": true,
            "rect": { "x": rect.left, "y": rect.top, "width": rect.right - rect.left, "height": rect.bottom - rect.top },
        }))
    }
}

/// What the recorder has seen so far.
pub(super) struct Recorder {
    pub(super) actions: Vec<Value>,
    /// The text field being typed in (read when the typing ends).
    pub(super) field: Option<IUIAutomationElement>,
    pub(super) last_click: Option<LastClick>,
}

pub(super) struct LastClick {
    button: MouseButton,
    at: POINT,
    time: u32,
    /// Its place in `actions` (`None` when it was not written down).
    action: Option<usize>,
}

pub(super) fn element_pid(el: &IUIAutomationElement) -> u32 {
    // SAFETY: UIA call on the UIA thread.
    unsafe { el.CurrentProcessId().unwrap_or(0) as u32 }
}

/// A text field the user can type in.
pub(super) fn editable(el: &IUIAutomationElement) -> bool {
    // SAFETY: UIA calls on the UIA thread.
    unsafe {
        pattern::<IUIAutomationValuePattern>(el, UIA_ValuePatternId)
            .and_then(|p| p.CurrentIsReadOnly())
            .is_ok_and(|read_only| !read_only.as_bool())
    }
}

/// Adds a field's `setValue`. A click into the field just before is part
/// of typing into it, so it goes.
pub(super) fn push_field(rec: &mut Recorder, action: Value) {
    if let Some(last) = rec.actions.last()
        && last["kind"] == "click"
        && last["button"] == "left"
        && last["double"] == false
        && last["target"] == action["target"]
    {
        rec.actions.pop();
        if let Some(click) = rec.last_click.as_mut() {
            click.action = None;
        }
    }
    rec.actions.push(action);
}

/// A field's text now.
pub(super) fn value_of(el: &IUIAutomationElement) -> Option<String> {
    // SAFETY: UIA calls on the UIA thread.
    unsafe {
        pattern::<IUIAutomationValuePattern>(el, UIA_ValuePatternId)
            .and_then(|p| p.CurrentValue())
            .map(|v| v.to_string())
            .ok()
    }
}

/// Whether the IME of the window in front is on (Japanese input mode).
pub(super) fn ime_open() -> bool {
    const IMC_GETOPENSTATUS: usize = 5;
    // SAFETY: plain Win32 calls; the answer is a number.
    unsafe {
        let ime = ImmGetDefaultIMEWnd(GetForegroundWindow());
        if ime.is_invalid() {
            return false;
        }
        let mut open = 0usize;
        let sent = SendMessageTimeoutW(
            ime,
            WM_IME_CONTROL,
            WPARAM(IMC_GETOPENSTATUS),
            LPARAM(0),
            SMTO_ABORTIFHUNG,
            100,
            Some(&mut open),
        );
        sent.0 != 0 && open != 0
    }
}

/// Sends on a key that waited in line, as it was.
pub(super) fn replay_raw_key(vk: u16, scan: u16, extended: bool, up: bool) {
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    let _ = send(&[keyboard(vk, scan, flags)]);
}

/// Sends a held-back click on to the app: pressed at `at`, released at `up`.
pub(super) fn replay_click(button: MouseButton, at: POINT, up: POINT) {
    let (down_flag, up_flag) = match button {
        MouseButton::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        MouseButton::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
    };
    // SAFETY: plain Win32 calls.
    unsafe {
        let mut back = POINT::default();
        let _ = GetCursorPos(&mut back);
        let _ = SetCursorPos(at.x, at.y);
        let _ = send(&[mouse(down_flag)]);
        let _ = SetCursorPos(up.x, up.y);
        let _ = send(&[mouse(up_flag)]);
        // The user may have moved on while the screen was read.
        let _ = SetCursorPos(back.x, back.y);
    }
}

/// Sends a held-back key on to the app. The modifiers are normally still
/// held by the user; any already let go are pressed around the key.
pub(super) fn replay_key(vk: u16, extended: bool, held: keys::Held) {
    let now = held_now();
    let mut missing = Vec::new();
    for (was, is, vk) in [
        (held.ctrl, now.ctrl, 0x11),
        (held.alt, now.alt, 0x12),
        (held.shift, now.shift, 0x10),
        (held.win, now.win, 0x5B),
    ] {
        if was && !is {
            missing.push(Key {
                vk,
                extended: vk == 0x5B,
            });
        }
    }
    let key = Key { vk, extended };
    let mut inputs: Vec<INPUT> = missing.iter().map(|k| key_event(*k, false)).collect();
    tap(&mut inputs, key);
    inputs.extend(missing.iter().rev().map(|k| key_event(*k, true)));
    let _ = send(&inputs);
}

pub(super) fn rect_key(rect: RECT) -> (i32, i32, i32, i32) {
    (rect.left, rect.top, rect.right, rect.bottom)
}

/// `button "保存"` for the banner, without building a cache.
pub(super) fn describe_live(el: &IUIAutomationElement) -> String {
    // SAFETY: reading the element's current properties.
    unsafe {
        let role = roles::of_control_type(el.CurrentControlType().map(|t| t.0).unwrap_or(0));
        let name = el.CurrentName().map(|b| b.to_string()).unwrap_or_default();
        let id = el
            .CurrentAutomationId()
            .map(|b| b.to_string())
            .unwrap_or_default();
        let mut line = role.to_owned();
        if !name.trim().is_empty() {
            line.push_str(&format!(" \u{300c}{}\u{300d}", name.trim()));
        }
        if !id.is_empty() {
            line.push_str(&format!(" id={id}"));
        }
        line
    }
}

/// What the picker shows for the element under the mouse: its process,
/// its place on screen and its banner line. `None`: nothing there.
pub(super) type Look = Option<(u32, RECT, String)>;

/// Looks up what is under the mouse for the picker, on a thread of its own
/// with its own UI Automation (and short timeouts), so a slow app never
/// holds up the picker's loop. The thread ends when this is dropped and its
/// last look-up returns; nobody waits for it.
pub(super) struct Looker {
    pub(super) ask: mpsc::Sender<POINT>,
    pub(super) answers: mpsc::Receiver<Look>,
}

/// How long the picker's look-ups wait for an app: a frame that lags is
/// better than a banner stuck on an app that hangs.
pub(super) const LOOK_CONNECTION_TIMEOUT_MS: u32 = 1_000;

pub(super) const LOOK_TRANSACTION_TIMEOUT_MS: u32 = 2_000;

impl Looker {
    fn start() -> Option<Self> {
        let (ask, questions) = mpsc::channel::<POINT>();
        let (tell, answers) = mpsc::channel::<Look>();
        std::thread::Builder::new()
            .name("spellsheet-pick-look".into())
            .spawn(move || {
                // SAFETY: COM and UIA on this thread's own apartment; the
                // interface pointers never leave it.
                unsafe {
                    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                    let _ =
                        SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
                    let automation: IUIAutomation = match CoCreateInstance(
                        &CUIAutomation8,
                        None,
                        CLSCTX_INPROC_SERVER,
                    )
                    .or_else(|_| CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER))
                    {
                        Ok(automation) => automation,
                        Err(_) => return,
                    };
                    if let Ok(a2) = automation.cast::<IUIAutomation2>() {
                        let _ = a2.SetConnectionTimeout(LOOK_CONNECTION_TIMEOUT_MS);
                        let _ = a2.SetTransactionTimeout(LOOK_TRANSACTION_TIMEOUT_MS);
                    }
                    for pt in questions {
                        let look = catch_unwind(AssertUnwindSafe(|| {
                            let el = automation.ElementFromPoint(pt).ok()?;
                            let pid = el.CurrentProcessId().unwrap_or(0) as u32;
                            let rect = el.CurrentBoundingRectangle().ok()?;
                            Some((pid, rect, describe_live(&el)))
                        }))
                        .unwrap_or(None);
                        if tell.send(look).is_err() {
                            break;
                        }
                    }
                }
            })
            .ok()?;
        Some(Self { ask, answers })
    }

    /// Asks what is at `pt`; false when the thread is gone.
    fn ask(&self, pt: POINT) -> bool {
        self.ask.send(pt).is_ok()
    }

    /// The answer to the last question, once it came.
    fn answer(&self) -> Option<Look> {
        self.answers.try_recv().ok()
    }
}

/// The top-level window at `pt` on screen, as the picker frames it.
pub(super) struct TopWindow {
    pub(super) hwnd: HWND,
    pub(super) pid: u32,
    /// What is seen of it (without the invisible resize borders).
    pub(super) rect: RECT,
    pub(super) title: String,
}

impl TopWindow {
    /// Which window, and where: a change means the frame moves.
    fn key(&self) -> (isize, (i32, i32, i32, i32)) {
        (self.hwnd.0 as isize, rect_key(self.rect))
    }
}

/// How the picked target would find window `w`, in words for the
/// picker's tag (see [`describe_window`]). The open windows come from plain
/// Win32 calls (no UI Automation, which a slow app holds up), so this is
/// what the picked target will be as long as UI Automation lists the same
/// windows.
pub(super) fn window_phrase(w: &TopWindow, labels: &Value) -> String {
    let windows = open_windows();
    let process = || process_name(w.pid).unwrap_or_default();
    let Some(index) = windows
        .iter()
        .position(|info| info.handle == w.hwnd.0 as isize)
    else {
        return app_label(&w.title, &process());
    };
    let info = &windows[index];
    let picked = picked_target(&windows, index, &[], None, Point { x: 0, y: 0 });
    let window = picked.target.get("window").cloned().unwrap_or(Value::Null);
    describe_window(&window, &app_label(&info.title, &info.process), labels)
}

/// The top-level window at `pt`. Only Win32 calls that do not wait for the
/// app (no WM_GETTEXT), so a hung app cannot stall the picker. The picker's
/// own frames and banner let the mouse through, so they are never found.
pub(super) fn top_window_at(pt: POINT) -> Option<TopWindow> {
    // SAFETY: plain Win32 calls with local buffers.
    unsafe {
        let at = WindowFromPoint(pt);
        if at.is_invalid() {
            return None;
        }
        let top = GetAncestor(at, GA_ROOT);
        let top = if top.is_invalid() { at } else { top };
        let mut pid = 0u32;
        GetWindowThreadProcessId(top, Some(&mut pid));
        let mut rect = RECT::default();
        let seen = DwmGetWindowAttribute(
            top,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            (&raw mut rect).cast(),
            std::mem::size_of::<RECT>() as u32,
        );
        if seen.is_err() || rect.right <= rect.left {
            GetWindowRect(top, &mut rect).ok()?;
        }
        let mut buf = [0u16; 256];
        let n = InternalGetWindowText(top, &mut buf);
        let title =
            String::from_utf16_lossy(&buf[..usize::try_from(n).unwrap_or(0).min(buf.len())]);
        Some(TopWindow {
            hwnd: top,
            pid,
            rect,
            title,
        })
    }
}

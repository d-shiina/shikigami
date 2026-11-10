//! Pictures of windows, and the real mouse and keyboard.

use super::*;

impl Uia {
    // -- pictures -------------------------------------------------------------------

    /// A picture of the target's window, from the top-left of its UI
    /// Automation rectangle (the origin of `target.point`). Drawn by the
    /// window itself where it can, so it may stay behind others; otherwise
    /// it is brought to the front and copied from the screen.
    pub(super) fn capture(&self, target: &Target) -> Result<Capture, StepError> {
        if let Some(element) = &target.element
            && let Reach::Bridge(app, _, window_el) = self.reach(&target.window)
        {
            let (left, top, width, height) = app.screen_rect(element)?;
            let mut capture = self.capture(&target.window_part_only())?;
            // SAFETY: UIA calls on the UIA thread.
            let rect = unsafe { window_el.CurrentBoundingRectangle() }.or_fail()?;
            capture.element = Some(Rect {
                x: left - rect.left,
                y: top - rect.top,
                width: width.max(1) as u32,
                height: height.max(1) as u32,
            });
            return Ok(capture);
        }
        let found = self.resolve(target)?;
        let window = hwnd(found.window.handle);
        // SAFETY: Win32 / UIA calls on the UIA thread.
        unsafe {
            if !window.0.is_null() && IsIconic(window).as_bool() {
                let _ = ShowWindow(window, SW_RESTORE);
                std::thread::sleep(std::time::Duration::from_millis(300));
            }
            let rect = found.window_el.CurrentBoundingRectangle().or_fail()?;
            let image = match capture::print_window(window, rect) {
                Some(image) => image,
                None => {
                    self.bring_to_front(&found, false)?;
                    capture::copy_screen(rect)?
                }
            };
            let element = if found.is_element {
                let r = found.el.CurrentBoundingRectangle().or_fail()?;
                if r.right <= r.left || r.bottom <= r.top {
                    return Err(StepError::new(
                        "ELEMENT_NOT_VISIBLE",
                        "the element has no area on screen",
                    ));
                }
                Some(Rect {
                    x: r.left - rect.left,
                    y: r.top - rect.top,
                    width: (r.right - r.left) as u32,
                    height: (r.bottom - r.top) as u32,
                })
            } else {
                None
            };
            Ok(Capture { image, element })
        }
    }

    // -- the real mouse and keyboard ---------------------------------------------

    /// Restores and activates the window, then focuses the element. For
    /// keyboard input the element must really have the focus, or the keys
    /// (perhaps a password) would land in another field.
    pub(super) fn bring_to_front(&self, found: &Found, keyboard: bool) -> Result<(), StepError> {
        let window = hwnd(found.window.handle);
        // SAFETY: Win32 / UIA calls on the UIA thread.
        unsafe {
            if !window.0.is_null() {
                if IsIconic(window).as_bool() {
                    let _ = ShowWindow(window, SW_RESTORE);
                }
                if GetForegroundWindow() != window {
                    // Windows lets the process that sent the last input
                    // choose the foreground window.
                    let _ = send(&[mouse(MOUSEEVENTF_MOVE)]);
                    let _ = SetForegroundWindow(window);
                }
            }
            if foreground_pid() != found.window.pid {
                let _ = found.window_el.SetFocus();
            }
            if foreground_pid() != found.window.pid {
                return Err(StepError::new(
                    "FOREGROUND_DENIED",
                    "Windows did not let SpellSheet bring the window to the front",
                )
                .with_details(json!({
                    "hint": "Keep the screen unlocked and do not use the PC while desktop steps run. desktop.click and desktop.setValue work without bringing the window to the front."
                })));
            }
            if found.is_element {
                let focused = found.el.SetFocus();
                if keyboard && (focused.is_err() || !self.has_focus(&found.el)) {
                    return Err(StepError::permanent(
                        "FOCUS_FAILED",
                        format!("the {} could not be given the keyboard focus", found.node.role),
                    )
                    .with_details(json!({
                        "hint": "Target the input field itself (inspect_ui), or use desktop.setValue / desktop.mouseClick on it first."
                    })));
                }
            }
        }
        Ok(())
    }

    /// Whether `el` or something inside it has the keyboard focus.
    pub(super) fn has_focus(&self, el: &IUIAutomationElement) -> bool {
        // SAFETY: UIA calls on the UIA thread.
        unsafe {
            let (Ok(mut current), Ok(walker)) = (
                self.automation.GetFocusedElement(),
                self.automation.ControlViewWalker(),
            ) else {
                return false;
            };
            for _ in 0..16 {
                if self
                    .automation
                    .CompareElements(el, &current)
                    .is_ok_and(|same| same.as_bool())
                {
                    return true;
                }
                match walker.GetParentElement(&current) {
                    Ok(parent) => current = parent,
                    Err(_) => return false,
                }
            }
            false
        }
    }

    pub(super) fn mouse_click(
        &self,
        target: &Target,
        button: MouseButton,
        double: bool,
    ) -> Result<Value, StepError> {
        let found = self.resolve_enabled(target)?;
        self.bring_to_front(&found, false)?;
        let at = self.mouse_point(&found, target)?;
        crate::keep_out::clear(at.x, at.y);
        // SAFETY: Win32 calls on the UIA thread.
        unsafe {
            SetCursorPos(at.x, at.y).or_fail()?;
            let (down, up) = match button {
                MouseButton::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
                MouseButton::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
            };
            let mut inputs = vec![mouse(down), mouse(up)];
            if double {
                inputs.extend([mouse(down), mouse(up)]);
            }
            send(&inputs)?;
        }
        Ok(Value::Null)
    }

    /// Where on the screen the mouse goes for `target`: its `point` from
    /// the window's top-left, or the element's clickable point (centre).
    pub(super) fn mouse_point(&self, found: &Found, target: &Target) -> Result<POINT, StepError> {
        // SAFETY: UIA calls on the UIA thread.
        unsafe {
            Ok(match target.point {
                Some(p) => {
                    let rect = found.window_el.CurrentBoundingRectangle().or_fail()?;
                    POINT {
                        x: rect.left + p.x,
                        y: rect.top + p.y,
                    }
                }
                None => {
                    let mut point = POINT::default();
                    match found.el.GetClickablePoint(&mut point) {
                        Ok(got) if got.as_bool() => point,
                        _ => center(found.el.CurrentBoundingRectangle().or_fail()?)?,
                    }
                }
            })
        }
    }

    pub(super) fn hover(&self, target: &Target) -> Result<Value, StepError> {
        let found = self.resolve(target)?;
        self.bring_to_front(&found, false)?;
        let at = self.mouse_point(&found, target)?;
        move_to(at)?;
        Ok(Value::Null)
    }

    pub(super) fn wheel(
        &self,
        target: &Target,
        direction: Direction,
        notches: u32,
    ) -> Result<Value, StepError> {
        let found = self.resolve(target)?;
        self.bring_to_front(&found, false)?;
        move_to(self.mouse_point(&found, target)?)?;
        // One notch is WHEEL_DELTA (120); positive is up / right.
        let (flag, delta) = match direction {
            Direction::Up | Direction::Top => (MOUSEEVENTF_WHEEL, 120),
            Direction::Down | Direction::Bottom => (MOUSEEVENTF_WHEEL, -120),
            Direction::Left => (MOUSEEVENTF_HWHEEL, -120),
            Direction::Right => (MOUSEEVENTF_HWHEEL, 120),
        };
        for _ in 0..notches {
            let mut input = mouse(flag);
            input.Anonymous.mi.mouseData = delta as _;
            send(&[input])?;
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        Ok(Value::Null)
    }

    /// Presses the left button on `from`, moves in small steps (so the app
    /// sees a drag, not a jump) and lets go on `to`. The button is always
    /// released, even when a step in between fails.
    pub(super) fn drag(&self, from: &Target, to: &Target) -> Result<Value, StepError> {
        let source = self.resolve_enabled(from)?;
        let goal = self.resolve(to)?;
        self.bring_to_front(&source, false)?;
        let a = self.mouse_point(&source, from)?;
        let b = self.mouse_point(&goal, to)?;
        move_to(a)?;
        send(&[mouse(MOUSEEVENTF_LEFTDOWN)])?;
        let pause = |ms| std::thread::sleep(std::time::Duration::from_millis(ms));
        let moved = (|| {
            pause(120);
            const STEPS: i32 = 24;
            for i in 1..=STEPS {
                move_to(POINT {
                    x: a.x + (b.x - a.x) * i / STEPS,
                    y: a.y + (b.y - a.y) * i / STEPS,
                })?;
                pause(15);
            }
            pause(150);
            Ok(())
        })();
        let released = send(&[mouse(MOUSEEVENTF_LEFTUP)]);
        moved.and(released)?;
        Ok(Value::Null)
    }

    pub(super) fn type_text(&self, target: &Target, text: &Text) -> Result<Value, StepError> {
        let found = self.resolve_enabled(target)?;
        check_app(text, &found.window)?;
        self.bring_to_front(&found, true)?;
        let mut inputs = Vec::new();
        for unit in text.value.encode_utf16() {
            match unit {
                0x0D => {}
                0x0A => tap(
                    &mut inputs,
                    Key {
                        vk: 0x0D,
                        extended: false,
                    },
                ),
                0x09 => tap(
                    &mut inputs,
                    Key {
                        vk: 0x09,
                        extended: false,
                    },
                ),
                _ => {
                    inputs.push(keyboard(0, unit, KEYEVENTF_UNICODE));
                    inputs.push(keyboard(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
                }
            }
        }
        send(&inputs)?;
        Ok(Value::Null)
    }

    pub(super) fn press(&self, target: &Target, chord: &Chord) -> Result<Value, StepError> {
        let found = self.resolve_enabled(target)?;
        self.bring_to_front(&found, true)?;
        let mut inputs = Vec::new();
        for m in &chord.modifiers {
            inputs.push(key_event(*m, false));
        }
        tap(&mut inputs, chord.key);
        for m in chord.modifiers.iter().rev() {
            inputs.push(key_event(*m, true));
        }
        send(&inputs)?;
        Ok(Value::Null)
    }
}

/// Moves the cursor and tells the app under it that the mouse moved.
pub(super) fn move_to(at: POINT) -> Result<(), StepError> {
    crate::keep_out::clear(at.x, at.y);
    // SAFETY: plain Win32 calls.
    unsafe { SetCursorPos(at.x, at.y) }.or_fail()?;
    send(&[mouse(MOUSEEVENTF_MOVE)])
}

pub(super) fn mouse(flags: MOUSE_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dwFlags: flags,
                ..MOUSEINPUT::default()
            },
        },
    }
}

pub(super) fn keyboard(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

pub(super) fn key_event(key: Key, up: bool) -> INPUT {
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if key.extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    keyboard(key.vk, 0, flags)
}

pub(super) fn tap(inputs: &mut Vec<INPUT>, key: Key) {
    inputs.push(key_event(key, false));
    inputs.push(key_event(key, true));
}

pub(super) fn send(inputs: &[INPUT]) -> Result<(), StepError> {
    // SAFETY: SendInput reads the slice it is given.
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if (sent as usize) < inputs.len() {
        return Err(StepError::new(
            "INPUT_BLOCKED",
            "Windows did not accept the mouse / keyboard input",
        )
        .with_details(json!({
            "hint": "The screen may be locked, or the app runs as administrator. Keep the session unlocked while desktop steps run."
        })));
    }
    Ok(())
}

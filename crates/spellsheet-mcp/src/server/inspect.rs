//! Looking at the screen for the AI: inspecting pages and apps, asking
//! the user to pick or choose, and trying one step.

use super::*;

impl SpellSheetMcp {
    pub(super) async fn inspect(&self, adapter: &str, params: Value) -> Outcome {
        let adapter = self
            .inner
            .adapters
            .iter()
            .find(|a| a.name() == adapter)
            .ok_or_else(|| {
                err(
                    "ADAPTER_UNAVAILABLE",
                    format!("the {adapter} adapter is not available in this server"),
                )
            })?;
        adapter
            .inspect(self.inner.session.as_str(), params)
            .await
            .map_err(|e| ErrorPayload {
                code: e.code,
                message: e.message,
                details: e.details,
            })
    }

    /// Outlines a browser step's target for a moment before test_step runs it
    /// (best effort: a page that is not open yet, or a headless one, shows nothing).
    pub(super) async fn show_target(
        &self,
        step_type: &str,
        target: &Value,
        context: Option<&Value>,
    ) {
        let label = match step_type {
            "browser.click" => "ここを押します",
            "browser.fill" | "browser.select" | "browser.press" => "ここに入力します",
            _ => "ここを使います",
        };
        let mut params = json!({
            "action": "highlight",
            "target": target,
            "label": label,
            "durationMs": 1200,
            "waitMs": HIGHLIGHT_WAIT_MS,
        });
        if let Some(context) = context {
            params["context"] = context.clone();
        }
        let _ = self.inspect("browser", params).await;
    }

    pub(super) async fn ask_user_to_pick_inner(
        &self,
        peer: &Peer<RoleServer>,
        p: AskUserToPickParams,
    ) -> Outcome {
        if p.message.trim().is_empty() {
            return Err(err(
                "INVALID_PARAMS",
                "message is required: say what to point at, e.g. 「出荷するときに押すボタンをクリックしてください」",
            ));
        }
        match p.app.as_deref() {
            None | Some("browser") => {}
            Some("desktop") => return self.ask_user_to_pick_in_app(peer, p).await,
            Some(other) => {
                return Err(err(
                    "INVALID_PARAMS",
                    format!(
                        "app {other:?} is not known: use \"browser\" (a web page) or \"desktop\" (a Windows app)"
                    ),
                ));
            }
        }
        let wait = self
            .inner
            .picks
            .open(&p.message, None, p.candidates.len())
            .map_err(ErrorPayload::from)?;
        let timeout = p
            .wait_ms
            .unwrap_or(DEFAULT_PICK_WAIT_MS)
            .clamp(1_000, MAX_WAIT_MS);
        let shot = ScreenshotFile::new(true);
        let mut params = json!({
            "action": "pick",
            "message": p.message,
            "candidates": p.candidates,
            "timeoutMs": timeout,
        });
        if let Some(context) = &p.context {
            params["context"] = json!(context);
        }
        if let Some(path) = shot.path() {
            params["screenshotPath"] = json!(path);
        }
        let pick = self.inspect("browser", params);
        tokio::pin!(pick);
        let mut cancelled_in_studio = false;
        let result = loop {
            tokio::select! {
                r = &mut pick => break r,
                () = tokio::time::sleep(PICK_POLL) => {
                    wait.touch();
                    if !cancelled_in_studio && !wait.is_open() {
                        // Studio cancelled: press わからない on the page so the pick returns.
                        cancelled_in_studio = true;
                        let mut cancel = json!({ "action": "cancelPick" });
                        if let Some(context) = &p.context {
                            cancel["context"] = json!(context);
                        }
                        let _ = self.inspect("browser", cancel).await;
                    }
                }
            }
        };
        drop(wait);
        let mut picked = result?;
        match picked.get("status").and_then(Value::as_str) {
            Some("picked") => {
                let target = picked.get("target").cloned().unwrap_or(Value::Null);
                let named = [target.get("role"), target.get("name")]
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" ");
                let seen = json!({
                    "url": picked.get("url"),
                    "title": format!("指してもらった部品：{named}"),
                });
                let request = json!({ "message": p.message, "candidates": p.candidates });
                if let Some(id) = self.observe(
                    peer,
                    ObservationSource::InspectPage,
                    request,
                    &seen,
                    shot.take(),
                ) {
                    picked["observationId"] = json!(id);
                }
                let repeats = picked.get("matches").and_then(Value::as_u64).unwrap_or(1) > 1;
                picked["hint"] = json!(if repeats {
                    "Use `target` as is to touch this exact element now. It repeats on the page (`nth`): if it belongs to one row of a list (`row`), decide with the user which row a run should pick (e.g. by an order number) instead of keeping a fixed nth."
                } else {
                    "Use `target` as is in the step, and name observationId in the edit's observations."
                });
            }
            _ => {
                picked["hint"] = json!(
                    "The user did not point at anything (pressed わからない, Esc, or cancelled in Writer). Ask them in chat what the step should do instead of guessing."
                );
            }
        }
        Ok(picked)
    }

    /// ask_user_to_pick in a Windows app: the person clicks the part on
    /// screen, under a frame and a banner with the AI's question; the click
    /// never reaches the app. Writer steps aside (minimises) while the
    /// request is on file, and can decline it.
    async fn ask_user_to_pick_in_app(
        &self,
        peer: &Peer<RoleServer>,
        p: AskUserToPickParams,
    ) -> Outcome {
        let wait = self
            .inner
            .picks
            .open_desktop(&p.message)
            .map_err(ErrorPayload::from)?;
        let timeout = p
            .wait_ms
            .unwrap_or(DEFAULT_PICK_WAIT_MS)
            .clamp(1_000, MAX_WAIT_MS);
        // Writer sees the request and minimises: let the windows under it
        // show before the frame follows the mouse.
        tokio::time::sleep(STEP_ASIDE).await;
        let params = json!({
            "action": "pick",
            "message": p.message,
            "hint": APP_PICK_HINT,
            "labels": window_tag_labels(),
            "timeoutMs": timeout,
        });
        let pick = self.inspect("desktop", params);
        tokio::pin!(pick);
        let mut cancelled_in_studio = false;
        let result = loop {
            tokio::select! {
                r = &mut pick => break r,
                () = tokio::time::sleep(PICK_POLL) => {
                    wait.touch();
                    if !cancelled_in_studio && !wait.is_open() {
                        // Declined in Writer: end the pick as Esc would.
                        cancelled_in_studio = true;
                        let _ = self.inspect("desktop", json!({ "action": "cancelPick" })).await;
                    }
                }
            }
        };
        drop(wait);
        let mut picked = result?;
        let Some(target) = picked.get("target").filter(|t| t.is_object()).cloned() else {
            return Ok(json!({
                "status": "cancelled",
                "hint": "The user did not point at anything (pressed Esc, right-clicked, or declined in Writer). Ask them in chat what the step should do instead of guessing.",
            }));
        };
        picked["status"] = json!("picked");
        if let Some(obj) = picked.as_object_mut() {
            // Places on this screen: of no use to the AI.
            obj.remove("rect");
        }
        // The window as the AI would have seen it with inspect_ui, kept as
        // what the change is based on.
        if let Some(window) = target.get("window").filter(|w| w.is_object()) {
            let shot = ScreenshotFile::new(true);
            let mut look = json!({ "window": window, "maxNodes": PICKED_WINDOW_NODES });
            if let Some(path) = shot.path() {
                look["screenshotPath"] = json!(path);
            }
            if let Ok(ui) = self.inspect("desktop", look.clone()).await
                && ui.get("snapshot").is_some()
            {
                if let Some(o) = look.as_object_mut() {
                    o.remove("screenshotPath");
                }
                if let Some(id) =
                    self.observe(peer, ObservationSource::InspectUi, look, &ui, shot.take())
                {
                    picked["observationId"] = json!(id);
                }
            }
        }
        picked["hint"] = json!(
            if picked.get("how").and_then(Value::as_str) == Some("point") {
                "Use `target` as is in the desktop.* step (it is a place in the window, see `note`), name observationId in the edit's observations, and tell the user in one line what they pointed at (`label`)."
            } else {
                "Use `target` as is in the desktop.* step (or as a part when several nodes use it), name observationId in the edit's observations, and tell the user in one line what they pointed at (`label`). `windowChoices` are other ways to find the window if its title changes (e.g. a date in it)."
            }
        );
        Ok(picked)
    }

    pub(super) async fn test_step_inner(
        &self,
        mut step: spellsheet_core::Step,
        variables: serde_json::Map<String, Value>,
        subflows: Vec<spellsheet_core::Subflow>,
        flow_id: Option<&str>,
        screenshot_path: Option<String>,
    ) -> Outcome {
        let project_dir = flow_id
            .map(|id| self.svc().project_dir(&FlowId::new(id)))
            .transpose()?;
        if self.inner.runtime.registry().get(&step.step_type).is_none() {
            return Err(unknown_step_type(
                self.inner.runtime.registry(),
                &step.step_type,
            ));
        }
        // The AI names no result variable: it gets the result as `output`.
        step.save_as = None;
        // The params as the run sees them, with the given variables filled
        // in, for showing the target and looking at the result: `context:
        // "{{ ctx }}"` names the context the step actually ran in.
        let raw = Value::Object(step.params.clone());
        let shown = spellsheet_core::expr::render_value(&raw, &variables).unwrap_or(raw);
        let context = shown.get("context").cloned();
        // Workbook steps: the workbook the step read or changed.
        let workbook = shown.get("path").cloned();
        let window = shown.get("target").and_then(|t| t.get("window")).cloned();
        let adapter = step
            .step_type
            .split_once('.')
            .map(|(prefix, _)| prefix.to_owned());
        // Show the person watching the browser what is about to be touched.
        if adapter.as_deref() == Some("browser")
            && let Some(target) = shown.get("target").filter(|t| t.is_object())
        {
            self.show_target(&step.step_type, target, context.as_ref())
                .await;
        }
        // What the step met on screen becomes the node's picture in the
        // flow's 手順書 (「作るときの画面」) until the flow is run.
        let mut draft = flow_id.and_then(|id| {
            let id = FlowId::new(id);
            let parts = self.svc().get(&id).ok().map(|f| f.parts);
            spellsheet_runtime::drafts::DraftCapture::new(
                self.svc().store().local_root(),
                &id,
                &step,
                parts.as_ref(),
                spellsheet_runtime::drafts::DraftSource::Ai,
            )
        });
        let by_hand = step.step_type == WAIT_FOR_HUMAN;
        if by_hand {
            // The AI holds its turn while the person works: never longer than this.
            step.timeout_ms = Some(
                step.timeout_ms
                    .unwrap_or(DEFAULT_HUMAN_TEST_MS)
                    .clamp(1_000, MAX_HUMAN_TEST_MS),
            );
        }
        let single = spellsheet_runtime::single::flow_for(
            step,
            self.inner.runtime.registry(),
            &variables,
            spellsheet_runtime::single::Context::default(),
        )
        .map_err(|m| err("UNKNOWN_STEP_TYPE", m))?;

        let mut handle = self
            .inner
            .runtime
            .start(
                single.flow.clone(),
                RunOptions {
                    run_id: Some(self.inner.session.clone()),
                    keep_adapter_state: true,
                    subflows,
                    project_dir,
                    screens_dir: draft.as_ref().map(|d| d.screens_dir()),
                    origin: RunOrigin::new(RunTrigger::Mcp),
                    inputs: variables,
                    ..RunOptions::default()
                },
            )
            .map_err(|e| ErrorPayload {
                code: e.code,
                message: e.message,
                details: e.details,
            })?;
        // The AI client gave up on the call (its stop button, a timeout):
        // the step stops too instead of waiting on in the background.
        let stop_on_drop = StopOnDrop(Some(handle.stopper()));
        // A wait by hand shows in Writer, which can end it 「終わりました」 or
        // stop it 「待つのをやめる」, and calls the person when Writer is behind.
        let mut human: Option<spellsheet_core::PickWait> = None;
        let mut ended_by = None;
        loop {
            tokio::select! {
                event = handle.next_event() => {
                    let Some(event) = event else { break };
                    if let Some(draft) = draft.as_mut() {
                        draft.on_event(&event.event);
                    }
                    match &event.event {
                        RunEvent::HumanActionRequired { message, dialog: false, .. } if by_hand => {
                            human = self.inner.picks.open_human(message).ok();
                        }
                        RunEvent::StepFinished { .. } => human = None,
                        _ => {}
                    }
                }
                () = tokio::time::sleep(PICK_POLL), if human.is_some() => {
                    let Some(wait) = human.as_ref() else { continue };
                    wait.touch();
                    match wait.answer() {
                        PickAnswer::Waiting => {}
                        PickAnswer::Done => {
                            let mut end = json!({ "action": "endHuman", "how": "person" });
                            if let Some(context) = &context {
                                end["context"] = context.clone();
                            }
                            // The page may not be waiting yet (still bringing the
                            // window forward): keep the request and try again.
                            let ended = self.inspect("browser", end).await.is_ok_and(|r| r["ended"] == json!(true));
                            if ended {
                                ended_by = Some(PickAnswer::Done);
                                human = None;
                            }
                        }
                        PickAnswer::Cancelled => {
                            ended_by = Some(PickAnswer::Cancelled);
                            human = None;
                            handle.cancel();
                        }
                    }
                }
            }
        }
        drop(human);
        let report = handle.wait().await;
        stop_on_drop.disarm();
        if let Some(draft) = draft {
            draft.finish();
        }
        let report = report.map_err(|e| err("INTERNAL", e.message))?;

        let output = single.result(&report.outputs);
        let mut result = json!({ "status": report.status, "output": output });
        if by_hand {
            let hint = match (ended_by, report.status) {
                (Some(PickAnswer::Done), RunStatus::Succeeded) => Some(
                    "The person pressed 終わりました in Writer before `until` showed. Look at `state`: if it is the page after the login, use something it lists as `until` in the flow (the one given never appeared).",
                ),
                (Some(PickAnswer::Cancelled), _) => Some(
                    "The person stopped the wait in Writer (待つのをやめる). The browser is left as it was. Ask them in chat how to go on instead of trying again.",
                ),
                (_, RunStatus::Failed)
                    if report
                        .error
                        .as_ref()
                        .is_some_and(|e| e.code == "HUMAN_TIMEOUT") =>
                {
                    Some(
                        "Nobody finished within the limit, or `until` never showed. Look at `state`: if the person did log in, `until` names something that page does not show; use what `state` lists. Otherwise ask them in chat before waiting again.",
                    )
                }
                _ => None,
            };
            if let Some(hint) = hint {
                result["hint"] = json!(hint);
            }
        }
        if report.status != RunStatus::Succeeded {
            result["error"] = json!(report.error);
            // A step from inside a flow, tried without the values it reads.
            if let Some(error) = &report.error
                && error.code == "EXPR_UNDEFINED_VARIABLE"
            {
                let name = error
                    .details
                    .as_ref()
                    .and_then(|d| d.get("variable"))
                    .and_then(Value::as_str)
                    .unwrap_or("it");
                result["hint"] = json!(format!(
                    "Give the value of `{name}` in `variables`, as it would be at this point of a run (e.g. the current item of a forEach)."
                ));
            }
        }
        // What the application shows now (skipped for adapters that cannot
        // be inspected and for built-in steps).
        if let Some(adapter) = adapter
            && self.inner.adapters.iter().any(|a| a.name() == adapter)
        {
            let mut params = serde_json::Map::new();
            if let Some(context) = context {
                params.insert("context".into(), context);
            }
            // Desktop steps: the window the step acted on (none after
            // desktop.launch, or when it closed).
            if let Some(window) = window {
                params.insert("window".into(), window);
            }
            if let Some(path) = screenshot_path {
                params.insert("screenshotPath".into(), Value::String(path));
            }
            if (adapter == "excel" || adapter == "word")
                && let Some(path) = workbook
            {
                params.insert("path".into(), path);
            }
            if (adapter != "desktop" || params.contains_key("window"))
                && let Ok(state) = self.inspect(&adapter, Value::Object(params)).await
            {
                result["state"] = truncate_snapshot(state);
            }
        }
        Ok(result)
    }
}

/// How long test_step shows a browser step's target before running it.
pub(super) const HIGHLIGHT_WAIT_MS: u64 = 700;
/// Most answers ask_user_to_choose shows (more do not fit a card to read at a glance).
pub(super) const MAX_CHOICES: usize = 4;

/// Whether ask_user_to_choose has a question and 2 to 4 distinct answers.
pub(super) fn check_choices(p: &AskUserToChooseParams) -> Result<(), ErrorPayload> {
    if p.question.trim().is_empty() {
        return Err(err(
            "INVALID_PARAMS",
            "question is required, e.g. 「在庫切れの注文はどうしますか？」",
        ));
    }
    if !(2..=MAX_CHOICES).contains(&p.options.len()) {
        return Err(err(
            "INVALID_PARAMS",
            format!(
                "give 2 to {MAX_CHOICES} options (got {}); for one, just say what you will do",
                p.options.len()
            ),
        ));
    }
    let mut seen = std::collections::HashSet::new();
    for option in &p.options {
        let label = option.label.trim();
        if label.is_empty() {
            return Err(err("INVALID_PARAMS", "every option needs a label"));
        }
        if !seen.insert(label) {
            return Err(err(
                "INVALID_PARAMS",
                format!("two options have the same label: {label}"),
            ));
        }
    }
    if p.recommended.is_some_and(|i| i >= p.options.len()) {
        return Err(err(
            "INVALID_PARAMS",
            "recommended is the index (from 0) of one of the options",
        ));
    }
    Ok(())
}

/// How long Writer has to minimise before the frame is put over the apps.
const STEP_ASIDE: Duration = Duration::from_millis(400);
/// The second line of the banner over the apps, under the AI's question.
const APP_PICK_HINT: &str =
    "クリックで答える ・ Esc または右クリックでわからない（アプリには押したことが伝わりません）";
/// How the tag at the window's frame says the window will be found, in
/// the words Writer's own picker uses (the AI asks in Japanese).
fn window_tag_labels() -> Value {
    json!({
        "any": "{app}（どのウィンドウでも）",
        "contains": "{app} ・ タイトルに「{title}」を含む",
        "exact": "{app} ・「{title}」だけ",
        "prefix": "{app} ・ タイトルが「{title}」で始まる",
        "suffix": "{app} ・ タイトルが「{title}」で終わる",
        "pattern": "{app} ・ タイトルがパターン {title} に合う",
        "nth": "・{n} 番目",
    })
}
/// The picked window's tree kept as the observation: enough to see it.
const PICKED_WINDOW_NODES: u64 = 400;
/// How long ask_user_to_pick waits for a click by default.
pub(super) const DEFAULT_PICK_WAIT_MS: u64 = 120_000;
/// How often ask_user_to_pick looks whether Studio cancelled the request.
pub(super) const PICK_POLL: Duration = Duration::from_millis(500);
/// test_step browser.waitForHuman: how long the person has by default, and at most.
pub(super) const DEFAULT_HUMAN_TEST_MS: u64 = 300_000;
pub(super) const MAX_HUMAN_TEST_MS: u64 = 600_000;
pub(super) const WAIT_FOR_HUMAN: &str = "browser.waitForHuman";

/// Stops a run when the call waiting on it is dropped (the client cancelled).
pub(super) struct StopOnDrop(Option<spellsheet_runtime::Stopper>);

impl StopOnDrop {
    pub(super) fn disarm(mut self) {
        self.0 = None;
    }
}

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        if let Some(stopper) = self.0.take() {
            stopper.stop();
        }
    }
}

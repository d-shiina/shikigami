//! Tools that run flows and look at the screen (browser pages, Windows
//! apps) while a flow is built.

use super::*;

#[tool_router(router = run_tools, vis = "pub(super)")]
impl SpellSheetMcp {
    /// Run a stored flow with the Runtime (no AI involved during the run). The flow must
    /// validate. With waitMs, waits for completion and returns the report; otherwise returns the run ID
    /// at once — poll get_run_status / get_run_logs.
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = false,
        open_world_hint = true
    ))]
    async fn run_flow(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<RunFlowParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = self.start_run(&peer, &p).await;
        self.finish("run_flow", &peer, Some(&p.flow_id), outcome)
    }

    // -- browser --------------------------------------------------------------

    /// Open a web page (or look at the one already open) and return its accessibility tree: roles,
    /// names and labels to use as step targets, e.g. `- button "ログイン"` becomes
    /// { "role": "button", "name": "ログイン" }. The browser state belongs to this MCP session.
    #[tool(annotations(read_only_hint = true, open_world_hint = true))]
    async fn inspect_page(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<InspectPageParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut params = serde_json::Map::new();
        if let Some(url) = p.url {
            let allowed = self.policy().and_then(|policy| {
                policy.check_site(&url).map_err(|r| ErrorPayload {
                    code: r.code.into(),
                    message: r.message,
                    details: Some(r.details),
                })
            });
            if let Err(e) = allowed {
                return self.finish("inspect_page", &peer, None, Err(e));
            }
            params.insert("url".into(), Value::String(url));
        }
        if let Some(context) = p.context {
            params.insert("context".into(), Value::String(context));
        }
        if let Some(target) = p.target {
            params.insert("target".into(), target);
        }
        let request = Value::Object(params.clone());
        let want_image = p.image == Some(true);
        let shot = ScreenshotFile::new(want_image || p.screenshot.unwrap_or(true));
        if let Some(path) = shot.path() {
            params.insert("screenshotPath".into(), Value::String(path));
        }
        let mut picture = None;
        let outcome = self
            .inspect("browser", Value::Object(params))
            .await
            .map(|mut page| {
                let bytes = shot.take();
                if want_image {
                    picture.clone_from(&bytes);
                }
                let kept = bytes.filter(|_| p.screenshot.unwrap_or(true));
                let id = self.observe(&peer, ObservationSource::InspectPage, request, &page, kept);
                if let Some(id) = id {
                    page["observationId"] = json!(id);
                }
                truncate_snapshot(page)
            });
        let mut result = self.finish("inspect_page", &peer, None, outcome)?;
        if let Some(bytes) = picture {
            result.content.push(ContentBlock::image(
                spellsheet_core::review::base64(&bytes),
                "image/jpeg",
            ));
        }
        Ok(result)
    }

    /// Ask the person to choose between 2 to 4 answers when the work depends on a decision only
    /// they can make (how to handle a case, which of several ways to build something). Writer
    /// shows the question and the answers as a card in its AI chat (「AI チャット」, a pane of the
    /// Writer window, not a web browser), right under your reply; the person presses one or
    /// writes their own answer. Use it instead of listing alternatives in your reply. This call
    /// returns at once: end your turn after it without repeating the options. The answer comes
    /// as the person's next message. One question per turn.
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn ask_user_to_choose(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<AskUserToChooseParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = check_choices(&p).map(|()| {
            json!({
                "status": "shown",
                "hint": "Writer shows this as a card right under your reply in its AI chat (「AI チャット」, not a web browser). End your turn now, without repeating the question or the options; if you say anything, point to 「下のカード」. The person's answer comes as the next message.",
            })
        });
        self.finish("ask_user_to_choose", &peer, None, outcome)
    }

    /// Ask the user to point at an element when you cannot tell which one a step should touch:
    /// several fit (two 「編集」 buttons, one per row), an icon has no name, or the words in
    /// inspect_page / inspect_ui do not say which one the user means. Do not guess with `nth`.
    /// Web page (default): the browser window comes to the front with your `message` in a
    /// banner; `candidates` are outlined with numbers; the answer is a browser target (with
    /// `frame` inside an iframe). Also say in your reply (shown in Writer, not in the browser)
    /// that they should switch to the browser window and click it. Windows app (`app:
    /// "desktop"`): Writer steps aside and a banner over the apps shows your `message`; the user
    /// clicks the part in any app and the answer is a desktop.* target (`label` names it,
    /// `windowChoices` are other ways to find the window). Either way the click is caught before
    /// the page or app sees it (nothing is pressed). status: `picked` (`target`, observationId,
    /// and for the web `matches`, `row`, `candidate`, `alternatives`) or `cancelled` (ask in
    /// chat). A web page must be open (inspect_page `url`); an app must be open on screen.
    #[tool(annotations(read_only_hint = true, open_world_hint = true))]
    async fn ask_user_to_pick(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<AskUserToPickParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = self.ask_user_to_pick_inner(&peer, p).await;
        self.finish("ask_user_to_pick", &peer, None, outcome)
    }

    /// See a Windows app the way desktop.* steps do. Without `window`: the open windows (title, process,
    /// app kind). With `window`: its elements as an indented tree, e.g. `- button "保存" id=btnSave`
    /// becomes { "window": { "process": "billing.exe" }, "element": { "id": "btnSave" } }.
    /// When the app shows no elements (Citrix, remote desktops, drawn screens), pass `ocr: true` for
    /// its text with places, and `image: true` to see it; then target places with target.ocr /
    /// target.image instead of element.
    #[tool(annotations(read_only_hint = true, open_world_hint = true))]
    async fn inspect_ui(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<InspectUiParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut params = serde_json::Map::new();
        if let Some(window) = p.window {
            params.insert("window".into(), window);
        }
        if let Some(element) = p.element {
            params.insert("element".into(), element);
        }
        if let Some(max_nodes) = p.max_nodes {
            params.insert("maxNodes".into(), max_nodes.into());
        }
        if p.ocr == Some(true) {
            params.insert("ocr".into(), Value::Bool(true));
        }
        if let Some(language) = p.language {
            params.insert("language".into(), Value::String(language));
        }
        let request = Value::Object(params.clone());
        let want_image = p.image == Some(true);
        let shot = ScreenshotFile::new(
            params.contains_key("window") && (want_image || p.screenshot.unwrap_or(true)),
        );
        if let Some(path) = shot.path() {
            params.insert("screenshotPath".into(), Value::String(path));
        }
        let mut picture = None;
        let outcome = self
            .inspect("desktop", Value::Object(params))
            .await
            .map(|mut ui| {
                let bytes = shot.take();
                if want_image {
                    picture.clone_from(&bytes);
                }
                let kept = bytes.filter(|_| p.screenshot.unwrap_or(true));
                // The window list is not a screen worth keeping.
                if ui.get("snapshot").is_some()
                    && let Some(id) =
                        self.observe(&peer, ObservationSource::InspectUi, request, &ui, kept)
                {
                    ui["observationId"] = json!(id);
                }
                truncate_snapshot(ui)
            });
        let mut result = self.finish("inspect_ui", &peer, None, outcome)?;
        if let Some(bytes) = picture {
            result.content.push(ContentBlock::image(
                spellsheet_core::review::base64(&bytes),
                "image/png",
            ));
        }
        Ok(result)
    }

    /// Run one step now, outside any flow, and return its output (and, for application steps such
    /// as browser.*, what the application shows afterwards). Steps share this MCP session's state, so
    /// you can walk through a site (open, log in, open a menu) before writing the flow. A step that
    /// reads variables ({{ row.顧客名 }}, an expression on `total`) is tried as written: give their
    /// values in `variables`, as they would be at that point of a run. The flow is not changed; what
    /// you saw is kept as an observation (observationId) to name in the edit it leads to.
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = false,
        open_world_hint = true
    ))]
    async fn test_step(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<TestStepParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let gated = match self.policy().and_then(|policy| {
            self.test_step_gate(&policy, &p.step, &p.variables, p.flow_id.as_deref())
        }) {
            Ok((gate, subs)) => self.gate(&peer, gate, &p.approval).await.map(|()| subs),
            Err(e) => Err(e),
        };
        let subflows = match gated {
            Ok(subs) => subs,
            Err(e) => return self.finish("test_step", &peer, None, Err(e)),
        };
        let request = to_value(&p.step);
        let shot = ScreenshotFile::new(p.step.step_type.starts_with("browser."));
        let outcome = self
            .test_step_inner(
                p.step,
                p.variables,
                subflows,
                p.flow_id.as_deref(),
                shot.path(),
            )
            .await
            .map(|mut result| {
                let id = self.observe(
                    &peer,
                    ObservationSource::TestStep,
                    request,
                    &result,
                    shot.take(),
                );
                if let Some(id) = id {
                    result["observationId"] = json!(id);
                }
                result
            });
        self.finish("test_step", &peer, None, outcome)
    }

    /// Request cancellation of a running flow.
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = false,
        open_world_hint = false
    ))]
    async fn stop_flow(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<RunRef>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = (|| -> Outcome {
            let id = run_id(&p.run_id)?;
            let runs = self
                .inner
                .runs
                .lock()
                .map_err(|_| err("INTERNAL", "run registry poisoned"))?;
            let run = runs.get(&id).ok_or_else(|| {
                err(
                    "RUN_NOT_ACTIVE",
                    format!("run {id} is not running in this server"),
                )
            })?;
            run.cancel.stop();
            Ok(json!({ "runId": id, "cancelRequested": true }))
        })();
        self.finish("stop_flow", &peer, None, outcome)
    }
}

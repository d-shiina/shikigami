//! Starting runs, running test cases and waiting for a login the user
//! registers.

use super::*;

impl SpellSheetMcp {
    /// The flows `flow` calls directly, with the variables a call
    /// maps, so an AI client can write `inputs` / `outputs` without
    /// fetching each one.
    pub(super) fn called_summaries(&self, flow: &spellsheet_core::Flow) -> Vec<Value> {
        spellsheet_core::call::called_ids(flow)
            .iter()
            .map(|id| match self.svc().get(id) {
                Ok(s) => {
                    let vars = |input: bool| -> Vec<Value> {
                        s.variables
                            .iter()
                            .filter(|v| {
                                if input {
                                    v.direction.is_input()
                                } else {
                                    v.direction.is_output()
                                }
                            })
                            .map(|v| {
                                let mut entry = json!({ "name": v.name, "type": v.var_type });
                                if input {
                                    entry["required"] = json!(v.default.is_none());
                                }
                                entry
                            })
                            .collect()
                    };
                    json!({
                        "id": s.id,
                        "name": s.name,
                        "revision": s.revision,
                        "inputs": vars(true),
                        "outputs": vars(false),
                    })
                }
                Err(_) => json!({ "id": id, "missing": true }),
            })
            .collect()
    }

    pub(super) fn run_status(&self, id: &RunId) -> Outcome {
        if let Ok(runs) = self.inner.runs.lock()
            && let Some(run) = runs.get(id)
        {
            let snapshot = run.snapshot.lock().map(|s| s.clone()).ok();
            return Ok(json!({ "runId": id, "active": true, "snapshot": snapshot }));
        }
        match record::read_report(self.svc().store().local_root(), id).map_err(io_err)? {
            Some(report) => Ok(json!({ "runId": id, "active": false, "report": report })),
            None => Err(err("RUN_NOT_FOUND", format!("no run {id}"))),
        }
    }

    pub(super) fn list_runs_inner(&self, p: &ListRunsParams) -> Outcome {
        let root = self.svc().store().local_root();
        let limit = p.limit.unwrap_or(20);
        let mut out = Vec::new();
        for id in record::list_runs(root).map_err(io_err)? {
            if out.len() >= limit {
                break;
            }
            let entry = match record::read_report(root, &id) {
                Ok(Some(r)) => json!({
                    "runId": r.run_id,
                    "flowId": r.flow_id,
                    "flowName": r.flow_name,
                    "revision": r.revision,
                    "status": r.status,
                    "startedAt": to_value(&r).get("startedAt"),
                    "finishedAt": to_value(&r).get("finishedAt"),
                    "errorCode": r.error.as_ref().map(|e| e.code.clone()),
                }),
                // No report yet: still running here or in another process, or crashed.
                _ => match self.run_status(&id) {
                    Ok(v) if v["active"] == json!(true) => json!({
                        "runId": id,
                        "flowId": v.pointer("/snapshot/flowId"),
                        "status": "running",
                    }),
                    _ => json!({ "runId": id, "status": "unknown" }),
                },
            };
            if let Some(filter) = &p.flow_id
                && entry.get("flowId").and_then(Value::as_str) != Some(filter.as_str())
            {
                continue;
            }
            out.push(entry);
        }
        Ok(json!({ "runs": out }))
    }

    /// Everything that can fail happens before the run starts, so a failed
    /// call never leaves an unrecorded, unstoppable run behind.
    pub(super) fn launch(
        &self,
        flow: spellsheet_core::Flow,
        version: Option<u32>,
        subflows: Vec<spellsheet_core::Subflow>,
        p: &RunFlowParams,
    ) -> Result<(RunId, RunHandle, RunRecorder), ErrorPayload> {
        let id = RunId::generate();
        let project_dir = self.svc().project_dir(&flow.id).ok();
        let root = self.svc().store().local_root();
        let recorder = RunRecorder::create(root, &id)
            .map_err(io_err)?
            .prune_on_finish(&Policy::path(self.svc().store().root()));
        let mut runs = self
            .inner
            .runs
            .lock()
            .map_err(|_| err("INTERNAL", "run registry poisoned"))?;
        let handle = match self.inner.runtime.start(
            flow,
            RunOptions {
                inputs: p.inputs.clone(),
                run_id: Some(id.clone()),
                version,
                subflows,
                project_dir,
                full_run: true,
                origin: RunOrigin::new(RunTrigger::Mcp),
                ..RunOptions::default()
            },
        ) {
            Ok(handle) => handle,
            Err(e) => {
                drop(recorder);
                let _ = std::fs::remove_dir_all(root.join("runs").join(id.as_str()));
                return Err(ErrorPayload {
                    code: e.code,
                    message: e.message,
                    details: e.details,
                });
            }
        };
        runs.insert(
            id.clone(),
            ActiveRun {
                cancel: handle.stopper(),
                snapshot: handle.snapshot_cell(),
            },
        );
        Ok((id, handle, recorder))
    }

    pub(super) async fn run_test_cases(
        &self,
        peer: &Peer<RoleServer>,
        p: &RunTestsParams,
    ) -> Outcome {
        use spellsheet_core::testcase;
        use spellsheet_runtime::testing;
        let flow = self.svc().get_runnable(&FlowId::new(p.flow_id.as_str()))?;
        let version = self.svc().matching_version(&flow).ok().flatten();
        let subflows = self.svc().subflows(&flow)?;
        let dir = self.svc().project_dir(&flow.id)?;
        let cases = match &p.cases {
            None => testcase::load_all(&dir)?,
            Some(names) => names
                .iter()
                .map(|name| testcase::load(&dir, name).map(|case| (name.clone(), case)))
                .collect::<Result<Vec<_>, _>>()?,
        };
        // One run per case named once: the approval below covers exactly these runs.
        if let Some((name, _)) = cases
            .iter()
            .enumerate()
            .find(|(i, (name, _))| cases[..*i].iter().any(|(other, _)| other == name))
            .map(|(_, c)| c)
        {
            return Err(err(
                "TEST_CASE_REPEATED",
                format!("'{name}' is named more than once in `cases`"),
            ));
        }
        if cases.is_empty() {
            return Err(err(
                "NO_TEST_CASES",
                format!(
                    "{} has no test cases; add them with save_test_case",
                    flow.id
                ),
            ));
        }
        // Secret values must not pass through the AI client.
        for (name, case) in &cases {
            if let Some(var) = flow
                .variables
                .iter()
                .find(|v| v.secret && case.inputs.contains_key(&v.name))
            {
                return Err(err(
                    "SECRET_INPUT_REJECTED",
                    format!("case '{name}' gives the secret input '{}'", var.name),
                ));
            }
        }
        let policy = self.policy()?;
        let (risk, step_types) = self
            .svc()
            .risk_of(std::iter::once(&flow).chain(subflows.iter().map(|s| &s.flow)));
        let ids: Vec<&str> = std::iter::once(flow.id.as_str())
            .chain(subflows.iter().map(|s| s.flow.id.as_str()))
            .collect();
        // In the order they run.
        let planned: Vec<Value> = cases
            .iter()
            .map(|(name, case)| json!({ "name": name, "inputs": case.inputs }))
            .collect();
        self.gate(
            peer,
            Gate {
                action: AiAction::RunFlow,
                decision: policy.ai_run(risk, &ids),
                risk,
                step_types,
                flow: Some((&flow.id, &flow.name)),
                subject: json!({
                    "flowId": flow.id,
                    "revision": flow.revision,
                    "version": version,
                    "published": false,
                    "testCases": planned,
                    "flows": snapshot_ids(&subflows),
                }),
            },
            &p.approval,
        )
        .await?;
        let policy_path = Policy::path(self.svc().store().root());
        let interrupt = testing::Interrupt::default();
        let mut results = Vec::new();
        for (name, case) in &cases {
            let options = RunOptions {
                inputs: case.inputs.clone(),
                version,
                subflows: subflows.clone(),
                project_dir: Some(dir.clone()),
                full_run: true,
                origin: RunOrigin::new(RunTrigger::Mcp).requested_by(format!("test:{name}")),
                ..RunOptions::default()
            };
            let records = testing::Records {
                workspace: self.svc().store().local_root(),
                policy: &policy_path,
            };
            // Listed among the active runs, so stop_flow with its runId stops it
            // (and the cases after it).
            let mut listed = None;
            let result = testing::run_case_with(
                &self.inner.runtime,
                records,
                &interrupt,
                name,
                case,
                flow.clone(),
                options,
                |handle| {
                    if let Ok(mut runs) = self.inner.runs.lock() {
                        runs.insert(
                            handle.run_id.clone(),
                            ActiveRun {
                                cancel: handle.stopper(),
                                snapshot: handle.snapshot_cell(),
                            },
                        );
                        listed = Some(handle.run_id.clone());
                    }
                },
            )
            .await;
            if let Some(id) = listed
                && let Ok(mut runs) = self.inner.runs.lock()
            {
                runs.remove(&id);
            }
            let result = result.map_err(|e| ErrorPayload {
                code: e.code,
                message: format!("{name}: {}", e.message),
                details: e.details,
            })?;
            let stopped = result.status == spellsheet_runtime::RunStatus::Cancelled;
            results.push(result);
            if stopped {
                break;
            }
        }
        let failed = results.iter().filter(|r| !r.passed).count();
        let outcomes = results
            .iter()
            .map(|r| CaseOutcome {
                name: r.name.clone(),
                passed: r.passed,
                run_id: r.run_id.clone(),
                status: to_value(&r.status).as_str().unwrap_or_default().to_owned(),
                mismatches: r.mismatches.clone(),
            })
            .collect();
        if let Err(e) = self.svc().record_test_evidence(
            &flow.id,
            flow.revision,
            EvidenceDetail::TestCases { results: outcomes },
            actor(peer),
        ) {
            tracing::warn!(error = %e, "failed to record test results");
        }
        Ok(json!({
            "flowId": flow.id,
            "passed": results.len() - failed,
            "failed": failed,
            "cases": results,
        }))
    }

    pub(super) async fn start_run(&self, peer: &Peer<RoleServer>, p: &RunFlowParams) -> Outcome {
        let actor = actor(peer);
        let flow_ref = FlowId::new(p.flow_id.as_str());
        let published = p.published.unwrap_or(false);
        let (flow, version, subflows) = if published {
            let run = self.svc().published_run(&flow_ref)?;
            (run.flow, Some(run.version), run.subflows)
        } else {
            let flow = self.svc().get_runnable(&flow_ref)?;
            let version = self.svc().matching_version(&flow).ok().flatten();
            let subflows = self.svc().subflows(&flow)?;
            (flow, version, subflows)
        };
        // Secret values must not pass through the AI client.
        if let Some(var) = flow
            .variables
            .iter()
            .find(|v| v.secret && p.inputs.contains_key(&v.name))
        {
            return Err(ErrorPayload {
                code: "SECRET_INPUT_REJECTED".into(),
                message: format!(
                    "'{}' is a secret input and cannot be given over MCP",
                    var.name
                ),
                details: Some(json!({
                    "hint": "Type passwords with a registered secret instead: browser.fill value { \"secret\": \"<name>\", \"field\": \"password\" } (list_secrets). Or ask the user to run the flow from Writer."
                })),
            });
        }
        let policy = self.policy()?;
        let (risk, step_types) = self
            .svc()
            .risk_of(std::iter::once(&flow).chain(subflows.iter().map(|s| &s.flow)));
        let ids: Vec<&str> = std::iter::once(flow.id.as_str())
            .chain(subflows.iter().map(|s| s.flow.id.as_str()))
            .collect();
        self.gate(
            peer,
            Gate {
                action: AiAction::RunFlow,
                decision: policy.ai_run(risk, &ids),
                risk,
                step_types,
                flow: Some((&flow.id, &flow.name)),
                subject: json!({
                    "flowId": flow.id,
                    "revision": flow.revision,
                    "version": version,
                    "published": published,
                    "inputs": p.inputs,
                    "flows": snapshot_ids(&subflows),
                }),
            },
            &p.approval,
        )
        .await?;
        let flow_id = flow.id.clone();
        let (id, handle, mut recorder) = self.launch(flow, version, subflows, p)?;
        let (tx, mut rx) = watch::channel(None);

        let inner = self.inner.clone();
        let task_id = id.clone();
        let run_actor = actor.clone();
        tokio::spawn(async move {
            let result = handle
                .wait_with(|event| {
                    if let Err(e) = recorder.write_event(event) {
                        tracing::warn!(error = %e, "failed to record run event");
                    }
                })
                .await;
            match result {
                Ok(report) => {
                    if let Err(e) = recorder.finish(&report) {
                        tracing::warn!(error = %e, "failed to write run report");
                    }
                    // Review evidence: what the AI's test run of this revision showed.
                    let run = TestRun {
                        run_id: report.run_id.clone(),
                        status: to_value(&report.status)
                            .as_str()
                            .unwrap_or_default()
                            .to_owned(),
                        error_code: report.error.as_ref().map(|e| e.code.clone()),
                        error_message: report.error.as_ref().map(|e| e.message.clone()),
                        step_id: report.error.as_ref().and_then(|e| e.step_id.clone()),
                        version: report.version,
                        started_at: report.started_at,
                        finished_at: report.finished_at,
                    };
                    // A run of the published version tests nothing new.
                    if !published
                        && let Err(e) =
                            inner
                                .service
                                .record_test_run(&flow_id, report.revision, run, run_actor)
                    {
                        tracing::warn!(error = %e, "failed to record test run");
                    }
                    let _ = tx.send(Some(report));
                }
                Err(e) => tracing::error!(error = %e, "run task failed"),
            }
            if let Ok(mut runs) = inner.runs.lock() {
                runs.remove(&task_id);
            }
        });

        let wait = p.wait_ms.unwrap_or(0).min(MAX_WAIT_MS);
        if wait > 0 {
            let finished =
                tokio::time::timeout(Duration::from_millis(wait), rx.wait_for(Option::is_some))
                    .await;
            if let Ok(Ok(report)) = finished
                && let Some(report) = report.as_ref()
            {
                return Ok(json!({ "runId": id, "finished": true, "report": report }));
            }
        }
        Ok(json!({ "runId": id, "finished": false }))
    }

    pub(super) async fn request_secret_inner(&self, p: RequestSecretParams) -> Outcome {
        let vault = &self.inner.vault;
        let request = vault
            .request(NewSecretRequest {
                name: p.name,
                kind: p.kind,
                sites: p.sites,
                fields: p.fields,
                reason: p.reason,
            })
            .map_err(secret_err)?;
        let name = request.name.clone();
        let check = || vault.missing(&name, &request.sites, &request.fields);
        let wait = Duration::from_millis(p.wait_ms.unwrap_or(0).min(MAX_WAIT_MS));
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            // Read before the vault: registering saves the secret first and
            // then drops the request, so a gone request with something still
            // missing means the user dismissed it.
            let requested = vault.is_requested(&name).map_err(secret_err)?;
            let missing = check().map_err(secret_err)?;
            if missing.is_empty() {
                // Already registered (or just now): nothing for Studio to show.
                // Another call may have merged more into the request, so it
                // is checked again as it stands now, not dismissed.
                let _ = vault.tidy_requests();
                let secret = vault
                    .summaries()
                    .map_err(secret_err)?
                    .into_iter()
                    .find(|s| s.name == name);
                return Ok(json!({
                    "status": "registered",
                    "secret": secret,
                    "hint": format!("Type it with browser.fill value {{ \"secret\": \"{name}\", \"field\": \"password\" }} (or \"username\" / \"totp\")."),
                }));
            }
            if !requested {
                return Ok(json!({
                    "status": "dismissed",
                    "name": name,
                    "hint": "The user closed the request in Writer without registering it. Ask them in chat how they want to log in (never for the password), or let them log in by hand with test_step browser.waitForHuman.",
                }));
            }
            if tokio::time::Instant::now() >= deadline {
                return Ok(json!({
                    "status": "waiting",
                    "request": request,
                    "missing": missing,
                    "hint": "Writer now asks the user to register this login in its own dialog. Tell the user in chat to open SpellSheet Writer and enter it there, never in chat. Then call request_secret again with waitMs, or list_secrets.",
                }));
            }
            tokio::time::sleep(SECRET_POLL.min(deadline - tokio::time::Instant::now())).await;
        }
    }
}

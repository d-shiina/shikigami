//! Tools that read flows, step types, history, versions and run records.

use super::*;

#[tool_router(router = read_tools, vis = "pub(super)")]
impl SpellSheetMcp {
    /// List all flows in the workspace (ID, name, revision, step count, and
    /// the `inputs` / `outputs` a `flow.call` to it can pass and receive).
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn list_flows(&self, peer: Peer<RoleServer>) -> Result<CallToolResult, ErrorData> {
        let outcome = self
            .svc()
            .list()
            .map(|s| json!({ "flows": s }))
            .map_err(Into::into);
        self.finish("list_flows", &peer, None, outcome)
    }

    /// Get a flow document: variables, settings and the step tree with step IDs.
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn get_flow(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<FlowRef>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = (|| -> Outcome {
            let id = FlowId::new(p.flow_id.as_str());
            let flow = self.svc().get(&id)?;
            let (can_undo, can_redo) = self.svc().undo_state(&id)?;
            let mut out = json!({ "flow": flow, "canUndo": can_undo, "canRedo": can_redo });
            let called = self.called_summaries(&flow);
            if !called.is_empty() {
                out["subflows"] = Value::Array(called);
            }
            let callers = self.svc().callers(&id)?;
            if !callers.is_empty() {
                out["calledBy"] = Value::Array(
                    callers
                        .iter()
                        .map(|c| json!({ "id": c.id, "name": c.name }))
                        .collect(),
                );
            }
            if let Some(feedback) = self.svc().open_feedback(&id)? {
                out["feedback"] = to_value(&feedback);
            }
            if let Some(published) = self.svc().published(&id)? {
                out["published"] = to_value(&published);
            }
            Ok(out)
        })();
        self.finish("get_flow", &peer, Some(&p.flow_id), outcome)
    }

    /// Validate a stored flow (flowId) or an unsaved document (flow).
    /// Returns every issue with a JSON Pointer path. A flow runs only when `valid` is true.
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn validate_flow(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<ValidateParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = match (&p.flow_id, &p.flow) {
            (Some(id), None) => self
                .svc()
                .validate_stored(&FlowId::new(id.as_str()))
                .map(|r| to_value(&r))
                .map_err(Into::into),
            (None, Some(flow)) => Ok(to_value(&self.svc().validate(flow))),
            _ => Err(err(
                "INVALID_ARGUMENT",
                "give exactly one of flowId or flow",
            )),
        };
        self.finish("validate_flow", &peer, p.flow_id.as_deref(), outcome)
    }

    /// List available step types with their descriptions and child blocks,
    /// and the functions usable in expressions and templates.
    /// Use get_step_schema for the params schema of a type.
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn list_step_types(&self, peer: Peer<RoleServer>) -> Result<CallToolResult, ErrorData> {
        let types: Vec<Value> = self
            .svc()
            .registry()
            .iter()
            .map(|d| {
                let mut entry = json!({
                    "type": d.step_type,
                    "category": d.category,
                    "label": d.label,
                    "description": d.description,
                    "blocks": d.blocks,
                    "hasOutput": d.has_output,
                    "expressionParams": d.expression_params,
                    "bindsVariables": d.binds_variables,
                    "risk": d.risk,
                });
                // Only when set, so the common case stays short.
                if let Some(deprecated) = &d.deprecated {
                    entry["deprecated"] = json!(deprecated);
                }
                if let Some(plugin) = &d.plugin {
                    entry["plugin"] = json!(plugin);
                }
                entry
            })
            .collect();
        self.finish(
            "list_step_types",
            &peer,
            None,
            Ok(json!({
                "stepTypes": types,
                "functions": spellsheet_core::expr::FUNCTION_DOCS,
            })),
        )
    }

    /// Get the full definition of a step type, including the JSON Schema of its params.
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn get_step_schema(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<StepTypeRef>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = match self.svc().registry().get(&p.step_type) {
            Some(def) => Ok(to_value(def)),
            None => Err(unknown_step_type(self.svc().registry(), &p.step_type)),
        };
        self.finish("get_step_schema", &peer, None, outcome)
    }

    /// Recent change history of a flow: who (Studio, MCP client, CLI) changed what, newest first.
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn get_history(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<HistoryParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = self
            .svc()
            .history(&FlowId::new(p.flow_id.as_str()), p.limit.unwrap_or(20))
            .map(|entries| {
                // The ops/inverse payloads are large and rarely useful to an AI.
                let entries: Vec<Value> = entries
                    .iter()
                    .map(|e| {
                        json!({
                            "revision": e.revision,
                            "kind": e.kind,
                            "actor": e.actor,
                            "at": e.at,
                            "label": e.label,
                            "summary": e.summary,
                            "checks": e.checks,
                            "stepIds": e.step_ids,
                        })
                    })
                    .collect();
                json!({ "entries": entries })
            })
            .map_err(Into::into);
        self.finish("get_history", &peer, Some(&p.flow_id), outcome)
    }

    /// What a human reviewing this flow sees: the changes since the last approval (with each
    /// change's summary and touched steps), your test runs, the screens you based changes on, and
    /// the reviews. `openFeedback` is a review that sent the flow back and still needs fixing.
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn get_review(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<GetReviewParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = self
            .svc()
            .review_timeline(&FlowId::new(p.flow_id.as_str()), p.since_revision)
            .map(|t| to_value(&t))
            .map_err(Into::into);
        self.finish("get_review", &peer, Some(&p.flow_id), outcome)
    }

    /// The workspace policy the user set: sites and programs steps may reach (empty: any), what
    /// you may do without asking (allow), only after the user approves in Studio (ask), or not at
    /// all (deny), by step risk; and per-flow settings. Only people change it.
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn get_policy(&self, peer: Peer<RoleServer>) -> Result<CallToolResult, ErrorData> {
        let outcome = self.policy().map(|p| json!({ "policy": p }));
        self.finish("get_policy", &peer, None, outcome)
    }

    /// Status of a run: live progress while running, the final report (status, outputs, error) once finished.
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn get_run_status(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<RunRef>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = run_id(&p.run_id).and_then(|id| self.run_status(&id));
        self.finish("get_run_status", &peer, None, outcome)
    }

    /// Events of a run (step started/finished, variable changes, logs, errors) in order. Use afterSeq to poll for new events, variable to trace one variable's values.
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn get_run_logs(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<RunLogsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = (|| -> Outcome {
            let id = run_id(&p.run_id)?;
            let root = self.svc().store().local_root();
            let events = match record::read_events(root, &id) {
                Ok(events) => events,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    return Err(err("RUN_NOT_FOUND", format!("no run {id}")));
                }
                Err(e) => return Err(io_err(e)),
            };
            let limit = p.limit.unwrap_or(DEFAULT_LOG_LIMIT);
            let selected: Vec<_> = events
                .into_iter()
                .filter(|e| p.after_seq.is_none_or(|after| e.seq > after))
                .filter(|e| {
                    p.variable.as_ref().is_none_or(|name| {
                        matches!(&e.event, RunEvent::VariableChanged { variable, .. } if variable == name)
                    })
                })
                .take(limit)
                .collect();
            let last_seq = selected.last().map(|e| e.seq).or(p.after_seq);
            let finished = record::read_report(root, &id).map_err(io_err)?.is_some();
            Ok(json!({ "events": selected, "lastSeq": last_seq, "finished": finished }))
        })();
        self.finish("get_run_logs", &peer, None, outcome)
    }

    /// Named versions of a flow, newest first (number, name, note, who, when).
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn list_versions(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<FlowRef>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = (|| -> Outcome {
            let id = FlowId::new(p.flow_id.as_str());
            let versions = self.svc().list_versions(&id)?;
            let published = self.svc().published(&id)?;
            Ok(json!({ "versions": versions, "published": published }))
        })();
        self.finish("list_versions", &peer, Some(&p.flow_id), outcome)
    }

    /// One version including the full flow snapshot.
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn get_version(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<VersionRef>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = self
            .svc()
            .get_version(&FlowId::new(p.flow_id.as_str()), p.number)
            .map(|v| to_value(&v))
            .map_err(Into::into);
        self.finish("get_version", &peer, Some(&p.flow_id), outcome)
    }

    /// What changed between two versions, by step ID: added, removed, changed (with the fields)
    /// and moved steps, plus variable and flow-level changes. Defaults: from = latest version,
    /// to = current content.
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn diff_versions(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<DiffVersionsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let id = FlowId::new(p.flow_id.as_str());
        let outcome = (|| -> Outcome {
            let from = match p.from {
                Some(n) => Some(n),
                None => self.svc().latest_version(&id)?,
            };
            Ok(to_value(&self.svc().diff_versions(&id, from, p.to)?))
        })();
        self.finish("diff_versions", &peer, Some(&p.flow_id), outcome)
    }

    /// Export a flow for another workspace or person. With `path`, writes the `.spx` file the user
    /// hands over (published version, the flows it calls, its folder's files except input/; logins
    /// by name only) and returns what it holds and needs. Without `path`, returns a JSON bundle
    /// for import_flow. Defaults of secret variables are removed either way.
    /// (Marked read-only: a read-only server refuses `path`, and the file is new, never overwritten.)
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn export_flow(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<ExportFlowParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let id = FlowId::new(p.flow_id.as_str());
        let outcome = match p.path.as_deref() {
            Some(path) => self.export_package_to(&id, path, &p),
            None => self
                .svc()
                .export(&id, p.include_versions.unwrap_or(true))
                .map(|b| json!({ "bundle": b }))
                .map_err(Into::into),
        };
        self.finish("export_flow", &peer, Some(&p.flow_id), outcome)
    }

    fn export_package_to(&self, id: &FlowId, path: &str, p: &ExportFlowParams) -> Outcome {
        use spellsheet_core::package::{
            PACKAGE_EXTENSION, PackageContent, PackageOptions, PackageVersions,
        };
        let options = PackageOptions {
            content: if p.current.unwrap_or(false) {
                PackageContent::Current
            } else {
                PackageContent::Auto
            },
            versions: if p.include_versions == Some(false) {
                PackageVersions::None
            } else {
                PackageVersions::Content
            },
            include_input: p.include_input.unwrap_or(false),
            exclude: Vec::new(),
            only: None,
            exported_by: std::env::var("USERNAME").ok(),
        };
        if !self.inner.can_write {
            return Err(err(
                "READ_ONLY",
                "this server is read-only; export_flow without path returns the bundle instead",
            ));
        }
        let (manifest, bytes) = self.svc().export_package(id, &options)?;
        let target = std::path::Path::new(path);
        let file = if target.is_dir() {
            target.join(spellsheet_core::package::file_name(
                &manifest.flow.name,
                manifest.flow.version.as_ref().map(|v| v.number),
            ))
        } else if target.extension().is_some_and(|e| e == PACKAGE_EXTENSION) {
            target.to_path_buf()
        } else {
            return Err(err(
                "INVALID_PATH",
                format!("path must be a folder or end with .{PACKAGE_EXTENSION}"),
            ));
        };
        if file.exists() {
            return Err(err(
                "FILE_EXISTS",
                format!("{} already exists; choose another name", file.display()),
            ));
        }
        std::fs::write(&file, &bytes)
            .map_err(|e| err("WRITE_FAILED", format!("{}: {e}", file.display())))?;
        Ok(json!({
            "path": file.to_string_lossy(),
            "manifest": manifest,
            "hint": "Tell the user the file name and what the receiver needs (manifest.requires: extensions, logins by name, sites). Logins are never in the file.",
        }))
    }

    /// Recent runs (newest first), optionally only those of one flow.
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn list_runs(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<ListRunsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = self.list_runs_inner(&p);
        self.finish("list_runs", &peer, p.flow_id.as_deref(), outcome)
    }

    /// Secrets the user registered in SpellSheet Writer: names, the sites each may be typed into, and
    /// which fields are set (username, password, totp). Values are never returned. Use a name in
    /// browser.fill: value { "secret": "<name>", "field": "password" }. Several accounts of one
    /// site are separate secrets (listed under `sameSite`): never pick one yourself. Ask the user
    /// which, or let the person pick each run: an input variable whose `choices` are those names,
    /// and { "secret": "{{ <variable> }}", "field": .. } in every step that logs in (also as
    /// browser.open `session`, so each account keeps its own login).
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn list_secrets(&self, peer: Peer<RoleServer>) -> Result<CallToolResult, ErrorData> {
        let outcome = self
            .inner
            .vault
            .summaries()
            .map(|secrets| {
                let same_site = same_site(&secrets);
                let mut out = json!({
                    "secrets": secrets,
                    "hint": "Missing one? Call request_secret with a name and the site: Writer asks the user to register it. Never ask for the values in chat.",
                });
                if !same_site.is_empty() {
                    out["sameSite"] = json!(same_site);
                    out["sameSiteHint"] = json!("These sites have several accounts. Do not choose one yourself: ask the user which one the flow should use, or make an input variable with those names as `choices` and write { \"secret\": \"{{ variable }}\" } so the person picks one each run.");
                }
                out
            })
            .map_err(secret_err);
        self.finish("list_secrets", &peer, None, outcome)
    }

    /// Ask the user for a login you need (e.g. the site shows a login page and list_secrets has no
    /// fitting secret, or a step failed with SECRET_NOT_FOUND / SECRET_FIELD_EMPTY / SECRET_SITE_*).
    /// Studio shows the user a registration form with the name and site filled in; the user types
    /// the values there and you never see them. Also tell the user in chat to enter it in
    /// SpellSheet Writer. status: `registered` (use it: browser.fill value { "secret": name,
    /// "field": "password" }), `waiting` (call again with waitMs, or list_secrets later) or
    /// `dismissed` (the user declined: ask how they want to log in).
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = false,
        open_world_hint = false
    ))]
    async fn request_secret(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<RequestSecretParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = self.request_secret_inner(p).await;
        self.finish("request_secret", &peer, None, outcome)
    }
}

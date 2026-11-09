//! Tools for versions, importing, sub-flows and test cases.

use super::*;

#[tool_router(router = version_tools, vis = "pub(super)")]
impl SpellSheetMcp {
    /// Save the flow's current content as a named version (e.g. "v1", "本番リリース").
    /// Versions are immutable snapshots shared with everyone using the workspace.
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = false,
        open_world_hint = false
    ))]
    async fn create_version(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<CreateVersionParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = self
            .svc()
            .create_version(
                &FlowId::new(p.flow_id.as_str()),
                NewVersion {
                    name: p.name,
                    note: p.note,
                },
                p.expected_revision,
                actor(&peer),
            )
            .map(|v| json!({ "version": v }))
            .map_err(Into::into);
        self.finish("create_version", &peer, Some(&p.flow_id), outcome)
    }

    /// Make the flow's content equal to a version again. Applied as one undoable edit;
    /// does nothing when the content already matches. Only when the user asked for it.
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = false,
        open_world_hint = false
    ))]
    async fn restore_version(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<RestoreVersionParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = self
            .svc()
            .restore_version(
                &FlowId::new(p.flow_id.as_str()),
                p.number,
                p.expected_revision,
                actor(&peer),
            )
            .map(|o| to_value(&o))
            .map_err(Into::into);
        self.finish("restore_version", &peer, Some(&p.flow_id), outcome)
    }

    /// Import a flow: a `.spx` file the user was handed (`path`), or a bundle from export_flow.
    /// The flow keeps its ID; if that ID exists the call fails with IMPORT_CONFLICT unless
    /// onConflict is given. With `check`, imports nothing and returns what the file holds, the
    /// difference from the flow here, and what this PC still needs. An imported flow does not run
    /// unattended until a person publishes it here.
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = false,
        open_world_hint = false
    ))]
    async fn import_flow(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<ImportFlowParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = self.import_flow_inner(&peer, p);
        let id = outcome
            .as_ref()
            .ok()
            .and_then(|v| v.pointer("/flow/id"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        self.finish("import_flow", &peer, id.as_deref(), outcome)
    }

    fn import_flow_inner(&self, peer: &Peer<RoleServer>, p: ImportFlowParams) -> Outcome {
        let value = match (p.bundle, p.path.as_deref()) {
            (Some(bundle), None) => bundle,
            (None, Some(path)) => {
                let bytes = std::fs::read(path)
                    .map_err(|e| err("FILE_NOT_FOUND", format!("{path}: {e}")))?;
                if p.check.unwrap_or(false) {
                    let secrets: Vec<String> = self
                        .inner
                        .vault
                        .summaries()
                        .map(|list| list.into_iter().map(|s| s.name).collect())
                        .unwrap_or_default();
                    return Ok(to_value(&self.svc().preview_file(&bytes, &secrets)?));
                }
                spellsheet_core::service::file_to_bundle_value(&bytes)?
            }
            _ => {
                return Err(err(
                    "INVALID_PARAMS",
                    "give either bundle or path (a .spx file)",
                ));
            }
        };
        Ok(to_value(&self.svc().import_bundle(
            value,
            p.on_conflict,
            actor(peer),
        )?))
    }

    /// Move steps that sit next to each other in one block into a new flow and replace them
    /// with one flow.call step, so a long flow reads as a few named parts. The call passes
    /// the variables the steps read as inputs and writes back the ones they change, so the
    /// flow behaves as before. Returns both flows and the new step's ID.
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = false,
        open_world_hint = false
    ))]
    async fn extract_subflow(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<ExtractSubflowParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let ids: Vec<StepId> = p.step_ids.iter().map(StepId::new).collect();
        let outcome = self
            .svc()
            .extract_subflow(
                &FlowId::new(p.flow_id.as_str()),
                p.expected_revision,
                &ids,
                &p.name,
                actor(&peer),
                change_note(p.summary, p.checks, Vec::new()),
            )
            .map(|o| {
                json!({
                    "flow": o.caller.flow,
                    "validation": o.caller.validation,
                    "subflow": o.subflow.flow,
                    "subflowValidation": o.subflow.validation,
                    "callStepId": o.call_step_id,
                })
            })
            .map_err(Into::into);
        self.finish("extract_subflow", &peer, Some(&p.flow_id), outcome)
    }

    /// Save a test case of a flow (`tests/<name>.json` in its folder): a promise of what
    /// the flow does, in `description` (business words; Studio shows it to the person
    /// reviewing your change), inputs to run it with and what should come out (`expect.status`, `expect.outputs` (a subset),
    /// `expect.errorCode`, `expect.errorStep`). Run the cases with run_tests. Read
    /// existing ones with list_project_files / read_project_file (`tests/`).
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = false,
        open_world_hint = false
    ))]
    async fn save_test_case(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<SaveTestCaseParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = (|| {
            let id = FlowId::new(p.flow_id.as_str());
            let flow = self.svc().get(&id)?;
            let dir = self.svc().project_dir(&id)?;
            if let Some(name) = p.case.inputs.keys().find(|n| {
                !flow
                    .variables
                    .iter()
                    .any(|v| &v.name == *n && v.direction.is_input())
            }) {
                return Err(err(
                    "TEST_CASE_UNKNOWN_INPUT",
                    format!("'{name}' is not an input variable of {id}"),
                ));
            }
            if let Some(var) = flow
                .variables
                .iter()
                .find(|v| v.secret && p.case.inputs.contains_key(&v.name))
            {
                return Err(err(
                    "SECRET_INPUT_REJECTED",
                    format!(
                        "'{}' is a secret input and cannot be kept in a test case",
                        var.name
                    ),
                ));
            }
            if !p.overwrite && spellsheet_core::testcase::exists(&dir, &p.name)? {
                return Err(err(
                    "TEST_CASE_EXISTS",
                    format!(
                        "{id} already has a test case '{}'; pass overwrite: true to replace it",
                        p.name
                    ),
                ));
            }
            let replaced = spellsheet_core::testcase::exists(&dir, &p.name)?;
            let path = spellsheet_core::testcase::save(&dir, &p.name, &p.case)?;
            // The review shows the cases an AI wrote as its promises.
            if let Err(e) = self.svc().record_test_evidence(
                &id,
                flow.revision,
                EvidenceDetail::TestCase {
                    name: p.name.clone(),
                    description: p.case.description.clone(),
                    replaced,
                },
                actor(&peer),
            ) {
                tracing::warn!(error = %e, "failed to record test case");
            }
            let relative = path
                .strip_prefix(&dir)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            Ok(json!({ "name": p.name, "path": relative }))
        })();
        self.finish("save_test_case", &peer, Some(&p.flow_id), outcome)
    }

    /// Run a flow's test cases (`tests/` in its folder; all, or `cases`) one after another
    /// with the working content, and compare each with what it expects. Returns `passed`,
    /// `failed` and `cases[]` (`passed`, `runId`, `status`, `error`, `mismatches[]` of `at`,
    /// `expected`, `actual`). Each case is an ordinary run (get_run_logs with its runId).
    /// Waits until all have run; stop_flow with the running case's runId (list_runs)
    /// stops it and the cases after it.
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = false,
        open_world_hint = true
    ))]
    async fn run_tests(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<RunTestsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = self.run_test_cases(&peer, &p).await;
        self.finish("run_tests", &peer, Some(&p.flow_id), outcome)
    }
}

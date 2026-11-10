//! Tools that change flows and the files in their project folders.

use super::*;

#[tool_router(router = edit_tools, vis = "pub(super)")]
impl SpellSheetMcp {
    /// Create a flow. Steps may omit IDs. Drafts may be invalid; check the returned validation.
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = false,
        open_world_hint = false
    ))]
    async fn create_flow(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<CreateFlowParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let input = NewFlow {
            name: p.name,
            description: p.description,
            variables: p.variables,
            steps: p.steps,
            tags: p.tags,
        };
        let note = change_note(p.summary, p.checks, p.observations);
        let outcome = self
            .svc()
            .create_noted(input, actor(&peer), note)
            .map(|o| to_value(&o))
            .map_err(Into::into);
        let id = outcome
            .as_ref()
            .ok()
            .and_then(|v| v.pointer("/flow/id"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        self.finish("create_flow", &peer, id.as_deref(), outcome)
    }

    /// Apply several edit operations atomically as one revision (addStep, updateStep, removeStep,
    /// moveStep, updateFlow, setVariable, removeVariable, setPart, removePart, replaceSteps).
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = false,
        open_world_hint = false
    ))]
    async fn update_flow(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<UpdateFlowParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let note = change_note(p.summary, p.checks, p.observations);
        let outcome = self.edit(&peer, &p.flow_id, p.expected_revision, p.ops, note);
        self.finish("update_flow", &peer, Some(&p.flow_id), outcome)
    }

    /// Insert a step (with children) at a position; appends to the top level by default.
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = false,
        open_world_hint = false
    ))]
    async fn add_step(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<AddStepParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let ops = vec![EditOp::AddStep {
            step: p.step,
            position: p.position,
        }];
        let note = change_note(p.summary, p.checks, p.observations);
        let outcome = self.edit(&peer, &p.flow_id, p.expected_revision, ops, note);
        self.finish("add_step", &peer, Some(&p.flow_id), outcome)
    }

    /// Change a step's params or settings with a partial patch.
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = false,
        open_world_hint = false
    ))]
    async fn update_step(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<UpdateStepParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let ops = vec![EditOp::UpdateStep {
            step_id: StepId::new(p.step_id),
            patch: p.patch,
        }];
        let note = change_note(p.summary, p.checks, p.observations);
        let outcome = self.edit(&peer, &p.flow_id, p.expected_revision, ops, note);
        self.finish("update_step", &peer, Some(&p.flow_id), outcome)
    }

    /// Remove a step and its children (undoable).
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = false,
        open_world_hint = false
    ))]
    async fn remove_step(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<RemoveStepParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let ops = vec![EditOp::RemoveStep {
            step_id: StepId::new(p.step_id),
        }];
        let note = change_note(p.summary, p.checks, p.observations);
        let outcome = self.edit(&peer, &p.flow_id, p.expected_revision, ops, note);
        self.finish("remove_step", &peer, Some(&p.flow_id), outcome)
    }

    /// Move a step to another position or into a control-flow block.
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = false,
        open_world_hint = false
    ))]
    async fn move_step(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<MoveStepParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let ops = vec![EditOp::MoveStep {
            step_id: StepId::new(p.step_id),
            position: p.position,
        }];
        let note = change_note(p.summary, p.checks, p.observations);
        let outcome = self.edit(&peer, &p.flow_id, p.expected_revision, ops, note);
        self.finish("move_step", &peer, Some(&p.flow_id), outcome)
    }

    /// Undo the latest change to a flow, whoever made it (shared with Studio and the CLI).
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = false,
        open_world_hint = false
    ))]
    async fn undo(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<RevisionedRef>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = self
            .svc()
            .undo(
                &FlowId::new(p.flow_id.as_str()),
                p.expected_revision,
                actor(&peer),
            )
            .map(|o| to_value(&o))
            .map_err(Into::into);
        self.finish("undo", &peer, Some(&p.flow_id), outcome)
    }

    /// Redo the latest undone change to a flow.
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = false,
        open_world_hint = false
    ))]
    async fn redo(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<RevisionedRef>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = self
            .svc()
            .redo(
                &FlowId::new(p.flow_id.as_str()),
                p.expected_revision,
                actor(&peer),
            )
            .map(|o| to_value(&o))
            .map_err(Into::into);
        self.finish("redo", &peer, Some(&p.flow_id), outcome)
    }

    /// Move a flow to the workspace trash. Requires the revision you last read.
    /// Only do this when the user explicitly asked to delete the flow.
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = true,
        open_world_hint = false
    ))]
    async fn delete_flow(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<DeleteFlowParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = async {
            let id = FlowId::new(p.flow_id.as_str());
            let flow = self.svc().get(&id)?;
            let policy = self.policy()?;
            self.gate(
                &peer,
                Gate {
                    action: AiAction::DeleteFlow,
                    decision: policy.ai_delete(),
                    risk: RiskLevel::Dangerous,
                    step_types: Vec::new(),
                    flow: Some((&id, &flow.name)),
                    subject: json!({ "flowId": id, "expectedRevision": p.expected_revision }),
                },
                &p.approval,
            )
            .await?;
            self.svc()
                .delete(&id, Some(p.expected_revision), actor(&peer))?;
            Ok(json!({ "deleted": p.flow_id, "movedToTrash": true }))
        }
        .await;
        self.finish("delete_flow", &peer, Some(&p.flow_id), outcome)
    }

    // -- project files ------------------------------------------------------

    /// The files in a flow's folder (input/, config/, templates/, output/,
    /// work/, logs/ and any folders of its own), with each file's path relative
    /// to the folder: write that path as is in a step's path param.
    /// `needed` lists the input/ files the steps read that are not there yet:
    /// ask the user where each comes from (put it in input/, or a file server
    /// or synced cloud storage folder kept as a `folder` setting in config/,
    /// or cloud storage reached through its API: config/cloud.json). `cloud`
    /// is that setting; with an input place, missing files are fetched at
    /// each run and none are `needed`.
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn list_project_files(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<FlowRef>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = self
            .svc()
            .project_files(&FlowId::new(p.flow_id.as_str()))
            .map(|files| to_value(&files))
            .map_err(Into::into);
        self.finish("list_project_files", &peer, Some(&p.flow_id), outcome)
    }

    /// Read a text file (config, CSV, JSON, log; UTF-8, up to 1 MB) from a
    /// flow's folder. For Excel, Word and PDF files use test_step with
    /// excel.readRange / word.readText / pdf.readText and the relative path.
    #[tool(annotations(read_only_hint = true, open_world_hint = false))]
    async fn read_project_file(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<ProjectFileRef>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = (|| {
            let id = FlowId::new(p.flow_id.as_str());
            let bytes = self.svc().read_project_file(&id, &p.path)?;
            let limit =
                usize::try_from(spellsheet_core::project::MAX_TEXT_READ).unwrap_or(usize::MAX);
            if bytes.len() > limit {
                return Err(err_hint(
                    "PROJECT_FILE_TOO_LARGE",
                    format!(
                        "{} is {} bytes; read_project_file returns up to 1 MB",
                        p.path,
                        bytes.len()
                    ),
                    "Read it in the flow instead (file.readCsv, excel.readRows), or try a step with test_step.",
                ));
            }
            let text = String::from_utf8(bytes.clone())
                .ok()
                .filter(|t| !t.contains('\0'))
                .ok_or_else(|| {
                    err_hint(
                        "PROJECT_FILE_NOT_TEXT",
                        format!("{} is not UTF-8 text", p.path),
                        "For Excel, Word and PDF files use test_step with excel.readRange, word.readText or pdf.readText and this relative path (pass flowId). A Shift_JIS CSV reads with file.readCsv.",
                    )
                })?;
            Ok(json!({ "path": p.path, "text": text }))
        })();
        self.finish("read_project_file", &peer, Some(&p.flow_id), outcome)
    }

    /// Put a file into a flow's folder: `text` for a settings, CSV or JSON
    /// file you write, or `copyFrom` to copy a file the user named on this PC
    /// (an input workbook, a template). Missing folders are created.
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = false,
        open_world_hint = false
    ))]
    async fn write_project_file(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<WriteProjectFileParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = (|| {
            let id = FlowId::new(p.flow_id.as_str());
            let file = match (&p.text, &p.copy_from) {
                (Some(text), None) => {
                    self.svc()
                        .write_project_file(&id, &p.path, text.as_bytes(), p.overwrite)?
                }
                (None, Some(from)) => self.svc().copy_into_project(
                    &id,
                    std::path::Path::new(from),
                    &p.path,
                    p.overwrite,
                )?,
                _ => {
                    return Err(err(
                        "INVALID_PARAMS",
                        "give exactly one of `text` and `copyFrom`",
                    ));
                }
            };
            Ok(to_value(&file))
        })();
        self.finish("write_project_file", &peer, Some(&p.flow_id), outcome)
    }

    /// Move a file or folder of a flow's folder to the workspace trash
    /// (a standard folder such as work/ is emptied instead). Only when the
    /// user asked for it.
    #[tool(annotations(
        read_only_hint = false,
        destructive_hint = true,
        open_world_hint = false
    ))]
    async fn delete_project_file(
        &self,
        peer: Peer<RoleServer>,
        Parameters(p): Parameters<ProjectFileRef>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = self
            .svc()
            .delete_project_file(&FlowId::new(p.flow_id.as_str()), &p.path)
            .map(|()| json!({ "deleted": p.path, "movedToTrash": true }))
            .map_err(Into::into);
        self.finish("delete_project_file", &peer, Some(&p.flow_id), outcome)
    }
}

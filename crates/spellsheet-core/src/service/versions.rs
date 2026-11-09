//! Named versions of a flow, publishing (the version that runs
//! unattended) and the runs that use the published version.

use super::*;

impl FlowService {
    /// Saves the current content as a new named version.
    pub fn create_version(
        &self,
        id: &FlowId,
        input: NewVersion,
        expected_revision: Option<u64>,
        actor: Actor,
    ) -> CoreResult<VersionSummary> {
        let name = input.name.trim();
        if name.is_empty() {
            return Err(CoreError::InvalidEdit(
                "version name must not be empty".into(),
            ));
        }
        let _lock = self.store.lock()?;
        let current = self.store.load(id)?;
        check_revision(expected_revision, current.revision)?;
        let number = self.next_version_number(id)?;
        let mut flow = current;
        flow.schema_ref = None;
        let version = FlowVersion {
            number,
            uid: uuid::Uuid::now_v7().simple().to_string(),
            name: name.to_owned(),
            note: input.note.trim().to_owned(),
            created_at: now(),
            created_by: actor,
            revision: flow.revision,
            flow,
        };
        self.store.save_version(&version)?;
        Ok(version.summary())
    }

    /// Versions of a flow, newest first.
    pub fn list_versions(&self, id: &FlowId) -> CoreResult<Vec<VersionSummary>> {
        let mut versions: Vec<_> = self
            .store
            .load_versions(id)?
            .iter()
            .map(FlowVersion::summary)
            .collect();
        versions.reverse();
        Ok(versions)
    }

    pub fn get_version(&self, id: &FlowId, number: u32) -> CoreResult<FlowVersion> {
        self.store.load_version(id, number)
    }

    /// Number of the newest version, if any.
    pub fn latest_version(&self, id: &FlowId) -> CoreResult<Option<u32>> {
        Ok(self.store.load_versions(id)?.last().map(|v| v.number))
    }

    /// Newest version whose content equals `flow` (e.g. to label a run).
    pub fn matching_version(&self, flow: &Flow) -> CoreResult<Option<u32>> {
        Ok(self
            .store
            .load_versions(&flow.id)?
            .iter()
            .rev()
            .find(|v| version::same_content(&v.flow, flow))
            .map(|v| v.number))
    }

    /// Differences from version `from` to version `to`; `None` means the
    /// current content.
    pub fn diff_versions(
        &self,
        id: &FlowId,
        from: Option<u32>,
        to: Option<u32>,
    ) -> CoreResult<FlowDiff> {
        let current = self.get(id)?;
        let load = |n: Option<u32>| n.map(|n| self.get_version(id, n)).transpose();
        let (from_v, to_v) = (load(from)?, load(to)?);
        let from_s = from_v.as_ref().map_or(&current, |v| &v.flow);
        let to_s = to_v.as_ref().map_or(&current, |v| &v.flow);
        Ok(version::diff(
            (from_s, version::side(from_v.as_ref(), &current)),
            (to_s, version::side(to_v.as_ref(), &current)),
        ))
    }

    /// Makes the current content equal to a version, as one undoable edit.
    /// Does nothing (and returns the current state) when it already matches.
    pub fn restore_version(
        &self,
        id: &FlowId,
        number: u32,
        expected_revision: Option<u64>,
        actor: Actor,
    ) -> CoreResult<EditOutcome> {
        let target = self.get_version(id, number)?;
        let label = format!("restore version {number} ({})", target.name);
        self.match_content(
            id,
            &target.flow,
            expected_revision,
            actor,
            label,
            Remarks::default(),
        )
    }

    pub(super) fn match_content(
        &self,
        id: &FlowId,
        target: &Flow,
        expected_revision: Option<u64>,
        actor: Actor,
        label: String,
        remarks: Remarks,
    ) -> CoreResult<EditOutcome> {
        let current = self.get(id)?;
        check_revision(expected_revision, current.revision)?;
        let ops = version::ops_to_match(&current, target);
        if ops.is_empty() {
            return self.current_outcome(current);
        }
        self.commit(
            id,
            expected_revision.or(Some(current.revision)),
            actor,
            ChangeKind::Edit,
            remarks,
            |_, current| {
                let (next, inverse) = ops::apply_all(current, ops.clone())?;
                Ok(Commit {
                    next,
                    applied: ops,
                    inverse,
                    label,
                })
            },
        )
    }

    pub(super) fn current_outcome(&self, flow: Flow) -> CoreResult<EditOutcome> {
        let (can_undo, can_redo) = self.undo_state(&flow.id)?;
        let validation = self.validate(&flow);
        Ok(EditOutcome {
            flow,
            validation,
            can_undo,
            can_redo,
        })
    }

    pub(super) fn next_version_number(&self, id: &FlowId) -> CoreResult<u32> {
        Ok(self
            .store
            .load_versions(id)?
            .last()
            .map_or(1, |v| v.number + 1))
    }

    // -- publishing -------------------------------------------------------

    /// The version unattended runs execute, if one is published.
    pub fn published(&self, id: &FlowId) -> CoreResult<Option<PublishedState>> {
        let Some((record, version)) = self.published_entry(id)? else {
            return Ok(None);
        };
        let matches_current = self
            .store
            .load(id)
            .is_ok_and(|current| version::same_content(&version.flow, &current));
        Ok(Some(PublishedState {
            version: version.number,
            name: version.name,
            revision: version.revision,
            published_at: record.at,
            published_by: record.by,
            note: record.note,
            matches_current,
        }))
    }

    /// Snapshot of the published version.
    pub fn published_version(&self, id: &FlowId) -> CoreResult<Option<FlowVersion>> {
        Ok(self.published_entry(id)?.map(|(_, v)| v))
    }

    pub(super) fn published_entry(
        &self,
        id: &FlowId,
    ) -> CoreResult<Option<(PublishRecord, FlowVersion)>> {
        let Some(record) = self.store.read_publish_log(id)?.pop() else {
            return Ok(None);
        };
        let Some(number) = record.version else {
            return Ok(None);
        };
        match self.store.load_version(id, number) {
            Ok(v) if record.uid.as_ref().is_none_or(|uid| *uid == v.uid) => Ok(Some((record, v))),
            Ok(_) | Err(CoreError::VersionNotFound { .. }) => {
                tracing::warn!(flow = %id, number, "published version is missing");
                Ok(None)
            }
            Err(e) => Err(e),
        }
    }

    /// Makes a version the one unattended runs execute. Only people publish
    /// (Studio, the CLI): an AI client gets `PUBLISH_NOT_ALLOWED`. Without
    /// `input.version` the current content is published, saved as a new
    /// version first unless one already matches it. The version must
    /// validate, and every flow it calls must be published already.
    pub fn publish(
        &self,
        id: &FlowId,
        input: PublishInput,
        actor: Actor,
    ) -> CoreResult<PublishedState> {
        ensure_person(&actor, "publish a flow")?;
        let version = match input.version {
            Some(number) => self.get_version(id, number)?,
            None => {
                let current = self.get(id)?;
                check_revision(input.expected_revision, current.revision)?;
                let existing = self
                    .store
                    .load_versions(id)?
                    .into_iter()
                    .rev()
                    .find(|v| version::same_content(&v.flow, &current));
                match existing {
                    Some(v) => v,
                    None => {
                        // Checked before a version is saved for nothing.
                        self.check_publishable(&current)?;
                        let name = input
                            .name
                            .as_deref()
                            .map(str::trim)
                            .filter(|n| !n.is_empty())
                            .map_or_else(
                                || self.next_version_number(id).map(|n| format!("v{n}")),
                                |n| Ok(n.to_owned()),
                            )?;
                        let created = self.create_version(
                            id,
                            NewVersion {
                                name,
                                note: input.note.clone(),
                            },
                            Some(current.revision),
                            actor.clone(),
                        )?;
                        self.get_version(id, created.number)?
                    }
                }
            }
        };
        self.check_publishable(&version.flow)?;
        {
            let _lock = self.store.lock()?;
            self.store.append_publish(
                id,
                &PublishRecord {
                    version: Some(version.number),
                    uid: Some(version.uid.clone()),
                    at: now(),
                    by: actor,
                    note: input.note.trim().to_owned(),
                },
            )?;
        }
        self.published(id)?.ok_or_else(|| {
            CoreError::InvalidEdit("published version could not be read back".into())
        })
    }

    /// Approves the current revision in review and publishes it, in one
    /// step (Studio's review desk). Nothing is recorded when publishing
    /// fails.
    pub fn approve_and_publish(
        &self,
        id: &FlowId,
        revision: u64,
        reason: String,
        input: PublishInput,
        actor: Actor,
    ) -> CoreResult<PublishedState> {
        ensure_person(&actor, "approve and publish a flow")?;
        let published = self.publish(
            id,
            PublishInput {
                version: None,
                expected_revision: Some(revision),
                ..input
            },
            actor.clone(),
        )?;
        self.submit_review(
            id,
            NewReview {
                revision,
                verdict: ReviewVerdict::Approved,
                reason,
                steps: Vec::new(),
            },
            actor,
        )?;
        Ok(published)
    }

    /// Stops unattended runs of a flow until a version is published
    /// again. People only, like [`Self::publish`].
    pub fn unpublish(&self, id: &FlowId, note: String, actor: Actor) -> CoreResult<()> {
        ensure_person(&actor, "withdraw a published flow")?;
        if self.published_entry(id)?.is_none() {
            return Ok(());
        }
        let _lock = self.store.lock()?;
        self.store.append_publish(
            id,
            &PublishRecord {
                version: None,
                uid: None,
                at: now(),
                by: actor,
                note: note.trim().to_owned(),
            },
        )
    }

    /// Who published what, oldest first.
    pub fn publish_log(&self, id: &FlowId) -> CoreResult<Vec<PublishRecord>> {
        self.store.read_publish_log(id)
    }

    /// What an unattended run of `id` executes: the published version and
    /// the published versions of every flow it calls. Fails with
    /// `NOT_PUBLISHED` / `SUBFLOW_NOT_PUBLISHED` rather than falling
    /// back to working content nobody approved.
    /// What an unattended run of `id` (`spellsheet run`, a schedule, a
    /// management server) executes: the published versions, once the
    /// workspace policy allows the flow and everything it calls to run
    /// unattended (`UNATTENDED_NOT_ALLOWED` otherwise).
    pub fn unattended_run(&self, id: &FlowId) -> CoreResult<PublishedRun> {
        let policy = crate::Policy::load(&crate::Policy::path(self.store.root()))?;
        let refuse = |id: &FlowId| -> CoreResult<()> {
            if policy.allows_unattended(id.as_str()) {
                return Ok(());
            }
            Err(CoreError::Rejected {
                code: "UNATTENDED_NOT_ALLOWED",
                message: format!("the workspace policy keeps {id} from running unattended"),
                hint: Some(
                    "Run it from Writer, or change \"unattended\" for it in policy.json.".into(),
                ),
            })
        };
        refuse(id)?;
        let run = self.published_run(id)?;
        for sub in &run.subflows {
            refuse(&sub.flow.id)?;
        }
        Ok(run)
    }

    pub fn published_run(&self, id: &FlowId) -> CoreResult<PublishedRun> {
        let Some(version) = self.published_version(id)? else {
            if !self.store.exists(id) {
                return Err(CoreError::FlowNotFound(id.clone()));
            }
            return Err(CoreError::Rejected {
                code: "NOT_PUBLISHED",
                message: format!("flow {id} has no published version"),
                hint: Some(
                    "Unattended runs execute the published version only. A person approves and publishes it in Writer (レビュー台 → 変更を承諾) or with `spellsheet version publish <id>`; `spellsheet run <id> --draft` runs the working content instead."
                        .into(),
                ),
            });
        };
        let subflows = self.check_publishable(&version.flow)?;
        Ok(PublishedRun {
            version: version.number,
            flow: version.flow,
            subflows,
        })
    }

    /// The published versions of everything `flow` calls, once it is
    /// known to validate against them.
    pub(super) fn check_publishable(&self, flow: &Flow) -> CoreResult<Vec<Subflow>> {
        let mut found: Vec<Subflow> = Vec::new();
        let mut missing: Vec<FlowId> = Vec::new();
        let mut queue: Vec<FlowId> = call::called_ids(flow).into_iter().collect();
        while let Some(next) = queue.pop() {
            if next == flow.id || missing.contains(&next) || found.iter().any(|s| s.flow.id == next)
            {
                continue;
            }
            match self.published_version(&next)? {
                Some(v) => {
                    queue.extend(call::called_ids(&v.flow));
                    found.push(Subflow {
                        project_dir: Some(self.store.project_dir(&next)),
                        flow: v.flow,
                        version: Some(v.number),
                    });
                }
                None => missing.push(next),
            }
        }
        if !missing.is_empty() {
            missing.sort_by(|a, b| a.as_str().cmp(b.as_str()));
            let list: Vec<&str> = missing.iter().map(FlowId::as_str).collect();
            return Err(CoreError::Rejected {
                code: "SUBFLOW_NOT_PUBLISHED",
                message: format!(
                    "called flow(s) have no published version: {}",
                    list.join(", ")
                ),
                hint: Some("Publish the called flows first.".into()),
            });
        }
        found.sort_by(|a, b| a.flow.id.as_str().cmp(b.flow.id.as_str()));
        let report = self.validator.validate_with_calls(flow, &|id| {
            found
                .iter()
                .find(|s| &s.flow.id == id)
                .map(|s| s.flow.clone())
        });
        if !report.valid {
            return Err(CoreError::ValidationFailed(report));
        }
        Ok(found)
    }
}

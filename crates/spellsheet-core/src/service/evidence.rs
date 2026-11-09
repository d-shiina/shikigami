//! Review evidence: what an AI saw on screen (observations), test runs,
//! and the reviews a person leaves on an AI's changes.

use super::*;

impl FlowService {
    /// Stores what an AI saw on screen (inspect_* / test_step) so a later
    /// edit can name it as its basis. Unused observations are deleted after
    /// [`review::UNLINKED_OBSERVATION_DAYS`] days.
    pub fn record_observation(
        &self,
        input: NewObservation,
        actor: Actor,
    ) -> CoreResult<Observation> {
        if let Err(e) = self
            .store
            .prune_observations(time::Duration::days(review::UNLINKED_OBSERVATION_DAYS))
        {
            tracing::warn!(error = %e, "failed to prune old observations");
        }
        let mut observation = Observation {
            id: ObservationId::generate(),
            source: input.source,
            at: now(),
            actor,
            title: review::clean_text(Some(input.title), 200).unwrap_or_default(),
            request: input.request,
            status: input.status,
            output: input.output,
            tree_file: None,
            screenshot_file: None,
            notes: Vec::new(),
            linked: Vec::new(),
        };
        let mut files = Vec::new();
        if let Some(mut tree) = input.tree {
            if review::cut_bytes(&mut tree, review::MAX_TREE_BYTES) {
                observation.notes.push(format!(
                    "UI tree cut at {} KB",
                    review::MAX_TREE_BYTES / 1024
                ));
            }
            observation.tree_file = Some("tree.txt".into());
            files.push(("tree.txt".to_owned(), tree.into_bytes()));
        }
        if let Some(bytes) = input.screenshot {
            match review::image_extension(&bytes) {
                _ if bytes.len() > review::MAX_SCREENSHOT_BYTES => observation.notes.push(format!(
                    "screenshot left out: larger than {} MB",
                    review::MAX_SCREENSHOT_BYTES / (1024 * 1024)
                )),
                Some(ext) => {
                    let name = format!("screenshot.{ext}");
                    observation.screenshot_file = Some(name.clone());
                    files.push((name, bytes));
                }
                None => observation
                    .notes
                    .push("screenshot left out: not a PNG or JPEG image".into()),
            }
        }
        self.store.save_observation(&observation, &files)?;
        Ok(observation)
    }

    /// An observation with its tree text and screenshot (as a data URL).
    pub fn get_observation(&self, id: &ObservationId) -> CoreResult<ObservationContent> {
        let observation = self.store.load_observation(id)?;
        let dir = self.store.observation_dir(id)?;
        let tree = match &observation.tree_file {
            Some(name) => {
                Some(String::from_utf8_lossy(&std::fs::read(dir.join(name))?).into_owned())
            }
            None => None,
        };
        let screenshot_data_url = match &observation.screenshot_file {
            Some(name) => {
                let mime = if name.ends_with(".png") {
                    "image/png"
                } else {
                    "image/jpeg"
                };
                let bytes = std::fs::read(dir.join(name))?;
                Some(format!("data:{mime};base64,{}", review::base64(&bytes)))
            }
            None => None,
        };
        Ok(ObservationContent {
            observation,
            tree,
            screenshot_data_url,
        })
    }

    /// Records a run an AI started to check a revision.
    pub fn record_test_run(
        &self,
        id: &FlowId,
        revision: u64,
        run: TestRun,
        actor: Actor,
    ) -> CoreResult<Evidence> {
        let evidence = Evidence {
            revision,
            at: now(),
            actor,
            detail: run.into(),
        };
        self.store.append_evidence(id, &evidence)?;
        Ok(evidence)
    }

    /// Records an AI's test case work (a saved case, or the results of the
    /// cases it ran) against `revision`.
    pub fn record_test_evidence(
        &self,
        id: &FlowId,
        revision: u64,
        detail: EvidenceDetail,
        actor: Actor,
    ) -> CoreResult<Evidence> {
        let evidence = Evidence {
            revision,
            at: now(),
            actor,
            detail,
        };
        self.store.append_evidence(id, &evidence)?;
        Ok(evidence)
    }

    /// Records a human's verdict on the current revision. Sending a flow
    /// back (`rejected`) needs a reason or at least one step note; the AI
    /// reads it with get_review / get_flow.
    pub fn submit_review(
        &self,
        id: &FlowId,
        input: NewReview,
        actor: Actor,
    ) -> CoreResult<Evidence> {
        let reason = review::clean_text(Some(input.reason), review::MAX_REVIEW_TEXT_CHARS)
            .unwrap_or_default();
        let mut steps = Vec::new();
        for mut note in input.steps {
            if let Some(text) = review::clean_text(Some(note.note), review::MAX_REVIEW_TEXT_CHARS) {
                note.note = text;
                steps.push(note);
            }
        }
        if input.verdict == ReviewVerdict::Rejected && reason.is_empty() && steps.is_empty() {
            return Err(CoreError::InvalidEdit(
                "sending a flow back needs a reason or a note on a step".into(),
            ));
        }
        let _lock = self.store.lock()?;
        let current = self.store.load(id)?;
        check_revision(Some(input.revision), current.revision)?;
        if let Some(note) = steps
            .iter()
            .find(|n| current.find_step(&n.step_id).is_none())
        {
            return Err(CoreError::StepNotFound(note.step_id.clone()));
        }
        let evidence = Evidence {
            revision: current.revision,
            at: now(),
            actor,
            detail: EvidenceDetail::Review {
                verdict: input.verdict,
                reason,
                steps,
            },
        };
        self.store.append_evidence(id, &evidence)?;
        Ok(evidence)
    }

    /// Changes and evidence after `since` (default: the last approved
    /// revision), for reviewing what an AI did.
    pub fn review_timeline(&self, id: &FlowId, since: Option<u64>) -> CoreResult<ReviewTimeline> {
        let flow = self.get(id)?;
        let journal = self.store.read_journal(id, usize::MAX)?;
        let evidence = self.store.read_evidence(id)?;
        Ok(review::timeline(
            flow.id,
            flow.revision,
            since,
            &journal,
            evidence,
        ))
    }

    /// The latest review when it sent the flow back.
    pub fn open_feedback(&self, id: &FlowId) -> CoreResult<Option<Evidence>> {
        Ok(review::open_feedback(&self.store.read_evidence(id)?))
    }

    pub(super) fn check_observations(&self, ids: &[ObservationId]) -> CoreResult<()> {
        for id in ids {
            self.store.load_observation(id)?;
        }
        Ok(())
    }

    /// Links observations to a committed revision. The edit already
    /// happened, so failures are logged rather than returned.
    pub(super) fn link_observations(
        &self,
        flow: &Flow,
        step_ids: &[crate::ids::StepId],
        actor: &Actor,
        observations: &[ObservationId],
    ) {
        for id in observations {
            let result = self.store.load_observation(id).and_then(|mut o| {
                o.linked.push(ObservationLink {
                    flow_id: flow.id.clone(),
                    revision: flow.revision,
                });
                self.store.write_observation(&o)?;
                self.store.append_evidence(
                    &flow.id,
                    &Evidence {
                        revision: flow.revision,
                        at: now(),
                        actor: actor.clone(),
                        detail: EvidenceDetail::Observation {
                            observation_id: o.id.clone(),
                            source: o.source,
                            title: o.title.clone(),
                            step_ids: step_ids.to_vec(),
                            has_screenshot: o.screenshot_file.is_some(),
                        },
                    },
                )
            });
            if let Err(e) = result {
                tracing::warn!(observation = %id, error = %e, "failed to link observation");
            }
        }
    }
}

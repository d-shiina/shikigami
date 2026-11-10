//! Moving flows between workspaces: bundles, `.spx` packages and
//! distribution folders.

use super::*;

impl FlowService {
    /// Packs a flow (and optionally its versions) into a bundle for
    /// another workspace. Secret variable defaults are removed.
    pub fn export(&self, id: &FlowId, include_versions: bool) -> CoreResult<FlowBundle> {
        let mut flow = self.get(id)?;
        version::strip_secrets(&mut flow);
        let versions = if include_versions {
            let mut versions = self.store.load_versions(id)?;
            for v in &mut versions {
                version::strip_secrets(&mut v.flow);
            }
            versions
        } else {
            Vec::new()
        };
        let mut subflows = self.called_flows(&flow, &[]);
        subflows.iter_mut().for_each(version::strip_secrets);
        let mut files = self.bundled_files(&flow.id)?;
        for sub in &subflows {
            files.extend(self.bundled_files(&sub.id)?);
        }
        Ok(FlowBundle {
            format: BUNDLE_FORMAT.into(),
            // An older build would drop the files without a word.
            format_version: if files.is_empty() {
                version::BUNDLE_FORMAT_VERSION_WITHOUT_FILES
            } else {
                BUNDLE_FORMAT_VERSION
            },
            exported_at: now(),
            flow,
            versions,
            subflows,
            files,
        })
    }

    /// Imports a bundle or a bare flow document.
    ///
    /// A new ID is created as is. When the ID already exists, `on_conflict`
    /// decides; without it the import fails with `IMPORT_CONFLICT` so the
    /// caller can ask the user.
    pub fn import_bundle(
        &self,
        value: serde_json::Value,
        on_conflict: Option<ImportConflict>,
        actor: Actor,
    ) -> CoreResult<ImportOutcome> {
        let bundle = parse_bundle(value)?;
        let files = bundle.files;
        // Sub-flows first, so the flow validates against them.
        let mut subflows = Vec::with_capacity(bundle.subflows.len());
        for sub in bundle.subflows {
            if sub.id == bundle.flow.id || !sub.id.is_well_formed() {
                continue;
            }
            let (id, name) = (sub.id.clone(), sub.name.clone());
            let mode = if !self.store.exists(&sub.id) {
                self.insert_imported(sub, actor.clone())?;
                SubflowImport::Created
            } else if on_conflict == Some(ImportConflict::Update) {
                let label = "import update".to_owned();
                self.match_content(&id, &sub, None, actor.clone(), label, Remarks::default())?;
                SubflowImport::Updated
            } else {
                SubflowImport::Kept
            };
            if mode != SubflowImport::Kept {
                let keep_input = mode == SubflowImport::Updated;
                self.write_bundled_files(&id, &id, &files, keep_input)?;
            }
            subflows.push(ImportedSubflow { id, name, mode });
        }
        let mut flow = bundle.flow;
        let original_id = flow.id.clone();
        let exists = flow.id.is_well_formed() && self.store.exists(&flow.id);
        let (mode, outcome) = match (exists, on_conflict) {
            (true, None) => {
                let existing = self.get(&flow.id)?;
                return Err(CoreError::ImportConflict {
                    flow_id: existing.id,
                    name: existing.name,
                });
            }
            (true, Some(ImportConflict::Update)) => {
                let id = flow.id.clone();
                let label = "import update".to_owned();
                (
                    ImportMode::Updated,
                    self.match_content(&id, &flow, None, actor, label, Remarks::default())?,
                )
            }
            (true, Some(ImportConflict::Copy)) => {
                flow.id = FlowId::generate();
                (ImportMode::Copied, self.insert_imported(flow, actor)?)
            }
            (false, _) => {
                if !flow.id.is_well_formed() {
                    flow.id = FlowId::generate();
                }
                (ImportMode::Created, self.insert_imported(flow, actor)?)
            }
        };
        let keep_input = mode == ImportMode::Updated;
        self.write_bundled_files(&original_id, &outcome.flow.id, &files, keep_input)?;
        let versions_added = self.add_versions(&outcome.flow.id, bundle.versions)?;
        // Validated before the sub-flows existed when it was created.
        let outcome = EditOutcome {
            validation: self.validate(&outcome.flow),
            ..outcome
        };
        Ok(ImportOutcome {
            mode,
            versions_added,
            subflows,
            outcome,
        })
    }

    // -- packages (.spx) -------------------------------------------

    /// What exporting `id` would put in a package, for choosing files
    /// before exporting.
    pub fn package_plan(
        &self,
        id: &FlowId,
        content: package::PackageContent,
    ) -> CoreResult<package::PackagePlan> {
        let current = self.get(id)?;
        let published = self.published_version(id)?;
        let use_published =
            published.is_some() && !matches!(content, package::PackageContent::Current);
        let content = match (&published, use_published) {
            (Some(v), true) => &v.flow,
            _ => &current,
        };
        let subflows = self.package_subflows(content, use_published);
        let mut files = Vec::new();
        for (flow_id, flow_name) in std::iter::once((&current.id, &current.name))
            .chain(subflows.iter().map(|s| (&s.id, &s.name)))
        {
            for file in project::list(flow_id, &self.store.project_dir(flow_id))?.files {
                if !project::is_bundled(&file.path) {
                    continue;
                }
                files.push(package::PackageFileChoice {
                    flow_id: flow_id.clone(),
                    flow_name: flow_name.clone(),
                    included_by_default: !is_input(&file.path),
                    path: file.path,
                    size: file.size,
                });
            }
        }
        let flows: Vec<&Flow> = std::iter::once(content).chain(subflows.iter()).collect();
        let mut requires = package::requirements(&flows, self.registry());
        let mut configs: Vec<Vec<u8>> = Vec::new();
        for flow in &flows {
            let dir = self.store.project_dir(&flow.id);
            for file in project::list(&flow.id, &dir)?.files {
                if file.path.starts_with("config/")
                    && file.path.ends_with(".json")
                    && let Ok(bytes) = std::fs::read(dir.join(&file.path))
                {
                    configs.push(bytes);
                }
            }
        }
        requires.places = crate::places::package_places(
            &flows,
            self.registry(),
            configs.iter().map(Vec::as_slice),
        );
        Ok(package::PackagePlan {
            flow_id: current.id.clone(),
            name: current.name.clone(),
            files,
            has_unpublished_changes: published
                .as_ref()
                .is_some_and(|v| !version::same_content(&v.flow, &current)),
            current: !use_published,
            published: published.as_ref().map(packaged_version),
            requires: package::requirements(&flows, self.registry()),
            subflows: subflows
                .iter()
                .map(|s| package::PackagedSubflow {
                    id: s.id.clone(),
                    name: s.name.clone(),
                })
                .collect(),
            file_name: package::file_name(
                &current.name,
                published
                    .as_ref()
                    .filter(|_| use_published)
                    .map(|v| v.number),
            ),
        })
    }

    /// Sub-flows `flow` calls, at their published version where they have one
    /// (`published`) or as they are now.
    /// Each one is resolved before following its own calls, so a published
    /// sub-flow brings what its published version calls.
    pub(super) fn package_subflows(&self, flow: &Flow, published: bool) -> Vec<Flow> {
        let mut found: Vec<Flow> = Vec::new();
        let mut queue: Vec<FlowId> = call::called_ids(flow).into_iter().collect();
        while let Some(id) = queue.pop() {
            if id == flow.id || found.iter().any(|s| s.id == id) {
                continue;
            }
            let snapshot = if published {
                self.published_version(&id).ok().flatten().map(|v| v.flow)
            } else {
                None
            };
            let Some(mut next) = snapshot.or_else(|| self.store.load(&id).ok()) else {
                continue;
            };
            next.id = id;
            queue.extend(call::called_ids(&next));
            found.push(next);
        }
        found.sort_by(|a, b| a.id.as_str().cmp(b.id.as_str()));
        found
    }

    /// The 配布フォルダー this PC looks at.
    pub fn distribution_folders(&self) -> CoreResult<Vec<distribution::DistributionFolder>> {
        Ok(distribution::load(self.store.local_root())?.folders)
    }

    /// Replaces the list of 配布フォルダー (checked: names and full paths).
    pub fn set_distribution_folders(
        &self,
        folders: Vec<distribution::DistributionFolder>,
    ) -> CoreResult<Vec<distribution::DistributionFolder>> {
        Ok(distribution::save(
            self.store.local_root(),
            &distribution::DistributionSettings { folders },
        )?
        .folders)
    }

    /// What each 配布フォルダー holds, against the flows here. A folder that
    /// cannot be reached says so instead of failing the rest.
    pub fn scan_distribution(&self) -> CoreResult<Vec<distribution::DistributionView>> {
        let local = |id: &FlowId| {
            if !self.store.exists(id) {
                return None;
            }
            let versions = self.store.load_versions(id).unwrap_or_default();
            Some(distribution::Local {
                latest: versions.last().map(|v| v.number),
                uids: versions.into_iter().map(|v| v.uid).collect(),
            })
        };
        Ok(self
            .distribution_folders()?
            .iter()
            .map(|folder| distribution::view(folder, local))
            .collect())
    }

    /// Puts the published version of `id` into the 配布フォルダー `folder`
    /// as `<name> v<n>.spx`, returning the file. Only a published version
    /// goes there. When the folder already has that very version, nothing
    /// is written. `only` is the files chosen in 渡す (as in
    /// [`package::PackageOptions::only`]); without it, the default choice.
    pub fn place_in_distribution(
        &self,
        id: &FlowId,
        folder: &str,
        only: Option<Vec<package::FileRef>>,
        exported_by: Option<String>,
    ) -> CoreResult<std::path::PathBuf> {
        let target = self
            .distribution_folders()?
            .into_iter()
            .find(|f| f.name == folder)
            .ok_or_else(|| CoreError::Rejected {
                code: "NOT_FOUND",
                message: format!("no distribution folder named {folder}"),
                hint: None,
            })?;
        let (manifest, bytes) = self.export_package(
            id,
            &package::PackageOptions {
                content: package::PackageContent::Published,
                only,
                exported_by,
                ..package::PackageOptions::default()
            },
        )?;
        let version = manifest.flow.version.as_ref().map(|v| v.uid.clone());
        let dir = std::path::Path::new(&target.path);
        let existing = distribution::manifests(dir).map_err(|e| CoreError::Rejected {
            code: "FOLDER_UNREACHABLE",
            message: format!("{}: {e}", target.path),
            hint: Some("Check that the folder exists and this PC can open it.".into()),
        })?;
        if let Some((path, _)) = existing.iter().find(|(_, m)| {
            m.flow.id == manifest.flow.id
                && m.flow.version.as_ref().map(|v| v.uid.clone()) == version
        }) {
            return Ok(path.clone());
        }
        let path = dir.join(package::file_name(
            &manifest.flow.name,
            manifest.flow.version.as_ref().map(|v| v.number),
        ));
        // Written beside it under a temporary name, then given its name only
        // if that is still free: a cut connection leaves no half file under
        // the real name, and two people putting at once cannot overwrite.
        let exists = || CoreError::Rejected {
            code: "FILE_EXISTS",
            message: format!("{} already exists and holds something else", path.display()),
            hint: Some("Rename or remove that file in the folder first.".into()),
        };
        if path.exists() {
            return Err(exists());
        }
        let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
        std::io::Write::write_all(&mut tmp, &bytes)?;
        tmp.as_file().sync_all()?;
        tmp.persist_noclobber(&path).map_err(|e| {
            if e.error.kind() == std::io::ErrorKind::AlreadyExists {
                exists()
            } else {
                CoreError::Io(e.error)
            }
        })?;
        Ok(path)
    }

    /// Writes a `.spx` package of `id`. Secret defaults are removed;
    /// logins are referred to by name only.
    pub fn export_package(
        &self,
        id: &FlowId,
        options: &package::PackageOptions,
    ) -> CoreResult<(package::PackageManifest, Vec<u8>)> {
        use package::{PackageContent, PackageVersions};
        let current = self.get(id)?;
        let published = self.published_version(id)?;
        let all_versions = self.store.load_versions(id)?;
        let (mut flow, version, is_published) = match (options.content, published) {
            (PackageContent::Auto | PackageContent::Published, Some(v)) => {
                let mut flow = v.flow.clone();
                flow.id = current.id.clone();
                (flow, Some(v), true)
            }
            (PackageContent::Published, None) => {
                return Err(CoreError::Rejected {
                    code: "NOT_PUBLISHED",
                    message: format!("flow {id} has no published version"),
                    hint: Some(
                        "Export the current content instead (content: \"current\"), or have a person publish it first."
                            .into(),
                    ),
                });
            }
            (_, published) => {
                let matched = all_versions
                    .iter()
                    .rev()
                    .find(|v| version::same_content(&v.flow, &current))
                    .cloned();
                let is_published =
                    matches!((&matched, &published), (Some(m), Some(p)) if m.uid == p.uid);
                (current.clone(), matched, is_published)
            }
        };
        version::strip_secrets(&mut flow);
        let mut versions = match options.versions {
            PackageVersions::None => Vec::new(),
            PackageVersions::Content => version.clone().into_iter().collect(),
            PackageVersions::All => all_versions,
        };
        for v in &mut versions {
            version::strip_secrets(&mut v.flow);
        }
        let mut subflows = self.package_subflows(&flow, is_published);
        subflows.iter_mut().for_each(version::strip_secrets);
        let mut files = Vec::new();
        for flow_id in std::iter::once(&flow.id).chain(subflows.iter().map(|s| &s.id)) {
            files.extend(self.bundled_files(flow_id)?.into_iter().filter(|f| {
                let is = |x: &package::FileRef| x.flow_id == f.flow_id && x.path == f.path;
                match &options.only {
                    Some(only) => only.iter().any(is),
                    None => {
                        (options.include_input || !is_input(&f.path))
                            && !options.exclude.iter().any(is)
                    }
                }
            }));
        }
        self.write_package(
            FlowBundle {
                format: BUNDLE_FORMAT.into(),
                format_version: BUNDLE_FORMAT_VERSION,
                exported_at: now(),
                flow,
                versions,
                subflows,
                files,
            },
            version.as_ref(),
            is_published,
            options.exported_by.clone(),
        )
    }

    /// Writes `bundle` as a package with its manifest.
    pub(super) fn write_package(
        &self,
        bundle: FlowBundle,
        version: Option<&FlowVersion>,
        is_published: bool,
        exported_by: Option<String>,
    ) -> CoreResult<(package::PackageManifest, Vec<u8>)> {
        let flow = &bundle.flow;
        let flows: Vec<&Flow> = std::iter::once(flow)
            .chain(bundle.subflows.iter())
            .collect();
        let manifest = package::PackageManifest {
            format: package::PACKAGE_FORMAT.into(),
            format_version: package::PACKAGE_FORMAT_VERSION,
            exported_at: bundle.exported_at,
            app_version: env!("CARGO_PKG_VERSION").into(),
            exported_by,
            flow: package::PackagedFlow {
                id: flow.id.clone(),
                name: flow.name.clone(),
                description: flow.description.clone(),
                version: version.map(packaged_version),
                published: is_published,
                step_count: flow.walk().count(),
            },
            subflows: bundle
                .subflows
                .iter()
                .map(|s| package::PackagedSubflow {
                    id: s.id.clone(),
                    name: s.name.clone(),
                })
                .collect(),
            requires: {
                let mut requires = package::requirements(&flows, self.registry());
                let configs: Vec<Vec<u8>> = bundle
                    .files
                    .iter()
                    .filter(|f| f.path.starts_with("config/") && f.path.ends_with(".json"))
                    .filter_map(|f| {
                        use base64::Engine as _;
                        base64::engine::general_purpose::STANDARD
                            .decode(&f.data)
                            .ok()
                    })
                    .collect();
                requires.places = crate::places::package_places(
                    &flows,
                    self.registry(),
                    configs.iter().map(Vec::as_slice),
                );
                requires
            },
            contents: Vec::new(),
        };
        let bytes = package::write(&bundle, manifest)?;
        let manifest = package::read_manifest(&bytes)?;
        Ok((manifest, bytes))
    }

    /// [`Self::preview_package`] for any file a flow can be imported from:
    /// an older JSON bundle or a flow document is previewed as the package
    /// it would have been.
    pub fn preview_file(
        &self,
        bytes: &[u8],
        registered_secrets: &[String],
    ) -> CoreResult<package::PackagePreview> {
        if package::is_package(bytes) {
            return self.preview_package(bytes, registered_secrets);
        }
        let bundle = parse_bundle(file_to_bundle_value(bytes)?)?;
        // The newest version that matches the content says which one it is.
        let version = bundle
            .versions
            .iter()
            .rev()
            .find(|v| version::same_content(&v.flow, &bundle.flow))
            .cloned();
        let (_, bytes) = self.write_package(bundle, version.as_ref(), false, None)?;
        self.preview_package(&bytes, registered_secrets)
    }

    /// What importing a package would do, and what this PC still needs for
    /// it. `registered_secrets` are the names of the logins registered here.
    pub fn preview_package(
        &self,
        bytes: &[u8],
        registered_secrets: &[String],
    ) -> CoreResult<package::PackagePreview> {
        use package::{CheckKind, CheckStatus, RequirementCheck};
        let (manifest, bundle) = package::read(bytes)?;
        let requires = &manifest.requires;
        let mut checks = Vec::new();
        for (key, range) in &requires.plugins {
            let name = key
                .strip_prefix(crate::requires::PLUGIN_PREFIX)
                .unwrap_or(key)
                .to_owned();
            let (status, installed) = match crate::requires::check(key, range, self.registry()) {
                crate::requires::Check::Ok => (CheckStatus::Ok, None),
                crate::requires::Check::Mismatch { installed } => {
                    (CheckStatus::Mismatch, Some(installed))
                }
                _ => (CheckStatus::Missing, None),
            };
            checks.push(RequirementCheck {
                kind: CheckKind::Plugin,
                name,
                range: Some(range.clone()),
                installed,
                status,
            });
        }
        for name in &requires.secrets {
            checks.push(RequirementCheck {
                kind: CheckKind::Secret,
                name: name.clone(),
                range: None,
                installed: None,
                status: if registered_secrets.contains(name) {
                    CheckStatus::Ok
                } else {
                    CheckStatus::Missing
                },
            });
        }
        let policy = crate::Policy::load(&crate::Policy::path(self.store.root()))?;
        for site in &requires.sites {
            checks.push(RequirementCheck {
                kind: CheckKind::Site,
                name: site.clone(),
                range: None,
                installed: None,
                status: if policy.check_site(site).is_ok() {
                    CheckStatus::Ok
                } else {
                    CheckStatus::NotAllowed
                },
            });
        }
        for app in &requires.apps {
            checks.push(RequirementCheck {
                kind: CheckKind::App,
                name: app.clone(),
                range: None,
                installed: None,
                status: if policy.check_app(app).is_ok() {
                    CheckStatus::Ok
                } else {
                    CheckStatus::NotAllowed
                },
            });
        }
        for place in &requires.places {
            checks.push(RequirementCheck {
                kind: CheckKind::Place,
                name: place.clone(),
                range: None,
                installed: None,
                status: if crate::places::reachable(place) {
                    CheckStatus::Ok
                } else {
                    CheckStatus::Missing
                },
            });
        }
        let id = &bundle.flow.id;
        let existing = if id.is_well_formed() && self.store.exists(id) {
            let current = self.get(id)?;
            let versions = self.store.load_versions(id)?;
            let incoming = version::DiffSide {
                version: manifest.flow.version.as_ref().map(|v| v.number),
                label: manifest.flow.version.as_ref().map_or_else(
                    || "package".to_owned(),
                    |v| format!("v{} {}", v.number, v.name),
                ),
                revision: bundle.flow.revision,
            };
            Some(package::ExistingFlow {
                name: current.name.clone(),
                latest_version: versions.last().map(|v| v.number),
                published_version: self.published(id)?.map(|p| p.version),
                has_package_version: manifest
                    .flow
                    .version
                    .as_ref()
                    .is_some_and(|pv| versions.iter().any(|v| v.uid == pv.uid)),
                diff: version::diff(
                    (&current, version::side(None, &current)),
                    (&bundle.flow, incoming),
                ),
                kept_inputs: project::kept_inputs(&bundle.files, id, &self.project_dir(id)?),
            })
        } else {
            None
        };
        Ok(package::PackagePreview {
            manifest,
            existing,
            checks,
        })
    }

    /// Imports a `.spx` package, a bundle (`*.spellsheet.json`) or a
    /// bare flow document, telling them apart by their first bytes.
    pub fn import_file(
        &self,
        bytes: &[u8],
        on_conflict: Option<ImportConflict>,
        actor: Actor,
    ) -> CoreResult<ImportOutcome> {
        self.import_bundle(file_to_bundle_value(bytes)?, on_conflict, actor)
    }

    pub(super) fn insert_imported(&self, mut flow: Flow, actor: Actor) -> CoreResult<EditOutcome> {
        flow.revision = 0;
        let now = now();
        flow.metadata.created_at.get_or_insert(now);
        flow.metadata.updated_at = Some(now);
        self.insert_new(flow, actor, "import flow", Remarks::default())
    }

    /// Adds versions whose `uid` is not present yet, in their original
    /// order, after the existing ones (keeping their number when it is
    /// higher than ours).
    pub(super) fn add_versions(
        &self,
        id: &FlowId,
        mut incoming: Vec<FlowVersion>,
    ) -> CoreResult<usize> {
        if incoming.is_empty() {
            return Ok(0);
        }
        let _lock = self.store.lock()?;
        let existing = self.store.load_versions(id)?;
        let mut next = existing.last().map_or(1, |v| v.number + 1);
        incoming.sort_by_key(|v| v.number);
        let mut added = 0;
        for mut v in incoming {
            if existing.iter().any(|e| e.uid == v.uid) {
                continue;
            }
            // Keep the sender's number when it is still free after ours, so
            // "v3" means the same version on both PCs.
            next = next.max(v.number);
            v.number = next;
            v.flow.id = id.clone();
            self.store.save_version(&v)?;
            next += 1;
            added += 1;
        }
        Ok(added)
    }
}

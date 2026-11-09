//! `spellsheet run` and `spellsheet test`: loading a flow (from the
//! workspace or a file) and running it, printing progress and results.

use super::*;

/// What `spellsheet run` executes, with the version recorded in the report.
/// A file runs as written. A workspace flow runs its published version
/// (and the published versions of what it calls) unless `draft`; the
/// policy can keep a flow from running unattended at all.
pub(crate) fn runnable(
    svc: &FlowService,
    target: &str,
    draft: bool,
) -> Result<(Flow, Option<u32>, Vec<spellsheet_core::Subflow>)> {
    if is_file(target) {
        let (flow, bundled) = resolve(svc, target)?;
        let version = svc.matching_version(&flow).ok().flatten();
        let subflows = subflows(svc, &flow, bundled)?;
        return Ok((flow, version, subflows));
    }
    let id = FlowId::new(target);
    let policy = Policy::load(&Policy::path(svc.store().root())).map_err(core_err)?;
    let unattended = |id: &FlowId| -> Result<()> {
        if policy.allows_unattended(id.as_str()) {
            return Ok(());
        }
        Err(core_err(spellsheet_core::CoreError::Rejected {
            code: "UNATTENDED_NOT_ALLOWED",
            message: format!("the workspace policy keeps {id} from running unattended"),
            hint: Some(
                "Run it from Writer, or change \"unattended\" for it in policy.json.".into(),
            ),
        }))
    };
    unattended(&id)?;
    let (flow, version, subflows) = if draft {
        let flow = svc.get(&id).map_err(core_err)?;
        let version = svc.matching_version(&flow).ok().flatten();
        let subflows = subflows(svc, &flow, Vec::new())?;
        (flow, version, subflows)
    } else {
        let run = svc.published_run(&id).map_err(core_err)?;
        (run.flow, Some(run.version), run.subflows)
    };
    // A called flow kept from unattended runs stops its callers too.
    for sub in &subflows {
        unattended(&sub.flow.id)?;
    }
    Ok((flow, version, subflows))
}

/// Reads a flow JSON file or the flow inside a bundle.
/// A flow file or bundle, with the sub-flows a bundle carries.
pub(crate) fn load_file(path: &Path) -> Result<(Flow, Vec<Flow>)> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let mut value = spellsheet_core::service::file_to_bundle_value(&bytes)?;
    let mut bundled = Vec::new();
    if spellsheet_core::version::is_bundle(&value) {
        // `scenario` / `subscenarios`: bundles from before flows were
        // renamed (up to 0.1.2).
        let mut take =
            |keys: [&str; 2]| keys.iter().find_map(|k| value.get_mut(*k).map(Value::take));
        if let Some(Value::Array(subs)) = take(["subflows", "subscenarios"]) {
            for sub in subs {
                bundled.push(spellsheet_core::migrate::from_value(sub)?);
            }
        }
        value = take(["flow", "scenario"]).unwrap_or_default();
    }
    Ok((spellsheet_core::migrate::from_value(value)?, bundled))
}

/// A target is a file path when it ends with `.json` or exists on disk.
pub(crate) fn is_file(target: &str) -> bool {
    target.ends_with(".json") || target.ends_with(".spx") || Path::new(target).is_file()
}

pub(crate) fn resolve(svc: &FlowService, target: &str) -> Result<(Flow, Vec<Flow>)> {
    if is_file(target) {
        load_file(Path::new(target))
    } else {
        Ok((svc.get(&FlowId::new(target))?, Vec::new()))
    }
}

/// Where the run's relative paths point. A flow in the workspace uses its
/// folder; a `flow.json` file the folder it is in (a copied flow
/// folder); a bundle's flows get their files unpacked next to it, into
/// `<bundle>.files/<id>/`, which stays after the run so its output/ and logs/
/// can be read. Any other JSON file runs from the folder it is in.
pub(crate) fn project_dirs(
    svc: &FlowService,
    target: &str,
    flow: &Flow,
    subflows: &mut [spellsheet_core::Subflow],
) -> Result<Option<PathBuf>> {
    let path = Path::new(target);
    if !(target.ends_with(".json") || path.is_file()) {
        return Ok(Some(svc.project_dir(&flow.id)?));
    }
    let value = spellsheet_core::service::file_to_bundle_value(&std::fs::read(path)?)?;
    let file = std::path::absolute(path)?;
    if !spellsheet_core::version::is_bundle(&value) {
        return Ok(file.parent().map(Path::to_path_buf));
    }
    let bundle: spellsheet_core::FlowBundle = serde_json::from_value(value)?;
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let base = name
        .strip_suffix(".spellsheet.json")
        .or_else(|| name.strip_suffix(&spellsheet_core::paths::legacy_spelling(".spellsheet.json")))
        .or_else(|| name.strip_suffix(".spx"))
        .or_else(|| name.strip_suffix(".json"))
        .unwrap_or(&name)
        .to_owned();
    let root = file
        .parent()
        .unwrap_or(Path::new("."))
        .join(format!("{base}.files"));
    let unpack = |id: &FlowId| -> Result<PathBuf> {
        // The ID comes from the file: never let it name a folder elsewhere.
        if !id.is_well_formed() {
            bail!("the bundle has an invalid flow ID: {}", id.as_str());
        }
        let dir = root.join(id.as_str());
        std::fs::create_dir_all(&dir)?;
        spellsheet_core::project::unpack(&bundle.files, id, &dir, false)?;
        Ok(dir)
    };
    let main = unpack(&flow.id)?;
    for sub in subflows.iter_mut() {
        if sub.project_dir.is_none() {
            sub.project_dir = Some(unpack(&sub.flow.id)?);
        }
    }
    eprintln!("files: {}", main.display());
    Ok(Some(main))
}

/// What the run's calls may use: a bundle's own sub-flows first, then
/// the workspace for any others (also those the bundled ones call).
pub(crate) fn subflows(
    svc: &FlowService,
    flow: &Flow,
    bundled: Vec<Flow>,
) -> Result<Vec<spellsheet_core::Subflow>> {
    Ok(svc.subflows_bundled(flow, &bundled)?)
}

pub(crate) fn parse_inputs(raw: &[String]) -> Result<Map<String, Value>> {
    let mut inputs = Map::new();
    for item in raw {
        let Some((name, value)) = item.split_once('=') else {
            bail!("input must be NAME=VALUE: {item}");
        };
        let value = serde_json::from_str(value).unwrap_or_else(|_| Value::String(value.to_owned()));
        inputs.insert(name.to_owned(), value);
    }
    Ok(inputs)
}

pub(crate) async fn run(
    runtime: &Runtime,
    workspace: &Path,
    policy: &Path,
    flow: Flow,
    options: RunOptions,
    json: bool,
    vars: bool,
) -> Result<RunStatus> {
    // Nodes are told by name, with the ID that finds them in the flow file.
    let names = spellsheet_runtime::names::StepNames::new(
        std::iter::once(&flow).chain(options.subflows.iter().map(|s| &s.flow)),
        runtime.registry(),
    );
    let handle = runtime.start(flow, options).map_err(|e| {
        anyhow::anyhow!(
            "{e}\n{}",
            e.details
                .as_ref()
                .map(|d| d.to_string())
                .unwrap_or_default()
        )
    })?;
    let cancel = handle.cancel_token();
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            eprintln!("cancelling…");
            cancel.cancel();
        }
    });

    let mut recorder = RunRecorder::create(workspace, &handle.run_id)?.prune_on_finish(policy);
    // `notify` with `waiting`: an unattended run waits for a person.
    let mut watch = spellsheet_agent::notify::WaitWatch::default();
    let mut waits = tokio::task::JoinSet::new();
    let report = handle
        .wait_with(|e| {
            if let Err(err) = recorder.write_event(e) {
                tracing::warn!(error = %err, "failed to record event");
            }
            if let Some(waiting) = watch.on_event(e) {
                let policy = policy.to_path_buf();
                waits.spawn(async move {
                    spellsheet_agent::notify::notify_waiting(&policy, &waiting).await;
                });
            }
            if json {
                if let Ok(line) = serde_json::to_string(e) {
                    println!("{line}");
                }
                return;
            }
            match &e.event {
                RunEvent::RunStarted {
                    flow_name,
                    revision,
                    ..
                } => {
                    println!("▶ {flow_name} (rev {revision}) run {}", e.run_id);
                }
                RunEvent::Log { level, message, .. } => {
                    let tag = match level {
                        LogLevel::Debug => "debug",
                        LogLevel::Info => "info ",
                        LogLevel::Warn => "warn ",
                        LogLevel::Error => "error",
                    };
                    println!("  [{tag}] {message}");
                }
                RunEvent::VariableChanged {
                    variable,
                    value,
                    step_id,
                    iteration,
                    truncated,
                    ..
                } if vars => {
                    let by = step_id
                        .as_ref()
                        .map_or_else(|| "start".to_owned(), ToString::to_string);
                    let at = iteration.map(|i| format!(" #{i}")).unwrap_or_default();
                    let cut = if *truncated { " (truncated)" } else { "" };
                    println!("  · {variable} = {value}{cut}  ← {by}{at}");
                }
                RunEvent::StepFinished {
                    step_id,
                    outcome: StepOutcome::Failed,
                    error: Some(err),
                    will_retry,
                    ..
                } => {
                    let retry = if *will_retry { " (retrying)" } else { "" };
                    println!(
                        "  ✗ {}: {} {}{retry}",
                        node(names.step(step_id), step_id.as_str()),
                        err.code,
                        err.message
                    );
                }
                RunEvent::RunFinished {
                    status,
                    duration_ms,
                    ..
                } => {
                    println!("■ {status:?} in {duration_ms} ms");
                }
                _ => {}
            }
        })
        .await?;
    recorder.finish(&report)?;
    // `notify` in policy.json: Task Scheduler and batch runs are unattended.
    spellsheet_agent::notify::notify(policy, &report).await;
    while waits.join_next().await.is_some() {}
    if !json {
        if !report.outputs.is_empty() {
            println!("outputs: {}", serde_json::to_string(&report.outputs)?);
        }
        if let Some(err) = &report.error {
            eprintln!("failed at {}: {} {}", failed_at(err), err.code, err.message);
        }
    }
    Ok(report.status)
}

/// `請求書の保存 [stp_013_save]`: the name people know, the ID that finds it.
pub(crate) fn node(name: &str, id: &str) -> String {
    if name.is_empty() {
        id.to_owned()
    } else {
        format!("{name} [{id}]")
    }
}

/// Where a run failed, down into the called flow it failed in.
pub(crate) fn failed_at(err: &spellsheet_runtime::RunError) -> String {
    let Some(id) = &err.step_id else {
        return "-".to_owned();
    };
    let mut at = node(err.step_label.as_deref().unwrap_or(""), id.as_str());
    if let Some(sub) = err.details.as_ref().and_then(|d| d.get("subFlow")) {
        let text = |key: &str| sub.get(key).and_then(Value::as_str).unwrap_or("");
        if !text("stepId").is_empty() {
            at.push_str(&format!(
                " → {} › {}",
                text("flowName"),
                node(text("stepLabel"), text("stepId"))
            ));
        }
    }
    at
}

pub(crate) fn print_case(result: &testing::CaseResult) {
    let mark = if result.passed { "✓" } else { "✗" };
    let about = result
        .description
        .as_ref()
        .map(|d| format!(" — {d}"))
        .unwrap_or_default();
    println!("{mark} {}{about} ({} ms)", result.name, result.duration_ms);
    for m in &result.mismatches {
        println!("    {}: expected {}, got {}", m.at, m.expected, m.actual);
    }
    if !result.passed {
        if let Some(err) = &result.error {
            println!(
                "    error at {}: {} {}",
                failed_at(err),
                err.code,
                err.message
            );
        }
        println!("    run {}", result.run_id);
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod load_file_tests {
    use super::*;

    #[test]
    fn reads_scenario_bundles_from_0_1() {
        let dir = tempfile::tempdir().unwrap();
        // Named and marked as the 0.1 builds wrote it, under the old name.
        let legacy = spellsheet_core::paths::legacy_spelling;
        let path = dir.path().join(legacy("old.spellsheet.json"));
        let bundle = serde_json::json!({
            "format": legacy(spellsheet_core::version::LEGACY_BUNDLE_FORMAT),
            "formatVersion": 2,
            "exportedAt": "2026-11-01T00:00:00Z",
            "scenario": {
                "schemaVersion": 3, "id": "scn_main", "name": "main",
                "steps": [{ "id": "c", "type": "scenario.call", "params": { "scenario": "scn_sub" } }]
            },
            "subscenarios": [{ "schemaVersion": 3, "id": "scn_sub", "name": "sub" }]
        });
        std::fs::write(&path, bundle.to_string()).unwrap();
        let (flow, subs) = load_file(&path).unwrap();
        assert_eq!(flow.name, "main");
        assert_eq!(flow.steps[0].step_type, "flow.call");
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].name, "sub");
    }
}

//! `spellsheet flow`, `version`, `approval` and `distribution`: managing
//! flows, their versions and the approvals and folders around them.

use super::*;
use crate::cli::{ApprovalCmd, DistributionCmd, FlowCmd, OnConflict, VersionCmd};

pub(crate) fn flow_cmd(svc: &FlowService, cmd: &FlowCmd) -> Result<()> {
    match cmd {
        FlowCmd::List => {
            for s in svc.list()? {
                println!(
                    "{}\trev {}\t{} step(s)\t{}",
                    s.id, s.revision, s.step_count, s.name
                );
            }
        }
        FlowCmd::Show { id } => {
            println!(
                "{}",
                serde_json::to_string_pretty(&svc.get(&FlowId::new(id.as_str()))?)?
            );
        }
        FlowCmd::Create { name } => {
            let out = svc.create(
                NewFlow {
                    name: name.clone(),
                    ..Default::default()
                },
                actor(),
            )?;
            println!("{}", out.flow.id);
        }
        FlowCmd::Import {
            file,
            on_conflict,
            check,
        } => {
            let bytes =
                std::fs::read(file).with_context(|| format!("reading {}", file.display()))?;
            if *check {
                let secrets: Vec<String> = Vault::open(svc.store().root())
                    .list()
                    .map(|list| list.into_iter().map(|s| s.name).collect())
                    .unwrap_or_default();
                let preview = svc.preview_file(&bytes, &secrets)?;
                println!("{}", serde_json::to_string_pretty(&preview)?);
                return Ok(());
            }
            let value = spellsheet_core::service::file_to_bundle_value(&bytes)?;
            let on_conflict = on_conflict.map(|c| match c {
                OnConflict::Update => ImportConflict::Update,
                OnConflict::Copy => ImportConflict::Copy,
            });
            let out = svc.import_bundle(value, on_conflict, actor())?;
            println!("{}", out.outcome.flow.id);
            eprintln!("{:?}, {} version(s) added", out.mode, out.versions_added);
            for issue in &out.outcome.validation.issues {
                eprintln!(
                    "{:?} {} {}: {}",
                    issue.severity, issue.code, issue.path, issue.message
                );
            }
        }
        FlowCmd::Export {
            id,
            output,
            current,
            all_versions,
            no_versions,
            with_input,
        } => {
            let id = FlowId::new(id.as_str());
            let legacy = output
                .as_deref()
                .is_some_and(|p| p == Path::new("-") || p.extension().is_some_and(|e| e == "json"));
            if legacy {
                let bundle = svc.export(&id, !no_versions)?;
                let json = serde_json::to_string_pretty(&bundle)? + "\n";
                match output.as_deref() {
                    Some(path) if path != Path::new("-") => {
                        std::fs::write(path, json)
                            .with_context(|| format!("writing {}", path.display()))?;
                    }
                    _ => print!("{json}"),
                }
                return Ok(());
            }
            use spellsheet_core::package::{PackageContent, PackageOptions, PackageVersions};
            let options = PackageOptions {
                content: if *current {
                    PackageContent::Current
                } else {
                    PackageContent::Auto
                },
                versions: if *no_versions {
                    PackageVersions::None
                } else if *all_versions {
                    PackageVersions::All
                } else {
                    PackageVersions::Content
                },
                include_input: *with_input,
                exclude: Vec::new(),
                only: None,
                exported_by: std::env::var("USERNAME")
                    .or_else(|_| std::env::var("USER"))
                    .ok(),
            };
            let (manifest, bytes) = svc.export_package(&id, &options)?;
            let name = spellsheet_core::package::file_name(
                &manifest.flow.name,
                manifest.flow.version.as_ref().map(|v| v.number),
            );
            let path = match output {
                Some(p) if p.is_dir() => p.join(&name),
                Some(p) => p.clone(),
                None => PathBuf::from(&name),
            };
            std::fs::write(&path, &bytes).with_context(|| format!("writing {}", path.display()))?;
            let what = match (&manifest.flow.version, manifest.flow.published) {
                (Some(v), true) => format!("published version v{}", v.number),
                (Some(v), false) => format!("version v{}", v.number),
                (None, _) => "current content (not saved as a version)".to_owned(),
            };
            eprintln!("wrote {} ({what})", path.display());
            let r = &manifest.requires;
            for (label, items) in [
                ("logins", &r.secrets),
                ("sites", &r.sites),
                ("apps", &r.apps),
            ] {
                if !items.is_empty() {
                    eprintln!("  needs {label}: {}", items.join(", "));
                }
            }
            if !r.plugins.is_empty() {
                let plugins: Vec<String> =
                    r.plugins.iter().map(|(k, v)| format!("{k} {v}")).collect();
                eprintln!("  needs extensions: {}", plugins.join(", "));
            }
        }
        FlowCmd::Files { id } => {
            let files = svc.project_files(&FlowId::new(id.as_str()))?;
            println!("{}", files.dir);
            for file in files.files {
                println!("  {:<48} {:>10}", file.path, file.size);
            }
        }
        FlowCmd::AddFile {
            id,
            file,
            to,
            overwrite,
        } => {
            let to = match to {
                Some(to) => to.clone(),
                None => format!(
                    "input/{}",
                    file.file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default()
                ),
            };
            let added = svc.copy_into_project(&FlowId::new(id.as_str()), file, &to, *overwrite)?;
            println!("added {}", added.path);
        }
        FlowCmd::Delete { id } => {
            svc.delete(&FlowId::new(id.as_str()), None, actor())?;
            println!("moved {id} to trash");
        }
        FlowCmd::Edit {
            id,
            ops,
            expected_revision,
        } => {
            let text = if ops.as_os_str() == "-" {
                std::io::read_to_string(std::io::stdin())?
            } else {
                std::fs::read_to_string(ops)
                    .with_context(|| format!("reading {}", ops.display()))?
            };
            let ops: Vec<spellsheet_core::EditOp> =
                serde_json::from_str(&text).context("parsing edit operations")?;
            let out = svc.edit(&FlowId::new(id.as_str()), *expected_revision, ops, actor())?;
            print_outcome(&out);
        }
        FlowCmd::Undo { id } => {
            print_outcome(&svc.undo(&FlowId::new(id.as_str()), None, actor())?)
        }
        FlowCmd::Redo { id } => {
            print_outcome(&svc.redo(&FlowId::new(id.as_str()), None, actor())?)
        }
        FlowCmd::History { id, limit } => {
            for entry in svc.history(&FlowId::new(id.as_str()), *limit)? {
                let who = entry.actor.name.as_deref().unwrap_or("");
                println!(
                    "rev {}\t{:?}\t{:?} {}\t{}",
                    entry.revision, entry.kind, entry.actor.kind, who, entry.label
                );
            }
        }
    }
    Ok(())
}

pub(crate) fn version_cmd(svc: &FlowService, cmd: &VersionCmd) -> spellsheet_core::CoreResult<()> {
    match cmd {
        VersionCmd::Create { id, name, note } => {
            let v = svc.create_version(
                &FlowId::new(id.as_str()),
                NewVersion {
                    name: name.clone(),
                    note: note.clone(),
                },
                None,
                actor(),
            )?;
            println!("v{} {} (rev {})", v.number, v.name, v.revision);
        }
        VersionCmd::List { id } => {
            let id = FlowId::new(id.as_str());
            let published = svc.published(&id)?.map(|p| p.version);
            for v in svc.list_versions(&id)? {
                let mark = if published == Some(v.number) {
                    "\tpublished"
                } else {
                    ""
                };
                let at = v
                    .created_at
                    .format(&time::format_description::well_known::Rfc3339)
                    .unwrap_or_default();
                println!(
                    "v{}\trev {}\t{}\t{:?} {}\t{}\t{}{mark}",
                    v.number,
                    v.revision,
                    at,
                    v.created_by.kind,
                    v.created_by.name.as_deref().unwrap_or(""),
                    v.name,
                    v.note
                );
            }
        }
        VersionCmd::Show { id, number } => {
            let v = svc.get_version(&FlowId::new(id.as_str()), *number)?;
            println!("{}", serde_json::to_string_pretty(&v)?);
        }
        VersionCmd::Diff { id, from, to, json } => {
            let id = FlowId::new(id.as_str());
            let from = match from {
                Some(n) => Some(*n),
                None => svc.latest_version(&id)?,
            };
            let diff = svc.diff_versions(&id, from, *to)?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&diff)?);
            } else {
                print_diff(&diff);
            }
        }
        VersionCmd::Restore { id, number } => {
            print_outcome(&svc.restore_version(
                &FlowId::new(id.as_str()),
                *number,
                None,
                actor(),
            )?);
        }
        VersionCmd::Publish {
            id,
            number,
            name,
            note,
        } => {
            let p = svc.publish(
                &FlowId::new(id.as_str()),
                PublishInput {
                    version: *number,
                    name: name.clone(),
                    note: note.clone(),
                    expected_revision: None,
                },
                actor(),
            )?;
            println!("published v{} {} (rev {})", p.version, p.name, p.revision);
            if !p.matches_current {
                println!("note: the working content has changes that are not published");
            }
        }
        VersionCmd::Unpublish { id, note } => {
            svc.unpublish(&FlowId::new(id.as_str()), note.clone(), actor())?;
            println!(
                "unpublished {id}: `spellsheet run {id}` now refuses until a version is published"
            );
        }
    }
    Ok(())
}

pub(crate) fn approval_cmd(
    store: &ApprovalStore,
    cmd: &ApprovalCmd,
) -> spellsheet_core::CoreResult<()> {
    match cmd {
        ApprovalCmd::List { json } => {
            let pending = store.pending()?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&pending)?);
                return Ok(());
            }
            for r in pending {
                println!(
                    "{}\t{}\t{:?}\t{}\t{}",
                    r.id,
                    r.action.as_str(),
                    r.risk,
                    r.flow_name.as_deref().unwrap_or("-"),
                    r.step_types.join(",")
                );
                println!("  {}", r.subject);
                if let Some(reason) = &r.reason {
                    println!("  reason (from the AI): {reason}");
                }
            }
        }
        ApprovalCmd::Approve { id } => {
            let r = store.decide(&ApprovalId::new(id.as_str()), true, actor())?;
            println!("approved {} ({})", r.id, r.action.as_str());
        }
        ApprovalCmd::Deny { id } => {
            let r = store.decide(&ApprovalId::new(id.as_str()), false, actor())?;
            println!("denied {} ({})", r.id, r.action.as_str());
        }
    }
    Ok(())
}

pub(crate) fn print_diff(diff: &FlowDiff) {
    println!("{} -> {}", diff.from.label, diff.to.label);
    if diff.identical {
        println!("no differences");
        return;
    }
    for f in &diff.flow {
        println!("~ flow.{}", f.field);
    }
    for v in &diff.variables {
        println!("{} variable {}", diff_mark(v.kind), v.name);
    }
    for s in &diff.steps {
        let fields: Vec<&str> = s.fields.iter().map(|f| f.field.as_str()).collect();
        println!(
            "{} {} {} {}{}",
            diff_mark(s.kind),
            s.step_id,
            s.step_type,
            s.name,
            if fields.is_empty() {
                String::new()
            } else {
                format!(" [{}]", fields.join(", "))
            }
        );
    }
}

pub(crate) fn diff_mark(kind: DiffKind) -> &'static str {
    match kind {
        DiffKind::Added => "+",
        DiffKind::Removed => "-",
        DiffKind::Changed => "~",
        DiffKind::Moved => ">",
    }
}

pub(crate) fn print_outcome(out: &spellsheet_core::EditOutcome) {
    println!(
        "rev {} ({} issue(s))",
        out.flow.revision,
        out.validation.issues.len()
    );
    for issue in &out.validation.issues {
        eprintln!(
            "{:?} {} {}: {}",
            issue.severity, issue.code, issue.path, issue.message
        );
    }
}

pub(crate) fn distribution_cmd(svc: &FlowService, cmd: &DistributionCmd) -> anyhow::Result<()> {
    use spellsheet_core::distribution::DistributionFolder;
    match cmd {
        DistributionCmd::List => {
            println!(
                "{}",
                serde_json::to_string_pretty(&svc.distribution_folders()?)?
            );
        }
        DistributionCmd::Add { name, path } => {
            let mut folders = svc.distribution_folders()?;
            folders.push(DistributionFolder {
                name: name.clone(),
                path: path.clone(),
            });
            println!(
                "{}",
                serde_json::to_string_pretty(&svc.set_distribution_folders(folders)?)?
            );
        }
        DistributionCmd::Remove { name } => {
            let folders = svc.distribution_folders()?;
            if !folders.iter().any(|f| &f.name == name) {
                anyhow::bail!("no distribution folder named {name}");
            }
            let left = folders.into_iter().filter(|f| &f.name != name).collect();
            println!(
                "{}",
                serde_json::to_string_pretty(&svc.set_distribution_folders(left)?)?
            );
        }
        DistributionCmd::Check => {
            println!(
                "{}",
                serde_json::to_string_pretty(&svc.scan_distribution()?)?
            );
        }
        DistributionCmd::Put { id, folder } => {
            let folders = svc.distribution_folders()?;
            let name = match (folder, folders.as_slice()) {
                (Some(name), _) => name.clone(),
                (None, [only]) => only.name.clone(),
                (None, []) => {
                    anyhow::bail!("no distribution folder yet; add one with `distribution add`")
                }
                (None, _) => {
                    anyhow::bail!("several distribution folders; choose one with --folder")
                }
            };
            let by = std::env::var("USERNAME")
                .or_else(|_| std::env::var("USER"))
                .ok();
            let path = svc.place_in_distribution(&FlowId::new(id.as_str()), &name, None, by)?;
            println!("{}", path.display());
        }
    }
    Ok(())
}

//! `spellsheet plugin`: node plugins installed in the workspace.

use super::*;
use crate::cli::PluginCmd;

pub(crate) fn builtin_names() -> Vec<String> {
    spellsheet_adapters::builtin()
        .iter()
        .map(|a| a.name().to_owned())
        .collect()
}

/// `spellsheet plugin install / update / remove / enable / disable / registry`.
pub(crate) fn plugin_command(cmd: &PluginCmd) -> Result<ExitCode> {
    use spellsheet_plugins::install::{self, Source};
    let Some(root) = install::install_root() else {
        bail!("cannot find the folder extensions are installed into (%LOCALAPPDATA%)");
    };
    let builtin = builtin_names();
    let taken: Vec<&str> = builtin.iter().map(String::as_str).collect();
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let install = |staged: install::Staged,
                   yes: bool,
                   current: Option<String>|
     -> Result<ExitCode> {
        let preview = staged.preview(&root);
        if let Some(current) = current
            && current == staged.manifest.version
            && !yes
        {
            install::discard(&root, &staged.id);
            println!("{} {} is the latest version", staged.manifest.name, current);
            return Ok(ExitCode::SUCCESS);
        }
        println!("{}", serde_json::to_string_pretty(&preview)?);
        if !yes {
            install::discard(&root, &staged.id);
            eprintln!(
                "Not installed. The extension runs `{}` on this PC: if you trust it, run the command again with --yes.",
                preview["program"].as_str().unwrap_or("")
            );
            return Ok(ExitCode::from(2));
        }
        let dir = install::commit(&root, staged)?;
        eprintln!(
            "installed into {} (restart Writer and AI clients to use it)",
            dir.display()
        );
        Ok(ExitCode::SUCCESS)
    };
    match cmd {
        PluginCmd::Install { source, yes } => {
            let staged = rt.block_on(install::stage(&root, Source::parse(source)?, &taken))?;
            install(staged, *yes, None)
        }
        PluginCmd::Update { name, yes } => {
            let staged = rt.block_on(install::stage_update(&root, name, &taken))?;
            let current =
                spellsheet_plugins::install::list(std::slice::from_ref(&root), Some(&root), &taken)
                    .into_iter()
                    .find(|p| p.summary["name"] == name.as_str())
                    .and_then(|p| p.summary["version"].as_str().map(str::to_owned));
            install(staged, *yes, current)
        }
        PluginCmd::Remove { name } => {
            install::remove(&root, name)?;
            eprintln!("removed {name}");
            Ok(ExitCode::SUCCESS)
        }
        PluginCmd::Enable { name } | PluginCmd::Disable { name } => {
            let on = matches!(cmd, PluginCmd::Enable { .. });
            install::set_enabled(&root, name, on)?;
            eprintln!("{name} is {}", if on { "on" } else { "off" });
            Ok(ExitCode::SUCCESS)
        }
        PluginCmd::Registry { set, reset } => {
            if *reset {
                install::set_registry_urls(&[install::OFFICIAL_REGISTRY.to_owned()])
                    .map_err(|e| anyhow::anyhow!(e))?;
            } else if let Some(urls) = set {
                install::set_registry_urls(urls).map_err(|e| anyhow::anyhow!(e))?;
            }
            let urls = install::registry_urls();
            if urls.is_empty() {
                eprintln!(
                    "no registry is set (spellsheet plugin registry --reset, or --set https://…/index.json)"
                );
                return Ok(ExitCode::SUCCESS);
            }
            let offered = rt.block_on(install::fetch_registries(&urls));
            for f in &offered.failed {
                eprintln!("cannot read {}: {}", f.registry, f.message);
                for p in &f.problems {
                    eprintln!("  {p}");
                }
            }
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "registries": urls,
                    "extensions": offered.extensions,
                }))?
            );
            Ok(ExitCode::SUCCESS)
        }
        PluginCmd::List | PluginCmd::Check { .. } => unreachable!("handled by run"),
    }
}

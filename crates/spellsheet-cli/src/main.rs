//! `spellsheet` — headless command line for flows.
//!
//! Uses exactly the same Flow Core and Runtime as Studio and the MCP
//! server; it is the reference for running flows without GUI or AI.

mod agent_cmd;
mod cli;
mod contract;
mod flow_cmd;
mod plugin_cmd;
mod run_cmd;
mod secret_cmd;
mod session_cmd;

use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use serde_json::{Map, Value};
use spellsheet_core::secret::SecretKind;
use spellsheet_core::testcase;
use spellsheet_core::{
    Actor, ActorKind, ApprovalId, ApprovalStore, DiffKind, FileStore, Flow, FlowDiff, FlowId,
    FlowService, ImportConflict, NewFlow, NewVersion, Policy, PublishInput, UserConfig,
    WorkspaceManifest,
};
use spellsheet_runtime::record::RunRecorder;
use spellsheet_runtime::testing;
use spellsheet_runtime::{
    LogLevel, RunEvent, RunOptions, RunOrigin, RunStatus, RunTrigger, Runtime, StepOutcome,
};
use spellsheet_secrets::{SecretInput, Vault};

use cli::{Cli, Command, PluginCmd, PolicyCmd, SchemaCmd, WorkspaceCmd};
use flow_cmd::{approval_cmd, distribution_cmd, flow_cmd, version_cmd};
use plugin_cmd::{builtin_names, plugin_command};
use run_cmd::{parse_inputs, print_case, project_dirs, resolve, run, runnable};
use secret_cmd::secret_cmd;
use session_cmd::{audit_cmd, session_cmd};

fn actor() -> Actor {
    Actor::new(ActorKind::Cli)
}

fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into()),
        )
        .with_writer(std::io::stderr)
        .init();
    match real_main() {
        Ok(code) => code,
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::from(2)
        }
    }
}

fn real_main() -> Result<ExitCode> {
    let cli = Cli::parse();
    let loaded = spellsheet_adapters::load();
    let adapters = loaded.adapters.clone();
    let runtime = spellsheet_adapters::runtime(&adapters);
    let workspace = || {
        cli.workspace
            .clone()
            .unwrap_or_else(FileStore::default_root)
    };
    let open_service = || -> Result<FlowService> {
        let root = workspace();
        let store = FileStore::open(&root)
            .with_context(|| format!("opening workspace {}", root.display()))?;
        Ok(FlowService::new(store, runtime.registry().clone()))
    };

    match &cli.command {
        Command::Session(cmd) => return session_cmd(cmd),
        Command::Worker(cmd) => {
            return agent_cmd::agent_cmd(open_service()?, &runtime, &workspace(), cmd);
        }
        Command::Schedule(cmd) => {
            return agent_cmd::schedule_cmd(&open_service()?, cmd, parse_inputs);
        }
        Command::Manager(cmd) => return agent_cmd::manager_cmd(cmd),
        Command::Audit {
            since,
            until,
            flow,
            json,
        } => {
            let svc = open_service()?;
            audit_cmd(
                &svc,
                since.as_deref(),
                until.as_deref(),
                flow.as_deref(),
                *json,
            )?;
        }
        Command::Flow(cmd) => {
            let svc = open_service()?;
            flow_cmd(&svc, cmd)?;
        }
        Command::Version(cmd) => {
            let svc = open_service()?;
            version_cmd(&svc, cmd).map_err(core_err)?;
        }
        Command::Policy(cmd) => {
            let path = Policy::path(&workspace());
            match cmd {
                PolicyCmd::Show => {
                    let policy = Policy::load(&path).map_err(core_err)?;
                    println!("{}", serde_json::to_string_pretty(&policy)?);
                }
                PolicyCmd::Check => match Policy::load(&path) {
                    Ok(_) => println!("ok: {}", path.display()),
                    Err(e) => {
                        eprintln!("{}", core_err(e));
                        return Ok(ExitCode::from(1));
                    }
                },
                PolicyCmd::Init => {
                    if path.exists() {
                        bail!("{} already exists", path.display());
                    }
                    let text = serde_json::to_string_pretty(&Policy::default())? + "\n";
                    std::fs::write(&path, text)?;
                    println!("wrote {}", path.display());
                }
            }
        }
        Command::Approval(cmd) => {
            let svc = open_service()?;
            approval_cmd(&ApprovalStore::new(svc.store().local_root()), cmd).map_err(core_err)?;
        }
        Command::Distribution(cmd) => {
            let svc = open_service()?;
            distribution_cmd(&svc, cmd)?;
        }
        Command::Workspace(WorkspaceCmd::Info) => {
            let svc = open_service()?;
            println!("{}", serde_json::to_string_pretty(&svc.store().info())?);
        }
        Command::Workspace(WorkspaceCmd::Init { dir, shared }) => {
            FileStore::init(dir, &WorkspaceManifest { shared: *shared })?;
            let store = FileStore::open(dir)?;
            println!("{}", serde_json::to_string_pretty(&store.info())?);
        }
        Command::Workspace(WorkspaceCmd::Use { dir }) => {
            let dir = std::path::absolute(dir)?;
            FileStore::open(&dir)
                .with_context(|| format!("opening workspace {}", dir.display()))?;
            let mut config = UserConfig::load();
            config.workspace = Some(dir.clone());
            config.save()?;
            println!("default workspace: {}", dir.display());
            if let Some(name) = spellsheet_core::paths::env_var_name("HOME") {
                eprintln!("note: {name} is set and takes precedence");
            }
        }
        Command::Secret(cmd) => {
            let svc = open_service()?;
            secret_cmd(&Vault::open(svc.store().root()), cmd)?;
        }
        Command::Validate { target } => {
            let svc = open_service()?;
            let (flow, bundled) = resolve(&svc, target)?;
            let report = svc.validate_bundled(&flow, &bundled);
            println!("{}", serde_json::to_string_pretty(&report)?);
            if !report.valid {
                return Ok(ExitCode::from(1));
            }
        }
        Command::StepTypes { json } => {
            if *json {
                let defs: Vec<_> = runtime.registry().iter().collect();
                println!("{}", serde_json::to_string_pretty(&defs)?);
            } else {
                for def in runtime.registry().iter() {
                    println!("{:<20} {}", def.step_type, def.label);
                }
            }
        }
        Command::AiGuide { dir, builtin } => {
            let files = if *builtin {
                contract::ai_guide()
            } else {
                spellsheet_core::chat::guide(runtime.registry())
            };
            std::fs::create_dir_all(dir)?;
            for file in files {
                let path = dir.join(&file.name);
                std::fs::write(&path, &file.text)?;
                println!("wrote {}", path.display());
            }
        }
        Command::Plugin(PluginCmd::List) => {
            let problems: Vec<_> = loaded.problems.iter().map(|p| p.to_json()).collect();
            let builtin = builtin_names();
            let taken: Vec<&str> = builtin.iter().map(String::as_str).collect();
            let root = spellsheet_plugins::install::install_root();
            let report = serde_json::json!({
                "dirs": spellsheet_plugins::default_dirs(),
                "installDir": root,
                "plugins": loaded.plugins,
                "problems": problems,
                "installed": spellsheet_plugins::install::list(
                    &spellsheet_plugins::default_dirs(), root.as_deref(), &taken),
            });
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        Command::Plugin(
            cmd @ (PluginCmd::Install { .. }
            | PluginCmd::Update { .. }
            | PluginCmd::Remove { .. }
            | PluginCmd::Enable { .. }
            | PluginCmd::Disable { .. }
            | PluginCmd::Registry { .. }),
        ) => {
            return plugin_command(cmd);
        }
        Command::Plugin(PluginCmd::Check { dir }) => {
            let builtin = builtin_names();
            let taken: Vec<&str> = builtin.iter().map(String::as_str).collect();
            match spellsheet_plugins::Plugin::load(dir, &taken) {
                Ok(plugin) => println!("{}", serde_json::to_string_pretty(&plugin.summary())?),
                Err(problem) => {
                    for line in &problem.problems {
                        eprintln!("{line}");
                    }
                    return Ok(ExitCode::from(1));
                }
            }
        }
        Command::Schema(SchemaCmd::Export { dir }) => {
            std::fs::create_dir_all(dir)?;
            let mut schemas = spellsheet_core::schema::all();
            schemas.push(("run-api.schema.json", spellsheet_runtime::run_api_schema()));
            schemas.extend(contract::files());
            for (name, schema) in schemas {
                let path = dir.join(name);
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(&path, serde_json::to_string_pretty(&schema)? + "\n")?;
                println!("wrote {}", path.display());
            }
        }
        Command::Mcp { allow, writer_chat } => {
            let mut options = spellsheet_mcp::ServerOptions {
                allow: Vec::new(),
                adapters: adapters.clone(),
                writer_chat: *writer_chat,
            };
            for name in allow {
                let Some(class) = spellsheet_mcp::ToolClass::parse(name) else {
                    bail!("unknown tool class: {name} (expected read, write or run)");
                };
                options.allow.push(class);
            }
            let svc = std::sync::Arc::new(open_service()?);
            // stdout carries the protocol; logs already go to stderr.
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?;
            rt.block_on(spellsheet_mcp::serve_stdio(svc, runtime.clone(), options))?;
        }
        Command::Run {
            target,
            draft,
            inputs,
            json,
            vars,
        } => {
            let svc = open_service()?;
            let (flow, version, mut subflows) = runnable(&svc, target, *draft)?;
            let project_dir = project_dirs(&svc, target, &flow, &mut subflows)?;
            let inputs = parse_inputs(inputs)?;
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?;
            let runtime = runtime.clone().for_workspace(
                svc.store().root(),
                Arc::new(Vault::open(svc.store().root())),
            );
            let status = rt.block_on(run(
                &runtime,
                svc.store().local_root(),
                &Policy::path(svc.store().root()),
                flow,
                RunOptions {
                    inputs,
                    version,
                    subflows,
                    project_dir,
                    full_run: true,
                    origin: RunOrigin::new(RunTrigger::Cli),
                    ..RunOptions::default()
                },
                *json,
                *vars,
            ))?;
            return Ok(match status {
                RunStatus::Succeeded => ExitCode::SUCCESS,
                RunStatus::Cancelled => ExitCode::from(130),
                _ => ExitCode::from(1),
            });
        }
        Command::Test {
            target,
            cases,
            draft,
            json,
        } => {
            let svc = open_service()?;
            let (flow, version, mut subflows) = runnable(&svc, target, *draft)?;
            let project_dir = project_dirs(&svc, target, &flow, &mut subflows)?
                .context("the flow has no folder to keep test cases in")?;
            let selected = if cases.is_empty() {
                testcase::load_all(&project_dir).map_err(core_err)?
            } else {
                cases
                    .iter()
                    .map(|name| {
                        testcase::load(&project_dir, name)
                            .map(|case| (name.clone(), case))
                            .map_err(core_err)
                    })
                    .collect::<Result<_>>()?
            };
            if selected.is_empty() {
                bail!(
                    "{} has no test cases; write them as {}/<name>.json",
                    flow.id,
                    testcase::tests_dir(&project_dir).display()
                );
            }
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?;
            let runtime = runtime.clone().for_workspace(
                svc.store().root(),
                Arc::new(Vault::open(svc.store().root())),
            );
            let interrupt = testing::Interrupt::default();
            let stop = interrupt.clone();
            rt.spawn(async move {
                if tokio::signal::ctrl_c().await.is_ok() {
                    eprintln!("cancelling…");
                    stop.stop();
                }
            });
            let policy = Policy::path(svc.store().root());
            let mut results = Vec::new();
            for (name, case) in selected {
                if interrupt.is_stopped() {
                    break;
                }
                let options = RunOptions {
                    inputs: case.inputs.clone(),
                    version,
                    subflows: subflows.clone(),
                    project_dir: Some(project_dir.clone()),
                    full_run: true,
                    origin: RunOrigin::new(RunTrigger::Cli).requested_by(format!("test:{name}")),
                    ..RunOptions::default()
                };
                let result = rt.block_on(testing::run_case(
                    &runtime,
                    testing::Records {
                        workspace: svc.store().local_root(),
                        policy: &policy,
                    },
                    &interrupt,
                    &name,
                    &case,
                    flow.clone(),
                    options,
                ))?;
                if !*json {
                    print_case(&result);
                }
                results.push(result);
            }
            let failed = results.iter().filter(|r| !r.passed).count();
            if *json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "flowId": flow.id,
                        "passed": results.len() - failed,
                        "failed": failed,
                        "cases": results,
                    }))?
                );
            } else {
                println!("{} passed, {failed} failed", results.len() - failed);
            }
            if interrupt.is_stopped() {
                return Ok(ExitCode::from(130));
            }
            return Ok(if failed == 0 {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(1)
            });
        }
    }
    Ok(ExitCode::SUCCESS)
}

/// A core error with its stable code and hint, for the terminal.
fn core_err(e: spellsheet_core::CoreError) -> anyhow::Error {
    let hint = e
        .details()
        .and_then(|d| d.get("hint").and_then(Value::as_str).map(str::to_owned));
    match hint {
        Some(hint) => anyhow::anyhow!("{e} ({})\nhint: {hint}", e.code()),
        None => anyhow::anyhow!("{e} ({})", e.code()),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod cli_tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn the_command_line_is_well_formed() {
        Cli::command().debug_assert();
    }

    #[test]
    fn inputs_are_json_when_they_parse_and_text_otherwise() {
        let inputs = parse_inputs(&[
            "count=3".into(),
            "name=山田".into(),
            "rows=[1,2]".into(),
            "url=https://example.com/?a=b".into(),
        ])
        .unwrap();
        assert_eq!(inputs["count"], serde_json::json!(3));
        assert_eq!(inputs["name"], serde_json::json!("山田"));
        assert_eq!(inputs["rows"], serde_json::json!([1, 2]));
        // Only the first `=` splits the name from the value.
        assert_eq!(inputs["url"], serde_json::json!("https://example.com/?a=b"));
        assert!(parse_inputs(&["no-equals".into()]).is_err());
    }

    #[test]
    fn runs_the_published_version_unless_asked_for_the_draft() {
        let cli = Cli::try_parse_from(["spellsheet", "run", "scn_a"]).unwrap();
        assert!(matches!(cli.command, Command::Run { draft: false, .. }));
        let cli =
            Cli::try_parse_from(["spellsheet", "run", "scn_a", "--draft", "-i", "x=1"]).unwrap();
        let Command::Run { draft, inputs, .. } = cli.command else {
            panic!("not a run");
        };
        assert!(draft);
        assert_eq!(inputs, vec!["x=1".to_owned()]);
        let cli = Cli::try_parse_from([
            "spellsheet",
            "test",
            "scn_a",
            "--case",
            "a",
            "--case",
            "b",
            "--draft",
        ])
        .unwrap();
        let Command::Test { cases, draft, .. } = cli.command else {
            panic!("not a test");
        };
        assert!(draft);
        assert_eq!(cases, ["a", "b"]);
        // The name from before flows were renamed still works.
        assert!(Cli::try_parse_from(["spellsheet", "scenario", "list"]).is_ok());
    }
}

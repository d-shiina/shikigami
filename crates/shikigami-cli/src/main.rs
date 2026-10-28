//! `shikigami` — headless command line for scenarios.
//!
//! Uses exactly the same Scenario Core and Runtime as Studio and the MCP
//! server; it is the reference for running scenarios without GUI or AI.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use serde_json::{Map, Value};
use shikigami_core::{
    Actor, ActorKind, FileStore, NewScenario, Scenario, ScenarioId, ScenarioService,
};
use shikigami_runtime::record::RunRecorder;
use shikigami_runtime::{LogLevel, RunEvent, RunOptions, RunStatus, Runtime, StepOutcome};

#[derive(Parser)]
#[command(name = "shikigami", version, about = "Shikigami RPA command line")]
struct Cli {
    /// Workspace directory (default: $SHIKIGAMI_HOME or the platform data dir).
    #[arg(long, global = true)]
    workspace: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Manage scenarios in the workspace.
    #[command(subcommand)]
    Scenario(ScenarioCmd),
    /// Run a scenario (by ID or JSON file) without GUI or AI.
    Run {
        /// Scenario ID in the workspace, or a path to a scenario JSON file.
        target: String,
        /// Input variable as name=value; value is parsed as JSON, else used as a string.
        #[arg(long = "input", short = 'i', value_name = "NAME=VALUE")]
        inputs: Vec<String>,
        /// Print events as JSON lines instead of human-readable text.
        #[arg(long)]
        json: bool,
    },
    /// Validate a scenario (by ID or JSON file).
    Validate { target: String },
    /// List available step types.
    StepTypes {
        #[arg(long)]
        json: bool,
    },
    /// JSON Schema utilities.
    #[command(subcommand)]
    Schema(SchemaCmd),
    /// Serve MCP over stdio for AI clients (Claude Code, Codex, Cursor, ...).
    Mcp {
        /// Tool classes to expose, comma separated: read, write, run.
        #[arg(long, value_delimiter = ',', default_value = "read,write,run")]
        allow: Vec<String>,
    },
}

#[derive(Subcommand)]
enum ScenarioCmd {
    List,
    Show {
        id: String,
    },
    Create {
        name: String,
    },
    Import {
        file: PathBuf,
    },
    Delete {
        id: String,
    },
    /// Apply edit operations (a JSON array of EditOp) to a scenario.
    Edit {
        id: String,
        /// File containing the JSON array, or `-` for stdin.
        ops: PathBuf,
        /// Fail with REVISION_CONFLICT unless the stored revision matches.
        #[arg(long)]
        expected_revision: Option<u64>,
    },
    Undo {
        id: String,
    },
    Redo {
        id: String,
    },
    History {
        id: String,
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
}

#[derive(Subcommand)]
enum SchemaCmd {
    /// Write JSON Schemas to a directory (default: ./schemas).
    Export {
        #[arg(long, default_value = "schemas")]
        dir: PathBuf,
    },
}

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
    let (runtime, browser) = shikigami_browser::default_runtime();
    let open_service = || -> Result<ScenarioService> {
        let root = cli
            .workspace
            .clone()
            .unwrap_or_else(FileStore::default_root);
        let store = FileStore::open(&root)
            .with_context(|| format!("opening workspace {}", root.display()))?;
        Ok(ScenarioService::new(store, runtime.registry().clone()))
    };

    match &cli.command {
        Command::Scenario(cmd) => {
            let svc = open_service()?;
            scenario_cmd(&svc, cmd)?;
        }
        Command::Validate { target } => {
            let svc = open_service()?;
            let scenario = resolve(&svc, target)?;
            let report = svc.validate(&scenario);
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
        Command::Schema(SchemaCmd::Export { dir }) => {
            std::fs::create_dir_all(dir)?;
            let mut schemas = shikigami_core::schema::all();
            schemas.push(("run-api.schema.json", shikigami_runtime::run_api_schema()));
            for (name, schema) in schemas {
                let path = dir.join(name);
                std::fs::write(&path, serde_json::to_string_pretty(&schema)? + "\n")?;
                println!("wrote {}", path.display());
            }
        }
        Command::Mcp { allow } => {
            let mut options = shikigami_mcp::ServerOptions {
                allow: Vec::new(),
                browser: Some(browser.clone()),
            };
            for name in allow {
                let Some(class) = shikigami_mcp::ToolClass::parse(name) else {
                    bail!("unknown tool class: {name} (expected read, write or run)");
                };
                options.allow.push(class);
            }
            let svc = std::sync::Arc::new(open_service()?);
            // stdout carries the protocol; logs already go to stderr.
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?;
            rt.block_on(shikigami_mcp::serve_stdio(svc, runtime.clone(), options))?;
        }
        Command::Run {
            target,
            inputs,
            json,
        } => {
            let svc = open_service()?;
            let scenario = resolve(&svc, target)?;
            let inputs = parse_inputs(inputs)?;
            let rt = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?;
            let status = rt.block_on(run(&runtime, svc.store().root(), scenario, inputs, *json))?;
            return Ok(match status {
                RunStatus::Succeeded => ExitCode::SUCCESS,
                RunStatus::Cancelled => ExitCode::from(130),
                _ => ExitCode::from(1),
            });
        }
    }
    Ok(ExitCode::SUCCESS)
}

fn scenario_cmd(svc: &ScenarioService, cmd: &ScenarioCmd) -> Result<()> {
    match cmd {
        ScenarioCmd::List => {
            for s in svc.list()? {
                println!(
                    "{}\trev {}\t{} step(s)\t{}",
                    s.id, s.revision, s.step_count, s.name
                );
            }
        }
        ScenarioCmd::Show { id } => {
            println!(
                "{}",
                serde_json::to_string_pretty(&svc.get(&ScenarioId::new(id.as_str()))?)?
            );
        }
        ScenarioCmd::Create { name } => {
            let out = svc.create(
                NewScenario {
                    name: name.clone(),
                    ..Default::default()
                },
                actor(),
            )?;
            println!("{}", out.scenario.id);
        }
        ScenarioCmd::Import { file } => {
            let scenario = load_file(file)?;
            let out = svc.import(scenario, actor())?;
            println!("{}", out.scenario.id);
            for issue in &out.validation.issues {
                eprintln!(
                    "{:?} {} {}: {}",
                    issue.severity, issue.code, issue.path, issue.message
                );
            }
        }
        ScenarioCmd::Delete { id } => {
            svc.delete(&ScenarioId::new(id.as_str()), None, actor())?;
            println!("moved {id} to trash");
        }
        ScenarioCmd::Edit {
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
            let ops: Vec<shikigami_core::EditOp> =
                serde_json::from_str(&text).context("parsing edit operations")?;
            let out = svc.edit(
                &ScenarioId::new(id.as_str()),
                *expected_revision,
                ops,
                actor(),
            )?;
            print_outcome(&out);
        }
        ScenarioCmd::Undo { id } => {
            print_outcome(&svc.undo(&ScenarioId::new(id.as_str()), None, actor())?)
        }
        ScenarioCmd::Redo { id } => {
            print_outcome(&svc.redo(&ScenarioId::new(id.as_str()), None, actor())?)
        }
        ScenarioCmd::History { id, limit } => {
            for entry in svc.history(&ScenarioId::new(id.as_str()), *limit)? {
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

fn print_outcome(out: &shikigami_core::EditOutcome) {
    println!(
        "rev {} ({} issue(s))",
        out.scenario.revision,
        out.validation.issues.len()
    );
    for issue in &out.validation.issues {
        eprintln!(
            "{:?} {} {}: {}",
            issue.severity, issue.code, issue.path, issue.message
        );
    }
}

fn load_file(path: &Path) -> Result<Scenario> {
    let text =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    Ok(shikigami_core::migrate::parse_scenario(&text)?)
}

/// A target is a file path when it ends with `.json` or exists on disk.
fn resolve(svc: &ScenarioService, target: &str) -> Result<Scenario> {
    let path = Path::new(target);
    if target.ends_with(".json") || path.is_file() {
        load_file(path)
    } else {
        Ok(svc.get(&ScenarioId::new(target))?)
    }
}

fn parse_inputs(raw: &[String]) -> Result<Map<String, Value>> {
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

async fn run(
    runtime: &Runtime,
    workspace: &Path,
    scenario: Scenario,
    inputs: Map<String, Value>,
    json: bool,
) -> Result<RunStatus> {
    let handle = runtime
        .start(
            scenario,
            RunOptions {
                inputs,
                run_id: None,
            },
        )
        .map_err(|e| {
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

    let mut recorder = RunRecorder::create(workspace, &handle.run_id)?;
    let report = handle
        .wait_with(|e| {
            if let Err(err) = recorder.write_event(e) {
                tracing::warn!(error = %err, "failed to record event");
            }
            if json {
                if let Ok(line) = serde_json::to_string(e) {
                    println!("{line}");
                }
                return;
            }
            match &e.event {
                RunEvent::RunStarted {
                    scenario_name,
                    revision,
                    ..
                } => {
                    println!("▶ {scenario_name} (rev {revision}) run {}", e.run_id);
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
                RunEvent::StepFinished {
                    step_id,
                    outcome: StepOutcome::Failed,
                    error: Some(err),
                    will_retry,
                    ..
                } => {
                    let retry = if *will_retry { " (retrying)" } else { "" };
                    println!("  ✗ {step_id}: {} {}{retry}", err.code, err.message);
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
    if !json {
        if !report.outputs.is_empty() {
            println!("outputs: {}", serde_json::to_string(&report.outputs)?);
        }
        if let Some(err) = &report.error {
            eprintln!(
                "failed at {}: {} {}",
                err.step_id.as_ref().map(|s| s.as_str()).unwrap_or("-"),
                err.code,
                err.message
            );
        }
    }
    Ok(report.status)
}

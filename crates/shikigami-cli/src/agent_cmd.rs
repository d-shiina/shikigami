//! `shikigami agent …` and `shikigami schedule …`.

use std::path::Path;
use std::process::ExitCode;
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use clap::{Args, Subcommand};
use serde_json::Map;
use shikigami_agent::ipc::{self, Request};
use shikigami_agent::schedule::new_id;
use shikigami_agent::{Agent, Schedule, Schedules, When};
use shikigami_core::{Policy, ScenarioId, ScenarioService};
use shikigami_runtime::Runtime;
use shikigami_secrets::Vault;

#[derive(Subcommand)]
pub enum AgentCmd {
    /// Run the agent in this window until stopped (Ctrl+C or `agent stop`).
    /// It starts scheduled runs and file triggers (`shikigami schedule`).
    Run,
    /// Whether the agent runs, what it is running and what comes next.
    Status {
        #[arg(long)]
        json: bool,
    },
    /// Stop the running agent (runs in progress are cancelled; `finally` runs).
    Stop,
    /// Start the agent whenever you sign in to Windows (a Task Scheduler
    /// task for your user), and start it now.
    Install,
    /// Remove the task `agent install` made (and stop the agent).
    Uninstall,
}

#[derive(Subcommand)]
pub enum ScheduleCmd {
    /// The schedules of this PC and, if the agent runs, when they fire next.
    List {
        #[arg(long)]
        json: bool,
    },
    /// Add a schedule. Give exactly one of --daily, --monthly, --every,
    /// --once, --file-added.
    Add(Box<AddArgs>),
    /// Delete a schedule.
    Remove { id: String },
    /// Turn a schedule on.
    Enable { id: String },
    /// Turn a schedule off (it stays in the list).
    Disable { id: String },
}

#[derive(Args)]
pub struct AddArgs {
    /// Scenario ID (its published version runs).
    scenario: String,
    /// What to call the schedule (default: the scenario's name).
    #[arg(long)]
    name: Option<String>,
    /// Every day at HH:MM.
    #[arg(long, value_name = "HH:MM")]
    daily: Option<String>,
    /// Only on these days with --daily or --every: mon,tue,wed,thu,fri,sat,sun.
    #[arg(long, value_delimiter = ',')]
    days: Vec<String>,
    /// Every month: DAY@HH:MM, e.g. 25@09:00, or -1@18:00 for the last day.
    #[arg(long, value_name = "DAY@HH:MM", allow_hyphen_values = true)]
    monthly: Option<String>,
    /// Every N minutes (with --from / --to for working hours).
    #[arg(long, value_name = "MINUTES")]
    every: Option<u32>,
    #[arg(long, value_name = "HH:MM")]
    from: Option<String>,
    #[arg(long, value_name = "HH:MM")]
    to: Option<String>,
    /// Once, at a local date and time: 2026-11-07T08:00.
    #[arg(long, value_name = "DATETIME")]
    once: Option<String>,
    /// When a file appears in FOLDER (relative to the scenario's folder, e.g. input).
    #[arg(long, value_name = "FOLDER")]
    file_added: Option<String>,
    /// File name pattern for --file-added, e.g. *.xlsx.
    #[arg(long, default_value = "*")]
    pattern: String,
    /// Input variable that gets the new file's full path (--file-added).
    #[arg(long, value_name = "NAME")]
    file_input: Option<String>,
    /// Input variable as name=value (JSON, else text).
    #[arg(long = "input", short = 'i', value_name = "NAME=VALUE")]
    inputs: Vec<String>,
}

fn when_of(a: &AddArgs) -> Result<When> {
    let mut found = Vec::new();
    if let Some(at) = &a.daily {
        found.push(When::Daily {
            at: at.clone(),
            days: a.days.clone(),
        });
    }
    if let Some(m) = &a.monthly {
        let Some((day, at)) = m.split_once('@') else {
            bail!("--monthly is DAY@HH:MM, e.g. 25@09:00");
        };
        found.push(When::Monthly {
            day: day.trim().parse().context("--monthly day")?,
            at: at.to_owned(),
        });
    }
    if let Some(minutes) = a.every {
        found.push(When::Every {
            minutes,
            from: a.from.clone(),
            to: a.to.clone(),
            days: a.days.clone(),
        });
    }
    if let Some(at) = &a.once {
        found.push(When::Once { at: at.clone() });
    }
    if let Some(folder) = &a.file_added {
        found.push(When::FileAdded {
            folder: folder.clone(),
            pattern: a.pattern.clone(),
            input: a.file_input.clone(),
        });
    }
    if found.len() != 1 {
        bail!("give exactly one of --daily, --monthly, --every, --once, --file-added");
    }
    let when = found.remove(0);
    if let Some(problem) = when.problem() {
        bail!("{problem}");
    }
    Ok(when)
}

fn rt() -> Result<tokio::runtime::Runtime> {
    Ok(tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?)
}

fn ask(local_root: &Path, request: &Request) -> Result<Option<ipc::Response>> {
    match rt()?.block_on(ipc::call(local_root, request)) {
        Ok(r) => Ok(Some(r)),
        Err(e) if ipc::not_running(&e) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn agent_cmd(
    svc: ScenarioService,
    runtime: &Runtime,
    workspace: &Path,
    cmd: &AgentCmd,
) -> Result<ExitCode> {
    let local_root = svc.store().local_root().to_path_buf();
    match cmd {
        AgentCmd::Run => {
            let runtime = runtime
                .clone()
                .with_secrets(Arc::new(Vault::open(svc.store().root())))
                .with_policy(Policy::path(svc.store().root()));
            let policy_path = Policy::path(svc.store().root());
            let agent = Agent::new(Arc::new(svc), runtime);
            // Notifications still being sent when the agent stops (a run
            // cancelled by the stop, for one) are waited for below.
            let sending = Arc::new(std::sync::Mutex::new(tokio::task::JoinSet::new()));
            let sends = Arc::clone(&sending);
            agent.on_finished(Arc::new(move |report| {
                let report = report.clone();
                let policy_path = policy_path.clone();
                if let Ok(mut set) = sends.lock() {
                    while set.try_join_next().is_some() {}
                    set.spawn(async move {
                        shikigami_agent::notify::notify(&policy_path, &report).await;
                    });
                }
            }));
            let rt = rt()?;
            rt.block_on(async {
                let stop = agent.stopping();
                let ctrl_c = Arc::clone(&agent);
                tokio::spawn(async move {
                    if tokio::signal::ctrl_c().await.is_ok() {
                        eprintln!("stopping…");
                        ctrl_c.stop();
                    }
                });
                eprintln!("Shikigami agent for {} (Ctrl+C stops)", workspace.display());
                let served = Arc::clone(&agent).serve().await;
                stop.cancel();
                let mut pending = match sending.lock() {
                    Ok(mut set) => std::mem::take(&mut *set),
                    Err(_) => tokio::task::JoinSet::new(),
                };
                let drained = async { while pending.join_next().await.is_some() {} };
                // Each webhook gives up after 15 seconds.
                let _ = tokio::time::timeout(std::time::Duration::from_secs(20), drained).await;
                served
            })
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::AddrInUse {
                    anyhow::anyhow!("{e} (see `shikigami agent status`)")
                } else {
                    e.into()
                }
            })?;
        }
        AgentCmd::Status { json } => {
            let Some(r) = ask(&local_root, &Request::Status)? else {
                if *json {
                    println!("{}", serde_json::json!({ "running": false }));
                } else {
                    println!(
                        "the agent is not running (start it with `shikigami agent run`, or `agent install`)"
                    );
                }
                return Ok(ExitCode::from(1));
            };
            let Some(status) = r.status else {
                bail!("the agent did not answer: {:?}", r.error);
            };
            if *json {
                println!("{}", serde_json::to_string_pretty(&status)?);
                return Ok(ExitCode::SUCCESS);
            }
            println!(
                "agent running (pid {}, since {})",
                status.pid, status.started_at
            );
            if let Some(problem) = &status.problem {
                println!("! schedules not read: {problem}");
            }
            for run in &status.running {
                println!(
                    "▶ {} {} ({})",
                    run.run_id, run.scenario_name, run.started_at
                );
            }
            for s in &status.schedules {
                let next = if !s.enabled {
                    "off".to_owned()
                } else {
                    s.next.clone().unwrap_or_else(|| "on new files".into())
                };
                println!("  {} {} → {}", s.id, s.name, next);
            }
        }
        AgentCmd::Stop => match ask(&local_root, &Request::Stop)? {
            Some(_) => println!("stopping the agent"),
            None => println!("the agent is not running"),
        },
        AgentCmd::Install => install(workspace)?,
        AgentCmd::Uninstall => {
            let _ = ask(&local_root, &Request::Stop);
            uninstall()?;
        }
    }
    Ok(ExitCode::SUCCESS)
}

const TASK_NAME: &str = r"Shikigami\Agent";

#[cfg(windows)]
fn install(workspace: &Path) -> Result<()> {
    let exe = std::env::current_exe()?;
    let command = format!(
        "\"{}\" agent run --workspace \"{}\"",
        exe.display(),
        workspace.display()
    );
    let status = std::process::Command::new("schtasks")
        .args([
            "/Create", "/F", "/SC", "ONLOGON", "/RL", "LIMITED", "/TN", TASK_NAME, "/TR",
        ])
        .arg(&command)
        .status()?;
    if !status.success() {
        bail!("schtasks could not create the task {TASK_NAME}");
    }
    let _ = std::process::Command::new("schtasks")
        .args(["/Run", "/TN", TASK_NAME])
        .status();
    println!(
        "the agent starts when you sign in to Windows (task {TASK_NAME}), and was started now"
    );
    Ok(())
}

#[cfg(windows)]
fn uninstall() -> Result<()> {
    let status = std::process::Command::new("schtasks")
        .args(["/Delete", "/F", "/TN", TASK_NAME])
        .status()?;
    if !status.success() {
        bail!("schtasks could not delete the task {TASK_NAME}");
    }
    println!("removed the task {TASK_NAME}");
    Ok(())
}

#[cfg(not(windows))]
fn install(_workspace: &Path) -> Result<()> {
    bail!(
        "`agent install` registers a Windows Task Scheduler task ({TASK_NAME}); on this system start `shikigami agent run` yourself"
    )
}

#[cfg(not(windows))]
fn uninstall() -> Result<()> {
    bail!("`agent uninstall` removes a Windows Task Scheduler task ({TASK_NAME})")
}

pub fn schedule_cmd(
    svc: &ScenarioService,
    cmd: &ScheduleCmd,
    parse_inputs: impl Fn(&[String]) -> Result<Map<String, serde_json::Value>>,
) -> Result<ExitCode> {
    let local_root = svc.store().local_root().to_path_buf();
    let path = Schedules::path(&local_root);
    let load = || Schedules::load(&path).map_err(crate::core_err);
    match cmd {
        ScheduleCmd::List { json } => {
            let schedules = load()?;
            let status = ask(&local_root, &Request::Status)
                .ok()
                .flatten()
                .and_then(|r| r.status);
            if *json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "schedules": schedules.schedules,
                        "agent": status,
                    }))?
                );
                return Ok(ExitCode::SUCCESS);
            }
            if status.is_none() {
                println!("(the agent is not running: schedules do not fire until it does)");
            }
            for s in &schedules.schedules {
                let next = status
                    .as_ref()
                    .and_then(|st| st.schedules.iter().find(|x| x.id == s.id))
                    .and_then(|x| x.next.clone());
                println!(
                    "{} {} [{}] {} {}{}",
                    s.id,
                    s.name,
                    s.scenario_id,
                    if s.enabled { "on " } else { "off" },
                    serde_json::to_string(&s.when)?,
                    next.map(|n| format!(" → {n}")).unwrap_or_default()
                );
            }
        }
        ScheduleCmd::Add(a) => {
            let id = ScenarioId::new(&a.scenario);
            let scenario = svc.get(&id).map_err(crate::core_err)?;
            let when = when_of(a)?;
            let mut schedules = load()?;
            let schedule = Schedule {
                id: new_id(),
                name: a.name.clone().unwrap_or(scenario.name),
                scenario_id: id.clone(),
                enabled: true,
                when,
                inputs: parse_inputs(&a.inputs)?,
            };
            println!("{}", schedule.id);
            schedules.schedules.push(schedule);
            schedules.save(&path).map_err(crate::core_err)?;
            if svc.published_version(&id).ok().flatten().is_none() {
                eprintln!(
                    "note: {id} has no published version yet; publish it or the schedule fails with NOT_PUBLISHED"
                );
            }
            if ask(&local_root, &Request::Status)?.is_none() {
                eprintln!(
                    "note: the agent is not running; start it with `shikigami agent install` (or `agent run`)"
                );
            }
        }
        ScheduleCmd::Remove { id } | ScheduleCmd::Enable { id } | ScheduleCmd::Disable { id } => {
            let mut schedules = load()?;
            let Some(index) = schedules.schedules.iter().position(|s| &s.id == id) else {
                bail!("no schedule {id} (see `shikigami schedule list`)");
            };
            match cmd {
                ScheduleCmd::Remove { .. } => {
                    schedules.schedules.remove(index);
                }
                ScheduleCmd::Enable { .. } => schedules.schedules[index].enabled = true,
                _ => schedules.schedules[index].enabled = false,
            }
            schedules.save(&path).map_err(crate::core_err)?;
        }
    }
    Ok(ExitCode::SUCCESS)
}

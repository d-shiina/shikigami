//! `spellsheet worker …` and `spellsheet schedule …`.

use std::path::Path;
use std::process::ExitCode;
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use clap::{Args, Subcommand};
use serde_json::Map;
use shikigami_agent::ipc::{self, Request};
use shikigami_agent::schedule::{HolidayShift, new_id};
use shikigami_agent::{Agent, Schedule, Schedules, When};
use shikigami_core::{FlowId, FlowService, Policy};
use shikigami_runtime::Runtime;
use shikigami_secrets::Vault;

#[derive(Subcommand)]
pub enum AgentCmd {
    /// Run the worker in this window until stopped (Ctrl+C or `worker stop`).
    /// It starts scheduled runs and file triggers (`spellsheet schedule`).
    Run,
    /// Whether the worker runs, what it is running and what comes next.
    Status {
        #[arg(long)]
        json: bool,
    },
    /// Stop the running worker (runs in progress are cancelled; `finally` runs).
    Stop,
    /// Start the worker whenever you sign in to Windows (a Task Scheduler
    /// task for your user), and start it now.
    Install,
    /// Remove the task `worker install` made (and stop the worker).
    Uninstall,
    /// Connect this PC to a management server with the one-time code it
    /// gave you. Jobs are taken only when policy.json has `remote.enabled`,
    /// `remote.manager` and `remote.flows` (docs/remote.md).
    Enroll {
        /// The server's URL (https://, or http://localhost).
        manager: String,
        /// The one-time enrollment code.
        code: String,
    },
    /// Forget the management server enrollment and its key.
    Unenroll,
}

#[derive(Subcommand)]
pub enum ManagerCmd {
    /// Run the reference management server (protocol v1) until stopped. Its
    /// state and admin token are kept in --data.
    Serve {
        /// Address to listen on. Put it behind HTTPS (a reverse proxy) for
        /// anything beyond this PC.
        #[arg(long, default_value = "127.0.0.1:8740")]
        listen: std::net::SocketAddr,
        #[arg(long, default_value = "shikigami-manager")]
        data: std::path::PathBuf,
    },
}

/// `spellsheet manager …`.
pub fn manager_cmd(cmd: &ManagerCmd) -> Result<ExitCode> {
    match cmd {
        ManagerCmd::Serve { listen, data } => {
            let manager = shikigami_manager::Manager::open(data)
                .with_context(|| format!("opening {}", data.display()))?;
            eprintln!(
                "SpellSheet manager on http://{listen} (data: {})",
                data.display()
            );
            eprintln!(
                "admin API: Authorization: Bearer <{}>",
                data.join("admin-token").display()
            );
            rt()?.block_on(shikigami_manager::serve(manager, *listen))?;
        }
    }
    Ok(ExitCode::SUCCESS)
}

#[derive(Subcommand)]
pub enum ScheduleCmd {
    /// The schedules of this PC and, if the worker runs, when they fire next.
    List {
        #[arg(long)]
        json: bool,
    },
    /// Add a schedule. Give exactly one of --daily, --monthly, --every,
    /// --once, --file-added, --mail-received.
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
    /// Flow ID (its published version runs).
    flow: String,
    /// What to call the schedule (default: the flow's name).
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
    /// Not on national holidays and the company's days off (holidays.json),
    /// with --daily or --every.
    #[arg(long)]
    skip_holidays: bool,
    /// With --monthly: DAY counts business days (3@09:00 = the third
    /// business day; -1@18:00 = the last).
    #[arg(long)]
    business_day: bool,
    /// With --monthly: when the day is not a business day, run on the
    /// business day before or after it, or skip that month.
    #[arg(long, value_name = "before|after|skip")]
    on_holiday: Option<String>,
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
    /// When a file appears in FOLDER (relative to the flow's folder, e.g. input).
    #[arg(long, value_name = "FOLDER")]
    file_added: Option<String>,
    /// When a mail arrives in FOLDER (e.g. 受信トレイ, or "" for the inbox),
    /// looked for every --every minutes (default 5); narrow it with
    /// --subject-contains / --from-contains. Outlook on this PC.
    #[arg(long, value_name = "FOLDER")]
    mail_received: Option<String>,
    #[arg(long, value_name = "TEXT")]
    subject_contains: Option<String>,
    #[arg(long, value_name = "TEXT")]
    from_contains: Option<String>,
    /// Input variable that gets the new mail (--mail-received).
    #[arg(long, value_name = "NAME")]
    mail_input: Option<String>,
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

            skip_holidays: a.skip_holidays,
        });
    }
    if let Some(m) = &a.monthly {
        let Some((day, at)) = m.split_once('@') else {
            bail!("--monthly is DAY@HH:MM, e.g. 25@09:00");
        };
        found.push(When::Monthly {
            day: day.trim().parse().context("--monthly day")?,
            at: at.to_owned(),

            business_day: a.business_day,
            on_holiday: match a.on_holiday.as_deref() {
                None => None,
                Some("before") => Some(HolidayShift::Before),
                Some("after") => Some(HolidayShift::After),
                Some("skip") => Some(HolidayShift::Skip),
                Some(other) => bail!("--on-holiday is before, after or skip, not {other}"),
            },
        });
    }
    if let Some(folder) = &a.mail_received {
        found.push(When::MailReceived {
            folder: (!folder.trim().is_empty()).then(|| folder.clone()),
            subject_contains: a.subject_contains.clone(),
            from_contains: a.from_contains.clone(),
            via: None,
            account: None,
            minutes: a.every,
            input: a.mail_input.clone(),
        });
    } else if let Some(minutes) = a.every {
        found.push(When::Every {
            minutes,
            from: a.from.clone(),
            to: a.to.clone(),
            days: a.days.clone(),

            skip_holidays: a.skip_holidays,
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
        bail!(
            "give exactly one of --daily, --monthly, --every, --once, --file-added, --mail-received"
        );
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
    svc: FlowService,
    runtime: &Runtime,
    workspace: &Path,
    cmd: &AgentCmd,
) -> Result<ExitCode> {
    let local_root = svc.store().local_root().to_path_buf();
    match cmd {
        AgentCmd::Run => {
            let runtime = runtime.clone().for_workspace(
                svc.store().root(),
                Arc::new(Vault::open(svc.store().root())),
            );
            let policy_path = Policy::path(svc.store().root());
            let agent = Agent::new(Arc::new(svc), runtime);
            // Notifications still being sent when the worker stops (a run
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
                eprintln!(
                    "SpellSheet Worker for {} (Ctrl+C stops)",
                    workspace.display()
                );
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
                    anyhow::anyhow!("{e} (see `spellsheet worker status`)")
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
                        "the worker is not running (start it with `spellsheet worker run`, or `worker install`)"
                    );
                }
                return Ok(ExitCode::from(1));
            };
            let Some(status) = r.status else {
                bail!("the worker did not answer: {:?}", r.error);
            };
            if *json {
                println!("{}", serde_json::to_string_pretty(&status)?);
                return Ok(ExitCode::SUCCESS);
            }
            println!(
                "worker running (pid {}, since {})",
                status.pid, status.started_at
            );
            if let Some(problem) = &status.problem {
                println!("! schedules not read: {problem}");
            }
            if let Some(remote) = &status.remote {
                println!(
                    "management server: {} as {}",
                    remote.manager.as_deref().unwrap_or("(not set)"),
                    remote.worker_id.as_deref().unwrap_or("(not enrolled)")
                );
                if let Some(problem) = &remote.problem {
                    println!("! {problem}");
                }
            }
            for run in &status.running {
                println!("▶ {} {} ({})", run.run_id, run.flow_name, run.started_at);
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
            Some(_) => println!("stopping the worker"),
            None => println!("the worker is not running"),
        },
        AgentCmd::Enroll { manager, code } => {
            let keys = shikigami_agent::remote::default_key_store(&local_root);
            let enrolled = rt()?
                .block_on(shikigami_agent::remote::enroll(
                    &local_root,
                    workspace,
                    keys.as_ref(),
                    manager,
                    code,
                ))
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            println!(
                "enrolled as {} with {}",
                enrolled.worker_id, enrolled.manager
            );
            let policy =
                Policy::load(&Policy::path(svc.store().root())).map_err(crate::core_err)?;
            if !policy.remote.enabled
                || policy
                    .remote
                    .manager
                    .as_deref()
                    .map(|m| m.trim_end_matches('/'))
                    != Some(enrolled.manager.as_str())
            {
                eprintln!(
                    "note: jobs are taken only when policy.json has \"remote\": {{ \"enabled\": true, \"manager\": \"{}\", \"flows\": [...] }}",
                    enrolled.manager
                );
            }
        }
        AgentCmd::Unenroll => {
            let keys = shikigami_agent::remote::default_key_store(&local_root);
            shikigami_agent::remote::unenroll(&local_root, keys.as_ref())
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            println!("this PC is no longer enrolled");
        }
        AgentCmd::Install => install(workspace)?,
        AgentCmd::Uninstall => {
            let _ = ask(&local_root, &Request::Stop);
            uninstall()?;
        }
    }
    Ok(ExitCode::SUCCESS)
}

const TASK_NAME: &str = r"SpellSheet\Worker";

/// The task's names before the rename (`Shikigami\Agent` in releases,
/// `SpellSheet\Agent` on builds from main between them): replaced by
/// `install`, removed by `uninstall`. Old tasks still work meanwhile:
/// `agent` is an alias of `worker`.
#[cfg(windows)]
const LEGACY_TASK_NAMES: [&str; 2] = [r"Shikigami\Agent", r"SpellSheet\Agent"];

#[cfg(windows)]
fn install(workspace: &Path) -> Result<()> {
    let exe = std::env::current_exe()?;
    let command = format!(
        "\"{}\" worker run --workspace \"{}\"",
        exe.display(),
        workspace.display()
    );
    // Two tasks would start two workers for the same workspace.
    remove_legacy_task();
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
        "the worker starts when you sign in to Windows (task {TASK_NAME}), and was started now"
    );
    Ok(())
}

#[cfg(windows)]
fn uninstall() -> Result<()> {
    let legacy = remove_legacy_task();
    let status = std::process::Command::new("schtasks")
        .args(["/Delete", "/F", "/TN", TASK_NAME])
        .stderr(std::process::Stdio::null())
        .status()?;
    if status.success() {
        println!("removed the task {TASK_NAME}");
    } else if !legacy {
        bail!("schtasks could not delete the task {TASK_NAME}");
    }
    Ok(())
}

/// Deletes the tasks an install before the rename made, if there are any.
/// Whether there were.
#[cfg(windows)]
fn remove_legacy_task() -> bool {
    let mut any = false;
    for name in LEGACY_TASK_NAMES {
        let removed = std::process::Command::new("schtasks")
            .args(["/Delete", "/F", "/TN", name])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        if removed {
            println!("removed the task {name} (its name before)");
            any = true;
        }
    }
    any
}

#[cfg(not(windows))]
fn install(_workspace: &Path) -> Result<()> {
    bail!(
        "`worker install` registers a Windows Task Scheduler task ({TASK_NAME}); on this system start `spellsheet worker run` yourself"
    )
}

#[cfg(not(windows))]
fn uninstall() -> Result<()> {
    bail!(
        "`worker uninstall` removes a Windows Task Scheduler task ({TASK_NAME}, and its names before the rename)"
    )
}

pub fn schedule_cmd(
    svc: &FlowService,
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
                println!("(the worker is not running: schedules do not fire until it does)");
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
                    s.flow_id,
                    if s.enabled { "on " } else { "off" },
                    serde_json::to_string(&s.when)?,
                    next.map(|n| format!(" → {n}")).unwrap_or_default()
                );
            }
        }
        ScheduleCmd::Add(a) => {
            let id = FlowId::new(&a.flow);
            let flow = svc.get(&id).map_err(crate::core_err)?;
            let when = when_of(a)?;
            let mut schedules = load()?;
            let schedule = Schedule {
                id: new_id(),
                name: a.name.clone().unwrap_or(flow.name),
                flow_id: id.clone(),
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
                    "note: the worker is not running; start it with `spellsheet worker install` (or `worker run`)"
                );
            }
        }
        ScheduleCmd::Remove { id } | ScheduleCmd::Enable { id } | ScheduleCmd::Disable { id } => {
            let mut schedules = load()?;
            let Some(index) = schedules.schedules.iter().position(|s| &s.id == id) else {
                bail!("no schedule {id} (see `spellsheet schedule list`)");
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

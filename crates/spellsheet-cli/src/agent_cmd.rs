//! `spellsheet worker …` and `spellsheet schedule …`.

use std::path::Path;
use std::process::ExitCode;
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use clap::{Args, Subcommand};
use serde_json::Map;
use spellsheet_agent::ipc::{self, Request};
use spellsheet_agent::schedule::{HolidayShift, new_id};
use spellsheet_agent::{Agent, Schedule, Schedules, When};
use spellsheet_core::{FlowId, FlowService, Policy};
use spellsheet_runtime::Runtime;
use spellsheet_secrets::Vault;

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
    /// task for your user, else the Run key of your user), and start it now.
    Install,
    /// Remove what `worker install` registered (and stop the worker).
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
    /// Point a task made before the product's rename (under the old task
    /// name, or starting the old command) at this command. Writer runs it
    /// after an update; the worker starts with it at the next sign-in.
    #[command(hide = true)]
    Migrate,
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
        #[arg(long, default_value = "spellsheet-manager")]
        data: std::path::PathBuf,
    },
}

/// A manager started before the product's rename kept its state in the old
/// default folder: it moves to the new one, so its workers, jobs and admin
/// token stay.
fn upgrade_legacy_data(data: &Path) {
    let name = data
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    let old = data.with_file_name(spellsheet_core::paths::legacy_spelling(name));
    if old != data
        && old.is_dir()
        && !data.exists()
        && let Err(e) = std::fs::rename(&old, data)
    {
        eprintln!("cannot move {} to {}: {e}", old.display(), data.display());
    }
}

/// `spellsheet manager …`.
pub fn manager_cmd(cmd: &ManagerCmd) -> Result<ExitCode> {
    match cmd {
        ManagerCmd::Serve { listen, data } => {
            upgrade_legacy_data(data);
            let manager = spellsheet_manager::Manager::open(data)
                .with_context(|| format!("opening {}", data.display()))?;
            eprintln!(
                "SpellSheet manager on http://{listen} (data: {})",
                data.display()
            );
            eprintln!(
                "admin API: Authorization: Bearer <{}>",
                data.join("admin-token").display()
            );
            rt()?.block_on(spellsheet_manager::serve(manager, *listen))?;
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
            // Started at sign-in by the task or the Run key, it has a console
            // window of its own: closing it would stop the worker.
            if spellsheet_desktop::console::leave_own_console() {
                tracing::debug!("left the console Windows opened for the worker");
            }
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
            let waiting_sends = Arc::clone(&sending);
            let waiting_policy = policy_path.clone();
            agent.on_finished(Arc::new(move |report| {
                let report = report.clone();
                let policy_path = policy_path.clone();
                if let Ok(mut set) = sends.lock() {
                    while set.try_join_next().is_some() {}
                    set.spawn(async move {
                        spellsheet_agent::notify::notify(&policy_path, &report).await;
                    });
                }
            }));
            // A run waiting for a person: nobody may be at this PC.
            agent.on_waiting(Arc::new(move |waiting| {
                let waiting = waiting.clone();
                let policy_path = waiting_policy.clone();
                if let Ok(mut set) = waiting_sends.lock() {
                    while set.try_join_next().is_some() {}
                    set.spawn(async move {
                        spellsheet_agent::notify::notify_waiting(&policy_path, &waiting).await;
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
            let keys = spellsheet_agent::remote::default_key_store(&local_root);
            let enrolled = rt()?
                .block_on(spellsheet_agent::remote::enroll(
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
            let keys = spellsheet_agent::remote::default_key_store(&local_root);
            spellsheet_agent::remote::unenroll(&local_root, keys.as_ref())
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            println!("this PC is no longer enrolled");
        }
        AgentCmd::Install => install(workspace)?,
        AgentCmd::Migrate => migrate()?,
        AgentCmd::Uninstall => {
            let _ = ask(&local_root, &Request::Stop);
            uninstall()?;
        }
    }
    Ok(ExitCode::SUCCESS)
}

const TASK_NAME: &str = r"SpellSheet\Worker";

/// The task's names before the rename (`<old name>\Agent` in releases,
/// `SpellSheet\Agent` on builds from main between them): replaced by
/// `install` and `migrate`, removed by `uninstall`. Old tasks still work
/// meanwhile: `agent` is an alias of `worker`.
#[cfg(windows)]
fn legacy_task_names() -> [String; 2] {
    [
        format!(r"{}\Agent", spellsheet_core::paths::LEGACY_APP_DIR),
        r"SpellSheet\Agent".to_owned(),
    ]
}

/// Where the worker is registered when Task Scheduler refuses the task
/// (some PCs let only administrators make tasks): the per-user Run key,
/// which every user may write.
#[cfg(windows)]
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(windows)]
const RUN_VALUE: &str = "SpellSheet Worker";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Runs a console program (schtasks, reg) without a window and without
/// passing its output on: whether it succeeded, and what it said, read in
/// the console's code page (a pipe gets CP932 on Japanese Windows, not
/// UTF-8).
#[cfg(windows)]
fn quiet<I, S>(program: &str, args: I) -> (bool, String)
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    use std::os::windows::process::CommandExt as _;
    let out = std::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match out {
        Ok(out) => {
            let mut said = spellsheet_files::encoding::console_text(&out.stderr);
            if said.trim().is_empty() {
                said = spellsheet_files::encoding::console_text(&out.stdout);
            }
            (out.status.success(), said.trim().to_owned())
        }
        Err(e) => (false, format!("cannot start {program}: {e}")),
    }
}

/// How the worker was registered to start at sign-in.
#[cfg(windows)]
enum Registered {
    Task,
    RunKey,
}

/// Registers `"<exe>" <arguments>` to start whenever this user signs in:
/// the task `TASK_NAME`, else the Run key. The error is what Windows said.
#[cfg(windows)]
fn register_at_sign_in(exe: &Path, arguments: &str) -> Result<Registered> {
    let task = create_task(exe, arguments);
    match task {
        Ok(()) => {
            // One registration only: two would start two workers.
            let _ = quiet("reg", ["delete", RUN_KEY, "/v", RUN_VALUE, "/f"]);
            Ok(Registered::Task)
        }
        Err(task_said) => {
            tracing::warn!(said = %task_said, "Task Scheduler refused the task; using the Run key");
            let command = format!("\"{}\" {arguments}", exe.display());
            let (ok, reg_said) = quiet(
                "reg",
                [
                    "add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", &command, "/f",
                ],
            );
            if ok {
                Ok(Registered::RunKey)
            } else {
                bail!(
                    "could not register the worker to start at sign-in: Windows said \"{}\"",
                    if reg_said.is_empty() {
                        task_said
                    } else {
                        reg_said
                    }
                )
            }
        }
    }
}

/// Makes the task from XML: a logon trigger for this user only, which needs
/// no administrator (`schtasks /SC ONLOGON` makes one for every user, which
/// does: "Access is denied"), with no time limit (`/SC` stops a task after
/// 72 hours) and on battery too.
#[cfg(windows)]
fn create_task(exe: &Path, arguments: &str) -> Result<(), String> {
    let user = match (std::env::var("USERDOMAIN"), std::env::var("USERNAME")) {
        (Ok(domain), Ok(name)) if !domain.is_empty() => format!(r"{domain}\{name}"),
        (_, Ok(name)) => name,
        _ => return Err("USERNAME is not set".into()),
    };
    let xml = task_xml(&user, &exe.display().to_string(), arguments);
    // schtasks reads UTF-16 with a BOM.
    let bytes: Vec<u8> = std::iter::once(0xFEFF_u16)
        .chain(xml.encode_utf16())
        .flat_map(u16::to_le_bytes)
        .collect();
    let file = tempfile::Builder::new()
        .prefix("spellsheet-task-")
        .suffix(".xml")
        .tempfile()
        .map_err(|e| e.to_string())?;
    std::fs::write(file.path(), bytes).map_err(|e| e.to_string())?;
    let (ok, said) = quiet(
        "schtasks",
        [
            std::ffi::OsStr::new("/Create"),
            "/F".as_ref(),
            "/TN".as_ref(),
            TASK_NAME.as_ref(),
            "/XML".as_ref(),
            file.path().as_os_str(),
        ],
    );
    if ok { Ok(()) } else { Err(said) }
}

/// Starts the worker now, apart from this process (it outlives it, and its
/// output does not hold the pipes of whoever ran `worker install`).
#[cfg(windows)]
fn start_now(exe: &Path, workspace: &Path) -> Result<()> {
    use std::os::windows::process::CommandExt as _;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    std::process::Command::new(exe)
        .args(["worker", "run", "--workspace"])
        .arg(workspace)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .context("cannot start the worker")?;
    Ok(())
}

#[cfg(windows)]
fn install(workspace: &Path) -> Result<()> {
    let exe = std::env::current_exe()?;
    let arguments = format!("worker run --workspace \"{}\"", workspace.display());
    // Two tasks would start two workers for the same workspace.
    remove_legacy_task();
    match register_at_sign_in(&exe, &arguments)? {
        Registered::Task => {
            if !quiet("schtasks", ["/Run", "/TN", TASK_NAME]).0 {
                start_now(&exe, workspace)?;
            }
            println!(
                "the worker starts when you sign in to Windows (task {TASK_NAME}), and was started now"
            );
        }
        Registered::RunKey => {
            start_now(&exe, workspace)?;
            println!(
                "the worker starts when you sign in to Windows ({RUN_KEY}, value \"{RUN_VALUE}\": Task Scheduler refused the task), and was started now"
            );
        }
    }
    Ok(())
}

#[cfg(windows)]
fn uninstall() -> Result<()> {
    let legacy = remove_legacy_task();
    let task = quiet("schtasks", ["/Delete", "/F", "/TN", TASK_NAME]).0;
    if task {
        println!("removed the task {TASK_NAME}");
    }
    let run = quiet("reg", ["delete", RUN_KEY, "/v", RUN_VALUE, "/f"]).0;
    if run {
        println!("removed \"{RUN_VALUE}\" from {RUN_KEY}");
    }
    if !(task || run || legacy) {
        bail!("the worker was not registered to start at sign-in");
    }
    Ok(())
}

/// Deletes the tasks an install before the rename made, if there are any.
/// Whether there were.
#[cfg(windows)]
fn remove_legacy_task() -> bool {
    let mut any = false;
    for name in legacy_task_names() {
        if quiet("schtasks", ["/Delete", "/F", "/TN", &name]).0 {
            println!("removed the task {name} (its name before)");
            any = true;
        }
    }
    any
}

/// The task `worker install` makes, as Task Scheduler XML: started at
/// `user`'s sign-in, as that user, without administrator rights, with no
/// time limit.
#[cfg_attr(not(windows), allow(dead_code))]
fn task_xml(user: &str, command: &str, arguments: &str) -> String {
    let user = escape_xml(user);
    let command = escape_xml(command);
    let arguments = escape_xml(arguments);
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>SpellSheet Worker: runs the schedules of SpellSheet</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{user}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{command}</Command>
      <Arguments>{arguments}</Arguments>
    </Exec>
  </Actions>
</Task>
"#
    )
}

#[cfg_attr(not(windows), allow(dead_code))]
fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// The task (`schtasks /Query /XML`) starts the old command, or has an old
/// name: the arguments to give the new one (`worker run --workspace …`).
#[cfg_attr(not(windows), allow(dead_code))]
fn legacy_task_arguments(name: &str, xml: &str, legacy_name: bool) -> Option<String> {
    let tag = |t: &str| {
        let start = xml.find(&format!("<{t}>"))? + t.len() + 2;
        let end = start + xml[start..].find(&format!("</{t}>"))?;
        Some(unescape_xml(xml[start..end].trim()))
    };
    let command = tag("Command")?;
    let file = command
        .trim_matches('"')
        .rsplit(['\\', '/'])
        .next()?
        .to_ascii_lowercase();
    let old_exe = format!(
        "{}.exe",
        spellsheet_core::paths::LEGACY_APP_DIR.to_ascii_lowercase()
    );
    if !legacy_name && file != old_exe {
        return None;
    }
    let arguments = tag("Arguments").unwrap_or_default();
    let arguments = arguments
        .strip_prefix("agent ")
        .map(|rest| format!("worker {rest}"))
        .unwrap_or(arguments);
    tracing::debug!(task = name, %arguments, "task made before the rename");
    Some(arguments)
}

#[cfg_attr(not(windows), allow(dead_code))]
fn unescape_xml(text: &str) -> String {
    text.replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

#[cfg(windows)]
fn migrate() -> Result<()> {
    use std::os::windows::process::CommandExt as _;
    let query = |name: &str| {
        let out = std::process::Command::new("schtasks")
            .args(["/Query", "/XML", "ONE", "/TN", name])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        out.status
            .success()
            .then(|| spellsheet_files::encoding::console_text(&out.stdout))
    };
    let mut found = None;
    if let Some(xml) = query(TASK_NAME) {
        found = legacy_task_arguments(TASK_NAME, &xml, false);
    }
    for name in legacy_task_names() {
        if found.is_some() {
            break;
        }
        if let Some(xml) = query(&name) {
            found = legacy_task_arguments(&name, &xml, true);
        }
    }
    let Some(arguments) = found else {
        return Ok(());
    };
    let exe = std::env::current_exe()?;
    // Not started now: a worker of the old command may still be running.
    register_at_sign_in(&exe, &arguments)?;
    remove_legacy_task();
    println!("the worker now starts \"{}\" {arguments}", exe.display());
    Ok(())
}

#[cfg(not(windows))]
fn migrate() -> Result<()> {
    Ok(())
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

#[cfg(test)]
mod migrate_tests {
    use super::legacy_task_arguments;

    fn xml(command: &str, arguments: &str) -> String {
        format!(
            "<Task><Actions><Exec><Command>{command}</Command><Arguments>{arguments}</Arguments></Exec></Actions></Task>"
        )
    }

    #[test]
    fn a_task_starting_the_old_command_moves_to_the_new_one() {
        let old = format!(
            r"C:\Users\a\AppData\Local\SpellSheet Writer\{}.exe",
            spellsheet_core::paths::LEGACY_APP_DIR
        );
        let task = xml(&old, "agent run --workspace &quot;D:\\業務&quot;");
        assert_eq!(
            legacy_task_arguments("t", &task, false).as_deref(),
            Some("worker run --workspace \"D:\\業務\"")
        );
    }

    #[test]
    fn a_task_already_on_the_new_command_is_left_alone() {
        let task = xml(
            r"C:\x\spellsheet.exe",
            "worker run --workspace &quot;D:\\w&quot;",
        );
        assert_eq!(legacy_task_arguments("t", &task, false), None);
        // Under an old task name it is moved all the same.
        assert!(legacy_task_arguments("t", &task, true).is_some());
    }

    #[test]
    fn the_task_starts_at_this_users_sign_in_only() {
        let task = super::task_xml(
            r"PC\山田",
            r"C:\Program Files\SpellSheet\spellsheet.exe",
            "worker run --workspace \"D:\\R&D <業務>\"",
        );
        // A logon trigger without a user needs an administrator.
        assert!(task.contains(
            "<LogonTrigger>\n      <Enabled>true</Enabled>\n      <UserId>PC\\山田</UserId>"
        ));
        assert!(task.contains("<RunLevel>LeastPrivilege</RunLevel>"));
        assert!(task.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
        // Read back the way `worker migrate` reads a task.
        assert_eq!(
            legacy_task_arguments("t", &task, true).as_deref(),
            Some("worker run --workspace \"D:\\R&D <業務>\"")
        );
    }
}

#[cfg(test)]
mod manager_tests {
    #[test]
    fn the_old_default_folder_moves_to_the_new_one() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join(spellsheet_core::paths::legacy_spelling(
            "spellsheet-manager",
        ));
        std::fs::create_dir(&old).unwrap();
        std::fs::write(old.join("admin-token"), "t").unwrap();
        let new = dir.path().join("spellsheet-manager");
        super::upgrade_legacy_data(&new);
        assert!(new.join("admin-token").is_file());
        assert!(!old.exists());
    }
}

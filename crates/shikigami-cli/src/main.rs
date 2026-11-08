//! `shikigami` — headless command line for flows.
//!
//! Uses exactly the same Flow Core and Runtime as Studio and the MCP
//! server; it is the reference for running flows without GUI or AI.

mod agent_cmd;
mod contract;

use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use serde_json::{Map, Value};
use shikigami_core::secret::SecretKind;
use shikigami_core::testcase;
use shikigami_core::{
    Actor, ActorKind, ApprovalId, ApprovalStore, DiffKind, FileStore, Flow, FlowDiff, FlowId,
    FlowService, ImportConflict, NewFlow, NewVersion, Policy, PublishInput, UserConfig,
    WorkspaceManifest,
};
use shikigami_runtime::record::RunRecorder;
use shikigami_runtime::testing;
use shikigami_runtime::{
    LogLevel, RunEvent, RunOptions, RunOrigin, RunStatus, RunTrigger, Runtime, StepOutcome,
};
use shikigami_secrets::{SecretInput, Vault};

#[derive(Parser)]
#[command(name = "shikigami", version, about = "SpellSheet RPA command line")]
struct Cli {
    /// Workspace directory (default: $SPELLSHEET_HOME or the platform data dir).
    #[arg(long, global = true)]
    workspace: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Manage flows in the workspace.
    // `scenario` is the name from before flows were renamed (up to 0.1.2).
    #[command(subcommand, alias = "scenario")]
    Flow(FlowCmd),
    /// Named versions of a flow: save, list, compare, restore.
    #[command(subcommand)]
    Version(VersionCmd),
    /// Workspace location and sharing.
    #[command(subcommand)]
    Workspace(WorkspaceCmd),
    /// Run a flow (by ID or JSON file) without GUI or AI. A flow in
    /// the workspace runs its published version (see `version publish`).
    Run {
        /// Flow ID in the workspace, or a path to a flow JSON file.
        target: String,
        /// Run the working content instead of the published version.
        #[arg(long)]
        draft: bool,
        /// Input variable as name=value; value is parsed as JSON, else used as a string.
        #[arg(long = "input", short = 'i', value_name = "NAME=VALUE")]
        inputs: Vec<String>,
        /// Print events as JSON lines instead of human-readable text.
        #[arg(long)]
        json: bool,
        /// Also print every variable change (value and the step that set it).
        #[arg(long)]
        vars: bool,
    },
    /// Run a flow's test cases (`tests/<name>.json` in its folder) and
    /// compare what came out with what each case expects. Exits 1 when a
    /// case fails. Like `run`, it uses the published version unless --draft.
    Test {
        /// Flow ID in the workspace, or a path to a flow JSON file.
        target: String,
        /// Only this case (the file name without .json); repeatable.
        #[arg(long = "case", value_name = "NAME")]
        cases: Vec<String>,
        /// Run the working content instead of the published version.
        #[arg(long)]
        draft: bool,
        /// Print the results as one JSON object.
        #[arg(long)]
        json: bool,
    },
    /// Validate a flow (by ID or JSON file).
    Validate { target: String },
    /// List available step types.
    StepTypes {
        #[arg(long)]
        json: bool,
    },
    /// Write the guide for an AI that has no MCP (Microsoft Copilot, a chat
    /// window): short instructions for an agent's instruction box and a
    /// reference of every step type and function, to attach as knowledge.
    /// The AI answers with JSON that Studio takes in (AI の答えを貼り付け).
    AiGuide {
        /// Folder to write the files to.
        #[arg(long, default_value = ".")]
        dir: PathBuf,
        /// Leave the plugins installed on this PC out.
        #[arg(long)]
        builtin: bool,
    },
    /// Node plugins installed on this PC (step types from other programs).
    #[command(subcommand)]
    Plugin(PluginCmd),
    /// JSON Schema utilities.
    #[command(subcommand)]
    Schema(SchemaCmd),
    /// Manage secrets (logins) that flows type by name. Values are
    /// encrypted in the workspace; the key is kept by Windows Credential Manager.
    #[command(subcommand)]
    Secret(SecretCmd),
    /// The workspace policy (policy.json): allowed sites and programs, and
    /// what an AI may do without a person's approval.
    #[command(subcommand)]
    Policy(PolicyCmd),
    /// Requests from AI clients waiting for a person's approval.
    #[command(subcommand)]
    Approval(ApprovalCmd),
    /// The agent: runs flows unattended on this PC (schedules, file
    /// triggers) so Task Scheduler is not needed.
    #[command(subcommand)]
    Agent(agent_cmd::AgentCmd),
    /// When the agent starts flows by itself: daily, monthly, every few
    /// minutes, once, or when a file appears.
    #[command(subcommand)]
    Schedule(agent_cmd::ScheduleCmd),
    /// This PC's screen for desktop flows: whether it takes input, when it
    /// locks by itself, and leaving a Remote Desktop session without
    /// locking it.
    #[command(subcommand)]
    Session(SessionCmd),
    /// A small reference management server for agents (protocol v1).
    #[command(subcommand)]
    Manager(agent_cmd::ManagerCmd),
    /// This PC's audit trail: who changed, published and ran which flow,
    /// from Studio, the CLI, an AI, a schedule or a management server.
    Audit {
        /// Only from this day or time on (2026-11-01 or RFC 3339).
        #[arg(long)]
        since: Option<String>,
        /// Only before this day or time.
        #[arg(long)]
        until: Option<String>,
        /// Only this flow.
        #[arg(long)]
        flow: Option<String>,
        /// One JSON object per line.
        #[arg(long)]
        json: bool,
    },
    /// Serve MCP over stdio for AI clients (Claude Code, Codex, Cursor, ...).
    Mcp {
        /// Tool classes to expose, comma separated: read, write, run.
        #[arg(long, value_delimiter = ',', default_value = "read,write,run")]
        allow: Vec<String>,
    },
}

#[derive(Subcommand)]
enum SessionCmd {
    /// Whether the screen takes mouse and keyboard input now, whether this
    /// is a Remote Desktop session, and when the PC locks without input.
    Status {
        #[arg(long)]
        json: bool,
    },
    /// Closes this Remote Desktop connection without locking the session
    /// (it moves to the PC's own screen), so desktop flows keep running.
    /// Needs an administrator (Windows asks). What runs is visible on a monitor plugged
    /// into the PC.
    Release,
}

#[derive(Subcommand)]
enum FlowCmd {
    List,
    Show {
        id: String,
    },
    Create {
        name: String,
    },
    /// Import a bundle (`*.shikigami.json`) or a flow JSON file.
    Import {
        file: PathBuf,
        /// When the flow ID already exists: `update` it (undoable) or
        /// import a `copy` under a new ID.
        #[arg(long, value_enum)]
        on_conflict: Option<OnConflict>,
    },
    /// Write a bundle (flow + versions) for another workspace or person.
    Export {
        id: String,
        /// Output file (default: stdout).
        #[arg(long, short = 'o')]
        output: Option<PathBuf>,
        /// Leave the named versions out.
        #[arg(long)]
        no_versions: bool,
    },
    Delete {
        id: String,
    },
    /// Apply edit operations (a JSON array of EditOp) to a flow.
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
    /// List the files in the flow's folder (input/, config/, …).
    Files {
        id: String,
    },
    /// Copy a file into the flow's folder.
    AddFile {
        id: String,
        file: PathBuf,
        /// Where in the folder (default: input/<file name>).
        #[arg(long)]
        to: Option<String>,
        /// Replace an existing file.
        #[arg(long)]
        overwrite: bool,
    },
}

#[derive(Clone, Copy, clap::ValueEnum)]
enum OnConflict {
    Update,
    Copy,
}

#[derive(Subcommand)]
enum VersionCmd {
    /// Save the current content as a named version.
    Create {
        id: String,
        name: String,
        #[arg(long, default_value = "")]
        note: String,
    },
    List {
        id: String,
    },
    /// Print one version (including the flow snapshot) as JSON.
    Show {
        id: String,
        number: u32,
    },
    /// Compare two versions. Defaults: FROM = latest version, TO = current content.
    Diff {
        id: String,
        from: Option<u32>,
        to: Option<u32>,
        #[arg(long)]
        json: bool,
    },
    /// Make the current content equal to a version (one undoable edit).
    Restore {
        id: String,
        number: u32,
    },
    /// Make a version the one `shikigami run <id>` (unattended) executes.
    /// Without NUMBER the current content is published, saved as a new
    /// version first unless one matches it.
    Publish {
        id: String,
        number: Option<u32>,
        /// Name of the version created for the current content.
        #[arg(long)]
        name: Option<String>,
        #[arg(long, default_value = "")]
        note: String,
    },
    /// Stop unattended runs until a version is published again.
    Unpublish {
        id: String,
        #[arg(long, default_value = "")]
        note: String,
    },
}

#[derive(Subcommand)]
enum PolicyCmd {
    /// Print the policy in force (the defaults when there is no policy.json).
    Show,
    /// Check policy.json; exits with 1 when it is broken.
    Check,
    /// Write policy.json with the defaults, to edit (keeps an existing file).
    Init,
}

#[derive(Subcommand)]
enum ApprovalCmd {
    /// Requests waiting for an answer.
    List {
        #[arg(long)]
        json: bool,
    },
    /// Approve one request (the AI may then run that exact action once).
    Approve { id: String },
    /// Refuse one request.
    Deny { id: String },
}

#[derive(Subcommand)]
enum WorkspaceCmd {
    /// Show where this workspace keeps shared and per-PC data.
    Info,
    /// Prepare a folder as a workspace. With --shared, several people can use
    /// it (OneDrive, a file server); undo history and run logs stay on each PC.
    Init {
        dir: PathBuf,
        #[arg(long)]
        shared: bool,
    },
    /// Make DIR the default workspace for Studio, the CLI and the MCP server.
    Use { dir: PathBuf },
}

#[derive(Subcommand)]
enum SecretCmd {
    /// List registered secrets (names, user names, sites; never values).
    List {
        #[arg(long)]
        json: bool,
    },
    /// Register a secret or update it (options left out keep their value).
    Set {
        name: String,
        /// What it holds: login (default), api-key (a key for a web API, given as the
        /// password) or oauth (an OAuth app: --username = client ID, password = client secret).
        #[arg(long, value_parser = parse_secret_kind)]
        kind: Option<SecretKind>,
        #[arg(long)]
        username: Option<String>,
        /// Read the password from the first line of stdin instead of asking.
        #[arg(long)]
        password_stdin: bool,
        /// Ask for the password (hidden input). Default when the secret is new.
        #[arg(long, conflicts_with = "password_stdin")]
        password: bool,
        /// MFA setup key (base32) or the otpauth:// text of the QR code; "" removes it.
        #[arg(long)]
        totp: Option<String>,
        /// Site the secret may be typed into (repeatable), e.g. https://example.com
        #[arg(long = "site", value_name = "URL")]
        sites: Vec<String>,
        #[arg(long)]
        description: Option<String>,
        /// Read the user name and password from this generic credential of
        /// Windows Credential Manager each time they are used ("" goes back
        /// to values kept by Shikigami).
        #[arg(long, value_name = "ADDRESS", conflicts_with_all = ["password", "password_stdin"])]
        windows_credential: Option<String>,
    },
    /// List the generic credentials of Windows Credential Manager a secret
    /// can be linked to (addresses and user names, never passwords).
    WindowsCredentials,
    /// Delete a secret.
    Remove { name: String },
    /// Forget a saved browser login (`session` of browser.open).
    Logout { session: String },
    /// Delete every secret, saved login and the key, so secrets can be
    /// registered again (e.g. after copying the workspace to another PC).
    Reset {
        /// Confirm the deletion.
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Subcommand)]
enum PluginCmd {
    /// Show the loaded plugins and the ones that could not be loaded.
    List,
    /// Check the plugin in DIR (manifest, schemas, examples) without
    /// installing it.
    Check { dir: PathBuf },
    /// Install an extension from a zip file or folder, an https zip URL or
    /// a GitHub repository (its latest release). Without --yes, only shows
    /// what it is: its nodes, what they send outside and the program it
    /// starts.
    Install {
        source: String,
        /// Install it (the program runs on this PC: install only what you trust).
        #[arg(long)]
        yes: bool,
    },
    /// Update an installed extension from where it was installed from.
    Update {
        name: String,
        #[arg(long)]
        yes: bool,
    },
    /// Remove an installed extension.
    Remove { name: String },
    /// Turn an installed extension on.
    Enable { name: String },
    /// Turn an installed extension off (kept, but its nodes are not loaded).
    Disable { name: String },
    /// Show or set (`--set URL`, empty to clear) the registry index URL,
    /// and list the extensions it offers.
    Registry {
        #[arg(long)]
        set: Option<String>,
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

fn builtin_names() -> Vec<String> {
    shikigami_adapters::builtin()
        .iter()
        .map(|a| a.name().to_owned())
        .collect()
}

/// `shikigami plugin install / update / remove / enable / disable / registry`.
fn plugin_command(cmd: &PluginCmd) -> Result<ExitCode> {
    use shikigami_plugins::install::{self, Source};
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
            "installed into {} (restart Studio and AI clients to use it)",
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
                shikigami_plugins::install::list(std::slice::from_ref(&root), Some(&root), &taken)
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
        PluginCmd::Registry { set } => {
            if let Some(url) = set {
                install::set_registry_url(url).map_err(|e| anyhow::anyhow!(e))?;
            }
            let Some(url) = install::registry_url() else {
                eprintln!(
                    "no registry is set (shikigami plugin registry --set https://…/index.json)"
                );
                return Ok(ExitCode::SUCCESS);
            };
            let list = rt.block_on(install::fetch_registry(&url))?;
            println!(
                "{}",
                serde_json::to_string_pretty(
                    &serde_json::json!({ "registry": url, "extensions": list })
                )?
            );
            Ok(ExitCode::SUCCESS)
        }
        PluginCmd::List | PluginCmd::Check { .. } => unreachable!("handled by run"),
    }
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
    let loaded = shikigami_adapters::load();
    let adapters = loaded.adapters.clone();
    let runtime = shikigami_adapters::runtime(&adapters);
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
        Command::Agent(cmd) => {
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
            if let Some(name) = shikigami_core::paths::env_var_name("HOME") {
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
                shikigami_core::chat::guide(runtime.registry())
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
            let root = shikigami_plugins::install::install_root();
            let report = serde_json::json!({
                "dirs": shikigami_plugins::default_dirs(),
                "installDir": root,
                "plugins": loaded.plugins,
                "problems": problems,
                "installed": shikigami_plugins::install::list(
                    &shikigami_plugins::default_dirs(), root.as_deref(), &taken),
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
            match shikigami_plugins::Plugin::load(dir, &taken) {
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
            let mut schemas = shikigami_core::schema::all();
            schemas.push(("run-api.schema.json", shikigami_runtime::run_api_schema()));
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
        Command::Mcp { allow } => {
            let mut options = shikigami_mcp::ServerOptions {
                allow: Vec::new(),
                adapters: adapters.clone(),
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

fn parse_secret_kind(text: &str) -> Result<SecretKind, String> {
    SecretKind::parse(text).ok_or_else(|| "login, api-key or oauth".to_owned())
}

fn secret_cmd(vault: &Vault, cmd: &SecretCmd) -> Result<()> {
    match cmd {
        SecretCmd::List { json } => {
            let list = vault.list()?;
            if *json {
                println!("{}", serde_json::to_string_pretty(&list)?);
            } else if list.is_empty() {
                println!("(no secrets; key store: {})", vault.key_location());
            } else {
                for s in list {
                    let fields: Vec<_> = s.fields.iter().map(|f| f.as_str()).collect();
                    let windows = s
                        .windows_credential
                        .map(|t| format!("\twindows={t}"))
                        .unwrap_or_default();
                    println!(
                        "{}\tkind={}\tuser={}\tfields={}\tsites={}{windows}",
                        s.name,
                        s.kind.as_str(),
                        s.username,
                        fields.join(","),
                        s.sites.join(" ")
                    );
                }
            }
        }
        SecretCmd::Set {
            name,
            kind,
            username,
            password_stdin,
            password,
            totp,
            sites,
            description,
            windows_credential,
        } => {
            let known = vault.summaries()?.into_iter().find(|s| &s.name == name);
            let is_new = known.is_none();
            let what = match kind.or(known.map(|s| s.kind)).unwrap_or_default() {
                SecretKind::Login => "パスワード",
                SecretKind::ApiKey => "API キー",
                SecretKind::Oauth => "クライアント シークレット",
            };
            let password = if *password_stdin {
                let mut line = String::new();
                std::io::stdin().read_line(&mut line)?;
                Some(line.trim_end_matches(['\r', '\n']).to_owned())
            } else if *password
                || (is_new
                    && windows_credential.as_deref().is_none_or(str::is_empty)
                    && std::io::stdin().is_terminal())
            {
                Some(rpassword::prompt_password(format!("{name} の{what}: "))?)
            } else {
                None
            };
            let info = vault.set(SecretInput {
                name: name.clone(),
                kind: *kind,
                username: username.clone(),
                password,
                totp: totp.clone(),
                sites: (!sites.is_empty()).then(|| sites.clone()),
                description: description.clone(),
                windows_credential: windows_credential.clone(),
            })?;
            if info.sites.is_empty() {
                eprintln!(
                    "warning: no --site given; browser steps refuse to type this secret until a site is added"
                );
            }
            println!("saved secret '{}' ({})", info.name, vault.key_location());
        }
        SecretCmd::WindowsCredentials => {
            let list = vault.windows_credentials()?;
            if list.is_empty() {
                println!("(no generic credentials in Windows Credential Manager)");
            }
            for c in list {
                println!("{}\tuser={}", c.target, c.username);
            }
        }
        SecretCmd::Remove { name } => {
            vault.remove(name)?;
            println!("removed secret '{name}'");
        }
        SecretCmd::Logout { session } => {
            if vault.remove_session(session)? {
                println!("forgot the saved login '{session}'");
            } else {
                println!("no saved login '{session}'");
            }
        }
        SecretCmd::Reset { yes } => {
            if !*yes {
                bail!(
                    "this deletes every secret and saved login of the workspace; run again with --yes to confirm"
                );
            }
            let count = vault.reset()?;
            println!("deleted {count} secret(s); register them again with `shikigami secret set`");
        }
    }
    Ok(())
}

fn flow_cmd(svc: &FlowService, cmd: &FlowCmd) -> Result<()> {
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
        FlowCmd::Import { file, on_conflict } => {
            let text = std::fs::read_to_string(file)
                .with_context(|| format!("reading {}", file.display()))?;
            let value: Value = serde_json::from_str(&text).context("parsing JSON")?;
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
            no_versions,
        } => {
            let bundle = svc.export(&FlowId::new(id.as_str()), !no_versions)?;
            let json = serde_json::to_string_pretty(&bundle)? + "\n";
            match output {
                Some(path) => {
                    std::fs::write(path, json)
                        .with_context(|| format!("writing {}", path.display()))?;
                    eprintln!(
                        "wrote {} ({} version(s))",
                        path.display(),
                        bundle.versions.len()
                    );
                }
                None => print!("{json}"),
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
            let ops: Vec<shikigami_core::EditOp> =
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

fn version_cmd(svc: &FlowService, cmd: &VersionCmd) -> shikigami_core::CoreResult<()> {
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
                "unpublished {id}: `shikigami run {id}` now refuses until a version is published"
            );
        }
    }
    Ok(())
}

fn approval_cmd(store: &ApprovalStore, cmd: &ApprovalCmd) -> shikigami_core::CoreResult<()> {
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

/// A core error with its stable code and hint, for the terminal.
fn core_err(e: shikigami_core::CoreError) -> anyhow::Error {
    let hint = e
        .details()
        .and_then(|d| d.get("hint").and_then(Value::as_str).map(str::to_owned));
    match hint {
        Some(hint) => anyhow::anyhow!("{e} ({})\nhint: {hint}", e.code()),
        None => anyhow::anyhow!("{e} ({})", e.code()),
    }
}

/// What `shikigami run` executes, with the version recorded in the report.
/// A file runs as written. A workspace flow runs its published version
/// (and the published versions of what it calls) unless `draft`; the
/// policy can keep a flow from running unattended at all.
fn runnable(
    svc: &FlowService,
    target: &str,
    draft: bool,
) -> Result<(Flow, Option<u32>, Vec<shikigami_core::Subflow>)> {
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
        Err(core_err(shikigami_core::CoreError::Rejected {
            code: "UNATTENDED_NOT_ALLOWED",
            message: format!("the workspace policy keeps {id} from running unattended"),
            hint: Some(
                "Run it from Studio, or change \"unattended\" for it in policy.json.".into(),
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

fn print_diff(diff: &FlowDiff) {
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

fn diff_mark(kind: DiffKind) -> &'static str {
    match kind {
        DiffKind::Added => "+",
        DiffKind::Removed => "-",
        DiffKind::Changed => "~",
        DiffKind::Moved => ">",
    }
}

fn print_outcome(out: &shikigami_core::EditOutcome) {
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

/// Reads a flow JSON file or the flow inside a bundle.
/// A flow file or bundle, with the sub-flows a bundle carries.
fn load_file(path: &Path) -> Result<(Flow, Vec<Flow>)> {
    let text =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let mut value: Value = serde_json::from_str(&text).context("parsing JSON")?;
    let mut bundled = Vec::new();
    if shikigami_core::version::is_bundle(&value) {
        // `scenario` / `subscenarios`: bundles from before flows were
        // renamed (up to 0.1.2).
        let mut take =
            |keys: [&str; 2]| keys.iter().find_map(|k| value.get_mut(*k).map(Value::take));
        if let Some(Value::Array(subs)) = take(["subflows", "subscenarios"]) {
            for sub in subs {
                bundled.push(shikigami_core::migrate::from_value(sub)?);
            }
        }
        value = take(["flow", "scenario"]).unwrap_or_default();
    }
    Ok((shikigami_core::migrate::from_value(value)?, bundled))
}

/// A target is a file path when it ends with `.json` or exists on disk.
fn is_file(target: &str) -> bool {
    target.ends_with(".json") || Path::new(target).is_file()
}

fn resolve(svc: &FlowService, target: &str) -> Result<(Flow, Vec<Flow>)> {
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
fn project_dirs(
    svc: &FlowService,
    target: &str,
    flow: &Flow,
    subflows: &mut [shikigami_core::Subflow],
) -> Result<Option<PathBuf>> {
    let path = Path::new(target);
    if !(target.ends_with(".json") || path.is_file()) {
        return Ok(Some(svc.project_dir(&flow.id)?));
    }
    let value: Value = serde_json::from_str(&std::fs::read_to_string(path)?)?;
    let file = std::path::absolute(path)?;
    if !shikigami_core::version::is_bundle(&value) {
        return Ok(file.parent().map(Path::to_path_buf));
    }
    let bundle: shikigami_core::FlowBundle = serde_json::from_value(value)?;
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let base = name
        .strip_suffix(".shikigami.json")
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
        shikigami_core::project::unpack(&bundle.files, id, &dir)?;
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
fn subflows(
    svc: &FlowService,
    flow: &Flow,
    bundled: Vec<Flow>,
) -> Result<Vec<shikigami_core::Subflow>> {
    Ok(svc.subflows_bundled(flow, &bundled)?)
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
    policy: &Path,
    flow: Flow,
    options: RunOptions,
    json: bool,
    vars: bool,
) -> Result<RunStatus> {
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
    // `notify` in policy.json: Task Scheduler and batch runs are unattended.
    shikigami_agent::notify::notify(policy, &report).await;
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

fn print_case(result: &testing::CaseResult) {
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
            let at = err.step_id.as_ref().map(|s| s.as_str()).unwrap_or("-");
            println!("    error at {at}: {} {}", err.code, err.message);
        }
        println!("    run {}", result.run_id);
    }
}

/// "2026-11-01" (that day, local midnight as UTC) or an RFC 3339 time.
fn parse_when(text: &str) -> Result<time::OffsetDateTime> {
    use time::format_description::well_known::Rfc3339;
    if let Ok(t) = time::OffsetDateTime::parse(text, &Rfc3339) {
        return Ok(t);
    }
    let format = time::macros::format_description!("[year]-[month]-[day]");
    let day = time::Date::parse(text, &format)
        .map_err(|_| anyhow::anyhow!("'{text}' is not a day (2026-11-01) or an RFC 3339 time"))?;
    Ok(day.midnight().assume_utc())
}

fn audit_cmd(
    svc: &FlowService,
    since: Option<&str>,
    until: Option<&str>,
    flow: Option<&str>,
    json: bool,
) -> Result<()> {
    use shikigami_runtime::audit::{self, AuditQuery};
    let query = AuditQuery {
        since: since.map(parse_when).transpose()?,
        until: until.map(parse_when).transpose()?,
        flow_id: flow.map(FlowId::new),
    };
    let entries = audit::collect(svc.store(), &query);
    if json {
        for e in &entries {
            println!("{}", serde_json::to_string(e)?);
        }
        return Ok(());
    }
    if entries.is_empty() {
        println!("nothing recorded");
    }
    for e in &entries {
        let at =
            e.at.format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_default();
        let who = e
            .who
            .as_deref()
            .map(|w| format!(" ({w})"))
            .unwrap_or_default();
        let flow = e.flow_id.as_deref().unwrap_or("-");
        let ok = if e.ok { "" } else { " FAILED" };
        let code = e
            .error_code
            .as_deref()
            .map(|c| format!(" {c}"))
            .unwrap_or_default();
        let detail = if e.detail.is_empty() {
            String::new()
        } else {
            format!("  {}", e.detail)
        };
        let secrets = if e.secrets.is_empty() {
            String::new()
        } else {
            format!("  secrets: {}", e.secrets.join(", "))
        };
        println!(
            "{at}  {}{who}  {}  {flow}{ok}{code}{detail}{secrets}",
            e.actor, e.action
        );
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod load_file_tests {
    use super::*;

    #[test]
    fn reads_scenario_bundles_from_0_1() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("old.shikigami.json");
        let bundle = serde_json::json!({
            "format": "shikigami.scenarioBundle",
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
        let cli = Cli::try_parse_from(["shikigami", "run", "scn_a"]).unwrap();
        assert!(matches!(cli.command, Command::Run { draft: false, .. }));
        let cli =
            Cli::try_parse_from(["shikigami", "run", "scn_a", "--draft", "-i", "x=1"]).unwrap();
        let Command::Run { draft, inputs, .. } = cli.command else {
            panic!("not a run");
        };
        assert!(draft);
        assert_eq!(inputs, vec!["x=1".to_owned()]);
        let cli = Cli::try_parse_from([
            "shikigami",
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
        assert!(Cli::try_parse_from(["shikigami", "scenario", "list"]).is_ok());
    }
}

fn session_cmd(cmd: &SessionCmd) -> Result<ExitCode> {
    use shikigami_desktop::screen_lock::{self, LockBy};
    match cmd {
        SessionCmd::Status { json } => {
            #[cfg(windows)]
            let (unavailable, remote) = (
                shikigami_desktop::session::desktop_unavailable(),
                shikigami_desktop::session::is_remote(),
            );
            #[cfg(not(windows))]
            let (unavailable, remote) = (Some("not Windows".to_owned()), false);
            let lock = screen_lock::current();
            if *json {
                println!(
                    "{}",
                    serde_json::json!({
                        "desktop": unavailable.is_none(),
                        "reason": unavailable,
                        "remote": remote,
                        "screenLock": lock,
                    })
                );
                return Ok(ExitCode::SUCCESS);
            }
            match &unavailable {
                None => println!("screen: takes mouse and keyboard input"),
                Some(reason) => println!("screen: cannot take input ({reason})"),
            }
            if remote {
                println!(
                    "remote desktop: yes (closing the window locks it; `shikigami session release` does not)"
                );
            }
            match lock {
                Some(lock) => println!(
                    "locks after {} min without input ({}): desktop flows stop there",
                    lock.after_secs.div_ceil(60),
                    match lock.by {
                        LockBy::ScreenSaver => "password-protected screen saver",
                        LockBy::InactivityLimit => "inactivity limit set by policy",
                    }
                ),
                None => println!("does not lock by itself"),
            }
            Ok(ExitCode::SUCCESS)
        }
        SessionCmd::Release => {
            #[cfg(windows)]
            {
                match shikigami_desktop::session::release_to_console() {
                    Ok(()) => Ok(ExitCode::SUCCESS),
                    Err(e) => {
                        eprintln!("error: {e}");
                        Ok(ExitCode::FAILURE)
                    }
                }
            }
            #[cfg(not(windows))]
            {
                eprintln!("error: only on Windows");
                Ok(ExitCode::FAILURE)
            }
        }
    }
}

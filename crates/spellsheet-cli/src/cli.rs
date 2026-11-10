//! The command line itself: every command, subcommand and option (clap).

use super::*;
use crate::secret_cmd::parse_secret_kind;

#[derive(Parser)]
#[command(name = "spellsheet", version, about = "SpellSheet RPA command line")]
pub(crate) struct Cli {
    /// Workspace directory (default: $SPELLSHEET_HOME or the platform data dir).
    #[arg(long, global = true)]
    pub(crate) workspace: Option<PathBuf>,
    #[command(subcommand)]
    pub(crate) command: Command,
}

#[derive(Subcommand)]
pub(crate) enum Command {
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
    /// 配布フォルダー: shared folders where people put published versions
    /// (`.spx`) for each other. The list of folders is this PC's own.
    #[command(subcommand)]
    Distribution(DistributionCmd),
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
    /// The AI answers with JSON that Writer takes in (AI の答えを貼り付け).
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
    /// Stock-takes of work (業務の棚卸し) an AI made with a person: the
    /// tasks, the time they take, and what to automate first.
    #[command(subcommand)]
    Inventory(InventoryCmd),
    /// The worker: runs flows unattended on this PC (schedules, file
    /// triggers, jobs from a management server) so Task Scheduler is not
    /// needed. `agent` (its name before) works too.
    #[command(subcommand, alias = "agent")]
    Worker(agent_cmd::AgentCmd),
    /// When the worker starts flows by itself: daily, monthly, every few
    /// minutes, once, or when a file appears.
    #[command(subcommand)]
    Schedule(agent_cmd::ScheduleCmd),
    /// This PC's screen for desktop flows: whether it takes input, when it
    /// locks by itself, and leaving a Remote Desktop session without
    /// locking it.
    #[command(subcommand)]
    Session(SessionCmd),
    /// A small reference management server for workers (protocol v1).
    #[command(subcommand)]
    Manager(agent_cmd::ManagerCmd),
    /// This PC's audit trail: who changed, published and ran which flow,
    /// from Writer, the CLI, an AI, a schedule or a management server.
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
        /// The client is the AI chat in SpellSheet Writer (it shows ask_user_to_choose as a card).
        #[arg(long, hide = true)]
        writer_chat: bool,
        /// Writer's folder for messages the person sends while the AI works
        /// (else `SPELLSHEET_CHAT_INBOX`, with `--writer-chat`).
        #[arg(long, hide = true)]
        inbox: Option<std::path::PathBuf>,
    },
}

#[derive(Subcommand)]
pub(crate) enum SessionCmd {
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
pub(crate) enum FlowCmd {
    List,
    Show {
        id: String,
    },
    Create {
        name: String,
    },
    /// Import a flow file someone handed over (`*.spx`), an older bundle
    /// (`*.spellsheet.json`) or a flow JSON file.
    Import {
        file: PathBuf,
        /// When the flow ID already exists: `update` it (undoable) or
        /// import a `copy` under a new ID.
        #[arg(long, value_enum)]
        on_conflict: Option<OnConflict>,
        /// Only show what the file holds and what this PC still needs
        /// (extensions, logins, allowed sites); import nothing.
        #[arg(long)]
        check: bool,
    },
    /// Write the flow as one file to hand to another person or PC (`.spx`):
    /// the published version by default, with the flows it calls and its
    /// folder's files (not `input/` unless asked). Logins go by name only.
    Export {
        id: String,
        /// Output file or folder (default: `<name> v<n>.spx` here). A name
        /// ending in `.json` writes the older JSON bundle; `-` writes that
        /// bundle to stdout.
        #[arg(long, short = 'o')]
        output: Option<PathBuf>,
        /// Export the current content instead of the published version.
        #[arg(long)]
        current: bool,
        /// Include every version, not only the exported one.
        #[arg(long, conflicts_with = "no_versions")]
        all_versions: bool,
        /// Leave versions out.
        #[arg(long)]
        no_versions: bool,
        /// Include the files under `input/` (usually real business data).
        #[arg(long)]
        with_input: bool,
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
pub(crate) enum OnConflict {
    Update,
    Copy,
}

#[derive(Subcommand)]
pub(crate) enum VersionCmd {
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
    /// Make a version the one `spellsheet run <id>` (unattended) executes.
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
pub(crate) enum PolicyCmd {
    /// Print the policy in force (the defaults when there is no policy.json).
    Show,
    /// Check policy.json; exits with 1 when it is broken.
    Check,
    /// Write policy.json with the defaults, to edit (keeps an existing file).
    Init,
}

#[derive(Subcommand, Clone)]
pub(crate) enum InventoryCmd {
    /// The stock-takes of the workspace, the latest changed first.
    List {
        #[arg(long)]
        json: bool,
    },
    /// One stock-take: its tasks in the order to build them.
    Show {
        id: String,
        #[arg(long)]
        json: bool,
    },
    /// Write one as an Excel workbook (.xlsx).
    Export {
        id: String,
        /// The file to write.
        path: PathBuf,
        /// Headings in English instead of Japanese.
        #[arg(long)]
        english: bool,
    },
}

#[derive(Subcommand)]
pub(crate) enum ApprovalCmd {
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
pub(crate) enum DistributionCmd {
    /// The folders this PC looks at.
    List,
    /// Look at a folder too, e.g. `add 経理課 \\fs01\経理\SpellSheet`.
    Add { name: String, path: String },
    /// Stop looking at a folder (its files stay).
    Remove { name: String },
    /// What each folder holds against this workspace (new, update, latest, older), as JSON.
    Check,
    /// Put the published version of a flow in a folder as `<name> v<n>.spx`.
    Put {
        /// Flow ID.
        id: String,
        /// Folder name (as added); may be left out when there is only one.
        #[arg(long)]
        folder: Option<String>,
    },
}

#[derive(Subcommand)]
pub(crate) enum WorkspaceCmd {
    /// Show where this workspace keeps shared and per-PC data.
    Info,
    /// Prepare a folder as a workspace. With --shared, several people can use
    /// it (OneDrive, a file server); undo history and run logs stay on each PC.
    Init {
        dir: PathBuf,
        #[arg(long)]
        shared: bool,
    },
    /// Make DIR the default workspace for Writer, the CLI and the MCP server.
    Use { dir: PathBuf },
}

#[derive(Subcommand)]
pub(crate) enum SecretCmd {
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
        /// to values kept by SpellSheet).
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
pub(crate) enum PluginCmd {
    /// Show the loaded plugins and the ones that could not be loaded.
    List,
    /// Check the plugin in DIR (manifest, schemas, examples) without
    /// installing it.
    Check { dir: PathBuf },
    /// Install an extension by its name in the registries (the version and
    /// zip they pin), or from a zip file or folder, an https zip URL or a
    /// GitHub repository (its latest release). Without --yes, only shows
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
    /// List the registries (the official one first by default) and the
    /// extensions they offer. `--set URL…` replaces the list (in order;
    /// earlier ones win a name), `--set` alone empties it, `--reset` goes
    /// back to the official one.
    Registry {
        #[arg(long, num_args = 0.., value_name = "URL", conflicts_with = "reset")]
        set: Option<Vec<String>>,
        #[arg(long)]
        reset: bool,
    },
}

#[derive(Subcommand)]
pub(crate) enum SchemaCmd {
    /// Write JSON Schemas to a directory (default: ./schemas).
    Export {
        #[arg(long, default_value = "schemas")]
        dir: PathBuf,
    },
}

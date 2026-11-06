//! The agent: one process per PC (and Windows user, and workspace) that
//! runs scenarios unattended, so that nobody has to set up Windows Task
//! Scheduler (docs/design/remote-runs.md, docs/schedules.md).
//!
//! - Schedules and file triggers in `schedules.json` start the published
//!   version of a scenario ([`schedule`]).
//! - Other processes talk to it over a local pipe ([`ipc`]): `shikigami
//!   agent status`, starting and stopping runs.
//! - Runs it starts are recorded like any other (`origin.trigger`
//!   `schedule`), and the mouse and keyboard are shared with Studio, the
//!   CLI and the MCP server through the PC-wide lock.

pub mod agent;
pub mod ipc;
pub mod notify;
pub mod schedule;

pub use agent::{Agent, AgentStatus, RunRequest, RunningRun, ScheduleStatus};
pub use schedule::{Schedule, ScheduleState, Schedules, When};

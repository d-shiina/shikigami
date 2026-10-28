//! Shikigami MCP server.
//!
//! Exposes Scenario Core and the Runtime to AI clients (Claude Code, Codex,
//! Cursor, ...) as MCP tools. Every tool is a thin wrapper: edits go through
//! `ScenarioService` exactly like Studio and the CLI, so a change made here is
//! journaled, undoable from Studio and shows up there immediately through the
//! workspace file watcher.
//!
//! The server runs over stdio and needs neither Studio nor any GUI.

mod audit;
mod params;
mod server;

pub use params::*;
pub use server::{ServerOptions, ShikigamiMcp, ToolClass, tool_contract};

use std::sync::Arc;

use rmcp::ServiceExt;
use shikigami_core::ScenarioService;
use shikigami_runtime::Runtime;

/// Serves MCP over stdin/stdout until the client disconnects.
pub async fn serve_stdio(
    service: Arc<ScenarioService>,
    runtime: Runtime,
    options: ServerOptions,
) -> anyhow::Result<()> {
    let server = ShikigamiMcp::new(service, runtime, options);
    let running = server.serve(rmcp::transport::stdio()).await?;
    running.waiting().await?;
    Ok(())
}

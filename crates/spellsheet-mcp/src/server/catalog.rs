//! The tools this server offers, their permission classes and the
//! contract (`schemas/`) generated from them.

use super::*;

/// Permission class of a tool. A server only exposes the classes it was
/// started with, so a client can be limited to e.g. read-only access.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ToolClass {
    /// Reads flows, step types, history and run records.
    Read,
    /// Creates, edits, undoes, versions, imports and deletes (to trash) flows.
    Write,
    /// Starts and stops runs.
    Run,
}

impl ToolClass {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Run => "run",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "read" => Some(Self::Read),
            "write" => Some(Self::Write),
            "run" => Some(Self::Run),
            _ => None,
        }
    }
}

/// Every tool and its permission class.
pub const TOOLS: &[(&str, ToolClass)] = &[
    ("list_flows", ToolClass::Read),
    ("get_flow", ToolClass::Read),
    ("validate_flow", ToolClass::Read),
    ("list_step_types", ToolClass::Read),
    ("get_step_schema", ToolClass::Read),
    ("get_history", ToolClass::Read),
    ("get_review", ToolClass::Read),
    ("get_run_status", ToolClass::Read),
    ("get_run_logs", ToolClass::Read),
    ("list_runs", ToolClass::Read),
    ("list_versions", ToolClass::Read),
    ("get_version", ToolClass::Read),
    ("diff_versions", ToolClass::Read),
    ("export_flow", ToolClass::Read),
    ("list_secrets", ToolClass::Read),
    ("get_policy", ToolClass::Read),
    ("list_project_files", ToolClass::Read),
    ("read_project_file", ToolClass::Read),
    ("create_flow", ToolClass::Write),
    ("update_flow", ToolClass::Write),
    ("add_step", ToolClass::Write),
    ("update_step", ToolClass::Write),
    ("remove_step", ToolClass::Write),
    ("move_step", ToolClass::Write),
    ("undo", ToolClass::Write),
    ("redo", ToolClass::Write),
    ("delete_flow", ToolClass::Write),
    ("create_version", ToolClass::Write),
    ("restore_version", ToolClass::Write),
    ("import_flow", ToolClass::Write),
    ("extract_subflow", ToolClass::Write),
    ("request_secret", ToolClass::Write),
    ("write_project_file", ToolClass::Write),
    ("delete_project_file", ToolClass::Write),
    ("save_test_case", ToolClass::Write),
    ("run_flow", ToolClass::Run),
    ("stop_flow", ToolClass::Run),
    ("inspect_page", ToolClass::Run),
    ("ask_user_to_pick", ToolClass::Run),
    ("ask_user_to_choose", ToolClass::Read),
    ("inspect_ui", ToolClass::Run),
    ("test_step", ToolClass::Run),
    ("run_tests", ToolClass::Run),
];

/// Tool names from before flows were renamed from scenarios (up to 0.1.2), with
/// the tool each one now is. Calls under the old name still work, but the
/// old names are not listed.
pub const LEGACY_TOOL_NAMES: &[(&str, &str)] = &[
    ("list_scenarios", "list_flows"),
    ("get_scenario", "get_flow"),
    ("validate_scenario", "validate_flow"),
    ("export_scenario", "export_flow"),
    ("create_scenario", "create_flow"),
    ("update_scenario", "update_flow"),
    ("delete_scenario", "delete_flow"),
    ("import_scenario", "import_flow"),
    ("extract_subscenario", "extract_subflow"),
    ("run_scenario", "run_flow"),
    ("stop_scenario", "stop_flow"),
];

/// The current name of a tool called by its old name.
pub fn current_tool_name(name: &str) -> Option<&'static str> {
    LEGACY_TOOL_NAMES
        .iter()
        .find(|(old, _)| *old == name)
        .map(|(_, new)| *new)
}

/// The tool contract AI clients and scripts depend on: every tool's name,
/// permission class, annotations and input/output schemas, without the
/// prose. Committed as `schemas/contract/mcp-tools.json`; see
/// docs/compatibility.md for what may change.
pub fn tool_contract() -> Value {
    let mut tools: Vec<Value> = SpellSheetMcp::tool_router()
        .list_all()
        .into_iter()
        .map(|tool| {
            let mut value = serde_json::to_value(&tool).unwrap_or(Value::Null);
            if let Some(obj) = value.as_object_mut() {
                obj.remove("description");
                obj.insert("class".into(), class_of(&tool.name).as_str().into());
            }
            spellsheet_core::schema::strip_docs(&mut value);
            value
        })
        .collect();
    tools.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    json!({ "tools": tools })
}

pub(super) fn class_of(tool: &str) -> ToolClass {
    TOOLS
        .iter()
        .find(|(name, _)| *name == tool)
        .map(|(_, c)| *c)
        .unwrap_or(ToolClass::Write)
}

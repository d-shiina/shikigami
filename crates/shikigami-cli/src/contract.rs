//! Contract snapshots: what AI clients, scripts and scenarios rely on.
//!
//! `shikigami schema export` writes these next to the JSON Schemas
//! (`schemas/contract/`). They hold shapes only (names, params, flags,
//! schemas), no prose, so a diff in them is a change to a public contract:
//! docs/compatibility.md says which changes are allowed and CI asks for a
//! CHANGELOG entry when they move.

use clap::{ArgAction, Command, CommandFactory};
use serde_json::{Value, json};

use crate::Cli;

/// Every contract file as `(path under schemas/, content)`.
pub fn files() -> Vec<(&'static str, Value)> {
    vec![
        ("contract/mcp-tools.json", shikigami_mcp::tool_contract()),
        ("contract/step-types.json", step_types()),
        ("contract/cli.json", command(&Cli::command())),
    ]
}

/// Built-in step types (plugins excluded) as scenarios use them.
fn step_types() -> Value {
    let runtime = shikigami_adapters::runtime(&shikigami_adapters::builtin());
    let types: Vec<Value> = runtime
        .registry()
        .iter()
        .map(|def| {
            let mut params = def.params_schema.clone();
            shikigami_core::schema::strip_docs(&mut params);
            json!({
                "type": def.step_type,
                "params": params,
                "blocks": def.blocks.iter().map(|b| b.name.as_str()).collect::<Vec<_>>(),
                "hasOutput": def.has_output,
                "risk": def.risk,
                "expressionParams": def.expression_params,
                "bindsVariables": def.binds_variables,
                "secretParams": def.secret_params,
                "deprecated": def.deprecated.as_ref().map(|d| &d.replacement),
            })
        })
        .collect();
    json!({ "schemaVersion": shikigami_core::SCHEMA_VERSION, "stepTypes": types })
}

/// Commands, arguments and flags of the `shikigami` command line.
fn command(cmd: &Command) -> Value {
    let args: Vec<Value> = cmd
        .get_arguments()
        .filter(|a| !matches!(a.get_id().as_str(), "help" | "version"))
        .map(|a| {
            let takes_value = !matches!(
                a.get_action(),
                ArgAction::SetTrue | ArgAction::SetFalse | ArgAction::Count
            );
            let mut arg = json!({
                "id": a.get_id().as_str(),
                "required": a.is_required_set(),
                "takesValue": takes_value,
                "repeatable": matches!(a.get_action(), ArgAction::Append | ArgAction::Count),
                "global": a.is_global_set(),
            });
            if let Some(long) = a.get_long() {
                arg["long"] = json!(long);
            }
            if let Some(short) = a.get_short() {
                arg["short"] = json!(short.to_string());
            }
            if a.is_positional() {
                arg["positional"] = json!(true);
            }
            let values: Vec<String> = a
                .get_possible_values()
                .iter()
                .map(|v| v.get_name().to_owned())
                .collect();
            if !values.is_empty() {
                arg["values"] = json!(values);
            }
            arg
        })
        .collect();
    let subcommands: Vec<Value> = cmd
        .get_subcommands()
        .filter(|c| c.get_name() != "help")
        .map(command)
        .collect();
    let mut out = json!({ "name": cmd.get_name() });
    if !args.is_empty() {
        out["args"] = json!(args);
    }
    if !subcommands.is_empty() {
        out["subcommands"] = json!(subcommands);
    }
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use std::path::PathBuf;

    #[test]
    fn committed_contracts_are_up_to_date() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../schemas");
        for (name, value) in super::files() {
            let expected = serde_json::to_string_pretty(&value).unwrap() + "\n";
            let actual = std::fs::read_to_string(dir.join(name)).unwrap_or_default();
            assert!(
                actual == expected,
                "schemas/{name} changed: run `pnpm schema:generate`, check docs/compatibility.md and add a CHANGELOG.md entry"
            );
        }
    }
}

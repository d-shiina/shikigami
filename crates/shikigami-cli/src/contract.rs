//! Contract snapshots: what AI clients, scripts and flows rely on.
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

/// Built-in step types (plugins excluded) as flows use them.
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

/// The guide for AIs without MCP, for the built-in step types only. A copy
/// is kept in docs/ai/ for people who download it from GitHub.
pub fn ai_guide() -> Vec<shikigami_core::chat::GuideFile> {
    let runtime = shikigami_adapters::runtime(&shikigami_adapters::builtin());
    shikigami_core::chat::guide(runtime.registry())
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

    #[test]
    fn the_ai_guide_in_docs_is_up_to_date() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/ai");
        for file in super::ai_guide() {
            let actual = std::fs::read_to_string(dir.join(&file.name)).unwrap_or_default();
            assert!(
                actual == file.text,
                "docs/ai/{} changed: run `pnpm schema:generate`",
                file.name
            );
        }
    }

    /// The example in the instructions is an answer Studio takes in.
    #[test]
    fn the_example_answer_reads_and_validates() {
        let files = super::ai_guide();
        let text = &files[0].text;
        let start = text.find("```json\n{\n  \"format\"").expect("example");
        let answer = shikigami_core::chat::read_answer(&text[start..]).expect("readable");
        let runtime = shikigami_adapters::runtime(&shikigami_adapters::builtin());
        let report =
            shikigami_core::Validator::new(runtime.registry().clone()).validate(&answer.flow);
        // IDs are assigned when Studio takes it in.
        let codes: Vec<&str> = report
            .issues
            .iter()
            .map(|i| i.code.as_str())
            .filter(|c| !matches!(*c, "INVALID_FLOW_ID" | "MISSING_STEP_ID"))
            .collect();
        // Only the parts are left, for the person to pick.
        assert!(codes.iter().all(|c| *c == "PART_NOT_PICKED"), "{report:?}");
        assert_eq!(codes.len(), 2);
    }

    /// Node names on screen are nouns ("文字入力", not "入力する"):
    /// docs/design/wording.md. A name ending in a verb's dictionary form
    /// fails here.
    #[test]
    fn step_type_names_are_nouns() {
        let runtime = shikigami_adapters::runtime(&shikigami_adapters::builtin());
        let verbs: Vec<String> = runtime
            .registry()
            .iter()
            .filter(|def| {
                let label = def.label.trim_end_matches(['）', ')']);
                let label = label.split(['（', '(']).next().unwrap_or(label);
                label.ends_with(['う', 'く', 'ぐ', 'す', 'つ', 'ぬ', 'ぶ', 'む', 'る'])
                    || label.ends_with("ない")
                    || label.ends_with('か')
            })
            .map(|def| format!("{} ({})", def.step_type, def.label))
            .collect();
        assert!(verbs.is_empty(), "name these as nouns: {verbs:?}");
    }
}

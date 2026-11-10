//! Building flows with an AI that has no MCP (Microsoft Copilot, a chat
//! window in the browser, ...).
//!
//! Such an AI cannot call tools, so it learns SpellSheet from two files this
//! module writes from the registry ([`guide`]): short instructions that fit
//! an agent's instruction box, and a reference with every step type and
//! function. It answers with one JSON block; a person pastes the answer into
//! Studio, which reads it with [`read_answer`]. Problems the AI must fix
//! come back as a list the person can paste into the chat again; screen
//! parts the AI could not see are left without a target for the person to
//! pick (`PART_NOT_PICKED`).

use std::collections::BTreeMap;
use std::fmt::Write as _;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::expr::FUNCTION_DOCS;
use crate::model::{Flow, SCHEMA_VERSION};
use crate::registry::{StepRegistry, StepTypeDef};

/// `format` of an answer: `{ "format": "spellsheet.answer", "flow": … }`.
pub const ANSWER_FORMAT: &str = "spellsheet.answer";

/// Name of the instructions file (for an agent's instruction box).
pub const INSTRUCTIONS_FILE: &str = "spellsheet-ai-instructions.md";
/// Name of the reference file (attached as knowledge).
pub const REFERENCE_FILE: &str = "spellsheet-ai-reference.md";

/// Microsoft Copilot Studio takes at most this many characters of agent
/// instructions; the instructions file stays under it.
pub const INSTRUCTIONS_LIMIT: usize = 8000;

/// One generated file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GuideFile {
    pub name: String,
    pub text: String,
}

/// What a pasted answer holds.
#[derive(Debug, Clone, PartialEq)]
pub struct ChatAnswer {
    pub flow: Flow,
    /// What the flow does, in the AI's words (first line: a short title).
    pub summary: Option<String>,
    /// Questions only the person can answer.
    pub checks: Vec<String>,
}

/// Why an answer could not be read, written for the AI that wrote it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AnswerProblem {
    /// JSON pointer into the flow (`/steps/2/params`), empty for the whole answer.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub path: String,
    pub message: String,
    /// The node the problem is in, by its name (or type when unnamed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<String>,
    /// What the answer has at `path`, as JSON (shortened), so the AI finds
    /// it in its own answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub found: Option<String>,
}

impl AnswerProblem {
    fn new(path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            message: message.into(),
            step: None,
            found: None,
        }
    }

    /// With the node and the value at `pointer` (relative to the flow).
    fn at(mut self, flow: &Value, pointer: &str) -> Self {
        self.found = flow.pointer(pointer).map(short_json);
        self.step = step_at(flow, pointer);
        self
    }
}

/// Longest a `found` value gets, in characters.
const FOUND_LIMIT: usize = 300;

fn short_json(value: &Value) -> String {
    let text = serde_json::to_string(value).unwrap_or_default();
    if text.chars().count() <= FOUND_LIMIT {
        return text;
    }
    let mut cut: String = text.chars().take(FOUND_LIMIT).collect();
    cut.push('…');
    cut
}

/// The name of the innermost step `pointer` is in (`/steps/2/blocks/then/0/…`).
fn step_at(flow: &Value, pointer: &str) -> Option<String> {
    let parts: Vec<&str> = pointer.split('/').skip(1).collect();
    let mut found = None;
    for j in 0..parts.len() {
        let is_step = parts[j].parse::<usize>().is_ok()
            && ((j >= 1 && parts[j - 1] == "steps") || (j >= 2 && parts[j - 2] == "blocks"));
        if !is_step {
            continue;
        }
        let at = format!("/{}", parts[..=j].join("/"));
        let Some(step) = flow.pointer(&at).and_then(Value::as_object) else {
            continue;
        };
        let label = step
            .get("name")
            .and_then(Value::as_str)
            .filter(|n| !n.trim().is_empty())
            .or_else(|| step.get("type").and_then(Value::as_str));
        if let Some(label) = label {
            found = Some(label.to_owned());
        }
    }
    found
}

// -- the guide ------------------------------------------------------------

/// The instructions and the reference for the step types in `registry`.
pub fn guide(registry: &StepRegistry) -> Vec<GuideFile> {
    vec![
        GuideFile {
            name: INSTRUCTIONS_FILE.into(),
            text: INSTRUCTIONS.into(),
        },
        GuideFile {
            name: REFERENCE_FILE.into(),
            text: reference(registry),
        },
    ]
}

const INSTRUCTIONS: &str = r#"# SpellSheet flow writer

You help a person automate office work with SpellSheet, a Windows RPA tool. You write the automation (a "flow") as JSON. The person pastes your answer into SpellSheet Writer, which checks it, shows the person what is left for them to do, and later runs the flow without you. You cannot run anything and you cannot see the person's screen. The full format, every step type and every function are in spellsheet-ai-reference.md: read it before you write steps, and copy its examples.

## How to work

1. Ask short questions until you know the job: which web site or Windows app, the order of the work, the files it reads and writes (names, sheets, columns), and what should happen on errors. Do not ask for passwords.
2. Answer with exactly one ```json code block holding the answer object below, and a few plain sentences around it saying what the person must do in Writer (pick the screen parts, register the logins, put the input files).
3. When the person pastes problems that SpellSheet found, fix exactly those and answer with the whole answer object again.
4. When the person pastes their current flow, change only what they ask, keep every step "id" and every part's "target" as they are, and answer with the whole answer object.

Reply in the person's language. Names, labels, summary and checks are in that language too.

## The answer

```json
{
  "format": "spellsheet.answer",
  "summary": "受注一覧を開いて検索する\n受注システムにログインし、注文番号で検索します。",
  "checks": ["検索するのは注文番号でよいですか？"],
  "flow": {
    "name": "受注を検索する",
    "variables": [ { "name": "orderNo", "type": "string", "direction": "input", "default": "" } ],
    "parts": {
      "searchBox": { "label": "受注一覧の上の検索欄", "app": "browser" },
      "searchButton": { "label": "検索欄の右の「検索」ボタン", "app": "browser" }
    },
    "steps": [
      { "type": "browser.open", "name": "受注一覧を開く", "params": { "url": "https://example.com/orders" } },
      { "type": "browser.fill", "name": "注文番号を入力", "params": { "target": { "part": "searchBox" }, "value": "{{ orderNo }}" } },
      { "type": "browser.click", "name": "検索", "params": { "target": { "part": "searchButton" } } }
    ]
  }
}
```

- summary: first line is a short title of what the flow does; then why and how. No step type names.
- checks: questions only the person can answer (your assumptions about their business), one each. Use [] when nothing is uncertain.
- flow: leave out id, revision, metadata and schemaVersion. Writer adds them.

## Steps

- A step is { "type": "<step type>", "name": "<short label>", "params": { … } }, plus "saveAs": "<variable>" to keep its output. Control steps (control.if, control.forEach, control.try, …) hold child steps in "blocks", e.g. { "then": [ … ], "else": [ … ] } or { "body": [ … ] }.
- Write node names and the flow's summary in the person's business words ("注文番号を入力", not "browser.fill #3"): Writer's 手順書 uses them as its headings.
- Use only step types and params listed in the reference. Set every required param.
- Params listed as "expression" take a bare expression without {{ }}: "condition": "count > 3". Every other text param is a template: "合計 {{ total }} 円"; a text that is exactly one {{ expr }} keeps the value's type.
- Work on text, numbers, dates and lists with expression functions inside variable.set, not with extra steps: "expression": "sum(map(rows, r => num(r.金額)))".
- Variables: declare inputs and outputs in "variables" (name: letters of any language, digits and _, no spaces or symbols, e.g. orderNo or 受注番号; use the language the person uses). Variables set by "saveAs" or variable.set need no declaration.

## The screen: never guess

You cannot see the screen, so never write a CSS selector, an element id or coordinates. For every button, field, link, table or window a step uses, add a part without a target and point the step at it:

```json
"parts": { "saveButton": { "label": "画面右上の「保存」ボタン", "app": "browser" } }
… { "type": "browser.click", "name": "保存", "params": { "target": { "part": "saveButton" } } }
```

- app is "browser" for web pages (browser.*) and "desktop" for Windows apps (desktop.*).
- The label says what it is and where, so the person can find it: Writer asks them to pick each part on the screen.
- Use one part for the same thing in several steps. Write { "part": "<name>" } and nothing else beside it.
- A desktop part covers the window too: do not write "window" in those steps.
- Some screens show no buttons or fields to pick (Citrix, remote desktops, drawn screens). There, use desktop.mouseClick, desktop.waitFor or desktop.isVisible with a part whose label starts with "画像：" and says what the picture shows (画像：保存ボタンのアイコン). The person cuts its picture out of the screen in Writer (画面から切り取る); Writer keeps it in templates/ and fills the target in.

## Logins, files and settings

- Never ask for or write a password. In params that take a secret, write { "secret": "<name>", "field": "username" | "password" | "totp" } and tell the person to register a secret with that name in Writer.
- A flow has a folder: input/ (files it reads), templates/ (forms), config/ (settings), output/ (results), work/ (temporary). Write paths relative to it, like "input/受注.xlsx". Tell the person which files to put in input/ and templates/.
- Values people will change (dates, recipients, folders) go in config/settings.json, read with config.read (see the reference).

## Before you answer

Check that every step type exists in the reference, every required param is set, every { "part": … } is in "parts", every expression uses only the functions in the reference, and the JSON is valid (no comments, no trailing commas).
"#;

fn reference(registry: &StepRegistry) -> String {
    let mut out = String::new();
    out.push_str(REFERENCE_HEAD);
    out.push_str("\n## Expression functions\n\n");
    out.push_str("Use them in expressions and inside {{ }}. Join text with + or a template.\n\n");
    let mut category = "";
    for doc in FUNCTION_DOCS {
        if doc.category != category {
            category = doc.category;
            let _ = writeln!(out, "\n### {category}\n");
        }
        let _ = writeln!(
            out,
            "- `{}`: {} Example: `{}`",
            doc.signature, doc.description, doc.example
        );
    }
    out.push_str("\n## Step types\n\n");
    out.push_str("Each step type: what it does, its params (* = required), whether `saveAs` gets an output, and examples to copy. Descriptions sometimes name tools such as inspect_page, inspect_ui, test_step or list_secrets: you do not have them; ask the person instead. In examples a screen `target` is written out in full; you write { \"part\": \"<name>\" } instead (see \"The screen\").\n");
    let mut groups: BTreeMap<&str, Vec<&StepTypeDef>> = BTreeMap::new();
    for def in registry.iter().filter(|d| d.deprecated.is_none()) {
        let group = def.step_type.split('.').next().unwrap_or_default();
        groups.entry(group).or_default().push(def);
    }
    for (group, mut defs) in groups {
        defs.sort_by(|a, b| a.step_type.cmp(&b.step_type));
        let _ = writeln!(out, "\n### {group}.*\n");
        for def in defs {
            step_section(&mut out, def);
        }
    }
    out
}

const REFERENCE_HEAD: &str = r#"# SpellSheet flow reference

Everything an AI needs to write a SpellSheet flow without tools. Read spellsheet-ai-instructions.md first: it says how to answer.

## The flow

```json
{
  "name": "…",
  "description": "…",
  "variables": [ { "name": "orders", "type": "array", "direction": "input", "default": [], "description": "…" } ],
  "parts": { "<name>": { "label": "…", "app": "browser" } },
  "steps": [ … ],
  "settings": { "defaultTimeoutMs": 30000, "onError": "fail" }
}
```

- variables[].type: string, number, boolean, object, array or any. direction: input (given when the run starts), output (returned), inOut, local (default). A secret: true variable is masked in logs.
- parts: screen parts the person picks in Writer (see "The screen" in the instructions). app: browser or desktop.
- settings (optional): defaultTimeoutMs per step, defaultRetry { "maxAttempts": 3, "backoffMs": 1000 }, onError "fail" or "continue", keepWork.

## A step

```json
{ "type": "excel.readRows", "name": "受注を読む", "params": { "path": "input/受注.xlsx", "sheet": "受注" }, "saveAs": "rows" }
```

- type, name (short label), params, saveAs (variable for the output), blocks (child steps of control steps), disabled, timeoutMs, retry { "maxAttempts": 3 }, onError ("fail" or "continue"; after continue, lastError holds the error).
- id: only when you edit a flow the person pasted. Keep the ids you were given; leave it out on new steps.

## Expressions and templates

- An expression is like JavaScript: numbers, 'text' or "text", true, false, null, lists [1, 2], objects { name: r.氏名 }, + - * / %, == != < <= > >=, && || !, a ? b : c, a.b, a['b'], list[0], and functions.
- The second argument of map, filter, find, some, every, sortBy and groupBy is a lambda r => expression.
- Dates are text: '2026-10-28' or '2026-10-28T09:30:00'.
- A template is text with {{ expression }} inside. Inside a template, close an object with } } (with a space).
- Variables: everything declared or set by saveAs, plus loop variables (control.forEach itemVar and indexVar), lastError after onError continue, and the outputs of earlier steps by their saveAs name.

## The screen

A step that works on the screen has a `target`. You write { "part": "<name>" } and declare the part in "parts" without a target; the person picks the element in Writer and Writer fills the target in. A picked browser target looks like { "role": "button", "name": "保存" } or { "label": "ユーザー名" }; a desktop target like { "window": { "process": "notepad.exe" }, "element": { "id": "15" } }. A picture cut out of the screen (an image part) is a desktop target too: { "window": { "process": "wfica32.exe" }, "image": { "path": "templates/image1.png", "threshold": 0.9 }, "offset": { "x": 0, "y": 0 } }; only desktop steps whose target lists `image` can use it. Keep image parts as they are.
"#;

fn step_section(out: &mut String, def: &StepTypeDef) {
    let _ = writeln!(out, "#### {} ({})\n", def.step_type, def.label);
    let _ = writeln!(out, "{}\n", def.description.trim());
    let props = def
        .params_schema
        .get("properties")
        .and_then(Value::as_object);
    let required: Vec<&str> = def
        .params_schema
        .get("required")
        .and_then(Value::as_array)
        .map(|r| r.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    match props {
        Some(props) if !props.is_empty() => {
            out.push_str("Params:\n");
            for (name, schema) in props {
                let star = if required.contains(&name.as_str()) {
                    "*"
                } else {
                    ""
                };
                let mut kinds = Vec::new();
                if def.expression_params.iter().any(|p| p == name) {
                    kinds.push("expression".to_owned());
                }
                if def.binds_variables.iter().any(|p| p == name) {
                    kinds.push("variable name".to_owned());
                }
                if def.secret_params.iter().any(|p| p == name) {
                    kinds.push("may be a secret".to_owned());
                }
                if def.path_params.iter().any(|p| p == name) {
                    kinds.push("path".to_owned());
                }
                let shape = if crate::model::takes_part(&def.step_type, name) {
                    "screen target: { \"part\": \"<name>\" }".to_owned()
                } else {
                    shape(schema, 0)
                };
                let kinds = if kinds.is_empty() {
                    String::new()
                } else {
                    format!(" [{}]", kinds.join(", "))
                };
                let doc = schema
                    .get("description")
                    .and_then(Value::as_str)
                    .map(|d| format!(" — {}", one_line(d)))
                    .unwrap_or_default();
                let _ = writeln!(out, "- `{name}`{star}: {shape}{kinds}{doc}");
            }
        }
        _ => out.push_str("Params: none.\n"),
    }
    if !def.blocks.is_empty() {
        let names: Vec<String> = def
            .blocks
            .iter()
            .map(|b| format!("`{}` ({})", b.name, b.label))
            .collect();
        let _ = writeln!(out, "Blocks: {}", names.join(", "));
    }
    if def.has_output {
        out.push_str("Output: yes (saveAs)\n");
    }
    for example in &def.examples {
        let _ = writeln!(
            out,
            "Example: `{}`",
            serde_json::to_string(example).unwrap_or_default()
        );
    }
    out.push('\n');
}

/// A JSON Schema as a short type: `text`, `"a" | "b"`, `list of number`,
/// `{ path*, sheet }`.
fn shape(schema: &Value, depth: usize) -> String {
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        return values
            .iter()
            .map(|v| serde_json::to_string(v).unwrap_or_default())
            .collect::<Vec<_>>()
            .join(" | ");
    }
    if let Some(value) = schema.get("const") {
        return serde_json::to_string(value).unwrap_or_default();
    }
    for key in ["oneOf", "anyOf"] {
        if let Some(options) = schema.get(key).and_then(Value::as_array)
            && schema.get("type").is_none()
        {
            let mut parts: Vec<String> = options.iter().map(|o| shape(o, depth)).collect();
            parts.dedup();
            return parts.join(" or ");
        }
    }
    let kind = match schema.get("type") {
        Some(Value::String(t)) => t.as_str(),
        Some(Value::Array(types)) => {
            let names: Vec<String> = types
                .iter()
                .filter_map(Value::as_str)
                .map(|t| shape(&serde_json::json!({ "type": t }), depth))
                .collect();
            return names.join(" or ");
        }
        _ => "",
    };
    match kind {
        "string" => "text".into(),
        "integer" => "whole number".into(),
        "number" => "number".into(),
        "boolean" => "true | false".into(),
        "null" => "null".into(),
        "array" => match schema.get("items") {
            Some(items) => format!("list of {}", shape(items, depth + 1)),
            None => "list".into(),
        },
        "object" => {
            let Some(props) = schema.get("properties").and_then(Value::as_object) else {
                return "object".into();
            };
            if props.is_empty() || depth >= 2 {
                return "object".into();
            }
            let required: Vec<&str> = schema
                .get("required")
                .and_then(Value::as_array)
                .map(|r| r.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            let fields: Vec<String> = props
                .iter()
                .map(|(name, sub)| {
                    let star = if required.contains(&name.as_str()) {
                        "*"
                    } else {
                        ""
                    };
                    format!("{name}{star}: {}", shape(sub, depth + 1))
                })
                .collect();
            format!("{{ {} }}", fields.join(", "))
        }
        _ => "any".into(),
    }
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

// -- reading an answer ------------------------------------------------------

/// Reads what a person pasted: the AI's whole reply (prose around a
/// ```json block is fine), the answer object, or a bare flow. Fills in what
/// the AI is told to leave out (id, schemaVersion) and checks the shape.
/// The flow's content (step types, params) is checked afterwards by the
/// ordinary validation.
pub fn read_answer(text: &str) -> Result<ChatAnswer, Vec<AnswerProblem>> {
    let value = find_json(text)?;
    let Value::Object(mut root) = value else {
        return Err(vec![AnswerProblem::new(
            "",
            "The answer must be one JSON object: { \"format\": \"spellsheet.answer\", \"summary\": …, \"checks\": […], \"flow\": { … } }.",
        )]);
    };
    let (flow, summary, checks) = if root.contains_key("flow") {
        let summary = match root.remove("summary") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s),
            Some(_) => {
                return Err(vec![AnswerProblem::new(
                    "/summary",
                    "summary must be text.",
                )]);
            }
        };
        let checks = match root.remove("checks") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(items)) => items
                .into_iter()
                .map(|item| match item {
                    Value::String(s) => Ok(s),
                    _ => Err(AnswerProblem::new(
                        "/checks",
                        "checks must be a list of texts.",
                    )),
                })
                .collect::<Result<Vec<_>, _>>()
                .map_err(|p| vec![p])?,
            Some(_) => {
                return Err(vec![AnswerProblem::new(
                    "/checks",
                    "checks must be a list of texts.",
                )]);
            }
        };
        let flow = root.remove("flow").unwrap_or(Value::Null);
        (flow, summary, checks)
    } else {
        (Value::Object(root), None, Vec::new())
    };
    let Value::Object(mut flow) = flow else {
        return Err(vec![AnswerProblem::new(
            "/flow",
            "flow must be an object with name, variables, parts and steps.",
        )]);
    };
    prepare(&mut flow);
    let mut value = Value::Object(flow);
    crate::migrate::upgrade(&mut value).map_err(|e| vec![AnswerProblem::new("", e.to_string())])?;
    let problems = shape_problems(&value);
    if !problems.is_empty() {
        return Err(problems);
    }
    let flow: Flow = serde_json::from_value(value)
        .map_err(|e| vec![AnswerProblem::new("/flow", e.to_string())])?;
    Ok(ChatAnswer {
        flow,
        summary: summary.filter(|s| !s.trim().is_empty()),
        checks: checks
            .into_iter()
            .filter(|c| !c.trim().is_empty())
            .collect(),
    })
}

/// Fills in what Studio owns: an empty id (a new one is made on import),
/// the format version, no revision or format tag.
fn prepare(flow: &mut Map<String, Value>) {
    flow.remove("format");
    flow.remove("revision");
    if !flow.get("id").is_some_and(Value::is_string) {
        flow.insert("id".into(), Value::String(String::new()));
    }
    if !flow.contains_key("schemaVersion") {
        flow.insert("schemaVersion".into(), Value::from(SCHEMA_VERSION));
    }
    if !flow.contains_key("name") {
        flow.insert("name".into(), Value::String(String::new()));
    }
}

/// Mistakes in the flow's shape (unknown fields, wrong types), with paths
/// relative to the flow.
fn shape_problems(flow: &Value) -> Vec<AnswerProblem> {
    let schema = crate::schema::all()
        .into_iter()
        .find(|(name, _)| *name == "flow.schema.json")
        .map(|(_, schema)| schema);
    let Some(Ok(validator)) = schema.map(|s| jsonschema::validator_for(&s)) else {
        return Vec::new();
    };
    let mut problems: Vec<AnswerProblem> = validator
        .iter_errors(flow)
        .map(|e| {
            let pointer = e.instance_path().to_string();
            AnswerProblem::new(format!("/flow{pointer}"), e.to_string()).at(flow, &pointer)
        })
        .collect();
    problems.dedup();
    problems.truncate(30);
    problems
}

/// The JSON in a pasted reply: the ```json block that holds a flow, or the
/// whole text, or the outermost { … }.
fn find_json(text: &str) -> Result<Value, Vec<AnswerProblem>> {
    let blocks = fenced_blocks(text);
    let mut first_error = None;
    for block in &blocks {
        match serde_json::from_str::<Value>(block) {
            Ok(value) if looks_like_answer(&value) => return Ok(value),
            Ok(_) => {}
            Err(e) => {
                first_error.get_or_insert_with(|| syntax_problem(block, &e));
            }
        }
    }
    if let Some(problem) = first_error {
        return Err(vec![problem]);
    }
    let trimmed = text.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return Ok(value);
    }
    if let (Some(start), Some(end)) = (trimmed.find('{'), trimmed.rfind('}'))
        && start < end
    {
        let inner = &trimmed[start..=end];
        return serde_json::from_str::<Value>(inner).map_err(|e| vec![syntax_problem(inner, &e)]);
    }
    Err(vec![AnswerProblem::new(
        "",
        "No JSON found. Answer with one ```json code block holding { \"format\": \"spellsheet.answer\", \"summary\": …, \"checks\": […], \"flow\": { … } }.",
    )])
}

fn looks_like_answer(value: &Value) -> bool {
    value
        .as_object()
        .is_some_and(|o| o.contains_key("flow") || o.contains_key("steps"))
}

/// The contents of every ``` fenced block, in order.
fn fenced_blocks(text: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut current: Option<String> = None;
    for line in text.lines() {
        let fence = line.trim_start().starts_with("```");
        match (&mut current, fence) {
            (None, true) => current = Some(String::new()),
            (Some(block), true) => {
                blocks.push(std::mem::take(block));
                current = None;
            }
            (Some(block), false) => {
                block.push_str(line);
                block.push('\n');
            }
            (None, false) => {}
        }
    }
    blocks
}

fn syntax_problem(text: &str, e: &serde_json::Error) -> AnswerProblem {
    let line = text
        .lines()
        .nth(e.line().saturating_sub(1))
        .unwrap_or("")
        .trim();
    let line: String = line.chars().take(120).collect();
    AnswerProblem::new(
        "",
        format!(
            "The JSON is not valid at line {}, column {}: {e}. The line: {line}. Write plain JSON: no comments, no trailing commas, no … placeholders.",
            e.line(),
            e.column()
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::StepRegistry;

    #[test]
    fn instructions_fit_an_agent_instruction_box() {
        assert!(
            INSTRUCTIONS.chars().count() < INSTRUCTIONS_LIMIT,
            "{} characters",
            INSTRUCTIONS.chars().count()
        );
    }

    #[test]
    fn the_reference_lists_step_types_and_functions() {
        let files = guide(&StepRegistry::with_builtins());
        let reference = &files[1].text;
        assert!(reference.contains("#### variable.set"));
        assert!(reference.contains("#### control.if"));
        assert!(reference.contains("`trim(s)`"));
        assert!(reference.contains("Blocks: `then`"));
    }

    #[test]
    fn reads_a_whole_reply_with_prose_around_the_json() {
        let reply = "フローを作りました。\n\n```json\n{ \"format\": \"spellsheet.answer\", \"summary\": \"挨拶する\", \"checks\": [\"これでよいですか？\"], \"flow\": { \"name\": \"挨拶\", \"steps\": [ { \"type\": \"log.message\", \"params\": { \"message\": \"こんにちは\" } } ] } }\n```\n\nStudio に貼り付けてください。";
        let answer = read_answer(reply).unwrap();
        assert_eq!(answer.flow.name, "挨拶");
        assert_eq!(answer.flow.steps.len(), 1);
        assert_eq!(answer.summary.as_deref(), Some("挨拶する"));
        assert_eq!(answer.checks, vec!["これでよいですか？"]);
        assert_eq!(answer.flow.schema_version, SCHEMA_VERSION);
        assert!(answer.flow.id.is_empty());
    }

    #[test]
    fn reads_a_bare_flow() {
        let answer = read_answer("{ \"name\": \"x\", \"steps\": [] }").unwrap();
        assert_eq!(answer.flow.name, "x");
        assert!(answer.summary.is_none());
    }

    #[test]
    fn parts_may_be_left_for_a_person_to_pick() {
        let answer = read_answer(
            r#"{ "flow": { "name": "x", "parts": { "save": { "label": "保存ボタン", "app": "browser" } },
                "steps": [ { "type": "log.message", "params": { "message": "a" } } ] } }"#,
        )
        .unwrap();
        assert!(answer.flow.parts["save"].target.is_null());
    }

    #[test]
    fn problems_say_where_and_what() {
        let bad = read_answer("```json\n{ \"flow\": { \"name\": \"x\", \"steps\": [ { \"type\": \"log.message\", } ] } }\n```")
            .unwrap_err();
        assert!(bad[0].message.contains("line 1"), "{bad:?}");
        let unknown = read_answer(r#"{ "flow": { "name": "x", "steps": [ { "type": "log.message", "parameters": {} } ] } }"#)
            .unwrap_err();
        assert!(
            unknown
                .iter()
                .any(|p| p.path == "/flow/steps/0" && p.message.contains("parameters")),
            "{unknown:?}"
        );
        // The node and what was written there go along.
        let nested = read_answer(
            r#"{ "flow": { "name": "x", "steps": [ { "type": "control.if", "name": "金額の確認",
                "params": { "condition": "true" },
                "blocks": { "then": [ { "type": "log.message", "name": "記録", "param": { "message": "a" } } ] } } ] } }"#,
        )
        .unwrap_err();
        let inner = nested
            .iter()
            .find(|p| p.path == "/flow/steps/0/blocks/then/0")
            .unwrap_or_else(|| panic!("{nested:?}"));
        assert_eq!(inner.step.as_deref(), Some("記録"));
        assert!(
            inner.found.as_deref().unwrap_or("").contains("\"param\""),
            "{inner:?}"
        );
        let none = read_answer("どうぞよろしく").unwrap_err();
        assert!(none[0].message.contains("No JSON"));
    }
}

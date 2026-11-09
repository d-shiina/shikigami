//! Tool input types. Their JSON Schemas (via schemars) are what MCP clients
//! see as each tool's `inputSchema`, so doc comments here are written for AI.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use shikigami_core::{EditOp, Flow, ImportConflict, Position, Step, StepPatch, VariableDef};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FlowRef {
    /// Flow ID, e.g. `scn_...`.
    #[serde(alias = "scenarioId")]
    pub flow_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ValidateParams {
    /// Validate a stored flow by ID.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "scenarioId")]
    pub flow_id: Option<String>,
    /// Or validate an unsaved flow document.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "scenario")]
    pub flow: Option<Flow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateFlowParams {
    /// Display name (Japanese is fine).
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Input/output/internal variables.
    #[serde(default)]
    pub variables: Vec<VariableDef>,
    /// Initial steps. Step IDs may be omitted; Core assigns them.
    #[serde(default)]
    pub steps: Vec<Step>,
    #[serde(default)]
    pub tags: Vec<String>,
    /// For the human who reviews your change in Studio, in plain words (no
    /// step types or expressions). First line: what the flow now does
    /// differently, as a short title (e.g. "未払いの高額請求だけを要確認にする").
    /// Then why, and what you checked (e.g. "受注一覧の画面で『状態』の列を確かめた").
    /// Japanese is fine. Kept in the change history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// Questions the reviewer must answer because only a person knows: your
    /// assumptions and guesses about the business (e.g. "「一部入金」も要確認に
    /// 含めました。それでよいですか？"). One question each, at most 10. Leave it
    /// out when nothing is uncertain. Studio shows each with 良い／違う.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub checks: Vec<String>,
    /// observationId values from inspect_page / inspect_ui / test_step that
    /// this change is based on. The screens are kept as evidence next to the
    /// steps you touched so the reviewer can see what you saw.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub observations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFlowParams {
    #[serde(alias = "scenarioId")]
    pub flow_id: String,
    /// When given, the edit fails with REVISION_CONFLICT unless the stored
    /// revision matches (someone else, e.g. a human in Studio, changed it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
    /// Edit operations applied atomically as one revision (one undo step).
    pub ops: Vec<EditOp>,
    /// For the human who reviews your change in Studio, in plain words (no
    /// step types or expressions). First line: what the flow now does
    /// differently, as a short title (e.g. "未払いの高額請求だけを要確認にする").
    /// Then why, and what you checked (e.g. "受注一覧の画面で『状態』の列を確かめた").
    /// Japanese is fine. Kept in the change history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// Questions the reviewer must answer because only a person knows: your
    /// assumptions and guesses about the business (e.g. "「一部入金」も要確認に
    /// 含めました。それでよいですか？"). One question each, at most 10. Leave it
    /// out when nothing is uncertain. Studio shows each with 良い／違う.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub checks: Vec<String>,
    /// observationId values from inspect_page / inspect_ui / test_step that
    /// this change is based on. The screens are kept as evidence next to the
    /// steps you touched so the reviewer can see what you saw.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub observations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AddStepParams {
    #[serde(alias = "scenarioId")]
    pub flow_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
    /// The step to insert (children included). Omit `id` to let Core assign one.
    pub step: Step,
    /// Where to insert. Omit to append at the top level.
    #[serde(default)]
    pub position: Position,
    /// For the human who reviews your change in Studio, in plain words (no
    /// step types or expressions). First line: what the flow now does
    /// differently, as a short title (e.g. "未払いの高額請求だけを要確認にする").
    /// Then why, and what you checked (e.g. "受注一覧の画面で『状態』の列を確かめた").
    /// Japanese is fine. Kept in the change history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// Questions the reviewer must answer because only a person knows: your
    /// assumptions and guesses about the business (e.g. "「一部入金」も要確認に
    /// 含めました。それでよいですか？"). One question each, at most 10. Leave it
    /// out when nothing is uncertain. Studio shows each with 良い／違う.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub checks: Vec<String>,
    /// observationId values from inspect_page / inspect_ui / test_step that
    /// this change is based on. The screens are kept as evidence next to the
    /// steps you touched so the reviewer can see what you saw.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub observations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStepParams {
    #[serde(alias = "scenarioId")]
    pub flow_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
    pub step_id: String,
    /// Partial update. `params` is a JSON Merge Patch (null removes a key).
    pub patch: StepPatch,
    /// For the human who reviews your change in Studio, in plain words (no
    /// step types or expressions). First line: what the flow now does
    /// differently, as a short title (e.g. "未払いの高額請求だけを要確認にする").
    /// Then why, and what you checked (e.g. "受注一覧の画面で『状態』の列を確かめた").
    /// Japanese is fine. Kept in the change history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// Questions the reviewer must answer because only a person knows: your
    /// assumptions and guesses about the business (e.g. "「一部入金」も要確認に
    /// 含めました。それでよいですか？"). One question each, at most 10. Leave it
    /// out when nothing is uncertain. Studio shows each with 良い／違う.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub checks: Vec<String>,
    /// observationId values from inspect_page / inspect_ui / test_step that
    /// this change is based on. The screens are kept as evidence next to the
    /// steps you touched so the reviewer can see what you saw.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub observations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RemoveStepParams {
    #[serde(alias = "scenarioId")]
    pub flow_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
    /// Step to remove (its children are removed too).
    pub step_id: String,
    /// For the human who reviews your change in Studio, in plain words (no
    /// step types or expressions). First line: what the flow now does
    /// differently, as a short title (e.g. "未払いの高額請求だけを要確認にする").
    /// Then why, and what you checked (e.g. "受注一覧の画面で『状態』の列を確かめた").
    /// Japanese is fine. Kept in the change history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// Questions the reviewer must answer because only a person knows: your
    /// assumptions and guesses about the business (e.g. "「一部入金」も要確認に
    /// 含めました。それでよいですか？"). One question each, at most 10. Leave it
    /// out when nothing is uncertain. Studio shows each with 良い／違う.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub checks: Vec<String>,
    /// observationId values from inspect_page / inspect_ui / test_step that
    /// this change is based on. The screens are kept as evidence next to the
    /// steps you touched so the reviewer can see what you saw.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub observations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MoveStepParams {
    #[serde(alias = "scenarioId")]
    pub flow_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
    pub step_id: String,
    /// New location. `index` is counted after removing the step.
    pub position: Position,
    /// For the human who reviews your change in Studio, in plain words (no
    /// step types or expressions). First line: what the flow now does
    /// differently, as a short title (e.g. "未払いの高額請求だけを要確認にする").
    /// Then why, and what you checked (e.g. "受注一覧の画面で『状態』の列を確かめた").
    /// Japanese is fine. Kept in the change history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// Questions the reviewer must answer because only a person knows: your
    /// assumptions and guesses about the business (e.g. "「一部入金」も要確認に
    /// 含めました。それでよいですか？"). One question each, at most 10. Leave it
    /// out when nothing is uncertain. Studio shows each with 良い／違う.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub checks: Vec<String>,
    /// observationId values from inspect_page / inspect_ui / test_step that
    /// this change is based on. The screens are kept as evidence next to the
    /// steps you touched so the reviewer can see what you saw.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub observations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExtractSubflowParams {
    #[serde(alias = "scenarioId")]
    pub flow_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
    /// IDs of the steps to move, next to each other in one block (same
    /// parent and block), e.g. the three steps that log in. Their children
    /// move with them.
    pub step_ids: Vec<String>,
    /// Name of the new flow and of the call step, e.g. "ログインする".
    pub name: String,
    /// For the human who reviews your change in Studio, in plain words (no
    /// step types or expressions). First line: what the flow now does
    /// differently, as a short title (e.g. "未払いの高額請求だけを要確認にする").
    /// Then why, and what you checked (e.g. "受注一覧の画面で『状態』の列を確かめた").
    /// Japanese is fine. Kept in the change history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// Questions the reviewer must answer because only a person knows: your
    /// assumptions and guesses about the business (e.g. "「一部入金」も要確認に
    /// 含めました。それでよいですか？"). One question each, at most 10. Leave it
    /// out when nothing is uncertain. Studio shows each with 良い／違う.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub checks: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RevisionedRef {
    #[serde(alias = "scenarioId")]
    pub flow_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeleteFlowParams {
    #[serde(alias = "scenarioId")]
    pub flow_id: String,
    /// Required: the revision you last read. Deleting moves the flow to
    /// the workspace trash.
    pub expected_revision: u64,
    #[serde(flatten)]
    pub approval: ApprovalArgs,
}

/// Answering an approval request (when the workspace policy says a person
/// must approve the action first).
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalArgs {
    /// The approvalId an earlier APPROVAL_REQUIRED error returned. Repeat the
    /// exact same call with it after the user approved in Studio.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<String>,
    /// Wait up to this many milliseconds (max 300000) for the user's answer
    /// instead of failing at once with APPROVAL_REQUIRED.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_wait_ms: Option<u64>,
    /// Why you need this, in a sentence (Japanese is fine). Shown to the user
    /// with the request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryParams {
    #[serde(alias = "scenarioId")]
    pub flow_id: String,
    /// Most recent entries to return (default 20).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GetReviewParams {
    #[serde(alias = "scenarioId")]
    pub flow_id: String,
    /// List changes and evidence after this revision. Default: the last
    /// revision a human approved (so you see everything still unreviewed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since_revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StepTypeRef {
    /// Step type, e.g. `control.if`.
    #[serde(rename = "type")]
    pub step_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunFlowParams {
    #[serde(alias = "scenarioId")]
    pub flow_id: String,
    /// Values for input variables, by name.
    #[serde(default)]
    pub inputs: Map<String, Value>,
    /// Wait up to this many milliseconds (max 300000) for the run to finish
    /// and return its report. Omit or 0 to return immediately with the run ID.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_ms: Option<u64>,
    /// Run the published version (what unattended runs execute) instead of
    /// the working content. Only when the user asks for it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub published: Option<bool>,
    #[serde(flatten)]
    pub approval: ApprovalArgs,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SaveTestCaseParams {
    pub flow_id: String,
    /// The case's name: its file is `tests/<name>.json` in the flow's folder
    /// (e.g. `3支店の合計`). No `/ \ : * ? " < > |`.
    pub name: String,
    /// Inputs to run with and what should come out. `expect.outputs` names
    /// only the outputs to check (objects: only the keys given; lists: same
    /// length, item by item; numbers by value).
    pub case: shikigami_core::testcase::TestCase,
    /// Replace a case of that name. Without it an existing case gives
    /// TEST_CASE_EXISTS.
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunTestsParams {
    pub flow_id: String,
    /// Only these cases (names). Omit for all of `tests/`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cases: Option<Vec<String>>,
    #[serde(flatten)]
    pub approval: ApprovalArgs,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RequestSecretParams {
    /// Name to register the login under, e.g. `Google` or `受注システム`. Use an
    /// existing name (list_secrets) to ask for a missing field or site.
    pub name: String,
    /// What to register: `login` (default; a user name and password typed into
    /// a site or app), `apiKey` (a fixed key or token of a web API, used as
    /// http.request `auth` with field `password`) or `oauth` (an app registered
    /// at an OAuth provider: client ID and client secret, for oauth.signIn).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<shikigami_core::secret::SecretKind>,
    /// Addresses it will be typed into, e.g. the login page's URL
    /// (`https://accounts.google.com/...`; kept as its origin). Desktop apps:
    /// `app:<exe name>`.
    #[serde(default)]
    pub sites: Vec<String>,
    /// Fields needed. Default: username and password (for `apiKey`: password,
    /// which holds the key). Add `totp` when the site asks for an
    /// authenticator-app code.
    #[serde(default)]
    pub fields: Vec<shikigami_core::secret::SecretField>,
    /// Why you need it, in one sentence for the user (Japanese is fine).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Wait up to this many milliseconds (max 300000) for the user to register
    /// it. Omit or 0 to return at once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunRef {
    /// Run ID, e.g. `run_...`.
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunLogsParams {
    pub run_id: String,
    /// Only events with `seq` greater than this (for polling).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_seq: Option<u64>,
    /// Maximum events to return (default 200).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
    /// Only the `variableChanged` events of this variable: what it was set
    /// to, by which step, in order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variable: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ListRunsParams {
    /// Only runs of this flow.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "scenarioId")]
    pub flow_id: Option<String>,
    /// Most recent runs to return (default 20).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InspectPageParams {
    /// Page to open first. Omit to inspect the page already open in `context`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Browser context to use (default "default"). Contexts here belong to the MCP session, not to runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    /// Limit the snapshot to one element, e.g. { "role": "table", "name": "受注" }. The tree does
    /// not show the inside of frames: look into one (listed under `frames`) with
    /// { "css": "body", "frame": { "name": "main" } }.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<Value>,
    /// Keep a screenshot with the observation for the human reviewer
    /// (default true; password fields are blacked out). It is not returned to you.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<bool>,
    /// Also return the screenshot to you as an image. Only when the tree is not enough to tell
    /// elements apart (icons without names, a layout the words do not show); it costs tokens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AskUserToPickParams {
    /// What to point at, in one sentence for the user, shown on the page (Japanese is fine),
    /// e.g. 「出荷するときに押すボタンをクリックしてください」.
    pub message: String,
    /// Elements you are torn between, as step targets. They are outlined with numbers 1, 2, …
    /// so the user can click one of them (or something else).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub candidates: Vec<Value>,
    /// Browser context whose page to point at (default "default").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    /// How long to wait for the click in milliseconds (default 120000, max 300000).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AskUserToChooseParams {
    /// The question, in one short sentence in the person's language, e.g.
    /// 「在庫切れの注文はどうしますか？」.
    pub question: String,
    /// 2 to 4 answers to pick from, each different in what happens.
    pub options: Vec<ChoiceOption>,
    /// Index (from 0) of the option you recommend, if one is better.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommended: Option<usize>,
    /// Why you recommend it, in one sentence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceOption {
    /// A short name for the answer (a few words), e.g. 「飛ばして一覧に残す」.
    pub label: String,
    /// One sentence on what happens if the person picks it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InspectUiParams {
    /// The window to look into, e.g. { "process": "notepad.exe" } or { "title": "請求" }
    /// (title matches partially). Omit to list the open windows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<Value>,
    /// Limit the tree to one element and what is inside it, e.g. { "role": "table", "name": "明細" }.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub element: Option<Value>,
    /// Most elements to list (default 1500).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_nodes: Option<u64>,
    /// Also read the window's text with OCR: each line with its place in pixels from the window's
    /// top-left (for apps whose elements are not listed, e.g. Citrix or remote desktops).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ocr: Option<bool>,
    /// OCR language, e.g. "ja" or "en-US" (default: the user's languages).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// Return the picture of the window to you as an image (default false), to see icons and
    /// layout when there are no elements, or to choose a region to cut out with
    /// desktop.screenshot for target.image.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<bool>,
    /// Keep a picture of the window with the observation for the human reviewer (default true).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TestStepParams {
    /// One step as it would appear in a flow, e.g.
    /// { "type": "browser.click", "params": { "target": { "role": "button", "name": "ログイン" } } }.
    /// `id` may be omitted.
    pub step: Step,
    /// Values for the variables the step reads, by name, as they would be at
    /// that point of a run, e.g. { "row": { "顧客名": "山田商事", "_row": 2 } }
    /// for a step inside control.forEach with itemVar "row". Lets a step that
    /// uses {{ }} or an expression be tried as it is written in the flow,
    /// instead of a copy with the values typed in. Not for secrets: logins go
    /// in params as { "secret": … }.
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub variables: Map<String, Value>,
    #[serde(flatten)]
    pub approval: ApprovalArgs,
    /// The flow the step is for: relative paths (input/orders.xlsx) are
    /// resolved from its folder, as in a run, and the screen the step
    /// meets is kept as that node's picture in the flow's 手順書 until the
    /// flow is run. Give it whenever the step is for a flow.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "scenarioId")]
    pub flow_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileRef {
    #[serde(alias = "scenarioId")]
    pub flow_id: String,
    /// Relative to the flow's folder, e.g. "config/settings.json".
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WriteProjectFileParams {
    #[serde(alias = "scenarioId")]
    pub flow_id: String,
    /// Where in the flow's folder, e.g. "config/settings.json",
    /// "input/受注一覧.xlsx", "templates/請求書.docx".
    pub path: String,
    /// The file's text (UTF-8). Give `text` or `copyFrom`, not both.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Absolute path of a file on this PC to copy in (an Excel workbook the
    /// user named, a template).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copy_from: Option<String>,
    /// Replace an existing file. Without it an existing file gives
    /// PROJECT_FILE_EXISTS.
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateVersionParams {
    #[serde(alias = "scenarioId")]
    pub flow_id: String,
    /// Short name, e.g. "v1" or "本番リリース".
    pub name: String,
    /// What changed or why this version matters.
    #[serde(default)]
    pub note: String,
    /// When given, fails with REVISION_CONFLICT unless the stored revision
    /// matches, so the version is exactly what you last read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VersionRef {
    #[serde(alias = "scenarioId")]
    pub flow_id: String,
    /// Version number from list_versions.
    pub number: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RestoreVersionParams {
    #[serde(alias = "scenarioId")]
    pub flow_id: String,
    /// Version number from list_versions.
    pub number: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DiffVersionsParams {
    #[serde(alias = "scenarioId")]
    pub flow_id: String,
    /// Older side: a version number. Omit for the latest version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<u32>,
    /// Newer side: a version number. Omit for the current content.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExportFlowParams {
    #[serde(alias = "scenarioId")]
    pub flow_id: String,
    /// Include named versions (default true).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_versions: Option<bool>,
    /// Write a `.spx` file (the one the user hands to another person or PC)
    /// instead of returning the bundle: a folder (the file is named after
    /// the flow and version) or a path ending in `.spx`. Existing files are
    /// not overwritten. Holds the published version unless `current`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// With `path`: the current content instead of the published version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<bool>,
    /// With `path`: include files under input/ (usually real business data;
    /// only when the user asks).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_input: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportFlowParams {
    /// The `bundle` returned by export_flow, or a bare flow document.
    /// Give this or `path`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle: Option<Value>,
    /// A file the user was handed: `.spx`, an older `.shikigami.json`
    /// bundle, or a flow JSON file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// With `path`: import nothing; return what the file holds, how it
    /// differs from the flow here, and what this PC still needs
    /// (extensions, logins, allowed sites).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check: Option<bool>,
    /// Only needed when the flow ID already exists (IMPORT_CONFLICT):
    /// "update" applies the content to the existing flow as one undoable
    /// edit and adds missing versions; "copy" imports it under a new ID.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_conflict: Option<ImportConflict>,
}

// Studio state. All mutations go through the backend API as EditOps; the
// store only mirrors what Core returns (flow, validation, undo state).
// The actions live in the *Actions files of this folder, by area.
import type { WaitingHuman } from "../lib/attention";
import type {
  ApprovalRequest,
  DebugCommand,
  EditOp,
  Policy,
  PublishedState,
  HistoryEntry,
  ImportConflict,
  PackageOptions,
  PackagePlan,
  DistributionFolder,
  DistributionView,
  PackagePreview,
  ReviewTimeline,
  RunEventEnvelope,
  Flow,
  FlowPatch,
  FlowSummary,
  StepNote,
  StepPatch,
  StepTypeDef,
  ValidationReport,
  VariableDef,
  VersionSummary,
  WorkspaceInfo,
} from "@spellsheet/schema";
import { createStore, type StoreApi } from "zustand/vanilla";
import type {
  Api,
  ExportedPackage,
  FlowFile,
  RunEvidence,
  SecretInfo,
  SecretInput,
  PasteOutcome,
  PickRequest,
  SecretRequest,
} from "../lib/api";
import { registerExtensions } from "../lib/extensions";
import type { Copied } from "../lib/stepClipboard";
import { setFlowNames } from "../lib/sentence";
import { message, storeContext } from "./context";
import { loadBreakpoints, loadFolded, OUTLINE_KEY, INSPECTOR_KEY, loadFlag, loadReviewed } from "./persist";
import { type RunOptions, type StepPlace, type StepTest, type RunState } from "./run";
import type { SecretPrefill, SecretFix } from "./secrets";
import { editActions } from "./editActions";
import { flowsActions } from "./flowsActions";
import { reviewActions } from "./reviewActions";
import { runActions } from "./runActions";
import { secretsActions } from "./secretsActions";
import { sharingActions } from "./sharingActions";
import { uiActions } from "./uiActions";

export {
  isExternal,
  isRevertible,
  revertBlocker,
  pendingReview,
  approvedUpTo,
  pendingIn,
  groupRevertBlocker,
  touchedSteps,
} from "./history";
export {
  type RunOptions,
  type StepRunState,
  type Pause,
  type LogEntry,
  type StepPlace,
  errorPlace,
  type VariableChange,
  STEP_TEST_RUN,
  type StepTest,
  type RunState,
  type LoopRun,
  loopKey,
  type StepClock,
  clockKey,
  callKey,
  type DiveLevel,
  diveChain,
  runBreakpoints,
  calledIds,
  type StepStart,
  isActive,
  trailOf,
} from "./run";
export { type SecretPrefill, type SecretFix, SECRET_FIX_CODES, secretFixOf } from "./secrets";
export {
  type Location,
  locate,
  insertPlace,
  findStep,
  selectedIds,
  extractChoices,
  WRAP_BLOCK,
  newStepId,
} from "./steps";

export type Selection =
  | { kind: "step"; stepId: string }
  | { kind: "slot"; parentId: string | null; block: string | null }
  /** A named screen part (`flow.parts`). */
  | { kind: "part"; name: string }
  | null;

/** A place between nodes (the "+" on a line of the flow chart): a new node goes at `index` of the block. */
export type InsertAt = { parentId: string | null; block: string | null; index: number };

/** Where on screen the palette was opened from (the "+", the node, the dock), so it opens beside it. */
export type PaletteAnchor = { left: number; top: number; right: number; bottom: number };

/**
 * The places in the sidebar; each fills the window right of it. "library" is
 * the page of all flows, "flows" the editor of the open one.
 */
export type Place = "library" | "flows" | "review" | "inventory" | "runs" | "secrets" | "extensions" | "settings";

/** A new flow the AI is making: the conversation that asked for it, and what was asked. */
export type Drafting = { chatId: string; title: string; request: string };

/** Tabs of the panel under the chart: what happened, and what is wrong. */
export type BottomTab = "log" | "issues" | "tests";

export type StudioState = {
  summaries: FlowSummary[];
  stepTypes: StepTypeDef[];
  flow: Flow | null;
  validation: ValidationReport | null;
  canUndo: boolean;
  canRedo: boolean;
  selection: Selection;
  /** Nodes picked with Shift+click: siblings from the anchor to `focus` (the selected node). */
  range: { anchor: string; focus: string; ids: string[] } | null;
  /** The "サブフローにまとめる" form is open beside the selected node. */
  extractOpen: boolean;
  /** The new flow's name typed in that form: kept while Shift+click moves the form to another node. */
  extractName: string;
  notice: string | null;
  error: string | null;
  run: RunState | null;
  /** Core's change journal for the open flow, oldest first. */
  history: HistoryEntry[];
  /** Revisions of non-Studio changes the user has looked at, per flow. */
  reviewed: Record<string, number[]>;
  /** Every flow's journal, oldest first, for the review inbox. */
  histories: Record<string, HistoryEntry[]>;
  /** Per flow: changes and evidence since the last approval (Core's reviews). */
  timelines: Record<string, ReviewTimeline>;
  /** The review desk is open instead of the flow list. */
  reviewing: boolean;
  /** A step the canvas should bring into view; `seq` changes on every request. */
  /** A node to bring into view; `inside` (a `callKey`) when it is in an entered call. */
  reveal: { stepId: string; seq: number; inside?: string } | null;
  /** The node open in the full-size editor (double-click on the chart). */
  editing: string | null;
  /** 「ここまで実行」: the run pauses before this node, runs it, and pauses again after. */
  trying: string | null;
  /** A run waiting for values of inputs with no default (「実行に必要な入力」). */
  askInputs: { flowId: string; options: RunOptions } | null;
  /** The last 「ノードの単体実行」 (only that node ran), until another node is run alone. */
  stepTest: StepTest | null;
  /** Results of nodes run alone, by flow and variable: the next node run alone reads them. */
  tested: Record<string, Record<string, unknown>>;
  /** While running, keep the running step in view. */
  followRun: boolean;
  /** How long each step of a flow usually takes (ms), from its latest runs: a running node's progress. */
  stepTimes: { flowId: string; times: Record<string, number> } | null;
  /** Steps to pause before, per flow (this PC only). */
  breakpoints: Record<string, string[]>;
  /** Frames (a loop, if, group, …) folded to their head on the chart, per flow (this PC only). */
  folded: Record<string, string[]>;
  outlineOpen: boolean;
  /** The 手順書 is open for editing (its outline), not read as sheets: the right pane may show. */
  manualEditing: boolean;
  /**
   * The right pane kept open by hand. Without it the pane opens only while a
   * node or part is selected, so the chart (or the 変数 table) has the room.
   */
  inspectorOpen: boolean;
  paletteOpen: boolean;
  /** The search over the chart (Ctrl+F). */
  searchOpen: boolean;
  /** Counts each Ctrl+F (or search button), so an open box takes the focus again. */
  searchAsked: number;
  /** Where the palette adds, when it was opened from a "+" between nodes; otherwise after the selection. */
  paletteAt: InsertAt | null;
  paletteAnchor: PaletteAnchor | null;
  place: Place;
  /**
   * A new flow asked of the AI and not made yet: the editor shows it being
   * made (DraftingFlow) until the flow appears and opens in its place.
   */
  drafting: Drafting | null;
  /** The panel under the chart (run log, issues); null when closed. */
  bottom: BottomTab | null;
  /** The flow's record and versions, opened from its revision. */
  historyOpen: boolean;
  /** The tab the history dialog opens on. */
  historyTab: "timeline" | "versions";
  /** Named versions of the open flow, newest first. */
  versions: VersionSummary[];
  /** The open flow's published version (what unattended runs execute). */
  published: PublishedState | null;
  /** Requests from AI clients waiting for the person's approval, oldest first. */
  approvals: ApprovalRequest[];
  /** AI clients waiting for the person to point at something in the browser, oldest first. */
  pickRequests: PickRequest[];
  /** The workspace policy, while its dialog is open. */
  policy: Policy | null;
  policyOpen: boolean;
  /** The flows the open one calls, directly or deeper, by id, for call nodes and their inputs. */
  called: Record<string, Flow>;
  /** Call steps shown unfolded on the chart, by `callKey` of their path. */
  unfolded: Record<string, boolean>;
  /** Call steps the chart has entered (double-click), outermost first: it shows the innermost one's flow. */
  dive: string[];
  workspace: WorkspaceInfo | null;
  /** A file whose flow already exists, waiting for the user's choice. */
  pendingImport: { contents: string; name: string } | null;
  /** The 「渡す」 dialog: what handing the flow over would put in the file. */
  handOff: PackagePlan | null;
  /** 配布フォルダー: the registered folders, what they held when last looked at, and whether their list is open. */
  distribution: { folders: DistributionFolder[]; views: DistributionView[] | null; open: boolean };
  /** A flow file being looked at before it is imported (opened from Explorer, dropped, chosen). */
  received: { file: FlowFile; preview: PackagePreview; away: boolean } | null;
  /** The dialog for an answer pasted from an AI chat without MCP: a new flow, or into the open one. */
  pasteOpen: "new" | "into" | null;
  /** Registered secrets (names, user names, sites; never values). */
  secrets: SecretInfo[];
  secretKeyLocation: string;
  /** Secrets are listed by name only: their key is not on this PC / user. */
  secretKeyMissing: boolean;
  /** Whether `secrets` has been read once (until then nothing counts as unregistered). */
  secretsLoaded: boolean;
  secretsOpen: boolean;
  /** A running step waits for the person at the PC (manual login, MFA). */
  human: WaitingHuman | null;
  /** Logins AI clients asked the user to register (request_secret), oldest first. */
  secretRequests: SecretRequest[];
  /** The last run stopped on a missing or incomplete secret. */
  secretFix: SecretFix | null;
  /** What the secrets dialog opens its form with (from a request or a failed run). */
  secretPrefill: SecretPrefill | null;

  init(): Promise<void>;
  refreshList(): Promise<void>;
  open(id: string): Promise<void>;
  create(name: string): Promise<void>;
  duplicate(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  applyOps(ops: EditOp[]): Promise<boolean>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  select(selection: Selection): void;
  /** Selects a step and brings it into view. */
  goTo(stepId: string): void;
  /** Brings up a node inside called flows too (a log line, a failure there). */
  goToPlace(place: StepPlace): void;
  /** Moves the selection to the previous / next step in reading order. */
  stepBy(delta: number): void;
  /** Moves to the previous / next step the AI changed (review desk). */
  changeBy(delta: number): void;
  setFollowRun(on: boolean): void;
  setManualEditing(on: boolean): void;
  setOutlineOpen(open: boolean): void;
  /** Keeps the right pane open (the flow's settings when nothing is selected), or closes it. */
  setInspectorOpen(open: boolean): void;
  /** Opens the right pane on the flow's own settings (name, variables, run settings). */
  showFlowProps(): void;
  /** Also keeps `reviewing` and `secretsOpen` in step. */
  setPlace(place: Place): void;
  /** Shows a new flow the AI is making in the editor (null: stops showing it). */
  showDrafting(drafting: Drafting | null): void;
  setBottom(tab: BottomTab | null): void;
  setHistoryOpen(open: boolean, tab?: "timeline" | "versions"): void;
  /** Name, description and run settings of the open flow. */
  updateFlow(patch: FlowPatch): Promise<void>;
  /** Adds a step after the selection; `params` and `name` override the type's defaults (palette presets). */
  addStep(type: string, params?: Record<string, unknown>, name?: string): Promise<void>;
  moveSelected(delta: -1 | 1): Promise<void>;
  removeSelected(): Promise<void>;
  /** Shift+click: selects the nodes from the selected one to `stepId` (same block only). */
  selectTo(stepId: string): void;
  /** Shift+drag: selects the nodes the box was drawn around (as one run of siblings, see `boxRange`). */
  selectBox(stepIds: string[]): void;
  /** Puts the selected nodes inside a new control node (繰り返し・条件分岐・エラー処理・グループ), where they were. */
  wrapSelected(type: string): Promise<void>;
  /** Opens or closes the "サブフローにまとめる" form beside the selected node. */
  setExtractOpen(open: boolean): void;
  setExtractName(name: string): void;
  /** Puts the selected nodes on the clipboard (`cut` also removes them). */
  copySelected(cut?: boolean): Promise<void>;
  /** Adds the nodes on the clipboard after the selection (or at the "+" / empty block). */
  paste(): Promise<void>;
  /** Adds a copy of the selected nodes right after them. */
  duplicateSelected(): Promise<void>;
  /** Adds copies (new IDs) of `copied` where a new node would go. */
  insertCopies(copied: Copied): Promise<void>;
  updateStep(stepId: string, patch: StepPatch): Promise<void>;
  setVariable(variable: VariableDef): Promise<void>;
  removeVariable(name: string): Promise<void>;
  loadCalled(): Promise<void>;
  /** `key`: `callKey` of the call step's path. */
  toggleUnfolded(key: string): void;
  /** Shows the flow a call step of the chart's current level runs, in place. */
  enterCall(stepId: string): void;
  /** Goes back up to `depth` entered calls (0: the open flow itself). */
  leaveCalls(depth: number): void;
  /** Moves neighbouring steps into a new flow; returns true when done. */
  extract(stepIds: string[], name: string): Promise<boolean>;
  onExternalChange(flowId: string): Promise<void>;
  /**
   * `step`: pause before the first step. Without `inputs`, an input with no
   * default is asked for first (`askInputs`) instead of failing the run.
   */
  startRun(options?: RunOptions): Promise<void>;
  /** Runs what `askInputs` held with the values the person entered. */
  answerInputs(inputs: Record<string, unknown>): Promise<void>;
  /** Closes the ask without running. */
  cancelInputs(): void;
  openEditor(stepId: string): void;
  closeEditor(): void;
  /** 「ここまで実行」: runs the flow up to and through `stepId`, then pauses, so its result can be looked at. */
  runTo(stepId: string): Promise<void>;
  /** 「ここから実行」: the nodes before it do not run; variables start as the last run had them there. */
  runFrom(stepId: string): Promise<void>;
  /** 「ノードの単体実行」: runs only `stepId`, with `values` for the variables it reads. */
  testStep(stepId: string, values: Record<string, unknown>): Promise<void>;
  /** 「中止」 for the node running alone. */
  stopStepTest(): Promise<void>;
  stopRun(): Promise<void>;
  /** Step command for the paused (or running) run; false when it was refused. */
  debug(command: DebugCommand): Promise<boolean>;
  /** `flowId`: the flow the step is in, when it is a called one shown on the chart. */
  toggleBreakpoint(stepId: string, flowId?: string): void;
  /** Removes every breakpoint of the open flow and of the flows it calls. */
  clearBreakpoints(): void;
  /** Folds a frame to its head on the chart, or opens it again. */
  toggleFold(stepId: string, flowId?: string): void;
  /** Opens the folded frames around a step of the open flow (or of `inFlow`, a called one), so it can be shown. */
  unfoldTo(stepId: string, inFlow?: Flow): void;
  onRunEvent(event: RunEventEnvelope): void;
  onRunEvidence(evidence: RunEvidence): void;
  /** Closes the notice about a failed run. */
  dismissFailure(): void;
  /** Takes the last run's marks off the chart (its log stays). */
  hideTrail(): void;
  clearLog(): void;
  dismiss(): void;
  loadHistory(): Promise<void>;
  approve(revision: number): void;
  /** Marks every unreviewed external change of the open flow as looked at (this PC only). */
  markAllReviewed(): void;
  /** Keeps the open flow's current revision: recorded in Core as approved. */
  approveAll(): Promise<void>;
  /** The review desk's 「残して本番に使う」: approves the current revision and publishes it. */
  approveAndPublish(): Promise<void>;
  /** Publishes a version (default: the current content). */
  publish(version?: number): Promise<void>;
  unpublish(): Promise<void>;
  loadApprovals(): Promise<void>;
  decideApproval(id: string, approve: boolean): Promise<void>;
  loadPickRequests(): Promise<void>;
  cancelPickRequest(id: string): Promise<void>;
  /** A wait by hand (login): the person says they finished. */
  finishPickRequest(id: string): Promise<void>;
  setPolicyOpen(open: boolean): void;
  /** Returns true when saved. */
  savePolicy(policy: Policy): Promise<boolean>;
  /** Sends the current revision back to the AI with a reason it reads over MCP. */
  sendBack(reason: string, steps: StepNote[]): Promise<boolean>;
  loadTimeline(id: string): Promise<void>;
  /** Reverts one journal entry by sending its inverse ops to Core as a new edit. */
  revert(entry: HistoryEntry): Promise<void>;
  /** Reverts every unreviewed external change of the open flow in one edit. */
  revertAll(): Promise<void>;
  loadInbox(): Promise<void>;
  setReviewing(on: boolean): void;
  /** Opens the node palette, adding at `at` (or after the selection) when a node is picked. */
  setPaletteOpen(open: boolean, at?: InsertAt | null, anchor?: PaletteAnchor | null): void;
  setSearchOpen(open: boolean): void;
  loadVersions(): Promise<void>;
  createVersion(name: string, note: string): Promise<boolean>;
  restoreVersion(number: number): Promise<void>;
  exportFlow(): Promise<void>;
  /** Opens the 「渡す」 dialog for flow `id`. */
  /** Opens (or re-plans) 渡す for the published version ("auto") or the current content. */
  openHandOff(id: string, content?: "auto" | "current"): Promise<void>;
  closeHandOff(): void;
  /** Reads the registered 配布フォルダー and looks through them (quietly: a folder that cannot be opened says so in its view). */
  checkDistribution(): Promise<void>;
  setDistributionFolders(folders: DistributionFolder[]): Promise<boolean>;
  openDistribution(): void;
  closeDistribution(): void;
  /** Puts the published version of a flow into a 配布フォルダー. True once it is there. */
  placeInDistribution(id: string, folder: string, only?: { flowId: string; path: string }[]): Promise<boolean>;
  /** Writes the flow as a `.spx` file; the path, or null when it failed (said in `error`). */
  exportPackage(id: string, options: PackageOptions): Promise<ExportedPackage | null>;
  /** Shows what a flow file holds and what this PC needs, before importing it. */
  receiveFile(file: FlowFile): Promise<void>;
  closeReceived(): void;
  /** Sets the file aside while the person adds what it needs (a login, an extension, a site). */
  stepAwayFromReceived(): void;
  /** Back to the file: checks again what this PC still needs. */
  backToReceived(): Promise<void>;
  /** Imports the file shown by receiveFile and opens the flow. True once it is in. */
  importReceived(onConflict?: ImportConflict): Promise<boolean>;
  /** Imports file contents; on IMPORT_CONFLICT keeps them in `pendingImport`. True once it is in. */
  importFile(contents: string, onConflict?: ImportConflict): Promise<boolean>;
  cancelImport(): void;
  setPasteOpen(mode: "new" | "into" | null): void;
  /**
   * Takes in an AI's answer: a new flow, or with `into` the open flow's new
   * content. Opens the flow it made; returns what happened, null on an error.
   */
  pasteAnswer(text: string, into: boolean): Promise<PasteOutcome | null>;
  setWorkspace(path: string, shared: boolean): Promise<void>;
  loadSecrets(): Promise<void>;
  /** Returns true when saved. */
  saveSecret(input: SecretInput): Promise<boolean>;
  /**
   * Saves values and adds `addSites` to the sites the secret has now (read
   * again first: the CLI may have changed them while Studio was open).
   */
  saveSecretAdding(input: Omit<SecretInput, "sites">, addSites: string[]): Promise<boolean>;
  removeSecret(name: string): Promise<void>;
  /** Forgets the saved sign-in (browser login, OAuth tokens) of a name. */
  signOutSecret(name: string): Promise<void>;
  resetSecrets(): Promise<void>;
  setSecretsOpen(open: boolean): void;
  loadSecretRequests(): Promise<void>;
  dismissSecretRequest(name: string): Promise<void>;
  /** Opens the secrets dialog on the form for `prefill.name`, with its sites added. */
  openSecretForm(prefill: SecretPrefill): void;
  clearSecretPrefill(): void;
  dismissSecretFix(): void;
};

export function createStudioStore(api: Api): StoreApi<StudioState> {
  return createStore<StudioState>()((set, get) => {
    const ctx = storeContext(api, set, get);

    return {
      summaries: [],
      stepTypes: [],
      flow: null,
      validation: null,
      canUndo: false,
      canRedo: false,
      selection: null,
      range: null,
      extractOpen: false,
      extractName: "",
      notice: null,
      error: null,
      run: null,
      history: [],
      reviewed: loadReviewed(),
      histories: {},
      timelines: {},
      reviewing: false,
      reveal: null,
      editing: null,
      trying: null,
      askInputs: null,
      stepTest: null,
      tested: {},
      followRun: true,
      stepTimes: null,
      breakpoints: loadBreakpoints(),
      folded: loadFolded(),
      outlineOpen: loadFlag(OUTLINE_KEY, false),
      manualEditing: false,
      inspectorOpen: loadFlag(INSPECTOR_KEY, false),
      paletteOpen: false,
      searchOpen: false,
      searchAsked: 0,
      paletteAt: null,
      paletteAnchor: null,
      place: "library",
      drafting: null,
      bottom: null,
      historyOpen: false,
      historyTab: "timeline",
      versions: [],
      published: null,
      approvals: [],
      pickRequests: [],
      policy: null,
      policyOpen: false,
      called: {},
      unfolded: {},
      dive: [],
      workspace: null,
      pendingImport: null,
      handOff: null,
      distribution: { folders: [], views: null, open: false },
      received: null,
      pasteOpen: null,
      secrets: [],
      secretKeyLocation: "",
      secretKeyMissing: false,
      secretsLoaded: false,
      secretsOpen: false,
      human: null,
      secretRequests: [],
      secretFix: null,
      secretPrefill: null,

      async init() {
        try {
          const [stepTypes, summaries] = await Promise.all([api.listStepTypes(), api.listFlows()]);
          setFlowNames(new Map(summaries.map((s) => [s.id, s.name] as const)));
          registerExtensions(stepTypes);
          set({ stepTypes, summaries });
          void get().loadInbox();
          set({ workspace: await api.workspaceInfo() });
        } catch (e) {
          set({ error: message(e) });
        }
        await get().loadSecrets();
        await get().loadSecretRequests();
      },

      ...secretsActions(ctx),
      ...flowsActions(ctx),
      ...uiActions(ctx),
      ...editActions(ctx),
      ...runActions(ctx),
      ...reviewActions(ctx),
      ...sharingActions(ctx),

      async setWorkspace(path, shared) {
        try {
          // Studio restarts on success, so nothing after this runs.
          await api.setWorkspace(path, shared);
        } catch (e) {
          set({ error: message(e) });
        }
      },
    };
  });
}

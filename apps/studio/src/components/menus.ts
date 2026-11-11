// What right-clicking means in each place (see docs/design/ui-principles.md,
// "右クリック"). A menu repeats the actions that already sit by the thing —
// with the same words and keys — and never holds an action found nowhere else.
import type { Step } from "@spellsheet/schema";
import {
  Workflow,
  SquareDashed,
  ArrowDown,
  ArrowUp,
  CircleDot,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Eye,
  EyeOff,
  FoldVertical,
  LogIn,
  MessageSquareText,
  Scissors,
  Trash2,
  Play,
  StepForward,
  UnfoldVertical,
  Variable,
  Lock,
  UserRound,
} from "lucide-react";
import { openAsk, useAgentApi } from "../agent";
import { useStudioApi } from "../context";
import { isActive, selectedIds, WRAP_BLOCK } from "../store";
import { copyText, type MenuEntry, type MenuSpec } from "../lib/contextMenu";
import { stepLabel, t } from "../lib/i18n";
import { canStartAt } from "../lib/startAt";

/** A call step as the chart shows it. */
export type CallMenu = { key: string; canEnter: boolean; unfolded: boolean };

/** Right-click on a node (chart or procedure): selects it, then its actions. */
export function useStepMenu() {
  const store = useStudioApi();
  const agent = useAgentApi();
  return (step: Step, options: { owner: string; readOnly?: boolean; call?: CallMenu }): MenuSpec[] => {
    const s = store.getState();
    const id = step.id ?? "";
    const { readOnly = false, call } = options;
    const breakpoint = (s.breakpoints[options.owner] ?? []).includes(id);
    const breakpointItem: MenuEntry = {
      label: breakpoint ? t.menu.breakpointOff : t.menu.breakpointOn,
      icon: CircleDot,
      shortcut: readOnly ? undefined : "F9",
      run: () => store.getState().toggleBreakpoint(id, options.owner),
    };
    const copyId: MenuEntry = { label: t.menu.copyId, icon: Copy, run: () => copyText(id) };
    if (readOnly) return [breakpointItem, "-", copyId];
    // Right-clicking one of several picked nodes keeps them picked.
    if (!selectedIds(s).includes(id)) s.select({ kind: "step", stepId: id });
    const agentName = agent.getState().info?.name ?? "AI";
    // Runs of the open flow only (not of a node in a flow it calls).
    const running = !!s.run && isActive(s.run);
    const own = options.owner === s.flow?.id;
    const startable = own && s.flow ? canStartAt(s.flow.steps ?? [], id) === true : false;
    return [
      // Bigger changes are the AI's (docs/design/ai-authoring.md, 人の手の役割): first in the menu.
      {
        label: t.menu.askAgent(agentName),
        icon: MessageSquareText,
        shortcut: "Ctrl+J",
        // The pane sends the selected node along with the request.
        run: () => openAsk(agent, { about: s.flow ? { id: s.flow.id, name: s.flow.name } : undefined, draft: t.props.askFixDraft(step.name || stepLabel(step.type, s.stepTypes.find((d) => d.type === step.type)?.label)) }),
      },
      "-",
      own && { label: t.menu.runTo, icon: Play, disabled: running, run: () => void store.getState().runTo(id) },
      own && {
        label: startable ? t.menu.runFrom : t.menu.runFromNot,
        icon: StepForward,
        disabled: running || !startable,
        run: () => void store.getState().runFrom(id),
      },
      "-",
      call?.canEnter && { label: t.menu.openCall, icon: LogIn, run: () => store.getState().enterCall(id) },
      call && {
        label: call.unfolded ? t.menu.fold : t.menu.unfold,
        icon: call.unfolded ? FoldVertical : UnfoldVertical,
        run: () => store.getState().toggleUnfolded(call.key),
      },
      "-",
      { label: t.menu.cut, icon: Scissors, shortcut: "Ctrl+X", run: () => void store.getState().copySelected(true) },
      { label: t.menu.copy, icon: Copy, shortcut: "Ctrl+C", run: () => void store.getState().copySelected() },
      { label: t.menu.pasteAfter, icon: ClipboardPaste, shortcut: "Ctrl+V", run: () => void store.getState().paste() },
      { label: t.duplicate, icon: CopyPlus, shortcut: "Ctrl+D", run: () => void store.getState().duplicateSelected() },
      "-",
      { label: t.moveUp, icon: ArrowUp, shortcut: "Alt+↑", run: () => void store.getState().moveSelected(-1) },
      { label: t.moveDown, icon: ArrowDown, shortcut: "Alt+↓", run: () => void store.getState().moveSelected(1) },
      "-",
      // Flow control is mostly put around nodes already there: pick them (Shift+click) and wrap them.
      ...(step.type === "control.case"
        ? []
        : Object.keys(WRAP_BLOCK).map(
            (type): MenuEntry => ({ label: t.menu.wrapIn(stepLabel(type, s.stepTypes.find((d) => d.type === type)?.label)), icon: SquareDashed, run: () => void store.getState().wrapSelected(type) }),
          )),
      // Beside 囲む: the same picked nodes, moved into a flow of their own.
      step.type !== "control.case" && { label: t.menu.extract, icon: Workflow, run: () => store.getState().setExtractOpen(true) },
      "-",
      {
        label: step.disabled ? t.menu.enable : t.menu.disable,
        icon: step.disabled ? Eye : EyeOff,
        run: () => void store.getState().updateStep(id, { disabled: !step.disabled }),
      },
      breakpointItem,
      "-",
      copyId,
      "-",
      { label: t.delete, icon: Trash2, shortcut: "Delete", danger: true, run: () => void store.getState().removeSelected() },
    ];
  };
}

/** Right-click on a variable (chip on the chart, row of the table). */
export function useVariableMenu() {
  const store = useStudioApi();
  return (name: string, options: { writer?: string; onOpenWriter?: (id: string) => void; inTable?: boolean } = {}): MenuSpec[] => {
    const s = store.getState();
    const variable = s.flow?.variables?.find((v) => v.name === name);
    const declared = variable !== undefined;
    const { writer, onOpenWriter, inTable } = options;
    return [
      { label: t.menu.copyName, icon: Copy, run: () => copyText(name) },
      // On the chart, variables are edited in the flow's settings; the 変数 table edits them in place.
      declared && !inTable && { label: t.menu.variableSettings, icon: Variable, run: () => store.getState().showFlowProps() },
      // In the table, secrecy and personal data are the settings without a column of their own.
      declared &&
        inTable && {
          label: variable.secret ? t.vars.table.unmakeSecret : t.vars.table.makeSecret,
          icon: Lock,
          run: () => void store.getState().setVariable(variable.secret ? { ...variable, secret: false } : { ...variable, secret: true, default: undefined }),
        },
      declared &&
        inTable &&
        !variable.secret && {
          label: variable.personal ? t.vars.table.unmakePersonal : t.vars.table.makePersonal,
          icon: UserRound,
          run: () => void store.getState().setVariable({ ...variable, personal: variable.personal ? undefined : true }),
        },
      writer && onOpenWriter && { label: t.menu.openWriter, icon: LogIn, run: () => onOpenWriter(writer) },
      "-",
      declared && { label: t.menu.removeVariable, icon: Trash2, danger: true, run: () => void store.getState().removeVariable(name) },
    ];
  };
}

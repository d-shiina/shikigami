// The built-in node types Studio's own logic has to know by name: control
// steps (which shape the chart) and the variables a node binds. Everything
// else about a node comes from its definition (`StepTypeDef`), so a plugin's
// node needs no change here. Tables keyed by type for display (sentences,
// icons, keywords) stay with what they display.

/** Control steps, as in `spellsheet_core::registry::control`. */
export const IF = "control.if";
export const SWITCH = "control.switch";
export const CASE = "control.case";
export const WHILE = "control.while";
export const REPEAT = "control.repeat";
export const FOR_EACH = "control.forEach";
export const TRY = "control.try";
export const BREAK = "control.break";
export const CONTINUE = "control.continue";
export const FAIL = "control.fail";
export const PARALLEL = "control.parallel";
export const GROUP = "control.group";
/** Runs another flow (a sub-flow). */
export const CALL = "flow.call";
export const VARIABLE_SET = "variable.set";

/** The repeats: framed as a loop on the chart. */
export const LOOP_TYPES: ReadonlySet<string> = new Set([WHILE, REPEAT, FOR_EACH]);

/**
 * Params that name a variable the node writes (`itemVar`, `name`), not a
 * value it reads: the registry's `bindsVariables`. A test checks this
 * against the built-in definitions, so the two cannot drift apart.
 */
export const BINDS: Readonly<Record<string, readonly string[]>> = {
  [FOR_EACH]: ["itemVar", "indexVar"],
  [REPEAT]: ["indexVar"],
  [TRY]: ["errorVar"],
  [VARIABLE_SET]: ["name"],
};

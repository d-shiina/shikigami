// The flow's checks in words for people (see issues.ja.ts).
import type { IssueText } from "../issueText";

export const issuesEn: Record<string, IssueText> = {
  INVALID_PARAMS: (c) => (c.missing ? `Enter "${c.label(c.missing)}"` : c.field ? `"${c.label(c.field)}" is not in the right form` : "A setting of this node is wrong"),
  UNDEFINED_VARIABLE: (c) => (c.name ? `There is no variable "${c.name}". Add it, or check the name` : "Uses a variable that does not exist"),
  EXPR_SYNTAX: (c) => (c.field ? `The expression in "${c.label(c.field)}" is not written correctly` : "An expression is not written correctly"),
  EXPR_UNKNOWN_FUNCTION: "An expression uses a function that does not exist. Check its name",
  VARIABLE_TYPE_MISMATCH: (c) => (c.name ? `The initial value of "${c.name}" does not match its type` : "A variable's initial value does not match its type"),
  INVALID_VARIABLE_NAME: (c) => `Variable names${c.name ? ` ("${c.name}")` : ""} use only letters, digits and _, starting with a letter`,
  DUPLICATE_VARIABLE: (c) => `The variable${c.name ? ` "${c.name}"` : ""} is added twice`,
  NO_OUTPUT: "This node returns nothing, so it cannot save a result",
  EMPTY_NAME: "Enter a name for the flow",
  NOT_IN_LOOP: "Put this node inside a repeat",
  UNKNOWN_PART: "The part it uses is not in this flow",
  PART_NOT_PICKED: "The part has not been picked on screen yet",
  PATH_OUTSIDE_PROJECT: (c) => (c.field ? `"${c.label(c.field)}" cannot be outside the flow's folder` : "Paths cannot be outside the flow's folder"),
  FOREACH_COLLECT_WITHOUT_SAVE_AS: 'To use "Collect results into", also enter "Save result to"',
  INVALID_SECRET_REF: "The secret is not set correctly. Choose it again",
  SECRET_DEFAULT: "Secret variables cannot have an initial value. Register it as a secret instead",
  UNKNOWN_STEP_TYPE: "This kind of node is not available in this Studio",
  DEPRECATED_STEP_TYPE: "This node is an old kind. Replace it with the new one",
  PLUGIN_NOT_INSTALLED: "The plugin this node needs is not installed",
  INVALID_RETRY: "Set the retry count to 1 or more",
  NOT_A_CASE: "Only cases go inside a switch",
  CASE_OUTSIDE_SWITCH: "Put a case inside a switch",
};

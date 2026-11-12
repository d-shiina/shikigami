// What a person still has to do before the open flow can run (a file to put
// in its folder, a login to register, a part to pick). The bar's run button,
// the sheet's 「実行する」 and F5 all read it, so none of them starts a run
// that can only fail on the first missing thing.
import { useEffect } from "react";
import { create } from "zustand";
import { t } from "./i18n";
import type { Todo } from "./todos";
import { useTodos } from "./useTodos";

export const useRunGate = create<{ flowId: string | null; todo: string | null }>(() => ({ flowId: null, todo: null }));

/** The to-do in words, as the to-do list says it. */
export function todoText(todo: Todo): string {
  if (todo.kind === "pick") return todo.image ? t.todos.snip(todo.label) : t.todos.pick(todo.label);
  if (todo.kind === "secret") return t.todos.secret(todo.name);
  return t.todos.file(todo.path);
}

/** Why the open flow cannot run yet because of a to-do, or null. */
export function todoBlock(flowId: string | null | undefined): string | null {
  const gate = useRunGate.getState();
  return gate.flowId === flowId && gate.todo ? t.todos.runFirst(gate.todo) : null;
}

/** Keeps the gate current for the open flow; mounted once with the flow's bar. */
export function useRunGateSync(flowId: string | null | undefined): string | null {
  const todos = useTodos();
  const first = todos[0] ? todoText(todos[0]) : null;
  useEffect(() => {
    useRunGate.setState({ flowId: flowId ?? null, todo: first });
  }, [flowId, first]);
  return first ? t.todos.runFirst(first) : null;
}

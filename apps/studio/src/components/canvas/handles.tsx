// The connection points on the sides of a node: where the flow comes in
// and goes out, and where a variable's link is drawn.
import { Handle, Position } from "@xyflow/react";

/**
 * A variable socket on the node's edge: a small hollow ring, filled with the
 * variable's type colour while its value is in focus. Links attach here.
 */
export function Socket({ side, id, color, title, lit }: { side: "in" | "out"; id: string; color: string; title: string; lit: boolean }) {
  return (
    <Handle
      id={id}
      type={side === "in" ? "target" : "source"}
      position={side === "in" ? Position.Left : Position.Right}
      title={title}
      isConnectable={false}
      className="flow-socket"
      style={{
        width: 9,
        height: 9,
        background: lit ? color : "var(--color-sheet)",
        border: `1.5px solid ${lit ? color : "var(--color-slate-300)"}`,
      }}
    />
  );
}

// Flow handles only anchor the lines: nothing connects by hand, so they are not drawn.
export const FLOW_HANDLE = "!h-px !min-h-0 !w-px !min-w-0 !border-0 !bg-transparent";

/** Where step-to-step flow enters (top) and leaves (bottom) a node; `x` from its left edge, else its middle. */
export function FlowHandles({ x }: { x?: number }) {
  // `left` counts from inside the node's 1px border.
  const style = x === undefined ? undefined : { left: x - 1 };
  return (
    <>
      <Handle id="flow" type="target" position={Position.Top} className={FLOW_HANDLE} style={style} />
      <Handle id="flow" type="source" position={Position.Bottom} className={FLOW_HANDLE} style={style} />
    </>
  );
}

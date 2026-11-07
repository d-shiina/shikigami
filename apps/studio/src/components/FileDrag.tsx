// Dragging a file onto a setting or the chart. A file of the flow's folder is
// dragged from the project panel (or the node editor's file list) with the
// pointer; a file from Explorer arrives through the window's own drop events.
// Either way it lands on what is under the pointer: a file setting takes its
// path (relative to the flow's folder), the chart makes the node that reads it,
// and the project panel's shelves take a copy.
//
// The webview's HTML drag and drop does not reach the page on Windows while the
// window takes drops from Explorer, so the drag inside Studio follows the
// pointer itself.
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { FileText } from "lucide-react";
import { useContext, useEffect, useMemo, useRef } from "react";
import { create } from "zustand";
import { fileName, folderOf, insideFolder } from "../lib/fileDrop";
import { t } from "../lib/i18n";
import { ProjectContext, type Role, ROLES } from "../project";

/** What a drop target takes: one file, a folder, or files to make nodes from. */
export type DropKind = "file" | "folder" | "canvas";
type Drop = (paths: string[], el: Element) => void | Promise<unknown>;
type Target = { kind: DropKind; drop: Drop };

const targets = new Map<string, Target>();
let seq = 0;

type DragState = {
  /** A file of the folder on its way, and where the pointer is. */
  drag: { label: string; x: number; y: number } | null;
  /** Files from Explorer over the window. */
  external: boolean;
  /** The target under the pointer. */
  over: string | null;
  /** The project panel's shelf under a drag from Explorer (the panel itself when between shelves). */
  shelf: Role | "panel" | null;
};

export const useFileDrag = create<DragState>(() => ({ drag: null, external: false, over: null, shelf: null }));

/**
 * Makes an element take dropped files: spread the returned attributes on it.
 * `over` is true while a file is held over it, `armed` while any is held.
 */
export function useFileDropTarget(kind: DropKind, drop: Drop): { attrs: { "data-file-drop": string }; over: boolean; armed: boolean } {
  const id = useMemo(() => `drop${++seq}`, []);
  const latest = useRef(drop);
  latest.current = drop;
  useEffect(() => {
    targets.set(id, { kind, drop: (paths, el) => latest.current(paths, el) });
    return () => void targets.delete(id);
  }, [id, kind]);
  const over = useFileDrag((s) => s.over === id);
  const armed = useFileDrag((s) => s.drag !== null || s.external);
  return { attrs: { "data-file-drop": id }, over, armed };
}

function targetAt(x: number, y: number): { id: string; el: Element; target: Target } | null {
  const el = document.elementFromPoint(x, y);
  const host = el?.closest("[data-file-drop]");
  const id = host?.getAttribute("data-file-drop");
  const target = id ? targets.get(id) : undefined;
  return el && id && target ? { id, el, target } : null;
}

/** What a folder setting takes from a dropped path (a file's folder). */
const forKind = (kind: DropKind, path: string) => (kind === "folder" && /\.[^/\\]+$/.test(path) ? folderOf(path) : path);

/** Starts dragging a file of the folder (`input/a.xlsx`) from a pointer press on it. */
export function startFileDrag(e: React.PointerEvent, path: string) {
  if (e.button !== 0) return;
  const sx = e.clientX;
  const sy = e.clientY;
  let moving = false;
  const move = (ev: PointerEvent) => {
    if (!moving && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
    if (!moving) {
      moving = true;
      document.body.style.userSelect = "none";
      window.getSelection()?.removeAllRanges();
    }
    const at = targetAt(ev.clientX, ev.clientY);
    useFileDrag.setState({ drag: { label: fileName(path), x: ev.clientX, y: ev.clientY }, over: at?.id ?? null });
  };
  const finish = (ev: PointerEvent | null) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", key, true);
    if (!moving) return;
    document.body.style.userSelect = "";
    useFileDrag.setState({ drag: null, over: null });
    // The press ended a drag, not a click: the file is not opened.
    const swallow = (c: MouseEvent) => {
      c.stopPropagation();
      c.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    const at = ev ? targetAt(ev.clientX, ev.clientY) : null;
    if (at) void at.target.drop([forKind(at.target.kind, path)], at.el);
  };
  const up = (ev: PointerEvent) => finish(ev);
  const cancel = () => finish(null);
  const key = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape") return;
    ev.stopPropagation();
    finish(null);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", key, true);
}

/** The project panel's shelf under a point. */
function shelfAt(x: number, y: number): Role | "panel" | null {
  const el = document.elementFromPoint(x, y);
  const shelf = el?.closest("[data-shelf]")?.getAttribute("data-shelf");
  if (shelf && (ROLES as string[]).includes(shelf)) return shelf as Role;
  return el?.closest("[data-project-panel]") ? "panel" : null;
}

/**
 * Drops from Explorer: onto a setting or the chart, the files go into the
 * flow's folder first (unless they are in it already) and the target takes
 * them from there; onto the project panel, they go on the shelf under the
 * pointer, or are sorted by name.
 */
function useExternalDrop() {
  const project = useContext(ProjectContext);
  useEffect(() => {
    if (!project) return;
    const dropOn = async (target: Target, el: Element, paths: string[]) => {
      const p = project.getState();
      const dir = p.files?.dir;
      if (target.kind === "folder") {
        const path = paths[0]!;
        return target.drop([forKind("folder", insideFolder(dir, path) ?? path)], el);
      }
      const wanted = target.kind === "file" ? paths.slice(0, 1) : paths;
      const inside = wanted.map((path) => insideFolder(dir, path));
      const outside = wanted.filter((_, i) => inside[i] === null);
      // Only once the copy is there: a file of the same name already on the
      // shelf, or a failed copy, would otherwise point the node at other contents.
      const copied = outside.length > 0 ? await p.copyIn(outside, null) : [];
      const paths2 = [...inside.filter((x): x is string => x !== null), ...copied.map((f) => f.path)];
      if (paths2.length > 0) await target.drop(paths2, el);
    };
    let off: (() => void) | null = null;
    let gone = false;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        const payload = e.payload;
        if (payload.type === "leave") return useFileDrag.setState({ external: false, over: null, shelf: null });
        const x = payload.position.x / devicePixelRatio;
        const y = payload.position.y / devicePixelRatio;
        const at = targetAt(x, y);
        const panelOpen = project.getState().panelOpen && project.getState().flowId !== null;
        if (payload.type === "enter" || payload.type === "over") {
          useFileDrag.setState({ external: true, over: at?.id ?? null, shelf: at || !panelOpen ? null : (shelfAt(x, y) ?? "panel") });
          return;
        }
        // drop
        const shelf = shelfAt(x, y);
        useFileDrag.setState({ external: false, over: null, shelf: null });
        if (payload.paths.length === 0) return;
        if (at) void dropOn(at.target, at.el, payload.paths);
        // Bundles and flow files are imported from the library, not added here.
        else if (panelOpen) void project.getState().copyIn(payload.paths, shelf === "panel" ? null : shelf);
      })
      .then((unlisten) => {
        if (gone) unlisten();
        else off = unlisten;
      })
      .catch(() => {
        // Outside Tauri (tests, the browser preview) there is nothing to drop.
      });
    return () => {
      gone = true;
      off?.();
    };
  }, [project]);
}

/** The file under the pointer while it is dragged, and what letting go will do. */
export function FileDragLayer() {
  useExternalDrop();
  const drag = useFileDrag((s) => s.drag);
  const over = useFileDrag((s) => s.over);
  if (!drag) return null;
  const kind = over ? targets.get(over)?.kind : undefined;
  const hint = kind === "canvas" ? t.fileDrop.makeNode : kind ? t.fileDrop.putHere : t.fileDrop.where;
  return (
    <div
      className="pointer-events-none fixed z-[100] flex max-w-[280px] items-center gap-2 rounded-[4px] border border-brand-500 bg-sheet px-2.5 py-1.5 text-[12px] shadow-lifted"
      style={{ left: drag.x + 14, top: drag.y + 10 }}
    >
      <FileText size={14} strokeWidth={1.75} className="shrink-0 text-brand-500" aria-hidden="true" />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-ink">{drag.label}</span>
        <span className={`truncate text-[10.5px] ${kind ? "text-brand-600" : "text-slate-500"}`}>{hint}</span>
      </span>
    </div>
  );
}

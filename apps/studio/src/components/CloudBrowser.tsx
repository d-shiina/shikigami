// 「参照…」 in the cloud storage dialog: walk the storage's folders and pick
// one, then (to fetch input) everything in it or some of its files. It signs
// in first (a person signs in only the first time) and lists each folder
// through the storage's extension (`<service>.list`), so Box, Google Drive
// and OneDrive / SharePoint look the same.
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight, File, Folder, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { CloudService, CloudSide } from "../lib/cloudPlaces";
import { t } from "../lib/i18n";

/** One entry of `<service>.list`. */
interface Item {
  id: string;
  name: string;
  type: "file" | "folder";
  size?: number;
  modifiedAt?: string;
  /** From the top of the storage, when the folder was named by its path. */
  path?: string;
  /** How the extension names the item again when it has no path (OneDrive under a link). */
  ref?: string;
}

/** A folder walked into: how to name it to the extension, and its name for people. */
interface Crumb {
  ref: string;
  name: string;
}

export interface Picked {
  /** The folder as the extension takes it (a path, an ID or a link). */
  folder: string;
  /** The folder for people (経理/受注). */
  folderName: string;
  /** The files chosen in it; empty for every file. */
  files: string[];
}

const message = (e: unknown) => (typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e));

/** How an item is named to the extension when walking into it. */
const refOf = (item: Item) => item.path ?? item.ref ?? item.id;

export function CloudBrowser({
  service,
  label,
  secret,
  signIn,
  side,
  start,
  onPick,
  onCancel,
}: {
  service: CloudService;
  /** The storage for people (Box). */
  label: string;
  secret: string;
  signIn: Record<string, unknown>;
  side: CloudSide;
  /** A folder already set or pasted (path, ID or link); empty for the top. */
  start: { folder: string; folderName: string; files: string[] };
  onPick: (picked: Picked) => void;
  onCancel: () => void;
}) {
  const b = t.places.cloudDialog.browse;
  const top: Crumb = { ref: "/", name: b.top(label) };
  const [crumbs, setCrumbs] = useState<Crumb[]>(() =>
    start.folder && start.folder !== "/" ? [top, { ref: start.folder, name: start.folderName || start.folder }] : [top],
  );
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>(start.files);
  const [some, setSome] = useState(start.files.length > 0);
  // The sign-in is needed once: later folders are listed without it.
  const [signedIn, setSignedIn] = useState(false);
  const here = crumbs[crumbs.length - 1]!;

  const load = useCallback(
    async (ref: string) => {
      setItems(null);
      setError(null);
      try {
        const list = await invoke<Item[]>("cloud_list", { service: service.plugin, secret, signIn: signedIn ? null : signIn, folder: ref });
        setSignedIn(true);
        setItems([...(list ?? [])].sort((a, c) => (a.type === c.type ? a.name.localeCompare(c.name, "ja") : a.type === "folder" ? -1 : 1)));
      } catch (e) {
        setError(message(e));
        setItems([]);
      }
    },
    [service.plugin, secret, signIn, signedIn],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: listed again only when the folder changes
  useEffect(() => void load(here.ref), [here.ref]);

  const enter = (item: Item) => {
    setCrumbs([...crumbs, { ref: refOf(item), name: item.name }]);
    setChosen([]);
    setSome(false);
  };
  const back = (index: number) => {
    setCrumbs(crumbs.slice(0, index + 1));
    setChosen([]);
    setSome(false);
  };
  const toggle = (name: string) => {
    setSome(true);
    setChosen((list) => (list.includes(name) ? list.filter((n) => n !== name) : [...list, name]));
  };
  const reading = side === "input";
  const folderName = crumbs
    .slice(1)
    .map((c) => c.name)
    .join("/");
  const pick = () =>
    onPick({
      folder: here.ref,
      folderName: folderName || top.name,
      files: reading && some ? chosen : [],
    });
  const files = (items ?? []).filter((i) => i.type === "file");

  return (
    <div data-cloud-browser className="mt-4">
      <nav aria-label={b.where} className="flex flex-wrap items-center gap-0.5 text-[12.5px]">
        {crumbs.map((c, i) => (
          <span key={`${i}-${c.ref}`} className="flex items-center gap-0.5">
            {i > 0 && <ChevronRight size={13} strokeWidth={1.75} className="text-slate-400" aria-hidden="true" />}
            {i === crumbs.length - 1 ? (
              <span className="font-medium text-ink">{c.name}</span>
            ) : (
              <button type="button" onClick={() => back(i)} className="text-brand-500 hover:underline">
                {c.name}
              </button>
            )}
          </span>
        ))}
      </nav>
      <div className="mt-2 h-[260px] overflow-y-auto rounded-md border border-slate-200">
        {items === null ? (
          <p className="flex items-center gap-2 px-3 py-3 text-[12.5px] text-slate-500">
            <LoaderCircle size={14} strokeWidth={1.75} className="animate-spin" aria-hidden="true" />
            {signedIn ? b.loading : b.signingIn(label)}
          </p>
        ) : items.length === 0 && !error ? (
          <p className="px-3 py-3 text-[12.5px] text-slate-500">{b.empty}</p>
        ) : (
          <ul>
            {items.map((item) =>
              item.type === "folder" ? (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => enter(item)}
                    className="flex h-8 w-full items-center gap-2 px-3 text-left text-[13px] text-ink hover:bg-slate-50 dark:hover:bg-white/5"
                  >
                    <Folder size={15} strokeWidth={1.75} className="shrink-0 text-amber-600" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    <ChevronRight size={14} strokeWidth={1.75} className="text-slate-400" aria-hidden="true" />
                  </button>
                </li>
              ) : (
                <li key={item.id}>
                  <label
                    className={`flex h-8 items-center gap-2 px-3 text-[13px] ${reading ? "cursor-pointer hover:bg-slate-50 dark:hover:bg-white/5" : "text-slate-500"}`}
                  >
                    {reading && <input type="checkbox" checked={some && chosen.includes(item.name)} onChange={() => toggle(item.name)} />}
                    <File size={15} strokeWidth={1.75} className="shrink-0 text-slate-400" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    {item.modifiedAt && <span className="shrink-0 text-[11px] text-slate-400">{new Date(item.modifiedAt).toLocaleDateString()}</span>}
                  </label>
                </li>
              ),
            )}
          </ul>
        )}
        {error && <p className="px-3 py-2 text-[12.5px] text-shu-600">{error}</p>}
      </div>
      {reading && (
        <div className="mt-2 space-y-1 text-[12.5px] text-slate-700" role="radiogroup" aria-label={b.which}>
          <label className="flex items-center gap-2">
            <input type="radio" checked={!some} onChange={() => setSome(false)} />
            {b.all(files.length)}
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={some} onChange={() => setSome(true)} />
            {b.some(chosen.length)}
          </label>
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="h-8 rounded-lg px-3 text-[13px] text-slate-600 hover:bg-slate-100">
          {t.cancel}
        </button>
        <button
          type="button"
          disabled={items === null || (reading && some && chosen.length === 0)}
          onClick={pick}
          className="h-8 rounded-lg bg-primary px-4 text-[13px] font-medium text-on-primary hover:bg-primary-hover disabled:opacity-60"
        >
          {reading ? b.pickInput : b.pickOutput}
        </button>
      </div>
    </div>
  );
}

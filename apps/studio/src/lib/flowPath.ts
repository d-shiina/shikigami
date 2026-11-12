// A path as the person thinks of it. Run errors carry the full path on the
// PC (C:\Users\…\SpellSheet\flows\<flow>\input\orders.xlsx); inside the
// flow's own folder the part after it (input/orders.xlsx) is what the sheet,
// the files panel and the "to do" list show.

const IN_FLOW = /[\\/]flows[\\/][^\\/]+[\\/](.+)$/;

/** `input/orders.xlsx` for a file in a flow's folder, else null. */
export function inFlowFolder(path: string): string | null {
  const m = IN_FLOW.exec(path);
  return m?.[1] ? m[1].replace(/\\/g, "/") : null;
}

/** The shortest name that still says which file: the flow-folder part, else the path as given. */
export function shownPath(path: string): string {
  return inFlowFolder(path) ?? path;
}

// The notes of a new version as Studio shows them: the GitHub Release body
// (the CHANGELOG section, scripts/release-notes.mjs) without the English
// "download the installer below" footer, which means nothing inside Studio.
export function releaseNotes(body: string): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  let footer = lines.length - 1;
  while (footer >= 0 && !/^\s*Install:/.test(lines[footer] ?? "")) footer--;
  if (footer < 0) return body.trim();
  let end = footer;
  while (end > 0 && /^\s*(-{3,})?\s*$/.test(lines[end - 1] ?? "")) end--;
  return lines.slice(0, end).join("\n").trimEnd();
}

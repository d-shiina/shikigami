// The 手順書 as one HTML file: the same outline ManualView shows, with the
// pictures cut to the marked part and what is hidden burned in, so the file
// can be opened, printed or turned into a PDF anywhere.
import { locale, t } from "./i18n";
import {
  blurRegions,
  type Container,
  cropOf,
  type Edition,
  frameTree,
  type Leaf,
  type ManualDoc,
  type ManualItem,
  type ManualShot,
  type ManualStep,
  type Mask,
  type PageNode,
  pagesOf,
  type Rect,
  type Scene,
  overviewRows,
} from "./manual";
import type { Part } from "./sentence";

export type ExportOptions = {
  /** Blur table cells and input fields (the picture's `regions`). */
  blurFields: boolean;
  /** Words only. */
  noPictures: boolean;
  /** "11月8日 18:20 の実行…" or null. */
  made: string | null;
  /** 「11月8日 18:20 の実行」: where the screens came from, short. */
  shotAt: string;
  edition: Edition;
  /** The schedules of the flow, in words. */
  when: string[];
  date: string;
};

/** The numbered marks a scene puts on its picture. */
/** A place marked on a picture: a numbered operation, or (number null) what the flow waits for. */
export type SceneMark = { number: number | null; rect: Rect; operates?: boolean };

/**
 * Where the buttons and fields a step works are: kept clear of the blur over
 * values. Marks of nodes that only read a value stay under the blur.
 */
export const operated = (marks: SceneMark[]): Rect[] => marks.flatMap((m) => (m.number !== null && m.operates ? [m.rect] : []));

export function sceneMarks(scene: Scene): SceneMark[] {
  const shot = scene.shot;
  if (!shot) return [];
  return [
    ...scene.steps.flatMap((s) => (s.mark ? [{ number: s.number, rect: s.mark, operates: s.operates }] : [])),
    ...scene.waits.flatMap((w) => (w.mark ? [{ number: null, rect: w.mark }] : [])),
  ];
}

/** lucide icons, drawn inline so the file stands alone (camera, split, repeat, clock, pencil). */
const ICONS = {
  camera:
    '<path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z"/><circle cx="12" cy="13" r="3"/>',
  split: '<path d="M16 3h5v5"/><path d="M8 3H3v5"/><path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3"/><path d="m15 9 6-6"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  window: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  bulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  pencil:
    '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
};
const icon = (name: keyof typeof ICONS) =>
  `<svg class="ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

const esc = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

function parts(list: Part[] | null): string {
  if (!list) return "";
  return list.map((p) => ("text" in p ? esc(p.text) : `<span class="v">${esc(p.code)}</span>`)).join("");
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image"));
    img.src = src;
  });
}

/**
 * The part of a picture the 手順書 shows, with blurred and blacked-out areas
 * and the numbered marks drawn in, as a JPEG data URL.
 */
export async function burnShot(
  src: string,
  shot: ManualShot,
  marks: SceneMark[],
  mask: Mask | undefined,
  blurFields: boolean,
): Promise<string> {
  const img = await loadImage(src);
  // Pictures may be taken at another scale than their reported size.
  const k = img.naturalWidth / shot.width || 1;
  const crop = cropOf(shot.width, shot.height, marks.map((m) => m.rect));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(crop.width * k);
  canvas.height = Math.round(crop.height * k);
  const ctx = canvas.getContext("2d");
  if (!ctx) return src;
  const draw = (r: Rect) => [r.x * k - crop.x * k, r.y * k - crop.y * k, r.width * k, r.height * k] as const;
  ctx.drawImage(img, crop.x * k, crop.y * k, crop.width * k, crop.height * k, 0, 0, canvas.width, canvas.height);
  const blur = (r: Rect) => {
    const [x, y, w, h] = draw(r);
    if (w <= 0 || h <= 0) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.filter = `blur(${Math.max(6, Math.round(8 * k))}px)`;
    ctx.drawImage(img, crop.x * k, crop.y * k, crop.width * k, crop.height * k, 0, 0, canvas.width, canvas.height);
    // Blur alone can leave large text readable: wash it out too.
    ctx.filter = "none";
    ctx.fillStyle = "rgba(225, 228, 232, 0.55)";
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  };
  // Blurs redraw from the picture, so they go first: a black box drawn
  // before an overlapping blur would come back uncovered.
  if (blurFields) for (const r of blurRegions(shot.regions, operated(marks))) blur(r);
  for (const box of mask?.boxes ?? []) if (box.kind !== "black") blur(box);
  for (const box of mask?.boxes ?? []) {
    if (box.kind !== "black") continue;
    const [x, y, w, h] = draw(box);
    ctx.fillStyle = "#16181b";
    ctx.fillRect(x, y, w, h);
  }
  const line = Math.max(2, Math.round(2.5 * k));
  for (const m of marks) {
    const [x, y, w, h] = draw(m.rect);
    const wait = m.number === null;
    const colour = wait ? "#475569" : "#0a6fa8";
    ctx.strokeStyle = colour;
    ctx.lineWidth = line;
    ctx.setLineDash(wait ? [6 * k, 4 * k] : []);
    ctx.strokeRect(x - 3 * k, y - 3 * k, w + 6 * k, h + 6 * k);
    ctx.setLineDash([]);
    const r = 11 * k;
    const cx = Math.max(r, x - 3 * k - r - 4 * k);
    const cy = y + h / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();
    ctx.lineWidth = 2 * k;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    if (wait) {
      // A small clock: what the flow waits to appear (or to go).
      ctx.lineWidth = 1.6 * k;
      ctx.beginPath();
      ctx.arc(cx, cy, 6 * k, 0, Math.PI * 2);
      ctx.moveTo(cx, cy - 3.5 * k);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + 2.8 * k, cy + 1.6 * k);
      ctx.stroke();
      continue;
    }
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 ${Math.round(12 * k)}px Inter, "Noto Sans JP", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(m.number), cx, cy + 0.5);
  }

  return canvas.toDataURL("image/jpeg", 0.85);
}

function note(kind: "check" | "caution" | "point", text: string): string {
  const [name, ic] = kind === "check" ? [t.manual.noteCheck, icon("clock")] : kind === "caution" ? [t.manual.noteCaution, icon("alert")] : [t.manual.notePoint, icon("bulb")];
  return `<div class="note ${kind}">${ic}<div><b>${esc(name)}</b>${esc(text)}</div></div>`;
}

function step(s: ManualStep): string {
  return `<li><span class="n">${s.number}</span><div class="t">${esc(s.text)}${s.how ? `<span class="how">${parts(s.how)}</span>` : ""}${
    s.note ? note("point", s.note) : ""
  }</div><span class="ok">${esc(t.manual.asExpected)}<i></i></span></li>`;
}

/** 「注意」 for the logins the steps enter, each once. */
function logins(steps: ManualStep[]): string {
  return [...new Set(steps.flatMap((s) => (s.login ? [s.login] : [])))].map((name) => note("caution", t.manual.loginCaution(name))).join("");
}

type Pictures = ReadonlyMap<Scene, string>;

function frameHead(item: Container, continued: boolean): string {
  const more = continued ? esc(t.manual.continued) : "";
  switch (item.kind) {
    case "branch":
      return `<div class="fh">${icon("split")}<span>${esc(item.label)}${more}</span>${
        item.taken === null ? "" : `<span class="took${item.taken ? "" : " not"}">${esc(item.taken ? t.manual.took : t.manual.notTaken)}</span>`
      }</div>`;
    case "loop":
      return `<div class="fh">${icon("repeat")}<span>${esc(item.label)}${more}</span>${item.times === null ? "" : `<small>${esc(t.manual.loopTimes(item.times))}</small>`}</div>`;
    case "group":
      return `<div class="fh"><span>${esc(item.label)}${more}</span></div>`;
  }
}

function leaf(item: Leaf, pictures: Pictures): string {
  switch (item.kind) {
    case "scene": {
      const src = pictures.get(item);
      const cap =
        esc(t.manual.screenOf(item.title, item.app === "desktop")) + (src && item.shot?.draft ? ` <span class="draft">${esc(t.manual.draft)}</span>` : "");
      const rows = [...item.steps, null]
        .map((s, i) => item.waits.filter((w) => w.at === i).map((w) => `<li class="w">${note("check", w.text)}</li>`).join("") + (s ? step(s) : ""))
        .join("");
      return `<section class="scene"><div class="cap">${icon("window")}${cap}</div>${src ? `<div class="shot"><img src="${src}" alt=""></div>` : ""}<ol class="steps">${rows}</ol>${logins(item.steps)}</section>`;
    }
    case "action":
      return `<ol class="steps">${step(item.step)}</ol>${logins([item.step])}`;
    case "stopped":
      return "";
    case "quiet":
      return `<p class="quiet"><b>${esc(t.manual.quiet)}</b>　${item.texts.map(esc).join("・")}</p>`;
  }
}

function node(n: PageNode, pictures: Pictures): string {
  if (n.kind === "item") return leaf(n.block.item, pictures);
  const item = n.label.item;
  const cls = item.kind === "branch" ? `frame if${item.taken === false ? " off" : ""}` : item.kind === "loop" ? "frame loop" : "frame";
  return `<div class="${cls}">${frameHead(item, n.label.continued)}<div class="fb">${n.children.map((c) => node(c, pictures)).join("")}</div></div>`;
}

/** The four colours of the swirl, as a thin band: the cover and the top of each sheet. */
const STRIPE = `<div class="stripe"><i></i><i></i><i></i><i></i></div>`;

const style = (madeWith: string) => `
@page{size:A4;margin:0}
:root{--navy:#0f3a66;--blue:#0a6fa8;--teal:#12a7b4;--teal-ink:#0b7680;--green:#3f9a5a;--orange:#f5872a;--red:#e8501f;--ink:#1b1d22;--sub:#50555e;--line:#e1e4e8}
*{box-sizing:border-box}
body{margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;background:#e6e8ec;color:var(--ink);font-family:"Segoe UI","Yu Gothic UI","Meiryo","Hiragino Sans","Noto Sans JP",sans-serif;font-size:14px;line-height:1.7}
.ic{display:inline-block;vertical-align:-2px;flex:none}
.sheet{position:relative;width:210mm;min-height:297mm;margin:24px auto;background:#fff;padding:15mm 16mm 20mm;box-shadow:0 1px 2px rgba(20,30,50,.08),0 8px 24px rgba(20,30,50,.08);break-after:page;overflow:hidden}
.stripe{display:flex;height:4px;position:absolute;top:0;left:0;right:0}
.stripe i{flex:1}.stripe i:nth-child(1){background:var(--teal)}.stripe i:nth-child(2){background:var(--blue)}.stripe i:nth-child(3){background:var(--green)}.stripe i:nth-child(4){background:var(--orange)}
.sheet>header{display:flex;justify-content:space-between;align-items:baseline;gap:16px;white-space:nowrap;border-bottom:1px solid var(--navy);padding-bottom:5px;margin-bottom:22px;font-size:11.5px;color:var(--sub)}
.sheet>header b{color:var(--navy);overflow:hidden;text-overflow:ellipsis}
.sheet>footer{position:absolute;left:16mm;right:16mm;bottom:9mm;display:flex;justify-content:space-between;font-size:10.5px;color:#8a8f98;border-top:1px solid var(--line);padding-top:5px}
.sheet>footer span:first-child{color:var(--navy)}
.kind{font-size:12px;font-weight:700;color:var(--navy);letter-spacing:.14em;margin:0}
h1{font-size:25px;line-height:1.4;margin:8px 0 14px;text-wrap:balance}
.docinfo{display:flex;flex-wrap:wrap;row-gap:8px;font-size:11px;color:#8a8f98;padding:8px 0;border-top:2px solid var(--navy);border-bottom:1px solid var(--line)}
.docinfo div{padding:0 20px;border-left:1px solid var(--line)}.docinfo div:first-child{padding-left:0;border-left:0}
.docinfo b{display:block;color:var(--ink);font-size:13px;font-weight:600}
.since{margin:8px 0 0;font-size:12px;color:var(--sub)}
.mast{margin-bottom:22px}
h3{display:flex;align-items:center;gap:8px;font-size:13.5px;color:var(--navy);margin:18px 0 6px}
h3:before{content:"";width:4px;height:14px;background:var(--navy)}
.lead{margin:0;color:#3a3e45;line-height:1.85}
table{width:100%;border-collapse:collapse}
.facts{font-size:13px}
.facts th{width:150px;text-align:left;font-weight:400;color:var(--sub);background:#f5f6f8;padding:6px 10px;border:1px solid var(--line)}
.facts td{padding:6px 10px;border:1px solid var(--line)}
.facts tr.in th{box-shadow:inset 3px 0 var(--teal)}
.facts tr.out th{box-shadow:inset 3px 0 var(--orange)}
.toc{list-style:none;margin:0;padding:0}
.toc li{display:flex;align-items:baseline;gap:10px;padding:3px 0;font-size:13.5px}
.toc .no{font-weight:700;width:18px;color:var(--navy)}
.toc a{color:inherit;text-decoration:none}
.toc .dots{flex:1;border-bottom:1px dotted #b9bec6;transform:translateY(-4px)}
.toc .pg{color:var(--sub);font-size:12.5px}
.rev{font-size:12px}
.rev th{background:#f5f6f8;font-weight:600;color:#3a3e45;text-align:left}
.rev th,.rev td{border:1px solid var(--line);padding:3px 8px}
.hint{display:flex;gap:6px;color:var(--sub);font-size:12px;margin:16px 0 0}
.hint .ic{margin-top:4px}
.privacy{color:#8a8f98;font-size:11px;margin-top:8px}
.draft{border:1px solid #c9ced6;border-radius:4px;padding:0 5px;font-size:11px;font-weight:400;color:var(--sub)}
h2{display:flex;align-items:center;gap:12px;font-size:19px;color:var(--navy);margin:0 0 4px;padding-bottom:8px;border-bottom:2px solid var(--navy)}
h2 .cn{font-size:12px;font-weight:600;color:#fff;background:var(--navy);border-radius:4px;padding:2px 8px}
.sub{margin:6px 0 16px;color:var(--sub);font-size:12.5px}
.cont{margin:0 0 14px;color:var(--sub);font-size:12.5px}
.scene{margin:0 0 16px;break-inside:avoid}
.cap{display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600;margin:14px 0 6px;color:#3a3e45}
.shot{border:1px solid #c9ced6;line-height:0}
.shot img{width:100%;max-height:150mm;object-fit:contain;object-position:left top;display:block}
.steps{list-style:none;margin:10px 0 0;padding:0}
.steps>li{display:grid;grid-template-columns:30px 1fr auto;gap:0 10px;padding:7px 0;border-bottom:1px solid var(--line);break-inside:avoid}
.steps>li:first-child{border-top:1px solid var(--line)}
.steps>li.w{display:block;padding:0;border:0}
.steps .n{width:26px;height:26px;border-radius:50%;background:var(--blue);color:#fff;font:700 13px/26px Inter,"Segoe UI",sans-serif;text-align:center}
.steps .t{font-weight:600;font-size:14.5px;min-width:0}
.steps .how{display:block;font-weight:400;color:var(--sub);font-size:12.5px}
.v{background:#e8f3fb;color:#0f3a66;border-radius:4px;padding:0 4px;font-weight:400}
.ok{display:flex;gap:6px;align-items:center;font-size:11.5px;color:var(--sub);align-self:start;padding-top:4px}
.ok i{width:14px;height:14px;border:1.5px solid #8a8f98;border-radius:2px}
.note{display:flex;gap:10px;margin:8px 0;padding:8px 12px;border-radius:4px;font-size:12.5px;font-weight:400;line-height:1.7;color:#3a3e45;border-left:3px solid;break-inside:avoid}
.note b{display:block;color:var(--ink);font-size:12.5px}
.note .ic{margin-top:4px}
.note.check{background:#eef8f1;border-color:var(--green)}.note.check .ic{color:var(--green)}
.note.caution{background:#fff3ec;border-color:var(--red)}.note.caution .ic{color:var(--red)}
.note.point{background:#e9f8f9;border-color:var(--teal)}.note.point .ic{color:var(--teal-ink)}
.frame{border:1px solid #c9ced6;border-radius:6px;margin:12px 0}
.frame>.fh{display:flex;align-items:center;gap:8px;padding:7px 14px;background:#f5f6f8;border-bottom:1px solid #c9ced6;border-radius:6px 6px 0 0;font-weight:600;font-size:13px}
.frame>.fh small{font-weight:400;color:var(--sub);margin-left:auto;font-size:12px}
.frame>.fb{padding:2px 14px 10px}
.frame.if{border-color:#e3c76a}.frame.if>.fh{background:#fffbea;border-color:#e3c76a}
.frame.loop{border-color:#b9cbe0}.frame.loop>.fh{background:#eef3f9;border-color:#b9cbe0;color:var(--navy)}
.frame.off>.fb{opacity:.7}
.took{font-weight:400;font-size:11.5px;color:#2f8a4c;border:1px solid #2f8a4c;border-radius:20px;padding:0 8px;background:#fff}
.took.not{border-color:#b9bec6;color:var(--sub)}
.quiet{font-size:12.5px;color:var(--sub);margin:10px 0}
.quiet b{color:#3a3e45;font-weight:600}
/* On paper the printer numbers the pages: a sheet with many steps may run onto a second page, and the count stays right. */
@media print{
@page{size:A4;margin:12mm 0 14mm;@bottom-left{content:${JSON.stringify(madeWith)};margin-left:16mm;font-size:8pt;color:#8a8f98}@bottom-right{content:counter(page) " / " counter(pages);margin-right:16mm;font-size:8pt;color:#8a8f98}}
body{background:#fff}.sheet{width:auto;min-height:0;margin:0;padding:0 16mm;box-shadow:none;overflow:visible}.sheet>footer,.toc .pg,.toc .dots,.sheet>.stripe{display:none}#p1{padding-top:0}}
`;

/** One HTML file of `doc`: the same A4 sheets ManualView shows. `pictures` holds each scene's burned picture. */
export function manualHtml(doc: ManualDoc, pictures: Pictures, options: ExportOptions): string {
  const shown: Pictures = options.noPictures ? new Map() : pictures;
  const pages = pagesOf(doc, !options.noPictures);
  const total = pages.length;
  const { edition } = options;
  const facts = overviewRows(doc, options.when).map((r) => [r.label, r.values, r.role === "input" ? "in" : r.role === "output" ? "out" : ""] as const);
  const rows = facts
    .map(([k, v, cls]) => `<tr${cls ? ` class="${cls}"` : ""}><th>${esc(k)}</th><td>${v.length > 0 ? v.map(esc).join("、") : esc(t.manual.none)}</td></tr>`)
    .join("");
  const firstPage = (n: number) => pages.find((p) => p.kind === "body" && p.chapter.number === n && p.first)?.number ?? "";
  const toc = doc.chapters
    .map(
      (c) =>
        `<li><span class="no">${c.number}</span><a href="#p${firstPage(c.number)}">${esc(c.title)}</a><span class="dots"></span><span class="pg">${firstPage(c.number)}</span></li>`,
    )
    .join("");
  const revisions =
    edition.revisions.length > 0
      ? `<h3>${esc(t.manual.revisions)}</h3><table class="rev"><tr><th style="width:84px">${esc(t.manual.edition)}</th><th style="width:120px">${esc(t.manual.revisionDate)}</th><th>${esc(t.manual.revisionText)}</th></tr>${edition.revisions
          .map((r) => `<tr><td>${esc(r.label)}</td><td>${esc(r.date)}</td><td>${esc(r.text)}</td></tr>`)
          .join("")}</table>`
      : "";
  const info = [
    [t.manual.edition, edition.label],
    ...(edition.updated ? [[t.manual.updated, edition.updated]] : []),
    [t.manual.shotAt, options.noPictures ? t.manual.shotNone : options.shotAt],
  ]
    .map(([k, v]) => `<div>${esc(k ?? "")}<b>${esc(v ?? "")}</b></div>`)
    .join("");
  const headRight = [edition.label, edition.updated].filter(Boolean).join("　");
  const foot = (n: number) => `<footer><span>${esc(t.manual.madeWith)}</span><span>${esc(t.manual.pageOf(n, total))}</span></footer>`;
  const sheets = pages.map((page) => {
    if (page.kind === "cover") {
      return `<section class="sheet" id="p1">
${STRIPE}<div class="mast"><p class="kind">${esc(t.manual.kind)}</p><h1>${esc(doc.title)}</h1><div class="docinfo">${info}</div>${
        edition.changedSince !== null ? `<p class="since">${esc(t.manual.changedSince(edition.changedSince))}</p>` : ""
      }</div>
${doc.description ? `<h3>${esc(t.manual.about)}</h3><p class="lead">${esc(doc.description)}</p>` : ""}
<h3>${esc(t.manual.overview)}</h3><table class="facts">${rows}</table>
<h3>${esc(t.manual.contents)}</h3><ol class="toc">${toc}</ol>
${revisions}
<p class="hint">${icon("pencil")}<span>${esc(t.manual.checkHint)}</span></p>
<p class="privacy">${esc(t.manual.footer(options.date))}</p>
${foot(page.number)}</section>`;
    }
    const c = page.chapter;
    const head = page.first
      ? `<h2><span class="cn">${c.number}</span>${esc(c.title)}</h2>${c.alongside.length > 0 ? `<p class="sub">${esc(t.manual.alongsideNote(c.alongside))}</p>` : `<div class="sub"></div>`}`
      : `<p class="cont">${c.number}. ${esc(c.title)}${esc(t.manual.continued)}</p>`;
    return `<section class="sheet" id="p${page.number}">${STRIPE}<header><b>${esc(doc.title)}</b><span>${esc(headRight)}</span></header>
${head}${frameTree(page.blocks)
      .map((n) => node(n, shown))
      .join("")}
${foot(page.number)}</section>`;
  });
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(doc.title)}</title><style>${style(t.manual.madeWith)}</style></head>
<body>
${sheets.join("\n")}
</body></html>`;
}

/** Every scene with a picture, in order. */
export function scenesOf(doc: ManualDoc): Scene[] {
  const walk = (list: ManualItem[]): Scene[] =>
    list.flatMap((i) => (i.kind === "scene" ? (i.shot ? [i] : []) : "items" in i ? walk(i.items) : []));
  return doc.chapters.flatMap((c) => walk(c.items));
}

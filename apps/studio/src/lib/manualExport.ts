// The 手順書 as one HTML file: the same outline ManualView shows, with the
// pictures cut to the marked part and what is hidden burned in, so the file
// can be opened, printed or turned into a PDF anywhere.
import { locale, t } from "./i18n";
import {
  blurRegions,
  type Container,
  cropOf,
  type Leaf,
  type ManualDoc,
  type ManualItem,
  type ManualShot,
  type ManualStep,
  type Mask,
  type PageBlock,
  pagesOf,
  type Rect,
  type Scene,
} from "./manual";
import type { Part } from "./sentence";

export type ExportOptions = {
  /** Blur table cells and input fields (the picture's `regions`). */
  blurFields: boolean;
  /** Words only. */
  noPictures: boolean;
  /** "11月8日 18:20 の実行…" or null. */
  made: string | null;
  /** The schedules of the flow, in words. */
  when: string[];
  date: string;
};

/** The numbered marks a scene puts on its picture. */
/** A place marked on a picture: a numbered operation, or (number null) what the flow waits for. */
export type SceneMark = { number: number | null; rect: Rect };

/** Where the numbered operations are: kept clear of the blur over values. */
export const operated = (marks: SceneMark[]): Rect[] => marks.flatMap((m) => (m.number === null ? [] : [m.rect]));

export function sceneMarks(scene: Scene): SceneMark[] {
  const shot = scene.shot;
  if (!shot) return [];
  return [
    ...scene.steps.flatMap((s) => (s.mark ? [{ number: s.number, rect: s.mark }] : [])),
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

function step(s: ManualStep): string {
  return `<li><span class="n">${s.number}</span><div class="t">${esc(s.text)}${s.how ? `<span class="how">${parts(s.how)}</span>` : ""}</div><span class="ok">${esc(t.manual.asExpected)}<i></i></span></li>`;
}

type Pictures = ReadonlyMap<Scene, string>;

function label(item: Container, continued: boolean): string {
  const more = continued ? esc(t.manual.continued) : "";
  switch (item.kind) {
    case "branch":
      return `<div class="cond${item.taken === false ? " off" : ""}">${icon("split")}${esc(item.label)}${more}${
        item.taken === null ? "" : `<span class="took${item.taken ? "" : " not"}">${esc(item.taken ? t.manual.took : t.manual.notTaken)}</span>`
      }</div>`;
    case "loop":
      return `<div class="lh">${icon("repeat")}${esc(item.label)}${more}${item.times === null ? "" : ` <span>${esc(t.manual.loopTimes(item.times))}</span>`}</div>`;
    case "group":
      return `<div class="gh">${esc(item.label)}${more}</div>`;
  }
}

function leaf(item: Leaf, pictures: Pictures): string {
  switch (item.kind) {
    case "scene": {
      const src = pictures.get(item);
      const cap =
        esc(t.manual.screenOf(item.title, item.app === "desktop")) + (src && item.shot?.draft ? ` <span class="draft">${esc(t.manual.draft)}</span>` : "");
      const rows = [...item.steps, null]
        .map((s, i) => item.waits.filter((w) => w.at === i).map((w) => `<li class="wait">${icon("clock")}${esc(w.text)}</li>`).join("") + (s ? step(s) : ""))
        .join("");
      return `<section class="scene"><div class="cap">${icon("camera")}${cap}</div>${src ? `<div class="shot"><img src="${src}" alt=""></div>` : ""}<ol class="steps">${rows}</ol></section>`;
    }
    case "action":
      return `<ol class="steps">${step(item.step)}</ol>`;
    case "quiet":
      return `<p class="quiet"><b>${esc(t.manual.quiet)}</b>　${item.texts.map(esc).join("・")}</p>`;
  }
}

function block(b: PageBlock, pictures: Pictures): string {
  const inner = b.kind === "label" ? label(b.item, b.continued) : leaf(b.item, pictures);
  return `<div class="blk${b.depth > 0 ? " in" : ""}" style="margin-left:${b.depth * 18}px">${inner}</div>`;
}

const style = (madeWith: string) => `
@page{size:A4;margin:0}
*{box-sizing:border-box}
body{margin:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;background:#e6e8ec;color:#1b1d22;font-family:"Segoe UI","Yu Gothic UI","Meiryo","Hiragino Sans","Noto Sans JP",sans-serif;font-size:14px;line-height:1.7}
.sheet{position:relative;width:210mm;min-height:297mm;margin:24px auto;background:#fff;padding:15mm 16mm 20mm;box-shadow:0 1px 2px rgba(20,30,50,.08),0 8px 24px rgba(20,30,50,.08);break-after:page}
.sheet>header{display:flex;justify-content:space-between;gap:16px;white-space:nowrap;border-bottom:1.5px solid #1b1d22;padding-bottom:5px;margin-bottom:18px;font-size:12px;color:#50555e}
.sheet>header b{color:#1b1d22;overflow:hidden;text-overflow:ellipsis}
.ic{display:inline-block;vertical-align:-2px;margin-right:6px;flex:none}
.sheet>footer{position:absolute;left:16mm;right:16mm;bottom:8mm;display:flex;justify-content:space-between;font-size:11px;color:#8a8f98}
.kicker{margin:40px 0 2px;color:#50555e;font-size:12.5px}
h1{font-size:26px;line-height:1.4;margin:0 0 6px}
.made{color:#50555e;font-size:12.5px;margin:0 0 20px}
.draft{border:1px solid #c9ced6;border-radius:4px;padding:0 5px;font-size:11px;font-weight:400;color:#50555e}
.lead{font-size:14.5px;line-height:1.85;color:#3a3e45;margin:0 0 20px}
dl{display:grid;grid-template-columns:120px 1fr;margin:0;border-top:1px solid #e1e4e8}
dt,dd{margin:0;padding:8px 0;border-bottom:1px solid #e1e4e8}
dt{color:#50555e}
h3{font-size:14px;margin:32px 0 6px}
.toc{list-style:none;padding:0;margin:0}
.toc li{display:flex;gap:12px;align-items:baseline;padding:7px 0;border-bottom:1px dotted #c9ced6}
.toc a{color:inherit;text-decoration:none}
.toc .pg{margin-left:auto;color:#50555e;font-size:12.5px}
.hint{color:#50555e;font-size:12.5px;margin:20px 0 0}
.n{display:inline-grid;place-items:center;flex:none;width:22px;height:22px;border-radius:5px;background:#1b1d22;color:#fff;font-size:12px;font-weight:700}
h2{display:flex;gap:12px;align-items:center;font-size:20px;margin:0 0 4px}
h2 .n{width:28px;height:28px;font-size:14px}
.sub{margin:0 0 14px 40px;color:#50555e;font-size:12.5px}
.cont{margin:0 0 14px;color:#50555e;font-size:12.5px}
.blk.in>*{border-left:2px solid #e1e4e8;padding-left:12px}
.scene{margin:0 0 18px}
.cap{font-size:12.5px;font-weight:600;margin:0 0 6px}
.shot{border:1px solid #c9ced6;line-height:0}
.shot img{width:100%;max-height:150mm;object-fit:contain;object-position:left top;display:block}
.steps{list-style:none;margin:8px 0 12px;padding:0;border-top:1px solid #e1e4e8}
.steps li{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid #e1e4e8;break-inside:avoid}
.steps .t{flex:1}
.steps .n{width:21px;height:21px;border-radius:20px;background:#0a6fa8;margin-top:2px}
.ok{display:flex;gap:6px;align-items:flex-start;flex:none;font-size:12px;color:#50555e;padding-top:3px}
.ok i{display:inline-block;width:14px;height:14px;border:1.5px solid #8a8f98;border-radius:2px;margin-top:2px}
.steps li.wait{color:#50555e;font-size:12.5px;padding:5px 0}
.how{display:block;color:#50555e;font-size:12.5px}
.v{background:#e8f3fb;color:#0f3a66;border-radius:4px;padding:0 4px}
.cond{display:inline-flex;gap:8px;align-items:center;margin:2px 0 10px;font-size:13px;background:#fff6d1;border:1px solid #d4a514;color:#5c4500;border-radius:6px;padding:3px 10px}
.cond .ic{margin-right:0}
.cond.off{opacity:.7}
.took{background:#fff;border:1px solid #2f8a4c;color:#2f8a4c;border-radius:20px;padding:0 8px;font-size:11.5px}
.took.not{border-color:#b9bec6;color:#50555e}
.lh,.gh{font-weight:600;margin:0 0 10px}
.lh span{font-weight:400;color:#50555e;font-size:12.5px}
.quiet{color:#50555e;font-size:13px;margin:0 0 12px}
.quiet b{color:#3a3e45}
.privacy{color:#8a8f98;font-size:11.5px;margin-top:28px}
/* On paper the printer numbers the pages: a sheet with many steps may run onto a second page, and the count stays right. */
@media print{
@page{size:A4;margin:12mm 0 14mm;@bottom-left{content:${JSON.stringify(madeWith)};margin-left:16mm;font-size:8pt;color:#8a8f98}@bottom-right{content:counter(page) " / " counter(pages);margin-right:16mm;font-size:8pt;color:#8a8f98}}
body{background:#fff}.sheet{width:auto;min-height:0;margin:0;padding:0 16mm;box-shadow:none}.sheet>footer,.toc .pg{display:none}}
`;

/** One HTML file of `doc`: the same A4 sheets ManualView shows. `pictures` holds each scene's burned picture. */
export function manualHtml(doc: ManualDoc, pictures: Pictures, options: ExportOptions): string {
  const shown: Pictures = options.noPictures ? new Map() : pictures;
  const pages = pagesOf(doc, !options.noPictures);
  const total = pages.length;
  const facts: [string, string[]][] = [
    [t.manual.uses, doc.uses],
    [t.manual.inputs, doc.inputs],
    [t.manual.outputs, doc.outputs],
    [t.manual.runsWhen, [...options.when, t.manual.byHand]],
  ];
  const dl = facts
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v.length > 0 ? v.map(esc).join("、") : esc(t.manual.none)}</dd>`)
    .join("");
  const firstPage = (n: number) => pages.find((p) => p.kind === "body" && p.chapter.number === n && p.first)?.number ?? "";
  const toc = doc.chapters
    .map((c) => `<li><span class="n">${c.number}</span><a href="#p${firstPage(c.number)}">${esc(c.title)}</a><span class="pg">${firstPage(c.number)}</span></li>`)
    .join("");
  const made = options.made ?? (doc.drafts > 0 && !options.noPictures ? t.manual.draftsOnly : null);
  const foot = (n: number) => `<footer><span>${esc(t.manual.madeWith)}</span><span>${esc(t.manual.pageOf(n, total))}</span></footer>`;
  const sheets = pages.map((page) => {
    if (page.kind === "cover") {
      return `<section class="sheet" id="p1">
<p class="kicker">${esc(t.manual.title)}</p>
<h1>${esc(doc.title)}</h1>
${made ? `<p class="made">${esc(made)}</p>` : ""}
${doc.description ? `<p class="lead">${esc(doc.description)}</p>` : ""}
<dl>${dl}</dl>
<h3>${esc(t.manual.contents)}</h3>
<ol class="toc">${toc}</ol>
<p class="hint">${icon("pencil")}${esc(t.manual.checkHint)}</p>
<p class="privacy">${esc(t.manual.footer(options.date))}</p>
${foot(page.number)}</section>`;
    }
    const c = page.chapter;
    const head = page.first
      ? `<h2><span class="n">${c.number}</span>${esc(c.title)}</h2>${c.alongside.length > 0 ? `<p class="sub">${esc(t.manual.alongsideNote(c.alongside))}</p>` : `<div class="sub"></div>`}`
      : `<p class="cont">${c.number}. ${esc(c.title)}${esc(t.manual.continued)}</p>`;
    return `<section class="sheet" id="p${page.number}"><header><b>${esc(doc.title)}</b>${options.made ? `<span>${esc(options.made)}</span>` : ""}</header>
${head}${page.blocks.map((b) => block(b, shown)).join("")}
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

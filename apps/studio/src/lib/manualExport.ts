// The 手順書 as one HTML file: the same outline ManualView shows, with the
// pictures cut to the marked part and what is hidden burned in, so the file
// can be opened, printed or turned into a PDF anywhere.
import { locale, t } from "./i18n";
import { type Chapter, cropOf, type ManualDoc, type ManualItem, type ManualShot, type ManualStep, type Mask, type Rect, type Scene } from "./manual";
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

export function sceneMarks(scene: Scene): SceneMark[] {
  const shot = scene.shot;
  if (!shot) return [];
  return [
    ...scene.steps.flatMap((s) => (s.mark ? [{ number: s.number, rect: s.mark }] : [])),
    ...scene.waits.flatMap((w) => (w.mark ? [{ number: null, rect: w.mark }] : [])),
  ];
}

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
  if (blurFields) for (const r of shot.regions ?? []) blur(r);
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
  return `<li><span class="n">${s.number}</span><div>${esc(s.text)}${s.how ? `<span class="how">${parts(s.how)}</span>` : ""}</div></li>`;
}

type Pictures = ReadonlyMap<Scene, string>;

function items(list: ManualItem[], pictures: Pictures): string {
  return list
    .map((item) => {
      switch (item.kind) {
        case "scene": {
          const src = pictures.get(item);
          const cap =
            esc(t.manual.screenOf(item.title, item.app === "desktop")) + (src && item.shot?.draft ? ` <span class="draft">${esc(t.manual.draft)}</span>` : "");
          return `<section class="scene"><div class="cap">${cap}</div><div class="body${src ? "" : " words"}">${
            src ? `<div class="shot"><img src="${src}" alt=""></div>` : ""
          }<ol class="steps">${[...item.steps, null].map((s, i) => item.waits.filter((w) => w.at === i).map((w) => `<li class="wait">⏱ ${esc(w.text)}</li>`).join("") + (s ? step(s) : "")).join("")}</ol></div></section>`;
        }
        case "action":
          return `<ol class="steps loose">${step(item.step)}</ol>`;
        case "quiet":
          return `<p class="quiet"><b>${esc(t.manual.quiet)}</b>　${item.texts.map(esc).join("・")}</p>`;
        case "branch":
          return `<div class="cond">◆ ${esc(item.label)}${item.taken === null ? "" : `<span class="took${item.taken ? "" : " not"}">${esc(item.taken ? t.manual.took : t.manual.notTaken)}</span>`}</div><div class="inner">${items(item.items, pictures)}</div>`;
        case "loop":
          return `<div class="loop"><div class="lh">↻ ${esc(item.label)}${item.times === null ? "" : ` <span>${esc(t.manual.loopTimes(item.times))}</span>`}</div>${items(item.items, pictures)}</div>`;
        case "group":
          return `<div class="group"><div class="gh">${esc(item.label)}</div>${items(item.items, pictures)}</div>`;
      }
    })
    .join("");
}

function chapter(c: Chapter, pictures: Pictures): string {
  const note = c.alongside.length > 0 ? `<p class="sub">${esc(t.manual.alongsideNote(c.alongside))}</p>` : "";
  return `<h2 id="c${c.number}"><span class="n">${c.number}</span>${esc(c.title)}</h2>${note}<div class="chapter">${items(c.items, pictures)}</div>`;
}

const STYLE = `
*{box-sizing:border-box}
body{margin:0;background:#eceef1;color:#1b1d22;font-family:"Segoe UI","Yu Gothic UI","Meiryo","Hiragino Sans","Noto Sans JP",sans-serif;font-size:14px;line-height:1.7}
article{max-width:940px;margin:24px auto;background:#fff;border:1px solid #e1e4e8;border-radius:8px;padding:36px 44px 40px}
h1{font-size:24px;margin:0 0 4px}
.made{color:#50555e;font-size:12.5px;margin:0 0 18px}
.draft{border:1px solid #c9ced6;border-radius:4px;padding:0 5px;font-size:11px;font-weight:400;color:#50555e}
.lead{font-size:15px;color:#3a3e45;margin:0 0 16px}
dl{display:grid;grid-template-columns:120px 1fr;margin:0;border-top:1px solid #e1e4e8}
dt,dd{margin:0;padding:8px 0;border-bottom:1px solid #e1e4e8}
dt{color:#50555e}
.toc{list-style:none;padding:0;margin:22px 0 0}
.toc li{display:flex;gap:10px;padding:4px 0}
.toc a{color:inherit;text-decoration:none}
.n{display:inline-grid;place-items:center;flex:none;width:22px;height:22px;border-radius:5px;background:#1b1d22;color:#fff;font-size:12px;font-weight:700}
h2{display:flex;gap:10px;align-items:center;font-size:19px;margin:36px 0 4px;break-after:avoid}
h2 .n{width:28px;height:28px;font-size:14px}
.sub{margin:0 0 10px 38px;color:#50555e;font-size:13px}
.chapter{margin-left:38px}
.scene{border:1px solid #e1e4e8;border-radius:8px;overflow:hidden;margin:0 0 14px;break-inside:avoid}
.cap{padding:7px 12px;border-bottom:1px solid #e1e4e8;background:#f4f5f7;font-size:12.5px;color:#3a3e45;font-weight:600}
.body{display:grid;grid-template-columns:1.45fr 1fr}
.body.words{display:block}
.shot{border-right:1px solid #e1e4e8;line-height:0}
.shot img{width:100%;display:block}
.steps{list-style:none;margin:0;padding:8px 14px}
.steps li{display:flex;gap:10px;padding:7px 0;border-bottom:1px dashed #e1e4e8}
.steps li:last-child{border-bottom:0}
.steps .n{width:21px;height:21px;border-radius:20px;background:#0a6fa8;margin-top:2px}
.steps.loose{padding:0 0 6px}
.steps li.wait{color:#50555e;font-size:12.5px;padding:4px 0;border:0}
.how{display:block;color:#50555e;font-size:12.5px}
.v{background:#e8f3fb;color:#0f3a66;border-radius:4px;padding:0 4px}
.cond{display:inline-flex;gap:8px;align-items:center;margin:2px 0 10px;font-size:13px;background:#fff6d1;border:1px solid #d4a514;color:#5c4500;border-radius:6px;padding:3px 10px}
.took{background:#fff;border:1px solid #2f8a4c;color:#2f8a4c;border-radius:20px;padding:0 8px;font-size:11.5px}
.took.not{border-color:#b9bec6;color:#50555e}
.inner{margin:0 0 6px}
.loop{border-left:3px solid #b9bec6;padding:2px 0 2px 16px;margin:0 0 14px}
.lh{font-weight:600;margin-bottom:8px}
.lh span{font-weight:400;color:#50555e;font-size:12.5px}
.group{margin:0 0 12px}
.gh{font-weight:600;margin:6px 0}
.quiet{color:#50555e;font-size:13px;margin:0 0 12px}
.quiet b{color:#3a3e45}
footer{max-width:940px;margin:0 auto 24px;color:#6b7079;font-size:12px;text-align:right}
@media print{body{background:#fff}article{border:0;margin:0;padding:0}footer{margin:12px 0}}
`;

/** One HTML file of `doc`. `images` holds each scene's burned picture. */
export function manualHtml(doc: ManualDoc, pictures: Pictures, options: ExportOptions): string {
  const facts: [string, string[]][] = [
    [t.manual.uses, doc.uses],
    [t.manual.inputs, doc.inputs],
    [t.manual.outputs, doc.outputs],
    [t.manual.runsWhen, [...options.when, t.manual.byHand]],
  ];
  const dl = facts
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v.length > 0 ? v.map(esc).join("、") : esc(t.manual.none)}</dd>`)
    .join("");
  const toc = doc.chapters
    .map((c) => `<li><span class="n">${c.number}</span><a href="#c${c.number}">${esc(c.title)}</a></li>`)
    .join("");
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(doc.title)}</title><style>${STYLE}</style></head>
<body><article>
<h1>${esc(doc.title)}</h1>
${options.made ? `<p class="made">${esc(options.made)}</p>` : doc.drafts > 0 && !options.noPictures ? `<p class="made">${esc(t.manual.draftsOnly)}</p>` : ""}
${doc.description ? `<p class="lead">${esc(doc.description)}</p>` : ""}
<dl>${dl}</dl>
<ol class="toc">${toc}</ol>
${doc.chapters.map((c) => chapter(c, options.noPictures ? new Map() : pictures)).join("\n")}
</article><footer>${esc(t.manual.footer(options.date))}</footer></body></html>`;
}

/** Every scene with a picture, in order. */
export function scenesOf(doc: ManualDoc): Scene[] {
  const walk = (list: ManualItem[]): Scene[] =>
    list.flatMap((i) => (i.kind === "scene" ? (i.shot ? [i] : []) : "items" in i ? walk(i.items) : []));
  return doc.chapters.flatMap((c) => walk(c.items));
}

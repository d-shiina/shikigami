// Makes the handwriting pictures of the OCR benchmark: a delivery slip and
// a phone memo filled in by hand, in five handwriting-style fonts, each
// character a little turned, moved and resized as a hand writes it, as a
// scan and as a phone photo (cream paper, uneven light, a slight tilt,
// blur, JPEG). The printed labels are not measured; only what is written.
//
//   NODE_PATH=$(npm root -g) node crates/shikigami-desktop/tests/ocr-bench/make-hand.mjs
//
// Fonts are a stand-in for handwriting: real hands vary far more. The real
// handwriting sample (daiki-styles.png) is kept beside these and listed in
// truth.json by hand; this script leaves it as it is.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../fixtures/ocr-hand");
mkdirSync(out, { recursive: true });

// Google Fonts with Japanese handwriting styles.
const FONTS = {
  yomogi: "Yomogi", // casual pen
  kurenaido: "Zen Kurenaido", // felt-tip
  klee: "Klee One", // pencil, neat
  hachimaru: "Hachi Maru Pop", // round
  yusei: "Yusei Magic", // marker
};
const RENDERS = ["scan", "photo"];

// What is written: [label, text]. Labels are printed and not measured.
const SLIP = [
  ["日付", "2026年11月8日"],
  ["お名前", "山田 太郎"],
  ["ご住所", "東京都千代田区丸の内1-2-3"],
  ["電話番号", "03-1234-5678"],
  ["品名", "コピー用紙 A4 5箱"],
  ["金額", "12,800円"],
  ["備考", "午前中に届けてください"],
];
const MEMO = ["佐藤様より電話あり", "見積書の件で折り返しお願いします", "携帯 090-8765-4321", "15時までに連絡"];

// The same jitter on every run.
let seed = 1;
const random = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};
const jitter = (amount) => (random() * 2 - 1) * amount;

// A text written by hand: each character its own span, turned, moved and
// sized a little. The whole is one measured text.
const hand = (text) => {
  const chars = [...text]
    .map((c) => {
      if (c === " ") return `<span style="display:inline-block;width:0.45em"></span>`;
      const style = `display:inline-block;transform:translate(${jitter(0.04).toFixed(3)}em,${jitter(0.06).toFixed(3)}em) rotate(${jitter(5).toFixed(1)}deg) scale(${(1 + jitter(0.08)).toFixed(3)});margin-right:${jitter(0.04).toFixed(3)}em`;
      return `<span style="${style}">${c}</span>`;
    })
    .join("");
  return `<span class="t" data-text="${text}">${chars}</span>`;
};

const page = (font, render) => {
  const photo = render === "photo";
  const rows = SLIP.map(([label, text]) => `<div class="label">${label}</div><div class="value">${hand(text)}</div>`).join("");
  const memo = MEMO.map((m) => `<div class="memo-line">${hand(m)}</div>`).join("");
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(FONTS[font])}&family=Noto+Sans+JP:wght@400;700&display=block">
<style>
  html, body { margin: 0; }
  body { background: ${photo ? "#5b5348" : "#ffffff"}; padding: 24px; width: max-content; }
  .paper { background: ${photo ? "#f6f1e3" : "#ffffff"}; color: #1b1b1b; padding: 28px 36px; position: relative; overflow: hidden;
    transform: rotate(${photo ? "-1.6deg" : "0.5deg"}); transform-origin: 50% 50%; ${photo ? "filter: blur(0.6px);" : ""} }
  .paper::after { content: ""; position: absolute; inset: 0; pointer-events: none;
    background: ${photo ? "radial-gradient(ellipse at 20% 15%, rgba(255,255,255,0.25), rgba(0,0,0,0) 45%), linear-gradient(115deg, rgba(0,0,0,0) 55%, rgba(60,45,20,0.22))" : "none"}; }
  h1 { font-family: "Noto Sans JP"; font-size: 22px; letter-spacing: 0.3em; margin: 0 0 14px; text-align: center; }
  .slip { display: grid; grid-template-columns: 7em 26em; border: 1.5px solid #333; font-family: "Noto Sans JP"; }
  .label { font-size: 13px; padding: 10px 8px; border-right: 1px solid #333; border-bottom: 1px solid #999; background: ${photo ? "rgba(0,0,0,0.04)" : "#f5f5f5"}; }
  .value { padding: 4px 12px; border-bottom: 1px solid #999; font-family: "${FONTS[font]}"; font-size: 26px; color: #1a2340; }
  .memo { margin-top: 26px; border-top: 2px dashed #888; padding-top: 12px; }
  .memo-title { font-family: "Noto Sans JP"; font-size: 13px; color: #555; }
  .memo-line { font-family: "${FONTS[font]}"; font-size: 28px; color: #222; line-height: 1.7; border-bottom: 1px solid #b8c4d8; }
</style></head><body><div class="paper">
  <h1>納品伝票</h1>
  <div class="slip">${rows}</div>
  <div class="memo"><div class="memo-title">伝言メモ</div>${memo}</div>
</div></body></html>`;
};

// A phone photo: JPEG at quality 0.55.
function jpeg(png) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const j = new Image();
      j.onload = () => {
        ctx.drawImage(j, 0, 0);
        resolve(c.toDataURL("image/png").split(",")[1]);
      };
      j.src = c.toDataURL("image/jpeg", 0.55);
    };
    img.src = `data:image/png;base64,${png}`;
  });
}

const truthPath = join(out, "truth.json");
const truth = existsSync(truthPath) ? JSON.parse(readFileSync(truthPath, "utf8")) : {};
const browser = await chromium.launch();
const context = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 1400, height: 1400 } });
const pg = await context.newPage();
for (const font of Object.keys(FONTS)) {
  for (const render of RENDERS) {
    const name = `hand-${font}-${render}`;
    await pg.setContent(page(font, render), { waitUntil: "networkidle" });
    await pg.evaluate(() => document.fonts.ready);
    const items = await pg.$$eval(".t", (spans) =>
      spans.map((s) => {
        const r = s.getBoundingClientRect();
        return { text: s.dataset.text, x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
      }),
    );
    const box = await (await pg.$("body")).boundingBox();
    const clip = { x: 0, y: 0, width: Math.ceil(box.width), height: Math.ceil(box.height) };
    let png = await pg.screenshot({ clip });
    if (render === "photo") png = Buffer.from(await pg.evaluate(jpeg, png.toString("base64")), "base64");
    writeFileSync(join(out, `${name}.png`), png);
    truth[name] = items;
    console.log(name, items.length, "texts");
  }
}
const sorted = Object.fromEntries(Object.keys(truth).sort().map((k) => [k, truth[k]]));
writeFileSync(truthPath, `${JSON.stringify(sorted, null, 1)}\n`);
await browser.close();

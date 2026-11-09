// Makes the OCR benchmark pictures: Japanese business screens (a
// spreadsheet, a browser form, an invoice rendered from PDF) at 9–14 pt, in
// light and dark. Each picture comes with the text it shows and where
// (truth.json), so `cargo test -p spellsheet-desktop ocr_bench` can measure
// how many characters OCR reads correctly.
//
//   NODE_PATH=$(npm root -g) node crates/spellsheet-desktop/tests/ocr-bench/make.mjs
//
// Needs Playwright's Chromium and the network for the web fonts (Noto Sans
// JP / Noto Serif JP, close to Yu Gothic and the Mincho of printed forms);
// the spreadsheet uses IPA P Gothic (fonts-ipafont-gothic), close to MS P
// Gothic. The pictures are committed, so this runs only to change them.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// Playwright from anywhere require() finds it (NODE_PATH works too).
const { chromium } = createRequire(import.meta.url)("playwright");

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../fixtures/ocr-bench");
mkdirSync(out, { recursive: true });

// Points at 96 DPI (100 % scaling): 9 pt is Windows' own UI text.
const SIZES = [9, 10.5, 12, 14];
const THEMES = {
  light: { bg: "#ffffff", panel: "#f3f3f3", text: "#1f1f1f", sub: "#5f5f5f", line: "#d4d4d4", accent: "#0f6cbd", head: "#f0f0f0", input: "#ffffff", error: "#c42b1c", hint: "#767676" },
  dark: { bg: "#1f1f1f", panel: "#2b2b2b", text: "#e8e8e8", sub: "#b0b0b0", line: "#454545", accent: "#4cc2ff", head: "#2d2d2d", input: "#262626", error: "#ff99a4", hint: "#9a9a9a" },
};

const t = (s, cls = "") => `<span class="t ${cls}">${s}</span>`;

const sheetRows = [
  ["No.", "受注日", "顧客コード", "顧客名", "品名", "数量", "単価", "金額"],
  ["1", "2026/11/01", "C-00128", "株式会社サンプル商事", "A4コピー用紙", "20", "¥450", "¥9,000"],
  ["2", "2026/11/02", "C-00341", "山田電機工業株式会社", "トナーカートリッジ（黒）", "3", "¥12,800", "¥38,400"],
  ["3", "2026/11/04", "C-01057", "有限会社みどり食品", "ボールペン 0.5mm", "120", "¥88", "¥10,560"],
  ["4", "2026/11/05", "C-00128", "株式会社サンプル商事", "クリアファイル A4", "500", "¥22", "¥11,000"],
  ["5", "2026/11/06", "C-02210", "東京ロジスティクス㈱", "段ボール箱 120サイズ", "45", "¥310", "¥13,950"],
  ["6", "2026/11/07", "C-00873", "北海道フーズ合同会社", "電卓 12桁", "8", "¥2,480", "¥19,840"],
  ["", "", "", "", "", "", "合計", "¥102,750"],
];

function sheet() {
  const cols = ["A", "B", "C", "D", "E", "F", "G", "H"];
  const right = new Set([5, 6, 7]);
  const head = `<tr><th class="corner"></th>${cols.map((c) => `<th>${t(c)}</th>`).join("")}</tr>`;
  const body = sheetRows
    .map(
      (row, r) =>
        `<tr><th class="rown">${t(String(r + 1))}</th>${row
          .map((v, c) => `<td class="${right.has(c) && r > 0 ? "num" : ""}${r === 0 ? " hdr" : ""}">${v ? t(v) : ""}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  return `
  <div class="ribbon">${["ファイル", "ホーム", "挿入", "ページ レイアウト", "数式", "データ", "校閲", "表示", "ヘルプ"].map((x) => t(x)).join("")}</div>
  <div class="fbar"><span class="name">${t("H9")}</span><span class="fx">${t("=SUM(H3:H8)")}</span></div>
  <table class="grid">${head}${body}</table>
  <div class="tabs">${t("受注一覧", "on")}${t("顧客マスタ")}${t("集計")}</div>
  <div class="status">${t("準備完了")}${t("平均: ¥17,125　データの個数: 6　合計: ¥102,750")}</div>`;
}

function form() {
  const field = (label, value, opts = {}) => `
    <div class="row"><label>${t(label)}${opts.req ? t("必須", "req") : ""}</label>
    <div class="input ${opts.hint ? "hint" : ""}">${t(value)}</div>
    ${opts.error ? `<div class="err">${t(opts.error)}</div>` : ""}</div>`;
  return `
  <div class="nav">${t("受発注管理システム", "brand")}${t("ホーム")}${t("受注登録", "cur")}${t("出荷指示")}${t("請求")}${t("マスタ管理")}<span class="user">${t("山田 太郎 さん")}</span></div>
  <div class="page">
    <div class="crumb">${t("ホーム ＞ 受注 ＞ 新規登録")}</div>
    <h1>${t("受注登録")}</h1>
    ${field("受注番号", "SO-2026-004817")}
    ${field("顧客名", "株式会社サンプル商事", { req: true })}
    ${field("担当者メール", "taro.yamada@example.co.jp")}
    ${field("電話番号", "03-1234-5678")}
    ${field("納品先住所", "東京都千代田区丸の内1丁目2番3号 サンプルビル8階")}
    ${field("希望納期", "2026年11月20日（金）")}
    ${field("備考", "午前中着でお願いします", { hint: true })}
    ${field("郵便番号", "100-000", { error: "郵便番号は7桁で入力してください" })}
    <div class="buttons">${t("一時保存", "btn")}${t("確認画面へ", "btn primary")}${t("キャンセル", "btn")}</div>
  </div>`;
}

function invoice() {
  const items = [
    ["業務用プリンター保守契約（年額）", "1", "式", "180,000", "180,000"],
    ["トナーカートリッジ TN-6200（黒）", "4", "個", "12,800", "51,200"],
    ["出張設置作業費", "2", "回", "15,000", "30,000"],
    ["コピー用紙 A4 2,500枚入", "10", "箱", "3,480", "34,800"],
  ];
  return `
  <div class="doc">
    <div class="title">${t("請　求　書")}</div>
    <div class="meta">${t("請求書番号：INV-2026-001234")}${t("発行日：2026年11月7日")}</div>
    <div class="to">${t("株式会社サンプル商事　御中")}</div>
    <div class="from">${t("株式会社シキ情報サービス")}${t("〒530-0001 大阪府大阪市北区梅田3-4-5")}${t("TEL 06-6123-4567　登録番号 T1234567890123")}</div>
    <div class="lead">${t("下記のとおりご請求申し上げます。")}</div>
    <div class="total">${t("ご請求金額")}${t("¥325,600-", "big")}${t("（税込）")}</div>
    <table class="items"><tr>${["品名", "数量", "単位", "単価", "金額"].map((h) => `<th>${t(h)}</th>`).join("")}</tr>
      ${items.map((r) => `<tr>${r.map((v, i) => `<td class="${i === 0 ? "" : i === 2 ? "c" : "num"}">${t(v)}</td>`).join("")}</tr>`).join("")}
      <tr><td colspan="4" class="num">${t("小計")}</td><td class="num">${t("296,000")}</td></tr>
      <tr><td colspan="4" class="num">${t("消費税（10%）")}</td><td class="num">${t("29,600")}</td></tr>
    </table>
    <div class="bank">${t("お振込先：みずなみ銀行 本店営業部 普通 1234567")}${t("お支払期限：2026年11月30日")}</div>
    <div class="note">${t("※振込手数料は貴社にてご負担くださいますようお願いいたします。")}</div>
  </div>`;
}

// A Windows message box: several lines of message close together (one
// span per line, as the dialog wraps it), the way dialogs are captured.
function dialog() {
  const lines = [
    "受注データの取り込み中にエラーが発生しました。",
    "ファイル「受注一覧_20261107.xlsx」の 12 行目に",
    "未登録の顧客コード（C-09912）があります。",
    "顧客マスタに登録してから、もう一度実行してください。",
  ];
  const detail = ["エラー番号：E-2041", "発生日時：2026/11/07 14:03:22"];
  return `
  <div class="win">
    <div class="titlebar">${t("受発注管理システム")}<span class="x">✕</span></div>
    <div class="body">
      <div class="icon">!</div>
      <div class="msg">${lines.map((l) => `<div>${t(l)}</div>`).join("")}
        <div class="detail">${detail.map((l) => `<div>${t(l)}</div>`).join("")}</div>
      </div>
    </div>
    <div class="foot">${t("詳細を表示", "link")}<span class="sp"></span>${t("再試行", "btn primary")}${t("キャンセル", "btn")}</div>
  </div>
  <div class="win confirm">
    <div class="titlebar">${t("確認")}<span class="x">✕</span></div>
    <div class="body"><div class="icon q">?</div><div class="msg">
      <div>${t("変更内容が保存されていません。")}</div>
      <div>${t("保存してから閉じますか？")}</div></div></div>
    <div class="foot"><span class="sp"></span>${t("保存する", "btn primary")}${t("保存しない", "btn")}${t("キャンセル", "btn")}</div>
  </div>`;
}

const SCREENS = { sheet, form, invoice, dialog };

function page(kind, pt, theme) {
  const c = THEMES[theme];
  const fs = (pt * 96) / 72;
  const css = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: ${c.bg}; color: ${c.text}; font-size: ${fs}px; line-height: 1.5; width: max-content; padding: 8px; }
  .t { white-space: pre; }
  /* spreadsheet */
  .sheet { font-family: "IPAPGothic"; }
  .ribbon { background: ${c.panel}; padding: 4px 6px; display: flex; gap: 1.4em; color: ${c.text}; }
  .fbar { display: flex; gap: 8px; padding: 3px 6px; border-bottom: 1px solid ${c.line}; }
  .fbar .name { width: 5em; border-right: 1px solid ${c.line}; }
  table.grid { border-collapse: collapse; }
  .grid th { background: ${c.head}; color: ${c.sub}; font-weight: normal; border: 1px solid ${c.line}; padding: 0 6px; }
  .grid td { border: 1px solid ${c.line}; padding: 1px 6px; white-space: nowrap; }
  .grid td.num { text-align: right; }
  .grid td.hdr { font-weight: bold; }
  .tabs { display: flex; gap: 0; border-top: 1px solid ${c.line}; margin-top: 6px; }
  .tabs .t { padding: 2px 14px; border-right: 1px solid ${c.line}; }
  .tabs .on { color: ${c.accent}; font-weight: bold; }
  .status { display: flex; justify-content: space-between; gap: 40px; background: ${c.panel}; padding: 2px 6px; color: ${c.sub}; }
  /* browser form */
  .form { font-family: "Noto Sans JP"; width: 46em; }
  .nav { display: flex; gap: 1.6em; align-items: center; background: ${theme === "light" ? "#20304a" : "#111827"}; color: #f2f4f8; padding: 8px 14px; }
  .nav .brand { font-weight: bold; }
  .nav .cur { border-bottom: 2px solid #7cc4ff; }
  .nav .user { margin-left: auto; }
  .page { padding: 12px 18px; }
  .crumb { color: ${c.sub}; }
  h1 { font-size: 1.5em; font-weight: bold; margin: 4px 0 10px; }
  .row { display: grid; grid-template-columns: 9em 1fr; align-items: center; gap: 4px 12px; margin-bottom: 8px; }
  label { display: flex; gap: 6px; align-items: center; }
  .req { background: ${c.error}; color: ${theme === "light" ? "#fff" : "#1f1f1f"}; font-size: 0.8em; padding: 0 4px; border-radius: 3px; }
  .input { border: 1px solid ${c.line}; background: ${c.input}; border-radius: 4px; padding: 3px 8px; }
  .input.hint { color: ${c.hint}; }
  .err { grid-column: 2; color: ${c.error}; font-size: 0.9em; }
  .buttons { display: flex; gap: 10px; margin-top: 12px; }
  .btn { border: 1px solid ${c.line}; border-radius: 4px; padding: 4px 16px; }
  .btn.primary { background: ${c.accent}; color: ${theme === "light" ? "#fff" : "#0b1a26"}; border-color: ${c.accent}; }
  /* dialog (Windows 11 message box: Yu Gothic UI is close to Noto Sans JP) */
  .dialog { font-family: "Noto Sans JP"; display: flex; flex-direction: column; gap: 16px; width: max-content; }
  .win { background: ${c.bg}; border: 1px solid ${c.line}; box-shadow: 0 4px 16px rgba(0,0,0,.25); width: max-content; }
  .titlebar { display: flex; justify-content: space-between; padding: 6px 10px; background: ${c.panel}; }
  .titlebar .x { color: ${c.sub}; padding-left: 40px; }
  .body { display: flex; gap: 14px; padding: 16px 20px 18px; line-height: 1.35; }
  .icon { width: 2.2em; height: 2.2em; border-radius: 50%; background: #f7b500; color: #000; text-align: center; font-weight: bold; line-height: 2.2em; flex: none; }
  .icon.q { background: ${c.accent}; color: #fff; }
  .detail { margin-top: 8px; color: ${c.sub}; }
  .foot { display: flex; gap: 8px; align-items: center; padding: 10px 14px; background: ${c.panel}; border-top: 1px solid ${c.line}; }
  .foot .sp { flex: 1; min-width: 20px; }
  .foot .link { color: ${c.accent}; }
  .foot .btn { background: ${c.bg}; }
  .foot .btn.primary { background: ${c.accent}; }
  /* invoice */
  .invoice { font-family: "Noto Serif JP"; }
  .doc { width: 44em; padding: 16px 22px; display: grid; gap: 6px; }
  .doc .title { text-align: center; font-size: 1.8em; letter-spacing: 0.2em; font-weight: bold; }
  .doc .meta, .doc .from, .doc .bank { display: flex; flex-direction: column; align-items: flex-end; }
  .doc .to { font-size: 1.2em; border-bottom: 1px solid ${c.text}; width: max-content; }
  .doc .from { font-family: "Noto Sans JP"; }
  .doc .total { display: flex; gap: 14px; align-items: baseline; border: 1px solid ${c.text}; padding: 4px 10px; width: max-content; }
  .doc .total .big { font-size: 1.4em; font-weight: bold; }
  table.items { border-collapse: collapse; width: 100%; font-family: "Noto Sans JP"; }
  .items th { border: 1px solid ${c.text}; background: ${c.head}; font-weight: normal; padding: 2px 6px; }
  .items td { border: 1px solid ${c.text}; padding: 2px 6px; }
  .items td.num { text-align: right; } .items td.c { text-align: center; }
  .doc .bank { align-items: flex-start; }
  .doc .note { font-size: 0.85em; color: ${c.sub}; }
  `;
  const fonts =
    '<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;700&family=Noto+Serif+JP:wght@400;700&display=block" rel="stylesheet">';
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">${fonts}<style>${css}</style></head>
  <body><div class="${kind}">${SCREENS[kind]()}</div></body></html>`;
}

// How the screen reaches OCR:
// - plain: as the browser draws it (grey anti-aliasing);
// - cleartype: with the colour fringes of Windows' ClearType (drawn three
//   times as wide, each third of a pixel becomes its red, green or blue,
//   through ClearType's 1-2-3-2-1 filter);
// - remote: ClearType, then JPEG at quality 50, like a remote desktop or
//   Citrix screen.
// Small sizes get every rendering, the others only plain.
const RENDERS = { plain: SIZES, cleartype: [9, 12], remote: [9, 12] };

/** Runs in the page: the picture `png` (base64) made `mode`. */
function develop([png, mode]) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const wide = document.createElement("canvas");
      wide.width = img.width;
      wide.height = img.height;
      const wctx = wide.getContext("2d");
      wctx.drawImage(img, 0, 0);
      const w = Math.floor(img.width / 3);
      const h = img.height;
      const src = wctx.getImageData(0, 0, img.width, h).data;
      const outc = document.createElement("canvas");
      outc.width = w;
      outc.height = h;
      const octx = outc.getContext("2d");
      const dst = octx.createImageData(w, h);
      const weights = [1, 2, 3, 2, 1].map((v) => v / 9);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          for (let c = 0; c < 3; c++) {
            const sub = 3 * x + c;
            let v = 0;
            for (let k = 0; k < 5; k++) {
              const sx = Math.min(img.width - 1, Math.max(0, sub + k - 2));
              v += weights[k] * src[(y * img.width + sx) * 4 + c];
            }
            dst.data[(y * w + x) * 4 + c] = Math.round(v);
          }
          dst.data[(y * w + x) * 4 + 3] = 255;
        }
      }
      octx.putImageData(dst, 0, 0);
      if (mode !== "remote") {
        resolve(outc.toDataURL("image/png").split(",")[1]);
        return;
      }
      const jpeg = new Image();
      jpeg.onload = () => {
        octx.drawImage(jpeg, 0, 0);
        resolve(outc.toDataURL("image/png").split(",")[1]);
      };
      jpeg.src = outc.toDataURL("image/jpeg", 0.5);
    };
    img.src = `data:image/png;base64,${png}`;
  });
}

const browser = await chromium.launch();
const context = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 3600, height: 1400 } });
const pg = await context.newPage();
const truth = {};
for (const kind of Object.keys(SCREENS)) {
  for (const [render, sizes] of Object.entries(RENDERS)) {
    for (const pt of sizes) {
      for (const theme of Object.keys(THEMES)) {
        const suffix = render === "plain" ? "" : `-${render}`;
        const name = `${kind}-${String(pt).replace(".", "_")}pt-${theme}${suffix}`;
        await pg.setContent(page(kind, pt, theme), { waitUntil: "networkidle" });
        await pg.evaluate(() => document.fonts.ready);
        const items = await pg.$$eval(".t", (spans) =>
          spans.map((s) => {
            const r = s.getBoundingClientRect();
            return { text: s.textContent, x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
          }),
        );
        const body = await pg.$("body > div");
        const box = await body.boundingBox();
        const pad = 8;
        const clip = { x: box.x - pad, y: box.y - pad, width: Math.ceil(box.width) + 2 * pad, height: Math.ceil(box.height) + 2 * pad };
        let png;
        if (render === "plain") {
          png = await pg.screenshot({ clip });
        } else {
          // Three times as wide; the text is drawn at that size, not stretched.
          await pg.evaluate(() => {
            document.body.style.transformOrigin = "0 0";
            document.body.style.transform = "scaleX(3)";
          });
          const wide = await pg.screenshot({ clip: { ...clip, x: clip.x * 3, width: clip.width * 3 } });
          png = Buffer.from(await pg.evaluate(develop, [wide.toString("base64"), render]), "base64");
        }
        writeFileSync(join(out, `${name}.png`), png);
        truth[name] = items
          .filter((i) => i.text.trim())
          .map((i) => ({ ...i, x: i.x - Math.round(clip.x), y: i.y - Math.round(clip.y) }));
        console.log(name, truth[name].length, "texts");
      }
    }
  }
}
writeFileSync(join(out, "truth.json"), `${JSON.stringify(truth, null, 1)}\n`);
await browser.close();

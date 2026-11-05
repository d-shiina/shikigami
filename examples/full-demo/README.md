# フル機能デモ（full-demo）

今ある機能をできるだけ使った 1 本のデモシナリオです。「月次の受注処理」を題材に、
設定の読み込みから Excel・Word・CSV の作成、ブラウザ出荷、実環境（Windows）機能まで
をひと通りなぞります。

このフォルダーは**シナリオ＝プロジェクトフォルダー**の形になっています。

```
full-demo/
  scenario.json            メインシナリオ（scn_demo_full）
  subscenarios/
    shipping.json          ブラウザ出荷のサブシナリオ（scn_demo_shipping）
  config/設定.json          外だし設定（消費税率・しきい値・送信先・実環境フラグ）
  input/受注.csv            入力データ
  templates/請求書.docx     Word 差し込みテンプレート（{{ 顧客 }} など）
```

実行時には `output/`（請求書・CSV・Excel・ZIP）が作られます。

## 実行

一発で試す（ウィンドウに表示しながら、ゆっくり動きます）:

```bash
pnpm demo:full
```

デモサイトを起動し、シークレット「デモ受注システム」を登録してから実行します。
開始ダイアログ → Excel/Word/CSV 作成 → ブラウザで出荷 → メモ帳を操作して OCR →
出力フォルダーをエクスプローラーで開く → 結果ダイアログ、の順に画面で見られます。

Studio で動かす（ワークスペースに取り込むとプロジェクトフォルダーとして展開されます）:

```bash
shikigami scenario import examples/full-demo.shikigami.json
```

入力 `siteUrl` を空のまま実行すると、同梱のデモサイト（`input/web/`）をファイル
（file://）として開きます。file:// のページにはシークレットを入力できない仕様の
ため、このときのログインは `browser.waitForHuman` で手動（ユーザー名 `demo`・
パスワード `shikigami`）になります。シークレットでのログインまで見せたいときは
`pnpm demo:site` を起動し、`siteUrl` に `http://127.0.0.1:8787/` を入れて、
シークレット「デモ受注システム」（サイト `http://127.0.0.1:8787/`）を登録します。

CLI から直接:

```bash
shikigami run examples/full-demo.shikigami.json
# ソースから: cargo run -p shikigami-cli -- run examples/full-demo.shikigami.json
```

無人実行や CI では、`config/設定.json` の `実環境を使う` を `false` にすると
ダイアログ・アプリ操作の節を飛ばして、ファイル処理だけで最後まで動きます。

`examples/full-demo.shikigami.json`（配布・実行用のバンドル）はこのフォルダーと
デモサイト `examples/web/` から生成します。編集したら作り直してください:

```bash
node examples/build-full-demo.mjs
```

## 流れ

1. 開始ダイアログ（`dialog.message`）
2. `config.read` で `config/設定.json` を読む
3. `file.readCsv` で受注を読み、`excel.writeRange` で `output/集計.xlsx` を作成、
   `excel.readRows` で読み戻す（Excel/Word はアプリ不要。ファイルを直接読み書き）
4. `control.forEach` ＋ `control.if` ＋ `control.try` で税込を計算し、同じ行に
   `excel.writeCell` で書き戻す（失敗は catch して継続）
5. `excel.addSheet` ＋ `excel.appendRows` で請求シートに転記
6. `file.writeCsv` で一覧を出力、`groupBy` で顧客別にまとめ、`word.fillTemplate`
   で顧客ごとに請求書 docx を作成（テーブル行の繰り返し差し込み）
7. `file.list` ＋ `file.zip` で `output/` を ZIP 化
8. `scenario.call` でブラウザ出荷のサブシナリオを呼ぶ（シークレットでログイン、
   できなければ `browser.waitForHuman`。`session` で次回はログイン省略）
9. `wait.until` のポーリング
10. 画面・アプリを使う節（`実環境を使う` = true のとき。各 `control.try` で包んで
    あるので、アプリが無い節は飛ばして先へ進みます）
    - `dialog.message` … 続行確認
    - `excel.runMacro` … `.xlsm` の VBA マクロ（デスクトップ Excel が必要。
      `input/集計マクロ.xlsm` は同梱していないので、各自の環境で用意してください）
    - `clipboard.set` / `clipboard.get`
    - `desktop.launch` / `type` / `screenshot` / `readText`(OCR) / `closeWindow`
      … メモ帳を操作して画面を OCR で読む
    - `process.run` … 外部コマンド
    - `oauth.signIn` ＋ `http.request` … OAuth サインインして Web API を呼ぶ
      （シークレット `Box` の登録が必要）
    - `mail.createDraft` … Outlook に下書きを作成（送信はしない）
    - 出力フォルダーをエクスプローラーで開き、結果をダイアログで表示

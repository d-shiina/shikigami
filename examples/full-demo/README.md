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

一発で試す（デモサイトとブラウザ出荷込み・ウィンドウ表示）:

```bash
pnpm demo:full
```

バンドル 1 ファイルから直接（ヘッドレス・外部不要。ブラウザ出荷節は自動スキップ）:

```bash
shikigami run examples/full-demo.shikigami.json
# ソースから: cargo run -p shikigami-cli -- run examples/full-demo.shikigami.json
```

ワークスペースに取り込む（プロジェクトフォルダーとして展開される）:

```bash
shikigami scenario import examples/full-demo.shikigami.json
```

`examples/full-demo.shikigami.json`（配布・実行用のバンドル）はこのフォルダーから
生成します。フォルダーを編集したら作り直してください:

```bash
node examples/build-full-demo.mjs
```

## 外部アカウントなしで完走する範囲

次の流れは**外部アカウント不要・ヘッドレスで最後まで動きます**（Excel/Word も
アプリ不要。ファイルを直接読み書きします）。

1. `config.read` で `config/設定.json` を読む
2. `file.readCsv` で受注を読み、`excel.writeRange` で `output/集計.xlsx` を作成、
   `excel.readRows` で読み戻す
3. `control.forEach` ＋ `control.if` ＋ `control.try` で税込を計算し、同じ行に
   `excel.writeCell` で書き戻す（失敗は catch して継続）
4. `excel.addSheet` ＋ `excel.appendRows` で請求シートに転記
5. `file.writeCsv` で一覧を出力、`groupBy` で顧客別にまとめ、`word.fillTemplate`
   で顧客ごとに請求書 docx を作成（テーブル行の繰り返し差し込み）
6. `file.list` ＋ `file.zip` で `output/` を ZIP 化
7. `scenario.call` でブラウザ出荷のサブシナリオを呼ぶ（デモサイトが無ければ
   `control.try` で捕捉してスキップ）
8. `wait.until` のポーリングで締める

## 実環境（Windows ＋各アプリ）が要る節

`config/設定.json` の `実環境を使う` を `true` にすると、次も実行します。いずれも
`control.try` で包んであるので、アプリが無くてもデモ全体は止まりません。

- `dialog.message` … 続行確認のダイアログ
- `excel.runMacro` … `.xlsm` の VBA マクロ（デスクトップ Excel が必要。
  `input/集計マクロ.xlsm` は同梱していないので、各自の環境で用意してください）
- `clipboard.set` / `clipboard.get` … クリップボード受け渡し
- `desktop.launch` / `type` / `screenshot` / `readText`(OCR) / `closeWindow`
  … メモ帳を操作して画面を OCR で読む
- `process.run` … 外部コマンド
- `oauth.signIn` ＋ `http.request` … ブラウザで OAuth サインインして Web API を呼ぶ
  （シークレット `Box` の登録が必要）
- `mail.createDraft` … Outlook に下書きを作成（送信はしない）

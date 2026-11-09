# フローのテスト

[English](../testing.md) | 日本語

フローを直したあと「前と同じ結果になるか」を毎回手で確かめなくて済むように、**テストケース**を保存しておき、まとめて流せます。テストケースは「この入力で流すと、こう終わって、出力はこうなる」を書いた小さな JSON ファイルです。

## 置き場所と書き方

フローのフォルダーの `tests/` に、1 ケース 1 ファイルで置きます。ファイル名（`.json` を除いた部分）がケースの名前です。

```text
flows/<フローの ID>/
  flow.json
  input/
  tests/
    3支店の合計.json
    フォルダーが無い.json
```

```json
{
  "description": "input の 3 支店の CSV を合計する",
  "inputs": { "folder": "input" },
  "expect": { "status": "succeeded", "outputs": { "branchCount": 3, "grandTotal": 73050 } }
}
```

| 項目 | 意味 |
|---|---|
| `$schema` | エディターの補完用に `https://spellsheet.dev/schemas/test-case.schema.json`（任意。中身は [schemas/test-case.schema.json](../../schemas/test-case.schema.json)） |
| `description` | ケースの説明（任意） |
| `inputs` | 入力変数の値。書かなかった入力は既定値のまま（`spellsheet run -i` と同じ） |
| `expect.status` | 終わり方：`succeeded`（既定）・`failed`・`cancelled` |
| `expect.outputs` | 確かめる出力変数と値 |
| `expect.errorCode` | `failed` のとき、エラーの種類（例 `ELEMENT_NOT_FOUND`、`FILE_NOT_FOUND`） |
| `expect.errorStep` | `failed` のとき、止まるはずのノードの ID |

`expect.outputs` は**書いたものだけ**を比べます。

- 出力が増えても、書いていない出力は見ません
- 値がオブジェクトなら、書いたキーだけを比べます（`{ "summary": { "count": 2 } }` は `summary.count` だけ）
- 一覧（配列）は件数が同じで、1 件ずつ同じ決まりで比べます
- 数は値で比べます（`3` と `3.0` は同じ）

エラーで止まることを確かめるケースも書けます。

```json
{
  "inputs": { "folder": "無いフォルダー" },
  "expect": { "status": "failed", "errorCode": "FILE_NOT_FOUND" }
}
```

`tests/` はフローと一緒にファイルへの書き出し（バンドル）に入ります。

## Writer で作る・流す

フロー図の下のパネルの「テスト」タブで扱います。

- **この実行をテストケースとして保存**：フローを実行したあとに押すと、その実行の入力・終わり方・出力を期待する結果として `tests/` に保存します。エラーで中断した実行なら、エラーの種類と止まったノードを期待にします。シークレットの入力・出力と、記録で切り詰められた長い値は保存しません（そう表示します）
- **すべて実行**・行の ▶：作業中の内容で 1 ケースずつ流し、期待どおりか、違うならどこがどう違うか（「出力『total』 期待 3 実際 4」）を並べます。エラーで止まったケースは、止まったノードへ移れます
- 実行中は「中止」で今のケースを止め、残りは流しません
- 中身を直したいときは、左の「プロジェクト」の `tests/` のファイルを開いて書き換えます

## AI から

MCP の `save_test_case` でケースを書き、`run_tests` で流せます（[mcp.md](mcp.md)）。AI にフローを直してもらうときは「テストケースを足して、run_tests が全部通るまで直して」と頼むと、直すたびに前の結果が崩れていないかを AI 自身が確かめます。シークレットの入力はケースに書けません。

AI が保存したケースは、その変更の**約束**として扱います。Writer の確認パネルは先頭に、ケースの `description`（何が起きればよいかを業務の言葉で書く）、入力と期待する結果、守れているかを並べ、人は約束が業務として正しいかを答えます。`description` はプログラムではなく、確認する人に向けて書いてください（[design/review-evidence.md](design/review-evidence.md)）。

## コマンドで流す

```bash
spellsheet test <フローの ID>                 # 確定版で全部のケース
spellsheet test <フローの ID> --draft         # 作業中の内容で
spellsheet test <フローの ID> --case 3支店の合計  # 1 ケースだけ（繰り返し指定できます）
spellsheet test examples/tutorials/sales-csv/flow.json   # ファイルのフローも
```

```text
✓ 3支店の合計 — input の 3 支店の CSV を合計する (57 ms)
✗ わざと違う (44 ms)
    outputs.grandTotal: expected 1, got 73050
    run run_01a1b7346ab87610b9e2a18b7b85b106
✓ フォルダーが無い (0 ms)
2 passed, 1 failed
```

- 1 ケースごとに 1 回ふつうに実行し、実行の記録にも残ります（`origin.requestedBy` が `test:<ケース名>`）。違ったケースの記録は、表示された run ID で Writer の実行の記録から開けます
- 外のアプリや Web を操作するフローは、テストでも本当に操作します。テスト用の入力（テスト用のフォルダー・テスト環境の URL など）を `inputs` で渡してください
- 1 つでも違うと終了コードは 1 です。バッチや CI の判定にそのまま使えます
- `--json` は結果を 1 つの JSON（`passed`・`failed`・`cases[]`、各ケースに `passed`・`runId`・`status`・`error`・`mismatches[]`）で出します。`mismatches[]` は `at`（`outputs.total` など）・`expected`・`actual` です

見本：[売上 CSV のチュートリアル](tutorials/sales-csv.md) の `examples/tutorials/sales-csv/tests/`。

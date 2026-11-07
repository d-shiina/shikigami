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
| `$schema` | エディターの補完用に `https://shikigami.dev/schemas/test-case.schema.json`（任意。中身は [schemas/test-case.schema.json](../../schemas/test-case.schema.json)） |
| `description` | ケースの説明（任意） |
| `inputs` | 入力変数の値。書かなかった入力は既定値のまま（`shikigami run -i` と同じ） |
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

## 流す

```bash
shikigami test <フローの ID>                 # 公開版で全部のケース
shikigami test <フローの ID> --draft         # 作業中の内容で
shikigami test <フローの ID> --case 3支店の合計  # 1 ケースだけ（繰り返し指定できます）
shikigami test examples/tutorials/sales-csv/flow.json   # ファイルのフローも
```

```text
✓ 3支店の合計 — input の 3 支店の CSV を合計する (57 ms)
✗ わざと違う (44 ms)
    outputs.grandTotal: expected 1, got 73050
    run run_01a1b7346ab87610b9e2a18b7b85b106
✓ フォルダーが無い (0 ms)
2 passed, 1 failed
```

- 1 ケースごとに 1 回ふつうに実行し、実行の記録にも残ります（`origin.requestedBy` が `test:<ケース名>`）。違ったケースの記録は、表示された run ID で Studio の実行の記録から開けます
- 外のアプリや Web を操作するフローは、テストでも本当に操作します。テスト用の入力（テスト用のフォルダー・テスト環境の URL など）を `inputs` で渡してください
- 1 つでも違うと終了コードは 1 です。バッチや CI の判定にそのまま使えます
- `--json` は結果を 1 つの JSON（`passed`・`failed`・`cases[]`、各ケースに `passed`・`runId`・`status`・`error`・`mismatches[]`）で出します。`mismatches[]` は `at`（`outputs.total` など）・`expected`・`actual` です

見本：[売上 CSV のチュートリアル](tutorials/sales-csv.md) の `examples/tutorials/sales-csv/tests/`。

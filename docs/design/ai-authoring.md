# AI が組みやすいシナリオ仕様（設計メモ）

方針：「AI が組むので、AI が間違えにくい仕様にする」。人間は Studio で読んで直し、実行は AI なしで行う。

## 5 原則

1. 構文を増やさない。同じことは 1 通りで書く。
2. 離れたノード同士を名前で参照しない（background/await のようなハンドルは作らない。「先に始めて後で待つ」は `control.parallel` のブランチとブロック末尾の合流で書く）。
3. 排他・ロックは Runtime が params から推論する。AI に宣言させない。
4. 検証エラーには直し方（`hint`）を付け、`get_step_schema` はコピーできる記述例（`examples`）を返す。
5. 結果がタイミングで変わる書き方は、実行時ではなく検証時にエラーにする。

## A. `control.forEach` の並列化

| param | 意味 |
|---|---|
| `concurrency` (1..64) | 指定すると「分離モード」。各回は開始時点の変数のコピーで動き、最大 `concurrency` 回を同時に実行 |
| `collect` (式) | 各回の終了時にその回の変数で評価した値を、その回の結果にする。forEach の `saveAs` に結果の配列（`items` と同じ順・同じ長さ）が入る |

- 分離モードの body 内の書き込みは、その回の中だけ有効（終了時に捨てる）。外へ出せるのは `collect` だけ。
- `itemVar` / `indexVar` は回ごとに束縛し、ループ後には残さない。
- 失敗は fail-fast（残りをキャンセル）。エラーの `details` に `{ index }` を付ける。要素ごとに失敗を許すなら body を `control.try` で包む。
- `continue` はその回を終える（`collect` はその時点で評価）。分離モードでの `break` は検証エラー。
- 排他資源のロックは従来どおり効く。

| 検証コード | 条件 |
|---|---|
| `FOREACH_BREAK_IN_CONCURRENT` (error) | 分離モードの body に `control.break` |
| `FOREACH_SHARED_WRITE` (error) | 分離モードの body が `variables` に宣言された変数に書き込む |
| `FOREACH_ACCUMULATOR` (warning) | 分離モードの body で、書く前に読む変数がある（`total + x` 型） |
| `FOREACH_COLLECT_WITHOUT_SAVE_AS` (warning) | `collect` があって `saveAs` がない |

## B. params から導く資源キー

- `StepTypeDef` に非公開（スキーマに出ない）の `resources` を持たせる：固定（`desktop.input`）または param 由来（`file` / `window` / `browserContext`）。
- `ActionHandler::exclusive_resources()` は廃止し、宣言場所を `StepTypeDef` に一本化。
- Runtime はテンプレート展開後の params からキーを作り、既存のロック（ソート・重複除去済み）で取得。
- `file:` キーの正規化（Windows）：絶対パス化（存在不要）→ `\\?\` 除去 → 区切りを `\` に → `.`/`..` を畳み込み → 小文字化 → 末尾 `\` 除去。相対パスは検証で `RELATIVE_PATH` warning。
- 同じキー文字列を Phase 4 のプロセス間排他（名前付きミューテックス）でもそのまま使う。

## C. `wait.until`

- Runtime 組み込みの制御ノード。params：`condition`（式、必須）、`intervalMs`（既定 500）。
- 任意の `check` ブロックを毎回のポーリング前に実行（ファイル存在確認・要素状態などの通常ノードを `saveAs` で変数に入れ、`condition` で判定）。式言語に副作用のあるプローブ関数は入れない。
- 上限はノード共通の `timeoutMs`。専用 timeout は作らない。超えたら `WAIT_TIMEOUT`（`details: { elapsedMs, polls }`）。
- `retry` 付きは `REDUNDANT_RETRY` warning。

## D. 現仕様の見直し（優先度順）

1. **[高] 式とテンプレートの規則を一本化**：`expressionParams` に挙げた param は「`{{ }}` なしの式」、それ以外の文字列はテンプレート。`control.repeat.count` と `flow.delay.ms` は「整数、または `{{ 式 }}`」に統一する（現状 `count` の文字列は式、`ms` の文字列はテンプレートで食い違う）。
2. **[高] 並行ブランチの変数競合を静的にも検出**：2 つ以上のブランチが同じ変数に書き込む構造は検証エラー。
3. **[高] `list_step_types` に `expressionParams` / `bindsVariables` を含める**。
4. **[高] スキルの誤り修正**：`direction` は `input / output / inOut / local`、関数一覧に `round` はない。
5. **[中] `variable.set` の value/expression 両方・両方なしに専用ヒント**。
6. **[中] 未宣言の入力名は `run_scenario` でエラー**（現状を確認のうえ）。
7. **[低] MCP の説明文に式とテンプレートの書き分けを一文追加**。

## 実装順

1. D-1・D-3・D-4・D-5（規則の一本化、一覧の拡張、スキル修正、ヒント）
2. D-2（並行ブランチの競合の静的検出）
3. B（資源キー）
4. C（`wait.until`）
5. A（forEach の並列と `collect`）
6. 設計書・サンプルの更新

設計：Fable（2026-10-28）。コードとの照合で、`render_value` は「文字列全体が 1 つの `{{ }}` なら型を保つ」を既に実装済みと確認したため、その提案は除外した。

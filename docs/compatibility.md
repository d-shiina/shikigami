# 互換性の方針

Shikigami の外に出ていく「約束」と、それをどう変えてよいかの決まりです。シナリオは長く使われ、AI クライアントやスクリプトは MCP のツールと CLI を前提に組まれます。ここに書いたものを壊すと、利用者の手元で黙ってシナリオが動かなくなります。

*English summary: this page lists Shikigami's public contracts (scenario files, bundles, step types, MCP tools, CLI) and the rules for changing them. Additive changes are fine in any release; breaking changes need a migration or a deprecation period and a CHANGELOG entry. Snapshots under `schemas/` make every contract change visible in review.*

## 1. 対象

| 約束 | どこに定義があるか | 主な利用者 |
|---|---|---|
| シナリオのファイル形式（`schemaVersion`） | `crates/shikigami-core/src/model.rs` → `schemas/scenario.schema.json` | 保存済みのシナリオ、共有ワークスペース |
| 名前付きの版・バンドル（`*.shikigami.json`、`formatVersion`） | `version.rs` → `schemas/api.schema.json` | 他の PC・ワークスペースへの受け渡し |
| 組込のステップ型（型名・params・ブロック・`saveAs` の有無・`risk`） | 各アダプター → `schemas/contract/step-types.json` | シナリオ、AI が覚えた書き方 |
| MCP のツール（名前・引数・戻り値・許可クラス・注釈） | `crates/shikigami-mcp` → `schemas/contract/mcp-tools.json` | AI クライアント、スキル |
| エラーコード（`code` と `retryable`） | `CoreError::code`、各ステップのエラー | AI の修正、`onError`・リトライの判断 |
| CLI（コマンド・引数・終了コード・`--json` の出力） | `crates/shikigami-cli` → `schemas/contract/cli.json`、`schemas/run-api.schema.json` | タスクスケジューラー、バッチ、CI |
| プラグインのマニフェストと JSON-RPC（`manifestVersion`） | [design/plugins.md](design/plugins.md) | プラグインの作者 |

約束ではないもの：Studio の画面、内部の Rust API（クレートは公開していません）、ログ・エラーの文章（`message` と `hint` は言い回しを変えます）、`list_step_types` などの説明文、ワークスペース内のローカル領域（取り消し履歴・実行記録の置き方）。

## 2. 変えてよいこと・いけないこと

**いつでもよい（追加）**

- ステップ型・MCP ツール・CLI のサブコマンドやフラグの追加
- 省略できる params・引数の追加（省略時は今までと同じ動き）
- 戻り値・`--json` の出力にフィールドを足す（読む側は知らないフィールドを無視すること）
- エラーコードの追加、文章やヒントの改善

**移行か非推奨の期間が要る（破壊的変更）**

- 名前の変更・削除（ステップ型、params、ツール、引数、フラグ、エラーコード）
- 必須の params・引数を増やす、受け付ける値を狭める、意味を変える
- 終了コードの意味を変える

0.x の間も、破壊的変更は次のどちらかで行います。

1. **シナリオ形式・組込ステップの params**：`schemaVersion` を上げて移行を書く（§3）。古いファイルは読み込み時に自動で新しい形になる
2. **MCP・CLI**：古い名前を残したまま新しい名前を足し、古い方を非推奨にする（§5）。少なくとも次のマイナー版までは両方動かす

どちらも [CHANGELOG.md](../CHANGELOG.md) の「破壊的変更」に書きます。1.0 以降は破壊的変更をメジャー版でだけ行います。

## 3. シナリオのファイル形式

- `schemaVersion` はファイルの形の版です。**形が変わるたびに 1 上げます**。シナリオは知らない項目を拒否する（書き間違いに気づくため）ので、省略できる項目を足すだけでも上げます。古い Shikigami は「新しい版で保存されたので更新してください」（`UNSUPPORTED_SCHEMA_VERSION`）と分かりやすく止まります
- 上げたら `crates/shikigami-core/src/migrate.rs` の `MIGRATIONS` に「1 つ前の版 → 今の版」の関数を足します。読み込みは古い版から 1 段ずつ順に変換するので、各関数は直前の版だけを知っていればよい。途切れていればテストが落ちます
- 組込ステップの params の破壊的変更も、ここで移行します（`for_each_step` で全ステップを書き換える）。組込ステップは本体と一緒に配布されるので、ステップごとの版は持たせません。シナリオに版を書かせると、AI が書く量と間違える場所が増えるためです（[design/ai-authoring.md](design/ai-authoring.md)）
- ファイル・名前付きの版・バンドルの中のシナリオ・サブシナリオは、すべて同じ移行を通ります（`migrate::from_value` / `migrate::deserialize`）
- 移行したシナリオは、次に保存したときに新しい版で書かれます。読むだけではファイルを書き換えません
- 未来の版は読み込みません（黙って項目を落とすと、保存したときに消えるため）
- `metadata` の中の知らないキーは保持します（Studio や外部ツールのメモ用）

テスト：`migrate.rs` に「前の版のファイルが今の版で読めること」のテストを、移行ごとに足してください。

### バンドル

バンドルは `formatVersion` を持ち、中のシナリオは上と同じ `schemaVersion` の規則に従います。バンドルの外側の形を変えるときは `BUNDLE_FORMAT_VERSION` を上げます。

## 4. プラグインと `requires`

シナリオは、使っているプラグインとその版の範囲を `requires` に持ちます。

```json
"requires": { "plugin:kintone": "^0.3.1" }
```

- **Core が自動で管理します**。プラグインのステップを足すとそのとき入っている版で `^<版>` が入り、使わなくなると消えます。人や AI が書く必要はありません
- 範囲を広げたい・狭めたいときだけ `update_scenario` の `patch.requires` で書き換えます（使っている間は保たれます）
- 範囲は semver（`^0.3.1`、`>=1.2, <3` など）。プラグインの `version` は semver で書く必要があります
- **入っていない PC**：シナリオは読み込めて、ステップもそのまま残ります。検証で `PLUGIN_NOT_INSTALLED`（どのプラグインのどの版が要るか、どこに入れるか）になり、実行前に止まります
- **範囲外の版が入っている PC**：`PLUGIN_VERSION_MISMATCH` で実行前に止まります

プラグインの作者へ：params を互換でない形に変えるときはメジャー版を上げてください（0.x ならマイナー版）。古いシナリオが `PLUGIN_VERSION_MISMATCH` で止まるので、黙って壊れることはありません。続けて古い書き方も受け付けられるなら、版は互換のまま新しい params を足すのが一番です。

## 5. 非推奨（deprecation）

- **ステップ型**：`StepTypeDef.deprecated`（プラグインはマニフェストの `steps[].deprecated`）に、理由と代わりの型を書きます。動き続けますが、検証で `DEPRECATED_STEP_TYPE` の警告と代わりの型が出ます。AI は警告を見て書き換えます
- **MCP のツール・引数**：古い名前を残し、説明の先頭に `Deprecated: use <新しい名前>.` と書きます。戻り値に `deprecated` の注意を入れてもよい
- **CLI**：古いコマンド・フラグを残し、使われたら標準エラーに警告を出します
- 非推奨にしたことと、削除する予定の版を CHANGELOG に書きます。削除は次のマイナー版以降（1.0 以降は次のメジャー版）

## 6. MCP

- ツール名は `snake_case`。変えるときは §5 の手順で
- 引数は追加だけ。必須にしたいときは、既定値を持たせるか、新しいツールにする
- 戻り値は JSON のオブジェクト。フィールドを足すのは自由、消す・型を変えるのは破壊的変更
- エラーは `code`・`message`・`details`。`code` は固定、`message` と `details.hint` は改善してよい
- 許可クラス（`read` / `write` / `run`）を広げる側に変える（`read` だったものを `write` にする）のは、`--allow read` で動かしている利用者から見えなくなるので破壊的変更として扱います
- MCP の仕様自体の版は `rmcp` に従い、古いクライアントとの互換は `rmcp` が受け持ちます

## 7. CLI

終了コード：

| コード | 意味 |
|---|---|
| 0 | 成功 |
| 1 | 実行が失敗した、検証でエラーがあった、`plugin check` で問題が見つかった |
| 2 | コマンドの使い方の誤り、ワークスペースが開けないなど、処理を始められなかった |
| 130 | 実行がキャンセルされた（Ctrl+C） |

- `--json` を付けたときの出力は約束です。`run --json` は 1 行 1 イベント（`schemas/run-api.schema.json` の `RunEvent`）、そのほかは 1 つの JSON。`--json` なしの表示は人向けで、いつでも変えます
- スクリプトからは `--json` と終了コードを使ってください

## 8. スナップショットと CI

`pnpm schema:generate`（`shikigami schema export`）が、JSON Schema と一緒に次の「契約のスナップショット」を `schemas/contract/` に書きます。説明文は含まず、形だけです。

| ファイル | 中身 |
|---|---|
| `mcp-tools.json` | ツールの名前・許可クラス・注釈・引数と戻り値の JSON Schema |
| `step-types.json` | 組込ステップ型の名前・params の JSON Schema・ブロック・`saveAs` の有無・`risk` など |
| `cli.json` | サブコマンド・引数・フラグ |

- コミット済みのファイルと Rust の定義がずれるとテストが落ちます（`schemas/*.schema.json` と同じ仕組み）
- `schemas/` が変わる Pull Request は、`CHANGELOG.md` も変える必要があります（CI の「Contract changes are in the changelog」）。差分を見て、§2 のどちらに当たるかを書いてください
- 生成物の TypeScript 型（`packages/schema`）も同じく CI でずれを確認します

## 9. リリースのとき

1. `CHANGELOG.md` の「未リリース」を版番号と日付にする
2. 破壊的変更・非推奨があれば、その版の見出しの下に目立つように書く
3. 以降は [release.md](release.md) の手順どおり

# Changelog

利用者から見える変更を記録します。書き方は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に、版番号は [Semantic Versioning](https://semver.org/lang/ja/) に従います。何が「約束」で、どう変えてよいかは [docs/compatibility.md](docs/compatibility.md) を参照してください。

`schemas/` が変わる Pull Request は、ここの「未リリース」にも書いてください（CI で確認します）。

## 未リリース

### 追加

- ライセンスを Apache License 2.0 にしました（`LICENSE`・`NOTICE`）。貢献のしかた（DCO）は `CONTRIBUTING.md`、脆弱性の報告先は `SECURITY.md`
- シナリオの `requires`：使っているプラグインと版の範囲（`{ "plugin:kintone": "^0.3.1" }`）。Core がステップに合わせて自動で更新します。入っていないプラグインは `PLUGIN_NOT_INSTALLED`、範囲外の版は `PLUGIN_VERSION_MISMATCH` で実行前に止まります。範囲は `update_scenario` の `patch.requires` で変えられます
- ステップ型の非推奨の印（`deprecated`、プラグインのマニフェストは `steps[].deprecated`）。使うと検証で `DEPRECATED_STEP_TYPE` の警告と代わりの型が出ます
- `list_step_types` / `get_step_schema` / `shikigami step-types --json` の各型に `plugin`（提供元のプラグインと版）
- 互換性の方針 `docs/compatibility.md` と、MCP ツール・組込ステップ型・CLI の契約のスナップショット（`schemas/contract/`）
- 公開版：`shikigami version publish <id> [番号]` / `version unpublish <id>`、Studio のレビュー台の「承認して公開」と版タブの「公開」。記録は `versions/<id>/publish.jsonl`。`version list` は公開中の版に `published` を付けます。MCP の `run_scenario` に `published: true`、`get_scenario` / `list_versions` に `published`
- ワークスペースの `policy.json`：許可するサイト（`sites`）・プログラム（`apps`）と、AI の `run_scenario` / `test_step` / `delete_scenario` を危険度ごとに `allow` / `ask` / `deny`。外れたステップは `SITE_NOT_ALLOWED` / `APP_NOT_ALLOWED`、壊れた設定は `POLICY_INVALID` で止まります。CLI の `shikigami policy show|check|init`、MCP の `get_policy`、Studio の「許可と承認」。詳しくは `docs/policy.md`
- AI の操作の承認：`ask` の操作は `APPROVAL_REQUIRED`（`details.approvalId`）を返し、人が Studio か `shikigami approval approve <id>` で許可した同じ内容だけが 1 回動きます。`delete_scenario` / `run_scenario` / `test_step` に `approvalId` / `approvalWaitMs` / `approvalReason`
- プラグインのマニフェストの `steps[].targets`：サイト・プログラムを指す param を宣言すると、組込と同じ `policy.json` の検査を受けます

### 変更

- **`shikigami run <シナリオID>` は公開版だけを動かすようになりました。** 公開版がなければ `NOT_PUBLISHED`（終了コード 2）で止まります。今までどおり作業中の内容を動かすには `--draft` を付けるか、`shikigami version publish <id>` で公開してください。ファイルを指定した `run` は変わりません
- シナリオのファイル形式を `schemaVersion` 2 にしました（`requires` の追加）。1 のファイルはそのまま読めて、次に保存したときに 2 になります。**2 で保存したファイルは、この版より古い Shikigami では開けません**
- プラグインのマニフェストの `version` は semver（`0.1.0` の形）が必須になりました
- 名前付きの版とバンドルの中のシナリオも、ファイルと同じ移行を通るようにしました

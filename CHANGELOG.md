# Changelog

利用者から見える変更を記録します。書き方は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に、版番号は [Semantic Versioning](https://semver.org/lang/ja/) に従います。何が「約束」で、どう変えてよいかは [docs/compatibility.md](docs/compatibility.md) を参照してください。

`schemas/` が変わる Pull Request は、ここの「未リリース」にも書いてください（CI で確認します）。

## 未リリース

### 追加

- シナリオをプロジェクト（フォルダー）として保存：`scenarios/<id>/scenario.json` の隣に `input/`・`config/`・`templates/`・`output/`・`work/`・`logs/` を置き、入力の Excel・設定ファイル・出力のひな形をシナリオと一緒に持てます。ステップのファイルの項目（ステップ型の `pathParams`）に書いた相対パスは、そのシナリオのフォルダーから解決します（サブシナリオは自分のフォルダーから）。従来の `scenarios/<id>.json` は保存先を開いたときにフォルダーへ移します（docs/files.md）
- 実行のたびに `work/` を空にし（`settings.keepWork` で残せる）、人が読む実行ログを `logs/<日時>_<結果>.log` に書きます（新しい 100 件を残す）
- 設定ファイルの形式 `{"format":"shikigami.config","items":[…]}` と、それを `{名前: 値}` で読む `config.read`
- MCP ツール `list_project_files` / `read_project_file` / `write_project_file` / `delete_project_file`、`test_step` の `scenarioId`、CLI の `shikigami scenario files` / `scenario add-file`
- Studio：フロー図の左に浮かぶ「プロジェクト」の棚。入力・設定・テンプレート・出力をロゴの 4 色で分け、どのノードが使っているか、Excel で開いたままか（`ProjectFile.inUse`）を出します。エクスプローラーからのドロップで追加（棚の上ならその棚、ほかは名前で振り分け）。設定ファイルはフォームで作って編集し、項目ごとに使っているノードを出します。テキストと実行ログもその場で開けます。ノードのファイルの項目は棚と同じ色で表示します
- バンドルとシナリオの複製に、プロジェクトのファイル（`output/`・`work/`・`logs/` を除く）を含めます

- `oauth.signIn`：Web API（Box など）に OAuth 2.0 の認可コードフローでサインイン。ブラウザの中でリダイレクト URL への要求を受け止めるので、リダイレクト URL は自社サイトなど固定のどんな URL でもよく（localhost で待ち受けない）、その先のサイトは読み込まれません。`state` の確認と PKCE 付き。トークンはシークレットと同じ鍵で暗号化して保存し、次回からは人なしで使い回し・更新します。`http.request` の `auth` に `{ "secret": "Box", "field": "accessToken" }`（期限が近ければ自動で更新）。シークレットの項目 `accessToken`、`list_secrets` の `signedIn`、Studio の「OAuth サインイン済み」と「サインアウト」（docs/oauth.md）
- Studio の表示を日本語と英語で切り替え（ステータスバーの JA / EN。選ぶまでは OS の言語に合わせる）。README と利用者向けドキュメントは英語を主にし、日本語版は `README.ja.md` と `docs/ja/` に
- Studio：呼び出し（サブシナリオ）のノードをダブルクリックすると、図がその場で呼ばれる側のフローに入ります（読み取り専用、入れ子も可、実行中の進み具合も表示）。上のパンくずか Esc で戻ります
- `excel.runMacro`：ブックの VBA マクロを、見えない別の Excel で実行（Windows、`Dangerous`）
- `word.fillTemplate` / `word.readText`：Word の文書（.docx）のひな形に `{{ 名前 }}` で差し込む（表の行の繰り返しも）、文書の文字を読む
- `mail.createDraft` / `mail.list` / `mail.saveAttachments`：この PC の Outlook で下書きを作る（送信はしない）、受信メールを読む、添付を保存する（Windows）
- ライセンスを Apache License 2.0 にしました（`LICENSE`・`NOTICE`）。貢献のしかた（DCO）は `CONTRIBUTING.md`、脆弱性の報告先は `SECURITY.md`
- シナリオの `requires`：使っているプラグインと版の範囲（`{ "plugin:kintone": "^0.3.1" }`）。Core がステップに合わせて自動で更新します。入っていないプラグインは `PLUGIN_NOT_INSTALLED`、範囲外の版は `PLUGIN_VERSION_MISMATCH` で実行前に止まります。範囲は `update_scenario` の `patch.requires` で変えられます
- ステップ型の非推奨の印（`deprecated`、プラグインのマニフェストは `steps[].deprecated`）。使うと検証で `DEPRECATED_STEP_TYPE` の警告と代わりの型が出ます
- `list_step_types` / `get_step_schema` / `shikigami step-types --json` の各型に `plugin`（提供元のプラグインと版）
- 互換性の方針 `docs/compatibility.md` と、MCP ツール・組込ステップ型・CLI の契約のスナップショット（`schemas/contract/`）
- 組込ステップ型 `pdf.readText`（PDF の文字を読む。パスワードはシークレットで渡せる）

### 変更

- シナリオのファイル形式を `schemaVersion` 3 にしました（`settings.keepWork` の追加。2 のファイルはそのまま読めます）。ファイルを含むバンドルは形式の版 2 で書き出し、**この版より古い Shikigami では読み込めません**（ファイルのないバンドルは従来どおり 1）
- 検証の `RELATIVE_PATH` をなくし、プロジェクトのフォルダーの外（`..`）を指すパスに `PATH_OUTSIDE_PROJECT` の警告を出すようにしました
- `dialog.message` / `dialog.input` のダイアログを Studio と同じ見た目に（白地と濃紺の文字、Windows のアプリがダークならダーク、日本語は Yu Gothic UI、ボタンは Windows の表示言語）。`dialog.selectFile` のフォルダー選択はエクスプローラーの画面に。Studio なしの `shikigami run` でも同じに出ます。ノードの指定と結果は変わりません
- シナリオのファイル形式を `schemaVersion` 2 にしました（`requires` の追加）。1 のファイルはそのまま読めて、次に保存したときに 2 になります。**2 で保存したファイルは、この版より古い Shikigami では開けません**
- プラグインのマニフェストの `version` は semver（`0.1.0` の形）が必須になりました
- 名前付きの版とバンドルの中のシナリオも、ファイルと同じ移行を通るようにしました

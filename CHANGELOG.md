# Changelog

利用者から見える変更を記録します。書き方は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に、版番号は [Semantic Versioning](https://semver.org/lang/ja/) に従います。何が「約束」で、どう変えてよいかは [docs/compatibility.md](docs/compatibility.md) を参照してください。

`schemas/` が変わる Pull Request は、ここの「未リリース」にも書いてください（CI で確認します）。

## 未リリース

### 追加

- Studio の AI ペイン：会話をシナリオごとに持ち、複数のシナリオで AI に並行して作業してもらえます。ペインは開いているシナリオの会話に切り替わり、見出しから会話を選べます（作業中・終わった印）。「新しいシナリオを作る」会話は、AI が作ったシナリオの会話になります。同じシナリオで同時に動く会話は一つだけです
- Studio の AI ペイン：AI の作業中でも「割り込む」で訂正を送れます。今の作業を止め、同じ会話でその訂正を続けます
- Studio：実行が終わったあとも、フロー図に通った道筋（ノードの枠と線の色、変数の値）を残します。線は緑＝通った、朱＝止まったノードへ、橙＝実行中。シナリオを編集したとき・次の実行・別のシナリオを開いたときに消え、実行ログの「図の色を消す」（右クリックにも）で手で消せます

### 変更

- Studio から AI にシナリオ作りを頼むと、作っている途中が見えるようにしました：AI が作ったシナリオを自動で開き（何も開いていないか、空のシナリオを開いているとき）、AI は名前だけで作ってからノードを数個ずつ足し、フロー図は足されたノードへ視点を移します。空のシナリオを開いて頼むと、AI はそこに組みます。AI がツール呼び出しを書いている間は AI ペインに「『ノードを追加』を書いています」、ステータスバーに「Claude Code が作業中・…」を出します

## [0.1.0] - 2026-11-06

### 追加

- 確認待ちのパネルを判断の順に組み替え：見出しは AI が書いた「何をするようになったか」、1 変わること（ノードごとに前と後をフロー図と同じ文で並べ、増えた語に色）、2 外への影響（サイト・ファイルの読み書きと削除・メール・コマンドのうち、今回新しくなるもの）、3 試しの結果（今の内容か、変えたノードを何個通ったか、出力とログ）、4 確かめてほしいこと。各ボタンが何をするか（確認して公開すると無人実行が次からこの内容で動く、など）を一文で出します（docs/design/review-evidence.md）
- MCP の編集ツールに `checks`（AI の仮定など、人にしか決められないことを 1 問ずつ）。ジャーナル（`HistoryEntry.checks`）に残り、`get_history` / `get_review` で読めます。Studio は「よい／違う…」で聞き、「違う…」は差し戻しのフォームを開きます
- シナリオをプロジェクト（フォルダー）として保存：`scenarios/<id>/scenario.json` の隣に `input/`・`config/`・`templates/`・`output/`・`work/`・`logs/` を置き、入力の Excel・設定ファイル・出力のひな形をシナリオと一緒に持てます。ステップのファイルの項目（ステップ型の `pathParams`）に書いた相対パスは、そのシナリオのフォルダーから解決します（サブシナリオは自分のフォルダーから）。従来の `scenarios/<id>.json` は保存先を開いたときにフォルダーへ移します（docs/files.md）
- 実行のたびに `work/` を空にし（`settings.keepWork` で残せる）、人が読む実行ログを `logs/<日時>_<結果>.log` に書きます（新しい 100 件を残す）
- 設定ファイルの形式 `{"format":"shikigami.config","items":[…]}` と、それを `{名前: 値}` で読む `config.read`
- MCP ツール `list_project_files` / `read_project_file` / `write_project_file` / `delete_project_file`、`test_step` の `scenarioId`、CLI の `shikigami scenario files` / `scenario add-file`
- Studio：フロー図の左に浮かぶ「プロジェクト」の棚。入力・設定・テンプレート・出力をロゴの 4 色で分け、どのノードが使っているか、Excel で開いたままか（`ProjectFile.inUse`）を出します。エクスプローラーからのドロップで追加（棚の上ならその棚、ほかは名前で振り分け）。設定ファイルはフォームで作って編集し、項目ごとに使っているノードを出します。テキストと実行ログもその場で開けます。ノードのファイルの項目は棚と同じ色で表示します
- バンドルとシナリオの複製に、プロジェクトのファイル（`output/`・`work/`・`logs/` を除く）を含めます
- 画像認識と OCR：部品が見えない画面（Citrix・リモートデスクトップ・独自描画）でも、`desktop.mouseClick` / `desktop.type` / `desktop.waitFor` / `desktop.isVisible` の `target` に `image`（PNG を画面から探す）か `ocr`（文字を OCR で探す）を書けます。`offset` で見つけた場所からずらし、`region` で探す範囲を絞り、複数見つかれば `nth` で選びます。新しいノード `desktop.readText`（ウィンドウ・部品・範囲・画像ファイルの文字を位置つきで OCR）と `desktop.screenshot`（PNG で保存。探す画像の切り出しにも使う）。OCR は PaddleOCR（PP-OCRv6 small、ONNX Runtime、オフラインで日本語・中国語・英語）が既定でインストーラに同梱（`pnpm studio:bundle-ocr`）、入っていなければ Windows OCR（`desktop.readText` の `engine` で使ったほうを返し、Windows OCR に落ちたときは `warning`。開発版は `pnpm studio:dev` が PaddleOCR を自動で用意）。PaddleOCR はラテン文字とそっくりな別の文字（`ı`・ギリシャ文字・キリル文字）を選ばない（「AI」が「Aı」にならない）。縦書きの行も上から読む。`accurate: true`（Studio の「高精度」）で手書きに強い大きいモデル（PP-OCRv6 medium、インストーラに同梱、数倍遅い）で読む。MCP の `inspect_ui` に `ocr`（文字と位置）と `image`（ウィンドウの絵を AI に返す）、ウィンドウの絵を観察に残す。Studio のノードにデスクトップの対象を言葉で表示（docs/desktop.md）
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
- 公開版：`shikigami version publish <id> [番号]` / `version unpublish <id>`、Studio のレビュー台の「承認して公開」と版タブの「公開」。記録は `versions/<id>/publish.jsonl`。`version list` は公開中の版に `published` を付けます。MCP の `run_scenario` に `published: true`、`get_scenario` / `list_versions` に `published`
- ワークスペースの `policy.json`：許可するサイト（`sites`：`browser.open`・`oauth.signIn`・`http.request`）・プログラム（`apps`：`desktop.launch`・`process.run`）と、AI の `run_scenario` / `test_step` / `delete_scenario` を危険度ごとに `allow` / `ask` / `deny`。外れたステップは `SITE_NOT_ALLOWED` / `APP_NOT_ALLOWED`、壊れた設定は `POLICY_INVALID` で止まります。CLI の `shikigami policy show|check|init`、MCP の `get_policy`、Studio の「許可と承認」。詳しくは `docs/policy.md`
- AI の操作の承認：`ask` の操作は `APPROVAL_REQUIRED`（`details.approvalId`）を返し、人が Studio か `shikigami approval approve <id>` で許可した同じ内容だけが 1 回動きます。`delete_scenario` / `run_scenario` / `test_step` に `approvalId` / `approvalWaitMs` / `approvalReason`
- プラグインのマニフェストの `steps[].targets`：サイト・プログラムを指す param を宣言すると、組込と同じ `policy.json` の検査を受けます
- 組込ステップ型 `pdf.readText`（PDF の文字を読む。パスワードはシークレットで渡せる）

### 変更

- **`shikigami run <シナリオID>` は公開版だけを動かすようになりました。** 公開版がなければ `NOT_PUBLISHED`（終了コード 2）で止まります。今までどおり作業中の内容を動かすには `--draft` を付けるか、`shikigami version publish <id>` で公開してください。ファイルを指定した `run` は変わりません
- シナリオのファイル形式を `schemaVersion` 3 にしました（`settings.keepWork` の追加。2 のファイルはそのまま読めます）。ファイルを含むバンドルは形式の版 2 で書き出し、**この版より古い Shikigami では読み込めません**（ファイルのないバンドルは従来どおり 1）
- 検証の `RELATIVE_PATH` をなくし、プロジェクトのフォルダーの外（`..`）を指すパスに `PATH_OUTSIDE_PROJECT` の警告を出すようにしました
- `dialog.message` / `dialog.input` のダイアログを Studio と同じ見た目に（白地と濃紺の文字、Windows のアプリがダークならダーク、日本語は Yu Gothic UI、ボタンは Windows の表示言語）。`dialog.selectFile` のフォルダー選択はエクスプローラーの画面に。Studio なしの `shikigami run` でも同じに出ます。ノードの指定と結果は変わりません
- シナリオのファイル形式を `schemaVersion` 2 にしました（`requires` の追加）。1 のファイルはそのまま読めて、次に保存したときに 2 になります。**2 で保存したファイルは、この版より古い Shikigami では開けません**
- プラグインのマニフェストの `version` は semver（`0.1.0` の形）が必須になりました
- 名前付きの版とバンドルの中のシナリオも、ファイルと同じ移行を通るようにしました

# Changelog

利用者から見える変更を記録します。書き方は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に、版番号は [Semantic Versioning](https://semver.org/lang/ja/) に従います。何が「約束」で、どう変えてよいかは [docs/compatibility.md](docs/compatibility.md) を参照してください。

`schemas/` が変わる Pull Request は、ここの「未リリース」にも書いてください（CI で確認します）。

## 未リリース

### 追加

- SAP GUI for Windows：SAP GUI Scripting が有効なら、同じ `desktop.*` のノードがスクリプトの仕組みを通して動きます（`inspect_ui` は SAP の部品 id と役割を一覧に、クリック・入力・読み取り・コンボボックス・ファンクションキー・メニューバー・`desktop.getTable` でテーブルコントロールと ALV グリッドの全行）。新しいノード `sap.runTransaction`（トランザクションを開き、ステータスバーを返す）。無効なときに SAP の部品 id を書くと `SAP_SCRIPTING_OFF`（有効にする手順つき）。実際の SAP ではまだ確認していません（docs/desktop.md「SAP GUI」）
- Java アプリ（Swing・AWT）：Java Access Bridge（`jabswitch -enable`）が有効なら、同じ `desktop.*` のノードがそれを通して動きます（`inspect_ui` は役割と名前で一覧に、クリック・入力・読み取り・一覧の選択・メニューバー・`desktop.getTable` で `JTable`）。無効なときは `JAVA_BRIDGE_OFF`（有効にする手順つき）（docs/desktop.md「Java アプリ」）
- 操作の記録（デスクトップ）：フロー図のドックの「記録」で、クリック（押した部品の対象つき）・入力欄の最終的な文字・Enter や Ctrl+S などのキーを書き留め、「そのままノードにする」か「AI に整えてもらう」を選べます。パスワード欄の文字は記録しません。元データはシナリオの `logs/recordings/` に残ります。デスクトップアダプターの inspect に `action: "record"`（docs/desktop.md）
- `desktop.getTable`：アプリの表・グリッド・一覧をまとめて読み、`browser.getTable` と同じ「列見出しをキーにしたオブジェクトのリスト」で返します。対応しているグリッドは画面外の行も読みます。10000 行を超えると `maxRows` を書かない限り `TABLE_TOO_LARGE`
- メールの送信 `mail.send`（dangerous、承認の対象）。`via` で送り方を選びます：`outlook`（既定、この PC の Outlook）、`microsoft365`（Microsoft Graph、`oauth.signIn` でサインインしたシークレットの `accessToken`、サイトに `https://graph.microsoft.com`）、`smtp`（`server`・`from`、ログインはシークレットでサイトに `smtp:<サーバー>`、パスワードは TLS なしでは送らない）。シークレットのサイトの書き方 `smtp:<サーバー>` を追加（docs/office.md）

## [0.1.2] - 2026-11-06

### 追加

- デスクトップのノード `desktop.selectMenu`（メニューバー・右クリックメニューの項目を上から名前でたどって選ぶ。アクセスキー `(F)`・`...`・ショートカットは省いてよい）、`desktop.scroll`（マウスを使わずに一覧や枠をスクロール、部品が見えるまで動かす。`atEnd` で最後まで来たかがわかる）、`desktop.mouseScroll`（マウスのホイール）、`desktop.drag`（マウスでドラッグ。別のウィンドウへも）、`desktop.hover`（マウスを重ねる）。マウスのノードは `target.ocr` / `target.image` / `target.point` も使えます（docs/desktop.md）
- 実行記録（`runStarted` イベントと `report.json`）に `origin`：どこから始めたか（`trigger`：`studio` / `mcp` / `cli` / `schedule` / `remote`）、頼んだもの（`requestedBy`）、ジョブ（`jobId`）、PC の名前（`machine`）。以前の記録はそのまま読めます
- `policy.json` に `records`（`keepDays`・`keepRuns`：各 PC が実行記録を残す日数と数。既定は消さない）と、管理サーバーからの実行の枠 `remote`（`enabled`・`manager`・`scenarios`・`acceptBundles`。既定は閉じる。まだ接続はしません）（docs/policy.md、docs/design/remote-runs.md）
- データベース：`db.query`（SELECT を 1 つ実行して列名をキーにしたレコードの配列に）と `db.execute`（INSERT・UPDATE・DELETE などを 1 つ実行して `{ rowsAffected }`）。ODBC 経由なので SQL Server・Oracle・Access・PostgreSQL などに使えます。値は `params` で SQL の `?` に入れます。接続文字列にパスワードは書かず、ログインはシークレット（`user` / `password`）で、シークレットのサイトに `db:<サーバー>` が要ります（Windows 認証なら不要）。ステップの分類 `database` と、シークレットのサイトの書き方 `db:<サーバー>` を追加（docs/database.md）
- PDF の結合・分割：`pdf.merge`（いくつかの PDF を 1 つに）、`pdf.extractPages`（`"1-3,5"`・`"2-"` で選んだページを新しい PDF に）、`pdf.split`（数ページずつのファイルに分けてパスの一覧を返す）。Acrobat は不要。新しいファイルには選んだページと、そのページが描くものだけを入れ、しおり・フォーム・ほかのページへのリンク、ほかのページだけが描く画像（共有の画像一覧に入っているもの）は引き継ぎません（docs/pdf.md）
- Studio のノードパレット：入力か出力を持つフローを「サブフロー」の分類にノードとして並べます。名前で探して選ぶと、そのフローの呼び出し（`scenario.call`）が足されます。開いているフロー自身と、入力も出力もないフローは並べません
- `list_scenarios` の各行に `inputs` / `outputs`（入力・出力の変数名。どちらもなければ省略）を足しました。呼び出せる形が一覧で分かります
- MCP ツール `ask_user_to_pick`：どのボタンかわからない（行ごとの「編集」、名前のないアイコンなど）とき、AI は推測せず人に指してもらいます。ブラウザに AI の言葉の帯が出て、迷っている候補には番号付きの枠が付き、人がクリックした部品を（ページには押させずに）`target` で受け取ります。同じ部品が並ぶときは `nth` と表の行の文字 `row` も返します。Studio にも「AI がブラウザの画面で指してほしいと言っています」と出て、そこから断れます。ブラウザアダプターに `pick` / `highlight` / `cancelPick`（`shikigami-browser` の inspect の `action`）、Studio が人の手で対象を選ぶときにも使えます
- Studio のブラウザのノードでも「画面から選ぶ」「光らせる」が使えます（実行中・止めているときに、そのブラウザで選ぶ）
- `test_step` は browser ノードを動かす前に、対象をブラウザ上で少しのあいだ枠で光らせます（「ここを押します」）
- `inspect_page` の `image: true`：スクリーンショットを AI にも渡します（ツリーだけでは見分けにくいページ向け）

### 変更

- AI への指示（MCP の説明・スキル）に「どれかわからなければ `nth` を当てずっぽうで選ばず、`ask_user_to_pick` で指してもらう」を加えました。`ELEMENT_AMBIGUOUS` のヒントも同じことを言います
- オンラインアップデートを VS Code と同じ流れに：新しい版は裏でダウンロードし、インストーラーの画面を出さずに入れます。設定の「再起動して更新」で数秒後に新しい版が開き直すか、Studio を閉じたときに入ります（この版から。0.1.1 からこの版への更新は従来どおり画面が出ます）

### 変更

- 無人実行の土台：マウス・キーボードを使うノード（`desktop.input`）は Studio・CLI・MCP サーバーをまたいで一度に一つだけ動きます（同じ Windows ユーザーのプロセスでロックファイルを共有）。画面ロック中・リモートセッションの切断中などは、そうしたノードが始める前に `DESKTOP_UNAVAILABLE` で止まります。実行を取り消しても `control.try` の `finally` を実行します（最長 60 秒）。プロセスが途中で終わった実行は、次の実行の開始時に `failed`・`RUN_INTERRUPTED` で閉じます

## [0.1.1] - 2026-11-06

### 追加

- ブラウザ：`browser.attach`。人が `--remote-debugging-port` 付きで開いた Edge・Chrome を、ログイン・証明書・拡張機能ごと使います（127.0.0.1 のみ、終わっても閉じない、`dangerous`）。Edge の IE モードのページはデスクトップのノードで扱う方針を docs/browser.md に（UI Automation で見えるかは未確認）

- ブラウザ：`browser.download`（押してダウンロードしたファイルを `path` か `folder` に保存）と `browser.upload`（ファイルの入力欄、またはファイル選択を開くボタンに添付）。パスはシナリオのフォルダーから。どちらも `dangerous` で、確認パネルの「外への影響」に出ます（docs/browser.md）

- ブラウザ：別のタブ・ポップアップへ移る `browser.switchTab` と閉じて戻る `browser.closeTab`、JS のダイアログ（alert・confirm・prompt）に答える `dialog`（`browser.click` / `browser.press` / `browser.open`。ダイアログの文を出力）、iframe・フレームセットの中の部品を指す `target.frame`、`browser.hover`・`browser.scroll`・`browser.getAttribute`。`inspect_page` と `ELEMENT_NOT_FOUND` の `details` にフレームとタブの一覧、閉じたダイアログ（docs/browser.md）
- Studio の AI ペイン：会話をシナリオごとに持ち、複数のシナリオで AI に並行して作業してもらえます。ペインは開いているシナリオの会話に切り替わり、見出しから会話を選べます（作業中・終わった印）。「新しいシナリオを作る」会話は、AI が作ったシナリオの会話になります。同じシナリオで同時に動く会話は一つだけです
- Studio の AI ペイン：AI の作業中でも「割り込む」で訂正を送れます。今の作業を止め、同じ会話でその訂正を続けます
- Studio：実行が終わったあとも、フロー図に通った道筋（ノードの枠と線の色、変数の値）を残します。線は緑＝通った、朱＝止まったノードへ、橙＝実行中。シナリオを編集したとき・次の実行・別のシナリオを開いたときに消え、実行ログの「図の色を消す」（右クリックにも）で手で消せます
- Studio：デスクトップのノードの「対象」に「画面から選ぶ」と「光らせる」を足しました。「画面から選ぶ」は Studio をしまい、マウスの下の部品を枠で囲んで追いかけ、クリックした部品の対象（ID、なければ種類と名前、それもなければウィンドウの中の位置）を入れます。クリックはアプリに渡しません。Esc か右クリックでやめます。「光らせる」は今の画面で対象を探し、見つかったら 2 秒枠で囲みます
- 名前付きの部品（`parts`）：画面のボタンや入力欄に名前を付けてシナリオに置き、ノードの対象を `{ "part": "saveButton" }` と書けます。画面が変わったら部品を 1 か所直せば、使っているノードすべてに効きます。Studio ではプロジェクトの「部品」に並び、ノードの対象の「部品にする」で作れます（同じ対象のノードもまとめて置き換え）。AI は編集の `setPart` / `removePart` を使います。シナリオの形式は `schemaVersion` 4 になります（古いファイルはそのまま読めます）

### 変更

- Studio：実行エラーを日本語（英語表示なら英語）で出します。エラーの `code` と `details`、ノードの設定から「何が起きたか」と「どうすればよいか」を組み、AI 向けの英語の原文は「英語の原文」を開くと読めます。実行ログの行も同じ言葉です。`code` を知らないエラー（プラグイン・`control.fail`）は元のメッセージのままです
- 実行エラーの `details` に名前と数値を足しました：`EXPR_UNDEFINED_VARIABLE` は `variable`、`EXPR_UNKNOWN_FUNCTION` は `function`、`STEP_TIMEOUT` は `timeoutMs`、`LOOP_LIMIT_EXCEEDED` は `maxIterations`、`MISSING_INPUT` は `input`
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

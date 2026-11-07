# Changelog

利用者から見える変更を記録します。書き方は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に、版番号は [Semantic Versioning](https://semver.org/lang/ja/) に従います。何が「約束」で、どう変えてよいかは [docs/compatibility.md](docs/compatibility.md) を参照してください。

`schemas/` が変わる Pull Request は、ここの「未リリース」にも書いてください（CI で確認します）。

## 未リリース

### 主な変更

- ノードの画面の「このノードだけ試す」は、実は先頭からそのノードまで全部を実行していました（手前の「メール送信」なども動きます）。ボタンを 2 つに分けました。「ノードの単体実行」は本当にそのノードだけを実行し、読む変数には前回の実行の値を使います。「ここまで実行」はこれまでの動き（先頭からそのノードまで実行して一時停止）です
- 右ペインはノードの設定の要約と「設定を開く」だけになりました。設定を変えるのはノードの画面（ダブルクリック）だけです

### 変更

- Studio：「ノードの単体実行」（Tauri の `test_step`）。前のノードは実行せず、実行の記録（`runs/`）にも残しません。読む変数に値がないときは押せず、理由を表示します。AI の `test_step` と同じ一ノードのフロー（`shikigami_runtime::single`）で動きます
- Studio：右ペイン（インスペクター）のノード表示は読むだけになり、設定・出力・実行の設定を「名前：値」で表示します
- アダプター：結果が表になるノードの列名は `Adapter::table_columns()` が答えます（これまでは excel・file の 2 種類を決め打ち）。プラグインも同じ形で加われます
- Studio：繰り返しの番号（`control.repeat` の `indexVar`）と `control.try` の `errorVar` を、変数を書き込む設定として扱います（変数の表・フロー図の出力に出ます）

## [0.1.7] - 2026-11-07

### 主な変更

- AI を使わずに手でフローを組むのが楽になりました。ノードをダブルクリックすると設定が画面いっぱいに開き、左の「使える値」（繰り返し中の行の列や、ほかの変数）をクリックするだけで入力欄に入ります。右の「このノードだけ試す」で、そのノードまで実行して結果をその場で確かめられます
- 繰り返しの「リスト」は、前のノードの結果（「rows（CSV を読むの結果）」など）から選ぶだけになりました。文字の設定欄には「変数」ボタンが付き、CSV・Excel の列名も実行する前から候補に出ます
- ノードの設定は必要な行だけを表示し、「＋ 設定を追加」で 1 行ずつ足せます。設定ファイルの画面は表になり、打てば保存されます
- 「画面から選ぶ」が、フローを実行していなくても使えるようになりました。上の「ページを開く」のアドレスを Shikigami がブラウザで開き、そこで部品をクリックします
- 検証の指摘は「「CSV を読む」の「ファイル」が入っていません」のように、設定の名前とノードの名前で表示します。ファイルの設定には「参照…」が付き、結果を入れる変数の名前は自動で付きます

### 追加

- Studio：ノードをダブルクリック（または右ペインの「開く」）で開くノードの画面。左「使える値」、中央「設定」、右「試した結果」（「このノードだけ試す」は前のノードから順に実行し、このノードの直後で止めます）。右ペインは要約と「開く」だけに
- Studio：文字の設定欄の「変数」ボタンと、式の欄の候補に、繰り返し中の行の列（`excel.readRows`・`file.readCsv` の見出しをファイルから読む）を表示。繰り返しの「リスト」は上にあるノードの結果から選択（式で書く道も残ります）
- Studio：設定は必須と値のあるものだけを表示し、「＋ 設定を追加」で足す（実行の設定も同じ）。設定ファイルの画面は 1 行 = 名前｜値｜種類の表で自動保存、作ると「設定ファイルを読む」をフローの先頭に置きます
- Studio：「画面から選ぶ」「光らせる」は、実行していないときはそのノードより上の一番近い「ページを開く」のアドレスを Shikigami 自身のブラウザで開いて使えます。開いたブラウザは次に選ぶときまで残ります。上に「ページを開く」がない・アドレスが変数のときは理由を表示（docs/browser.md）
- Studio：ファイルの設定に「参照…」（フローのフォルダーの外のファイルは取り込みます。フォルダーの設定はフォルダーを選びます）。結果を返すノードには結果の変数名（rows・text・response など）が自動で付き、新しい繰り返しは直前のノードの結果を回します

### 変更

- Studio：検証の指摘を、設定の名前とノードの名前を使った人の言葉にしました（コードや場所はツールチップへ）。「設定」「再試行の回数」「タイムアウト（ミリ秒）」「変更履歴」などの言葉を見直し、日本語の画面に英語の補足を出さないようにしました

## [0.1.6] - 2026-11-06

### 主な変更

- Microsoft Copilot など、Shikigami に直接つながらない AI でもフローを作れるようになりました。Studio の「AI の答えを貼り付け」から AI 向けの説明を保存して AI に渡し、返ってきた答えを貼り付けると、内容を確かめてフローに取り込みます
- 画面から部品を選ぶ・ログイン情報を登録するなど、人の手直しが必要なところは「要手直し」として一覧とフロー図に表示されます
- ノードの設定欄・選択肢・エラーの文を、プログラムの名前ではなく分かる言葉で表示するようにしました（例：「上書きする」「文字コード」）

### 追加

- MCP を使えない AI（Microsoft Copilot など）でフローを作る：`shikigami ai-guide`（Studio の「AI の答えを貼り付け」›「仕様書を保存」）が AI に読ませる指示（8,000 文字未満）と詳細（全ノード・関数）を書き出し、AI の答え（`{ "format": "shikigami.answer", "summary", "checks", "flow" }`、前後の文章つきでも可）を Studio に貼り付けると検証して取り込みます。人の手直し（部品を画面から選ぶ・ログイン情報の登録・入力ファイル）は一覧とフロー図の「要手直し」で、AI の誤りは AI に返す文面のコピーで示します。取り込みは「AI（貼り付け）」の変更として確認待ちに入ります（docs/ai-chat.md）
- フロー形式：部品（`parts`）の `target` を省けるようにしました。省いた部品は人が画面から選ぶまで、それを使うノードが `PART_NOT_PICKED` で検証を通りません。変更履歴の `actor.kind` に `chat`（AI の答えの貼り付け）を追加

### 変更

- Studio：ノードの設定欄と選択肢を、プログラムの名前（`sheet`・`overwrite`・`shift_jis` など）ではなく人の言葉で表示します。保存形式は変わりません。エラー文と画面の開発用語（MCP・CLI・リビジョン・finally など）も言い換えました。README の先頭に、インストールから始める「使い始める」を追加

## [0.1.5] - 2026-11-06

### 主な変更

- 式を書かなくても値を加工できるようになりました。表の列の合計、絞り込み、空白を除く、日付の書式など、よく使う加工はフォームで選んで入力するだけです
- 式を書く欄では、変数が色で分かり、変数・表の列・関数の候補と、前回の実行の値で計算した結果が表示されます

### 追加

- Studio：式を書かずに値を加工できます。「変数に代入」のよくある式（表の列の合計、絞り込み、空白を除く、日付の書式など 27 種）はインスペクターで「加工：表の列を集計／表／列」のフォームになり、フロー図の文も「total に rows の「金額」の合計を入れる」と読めます。式の欄は変数を色で示し、変数・表の列・関数の候補と関数の説明、前回の実行の値で計算した結果を表示します。フローの保存形式は変わりません

## [0.1.4] - 2026-11-06

### 主な変更

- 現場の人向けの実行画面「Shikigami 実行」：公開されたフローを選び、入力欄に記入して実行できます。ファイルの選択・カレンダー・選択肢の入力欄、タスクトレイのアイコンにも対応しました
- 「自動実行」：毎日・曜日・毎月などの決まった時刻にフローを実行するスケジュールを、Studio の画面で設定できます。失敗したときに Teams・Slack へ知らせることもできます（この通知の設定は、今は設定ファイルに書きます）
- 値によって処理を分ける「値で分岐」ノードを追加しました（VBA の Select Case と同じ考え方です）
- 停止ボタンで実行を確実に中止できるようになりました
- Web ページに埋め込まれた画面（iframe）の部品も「画面から選ぶ」で指定できます
- 分岐・繰り返しの枠の最後にもノードを追加できる「＋」を付けました。設定画面も見やすく作り直しました

### 追加

- Studio のフロー図：分岐・繰り返しの枠の最後にも「＋」が出て、その中の最後にノードを足せます
- 値で分岐（VBA の Select Case）：`control.switch`（`value` / `cases` / `default`）と `control.case`（`values` か `condition`）。上から最初に当たったケースだけを実行し、どれにも当たらなければ `default`。検証コード `NOT_A_CASE` / `CASE_OUTSIDE_SWITCH`。フローの形式は変わりません。Studio ではケースごとの枝と「ケースを追加」を表示
- ブラウザの「画面から選ぶ」と `ask_user_to_pick` で、iframe の中の部品も指せるようになりました。指した部品は `target.frame` 付きで返ります（フレームの中のフレーム、別のサイトの iframe も）。「光らせる」も iframe の中の部品に効きます。`target.frame` は 4 段まで書けます（これまでは 2 段）
- Studio に「自動実行」：エージェントの状態（実行中のフロー）と「エージェントを開始」・停止、スケジュールの一覧・追加・編集・有効と無効（次と前回の時刻つき、公開版がないものは警告）。フローのインスペクターに「スケジュール」の節
- Studio：現場の人が使う実行画面「Shikigami 実行」（別ウィンドウ）。公開されたフローだけが並び、入力変数から作るフォームで入力し、公開版を実行。実行中は一番上の段のノードの進み、終わると出力変数と `output/` に書いたファイル、失敗は日本語のエラー。サイドバーの「実行画面」か、Studio を `--runner` で起動して開く（docs/runner.md）
- 実行画面の入力欄：変数に任意の印 `format`（`file`・`folder`・`date`・`month`）と `choices`（選択肢）を書くと、実行画面がファイル・フォルダーを選択する「参照…」、カレンダー、選択肢の一覧を出します。検査のエラー `INVALID_VARIABLE_FORMAT` / `INVALID_VARIABLE_CHOICES`。フロー形式 `schemaVersion` 6（古いファイルはそのまま読めます。6 のファイルは 0.1.3 までの Shikigami では開けません）（docs/runner.md）
- タスクトレイのアイコン：クリックで実行画面、右クリックで「実行画面を開く」「Studio を開く」「終了」。`--runner` で起動すると実行画面を閉じてもトレイに残り、`--tray` でトレイだけで起動します（docs/runner.md）
- 無人実行の通知：`policy.json` の `notify` に Teams（ワークフローの Webhook）・Slack・任意の Webhook を書くと、エージェントのスケジュールと `shikigami run` の失敗（`on` で成功・取り消しも）を、フロー・エラー・PC・時刻つきで知らせます（docs/schedules.md）
- 管理サーバー（プロトコル v1、docs/remote.md）：`shikigami agent enroll <URL> <コード>` で PC を一度だけ使える登録コードで登録（鍵の組は PC で作り、秘密鍵は資格情報マネージャー）。`policy.json` の `remote` で許したフローの公開版だけを、手が空いたエージェントが自分から取りに行き、イベントとレポートを返す。サーバーでの取り消し、断ったジョブ（`REMOTE_NOT_ALLOWED` / `NOT_PUBLISHED` / `VERSION_MISMATCH`）、`shikigami agent unenroll`、`agent status` にサーバーとの接続。参考実装のサーバー `shikigami manager serve`（登録コード・ワーカー・ジョブの管理用 API）
- 監査の記録 `shikigami audit`：変更・公開・AI（MCP）の操作・実行を、誰がどこからしたかつきで 1 つの一覧に（`--since` / `--until` / `--flow` / `--json`）。`records.keepDays` は MCP の呼び出しの記録も期限で削除します（docs/audit.md）

### 変更

- Studio の設定画面：中央の細い列に枠を積む形をやめ、左に節の目次・右に幅いっぱいの節を並べる形に。各設定は左に名前と補足、右に入力欄の 1 行にそろえ、言語・テーマの切り替えは名前つきに

### 修正

- 停止ボタンが効かないように見えることがあったのを直しました。押すと「中止しています…」と出し、`finally`（後片付け）の途中でもう一度押せばそれも待たずに中止します（Studio・実行画面・MCP `stop_flow`）。後片付けに応答しないアダプターがあっても、実行は 15 秒以内に終わります。終わりの知らせが届かず「実行中」のまま残った表示も、停止を押せば元に戻ります

## [0.1.3] - 2026-11-06

### 変更（呼び名：シナリオ → フロー）

- 「シナリオ」を「フロー / Flow」に改名しました（サブシナリオは「サブフロー / Subflow」）。Studio・ドキュメント・MCP・CLI・保存形式のすべてが対象です。製品名 Shikigami は変わりません
- 保存先：`scenarios/<id>/scenario.json` は `flows/<id>/flow.json` になりました。古いワークスペースは開いたときに自動で移します（ごみ箱の中も）
- フロー形式 `schemaVersion` 5：呼び出しノード `scenario.call { scenario }` は `flow.call { flow }` になりました。古いファイル・版・バンドルは読み込み時に自動で書き換えます
- バンドルの `format` は `shikigami.flowBundle`、中身は `flow` / `subflows` です。0.1.2 までの `shikigami.scenarioBundle` も読めます
- MCP ツール：`list_flows` / `get_flow` / `validate_flow` / `export_flow` / `create_flow` / `update_flow` / `delete_flow` / `import_flow` / `extract_subflow` / `run_flow` / `stop_flow`、引数は `flowId`。旧名（`create_scenario` など）と `scenarioId` も当面は受け付けます（一覧には出しません）
- CLI：`shikigami flow …`（`shikigami scenario …` も当面は動きます）
- policy.json：`flows`、`ai.runFlow` / `ai.deleteFlow`（旧名 `scenarios` / `runScenario` / `deleteScenario` も読めます）
- **互換性のない変更**：出力側の名前は新しい名前だけになります。エラーコード `SCENARIO_*` は `FLOW_*`（`SUBSCENARIO_NOT_PUBLISHED` は `SUBFLOW_NOT_PUBLISHED`）、`run --json` と MCP の結果の `scenarioId` / `scenarioName` / `scenario` は `flowId` / `flowName` / `flow` です

### 追加

- 業務別のチュートリアル 3 本（`docs/ja/tutorials/`、英語は `docs/tutorials/`）：支店の売上 CSV を 1 つの Excel に、受注一覧から取引先ごとの Word 請求書、Web の受注システムで出荷。見本のファイルと完成形のフロー（`examples/tutorials/*.shikigami.json`、「ファイルから読み込む」で開ける）付き
- Studio のフローの画面の下に「見本」：チュートリアルの手順のページを開く、完成形のフローを見本のファイルごと開く
- SAP GUI for Windows：SAP GUI Scripting が有効なら、同じ `desktop.*` のノードがスクリプトの仕組みを通して動きます（`inspect_ui` は SAP の部品 id と役割を一覧に、クリック・入力・読み取り・コンボボックス・ファンクションキー・メニューバー・`desktop.getTable` でテーブルコントロールと ALV グリッドの全行）。新しいノード `sap.runTransaction`（トランザクションを開き、ステータスバーを返す）。無効なときに SAP の部品 id を書くと `SAP_SCRIPTING_OFF`（有効にする手順つき）。実際の SAP ではまだ確認していません（docs/desktop.md「SAP GUI」）
- Java アプリ（Swing・AWT）：Java Access Bridge（`jabswitch -enable`）が有効なら、同じ `desktop.*` のノードがそれを通して動きます（`inspect_ui` は役割と名前で一覧に、クリック・入力・読み取り・一覧の選択・メニューバー・`desktop.getTable` で `JTable`）。無効なときは `JAVA_BRIDGE_OFF`（有効にする手順つき）（docs/desktop.md「Java アプリ」）
- 操作の記録（デスクトップ）：フロー図のドックの「記録」で、クリック（押した部品の対象つき）・入力欄の最終的な文字・Enter や Ctrl+S などのキーを書き留め、「そのままノードにする」か「AI に整えてもらう」を選べます。パスワード欄の文字は記録しません。元データはフローの `logs/recordings/` に残ります。デスクトップアダプターの inspect に `action: "record"`（docs/desktop.md）
- `desktop.getTable`：アプリの表・グリッド・一覧をまとめて読み、`browser.getTable` と同じ「列見出しをキーにしたオブジェクトのリスト」で返します。対応しているグリッドは画面外の行も読みます。10000 行を超えると `maxRows` を書かない限り `TABLE_TOO_LARGE`
- メールの送信 `mail.send`（dangerous、承認の対象）。`via` で送り方を選びます：`outlook`（既定、この PC の Outlook）、`microsoft365`（Microsoft Graph、`oauth.signIn` でサインインしたシークレットの `accessToken`、サイトに `https://graph.microsoft.com`）、`smtp`（`server`・`from`、ログインはシークレットでサイトに `smtp:<サーバー>`、パスワードは TLS なしでは送らない）。シークレットのサイトの書き方 `smtp:<サーバー>` を追加（docs/office.md）
- Excel 本体での操作：この PC の Excel でブックを開いているときは、`excel.*` の読み書きがファイルではなく開いているブックに働きます（画面の内容を読み、書いたら保存、Excel は閉じない）。`excel.recalculate`（数式を計算し直して保存）、`excel.sort`（見出しの列で並べ替え）、`excel.exportPdf`（ブックかシートを PDF に）を追加。どれもデスクトップ版 Excel が要り、ブックが開いていなければ見えない別の Excel を使います（docs/office.md）
- Excel の書式・フィルター・ピボット：`excel.format`（太字・色・塗りつぶし・表示形式・配置・罫線・列幅）、`excel.filter`（見出しの列と値で絞り込み、`clear: true` で解除）、`excel.pivot`（見出しでまとめて合計・件数などを新しいシートに）を追加。どれもデスクトップ版 Excel が要り、開いているブックがあればそれを使います（docs/office.md）
- スケジュールとエージェント：`shikigami agent install` で PC ごとのエージェントがサインイン時に起動し、`schedules.json` のスケジュール（毎日・曜日・毎月・n 分ごと・1 回）と、フォルダーにファイルが置かれたときに公開版を実行します。`shikigami agent status / stop / run / uninstall`、`shikigami schedule list / add / remove / enable / disable`（docs/schedules.md）

### 変更

- Studio：実行エラーの言い換えを 2 つ直しました。`INVALID_ADDRESS` は CC・BCC の形の誤りも含めて、`SECRET_DECRYPT_FAILED` はそのシークレットを登録し直す案内にしました

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

# WinActor・UiPath・Power Automate Desktop と比べて足りないもの（2026-11-06）

目的：既存の RPA 製品と並べたときに Shikigami が劣る点・欠けている機能を、リポジトリの実装と docs を根拠に洗い出し、影響の大きさで並べる。**実装はしない**（ここは一覧と優先度だけ。着手は項目ごとに決める）。

前提にする方針（変えない）：

- 差別化の軸は「AI が作り、AI なしで動く」。AI がシナリオを組み、実行は決まった JSON を Runtime が動かす
- Windows 特化（mac / Linux はやらない）、OSS（Apache-2.0）で当面無償
- 組込以外のノードはプラグイン（別プロセス・JSON-RPC、[plugins.md](plugins.md)）
- 値の加工は式の関数、外に触れる操作だけノード（[uipath-coverage.md](uipath-coverage.md)）

比較相手の機能は、各社の公開情報から一般に知られている範囲で書いた（細かい版・価格は確かめていない）。Shikigami 側は本文中のファイルを根拠にした。

## 優先度の決め方

| 優先度 | 意味 |
|---|---|
| **P0** | 導入の前提を欠く。ないと企業の PC で入らない・無人で動かない・日本の業務システムに届かない |
| **P1** | 多くの業務で困る。比較表で必ず「×」が付き、乗り換えを止める |
| **P2** | 特定の業種・規模・使い方で効く。プラグインや後回しでもよい |

「重なり」欄：進行中の別の取り組みと重なる項目。

- **#77**：離れた所からの実行指示と管理ツール（`shikigami agent`、設計メモ PR #77、draft）
- **部品選択**：画面から部品を選ぶ機能（別スレッドで進行中）

## 一覧（要約）

| # | 優先度 | 項目 | 主に強い相手 | 重なり |
|---|---|---|---|---|
| 1 | P0 | スケジュール実行・トリガーがない | WinActor・PAD・UiPath | #77 |
| 2 | P0 | 無人実行の土台（画面ロック・PC 間の入力排他・キャンセル時の後始末・再開） | UiPath・PAD | #77 |
| 3 | P0 | 人が画面を指して部品を選ぶ・光らせて確かめる手段がない | 3 製品すべて | 部品選択 |
| 4 | P0 | Edge の IE モード・既に開いているブラウザを操作できない | WinActor・UiPath・PAD | – |
| 5 | P0 | 実際の業務アプリ・SAP・Java・Citrix で未検証、SAP / Java の経路が未実装 | UiPath・WinActor | – |
| 6 | P0 | インストーラーが未署名、企業での配布・更新の統制がない | 3 製品すべて | – |
| 7 | P1 | 実行時のエラーメッセージが英語のまま Studio に出る | WinActor | – |
| 8 | P1 | 管理サーバー（PC 一覧・ジョブ・キュー・集中ログ・共有の設定値）がない | UiPath・WinActor・PAD | #77 |
| 9 | P1 | 失敗の通知（メール・Teams）がない | UiPath・PAD | #77 |
| 10 | P1 | 操作の記録（レコーダー）がない。AI を使えない職場で作りにくい | WinActor・PAD・UiPath | 部品選択（一部） |
| 11 | P1 | ブラウザ操作の欠け（タブ・ポップアップ・iframe・ダウンロード・アップロード・JS ダイアログ・ホバー・スクロール） | 3 製品すべて | – |
| 12 | P1 | デスクトップ操作の欠け（スクロール・ドラッグ・ホバー・表の一括読み・メニュー辿り） | 3 製品すべて | – |
| 13 | P1 | 画面の部品を名前を付けて共有する場所（UiPath のオブジェクトリポジトリ、PAD の UI 要素）がない | UiPath・PAD | 部品選択 |
| 14 | P1 | Excel：開いているブックの操作・書式・フィルター・並べ替え・ピボット・再計算・PDF 保存がない | 3 製品すべて | – |
| 15 | P1 | メール：Outlook（クラシック）だけ・送信なし・SMTP / IMAP / Microsoft 365（Graph）なし | 3 製品すべて | – |
| 16 | P1 | データベース（SQL Server・Oracle・Access・ODBC）のノードがない | 3 製品すべて | – |
| 17 | P1 | 人が起動するための軽い実行画面と、複数項目の入力フォームがない | UiPath・PAD・WinActor | #77（一部） |
| 18 | P1 | 業務の人向けの学習資料（操作マニュアル・チュートリアル・業務別サンプル）がない | 3 製品すべて | – |
| 19 | P2 | 帳票の項目を読む OCR（AI-OCR・請求書など）、PDF の結合・分割・表の読み取り | UiPath・WinActor（連携製品） | – |
| 20 | P2 | シナリオのテスト（テストケース・モック・自動回帰） | UiPath | – |
| 21 | P2 | 複数人での開発（同じシナリオの同時編集・マージ・編集中の印） | UiPath | – |
| 22 | P2 | プラグインの配布（インストール・カタログ・署名）と部品の数 | UiPath・WinActor | – |
| 23 | P2 | SaaS へのつなぎ（kintone・Salesforce・Box・Slack など）が `http.request` 頼み | UiPath・PAD | – |
| 24 | P2 | 汎用機の端末エミュレーター、FTP / SFTP、XML | UiPath・PAD | – |
| 25 | P2 | 実行記録の保管期間・監査の一元化 | UiPath | #77 |
| 26 | P2 | 有償サポート・販売パートナー・研修と認定 | WinActor・UiPath | – |

## P0：導入の前提

### 1. スケジュール実行・トリガーがない（重なり：#77）

- **今**：無人実行は Windows のタスクスケジューラーから `shikigami run` を呼ぶ前提（[policy.md](../policy.md) §1、[compatibility.md](../compatibility.md) §1）。Studio には置き場所だけ決めてある（[ui-principles.md](ui-principles.md)「スケジュール実行・トリガー」）。実行記録の `trigger` に `schedule` の値は予約済み（[architecture.md](../architecture.md) §8）
- **相手**：WinActor は製品の中でスケジュールを組める。PAD はクラウドフローから日時・メール・ファイルなどのトリガーで起動できる。UiPath は Orchestrator のトリガー（時刻・キュー・イベント）
- **影響**：タスクスケジューラーの設定は業務の人には難しく、「毎朝 8 時」すら Studio で完結しない。ファイルが置かれたら・メールが来たら、の起動もない
- **方向**：#77 の `shikigami agent` に実行を集め、日時・ファイル・メールのトリガーをそこに置く案と合わせて決める

### 2. 無人実行の土台（重なり：#77）

- **今**（[desktop.md](../desktop.md)「How it works」「Verified and limits」、[architecture.md](../architecture.md) §13 Known limits）
  - 画面がロックされていると前面に出せず `FOREGROUND_DENIED` / `INPUT_BLOCKED` で止まる。ロック中・ログオフ中に Windows のセッションを用意する仕組みはない
  - マウス・キーボードの排他は 1 プロセスの中だけ。Studio・CLI・MCP サーバーが同時に動くと取り合う
  - `control.try` の `finally` はキャンセル時に走らない。プロセスが落ちたあと途中から再開できない
- **相手**：UiPath の無人ロボットは Windows にサインインしてセッションを作ってから動く。PAD の無人実行も同様（ロックされた PC で動く）
- **影響**：夜間・休日の無人運用が実質できない。「AI なしで動く」を一番売りたい場面で弱い
- **方向**：#77 のメモにある「排他・画面ロック検知・キャンセル時 finally」と同じ。ロック中の自動サインインは資格情報の扱いを含めて別に設計が要る

### 3. 人が画面を指して部品を選ぶ手段がない（重なり：部品選択）

- **今**：部品の特定は AI が `inspect_ui` / `inspect_page` の木から写す前提（[desktop.md](../desktop.md)、[browser.md](../browser.md)）。Studio では項目ごとの入力欄で `id` / `role` / `name` を打つ（PR #72）。「UI element inspector」は未実装（[architecture.md](../architecture.md) §13）。指定した部品を画面上で光らせて確かめる機能もない
- **相手**：3 製品とも「画面上の部品をクリックして選ぶ」「選んだ部品を光らせる」が基本の操作
- **影響**：AI を通さずに直すとき（AI が使えない日、AI に頼むほどでもない小さな直し）に止まる。「AI が作り」の後の保守を人がやれない
- **方向**：進行中のスレッドで扱う。そこで光らせる（ハイライト）・今の画面で見つかるか試す、まで含めるとよい

### 4. Edge の IE モード・既に開いているブラウザを操作できない

- **今**：ブラウザは Playwright が Edge / Chrome を自分で起動して操作する（[browser.md](../browser.md)「How it works」）。ログイン状態は `session` で保存して使い回せるが、人が開いているブラウザに後から入ることはできない。IE モードのタブは Playwright（CDP）から操作できない
- **相手**：WinActor・UiPath・PAD はブラウザ拡張や IE 用の仕組みで、人が開いたブラウザ・IE モードのページも操作できる
- **影響**：日本の社内システムには IE モードでしか動かないものがまだ多い。拡張機能や証明書・SSO で「人のブラウザでしか入れない」社内サイトもある。対象に届かなければ他の強みは効かない
- **方向**：IE モードはデスクトップ側（UI Automation）で扱えるかをまず確かめる（IE モードのタブは UIA で部品が見えることが多い）。人のブラウザへの接続は `--remote-debugging-port` で起動したブラウザに CDP でつなぐ案と、拡張機能を作る案を比べる
- **対応**：人が開いたブラウザは `browser.attach`（`--remote-debugging-port` と専用の `--user-data-dir` で起動した Edge / Chrome に 127.0.0.1 でつなぐ、終わっても閉じない、PR #88）。拡張機能の案はとらない。IE モードは `desktop.*` で扱う。Windows CI の実験（`crates/shikigami-desktop/tests/ie_mode.rs`、PR #98）で、IE11 のエンジンで出したページの部品が UI Automation に `id` 付きで出て、入力とクリックも効くことを確かめた（[browser.md](../browser.md)「Edge IE mode」）。残り：どちらも実機の Edge での確認

### 5. 実際の業務アプリで未検証、SAP / Java の経路が未実装

- **今**：「Not yet verified: real business apps, SAP GUI, Java apps and Citrix; mouse and keyboard actions; high DPI and multiple monitors」（[desktop.md](../desktop.md)）。SAP GUI Scripting と Java Access Bridge は「Planned」。版は 0.1.0
- **相手**：UiPath は SAP・Java・Citrix（Remote Runtime）それぞれに専用の経路がある。WinActor は国内の業務アプリでの実績が長い
- **影響**：安定性はカタログでは比べられず、実績と事例で比べられる。未検証のままでは評価の土俵に乗らない
- **方向**：代表的な業務アプリ（会計・販売管理・SAP GUI・Java 製の社内システム・Citrix）での検証の一覧を作り、結果を docs に「動作確認済み」として残す。SAP / Java の経路は [desktop.md](../desktop.md) の計画どおり

### 6. インストーラーが未署名、企業での配布・更新の統制がない

- **今**：Authenticode の署名なし、初回に SmartScreen の警告（[release.md](../release.md)「Notes」）。更新は Studio が GitHub Releases の最新を見て入れる。社内で版を固定する・社内のサーバーから配る・まとめて入れる（サイレントインストール）手順は書いていない
- **相手**：3 製品とも署名済みで、企業向けの配布（MSI・Intune・社内配布）と版の管理がある
- **影響**：情報システム部門が未署名の exe を通すことはまずない。管理者権限なしで入る NSIS は、逆に「勝手に入る」と嫌われることもある
- **方向**：コード署名証明書の取得（費用が要る。OSS 向けの無償署名サービスも候補）、MSI のサイレントインストールと更新を止める設定・社内配布先を指定する設定の手順

## P1：多くの業務で困る

### 7. 実行時のエラーメッセージが英語のまま出る

- **今**：Runtime・アダプターのエラーは英語（例：`crates/shikigami-desktop/src/target.rs:367` の `no open window matches target.window`）。Studio は `error.message` をそのまま出す（`apps/studio/src/components/RunPausePanel.tsx:249`）。UI の文言は日英あるが、エラーは訳されない
- **相手**：WinActor は日本語が母語。UiPath・PAD も日本語のメッセージを出す
- **影響**：止まったときに一番読む文が英語。日本語で売るときに真っ先に気になる
- **方向**：`code` は契約で固定（[compatibility.md](../compatibility.md) §6）なので、Studio 側で `code` と `details` から日本語の説明を組む（`message` は AI 向けの英語のまま残す）
- **対応**：Studio の `apps/studio/src/lib/errorText.ts` と `locales/errors.{ja,en}.ts` で、約 150 の `code` を「何が起きたか・どうすればよいか」に言い換える。一時停止パネルと実行ログで使い、英語の原文は折りたたみで残す。残り：検証結果（問題の一覧）の `message` / `hint` はまだ英語

### 8. 管理サーバーがない（重なり：#77）

- **今**：PC ごとのワークスペースだけ。共有は共有フォルダーかバンドル（[sharing-versioning.md](sharing-versioning.md)）
- **相手**：UiPath Orchestrator（ロボット・ジョブ・キュー・アセット・ログ）、WinActor の管理製品（WinDirector など）、PAD の Power Automate ポータル
- **影響**：10 台を超えると、どの PC で何がいつ失敗したかを追えない。キュー（1 件ずつ処理を配る）もない
- **方向**：#77 のとおり。キューは「預けは期限付き・空いた PC が取りに行く」案の延長で扱える

### 9. 失敗の通知がない（重なり：#77）

- **今**：通知の置き場所は Studio の中だけ（[ui-principles.md](ui-principles.md)「通知」）。無人実行が失敗しても誰にも届かない
- **相手**：UiPath（Orchestrator のアラート・メール）、PAD（クラウドフローで Teams・メール）
- **方向**：シナリオに書かせる（`mail.*` や `http.request` を `catch` で呼ぶ）のではなく、実行の受け持ち（#77 の agent）の設定にする。AI が毎回書くものを増やさない

### 10. 操作の記録（レコーダー）がない

- **今**：記録機能はない（`grep` で該当なし。`RunRecorder` は実行記録で別物）。作るのは AI か、Studio のパレットから 1 つずつ（PR #70）
- **相手**：WinActor は「記録」で操作をそのままシナリオにするのが入口。PAD・UiPath にもレコーダーがある
- **影響**：方針上 AI が代わりをするが、**生成 AI の利用を禁じている職場**では入口がない。WinActor から来る人は「まず記録」を期待する
- **方向**：記録した操作を AI がまとめ直す「記録 → AI が整える」にすれば方針と両立する。最低限は部品選択（#3）とパレットで手で組めること。どこまでやるかは決めが要る

### 11. ブラウザ操作の欠け

- **今**（[browser.md](../browser.md)「Nodes」、[architecture.md](../architecture.md) §13）：ダウンロード・アップロードは未実装と明記。`context` ごとに 1 ページで、新しいタブ・ポップアップへの切替のノードはない。`target` に iframe の指定はない。`alert` / `confirm` の扱い、ホバー、スクロール、属性（`href` など）の取得、ページ送りしながらの表の取得もない
- **相手**：3 製品とも標準
- **影響**：業務サイトの多くで「CSV をダウンロードする」「ファイルを添付する」「別ウィンドウで開く」が出てくる。ここで止まる
- **方向**：組込ノードとして足す（外に触れる操作なので方針どおりノード）。ダウンロードは `file.*` と同じくプロジェクトフォルダー基準の保存先にする
- **対応**：`browser.switchTab` / `browser.closeTab`、出す操作のノードの `dialog`（alert / confirm / prompt）、`target.frame`（iframe）、`browser.hover` / `browser.scroll` / `browser.getAttribute`（PR #83）、`browser.download` / `browser.upload`（保存先・添付するファイルはプロジェクトフォルダー基準、PR #88）。ページ送りしながらの表は既存のノードのくり返しで読む書き方を [browser.md](../browser.md)「Tables across pages」に追加（PR #98）。残り：実機の Edge での確認

### 12. デスクトップ操作の欠け

- **今**（[desktop.md](../desktop.md)）：スクロール・ドラッグ・ホバー・マウス移動のノードはない。「Reading a whole grid at once and walking through menus are not implemented」。デスクトップの表を一度に読めない
- **相手**：3 製品とも標準（UiPath・PAD は表のデータ抽出、WinActor はリスト・表の取得）
- **影響**：販売管理・会計ソフトの一覧画面から表を読む、は RPA の典型。1 セルずつ読むのは遅く、AI が組んでも長いシナリオになる
- **方向**：`desktop.getTable`（`browser.getTable` と同じ形の配列で返す）、`desktop.scroll`、`desktop.drag` を組込で

### 13. 画面の部品を名前を付けて共有する場所がない（重なり：部品選択）

- **今**：`target` はノードごとにその場で書く。同じ「保存ボタン」を 10 ノードが使えば 10 か所に書く
- **相手**：UiPath のオブジェクトリポジトリ、PAD の UI 要素の一覧。画面が変わったら 1 か所直せば済む
- **影響**：画面の改修のたびに直す箇所が多く、AI が直してもレビュー（確認待ち）が膨らむ
- **方向**：AI が組みやすい仕様（1 つのことは 1 通り、[ai-authoring.md](ai-authoring.md)）と衝突しうるので慎重に。プロジェクトフォルダーに名前付きの対象を置き、ノードはその名前を参照する形なら、AI は名前だけ書けばよくなる。部品選択の結果をどこに保存するかと同時に決める

### 14. Excel の欠け

- **今**（[office.md](../office.md)）：xlsx をファイルとして直接読み書き。Excel で開いているブックは `FILE_IN_USE`。書式・フィルター・並べ替え・ピボット・数式の再計算・PDF 保存はない（COM は `excel.runMacro` だけ）
- **相手**：3 製品とも、開いている Excel を COM で操作できる（PAD の Excel アクションは COM が基本）
- **影響**：「人が開いて見ているブックに追記する」「数式を再計算した結果を読む」「PDF にして送る」は日本の事務で頻出
- **方向**：ファイル直接を既定のまま、COM の「開いているブック」を別の入口として足す（デスクトップと同じく backend を自動で選ぶ形が AI に優しい）

### 15. メールの欠け

- **今**（[office.md](../office.md)）：Outlook（クラシック）の COM のみ。下書き・一覧・添付の保存。送信はない。SMTP・IMAP・Microsoft 365（Graph）・Gmail はない
- **相手**：3 製品とも送信と複数の方式がある
- **影響**：送信できないので通知・報告の自動化が完結しない。新しい Outlook への移行が進むとクラシックの COM が使えない PC が増える
- **方向**：`mail.send`（危険度 Dangerous、承認の対象）と Graph の backend を先に。SMTP は社内メールサーバー向け

### 16. データベースのノードがない

- **今**：該当なし（組込ノード一覧に `db.*` なし）
- **相手**：3 製品とも SQL の実行がある
- **影響**：基幹システムの DB から抜いて Excel にする、は定番。`process.run` で `sqlcmd` を呼ぶのは AI にも人にも筋が悪い
- **方向**：`db.query` / `db.execute`（ODBC と SQL Server を先に。接続文字列はシークレット）。プラグインでなく組込にするかはここで決める

### 17. 人が起動する軽い実行画面・入力フォームがない（重なり：#77 一部）

- **今**：起動は Studio か CLI。人への入力は `dialog.input`（1 行）、`dialog.message`、`dialog.selectFile` だけ（[system.md](../system.md)）
- **相手**：UiPath Assistant、PAD のコンソール、WinActor の簡易実行の画面。複数項目のフォーム（UiPath のフォーム、PAD のカスタムフォーム）
- **影響**：現場の人に「公開版を押して動かすだけ」の画面を渡せない。Studio は作る人の道具で、使う人には重い
- **方向**：公開版だけが並ぶ小さな実行画面（タスクトレイ）。入力はシナリオの入力変数から自動でフォームを作れば、AI は何も書かなくてよい

### 18. 業務の人向けの学習資料がない

- **今**：docs は設計と仕様（英語が主、日本語は `docs/ja/`）。開発者・AI 向けで、操作マニュアル・チュートリアル・業務別のサンプル集はない。サンプルは `examples/` の数本
- **相手**：UiPath Academy、Microsoft Learn（PAD）、WinActor のマニュアル・研修・利用者コミュニティ
- **影響**：OSS で販売網がない分、資料が営業の代わり。ないと試されない
- **方向**：「AI に頼んで請求書の集計を作る」のような業務別の通し例を数本、画面付きで。Studio の中から開ける形が望ましい

## P2：特定の場面で効く

### 19. 帳票 OCR・PDF の操作

- **今**：`pdf.readText`（テキスト層のみ）、`desktop.readText`（画像の OCR、位置つき）。請求書などの項目を取り出す仕組み、表の読み取りはない。PDF の結合・分割は `pdf.merge` / `pdf.extractPages` / `pdf.split` で済み（[uipath-coverage.md](uipath-coverage.md)「PDF」）
- **相手**：UiPath Document Understanding。WinActor は AI-OCR 製品との連携が定番
- **方向**：項目の取り出しは「AI なしで動く」と相性が悪い（毎回 AI に読ませると AI ありになる）。位置で読む定型帳票なら OCR＋式で書ける。非定型はプラグイン（外部の AI-OCR）にする

### 20. シナリオのテスト

- **今**：試しの実行と確認待ちの「試しの結果」はある（[review-evidence.md](review-evidence.md)）。入力と期待する出力を保存して繰り返し流すテストケース・外部をモックにする仕組みはない
- **相手**：UiPath Test Suite
- **方向**：AI が直したときの回帰確認に効く。確認待ちの「試しの結果」を保存してテストケースにする、が最小

### 21. 複数人での開発

- **今**：同時編集はリビジョン競合で止めて読み直し。3-way マージはしない（[sharing-versioning.md](sharing-versioning.md)「やらないこと」）。Undo はシナリオに 1 本で人ごとではない（[architecture.md](../architecture.md) §13）
- **相手**：UiPath（Git 連携・Studio のチーム機能）
- **方向**：Git に頼らない方針は維持。「誰が編集中か」の印と、版どうしの差分（確認待ちの比較を版に使う）から

### 22. プラグインの配布と部品の数

- **今**：`shikigami plugin list` / `check` のみ。インストール・カタログ・署名・SDK は未着手（[plugins.md](plugins.md) §8）
- **相手**：UiPath Marketplace、WinActor の豊富なライブラリ
- **方向**：§8 の順で。部品の数の勝負は式の関数（[uipath-coverage.md](uipath-coverage.md)）で半分は埋まっているので、外部連携のプラグインを数本作って見本にする

### 23. SaaS へのつなぎ

- **今**：`http.request` と `oauth.signIn`（[oauth.md](../oauth.md)）。個別の SaaS 用ノードはない
- **相手**：UiPath Integration Service、PAD（Power Automate のコネクター）
- **方向**：方針どおりプラグイン。国内でよく使う kintone・Box・Slack・Teams から

### 24. 汎用機の端末・FTP / SFTP・XML

- **今**：なし（XML は「需要を見て」、[uipath-coverage.md](uipath-coverage.md)）
- **相手**：UiPath・PAD に端末エミュレーターと FTP の操作がある
- **方向**：金融・製造の一部で必須。プラグイン候補

### 25. 実行記録の保管と監査の一元化（重なり：#77）

- **今**：人が読む実行ログは新しい 100 件（CHANGELOG 0.1.0）。MCP の操作は `audit/mcp.jsonl`。Studio・CLI・MCP をまたいだ監査の一本化と、保管期間の設定はない
- **相手**：UiPath（Orchestrator の監査ログ・保持期間）
- **方向**：#77 の管理ツールに集める前提で、PC 側の保管期間の設定を先に

### 26. 有償サポート・販売パートナー・研修と認定

- **今**：OSS で当面無償。サポート窓口・SLA はない
- **相手**：WinActor は国内の販売パートナー網と研修。UiPath は認定制度とパートナー
- **影響**：大企業の購買は「問い合わせ先があるか」で決まることがある。OSS の構造上の弱み
- **方向**：収益化と同じく「広がってから」。それまでは資料（#18）と公開の Issue 対応で補う

## 方針としてやらないこと（比較で × が付いても追わない）

| 相手にあるもの | やらない理由 |
|---|---|
| 任意のコードの実行（Invoke Code・VBA の直書き・PowerShell の直書き） | 任意コードを実行しない方針。外部プログラムは `process.run`、マクロは `excel.runMacro`（[uipath-coverage.md](uipath-coverage.md)） |
| 乱数・Switch | 結果が変わる／書き方が 2 通りになる（同上） |
| mac / Linux 対応 | Windows 特化（[architecture.md](../architecture.md) 判断 9） |
| Git 連携 | 自前の版管理（[sharing-versioning.md](sharing-versioning.md)） |
| 1 操作 1 アクティビティの細かいノード | 式の関数で 1 通りに書く（[uipath-coverage.md](uipath-coverage.md)） |

## 逆に勝っている点（比較表で並べるときのために）

- AI がシナリオを組む入口が MCP（他社の MCP は既存のロボットを呼ぶ側が中心）
- 無人実行は人が承認して公開した版だけ、AI の操作は `policy.json` で絞る（[policy.md](../policy.md)）
- シナリオは JSON で人も AI も同じものを見る。差分を確認して公開（[review-evidence.md](review-evidence.md)）
- 同時に動かす数に料金がない、ブラウザは `context` ごとに並列（[architecture.md](../architecture.md) §10.5）
- 和暦・全角半角・Shift_JIS が式と `file.*` にある（[uipath-coverage.md](uipath-coverage.md)）
- エラーで止まったところから直して続けられる（[debug-runs.md](debug-runs.md)）
- オフラインで動く日本語 OCR を同梱（[desktop.md](../desktop.md)）

## 次に決めること

P0 のうち別の取り組みと重ならない #4（IE モード・既存ブラウザ）・#5（実機検証）・#6（署名と配布）は、担当を決めて着手するかどうかを先に決める。#1・#2 は #77、#3 は部品選択のスレッドで進める。

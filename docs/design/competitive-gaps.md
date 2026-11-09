# WinActor・UiPath・Power Automate Desktop などと比べて劣る点（2026-11-07 再点検）

目的：既存の RPA 製品と並べたときに Shikigami が**まだ劣っている点だけ**を、ノード・操作の単位まで掘って並べる。各項目に、相手の製品での名前・Shikigami での対応案・優先度を書く。上から順に PR で潰していき、済んだものは「済んだもの」に移す。

比べた相手：WinActor・UiPath（Studio / Robot / Orchestrator）・Power Automate Desktop（以下 PAD）・Automation Anywhere（以下 AA）・BizRobo!。相手の機能名は各社の公開資料で一般に知られている範囲で書いた（細かい版・価格は確かめていない）。Shikigami 側は `schemas/contract/step-types.json`（組込ノード 105 種）と docs・Studio のコードを根拠にした。

前提にする方針（変えない）：

- 差別化の軸は「AI が作り、AI なしで動く」。人の手は「読む・試す・小さく直す・AI にできないこと」を一級に扱い、ゼロから手で組む流れは磨かない（[ai-authoring.md](ai-authoring.md) の「人の手の役割」、2026-11-08 決定）。保守で困る点は AI で作るときと同じ重さで数える
- Windows 特化、OSS（Apache-2.0）で当面無償
- 値の加工は式の関数、外に触れる操作だけノード（[uipath-coverage.md](uipath-coverage.md)）。組込以外はプラグイン（[plugins.md](plugins.md)）
- 1 つのことは 1 通りに書ける（[ai-authoring.md](ai-authoring.md)）。足すときは既存のノードの設定で済むならそちらを選ぶ

## 優先度

| 優先度 | 意味 |
|---|---|
| **P0** | 導入の前提を欠く。ないと企業の PC に入らない・評価の土俵に乗らない |
| **P1** | 多くの業務で困る。乗り換えの比較表で「×」が付く、または AI が無い PC で公開版を直す人が手を止める |
| **P2** | 特定の業務・使い方で効く。後回しやプラグインでもよい |

「状態」欄：**着手順** は下の「進める順」の番号。**別** は別の取り組みで進めている。**待ち** は Daiki の PC・費用など外の条件待ち。

## 一覧

| # | 優先度 | 分野 | 劣っている点 | 相手での名前 | 状態 |
|---|---|---|---|---|---|
| G1 | P0 | 実機 | 実際の業務アプリ・SAP GUI・Citrix・Edge の IE モード・`browser.attach` が実機で未確認 | （実績・事例の比較） | 待ち |
| G2 | P0 | 配布 | インストーラーが未署名、MSI・サイレントインストール・社内配布先の指定がない | 署名済みインストーラー・MSI・Intune 配布 | 待ち（後回し） |
| G3 | P1 | Studio | ノードのコピー・貼り付け・複製ができない。複数のノードをまとめて選べない | UiPath・PAD・WinActor：Ctrl+C / Ctrl+V・複数選択 | 済み（#151） |
| G4 | P1 | 例外処理 | 複数のノードをまとめて再試行できない（`control.group` の `retry` は黙って無視される） | UiPath：Retry Scope／PAD：「エラー発生時」のブロックの再試行 | 済み（#153） |
| G5 | P1 | ログ | 無人実行で失敗したときの画面が残らない（Studio の一時停止のときだけ撮る） | UiPath：REFramework の Take Screenshot・Orchestrator のログ／AA：エラー時のスクリーンショット | 済み |
| G6 | P1 | ブラウザ | クリックの種類（右クリック・ダブルクリック・Ctrl / Shift を押しながら）がない | UiPath：Click の ClickType・MouseButton・KeyModifiers／PAD：「Web ページのリンクまたはボタンをクリック」のクリックの種類 | 済み |
| G7 | P1 | ブラウザ・デスクトップ | チェックボックスを「オンにする／オフにする」ができない（クリックで切り替えるだけなので、2 回流すと逆になる） | UiPath：Check / Uncheck／PAD：「Web ページのチェック ボックスの状態を設定します」「ウィンドウのチェック ボックスの状態を設定」／WinActor：チェックボックス操作 | 済み |
| G8 | P1 | デスクトップ | ウィンドウの最大化・最小化・元に戻す・前面に出す・移動・サイズ変更がない | WinActor：ウィンドウ状態変更・ウィンドウ位置変更／UiPath：Maximize / Minimize / Restore / Move Window / Activate／PAD：「ウィンドウの状態の設定」「ウィンドウの移動」「ウィンドウのサイズ変更」「ウィンドウにフォーカスする」 | 済み |
| G9 | P1 | システム | 動いているプロセスの終了・有無の確認がない（固まった業務アプリを落として立ち上げ直せない） | UiPath：Kill Process・Get Processes／PAD：「プロセスを終了する」「プロセスを待機する」／WinActor：プロセス終了 | 済み |
| G10 | P1 | Excel | 行・列の挿入と削除、範囲のクリア、シートの削除・名前変更・コピーがない | WinActor：Excel 操作（行削除・シート名変更・シートコピー…）／UiPath：Insert/Delete Rows・Delete Range・Rename Sheet・Copy Sheet／PAD：「Excel ワークシートから行を削除」など | 済み |
| G11 | P1 | Excel | `.xls`・パスワード付きのブックが開けない、CSV や `.xlsx` への変換（名前を付けて保存）がない | UiPath：Save Workbook As・Password／PAD：「Excel の起動」のパスワード・「Excel を閉じる」の名前を付けて保存 | 済み |
| G12 | P1 | 人とのやりとり | フローの途中で複数の項目（選択肢・日付・チェック）を一度に入れてもらう画面がない（`dialog.input` は 1 行だけ） | UiPath：Create Form／PAD：「カスタム フォームを表示」／WinActor：ユーザー入力（複数項目） | 済み |
| G13 | P1 | Studio・デバッグ | 選んだノードから実行する（前のノードを飛ばす）ことができない | UiPath：Run from this Activity／PAD：「ここから実行」 | 済み |
| G14 | P1 | メール | メールの移動・既読にする・返信・転送・削除がない。Outlook（クラシック）なしで受信できない（Microsoft 365・IMAP） | UiPath：Move / Mark as Read / Reply To / Delete Outlook Mail Message・Get IMAP Mail／PAD：「メール メッセージの処理」・Exchange / Outlook / IMAP | 済み（IMAP は残り） |
| G15 | P1 | スケジュール | 祝日・会社の休日を飛ばす・「第 3 営業日」の指定がない。メールが届いたら起動もない | UiPath：Orchestrator の Non-Working Days・キュートリガー／PAD：クラウドフローのメールトリガー | 済み |
| G16 | P1 | 記録 | ブラウザの操作は記録できない（デスクトップだけ） | WinActor：Web レコーディング／UiPath：Web Recorder／PAD：Web レコーダー | 済み |
| G17 | P1 | Word | PDF で保存・文字の置換・表の読み取りがない（`word.fillTemplate` / `word.readText` だけ） | UiPath：Save Document As PDF・Replace Text／PAD：「Word 文書を保存」の PDF・「Word 文書内の語句の検索と置換」 | 済み |
| G18 | P1 | 無人実行 | 画面がロックされた・サインアウトした PC ではデスクトップのノードが止まる（`DESKTOP_UNAVAILABLE`） | UiPath：無人ロボットがセッションを作る／PAD：ロックされた PC での無人実行 | 段階 1 済み（#187・#188・#192）、段階 2 は署名のあと（[locked-runs.md](locked-runs.md)） |
| G19 | P1 | 画像 | 画像認識で「画面から切り取る」・一致率・探す範囲がない | UiPath：Click Image・Find Image の Indicate on screen／PAD：画像をキャプチャ | 別（画像部品のスレッド） |
| G20 | P2 | ブラウザ | 戻る・進む・再読み込みがない（同じタブでの移動は `browser.open` で済む） | UiPath：Go Back / Go Forward / Refresh／PAD：「Web ページに移動します」の戻る・進む・再読み込み | 済み |
| G21 | P2 | ブラウザ | 1 文字ずつ打つ入力がない（キーの動きを見ているサイトで `browser.fill` が効かない） | UiPath：Type Into の入力方式／PAD：「Web ページ内のテキスト フィールドに入力する」の入力をエミュレート | 済み |
| G22 | P2 | Studio | ノードのメモ（注釈）を Studio で書けない（フローの `description` はあるが画面に出ない） | UiPath：Annotation／PAD：コメント／WinActor：コメント | 済み（#151） |
| G23 | P2 | Studio | フローの中の検索（ノード名・設定値・変数名で探す）がない | UiPath：Find / Find References／PAD：アクションの検索 | 済み |
| G24 | P2 | デバッグ | 一時停止中に変数の値を書き換えられない | UiPath：Locals パネルの値の変更・Immediate | 済み |
| G25 | P2 | デスクトップ | 部品の指定は「ウィンドウ＋部品」の 2 段だけ。親の部品をたどる指定がなく、同じ名前の部品は `nth` 頼み | UiPath：Selector の階層・Anchor／PAD：UI 要素のセレクター | 済み |
| G26 | P2 | 資格情報 | Windows の資格情報マネージャーにある資格情報を使えない | UiPath：Get Secure Credential | 済み |
| G27 | P2 | 帳票 | 帳票の項目を読む AI-OCR がない | UiPath：Document Understanding／WinActor：AI-OCR 連携 | プラグイン候補 |
| G28 | P2 | テスト | 入力と期待する出力を保存して繰り返し流すテストがない | UiPath：Test Suite | 済み |
| G29 | P2 | 連携 | kintone・Box・Slack などの個別ノード、端末エミュレーター、FTP / SFTP がない | UiPath：Integration Service・Terminal・FTP／PAD：コネクター・FTP | プラグイン候補 |
| G30 | P2 | 支援 | 有償サポート・販売パートナー・研修と認定がない | WinActor・UiPath | 広がってから |

## 項目ごとの対応案

### G3・G22 ノードのコピー・貼り付け・複製、ノードのメモ（Studio）

- **今**：Studio の選択は 1 つ（`Selection` は 1 ノード）。キーは元に戻す・やり直す・削除・上下移動だけで、Ctrl+C / Ctrl+V / Ctrl+D がない。右クリックのメニューにも複製がない。同じ形の手順を 2 回作るとき、手で組む人は一から設定し直すことになる
- **対応案**：
  - ノードの右クリックと Ctrl+C / Ctrl+X / Ctrl+V / Ctrl+D。ブロックごとコピーし、貼り付けると ID は付け直す（Core の `addSteps` で）。別のフロー・別の Studio の窓にも貼れるよう、クリップボードにはフローの JSON の形で置く（AI のチャットに貼ってもそのまま読める）
  - Shift+クリックで同じブロックの中の連続したノードを選び、まとめてコピー・削除・移動
  - 設定画面に「メモ」の欄（`Step.description`）。チャートではノードの下に 1 行で出す

### G4 範囲の再試行

- **今**：`retry` はアクションのノードだけで効く。`control.group` に `retry` を書いても検証は通り、実行では無視される（AI にも人にも気付けない）
- **対応案**：`control.group` の `retry` で、ブロックの中が失敗したら頭からやり直す（`retryable` でないエラーも含めて、`maxAttempts` 回まで、`backoffMs` を空けて）。ブラウザを開く→ログイン→画面を開く、をまとめてやり直すときの書き方を docs に。ほかの制御ノード（`control.if` など）の `retry` は検証で止める（`CONTROL_RETRY`）

### G5 失敗したときの画面を残す

- **今**：Studio の一時停止のときだけ、アダプターの `inspect` で画面を撮って観察として残す。`shikigami run`・自動実行・管理サーバーからの実行では、どんな画面で止まったか後から分からない
- **対応案**：実行が失敗で終わるとき、失敗したノードがブラウザ・デスクトップのノードなら、その画面のスクリーンショットを実行記録のフォルダーに保存し、実行記録と通知・`get_run_logs` から辿れるようにする。秘密の値は画面に出ていることがあるので、`policy.json` で切れるようにする（既定は撮る）

### G6・G7・G20・G21 ブラウザ・デスクトップの細かい操作

**対応**：済み（#158、デスクトップのチェックボックス `desktop.check` は G8・G9 と一緒に）。


- `browser.click` に `button`（`left` / `right`）・`double`・`modifiers`（`["Control"]` など）。`desktop.mouseClick` の書き方にそろえる
- チェックボックスは「チェック状態」のノード（`browser.check` / `desktop.check`、`checked`: true / false）。今の状態と同じなら何もしない。`fill` に true / false を混ぜるより、図とパレットで探しやすいので別のノードにした
- `browser.open` は同じタブで開き直せるので、戻る・進む・再読み込みは `browser.press` ではなく `browser.navigate`（`action`: `back` / `forward` / `reload`）を 1 つ足す
- 1 文字ずつ打つのは `browser.fill` に `typing: true`（キーの間隔は固定）

### G8・G9 ウィンドウとプロセス

**対応**：済み。`desktop.setWindow`（ウィンドウ状態）・`process.list`（プロセス一覧）・`process.kill`（プロセス終了、policy の `apps` で絞れる）。

- `desktop.setWindow`（`target` の窓、`state`: `maximized` / `minimized` / `normal`、`front: true`、`x` / `y` / `width` / `height`）。画面の大きさで部品の位置が変わるアプリを、毎回同じ大きさにしてから操作できる
- `process.kill`（`name` または `pid`、危険度 Dangerous、`policy.json` の許可した program と同じ確認）と、`process.list`（`name` で絞って `{ pid, name, startedAt }` の一覧）。固まった業務アプリを落として `desktop.launch` で立ち上げ直す書き方を docs に

### G10・G11 Excel の行・シート・形式

**対応**：済み。行・シートの操作はファイルを直接変え（数式の参照も付いていく）、`excel.saveAs` は Excel で。`.xls` とパスワード付きは `excel.saveAs` で `.xlsx` にしてから使う形にした。

- `excel.insertRows` / `excel.deleteRows`（`sheet`・`row`・`count`。readRows の `_row` をそのまま使える）、`excel.clearRange`、`excel.deleteSheet` / `excel.renameSheet` / `excel.copySheet`
- `.xls`・パスワード付きのブックは COM（この PC の Excel）で開く。`excel.saveAs`（`to` の拡張子で `.xlsx` / `.xls` / `.csv` / `.pdf` を決める。`excel.exportPdf` はそのまま残す）
- ファイルを直接読み書きする経路（umya-spreadsheet）でできるものは Excel なしでも動かす

### G12 フローの途中の入力フォーム

- `dialog.form`：`fields`（`name`・`label`・`type`: `text` / `number` / `date` / `choice` / `check` / `file`・`choices`・`default`・`required`）を 1 つの画面で入れてもらい、`{ 名前: 値 }` を返す。見た目と作りは `dialog.*` と同じ WPF（Studio の見た目）。実行画面の入力フォームと同じ部品の種類にそろえる

### G13 選んだノードから実行

**対応**：済み。繰り返し・分岐の中からは始めない形にした（グループ・try の中からは始められる）。変数は直前の実行がそのノードに来たときの値。

- ノードの右クリックに「ここから実行」。前のノードは実行せず、変数は既定値（または直前の実行の、そのノードの手前の値を使うかを選ぶ）。ブロックの中のノードなら、外側の繰り返しの 1 回目として入る。Runtime の `debug` の「ノードへ飛ぶ」と同じ仕組みで始める

### G14 メール

- 済み：`mail.move`（`id`・`folder`）、`mail.markRead`（`id`・`read`）、`mail.reply` / `mail.forward`（下書きに置く。送るのは Dangerous の `mail.sendDraft` だけ）、`mail.delete`（削除済みアイテムへ）
- 済み：`mail.send` 以外のメールのノードに `via`（`outlook` / `microsoft365`）。`mail.send` と同じ書き方で、Microsoft 365 は Graph
- 残り：`via: "imap"`（Outlook・Microsoft 365 以外のメールボックス）

### G15 祝日・営業日・メールのトリガー

- 済み：スケジュールに `skipHolidays`（日本の祝日を内蔵。会社の休日・出勤日はワークスペースの `holidays.json`）、`monthly` の `businessDay`（第 n 営業日、-1 で最終営業日）と `onHoliday`（休日なら前・次の営業日、その月は飛ばす）
- 済み：`when.kind: "mailReceived"`（`folder`・`subjectContains`・`fromContains`・`minutes`・`via`、届いたメールを入力変数へ）

### G16 ブラウザの操作の記録

- デスクトップの記録と同じ入口・同じ「記録した操作」の一覧。ブラウザは Playwright の中でクリック・入力・選択・ページの移動を拾い、`target` は「画面から選ぶ」と同じ作り方で作る。記録のあと「AI に整えてもらう」も同じ

**対応**：済み。**記録** で「デスクトップ／ブラウザ」を選ぶ。アップロード・ドラッグ・新しいタブは記録しない（一覧に理由を出す）。

### G17 Word

- `word.exportPdf`（COM、Excel のマクロと同じ経路）、`word.replaceText`（`.docx` を直接、書式を残す）、`word.readTables`（表を行の一覧で）

**対応**：済み。`word.replaceText`・`word.readTables` は Word なしで、`word.exportPdf` は専用の見えない Word で。

### G18 ロック中の無人実行

- 方式を比べて決める：（a）実行の間だけ RDP のループバックでセッションを作る、（b）自動サインインの仕組みを使う、（c）デスクトップのノードがある実行はロックを解いて終わったらロックし直す。どれも資格情報の扱いが要るので、設計メモを先に書く

**方針**：[locked-runs.md](locked-runs.md)。段階 1（資格情報を持たない手当て：実行中はロックさせない、リモートデスクトップをロックしないで切断、ロック解除を待つ、前もって知らせる）を先に作り、段階 2（Windows サービスがロボット用アカウントでサインインする、UiPath・PAD と同じ形）はコード署名のあとに決める。

**対応**：段階 1 は済み。実行中は画面オフ・スリープさせない（#187）、予定に何分でロックされるかを出す（#188）、リモートデスクトップをロックしないで切断する「画面を残して切断」・`shikigami session`、`policy.json` の `desktop.waitUnlockedMinutes`（#192）。実機の Windows ではまだ試していない。

### G26 Windows の資格情報マネージャー

- シークレットの値の保存先に「Windows の資格情報マネージャー」を足す。名前・サイト・MFA キーは Shikigami 側に残し、ユーザー名とパスワードだけを使うたびに汎用資格情報から読む（UiPath の Get Secure Credential と同じく、変更はそちらだけで済む）。参照の書き方・サイト照合・伏せ字は変えない

**対応**：済み。読めるのは汎用資格情報だけ（ドメインの資格情報のパスワードは Windows が渡さない）。実機の Windows ではまだ試していない。

### G25 部品の階層・アンカー

- `element.within`（この部品の中だけを探す）と `element.after`（この部品の後ろで最初に当たる部品、名前のない入力欄をラベルで指す）。どちらも `element` と同じ書き方で 2 段まで。画面から選ぶも、`nth` の前にこの 2 つを試す

**対応**：済み。UiPath の Anchor は位置（右・下）で探すが、ここでは画面の部品の並び順の「後ろ」にした（ラベルの後に入力欄が来る業務画面の作りで足り、AI が inspect_ui の木から写せる）。実機ではまだ試していない。

### G28 テストの仕組み

- フローのフォルダーの `tests/<名前>.json` に `inputs` と `expect`（`status`・`outputs` は書いたものだけ比べる・`errorCode`・`errorStep`）。`shikigami test <フロー> [--case] [--draft] [--json]` で 1 ケース 1 回ふつうに実行し、違いを `at`・`expected`・`actual` で出す。終了コード 1 で CI やバッチに使える。`tests/` はバンドルに入る（docs/testing.md）
- Studio：下のパネルの「テスト」タブ。「この実行をテストケースとして保存」（入力・終わり方・出力をそのまま期待に。シークレットと切り詰めた値は除く）、一覧・すべて実行・1 件実行・中止、違いを「出力『total』 期待 3 実際 4」の言葉で
- AI：MCP の `save_test_case`（入力変数でない名前・シークレットの入力は断る）と `run_tests`（承認は run_flow と同じ）

**対応**：済み（CLI・Studio・AI）。UiPath の Test Suite のようなモック（外の操作の差し替え）はまだ持たない。外を操作するフローはテスト用の入力（テスト環境の URL・フォルダー）を渡して本当に流す前提。

### G27・G29 はプラグインの見本として作る候補。

## 進める順

手で直す人が手を止める点と、無人実行で困る点を先に（この順は 2026-11-08 の方針変更より前に決めたもの）、小さく出せる順に並べた。1 つずつ PR にして、CI が通ったらマージする。

1. G3・G22 ノードのコピー・貼り付け・複製・複数選択・メモ
2. G4 範囲の再試行
3. G5 失敗したときの画面
4. G6・G7・G20・G21 クリックの種類・チェックボックス・戻る／進む／再読み込み・1 文字ずつの入力
5. G8・G9 ウィンドウとプロセス
6. G10・G11 Excel の行・シート・形式
7. G12 入力フォーム
8. G13 ここから実行
9. G14 メール
10. G15 祝日・営業日・メールのトリガー
11. G16 ブラウザの記録
12. G17 Word
13. G23・G24 フローの中の検索・一時停止中の変数の書き換え

## 済んだもの（2026-11-06 版の 26 項目から）

前の版で挙げた点のうち、次は対応済み（詳しくは各 docs）。

| 前の # | 項目 | 対応 |
|---|---|---|
| 1 | スケジュール・トリガー | `shikigami agent` と Studio の「自動実行」、日時・毎月・間隔・ファイル到着（[schedules.md](../schedules.md)） |
| 2 | 無人実行の土台 | PC をまたいだ入力の排他、キャンセル時の `finally`、ロックの検知（ロック中に動かすのは G18） |
| 3・13 | 画面から選ぶ・光らせる・名前付きの部品 | 「画面から選ぶ」「光らせる」、`parts`（[desktop.md](../desktop.md)） |
| 4 | IE モード・人が開いたブラウザ | `desktop.*` で IE モード、`browser.attach`（実機確認は G1） |
| 5 | SAP / Java の経路 | SAP GUI Scripting・Java Access Bridge、`sap.runTransaction`（実機確認は G1） |
| 7 | エラーが英語 | `errorText.ts`・検証の問題の日本語化 |
| 8・25 | 管理サーバー・監査 | 管理サーバー、`shikigami audit`、`records.keepDays` |
| 9 | 失敗の通知 | `policy.json` の `notify`（Teams・メール） |
| 10 | 操作の記録 | デスクトップ・ブラウザの記録 → AI が整える |
| 11 | ブラウザ操作の欠け | タブ・iframe・JS ダイアログ・ホバー・スクロール・属性・ダウンロード・アップロード |
| 12 | デスクトップ操作の欠け | スクロール・ドラッグ・ホバー・メニュー・表の一括読み |
| 14 | Excel | 開いているブック・再計算・並べ替え・書式・フィルター・ピボット・PDF（行・シートの操作は G10・G11） |
| 15 | メールの送信 | `mail.send`（Outlook・Microsoft 365・SMTP。受信側は G14） |
| 16 | データベース | `db.query` / `db.execute`（ODBC） |
| 17 | 軽い実行画面 | 「Shikigami 実行」（入力変数から作るフォーム。途中のフォームは G12） |
| 18 | 学習資料 | `docs/ja/tutorials/`、Studio の「見本」 |
| 19 | PDF の結合・分割 | `pdf.merge` / `pdf.extractPages` / `pdf.split`（帳票 OCR は G27） |

## 方針としてやらないこと（比較で × が付いても追わない）

| 相手にあるもの | やらない理由 |
|---|---|
| 任意のコードの実行（Invoke Code・VBA の直書き・PowerShell の直書き） | PC の上で任意のコードを実行しない方針。外部プログラムは `process.run`、マクロは `excel.runMacro`。ブラウザでの JavaScript だけは、開いているページの中でしか動かないので `browser.runScript` で扱う（2026-11-09 Daiki 決定、`dangerous`） |
| 乱数 | 結果が毎回変わる |
| mac / Linux 対応 | Windows 特化 |
| Git 連携 | 自前の版管理（[sharing-versioning.md](sharing-versioning.md)） |
| 1 操作 1 アクティビティの細かいノード（文字の結合・トリムなど） | 式の関数で 1 通りに書く |

## 逆に勝っている点（比較表で並べるときのために）

- AI がフローを組む入口が MCP（他社の MCP は既存のロボットを呼ぶ側が中心）
- 無人実行は人が確認して公開した版だけ、AI の操作は `policy.json` で絞る
- フローは JSON で人も AI も同じものを見る。差分を確認して公開
- 同時に動かす数に料金がない、ブラウザは `context` ごとに並列
- 和暦・全角半角・Shift_JIS が式と `file.*` にある
- エラーで止まったところから直して続けられる（[debug-runs.md](debug-runs.md)）
- オフラインで動く日本語 OCR を同梱

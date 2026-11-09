# ブラウザ操作（Phase 3）

[English](../browser.md) | 日本語

SpellSheet のフローから Web ページを操作します。Rust の Runtime が Node.js + Playwright のブラウザアダプター（`packages/browser-adapter`）を子プロセスとして起動し、改行区切りの JSON-RPC 2.0（stdio）で指示します。フローの実行に AI は関わりません。

## 必要なもの

- **インストーラーで入れた場合は追加のものは不要です。** Node.js とアダプターが同梱されています（[release.md](release.md#nodejs-とブラウザアダプターの同梱)）
- ソースから動かす場合：Node.js 22.18 以降（TypeScript をそのまま実行します）と、リポジトリでの `pnpm install`（`playwright-core` が入ります）
- ブラウザ：Windows では **Microsoft Edge をそのまま使う** ので追加のダウンロードは不要です。Chrome を使うときは `SPELLSHEET_BROWSER_CHANNEL=chrome`、任意の実行ファイルは `SPELLSHEET_BROWSER_PATH`

| 環境変数 | 意味 |
|---|---|
| `SPELLSHEET_BROWSER_CHANNEL` | `msedge`（Windows の既定）/ `chrome` など |
| `SPELLSHEET_BROWSER_PATH` | ブラウザの実行ファイル |
| `SPELLSHEET_BROWSER_HEADLESS` | `1` で常に画面なし（無人実行・CI 向け） |
| `SPELLSHEET_BROWSER_SLOWMO` | 操作ごとの待ち（ミリ秒）。デモで動きを見せるとき |
| `SPELLSHEET_BROWSER_ADAPTER` | アダプター `main.ts` の場所（通常は自動で見つける） |
| `SPELLSHEET_NODE` | Node.js の実行ファイル（既定は同梱の `node\node.exe`、なければ PATH 上の `node`） |

## デモ

```powershell
pnpm demo:browser
```

デモ用の業務サイト「サンプル商事 受注管理システム」（`examples/web`）を `http://127.0.0.1:8787/` で起動し、`examples/browser-demo.json` を CLI で実行します。デモ用アカウントは最初にシークレット「デモ受注システム」として登録するので、フローにパスワードは書かれていません（Writer の「🔑 シークレット」にも出ます）。

1. 受注係と在庫係が **同時に** 作業する：受注係がログインして受注一覧を読み、在庫係は別のウィンドウで在庫一覧を読む（`control.parallel` と別々の `context`）
2. 未処理の注文ごとに「出荷する」を押し、処理完了の表示を待つ（`control.forEach` + `control.if`）
3. 出荷した注文番号・合計金額・在庫切れの商品を出力する
4. ログイン状態を `session` で保存するので、**2 回目の実行ではログイン画面を飛ばす**

CLI は `target/demo` にビルドするので、MCP サーバーなどで `target\debug\spellsheet.exe` を使用中でも上書きで失敗しません（初回はビルドに少し時間がかかります）。サイトだけ起動するときは `pnpm demo:site`。Writer からも同じフローを読み込んで実行できます。

## ノード

| type | 主な params | 出力 |
|---|---|---|
| `browser.open` | `url`, `headless`, `session`（ログイン状態を保存・再利用する名前）, `dialog` | `{ url, title }` |
| `browser.attach` | `port`（既定 9222）, `title` / `url`（使うタブ） | `{ url, title }` |
| `browser.click` | `target`, `button`（`right` で右クリック）, `double`（ダブルクリック）, `modifiers`（`["Control"]` など押しながらのキー）, `dialog`（クリックで出る JS のダイアログへの答え） | ダイアログの文 / `null` |
| `browser.download` | `target`（押すもの）, `path`（保存するファイル）か `folder`（サイトの名前のまま） | `{ path, fileName }` |
| `browser.upload` | `target`（ファイルの入力欄、またはファイル選択を開くボタン）, `path`（ファイル 1 つか配列） | – |
| `browser.hover` | `target` | – |
| `browser.scroll` | `target`（見えるところまで）と `to`（`top` / `bottom`）のどちらか、または両方 | – |
| `browser.fill` | `target`, `value`（文字、または登録済みシークレット `{ "secret": "名前", "field": "password" }`）, `typing`（1 文字ずつキーを打つ。キー入力を見ているページ向け。シークレットはいつも一度に入れる） | – |
| `browser.check` | `target`, `checked`（既定 `true`、`false` で外す） | –（すでにその状態なら何もしない） |
| `browser.navigate` | `action`（`back` 戻る / `forward` 進む / `reload` 再読み込み） | `{ url, title }` |
| `browser.select` | `target`, `value`（表示名、または配列） | – |
| `browser.press` | `key`（`Enter` など）, `target`（省略時はページ）, `dialog` | ダイアログの文 / `null` |
| `browser.getText` | `target`, `all`（`true` で全一致の配列） | 文字列 / 配列 |
| `browser.getTable` | `target`（省略時は最初の表） | 見出しをキーにしたオブジェクトの配列 |
| `browser.getAttribute` | `target`, `name`（`href`・`src`・`value`・`data-id` など）, `all` | 文字列 / `null` / 配列（`href`・`src` は完全なアドレス） |
| `browser.runScript` | `script`（async 関数の中身）, `args`, `target`, `frame` | スクリプトが `return` した値 |
| `browser.switchTab` | `title` / `url`（一部でよい）か `index`（0 が最初のタブ） | `{ url, title, index }` |
| `browser.closeTab` | – | 戻った先のタブの `{ url, title }` |
| `browser.waitFor` | `target`, `state`（`visible` / `hidden` / `attached` / `detached`） | – |
| `browser.screenshot` | `path`（絶対パス）, `fullPage` | 保存先 |
| `browser.isVisible` | `target`, `waitMs`（既定 2000） | `true` / `false`（見つからなくても失敗しない） |
| `browser.waitForHuman` | `message`, `until`（人の操作が終わると出る要素） | – |
| `browser.close` | – | – |

すべてのノードに `context`（既定 `default`）があります。`context` ごとに Cookie もタブも別で、ノードはその **今のタブ** を操作します。**同じ `context` のノードは 1 つずつ、別の `context` は同時に** 動きます（排他は Runtime が `context` から自動で決めるので、フローにロックを書く必要はありません）。実行が終わると、その実行で開いた `context` は自動で閉じます。

### タブとポップアップ

`target="_blank"` のリンクやウィンドウを開くボタンを押すと、その `context` にタブが増えますが、ノードは `browser.switchTab` で移るまで今のタブのままです。クリックのすぐ後に置きます：タブが開くのを待ち、タイトルに `title` を含む（アドレスに `url` を含む）いちばん新しいタブに移ります。`browser.closeTab` は今のタブを閉じて前のタブに戻ります。自分で閉じるポップアップ（`window.close()`）のときは自動で前のタブに戻ります。

```jsonc
{ "type": "browser.click", "params": { "target": { "role": "button", "name": "詳細" } } },
{ "type": "browser.switchTab", "params": { "title": "受注詳細" } },
{ "type": "browser.getText", "params": { "target": { "role": "heading" } }, "saveAs": "title" },
{ "type": "browser.closeTab" }
```

### 人が開いたブラウザを使う（`browser.attach`）

PC のサインインでの SSO、クライアント証明書、必須の拡張機能など、人のブラウザでしか開けないサイトがあります。`browser.attach` は新しくブラウザを起動する代わりに、もう開いている Edge・Chrome を使い、同じ `context` の後のノードはその中で動きます。つなぐ先は `127.0.0.1` だけで、実行が終わるとブラウザは閉じずに手を離します。

ブラウザはデバッグ用のポートを付けて起動しておきます。Chrome 136 以降はふだんのプロファイルではこのポートを無視し（[Chrome の告知](https://developer.chrome.com/blog/remote-debugging-port)）、Edge も同じになる見込みなので、専用のプロファイルのフォルダーを付け、そこで一度サインインしておきます（この引数のショートカットを作るのが簡単です）：

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222 --user-data-dir="$env:LOCALAPPDATA\SpellSheet\edge-profile"
```

```jsonc
{ "type": "browser.attach", "params": { "title": "勤怠" } }
```

注意：

- ポートで待っている間は、この PC のどのプログラムからもそのブラウザを操作できます。必要な作業のときだけこの開き方をします
- ワークスペースの許可したサイト（ポリシー）は `browser.open` で確かめます。人がもう開いていたタブは確かめません
- 無人実行には使えません（ブラウザを起動する人がいない）。無人では `browser.open` の `session` を使います
- つないでいる間、そのブラウザの JS のダイアログには実行が答えます
- **Windows の PC の Edge ではまだ試していません**（Chromium で確認）

### Edge の IE モード

Edge が IE モードで表示するページは古い Internet Explorer のエンジンで動くため、Playwright（つまり `browser.*`）からは届きません。そこではデスクトップのノードを使います。IE モードのページは Edge のウィンドウの一部なので、`{ "window": { "process": "msedge.exe", "title": "<ページのタイトルの一部>" }, "element": { … } }` で指し、`inspect_ui` で中を見ます。Windows の CI（Windows Server、IE 強化セキュリティは切った状態）では、ページの見出し・ラベル・入力欄・ボタンが HTML の `id` 付きで UI Automation に出て、入力欄への `desktop.setValue` とボタンの `desktop.click` も効きました（`crates/spellsheet-desktop/tests/ie_mode.rs`）。ラベルと入力欄は同じ名前になるので、部品は `role` も付けて指します。**実機の Edge ではまだ試していません**（[desktop.md](desktop.md)）。Windows Server では IE 強化セキュリティが入っているとページが空のままになります（ふつうの PC では切れています）。

### ダウンロードとアップロード

`browser.download` はリンクやボタンを押して、ダウンロードされたファイルを保存します。パスはフローのフォルダーからの相対で、`"path": "input/受注.csv"` とすれば次の `file.readCsv` / `excel.readRows` がそのまま読めます。`path` の代わりに `folder` を書くと、サイトが付けた名前のまま保存します（出力の `fileName`）。`browser.upload` はフォームにファイルを添付します。ファイルの入力欄そのものでも、ファイル選択を開くボタンでも使えます（選択の画面は出ません）。添付するだけなので、続けて送信ボタンを押します。

どちらも `dangerous`（ダウンロードはファイルを書き、アップロードは外に送る）なので、確認パネルの「外への影響」に出ます。

### JS のダイアログ（alert・confirm・prompt）

ダイアログを出す操作のノードに `dialog` を付けて答えます：`"accept"`（OK）、`"dismiss"`（キャンセル）、prompt に文字を入れるなら `{ "action": "accept", "promptText": "…" }`。ノードはダイアログを待ち（サーバーの返事の後に出る「登録しました」のように、クリックから少し遅れて出るものも）、その文を出力するので、alert に出る受付番号を `saveAs` で残せます。ノードの制限時間内に出なければ `DIALOG_NOT_SHOWN` で失敗します。

`dialog` がないときは、人のいないブラウザと同じように閉じ（alert は OK、confirm・prompt はキャンセル）、次に失敗したノードの `details.dismissedDialog` に出します。ページが自分で描くダイアログは普通の部品なので、そのボタンを `browser.click` で押します。

### 何ページにも分かれた表

表の下の「次へ」で何ページにも分かれた一覧は、上のノードのくり返しで読みます（専用のノードはありません）。ページを読んで行に足し、「次へ」がある間はそれを押します：

```jsonc
{ "type": "variable.set", "params": { "name": "rows", "expression": "[]" } },
{ "type": "variable.set", "params": { "name": "more", "expression": "true" } },
{ "type": "variable.set", "params": { "name": "pageNo", "expression": "1" } },
{ "type": "control.while", "params": { "condition": "more", "maxIterations": 200 }, "blocks": { "body": [
  { "type": "browser.getTable", "params": { "target": { "css": "#orders" } }, "saveAs": "page" },
  { "type": "variable.set", "params": { "name": "rows", "expression": "rows + page" } },
  { "type": "browser.isVisible", "params": { "target": { "role": "link", "name": "次へ" } }, "saveAs": "more" },
  { "type": "control.if", "params": { "condition": "more" }, "blocks": { "then": [
    { "type": "browser.click", "params": { "target": { "role": "link", "name": "次へ" } } },
    { "type": "variable.set", "params": { "name": "pageNo", "expression": "pageNo + 1" } },
    { "type": "browser.waitFor", "params": { "target": { "text": "{{ pageNo }} ページ" } } }
  ] } }
] } }
```

押したあとは次のページにしか出ないもの（ここではページ番号）を待ちます。待たないと `getTable` が前の表をもう一度読むことがあります。最後のページにも灰色の「次へ」が残るサイトでは、押せるリンクだけにあるもので `target` を書きます（例 `css: "a.next:not(.disabled)"`）。

### フレーム

iframe の中や、古いフレームセットのページの `<frame>` の中の部品は、`target` に `frame` を付けます：フレームの `name`（または `id`）属性、`title` や `src` の一部、または `css`。フレームの中のフレームは、外側を `frame.frame` に書きます（4 段まで）。画面から選ぶ・`ask_user_to_pick` で iframe の中の部品を指すと、この `frame` も付いて返ります（`name` → `title` → `src` → タグの順で、ほかのフレームと見分けられるもの。同じものが並ぶときは `nth`）。

```jsonc
{ "label": "備考", "frame": { "name": "main" } }
{ "role": "button", "name": "検索", "frame": { "name": "body", "frame": { "name": "main" } } }
```

`inspect_page` はページのフレームを `frames` に並べ、`target: { "css": "body", "frame": { "name": "main" } }` を付けて呼ぶとその中を見せます。失敗したノードの `details.frames` にも出ます。

### JavaScript の実行（`browser.runScript`）

ほかのノードで読めない値（ページの JavaScript が持っている値、画面に出ない状態、たくさんの要素をまとめた計算）だけに使います。文字・属性・表を読む、押す、入力するにはそれぞれのノードがあり、そちらのほうが読みやすく、ページが変わっても壊れにくいからです。

`script` は async 関数の中身で、結果は `return` で返します（`await` も使えます）。中では `args` に `args` の値、`element` に `target` の要素（`target` がなければ `null`）が入ります。フローの値は **`args` に `{{ }}` で入れ、`script` には書きません**（値に引用符が入るとコードが壊れるため）。

```jsonc
{ "type": "browser.runScript", "params": { "script": "return window.app.orders.length;" }, "saveAs": "orderCount" }
{ "type": "browser.runScript", "params": {
  "script": "const res = await fetch('/api/orders?code=' + encodeURIComponent(args.code)); return await res.json();",
  "args": { "code": "{{ order.code }}" }
}, "saveAs": "detail" }
```

- 出力は文字・数値・真偽値・`null` と、それらの配列・オブジェクト。要素や関数は `null`、日付は ISO 形式の文字になります
- `target` があればその要素のフレーム、なければ `frame` のフレーム（省略時はページ）で動きます
- ページが eval を禁じていても（CSP）動きます
- 返した Promise はノードの `timeoutMs` まで待ち、過ぎると `SCRIPT_TIMEOUT`。例外や文法の誤りは `SCRIPT_ERROR` で、その文が出ます
- 動くのは **開いているページの中だけ** で、PC のファイルやプログラムには触れません。ただしページでできること（送信・削除など）は何でもできるので `dangerous` で、確認パネルの「外への影響」に出ます
- 登録済みのシークレットは渡せません。シークレットの値やパスワード欄に入っている文字が結果に混ざると `***` になります

ログイン・パスワード・MFA の扱いは [secrets.md](secrets.md) を見てください。ブラウザで OAuth のサインインをする Web API（`oauth.signIn`）は [oauth.md](oauth.md) です。

### 記録

フロー図の下のドックの **記録** を押すと、どこで記録するかを聞きます。**ブラウザ** と URL（フローの最初の `browser.open` から入ります）を選ぶと、上に赤い帯の付いたブラウザが開き、帯を押すまでの操作を書き留めます。フローの実行でブラウザが開いているときは、そのブラウザで記録します。

- クリック（右クリック・ダブルクリックも）は `browser.click`、入力した文字は欄ごとに 1 つの `browser.fill`、選択肢は `browser.select`、チェックボックスは `browser.check`、Enter・Tab・Esc は `browser.press`、アドレス欄に打った URL は `browser.open` になります。
- `target` は「画面から選ぶ」と同じ作り方（役割と名前を優先）です。パスワード欄の文字は記録しません。ノードでシークレットを選んでもらいます。
- 記録しないもの：ドラッグ、ファイルのアップロード（`browser.upload` を足してください）、クリックで新しいタブに開いたページ。

止めると、デスクトップの記録と同じ **記録した操作** の一覧が出て、**そのままノードにする**・**AI に整えてもらう** が使えます。アダプターの inspect に `action: "record"`・`"stopRecording"` を渡しても同じことができます。

### 要素の指定（`target`）

意味で指定します。CSS は最後の手段です。

```jsonc
{ "role": "button", "name": "ログイン" }        // ボタン・リンク・見出し・セルなど（第一候補）
{ "label": "ユーザー名" }                        // 入力欄
{ "text": "A-1001 を出荷しました" }              // 表示されている文字
{ "placeholder": "例：青葉商店" } / { "testId": "submit" } / { "css": "#q" }
// 共通：exact（完全一致）, nth（複数一致したときの 0 始まりの番号）, frame（入っている iframe）
```

待機は Playwright の自動待機を使うので、`flow.delay` を挟む必要はありません。待つ上限はノードの `timeoutMs`（既定 30 秒）で、アダプター側の操作もその直前で止まるため、タイムアウトしたクリックが再試行の後で遅れて実行されることはありません。

Writer では、フローを実行しているあいだ（ノードで止めているときも）、ブラウザのノードの対象に **画面から選ぶ** と **光らせる** が使えます。Writer をしまい、実行中のブラウザで部品をクリックします（Esc でやめる。ページにはクリックが渡りません）。実行していないときは、そのノードより上にある一番近い「ページを開く」のアドレス（変数でなく書いてあるもの）を Writer が自分のブラウザで開いて、そこで選びます。このブラウザは次に選ぶときまで開いたままで、人が別のページへ移っていればそのページで選べます。上に「ページを開く」がないときは押せず、その旨が出ます。iframe の中の部品も選べ、光らせられます（別のサイトの iframe、フレームの中のフレームも）。

### エラー

| コード | 意味 | 再試行 |
|---|---|---|
| `ELEMENT_NOT_FOUND` | 要素が見つからない。`details.page` にそのときのページ（アクセシビリティツリー）と直し方のヒント | する |
| `OPTION_NOT_FOUND` | `browser.select` の値が選択肢の表示名にも値にもない。`details.options` に選択肢 | しない |
| `ELEMENT_AMBIGUOUS` | 複数の要素に一致。`exact` / `nth` で絞る | しない |
| `TAB_NOT_FOUND` | `browser.switchTab` に合うタブがない。`details.tabs` にタブの一覧 | する |
| `LAST_TAB` | タブが 1 つだけのときの `browser.closeTab`（`browser.close` を使う） | しない |
| `DIALOG_NOT_SHOWN` | `dialog` を付けたのに JS のダイアログが出なかった | しない |
| `BROWSER_NOT_RUNNING` | `browser.attach` で `port` にブラウザがない。`details.hint` に起動のしかた | する |
| `CONTEXT_IN_USE` | `browser.open` が使っている `context` に `browser.attach` | しない |
| `DOWNLOAD_NOT_STARTED` | `browser.download` で押したがダウンロードが始まらない | しない |
| `DOWNLOAD_FAILED` | ダウンロードが途中で切れた | する |
| `FILE_NOT_FOUND` | `browser.upload` のファイルがない | しない |
| `FILE_CHOOSER_NOT_SHOWN` | `browser.upload` の対象がファイルの入力欄でも、ファイル選択を開くものでもない | しない |
| `SCRIPT_ERROR` | `browser.runScript` のスクリプトが例外を出した、または文法の誤り | しない |
| `SCRIPT_TIMEOUT` | `browser.runScript` のスクリプトがノードの制限時間内に終わらない | しない |
| `BROWSER_NOT_OPEN` | 同じ `context` の `browser.open` がない | しない |
| `NAVIGATION_FAILED` | ページを開けない | する |
| `BROWSER_LAUNCH_FAILED` | ブラウザを起動できない | しない |
| `ADAPTER_UNAVAILABLE` | Node.js かアダプターが見つからない | しない |
| `ADAPTER_CRASHED` | アダプターが異常終了。次の要求で自動的に再起動 | する |

## AI からフローを作る（MCP）

MCP サーバーに 3 つのツールがあります（権限区分は `run`）。

- `inspect_page`：ページを開いて（または開いているページの）アクセシビリティツリーを返す。`- button "ログイン"` と出ていれば `{ "role": "button", "name": "ログイン" }` がそのまま `target` になる。`image: true` でスクリーンショットも AI に渡す（名前のないアイコンなど、ツリーでは見分けられないページ向け）
- `test_step`：ノードを 1 つその場で実行して、出力と実行後のページを返す（どのアダプターのノードでも使える）。ログインしてから次の画面を調べる、といった下調べに使う。フローは変更しない。browser ノードは実行の前に、対象をブラウザ上で少しのあいだ枠で光らせる（「ここを押します」）ので、見ている人に AI が何を触るのかがわかる
- `ask_user_to_pick`：どの部品かわからないとき（行ごとの「編集」ボタン、名前のないアイコンなど）、AI は推測せず人に指してもらう。ブラウザのウィンドウが前に出て AI の `message` が帯で出て、迷っている `candidates` には番号付きの枠が付く。人のクリックはページに届く前に受け止めるので、ボタンは押されない。指した部品は `target` で返る（同じものが複数あれば `nth` と、その表の行の文字 `row` も。iframe の中なら `frame` も）。同時に Writer に「AI がブラウザの画面で指してほしいと言っています」と出て、そこから断れる。ブラウザの「わからない」か Esc でも断れる（`status: "cancelled"`）。ウィンドウのあるブラウザが必要

AI はこれでサイトを確かめながらノードを組み、`validate_flow` → `run_flow` で AI なしの実行を確認します。

## 仕組み

```text
Runtime ──(JSON-RPC over stdio)──▶ node packages/browser-adapter/src/main.ts ──▶ Playwright ──▶ Edge / Chrome
  browser.* ステップ                   実行 × context ごとに BrowserContext
```

- ブラウザ対応は「アダプター」の 1 つです。ほかのアプリを足す方法は [adapters.md](adapters.md)。
- アダプターは最初のブラウザノードで起動し、全実行で共有します。異常終了すると実行中のノードは `ADAPTER_CRASHED` で失敗し、次の要求で起動し直します。
- アダプターの stderr は Rust の tracing（`spellsheet_browser::adapter`）に流れます。

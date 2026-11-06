# ブラウザ操作（Phase 3）

[English](../browser.md) | 日本語

Shikigami のシナリオから Web ページを操作します。Rust の Runtime が Node.js + Playwright のブラウザアダプター（`packages/browser-adapter`）を子プロセスとして起動し、改行区切りの JSON-RPC 2.0（stdio）で指示します。シナリオの実行に AI は関わりません。

## 必要なもの

- **インストーラーで入れた場合は追加のものは不要です。** Node.js とアダプターが同梱されています（[release.md](release.md#nodejs-とブラウザアダプターの同梱)）
- ソースから動かす場合：Node.js 22.18 以降（TypeScript をそのまま実行します）と、リポジトリでの `pnpm install`（`playwright-core` が入ります）
- ブラウザ：Windows では **Microsoft Edge をそのまま使う** ので追加のダウンロードは不要です。Chrome を使うときは `SHIKIGAMI_BROWSER_CHANNEL=chrome`、任意の実行ファイルは `SHIKIGAMI_BROWSER_PATH`

| 環境変数 | 意味 |
|---|---|
| `SHIKIGAMI_BROWSER_CHANNEL` | `msedge`（Windows の既定）/ `chrome` など |
| `SHIKIGAMI_BROWSER_PATH` | ブラウザの実行ファイル |
| `SHIKIGAMI_BROWSER_HEADLESS` | `1` で常に画面なし（無人実行・CI 向け） |
| `SHIKIGAMI_BROWSER_SLOWMO` | 操作ごとの待ち（ミリ秒）。デモで動きを見せるとき |
| `SHIKIGAMI_BROWSER_ADAPTER` | アダプター `main.ts` の場所（通常は自動で見つける） |
| `SHIKIGAMI_NODE` | Node.js の実行ファイル（既定は同梱の `node\node.exe`、なければ PATH 上の `node`） |

## デモ

```powershell
pnpm demo:browser
```

デモ用の業務サイト「サンプル商事 受注管理システム」（`examples/web`）を `http://127.0.0.1:8787/` で起動し、`examples/browser-demo.json` を CLI で実行します。デモ用アカウントは最初にシークレット「デモ受注システム」として登録するので、シナリオにパスワードは書かれていません（Studio の「🔑 シークレット」にも出ます）。

1. 受注係と在庫係が **同時に** 作業する：受注係がログインして受注一覧を読み、在庫係は別のウィンドウで在庫一覧を読む（`control.parallel` と別々の `context`）
2. 未処理の注文ごとに「出荷する」を押し、処理完了の表示を待つ（`control.forEach` + `control.if`）
3. 出荷した注文番号・合計金額・在庫切れの商品を出力する
4. ログイン状態を `session` で保存するので、**2 回目の実行ではログイン画面を飛ばす**

CLI は `target/demo` にビルドするので、MCP サーバーなどで `target\debug\shikigami.exe` を使用中でも上書きで失敗しません（初回はビルドに少し時間がかかります）。サイトだけ起動するときは `pnpm demo:site`。Studio からも同じシナリオを読み込んで実行できます。

## ノード

| type | 主な params | 出力 |
|---|---|---|
| `browser.open` | `url`, `headless`, `session`（ログイン状態を保存・再利用する名前）, `dialog` | `{ url, title }` |
| `browser.click` | `target`, `dialog`（クリックで出る JS のダイアログへの答え） | ダイアログの文 / `null` |
| `browser.hover` | `target` | – |
| `browser.scroll` | `target`（見えるところまで）と `to`（`top` / `bottom`）のどちらか、または両方 | – |
| `browser.fill` | `target`, `value`（文字、または登録済みシークレット `{ "secret": "名前", "field": "password" }`） | – |
| `browser.select` | `target`, `value`（表示名、または配列） | – |
| `browser.press` | `key`（`Enter` など）, `target`（省略時はページ）, `dialog` | ダイアログの文 / `null` |
| `browser.getText` | `target`, `all`（`true` で全一致の配列） | 文字列 / 配列 |
| `browser.getTable` | `target`（省略時は最初の表） | 見出しをキーにしたオブジェクトの配列 |
| `browser.getAttribute` | `target`, `name`（`href`・`src`・`value`・`data-id` など）, `all` | 文字列 / `null` / 配列（`href`・`src` は完全なアドレス） |
| `browser.switchTab` | `title` / `url`（一部でよい）か `index`（0 が最初のタブ） | `{ url, title, index }` |
| `browser.closeTab` | – | 戻った先のタブの `{ url, title }` |
| `browser.waitFor` | `target`, `state`（`visible` / `hidden` / `attached` / `detached`） | – |
| `browser.screenshot` | `path`（絶対パス）, `fullPage` | 保存先 |
| `browser.isVisible` | `target`, `waitMs`（既定 2000） | `true` / `false`（見つからなくても失敗しない） |
| `browser.waitForHuman` | `message`, `until`（人の操作が終わると出る要素） | – |
| `browser.close` | – | – |

すべてのノードに `context`（既定 `default`）があります。`context` ごとに Cookie もタブも別で、ノードはその **今のタブ** を操作します。**同じ `context` のノードは 1 つずつ、別の `context` は同時に** 動きます（排他は Runtime が `context` から自動で決めるので、シナリオにロックを書く必要はありません）。実行が終わると、その実行で開いた `context` は自動で閉じます。

### タブとポップアップ

`target="_blank"` のリンクやウィンドウを開くボタンを押すと、その `context` にタブが増えますが、ノードは `browser.switchTab` で移るまで今のタブのままです。クリックのすぐ後に置きます：タブが開くのを待ち、タイトルに `title` を含む（アドレスに `url` を含む）いちばん新しいタブに移ります。`browser.closeTab` は今のタブを閉じて前のタブに戻ります。自分で閉じるポップアップ（`window.close()`）のときは自動で前のタブに戻ります。

```jsonc
{ "type": "browser.click", "params": { "target": { "role": "button", "name": "詳細" } } },
{ "type": "browser.switchTab", "params": { "title": "受注詳細" } },
{ "type": "browser.getText", "params": { "target": { "role": "heading" } }, "saveAs": "title" },
{ "type": "browser.closeTab" }
```

### JS のダイアログ（alert・confirm・prompt）

ダイアログを出す操作のノードに `dialog` を付けて答えます：`"accept"`（OK）、`"dismiss"`（キャンセル）、prompt に文字を入れるなら `{ "action": "accept", "promptText": "…" }`。ノードはダイアログを待ち（サーバーの返事の後に出る「登録しました」のように、クリックから少し遅れて出るものも）、その文を出力するので、alert に出る受付番号を `saveAs` で残せます。ノードの制限時間内に出なければ `DIALOG_NOT_SHOWN` で失敗します。

`dialog` がないときは、人のいないブラウザと同じように閉じ（alert は OK、confirm・prompt はキャンセル）、次に失敗したノードの `details.dismissedDialog` に出します。ページが自分で描くダイアログは普通の部品なので、そのボタンを `browser.click` で押します。

### フレーム

iframe の中や、古いフレームセットのページの `<frame>` の中の部品は、`target` に `frame` を付けます：フレームの `name`（または `id`）属性、`title` や `src` の一部、または `css`。フレームの中のフレームは、外側を `frame.frame` に書きます。

```jsonc
{ "label": "備考", "frame": { "name": "main" } }
{ "role": "button", "name": "検索", "frame": { "name": "body", "frame": { "name": "main" } } }
```

`inspect_page` はページのフレームを `frames` に並べ、`target: { "css": "body", "frame": { "name": "main" } }` を付けて呼ぶとその中を見せます。失敗したノードの `details.frames` にも出ます。

ログイン・パスワード・MFA の扱いは [secrets.md](secrets.md) を見てください。ブラウザで OAuth のサインインをする Web API（`oauth.signIn`）は [oauth.md](oauth.md) です。

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

### エラー

| コード | 意味 | 再試行 |
|---|---|---|
| `ELEMENT_NOT_FOUND` | 要素が見つからない。`details.page` にそのときのページ（アクセシビリティツリー）と直し方のヒント | する |
| `OPTION_NOT_FOUND` | `browser.select` の値が選択肢の表示名にも値にもない。`details.options` に選択肢 | しない |
| `ELEMENT_AMBIGUOUS` | 複数の要素に一致。`exact` / `nth` で絞る | しない |
| `TAB_NOT_FOUND` | `browser.switchTab` に合うタブがない。`details.tabs` にタブの一覧 | する |
| `LAST_TAB` | タブが 1 つだけのときの `browser.closeTab`（`browser.close` を使う） | しない |
| `DIALOG_NOT_SHOWN` | `dialog` を付けたのに JS のダイアログが出なかった | しない |
| `BROWSER_NOT_OPEN` | 同じ `context` の `browser.open` がない | しない |
| `NAVIGATION_FAILED` | ページを開けない | する |
| `BROWSER_LAUNCH_FAILED` | ブラウザを起動できない | しない |
| `ADAPTER_UNAVAILABLE` | Node.js かアダプターが見つからない | しない |
| `ADAPTER_CRASHED` | アダプターが異常終了。次の要求で自動的に再起動 | する |

## AI からシナリオを作る（MCP）

MCP サーバーに 3 つのツールがあります（権限区分は `run`）。

- `inspect_page`：ページを開いて（または開いているページの）アクセシビリティツリーを返す。`- button "ログイン"` と出ていれば `{ "role": "button", "name": "ログイン" }` がそのまま `target` になる。`image: true` でスクリーンショットも AI に渡す（名前のないアイコンなど、ツリーでは見分けられないページ向け）
- `test_step`：ノードを 1 つその場で実行して、出力と実行後のページを返す（どのアダプターのノードでも使える）。ログインしてから次の画面を調べる、といった下調べに使う。シナリオは変更しない。browser ノードは実行の前に、対象をブラウザ上で少しのあいだ枠で光らせる（「ここを押します」）ので、見ている人に AI が何を触るのかがわかる
- `ask_user_to_pick`：どの部品かわからないとき（行ごとの「編集」ボタン、名前のないアイコンなど）、AI は推測せず人に指してもらう。ブラウザのウィンドウが前に出て AI の `message` が帯で出て、迷っている `candidates` には番号付きの枠が付く。人のクリックはページに届く前に受け止めるので、ボタンは押されない。指した部品は `target` で返る（同じものが複数あれば `nth` と、その表の行の文字 `row` も）。同時に Studio に「AI がブラウザの画面で指してほしいと言っています」と出て、そこから断れる。ブラウザの「わからない」か Esc でも断れる（`status: "cancelled"`）。ウィンドウのあるブラウザが必要

AI はこれでサイトを確かめながらノードを組み、`validate_scenario` → `run_scenario` で AI なしの実行を確認します。

## 仕組み

```text
Runtime ──(JSON-RPC over stdio)──▶ node packages/browser-adapter/src/main.ts ──▶ Playwright ──▶ Edge / Chrome
  browser.* ステップ                   実行 × context ごとに BrowserContext
```

- ブラウザ対応は「アダプター」の 1 つです。ほかのアプリを足す方法は [adapters.md](adapters.md)。
- アダプターは最初のブラウザノードで起動し、全実行で共有します。異常終了すると実行中のノードは `ADAPTER_CRASHED` で失敗し、次の要求で起動し直します。
- アダプターの stderr は Rust の tracing（`shikigami_browser::adapter`）に流れます。

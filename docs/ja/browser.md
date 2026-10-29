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
| `browser.open` | `url`, `headless`, `session`（ログイン状態を保存・再利用する名前） | `{ url, title }` |
| `browser.click` | `target` | – |
| `browser.fill` | `target`, `value`（文字、または登録済みシークレット `{ "secret": "名前", "field": "password" }`） | – |
| `browser.select` | `target`, `value`（表示名、または配列） | – |
| `browser.press` | `key`（`Enter` など）, `target`（省略時はページ） | – |
| `browser.getText` | `target`, `all`（`true` で全一致の配列） | 文字列 / 配列 |
| `browser.getTable` | `target`（省略時は最初の表） | 見出しをキーにしたオブジェクトの配列 |
| `browser.waitFor` | `target`, `state`（`visible` / `hidden` / `attached` / `detached`） | – |
| `browser.screenshot` | `path`（絶対パス）, `fullPage` | 保存先 |
| `browser.isVisible` | `target`, `waitMs`（既定 2000） | `true` / `false`（見つからなくても失敗しない） |
| `browser.waitForHuman` | `message`, `until`（人の操作が終わると出る要素） | – |
| `browser.close` | – | – |

すべてのノードに `context`（既定 `default`）があります。`context` ごとに Cookie もタブも別で、**同じ `context` のノードは 1 つずつ、別の `context` は同時に** 動きます（排他は Runtime が `context` から自動で決めるので、シナリオにロックを書く必要はありません）。実行が終わると、その実行で開いた `context` は自動で閉じます。

ログイン・パスワード・MFA の扱いは [secrets.md](secrets.md) を見てください。ブラウザで OAuth のサインインをする Web API（`oauth.signIn`）は [oauth.md](oauth.md) です。

### 要素の指定（`target`）

意味で指定します。CSS は最後の手段です。

```jsonc
{ "role": "button", "name": "ログイン" }        // ボタン・リンク・見出し・セルなど（第一候補）
{ "label": "ユーザー名" }                        // 入力欄
{ "text": "A-1001 を出荷しました" }              // 表示されている文字
{ "placeholder": "例：青葉商店" } / { "testId": "submit" } / { "css": "#q" }
// 共通：exact（完全一致）, nth（複数一致したときの 0 始まりの番号）
```

待機は Playwright の自動待機を使うので、`flow.delay` を挟む必要はありません。待つ上限はノードの `timeoutMs`（既定 30 秒）で、アダプター側の操作もその直前で止まるため、タイムアウトしたクリックが再試行の後で遅れて実行されることはありません。

### エラー

| コード | 意味 | 再試行 |
|---|---|---|
| `ELEMENT_NOT_FOUND` | 要素が見つからない。`details.page` にそのときのページ（アクセシビリティツリー）と直し方のヒント | する |
| `OPTION_NOT_FOUND` | `browser.select` の値が選択肢の表示名にも値にもない。`details.options` に選択肢 | しない |
| `ELEMENT_AMBIGUOUS` | 複数の要素に一致。`exact` / `nth` で絞る | しない |
| `BROWSER_NOT_OPEN` | 同じ `context` の `browser.open` がない | しない |
| `NAVIGATION_FAILED` | ページを開けない | する |
| `BROWSER_LAUNCH_FAILED` | ブラウザを起動できない | しない |
| `ADAPTER_UNAVAILABLE` | Node.js かアダプターが見つからない | しない |
| `ADAPTER_CRASHED` | アダプターが異常終了。次の要求で自動的に再起動 | する |

## AI からシナリオを作る（MCP）

MCP サーバーに 2 つのツールがあります（権限区分は `run`）。

- `inspect_page`：ページを開いて（または開いているページの）アクセシビリティツリーを返す。`- button "ログイン"` と出ていれば `{ "role": "button", "name": "ログイン" }` がそのまま `target` になる
- `test_step`：ノードを 1 つその場で実行して、出力と実行後のページを返す（どのアダプターのノードでも使える）。ログインしてから次の画面を調べる、といった下調べに使う。シナリオは変更しない

AI はこれでサイトを確かめながらノードを組み、`validate_scenario` → `run_scenario` で AI なしの実行を確認します。

## 仕組み

```text
Runtime ──(JSON-RPC over stdio)──▶ node packages/browser-adapter/src/main.ts ──▶ Playwright ──▶ Edge / Chrome
  browser.* ステップ                   実行 × context ごとに BrowserContext
```

- ブラウザ対応は「アダプター」の 1 つです。ほかのアプリを足す方法は [adapters.md](adapters.md)。
- アダプターは最初のブラウザノードで起動し、全実行で共有します。異常終了すると実行中のノードは `ADAPTER_CRASHED` で失敗し、次の要求で起動し直します。
- アダプターの stderr は Rust の tracing（`shikigami_browser::adapter`）に流れます。

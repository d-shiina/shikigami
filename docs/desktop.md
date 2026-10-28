# デスクトップアプリ操作（Phase 4）

Windows のアプリ（業務システム、メモ帳、Excel の画面、SAP GUI など）をシナリオから操作します。ステップはアプリの作り（Win32 / WinForms / WPF / UWP / SAP / Java）で分けず、**`desktop.*` の 1 セットだけ** です。どの技術でアプリの中を見るかは、Shikigami が対象のウィンドウを見て決めます。シナリオの実行に AI は関わりません。

## 対象の書き方

```json
{ "window": { "title": "請求システム", "process": "billing.exe" },
  "element": { "id": "btnSave" } }
```

- `window`：トップレベルのウィンドウ。`title`（既定は部分一致・大文字小文字無視、`exact: true` で完全一致）か `process`（実行ファイル名、`.exe` は省略可）のどちらかは必須。複数当たるときは `nth`（0 始まり）
- `element`：ウィンドウ内の部品。`id`（UI Automation の AutomationId、完全一致）が第一候補、なければ `role` + `name`。省略するとウィンドウ自体
- `role` はブラウザと同じ語彙です（`button` `textbox` `checkbox` `combobox` `list` `listitem` `menuitem` `tab` `tree` `treeitem` `table` `row` `text` …）。`{ "role": "button", "name": "保存" }` はブラウザでもデスクトップでも同じ意味です
- `point`（ウィンドウ左上からの座標）は `desktop.mouseClick` だけで使える最終手段です

部品が複数当たったときは「どれか」を選ばずにエラー（`ELEMENT_AMBIGUOUS`、候補つき）にします。実行のたびに違う部品を押すことがないようにするためです。

## ステップ

| type | 主な params | 出力 | マウス・キーボード |
|---|---|---|---|
| `desktop.launch` | `path`, `args`, `workingDir` | `{ pid }` | – |
| `desktop.click` | `target` | – | 使わない |
| `desktop.setValue` | `target`, `value`（文字またはシークレット） | – | 使わない |
| `desktop.getValue` | `target` | 文字（チェックボックスは true / false） | 使わない |
| `desktop.select` | `target`, `value`（選択肢の名前） | – | 使わない |
| `desktop.waitFor` | `target`, `state`（visible / hidden / enabled） | – | 使わない |
| `desktop.isVisible` | `target`, `waitMs` | true / false | 使わない |
| `desktop.closeWindow` | `target` | – | 使わない |
| `desktop.mouseClick` | `target`, `button`, `double` | – | **使う** |
| `desktop.type` | `target`, `text`（文字またはシークレット） | – | **使う** |
| `desktop.press` | `target`, `key`（`Enter` `Control+S` `Alt+F4` など。ブラウザと同じ書き方） | – | **使う** |

- **待ち時間を書かなくてよい**：どのステップも、ウィンドウや部品が現れる（無効なら有効になる）まで自動で探し直します。上限はステップの `timeoutMs`（既定 30 秒）。消えるのを待つときだけ `desktop.waitFor` の `state: "hidden"` を使います
- **まずマウスを使わない操作**：`desktop.click` はボタンを押す・チェックを切り替える・項目を選ぶ・ツリーを開く操作を、マウスを動かさずに行います。ウィンドウが裏にあっても動き、ほかの作業と並行できます。反応しないアプリだけ `desktop.mouseClick` / `desktop.type` を使います
- **マウス・キーボードは 1 組だけ**：「使う」のステップは画面の使用権（`desktop.input`）を自動で取ってから動くので、並行ブランチの中でも同時には動きません。同じアプリ（`process` が同じ）へのステップも 1 つずつ動きます。シナリオにロックは書きません

## AI が画面を調べる（MCP）

- `inspect_ui`（引数なし）：開いているウィンドウの一覧（タイトル・プロセス・アプリの種類）
- `inspect_ui`（`window` あり）：そのウィンドウの部品を字下げした一覧で返します。この行をそのまま対象に写します

```text
- window "請求システム"
  - pane
    - textbox "顧客コード" id=txtCustomer value="C-001"
    - textbox "パスワード" id=txtPassword [password]
    - checkbox "請求書を送る" [checked]
    - button "保存" id=btnSave
```

- `test_step`：1 ステップだけその場で実行し、出力と操作後のウィンドウの一覧を返します。画面を順にたどってからシナリオを書けます
- パスワード欄の中身は一覧にも `desktop.getValue` にも出しません

## ログイン（シークレット）

パスワードは Studio の「🔑 シークレット」に登録し、シナリオには名前だけを書きます（[secrets.md](secrets.md)）。デスクトップアプリに入力するときは、シークレットの「入力してよいサイト・アプリ」に **`app:<実行ファイル名>`**（例 `app:billing.exe`）を登録します。登録のないアプリには入力しません。

```json
{ "type": "desktop.setValue",
  "params": { "target": { "window": { "process": "billing.exe" }, "element": { "id": "txtPassword" } },
              "value": { "secret": "請求システム", "field": "password" } } }
```

## アプリの種類と見え方

| アプリ | いまの見え方 | 予定 |
|---|---|---|
| Win32 / WinForms / WPF / UWP、Office の画面 | UI Automation で部品が見える | – |
| SAP GUI for Windows | UI Automation では一部しか見えないことが多い（`inspect_ui` に注記） | SAP GUI Scripting を別の掴み方として追加。ステップは同じ `desktop.*`、SAP 固有の操作（トランザクションコードなど）だけ専用の型を足す。SAP サーバー側の `sapgui/user_scripting` と SAP GUI のオプションでスクリプトを有効にする必要がある |
| Java（Swing など） | 枠しか見えないことが多い（注記） | Java Access Bridge（`jabswitch -enable` で有効化） |
| Citrix / リモートデスクトップの中 | 部品は見えない | 画像認識と座標（`point`） |
| Excel のデータ | – | xlsx を直接読み書きする `excel.*`（[adapters.md](adapters.md)） |

## しくみ

- UI Automation は **ウィンドウを持たない専用スレッド** で、マルチスレッドアパートメント（MTA）に参加して呼びます（Microsoft の推奨。Studio 自身の画面が対象でも固まらない）。ステップはこのスレッドに要求を送るだけで、部品への参照はスレッドの外に出しません。毎回 `target` から探し直します
- 接続 2 秒・処理 10 秒の UI Automation のタイムアウトを設定し、応答しないアプリで止まり続けないようにします（`APP_NOT_RESPONDING`）。クリックなどの操作中のタイムアウトは「操作が済んだかもしれない」ので、二重に押さないよう再試行しません
- 昔ながらの Win32 のボタンはクリックを投げるだけにして、押した先でダイアログが開いても待たされないようにしています
- 管理者として動いているアプリは、通常の権限の Shikigami から操作できません（Windows の制限）。`ELEVATION_REQUIRED` で知らせます
- 実行キューで待っている間にステップが時間切れ・停止になった要求は、実行せずに捨てます（停止後や再試行で二重にクリック・入力しないため）
- マウス・キーボードを使う前にウィンドウを前面に出します。Windows が許さなかったとき（画面ロック中など）は `FOREGROUND_DENIED` / `INPUT_BLOCKED` で止めます
- 座標は高 DPI でもずれないよう、スレッドを Per-Monitor DPI 対応にしています

## 主なエラー

| code | 意味と直し方 |
|---|---|
| `WINDOW_NOT_FOUND` | ウィンドウが見つからない（開いているウィンドウの一覧つき）。`inspect_ui` で title / process を確認する |
| `WINDOW_AMBIGUOUS` / `ELEMENT_AMBIGUOUS` | 複数当たった（候補つき）。条件を足すか `nth` を書く |
| `ELEMENT_NOT_FOUND` | 部品が見つからない。`inspect_ui` で id / role / name を写す |
| `NOT_CLICKABLE` / `NOT_SUPPORTED` | マウスなしでは操作できない部品。`desktop.mouseClick` / `desktop.type` を使う |
| `OPTION_NOT_FOUND` | 選択肢がない（選択肢の一覧つき） |
| `SECRET_APP_NOT_SET` / `SECRET_APP_MISMATCH` | シークレットにこのアプリ（`app:xxx.exe`）が登録されていない |
| `FOCUS_FAILED` | キーボード入力の前に部品へフォーカスを移せなかった（別の欄に打ち込まないよう止める）。入力欄そのものを対象にする |
| `ELEVATION_REQUIRED` | 管理者として動いているアプリ |
| `PLATFORM_UNSUPPORTED` | Windows 以外で実行した |

## 確認済みの事項と制約

- **確認済み**：ステップ定義・検証・自動待ち・ロック・シークレットの照合を、偽のバックエンドで自動テスト（Linux / Windows の CI）。Windows の CI でメモ帳を起動し、文字の入力と読み取りを UI Automation で行うテスト
- **未確認**：実際の業務アプリ・SAP GUI・Java アプリでの動作、マウス・キーボード操作（CI では画面操作をテストしていない）、高 DPI・複数モニター
- Studio・CLI・MCP サーバーなど **別プロセス間** のマウス・キーボードの排他は未実装です（同じプロセス内のみ）
- スクリーンショット、表（グリッド）の一括読み取り、メニューを順にたどる書き方は未実装です

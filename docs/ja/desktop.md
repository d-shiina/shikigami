# デスクトップアプリ操作（Phase 4）

[English](../desktop.md) | 日本語

Windows のアプリ（業務システム、メモ帳、Excel の画面、SAP GUI など）をフローから操作します。ノードはアプリの作り（Win32 / WinForms / WPF / UWP / SAP / Java）で分けず、**`desktop.*` の 1 セットだけ** です。どの技術でアプリの中を見るかは、Shikigami が対象のウィンドウを見て決めます。フローの実行に AI は関わりません。

## 対象の書き方

```json
{ "window": { "title": "請求システム", "process": "billing.exe" },
  "element": { "id": "btnSave" } }
```

- `window`：トップレベルのウィンドウ。`title`（既定は部分一致・大文字小文字無視、`exact: true` で完全一致）か `process`（実行ファイル名、`.exe` は省略可）のどちらかは必須。複数当たるときは `nth`（0 始まり）
- `element`：ウィンドウ内の部品。`id`（UI Automation の AutomationId、完全一致）が第一候補、なければ `role` + `name`。省略するとウィンドウ自体
- `role` はブラウザと同じ語彙です（`button` `textbox` `checkbox` `combobox` `list` `listitem` `menuitem` `tab` `tree` `treeitem` `table` `row` `text` …）。`{ "role": "button", "name": "保存" }` はブラウザでもデスクトップでも同じ意味です
- 部品が見えないアプリ（Citrix・リモートデスクトップ・独自描画の画面）では、`image`（画像）か `ocr`（文字）で画面の上の場所を指せます（下の「部品が見えない画面」）
- `point`（ウィンドウ左上からの座標）は `desktop.mouseClick` だけで使える最終手段です

部品が複数当たったときは「どれか」を選ばずにエラー（`ELEMENT_AMBIGUOUS`、候補つき）にします。実行のたびに違う部品を押すことがないようにするためです。

### 画面から選ぶ・名前付きの部品

- Studio では、デスクトップのノードの対象に **画面から選ぶ**（Studio をしまい、マウスの下の部品を枠で囲む。クリックで選ぶ、Esc か右クリックでやめる。クリックはアプリに渡らない）と **光らせる**（今の画面で対象を探して枠で囲む）があります。対象は壊れにくい順に組みます：ウィンドウの中で一つに決まる `id`、なければ `role` + `name`（完全一致）、次に `nth`、最後にウィンドウの中の `point`。AI からはアダプターの inspect に `action: "pick"` / `"highlight"` を渡すと同じことができます。
- **名前付きの部品**：フローの `parts` に対象を置き（`"parts": { "saveButton": { "label": "保存ボタン", "app": "desktop", "target": { … } } }`）、ノードは `"target": { "part": "saveButton" }` と書きます（ほかの項目は並べない）。画面が変わったら部品を 1 か所直せば済みます。Studio ではプロジェクトの「部品」に並び、ノードの対象の「部品にする」で作れます。AI は編集の `setPart` / `removePart` を使います。ブラウザのノードも同じ形で使えます（`"app": "browser"`）。
- **画像の部品**（選べる部品がない画面：Citrix・リモートデスクトップ・独自描画の画面）：画像で場所を探すノード（`desktop.mouseClick`・`desktop.waitFor`・`desktop.isVisible`・`desktop.hover`・`desktop.type`・`desktop.drag` など）は、「画面から選ぶ」の隣に **画面から切り取る** があります。Studio が最小化して画面が暗くなるので、探す画像の範囲をドラッグします（Esc か右クリックで中止）。名前を付けると種類「画像」の部品になり、画像は `templates/<キー>.png` に保存されます。部品の中身は普通のデスクトップの部品で、`{ "window": { … }, "image": { "path": "templates/image1.png", "threshold": 0.9 }, "offset": { "x": 0, "y": 0 } }` の形です（`window` は切り取った場所のウィンドウで、その中だけを探します。`region` を書くとさらに絞れます）。部品の画面では画像が見え、画像の上をクリックすると操作する位置（中心からの `offset`）が決まります。「一致率」のつまみが `threshold`（既定 90%）、**撮り直し** は同じ名前のまま画像だけを切り取り直し、使っているノードすべてに効きます。部品の一覧の下の **未使用の部品を削除** は、どのノードも使っていない部品と、ほかに使われていないその画像を消します（画像はワークスペースのごみ箱へ）。`image.path` の相対パスは、ほかのパスと同じくフローのフォルダーから解決します。アダプターの inspect に `action: "snip"` を渡しても同じことができます（ウィンドウと PNG の base64 を返します）。切り取りは Windows だけで動き、実機ではまだ試していません。

### 記録

フロー図の下のドックの **記録** を押すと、Studio をしまい、デスクトップアプリでの操作を書き留めます。画面上の帯をクリックすると止まります。

- **クリック**：押した部品の対象を、**画面から選ぶ** と同じ組み立てで残します。クリックは画面を読むあいだだけ止めてからアプリに渡します（メニューが開く前のボタンを捕まえるため）。ダブルクリックはダブルクリックのまま残ります。
- **入力**：入力欄を離れたときの最終的な文字を 1 つの `desktop.setValue` にします（IME での日本語入力も同じ。変換の F6〜F10・Esc と、変換を確定する Enter は入力の一部として扱います）。パスワード欄の文字は記録しません。ノードでシークレットを選んでもらいます。
- **キー**：Enter・Tab・Esc・F1〜F24 と、Ctrl / Alt / Windows との組み合わせ（`Control+S`）は `desktop.press` にします。入力欄の中のコピー・貼り付け・元に戻す・すべて選択は入力の一部として扱います。
- 記録しないもの：ドラッグ、ホイール、Studio 自身の操作、ブラウザ（これから）。

止めると **記録した操作** にノードの一覧が出ます。**そのままノードにする** は、新しいノードが入る場所に 1 操作 1 ノードで足します（2 か所以上で使う対象は名前付きの部品にします）。**AI に整えてもらう** は、記録を AI のペイン（使えないときはクリップボード）に渡し、画面が変わるところの待ち、繰り返しのループ、毎回変わる値の入力変数などを頼みます。記録の元データはフローの `logs/recordings/` に残ります。アダプターの inspect に `action: "record"` を渡しても同じことができます。

## ノード

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
| `desktop.setWindow` | `target`（ウィンドウ）, `state`（`maximized` / `minimized` / `normal`）, `front`（前面に出す）, `x` `y` `width` `height`（画面の左上からのピクセル。書いたものだけ変える） | `{ state, x, y, width, height }` | 使わない |
| `desktop.check` | `target`（チェックボックス）, `checked`（既定 true） | – | 使わない |
| `desktop.mouseClick` | `target`, `button`, `double` | – | **使う** |
| `desktop.type` | `target`, `text`（文字またはシークレット） | – | **使う** |
| `desktop.press` | `target`, `key`（`Enter` `Control+S` `Alt+F4` など。ブラウザと同じ書き方） | – | **使う** |
| `desktop.readText` | `target`（ウィンドウ・`element`・`region`）または `file`（画像ファイル） | `{ text, lines }`（OCR） | 使わない |
| `desktop.screenshot` | `target`（ウィンドウ・`element`・`region`）, `path` | 保存したパス | 使わない |
| `desktop.getTable` | `target`（表・グリッド・一覧。ウィンドウだけなら最初の 1 つ）, `maxRows` | 列見出しをキーにしたオブジェクトのリスト（`browser.getTable` と同じ形） | 使わない |
| `desktop.selectMenu` | `target`（ウィンドウならメニューバーか開いているメニュー、部品ならその右クリックメニュー）, `path`（上から順の名前。例 `["ファイル", "名前を付けて保存"]`） | – | 使わない |
| `desktop.scroll` | `target`。`direction` なしならその部品が見えるまで、`direction`（`up` `down` `left` `right` `top` `bottom`）・`amount`・`unit`（`page` / `line`）ありなら一覧や枠をスクロール | `{ verticalPercent, horizontalPercent, atEnd }` | 使わない |
| `desktop.mouseScroll` | `target`, `direction`（`up` `down` `left` `right`）, `amount`（ホイールの刻み、既定 3） | – | **使う** |
| `desktop.drag` | `target`（つかむ所）, `to`（離す所。別のウィンドウでもよい） | – | **使う** |
| `desktop.hover` | `target` | – | **使う** |

- **待ち時間を書かなくてよい**：どのノードも、ウィンドウや部品が現れる（無効なら有効になる）まで自動で探し直します。上限はノードの `timeoutMs`（既定 30 秒）。消えるのを待つときだけ `desktop.waitFor` の `state: "hidden"` を使います
- **まずマウスを使わない操作**：`desktop.click` はボタンを押す・チェックを切り替える・項目を選ぶ・ツリーを開く操作を、マウスを動かさずに行います。ウィンドウが裏にあっても動き、ほかの作業と並行できます。反応しないアプリだけ `desktop.mouseClick` / `desktop.type` を使います
- **メニューは名前で**：`desktop.selectMenu` は名前を画面の表示どおりに、アクセスキー（`(F)`・`&`）・末尾の `...`・ショートカットを除いて照らし合わせ、サブメニューが開くのを待ちます。部品の右クリックメニューがマウスなしで開かない（`NOT_SUPPORTED`）ときは、`desktop.mouseClick`（`button: "right"`）で開いてから、`desktop.selectMenu` にウィンドウだけを渡します
- **表はまとめて**：`desktop.getTable` は、対応しているグリッド（WPF、多くの WinForms・Win32 のもの）なら画面外の行も含めて全部読みます。そうでない一覧は、アプリが作ってある行だけです。空のセルは `""`（WinForms の `(null)` も）、文字のない行は除き、10000 行を超えると `maxRows` を書かない限り `TABLE_TOO_LARGE` で止まります
- **長い一覧をページごとに読む**：`desktop.scroll` に `direction: "down"` を付けると `atEnd` が返るので、`control.while` で「読む→スクロール」を最後まで繰り返せます
- **マウス・キーボードは 1 組だけ**：「使う」のノードは画面の使用権（`desktop.input`）を自動で取ってから動くので、並行ブランチの中でも同時には動きません。同じアプリ（`process` が同じ）へのノードも 1 つずつ動きます。フローにロックは書きません

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

- `test_step`：1 ノードだけその場で実行し、出力と操作後のウィンドウの一覧を返します。画面を順にたどってからフローを書けます
- パスワード欄の中身は一覧にも `desktop.getValue` にも出しません

## ログイン（シークレット）

パスワードは Studio の「🔑 シークレット」に登録し、フローには名前だけを書きます（[secrets.md](secrets.md)）。デスクトップアプリに入力するときは、シークレットの「入力してよいサイト・アプリ」に **`app:<実行ファイル名>`**（例 `app:billing.exe`）を登録します。登録のないアプリには入力しません。

```json
{ "type": "desktop.setValue",
  "params": { "target": { "window": { "process": "billing.exe" }, "element": { "id": "txtPassword" } },
              "value": { "secret": "請求システム", "field": "password" } } }
```

## 部品が見えない画面：画像と文字（OCR）

Citrix やリモートデスクトップの中、独自に描画する画面では `inspect_ui` に部品が出ません。そのときは画面の絵の上で場所を探します。

```json
{ "window": { "title": "Citrix" }, "ocr": { "text": "検索" } }
{ "window": { "title": "Citrix" }, "image": { "path": "C:\\RPA\\images\\保存ボタン.png" } }
{ "window": { "title": "Citrix" }, "ocr": { "text": "顧客コード" }, "offset": { "x": 150, "y": 0 } }
```

- `ocr`：画面に出ている文字を OCR で探します。空白・大文字小文字・全角半角は無視します。`exact: true` で行全体が一致するものだけ
- `image`：PNG の画像を画面から探します（正規化相互相関なので明るさの変化には強い）。`threshold`（0.5〜1、既定 0.9）で似ている度合いの下限を決めます。画像は同じアプリの画面から `desktop.screenshot` と `region` で切り出します。**画面の拡大率（DPI）やテーマが違うと見つかりません**
- `offset`：見つけた場所の中心からずらします（ラベルの右の入力欄など）
- `region`：探す範囲をウィンドウの一部（ウィンドウ左上からの px）に絞ります。`element` が見えるならそれでも絞れます
- 複数見つかったときは選ばずに `IMAGE_AMBIGUOUS` / `TEXT_AMBIGUOUS`（候補の位置つき）にします。`nth`（上から、同じ行は左から数えて 0 始まり）か `region` で決めます
- 使えるノード：`desktop.mouseClick`・`desktop.mouseScroll`・`desktop.drag`（両端とも）・`desktop.hover`・`desktop.type`（その場所をクリックしてから入力）・`desktop.waitFor`・`desktop.isVisible`。どれも見つかるまで自動で待ちます
- 画面の絵はウィンドウ自身に描かせるので、ほかのウィンドウに隠れていても読めます。描けないアプリだけ前面に出して画面から写します

### OCR エンジン

- 既定は **PaddleOCR**（PP-OCRv6 small を ONNX Runtime で実行）です。オフラインで動き、日本語・中国語・英語を 1 つのモデルで読みます。12px 程度の小さい画面の文字も読めます。モデルと ONNX Runtime はインストーラに同梱しています（`ocr\`、約 60 MB。モデルは Apache-2.0、ONNX Runtime は MIT）
- PaddleOCR はラテン文字とそっくりな別の文字（トルコ語の `ı`、ギリシャ文字・キリル文字の大文字など）を選ばないので、「AI」が「Aı」になりません
- 縦書き（幅の 1.5 倍以上縦に長い行）は 90 度回して上から読みます
- PaddleOCR が入っていないときは **Windows OCR**（Windows.Media.Ocr）を使います。小さい文字と日本語は苦手なので、2 倍に拡大してから読ませます。`engine: "windows"` で明示もでき、`language`（`ja`・`en-US` など）はこちら用です
- `accurate: true`（Studio では「高精度」）にすると PaddleOCR の大きいモデル（PP-OCRv6 medium、`ocr\medium\`）で読みます。手書きにかなり強くなる代わりに数倍〜10 倍遅くなります（1000×560 の画像で 0.4 秒 → 約 5 秒）。`desktop.readText` と `ocr` ターゲットで使えます。インストーラに同梱し、開発中は `pnpm studio:bundle-ocr` が ModelScope から取れれば取ります（`SHIKIGAMI_OCR_ACCURATE=required` で取れなければエラー、`skip` で取らない）
- `desktop.readText` はどちらのエンジンで読んだかを `engine` で返し、既定が Windows OCR に落ちたときは `warning` を付けます
- PaddleOCR は日本語として読みます。日本語で使わない漢字（簡体字の「纳」、繁体字の「錄」など Shift_JIS で書けない字）は選ばず、次の候補の同じ形の日本の字（「納」「録」）にします。形の似たかなと漢字は前後の文字で選びます：カタカナの後の「ー」（「コピ一用紙」→「コピー用紙」、ただし「データ一覧」はそのまま）、漢字の間の「力」（「入カ」→「入力」）、カタカナの間の「タ」（「デー夕」→「データ」）。画像は 1.5 倍に拡大して読みます（小さい文字が見つかりやすく、読み違いも減ります）
- `desktop.readText` の各行には、エンジンが確からしさを返すとき（PaddleOCR。Windows OCR は返しません）`confidence`（0〜1、行の中で一番自信のない語）と `unsure`（信頼度 0.8 未満の語の文字が `text` の何文字目か）が付きます。Studio のノードの実行結果では、行ごとの信頼度と読んだエンジンを表示し、信頼度の低い文字に色を付けます
- `table: true`（Studio では「表の読み取り」）で、画像の中の表を行と列に分けます。罫線（枠・表計算の目盛線）があればその間のマス（「小計」のような結合したマスは文字の下の列）、なければ全部の行を縦に通る隙間で分けます。出力に `cells`（行ごとの文字の並び）と `rows`（`headerRow`（既定 1）の行の名前で引ける、その後の各行。名前が空なら 列1・列2…、`headerRow: 0` で見出しなし）が付きます。例：`{{ invoice.rows[0].金額 }}`。ベンチマークの請求書・表計算（リモート画面風を含む）では 24 枚中 22 枚を正しく分けられました
- ほかのエンジン（拡張機能のクラウド AI-OCR など）は `OcrProvider` トレイト（`shikigami_desktop::backend::register_ocr_engine`）で足せます。フローでは `engine: "<名前>"` で選びます

### OCR の正解率（ベンチマーク）

`crates/shikigami-desktop/src/ocr_bench.rs` が、日本語の業務画面の画像（`tests/fixtures/ocr-bench`、`tests/ocr-bench/make.mjs` で作成）で OCR を測ります。表計算・ブラウザのフォーム・帳票・複数行のダイアログを、9・10.5・12・14pt、ライト/ダーク、そのまま・ClearType の色にじみ・リモートデスクトップ（JPEG）で用意しています。「文字」は 1 − 編集距離 ÷ 文字数、「項目」は項目まるごと正しく読めた割合です（全角半角は同じとみなします）。

| PaddleOCR small | 文字 | 項目 |
| --- | --- | --- |
| 改善前（v0.1.9） | 99.1 % | 94.7 % |
| 改善後 | 99.6 % | 98.0 % |

画像は Linux の Chromium と Noto Sans JP・IPA フォントで描いたもので、Windows の描画ではないため、実機の画面ではもう少し下がる可能性があります。`cargo test -p shikigami-desktop --lib ocr_bench -- --ignored --nocapture` で表と読み違いの一覧を出します。9pt の分は毎回のテストで走り、99 %・95 % を下回ると失敗します。Windows の CI では同じベンチマークを Windows OCR でも測ります（main と、タイトルに OCR を含む Pull Request での実験。結果は実行の通知に出ます）。
- 開発中のチェックアウトでは、`pnpm studio:dev` が `target\ocr` がない（または古い）ときに取ってきます（`pnpm studio:bundle-ocr` でも可）。開発版の Studio・MCP サーバー・テストが使います

### AI が画面を見るには（MCP）

- `inspect_ui` に `ocr: true` を付けると、ウィンドウの文字を行ごとに位置（ウィンドウ左上からの px）つきで返します。そのまま `target.ocr` や `region` に使えます
- `image: true` を付けると、ウィンドウの絵が AI に画像として返ります（アイコンや配置を見て、切り出す範囲を決めるため）
- ウィンドウの絵は観察として残り、レビューする人が見られます

## アプリの種類と見え方

| アプリ | いまの見え方 | 予定 |
|---|---|---|
| Win32 / WinForms / WPF / UWP、Office の画面 | UI Automation で部品が見える | – |
| SAP GUI for Windows | SAP GUI Scripting が有効なら、それを通して見える（下の「SAP GUI」）。無効なら UI Automation で一部だけ（`inspect_ui` に注記） | – |
| Java（Swing・AWT など） | Java Access Bridge が有効なら、それを通して見える（下の「Java アプリ」）。無効なら枠だけ（注記） | – |
| Citrix / リモートデスクトップの中 | 部品は見えない。画像（`image`）と文字（`ocr`）で場所を指す | – |
| Excel のデータ | – | xlsx を直接読み書きする `excel.*`（[adapters.md](adapters.md)） |

## SAP GUI

対象のウィンドウが SAP GUI for Windows で、SAP GUI Scripting が有効なら、同じ `desktop.*` のノードが UI Automation の代わりにスクリプトの仕組みを通して動きます（UI Automation では SAP の項目や表の多くが見えないため）。

- **スクリプトを有効にする**（SAP の管理者が一度、各 PC でも一度）：SAP サーバーでトランザクション RZ11 から `sapgui/user_scripting` を `TRUE` に。SAP GUI の［オプション］>［アクセシビリティとスクリプト］>［スクリプト］で「スクリプトを有効にする」をオンにし、「スクリプトが接続したときに通知」などの 2 つはオフに（オンのままだと操作のたびに確認が出ます）
- `inspect_ui` は SAP の部品を id（`wnd[0]/usr/txtRSYST-BNAME`）とほかのアプリと同じ役割（`textbox`・`button`・`checkbox`・`combobox`・`tab`・`table`、ALV グリッドは `grid` など）で一覧にします。`element.id` にそのまま写します。SAP GUI で記録したスクリプトの id（`/app/con[0]/ses[0]/wnd[0]/…`）や、対象ウィンドウの中の id（`usr/…`）でも動きます
- 各ノードの動き：`desktop.click` はボタンを押す・チェックの切り替え・ラジオボタン・タブ・メニューの選択（ラベルや入力欄では F2 ＝ダブルクリックと同じ）。`desktop.setValue` / `desktop.getValue` は入力欄の書き込みと読み取り。`desktop.select` はコンボボックスの項目を表示名かキーで選ぶ。`desktop.press` は SAP のファンクションキー（Enter、Shift / Ctrl 付きの F1〜F12、Ctrl+S、Esc、PageUp / PageDown）を実際のキーボードを使わずに送る。`desktop.selectMenu` はメニューバーをたどる。`desktop.getTable` はテーブルコントロールと ALV グリッドをスクロールしながら全部読む。`desktop.type`・`desktop.mouseClick` などマウスのノードは、その部品にフォーカスを移すか、画面上の位置を使う
- `sap.runTransaction` はトランザクションを開始し（`code`：`VA03`）、そのあとのステータスバー `{ type, text }`（`S` 成功、`W` 警告、`E` エラーなど）を返すので、`control.if` で確かめられます
- スクリプトが無効なときに SAP の部品 id を書いた対象は `SAP_SCRIPTING_OFF`（有効にする手順つき）で止まります。ウィンドウそのもの・OCR・画像は UI Automation で動きます
- **実際の SAP ではまだ確認していません**：SAP のスクリプト API の資料をもとに書いています。CI には SAP GUI がありません

## Java アプリ

Java のアプリ（Swing・AWT と、それで作られた多くの社内システム）は、UI Automation には枠しか見えません。Java Access Bridge が有効なら、同じ `desktop.*` のノードがその仕組みを通して動きます。

- **Java Access Bridge を有効にする**（PC・ユーザーごとに一度）：アプリが使う Java の `bin` フォルダーで `jabswitch -enable` を実行し、アプリを起動し直します。Shikigami は `WindowsAccessBridge-64.dll` を Windows、アプリの `java.exe` のフォルダー、`JAVA_HOME\bin` の順に探します
- `inspect_ui` は Java の部品をほかのアプリと同じ役割（`textbox`・`button`・`checkbox`・`combobox`・`table`・`menuitem` など）で一覧にします。Java の部品には id がないので、`role` ＋ `name`（同じ名前が並ぶときは `nth`）で指定します
- 各ノードの動き：`desktop.click` は部品の動作（押す・切り替え・選ぶ）を実行。`desktop.setValue` / `desktop.getValue` は入力欄の書き込みと読み取り（パスワード欄は書き込みだけ）。`desktop.select` は一覧やコンボボックスの項目を選ぶ。`desktop.selectMenu` はメニューバーをたどる。`desktop.getTable` は `JTable` を列見出しつきで全部読む。`desktop.type`・`desktop.press`・マウスのノードは、その部品にフォーカスを移すか、画面上の位置を使う
- 無効なときに部品を指定した対象は `JAVA_BRIDGE_OFF`（有効にする手順つき）で止まります。ウィンドウそのもの・OCR・画像は UI Automation で動きます
- CI では小さな Swing の画面で確認しています。実際の業務用 Java アプリ（Oracle Forms、Java Web Start など）ではまだ確認していません

## しくみ

- UI Automation は **ウィンドウを持たない専用スレッド** で、マルチスレッドアパートメント（MTA）に参加して呼びます（Microsoft の推奨。Studio 自身の画面が対象でも固まらない）。ノードはこのスレッドに要求を送るだけで、部品への参照はスレッドの外に出しません。毎回 `target` から探し直します
- 接続 2 秒・処理 10 秒の UI Automation のタイムアウトを設定し、応答しないアプリで止まり続けないようにします（`APP_NOT_RESPONDING`）。クリックなどの操作中のタイムアウトは「操作が済んだかもしれない」ので、二重に押さないよう再試行しません
- 昔ながらの Win32 のボタンはクリックを投げるだけにして、押した先でダイアログが開いても待たされないようにしています
- 管理者として動いているアプリは、通常の権限の Shikigami から操作できません（Windows の制限）。`ELEVATION_REQUIRED` で知らせます
- 実行キューで待っている間にノードが時間切れ・停止になった要求は、実行せずに捨てます（停止後や再試行で二重にクリック・入力しないため）
- マウス・キーボードを使う前にウィンドウを前面に出します。画面ロック中・サインイン画面や昇格の確認が入力を持っているとき・リモートセッションが切断または最小化されているときは、そうしたノードは始める前に `DESKTOP_UNAVAILABLE` で止めます（マウス・キーボードを使わないノードは動きます）。それ以外で Windows が許さなかったときは `FOREGROUND_DENIED` / `INPUT_BLOCKED` で止めます。マウス・キーボードは Studio・CLI・MCP サーバーをまたいで一度に一つのノードだけが使います
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
| `IMAGE_NOT_FOUND` / `TEXT_NOT_FOUND` | 画面に見つからない（時間切れまで待ったあと）。画像は惜しかったときの `bestScore`、文字は OCR が読んだ内容 `textRead` つき |
| `IMAGE_AMBIGUOUS` / `TEXT_AMBIGUOUS` | 複数見つかった（候補の位置つき）。`nth` か `region` で決める |
| `IMAGE_FILE_NOT_FOUND` / `IMAGE_FLAT` | 画像ファイルがない／一色だけの画像（どこにでも当たる） |
| `OCR_ENGINE_MISSING` / `OCR_LANGUAGE_MISSING` | `engine: "paddle"` なのに PaddleOCR が入っていない／Windows OCR にその言語がない |
| `SAP_SCRIPTING_OFF` | SAP の部品 id を書いたが、SAP GUI Scripting がそのウィンドウに届かない。有効にする（「SAP GUI」） |
| `JAVA_BRIDGE_OFF` | Java のウィンドウだが、Java Access Bridge が無効か見つからない。有効にする（「Java アプリ」） |
| `JAVA_NOT_READY` | Java アプリがまだ起動中。ノードの待ち時間のあいだ再試行する |
| `NOT_SAP_WINDOW` | SAP GUI でないウィンドウに `sap.runTransaction` |
| `TABLE_TOO_LARGE` | 10000 行を超えた。`maxRows` を書くか、アプリで絞り込んでから読む |
| `MENU_ITEM_NOT_FOUND` / `MENU_ITEM_AMBIGUOUS` | その名前のメニュー項目が出ていない（出ている項目つき）／複数ある。上のメニューから順に書く |
| `PLATFORM_UNSUPPORTED` | Windows 以外で実行した |

## 確認済みの事項と制約

- **確認済み**：ノード定義・検証・自動待ち・ロック・シークレットの照合を、偽のバックエンドで自動テスト（Linux / Windows の CI）。Windows の CI で PowerShell が出す WinForms の画面を使い、メニューバーからの選択、文字の入力と読み取り、最後までのスクロール、DataGridView と一覧の `desktop.getTable` を UI Automation で行うテスト（メモ帳のテストは、CI のランナーのように古い Edit のないメモ帳では飛ばされます）。画像検索と、日本語の業務画面の絵（12px の文字）を PaddleOCR で読むテスト（Linux / Windows の CI）。Windows の CI でメモ帳の絵を撮って OCR し、切り出した画像をもう一度見つけるテスト
- **未確認**：実際の業務アプリ・SAP GUI・業務用 Java アプリ・Citrix での動作、マウス・キーボード操作（CI では画面操作をテストしていない）、高 DPI・複数モニター
- 画像検索はフル HD のウィンドウで 1 回 0.2〜0.5 秒、PaddleOCR は小さい画面で 0.3 秒ほど（CPU 4 コア）です。大きなウィンドウ全体の OCR は 1 秒を超えることがあるので、`region` で絞ると速くなります
- Studio・CLI・MCP サーバーなど **別プロセス間** のマウス・キーボードの排他は未実装です（同じプロセス内のみ）
- 回転・拡大縮小した画像は探せません

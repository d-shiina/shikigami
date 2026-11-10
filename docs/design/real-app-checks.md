# 実機での確認手順（デスクトップ操作・SAP・Java）

目的：CI では確かめられない操作を、実際の PC と業務アプリで確かめ、結果をここに残す（[competitive-gaps.md](competitive-gaps.md) の G1）。結果が出たら [desktop.md](../desktop.md)「Verified and limits」に「動作確認済み」として写す。

CI で確かめているもの（ここではやらなくてよい）：WinForms の画面でのメニュー・スクロール・`desktop.getTable`（`tests/uia_smoke.rs`）、小さな Swing の画面での Java Access Bridge（`tests/java_smoke.rs`）。

## やり方

どれも Studio の AI に頼むのがいちばん早い。例：「メモ帳を開いて、ヘルプ > バージョン情報を desktop.selectMenu で開いて閉じるフローを作って、試しに動かして」。AI は `inspect_ui` で画面を見てから組む。

1. `git pull` のあと `cargo build -p spellsheet-cli`（MCP の `target\debug\spellsheet.exe` を新しくする）、`pnpm studio:dev` で Studio を起動
2. 下の表の上から順に、AI に頼むか手でノードを置いて動かす
3. 結果の列に「OK」「NG（エラーコードと一言）」を書く。NG はエラーの詳細（Studio の実行ログ）をスレッドに貼ってもらえれば直す

## 1. デスクトップ操作（マウス・キーボードを使うもの）

| # | 何を | 手順 | 期待 | 結果 |
|---|---|---|---|---|
| 1-1 | 右クリックメニュー（Win32） | エクスプローラーでファイルを 1 つ選び、`desktop.selectMenu`（`target.element` にそのファイル、`path: ["プロパティ"]`） | プロパティのダイアログが開く | |
| 1-2 | 右クリックメニュー（WPF / WinForms の業務アプリ） | 普段使う業務アプリの一覧で行を指定して `desktop.selectMenu` | 指定した項目が実行される | |
| 1-3 | メニューバー（Win32） | ペイントや古い業務アプリで `desktop.selectMenu`（`path: ["ファイル", "名前を付けて保存"]` など） | 項目が開く | |
| 1-4 | ドラッグ | エクスプローラーでファイルをフォルダーへ `desktop.drag`（`target` にファイル、`to` にフォルダー） | 移動される | |
| 1-5 | マウスを重ねる | ツールチップの出るボタンに `desktop.hover`、続けて `desktop.screenshot` | 画像にツールチップが写る | |
| 1-6 | ホイール | ブラウザ以外の長い一覧で `desktop.mouseScroll`（`direction: "down"`, `amount: 5`） | 一覧が動く | |
| 1-7 | スクロール（マウスなし） | 長い一覧で `desktop.scroll`（`direction: "bottom"`）→ 戻り値の `atEnd` | `true` | |
| 1-8 | 表を読む | 販売管理・会計ソフトなどの一覧画面で `desktop.getTable` | 見出しをキーにした行の配列 | |
| 1-9 | 高 DPI | 表示スケール 150% で 1-4・1-5 | 位置がずれない | |
| 1-10 | 複数モニター | 2 枚目のモニターに置いた画面で 1-4・1-5 | 位置がずれない | |

## 2. SAP GUI

SAP GUI Scripting を通した操作は SAP のプラグイン（有料、別に提供）に移しました。確認の手順はプラグインの側にあります。本体だけのときは、SAP GUI のウィンドウで `inspect_ui` に「UI Automation で見ている。SAP のプラグインがあれば中まで見える」という注記が出ること、`target.ocr` で文字を指して操作できることを確かめます。

## 3. Java アプリ

前提：アプリが使う Java の `bin` で `jabswitch -enable`、アプリを起動し直す（[desktop.md](../desktop.md)「Java アプリ」）。

| # | 何を | 手順 | 期待 | 結果 |
|---|---|---|---|---|
| 3-1 | 見える | Java 製の社内システム（なければ JDK 付属のデモや SwingSet）で `inspect_ui` | 部品が役割と名前で並ぶ | |
| 3-2 | 入力と読み取り | `desktop.setValue` → `desktop.getValue` | 同じ値 | |
| 3-3 | ボタン・チェック | `desktop.click` | 押せる・切り替わる | |
| 3-4 | 一覧・コンボボックス | `desktop.select` | 選べる | |
| 3-5 | メニューバー | `desktop.selectMenu` | 項目が実行される | |
| 3-6 | 表 | `JTable` のある画面で `desktop.getTable` | 見出しつきで全行 | |
| 3-7 | ブリッジ無効 | `jabswitch -disable` で 3-2 | `JAVA_BRIDGE_OFF`（手順つき） | |
| 3-8 | 32 ビット Java | 32 ビットの Java で動くアプリがあれば 3-1 | 見えるか（見えなければ記録だけ。対応は別に決める） | |

## 4. Citrix・リモートデスクトップ

部品は見えないので OCR と画像だけ（[desktop.md](../desktop.md)「Screens without elements」）。

| # | 何を | 手順 | 期待 | 結果 |
|---|---|---|---|---|
| 4-1 | 文字で押す | `desktop.mouseClick`（`target.ocr.text` にボタンの文字） | 押せる | |
| 4-2 | 画像で押す | `desktop.screenshot` で切り出した PNG を `target.image.path` に | 押せる | |
| 4-3 | 読む | `desktop.readText` | 画面の文字が読める | |

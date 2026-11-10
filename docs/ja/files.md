# ファイル・フォルダーの操作（`file.*`）

[English](../files.md) | 日本語

クレート `spellsheet-files`。何もインストールせずに動き、Windows 以外でもテストできます。値の加工（パスの組み立て、行の絞り込みなど）はノードではなく式の関数で書きます（[expressions.md](expressions.md)）。

| ノード | 内容 | 出力 |
|---|---|---|
| `file.readText` | テキストファイルを丸ごと読む | 文字列 |
| `file.writeText` | 書く（`append: true` で末尾に追加）。フォルダーがなければ作る | パス |
| `file.readCsv` | CSV / TSV を読む。1 行目を見出しにしたレコードの配列（セルはすべて文字列） | レコードの配列 |
| `file.writeCsv` | レコード（またはセルの配列）を書く。見出し付き、改行は CRLF | 書いた行数 |
| `file.exists` | ファイルかフォルダーがあるか | true / false |
| `file.list` | フォルダーの中を一覧（`pattern` は `*.csv` など、大文字小文字は区別しない） | `{ path, name, isFolder, size, modified }` の配列 |
| `file.copy` / `file.move` | コピー / 移動・名前の変更。`to` は新しいパスそのもの（フォルダーではない） | 新しいパス |
| `file.delete` | 削除（ごみ箱には入らない）。中身のあるフォルダーは `recursive: true` | 削除したか |
| `file.createFolder` | フォルダーを作る（途中のフォルダーも。既にあってもよい） | パス |
| `file.zip` / `file.unzip` | zip に圧縮 / 展開 | zip のパス / 展開したファイルの配列 |
| `config.read` | 設定ファイル（下記）を読み、`{ 名前: 値 }` で返す。普通の JSON のオブジェクトはそのまま返す | レコード |

## フローのフォルダー

フローは保存先の中の 1 つのフォルダーで、関係するファイルを隣に置きます。

```text
flows/<フロー名>/
  flow.json   フロー
  input/          フローが読むファイル（Excel、CSV など）
  config/         フローを変えずに人が書き換える設定ファイル
  templates/      出力のひな形（Excel、Word）
  output/         実行で作るもの
  work/           作業用。実行のはじめに毎回空にする
  logs/           実行ごとの読めるログ：20261029-140512_failed.log（新しい 100 件、既定では 90 日まで残す：`records.keepDays`）
```

- ノードのファイルの項目に書いた相対パス（`input/受注一覧.xlsx`）は、フローのフォルダーから解決します。保存先を移しても共有しても動きます。サブフローは自分のフォルダーから解決します。フォルダーの外（`..`）を指すと `PATH_OUTSIDE_PROJECT` の警告。絶対パスは従来どおり使えます。
- `work/` は実行のはじめに空にします。残したいときはフローの `settings.keepWork: true`。1 ノードだけ試す（`test_step`）ときは空にせず、ログも書きません。
- バンドル（`export_flow`）と複製はファイルも持っていきます（`output/`・`work/`・`logs/` を除く）。人に渡す `.spx` では、`input/` は業務の実データが多いので最初は外してあります（「渡す」でチェックを入れるか、CLI の `--with-input`）。
- バンドルのファイルを `spellsheet run 受注.spellsheet.json` で直接実行すると、ファイルを隣の `受注.files/<id>/` に展開してそこで実行します。実行後も `output/` と `logs/` が残ります。
- フォルダー名はフロー名です（Windows で使えない `\ / : * ? " < > |` は全角に、60 文字で切ります）。フロー名を変えるとフォルダー名も変わります。中のファイルを開いていて変えられないときは、次に保存先を開いたときに変えます。フローの ID は `flow.json` の中にあり、呼び出し・スケジュール・実行記録は ID で指すので、名前を変えても壊れません。
- 同じ名前のフローは作れません（大文字小文字は区別しません）。新しく作る・複製する・取り込むフローの名前が使われていれば「 (2)」を付け、名前の変更で使われている名前を選ぶと `DUPLICATE_FLOW_NAME` で断ります。
- 0.1.20 までの `flows/<id>/` と、それより前の `flows/<id>.json` は、保存先を開いたときにフロー名のフォルダーへ移します。同じ名前のフローがすでに 2 つあれば、後のほうのフォルダーを「名前 (2)」にします。
- ファイルは Writer、AI（`write_project_file`）、`spellsheet flow add-file <id> <ファイル> --to input` で追加できます。

### 設定ファイル

`config/` の設定ファイルは、名前付きの値を種類と説明つきで並べます。Writer はこれをフォームで見せます。

```json
{
  "format": "spellsheet.config",
  "items": [
    { "name": "承認しきい値", "type": "number", "value": 10000, "description": "この金額以上は承認待ち" },
    { "name": "送信先", "type": "text", "value": "keiri@example.co.jp" }
  ]
}
```

種類は `text`・`number`・`boolean`・`date`・`list`・`folder`。`config.read` に `{ "path": "config/settings.json" }` を渡して `settings` に入れると `settings.承認しきい値` で使えます。形式が違うと `CONFIG_INVALID`。

`folder` はフォルダーのフルパスです。`%USERPROFILE%` などの `%名前%` は、読むときにその PC の環境変数に置き換えます。Box Drive・OneDrive・Dropbox のフォルダーは人ごとにユーザー フォルダーの下にあるので、`%USERPROFILE%\Box\経理` と書けば誰の PC でも同じ設定で動きます。

### ファイルサーバーやクラウドストレージのファイルを読む・書く

ファイルの項目にはフルパスも書けます。ファイルサーバー（`\\fs01\経理\受注.xlsx`）も、Box Drive・OneDrive・Google ドライブ・Dropbox などクラウドストレージの同期フォルダーもそのまま読み書きできます。無人実行（Worker）はサインインしたユーザーとして動くので、その人が開ける場所なら開けます。Box Drive は、その PC で Box Drive にサインインしておいてください。

場所はノードに直接書かず、設定ファイルの `folder` にしておくのがおすすめです。フローを人に渡したとき、受け取った人は設定を 1 つ書き換えるだけで済みます。

```json
{ "name": "受注の場所", "type": "folder", "value": "\\\\fs01\\経理\\受注" }
```

ノードでは `{{ settings.受注の場所 }}/受注.xlsx` と書きます。

Writer では次のようにできます。

- フローが `input/` の入力ファイルがまだ無いと、ファイル一覧の「入力」の欄に「入力ファイルがまだありません」が出ます。「フォルダーに置く」（ファイルを選んでその名前でコピー）、「ファイルサーバーから読む」（フォルダーを選ぶと、設定ファイルに `folder` を足し、そのファイルを読むノードを `{{ settings.<名前> }}/…` に変えます）、「クラウドストレージから読む」（下）から選びます。ユーザー フォルダーの下のフォルダーは `%USERPROFILE%\…` で残します
- ファイル一覧の output フォルダーの欄の「書き出す場所を変える」で、`output/` に書いているノードをまとめて、選んだファイルサーバーのフォルダーに書くように変えます。クラウドストレージを選ぶと、実行が終わるたびに送ります（下）
- ノードの設定の「参照…」でフローのフォルダーの外のファイルを選ぶと、「元の場所から読む」か「コピーする」かを聞きます
- `.spx` で渡すと、フルパスと設定ファイルのフォルダーが「相手の PC に必要なもの」に出ます。受け取る PC では、その場所が開けるかを確かめて見せます
- AI の `list_project_files` は、まだ無い入力ファイルを `needed` で、クラウドストレージの設定を `cloud` で返します（入力を取得する設定があれば `needed` は空です）

### クラウドストレージ（API）

同期アプリ（Box Drive など）が入っていない PC や無人実行では、フローのフォルダーがストレージの API でつながります。Box・Google ドライブ・OneDrive・SharePoint に対応しています。ノードではなくフォルダーの設定です。ノードは `input/受注.xlsx` を読み、`output/請求書.pdf` に書くままなので、同じフローはファイルを手で置いても動きます。

- **入力**：フロー全体の実行を始めるたびに、最初のノードの前で、クラウドストレージのフォルダーの直下にあるファイルを `input/` に取得します（同じ名前は置き換えます）。
- **出力**：実行がエラーなく終わるたびに、その回に `output/` の直下に書いたファイル（実行中に増えたもの・変わったもの）をクラウドストレージのフォルダーに送ります（同じ名前は置き換えます）。`output/` にも残ります。

ファイル一覧の「クラウドストレージから読む」（足りない入力ファイルのところ）と「書き出す場所を変える → クラウドストレージに書き出す」で、次を入れます。

| 項目 | 内容 |
|---|---|
| サービス | Box・Google ドライブ・OneDrive・SharePoint |
| サインインに使うシークレット | 種類が OAuth アプリのシークレット。新しく登録するときは、サービスの開発者コンソールで作ったアプリのクライアント ID とクライアント シークレット。使ってよい先に API のサイトと `plugin:<名前>` を足します |
| リダイレクト URL | アプリに登録したもの（[oauth.md](oauth.md)） |
| フォルダー | ストレージの一番上からのパス（`経理/受注`）か、フォルダーのアドレス（Box・Google ドライブ）やリンク（OneDrive・SharePoint） |
| 名前の絞り込み（入力だけ） | `*.xlsx` など。空欄の場合はフォルダーのファイルをすべて（中のフォルダーは取得しません） |

設定は `config/cloud.json` に入ります。

```jsonc
{
  "format": "spellsheet.cloud",
  "input": {
    "service": "box", "label": "Box", "secret": "Box",
    "signIn": { "authorizeUrl": "…", "tokenUrl": "…", "redirectUrl": "…" },
    "folder": "経理/受注", "pattern": "*.xlsx"
  },
  "output": { "service": "onedrive", "label": "OneDrive・SharePoint", "secret": "Microsoft", "signIn": { … }, "folder": "経理/出力" }
}
```

入力と出力で別のサービスや別のアカウント（シークレット）も使えます。実行はまず `oauth.signIn` でサインインします。最初の実行でサインイン画面が開き、2 回目からはサインインしたまま続きます（[oauth.md](oauth.md)）。実行のログには何をやり取りしたかが出ます（「Box の 経理/受注 から input/ に 2 ファイルを取得しました（受注.xlsx、単価.xlsx）」）。やり取りに失敗すると、その実行は失敗になり、どのやり取りかがエラーに出ます。「ここから実行」では `input/` をそのまま使います。トークンは設定に入らないので、フローはそのまま人に渡せます。受け取った人は自分のアカウントでサインインし、必要ならフォルダーを変えます。

やり取りはサービスのプラグイン（`box`・`googledrive`・`onedrive`）の `<名前>.downloadFolder` と `<名前>.upload` が行います。これらのプラグインは Writer に入っておらず、別に提供します。受け取ったものをサイドバーの「プラグイン」で追加し、Writer を再起動します。プラグインのノード（`googledrive.list`・`googledrive.download`・`googledrive.downloadFolder`・`googledrive.upload` など）はフローの中でも使えます。

`work/` はフローのフォルダーのまま使ってください。実行のたびに空にする作業用なので、同期フォルダーに置くと同期が追いつかずにロックがかかったり、途中のファイルが他の人に見えたりします。

## 文字コード

- 読むとき（`encoding`、既定 `auto`）：BOM → UTF-8 → Shift_JIS の順に判定する。`utf-8` / `shift_jis` を指定すると、合わないとき `ENCODING_MISMATCH`。
- 書くとき（既定 `utf-8`）：Excel で開く CSV は `utf-8-bom` か `shift_jis`。Shift_JIS で表せない文字（絵文字など）があると `UNENCODABLE_TEXT`（どの文字かを `details.characters` に入れる）。追記では BOM を付け直さない。
- Windows のエクスプローラーで作った zip の日本語ファイル名（Shift_JIS）も正しく展開する。

## 振る舞い

- 上書きは既定で禁止（`FILE_EXISTS`）。`overwrite: true` で置き換える。`file.unzip` は 1 つでも上書きになるなら何も展開せずに止まる。
- 書き込みは一時ファイルに書いてから置き換えるので、途中の状態のファイルは残らない（追記を除く）。止められた・時間切れになった試行はファイルを変えない。
- `path` / `from` / `to` がロックになる。同じファイルへの操作は順番に、別のファイルは並行に動く。
- `writeCsv` の追記は既存ファイルの見出しの順に列を合わせ、見出しは書き直さない。
- 展開先の外に出る zip の項目（`../`）は `ZIP_INVALID` で拒否する。
- エラーコード：`FILE_NOT_FOUND`、`FILE_EXISTS`、`FILE_ACCESS_DENIED`、`FILE_IN_USE`（Excel などで開いている。再試行で直ることがある）、`FOLDER_NOT_EMPTY`、`NOT_A_FOLDER`、`CSV_INVALID`、`ZIP_INVALID`。

## 例

ダウンロードを待って、CSV の 1 万円以上の行だけを税込にして書き出す：

```json
[
  { "type": "wait.until", "params": { "condition": "len(files) > 0" },
    "blocks": { "check": [ { "type": "file.list", "params": { "folder": "C:\\work\\dl", "pattern": "*.csv" }, "saveAs": "files" } ] } },
  { "type": "file.readCsv", "params": { "path": "{{ files[0].path }}" }, "saveAs": "orders" },
  { "type": "variable.set", "params": { "name": "big",
      "expression": "map(filter(orders, r => num(r.金額) >= 10000), r => { 番号: r.注文番号, 税込: round(num(r.金額) * 1.1) })" } },
  { "type": "file.writeCsv", "params": { "path": "C:\\work\\out\\{{ formatDate(today(), 'yyyyMMdd') }}.csv", "rows": "{{ big }}", "encoding": "utf-8-bom" } },
  { "type": "file.move", "params": { "from": "{{ files[0].path }}", "to": "{{ pathJoin('C:\\\\work\\\\done', files[0].name) }}", "overwrite": true } }
]
```

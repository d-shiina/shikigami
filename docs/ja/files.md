# ファイル・フォルダーの操作（`file.*`）

[English](../files.md) | 日本語

クレート `shikigami-files`。何もインストールせずに動き、Windows 以外でもテストできます。値の加工（パスの組み立て、行の絞り込みなど）はノードではなく式の関数で書きます（[expressions.md](expressions.md)）。

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

## シナリオのフォルダー

シナリオは保存先の中の 1 つのフォルダーで、関係するファイルを隣に置きます。

```text
scenarios/<id>/
  scenario.json   シナリオ
  input/          シナリオが読むファイル（Excel、CSV など）
  config/         フローを変えずに人が書き換える設定ファイル
  templates/      出力のひな形（Excel、Word）
  output/         実行で作るもの
  work/           作業用。実行のはじめに毎回空にする
  logs/           実行ごとの読めるログ：20261029-140512_failed.log（新しい 100 件を残す）
```

- ノードのファイルの項目に書いた相対パス（`input/受注一覧.xlsx`）は、シナリオのフォルダーから解決します。保存先を移しても共有しても動きます。サブシナリオは自分のフォルダーから解決します。フォルダーの外（`..`）を指すと `PATH_OUTSIDE_PROJECT` の警告。絶対パスは従来どおり使えます。
- `work/` は実行のはじめに空にします。残したいときはシナリオの `settings.keepWork: true`。1 ノードだけ試す（`test_step`）ときは空にせず、ログも書きません。
- バンドル（`export_scenario`）と複製はファイルも持っていきます（`output/`・`work/`・`logs/` を除く）。
- バンドルのファイルを `shikigami run 受注.shikigami.json` で直接実行すると、ファイルを隣の `受注.files/<id>/` に展開してそこで実行します。実行後も `output/` と `logs/` が残ります。
- 従来の `scenarios/<id>.json` は、保存先を開いたときにフォルダーへ移します。
- ファイルは Studio、AI（`write_project_file`）、`shikigami scenario add-file <id> <ファイル> --to input` で追加できます。

### 設定ファイル

`config/` の設定ファイルは、名前付きの値を種類と説明つきで並べます。Studio はこれをフォームで見せます。

```json
{
  "format": "shikigami.config",
  "items": [
    { "name": "承認しきい値", "type": "number", "value": 10000, "description": "この金額以上は承認待ち" },
    { "name": "送信先", "type": "text", "value": "keiri@example.co.jp" }
  ]
}
```

種類は `text`・`number`・`boolean`・`date`・`list`。`config.read` に `{ "path": "config/settings.json" }` を渡して `settings` に入れると `settings.承認しきい値` で使えます。形式が違うと `CONFIG_INVALID`。

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

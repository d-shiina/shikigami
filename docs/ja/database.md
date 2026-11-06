# データベース

[English](../database.md) | 日本語

クレート `shikigami-db`。SQL を ODBC 経由で実行する組込ノードです。同じ 2 つのノードで SQL Server・Oracle・Access・PostgreSQL・MySQL など、PC に ODBC ドライバーがあるデータベースを扱えます。ODBC のドライバーマネージャーは Windows に入っています。データベースごとのドライバーは通常どおり入れます（SQL Server なら「ODBC Driver 18 for SQL Server」）。

| ノード | 内容 | 出力 | リスク |
|---|---|---|---|
| `db.query` | SELECT を 1 つ実行する | 列名をキーにしたレコードの配列 | safe |
| `db.execute` | データを変える文を 1 つ実行する | `{ rowsAffected }` | dangerous |

## つなぎ方

- `connection` は ODBC の接続文字列です：`Driver={ODBC Driver 18 for SQL Server};Server=db01;Database=受注;TrustServerCertificate=yes`、`DSN=基幹システム`（「ODBC データ ソース (64 ビット)」で作ったもの）、`Driver={Microsoft Access Driver (*.mdb, *.accdb)};DBQ=C:\data\受注.accdb`。
- パスワードは書きません。`UID` / `PWD` を書くと `DB_LOGIN_IN_CONNECTION`。ログインは登録済みのシークレットで、`user: { "secret": "受注DB", "field": "username" }`、`password: { "secret": "受注DB", "field": "password" }`（`password` はシークレットだけ）。
- Web API と同じく、シークレットは許した先にだけ送ります。シークレットのサイトに `db:<サーバー>` が要ります。サーバーは接続文字列でサーバーを指すキー（`Server`・`Servername`・`Data Source`・`Host`・`DSN`・`DBQ`、SQLite は `Database` のファイル）で、例 `db:db01`、`db:db01\sqlexpress`。ないと `SECRET_SITE_NOT_SET` / `SECRET_SITE_MISMATCH` になり、AI は `request_secret` で登録を頼みます。
- ログインを送るときは、接続文字列でサーバーを指すのは 1 つだけ（2 つあると `DB_SERVER_AMBIGUOUS`）、ほかは `Driver`・`Database`・`Port`・`Encrypt` などよく知られた設定だけにします（それ以外は `DB_CONNECTION_KEY_NOT_ALLOWED` で、使えるキーの一覧が付きます）。ほかの設定でログインを別の先へ送らせないためです。ほかのドライバー設定は DSN に入れてください。
- Windows 認証（`Trusted_Connection=yes`、サインイン中の Windows ユーザー）ならシークレットは要りません。

## SQL と値

- 値は `params` に入れ、`sql` には値ごとに `?` を書きます（順番どおりに入る）。`{{ }}` で SQL を組み立てないでください。`O'Brien` のような名前で壊れ、外から来た値が SQL の意味を変えられてしまいます。
- `params` に入るのは文字・数値・`true` / `false`・`null`。日付は文字（`"2026-11-06"`）。
- `db.query` は SELECT（または `WITH … SELECT`）1 つだけ。データを変えるもの（INSERT・UPDATE・DELETE・`SELECT … INTO`・EXEC など）は `DB_NOT_A_QUERY` なので `db.execute` を使います。読むだけなので、AI は `test_step` で表の中身や列を確かめられます（`SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ?`）。
- 行はレコードになります：数値は数値（DECIMAL の `12800.00` は `12800`）、`BIT` は `true` / `false`、日付・日時は `"2026-11-06"` / `"2026-11-06T09:30:00"`、`NULL` は `null`。`maxRows`（既定・上限 100,000）を超えると `DB_TOO_MANY_ROWS`。SQL で絞ってください。
- `db.execute` は文を 1 つ実行し、成功したら確定（コミット）します。何行も書くなら `control.forEach` で回します。

```json
{ "type": "db.query", "params": {
  "connection": "Driver={ODBC Driver 18 for SQL Server};Server=db01;Database=受注;TrustServerCertificate=yes",
  "user": { "secret": "受注DB", "field": "username" },
  "password": { "secret": "受注DB", "field": "password" },
  "sql": "SELECT 受注番号, 顧客名, 金額 FROM 受注 WHERE 受注日 = ?",
  "params": ["{{ formatDate(today(), 'yyyy-MM-dd') }}"]
}, "saveAs": "orders" }
{ "type": "excel.appendRows", "params": { "path": "output/本日分.xlsx", "rows": "{{ orders }}" } }
```

## 停止とタイムアウト

`db.execute` は SQL をトランザクションの中で動かし、ステップがまだ必要なときだけ確定（コミット）します。途中で実行を止めたときやステップの時間切れのときは取り消す（ロールバック）ので、再試行が途中までの変更とぶつかることはありません。ドライバーにはステップのタイムアウトより少し早くあきらめるよう伝えます。

`db.query` もトランザクションの中で動かし、終わったら必ず取り消します。副作用のある関数を呼ぶ SELECT（PostgreSQL の `lo_unlink` など）でも、データベースは元のままです。取り消せないもの（シーケンス、MySQL の MyISAM の表など）もあるので、読むだけのフローには読み取りだけできるログインを使ってください。

## エラー

| コード | いつ |
|---|---|
| `DB_DRIVER_NOT_FOUND` | ドライバーか DSN がこの PC にない |
| `DB_CONNECT_FAILED` | サーバーにつながらない（再試行の対象） |
| `DB_LOGIN_FAILED` | ログインを断られた |
| `DB_TIMEOUT` | ステップのタイムアウトまでに返事がない（再試行の対象） |
| `DB_SQL_ERROR` | SQL を受け付けなかった（`details.sqlState` に SQLSTATE） |
| `DB_NOT_A_QUERY` | `db.query` に SELECT 1 つ以外を渡した |
| `DB_TOO_MANY_ROWS` | `maxRows` より行が多い |
| `DB_LOGIN_IN_CONNECTION` | 接続文字列に `UID` / `PWD` がある |

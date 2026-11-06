# Databases

English | [日本語](ja/database.md)

Crate `shikigami-db`. Built-in nodes that run SQL through ODBC, so one pair of nodes reaches SQL Server, Oracle, Access, PostgreSQL, MySQL and anything else with an ODBC driver on the PC. Windows has the ODBC driver manager built in; the database's own driver is installed as usual (for SQL Server, "ODBC Driver 18 for SQL Server").

| Node | What it does | Output | Risk |
|---|---|---|---|
| `db.query` | Runs one SELECT | the rows, as records keyed by column name | safe |
| `db.execute` | Runs one statement that changes data | `{ rowsAffected }` | dangerous |

## Connecting

- `connection` is an ODBC connection string: `Driver={ODBC Driver 18 for SQL Server};Server=db01;Database=orders;TrustServerCertificate=yes`, `DSN=core-system` (a data source set up in "ODBC Data Sources (64-bit)"), or `Driver={Microsoft Access Driver (*.mdb, *.accdb)};DBQ=C:\data\orders.accdb`.
- A password never goes in it: `UID` / `PWD` there give `DB_LOGIN_IN_CONNECTION`. The login is a registered secret, `user: { "secret": "Orders DB", "field": "username" }` and `password: { "secret": "Orders DB", "field": "password" }` (`password` takes only a secret).
- Like web APIs, the secret is sent only where it is allowed: its sites must include `db:<server>`, where the server is the `Server` (or `Data Source`, `Host`, `DSN`, `DBQ`) of the connection string, e.g. `db:db01` or `db:db01\sqlexpress`. Otherwise `SECRET_SITE_NOT_SET` / `SECRET_SITE_MISMATCH`, and the AI asks for it with `request_secret`.
- Windows authentication (`Trusted_Connection=yes`, the signed-in Windows user) needs no secret.

## SQL and values

- Values go in `params`, one for each `?` in `sql`, in order. Never build the SQL with `{{ }}`: a name like `O'Brien` would break it, and a value from outside could change what the SQL does.
- `params` takes text, numbers, `true` / `false` and `null`; dates as text (`"2026-11-06"`).
- `db.query` takes only one SELECT (or `WITH … SELECT`). Anything that changes data (INSERT, UPDATE, DELETE, `SELECT … INTO`, EXEC, …) gives `DB_NOT_A_QUERY`: use `db.execute`. Because it only reads, the AI can try it with `test_step` to look at tables (`SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ?`).
- Rows come out as records: numbers as numbers (`12800.00` of a DECIMAL column is `12800`), `BIT` as `true` / `false`, dates and times as `"2026-11-06"` / `"2026-11-06T09:30:00"`, `NULL` as `null`. More than `maxRows` rows (default and limit 100,000) gives `DB_TOO_MANY_ROWS`: narrow them down in the SQL.
- `db.execute` runs one statement and commits it when it succeeds. For many rows, loop over them with `control.forEach`.

```json
{ "type": "db.query", "params": {
  "connection": "Driver={ODBC Driver 18 for SQL Server};Server=db01;Database=orders;TrustServerCertificate=yes",
  "user": { "secret": "Orders DB", "field": "username" },
  "password": { "secret": "Orders DB", "field": "password" },
  "sql": "SELECT order_no, customer, amount FROM orders WHERE order_date = ?",
  "params": ["{{ formatDate(today(), 'yyyy-MM-dd') }}"]
}, "saveAs": "orders" }
{ "type": "excel.appendRows", "params": { "path": "output/today.xlsx", "rows": "{{ orders }}" } }
```

## Stopping and timeouts

`db.execute` runs its SQL in a transaction and commits only while the step is still wanted. When the run is stopped or the step's time runs out meanwhile, the change is rolled back, so a retry never meets half of an attempt that was given up on. The driver is told to give up a little before the step's timeout.

## Errors

| Code | When |
|---|---|
| `DB_DRIVER_NOT_FOUND` | The driver or DSN is not installed on this PC |
| `DB_CONNECT_FAILED` | The server could not be reached (retried) |
| `DB_LOGIN_FAILED` | The database refused the login |
| `DB_TIMEOUT` | No answer within the step's timeout (retried) |
| `DB_SQL_ERROR` | The database rejected the SQL (`details.sqlState` holds its SQLSTATE) |
| `DB_NOT_A_QUERY` | `db.query` was given something other than one SELECT |
| `DB_TOO_MANY_ROWS` | More rows than `maxRows` |
| `DB_LOGIN_IN_CONNECTION` | The connection string holds `UID` / `PWD` |

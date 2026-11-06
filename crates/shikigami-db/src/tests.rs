use std::sync::Arc;

use serde_json::{Value, json};
use shikigami_core::secret::{ResolvedSecret, SecretError, SecretProvider, SecretRef};
use shikigami_core::{Scenario, Step, Validator, VarDirection, VarType, VariableDef};
use shikigami_runtime::{RunOptions, RunReport, RunStatus, Runtime};

use super::*;

fn runtime() -> Runtime {
    Runtime::builder().adapter(&DbAdapter::new()).build()
}

async fn run(runtime: &Runtime, step_type: &str, params: Value) -> RunReport {
    let mut s = Scenario::new("db");
    s.variables.push(VariableDef {
        direction: VarDirection::Output,
        ..VariableDef::new("out", VarType::Any)
    });
    let mut step = Step::new(step_type);
    for (k, v) in params.as_object().unwrap() {
        step = step.with_param(k, v.clone());
    }
    step.save_as = Some("out".into());
    shikigami_core::ops::assign_missing_ids(&mut step);
    s.steps = vec![step];
    runtime
        .start(s, RunOptions::default())
        .unwrap()
        .wait()
        .await
        .unwrap()
}

struct Login(Vec<String>);

impl SecretProvider for Login {
    fn resolve(&self, reference: &SecretRef) -> Result<ResolvedSecret, SecretError> {
        Ok(ResolvedSecret {
            name: reference.secret.clone(),
            field: reference.field,
            value: match reference.field.as_str() {
                "username" => "robot".into(),
                _ => "pa;ss}word".into(),
            },
            sites: self.0.clone(),
        })
    }
    fn load_session(&self, _: &str) -> Result<Option<Value>, SecretError> {
        Ok(None)
    }
    fn save_session(&self, _: &str, _: &Value) -> Result<(), SecretError> {
        Ok(())
    }
}

/// A connection string for a new SQLite database through the SQLite ODBC
/// driver, or `None` when that driver is not installed (CI on Linux
/// installs it; see .github/workflows/ci.yml).
fn sqlite(dir: &std::path::Path) -> Option<String> {
    let path = dir.join("受注.db");
    let connection = format!("Driver=SQLite3;Database={}", path.display());
    match odbc_api::environment()
        .ok()?
        .connect_with_connection_string(&connection, odbc_api::ConnectionOptions::default())
    {
        Ok(_) => Some(connection),
        Err(e) => {
            assert!(
                !std::env::var("SHIKIGAMI_REQUIRE_ODBC").is_ok_and(|v| v == "1"),
                "the SQLite ODBC driver is required here: {e}"
            );
            eprintln!("skipped: no SQLite ODBC driver ({e})");
            None
        }
    }
}

#[tokio::test]
async fn writes_and_reads_rows_with_bound_values() {
    let dir = tempfile::tempdir().unwrap();
    let Some(connection) = sqlite(dir.path()) else {
        return;
    };
    let runtime = runtime();
    let report = run(
        &runtime,
        types::EXECUTE,
        json!({ "connection": connection, "sql": "CREATE TABLE 受注 (番号 INTEGER, 顧客名 VARCHAR(50), 金額 DOUBLE, 受注日 TIMESTAMP, 済 BIT)" }),
    )
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    for (n, name, amount) in [
        (1, "山田商店", 12800.0),
        (2, "O'Brien", 99.5),
        (3, "鈴木", 0.0),
    ] {
        let report = run(
            &runtime,
            types::EXECUTE,
            json!({
                "connection": connection,
                "sql": "INSERT INTO 受注 VALUES (?, ?, ?, ?, ?)",
                "params": [n, name, amount, "2026-11-06 09:30:00", n == 1]
            }),
        )
        .await;
        assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
        assert_eq!(report.outputs["out"]["rowsAffected"], json!(1));
    }
    let report = run(
        &runtime,
        types::EXECUTE,
        json!({ "connection": connection, "sql": "UPDATE 受注 SET 済 = ? WHERE 金額 < ?", "params": [true, 100] }),
    )
    .await;
    assert_eq!(report.outputs["out"]["rowsAffected"], json!(2));

    let report = run(
        &runtime,
        types::QUERY,
        json!({
            "connection": connection,
            // A ; and the word DELETE inside a string are not statements.
            "sql": "SELECT 番号, 顧客名, 金額, 受注日, 済, NULL AS 備考 FROM 受注 WHERE 顧客名 <> 'x;DELETE' AND 番号 >= ? ORDER BY 番号 -- 1 件目から",
            "params": [1]
        }),
    )
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    let rows = report.outputs["out"].as_array().unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0]["顧客名"], json!("山田商店"));
    assert_eq!(rows[0]["金額"], json!(12800));
    assert_eq!(rows[1]["顧客名"], json!("O'Brien"));
    assert_eq!(rows[1]["金額"], json!(99.5));
    assert_eq!(rows[0]["番号"], json!(1));
    assert_eq!(rows[0]["受注日"], json!("2026-11-06T09:30:00"));
    assert_eq!(rows[0]["備考"], Value::Null);

    let report = run(
        &runtime,
        types::QUERY,
        json!({ "connection": connection, "sql": "SELECT * FROM 受注", "maxRows": 2 }),
    )
    .await;
    assert_eq!(report.error.unwrap().code, "DB_TOO_MANY_ROWS");

    let report = run(
        &runtime,
        types::QUERY,
        json!({ "connection": connection, "sql": "SELECT * FROM ない表" }),
    )
    .await;
    assert_eq!(report.error.unwrap().code, "DB_SQL_ERROR");
}

#[tokio::test]
async fn a_login_goes_only_to_the_servers_its_secret_allows() {
    let dir = tempfile::tempdir().unwrap();
    let Some(connection) = sqlite(dir.path()) else {
        return;
    };
    let site = format!(
        "db:{}",
        dir.path()
            .join("受注.db")
            .display()
            .to_string()
            .to_lowercase()
    );
    let login = json!({
        "connection": connection,
        "user": { "secret": "受注DB", "field": "username" },
        "password": { "secret": "受注DB", "field": "password" },
        "sql": "SELECT 1 AS one",
    });
    let report = run(
        &runtime().with_secrets(Arc::new(Login(vec!["db:other".into()]))),
        types::QUERY,
        login.clone(),
    )
    .await;
    assert_eq!(report.error.unwrap().code, "SECRET_SITE_MISMATCH");
    let report = run(
        &runtime().with_secrets(Arc::new(Login(vec![site]))),
        types::QUERY,
        login,
    )
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["out"], json!([{ "one": 1 }]));
}

#[tokio::test]
async fn refuses_a_password_in_the_connection_string_or_as_text() {
    let report = run(
        &runtime(),
        types::QUERY,
        json!({ "connection": "Driver={SQL Server};Server=db01;UID=sa;PWD=x", "sql": "SELECT 1" }),
    )
    .await;
    assert_eq!(report.error.unwrap().code, "DB_LOGIN_IN_CONNECTION");
    let report = run(
        &runtime(),
        types::QUERY,
        json!({ "connection": "Driver={SQL Server};Server=db01", "password": "x", "sql": "SELECT 1" }),
    )
    .await;
    assert_eq!(report.error.unwrap().code, "INVALID_PARAMS");
}

#[tokio::test]
async fn a_missing_driver_is_named() {
    let report = run(
        &runtime(),
        types::QUERY,
        json!({ "connection": "Driver={No Such Driver 99};Server=db01", "sql": "SELECT 1" }),
    )
    .await;
    let error = report.error.unwrap();
    // unixODBC without any driver configured may not get as far as IM002.
    assert!(
        ["DB_DRIVER_NOT_FOUND", "DB_SQL_ERROR"].contains(&error.code.as_str()),
        "{error:?}"
    );
}

#[test]
fn query_only_reads() {
    for ok in [
        "SELECT * FROM t",
        "  select a, b from t where c = 'DELETE; DROP' ;",
        "WITH x AS (SELECT 1 AS a) SELECT a FROM x",
        "/* 一覧 */ SELECT [update] FROM t",
    ] {
        assert!(sql::check_query(ok).is_ok(), "{ok}");
    }
    for bad in [
        "DELETE FROM t",
        "SELECT 1; DELETE FROM t",
        "SELECT * INTO copy FROM t",
        "WITH x AS (SELECT 1) DELETE FROM t",
        "EXEC sp_who",
        "",
    ] {
        assert_eq!(
            sql::check_query(bad).unwrap_err().code,
            "DB_NOT_A_QUERY",
            "{bad}"
        );
    }
}

#[test]
fn connection_strings_are_read_like_odbc() {
    let pairs = sql::parse_connection(
        "Driver={ODBC Driver 18 for SQL Server};Server=DB01\\SQLEXPRESS; Database=受注;Extra={a;b}}c}",
    )
    .unwrap();
    assert_eq!(
        pairs[0],
        ("driver".into(), "ODBC Driver 18 for SQL Server".into())
    );
    assert_eq!(pairs[3], ("extra".into(), "a;b}c".into()));
    assert_eq!(sql::server_site(&pairs).unwrap(), "db:db01\\sqlexpress");
    let dsn = sql::parse_connection("DSN=基幹;Trusted_Connection=yes").unwrap();
    assert_eq!(sql::server_site(&dsn).unwrap(), "db:基幹");
    assert!(sql::is_login_key("pwd") && sql::is_login_key("user id"));
    assert_eq!(sql::quote_value("pa;ss}word"), "{pa;ss}}word}");
    assert_eq!(sql::quote_value("plain"), "plain");
}

#[test]
fn examples_validate() {
    let runtime = runtime();
    let validator = Validator::new(runtime.registry().clone());
    for def in definitions() {
        for example in &def.examples {
            let mut step: Step = serde_json::from_value(example.clone()).unwrap();
            shikigami_core::ops::assign_missing_ids(&mut step);
            let mut s = Scenario::new("example");
            s.variables = ["orders", "rows", "result", "area", "order"]
                .iter()
                .map(|n| VariableDef::new(*n, VarType::Any))
                .collect();
            s.steps = vec![step];
            let report = validator.validate(&s);
            assert_eq!(report.error_count(), 0, "{example}: {:?}", report.issues);
        }
    }
}

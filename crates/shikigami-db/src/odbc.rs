//! Talking to the database through the ODBC driver manager (odbc32.dll on
//! Windows, unixODBC elsewhere). Text goes both ways as UTF-16, so Japanese
//! is kept whatever the PC's code page.

use odbc_api::{
    ConnectionOptions, Cursor, DataType, IntoParameter,
    parameter::{InputParameter, VarWCharBox},
};
use serde_json::{Map, Number, Value, json};
use shikigami_runtime::StepError;
use tokio_util::sync::CancellationToken;

use crate::{Kind, LOGIN_TIMEOUT_SECS, Request};

/// Why the step must not go on: stopped, or its time is up.
fn given_up(request: &Request, cancel: &CancellationToken) -> Option<StepError> {
    if cancel.is_cancelled() {
        Some(StepError::new("CANCELLED", "the step was stopped"))
    } else if std::time::Instant::now() >= request.deadline {
        Some(StepError::new(
            "DB_TIMEOUT",
            "the database did not answer in time",
        ))
    } else {
        None
    }
}

/// Runs the SQL. A query never keeps a change (see below). A change
/// (`db.execute`) runs in a transaction that is
/// committed only while the step is still wanted: when it was stopped or
/// its time ran out meanwhile, the change is rolled back, so a retry or
/// the next step never meets half of an attempt that was given up on.
pub fn run(request: &Request, cancel: &CancellationToken) -> Result<Value, StepError> {
    if let Some(e) = given_up(request, cancel) {
        return Err(e);
    }
    let env = odbc_api::environment().map_err(|e| failure(&e, "the ODBC driver manager"))?;
    let login_timeout = u32::try_from(request.timeout_secs)
        .unwrap_or(u32::MAX)
        .min(LOGIN_TIMEOUT_SECS);
    let connection = env
        .connect_with_connection_string(
            &request.connection,
            ConnectionOptions {
                login_timeout_sec: Some(login_timeout),
                ..ConnectionOptions::default()
            },
        )
        .map_err(|e| failure(&e, "connecting"))?;
    // Both kinds run in a transaction. A query's is always rolled back, so
    // even a SELECT that changes something (a function with side effects,
    // such as PostgreSQL's lo_unlink) leaves the database as it was.
    connection
        .set_autocommit(false)
        .map_err(|e| failure(&e, "starting a transaction"))?;
    let result = execute(&connection, request, cancel);
    if request.kind == Kind::Query {
        let ended = connection.rollback();
        if result.is_ok() {
            ended.map_err(|e| failure(&e, "ending the read"))?;
        }
    } else {
        let outcome = match (&result, given_up(request, cancel)) {
            (Ok(_), None) => connection.commit().map_err(|e| failure(&e, "committing")),
            (Ok(_), Some(e)) => {
                let _ = connection.rollback();
                Err(e)
            }
            (Err(_), _) => {
                let _ = connection.rollback();
                Ok(())
            }
        };
        outcome?;
    }
    result
}

fn execute(
    connection: &odbc_api::Connection<'_>,
    request: &Request,
    cancel: &CancellationToken,
) -> Result<Value, StepError> {
    let params: Vec<Box<dyn InputParameter>> = request.params.iter().map(parameter).collect();
    let mut statement = connection
        .preallocate()
        .map_err(|e| failure(&e, "preparing"))?;
    statement
        .set_query_timeout_sec(request.timeout_secs)
        .map_err(|e| failure(&e, "preparing"))?;
    let cursor = statement
        .execute(&request.sql, params.as_slice())
        .map_err(|e| failure(&e, "running the SQL"))?;
    match request.kind {
        Kind::Query => {
            let Some(mut cursor) = cursor else {
                return Ok(json!([]));
            };
            let rows = read_rows(&mut cursor, request.max_rows)?;
            given_up(request, cancel).map_or(Ok(rows), Err)
        }
        Kind::Execute => {
            drop(cursor);
            let count = statement
                .row_count()
                .map_err(|e| failure(&e, "running the SQL"))?;
            Ok(json!({ "rowsAffected": count }))
        }
    }
}

/// A JSON value bound to a `?` of the SQL.
fn parameter(value: &Value) -> Box<dyn InputParameter> {
    match value {
        Value::Null => Box::new(VarWCharBox::null()),
        Value::Bool(b) => Box::new(odbc_api::Bit::from_bool(*b)),
        Value::Number(n) => match (n.as_i64(), n.is_u64(), n.as_f64()) {
            (Some(i), _, _) => Box::new(i.into_parameter()),
            // Above i64::MAX (BIGINT UNSIGNED): exact, as decimal text.
            (None, true, _) => Box::new(VarWCharBox::from_str_slice(&n.to_string())),
            (None, false, Some(f)) => Box::new(f.into_parameter()),
            _ => Box::new(VarWCharBox::from_str_slice(&n.to_string())),
        },
        Value::String(s) => Box::new(VarWCharBox::from_str_slice(s)),
        other => Box::new(VarWCharBox::from_str_slice(&other.to_string())),
    }
}

fn read_rows(cursor: &mut impl Cursor, max_rows: usize) -> Result<Value, StepError> {
    let fail = |e: odbc_api::Error| failure(&e, "reading the rows");
    let count = cursor.num_result_cols().map_err(fail)?;
    let count = u16::try_from(count.max(0)).unwrap_or(0);
    let mut columns = Vec::new();
    for n in 1..=count {
        let name = cursor.col_name(n).map_err(fail)?;
        let name = if name.trim().is_empty() {
            format!("col{n}")
        } else {
            name
        };
        columns.push((name, cursor.col_data_type(n).map_err(fail)?));
    }
    let mut rows = Vec::new();
    let mut buf: Vec<u16> = Vec::new();
    while let Some(mut row) = cursor.next_row().map_err(fail)? {
        if rows.len() == max_rows {
            return Err(StepError::permanent(
                "DB_TOO_MANY_ROWS",
                format!("the query returns more than {max_rows} rows"),
            )
            .with_details(json!({ "hint": "Narrow the rows down in the SQL (WHERE, TOP / FETCH FIRST), or raise maxRows." })));
        }
        let mut record = Map::new();
        for (index, (name, data_type)) in columns.iter().enumerate() {
            let n = u16::try_from(index + 1).unwrap_or(u16::MAX);
            let value = if row.get_wide_text(n, &mut buf).map_err(fail)? {
                convert(&String::from_utf16_lossy(&buf), data_type)
            } else {
                Value::Null
            };
            record.insert(name.clone(), value);
        }
        rows.push(Value::Object(record));
    }
    Ok(Value::Array(rows))
}

/// A column's text as the JSON value a flow expects for its type.
pub fn convert(text: &str, data_type: &DataType) -> Value {
    let number = |text: &str| -> Value {
        let trimmed = text.trim();
        if let Ok(i) = trimmed.parse::<i64>() {
            return json!(i);
        }
        // BIGINT UNSIGNED above i64::MAX.
        if let Ok(u) = trimmed.parse::<u64>() {
            return json!(u);
        }
        // More digits than a double holds exactly (DECIMAL(38, 0) and the
        // like): kept as text so no identifier or amount is rounded.
        if trimmed.chars().filter(char::is_ascii_digit).count() > 15 {
            return json!(trimmed);
        }
        match trimmed.parse::<f64>() {
            Ok(f) if f.is_finite() => {
                // 12800.00 from a DECIMAL column is the whole number 12800.
                if f.fract() == 0.0 && f.abs() < 9.0e15 {
                    #[allow(clippy::cast_possible_truncation)]
                    return json!(f as i64);
                }
                Number::from_f64(f).map_or_else(|| json!(trimmed), Value::Number)
            }
            _ => json!(trimmed),
        }
    };
    match data_type {
        DataType::Integer
        | DataType::SmallInt
        | DataType::BigInt
        | DataType::TinyInt
        | DataType::Numeric { .. }
        | DataType::Decimal { .. }
        | DataType::Float { .. }
        | DataType::Real
        | DataType::Double => number(text),
        DataType::Bit => match text.trim() {
            "1" | "true" | "TRUE" => json!(true),
            "0" | "false" | "FALSE" => json!(false),
            other => json!(other),
        },
        DataType::Timestamp { .. } => json!(timestamp(text)),
        _ => json!(text),
    }
}

/// `2026-11-06 09:30:00.000` → `2026-11-06T09:30:00`, as dates are written
/// elsewhere in flows; fractions of a second are kept when not zero.
fn timestamp(text: &str) -> String {
    let text = text.trim();
    let text = match text.split_once('.') {
        Some((whole, fraction)) if fraction.chars().all(|c| c == '0') => whole,
        _ => text,
    };
    text.replacen(' ', "T", 1)
}

/// An ODBC error as a step error with a stable code.
fn failure(error: &odbc_api::Error, doing: &str) -> StepError {
    let state = match error {
        odbc_api::Error::Diagnostics { record, .. } => record.state.as_str().to_owned(),
        _ => String::new(),
    };
    let message = format!("{doing}: {error}");
    let (code, hint, retryable) = match state.as_str() {
        "IM002" => (
            "DB_DRIVER_NOT_FOUND",
            "The ODBC driver or DSN in `connection` is not installed on this PC. Check the Driver={…} name in \"ODBC Data Sources (64-bit)\", e.g. {ODBC Driver 18 for SQL Server}, {SQL Server}, {Microsoft Access Driver (*.mdb, *.accdb)}.",
            false,
        ),
        "28000" => (
            "DB_LOGIN_FAILED",
            "The database refused the login. Check the user name and password of the secret in Writer, or whether Windows authentication is allowed.",
            false,
        ),
        s if s.starts_with("08") => (
            "DB_CONNECT_FAILED",
            "The database server could not be reached. Check Server / Data Source in `connection`, the network, and whether the server is running.",
            true,
        ),
        "HYT00" | "HYT01" => (
            "DB_TIMEOUT",
            "The database did not answer in time. Narrow the SQL down, or raise the step's timeout.",
            true,
        ),
        _ => (
            "DB_SQL_ERROR",
            "The database rejected the SQL. Check table and column names (db.query on INFORMATION_SCHEMA.COLUMNS lists them on SQL Server, PostgreSQL and MySQL) and that each ? has a value in params.",
            false,
        ),
    };
    let error = if retryable {
        StepError::new(code, message)
    } else {
        StepError::permanent(code, message)
    };
    error.with_details(json!({ "sqlState": state, "hint": hint }))
}

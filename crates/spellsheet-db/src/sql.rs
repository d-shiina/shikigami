//! Reading connection strings and SQL text: no database needed.

use serde_json::json;
use spellsheet_runtime::StepError;

/// `Key=Value;…` pairs of an ODBC connection string, keys lower case.
/// A value in braces (`{ODBC Driver 18 for SQL Server}`) may hold `;`, and
/// `}}` inside braces is one `}`.
pub fn parse_connection(text: &str) -> Result<Vec<(String, String)>, StepError> {
    let bad = |why: &str| {
        StepError::permanent("INVALID_PARAMS", format!("connection string: {why}")).with_details(json!({
            "hint": "Write Key=Value pairs separated by ;, e.g. Driver={ODBC Driver 18 for SQL Server};Server=db01;Database=受注",
        }))
    };
    let mut pairs = Vec::new();
    let mut chars = text.chars().peekable();
    loop {
        while chars.peek().is_some_and(|c| *c == ';' || c.is_whitespace()) {
            chars.next();
        }
        if chars.peek().is_none() {
            break;
        }
        let mut key = String::new();
        for c in chars.by_ref() {
            if c == '=' {
                break;
            }
            key.push(c);
        }
        let key = key.trim().to_lowercase();
        if key.is_empty() {
            return Err(bad("a key is missing before ="));
        }
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
        let mut value = String::new();
        if chars.peek() == Some(&'{') {
            chars.next();
            loop {
                match chars.next() {
                    None => return Err(bad("a { is not closed")),
                    Some('}') if chars.peek() == Some(&'}') => {
                        chars.next();
                        value.push('}');
                    }
                    Some('}') => break,
                    Some(c) => value.push(c),
                }
            }
            for c in chars.by_ref() {
                if c == ';' {
                    break;
                }
            }
        } else {
            for c in chars.by_ref() {
                if c == ';' {
                    break;
                }
                value.push(c);
            }
            value = value.trim().to_owned();
        }
        pairs.push((key, value));
    }
    Ok(pairs)
}

/// Keys that carry a login, which never goes in the connection string.
pub fn is_login_key(key: &str) -> bool {
    matches!(
        key,
        "uid" | "pwd" | "user" | "user id" | "userid" | "username" | "user name" | "password"
    )
}

/// Keys that name where the driver connects. Different drivers use
/// different ones (psqlODBC: Servername, MySQL: Server, Oracle: DBQ).
const ENDPOINT_KEYS: [&str; 10] = [
    "server",
    "servername",
    "data source",
    "host",
    "hostname",
    "address",
    "addr",
    "network address",
    "dsn",
    "dbq",
];

/// Other keys a connection string may hold when a login is sent with it:
/// none of them can point the driver somewhere else.
const OPTION_KEYS: [&str; 22] = [
    "driver",
    "database",
    "initial catalog",
    "port",
    "encrypt",
    "trustservercertificate",
    "hostnameincertificate",
    "applicationintent",
    "multisubnetfailover",
    "connection timeout",
    "login timeout",
    "timeout",
    "app",
    "application name",
    "wsid",
    "workstation id",
    "language",
    "readonly",
    "charset",
    "sslmode",
    "option",
    "schema",
];

/// The site a secret must list to be sent with this connection:
/// `db:<server>`, from the one key that names where the driver connects.
/// A connection string a login may not go with (no endpoint, two different
/// endpoints, or a key that could send the driver elsewhere) is refused,
/// so a secret only ever goes where its site says.
pub fn server_site(pairs: &[(String, String)]) -> Result<String, StepError> {
    if let Some((key, _)) = pairs
        .iter()
        .find(|(k, _)| !ENDPOINT_KEYS.contains(&k.as_str()) && !OPTION_KEYS.contains(&k.as_str()))
    {
        return Err(StepError::permanent(
            "DB_CONNECTION_KEY_NOT_ALLOWED",
            format!("a login is not sent with a connection string that sets {key}"),
        )
        .with_details(json!({
            "key": key,
            "allowed": ENDPOINT_KEYS.iter().chain(OPTION_KEYS.iter()).collect::<Vec<_>>(),
            "hint": "With user / password, the connection string may only hold the keys in `allowed`, so the login can only go to the server its secret names. Put other driver settings in an ODBC data source (DSN) and connect with DSN=<name>, or use Windows authentication (Trusted_Connection=yes) without a login.",
        })));
    }
    let mut endpoints: Vec<String> = pairs
        .iter()
        .filter(|(k, v)| ENDPOINT_KEYS.contains(&k.as_str()) && !v.trim().is_empty())
        .map(|(_, v)| v.trim().to_lowercase())
        .collect();
    endpoints.dedup();
    let driver = pairs
        .iter()
        .find(|(k, _)| k == "driver")
        .map(|(_, v)| v.to_lowercase())
        .unwrap_or_default();
    if endpoints.is_empty() && driver.contains("sqlite") {
        // A SQLite database is its file.
        endpoints.extend(
            pairs
                .iter()
                .filter(|(k, v)| k == "database" && !v.trim().is_empty())
                .map(|(_, v)| v.trim().to_lowercase()),
        );
    }
    match endpoints.as_slice() {
        [one] => Ok(format!("db:{one}")),
        [] => Err(StepError::permanent(
            "DB_SERVER_UNKNOWN",
            "the connection string names no server (Server, Data Source, Servername, DSN or DBQ)",
        )),
        _ => Err(StepError::permanent(
            "DB_SERVER_AMBIGUOUS",
            format!("the connection string names more than one server: {}", endpoints.join(", ")),
        )
        .with_details(json!({ "hint": "Name the server once (Server=..., or DSN=... alone) so the login can only go there." }))),
    }
}

/// A value as written in a connection string: in braces when it has to be.
pub fn quote_value(value: &str) -> String {
    if value.contains([';', '{', '}', '=']) || value.trim() != value {
        format!("{{{}}}", value.replace('}', "}}"))
    } else {
        value.to_owned()
    }
}

/// The SQL without comments and with strings and quoted names blanked,
/// so keywords and `;` are found only where they mean something.
fn code_only(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut chars = sql.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '-' if chars.peek() == Some(&'-') => {
                for c in chars.by_ref() {
                    if c == '\n' {
                        break;
                    }
                }
                out.push(' ');
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut last = ' ';
                for c in chars.by_ref() {
                    if last == '*' && c == '/' {
                        break;
                    }
                    last = c;
                }
                out.push(' ');
            }
            '\'' | '"' | '[' | '`' => {
                let close = if c == '[' { ']' } else { c };
                while let Some(c) = chars.next() {
                    if c == close {
                        // '' inside a string is one quote.
                        if chars.peek() == Some(&close) && close != ']' {
                            chars.next();
                            continue;
                        }
                        break;
                    }
                }
                out.push_str(" x ");
            }
            _ => out.push(c),
        }
    }
    out
}

/// `db.query` only reads: one SELECT, or WITH … SELECT.
pub fn check_query(sql: &str) -> Result<(), StepError> {
    let code = code_only(sql).to_uppercase();
    let words: Vec<&str> = code
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty())
        .collect();
    let not_a_query = |why: String| {
        StepError::permanent("DB_NOT_A_QUERY", why).with_details(json!({
            "hint": "db.query runs one SELECT. Use db.execute for INSERT, UPDATE, DELETE and other statements that change data, one statement per step.",
        }))
    };
    let body = code.trim().trim_end_matches(';');
    if body.contains(';') {
        return Err(not_a_query("the SQL holds more than one statement".into()));
    }
    match words.first() {
        Some(&("SELECT" | "WITH")) => {}
        Some(first) => return Err(not_a_query(format!("{first} is not a SELECT"))),
        None => return Err(not_a_query("the SQL is empty".into())),
    }
    const CHANGES: [&str; 13] = [
        "INSERT", "UPDATE", "DELETE", "MERGE", "INTO", "DROP", "CREATE", "ALTER", "TRUNCATE",
        "EXEC", "EXECUTE", "GRANT", "CALL",
    ];
    if let Some(word) = words.iter().find(|w| CHANGES.contains(w)) {
        return Err(not_a_query(format!("{word} changes data")));
    }
    Ok(())
}

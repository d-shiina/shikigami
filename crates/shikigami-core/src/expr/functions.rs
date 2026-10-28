//! The built-in functions of the expression language, with the catalogue AI
//! clients read (`list_step_types` → `functions`).
//!
//! Functions never change anything outside the expression. A few read the
//! clock or the environment (`now`, `today`, `env`); everything else depends
//! only on its arguments.

use std::cmp::Ordering;

use serde::Serialize;
use serde_json::{Map, Value};

use super::{
    Expr, ExprError, Scope, apply_lambda, date, eval, loose_eq, number, to_display, truthy,
    type_name, width,
};

/// One entry of the function catalogue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionDoc {
    pub name: &'static str,
    /// `text`, `regex`, `number`, `list`, `object`, `date`, `path`, `json` or `other`.
    pub category: &'static str,
    pub signature: &'static str,
    pub description: &'static str,
    /// An expression and its result, e.g. `trim('  a ') → 'a'`.
    pub example: &'static str,
}

const fn f(
    name: &'static str,
    category: &'static str,
    signature: &'static str,
    description: &'static str,
    example: &'static str,
) -> FunctionDoc {
    FunctionDoc {
        name,
        category,
        signature,
        description,
        example,
    }
}

/// Every function, grouped by category.
pub const FUNCTION_DOCS: &[FunctionDoc] = &[
    // Text. Joining text needs no function: `a + b`, `a + '様'` or a template.
    f(
        "len",
        "text",
        "len(x)",
        "Number of characters of a string, elements of a list or keys of an object (null → 0).",
        "len('東京都') → 3",
    ),
    f(
        "trim",
        "text",
        "trim(s)",
        "Removes leading and trailing whitespace (including full-width spaces).",
        "trim('  山田 ') → '山田'",
    ),
    f(
        "trimStart",
        "text",
        "trimStart(s)",
        "Removes leading whitespace.",
        "trimStart('  a ') → 'a '",
    ),
    f(
        "trimEnd",
        "text",
        "trimEnd(s)",
        "Removes trailing whitespace.",
        "trimEnd('  a ') → '  a'",
    ),
    f(
        "lower",
        "text",
        "lower(s)",
        "Lower-cases a string.",
        "lower('ABC') → 'abc'",
    ),
    f(
        "upper",
        "text",
        "upper(s)",
        "Upper-cases a string.",
        "upper('abc') → 'ABC'",
    ),
    f(
        "replace",
        "text",
        "replace(s, find, with)",
        "Replaces every occurrence of the text `find` (not a pattern; see regexReplace).",
        "replace('2026/10/28', '/', '-') → '2026-10-28'",
    ),
    f(
        "slice",
        "text",
        "slice(x, start, end?)",
        "Part of a string (by character) or list from `start` up to but not including `end`. Negative positions count from the end.",
        "slice('ABC-123', 4) → '123', slice('ABC-123', 0, 3) → 'ABC', slice(code, -2) → last 2 characters",
    ),
    f(
        "indexOf",
        "text",
        "indexOf(x, find)",
        "Position of `find` in a string (characters) or list, or -1.",
        "indexOf('ABC-123', '-') → 3",
    ),
    f(
        "padStart",
        "text",
        "padStart(x, length, fill?)",
        "Pads the start to `length` characters with `fill` (default space). Numbers are converted to text.",
        "padStart(7, 3, '0') → '007'",
    ),
    f(
        "padEnd",
        "text",
        "padEnd(x, length, fill?)",
        "Pads the end to `length` characters with `fill` (default space).",
        "padEnd('A', 3, '*') → 'A**'",
    ),
    f(
        "contains",
        "text",
        "contains(x, find)",
        "Whether a string contains the text, a list contains the value, or an object has the key.",
        "contains('株式会社ABC', '株式会社') → true",
    ),
    f(
        "startsWith",
        "text",
        "startsWith(s, prefix)",
        "Whether the string starts with `prefix`.",
        "startsWith('INV-001', 'INV') → true",
    ),
    f(
        "endsWith",
        "text",
        "endsWith(s, suffix)",
        "Whether the string ends with `suffix`.",
        "endsWith('a.xlsx', '.xlsx') → true",
    ),
    f(
        "split",
        "text",
        "split(s, separator)",
        "Splits a string into a list.",
        "split('a,b,c', ',') → ['a', 'b', 'c']",
    ),
    f(
        "lines",
        "text",
        "lines(s)",
        "Splits text into lines (\\r\\n, \\n or \\r). A final line break does not add an empty line.",
        "lines('a\\r\\nb\\n') → ['a', 'b']",
    ),
    f(
        "join",
        "text",
        "join(list, separator)",
        "Joins list elements into one string.",
        "join(['a', 'b'], '、') → 'a、b'",
    ),
    f(
        "toHalfWidth",
        "text",
        "toHalfWidth(s)",
        "Converts full-width letters, digits, symbols, spaces and katakana to half-width.",
        "toHalfWidth('ＡＢＣ１２３　カナ') → 'ABC123 ｶﾅ'",
    ),
    f(
        "toFullWidth",
        "text",
        "toFullWidth(s)",
        "Converts half-width letters, digits, symbols, spaces and katakana to full-width.",
        "toFullWidth('ABC123 ｶﾞ') → 'ＡＢＣ１２３　ガ'",
    ),
    f(
        "str",
        "text",
        "str(x)",
        "Converts a value to text (null → '').",
        "str(1200) → '1200'",
    ),
    f(
        "formatNumber",
        "text",
        "formatNumber(n, decimals?)",
        "Formats a number with thousands separators and `decimals` digits (default 0, rounded half away from zero).",
        "formatNumber(1234567.891, 2) → '1,234,567.89'",
    ),
    // Regular expressions (Rust regex syntax; no backtracking, so any pattern runs in linear time).
    f(
        "regexTest",
        "regex",
        "regexTest(s, pattern)",
        "Whether the pattern matches anywhere in the string.",
        "regexTest(code, '^[A-Z]{3}-\\\\d+$') → true",
    ),
    f(
        "regexFind",
        "regex",
        "regexFind(s, pattern, group?)",
        "The first match, or the given capture group (number or name) of it; null when nothing matches.",
        "regexFind('請求番号: INV-0042', 'INV-(\\\\d+)', 1) → '0042'",
    ),
    f(
        "regexFindAll",
        "regex",
        "regexFindAll(s, pattern, group?)",
        "Every match (or the given capture group of each) as a list.",
        "regexFindAll('a1 b22 c333', '\\\\d+') → ['1', '22', '333']",
    ),
    f(
        "regexReplace",
        "regex",
        "regexReplace(s, pattern, with)",
        "Replaces every match; `$1` / `${name}` in `with` insert capture groups.",
        "regexReplace('090-1234-5678', '\\\\D', '') → '09012345678'",
    ),
    // Numbers.
    f(
        "num",
        "number",
        "num(x)",
        "Converts text to a number; commas and surrounding spaces are ignored.",
        "num('1,234') → 1234",
    ),
    f(
        "round",
        "number",
        "round(x, digits?)",
        "Rounds half away from zero to `digits` decimals (0-10, default 0).",
        "round(2.345, 2) → 2.35",
    ),
    f(
        "floor",
        "number",
        "floor(x)",
        "Largest integer not greater than x.",
        "floor(2.7) → 2",
    ),
    f(
        "ceil",
        "number",
        "ceil(x)",
        "Smallest integer not less than x.",
        "ceil(2.1) → 3",
    ),
    f("abs", "number", "abs(x)", "Absolute value.", "abs(-5) → 5"),
    f(
        "min",
        "number",
        "min(list) / min(a, b, …)",
        "Smallest number (or string). null elements are skipped; an empty list gives null.",
        "min([3, 1, 2]) → 1",
    ),
    f(
        "max",
        "number",
        "max(list) / max(a, b, …)",
        "Largest number (or string). null elements are skipped; an empty list gives null.",
        "max(price, 1000) → the larger",
    ),
    f(
        "sum",
        "number",
        "sum(list)",
        "Sum of a list of numbers (null counts as 0).",
        "sum(map(rows, r => r.amount)) → total",
    ),
    f(
        "avg",
        "number",
        "avg(list)",
        "Average of a list of numbers (null elements skipped); null for an empty list.",
        "avg([1, 2, 6]) → 3",
    ),
    // Lists.
    f(
        "map",
        "list",
        "map(list, x => value)",
        "A new list with `value` computed for each element.",
        "map(rows, r => r.name) → ['A', 'B']",
    ),
    f(
        "filter",
        "list",
        "filter(list, x => condition)",
        "The elements for which `condition` is truthy.",
        "filter(rows, r => num(r.amount) >= 10000)",
    ),
    f(
        "find",
        "list",
        "find(list, x => condition)",
        "The first element for which `condition` is truthy, or null.",
        "find(customers, c => c.code == code)",
    ),
    f(
        "some",
        "list",
        "some(list, x => condition)",
        "Whether any element matches.",
        "some(rows, r => r.status == 'エラー') → true",
    ),
    f(
        "every",
        "list",
        "every(list, x => condition)",
        "Whether all elements match (true for an empty list).",
        "every(rows, r => r.checked)",
    ),
    f(
        "sortBy",
        "list",
        "sortBy(list, x => key)",
        "Sorts by the key, ascending (stable; nulls last). Wrap in reverse() for descending.",
        "reverse(sortBy(rows, r => num(r.amount)))",
    ),
    f(
        "groupBy",
        "list",
        "groupBy(list, x => key)",
        "An object mapping each key (as text) to the list of its elements.",
        "groupBy(rows, r => r.dept) → { '営業': [...], '経理': [...] }",
    ),
    f(
        "sort",
        "list",
        "sort(list)",
        "Sorts numbers or strings ascending.",
        "sort([3, 1, 2]) → [1, 2, 3]",
    ),
    f(
        "reverse",
        "list",
        "reverse(x)",
        "Reverses a list, or the characters of a string.",
        "reverse([1, 2, 3]) → [3, 2, 1]",
    ),
    f(
        "unique",
        "list",
        "unique(list)",
        "Removes duplicates, keeping the first occurrence.",
        "unique(['a', 'b', 'a']) → ['a', 'b']",
    ),
    f(
        "range",
        "list",
        "range(count) / range(start, end)",
        "Integers from 0 to count-1, or from start up to but not including end (at most 100000).",
        "range(3) → [0, 1, 2]",
    ),
    // Objects.
    f(
        "keys",
        "object",
        "keys(object)",
        "The keys of an object, in order.",
        "keys({ a: 1, b: 2 }) → ['a', 'b']",
    ),
    f(
        "values",
        "object",
        "values(object)",
        "The values of an object, in key order.",
        "values({ a: 1, b: 2 }) → [1, 2]",
    ),
    f(
        "merge",
        "object",
        "merge(a, b, …)",
        "One object with the keys of all arguments; later arguments win. Use it to add or change keys of a record.",
        "merge(row, { status: '済' })",
    ),
    // Dates: text `yyyy-MM-dd` or `yyyy-MM-ddTHH:mm:ss` in local time.
    f(
        "now",
        "date",
        "now()",
        "The current local date and time, e.g. '2026-10-28T09:30:00'.",
        "formatDate(now(), 'HHmmss')",
    ),
    f(
        "today",
        "date",
        "today()",
        "Today's local date, e.g. '2026-10-28'.",
        "formatDate(today(), 'yyyyMMdd') → '20261028'",
    ),
    f(
        "formatDate",
        "date",
        "formatDate(date, pattern)",
        "Formats a date. Tokens: yyyy yy MM M dd d HH H mm ss, ddd (月) dddd (月曜日), gg (令和) e/ee (era year). Other characters are kept.",
        "formatDate('2026-10-28', 'gge年M月d日(ddd)') → '令和8年10月28日(水)'",
    ),
    f(
        "parseDate",
        "date",
        "parseDate(text, pattern?)",
        "Reads a date into 'yyyy-MM-dd' (or 'yyyy-MM-ddTHH:mm:ss' when it has a time). Without a pattern it reads 2026-10-28, 2026/10/28 9:30 and 2026年10月28日; otherwise give the layout with formatDate tokens.",
        "parseDate('令和8年10月28日', 'gge年M月d日') → '2026-10-28'",
    ),
    f(
        "dateAdd",
        "date",
        "dateAdd(date, amount, unit)",
        "Adds a (possibly negative) amount of year, month, week, day, hour, minute or second. Adding months keeps the day where possible (1/31 + 1 month = 2/28).",
        "dateAdd(today(), -1, 'day') → yesterday",
    ),
    f(
        "dateDiff",
        "date",
        "dateDiff(from, to, unit)",
        "Whole units from `from` to `to` (negative if `to` is earlier).",
        "dateDiff('2026-01-01', '2026-03-01', 'day') → 59",
    ),
    f(
        "endOfMonth",
        "date",
        "endOfMonth(date)",
        "The last day of the date's month.",
        "endOfMonth('2028-02-10') → '2028-02-29'",
    ),
    // Paths (text only; nothing is read from disk).
    f(
        "pathJoin",
        "path",
        "pathJoin(folder, name, …)",
        "Joins path parts with the path separator.",
        "pathJoin(outDir, '請求書.xlsx')",
    ),
    f(
        "dirName",
        "path",
        "dirName(path)",
        "The folder part of a path.",
        "dirName('C:\\\\data\\\\a.csv') → 'C:\\\\data'",
    ),
    f(
        "fileName",
        "path",
        "fileName(path)",
        "The file name with its extension.",
        "fileName('C:\\\\data\\\\a.csv') → 'a.csv'",
    ),
    f(
        "baseName",
        "path",
        "baseName(path)",
        "The file name without its extension.",
        "baseName('C:\\\\data\\\\a.csv') → 'a'",
    ),
    f(
        "extName",
        "path",
        "extName(path)",
        "The extension including the dot, or ''.",
        "extName('C:\\\\data\\\\a.csv') → '.csv'",
    ),
    // JSON.
    f(
        "parseJson",
        "json",
        "parseJson(text)",
        "Parses JSON text into a value.",
        "parseJson('{\"a\": 1}').a → 1",
    ),
    f(
        "toJson",
        "json",
        "toJson(value, pretty?)",
        "Converts a value to JSON text (indented when `pretty` is true).",
        "toJson({ a: 1 }) → '{\"a\":1}'",
    ),
    // Other.
    f(
        "isEmpty",
        "other",
        "isEmpty(x)",
        "Whether x is null, '', [] or {}.",
        "isEmpty(trim(name)) → true for blank names",
    ),
    f(
        "coalesce",
        "other",
        "coalesce(a, b, …)",
        "The first argument that is not null.",
        "coalesce(row.memo, '') → '' when memo is missing",
    ),
    f(
        "env",
        "other",
        "env(name)",
        "An environment variable of the PC running the scenario, or null.",
        "pathJoin(env('USERPROFILE'), 'Desktop')",
    ),
];

/// Functions whose second argument is `x => …`.
pub(super) const HIGHER_ORDER: &[&str] = &[
    "map", "filter", "find", "some", "every", "sortBy", "groupBy",
];

/// Names of all functions, in catalogue order.
pub fn function_names() -> impl Iterator<Item = &'static str> {
    FUNCTION_DOCS.iter().map(|d| d.name)
}

pub(super) fn doc(name: &str) -> Option<&'static FunctionDoc> {
    FUNCTION_DOCS.iter().find(|d| d.name == name)
}

fn type_err(message: impl Into<String>) -> ExprError {
    ExprError::Type(message.into())
}

/// Error for a wrong number of arguments, quoting the signature.
fn usage(name: &str) -> ExprError {
    match doc(name) {
        Some(d) => type_err(format!("usage: {}", d.signature)),
        None => ExprError::UnknownFunction(name.to_owned()),
    }
}

fn arity(name: &str, args: &[Value], min: usize, max: usize) -> Result<(), ExprError> {
    if (min..=max).contains(&args.len()) {
        Ok(())
    } else {
        Err(usage(name))
    }
}

fn str_arg<'a>(name: &str, value: &'a Value) -> Result<&'a str, ExprError> {
    value.as_str().ok_or_else(|| {
        type_err(format!(
            "{name}() expects a string, got {}",
            type_name(value)
        ))
    })
}

fn num_arg(name: &str, value: &Value) -> Result<f64, ExprError> {
    value.as_f64().ok_or_else(|| {
        type_err(format!(
            "{name}() expects a number, got {} (convert text with num())",
            type_name(value)
        ))
    })
}

fn int_arg(name: &str, value: &Value) -> Result<i64, ExprError> {
    let n = num_arg(name, value)?;
    if n.fract() != 0.0 || n.abs() > 9.0e15 {
        return Err(type_err(format!(
            "{name}() expects a whole number, got {n}"
        )));
    }
    #[allow(clippy::cast_possible_truncation)]
    Ok(n as i64)
}

fn list_arg<'a>(name: &str, value: &'a Value) -> Result<&'a Vec<Value>, ExprError> {
    match value {
        Value::Array(items) => Ok(items),
        other => Err(type_err(format!(
            "{name}() expects a list, got {}",
            type_name(other)
        ))),
    }
}

fn date_arg(name: &str, value: &Value) -> Result<date::When, ExprError> {
    date::parse(str_arg(name, value)?).map_err(|e| match e {
        ExprError::Type(m) => type_err(format!("{name}(): {m}")),
        other => other,
    })
}

/// Resolves a possibly negative position against a length (JavaScript `slice`).
fn position(index: i64, len: usize) -> usize {
    let len_i = i64::try_from(len).unwrap_or(i64::MAX);
    let resolved = if index < 0 { len_i + index } else { index };
    usize::try_from(resolved.clamp(0, len_i)).unwrap_or(0)
}

/// Total order used by `sort`, `sortBy`, `min` and `max`: numbers, then
/// strings, then everything else (nulls last).
fn compare(a: &Value, b: &Value) -> Ordering {
    fn rank(v: &Value) -> u8 {
        match v {
            Value::Number(_) => 0,
            Value::String(_) => 1,
            Value::Bool(_) => 2,
            Value::Array(_) | Value::Object(_) => 3,
            Value::Null => 4,
        }
    }
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x
            .as_f64()
            .partial_cmp(&y.as_f64())
            .unwrap_or(Ordering::Equal),
        (Value::String(x), Value::String(y)) => x.cmp(y),
        (Value::Bool(x), Value::Bool(y)) => x.cmp(y),
        _ => rank(a).cmp(&rank(b)),
    }
}

fn regex(pattern: &str) -> Result<regex::Regex, ExprError> {
    regex::RegexBuilder::new(pattern)
        .size_limit(1 << 20)
        .build()
        .map_err(|e| type_err(format!("invalid regex '{pattern}': {e}")))
}

/// Text of `group` (number or name) of a match; the whole match when `None`.
fn group_text(caps: &regex::Captures<'_>, group: Option<&Value>) -> Result<Value, ExprError> {
    let m = match group {
        None => caps.get(0),
        Some(Value::String(name)) => caps.name(name),
        Some(Value::Number(n)) => n
            .as_u64()
            .and_then(|i| usize::try_from(i).ok())
            .and_then(|i| caps.get(i)),
        Some(other) => {
            return Err(type_err(format!(
                "regex group must be a number or name, got {}",
                type_name(other)
            )));
        }
    };
    Ok(m.map_or(Value::Null, |m| Value::String(m.as_str().to_owned())))
}

fn pad(name: &str, args: &[Value]) -> Result<Value, ExprError> {
    arity(name, args, 2, 3)?;
    let text = to_display(&args[0]);
    let target = usize::try_from(int_arg(name, &args[1])?.clamp(0, 100_000)).unwrap_or(0);
    let fill = match args.get(2) {
        Some(v) => str_arg(name, v)?,
        None => " ",
    };
    let len = text.chars().count();
    if fill.is_empty() || len >= target {
        return Ok(Value::String(text));
    }
    let padding: String = fill.chars().cycle().take(target - len).collect();
    Ok(Value::String(if name == "padStart" {
        padding + &text
    } else {
        text + &padding
    }))
}

fn format_number(n: f64, decimals: usize) -> String {
    let scale = 10f64.powi(i32::try_from(decimals).unwrap_or(0));
    let rounded = (n.abs() * scale).round() / scale;
    let text = format!("{rounded:.decimals$}");
    let (int_part, frac) = text
        .split_once('.')
        .map_or((text.as_str(), None), |(i, f)| (i, Some(f)));
    let mut grouped = String::new();
    for (i, c) in int_part.chars().enumerate() {
        if i > 0 && (int_part.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    let sign = if n < 0.0 && rounded != 0.0 { "-" } else { "" };
    match frac {
        Some(f) => format!("{sign}{grouped}.{f}"),
        None => format!("{sign}{grouped}"),
    }
}

fn is_separator(c: char) -> bool {
    c == '/' || c == '\\'
}

/// (folder, file name) of a path; either separator is accepted.
fn split_path(path: &str) -> (&str, &str) {
    let trimmed = path.trim_end_matches(is_separator);
    match trimmed.rfind(is_separator) {
        Some(0) => (&trimmed[..1], &trimmed[1..]),
        Some(i) if i == 2 && trimmed.as_bytes().get(1) == Some(&b':') => {
            (&trimmed[..=i], &trimmed[i + 1..])
        }
        Some(i) => (&trimmed[..i], &trimmed[i + 1..]),
        None => ("", trimmed),
    }
}

/// (base name, extension with dot) of a file name.
fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}

fn min_max(name: &str, args: &[Value]) -> Result<Value, ExprError> {
    let items: &[Value] = match args {
        [] => return Err(usage(name)),
        [Value::Array(items)] => items,
        many => many,
    };
    let best = items
        .iter()
        .filter(|v| !v.is_null())
        .try_fold(None::<&Value>, |best, v| {
            if !matches!(v, Value::Number(_) | Value::String(_)) {
                return Err(type_err(format!("{name}() of {}", type_name(v))));
            }
            Ok(Some(match best {
                None => v,
                Some(b) => {
                    let ord = compare(v, b);
                    if (name == "min" && ord.is_lt()) || (name == "max" && ord.is_gt()) {
                        v
                    } else {
                        b
                    }
                }
            }))
        })?;
    Ok(best.cloned().unwrap_or(Value::Null))
}

/// Calls `map`, `filter`, … : evaluates the list, then the lambda per element.
pub(super) fn call_higher_order(
    name: &str,
    args: &[Expr],
    scope: &dyn Scope,
) -> Result<Value, ExprError> {
    let [list, lambda] = args else {
        return Err(usage(name));
    };
    let list = eval(list, scope)?;
    let items = match &list {
        Value::Null => &Vec::new(),
        other => list_arg(name, other)?,
    };
    let apply = |item: &Value| apply_lambda(lambda, item.clone(), scope);
    Ok(match name {
        "map" => Value::Array(items.iter().map(apply).collect::<Result<_, _>>()?),
        "filter" => {
            let mut out = Vec::new();
            for item in items {
                if truthy(&apply(item)?) {
                    out.push(item.clone());
                }
            }
            Value::Array(out)
        }
        "find" => {
            for item in items {
                if truthy(&apply(item)?) {
                    return Ok(item.clone());
                }
            }
            Value::Null
        }
        "some" => {
            for item in items {
                if truthy(&apply(item)?) {
                    return Ok(Value::Bool(true));
                }
            }
            Value::Bool(false)
        }
        "every" => {
            for item in items {
                if !truthy(&apply(item)?) {
                    return Ok(Value::Bool(false));
                }
            }
            Value::Bool(true)
        }
        "sortBy" => {
            let mut keyed = items
                .iter()
                .map(|item| Ok((apply(item)?, item)))
                .collect::<Result<Vec<_>, ExprError>>()?;
            keyed.sort_by(|(a, _), (b, _)| compare(a, b));
            Value::Array(keyed.into_iter().map(|(_, item)| item.clone()).collect())
        }
        "groupBy" => {
            let mut groups: Map<String, Value> = Map::new();
            for item in items {
                let key = to_display(&apply(item)?);
                if let Value::Array(group) = groups
                    .entry(key)
                    .or_insert_with(|| Value::Array(Vec::new()))
                {
                    group.push(item.clone());
                }
            }
            Value::Object(groups)
        }
        other => return Err(ExprError::UnknownFunction(other.to_owned())),
    })
}

#[allow(clippy::too_many_lines)]
pub(super) fn call(name: &str, args: &[Value]) -> Result<Value, ExprError> {
    let text = |s: String| Ok(Value::String(s));
    match name {
        "len" => {
            arity(name, args, 1, 1)?;
            Ok(Value::from(match &args[0] {
                Value::String(s) => s.chars().count(),
                Value::Array(a) => a.len(),
                Value::Object(o) => o.len(),
                Value::Null => 0,
                other => return Err(type_err(format!("len() of {}", type_name(other)))),
            }))
        }
        "contains" => {
            arity(name, args, 2, 2)?;
            Ok(Value::Bool(match (&args[0], &args[1]) {
                (Value::String(s), needle) => s.contains(&to_display(needle)),
                (Value::Array(items), needle) => items.iter().any(|v| loose_eq(v, needle)),
                (Value::Object(map), Value::String(key)) => map.contains_key(key),
                _ => false,
            }))
        }
        "startsWith" | "endsWith" => {
            arity(name, args, 2, 2)?;
            let s = str_arg(name, &args[0])?;
            let p = str_arg(name, &args[1])?;
            Ok(Value::Bool(if name == "startsWith" {
                s.starts_with(p)
            } else {
                s.ends_with(p)
            }))
        }
        "lower" => {
            arity(name, args, 1, 1)?;
            text(str_arg(name, &args[0])?.to_lowercase())
        }
        "upper" => {
            arity(name, args, 1, 1)?;
            text(str_arg(name, &args[0])?.to_uppercase())
        }
        "trim" | "trimStart" | "trimEnd" => {
            arity(name, args, 1, 1)?;
            let s = str_arg(name, &args[0])?;
            text(
                match name {
                    "trim" => s.trim(),
                    "trimStart" => s.trim_start(),
                    _ => s.trim_end(),
                }
                .to_owned(),
            )
        }
        "replace" => {
            arity(name, args, 3, 3)?;
            let s = str_arg(name, &args[0])?;
            let find = to_display(&args[1]);
            if find.is_empty() {
                return Err(type_err("replace(): the text to find is empty"));
            }
            text(s.replace(&find, &to_display(&args[2])))
        }
        "slice" => {
            arity(name, args, 2, 3)?;
            let start = int_arg(name, &args[1])?;
            let end = args.get(2).map(|e| int_arg(name, e)).transpose()?;
            let range = |len: usize| {
                let from = position(start, len);
                let to = end.map_or(len, |e| position(e, len));
                (from, to.max(from))
            };
            match &args[0] {
                Value::String(s) => {
                    let chars: Vec<char> = s.chars().collect();
                    let (from, to) = range(chars.len());
                    text(chars[from..to].iter().collect())
                }
                Value::Array(items) => {
                    let (from, to) = range(items.len());
                    Ok(Value::Array(items[from..to].to_vec()))
                }
                Value::Null => Ok(Value::Null),
                other => Err(type_err(format!("slice() of {}", type_name(other)))),
            }
        }
        "indexOf" => {
            arity(name, args, 2, 2)?;
            let found = match &args[0] {
                Value::String(s) => {
                    let needle = to_display(&args[1]);
                    s.find(&needle).map(|byte| s[..byte].chars().count())
                }
                Value::Array(items) => items.iter().position(|v| loose_eq(v, &args[1])),
                other => return Err(type_err(format!("indexOf() of {}", type_name(other)))),
            };
            Ok(found.map_or(Value::from(-1), Value::from))
        }
        "padStart" | "padEnd" => pad(name, args),
        "split" => {
            arity(name, args, 2, 2)?;
            let s = str_arg(name, &args[0])?;
            let sep = str_arg(name, &args[1])?;
            Ok(Value::Array(
                s.split(sep).map(|p| Value::String(p.to_owned())).collect(),
            ))
        }
        "lines" => {
            arity(name, args, 1, 1)?;
            let s = str_arg(name, &args[0])?;
            let normalized = s.replace("\r\n", "\n").replace('\r', "\n");
            let body = normalized.strip_suffix('\n').unwrap_or(&normalized);
            if body.is_empty() {
                return Ok(Value::Array(Vec::new()));
            }
            Ok(Value::Array(
                body.split('\n')
                    .map(|l| Value::String(l.to_owned()))
                    .collect(),
            ))
        }
        "join" => {
            arity(name, args, 2, 2)?;
            let items = list_arg(name, &args[0])?;
            let sep = str_arg(name, &args[1])?;
            text(items.iter().map(to_display).collect::<Vec<_>>().join(sep))
        }
        "toHalfWidth" => {
            arity(name, args, 1, 1)?;
            text(width::to_half(str_arg(name, &args[0])?))
        }
        "toFullWidth" => {
            arity(name, args, 1, 1)?;
            text(width::to_full(str_arg(name, &args[0])?))
        }
        "str" => {
            arity(name, args, 1, 1)?;
            text(to_display(&args[0]))
        }
        "formatNumber" => {
            arity(name, args, 1, 2)?;
            let n = num_arg(name, &args[0])?;
            let decimals = match args.get(1) {
                None => 0,
                Some(d) => usize::try_from(int_arg(name, d)?.clamp(0, 10)).unwrap_or(0),
            };
            text(format_number(n, decimals))
        }
        "regexTest" => {
            arity(name, args, 2, 2)?;
            let re = regex(str_arg(name, &args[1])?)?;
            Ok(Value::Bool(re.is_match(str_arg(name, &args[0])?)))
        }
        "regexFind" => {
            arity(name, args, 2, 3)?;
            let re = regex(str_arg(name, &args[1])?)?;
            match re.captures(str_arg(name, &args[0])?) {
                Some(caps) => group_text(&caps, args.get(2)),
                None => Ok(Value::Null),
            }
        }
        "regexFindAll" => {
            arity(name, args, 2, 3)?;
            let re = regex(str_arg(name, &args[1])?)?;
            re.captures_iter(str_arg(name, &args[0])?)
                .map(|caps| group_text(&caps, args.get(2)))
                .collect::<Result<Vec<_>, _>>()
                .map(Value::Array)
        }
        "regexReplace" => {
            arity(name, args, 3, 3)?;
            let re = regex(str_arg(name, &args[1])?)?;
            let with = to_display(&args[2]);
            text(
                re.replace_all(str_arg(name, &args[0])?, with.as_str())
                    .into_owned(),
            )
        }
        "num" => {
            arity(name, args, 1, 1)?;
            match &args[0] {
                Value::Number(_) => Ok(args[0].clone()),
                Value::String(s) => {
                    let cleaned = width::to_half(s.trim()).replace(',', "");
                    cleaned
                        .parse::<f64>()
                        .map(number)
                        .map_err(|_| type_err(format!("num() cannot parse '{s}'")))
                }
                Value::Bool(b) => Ok(Value::from(u8::from(*b))),
                other => Err(type_err(format!("num() of {}", type_name(other)))),
            }
        }
        "round" => {
            arity(name, args, 1, 2)?;
            let x = num_arg(name, &args[0])?;
            let digits = match args.get(1) {
                None => 0,
                Some(d) => Some(int_arg(name, d)?)
                    .filter(|d| (0..=10).contains(d))
                    .ok_or_else(|| type_err("round() digits must be 0-10"))?,
            };
            let scale = 10f64.powi(i32::try_from(digits).unwrap_or(0));
            Ok(number((x * scale).round() / scale))
        }
        "floor" | "ceil" | "abs" => {
            arity(name, args, 1, 1)?;
            let x = num_arg(name, &args[0])?;
            Ok(number(match name {
                "floor" => x.floor(),
                "ceil" => x.ceil(),
                _ => x.abs(),
            }))
        }
        "min" | "max" => min_max(name, args),
        "sum" | "avg" => {
            arity(name, args, 1, 1)?;
            let items = list_arg(name, &args[0])?;
            let mut total = 0.0;
            let mut count = 0u32;
            for item in items {
                match item {
                    Value::Number(n) => {
                        total += n.as_f64().unwrap_or(0.0);
                        count += 1;
                    }
                    Value::Null => {}
                    other => {
                        return Err(type_err(format!(
                            "{name}() of a list containing {} (convert text with num())",
                            type_name(other)
                        )));
                    }
                }
            }
            if name == "sum" {
                Ok(number(total))
            } else if count == 0 {
                Ok(Value::Null)
            } else {
                Ok(number(total / f64::from(count)))
            }
        }
        "sort" => {
            arity(name, args, 1, 1)?;
            let mut items = list_arg(name, &args[0])?.clone();
            items.sort_by(compare);
            Ok(Value::Array(items))
        }
        "reverse" => {
            arity(name, args, 1, 1)?;
            match &args[0] {
                Value::Array(items) => Ok(Value::Array(items.iter().rev().cloned().collect())),
                Value::String(s) => text(s.chars().rev().collect()),
                other => Err(type_err(format!("reverse() of {}", type_name(other)))),
            }
        }
        "unique" => {
            arity(name, args, 1, 1)?;
            let mut out: Vec<Value> = Vec::new();
            for item in list_arg(name, &args[0])? {
                if !out.iter().any(|seen| loose_eq(seen, item)) {
                    out.push(item.clone());
                }
            }
            Ok(Value::Array(out))
        }
        "range" => {
            arity(name, args, 1, 2)?;
            let (start, end) = match args {
                [count] => (0, int_arg(name, count)?),
                _ => (int_arg(name, &args[0])?, int_arg(name, &args[1])?),
            };
            if end.saturating_sub(start) > 100_000 {
                return Err(type_err("range() is limited to 100000 numbers"));
            }
            Ok(Value::Array((start..end).map(Value::from).collect()))
        }
        "keys" | "values" => {
            arity(name, args, 1, 1)?;
            let Value::Object(map) = &args[0] else {
                return Err(type_err(format!(
                    "{name}() expects an object, got {}",
                    type_name(&args[0])
                )));
            };
            Ok(Value::Array(if name == "keys" {
                map.keys().cloned().map(Value::String).collect()
            } else {
                map.values().cloned().collect()
            }))
        }
        "merge" => {
            if args.is_empty() {
                return Err(usage(name));
            }
            let mut out = Map::new();
            for arg in args {
                match arg {
                    Value::Object(map) => out.extend(map.clone()),
                    Value::Null => {}
                    other => {
                        return Err(type_err(format!("merge() of {}", type_name(other))));
                    }
                }
            }
            Ok(Value::Object(out))
        }
        "now" => {
            arity(name, args, 0, 0)?;
            text(date::now().to_text())
        }
        "today" => {
            arity(name, args, 0, 0)?;
            text(date::today().to_text())
        }
        "formatDate" => {
            arity(name, args, 2, 2)?;
            text(date::format(
                date_arg(name, &args[0])?,
                str_arg(name, &args[1])?,
            )?)
        }
        "parseDate" => {
            arity(name, args, 1, 2)?;
            let source = str_arg(name, &args[0])?;
            let when = match args.get(1) {
                Some(p) => date::parse_with(source, str_arg(name, p)?)?,
                None => date::parse(source)?,
            };
            text(when.to_text())
        }
        "dateAdd" => {
            arity(name, args, 3, 3)?;
            let when = date_arg(name, &args[0])?;
            let amount = int_arg(name, &args[1])?;
            text(date::add(when, amount, str_arg(name, &args[2])?)?.to_text())
        }
        "dateDiff" => {
            arity(name, args, 3, 3)?;
            let from = date_arg(name, &args[0])?;
            let to = date_arg(name, &args[1])?;
            Ok(Value::from(date::diff(from, to, str_arg(name, &args[2])?)?))
        }
        "endOfMonth" => {
            arity(name, args, 1, 1)?;
            text(date::end_of_month(date_arg(name, &args[0])?).to_text())
        }
        "pathJoin" => {
            if args.len() < 2 {
                return Err(usage(name));
            }
            let mut out = String::new();
            for part in args {
                let part = str_arg(name, part)?;
                if part.is_empty() {
                    continue;
                }
                if out.is_empty() || out.ends_with(is_separator) {
                    out.push_str(part);
                } else {
                    out.push(std::path::MAIN_SEPARATOR);
                    out.push_str(part.trim_start_matches(is_separator));
                }
            }
            text(out)
        }
        "dirName" | "fileName" | "baseName" | "extName" => {
            arity(name, args, 1, 1)?;
            let (dir, file) = split_path(str_arg(name, &args[0])?);
            let (base, ext) = split_ext(file);
            text(
                match name {
                    "dirName" => dir,
                    "fileName" => file,
                    "baseName" => base,
                    _ => ext,
                }
                .to_owned(),
            )
        }
        "parseJson" => {
            arity(name, args, 1, 1)?;
            serde_json::from_str(str_arg(name, &args[0])?)
                .map_err(|e| type_err(format!("parseJson(): {e}")))
        }
        "toJson" => {
            arity(name, args, 1, 2)?;
            let pretty = args.get(1).is_some_and(truthy);
            let out = if pretty {
                serde_json::to_string_pretty(&args[0])
            } else {
                serde_json::to_string(&args[0])
            };
            out.map(Value::String)
                .map_err(|e| type_err(format!("toJson(): {e}")))
        }
        "isEmpty" => {
            arity(name, args, 1, 1)?;
            Ok(Value::Bool(
                !truthy(&args[0]) && !matches!(args[0], Value::Bool(false) | Value::Number(_)),
            ))
        }
        "coalesce" => Ok(args
            .iter()
            .find(|v| !v.is_null())
            .cloned()
            .unwrap_or(Value::Null)),
        "env" => {
            arity(name, args, 1, 1)?;
            Ok(std::env::var(str_arg(name, &args[0])?).map_or(Value::Null, Value::String))
        }
        other => Err(ExprError::UnknownFunction(other.to_owned())),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::evaluate;
    use super::*;

    fn ev(src: &str) -> Value {
        let scope = json!({
            "rows": [
                { "name": "A", "amount": "1,200", "dept": "営業" },
                { "name": "B", "amount": "300", "dept": "経理" },
                { "name": "C", "amount": "5,000", "dept": "営業" },
            ],
            "limit": 1000,
        });
        let scope = scope.as_object().cloned().unwrap_or_default();
        match evaluate(src, &scope) {
            Ok(v) => v,
            Err(e) => panic!("{src}: {e}"),
        }
    }

    #[test]
    fn every_function_is_documented_and_dispatched() {
        for d in FUNCTION_DOCS {
            let src = format!("{}()", d.name);
            let result = if HIGHER_ORDER.contains(&d.name) {
                super::super::Expr::parse(&format!("{}([], x => x)", d.name))
                    .and_then(|e| e.eval(&Map::new()))
            } else {
                evaluate(&src, &Map::new())
            };
            assert!(
                !matches!(result, Err(ExprError::UnknownFunction(_))),
                "{} is documented but not implemented",
                d.name
            );
        }
        let mut names: Vec<_> = function_names().collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), FUNCTION_DOCS.len());
        let reference = include_str!("../../../../docs/expressions.md");
        for d in FUNCTION_DOCS {
            assert!(
                reference.contains(&format!("| `{}", d.signature)),
                "docs/expressions.md lacks {}",
                d.name
            );
        }
    }

    #[test]
    fn text() {
        assert_eq!(ev("replace('2026/10/28', '/', '-')"), json!("2026-10-28"));
        assert_eq!(ev("slice('ABC-123', 4)"), json!("123"));
        assert_eq!(ev("slice('ABC-123', 0, 3)"), json!("ABC"));
        assert_eq!(ev("slice('東京都港区', -2)"), json!("港区"));
        assert_eq!(ev("slice([1, 2, 3], 1, -1)"), json!([2]));
        assert_eq!(ev("slice('abc', 5)"), json!(""));
        assert_eq!(ev("indexOf('東京-港', '-')"), json!(2));
        assert_eq!(ev("indexOf([1, 2], 3)"), json!(-1));
        assert_eq!(ev("padStart(7, 3, '0')"), json!("007"));
        assert_eq!(ev("padEnd('A', 3, '*')"), json!("A**"));
        assert_eq!(ev("padStart('1234', 3, '0')"), json!("1234"));
        assert_eq!(ev("trim('　山田 ')"), json!("山田"));
        assert_eq!(ev("trimStart('  a ')"), json!("a "));
        assert_eq!(ev("lines('a\\r\\nb\\n')"), json!(["a", "b"]));
        assert_eq!(ev("lines('')"), json!([]));
        assert_eq!(ev("toHalfWidth('ＡＢ１　カナ')"), json!("AB1 ｶﾅ"));
        assert_eq!(ev("num('１，２００')"), json!(1200));
        assert_eq!(ev("formatNumber(1234567.891, 2)"), json!("1,234,567.89"));
        assert_eq!(ev("formatNumber(-1000)"), json!("-1,000"));
        assert_eq!(ev("formatNumber(999.5)"), json!("1,000"));
        assert_eq!(ev("'様' + 'A' + 1"), json!("様A1"));
    }

    #[test]
    fn regex_functions() {
        assert_eq!(ev("regexTest('ABC-12', '^[A-Z]{3}-\\\\d+$')"), json!(true));
        assert_eq!(
            ev("regexFind('番号: INV-0042', 'INV-(\\\\d+)', 1)"),
            json!("0042")
        );
        assert_eq!(ev("regexFind('x', '\\\\d')"), Value::Null);
        assert_eq!(
            ev("regexFind('2026-10', '(?P<y>\\\\d{4})-(?P<m>\\\\d+)', 'm')"),
            json!("10")
        );
        assert_eq!(ev("regexFindAll('a1 b22', '\\\\d+')"), json!(["1", "22"]));
        assert_eq!(
            ev("regexReplace('090-1234-5678', '\\\\D', '')"),
            json!("09012345678")
        );
        assert_eq!(
            ev("regexReplace('山田 太郎', '(\\\\S+) (\\\\S+)', '$2 $1')"),
            json!("太郎 山田")
        );
        assert!(evaluate("regexTest('a', '(')", &Map::new()).is_err());
    }

    #[test]
    fn numbers_and_lists() {
        assert_eq!(ev("floor(2.7) + ceil(2.1) + abs(-5)"), json!(10));
        assert_eq!(ev("min([3, null, 1])"), json!(1));
        assert_eq!(ev("max(limit, 2000)"), json!(2000));
        assert_eq!(ev("max([])"), Value::Null);
        assert_eq!(ev("avg([1, 2, 6])"), json!(3));
        assert_eq!(ev("sum(map(rows, r => num(r.amount)))"), json!(6500));
        assert_eq!(
            ev("map(filter(rows, r => num(r.amount) >= limit), r => r.name)"),
            json!(["A", "C"])
        );
        assert_eq!(ev("find(rows, r => r.name == 'B').amount"), json!("300"));
        assert_eq!(ev("find(rows, r => r.name == 'Z')"), Value::Null);
        assert_eq!(ev("some(rows, r => r.dept == '経理')"), json!(true));
        assert_eq!(ev("every([], r => false)"), json!(true));
        assert_eq!(
            ev("map(reverse(sortBy(rows, r => num(r.amount))), r => r.name)"),
            json!(["C", "A", "B"])
        );
        assert_eq!(
            ev("keys(groupBy(rows, r => r.dept))"),
            json!(["営業", "経理"])
        );
        assert_eq!(ev("len(groupBy(rows, r => r.dept)['営業'])"), json!(2));
        assert_eq!(ev("sort(['b', 'a'])"), json!(["a", "b"]));
        assert_eq!(ev("unique([1, 1.0, 2])"), json!([1, 2]));
        assert_eq!(ev("range(2, 5)"), json!([2, 3, 4]));
        assert_eq!(
            ev("map(rows, r => { n: r.name, ok: true })[0]"),
            json!({ "n": "A", "ok": true })
        );
        assert_eq!(
            ev("merge(rows[0], { amount: 0, memo: '済' })"),
            json!({ "name": "A", "amount": 0, "dept": "営業", "memo": "済" })
        );
        assert_eq!(ev("values({ a: 1, 'b c': 2 })"), json!([1, 2]));
        assert_eq!(ev("{ A: '甲', B: '乙' }[rows[1].name]"), json!("乙"));
        // The lambda parameter shadows a variable of the same name.
        assert_eq!(ev("map([1, 2], limit => limit * 2)"), json!([2, 4]));
    }

    #[test]
    fn dates_paths_json() {
        assert_eq!(
            ev("formatDate('2026-10-28', 'gge年M月d日(ddd)')"),
            json!("令和8年10月28日(水)")
        );
        assert_eq!(
            ev("parseDate('2026/10/28 9:05')"),
            json!("2026-10-28T09:05:00")
        );
        assert_eq!(
            ev("dateAdd('2026-10-28', -1, 'month')"),
            json!("2026-09-28")
        );
        assert_eq!(ev("dateDiff('2026-10-01', '2026-10-28', 'day')"), json!(27));
        assert_eq!(ev("endOfMonth('2026-02-01')"), json!("2026-02-28"));
        assert!(
            regex::Regex::new(r"^\d{4}-\d{2}-\d{2}$")
                .unwrap()
                .is_match(ev("today()").as_str().unwrap())
        );
        assert!(
            regex::Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$")
                .unwrap()
                .is_match(ev("now()").as_str().unwrap())
        );
        assert_eq!(
            ev("fileName('C:\\\\data\\\\請求書.xlsx')"),
            json!("請求書.xlsx")
        );
        assert_eq!(ev("baseName('C:\\\\data\\\\請求書.xlsx')"), json!("請求書"));
        assert_eq!(ev("extName('/tmp/a.tar.gz')"), json!(".gz"));
        assert_eq!(ev("dirName('C:\\\\data\\\\a.csv')"), json!("C:\\data"));
        assert_eq!(ev("dirName('C:\\\\a.csv')"), json!("C:\\"));
        assert_eq!(ev("extName('.env')"), json!(""));
        let sep = std::path::MAIN_SEPARATOR;
        assert_eq!(
            ev("pathJoin('out', 'a.csv')"),
            json!(format!("out{sep}a.csv"))
        );
        assert_eq!(
            ev("pathJoin('C:\\\\out\\\\', 'a.csv')"),
            json!("C:\\out\\a.csv")
        );
        assert_eq!(ev("parseJson('{\"a\": [1]}').a[0]"), json!(1));
        assert_eq!(ev("toJson({ a: 1 })"), json!("{\"a\":1}"));
        assert_eq!(
            ev("coalesce(env('SHIKIGAMI_SURELY_UNSET_VAR'), 'x')"),
            json!("x")
        );
    }

    #[test]
    fn lambdas_are_checked_when_parsing() {
        use super::super::Expr;
        assert!(Expr::parse("map(rows, 1)").is_err());
        assert!(Expr::parse("map(rows)").is_err());
        assert!(Expr::parse("len(x => x)").is_err());
        assert!(Expr::parse("x => x").is_err());
        let vars = Expr::parse("filter(rows, r => r.a > limit)")
            .unwrap()
            .variables();
        assert_eq!(vars.into_iter().collect::<Vec<_>>(), ["limit", "rows"]);
    }
}

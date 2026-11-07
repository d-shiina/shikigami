//! What an expression's author most likely meant, when they wrote it the way
//! another language does (JavaScript, Excel, Python, SQL). AIs that write a
//! flow without the tools (a chat window) fall into these habits; the hint
//! names the habit and the Shikigami way, so the fix is one edit.

use super::FUNCTION_DOCS;

/// Functions of other languages that have a Shikigami function under a
/// name too far for a typo match (`toUpperCase` → `upper`).
const ALIASES: &[(&str, &str)] = &[
    ("length", "len"),
    ("count", "len"),
    ("size", "len"),
    ("strlen", "len"),
    ("toupper", "upper"),
    ("touppercase", "upper"),
    ("ucase", "upper"),
    ("tolower", "lower"),
    ("tolowercase", "lower"),
    ("lcase", "lower"),
    ("substring", "slice"),
    ("substr", "slice"),
    ("mid", "slice"),
    ("left", "slice"),
    ("right", "slice"),
    ("includes", "contains"),
    ("instr", "indexOf"),
    ("search", "indexOf"),
    ("tostring", "str"),
    ("string", "str"),
    ("text", "str"),
    ("cstr", "str"),
    ("number", "num"),
    ("parseint", "num"),
    ("parsefloat", "num"),
    ("int", "num"),
    ("float", "num"),
    ("value", "num"),
    ("cint", "num"),
    ("average", "avg"),
    ("mean", "avg"),
    ("concat", "join"),
    ("concatenate", "join"),
    ("textjoin", "join"),
    ("isnull", "isEmpty"),
    ("isblank", "isEmpty"),
    ("ifnull", "coalesce"),
    ("nvl", "coalesce"),
    ("ifempty", "coalesce"),
    ("date", "today"),
    ("datediff", "dateDiff"),
    ("dateadd", "dateAdd"),
    ("eomonth", "endOfMonth"),
    ("tofixed", "formatNumber"),
    ("format", "formatDate"),
    ("strftime", "formatDate"),
    ("todate", "parseDate"),
    ("datevalue", "parseDate"),
    ("json", "parseJson"),
    ("stringify", "toJson"),
];

/// The hint for an unknown function `name`: the Shikigami function it most
/// likely stands for, with how to write it. `None` when nothing fits.
pub fn unknown_function_hint(name: &str) -> Option<String> {
    let lower = name.to_lowercase();
    if matches!(
        lower.as_str(),
        "if" | "iif" | "iff" | "ifs" | "switch" | "choose"
    ) {
        return Some(format!(
            "There is no {name}() in expressions. For a default when a value is empty use coalesce(value, 'default'); to do different things by a condition use a control.if node (or control.switch to choose by a value)."
        ));
    }
    let target = ALIASES
        .iter()
        .find(|(alias, _)| *alias == lower)
        .map(|(_, to)| *to)?;
    Some(format!(
        "Use {target}() instead of {name}(). {}",
        describe(target)?
    ))
}

/// `len(x): Number of characters …  e.g. len('東京都') → 3`
pub fn describe(function: &str) -> Option<String> {
    let doc = FUNCTION_DOCS.iter().find(|d| d.name == function)?;
    Some(format!(
        "{}: {} e.g. {}",
        doc.signature, doc.description, doc.example
    ))
}

/// The habit from another language in `src`, with the Shikigami way.
/// `template` is true for a template setting (`"… {{ x }} …"`), false for
/// an expression setting (a bare expression).
pub fn mistake_hint(src: &str, template: bool) -> Option<String> {
    // In a template only the parts inside {{ }} are code.
    let scope = if template {
        inner_parts(src)
    } else {
        src.to_owned()
    };
    let code = code_only(&scope);
    let trimmed = code.trim_start();
    let mut found = Vec::new();
    if template && src.contains("${") {
        found.push("Embed values with {{ name }}, not ${name}.".to_owned());
    }
    if !template && trimmed.starts_with('=') && !trimmed.starts_with("==") {
        found.push(
            "Remove the leading '=': an expression is not an Excel formula (write sum(list), not =SUM(A1:A3)).".to_owned(),
        );
    }
    if code.contains("===") || code.contains("!==") {
        found.push("Compare with == and != (there is no === or !==).".to_owned());
    } else if single_equals(&code) {
        found.push(
            "Compare with ==, not = (to set a variable, use a variable.set node).".to_owned(),
        );
    }
    if code.contains("<>") {
        found.push("Write 'not equal' as != (not <>).".to_owned());
    }
    let words: Vec<String> = code
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .map(str::to_lowercase)
        .collect();
    let has = |w: &str| words.iter().any(|x| x == w);
    if has("and") || has("or") || has("not") {
        found.push("Combine conditions with &&, || and ! (not and, or, not).".to_owned());
    }
    if single_amp(&code) {
        found.push("Join text with +, not & (e.g. name + '様').".to_owned());
    }
    if code.contains("??") {
        found.push("For a default use coalesce(value, 'default') (there is no ??).".to_owned());
    } else if code.contains('?') {
        found.push(
            "There is no a ? b : c. For a default use coalesce(value, 'default'); to do different things by a condition use a control.if node.".to_owned(),
        );
    }
    if let Some(method) = method_call(&code) {
        let function = ALIASES
            .iter()
            .find(|(alias, _)| *alias == method.to_lowercase())
            .map(|(_, to)| (*to).to_owned())
            .or_else(|| {
                FUNCTION_DOCS
                    .iter()
                    .find(|d| d.name.eq_ignore_ascii_case(&method))
                    .map(|d| d.name.to_owned())
            });
        found.push(match function {
            Some(f) => format!(
                "Functions are not methods: write {f}(x), not x.{method}(). {}",
                describe(&f).unwrap_or_default()
            ),
            None => format!("Functions are not methods: there is no x.{method}(); call a function with the value as its first argument, e.g. trim(x)."),
        });
    }
    if scope.chars().any(|c| matches!(c, '‘' | '’' | '“' | '”')) {
        found.push("Use straight quotes ' or \" around text, not ‘ ’ or “ ”.".to_owned());
    }
    if code.chars().any(|c| {
        matches!(
            c,
            '（' | '）' | '＝' | '＋' | '，' | '＜' | '＞' | '！' | '＆' | '｜'
        )
    }) {
        found.push(
            "Write operators, brackets and commas half-width ((, ), =, +, ,), not full-width."
                .to_owned(),
        );
    }
    (!found.is_empty()).then(|| found.join(" "))
}

/// The code of a template: what is inside each `{{ }}`, one per line.
fn inner_parts(src: &str) -> String {
    let mut out = Vec::new();
    let mut rest = src;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        let end = after.find("}}").unwrap_or(after.len());
        out.push(&after[..end]);
        rest = after.get(end + 2..).unwrap_or("");
    }
    out.join("\n")
}

/// `src` with the inside of string literals blanked out, so `'a = b'` is
/// not read as code.
fn code_only(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for c in src.chars() {
        match quote {
            Some(q) => {
                if escaped {
                    escaped = false;
                    out.push(' ');
                } else if c == '\\' {
                    escaped = true;
                    out.push(' ');
                } else if c == q {
                    quote = None;
                    out.push(c);
                } else {
                    out.push(' ');
                }
            }
            None => {
                if c == '\'' || c == '"' {
                    quote = Some(c);
                }
                out.push(c);
            }
        }
    }
    out
}

/// An `=` that is not part of `==`, `!=`, `<=`, `>=` or `=>`, after the
/// first character (a leading `=` is the Excel habit).
fn single_equals(code: &str) -> bool {
    let chars: Vec<char> = code.trim_start().chars().collect();
    (1..chars.len()).any(|i| {
        chars[i] == '='
            && !matches!(chars[i - 1], '=' | '!' | '<' | '>')
            && !matches!(chars.get(i + 1), Some('=' | '>'))
    })
}

/// An `&` that is not part of `&&`.
fn single_amp(code: &str) -> bool {
    let chars: Vec<char> = code.chars().collect();
    (0..chars.len()).any(|i| {
        chars[i] == '&' && chars.get(i + 1) != Some(&'&') && (i == 0 || chars[i - 1] != '&')
    })
}

/// `x.name(` → `name`.
fn method_call(code: &str) -> Option<String> {
    let chars: Vec<char> = code.chars().collect();
    for (i, c) in chars.iter().enumerate() {
        if *c != '.' || i == 0 {
            continue;
        }
        // Not a decimal point.
        if chars[i - 1].is_ascii_digit() && chars.get(i + 1).is_some_and(char::is_ascii_digit) {
            continue;
        }
        let name: String = chars[i + 1..]
            .iter()
            .take_while(|c| c.is_alphanumeric() || **c == '_')
            .collect();
        if name.is_empty() {
            continue;
        }
        let after = chars[i + 1 + name.chars().count()..]
            .iter()
            .find(|c| !c.is_whitespace());
        if after == Some(&'(') {
            return Some(name);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hint(src: &str) -> String {
        mistake_hint(src, false).unwrap_or_default()
    }

    #[test]
    fn names_the_habit_of_another_language() {
        assert!(hint("status === '済'").contains("=="));
        assert!(hint("count = 3").contains("Compare with =="));
        assert!(hint("=SUM(A1:A3)").contains("leading '='"));
        assert!(hint("a > 1 and b < 2").contains("&&"));
        assert!(hint("name & '様'").contains("+"));
        assert!(hint("x > 0 ? 'a' : 'b'").contains("coalesce"));
        assert!(hint("name ?? '未入力'").contains("coalesce"));
        assert!(hint("name.trim()").contains("trim(x)"));
        assert!(hint("name.toUpperCase()").contains("upper(x)"));
        assert!(hint("a <> b").contains("!="));
        assert!(hint("len（items）").contains("half-width"));
        assert!(hint("‘済’").contains("straight quotes"));
        assert!(
            mistake_hint("合計 ${total} 円", true)
                .unwrap_or_default()
                .contains("{{ name }}")
        );
    }

    #[test]
    fn leaves_correct_expressions_alone() {
        for src in [
            "count == 3",
            "a != b && c <= 2 || d >= 1",
            "!done",
            "map(items, x => x.price)",
            "name + '様'",
            "'a = b & c ? d'",
            "len(items) > 0",
            "price * 1.08",
            "row['length']",
            // x.length works for lists and text.
            "items.length > 0",
        ] {
            assert_eq!(mistake_hint(src, false), None, "{src}");
        }
        assert_eq!(mistake_hint("合計 {{ total }} 円", true), None);
        // Text around {{ }} is not code.
        assert_eq!(
            mistake_hint("税込 = {{ price * 1.1 }} & 送料 ?", true),
            None
        );
        assert!(
            mistake_hint("{{ a = 1 }}", true)
                .unwrap_or_default()
                .contains("==")
        );
    }

    #[test]
    fn unknown_functions_point_to_ours() {
        assert!(
            unknown_function_hint("toUpperCase")
                .unwrap()
                .contains("upper()")
        );
        assert!(unknown_function_hint("IF").unwrap().contains("control.if"));
        assert!(
            unknown_function_hint("substring")
                .unwrap()
                .contains("slice(x, start")
        );
        assert_eq!(unknown_function_hint("frobnicate"), None);
        for (_, to) in ALIASES {
            assert!(describe(to).is_some(), "{to} is not a function");
        }
    }
}

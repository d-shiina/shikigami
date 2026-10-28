//! A small, side-effect-free expression language for conditions and templates.
//!
//! Scenarios must never execute arbitrary code (scenarios can be written by AI
//! from untrusted page content), so instead of embedding a scripting engine we
//! evaluate a tiny, total language over JSON values:
//!
//! - literals: `1`, `2.5`, `'text'`, `"text"`, `true`, `false`, `null`, `[1, 2]`
//! - variables and paths: `user.name`, `items[0]`, `row['列名']`
//! - operators: `!` `-` `*` `/` `%` `+` `-` `<` `<=` `>` `>=` `==` `!=` `&&` `||`
//! - whitelisted pure functions: see [`FUNCTIONS`]
//!
//! Templates embed expressions in strings: `"こんにちは {{ user.name }}"`.
//! A string that is exactly one `{{ … }}` evaluates to the typed value.

use std::collections::BTreeSet;
use std::fmt;

use serde_json::{Map, Number, Value};

/// Names of the built-in functions (all pure).
pub const FUNCTIONS: &[&str] = &[
    "len",
    "contains",
    "startsWith",
    "endsWith",
    "lower",
    "upper",
    "trim",
    "str",
    "num",
    "isEmpty",
    "coalesce",
    "join",
    "split",
];

const MAX_DEPTH: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ExprError {
    #[error("syntax error at {pos}: {message}")]
    Syntax { pos: usize, message: String },
    #[error("undefined variable: {0}")]
    UndefinedVariable(String),
    #[error("unknown function: {0}")]
    UnknownFunction(String),
    #[error("type error: {0}")]
    Type(String),
}

impl ExprError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Syntax { .. } => "EXPR_SYNTAX",
            Self::UndefinedVariable(_) => "EXPR_UNDEFINED_VARIABLE",
            Self::UnknownFunction(_) => "EXPR_UNKNOWN_FUNCTION",
            Self::Type(_) => "EXPR_TYPE",
        }
    }
}

/// Variable lookup used during evaluation.
pub trait Scope {
    fn get(&self, name: &str) -> Option<&Value>;
}

impl Scope for Map<String, Value> {
    fn get(&self, name: &str) -> Option<&Value> {
        Map::get(self, name)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    Literal(Value),
    Var(String),
    List(Vec<Expr>),
    Member(Box<Expr>, String),
    Index(Box<Expr>, Box<Expr>),
    Call(String, Vec<Expr>),
    Unary(UnaryOp, Box<Expr>),
    Binary(BinaryOp, Box<Expr>, Box<Expr>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnaryOp {
    Not,
    Neg,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinaryOp {
    Or,
    And,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    Add,
    Sub,
    Mul,
    Div,
    Rem,
}

impl Expr {
    /// Parses an expression.
    pub fn parse(source: &str) -> Result<Self, ExprError> {
        let tokens = tokenize(source)?;
        let mut parser = Parser {
            tokens,
            pos: 0,
            depth: 0,
        };
        let expr = parser.expr()?;
        match parser.peek() {
            Tok::Eof => Ok(expr),
            other => Err(parser.error(format!("unexpected token {other}"))),
        }
    }

    /// Evaluates the expression against a scope.
    pub fn eval(&self, scope: &dyn Scope) -> Result<Value, ExprError> {
        eval(self, scope)
    }

    /// Root variable names referenced by the expression.
    pub fn variables(&self) -> BTreeSet<String> {
        let mut out = BTreeSet::new();
        collect_vars(self, &mut out);
        out
    }
}

/// Parses and evaluates an expression in one go.
pub fn evaluate(source: &str, scope: &dyn Scope) -> Result<Value, ExprError> {
    Expr::parse(source)?.eval(scope)
}

/// JavaScript-like truthiness: `null`, `false`, `0`, `""`, `[]`, `{}` are false.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// Converts a value to its display string (strings unquoted).
pub fn to_display(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Templates

/// A parsed template string.
#[derive(Debug, Clone, PartialEq)]
pub struct Template {
    parts: Vec<Part>,
}

#[derive(Debug, Clone, PartialEq)]
enum Part {
    Text(String),
    Expr(Expr),
}

impl Template {
    pub fn parse(source: &str) -> Result<Self, ExprError> {
        let mut parts = Vec::new();
        let mut rest = source;
        let mut offset = 0;
        while let Some(start) = rest.find("{{") {
            if start > 0 {
                parts.push(Part::Text(rest[..start].to_owned()));
            }
            let after = &rest[start + 2..];
            let end = after.find("}}").ok_or(ExprError::Syntax {
                pos: offset + start,
                message: "unterminated '{{'".into(),
            })?;
            let inner = &after[..end];
            let expr = Expr::parse(inner).map_err(|e| match e {
                ExprError::Syntax { pos, message } => ExprError::Syntax {
                    pos: offset + start + 2 + pos,
                    message,
                },
                other => other,
            })?;
            parts.push(Part::Expr(expr));
            let consumed = start + 2 + end + 2;
            offset += consumed;
            rest = &rest[consumed..];
        }
        if !rest.is_empty() {
            parts.push(Part::Text(rest.to_owned()));
        }
        Ok(Self { parts })
    }

    /// True when the template contains at least one expression.
    pub fn is_dynamic(&self) -> bool {
        self.parts.iter().any(|p| matches!(p, Part::Expr(_)))
    }

    pub fn render(&self, scope: &dyn Scope) -> Result<Value, ExprError> {
        if let [Part::Expr(expr)] = self.parts.as_slice() {
            return expr.eval(scope);
        }
        let mut out = String::new();
        for part in &self.parts {
            match part {
                Part::Text(t) => out.push_str(t),
                Part::Expr(e) => out.push_str(&to_display(&e.eval(scope)?)),
            }
        }
        Ok(Value::String(out))
    }

    pub fn variables(&self) -> BTreeSet<String> {
        let mut out = BTreeSet::new();
        for part in &self.parts {
            if let Part::Expr(e) = part {
                collect_vars(e, &mut out);
            }
        }
        out
    }
}

/// Recursively renders every template string inside a JSON value.
pub fn render_value(value: &Value, scope: &dyn Scope) -> Result<Value, ExprError> {
    match value {
        Value::String(s) if s.contains("{{") => Template::parse(s)?.render(scope),
        Value::Array(items) => items
            .iter()
            .map(|v| render_value(v, scope))
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        Value::Object(map) => map
            .iter()
            .map(|(k, v)| Ok((k.clone(), render_value(v, scope)?)))
            .collect::<Result<Map<_, _>, _>>()
            .map(Value::Object),
        other => Ok(other.clone()),
    }
}

/// Visits every template string inside a JSON value (used by validation).
pub fn visit_templates(value: &Value, f: &mut dyn FnMut(Result<Template, ExprError>)) {
    match value {
        Value::String(s) if s.contains("{{") => f(Template::parse(s)),
        Value::Array(items) => items.iter().for_each(|v| visit_templates(v, f)),
        Value::Object(map) => map.values().for_each(|v| visit_templates(v, f)),
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Tokenizer

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(f64),
    Str(String),
    Ident(String),
    Op(&'static str),
    Eof,
}

impl fmt::Display for Tok {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Tok::Num(n) => write!(f, "{n}"),
            Tok::Str(s) => write!(f, "'{s}'"),
            Tok::Ident(s) => write!(f, "{s}"),
            Tok::Op(s) => write!(f, "'{s}'"),
            Tok::Eof => write!(f, "end of expression"),
        }
    }
}

const OPS: &[&str] = &[
    "&&", "||", "==", "!=", "<=", ">=", "<", ">", "+", "-", "*", "/", "%", "!", "(", ")", "[", "]",
    ".", ",",
];

fn tokenize(source: &str) -> Result<Vec<(usize, Tok)>, ExprError> {
    let mut tokens = Vec::new();
    let chars: Vec<(usize, char)> = source.char_indices().collect();
    let mut i = 0;
    while i < chars.len() {
        let (pos, c) = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c.is_ascii_digit() {
            let start = i;
            while i < chars.len() && (chars[i].1.is_ascii_digit() || chars[i].1 == '.') {
                i += 1;
            }
            let end = chars.get(i).map_or(source.len(), |(p, _)| *p);
            let text = &source[pos..end];
            let n = text.parse::<f64>().map_err(|_| ExprError::Syntax {
                pos,
                message: format!("invalid number '{text}'"),
            })?;
            debug_assert!(i > start);
            tokens.push((pos, Tok::Num(n)));
            continue;
        }
        if c == '\'' || c == '"' {
            let quote = c;
            let mut s = String::new();
            i += 1;
            loop {
                let Some(&(_, ch)) = chars.get(i) else {
                    return Err(ExprError::Syntax {
                        pos,
                        message: "unterminated string".into(),
                    });
                };
                i += 1;
                match ch {
                    '\\' => {
                        let Some(&(_, esc)) = chars.get(i) else {
                            return Err(ExprError::Syntax {
                                pos,
                                message: "unterminated escape".into(),
                            });
                        };
                        i += 1;
                        s.push(match esc {
                            'n' => '\n',
                            't' => '\t',
                            other => other,
                        });
                    }
                    ch if ch == quote => break,
                    ch => s.push(ch),
                }
            }
            tokens.push((pos, Tok::Str(s)));
            continue;
        }
        if c.is_alphabetic() || c == '_' {
            let start = pos;
            while i < chars.len() && (chars[i].1.is_alphanumeric() || chars[i].1 == '_') {
                i += 1;
            }
            let end = chars.get(i).map_or(source.len(), |(p, _)| *p);
            tokens.push((pos, Tok::Ident(source[start..end].to_owned())));
            continue;
        }
        let rest = &source[pos..];
        let Some(op) = OPS.iter().find(|op| rest.starts_with(**op)) else {
            return Err(ExprError::Syntax {
                pos,
                message: format!("unexpected character '{c}'"),
            });
        };
        tokens.push((pos, Tok::Op(op)));
        i += op.chars().count();
    }
    tokens.push((source.len(), Tok::Eof));
    Ok(tokens)
}

// ---------------------------------------------------------------------------
// Parser (precedence climbing)

struct Parser {
    tokens: Vec<(usize, Tok)>,
    pos: usize,
    depth: usize,
}

impl Parser {
    fn peek(&self) -> &Tok {
        self.tokens.get(self.pos).map_or(&Tok::Eof, |(_, t)| t)
    }

    fn next(&mut self) -> Tok {
        let tok = self.peek().clone();
        if self.pos < self.tokens.len() {
            self.pos += 1;
        }
        tok
    }

    fn error(&self, message: String) -> ExprError {
        let pos = self.tokens.get(self.pos).map_or(0, |(p, _)| *p);
        ExprError::Syntax { pos, message }
    }

    fn eat(&mut self, op: &str) -> bool {
        if matches!(self.peek(), Tok::Op(o) if *o == op) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn expect(&mut self, op: &str) -> Result<(), ExprError> {
        if self.eat(op) {
            Ok(())
        } else {
            Err(self.error(format!("expected '{op}', found {}", self.peek())))
        }
    }

    fn expr(&mut self) -> Result<Expr, ExprError> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(self.error("expression is nested too deeply".into()));
        }
        let result = self.binary(0);
        self.depth -= 1;
        result
    }

    fn binary(&mut self, level: usize) -> Result<Expr, ExprError> {
        const LEVELS: &[&[(&str, BinaryOp)]] = &[
            &[("||", BinaryOp::Or)],
            &[("&&", BinaryOp::And)],
            &[("==", BinaryOp::Eq), ("!=", BinaryOp::Ne)],
            &[
                ("<=", BinaryOp::Le),
                (">=", BinaryOp::Ge),
                ("<", BinaryOp::Lt),
                (">", BinaryOp::Gt),
            ],
            &[("+", BinaryOp::Add), ("-", BinaryOp::Sub)],
            &[
                ("*", BinaryOp::Mul),
                ("/", BinaryOp::Div),
                ("%", BinaryOp::Rem),
            ],
        ];
        let Some(ops) = LEVELS.get(level) else {
            return self.unary();
        };
        let mut left = self.binary(level + 1)?;
        'outer: loop {
            for (sym, op) in *ops {
                if self.eat(sym) {
                    let right = self.binary(level + 1)?;
                    left = Expr::Binary(*op, Box::new(left), Box::new(right));
                    continue 'outer;
                }
            }
            return Ok(left);
        }
    }

    fn unary(&mut self) -> Result<Expr, ExprError> {
        if self.eat("!") {
            return Ok(Expr::Unary(UnaryOp::Not, Box::new(self.nested_unary()?)));
        }
        if self.eat("-") {
            return Ok(Expr::Unary(UnaryOp::Neg, Box::new(self.nested_unary()?)));
        }
        self.postfix()
    }

    fn nested_unary(&mut self) -> Result<Expr, ExprError> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(self.error("expression is nested too deeply".into()));
        }
        let result = self.unary();
        self.depth -= 1;
        result
    }

    fn postfix(&mut self) -> Result<Expr, ExprError> {
        let mut expr = self.primary()?;
        loop {
            if self.eat(".") {
                match self.next() {
                    Tok::Ident(name) => expr = Expr::Member(Box::new(expr), name),
                    other => {
                        return Err(self.error(format!("expected property name, found {other}")));
                    }
                }
            } else if self.eat("[") {
                let index = self.expr()?;
                self.expect("]")?;
                expr = Expr::Index(Box::new(expr), Box::new(index));
            } else {
                return Ok(expr);
            }
        }
    }

    fn primary(&mut self) -> Result<Expr, ExprError> {
        match self.next() {
            Tok::Num(n) => Ok(Expr::Literal(number(n))),
            Tok::Str(s) => Ok(Expr::Literal(Value::String(s))),
            Tok::Ident(name) => match name.as_str() {
                "true" => Ok(Expr::Literal(Value::Bool(true))),
                "false" => Ok(Expr::Literal(Value::Bool(false))),
                "null" => Ok(Expr::Literal(Value::Null)),
                _ if self.eat("(") => {
                    if !FUNCTIONS.contains(&name.as_str()) {
                        return Err(ExprError::UnknownFunction(name));
                    }
                    let mut args = Vec::new();
                    if !self.eat(")") {
                        loop {
                            args.push(self.expr()?);
                            if self.eat(")") {
                                break;
                            }
                            self.expect(",")?;
                        }
                    }
                    Ok(Expr::Call(name, args))
                }
                _ => Ok(Expr::Var(name)),
            },
            Tok::Op("(") => {
                let e = self.expr()?;
                self.expect(")")?;
                Ok(e)
            }
            Tok::Op("[") => {
                let mut items = Vec::new();
                if !self.eat("]") {
                    loop {
                        items.push(self.expr()?);
                        if self.eat("]") {
                            break;
                        }
                        self.expect(",")?;
                    }
                }
                Ok(Expr::List(items))
            }
            other => {
                self.pos = self.pos.saturating_sub(1);
                Err(self.error(format!("unexpected {other}")))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Evaluation

fn collect_vars(expr: &Expr, out: &mut BTreeSet<String>) {
    match expr {
        Expr::Literal(_) => {}
        Expr::Var(name) => {
            out.insert(name.clone());
        }
        Expr::List(items) | Expr::Call(_, items) => items.iter().for_each(|e| collect_vars(e, out)),
        Expr::Member(base, _) => collect_vars(base, out),
        Expr::Index(base, index) => {
            collect_vars(base, out);
            collect_vars(index, out);
        }
        Expr::Unary(_, e) => collect_vars(e, out),
        Expr::Binary(_, a, b) => {
            collect_vars(a, out);
            collect_vars(b, out);
        }
    }
}

fn number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.0e15 {
        // Integral values stay integers so `1 + 1` prints as `2`, not `2.0`.
        #[allow(clippy::cast_possible_truncation)]
        return Value::Number(Number::from(n as i64));
    }
    Number::from_f64(n).map_or(Value::Null, Value::Number)
}

fn as_num(value: &Value, op: &str) -> Result<f64, ExprError> {
    value
        .as_f64()
        .ok_or_else(|| ExprError::Type(format!("'{op}' expects numbers, got {}", type_name(value))))
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn loose_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        _ => a == b,
    }
}

fn eval(expr: &Expr, scope: &dyn Scope) -> Result<Value, ExprError> {
    match expr {
        Expr::Literal(v) => Ok(v.clone()),
        Expr::Var(name) => scope
            .get(name)
            .cloned()
            .ok_or_else(|| ExprError::UndefinedVariable(name.clone())),
        Expr::List(items) => items
            .iter()
            .map(|e| eval(e, scope))
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        Expr::Member(base, name) => Ok(match eval(base, scope)? {
            Value::Object(map) => map.get(name).cloned().unwrap_or(Value::Null),
            Value::Array(items) if name == "length" => Value::from(items.len()),
            Value::String(s) if name == "length" => Value::from(s.chars().count()),
            _ => Value::Null,
        }),
        Expr::Index(base, index) => {
            let base = eval(base, scope)?;
            let index = eval(index, scope)?;
            Ok(match (&base, &index) {
                (Value::Array(items), Value::Number(n)) => n
                    .as_f64()
                    .filter(|f| *f >= 0.0 && f.fract() == 0.0)
                    .and_then(|f| {
                        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                        items.get(f as usize)
                    })
                    .cloned()
                    .unwrap_or(Value::Null),
                (Value::Object(map), Value::String(key)) => {
                    map.get(key).cloned().unwrap_or(Value::Null)
                }
                _ => Value::Null,
            })
        }
        Expr::Unary(UnaryOp::Not, e) => Ok(Value::Bool(!truthy(&eval(e, scope)?))),
        Expr::Unary(UnaryOp::Neg, e) => Ok(number(-as_num(&eval(e, scope)?, "-")?)),
        Expr::Binary(BinaryOp::And, a, b) => {
            let left = eval(a, scope)?;
            if truthy(&left) {
                eval(b, scope)
            } else {
                Ok(left)
            }
        }
        Expr::Binary(BinaryOp::Or, a, b) => {
            let left = eval(a, scope)?;
            if truthy(&left) {
                Ok(left)
            } else {
                eval(b, scope)
            }
        }
        Expr::Binary(op, a, b) => {
            let left = eval(a, scope)?;
            let right = eval(b, scope)?;
            binary(*op, &left, &right)
        }
        Expr::Call(name, args) => {
            let args = args
                .iter()
                .map(|e| eval(e, scope))
                .collect::<Result<Vec<_>, _>>()?;
            call(name, &args)
        }
    }
}

fn binary(op: BinaryOp, left: &Value, right: &Value) -> Result<Value, ExprError> {
    use BinaryOp::*;
    Ok(match op {
        Eq => Value::Bool(loose_eq(left, right)),
        Ne => Value::Bool(!loose_eq(left, right)),
        Lt | Le | Gt | Ge => {
            let ord = match (left, right) {
                (Value::String(a), Value::String(b)) => a.partial_cmp(b),
                _ => as_num(left, "compare")?.partial_cmp(&as_num(right, "compare")?),
            };
            let Some(ord) = ord else {
                return Ok(Value::Bool(false));
            };
            Value::Bool(match op {
                Lt => ord.is_lt(),
                Le => ord.is_le(),
                Gt => ord.is_gt(),
                _ => ord.is_ge(),
            })
        }
        Add => match (left, right) {
            (Value::Number(_), Value::Number(_)) => {
                number(as_num(left, "+")? + as_num(right, "+")?)
            }
            (Value::Array(a), Value::Array(b)) => {
                Value::Array(a.iter().chain(b.iter()).cloned().collect())
            }
            (Value::String(_), _) | (_, Value::String(_)) => {
                Value::String(format!("{}{}", to_display(left), to_display(right)))
            }
            _ => {
                return Err(ExprError::Type(format!(
                    "cannot add {} and {}",
                    type_name(left),
                    type_name(right)
                )));
            }
        },
        Sub => number(as_num(left, "-")? - as_num(right, "-")?),
        Mul => number(as_num(left, "*")? * as_num(right, "*")?),
        Div | Rem => {
            let divisor = as_num(right, "/")?;
            if divisor == 0.0 {
                return Err(ExprError::Type("division by zero".into()));
            }
            let dividend = as_num(left, "/")?;
            number(if op == Div {
                dividend / divisor
            } else {
                dividend % divisor
            })
        }
        And | Or => unreachable_logical(),
    })
}

#[cold]
fn unreachable_logical() -> Value {
    // `&&` and `||` short-circuit in `eval` and never reach `binary`.
    Value::Null
}

fn arity(name: &str, args: &[Value], n: usize) -> Result<(), ExprError> {
    if args.len() == n {
        Ok(())
    } else {
        Err(ExprError::Type(format!(
            "{name}() takes {n} argument(s), got {}",
            args.len()
        )))
    }
}

fn str_arg<'a>(name: &str, value: &'a Value) -> Result<&'a str, ExprError> {
    value.as_str().ok_or_else(|| {
        ExprError::Type(format!(
            "{name}() expects a string, got {}",
            type_name(value)
        ))
    })
}

fn call(name: &str, args: &[Value]) -> Result<Value, ExprError> {
    match name {
        "len" => {
            arity(name, args, 1)?;
            Ok(Value::from(match &args[0] {
                Value::String(s) => s.chars().count(),
                Value::Array(a) => a.len(),
                Value::Object(o) => o.len(),
                Value::Null => 0,
                other => return Err(ExprError::Type(format!("len() of {}", type_name(other)))),
            }))
        }
        "contains" => {
            arity(name, args, 2)?;
            Ok(Value::Bool(match (&args[0], &args[1]) {
                (Value::String(s), needle) => s.contains(&to_display(needle)),
                (Value::Array(items), needle) => items.iter().any(|v| loose_eq(v, needle)),
                (Value::Object(map), Value::String(key)) => map.contains_key(key),
                _ => false,
            }))
        }
        "startsWith" | "endsWith" => {
            arity(name, args, 2)?;
            let s = str_arg(name, &args[0])?;
            let p = str_arg(name, &args[1])?;
            Ok(Value::Bool(if name == "startsWith" {
                s.starts_with(p)
            } else {
                s.ends_with(p)
            }))
        }
        "lower" => {
            arity(name, args, 1)?;
            Ok(Value::String(str_arg(name, &args[0])?.to_lowercase()))
        }
        "upper" => {
            arity(name, args, 1)?;
            Ok(Value::String(str_arg(name, &args[0])?.to_uppercase()))
        }
        "trim" => {
            arity(name, args, 1)?;
            Ok(Value::String(str_arg(name, &args[0])?.trim().to_owned()))
        }
        "str" => {
            arity(name, args, 1)?;
            Ok(Value::String(to_display(&args[0])))
        }
        "num" => {
            arity(name, args, 1)?;
            match &args[0] {
                Value::Number(_) => Ok(args[0].clone()),
                Value::String(s) => {
                    let cleaned = s.trim().replace(',', "");
                    cleaned
                        .parse::<f64>()
                        .map(number)
                        .map_err(|_| ExprError::Type(format!("num() cannot parse '{s}'")))
                }
                Value::Bool(b) => Ok(Value::from(u8::from(*b))),
                other => Err(ExprError::Type(format!("num() of {}", type_name(other)))),
            }
        }
        "isEmpty" => {
            arity(name, args, 1)?;
            Ok(Value::Bool(
                !truthy(&args[0]) && !matches!(args[0], Value::Bool(false) | Value::Number(_)),
            ))
        }
        "coalesce" => Ok(args
            .iter()
            .find(|v| !v.is_null())
            .cloned()
            .unwrap_or(Value::Null)),
        "join" => {
            arity(name, args, 2)?;
            let Value::Array(items) = &args[0] else {
                return Err(ExprError::Type("join() expects an array".into()));
            };
            let sep = str_arg(name, &args[1])?;
            Ok(Value::String(
                items.iter().map(to_display).collect::<Vec<_>>().join(sep),
            ))
        }
        "split" => {
            arity(name, args, 2)?;
            let s = str_arg(name, &args[0])?;
            let sep = str_arg(name, &args[1])?;
            Ok(Value::Array(
                s.split(sep).map(|p| Value::String(p.to_owned())).collect(),
            ))
        }
        other => Err(ExprError::UnknownFunction(other.to_owned())),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scope() -> Map<String, Value> {
        json!({
            "count": 3,
            "name": "太郎",
            "user": { "name": "Alice", "tags": ["a", "b"] },
            "items": [10, 20, 30],
            "empty": "",
        })
        .as_object()
        .cloned()
        .unwrap_or_default()
    }

    fn ev(src: &str) -> Value {
        match evaluate(src, &scope()) {
            Ok(v) => v,
            Err(e) => panic!("{src}: {e}"),
        }
    }

    #[test]
    fn arithmetic_and_precedence() {
        assert_eq!(ev("1 + 2 * 3"), json!(7));
        assert_eq!(ev("(1 + 2) * 3"), json!(9));
        assert_eq!(ev("10 / 4"), json!(2.5));
        assert_eq!(ev("-count + 1"), json!(-2));
        assert_eq!(ev("7 % 4"), json!(3));
    }

    #[test]
    fn comparisons_and_logic() {
        assert_eq!(ev("count > 2 && name == '太郎'"), json!(true));
        assert_eq!(ev("count >= 4 || !true"), json!(false));
        assert_eq!(ev("'b' > 'a'"), json!(true));
        assert_eq!(ev("empty || 'fallback'"), json!("fallback"));
        assert_eq!(ev("3 == 3.0"), json!(true));
    }

    #[test]
    fn paths_and_indexing() {
        assert_eq!(ev("user.name"), json!("Alice"));
        assert_eq!(ev("user.tags[1]"), json!("b"));
        assert_eq!(ev("items[count - 1]"), json!(30));
        assert_eq!(ev("user['name']"), json!("Alice"));
        assert_eq!(ev("user.missing"), Value::Null);
        assert_eq!(ev("items.length"), json!(3));
    }

    #[test]
    fn functions() {
        assert_eq!(ev("len(name)"), json!(2));
        assert_eq!(ev("contains(user.tags, 'a')"), json!(true));
        assert_eq!(ev("upper(user.name)"), json!("ALICE"));
        assert_eq!(ev("num('1,234')"), json!(1234));
        assert_eq!(ev("join(split('a-b', '-'), '+')"), json!("a+b"));
        assert_eq!(ev("coalesce(null, user.missing, 5)"), json!(5));
        assert_eq!(ev("isEmpty(empty)"), json!(true));
        assert_eq!(ev("'n=' + count"), json!("n=3"));
    }

    #[test]
    fn errors_are_reported() {
        assert!(matches!(
            evaluate("nope + 1", &scope()),
            Err(ExprError::UndefinedVariable(_))
        ));
        assert!(matches!(
            Expr::parse("system('rm')"),
            Err(ExprError::UnknownFunction(_))
        ));
        assert!(matches!(Expr::parse("1 +"), Err(ExprError::Syntax { .. })));
        assert!(matches!(Expr::parse("'abc"), Err(ExprError::Syntax { .. })));
        assert!(matches!(
            evaluate("1 / 0", &scope()),
            Err(ExprError::Type(_))
        ));
        assert!(matches!(
            evaluate("{}", &scope()),
            Err(ExprError::Syntax { .. })
        ));
    }

    #[test]
    fn deep_nesting_is_rejected_not_overflowed() {
        let src = format!("{}1{}", "(".repeat(500), ")".repeat(500));
        assert!(matches!(Expr::parse(&src), Err(ExprError::Syntax { .. })));
        let src = format!("{}1", "!".repeat(500));
        assert!(matches!(Expr::parse(&src), Err(ExprError::Syntax { .. })));
    }

    #[test]
    fn templates() {
        let s = scope();
        let t = Template::parse("こんにちは {{ user.name }} さん ({{ count }})").expect("parse");
        assert_eq!(
            t.render(&s).expect("render"),
            json!("こんにちは Alice さん (3)")
        );
        // A single whole-string expression keeps its type.
        assert_eq!(
            Template::parse("{{ items }}")
                .expect("parse")
                .render(&s)
                .expect("render"),
            json!([10, 20, 30])
        );
        assert!(Template::parse("{{ oops").is_err());
        let rendered = render_value(&json!({ "a": ["{{ count + 1 }}", "x"] }), &s).expect("render");
        assert_eq!(rendered, json!({ "a": [4, "x"] }));
    }

    #[test]
    fn referenced_variables() {
        let vars = Expr::parse("len(user.tags) > limit && items[i] == 1")
            .expect("parse")
            .variables();
        assert_eq!(
            vars.into_iter().collect::<Vec<_>>(),
            ["i", "items", "limit", "user"]
        );
    }
}

//! Fitting what OCR reads to what a field can hold: the kind of text
//! (`textKind`: digits for an amount, a date, a phone number…) narrows the
//! characters PaddleOCR may choose from, and a list of `candidates` (the
//! staff's names, the product names) snaps each line to the nearest one.
//! Handwriting gains the most: a hand's "0" and "O", "1" and "l", "7" and
//! "ク" look alike, and a name read with one wrong stroke is still nearest
//! its own name.

use serde_json::{Value, json};

use shikigami_runtime::StepError;

/// What a field holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextKind {
    /// Digits, with `,` `.` `-` `+`.
    Number,
    /// A number with `¥` or `円`.
    Amount,
    /// Digits with `/` `-` `.` `年` `月` `日` and the era names.
    Date,
    /// Digits with `-` `(` `)` `+`.
    Phone,
    /// Latin letters and digits with `-` `_` `.` `@` `/` `:` (codes, mail
    /// addresses).
    Alphanumeric,
    /// Katakana (furigana fields).
    Katakana,
}

impl TextKind {
    pub const NAMES: [&'static str; 6] = [
        "number",
        "amount",
        "date",
        "phone",
        "alphanumeric",
        "katakana",
    ];

    pub fn parse(name: &str) -> Result<Option<Self>, StepError> {
        Ok(Some(match name {
            "" | "any" => return Ok(None),
            "number" => TextKind::Number,
            "amount" => TextKind::Amount,
            "date" => TextKind::Date,
            "phone" => TextKind::Phone,
            "alphanumeric" => TextKind::Alphanumeric,
            "katakana" => TextKind::Katakana,
            other => {
                return Err(StepError::invalid_params(format!(
                    "textKind \"{other}\" is not one of any, {}",
                    Self::NAMES.join(", ")
                )));
            }
        }))
    }

    /// Whether a field of this kind can hold `c` (full-width forms count
    /// as their ASCII ones).
    pub fn allows(self, c: char) -> bool {
        let c = ascii(c);
        let digit = c.is_ascii_digit();
        match self {
            TextKind::Number => digit || ",.-+".contains(c),
            TextKind::Amount => digit || ",.-+¥\\円".contains(c),
            TextKind::Date => digit || "/-.年月日令和平成昭元 ".contains(c),
            TextKind::Phone => digit || "-()+".contains(c),
            TextKind::Alphanumeric => c.is_ascii_alphanumeric() || "-_.@/: ".contains(c),
            TextKind::Katakana => ('\u{30A1}'..='\u{30FA}').contains(&c) || "ー・ ".contains(c),
        }
    }

    /// `text` as the field holds it: full-width digits and letters as
    /// ASCII (except katakana fields), dash-like marks as `-` in numbers,
    /// and characters the kind cannot hold dropped (what an engine that
    /// cannot be narrowed read anyway).
    pub fn fit(self, text: &str) -> String {
        let fitted: String = text
            .chars()
            .map(|c| match self {
                TextKind::Katakana => c,
                _ => match ascii(c) {
                    'ー' | '‐' | '−' | '–' | '—' => '-',
                    '￥' => '¥',
                    c => c,
                },
            })
            .filter(|&c| self.allows(c))
            .collect();
        if self != TextKind::Amount {
            return fitted;
        }
        // Yen has no decimals: a point before three digits is a thousands
        // comma read short ("12.800円").
        let chars: Vec<char> = fitted.chars().collect();
        chars
            .iter()
            .enumerate()
            .map(|(i, &c)| {
                let thousands = c == '.'
                    && i > 0
                    && chars[i - 1].is_ascii_digit()
                    && chars.len() >= i + 4
                    && chars[i + 1..i + 4].iter().all(char::is_ascii_digit)
                    && chars.get(i + 4).is_none_or(|n| !n.is_ascii_digit());
                if thousands { ',' } else { c }
            })
            .collect()
    }
}

/// A full-width ASCII form as ASCII.
fn ascii(c: char) -> char {
    match c as u32 {
        0xFF01..=0xFF5E => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
        0x3000 => ' ',
        0xFFE5 => '¥',
        _ => c,
    }
}

/// Characters as compared with choices: no spaces, full-width as ASCII,
/// lower case.
fn key(text: &str) -> Vec<char> {
    text.chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| ascii(c).to_lowercase().next().unwrap_or(c))
        .collect()
}

fn distance(a: &[char], b: &[char]) -> usize {
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut diagonal = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let next = (diagonal + usize::from(ca != cb))
                .min(row[j] + 1)
                .min(row[j + 1] + 1);
            diagonal = row[j + 1];
            row[j + 1] = next;
        }
    }
    row[b.len()]
}

/// How close two texts must be for a read to snap to a choice: at most
/// half its characters different.
const MIN_SIMILARITY: f64 = 0.5;

/// The choice `read` is nearest, when it is near enough and nearer than
/// any other (a tie snaps to nothing: the read is left as it is).
pub fn nearest<'a>(read: &str, choices: &'a [String]) -> Option<&'a str> {
    scored(read, choices).map(|(_, c)| c)
}

/// [`nearest`], with how near it is (0–1).
fn scored<'a>(read: &str, choices: &'a [String]) -> Option<(f64, &'a str)> {
    let read = key(read);
    if read.is_empty() {
        return None;
    }
    let mut scored: Vec<(f64, &str)> = choices
        .iter()
        .map(|c| {
            let k = key(c);
            let longest = k.len().max(read.len()).max(1);
            (
                1.0 - distance(&read, &k) as f64 / longest as f64,
                c.as_str(),
            )
        })
        .collect();
    scored.sort_by(|a, b| b.0.total_cmp(&a.0));
    match scored.as_slice() {
        [(best, choice), rest @ ..]
            if *best >= MIN_SIMILARITY && rest.first().is_none_or(|(next, _)| next < best) =>
        {
            Some((*best, choice))
        }
        _ => None,
    }
}

/// The `candidates` parameter: texts, at least one.
pub fn choices(params: &Value) -> Result<Option<Vec<String>>, StepError> {
    let Some(value) = params.get("candidates") else {
        return Ok(None);
    };
    let list: Vec<String> = value
        .as_array()
        .ok_or_else(|| StepError::invalid_params("candidates must be a list of texts"))?
        .iter()
        .map(|v| match v {
            Value::String(s) => Ok(s.clone()),
            Value::Number(n) => Ok(n.to_string()),
            _ => Err(StepError::invalid_params(
                "candidates must be a list of texts",
            )),
        })
        .collect::<Result<_, _>>()?;
    Ok((!list.is_empty()).then_some(list))
}

/// desktop.readText's output fitted to `textKind` and `candidates`: each line's
/// text fitted and snapped (the text as read kept as `read` where it
/// changed), and `text` made again from the lines. A snapped line is no
/// longer unsure of anything.
pub fn fit_output(output: &mut Value, kind: Option<TextKind>, choices: Option<&[String]>) {
    if kind.is_none() && choices.is_none() {
        return;
    }
    // A field's text broken over lines ("山田" / "太郎") that as a whole is
    // a candidate is one line of it.
    let whole: Vec<String> = output["lines"]
        .as_array()
        .map(|l| {
            l.iter()
                .map(|l| {
                    let t = l["text"].as_str().unwrap_or_default();
                    kind.map_or_else(|| t.to_owned(), |k| k.fit(t))
                })
                .collect()
        })
        .unwrap_or_default();
    if whole.len() > 1 && snap_whole(output, &whole, choices) {
        return;
    }
    let Some(lines) = output["lines"].as_array_mut() else {
        return;
    };
    for line in lines.iter_mut() {
        let read = line["text"].as_str().unwrap_or_default().to_owned();
        let mut text = kind.map_or_else(|| read.clone(), |k| k.fit(&read));
        if let Some(choice) = choices.and_then(|c| nearest(&text, c)) {
            text = choice.to_owned();
            if let Some(obj) = line.as_object_mut() {
                obj.remove("unsure");
            }
            line["candidate"] = json!(true);
        }
        if text != read {
            line["read"] = json!(read);
            line["text"] = json!(text);
            // Positions in the text as read no longer line up.
            if let Some(obj) = line.as_object_mut() {
                obj.remove("unsure");
            }
        }
    }
    lines.retain(|l| !l["text"].as_str().unwrap_or_default().is_empty());
    let text: Vec<&str> = lines.iter().filter_map(|l| l["text"].as_str()).collect();
    output["text"] = json!(text.join("\n"));
}

/// Lines that as a whole are a candidate, made one line of it; false when
/// they are not, or when a line alone is as near to a candidate (lines
/// that are each a candidate of their own stay apart).
fn snap_whole(output: &mut Value, fitted: &[String], choices: Option<&[String]>) -> bool {
    let Some(choices) = choices else {
        return false;
    };
    let Some((near, choice)) = scored(&fitted.concat(), choices) else {
        return false;
    };
    if fitted
        .iter()
        .filter_map(|l| scored(l, choices))
        .any(|(n, _)| n >= near)
    {
        return false;
    }
    let Some(lines) = output["lines"].as_array() else {
        return false;
    };
    let read: Vec<&str> = lines.iter().filter_map(|l| l["text"].as_str()).collect();
    let num = |l: &Value, k: &str| l[k].as_i64().unwrap_or(0);
    let left = lines.iter().map(|l| num(l, "x")).min().unwrap_or(0);
    let top = lines.iter().map(|l| num(l, "y")).min().unwrap_or(0);
    let right = lines
        .iter()
        .map(|l| num(l, "x") + num(l, "width"))
        .max()
        .unwrap_or(0);
    let bottom = lines
        .iter()
        .map(|l| num(l, "y") + num(l, "height"))
        .max()
        .unwrap_or(0);
    let mut line = json!({
        "text": choice, "x": left, "y": top, "width": right - left, "height": bottom - top,
        "read": read.join("\n"), "candidate": true,
    });
    if let Some(c) = lines
        .iter()
        .filter_map(|l| l["confidence"].as_f64())
        .reduce(f64::min)
    {
        line["confidence"] = json!(c);
    }
    output["lines"] = json!([line]);
    output["text"] = json!(choice);
    true
}

/// A table's cells below the header row fitted and snapped as lines are;
/// the header's names are left as read.
pub fn fit_cells(
    cells: &mut [Vec<String>],
    header: usize,
    kind: Option<TextKind>,
    choices: Option<&[String]>,
) {
    for row in cells.iter_mut().skip(header) {
        for cell in row.iter_mut().filter(|c| !c.is_empty()) {
            let mut text = kind.map_or_else(|| cell.clone(), |k| k.fit(cell));
            if let Some(choice) = choices.and_then(|c| nearest(&text, c)) {
                text = choice.to_owned();
            }
            *cell = text;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_hold_their_characters() {
        assert!(TextKind::Number.allows('７') && !TextKind::Number.allows('ク'));
        assert!(TextKind::Amount.allows('円') && TextKind::Amount.allows('￥'));
        assert!(TextKind::Date.allows('令') && !TextKind::Date.allows('火'));
        assert!(TextKind::Katakana.allows('ヤ') && !TextKind::Katakana.allows('や'));
        assert_eq!(TextKind::Phone.fit("０３ー1234−5678"), "03-1234-5678");
        assert_eq!(TextKind::Amount.fit("￥12,800 円"), "¥12,800円");
        assert_eq!(TextKind::Number.fit("1O2"), "12");
        assert_eq!(TextKind::Amount.fit("12.800円"), "12,800円");
        assert_eq!(TextKind::Amount.fit("1.5円"), "1.5円");
        assert_eq!(TextKind::Number.fit("12.800"), "12.800");
        assert!(TextKind::parse("color").is_err());
        assert_eq!(TextKind::parse("any").unwrap(), None);
    }

    #[test]
    fn reads_snap_to_the_nearest_choice() {
        let staff: Vec<String> = ["山田 太郎", "山本 花子", "佐藤 一郎"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        assert_eq!(nearest("山田木", &staff), Some("山田 太郎"));
        assert_eq!(nearest("佐藤一朗", &staff), Some("佐藤 一郎"));
        // Nothing near enough, or two as near: left as read.
        assert_eq!(nearest("鈴木", &staff), None);
        let two: Vec<String> = vec!["A-100".into(), "A-200".into()];
        assert_eq!(nearest("A-300", &two), None);
    }

    #[test]
    fn output_keeps_what_was_read() {
        let mut output = json!({
            "text": "山田木\n03ー1234",
            "lines": [
                { "text": "山田木", "confidence": 0.4, "unsure": [2] },
                { "text": "03ー1234" }
            ]
        });
        let staff = vec!["山田 太郎".to_owned()];
        fit_output(&mut output, None, Some(&staff));
        assert_eq!(output["text"], "山田 太郎\n03ー1234");
        assert_eq!(output["lines"][0]["read"], "山田木");
        assert_eq!(output["lines"][0]["candidate"], true);
        assert!(output["lines"][0].get("unsure").is_none());
        assert!(output["lines"][1].get("read").is_none());

        // A name broken over two lines is one line of the candidate.
        let mut output = json!({ "text": "山田\n太郎", "lines": [
            { "text": "山田", "x": 10, "y": 5, "width": 40, "height": 20, "confidence": 0.9 },
            { "text": "太郎", "x": 60, "y": 6, "width": 40, "height": 20, "confidence": 0.7 }
        ] });
        fit_output(&mut output, None, Some(&staff));
        assert_eq!(output["text"], "山田 太郎");
        assert_eq!(output["lines"].as_array().unwrap().len(), 1);
        assert_eq!(output["lines"][0]["width"], 90);
        assert_eq!(output["lines"][0]["read"], "山田\n太郎");
        assert_eq!(output["lines"][0]["confidence"], 0.7);

        // Lines that are each a candidate stay apart.
        let two: Vec<String> = vec!["Alice".into(), "Bob".into()];
        let mut output =
            json!({ "text": "Alice\nBob", "lines": [{ "text": "Alice" }, { "text": "Bob" }] });
        fit_output(&mut output, None, Some(&two));
        assert_eq!(output["text"], "Alice\nBob");
        assert_eq!(output["lines"].as_array().unwrap().len(), 2);

        let mut output = json!({ "text": "", "lines": [{ "text": "０９０ー1234" }] });
        fit_output(&mut output, Some(TextKind::Phone), None);
        assert_eq!(output["text"], "090-1234");
        assert_eq!(output["lines"][0]["read"], "０９０ー1234");
    }

    #[test]
    fn table_cells_below_the_header_are_fitted() {
        let mut cells = vec![
            vec!["金額".to_owned(), "担当".to_owned()],
            vec!["12.800円".to_owned(), "山田木".to_owned()],
        ];
        let staff: Vec<String> = vec!["山田 太郎".into(), "佐藤 一郎".into()];
        let mut names = cells.clone();
        fit_cells(&mut cells, 1, Some(TextKind::Amount), None);
        assert_eq!(cells[0][0], "金額");
        assert_eq!(cells[1][0], "12,800円");
        fit_cells(&mut names, 1, None, Some(&staff));
        assert_eq!(names[1][1], "山田 太郎");
    }
}

//! The text inside a .docx part (`word/document.xml`, headers, footers).
//!
//! Word stores a paragraph's text in `<w:t>` elements spread over runs,
//! and often splits what the author typed as `{{ 氏名 }}` across several
//! runs (spell checking, edits, formatting). Placeholders are therefore
//! found in each paragraph's joined text and written back into the runs
//! they came from: the replacement takes the formatting of the run where
//! the placeholder starts.

use std::collections::BTreeSet;

use serde_json::{Map, Value};

/// One `<w:t>` element: the whole element's byte range and its text.
struct Segment {
    start: usize,
    end: usize,
    text: String,
    paragraph: usize,
}

/// What a placeholder name stands for.
pub enum Lookup {
    Text(String),
    Missing,
}

fn is_tag(xml: &str, at: usize, name: &str) -> bool {
    let rest = &xml[at..];
    rest.starts_with(name) && matches!(rest.as_bytes().get(name.len()), Some(b'>' | b' ' | b'/'))
}

fn segments(xml: &str) -> Vec<Segment> {
    let mut out = Vec::new();
    let mut paragraph = 0;
    let mut i = 0;
    while let Some(off) = xml[i..].find('<') {
        let at = i + off;
        if xml[at..].starts_with("</w:p>") {
            paragraph += 1;
            i = at + 6;
            continue;
        }
        if is_tag(xml, at, "<w:t") {
            let Some(close) = xml[at..].find('>').map(|c| at + c) else {
                break;
            };
            if xml.as_bytes()[close - 1] == b'/' {
                i = close + 1;
                continue;
            }
            let Some(end) = xml[close..].find("</w:t>").map(|c| close + c) else {
                break;
            };
            out.push(Segment {
                start: at,
                end: end + 6,
                text: unescape(&xml[close + 1..end]),
                paragraph,
            });
            i = end + 6;
            continue;
        }
        i = at + 1;
    }
    out
}

/// `{{ name }}` occurrences in `text`: (char start, char end, trimmed name).
fn placeholders(text: &[char]) -> Vec<(usize, usize, String)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < text.len() {
        if text[i] == '{'
            && text[i + 1] == '{'
            && let Some(len) = text[i + 2..].windows(2).position(|w| w == ['}', '}'])
        {
            let inner: String = text[i + 2..i + 2 + len].iter().collect();
            if !inner.contains(['{', '}']) && !inner.trim().is_empty() {
                out.push((i, i + 2 + len + 2, inner.trim().to_owned()));
                i += 2 + len + 2;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// The placeholder names used in a part.
pub fn names(xml: &str) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    for_each_paragraph(&segments(xml), |chars, _| {
        names.extend(placeholders(chars).into_iter().map(|(_, _, n)| n));
    });
    names
}

fn for_each_paragraph(segments: &[Segment], mut f: impl FnMut(&[char], &[usize])) {
    let mut i = 0;
    while i < segments.len() {
        let paragraph = segments[i].paragraph;
        let mut chars = Vec::new();
        let mut owner = Vec::new();
        let mut j = i;
        while j < segments.len() && segments[j].paragraph == paragraph {
            for c in segments[j].text.chars() {
                chars.push(c);
                owner.push(j);
            }
            j += 1;
        }
        f(&chars, &owner);
        i = j;
    }
}

/// Replaces every placeholder `lookup` knows. Returns the new XML, how many
/// were replaced and the names it did not know.
pub fn fill(xml: &str, lookup: &dyn Fn(&str) -> Lookup) -> (String, usize, BTreeSet<String>) {
    let segments = segments(xml);
    let mut texts: Vec<Option<String>> = vec![None; segments.len()];
    let mut replaced = 0;
    let mut missing = BTreeSet::new();
    for_each_paragraph(&segments, |chars, owner| {
        let found = placeholders(chars);
        if found.is_empty() {
            return;
        }
        let mut new: Vec<String> = Vec::new();
        let first = owner[0];
        let last = owner[owner.len() - 1];
        new.resize(last - first + 1, String::new());
        let mut k = 0;
        let mut any = false;
        let mut c = 0;
        while c < chars.len() {
            if k < found.len() && found[k].0 == c {
                let (start, end, name) = &found[k];
                k += 1;
                match lookup(name) {
                    Lookup::Text(value) => {
                        new[owner[*start] - first].push_str(&value);
                        replaced += 1;
                        any = true;
                        c = *end;
                        continue;
                    }
                    Lookup::Missing => {
                        missing.insert(name.clone());
                    }
                }
            }
            new[owner[c] - first].push(chars[c]);
            c += 1;
        }
        if any {
            for (n, text) in new.into_iter().enumerate() {
                texts[first + n] = Some(text);
            }
        }
    });

    let mut out = String::with_capacity(xml.len());
    let mut at = 0;
    for (segment, text) in segments.iter().zip(texts) {
        let Some(text) = text else { continue };
        out.push_str(&xml[at..segment.start]);
        out.push_str("<w:t xml:space=\"preserve\">");
        out.push_str(&escape(&text).replace('\n', "</w:t><w:br/><w:t xml:space=\"preserve\">"));
        out.push_str("</w:t>");
        at = segment.end;
    }
    out.push_str(&xml[at..]);
    (out, replaced, missing)
}

/// Byte ranges of the table rows (`<w:tr>`) in a part, outermost only.
fn rows(xml: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut start = 0;
    let mut i = 0;
    while let Some(off) = xml[i..]
        .find("<w:tr")
        .into_iter()
        .chain(xml[i..].find("</w:tr>"))
        .min()
    {
        let at = i + off;
        if xml[at..].starts_with("</w:tr>") {
            if depth > 0 {
                depth -= 1;
                if depth == 0 {
                    out.push((start, at + 7));
                }
            }
            i = at + 7;
        } else {
            if is_tag(xml, at, "<w:tr") {
                if depth == 0 {
                    start = at;
                }
                depth += 1;
            }
            i = at + 5;
        }
    }
    out
}

/// Repeats each table row whose placeholders name a list in `values`
/// (`{{ 明細.品名 }}` with `"明細": [ { "品名": … }, … ]`): once per
/// record, filled from it. An empty list removes the row.
pub fn expand_rows(
    xml: &str,
    values: &Map<String, Value>,
    replaced: &mut usize,
    missing: &mut BTreeSet<String>,
) -> String {
    let mut out = String::with_capacity(xml.len());
    let mut at = 0;
    for (start, end) in rows(xml) {
        let row = &xml[start..end];
        let list = names(row).into_iter().find_map(|name| {
            let (head, _) = name.split_once('.')?;
            match values.get(head.trim()) {
                Some(Value::Array(items)) => Some((head.trim().to_owned(), items)),
                _ => None,
            }
        });
        let Some((key, items)) = list else { continue };
        out.push_str(&xml[at..start]);
        for item in items {
            let lookup = |name: &str| match name.split_once('.') {
                Some((head, field)) if head.trim() == key => match item.get(field.trim()) {
                    Some(value) => text(value),
                    None => Lookup::Missing,
                },
                _ => lookup(values, name),
            };
            let (filled, n, gone) = fill(row, &lookup);
            *replaced += n;
            missing.extend(gone);
            out.push_str(&filled);
        }
        at = end;
    }
    out.push_str(&xml[at..]);
    out
}

fn text(value: &Value) -> Lookup {
    match value {
        Value::Null => Lookup::Text(String::new()),
        Value::String(s) => Lookup::Text(s.clone()),
        Value::Number(n) => Lookup::Text(n.to_string()),
        Value::Bool(b) => Lookup::Text(b.to_string()),
        _ => Lookup::Missing,
    }
}

/// `氏名` or `顧客.氏名` (a field of a record) from `values`.
pub fn lookup(values: &Map<String, Value>, name: &str) -> Lookup {
    if let Some(value) = values.get(name) {
        return text(value);
    }
    if let Some((head, field)) = name.split_once('.')
        && let Some(Value::Object(record)) = values.get(head.trim())
        && let Some(value) = record.get(field.trim())
    {
        return text(value);
    }
    Lookup::Missing
}

/// The part's text: paragraphs on their own lines, tabs and line breaks kept.
pub fn plain_text(xml: &str) -> String {
    let mut out = String::new();
    let mut i = 0;
    while let Some(off) = xml[i..].find('<') {
        let at = i + off;
        let rest = &xml[at..];
        if rest.starts_with("</w:p>") {
            out.push('\n');
        } else if is_tag(xml, at, "<w:tab") {
            out.push('\t');
        } else if is_tag(xml, at, "<w:br") || is_tag(xml, at, "<w:cr") {
            out.push('\n');
        } else if is_tag(xml, at, "<w:t")
            && let Some(close) = rest.find('>')
            && xml.as_bytes()[at + close - 1] != b'/'
            && let Some(end) = xml[at + close..].find("</w:t>")
        {
            out.push_str(&unescape(&xml[at + close + 1..at + close + end]));
            i = at + close + end + 6;
            continue;
        }
        i = at + 1;
    }
    out.trim_end().to_owned()
}

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            // Control characters other than tab / newline are not allowed in XML.
            c if (c as u32) < 0x20 && c != '\n' && c != '\t' => {}
            c => out.push(c),
        }
    }
    out
}

fn unescape(text: &str) -> String {
    if !text.contains('&') {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let Some(semi) = rest.find(';') else { break };
        let entity = &rest[1..semi];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => entity
                .strip_prefix("#x")
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &rest[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn values(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn placeholders_split_over_runs_are_filled() {
        let xml = r#"<w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>宛名：{{</w:t></w:r><w:proofErr w:type="spellStart"/><w:r><w:t xml:space="preserve"> 氏名</w:t></w:r><w:r><w:t>}} 様</w:t></w:r></w:p><w:p><w:r><w:t>{{金額}}円 &amp; {{不明}}</w:t></w:r><w:tab/></w:p></w:body>"#;
        assert_eq!(
            names(xml).into_iter().collect::<Vec<_>>(),
            ["不明", "氏名", "金額"]
        );
        let v = values(json!({ "氏名": "山田 <太郎>", "金額": 1200 }));
        let (out, replaced, missing) = fill(xml, &|n| lookup(&v, n));
        assert_eq!(replaced, 2);
        assert_eq!(missing.into_iter().collect::<Vec<_>>(), ["不明"]);
        assert_eq!(plain_text(&out), "宛名：山田 <太郎> 様\n1200円 & {{不明}}");
        assert!(
            out.contains("<w:b/></w:rPr><w:t xml:space=\"preserve\">宛名：山田 &lt;太郎&gt;</w:t>")
        );
    }

    #[test]
    fn newlines_become_line_breaks() {
        let xml = "<w:p><w:r><w:t>{{住所}}</w:t></w:r></w:p>";
        let v = values(json!({ "住所": "東京都\n千代田区" }));
        let (out, _, _) = fill(xml, &|n| lookup(&v, n));
        assert_eq!(
            out,
            "<w:p><w:r><w:t xml:space=\"preserve\">東京都</w:t><w:br/><w:t xml:space=\"preserve\">千代田区</w:t></w:r></w:p>"
        );
    }

    #[test]
    fn rows_repeat_for_each_record() {
        let row = |a: &str, b: &str| {
            format!(
                "<w:tr><w:tc><w:p><w:r><w:t>{a}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>{b}</w:t></w:r></w:p></w:tc></w:tr>"
            )
        };
        let xml = format!(
            "<w:tbl>{}{}</w:tbl><w:tbl>{}</w:tbl>",
            row("品名", "数量"),
            row("{{ 明細.品名 }}", "{{明細.数量}}"),
            row("{{ 空.品名 }}", "x")
        );
        let v = values(
            json!({ "明細": [ { "品名": "りんご", "数量": 3 }, { "品名": "みかん", "数量": 5 } ], "空": [] }),
        );
        let (mut replaced, mut missing) = (0, BTreeSet::new());
        let out = expand_rows(&xml, &v, &mut replaced, &mut missing);
        assert_eq!(replaced, 4);
        assert!(missing.is_empty());
        assert_eq!(plain_text(&out), "品名\n数量\nりんご\n3\nみかん\n5");
    }

    #[test]
    fn records_and_entities() {
        let v = values(json!({ "顧客": { "氏名": "佐藤" } }));
        let xml = "<w:p><w:r><w:t>{{顧客.氏名}} &#x3042;&lt;</w:t></w:r></w:p>";
        let (out, n, _) = fill(xml, &|name| lookup(&v, name));
        assert_eq!(n, 1);
        assert_eq!(plain_text(&out), "佐藤 あ<");
    }
}

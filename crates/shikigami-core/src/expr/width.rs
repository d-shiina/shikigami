//! 全角・半角の変換（英数字・記号・空白・カタカナ）。

/// Half-width katakana U+FF66..=U+FF9D, in code point order.
const HALF_KANA: &str = "ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ";
/// The full-width katakana for each character of [`HALF_KANA`].
const FULL_KANA: &str = "ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン";
/// Half-width punctuation and the full-width forms.
const HALF_PUNCT: &str = "｡｢｣､･ﾞﾟ";
const FULL_PUNCT: &str = "。「」、・゛゜";
/// Katakana that take a voiced mark (ガ = カ + 1, バ = ハ + 1).
const VOICEABLE: &str = "カキクケコサシスセソタチツテトハヒフヘホ";
/// Katakana that take a semi-voiced mark (パ = ハ + 2).
const SEMI_VOICEABLE: &str = "ハヒフヘホ";

fn shift(c: char, by: u32) -> Option<char> {
    char::from_u32(c as u32 + by)
}

fn half_of(full: char) -> Option<char> {
    FULL_KANA
        .chars()
        .zip(HALF_KANA.chars())
        .chain(FULL_PUNCT.chars().zip(HALF_PUNCT.chars()))
        .find(|(f, _)| *f == full)
        .map(|(_, h)| h)
}

fn full_of(half: char) -> Option<char> {
    HALF_KANA
        .chars()
        .zip(FULL_KANA.chars())
        .chain(HALF_PUNCT.chars().zip(FULL_PUNCT.chars()))
        .find(|(h, _)| *h == half)
        .map(|(_, f)| f)
}

/// ＡＢＣ１２３ → ABC123, アイウ → ｱｲｳ, ガ → ｶﾞ, 全角空白 → 半角空白.
pub fn to_half(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\u{3000}' => out.push(' '),
            '\u{FF01}'..='\u{FF5E}' => out.extend(char::from_u32(c as u32 - 0xFEE0)),
            'ヴ' => out.push_str("ｳﾞ"),
            _ => {
                if let Some(h) = half_of(c) {
                    out.push(h);
                } else if let Some(base) = VOICEABLE
                    .chars()
                    .find(|b| shift(*b, 1) == Some(c))
                    .and_then(half_of)
                {
                    out.push(base);
                    out.push('ﾞ');
                } else if let Some(base) = SEMI_VOICEABLE
                    .chars()
                    .find(|b| shift(*b, 2) == Some(c))
                    .and_then(half_of)
                {
                    out.push(base);
                    out.push('ﾟ');
                } else {
                    out.push(c);
                }
            }
        }
    }
    out
}

/// ABC123 → ＡＢＣ１２３, ｶﾞ → ガ, 半角空白 → 全角空白.
pub fn to_full(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            ' ' => out.push('\u{3000}'),
            '!'..='~' => out.extend(char::from_u32(c as u32 + 0xFEE0)),
            _ => {
                let Some(full) = full_of(c) else {
                    out.push(c);
                    continue;
                };
                let combined = match chars.peek() {
                    Some('ﾞ') if full == 'ウ' => Some('ヴ'),
                    Some('ﾞ') if VOICEABLE.contains(full) => shift(full, 1),
                    Some('ﾟ') if SEMI_VOICEABLE.contains(full) => shift(full, 2),
                    _ => None,
                };
                if let Some(combined) = combined {
                    chars.next();
                    out.push(combined);
                } else {
                    out.push(full);
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        assert_eq!(to_half("ＡＢＣ　１２３－ガパヴッ。"), "ABC 123-ｶﾞﾊﾟｳﾞｯ｡");
        assert_eq!(to_full("ABC 123-ｶﾞﾊﾟｳﾞｯ｡"), "ＡＢＣ　１２３－ガパヴッ。");
        assert_eq!(to_half("漢字ひらがな"), "漢字ひらがな");
        assert_eq!(to_full("ﾃｽﾄ"), "テスト");
    }
}

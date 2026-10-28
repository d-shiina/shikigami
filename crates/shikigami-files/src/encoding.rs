//! Text encodings of files: UTF-8 (with or without BOM) and Shift_JIS.

use encoding_rs::{SHIFT_JIS, UTF_16BE, UTF_16LE};
use serde_json::json;
use shikigami_runtime::StepError;

/// `encoding` param when reading.
pub const READ_ENCODINGS: &[&str] = &["auto", "utf-8", "shift_jis"];
/// `encoding` param when writing.
pub const WRITE_ENCODINGS: &[&str] = &["utf-8", "utf-8-bom", "shift_jis"];

const BOM: &[u8] = b"\xEF\xBB\xBF";

/// Decodes file bytes. `auto` reads a BOM (UTF-8 / UTF-16), then UTF-8, and
/// falls back to Shift_JIS (Windows Japanese) when the bytes are not UTF-8.
pub fn decode(bytes: &[u8], encoding: &str, path: &str) -> Result<String, StepError> {
    if let Some(rest) = bytes.strip_prefix(BOM) {
        return utf8(rest, path);
    }
    match encoding {
        "shift_jis" => {
            let (text, had_errors) = SHIFT_JIS.decode_without_bom_handling(bytes);
            if had_errors {
                return Err(StepError::permanent(
                    "ENCODING_MISMATCH",
                    format!("{path} is not Shift_JIS text"),
                )
                .with_details(json!({ "hint": "Try encoding \"utf-8\" (or \"auto\")." })));
            }
            Ok(text.into_owned())
        }
        "utf-8" => utf8(bytes, path),
        _ => {
            if let Some(rest) = bytes.strip_prefix(b"\xFF\xFE") {
                return Ok(UTF_16LE.decode_without_bom_handling(rest).0.into_owned());
            }
            if let Some(rest) = bytes.strip_prefix(b"\xFE\xFF") {
                return Ok(UTF_16BE.decode_without_bom_handling(rest).0.into_owned());
            }
            match std::str::from_utf8(bytes) {
                Ok(text) => Ok(text.to_owned()),
                Err(_) => decode(bytes, "shift_jis", path),
            }
        }
    }
}

fn utf8(bytes: &[u8], path: &str) -> Result<String, StepError> {
    String::from_utf8(bytes.to_vec()).map_err(|_| {
        StepError::permanent("ENCODING_MISMATCH", format!("{path} is not UTF-8 text"))
            .with_details(json!({ "hint": "Try encoding \"shift_jis\" (or \"auto\")." }))
    })
}

/// Encodes text for a file. `with_bom` is false when appending to a file
/// that already has content.
pub fn encode(text: &str, encoding: &str, with_bom: bool) -> Result<Vec<u8>, StepError> {
    match encoding {
        "shift_jis" => {
            let (bytes, _, had_errors) = SHIFT_JIS.encode(text);
            if had_errors {
                let bad: String = text
                    .chars()
                    .filter(|c| SHIFT_JIS.encode(&c.to_string()).2)
                    .take(5)
                    .collect();
                return Err(StepError::permanent(
                    "UNENCODABLE_TEXT",
                    format!("Shift_JIS cannot represent these characters: {bad}"),
                )
                .with_details(json!({
                    "characters": bad,
                    "hint": "Use encoding \"utf-8-bom\" (Excel reads it), or replace the characters first with replace().",
                })));
            }
            Ok(bytes.into_owned())
        }
        "utf-8-bom" if with_bom => Ok([BOM, text.as_bytes()].concat()),
        _ => Ok(text.as_bytes().to_vec()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_detects_utf8_bom_and_shift_jis() {
        let sjis = encode("請求書", "shift_jis", true).unwrap();
        assert_eq!(decode(&sjis, "auto", "a").unwrap(), "請求書");
        assert_eq!(decode(&sjis, "shift_jis", "a").unwrap(), "請求書");
        assert!(decode(&sjis, "utf-8", "a").is_err());
        let bom = encode("請求書", "utf-8-bom", true).unwrap();
        assert!(bom.starts_with(BOM));
        assert_eq!(decode(&bom, "auto", "a").unwrap(), "請求書");
        assert_eq!(decode(&bom, "shift_jis", "a").unwrap(), "請求書");
        assert_eq!(encode("x", "utf-8-bom", false).unwrap(), b"x");
        let err = encode("髙橋🍣", "shift_jis", true).unwrap_err();
        assert_eq!(err.code, "UNENCODABLE_TEXT");
        assert!(err.message.contains('🍣'));
    }
}

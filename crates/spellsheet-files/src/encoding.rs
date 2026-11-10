//! Text encodings of files: UTF-8 (with or without BOM) and Shift_JIS.

use encoding_rs::{SHIFT_JIS, UTF_16BE, UTF_16LE};
use serde_json::json;
use spellsheet_runtime::StepError;

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

/// What a console program (schtasks, reg, tasklist, …) wrote to a pipe.
/// Windows programs write in the console's code page, not UTF-8 (CP932 on
/// Japanese Windows): UTF-8 is taken as it is, anything else is read in the
/// console's output code page, else the OEM code page.
pub fn console_text(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(BOM) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_owned();
    }
    #[cfg(windows)]
    if let Some(text) = windows_code_page(bytes) {
        return text;
    }
    SHIFT_JIS.decode_without_bom_handling(bytes).0.into_owned()
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn windows_code_page(bytes: &[u8]) -> Option<String> {
    use windows::Win32::Globalization::{
        GetOEMCP, MULTI_BYTE_TO_WIDE_CHAR_FLAGS, MultiByteToWideChar,
    };
    use windows::Win32::System::Console::GetConsoleOutputCP;
    // SAFETY: plain queries without arguments.
    let console = unsafe { GetConsoleOutputCP() };
    let page = if console == 0 {
        unsafe { GetOEMCP() }
    } else {
        console
    };
    let flags = MULTI_BYTE_TO_WIDE_CHAR_FLAGS(0);
    // SAFETY: the slices are valid for the calls; the second writes at most
    // the length the first returned.
    let len = unsafe { MultiByteToWideChar(page, flags, bytes, None) };
    let mut wide = vec![0u16; usize::try_from(len).ok().filter(|&n| n > 0)?];
    let written = unsafe { MultiByteToWideChar(page, flags, bytes, Some(&mut wide)) };
    wide.truncate(usize::try_from(written).ok()?);
    Some(String::from_utf16_lossy(&wide))
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

    #[test]
    fn console_text_reads_the_console_code_page() {
        // What schtasks says on Japanese Windows, in CP932 (the code page
        // of a Windows runner is not, so only off Windows).
        #[cfg(not(windows))]
        {
            let sjis = encode("エラー: アクセスが拒否されました。", "shift_jis", true).unwrap();
            assert_eq!(console_text(&sjis), "エラー: アクセスが拒否されました。");
        }
        assert_eq!(console_text("成功".as_bytes()), "成功");
        assert_eq!(console_text(b""), "");
    }
}

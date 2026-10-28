//! One-time codes (TOTP, RFC 6238) for sites that ask for MFA.
//!
//! The key is what an authenticator app would scan: a base32 secret or the
//! whole `otpauth://totp/...` text of the QR code.

use hmac::{Hmac, Mac};
use sha1::Sha1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TotpSpec {
    key: Vec<u8>,
    digits: u32,
    period: u64,
}

impl TotpSpec {
    pub(crate) fn parse(text: &str) -> Result<Self, String> {
        let text = text.trim();
        let (secret, digits, period) = match text.strip_prefix("otpauth://") {
            Some(rest) => {
                let query = rest.split_once('?').map_or("", |(_, q)| q);
                let mut secret = None;
                let mut digits = 6;
                let mut period = 30;
                for pair in query.split('&') {
                    let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
                    match k.to_ascii_lowercase().as_str() {
                        "secret" => secret = Some(v.to_owned()),
                        "digits" => digits = v.parse().map_err(|_| "invalid digits")?,
                        "period" => period = v.parse().map_err(|_| "invalid period")?,
                        "algorithm" if !v.eq_ignore_ascii_case("SHA1") => {
                            return Err(format!("TOTP algorithm {v} is not supported (SHA1 only)"));
                        }
                        _ => {}
                    }
                }
                (
                    secret.ok_or("the otpauth text has no secret")?,
                    digits,
                    period,
                )
            }
            None => (text.to_owned(), 6, 30),
        };
        if !(6..=8).contains(&digits) || period == 0 {
            return Err("TOTP needs 6–8 digits and a positive period".into());
        }
        let key = base32_decode(&secret).ok_or("the TOTP key is not valid base32")?;
        if key.is_empty() {
            return Err("the TOTP key is empty".into());
        }
        Ok(Self {
            key,
            digits,
            period,
        })
    }

    pub(crate) fn code_at(&self, unix_seconds: u64) -> String {
        let counter = unix_seconds / self.period;
        let Ok(mut mac) = Hmac::<Sha1>::new_from_slice(&self.key) else {
            return String::new();
        };
        mac.update(&counter.to_be_bytes());
        let hash = mac.finalize().into_bytes();
        let offset = usize::from(hash[hash.len() - 1] & 0x0f);
        let binary = (u32::from(hash[offset]) & 0x7f) << 24
            | u32::from(hash[offset + 1]) << 16
            | u32::from(hash[offset + 2]) << 8
            | u32::from(hash[offset + 3]);
        let code = binary % 10u32.pow(self.digits);
        format!("{code:0width$}", width = self.digits as usize)
    }

    pub(crate) fn code_now(&self) -> String {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        self.code_at(now)
    }
}

fn base32_decode(text: &str) -> Option<Vec<u8>> {
    let mut bits: u64 = 0;
    let mut count = 0;
    let mut out = Vec::new();
    for c in text.chars() {
        if c == '=' || c == ' ' || c == '-' {
            continue;
        }
        let value = match c.to_ascii_uppercase() {
            c @ 'A'..='Z' => c as u64 - 'A' as u64,
            c @ '2'..='7' => c as u64 - '2' as u64 + 26,
            _ => return None,
        };
        bits = (bits << 5) | value;
        count += 5;
        if count >= 8 {
            count -= 8;
            out.push(((bits >> count) & 0xff) as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    // RFC 6238 test vector (SHA1, key "12345678901234567890").
    const RFC_KEY: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

    #[test]
    fn matches_rfc_6238() {
        let spec = TotpSpec::parse(&format!("otpauth://totp/x?secret={RFC_KEY}&digits=8")).unwrap();
        assert_eq!(spec.code_at(59), "94287082");
        assert_eq!(spec.code_at(1_111_111_109), "07081804");
        assert_eq!(spec.code_at(20_000_000_000), "65353130");
        let six = TotpSpec::parse(&RFC_KEY.to_lowercase()).unwrap();
        assert_eq!(six.code_at(59), "287082");
    }

    #[test]
    fn rejects_bad_keys() {
        assert!(TotpSpec::parse("not base32!").is_err());
        assert!(TotpSpec::parse("otpauth://totp/x?issuer=a").is_err());
        assert!(
            TotpSpec::parse(&format!(
                "otpauth://totp/x?secret={RFC_KEY}&algorithm=SHA256"
            ))
            .is_err()
        );
    }
}

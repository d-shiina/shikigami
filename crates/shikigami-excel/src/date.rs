//! Excel dates: serial numbers with a date number format.
//!
//! Steps exchange dates as ISO text (`2026-10-28`, `2026-10-28T09:30:00`)
//! so that scenarios can compare and template them without knowing about
//! serial numbers.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Date,
    Time,
    DateTime,
}

/// Built-in number formats that show dates or times (14–22, 45–47, and
/// the East Asian ones 27–36, 50–58).
fn builtin_kind(id: u32) -> Option<Kind> {
    match id {
        14..=17 | 27..=31 | 34..=36 | 50..=58 => Some(Kind::Date),
        18..=21 | 32 | 33 | 45..=47 => Some(Kind::Time),
        22 => Some(Kind::DateTime),
        _ => None,
    }
}

/// Whether a number format shows a date, a time or both.
pub fn format_kind(id: u32, code: &str) -> Option<Kind> {
    if code.is_empty() {
        return builtin_kind(id);
    }
    // Look at the format's letters outside "quoted text", [colours /
    // locales] and \escaped characters; only the first section counts.
    let section = code
        .split(';')
        .next()
        .unwrap_or("")
        .replace("G/標準", "")
        .replace("General", "")
        .replace("general", "");
    let (mut date, mut month, mut time) = (false, false, false);
    let mut chars = section.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                for q in chars.by_ref() {
                    if q == '"' {
                        break;
                    }
                }
            }
            '[' => {
                let inner: String = chars.by_ref().take_while(|&b| b != ']').collect();
                // [h] [mm] [ss]: elapsed time.
                if !inner.is_empty()
                    && inner
                        .chars()
                        .all(|b| matches!(b, 'h' | 'H' | 'm' | 'M' | 's' | 'S'))
                {
                    time = true;
                }
            }
            '\\' | '_' | '*' => {
                chars.next();
            }
            'y' | 'Y' | 'd' | 'D' | 'e' | 'g' | 'G' => date = true,
            'h' | 'H' | 's' | 'S' => time = true,
            'm' | 'M' => month = true,
            _ => {}
        }
    }
    // `m` next to h / s is minutes, not months.
    match (date || (month && !time), time) {
        (true, true) => Some(Kind::DateTime),
        (true, false) => Some(Kind::Date),
        (false, true) => Some(Kind::Time),
        (false, false) => builtin_kind(id),
    }
}

/// Days from 1970-01-01 to a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// Serial 0 in days since 1970-01-01. In the 1900 system serials from 61
/// count from 1899-12-30, because Excel keeps Lotus's 1900-02-29.
fn epoch(serial_day: i64, date1904: bool) -> i64 {
    if date1904 {
        days_from_civil(1904, 1, 1)
    } else if serial_day >= 61 {
        days_from_civil(1899, 12, 30)
    } else {
        days_from_civil(1899, 12, 31)
    }
}

pub fn to_text(serial: f64, kind: Kind, date1904: bool) -> Option<String> {
    if !serial.is_finite() || !(0.0..3_000_000.0).contains(&serial) {
        return None;
    }
    let mut day = serial.floor() as i64;
    let mut seconds = ((serial - serial.floor()) * 86_400.0).round() as i64;
    if seconds == 86_400 {
        day += 1;
        seconds = 0;
    }
    let (y, m, d) = civil_from_days(epoch(day, date1904) + day);
    let (hh, mm, ss) = (seconds / 3600, seconds / 60 % 60, seconds % 60);
    Some(match kind {
        Kind::Date if seconds == 0 => format!("{y:04}-{m:02}-{d:02}"),
        Kind::Time if day == 0 => format!("{hh:02}:{mm:02}:{ss:02}"),
        _ => format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}"),
    })
}

/// `2026-10-28`, `2026/10/28` or `2026-10-28T09:30[:00]` (also with a
/// space) as a serial number, and whether it has a time.
pub fn from_text(text: &str, date1904: bool) -> Option<(f64, bool)> {
    let text = text.trim();
    let (date, time) = match text.split_once(['T', ' ']) {
        Some((d, t)) => (d, Some(t)),
        None => (text, None),
    };
    let mut parts = date.split(['-', '/']);
    let y: i64 = parts.next()?.parse().ok()?;
    let m: i64 = parts.next()?.parse().ok()?;
    let d: i64 = parts.next()?.parse().ok()?;
    if parts.next().is_some()
        || !(1..=12).contains(&m)
        || !(1..=31).contains(&d)
        || !(1900..=9999).contains(&y)
    {
        return None;
    }
    let days = days_from_civil(y, m, d);
    // Reject 2026-02-30 and the like.
    if civil_from_days(days) != (y, m, d) {
        return None;
    }
    let seconds = match time {
        None => 0,
        Some(t) => {
            let t = t.trim_end_matches('Z');
            let mut hms = t.split(':');
            let h: i64 = hms.next()?.parse().ok()?;
            let mi: i64 = hms.next()?.parse().ok()?;
            let s: f64 = hms.next().map_or(Some(0.0), |s| s.parse().ok())?;
            if hms.next().is_some()
                || !(0..24).contains(&h)
                || !(0..60).contains(&mi)
                || !(0.0..60.0).contains(&s)
            {
                return None;
            }
            h * 3600 + mi * 60 + s.round() as i64
        }
    };
    let base = if date1904 {
        days_from_civil(1904, 1, 1)
    } else {
        days_from_civil(1899, 12, 30)
    };
    let mut serial = days - base;
    if !date1904 && serial < 61 {
        // Before Excel's fictitious 1900-02-29.
        serial -= 1;
    }
    Some((serial as f64 + seconds as f64 / 86_400.0, time.is_some()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_serials_both_ways() {
        assert_eq!(
            to_text(46_323.0, Kind::Date, false).as_deref(),
            Some("2026-10-28")
        );
        assert_eq!(
            to_text(46_323.5, Kind::DateTime, false).as_deref(),
            Some("2026-10-28T12:00:00")
        );
        assert_eq!(
            to_text(0.75, Kind::Time, false).as_deref(),
            Some("18:00:00")
        );
        assert_eq!(
            to_text(1.0, Kind::Date, false).as_deref(),
            Some("1900-01-01")
        );
        assert_eq!(
            to_text(0.0, Kind::Date, true).as_deref(),
            Some("1904-01-01")
        );
        assert_eq!(from_text("2026-10-28", false), Some((46_323.0, false)));
        assert_eq!(from_text("2026/10/28 12:00", false), Some((46_323.5, true)));
        assert_eq!(from_text("1900-01-01", false), Some((1.0, false)));
        assert_eq!(from_text("2026-02-30", false), None);
        assert_eq!(from_text("令和8年", false), None);
    }

    #[test]
    fn recognises_date_formats() {
        assert_eq!(format_kind(14, ""), Some(Kind::Date));
        assert_eq!(format_kind(164, "yyyy/mm/dd"), Some(Kind::Date));
        assert_eq!(
            format_kind(164, "yyyy\"年\"m\"月\"d\"日\""),
            Some(Kind::Date)
        );
        assert_eq!(
            format_kind(164, "[$-411]ggge\"年\"m\"月\"d\"日\""),
            Some(Kind::Date)
        );
        assert_eq!(format_kind(164, "h:mm"), Some(Kind::Time));
        assert_eq!(format_kind(164, "[h]:mm:ss"), Some(Kind::Time));
        assert_eq!(format_kind(164, "yyyy/m/d h:mm"), Some(Kind::DateTime));
        assert_eq!(format_kind(0, "General"), None);
        assert_eq!(format_kind(164, "G/標準\"個\""), None);
        assert_eq!(format_kind(164, "#,##0\"円\""), None);
        assert_eq!(format_kind(164, "[Red]0.00"), None);
        assert_eq!(format_kind(10, "0.00%"), None);
    }
}

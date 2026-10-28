//! Dates as text: `2026-10-28` (date) or `2026-10-28T09:30:00` (local date
//! and time). Scenarios keep dates in variables as these ISO strings, so they
//! survive JSON, logs and Excel/CSV round trips unchanged.

use jiff::civil::{Date, DateTime, Time};
use jiff::{Span, Unit};

use super::ExprError;

/// A parsed date, remembering whether it had a time of day.
#[derive(Debug, Clone, Copy)]
pub struct When {
    pub at: DateTime,
    pub has_time: bool,
}

impl When {
    pub fn to_text(self) -> String {
        if self.has_time {
            self.at.strftime("%Y-%m-%dT%H:%M:%S").to_string()
        } else {
            self.at.date().strftime("%Y-%m-%d").to_string()
        }
    }
}

fn err(message: impl Into<String>) -> ExprError {
    ExprError::Type(message.into())
}

pub fn now() -> When {
    let at = jiff::Zoned::now().datetime();
    When {
        at: at.with().subsec_nanosecond(0).build().unwrap_or(at),
        has_time: true,
    }
}

pub fn today() -> When {
    When {
        at: jiff::Zoned::now().date().to_datetime(Time::midnight()),
        has_time: false,
    }
}

/// Era start dates, newest first: (name, first day).
const ERAS: &[(&str, i16, i8, i8)] = &[
    ("令和", 2019, 5, 1),
    ("平成", 1989, 1, 8),
    ("昭和", 1926, 12, 25),
    ("大正", 1912, 7, 30),
    ("明治", 1868, 1, 25),
];

fn era_of(date: Date) -> Option<(&'static str, i16)> {
    ERAS.iter().find_map(|(name, y, m, d)| {
        let start = Date::new(*y, *m, *d).ok()?;
        (date >= start).then(|| (*name, date.year() - *y + 1))
    })
}

const WEEKDAYS: [&str; 7] = ["月", "火", "水", "木", "金", "土", "日"];

/// Pattern tokens, longest first so `yyyy` wins over `yy`.
const TOKENS: &[&str] = &[
    "yyyy", "dddd", "ddd", "yy", "MM", "dd", "HH", "mm", "ss", "gg", "ee", "M", "d", "H", "e",
];

fn tokens(pattern: &str) -> Vec<Result<&'static str, char>> {
    let mut out = Vec::new();
    let mut rest = pattern;
    while let Some(c) = rest.chars().next() {
        if let Some(tok) = TOKENS.iter().find(|t| rest.starts_with(**t)) {
            out.push(Ok(*tok));
            rest = &rest[tok.len()..];
        } else {
            out.push(Err(c));
            rest = &rest[c.len_utf8()..];
        }
    }
    out
}

/// `formatDate('2026-10-28', 'yyyy年M月d日(ddd)')` → `2026年10月28日(水)`.
pub fn format(when: When, pattern: &str) -> Result<String, ExprError> {
    let at = when.at;
    let mut out = String::new();
    for tok in tokens(pattern) {
        match tok {
            Err(c) => out.push(c),
            Ok("yyyy") => out.push_str(&format!("{:04}", at.year())),
            Ok("yy") => out.push_str(&format!("{:02}", at.year().rem_euclid(100))),
            Ok("MM") => out.push_str(&format!("{:02}", at.month())),
            Ok("M") => out.push_str(&at.month().to_string()),
            Ok("dd") => out.push_str(&format!("{:02}", at.day())),
            Ok("d") => out.push_str(&at.day().to_string()),
            Ok(t @ ("ddd" | "dddd")) => {
                out.push_str(WEEKDAYS[at.weekday().to_monday_zero_offset() as usize]);
                if t == "dddd" {
                    out.push_str("曜日");
                }
            }
            Ok("HH") => out.push_str(&format!("{:02}", at.hour())),
            Ok("H") => out.push_str(&at.hour().to_string()),
            Ok("mm") => out.push_str(&format!("{:02}", at.minute())),
            Ok("ss") => out.push_str(&format!("{:02}", at.second())),
            Ok(t) => {
                let (name, year) = era_of(at.date())
                    .ok_or_else(|| err("formatDate(): no Japanese era before 1868"))?;
                match t {
                    "gg" => out.push_str(name),
                    "ee" => out.push_str(&format!("{year:02}")),
                    _ => out.push_str(&year.to_string()),
                }
            }
        }
    }
    Ok(out)
}

fn build(
    (y, mo, d): (i64, i64, i64),
    (h, mi, s): (i64, i64, i64),
    has_time: bool,
    source: &str,
) -> Result<When, ExprError> {
    let bad = || err(format!("not a valid date: '{source}'"));
    let small = |n: i64| i8::try_from(n).map_err(|_| bad());
    let year = i16::try_from(y).map_err(|_| bad())?;
    let date = Date::new(year, small(mo)?, small(d)?).map_err(|_| bad())?;
    let time = Time::new(small(h)?, small(mi)?, small(s)?, 0).map_err(|_| bad())?;
    Ok(When {
        at: date.to_datetime(time),
        has_time,
    })
}

/// Reads a date without a pattern: ISO (`2026-10-28`, `2026-10-28T09:30`,
/// with `Z` or an offset), `2026/10/28 9:30`, `2026.10.28`, `2026年10月28日`.
pub fn parse(source: &str) -> Result<When, ExprError> {
    let s = source.trim();
    if (s.ends_with('Z') || s.get(19..).is_some_and(|tail| tail.contains(['+', '-'])))
        && let Ok(ts) = s.parse::<jiff::Timestamp>()
    {
        return Ok(When {
            at: ts.to_zoned(jiff::tz::TimeZone::system()).datetime(),
            has_time: true,
        });
    }
    let mut nums: Vec<i64> = Vec::new();
    let mut current = String::new();
    for c in s.chars() {
        if c.is_ascii_digit() {
            current.push(c);
        } else {
            if !current.is_empty() {
                nums.push(
                    current
                        .parse()
                        .map_err(|_| err(format!("not a date: '{source}'")))?,
                );
                current.clear();
            }
            if !matches!(
                c,
                '-' | '/' | '.' | ':' | ' ' | 'T' | '年' | '月' | '日' | '時' | '分' | '秒'
            ) {
                return Err(err(format!(
                    "not a date: '{source}' (give the format, e.g. parseDate(s, 'yyyy/MM/dd'))"
                )));
            }
        }
    }
    if !current.is_empty() {
        nums.push(
            current
                .parse()
                .map_err(|_| err(format!("not a date: '{source}'")))?,
        );
    }
    match nums.as_slice() {
        [y, m, d] => build((*y, *m, *d), (0, 0, 0), false, source),
        [y, m, d, h, mi] => build((*y, *m, *d), (*h, *mi, 0), true, source),
        [y, m, d, h, mi, sec] => build((*y, *m, *d), (*h, *mi, *sec), true, source),
        // Fractional seconds from an ISO timestamp are dropped.
        [y, m, d, h, mi, sec, _] => build((*y, *m, *d), (*h, *mi, *sec), true, source),
        _ => Err(err(format!(
            "not a date: '{source}' (give the format, e.g. parseDate(s, 'yyyy/MM/dd'))"
        ))),
    }
}

/// Reads a date laid out as `pattern` (same tokens as [`format`]; `gg` +
/// `e`/`ee` read a Japanese era date such as `令和8年10月28日`).
pub fn parse_with(source: &str, pattern: &str) -> Result<When, ExprError> {
    let mismatch = || err(format!("'{source}' does not match the format '{pattern}'"));
    let mut rest = source.trim();
    let (mut y, mut mo, mut d, mut h, mut mi, mut sec) = (None, 1, 1, 0, 0, 0);
    let mut era: Option<i16> = None;
    let mut era_year = None;
    let mut has_time = false;
    let take_digits = |rest: &mut &str, max: usize| -> Option<i64> {
        let n = rest
            .chars()
            .take(max)
            .take_while(char::is_ascii_digit)
            .count();
        if n == 0 {
            return None;
        }
        let value = rest[..n].parse().ok();
        *rest = &rest[n..];
        value
    };
    for tok in tokens(pattern) {
        match tok {
            Err(c) => {
                rest = rest.strip_prefix(c).ok_or_else(mismatch)?;
            }
            Ok("yyyy") => y = Some(take_digits(&mut rest, 4).ok_or_else(mismatch)?),
            Ok("yy") => y = Some(2000 + take_digits(&mut rest, 2).ok_or_else(mismatch)?),
            Ok("MM" | "M") => mo = take_digits(&mut rest, 2).ok_or_else(mismatch)?,
            Ok("dd" | "d") => d = take_digits(&mut rest, 2).ok_or_else(mismatch)?,
            Ok("HH" | "H") => {
                h = take_digits(&mut rest, 2).ok_or_else(mismatch)?;
                has_time = true;
            }
            Ok("mm") => {
                mi = take_digits(&mut rest, 2).ok_or_else(mismatch)?;
                has_time = true;
            }
            Ok("ss") => {
                sec = take_digits(&mut rest, 2).ok_or_else(mismatch)?;
                has_time = true;
            }
            Ok("ddd" | "dddd") => {
                let day = WEEKDAYS
                    .iter()
                    .find(|w| rest.starts_with(**w))
                    .ok_or_else(mismatch)?;
                rest = &rest[day.len()..];
                rest = rest.strip_prefix("曜日").unwrap_or(rest);
            }
            Ok("gg") => {
                let (name, start, ..) = ERAS
                    .iter()
                    .find(|(name, ..)| rest.starts_with(name))
                    .ok_or_else(mismatch)?;
                era = Some(*start);
                rest = &rest[name.len()..];
            }
            Ok(_) => {
                era_year = Some(if let Some(r) = rest.strip_prefix('元') {
                    rest = r;
                    1
                } else {
                    take_digits(&mut rest, 2).ok_or_else(mismatch)?
                });
            }
        }
    }
    if !rest.is_empty() {
        return Err(mismatch());
    }
    let year = match (y, era, era_year) {
        (Some(y), _, _) => y,
        (None, Some(start), Some(n)) => i64::from(start) + n - 1,
        _ => {
            return Err(err(format!(
                "the format '{pattern}' has no year (yyyy or gg+e)"
            )));
        }
    };
    build((year, mo, d), (h, mi, sec), has_time, source)
}

fn span(amount: i64, unit: &str) -> Result<(Span, bool), ExprError> {
    let too_big = |_| err("dateAdd(): amount out of range");
    Ok(match unit {
        "year" | "years" => (Span::new().try_years(amount).map_err(too_big)?, false),
        "month" | "months" => (Span::new().try_months(amount).map_err(too_big)?, false),
        "week" | "weeks" => (Span::new().try_weeks(amount).map_err(too_big)?, false),
        "day" | "days" => (Span::new().try_days(amount).map_err(too_big)?, false),
        "hour" | "hours" => (Span::new().try_hours(amount).map_err(too_big)?, true),
        "minute" | "minutes" => (Span::new().try_minutes(amount).map_err(too_big)?, true),
        "second" | "seconds" => (Span::new().try_seconds(amount).map_err(too_big)?, true),
        other => return Err(unknown_unit(other)),
    })
}

fn unknown_unit(unit: &str) -> ExprError {
    err(format!(
        "unknown unit '{unit}' (use year, month, week, day, hour, minute or second)"
    ))
}

/// Adds `amount` units. Month and year steps clamp to the month's last day
/// (`2026-01-31` + 1 month = `2026-02-28`).
pub fn add(when: When, amount: i64, unit: &str) -> Result<When, ExprError> {
    let (span, timed) = span(amount, unit)?;
    let at = when
        .at
        .checked_add(span)
        .map_err(|_| err("dateAdd(): result out of range"))?;
    Ok(When {
        at,
        has_time: when.has_time || timed,
    })
}

/// Whole `unit`s from `a` to `b` (negative when `b` is earlier), rounded toward zero.
pub fn diff(a: When, b: When, unit: &str) -> Result<i64, ExprError> {
    let (largest, get): (Unit, fn(&Span) -> i64) = match unit {
        "year" | "years" => (Unit::Year, |s| i64::from(s.get_years())),
        "month" | "months" => (Unit::Month, |s| {
            i64::from(s.get_years()) * 12 + i64::from(s.get_months())
        }),
        "week" | "weeks" => (Unit::Week, |s| i64::from(s.get_weeks())),
        "day" | "days" => (Unit::Day, |s| i64::from(s.get_days())),
        "hour" | "hours" => (Unit::Hour, |s| i64::from(s.get_hours())),
        "minute" | "minutes" => (Unit::Minute, Span::get_minutes),
        "second" | "seconds" => (Unit::Second, Span::get_seconds),
        other => return Err(unknown_unit(other)),
    };
    let span =
        a.at.until((largest, b.at))
            .map_err(|e| err(format!("dateDiff(): {e}")))?;
    Ok(get(&span))
}

pub fn end_of_month(when: When) -> When {
    When {
        at: when.at.date().last_of_month().to_datetime(Time::midnight()),
        has_time: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> When {
        parse(s).unwrap()
    }

    #[test]
    fn parses_common_layouts() {
        assert_eq!(d("2026-10-28").to_text(), "2026-10-28");
        assert_eq!(d("2026/1/5 9:30").to_text(), "2026-01-05T09:30:00");
        assert_eq!(d("2026年10月28日").to_text(), "2026-10-28");
        assert_eq!(
            d("2026-10-28T09:30:15.250").to_text(),
            "2026-10-28T09:30:15"
        );
        assert!(parse("10/28").is_err());
        assert!(parse("2026-02-30").is_err());
        assert_eq!(
            parse_with("令和8年10月28日", "gge年M月d日")
                .unwrap()
                .to_text(),
            "2026-10-28"
        );
        assert_eq!(
            parse_with("令和元年5月1日", "gge年M月d日")
                .unwrap()
                .to_text(),
            "2019-05-01"
        );
        assert_eq!(
            parse_with("28/10/26 07:05", "dd/MM/yy HH:mm")
                .unwrap()
                .to_text(),
            "2026-10-28T07:05:00"
        );
        assert!(parse_with("2026-10", "yyyy/MM").is_err());
    }

    #[test]
    fn formats_and_calculates() {
        let w = d("2026-10-28T07:05:09");
        assert_eq!(
            format(w, "yyyy/MM/dd HH:mm:ss").unwrap(),
            "2026/10/28 07:05:09"
        );
        assert_eq!(format(w, "M月d日(ddd)").unwrap(), "10月28日(水)");
        assert_eq!(format(w, "ggee年").unwrap(), "令和08年");
        assert_eq!(format(w, "gge年").unwrap(), "令和8年");
        assert_eq!(
            add(d("2026-01-31"), 1, "month").unwrap().to_text(),
            "2026-02-28"
        );
        assert_eq!(
            add(d("2026-03-01"), -1, "day").unwrap().to_text(),
            "2026-02-28"
        );
        assert_eq!(
            add(d("2026-03-01"), 90, "minute").unwrap().to_text(),
            "2026-03-01T01:30:00"
        );
        assert_eq!(diff(d("2026-01-01"), d("2026-03-01"), "day").unwrap(), 59);
        assert_eq!(diff(d("2026-03-01"), d("2026-01-01"), "month").unwrap(), -2);
        assert_eq!(diff(d("2000-04-01"), d("2026-03-31"), "year").unwrap(), 25);
        assert_eq!(end_of_month(d("2028-02-10")).to_text(), "2028-02-29");
        assert!(add(d("2026-01-01"), 1, "fortnight").is_err());
    }
}

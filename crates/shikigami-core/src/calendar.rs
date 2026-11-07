//! Business days: Japan's national holidays (built in) and the company's
//! own days off and working days (`holidays.json` at the workspace root).
//!
//! ```json
//! { "formatVersion": 1, "holidays": ["2026-12-29", "2026-12-30"], "workdays": ["2026-11-03"] }
//! ```
//!
//! A business day is a weekday that is neither a national holiday nor one
//! of `holidays`, or a day in `workdays` (a Saturday the office opens).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use jiff::civil::{Date, Weekday, date};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{CoreError, CoreResult};

pub const HOLIDAYS_FILE: &str = "holidays.json";
pub const HOLIDAYS_FORMAT_VERSION: u32 = 1;

/// `holidays.json` as written.
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HolidaysFile {
    #[serde(default = "format_version")]
    pub format_version: u32,
    /// Days off besides national holidays ("2026-12-29": year-end, the
    /// founding day, …).
    #[serde(default)]
    pub holidays: Vec<String>,
    /// Days that are business days although they are weekends or national
    /// holidays.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub workdays: Vec<String>,
}

fn format_version() -> u32 {
    HOLIDAYS_FORMAT_VERSION
}

/// The company's days off and working days, read from `holidays.json`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Calendar {
    pub holidays: BTreeSet<Date>,
    pub workdays: BTreeSet<Date>,
}

impl Calendar {
    pub fn path(root: &Path) -> PathBuf {
        root.join(HOLIDAYS_FILE)
    }

    /// Reads `holidays.json`; without it only national holidays count.
    pub fn load(path: &Path) -> CoreResult<Self> {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(e.into()),
        };
        let invalid = |message: String| {
            CoreError::Rejected {
            code: "HOLIDAYS_INVALID",
            message: format!("{}: {message}", path.display()),
            hint: Some(
                "Write the days as \"2026-12-29\" in `holidays` and `workdays` (docs/schedules.md)."
                    .into(),
            ),
        }
        };
        let file: HolidaysFile =
            serde_json::from_slice(&bytes).map_err(|e| invalid(e.to_string()))?;
        if file.format_version > HOLIDAYS_FORMAT_VERSION {
            return Err(invalid(format!(
                "formatVersion {} is newer than this Shikigami understands",
                file.format_version
            )));
        }
        let days = |list: &[String]| -> CoreResult<BTreeSet<Date>> {
            list.iter()
                .map(|d| {
                    d.trim()
                        .parse::<Date>()
                        .map_err(|_| invalid(format!("'{d}' is not a date like 2026-12-29")))
                })
                .collect()
        };
        Ok(Self {
            holidays: days(&file.holidays)?,
            workdays: days(&file.workdays)?,
        })
    }

    /// A day off that is not a weekend: a national holiday or one of the
    /// company's, unless it is a working day.
    pub fn is_holiday(&self, day: Date) -> bool {
        !self.workdays.contains(&day)
            && (self.holidays.contains(&day) || national_holiday(day).is_some())
    }

    pub fn is_business_day(&self, day: Date) -> bool {
        self.workdays.contains(&day)
            || (!matches!(day.weekday(), Weekday::Saturday | Weekday::Sunday)
                && !self.is_holiday(day))
    }

    /// The business days of the month of `day`, in order.
    pub fn business_days_of_month(&self, day: Date) -> Vec<Date> {
        let first = day.first_of_month();
        first
            .series(jiff::Span::new().days(1))
            .take_while(|d| d.month() == first.month())
            .filter(|d| self.is_business_day(*d))
            .collect()
    }

    /// The nearest business day on or before (`later` false) or on or
    /// after `day`, looking at most 30 days.
    pub fn nearest_business_day(&self, day: Date, later: bool) -> Option<Date> {
        let mut d = day;
        for _ in 0..30 {
            if self.is_business_day(d) {
                return Some(d);
            }
            d = if later {
                d.tomorrow().ok()?
            } else {
                d.yesterday().ok()?
            };
        }
        None
    }
}

/// The nth `weekday` of a month (1 = the first).
fn nth(year: i16, month: i8, weekday: Weekday, n: i8) -> Date {
    date(year, month, 1)
        .nth_weekday_of_month(n, weekday)
        .unwrap_or_else(|_| date(year, month, 1))
}

/// 春分の日 and 秋分の日 by the usual formula (1980–2099).
fn equinox(year: i16, autumn: bool) -> i8 {
    let y = f64::from(year - 1980);
    let base = if autumn { 23.2488 } else { 20.8431 };
    let day = (base + 0.242194 * y - (y / 4.0).floor()).floor();
    day as i8
}

/// Holidays fixed by the law, before substitutes and days between two.
fn listed_holiday(day: Date) -> Option<&'static str> {
    let (y, m, d) = (day.year(), day.month(), day.day());
    let monday = |month: i8, n: i8| day == nth(y, month, Weekday::Monday, n);
    Some(match (m, d) {
        (1, 1) => "元日",
        (1, _) if monday(1, 2) => "成人の日",
        (2, 11) => "建国記念の日",
        (2, 23) if y >= 2020 => "天皇誕生日",
        (3, _) if d == equinox(y, false) => "春分の日",
        (4, 29) => "昭和の日",
        (5, 3) => "憲法記念日",
        (5, 4) => "みどりの日",
        (5, 5) => "こどもの日",
        // The Tokyo Olympics moved three holidays in 2020 and 2021.
        (7, 23) if y == 2020 => "海の日",
        (7, 24) if y == 2020 => "スポーツの日",
        (8, 10) if y == 2020 => "山の日",
        (7, 22) if y == 2021 => "海の日",
        (7, 23) if y == 2021 => "スポーツの日",
        (8, 8) if y == 2021 => "山の日",
        (7, _) if y != 2020 && y != 2021 && monday(7, 3) => "海の日",
        (8, 11) if y != 2020 && y != 2021 => "山の日",
        (9, _) if monday(9, 3) => "敬老の日",
        (9, _) if d == equinox(y, true) => "秋分の日",
        (10, _) if y != 2020 && y != 2021 && monday(10, 2) => "スポーツの日",
        (11, 3) => "文化の日",
        (11, 23) => "勤労感謝の日",
        (12, 23) if (1989..=2018).contains(&y) => "天皇誕生日",
        _ => return None,
    })
}

/// The name of the national holiday on `day` ("元日", "振替休日", …), by
/// today's law (the names and days since 2020; earlier years as they are
/// counted now).
pub fn national_holiday(day: Date) -> Option<&'static str> {
    if let Some(name) = listed_holiday(day) {
        return Some(name);
    }
    // 振替休日: a holiday on a Sunday moves to the next day that is not one.
    let mut d = day;
    while let Ok(before) = d.yesterday() {
        if listed_holiday(before).is_none() {
            break;
        }
        if before.weekday() == Weekday::Sunday {
            return Some("振替休日");
        }
        d = before;
    }
    // 国民の休日: a day between two holidays (September's silver week).
    if day.weekday() != Weekday::Sunday
        && let (Ok(before), Ok(after)) = (day.yesterday(), day.tomorrow())
        && listed_holiday(before).is_some()
        && listed_holiday(after).is_some()
    {
        return Some("国民の休日");
    }
    None
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn holidays(year: i16) -> Vec<String> {
        date(year, 1, 1)
            .series(jiff::Span::new().days(1))
            .take_while(|d| d.year() == year)
            .filter_map(|d| national_holiday(d).map(|n| format!("{} {n}", d.strftime("%m-%d"))))
            .collect()
    }

    #[test]
    fn the_holidays_of_2026() {
        // The Cabinet Office's list for 2026.
        assert_eq!(
            holidays(2026),
            [
                "01-01 元日",
                "01-12 成人の日",
                "02-11 建国記念の日",
                "02-23 天皇誕生日",
                "03-20 春分の日",
                "04-29 昭和の日",
                "05-03 憲法記念日",
                "05-04 みどりの日",
                "05-05 こどもの日",
                "05-06 振替休日",
                "07-20 海の日",
                "08-11 山の日",
                "09-21 敬老の日",
                "09-22 国民の休日",
                "09-23 秋分の日",
                "10-12 スポーツの日",
                "11-03 文化の日",
                "11-23 勤労感謝の日",
            ]
        );
    }

    #[test]
    fn the_holidays_of_2025_and_2027() {
        let y2025 = holidays(2025);
        for day in [
            "01-13 成人の日",
            "02-24 振替休日",
            "03-20 春分の日",
            "05-06 振替休日",
            "08-11 山の日",
            "09-15 敬老の日",
            "09-23 秋分の日",
            "11-24 振替休日",
        ] {
            assert!(y2025.contains(&day.to_owned()), "{day} in {y2025:?}");
        }
        assert_eq!(y2025.len(), 19);
        let y2027 = holidays(2027);
        for day in [
            "03-21 春分の日",
            "03-22 振替休日",
            "09-20 敬老の日",
            "09-23 秋分の日",
        ] {
            assert!(y2027.contains(&day.to_owned()), "{day} in {y2027:?}");
        }
        assert!(holidays(2021).contains(&"07-23 スポーツの日".to_owned()));
    }

    #[test]
    fn the_company_calendar_adds_days_off_and_working_days() {
        let mut c = Calendar::default();
        assert!(!c.is_business_day(date(2026, 11, 3)));
        assert!(!c.is_business_day(date(2026, 11, 7)));
        assert!(c.is_business_day(date(2026, 12, 29)));
        c.holidays.insert(date(2026, 12, 29));
        c.workdays.insert(date(2026, 11, 3));
        assert!(!c.is_business_day(date(2026, 12, 29)));
        assert!(c.is_business_day(date(2026, 11, 3)));
        // November 2026: 2nd is the first business day, 30th the last.
        let days = c.business_days_of_month(date(2026, 11, 15));
        assert_eq!(days.first(), Some(&date(2026, 11, 2)));
        assert_eq!(days.last(), Some(&date(2026, 11, 30)));
        assert_eq!(
            c.nearest_business_day(date(2026, 11, 22), false),
            Some(date(2026, 11, 20))
        );
        assert_eq!(
            c.nearest_business_day(date(2026, 11, 22), true),
            Some(date(2026, 11, 24))
        );

        let tmp = tempfile::tempdir().unwrap();
        let path = Calendar::path(tmp.path());
        assert_eq!(Calendar::load(&path).unwrap(), Calendar::default());
        std::fs::write(
            &path,
            r#"{ "holidays": ["2026-12-29"], "workdays": ["2026-11-03"] }"#,
        )
        .unwrap();
        let loaded = Calendar::load(&path).unwrap();
        assert!(loaded.holidays.contains(&date(2026, 12, 29)));
        std::fs::write(&path, r#"{ "holidays": ["12/29"] }"#).unwrap();
        assert!(Calendar::load(&path).is_err());
    }
}

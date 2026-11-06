//! Schedules: when the agent starts a scenario by itself.
//!
//! ```text
//! <per-PC area>/schedules.json        what to run when (edited by Studio and the CLI)
//! <per-PC area>/agent/state.json      when each schedule last fired (the agent's)
//! ```
//!
//! Schedules belong to the PC that runs them, not to the shared workspace:
//! when several PCs share a workspace folder, only the PC a schedule was
//! made on runs it. Times are the PC's local time.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use jiff::civil::{Date, Time, Weekday};
use jiff::{ToSpan, Zoned};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use shikigami_core::{CoreError, CoreResult, ScenarioId};

pub const SCHEDULES_FILE: &str = "schedules.json";
pub const SCHEDULES_FORMAT_VERSION: u32 = 1;

/// When a schedule fires.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum When {
    /// Every day at `at` ("08:00"), or only on `days` ("mon" … "sun").
    Daily {
        at: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        days: Vec<String>,
    },
    /// Every month on `day` (1–31; -1 is the last day) at `at`. A day the
    /// month does not have (31 in June) is its last day.
    Monthly { day: i8, at: String },
    /// Every `minutes` minutes, between `from` and `to` ("09:00"–"18:00")
    /// when given, on `days` when given.
    Every {
        minutes: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        to: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        days: Vec<String>,
    },
    /// Once, at a local date and time ("2026-11-07T08:00").
    Once { at: String },
    /// When a file appears in `folder` (relative to the scenario's folder,
    /// or a full path) whose name matches `pattern` ("*.xlsx"). Each new
    /// file starts one run, with its full path in the input variable
    /// `input` when given. Files already there when the agent starts do not.
    FileAdded {
        folder: String,
        #[serde(default = "any_file")]
        pattern: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input: Option<String>,
    },
}

fn any_file() -> String {
    "*".into()
}

/// One schedule.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    /// `sch_…`, made when the schedule is added.
    pub id: String,
    /// What people call it ("毎朝の受注取り込み").
    pub name: String,
    pub scenario_id: ScenarioId,
    #[serde(default = "yes")]
    pub enabled: bool,
    pub when: When,
    /// Values for the scenario's input variables.
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub inputs: Map<String, Value>,
}

fn yes() -> bool {
    true
}

/// `schedules.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Schedules {
    #[serde(default = "format_version")]
    pub format_version: u32,
    #[serde(default)]
    pub schedules: Vec<Schedule>,
}

fn format_version() -> u32 {
    SCHEDULES_FORMAT_VERSION
}

impl Default for Schedules {
    fn default() -> Self {
        Self {
            format_version: SCHEDULES_FORMAT_VERSION,
            schedules: Vec::new(),
        }
    }
}

fn invalid(path: &Path, message: impl std::fmt::Display) -> CoreError {
    CoreError::Rejected {
        code: "SCHEDULE_INVALID",
        message: format!("{}: {message}", path.display()),
        hint: Some(
            "Fix the schedule (see docs/schedules.md) or check it with `shikigami schedule list`."
                .into(),
        ),
    }
}

impl Schedules {
    pub fn path(local_root: &Path) -> PathBuf {
        local_root.join(SCHEDULES_FILE)
    }

    /// Reads `schedules.json`; a missing file has no schedules.
    pub fn load(path: &Path) -> CoreResult<Self> {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(e.into()),
        };
        let schedules: Self = serde_json::from_slice(&bytes).map_err(|e| invalid(path, e))?;
        if schedules.format_version > SCHEDULES_FORMAT_VERSION {
            return Err(invalid(
                path,
                format!(
                    "formatVersion {} is newer than this Shikigami understands",
                    schedules.format_version
                ),
            ));
        }
        for s in &schedules.schedules {
            if let Some(problem) = s.when.problem() {
                return Err(invalid(path, format!("{} ({}): {problem}", s.name, s.id)));
            }
        }
        Ok(schedules)
    }

    pub fn save(&self, path: &Path) -> CoreResult<()> {
        let mut json = serde_json::to_vec_pretty(self).map_err(|e| invalid(path, e))?;
        json.push(b'\n');
        shikigami_core::store::write_atomic(path, &json)
    }

    pub fn get(&self, id: &str) -> Option<&Schedule> {
        self.schedules.iter().find(|s| s.id == id)
    }
}

/// A new schedule ID.
pub fn new_id() -> String {
    format!("sch_{}", uuid::Uuid::now_v7().simple())
}

pub(crate) fn parse_time(text: &str) -> Option<Time> {
    let (h, m) = text.trim().split_once(':')?;
    let (h, m): (i8, i8) = (h.parse().ok()?, m.parse().ok()?);
    Time::new(h, m, 0, 0).ok()
}

fn parse_day(text: &str) -> Option<Weekday> {
    Some(match text.trim().to_ascii_lowercase().as_str() {
        "mon" | "月" => Weekday::Monday,
        "tue" | "火" => Weekday::Tuesday,
        "wed" | "水" => Weekday::Wednesday,
        "thu" | "木" => Weekday::Thursday,
        "fri" | "金" => Weekday::Friday,
        "sat" | "土" => Weekday::Saturday,
        "sun" | "日" => Weekday::Sunday,
        _ => return None,
    })
}

fn on_days(days: &[String], date: Date) -> bool {
    days.is_empty()
        || days
            .iter()
            .filter_map(|d| parse_day(d))
            .any(|d| d == date.weekday())
}

impl When {
    /// What is wrong with it, if anything.
    pub fn problem(&self) -> Option<String> {
        let time = |t: &str| {
            parse_time(t)
                .is_none()
                .then(|| format!("'{t}' is not a time like 08:00"))
        };
        let days = |days: &[String]| {
            days.iter()
                .find(|d| parse_day(d).is_none())
                .map(|d| format!("'{d}' is not a day (mon, tue, wed, thu, fri, sat, sun)"))
        };
        match self {
            Self::Daily { at, days: d } => time(at).or_else(|| days(d)),
            Self::Monthly { day, at } => {
                if *day == 0 || *day > 31 || *day < -1 {
                    Some(format!("day {day} must be 1–31 or -1 (the last day)"))
                } else {
                    time(at)
                }
            }
            Self::Every {
                minutes,
                from,
                to,
                days: d,
            } => {
                if *minutes == 0 {
                    return Some("minutes must be at least 1".into());
                }
                from.as_deref()
                    .and_then(time)
                    .or_else(|| to.as_deref().and_then(time))
                    .or_else(|| days(d))
            }
            Self::Once { at } => at
                .parse::<jiff::civil::DateTime>()
                .is_err()
                .then(|| format!("'{at}' is not a date and time like 2026-11-07T08:00")),
            Self::FileAdded { folder, .. } => folder
                .trim()
                .is_empty()
                .then(|| "folder is empty".to_owned()),
        }
    }

    /// The first time after `after` it fires (`None`: never again, or a
    /// file trigger, which has no times).
    pub fn next_after(&self, after: &Zoned) -> Option<Zoned> {
        let tz = after.time_zone().clone();
        let at_on = |date: Date, time: Time| date.to_datetime(time).to_zoned(tz.clone()).ok();
        match self {
            Self::Daily { at, days } => {
                let time = parse_time(at)?;
                let mut date = after.date();
                for _ in 0..8 {
                    if on_days(days, date)
                        && let Some(t) = at_on(date, time)
                        && t > *after
                    {
                        return Some(t);
                    }
                    date = date.tomorrow().ok()?;
                }
                None
            }
            Self::Monthly { day, at } => {
                let time = parse_time(at)?;
                let mut month = after.date().first_of_month();
                for _ in 0..3 {
                    let last = month.last_of_month();
                    let date = if *day == -1 || i16::from(*day) > i16::from(last.day()) {
                        last
                    } else {
                        month.with().day(*day).build().ok()?
                    };
                    if let Some(t) = at_on(date, time)
                        && t > *after
                    {
                        return Some(t);
                    }
                    month = month.checked_add(1.month()).ok()?;
                }
                None
            }
            Self::Every {
                minutes,
                from,
                to,
                days,
            } => {
                let start = from
                    .as_deref()
                    .and_then(parse_time)
                    .unwrap_or(Time::midnight());
                let end = to.as_deref().and_then(parse_time);
                let step = i64::from(*minutes);
                let mut date = after.date();
                for _ in 0..8 {
                    if on_days(days, date) {
                        // Times of the day: start, start + step, … until `to`.
                        let first = at_on(date, start)?;
                        let mut t = if first > *after {
                            first
                        } else {
                            let since = after.duration_since(&first).as_secs() / 60;
                            let n = since / step + 1;
                            first.checked_add((n * step).minutes()).ok()?
                        };
                        if t <= *after {
                            t = t.checked_add(step.minutes()).ok()?;
                        }
                        let in_day = t.date() == date && end.is_none_or(|end| t.time() <= end);
                        if in_day {
                            return Some(t);
                        }
                    }
                    date = date.tomorrow().ok()?;
                }
                None
            }
            Self::Once { at } => {
                let t = at
                    .parse::<jiff::civil::DateTime>()
                    .ok()?
                    .to_zoned(tz)
                    .ok()?;
                (t > *after).then_some(t)
            }
            Self::FileAdded { .. } => None,
        }
    }
}

/// When each schedule last fired, so a restarted agent neither repeats a
/// run nor makes up for the ones it missed while it was off.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleState {
    /// Schedule ID → when it last fired (RFC 3339).
    #[serde(default)]
    pub last_fired: BTreeMap<String, String>,
}

impl ScheduleState {
    pub fn path(local_root: &Path) -> PathBuf {
        local_root.join("agent").join("state.json")
    }

    pub fn load(path: &Path) -> Self {
        std::fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_vec_pretty(self)
            && let Err(e) = shikigami_core::store::write_atomic(path, &json)
        {
            tracing::warn!(error = %e, "could not save the schedule state");
        }
    }

    pub fn last(&self, id: &str) -> Option<Zoned> {
        let ts: jiff::Timestamp = self.last_fired.get(id)?.parse().ok()?;
        Some(ts.to_zoned(jiff::tz::TimeZone::system()))
    }
}

/// `*` and `?` file name patterns, without case (Windows file names).
pub fn name_matches(pattern: &str, name: &str) -> bool {
    fn go(p: &[char], n: &[char]) -> bool {
        match (p.first(), n.first()) {
            (None, None) => true,
            (Some('*'), _) => go(&p[1..], n) || (!n.is_empty() && go(p, &n[1..])),
            (Some('?'), Some(_)) => go(&p[1..], &n[1..]),
            (Some(a), Some(b)) => a == b && go(&p[1..], &n[1..]),
            _ => false,
        }
    }
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let n: Vec<char> = name.to_lowercase().chars().collect();
    go(&p, &n)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn at(text: &str) -> Zoned {
        text.parse::<jiff::civil::DateTime>()
            .unwrap()
            .to_zoned(jiff::tz::TimeZone::UTC)
            .unwrap()
    }

    fn next(when: &When, after: &str) -> Option<String> {
        when.next_after(&at(after))
            .map(|t| t.datetime().strftime("%Y-%m-%d %a %H:%M").to_string())
    }

    #[test]
    fn daily_on_weekdays() {
        let w = When::Daily {
            at: "08:00".into(),
            days: vec![
                "mon".into(),
                "tue".into(),
                "wed".into(),
                "thu".into(),
                "fri".into(),
            ],
        };
        // 2026-11-06 is a Friday.
        assert_eq!(
            next(&w, "2026-11-06T07:59").as_deref(),
            Some("2026-11-06 Fri 08:00")
        );
        assert_eq!(
            next(&w, "2026-11-06T08:00").as_deref(),
            Some("2026-11-09 Mon 08:00")
        );
        let every_day = When::Daily {
            at: "08:00".into(),
            days: vec![],
        };
        assert_eq!(
            next(&every_day, "2026-11-06T09:00").as_deref(),
            Some("2026-11-07 Sat 08:00")
        );
    }

    #[test]
    fn monthly_including_the_last_day() {
        let w = When::Monthly {
            day: 25,
            at: "09:30".into(),
        };
        assert_eq!(
            next(&w, "2026-11-06T00:00").as_deref(),
            Some("2026-11-25 Wed 09:30")
        );
        assert_eq!(
            next(&w, "2026-11-25T09:30").as_deref(),
            Some("2026-12-25 Fri 09:30")
        );
        let last = When::Monthly {
            day: -1,
            at: "18:00".into(),
        };
        assert_eq!(
            next(&last, "2027-02-01T00:00").as_deref(),
            Some("2027-02-28 Sun 18:00")
        );
        let day31 = When::Monthly {
            day: 31,
            at: "18:00".into(),
        };
        assert_eq!(
            next(&day31, "2026-11-01T00:00").as_deref(),
            Some("2026-11-30 Mon 18:00")
        );
    }

    #[test]
    fn every_few_minutes_within_hours() {
        let w = When::Every {
            minutes: 30,
            from: Some("09:00".into()),
            to: Some("18:00".into()),
            days: vec![],
        };
        assert_eq!(
            next(&w, "2026-11-06T07:00").as_deref(),
            Some("2026-11-06 Fri 09:00")
        );
        assert_eq!(
            next(&w, "2026-11-06T09:00").as_deref(),
            Some("2026-11-06 Fri 09:30")
        );
        assert_eq!(
            next(&w, "2026-11-06T09:10").as_deref(),
            Some("2026-11-06 Fri 09:30")
        );
        assert_eq!(
            next(&w, "2026-11-06T17:45").as_deref(),
            Some("2026-11-06 Fri 18:00")
        );
        assert_eq!(
            next(&w, "2026-11-06T18:00").as_deref(),
            Some("2026-11-07 Sat 09:00")
        );
        let all_day = When::Every {
            minutes: 15,
            from: None,
            to: None,
            days: vec![],
        };
        assert_eq!(
            next(&all_day, "2026-11-06T23:50").as_deref(),
            Some("2026-11-07 Sat 00:00")
        );
    }

    #[test]
    fn once_and_problems() {
        let w = When::Once {
            at: "2026-11-07T08:00".into(),
        };
        assert_eq!(
            next(&w, "2026-11-06T00:00").as_deref(),
            Some("2026-11-07 Sat 08:00")
        );
        assert_eq!(next(&w, "2026-11-07T08:00"), None);
        assert!(
            When::Daily {
                at: "8時".into(),
                days: vec![]
            }
            .problem()
            .is_some()
        );
        assert!(
            When::Daily {
                at: "8:00".into(),
                days: vec!["月".into()]
            }
            .problem()
            .is_none()
        );
        assert!(
            When::Monthly {
                day: 0,
                at: "08:00".into()
            }
            .problem()
            .is_some()
        );
        assert!(
            When::Every {
                minutes: 0,
                from: None,
                to: None,
                days: vec![]
            }
            .problem()
            .is_some()
        );
    }

    #[test]
    fn file_names() {
        assert!(name_matches("*.xlsx", "受注_1106.XLSX"));
        assert!(!name_matches("*.xlsx", "受注.xlsx.tmp"));
        assert!(name_matches("order_????.csv", "order_1106.csv"));
        assert!(name_matches("*", "a"));
    }

    #[test]
    fn schedules_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let path = Schedules::path(tmp.path());
        assert!(Schedules::load(&path).unwrap().schedules.is_empty());
        let s = Schedules {
            format_version: 1,
            schedules: vec![Schedule {
                id: new_id(),
                name: "朝".into(),
                scenario_id: ScenarioId::new("scn_a"),
                enabled: true,
                when: When::FileAdded {
                    folder: "input".into(),
                    pattern: "*.csv".into(),
                    input: Some("file".into()),
                },
                inputs: Map::new(),
            }],
        };
        s.save(&path).unwrap();
        assert_eq!(Schedules::load(&path).unwrap(), s);
        std::fs::write(&path, r#"{"schedules":[{"id":"x","name":"n","scenarioId":"scn_a","when":{"kind":"daily","at":"25:00"}}]}"#).unwrap();
        assert!(Schedules::load(&path).is_err());
    }
}

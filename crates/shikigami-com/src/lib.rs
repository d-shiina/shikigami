//! COM automation of Office apps for Shikigami adapters.
//!
//! Office apps are driven late-bound through `IDispatch` ([`Object`]),
//! always from a dedicated single-threaded apartment thread started per
//! request ([`run_on_sta`]). The caller gives the time limit and the run's
//! cancellation; when either ends the wait, the caller decides what to do
//! with the app (Excel started for the step is killed, the user's Outlook
//! is left alone).
//!
//! On other platforms every request fails with `PLATFORM_UNSUPPORTED`.

// StepError is the Runtime's handler error type; boxing it here would only
// move the allocation.
#![allow(clippy::result_large_err)]

#[cfg(windows)]
mod dispatch;

#[cfg(windows)]
pub use dispatch::{GaveUp, GaveUpReason, Object, Session, Var, kill_process, run_on_sta};

/// Days from 1970-01-01 to a civil date (Howard Hinnant's algorithm).
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

/// An OLE automation date (days since 1899-12-30) as ISO text:
/// `2026-10-28`, or `2026-10-28T09:30:00` when it has a time.
pub fn ole_date_text(date: f64) -> Option<String> {
    if !date.is_finite() || date.abs() > 3_000_000.0 {
        return None;
    }
    let mut day = date.floor() as i64;
    let mut seconds = ((date - date.floor()) * 86_400.0).round() as i64;
    if seconds == 86_400 {
        day += 1;
        seconds = 0;
    }
    // 1899-12-30 is 25,569 days before 1970-01-01.
    let (y, m, d) = civil_from_days(day - 25_569);
    Some(if seconds == 0 {
        format!("{y:04}-{m:02}-{d:02}")
    } else {
        format!(
            "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}",
            seconds / 3600,
            seconds / 60 % 60,
            seconds % 60
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ole_dates() {
        assert_eq!(ole_date_text(46_323.0).as_deref(), Some("2026-10-28"));
        assert_eq!(
            ole_date_text(46_323.75).as_deref(),
            Some("2026-10-28T18:00:00")
        );
        assert_eq!(ole_date_text(1.0).as_deref(), Some("1899-12-31"));
        assert_eq!(ole_date_text(f64::NAN), None);
    }
}

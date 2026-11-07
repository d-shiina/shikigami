//! When the picker looks up what is under the mouse.
//!
//! Each look-up (`ElementFromPoint`) asks the app under the mouse about its
//! screen, and some apps (browsers, Electron, Office) answer slowly or build
//! their whole accessibility tree to answer. Asking on every tick, even with
//! the mouse still, made the cursor and the apps heavy. So: look again only
//! when the mouse moved and the last look is at least [`MOVING`] old, and
//! when it rests, once more every [`RESTING`] (the screen may change under a
//! still mouse). A look-up that was slow pushes the next one back as long
//! again, so a slow app is never asked faster than it answers.
//!
//! Pure logic (no Windows calls), so it is tested on every platform.

use std::time::{Duration, Instant};

/// The shortest time between two look-ups while the mouse moves.
pub const MOVING: Duration = Duration::from_millis(60);
/// How often to look again while the mouse rests.
pub const RESTING: Duration = Duration::from_millis(500);
/// How long the picker sleeps between two checks of the mouse.
pub const TICK: Duration = Duration::from_millis(15);

/// Remembers the last look-up and says when the next one is due.
#[derive(Debug, Default)]
pub struct Hover {
    /// Where and when the last look-up started, and how long it took.
    /// Intervals count from when it ended (start + took).
    last: Option<((i32, i32), Instant, Duration)>,
}

impl Hover {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether to look up what is at `at` now.
    pub fn due(&self, at: (i32, i32), now: Instant) -> bool {
        let Some((seen, when, took)) = self.last else {
            return true;
        };
        // Counted from when the answer came, not when the question went:
        // the picker asks again only after the look-up returned, so from
        // the start a slow look-up would already be "old enough".
        let since = now.saturating_duration_since(when + took);
        // A slow app sets the pace: after its answer, wait as long again.
        if since < took {
            return false;
        }
        if at == seen {
            since >= RESTING
        } else {
            since >= MOVING
        }
    }

    /// Records a look-up at `at` that started at `started` and took `took`.
    pub fn looked(&mut self, at: (i32, i32), started: Instant, took: Duration) {
        self.last = Some((at, started, took));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn first_look_is_due_at_once() {
        assert!(Hover::new().due((10, 10), Instant::now()));
    }

    #[test]
    fn a_still_mouse_is_not_asked_again_on_every_tick() {
        let t0 = Instant::now();
        let mut hover = Hover::new();
        hover.looked((10, 10), t0, ms(2));
        for tick in 1..33 {
            assert!(
                !hover.due((10, 10), t0 + TICK * tick),
                "asked again at tick {tick}"
            );
        }
        assert!(hover.due((10, 10), t0 + ms(2) + RESTING));
    }

    #[test]
    fn a_moving_mouse_is_asked_at_most_every_moving_interval() {
        let t0 = Instant::now();
        let mut hover = Hover::new();
        hover.looked((10, 10), t0, ms(2));
        assert!(!hover.due((11, 10), t0 + ms(15)));
        assert!(!hover.due((30, 10), t0 + ms(59)));
        assert!(hover.due((30, 10), t0 + ms(2) + MOVING));
    }

    #[test]
    fn a_slow_app_is_not_asked_faster_than_it_answers() {
        let t0 = Instant::now();
        let mut hover = Hover::new();
        // The app took 400 ms to answer: the picker learns it at t0 + 400.
        hover.looked((10, 10), t0, ms(400));
        assert!(!hover.due((50, 50), t0 + ms(415)));
        assert!(!hover.due((50, 50), t0 + ms(799)));
        assert!(hover.due((50, 50), t0 + ms(800)));
        // A still mouse waits the resting time after the answer, too.
        assert!(!hover.due((10, 10), t0 + ms(800)));
        assert!(hover.due((10, 10), t0 + ms(900)));
    }

    #[test]
    fn look_ups_per_second_stay_low_however_fast_the_mouse_moves() {
        // A 1000 Hz mouse moving all the time, checked every tick for 1 s.
        let t0 = Instant::now();
        let mut hover = Hover::new();
        let mut looks = 0;
        let mut now = t0;
        let mut x = 0;
        while now < t0 + Duration::from_secs(1) {
            x += 15;
            if hover.due((x, 0), now) {
                hover.looked((x, 0), now, ms(1));
                looks += 1;
            }
            now += TICK;
        }
        assert!(looks <= 17, "{looks} look-ups in a second");
        assert!(looks >= 10, "{looks} look-ups in a second: the frame lags");
    }
}

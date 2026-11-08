//! What the picker shows while the user points: when it looks up what is
//! under the mouse, and the frames and banner line it draws for it.
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

/// The four sides (x, y, width, height) of a frame `thickness` wide around
/// `rect` (left, top, right, bottom): just outside it, or with `inside`,
/// just inside it (a maximised window's outside is off the screen).
pub fn frame_sides(
    rect: (i32, i32, i32, i32),
    thickness: i32,
    inside: bool,
) -> [(i32, i32, i32, i32); 4] {
    let (l, t, r, b) = if inside {
        rect
    } else {
        (
            rect.0 - thickness,
            rect.1 - thickness,
            rect.2 + thickness,
            rect.3 + thickness,
        )
    };
    [
        (l, t, r - l, thickness),
        (l, b - thickness, r - l, thickness),
        (l, t, thickness, b - t),
        (r - thickness, t, thickness, b - t),
    ]
}

/// A rectangle on screen: left, top, right, bottom.
pub type Rect = (i32, i32, i32, i32);

/// Where the picker's tag naming the window goes: just above the window's
/// top-left corner, outside it, so it hides nothing of the app; inside the
/// corner (past the frame, `inset`) when the window reaches the top of the
/// screen (maximised). `size` is the tag's width and height.
pub fn window_tag_at(window: Rect, size: (i32, i32), screen: Rect, inset: i32) -> (i32, i32) {
    let (w, h) = size;
    let (x, y) = if window.1 - h >= screen.1 {
        (window.0, window.1 - h)
    } else {
        (window.0 + inset, window.1 + inset)
    };
    (clamp_x(x, w, screen), y)
}

/// Where the tag naming the part under the mouse goes: just below the part,
/// else just above it (at the bottom of the screen), else inside its
/// bottom edge (a part as tall as the screen).
pub fn part_tag_at(part: Rect, size: (i32, i32), screen: Rect, gap: i32) -> (i32, i32) {
    let (w, h) = size;
    let y = if part.3 + gap + h <= screen.3 {
        part.3 + gap
    } else if part.1 - gap - h >= screen.1 {
        part.1 - gap - h
    } else {
        (part.3 - h).max(screen.1)
    };
    (clamp_x(part.0, w, screen), y)
}

/// Where the picker's small banner (how to stop) goes on the screen the
/// mouse is on: at the bottom in the middle, out of the way of the app's
/// title and menus; at the top while the mouse is near the bottom spot,
/// so it never sits on what the user wants to point at.
pub fn pick_banner_at(
    screen: Rect,
    size: (i32, i32),
    mouse: (i32, i32),
    margin: i32,
) -> (i32, i32) {
    let (w, h) = size;
    let x = screen.0 + (screen.2 - screen.0 - w) / 2;
    let bottom = screen.3 - h - margin;
    // Near: within a banner's height of it, all round.
    let near =
        mouse.0 >= x - h && mouse.0 < x + w + h && mouse.1 >= bottom - 2 * h && mouse.1 < screen.3;
    (x, if near { screen.1 + margin } else { bottom })
}

fn clamp_x(x: i32, width: i32, screen: Rect) -> i32 {
    x.min(screen.2 - width).max(screen.0)
}

/// The banner's second line while picking: which window, then which part,
/// e.g. `［請求書 - Excel］ button「保存」`. A long title is cut so the part
/// still shows.
pub fn banner_line(window: &str, part: &str) -> String {
    const MAX: usize = 40;
    let window = window.trim();
    if window.is_empty() {
        return part.to_owned();
    }
    let title: String = if window.chars().count() > MAX {
        window.chars().take(MAX - 1).chain(['…']).collect()
    } else {
        window.to_owned()
    };
    format!("\u{ff3b}{title}\u{ff3d} {part}")
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

    #[test]
    fn frame_outside_surrounds_the_part() {
        let sides = frame_sides((100, 50, 200, 80), 3, false);
        assert_eq!(sides[0], (97, 47, 106, 3)); // top
        assert_eq!(sides[1], (97, 80, 106, 3)); // bottom
        assert_eq!(sides[2], (97, 47, 3, 36)); // left
        assert_eq!(sides[3], (200, 47, 3, 36)); // right
    }

    #[test]
    fn frame_inside_stays_within_a_maximised_window() {
        let sides = frame_sides((0, 0, 1920, 1080), 4, true);
        for (x, y, w, h) in sides {
            assert!(x >= 0 && y >= 0, "{x},{y} off screen");
            assert!(x + w <= 1920 && y + h <= 1080, "{x},{y} {w}x{h} off screen");
        }
    }

    #[test]
    fn banner_names_the_window_then_the_part() {
        assert_eq!(
            banner_line("請求書 - Excel", "button \u{300c}保存\u{300d}"),
            "\u{ff3b}請求書 - Excel\u{ff3d} button \u{300c}保存\u{300d}"
        );
        assert_eq!(banner_line("  ", "button"), "button");
        let long = "あ".repeat(60);
        let line = banner_line(&long, "edit");
        assert!(line.contains('…'));
        assert!(line.ends_with(" edit"));
        assert_eq!(line.chars().count(), 40 + 2 + 5);
    }

    #[test]
    fn the_window_tag_sits_outside_unless_the_window_is_at_the_top() {
        let screen = (0, 0, 1920, 1040);
        assert_eq!(
            window_tag_at((100, 200, 900, 700), (240, 24), screen, 4),
            (100, 176)
        );
        // Maximised: inside the corner, past the frame.
        assert_eq!(
            window_tag_at((0, 0, 1920, 1040), (240, 24), screen, 4),
            (4, 4)
        );
        // Off the right edge: pulled back onto the screen.
        assert_eq!(
            window_tag_at((1800, 300, 2400, 900), (240, 24), screen, 4).0,
            1680
        );
    }

    #[test]
    fn the_part_tag_goes_below_else_above_else_inside() {
        let screen = (0, 0, 1920, 1040);
        assert_eq!(
            part_tag_at((50, 100, 150, 130), (120, 24), screen, 4),
            (50, 134)
        );
        assert_eq!(
            part_tag_at((50, 1000, 150, 1030), (120, 24), screen, 4),
            (50, 972)
        );
        assert_eq!(
            part_tag_at((0, 0, 1920, 1040), (120, 24), screen, 4),
            (0, 1016)
        );
    }

    #[test]
    fn the_pick_banner_moves_out_of_the_way() {
        let screen = (0, 0, 1920, 1040);
        let (x, y) = pick_banner_at(screen, (320, 36), (100, 100), 16);
        assert_eq!((x, y), (800, 988));
        assert_eq!(
            pick_banner_at(screen, (320, 36), (900, 1000), 16),
            (800, 16)
        );
    }
}

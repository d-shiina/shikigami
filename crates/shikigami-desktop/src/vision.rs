//! Finding things in a picture of the screen: an image (template matching)
//! or a piece of text (in OCR results). Pure logic, tested without Windows.

use serde_json::{Value, json};

use crate::bitmap::{Gray, Rect};

/// Where an image was found, and how alike it is (0–1).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Match {
    pub rect: Rect,
    pub score: f32,
}

/// Smallest side the image is shrunk to for the first, rough pass.
const COARSE_MIN_SIDE: u32 = 4;
/// Most it is shrunk (each side).
const MAX_FACTOR: u32 = 16;
/// The rough pass keeps places this much less alike than asked, to look at
/// closely.
const COARSE_SLACK: f32 = 0.2;
/// Most places looked at closely (the rest are almost certainly noise).
const MAX_CANDIDATES: usize = 400;

/// Every place in `haystack` that looks like `needle` with a score of at
/// least `threshold`, in reading order (top to bottom, then left to right).
/// The score is the zero-mean normalised cross-correlation of brightness,
/// so it ignores a uniform change of brightness or contrast. `None` when
/// the needle is one flat colour (it would match anything).
pub fn find_image(haystack: &Gray, needle: &Gray, threshold: f32) -> Option<Vec<Match>> {
    if needle.width == 0 || needle.height == 0 {
        return None;
    }
    let full = Template::new(needle)?;
    if needle.width > haystack.width || needle.height > haystack.height {
        return Some(Vec::new());
    }
    let hay = Summed::new(haystack.clone());
    // Look at shrunk copies first, then closely at what they found. The
    // haystack is shrunk from every starting offset, so its blocks line up
    // with the needle's wherever the needle is.
    let mut factor = 1;
    while factor < MAX_FACTOR && needle.width.min(needle.height) / (factor * 2) >= COARSE_MIN_SIDE {
        factor *= 2;
    }
    let candidates: Vec<(u32, u32)> = if factor == 1 {
        scan(&hay, &full, threshold)
            .into_iter()
            .map(|(x, y, _)| (x, y))
            .collect()
    } else {
        let Some(small) = Template::new(&Summed::new(needle.clone()).shrunk_from(0, 0, factor))
        else {
            return Some(Vec::new());
        };
        let mut rough = Vec::new();
        for py in 0..factor {
            for px in 0..factor {
                let shifted = Summed::new(hay.shrunk_from(px, py, factor));
                if shifted.gray.width < small.width || shifted.gray.height < small.height {
                    continue;
                }
                rough.extend(
                    scan(&shifted, &small, threshold - COARSE_SLACK)
                        .into_iter()
                        .map(|(x, y, s)| (x * factor + px, y * factor + py, s)),
                );
            }
        }
        rough.sort_by(|a, b| b.2.total_cmp(&a.2));
        rough.truncate(MAX_CANDIDATES);
        rough.into_iter().map(|(x, y, _)| (x, y)).collect()
    };
    let mut found: Vec<Match> = candidates
        .into_iter()
        .map(|(x, y)| Match {
            rect: Rect {
                x: x as i32,
                y: y as i32,
                width: needle.width,
                height: needle.height,
            },
            score: full.score(&hay, x, y),
        })
        .filter(|m| m.score >= threshold)
        .collect();
    Some(reading_order(suppress_overlaps(&mut found), |m| m.rect))
}

/// A picture with running sums of its values and their squares, so the
/// sum over any rectangle takes four lookups.
struct Summed {
    gray: Gray,
    sum: Vec<f64>,
    sum_sq: Vec<f64>,
}

impl Summed {
    fn new(gray: Gray) -> Self {
        let (w, h) = (gray.width as usize, gray.height as usize);
        let mut sum = vec![0.0; (w + 1) * (h + 1)];
        let mut sum_sq = vec![0.0; (w + 1) * (h + 1)];
        for y in 0..h {
            let (mut row, mut row_sq) = (0.0, 0.0);
            for x in 0..w {
                let v = f64::from(gray.values[y * w + x]);
                row += v;
                row_sq += v * v;
                sum[(y + 1) * (w + 1) + x + 1] = sum[y * (w + 1) + x + 1] + row;
                sum_sq[(y + 1) * (w + 1) + x + 1] = sum_sq[y * (w + 1) + x + 1] + row_sq;
            }
        }
        Self { gray, sum, sum_sq }
    }

    /// Sums of values and squares in the `w` × `h` block at (x, y).
    fn block(&self, x: usize, y: usize, w: usize, h: usize) -> (f64, f64) {
        let stride = self.gray.width as usize + 1;
        let at = |table: &[f64]| {
            table[(y + h) * stride + x + w]
                - table[y * stride + x + w]
                - table[(y + h) * stride + x]
                + table[y * stride + x]
        };
        (at(&self.sum), at(&self.sum_sq))
    }

    /// Averaged `factor` × `factor` blocks, the first at (`x0`, `y0`).
    fn shrunk_from(&self, x0: u32, y0: u32, factor: u32) -> Gray {
        let width = self.gray.width.saturating_sub(x0) / factor;
        let height = self.gray.height.saturating_sub(y0) / factor;
        let f = factor as usize;
        let area = (factor * factor) as f64;
        let mut values = Vec::with_capacity(width as usize * height as usize);
        for by in 0..height as usize {
            for bx in 0..width as usize {
                let (sum, _) = self.block(x0 as usize + bx * f, y0 as usize + by * f, f, f);
                values.push((sum / area) as f32);
            }
        }
        Gray {
            width,
            height,
            values,
        }
    }
}

/// The needle with its mean taken out, and its spread.
struct Template {
    width: u32,
    height: u32,
    centred: Vec<f32>,
    norm: f32,
}

impl Template {
    fn new(gray: &Gray) -> Option<Self> {
        let n = gray.values.len() as f32;
        let mean = gray.values.iter().sum::<f32>() / n;
        let centred: Vec<f32> = gray.values.iter().map(|v| v - mean).collect();
        let norm = centred.iter().map(|v| v * v).sum::<f32>().sqrt();
        (norm > 1e-3 * n.sqrt()).then_some(Self {
            width: gray.width,
            height: gray.height,
            centred,
            norm,
        })
    }

    /// Similarity of the haystack's patch at (x, y), -1 to 1.
    fn score(&self, hay: &Summed, x: u32, y: u32) -> f32 {
        let w = self.width as usize;
        let h = self.height as usize;
        let stride = hay.gray.width as usize;
        let n = (w * h) as f64;
        let (sum, sum_sq) = hay.block(x as usize, y as usize, w, h);
        let variance = (sum_sq - sum * sum / n).max(0.0);
        if variance < 1e-3 * n {
            return 0.0;
        }
        let mut dot = 0.0f32;
        for row in 0..h {
            let start = (y as usize + row) * stride + x as usize;
            let patch = &hay.gray.values[start..start + w];
            let t = &self.centred[row * w..(row + 1) * w];
            dot += patch.iter().zip(t).map(|(p, t)| p * t).sum::<f32>();
        }
        dot / (variance.sqrt() as f32 * self.norm)
    }
}

/// Places where the score reaches `threshold` and is highest among its
/// neighbours.
fn scan(hay: &Summed, t: &Template, threshold: f32) -> Vec<(u32, u32, f32)> {
    let cols = (hay.gray.width - t.width + 1) as usize;
    let rows = (hay.gray.height - t.height + 1) as usize;
    let mut scores = vec![f32::MIN; cols * rows];
    for y in 0..rows {
        for x in 0..cols {
            scores[y * cols + x] = t.score(hay, x as u32, y as u32);
        }
    }
    let mut out = Vec::new();
    for y in 0..rows {
        for x in 0..cols {
            let s = scores[y * cols + x];
            if s < threshold {
                continue;
            }
            let peak = (y.saturating_sub(1)..=(y + 1).min(rows - 1)).all(|ny| {
                (x.saturating_sub(1)..=(x + 1).min(cols - 1)).all(|nx| {
                    let n = scores[ny * cols + nx];
                    // Ties go to the first in reading order.
                    n < s || (n == s && (ny, nx) >= (y, x))
                })
            });
            if peak {
                out.push((x as u32, y as u32, s));
            }
        }
    }
    out
}

/// Keeps the best of matches that overlap by more than half: one button
/// is one match.
fn suppress_overlaps(found: &mut [Match]) -> Vec<Match> {
    found.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut kept: Vec<Match> = Vec::new();
    for m in found.iter() {
        let area = (m.rect.width * m.rect.height) as f32;
        let overlaps = kept.iter().any(|k| {
            k.rect
                .intersect(&m.rect)
                .is_some_and(|i| (i.width * i.height) as f32 > area * 0.5)
        });
        if !overlaps {
            kept.push(*m);
        }
    }
    kept
}

/// Top to bottom; things on the same line (tops closer than half their
/// height) left to right.
pub(crate) fn reading_order<T>(mut found: Vec<T>, rect: impl Fn(&T) -> Rect) -> Vec<T> {
    found.sort_by_key(|m| (rect(m).y, rect(m).x));
    let mut out: Vec<T> = Vec::with_capacity(found.len());
    let mut line: Vec<T> = Vec::new();
    for m in found {
        if let Some(first) = line.first()
            && rect(&m).y - rect(first).y >= (rect(first).height as i32 / 2).max(1)
        {
            line.sort_by_key(|m| rect(m).x);
            out.append(&mut line);
        }
        line.push(m);
    }
    line.sort_by_key(|m| rect(m).x);
    out.append(&mut line);
    out
}

// -- text ---------------------------------------------------------------------

/// One word as OCR read it.
#[derive(Debug, Clone, PartialEq)]
pub struct OcrWord {
    pub text: String,
    pub rect: Rect,
}

/// One line of words.
#[derive(Debug, Clone, PartialEq)]
pub struct OcrLine {
    pub words: Vec<OcrWord>,
}

impl OcrLine {
    /// The words joined as a person reads them: Windows OCR splits
    /// Japanese into words with spaces between, which are dropped between
    /// characters of scripts written without spaces.
    pub fn text(&self) -> String {
        let mut out = String::new();
        for word in &self.words {
            let text = word.text.trim();
            if text.is_empty() {
                continue;
            }
            if let (Some(last), Some(first)) = (out.chars().last(), text.chars().next())
                && !(is_unspaced(last) || is_unspaced(first))
            {
                out.push(' ');
            }
            out.push_str(text);
        }
        out
    }

    pub fn rect(&self) -> Option<Rect> {
        let mut words = self.words.iter().map(|w| w.rect);
        let first = words.next()?;
        Some(words.fold(first, |acc, r| acc.union(&r)))
    }
}

/// Kana, kanji, CJK punctuation, full-width forms and Hangul: written
/// without spaces between words.
pub(crate) fn is_unspaced(c: char) -> bool {
    matches!(c as u32,
        0x3000..=0x30FF   // CJK punctuation, hiragana, katakana
        | 0x3400..=0x4DBF // CJK extension A
        | 0x4E00..=0x9FFF // CJK unified ideographs
        | 0xF900..=0xFAFF // CJK compatibility ideographs
        | 0xFF00..=0xFFEF // half- and full-width forms
        | 0xAC00..=0xD7AF // Hangul syllables
    )
}

/// The text of every line, one per line.
pub fn ocr_text(lines: &[OcrLine]) -> String {
    lines
        .iter()
        .map(OcrLine::text)
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Lines as returned to scenarios and the AI, with their places moved by
/// (`dx`, `dy`) (into window coordinates).
pub fn ocr_lines_json(lines: &[OcrLine], dx: i32, dy: i32) -> Value {
    Value::Array(
        lines
            .iter()
            .filter_map(|line| {
                let text = line.text();
                let rect = line.rect()?.offset(dx, dy);
                (!text.is_empty()).then(|| {
                    json!({ "text": text, "x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height })
                })
            })
            .collect(),
    )
}

/// For matching: no spaces, lower case, full-width letters and digits as
/// ASCII (OCR reads `１２３` and `123` alike).
fn fold(c: char) -> Option<char> {
    if c.is_whitespace() {
        return None;
    }
    let c = match c as u32 {
        0xFF01..=0xFF5E => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
        _ => c,
    };
    Some(c.to_lowercase().next().unwrap_or(c))
}

/// Every place `wanted` appears in the lines, in reading order: the words it
/// spans. Spaces, case and full / half width are ignored; `exact` asks for
/// a whole line.
pub fn find_text(lines: &[OcrLine], wanted: &str, exact: bool) -> Vec<Rect> {
    let wanted: Vec<char> = wanted.chars().filter_map(fold).collect();
    if wanted.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for line in lines {
        // Each folded character with the word it came from.
        let chars: Vec<(char, usize)> = line
            .words
            .iter()
            .enumerate()
            .flat_map(|(i, w)| w.text.chars().filter_map(fold).map(move |c| (c, i)))
            .collect();
        let starts: Vec<usize> = if exact {
            if chars.len() == wanted.len() {
                vec![0]
            } else {
                vec![]
            }
        } else {
            (0..=chars.len().saturating_sub(wanted.len())).collect()
        };
        let mut next_free = 0;
        for start in starts {
            if start < next_free || start + wanted.len() > chars.len() {
                continue;
            }
            let hit = chars[start..start + wanted.len()]
                .iter()
                .zip(&wanted)
                .all(|((c, _), w)| c == w);
            if !hit {
                continue;
            }
            next_free = start + wanted.len();
            let first = chars[start].1;
            let last = chars[start + wanted.len() - 1].1;
            let rect = line.words[first..=last]
                .iter()
                .map(|w| w.rect)
                .reduce(|a, b| a.union(&b));
            if let Some(rect) = rect {
                out.push(rect);
            }
        }
    }
    reading_order(out, |r| *r)
}

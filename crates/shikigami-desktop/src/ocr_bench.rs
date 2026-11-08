//! How well OCR reads Japanese business screens: the pictures in
//! `tests/fixtures/ocr-bench` (a spreadsheet, a browser form and an invoice,
//! 9–14 pt, light and dark; made by `tests/ocr-bench/make.mjs`) with the
//! text each one shows and where.
//!
//! Each text on the picture is compared with the OCR words whose centre
//! falls in its box. Two numbers come out:
//! - character accuracy: 1 − edit distance ÷ characters (what OCR papers
//!   report);
//! - field accuracy: the share of texts read exactly, which is what a flow
//!   needs (an order number with one wrong digit is useless).
//!
//! `cargo test -p shikigami-desktop ocr_bench -- --nocapture` prints the
//! table. With the models missing the measuring tests say so and pass.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::Value;

use crate::bitmap::{Bitmap, Rect};
use crate::vision::OcrLine;

/// One text on a picture.
#[derive(Debug, Clone)]
pub struct Truth {
    pub text: String,
    pub rect: Rect,
}

/// A picture and its texts.
pub struct Sample {
    pub name: String,
    pub image: Bitmap,
    pub truth: Vec<Truth>,
}

fn fixtures(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

/// The screens of the benchmark.
pub fn samples() -> Vec<Sample> {
    samples_in("ocr-bench")
}

/// The handwriting of the benchmark (`tests/fixtures/ocr-hand`): a slip and
/// a memo written in handwriting-style fonts (`tests/ocr-bench/make-hand.mjs`),
/// scanned and photographed, and real handwriting (`daiki-styles`).
pub fn hand_samples() -> Vec<Sample> {
    samples_in("ocr-hand")
}

fn samples_in(name: &str) -> Vec<Sample> {
    let dir = fixtures(name);
    let truth: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("truth.json")).unwrap()).unwrap();
    let mut out = Vec::new();
    for (name, items) in truth.as_object().unwrap() {
        let bytes = std::fs::read(dir.join(format!("{name}.png"))).unwrap();
        let image = Bitmap::from_png(&bytes).unwrap();
        let truth = items
            .as_array()
            .unwrap()
            .iter()
            .map(|i| Truth {
                text: i["text"].as_str().unwrap().to_owned(),
                rect: Rect {
                    x: i["x"].as_i64().unwrap() as i32,
                    y: i["y"].as_i64().unwrap() as i32,
                    width: i["width"].as_u64().unwrap() as u32,
                    height: i["height"].as_u64().unwrap() as u32,
                },
            })
            .collect();
        out.push(Sample {
            name: name.clone(),
            image,
            truth,
        });
    }
    out
}

/// Characters as compared: no spaces. `fold` also reads full-width letters
/// and digits as ASCII (`１２３` = `123`) and `￥` as `¥`, as `target.ocr`
/// does.
fn chars(text: &str, fold: bool) -> Vec<char> {
    text.chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| match c as u32 {
            0xFF01..=0xFF5E if fold => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
            0xFFE5 if fold => '¥',
            _ => c,
        })
        .collect()
}

pub fn edit_distance(a: &[char], b: &[char]) -> usize {
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut diagonal = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let next = (diagonal + usize::from(ca != cb))
                .min(row[j] + 1)
                .min(row[j + 1] + 1);
            diagonal = row[j + 1];
            row[j + 1] = next;
        }
    }
    row[b.len()]
}

/// What OCR read for each text of a picture.
#[derive(Debug, Clone, Default)]
pub struct Score {
    /// Characters in the texts.
    pub chars: usize,
    /// Edits to turn what was read into the texts (strict / folded).
    pub errors: usize,
    pub errors_folded: usize,
    pub fields: usize,
    pub exact: usize,
    pub exact_folded: usize,
    /// Texts read wrong: (expected, read).
    pub misses: Vec<(String, String)>,
}

impl Score {
    pub fn add(&mut self, other: &Score) {
        self.chars += other.chars;
        self.errors += other.errors;
        self.errors_folded += other.errors_folded;
        self.fields += other.fields;
        self.exact += other.exact;
        self.exact_folded += other.exact_folded;
        self.misses.extend(other.misses.iter().cloned());
    }

    pub fn char_accuracy(&self) -> f64 {
        1.0 - self.errors_folded as f64 / self.chars.max(1) as f64
    }

    pub fn field_accuracy(&self) -> f64 {
        self.exact_folded as f64 / self.fields.max(1) as f64
    }
}

/// Compares what OCR read with a picture's texts.
pub fn score(truth: &[Truth], lines: &[OcrLine]) -> Score {
    // Each word goes to the smallest text box holding its centre.
    let mut read: Vec<String> = vec![String::new(); truth.len()];
    for word in lines.iter().flat_map(|l| &l.words) {
        let (cx, cy) = word.rect.center();
        let owner = truth
            .iter()
            .enumerate()
            .filter(|(_, t)| {
                let r = t.rect;
                cx >= r.x - 2 && cx <= r.right() + 2 && cy >= r.y - 2 && cy <= r.bottom() + 2
            })
            .min_by_key(|(_, t)| t.rect.width * t.rect.height)
            .map(|(i, _)| i);
        if let Some(i) = owner {
            read[i].push_str(&word.text);
        }
    }
    let mut score = Score::default();
    for (t, r) in truth.iter().zip(&read) {
        let want = chars(&t.text, false);
        let got = chars(r, false);
        let errors = edit_distance(&want, &got);
        let errors_folded = edit_distance(&chars(&t.text, true), &chars(r, true));
        score.chars += want.len();
        score.errors += errors;
        score.errors_folded += errors_folded;
        score.fields += 1;
        score.exact += usize::from(errors == 0);
        score.exact_folded += usize::from(errors_folded == 0);
        if errors_folded > 0 {
            score.misses.push((t.text.clone(), r.clone()));
        }
    }
    score
}

/// Chooses pictures by name.
pub type Pick = Box<dyn Fn(&str) -> bool>;

/// Scores by picture and by group (kind, size, theme) and in total.
pub struct Report {
    pub by_sample: BTreeMap<String, Score>,
    pub seconds: f64,
}

impl Report {
    pub fn total(&self) -> Score {
        let mut total = Score::default();
        for s in self.by_sample.values() {
            total.add(s);
        }
        total
    }

    /// Scores of the pictures whose name `pick` chooses.
    pub fn group(&self, pick: impl Fn(&str) -> bool) -> Score {
        let mut total = Score::default();
        for (name, s) in &self.by_sample {
            if pick(name) {
                total.add(s);
            }
        }
        total
    }

    /// The groups the table shows: (label, pictures).
    pub fn groups() -> Vec<(&'static str, Pick)> {
        fn has(part: &'static str) -> Pick {
            Box::new(move |n: &str| n.contains(part))
        }
        vec![
            ("表計算", has("sheet-")),
            ("フォーム", has("form-")),
            ("帳票", has("invoice-")),
            ("ダイアログ", has("dialog-")),
            ("9pt", has("-9pt-")),
            ("10.5pt", has("-10_5pt-")),
            ("12pt", has("-12pt-")),
            ("14pt", has("-14pt-")),
            ("ライト", has("-light")),
            ("ダーク", has("-dark")),
            (
                "そのまま",
                Box::new(|n: &str| {
                    !n.contains("-cleartype")
                        && !n.contains("-remote")
                        && !n.starts_with("hand-")
                        && !n.starts_with("daiki-")
                }),
            ),
            ("ClearType", has("-cleartype")),
            ("リモート画面", has("-remote")),
            ("手書き風（スキャン）", has("-scan")),
            ("手書き風（写真）", has("-photo")),
            ("本物の手書き", has("daiki-")),
        ]
    }

    /// On GitHub Actions, the totals as a notice on the run (readable
    /// without downloading the log).
    pub fn annotate(&self, title: &str) {
        if std::env::var_os("GITHUB_ACTIONS").is_none() {
            return;
        }
        let mut parts = Vec::new();
        for (label, pick) in
            std::iter::once(("全体", Box::new(|_: &str| true) as Pick)).chain(Self::groups())
        {
            let s = self.group(pick);
            if s.fields == 0 {
                continue;
            }
            parts.push(format!(
                "{label} {:.1}/{:.1}",
                s.char_accuracy() * 100.0,
                s.field_accuracy() * 100.0
            ));
        }
        println!(
            "::notice title=OCR benchmark: {title}::文字/項目 % {} ({:.0} s)",
            parts.join(", "),
            self.seconds
        );
    }

    pub fn print(&self, title: &str) {
        let line = |label: &str, s: &Score| {
            eprintln!(
                "  {label:<14} 文字 {:>5.1}%  項目 {:>5.1}%  (全角半角を区別: 文字 {:>5.1}% 項目 {:>5.1}%)",
                s.char_accuracy() * 100.0,
                s.field_accuracy() * 100.0,
                (1.0 - s.errors as f64 / s.chars.max(1) as f64) * 100.0,
                s.exact as f64 / s.fields.max(1) as f64 * 100.0,
            );
        };
        eprintln!("== {title} ({:.1} s)", self.seconds);
        line("全体", &self.total());
        for (label, pick) in Self::groups() {
            let group = self.group(pick);
            if group.fields > 0 {
                line(label, &group);
            }
        }
        let misses = self.total().misses;
        // SHIKIGAMI_OCR_BENCH_ALL=1 lists every one.
        let shown = if std::env::var_os("SHIKIGAMI_OCR_BENCH_ALL").is_some() {
            misses.len()
        } else {
            40
        };
        eprintln!("  読み違い {} 件（先頭 {shown} 件）:", misses.len());
        for (want, got) in misses.iter().take(shown) {
            eprintln!("    {want:?} → {got:?}");
        }
    }
}

/// Runs `read` on every picture.
pub fn run(samples: &[Sample], mut read: impl FnMut(&Bitmap) -> Vec<OcrLine>) -> Report {
    let started = std::time::Instant::now();
    let by_sample = samples
        .iter()
        .map(|s| (s.name.clone(), score(&s.truth, &read(&s.image))))
        .collect();
    Report {
        by_sample,
        seconds: started.elapsed().as_secs_f64(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vision::OcrWord;

    #[test]
    fn edit_distance_counts_changes() {
        let c = |s: &str| s.chars().collect::<Vec<_>>();
        assert_eq!(edit_distance(&c("顧客コード"), &c("顧客コード")), 0);
        assert_eq!(edit_distance(&c("顧客コード"), &c("顧容コ一ド")), 2);
        assert_eq!(edit_distance(&c("C-001"), &c("C001")), 1);
        assert_eq!(edit_distance(&c(""), &c("abc")), 3);
    }

    #[test]
    fn words_are_scored_against_the_text_they_sit_on() {
        let truth = vec![
            Truth {
                text: "請求金額".into(),
                rect: Rect {
                    x: 0,
                    y: 0,
                    width: 80,
                    height: 20,
                },
            },
            Truth {
                text: "１２３".into(),
                rect: Rect {
                    x: 100,
                    y: 0,
                    width: 60,
                    height: 20,
                },
            },
        ];
        let word = |text: &str, x| OcrWord {
            text: text.into(),
            rect: Rect {
                x,
                y: 2,
                width: 18,
                height: 16,
            },
            confidence: None,
        };
        let lines = vec![OcrLine {
            words: vec![
                word("請", 0),
                word("求", 20),
                word("全", 40),
                word("額", 60),
                word("123", 110),
            ],
        }];
        let s = score(&truth, &lines);
        assert_eq!((s.chars, s.errors, s.errors_folded), (7, 4, 1));
        assert_eq!((s.exact, s.exact_folded), (0, 1));
        assert_eq!(s.misses, [("請求金額".to_owned(), "請求全額".to_owned())]);
    }

    /// The small, hard part of the benchmark (9 pt, as drawn and through a
    /// remote desktop) on every test run, so a change that reads worse
    /// fails. The whole benchmark is `ocr_bench_paddle` (ignored: it takes
    /// minutes in a debug build).
    #[test]
    fn ocr_reads_small_business_text() {
        let engine = match crate::paddle::engine() {
            Ok(engine) => engine,
            Err(reason) => {
                eprintln!("skipped: {reason}");
                return;
            }
        };
        let samples: Vec<Sample> = samples()
            .into_iter()
            .filter(|s| s.name.contains("-9pt-") && !s.name.contains("-cleartype"))
            .collect();
        let report = run(&samples, |image| engine.recognize(image).unwrap());
        report.print("PaddleOCR small, 9pt");
        let total = report.total();
        // Measured 2026-11: 99.4 % of characters, 96.1 % of texts.
        assert!(total.char_accuracy() >= 0.99, "{}", total.char_accuracy());
        assert!(total.field_accuracy() >= 0.95, "{}", total.field_accuracy());
    }

    /// The whole benchmark with PaddleOCR as Shikigami runs it:
    /// `cargo test -p shikigami-desktop --lib ocr_bench -- --ignored --nocapture`.
    #[test]
    #[ignore = "minutes in a debug build; run with --ignored"]
    fn ocr_bench_paddle() {
        let engine = match crate::paddle::engine() {
            Ok(engine) => engine,
            Err(reason) => {
                eprintln!("skipped: {reason}");
                return;
            }
        };
        let samples = samples();
        let report = run(&samples, |image| engine.recognize(image).unwrap());
        report.print("PaddleOCR small");
        report.annotate("PaddleOCR small");
    }

    /// Handwriting with PaddleOCR, small (the default) and medium
    /// ("高精度", where its models are installed).
    #[test]
    #[ignore = "minutes in a debug build; run with --ignored"]
    fn ocr_bench_handwriting_paddle() {
        let samples = hand_samples();
        for (accurate, title) in [
            (false, "手書き PaddleOCR small"),
            (true, "手書き PaddleOCR medium（高精度）"),
        ] {
            let engine = match crate::paddle::engine_for(accurate) {
                Ok(engine) => engine,
                Err(reason) => {
                    eprintln!("skipped {title}: {reason}");
                    continue;
                }
            };
            let report = run(&samples, |image| engine.recognize(image).unwrap());
            report.print(title);
            report.annotate(title);
        }
    }

    /// The same benchmark with Windows OCR, where its Japanese pack is
    /// installed (Add-WindowsCapability -Online -Name
    /// "Language.OCR~~~ja-JP~0.0.1.0").
    #[cfg(windows)]
    #[test]
    #[ignore = "needs Windows OCR's Japanese pack; run with --ignored"]
    fn ocr_bench_windows() {
        let samples = samples();
        if let Err(e) = crate::capture::recognize(&samples[0].image, Some("ja")) {
            eprintln!("skipped: {}", e.message);
            return;
        }
        let report = run(&samples, |image| {
            crate::capture::recognize(image, Some("ja")).unwrap()
        });
        report.print("Windows OCR");
        report.annotate("Windows OCR");
        let hand = hand_samples();
        let report = run(&hand, |image| {
            crate::capture::recognize(image, Some("ja")).unwrap()
        });
        report.print("手書き Windows OCR");
        report.annotate("手書き Windows OCR");
    }
}

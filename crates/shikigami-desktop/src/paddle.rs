//! PaddleOCR (PP-OCRv6 small, ONNX) on ONNX Runtime: the default OCR
//! engine. Offline, one model for Japanese, Chinese and English, and much
//! better than Windows OCR on small screen text.
//!
//! The models and the runtime are files next to Shikigami (`ocr\` in the
//! installed app, `target\ocr` in a development build, or
//! `SHIKIGAMI_OCR_DIR`); `pnpm studio:bundle-ocr` puts them there. Without
//! them OCR falls back to Windows OCR.
//!
//! Detection (DB) finds the lines of text; recognition (CTC) reads each
//! line. Pre- and post-processing follow PaddleOCR's defaults and are pure
//! functions tested without the models.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use ort::session::Session;
use ort::value::Tensor;
use serde_json::json;
use shikigami_runtime::StepError;

use crate::bitmap::{Bitmap, Rect};
use crate::vision::{OcrLine, OcrWord, reading_order};

pub const DET_MODEL: &str = "det.onnx";
pub const REC_MODEL: &str = "rec.onnx";
#[cfg(windows)]
const RUNTIME: &str = "onnxruntime.dll";
#[cfg(not(windows))]
const RUNTIME: &str = "libonnxruntime.so";

/// Tiny pictures (one field) are enlarged to this shorter side...
const DET_MIN_SIDE: f32 = 96.0;
/// ... and shrunk until the longer one is at most this.
const DET_MAX_SIDE: f32 = 2560.0;
/// A pixel is text when the detector's probability reaches this.
const DET_THRESHOLD: f32 = 0.3;
/// A region is a line when its mean probability reaches this.
const BOX_THRESHOLD: f32 = 0.5;
/// How much a detected region grows to hold the whole line.
const UNCLIP_RATIO: f32 = 1.6;
const REC_HEIGHT: u32 = 48;
const REC_MAX_WIDTH: u32 = 3200;
/// A line this many times taller than wide is vertical text: it is turned
/// a quarter left (top first) before reading, as PaddleOCR does.
const VERTICAL_RATIO: f32 = 1.5;
/// Lines read at once.
const REC_BATCH: usize = 8;
/// Small screen text (9 pt, 12 px) is found and read better enlarged:
/// pictures are read this much larger, when the larger copy still fits the
/// detector ([`DET_MAX_SIDE`]). On the OCR benchmark (`ocr_bench`) it reads
/// about a fifth fewer texts wrong for about a third more time.
const ENLARGE: f32 = 1.5;
/// Lines read with less confidence than this are dropped (noise).
const TEXT_SCORE: f32 = 0.5;
/// Letters the model knows that look the same as a Latin letter or digit
/// (Turkish dotless i, Greek and Cyrillic capitals...) but hardly appear on
/// Japanese business screens. Reading them turns "AI" into "Aı" and breaks
/// text search, so recognition never chooses them: the next guess (here
/// "I") wins.
pub const LOOKALIKES: &str = "ıΑΒΕΖΗΙΚΜΝΟΡΤΥΧιονАВЕКМНОРСТХаеорсухіјѕІЈЅ";

/// The loaded models.
pub struct Paddle {
    det: Mutex<Session>,
    rec: Mutex<Session>,
    vocab: Vocab,
}

/// The larger, slower models (PP-OCRv6 medium) in `medium\` next to the
/// small ones: much better on handwriting, chosen with `accurate: true`.
pub const ACCURATE_DIR: &str = "medium";

static RUNTIME_ENV: OnceLock<Result<(ort::environment::Environment, PathBuf), String>> =
    OnceLock::new();
static ENGINE: OnceLock<Result<Paddle, String>> = OnceLock::new();
static ACCURATE: OnceLock<Result<Paddle, String>> = OnceLock::new();

/// The engine, loaded on first use. `Err` says why it is not available.
pub fn engine() -> Result<&'static Paddle, String> {
    ENGINE
        .get_or_init(|| load(None))
        .as_ref()
        .map_err(Clone::clone)
}

/// The accurate engine (the medium models), loaded on first use.
pub fn accurate_engine() -> Result<&'static Paddle, String> {
    ACCURATE
        .get_or_init(|| load(Some(ACCURATE_DIR)))
        .as_ref()
        .map_err(Clone::clone)
}

/// The engine `accurate` asks for.
pub fn engine_for(accurate: bool) -> Result<&'static Paddle, String> {
    if accurate {
        accurate_engine()
    } else {
        engine()
    }
}

/// Where the models and runtime are, if anywhere.
pub fn find_dir() -> Option<PathBuf> {
    let has_models = |d: &Path| d.join(DET_MODEL).is_file() && d.join(REC_MODEL).is_file();
    if let Some(dir) = std::env::var_os("SHIKIGAMI_OCR_DIR") {
        return Some(PathBuf::from(dir)).filter(|d| has_models(d));
    }
    let exe = std::env::current_exe().ok()?;
    let mut candidates = Vec::new();
    // Installed: ocr\ next to the executables. Development builds:
    // target\debug\shikigami.exe finds target\ocr (tests run one level
    // deeper, in target\debug\deps).
    for dir in exe.ancestors().skip(1).take(3) {
        candidates.push(dir.join("ocr"));
    }
    candidates.into_iter().find(|d| has_models(d))
}

/// The ONNX Runtime library in `dir`, or the one `ORT_DYLIB_PATH` names.
fn runtime_path(dir: &Path) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("ORT_DYLIB_PATH") {
        return Some(PathBuf::from(path));
    }
    let exact = dir.join(RUNTIME);
    if exact.is_file() {
        return Some(exact);
    }
    // libonnxruntime.so.1.31.1 and the like.
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(RUNTIME))
        })
}

/// ONNX Runtime, loaded once (a process has one environment), and the
/// folder it came from.
fn runtime() -> Result<&'static (ort::environment::Environment, PathBuf), String> {
    RUNTIME_ENV
        .get_or_init(|| {
            let dir = find_dir().ok_or("the PaddleOCR models are not installed")?;
            let runtime = runtime_path(&dir).ok_or_else(|| {
                format!("ONNX Runtime ({RUNTIME}) is missing in {}", dir.display())
            })?;
            #[cfg(windows)]
            crate::capture::preload_library(&runtime)?;
            let environment = ort::init_from(&runtime)
                .map_err(|e| format!("cannot load {}: {e}", runtime.display()))?
                .with_name("shikigami-ocr")
                .build()
                .map_err(|e| format!("ONNX Runtime: {e}"))?;
            Ok((environment, dir))
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// The models in the OCR folder, or in its `sub` folder.
fn load(sub: Option<&str>) -> Result<Paddle, String> {
    let (environment, dir) = runtime()?;
    let dir = match sub {
        Some(sub) => dir.join(sub),
        None => dir.clone(),
    };
    if !dir.join(DET_MODEL).is_file() || !dir.join(REC_MODEL).is_file() {
        return Err(format!("the models are not installed in {}", dir.display()));
    }
    let threads = std::thread::available_parallelism()
        .map_or(2, |n| n.get())
        .clamp(1, 4);
    let session = |name: &str| -> Result<Session, String> {
        Session::builder(environment)
            .and_then(|mut b| {
                b = b.with_intra_threads(threads)?;
                b.commit_from_file(dir.join(name))
            })
            .map_err(|e| format!("cannot load {name}: {e}"))
    };
    let det = session(DET_MODEL)?;
    let rec = session(REC_MODEL)?;
    let chars: Vec<String> = rec
        .metadata()
        .ok()
        .and_then(|m| m.custom("character"))
        .ok_or("rec.onnx has no character list")?
        .split('\n')
        .map(str::to_owned)
        .collect();
    Ok(Paddle {
        det: Mutex::new(det),
        rec: Mutex::new(rec),
        vocab: Vocab::new(chars),
    })
}

fn ocr_error(e: impl std::fmt::Display) -> StepError {
    StepError::new("OCR_FAILED", format!("PaddleOCR: {e}"))
}

impl Paddle {
    /// The lines of text in `image`, in its pixels.
    pub fn recognize(&self, image: &Bitmap) -> Result<Vec<OcrLine>, StepError> {
        self.recognize_kind(image, None)
    }

    /// The lines of text in `image`, reading only characters a field of
    /// `kind` can hold.
    pub fn recognize_kind(
        &self,
        image: &Bitmap,
        kind: Option<crate::ocr_fit::TextKind>,
    ) -> Result<Vec<OcrLine>, StepError> {
        let limited = kind.map(|k| self.vocab.for_kind(k));
        let vocab = limited.as_ref().unwrap_or(&self.vocab);
        let longest = image.width.max(image.height) as f32;
        if longest * ENLARGE > DET_MAX_SIDE {
            return self.recognize_as_is(image, vocab);
        }
        let large = image.scaled(ENLARGE);
        let back = |v: i32| (v as f32 / ENLARGE).round() as i32;
        Ok(self
            .recognize_as_is(&large, vocab)?
            .into_iter()
            .map(|mut line| {
                for word in &mut line.words {
                    let (x, y) = (back(word.rect.x), back(word.rect.y));
                    word.rect = Rect {
                        x,
                        y,
                        width: (back(word.rect.right()) - x).max(1) as u32,
                        height: (back(word.rect.bottom()) - y).max(1) as u32,
                    };
                }
                line
            })
            .collect())
    }

    /// The lines of text in `image` at its own size.
    fn recognize_as_is(&self, image: &Bitmap, vocab: &Vocab) -> Result<Vec<OcrLine>, StepError> {
        let mut crops: Vec<(Rect, Bitmap)> = self
            .detect(image)?
            .into_iter()
            .filter_map(|rect| image.crop(rect).map(|crop| (rect, crop)))
            .map(|(rect, crop)| {
                if is_vertical(&crop) {
                    (rect, crop.rotated_left())
                } else {
                    (rect, crop)
                }
            })
            .collect();
        // Lines of similar shape go through recognition together.
        crops.sort_by(|a, b| aspect(&a.1).total_cmp(&aspect(&b.1)));
        let mut lines = Vec::new();
        for batch in crops.chunks(REC_BATCH) {
            for ((rect, _), line) in batch.iter().zip(self.read_lines(batch, vocab)?) {
                if let Some(mut line) = line {
                    let vertical = rect.height as f32 >= rect.width as f32 * VERTICAL_RATIO;
                    if vertical {
                        line = line.turned_back(rect.width);
                    }
                    lines.push((line.offset(rect.x, rect.y), vertical));
                }
            }
        }
        Ok(reading_order(lines, |(l, vertical)| {
            let rect = l.rect().unwrap_or(Rect {
                x: 0,
                y: 0,
                width: 1,
                height: 1,
            });
            // Vertical columns are read right to left: mirrored, the
            // rightmost comes first in its row.
            if *vertical {
                Rect {
                    x: -rect.right(),
                    ..rect
                }
            } else {
                rect
            }
        })
        .into_iter()
        .map(|(line, _)| line)
        .collect())
    }

    fn detect(&self, image: &Bitmap) -> Result<Vec<Rect>, StepError> {
        let (w, h) = det_size(image.width, image.height);
        let input = Tensor::from_array((
            [1usize, 3, h as usize, w as usize],
            det_input(&image.resized(w, h)),
        ))
        .map_err(ocr_error)?;
        let mut det = self
            .det
            .lock()
            .map_err(|_| ocr_error("the detector is broken"))?;
        let outputs = det.run(ort::inputs![input]).map_err(ocr_error)?;
        let (shape, probs) = outputs[0].try_extract_tensor::<f32>().map_err(ocr_error)?;
        let (mh, mw) = (shape[2] as u32, shape[3] as u32);
        let sx = image.width as f32 / mw as f32;
        let sy = image.height as f32 / mh as f32;
        Ok(text_boxes(probs, mw, mh)
            .into_iter()
            .filter_map(|r| {
                let x0 = (r.x as f32 * sx).floor().max(0.0);
                let y0 = (r.y as f32 * sy).floor().max(0.0);
                let x1 = (r.right() as f32 * sx).ceil().min(image.width as f32);
                let y1 = (r.bottom() as f32 * sy).ceil().min(image.height as f32);
                (x1 > x0 && y1 > y0).then_some(Rect {
                    x: x0 as i32,
                    y: y0 as i32,
                    width: (x1 - x0) as u32,
                    height: (y1 - y0) as u32,
                })
            })
            .collect())
    }

    /// Reads lines of similar shape at once: each scaled to the model's
    /// height, padded to the widest.
    fn read_lines(
        &self,
        batch: &[(Rect, Bitmap)],
        vocab: &Vocab,
    ) -> Result<Vec<Option<OcrLine>>, StepError> {
        let widths: Vec<u32> = batch
            .iter()
            .map(|(_, crop)| {
                ((REC_HEIGHT as f32 * aspect(crop)).ceil() as u32).clamp(8, REC_MAX_WIDTH)
            })
            .collect();
        let padded = widths.iter().copied().max().unwrap_or(8) as usize;
        let plane = REC_HEIGHT as usize * padded;
        let mut data = vec![0.0f32; batch.len() * 3 * plane];
        for (i, ((_, crop), &w)) in batch.iter().zip(&widths).enumerate() {
            let item = rec_input(&crop.resized(w, REC_HEIGHT));
            let w = w as usize;
            for c in 0..3 {
                for y in 0..REC_HEIGHT as usize {
                    let from = c * REC_HEIGHT as usize * w + y * w;
                    let to = (i * 3 + c) * plane + y * padded;
                    data[to..to + w].copy_from_slice(&item[from..from + w]);
                }
            }
        }
        let input = Tensor::from_array(([batch.len(), 3, REC_HEIGHT as usize, padded], data))
            .map_err(ocr_error)?;
        let mut rec = self
            .rec
            .lock()
            .map_err(|_| ocr_error("the recogniser is broken"))?;
        let outputs = rec.run(ort::inputs![input]).map_err(ocr_error)?;
        let (shape, scores) = outputs[0].try_extract_tensor::<f32>().map_err(ocr_error)?;
        let (steps, classes) = (shape[1] as usize, shape[2] as usize);
        Ok(batch
            .iter()
            .zip(&widths)
            .enumerate()
            .map(|(i, ((_, crop), &w))| {
                let item = &scores[i * steps * classes..(i + 1) * steps * classes];
                let decoded = ctc_decode(item, steps, classes, vocab);
                if decoded.is_empty() || decoded.score < TEXT_SCORE {
                    return None;
                }
                // A step is padded / steps model pixels, w of which cover
                // the crop.
                let column = padded as f32 / steps as f32 * crop.width as f32 / w as f32;
                Some(decoded.line(column, crop.width, crop.height))
            })
            .collect())
    }
}

fn is_vertical(image: &Bitmap) -> bool {
    image.height as f32 >= image.width as f32 * VERTICAL_RATIO
}

fn aspect(image: &Bitmap) -> f32 {
    image.width as f32 / image.height.max(1) as f32
}

/// The detector's input size, in multiples of 32.
pub fn det_size(width: u32, height: u32) -> (u32, u32) {
    let (w, h) = (width as f32, height as f32);
    let mut scale = (DET_MIN_SIDE / w.min(h)).max(1.0);
    if w.max(h) * scale > DET_MAX_SIDE {
        scale = DET_MAX_SIDE / w.max(h);
    }
    let round = |v: f32| (((v * scale) / 32.0).round() as u32).max(1) * 32;
    (round(w), round(h))
}

/// BGR planes normalised with ImageNet's mean and spread (the detector was
/// trained on OpenCV's BGR pictures).
fn det_input(image: &Bitmap) -> Vec<f32> {
    const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
    const STD: [f32; 3] = [0.229, 0.224, 0.225];
    planes(image, |plane, v| (v / 255.0 - MEAN[plane]) / STD[plane])
}

/// BGR planes scaled to -1..1.
fn rec_input(image: &Bitmap) -> Vec<f32> {
    planes(image, |_, v| (v / 255.0 - 0.5) / 0.5)
}

fn planes(image: &Bitmap, f: impl Fn(usize, f32) -> f32) -> Vec<f32> {
    let n = image.width as usize * image.height as usize;
    let mut out = vec![0.0; 3 * n];
    for (i, px) in image.rgba.as_chunks::<4>().0.iter().enumerate() {
        // B, G, R.
        for (plane, channel) in [2usize, 1, 0].into_iter().enumerate() {
            out[plane * n + i] = f(plane, f32::from(px[channel]));
        }
    }
    out
}

/// Lines of text in the detector's probability map: regions of connected
/// text pixels, kept when confident enough, grown to hold the whole line.
pub fn text_boxes(probs: &[f32], width: u32, height: u32) -> Vec<Rect> {
    let (w, h) = (width as usize, height as usize);
    let mut seen = vec![false; w * h];
    let mut out = Vec::new();
    let mut stack = Vec::new();
    for start in 0..w * h {
        if seen[start] || probs[start] < DET_THRESHOLD {
            continue;
        }
        seen[start] = true;
        stack.push(start);
        let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0, 0);
        let mut pixels = Vec::new();
        while let Some(i) = stack.pop() {
            pixels.push(i);
            let (x, y) = (i % w, i / w);
            x0 = x0.min(x);
            x1 = x1.max(x + 1);
            y0 = y0.min(y);
            y1 = y1.max(y + 1);
            let mut visit = |j: usize| {
                if !seen[j] && probs[j] >= DET_THRESHOLD {
                    seen[j] = true;
                    stack.push(j);
                }
            };
            if x > 0 {
                visit(i - 1);
            }
            if x + 1 < w {
                visit(i + 1);
            }
            if y > 0 {
                visit(i - w);
            }
            if y + 1 < h {
                visit(i + w);
            }
        }
        let (bw, bh) = ((x1 - x0) as f32, (y1 - y0) as f32);
        if bw.min(bh) < 3.0 {
            continue;
        }
        // PaddleOCR scores the whole box; the region's own pixels are close
        // and need no second pass.
        let score = pixels.iter().map(|&i| probs[i]).sum::<f32>() / pixels.len() as f32;
        if score < BOX_THRESHOLD {
            continue;
        }
        let grow = bw * bh * UNCLIP_RATIO / (2.0 * (bw + bh));
        let gx0 = (x0 as f32 - grow).max(0.0);
        let gy0 = (y0 as f32 - grow).max(0.0);
        let gx1 = (x1 as f32 + grow).min(w as f32);
        let gy1 = (y1 as f32 + grow).min(h as f32);
        out.push(Rect {
            x: gx0.floor() as i32,
            y: gy0.floor() as i32,
            width: (gx1.ceil() - gx0.floor()) as u32,
            height: (gy1.ceil() - gy0.floor()) as u32,
        });
    }
    out
}

/// A line as recognition read it: each character with the time step (a
/// column of the line picture) where it was read, and how sure the model
/// was of it (0–1).
#[derive(Debug, Clone, PartialEq)]
pub struct Decoded {
    pub chars: Vec<(String, f32)>,
    pub confidences: Vec<f32>,
    pub score: f32,
}

impl Decoded {
    fn is_empty(&self) -> bool {
        self.chars.iter().all(|(c, _)| c.trim().is_empty())
    }

    /// The line's words in a `width` × `height` picture where each step is
    /// `column` pixels wide. Each character owns the columns halfway to its neighbours;
    /// kana and kanji are words of their own (so a part of a Japanese line
    /// can be found), other letters run together until a space.
    pub fn line(&self, column: f32, width: u32, height: u32) -> OcrLine {
        let centres: Vec<f32> = self.chars.iter().map(|(_, t)| (t + 0.5) * column).collect();
        let mut words: Vec<OcrWord> = Vec::new();
        let mut open = false;
        for (i, (c, _)) in self.chars.iter().enumerate() {
            let sure = self.confidences.get(i).copied();
            let left = if i == 0 {
                0.0
            } else {
                (centres[i - 1] + centres[i]) / 2.0
            };
            let right = if i + 1 == centres.len() {
                width as f32
            } else {
                (centres[i] + centres[i + 1]) / 2.0
            };
            if c.trim().is_empty() {
                open = false;
                continue;
            }
            let rect = Rect {
                x: left.floor() as i32,
                y: 0,
                width: ((right - left).round() as u32).max(1),
                height,
            };
            let alone = c.chars().any(crate::vision::is_unspaced);
            match words.last_mut() {
                Some(word) if open && !alone => {
                    word.text.push_str(c);
                    word.rect = word.rect.union(&rect);
                    word.confidence = match (word.confidence, sure) {
                        (Some(a), Some(b)) => Some(a.min(b)),
                        (a, b) => a.or(b),
                    };
                }
                _ => words.push(OcrWord {
                    text: c.clone(),
                    rect,
                    confidence: sure,
                }),
            }
            open = !alone;
        }
        OcrLine { words }
    }
}

/// Pairs that look alike on screen: a kanji or hiragana and the katakana
/// of the same shape. Which one a line means follows from its neighbours
/// (see [`Decoded::fix_kana`]).
pub const KANA_PAIRS: [(char, char); 13] = [
    ('一', 'ー'),
    ('力', 'カ'),
    ('口', 'ロ'),
    ('工', 'エ'),
    ('二', 'ニ'),
    ('夕', 'タ'),
    ('卜', 'ト'),
    ('八', 'ハ'),
    ('才', 'オ'),
    ('へ', 'ヘ'),
    ('べ', 'ベ'),
    ('ぺ', 'ペ'),
    // A long vowel read as a hyphen ("エラ-番号").
    ('-', 'ー'),
];

/// Recognition's classes: class 0 is CTC's blank, class `i` is
/// `chars[i - 1]`, one past the end is a space.
#[derive(Clone)]
pub struct Vocab {
    pub chars: Vec<String>,
    /// Classes recognition never chooses (see [`skipped`]).
    skip: Vec<bool>,
    /// Classes a field cannot hold (see [`Vocab::for_kind`]); empty: all.
    deny: Vec<bool>,
}

impl Vocab {
    pub fn new(chars: Vec<String>) -> Self {
        let single = |c: &String| {
            let mut it = c.chars();
            match (it.next(), it.next()) {
                (Some(ch), None) => Some(ch),
                _ => None,
            }
        };
        let skip = std::iter::once(false)
            .chain(chars.iter().map(|c| single(c).is_some_and(skipped)))
            .collect();
        Vocab {
            chars,
            skip,
            deny: Vec::new(),
        }
    }

    /// The classes a field of `kind` can hold (blank always).
    pub fn for_kind(&self, kind: crate::ocr_fit::TextKind) -> Vocab {
        let deny = (0..=self.chars.len() + 1)
            .map(|class| {
                class != 0 && {
                    let c = self.char(class);
                    let mut it = c.chars();
                    match (it.next(), it.next()) {
                        (Some(ch), None) => !kind.allows(ch),
                        _ => true,
                    }
                }
            })
            .collect();
        Vocab {
            deny,
            ..self.clone()
        }
    }

    fn skips(&self, class: usize) -> bool {
        self.skip.get(class).copied().unwrap_or(false)
    }

    /// Not chosen: a look-alike, or a character the field cannot hold.
    fn excludes(&self, class: usize) -> bool {
        self.skips(class) || self.deny.get(class).copied().unwrap_or(false)
    }

    fn char(&self, class: usize) -> String {
        self.chars
            .get(class - 1)
            .cloned()
            .unwrap_or_else(|| " ".into())
    }
}

/// Characters recognition never chooses, because a Japanese business
/// screen does not show them and the model reads them for one that it does:
/// - [`LOOKALIKES`] of Latin letters ("AI" read as "Aı");
/// - kanji outside Japanese use (JIS X 0208 and Windows' own additions, the
///   characters Shift_JIS can write): the model, trained on Chinese too,
///   reads "納" as the simplified "纳" and "録" as the traditional "錄".
///   Its next guess, the Japanese form of the same shape, wins.
pub fn skipped(c: char) -> bool {
    if LOOKALIKES.contains(c) {
        return true;
    }
    let ideograph = matches!(c as u32,
        0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x20000..=0x3FFFF);
    if !ideograph {
        return false;
    }
    let mut buf = [0u8; 4];
    let (_, _, unmappable) = encoding_rs::SHIFT_JIS.encode(c.encode_utf8(&mut buf));
    unmappable
}

/// Greedy CTC decoding of `[steps, classes]` scores: the best class per
/// step, repeats merged, blanks (class 0) dropped. Where the best is a
/// class `vocab` skips, the best class it does not skip is read instead.
pub fn ctc_decode(scores: &[f32], steps: usize, classes: usize, vocab: &Vocab) -> Decoded {
    let mut out = Vec::new();
    let mut confidence = Vec::new();
    let mut previous = 0;
    for t in 0..steps {
        let row = &scores[t * classes..(t + 1) * classes];
        let best_of = |allowed: &dyn Fn(usize) -> bool| {
            row.iter().enumerate().filter(|&(i, _)| allowed(i)).fold(
                (0, f32::MIN),
                |acc, (i, &s)| if s > acc.1 { (i, s) } else { acc },
            )
        };
        let (mut best, mut score) = best_of(&|_| true);
        if vocab.excludes(best) {
            (best, score) = best_of(&|i| i != 0 && !vocab.excludes(i));
        }
        if best != 0 && best != previous {
            out.push((vocab.char(best), t as f32));
            // A skipped class the model preferred is the same shape: its
            // probability counts for the character read instead, or a lone
            // "I" read as "ı" would be dropped as noise.
            let skipped: f32 = row
                .iter()
                .enumerate()
                .filter(|&(i, _)| vocab.skips(i))
                .map(|(_, &s)| s)
                .sum();
            confidence.push((score + skipped).min(1.0));
        }
        previous = best;
    }
    let score = if confidence.is_empty() {
        0.0
    } else {
        confidence.iter().sum::<f32>() / confidence.len() as f32
    };
    let mut decoded = Decoded {
        chars: out,
        confidences: confidence,
        score,
    };
    decoded.fix_kana();
    decoded
}

fn is_numeral(c: char) -> bool {
    c.is_ascii_digit() || ('０'..='９').contains(&c) || "一二三四五六七八九十百千何数".contains(c)
}

fn is_katakana(c: char) -> bool {
    matches!(c as u32, 0x30A1..=0x30FA | 0x30FC)
}

fn is_hiragana(c: char) -> bool {
    matches!(c as u32, 0x3041..=0x3096)
}

fn is_kanji(c: char) -> bool {
    matches!(c as u32, 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF)
}

/// Kanji that follow "一" in words ("データ一覧", "メニュー一括"): after
/// katakana, "一" before any other kanji is the long vowel ("コピー用紙").
const AFTER_ICHI: &str = "覧括時部式般致度件回日月年人個つ定律斉緒切旦方体同連貫環行列";

impl Decoded {
    /// Chooses between the halves of a [`KANA_PAIRS`] pair by the
    /// neighbours: katakana after katakana ("デー夕" is "データ", "ホ一ム" is
    /// "ホーム", "コピ一用紙" is "コピー用紙"), the kanji or hiragana among
    /// those ("入カ" is "入力").
    pub fn fix_kana(&mut self) {
        let single: Vec<Option<char>> = self
            .chars
            .iter()
            .map(|(c, _)| {
                let mut it = c.chars();
                match (it.next(), it.next()) {
                    (Some(ch), None) => Some(ch),
                    _ => None,
                }
            })
            .collect();
        for i in 0..single.len() {
            let Some(c) = single[i] else { continue };
            let Some(&(other, kana)) = KANA_PAIRS.iter().find(|&&(a, b)| c == a || c == b) else {
                continue;
            };
            let before = i.checked_sub(1).and_then(|j| single[j]);
            let after = single.get(i + 1).copied().flatten();
            let neighbours = [before, after];
            let katakana = neighbours.iter().flatten().any(|&n| is_katakana(n));
            // Hiragana counts with kanji except for the hiragana halves.
            let native = neighbours
                .iter()
                .flatten()
                .any(|&n| is_kanji(n) || (is_hiragana(n) && !is_hiragana(other)));
            // After a number カ is the counter: "3カ月", "2カ所", "十カ国".
            let counter = other == '力' && before.is_some_and(is_numeral);
            let wanted = if counter {
                Some(kana)
            } else if c == other {
                // After katakana the katakana half, except "一" starting a
                // word of its own.
                let starts_word = c == '一' && after.is_some_and(|n| AFTER_ICHI.contains(n));
                let after_katakana = before.is_some_and(is_katakana) && !starts_word;
                // A hyphen only right after katakana ("A-カード" keeps it).
                let among_katakana = katakana && !native && c != '-';
                (after_katakana || among_katakana).then_some(kana)
            } else {
                (native && !katakana).then_some(other)
            };
            if let Some(w) = wanted {
                self.chars[i].0 = w.to_string();
            }
        }
    }
}

impl OcrLine {
    /// A line read turned a quarter left, with its places back in the
    /// upright picture `width` pixels wide: a word's span along the line is
    /// its span down the picture.
    pub fn turned_back(mut self, width: u32) -> OcrLine {
        for word in &mut self.words {
            word.rect = Rect {
                x: 0,
                y: word.rect.x,
                width,
                height: word.rect.width,
            };
        }
        self
    }

    fn offset(mut self, dx: i32, dy: i32) -> OcrLine {
        for word in &mut self.words {
            word.rect = word.rect.offset(dx, dy);
        }
        self
    }
}

/// Why PaddleOCR cannot run, as a step error for `engine: "paddle"`.
pub fn unavailable(reason: &str) -> StepError {
    // The hint differs: the accurate models are a separate download.
    if reason.contains(ACCURATE_DIR) {
        return StepError::permanent(
            "OCR_ENGINE_MISSING",
            format!("PaddleOCR's accurate models are not available: {reason}"),
        )
        .with_details(json!({
            "hint": "Reinstall SpellSheet (the installer includes them), run `pnpm studio:bundle-ocr` in a development checkout, or leave out accurate."
        }));
    }
    StepError::permanent("OCR_ENGINE_MISSING", format!("PaddleOCR is not available: {reason}"))
        .with_details(json!({
            "hint": "Reinstall SpellSheet (the installer includes the OCR models), run `pnpm studio:bundle-ocr` in a development checkout, or leave out engine to use Windows OCR."
        }))
}

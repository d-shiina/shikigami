//! Looking at the picture of a window: finding an image or a piece of text
//! on it (`target.image` / `target.ocr`), reading its text (OCR) and saving
//! it. The backend only takes pictures and runs OCR; everything here is the
//! same on every platform and tested with a scripted backend.

use serde_json::{Value, json};
use shikigami_runtime::StepError;

use crate::backend::{Backend, Capture, OcrEngine, OcrOptions};
use crate::bitmap::{Bitmap, Gray, Rect};
use crate::target::{DEFAULT_IMAGE_THRESHOLD, Point, Target, TextQuery};
use crate::vision::{self, OcrLine, OcrWord};

/// How much less alike than asked a place may be to be reported as a near
/// miss when nothing matches.
const NEAR_MISS: f32 = 0.25;
/// Most lines of read text put in an error's details.
const TEXT_IN_ERRORS: usize = 40;

/// The part of a window a step looks at, and where it sits in the window.
pub struct Picture {
    pub image: Bitmap,
    pub origin: (i32, i32),
}

/// Takes a picture of the window and cuts out `target.element` or
/// `target.region`.
pub async fn picture(backend: &dyn Backend, target: &Target) -> Result<Picture, StepError> {
    let Capture { image, element } = backend.capture(target.window_part()).await?;
    let area = match (&target.region, element) {
        (Some(r), _) => Some(Rect {
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
        }),
        (None, Some(rect)) => Some(rect),
        (None, None) => None,
    };
    let Some(area) = area else {
        return Ok(Picture {
            image,
            origin: (0, 0),
        });
    };
    let Some(clipped) = area.intersect(&image.bounds()) else {
        let (what, hint) = if target.region.is_some() {
            (
                "target.region is outside the window",
                "Region coordinates are pixels from the window's top-left; desktop.readText or inspect_ui with ocr shows where things are.",
            )
        } else {
            (
                "the element is not inside the window's picture",
                "Scroll the element into view, or leave out target.element.",
            )
        };
        return Err(StepError::new("REGION_OUTSIDE", what).with_details(json!({
            "window": { "width": image.width, "height": image.height },
            "hint": hint,
        })));
    };
    let cut = image.crop(clipped).unwrap_or(image);
    Ok(Picture {
        image: cut,
        origin: (clipped.x, clipped.y),
    })
}

/// OCR of a picture, with every place in window coordinates.
pub async fn read_lines(
    backend: &dyn Backend,
    picture: &Picture,
    options: OcrOptions,
) -> Result<Vec<OcrLine>, StepError> {
    let lines = backend.recognize(picture.image.clone(), options).await?;
    let (dx, dy) = picture.origin;
    Ok(lines
        .into_iter()
        .map(|line| OcrLine {
            words: line
                .words
                .into_iter()
                .map(|w| OcrWord {
                    text: w.text,
                    rect: w.rect.offset(dx, dy),
                })
                .collect(),
        })
        .collect())
}

/// What a visual target looks for, prepared once per step (the image file
/// is read once, not on every look).
pub enum Looking {
    Image {
        path: String,
        needle: Gray,
        threshold: f32,
        nth: Option<usize>,
    },
    Text(TextQuery),
}

impl Looking {
    pub async fn new(backend: &dyn Backend, target: &Target) -> Result<Option<Self>, StepError> {
        if let Some(image) = &target.image {
            let needle = backend.load_image(image.path.clone()).await?.gray();
            return Ok(Some(Self::Image {
                path: image.path.clone(),
                needle,
                threshold: image.threshold.unwrap_or(DEFAULT_IMAGE_THRESHOLD),
                nth: image.nth,
            }));
        }
        Ok(target.ocr.clone().map(Self::Text))
    }
}

/// The places found on one look, in reading order (window coordinates).
pub struct Seen {
    pub places: Vec<(Rect, Option<f32>)>,
    /// The best score below the threshold, when the image was not found.
    near_miss: Option<f32>,
    /// What OCR read, when the text was not found.
    text_read: Option<String>,
}

/// Looks once at the window for what `looking` describes.
pub async fn look(
    backend: &dyn Backend,
    target: &Target,
    looking: &Looking,
) -> Result<Seen, StepError> {
    let picture = picture(backend, target).await?;
    let (dx, dy) = picture.origin;
    match looking {
        Looking::Image {
            path,
            needle,
            threshold,
            ..
        } => {
            let floor = (threshold - NEAR_MISS).max(0.3);
            let found =
                vision::find_image(&picture.image.gray(), needle, floor).ok_or_else(|| {
                    StepError::permanent(
                        "IMAGE_FLAT",
                        format!("{path} is one flat colour, so it would match anywhere"),
                    )
                    .with_details(
                        json!({ "hint": "Cut out a part with a border, an icon or text in it." }),
                    )
                })?;
            let (hits, misses): (Vec<_>, Vec<_>) =
                found.into_iter().partition(|m| m.score >= *threshold);
            Ok(Seen {
                places: hits
                    .into_iter()
                    .map(|m| (m.rect.offset(dx, dy), Some(m.score)))
                    .collect(),
                near_miss: misses.iter().map(|m| m.score).reduce(f32::max),
                text_read: None,
            })
        }
        Looking::Text(query) => {
            let options = OcrOptions {
                language: query.language.clone(),
                engine: query.engine.as_deref().map(OcrEngine::parse).transpose()?,
            };
            let lines = read_lines(backend, &picture, options).await?;
            let places: Vec<(Rect, Option<f32>)> =
                vision::find_text(&lines, &query.text, query.exact)
                    .into_iter()
                    .map(|r| (r, None))
                    .collect();
            let text_read = places.is_empty().then(|| {
                lines
                    .iter()
                    .take(TEXT_IN_ERRORS)
                    .map(OcrLine::text)
                    .collect::<Vec<_>>()
                    .join("\n")
            });
            Ok(Seen {
                places,
                near_miss: None,
                text_read,
            })
        }
    }
}

/// The one place to act on: the match (`nth` when several), its centre
/// moved by `target.offset`.
pub fn pick(target: &Target, looking: &Looking, seen: &Seen) -> Result<Point, StepError> {
    let (nth, what) = match looking {
        Looking::Image { nth, path, .. } => (*nth, format!("the image {path}")),
        Looking::Text(q) => (q.nth, format!("the text '{}'", q.text)),
    };
    let image = matches!(looking, Looking::Image { .. });
    let candidates = || -> Vec<Value> {
        seen.places
            .iter()
            .map(|(r, score)| {
                let mut c = json!({ "x": r.x, "y": r.y, "width": r.width, "height": r.height });
                if let Some(s) = score {
                    c["score"] = json!((s * 1000.0).round() / 1000.0);
                }
                c
            })
            .collect()
    };
    let rect = match (seen.places.len(), nth) {
        (0, _) => {
            let mut details = json!({});
            if let Some(score) = seen.near_miss {
                details["bestScore"] = json!((score * 1000.0).round() / 1000.0);
                details["hint"] = json!(
                    "Something similar is there but below the threshold: lower target.image.threshold a little, or cut the image again from the current screen (same display scaling)."
                );
            } else if image {
                details["hint"] = json!(
                    "Check that the window shows it (inspect_ui with image: true). Images must come from the same display scaling and theme."
                );
            }
            if let Some(text) = &seen.text_read {
                details["textRead"] = json!(text);
                details["hint"] = json!(
                    "textRead is what OCR read in that part of the window. Write target.ocr.text as it appears there."
                );
            }
            let code = if image {
                "IMAGE_NOT_FOUND"
            } else {
                "TEXT_NOT_FOUND"
            };
            return Err(
                StepError::new(code, format!("{what} is not on the screen")).with_details(details)
            );
        }
        (_, Some(n)) => match seen.places.get(n) {
            Some((r, _)) => *r,
            None => {
                return Err(StepError::new(
                    if image {
                        "IMAGE_NOT_FOUND"
                    } else {
                        "TEXT_NOT_FOUND"
                    },
                    format!(
                        "{what} is shown {} times, so nth {n} is not there",
                        seen.places.len()
                    ),
                )
                .with_details(json!({ "candidates": candidates() })));
            }
        },
        (1, None) => seen.places[0].0,
        (n, None) => {
            return Err(StepError::permanent(
                if image { "IMAGE_AMBIGUOUS" } else { "TEXT_AMBIGUOUS" },
                format!("{what} is shown {n} times"),
            )
            .with_details(json!({
                "candidates": candidates(),
                "hint": "Add nth (0-based, in reading order), or narrow the search with target.region or target.element.",
            })));
        }
    };
    let (x, y) = rect.center();
    let offset = target.offset.unwrap_or(Point { x: 0, y: 0 });
    Ok(Point {
        x: x + offset.x,
        y: y + offset.y,
    })
}

/// Errors that mean "not on the screen yet".
pub fn is_not_seen(e: &StepError) -> bool {
    matches!(e.code.as_str(), "IMAGE_NOT_FOUND" | "TEXT_NOT_FOUND")
}

/// `language` and `engine` of a step or inspect_ui.
pub fn ocr_options(params: &Value) -> Result<OcrOptions, StepError> {
    let text = |key: &str| params.get(key).and_then(Value::as_str).map(str::to_owned);
    Ok(OcrOptions {
        language: text("language"),
        engine: text("engine")
            .as_deref()
            .map(OcrEngine::parse)
            .transpose()?,
    })
}

/// The result of desktop.readText.
pub fn read_output(lines: &[OcrLine]) -> Value {
    json!({
        "text": vision::ocr_text(lines),
        "lines": vision::ocr_lines_json(lines, 0, 0),
    })
}

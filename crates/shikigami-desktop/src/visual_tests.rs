//! Image search, OCR text and the steps that look at the screen, against a
//! fake screen.

use std::sync::Mutex;

use serde_json::{Value, json};
use shikigami_core::{Scenario, Step, Validator, VarDirection, VarType, VariableDef};
use shikigami_runtime::{RunOptions, RunReport, RunStatus, Runtime};

use super::*;
use crate::backend::Capture;
use crate::bitmap::{Bitmap, Rect};
use crate::vision::{OcrLine, OcrWord, find_image, find_text, ocr_text};

/// A noisy picture (every patch is different, like a real screen).
fn noise(width: u32, height: u32, seed: u32) -> Bitmap {
    let mut state = seed.wrapping_mul(2_654_435_761).wrapping_add(1);
    let mut rgba = Vec::with_capacity((width * height * 4) as usize);
    for _ in 0..width * height {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let v = (state >> 24) as u8;
        rgba.extend_from_slice(&[v, v / 2, 255 - v, 255]);
    }
    Bitmap::new(width, height, rgba)
}

/// `picture` with `patch` drawn at (x, y).
fn paste(picture: &mut Bitmap, patch: &Bitmap, x: u32, y: u32) {
    for row in 0..patch.height {
        let from = (row * patch.width * 4) as usize;
        let to = (((y + row) * picture.width + x) * 4) as usize;
        picture.rgba[to..to + (patch.width * 4) as usize]
            .copy_from_slice(&patch.rgba[from..from + (patch.width * 4) as usize]);
    }
}

fn word(text: &str, x: i32, y: i32, width: u32) -> OcrWord {
    OcrWord {
        text: text.into(),
        rect: Rect {
            x,
            y,
            width,
            height: 20,
        },
    }
}

#[test]
fn png_round_trips_and_pictures_crop_and_scale() {
    let picture = noise(30, 20, 1);
    let back = Bitmap::from_png(&picture.to_png()).unwrap();
    assert_eq!(back, picture);
    let part = picture
        .crop(Rect {
            x: 25,
            y: 15,
            width: 10,
            height: 10,
        })
        .unwrap();
    assert_eq!((part.width, part.height), (5, 5), "clipped to the picture");
    assert!(
        picture
            .crop(Rect {
                x: 40,
                y: 0,
                width: 5,
                height: 5
            })
            .is_none()
    );
    let doubled = picture.scaled(2.0);
    assert_eq!((doubled.width, doubled.height), (60, 40));
    assert!(Bitmap::new(2, 1, vec![0, 0, 0, 255, 0, 0, 0, 255]).is_blank());
    assert!(!picture.is_blank());
    assert!(Bitmap::from_png(b"not a png").is_err());
}

#[test]
fn images_are_found_where_they_are_in_reading_order() {
    // Small (searched at full size) and large (searched shrunk first).
    for (w, h) in [(12, 10), (40, 30), (64, 64)] {
        let mut screen = noise(400, 300, 7);
        let button = noise(w, h, 99);
        paste(&mut screen, &button, 300, 40);
        paste(&mut screen, &button, 20, 41);
        paste(&mut screen, &button, 150, 200);
        let found = find_image(&screen.gray(), &button.gray(), 0.9).unwrap();
        let places: Vec<(i32, i32)> = found.iter().map(|m| (m.rect.x, m.rect.y)).collect();
        // Same line (41 vs 40) left to right, then the next line.
        assert_eq!(places, [(20, 41), (300, 40), (150, 200)], "{w}x{h}");
        assert!(found.iter().all(|m| m.score > 0.99), "{found:?}");
    }
}

#[test]
fn brightness_changes_still_match_but_other_pictures_do_not() {
    let mut screen = noise(200, 120, 3);
    let icon = noise(24, 24, 42);
    // The same icon, a little darker on screen (a hover or theme tint).
    let mut darker = icon.clone();
    for px in darker.rgba.chunks_exact_mut(4) {
        for c in &mut px[..3] {
            *c = (f32::from(*c) * 0.8) as u8 + 10;
        }
    }
    paste(&mut screen, &darker, 100, 50);
    let found = find_image(&screen.gray(), &icon.gray(), 0.9).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!((found[0].rect.x, found[0].rect.y), (100, 50));
    let other = noise(24, 24, 43);
    assert!(
        find_image(&screen.gray(), &other.gray(), 0.9)
            .unwrap()
            .is_empty()
    );
    // A flat picture would match anywhere.
    let flat = Bitmap::new(8, 8, [200, 200, 200, 255].repeat(64));
    assert!(find_image(&screen.gray(), &flat.gray(), 0.9).is_none());
    // Larger than the screen: not there.
    assert!(
        find_image(&icon.gray(), &screen.gray(), 0.9)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn ocr_words_join_as_people_read_them() {
    let line = OcrLine {
        words: vec![
            word("請求", 0, 0, 30),
            word("書", 32, 0, 15),
            word("No.", 60, 0, 30),
            word("1234", 95, 0, 40),
            word("の", 140, 0, 15),
            word("確認", 160, 0, 30),
        ],
    };
    assert_eq!(line.text(), "請求書No. 1234の確認");
    let other = OcrLine {
        words: vec![word("Save", 0, 40, 40), word("all", 45, 40, 30)],
    };
    let lines = vec![line, other];
    assert_eq!(ocr_text(&lines), "請求書No. 1234の確認\nSave all");

    // Spaces, case and full width do not matter; the words found make the
    // place.
    let hits = find_text(&lines, "請求書ｎｏ．１２３４", false);
    assert_eq!(
        hits,
        [Rect {
            x: 0,
            y: 0,
            width: 135,
            height: 20
        }]
    );
    assert_eq!(find_text(&lines, "SAVE", false).len(), 1);
    assert!(find_text(&lines, "SAVE", true).is_empty());
    assert_eq!(find_text(&lines, "save all", true).len(), 1);
    assert!(find_text(&lines, "削除", false).is_empty());
}

// -- steps against a fake screen ----------------------------------------------

/// A window picture, the OCR lines on it (in the pixels of the picture
/// given to OCR at its original size), and what the steps asked.
struct Screen {
    window: Bitmap,
    element: Option<Rect>,
    lines: Vec<OcrLine>,
    /// Width of the picture `lines` are written for (OCR may get it
    /// enlarged).
    ocr_width: u32,
    calls: Mutex<Vec<Op>>,
    ocr_sizes: Mutex<Vec<(u32, u32)>>,
}

impl Screen {
    fn new(window: Bitmap) -> Self {
        let ocr_width = window.width;
        Self {
            window,
            element: None,
            lines: vec![],
            ocr_width,
            calls: Mutex::default(),
            ocr_sizes: Mutex::default(),
        }
    }

    fn clicks(&self) -> Vec<(i32, i32)> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter_map(|op| match op {
                Op::MouseClick { target, .. } => target.point.map(|p| (p.x, p.y)),
                _ => None,
            })
            .collect()
    }
}

impl Backend for Screen {
    fn call(&self, op: Op) -> BoxFuture<'static, Result<Value, StepError>> {
        self.calls.lock().unwrap().push(op);
        Box::pin(async { Ok(json!({ "snapshot": "- window \"Citrix\"" })) })
    }

    fn capture(&self, target: Target) -> BoxFuture<'static, Result<Capture, StepError>> {
        let capture = Capture {
            image: self.window.clone(),
            element: self.element.filter(|_| target.element.is_some()),
        };
        Box::pin(async move { Ok(capture) })
    }

    fn recognize(
        &self,
        image: Bitmap,
        _options: crate::backend::OcrOptions,
    ) -> BoxFuture<'static, Result<Vec<OcrLine>, StepError>> {
        self.ocr_sizes
            .lock()
            .unwrap()
            .push((image.width, image.height));
        let factor = (image.width / self.ocr_width) as i32;
        let lines = self
            .lines
            .iter()
            .map(|l| OcrLine {
                words: l
                    .words
                    .iter()
                    .map(|w| OcrWord {
                        text: w.text.clone(),
                        rect: Rect {
                            x: w.rect.x * factor,
                            y: w.rect.y * factor,
                            width: w.rect.width * factor as u32,
                            height: w.rect.height * factor as u32,
                        },
                    })
                    .collect(),
            })
            .collect();
        Box::pin(async move { Ok(lines) })
    }
}

async fn run_on(screen: Arc<Screen>, steps: Vec<Step>) -> RunReport {
    let runtime = Runtime::builder()
        .adapter(&DesktopAdapter::with_backend(screen))
        .build();
    let mut s = Scenario::new("visual");
    s.variables.push(VariableDef {
        direction: VarDirection::Output,
        ..VariableDef::new("out", VarType::Any)
    });
    s.steps = steps;
    for step in &mut s.steps {
        shikigami_core::ops::assign_missing_ids(step);
    }
    runtime
        .start(s, RunOptions::default())
        .unwrap()
        .wait()
        .await
        .unwrap()
}

fn step(step_type: &str, params: Value) -> Step {
    let mut step = Step::new(step_type);
    for (key, value) in params.as_object().unwrap() {
        step = step.with_param(key, value.clone());
    }
    step
}

fn saving(mut step: Step) -> Step {
    step.save_as = Some("out".into());
    step
}

fn short(mut step: Step) -> Step {
    step.timeout_ms = Some(1500);
    step
}

/// The search button's picture on a screen, with the PNG file for it.
fn screen_with_button(dir: &tempfile::TempDir, copies: &[(u32, u32)]) -> (Screen, String) {
    let mut window = noise(320, 240, 5);
    let button = noise(40, 16, 77);
    for (x, y) in copies {
        paste(&mut window, &button, *x, *y);
    }
    let path = dir.path().join("search.png");
    std::fs::write(&path, button.to_png()).unwrap();
    (Screen::new(window), path.display().to_string())
}

#[tokio::test]
async fn mouse_click_on_an_image_clicks_its_centre() {
    let dir = tempfile::tempdir().unwrap();
    let (screen, path) = screen_with_button(&dir, &[(200, 100)]);
    let screen = Arc::new(screen);
    let target = json!({ "window": { "title": "Citrix" }, "image": { "path": path }, "offset": { "x": 5, "y": -3 } });
    let report = run_on(
        screen.clone(),
        vec![step(types::MOUSE_CLICK, json!({ "target": target }))],
    )
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(screen.clicks(), [(200 + 20 + 5, 100 + 8 - 3)]);
}

#[tokio::test]
async fn several_matches_need_nth_and_regions_narrow_the_search() {
    let dir = tempfile::tempdir().unwrap();
    let (screen, path) = screen_with_button(&dir, &[(200, 100), (20, 180)]);
    let screen = Arc::new(screen);
    let click = |extra: Value| {
        let mut target = json!({ "window": { "title": "Citrix" }, "image": { "path": path } });
        for (k, v) in extra.as_object().unwrap() {
            if k == "nth" {
                target["image"]["nth"] = v.clone();
            } else {
                target[k] = v.clone();
            }
        }
        short(step(types::MOUSE_CLICK, json!({ "target": target })))
    };
    let report = run_on(screen.clone(), vec![click(json!({}))]).await;
    let error = report.error.unwrap();
    assert_eq!(error.code, "IMAGE_AMBIGUOUS");
    assert_eq!(
        error.details.unwrap()["candidates"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    let report = run_on(
        screen.clone(),
        vec![
            click(json!({ "nth": 1 })),
            click(json!({ "region": { "x": 0, "y": 150, "width": 100, "height": 90 } })),
        ],
    )
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    // nth 1 is the lower one; the region holds only that one too.
    assert_eq!(screen.clicks(), [(40, 188), (40, 188)]);
}

#[tokio::test]
async fn a_missing_image_waits_then_says_how_close_it_came() {
    let dir = tempfile::tempdir().unwrap();
    let (mut screen, path) = screen_with_button(&dir, &[]);
    // A faded copy: alike, but not enough.
    let button = Bitmap::from_png(&std::fs::read(&path).unwrap()).unwrap();
    let mut faded = button.clone();
    for (i, px) in faded.rgba.chunks_exact_mut(4).enumerate() {
        if i % 6 == 0 {
            px[..3].copy_from_slice(&[128, 128, 128]);
        }
    }
    paste(&mut screen.window, &faded, 60, 60);
    let started = Instant::now();
    let report = run_on(
        Arc::new(screen),
        vec![short(step(
            types::MOUSE_CLICK,
            json!({ "target": { "window": { "title": "Citrix" }, "image": { "path": path, "threshold": 0.95 } } }),
        ))],
    )
    .await;
    let error = report.error.unwrap();
    assert_eq!(error.code, "IMAGE_NOT_FOUND");
    assert!(started.elapsed() >= Duration::from_millis(500), "it waited");
    let best = error.details.unwrap()["bestScore"].as_f64().unwrap();
    assert!(best > 0.6 && best < 0.95, "{best}");

    let report = run_on(
        Arc::new(Screen::new(noise(50, 50, 1))),
        vec![step(
            types::MOUSE_CLICK,
            json!({ "target": { "window": { "title": "Citrix" }, "image": { "path": dir.path().join("none.png").display().to_string() } } }),
        )],
    )
    .await;
    assert_eq!(report.error.unwrap().code, "IMAGE_FILE_NOT_FOUND");
}

fn ocr_screen() -> Screen {
    let mut screen = Screen::new(noise(400, 300, 9));
    screen.lines = vec![
        OcrLine {
            words: vec![word("顧客", 20, 50, 40), word("コード", 62, 50, 60)],
        },
        OcrLine {
            words: vec![word("検索", 300, 250, 40)],
        },
    ];
    screen
}

#[tokio::test]
async fn text_on_screen_is_clicked_and_typed_into() {
    let screen = Arc::new(ocr_screen());
    let report = run_on(
        screen.clone(),
        vec![
            step(
                types::MOUSE_CLICK,
                json!({ "target": { "window": { "title": "Citrix" }, "ocr": { "text": "検索" } } }),
            ),
            step(
                types::TYPE,
                json!({ "target": { "window": { "title": "Citrix" }, "ocr": { "text": "顧客コード" }, "offset": { "x": 150, "y": 0 } }, "text": "C-001" }),
            ),
        ],
    )
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(screen.ocr_sizes.lock().unwrap()[0], (400, 300));
    assert_eq!(screen.clicks(), [(320, 260), (20 + 51 + 150, 60)]);
    let calls = screen.calls.lock().unwrap().clone();
    let Some(Op::Type { target, text }) = calls.last() else {
        panic!("{calls:?}")
    };
    assert_eq!(text.value, "C-001");
    assert!(target.point.is_none() && target.element.is_none());
}

#[tokio::test]
async fn missing_text_reports_what_was_read() {
    let report = run_on(
        Arc::new(ocr_screen()),
        vec![short(step(
            types::MOUSE_CLICK,
            json!({ "target": { "window": { "title": "Citrix" }, "ocr": { "text": "削除" } } }),
        ))],
    )
    .await;
    let error = report.error.unwrap();
    assert_eq!(error.code, "TEXT_NOT_FOUND");
    assert_eq!(
        error.details.unwrap()["textRead"],
        json!("顧客コード\n検索")
    );
}

#[tokio::test]
async fn is_visible_and_wait_for_look_at_the_screen() {
    let report = run_on(
        Arc::new(ocr_screen()),
        vec![
            saving(step(
                types::IS_VISIBLE,
                json!({ "target": { "window": { "title": "Citrix" }, "ocr": { "text": "エラー" } }, "waitMs": 0 }),
            )),
            step(
                types::WAIT_FOR,
                json!({ "target": { "window": { "title": "Citrix" }, "ocr": { "text": "検索" } } }),
            ),
            step(
                types::WAIT_FOR,
                json!({ "target": { "window": { "title": "Citrix" }, "ocr": { "text": "エラー" } }, "state": "hidden" }),
            ),
        ],
    )
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["out"], json!(false));
}

#[tokio::test]
async fn read_text_reads_a_window_part_or_a_file() {
    let mut screen = ocr_screen();
    // Only the part asked for goes to OCR; its lines start at the region.
    screen.ocr_width = 200;
    screen.lines = vec![OcrLine {
        words: vec![word("合計", 10, 5, 40), word("1,200円", 60, 5, 80)],
    }];
    let screen = Arc::new(screen);
    let report = run_on(
        screen.clone(),
        vec![saving(step(
            types::READ_TEXT,
            json!({ "target": { "window": { "title": "Citrix" }, "region": { "x": 100, "y": 200, "width": 200, "height": 50 } } }),
        ))],
    )
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(screen.ocr_sizes.lock().unwrap()[0], (200, 50));
    assert_eq!(
        report.outputs["out"],
        json!({ "text": "合計1,200円", "lines": [{ "text": "合計1,200円", "x": 110, "y": 205, "width": 130, "height": 20 }] })
    );

    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("invoice.png");
    std::fs::write(&file, noise(200, 100, 2).to_png()).unwrap();
    let report = run_on(
        screen.clone(),
        vec![saving(step(
            types::READ_TEXT,
            json!({ "file": file.display().to_string(), "language": "ja" }),
        ))],
    )
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["out"]["text"], json!("合計1,200円"));
}

#[tokio::test]
async fn screenshots_save_the_window_element_or_region() {
    let dir = tempfile::tempdir().unwrap();
    let mut screen = Screen::new(noise(120, 80, 4));
    screen.element = Some(Rect {
        x: 10,
        y: 20,
        width: 30,
        height: 15,
    });
    let window = screen.window.clone();
    let path = |name: &str| dir.path().join("shots").join(name).display().to_string();
    let report = run_on(
        Arc::new(screen),
        vec![
            step(
                types::SCREENSHOT,
                json!({ "target": { "window": { "title": "a" } }, "path": path("all.png") }),
            ),
            step(
                types::SCREENSHOT,
                json!({ "target": { "window": { "title": "a" }, "element": { "id": "x" } }, "path": path("element.png") }),
            ),
            saving(step(
                types::SCREENSHOT,
                json!({ "target": { "window": { "title": "a" }, "region": { "x": 100, "y": 70, "width": 50, "height": 50 } }, "path": path("region.png") }),
            )),
        ],
    )
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["out"], json!(path("region.png")));
    let read = |name: &str| Bitmap::from_png(&std::fs::read(path(name)).unwrap()).unwrap();
    assert_eq!(read("all.png"), window);
    let element = read("element.png");
    assert_eq!((element.width, element.height), (30, 15));
    let region = read("region.png");
    assert_eq!(
        (region.width, region.height),
        (20, 10),
        "clipped to the window"
    );
}

#[tokio::test]
async fn visual_targets_only_where_they_make_sense() {
    let runtime = Runtime::builder()
        .adapter(&DesktopAdapter::with_backend(Arc::new(ocr_screen())))
        .build();
    let validator = Validator::new(runtime.registry().clone());
    let valid = |step_type: &str, params: Value| {
        let mut s = Scenario::new("check");
        s.steps = vec![step(step_type, params).with_id("s")];
        validator.validate(&s).valid
    };
    let ocr = json!({ "window": { "title": "a" }, "ocr": { "text": "OK" } });
    assert!(valid(types::MOUSE_CLICK, json!({ "target": ocr })));
    assert!(valid(types::WAIT_FOR, json!({ "target": ocr })));
    // Steps that need an element do not take a place on the picture.
    assert!(!valid(types::CLICK, json!({ "target": ocr })));
    assert!(!valid(types::GET_VALUE, json!({ "target": ocr })));
    // readText reads a window or a file.
    assert!(!valid(types::READ_TEXT, json!({})));
    assert!(valid(types::READ_TEXT, json!({ "file": "C:\\scan.png" })));

    // Mixed-up targets fail when the step runs.
    let screen = Arc::new(ocr_screen());
    let bad = [
        json!({ "window": { "title": "a" }, "region": { "x": 0, "y": 0, "width": 5, "height": 5 } }),
        json!({ "window": { "title": "a" }, "ocr": { "text": "OK" }, "image": { "path": "C:\\a.png" } }),
        json!({ "window": { "title": "a" }, "offset": { "x": 1, "y": 1 } }),
        json!({ "window": { "title": "a" }, "image": { "path": "C:\\a.png" }, "point": { "x": 1, "y": 1 } }),
    ];
    for target in bad {
        let report = run_on(
            screen.clone(),
            vec![step(types::MOUSE_CLICK, json!({ "target": target }))],
        )
        .await;
        assert_eq!(report.error.unwrap().code, "INVALID_PARAMS", "{target}");
    }
    assert!(screen.clicks().is_empty());
}

#[tokio::test]
async fn inspect_adds_the_picture_and_its_text() {
    let dir = tempfile::tempdir().unwrap();
    let shot = dir.path().join("shot.png");
    let adapter = DesktopAdapter::with_backend(Arc::new(ocr_screen()));
    let ui = adapter
        .inspect(
            "s",
            json!({ "window": { "title": "Citrix" }, "ocr": true, "screenshotPath": shot.display().to_string() }),
        )
        .await
        .unwrap();
    assert_eq!(ui["size"], json!({ "width": 400, "height": 300 }));
    assert_eq!(
        ui["ocr"][1],
        json!({ "text": "検索", "x": 300, "y": 250, "width": 40, "height": 20 })
    );
    assert_eq!(
        Bitmap::from_png(&std::fs::read(&shot).unwrap())
            .unwrap()
            .width,
        400
    );
}

// -- PaddleOCR ------------------------------------------------------------------

#[test]
fn detector_regions_become_grown_line_boxes() {
    // A 20 x 6 map with one line of text (probability 0.9) and a speck.
    let (w, h) = (20u32, 6u32);
    let mut probs = vec![0.0f32; (w * h) as usize];
    for y in 2..5 {
        for x in 3..15 {
            probs[(y * w + x) as usize] = 0.9;
        }
    }
    probs[(w + 18) as usize] = 0.9;
    let boxes = crate::paddle::text_boxes(&probs, w, h);
    // 12 x 3 grows by 12*3*1.6/30 = 1.44 on each side.
    assert_eq!(
        boxes,
        [Rect {
            x: 1,
            y: 0,
            width: 16,
            height: 6
        }]
    );
    assert_eq!(crate::paddle::det_size(400, 300), (416, 288));
    assert_eq!(crate::paddle::det_size(200, 24), (800, 96));
    assert_eq!(crate::paddle::det_size(3840, 1000), (2560, 672));
}

#[test]
fn ctc_output_becomes_words_with_places() {
    let chars: Vec<String> = ["保", "存", "O", "K"]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
    // Steps: 保 保 _ 存 _ (space) O O K, over 6 classes (blank, 4, space).
    let best = [1, 1, 0, 2, 0, 5, 3, 3, 4, 0];
    let classes = 6;
    let mut scores = vec![0.0f32; best.len() * classes];
    for (t, &c) in best.iter().enumerate() {
        scores[t * classes + c] = 0.9;
    }
    let decoded = crate::paddle::ctc_decode(&scores, best.len(), classes, &chars);
    let text: String = decoded.chars.iter().map(|(c, _)| c.as_str()).collect();
    assert_eq!(text, "保存 OK");
    assert!((decoded.score - 0.9).abs() < 1e-6);
    let line = decoded.line(10.0, 100, 20);
    let words: Vec<&str> = line.words.iter().map(|w| w.text.as_str()).collect();
    assert_eq!(words, ["保", "存", "OK"]);
    assert_eq!(line.text(), "保存OK");
    // Each character owns the columns halfway to its neighbours.
    assert_eq!(line.words[0].rect.x, 0);
    assert_eq!(line.words[2].rect.right(), 100);
    assert!(line.words[0].rect.right() <= line.words[1].rect.x + 1);
}

/// Real models, when installed (`SHIKIGAMI_OCR_DIR`, or `target/ocr` after
/// `pnpm studio:bundle-ocr`): small Japanese UI text.
#[test]
fn paddle_reads_small_japanese_screen_text() {
    let engine = match crate::paddle::engine() {
        Ok(engine) => engine,
        Err(reason) => {
            eprintln!("skipped: {reason}");
            return;
        }
    };
    let bytes = include_bytes!("../tests/fixtures/billing-ja.png");
    let screen = Bitmap::from_png(bytes).unwrap();
    let started = Instant::now();
    let lines = engine.recognize(&screen).unwrap();
    eprintln!("{:?}\n{}", started.elapsed(), ocr_text(&lines));
    let text = ocr_text(&lines);
    for expected in [
        "顧客コード",
        "C-001",
        "請求金額",
        "¥1,234,567",
        "月末締め",
        "Save all changes",
    ] {
        assert!(text.contains(expected), "{expected} in {text}");
    }
    // Buttons on one row come left to right, and a part of a line is found.
    let buttons = ["検索", "保存", "終了"];
    let row: Vec<String> = lines
        .iter()
        .map(OcrLine::text)
        .filter(|t| buttons.contains(&t.as_str()))
        .collect();
    assert_eq!(row, ["検索", "保存", "終了"]);
    let save = find_text(&lines, "保存", false);
    assert_eq!(save.len(), 1);
    let (x, y) = save[0].center();
    assert!(
        (395..=422).contains(&x) && (162..=182).contains(&y),
        "{:?}",
        save[0]
    );
    let amount = find_text(&lines, "金額", false);
    let (x, _) = amount[0].center();
    assert!((40..=66).contains(&x), "{:?}", amount[0]);
}

//! Pictures of windows (GDI) and text recognition (Windows OCR,
//! `Windows.Media.Ocr`, offline, for every language whose OCR pack is
//! installed; Japanese Windows has Japanese). Called on the UI Automation
//! thread, which has joined the multithreaded apartment WinRT needs.
//!
//! Besides `uia`, the only module that may use `unsafe` (GDI calls).

#![allow(unsafe_code)]

use serde_json::json;
use shikigami_runtime::StepError;
use windows::Foundation::Rect as WinRect;
use windows::Globalization::Language;
use windows::Graphics::Imaging::{
    BitmapAlphaMode, BitmapDecoder, BitmapPixelFormat, BitmapTransform, ColorManagementMode,
    ExifOrientationMode, SoftwareBitmap,
};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::DataWriter;
use windows::Storage::{FileAccessMode, StorageFile};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CAPTUREBLT, CreateCompatibleBitmap,
    CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, GetDIBits, HBITMAP, HDC,
    ReleaseDC, SRCCOPY, SelectObject,
};
use windows::Win32::Storage::Xps::{PRINT_WINDOW_FLAGS, PrintWindow};
use windows::Win32::System::LibraryLoader::{LOAD_WITH_ALTERED_SEARCH_PATH, LoadLibraryExW};
use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;
use windows::core::HSTRING;

use crate::bitmap::{Bitmap, Rect};
use crate::vision::{OcrLine, OcrWord};

/// Pictures up to this size are doubled for Windows OCR.
const UPSCALE_BELOW: u32 = 1600;

/// `PW_RENDERFULLCONTENT`: also windows drawn with DirectX (browsers,
/// remote desktop clients).
const PW_RENDERFULLCONTENT: PRINT_WINDOW_FLAGS = PRINT_WINDOW_FLAGS(2);

/// The window as it draws itself, even behind other windows, cut to
/// `rect` (screen pixels). `None` when the app does not draw for
/// PrintWindow (it comes back blank).
pub fn print_window(window: HWND, rect: RECT) -> Option<Bitmap> {
    let mut outer = RECT::default();
    // SAFETY: plain Win32 calls; every GDI object is released below.
    unsafe {
        GetWindowRect(window, &mut outer).ok()?;
        let (w, h) = (outer.right - outer.left, outer.bottom - outer.top);
        let image = with_bitmap(w, h, |dc, _| {
            PrintWindow(window, dc, PW_RENDERFULLCONTENT).as_bool()
        })?;
        let image = image.crop(Rect {
            x: rect.left - outer.left,
            y: rect.top - outer.top,
            width: (rect.right - rect.left).max(0) as u32,
            height: (rect.bottom - rect.top).max(0) as u32,
        })?;
        (!image.is_blank()).then_some(image)
    }
}

/// What the screen shows inside `rect` (the window must be in front).
pub fn copy_screen(rect: RECT) -> Result<Bitmap, StepError> {
    let (w, h) = (rect.right - rect.left, rect.bottom - rect.top);
    // SAFETY: plain Win32 calls; every GDI object is released below.
    let image = unsafe {
        with_bitmap(w, h, |dc, screen| {
            BitBlt(
                dc,
                0,
                0,
                w,
                h,
                Some(screen),
                rect.left,
                rect.top,
                SRCCOPY | CAPTUREBLT,
            )
            .is_ok()
        })
    };
    image.ok_or_else(|| {
        StepError::new(
            "CAPTURE_FAILED",
            "Windows did not give a picture of the screen",
        )
        .with_details(
            json!({ "hint": "Keep the screen unlocked while steps that look at the screen run." }),
        )
    })
}

/// Runs `draw` into a `w` × `h` bitmap and reads its pixels.
unsafe fn with_bitmap(w: i32, h: i32, draw: impl FnOnce(HDC, HDC) -> bool) -> Option<Bitmap> {
    if w <= 0 || h <= 0 {
        return None;
    }
    // SAFETY: the caller's; objects are selected out and deleted in order.
    unsafe {
        let screen = GetDC(None);
        let dc = CreateCompatibleDC(Some(screen));
        let bitmap: HBITMAP = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(dc, bitmap.into());
        let drawn = draw(dc, screen);
        SelectObject(dc, old);
        let pixels = drawn.then(|| read_pixels(dc, bitmap, w, h)).flatten();
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(dc);
        ReleaseDC(None, screen);
        pixels.map(|bgra| Bitmap::from_bgra(w as u32, h as u32, bgra))
    }
}

unsafe fn read_pixels(dc: HDC, bitmap: HBITMAP, w: i32, h: i32) -> Option<Vec<u8>> {
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            // Negative: rows from the top.
            biHeight: -h,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut pixels = vec![0u8; w as usize * h as usize * 4];
    // SAFETY: the buffer holds h rows of w 32-bit pixels, as `info` says.
    let rows = unsafe {
        GetDIBits(
            dc,
            bitmap,
            0,
            h as u32,
            Some(pixels.as_mut_ptr().cast()),
            &mut info,
            DIB_RGB_COLORS,
        )
    };
    (rows == h).then_some(pixels)
}

/// The lines Windows OCR reads in `image`.
pub fn recognize(image: &Bitmap, language: Option<&str>) -> Result<Vec<OcrLine>, StepError> {
    let engine = engine(language)?;
    // Windows OCR reads small screen text better enlarged, and refuses
    // pictures larger than its limit: scale, then map back.
    let max = OcrEngine::MaxImageDimension().unwrap_or(4096).max(1);
    let longest = image.width.max(image.height);
    let factor = if longest > max {
        max as f32 / longest as f32
    } else if longest * 2 <= max.min(UPSCALE_BELOW * 2) {
        2.0
    } else {
        1.0
    };
    let scaled;
    let image = if factor != 1.0 {
        scaled = image.scaled(factor);
        &scaled
    } else {
        image
    };
    let ocr_error = |e: windows::core::Error| StepError::new("OCR_FAILED", format!("OCR: {e}"));
    let writer = DataWriter::new().map_err(ocr_error)?;
    writer.WriteBytes(&image.to_bgra()).map_err(ocr_error)?;
    let buffer = writer.DetachBuffer().map_err(ocr_error)?;
    let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
        &buffer,
        BitmapPixelFormat::Bgra8,
        image.width as i32,
        image.height as i32,
    )
    .map_err(ocr_error)?;
    let result = engine
        .RecognizeAsync(&bitmap)
        .and_then(|op| op.join())
        .map_err(ocr_error)?;
    let back = |r: WinRect| Rect {
        x: (r.X / factor).round() as i32,
        y: (r.Y / factor).round() as i32,
        width: ((r.Width / factor).round() as u32).max(1),
        height: ((r.Height / factor).round() as u32).max(1),
    };
    let mut lines = Vec::new();
    for line in result.Lines().map_err(ocr_error)? {
        let mut words = Vec::new();
        for word in line.Words().map_err(ocr_error)? {
            words.push(OcrWord {
                text: word.Text().map_err(ocr_error)?.to_string(),
                rect: back(word.BoundingRect().map_err(ocr_error)?),
            });
        }
        lines.push(OcrLine { words });
    }
    Ok(lines)
}

fn engine(language: Option<&str>) -> Result<OcrEngine, StepError> {
    let available = || -> Vec<String> {
        OcrEngine::AvailableRecognizerLanguages()
            .map(|langs| {
                langs
                    .into_iter()
                    .filter_map(|l| l.LanguageTag().ok())
                    .map(|t| t.to_string())
                    .collect()
            })
            .unwrap_or_default()
    };
    let missing = |what: String| {
        StepError::permanent("OCR_LANGUAGE_MISSING", what).with_details(json!({
            "available": available(),
            "hint": "Use one of the available languages, or install the OCR pack (Settings > Time & language > Language, or as administrator: Add-WindowsCapability -Online -Name \"Language.OCR~~~ja-JP~0.0.1.0\").",
        }))
    };
    match language {
        Some(tag) => {
            let lang = Language::CreateLanguage(&HSTRING::from(tag))
                .map_err(|_| missing(format!("'{tag}' is not a language tag")))?;
            if !OcrEngine::IsLanguageSupported(&lang).unwrap_or(false) {
                return Err(missing(format!(
                    "OCR for '{tag}' is not installed on this PC"
                )));
            }
            OcrEngine::TryCreateFromLanguage(&lang)
                .map_err(|_| missing(format!("OCR for '{tag}' is not available")))
        }
        None => OcrEngine::TryCreateFromUserProfileLanguages()
            .map_err(|_| missing("OCR is not installed for any of the user's languages".into())),
    }
}

/// An image file in any format Windows decodes (PNG, JPEG, BMP, GIF,
/// TIFF, ...).
pub fn load_image(path: &str) -> Result<Bitmap, StepError> {
    if path.to_lowercase().ends_with(".png") {
        return crate::backend::load_png(path);
    }
    let open = || -> windows::core::Result<StorageFile> {
        StorageFile::GetFileFromPathAsync(&HSTRING::from(path))?.join()
    };
    let file = open().map_err(|e| crate::backend::image_file_error(path, &e.message()))?;
    let decode = || -> windows::core::Result<Bitmap> {
        let stream = file.OpenAsync(FileAccessMode::Read)?.join()?;
        let decoder = BitmapDecoder::CreateAsync(&stream)?.join()?;
        let (w, h) = (
            decoder.OrientedPixelWidth()?,
            decoder.OrientedPixelHeight()?,
        );
        let data = decoder
            .GetPixelDataTransformedAsync(
                BitmapPixelFormat::Bgra8,
                BitmapAlphaMode::Straight,
                &BitmapTransform::new()?,
                ExifOrientationMode::RespectExifOrientation,
                ColorManagementMode::DoNotColorManage,
            )?
            .join()?
            .DetachPixelData()?;
        let mut bitmap = Bitmap::from_bgra(w, h, data.to_vec());
        // from_bgra makes screen pictures opaque; files keep their alpha.
        for (px, src) in bitmap.rgba.chunks_exact_mut(4).zip(data.chunks_exact(4)) {
            px[3] = src[3];
        }
        Ok(bitmap)
    };
    decode().map_err(|e| {
        StepError::permanent(
            "IMAGE_UNREADABLE",
            format!("{path} could not be read as an image: {}", e.message()),
        )
    })
}

/// Loads a DLL so that the DLLs it needs are looked for in its own folder
/// first (ONNX Runtime ships with the Visual C++ runtime beside it). Later
/// loads of the same path get this module.
pub fn preload_library(path: &std::path::Path) -> Result<(), String> {
    let wide = HSTRING::from(path.as_os_str());
    // SAFETY: loads a library by absolute path; the handle is kept for the
    // life of the process on purpose.
    unsafe { LoadLibraryExW(&wide, None, LOAD_WITH_ALTERED_SEARCH_PATH) }
        .map(|_| ())
        .map_err(|e| format!("cannot load {}: {}", path.display(), e.message()))
}

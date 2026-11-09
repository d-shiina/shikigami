//! Pictures of the screen and image files, in memory. Pure Rust (PNG via the
//! `png` crate), so image search and OCR post-processing are tested without
//! Windows.

use std::io::Cursor;

/// 8-bit RGBA pixels, row by row from the top-left.
#[derive(Clone, PartialEq, Eq)]
pub struct Bitmap {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

impl std::fmt::Debug for Bitmap {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Bitmap({}x{})", self.width, self.height)
    }
}

/// A rectangle in pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    /// The rectangle a drag from `a` to `b` spans (either way round), both
    /// corners inside.
    pub fn spanning(a: (i32, i32), b: (i32, i32)) -> Rect {
        let (x, y) = (a.0.min(b.0), a.1.min(b.1));
        Rect {
            x,
            y,
            width: a.0.abs_diff(b.0) + 1,
            height: a.1.abs_diff(b.1) + 1,
        }
    }

    pub fn right(&self) -> i32 {
        self.x + self.width as i32
    }

    pub fn bottom(&self) -> i32 {
        self.y + self.height as i32
    }

    pub fn center(&self) -> (i32, i32) {
        (
            self.x + (self.width / 2) as i32,
            self.y + (self.height / 2) as i32,
        )
    }

    /// The smallest rectangle around both.
    pub fn union(&self, other: &Rect) -> Rect {
        let x = self.x.min(other.x);
        let y = self.y.min(other.y);
        Rect {
            x,
            y,
            width: (self.right().max(other.right()) - x) as u32,
            height: (self.bottom().max(other.bottom()) - y) as u32,
        }
    }

    /// The part both share, if any.
    pub fn intersect(&self, other: &Rect) -> Option<Rect> {
        let x = self.x.max(other.x);
        let y = self.y.max(other.y);
        let right = self.right().min(other.right());
        let bottom = self.bottom().min(other.bottom());
        (right > x && bottom > y).then(|| Rect {
            x,
            y,
            width: (right - x) as u32,
            height: (bottom - y) as u32,
        })
    }

    pub fn offset(&self, dx: i32, dy: i32) -> Rect {
        Rect {
            x: self.x + dx,
            y: self.y + dy,
            ..*self
        }
    }
}

impl Bitmap {
    /// Paints `rect` (clipped to the picture) in one colour.
    pub fn fill(&mut self, rect: Rect, rgba: [u8; 4]) {
        let whole = Rect {
            x: 0,
            y: 0,
            width: self.width,
            height: self.height,
        };
        let Some(r) = rect.intersect(&whole) else {
            return;
        };
        for y in r.y..r.bottom() {
            let start = (y as usize * self.width as usize + r.x as usize) * 4;
            for px in self.rgba[start..start + r.width as usize * 4]
                .as_chunks_mut::<4>()
                .0
            {
                *px = rgba;
            }
        }
    }

    pub fn new(width: u32, height: u32, rgba: Vec<u8>) -> Self {
        debug_assert_eq!(rgba.len(), width as usize * height as usize * 4);
        Self {
            width,
            height,
            rgba,
        }
    }

    /// From BGRA rows (as Windows GDI and WinRT give them); alpha is set
    /// to opaque, since screen captures carry none.
    pub fn from_bgra(width: u32, height: u32, mut bgra: Vec<u8>) -> Self {
        for px in bgra.as_chunks_mut::<4>().0.iter_mut() {
            px.swap(0, 2);
            px[3] = 255;
        }
        Self::new(width, height, bgra)
    }

    pub fn to_bgra(&self) -> Vec<u8> {
        let mut out = self.rgba.clone();
        for px in out.as_chunks_mut::<4>().0.iter_mut() {
            px.swap(0, 2);
        }
        out
    }

    pub fn bounds(&self) -> Rect {
        Rect {
            x: 0,
            y: 0,
            width: self.width,
            height: self.height,
        }
    }

    /// Decodes a PNG file's bytes (any colour type and bit depth).
    pub fn from_png(bytes: &[u8]) -> Result<Self, String> {
        let mut decoder = png::Decoder::new(Cursor::new(bytes));
        decoder.set_transformations(png::Transformations::normalize_to_color8());
        let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
        let size = reader
            .output_buffer_size()
            .ok_or_else(|| "the image is too large".to_owned())?;
        let mut buf = vec![0; size];
        let info = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
        let (width, height) = (info.width, info.height);
        let pixels = width as usize * height as usize;
        let mut rgba = Vec::with_capacity(pixels * 4);
        let rows = buf.chunks(info.line_size).take(height as usize);
        for row in rows {
            let row = &row[..width as usize * info.color_type.samples()];
            match info.color_type {
                png::ColorType::Rgba => rgba.extend_from_slice(row),
                png::ColorType::Rgb => {
                    for px in row.as_chunks::<3>().0.iter() {
                        rgba.extend_from_slice(&[px[0], px[1], px[2], 255]);
                    }
                }
                png::ColorType::GrayscaleAlpha => {
                    for px in row.as_chunks::<2>().0.iter() {
                        rgba.extend_from_slice(&[px[0], px[0], px[0], px[1]]);
                    }
                }
                png::ColorType::Grayscale => {
                    for &g in row {
                        rgba.extend_from_slice(&[g, g, g, 255]);
                    }
                }
                png::ColorType::Indexed => return Err("unexpected palette image".into()),
            }
        }
        if rgba.len() != pixels * 4 {
            return Err("the image data is incomplete".into());
        }
        Ok(Self::new(width, height, rgba))
    }

    pub fn to_png(&self) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut out, self.width, self.height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            // Encoding into memory fails only on a size mismatch, which
            // `new` rules out.
            if let Ok(mut writer) = encoder.write_header() {
                let _ = writer.write_image_data(&self.rgba);
            }
        }
        out
    }

    /// The part inside `rect` (clipped to the picture).
    pub fn crop(&self, rect: Rect) -> Option<Bitmap> {
        let r = rect.intersect(&self.bounds())?;
        let mut rgba = Vec::with_capacity(r.width as usize * r.height as usize * 4);
        for y in r.y..r.bottom() {
            let start = (y as usize * self.width as usize + r.x as usize) * 4;
            rgba.extend_from_slice(&self.rgba[start..start + r.width as usize * 4]);
        }
        Some(Bitmap::new(r.width, r.height, rgba))
    }

    /// Darker, keeping `keep` / 255 of each colour (the screen behind the
    /// cutter of 「画面から切り取る」).
    pub fn dimmed(&self, keep: u8) -> Bitmap {
        let mut rgba = self.rgba.clone();
        for px in rgba.as_chunks_mut::<4>().0.iter_mut() {
            for c in &mut px[..3] {
                *c = (u16::from(*c) * u16::from(keep) / 255) as u8;
            }
        }
        Bitmap::new(self.width, self.height, rgba)
    }

    /// Every pixel the same colour (a window that could not be captured
    /// comes back black).
    pub fn is_blank(&self) -> bool {
        let mut pixels = self.rgba.as_chunks::<4>().0.iter();
        match pixels.next() {
            Some(first) => pixels.all(|px| px[..3] == first[..3]),
            None => true,
        }
    }

    /// Resized by `factor` with bilinear filtering (OCR reads small text
    /// better enlarged).
    pub fn scaled(&self, factor: f32) -> Bitmap {
        let width = ((self.width as f32 * factor).round() as u32).max(1);
        let height = ((self.height as f32 * factor).round() as u32).max(1);
        self.resized(width, height)
    }

    /// Resized to `width` × `height` with bilinear filtering.
    /// Turned a quarter left: the top edge becomes the left one (a vertical
    /// line of text then reads left to right).
    pub fn rotated_left(&self) -> Bitmap {
        let (w, h) = (self.width as usize, self.height as usize);
        let mut rgba = vec![0u8; w * h * 4];
        // Pixel (x, y) moves to (y, w - 1 - x) in an h × w picture.
        for y in 0..h {
            for x in 0..w {
                let from = (y * w + x) * 4;
                let to = ((w - 1 - x) * h + y) * 4;
                rgba[to..to + 4].copy_from_slice(&self.rgba[from..from + 4]);
            }
        }
        Bitmap::new(self.height, self.width, rgba)
    }

    pub fn resized(&self, width: u32, height: u32) -> Bitmap {
        let (width, height) = (width.max(1), height.max(1));
        let fx_scale = width as f32 / self.width as f32;
        let fy_scale = height as f32 / self.height as f32;
        let mut rgba = Vec::with_capacity(width as usize * height as usize * 4);
        let max_x = self.width.saturating_sub(1) as f32;
        let max_y = self.height.saturating_sub(1) as f32;
        let at = |x: u32, y: u32| (y as usize * self.width as usize + x as usize) * 4;
        for oy in 0..height {
            let sy = ((oy as f32 + 0.5) / fy_scale - 0.5).clamp(0.0, max_y);
            let (y0, fy) = (sy.floor() as u32, sy.fract());
            let y1 = (y0 + 1).min(self.height - 1);
            for ox in 0..width {
                let sx = ((ox as f32 + 0.5) / fx_scale - 0.5).clamp(0.0, max_x);
                let (x0, fx) = (sx.floor() as u32, sx.fract());
                let x1 = (x0 + 1).min(self.width - 1);
                for c in 0..4 {
                    let p = |x, y| f32::from(self.rgba[at(x, y) + c]);
                    let top = p(x0, y0) * (1.0 - fx) + p(x1, y0) * fx;
                    let bottom = p(x0, y1) * (1.0 - fx) + p(x1, y1) * fx;
                    rgba.push((top * (1.0 - fy) + bottom * fy).round() as u8);
                }
            }
        }
        Bitmap::new(width, height, rgba)
    }

    /// Brightness of each pixel (0–255), for image search. Transparent
    /// pixels of an image file count as white.
    pub fn gray(&self) -> Gray {
        let values = self
            .rgba
            .as_chunks::<4>()
            .0
            .iter()
            .map(|px| {
                let [r, g, b, a] = [px[0], px[1], px[2], px[3]].map(f32::from);
                let luma = 0.299 * r + 0.587 * g + 0.114 * b;
                let alpha = a / 255.0;
                luma * alpha + 255.0 * (1.0 - alpha)
            })
            .collect();
        Gray {
            width: self.width,
            height: self.height,
            values,
        }
    }
}

/// One brightness value per pixel.
#[derive(Debug, Clone, PartialEq)]
pub struct Gray {
    pub width: u32,
    pub height: u32,
    pub values: Vec<f32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_drag_spans_its_corners_either_way_round() {
        let r = Rect::spanning((10, 20), (3, 25));
        assert_eq!(
            r,
            Rect {
                x: 3,
                y: 20,
                width: 8,
                height: 6
            }
        );
        assert_eq!(Rect::spanning((3, 25), (10, 20)), r);
        assert_eq!(Rect::spanning((-5, -5), (-5, -5)).width, 1);
    }

    #[test]
    fn dimming_keeps_alpha_and_darkens_colour() {
        let image = Bitmap::new(1, 1, vec![255, 100, 0, 255]);
        assert_eq!(image.dimmed(110).rgba, vec![110, 43, 0, 255]);
        assert_eq!(image.dimmed(255), image);
    }
}

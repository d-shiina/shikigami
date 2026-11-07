//! A table on the screen read as rows and columns: the 明細 of an invoice,
//! a list in a business app, a spreadsheet. Ruled lines (borders, grid
//! lines) give the cells; without them, the columns are the gaps that run
//! down every row of text. OCR's words then go into the cell under their
//! centre. Pure logic, tested without Windows.

use serde_json::{Map, Value, json};

use crate::bitmap::{Bitmap, Gray, Rect};
use crate::vision::OcrLine;

/// A pixel is part of a ruled line when its brightness is this far from the
/// background's (light grey grid lines on white, and on a dark theme).
const LINE_CONTRAST: f32 = 18.0;
/// Ruled lines are at least this long (longer than any stroke of a
/// character at screen sizes)...
const MIN_LINE: usize = 40;
/// ... and at most this thick (a filled bar is not a line).
const MAX_THICKNESS: usize = 4;
/// Gaps in a ruled line up to this long are noise, not its end.
const MAX_GAP: usize = 2;
/// A gap this wide, empty down every row, separates columns of a table
/// without lines.
const MIN_GAP: i32 = 10;

/// A ruled line: along `from..to` at `at` (y for horizontal, x for
/// vertical).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rule {
    pub at: i32,
    pub from: i32,
    pub to: i32,
}

impl Rule {
    fn len(&self) -> i32 {
        self.to - self.from
    }
}

/// The table: its cells' text, row by row, and whether ruled lines gave
/// them.
#[derive(Debug, Clone, PartialEq)]
pub struct Table {
    pub cells: Vec<Vec<String>>,
    pub ruled: bool,
}

/// The background's brightness: the most common one.
fn background(gray: &Gray) -> f32 {
    let mut counts = [0usize; 256];
    for &v in &gray.values {
        counts[v.clamp(0.0, 255.0) as usize] += 1;
    }
    counts
        .iter()
        .enumerate()
        .max_by_key(|&(_, &n)| n)
        .map_or(255.0, |(v, _)| v as f32)
}

/// Runs of line pixels along each row (`horizontal`) or column, merged
/// across neighbouring rows into rules, thin ones only.
fn rules(gray: &Gray, horizontal: bool) -> Vec<Rule> {
    let bg = background(gray);
    let (w, h) = (gray.width as usize, gray.height as usize);
    let (outer, inner) = if horizontal { (h, w) } else { (w, h) };
    let at = |o: usize, i: usize| {
        let (x, y) = if horizontal { (i, o) } else { (o, i) };
        (gray.values[y * w + x] - bg).abs() >= LINE_CONTRAST
    };
    // Runs per row: (row, from, to).
    let mut runs: Vec<(usize, usize, usize)> = Vec::new();
    for o in 0..outer {
        // (start, last line pixel): a gap of up to MAX_GAP pixels (JPEG
        // noise of a remote screen) does not end a run.
        let mut run: Option<(usize, usize)> = None;
        for i in 0..=inner {
            let on = i < inner && at(o, i);
            match (on, run) {
                (true, None) => run = Some((i, i)),
                (true, Some((s, _))) => run = Some((s, i)),
                (false, Some((s, last))) if i == inner || i - last > MAX_GAP => {
                    if last + 1 - s >= MIN_LINE {
                        runs.push((o, s, last + 1));
                    }
                    run = None;
                }
                _ => {}
            }
        }
    }
    // Neighbouring rows' overlapping runs are one rule.
    let mut groups: Vec<(usize, usize, usize, usize)> = Vec::new(); // first, last, from, to
    for (o, from, to) in runs {
        match groups
            .iter_mut()
            .rev()
            .find(|g| g.1 + 1 == o && overlap(g.2, g.3, from, to) > 0.8)
        {
            Some(g) => {
                g.1 = o;
                g.2 = g.2.min(from);
                g.3 = g.3.max(to);
            }
            None => groups.push((o, o, from, to)),
        }
    }
    let contrast = |o: usize, i: usize| {
        let (x, y) = if horizontal { (i, o) } else { (o, i) };
        (gray.values[y * w + x] - bg).abs()
    };
    // A line has background beside it; a row through the middle of a line
    // of text (strokes close together) has more text beside it. Beside
    // counts what is at least half as dark as the line itself, so a light
    // shaded header under its border is still background.
    let clear = |o: Option<usize>, from: usize, to: usize, strength: f32| {
        let enough = (strength / 2.0).max(LINE_CONTRAST);
        o.filter(|&o| o < outer).is_none_or(|o| {
            (from..to).filter(|&i| contrast(o, i) >= enough).count() * 2 < to - from
        })
    };
    let mut out: Vec<Rule> = groups
        .into_iter()
        .filter(|g| g.1 - g.0 < MAX_THICKNESS)
        .filter(|&(first, last, from, to)| {
            let strength = (from..to).map(|i| contrast(first, i)).sum::<f32>() / (to - from) as f32;
            clear(first.checked_sub(2), from, to, strength)
                && clear(Some(last + 2), from, to, strength)
        })
        .map(|(first, last, from, to)| Rule {
            at: ((first + last) / 2) as i32,
            from: from as i32,
            to: to as i32,
        })
        .collect();
    // Pieces of one line broken by noise are one rule.
    out.sort_by_key(|r| (r.at, r.from));
    let mut merged: Vec<Rule> = Vec::new();
    for r in out {
        match merged.last_mut() {
            Some(m) if (r.at - m.at).abs() <= 1 && r.from - m.to <= 8 => m.to = m.to.max(r.to),
            _ => merged.push(r),
        }
    }
    merged
}

/// How much of the shorter of two spans the other covers.
fn overlap(a0: usize, a1: usize, b0: usize, b1: usize) -> f32 {
    let common = a1.min(b1).saturating_sub(a0.max(b0));
    common as f32 / (a1 - a0).min(b1 - b0).max(1) as f32
}

/// Positions within `tolerance` of each other as one (sorted).
fn cluster(mut values: Vec<i32>, tolerance: i32) -> Vec<i32> {
    values.sort_unstable();
    let mut out: Vec<Vec<i32>> = Vec::new();
    for v in values {
        match out.last_mut() {
            Some(group) if v - group[group.len() - 1] <= tolerance => group.push(v),
            _ => out.push(vec![v]),
        }
    }
    out.iter()
        .map(|g| g.iter().sum::<i32>() / g.len() as i32)
        .collect()
}

/// The words of `lines` with their centres.
fn words(lines: &[OcrLine]) -> Vec<(String, Rect)> {
    lines
        .iter()
        .flat_map(|l| &l.words)
        .filter(|w| !w.text.trim().is_empty())
        .map(|w| (w.text.clone(), w.rect))
        .collect()
}

/// Joins the words of one cell as a line reads them.
fn cell_text(mut words: Vec<(String, Rect)>) -> String {
    // Lines first: a word whose middle is within the line's first word
    // (glyphs of different heights) is on that line. Then left to right.
    words.sort_by_key(|(_, r)| r.center().1);
    let mut lines: Vec<Vec<(String, Rect)>> = Vec::new();
    for word in words {
        let cy = word.1.center().1;
        match lines.last_mut() {
            Some(line) if cy >= line[0].1.y && cy <= line[0].1.bottom() => line.push(word),
            _ => lines.push(vec![word]),
        }
    }
    for line in &mut lines {
        line.sort_by_key(|(_, r)| r.x);
    }
    let line = OcrLine {
        words: lines
            .into_iter()
            .flatten()
            .map(|(text, rect)| crate::vision::OcrWord {
                text,
                rect,
                confidence: None,
            })
            .collect(),
    };
    line.text()
}

/// The table in `image` (OCR read `lines` in it): the one with ruled lines
/// when there is one, otherwise the text laid out in columns. `None` when
/// there is no table (fewer than two rows or columns).
pub fn read_table(image: &Bitmap, lines: &[OcrLine]) -> Option<Table> {
    let gray = image.gray();
    ruled_table(&gray, lines).or_else(|| aligned_table(lines))
}

/// Cells between ruled lines: rows between the horizontal rules of the
/// longest rule's table, columns at every vertical rule inside it.
fn ruled_table(gray: &Gray, lines: &[OcrLine]) -> Option<Table> {
    let across = rules(gray, true);
    let down = rules(gray, false);
    let longest = across.iter().max_by_key(|r| r.len())?;
    let (left, right) = (longest.from, longest.to);
    let width = right - left;
    // The table's horizontal rules: as wide as the longest (most of it), or
    // the inner ones between columns, at least half.
    let ys = cluster(
        across
            .iter()
            .filter(|r| r.from <= left + width / 2 && r.to >= right - width / 2)
            .map(|r| r.at)
            .collect(),
        3,
    );
    if ys.len() < 2 {
        return None;
    }

    let (top, bottom) = (ys[0], ys[ys.len() - 1]);
    let xs = cluster(
        down.iter()
            .filter(|r| r.at >= left - 3 && r.at <= right + 3)
            .filter(|r| r.from <= bottom && r.to >= top && r.len() >= (bottom - top) / 8)
            .map(|r| r.at)
            .chain([left, right])
            .collect(),
        3,
    );
    let words = words(lines);
    let mut cells: Vec<Vec<String>> = Vec::new();
    for band in ys.windows(2) {
        let (y0, y1) = (band[0], band[1]);
        // The rules crossing this row: a merged cell ("小計" across several
        // columns) has none inside it. Its text goes to the column under
        // its middle.
        let middle = (y0 + y1) / 2;
        let here: Vec<i32> = xs
            .iter()
            .copied()
            .filter(|&x| {
                x == left
                    || x == right
                    || down
                        .iter()
                        .any(|r| (r.at - x).abs() <= 3 && r.from <= middle && r.to >= middle)
            })
            .collect();
        let mut row = vec![String::new(); xs.len() - 1];
        for cell in here.windows(2) {
            let (x0, x1) = (cell[0], cell[1]);
            let inside: Vec<(String, Rect)> = words
                .iter()
                .filter(|(_, r)| {
                    let (cx, cy) = r.center();
                    cx > x0 && cx < x1 && cy > y0 && cy < y1
                })
                .cloned()
                .collect();
            let Some(span) = inside.iter().map(|(_, r)| *r).reduce(|a, b| a.union(&b)) else {
                continue;
            };
            let cx = span.center().0;
            let column = xs
                .windows(2)
                .position(|c| cx > c[0] && cx <= c[1])
                .unwrap_or(0);
            row[column] = cell_text(inside);
        }
        cells.push(row);
    }
    // Only horizontal rules: the columns come from the text's gaps.
    if xs.len() <= 2 {
        let inside: Vec<OcrLine> = lines
            .iter()
            .filter(|l| {
                l.rect().is_some_and(|r| {
                    let (cx, cy) = r.center();
                    cx > left && cx < right && cy > top && cy < bottom
                })
            })
            .cloned()
            .collect();
        let columns = column_gaps(&inside)?;
        let mut cells = Vec::new();
        for band in ys.windows(2) {
            let row_words: Vec<(String, Rect)> = words
                .iter()
                .filter(|(_, r)| {
                    let (cx, cy) = r.center();
                    cx > left && cx < right && cy > band[0] && cy < band[1]
                })
                .cloned()
                .collect();
            if band[1] - band[0] >= 6 {
                cells.push(split_by(&columns, row_words));
            }
        }
        return keep(Table { cells, ruled: true });
    }
    keep(Table { cells, ruled: true })
}

/// A table worth returning: two rows and two columns. Rows and columns
/// without text (between two close rules) are dropped.
fn keep(mut table: Table) -> Option<Table> {
    table.cells.retain(|row| row.iter().any(|c| !c.is_empty()));
    // Columns without text (slivers between a border and a rule beside it).
    let width = table.cells.iter().map(Vec::len).max().unwrap_or(0);
    let used: Vec<bool> = (0..width)
        .map(|i| {
            table
                .cells
                .iter()
                .any(|row| row.get(i).is_some_and(|c| !c.is_empty()))
        })
        .collect();
    for row in &mut table.cells {
        let mut i = 0;
        row.retain(|_| {
            i += 1;
            used.get(i - 1).copied().unwrap_or(false)
        });
    }
    let cols = table.cells.iter().map(Vec::len).max().unwrap_or(0);
    let text = table.cells.iter().flatten().any(|c| !c.is_empty());
    (table.cells.len() >= 2 && cols >= 2 && text).then_some(table)
}

/// The column boundaries (x of each gap's middle) of lines laid out in
/// columns: gaps at least [`MIN_GAP`] wide that no line of a row with two
/// or more lines covers.
fn column_gaps(lines: &[OcrLine]) -> Option<Vec<i32>> {
    let rows = rows_of(lines);
    let tabular: Vec<&Vec<Rect>> = rows.iter().filter(|r| r.len() >= 2).collect();
    if tabular.len() < 2 {
        return None;
    }
    let left = tabular.iter().flat_map(|r| r.iter().map(|x| x.x)).min()?;
    let right = tabular
        .iter()
        .flat_map(|r| r.iter().map(Rect::right))
        .max()?;
    let mut covered = vec![false; (right - left).max(0) as usize + 1];
    for rect in tabular.iter().flat_map(|r| r.iter()) {
        for x in rect.x..rect.right() {
            covered[(x - left) as usize] = true;
        }
    }
    let mut gaps = Vec::new();
    let mut start = None;
    for (i, &c) in covered.iter().enumerate() {
        match (c, start) {
            (false, None) => start = Some(i as i32),
            (true, Some(s)) => {
                if i as i32 - s >= MIN_GAP {
                    gaps.push(left + (s + i as i32) / 2);
                }
                start = None;
            }
            _ => {}
        }
    }
    (!gaps.is_empty()).then_some(gaps)
}

/// The boxes of the pieces of text in `lines`: a line is split where its
/// words are a column gap apart (an engine may return a whole table row
/// as one line).
fn pieces(lines: &[OcrLine]) -> Vec<Rect> {
    let mut out = Vec::new();
    for line in lines {
        let mut words: Vec<Rect> = line
            .words
            .iter()
            .filter(|w| !w.text.trim().is_empty())
            .map(|w| w.rect)
            .collect();
        words.sort_by_key(|r| r.x);
        let mut piece: Option<Rect> = None;
        for r in words {
            piece = Some(match piece {
                Some(p) if r.x - p.right() >= MIN_GAP.max(p.height.min(r.height) as i32) => {
                    out.push(p);
                    r
                }
                Some(p) => p.union(&r),
                None => r,
            });
        }
        out.extend(piece);
    }
    out
}

/// Pieces of text grouped into rows (by their vertical middle), top to
/// bottom.
fn rows_of(lines: &[OcrLine]) -> Vec<Vec<Rect>> {
    let mut rects: Vec<Rect> = pieces(lines);
    rects.sort_by_key(|r| r.center().1);
    let mut rows: Vec<Vec<Rect>> = Vec::new();
    for r in rects {
        match rows.last_mut() {
            Some(row)
                if {
                    let first = row[0];
                    (r.center().1 - first.center().1).abs()
                        < (first.height.min(r.height) as i32) / 2
                } =>
            {
                row.push(r)
            }
            _ => rows.push(vec![r]),
        }
    }
    rows
}

/// Words split into the columns between `gaps`.
fn split_by(gaps: &[i32], words: Vec<(String, Rect)>) -> Vec<String> {
    let mut cols: Vec<Vec<(String, Rect)>> = vec![Vec::new(); gaps.len() + 1];
    for (text, rect) in words {
        let cx = rect.center().0;
        let i = gaps.iter().take_while(|&&g| cx > g).count();
        cols[i].push((text, rect));
    }
    cols.into_iter().map(cell_text).collect()
}

/// Without ruled lines: the rows of text that sit in columns (two or more
/// pieces in a row), split at the gaps running down all of them.
fn aligned_table(lines: &[OcrLine]) -> Option<Table> {
    let gaps = column_gaps(lines)?;
    let words = words(lines);
    let mut cells = Vec::new();
    for row in rows_of(lines) {
        if row.len() < 2 {
            continue;
        }
        let top = row.iter().map(|r| r.y).min().unwrap_or(0);
        let bottom = row.iter().map(Rect::bottom).max().unwrap_or(0);
        let row_words: Vec<(String, Rect)> = words
            .iter()
            .filter(|(_, r)| {
                let cy = r.center().1;
                cy >= top && cy <= bottom
            })
            .cloned()
            .collect();
        cells.push(split_by(&gaps, row_words));
    }
    keep(Table {
        cells,
        ruled: false,
    })
}

/// The table as returned by desktop.readText with `table: true`: `cells`
/// (every row, as lists of text), and `rows`, the rows after the header
/// row `header` (1-based; 0: none) as records named by its cells (empty
/// names become 列1, 列2, ...).
pub fn table_json(table: &Table, header: usize) -> Value {
    let rows: Vec<Value> = if header == 0 || header > table.cells.len() {
        Vec::new()
    } else {
        let names: Vec<String> = table.cells[header - 1]
            .iter()
            .enumerate()
            .map(|(i, n)| {
                if n.is_empty() {
                    format!("列{}", i + 1)
                } else {
                    n.clone()
                }
            })
            .collect();
        table.cells[header..]
            .iter()
            .filter(|row| row.iter().any(|c| !c.is_empty()))
            .map(|row| {
                let mut record = Map::new();
                for (i, name) in names.iter().enumerate() {
                    let mut name = name.clone();
                    while record.contains_key(&name) {
                        name.push('_');
                    }
                    record.insert(name, json!(row.get(i).cloned().unwrap_or_default()));
                }
                Value::Object(record)
            })
            .collect()
    };
    json!({ "cells": table.cells, "rows": rows, "ruled": table.ruled })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vision::OcrWord;

    fn line(words: &[(&str, i32, i32, u32)]) -> OcrLine {
        OcrLine {
            words: words
                .iter()
                .map(|&(text, x, y, width)| OcrWord {
                    text: text.into(),
                    rect: Rect {
                        x,
                        y,
                        width,
                        height: 16,
                    },
                    confidence: None,
                })
                .collect(),
        }
    }

    /// Without ruled lines, the columns are the gaps down every row; a
    /// title above the table is not a row of it.
    #[test]
    fn text_in_columns_is_a_table() {
        let blank = Bitmap::new(400, 200, vec![255; 400 * 200 * 4]);
        let lines = vec![
            line(&[("受注一覧", 10, 0, 80)]),
            line(&[("品名", 10, 40, 40)]),
            line(&[("数量", 200, 40, 40)]),
            line(&[("用紙", 10, 70, 40)]),
            line(&[("20", 220, 70, 20)]),
            line(&[("トナー", 10, 100, 60)]),
            line(&[("3", 230, 100, 10)]),
        ];
        let table = read_table(&blank, &lines).unwrap();
        assert!(!table.ruled);
        assert_eq!(
            table.cells,
            [["品名", "数量"], ["用紙", "20"], ["トナー", "3"]]
        );
        let json = table_json(&table, 1);
        assert_eq!(
            json["rows"],
            json!([{ "品名": "用紙", "数量": "20" }, { "品名": "トナー", "数量": "3" }])
        );
        assert_eq!(table_json(&table, 0)["rows"], json!([]));
    }

    #[test]
    fn empty_and_repeated_header_names_are_numbered() {
        let table = Table {
            cells: vec![
                vec!["".into(), "金額".into(), "金額".into()],
                vec!["1".into(), "100".into(), "200".into()],
                vec!["".into(), "".into(), "".into()],
            ],
            ruled: true,
        };
        assert_eq!(
            table_json(&table, 1)["rows"],
            json!([{ "列1": "1", "金額": "100", "金額_": "200" }])
        );
    }

    /// A whole row as one line of words (as Windows OCR may give it) is
    /// still split at the gaps between its columns.
    #[test]
    fn rows_read_as_one_line_are_split_at_column_gaps() {
        let table = aligned_table(&[
            line(&[("品名", 10, 10, 40), ("金額", 200, 10, 40)]),
            line(&[("用紙", 10, 40, 40), ("450", 200, 40, 30)]),
            line(&[("トナー", 10, 70, 60), ("12,800", 200, 70, 60)]),
        ])
        .unwrap();
        assert_eq!(
            table.cells,
            vec![
                vec!["品名", "金額"],
                vec!["用紙", "450"],
                vec!["トナー", "12,800"]
            ]
        );
    }

    /// Words of one line whose middles differ by a pixel keep their order.
    #[test]
    fn a_cell_reads_its_words_left_to_right() {
        let at = |x, y| Rect {
            x,
            y,
            width: 30,
            height: 16,
        };
        let text = cell_text(vec![
            ("東京".into(), at(0, 16)),
            ("本店".into(), at(40, 15)),
        ]);
        assert_eq!(text, "東京本店");
    }

    /// The invoices and spreadsheets of the OCR benchmark, read as tables
    /// (ruled lines, a merged 小計 cell, ClearType, remote screens).
    #[test]
    fn ocr_reads_tables_on_business_screens() {
        let Ok(engine) = crate::paddle::engine() else {
            eprintln!("skipped: PaddleOCR is not installed");
            return;
        };
        let mut failed = Vec::new();
        let samples: Vec<_> = crate::ocr_bench::samples()
            .into_iter()
            .filter(|s| s.name.starts_with("invoice-") || s.name.starts_with("sheet-"))
            .filter(|s| s.name.contains("-remote") || s.name.ends_with("-12pt-light"))
            .collect();
        for s in &samples {
            let lines = engine.recognize(&s.image).unwrap();
            let cells = read_table(&s.image, &lines)
                .map(|t| t.cells)
                .unwrap_or_default();
            let fold = |c: &String| c.replace(['（', '）'], "").replace(['(', ')'], "");
            let ok = if s.name.starts_with("invoice-") {
                cells.len() == 7
                    && cells[0] == ["品名", "数量", "単位", "単価", "金額"]
                    && cells[2][1..] == ["4", "個", "12,800", "51,200"]
                    && cells[5][3..] == ["小計", "296,000"]
                    && fold(&cells[6][3]) == "消費税10%"
            } else {
                let header = cells.iter().position(|r| r.iter().any(|c| c == "金額"));
                header.is_some_and(|h| {
                    cells.len() == h + 8
                        && cells[h + 3].iter().any(|c| c == "C-01057")
                        && cells[h + 7].last().is_some_and(|c| c == "¥102,750")
                })
            };
            if !ok {
                failed.push((s.name.clone(), cells));
            }
        }
        for (name, cells) in &failed {
            eprintln!("{name}: {cells:?}");
        }
        assert!(
            failed.len() * 10 <= samples.len(),
            "{} of {} tables read wrong",
            failed.len(),
            samples.len()
        );
    }
}

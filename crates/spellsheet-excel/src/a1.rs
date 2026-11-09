//! A1-style cell addresses (`B3`, `A1:D20`), 1-based like Excel.

/// Excel's largest sheet: 16,384 columns (XFD) × 1,048,576 rows.
pub const MAX_COLUMN: u32 = 16_384;
pub const MAX_ROW: u32 = 1_048_576;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cell {
    pub column: u32,
    pub row: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Range {
    pub start: Cell,
    pub end: Cell,
}

impl Cell {
    /// `B3`, `$B$3` or `b3`.
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim().replace('$', "");
        let split = text.find(|c: char| c.is_ascii_digit())?;
        let (letters, digits) = text.split_at(split);
        if letters.is_empty() || !letters.chars().all(|c| c.is_ascii_alphabetic()) {
            return None;
        }
        let column = letters.chars().try_fold(0u32, |acc, c| {
            let n = acc * 26 + (c.to_ascii_uppercase() as u32 - 'A' as u32 + 1);
            (n <= MAX_COLUMN).then_some(n)
        })?;
        let row: u32 = digits.parse().ok()?;
        (1..=MAX_ROW).contains(&row).then_some(Self { column, row })
    }

    pub fn name(self) -> String {
        format!("{}{}", column_name(self.column), self.row)
    }
}

impl Range {
    /// `A1:D20` (either corner first) or a single cell `B3`.
    pub fn parse(text: &str) -> Option<Self> {
        let (a, b) = match text.split_once(':') {
            Some((a, b)) => (Cell::parse(a)?, Cell::parse(b)?),
            None => {
                let cell = Cell::parse(text)?;
                (cell, cell)
            }
        };
        Some(Self {
            start: Cell {
                column: a.column.min(b.column),
                row: a.row.min(b.row),
            },
            end: Cell {
                column: a.column.max(b.column),
                row: a.row.max(b.row),
            },
        })
    }

    pub fn name(self) -> String {
        format!("{}:{}", self.start.name(), self.end.name())
    }
}

/// `1` → `A`, `27` → `AA`.
pub fn column_name(mut column: u32) -> String {
    let mut name = Vec::new();
    while column > 0 {
        let rem = (column - 1) % 26;
        name.push(b'A' + rem as u8);
        column = (column - 1) / 26;
    }
    name.reverse();
    String::from_utf8(name).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cells_and_ranges() {
        assert_eq!(Cell::parse("B3"), Some(Cell { column: 2, row: 3 }));
        assert_eq!(
            Cell::parse("$aa$10"),
            Some(Cell {
                column: 27,
                row: 10
            })
        );
        assert_eq!(
            Cell::parse("XFD1048576").map(Cell::name).as_deref(),
            Some("XFD1048576")
        );
        for bad in ["", "3B", "B0", "B", "A1B", "XFE1", "B1048577", "あ1"] {
            assert_eq!(Cell::parse(bad), None, "{bad}");
        }
        let range = Range::parse("D20:A1").unwrap();
        assert_eq!(range.name(), "A1:D20");
        assert_eq!(Range::parse("C2").unwrap().name(), "C2:C2");
        assert_eq!(column_name(26), "Z");
        assert_eq!(column_name(28), "AB");
    }
}

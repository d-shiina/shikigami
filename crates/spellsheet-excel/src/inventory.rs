//! A stock-take of work (業務の棚卸し) as an Excel workbook: the tasks in
//! the order to build them, with their numbers, to pass round or print.

use std::path::Path;

use spellsheet_core::inventory::{self, Group, Level, Period, WorkInventory};

/// The words of the sheet, in the language Writer shows.
struct Words {
    sheet: &'static str,
    about: &'static str,
    made: &'static str,
    headers: [&'static str; 18],
    total: &'static str,
    groups: [&'static str; 5],
    levels: [&'static str; 3],
}

const JA: Words = Words {
    sheet: "自動化の候補",
    about: "対象",
    made: "作成",
    headers: [
        "順位",
        "業務",
        "区分",
        "頻度",
        "1 回の時間（分）",
        "人数",
        "月の作業時間（時間）",
        "手作業の割合（%）",
        "削減見込み（時間/月）",
        "作りやすさ",
        "ミスの影響",
        "作りやすさの理由",
        "使用システム",
        "使用ノード",
        "必要なプラグイン",
        "今は向かない理由",
        "作成したフロー",
        "メモ",
    ],
    total: "合計",
    groups: [
        "最初に作る",
        "慣れたら作る",
        "分けて小さくする",
        "聞き取り中",
        "今は向かない",
    ],
    levels: ["高", "中", "低"],
};

const EN: Words = Words {
    sheet: "Automation candidates",
    about: "Whose work",
    made: "Made",
    headers: [
        "Rank",
        "Work",
        "Group",
        "How often",
        "Minutes each",
        "People",
        "Hours a month",
        "Hands-only work (%)",
        "Hours a month saved",
        "Ease",
        "Cost of a mistake",
        "Why that ease",
        "Systems",
        "Nodes",
        "Plugins needed",
        "Why not now",
        "Flows",
        "Note",
    ],
    total: "Total",
    groups: [
        "Build first",
        "Build later",
        "Split it up",
        "Still asking",
        "Not now",
    ],
    levels: ["High", "Medium", "Low"],
};

fn group(words: &Words, g: Group) -> &'static str {
    words.groups[match g {
        Group::First => 0,
        Group::Later => 1,
        Group::Split => 2,
        Group::Unknown => 3,
        Group::NotNow => 4,
    }]
}

fn level(words: &Words, l: Option<Level>) -> &'static str {
    match l {
        Some(Level::High) => words.levels[0],
        Some(Level::Medium) => words.levels[1],
        Some(Level::Low) => words.levels[2],
        None => "",
    }
}

/// 「毎日 1 回」「週 3 回」, "3 a week".
pub fn frequency_text(f: inventory::Frequency, english: bool) -> String {
    let times = trim_number(f.times);
    if english {
        let per = match f.per {
            Period::Day => "day",
            Period::Week => "week",
            Period::Month => "month",
            Period::Quarter => "quarter",
            Period::Year => "year",
        };
        format!("{times} a {per}")
    } else {
        let per = match f.per {
            Period::Day => "毎日",
            Period::Week => "週",
            Period::Month => "月",
            Period::Quarter => "四半期に",
            Period::Year => "年",
        };
        format!("{per} {times} 回")
    }
}

fn trim_number(x: f64) -> String {
    let s = format!("{x:.1}");
    s.trim_end_matches('0').trim_end_matches('.').to_owned()
}

fn hours(minutes: f64) -> f64 {
    (minutes / 60.0 * 10.0).round() / 10.0
}

/// Writes the stock-take to `path` (.xlsx). `flow_names` gives a flow's name
/// by its ID, for the flows made for a task.
pub fn write(
    path: &Path,
    inventory: &WorkInventory,
    english: bool,
    flow_names: &dyn Fn(&str) -> Option<String>,
) -> Result<(), String> {
    let words = if english { &EN } else { &JA };
    let assessment = inventory::assess(inventory);
    let mut book = umya_spreadsheet::new_file();
    let sheet = book.sheet_mut(0).map_err(|e| e.to_string())?;
    sheet.set_name(words.sheet);

    sheet
        .cell_mut((1, 1))
        .set_value_string(inventory.title.as_str());
    sheet
        .cell_mut((1, 1))
        .style_mut()
        .font_mut()
        .set_bold(true)
        .set_size(14.0);
    if let Some(about) = &inventory.about {
        sheet
            .cell_mut((1, 2))
            .set_value_string(format!("{}：{about}", words.about));
    }
    let made = inventory.updated_at.date();
    sheet
        .cell_mut((1, 3))
        .set_value_string(format!("{}：{}", words.made, made));

    let head = 5;
    for (i, label) in words.headers.iter().enumerate() {
        let cell = sheet.cell_mut((i as u32 + 1, head));
        cell.set_value_string(*label);
        let style = cell.style_mut();
        style.font_mut().set_bold(true);
        style.alignment_mut().set_wrap_text(true);
    }
    let mut row = head;
    for scored in &assessment.tasks {
        let Some(task) = inventory.tasks.iter().find(|t| t.id == scored.task_id) else {
            continue;
        };
        row += 1;
        let text = |sheet: &mut umya_spreadsheet::Worksheet, col: u32, value: &str| {
            if !value.is_empty() {
                sheet.cell_mut((col, row)).set_value_string(value);
            }
        };
        let number = |sheet: &mut umya_spreadsheet::Worksheet, col: u32, value: Option<f64>| {
            if let Some(v) = value {
                sheet.cell_mut((col, row)).set_value_number(v);
            }
        };
        number(sheet, 1, scored.rank.map(f64::from));
        text(sheet, 2, &task.name);
        text(sheet, 3, group(words, scored.group));
        text(
            sheet,
            4,
            &task
                .frequency
                .map(|f| frequency_text(f, english))
                .unwrap_or_default(),
        );
        number(sheet, 5, task.minutes);
        number(sheet, 6, task.people.map(f64::from));
        number(sheet, 7, scored.monthly_minutes.map(hours));
        number(sheet, 8, task.manual_share.map(f64::from));
        number(sheet, 9, scored.savable_minutes.map(hours));
        text(sheet, 10, level(words, task.ease));
        text(sheet, 11, level(words, task.error_impact));
        text(sheet, 12, &task.ease_reasons.join("\n"));
        text(sheet, 13, &task.systems.join("\n"));
        text(sheet, 14, &task.step_types.join("\n"));
        text(sheet, 15, &task.plugins.join("\n"));
        text(sheet, 16, task.not_now.as_deref().unwrap_or_default());
        let flows: Vec<String> = task
            .flow_ids
            .iter()
            .map(|id| flow_names(id).unwrap_or_else(|| id.clone()))
            .collect();
        text(sheet, 17, &flows.join("\n"));
        let note = [task.description.as_deref(), task.note.as_deref()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("\n");
        text(sheet, 18, &note);
    }
    row += 1;
    sheet.cell_mut((2, row)).set_value_string(words.total);
    sheet
        .cell_mut((7, row))
        .set_value_number(hours(assessment.monthly_minutes));
    sheet
        .cell_mut((9, row))
        .set_value_number(hours(assessment.savable_minutes));
    for col in [2, 7, 9] {
        sheet
            .cell_mut((col, row))
            .style_mut()
            .font_mut()
            .set_bold(true);
    }
    for (col, width) in [
        (1, 6.0),
        (2, 36.0),
        (3, 16.0),
        (4, 14.0),
        (5, 10.0),
        (6, 8.0),
        (7, 12.0),
        (8, 12.0),
        (9, 14.0),
        (10, 10.0),
        (11, 10.0),
        (12, 36.0),
        (13, 24.0),
        (14, 24.0),
        (15, 18.0),
        (16, 24.0),
        (17, 24.0),
        (18, 40.0),
    ] {
        sheet.column_dimension_by_number_mut(col).set_width(width);
    }
    umya_spreadsheet::writer::xlsx::write(&book, path).map_err(|e| e.to_string())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use spellsheet_core::inventory::{InventoryPatch, TaskPatch};

    #[test]
    fn writes_the_tasks_in_order() {
        let mut inv = WorkInventory::new("経理課", None);
        let tasks: Vec<TaskPatch> = serde_json::from_value(serde_json::json!([
            { "name": "週報", "frequency": { "times": 1, "per": "week" }, "minutes": 20, "manualShare": 50, "ease": "high" },
            { "name": "受注入力", "frequency": { "times": 1, "per": "day" }, "minutes": 30, "manualShare": 80, "ease": "high", "flowIds": ["scn_1"] }
        ]))
        .unwrap();
        inv.apply(&InventoryPatch {
            tasks,
            ..Default::default()
        })
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.xlsx");
        write(&path, &inv, false, &|id| {
            (id == "scn_1").then(|| "受注を入力する".to_owned())
        })
        .unwrap();
        let book = umya_spreadsheet::reader::xlsx::read(&path).unwrap();
        let sheet = book.sheet(0).unwrap();
        assert_eq!(sheet.name(), "自動化の候補");
        assert_eq!(sheet.value((2, 6)), "受注入力");
        assert_eq!(sheet.value((3, 6)), "最初に作る");
        assert_eq!(sheet.value((4, 6)), "毎日 1 回");
        assert_eq!(sheet.value((9, 6)), "8");
        assert_eq!(sheet.value((17, 6)), "受注を入力する");
        assert_eq!(sheet.value((2, 7)), "週報");
        assert_eq!(sheet.value((2, 8)), "合計");
        assert_eq!(
            frequency_text(
                inventory::Frequency {
                    times: 2.5,
                    per: Period::Week
                },
                true
            ),
            "2.5 a week"
        );
    }
}

use serde_json::{Value, json};
use shikigami_core::resource::resource_keys;
use shikigami_core::{Scenario, Step, Validator, VarDirection, VarType, VariableDef};
use shikigami_runtime::{RunOptions, RunReport, RunStatus, Runtime};

use super::*;

fn runtime() -> Runtime {
    Runtime::builder().adapter(&ExcelAdapter::new()).build()
}

fn step(step_type: &str, params: Value) -> Step {
    let mut step = Step::new(step_type);
    for (key, value) in params.as_object().unwrap() {
        step = step.with_param(key, value.clone());
    }
    step
}

fn saving(mut step: Step, name: &str) -> Step {
    step.save_as = Some(name.into());
    step
}

async fn run(steps: Vec<Step>) -> RunReport {
    let mut s = Scenario::new("excel");
    for name in ["out", "rows", "cell"] {
        s.variables.push(VariableDef {
            direction: VarDirection::Output,
            ..VariableDef::new(name, VarType::Any)
        });
    }
    s.steps = steps;
    for step in &mut s.steps {
        shikigami_core::ops::assign_missing_ids(step);
    }
    let handle = runtime().start(s, RunOptions::default()).expect("start");
    handle.wait().await.expect("report")
}

fn workbook(dir: &tempfile::TempDir, name: &str) -> String {
    dir.path().join(name).to_string_lossy().into_owned()
}

#[test]
fn examples_validate_and_every_step_locks_its_workbook() {
    let runtime = runtime();
    let validator = Validator::new(runtime.registry().clone());
    let defs = definitions();
    assert_eq!(defs.len(), 8);
    for def in &defs {
        assert!(def.step_type.starts_with("excel."));
        assert!(!def.examples.is_empty(), "{}", def.step_type);
        assert_eq!(
            resource_keys(&def.resources, &json!({ "path": "C:\\Work\\受注.xlsx" })),
            ["file:c:\\work\\受注.xlsx"],
        );
        for example in &def.examples {
            let mut step: Step = serde_json::from_value(example.clone()).unwrap();
            shikigami_core::ops::assign_missing_ids(&mut step);
            let mut s = Scenario::new("example");
            s.variables = [
                "orders",
                "order",
                "processedAt",
                "closingDate",
                "prices",
                "sheets",
                "results",
                "month",
            ]
            .iter()
            .map(|n| VariableDef::new(*n, VarType::Any))
            .collect();
            s.steps = vec![step];
            let report = validator.validate(&s);
            assert_eq!(
                report.error_count(),
                0,
                "{}: {:?}",
                def.step_type,
                report.issues
            );
        }
    }
}

#[tokio::test]
async fn a_table_is_written_read_by_rows_and_updated_in_place() {
    let dir = tempfile::tempdir().unwrap();
    let path = workbook(&dir, "受注.xlsx");
    let report = run(vec![
        step(types::APPEND_ROWS, json!({ "path": path, "sheet": "受注", "rows": [
            { "受注番号": "A-1", "金額": 1200, "受注日": { "date": "2026-10-28" } },
            { "受注番号": "A-2", "金額": 980.5, "受注日": { "date": "2026-10-29" } },
        ] })),
        step(types::APPEND_ROWS, json!({ "path": path, "sheet": "受注", "rows": [
            { "金額": 10, "受注番号": "007" },
        ] })),
        saving(step(types::READ_ROWS, json!({ "path": path, "sheet": "受注" })), "rows"),
        step("control.forEach", json!({ "items": "rows", "itemVar": "row" })).with_block(
            "body",
            vec![step(types::WRITE_CELL, json!({ "path": path, "sheet": "受注", "cell": "D{{ row._row }}", "value": "完了" }))],
        ),
        saving(step(types::READ_RANGE, json!({ "path": path, "sheet": "受注" })), "out"),
    ])
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(
        report.outputs["rows"],
        json!([
            { "受注番号": "A-1", "金額": 1200, "受注日": "2026-10-28", "_row": 2 },
            { "受注番号": "A-2", "金額": 980.5, "受注日": "2026-10-29", "_row": 3 },
            { "受注番号": "007", "金額": 10, "受注日": null, "_row": 4 },
        ])
    );
    assert_eq!(
        report.outputs["out"],
        json!([
            ["受注番号", "金額", "受注日", null],
            ["A-1", 1200, "2026-10-28", "完了"],
            ["A-2", 980.5, "2026-10-29", "完了"],
            ["007", 10, null, "完了"],
        ])
    );
}

#[tokio::test]
async fn cells_ranges_formulas_and_sheets() {
    let dir = tempfile::tempdir().unwrap();
    let path = workbook(&dir, "集計.xlsx");
    let report = run(vec![
        step(types::WRITE_RANGE, json!({ "path": path, "cell": "B2", "values": [[1, 2], [3, true]] })),
        step(types::WRITE_CELL, json!({ "path": path, "cell": "B4", "value": { "formula": "=SUM(B2:C3)" } })),
        step(types::WRITE_CELL, json!({ "path": path, "cell": "C2", "value": null })),
        step(types::WRITE_CELL, json!({ "path": path, "cell": "E1", "value": "=1+1" })),
        step(types::ADD_SHEET, json!({ "path": path, "sheet": "明細" })),
        step(types::ADD_SHEET, json!({ "path": path, "sheet": "明細" })),
        step(types::WRITE_CELL, json!({ "path": path, "sheet": "明細", "cell": "A1", "value": { "date": "2026-10-28T09:30:00" } })),
        saving(step(types::READ_CELL, json!({ "path": path, "sheet": "明細", "cell": "A1" })), "cell"),
        saving(step(types::LIST_SHEETS, json!({ "path": path })), "rows"),
        saving(step(types::READ_RANGE, json!({ "path": path, "range": "B2:E3" })), "out"),
    ])
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["cell"], json!("2026-10-28T09:30:00"));
    assert_eq!(report.outputs["rows"], json!(["Sheet1", "明細"]));
    // Text that looks like a formula stays text.
    assert_eq!(
        report.outputs["out"],
        json!([[1, null, null, null], [3, true, null, null]])
    );
    let book = book::open(&path).unwrap();
    let sheet = book.sheet(0).unwrap();
    assert_eq!(sheet.cell("B4").unwrap().formula(), "SUM(B2:C3)");
    assert_eq!(sheet.cell("E1").unwrap().value(), "=1+1");
    assert!(!sheet.cell("E1").unwrap().is_formula());
}

async fn error_of(steps: Vec<Step>) -> shikigami_runtime::RunError {
    let report = run(steps).await;
    assert_eq!(report.status, RunStatus::Failed);
    report.error.unwrap()
}

#[tokio::test]
async fn mistakes_come_back_with_what_to_do() {
    let dir = tempfile::tempdir().unwrap();
    let path = workbook(&dir, "a.xlsx");
    let missing = error_of(vec![step(types::READ_ROWS, json!({ "path": path }))]).await;
    assert_eq!(missing.code, "FILE_NOT_FOUND");

    let error = error_of(vec![
        step(types::ADD_SHEET, json!({ "path": path, "sheet": "受注" })),
        step(
            types::READ_CELL,
            json!({ "path": path, "sheet": "受付", "cell": "A1" }),
        ),
    ])
    .await;
    assert_eq!(error.code, "SHEET_NOT_FOUND");
    assert_eq!(error.details.unwrap()["sheets"], json!(["受注"]));

    let error = error_of(vec![
        step(
            types::WRITE_RANGE,
            json!({ "path": path, "cell": "A1", "values": [["品番", "数量"]] }),
        ),
        step(
            types::APPEND_ROWS,
            json!({ "path": path, "rows": [{ "品番": "X", "個数": 1 }] }),
        ),
    ])
    .await;
    assert_eq!(error.code, "UNKNOWN_COLUMN");
    assert_eq!(error.details.unwrap()["columns"], json!(["品番", "数量"]));

    let error = error_of(vec![step(
        types::READ_CELL,
        json!({ "path": path, "cell": "1A" }),
    )])
    .await;
    assert_eq!(error.code, "INVALID_CELL");

    let error = error_of(vec![step(
        types::READ_CELL,
        json!({ "path": workbook(&dir, "old.xls"), "cell": "A1" }),
    )])
    .await;
    assert_eq!(error.code, "UNSUPPORTED_FORMAT");

    // Excel keeps ~$a.xlsx next to a workbook it has open.
    std::fs::write(dir.path().join("~$a.xlsx"), b"").unwrap();
    let error = error_of(vec![step(
        types::WRITE_CELL,
        json!({ "path": path, "cell": "A1", "value": 1 }),
    )])
    .await;
    assert_eq!(error.code, "FILE_IN_USE");
    // Reading still works, and the failed write left the file as it was.
    let report = run(vec![saving(
        step(types::READ_CELL, json!({ "path": path, "cell": "A1" })),
        "out",
    )])
    .await;
    assert_eq!(report.outputs["out"], json!("品番"));
    let leftovers: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty());
}

#[tokio::test]
async fn inspect_shows_sheets_and_their_first_rows() {
    let dir = tempfile::tempdir().unwrap();
    let path = workbook(&dir, "b.xlsx");
    let report = run(vec![step(
        types::WRITE_RANGE,
        json!({ "path": path, "cell": "A1", "values": [["品番", "数量"], ["X", 1]] }),
    )])
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    let seen = ExcelAdapter::new()
        .inspect("s", json!({ "path": path }))
        .await
        .unwrap();
    assert_eq!(
        seen["sheets"],
        json!([{ "name": "Sheet1", "usedRange": "A1:B2", "firstRows": [["品番", "数量"], ["X", 1]] }])
    );
}

#[tokio::test]
async fn appended_rows_go_below_formulas_not_yet_calculated() {
    let dir = tempfile::tempdir().unwrap();
    let path = workbook(&dir, "c.xlsx");
    let report = run(vec![
        step(
            types::WRITE_RANGE,
            json!({ "path": path, "cell": "A1", "values": [["品番", "数量"], ["X", 1]] }),
        ),
        step(
            types::WRITE_CELL,
            json!({ "path": path, "cell": "B3", "value": { "formula": "SUM(B2)" } }),
        ),
        saving(
            step(
                types::APPEND_ROWS,
                json!({ "path": path, "rows": [{ "品番": "Y", "数量": 2 }] }),
            ),
            "out",
        ),
    ])
    .await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["out"], json!({ "firstRow": 4, "count": 1 }));
}

#[test]
fn a_stopped_step_does_not_save() {
    let dir = tempfile::tempdir().unwrap();
    let path = workbook(&dir, "d.xlsx");
    let cancel = CancellationToken::new();
    cancel.cancel();
    let error = run_step(
        Kind::WriteCell,
        &json!({ "path": path, "cell": "A1", "value": 1 }),
        &cancel,
    )
    .unwrap_err();
    assert_eq!(error.code, "CANCELLED");
    assert!(!std::path::Path::new(&path).exists());
}

use std::fs;

use serde_json::{Value, json};
use shikigami_core::{Scenario, Step, Validator, VarDirection, VarType, VariableDef};
use shikigami_runtime::{RunOptions, RunStatus, Runtime};

use super::*;

fn run(kind: Kind, params: Value) -> Result<Value, StepError> {
    run_step(kind, &params, &CancellationToken::new())
}

fn p(dir: &tempfile::TempDir, name: &str) -> String {
    dir.path().join(name).display().to_string()
}

#[test]
fn examples_validate() {
    let runtime = Runtime::builder().adapter(&FileAdapter::new()).build();
    let validator = Validator::new(runtime.registry().clone());
    let defs = definitions();
    assert_eq!(defs.len(), 12);
    for def in &defs {
        assert!(def.step_type.starts_with("file."));
        assert!(!def.examples.is_empty(), "{}", def.step_type);
        for example in &def.examples {
            let mut step: Step = serde_json::from_value(example.clone()).unwrap();
            shikigami_core::ops::assign_missing_ids(&mut step);
            let mut s = Scenario::new("example");
            s.variables = [
                "total", "results", "file", "name", "memo", "orders", "done", "csvFiles", "files",
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

#[test]
fn text_round_trips_in_each_encoding() {
    let dir = tempfile::tempdir().unwrap();
    let path = p(&dir, "sub/a.txt");
    for encoding in ["utf-8", "utf-8-bom", "shift_jis"] {
        run(
            Kind::WriteText,
            json!({ "path": path, "text": "請求書\r\n", "encoding": encoding }),
        )
        .unwrap();
        run(
            Kind::WriteText,
            json!({ "path": path, "text": "2行目", "encoding": encoding, "append": true }),
        )
        .unwrap();
        assert_eq!(
            run(Kind::ReadText, json!({ "path": path })).unwrap(),
            json!("請求書\r\n2行目")
        );
    }
    let bytes = fs::read(&path).unwrap();
    assert!(
        std::str::from_utf8(&bytes).is_err(),
        "last write is Shift_JIS"
    );
    let err = run(Kind::ReadText, json!({ "path": p(&dir, "missing.txt") })).unwrap_err();
    assert_eq!(err.code, "FILE_NOT_FOUND");
    assert!(!err.retryable);
}

#[test]
fn csv_reads_records_and_writes_them_back() {
    let dir = tempfile::tempdir().unwrap();
    let path = p(&dir, "in.csv");
    let sjis = encoding::encode(
        "注文番号,金額,,金額\r\nA-1,\"1,200\",x,1\r\nA-2,300\r\n",
        "shift_jis",
        true,
    )
    .unwrap();
    fs::write(&path, sjis).unwrap();
    let rows = run(Kind::ReadCsv, json!({ "path": path })).unwrap();
    assert_eq!(
        rows,
        json!([
            { "注文番号": "A-1", "金額": "1,200", "列3": "x", "金額_2": "1" },
            { "注文番号": "A-2", "金額": "300", "列3": "", "金額_2": "" },
        ])
    );
    let raw = run(Kind::ReadCsv, json!({ "path": path, "header": false })).unwrap();
    assert_eq!(raw[2], json!(["A-2", "300"]));

    let out = p(&dir, "out.csv");
    let written = run(
        Kind::WriteCsv,
        json!({ "path": out, "rows": [{ "b": 1, "a": "x,y" }, { "a": null, "c": true }], "encoding": "utf-8-bom" }),
    )
    .unwrap();
    assert_eq!(written, json!(2));
    let bytes = fs::read(&out).unwrap();
    assert!(bytes.starts_with(b"\xEF\xBB\xBF"));
    assert_eq!(&bytes[3..], "b,a,c\r\n1,\"x,y\",\r\n,,true\r\n".as_bytes());
    // Appending follows the file's header order and adds no BOM or header.
    run(Kind::WriteCsv, json!({ "path": out, "rows": [{ "c": 3, "a": "z" }], "append": true, "encoding": "utf-8-bom" })).unwrap();
    let text = run(Kind::ReadText, json!({ "path": out })).unwrap();
    assert_eq!(text, json!("b,a,c\r\n1,\"x,y\",\r\n,,true\r\n,z,3\r\n"));
    let tsv = p(&dir, "t.tsv");
    run(
        Kind::WriteCsv,
        json!({ "path": tsv, "rows": [["1", "2"]], "delimiter": "\t" }),
    )
    .unwrap();
    assert_eq!(
        run(
            Kind::ReadCsv,
            json!({ "path": tsv, "delimiter": "\t", "header": false })
        )
        .unwrap(),
        json!([["1", "2"]])
    );
    let err = run(
        Kind::WriteText,
        json!({ "path": out, "text": "🍣", "encoding": "shift_jis" }),
    )
    .unwrap_err();
    assert_eq!(err.code, "UNENCODABLE_TEXT");
}

#[test]
fn files_and_folders() {
    let dir = tempfile::tempdir().unwrap();
    let a = p(&dir, "in/a.csv");
    run(Kind::WriteText, json!({ "path": a, "text": "1" })).unwrap();
    run(
        Kind::WriteText,
        json!({ "path": p(&dir, "in/b.TXT"), "text": "2" }),
    )
    .unwrap();
    run(
        Kind::WriteText,
        json!({ "path": p(&dir, "in/sub/c.csv"), "text": "3" }),
    )
    .unwrap();
    assert_eq!(
        run(Kind::Exists, json!({ "path": a })).unwrap(),
        json!(true)
    );

    let names = |v: Value| -> Vec<String> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap().to_owned())
            .collect()
    };
    let folder = p(&dir, "in");
    assert_eq!(
        names(run(Kind::List, json!({ "folder": folder })).unwrap()),
        ["a.csv", "b.TXT"]
    );
    assert_eq!(
        names(run(Kind::List, json!({ "folder": folder, "pattern": "*.txt" })).unwrap()),
        ["b.TXT"]
    );
    assert_eq!(
        names(
            run(
                Kind::List,
                json!({ "folder": folder, "pattern": "*.csv", "recursive": true })
            )
            .unwrap()
        ),
        ["a.csv", "c.csv"]
    );
    let listed = run(Kind::List, json!({ "folder": folder, "type": "folder" })).unwrap();
    assert_eq!(listed[0]["name"], "sub");
    assert_eq!(listed[0]["isFolder"], true);
    let first = &run(Kind::List, json!({ "folder": folder })).unwrap()[0];
    assert_eq!(first["size"], 1);
    assert!(first["modified"].as_str().unwrap().contains('T'));

    let copy = p(&dir, "out/a.csv");
    run(Kind::Copy, json!({ "from": a, "to": copy })).unwrap();
    assert_eq!(
        run(Kind::Copy, json!({ "from": a, "to": copy }))
            .unwrap_err()
            .code,
        "FILE_EXISTS"
    );
    run(
        Kind::Copy,
        json!({ "from": a, "to": copy, "overwrite": true }),
    )
    .unwrap();
    run(Kind::Copy, json!({ "from": folder, "to": p(&dir, "copy") })).unwrap();
    assert!(dir.path().join("copy/sub/c.csv").exists());

    let moved = p(&dir, "out/renamed.csv");
    run(Kind::Move, json!({ "from": copy, "to": moved })).unwrap();
    assert!(!dir.path().join("out/a.csv").exists());
    assert!(dir.path().join("out/renamed.csv").exists());

    assert_eq!(
        run(Kind::Delete, json!({ "path": p(&dir, "copy") }))
            .unwrap_err()
            .code,
        "FOLDER_NOT_EMPTY"
    );
    assert_eq!(
        run(
            Kind::Delete,
            json!({ "path": p(&dir, "copy"), "recursive": true })
        )
        .unwrap(),
        json!(true)
    );
    assert_eq!(
        run(Kind::Delete, json!({ "path": p(&dir, "copy") })).unwrap(),
        json!(false)
    );
    run(Kind::CreateFolder, json!({ "path": p(&dir, "x/y") })).unwrap();
    run(Kind::CreateFolder, json!({ "path": p(&dir, "x/y") })).unwrap();
    assert!(dir.path().join("x/y").is_dir());
}

#[test]
fn zip_round_trip_and_shift_jis_names() {
    let dir = tempfile::tempdir().unwrap();
    run(
        Kind::WriteText,
        json!({ "path": p(&dir, "src/請求書.txt"), "text": "a" }),
    )
    .unwrap();
    run(
        Kind::WriteText,
        json!({ "path": p(&dir, "src/sub/b.txt"), "text": "b" }),
    )
    .unwrap();
    let zip_path = p(&dir, "out.zip");
    run(Kind::Zip, json!({ "from": p(&dir, "src"), "to": zip_path })).unwrap();
    assert_eq!(
        run(Kind::Zip, json!({ "from": p(&dir, "src"), "to": zip_path }))
            .unwrap_err()
            .code,
        "FILE_EXISTS"
    );
    let files = run(Kind::Unzip, json!({ "path": zip_path, "to": p(&dir, "x") })).unwrap();
    assert_eq!(files.as_array().unwrap().len(), 2);
    assert_eq!(
        fs::read_to_string(dir.path().join("x/src/請求書.txt")).unwrap(),
        "a"
    );
    assert_eq!(
        run(Kind::Unzip, json!({ "path": zip_path, "to": p(&dir, "x") }))
            .unwrap_err()
            .code,
        "FILE_EXISTS"
    );

    // Windows Explorer stores Japanese names in Shift_JIS without the UTF-8 flag.
    let sjis = encoding::encode("見積.txt", "shift_jis", false).unwrap();
    assert_eq!(ops::entry_name(&sjis), "見積.txt");
    assert_eq!(ops::entry_name("見積.txt".as_bytes()), "見積.txt");

    // Entries that climb out of the destination are refused.
    let evil = dir.path().join("evil.zip");
    {
        let mut w = zip::ZipWriter::new(fs::File::create(&evil).unwrap());
        w.start_file("../escape.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        w.finish().unwrap();
    }
    let err = run(
        Kind::Unzip,
        json!({ "path": evil.display().to_string(), "to": p(&dir, "e") }),
    )
    .unwrap_err();
    assert_eq!(err.code, "ZIP_INVALID");
    assert!(!dir.path().join("escape.txt").exists());
}

#[tokio::test]
async fn a_scenario_filters_a_csv_with_expressions() {
    let dir = tempfile::tempdir().unwrap();
    let input = p(&dir, "orders.csv");
    let output = p(&dir, "big.csv");
    fs::write(&input, "番号,金額\nA,\"1,200\"\nB,300\nC,5000\n").unwrap();
    let runtime = Runtime::builder().adapter(&FileAdapter::new()).build();
    let mut s = Scenario::new("csv");
    s.variables.push(VariableDef {
        direction: VarDirection::Output,
        ..VariableDef::new("count", VarType::Any)
    });
    let mut read = Step::new(types::READ_CSV).with_param("path", input);
    read.save_as = Some("orders".into());
    let filter = Step::new("variable.set")
        .with_param("name", "big")
        .with_param("expression", "map(filter(orders, r => num(r.金額) >= 1000), r => { 番号: r.番号, 税込: round(num(r.金額) * 1.1) })");
    let mut write = Step::new(types::WRITE_CSV)
        .with_param("path", output.clone())
        .with_param("rows", "{{ big }}");
    write.save_as = Some("count".into());
    s.steps = vec![read, filter, write];
    for step in &mut s.steps {
        shikigami_core::ops::assign_missing_ids(step);
    }
    let report = runtime
        .start(s, RunOptions::default())
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["count"], json!(2));
    assert_eq!(
        fs::read_to_string(&output).unwrap(),
        "番号,税込\r\nA,1320\r\nC,5500\r\n"
    );
}

#[test]
fn copy_and_move_never_destroy_the_source() {
    let dir = tempfile::tempdir().unwrap();
    let a = p(&dir, "a.csv");
    run(Kind::WriteText, json!({ "path": a, "text": "keep" })).unwrap();
    for kind in [Kind::Copy, Kind::Move] {
        let err = run(kind, json!({ "from": a, "to": a, "overwrite": true })).unwrap_err();
        assert_eq!(err.code, "SAME_PATH");
        let alias = dir.path().join(".").join("a.csv").display().to_string();
        let err = run(kind, json!({ "from": a, "to": alias, "overwrite": true })).unwrap_err();
        assert_eq!(err.code, "SAME_PATH");
    }
    assert_eq!(fs::read_to_string(&a).unwrap(), "keep");
    let folder = p(&dir, "f");
    run(
        Kind::WriteText,
        json!({ "path": p(&dir, "f/x.txt"), "text": "x" }),
    )
    .unwrap();
    let err = run(
        Kind::Copy,
        json!({ "from": folder, "to": p(&dir, "f/sub/copy") }),
    )
    .unwrap_err();
    assert_eq!(err.code, "SAME_PATH");
    assert!(!dir.path().join("f/sub").exists());
}

#[test]
fn a_cancelled_attempt_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let path = p(&dir, "a.txt");
    let cancel = CancellationToken::new();
    cancel.cancel();
    let err = run_step(
        Kind::WriteText,
        &json!({ "path": path, "text": "x" }),
        &cancel,
    )
    .unwrap_err();
    assert_eq!(err.code, "CANCELLED");
    assert!(!dir.path().join("a.txt").exists());
}

#[test]
fn appending_csv_follows_the_file_header_over_columns() {
    let dir = tempfile::tempdir().unwrap();
    let out = p(&dir, "a.csv");
    run(
        Kind::WriteCsv,
        json!({ "path": out, "rows": [{ "a": 1, "b": 2 }] }),
    )
    .unwrap();
    run(
        Kind::WriteCsv,
        json!({ "path": out, "rows": [{ "a": 3, "b": 4 }], "columns": ["b", "a"], "append": true }),
    )
    .unwrap();
    assert_eq!(
        run(Kind::ReadCsv, json!({ "path": out })).unwrap(),
        json!([{ "a": "1", "b": "2" }, { "a": "3", "b": "4" }])
    );
}

#[test]
fn zipping_a_folder_into_itself_skips_the_archive() {
    let dir = tempfile::tempdir().unwrap();
    run(
        Kind::WriteText,
        json!({ "path": p(&dir, "src/a.txt"), "text": "a" }),
    )
    .unwrap();
    let to = p(&dir, "src/out.zip");
    run(Kind::Zip, json!({ "from": p(&dir, "src"), "to": to })).unwrap();
    run(
        Kind::Zip,
        json!({ "from": p(&dir, "src"), "to": to, "overwrite": true }),
    )
    .unwrap();
    let mut archive = zip::ZipArchive::new(fs::File::open(&to).unwrap()).unwrap();
    let names: Vec<String> = (0..archive.len())
        .map(|i| archive.by_index(i).unwrap().name().unwrap().into_owned())
        .collect();
    assert_eq!(names, ["src/", "src/a.txt"]);
}

#[cfg(unix)]
#[test]
fn unzip_refuses_to_follow_links_out_of_the_destination() {
    let dir = tempfile::tempdir().unwrap();
    let outside = dir.path().join("outside");
    fs::create_dir_all(&outside).unwrap();
    let dest = dir.path().join("dest");
    fs::create_dir_all(&dest).unwrap();
    std::os::unix::fs::symlink(&outside, dest.join("link")).unwrap();
    let zip_path = dir.path().join("evil.zip");
    {
        let mut w = zip::ZipWriter::new(fs::File::create(&zip_path).unwrap());
        w.start_file("link/new.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        std::io::Write::write_all(&mut w, b"x").unwrap();
        w.finish().unwrap();
    }
    let err = run(
        Kind::Unzip,
        json!({ "path": zip_path.display().to_string(), "to": dest.display().to_string() }),
    )
    .unwrap_err();
    assert_eq!(err.code, "ZIP_INVALID");
    assert!(!outside.join("new.txt").exists());
}

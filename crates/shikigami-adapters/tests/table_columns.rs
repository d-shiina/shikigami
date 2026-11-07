use serde_json::json;
use shikigami_adapters::table_columns;

#[test]
fn reads_the_header_of_a_csv_in_the_flow_folder() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("input")).unwrap();
    std::fs::write(
        dir.path().join("input/受注.csv"),
        "受注番号,顧客,,顧客\n1,A,,B\n",
    )
    .unwrap();
    let params = json!({ "path": "input/受注.csv" });
    let columns = table_columns("file.readCsv", &params, dir.path()).unwrap();
    assert_eq!(columns[0], "受注番号");
    assert_eq!(columns[1], "顧客");
    assert_eq!(columns.len(), 4);
    assert_eq!(
        table_columns(
            "file.readCsv",
            &json!({ "path": "input/受注.csv", "header": false }),
            dir.path()
        ),
        Some(vec![])
    );
}

#[test]
fn offers_nothing_it_cannot_read_yet() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        table_columns(
            "file.readCsv",
            &json!({ "path": "input/none.csv" }),
            dir.path()
        ),
        None
    );
    assert_eq!(
        table_columns("file.readCsv", &json!({ "path": "{{ file }}" }), dir.path()),
        None
    );
    assert_eq!(
        table_columns("file.readText", &json!({ "path": "a.txt" }), dir.path()),
        None
    );
}

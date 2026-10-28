use pdf_extract::{Dictionary, Object, Stream, dictionary};
use serde_json::{Value, json};
use shikigami_core::{Scenario, Step, VarDirection, VarType, VariableDef};
use shikigami_runtime::{RunOptions, RunReport, RunStatus, Runtime};

use super::*;

fn runtime() -> Runtime {
    Runtime::builder().adapter(&PdfAdapter::new()).build()
}

async fn read(params: Value) -> RunReport {
    let mut s = Scenario::new("pdf");
    s.variables.push(VariableDef {
        direction: VarDirection::Output,
        ..VariableDef::new("out", VarType::Any)
    });
    let mut step = Step::new(types::READ_TEXT);
    for (k, v) in params.as_object().unwrap() {
        step = step.with_param(k, v.clone());
    }
    step.save_as = Some("out".into());
    shikigami_core::ops::assign_missing_ids(&mut step);
    s.steps = vec![step];
    runtime()
        .start(s, RunOptions::default())
        .unwrap()
        .wait()
        .await
        .unwrap()
}

/// A PDF whose pages show `contents` in a CID font: each text is written as
/// two-byte glyph ids mapped to Unicode by a ToUnicode CMap, as Word and
/// other Japanese producers do.
fn pdf(contents: &[&str]) -> Vec<u8> {
    save(document(contents))
}

fn save(mut doc: pdf_extract::Document) -> Vec<u8> {
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).unwrap();
    bytes
}

fn document(contents: &[&str]) -> pdf_extract::Document {
    let mut chars: Vec<char> = contents.iter().flat_map(|c| c.chars()).collect();
    chars.sort_unstable();
    chars.dedup();
    let gid = |c: char| chars.iter().position(|x| *x == c).unwrap() + 1;
    let cmap = format!(
        "/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n\
         /CMapName /Test def 1 begincodespacerange <0000> <FFFF> endcodespacerange\n\
         {} beginbfchar\n{}endbfchar\nendcmap CMapName currentdict /CMap defineresource pop end end",
        chars.len(),
        chars
            .iter()
            .map(|c| {
                let mut units = [0u16; 2];
                let hex: String = c
                    .encode_utf16(&mut units)
                    .iter()
                    .map(|u| format!("{u:04X}"))
                    .collect();
                format!("<{:04X}> <{hex}>\n", gid(*c))
            })
            .collect::<String>()
    );

    let mut doc = pdf_extract::Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let to_unicode = doc.add_object(Stream::new(Dictionary::new(), cmap.into_bytes()));
    let descriptor = doc.add_object(dictionary! {
        "Type" => "FontDescriptor",
        "FontName" => "TestGothic",
        "Flags" => 4,
        "FontBBox" => vec![0.into(), (-120).into(), 1000.into(), 880.into()],
        "ItalicAngle" => 0,
        "Ascent" => 880,
        "Descent" => -120,
        "CapHeight" => 700,
        "StemV" => 80,
    });
    let descendant = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "CIDFontType2",
        "BaseFont" => "TestGothic",
        "CIDSystemInfo" => dictionary! {
            "Registry" => Object::string_literal("Adobe"),
            "Ordering" => Object::string_literal("Identity"),
            "Supplement" => 0,
        },
        "FontDescriptor" => descriptor,
        "DW" => 1000,
    });
    let font = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type0",
        "BaseFont" => "TestGothic",
        "Encoding" => "Identity-H",
        "DescendantFonts" => vec![descendant.into()],
        "ToUnicode" => to_unicode,
    });
    let resources = doc.add_object(dictionary! {
        "Font" => dictionary! { "F1" => font },
    });
    let mut kids = Vec::new();
    for text in contents {
        let mut y = 750;
        let mut ops = String::new();
        for line in text.lines() {
            let hex: String = line.chars().map(|c| format!("{:04X}", gid(c))).collect();
            ops += &format!("BT /F1 12 Tf 50 {y} Td <{hex}> Tj ET\n");
            y -= 20;
        }
        let content = doc.add_object(Stream::new(Dictionary::new(), ops.into_bytes()));
        kids.push(Object::from(doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => content,
            "Resources" => resources,
            "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
        })));
    }
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Count" => i64::try_from(kids.len()).unwrap(),
            "Kids" => kids,
        }),
    );
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog);
    doc
}

#[tokio::test]
async fn reads_japanese_text_page_by_page() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("請求書.pdf");
    std::fs::write(
        &path,
        pdf(&["請求書\n請求金額 12,800円", "お支払期限 2026年11月30日"]),
    )
    .unwrap();
    let report = read(json!({ "path": path.display().to_string() })).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    let out = &report.outputs["out"];
    let pages = out["pages"].as_array().unwrap();
    assert_eq!(pages.len(), 2);
    let first = pages[0].as_str().unwrap();
    assert!(first.contains("請求書"), "{first:?}");
    assert!(first.contains("請求金額 12,800円"), "{first:?}");
    assert!(
        pages[1]
            .as_str()
            .unwrap()
            .contains("お支払期限 2026年11月30日")
    );
    let text = out["text"].as_str().unwrap();
    assert!(text.find("請求書").unwrap() < text.find("お支払期限").unwrap());
}

#[tokio::test]
async fn missing_and_broken_files_fail_clearly() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("none.pdf");
    let report = read(json!({ "path": missing.display().to_string() })).await;
    assert_eq!(report.error.unwrap().code, "FILE_NOT_FOUND");

    let broken = dir.path().join("broken.pdf");
    std::fs::write(&broken, b"not a pdf at all").unwrap();
    let report = read(json!({ "path": broken.display().to_string() })).await;
    assert_eq!(report.error.unwrap().code, "PDF_UNREADABLE");
}

/// `contents` as a PDF encrypted with these passwords.
fn encrypted(contents: &[&str], user_password: &str) -> Vec<u8> {
    let mut doc = document(contents);
    // An encrypted file keeps a plain cross-reference table and an ID, as
    // producers write it (lopdf would otherwise encrypt its xref stream).
    doc.reference_table.cross_reference_type = pdf_extract::xref::XrefType::CrossReferenceTable;
    let id = Object::string_literal("0123456789abcdef");
    doc.trailer.set("ID", vec![id.clone(), id]);
    let state = pdf_extract::EncryptionState::try_from(pdf_extract::EncryptionVersion::V2 {
        document: &doc,
        owner_password: "owner",
        user_password,
        key_length: 128,
        permissions: pdf_extract::Permissions::all(),
    })
    .unwrap();
    doc.encrypt(&state).unwrap();
    save(doc)
}

#[tokio::test]
async fn opens_a_protected_pdf_with_its_password() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("secret.pdf");
    std::fs::write(&path, encrypted(&["社外秘"], "himitsu")).unwrap();
    let path = path.display().to_string();

    let report = read(json!({ "path": path })).await;
    assert_eq!(report.error.unwrap().code, "PDF_PASSWORD_REQUIRED");
    let report = read(json!({ "path": path, "password": "wrong" })).await;
    assert_eq!(report.error.unwrap().code, "PDF_WRONG_PASSWORD");
    let report = read(json!({ "path": path, "password": "himitsu" })).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    let text = report.outputs["out"]["text"].as_str().unwrap();
    assert!(text.contains("社外秘"), "{text:?}");
}

#[tokio::test]
async fn reads_a_pdf_that_only_restricts_printing() {
    // Only an owner password: opens without one, like in a PDF viewer.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("restricted.pdf");
    std::fs::write(&path, encrypted(&["印刷禁止"], "")).unwrap();
    let report = read(json!({ "path": path.display().to_string() })).await;
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    let text = report.outputs["out"]["text"].as_str().unwrap();
    assert!(text.contains("印刷禁止"), "{text:?}");
}

#[test]
fn examples_validate() {
    let runtime = runtime();
    let validator = shikigami_core::Validator::new(runtime.registry().clone());
    for example in &read_text_def().examples {
        let mut step: Step = serde_json::from_value(example.clone()).unwrap();
        shikigami_core::ops::assign_missing_ids(&mut step);
        let mut s = Scenario::new("example");
        s.variables = ["invoice", "pdfPath"]
            .iter()
            .map(|n| VariableDef::new(*n, VarType::Any))
            .collect();
        s.steps = vec![step];
        let report = validator.validate(&s);
        assert_eq!(report.error_count(), 0, "{example}: {:?}", report.issues);
    }
}

#[tokio::test]
async fn the_documented_amount_expression_works() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("請求書.pdf");
    std::fs::write(&path, pdf(&["請求書\n請求金額 12,800円"])).unwrap();
    // The two steps of docs/pdf.md.
    let steps = format!(
        r#"[
            {{ "type": "pdf.readText", "params": {{ "path": {} }}, "saveAs": "invoice" }},
            {{ "type": "variable.set", "params": {{ "name": "amount", "value": "{{{{ num(regexFind(invoice.text, '請求金額\\\\s*([\\\\d,]+)', 1)) }}}}" }} }}
        ]"#,
        serde_json::to_string(&path.display().to_string()).unwrap()
    );
    let mut s = Scenario::new("pdf");
    s.variables = vec![
        VariableDef::new("invoice", VarType::Any),
        VariableDef {
            direction: VarDirection::Output,
            ..VariableDef::new("amount", VarType::Any)
        },
    ];
    s.steps = serde_json::from_str(&steps).unwrap();
    for step in &mut s.steps {
        shikigami_core::ops::assign_missing_ids(step);
    }
    let report = runtime()
        .start(s, RunOptions::default())
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert_eq!(report.status, RunStatus::Succeeded, "{:?}", report.error);
    assert_eq!(report.outputs["amount"], json!(12800));
}

//! Putting pages of PDFs together: `pdf.merge`, `pdf.extractPages` and
//! `pdf.split` all build a new document from chosen pages of loaded ones.
//!
//! The new document holds only the chosen pages and what they use. Anything
//! else that points at other pages (bookmarks, the tag tree, form fields,
//! links to pages left out) is not carried over, so a page split out of a
//! batch of invoices never carries another customer's page inside the file.

use std::collections::{BTreeSet, HashSet};

use pdf_extract::{Dictionary, Document, Object, ObjectId};
use serde_json::json;
use shikigami_runtime::StepError;

/// Keys a page takes from its parents in the page tree when it has none.
const INHERITED: [&[u8]; 4] = [b"Resources", b"MediaBox", b"CropBox", b"Rotate"];

/// Pages chosen from one loaded document, in the order they go out.
pub struct Source {
    pub doc: Document,
    /// Page numbers (1 = the first page).
    pub pages: Vec<u32>,
}

/// A new document made of the chosen pages, one source after another.
pub fn assemble(sources: Vec<Source>) -> Document {
    let mut out = Document::with_version("1.5");
    let mut version = String::from("1.5");
    let mut next_id = 1;
    let mut kids: Vec<ObjectId> = Vec::new();
    let mut dropped: HashSet<ObjectId> = HashSet::new();

    for Source { mut doc, pages } in sources {
        doc.renumber_objects_with(next_id);
        next_id = doc.max_id + 1;
        if doc.version > version {
            version.clone_from(&doc.version);
        }
        let all = doc.get_pages();
        let chosen: Vec<ObjectId> = pages.iter().filter_map(|n| all.get(n).copied()).collect();
        for id in &chosen {
            let inherited = inherited_keys(&doc, *id);
            if let Ok(page) = doc.get_dictionary_mut(*id) {
                for (key, value) in inherited {
                    page.set(key, value);
                }
            }
        }
        let keep: HashSet<ObjectId> = chosen.iter().copied().collect();
        // Every page left out, every node of the old page tree and the old
        // catalog: references to them are cut so they are not copied along.
        dropped.extend(all.values().filter(|id| !keep.contains(id)));
        dropped.extend(doc.objects.iter().filter_map(|(id, object)| {
            matches!(object.type_name(), Ok(b"Pages" | b"Catalog")).then_some(*id)
        }));
        if let Ok(root) = doc.trailer.get(b"Root").and_then(Object::as_reference) {
            dropped.insert(root);
        }
        kids.extend(chosen);
        out.objects.append(&mut doc.objects);
    }

    let pages_id = (next_id, 0);
    let catalog_id = (next_id + 1, 0);
    out.max_id = next_id + 1;
    out.version = version;
    for id in &kids {
        if let Ok(page) = out.get_dictionary_mut(*id) {
            page.set("Parent", pages_id);
        }
    }
    let count = i64::try_from(kids.len()).unwrap_or(i64::MAX);
    out.objects.insert(
        pages_id,
        Object::Dictionary(Dictionary::from_iter([
            ("Type", Object::Name(b"Pages".to_vec())),
            ("Count", Object::Integer(count)),
            (
                "Kids",
                Object::Array(kids.into_iter().map(Object::Reference).collect()),
            ),
        ])),
    );
    out.objects.insert(
        catalog_id,
        Object::Dictionary(Dictionary::from_iter([
            ("Type", Object::Name(b"Catalog".to_vec())),
            ("Pages", Object::Reference(pages_id)),
        ])),
    );
    out.trailer = Dictionary::new();
    out.trailer.set("Root", catalog_id);
    for id in &dropped {
        out.objects.remove(id);
    }
    // Cut the references that are left to what was dropped (a page's /Parent
    // was set above; links, /P of annotations and the like are not).
    out.traverse_objects(|object| {
        if let Object::Reference(id) = object
            && dropped.contains(id)
        {
            *object = Object::Null;
        }
    });
    out.prune_objects();
    out.renumber_objects();
    out
}

/// The inherited attributes `page` lacks, from the nearest parent having them.
fn inherited_keys(doc: &Document, page: ObjectId) -> Vec<(&'static [u8], Object)> {
    let Ok(dict) = doc.get_dictionary(page) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for key in INHERITED {
        if dict.has(key) {
            continue;
        }
        let mut seen = BTreeSet::new();
        let mut parent = dict.get(b"Parent").and_then(Object::as_reference).ok();
        while let Some(id) = parent {
            if !seen.insert(id) {
                break;
            }
            let Ok(node) = doc.get_dictionary(id) else {
                break;
            };
            if let Ok(value) = node.get(key) {
                found.push((key, value.clone()));
                break;
            }
            parent = node.get(b"Parent").and_then(Object::as_reference).ok();
        }
    }
    found
}

/// Pages named like `1-3,5,8-` (`8-` = from page 8 to the last), in that
/// order; each page at most once.
pub fn parse_pages(spec: &str, count: u32) -> Result<Vec<u32>, StepError> {
    let bad = |why: String| {
        StepError::permanent("INVALID_PARAMS", format!("pages '{spec}': {why}")).with_details(json!({
            "hint": "Write page numbers and ranges separated by commas, e.g. \"1-3,5\" or \"2-\" (page 2 to the last). Page 1 is the first page.",
        }))
    };
    let out_of_range = |page: u32| {
        StepError::permanent(
            "PDF_PAGE_OUT_OF_RANGE",
            format!("page {page} does not exist: the PDF has {count} pages"),
        )
        .with_details(json!({ "pageCount": count }))
    };
    let number = |text: &str| -> Result<u32, StepError> {
        let n: u32 = text
            .trim()
            .parse()
            .map_err(|_| bad(format!("'{}' is not a page number", text.trim())))?;
        if n == 0 {
            return Err(bad("pages start at 1".into()));
        }
        if n > count {
            return Err(out_of_range(n));
        }
        Ok(n)
    };
    let mut pages = Vec::new();
    for part in spec.split([',', '、']) {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let (first, last) = match part.split_once(['-', '~', '〜']) {
            None => {
                let n = number(part)?;
                (n, n)
            }
            Some((a, b)) => {
                let first = number(a)?;
                let last = if b.trim().is_empty() {
                    count
                } else {
                    number(b)?
                };
                if last < first {
                    return Err(bad(format!("'{part}' goes backwards")));
                }
                (first, last)
            }
        };
        for page in first..=last {
            if pages.contains(&page) {
                return Err(bad(format!("page {page} is named twice")));
            }
            pages.push(page);
        }
    }
    if pages.is_empty() {
        return Err(bad("no page is named".into()));
    }
    Ok(pages)
}

/// The document as PDF bytes.
pub fn to_bytes(mut doc: Document) -> Result<Vec<u8>, StepError> {
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes)
        .map_err(|e| StepError::permanent("PDF_WRITE_FAILED", e.to_string()))?;
    Ok(bytes)
}

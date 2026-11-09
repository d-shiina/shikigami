//! Putting pages of PDFs together: `pdf.merge`, `pdf.extractPages` and
//! `pdf.split` all build a new document from chosen pages of loaded ones.
//!
//! The new document holds only the chosen pages and what they use. Anything
//! else that points at other pages (bookmarks, the tag tree, form fields,
//! links to pages left out) is not carried over, so a page split out of a
//! batch of invoices never carries another customer's page inside the file.
//! Resources the pages share (one `/XObject` dictionary holding every
//! page's scanned image, as scanners write it) are cut down to what each
//! kept page draws, for the same reason.

use std::collections::{BTreeSet, HashSet};

use pdf_extract::content::Content;
use pdf_extract::{Dictionary, Document, Object, ObjectId};
use serde_json::json;
use spellsheet_runtime::StepError;

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
        let mut forms = HashSet::new();
        for id in &chosen {
            scope_page_resources(&mut doc, *id, &mut forms);
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

/// The names `Do` draws in a content stream (images and forms), or `None`
/// when the content cannot be read (then nothing is cut). The name is the
/// last operand: the parser reads a glyph's `0 0 d0` as `d` with an extra
/// `0` that it hands to the next operator.
fn drawn_names(content: &[u8]) -> Option<HashSet<Vec<u8>>> {
    let content = Content::decode(content).ok()?;
    Some(
        content
            .operations
            .iter()
            .filter(|op| op.operator == "Do")
            .filter_map(|op| {
                op.operands
                    .iter()
                    .rev()
                    .find_map(|o| o.as_name().ok())
                    .map(<[u8]>::to_vec)
            })
            .collect(),
    )
}

/// `object` as a dictionary, following one reference.
fn dictionary(doc: &Document, object: &Object) -> Option<Dictionary> {
    match object {
        Object::Dictionary(d) => Some(d.clone()),
        Object::Reference(id) => doc.get_dictionary(*id).ok().cloned(),
        _ => None,
    }
}

/// `used` plus what forms and Type 3 glyphs without resources of their
/// own draw: they use the resources of whatever draws them (older PDFs
/// write them so).
fn with_borrowing_forms(
    doc: &Document,
    resources: &Dictionary,
    mut used: HashSet<Vec<u8>>,
) -> Option<HashSet<Vec<u8>>> {
    // Type 3 glyphs without resources of their own draw with these too.
    for (_, font) in resources
        .get(b"Font")
        .ok()
        .and_then(|f| dictionary(doc, f))
        .iter()
        .flat_map(Dictionary::iter)
    {
        let Some(font) = dictionary(doc, font) else {
            continue;
        };
        let is_type3 = matches!(font.get(b"Subtype"), Ok(Object::Name(n)) if n == b"Type3");
        if !is_type3 || font.has(b"Resources") {
            continue;
        }
        let glyphs = font
            .get(b"CharProcs")
            .ok()
            .and_then(|c| dictionary(doc, c))?;
        for (_, glyph) in glyphs.iter() {
            let stream = glyph
                .as_reference()
                .ok()
                .and_then(|id| doc.get_object(id).and_then(Object::as_stream).ok())?;
            let content = stream
                .decompressed_content()
                .unwrap_or_else(|_| stream.content.clone());
            // A glyph whose drawing cannot be read: nothing is cut.
            used.extend(drawn_names(&content)?);
        }
    }
    let Some(xobjects) = resources
        .get(b"XObject")
        .ok()
        .and_then(|x| dictionary(doc, x))
    else {
        return Some(used);
    };
    let mut todo: Vec<Vec<u8>> = used.iter().cloned().collect();
    while let Some(name) = todo.pop() {
        let Some(stream) = xobjects
            .get(&name)
            .ok()
            .and_then(|o| o.as_reference().ok())
            .and_then(|id| doc.get_object(id).and_then(Object::as_stream).ok())
        else {
            continue;
        };
        let is_form = matches!(stream.dict.get(b"Subtype"), Ok(Object::Name(n)) if n == b"Form");
        if !is_form || stream.dict.has(b"Resources") {
            continue;
        }
        let content = stream
            .decompressed_content()
            .unwrap_or_else(|_| stream.content.clone());
        // A form whose drawing cannot be read: nothing is cut.
        for drawn in drawn_names(&content)? {
            if used.insert(drawn.clone()) {
                todo.push(drawn);
            }
        }
    }
    Some(used)
}

/// `resources` with only the XObjects named in `used`; the Form XObjects
/// kept are returned so their own resources can be cut down too.
fn scoped(
    doc: &Document,
    mut resources: Dictionary,
    used: &HashSet<Vec<u8>>,
) -> (Dictionary, Vec<ObjectId>) {
    let Some(mut xobjects) = resources
        .get(b"XObject")
        .ok()
        .and_then(|x| dictionary(doc, x))
    else {
        return (resources, Vec::new());
    };
    let names: Vec<Vec<u8>> = xobjects.iter().map(|(k, _)| k.clone()).collect();
    for name in names {
        if !used.contains(&name) {
            xobjects.remove(&name);
        }
    }
    let forms = xobjects
        .iter()
        .filter_map(|(_, v)| v.as_reference().ok())
        .filter(|id| {
            doc.get_object(*id).and_then(Object::as_stream).is_ok_and(
                |s| matches!(s.dict.get(b"Subtype"), Ok(Object::Name(n)) if n == b"Form"),
            )
        })
        .collect();
    resources.set("XObject", Object::Dictionary(xobjects));
    (resources, forms)
}

/// Gives `page` its own resources holding only the images and forms it
/// draws, and does the same inside those forms.
fn scope_page_resources(doc: &mut Document, page: ObjectId, forms_done: &mut HashSet<ObjectId>) {
    let Ok(content) = doc.get_page_content(page) else {
        return;
    };
    let Some(used) = drawn_names(&content) else {
        return;
    };
    let Some(resources) = doc
        .get_dictionary(page)
        .ok()
        .and_then(|p| p.get(b"Resources").ok())
        .and_then(|r| dictionary(doc, r))
    else {
        return;
    };
    let Some(used) = with_borrowing_forms(doc, &resources, used) else {
        return;
    };
    let (resources, mut forms) = scoped(doc, resources, &used);
    if let Ok(dict) = doc.get_dictionary_mut(page) {
        dict.set("Resources", Object::Dictionary(resources));
    }
    while let Some(form) = forms.pop() {
        if !forms_done.insert(form) {
            continue;
        }
        let Ok(stream) = doc.get_object(form).and_then(Object::as_stream) else {
            continue;
        };
        let content = stream
            .decompressed_content()
            .unwrap_or_else(|_| stream.content.clone());
        let Some(used) = drawn_names(&content) else {
            continue;
        };
        let Some(resources) = stream
            .dict
            .get(b"Resources")
            .ok()
            .and_then(|r| dictionary(doc, r))
        else {
            continue;
        };
        let Some(used) = with_borrowing_forms(doc, &resources, used) else {
            continue;
        };
        let (resources, more) = scoped(doc, resources, &used);
        forms.extend(more);
        if let Ok(Object::Stream(stream)) = doc.get_object_mut(form) {
            stream.dict.set("Resources", Object::Dictionary(resources));
        }
    }
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

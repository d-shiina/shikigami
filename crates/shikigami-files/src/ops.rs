//! The file operations behind the `file.*` steps (blocking; run off the
//! async threads by the handler).

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};
use shikigami_core::expr::to_display;
use shikigami_runtime::StepError;
use tokio_util::sync::CancellationToken;

use crate::encoding;

/// Refuses to change files once the attempt was stopped or timed out: the
/// Runtime has moved on and may already run the next attempt.
pub fn check_cancel(cancel: &CancellationToken) -> Result<(), StepError> {
    if cancel.is_cancelled() {
        return Err(StepError::new(
            "CANCELLED",
            "the step was stopped before it finished changing files",
        ));
    }
    Ok(())
}

/// Turns an I/O error into a step error with a stable code.
pub fn io_error(e: &io::Error, path: &Path) -> StepError {
    let shown = path.display();
    match e.kind() {
        io::ErrorKind::NotFound => {
            StepError::permanent("FILE_NOT_FOUND", format!("{shown} does not exist"))
                .with_details(json!({ "path": shown.to_string(), "hint": "Check the path, or list the folder with file.list." }))
        }
        io::ErrorKind::AlreadyExists => {
            StepError::permanent("FILE_EXISTS", format!("{shown} already exists"))
                .with_details(json!({ "path": shown.to_string(), "hint": "Set overwrite: true to replace it." }))
        }
        io::ErrorKind::PermissionDenied => StepError::new(
            "FILE_ACCESS_DENIED",
            format!("{shown}: access denied (read-only, or open in another program)"),
        )
        .with_details(json!({ "path": shown.to_string() })),
        // ERROR_SHARING_VIOLATION / ERROR_LOCK_VIOLATION: open in Excel etc.
        _ if matches!(e.raw_os_error(), Some(32 | 33)) && cfg!(windows) => StepError::new(
            "FILE_IN_USE",
            format!("{shown} is open in another program"),
        )
        .with_details(json!({ "path": shown.to_string(), "hint": "Close the file (e.g. in Excel) and run again." })),
        _ => StepError::new("FILE_ERROR", format!("{shown}: {e}"))
            .with_details(json!({ "path": shown.to_string() })),
    }
}

fn exists_error(path: &Path) -> StepError {
    io_error(&io::Error::from(io::ErrorKind::AlreadyExists), path)
}

pub fn read_bytes(path: &Path) -> Result<Vec<u8>, StepError> {
    fs::read(path).map_err(|e| io_error(&e, path))
}

fn ensure_parent(path: &Path) -> Result<(), StepError> {
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => {
            fs::create_dir_all(parent).map_err(|e| io_error(&e, parent))
        }
        _ => Ok(()),
    }
}

/// Replaces `path` with `bytes` through a temporary file in the same folder,
/// so a reader never sees half a file.
pub fn write_atomic(
    path: &Path,
    bytes: &[u8],
    cancel: &CancellationToken,
) -> Result<(), StepError> {
    ensure_parent(path)?;
    let dir = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut tmp = tempfile::NamedTempFile::new_in(dir).map_err(|e| io_error(&e, dir))?;
    tmp.write_all(bytes).map_err(|e| io_error(&e, path))?;
    check_cancel(cancel)?;
    tmp.persist(path).map_err(|e| io_error(&e.error, path))?;
    Ok(())
}

pub fn append(path: &Path, bytes: &[u8], cancel: &CancellationToken) -> Result<(), StepError> {
    check_cancel(cancel)?;
    ensure_parent(path)?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| io_error(&e, path))?;
    file.write_all(bytes).map_err(|e| io_error(&e, path))
}

fn has_content(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|m| m.len() > 0)
}

pub fn write_text(
    path: &Path,
    text: &str,
    encoding: &str,
    append_mode: bool,
    cancel: &CancellationToken,
) -> Result<(), StepError> {
    if append_mode {
        let bytes = encoding::encode(text, encoding, !has_content(path))?;
        append(path, &bytes, cancel)
    } else {
        write_atomic(path, &encoding::encode(text, encoding, true)?, cancel)
    }
}

// ---------------------------------------------------------------------------
// CSV

fn delimiter(value: Option<&str>) -> Result<u8, StepError> {
    match value.unwrap_or(",") {
        "\t" | "\\t" | "tab" => Ok(b'\t'),
        d if d.len() == 1 && d.is_ascii() => Ok(d.as_bytes()[0]),
        d => Err(StepError::permanent(
            "INVALID_PARAMS",
            format!("delimiter must be one ASCII character, got '{d}'"),
        )),
    }
}

/// Header names usable as keys: blanks become `列N`, repeats get `_2`, `_3`.
fn header_names(raw: &csv::StringRecord) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for (i, cell) in raw.iter().enumerate() {
        let base = match cell.trim() {
            "" => format!("列{}", i + 1),
            name => name.to_owned(),
        };
        let mut name = base.clone();
        let mut n = 2;
        while names.contains(&name) {
            name = format!("{base}_{n}");
            n += 1;
        }
        names.push(name);
    }
    names
}

pub fn read_csv(
    text: &str,
    delim: Option<&str>,
    header: bool,
    path: &str,
) -> Result<Value, StepError> {
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter(delim)?)
        .has_headers(false)
        .flexible(true)
        .from_reader(text.as_bytes());
    let mut records = reader.records();
    let bad = |e: csv::Error| StepError::permanent("CSV_INVALID", format!("{path}: {e}"));
    let names = if header {
        match records.next() {
            Some(first) => Some(header_names(&first.map_err(bad)?)),
            None => return Ok(json!([])),
        }
    } else {
        None
    };
    let mut rows = Vec::new();
    for record in records {
        let record = record.map_err(bad)?;
        rows.push(match &names {
            Some(names) => {
                let mut row = Map::new();
                for (i, name) in names.iter().enumerate() {
                    row.insert(name.clone(), json!(record.get(i).unwrap_or("")));
                }
                for (i, extra) in record.iter().enumerate().skip(names.len()) {
                    row.insert(format!("列{}", i + 1), json!(extra));
                }
                Value::Object(row)
            }
            None => json!(record.iter().collect::<Vec<_>>()),
        });
    }
    Ok(Value::Array(rows))
}

/// Columns for writing objects: `columns`, the header of the file being
/// appended to, or every key in order of first appearance.
fn csv_columns(
    rows: &[Value],
    columns: Option<Vec<String>>,
    existing: Option<Vec<String>>,
) -> Vec<String> {
    // When appending, the file's header decides: rows are matched to it by
    // key, so values never land under another column.
    if let Some(columns) = existing.or(columns) {
        return columns;
    }
    let mut out: Vec<String> = Vec::new();
    for row in rows {
        if let Value::Object(map) = row {
            for key in map.keys() {
                if !out.contains(key) {
                    out.push(key.clone());
                }
            }
        }
    }
    out
}

pub struct CsvWrite<'a> {
    pub path: &'a Path,
    pub rows: &'a [Value],
    pub columns: Option<Vec<String>>,
    pub delimiter: Option<&'a str>,
    pub header: bool,
    pub append: bool,
    pub encoding: &'a str,
    pub cancel: &'a CancellationToken,
}

pub fn write_csv(w: &CsvWrite<'_>) -> Result<usize, StepError> {
    let appending = w.append && has_content(w.path);
    let existing = if appending && w.header {
        let text = encoding::decode(&read_bytes(w.path)?, "auto", &w.path.display().to_string())?;
        let mut reader = csv::ReaderBuilder::new()
            .delimiter(delimiter(w.delimiter)?)
            .has_headers(false)
            .flexible(true)
            .from_reader(text.as_bytes());
        reader
            .records()
            .next()
            .and_then(Result::ok)
            .map(|r| header_names(&r))
    } else {
        None
    };
    let objects = w.rows.iter().any(Value::is_object);
    let columns = if objects {
        csv_columns(w.rows, w.columns.clone(), existing)
    } else {
        w.columns.clone().unwrap_or_default()
    };
    let mut writer = csv::WriterBuilder::new()
        .delimiter(delimiter(w.delimiter)?)
        .flexible(true)
        .terminator(csv::Terminator::CRLF)
        .from_writer(Vec::new());
    let fail = |e: csv::Error| StepError::permanent("CSV_INVALID", e.to_string());
    if w.header && !appending && !columns.is_empty() {
        writer.write_record(&columns).map_err(fail)?;
    }
    for (i, row) in w.rows.iter().enumerate() {
        let cells: Vec<String> = match row {
            Value::Object(map) => columns
                .iter()
                .map(|c| map.get(c).map(to_display).unwrap_or_default())
                .collect(),
            Value::Array(cells) => cells.iter().map(to_display).collect(),
            other => {
                return Err(StepError::permanent(
                    "INVALID_PARAMS",
                    format!("rows[{i}] must be an object or a list, got {other}"),
                ));
            }
        };
        writer.write_record(&cells).map_err(fail)?;
    }
    let bytes = writer
        .into_inner()
        .map_err(|e| StepError::permanent("CSV_INVALID", e.to_string()))?;
    let text =
        String::from_utf8(bytes).map_err(|e| StepError::permanent("CSV_INVALID", e.to_string()))?;
    write_text(w.path, &text, w.encoding, w.append, w.cancel)?;
    Ok(w.rows.len())
}

// ---------------------------------------------------------------------------
// Files and folders

fn modified(meta: &fs::Metadata) -> Value {
    meta.modified()
        .ok()
        .and_then(|t| jiff::Timestamp::try_from(t).ok())
        .map_or(Value::Null, |ts| {
            json!(
                ts.to_zoned(jiff::tz::TimeZone::system())
                    .datetime()
                    .strftime("%Y-%m-%dT%H:%M:%S")
                    .to_string()
            )
        })
}

pub fn entry(path: &Path, meta: &fs::Metadata) -> Value {
    json!({
        "path": path.display().to_string(),
        "name": path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        "isFolder": meta.is_dir(),
        "size": if meta.is_dir() { 0 } else { meta.len() },
        "modified": modified(meta),
    })
}

pub struct ListOptions<'a> {
    pub pattern: &'a str,
    pub recursive: bool,
    /// `file`, `folder` or `all`.
    pub kind: &'a str,
}

pub fn list(folder: &Path, options: &ListOptions<'_>) -> Result<Value, StepError> {
    let pattern = glob::Pattern::new(options.pattern).map_err(|e| {
        StepError::permanent(
            "INVALID_PARAMS",
            format!("pattern '{}': {e}", options.pattern),
        )
    })?;
    let match_options = glob::MatchOptions {
        case_sensitive: false,
        require_literal_separator: false,
        require_literal_leading_dot: false,
    };
    let meta = fs::metadata(folder).map_err(|e| io_error(&e, folder))?;
    if !meta.is_dir() {
        return Err(StepError::permanent(
            "NOT_A_FOLDER",
            format!("{} is a file, not a folder", folder.display()),
        ));
    }
    let mut found = Vec::new();
    let mut pending = vec![folder.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for item in fs::read_dir(&dir).map_err(|e| io_error(&e, &dir))? {
            let item = item.map_err(|e| io_error(&e, &dir))?;
            let path = item.path();
            let Ok(meta) = item.metadata() else { continue };
            if meta.is_dir() && options.recursive {
                pending.push(path.clone());
            }
            let wanted = match options.kind {
                "folder" => meta.is_dir(),
                "all" => true,
                _ => meta.is_file(),
            };
            let name = item.file_name().to_string_lossy().into_owned();
            if wanted && pattern.matches_with(&name, match_options) {
                found.push((path, meta));
            }
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(Value::Array(
        found.iter().map(|(p, m)| entry(p, m)).collect(),
    ))
}

fn copy_tree(from: &Path, to: &Path, cancel: &CancellationToken) -> Result<(), StepError> {
    fs::create_dir_all(to).map_err(|e| io_error(&e, to))?;
    for item in fs::read_dir(from).map_err(|e| io_error(&e, from))? {
        check_cancel(cancel)?;
        let item = item.map_err(|e| io_error(&e, from))?;
        let target = to.join(item.file_name());
        if item
            .file_type()
            .map_err(|e| io_error(&e, &item.path()))?
            .is_dir()
        {
            copy_tree(&item.path(), &target, cancel)?;
        } else {
            fs::copy(item.path(), &target).map_err(|e| io_error(&e, &item.path()))?;
        }
    }
    Ok(())
}

/// The same file or folder under two spellings (`a.csv` / `A.CSV`, `.\\a`).
fn same_path(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Rejects a destination that is the source itself or lies inside it.
fn check_distinct(from: &Path, to: &Path) -> Result<(), StepError> {
    let inside = fs::canonicalize(from).ok().is_some_and(|from| {
        to.ancestors()
            .skip(1)
            .filter_map(|a| fs::canonicalize(a).ok())
            .any(|a| a == from)
    });
    if same_path(from, to) || inside {
        return Err(StepError::permanent(
            "SAME_PATH",
            format!(
                "{} cannot be copied or moved onto or into itself",
                from.display()
            ),
        )
        .with_details(
            json!({ "from": from.display().to_string(), "to": to.display().to_string() }),
        ));
    }
    Ok(())
}

fn prepare_target(to: &Path, overwrite: bool) -> Result<(), StepError> {
    if fs::symlink_metadata(to).is_ok() {
        if !overwrite {
            return Err(exists_error(to));
        }
        remove(to, true)?;
    }
    ensure_parent(to)
}

pub fn copy(
    from: &Path,
    to: &Path,
    overwrite: bool,
    cancel: &CancellationToken,
) -> Result<(), StepError> {
    let meta = fs::metadata(from).map_err(|e| io_error(&e, from))?;
    check_distinct(from, to)?;
    check_cancel(cancel)?;
    prepare_target(to, overwrite)?;
    if meta.is_dir() {
        copy_tree(from, to, cancel)
    } else {
        fs::copy(from, to)
            .map(|_| ())
            .map_err(|e| io_error(&e, from))
    }
}

pub fn rename(
    from: &Path,
    to: &Path,
    overwrite: bool,
    cancel: &CancellationToken,
) -> Result<(), StepError> {
    fs::metadata(from).map_err(|e| io_error(&e, from))?;
    // Renaming `a.csv` to `A.csv` (same file on Windows) is allowed.
    let case_only = same_path(from, to) && from != to;
    if !case_only {
        check_distinct(from, to)?;
    }
    check_cancel(cancel)?;
    if !case_only {
        prepare_target(to, overwrite)?;
    }
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    // Another drive: copy, then delete the original.
    copy(from, to, false, cancel)?;
    check_cancel(cancel)?;
    remove(from, true).map(|_| ())
}

/// Deletes a file or folder. Returns false when there was nothing to delete.
pub fn remove(path: &Path, recursive: bool) -> Result<bool, StepError> {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return Ok(false);
    };
    let result = if meta.is_dir() {
        if recursive {
            fs::remove_dir_all(path)
        } else {
            fs::remove_dir(path).map_err(|e| {
                if fs::read_dir(path).is_ok_and(|mut d| d.next().is_some()) {
                    io::Error::new(io::ErrorKind::DirectoryNotEmpty, e)
                } else {
                    e
                }
            })
        }
    } else {
        fs::remove_file(path)
    };
    result.map_err(|e| {
        if e.kind() == io::ErrorKind::DirectoryNotEmpty {
            StepError::permanent(
                "FOLDER_NOT_EMPTY",
                format!("{} is a folder with files in it", path.display()),
            )
            .with_details(
                json!({ "hint": "Set recursive: true to delete the folder and everything in it." }),
            )
        } else {
            io_error(&e, path)
        }
    })?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// Zip

/// Name of a zip entry. Zips made by Windows Explorer store Japanese names
/// in Shift_JIS without saying so.
pub(crate) fn entry_name(raw: &[u8]) -> String {
    match std::str::from_utf8(raw) {
        Ok(name) => name.to_owned(),
        Err(_) => encoding_rs::SHIFT_JIS
            .decode_without_bom_handling(raw)
            .0
            .into_owned(),
    }
}

struct ZipJob<'a> {
    options: zip::write::SimpleFileOptions,
    /// The archive being written (and the one it replaces): never added to itself.
    skip: Vec<PathBuf>,
    cancel: &'a CancellationToken,
}

fn add_to_zip(
    zip: &mut zip::ZipWriter<fs::File>,
    path: &Path,
    name: &str,
    job: &ZipJob<'_>,
) -> Result<(), StepError> {
    check_cancel(job.cancel)?;
    let options = job.options;
    let fail = |e: zip::result::ZipError| StepError::new("ZIP_ERROR", e.to_string());
    let meta = fs::metadata(path).map_err(|e| io_error(&e, path))?;
    if meta.is_dir() {
        zip.add_directory(format!("{name}/"), options)
            .map_err(fail)?;
        let mut children: Vec<_> = fs::read_dir(path)
            .map_err(|e| io_error(&e, path))?
            .filter_map(Result::ok)
            .collect();
        children.sort_by_key(fs::DirEntry::file_name);
        for child in children {
            let child_name = format!("{name}/{}", child.file_name().to_string_lossy());
            let child_path = child.path();
            if fs::canonicalize(&child_path).is_ok_and(|c| job.skip.contains(&c)) {
                continue;
            }
            add_to_zip(zip, &child_path, &child_name, job)?;
        }
    } else {
        zip.start_file(name, options).map_err(fail)?;
        let mut file = fs::File::open(path).map_err(|e| io_error(&e, path))?;
        io::copy(&mut file, zip).map_err(|e| io_error(&e, path))?;
    }
    Ok(())
}

pub fn zip(
    sources: &[PathBuf],
    to: &Path,
    overwrite: bool,
    cancel: &CancellationToken,
) -> Result<(), StepError> {
    for source in sources {
        fs::metadata(source).map_err(|e| io_error(&e, source))?;
    }
    if !overwrite && to.exists() {
        return Err(exists_error(to));
    }
    ensure_parent(to)?;
    let dir = to
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let tmp = tempfile::NamedTempFile::new_in(dir).map_err(|e| io_error(&e, dir))?;
    let file = tmp.reopen().map_err(|e| io_error(&e, to))?;
    let mut writer = zip::ZipWriter::new(file);
    let job = ZipJob {
        options: zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated),
        skip: [tmp.path(), to]
            .iter()
            .filter_map(|p| fs::canonicalize(p).ok())
            .collect(),
        cancel,
    };
    for source in sources {
        let name = source
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "root".into());
        add_to_zip(&mut writer, source, &name, &job)?;
    }
    writer
        .finish()
        .map_err(|e| StepError::new("ZIP_ERROR", e.to_string()))?;
    check_cancel(cancel)?;
    tmp.persist(to).map_err(|e| io_error(&e.error, to))?;
    Ok(())
}

/// Fails when a folder between `root` and `target` is a link (symlink or
/// junction) that already exists: writing through it would leave `root`.
fn check_no_links(root: &Path, target: &Path) -> Result<(), StepError> {
    let Ok(relative) = target.strip_prefix(root) else {
        return Ok(());
    };
    let mut current = root.to_path_buf();
    for part in relative.components() {
        current.push(part);
        if fs::symlink_metadata(&current).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(StepError::permanent(
                "ZIP_INVALID",
                format!(
                    "{} is a link; extracting through it would leave the destination",
                    current.display()
                ),
            ));
        }
    }
    Ok(())
}

pub fn unzip(
    path: &Path,
    to: &Path,
    overwrite: bool,
    cancel: &CancellationToken,
) -> Result<Value, StepError> {
    let file = fs::File::open(path).map_err(|e| io_error(&e, path))?;
    let bad = |e: zip::result::ZipError| {
        StepError::permanent("ZIP_INVALID", format!("{}: {e}", path.display()))
    };
    let mut archive = zip::ZipArchive::new(file).map_err(bad)?;
    let mut planned = Vec::new();
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(bad)?;
        let name = entry_name(entry.name_raw());
        let relative: PathBuf = name
            .split(['/', '\\'])
            .filter(|part| !part.is_empty() && *part != ".")
            .collect();
        if name.split(['/', '\\']).any(|p| p == "..")
            || relative.is_absolute()
            || relative.has_root()
        {
            return Err(StepError::permanent(
                "ZIP_INVALID",
                format!(
                    "{}: the entry '{name}' points outside the destination",
                    path.display()
                ),
            ));
        }
        let target = to.join(&relative);
        check_no_links(to, &target)?;
        if !entry.is_dir() && !overwrite && target.exists() {
            return Err(exists_error(&target));
        }
        planned.push((i, target, entry.is_dir()));
    }
    let mut extracted = Vec::new();
    for (i, target, is_dir) in planned {
        check_cancel(cancel)?;
        check_no_links(to, &target)?;
        if is_dir {
            fs::create_dir_all(&target).map_err(|e| io_error(&e, &target))?;
            continue;
        }
        ensure_parent(&target)?;
        let mut entry = archive.by_index(i).map_err(bad)?;
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|e| io_error(&e, path))?;
        fs::write(&target, bytes).map_err(|e| io_error(&e, &target))?;
        extracted.push(json!(target.display().to_string()));
    }
    Ok(Value::Array(extracted))
}

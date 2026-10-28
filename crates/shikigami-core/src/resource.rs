//! Exclusive resources a step uses, derived from its params.
//!
//! Step type authors declare *where* a resource comes from (a fixed name or a
//! param); scenario authors never write lock names. The Runtime turns the
//! rendered params of each step into keys and lets only one step hold a key
//! at a time. The same key strings are meant to back cross-process locks
//! later, so they must not depend on the process.

use serde_json::Value;

/// Where a step type's exclusive resource comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResourceDef {
    /// Always the same resource, e.g. [`DESKTOP_INPUT`].
    Static(String),
    /// The resource named by a param (after template rendering).
    Param { key: String, kind: ResourceKind },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceKind {
    /// A file path; normalised so different spellings of one file collide.
    File,
    /// A window (title or handle).
    Window,
    /// A browser context / profile.
    BrowserContext,
}

/// The physical mouse, keyboard and foreground window: one per desktop.
pub const DESKTOP_INPUT: &str = "desktop.input";

impl ResourceDef {
    pub fn file(key: &str) -> Self {
        Self::Param {
            key: key.into(),
            kind: ResourceKind::File,
        }
    }
}

/// Resource keys for one step, from its rendered params. Params that are
/// missing or not strings yield no key (validation reports them).
pub fn resource_keys(defs: &[ResourceDef], params: &Value) -> Vec<String> {
    let mut keys: Vec<String> = defs
        .iter()
        .filter_map(|def| match def {
            ResourceDef::Static(name) => Some(name.clone()),
            ResourceDef::Param { key, kind } => {
                let value = params.get(key)?.as_str()?.trim();
                if value.is_empty() {
                    return None;
                }
                Some(match kind {
                    ResourceKind::File => format!("file:{}", normalize_path(value)),
                    ResourceKind::Window => format!("window:{}", value.to_lowercase()),
                    ResourceKind::BrowserContext => format!("browser:{value}"),
                })
            }
        })
        .collect();
    keys.sort_unstable();
    keys.dedup();
    keys
}

/// Whether `path` is absolute in Windows terms (`C:\…` or `\\server\…`).
pub fn is_absolute_windows_path(path: &str) -> bool {
    let b = path.as_bytes();
    let drive = b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && is_sep(b[2]);
    let unc = b.len() >= 2 && is_sep(b[0]) && is_sep(b[1]);
    drive || unc
}

fn is_sep(b: u8) -> bool {
    b == b'\\' || b == b'/'
}

/// Windows path identity: absolute (relative paths are resolved against the
/// current directory; the file need not exist), no `\\?\` prefix, `\`
/// separators, `.` / `..` folded, lower case, no trailing `\`.
pub fn normalize_path(path: &str) -> String {
    let mut path = path.replace('/', "\\");
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        path = format!(r"\\{rest}");
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        path = rest.to_owned();
    }
    if !is_absolute_windows_path(&path)
        && let Ok(cwd) = std::env::current_dir()
    {
        let cwd = cwd.to_string_lossy().replace('/', "\\");
        path = format!("{}\\{path}", cwd.trim_end_matches('\\'));
    }

    let (prefix, rest) = if let Some(rest) = path.strip_prefix(r"\\") {
        // \\server\share is the root of a UNC path.
        let mut parts = rest.splitn(3, '\\');
        let server = parts.next().unwrap_or_default();
        let share = parts.next().unwrap_or_default();
        (
            format!(r"\\{server}\{share}"),
            parts.next().unwrap_or_default().to_owned(),
        )
    } else if path.len() >= 2 && path.as_bytes()[1] == b':' {
        (path[..2].to_owned(), path[2..].to_owned())
    } else {
        (String::new(), path.clone())
    };

    let mut parts: Vec<&str> = Vec::new();
    for part in rest.split('\\') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            p => parts.push(p),
        }
    }
    let mut out = prefix;
    for part in parts {
        out.push('\\');
        out.push_str(part);
    }
    out.to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn spellings_of_one_file_share_a_key() {
        let same = [
            r"C:\Data\in.xlsx",
            "c:/data/IN.xlsx",
            r"C:\Data\.\sub\..\in.xlsx",
            r"\\?\C:\Data\in.xlsx",
            r"C:\\Data\in.xlsx",
        ];
        for path in same {
            assert_eq!(normalize_path(path), r"c:\data\in.xlsx", "{path}");
        }
        assert_eq!(
            normalize_path(r"\\Server\Share\a\..\b.csv"),
            r"\\server\share\b.csv"
        );
        assert_eq!(
            normalize_path(r"\\?\UNC\server\share\x"),
            r"\\server\share\x"
        );
        assert_eq!(normalize_path(r"C:\Data\"), r"c:\data");
    }

    #[test]
    fn keys_come_from_rendered_params() {
        let defs = [
            ResourceDef::Static(DESKTOP_INPUT.into()),
            ResourceDef::file("path"),
            ResourceDef::Param {
                key: "title".into(),
                kind: ResourceKind::Window,
            },
        ];
        let keys = resource_keys(&defs, &json!({ "path": "C:/A.xlsx", "title": "Excel" }));
        assert_eq!(keys, ["desktop.input", r"file:c:\a.xlsx", "window:excel"]);
        // Missing params give no key.
        assert_eq!(resource_keys(&defs, &json!({})), ["desktop.input"]);
    }

    #[test]
    fn absolute_paths() {
        assert!(is_absolute_windows_path(r"C:\x"));
        assert!(is_absolute_windows_path("d:/x"));
        assert!(is_absolute_windows_path(r"\\server\share"));
        assert!(!is_absolute_windows_path("data.xlsx"));
        assert!(!is_absolute_windows_path(r"C:data.xlsx"));
        assert!(!is_absolute_windows_path(r"..\data.xlsx"));
    }
}

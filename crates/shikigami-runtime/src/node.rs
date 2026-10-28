//! Which Node.js starts the browser adapter and Node plugins.
//!
//! The Windows installer ships Node.js in `node\` next to `shikigami.exe`
//! and Studio, so browser steps and Node plugins work on PCs where Node.js
//! is not installed (or cannot be, as on many company PCs). A development
//! build has no such folder and uses `node` on PATH.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// The folder next to the executables that holds the shipped Node.js.
pub const BUNDLED_NODE_DIR: &str = "node";

/// `SHIKIGAMI_NODE` when set, otherwise the Node.js shipped next to the
/// running executable, otherwise `node` on PATH.
pub fn node_program() -> PathBuf {
    resolve(std::env::var_os("SHIKIGAMI_NODE"), exe_dir().as_deref())
}

/// The folder of the running executable, where the installer puts the
/// files it ships (`node\`, `browser-adapter\`).
pub fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
}

/// Whether a plugin's `command.program` means Node.js on PATH, so that the
/// shipped Node.js can stand in for it.
pub fn is_node(program: &str) -> bool {
    program.eq_ignore_ascii_case("node") || program.eq_ignore_ascii_case("node.exe")
}

fn resolve(env: Option<OsString>, exe_dir: Option<&Path>) -> PathBuf {
    if let Some(node) = env.filter(|v| !v.is_empty()) {
        return PathBuf::from(node);
    }
    exe_dir
        .map(|dir| {
            dir.join(BUNDLED_NODE_DIR)
                .join(format!("node{}", std::env::consts::EXE_SUFFIX))
        })
        .filter(|bundled| bundled.is_file())
        .unwrap_or_else(|| PathBuf::from("node"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundled(dir: &Path) -> PathBuf {
        let node = dir
            .join(BUNDLED_NODE_DIR)
            .join(format!("node{}", std::env::consts::EXE_SUFFIX));
        std::fs::create_dir_all(node.parent().unwrap()).unwrap();
        std::fs::write(&node, "").unwrap();
        node
    }

    #[test]
    fn prefers_the_environment_variable() {
        let dir = tempfile::tempdir().unwrap();
        bundled(dir.path());
        assert_eq!(
            resolve(Some("C:/tools/node.exe".into()), Some(dir.path())),
            PathBuf::from("C:/tools/node.exe")
        );
    }

    #[test]
    fn uses_the_shipped_node_next_to_the_executable() {
        let dir = tempfile::tempdir().unwrap();
        let node = bundled(dir.path());
        assert_eq!(resolve(None, Some(dir.path())), node);
        assert_eq!(resolve(Some("".into()), Some(dir.path())), node);
    }

    #[test]
    fn falls_back_to_node_on_path() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(resolve(None, Some(dir.path())), PathBuf::from("node"));
        assert_eq!(resolve(None, None), PathBuf::from("node"));
    }

    #[test]
    fn recognizes_node_as_a_plugin_program() {
        assert!(is_node("node"));
        assert!(is_node("Node.exe"));
        assert!(!is_node("python"));
        assert!(!is_node("./node"));
    }
}

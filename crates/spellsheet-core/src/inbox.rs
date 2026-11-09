//! Messages the person writes in Writer's AI chat while the AI is working.
//!
//! The AI keeps calling SpellSheet's MCP tools while it works, and each call
//! is a moment it reads what comes back. Writer puts a message the person
//! sends meanwhile in a folder for that turn ([`ChatInbox::post`]); the MCP
//! server takes whatever is there when a tool call ends ([`ChatInbox::take`])
//! and adds it to that call's result, so the AI reads it without being
//! stopped. A message still in the folder when the turn ends was never read:
//! Writer takes it back and sends it as the next message.
//!
//! One file per message, named so they sort in the order sent. Taking one
//! renames it first, so the server and Writer never both get it.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::CoreResult;
use crate::store::write_atomic;

const EXT: &str = "msg";
const TAKEN: &str = "taken";

/// One message the person sent while the AI worked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboxMessage {
    /// Writer's id for the message, so it can mark it as read.
    pub id: String,
    pub text: String,
}

/// The folder of one turn's messages.
#[derive(Debug, Clone)]
pub struct ChatInbox {
    dir: PathBuf,
}

impl ChatInbox {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Leaves a message for the AI's next tool call.
    pub fn post(&self, id: &str, text: &str) -> CoreResult<()> {
        fs::create_dir_all(&self.dir)?;
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis());
        let name = format!("{millis:015}-{}.{EXT}", safe(id));
        write_atomic(&self.dir.join(name), text.as_bytes())
    }

    /// Ids of the messages not taken yet, oldest first.
    pub fn waiting(&self) -> Vec<String> {
        self.files().into_iter().map(|(id, _)| id).collect()
    }

    /// Takes every message not taken yet, oldest first.
    pub fn take(&self) -> Vec<InboxMessage> {
        let mut out = Vec::new();
        for (id, path) in self.files() {
            let claimed = path.with_extension(TAKEN);
            // Someone else took it first.
            if fs::rename(&path, &claimed).is_err() {
                continue;
            }
            let text = fs::read_to_string(&claimed).unwrap_or_default();
            let _ = fs::remove_file(&claimed);
            if !text.trim().is_empty() {
                out.push(InboxMessage { id, text });
            }
        }
        out
    }

    /// Removes the folder with whatever is left in it.
    pub fn remove(&self) {
        let _ = fs::remove_dir_all(&self.dir);
    }

    fn files(&self) -> Vec<(String, PathBuf)> {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut paths: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e == EXT))
            .collect();
        // Names start with the time sent.
        paths.sort();
        paths
            .into_iter()
            .filter_map(|p| {
                let id = p.file_stem()?.to_str()?.split_once('-')?.1.to_owned();
                Some((id, p))
            })
            .collect()
    }
}

/// Keeps an id usable as part of a file name.
fn safe(id: &str) -> String {
    id.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .take(64)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_come_out_once_in_the_order_sent() {
        let dir = tempfile::tempdir().unwrap();
        let inbox = ChatInbox::new(dir.path().join("inbox"));
        assert!(inbox.take().is_empty());
        inbox
            .post("item_a_1", "受注一覧は昨日の分だけでいい")
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(3));
        inbox.post("item_b_2", "CSV は Shift_JIS で").unwrap();
        assert_eq!(inbox.waiting(), ["item_a_1", "item_b_2"]);
        let taken = inbox.take();
        assert_eq!(
            taken,
            [
                InboxMessage {
                    id: "item_a_1".into(),
                    text: "受注一覧は昨日の分だけでいい".into()
                },
                InboxMessage {
                    id: "item_b_2".into(),
                    text: "CSV は Shift_JIS で".into()
                },
            ]
        );
        assert!(inbox.take().is_empty());
        assert!(inbox.waiting().is_empty());
    }

    #[test]
    fn an_id_cannot_leave_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let inbox = ChatInbox::new(dir.path());
        inbox.post("../../x-y", "hi").unwrap();
        assert_eq!(inbox.waiting(), ["xy"]);
    }
}

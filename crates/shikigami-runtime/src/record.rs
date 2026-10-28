//! Persistent run records.
//!
//! ```text
//! <workspace>/runs/<run-id>/events.jsonl   every event, in order (secrets masked)
//! <workspace>/runs/<run-id>/report.json    final report (written when the run ends)
//! ```
//!
//! These files are what `get_run_status`, `get_run_logs` and AI error
//! analysis read. SQLite indexing is planned for when listing many runs
//! becomes slow; the files stay the source of truth.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

use shikigami_core::RunId;

use crate::event::{RunEventEnvelope, RunReport};

pub struct RunRecorder {
    dir: PathBuf,
    events: BufWriter<File>,
}

impl RunRecorder {
    pub fn create(workspace: &Path, run_id: &RunId) -> std::io::Result<Self> {
        let dir = run_dir(workspace, run_id)?;
        fs::create_dir_all(&dir)?;
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("events.jsonl"))?;
        Ok(Self {
            dir,
            events: BufWriter::new(file),
        })
    }

    pub fn write_event(&mut self, event: &RunEventEnvelope) -> std::io::Result<()> {
        serde_json::to_writer(&mut self.events, event)?;
        self.events.write_all(b"\n")?;
        self.events.flush()
    }

    pub fn finish(mut self, report: &RunReport) -> std::io::Result<()> {
        self.events.flush()?;
        let bytes = serde_json::to_vec_pretty(report)?;
        fs::write(self.dir.join("report.json"), bytes)
    }
}

fn run_dir(workspace: &Path, run_id: &RunId) -> std::io::Result<PathBuf> {
    if !run_id.is_well_formed() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "invalid run id",
        ));
    }
    Ok(workspace.join("runs").join(run_id.as_str()))
}

pub fn read_report(workspace: &Path, run_id: &RunId) -> std::io::Result<Option<RunReport>> {
    let path = run_dir(workspace, run_id)?.join("report.json");
    match fs::read(&path) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn read_events(workspace: &Path, run_id: &RunId) -> std::io::Result<Vec<RunEventEnvelope>> {
    let path = run_dir(workspace, run_id)?.join("events.jsonl");
    let file = File::open(path)?;
    let mut out = Vec::new();
    for line in BufReader::new(file).lines() {
        let line = line?;
        if !line.trim().is_empty() {
            out.push(serde_json::from_str(&line)?);
        }
    }
    Ok(out)
}

/// Lists recorded runs, newest first (run IDs are time-ordered UUIDv7).
pub fn list_runs(workspace: &Path) -> std::io::Result<Vec<RunId>> {
    let dir = workspace.join("runs");
    let mut ids = match fs::read_dir(&dir) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .filter(|e| e.path().is_dir())
            .filter_map(|e| e.file_name().to_str().map(RunId::new))
            .collect::<Vec<_>>(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e),
    };
    ids.sort();
    ids.reverse();
    Ok(ids)
}

//! `process.list` and `process.kill`: the programs running on this PC, and
//! ending a program that hangs so the flow can start it again.

use serde_json::{Value, json};
use spellsheet_runtime::StepError;

/// One running program.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proc {
    pub pid: u32,
    pub name: String,
}

/// Whether `proc_name` is the program `wanted`: case does not matter and
/// `.exe` may be left out of either.
pub fn same_name(proc_name: &str, wanted: &str) -> bool {
    fn bare(name: &str) -> String {
        let name = name.trim().to_lowercase();
        name.strip_suffix(".exe")
            .map(str::to_string)
            .unwrap_or(name)
    }
    bare(proc_name) == bare(wanted)
}

/// Rows of `tasklist /FO CSV /NH`: `"name","pid","session","#","memory"`.
pub fn parse_tasklist(text: &str) -> Vec<Proc> {
    text.lines()
        .filter_map(|line| {
            let mut fields = csv_fields(line).into_iter();
            let name = fields.next()?;
            let pid = fields.next()?.parse().ok()?;
            Some(Proc { pid, name })
        })
        .collect()
}

fn csv_fields(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = line.trim().chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if quoted && chars.peek() == Some(&'"') => {
                field.push('"');
                chars.next();
            }
            '"' => quoted = !quoted,
            ',' if !quoted => fields.push(std::mem::take(&mut field)),
            c => field.push(c),
        }
    }
    fields.push(field);
    fields
}

/// Rows of `ps -eo pid=,comm=`.
pub fn parse_ps(text: &str) -> Vec<Proc> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            let (pid, name) = line.split_once(char::is_whitespace)?;
            Some(Proc {
                pid: pid.parse().ok()?,
                name: name.trim().to_string(),
            })
        })
        .collect()
}

fn output(program: &str, args: &[&str]) -> Result<String, StepError> {
    let mut command = std::process::Command::new(program);
    command.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let out = command
        .output()
        .map_err(|e| StepError::new("PROCESS_FAILED", format!("cannot run {program}: {e}")))?;
    Ok(
        spellsheet_files::encoding::decode(&out.stdout, "auto", program)
            .unwrap_or_else(|_| String::from_utf8_lossy(&out.stdout).into_owned()),
    )
}

/// Every running program but this one.
fn all() -> Result<Vec<Proc>, StepError> {
    let procs = if cfg!(windows) {
        parse_tasklist(&output("tasklist", &["/FO", "CSV", "/NH"])?)
    } else {
        parse_ps(&output("ps", &["-eo", "pid=,comm="])?)
    };
    let me = std::process::id();
    Ok(procs.into_iter().filter(|p| p.pid != me).collect())
}

fn name_param(params: &Value) -> Option<&str> {
    params
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|n| !n.is_empty())
}

pub fn list(params: &Value) -> Result<Value, StepError> {
    let wanted = name_param(params);
    let rows: Vec<Value> = all()?
        .into_iter()
        .filter(|p| wanted.is_none_or(|w| same_name(&p.name, w)))
        .map(|p| json!({ "pid": p.pid, "name": p.name }))
        .collect();
    Ok(Value::Array(rows))
}

pub fn kill(params: &Value) -> Result<Value, StepError> {
    let wanted = name_param(params)
        .ok_or_else(|| StepError::permanent("INVALID_PARAMS", "'name' is required"))?;
    let targets: Vec<Proc> = all()?
        .into_iter()
        .filter(|p| same_name(&p.name, wanted))
        .collect();
    let mut killed = 0;
    let mut failed = Vec::new();
    for p in &targets {
        let pid = p.pid.to_string();
        let status = if cfg!(windows) {
            std::process::Command::new("taskkill")
                .args(["/PID", &pid, "/T", "/F"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
        } else {
            std::process::Command::new("kill")
                .args(["-KILL", &pid])
                .stderr(std::process::Stdio::null())
                .status()
        };
        match status {
            Ok(s) if s.success() => killed += 1,
            // Gone already (a child ended with its parent's tree).
            _ if !all()?.iter().any(|q| q.pid == p.pid) => killed += 1,
            _ => failed.push(p.pid),
        }
    }
    if !failed.is_empty() {
        return Err(StepError::permanent(
            "PROCESS_KILL_FAILED",
            format!("cannot end {wanted} (pid {failed:?})"),
        )
        .with_details(json!({
            "pids": failed,
            "hint": "A program started by another user or as administrator can only be ended by SpellSheet running as that user or as administrator.",
        })));
    }
    Ok(json!({ "killed": killed }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_match_without_case_or_exe() {
        assert!(same_name("EXCEL.EXE", "excel"));
        assert!(same_name("excel", "Excel.exe"));
        assert!(!same_name("excelx.exe", "excel"));
    }

    #[test]
    fn reads_tasklist_rows() {
        let text = "\"System Idle Process\",\"0\",\"Services\",\"0\",\"8 K\"\r\n\"EXCEL.EXE\",\"4120\",\"Console\",\"1\",\"120,344 K\"\r\n\"販売, \"\"管理\"\".exe\",\"77\",\"Console\",\"1\",\"1 K\"\r\n";
        assert_eq!(
            parse_tasklist(text),
            vec![
                Proc {
                    pid: 0,
                    name: "System Idle Process".into()
                },
                Proc {
                    pid: 4120,
                    name: "EXCEL.EXE".into()
                },
                Proc {
                    pid: 77,
                    name: "販売, \"管理\".exe".into()
                },
            ]
        );
    }

    #[test]
    fn reads_ps_rows() {
        assert_eq!(
            parse_ps("    1 init\n 4242 sleep\n"),
            vec![
                Proc {
                    pid: 1,
                    name: "init".into()
                },
                Proc {
                    pid: 4242,
                    name: "sleep".into()
                }
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn ends_a_running_program_by_name() {
        // A copy under its own name, so other tests' `sleep`s live on.
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("sgsleeper");
        std::fs::copy("/bin/sleep", &program).unwrap();
        let mut child = std::process::Command::new(&program)
            .arg("300")
            .spawn()
            .unwrap();
        let listed = list(&json!({ "name": "sgsleeper" })).unwrap();
        assert!(
            listed
                .as_array()
                .unwrap()
                .iter()
                .any(|p| p["pid"] == child.id())
        );
        let out = kill(&json!({ "name": "SGSLEEPER.exe" })).unwrap();
        assert!(out["killed"].as_u64().unwrap() >= 1);
        let status = child.wait().unwrap();
        assert!(!status.success());
        assert_eq!(
            kill(&json!({ "name": "no-such-program-xyz" })).unwrap(),
            json!({ "killed": 0 })
        );
    }
}

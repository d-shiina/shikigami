//! `process.run`: runs a program, waits for it and returns its output.

use std::process::Stdio;

use serde_json::{Value, json};
use shikigami_runtime::{ActionInput, StepError};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Most output kept from each of stdout and stderr.
const MAX_OUTPUT: usize = 10 * 1024 * 1024;
/// Output quoted in error details.
const DETAIL_CHARS: usize = 2000;

fn tail(text: &str) -> String {
    let count = text.chars().count();
    text.chars()
        .skip(count.saturating_sub(DETAIL_CHARS))
        .collect()
}

async fn read_all(stream: Option<impl tokio::io::AsyncRead + Unpin>) -> Vec<u8> {
    let mut out = Vec::new();
    if let Some(stream) = stream {
        let _ = stream.take(MAX_OUTPUT as u64).read_to_end(&mut out).await;
    }
    out
}

pub async fn run(input: &ActionInput) -> Result<Value, StepError> {
    let params = &input.params;
    let program = params
        .get("program")
        .and_then(Value::as_str)
        .filter(|p| !p.trim().is_empty())
        .ok_or_else(|| StepError::permanent("INVALID_PARAMS", "'program' is required"))?;
    let args: Vec<String> = params
        .get("args")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(shikigami_core::expr::to_display).collect())
        .unwrap_or_default();
    let encoding = params
        .get("encoding")
        .and_then(Value::as_str)
        .unwrap_or("auto");
    let ok_codes: Vec<i64> = params
        .get("okExitCodes")
        .and_then(Value::as_array)
        .map(|c| c.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_else(|| vec![0]);

    let mut command = tokio::process::Command::new(program);
    command
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        // No console window flashing up for command-line tools.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    if let Some(cwd) = params.get("cwd").and_then(Value::as_str) {
        command.current_dir(cwd);
    }
    if let Some(env) = params.get("env").and_then(Value::as_object) {
        for (key, value) in env {
            command.env(key, shikigami_core::expr::to_display(value));
        }
    }
    let mut child = command.spawn().map_err(|e| {
        let code = if e.kind() == std::io::ErrorKind::NotFound {
            "PROCESS_NOT_FOUND"
        } else {
            "PROCESS_START_FAILED"
        };
        StepError::permanent(code, format!("cannot start {program}: {e}")).with_details(json!({
            "program": program,
            "hint": "Give the full path of the program (e.g. C:\\Tools\\export.exe), or run a command through cmd: program \"cmd\", args [\"/c\", \"...\"].",
        }))
    })?;
    if let Some(mut stdin) = child.stdin.take() {
        if let Some(text) = params.get("stdin").filter(|v| !v.is_null()) {
            let _ = stdin
                .write_all(shikigami_core::expr::to_display(text).as_bytes())
                .await;
        }
        drop(stdin);
    }
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (out, err, status) = tokio::join!(read_all(stdout), read_all(stderr), child.wait());
    let status = status.map_err(|e| StepError::new("PROCESS_FAILED", e.to_string()))?;
    let decode = |bytes: &[u8]| {
        shikigami_files::encoding::decode(bytes, encoding, program)
            .unwrap_or_else(|_| String::from_utf8_lossy(bytes).into_owned())
    };
    let stdout = decode(&out);
    let stderr = decode(&err);
    let exit_code = status.code().map_or(-1, i64::from);
    if !ok_codes.contains(&exit_code) {
        return Err(StepError::permanent(
            "PROCESS_FAILED",
            format!("{program} exited with code {exit_code}"),
        )
        .with_details(json!({
            "exitCode": exit_code,
            "stderr": tail(&stderr),
            "stdout": tail(&stdout),
            "hint": "If this exit code means success for this program, list it in okExitCodes (e.g. robocopy: [0, 1, 2, 3]).",
        })));
    }
    Ok(json!({ "exitCode": exit_code, "stdout": stdout, "stderr": stderr }))
}

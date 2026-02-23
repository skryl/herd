use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

const THREAD_LIST_LIMIT: usize = 1;
const CODEX_SOURCE_KINDS: &[&str] = &["cli", "vscode", "exec", "appServer"];

#[derive(Debug)]
pub(super) struct CodexAppServerClient {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
    initialized: bool,
}

impl CodexAppServerClient {
    pub(super) fn start() -> Result<Self, String> {
        let mut child = Command::new("codex")
            .args(["app-server", "--listen", "stdio://"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|err| format!("failed to start codex app-server: {err}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "codex app-server stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "codex app-server stdout unavailable".to_string())?;
        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
            initialized: false,
        })
    }

    pub(super) fn ensure_initialized(&mut self) -> Result<(), String> {
        if self.initialized {
            return Ok(());
        }
        let params = json!({
            "clientInfo": {
                "name": "herd",
                "version": env!("CARGO_PKG_VERSION")
            },
            "capabilities": {
                "experimentalApi": true
            }
        });
        let _ = self.request("initialize", params)?;
        self.initialized = true;
        Ok(())
    }

    pub(super) fn thread_list_latest_for_cwd(
        &mut self,
        cwd: &str,
    ) -> Result<Option<CodexThreadSummary>, String> {
        let params = json!({
            "archived": false,
            "limit": THREAD_LIST_LIMIT,
            "sortKey": "updated_at",
            "sourceKinds": CODEX_SOURCE_KINDS,
            "cwd": cwd
        });
        let response: CodexThreadListResponse =
            serde_json::from_value(self.request("thread/list", params)?)
                .map_err(|err| format!("invalid codex thread/list response: {err}"))?;
        Ok(response.data.into_iter().next())
    }

    pub(super) fn thread_read(&mut self, thread_id: &str) -> Result<CodexThread, String> {
        let params = json!({
            "threadId": thread_id,
            "includeTurns": true
        });
        let response: CodexThreadReadResponse =
            serde_json::from_value(self.request("thread/read", params)?)
                .map_err(|err| format!("invalid codex thread/read response: {err}"))?;
        Ok(response.thread)
    }

    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);

        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });
        writeln!(self.stdin, "{payload}")
            .map_err(|err| format!("failed writing app-server request {method}: {err}"))?;
        self.stdin
            .flush()
            .map_err(|err| format!("failed flushing app-server request {method}: {err}"))?;

        let mut line = String::new();
        loop {
            line.clear();
            let read = self
                .stdout
                .read_line(&mut line)
                .map_err(|err| format!("failed reading app-server response {method}: {err}"))?;
            if read == 0 {
                return Err(format!(
                    "codex app-server closed while waiting for response to {method}"
                ));
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            let Some(object) = value.as_object() else {
                continue;
            };
            if !id_matches(object.get("id"), id) {
                continue;
            }
            if let Some(err) = object.get("error") {
                return Err(format!("app-server {method} error: {err}"));
            }
            return object
                .get("result")
                .cloned()
                .ok_or_else(|| format!("app-server {method} response missing result"));
        }
    }
}

impl Drop for CodexAppServerClient {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn id_matches(value: Option<&Value>, expected: u64) -> bool {
    match value {
        Some(Value::Number(number)) => number.as_u64() == Some(expected),
        Some(Value::String(text)) => text == &expected.to_string(),
        _ => false,
    }
}

#[derive(Clone, Debug, Deserialize)]
pub(super) struct CodexThreadSummary {
    pub(super) id: String,
    #[serde(rename = "updatedAt", default)]
    pub(super) updated_at: i64,
}

#[derive(Clone, Debug, Deserialize)]
struct CodexThreadListResponse {
    #[serde(default)]
    data: Vec<CodexThreadSummary>,
}

#[derive(Clone, Debug, Deserialize)]
struct CodexThreadReadResponse {
    thread: CodexThread,
}

#[derive(Clone, Debug, Deserialize)]
pub(super) struct CodexThread {
    pub(super) id: String,
    #[serde(rename = "updatedAt", default)]
    pub(super) updated_at: i64,
    #[serde(default)]
    pub(super) turns: Vec<CodexTurn>,
}

#[derive(Clone, Debug, Deserialize)]
pub(super) struct CodexTurn {
    pub(super) status: String,
}

#[cfg(test)]
mod tests {
    use super::{CodexThread, CodexThreadListResponse};

    #[test]
    fn thread_response_shapes_deserialize() {
        let list: CodexThreadListResponse =
            serde_json::from_str(r#"{"data":[{"id":"a","updatedAt":123}]}"#)
                .expect("list should parse");
        assert_eq!(list.data.len(), 1);
        assert_eq!(list.data[0].updated_at, 123);

        let thread: CodexThread =
            serde_json::from_str(r#"{"id":"a","updatedAt":124,"turns":[{"status":"inProgress"}]}"#)
                .expect("thread should parse");
        assert_eq!(thread.turns.len(), 1);
        assert_eq!(thread.updated_at, 124);
    }
}

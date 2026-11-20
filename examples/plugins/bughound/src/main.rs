//! An optional pi-studio plugin: a background worker that watches a workspace folder for file changes
//! and, when a file a test covers changes, immediately runs the targeted pytest for it.
//!
//! The daemon starts this program, speaks to it over its own pipes, and stops it when the daemon goes.
//! The words are one JSON object per line, LF at the end, in both directions: the line protocol every
//! language can write without a library. The daemon calls `initialize` first, and the plugin calls back
//! for what it needs.
//!
//! What it does: it asks the daemon which workspaces it knows (`workspace.list` hands back each one's
//! folder, which is the only way this plugin learns one), polls those folders for changes with pruned
//! recursive metadata snapshots, resolves each changed file to the test files covering it by scanning
//! Python imports, and runs `pytest` on just those. A panel asks it how the watch is going through the
//! daemon's fixed method `visual.request`, which this plugin answers from shared state rather than by
//! doing work: the watcher and the test runner are background threads, so a request is answered in
//! microseconds even while a run is in flight.
//!
//! Configuration arrives as registration `args`, the only way a plugin is told anything: `--interval-ms`
//! (default 2000), `--debounce-ms` (default 500), `--timeout-s` (default 60), `--workspace` (repeatable,
//! an id, a name or a folder; the default watches every non-scratch workspace), `--pytest` (the program
//! to run; otherwise `.venv/bin/pytest`, a venv's `python -m pytest`, or `pytest` on PATH),
//! `--pytest-arg` (repeatable fixed flags), and `--post-failures` (off by default; when set, a run that
//! turns failing or passing again revises one card per workspace).
//!
//! The methods a daemon answers are documented at the top of `server/plugins/service.ts`.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

/// What both ends say in `initialize`. A daemon that answers another number is one this plugin cannot
/// speak to.
const PROTOCOL_VERSION: i64 = 1;

/// What this plugin calls itself, in the handshake and in the daemon's log.
const PLUGIN_NAME: &str = "bughound";
const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The codes a refusal carries, as the daemon's `protocol.ts` spells them.
const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;

/// How far the test search walks from a changed file through the import graph before it gives up.
const MAX_HOPS: usize = 16;
/// The most a run's output keeps in memory, first and last together. More than that is truncated.
const OUTPUT_CAP: usize = 64 * 1024;

// ---------- the wire ----------

/// A refusal on the wire: the code a caller can act on, and the reason in words.
#[derive(Debug)]
struct RpcError {
    code: i64,
    message: String,
}

impl RpcError {
    fn new(code: i64, message: &str) -> Self {
        Self {
            code,
            message: message.to_string(),
        }
    }
}

/// One frame, read as the kind of frame it is. This is the daemon's `parseMessage` seen from the plugin
/// side, down to the wording of its refusals.
#[derive(Debug)]
enum Incoming {
    /// A call of the daemon's, which wants an answer.
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    /// Something the daemon said with no answer wanted: `shutdown`, or an `event`.
    Notification { method: String, params: Value },
    /// The answer to a call this plugin made.
    Response {
        id: Value,
        result: Result<Value, RpcError>,
    },
    /// A frame that could not be read, with the id it named when it named one.
    Invalid { id: Option<Value>, error: RpcError },
}

fn classify(line: &str) -> Incoming {
    let invalid = |id: Option<Value>, message: &str| Incoming::Invalid {
        id,
        error: RpcError::new(INVALID_REQUEST, message),
    };
    let bag: Value = match serde_json::from_str(line) {
        Ok(bag) => bag,
        Err(_) => {
            return Incoming::Invalid {
                id: None,
                error: RpcError::new(PARSE_ERROR, "the frame is not JSON"),
            }
        }
    };
    let Some(frame) = bag.as_object() else {
        return invalid(None, "a frame must be one JSON object");
    };
    if frame.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return invalid(None, "every frame must say \"jsonrpc\": \"2.0\"");
    }
    let id = match frame.get("id") {
        Some(value) if value.is_string() || value.is_number() => Some(value.clone()),
        Some(_) => return invalid(None, "an id must be a string or a number"),
        None => None,
    };
    let params = frame.get("params").cloned().unwrap_or(Value::Null);
    if let Some(method) = frame
        .get("method")
        .and_then(Value::as_str)
        .filter(|method| !method.trim().is_empty())
    {
        return match id {
            Some(id) => Incoming::Request {
                id,
                method: method.to_string(),
                params,
            },
            None => Incoming::Notification {
                method: method.to_string(),
                params,
            },
        };
    }
    let Some(id) = id else {
        return invalid(None, "a frame is a request, a response or a notification");
    };
    if let Some(error) = frame.get("error") {
        return Incoming::Response {
            id,
            result: Err(error_of(error)),
        };
    }
    if let Some(result) = frame.get("result") {
        return Incoming::Response {
            id,
            result: Ok(result.clone()),
        };
    }
    invalid(Some(id), "a response carries a result or an error")
}

/// A refusal as the three things a caller can act on, whatever the daemon actually wrote.
fn error_of(value: &Value) -> RpcError {
    let Some(error) = value.as_object() else {
        return RpcError::new(-32603, "the daemon answered an error that is not an object");
    };
    let code = error.get("code").and_then(Value::as_i64).unwrap_or(-32603);
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("the daemon answered an error with no message");
    RpcError::new(code, message)
}

/// What this plugin says and hears. One message out, one line in: the framing belongs to the writing
/// half, so a test drives the plugin without a pipe.
trait Transport {
    fn write(&mut self, message: Value) -> io::Result<()>;
    /// One line from the daemon, or `None` when its input is closed. Unparsed, so this plugin can
    /// answer a line it cannot read the way the protocol says to.
    fn read_line(&mut self) -> io::Result<Option<String>>;
    /// One line if it arrives within `timeout`, `Some(None)` on a closed input, and `None` on a
    /// timeout — the main loop drains cards the runner queued between lines, so it cannot wait
    /// forever for a line that may never come.
    fn read_line_timeout(&mut self, _timeout: Duration) -> io::Result<Option<Option<String>>> {
        Ok(Some(self.read_line()?))
    }
}

/// The real pipes: stdout carries frames and nothing else, so a diagnosis goes to stderr where the
/// daemon keeps it. Stdin is read on its own thread into a channel, because a blocking read on the
/// main thread would hold cards the runner queued until the daemon next spoke.
struct StdioTransport {
    stdin: std::sync::mpsc::Receiver<Option<String>>,
}

impl StdioTransport {
    fn new() -> Self {
        let (sender, stdin) = std::sync::mpsc::channel::<Option<String>>();
        std::thread::spawn(move || {
            let mut input = io::stdin().lock();
            loop {
                let mut line = String::new();
                match input.read_line(&mut line) {
                    Ok(0) => {
                        let _ = sender.send(None);
                        return;
                    }
                    Ok(_) => {
                        let line = line.strip_suffix('\n').unwrap_or(&line);
                        let line = line.strip_suffix('\r').unwrap_or(line);
                        if sender.send(Some(line.to_string())).is_err() {
                            return;
                        }
                    }
                    Err(_) => {
                        let _ = sender.send(None);
                        return;
                    }
                }
            }
        });
        Self { stdin }
    }
}

impl Transport for StdioTransport {
    fn write(&mut self, message: Value) -> io::Result<()> {
        let mut stdout = io::stdout().lock();
        let mut line = serde_json::to_string(&message).map_err(io::Error::other)?;
        line.push('\n');
        stdout.write_all(line.as_bytes())?;
        stdout.flush()
    }

    fn read_line(&mut self) -> io::Result<Option<String>> {
        Ok(self.stdin.recv().unwrap_or(None))
    }

    fn read_line_timeout(&mut self, timeout: Duration) -> io::Result<Option<Option<String>>> {
        match self.stdin.recv_timeout(timeout) {
            Ok(line) => Ok(Some(line)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Ok(None),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Ok(Some(None)),
        }
    }
}

// ---------- the plugin ----------

/// This plugin: the pipe it speaks on, the id of the next call it makes, and what it has been told.
/// The watcher and the runner are threads of their own, so a frame the daemon sends is never held up
/// behind a test run: this thread answers `visual.request` from shared state and nothing else.
struct Bughound<T: Transport> {
    transport: T,
    next_id: i64,
    stashed: HashMap<String, Result<Value, RpcError>>,
    settings_path: PathBuf,
    shared: Arc<(Mutex<Shared>, Condvar)>,
    /// Set once the daemon said `shutdown`, or told this plugin something it cannot answer.
    stopping: bool,
}

impl<T: Transport> Bughound<T> {
    fn new(transport: T, config: Config, settings_path: PathBuf) -> Self {
        Self {
            transport,
            next_id: 1,
            stashed: HashMap::new(),
            settings_path,
            shared: Arc::new((Mutex::new(Shared::new(config)), Condvar::new())),
            stopping: false,
        }
    }

    fn run(&mut self) -> io::Result<()> {
        self.handshake()?;
        if self.stopping {
            return Ok(());
        }
        self.learn_workspaces()?;
        self.subscribe()?;
        let coordinator = self.spawn_coordinator();
        let runner = self.spawn_runner();
        while !self.stopping {
            self.drain_notes()?;
            if self.stopping {
                break;
            }
            let Some(maybe_line) = self.transport.read_line_timeout(Duration::from_millis(50))? else {
                continue;
            };
            let Some(line) = maybe_line else {
                break;
            };
            if line.trim().is_empty() {
                continue;
            }
            self.handle(classify(&line))?;
        }
        // The daemon is going away: tell the threads, and give the runner its moment to kill a run.
        stop(&self.shared);
        let _ = coordinator.join();
        let _ = runner.join();
        Ok(())
    }

    /// Wait for the call the daemon makes first and answer it.
    fn handshake(&mut self) -> io::Result<()> {
        while !self.stopping {
            let Some(line) = self.next_line()? else {
                self.stopping = true;
                break;
            };
            let Incoming::Request { id, method, params } = classify(&line) else {
                continue;
            };
            if method != "initialize" {
                let message = format!("the first call must be initialize, not {method}");
                self.refuse(Some(id), RpcError::new(INVALID_REQUEST, &message))?;
                continue;
            }
            self.answer(id, &method, params)?;
            return Ok(());
        }
        Ok(())
    }

    /// Ask for the one event this plugin reads, so a settled run on a board is a reason to rescan it.
    fn subscribe(&mut self) -> io::Result<()> {
        self.call("events.subscribe", json!({ "types": ["thread.settled"] }))?;
        Ok(())
    }

    /// Ask which workspaces the daemon knows, and watch the ones the configuration allows.
    fn learn_workspaces(&mut self) -> io::Result<()> {
        if let Some(list) = self.call("workspace.list", json!({}))? {
            apply_workspace_list(&self.shared, &list);
        }
        Ok(())
    }

    fn spawn_coordinator(&self) -> std::thread::JoinHandle<()> {
        let shared = Arc::clone(&self.shared);
        std::thread::spawn(move || coordinator(shared))
    }

    fn spawn_runner(&self) -> std::thread::JoinHandle<()> {
        let shared = Arc::clone(&self.shared);
        std::thread::spawn(move || runner(shared))
    }

    /// One message that is not the answer a caller is waiting for, or that answer handed back to it.
    fn handle(
        &mut self,
        incoming: Incoming,
    ) -> io::Result<Option<(Value, Result<Value, RpcError>)>> {
        match incoming {
            Incoming::Request { id, method, params } => {
                self.answer(id, &method, params)?;
                Ok(None)
            }
            Incoming::Notification { method, params } => {
                self.absorb(&method, params);
                Ok(None)
            }
            Incoming::Response { id, result } => Ok(Some((id, result))),
            Incoming::Invalid { id, error } => {
                self.refuse(id, error)?;
                Ok(None)
            }
        }
    }

    /// Something the daemon said with no answer wanted.
    fn absorb(&mut self, method: &str, params: Value) {
        match method {
            "shutdown" => {
                self.stopping = true;
                stop(&self.shared);
            }
            "event" => {
                // A run that ended may have edited the folder, so the coordinator rescans at once
                // rather than at its next interval.
                if params.get("type").and_then(Value::as_str) == Some("thread.settled") {
                    wake(&self.shared);
                }
            }
            other => {
                eprintln!("bughound: the daemon said {other}, which this plugin does not read")
            }
        }
    }

    /// Answer one call of the daemon's. `initialize` is the only method this plugin has to answer for
    /// itself; `visual.request` is what its panel asks through the board.
    fn answer(&mut self, id: Value, method: &str, params: Value) -> io::Result<()> {
        match method {
            "initialize" => match initialize_answer(&params) {
                Ok(answer) => self.send(json!({ "jsonrpc": "2.0", "id": id, "result": answer })),
                Err(error) => {
                    self.stopping = true;
                    self.refuse(Some(id), error)
                }
            },
            "visual.request" => match self.handle_visual(&params) {
                Ok(answer) => self.send(json!({ "jsonrpc": "2.0", "id": id, "result": answer })),
                Err(error) => self.refuse(Some(id), error),
            },
            other => {
                let message =
                    format!("{other} is not a method this plugin answers; it answers initialize");
                self.refuse(Some(id), RpcError::new(METHOD_NOT_FOUND, &message))
            }
        }
    }

    /// A call this plugin makes. `None` is an answer the daemon refused, which is said on stderr and
    /// left for the caller to do without. An answer to a call made while this one was waiting is kept
    /// rather than dropped, so a nested call cannot swallow it.
    fn call(&mut self, method: &str, params: Value) -> io::Result<Option<Value>> {
        let id = json!(self.next_id);
        self.next_id += 1;
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))?;
        loop {
            if let Some(result) = self.stashed.remove(&id.to_string()) {
                return match result {
                    Ok(value) => Ok(Some(value)),
                    Err(error) => {
                        eprintln!(
                            "bughound: the daemon refused {method}: {} (code {})",
                            error.message, error.code
                        );
                        Ok(None)
                    }
                };
            }
            let Some(line) = self.next_line()? else {
                eprintln!("bughound: the daemon closed its input while answering {method}");
                self.stopping = true;
                return Ok(None);
            };
            let Some((answer_id, result)) = self.handle(classify(&line))? else {
                continue;
            };
            if answer_id != id {
                self.stashed.insert(answer_id.to_string(), result);
                continue;
            }
            return match result {
                Ok(value) => Ok(Some(value)),
                Err(error) => {
                    eprintln!(
                        "bughound: the daemon refused {method}: {} (code {})",
                        error.message, error.code
                    );
                    Ok(None)
                }
            };
        }
    }

    /// Cards the runner queued while this thread was answering something else, written in order.
    fn drain_notes(&mut self) -> io::Result<()> {
        let pending: Vec<Value> = {
            let (lock, _) = &*self.shared;
            let mut shared = lock.lock().unwrap();
            shared.notes.drain(..).collect()
        };
        for params in pending {
            self.call("cards.note", params)?;
        }
        Ok(())
    }

    /// What a panel asks, in the plugin's own words, or why the plugin does not answer it.
    fn handle_visual(&mut self, params: &Value) -> Result<Value, RpcError> {
        let method = params.get("method").and_then(Value::as_str).unwrap_or("");
        let inner = params.get("params").cloned().unwrap_or(Value::Null);
        let workspace = params.get("workspace").and_then(Value::as_str).unwrap_or("");
        // A workspace asked for that this plugin does not know may have opened after it started, so
        // ask the daemon again before answering without it.
        if !workspace.is_empty() && !knows(&self.shared, workspace) {
            if let Some(list) = self.call("workspace.list", json!({})).unwrap_or(None) {
                apply_workspace_list(&self.shared, &list);
            }
        }
        match method {
            "state" => Ok(state_snapshot(&self.shared, workspace)),
            "log" => {
                let workspace = inner
                    .get("workspace")
                    .and_then(Value::as_str)
                    .unwrap_or(workspace);
                Ok(json!({ "text": last_output(&self.shared, workspace) }))
            }
            "toggle_pause" => {
                let (lock, _) = &*self.shared;
                let mut shared = lock.lock().unwrap();
                shared.paused = !shared.paused;
                let paused = shared.paused;
                drop(shared);
                wake(&self.shared);
                Ok(json!({ "paused": paused }))
            }
            "run" => {
                let scope = inner.get("scope").and_then(Value::as_str).unwrap_or("all");
                let workspace = inner
                    .get("workspace")
                    .and_then(Value::as_str)
                    .unwrap_or(workspace);
                Ok(queue_manual_run(&self.shared, scope, workspace))
            }
            "set_config" => self.set_config(&inner),
            other => Err(RpcError::new(
                METHOD_NOT_FOUND,
                &format!("{other} is not something this panel asks for; it asks for state, log, toggle_pause and run"),
            )),
        }
    }

    /// The panel's own settings page, the git graph's in miniature: the watch timings it edits are
    /// written to this plugin's own state file, so they survive the daemon and the plugin together.
    /// Registration args still win over the file on the next start.
    fn set_config(&mut self, inner: &Value) -> Result<Value, RpcError> {
        let interval = inner.get("intervalMs").and_then(Value::as_u64);
        let debounce = inner.get("debounceMs").and_then(Value::as_u64);
        let timeout = inner.get("timeoutS").and_then(Value::as_u64);
        if interval.is_none() && debounce.is_none() && timeout.is_none() {
            return Err(RpcError::new(INVALID_PARAMS, "set_config asks for intervalMs, debounceMs or timeoutS"));
        }
        let (lock, _) = &*self.shared;
        let mut shared = lock.lock().unwrap();
        if let Some(value) = interval {
            shared.config.interval_ms = value.max(250);
        }
        if let Some(value) = debounce {
            shared.config.debounce_ms = value;
        }
        if let Some(value) = timeout {
            shared.config.timeout_s = value.max(1);
        }
        let saved = Settings {
            interval_ms: Some(shared.config.interval_ms),
            debounce_ms: Some(shared.config.debounce_ms),
            timeout_s: Some(shared.config.timeout_s),
        };
        if let Err(error) = saved.write(&self.settings_path) {
            eprintln!("bughound: the settings could not be written: {error}");
            return Err(RpcError::new(-32603, "the settings could not be written"));
        }
        drop(shared);
        wake(&self.shared);
        Ok(json!({ "ok": true, "settings": settings_view(&self.shared) }))
    }

    fn send(&mut self, message: Value) -> io::Result<()> {
        self.transport.write(message)
    }

    fn refuse(&mut self, id: Option<Value>, error: RpcError) -> io::Result<()> {
        self.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": error.code, "message": error.message },
        }))
    }

    /// One line the plugin has to read, skipping the blank ones a chatty tool leaves behind.
    fn next_line(&mut self) -> io::Result<Option<String>> {
        loop {
            match self.transport.read_line()? {
                None => return Ok(None),
                Some(line) if line.trim().is_empty() => continue,
                Some(line) => return Ok(Some(line)),
            }
        }
    }
}

// ---------- what the plugin reads and writes ----------

/// What this plugin says about itself, or why the daemon at the other end is one it cannot speak to.
fn initialize_answer(params: &Value) -> Result<Value, RpcError> {
    if params.get("protocolVersion").and_then(Value::as_i64) != Some(PROTOCOL_VERSION) {
        return Err(RpcError::new(
            INVALID_PARAMS,
            &format!("this plugin speaks protocol {PROTOCOL_VERSION}"),
        ));
    }
    Ok(json!({
        "protocolVersion": PROTOCOL_VERSION,
        "name": PLUGIN_NAME,
        "version": PLUGIN_VERSION,
    }))
}

/// Which workspaces this plugin watches, merged from the daemon's own list. Scratch and missing
/// workspaces are always skipped: they are not folders a human edits. A `--workspace` allowlist narrows
/// further, matching ids, names and folders as they are spelled.
fn apply_workspace_list(shared: &Arc<(Mutex<Shared>, Condvar)>, list: &Value) {
    let Some(rows) = list.get("workspaces").and_then(Value::as_array) else {
        return;
    };
    let (lock, _) = &**shared;
    let mut shared = lock.lock().unwrap();
    let allow = shared.config.workspaces.clone();
    for row in rows {
        let Some(id) = row.get("id").and_then(Value::as_str) else {
            continue;
        };
        if shared.workspaces.contains_key(id) {
            continue;
        }
        let name = row
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(id)
            .to_string();
        let folder = row
            .get("folder")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let scratch = row.get("scratch").and_then(Value::as_bool) == Some(true);
        let missing = row.get("missing").and_then(Value::as_bool) == Some(true);
        let allowed = allow.is_empty()
            || allow
                .iter()
                .any(|one| one == id || one == &name || one == &folder);
        let watched = !scratch && !missing && !folder.is_empty() && allowed;
        shared.workspaces.insert(
            id.to_string(),
            WorkspaceTracker::new(id, name, PathBuf::from(folder), watched),
        );
    }
}

fn knows(shared: &Arc<(Mutex<Shared>, Condvar)>, workspace: &str) -> bool {
    let (lock, _) = &**shared;
    lock.lock().unwrap().workspaces.contains_key(workspace)
}

// ---------- configuration ----------

#[derive(Clone, Debug, Default)]
struct Config {
    interval_ms: u64,
    debounce_ms: u64,
    timeout_s: u64,
    workspaces: Vec<String>,
    pytest: Option<String>,
    pytest_args: Vec<String>,
    post_failures: bool,
}

impl Config {
    fn with_defaults() -> Self {
        Self {
            interval_ms: 2000,
            debounce_ms: 500,
            timeout_s: 60,
            ..Config::default()
        }
    }
}

/// What the registration said, before what the panel saved adds to it: the three timings as options,
/// so a file the panel wrote and an arg the registration gave can be told apart.
#[derive(Clone, Debug, Default)]
struct Given {
    interval_ms: Option<u64>,
    debounce_ms: Option<u64>,
    timeout_s: Option<u64>,
    workspaces: Vec<String>,
    pytest: Option<String>,
    pytest_args: Vec<String>,
    post_failures: bool,
    settings_path: Option<String>,
}

/// The timings the panel's settings page last wrote, if it wrote any.
#[derive(Clone, Debug, Default)]
struct Settings {
    interval_ms: Option<u64>,
    debounce_ms: Option<u64>,
    timeout_s: Option<u64>,
}

impl Settings {
    fn read(path: &Path) -> Settings {
        let Ok(text) = std::fs::read_to_string(path) else {
            return Settings::default();
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            return Settings::default();
        };
        Settings {
            interval_ms: value.get("intervalMs").and_then(Value::as_u64),
            debounce_ms: value.get("debounceMs").and_then(Value::as_u64),
            timeout_s: value.get("timeoutS").and_then(Value::as_u64),
        }
    }

    fn write(&self, path: &Path) -> Result<(), io::Error> {
        if let Some(folder) = path.parent() {
            std::fs::create_dir_all(folder)?;
        }
        let text = json!({
            "intervalMs": self.interval_ms,
            "debounceMs": self.debounce_ms,
            "timeoutS": self.timeout_s,
        });
        std::fs::write(path, format!("{}\n", text))
    }
}

/// Where the settings file lives: the daemon's own state folder, unless `--settings` said elsewhere.
fn default_settings_path() -> PathBuf {
    if let Some(folder) = std::env::var_os("XDG_STATE_HOME") {
        return PathBuf::from(folder).join("pi-studio").join("bughound.json");
    }
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home).join(".local").join("state").join("pi-studio").join("bughound.json");
    }
    std::env::temp_dir().join("bughound.json")
}

/// Registration `args` as configuration, or why one of them cannot be used. An unknown flag is an
/// error rather than a guess: the daemon reports it beside the plugins that did start.
#[allow(dead_code)]
fn parse_args(args: &[String]) -> Result<Config, String> {
    resolve(parse_given(args)?, None)
}

fn parse_given(args: &[String]) -> Result<Given, String> {
    let mut given = Given::default();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) => (flag, Some(value.to_string())),
            None => (arg.as_str(), None),
        };
        let value = |i: &mut usize| -> Result<String, String> {
            if let Some(value) = &inline {
                return Ok(value.clone());
            }
            *i += 1;
            args.get(*i).cloned().ok_or_else(|| format!("{flag} needs a value"))
        };
        match flag {
            "--interval-ms" => {
                given.interval_ms = Some(parse_u64(&value(&mut i)?, flag)?);
            }
            "--debounce-ms" => {
                given.debounce_ms = Some(parse_u64(&value(&mut i)?, flag)?);
            }
            "--timeout-s" => {
                given.timeout_s = Some(parse_u64(&value(&mut i)?, flag)?);
            }
            "--workspace" => {
                given.workspaces.push(value(&mut i)?);
            }
            "--pytest" => {
                given.pytest = Some(value(&mut i)?);
            }
            "--pytest-arg" => {
                given.pytest_args.push(value(&mut i)?);
            }
            "--settings" => {
                given.settings_path = Some(value(&mut i)?);
            }
            "--post-failures" => given.post_failures = true,
            _ => return Err(format!("unknown argument {flag}")),
        }
        i += 1;
    }
    Ok(given)
}

/// Defaults, then what the panel saved, then what the registration said: the last word wins.
fn resolve(given: Given, saved: Option<Settings>) -> Result<Config, String> {
    let mut config = Config::with_defaults();
    if let Some(saved) = saved {
        if let Some(value) = saved.interval_ms {
            config.interval_ms = value;
        }
        if let Some(value) = saved.debounce_ms {
            config.debounce_ms = value;
        }
        if let Some(value) = saved.timeout_s {
            config.timeout_s = value;
        }
    }
    if let Some(value) = given.interval_ms {
        config.interval_ms = value;
    }
    if let Some(value) = given.debounce_ms {
        config.debounce_ms = value;
    }
    if let Some(value) = given.timeout_s {
        config.timeout_s = value;
    }
    config.workspaces = given.workspaces;
    config.pytest = given.pytest;
    config.pytest_args = given.pytest_args;
    config.post_failures = given.post_failures;
    if config.interval_ms < 250 {
        config.interval_ms = 250;
    }
    Ok(config)
}

fn parse_u64(text: &str, flag: &str) -> Result<u64, String> {
    text.parse::<u64>()
        .map_err(|_| format!("{flag} is not a number"))
}

// ---------- the shared watch state ----------

#[derive(Clone, Debug)]
struct Failure {
    nodeid: String,
    summary: String,
}

#[derive(Clone, Debug)]
struct LastRun {
    at: u64,
    status: String,
    summary: String,
    duration_ms: u64,
    targets: Vec<String>,
    failures: Vec<Failure>,
}

struct RunningView {
    targets: Vec<String>,
    started_at: u64,
}

/// One workspace under watch: its folder, its snapshot, and what the last change and the last run said.
struct WorkspaceTracker {
    id: String,
    name: String,
    folder: PathBuf,
    watched: bool,
    initialized: bool,
    snapshot: HashMap<PathBuf, (u64, u64, u64)>,
    pending: BTreeSet<PathBuf>,
    last_change: Option<Instant>,
    last_change_at: u64,
    phase: String,
    message: String,
    running: Option<RunningView>,
    last_run: Option<LastRun>,
    last_scan_at: Option<u64>,
    last_output: String,
}

impl WorkspaceTracker {
    fn new(id: &str, name: String, folder: PathBuf, watched: bool) -> Self {
        Self {
            id: id.to_string(),
            name,
            folder,
            watched,
            initialized: false,
            snapshot: HashMap::new(),
            pending: BTreeSet::new(),
            last_change: None,
            last_change_at: 0,
            phase: if watched { "idle".to_string() } else { "unwatched".to_string() },
            message: String::new(),
            running: None,
            last_run: None,
            last_scan_at: None,
            last_output: String::new(),
        }
    }
}

/// A run the coordinator or the panel asked for: specific test targets, or the whole suite.
struct Job {
    workspace: String,
    targets: Vec<PathBuf>,
    full: bool,
    reason: String,
}

struct Shared {
    config: Config,
    workspaces: BTreeMap<String, WorkspaceTracker>,
    paused: bool,
    stopping: bool,
    jobs: VecDeque<Job>,
    notes: VecDeque<Value>,
}

impl Shared {
    fn new(config: Config) -> Self {
        Self {
            config,
            workspaces: BTreeMap::new(),
            paused: false,
            stopping: false,
            jobs: VecDeque::new(),
            notes: VecDeque::new(),
        }
    }
}

type Hub = Arc<(Mutex<Shared>, Condvar)>;

fn wake(hub: &Hub) {
    hub.1.notify_all();
}

fn stop(hub: &Hub) {
    let (lock, _) = &**hub;
    lock.lock().unwrap().stopping = true;
    wake(hub);
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// One manual or watched run, queued if its workspace has no run waiting already.
fn push_job(hub: &Hub, job: Job) {
    {
        let (lock, _) = &**hub;
        let mut shared = lock.lock().unwrap();
        if let Some(waiting) = shared.jobs.iter_mut().find(|waiting| waiting.workspace == job.workspace) {
            if job.full {
                waiting.full = true;
                waiting.targets.clear();
            } else if !waiting.full {
                for target in job.targets {
                    if !waiting.targets.contains(&target) {
                        waiting.targets.push(target);
                    }
                }
            }
            waiting.reason = job.reason;
        } else {
            shared.jobs.push_back(job);
        }
    }
    wake(hub);
}

// ---------- the coordinator: scan, debounce, resolve, dispatch ----------

fn coordinator(hub: Hub) {
    loop {
        // Wait for the next scan, or for anything that should shorten it.
        {
            let (lock, cvar) = &*hub;
            let guard = lock.lock().unwrap();
            let interval = Duration::from_millis(guard.config.interval_ms);
            let (shared, _) = cvar.wait_timeout(guard, interval).unwrap();
            if shared.stopping {
                return;
            }
        }
        // Snapshot the folders without the lock in hand: a walk is the slow part.
        let watched: Vec<(String, PathBuf)> = {
            let (lock, _) = &*hub;
            lock.lock()
                .unwrap()
                .workspaces
                .values()
                .filter(|one| one.watched)
                .map(|one| (one.id.clone(), one.folder.clone()))
                .collect()
        };
        for (id, folder) in watched {
            let snapshot = scan(&folder);
            let pending: Vec<PathBuf> = {
                let (lock, _) = &*hub;
                let mut shared = lock.lock().unwrap();
                if shared.stopping {
                    return;
                }
                let Some(tracker) = shared.workspaces.get_mut(&id) else {
                    continue;
                };
                tracker.last_scan_at = Some(now_ms());
                if !tracker.initialized {
                    // The baseline: the first scan says what is there, and runs nothing for it.
                    tracker.snapshot = snapshot;
                    tracker.initialized = true;
                    continue;
                }
                let changed = diff(&tracker.snapshot, &snapshot);
                tracker.snapshot = snapshot;
                if !changed.is_empty() {
                    tracker.pending.extend(changed);
                    tracker.last_change = Some(Instant::now());
                    tracker.last_change_at = now_ms();
                    if tracker.running.is_none() {
                        tracker.phase = "debouncing".to_string();
                    }
                }
                tracker.pending.iter().cloned().collect()
            };
            if pending.is_empty() {
                continue;
            }
            // A pause holds the run, not the watch: the pending set stays for the resume.
            let (debounced, paused, busy) = {
                let (lock, _) = &*hub;
                let shared = lock.lock().unwrap();
                let tracker = &shared.workspaces[&id];
                let debounced = tracker
                    .last_change
                    .map(|at| at.elapsed() >= Duration::from_millis(shared.config.debounce_ms))
                    .unwrap_or(true);
                (debounced, shared.paused, tracker.running.is_some())
            };
            if !debounced || paused || busy {
                continue;
            }
            // Resolve without the lock: reading every Python file is the slow part.
            let resolution = resolve_targets(&folder, &pending.iter().cloned().collect());
            let no_tests = matches!(resolution, Resolution::NoTests);
            let dispatched = {
                let (lock, _) = &*hub;
                let mut shared = lock.lock().unwrap();
                let Some(tracker) = shared.workspaces.get_mut(&id) else {
                    continue;
                };
                // Only the files that were resolved leave the pending set: an edit made during the
                // resolution is still pending and earns its own run.
                for file in &pending {
                    tracker.pending.remove(file);
                }
                if tracker.pending.is_empty() {
                    tracker.last_change = None;
                    if tracker.running.is_none() {
                        tracker.phase = "idle".to_string();
                    }
                }
                match resolution {
                    Resolution::Full => {
                        tracker.message = "suite configuration changed: running everything".to_string();
                        push_job_locked(&mut shared, id.clone(), vec![], true, "config changed".to_string());
                    }
                    Resolution::Targets(targets) => {
                        tracker.message = format!("{} test file(s) cover the change", targets.len());
                        push_job_locked(&mut shared, id.clone(), targets, false, "files changed".to_string());
                    }
                    Resolution::NoTests => {
                        tracker.phase = "no_tests".to_string();
                        tracker.message = format!("no tests cover {}", relative_names(&pending));
                        eprintln!("bughound: {id}: no tests cover {}", relative_names(&pending));
                    }
                }
                !no_tests
            };
            if dispatched {
                wake(&hub);
            }
        }
    }
}

/// A resolved job, pushed while the caller already holds the lock.
fn push_job_locked(shared: &mut Shared, workspace: String, targets: Vec<PathBuf>, full: bool, reason: String) {
    if let Some(waiting) = shared.jobs.iter_mut().find(|waiting| waiting.workspace == workspace) {
        if full {
            waiting.full = true;
            waiting.targets.clear();
        } else if !waiting.full {
            for target in targets {
                if !waiting.targets.contains(&target) {
                    waiting.targets.push(target);
                }
            }
        }
        waiting.reason = reason;
    } else {
        shared.jobs.push_back(Job {
            workspace,
            targets,
            full,
            reason,
        });
    }
}

fn relative_names(paths: &[PathBuf]) -> String {
    paths
        .iter()
        .take(4)
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(", ")
}

// ---------- scanning ----------

/// Directories the walk never enters: version control, pi-studio's own worktrees beside the folder,
/// virtual environments, caches and build output. Entering any of them is how a watcher spends its
/// visit on files nobody edits.
const PRUNED: &[&str] = &[
    ".git", ".hg", ".svn", ".agents", ".pi-studio", ".venv", "venv", "env", ".tox", ".nox", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", "__pycache__", "node_modules", "target", "dist", "build", ".eggs",
];

/// The relative paths worth watching: Python sources and the files pytest reads its own configuration
/// from. A config change is a full-suite run by resolution, so it has to be noticed.
fn watched_file(name: &str) -> bool {
    name.ends_with(".py")
        || matches!(name, "pyproject.toml" | "pytest.ini" | "tox.ini" | "setup.cfg")
}

/// A snapshot of one folder: every watched file's (mtime seconds, mtime nanos, length).
fn scan(folder: &Path) -> HashMap<PathBuf, (u64, u64, u64)> {
    let mut out = HashMap::new();
    let mut stack = vec![folder.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if PRUNED.contains(&name.as_str()) || name.ends_with(".egg-info") {
                    continue;
                }
                stack.push(path);
            } else if file_type.is_file() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !watched_file(&name) {
                    continue;
                }
                if let Ok(meta) = entry.metadata() {
                    let modified = meta.modified().ok();
                    let (secs, nanos) = modified
                        .and_then(|at| at.duration_since(UNIX_EPOCH).ok())
                        .map(|elapsed| (elapsed.as_secs(), elapsed.subsec_nanos() as u64))
                        .unwrap_or((0, 0));
                    if let Ok(relative) = path.strip_prefix(folder) {
                        out.insert(relative.to_path_buf(), (secs, nanos, meta.len()));
                    }
                }
            }
        }
    }
    out
}

fn diff(old: &HashMap<PathBuf, (u64, u64, u64)>, new: &HashMap<PathBuf, (u64, u64, u64)>) -> Vec<PathBuf> {
    let mut changed: Vec<PathBuf> = new
        .iter()
        .filter(|(path, fingerprint)| old.get(*path) != Some(*fingerprint))
        .map(|(path, _)| path.clone())
        .collect();
    for path in old.keys() {
        if !new.contains_key(path) {
            changed.push(path.clone());
        }
    }
    changed.sort();
    changed
}

// ---------- resolving a change to the tests that cover it ----------

enum Resolution {
    /// Configuration changed: run the whole suite.
    Full,
    /// These test files, and nothing else.
    Targets(Vec<PathBuf>),
    /// Nothing covers it: say so, and spawn nothing.
    NoTests,
}

/// A file pytest collects: `test_*.py` or `*_test.py`, beside a `conftest.py` it never collects.
fn is_test_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|one| one.to_str()) else {
        return false;
    };
    name.ends_with(".py") && (name.starts_with("test_") || name.ends_with("_test.py"))
}

fn resolve_targets(folder: &Path, changed: &BTreeSet<PathBuf>) -> Resolution {
    let mut targets: BTreeSet<PathBuf> = BTreeSet::new();
    let mut seeds: BTreeSet<PathBuf> = BTreeSet::new();
    let mut full = false;
    for path in changed {
        let name = path.file_name().and_then(|one| one.to_str()).unwrap_or("");
        if matches!(name, "pyproject.toml" | "pytest.ini" | "tox.ini" | "setup.cfg") {
            full = true;
        } else if name == "conftest.py" {
            match path.parent() {
                Some(parent) if !parent.as_os_str().is_empty() => {
                    targets.insert(parent.to_path_buf());
                }
                _ => full = true,
            }
        } else if name.ends_with(".py") {
            seeds.insert(path.clone());
        }
    }
    if full {
        return Resolution::Full;
    }
    if !seeds.is_empty() {
        let dependents = dependents_of(folder);
        let mut visited: HashSet<PathBuf> = HashSet::new();
        let mut frontier: Vec<PathBuf> = seeds.into_iter().collect();
        let mut hops = 0;
        while !frontier.is_empty() && hops < MAX_HOPS {
            hops += 1;
            let mut next: Vec<PathBuf> = Vec::new();
            for file in frontier {
                if !visited.insert(file.clone()) {
                    continue;
                }
                if is_test_file(&file) {
                    targets.insert(file.clone());
                }
                if let Some(importers) = dependents.get(&file) {
                    for importer in importers {
                        if !visited.contains(importer) {
                            next.push(importer.clone());
                        }
                    }
                }
            }
            frontier = next;
        }
    }
    if targets.is_empty() {
        Resolution::NoTests
    } else {
        Resolution::Targets(targets.into_iter().collect())
    }
}

/// The reverse graph of Python imports under one folder: a file and every file that imports it.
fn dependents_of(folder: &Path) -> HashMap<PathBuf, BTreeSet<PathBuf>> {
    let files = python_files(folder);
    let modules = module_map(&files);
    let mut dependents: HashMap<PathBuf, BTreeSet<PathBuf>> = HashMap::new();
    for file in &files {
        let Ok(text) = std::fs::read_to_string(folder.join(file)) else {
            continue;
        };
        for dep in imports_of(&text, file) {
            match module_file(&dep, &modules) {
                Some(target) if target != *file => {
                    dependents.entry(target).or_default().insert(file.clone());
                }
                _ => {}
            }
        }
    }
    dependents
}

fn python_files(folder: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![folder.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if PRUNED.contains(&name.as_str()) || name.ends_with(".egg-info") {
                    continue;
                }
                stack.push(path);
            } else if file_type.is_file() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.ends_with(".py") {
                    if let Ok(relative) = path.strip_prefix(folder) {
                        out.push(relative.to_path_buf());
                    }
                }
            }
        }
    }
    out.sort();
    out
}

/// Every dotted name a file may be imported by, from where it sits: at the root, under `src/` or
/// under `lib/` — the three layouts a Python project actually ships.
fn module_names(path: &Path) -> Vec<String> {
    let relative = path.to_string_lossy().replace('\\', "/");
    let stem = relative.strip_suffix(".py").unwrap_or(&relative);
    let stem = stem.strip_suffix("/__init__").unwrap_or(stem);
    let mut names = vec![stem.replace('/', ".")];
    for root in ["src/", "lib/"] {
        if let Some(rest) = stem.strip_prefix(root) {
            names.push(rest.replace('/', "."));
        }
    }
    names
}

fn module_map(files: &[PathBuf]) -> HashMap<String, PathBuf> {
    let mut map = HashMap::new();
    for file in files {
        for name in module_names(file) {
            map.entry(name).or_insert_with(|| file.clone());
        }
    }
    map
}

fn module_file(dep: &str, modules: &HashMap<String, PathBuf>) -> Option<PathBuf> {
    if let Some(file) = modules.get(dep) {
        return Some(file.clone());
    }
    // `from a.b import x` names a.b.x when x is a submodule, and a.b when it is not.
    dep.rsplit_once('.')
        .and_then(|(parent, _)| modules.get(parent).cloned())
}

/// The dotted names one Python file imports, resolved against where it sits for relative imports.
fn imports_of(text: &str, importer: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for line in logical_lines(text) {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // A comment after an import is a comment.
        let line = line.split('#').next().unwrap_or(line).trim();
        if let Some(rest) = line.strip_prefix("import ") {
            for part in rest.split(',') {
                let part = part.trim().split_whitespace().next().unwrap_or("");
                if !part.is_empty() {
                    out.push(part.to_string());
                    if let Some((parent, _)) = part.rsplit_once('.') {
                        out.push(parent.to_string());
                    }
                }
            }
        } else if let Some(rest) = line.strip_prefix("from ") {
            let Some((module, _)) = rest.split_once(" import ") else {
                continue;
            };
            let module = module.trim();
            let dots = module.len() - module.trim_start_matches('.').len();
            let module = module.trim_start_matches('.');
            let absolute = if dots == 0 {
                module.to_string()
            } else {
                let base = package_of(importer, dots);
                if module.is_empty() {
                    base
                } else if base.is_empty() {
                    module.to_string()
                } else {
                    format!("{base}.{module}")
                }
            };
            if !absolute.is_empty() {
                out.push(absolute.clone());
                // `from a.b import x, y`: x and y may each be a submodule a.b.x.
                if let Some((_, names)) = rest.split_once(" import ") {
                    for name in names.trim().trim_matches(['(', ')']).split(',') {
                        let name = name.trim().split_whitespace().next().unwrap_or("");
                        if !name.is_empty() && name != "*" {
                            out.push(format!("{absolute}.{name}"));
                        }
                    }
                }
            }
        }
    }
    out
}

/// The package a relative import starts from: `from .` is the file's own directory as a package,
/// `from ..` is one up, and a package's own `__init__.py` sits in its own package already.
fn package_of(importer: &Path, dots: usize) -> String {
    let mut dir: Vec<&str> = importer
        .parent()
        .map(|parent| parent.to_str().unwrap_or("").split('/').filter(|one| !one.is_empty()).collect())
        .unwrap_or_default();
    for _ in 1..dots {
        dir.pop();
    }
    dir.join(".")
}

/// Import statements with their continuations joined: a backslash or an open parenthesis keeps the
/// statement going onto the next line.
fn logical_lines(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut held = String::new();
    for raw in text.lines() {
        let mut line = raw.to_string();
        if line.ends_with('\\') {
            line.pop();
            held.push_str(&line);
            held.push(' ');
            continue;
        }
        held.push_str(&line);
        let open = held.matches('(').count();
        let close = held.matches(')').count();
        if open > close {
            held.push(' ');
            continue;
        }
        out.push(std::mem::take(&mut held));
    }
    if !held.trim().is_empty() {
        out.push(held);
    }
    out
}

// ---------- the runner: one pytest at a time ----------

fn runner(hub: Hub) {
    loop {
        let job = {
            let (lock, cvar) = &*hub;
            let mut shared = lock.lock().unwrap();
            loop {
                if shared.stopping {
                    return;
                }
                if let Some(job) = shared.jobs.pop_front() {
                    break Some(job);
                }
                shared = cvar.wait(shared).unwrap();
            }
        };
        let Some(job) = job else {
            return;
        };
        {
            let (lock, _) = &*hub;
            let mut shared = lock.lock().unwrap();
            if shared.stopping {
                return;
            }
            let Some(tracker) = shared.workspaces.get_mut(&job.workspace) else {
                continue;
            };
            tracker.phase = "running".to_string();
            tracker.running = Some(RunningView {
                targets: target_names(&job),
                started_at: now_ms(),
            });
        }
        let outcome = run_pytest(&hub, job.workspace.clone(), &job);
        {
            let (lock, _) = &*hub;
            let mut shared = lock.lock().unwrap();
            let previous_failed = shared
                .workspaces
                .get(&job.workspace)
                .and_then(|tracker| tracker.last_run.as_ref())
                .map(|last| last.status == "failed")
                .unwrap_or(false);
            let Some(tracker) = shared.workspaces.get_mut(&job.workspace) else {
                continue;
            };
            tracker.running = None;
            tracker.phase = "idle".to_string();
            tracker.last_output = outcome.output.clone();
            tracker.last_run = Some(LastRun {
                at: now_ms(),
                status: outcome.status.clone(),
                summary: outcome.summary.clone(),
                duration_ms: outcome.duration_ms,
                targets: target_names(&job),
                failures: outcome.failures.clone(),
            });
            if shared.config.post_failures
                && (outcome.status == "failed") != previous_failed
            {
                let markdown = format!(
                    "**{}** — {}\n\n{}\n\n{}",
                    job.workspace,
                    outcome.status,
                    outcome.summary,
                    failure_lines(&outcome.failures)
                );
                shared.notes.push_back(json!({
                    "workspace": job.workspace,
                    "title": format!("bughound: {}", outcome.status),
                    "markdown": markdown,
                    "key": format!("bughound:{}", job.workspace),
                }));
            }
        }
        // Changes that arrived during the run are now eligible for their own.
        wake(&hub);
    }
}

/// One drain thread for one pipe of the child. A run that fills its output must not stop at a full
/// pipe while nobody reads it, so both pipes are drained while the child runs.
fn spawn_reader<R: io::Read + Send + 'static>(stream: R, output: Arc<Mutex<String>>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut reader = io::BufReader::new(stream);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    let mut text = output.lock().unwrap();
                    text.push_str(&line);
                    if text.len() > OUTPUT_CAP {
                        *text = truncate_output(&text);
                    }
                }
                Err(_) => break,
            }
        }
    })
}

/// A full log keeps its head and its tail: the counts live in the last line, and cutting only the
/// front would lose the summary a failing run is read by.
fn truncate_output(text: &str) -> String {
    const HEAD_CAP: usize = 16 * 1024;
    const TAIL_CAP: usize = 48 * 1024;
    if text.len() <= OUTPUT_CAP {
        return text.to_string();
    }
    let mut head_end = HEAD_CAP;
    while head_end > 0 && !text.is_char_boundary(head_end) {
        head_end -= 1;
    }
    let head = match text[..head_end].rfind('\n') {
        Some(at) => &text[..at],
        None => &text[..head_end],
    };
    let tail_start = text.len() - TAIL_CAP;
    let mut tail_start = tail_start;
    while tail_start < text.len() && !text.is_char_boundary(tail_start) {
        tail_start += 1;
    }
    let tail = match text[tail_start..].find('\n') {
        Some(at) => &text[tail_start + at + 1..],
        None => &text[tail_start..],
    };
    format!("{head}\n… [output truncated] …\n{tail}")
}

fn target_names(job: &Job) -> Vec<String> {
    if job.full {
        vec!["<full suite>".to_string()]
    } else {
        job.targets.iter().map(|target| target.to_string_lossy().into_owned()).collect()
    }
}

fn failure_lines(failures: &[Failure]) -> String {
    failures
        .iter()
        .take(10)
        .map(|failure| format!("- `{}` — {}", failure.nodeid, failure.summary))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The program that runs the tests and whatever has to be said first: a configured binary with its
/// flags, a project venv's pytest or `python -m pytest`, or `pytest` on the PATH. Never a shell.
fn choose_pytest(folder: &Path, config: &Config) -> (String, Vec<String>) {
    if let Some(bin) = &config.pytest {
        return (bin.clone(), config.pytest_args.clone());
    }
    let candidates: [(&str, Vec<String>); 4] = [
        (".venv/bin/pytest", vec![]),
        ("venv/bin/pytest", vec![]),
        (".venv/bin/python", vec!["-m".to_string(), "pytest".to_string()]),
        ("venv/bin/python", vec!["-m".to_string(), "pytest".to_string()]),
    ];
    for (relative, prefix) in candidates {
        let path = folder.join(relative);
        #[cfg(unix)]
        let executable = {
            use std::os::unix::fs::PermissionsExt;
            std::fs::metadata(&path)
                .map(|meta| meta.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
        };
        #[cfg(not(unix))]
        let executable = path.is_file();
        if executable {
            return (path.to_string_lossy().into_owned(), prefix);
        }
    }
    ("pytest".to_string(), vec![])
}

struct Outcome {
    status: String,
    summary: String,
    failures: Vec<Failure>,
    output: String,
    duration_ms: u64,
}

fn run_pytest(hub: &Hub, workspace: String, job: &Job) -> Outcome {
    let (config, folder) = {
        let (lock, _) = &**hub;
        let shared = lock.lock().unwrap();
        let folder = shared
            .workspaces
            .get(&workspace)
            .map(|tracker| tracker.folder.clone())
            .unwrap_or_default();
        (shared.config.clone(), folder)
    };
    let started = Instant::now();
    let (program, mut prefix) = choose_pytest(&folder, &config);
    let mut args = prefix.drain(..).collect::<Vec<String>>();
    args.extend(["-q", "--tb=short", "--no-header", "--color=no"].iter().map(|one| one.to_string()));
    if !job.full {
        for target in &job.targets {
            args.push(target.to_string_lossy().into_owned());
        }
    }
    let mut child = match Command::new(&program)
        .args(&args)
        .current_dir(&folder)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return Outcome {
                status: "error".to_string(),
                summary: format!("could not start {program}: {error}"),
                failures: vec![],
                output: format!("could not start {program}: {error}\n"),
                duration_ms: started.elapsed().as_millis() as u64,
            };
        }
    };
    let output = Arc::new(Mutex::new(String::new()));
    let mut readers: Vec<std::thread::JoinHandle<()>> = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        readers.push(spawn_reader(stdout, Arc::clone(&output)));
    }
    if let Some(stderr) = child.stderr.take() {
        readers.push(spawn_reader(stderr, Arc::clone(&output)));
    }
    let deadline = started + Duration::from_secs(config.timeout_s);
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                let (lock, _) = &**hub;
                if lock.lock().unwrap().stopping || Instant::now() >= deadline {
                    if Instant::now() >= deadline {
                        timed_out = true;
                    }
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => break,
        }
    }
    for reader in readers {
        let _ = reader.join();
    }
    let output_text = output.lock().unwrap().clone();
    if timed_out {
        return Outcome {
            status: "timeout".to_string(),
            summary: format!("did not finish in {}s", config.timeout_s),
            failures: vec![],
            output: output_text,
            duration_ms: started.elapsed().as_millis() as u64,
        };
    }
    let exit_code = child
        .try_wait()
        .ok()
        .flatten()
        .and_then(|status| status.code())
        .unwrap_or(-1);
    let (status, summary, failures) = parse_result(&output_text, exit_code);
    Outcome {
        status,
        summary,
        failures,
        output: output_text,
        duration_ms: started.elapsed().as_millis() as u64,
    }
}

/// What a `-q --tb=short` run said, read back: the summary counts, and the failures by node id.
fn parse_result(output: &str, exit_code: i32) -> (String, String, Vec<Failure>) {
    let mut failures: Vec<Failure> = Vec::new();
    let mut summary = String::new();
    for line in output.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("FAILED ") {
            let (nodeid, note) = rest.split_once(" - ").unwrap_or((rest, ""));
            failures.push(Failure {
                nodeid: nodeid.trim().to_string(),
                summary: note.trim().to_string(),
            });
        } else if let Some(rest) = line.strip_prefix("ERROR ") {
            let (nodeid, note) = rest.split_once(" - ").unwrap_or((rest, ""));
            failures.push(Failure {
                nodeid: nodeid.trim().to_string(),
                summary: note.trim().to_string(),
            });
        } else if line.contains(" in ") && (line.contains("passed") || line.contains("failed") || line.contains("error")) {
            // The summary banner ends "in 0.42s"; a traceback line that merely mentions "error" ends
            // a different way and must not stand in for it.
            summary = line.to_string();
        }
    }
    if summary.is_empty() {
        summary = output
            .lines()
            .filter(|line| !line.trim().is_empty())
            .last()
            .unwrap_or("")
            .trim()
            .to_string();
    }
    let status = match exit_code {
        0 => "passed",
        1 => "failed",
        5 => "no_tests",
        _ => "error",
    };
    (status.to_string(), summary, failures)
}

// ---------- what the panel reads ----------

fn settings_view(hub: &Hub) -> Value {
    let (lock, _) = &**hub;
    let shared = lock.lock().unwrap();
    settings_view_of(&shared)
}

fn settings_view_of(shared: &Shared) -> Value {
    json!({
        "intervalMs": shared.config.interval_ms,
        "debounceMs": shared.config.debounce_ms,
        "timeoutS": shared.config.timeout_s,
    })
}

fn state_snapshot(hub: &Hub, only: &str) -> Value {
    let (lock, _) = &**hub;
    let shared = lock.lock().unwrap();
    let rows: Vec<Value> = shared
        .workspaces
        .values()
        .filter(|one| only.is_empty() || one.id == only)
        .map(|one| {
            let phase = if shared.paused {
                "paused".to_string()
            } else {
                one.phase.clone()
            };
            json!({
                "id": one.id,
                "name": one.name,
                "folder": one.folder.to_string_lossy(),
                "watched": one.watched,
                "phase": phase,
                "message": one.message,
                "pending": one.pending.iter().map(|path| path.to_string_lossy().into_owned()).collect::<Vec<_>>(),
                "running": one.running.as_ref().map(|running| json!({
                    "targets": running.targets,
                    "startedAt": running.started_at,
                })),
                "lastRun": one.last_run.as_ref().map(|last| json!({
                    "at": last.at,
                    "status": last.status,
                    "summary": last.summary,
                    "durationMs": last.duration_ms,
                    "targets": last.targets,
                    "failures": last.failures.iter().map(|failure| json!({
                        "nodeid": failure.nodeid,
                        "summary": failure.summary,
                    })).collect::<Vec<_>>(),
                })),
                "lastScanAt": one.last_scan_at,
                "lastChangeAt": one.last_change_at,
            })
        })
        .collect();
    json!({
        "paused": shared.paused,
        "phase": computed_phase(&shared),
        "intervalMs": shared.config.interval_ms,
        "debounceMs": shared.config.debounce_ms,
        "timeoutS": shared.config.timeout_s,
        "settings": settings_view_of(&shared),
        "workspaces": rows,
    })
}

fn computed_phase(shared: &Shared) -> &'static str {
    if shared.paused {
        return "paused";
    }
    if shared.workspaces.values().any(|one| one.running.is_some()) {
        return "running";
    }
    if shared.workspaces.values().any(|one| one.phase == "debouncing") {
        return "debouncing";
    }
    "idle"
}

fn last_output(hub: &Hub, workspace: &str) -> String {
    let (lock, _) = &**hub;
    let shared = lock.lock().unwrap();
    if workspace.is_empty() {
        shared
            .workspaces
            .values()
            .max_by_key(|one| one.last_run.as_ref().map(|last| last.at).unwrap_or(0))
            .map(|one| one.last_output.clone())
            .unwrap_or_default()
    } else {
        shared
            .workspaces
            .get(workspace)
            .map(|one| one.last_output.clone())
            .unwrap_or_default()
    }
}

fn queue_manual_run(hub: &Hub, scope: &str, workspace: &str) -> Value {
    let ids: Vec<String> = {
        let (lock, _) = &**hub;
        let shared = lock.lock().unwrap();
        if workspace.is_empty() {
            shared.workspaces.keys().cloned().collect()
        } else if shared.workspaces.contains_key(workspace) {
            vec![workspace.to_string()]
        } else {
            vec![]
        }
    };
    let mut queued = false;
    for id in ids {
        if scope == "failed" {
            let targets: Vec<PathBuf> = {
                let (lock, _) = &**hub;
                let shared = lock.lock().unwrap();
                shared
                    .workspaces
                    .get(&id)
                    .and_then(|tracker| tracker.last_run.as_ref())
                    .map(|last| {
                        last.failures
                            .iter()
                            .map(|failure| PathBuf::from(failure.nodeid.split("::").next().unwrap_or("")))
                            .collect()
                    })
                    .unwrap_or_default()
            };
            if targets.is_empty() {
                continue;
            }
            push_job(
                hub,
                Job {
                    workspace: id,
                    targets,
                    full: false,
                    reason: "rerun the failures".to_string(),
                },
            );
            queued = true;
        } else {
            push_job(
                hub,
                Job {
                    workspace: id,
                    targets: vec![],
                    full: true,
                    reason: "manual run all".to_string(),
                },
            );
            queued = true;
        }
    }
    json!({ "queued": queued, "scope": scope })
}

// ---------- the tests ----------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    /// A daemon a test can drive: the lines it says, and the frames this plugin wrote back.
    struct Script {
        incoming: VecDeque<String>,
        sent: Vec<Value>,
    }

    impl Script {
        fn new(lines: Vec<Value>) -> Self {
            Self {
                incoming: lines.into_iter().map(|line| line.to_string()).collect(),
                sent: Vec::new(),
            }
        }
    }

    impl Transport for Script {
        fn write(&mut self, message: Value) -> io::Result<()> {
            self.sent.push(message);
            Ok(())
        }

        fn read_line(&mut self) -> io::Result<Option<String>> {
            Ok(self.incoming.pop_front())
        }
    }

    fn call_frame(id: i64, method: &str, params: Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
    }

    fn response_frame(id: i64, result: Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "result": result })
    }

    /// A folder a test can edit under, given a name no other test writes at once.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!("bughound-test-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).unwrap();
            Scratch(path)
        }

        fn write(&self, relative: &str, text: &str) {
            let path = self.0.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn config_defaults_and_flags() {
        let config = parse_args(&[]).unwrap();
        assert_eq!(config.interval_ms, 2000);
        assert_eq!(config.debounce_ms, 500);
        assert_eq!(config.timeout_s, 60);
        assert!(!config.post_failures);
        let config = parse_args(&[
            "--interval-ms".to_string(),
            "100".to_string(),
            "--workspace=foo".to_string(),
            "--pytest".to_string(),
            "uv".to_string(),
            "--pytest-arg".to_string(),
            "run".to_string(),
            "--post-failures".to_string(),
        ])
        .unwrap();
        assert_eq!(config.interval_ms, 250, "an interval under a quarter second is clamped up");
        assert_eq!(config.workspaces, vec!["foo".to_string()]);
        assert_eq!(config.pytest.as_deref(), Some("uv"));
        assert_eq!(config.pytest_args, vec!["run".to_string()]);
        assert!(config.post_failures);
        assert!(parse_args(&["--nope".to_string()]).is_err());
        assert!(parse_args(&["--interval-ms".to_string(), "soon".to_string()]).is_err());
        assert!(parse_args(&["--interval-ms".to_string()]).is_err());
    }

    #[test]
    fn a_changed_module_pulls_in_the_test_that_imports_it() {
        let project = Scratch::new("closure");
        project.write("pkg/calc.py", "def add(a, b):\n    return a + b\n");
        project.write(
            "tests/test_calc.py",
            "from pkg.calc import add\n\ndef test_add():\n    assert add(1, 2) == 3\n",
        );
        project.write("pkg/unused.py", "X = 1\n");
        let files: BTreeSet<PathBuf> = [PathBuf::from("pkg/calc.py")].into_iter().collect();
        match resolve_targets(&project.0, &files) {
            Resolution::Targets(targets) => {
                assert_eq!(targets, vec![PathBuf::from("tests/test_calc.py")]);
            }
            _ => panic!("a covered source file should resolve to its test"),
        }
        let files: BTreeSet<PathBuf> = [PathBuf::from("pkg/unused.py")].into_iter().collect();
        assert!(matches!(resolve_targets(&project.0, &files), Resolution::NoTests));
    }

    #[test]
    fn a_changed_test_runs_itself_and_config_runs_everything() {
        let project = Scratch::new("config");
        project.write("tests/test_a.py", "def test_a():\n    pass\n");
        project.write("conftest.py", "");
        let files: BTreeSet<PathBuf> = [PathBuf::from("tests/test_a.py")].into_iter().collect();
        match resolve_targets(&project.0, &files) {
            Resolution::Targets(targets) => assert_eq!(targets, vec![PathBuf::from("tests/test_a.py")]),
            _ => panic!("a changed test file covers itself"),
        }
        let files: BTreeSet<PathBuf> = [PathBuf::from("pyproject.toml")].into_iter().collect();
        assert!(matches!(resolve_targets(&project.0, &files), Resolution::Full));
        let files: BTreeSet<PathBuf> = [PathBuf::from("conftest.py")].into_iter().collect();
        assert!(matches!(resolve_targets(&project.0, &files), Resolution::Full));
    }

    #[test]
    fn imports_are_read_with_relative_forms_and_continuations() {
        let project = Scratch::new("imports");
        project.write("pkg/one.py", "X = 1\n");
        project.write("pkg/two.py", "Y = 2\n");
        project.write(
            "tests/test_three.py",
            "from pkg import one  # a comment\nfrom pkg.two import (\n    Y,\n)\nimport pkg.one\n\ndef test_three():\n    assert one.X + Y == 3\n",
        );
        let files: BTreeSet<PathBuf> = [PathBuf::from("pkg/one.py")].into_iter().collect();
        match resolve_targets(&project.0, &files) {
            Resolution::Targets(targets) => assert_eq!(targets, vec![PathBuf::from("tests/test_three.py")]),
            _ => panic!("the import forms should reach the test"),
        }
        let files: BTreeSet<PathBuf> = [PathBuf::from("pkg/two.py")].into_iter().collect();
        match resolve_targets(&project.0, &files) {
            Resolution::Targets(targets) => assert_eq!(targets, vec![PathBuf::from("tests/test_three.py")]),
            _ => panic!("a parenthesised continuation should reach the test"),
        }
    }

    #[test]
    fn result_parsing_reads_counts_and_failures() {
        let output = "test_calc.py::test_add FAILED\nFAILED tests/test_calc.py::test_add - assert 1 == 2\n1 failed, 3 passed in 0.42s\n";
        let (status, summary, failures) = parse_result(output, 1);
        assert_eq!(status, "failed");
        assert_eq!(summary, "1 failed, 3 passed in 0.42s");
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].nodeid, "tests/test_calc.py::test_add");
        assert_eq!(failures[0].summary, "assert 1 == 2");
        let (status, summary, _) = parse_result("4 passed in 0.10s\n", 0);
        assert_eq!(status, "passed");
        assert_eq!(summary, "4 passed in 0.10s");
        let (status, _, _) = parse_result("no tests ran\n", 5);
        assert_eq!(status, "no_tests");
    }

    #[test]
    fn saved_settings_yield_to_the_registration() {
        let saved = Settings {
            interval_ms: Some(900),
            debounce_ms: Some(900),
            timeout_s: Some(90),
        };
        let config = resolve(Given::default(), Some(saved)).unwrap();
        assert_eq!(config.interval_ms, 900);
        assert_eq!(config.debounce_ms, 900);
        assert_eq!(config.timeout_s, 90);
        let given = Given {
            interval_ms: Some(3000),
            ..Given::default()
        };
        let saved = Settings {
            interval_ms: Some(900),
            debounce_ms: Some(900),
            timeout_s: Some(90),
        };
        let config = resolve(given, Some(saved)).unwrap();
        assert_eq!(config.interval_ms, 3000, "an arg wins over the file");
        assert_eq!(config.debounce_ms, 900, "what no arg said still comes from the file");
    }

    #[test]
    fn a_long_output_keeps_its_head_and_its_tail() {
        let mut text = String::from("first line\n");
        for i in 0..10000 {
            text.push_str(&format!("line {i}\n"));
        }
        text.push_str("2 failed, 3 passed in 0.42s\n");
        let kept = truncate_output(&text);
        assert!(kept.starts_with("first line"), "the head survives");
        assert!(kept.contains("… [output truncated] …"), "the cut is marked");
        assert!(kept.ends_with("2 failed, 3 passed in 0.42s\n"), "and so does the summary in the tail");
        assert!(kept.len() <= OUTPUT_CAP + 64, "the log stays bounded");
    }

    #[test]
    fn the_handshake_and_a_panel_state_are_answered_in_memory() {
        let project = Scratch::new("state");
        project.write("calc.py", "X = 1\n");
        let folder = project.0.to_string_lossy().into_owned();
        let workspaces = json!({
            "workspaces": [{ "id": "ws", "name": "ws", "folder": folder, "missing": false, "scratch": false }]
        });
        let script = Script::new(vec![
            call_frame(1, "initialize", json!({ "protocolVersion": 1 })),
            response_frame(1, workspaces),
            response_frame(2, json!({ "types": ["thread.settled"] })),
            call_frame(3, "visual.request", json!({ "workspace": "ws", "method": "state", "params": {} })),
            call_frame(4, "visual.request", json!({ "workspace": "ws", "method": "run", "params": { "scope": "all" } })),
            call_frame(5, "visual.request", json!({ "workspace": "ws", "method": "zap", "params": {} })),
            json!({ "jsonrpc": "2.0", "method": "shutdown" }),
        ]);
        let mut plugin = Bughound::new(script, Config::with_defaults(), project.0.join("settings.json"));
        plugin.run().unwrap();
        let sent = &plugin.transport.sent;
        let answer = |id: i64| sent.iter().find(|frame| frame.get("id") == Some(&json!(id))).cloned();
        assert_eq!(answer(1).unwrap()["result"]["name"], json!("bughound"));
        let state = answer(3).unwrap()["result"].clone();
        assert_eq!(state["workspaces"][0]["id"], json!("ws"));
        assert_eq!(state["workspaces"][0]["watched"], json!(true));
        assert_eq!(answer(4).unwrap()["result"]["queued"], json!(true));
        assert_eq!(answer(5).unwrap()["error"]["code"], json!(METHOD_NOT_FOUND));
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (config, settings_path) = match parse_given(&args) {
        Ok(given) => {
            let path = given
                .settings_path
                .clone()
                .map(PathBuf::from)
                .unwrap_or_else(default_settings_path);
            let saved = Settings::read(&path);
            (resolve(given, Some(saved)).unwrap_or_else(|_| Config::with_defaults()), path)
        }
        Err(error) => {
            eprintln!("bughound: {error}");
            std::process::exit(2);
        }
    };
    let mut plugin = Bughound::new(StdioTransport::new(), config, settings_path);
    if let Err(error) = plugin.run() {
        // A daemon that has gone away is the ordinary end of a plugin, and worth no fuss.
        if error.kind() != io::ErrorKind::BrokenPipe {
            eprintln!("bughound: {error}");
            std::process::exit(1);
        }
    }
}

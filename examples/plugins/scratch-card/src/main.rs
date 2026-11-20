//! An example pi-studio plugin, in Rust, and the whole of what a plugin has to be.
//!
//! The daemon starts this program, speaks to it over its own pipes, and stops it when the daemon goes.
//! The words are one JSON object per line, LF at the end, in both directions: a line protocol every
//! language can write without a library. The daemon calls `initialize` first, and the plugin calls back
//! for what it needs.
//!
//! What this one does: it asks to be told about runs that ended, asks the daemon which workspace is the
//! scratch one, and writes one note there for each settled thread on that board. The note's key is the
//! thread's id, so a thread that settles again revises that card instead of stacking a second one. A
//! thread on any other workspace is left alone, and a daemon that never says which board is scratch
//! gets no card at all.
//!
//! The methods a daemon answers, and the events it sends, are documented at the top of
//! `server/plugins/service.ts`.

use std::collections::VecDeque;
use std::io::{self, BufRead, Write};

use serde_json::{json, Value};

/// What both ends say in `initialize`. A daemon that answers another number is one this plugin cannot
/// speak to.
const PROTOCOL_VERSION: i64 = 1;

/// What this plugin calls itself, in the handshake and in the daemon's log.
const PLUGIN_NAME: &str = "scratch-card";
const PLUGIN_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The enterprising half of JSON-RPC 2.0: the codes a refusal carries, as the daemon's `protocol.ts`
/// spells them.
const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;

fn main() {
    let mut plugin = ScratchCard::new(Stdio);
    if let Err(error) = plugin.run() {
        // A daemon that has gone away is the ordinary end of a plugin, and worth no fuss.
        if error.kind() != io::ErrorKind::BrokenPipe {
            eprintln!("{PLUGIN_NAME}: {error}");
            std::process::exit(1);
        }
    }
}

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
}

/// The real pipes: stdout carries frames and nothing else, so a diagnosis goes to stderr where the
/// daemon keeps it.
struct Stdio;

impl Transport for Stdio {
    fn write(&mut self, message: Value) -> io::Result<()> {
        let mut stdout = io::stdout().lock();
        let mut line = serde_json::to_string(&message).map_err(io::Error::other)?;
        line.push('\n');
        stdout.write_all(line.as_bytes())?;
        stdout.flush()
    }

    fn read_line(&mut self) -> io::Result<Option<String>> {
        let mut line = String::new();
        if io::stdin().lock().read_line(&mut line)? == 0 {
            return Ok(None);
        }
        let line = line.strip_suffix('\n').unwrap_or(&line);
        // A plugin written on Windows writes its lines that way, and the daemon strips one CR for the
        // same reason.
        let line = line.strip_suffix('\r').unwrap_or(line);
        Ok(Some(line.to_string()))
    }
}

// ---------- the plugin ----------

/// This plugin: the pipe it speaks on, the id of the next call it makes, and what it has been told.
struct ScratchCard<T: Transport> {
    transport: T,
    next_id: i64,
    /// The workspace the daemon marks as scratch, once `workspace.list` has answered. Nothing is
    /// written until it is known.
    scratch: Option<String>,
    /// Runs that ended while a call was in flight, handled once that call answers, so the answer to a
    /// call is never taken out of order.
    deferred: VecDeque<Value>,
    /// Set once the daemon said `shutdown`, or told this plugin something it cannot answer.
    stopping: bool,
}

impl<T: Transport> ScratchCard<T> {
    fn new(transport: T) -> Self {
        Self {
            transport,
            next_id: 1,
            scratch: None,
            deferred: VecDeque::new(),
            stopping: false,
        }
    }

    fn run(&mut self) -> io::Result<()> {
        self.handshake()?;
        if self.stopping {
            return Ok(());
        }
        self.subscribe()?;
        self.learn_scratch()?;
        while !self.stopping {
            self.write_deferred_cards()?;
            if self.stopping {
                break;
            }
            let Some(line) = self.next_line()? else {
                break;
            };
            // The answer to a call is taken inside `call`, so one that reaches here answers nothing.
            self.handle(classify(&line))?;
        }
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

    /// Ask for the one event this plugin reads. A daemon that refuses it says so on stderr, and the
    /// plugin carries on with what it can still do.
    fn subscribe(&mut self) -> io::Result<()> {
        self.call("events.subscribe", json!({ "types": ["thread.settled"] }))?;
        Ok(())
    }

    /// Ask which workspaces the daemon knows, and remember the one it marks as scratch.
    fn learn_scratch(&mut self) -> io::Result<()> {
        if let Some(list) = self.call("workspace.list", json!({}))? {
            self.scratch = scratch_id(&list);
        }
        Ok(())
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
            "shutdown" => self.stopping = true,
            "event" => self.deferred.push_back(params),
            other => {
                eprintln!("{PLUGIN_NAME}: the daemon said {other}, which this plugin does not read")
            }
        }
    }

    /// Answer one call of the daemon's. `initialize` is the only method a plugin has to answer.
    fn answer(&mut self, id: Value, method: &str, params: Value) -> io::Result<()> {
        match method {
            "initialize" => match initialize_answer(&params) {
                Ok(answer) => self.send(json!({ "jsonrpc": "2.0", "id": id, "result": answer })),
                Err(error) => {
                    // A daemon that speaks another protocol has nothing this plugin can answer.
                    self.stopping = true;
                    self.refuse(Some(id), error)
                }
            },
            other => {
                let message =
                    format!("{other} is not a method this plugin answers; it answers initialize");
                self.refuse(Some(id), RpcError::new(METHOD_NOT_FOUND, &message))
            }
        }
    }

    /// A call this plugin makes. `None` is an answer the daemon refused, which is said on stderr and
    /// left for the caller to do without.
    fn call(&mut self, method: &str, params: Value) -> io::Result<Option<Value>> {
        let id = json!(self.next_id);
        self.next_id += 1;
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))?;
        loop {
            let Some(line) = self.next_line()? else {
                eprintln!("{PLUGIN_NAME}: the daemon closed its input while answering {method}");
                self.stopping = true;
                return Ok(None);
            };
            let Some((answer_id, result)) = self.handle(classify(&line))? else {
                continue;
            };
            if answer_id != id {
                continue;
            }
            return match result {
                Ok(value) => Ok(Some(value)),
                Err(error) => {
                    eprintln!(
                        "{PLUGIN_NAME}: the daemon refused {method}: {} (code {})",
                        error.message, error.code
                    );
                    Ok(None)
                }
            };
        }
    }

    /// Every run that ended while a call was in flight, as the card it earns.
    fn write_deferred_cards(&mut self) -> io::Result<()> {
        while let Some(event) = self.deferred.pop_front() {
            if let Some(params) = card_params(&event, self.scratch.as_deref()) {
                self.call("cards.note", params)?;
            }
        }
        Ok(())
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

/// The workspace the daemon's own list marks as scratch. A row that does not say `scratch: true` is not
/// it, and a list with no such row means this plugin writes nothing anywhere.
fn scratch_id(list: &Value) -> Option<String> {
    list.get("workspaces")?
        .as_array()?
        .iter()
        .find(|row| row.get("scratch").and_then(Value::as_bool) == Some(true))?
        .get("id")?
        .as_str()
        .map(str::to_string)
}

/// The note one ended run earns, or nothing when the run was not on the scratch board.
///
/// The workspace has to be the one the daemon called scratch: a plugin that guessed, or that wrote
/// wherever an event pointed, would leave notes in somebody's project.
fn card_params(event: &Value, scratch: Option<&str>) -> Option<Value> {
    if event.get("type").and_then(Value::as_str) != Some("thread.settled") {
        return None;
    }
    let workspace = event.get("workspace")?.as_str()?;
    if Some(workspace) != scratch {
        return None;
    }
    let thread = event.get("thread")?;
    let id = thread.get("id")?.as_str()?;
    let title = thread
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("a thread");
    let status = thread
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let answered = thread
        .get("answered")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let outcome = if answered {
        "answered"
    } else {
        "ended without an answer"
    };
    let reason = match thread.get("error").and_then(Value::as_str) {
        Some(error) => format!("\n\n> {error}"),
        None => String::new(),
    };
    Some(json!({
        // The key is the thread's id, so a thread that settles again revises this card rather than
        // stacking a second one beside it. `cards.note` does the rest.
        "key": format!("scratch-card:{id}"),
        "workspace": workspace,
        "title": title,
        "markdown": format!("**{title}**\n\nthread `{id}` · `{status}` · {outcome}{reason}"),
    }))
}

// ---------- the tests ----------

#[cfg(test)]
mod tests {
    use super::*;

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

        /// One line the daemon would not send: a frame that is not JSON at all.
        fn raw(mut self, line: &str) -> Self {
            self.incoming.push_back(line.to_string());
            self
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

    /// The frames one script made the plugin write. The plugin is expected to have finished.
    fn run(script: Script) -> Vec<Value> {
        let mut plugin = ScratchCard::new(script);
        plugin
            .run()
            .expect("the plugin ran to the end of its script");
        plugin.transport.sent
    }

    fn initialize(protocol_version: i64) -> Value {
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": { "protocolVersion": protocol_version, "plugin": PLUGIN_NAME, "client": { "name": "pi-studio" } },
        })
    }

    fn answer(id: i64, result: Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": id, "result": result })
    }

    fn event(workspace: &str, thread: &str) -> Value {
        json!({
            "jsonrpc": "2.0",
            "method": "event",
            "params": {
                "type": "thread.settled",
                "workspace": workspace,
                "at": 1,
                "thread": { "id": thread, "title": "do the thing", "status": "done", "answered": true },
            },
        })
    }

    /// The list the daemon answers with: a project and the scratch row.
    fn workspaces() -> Value {
        json!({ "workspaces": [
            { "id": "project", "name": "a project", "folder": "/tmp/p", "missing": false, "scratch": false },
            { "id": "scratch", "name": "scratch", "folder": "/tmp/s", "missing": false, "scratch": true },
        ] })
    }

    #[test]
    fn the_handshake_names_the_protocol_and_then_asks_for_what_it_needs() {
        let sent = run(Script::new(vec![
            initialize(PROTOCOL_VERSION),
            answer(1, json!({ "types": ["thread.settled"] })),
            answer(2, workspaces()),
            json!({ "jsonrpc": "2.0", "method": "shutdown" }),
        ]));
        assert_eq!(
            sent[0],
            json!({ "jsonrpc": "2.0", "id": 1, "result": {
                "protocolVersion": 1, "name": PLUGIN_NAME, "version": PLUGIN_VERSION,
            } })
        );
        assert_eq!(sent[1]["method"], "events.subscribe");
        assert_eq!(sent[1]["params"], json!({ "types": ["thread.settled"] }));
        assert_eq!(sent[2]["method"], "workspace.list");
        assert_eq!(
            sent.len(),
            3,
            "nothing else is asked of a daemon that then says shutdown"
        );
    }

    #[test]
    fn a_run_that_ended_on_the_scratch_board_leaves_one_card_there() {
        let sent = run(Script::new(vec![
            initialize(PROTOCOL_VERSION),
            answer(1, json!({ "types": ["thread.settled"] })),
            answer(2, workspaces()),
            event("project", "t-on-a-project"),
            event("scratch", "t-on-scratch"),
            answer(3, json!({ "cardId": "card-1", "card": {} })),
        ]));
        let notes = sent
            .iter()
            .filter(|frame| frame["method"] == "cards.note")
            .collect::<Vec<_>>();
        assert_eq!(
            notes.len(),
            1,
            "one card, for the scratch thread and no other"
        );
        assert_eq!(notes[0]["params"]["workspace"], "scratch");
        assert_eq!(notes[0]["params"]["key"], "scratch-card:t-on-scratch");
        let markdown = notes[0]["params"]["markdown"].as_str().unwrap();
        assert!(
            markdown.contains("do the thing"),
            "the card says what the thread was asked"
        );
    }

    #[test]
    fn a_daemon_that_names_no_scratch_board_earns_no_card_anywhere() {
        let sent = run(Script::new(vec![
            initialize(PROTOCOL_VERSION),
            answer(1, json!({ "types": ["thread.settled"] })),
            answer(2, json!({ "workspaces": [] })),
            event("scratch", "t-on-scratch"),
        ]));
        assert!(
            sent.iter().all(|frame| frame["method"] != "cards.note"),
            "a card needs a board the daemon positively called scratch"
        );
    }

    #[test]
    fn a_list_the_daemon_refused_leaves_the_plugin_with_no_board_to_write_on() {
        let sent = run(Script::new(vec![
            initialize(PROTOCOL_VERSION),
            answer(1, json!({ "types": ["thread.settled"] })),
            json!({ "jsonrpc": "2.0", "id": 2, "error": { "code": -32602, "message": "no list for you" } }),
            event("scratch", "t-on-scratch"),
        ]));
        assert!(sent.iter().all(|frame| frame["method"] != "cards.note"));
    }

    #[test]
    fn a_daemon_speaking_another_protocol_is_refused_and_the_plugin_stops() {
        let sent = run(Script::new(vec![initialize(2), event("scratch", "t")]));
        assert_eq!(
            sent.len(),
            1,
            "a refusal is all this plugin has to say to that daemon"
        );
        assert_eq!(sent[0]["error"]["code"], INVALID_PARAMS);
        assert_eq!(sent[0]["id"], 1);
    }

    #[test]
    fn a_frame_that_is_not_json_is_answered_with_a_parse_error() {
        let sent = run(Script::new(vec![
            initialize(PROTOCOL_VERSION),
            answer(1, json!({ "types": ["thread.settled"] })),
            answer(2, workspaces()),
        ])
        .raw("this is not a frame"));
        let refusal = sent.last().expect("the plugin answered the bad line");
        assert_eq!(refusal["error"]["code"], PARSE_ERROR);
        assert_eq!(refusal["id"], Value::Null);
    }

    #[test]
    fn a_method_the_plugin_does_not_have_is_refused_as_one() {
        let sent = run(Script::new(vec![
            initialize(PROTOCOL_VERSION),
            answer(1, json!({ "types": ["thread.settled"] })),
            answer(2, workspaces()),
            json!({ "jsonrpc": "2.0", "id": 7, "method": "cards.recolor", "params": {} }),
        ]));
        let refusal = sent.last().expect("the plugin answered the call");
        assert_eq!(refusal["id"], 7);
        assert_eq!(refusal["error"]["code"], METHOD_NOT_FOUND);
    }

    #[test]
    fn the_three_kinds_of_frame_are_told_apart() {
        assert!(matches!(
            classify(&initialize(1).to_string()),
            Incoming::Request { .. }
        ));
        assert!(matches!(
            classify(&answer(1, Value::Null).to_string()),
            Incoming::Response { result: Ok(_), .. }
        ));
        assert!(matches!(
            classify(&json!({ "jsonrpc": "2.0", "method": "shutdown" }).to_string()),
            Incoming::Notification { .. }
        ));
        assert!(matches!(
            classify("not json"),
            Incoming::Invalid { id: None, .. }
        ));
        assert!(matches!(
            classify(&json!({ "jsonrpc": "1.0", "id": 1, "method": "initialize" }).to_string()),
            Incoming::Invalid { .. }
        ));
    }

    #[test]
    fn the_scratch_board_is_the_row_the_daemon_marks_as_scratch() {
        assert_eq!(scratch_id(&workspaces()).as_deref(), Some("scratch"));
        assert_eq!(scratch_id(&json!({ "workspaces": [] })), None);
        assert_eq!(scratch_id(&json!({})), None);
    }

    #[test]
    fn a_card_is_made_for_the_scratch_board_and_for_nothing_else() {
        let settled = json!({
            "type": "thread.settled", "workspace": "scratch", "at": 1,
            "thread": { "id": "t1", "title": "do the thing", "status": "done", "answered": true },
        });
        let card = card_params(&settled, Some("scratch")).expect("the scratch board earns a card");
        assert_eq!(card["key"], "scratch-card:t1");
        assert_eq!(card["workspace"], "scratch");
        assert_eq!(card_params(&settled, Some("project")), None);
        assert_eq!(card_params(&settled, None), None);

        let failed = json!({
            "type": "thread.settled", "workspace": "scratch", "at": 1,
            "thread": { "id": "t2", "title": "do the other thing", "status": "failed", "answered": false, "error": "the model returned nothing" },
        });
        let markdown = card_params(&failed, Some("scratch")).unwrap()["markdown"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(markdown.contains("ended without an answer"));
        assert!(markdown.contains("the model returned nothing"));
    }
}

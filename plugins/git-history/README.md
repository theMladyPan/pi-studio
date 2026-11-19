# git-history

A plugin for pi-studio that draws a workspace's git history on the board: compact rows a line high, real
lanes for the merges and the forks between them, the branch and tag labels beside each commit, and a
details pane with the files a commit changed and the patch of the one that was picked.

It is a plugin, so it lives in its own folder and talks to the daemon over the plugin line protocol. It
runs `git` itself, read-only, and it holds no credentials: no token, no URL, no route into the daemon.

## Building and checking it

Needs Go 1.22 or newer and `git` on `PATH`. No third-party modules are used.

```sh
cd plugins/git-history
gofmt -l .                      # should print nothing
go vet ./...
go test ./...                   # history, lanes, paging, patches, the pipe, the handshake
go build -o git-history .       # the executable a daemon is registered with
node scripts/e2e.mjs            # the built binary, on real repositories, with a fake daemon
```

`scripts/e2e.mjs` is a script rather than a `node --test` file on purpose: it needs the built binary, so it
runs when someone asks for it, not on every test run of the daemon. It takes the binary as its one
argument and defaults to `./git-history`.

## Registering it with a daemon

The daemon starts an executable named by absolute path in its own `plugins.json`. Global records live under
`~/.local/state/pi-studio`, so the file is `~/.local/state/pi-studio/plugins.json` unless
`$XDG_STATE_HOME`, `$PI_STUDIO_STATE` or `--state` moved that folder. The folder the executable sits in is
also the folder its panel's files are served from, so build it where it will stay:

```sh
cd plugins/git-history
go build -o git-history .
```

`plugin.json` beside the executable is this plugin's own manifest. It names the version the handshake
answers with, and the panel the board may show, in the words the daemon's registration uses:

```json
{
	"name": "git-history",
	"version": "0.1.0",
	"protocol": 1,
	"visual": {
		"title": "git history",
		"entry": "assets/history.html",
		"files": ["assets/history.html", "assets/history.css", "assets/history.js"]
	}
}
```

A registration that offers this panel copies that `visual` block as it stands, and points `command` at the
executable the build wrote:

```json
{
	"plugins": [
		{
			"name": "git-history",
			"command": "/absolute/path/to/plugins/git-history/git-history",
			"args": [],
			"visual": {
				"title": "git history",
				"entry": "assets/history.html",
				"files": ["assets/history.html", "assets/history.css", "assets/history.js"]
			}
		}
	]
}
```

- `name` — how the daemon logs this plugin, and how its panel is addressed.
- `command` — the absolute path of an executable, spawned directly. A relative path or a bare name is
  refused, because both would be resolved against something the installer does not control.
- `args` — a list of strings, and nothing in it becomes another command.
- `visual` — optional. Without it the plugin runs and the board offers no door for it.
  - `title` — one line of 1 to 80 characters, shown on the door and in the panel's bar.
  - `entry` — the document the frame loads.
  - `files` — every file the daemon will serve for this panel, and nothing beside them: the request path
    is looked up in this list rather than joined to a folder. It has to include `entry`.

Both paths are relative to the folder the executable sits in. A declared file that is absolute, climbs out
of that folder, or is not a plain file there is refused when the registration is read, so a panel that
points at nothing is a line in the daemon's log at startup rather than a door that fails when pressed.

The daemon serves a panel's files from its own registration and never from the manifest, so the two blocks
above have to say the same thing. `assets` below is this plugin's own answer on the same list, which is
what the tests compare against the folder.

### In an installed release

A release ships this plugin ready to run: `plugins/git-history` beside the app, with its manifest, its panel
and a prebuilt executable for Linux and macOS on x86_64 and arm64. Registering it there is one row, and no Go
toolchain is involved:

```json
{
	"plugins": [
		{ "name": "git-history", "bundled": "git-history" }
	]
}
```

`bundled` names the folder this install carries. The daemon runs
`plugins/git-history/git-history-<platform>` — `git-history-linux-x64`, `git-history-darwin-arm64` and the
other two — and takes the panel from this folder's `plugin.json`, so there is no `command` and no `visual`
to copy. A row that names both `bundled` and `command`, or a bundled row that also names `visual`, is
refused rather than half read. The full rules are in `docs/plugins.md`.

## What the plugin speaks

One JSON-RPC 2.0 message per LF-terminated line, in both directions, frames of at most 1 MiB.

The daemon asks:

- `initialize` `{ protocolVersion: 1, plugin, client }` → `{ protocolVersion: 1, name, version, visual }`.
  Another protocol version is refused with `-32000`, so a mismatch is found at startup.
- `visual.request` `{ workspace, method, params }` → that method's answer, or a JSON-RPC error.
  `workspace` is a workspace id the daemon knows; the plugin never accepts a folder.
- `shutdown` (notification) → the process ends.

The plugin asks the daemon, over the same pipe:

- `workspace.list` `{}` → `{ workspaces: [ { id, name, folder, missing, scratch } ] }`. This is what a
  request that only needs the folder uses.
- `workspace.read` `{ workspace }` → `{ workspace, open, cards }`. Only `summary` uses this, because it is
  the one answer that says something about the board.

Requests are handled on their own goroutine, so a handler waiting for one of those answers does not stop
the read loop from reading it. The `visual.request`s below may therefore be called concurrently.

## The methods the view calls

`summary` `{}` — the workspace, whether its board is open, how many cards it holds, and where HEAD points.

`history` `{ offset?, limit? }` — a page of rows. `limit` defaults to 40 and is clamped at 200; `offset`
defaults to 0. The answer carries `repo`, `rows`, `laneCount` and `page`. Each row is one commit:

```json
{
	"sha": "…", "short": "…", "parents": ["…"], "author": "…", "email": "…", "at": 1704164645,
	"subject": "…", "lane": 0, "cols": 1, "up": true, "root": false, "head": true,
	"refs": [{ "kind": "branch", "name": "main" }],
	"edges": [{ "from": 0, "to": 1, "kind": "fork" }]
}
```

`lane` is the commit's column, fixed for the row. `up` says a line reaches the commit from the row above;
a commit with parents draws a line down from its column. `edges` are the other lines crossing the row: a
`pass` keeps its column, a `merge` bends from a column above into this commit, a `fork` bends out of this
commit into a column below. Columns are absolute, so consecutive pages line up, and a renderer can draw
each row on its own. `page` carries `offset`, `limit`, `hasMore`, `next`, `scanned` and `total` (null when
the walk stopped on its bound before it saw the end of the history).

`commit` `{ sha }` — one commit: message, author, committer, parents, labels, and the files it changed
against its first parent, as `{ status, path }` with git's `A`/`M`/`D`/`T` letter.

`diff` `{ sha, path, context? }` — one file's patch against the commit's first parent (`parent` is empty
for a root commit, which is diffed against the empty tree), plus `added`, `removed`, `binary` and
`truncated`. A patch is cut at 512 KiB and says so.

`assets` `{}` — the panel's files as `{ root, entry, files: [{ path, has }] }`, every path relative to the
executable, with whether each one is really there.

A refusal carries a standard code: `-32602` for params, a workspace or a revision the plugin cannot use,
`-32601` for a method it does not answer, `-32000` when the daemon did not answer a call in time.

## What the page needs from the board

The page in `assets/history.html` is served by the daemon and shown by the board in a frame sandboxed with
`allow-scripts` and nothing else, so its document has an opaque origin: it holds no cookie of the daemon,
it cannot read the board around it, and it makes no request of its own. Its one way out is
`window.postMessage` to the board above it, in the board's own words:

- board → page: `{ type: "pi-studio.host.hello", nonce, plugin }`. The page starts reading when this
  arrives, and keeps the `nonce` every later message has to carry.
- page → board: `{ type: "pi-studio.visual.request", nonce, id, method, params }`. The board asks the
  daemon with `{ workspace, method, params }` and answers with the same `id`. The workspace is the board's
  own, resolved by the daemon from its list, and the plugin is the one whose panel is on screen, so the
  page names neither.
- board → page: `{ type: "pi-studio.visual.result", nonce, id, result }` or
  `{ type: "pi-studio.visual.error", nonce, id, error: { code, message } }`. The `code` is the JSON-RPC
  code of the refusal, `-32602` for params or a workspace this plugin will not take, and the page shows its
  `message` beside the graph.
- page → board: `{ type: "pi-studio.visual.close", nonce }`, which puts the panel away. The close button
  in the bar sends it; the board's own close does the same without asking the page.

The greeting is the one message with no secret in it, and every other message is ignored unless it carries
the `nonce` the page was given. A message from any window but `window.parent` is ignored as well.

The frame imposes two rules on the files themselves. The daemon serves them with no CORS header, and the
document has an opaque origin, so the page loads a classic script (`<script src="history.js">`) and never a
module, whose fetch would be a cross-origin request the daemon refuses. And the served document carries
`sandbox allow-scripts`, so the page has no storage, no cookie and no request of its own: everything it
knows it asked the board for.

## What it will not do

- It never writes to a repository. Every command is read-only (`log`, `for-each-ref`, `rev-parse`,
  `symbolic-ref`, `show`, `diff`, `diff-tree`), run with `GIT_OPTIONAL_LOCKS=0` so not even the index lock
  is taken.
- Arguments are fixed lists written in Go, with the folder passed as the value of `git -C`. A revision is
  accepted only as 4 to 64 hexadecimal characters, and a path is passed after `--`, so nothing a request
  says can become an option or another command.
- Every command has a deadline (5 s for a probe, 10 s for a commit or a patch, 15 s for a walk) and an
  output budget, so a huge repository costs a slow answer rather than the daemon's memory.
- A walk reads at most 5000 commits and reports `scanned`; an offset past that is answered with a note
  instead of a minute of reading.
- Renames are not followed: a rename is shown as the deletion and the addition it looks like with
  `--no-renames`.
- A merge is read against its first parent, and the details pane says so.

## Limits of this first version

- A page past the newest 5000 commits cannot be asked for; narrowing the graph is not built yet.
- There is no file history, no blame and no comparison between two commits: one page of the graph, one
  commit, one patch.
- Nothing here watches the repository. The view reads again when the reader asks for it with `refresh`.

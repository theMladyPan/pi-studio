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

The daemon starts an executable named by absolute path in its own `plugins.json`
(`~/.pi/agent/state/pi-studio/plugins.json` by default, `$PI_STUDIO_STATE` if that is set):

```json
{
	"plugins": [{ "name": "git-history", "command": "/absolute/path/to/plugins/git-history/git-history", "args": [] }]
}
```

`plugin.json` beside the executable is this plugin's own manifest. It names the version the handshake
answers with and the files its view is made of, all relative to the executable:

```json
{
	"name": "git-history",
	"version": "0.1.0",
	"protocol": 1,
	"visual": {
		"entry": "assets/history.html",
		"styles": ["assets/history.css"],
		"scripts": ["assets/history.js"]
	}
}
```

A path that is absolute or climbs out of the plugin folder is refused at startup.

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

`assets` `{}` — the view's files as `{ root, entry, files: [{ path, kind, has }] }`, every path relative
to the executable, which is what a host serves from.

A refusal carries a standard code: `-32602` for params, a workspace or a revision the plugin cannot use,
`-32601` for a method it does not answer, `-32000` when the daemon did not answer a call in time.

## What the page needs from the host

The page in `assets/history.html` is served by the host, and it reaches the plugin only through the host.
It takes one message protocol on `window.postMessage`, with `plugin: "git-history"` in every message:

- host → page: `{ type: "pi-plugin:hello", plugin, nonce, workspace? }`. The page starts reading when
  this arrives.
- page → host: `{ type: "pi-plugin:request", plugin, nonce, id, method, params }`. The host forwards
  `{ workspace, method, params }` as a `visual.request` and answers with the same `id`.
- host → page: `{ type: "pi-plugin:result", plugin, nonce, id, result }` or
  `{ type: "pi-plugin:error", plugin, nonce, id, error }`.

Anything without the nonce the page was given is ignored. The page holds no token and makes no request of
its own: it has no way to reach the daemon, which is why a host must open this channel for it.

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

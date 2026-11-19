# Plugins

A plugin is a separate program the daemon starts and talks to over its own pipes. It can read a board,
post a note, drive a thread, follow the runs on a board, and put a page of its own on the board. It runs
as you, with your privileges, and it is never installed, updated or started by anything but you.

## The trust model

- **You register a plugin, in the daemon's own folder.** The daemon reads `<state dir>/plugins.json`,
  which is `~/.local/state/pi-studio/plugins.json` unless `--state` or `PI_STUDIO_STATE` moved it. No
  workspace, board, thread or dropped file is read for this, and a `plugins.json` inside a project is
  ignored.
- **No registration, no process.** The daemon starts exactly the rows in that file, when it starts. A
  release that ships a plugin still starts nothing until a row names it.
- **No permission prompts, no downloads.** A plugin's program has to be on the disk already: the path of
  an executable, or the name of a plugin this install carries. The daemon never fetches, builds or
  updates one.
- **Same user, no credentials.** A plugin is spawned directly, never through a shell, with an
  allowlisted environment: `PATH`, `HOME`, the locale and the temp folder, and nothing else. The daemon's
  token, its URL and its browser sessions are not passed to it. This is a guard against leaking secrets
  by accident, not a sandbox: what your user can do, the plugin can do.
- **One process per plugin, outside the daemon.** A plugin that hangs, floods its output or dies is
  written off with a reason and the rest keep running. A stopped daemon tells every plugin to stop.

## Registering one

`plugins.json` holds one list of rows:

```json
{
  "plugins": [
    { "name": "git-history", "bundled": "git-history" },
    { "name": "scratch-card", "command": "/absolute/path/to/pi-studio-scratch-card", "args": [] }
  ]
}
```

- `name` — how the daemon logs the plugin, how its panel is addressed, and the name its events are sent
  under. A name used twice is refused.
- `command` — an absolute path to an executable. A relative path and a bare program name are both
  refused: one would resolve against the folder the daemon happens to be in, the other against a `PATH`
  somebody else may own.
- `bundled` — the name of a plugin this install ships, under `plugins/` beside the app. The program and
  the panel come from that folder, so this is the whole row. A row may carry `bundled` or `command`, not
  both, and a bundled row takes no `visual` of its own. The daemon runs
  `plugins/<name>/<name>-<platform>` when the release built one for this machine (for example
  `git-history-linux-x64`), and otherwise `plugins/<name>/<name>`, which is a binary built in place in a
  checkout.
- `args` — a list of strings, passed as they are. Nothing in it becomes another command.
- `visual` — optional, and only on a `command` row: the panel the board may show for this plugin. See
  below.

A row that cannot be used is a line in the daemon's log at startup, saying which row and why, and the
other rows still start. Restart the daemon to pick up a change: the file is read when plugins start, not
watched.

## What the daemon offers a plugin

One JSON-RPC 2.0 message per line, in both directions, frames of at most 1 MiB, protocol version 1. The
daemon sends `initialize` first and refuses a plugin that answers another version, then `visual.request`
for whatever a panel asks, then `shutdown` on its way out. The code is `server/plugins/protocol.ts` and
`server/plugins/host.ts`.

A plugin asks the daemon over the same pipe, and each answer is a call into the daemon's own services:

| method | params | answer |
| --- | --- | --- |
| `workspace.list` | `{}` | `{ workspaces: [ { id, name, folder, missing, scratch } ] }` |
| `workspace.read` | `{ workspace }` | `{ workspace, open, cards }` |
| `cards.note` | `{ workspace, markdown, title?, key?, size?, after? }` | `{ cardId, card, updated?, report? }` |
| `threads.list` | `{ workspace }` | `{ workspace, threads: [ … ] }` |
| `threads.create` | `{ workspace, title?, mode?, provider?, model?, thinking?, type?, after? }` | `{ workspace, threadId, thread }` |
| `threads.prompt` | `{ workspace, thread, text, mode? }` | `{ workspace, thread, turn }` |
| `threads.stop` | `{ workspace, thread }` | `{ workspace, stopped }` |
| `events.subscribe` | `{ types: [ … ] }` | `{ types }` |

A workspace is always an id the daemon already knows, resolved from its own list; a plugin never names a
folder and never receives one it asked for by path. `cards.note`, `threads.create`, `threads.prompt` and
`threads.stop` write what the human's own routes write, and are refused what those routes refuse. The
exact params, the events and the refusal codes are documented at the top of `server/plugins/service.ts`.

The daemon sends two notifications, to the plugins that asked for that type:

- `thread.settled` — a run has ended, and whether it ended on an answer, a stop or a failure.
- `thread.stream` — a running answer as it is written, at the pace the card is repainted.

## A panel on the board

A plugin with a `visual` gets a door in the board's toolbox. Pressing it loads the plugin's own page into
a frame sandboxed with `allow-scripts` and no `allow-same-origin`, so the document has an opaque origin:
no cookie, no storage, no request of its own. The daemon serves only the files the panel declared, each
one relative to the plugin's folder and each one a plain file there, and looking a request up in that
list rather than joining a path.

The page and the board trade five messages: `pi-studio.host.hello` with a nonce, `pi-studio.visual.request`
with that nonce and an id, `pi-studio.visual.result` or `pi-studio.visual.error` with the same id, and
`pi-studio.visual.close`. The board adds the workspace, resolved by the daemon from its own list, so the
page names neither a folder nor a plugin. The full shapes are in `docs` at the top of
`server/routes/plugins.ts` and in the panel example `test-support/plugin-visual/`.

## The two plugins here

`plugins/git-history` draws a workspace's git history: compact rows, connected lanes, branch and tag
labels, and a details pane with a commit's files and one file's patch. It is written in Go, runs `git`
read-only with fixed arguments, deadlines and output budgets, and never writes to a repository.

```sh
cd plugins/git-history
go test ./...                 # history, lanes, paging, patches, the pipe, the handshake
go build -o git-history .     # a binary beside plugin.json, which is what a checkout registers
node scripts/e2e.mjs          # the built binary on real repositories, with a fake daemon
```

`examples/plugins/scratch-card` is a Rust plugin that writes one note on the scratch board for every run
that ends there. It is the example that proves a language other than Go works against the same protocol.

```sh
cd examples/plugins/scratch-card
cargo build --release
cargo test
```

Each has its own README with the exact registration, the methods it calls and what it refuses to do.

## What a release ships

An installed release carries `plugins/git-history` with its manifest, its panel and a prebuilt executable
for Linux and macOS on x86_64 and arm64, so enabling it needs no Go toolchain:

```json
{ "plugins": [{ "name": "git-history", "bundled": "git-history" }] }
```

`npm run build:plugins` cross-builds those four files (`bin/build-plugins.mjs`), and `npm run package`
stages them from `plugins/*/dist/` into the archive beside the plugin's manifest. They stay in the single
platform-neutral tarball; the daemon picks the file that matches the machine. The Rust example is not
shipped: it is an example to build from its source.

## Next steps

- **Choosing which panel is on screen.** Today every plugin with a panel gets a door, and the newest one
  opened wins the frame. A workspace could remember the panel it was left on, and the board could offer
  one door per workspace instead of one per plugin.
- **Declaring what a plugin may do.** The daemon answers all eight methods for every plugin. A row could
  name the ones it wants — read only, notes but no threads — and the daemon would refuse the rest.
- **Reporting plugins where the other gaps are reported.** `pi-studio doctor` names Node, git, pi and the
  git drawer's copy. It could list the registered plugins, what each one answers, and the rows that did
  not start.
- **A helper for the registration.** Writing `plugins.json` by hand is the whole install step for a
  bundled plugin. A `pi-studio plugins` command could list the shipped ones and write the row.
- **Per-plugin settings.** A row can carry `args`, and nothing else about a plugin's own configuration
  reaches it, so a plugin that needs a token or a folder has to be told in its own file.

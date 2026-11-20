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

The easiest way in is `pi-studio add <git-url>`: it clones the plugin's repository into the plugins
folder (`<state dir>/plugins/<name>/`), builds it when it is Rust (`Cargo.toml` runs `cargo build
--release`), and leaves it for the settings page to enable — the page scans the folder when it opens,
so no daemon restart is needed. Adding one already installed pulls and rebuilds instead, and keeps
whatever the human registered. A repository without a `plugin.json` is refused and its clone removed.

Otherwise `plugins.json` holds one list of rows:

```json
{
  "plugins": [
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
  `plugins/<name>/<name>-<platform>` when the package built one for this machine (for example
  `example-panel-linux-x64`), and otherwise `plugins/<name>/<name>`, which is a binary built in place in a
  checkout. This repository ships no plugin of its own, so a row here is normally a `command` row.
- `installed` — the same one word for a folder the human put in the plugins folder,
  `<state dir>/plugins/<name>/` (`~/.local/state/pi-studio/plugins/<name>/` unless `--state` moved it).
  It lives in state rather than beside the app, so an installed plugin survives an update and an
  uninstall. It is shown in settings as available to enable.
- `args` — a list of strings, passed as they are. Nothing in it becomes another command.
- `visual` — optional, and only on a `command` row: the panel the board may show for this plugin. See
  below.

A row that cannot be used is a line in the daemon's log at startup, saying which row and why, and the
other rows still start. The settings page writes the file and restarts the roster in place; the file is
read when plugins start, never watched.

## What the daemon offers a plugin

One JSON-RPC 2.0 message per line, in both directions, frames of at most 1 MiB, protocol version 1. The
daemon sends `initialize` first and refuses a plugin that answers another version, then `visual.request`
for whatever a panel asks, then `shutdown` on its way out. The code is `server/plugins/protocol.ts` and
`server/plugins/host.ts`.

A plugin that lives in its own folder declares itself in a `plugin.json` beside its executable — the
plugin's responsibility, not the registry's. It carries its name, version, protocol and protocol minor,
the smallest pi-studio it works with, its title and description, the folder-relative command, default
args, one suggested shortcut, `start` (`"eager"` or `"lazy"`, see below), and its `visual` when it has
a panel. Unknown keys are ignored, so a newer plugin's manifest is still readable by an older daemon.
The daemon proves the manifest at read time, without starting anything, and refuses a row whose manifest
asks for a protocol or a pi-studio newer than itself.

`start: "lazy"` registers the plugin without spawning it: its door and panel serve from disk as usual,
and the first panel request starts the process. It suits a plugin that only answers a door. A plugin
that watches the world or listens for events declares `"eager"` — the default — and starts with the
roster at boot, because nothing would ever wake it. A lazy plugin with no panel is refused.

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

The shapes of those eight methods, the two events and `initialize` are frozen while the protocol version
is 1: they may gain fields and new methods, but a field may never be removed, renamed or reshaped
without a protocol 2. Unknown keys on either side are ignored, which is what makes that promise keepable.

The daemon sends two notifications, to the plugins that asked for that type:

- `thread.settled` — a run has ended, and whether it ended on an answer, a stop or a failure.
- `thread.stream` — a running answer as it is written, at the pace the card is repainted.

## A panel on the board

A plugin with a `visual` gets a door in the board's toolbox. Pressing it loads the plugin's own page into
a frame sandboxed with `allow-scripts` and no `allow-same-origin`, so the document has an opaque origin:
no cookie, no storage, and no call of its own. The daemon serves only the files the panel declared, each
one relative to the plugin's folder and each one a plain file there, and looking a request up in that
list rather than joining a path. Those files are served without asking for a credential, because a
document with an opaque origin has none to send: what they hold is a page, a script and a style, never a
workspace's data. The list of doors and the one call a panel makes are the human's, and need the session
the printed link left.

The page and the board trade five messages: `pi-studio.host.hello` with a nonce, `pi-studio.visual.request`
with that nonce and an id, `pi-studio.visual.result` or `pi-studio.visual.error` with the same id, and
`pi-studio.visual.close`. The board adds the workspace, resolved by the daemon from its own list, so the
page names neither a folder nor a plugin. The full shapes are in `docs` at the top of
`server/routes/plugins.ts` and in the panel example `test-support/plugin-visual/`.

A panel is in the toolbox by default. Giving its `visual` the place `"drawer"` puts it in the left
drawers' column instead, beside files, activity and cards: the board draws its pane with the rail's own
head and close button, sizes it with the rail grip, and puts its door in the header with activity and
cards. The files a drawer panel is served, and the one call it may make, are the same either way.

## The example plugin

`examples/plugins/scratch-card` is a Rust plugin that writes one note on the scratch board for every run
that ends there. It is the worked example of the protocol from a language other than Go, and it carries
the exact registration, the methods it calls and what it refuses to do.

```sh
cd examples/plugins/scratch-card
cargo build --release
cargo test
```

Its own README is the walk-through; the two check scripts beside it run the built binary against a fake
daemon and against the daemon's own service layer.

The tests in this repository use fixtures rather than a shipped plugin: `test-support/plugin-visual/` is
a panel plugin with a page, a script and a style, and `test/plugins-bundled.test.ts` builds the layout a
package ships in a throwaway folder. Nothing in `plugins/` is needed to run the board or its checks.

## What a package of pi-studio may ship

A package can add one folder per plugin under `plugins/`: a `plugin.json`, the panel's files, and the
executables built for each platform. An install then enables it with one row and needs no toolchain for
it:

```json
{ "plugins": [{ "name": "example-panel", "bundled": "example-panel" }] }
```

`npm run build:plugins` cross-builds the executables of any plugin folder holding a `go.mod`
(`bin/build-plugins.mjs`), and a plugin in another language brings its own build step. `npm run build`
stages `plugins/<name>/` into the tree an install copies: the manifest, the panel and every built file
from `plugins/<name>/dist/`. They stay in the single
platform-neutral tarball; the daemon picks the file that matches the machine. The Rust example is not
staged: it is an example to build from its own source.

## Next steps

- **Choosing which panel is on screen.** Today every plugin with a panel gets a door, and the newest one
  opened wins the frame. A workspace could remember the panel it was left on, and the board could offer
  one door per workspace instead of one per plugin.
- **Declaring what a plugin may do.** The daemon answers all eight methods for every plugin. A row could
  name the ones it wants — read only, notes but no threads — and the daemon would refuse the rest.
- **Reporting plugins where the other gaps are reported.** `pi-studio doctor` names Node, git and pi. It
  could list the registered plugins, what each one answers, and the rows that did not start.
- **A helper for the registration.** Writing `plugins.json` by hand is the whole install step for a
  bundled plugin. A `pi-studio plugins` command could list the shipped ones and write the row.
- **Per-plugin settings.** A row can carry `args`, and nothing else about a plugin's own configuration
  reaches it, so a plugin that needs a token or a folder has to be told in its own file.

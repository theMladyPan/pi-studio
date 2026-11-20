# bughound

An optional pi-studio plugin in Rust that watches a workspace folder for file changes and, when a file
a test covers changes, immediately runs the targeted pytest for it.

It is an example like `examples/plugins/scratch-card` — a program you name yourself in `plugins.json`.
No daemon registers it, ships it or looks for it on its own. The plugin system as a whole — the
protocol, the registration, the methods and the panel a plugin can put on a board — is documented in
`docs/plugins.md`.

## What it does

The daemon starts the program, calls `initialize` on it, and from then on the two talk over the same
pipes, one JSON object per line. This plugin:

1. answers the handshake with `{ "protocolVersion": 1, "name": "bughound", "version": … }`;
2. calls `workspace.list` and watches every non-scratch workspace it learns there (told apart by the
   `--workspace` args when it is told any);
3. polls those folders every `--interval-ms` (2000 by default), and when a `.py` file or a pytest
   configuration file changes, waits `--debounce-ms` (500) for the edits to settle and then runs the
   tests that cover the change;
4. resolves a change to its tests by scanning Python imports — a test file runs itself, a source file
   runs the tests that import it, a `conftest.py` change runs its folder's tests, and a configuration
   change runs the whole suite. A file nothing covers is reported as such, and no test is spawned for it.

The plugin keeps the watch and the running on threads of their own, so when the panel asks how it is
going it is answered from shared state at once, even mid-run. The panel is a left drawer, with the
rail's own head, door and buttons: its state, its last run, the pending files and the last log.

## Build it

```sh
cd examples/plugins/bughound
cargo build --release
```

The binary lands at `target/release/pi-studio-bughound`, with its panel next to it in
`target/release/assets/` — `build.rs` copies the three panel files there, so the build is the whole
install step. `Cargo.lock` is committed, so the build pins the same `serde_json` this example was
written against.

## Register it

This plugin declares itself in the `plugin.json` beside its source, so the simplest registration is
the settings page: copy this whole folder into `~/.local/state/pi-studio/plugins/bughound/`, open the
board's settings, and enable it there — the row takes the manifest's defaults (the drawer panel, the
`b` shortcut). Nothing starts until you enable it.

The hand-written way still works: the daemon reads its roster when it starts, from `plugins.json` in
its state folder — by default `~/.local/state/pi-studio/plugins.json`, or `$PI_STUDIO_STATE/plugins.json`
when the daemon was started with its own state folder. Add one row, with the absolute path of the binary
you just built and the panel it carries, in the left drawers:

```json
{
  "plugins": [
    {
      "name": "bughound",
      "command": "/absolute/path/to/examples/plugins/bughound/target/release/pi-studio-bughound",
      "args": ["--interval-ms", "2000", "--debounce-ms", "500"],
      "visual": {
        "title": "bughound",
        "place": "drawer",
        "entry": "assets/panel.html",
        "files": ["assets/panel.html", "assets/panel.js", "assets/panel.css"]
      }
    }
  ]
}
```

`command` has to be an absolute path to an executable file; a bare name or a relative path is refused
when the roster is read. A plugin that did not start says so in the daemon's log, as
`pi-studio: plugin bughound did not start: …` followed by the reason.

To stop using it, remove the plugin in settings, or take the row out of `plugins.json` and restart the
daemon.

The args, all optional:

- `--interval-ms <n>` — how often the folders are scanned. Minimum 250.
- `--debounce-ms <n>` — how long the edits have to settle before a run.
- `--timeout-s <n>` — a run that does not finish in this time is killed.
- `--workspace <id-or-name-or-folder>` — repeatable; watch only these. Without it, every non-scratch
  workspace is watched.
- `--pytest <program>` — the test program. Without it, the plugin runs a project's `.venv/bin/pytest`,
  its venv's `python -m pytest`, or `pytest` on the PATH, in that order.
- `--pytest-arg <arg>` — repeatable; fixed flags before pytest's own.
- `--post-failures` — off by default. When set, a run that turns failing or passing again revises one
  card per workspace with the result.

## Check it

```sh
cargo test                                              # the plugin's own tests, no pipes involved
BUGHOUND_BIN=$PWD/target/release/pi-studio-bughound \
  node --test check/against-host.mjs                     # the real PluginHost, a fake pytest
BUGHOUND_BIN=$PWD/target/release/pi-studio-bughound \
  node --test check/against-service.mjs                  # the real roster, service and board
```

`against-host.mjs` watches a throwaway Python project through the real `PluginHost` and asserts that
editing a source file runs the test that imports it and that a failing run is reported by node id.
`against-service.mjs` registers the plugin the way the daemon does, with its panel placed in the
drawers, and asserts that a failing run leaves the one card `--post-failures` promised. Both run
against a fake `pytest`, so no Python environment is needed to check either.

## What it is not

This is not a sandbox or a template for reading anything you like. A plugin runs as you, with an
allowlisted environment, and it can do whatever your user can do; what the daemon offers it is the
eight methods in `server/plugins/service.ts`, and this example uses two of them (`workspace.list` and
`cards.note`, the latter only with `--post-failures`). Dynamic imports, data files and C extensions are
invisible to a static reading of imports, so a change to one of those reports that no tests cover it
rather than guessing — the panel's run-all runs the whole suite regardless.

One trust decision is called out rather than hidden: with no `--pytest`, the plugin runs the watched
folder's own `.venv/bin/pytest` (or its venv's `python -m pytest`) when it finds one, and that binary
runs with your privileges on every change, as it would if you ran pytest there yourself. A folder you
would not run a command out of should be left unwatched; `--pytest` names the program instead.

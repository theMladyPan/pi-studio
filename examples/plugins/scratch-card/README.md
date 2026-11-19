# scratch-card

An example pi-studio plugin, in Rust, that writes one note on the scratch board for every run that
ends.

It is an example and nothing else. No daemon registers it, ships it or looks for it: a plugin is a
program you name yourself in `plugins.json`, by the absolute path of an executable on this machine.

## What it does

The daemon starts the program, calls `initialize` on it, and from then on the two talk over the same
pipes, one JSON object per line. This plugin:

1. answers the handshake with `{ "protocolVersion": 1, "name": "scratch-card", "version": … }`;
2. calls `events.subscribe` for `thread.settled`, the one event a daemon sends;
3. calls `workspace.list` and keeps the id of the row that says `"scratch": true`;
4. for every run that ends on that board, calls `cards.note` with `key: "scratch-card:<thread id>"`.

The key is what makes the card stable: `cards.note` revises the card a key names, so a thread that
settles five times leaves one note rather than five. A run on any other workspace is left alone, and a
daemon that never names a scratch board gets no card at all. A plugin that guessed would leave notes in
somebody's project.

The methods, their params and their answers are documented at the top of `server/plugins/service.ts`.
The wire format is `server/plugins/protocol.ts`.

## Build it

```sh
cd examples/plugins/scratch-card
cargo build --release
```

The binary lands at `target/release/pi-studio-scratch-card`. `Cargo.lock` is committed, so the build
pins the same `serde_json` this example was written against.

## Register it

The daemon reads its roster when it starts, from `plugins.json` in its state folder — by default
`~/.local/state/pi-studio/plugins.json`, or `$PI_STUDIO_STATE/plugins.json` when the daemon was
started with its own state folder. Add one row, with the absolute path of the binary you just built:

```json
{
  "plugins": [
    {
      "name": "scratch-card",
      "command": "/absolute/path/to/examples/plugins/scratch-card/target/release/pi-studio-scratch-card",
      "args": []
    }
  ]
}
```

Then restart the daemon. `command` has to be an absolute path to an executable file; a bare name or a
relative path is refused when the roster is read. A plugin that did not start says so in the daemon's
log, as `pi-studio: plugin scratch-card did not start: …` followed by the reason.

To stop using it, take the row out of `plugins.json` and restart the daemon.

## Check it

```sh
cargo test                                              # the plugin's own tests, no pipes involved
SCRATCH_CARD_BIN=$PWD/target/release/pi-studio-scratch-card \
  node --test check/against-host.mjs                     # the real PluginHost, a stand-in daemon
SCRATCH_CARD_BIN=$PWD/target/release/pi-studio-scratch-card \
  node --test check/against-service.mjs                  # the real roster, service, board and settle seam
```

`against-service.mjs` is the whole loop a daemon runs, minus HTTP: it writes a throwaway state folder,
registers the binary there, starts it the way the daemon does, announces a settled run on the scratch
board and on a project board, and asserts that exactly one note lands on the former and the latter is
not opened at all. Both checks skip nothing: they fail when the binary is missing.

## What it is not

This is not a sandbox or a template for reading anything you like. A plugin runs as you, with an
allowlisted environment, and it can do whatever your user can do; what the daemon offers it is the four
methods in `service.ts`.

# An example plugin with a panel

A plugin is a program the human installs and the daemon runs. This one is also a page: it declares a
`visual` panel, and the board's toolbox gets a door that shows that page in a sandboxed frame.

The executable is `panel-plugin.mjs`. It answers the daemon's `initialize` handshake and the one method a
panel's call arrives as, `visual.request`, whose params are `{ workspace, method, params }`: `workspace` is
the id the daemon resolved from its own list, and `method` and `params` are what the panel asked for. It
answers with its own JSON-RPC result, or refuses with an error the panel reads.

To try it, register it in the daemon's own state folder — `~/.local/state/pi-studio/plugins.json` unless
`--state` moved that folder — and restart the daemon:

```json
{
  "plugins": [
    {
      "name": "example-panel",
      "command": "/absolute/path/to/test-support/plugin-visual/panel-plugin.mjs",
      "args": [],
      "visual": {
        "title": "example panel",
        "entry": "panel.html",
        "files": ["panel.html", "panel.js", "panel.css"]
      }
    }
  ]
}
```

The row's keys, and what each one is:

- `name` — how the plugin is called in the daemon's log, in its roster, and in the address of its panel.
  One name is one plugin, so it appears once.
- `command` — the absolute path of the executable. It is spawned directly, never through a shell; a bare
  name or a relative path is refused, because both would be resolved against something the installer does
  not control.
- `args` — the arguments it starts with. A list of strings, and nothing in it becomes another command.
- `visual` — optional. Without it the plugin runs and has no door on the board.
  - `title` — one line, 1 to 80 characters, shown on the door and in the panel's bar.
  - `entry` — the document the frame loads, relative to the folder the executable sits in.
  - `files` — every file the daemon will serve for this panel, relative to that same folder. It has to
    include `entry`. Nothing beside these files is served, however it is spelled: the request path is
    looked up in this list rather than joined to a folder.
  - `place` — optional. `"drawer"` puts the panel in the left drawers' column behind a header door,
    beside files, activity and cards, instead of in the toolbox. Anything else is refused.

A declared file that is not a plain file inside the executable's folder — a `..` path, an absolute path, a
missing file, a symbolic link — is refused when the registration is read, and the row is reported as a
problem instead of becoming a plugin. A registration that cannot be used is a line in the daemon's log at
startup, not a door that fails later.

The page itself has one way out of its frame:

```js
// The board greets the panel with its secret once the page has loaded.
window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  // { type: "pi-studio.host.hello", nonce, plugin }
});

// A call to the plugin, settled by the answer the board posts back.
window.parent.postMessage({ type: "pi-studio.visual.request", nonce, id, method, params }, "*");
// { type: "pi-studio.visual.result", nonce, id, result }
// { type: "pi-studio.visual.error", nonce, id, error: { code, message } }

// Closing the panel, which the board does for its own close button too.
window.parent.postMessage({ type: "pi-studio.visual.close", nonce }, "*");
```

The frame is sandboxed with scripts and no origin of its own, so it is handed no token and no cookie, it
cannot read the board around it, and it makes no request of its own: `panel.js` here is the whole bridge.

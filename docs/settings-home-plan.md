# Plan: the shelf home screen with a settings page rendered from JSON

Picked mockups: `mockups/home-shelf.html` (the layout) and `mockups/home-shelf-settings.html` +
`mockups/settings.defaults.json` (the settings page and the document it renders). The mockups are the
design; this plan is what makes them real.

## The gate

`/tmp/gate/home-settings.mjs` boots a daemon against a scratch state folder seeded with
`{provider: klotilda, model: deepseek-ai/DeepSeek-V4.1-Flash-1017, thinking: high, dimOthers: false}`
and checks: the page is served and no longer carries the three-column markup; the client asks the
daemon for the settings document; `GET /settings/defaults` answers with version, three field leaves,
a filled model catalogue, every thinking level, a toggle and three levels of nesting; the seeded
choice migrated; `POST /defaults` still refuses an unrunnable model (409) and an unknown level (400)
and still saves a good value; `POST /workspace` still accepts a `~/` path.

Ran on the current tree: **16 of 22 checks red**, including a real bug — see below.

## The bug the gate found

`server/routes/crossroads.ts:60` assigns to `homeDefaults`, an imported binding:

```
GET /defaults                      -> 200, values read fine
POST /defaults {"thinking":"low"}  -> 500 "board error"
pi-studio: TypeError: Assignment to constant variable.
    at onDefaults (server/routes/crossroads.ts:60:15)
```

An ESM import is a constant, so **saving a default has never worked**. `STATE.md:649` claims it was
verified against a real daemon. It was not. The fix is a setter in the owning module, which is the
same change the settings page needs anyway.

## Contract

`GET /settings/defaults?token=…` answers `200` with

```json
{ "version": 1, "title": "New board defaults", "help": "…",
  "groups": [ { "id": "new-boards", "label": "New boards", "collapsed": false,
    "groups": [ { "id": "agent", "label": "Agent",
      "groups": [ { "id": "model-routing", "label": "Model & reasoning",
        "fields": [
          { "id": "model", "label": "model", "type": "combo",
            "value": "klotilda/deepseek-ai/DeepSeek-V4.1-Flash-1017",
            "options": ["klotilda/…", "…"], "source": "/models",
            "store": { "split": "/", "keys": ["provider", "model"] } },
          { "id": "thinking", "label": "thinking", "type": "select",
            "value": "medium", "levels": ["off", "minimal", "low", "medium", "high", "xhigh", "max"] } ] } ] } ] } ] }
```

- `groups` nests to arbitrary depth; every group has `id`, `label`, optional `help`, optional
  `status`, optional `collapsed`, and either `groups` or `fields` or both.
- A field has `id`, `label`, `type` (`combo` | `select` | `toggle` | `text` | `number`), `value`,
  optional `help`, `options`, `levels`, `source`, `placeholder`, `disabled`, and `store` when the
  stored key is not the field id.
- `POST /defaults` keeps its body and its answers: `{provider?, model?, thinking?, dimOthers?}`,
  `409` for a model this machine cannot run, `400` for a level pi does not name.
- One source of truth for the values: `workspaces.json#defaults`. The document is a *view* of it with
  the catalogue hydrated in. Nothing new is stored on disk.

## Slice 1 — the daemon (server/)

| file | change |
| --- | --- |
| `server/settings.defaults.json` | new. The template from `mockups/settings.defaults.json`: structure, labels, help, placeholder values only. No live catalogue, no live choice. |
| `server/settings.ts` | new. Reads the template, walks it, copies each leaf's `value` from `activeHomeDefaults()` using the leaf's `id` (or `store.keys`), fills `model.options` from `modelCatalog()` in pi's scope order and `thinking.levels` from `THINKING_LEVELS`. Exports `settingsDocument()`. Pure read: no writes, no caching beyond the module load. |
| `server/workspaces.ts` | `export function setHomeDefaults(next)` — the one place the binding may be written; it assigns and calls `saveWorkspaces()`. |
| `server/routes/crossroads.ts` | `onDefaults` uses `setHomeDefaults({ ...homeDefaults, ...patch })` instead of assigning the import. New `onSettingsDefaults(res)` answering 200 with `settingsDocument()`. |
| `server/main.ts` | route `GET /settings/defaults` beside `GET /defaults` (line ~206), same token gate as its neighbours. |
| `test/settings.test.ts` | new: the document's shape (version, three leaves found by id, ≥3 levels deep), hydration from a set `workspaces.json`, and that a catalogue entry the machine cannot run never appears in `model.options`. |
| `test/routes.test.ts` | add: `GET /settings/defaults` 200 and shaped; `POST /defaults {thinking:"low"}` 200 and read back through `/settings/defaults` — the regression the bug needs. |

JSON import: do not `import … with { type: "json" }`. Read `server/settings.defaults.json` with the
same `readJsonFile` helper the rest of the server uses, resolved from `import.meta.url`, so the file
needs no build step and no tsconfig change.

## Slice 2 — the client (public/welcome.*)

| file | change |
| --- | --- |
| `public/welcome.html` | replaced by the shelf markup plus the settings view from the chosen mockup: masthead with `pi-studio · N workspaces · M running` and `settings →`, the omnibar, the workspace list, the keyboard footer, and the settings view with its document head and tree. No `#crossroads` grid. |
| `public/welcome.css` | the mockup's stylesheet, minus the mockup-only pieces (the state pills). |
| `public/welcome.js` | one file, no new client modules: fetch `/workspaces` and keep it live on the `/events?scope=welcome` stream; filter as you type; a path-shaped entry opens through `POST /workspace`; Enter opens the selected board by name (`window.open(url, "pi-studio-<id>")` then `location.replace`, as today); `browse…` through `POST /pick-folder`; `settings →` fetches `/settings/defaults` and renders the tree generically — collapse state per dotted group path in `localStorage`, values written on change through `POST /defaults` using each field's `store` mapping, `409`/`400` shown on the field with a revert; `Esc`/`Alt+M` returns to the shelf. |

What must survive the rewrite, from the scout's map ([[crossroads-inventory]]): the token in every
request, the `EventSource` that keeps the counts honest, the named tab, the folder dialog, and the
keyboard handling that lets a human work without a mouse.

No new client module: `bin/check-imports.mjs` does not know `welcome.js`, so a split would 404 at
runtime with every check green ([[rewrite-risks]]). One file, or fix the check first; not both in one
commit.

## Out of scope

- Writing a new settings file on disk. `workspaces.json#defaults` stays the only store.
- The mockup's `Per-board overrides` group and its "not built yet" badge, the `mockup state` pills, and
  the hard-coded 6-workspace counts.
- The board's own settings panel (`dimOthers` per board), untouched.
- Anything the board page does. This is the crossroads only.

## Done means

1. `/tmp/gate/home-settings.mjs` green, every check.
2. `npm run check` green (syntax, import graph, tsc, node --test, smoke).
3. In a browser: the shelf lists real workspaces, typing filters, `~/…` opens a folder, `Enter` opens a
   board tab, `settings →` renders the tree from the daemon's document, closing groups survives a
   reload, and changing the thinking level says `saved` and survives a reload too.

## Addendum (asked for after the first pass): every prompt on the settings page

The settings page must carry **all** of the app's prompts: the files in `prompts/roles/`,
`prompts/modes/` and `prompts/flows/`. They already have a read and a guarded write route
(`GET /prompts`, `GET /prompt?name=`, `POST /prompt` in `server/routes/board/prompts.ts`), so this is
a document change and a control type, not a new store.

The document grows one top-level group after `new-boards`, collapsed by default:

```
Prompts                                   (collapsed)
  Roles        -> architect, chore, implement, review, scout
  Modes        -> boss, plan
  Flows        -> advanced, complex, simple
```

Each prompt file is one field:

```json
{ "id": "prompt-roles-implement", "label": "implement.md", "type": "prompt",
  "value": "<the whole file, verbatim>",
  "help": "<its first non-empty line>",
  "source": "/prompt?name=roles%2Fimplement.md",
  "write": { "route": "/prompt", "method": "POST", "keys": { "name": "roles/implement.md", "text": "@value" } } }
```

- The group tree is built from what is on disk when the document is read, so a prompt file added to
  `prompts/` appears on the page with no code change. Order: folders `roles`, `modes`, `flows`, and
  the files in each sorted by name.
- `write` is the general form of the mapping the three defaults already use: `route`, `method`,
  optional fixed `keys`, and `@value` standing for the control's value. A field with no `write` keeps
  going through `store` to `POST /defaults`.
- Type `prompt` draws a monospace textarea, and it does **not** auto-save on every change: it keeps
  the text dirty until the human presses the field's own `save`, then reports `saved`, and `revert`
  puts the last saved text back. The three defaults stay auto-save; a prompt is a file, and a file
  written on every keystroke is not a file anyone meant.
- `POST /prompt` already refuses a name outside the three folders, a name that is not a plain file,
  and a missing body. The page shows its answer on the field.
- The page carries every prompt file, so the payload grows by about 12 kB; that is fine and reads
  faster than ten round trips.

Nothing writes to `prompts/` in a test: a test may list, and may save a file's own bytes back to
exercise the route, but the repository's prompts must be byte-identical when the suite ends.

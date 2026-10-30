# Settings page brief: shelf home screen, JSON-driven defaults

The human picked the "Shelf" home screen out of three. It is at `mockups/home-shelf.html` in your
worktree — read it, and reuse its visual language: the 640px centred shelf between two hairline rails,
the masthead line, the monospace data, the existing palette tokens, its keyboard footer. Do not
redesign the shelf. Your job is to add the settings surface it always promised and never had.

Read `docs/home-screen-brief.md` first for what the product is, the palette, the data model and the
hard constraints. Everything there about one self-contained file, no framework, no CDN, no build,
`file://`, realistic content, no emoji, "every element has to earn its pixels" still holds. Then read
`mockups/home-shelf.html`.

## What the human asked for, in his words

> add a default settings page. I want settings to be stored and rendered from json. must support
> multiple levels. must be collapsible.

Read that as four requirements:

1. **A page, not a popover.** Settings get a real surface, reachable from the shelf in one click and
   left in one click, not a `<details>` that spills over the shelf.
2. **The JSON is both the store and the definition.** One document holds the groups, the fields, how
   each field renders, the current values, and the option lists. The DOM is *generated* from it. Add a
   field to the JSON and it appears in the page without touching the renderer and without hand-written
   markup per field. That is the whole point: no more hard-coded form.
3. **Multiple levels.** Nesting, at least three deep — a group inside a group inside the page — and it
   has to remain readable at that depth. "Multiple levels" also covers the thinking level list
   (`off`, `low`, `medium`, `high`): those four options come out of the same JSON, so a fifth level
   would need no code change. Both readings are in scope; do both.
4. **Collapsible.** Every group at every level opens and closes. Both states must be visible in the
   mockup at the same time, so the human can judge the closed state as well as the open one.

## The settings that actually exist today

Do not invent product features. These three are real, handled by `POST /defaults` on the daemon:

| stored key | meaning | control |
| --- | --- | --- |
| `provider` + `model` | the model a new board's agent starts with | combobox over `GET /models`, a long catalogue of `provider/model` |
| `thinking` | the thinking level a new board's agent starts with | select over `levels` |
| `dimOthers` | dim the cards of other threads while one is selected | toggle |

That is enough to prove depth, honestly: the page is *what a new board is born with*, so the path
`New boards → Agent → Model` and `New boards → Board → Cards → dim others` are real statements about
the product, not filler. Depth beyond that (a "Workspace" level, or the per-board overrides that the
board's own settings panel holds today) may be shown **only** if you label it as not built yet. Prefer
honest depth over invented settings.

## The JSON document

Shape it yourself, but it must satisfy:

- a `version` for later migration, and a title for the page;
- nested groups to arbitrary depth: every group has an `id`, a `label`, an optional one-line
  `help`, and either `groups` or `fields` (or both);
- every field has an `id` (which is also the key written to the store), a `label`, a `type`, and its
  current `value`;
- types: at least `combo` (free text with a suggestion catalogue, for the model), `select` (fixed
  options, for thinking), `toggle` (for dim others), and `text` or `number` for completeness;
- option sources either inline (`options: [...]`, `levels: [...]`) or by reference to a daemon route
  (`source: "/models"`), so the catalogue is not baked into the page;
- one document, structure and values together, so writing a value back is editing the same object.
- No comments (JSON has none). Put the explanation in `help` strings and in your notes.

Ship the identical document twice: embedded in the HTML inside `<script type="application/json"
id="settings">` so the file works from `file://`, and as `mockups/settings.defaults.json` so the
daemon side has something concrete to read. State in a header comment of your notes that the two must
stay byte-identical, and say which one the future daemon route would serve.

## The renderer

- Vanilla JS, no framework. One tree walk that turns the document into groups and fields. Keep it
  small enough that the human can read it in one screen; no clever abstractions.
- The renderer must be *generic*: no `if (field.id === "dimOthers")` anywhere. Every special case
  belongs in the JSON. This is the acceptance test for requirement 2 — if you had to special-case a
  field in code, the document is wrong.
- Collapse state per group lives in `localStorage` under one key, so a reload keeps the shape the
  human left. Sensible default for a fresh visit.
- Keyboard: groups reachable and togglable from the keyboard, focus rings visible, the whole page
  navigable without a mouse. Say how in your notes.

## Saving

The daemon today writes a default the moment it changes and shows `saved`. A page with many fields
wants something better, and the choice is yours — but you must pick one and justify it:

- **explicit save**: fields mark themselves dirty, one Save button, a `saved` line after, and a
  warning when leaving with unsaved changes; or
- **auto-save per field**: each control writes on change and reports inline.

Either way the mockup must *show* the outcome: a dirty state, a saved line, or a refused value (the
daemon answers 409 when the machine cannot run a model — the page has to have somewhere for that).

## Deliverable

1. `mockups/home-shelf-settings.html` — one self-contained file. It opens on the settings page (that
   is what the human asked to see), with the group tree in whatever default open/closed shape reads
   best, and a way back to the shelf that is obvious in one glance. The shelf itself is unchanged, but
   its masthead `defaults` control must now be the way in, so a reader can see both.
2. `mockups/settings.defaults.json` — the same document, standalone.
3. Commit both in your own worktree.

Then answer, only in your final message:

- the JSON shape, in a short block, with the reason for each structural choice;
- how the renderer stays generic, and how a fourth field or a fifth nesting level is added with the
  document alone;
- the collapse defaults you chose and why;
- what the closed state looks like, since it is the state the page will be in most of the time;
- how it holds at 1024×700, deep nesting included;
- what the daemon has to grow for this page to be real: the route, the file, the migration from
  `POST /defaults`, and anything the model catalogue needs. Be concrete; that part will be
  implemented next, not now.

## Rules you must not break

- Do not edit `public/`, `server/`, `docs/`, or `mockups/home-shelf.html`.
- Do not start a browser, do not run the daemon, do not install anything, do not signal processes.
  Write the files, commit, answer.
- Do not add a second design language next to the shelf's. Same rails, same masthead, same type sizes,
  same palette.

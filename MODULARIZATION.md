# Breaking the two monoliths into modules

**Status, 2026-10-29: the daemon half is done; the client half is deferred until further notice.**
Where this stands, and
what to read instead of the plan below:

| | state | where |
|---|---|---|
| the daemon | **done and merged** | `server.ts` plus 28 modules under `server/`, one commit per group, merged to `dev` at `78e6ca8` |
| its checks and tests | **done** | `npm run check` = `node --check`, `bin/check-imports.mjs`, `tsc`, `node --test` (34 tests), `bin/smoke.mjs` (19 route checks) |
| the client | **one module**: `public/client/board.js`, 5322 lines, loaded by `index.html` as `type="module"` and served by one `/client/**/*.js` rule | `f600268` |
| the client's split | **deferred, not started** | see "The client, when someone picks it up" below |
| `@ts-nocheck` on 26 of 28 daemon modules | **open** | 44 diagnostics under a loose config; stripping the pragmas and gating them is the next real win |

`PORT-PLAN.md` is the record of the daemon port: its target layout, the order of work, the review that
reshaped it, and the status section written when it landed.

## The client, when someone picks it up

Do not start from the plan below. It was measured with text greps, and the parser disagreed with it:

| plan said | measured |
|---|---:|
| 404 top-level declarations | 403 |
| 113 module-level `let` | 56 |
| 64 top-level listeners + 50 inside functions | 103 call sites: **68 run when the module evaluates**, 35 inside functions |
| 19 section banners | 20 |
| eight cross-section names | **eleven** written across sections: `sendMode`, `forkNext`, `boardConfig`, `boardMetaCache`, plus `z`, `newestFirst`, `sawFirstCard`, `replyTarget`, `replaying`, `framedView`, `freshCount` |

Three routes, cheapest first. The recommendation is C, and A only if the file keeps growing.

- **B. Put the state object inside the monolith.** One commit, one file, no imports: the eleven names
  become properties of one `state` object, about 128 mechanical renames. Nothing else moves. It removes
  the one thing that broke both earlier attempts — an imported binding cannot be assigned — so the file
  becomes liftable by pure mechanics later.
- **C. Split the three pure leaves.** `lib/highlight.js`, `lib/markdown.js`, `lib/dom.js`, about 250
  lines, one-directional imports, no state and no wiring. This is the only route that produces the
  client's first tests: the tokenizer and the escaping are string-pure. It cannot break the board.
- **A. The full split.** ~20 banner modules (or ~30 to reach the finer layout), ~84 load-time statements
  relocated, ~128 `state.x` rewrites, ~159 cross-section names turned into imports, 20+ commits. Its
  payoff is organisational — parallel review, parity with the daemon, per-module types later — and this
  is a single-author project. Its whole risk is carried by an eye on a browser, because there is no
  client test to carry it.

Three rules if A is ever taken, learned the hard way:

1. **`wire()` means every statement a section evaluates, not its listeners.** Besides the 68
   registrations there are 2 `onclick=` assignments, 3 observers and 11 init calls — about 84 statements
   that run on load today. A `wire()` that takes only listeners leaves the entry a hub and panels
   half-painted.
2. **Call the wires in today's evaluation order**, not the order the module list happens to be written.
   The threads section's four document keydown handlers must stay one module, and capture handlers
   register before bubble ones.
3. **No setters.** With each writer moved into the module that owns the variable, no module assigns
   another module's binding. Generating setters and rewriting assignment sites with regexes is what
   broke four files and cost the most time in the first attempt.

The tooling that worked: a parser-driven lift, which appends to a module instead of replacing it,
lifts only top-level statements, and generates import lines from the references each block actually
makes. `bin/check-imports.mjs` already walks the client entry's import graph and fails if a module the
page reaches is not served.

---

## The original record, unchanged

Recorded against `dev` at `99e38e9`. Sizes are measured from that worktree.

## What the two files actually are

`server.mjs` is 3978 lines and `public/board.js` is 5305. Both already carry their own seam list in
`// ----------` comments, which is the good news: the sections are module shaped, not a soup.

| `server.mjs` | lines | what it is |
|---|---:|---|
| preamble | 413 | constants, model catalogue, pi settings, scope resolution, extension list |
| small filesystem helpers | 44 | read/write JSON, token, workspace id, build hash |
| workspaces | 345 | the list on disk, defaults for new boards |
| what the crossroads needs | 24 | the facts a preview shows |
| the git picture | 176 | `gitGraph`, the payload the strip draws |
| worktrees | 524 | make one, settle its branch, retire it, `clean` |
| the board the client draws | 325 | `cardFor`, `plainCardFor`, the wire shapes |
| the child | 448 | spawn, rpc, turns, stop |
| the thought | 395 | streaming thought text, `liveThoughts` |
| http plumbing | 66 | `readJson`, `answer`, `fail`, `serveStatic`, `send` |
| routes: crossroads | 68 | workspace list and picker |
| routes: board | 854 | threads, cards, notes, ask, config, clean, layout |
| the server | 296 | the token, the one handler, the route table, listen |

| `public/board.js` | lines | what it is |
|---|---:|---|
| preamble | 210 | DOM refs, `view`, `cards`, `byId`, keys |
| helpers | 36 | small pure functions |
| syntax highlighting | 18 | one tokenizer |
| markdown | 196 | its own renderer |
| bodies | 360 | how each card kind is drawn |
| cards | 906 | create, place, drag, resize, fold, select |
| view | 491 | pan, zoom, fit, tidy, stack |
| minimap | 215 | the overview |
| git strip | 312 | lanes, pills, halo |
| activity rail | 44 | the rail shell |
| transcript | 320 | the conversation behind a thread |
| row detail | 555 | an expanded activity row |
| composer | 163 | the field and its modes |
| what answers | 394 | model and thinking pickers |
| settings | 58 | `#boardConfig` |
| clean and new | 118 | the two header buttons |
| crossroads | 83 | the workspace switch |
| file picker | 339 | folders and filters |
| threads | 171 | grouping, order, stack |
| transport | 316 | the event stream and its dispatch |

## What fixes the shape, whether or not I like it

1. **No build step, no dependencies.** `README.md` promises Node 22 and nothing to install. So the
   daemon split is plain ESM (`package.json` is already `"type": "module"`) and the client split is
   native `<script type="module">`. No bundler, no framework, no DI container.
2. **`bin/pi-studio` hardcodes `../server.mjs`**, and `npm run dev` watches that name. So `server.mjs`
   stays at the root as a thin entry and imports `server/main.mjs`.
3. **Static assets are an allowlist of four paths** (`server.mjs:3695`). `public/lib/*.js` will not
   be served until that list grows, which is one small change, not a static file server.
4. **The client is one closure.** `view`, `cards`, `byId`, `z`, `mapOn`, `gitShown`, `boardConfig`,
   the selection and the reply target are shared by nearly every section. Extracting a section means
   deciding where that state lives; there is no version of this that is a pure move.
5. **There are no tests.** `npm run check` is `node --check` on two files. That is a syntax check, not
   a regression net, and it is the main risk in every step below.

## Target layout

Daemon, under `server/`:

```
main.mjs        the token, the handler, the route table, listen (from "the server")
paths.mjs       state dirs, board and session files, read/write JSON, token, build hash
models.mjs      catalogue, pi settings, scope patterns, defaults
http.mjs        readJson, answer, fail, send, serveStatic
workspaces.mjs  the list on disk, defaults, describeWorkspace
git.mjs         gitIn, repoOf, baseRef, status, head branch, the graph picture
worktrees.mjs   ensure, settle, retire, cleanBoard
store.mjs       save, load, restore, scheduleSave
cards.mjs       cardFor, plainCardFor, notes, askers
child.mjs       spawn, rpc, turns, stop, settle
thought.mjs     the streaming thought
routes/crossroads.mjs
routes/board.mjs
```

Client, keeping `public/board.js` as the entry so `index.html` and the existing client files stay the
ones being edited:

```
public/board.js       composition root: wires what the modules export, keeps BOARD_START
public/state.mjs      the shared mutable state, one object, documented
public/lib/markdown.mjs, lib/highlight.mjs, lib/dom.mjs
public/card.mjs       bodies + cards
public/view.mjs       pan, zoom, fit, tidy, stack
public/minimap.mjs, public/gitstrip.mjs
public/rail.mjs       rail shell + transcript + row detail (they share the rail DOM)
public/composer.mjs, public/picker.mjs (models, thinking, tools, files)
public/config.mjs     settings panel + clean + new
public/threads.mjs, public/transport.mjs
```

The only new idea in either list is `state.mjs`. Everything else is a section that already exists.

## Order of work

One commit per step, each one mergeable on its own. Daemon first: a move there is reviewable in a
diff and carries no visual risk. Client last: a move there can only be checked by eye.

**Step 0, the enabler I would put first.** The state folder is hardcoded to
`~/.pi/agent/state/pi-studio` (`server.mjs:40`). Without an override there is no way to boot a second
daemon against a scratch folder, so no step below can be checked by anything but the human's own
board. One line, `process.env.PI_STUDIO_STATE_DIR ?? join(homedir(), ...)`, buys a `node --test`
smoke: boot on `PI_STUDIO_PORT=0 --no-open`, `GET /`, `GET /board.js`, `POST /workspace`, stop. That
test is what makes the rest of this list safe. Say if you want it; I would not start the split
without it.

1. `http.mjs` and `paths.mjs`: leaves, no imports of their own. Check: `node --check`, daemon boots.
2. `models.mjs`: catalogue and scope only the picker needs.
3. `git.mjs`: read-only git, plus the strip payload.
4. `store.mjs`: save, load, restore a board.
5. `worktrees.mjs`: the section with the most history behind it, moved with its comments intact.
6. `cards.mjs`, `child.mjs`, `thought.mjs`.
7. `routes/crossroads.mjs`, `routes/board.mjs`, then `main.mjs` with `server.mjs` left as the entry.
8. Client leaves: `lib/markdown.mjs`, `lib/highlight.mjs`, `lib/dom.mjs`. Pure, no shared state, so
   they move without a decision. This is also where the static allowlist grows and the tag becomes
   `type="module"`, done as its own commit so a broken import is the only thing that can fail.
9. `state.mjs`, introduced with only the variables the first extracted panel needs, then grown.
10. One panel per commit, smallest first: `minimap`, `gitstrip`, `settings`, `composer`, `rail`,
    `view`, `picker`, `threads`, `card`, `transport`.
11. `README.md` and `STATE.md` layout sections, last, so they describe what is there.

Each step: `npm run check` (grown to loop over the new folders), the smoke test from step 0, and for
client steps a browser look at the one panel that moved.

## How a section is moved without rewriting it

Function bodies stay byte identical; only the surrounding `import`/`export` line is new. Before
moving a block, `rg` it for calls to functions defined in other sections. That list is the import
line of the new module. A block that reaches into a dozen globals is the one to leave for last, and
the one that says whether the shared state object is shaped right.

## What could go wrong

- **Circular imports** on the client once `state.mjs` exists. Mitigation: modules export functions and
  factories, never a frozen snapshot of state; `state.mjs` imports nothing from the panels.
- **A silent behavioural change** in a "move", which the syntax check cannot see. Mitigation: the
  smoke test, plus a `git diff --stat` review per step; if a diff shows more than moved lines plus
  imports, the step was not a move.
- **The client's `BOARD_START` handshake**: `index.html:882` calls it from an inline script. With
  `type="module"` the module runs after parsing, so the inline call has to become an import-time
  call or a `DOMContentLoaded` one. Small, but it is the kind of thing that leaves a blank board.
- **Node's `--watch`** treats one entry and its graph: fine, as long as `server.mjs` keeps importing
  the rest.

## What I would not do

No bundler, no framework, no dependency. No barrel `index.js` files, since they hide the import
graph the point of this is to expose. No renames of behaviour while moving, no "while I am here"
fixes: those go on their own branch so a regression has one suspect. No class hierarchy around the
board; the shared state object is the plainest thing that works.

A realistic end state is no file over about 600 lines, and `npm run check` covering every file under
`server/` and `public/`.

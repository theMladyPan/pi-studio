# Open issues

The one list of what is open. `STATE.md` says what works; this says what does not, yet. Each entry
says what it is, what it would touch, and what has to be settled before it can start. Line numbers are
`dev` at `72a0a3d`.

Fifteen entries, in three groups: **fix** is something that reads wrong on screen today, **feat** is
something the board cannot do yet, **chore** is work on the code itself.

Three decisions have to be answered by you before some of these can start, and each is named in the
entry it blocks: whether "nothing to install" stays a promise, how the git strip should notice the
pointer, and where a screenshot's bytes live once the daemon has restarted.

## fix

**A workspace whose folder is gone cannot be forgotten.** The picker says `folder missing`, disables
its open button and puts `that folder no longer exists` where the hint goes
(`public/welcome.js:249`), and the entry stays for ever, because no route removes a workspace at all:
the daemon has `GET /workspaces` and `POST /workspace` and nothing else (`server/main.ts:207`). Touches
the workspaces list on disk and the picker. To settle: whether forgetting a workspace also deletes its
board file and its session folder, or only the entry.

**A screenshot row loses its picture on restart.** Pictures are held in memory and stripped on the way
to disk (`diskRow`, `server/bus.ts:136`), so a row from before a restart says the picture was not kept
(`public/client/board.js:4559`). Touches the store and the row sheet. To settle: where the bytes live
(a folder under the state dir, pruned with the activity), the size cap, and whether a restored row
fetches its picture on demand or carries it.

## feat

**Fork a thread.** The fork the composer offers answers only for a plain card that already has a thread
behind it (`forkTarget`, `public/client/board.js:5717`); on a thread card the button stays hidden, and
nothing anywhere reads or writes `forkedFrom`. A real fork copies the session file, marks the copy, and
gives the new thread a card of its own. Touches the thread spawn and the session handling.

**A card that renders a whole HTML page.** An opened file is shown as source text and nothing else.
Touches the client's card bodies. To settle: how a page is sandboxed (its own frame with scripts off,
or an inline document), the size cap, and what happens to a page that refers to a file beside it.

**The home screen, redesigned.** The crossroads is untouched since it was built. The briefs and the
picked mockups are already in the tree: `docs/home-screen-brief.md`, `docs/settings-home-plan.md` and
the three files in `mockups/`.

**A debug view of the raw agent stream.** Only the last 1 000 characters of a child's errors are kept
(`thread.stderrTail`, `server/child/run.ts:68`). Touches the child's run and the rail. To settle:
whether it is a panel behind the settings switch or a route read by hand, since it prints everything a
child says.

**Usage totals beside a rail row's detail sheet.** The sheet shows status, exit code, tokens and time
(`public/client/board.js:4736`) and nothing about what the call cost. The numbers exist per thread
(`thread.stats`) and not per call. To settle: what a single tool call can honestly claim, since pi
reports cost per session.

**One remembered setting for the minimap, and a switch for the graph.** The two disagree. The map is on
at every load (`let mapOn = true`, `public/client/board.js:3473`), toggled by `#mapBtn`
(`public/index.html:999`) and stored nowhere. The graph is a side effect: the strip appears whenever the
daemon sends commits (`git-on`, `public/client/board.js:3973`), with no key and no button. Touches the
client only. To settle: whether both become rows in the settings dialog `#boardConfig`
(`public/index.html:1020`) rather than header buttons.

**A git strip with no plate behind it.** The strip has no panel and the paint draws solid
(`public/client/board.js:3902`, `3914`), so the board reads through it. Lowering the alpha puts the
cards behind it into the picture. Wants one look in a browser before the values are kept, and it is
blocked on the strip's width: see the entry below.

**Git strip: dots at rest, branches and messages on hover.** As specified, the strip shows lanes and
dots only, and hovering opens it wide enough for branch and tag pills and commit subjects. Today it is
the other way round: a fixed 208px column (`public/index.html:84`) that always draws up to two pills
(`public/client/board.js:3919`) and a fitted subject (`3924`). Two ways to get the hover, and they are
not equivalent: a plain hover on the strip (`pointer-events: auto`) swallows drags and clicks over
208px of board, which the stylesheet states it must not (`public/index.html:85`); a pointer position
test keeps the board usable and costs a short delay. Hover is also not a modality everyone has, so the
accessible read (the strip's own summary label, or a strip that can take focus) has to be kept.

**How subagents should be organised on a board.** An idea to settle before it becomes a task: it may
replace the `delegate` tool. The three flows a boss runs today are drawn in
`docs/boss-and-subagents.md`.

## chore

**Let the type checker inspect the server.** `tsc` runs in `npm run check` and passes, but 30 of the 39
daemon files carry `@ts-nocheck`, so it checks nine of them. Measured by stripping every pragma: **557
diagnostics under the strict config** (407 a parameter with no type) and **75 under
`strict: false, noImplicitAny: false`**. Next commit: a loose pass in `check` that gates, then strict
module by module.

**Split the 7 807-line client module.** One file, up from 5 305 when it was costed, and the deepest
change the app still needs. Three routes, cheapest first: the shared state object inside the monolith
(about 128 mechanical renames, nothing else moves); the three pure leaves first (markdown, escaping,
small helpers — the only route that produces the client's first tests); or the full split into about
twenty modules. Three rules were learned the hard way and are written down here because the attempts
that broke were reverted: every statement a section evaluates on load belongs in its wire, not only its
listeners; the wires are called in today's evaluation order; and no setters, because generating them is
what broke four files.

**Cover a real spawn.** The line parser, a run's text, the argument list, the prompts, the settings
documents and every route are tested against a stub child (115 tests). What is left needs a real agent:
a whole conversation, an abort mid-answer, and a session resumed after a restart.

**Retire the older board in the extensions repository.** The `dashboard` extension duplicates this app,
which is why every child excludes it by name (`server/models.ts:239`). Once this board is the only one,
the exclusion and the extension both go.

## Not open

Decided, and recorded here so it is not reopened: **no framework**, because the client is an imperative
editor of canvas and pointer maths, and a rewrite would replace it whole with no regression net; the
triggers that would change the answer are a second surface reading the same cards, a component library
worth having, more than one person editing the client, or hot reload being worth a build step in itself.
And **no build step**: the daemon is plain ESM run by Node, and `npm install` is needed only for the
checks, which `precheck` says before it fails.

The one promise still to decide is "nothing to install". Running the app needs nothing today and running
the checks needs a devDependency, and that line in the README shapes every option here.

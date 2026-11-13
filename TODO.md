# Open issues

The one list of what is open. `STATE.md` says what works; this says what does not, yet. Each entry
says what it is, what it would touch, and what has to be settled before it can start. Line numbers are
`dev` at `c723fc3`.

Fourteen entries, in three groups: **fix** is something that reads wrong on screen today, **feat** is
something the board cannot do yet, **chore** is work on the code itself.

Four decisions have to be answered by you before some of these can start, and each is named in the
entry it blocks: whether "nothing to install" stays a promise, how the git strip should notice the
pointer, where a screenshot's bytes live once the daemon has restarted, and whether the microphone
stays in the daemon or moves into the page.

## fix

**A workspace whose folder is gone cannot be forgotten.** The picker says `folder missing` where a row's
age would go (`public/welcome.js:330`), names the folder as missing on disk in the path line, and
refuses to open it (`:367`), and the entry stays for ever, because no route removes a workspace at all:
the daemon has `GET /workspaces` and `POST /workspace` and nothing else (`server/main.ts:283`, `:309`).
The scratch row is the only row with a button that throws anything away, and it empties the folder
rather than forgetting the entry. Touches the workspaces list on disk and the picker. To settle: whether
forgetting a workspace also deletes its board file and its session folder, or only the entry.

**A screenshot row loses its picture on restart.** Pictures are held in memory and stripped on the way
to disk (`diskRow`, `server/bus.ts:136`), so a row from before a restart says the picture was not kept
(`public/client/board.js:5347`). Touches the store and the row sheet. To settle: where the bytes live
(a folder under the state dir, pruned with the activity), the size cap, and whether a restored row
fetches its picture on demand or carries it.

## feat

**Fork a thread.** The fork the composer offers answers only for a card that already has a thread
behind it (`forkTarget`, `public/client/board.js:6757`); on a thread card the button stays hidden, and
nothing anywhere reads or writes `forkedFrom`. A real fork copies the session file, marks the copy, and
gives the new thread a card of its own. Touches the thread spawn and the session handling.

**A card that renders a whole HTML page.** An opened file is shown as source text and nothing else. The
board can already send a note out as a page the browser draws; it cannot draw one that came in. Touches
the client's card bodies. To settle: how a page is sandboxed (its own frame with scripts off, or an
inline document), the size cap, and what happens to a page that refers to a file beside it.

**A debug view of the raw agent stream.** Only the last 1 000 characters of a child's errors are kept
(`thread.stderrTail`, `server/child/run.ts:92`). Touches the child's run and the rail. To settle:
whether it is a panel behind the settings switch or a route read by hand, since it prints everything a
child says.

**Usage totals beside a rail row's detail sheet.** The sheet shows status, exit code, tokens and time
(`public/client/board.js:5524`) and nothing about what the call cost. The numbers exist per thread
(`thread.stats`) and not per call. To settle: what a single tool call can honestly claim, since pi
reports cost per session.

**One remembered setting for the minimap, and a switch for the graph.** The two disagree. The map is on
at every load (`let mapOn = true`, `public/client/board.js:4186`), toggled by `#mapBtn`
(`public/index.html:1235`) and stored nowhere. The graph is a side effect: the strip appears whenever
the daemon sends commits (`git-on`, `public/client/board.js:4686`), with no key and no button. Touches
the client only. To settle: whether both become rows in the settings dialog `#boardConfig`
(`public/index.html:1258`), which is now a tree the daemon describes, rather than header buttons.

**A git strip with no plate behind it.** The strip has no panel and the paint draws solid
(`public/client/board.js:4540`, `4600`), so the board reads through it. Lowering the alpha puts the
cards behind it into the picture. Wants one look in a browser before the values are kept, and it is
blocked on the strip's width: see the entry below.

**Git strip: dots at rest, branches and messages on hover.** As specified, the strip shows lanes and
dots only, and hovering opens it wide enough for branch and tag pills and commit subjects. Today it is
the other way round: a fixed 208px column (`public/index.html:97`) that always draws up to two pills
(`public/client/board.js:4632`) and a fitted subject (`4637`). Two ways to get the hover, and they are
not equivalent: a plain hover on the strip (`pointer-events: auto`) swallows drags and clicks over
208px of board, which the stylesheet states it must not (`public/index.html:99`); a pointer position
test keeps the board usable and costs a short delay. Hover is also not a modality everyone has, so the
accessible read (the strip's own summary label, or a strip that can take focus) has to be kept.

**Voice, on a card.** The `voice` extension drove the console by speech, and it was retired from the
extensions repository rather than ported, because every one of its hooks checked `ctx.mode === "tui"`
and `ctx.hasUI`: a thread runs `--mode rpc`, so a board version is a rebuild. What it did is worth
having back. It dictated into the editor from `arecord` at 16 kHz mono, with an energy gate on 100 ms
frames, an utterance closed by 700 ms of quiet or cut every 6.5 s so the words appeared while you were
still talking, and 200 ms of speech cut whatever was being read out. It had the agent write one short
breadcrumb per tool batch and spoke each sentence as it streamed, so the voice overlapped the tools
instead of following them, then spoke a 40-word wrap-up when the run settled — what changed, and the
one question worth answering next. `humanizeForSpeech` read `src/config/settings.py` as "settings py in
src config folder", `alt+s`/`alt+x`/`alt+l` and `/voice` drove it, English and Slovak came from one
setting, and speech in and out went to `gemini-3.8-flash` and `gemini-3.8-flash-tts`. The last tree is
branch `archive/voice-mode` (`06d5868`) in the extensions repository. Here the text is already on the
wire — a child's `text_delta` reaches the daemon (`server/thought.ts:371`) — and the breadcrumb is a
system-prompt section, which the daemon already writes per role (`server/child/roles.ts`). Touches the
card composer, the child's stream, the settings document for the key and the language, and a control to
read one thread aloud. To settle: whether the microphone stays in the daemon with `arecord` or moves
into the page with `MediaRecorder` sending bytes here, which would drop the ALSA dependency and the
record-device question with it; where `GEMINI_API_KEY` lives, in the daemon's environment or in a
board's settings; and whether speech is one switch for the board or per thread, because several
children answer at once and a voice that reads all of them is a mess.

## chore

**Let the type checker inspect the server.** `tsc` runs in `npm run check`, but 32 of the 58 daemon
files carry `@ts-nocheck`, so it checks twenty-six of them. Measured by stripping every pragma: **775
diagnostics under the strict config** (565 a parameter with no type) and **113 under
`strict: false, noImplicitAny: false`**. Next commit: a loose pass in `check` that gates, then strict
module by module.

**Split the 10 812-line client module.** One file, up from 7 807 when it was last costed and 5 305
before that, and the deepest change the app still needs. Three routes, cheapest first: the shared state
object inside the monolith (about 128 mechanical renames, nothing else moves); the three pure leaves
first (markdown, escaping, small helpers — the only route that produces the client's first tests); or
the full split into about twenty modules. Three rules were learned the hard way and are written down
here because the attempts that broke were reverted: every statement a section evaluates on load belongs
in its wire, not only its listeners; the wires are called in today's evaluation order; and no setters,
because generating them is what broke four files.

**Cover a real spawn.** The line parser, a run's text, the argument list, the prompts, the settings
documents and every route are tested against a stub child (333 tests). What is left needs a real agent:
a whole conversation, an abort mid-answer, and a session resumed after a restart.

**Retire the older board in the extensions repository.** Done on the extensions side: the `dashboard`
extension and its roadmap are deleted (`6662647`), kept on branch `archive/dashboard-extension`. What is
left here is the name, `dashboard` in `CHILD_EXCLUDE` (`server/models.ts:270`), which can go once the
extension is gone from every workstation.

## Not open

Decided, and recorded here so it is not reopened: **no framework**, because the client is an imperative
editor of canvas and pointer maths, and a rewrite would replace it whole with no regression net; the
triggers that would change the answer are a second surface reading the same cards, a component library
worth having, more than one person editing the client, or hot reload being worth a build step in itself.
And **no build step**: the daemon is plain ESM run by Node, and `npm install` is needed only for the
checks, which `precheck` says before it fails. And **subagents are organised by the board**: a human's
thread has a mode, a spawned child has a role, and a boss's flow is a file under `prompts/flows/`, which
is what replaced the `delegate` tool; `docs/boss-and-subagents.md` is the one page that says how.

The one promise still to decide is "nothing to install". Running the app needs nothing today and running
the checks needs a devDependency, and that line in the README shapes every option here.

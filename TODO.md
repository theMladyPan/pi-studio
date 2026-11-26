# Open issues

The one list of what is open. `STATE.md` says what works; this says what does not, yet. Each entry
says what it is, what it would touch, and what has to be settled before it can start. Line numbers are
`dev` at `c723fc3`.

Eight entries, in three groups: **fix** is something that reads wrong on screen today, **feat** is
something the board cannot do yet, **chore** is work on the code itself.

Two decisions have to be answered by you before some of these can start, and each is named in the
entry it blocks: where a screenshot's bytes live once the daemon has restarted, and whether the
microphone stays in the daemon or moves into the page.

## fix

**A screenshot row loses its picture on restart.** Pictures are held in memory and stripped on the way
to disk (`diskRow`, `server/bus.ts:136`), so a row from before a restart says the picture was not kept
(`public/client/board.js:5347`). Touches the store and the row sheet. To settle: where the bytes live
(a folder under the state dir, pruned with the activity), the size cap, and whether a restored row
fetches its picture on demand or carries it.

## feat

**Usage totals beside a rail row's detail sheet.** The sheet shows status, exit code, tokens and time
(`public/client/board.js:5524`) and nothing about what the call cost. The numbers exist per thread
(`thread.stats`) and not per call. To settle: what a single tool call can honestly claim, since pi
reports cost per session.

**The Git Graph drawer still cannot reach a few commands.** The remote writes now answer — adding,
editing and deleting a remote, deleting a remote branch, fetching a remote branch into a local one,
pulling, pushing a branch, pushing a tag on its own — in `server/git/gitgraph/actions.ts` behind the
table in `server/git/gitgraph/dispatch.ts`. What still answers `This tab cannot do that yet.` is the
archive download, the repository-configuration export, and the settings import and export the editor or a
third party would have served. A push gets its token the way the shell's git would: the run inherits the
daemon's environment, so an ssh key, an agent and a credential helper answer, and no terminal prompt
stands in them (`server/git/exec.ts`). To settle: what the board says to a thread whose checkout moved
under it while the thread was idle, because the live guard only knows a child that is running now, so a
human merging or resetting an idle thread's tree moves it in silence.

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

**Let the type checker inspect the server.** `tsc` runs in `npm run check`, but 34 of the 92 daemon
files carry `@ts-nocheck`, so it checks fifty-eight of them. Measured by stripping every pragma: **775
diagnostics under the strict config** (565 a parameter with no type) and **113 under
`strict: false, noImplicitAny: false`**. Next commit: a loose pass in `check` that gates, then strict
module by module.

**Split the 15 434-line client module.** One file, 15 434 lines now, up from 7 807 when it was last
costed and 5 305 before that, and the deepest change the app still needs. Three routes, cheapest first: the shared state
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

**Installation is decided**: a release installs for the current user from one download line and keeps one
folder per version, while `npm run install:local` installs a build from a checkout and reads custom.
Running the daemon needs Node, `git` and `pi` on the machine; `npm ci` is needed only for the checks and
for building a release.

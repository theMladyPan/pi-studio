# pi-studio — where this stands

Written when the app moved out of the extensions repository. What the board does was verified by curl
against real children, and the commits that built each part report what was seen in a browser; the
check that was actually run for the tree as it stands is `npm run check`. Where a claim rests on a
commit's own account rather than on a check run now, the section below says so.

## Works

- `server.mjs`, Node builtins only, `node server.mjs` or `bin/pi-studio`. It opens the crossroads in a
  browser unless started with `--no-open`.
- **Two surfaces**: `/` is the crossroads (workspaces, a preview of one, facts about it), `/w/<id>` is
  that workspace's board in its own tab. The crossroads opens a board with
  `window.open('/w/<id>', 'pi-studio-<id>')`, so asking twice focuses the tab instead of stacking
  duplicates. A thread row in the preview opens the board on that thread (`&thread=<id>`).
- **Boards are independent**: threads, children, activity and the event stream are keyed by
  workspace, so two tabs work at once and neither can disturb the other. Closing a tab kills
  nothing — children belong to the daemon and keep running.
- **Folder picker**: `POST /pick-folder` runs `zenity --file-selection --directory`, because a browser
  cannot be handed an absolute path. Falls back to typing a path when zenity is missing; a path that
  does not exist is refused rather than created.
- **Workspaces**: `GET /workspaces` lists what has been opened with the facts the crossroads shows
  (thread count, running count, last activity, git branch and dirty count, session size, whether the
  folder still exists); `POST /workspace {folder}` registers and loads one. State lives in
  `~/.pi/agent/state/pi-studio/`: `daemon.json` (token, port), `workspaces.json` (the list plus the
  crossroads defaults), `boards/<id>.json`, `sessions/<id>/`.
- **Threads** are cards: `POST /thread` creates one in the open workspace, `POST /message {cardId,
  text, mode}` prompts it. The child is spawned on the first message, one per thread, and shut down
  when it settles.
- **A thread draws on its own board.** Every child is started with `-ne -e bridge/child-bridge.mjs`
  and four environment variables (`PI_STUDIO_URL`, `PI_STUDIO_TOKEN`, `PI_STUDIO_WORKSPACE`,
  `PI_STUDIO_THREAD`), and the bridge registers three tools that post to the board's own routes:
  `board_note`, `board_source`, `board_ask`. A child started by hand, with no daemon behind it,
  registers nothing. The tools say what the human should see; card type, placement, cascade and keys
  stay the daemon's decision, so the verbs are not pi's.
- **A thread has the tools a console pi has**: it loads every extension installed here, and no
  allowlist is passed unless `PI_STUDIO_TOOLS` asks for one (`PI_STUDIO_CHILD_EXTENSIONS` names an
  exact list instead of discovering). `-ne` keeps discovery off so that list is explicit and `-e`
  loads what it names. Three things are left out by default, and
  `PI_STUDIO_CHILD_EXCLUDE` changes that: `dashboard`, because it registers the same tool names as
  the bridge and would open a board server and rewrite its state file once per running thread;
  `browser-screenshot` and `ytrack`, because one drives the human's browser and the other answers
  through a 2FA gateway. Test scripts in that folder are skipped too — `test-delegate-retry.mts`
  exports no factory, so pi refuses to load it and the thread dies before it can answer.
- **What a thread is told**: `--append-system-prompt` says it is one thread on a board, in which
  folder, that the human reads cards rather than a terminal log, and that a fenced svg block in a
  note draws a picture.
- **Notes** are the cards with no child behind them. `POST /card/note {markdown, title?, rect?}`
  puts one on the board, `POST /edit {cardId, markdown}` rewrites it, and `POST /layout` and
  `POST /close` treat a note like a thread. A message asked on a note starts a thread named after
  it, cascading under the note through `threadRoot`. Notes are saved with the board and come back
  with their text, place and fold. A `key` makes a note stable: the same key revises that card
  instead of stacking another, which is what a running agent stepping through a job needs. A note
  holds at most 100 000 characters and the board keeps 200 of them.
- **Source cards**: `POST /card/source {path, line?, title?, key?}` reads a file from the workspace
  and shows it on the board, refusing anything outside the folder, a folder, a binary, or more than
  200 000 bytes. The key defaults to the path, so opening the same file again refreshes that card.
- **Questions**: `POST /card/ask {question, options[], allowFreeText?, title?}` puts a question on
  the board and holds the request open; `POST /answer {cardId, answer}` settles it and the click
  travels back in the held response. Five minutes with no answer expires it, closing the tab expires
  it, and a question restored from disk is always expired because the agent that was waiting is gone.
  A question nobody answered is not a failure: the tool tells the child to decide and say what it
  assumed.
- **One map for cards without a child**: notes, sources and questions live in `board.cards`, saved
  under `cards` and read from an older file's `notes` too.
- **Commenting on a card**: a thread answers in itself. A card without a child is asked of the thread
  that made it — its `threadRoot` — and the card is quoted at the top of the message, so the agent
  that wrote the note is the one that answers about it. `{"fork": true}` on `/message`, the composer's
  `fork` button, asks a new thread under the card instead, with the same quote and its own
  conversation. A card nobody made, or one whose thread has ended, starts that thread too. The card
  shows what the human typed; only the child is given the quote. A queued message carries both.
- **A card has a thread behind it, not a thread card beside it.** `threadRoot` on a plain card is where
  the card cascades; `ownerThread` is the thread that answers comments on it; and a thread marked
  `hidden` is never drawn — the card is the surface. A comment on a card that already has
  an owner is answered by that thread, and the question and answer are kept in `card.turns`. A fork, or
  a card nobody answers for yet, starts a hidden child and hands the card to it, so the
  conversation moves to a fresh session while the card stays where it is. `plainCardFor` carries
  `answersWith` (provider, model, thinking) so the composer can name and change what answers a card
  without the thread behind it ever being drawn.
- **A child lives while it has a card.** Closing the thread's own card does not end its child: the
  thread turns `hidden` and keeps answering the notes it owns, which are where that conversation is
  read. Closing the last card it answers for ends it — the child process goes, and so does a run that
  was writing for it — and the same happens when a card is pruned for room. A reply whose card is gone
  is written nowhere: never onto the thread's own turn, which would overwrite an older answer.
  `anchorOf` keeps placement honest for cards a hidden child writes: they cascade under the newest card
  that child owns, and name that child as their owner.
- **A run is stopped or killed where it is read.** The card of a thread carries `answersWith.running`
  (or its own `sent` status) while a run is live, and its header turns that into one control: `■` asks
  the child to abort, and the same control becomes `⊗` — kill — when the stop does not land. `POST
  /stop` takes a card id and stops only that thread; without one it still stops everything, which is
  what the header button means. `POST /kill` sends SIGKILL, marks the turn stopped, drains the queue
  that nothing will now serve, and leaves the thread and its card in place, so the next message starts
  a fresh child on the same session. An abort asked for before the child got going is repeated on the
  run's first event, because there was no run to abort yet.
- **A source card is titled by its file, then by its label**: `docs/notes.md - The list as it reads
  now`. The path is made relative to the workspace, so a card says where it is before what it is.
- **A card draws only what it has.** A thread card's `text` is empty by design — the turns are the
  conversation — so an empty text draws no bubble and no state line.
- **The rail is a stack of threads.** Every activity row says which thread wrote it, and a settled row
  is filed in that thread's foldable section: title, count, newest thread on top. A folded section is
  remembered for the session only. Rows still running stay in the strip above the log, so what is
  happening now is visible however far the log is scrolled.
- **What answers is a choice, per thread.** `provider`, `model` and `thinking` live on the thread and
  are saved with it; `board.config` is what the next thread starts with, taken from the newest thread
  until a choice is made. `GET /models` reads `pi --list-models` once and keeps it for ten minutes, so
  the picker works before any child exists. `POST /model` and `POST /thinking` take a card id — a card
  resolves to the thread that answers for it — or no id at all, which sets the board's default. A live
  child is told with `set_model` and `set_thinking_level`; a sleeping one starts with `--thinking` next
  time. Every card a thread answers for is re-broadcast after the change, because the card carries the
  runtime in `answersWith`.
- **Settings live in two places.** `GET /defaults` and `POST /defaults {provider?, model?, thinking?,
  dimOthers?}` on the crossroads set what every board opened from there is born with, kept in
  `workspaces.json`; a model is refused with 409 unless this machine can actually run it. A board keeps
  its own copy in `board.config`, spread over the crossroads defaults when it is created, and
  `POST /config {dimOthers}` changes one switch there without touching the next workspace. `dimOthers`
  is the one feature so far: the cards of other threads step back to 70% opacity while one is selected.
  `meta.config` is what the client reads, and `POST /model` with no card writes the board's own default.
  The board's panel reuses the composer's model list, so there is one catalogue in the app.
- **Ownership survives a restart or is repaired.** `answersWith` is only reported for an owner that is
  still alive; a choice made on a card whose thread has ended lands on `board.config`, which is where
  the next child comes from anyway. A board file
  that lost half a pair — a child with no card, a card naming a thread that is gone — is repaired when
  it is read, and the crossroads counts only threads that are drawn.
- **A turn is drawn in the card it was written on.** An existing owner thread answering for its card
  keeps the question on that card: `card.turns` fills in, `thread.answering` remembers which card the
  run in flight writes back to, and the answer lands there, so a chain of comments reads under the
  note instead of on the thread's card. A fork, or a card nobody made, gets a thread of its own and the
  turn lives on that thread card. The chain is quoted into the preamble — last three turns, 200
  characters each — so a fresh child, a fork or a restarted thread still knows what was already said
  about the card. Card turns survive a restart; a turn in flight when the daemon stopped reads as
  stopped.
- **Sessions resume**: the child writes its session under the app's own session dir, the thread
  stores the id, and a message after a daemon restart resumes that session. Verified: after a
  restart the agent remembered the word it had answered in the previous run.
- **Steering and queueing** per thread; a turn a steer displaced reads `stopped`.
- **Layout**: `POST /layout {cardId, rect, mini}` is saved with the board and restored on open.
- **Clean and new**: `POST /clean` forgets activity rows whose thread is gone or dead, the dead threads
  and their children, and the ownership their cards still pointed at, so a note left behind starts a
  fresh child when it is asked again. Nothing that can answer is touched. `POST /new` empties the board
  in the same workspace and keeps its settings; the button turns into `sure?` for four seconds first.
  Both answer with a snapshot, which the client already replays, so every open tab rebuilds.
- **Persistence**: board saved on a 500 ms debounce and flushed on stop and on a workspace switch;
  a restart reopens the last workspace.
- `GET /browse` for the composer's file picker. Token gate on every data route (403 without it).

## Client

Three files on the crossroads (`welcome.html`, `welcome.css`, `welcome.js`) and the board's
established client (`index.html`, `board.js`), which is unchanged apart from reading its workspace id
from the path, carrying `&workspace=` on its routes, and its `board of <name>` label opening the
crossroads in a tab. The board gained a corner panel for its own settings and the `clean` and `new`
buttons beside them; the crossroads gained the defaults panel. No framework, no build step.

## Fixed on the way

- A reply could land on the wrong card: when the card a run was answering for was closed mid-run,
  `turn_end` fell back to the thread's own last turn and overwrote an older answer. It now writes
  nowhere, and closing the card stops the turn and clears `thread.answering`.
- A model or level chosen while a child was shutting down ended the thread with "write after end": the
  `stdin` write is now guarded by `writable`, and a choice made on a dead thread goes to the defaults.
- A thread card's chips showed the board default, because it looked for a card type that no longer
  exists. It now reports its own model and level. The model picker also opens below its anchor when
  there is no room above, so it stops covering the corner panel it was opened from.
- A card made by a hidden child was owned by the *card* it cascaded under, not by the child, because
  `rootOf` returned one id for two jobs. Placement and ownership are decided separately now.
- `pi --list-models` had no timeout, and an empty answer was never cached, so a machine with no
  credentials spawned pi on every open of the picker.

- `update()` broadcast a thread that serves a card as if it were a card, so changing a model put a
  second card on the board for the same conversation. It now broadcasts the card the thread serves.
- `applyMessage` skipped the record update when nothing visible had changed, which left
  `answersWith` stale and the composer's chips showing the old model. The paint is skipped, the data is
  not.
- The chips were blank until the first card update, because the snapshot path never repainted them.

- A queued message was killed by the `stdin.end()` that ran before the queue drained: the next message
  started a child that the old child's exit handler then declared dead, so the turn read as stopped.
  A child is closed only when nothing is waiting, and a replaced child's exit is ignored.

## Verified by curl

Crossroads served and reachable, `GET /workspaces` empty then populated, workspace opened, board page
served at `/w/<id>`, board snapshot with its workspace in meta, thread and reply in one workspace,
a second workspace with its own thread and reply at the same time, both restored after a daemon
restart, crossroads showing both with their last activity. `POST /pick-folder` is untested because
running it opens a dialog on the human's screen.

The board verbs, against real children on a throwaway `HOME`: a child asked to make a note and open a
file did both (`board_note` with a key revised one card; `board_source` opened `notes.txt` at line 2),
each card cascading under the thread that asked for it, and the thread still answered in its own
card. A child asked a question with `board_ask`, the card appeared while the request was held, an
answer posted from another request reached the card and the child's turn ("You chose tabs"), a second
answer to the same question was refused with 409, an ask with no question or with one option was
refused with 400. A child asked to search the web used `exa_search` and answered with the result, and
the rail showed the tool row, which proves the research extensions load inside a thread.

With the whole extension folder in play: a child loaded the installed extensions, called `exa_search`,
then `board_note`, and its note landed on the pi-studio board (so the bridge's tool names survive the
folder being loaded), with clean stderr and no extra listening port — the dashboard was left out and
did not open a second board. A first run died on `test-delegate-retry.mts` ("does not export a valid
factory function"), which is why test scripts are skipped now.

Against real children, after the review: a fork's child owning the card with its question on the card
and no card of its own, a note written by that hidden child cascading under the card it serves and owned
by the child, the card's chain intact across both, the crossroads listing only drawn threads, and
closing the card removing its child. A choice made on a closed card landed on the board default and the
next thread started with it.

Seen in a browser (the only part of this app that has been): the note card with its comment chain, the
composer docked in it, the model and thinking chips reading `claude-sonnet-5-5` and `think medium`, the
model picker listing 590 models grouped by provider with a search field, and each choice repainting the
chip and landing on the thread behind the card. A fork put its question and answer on the note and
opened no card.

Card chains, against real children: a note's comment and its answer land on the note while the thread
card keeps only its own turn; a second comment chains under the first and the child answers about the
previous question; a fork makes its own thread card and leaves the note's chain alone; the chain comes
back after a restart; a comment written while the owner was busy waited, then answered on the card.

Notes, against a daemon on a throwaway `HOME` and a scratch folder: created with and without a
`rect`, refused when the markdown is blank, carried in the `snapshot` and in `GET /state`, edited
(the stored markdown and `updatedAt` change), moved and folded through `POST /layout`, restored with
text, place and fold after a daemon restart, closed through `POST /close`, and a message asked on a
note started a thread named after it. Editing a card id that is not a note answers 409. Nothing here
has been checked in a browser.

Reported by the commits that added the settings and the clean/new verbs, both against a real daemon
and neither re-checked since: crossroads defaults set, and refused with 409 for a model this machine
cannot run or 400 for a level pi does not name; a new board inheriting them; a board changing its own
`dimOthers` without moving the crossroads default; a thread starting with the inherited model and
level; `POST /model` with no card landing in `board.config`. Cleaning removed exactly the rows of a
closed thread and kept the open one's card and rows; `new` emptied cards, threads and activity and kept
model and level. Those commits say the panel, the picker, the dimming on a five-card board, both
buttons and the `sure?` arming were seen in a browser. `npm run check` passes on the current tree.

## Does not work yet

- The answer appears when a turn ends; nothing streams into the card while it is generated.
- Forking a *thread* is not built: `fork` on a thread card does nothing (the button is hidden there),
  because a real fork has to copy the session file and mark the copy `forkedFrom`.
- Feeding a card into a thread other than the one that made it is designed and not built.
- Rail rows carry no payloads (arguments, logs, outputs), no usage totals, no images. `GET
  /activity/<id>` answers 404 rather than pretending an empty detail exists.
- A workspace whose folder has been deleted or moved says `folder missing` at the crossroads, with its
  open button disabled and `that folder no longer exists` where the hint goes, but there is no way to
  forget the entry and it stays in the list.

- **Two verbs for tidying.** `clean` forgets the activity of threads that are gone or dead, the dead
  threads themselves with their children, and the ownership their cards still pointed at, so a note
  left behind starts a fresh child when asked again. `new` empties the board and keeps the workspace
  and its settings; because it throws work away, the button turns into `sure?` and the second press
  inside four seconds is the answer. Both answer by sending a snapshot, which every open tab already
  knows how to replay.
- **The selection decides the wheel and the dimming.** A selected card is the reading position: the
  wheel scrolls that card wherever the pointer is, and cards of other threads drop to 70% opacity
  (`board.config.dimOthers`). With nothing selected the wheel pans the board and every card is equal.
  Escape gives the selection up.
- **A card is a handle.** Press and drag anywhere on a card moves it; press the background and the
  board pans; ctrl+drag inside a card selects its text. Controls keep their own press: header buttons,
  the docked composer, links, checkboxes, editable fields and the resize corner.
- **A reload in development.** The daemon reuses the port it printed last, so `npm run dev`
  (`node --watch server.mjs --no-open`) restarts behind the URL a tab is already on, and the tab
  reconnects to a snapshot by itself. Client files need only a browser reload.

## Next, in order

1. Stream the answer into the card, then rail payloads. pi already writes `message_update` with a
   `text_delta` on the same stdout `handleChildLine` reads, and only `turn_end` is acted on.
2. A workspace entry that no longer resolves: offer to forget it.
3. Fork a thread, then feeding a card into another thread.
4. Brainstorm how to organize subagents on a board — potentially replace `delegate`.
5. HTML artifacts: a card that renders a whole html file, not only source text.
6. Home screen redesign — the crossroads (`/`, `welcome.html`/`welcome.css`/`welcome.js`).
7. A debug view of the raw stream from a pi child: the stdout lines `handleChildLine` parses, line by
   line and unfiltered, beside the 1000-character `stderrTail` that is kept today.

## Rules

- `public/` is the client; do not add a second UI beside it.
- No subagent starts a browser or sends signals to processes; verification is curl and `node --check`.
- One slice per commit, conventional commits, review before commit.

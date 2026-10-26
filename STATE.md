# pi-studio — where this stands

Written when the app moved out of the extensions repository. Everything here was verified by curl
against real children; nothing has been checked in a browser.

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
  `~/.pi/agent/state/pi-studio/`: `daemon.json` (token, port), `workspaces.json`, `boards/<id>.json`,
  `sessions/<id>/`.
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
- **Sessions resume**: the child writes its session under the app's own session dir, the thread
  stores the id, and a message after a daemon restart resumes that session. Verified: after a
  restart the agent remembered the word it had answered in the previous run.
- **Steering and queueing** per thread; a turn a steer displaced reads `stopped`.
- **Layout**: `POST /layout {cardId, rect, mini}` is saved with the board and restored on open.
- **Persistence**: board saved on a 500 ms debounce and flushed on stop and on a workspace switch;
  a restart reopens the last workspace.
- `GET /browse` for the composer's file picker. Token gate on every data route (403 without it).

## Client

Three files on the crossroads (`welcome.html`, `welcome.css`, `welcome.js`) and the board's
established client (`index.html`, `board.js`), which is unchanged apart from reading its workspace id
from the path, carrying `&workspace=` on its routes, and its `board of <name>` label opening the
crossroads in a tab. No framework, no build step.

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

Notes, against a daemon on a throwaway `HOME` and a scratch folder: created with and without a
`rect`, refused when the markdown is blank, carried in the `snapshot` and in `GET /state`, edited
(the stored markdown and `updatedAt` change), moved and folded through `POST /layout`, restored with
text, place and fold after a daemon restart, closed through `POST /close`, and a message asked on a
note started a thread named after it. Editing a card id that is not a note answers 409. Nothing here
has been checked in a browser.

## Does not work yet

- The answer appears when a turn ends; nothing streams into the card while it is generated.
- Forking a *thread* is not built: `fork` on a thread card does nothing (the button is hidden there),
  because a real fork has to copy the session file and mark the copy `forkedFrom`.
- Feeding a card into a thread other than the one that made it is designed and not built.
- Rail rows carry no payloads (arguments, logs, outputs), no usage totals, no images.
- `stop` aborts every running thread, not a chosen one; the rail is one list, not one per thread.
- No attention to a workspace whose folder has been deleted or moved: opening it fails with a 404
  and the entry stays in the list.

## Next, in order

1. Stream the answer into the card, then rail payloads.
2. Per-thread stop, and the rail grouped by thread.
4. A workspace entry that no longer resolves: say so and offer to forget it.

## Rules

- `public/` is the client; do not add a second UI beside it.
- No subagent starts a browser or sends signals to processes; verification is curl and `node --check`.
- One slice per commit, conventional commits, review before commit.

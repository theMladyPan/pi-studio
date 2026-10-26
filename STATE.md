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

## Does not work yet

- A thread cannot draw notes, sources or ask questions: no board verbs, so it only answers in its
  own card.
- The answer appears when a turn ends; nothing streams into the card while it is generated.
- Rail rows carry no payloads (arguments, logs, outputs), no usage totals, no images.
- `stop` aborts every running thread, not a chosen one; the rail is one list, not one per thread.
- No attention to a workspace whose folder has been deleted or moved: opening it fails with a 404
  and the entry stays in the list.

## Next, in order

1. Board verbs over HTTP for children (`POST /card/note`, `/card/source`, `/card/ask`) plus a thin
   `slave.ts` a child loads with `-e`, so a thread can put things on the board.
2. Stream the answer into the card, then rail payloads.
3. Per-thread stop, and the rail grouped by thread.
4. A workspace entry that no longer resolves: say so and offer to forget it.

## Rules

- `public/` is the client; do not add a second UI beside it.
- No subagent starts a browser or sends signals to processes; verification is curl and `node --check`.
- One slice per commit, conventional commits, review before commit.

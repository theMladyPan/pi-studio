# pi-studio — where this stands

Written when the app moved out of the extensions repository. Everything here was verified by curl
against real children; nothing has been checked in a browser.

## Works

- `server.mjs`, Node builtins only, `node server.mjs` or `bin/pi-studio`.
- **Workspaces**: `GET /workspaces` lists what has been opened (folder, name, thread count, newest
  first, plus which one is open); `POST /workspace {id | folder}` opens one, creating it if the
  folder is new. State lives in `~/.pi/agent/state/pi-studio/`: `daemon.json` (token, port),
  `workspaces.json`, `boards/<id>.json`, `sessions/<id>/`.
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

`public/index.html` and `public/board.js` are the board's established client, copied in. Two
additions: a start screen (`#workspaces`) listing workspaces and taking a folder to open, and the
`+` button. The header's `board of <name>` label is a button that reopens the start screen.

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

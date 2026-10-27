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
- **A thread is named by its first request, never by a counter.** `POST /thread` with no title leaves
  the card nameless, and its head shows nothing until there is something to show. The first message
  names it twice over: `titleFromRequest` takes its opening words at once, and `nameThread` asks
  `PI_STUDIO_NAME_MODEL` (default `openrouter/z-ai/glm-5.3-flash`, naming off when empty) beside the
  turn for two to four better words, keeping the answer only when `plausibleTitle` accepts its shape
  and it is not a dull name like "work" or `thread 1a2b3c4d`. `namedBy` records whether the human,
  `request` or the model chose, and only the `request` name is ever replaced, so a rename by hand
  survives a slow model. A name that never arrives is said on stderr rather than passed over.
- **A link to a card that is not there says so.** `[[key]]` is resolved against the keys and names on
  the board each time a card paints, so a link whose card was closed or never written is marked
  `stale` before any click: muted, dashed, with a title naming what is missing. The click reports the
  miss in the footer's `footHint`, which is always on screen, unlike the composer's own hint that goes
  away when its field is docked in a card.
- **A thread draws on its own board.** Every child is started with `-ne -e bridge/child-bridge.mjs`
  and four environment variables (`PI_STUDIO_URL`, `PI_STUDIO_TOKEN`, `PI_STUDIO_WORKSPACE`,
  `PI_STUDIO_THREAD`), and the bridge registers three tools that post to the board's own routes:
  `board_note`, `board_source`, `board_ask`. A child started by hand, with no daemon behind it,
  registers nothing. The tools say what the human should see; card type, placement, cascade and keys
  stay the daemon's decision, so the verbs are not pi's.
- **A thread has the tools a console pi has**: it loads every extension installed here, and no
  allowlist is passed unless `PI_STUDIO_TOOLS` asks for one (`PI_STUDIO_CHILD_EXTENSIONS` names an
  exact list instead of discovering). `-ne` keeps discovery off so that list is explicit and `-e`
  loads what it names. Two things are left out by default, and `PI_STUDIO_CHILD_EXCLUDE` changes
  that: `dashboard`, because it registers the same tool names as the bridge and would open a board
  server and rewrite its state file once per running thread; and `ytrack`, because it answers
  through a 2FA gateway that expects a human at the keyboard. `browser-screenshot` used to be left
  out with them and is now loaded: its runner launches its own headless chromium on a throwaway
  profile in a temp folder, so it takes a picture of a page without touching the human's browser.
  Test scripts in that folder are skipped too — `test-delegate-retry.mts` exports no factory, so pi
  refuses to load it and the thread dies before it can answer.
- **What a thread is allowed to do is a switch on the board.** The settings panel draws a checkbox
  per built-in tool (`read`, `bash`, `edit`, `write`) and per installed extension, each group led by
  a switch for the whole list that reads `mixed` when half of it is off. The built-in boxes go out as
  `--exclude-tools`, which pi applies after every other selection option, and an unboxed extension is
  simply not passed as `-e`. The switches are stored per board as `toolsOff` and `extensionsOff`, so
  they land on the next child that starts, which is how a running thread keeps what it began with.
  The list itself comes from `GET /tools` and is read the first time the panel opens.
- **What a thread is told**: `--append-system-prompt` says it is one thread on a board, in which
  folder, that the human reads cards rather than a chat log, and that its chat answer is a pointer of
  a line or two naming the cards it wrote as `[[key]]`, that a card must carry the very key the
  pointer names, and that neither a plan nor a summary belongs in that answer. It is told that one
  card holds one kind of thing — a chart, an analysis, a diagram, a checklist — that it reads the
  board before writing so a card on the same subject is revised under its key rather than duplicated,
  and that only a fenced svg block draws a picture. It is also told where its own git worktree is,
  what branch it is on and what that branch was cut from, that it commits there, that changed files
  earn one clause naming the branch and the path, and that no merge happens without the human. Three
  examples of right and wrong are in the prompt. A thread whose folder is not
  a repository is told it works in place, and why.
- **The board makes the worktree, not the child.** On a thread's first message, before anything is
  spawned, the daemon runs `git worktree add --detach <repo>/.agents/<id> <base>`, spawns the child
  with that path as its `cwd`, and leaves the branch to the child. `<id>` is the first eight hex of the
  thread id, so the folder is one level deep and never collides with another thread's. The tree starts
  detached because a branch is a name for work and the work is not known until the code has been read:
  a request that only asks a question writes no branch at all, and an implementation still answers "what
  is this" before it answers "what do we call it". `POST /thread {type}` still overrides the kind of
  change when the human knows it up front. `<base>` is `dev` when the repository has one, else
  the branch checked out. The child is told to cut `<type>/<slug>-<id>` before its first edit, `<type>`
  being `fix`, `feat`, `refactor`, `docs`, `test` or `chore` and the slug saying what the work turned
  out to be; to stay on that branch while it edits and commits; that it may check out the base or
  another branch to read and compare; and that it may rename its branch when the name stops fitting.
  No branch is ever named `thread-N` or `agent-N`, and no counter is kept. This supersedes `2e6c8db`,
  which handed `git worktree add` to the child: a rule a model may skip is a rule that half the time is
  skipped.
- **The board learns the branch from the tree, after every turn.** `settleTreeBranch` reads
  `git rev-parse --abbrev-ref HEAD` in the tree when a run settles, so the card shows the branch the
  child actually cut without the child having to say so. A detached HEAD that has commits ahead of the
  base is a child that committed without branching, where the work is reachable from the reflog alone
  and a sweep would read the tree as empty: the board cuts `<type>/<slug>-<id>` there itself, taking
  the type and the slug from the commit subject with its own `feat:` prefix removed, `wip` when that
  subject says nothing. `retireWorktree` asks the same question in the other direction, counting
  `base..HEAD` inside a tree with no branch and reporting such a tree as `detached at <base>`. A card
  whose tree is still detached prints `detached on <base>` in its muted worktree line.
- **A thread moved into a tree takes its session with it.** pi resolves `--session <id>` in the folder
  the child is started in, so once the child runs in a worktree its session is a session of another
  project, and pi's answer to that is a question on stdin — `Fork this session into current directory?
  [y/N]` — which nothing on a board can answer: the child exited before it settled and the card carried
  that question as its error. Such a child is now started with `--fork <id>`, which brings the history
  into the tree, and the id the child reports back on `get_state` is what the next run resumes. Whether
  the session has moved is read from the `cwd` in the header of its file, of which only the first block
  is read; a thread whose session file is gone still gets `--session`, so the `pi session behind this
  thread is gone` reason stays as it was. This is why a thread created before worktrees existed keeps
  its conversation when its first message makes the tree.
- **`clean` is the only thing that deletes a tree.** It retires the worktree of a thread that is gone
  when `git status` finds no uncommitted change in it (ignored files do not count) and the branch has
  no commit its base does not have, and reports the rest — a tree with work in it is named in the
  response with the reason it was kept, never removed. A count git cannot read (a base branch that was
  renamed or deleted) is treated as unknown, so nothing is deleted on a guess. The record of a tree
  belongs to the board rather than to the thread, in `board.trees`, so closing a thread card or
  clearing the board leaves the tree sweepable instead of orphaned.
- **An answer arrives as it is written.** `message_update` from the child carries `text_delta`, and
  the daemon buffers it per content block, puts it on the turn in flight and re-broadcasts the card
  that holds that turn — the note when a note is being answered, the thread's own card otherwise — at
  most ten times a second. `turn.streaming` makes the card draw a caret; it is set when the message is
  asked, so the caret covers the wait before the first word and the tool calls after it, and it is
  cleared by `agent_settled`, a stop, a kill or a dead child, in every case with the card re-sent.
  A finished block replaces the buffered text with its own authoritative content. The turn's answer is
  every assistant message of the run joined by a blank line, so a run that talks, calls a tool and
  talks again keeps both halves; a message pi reports as `aborted` or `error` settles the turn as
  `stopped` rather than `answered`, and one it is about to retry does not leave its half behind to be
  read twice. A tick itself writes nothing to the board file, though an unrelated save during a run
  carries the half sentence to disk, where it is stored as `stopped`. On the client a growing reply
  repaints only that turn's answer, and while the card's own body is unchanged only the conversation
  is painted, so a note being answered keeps the reader's selection. The card's height fits once, when
  the run settles, because every growth would otherwise write the card's place to the daemon ten times
  a second. A reader already at the bottom is carried along; one who scrolled up is left where they
  are.
- **Notes** are the cards with no child behind them. `POST /card/note {markdown, title?, rect?}`
  puts one on the board, `POST /edit {cardId, markdown}` rewrites it, and `POST /layout` and
  `POST /close` treat a note like a thread. A message asked on a note starts a thread named after
  it, cascading under the note through `threadRoot`. Notes are saved with the board and come back
  with their text, place and fold. A `key` makes a note stable: the same key revises that card
  instead of stacking another, which is what a running agent stepping through a job needs. The key
  goes out with the card, because a `[[key]]` written in another card or in a reply is resolved
  against it in the browser: a key the client never received is a link that goes nowhere. A note
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
- **A run is stopped or killed where it is read, and only there.** The thread's own activity section
  carries the one control: `■` asks the child to abort, and the same control becomes `⊗` — kill —
  when the stop does not land. It was on the card's header too, with the same stop-then-kill state
  kept in two places; the card lost it. `POST
  /stop` takes a card id and stops only that thread; without one it still stops everything, which is
  what the header button means. `POST /kill` sends SIGKILL, marks the turn stopped, drains the queue
  that nothing will now serve, and leaves the thread and its card in place, so the next message starts
  a fresh child on the same session. An abort asked for before the child got going is repeated on the
  run's first event, because there was no run to abort yet.
- **A source card is titled by its file, then by its label**: `docs/notes.md - The list as it reads
  now`. The path is made relative to the workspace, so a card says where it is before what it is.
  Opening the same file again titles the card from the file once more, so a name given by hand to a
  file card lasts until that file is asked for again.
- **A card's name is the human's too.** Two presses on the name in a card's head turn it into a field
  holding itself: Enter or a click elsewhere keeps what was typed, Escape drops it, and an empty name
  keeps the one the card had. `POST /rename {cardId, title}` stores it on the card, or on the thread
  when the id names a thread, because a thread is drawn as a card of its own. The press that starts a
  rename belongs to the name, so the card does not also drag, and one press still drags it.
- **A card draws only what it has.** A thread card's `text` is empty by design — the turns are the
  conversation — so an empty text draws no bubble and no state line.
- **The rail is a stack of threads.** Every activity row says which thread wrote it, and a settled row
  is filed in that thread's foldable section: title, count, newest thread on top. A folded section is
  remembered for the session only. Rows still running stay in the strip above the log, so what is
  happening now is visible however far the log is scrolled; that strip belongs to no section, so a
  running row names its own thread beside the tool.
- **Right click a thread in the rail to read it whole.** `GET /transcript/<threadId>` renders the
  session file pi wrote into entries — `user`, `thinking`, `call`, `result`, `answer` — and the drawer
  shows them in that order, marked and coloured by kind, with the thread's status and branch in its
  head. It is the conversation, not the child's protocol stream: the stream is JSON frames, and what a
  human reads in a terminal is the conversation they carry. The system prompt is left out, one block is
  cut at 4000 characters and the last 600 entries are served, because a tool result can be megabytes
  and a drawer holding one is a tab that stops answering. The drawer reads again every 2.5 seconds
  while `follow` is on, keeps the reader's scroll unless they were at the bottom, and costs nothing
  while it is closed: nothing is written to disk for it, the session file is already there.
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
- **The models offered first are pi's own scope.** `GET /models` also reads `enabledModels` from
  `settings.json` in the agent directory (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`), which is the key
  `/scoped-models` writes. Nothing in pi-studio stores that list, so there is nothing to keep in sync:
  pi is its only editor. It is read on every call rather than cached with the catalogue, and the client
  refetches `/models` each time the picker opens, so an edit made in a console pi lands on the next open.
  Patterns resolve in pi's order — `provider/id` first, then the same id on every provider that offers
  it, then globs on `provider/id` and on the bare id, then the one model a piece of an id names, an alias
  before a dated snapshot as pi chooses it — and a trailing `:level` is cut away. pi's fuzzy match on
  model *names* cannot be reproduced, because `pi --list-models` prints no names.
  A pattern that matches nothing is listed in `problems`, said once on stderr, and shown as a note in
  both lists — including the full one, which is the only list left when nothing in the scope resolved.
  The picker opens on the scope, names the provider on each row because a scope has one heading, and
  swaps to the whole catalogue with one row, remembered in `localStorage` as `board.allModels`. The
  model a running thread answers with keeps its row, marked `not scoped`, when pi's scope no longer
  names it. Only the agent-level file is read: a project `.pi/settings.json` can override the list for
  one folder, and a board there would then show wider than its children cycle.
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
  fresh child when it is asked again. Nothing that can answer is touched. It also sweeps the worktrees
  of threads that are gone — see the worktree bullets — and answers `{removed, rows, trees}`, where a
  kept tree carries the reason it was kept. `POST /new` empties the board in the same workspace and
  keeps its settings; the button turns into `sure?` for four seconds first. The worktree records stay
  in the board file, so a tree left behind by `new` can still be swept by a later `clean`. Both answer
  with a snapshot, which the client already replays, so every open tab rebuilds.
- **Usage is asked for, then shown twice.** A pi child keeps its own numbers, so at every settle the
  daemon sends `{"type":"get_session_stats"}` and holds the child's stdin open until the answer
  arrives — `stdin.end()` before it threw the last run's cost away. `thread.stats` keeps input,
  output, cache reads, total, cost, message and tool counts, and the context the last request carried.
  A thread's activity section head shows its context, its cost and the stop; the footer along the
  bottom edge follows the selection the way the wheel and the dimming do: with a card selected it is
  that thread in full — provider and model in the clear, tokens, cache, cost, context against the
  window, messages and tools, `running` while a run is live — and with nothing selected it is the
  board's totals, summed, with the largest context, since contexts do not add up.
- **The footer is not a header.** Those figures used to sit between the header's buttons as zeros;
  they moved to a 24 px strip that the `+` button and the cards keep clear of.
- **The wheel has one target.** Ctrl/Cmd zooms at the pointer. Otherwise an open editor under the
  pointer scrolls its own text, and everything else is decided by the selection: a selected card
  scrolls its own body, nothing selected pans. A card with comments is scrollable, so it must not
  take the wheel merely by being under the pointer — that pinned the board to whatever card the
  pointer crossed.
- **The edit pencil toggles, and the editor keeps its card's height.** A press while the editor is
  open closes it, done on `pointerdown` because the press blurs the textarea and the blur commits and
  repaints, after which the card no longer reads as editing and the click would open a fresh editor.
  A textarea carries no height of its own, so the card's height is measured before the swap and
  becomes the editor's floor; without that an auto-sized card collapsed to its minimum.
- **The board has a minimap.** A 208×140 canvas sits under the header at the right, the corner the
  `+` button and the footer leave free. Every card is a rectangle in its kind's colour, the window
  you are looking through is drawn over them and the rest is dimmed; a folded card is drawn at
  header height, because that is the size on the board. It draws `cards[]` and `view`, so nothing
  about it reaches the daemon, and it repaints once a frame from `applyView`, `placeCard`, the drag
  and resize moves and `setMini`, plus a `ResizeObserver` on the viewport. A press puts the window
  on that point, a drag keeps it under the pointer, a press on a card centres that card, and `m` or
  the header's `map` button hides it, remembered in `localStorage`.
- **The workspace's git state hangs under the minimap.** A 208px column between the map and the `+`
  draws the commit graph: one lane per branch, refs as pills (`dev`, `origin/dev`, a thread's branch,
  tags), an amber ring and a count on a commit that has uncommitted work, and a halo that breathes
  on the commit a running thread is standing on. It has no panel and takes no clicks, so the board
  reads and pans through it; the map's toggle moves it up and `body.git-on` is what shows it at all.
  The daemon reads the disk, never the page: `gitGraph` is one `git log --all --topo-order`
  (`-n 40`, refs from `%D`) and `gitStatusOf` is one `git status --porcelain=v2` per checkout. A
  commit gets a 34px row: its refs as pills on the dot's own line, its subject as the caption under
  it, so 22 commits fill the column at 1080. Junctions are right angles with a 3px corner and dots
  are hollow rings, so the board's dots read through the graph; a merge opens the nearest free lane,
  because a one-column bend reads as a fork and a five-column one reads as a line across the graph. A
  board with a tab open is watched every 3 s, the fingerprint is compared and only a real change is
  broadcast as `{type:"git"}`, plus a look 400 ms after a turn settles; with no tab open nothing runs.
  Measured: 6 ms for the graph, 2–3 ms per tree, so eight trees cost about 40 ms of a core.
  It says nothing when the folder is not a repository, and it will not claim insertions or remote
  drift: neither is readable without a `diff` or a fetch.
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

Worktrees, against daemons on throwaway `HOME`s whose `~/.pi/agent` is symlinked so pi keeps its
credentials, in scratch repositories: a thread's first message made `.agents/agent-1/fix-the-parser-bug`
on branch `agent-1/fix/fix-the-parser-bug`, and the child answered `pwd` with that path, so the tree is
where it works; a second thread in the same repository got `agent-2/refactor/refactor-the-loader`; the
base was `dev` where the repository had one and `main` where it did not; `ignored` came back true in a
repository whose `.gitignore` listed `.agents/` and false in one that did not, and the false case put a
line about it in the child's prompt; a folder that is not a repository got `{skipped: "this folder is
not a git repository"}` on the thread and on its card, and the child still ran there. Those paths and
branches are the older `<agent>/<type>/<slug>` layout, which is superseded twice over: `.agents/<id>`
with the branch cut by the child replaces it, and the code still sweeps a tree made by the old layout
because it retires whatever path the board recorded. `clean` removed
three empty trees and their branches, kept a fourth whose tree had one commit the base did not have,
and said so: `1 commit(s) not in dev`. A tree whose thread was closed with `POST /close` was swept by
the next `clean`, and a tree left behind by `POST /new` was still reported by a later `clean`, which is
what the board's own record of a tree is for. With the base branch deleted, `clean` deleted nothing and
answered `could not read dev..agent-1/...`, so an unreadable count is not taken for a zero. The prompt
the child actually received was read out of its session file, which is how the wording above is known
rather than assumed. `board_source` resolving a relative path against the asking thread's tree is
reasoning from the code: no run has asked for a file from inside a tree yet, and none of this has been
seen in a browser.

The detached tree, against the live daemon on this repository: a thread asked to name the constant
holding `.agents` made `.agents/94f3d5ce` and stood there detached, with no branch in `git branch` and
no `branch` field on the record. Told to write a file and commit it, the same thread cut
`chore/notes-probe-94f3d5ce` itself and the board read that name off the tree at `agent_settled`, so
the card carried a branch the child had never reported. A second thread told to commit while staying
detached did exactly that (`61510a6`, reachable only from the reflog), and the board cut
`chore/add-rescue-probe-md-<id>` on its behalf and moved the tree onto it; before the prefix strip that
name read `chore/chore-add-rescue-probe-md-<id>`, so the strip is checked against four subjects rather
than assumed. A third thread read only and left the tree detached with nothing in it; `POST /close`
followed by `POST /clean` removed that tree and reported it as `detached at dev`, while the two trees
holding commits were kept and reported against their branches. The three probe threads, their trees and
their branches were removed by hand afterwards. Not exercised: a daemon restart with a detached tree on
the board, which the loader now allows, and any of this in a browser.

A thread moved into a tree, against the same kind of throwaway daemon: the board file was edited to give
it a session made in the workspace folder, and its next message made the tree and started the child with
`--fork`. The child answered with a word from that older conversation (`Platypus.`), its own session
file had `cwd` in the tree and a `parentSession`, the thread's `sessionId` moved to the new one, and a
second message kept that id and started no third session. The same setup without the change gave the
card `child exited (0) before it settled: Fork this session into current directory? [y/N] Aborted.`,
which is the line a person reads as "fork is broken".

Streaming, against real children on a throwaway `HOME` whose `~/.pi/agent` is symlinked so pi keeps
its credentials: a 250-word answer reached the browser as 8 frames growing 216 → 1432 characters,
104–189 ms apart, ending `answered` with the caret cleared; a longer one showed the caret alone for
11 seconds while the child started and thought, then grew to 1280 characters over 10 frames; a run
told to say READY, run `ls` and say DONE ended with one answer holding both halves; a run stopped once
186 characters had arrived kept those characters and read `stopped`. A thread that owned a note of its
own streamed thirteen frames to its own card and left the note untouched, which is what a review of the
first draft found broken: the tick had been aimed at the newest card the thread owned. A card closed
while its run was writing is pinned to a turn that does not exist, so the reply lands nowhere instead
of on the thread's older answer; that is reasoning from the code, not a run. Those runs also found a
bug: the flush timer lived on the thread, and `GET /state` serialises whole threads, so a pending timer
made that request throw "Converting circular structure to JSON". Timers live in a `WeakMap` now. The
caret and the incremental repaint have not been seen in a browser; the client half is checked by
`node --check` and by reading it, not by eye.

Reported by the commits that added the settings and the clean/new verbs, both against a real daemon
and neither re-checked since: crossroads defaults set, and refused with 409 for a model this machine
cannot run or 400 for a level pi does not name; a new board inheriting them; a board changing its own
`dimOthers` without moving the crossroads default; a thread starting with the inherited model and
level; `POST /model` with no card landing in `board.config`. Cleaning removed exactly the rows of a
closed thread and kept the open one's card and rows; `new` emptied cards, threads and activity and kept
model and level. Those commits say the panel, the picker, the dimming on a five-card board, both
buttons and the `sure?` arming were seen in a browser. `npm run check` passes on the current tree.

## Does not work yet

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
  left behind starts a fresh child when asked again. It also removes the worktree and branch of a gone
  thread when the tree has no uncommitted change and no commit the base does not have, and names the
  trees it kept and why. `new` empties the board and keeps the workspace and its settings; because it
  throws work away, the button turns into `sure?` and the second press inside four seconds is the
  answer. Both answer by sending a snapshot, which every open tab already knows how to replay.
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

1. A workspace entry that no longer resolves: offer to forget it.
2. Fork a thread, then feeding a card into another thread.
3. Brainstorm how to organize subagents on a board — potentially replace `delegate`.
4. HTML artifacts: a card that renders a whole html file, not only source text.
5. Home screen redesign — the crossroads (`/`, `welcome.html`/`welcome.css`/`welcome.js`).
6. A debug view of the raw stream from a pi child: the stdout lines `handleChildLine` parses, line by
   line and unfiltered, beside the 1000-character `stderrTail` that is kept today.
7. Retire the board in the pi extensions repo. The `dashboard` extension duplicates this app, which is
   why children exclude it by name; once this one is the only board it can go.

## Rules

- `public/` is the client; do not add a second UI beside it.
- `.agents/` is where worktrees and scratch plans live, and it is gitignored. One name, one folder.
- No subagent starts a browser or sends signals to processes; verification is curl and `node --check`.
- One slice per commit, conventional commits, review before commit.

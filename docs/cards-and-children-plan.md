# Plan: fewer cards, written for somebody

The board fills with cards nobody asked for. Two sources, one shape of fix.

Spawned children draw on the board they were spawned from, and a scout that leaves a note, a todo and a
source card for every step clutters the workspace its parent is also drawing on. The thread the human
talks to draws too much as well, because its prompt says the chat is only a pointer to cards, which
leaves a card as the only way to say anything.

So: children stop drawing. A thread that does draw obeys two new board settings, one for how often it
writes a card and one for whom the card is written. The frequency and the audience rules are prompt
files, like every other set of words this app sends to a model.

## What the human decided

- Both settings live on the board and on the crossroads as the default a new board is born with, the
  way `dimOthers` already does.
- A spawned child gets no board tools at all. It reports in its last message and the thread that
  spawned it writes whatever card is worth writing.
- The audience list is ours to choose, with `programmer` and `data-analyst` in it, and `designer` and
  `junior` as well.

## The two axes

| setting | stored key | ids | default | what it decides |
| --- | --- | --- | --- | --- |
| card verbosity | `cardsVerbosity` | `quiet`, `normal`, `verbose` | `normal` | how often a thread opens a card |
| card audience | `cardsAudience` | `programmer`, `data-analyst`, `designer`, `vibecoder`, `junior`, `mathematician` | `programmer` | what goes inside one |

`quiet` means a card only when the human asks for one, or when the flow the thread runs asks for one.
`normal` means a card for something that has to be seen — a diagram, a table, a plan, the result a
question rests on — and nothing for narration, code quotes or one-line answers. `verbose` is what the
board does today.

The audience decides what a card may contain:

| audience | a card carries | a card does not carry |
| --- | --- | --- |
| `programmer` | paths, identifiers, diffs, code where the exact text matters | hand-holding prose about what a file is |
| `data-analyst` | tables with units and column meaning, counts, charts | code past snippets that read as columns |
| `designer` | layout, states, spacing, flows, token names | implementation code, stack traces |
| `vibecoder` | plain words: what happens, what to click, what to expect | code, file paths, jargon |
| `junior` | one idea per card, the file and why, jargon defined once | terse shorthand, unexplained acronyms |
| `mathematician` | definitions, notation, the claim and its proof | code, UI instructions |

## Where the values live

Nothing new is stored. `dimOthers` is the precedent and both axes copy it exactly:

- `workspaces.json#defaults` holds the crossroads choice, which seeds a board the first time its folder
  is opened (`store.ts:302`).
- `board.config` holds this board's own choice, written by `POST /config` and read back by
  `activeConfig()`.
- `activeConfig()` and `activeHomeDefaults()` fall back to `normal` and `programmer` for a board file
  written before this change, so there is no migration.

## Where the words live

One folder per axis, one file per id, plain markdown like every other prompt:

```
prompts/verbosity/quiet.md  normal.md  verbose.md
prompts/audiences/programmer.md  data-analyst.md  designer.md  vibecoder.md  junior.md  mathematician.md
```

`PROMPT_FOLDERS` in `server/child/modes.ts` gains `verbosity` and `audiences`, and the name guard in
`server/routes/board/prompts.ts` gains the same two folders. That is the whole settings-page work for
the words: the page lists what is on disk, so both folders appear under Prompts and every file is
editable there. The valid ids stay in code, beside `ROLE_NAMES`, because a file dropped in by accident
must not become a choice.

## What a thread is told

`boardPrompt()` in `server/child/prompts.ts` splits in two.

A spawned child gets `childPrompt()`: it works in its own worktree, its last message is the whole
report, and it draws nothing — no note, no source card, no question card. The pointer convention
(`[[key]]`, "put the work on cards") is not said to it at all.

A thread the human talks to keeps the card mechanics it has and gains a block built from the board's
two settings, read at spawn like every other prompt:

```
Cards on this board: normal. A card is for something that has to be seen: a diagram, a table, a plan,
the result a question rests on. Not for narration, not for a code quote, not for a one-line answer.

Cards are written for: programmer. Paths, identifiers and code are welcome where the exact text
matters; say what a thing does, not what a file is called.

This thread's flow, or the human asking for a card in so many words, wins over both.
```

The paragraph that says the chat is only a pointer also changes. Today it forces a card for every
answer, which is the reason `quiet` would otherwise be a dead setting. The rule becomes: a pointer when
the work is on a card, the answer itself in the chat when nothing is.

## Slices

### Slice 1 — children draw nothing (`feat(children): a spawned thread has no board tools`)

| file | change |
| --- | --- |
| `server/main.ts` | `threadRefusal` refuses every route in `THREAD_ROUTES` for a caller whose thread has a `parentThread`, with "a spawned child has no board tools". `THREAD_ROUTES` itself stays: a hidden thread answering a card the human started is not a child and keeps its verbs. |
| `server/child/argv.ts` | no `-e <bridge>` when `thread.parentThread` is set. The child cannot call what it was never given, and the guard refuses the route behind that. |
| `server/child/prompts.ts` | `childPrompt()` as above; `boardPrompt()` keeps the human thread's text. |
| `test/guard.test.ts` | a caller with a parent is refused `/card/note`, `/card/source`, `/card/ask`, `/thread/spawn`; a hidden non-child thread keeps them. |
| `test/child.test.ts` | the child's argv has no bridge and its prompt has no `board_note`; the human thread's has both. |

### Slice 2 — the two settings on the daemon (`feat(config): card verbosity and card audience`)

| file | change |
| --- | --- |
| `server/workspaces.ts` | `homeDefaults` parses both keys, `activeHomeDefaults()` and `activeConfig()` fill in `normal` / `programmer`, and the valid ids live here once (`CARDS_VERBOSITY`, `CARDS_AUDIENCE`) beside `THINKING_LEVELS`. |
| `server/routes/board/config.ts` | `onConfig` accepts `cardsVerbosity` and `cardsAudience`, `400` on an id neither list names, and names them in its "nothing to change" answer. |
| `server/routes/crossroads.ts` | `onDefaults` accepts the same two keys with the same checks. |
| `server/settings.defaults.json` | a new group `new-boards.board.writing`, "Cards written by agents", with two `select` fields, `cardsVerbosity` and `cardsAudience`. Six options still draw as a segmented row on the page. |
| `test/settings.test.ts` | both leaves exist, are `select`, carry exactly the ids above, and show the seeded value. |
| `test/routes.test.ts` | `POST /config` saves and `GET /state` reads back, an unknown id is `400`; `POST /defaults` the same, read back through `GET /settings/defaults`. |

### Slice 3 — the words, and the bridge (`feat(prompts): verbosity and audience prompts`)

| file | change |
| --- | --- |
| `prompts/verbosity/*.md`, `prompts/audiences/*.md` | the nine files, four to six lines each, one idea per paragraph. |
| `server/child/modes.ts` | `PROMPT_FOLDERS` gains `verbosity` and `audiences`; `cardsBlock()` builds the block above from `promptText()`, and `modeSystemPrompt` leaves it alone. |
| `server/child/prompts.ts` | the block goes into `boardPrompt()`, after the card mechanics and before the worktree text. |
| `server/routes/board/prompts.ts` | the name guard accepts the two new folders, so a save from the settings page reaches them. |
| `bridge/child-bridge.mjs` | one sentence appended to the `board_note` description from `PI_STUDIO_VERBOSITY`: quiet says a card only when the human asked, normal says a picture, a plan or a decision, verbose says nothing extra. `board_source` says it is not for proving a file was read. |
| `server/child/run.ts` | passes `PI_STUDIO_VERBOSITY` in the child's environment, read from `activeConfig(board)`. |
| `prompts/README.md` | the two folders, and that a spawned child reads no board prompt. |

### Slice 4 — the board's own panel (`feat(board): card verbosity and audience in the settings panel`)

`public/index.html` and `public/client/board.js` only, following the `flow for a new boss` row that is
already there:

- two rows, `card verbosity` and `cards written for`, each showing its value;
- `openPick("verbosity")` and `openPick("audience")` draw local lists with a hint per id, the way
  `drawPathPick` does, and write through `POST /config`;
- `paintConfig()` prints both, so a value changed in another tab arrives with `applyConfig`.

### Slice 5 — the record (`docs(plan): card verbosity and audience`)

This file, and a bullet under "Works" in `STATE.md`: children draw nothing, two axes, where the words
live.

## Checks

1. `/tmp/gate/cards.mjs`, a scratch daemon: `/state` shows `normal` / `programmer` on a board with no
   stored choice; `POST /config {cardsVerbosity:"quiet"}` answers `200` and `/state` shows it;
   `{cardsAudience:"shaman"}` answers `400`; `POST /defaults {cardsAudience:"designer"}` reaches
   `GET /settings/defaults` and a folder opened afterwards is born with it.
2. `node --test test/guard.test.ts test/child.test.ts test/settings.test.ts test/routes.test.ts`.
3. `npm run check` once those are green.
4. In a browser, by the owner: the two rows in the board's panel change the value and survive a reload;
   a new thread on `quiet` writes no card for a one-line answer; the settings page lists Verbosity and
   Audiences and saves a file.

## Risks

- A prompt is advice, not a gate. `quiet` holds because the prompt and the tool description both say
  it, and a model that ignores both will still write a card. The only real gate here is the one on
  children, and that one is in `threadRefusal`.
- A child that loses `board_ask` cannot put a decision to the human mid-run. It reports the decision
  instead, and the boss asks. That is the cost of the cut and it is worth naming in the boss prompt.
- Flow prompts say "put the plan on the board". `quiet` would otherwise make the advanced and complex
  flows impossible, which is why the block ends with the flow winning.
- Six audiences are six files to keep honest. A wrong `programmer` file is a card full of paths and a
  human who wanted plain words; the settings page is where that gets fixed, with no code in between.

## Not doing

- Per-thread verbosity, or per-card audience.
- A daemon-side cap on how many cards a thread may write.
- Rewriting the role prompts beyond the section that says a child draws nothing.

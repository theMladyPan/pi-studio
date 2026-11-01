# Plan: fewer cards, written for somebody

The board fills with cards nobody asked for. Two sources, one shape of fix.

Spawned children draw on the board they were spawned from, and a scout that leaves a note, a todo and a
source card for every step clutters the workspace its parent is also drawing on. The thread the human
talks to draws too much as well, because its prompt says the chat is only a pointer to cards, which
leaves a card as the only way to say anything.

So: children stop drawing. A thread that does draw obeys six board settings — how often it writes a
card, who reads it, and four switches for what may be inside one. The words behind all six are prompt
files, like every other set of words this app sends to a model.

## What the human decided

- The settings live on the board and on the crossroads as the default a new board is born with, the
  way `dimOthers` already does.
- A spawned child gets no board tools at all. It reports in its last message and the thread that
  spawned it writes whatever card is worth writing.
- Content is decided by booleans rather than by the audience: `show_code_fragments`,
  `show_math_formulas`, `show_charts`, `show_references`, all on by default and the same four for
  every audience.

## The six settings

| setting | stored key | ids | default | what it decides |
| --- | --- | --- | --- | --- |
| card verbosity | `cardsVerbosity` | `quiet`, `normal`, `verbose` | `normal` | how often a thread opens a card |
| card audience | `cardsAudience` | `programmer`, `data-analyst`, `designer`, `vibecoder`, `junior`, `mathematician` | `programmer` | vocabulary, and how much is explained |
| show code fragments | `showCodeFragments` | on / off | on | a function name, a path, a two-line snippet |
| show math formulas | `showMathFormulas` | on / off | on | a formula, a symbol, a notation |
| show charts | `showCharts` | on / off | on | a chart, and a table of numbers |
| show references | `showReferences` | on / off | on | a footnote at the foot of the card for every claim that is not the agent's own reasoning |

`quiet` means a card only when the human asks for one, or when the flow the thread runs asks for one.
`normal` means a card for something that has to be seen — a diagram, a plan, the result a question
rests on — and nothing for narration, code quotes or one-line answers. `verbose` is what the board does
today.

The audience no longer decides what may be in a card; the four switches do. What is left to it is the
register: a `programmer` gets the fact and no walkthrough, a `junior` gets the file and the reason with
jargon defined once, a `vibecoder` gets plain words and what to click, a `mathematician` gets every
symbol defined. The audience prompt files are trimmed to exactly that, because a rule written twice is
a rule that will disagree with itself.

## What the four switches mean

Three are permissions and one is a duty, which is why `showReferences` is not a fourth line of the same
shape.

- **Code fragments.** On, a card carries an identifier, a path or a short snippet where the exact text
  matters: `retryFetch`, `server/child/run.ts`, three lines of the loop. Off, the same card says what
  the code does in words. It does not go silent: a card that says nothing because it may not show code
  is worse than one that shows three lines.
- **Math formulas.** On, notation and symbols are fine — `O(n log n)`, `Σ`, a probability. Off, the
  same claim in plain words and numbers, with no symbol left undefined.
- **Charts.** On, a chart of real numbers is a fenced `svg`, and a table of numbers is a table. A
  fenced `mermaid` block is not covered by this switch: a flow, a sequence, a state machine and a tree
  show structure rather than data, and they stay available at every setting, because a diagram is the
  cheapest thing a card can hold. A table of words is prose and stays too.
- **References.** On, a claim that is not the agent's own reasoning — a version, a behaviour, a number,
  what a library does — carries a marker and a line at the foot of the card that resolves to a URL or a
  file path. A reference that resolves to neither is not a reference; a claim the agent could not
  ground says so instead of inventing a citation. Off, no reference block, and the card is shorter by
  exactly what it can no longer prove.

The card renderer draws links, tables, fenced code, `mermaid`, `svg` and tick lists. It has no footnote
syntax, so `[^1]` would arrive as literal text. The convention the prompt asks for is one that already
renders:

```
The retry loop gives up after three tries [1], which is the number the vendor's docs state [2].

- [1] server/agents/retry.ts:88 — where the counter stops
- [2](https://vendor.example/api/limits) — the documented limit
```

The `[1]` in the prose is a marker and nothing clickable, which is fine: the foot of the card is where
the answer is.

With references on, a `board_source` card is no longer how a thread shows its evidence — the path in
the reference is. `board_source` goes back to what it says on the tin: opening a file because the human
asked to see it. That is the second half of the "code cards popping up" fix, and it needs no setting.

## Where the values live

Nothing new is stored. `dimOthers` is the precedent and all six copy it:

- `workspaces.json#defaults` holds the crossroads choice, which seeds a board the first time its folder
  is opened (`store.ts:302`).
- `board.config` holds this board's own choice, written by `POST /config` and read back by
  `activeConfig()`.
- `activeConfig()` and `activeHomeDefaults()` fall back to `normal`, `programmer` and four times `on`
  for a board file written before this change, so there is no migration.

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

The four switches need no files. What each one says to the model is one line built in
`cardsBlock()`, in the same place as the two settings that do read files.

## What a thread is told

`boardPrompt()` in `server/child/prompts.ts` splits in two.

A spawned child gets `childPrompt()`: it works in its own worktree, its last message is the whole
report, and it draws nothing — no note, no source card, no question card. The pointer convention
(`[[key]]`, "put the work on cards") is not said to it at all.

A thread the human talks to keeps the card mechanics it has and gains a block built from the board's
six settings, read at spawn like every other prompt:

```
Cards on this board: normal. A card is for something that has to be seen: a diagram, a plan, the
result a question rests on. Not for narration, not for a code quote, not for a one-line answer.

Cards are written for: programmer. The fact and no walkthrough; say what a thing does, not what a
file is called.

What a card may contain: code fragments yes; math formulas yes; charts and tables of numbers yes;
references yes, a marker in the line and a line at the foot that resolves to a URL or a file path.

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

### Slice 2 — the six settings on the daemon (`feat(config): card verbosity, audience and content switches`)

| file | change |
| --- | --- |
| `server/workspaces.ts` | `homeDefaults` parses all six keys, `activeHomeDefaults()` and `activeConfig()` fill in the defaults, and the valid ids live here once (`CARDS_VERBOSITY`, `CARDS_AUDIENCE`) beside `THINKING_LEVELS`. |
| `server/routes/board/config.ts` | `onConfig` accepts the two ids and the four booleans, `400` on an id neither list names or a switch that is not a boolean, and names them in its "nothing to change" answer. |
| `server/routes/crossroads.ts` | `onDefaults` accepts the same six with the same checks. |
| `server/settings.defaults.json` | the new group `new-boards.board.writing`, "Cards written by agents", with two `select` fields and four `toggle` fields. Six options still draw as a segmented row on the page. |
| `test/settings.test.ts` | all six leaves exist, with the right types, the exact ids above, and the seeded value. |
| `test/routes.test.ts` | `POST /config` saves and `GET /state` reads back, an unknown id and a non-boolean are `400`; `POST /defaults` the same, read back through `GET /settings/defaults`. |

### Slice 3 — the words, and the bridge (`feat(prompts): verbosity, audience and card content prompts`)

| file | change |
| --- | --- |
| `prompts/verbosity/*.md`, `prompts/audiences/*.md` | the nine files, three to six lines each, one idea per paragraph. |
| `server/child/modes.ts` | `PROMPT_FOLDERS` gains `verbosity` and `audiences`; `cardsBlock()` builds the block above from `promptText()` and the four switches. |
| `server/child/prompts.ts` | the block goes into `boardPrompt()`, after the card mechanics and before the worktree text. |
| `server/routes/board/prompts.ts` | the name guard accepts the two new folders, so a save from the settings page reaches them. |
| `bridge/child-bridge.mjs` | one sentence appended to the `board_note` description from `PI_STUDIO_CARDS`: verbosity, and which of the four may be on a card. `board_source` says it is for a file the human asked to see, never for evidence. |
| `server/child/run.ts` | passes `PI_STUDIO_CARDS` in the child's environment, built from `activeConfig(board)`. |
| `prompts/README.md` | the two folders, and that a spawned child reads no board prompt. |

### Slice 4 — the board's own panel (`feat(board): card settings in the panel`)

`public/index.html` and `public/client/board.js` only: two `cfg-row` buttons that open a pick list the
way the flow row does, and four toggle rows that flip on click the way `dim other threads` does. Both
read and write through `POST /config`, and `paintConfig()` prints all six.

### Slice 5 — the record (`docs(plan): card settings, and no board tools for children`)

This file, and a bullet under "Works" in `STATE.md`.

## Checks

1. `/tmp/gate/cards.mjs`, a scratch daemon: `/state` shows the six defaults on a board with nothing
   stored; `POST /config {cardsVerbosity:"quiet"}` answers `200` and `/state` shows it;
   `{cardsAudience:"shaman"}` and `{showCharts:"yes"}` answer `400`; `POST /defaults` with all six
   reaches `GET /settings/defaults`, and a folder opened afterwards is born with them.
2. `node --test test/guard.test.ts test/child.test.ts test/settings.test.ts test/routes.test.ts`.
3. `npm run check` once those are green.
4. In a browser, by the owner: the six rows in the panel change and survive a reload; a new thread on
   `quiet` writes no card for a one-line answer; a card with `showReferences` on carries a foot;
   the settings page lists Verbosity and Audiences and saves a file.

## Risks

- A prompt is advice, not a gate. `quiet` and the four switches hold because the prompt and the tool
  description both say so, and a model that ignores both still writes a card full of code. The only
  real gate here is the one on children, and that one is in `threadRefusal`.
- References lengthen every card, and a minted reference is worse than none. That is why the rule names
  what a reference has to resolve to, and why "I could not ground this" is offered as the honest answer.
- Six settings on two surfaces is twelve controls to keep in step, all of them through `activeConfig`.
  The alternative — a per-audience preset that writes the four switches — was rejected: a preset that
  overwrites a switch the human set is a switch that lies about its state.
- A child that loses `board_ask` cannot put a decision to the human mid-run. It reports the decision
  instead, and the boss asks. That is the cost of the cut and it is worth naming in the boss prompt.
- Flow prompts say "put the plan on the board". `quiet` would otherwise make the advanced and complex
  flows impossible, which is why the block ends with the flow winning.

## Not doing

- Per-thread settings, per-card switches, or an audience matrix of presets.
- A daemon-side cap on how many cards a thread may write.
- Rewriting the role prompts beyond the section that says a child draws nothing.
- Footnote syntax in the card renderer: the convention above draws with what the board already has.

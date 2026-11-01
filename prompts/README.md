# Prompts

Spawning a thread gives it a role, and a role is a file here. A thread the human started gets a mode
instead, and a boss among those also gets a flow. Two of the board's card settings pick a file here too.

- `board/conventions.md` is what every thread the human starts is told about the board itself: that the
  chat is a pointer to the cards, one card holds one kind of thing, mermaid before svg, detail on
  request. It is the general usage prompt, and the one file to edit when a board's threads write the
  wrong shape of card. A spawned child reads none of it, and neither does a missing file: the prompt
  then says the file is missing and leaves it there.
- The facts stay in code: `boardPrompt` in `server/child/prompts.ts` writes the thread's title, its
  folder, the `[[key]]`-to-`board_note key` rule, and the cards block at the end. A count of cards, a
  chart's format or the mermaid rule belong in the file, because no route enforces them.

- `roles/<role>.md` is the body of that role's instructions. The daemon reads it when a child starts,
  so an edit takes effect on the next spawn and never rewrites a run already going.
- The daemon adds a short frame around the file: who spawned the child, that its last message is the
  whole report, that it cannot ask the human anything, and that it works in its own worktree. That
  frame lives in `server/child/roles.ts` (`roleSystemPrompt`), because it is behaviour rather than advice.
- A role also sets tool rules and a thinking level, in `ROLE_TOOLS_OFF` and `ROLE_THINKING` next to
  it: scout, review and architect may not write, and scout and chore think at medium while
  implement, review and architect think at high.

- `modes/<mode>.md` is what a human's thread is for: `plan` writes a plan and throwaway checks under
  `/tmp`, `boss` spawns children and does no work itself. `agent` has no file, because it is the
  baseline the board already had. The tool rules are `MODE_TOOLS_OFF` in `server/child/modes.ts`:
  neither a planner nor a boss may write or edit.
- `flows/<path>.md` is the flow a boss runs: `simple`, `advanced`, `complex`. A boss on `auto` reads
  none of them, picks one, and says which with the `board_path` tool, so its card can show it.
- `verbosity/<id>.md` and `audiences/<id>.md` are not chosen by a spawn but by the board: they are the
  words behind `cardsVerbosity` and `cardsAudience`. The ids a board may hold are in
  `server/card-settings.ts`, and `PROMPT_FOLDERS` in `server/child/modes.ts` lists both folders, so
  the settings page draws per file and a file added here is editable there with no code in between.
  The four content switches of a card have no file: each is one line in `card-settings.ts`.

Roles today: scout, implement, review, chore, architect. Modes: agent, plan, boss. Flows: simple,
advanced, complex. Verbosity: quiet, normal, verbose. Audiences: programmer, data-analyst, designer,
vibecoder, junior, mathematician. Board: conventions. The board's settings page edits these files, so
keep them plain markdown with no front matter and one idea per paragraph.

A spawned child reads no board prompt. `server/child/prompts.ts` gives it `childPrompt` instead of
`boardPrompt`, so it reads no conventions either, and it is not started with the bridge at all: it draws
nothing on the board, and its last message is the whole report.

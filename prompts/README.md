# Prompts

Spawning a thread gives it a role, and a role is a file here. A thread the human started gets a mode
instead, and a boss among those also gets a flow.

- `roles/<role>.md` is the body of that role's instructions. The daemon reads it when a child starts,
  so an edit takes effect on the next spawn and never rewrites a run already going.
- The daemon adds a short frame around the file: who spawned the child, that its last message is the
  whole report, that it cannot ask the human anything, and that it works in its own worktree. That
  frame lives in `server.mjs` (`roleSystemPrompt`), because it is behaviour rather than advice.
- A role also sets tool rules and a thinking level, in `ROLE_TOOLS_OFF` and `ROLE_THINKING` next to
  it: scout, review and architect may not write, and scout and chore think at medium while
  implement, review and architect think at high.

- `modes/<mode>.md` is what a human's thread is for: `plan` writes a plan and throwaway checks under
  `/tmp`, `boss` spawns children and does no work itself. `agent` has no file, because it is the
  baseline the board already had. The tool rules are `MODE_TOOLS_OFF` in `server/child/modes.ts`:
  neither a planner nor a boss may write or edit.
- `flows/<path>.md` is the flow a boss runs: `simple`, `advanced`, `complex`. A boss on `auto` reads
  none of them, picks one, and says which with the `board_path` tool, so its card can show it.

Roles today: scout, implement, review, chore, architect. Modes: agent, plan, boss. Flows: simple,
advanced, complex. The board's settings page will edit these files, so keep them plain markdown with
no front matter and one idea per paragraph.

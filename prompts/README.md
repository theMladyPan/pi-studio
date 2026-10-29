# Prompts

Spawning a thread gives it a role, and a role is a file here.

- `roles/<role>.md` is the body of that role's instructions. The daemon reads it when a child starts,
  so an edit takes effect on the next spawn and never rewrites a run already going.
- The daemon adds a short frame around the file: who spawned the child, that its last message is the
  whole report, that it cannot ask the human anything, and that it works in its own worktree. That
  frame lives in `server.mjs` (`roleSystemPrompt`), because it is behaviour rather than advice.
- A role also sets tool rules and a thinking level, in `ROLE_TOOLS_OFF` and `ROLE_THINKING` next to
  it: scout, review and architect may not write, and scout and chore think at medium while
  implement, review and architect think at high.

Roles today: scout, implement, review, chore, architect. The board's settings page will edit these
files, so keep them plain markdown with no front matter and one idea per paragraph.

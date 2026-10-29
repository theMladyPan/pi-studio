# Deferred asks

Work that has been decided against doing yet. Each entry says what it is, what it would touch, and
what has to be settled before it can start. Nothing here is a plan; `STATE.md` says what works now and
`MODULARIZATION.md` (branch `docs/task-notes-ab687f16`) says where the big files are going.

Line numbers are `dev` as this tree sees it.

Nothing is deferred right now. `board_thread`, the fourth bridge tool, is built: a thread spawns a
child with a role, waits for its answer, and the child may not spawn one of its own. The limits it
carries are in `server/limits.ts` and its prompt files are in `prompts/roles/`.

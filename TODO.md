# Deferred asks

Work that has been decided against doing yet. Each entry says what it is, what it would touch, and
what has to be settled before it can start. Nothing here is a plan; `STATE.md` says what works now and
`MODULARIZATION.md` (branch `docs/task-notes-ab687f16`) says where the big files are going.

Line numbers are `dev` as this tree sees it.

## `board_thread` as a fourth bridge tool

A thread is one card and one pi child. Today only the human can make one, with `+` in the browser.
The bridge gives a child `board_note`, `board_source` and `board_ask` (`bridge/child-bridge.mjs:146`),
so a child that wants a slice of work to have its own session, its own card and its own stop button
has to do it all in its own turn.

A fourth tool, `board_thread {title, prompt?, model?}`, would let it put a thread card on the board
and return that card's id.

- [ ] tool shape: `board_thread {title, prompt?, model?}`, answer with the new card id
- [ ] no `prompt`: card created, no child spawned. That is what `POST /thread` already does
  (`server/routes/board/thread.ts`), so this half costs nothing and is the safe default
- [ ] with `prompt`: the new thread's own child starts on it, so the caller's run is the grandparent
  of a run it cannot steer
- [ ] placement: `call()` already sends `threadRoot` (`bridge/child-bridge.mjs:33`), but `onThread`
  drops it, so a card made this way lands wherever the daemon puts a fresh thread. `onNote` sends the
  same field through `anchorOf` (`server/routes/board/thread.ts`); a thread card would need the same, and
  `threadRoot` is already on the thread row (`server/store.ts`)
- [ ] depth: nothing caps nesting. `MAX_THREADS = 200` (`server/store.ts`) caps the board, not the
  chain, so one child could fill a board with children of its own
- [ ] register it in `boardBridge` beside the other three

The depth cap and a budget line have to be settled with the tool, because a child that can spawn
children can spend money in a loop. That is the reason this waits.

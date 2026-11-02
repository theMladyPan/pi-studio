# Visual asks, marked down and not built

Three requests, none of them implemented. Line numbers are `dev` at `72a0a3d`, which is the tree this
worktree sees.

The fourth request this file used to carry — clean pruning only merged branches — was checked against
the code and needs no work: it is what the tree already does.

## Settled: clean prunes only merged branches

Read from the code, not from a live sweep.

A worktree is retired only when its work is already in the branch it was cut from.
`retireWorktree` (`server/worktrees/retire.ts:18`) lets a tree go on this path and no other:

1. a tree still on disk must have an empty `git status --porcelain`; a dirty tree is kept and the count
   of changes is reported (`server/worktrees/retire.ts:30`);
2. `git rev-list --count <tree.base>..<branch>` must be readable and zero
   (`server/worktrees/retire.ts:46`). An unreadable count is kept, never read as zero — the comment
   beside it records that a failed `rev-list` once deleted a branch holding commits;
3. only then does `git worktree remove` run, followed by `git branch -D`
   (`server/worktrees/retire.ts:73`).

The force-delete is guarded by an ancestry test, so nothing unmerged can be swept.

Four edges worth knowing:

- **The base, not `dev`.** `tree.base` is what `baseRef(repo)` picked when the thread first worked,
  normally `dev`. A branch merged into `main` but not into `dev` still has commits ahead of `dev` and is
  kept. That is the safe direction.
- **Squash and cherry-pick keep the tree.** After a squash merge the branch's commits are not ancestors
  of the base, so the count is not zero, so the tree stays and `clean` reports it as kept. Correct, but
  the sweep will look broken to anyone who squashes.
- **A detached tree is judged on its own HEAD** (`server/worktrees/retire.ts:48`), since it never earned
  a branch.
- **A branch deleted by hand** leaves the record dropped and the tree removed, with the note "the branch
  is already gone" (`server/worktrees/retire.ts:41`).

What the human sees comes from the `/clean` payload: removed trees and kept trees, the kept ones
spelled out in the footer.

## 1. Git graph semi transparent

`#gitstrip` has no panel behind it (`public/index.html:83`); the paint sets `globalAlpha = 1` on dots
and links (`public/client/board.js:3902`) and on the amber ring (`3914`), with the halo breathing under
them at `0.12 + 0.26` (`3896`) and the subject solid grey (`3926`). A change would lower the alpha
across `paintGit` (`public/client/board.js:3827`) so the board reads through the strip.

## 2. Minimap and graph as settings widgets

The two toggles disagree today.

- The map is a session toggle: `#mapBtn` in the header (`public/index.html:999`), `setMap` at
  `public/client/board.js:3626`, on at every load (`let mapOn = true`, `3473`) and stored nowhere — the
  only thing the client remembers about the map is nothing at all.
- The graph is a side effect: `git-on` is set from whether the daemon sent commits
  (`public/client/board.js:3973`), with no key and no button, so a board in a repository always grows a
  strip and a board outside one never does.

Settling them means giving the graph the same key-and-button shape the map has, then optionally
offering both as rows in the settings dialog `#boardConfig` (`public/index.html:1020`, the tree drawn at
`public/client/board.js` in the settings section) rather than as header buttons.

## 3. Git graph: graphics at rest, branches and messages on hover

As specified: the strip shows lanes and dots only. Hovering rolls it further into view, wide enough for
branch and tag pills and commit subjects; leaving hides the text again and leaves the graph.

Where it stands today the opposite way round: the strip is a fixed 208px column
(`public/index.html:84`), and it already draws up to two pills per row
(`public/client/board.js:3919`) and a fitted subject (`3924`) inside that width. So the change is two
things at once: text out of the resting state, and width in the hovered one.

Two ways to get the hover, and they are not equivalent:

- **`pointer-events: auto` on `#gitstrip`.** Simple, uses plain `:hover`. It breaks the invariant the
  stylesheet states on purpose (`public/index.html:85`): today the board reads and pans *through* that
  column, and the only pointer target on the right edge is the `+`. An auto strip swallows drags and
  clicks over 208px of board.
- **A `pointermove` hit test on the window against the strip's rect.** Keeps the invariant, costs one
  listener and a proximity test, and the same handler can drive a short open/close delay so a pointer
  crossing the column on its way somewhere else does not flash text over the board.

Either way the repaint is free: `new ResizeObserver(() => paintGit()).observe(gitStrip)`
(`public/client/board.js:3982`) already redraws when the box changes, and the canvas re-measures text
at the new width. A fade needs more than CSS, because the text is canvas pixels: either the paint takes
a hover alpha and ramps it, or the text moves to a second canvas above the lanes.

Three consequences worth deciding before anyone writes it:

- **Hover is not a modality everyone has.** Keyboard and touch users get nothing from it. The
  accessible read is already the `aria-label` summary; keeping the text in that label, or making the
  strip focusable so `:focus-within` opens it, is the honest fix.
- **A wide strip sits over cards.** At 208px it is a margin; at 400px it is over the board, and this is
  where item 1 above bites: a semi transparent strip with no panel would put commit subjects on top of
  card text. The hovered state wants a background the resting state does not.
- **It changes this item's default.** If the graph becomes an opt-in widget, this is the state it opens
  in: graphics only, text on hover, one remembered preference for whether it is there at all.

No defaults chosen. Every item is reversible except the alpha values, which want one look in a browser
before they are kept.

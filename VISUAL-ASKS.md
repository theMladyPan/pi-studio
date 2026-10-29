# Visual asks, marked down and not built

Four requests recorded against `dev` at `99e38e9`. Nothing here is implemented. Line numbers are
from that commit in this worktree.

## 1. Clean should prune only merged branches

Answer from reading the code, not from a live sweep.

A worktree is retired only when its work is already in the branch it was cut from.
`retireWorktree` (`server.mjs:1280`) lets a tree go on this path and no other:

1. a tree still on disk must have an empty `git status --porcelain` (`server.mjs:1291`); a dirty tree
   is kept and the count of changes is reported;
2. `git rev-list --count <tree.base>..<branch>` must be readable and zero (`server.mjs:1307`). An
   unreadable count is kept, never read as zero — a comment at `server.mjs:1305` records that a
   failed `rev-list` once deleted a branch holding commits;
3. only then does `git worktree remove` run, followed by `git branch -D` (`server.mjs:1335`).

The force-delete is guarded by an ancestry test, so nothing unmerged can be swept.

Four edges worth knowing:

- **The base, not `dev`.** `tree.base` is what `baseRef(repo)` picked when the thread first worked
  (`server.mjs:1089`), normally `dev`. A branch merged into `main` but not into `dev` still has
  commits ahead of `dev` and is kept. That is the safe direction.
- **Squash and cherry-pick keep the tree.** After a squash merge the branch's commits are not
  ancestors of the base, so the count is not zero, so the tree stays and `clean` reports it as kept.
  Correct, but the sweep will look broken to anyone who squashes.
- **A detached tree is judged on its own HEAD** (`server.mjs:1310`), since it never earned a branch.
- **A branch deleted by hand** leaves the record dropped and the tree removed, with the note "the
  branch is already gone" (`server.mjs:1300`).

What the human sees comes from the `/clean` payload: removed trees and kept trees, the kept ones
spelled out in the footer (`public/board.js:4300`).

## 2. Git graph semi transparent

`#gitstrip` has no panel behind it (`public/index.html:77`); the paint sets `globalAlpha = 1` on dots
and links (`public/board.js:2662`) and on the amber ring (`2674`), with text solid at `#8b949e`.
A change would lower the alpha across `paintGit` so the board reads through the strip.

## 3. Minimap and graph as settings widgets

The two toggles disagree today.

- The map is a session toggle: `#mapBtn` in the header (`public/index.html:753`), `setMap` at
  `public/client/board.js:2381`, on at every load and stored nowhere.
- The graph is a side effect: `git-on` is set from whether the daemon sent commits
  (`public/board.js:2733`), with no key and no button.

Settling them means giving the graph the same key-and-button shape the map has, then optionally
offering both as rows in the settings dialog `#boardConfig` (`public/index.html:773`, JS at
`public/board.js:4221`) rather than as header buttons.

## 4. Git graph: graphics at rest, branches and messages on hover

As specified: the strip shows lanes and dots only. Hovering rolls it further into view, wide enough for
branch and tag pills and commit subjects; leaving hides the text again and leaves the graph.

Where it stands today the opposite way round: the strip is a fixed 208px column
(`public/index.html:78`), and it already draws up to two pills per row (`public/board.js:2682`) and a
fitted subject (`public/board.js:2684`) inside that width. So the change is two things at once: text
out of the resting state, and width in the hovered one.

Two ways to get the hover, and they are not equivalent:

- **`pointer-events: auto` on `#gitstrip`.** Simple, uses plain `:hover`. It breaks the invariant the
  stylesheet states on purpose (`public/index.html:79`): today the board reads and pans *through* that
  column, and the only pointer target on the right edge is the `+`. An auto strip swallows drags and
  clicks over 208px of board.
- **A `pointermove` hit test on the window against the strip's rect.** Keeps the invariant, costs one
  listener and a proximity test, and the same handler can drive a short open/close delay so a pointer
  crossing the column on its way somewhere else does not flash text over the board.

Either way the repaint is free: `new ResizeObserver(() => paintGit()).observe(gitStrip)`
(`public/board.js:2742`) already redraws when the box changes, and the canvas re-measures text at the
new width. A fade needs more than CSS, because the text is canvas pixels: either the paint takes a
hover alpha and ramps it, or the text moves to a second canvas above the lanes.

Three consequences worth deciding before anyone writes it:

- **Hover is not a modality everyone has.** Keyboard and touch users get nothing from it. The
  accessible read is already the `aria-label` summary (`gitLabel`, `public/board.js:2714`); keeping the
  text in that label, or making the strip focusable so `:focus-within` opens it, is the honest fix.
- **A wide strip sits over cards.** At 208px it is a margin; at 400px it is over the board, and this is
  where item 2 above bites: a semi transparent strip with no panel would put commit subjects on top of
  card text. The hovered state wants a background the resting state does not.
- **It changes item 4's default.** If the graph becomes an opt-in widget, this is the state it opens in:
  graphics only, text on hover, one remembered preference for whether it is there at all.

No defaults chosen. Every item is reversible except the alpha values, which want one look in a
browser before they are kept.

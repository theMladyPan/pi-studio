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

## 3. Minimap 75% transparent

Today the map is nearly solid on purpose: `background: rgba(13,17,23,.97)` with `blur(10px)`
(`public/index.html:68`), and the out-of-window scrim is `rgba(1,4,9,.68)` (`public/board.js:2300`).
Seventy-five per cent transparency means a background near `rgba(13,17,23,.25)`, and the scrim down
to match, or the map stays a dark box over the board.

## 4. Minimap and graph as settings widgets

The two toggles disagree today.

- The map is a remembered preference: `#mapBtn` in the header (`public/index.html:753`),
  `board.minimap` in localStorage (`public/board.js:2225`), `setMap` at `public/board.js:2385`.
- The graph is a side effect: `git-on` is set from whether the daemon sent commits
  (`public/board.js:2733`), with no key and no button.

Settling them means giving the graph the same key-and-button shape the map has, then optionally
offering both as rows in the settings dialog `#boardConfig` (`public/index.html:773`, JS at
`public/board.js:4221`) rather than as header buttons.

No defaults chosen. Every item is reversible except the alpha values, which want one look in a
browser before they are kept.

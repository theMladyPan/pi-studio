# What a board of leftovers costs

A reproduction of the doc-compliance workspace and the numbers it gives the OLD code (dev at 105dfde, a
plain checkout in `OLD`). Nothing here touches the human's repository: the repo is cloned into `REPRO`,
the boards live beside it, and every path the scripts write is under that folder.

```
REPRO=${REPRO:-/tmp/bench/repro}
OLD=${OLD:-/tmp/bench/old}

git clone --no-hardlinks ~/projekty/webygroup/doc-compliance $REPRO/doc-compliance
./reset.sh                    # branches, 15 worktrees, .venv bulks, the board file
node harness.mjs list         # the leftovers panel
node harness.mjs remove $REPRO/stateA <hex-of-steps> <hex-of-route>
node harness.mjs sweep        # retireWorktree over every tree on the board
node harness.mjs sweeproute $REPRO/stateB   # onCleanClosed, ten closed threads
node harness.mjs open         # boardFor() and the sweep it queues
node harness.mjs resync       # the snapshot a route broadcasts

ALL_BULK=1 ./reset.sh         # every folder carries the 293 MB ignored .venv
MULTI=1 ./reset.sh            # one squashed folder whose commits touch six files each
PATH=$SHIM:$PATH GITLOG=...   # counts the git programs each phase starts
```

`harness.mjs` builds the board the loader would build and then runs the routes the daemon runs. Every git
call in this code is `spawnSync`, so each probe reports the wall clock and the stall a 2 ms timer sees:
the two are the same number, which is how long the daemon is frozen.

## The reconstruction

Clone of the real repository, dev at 176d9d9 (655 commits). Twenty thread-shaped branches; fifteen
worktrees under `.agents/<8hex>` — five whose commits a fast-forward put into dev, five whose work landed
on dev as cherry-picked copies (so only the patch proof can see it), three with unmerged commits, two
belonging to threads the board still has — and five branch-only leftovers. Six folders carry a `.venv` of
15,000 files, 244 MB apparent / 293 MB on disk (the real ones are 14,866 files / 311 MB). Board file 1.10 MB
with 17 tree records and 16 threads, against the real 1.11 MB. Landing the work leaves dev at 675 commits.

## Numbers (median where repeated; machine tmpfs for `/tmp`, so deletions are a lower bound)

| what | folders | wall clock | git programs |
| --- | --- | --- | --- |
| `onFragments`, warm | 13 leftovers + 5 branch leftovers | 262–330 ms | 48 |
| `onFragments`, right after a fresh checkout | same | 906–1236 ms | 48 |
| `onFragments` after the sweep | 3 kept + 5 branch leftovers | 104–125 ms | — |
| one clear press, light folder | listing / delete / branch | 270 / 23 / 14 ms; route 525 ms | 48 + 2 + 3 |
| one clear press, 293 MB bulk folder | listing / delete / branch | 294 / 237 / 17 ms; route 804 ms | 48 + 2 + 3 |
| the snapshot that press broadcasts | — | 1,109,209 B; `resync` alone 132 ms | — |
| the board file it schedules | — | 7 ms for 1.10 MB | 0 |
| tidy-up sweep (`sweepTrees`/`retireWorktree`) | 17 records, 6 with bulk | 3,456 ms, worst folder 448 ms | 251 |
| tidy-up sweep, every folder carrying the bulk | 17 records | 4,194 ms | — |
| tidy-up sweep again on the swept board | 5 records | 574 ms | — |
| `boardFor()` + its queued sweep | 17 records | 5 ms + **3,131 / 3,622 ms** freeze | — |
| `onCleanClosed`, ten closed threads, all bulk | 10 folders | **5,068 ms** freeze | — |

Per folder in the sweep: merged (contained in dev) 11 programs; squash/cherry-pick 22 for three commits of
one file each, 52 for three commits of six files each — one plus two per changed file, as the comment on
`patchProof` says; unmerged and kept 12; a record whose folder is gone 6.

## What garbage costs

- 15,000 ignored files (`.venv`): `git status --porcelain` 3.9 ms against 3.8 ms clean. Git prunes an
  ignored directory whole, so bulk that is ignored is free.
- 15,000 untracked files in one directory: 3.7 ms, because git collapses the directory. With
  `--untracked-files=all` 18.6 ms.
- Modified **tracked** content is the expensive shape: every changed file is re-hashed. 100 MB → 290 ms,
  200 MB → 564 ms, 2000 files of 100 KB → 564 ms. About 2.7 ms per changed MB, 370 MB/s.

## Where five seconds comes from

- The listing: 3 programs and ~19 ms per leftover folder, so ~260 leftover folders, or one folder holding
  ~1.8 GB of modified tracked content.
- One clear press: one folder, so ~6.2 GB of ignored bulk to delete (237 ms per 293 MB here, tmpfs).
- The sweep: 17 records already cost 3.1–4.2 s in the reconstruction, and the real `.agents` is 4.0 GB in
  17 folders of about 320 MB each — ~4.3 s of deletion alone at the measured rate, before the proofs.

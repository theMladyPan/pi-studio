# Changelog

## [Unreleased]

## [0.5.1] - 2026-11-19

- fix: Show git tags in the graph again — a stored "disabled" no longer hides the tag pills while the tag dropdown still lists them, so picking a tag filters the graph instead of emptying it; drop the phantom uncommitted row on a clean tree and carry its change count when the tree is dirty; name the commit an annotated tag peels to in its details; honour the picked branches, authors and tags in commit search and the unreachable-commits setting in the walk, all of which were accepted and ignored — and draw the graph toolbar icons in Codicon at full brightness instead of faint text glyphs.

## [0.5.0] - 2026-11-18

- fix: Remove the right-hand git tree strip from the board, so the daemon no longer polls the repository every few seconds for a picture nobody could click. The full graph on g, source control on d and the terminal remain; an open source control drawer no longer re-reads on commits made elsewhere, it reads again on the next open.
- fix: Choose the default model on the crossroads settings page from a dropdown of the scoped models pi cycles, instead of typing it, so the list matches what the board's model picker offers.
- feat: Add a helper model setting, chosen from the same scoped list, for the model that names a thread and drafts a commit message, replacing the hardcoded naming model.
- feat: Consolidate the top bar into `view`, `housekeeping` and `toolbox` menu chips, and move the overview map toggle and the hotkeys list into board settings, so the header keeps only the doors and actions used most.

## [0.4.0] - 2026-11-18

- docs: Allow a release's back-merge into dev to be a fast-forward when main carries nothing beyond the release merge, so the history drops one empty commit per release.
- feat: Press d to open a source control drawer on the left: changed and staged files in their own lists, a file moved between them with +/−, a commit message typed by hand or drafted by the fast model that names threads, and a Commit that commits only the staged files. During a merge the drawer lists conflicted files, opens them in a merge editor that accepts the current, incoming or both sides of each hunk, stages the resolved file, and concludes the merge with Continue. Clicking a file's name shows its diff in a modal before committing, and right-clicking opens a menu: open the diff or the file, stage or unstage, discard after asking, add an untracked file to .gitignore, or reveal it in the files drawer. Publishing and pulling stay in the git graph drawer.
- fix: Answer questions in the thread by default and reserve board cards for artifacts worth revisiting or keeping visible. Cards carry useful context and meaningful titles, while modes and workflows keep routine answers and reports in the conversation.

## [0.3.0] - 2026-11-18

- feat: Press x to roll a terminal drawer up from the bottom of the board: a real shell in the workspace folder, kept alive between rolls, so a few commands can be typed without leaving the board. Ending the shell (Ctrl+D or `exit`) rolls the drawer down, and the next roll up starts a fresh shell.
- feat: Draw the git drawer with Git Graph Libre instead of the older Git Graph webview, so the rolled-down graph uses the rounded lanes, repo/branches/authors/tags filters and commit details you asked for. The drawing is borrowed from the copy already installed in your VS Code and never shipped from here, and the daemon keeps working when it is missing.

## [0.2.6] - 2026-11-18

- fix: Let a test remove its throwaway files even while a stopped daemon's children are still writing in them.
- fix: Let the publishing run name the repository on its own, so it can reach GitHub without a checkout.
- fix: Let a test wait longer for the browser on a loaded machine, while a card still keeps the shorter product budget.
- fix: Let a real release archive pass its proof step, which now reads the archive listing once instead of killing the lister with an early match.
- fix: Keep the install lifecycle tests independent of whether the checkout sits on a clean release tag, so a staged copy the tests install is always their custom copy.
- fix: Accept an annotated release tag on the publishing run by checking the remote tag, so the run no longer mistakes a real annotated tag for a plain one after the checkout step rewrites its local copy.
- fix: Keep a running thread's thinking/tool strip readable on long cards and keep its newest message in view when the board zoom changes.
- fix: Define a release workflow that maintains existing changelog entries and combines duplicate notes for the same feature or fix.
- feat: Keep an opened folder's board, its thread sessions and its Git view state inside that folder, so a project's history travels with the project and an archived or copied folder carries it. Breaking: these used to live under the machine's state folder. They are imported once, by copy, with ids, transcripts and worktree links intact, and the old files are left where they are; the records that remain global moved to the standard XDG state location, and `--state` now moves only those. Two daemons must not work on one project folder at once.
- feat: Publish a release from an annotated version tag and install or update pi-studio from it: one download puts the latest release in the current user's home, `--version`, `update` and `uninstall` manage that copy without sudo, `PATH` edits or npm, releases are compiled JavaScript so a Node that cannot read TypeScript runs them, and an uninstall keeps every board, session, prompt edit and cloned source. A published version is never replaced, the download installs only the official build of the release it names, an older release never replaces a newer installed copy, and a version whose notes are missing, undated or impossibly dated in the changelog, or still name the threads that wrote them, is refused instead of published with a placeholder.
- feat: Keep edits to the shipped prompts as overrides under the machine's state, with the default each was based on pinned beside it and a three-way report written when an update changes a prompt you have edited. Nothing is merged automatically; a thread can read the report and settle each prompt with you.

# Changelog

## [Unreleased]

## [0.2.2] - 2026-11-18

- fix: Keep the install lifecycle tests independent of whether the checkout sits on a clean release tag, so a staged copy the tests install is always their custom copy.
- fix: Accept an annotated release tag on the publishing run by checking the remote tag, so the run no longer mistakes a real annotated tag for a plain one after the checkout step rewrites its local copy.
- fix: Keep a running thread's thinking/tool strip readable on long cards and keep its newest message in view when the board zoom changes.
- fix: Define a release workflow that maintains existing changelog entries and combines duplicate notes for the same feature or fix.
- feat: Keep an opened folder's board, its thread sessions and its Git view state inside that folder, so a project's history travels with the project and an archived or copied folder carries it. Breaking: these used to live under the machine's state folder. They are imported once, by copy, with ids, transcripts and worktree links intact, and the old files are left where they are; the records that remain global moved to the standard XDG state location, and `--state` now moves only those. Two daemons must not work on one project folder at once.
- feat: Publish a release from an annotated version tag and install or update pi-studio from it: one download puts the latest release in the current user's home, `--version`, `update` and `uninstall` manage that copy without sudo, `PATH` edits or npm, releases are compiled JavaScript so a Node that cannot read TypeScript runs them, and an uninstall keeps every board, session, prompt edit and cloned source. A published version is never replaced, the download installs only the official build of the release it names, an older release never replaces a newer installed copy, and a version whose notes are missing, undated or impossibly dated in the changelog, or still name the threads that wrote them, is refused instead of published with a placeholder.
- feat: Keep edits to the shipped prompts as overrides under the machine's state, with the default each was based on pinned beside it and a three-way report written when an update changes a prompt you have edited. Nothing is merged automatically; a thread can read the report and settle each prompt with you.

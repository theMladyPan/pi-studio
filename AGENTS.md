# pi-studio

A local daemon that owns pi agents: a workspace is a folder, a thread on its board is an agent.

## Keyboard shortcuts

The `keys` button in the header lists every shortcut. That panel renders from one list, `SHORTCUTS` in
`public/client/board.js`, which is the single source of truth for it.

Any change to a shortcut handler must change that same list in the same commit, and the `map` button's
title in the same client, which names its own key (`"hide the board overview (m)"`).

## Branching and merging

- The trunk branches are `dev` and `main`. Work lands on `dev` through a merge;
  merging `dev` into `main` cuts a release.
- Never commit directly on a trunk branch. Cut a work branch from the latest `dev`, named
  `<type>/<slug>-<thread-id>`: use `feat`, `fix`, `refactor`, `docs`, `test` or `chore`,
  followed by a short description and the owning thread's 8-character id. Commit isolated changes there.
- Rebase the work branch on the latest `dev` before merging. Preserve a merge commit (`--no-ff`)
  so the branch and its thread id remain in the delivery history.
- Use `merge: <what the branch delivers>` for work merge subjects and
  `merge: dev into main for <version>` for release merge subjects.
- Merge, tag or publish only when the human asks. Otherwise, hand off the committed work branch.
- Run `npm run check` before merging: syntax, imports, types, unit and route tests, and smoke tests
  must all pass. Targeted tests during development do not replace this gate. Use `npm ci` if the
  locked development dependencies need installing.

## Versioning

- Use ZeroVer: `0.MINOR.PATCH`. The leading zero stays zero. Bump minor for new features or
  breaking changes and reset patch to zero; bump patch for fixes, documentation and maintenance.
  Call out breaking changes and any required migration in their changelog bullets.
- `package.json` is the version source. Keep the top-level version and the root package version
  in `package-lock.json` identical to it. Update a current version displayed in `README.md` only
  if one is present.
- Bump the version only when preparing the `dev` to `main` release. Ordinary work branches
  add unreleased notes; they never bump versions, create release headings or tag releases.
- Prepare the release on a work branch from the latest `dev`. Choose the next version against
  the version it carries and existing release tags. If another release has taken that number,
  choose the next free number. Versions must increase and no released number may be reused.
- Use `npm version minor --no-git-tag-version` or `npm version patch --no-git-tag-version` to
  update both package files together. If a number is already taken, use
  `npm version <version> --no-git-tag-version` with the next free version instead.
- Commit the package files and the dated changelog section together as
  `chore(release): bump version to <version>`, along with any existing README version.
- Merge the release preparation into `dev`, then merge `dev` into `main` as one release
  sequence. If `dev` changes before that release merge, refresh the notes and version as needed
  and rerun the checks against the updated release candidate.
- After the release merge, create an annotated `v0.MINOR.PATCH` tag on that `main` merge commit.
  Release artifacts use that same version. Never move a published tag or replace a published version.
  Merge `main` back into `dev` so subsequent work includes the release history.
- If a release is missing its version bump, matching lockfile, dated notes or tag, report it and
  offer a correction. Repair an already published release with a new version.

## Changelog (`CHANGELOG.md`)

- Keep the release history at the repository root, in Keep a Changelog style: `# Changelog`,
  then `## [Unreleased]`, then `## [0.MINOR.PATCH] - YYYY-MM-DD` sections, newest first.
- Every change merged into `dev` must be covered by an unreleased bullet. Use `- feat: ...` for
  a new capability or `- fix: ...` for a correction, including documentation or maintenance.
  Say what changed and why the reader cares in one or two sentences. Avoid file paths, commit
  hashes and vague claims.
- Read `[Unreleased]` before editing. Maintain an existing bullet when continuing the same
  feature or fix; update its wording as the work evolves. If it already covers the change, leave
  it as is. Add a new bullet only for a distinct feature or fix, never just for another commit,
  thread or merge.
- Deduplicate overlapping unreleased bullets whenever possible. Combine entries for the same
  feature or fix while preserving distinct behavior, breaking changes and migration guidance.
  Keep unrelated changes separate. Workers may update matching entries from other threads;
  never edit released sections during ordinary work.
- End new bullets with the contributing branch's thread id, for example `[t-c70e4c65]`.
  When updating or combining entries, preserve existing thread watermarks and add your own once
  if you contribute to the change.
- The thread handling the merge checks that all changes are covered, consolidates duplicates
  and unifies their wording. Work merged to `dev` stays unreleased until the release preparation
  above.
- During release preparation, move all unreleased bullets into the new dated version section
  and remove every `[t-...]` watermark from those bullets. Leave an empty `[Unreleased]` section
  at the top. Release preparation does not need a changelog bullet about itself.
- Released notes describe the changes, never their authors or threads. Ownership stays in git:
  the merge records the branch, and the branch carries the thread id. Read `git log --merges`.

### Parallel threads

- Recheck the latest unreleased entries before merging. Update a matching bullet first; append
  below the last unreleased bullet only when the feature or fix is new. Preserve unrelated entries
  and all contributing thread watermarks when maintaining or deduplicating shared notes.
- On a changelog conflict, retain every distinct change and all released history. Combine
  duplicate unreleased notes using the rules above. Never take one side of the file wholesale.
- Recheck the version and release tags at release time. If `dev` has already released the work
  your bullet would describe, do not add a duplicate entry.

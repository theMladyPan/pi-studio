# Releasing pi-studio

The rules live in the Versioning and Changelog sections of `AGENTS.md`. This is
the ordered, human copy-paste procedure built from them. Nothing is published
from a branch: pushing an annotated version tag to GitHub is what publishes.

## The procedure

1. Cut a release branch from the latest `dev`:
   `git checkout dev && git checkout -b chore/release-<version>-<thread-id>`

2. Bump the version in both package files together, without creating a tag:
   `npm version minor --no-git-tag-version` for a feature or breaking release,
   `npm version patch --no-git-tag-version` for a fix-only release. If the number
   is already taken by a released version, use the next free one with
   `npm version <version> --no-git-tag-version`.

3. In `CHANGELOG.md`, move every `[Unreleased]` bullet under a new section
   directly below it: `## [<version>] - YYYY-MM-DD`, dated with the real release
   date. Remove every `[t-...]` thread watermark from those bullets and leave
   `[Unreleased]` empty. A missing, undated or impossible date, an empty section
   or a leftover watermark makes the release run refuse instead of publishing.

4. Run the full gate: `npm run check -- --full`. It must pass end to end before any merge.

5. Commit only the release files (the two package files, the changelog, and any
   README version display if there is one):
   `git commit -m "chore(release): bump version to <version>"`

6. Merge the branch into `dev` with a merge commit, preserving the branch:
   `git checkout dev && git merge --no-ff chore/release-<version>-<thread-id> -m "merge: <what the branch delivers>"`
   If `dev` moved since the bump, refresh the notes and version and rerun the
   checks against the updated candidate.

7. Merge `dev` into `main` as one release sequence:
   `git checkout main && git merge --no-ff dev -m "merge: dev into main for <version>"`

8. Create an annotated tag on that `main` merge commit. A lightweight tag is
   refused: `git tag -a v<version> -m "v<version>"`

9. Push `main` first, then push the tag. The tag push starts the Release
   workflow, which re-verifies the tag against the package files and the lockfile,
   runs the full checks, builds the assets, and publishes them as a draft GitHub
   Release before making it the latest. A published release is never replaced;
   repair a bad one with a new version:
   `git push origin main && git push origin v<version>`

10. Merge `main` back into `dev` so subsequent work includes the release history,
    and push it: `git checkout dev && git merge --no-ff main && git push origin dev`
    If `main` carries nothing beyond the release merge, carrying it back may be a
    fast-forward instead of a merge commit.

## What to watch

After step 9, watch the Actions run named Release: the verify job must go green
and the publish job must actually run. The release page must show the version as
latest with the tarball, its checksum file and the installer script attached.
Until that run finishes, the public install address answers "not found".

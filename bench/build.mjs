import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, cpSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPRO = process.env.REPRO ?? "/tmp/bench/repro";
const REPO = `${REPRO}/doc-compliance`;
const BULK = `${REPRO}/bulk-template`;
const RUN = Date.now().toString(36).slice(-4);
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
/** A git run with its own committer identity, so a cherry-picked copy never hashes to the commit it copies. */
const gitDated = (cwd, ...args) =>
	execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_NAME: "copier", GIT_COMMITTER_EMAIL: "copier@example.invalid" } }).trim();

// --- the bulk template: a `.venv` of 15,000 files, ~250 MB apparent (the real one is 14,866 files / 311 MB) ---
if (!existsSync(BULK)) {
  mkdirSync(BULK, { recursive: true });
  const blob = Buffer.alloc(17000, 0x78);
  for (let d = 0; d < 150; d++) {
    const dir = join(BULK, `pkg${String(d).padStart(3, "0")}`);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 100; f++) writeFileSync(join(dir, `m${String(f).padStart(3, "0")}.py`), blob);
  }
}
const bulkFiles = execFileSync("bash", ["-lc", `find ${BULK} -type f | wc -l`], { encoding: "utf8" }).trim();

// --- the shape -----------------------------------------------------------------------------------------
// 15 folders: 13 leftovers (thread no longer on the board) and 2 whose thread is on the board.
const FOLDERS = [
  { hex: "a1a1a1a1", kind: "merged", bulk: true,  slug: "merged-one",   type: "feat" },
  { hex: "a2a2a2a2", kind: "merged", bulk: true,  slug: "merged-two",   type: "fix" },
  { hex: "a3a3a3a3", kind: "merged", bulk: false, slug: "merged-three", type: "docs" },
  { hex: "a4a4a4a4", kind: "merged", bulk: false, slug: "merged-four",  type: "chore" },
  { hex: "a5a5a5a5", kind: "merged", bulk: false, slug: "merged-five",  type: "test" },
  { hex: "b1b1b1b1", kind: "squash", bulk: true,  slug: "squashed-one", type: "feat" },
  { hex: "b2b2b2b2", kind: "squash", bulk: true,  slug: "squashed-two", type: "fix" },
  { hex: "b3b3b3b3", kind: "squash", bulk: true,  slug: "squashed-three", type: "docs" },
  { hex: "b4b4b4b4", kind: "squash", bulk: false, slug: "squashed-four", type: "chore" },
  { hex: "b5b5b5b5", kind: "squash", bulk: false, slug: "squashed-five", type: "test" },
  { hex: "c1c1c1c1", kind: "unmerged", bulk: true,  slug: "unmerged-one", type: "fix" },
  { hex: "c2c2c2c2", kind: "unmerged", bulk: false, slug: "unmerged-two", type: "feat" },
  { hex: "c3c3c3c3", kind: "unmerged", bulk: false, slug: "unmerged-three", type: "docs" },
  { hex: "d1d1d1d1", kind: "live", bulk: false, slug: "live-one", type: "feat" },
  { hex: "d2d2d2d2", kind: "live", bulk: false, slug: "live-two", type: "fix" },
];
const ORPHAN_BRANCHES = ["e1e1e1e1", "e2e2e2e2", "e3e3e3e3", "e4e4e4e4", "e5e5e5e5"].map((hex, i) => ({
  hex, kind: "branchonly", slug: `orphan-${i + 1}`, type: "feat",
}));

const branchOf = (f) => `${f.type}/${f.slug}-${f.hex}`;
const treePath = (f) => join(REPO, ".agents", f.hex);

function reset() {
  // Drop every worktree under .agents but keep the clone, its branches and dev.
  for (const entry of git(REPO, "worktree", "list", "--porcelain").split("\n")) {
    if (entry.startsWith("worktree ") && entry.includes("/.agents/")) {
      git(REPO, "worktree", "remove", "--force", entry.slice(9));
    }
  }
  rmSync(join(REPO, ".agents"), { recursive: true, force: true });
  for (const line of git(REPO, "for-each-ref", "refs/heads", "--format=%(refname:short)").split("\n")) {
    if (/\/(?:[a-z0-9-]+)-[0-9a-f]{8}$/.test(line)) git(REPO, "branch", "-D", line);
  }
  git(REPO, "checkout", "-q", "dev");
  git(REPO, "reset", "-q", "--hard", "origin/dev");
}

function build() {
  mkdirSync(join(REPO, ".agents"), { recursive: true });
  let n = 0;
  for (const f of [...FOLDERS, ...ORPHAN_BRANCHES]) {
    const branch = branchOf(f);
    n += 1;
    if (f.kind === "branchonly") {
      git(REPO, "branch", branch, "dev");
      for (let i = 1; i <= 2; i++) {
        const wt = join(REPO, ".agents", `.tmp-${f.hex}-${i}`);
        git(REPO, "worktree", "add", "-q", wt, branch);
        writeFileSync(join(wt, `${f.slug}-${RUN}-${i}.txt`), `${f.slug} line ${i}\n`);
        git(wt, "add", "-A");
        git(wt, "commit", "-qm", `${f.slug} step ${i}`);
        git(REPO, "worktree", "remove", "--force", wt);
      }
      continue;
    }
    git(REPO, "worktree", "add", "-q", treePath(f), "-b", branch, "dev");
    const commits = f.kind === "squash" ? 3 : 1;
    // One folder is given commits that touch six files each, which is the shape the patch proof pays per file for.
    const filesPerCommit = process.env.MULTI === "1" && f.hex === "b3b3b3b3" ? 6 : 1;
    for (let i = 1; i <= commits; i++) {
      for (let k = 0; k < filesPerCommit; k++)
        writeFileSync(join(treePath(f), `${f.slug}-${RUN}-${i}-${k}.txt`), `${f.slug} line ${i} file ${k}\n`);
      git(treePath(f), "add", "-A");
      git(treePath(f), "commit", "-qm", `${f.slug} step ${i}`);
    }
    if (f.kind === "merged") {
      // A fast-forward: dev ends up holding the very commits the tree stands on.
      git(REPO, "merge", "-q", "--ff-only", branch);
    } else if (f.kind === "squash") {
      // The same work lands on dev as new commits, so no local branch contains the tree's commits.
      const ids = git(treePath(f), "rev-list", "--reverse", `dev..${branch}`).split("\n").filter(Boolean);
      gitDated(REPO, "cherry-pick", ...ids);
    }
    if (f.bulk || process.env.ALL_BULK === "1") cpSync(BULK, join(treePath(f), ".venv"), { recursive: true });
  }
  // A stale record: the folder was deleted by hand, the registration is gone, the branch is still there.
  git(REPO, "branch", "chore/stale-record-ffff1111", "dev");
}

reset();
build();
const info = {
  repo: REPO,
  head: git(REPO, "rev-parse", "--short", "HEAD"),
  devCommits: Number(git(REPO, "rev-list", "--count", "dev")),
  branches: git(REPO, "for-each-ref", "refs/heads", "--format=%(refname:short)").split("\n").filter(Boolean).length,
  registrations: git(REPO, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length,
  bulkFiles,
};
console.log(JSON.stringify(info, null, 1));

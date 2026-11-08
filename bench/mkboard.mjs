import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPRO = process.env.REPRO ?? "/tmp/bench/repro";
const REPO = `${REPRO}/doc-compliance`;
const id = createHash("sha256").update(REPO).digest("hex").slice(0, 12);
const hexOf = (h) => `${h}-0000-4000-8000-${h}${h}`;

const LEFTOVERS = [
  ["a1a1a1a1", "feat/merged-one-a1a1a1a1"],
  ["a2a2a2a2", "fix/merged-two-a2a2a2a2"],
  ["a3a3a3a3", "docs/merged-three-a3a3a3a3"],
  ["a4a4a4a4", "chore/merged-four-a4a4a4a4"],
  ["a5a5a5a5", "test/merged-five-a5a5a5a5"],
  ["b1b1b1b1", "feat/squashed-one-b1b1b1b1"],
  ["b2b2b2b2", "fix/squashed-two-b2b2b2b2"],
  ["b3b3b3b3", "docs/squashed-three-b3b3b3b3"],
  ["b4b4b4b4", "chore/squashed-four-b4b4b4b4"],
  ["b5b5b5b5", "test/squashed-five-b5b5b5b5"],
  ["c1c1c1c1", "fix/unmerged-one-c1c1c1c1"],
  ["c2c2c2c2", "feat/unmerged-two-c2c2c2c2"],
  ["c3c3c3c3", "docs/unmerged-three-c3c3c3c3"],
];
const LIVE = [
  ["d1d1d1d1", "feat/live-one-d1d1d1d1"],
  ["d2d2d2d2", "fix/live-two-d2d2d2d2"],
];

const treeRecord = ([hex, branch]) => ({
  path: join(REPO, ".agents", hex),
  base: "dev",
  repo: REPO,
  ignored: true,
  thread: hexOf(hex),
  title: "",
  at: 1793972204607,
  branch,
});

/** A turn big enough that a board of sixteen of them weighs what the real one does (1.4 MB on disk). */
function paddingTurns(n, per) {
  const turns = [];
  for (let i = 0; i < n; i++) {
    turns.push({
      text: `question ${i} ${"q".repeat(per)}`,
      status: "answered",
      at: 1793972204607 + i * 1000,
      reply: `answer ${i} ${"a".repeat(per * 14)}`,
    });
  }
  return turns;
}

function board(stateDir, shape) {
  const trees = [...LEFTOVERS.map(treeRecord), ...LIVE.map(treeRecord)];
  // Two records whose folder was deleted by hand: one whose branch still exists, one whose branch is gone.
  trees.push({ path: join(REPO, ".agents", "ffff1111"), base: "dev", repo: REPO, ignored: true, thread: hexOf("ffff1111"), title: "", at: 1793972204607, branch: "chore/stale-record-ffff1111" });
  trees.push({ path: join(REPO, ".agents", "ffff2222"), base: "dev", repo: REPO, ignored: true, thread: hexOf("ffff2222"), title: "", at: 1793972204607, branch: "chore/stale-gone-ffff2222" });

  const threads = [];
  const liveTree = (hex) => trees.find((t) => t.path.endsWith(hex));
  for (const [hex, branch] of LIVE) {
    threads.push({
      id: hexOf(hex), title: `a live thread ${hex}`, sessionId: `sess-${hex}`, provider: "x", model: "y",
      at: 1793972204607, turns: paddingTurns(3, 900), worktree: liveTree(hex),
    });
  }
  if (shape === "closed") {
    // Ten threads the human put away, each still holding its folder: what `onCleanClosed` walks.
    for (const [hex, branch] of LEFTOVERS.slice(0, 10)) {
      threads.push({
        id: hexOf(hex), title: `a closed thread ${hex}`, sessionId: `sess-${hex}`, provider: "x", model: "y",
        at: 1793972204607, turns: paddingTurns(1, 300), hidden: true, closedAt: 1794060000000,
        worktree: trees.find((t) => t.path.endsWith(hex)),
      });
    }
  } else {
    // Padding only: threads with no tree, so the board file and its snapshot weigh what the real one does.
    for (let i = 0; i < 14; i++) {
      const hex = `aa${String(i).padStart(6, "0")}`;
      threads.push({
        id: hexOf(hex), title: `padding thread ${i}`, sessionId: `sess-${hex}`, provider: "x", model: "y",
        at: 1793972204607 + i, turns: paddingTurns(2, 1800),
      });
    }
  }
  const cards = threads.slice(0, 16).map((t, i) => ({
    id: `card-${i}`, type: "note", title: t.title, at: 1793972204607, markdown: `# ${t.title}\n\n${"c".repeat(9000)}`,
    updatedAt: 1793972204607, rect: { x: 10 * i, y: 10 * i, w: 320, h: 240 }, ownerThread: t.id,
  }));
  const activity = Array.from({ length: 256 }, (_, i) => ({
    id: `row-${i}`, thread: { id: threads[i % threads.length].id, title: threads[i % threads.length].title },
    status: "done", at: 1793972204607 + i, text: `row ${i} ${"r".repeat(200)}`,
  }));
  const file = {
    version: 1,
    workspace: { id, folder: REPO, name: "repro" },
    savedAt: 1794060000000,
    activity,
    config: { provider: "x", model: "y" },
    trees,
    threads,
    cards,
  };
  mkdirSync(join(stateDir, "boards"), { recursive: true });
  writeFileSync(join(stateDir, "boards", `${id}.json`), JSON.stringify(file, null, 1));
  writeFileSync(join(stateDir, "workspaces.json"), JSON.stringify({
    version: 1,
    workspaces: [{ id, folder: REPO, name: "repro", openedAt: 1794060000000 }],
    defaults: {},
  }));
  return { id, threads: threads.length, trees: trees.length, cards: cards.length };
}

const a = board(`${REPRO}/stateA`, "leftovers");
const b = board(`${REPRO}/stateB`, "closed");
console.log(JSON.stringify({ a, b, id }, null, 1));

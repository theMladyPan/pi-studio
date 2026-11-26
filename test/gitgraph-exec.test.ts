import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gitText, runGit } from "../server/git/exec.ts";
import { snapshot } from "../server/logs.ts";
import { scratchRepo } from "../test-support/git.ts";

test("a read answers what git said, in the folder it was asked about", async () => {
	const repo = scratchRepo();
	try {
		const top = await gitText(repo, ["rev-parse", "--show-toplevel"]);
		assert.equal(top.ok, true, top.stderr);
		assert.equal(realpathSync(top.text.trim()), realpathSync(repo));
		const line = snapshot().find((entry) => entry.source === "git" && entry.message === "git rev-parse --show-toplevel");
		assert.equal(realpathSync(String(line?.output)), realpathSync(repo), "the expanded view carries git's answer, not the command again");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a command that fails answers so, without throwing", async () => {
	const repo = scratchRepo();
	try {
		const missing = await runGit(repo, ["rev-parse", "--verify", "--quiet", "refs/heads/no-such-branch"], { kind: "read" });
		assert.equal(missing.ok, false);
		assert.equal(missing.code, 1);
		assert.equal(missing.timedOut, false);
		assert.equal(missing.truncated, false);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("the environment is the one a daemon can run git in", async () => {
	// A git that waits for a password holds the daemon forever, and one that turns on optional locks
	// makes a read something a write has to wait for. Both are pinned here, and the print is what
	// proves it rather than the code that sets them.
	const repo = scratchRepo();
	const print = ["-c", "alias.env=!sh -c 'echo $GIT_TERMINAL_PROMPT $GIT_PAGER $SSH_ASKPASS_REQUIRE $GIT_OPTIONAL_LOCKS'", "env"];
	try {
		const read = await gitText(repo, print);
		assert.equal(read.ok, true, read.stderr);
		assert.equal(read.text.trim(), "0 cat never 0");
		// A write must not carry the read-only switch: git has to be allowed to take its locks.
		const write = await gitText(repo, ["-c", "alias.env2=!sh -c 'echo $GIT_TERMINAL_PROMPT $GIT_PAGER $SSH_ASKPASS_REQUIRE $GIT_OPTIONAL_LOCKS'", "env2"], { kind: "write" });
		assert.equal(write.ok, true, write.stderr);
		assert.equal(write.text.trim(), "0 cat never");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a command's own variables are merged over the inherited ones", async () => {
	const repo = scratchRepo();
	try {
		const out = await gitText(
			repo,
			["-c", "alias.env=!sh -c 'echo $GIT_PAGER $PI_STUDIO_EXEC_TEST'", "env"],
			{ env: { GIT_PAGER: "less", PI_STUDIO_EXEC_TEST: "yes" } },
		);
		assert.equal(out.ok, true, out.stderr);
		assert.equal(out.text.trim(), "less yes");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a command that hangs is killed and reported as timed out", async () => {
	const repo = scratchRepo();
	try {
		const started = Date.now();
		const slow = await runGit(repo, ["-c", "alias.slow=!sleep 5", "slow"], { kind: "read", timeoutMs: 150 });
		const took = Date.now() - started;
		assert.equal(slow.timedOut, true);
		assert.equal(slow.ok, false);
		assert.ok(took < 2_000, `the kill took ${took} ms, so the child was not killed`);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("an aborted command is killed the same way a timed out one is", async () => {
	const repo = scratchRepo();
	try {
		const controller = new AbortController();
		const running = runGit(repo, ["-c", "alias.slow=!sleep 5", "slow"], { kind: "read", signal: controller.signal });
		controller.abort();
		const aborted = await running;
		assert.equal(aborted.timedOut, true);
		assert.equal(aborted.ok, false);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("output past the budget is cut, and the run is not trusted", async () => {
	const repo = scratchRepo();
	try {
		const big = await runGit(repo, ["-c", "alias.big=!seq 1 200000", "big"], { kind: "read", maxBytes: 1024 });
		assert.equal(big.truncated, true);
		assert.equal(big.ok, false);
		assert.equal(big.stdout.length, 1024, "exactly the first maxBytes bytes are kept");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("a folder that is gone answers with the reason instead of throwing", async () => {
	const gone = join(tmpdir(), `pi-studio-exec-gone-${process.pid}-${Date.now()}`);
	const result = await runGit(gone, ["status"], { kind: "read" });
	assert.equal(result.ok, false);
	assert.ok(result.stderr.length > 0, "the child's error should be the reason");
});

test("a repository with no commits yet still answers its own reads", async () => {
	const empty = mkdtempSync(join(tmpdir(), "pi-studio-exec-empty-"));
	try {
		const gitIn = await runGit(empty, ["init", "-q"], { kind: "write" });
		assert.equal(gitIn.ok, true, gitIn.stderr);
		const head = await runGit(empty, ["symbolic-ref", "--short", "HEAD"], { kind: "read" });
		assert.equal(head.ok, true, head.stderr);
		assert.ok(head.stdout.toString("utf8").trim().length > 0, "a fresh repository is still on a branch");
	} finally {
		rmSync(empty, { recursive: true, force: true });
	}
});

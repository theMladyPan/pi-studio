// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * What git is being asked about: the repository a thread's worktree came from, the worktree itself,
 * and the ref a branch is cut from. Read only, so every function here is safe to call twice.
 */
import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";



/** One git command, short enough to wait for while a message is being sent. */
export function gitIn(folder, args, timeout = 5000) {
	try {
		const out = spawnSync("git", ["-C", folder, ...args], { encoding: "utf8", timeout });
		return { ok: out.status === 0, out: (out.stdout ?? "").trim(), err: (out.stderr ?? "").trim() };
	} catch (error) {
		return { ok: false, out: "", err: error.message };
	}
}



/**
 * One git command, waited for without holding the event loop. A read that asks git a dozen questions must
 * not make every other tab, agent and poll wait for a dozen processes it never asked for, so the reads that
 * add up — the leftovers scan, the facts a folder's row is drawn from — come through here.
 */
export function gitSoon(folder, args, timeout = 5000) {
	return new Promise<{ ok: boolean; out: string; err: string }>((done) => {
		execFile(
			"git",
			["-C", folder, ...args],
			{ encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024 },
			(error, stdout, stderr) => {
				const err = String(stderr ?? "").trim() || (error ? error.message : "");
				done({ ok: !error, out: String(stdout ?? "").trim(), err });
			},
		);
	});
}



/** The same question as `repoOf`, asked without holding the event loop. */
export async function repoOfSoon(folder) {
	if (!folder || !existsSync(folder)) return "";
	const found = await gitSoon(folder, ["rev-parse", "--show-toplevel"]);
	return found.ok && found.out ? found.out : "";
}



/** The same answer as `baseRef`, asked without holding the event loop. */
export async function baseRefSoon(repo) {
	if ((await gitSoon(repo, ["rev-parse", "--verify", "--quiet", "refs/heads/dev"])).ok) return "dev";
	const head = await gitSoon(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
	return head.ok && head.out && head.out !== "HEAD" ? head.out : "";
}



/** The repository a folder belongs to; empty when it is not one. */
export function repoOf(folder) {
	if (!folder || !existsSync(folder)) return "";
	const found = gitIn(folder, ["rev-parse", "--show-toplevel"]);
	return found.ok && found.out ? found.out : "";
}



/** What a new branch is cut from: `dev` when the repository has one, else the branch checked out. */
export function baseRef(repo) {
	if (gitIn(repo, ["rev-parse", "--verify", "--quiet", "refs/heads/dev"]).ok) return "dev";
	const head = gitIn(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
	return head.ok && head.out && head.out !== "HEAD" ? head.out : "";
}



/**
 * The main checkout a linked worktree belongs to: `git rev-parse --show-toplevel` inside a worktree
 * answers with the tree itself, so removal and branch deletion have to be run from the other one.
 */
export function mainRepoOf(path) {
	if (!path || !existsSync(path)) return "";
	const common = gitIn(path, ["rev-parse", "--git-common-dir"]);
	if (!common.ok || !common.out) return "";
	return dirname(resolve(path, common.out));
}

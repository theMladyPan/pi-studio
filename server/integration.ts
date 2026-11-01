/**
 * The one thing a board says about how the work a child does comes back onto the board's own branch: one
 * of three git strategies, `merge` unless a human chose otherwise.
 *
 * This module is the only place the ids are written down. A board file may hold anything; what reaches a
 * prompt or a git command is one of these ids or the default.
 */



/** How a child's branch is brought back onto the branch the boss works on. */
export const CHILD_INTEGRATION: readonly string[] = ["merge", "cherry-pick", "rebase"];



/** What a board holds before anybody chooses, and what an older board file is read as. */
export const INTEGRATION_DEFAULT = "merge";



/**
 * The git command that carries each one out, in the words a thread reads. `merge` keeps the branch it
 * took from visible in the history, which is why a merge commit is the default.
 */
export const INTEGRATION_COMMAND: Record<string, string> = {
	merge: "git merge --no-ff <branch>",
	"cherry-pick": "git cherry-pick <sha>…",
	rebase: "git rebase <branch>",
};



/**
 * The strategy a board holds. Something nobody recognises is not a choice, so it reads as the default:
 * a board file written before this setting existed is a `merge` board.
 */
export function integrationOf(config: unknown): string {
	const chosen = (config ?? {}) as { childIntegration?: unknown };
	return typeof chosen.childIntegration === "string" && CHILD_INTEGRATION.includes(chosen.childIntegration)
		? chosen.childIntegration
		: INTEGRATION_DEFAULT;
}

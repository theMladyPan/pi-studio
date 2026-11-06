// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * The words a thread is started with. They are the lines most likely to be edited, so they live apart
 * from the process that sends them.
 */
import { AGENTS_DIR, shortId, workdirOf } from "../worktrees/make.ts";
import { cardsBlock } from "../card-settings.ts";
import { INTEGRATION_COMMAND, integrationOf } from "../integration.ts";
import { promptText } from "./modes.ts";
import { STUDIO_FILE, workspacePromptText } from "../workspace-prompt.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";



/**
 * What a thread is told about the folder it works in. The board makes the tree before the child is
 * spawned, so this is a fact to report, not an instruction to obey: `2e6c8db` asked the child to run
 * `git worktree add` itself, and a rule a model may skip is a rule that half the time is skipped.
 *
 * The tree starts detached, so the branch is the one thing here the child does create. It is told to
 * cut it before its first edit and to name it after the work it turned out to be, because a name
 * decided from the request describes the question rather than the answer.
 */
export function worktreePrompt(board, thread) {
	const tree = thread.worktree;
	const short = shortId(thread);
	const lines = [];
	if (tree?.path) {
		lines.push(
			`Other threads may be working in ${board.folder} at the same time. The board gives each thread its own git worktree, so a change of yours cannot collide with one of theirs.`,
			`Your worktree is ${tree.path}, detached on ${tree.base}: no branch has been cut yet, and nothing is committed there. Read and analyze in it as long as you like without one.`,
			`Before your first edit, cut your own branch with \`git checkout -b <type>/<slug>-${short}\`: <type> is fix, feat, refactor, docs, test or chore, and <slug> says what the work turned out to be, in kebab-case. Commit there. A request that only asks a question leaves the tree detached and writes no branch.`,
			`That tree is yours alone. Stay on your branch while you edit and commit: it is your playground, and the human reads it as your work. You may check out ${tree.base} or another branch to read and compare, as long as nothing is left uncommitted when you switch back.`,
			`If the work turns out to be something other than the branch name says, rename it with \`git branch -m <type>/<slug>-${short}\` and report the new name.`,
			`If files changed, name the branch and the path in one clause; nothing more. Nobody merges for you: cutting a branch and merging one are the human's decisions.`,
			// The tree is a playground that goes away: a child that leaves work uncommitted has done work
			// nobody can read back, so the rule is said here, next to the tree it is about.
			`When this thread is retired its worktree is wiped clean, so anything left uncommitted in it is lost: commit what you want to keep before your last message, and never leave work in that tree as an uncommitted change.`,
		);
		if (!existsSync(tree.path)) {
			lines.push(
				`That tree is no longer on disk, so work in ${board.folder} and say so when you report.`,
			);
		}
		if (tree.ignored === false) {
			lines.push(
				`\`.agents/\` is not in that repository's .gitignore, so the tree shows up as an untracked folder in the main checkout. Say so when you report; do not edit .gitignore unless the job asks for it.`,
			);
		}
	} else {
		lines.push(
			`No worktree was made: ${tree?.skipped ?? "the board has none for this thread"}. Work in ${board.folder} itself, where there is no branch to cut and no separate tree: edit the files in place, and say so when you report.`,
		);
	}
	lines.push(
		"Examples of right and wrong:",
		`- right: the job is to rewrite the parser in a repository: read first, cut \`feat/rewrite-the-parser-${short}\`, edit files under ${tree?.path ?? `${board.folder}/${AGENTS_DIR}/<your tree>`}, commit there, and stop.`,
		`- right: "how does the router pick a board?" is answered with reads on the detached tree, which stays detached and holds no branch.`,
		`- wrong: cutting a branch named after the request before you have read anything, or editing parser.ts in ${board.folder} itself, or merging your branch into ${tree?.base ?? "the base branch"}, because another thread may have the same files open.`,
	);
	return lines.join("\n");
}



/**
 * Said when `prompts/board/conventions.md` is gone. Short on purpose: the advice is the file's job, and a
 * second copy here is the copy a human's edit would not reach.
 */
const NO_CONVENTIONS =
	"The board's conventions file is missing (prompts/board/conventions.md), so nothing here says how a card is written: put the work on cards anyway, give each one a key, and say in the chat what you put there.";



/**
 * The thread's own card, and the board around it, said plainly enough that an agent uses it.
 *
 * The board is the product, and the chat is only the wire under it: when the work is on a card the answer
 * is a pointer to it, so a thread that writes its findings in prose has done the work where nobody reads
 * it. When nothing is on a card the answer itself belongs in the chat, which is what keeps a quiet board
 * usable: a prompt that made every sentence a card is why cards were never asked for.
 *
 * A spawned child is told none of this. It draws nothing — the bridge is not loaded for it and every card
 * route refuses it — so the instruction and the tools agree, and `childPrompt` is what it gets.
 *
 * What stays here is the fact of where the thread works and the two mechanics the board enforces: a
 * `[[key]]` resolves to the card whose key is that same string, and the card rules are the last thing a
 * thread reads. The taste — pointer style, one kind of thing per card, mermaid before svg — is
 * `prompts/board/conventions.md`, because a human may want it in their own words.
 *
 * A workspace adds one file of its own to that, `STUDIO.md` in its folder: the studio's own instructions
 * for that project, which pi does not read on its own account. It is read here rather than kept, so an
 * edit lands on the next run of a thread already on the board. A spawned child is given its own frame
 * instead and reads none of it.
 */
export function boardPrompt(board, thread) {
	if (thread.parentThread) return childPrompt(board, thread);
	const workdir = workdirOf(board, thread);
	const integration = integrationOf(board.config);
	return [
		`You are thread "${thread.title}" on a board, working in the folder ${workdir}.`,
		`The workspace this board opened is ${board.folder}, which is where the rest of the board reads files from.`,
		"The human reads cards on that board, not a chat log or a terminal.",
		// A board whose conventions file was deleted still has every mechanic below, so it still gets told
		// what to do with a card rather than being left with the identity lines and nothing else.
		promptText("board", "conventions") || NO_CONVENTIONS,
		// The workspace's own words to the studio, from the folder rather than from a value on the board.
		workspacePromptText(board, STUDIO_FILE),
		"A [[key]] only works if the card carries that exact key, so pass a short key to board_note every time and name the card by it.",
		"Once the children you spawned are merged or otherwise brought in, board_collect frees their worktrees and branches.",
		"How many cards this thread writes, and what may be inside one, is set at the end of this prompt.",
		worktreePrompt(board, thread),
		// How a branch a child cut comes back onto this board's own branch: one strategy and the git command
		// that carries it out, so the boss reads the rule rather than three it has to choose between.
		`The board brings a child's work back with: ${integration} — ${INTEGRATION_COMMAND[integration]}.`,
		cardsBlock(board.config),
	].filter(Boolean).join("\n");
}



/**
 * What a spawned child is told on the same board. It draws nothing: the bridge is not loaded for it and
 * every card route refuses it, so the report in its last message is the whole of what the thread that
 * spawned it reads. That thread decides which card the finding is worth.
 */
export function childPrompt(board, thread) {
	const workdir = workdirOf(board, thread);
	return [
		`You are thread "${thread.title}" on a board, working in the folder ${workdir}.`,
		`The workspace this board opened is ${board.folder}, which is where the rest of the board reads files from.`,
		"You draw nothing on that board: no note, no source card, no question to the human. The thread that spawned you reads your last message and writes the cards, so that message is the whole report.",
		"Say what you found, where it is, what you changed, and what you would do next, in short prose or bullets, with paths and line numbers where they matter. Quote the exact text when the exact text is the finding.",
		worktreePrompt(board, thread),
	].join("\n");
}

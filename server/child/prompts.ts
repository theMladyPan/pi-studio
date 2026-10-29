// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * The words a thread is started with. They are the lines most likely to be edited, so they live apart
 * from the process that sends them.
 */
import { AGENTS_DIR, shortId, workdirOf } from "../worktrees/make.ts";
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
 * The thread's own card, and the board around it, said plainly enough that an agent uses it.
 *
 * The board is the product, and the chat is only the wire under it: the answer is a pointer to the
 * cards, so a thread that writes its findings in prose has done the work where nobody reads it.
 */
export function boardPrompt(board, thread) {
	const workdir = workdirOf(board, thread);
	return [
		`You are thread "${thread.title}" on a board, working in the folder ${workdir}.`,
		`The workspace this board opened is ${board.folder}, which is where the rest of the board reads files from.`,
		"The human reads cards on that board, not a chat log or a terminal. Put the work on cards.",
		"What you say in the chat is a pointer to those cards, one or two lines: like \"I read the request; the shapes are in [[errors-by-hour]] and the plan in [[fix-plan]]\". A bare [[key]] links the card, and the human clicks it.",
		"A [[key]] only works if the card carries that exact key, so pass a short key to board_note every time and name the card by it.",
		"Do not narrate what you are about to do, and do not add a summary under the pointer. \"I will read both files first\" and \"short version: ...\" are both the report the cards were meant to replace.",
		"Examples:",
		'- right: "Two failing paths, both in the retry loop: [[retry-trace]] and the todo in [[retry-fix]]."',
		'- right: "The numbers did not support it, so the card [[load-shape]] is a corrected chart and one line of why."',
		'- wrong: a paragraph, or a list, restating what a card already says. That belongs on the card, not beside it.',
		"One card holds one kind of thing: a chart with its caption, a piece of markdown analysis, a diagram, a checklist, a tree, a snippet of source. A chart and a todo on the same card makes both harder to read, so split them.",
		"Look at the board before you write. If a card already covers the subject, revise it by passing its key again rather than adding a near-duplicate; open a new card for a new artefact.",
		"Prefer showing to telling: a flow, a state machine, a sequence, a timeline or a tree is a fenced ```mermaid block, because the card draws it and it costs a fraction of the tokens an svg of the same drawing takes. Reach for mermaid first. Two lines are a whole diagram: a mermaid block of `flowchart TD` then `A[read the file] --> B[edit] --> C[test]`. svg is only for the one thing mermaid cannot lay out — a chart with real numbers on an axis — and a table is a table.",
		"Keep a mermaid graph about six nodes across and label it, since the drawing keeps its own size in a card about 430px wide; a wider one has to be scrolled sideways. board_note writes the card; board_source opens a real file, scrolled to a line, instead of quoting it.",
		"Detail on request: the human can ask you to expand anything in the chat, so do not spend the answer on a summary of what the board already shows.",
		worktreePrompt(board, thread),
	].join("\n");
}

/**
 * The commands a thread is running through pi's own prompt frame, and how each one is settled.
 *
 * A command is a `prompt` frame like a message, and pi answers it with the same `response`. The one
 * difference is what that answer means: an extension command answers `handled`, which for a message
 * says the thread never ran and is fatal here — `server/thought.ts` reads it that way and the card is
 * marked dead. So a command's frame carries an id with this prefix, and the reader settles it here
 * before that branch is reached. A plain message's `handled` stays exactly as fatal as it was. A
 * `started` answer is the other way round: a run has begun, and the turn it answers is opened here.
 *
 * The map lives beside the frames rather than on the thread: it holds a resolver and a timer, and
 * `/state` serialises whole threads.
 */
import { addRow, patchRow, threadRef } from "../bus.ts";
import { beginRun } from "./run.ts";
import { randomUUID } from "node:crypto";

/** What makes a frame a command: a prompt's answer to settle here instead of a turn's. */
export const COMMAND_PREFIX = "cmd:";

/**
 * How long the route waits for pi to answer. A child that is streaming takes the frame at once — an
 * extension command runs during a run — so an answer this late is one that is not coming, and the
 * human is owed a refusal rather than a request that never ends.
 */
export const COMMAND_WAIT_MS = 10_000;

/**
 * What pi said about the command it was given: `handled` for an extension command that ran itself,
 * `started` when the frame began a run, `queued` when it joined one that was already going. A refusal
 * carries the words instead, with the status the route answers: 409 for a child that refused or left,
 * 504 for an answer that never came, which is not the same thing to whoever pressed the button.
 */
export type Disposition = { disposition: string } | { error: string; status: number };

type Waiting = {
	board: any;
	thread: any;
	rowId: string;
	label: string;
	startedAt: number;
	finish: (outcome: Disposition) => void;
	clock: ReturnType<typeof setTimeout>;
};

const waiting = new Map<string, Waiting>();

/**
 * A command about to be sent: its row on the rail, the id its frame carries, and the promise its answer
 * arrives on. The row is written here so the human sees what ran before pi has said anything back.
 */
export function beginCommand(board: any, thread: any, label: string): { id: string; outcome: Promise<Disposition> } {
	const id = `${COMMAND_PREFIX}${randomUUID()}`;
	const startedAt = Date.now();
	const rowId = randomUUID();
	addRow(board, {
		id: rowId,
		kind: "tool",
		tool: "command",
		label,
		status: "running",
		startedAt,
		thread: threadRef(thread),
	});
	const outcome = new Promise<Disposition>((finish) => {
		const clock = setTimeout(() => {
			settleCommand(id, { error: `pi did not answer /${label.replace(/^\//, "")} in ${Math.round(COMMAND_WAIT_MS / 1000)}s`, status: 504 });
		}, COMMAND_WAIT_MS);
		clock.unref?.();
		waiting.set(id, { board, thread, rowId, label, startedAt, finish, clock });
	});
	return { id, outcome };
}

/**
 * Answer one command: close its row, tell whoever is waiting, and forget it. False means nothing was
 * waiting on that id, which is what a second answer or a frame from an older child looks like.
 */
export function settleCommand(id: string, outcome: Disposition): boolean {
	const held = waiting.get(id);
	if (!held) return false;
	waiting.delete(id);
	clearTimeout(held.clock);
	const said = "error" in outcome ? outcome.error : outcome.disposition;
	patchRow(held.board, held.rowId, {
		status: "error" in outcome ? "error" : "ok",
		durationMs: Date.now() - held.startedAt,
		summary: said,
	});
	if (!("error" in outcome)) beganRun(held, outcome.disposition);
	held.finish(outcome);
	return true;
}



/**
 * The run a prompt template or a skill command begins, opened when pi says it began one.
 *
 * `handled` is an extension command running itself: no turn and no `agent_settled` follow it, so the thread
 * is left idle and untouched. `started` is prose pi hands the model, and a run follows — one whose
 * `turn_end` used to land on whatever turn the thread happened to end with, overwriting an answer someone
 * had already read, because nothing had named a turn for it. So the command gets a turn of its own, opened
 * by the same bookkeeping a message opens, and the reply lands under the words that asked for it. A
 * `queued` command answers inside a run already going, whose turn and `answering` pointer are its own:
 * opening a second turn there would take the reply of the first.
 */
function beganRun(held: Waiting, disposition: string): void {
	if (disposition === "handled") return;
	if (held.thread.status === "running") return;
	held.thread.turns ??= [];
	held.thread.turns.push({ text: held.label.slice(0, 4000), status: "sent", mode: "queue", at: Date.now() });
	// No target: the run answers the turn just made, which is the one pushed above.
	beginRun(held.board, held.thread);
}



/**
 * The commands this thread's child will never answer, settled with the reason it is gone: the route that
 * sent one hears the exit rather than waiting out its own clock for an answer that cannot come.
 */
export function flushCommands(thread: any, reason: string): void {
	for (const [id, held] of waiting) {
		if (held.thread !== thread) continue;
		settleCommand(id, { error: reason, status: 409 });
	}
}

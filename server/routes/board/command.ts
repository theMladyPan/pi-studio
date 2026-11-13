/**
 * `/command`: one of pi's own slash commands, run inside a thread.
 *
 * The name and the arguments are pi's, never rewritten here — `scan_codebase src` is the whole of what
 * an extension reads — so the route's work is the three things around it. It refuses a name neither
 * the menu nor pi knows, it refuses a card that is not a living thread, and it waits for pi's answer
 * so the human is told which of the three things happened: `handled` (an extension command ran itself),
 * `started` (the frame began a run) or `queued` (it joined one already going).
 *
 * The one spelling it does resolve is a skill's: pi names a skill `skill:name` and the menu shows `name`,
 * so the field can only send the short one. A short name that is pi's prefixed name with the prefix off
 * is that command, which is why `python-best-practices` runs `skill:python-best-practices`.
 *
 * Not in `THREAD_ROUTES`: a command may run an extension that writes files or dumps a codebase, and
 * `threadRefusal` is where a child is kept out of it.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { answer, fail, readJson } from "../../http.ts";
import { workdirOf } from "../../worktrees/make.ts";
import { commandList, NAME, refusal, resolve } from "../../commands.ts";
import { sendCommand } from "../../child/run.ts";

export async function onCommand(req: IncomingMessage, res: ServerResponse, board: any): Promise<void> {
	const body = await readJson(req, res);
	if (!body) return;
	const cardId = typeof body.cardId === "string" ? body.cardId.trim() : "";
	const name = typeof body.name === "string" ? body.name.trim().replace(/^\//, "") : "";
	const args = typeof body.args === "string" ? body.args.trim() : "";
	if (!cardId) return void fail(res, 400, "which thread? a command names its card");
	if (!name) return void fail(res, 400, "empty command");
	if (!NAME.test(name)) return void fail(res, 400, `${name} is not a command name`);
	// A command runs inside a thread, not beside one: the folder it reads, the extensions it may use and
	// the child that answers for it all come from the thread the card names.
	const thread = board.threads.get(cardId);
	if (!thread) return void fail(res, 409, "no thread answers this card");
	if (thread.status === "dead") return void fail(res, 409, "thread ended");
	// The same list the menu was drawn from, usually already read: a name pi does not have is refused here
	// rather than sent to a child that would answer it as prose about a slash command. A probe that could
	// not be read refuses nothing — it has no list to read the name against.
	const { commands, trouble } = await commandList(board, workdirOf(board, thread));
	// What pi is asked to run, which is the typed name unless the typed name is a skill's short one.
	let known = name;
	if (!trouble && commands.length) {
		known = resolve(commands, name);
		if (!known) return void fail(res, 409, refusal(commands, name));
	}
	const sent = sendCommand(board, thread, `/${known}${args ? ` ${args}` : ""}`);
	const outcome = await sent.outcome;
	if ("error" in outcome) return void fail(res, outcome.status, outcome.error);
	answer(res, 200, { id: thread.id, name: known, disposition: outcome.disposition });
}

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
import { commandList } from "../../commands.ts";
import type { SlashCommand } from "../../commands.ts";
import { sendCommand } from "../../child/run.ts";

/** The name pi knows a command by: its own, so a `skill:` command keeps its prefix. */
const NAME = /^[A-Za-z0-9][\w:.-]*$/;

/** The prefix pi puts on a skill's command, and the thing the menu takes off before the field writes it. */
const SKILL = "skill:";

/** How far a typed name may be from a real one and still be worth answering with it. */
const NEAR = 2;

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

/**
 * The name pi knows the typed one by: itself when the list has it, the `skill:` form when that is the one
 * command the short name can mean, and nothing when it is neither. Which form to send is the whole question
 * — pi runs the name it was given, so an unprefixed skill is a name it does not have.
 */
function resolve(commands: SlashCommand[], typed: string): string {
	if (commands.some((one) => one.name === typed)) return typed;
	const skills = commands.filter((one) => one.name === `${SKILL}${typed}`);
	return skills.length === 1 ? skills[0].name : "";
}

/**
 * The refusal, and the name the human most likely meant. `no command named /ndk-exprot` on its own leaves
 * them staring at a menu they closed, so a name one or two letters from a real one offers that one. A skill
 * is measured by its short name too, because the short name is the one the human had in front of them, and
 * it is offered prefixed, because the prefixed name is the one they can type. Two names equally near are a
 * guess rather than an answer, so they say nothing.
 */
function refusal(commands: SlashCommand[], typed: string): string {
	const said = `no command named /${typed}`;
	const near = commands
		.map((one) => ({ name: one.name, off: Math.min(away(typed, one.name), away(typed, shown(one.name))) }))
		.filter((one) => one.off <= NEAR)
		.sort((left, right) => left.off - right.off);
	const best = near[0];
	if (!best || near.filter((one) => one.off === best.off).length > 1) return said;
	return `${said} — did you mean /${best.name}?`;
}

/** The name the menu shows a command by: a skill's own, with the prefix pi names it with taken off. */
function shown(name: string): string {
	return name.startsWith(SKILL) ? name.slice(SKILL.length) : name;
}

/**
 * How many letters two names differ by. The whole table, because a name and a list are both short and a
 * suggestion may be a few thousand comparisons — small enough that a cleverer measure would only be harder
 * to read. Two letters swapped cost two, which is enough for `slikll` to reach `skill`.
 */
function away(left: string, right: string): number {
	const row = Array.from({ length: right.length + 1 }, (_, at) => at);
	for (let down = 1; down <= left.length; down++) {
		let above = row[0];
		row[0] = down;
		for (let at = 1; at <= right.length; at++) {
			const held = row[at];
			row[at] = Math.min(row[at] + 1, row[at - 1] + 1, above + (left[down - 1] === right[at - 1] ? 0 : 1));
			above = held;
		}
	}
	return row[right.length];
}

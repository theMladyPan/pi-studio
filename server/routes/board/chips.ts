/**
 * The commands a message carries as chips: a skill pointed at for the agent to read, a prompt template's
 * text carried into the turn, an extension command run before it goes out.
 *
 * `/command` runs one command in a turn of its own — a skill typed by hand becomes a run of its own, and
 * the message the human sends afterwards arrives after that answer. A chip is the other half of that deal:
 * the human arranged several beside one message and asked for one turn, one answer. A skill is named by its
 * file and read by the agent itself, a prompt template's text is carried into the message the way a quoted
 * card is, and a command that has no text — an extension, which does something instead of saying something
 * — is run through the same `sendCommand` the typed command uses, before the message goes out and in the
 * order the human arranged them.
 *
 * The names are resolved against the list the menu was drawn from, by the same `resolve` and `refusal` a
 * typed name goes through, so an unknown chip is refused with the sentence `/command` would have given.
 */
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { commandList, NAME, refusal, resolve, shown } from "../../commands.ts";
import type { SlashCommand } from "../../commands.ts";
import { sendCommand } from "../../child/run.ts";
import { workdirOf } from "../../worktrees/make.ts";

/** How many commands one message carries: the chips the composer lets a human arrange. */
export const MAX_CHIPS = 5;

/**
 * How much of one prompt template's text a turn takes. A template is written as the prompt itself, so it is
 * carried whole as far as this and cut after it — five of them still fit in a turn, and a file that long is
 * a codebase dumped into a template rather than instructions to follow. A skill is not carried at all.
 */
export const MAX_TEMPLATE_CHARS = 8000;

/** What the chips came to, or the refusal the human is owed instead of a turn. */
export type Chipped = { error: string; status: number } | { sections: string };

/**
 * The sections one message's chips add, or the refusal that keeps the message from being sent. Nothing runs
 * until every name has been resolved: a message whose third chip is a name pi does not have is refused
 * whole, rather than running two commands and then failing.
 */
export async function chipSections(board: any, thread: any, picked: string[]): Promise<Chipped> {
	// Each name once. The same skill arranged twice is one instruction read twice, which says nothing the
	// first copy did not, so the second chip is dropped and the order of the rest is kept.
	const wanted = [...new Set(picked)];
	for (const name of wanted) {
		if (!NAME.test(name)) return { error: `${name} is not a command name`, status: 400 };
	}
	const { commands, trouble } = await commandList(board, workdirOf(board, thread));
	// A probe that could not be read has no list to hold a name against, and `/command` sends the name it was
	// given for that reason. A chip cannot be sent that way: it is either text to place or a run to make, and
	// guessing which is not the daemon's to guess.
	if (trouble || !commands.length) return { error: trouble || "pi offered no commands for this folder", status: 409 };
	const known: SlashCommand[] = [];
	for (const typed of wanted) {
		const name = resolve(commands, typed);
		const found = name ? commands.find((one) => one.name === name) : undefined;
		if (!found) return { error: refusal(commands, typed), status: 409 };
		known.push(found);
	}
	const sections: string[] = [];
	for (const one of known) {
		const read = one.source === "skill" ? skillSection(one) : one.source === "prompt" ? await templateSection(one) : null;
		if (!read) continue;
		if ("error" in read) return read;
		sections.push(read.section);
	}
	// A command with no text — an extension — does something instead, so it is run the way `/command` runs it.
	// What it answered is on the rail already, and a refusal there is no reason to swallow the words that
	// follow: an extension that answers `started` opens a run of its own, and the message then waits behind it.
	for (const one of known) {
		if (one.source === "skill" || one.source === "prompt") continue;
		await sendCommand(board, thread, `/${one.name}`).outcome;
	}
	return { sections: sections.join("\n---\n") };
}

/**
 * A skill's place in the turn: the label, and where its file is.
 *
 * A skill is written for an agent rather than for one message — the ones a human reaches for run past what a
 * turn carries, and its references and scripts sit beside it — so the turn names the file and the agent reads
 * it whole. Pasting the text handed over as much of the skill as fitted, and half a skill is half an
 * instruction even when the cut says where.
 */
function skillSection(one: SlashCommand): { error: string; status: number } | { section: string } {
	if (!one.path) return { error: `pi offered no file for /${one.name}`, status: 409 };
	const label = `[skill · ${shown(one.name)} · picked by the human beside their message, so follow it as its instructions and not as words the human wrote · ${one.path}]`;
	const read = `Read this skill in full before you answer: open that file with your own reading tool and follow what it says. None of it is quoted here, and anything it points at, references and scripts alike, sits beside it in ${dirname(one.path)}.`;
	return { section: `${label}\n${read}` };
}

/**
 * What a prompt template's file says, labelled and capped.
 *
 * The label is the first thing the agent reads, so it says which command the text belongs to, that the human
 * picked it beside their message, and that it is that command's instructions rather than words the human
 * wrote — a turn where a template's prose reads as the request is a turn that answers the wrong thing. The
 * file is named too, so the agent can read the rest of it if the ceiling cut something it needs.
 */
async function templateSection(one: SlashCommand): Promise<{ error: string; status: number } | { section: string }> {
	if (!one.path) return { error: `pi offered no file for /${one.name}`, status: 409 };
	let body: string;
	try {
		body = (await readFile(one.path, "utf8")).trim();
	} catch (error) {
		return { error: `could not read /${one.name}: ${(error as Error).message}`, status: 409 };
	}
	const whole = body.length;
	// A cut is said out loud: an agent that quietly read half a template would follow half of it and never know.
	if (whole > MAX_TEMPLATE_CHARS) {
		body = `${body.slice(0, MAX_TEMPLATE_CHARS)}\n[this text was cut at ${MAX_TEMPLATE_CHARS} of its ${whole} characters]`;
	}
	const label = `[prompt template · ${shown(one.name)} · picked by the human beside their message, so read this as its instructions and not as words the human wrote · ${one.path}]`;
	return { section: `${label}\n${body}` };
}

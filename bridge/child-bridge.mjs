/**
 * The board's side of a thread.
 *
 * pi-studio starts every child with this file loaded (`-ne -e <this>`), and passes what it needs to
 * reach back through the environment. A child that was started by hand, with no daemon behind it,
 * registers nothing rather than offering tools that cannot reach anything.
 *
 * The tools are thin: they say what the human should see, and the daemon decides how it looks —
 * card type, placement, cascade, keys. Everything here goes through the same HTTP routes the board's
 * own client uses, so the verbs belong to the daemon and not to pi.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

const BASE = process.env.PI_STUDIO_URL ?? "";
const TOKEN = process.env.PI_STUDIO_TOKEN ?? "";
const WORKSPACE = process.env.PI_STUDIO_WORKSPACE ?? "";
const THREAD = process.env.PI_STUDIO_THREAD ?? "";
// What this board asks of a card: how often, and what may be inside one. Both are read here rather than
// only in the system prompt, because the description of a tool is read at the moment the model decides
// whether to call it, and that is where a frequency rule actually lands.
const VERBOSITY = process.env.PI_STUDIO_CARDS_VERBOSITY ?? "";
const OFF = (process.env.PI_STUDIO_CARDS_OFF ?? "").split(",").filter(Boolean);

/** The words for a switch a board has turned off, so the sentence names what it costs. */
const OFF_WORDS = {
	showCodeFragments: "code fragments",
	showMathFormulas: "math formulas",
	showCharts: "charts and tables of numbers",
	showReferences: "references",
};

/** How often this board wants a card, one line, or nothing when the board is on the board's default. */
const WHEN = {
	quiet: "This board is on quiet: write a card only when the human asked for one in so many words.",
	normal: "This board is on normal: a card for something that has to be seen, none for narration.",
};

/** The two sentences a card tool carries under this board's settings. */
function cardRules() {
	const off = OFF.map((key) => OFF_WORDS[key]).filter(Boolean);
	const said = [WHEN[VERBOSITY] ?? "", off.length ? `Off for this board, say it in words instead: ${off.join(", ")}. A human asking for one of those by name outranks this.` : ""];
	return said.filter(Boolean).join(" ");
}

/** Said once, because it is the same sentence on both card tools. */
const RULES = cardRules();

/** True when a daemon handed this child a board to draw on. */
function attached() {
	return Boolean(BASE && TOKEN && WORKSPACE);
}

const DETACHED = "This run has no board behind it, so nothing was shown to the user.";

async function call(path, body) {
	const query = `token=${encodeURIComponent(TOKEN)}&workspace=${encodeURIComponent(WORKSPACE)}`;
	const response = await fetch(`${BASE}${path}?${query}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		// The thread this child speaks for, so the daemon can cascade its cards under it.
		body: JSON.stringify({ threadRoot: THREAD, ...body }),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`${path} answered ${response.status}: ${text.slice(0, 300)}`.trim());
	return JSON.parse(text);
}

function failure(error) {
	return { content: [{ type: "text", text: `The board refused that: ${error.message}` }] };
}

const noteTool = defineTool({
	name: "board_note",
	label: "Board note",
	description:
		"Put a note on the user's board. Use it for a diagram, a table, a file tree, a todo list that will be updated, or a finding worth keeping beside the conversation instead of buried in it. One card holds one kind of thing: a chart and the todo for it are two notes. Markdown is rendered; a fenced mermaid block draws a diagram, so a flow, a state machine, a sequence or a tree is mermaid, and a chart with numbers on an axis is a ```chart block, never a hand-written svg. Pass the same key again to revise that note in place, which is how a checklist grows." +
		(RULES ? ` ${RULES}` : ""),
	parameters: Type.Object({
		markdown: Type.String({ description: "Note body in markdown." }),
		title: Type.Optional(Type.String({ description: "Short card title, for example the step name." })),
		key: Type.Optional(
			Type.String({
				description:
					"Stable name for this note, e.g. 'plan'. Reusing it revises the same card. A [[key]] in your chat answer points at this card, so give every note one and use the same string in both places.",
			}),
		),
		size: Type.Optional(
			Type.Union(["compact", "normal", "wide", "tall"].map((size) => Type.Literal(size)), {
				description:
					"Card size for the form, not for emphasis: 'wide' for a chart or table with more than ten columns or points, 'compact' for a three-line answer, 'tall' for a long checklist or trace. Leave it out on almost every card.",
			}),
		),
		after: Type.Optional(
			Type.Array(Type.String(), {
				description: "Keys or ids of the cards this one builds on. The board draws an arrow from each.",
			}),
		),
	}),
	async execute(_id, params) {
		if (!attached()) return { content: [{ type: "text", text: DETACHED }] };
		try {
			const result = await call("/card/note", {
				markdown: params.markdown,
				...(params.title ? { title: params.title } : {}),
				...(params.key ? { key: params.key } : {}),
				...(params.size ? { size: params.size } : {}),
				...(params.after?.length ? { after: params.after } : {}),
			});
			const what = result.updated ? "Revised" : "Added";
			// The key is how a later turn revises this card and how a [[key]] in the chat finds it.
			const key = result.card?.key ?? params.key ?? "";
			const said = `${what} board note${params.title ? `: ${params.title}` : ""}${key ? ` (key [[${key}]])` : ""}.`;
			return {
				content: [{ type: "text", text: typeof result.report === "string" && result.report ? `${said} ${result.report}` : said }],
				details: { cardId: result.cardId },
			};
		} catch (error) {
			return failure(error);
		}
	},
});

const sourceTool = defineTool({
	name: "board_source",
	label: "Board source",
	description:
		"Open a file from the workspace on the user's board, scrolled to a line, so they read the real text rather than a description of it. For a file the human asked to see: it is not how you show evidence, which is a reference at the foot of a card. Passing the same path again refreshes that card after the file changes." +
		(RULES ? ` ${RULES}` : ""),
	parameters: Type.Object({
		path: Type.String({ description: "File path, relative to the workspace folder." }),
		line: Type.Optional(Type.Number({ description: "Line to centre the view on." })),
		title: Type.Optional(Type.String({ description: "Optional card title, defaults to the file name." })),
		key: Type.Optional(Type.String({ description: "Stable name for this card. Defaults to the path." })),
		size: Type.Optional(
			Type.Union(["compact", "normal", "wide", "tall"].map((size) => Type.Literal(size)), {
				description:
					"Card size for the form, not for emphasis: 'wide' for a chart or table with more than ten columns or points, 'compact' for a three-line answer, 'tall' for a long checklist or trace. Leave it out on almost every card.",
			}),
		),
	}),
	async execute(_id, params) {
		if (!attached()) return { content: [{ type: "text", text: DETACHED }] };
		try {
			const result = await call("/card/source", {
				path: params.path,
				...(Number.isFinite(params.line) ? { line: params.line } : {}),
				...(params.title ? { title: params.title } : {}),
				...(params.key ? { key: params.key } : {}),
				...(params.size ? { size: params.size } : {}),
			});
			const card = result.card ?? {};
			const lines = Number.isFinite(card.lines) ? ` (${card.lines} lines)` : "";
			return {
				content: [{ type: "text", text: `Opened ${params.path}${lines} on the board.` }],
				details: { cardId: result.cardId },
			};
		} catch (error) {
			return failure(error);
		}
	},
});

const askTool = defineTool({
	name: "board_ask",
	label: "Ask on board",
	description:
		"Ask the human a question on the board and wait for their click. Use it for a decision that is genuinely theirs instead of guessing, or when two readings of the request lead to different work. Blocks this turn until they answer or the question expires. Set `multiple: true` when more than one of the options can apply: the human then ticks boxes and sends them together, and the answer is all of them. Ask several decisions at once with `questions`, up to five: each lands on its own tab and the answer comes back as one line per question.",
	parameters: Type.Object({
		question: Type.Optional(
			Type.String({ description: "The question, in one or two sentences. Leave it out when you ask several with `questions`." }),
		),
		options: Type.Optional(
			Type.Array(Type.String(), { description: "Two to four choices they can click, each a short phrase." }),
		),
		questions: Type.Optional(
			Type.Array(
				Type.Object({
					question: Type.String({ description: "One question, in one or two sentences." }),
					options: Type.Array(Type.String(), { description: "Two to four choices they can click, each a short phrase." }),
					multiple: Type.Optional(
						Type.Boolean({ description: "Let them tick more than one option on this tab. Defaults to false." }),
					),
					allowFreeText: Type.Optional(
						Type.Boolean({ description: "Also allow a typed answer on this tab. Defaults to true." }),
					),
				}),
				{
					description:
						"Up to five questions asked together, one tab each, sent in one go. Use it instead of several board_ask calls when the answers belong together.",
				},
			),
		),
		title: Type.Optional(Type.String({ description: "Optional card title." })),
		allowFreeText: Type.Optional(Type.Boolean({ description: "Also allow a typed answer. Defaults to true." })),
		multiple: Type.Optional(
			Type.Boolean({
				description:
					"Let the human pick more than one option. Defaults to false, where one click answers the question.",
			}),
		),
	}),
	async execute(_id, params) {
		if (!attached()) return { content: [{ type: "text", text: DETACHED }] };
		const listed = Array.isArray(params.questions) ? params.questions.filter((one) => one && one.question) : [];
		if (!listed.length && !params.question) {
			return {
				content: [
					{ type: "text", text: "Nothing was asked: give `question` and `options`, or a `questions` list of the same." },
				],
			};
		}
		// The card has one row of tabs, so more than five questions wants a second card rather than a
		// scroll, and the daemon refuses the same number.
		if (listed.length > 5) {
			return { content: [{ type: "text", text: "A card asks up to five questions. Ask these five, then ask the rest." }] };
		}
		try {
			const result = await call("/card/ask", {
				...(listed.length ? { questions: listed } : {}),
				...(params.question ? { question: params.question } : {}),
				...(Array.isArray(params.options) ? { options: params.options } : {}),
				...(params.title ? { title: params.title } : {}),
				...(typeof params.allowFreeText === "boolean" ? { allowFreeText: params.allowFreeText } : {}),
				...(params.multiple === true ? { multiple: true } : {}),
			});
			// A question that took several answers comes back as the list, so the child reads the picks
			// rather than one line it would have to split again. A card of tabs comes back one line per tab.
			const picked = Array.isArray(result.answers) && result.answers.length ? result.answers : null;
			const said = !picked
				? `The human answered: ${result.answer}`
				: listed.length
					? `The human answered all ${picked.length} questions: ${picked.map((one, at) => `${at + 1}) ${one}`).join(" · ")}`
					: `The human chose: ${picked.join(", ")}`;
			return {
				content: [{ type: "text", text: said }],
				details: { cardId: result.cardId, answer: result.answer, ...(picked ? { answers: picked } : {}) },
			};
		} catch (error) {
			// A question nobody answered is not a failure of the work: the turn has to decide for itself.
			if (String(error.message).includes("409")) {
				return { content: [{ type: "text", text: "Nobody answered that question in time. Decide sensibly and say what you assumed." }] };
			}
			return failure(error);
		}
	},
});

const threadTool = defineTool({
	name: "board_thread",
	label: "Spawn a thread",
	description:
		"Spawn a child thread on the board and wait for it. The child has its own session, its own worktree cut from yours, and the role you give it, and its last message comes back to you as the result. Call it twice in one turn to run two children side by side. A thread spawned this way cannot spawn further threads, and the timeout is the only thing that ends a child you are waiting on.",
	parameters: Type.Object({
		title: Type.String({ description: "Short name for the child's card." }),
		task: Type.String({
			description:
				"The child's whole assignment: goal and why, bounded scope or the one question, known evidence and paths, acceptance criteria, the checks it may run, and the output you want back.",
		}),
		role: Type.Optional(
			Type.Union(["scout", "implement", "review", "chore", "architect"].map((role) => Type.Literal(role)), {
				description:
					"scout maps unknown files and relationships; implement changes one coherent slice; review judges an artifact against the goal; chore runs separable tests, checks and maintenance; architect settles one structural decision, read-only.",
			}),
		),
		after: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Card or thread ids this child hangs under, one arrow drawn from each. Use them to show what the child follows from, chronological or logical.",
			}),
		),
		provider: Type.Optional(Type.String({ description: "Provider override, together with model." })),
		model: Type.Optional(Type.String({ description: "Model override, together with provider." })),
		thinking: Type.Optional(
			Type.Union(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => Type.Literal(level)), {
				description: "Thinking override; otherwise the role's own level.",
			}),
		),
		timeoutSeconds: Type.Optional(Type.Number({ description: "Hard limit on the child's run. Default 600, at most 3600." })),
		maxTurns: Type.Optional(Type.Number({ description: "Turn ceiling, reported rather than enforced." })),
		maxCostUsd: Type.Optional(Type.Number({ description: "Cost ceiling, reported rather than enforced." })),
	}),
	async execute(_id, params) {
		if (!attached()) return { content: [{ type: "text", text: DETACHED }] };
		try {
			const result = await call("/thread/spawn", {
				title: params.title,
				task: params.task,
				...(params.role ? { role: params.role } : {}),
				...(params.after?.length ? { after: params.after } : {}),
				...(params.provider && params.model ? { provider: params.provider, model: params.model } : {}),
				...(params.thinking ? { thinking: params.thinking } : {}),
				...(Number.isFinite(params.timeoutSeconds) ? { timeoutSeconds: params.timeoutSeconds } : {}),
				...(Number.isFinite(params.maxTurns) ? { maxTurns: params.maxTurns } : {}),
				...(Number.isFinite(params.maxCostUsd) ? { maxCostUsd: params.maxCostUsd } : {}),
			});
			const crossed = [
				result.breached?.timeout ? "timed out" : "",
				result.breached?.turns ? "over its turn ceiling" : "",
				result.breached?.cost ? "over its cost ceiling" : "",
			].filter(Boolean);
			const spent = `$${(result.usage?.cost ?? 0).toFixed(2)}, ${result.usage?.turns ?? 0} turns`;
			const head = `Child ${result.cardId} ${result.status ?? "done"} — ${spent}${crossed.length ? ` (${crossed.join(", ")})` : ""}`;
			return {
				content: [{ type: "text", text: `${head}\n\n${String(result.output ?? "").trim() || "(the child said nothing)"}` }],
				details: result,
			};
		} catch (error) {
			return failure(error);
		}
	},
});


const skillTool = defineTool({
	name: "board_skill",
	label: "Board skill",
	description:
		"Load the chart documentation before writing your first ```chart block in a session. Returns the grammar, the rules that keep a chart legible in a small card, and worked examples.",
	parameters: Type.Object({
		name: Type.Literal("chart", { description: "The skill to load. `chart` is the only one so far." }),
	}),
	async execute(_id, params) {
		if (!attached()) return { content: [{ type: "text", text: DETACHED }] };
		try {
			const result = await call("/skill", { name: params.name });
			return { content: [{ type: "text", text: result.text }] };
		} catch (error) {
			return failure(error);
		}
	},
});


const closeTool = defineTool({
	name: "board_close",
	label: "Close a card",
	description:
		"Close a card that is spent, to keep the board readable. A superseded option, a question that no longer matters. A child you spawned needs no close: the board puts its card away itself once you have its answer. Only close a card you are certain no other card refers to and that plays no part in the work still going: this cannot be undone from here. A pinned card cannot be closed, and never the card you answer on. When several cards have gone stale, say so and offer to clean the board rather than closing them unasked.",
	parameters: Type.Object({
		card: Type.String({ description: "The card's key, or its id." }),
	}),
	async execute(_id, params) {
		if (!attached()) return { content: [{ type: "text", text: DETACHED }] };
		try {
			const result = await call("/close", { cardId: params.card });
			return {
				content: [{ type: "text", text: `Closed ${params.card}.` }],
				details: { cardId: result.closed ?? params.card },
			};
		} catch (error) {
			return failure(error);
		}
	},
});


const collectTool = defineTool({
	name: "board_collect",
	label: "Free merged children",
	description:
		"Ask the board to free the worktrees and branches of the children you spawned whose work you have already merged or otherwise brought in. Each child that goes takes its thread, its closed card and its transcript with it, so its conversation cannot be reopened: this cannot be undone from here. The board only frees what it can prove is integrated, and answers with what it kept and why. A retired tree is wiped clean, so only what the child committed survives: commit what you want to keep before the child finishes.",
	parameters: Type.Object({}),
	async execute(_id, _params) {
		if (!attached()) return { content: [{ type: "text", text: DETACHED }] };
		try {
			const result = await call("/thread/collect", {});
			const removed = Array.isArray(result.removed) ? result.removed : [];
			const kept = Array.isArray(result.kept) ? result.kept : [];
			const named = (one) => one.title ?? one.id;
			const freed = removed.length
				? `Freed ${removed.length} of this thread's children: ${removed.map(named).join(", ")}.`
				: kept.length
					? "Nothing was freed."
					: "Nothing was freed: this thread has no closed child to collect.";
			const held = kept.length
				? ` Kept ${kept.length}: ${kept.map((one) => `${named(one)} (${one.reason})`).join("; ")}.`
				: "";
			return { content: [{ type: "text", text: `${freed}${held}` }], details: { removed, kept } };
		} catch (error) {
			return failure(error);
		}
	},
});


export default function boardBridge(pi) {
	if (!attached()) return;
	pi.registerTool(noteTool);
	pi.registerTool(sourceTool);
	pi.registerTool(askTool);
	pi.registerTool(threadTool);
	pi.registerTool(skillTool);
	pi.registerTool(closeTool);
	pi.registerTool(collectTool);
}

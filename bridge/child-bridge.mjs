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
		"Put a note on the user's board. Use it for a diagram, a table, a file tree, a todo list that will be updated, or a finding worth keeping beside the conversation instead of buried in it. One card holds one kind of thing: a chart and the todo for it are two notes. Markdown is rendered; a fenced mermaid block draws a diagram, a fenced svg block draws a picture. Pass the same key again to revise that note in place, which is how a checklist grows.",
	parameters: Type.Object({
		markdown: Type.String({ description: "Note body in markdown." }),
		title: Type.Optional(Type.String({ description: "Short card title, for example the step name." })),
		key: Type.Optional(
			Type.String({
				description:
					"Stable name for this note, e.g. 'plan'. Reusing it revises the same card. A [[key]] in your chat answer points at this card, so give every note one and use the same string in both places.",
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
			});
			const what = result.updated ? "Revised" : "Added";
			return {
				content: [{ type: "text", text: `${what} board note${params.title ? `: ${params.title}` : ""}.` }],
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
		"Open a file from the workspace on the user's board, scrolled to a line, so they read the real text rather than a description of it. Use it whenever you point at code or config. Passing the same path again refreshes that card after the file changes.",
	parameters: Type.Object({
		path: Type.String({ description: "File path, relative to the workspace folder." }),
		line: Type.Optional(Type.Number({ description: "Line to centre the view on." })),
		title: Type.Optional(Type.String({ description: "Optional card title, defaults to the file name." })),
		key: Type.Optional(Type.String({ description: "Stable name for this card. Defaults to the path." })),
	}),
	async execute(_id, params) {
		if (!attached()) return { content: [{ type: "text", text: DETACHED }] };
		try {
			const result = await call("/card/source", {
				path: params.path,
				...(Number.isFinite(params.line) ? { line: params.line } : {}),
				...(params.title ? { title: params.title } : {}),
				...(params.key ? { key: params.key } : {}),
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
		"Ask the human a question on the board and wait for their click. Use it for a decision that is genuinely theirs instead of guessing, or when two readings of the request lead to different work. Blocks this turn until they answer or the question expires, so ask one thing at a time.",
	parameters: Type.Object({
		question: Type.String({ description: "The question, in one or two sentences." }),
		options: Type.Array(Type.String(), {
			description: "Two to four choices they can click, each a short phrase.",
		}),
		title: Type.Optional(Type.String({ description: "Optional card title." })),
		allowFreeText: Type.Optional(Type.Boolean({ description: "Also allow a typed answer. Defaults to true." })),
	}),
	async execute(_id, params) {
		if (!attached()) return { content: [{ type: "text", text: DETACHED }] };
		try {
			const result = await call("/card/ask", {
				question: params.question,
				options: params.options,
				...(params.title ? { title: params.title } : {}),
				...(typeof params.allowFreeText === "boolean" ? { allowFreeText: params.allowFreeText } : {}),
			});
			return {
				content: [{ type: "text", text: `The human answered: ${result.answer}` }],
				details: { cardId: result.cardId, answer: result.answer },
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

export default function boardBridge(pi) {
	if (!attached()) return;
	pi.registerTool(noteTool);
	pi.registerTool(sourceTool);
	pi.registerTool(askTool);
}

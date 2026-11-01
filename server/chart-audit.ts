/**
 * What a chart fence will look like on the card, said back to the model that wrote it.
 *
 * A chart block is a Chart.js config written as JSON, so there is nothing here to draw and nothing to
 * import from the client: this module reads the config and reports only what the model can act on. The
 * failures that matter are the ones a card 400px wide makes for it — too many labels, too many series,
 * a config that is not JSON at all — and every message is one line that says what to change.
 */

/** A card below this width cannot hold many labels, and `size="wide"` is what lifts the limit. */
const WIDE = 600;
const MAX_LABELS = 10;
const MAX_DATASETS = 6;
/** `options` itself counts as one, so four is `options.scales.y.ticks` and no deeper. */
const MAX_OPTION_DEPTH = 4;
/** A report is read by a model that cannot see the card, so it has to fit in a glance: four lines, then a count. */
const MAX_WARNINGS = 4;
/** The longest fence body the card draws, named here so the model hears the limit in the report. */
const MAX_BODY = 20000;
/** The types Chart.js registers in the bundle the board ships. */
const TYPES = ["bar", "line", "pie", "doughnut", "polarArea", "radar", "bubble", "scatter"];

export function auditMarkdown(markdown: string, width = 406): { warnings: string[]; summary: string } {
	const warnings: string[] = [];
	const summaries: string[] = [];
	try {
		for (const body of chartFences(String(markdown ?? ""))) {
			try {
				const audited = auditFence(body, width);
				warnings.push(...audited.warnings);
				if (audited.summary) summaries.push(audited.summary);
			} catch (error) {
				// A reader that chokes on one fence must not take the rest of the note with it.
				warnings.push(`chart block could not be read: ${message(error)}`);
			}
		}
	} catch {
		// A note is never worth failing a tool call over: the worst case is a fence nobody described.
	}
	if (warnings.length > MAX_WARNINGS) {
		const more = warnings.length - MAX_WARNINGS;
		warnings.length = MAX_WARNINGS;
		warnings.push(`and ${more} more`);
	}
	return { warnings, summary: summaries.join(" · ") };
}

/** One fence, as a warning list and a line naming the shape the reader will meet. */
function auditFence(body: string, width: number): { warnings: string[]; summary: string } {
	// The card refuses a body this long before it parses one, so the model is told the number here.
	if (body.length > MAX_BODY) {
		return { warnings: [`chart block is ${body.length} characters: the card draws at most ${MAX_BODY}`], summary: "" };
	}
	let config: unknown;
	try {
		config = JSON.parse(body);
	} catch (error) {
		// The most common failure by far, so it is the shortest message: the parser already says where.
		return { warnings: [`chart block is not JSON: ${message(error)}`], summary: "" };
	}
	const warnings: string[] = [];
	// A config is data. A callback written into one is either a string that does nothing or a body that
	// does not parse, and both are worth saying out loud. A bare `new` is not: it is a word a label uses.
	if (/\bfunction\b|=>/.test(body)) {
		warnings.push("chart block holds code: JSON carries data only, so a function here never runs");
	}
	const chart = asObject(config);
	const type = typeof chart.type === "string" ? chart.type : "";
	if (!type) warnings.push(`chart block has no type: one of ${TYPES.join(", ")}`);
	else if (!TYPES.includes(type)) warnings.push(`${type} is not a chart type here: use one of ${TYPES.join(", ")}`);

	const data = asObject(chart.data);
	const labels = Array.isArray(data.labels) ? data.labels : [];
	const declared = Array.isArray(data.datasets) ? data.datasets : [];
	if (!Array.isArray(data.datasets)) warnings.push("chart block has no data.datasets");
	else if (!declared.length) warnings.push("data.datasets is empty: a chart needs one dataset with values");

	if (labels.length > MAX_LABELS && width < WIDE) {
		warnings.push(`${labels.length} labels in a ${width}px card: rotate, shorten, or use size="wide"`);
	}
	if (declared.length > MAX_DATASETS) {
		warnings.push(`${declared.length} datasets in one chart: unreadable, keep the top three`);
	}

	let points = 0;
	declared.forEach((entry, index) => {
		const dataset = asObject(entry);
		const values = Array.isArray(dataset.data) ? dataset.data : [];
		points += values.length;
		const name = typeof dataset.label === "string" && dataset.label ? `"${dataset.label}"` : `#${index + 1}`;
		if (!values.length) warnings.push(`dataset ${name} has no data`);
		else if (labels.length && values.length !== labels.length) {
			warnings.push(`${values.length} values in dataset ${name} for ${labels.length} labels: one value per label`);
		}
	});
	if (points === 1) warnings.push("a chart of one value says nothing a sentence cannot");

	const depth = depthOf(chart.options);
	if (depth > MAX_OPTION_DEPTH) {
		warnings.push(`options nested ${depth} deep: keep only what you need, the board sets the rest`);
	}

	const summary = type
		? `chart: ${type}, ${labels.length} label${labels.length === 1 ? "" : "s"}, ${declared.length} dataset${declared.length === 1 ? "" : "s"}`
		: "";
	return { warnings, summary };
}

/** The bodies of every ```chart fence, matched the way the client matches a fence. */
function chartFences(markdown: string): string[] {
	const found: string[] = [];
	for (const match of markdown.matchAll(/(`{3,})([a-zA-Z0-9_-]*)\n([\s\S]*?)\1/g)) {
		if (match[2].toLowerCase() === "chart") found.push(match[3]);
	}
	return found;
}

/** A parsed config or one of its parts, read as a bag of keys without trusting that it is one. */
function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** How many objects deep `options` reaches, counting `options` itself as the first. */
function depthOf(value: unknown, depth = 1): number {
	const node = asObject(value);
	let deepest = depth;
	for (const child of Object.values(node)) {
		if (child && typeof child === "object") deepest = Math.max(deepest, depthOf(child, depth + 1));
	}
	return deepest;
}

/** The parser's own message, on one line: a warning that wraps is a warning the model skims past. */
function message(error: unknown): string {
	return String((error as { message?: unknown } | null)?.message ?? error).split("\n")[0];
}

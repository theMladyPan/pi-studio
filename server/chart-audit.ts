/**
 * What a chart fence will look like on the card, said back to the model that wrote it.
 *
 * The client draws the svg, but the model cannot see the drawing, so the two things that make a chart
 * unreadable in a card about 400px wide — too many categories, too many series — have to be said in
 * words and said before the reader meets them. This module parses the fence and reports only what the
 * model can act on. It never draws and never imports the client: `tsc` cannot resolve a `.js` under
 * `public/`, and the layout numbers here are the ones the drawing budgets for anyway.
 */

const CHAR = 7;
const WIDE = 600;
const MAX_CATEGORIES = 10;
const MAX_SERIES = 6;

type Fence = {
	type: string;
	sort: string;
	series: number;
	points: number;
	values: number;
	hasY: boolean;
};

export function auditMarkdown(markdown: string, width = 406): { warnings: string[]; summary: string } {
	const warnings: string[] = [];
	const summaries: string[] = [];
	try {
		for (const body of chartFences(String(markdown ?? ""))) {
			const fence = parseFence(body);
			if (!fence) {
				warnings.push("chart block does not parse: no --- separator and no two-column rows");
				continue;
			}
			if (!fence.hasY) warnings.push("chart block has data but no y: header");
			if (fence.values === 1) warnings.push("a chart of one value says nothing a sentence cannot");
			if (fence.points > MAX_CATEGORIES && width < WIDE) {
				warnings.push(`${fence.points} categories in ${width}px: labels will be elided or rotated, use size="wide" or fewer points`);
			}
			if (fence.series > MAX_SERIES) warnings.push(`${fence.series} series in one chart: unreadable, split it or keep the top three`);
			const order = fence.sort === "none" ? "not sorted" : `sorted ${fence.sort}`;
			summaries.push(`chart: ${fence.type}, ${fence.points} point${fence.points === 1 ? "" : "s"}, ${fence.series} series, ${order}`);
		}
	} catch {
		// A note is not worth failing over: a fence this reader chokes on draws as an empty box and says
		// nothing, which is what the client already does on its own.
	}
	return { warnings, summary: summaries.join(" · ") };
}

/** The bodies of every ```chart fence, matched the way the client matches a fence. */
function chartFences(markdown: string): string[] {
	const found: string[] = [];
	for (const match of markdown.matchAll(/(`{3,})([a-zA-Z0-9_-]*)\n([\s\S]*?)\1/g)) {
		if (match[2].toLowerCase() === "chart") found.push(match[3]);
	}
	return found;
}

/**
 * The same fence grammar the drawing reads, cut down to what a warning needs: the type, the order, how
 * many rows and series the model wrote, and whether it named them. `null` means the body is not a chart.
 */
function parseFence(body: string): Fence | null {
	const lines = body
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const separator = lines.indexOf("---");
	let type = "bar";
	let sort = "none";
	let yText = "";
	const rows: string[] = [];

	const readHeader = (line: string) => {
		const pair = line.match(/^([a-z][\w-]*)\s*:\s*(.*)$/i);
		if (!pair) return false;
		const key = pair[1].toLowerCase();
		const value = pair[2].trim();
		if (key === "type") type = value.toLowerCase() || "bar";
		else if (key === "sort") sort = value.toLowerCase() || "none";
		else if (key === "y") yText = value;
		else if (!["title", "x", "scale", "labels", "goal"].includes(key)) return false;
		return true;
	};

	if (separator < 0) {
		// No `---`: the body is a two-column table, so a line with a value is data and a known key is a header.
		for (const line of lines) if (!readHeader(line)) rows.push(line);
	} else {
		for (const line of lines.slice(0, separator)) readHeader(line);
		rows.push(...lines.slice(separator + 1));
	}

	let dataRows = rows.map(cellsOf).filter((row) => row.length >= 2);
	if (!dataRows.length) {
		// The drawing accepts a `---` block whose rows hold one value each, so the audit does too.
		const lone = rows.map(cellsOf).filter((row) => row.length === 1 && numberOf(row[0]) !== null);
		if (separator < 0 || !lone.length) return null;
		dataRows = lone;
	}
	const widestRow = dataRows.reduce((most, row) => Math.max(most, row.length - 1), 1);
	const values = dataRows.reduce((total, row) => total + row.slice(1, widestRow + 1).filter((cell) => numberOf(cell) !== null).length, 0);
	const declared = yText ? yText.split(",").filter((entry) => entry.trim()) : [];
	return {
		type,
		sort: sort === "asc" || sort === "desc" ? sort : type === "hbar" ? "desc" : "none",
		series: Math.max(1, declared.length || widestRow),
		points: dataRows.length,
		values,
		hasY: declared.length > 0,
	};
}

/** A row's cells, separated the way the drawing separates them: `|`, then a comma, then a `label: value`. */
function cellsOf(line: string): string[] {
	if (line.includes("|")) return line.split("|").map((cell) => cell.trim());
	if (line.includes(",")) return line.split(",").map((cell) => cell.trim());
	return line.split(/:(.+)/).map((cell) => cell.trim());
}

function numberOf(cell: string | undefined): number | null {
	const cleaned = String(cell ?? "").replace(/[\s,_%]/g, "");
	if (!cleaned || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(cleaned)) return null;
	const parsed = Number(cleaned);
	return Number.isFinite(parsed) ? parsed : null;
}

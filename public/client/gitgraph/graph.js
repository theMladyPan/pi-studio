/** Place pending parents in columns, keeping their place until the parent is drawn. */
export function layoutGraph(commits, { more = false, firstParentOnly = false } = {}) {
	const positions = new Map(commits.map((commit, i) => [commit.hash, i]));
	const pending = [];
	const rows = [];
	let width = 1;

	for (const [index, { hash, parentHashes }] of commits.entries()) {
		const incoming = pending.findIndex((entry) => entry?.hash === hash);
		const lane = incoming < 0 ? vacant(pending) : incoming;
		const tone = incoming < 0 ? freeTone(pending) : pending[incoming].tone;
		const links = pending.flatMap((entry, column) => entry && column !== incoming
			? [{ from: column, to: column, tone: entry.tone, uncommitted: entry.uncommitted, kind: "pass" }]
			: []);
		if (incoming >= 0) {
			links.push({ from: lane, to: lane, tone, uncommitted: pending[incoming].uncommitted, kind: "in" });
			pending[lane] = null;
		}

		// Missing parents are continuations only when the walk can still return them.
		// A parent excluded by an author/tag filter must not run a line to the bottom.
		const parents = firstParentOnly ? parentHashes.slice(0, 1) : parentHashes;
		const targets = [...new Set(parents)].filter((parent) =>
			parent && (positions.has(parent) ? positions.get(parent) > index : more));
		for (const [order, parent] of targets.entries()) {
			let to = pending.findIndex((entry) => entry?.hash === parent);
			if (to < 0) {
				to = order === 0 ? lane : vacant(pending);
				pending[to] = { hash: parent, tone: order === 0 ? tone : freeTone(pending, tone), uncommitted: hash === "*" };
			}
			links.push({ from: lane, to, tone: pending[to].tone, kind: "out", uncommitted: hash === "*" });
		}
		while (pending.length && !pending.at(-1)) pending.pop();
		width = Math.max(width, lane + 1, pending.length);
		rows.push({ lane, tone, links, root: !parentHashes.some(Boolean), exits: pending.flatMap((p, column) => p ? [{ column, tone: p.tone, uncommitted: p.uncommitted }] : []) });
	}
	return { rows, width };
}

function vacant(lanes) {
	const free = lanes.findIndex((lane) => !lane);
	return free < 0 ? lanes.length : free;
}

function freeTone(lanes, reserved) {
	const used = new Set(lanes.filter(Boolean).map((lane) => lane.tone));
	let tone = 0;
	while (tone === reserved || used.has(tone)) tone += 1;
	return tone;
}

export const ROW_HEIGHT = 24;
const LANE_STEP = 16;
const FIRST_DOT = 16;
export const graphWidth = (lanes) => FIRST_DOT + LANE_STEP * lanes;
const laneX = (column) => FIRST_DOT + LANE_STEP * column;

function svgNode(name, attributes) {
	const node = document.createElementNS("http://www.w3.org/2000/svg", name);
	for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
	return node;
}

export function drawLanes(row, width, colors, { current, stash, uncommitted, angular }) {
	const half = ROW_HEIGHT / 2;
	const svg = svgNode("svg", { class: "lanes", width, height: ROW_HEIGHT, viewBox: `0 0 ${width} ${ROW_HEIGHT}`, preserveAspectRatio: "none", "aria-hidden": true });
	for (const { from, to, tone, kind, uncommitted: dirty } of row.links) {
		const x = laneX(from), end = laneX(to);
		const startY = kind === "out" ? half : 0, endY = kind === "in" ? half : ROW_HEIGHT;
		const d = x === end ? `M${x} ${startY}V${endY}`
			: angular ? `M${x} ${startY}L${end} ${endY - 3}V${endY}`
				: `M${x} ${startY}C${x} ${startY + 9} ${end} ${endY - 8} ${end} ${endY}`;
		if (x !== end) svg.append(svgNode("path", { class: "lane-shadow", d }));
		svg.append(svgNode("path", { d, stroke: dirty ? "var(--muted)" : colors[tone % colors.length] }));
	}
	const cx = laneX(row.lane), color = uncommitted ? "var(--muted)" : colors[row.tone % colors.length];
	const outline = current || stash || uncommitted;
	const shape = row.root && !stash && !uncommitted
		? svgNode("rect", { x: cx - 3.5, y: half - 3.5, width: 7, height: 7, rx: 1 })
		: svgNode("circle", { cx, cy: half, r: outline ? 4 : 3.5 });
	shape.setAttribute("fill", outline ? "var(--bg)" : color);
	shape.setAttribute("stroke", outline ? color : "var(--bg)");
	shape.setAttribute("stroke-width", outline ? "2" : "1");
	svg.append(shape);
	if (stash) svg.append(svgNode("circle", { cx, cy: half, r: 1.5, fill: color }));
	return svg;
}

export function extendLanes(exits, colors) {
	return exits.map(({ column, tone, uncommitted }) => {
		const line = document.createElement("span");
		line.className = "lane-extension";
		line.style.left = `${laneX(column) - 1}px`;
		line.style.backgroundColor = uncommitted ? "var(--muted)" : colors[tone % colors.length];
		return line;
	});
}

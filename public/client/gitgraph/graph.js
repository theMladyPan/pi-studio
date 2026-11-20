/** Place commits into lanes by tracing each branch as one chain, the way Libre lays a graph out.
 *
 * A branch is followed parent by parent until the walk reaches a commit another branch already owns.
 * Commits the walk only passes are handed a neighbouring column of their own, so no branch has to
 * cross another to reach its parent. A branch keeps one colour for its whole length, and that colour
 * is handed out again only once the branch has ended, so two branches alive at once never share one.
 * A merge already sitting on one branch joins the branch its second parent sits on, which is what
 * keeps forks and joins from tangling the way a per-row lane fill does.
 */

class Vertex { // One commit, and the place its lines may be drawn.
	constructor(commit, y) {
		this.hash = commit.hash;
		this.y = y;
		this.x = 0;
		this.parents = []; // Vertices, or null where the parent is beyond these rows.
		this.nextParent = 0;
		this.hasUndrawnParent = false;
		this.onBranch = null;
		this.isCommitted = commit.hash !== "*";
		this.nextX = 0;
		this.connections = new Map(); // Column -> { connectsTo, onBranch }
	}

	addParent(vertex) { this.parents.push(vertex); }
	addParentBeyondPage() { this.parents.push(null); }
	hasPendingParents() { return this.nextParent < this.parents.length; }
	getNextParent() { return this.nextParent < this.parents.length ? this.parents[this.nextParent] : null; }
	registerParentProcessed() { this.nextParent += 1; }
	isMerge() { return this.parents.length > 1; }

	addToBranch(branch, x) {
		if (this.onBranch === null) { this.onBranch = branch; this.x = x; }
	}
	isNotOnBranch() { return this.onBranch === null; }
	getPoint() { return { x: this.x, y: this.y }; }
	getNextPoint() { return { x: this.nextX, y: this.y }; }

	getPointConnectingTo(target, branch) {
		for (const [x, connection] of this.connections) {
			if (connection.connectsTo === target && connection.onBranch === branch) return { x, y: this.y };
		}
		return null;
	}

	registerUnavailablePoint(x, connectsTo, branch) {
		if (x === this.nextX) {
			this.nextX = x + 1;
			this.connections.set(x, { connectsTo, onBranch: branch });
		}
	}
}

class Branch { // One chain of lines, all of one colour.
	constructor(color) {
		this.color = color;
		this.lines = [];
		this.end = 0;
	}

	addLine(p1, p2, uncommitted, lockedFirst, startIsDot, endIsDot) {
		this.lines.push({ p1, p2, uncommitted, lockedFirst, startIsDot, endIsDot });
	}
}

function linkVertices(vertices, commits, positions, mode) {
	for (const [index, commit] of commits.entries()) {
		const vertex = vertices[index];
		for (const [order, parent] of commit.parentHashes.entries()) {
			const at = positions.get(parent);
			if (typeof at === "number" && at > index) vertex.addParent(vertices[at]);
			else if (parent === "") { /* a root's padding, not a parent */ }
			// A parent the walk has already passed cannot be joined by a line going down.
			else if (typeof at === "number") vertex.hasUndrawnParent = true;
			else if (mode === "all" || (mode === "first" && order === 0)) vertex.addParentBeyondPage();
			else vertex.hasUndrawnParent = true;
		}
	}
}

class Layout {
	constructor(vertices) {
		this.vertices = vertices;
		this.branches = [];
		this.availableColors = []; // Colour -> the row its last branch ended.
	}

	run() {
		let start = this.findStart();
		while (start !== -1) {
			this.determinePath(start);
			start = this.findStart();
		}
	}

	findStart() {
		for (let index = 0; index < this.vertices.length; index += 1) {
			const vertex = this.vertices[index];
			if (vertex.hasPendingParents() || vertex.isNotOnBranch()) return index;
		}
		return -1;
	}

	determinePath(index) {
		const vertex = this.vertices[index];
		const parent = vertex.getNextParent();
		if (parent !== null && vertex.isMerge() && !vertex.isNotOnBranch() && !parent.isNotOnBranch()) {
			this.determineMergePath(index, vertex, parent);
		} else {
			this.determineNormalPath(index, vertex, parent);
		}
	}

	determineMergePath(index, vertex, parent) {
		const branch = parent.onBranch;
		if (branch === null) throw new Error("Expected merge parent to be on a branch");
		let point = vertex.isNotOnBranch() ? vertex.getNextPoint() : vertex.getPoint();
		let pointIsDot = !vertex.isNotOnBranch();
		let landed = false;
		for (let at = index + 1; at < this.vertices.length; at += 1) {
			const other = this.vertices[at];
			const connecting = other.getPointConnectingTo(parent, branch);
			const end = connecting ?? other.getNextPoint();
			const endIsDot = at === parent.y && connecting !== null;
			landed = landed || connecting !== null;
			// Locked until the line lands on its branch: go down first, then across.
			const locked = !landed && other !== parent ? point.x < end.x : true;
			branch.addLine(point, end, !vertex.isCommitted, locked, pointIsDot, endIsDot);
			other.registerUnavailablePoint(end.x, parent, branch);
			point = end;
			pointIsDot = endIsDot;
			if (landed) {
				vertex.registerParentProcessed();
				break;
			}
		}
	}

	determineNormalPath(index, vertex, parent) {
		let current = vertex;
		let target = parent;
		let point = current.isNotOnBranch() ? current.getNextPoint() : current.getPoint();
		let pointIsDot = true;
		const branch = new Branch(this.getAvailableColor(index));
		current.addToBranch(branch, point.x);
		current.registerUnavailablePoint(point.x, current, branch);
		let at = index + 1;
		while (current.hasPendingParents() && at < this.vertices.length) {
			const other = this.vertices[at];
			const reached = target === other;
			// A parent the walk reaches on its own branch is drawn at its own point; every other
			// commit, reached or only passed, is drawn in a column of its own, to the side.
			const end = reached && !other.isNotOnBranch() ? other.getPoint() : other.getNextPoint();
			const endIsDot = reached;
			branch.addLine(point, end, !current.isCommitted, point.x < end.x, pointIsDot, endIsDot);
			other.registerUnavailablePoint(end.x, target, branch);
			point = end;
			pointIsDot = endIsDot;
			if (reached) {
				current.registerParentProcessed();
				const wasOnBranch = !target.isNotOnBranch();
				target.addToBranch(branch, end.x);
				current = target;
				target = current.getNextParent();
				if (wasOnBranch || !current.hasPendingParents()) break;
			}
			at += 1;
		}
		if (at === this.vertices.length && current.hasPendingParents() && target === null) {
			// The branch runs off the bottom of these rows: draw it to the row below.
			let end = { x: point.x, y: this.vertices.length };
			if (index === this.vertices.length - 1 && current.onBranch !== branch) {
				end = { x: current.getNextPoint().x, y: this.vertices.length };
				current.registerUnavailablePoint(end.x, null, branch);
			}
			branch.addLine(point, end, !current.isCommitted, true, pointIsDot, false);
			current.registerParentProcessed();
		}
		branch.end = at;
		this.branches.push(branch);
		this.availableColors[branch.color] = at;
	}

	getAvailableColor(index) {
		for (let color = 0; color < this.availableColors.length; color += 1) {
			if (index > this.availableColors[color]) return color;
		}
		this.availableColors.push(0);
		return this.availableColors.length - 1;
	}

	// Turn the traced branches into the rows the page draws: one link per row a line crosses, the
	// lanes still open at each row's bottom edge, and the column each commit's dot sits in.
	toRows() {
		const count = this.vertices.length;
		const rows = this.vertices.map((vertex) => ({
			lane: vertex.x,
			tone: vertex.onBranch !== null ? vertex.onBranch.color : 0,
			links: [],
			root: vertex.parents.length === 0 && !vertex.hasUndrawnParent,
			exits: [],
		}));
		let width = 1;
		for (const vertex of this.vertices) width = Math.max(width, vertex.nextX);

		const exitsOf = rows.map(() => new Map()); // Row -> column -> exit
		for (const branch of this.branches) {
			for (const line of branch.lines) {
				const { p1, p2 } = line;
				const span = p2.y - p1.y;
				const columnAt = (boundary) => Math.round(p1.x + (p2.x - p1.x) * (boundary - p1.y) / span);
				for (let boundary = p1.y + 1; boundary <= p2.y; boundary += 1) {
					if (boundary - 1 >= count) continue;
					// A column two lines cross at the same edge keeps the line that goes on past it.
					const column = columnAt(boundary);
					const exits = exitsOf[boundary - 1];
					if (!exits.has(column) || p2.y > boundary) {
						exits.set(column, { column, tone: branch.color, uncommitted: line.uncommitted });
					}
				}
				if (line.startIsDot) {
					rows[p1.y].links.push({ from: p1.x, to: columnAt(p1.y + 1), tone: branch.color, kind: "out", uncommitted: line.uncommitted, locked: line.lockedFirst });
				}
				for (let row = p1.y; row < p2.y; row += 1) {
					if (row === p1.y && line.startIsDot) continue;
					rows[row].links.push({ from: columnAt(row), to: columnAt(row + 1), tone: branch.color, kind: "pass", uncommitted: line.uncommitted, locked: line.lockedFirst });
				}
				if (line.endIsDot && p2.y < count) {
					rows[p2.y].links.push({ from: p2.x, to: p2.x, tone: branch.color, kind: "in", uncommitted: line.uncommitted, locked: line.lockedFirst });
				}
			}
		}
		for (const [index, exits] of exitsOf.entries()) rows[index].exits = [...exits.values()];
		return { rows, width };
	}
}

export function layoutGraph(commits, { more = false, firstParentOnly = false } = {}) {
	const positions = new Map(commits.map((commit, i) => [commit.hash, i]));
	const vertices = commits.map((commit, i) => new Vertex(commit, i));
	// With only the first parent followed, a second parent the walk cannot return leaves no lane.
	const mode = !more ? "none" : "all";
	linkVertices(vertices, commits, positions, mode);
	const layout = new Layout(vertices);
	// firstParentOnly trims each commit to the parent the line follows before anything is linked.
	if (firstParentOnly) {
		for (const [index, commit] of commits.entries()) {
			vertices[index].parents = vertices[index].parents.slice(0, 1);
			vertices[index].nextParent = 0;
		}
	}
	layout.run();
	return layout.toRows();
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
	for (const { from, to, tone, kind, locked, uncommitted: dirty } of row.links) {
		const x = laneX(from), end = laneX(to);
		const startY = kind === "out" ? half : 0, endY = kind === "in" ? half : ROW_HEIGHT;
		// The bend spans most of the piece: vertical at each end, across in the middle.
		const span = endY - startY;
		const round = (value) => Math.round(value * 10) / 10;
		const d = x === end ? `M${x} ${startY}V${endY}`
			: angular ? (locked
				? `M${x} ${startY}L${end} ${round(endY - span * 0.38)}V${endY}`
				: `M${x} ${startY}V${round(startY + span * 0.38)}L${end} ${endY}`)
			: `M${x} ${startY}C${x} ${round(startY + span * 0.8)} ${end} ${round(endY - span * 0.8)} ${end} ${endY}`;
		if (x !== end) svg.append(svgNode("path", { class: "lane-shadow", d }));
		svg.append(svgNode("path", { d, stroke: dirty ? "var(--muted)" : colors[tone % colors.length] }));
	}
	const cx = laneX(row.lane), color = uncommitted ? "var(--muted)" : colors[row.tone % colors.length];
	const outline = current || stash || uncommitted;
	const shape = row.root && !stash && !uncommitted
		? svgNode("rect", { x: cx - 4, y: half - 4, width: 8, height: 8, rx: 1 })
		: svgNode("circle", { cx, cy: half, r: outline ? 4 : 4 });
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

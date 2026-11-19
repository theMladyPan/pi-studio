// The history view: rows a line high with real lanes, the refs beside each commit, and a details pane
// with the files a commit changed and the patch of the one that was picked.
//
// Everything this page knows comes from the host, over the one channel the host opens: it sends a hello
// with a nonce and this plugin's name, this page asks for a method with that nonce, and the answers come
// back with the same nonce. There is no token, no cookie and no request to the daemon from here: a view
// that could fetch on its own would be a second door into the board, and the host already has one.
//
// The lanes are drawn from the geometry the plugin computes: each row says which column its commit sits
// in, whether a line reaches it from above, and where the lines of other lanes pass or bend. Numbers
// only, so nothing the repository contains can become markup here.
(() => {
	"use strict";

	const PLUGIN = "git-history";
	const ROW_HEIGHT = 24;
	const COLUMN_WIDTH = 14;
	const PAGE_LIMIT = 40;
	const LANE_COLORS = ["#3f6ddb", "#c2570f", "#1f8a5f", "#8b3fb0", "#b03030", "#1d7f9c", "#8a7a16", "#5d6068"];

	/** The state the view draws from. Only ever replaced by an answer from the plugin. */
	const state = {
		host: false,
		workspace: "",
		summary: null,
		page: null,
		rows: [],
		laneCount: 1,
		selected: "",
		detail: null,
		pickedFile: "",
		diff: null,
		busy: false,
		failure: "",
	};

	// ---------- the host bridge ----------

	/** The one channel to the host: its nonce, the window to answer, and the calls still waiting. */
	const bridge = {
		nonce: "",
		target: null,
		origin: "*",
		nextId: 0,
		waiting: new Map(),
	};

	/** post sends one message to the host, which is the only place this page talks to. */
	function post(message) {
		if (!bridge.target) return;
		bridge.target.postMessage(message, bridge.origin);
	}

	/**
	 * request asks the plugin one thing through the host. The host forwards `{ workspace, method, params }`
	 * as a `visual.request`; this page never names the workspace itself, the host already knows it.
	 */
	function request(method, params) {
		if (!bridge.host) return Promise.reject(new Error("no host is connected"));
		const id = (bridge.nextId += 1);
		const message = { type: "pi-plugin:request", plugin: PLUGIN, nonce: bridge.nonce, id, method, params: params || {} };
		return new Promise((resolve, reject) => {
			bridge.waiting.set(id, { resolve, reject });
			post(message);
		});
	}

	/** settle hands one answer from the host to the call waiting for it. */
	function settle(id, result, error) {
		const waiter = bridge.waiting.get(id);
		if (!waiter) return;
		bridge.waiting.delete(id);
		if (error) waiter.reject(new Error(error.message || "the plugin refused the call"));
		else waiter.resolve(result);
	}

	window.addEventListener("message", (event) => {
		const data = event.data;
		if (!data || typeof data !== "object" || data.plugin !== PLUGIN) return;
		if (data.type === "pi-plugin:hello") {
			if (typeof data.nonce !== "string" || data.nonce === "") return;
			bridge.nonce = data.nonce;
			bridge.target = event.source;
			bridge.origin = event.origin || "*";
			bridge.host = true;
			if (typeof data.workspace === "string") state.workspace = data.workspace;
			load();
			return;
		}
		// Everything else must carry the nonce this page was given, or it is not an answer to this page.
		if (!bridge.nonce || data.nonce !== bridge.nonce) return;
		if (data.type === "pi-plugin:result") settle(data.id, data.result, null);
		if (data.type === "pi-plugin:error") settle(data.id, null, data.error || { message: "the plugin refused the call" });
	});

	// ---------- reading ----------

	/** load reads the header and the first page again, which is what a refresh does. */
	async function load() {
		state.busy = true;
		state.failure = "";
		renderNotice();
		try {
			const [summary] = await Promise.all([request("summary", {}), readPage(0)]);
			state.summary = summary;
		} catch (error) {
			state.failure = error.message;
		} finally {
			state.busy = false;
			renderAll();
		}
	}

	/** readPage reads one page of rows and keeps it as the page on screen. */
	async function readPage(offset) {
		const answer = await request("history", { offset, limit: PAGE_LIMIT });
		state.rows = Array.isArray(answer.rows) ? answer.rows : [];
		state.laneCount = Math.max(1, answer.laneCount || 1);
		state.page = answer.page || null;
		state.summary = state.summary || { repo: answer.repo };
		state.failure = (answer.notes && answer.notes[0]) || "";
		return answer;
	}

	/** openRow reads one commit and the patch of its first file. */
	async function openRow(sha) {
		state.selected = sha;
		state.detail = null;
		state.pickedFile = "";
		state.diff = null;
		renderRows();
		renderDetail();
		try {
			const detail = await request("commit", { sha });
			if (state.selected !== sha) return;
			state.detail = detail;
			renderDetail();
			const first = Array.isArray(detail.files) && detail.files.length ? detail.files[0].path : "";
			if (first) await openFile(detail.sha, first);
		} catch (error) {
			state.failure = error.message;
			renderNotice();
		}
	}

	/** openFile reads the patch of one file in the open commit. */
	async function openFile(sha, path) {
		state.pickedFile = path;
		state.diff = null;
		renderFiles();
		renderPatch();
		try {
			const diff = await request("diff", { sha, path, context: 3 });
			if (state.pickedFile !== path) return;
			state.diff = diff;
			renderPatch();
		} catch (error) {
			state.diff = { path, patch: "", error: error.message };
			renderPatch();
		}
	}

	// ---------- drawing ----------

	const el = {
		title: document.getElementById("title"),
		where: document.getElementById("where"),
		counts: document.getElementById("counts"),
		notice: document.getElementById("notice"),
		rows: document.getElementById("rows"),
		range: document.getElementById("range"),
		refresh: document.getElementById("refresh"),
		newest: document.getElementById("newest"),
		newer: document.getElementById("newer"),
		older: document.getElementById("older"),
		detail: document.getElementById("detail"),
		detailSubject: document.getElementById("detail-subject"),
		detailMeta: document.getElementById("detail-meta"),
		detailNote: document.getElementById("detail-note"),
		detailClose: document.getElementById("detail-close"),
		files: document.getElementById("files"),
		patch: document.getElementById("patch"),
	};

	function renderAll() {
		renderHeader();
		renderRows();
		renderPage();
		renderDetail();
		renderNotice();
	}

	/** renderHeader is the bar: which workspace, where HEAD is, and how much is in it. */
	function renderHeader() {
		const summary = state.summary;
		const repo = summary && summary.repo ? summary.repo : null;
		el.title.textContent = summary && summary.workspace && summary.workspace.name ? summary.workspace.name : "git history";
		if (!repo) {
			el.where.textContent = bridge.host ? "" : "waiting for the host";
			el.counts.textContent = "";
			return;
		}
		if (repo.unborn) el.where.textContent = `no commits yet · ${repo.branch || "unborn"}`;
		else if (repo.detached) el.where.textContent = `detached at ${repo.short}`;
		else el.where.textContent = `${repo.branch || "HEAD"} · ${repo.short}`;
		el.counts.textContent = `${repo.branches} branch${repo.branches === 1 ? "" : "es"} · ${repo.tags} tag${repo.tags === 1 ? "" : "s"}`;
		el.refresh.disabled = state.busy;
	}

	function renderNotice() {
		if (!state.failure) {
			el.notice.hidden = true;
			el.notice.textContent = "";
			return;
		}
		el.notice.hidden = false;
		el.notice.textContent = state.failure;
	}

	/** renderRows draws one line per commit, with the lanes and the labels beside it. */
	function renderRows() {
		const gutter = state.laneCount * COLUMN_WIDTH + 6;
		el.rows.style.setProperty("--gutter", `${gutter}px`);
		el.rows.textContent = "";
		if (!state.rows.length) {
			const empty = document.createElement("p");
			empty.className = "notice";
			empty.textContent = state.summary && state.summary.repo && state.summary.repo.unborn ? "this workspace has no commits yet" : "no commits to draw";
			el.rows.append(empty);
			return;
		}
		const fragment = document.createDocumentFragment();
		for (const row of state.rows) {
			fragment.append(buildRow(row, gutter));
		}
		el.rows.append(fragment);
	}

	/** buildRow is one commit line: its lanes, its sha, its labels, its subject, its author and its age. */
	function buildRow(row, gutter) {
		const line = document.createElement("button");
		line.type = "button";
		line.className = row.head ? "row head" : "row";
		line.dataset.sha = row.sha;
		line.setAttribute("role", "option");
		line.setAttribute("aria-selected", String(state.selected === row.sha));
		if (row.head) line.setAttribute("aria-label", `${row.short} ${row.subject} (HEAD)`);

		const lane = document.createElement("span");
		lane.className = "gutter";
		lane.append(lanePicture(row, gutter));
		line.append(lane);

		const sha = document.createElement("span");
		sha.className = "sha";
		sha.textContent = row.short;
		sha.title = row.sha;
		line.append(sha);

		const refs = document.createElement("span");
		refs.className = "refs";
		for (const label of row.refs || []) {
			const pill = document.createElement("span");
			pill.className = `ref ${label.kind}`;
			pill.textContent = label.name;
			pill.title = `${label.kind} ${label.name}`;
			refs.append(pill);
		}
		line.append(refs);

		const subject = document.createElement("span");
		subject.className = "subject";
		subject.textContent = row.subject;
		subject.title = row.subject;
		line.append(subject);

		const author = document.createElement("span");
		author.className = "author";
		author.textContent = row.author;
		author.title = `${row.author} <${row.email}>`;
		line.append(author);

		const when = document.createElement("span");
		when.className = "when";
		when.textContent = age(row.at);
		when.title = new Date(row.at * 1000).toLocaleString();
		line.append(when);

		line.addEventListener("click", () => {
			if (state.selected === row.sha) {
				closeDetail();
				return;
			}
			void openRow(row.sha);
		});
		return line;
	}

	/**
	 * lanePicture draws the lines of one row in a viewBox one row high, so consecutive rows meet exactly.
	 * A passing lane is a straight line, one bending into the commit is a curve down to the dot, and one
	 * forking away is a curve from the dot to the lane it opens below.
	 */
	function lanePicture(row, width) {
		const ns = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(ns, "svg");
		svg.setAttribute("width", String(width));
		svg.setAttribute("height", String(ROW_HEIGHT));
		svg.setAttribute("viewBox", `0 0 ${width} ${ROW_HEIGHT}`);
		svg.setAttribute("aria-hidden", "true");
		const middle = ROW_HEIGHT / 2;
		const x = (column) => COLUMN_WIDTH / 2 + column * COLUMN_WIDTH;

		const curve = (fromX, fromY, toX, toY) => {
			const bend = Math.abs(toY - fromY) / 2;
			return `M${fromX} ${fromY}C${fromX} ${fromY + bend},${toX} ${toY - bend},${toX} ${toY}`;
		};

		if (row.up) svg.append(path(ns, `M${x(row.lane)} 0L${x(row.lane)} ${middle}`, LANE_COLORS[row.lane % LANE_COLORS.length], 2));
		if (!row.root) svg.append(path(ns, `M${x(row.lane)} ${middle}L${x(row.lane)} ${ROW_HEIGHT}`, LANE_COLORS[row.lane % LANE_COLORS.length], 2));

		for (const edge of row.edges || []) {
			const colour = LANE_COLORS[Math.max(edge.from, edge.to) % LANE_COLORS.length];
			if (edge.kind === "pass") svg.append(path(ns, `M${x(edge.from)} 0L${x(edge.to)} ${ROW_HEIGHT}`, LANE_COLORS[edge.from % LANE_COLORS.length], 2));
			if (edge.kind === "merge") svg.append(path(ns, curve(x(edge.from), 0, x(edge.to), middle), colour, 2));
			if (edge.kind === "fork") svg.append(path(ns, curve(x(edge.from), middle, x(edge.to), ROW_HEIGHT), colour, 2));
		}

		const dot = document.createElementNS(ns, "circle");
		dot.setAttribute("cx", String(x(row.lane)));
		dot.setAttribute("cy", String(middle));
		dot.setAttribute("r", row.head ? "4.5" : "3.5");
		dot.setAttribute("fill", LANE_COLORS[row.lane % LANE_COLORS.length]);
		dot.setAttribute("stroke", row.head ? "var(--ink)" : "transparent");
		dot.setAttribute("stroke-width", "1.5");
		svg.append(dot);
		return svg;
	}

	function path(ns, d, colour, width) {
		const line = document.createElementNS(ns, "path");
		line.setAttribute("d", d);
		line.setAttribute("fill", "none");
		line.setAttribute("stroke", colour);
		line.setAttribute("stroke-width", String(width));
		line.setAttribute("stroke-linecap", "round");
		return line;
	}

	/** renderPage says which rows are on screen and offers the pages either side of them. */
	function renderPage() {
		const page = state.page;
		if (!page || !state.rows.length) {
			el.range.textContent = page && page.total ? `0 of ${page.total}` : "";
			el.newer.disabled = true;
			el.older.disabled = true;
			el.newest.disabled = true;
			return;
		}
		const first = page.offset + 1;
		const last = page.offset + state.rows.length;
		el.range.textContent = page.total ? `${first}–${last} of ${page.total}` : `${first}–${last}`;
		el.newer.disabled = page.offset === 0;
		el.older.disabled = !page.hasMore;
		el.newest.disabled = page.offset === 0;
	}

	/** renderDetail shows the open commit, and hides the pane when nothing is picked. */
	function renderDetail() {
		const detail = state.detail;
		el.detail.hidden = !state.selected || (!detail && !state.busy);
		if (!state.selected) return;
		el.detailSubject.textContent = detail ? detail.subject : state.selected;
		const meta = [];
		if (detail) {
			meta.push(detail.short);
			meta.push(`${detail.author} <${detail.email}>`);
			meta.push(new Date(detail.at * 1000).toLocaleString());
			if (detail.parents.length) meta.push(`${detail.parents.length} parent${detail.parents.length === 1 ? "" : "s"}`);
			if (detail.head) meta.push("HEAD");
		}
		el.detailMeta.textContent = meta.join(" · ");
		el.detailNote.hidden = !(detail && detail.note);
		el.detailNote.textContent = detail && detail.note ? detail.note : "";
		renderFiles();
		renderPatch();
	}

	/** renderFiles lists what the commit changed, each file a button that opens its patch. */
	function renderFiles() {
		el.files.textContent = "";
		const detail = state.detail;
		if (!detail) return;
		if (!detail.files.length) {
			const empty = document.createElement("li");
			empty.className = "note";
			empty.textContent = detail.merge ? "this merge changed no file against its first parent" : "this commit changed no file";
			el.files.append(empty);
			return;
		}
		const statusWords = { A: "added", M: "changed", D: "deleted", T: "type changed", R: "renamed", C: "copied" };
		for (const file of detail.files) {
			const item = document.createElement("li");
			const button = document.createElement("button");
			button.type = "button";
			button.setAttribute("aria-current", String(state.pickedFile === file.path));
			const status = document.createElement("span");
			status.className = `status ${file.status}`;
			status.textContent = file.status;
			status.title = statusWords[file.status] || "changed";
			const name = document.createElement("span");
			name.className = "path";
			name.textContent = file.path;
			button.append(status, name);
			button.addEventListener("click", () => {
				if (detail.sha) void openFile(detail.sha, file.path);
			});
			item.append(button);
			el.files.append(item);
		}
	}

	/** renderPatch draws the picked file's patch, one line at a time, with git's own + and - kept. */
	function renderPatch() {
		el.patch.textContent = "";
		const diff = state.diff;
		if (!diff) return;
		const note = (text) => {
			const line = document.createElement("div");
			line.className = "note";
			line.textContent = text;
			el.patch.append(line);
		};
		if (diff.error) {
			note(diff.error);
			return;
		}
		const counts = `+${diff.added} −${diff.removed}`;
		if (diff.binary) note(`${diff.path} is a binary file · ${counts}`);
		if (diff.truncated) note("this patch was cut at the plugin's output budget");
		if (!diff.patch) {
			note(`${diff.path} has no patch against the parent this commit is read against`);
			return;
		}
		const fragment = document.createDocumentFragment();
		for (const text of diff.patch.split("\n")) {
			if (text === "") continue;
			const line = document.createElement("div");
			let kind = "";
			if (text.startsWith("+++") || text.startsWith("---") || text.startsWith("@@") || text.startsWith("diff ") || text.startsWith("index ")) kind = "meta";
			else if (text.startsWith("+")) kind = "add";
			else if (text.startsWith("-")) kind = "del";
			line.className = kind ? `line ${kind}` : "line";
			line.textContent = text;
			fragment.append(line);
		}
		el.patch.append(fragment);
	}

	/** closeDetail puts the details pane away and clears the selection. */
	function closeDetail() {
		state.selected = "";
		state.detail = null;
		state.diff = null;
		state.pickedFile = "";
		renderRows();
		renderDetail();
	}

	/** age is a commit's date in the words a person reads at a glance. */
	function age(seconds) {
		const then = seconds * 1000;
		const minutes = Math.round((Date.now() - then) / 60000);
		if (minutes < 1) return "now";
		if (minutes < 60) return `${minutes}m`;
		const hours = Math.round(minutes / 60);
		if (hours < 24) return `${hours}h`;
		const days = Math.round(hours / 24);
		if (days < 30) return `${days}d`;
		const months = Math.round(days / 30);
		if (months < 12) return `${months}mo`;
		return `${Math.round(months / 12)}y`;
	}

	// ---------- moving around ----------

	function moveSelection(step) {
		if (!state.rows.length) return;
		const now = state.rows.findIndex((row) => row.sha === state.selected);
		const next = Math.min(state.rows.length - 1, Math.max(0, (now === -1 ? 0 : now + step)));
		const row = state.rows[next];
		if (!row) return;
		void openRow(row.sha);
		const drawn = el.rows.querySelector(`[data-sha="${row.sha}"]`);
		if (drawn) drawn.scrollIntoView({ block: "nearest" });
	}

	async function goPage(offset) {
		state.busy = true;
		renderHeader();
		try {
			await readPage(offset);
		} catch (error) {
			state.failure = error.message;
		} finally {
			state.busy = false;
			renderHeader();
			renderRows();
			renderPage();
			renderNotice();
			el.rows.scrollTop = 0;
		}
	}

	el.rows.addEventListener("keydown", (event) => {
		if (event.key === "ArrowDown" || event.key === "j") {
			event.preventDefault();
			moveSelection(1);
		}
		if (event.key === "ArrowUp" || event.key === "k") {
			event.preventDefault();
			moveSelection(-1);
		}
		if (event.key === "Escape") closeDetail();
	});
	el.detailClose.addEventListener("click", closeDetail);
	el.refresh.addEventListener("click", () => void load());
	el.newest.addEventListener("click", () => void goPage(0));
	el.newer.addEventListener("click", () => void goPage(Math.max(0, (state.page ? state.page.offset : 0) - PAGE_LIMIT)));
	el.older.addEventListener("click", () => {
		const page = state.page;
		if (page && page.next !== null && page.next !== undefined) void goPage(page.next);
	});

	// ---------- first paint ----------

	renderAll();
	if (!bridge.host) {
		state.failure = "waiting for the host to say hello";
		renderNotice();
	}
})();

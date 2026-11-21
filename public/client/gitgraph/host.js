import { $, btn, compareOrder, elt, filterBox, menuOn, modal, repoLabel, short, showError, showMenu, splitRemote, dateOf } from "./dom.js";
import { checkoutRef, commitMenu, fetchFrom, item, pushAllTags, refMenu, stashMenu, uncommittedMenu } from "./actions.js";
import { drawLanes, extendLanes, graphWidth, layoutGraph } from "./graph.js";
import { detailPanel } from "./details.js";
import { drawSettings } from "./settings.js";
import { showView } from "./viewer.js";

const workspace = /^\/git\/([a-f0-9]{6,64})\/?$/.exec(location.pathname)?.[1];
const framed = window.parent !== window;
const storagePrefix = "pi-studio.gitgraph";
const cacheKey = `${storagePrefix}.v2.${workspace}`;
const filterKeys = ["branches", "authors", "tags"];
const columns = ["graph", "description", "date", "author", "commit", "signature"];
const adjustable = columns.filter((key) => key !== "description");
const defaultWidths = [64, 145, 128, 84, 82];
const orderOf = (settings) => Object.hasOwn(compareOrder, settings.commitOrdering) ? settings.commitOrdering : "date";
const checked = (node, val) => { node.checked = Boolean(val); };
const emptyInfo = { authors: [], tags: [], remotes: [], stashes: [] };

function readCache(key) {
	try { return JSON.parse(localStorage.getItem(key)) ?? {}; } catch { return {}; }
}
const cache = readCache(cacheKey);
const legacy = Object.keys(cache).length ? {} : readCache(`${storagePrefix}.v1.${workspace}`);
const prefs = cache.prefs && typeof cache.prefs === "object" ? cache.prefs : {};
const hiddenColumns = new Set((Array.isArray(cache.hiddenColumns) ? cache.hiddenColumns
	: Array.isArray(legacy.hiddenColumns) ? legacy.hiddenColumns : ["signature"]).filter((key) => columns.slice(2).includes(key)));
const remembered = { ...cache.repositories };
if (legacy.currentRepo) {
	remembered[legacy.currentRepo] = { filters: {
		branches: legacy.currentBranches || (legacy.currentBranch ? [legacy.currentBranch] : []), authors: legacy.currentAuthors, tags: legacy.currentTags,
	}, expanded: legacy.expandedCommit?.hash, count: legacy.maxCommits };
}

let config = null;
let repos = {};
let repo = "";
let filters = {};
let info = emptyInfo;
let branches = [];
let branchHead = null;
let worktrees = [];
let upstreams = {};
let rows = [];
let layout = { rows: [], width: 1 };
let rowNodes = new Map();
let head = null;
let count = 250;
let more = false;
let expanded = null;
let selected = new Set();
let anchor = null;
let generation = 0;
let viewGeneration = 0;
let busy = false;
let loading = false;
let lastLoaded = 0;
let matches = [];
let matchIndex = -1;
let revealedNode = null;
let selectionSave = Promise.resolve();

function store() {
	if (repo) remembered[repo] = { filters, count, expanded: expanded && !expanded.comparison ? expanded.hash : null };
	try { localStorage.setItem(cacheKey, JSON.stringify({ repositories: remembered, prefs, hiddenColumns: [...hiddenColumns] })); } catch {}
}

async function json(path, init) {
	const res = await fetch(`${path}?workspace=${encodeURIComponent(workspace)}`, {
		credentials: "same-origin", ...init,
	});
	if (res.status === 403) throw new Error("This tab is not signed in. Open Git Graph from your board.");
	const data = await res.json();
	if (!res.ok) throw new Error(data.error || data.message || `The daemon answered ${res.status}.`);
	return data;
}

async function request(command, fields = {}) {
	const answers = await json("/git/msg", {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command, ...fields }),
	});
	const reply = answers.find((message) => message.command === command) ?? {};
	if (reply.error) return fail(reply.error.message || reply.error, command, fields);
	if (typeof reply.status === "string") return fail(reply.status, command, fields);
	return reply;
}

function fail(message, command, fields) {
	const error = new Error(message);
	// The dialog shows git's words first, then asks the helper once beside them.
	errno.gitCommand = command;
	errno.gitRepo = fields?.repo ?? null;
	errno.gitDetails = message;
	throw error;
}

function status(message, state = "ready") {
	$("statusText").textContent = message;
	$("statusStrip").dataset.state = state;
	$("statusStrip").setAttribute("aria-busy", String(state === "loading" || state === "action"));
}

function notice(title, detail) {
	$("topBar").hidden = true;
	$("commitGraph").hidden = true;
	$("footer").replaceChildren();
	$("ggNoticeTitle").textContent = title;
	$("ggNoticeDetail").textContent = detail;
	$("ggNotice").hidden = false;
}

function setting(key, settings = repos[repo] || {}) {
	return settings[key] === "enabled" || (settings[key] !== "disabled" && Boolean(config[key]));
}

function withFilters() {
	return {
		branches: filters.branches, authors: filters.authors, tags: filters.tags,
		showRemoteBranches: setting("showRemoteBranches"), hiddenRemotes: repos[repo]?.hiddenRemotes ?? [], showTags: true,
	};
}

function ctx() {
	const here = repo;
	const expectRepo = () => { if (repo !== here) throw new Error("The selected repository changed. Open the action again."); };
	const read = async (command, fields = {}) => {
		expectRepo();
		const reply = await request(command, { repo: here, ...fields });
		expectRepo();
		return reply;
	};
	const remoteNames = info.remotes.map((remote) => remote.name);
	const remoteBranches = remoteNames.map((remote) => `${remote}/`);
	return { repo: here, config, info, branches, branchHead, head, worktrees, upstreams, settings: repos[repo] ?? {},
		localBranches: new Set(branches.filter((name) => (Object.hasOwn(upstreams, name) || !remoteBranches.some((remote) => name.startsWith(remote))) && !name.startsWith("remotes/"))),
		hasRepo: (path) => Object.hasOwn(repos, path), switchRepo,
		read, fail: showError,
		compare: (hash, base, other, baseLabel, otherLabel) => { expectRepo(); return expand(hash, { base, other, baseLabel, otherLabel }); },
		closeDetail: () => closeDetail(true),
		view: async (command, fields) => {
			const id = ++viewGeneration;
			const reply = await read(command, fields);
			if (id !== viewGeneration) return;
			if (!reply.view) throw new Error("Git could not open that file or diff.");
			showView(reply.view);
		},
		write: async (command, fields = {}, after = null, label) => {
			expectRepo();
			if (busy) throw new Error("A Git action is already running in this view.");
			const labelText = label.replace(/[.?!…]+$/, "") + "…";
			busy = true;
			status(labelText, "action");
			let failure = null;
			try {
				await read(command, fields);
				if (after) await read(...after);
			} catch (error) {
				failure = error;
			} finally {
				busy = false;
				await refresh();
			}
			if (failure) throw failure;
		},
	};
}

function aboutRepo(active) {
	const saved = remembered[active] ?? {};
	return {
		filters: Object.fromEntries(filterKeys.map((key) => [key, Array.isArray(saved.filters?.[key]) ? saved.filters[key].filter((v) => typeof v === "string" && v !== "") : []])),
		count: Number.isSafeInteger(saved.count) && saved.count >= config.initialLoadCommits ? saved.count : config.initialLoadCommits,
		expanded: typeof saved.expanded === "string" ? saved.expanded : null,
	};
}

function setRepo(next) {
	if (!Object.hasOwn(repos, next)) return;
	store();
	repo = next;
	const saved = aboutRepo(next);
	filters = saved.filters;
	count = saved.count;
	expanded = saved.expanded ? makeExpanded(saved.expanded, null) : null;
	info = emptyInfo;
	branches = [];
	branchHead = null;
	worktrees = [];
	upstreams = {};
	rows = [];
	head = null;
	more = false;
	selected.clear();
	anchor = null;
	viewGeneration += 1;
}

function switchRepo(next) {
	if (!Object.hasOwn(repos, next) || repo === next) return;
	if (busy) {
		repoSelect.value = repo;
		showError(new Error("Wait for the current Git action to finish before switching repositories."));
		return;
	}
	setRepo(next);
	window.scrollTo(0, 0);
	if ($("settingsWidget").open) $("settingsWidget").close();
	drawToolbar();
	draw();
	return refresh({ rememberRepo: true });
}

async function changeSettings(fields, reload = false) {
	const active = repo;
	const state = { ...repos[active], ...fields };
	repos[active] = state;
	// Column drags and toggle changes can follow one another before the save returns.
	const sent = selectionSave.catch(() => {}).then(() => request("saveRepoState", { repo: active, state }));
	selectionSave = sent;
	if (reload) count = config.initialLoadCommits;
	drawToolbar();
	await sent;
	if (repo !== active) return;
	if (reload) await refresh();
	else if (Object.hasOwn(fields, "issueLinking")) draw();
}

function changePreference(key, value) {
	prefs[key] = value;
	store();
	draw();
}

// ---------- loading ----------

async function refresh({ repoList = false, rememberRepo = false, keepDetails = true } = {}) {
	if (busy || !config) return;
	const current = ++generation;
	const same = () => generation === current;
	loading = true;
	status(rows.length ? "Refreshing graph…" : "Loading graph…", "loading");
	try {
		if (repoList) {
			const latest = await request("loadRepos", { check: true });
			if (!same()) return;
			repos = latest.repos;
			if (!Object.hasOwn(repos, repo)) setRepo(latest.lastActiveRepo || Object.keys(repos)[0]);
		}
		if (!Object.hasOwn(repos, repo)) {
			notice("No repository to show", "Open a workspace containing a Git repository or worktree.");
			return;
		}
		const active = repo;
		if (rememberRepo) await request("selectRepo", { repo: active });
		if (!same()) return;
		const [listed, loaded] = await Promise.all([
			request("loadBranches", { repo: active, hard: true, ...withFilters() }),
			request("loadRepoInfo", { repo: active, showStashes: setting("showStashes") }),
		]);
		if (!same()) return;
		if (!listed.isRepo || !loaded.repoInfo?.isRepo) throw new Error("Git could not read this repository.");
		branches = listed.branches;
		branchHead = listed.head;
		worktrees = listed.worktrees || [];
		upstreams = listed.upstreams || {};
		info = loaded.repoInfo;
		const values = { branches: ["HEAD", ...branches], authors: info.authors, tags: info.tags };
		for (const key of filterKeys) filters[key] = filters[key].filter((name) => values[key].includes(name));
		const answer = await request("loadCommits", {
			repo: active, ...withFilters(), branchName: "", maxCommits: count, showStashes: setting("showStashes") && config.stashDisplay !== "table",
			includeReflog: setting("includeReflog"), includeUnreachableCommits: setting("includeUnreachableCommits"),
			onlyFollowFirstParent: setting("onlyFollowFirstParent"), commitOrdering: orderOf(repos[active]),
		});
		if (!same()) return;
		rows = answer.commits;
		head = answer.head;
		more = answer.moreCommitsAvailable;
		lastLoaded = Date.now();
		if (!keepDetails || (expanded && !rows.some((commit) => commit.hash === expanded.hash))) expanded = null;
		const wasExpanded = expanded;
		drawToolbar();
		draw();
		store();
		status("Ready");
		// Dirty files change between visits. Completed commit details are immutable.
		if (wasExpanded && (!wasExpanded.info || wasExpanded.hash === "*" || wasExpanded.comparison?.base === "*" || wasExpanded.comparison?.other === "*")) {
			await fillDetails(wasExpanded, false);
		}
	} catch (error) {
		if (same()) {
			status(error.message, "error");
			if (!rows.length) $("commitTable").replaceChildren(elt("p", { className: "empty error" }, error.message));
		}
	} finally {
		if (same()) loading = false;
	}
}

async function init() {
	if (!workspace) return notice("Git Graph needs a workspace", "Open it from a board’s toolbox.");
	try {
		const payload = await json("/git/init");
		if (!payload.available) return notice("No repository to show", payload.reason);
		config = payload.viewState;
		repos = config.repos;
		setRepo(config.lastActiveRepo || Object.keys(repos)[0]);
		$("ggNotice").hidden = true;
		$("topBar").hidden = false;
		$("commitGraph").hidden = false;
		await refresh();
	} catch (error) {
		notice("Git Graph could not open", error.message);
	} finally {
		if (framed) window.parent.postMessage({ source: "pi-gitgraph", type: "ready" }, location.origin);
	}
}

function filterChange(key, values) {
	filters[key] = values;
	count = config.initialLoadCommits;
	closeDetail();
	selected.clear();
	anchor = null;
	window.scrollTo(0, 0);
	store();
	void refresh();
}

const repoSelect = elt("select", { "aria-label": "Repository or worktree" });
$("repoSelect").append(repoSelect);
repoSelect.addEventListener("change", () => void switchRepo(repoSelect.value));
const updateFilter = Object.fromEntries(filterKeys.map((key) => [key, filterBox($(key === "branches" ? "branchSelect" : key === "authors" ? "authorSelect" : "tagSelect"), key[0].toUpperCase() + key.slice(1), (value) => filterChange(key, value))]));

function drawToolbar() {
	const repoOptions = Object.entries(repos).map(([path, state]) => elt("option", { value: path, title: path }, repoLabel(path, state)));
	repoSelect.replaceChildren(...repoOptions);
	repoSelect.value = repo;
	$("repoControl").hidden = repoOptions.length < 2;
	updateFilter.branches([["HEAD", "HEAD"], ...branches.filter((name) => name !== "HEAD").map((name) => [name, name.replace(/^remotes\//, "")])], filters.branches);
	updateFilter.authors(info.authors.map((name) => [name, name]), filters.authors);
	updateFilter.tags(info.tags.map((name) => [name, name]), filters.tags);
	checked($("showRemoteBranchesCheckbox"), setting("showRemoteBranches"));
	$("fetchBtn").hidden = info.remotes.length === 0;
	$("pushTagsBtn").hidden = info.remotes.length === 0;
	if ($("settingsWidget").open) drawSettings(ctx(), changeSettings);
	const stash = $("stashListSlot");
	const wasOpen = stash.firstChild?.open ?? true;
	stash.replaceChildren();
	if (setting("showStashes") && config.stashDisplay !== "graph" && info.stashes.length) {
		const active = ctx();
		const entries = info.stashes.map(({ ref, hash, message, date }) => {
			const options = () => stashMenu(active, ref, hash);
			return menuOn(btn(elt("span", { className: "stash-row" }, elt("code", {}, ref), elt("span", { title: message }, message), elt("time", {}, dateOf(date))), (event) => showMenu(event, options()), { className: "stash-entry" }), options);
		});
		stash.append(elt("details", { className: "stash-list", open: wasOpen }, elt("summary", {}, `Stashes (${entries.length})`), elt("div", {}, entries)));
	}
}

// ---------- graph and table ----------

function refBadge(active, row, ref, display = ref.name, alias = false) {
	const held = active.worktrees.find((tree) => !tree.isCurrent && tree.branch === ref.name);
	const options = () => refMenu(active, ref, row);
	const badge = menuOn(btn(elt("span", {}, display, held ? " ◇" : ""), (event) => {
		if (event.detail === 0) showMenu(event, options());
	}, {
		className: `ref ${ref.type}${alias ? " alias" : ""}${ref.type === "head" && ref.name === branchHead ? " active" : ""}`,
		title: held ? `${ref.name} · checked out at ${held.path}` : ref.name,
		"aria-label": ref.name, "aria-haspopup": "menu",
	}), options);
	badge.addEventListener("click", (event) => event.stopPropagation());
	badge.addEventListener("dblclick", (event) => {
		event.stopPropagation();
		void checkoutRef(active, ref).catch(showError);
	});
	return badge;
}

function drawRefs(active, row) {
	const locals = row.refs.filter(({ type }) => type === "head").sort((a, b) => Number(b.name === branchHead) - Number(a.name === branchHead));
	const remoteNames = info.remotes.map(({ name }) => name);
	const aliases = new Set();
	const parts = locals.map((ref) => {
		const matching = row.refs.filter((other) => other.type === "remote" && splitRemote(other.name, remoteNames)[1] === ref.name);
		if (!matching.length) return refBadge(active, row, ref);
		for (const other of matching) aliases.add(other.name);
		return elt("span", { className: `ref-group${ref.name === branchHead ? " active" : ""}` }, refBadge(active, row, ref),
			matching.map((other) => refBadge(active, row, other, splitRemote(other.name, remoteNames)[0], true)));
	});
	for (const ref of row.refs) if (ref.type !== "head" && !aliases.has(ref.name)) parts.push(refBadge(active, row, ref));
	for (const tree of worktrees) {
		if (tree.isCurrent || !tree.detached || tree.head !== row.hash) continue;
		parts.push(elt("span", { className: "ref worktree", title: tree.path }, `HEAD · ${repoLabel(tree.path)}`));
	}
	return parts;
}

function widthForGraph() {
	return graphWidth(layout.width);
}

function widthsForColumns() {
	const saved = repos[repo]?.columnWidths;
	return defaultWidths.map((width, idx) => {
		const value = saved?.[idx];
		return Number.isFinite(value) ? Math.min(1000, Math.max(44, value)) : idx === 0 ? Math.max(width, widthForGraph() + 12) : width;
	});
}

function headerFor(key, widths, col) {
	const order = orderOf(repos[repo]);
	const labels = { graph: "Graph", description: "Description", date: "Date", author: "Author", commit: "Commit", signature: "Signature" };
	const heading = elt("th", { className: `col-${key}`, scope: "col", tabindex: 0 }, labels[key]);
	if (key === "date" && order === "date") heading.setAttribute("aria-sort", "descending");
	menuOn(heading, () => [
		...columns.slice(2).map((name) => item(`Show ${labels[name].toLowerCase()}`, () => {
			if (!hiddenColumns.delete(name)) hiddenColumns.add(name);
			store();
			draw();
		}, { checked: !hiddenColumns.has(name) })),
		...Object.entries(compareOrder).map(([ordering, label]) => item(label, () => changeSettings({ commitOrdering: ordering }, true), { checked: order === ordering })),
		item("Include unreachable commits", () => changeSettings({ includeUnreachableCommits: setting("includeUnreachableCommits") ? "disabled" : "enabled" }, true), { checked: setting("includeUnreachableCommits") }),
		item("Reset column widths", () => changeSettings({ columnWidths: null }).then(draw)),
	]);
	const index = adjustable.indexOf(key);
	if (index < 0) return heading;
	const grab = elt("span", { className: "col-grab", role: "separator", tabindex: 0, "aria-orientation": "vertical", "aria-label": `Resize ${labels[key]} column`, "aria-valuemin": 44, "aria-valuemax": 1000, "aria-valuenow": widths[index] });
	function resize(next) {
		widths[index] = Math.min(1000, Math.max(44, next));
		col.style.width = `${widths[index]}px`;
		grab.setAttribute("aria-valuenow", widths[index]);
	}
	const save = () => changeSettings({ columnWidths: [...widths] }).catch(showError);
	grab.addEventListener("pointerdown", (event) => {
		if (event.button !== 0) return;
		event.preventDefault();
		grab.setPointerCapture(event.pointerId);
		const x = event.clientX, from = widths[index];
		const move = (event) => resize(from + event.clientX - x);
		grab.addEventListener("pointermove", move);
		grab.addEventListener("lostpointercapture", () => { grab.removeEventListener("pointermove", move); void save(); }, { once: true });
	});
	grab.addEventListener("keydown", (event) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		event.preventDefault();
		resize(widths[index] + (event.key === "ArrowLeft" ? -12 : 12));
		void save();
	});
	heading.append(grab);
	return heading;
}

function draw() {
	if (!config || !repo) return;
	const active = ctx();
	const y = window.scrollY, x = window.scrollX;
	const focusHash = document.activeElement?.dataset?.hash;
	const shown = columns.filter((key) => !hiddenColumns.has(key));
	layout = layoutGraph(rows, { more: more && !filters.authors.length && !filters.tags.length, firstParentOnly: setting("onlyFollowFirstParent") });
	const widths = widthsForColumns();
	const colgroup = elt("colgroup");
	const tableHead = elt("tr");
	for (const key of shown) {
		const col = elt("col");
		const width = widths[adjustable.indexOf(key)];
		if (width) col.style.width = `${width}px`;
		colgroup.append(col);
		tableHead.append(headerFor(key, widths, col));
	}
	const tbody = elt("tbody");
	rowNodes = new Map();
	const visible = new Set(rows.map(({ hash }) => hash));
	selected = new Set([...selected].filter((hash) => visible.has(hash)));
	for (const [i, row] of rows.entries()) {
		const { hash } = row;
		const dirty = hash === "*";
		const isHead = hash === head;
		const shownDetail = expanded?.hash === hash;
		const lane = layout.rows[i];
		const tr = elt("tr", { className: `commit${dirty ? " dirty" : ""}${shownDetail ? " expanded" : ""}`, tabindex: 0,
			"data-hash": hash, "aria-current": isHead ? "true" : null, "aria-expanded": String(shownDetail), "aria-selected": String(selected.has(hash) || shownDetail) });
		tr.style.setProperty("--lane", dirty ? "var(--muted)" : config.graphColors[lane.tone % config.graphColors.length]);
		rowNodes.set(hash, tr);
		const initials = row.stash ? [elt("span", { className: "ref stash" }, row.stash.ref)] : drawRefs(active, row);
		const cells = {
			graph: () => drawLanes(lane, widthForGraph(), config.graphColors, { current: isHead, stash: Boolean(row.stash), uncommitted: dirty, angular: config.graphStyle === "angular" }),
			description: () => elt("div", { className: "description" },
				isHead && elt("span", { className: "head-dot", title: "HEAD", "aria-label": "HEAD" }), initials,
				elt("span", { className: "subject", title: row.message }, row.message)),
			date: () => elt("time", {}, dateOf(row.date)),
			author: () => elt("span", { title: `${row.author} <${row.email}>` }, row.author),
			commit: () => elt("code", { title: hash }, dirty ? "—" : short(hash, config.shortHashLength)),
			signature: () => elt("span", { title: row.signature?.status || "No signature status" }, row.signature?.status ?? "—"),
		};
		for (const name of shown) tr.append(elt("td", { className: `col-${name}` }, cells[name]()));
		const open = () => {
			if (expanded?.hash === hash) closeDetail(true);
			else void expand(hash, null).catch(showError);
		};
		tr.addEventListener("click", (event) => {
			if (event.target.closest("button, a")) return;
			if ((event.ctrlKey || event.metaKey || (event.shiftKey && anchor)) && !dirty && !row.stash) {
				if (event.shiftKey && visible.has(anchor)) {
					const start = rows.findIndex((commit) => commit.hash === anchor);
					selected = new Set(rows.slice(Math.min(start, i), Math.max(start, i) + 1).filter((commit) => !commit.stash && commit.hash !== "*").map((commit) => commit.hash));
				} else {
					if (!selected.delete(hash)) selected.add(hash);
					anchor = hash;
				}
				paintSelection();
				return;
			}
			selected.clear();
			anchor = hash;
			open();
		});
		tr.addEventListener("keydown", (event) => {
			if (event.target !== tr || (event.key !== "Enter" && event.key !== " ")) return;
			event.preventDefault();
			open();
		});
		menuOn(tr, () => {
			if (dirty) return uncommittedMenu(active, prefs.flatUncommitted, () => changePreference("flatUncommitted", !prefs.flatUncommitted));
			if (row.stash) return stashMenu(active, row.stash.ref, hash);
			if (!selected.has(hash)) { selected = new Set([hash]); anchor = hash; paintSelection(); }
			const ordered = rows.filter((commit) => selected.has(commit.hash)).map((commit) => commit.hash);
			return commitMenu(active, row, ordered);
		});
		tbody.append(tr);
		if (shownDetail) {
			const gutter = elt("td", { className: "detail-graph", "aria-hidden": true }, extendLanes(lane.exits, config.graphColors));
			tbody.append(elt("tr", { className: "detail-row" }, gutter, elt("td", { colspan: shown.length - 1 }, detailPanel(active, expanded, prefs, changePreference))));
		}
	}
	if (!rows.length) tbody.append(elt("tr", {}, elt("td", { className: "empty", colspan: shown.length }, head || branches.length ? "No commits match these filters." : "This repository has no commits yet.")));
	$("commitTable").replaceChildren(elt("table", { "aria-label": "Commits" }, colgroup, elt("thead", {}, tableHead), tbody));
	$("footer").replaceChildren(more ? btn("Load more commits", () => void loadMore(), { id: "loadMoreCommitsBtn" }) : elt("span", { className: "muted" }, `${rows.filter((row) => row.hash !== "*" && !row.stash).length} commits`));
	refreshMatches(matches[matchIndex]);
	window.scrollTo(x, y);
	if (focusHash) rowNodes.get(focusHash)?.focus({ preventScroll: true });
}

function paintSelection() {
	for (const [hash, tr] of rowNodes) tr.setAttribute("aria-selected", String(selected.has(hash) || expanded?.hash === hash));
}

function makeExpanded(hash, comparison) {
	return { hash, comparison, info: null, height: expanded?.height || 250, closed: new Set(), folders: new Set() };
}

async function fillDetails(detail, reveal) {
	const active = ctx();
	try {
		const { hash, comparison } = detail;
		const result = comparison ? await active.read("commitComparison", { commitHash: hash, baseRef: comparison.base, compareRef: comparison.other })
			: hash === "*" ? await active.read("uncommittedDetails") : await active.read("commitDetails", { commitHash: hash });
		if (expanded !== detail) return;
		detail.info = hash === "*" ? result.changes : result.commitDetails;
		if (!detail.info) throw new Error("Git did not return details for this row.");
		draw();
		if (reveal) {
			const tr = rowNodes.get(hash);
			tr?.focus({ preventScroll: true });
			if (config.autoCenterCommitDetailsView) tr?.scrollIntoView({ block: "center", inline: "nearest" });
		}
	} catch (error) {
		if (expanded === detail) { closeDetail(true); throw error; }
	}
}

function expand(hash, comparison) {
	expanded = makeExpanded(hash, comparison);
	draw();
	store();
	return fillDetails(expanded, true);
}

function closeDetail(focus = false) {
	if (!expanded) return;
	const hash = expanded.hash;
	expanded = null;
	draw();
	store();
	if (focus) rowNodes.get(hash)?.focus({ preventScroll: true });
}

async function loadMore() {
	if (!more || busy || loading) return;
	count += config.loadMoreCommits;
	await refresh();
}

// ---------- find and reveal ----------

const findInput = $("findInput");
function refreshMatches(previous) {
	const query = findInput.value.trim().toLowerCase();
	matches = !query ? [] : rows.filter((row) => row.hash !== "*" && [row.hash, row.message, row.author, row.email, row.stash?.ref,
		...row.refs.map((ref) => ref.name)].some((value) => value?.toLowerCase().includes(query))).map(({ hash }) => hash);
	const index = matches.indexOf(previous);
	matchIndex = matches.length ? Math.max(0, index) : -1;
	paintMatches();
}

function paintMatches() {
	const active = matches[matchIndex];
	const matching = new Set(matches);
	for (const [hash, node] of rowNodes) {
		node.classList.toggle("find-match", matching.has(hash));
		node.classList.toggle("find-active", active === hash);
	}
	$("findMatchCount").textContent = active ? `${matchIndex + 1} of ${matches.length}` : findInput.value.trim() ? "No matches" : "";
	$("findNextBtn").disabled = !matches.length;
	$("findPreviousBtn").disabled = !matches.length;
	$("findSearchHistoryBtn").disabled = !findInput.value.trim();
}

function navigateFind(delta) {
	if (!matches.length) return;
	matchIndex = (matchIndex + delta + matches.length) % matches.length;
	paintMatches();
	rowNodes.get(matches[matchIndex])?.scrollIntoView({ block: "center", inline: "nearest" });
}

function openFind() {
	$("findControl").hidden = false;
	findInput.focus();
	findInput.select();
}

function closeFind() {
	$("findControl").hidden = true;
	findInput.value = "";
	refreshMatches();
	$("findBtn").focus({ preventScroll: true });
}

function reveal(hash) {
	const row = rowNodes.get(hash);
	if (!row) return false;
	revealedNode?.classList.remove("revealed");
	row.classList.add("revealed");
	revealedNode = row;
	row.scrollIntoView({ block: "center", inline: "nearest" });
	row.focus({ preventScroll: true });
	return true;
}

async function showCommit(hash) {
	if (!hash) return;
	if (reveal(hash)) return;
	const active = repo;
	if (filters.branches.length || filters.authors.length || filters.tags.length) {
		filters = { branches: [], authors: [], tags: [] };
		await refresh();
		if (active !== repo || reveal(hash)) return;
	}
	// Search returns matching commits, not a position in this ordered walk.
	while (more && active === repo && !loading && !busy) {
		const previousLength = rows.length;
		count += Math.max(config.loadMoreCommits, count);
		await refresh();
		if (active !== repo || reveal(hash)) return;
		if (rows.length <= previousLength) break;
	}
	throw new Error("This commit is outside the current graph. Check the repository’s history settings.");
}

async function searchHistory() {
	const query = findInput.value.trim();
	if (!query || !repo) return;
	const reply = await ctx().read("searchCommits", { query, maxResults: 50, ...withFilters() });
	if (!reply.results.length) return modal("No commits found", elt("p", {}, `No commits matched “${query}”.`));
	modal(`History results for “${query}”`, elt("div", { className: "search-results" }, reply.results.map((row) => btn(`${short(row.hash)} · ${row.message} · ${row.author}`, () => {
		$("dialog").close();
		void showCommit(row.hash).catch(showError);
	}))));
}

// ---------- UI events ----------

const onClick = (id, fn) => $(id).addEventListener("click", () => Promise.resolve().then(fn).catch(showError));
onClick("findBtn", openFind);
onClick("findClearBtn", closeFind);
onClick("findNextBtn", () => navigateFind(1));
onClick("findPreviousBtn", () => navigateFind(-1));
onClick("findSearchHistoryBtn", searchHistory);
onClick("fetchBtn", () => fetchFrom(ctx()));
onClick("pushTagsBtn", () => pushAllTags(ctx()));
onClick("refreshBtn", () => refresh({ repoList: true }));
onClick("blinkHeadBtn", () => showCommit(head));
onClick("ggRetry", init);
onClick("settingsBtn", () => { drawSettings(ctx(), changeSettings); $("settingsWidget").showModal(); });
$("showRemoteBranchesCheckbox").addEventListener("change", (event) => {
	void changeSettings({ showRemoteBranches: event.target.checked ? "enabled" : "disabled" }, true).catch(showError);
});
findInput.addEventListener("input", () => {
	refreshMatches();
	rowNodes.get(matches[matchIndex])?.scrollIntoView({ block: "center", inline: "nearest" });
});
findInput.addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.isComposing) {
		event.preventDefault();
		navigateFind(event.shiftKey ? -1 : 1);
	}
});

const topBar = $("topBar");
new ResizeObserver(() => document.documentElement.style.setProperty("--toolbar-height", `${topBar.offsetHeight}px`)).observe(topBar);
window.addEventListener("scroll", () => {
	topBar.classList.toggle("scrolled", window.scrollY > 140);
	const next = $("loadMoreCommitsBtn");
	if (next && next.getBoundingClientRect().top < window.innerHeight + 60) void loadMore();
}, { passive: true });

window.addEventListener("message", (event) => {
	if (!framed || event.origin !== location.origin || event.source !== window.parent || event.data?.source !== "pi-studio") return;
	if (event.data.type === "focus") ($("topBar").hidden ? $("ggRetry") : $("findBtn")).focus({ preventScroll: true });
	if (event.data.command === "refresh" && !loading && Date.now() - lastLoaded > 450 && config) void refresh({ repoList: true });
});

document.addEventListener("keydown", (event) => {
	if (event.defaultPrevented || event.isComposing || document.querySelector('dialog[open], #contextMenu:popover-open, #ggViewer:not([hidden])')) return;
	const key = event.key.toLowerCase();
	if (key === "escape") {
		const filter = document.querySelector(".filter[open]");
		if (filter) { filter.open = false; filter.querySelector("summary").focus(); }
		else if (!$("findControl").hidden) closeFind();
		else if (expanded) closeDetail(true);
		else if (framed) window.parent.postMessage({ source: "pi-gitgraph", type: "close" }, location.origin);
		else return;
		event.preventDefault();
		return;
	}
	if (event.target.closest?.("input, textarea, select, [contenteditable]")) return;
	if ((event.ctrlKey || event.metaKey) && !event.altKey) {
		if (key === "f") openFind();
		else if (key === "h") void showCommit(head).catch(showError);
		else if (key === "r") void refresh({ repoList: true });
		else return;
	} else if (key === "f3" && !$("findControl").hidden) {
		navigateFind(event.shiftKey ? -1 : 1);
	} else if (key === "g" && framed && !event.altKey && !event.shiftKey) {
		window.parent.postMessage({ source: "pi-gitgraph", type: "close" }, location.origin);
	} else if ((key === "arrowup" || key === "arrowdown") && expanded && event.target.matches?.("tr.commit, body")) {
		const index = rows.findIndex((row) => row.hash === expanded.hash);
		const next = rows[index + (key === "arrowup" ? -1 : 1)];
		if (next) void expand(next.hash, null).catch(showError);
	} else return;
	event.preventDefault();
});

void init();

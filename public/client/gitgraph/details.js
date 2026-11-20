import { btn, copyText, dateOf, elt, menuOn, modal, short } from "./dom.js";
import { item } from "./actions.js";

function webLink(url) {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

export function checkIssueRule(pattern, template) {
	if (pattern.length > 200) throw new Error("Use an issue pattern of no more than 200 characters.");
	const patternCheck = new RegExp(pattern);
	if (patternCheck.test("")) throw new Error("The issue pattern must match text, rather than an empty string.");
	if (!/\$[1-9]\d*/.test(template) || !webLink(template.replace(/\$[1-9]\d*/g, "123"))) {
		throw new Error("Use an HTTP or HTTPS URL with a capture placeholder such as $1.");
	}
}

function messageParts(text, rule) {
	const hits = [...text.matchAll(/https?:\/\/[^\s<>]+/gi)].map((match) => {
		const link = match[0].replace(/[),.?!;]+$/, "");
		return { at: match.index, label: link, link };
	});
	if (rule) {
		try {
			checkIssueRule(rule.pattern, rule.urlTemplate);
			for (const match of text.matchAll(new RegExp(rule.pattern, "g"))) {
				if (!match[0]) continue;
				const link = rule.urlTemplate.replace(/\$(\d+)/g, (_, group) => encodeURIComponent(match[Number(group)] ?? ""));
				hits.push({ at: match.index, label: match[0], link });
			}
		} catch {
			// Old settings may contain a pattern the current form would refuse.
		}
	}
	const parts = [];
	let cursor = 0;
	for (const { at, label, link } of hits.sort((a, b) => a.at - b.at || b.label.length - a.label.length)) {
		if (at < cursor || !webLink(link)) continue;
		parts.push(text.slice(cursor, at), elt("a", { href: link, target: "_blank", rel: "noopener noreferrer" }, label));
		cursor = at + label.length;
	}
	parts.push(text.slice(cursor));
	return parts;
}

function makePane(key, label, content, state, onResize, drop = null) {
	const panel = elt("details", { className: `detail-pane ${key}`, open: !state.closed.has(key) }, elt("summary", {}, label), content);
	panel.addEventListener("toggle", () => {
		if (panel.open) state.closed.delete(key);
		else state.closed.add(key);
		onResize();
	});
	if (drop) {
		panel.addEventListener("dragover", (event) => {
			if (!event.dataTransfer.types.includes("application/x-pi-git-stage")) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = "move";
			panel.classList.add("drop-target");
		});
		panel.addEventListener("dragleave", (event) => { if (!panel.contains(event.relatedTarget)) panel.classList.remove("drop-target"); });
		panel.addEventListener("drop", (event) => {
			if (!event.dataTransfer.types.includes("application/x-pi-git-stage")) return;
			event.preventDefault();
			panel.classList.remove("drop-target");
			drop();
		});
	}
	return panel;
}

function groupFiles(files, render, listMode, closed, groupPrefix, drag = null) {
	if (!files.length) return elt("p", { className: "muted" }, "No files");
	const ordered = [...files].sort((a, b) => a.path.localeCompare(b.path));
	if (listMode) return elt("ul", { className: "files" }, ordered.map((file) => render(file, file.path)));
	const root = { folders: new Map(), files: [], paths: [] };
	for (const file of ordered) {
		const parts = file.path.split("/");
		const name = parts.pop();
		let node = root;
		for (const part of parts) {
			if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [], paths: [] });
			node = node.folders.get(part);
			node.paths.push(file.path);
		}
		node.files.push([file, name]);
	}
	const walk = (node, prefix) => elt("ul", { className: "files" },
		[...node.folders].map(([name, folder]) => {
			const key = `${prefix}/${name}`;
			const head = elt("summary", { draggable: Boolean(drag) }, name);
			const group = elt("details", { open: !closed.has(key) }, head, walk(folder, key));
			group.addEventListener("toggle", () => group.open ? closed.delete(key) : closed.add(key));
			if (drag) drag(head, folder.paths);
			return elt("li", { className: "folder" }, group);
		}), node.files.map(([file, name]) => render(file, name)));
	return walk(root, groupPrefix);
}

function makeCommitFile(ctx, detail, file, label) {
	const { change } = file;
	const { type, oldFilePath, newFilePath, additions, deletions } = change;
	const comparison = detail.comparison;
	const hash = detail.hash;
	const revision = comparison ? (type === "D" ? comparison.base : comparison.other) : type === "D" ? null : change.untracked ? `${hash}^3` : hash;
	const tty = additions !== null && deletions !== null;
	const diff = () => ctx.view("viewDiff", {
		commitHash: hash, oldFilePath, newFilePath, type,
		...(comparison ? { oldRef: comparison.base, newRef: comparison.other } : change.untracked ? { oldRef: `${hash}^`, newRef: `${hash}^3` } : {}),
	});
	const open = () => ctx.view("openFile", { filePath: newFilePath });
	const displayPath = newFilePath || oldFilePath;
	const copy = () => copyText(displayPath).catch(ctx.fail);
	const fileName = tty ? btn(label, () => diff().catch(ctx.fail), { className: "file-name", title: displayPath })
		: elt("span", { className: "file-name", title: `${displayPath} · binary file` }, label);
	return menuOn(elt("li", { className: "changed-file", tabindex: 0 }, elt("code", { className: "file-kind", "data-kind": type, title: type === "R" ? `${oldFilePath} → ${newFilePath}` : null }, type), fileName,
		tty && elt("span", { className: "file-stats" }, elt("span", { className: "plus" }, `+${additions}`), " ", elt("span", { className: "minus" }, `−${deletions}`)),
		elt("span", { className: "file-actions" }, btn("Copy path", copy), type !== "D" && btn("Open file", () => open().catch(ctx.fail)))), () => [
		tty && item("View file diff", diff),
		revision && item("View file at revision", () => ctx.view("viewFileAtRevision", { commitHash: revision, filePath: displayPath })),
		revision && revision !== "*" && item("Compare file with working tree", () => ctx.view("compareFileWithWorkingTree", { commitHash: revision, filePath: displayPath })),
		type !== "D" && item("Open working file", open),
		revision && revision !== "*" && item("Restore file from revision…", () => modal(`Restore ${displayPath} from ${short(revision)}?`, elt("p", {}, "This replaces the staged and working copies."), "Restore file", () => ctx.write("resetFileToRevision", { commitHash: revision, filePath: displayPath }), true), { danger: true }),
		item("Copy absolute path", () => copyText(`${ctx.repo.replace(/[/\\]$/, "")}/${displayPath}`)), item("Copy relative path", copy),
	]);
}

function commitInfo(ctx, detail) {
	const { info, comparison } = detail;
	const meta = [["Commit", info.hash], ["Parents", info.parents.join(", ") || "—"],
		["Author", [info.author, info.email].filter(Boolean).join(" · ")], ["Authored", dateOf(info.authorDate)],
		["Committer", [info.committer, info.committerEmail].filter(Boolean).join(" · ")], ["Committed", dateOf(info.committerDate)]];
	return elt("div", { className: "detail-content" }, comparison && elt("div", { className: "control-row comparison" },
		"Comparing", elt("code", {}, comparison.baseLabel || short(comparison.base)), "→", elt("code", {}, comparison.otherLabel || short(comparison.other)),
		btn("Swap", () => ctx.compare(detail.hash, comparison.other, comparison.base, comparison.otherLabel, comparison.baseLabel).catch(ctx.fail), { title: "Swap comparison" })),
		elt("dl", { className: "metadata" }, meta.flatMap(([label, text]) => [elt("dt", {}, label), elt("dd", {}, text)])),
		elt("p", { className: "message" }, messageParts(info.body || "", ctx.settings.issueLinking)));
}

export function detailPanel(ctx, state, prefs, changePref) {
	const wrapper = elt("div", { className: "detail-box" });
	const panes = elt("div", { className: "detail-panes" });
	const resize = elt("div", { className: "detail-resize", role: "separator", "aria-orientation": "horizontal", "aria-label": "Resize details", "aria-valuemin": 160, "aria-valuemax": 900, tabindex: 0 });
	function size(height) {
		state.height = Math.min(900, Math.max(160, Math.round(height)));
		panes.style.height = `${state.height}px`;
		resize.setAttribute("aria-valuenow", state.height);
	}
	function onToggle() {
		const collapsed = ![...panes.children].some((pane) => pane.open);
		panes.classList.toggle("all-collapsed", collapsed);
		resize.hidden = collapsed;
	}
	size(state.height ?? 250);
	resize.addEventListener("pointerdown", (event) => {
		if (event.button !== 0) return;
		event.preventDefault();
		resize.setPointerCapture(event.pointerId);
		const top = event.clientY, start = state.height;
		const move = (event) => size(start + event.clientY - top);
		resize.addEventListener("pointermove", move);
		resize.addEventListener("lostpointercapture", () => resize.removeEventListener("pointermove", move), { once: true });
	});
	resize.addEventListener("keydown", (event) => {
		const target = { ArrowUp: state.height - 24, ArrowDown: state.height + 24, PageUp: state.height - 120, PageDown: state.height + 120, Home: 160, End: 900 }[event.key];
		if (target === undefined) return;
		event.preventDefault();
		size(target);
	});

	if (!state.info) return elt("p", { className: "detail-content muted" }, "Loading details…");
	const dirty = state.hash === "*";
	const prefKey = dirty ? "flatUncommitted" : "flatFiles";
	const listMode = Boolean(prefs[prefKey]);
	if (dirty) {
		let dragging = null;
		for (const section of ["staged", "unstaged"]) {
			const rows = state.info[section];
			const move = (paths) => ctx.write(section === "staged" ? "unstageFiles" : "stageFiles", { filePaths: paths });
			const drag = (node, paths) => {
				node.addEventListener("dragstart", (event) => {
					event.stopPropagation();
					dragging = { section, paths };
					event.dataTransfer.setData("application/x-pi-git-stage", section);
					event.dataTransfer.effectAllowed = "move";
				});
				node.addEventListener("dragend", () => { dragging = null; });
			};
			const files = groupFiles(rows, (file, label) => {
				const stage = section === "staged" ? "Unstage" : "Stage";
				const row = elt("li", { className: "changed-file", draggable: true },
					elt("code", { className: "file-kind" }, (section === "staged" ? file.stagedKind : file.unstagedKind) || "?"),
					elt("span", { className: "file-name", title: file.oldPath ? `${file.oldPath} → ${file.path}` : file.path }, label),
					btn(stage, () => move([file.path]).catch(ctx.fail), { className: "file-actions", "aria-label": `${stage} ${file.path}` }));
				drag(row, [file.path]);
				return row;
			}, listMode, state.folders, section, drag);
			panes.append(makePane(section, `${section === "staged" ? "Staged" : "Unstaged"} (${rows.length})`, elt("div", { className: "detail-content" }, files), state, onToggle, () => {
				if (!dragging || dragging.section === section) return;
				ctx.write(section === "staged" ? "stageFiles" : "unstageFiles", { filePaths: dragging.paths }).catch(ctx.fail);
				dragging = null;
			}));
		}
	} else {
		const changes = state.info.fileChanges.map((change) => ({ path: change.newFilePath || change.oldFilePath, change }));
		const files = groupFiles(changes, (file, label) => makeCommitFile(ctx, state, file, label), listMode, state.folders, "files");
		panes.append(makePane("summary", "Summary", commitInfo(ctx, state), state, onToggle),
			makePane("files", `Files (${changes.length})`, elt("div", { className: "detail-content" },
				!state.comparison && state.info.parents.length > 1 && elt("p", { className: "muted" }, "Compared with the first parent."), files), state, onToggle));
	}
	wrapper.append(elt("div", { className: "detail-controls" },
		btn(listMode ? "Group by folder" : "Show flat list", () => changePref(prefKey, !listMode)), btn("Close details", ctx.closeDetail)), panes, resize);
	onToggle();
	return wrapper;
}

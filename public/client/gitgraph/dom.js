export const $ = (id) => document.getElementById(id);

export function elt(tag, { className, ...attrs } = {}, ...children) {
	const element = document.createElement(tag);
	if (className) element.className = className;
	for (const [attr, value] of Object.entries(attrs)) {
		if (value != null && value !== false) element.setAttribute(attr, value === true ? "" : String(value));
	}
	element.append(...children.flat(Infinity).filter((child) => child != null && typeof child !== "boolean"));
	return element;
}

export function btn(label, click, attrs = {}) {
	const button = elt("button", { type: "button", ...attrs }, label);
	button.addEventListener("click", click);
	return button;
}

export function short(hash, length = 7) {
	return hash === "*" ? "working tree" : (hash ?? "").slice(0, length);
}

const dateTime = new Intl.DateTimeFormat("en-GB", {
	day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
});
export const dateOf = (seconds) => Number.isFinite(seconds) ? dateTime.format(seconds * 1000).replace(", ", " ") : "—";
export const compareOrder = { date: "Commit date (newest first)", "author-date": "Author date", topo: "Topological" };
export const repoLabel = (path, settings) => settings?.displayName || path.split(/[/\\]/).filter(Boolean).at(-1) || path;

export function splitRemote(ref, remotes) {
	const name = ref.startsWith("remotes/") ? ref.slice(8) : ref;
	const remote = remotes.filter((r) => name.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0];
	const separator = remote?.length ?? name.indexOf("/");
	return separator > 0 ? [name.slice(0, separator), name.slice(separator + 1)] : ["", name];
}

export async function copyText(text) {
	if (navigator.clipboard) return navigator.clipboard.writeText(text);
	const field = elt("textarea", { readonly: true });
	field.style.position = "fixed";
	field.style.opacity = "0";
	field.value = text;
	document.body.append(field);
	field.select();
	try {
		if (!document.execCommand("copy")) throw new Error("The browser denied clipboard access.");
	} finally {
		field.remove();
	}
}

export function showMenu(event, items) {
	const menu = $("contextMenu");
	const enabled = items.filter(Boolean);
	if (!enabled.length) return;
	event.preventDefault();
	event.stopPropagation();
	const source = event.currentTarget;
	const bounds = source.getBoundingClientRect();
	const x = event.clientX || bounds.left;
	const y = event.clientY || bounds.bottom;
	const buttons = enabled.map(({ label, run, checked, danger }) => btn(checked === undefined ? label : `${checked ? "✓" : "·"} ${label}`, () => {
		menu.hidePopover();
		Promise.resolve().then(run).catch(showError);
	}, { role: checked === undefined ? "menuitem" : "menuitemcheckbox", "aria-checked": checked === undefined ? null : String(checked), className: danger ? "danger" : null }));
	menu.replaceChildren(...buttons);
	if (!menu.matches(":popover-open")) menu.showPopover();
	menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 4))}px`;
	menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 4))}px`;
	buttons[0].focus({ preventScroll: true });
	menu.onkeydown = (key) => {
		const index = buttons.indexOf(document.activeElement);
		const next = key.key === "ArrowDown" ? (index + 1) % buttons.length
			: key.key === "ArrowUp" ? (index + buttons.length - 1) % buttons.length
				: key.key === "Home" ? 0 : key.key === "End" ? buttons.length - 1 : -1;
		if (next < 0) return;
		key.preventDefault();
		buttons[next].focus();
	};
}

export function menuOn(element, options) {
	element.addEventListener("contextmenu", (event) => showMenu(event, options()));
	return element;
}

/** A native modal gives forms cancellation and a focus trap even inside the drawer. */
export function modal(title, children, submitLabel = null, submit = null, danger = false) {
	const dialog = $("dialog");
	const form = elt("form", { method: "dialog" }, elt("h2", { id: "ggDialogTitle" }, title), children);
	const close = btn(submitLabel ? "Cancel" : "Close", () => dialog.close());
	const buttons = elt("div", { className: "dialog-actions" }, close);
	if (submitLabel) {
		buttons.append(elt("button", { type: "submit", className: danger ? "danger confirm" : "primary" }, submitLabel));
	}
	form.append(buttons);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const values = new FormData(form);
		dialog.close();
		Promise.resolve().then(() => submit?.(values)).catch(showError);
	});
	dialog.replaceChildren(form);
	if (!dialog.open) dialog.showModal();
	// For destructive actions with no required input, default focus means cancel.
	if (danger) close.focus();
}

export function showError(error) {
	const details = error?.gitDetails ?? error?.message ?? String(error);
	const help = elt("p", { className: "git-help", "aria-live": "polite" }, "Asking the helper for one sentence…");
	const dialog = $("dialog");
	modal("Git Graph", [
		elt("p", { className: "error" }, "Git did not finish. What git said:"),
		elt("pre", { className: "git-details error" }, details),
		help,
	]);
	// One call, after the words are on screen: the helper fills in beside them and
	// a silent failure leaves them alone. Closing the dialog abandons the answer.
	// Only git replies carry details worth a call; a plain client error shows its
	// own line and asks nothing.
	void (async () => {
		if (!error?.gitDetails) { help.hidden = true; return; }
		const workspace = /^\/git\/([a-f0-9]{6,64})\/?$/.exec(location.pathname)?.[1];
		if (!workspace) { help.hidden = true; return; }
		try {
			const res = await fetch(`/git/msg?workspace=${encodeURIComponent(workspace)}`, {
				method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
				body: JSON.stringify({ command: "explainGitError", details, forCommand: error?.gitCommand ?? "", repo: error?.gitRepo ?? undefined }),
			});
			if (!res.ok) { help.hidden = true; return; }
			const answers = await res.json();
			const reply = answers.find((message) => message.command === "explainGitError") ?? {};
			const sentence = typeof reply.explanation === "string" ? reply.explanation.trim() : "";
			if (!dialog.open || !help.isConnected) return;
			if (sentence) { help.textContent = `Help: ${sentence}`; help.hidden = false; }
			else help.hidden = true;
		} catch {
			if (help.isConnected) help.hidden = true;
		}
	})();
}

/** Definition tuples are only used by Git command dialogs. */
export function field(name, label, value = "", { required, options, placeholder, list } = {}) {
	const attrs = { name, "aria-label": label, required, placeholder };
	const input = options
		? elt("select", attrs, options.map(([key, text]) => elt("option", { value: key, selected: key === value }, text)))
		: typeof value === "boolean"
			? elt("input", { ...attrs, type: "checkbox", checked: value })
			: elt("input", { ...attrs, value, type: "text", autocomplete: "off" });
	if (list) {
		input.setAttribute("list", `git-options-${name}`);
		return elt("label", { className: "field" }, label, input,
			elt("datalist", { id: `git-options-${name}` }, list.map((value) => elt("option", { value }))));
	}
	return typeof value === "boolean"
		? elt("label", { className: "check" }, input, label)
		: elt("label", { className: "field" }, label, input);
}

export function filterBox(host, name, onChange) {
	const panel = elt("details", { className: "filter" });
	const heading = elt("summary", { "aria-label": `${name} filter` }, "Show all");
	const search = elt("input", { type: "search", placeholder: `Filter ${name.toLowerCase()}…`, "aria-label": `Filter ${name.toLowerCase()}` });
	const list = elt("div", { className: "filter-list" });
	const noMatch = elt("p", { className: "muted", hidden: true }, "No matches");
	const body = elt("div", { className: "filter-panel" }, search, elt("div", { className: "control-row" },
		btn("Show all", () => choose([])), btn("Invert matches", () => {
			const next = new Set(selected);
			for (const item of list.children) {
				const { value } = item.firstChild;
				if (!item.hidden && !next.delete(value)) next.add(value);
			}
			choose([...next]);
		})), list, noMatch);
	panel.append(heading, body);
	host.append(panel);
	let selected = [], entries = [];
	function update(entriesNext = entries, selectedNext = selected) {
		entries = entriesNext;
		selected = selectedNext;
		const labels = entries.filter(([value]) => selected.includes(value)).map(([, label]) => label);
		heading.textContent = labels.join(", ") || "Show all";
		heading.title = heading.textContent;
		const existing = new Map([...list.children].map((item) => [item.firstChild.value, item]));
		const ordered = entries.map(([value, label]) => {
			const item = existing.get(value) ?? elt("label", { className: "check" }, elt("input", { type: "checkbox", value }), label);
			item.firstChild.checked = selected.includes(value);
			return item;
		});
		if (ordered.length !== list.children.length || ordered.some((item, index) => item !== list.children[index])) list.replaceChildren(...ordered);
		applyFilter();
	}
	function choose(values) {
		update(entries, values);
		onChange(values);
	}
	function applyFilter() {
		const needle = search.value.trim().toLowerCase();
		let hits = 0;
		for (const item of list.children) {
			item.hidden = !item.textContent.toLowerCase().includes(needle);
			if (!item.hidden) hits += 1;
		}
		noMatch.hidden = hits > 0;
	}
	search.addEventListener("input", applyFilter);
	list.addEventListener("change", (event) => {
		const { value, checked } = event.target;
		choose(checked ? [...selected, value] : selected.filter((item) => item !== value));
	});
	panel.addEventListener("toggle", () => {
		if (panel.open) {
			search.value = "";
			applyFilter();
			search.focus();
		}
	});
	document.addEventListener("pointerdown", (event) => { if (!panel.contains(event.target)) panel.open = false; });
	return update;
}

import { $, btn, compareOrder, elt, field, modal, repoLabel } from "./dom.js";
import { remoteEditor, remoteOptions } from "./actions.js";
import { checkIssueRule } from "./details.js";

const options = {
	showRemoteBranches: "Remote branches", showStashes: "Stashes", includeReflog: "Commits from reflog",
	includeUnreachableCommits: "Unreachable commits", onlyFollowFirstParent: "Follow only first parents",
};

export function drawSettings(ctx, save) {
	const box = $("settingsWidget");
	const prefs = ctx.settings;
	const identity = ctx.info.config || {};
	const header = elt("div", { className: "settings-heading" }, elt("h2", {}, "Repository settings"), btn("Close", () => box.close()));
	const display = elt("div", { className: "control-row" },
		elt("span", { title: ctx.repo }, repoLabel(ctx.repo, prefs)),
		btn("Edit name…", () => modal("Repository name", field("displayName", "Display name", prefs.displayName || ""), "Save name", (form) => save({ displayName: String(form.get("displayName")).trim() || null }))),
		prefs.displayName && btn("Clear name", () => save({ displayName: null }).catch(ctx.fail)));
	const opts = Object.entries(options).map(([key, label]) => {
		const row = field(key, label, prefs[key] ?? "default", { options: [
			["default", `Default (${ctx.config[key] ? "on" : "off"})`], ["enabled", "Show"], ["disabled", "Hide"],
		] });
		row.addEventListener("change", (event) => save({ [key]: event.target.value }, true).catch(ctx.fail));
		return row;
	});
	const ordering = field("commitOrdering", "Commit order", prefs.commitOrdering ?? "date", { options: Object.entries(compareOrder) });
	ordering.addEventListener("change", (event) => save({ commitOrdering: event.target.value }, true).catch(ctx.fail));
	const general = elt("section", {}, elt("h3", {}, "History"), display, ordering, opts);
	const getIdentity = (entry) => entry?.local ? `${entry.local} (local)` : entry?.global ? `${entry.global} (global)` : "Not set";
	const info = elt("section", {}, elt("h3", {}, "Git identity"), elt("dl", { className: "metadata" },
		elt("dt", {}, "Name"), elt("dd", {}, getIdentity(identity.userName)), elt("dt", {}, "Email"), elt("dd", {}, getIdentity(identity.userEmail))));
	const remotes = elt("section", {}, elt("h3", {}, "Remotes"), !ctx.info.remotes.length && elt("p", { className: "muted" }, "No remotes configured."));
	for (const remote of ctx.info.remotes) {
		const hidden = (prefs.hiddenRemotes ?? []).includes(remote.name);
		const toggle = () => {
			const next = new Set(prefs.hiddenRemotes ?? []);
			if (!next.delete(remote.name)) next.add(remote.name);
			return save({ hiddenRemotes: [...next] }, true);
		};
		remotes.append(elt("article", { className: "remote" }, elt("strong", {}, remote.name),
			elt("dl", { className: "metadata" }, elt("dt", {}, "Fetch"), elt("dd", {}, remote.fetchUrls.join(", ") || "—"),
				elt("dt", {}, "Push"), elt("dd", {}, remote.pushUrls.join(", ") || "—")),
			elt("div", { className: "control-row" }, btn(hidden ? "Show in graph" : "Hide in graph", () => toggle().catch(ctx.fail)),
				remoteOptions(ctx, remote).map(({ label, run, danger }) => btn(label, () => Promise.resolve().then(run).catch(ctx.fail), { className: danger ? "danger" : null })))));
	}
	remotes.append(btn("Add remote…", () => remoteEditor(ctx)));
	const issue = elt("section", {}, elt("h3", {}, "Issue links"),
		prefs.issueLinking && elt("p", { className: "message" }, `${prefs.issueLinking.pattern} → ${prefs.issueLinking.urlTemplate}`),
		elt("div", { className: "control-row" }, btn(prefs.issueLinking ? "Edit rule…" : "Add rule…", () => modal("Link issue numbers in commit messages", [
			field("pattern", "Issue pattern", prefs.issueLinking?.pattern ?? String.raw`#(\d+)`, { required: true }),
			field("urlTemplate", "URL (use $1 for the issue number)", prefs.issueLinking?.urlTemplate ?? "", { required: true }),
		], "Save rule", (form) => {
			const pattern = String(form.get("pattern")).trim(), urlTemplate = String(form.get("urlTemplate")).trim();
			checkIssueRule(pattern, urlTemplate);
			return save({ issueLinking: { pattern, urlTemplate } });
		})), prefs.issueLinking && btn("Remove rule", () => save({ issueLinking: null }).catch(ctx.fail))));
	box.replaceChildren(header, elt("div", { className: "settings-body" }, general, remotes, issue, info));
}

import { btn, copyText, dateOf, elt, field, modal, short, splitRemote } from "./dom.js";

const required = { required: true };
const value = (form, key) => String(form.get(key) ?? "").trim();
const checks = (form, ...keys) => Object.fromEntries(keys.map((key) => [key, form.has(key)]));
const choice = (key, label, initial, options) => field(key, label, initial, { options });
export const item = (label, run, more = {}) => ({ label, run, ...more });

const resetModes = [["soft", "Soft · keep staged changes"], ["mixed", "Mixed · keep files, clear staging"], ["hard", "Hard · discard tracked changes"]];
const pushModes = [["normal", "Normal"], ["force-with-lease", "Force with lease"], ["force", "Force"]];

// Every write uses the graph's existing command, including its workspace and live-tree checks.
function ask(ctx, label, title, command, fields = [], payload = () => ({}), danger = false) {
	modal(title, fields, label, (form) => ctx.write(command, payload(form)), danger);
}

function action(ctx, label, title, command, fields, payload, danger = false) {
	return item(`${label}…`, () => ask(ctx, label, title, command, fields?.(), payload, danger), { danger });
}

function confirm(ctx, label, title, command, args, danger = false) {
	return action(ctx, label, title, command, null, () => args, danger);
}

function integrate(ctx, command, label, target, args, noFastForward) {
	return action(ctx, label, `${label} ${target} into the current branch?`, command, () => [
		field("createNewCommit", "Create a merge commit even if fast-forward is possible", noFastForward),
		field("squash", "Squash commits", false), field("noCommit", "Leave changes staged", false),
		field("noVerify", "Bypass Git hooks", false),
	], (form) => ({ ...args, ...checks(form, "createNewCommit", "squash", "noCommit", "noVerify") }));
}

function rebase(ctx, ref, kind, label) {
	return action(ctx, "Rebase here", `Rebase the current branch onto ${label}?`, "rebaseCurrentBranch", () => [
		field("ignoreDate", "Use today’s date for replayed commits", true),
	], (form) => ({ target: ref, targetType: kind, ...checks(form, "ignoreDate") }), true);
}

function replay(ctx, commit, label, command) {
	const parents = commit.parentHashes.filter(Boolean);
	return action(ctx, label, `${label} ${short(commit.hash)}?`, command, () => [
		parents.length > 1 ? choice("parentIndex", "Mainline parent", "1", parents.map((parent, i) => [String(i + 1), `${i + 1} · ${short(parent)}`])) : null,
		field("noCommit", "Leave changes staged", false),
	], (form) => ({ commitHash: commit.hash, parentIndex: Number(value(form, "parentIndex")), ...checks(form, "noCommit") }));
}

function addTag(ctx, hash) {
	return item("Add tag…", () => {
		const type = choice("kind", "Tag type", "annotated", [["annotated", "Annotated"], ["lightweight", "Lightweight"]]);
		const message = field("message", "Message");
		type.addEventListener("change", (event) => { message.hidden = event.target.value === "lightweight"; });
		ask(ctx, "Add tag", `Tag ${short(hash)}`, "addTag", [field("tagName", "Name", "", required), type, message], (form) => ({
			commitHash: hash, tagName: value(form, "tagName"), lightweight: value(form, "kind") === "lightweight", message: value(form, "message"),
		}));
	});
}

function compareItems(ctx, hash, name) {
	return [
		ctx.head && hash !== ctx.head && item("Compare with HEAD", () => ctx.compare(hash, hash, ctx.head, name, "HEAD")),
		item("Compare with…", () => modal(`Compare ${name} with`, field("ref", "Commit, branch or tag", "", { ...required, list: [...new Set(["HEAD", ...ctx.branches, ...ctx.info.tags])] }), "Compare", async (form) => {
			const ref = value(form, "ref");
			const { hash: other } = await ctx.read("resolveRef", { ref });
			if (!other) throw new Error(`Git could not resolve ${ref}.`);
			await ctx.compare(hash, hash, other, name, ref);
		})),
	];
}

export function commitMenu(ctx, row, selected = []) {
	const hash = row.hash, label = short(hash);
	if (selected.length === 2) {
		const [newer, older] = selected;
		return [item("Compare selected commits", () => ctx.compare(hash, older, newer))];
	}
	return [
		addTag(ctx, hash),
		action(ctx, "Create branch", `Create a branch at ${label}`, "createBranch", () => [field("branchName", "Branch name", "", required), field("checkout", "Check out the new branch", ctx.config.createBranchCheckout)],
			(form) => ({ commitHash: hash, branchName: value(form, "branchName"), ...checks(form, "checkout") })),
		...compareItems(ctx, hash, label),
		item("Compare with working tree", () => ctx.compare(hash, hash, "*")),
		confirm(ctx, "Check out commit", `Check out ${label} with a detached HEAD?`, "checkoutCommit", { commitHash: hash }),
		replay(ctx, row, "Cherry-pick", "cherrypickCommit"), replay(ctx, row, "Revert", "revertCommit"),
		hash === ctx.head && row.parentHashes.some(Boolean) && confirm(ctx, "Undo last commit (soft)", "Move HEAD back one commit and keep its changes staged?", "undoLastCommit", {}, true),
		row.parentHashes.filter(Boolean).length === 1 && confirm(ctx, "Drop commit", `Remove ${label} from the current branch’s history? This rewrites history.`, "dropCommit", { commitHash: hash }, true),
		integrate(ctx, "mergeCommit", "Merge", label, { commitHash: hash }, ctx.config.mergeNoFastForward),
		rebase(ctx, hash, "commit", label),
		action(ctx, "Reset branch here", `Reset the current branch to ${label}?`, "resetToCommit", () => [choice("resetMode", "Reset mode", "mixed", resetModes)],
			(form) => ({ commitHash: hash, resetMode: value(form, "resetMode") }), true),
		item("Copy commit hash", () => copyText(hash)), item("Copy commit subject", () => copyText(row.message)),
	];
}

const remoteNames = (ctx) => ctx.info.remotes.map((remote) => remote.name);

function heldBy(ctx, name) {
	return ctx.worktrees.find((tree) => !tree.isCurrent && tree.branch === name);
}

export async function checkoutRef(ctx, ref) {
	const { name, type } = ref;
	if (type === "head") {
		if (name === ctx.branchHead) return;
		const held = heldBy(ctx, name);
		if (held) {
			if (ctx.hasRepo(held.path)) return ctx.switchRepo(held.path);
			throw new Error(`${name} is checked out in ${held.path}.`);
		}
		return ctx.write("checkoutBranch", { branchName: name, remoteBranch: null });
	}
	if (type !== "remote") return;
	const [, branch] = splitRemote(name, remoteNames(ctx));
	const local = ctx.localBranches.has(branch) ? branch
		: [...ctx.localBranches].find((name) => ctx.upstreams[name] === ref.name || ctx.upstreams[name] === `refs/remotes/${ref.name}`);
	const make = () => modal(`Track ${name}`, field("branchName", "New local branch name", local === branch ? "" : branch, required), "Create and check out", (form) => {
		const branchName = value(form, "branchName");
		if (ctx.localBranches.has(branchName)) throw new Error(`${branchName} already exists.`);
		return ctx.write("checkoutBranch", { branchName, remoteBranch: name });
	});
	if (!local) return make();
	const held = heldBy(ctx, local);
	const select = (run) => () => {
		document.getElementById("dialog").close();
		Promise.resolve().then(run).catch(ctx.fail);
	};
	modal(`Local branch ${local} already exists`, [
		elt("p", { className: "muted" }, held ? `It is checked out in ${held.path}.` : `Keep its current tip, or fast-forward it to ${name}.`),
		elt("div", { className: "control-row" },
			held ? ctx.hasRepo(held.path) && btn("Show its worktree", select(() => ctx.switchRepo(held.path)))
				: btn("Switch to local branch", select(() => ctx.write("checkoutBranch", { branchName: local, remoteBranch: null }))),
			!held && btn("Switch and fast-forward", select(() => ctx.write("checkoutAndFastForward", { branchName: local, target: name }))),
			btn("Create another branch…", select(make))),
	]);
}

async function push(ctx, command, name = null) {
	const remotes = remoteNames(ctx);
	if (!remotes.length) return;
	const isBranch = command === "pushBranch";
	const defaults = isBranch ? await ctx.read("branchPushDefaults", { branch: name }) : {};
	const preferred = [defaults.pushRemote, defaults.upstreamRemote, "origin", remotes[0]].find((candidate) => remotes.includes(candidate));
	const targets = remotes.map((remote, i) => field(`remote${i}`, `Push to ${remote}`, remote === preferred));
	const title = isBranch ? `Push branch ${name}` : name ? `Push tag ${name}` : "Push all tags";
	ask(ctx, "Push", title, command, [...targets,
		isBranch ? field("setUpstream", "Set upstream", !defaults.upstreamRemote) : null,
		choice("mode", "Push mode", "normal", pushModes), field("noVerify", "Bypass Git hooks", false),
	], (form) => {
		const targets = remotes.filter((_, i) => form.has(`remote${i}`));
		if (targets.length === 0) throw new Error("Select at least one remote.");
		const sorted = targets.includes(preferred) ? [preferred, ...targets.filter((remote) => remote !== preferred)] : targets;
		return { remotes: sorted, mode: value(form, "mode"), ...checks(form, "setUpstream", "noVerify"), ...(isBranch ? { branchName: name } : name ? { tagName: name } : {}) };
	});
}

export const pushAllTags = (ctx) => push(ctx, "pushAllTags");

export function fetchFrom(ctx, remote = null) {
	modal(remote ? `Fetch from ${remote}` : "Fetch from all remotes", [
		field("prune", "Prune deleted remote-tracking branches", false),
		field("pruneTags", "Prune deleted tags", false),
		!remote && field("tags", "Fetch all tags", ctx.config.fetchTagsByDefault),
	], "Fetch", (form) => {
		const options = checks(form, "prune", "pruneTags");
		if (options.pruneTags && !options.prune) throw new Error("Enable pruning before pruning tags.");
		return ctx.write("fetchRemotes", { remote, ...options }, form.has("tags") ? ["fetchTags", { remotes: remoteNames(ctx), pruneTags: options.pruneTags }] : null);
	});
}

function fetchTags(ctx) {
	const remotes = remoteNames(ctx);
	ask(ctx, "Fetch tags", "Fetch tags from remotes", "fetchTags", [...remotes.map((name, i) => field(`remote${i}`, name, true)), field("pruneTags", "Prune deleted tags", false)], (form) => {
		const selected = remotes.filter((_, i) => form.has(`remote${i}`));
		if (!selected.length) throw new Error("Select at least one remote.");
		return { remotes: selected, ...checks(form, "pruneTags") };
	});
}

function tagDetails(ctx, name) {
	return ctx.read("tagDetails", { tagName: name }).then(({ tagDetails: tag }) => {
		if (!tag) throw new Error(`Git did not return details for ${name}.`);
		const metadata = [["Type", tag.type], ["Object", tag.objectHash], ["Target", `${tag.targetType} ${tag.targetHash}`],
			["Tagger", [tag.taggerName, tag.taggerEmail].filter(Boolean).join(" · ") || "—"], ["Date", dateOf(tag.taggerDate)],
			["Signature", tag.signature ? [tag.signature.status, tag.signature.signer, tag.signature.key].filter(Boolean).join(" · ") : "Unsigned"]];
		const message = tag.body || tag.subject || "";
		modal(`Tag ${name}`, [elt("dl", { className: "metadata" }, metadata.flatMap(([label, text]) => [elt("dt", {}, label), elt("dd", {}, text)])),
			elt("p", { className: "message" }, message || "No tag message."),
			elt("div", { className: "control-row" }, [["Copy name", name], ["Copy object hash", tag.objectHash], ["Copy message", message]].map(([label, text]) => btn(label, () => copyText(text).catch(ctx.fail))))]);
	});
}

function worktreeItems(ctx, tree) {
	return [
		ctx.hasRepo(tree.path) && item("Show worktree in graph", () => ctx.switchRepo(tree.path)),
		item("Copy worktree path", () => copyText(tree.path)),
		!tree.isMain && (tree.locked
			? confirm(ctx, "Unlock worktree", `Unlock ${tree.path}?`, "unlockWorktree", { path: tree.path })
			: action(ctx, "Lock worktree", `Lock ${tree.path}?`, "lockWorktree", () => [field("reason", "Reason (optional)")],
				(form) => ({ path: tree.path, reason: value(form, "reason") }))),
		!tree.isMain && tree.prunable && action(ctx, "Repair worktree", `Repair the record of ${tree.path}`, "repairWorktree", () => [field("newPath", "Where the worktree was moved (absolute path)", "", required)],
			(form) => ({ path: tree.path, newPath: value(form, "newPath") })),
		!tree.isMain && !tree.locked && !tree.prunable && !ctx.hasRepo(tree.path) && action(ctx, "Move worktree", `Move ${tree.path}`, "moveWorktree", () => [field("newPath", "New absolute path", "", required)],
			(form) => ({ path: tree.path, newPath: value(form, "newPath") })),
		!tree.isMain && !tree.isCurrent && !ctx.hasRepo(tree.path) && item("Remove worktree…", () => removeWorktree(ctx, tree)),
	];
}

async function removeWorktree(ctx, tree, branch = null) {
	const reply = tree.prunable ? { files: [], truncated: false } : await ctx.read("worktreeChanges", { path: tree.path });
	const files = reply.files ?? [];
	modal(`Remove worktree ${tree.path}?`, [
		elt("p", {}, tree.prunable ? "Git will remove the stale worktree record." : "Git will delete the worktree’s folder."),
		files.length > 0 && elt("p", { className: "danger" }, "The worktree has local changes. These files will be deleted:"),
		files.length > 0 && elt("ul", { className: "file-warning" }, files.map((file) => elt("li", {}, file))),
		reply.truncated && elt("p", {}, "Other changed files are not shown."),
		branch && elt("p", {}, `If removal succeeds, Git will also delete ${branch.branchName}.`),
	], "Remove worktree", () => ctx.write("removeWorktree", { path: tree.path, force: files.length > 0, unlock: Boolean(tree.locked) }, branch ? ["deleteBranch", branch] : null), true);
}

export function refMenu(ctx, ref, row) {
	const { name, type } = ref, remotes = remoteNames(ctx);
	const copyName = item("Copy name", () => copyText(name));
	const comparison = compareItems(ctx, row.hash, name);
	if (type === "tag") {
		return [item("Tag details…", () => tagDetails(ctx, name)),
			action(ctx, "Delete tag", `Delete tag ${name}?`, "deleteTag", () => remotes.map((name, i) => field(`remote${i}`, `Also delete on ${name}`, false)),
				(form) => ({ tagName: name, deleteOnRemotes: remotes.filter((_, i) => form.has(`remote${i}`)) }), true),
			remotes.length && item("Push tag…", () => push(ctx, "pushTag", name)), remotes.length && item("Fetch tags…", () => fetchTags(ctx)), ...comparison, copyName];
	}
	if (type === "remote") {
		const [remote, branchName] = splitRemote(name, remotes);
		return [item("Check out branch…", () => checkoutRef(ctx, ref)),
			remote && confirm(ctx, "Delete remote branch", `Delete ${branchName} from ${remote}?`, "deleteRemoteBranch", { remote, branchName }, true),
			integrate(ctx, "mergeBranch", "Merge", name, { branchName: name }, ctx.config.mergeNoFastForward),
			remote && ctx.localBranches.has(branchName) && branchName !== ctx.branchHead && !heldBy(ctx, branchName) && action(ctx, "Fetch into local branch", `Fetch ${name} into ${branchName}?`, "fetchIntoLocalBranch", () => [field("force", "Allow non-fast-forward update", false)],
				(form) => ({ remote, remoteBranch: branchName, localBranch: branchName, ...checks(form, "force") })),
			remote && integrate(ctx, "pullBranch", "Pull", name, { remote, branchName }, ctx.config.pullBranchNoFastForward), ...comparison, copyName];
	}
	const held = heldBy(ctx, name), active = ctx.branchHead === name;
	const tracked = remotes.filter((remote) => ctx.branches.some((b) => b.replace(/^remotes\//, "") === `${remote}/${name}`));
	return [
		!active && !held && item("Check out branch", () => checkoutRef(ctx, ref)),
		action(ctx, "Rename branch", `Rename ${name}`, "renameBranch", () => [field("newName", "New name", name, required)], (form) => ({ oldName: name, newName: value(form, "newName") })),
		remotes.length && item("Push branch…", () => push(ctx, "pushBranch", name)),
		remotes.length && !held && action(ctx, "Update from upstream", `Update ${name} from its upstream?`, "updateBranchFromUpstream", null, () => ({ branchName: name })),
		!active && !held && action(ctx, "Delete branch", `Delete ${name}?`, "deleteBranch", () => [field("forceDelete", "Delete even if not merged", false), tracked.length > 0 && field("deleteRemote", `Also delete on ${tracked.join(", ")}`, false)],
			(form) => ({ branchName: name, ...checks(form, "forceDelete"), deleteOnRemotes: form.has("deleteRemote") ? tracked : [] }), true),
		!active && held && !ctx.hasRepo(held.path) && !held.isMain && item("Remove worktree and delete branch…", () => removeWorktree(ctx, held, { branchName: name })),
		!active && integrate(ctx, "mergeBranch", "Merge", name, { branchName: name }, ctx.config.mergeNoFastForward),
		!active && rebase(ctx, name, "branch", name),
		...comparison, ...(held ? worktreeItems(ctx, held) : []),
		ctx.worktrees.some((tree) => tree.prunable && !tree.locked) && confirm(ctx, "Prune stale worktrees", "Remove Git’s records of missing worktrees?", "pruneWorktrees", {}),
		copyName,
	];
}

export function stashMenu(ctx, ref, hash) {
	return [
		...[ ["Apply stash", "applyStash"], ["Pop stash", "popStash"] ].map(([label, command]) => action(ctx, label, `${label} ${ref}?`, command,
			() => [field("reinstateIndex", "Restore staged state", false)], (form) => ({ selector: ref, ...checks(form, "reinstateIndex") }))),
		action(ctx, "Create branch from stash", `Create and check out a branch from ${ref}`, "branchFromStash", () => [field("branchName", "New branch name", "", required)],
			(form) => ({ selector: ref, branchName: value(form, "branchName") })),
		confirm(ctx, "Drop stash", `Discard ${ref}?`, "dropStash", { selector: ref }, true),
		item("Copy stash name", () => copyText(ref)), item("Copy stash hash", () => copyText(hash)),
	];
}

export function uncommittedMenu(ctx, listMode, toggleMode) {
	return [
		item(listMode ? "Group by folder" : "Show as flat list", toggleMode),
		action(ctx, "Stash changes", "Stash uncommitted changes", "pushStash", () => [field("message", "Message (optional)"), field("includeUntracked", "Include untracked files", true)],
			(form) => ({ message: value(form, "message"), ...checks(form, "includeUntracked") })),
		action(ctx, "Reset changes", "Reset uncommitted changes to HEAD?", "resetUncommittedChanges", () => [choice("resetMode", "Reset mode", "mixed", resetModes.slice(1))],
			(form) => ({ resetMode: value(form, "resetMode") }), true),
		action(ctx, "Clean untracked files", "Permanently delete untracked files?", "cleanUntrackedFiles", () => [field("includeDirectories", "Include untracked directories", false)],
			(form) => checks(form, "includeDirectories"), true),
	];
}

export function remoteEditor(ctx, remote = null) {
	const type = remote ? "Edit remote" : "Add remote";
	ask(ctx, "Save remote", remote ? `Edit ${remote.name}` : type, remote ? "editRemote" : "addRemote", [
		field("name", "Name", remote?.name ?? "", required), field("fetchUrl", "Fetch URL", remote?.fetchUrls[0] ?? "", required),
		remote && field("pushUrl", "Push URL (optional)", remote.pushUrls[0] ?? ""),
		!remote && field("fetch", "Fetch after adding", false),
	], (form) => ({ name: value(form, "name"), fetchUrl: value(form, "fetchUrl"), ...(remote ? { oldName: remote.name, pushUrl: value(form, "pushUrl") || null } : checks(form, "fetch")) }));
}

export function remoteOptions(ctx, remote) {
	return [item("Fetch…", () => fetchFrom(ctx, remote.name)), item("Edit…", () => remoteEditor(ctx, remote)),
		confirm(ctx, "Prune remote", `Delete stale tracking refs for ${remote.name}?`, "pruneRemote", { name: remote.name }),
		confirm(ctx, "Delete remote", `Remove ${remote.name} from this repository’s configuration?`, "deleteRemote", { name: remote.name }, true)];
}

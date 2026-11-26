import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * The kontainer drawer's wiring, without a browser.
 *
 * The drawer itself draws a topology from `/kontainer/*` and is not reached from here: what this covers
 * is the three files that carry it — the page that holds its two elements and its stylesheet, the board
 * that opens it with `k` and closes the other drawers as it comes up, and the terminal drawer's
 * `runCommand`, which is the one new piece of logic the handoff carries. A command that arrives before
 * the socket is up is the case worth a test: the drawer that hands it over closes in the same breath.
 */

const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const board = readFileSync(new URL("../public/client/board.js", import.meta.url), "utf8");
const terminalSource = readFileSync(new URL("../public/client/terminal-drawer.js", import.meta.url), "utf8");
const kontainerSource = readFileSync(new URL("../public/client/kontainer-drawer.js", import.meta.url), "utf8");
const kontainerCss = readFileSync(new URL("../public/client/kontainer-drawer.css", import.meta.url), "utf8");

test("the page carries the drawer, its scrim, its stylesheet and the door in the toolbox", () => {
	assert.match(page, /<link rel="stylesheet" href="\/client\/kontainer-drawer\.css" \/>/, "the board links the drawer's own stylesheet");
	assert.match(page, /<div id="kontainerScrim" hidden><\/div>/, "the scrim under the drawer");
	assert.match(page, /<section id="kontainerDrawer" class="drawer-shell drawer-slide" aria-label="kontainer" inert>/, "the drawer itself, shut and inert until it rolls down");
	// The door stands with the other three in the toolbox, so the menu opens and closes it like them.
	assert.match(page, /id="toolboxMenu"[\s\S]*?id="kontainerBtn"[^>]*aria-controls="kontainerDrawer"[^>]*><span>kontainer<\/span><span class="hm-key">k<\/span>/, "the toolbox names the drawer and the key it answers");
	// The roll is the shared furniture, so the open state is one body class in each of its two places.
	assert.match(page, /body\.kontainer-open #kontainerDrawer,/, "the open selector list knows the drawer");
	assert.match(page, /#gitDrawer, #gitScrim, #kontainerDrawer, #kontainerScrim,/, "and the reduced-motion list kills its roll too");
});

test("the board imports the drawer, opens it with k and hands commands to the terminal", () => {
	assert.match(board, /import \{ createKontainerDrawer \} from "\.\/kontainer-drawer\.js";/);
	assert.match(board, /const kontainerDrawer = createKontainerDrawer\(\{[\s\S]*?openTerminalCommand:[\s\S]*?terminalDrawer\.runCommand\(cmd\);/, "an `exec ↗` in the topology lands in the shell the terminal drawer owns");
	// The letter is listed in the map on screen beside the two drawers it sits between.
	assert.match(board, /\{ keys: "g", does: "[^"]+" \},\n\s*\{ keys: "x", does: "[^"]+" \},\n\s*\{ keys: "k", does: "[^"]*kontainer[^"]*" \},/);
	// `k` rolls it down and the same letter rolls it up, because `panelUp` counts the open drawer.
	assert.match(board, /if \(event\.key !== "k"[\s\S]*?kontainerDrawer\.close\(\);[\s\S]*?!atPick\.hidden \|\| drawerSurface\(\)\) return;[\s\S]*?kontainerDrawer\.open\(\);/, "one press opens it, and a press while it is up closes it");
	assert.match(board, /const panelUp = [^\n]*kontainerDrawer\.isOpen\(\);/);
});

test("the drawer takes the surfaces the board's keys and Escape answer", () => {
	assert.match(board, /kontainer: kontainerDrawer\.isOpen\(\),/, "the escape order is told when the drawer is up");
	assert.match(board, /if \(target === "kontainer"\) return kontainerDrawer\.handleEscape\(\);/, "a sheet, the tools, the filter or a selection goes before the drawer does");
	// The three drawers cover the same board, so each one rolls the others up as it comes down.
	assert.match(board, /function showDrawer\(name\)[\s\S]*?if \(gitDrawer\.isOpen\(\)\) gitDrawer\.close\(\);\n\s*kontainerDrawer\.close\(\);/, "a left drawer rolls the topology up");
	assert.match(board, /function toggleDrawer\(name\)[\s\S]*?kontainerDrawer\.close\(\);/, "and so does its letter");
});

test("the drawer module keeps the members the board drives, and its three refresh modes", async () => {
	const module = (await import(new URL("../public/client/kontainer-drawer.js", import.meta.url).href)) as {
		createKontainerDrawer?: unknown;
	};
	assert.equal(typeof module.createKontainerDrawer, "function", "the drawer is made, not run at load");
	// What the board calls on it is the shared sliding drawer's list plus the topology's own one.
	assert.match(kontainerSource, /return \{ isOpen: sliding\.isOpen, toggle: sliding\.toggle, open: sliding\.open, close: sliding\.close, handleEscape \};/);
	// The stats cadence is the human's pick, and the stored one has to be one of the three.
	for (const mode of ["eco", "balanced", "live"]) {
		assert.match(kontainerSource, new RegExp(`<option value="${mode}">`), `the bar offers ${mode}`);
	}
	assert.match(kontainerSource, /\["eco", "balanced", "live"\]\.includes\(/, "and a remembered mode outside them falls back to balanced");
});

test("the board's header names the drawer, and nothing in its own bar does", () => {
	// The name stands in the slot the git graph uses, and the drawer's bar carries no title and no
	// workspace label of its own.
	assert.doesNotMatch(kontainerSource, /k-title/, "the bar has no title of its own");
	assert.doesNotMatch(kontainerSource, /k-ws|"kWs"/, "and no second copy of the workspace name");
	assert.doesNotMatch(kontainerCss, /\.k-title|\.k-ws\b/, "neither rule is left in the sheet");
	// `setName` named that label and nothing else, so it leaves with it — and the board stops calling it.
	assert.doesNotMatch(kontainerSource, /setName/, "the drawer no longer names a workspace");
	assert.doesNotMatch(board, /kontainerDrawer\.setName/, "and the board does not ask it to");
	// The slot belongs to the board, another drawer names it next, so what it said comes back at close.
	assert.match(kontainerSource, /const panelName = document\.getElementById\("openPanelName"\);/, "the drawer reads the board's own name slot");
	assert.match(kontainerSource, /panelName\.textContent = "kontainer";/, "and puts its own name in it as it opens");
	assert.match(kontainerSource, /panelNameBefore = \{ text: panelName\.textContent, hidden: panelName\.hidden \};/, "after remembering what the slot said");
	assert.match(kontainerSource, /panelName\.textContent = panelNameBefore\.text;/, "which comes back as it closes");
	assert.match(kontainerSource, /panelName\.hidden = panelNameBefore\.hidden;/, "hidden or shown as it was left");
});

test("the inspector is dragged wide from its left edge, and its width survives a reload", () => {
	// The handle is a strip on the inspector's own left edge, and it says what it does on hover.
	assert.match(kontainerSource, /<div class="k-insp-grip" id="kInspGrip" role="separator" aria-orientation="vertical" tabindex="0" title="drag to resize inspector"><\/div>/, "the strip is inside the panel it sizes");
	assert.match(kontainerCss, /#kontainerDrawer \.k-insp-grip \{[^}]*cursor:col-resize/, "it reads as a width edge under the cursor");
	// The width is the human's furniture, the way the rail's is: clamped, remembered, set as one property.
	assert.match(kontainerSource, /const INSP_MIN = 260, INSP_MAX = 560;/, "the panel stays readable and leaves the topology its room");
	assert.match(kontainerSource, /drawer\.style\.setProperty\("--k-insp-w", `\$\{inspWidth\}px`\);/, "one custom property carries it, and the sheet reads it");
	assert.match(kontainerCss, /#kontainerDrawer \.k-inspector \{[^}]*width:var\(--k-insp-w, 340px\)/, "the inspector's width comes from it");
	assert.match(kontainerSource, /store\.set\("kontainer\.inspectorWidth", String\(inspWidth\)\);/, "the width is remembered");
	assert.match(kontainerSource, /setInspectorWidth\(Number\(store\.get\("kontainer\.inspectorWidth", ""\)\) \|\| inspWidth\);/, "and read back at load");
	// The drag is the shared grip furniture; the wires are drawn against the stage, so they follow it.
	assert.match(kontainerSource, /bindDragHeight\(grip, \{ bodyClass: "kontainer-inspecting", resolvePx: \(event\) => setInspectorWidth\(inspector\.getBoundingClientRect\(\)\.right - event\.clientX\) \}\);/, "the press, the capture and the release are the shared ones");
	assert.match(kontainerSource, /function setInspectorWidth\(px\) \{[\s\S]{0,400}?scheduleWires\(\);/, "a resize redraws the wires rather than leaving them detached");
	assert.match(kontainerCss, /body\.kontainer-inspecting \{ cursor:col-resize; user-select:none; \}/, "the drag takes the pointer and the text selection out of it");
	// Arrow keys move the edge too, so the width is not a mouse-only setting.
	assert.match(kontainerSource, /event\.key === "ArrowLeft" \? 24 : event\.key === "ArrowRight" \? -24 : 0/, "the handle answers the two arrows that move it");
	assert.match(kontainerSource, /grip\.setAttribute\("aria-valuenow", String\(inspWidth\)\);/, "and says where the edge stands");
});

test("the drawer reads a 200 that says ok:false as the failure it is", () => {
	// The action route answers 200 either way, so the body's `ok` is the only verdict there is.
	assert.match(kontainerSource, /if \(data\?\.ok === false\) throw new Error\(data\?\.error \|\| "action failed"\);/, "a rejected action is thrown, so its caller toasts it");
	assert.doesNotMatch(kontainerSource, /data\?\.cmd/, "there is no second place a command could come from");
	assert.match(kontainerSource, /const cmd = data\?\.command;/, "the terminal runs the command the server built");
	assert.doesNotMatch(kontainerSource, /docker logs -f \$\{payload\.id\}|docker exec -it \$\{payload\.id\}/, "a failed handoff never becomes a client-built `docker ...` string");
	// The unavailability reason reaches the bar, next to the way to try again.
	assert.match(kontainerSource, /state\.data\.reason \|\| "Docker\/Podman socket unavailable"/, "the engine's complaint is shown, not an empty board");
	// The runtime switcher reads the label the backend carries; the engine never sends a `name`.
	assert.match(kontainerSource, /const rlabel = \(r\) => \(typeof r === "string" \? r : r\.label \|\| r\.id\);/, "a runtime is named by its label");
	assert.doesNotMatch(kontainerSource, /r\.name/, "and never by a field the backend does not have");
	// The unused escaper is gone: every string is written as text.
	assert.doesNotMatch(kontainerSource, /const esc = /, "no dead helper is left behind");
	// A re-render draws the detail it already has instead of wiping the box back to "loading…".
	assert.match(kontainerSource, /const cached = state\.details\.get\(detailKey\(kind, id, tab\)\);/, "the fetched detail is remembered per node and tab");
	assert.match(kontainerSource, /if \(cached === undefined \|\| refresh\) fetchDetail\(kind, id, tab, box\);/, "a detail with nothing cached is fetched without being asked twice");
	assert.match(kontainerSource, /if \(tab === "logs"\) return fillLogs\(box, data\.lines\);/, "and the same filler draws it again");
	// The drawer's own roll and wire flow answer a human who asked for less motion.
	assert.match(kontainerCss, /@media \(prefers-reduced-motion: reduce\) \{\n\s*#kontainerDrawer, #kontainerScrim, body\.kontainer-open #kontainerDrawer \{ transition: none; \}/, "the stylesheet stops its own transitions");
	assert.match(kontainerCss, /#kontainerDrawer \* \{ animation: none !important; \}/, "and every animation inside it");
});

test("a long engine error wraps inside a rounded bubble", () => {
	// A failed action quotes the engine verbatim, container ids and all, so the bubble is a box that
	// wraps its text rather than a pill that clips a line running past its edge.
	assert.match(kontainerCss, /#kontainerDrawer \.k-toast \{[^}]*border-radius:10px/, "the toast has rounded corners, not circled sides");
	assert.doesNotMatch(kontainerCss, /#kontainerDrawer \.k-toast \{[^}]*border-radius:999px/, "which a pill radius would undo");
	assert.match(kontainerCss, /#kontainerDrawer \.k-toast \{[^}]*white-space:normal/, "its text wraps to a second line");
	assert.match(kontainerCss, /#kontainerDrawer \.k-toast \{[^}]*overflow-wrap:anywhere/, "and a container id with no space in it breaks");
	assert.match(kontainerCss, /#kontainerDrawer \.k-toast \{[^}]*font:12px\/1\.45 var\(--k-mono\)/, "its lines are spaced for reading");
	assert.match(kontainerCss, /#kontainerDrawer \.k-toast \{[^}]*max-width:min\(560px,90vw\)/, "it stops short of the screen edge");
});

test("docker actions pop as blue running tasks, then green or red", () => {
	// The skeleton carries the queue beside the plain toast, and each action owes one card.
	assert.match(kontainerSource, /<div class="k-tasks" id="kTasks" role="status" aria-live="polite"><\/div>/, "the queue hangs beside the toast");
	assert.match(kontainerSource, /payload\?\.action === "exec\.cmd" \? null : startTask\(okMsg/, "only exec.cmd, which only builds a string, never pops");
	assert.match(kontainerSource, /function startTask\(label\) \{/, "one starter makes one card");
	assert.match(kontainerSource, /host\.append\(card\);/, "and appends it, so parallel actions stack rather than replace");
	assert.match(kontainerSource, /function finishTask\(task, ok, detail\) \{/, "and one finisher closes it");
	assert.match(kontainerSource, /setTimeout\(\(\) => task\.card\.remove\(\), 2000\);/, "two seconds after it finishes, on its own timer");
	assert.doesNotMatch(kontainerSource, /if \(okMsg\) toast\(okMsg\);/, "the old success toast is not left beside the queue");
	assert.match(kontainerSource, /"k-task k-running"/, "running reads in its own blue");
	assert.match(kontainerCss, /#kontainerDrawer \.k-tasks \{ position:fixed; bottom:14px; right:14px/, "the queue pins to the toast's own corner");
	assert.match(kontainerCss, /#kontainerDrawer \.k-task\.k-running \{ border-color:var\(--k-accent\);/, "running is accented blue");
	assert.match(kontainerCss, /#kontainerDrawer \.k-task\.k-done \{ border-color:rgba\(63,185,80/, "done is green");
	assert.match(kontainerCss, /#kontainerDrawer \.k-task\.k-failed \{ border-color:rgba\(248,81,73/, "failed is red");
	// A failed task already carries its error, so the caller's catch does not copy it.
	assert.match(kontainerSource, /lastTaskFailure && String\(msg\) === lastTaskFailure\.msg/, "the plain toast bows out for the copy the task carries");
});

test("a right press on a card opens the node menu its kind answers to", () => {
	// The menu is a body element of its own, beside the tools popover, and it starts hidden.
	assert.match(kontainerSource, /<div class="k-ctx-menu" id="kCtxMenu" hidden role="menu" aria-label="node actions"><\/div>/, "the skeleton carries the menu");
	// It leaves the drawer at init: a drawer in mid-roll is a transformed box, and it would place the
	// menu 44px off against itself instead of against the window.
	assert.match(kontainerSource, /document\.body\.append\(ctxMenu\);/, "the menu is moved to the page body when the drawer is made");
	assert.match(kontainerCss, /#kCtxMenu \{[^}]*position:fixed/, "the menu is placed on the window, and no drawer ancestor can claim it");
	assert.doesNotMatch(kontainerCss, /#kontainerDrawer \.k-ctx/, "no rule for the menu hangs off the drawer it left");
	assert.match(kontainerCss, /#kCtxMenu\[hidden\] \{ display:none; \}/, "a closed menu draws nothing");
	assert.match(kontainerCss, /#kCtxMenu \.k-ctx-sep \{[^}]*background:var\(--k-border\)/, "the items are parted by a hairline");
	assert.match(kontainerCss, /#kCtxMenu \.k-ctx-item:disabled \{ color:var\(--k-muted\)/, "an item that cannot act reads muted");
	assert.match(kontainerCss, /#kCtxMenu \.k-ctx-item\.k-danger-item \{ color:var\(--k-red\); \}/, "and the one that removes reads red in the drawer's own palette");
	// The tokens live on the drawer, so the menu carries them too and keeps its dark styling outside it.
	assert.match(kontainerCss, /#kontainerDrawer, #kCtxMenu \{\n\s*--k-bg: #0d1117;[^\n]*--k-card: #161b22;/, "the palette is declared on the drawer and the menu alike");
	assert.match(kontainerCss, /#kCtxMenu, #kCtxMenu \*, #kCtxMenu \*::before, #kCtxMenu \*::after \{ box-sizing: border-box; \}/, "and the menu keeps the drawer's box model");
	// One listener on the shared card decorator serves all three builders; no builder adds its own.
	assert.match(kontainerSource, /function focusClasses\(card, id, related\) \{[\s\S]*?card\.addEventListener\("contextmenu"/, "the shared card decorator listens for the right press");
	assert.equal(kontainerSource.match(/"contextmenu"/g)?.length, 1, "and no builder listens a second time");
	// The five tables speak the inspector's words, and the kind of a node picks its own.
	for (const kind of ["image", "container", "port", "network", "volume", "source"]) {
		assert.match(kontainerSource, new RegExp(`\\b${kind}Ctx\\b`), `a ${kind} node has a menu of its own`);
	}
	assert.match(kontainerSource, /const CTX_MENUS = \{ image: imageCtx, container: containerCtx, port: portCtx, network: networkCtx, volume: volumeCtx, source: sourceCtx \};/, "the kind of a node picks its table");
	// Placed where the press was, pulled back inside the window by the box the menu really drew.
	assert.match(kontainerSource, /const box = ctxMenu\.getBoundingClientRect\(\);/, "the menu is measured before it is placed");
	assert.match(kontainerSource, /Math\.max\(4, Math\.min\(at\.x, window\.innerWidth - box\.width - 4\)\)/, "the left edge stays on the window");
	assert.match(kontainerSource, /Math\.max\(4, Math\.min\(at\.y, window\.innerHeight - box\.height - 4\)\)/, "and so does the top");
	assert.match(kontainerSource, /ctxMenu\.querySelector\("button:not\(:disabled\)"\)\?\.focus\(\);/, "the first item that can act takes the keyboard");
});

test("a right press opens the menu without the selection or the inspector following it", () => {
	// The press belongs to the menu alone: it selects nothing, so a shut inspector stays shut and an
	// open one stays open, and `inspect`/`layers` are the only items that mean "show me this node".
	const handler = kontainerSource.match(/card\.addEventListener\("contextmenu", \(event\) => \{[\s\S]*?\n    \}\);/)?.[0];
	assert.ok(handler, "the card decorator's right-press listener is found whole");
	assert.doesNotMatch(handler, /state\.selected/, "a right press assigns no selection");
	assert.doesNotMatch(handler, /render\(|renderInspector\(|showTab\(/, "and repaints no panel");
	assert.match(handler, /ctxOpen\(/, "it opens the menu on the node it read");
	// Every item runs against the copy the menu held at the press, never against a selection.
	assert.match(kontainerSource, /ctxHeld = \{ kind, id: entity\.id, node: \{ \.\.\.entity \} \};/, "the menu keeps its own snapshot of the node");
	assert.match(kontainerSource, /const item = CTX_MENUS\[held\.kind\]\?\.\(held\.node\)\.find\(\(one\) => one\.id === id\);/, "and every press runs against that snapshot");
	for (const kind of ["image", "container", "port", "network", "volume", "source"]) {
		const table = kontainerSource.match(new RegExp(`function ${kind}Ctx\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0];
		assert.ok(table, `the ${kind} table is found whole`);
		assert.doesNotMatch(table, /state\.selected/, `the ${kind} menu reads no selection`);
	}
	// The two items that name the inspector are the only ones that select, and they say which tab.
	assert.match(kontainerSource, /function showTab\(kind, id, tab\) \{ state\.selected = \{ kind, id \}; state\.tab = tab; renderInspector\(\); \}/, "one helper opens the inspector on the node the item names");
	assert.equal(kontainerSource.match(/run: \(\) => showTab\(/g)?.length, 4, "and only the inspect, layers and source preview items call it");
	assert.match(kontainerSource, /\{ id: "inspect", label: "inspect", run: \(\) => showTab\("image", img\.id, "inspect"\) \}/, "the image inspect item selects and opens the inspector");
	assert.match(kontainerSource, /\{ id: "layers", label: "layers", run: \(\) => showTab\("image", img\.id, "layers"\) \}/, "so does the image layers item");
	assert.match(kontainerSource, /\{ id: "inspect", label: "inspect", run: \(\) => showTab\("container", c\.id, "inspect"\) \}/, "and the container inspect item");
	assert.match(kontainerSource, /\{ id: "preview", label: "inspect", run: \(\) => showTab\("source", src\.id, "preview"\) \}/, "and the source preview item");
});

test("Escape and a press outside put the node menu away before the tools and the selection", () => {
	// The menu is a page element, so the roll up is the only thing that can take it down with the drawer.
	assert.match(kontainerSource, /afterClose\(\) \{\n\s*\/\/ The menu is a page element now[^\n]*\n\s*scrim\.hidden = true; stopLive\(\); ctxClose\(\);/, "rolling the drawer up puts the menu away with it");
	// The drawer's own Escape order: a sheet, then the node menu, then the tools, the filter, the selection.
	assert.match(kontainerSource, /if \(!sheet\.hidden\) \{ sheet\.hidden = true; return true; \}\n\s*if \(!ctxMenu\.hidden\) \{[^\n]*ctxClose\(\);[^\n]*return true; \}\n\s*if \(!toolsMenu\.hidden\)/, "the sheet goes first, the node menu second, the tools third");
	assert.match(kontainerSource, /if \(!ctxMenu\.hidden\) \{[^\n]*const id = ctxHeld\?\.id \?\? state\.selected\?\.id;[^\n]*focusNode\(id\);[^\n]*return true; \}/, "and the keyboard comes back to the card the menu was opened on");
	assert.match(kontainerSource, /document\.addEventListener\("pointerdown", \(event\) => \{\n\s*if \(ctxMenu\.hidden\) return;\n\s*if \(event\.target\.closest\?\.\("#kCtxMenu"\)\) return;\n\s*ctxClose\(\);/, "a press anywhere else closes it, the files menu's own shape");
	assert.match(kontainerSource, /if \(event\.key === "Tab"\) \{ ctxClose\(\); return; \}/, "Tab puts it away");
	assert.match(kontainerSource, /const step = event\.key === "ArrowDown" \? 1 : -1;\n\s*buttons\[\(at \+ step \+ buttons\.length\) % buttons\.length\]\?\.focus\(\);/, "the two arrows walk the items that can act");
});

test("the menu copies through the browser's clipboard, and the volume menu prunes volumes", () => {
	// A board opened over the network is not a secure context, so a missing or refused clipboard shows the value.
	assert.match(kontainerSource, /if \(!navigator\.clipboard\?\.writeText\) \{ toast\(value\); return; \}/, "there is one guarded clipboard call");
	assert.match(kontainerSource, /navigator\.clipboard\.writeText\(value\)\.then\(\(\) => toast\("copied"\), \(\) => toast\(value\)\);/, "and a refusal carries the value it could not copy");
	// The volume sheet names no count: the topology only carries mounted volumes, so a count of unused
	// ones read zero however many dangling volumes the engine holds. The image sheet's count is real.
	const pruneSheet = kontainerSource.match(/} else if \(tool === "prune"\) \{[\s\S]*?\n    } else if \(tool === "df"\)/)?.[0];
	assert.ok(pruneSheet, "the prune sheet is found whole");
	assert.doesNotMatch(pruneSheet, /prune \$\{unused\.length\} volume/, "the volume press counts nothing it cannot count");
	assert.doesNotMatch(pruneSheet, /Prune \$\{unused\.length\} unused volume/, "and neither does its note");
	assert.match(pruneSheet, /Docker will remove anonymous and unused volumes not referenced by any container\. This cannot be undone\./, "the note says what Docker does instead of naming a number");
	assert.match(pruneSheet, /finish\(target === "volumes" \? "prune unused volumes" : `prune \$\{unused\.length\} image\(s\)`/, "the volume press names the act, and the image press keeps its real count");
	// The sheet takes the target it is asked for, and every caller that names none keeps the images it had.
	assert.match(kontainerSource, /run: \(\) => openSheet\("prune", \{ target: "volumes" \}\)/, "the volume menu asks the sheet for volumes");
	assert.match(kontainerSource, /const target = preset\?\.target === "volumes" \? "volumes" : "images";/, "and the sheet defaults to images");
	assert.equal(kontainerSource.match(/openSheet\("prune"\)/g)?.length, 3, "the tray, the tools menu and `> prune` still ask for the image sheet");
	assert.match(kontainerSource, /disabled: w\.mountKind !== "volume", hint: "a bind mount has no volume to prune"/, "a bind mount offers no prune, and says why");
});

test("the menu's kill arm repaints the inspector it armed, and only for the node it names", () => {
	// The menu puts itself away before the item runs, so the press that arms the kill would otherwise leave
	// the inspector's button reading `kill` while it waits for its second press. The arming is one helper
	// the inspector's own button and the menu share, and it repaints only the node the panel already shows.
	const arm = kontainerSource.match(/function armKill\(c\) \{[\s\S]*?\n  \}/)?.[0];
	assert.ok(arm, "the kill arming is one helper the inspector and the menu share");
	assert.equal(arm.match(/renderInspector\(false\)/g)?.length, 2, "the press and its three-second reset both repaint the button");
	assert.match(arm, /state\.selected\?\.kind === "container" && state\.selected\.id === c\.id/, "and only when the panel is on that container");
	assert.match(kontainerSource, /if \(state\.armedKill !== c\.id\) \{ armKill\(c\); toast\(/, "the menu's kill item arms through it");
	assert.match(kontainerSource, /if \(!armed\) return armKill\(c\);/, "and so does the inspector's own button");
});

test("a wire card and its inspector name a mount's own kind, not the column it is drawn in", () => {
	// `volume` and `bind` ride beside the `vol` column, so a mounted folder never reads as a volume.
	assert.match(kontainerSource, /const items = list\.map\(\(n\) => \(\{ \.\.\.n, kind, mountKind: n\.kind \}\)\)/, "the mount's kind survives the spread that paints the column's");
	assert.match(kontainerSource, /`\$\{w\.mountKind \|\| w\.kind \|\| ""\} · \$\{w\.destination/, "the card names the mount's kind");
	assert.match(kontainerSource, /kvRow\("kind", w\.mountKind \|\| w\.kind \|\| "—"\)/, "and so does the inspector's kind row");
});

test("open in browser reaches the port through a host a browser can dial", () => {
	// An any-interface bind and an IPv6 literal are not authorities a browser resolves, so the first reads
	// as `localhost` and the second gets its brackets back; the tab it opens cannot reach back into the board.
	const open = kontainerSource.match(/const openHost = \(ip\) => \{[\s\S]*?\n  \};/)?.[0];
	assert.ok(open, "the host is mapped in one place");
	assert.match(open, /if \(host === "0\.0\.0\.0" \|\| host === "::"\) return "localhost";/, "a wildcard bind is dialled at localhost");
	assert.match(open, /host\.includes\(":"\) \? `\[\$\{host\}\]` : host;/, "and an IPv6 literal keeps the brackets a URL needs");
	assert.match(kontainerSource, /window\.open\(`http:\/\/\$\{openHost\(w\.hostIp\)\}:\$\{w\.hostPort\}`, "_blank", "noopener"\)/, "the port opens through it, and the tab is opened without a handle back");
});

test("a keyboard press opens the menu on the card it was pressed on", () => {
	// `Shift+F10` and the menu key fire a `contextmenu` with no point of their own, so the menu opens at the
	// card's corner instead of pinned to the window's.
	const open = kontainerSource.match(/function ctxOpen\(kind, entity, event, card\) \{[\s\S]*?\n  \}/)?.[0];
	assert.ok(open, "the menu takes the card it was opened on");
	assert.match(open, /const at = !event\.clientX && !event\.clientY \? \{ x: rect\.left \+ 16, y: rect\.top \+ 16 \}/, "a press with no point is placed on the card");
	assert.match(kontainerSource, /ctxOpen\(cardKind === "wire" \? \{ port: "port", net: "network", vol: "volume" \}\[node\.kind\] : cardKind, node, event, card\);/, "and the one card decorator hands its card in");
});

test("00 Sources stratum sits first, with its own accent and meta", () => {
	assert.match(kontainerSource, /<span class="k-stratum-label"><span class="k-idx">00<\/span> Sources · Definitions<\/span><span class="k-stratum-meta" id="kMetaSources">/, "the skeleton carries the sources stratum first");
	assert.match(kontainerSource, /<div class="k-col-list" id="kSources"><\/div>/, "and its column list");
	assert.match(kontainerSource, /const composeCount = sources\(\)\.filter\(\(s\) => s\.kind === "compose"\)\.length;/, "the meta counts compose files");
	assert.match(kontainerSource, /`\$\{composeCount\} compose · \$\{buildFileCount\} file\$\{buildFileCount === 1 \? "" : "s"\}`/, "and build files");
	assert.match(kontainerCss, /--k-cyan: #56d4dd/, "the drawer carries the cyan accent");
	assert.match(kontainerCss, /\.k-stratum-head\.k-stratum-sources \{[^}]*rgba\(86,212,221,\.35\)/, "the sources head is cyan-lined");
	assert.match(kontainerCss, /grid-template-columns:minmax\(220px,\.95fr\) minmax\(205px,\.88fr\) minmax\(290px,1\.38fr\) minmax\(205px,\.86fr\); gap:42px/, "four strata draw the grid");
	assert.match(kontainerCss, /#kontainerDrawer \.k-stage \{[^}]*min-width:1020px/, "the stage is wide enough for four columns");
	assert.match(kontainerCss, /\.k-src-card\.k-src-compose \{ border-left-color:var\(--k-cyan\); \}/, "compose cards lean cyan");
	assert.match(kontainerCss, /\.k-src-card\.k-src-containerfile \{ border-left-color:var\(--k-purple\); \}/, "containerfiles lean purple");
	assert.match(kontainerCss, /\.k-src-card\.k-src-unbuilt \{ border-style:dashed/, "an unbuilt source reads dashed");
});

test("source cards name their kind, badge, services and output jack", () => {
	assert.match(kontainerSource, /function buildSourceCard\(src, related\) \{/, "the builder exists");
	assert.match(kontainerSource, /card\.dataset\.nodeId = src\.id; card\.dataset\.kind = "source";/, "the card carries a source node id");
	assert.match(kontainerSource, /src\.kind === "compose" \? "C" : src\.kind === "dockerfile" \? "D" : "CF"/, "C, D and CF badges");
	assert.match(kontainerSource, /el\("span", `k-mini-dot \$\{s\.state\}`\)/, "service pills carry a state dot");
	assert.match(kontainerSource, /jack\.dataset\.jack = `\$\{src\.id\}-out`/, "the source card draws the output jack");
	assert.match(kontainerSource, /jackL\.dataset\.jack = `\$\{img\.id\}-in`;/, "and the image card draws the input jack the source wire lands on");
	assert.match(kontainerSource, /"compose stacks"/, "sources group compose stacks first");
	assert.match(kontainerSource, /"dockerfiles & containerfiles"/, "then dockerfiles & containerfiles");
	assert.match(kontainerSource, /"no compose or containerfiles"/, "an empty workspace says so");
	assert.match(kontainerSource, /"no sources match"/, "and a filter that matches nothing says that");
	// The wire from a source to its image is drawn in the kind's colour, dashed, and amber when drifted.
	assert.match(kontainerSource, /`k-src \$\{drift\}/, "source wires are dashed");
	assert.match(kontainerSource, /s\.edited \|\| img\?\.drift\) stroke = "#d29922"/, "drift wires read amber");
	assert.match(kontainerSource, /s\.kind === "compose"\) stroke = "#56d4dd"/, "compose wires read cyan");
	assert.match(kontainerSource, /const src = findSource\(id\);/, "a source is a focusable node");
	assert.match(kontainerSource, /sources\(\)\.filter\(\(s\) => \(s\.imageIds \|\| \[\]\)\.includes\(img\.id\)\)/, "an image pulls its sources into focus");
});

test("sourceCtx runs against the snapshot, and only preview opens the inspector", () => {
	const table = kontainerSource.match(/function sourceCtx\(src\) \{[\s\S]*?\n  \}/)?.[0];
	assert.ok(table, "the source table is found whole");
	assert.doesNotMatch(table, /state\.selected/, "the source menu reads no selection");
	assert.match(table, /\{ id: "openFile", label: "open file", run: \(\) => openSourceFile\(src\.relPath\) \}/, "open file hands the path to the board");
	assert.match(table, /\{ id: "copyPath", label: "copy path", run: \(\) => copyText\(src\.relPath\) \}/, "and copies it");
	assert.match(table, /action: "compose\.up", file: src\.relPath/, "compose up names the file");
	assert.match(table, /action: "compose\.restart", file: src\.relPath/, "restart does too");
	assert.match(table, /action: "compose\.down", file: src\.relPath/, "down does too");
	assert.match(table, /disabled: src\.unbuilt, hint: "no stack containers are up"/, "down says why it is greyed on an unbuilt stack");
	assert.match(table, /execToTerminal\(\{ mode: "compose-logs", composeFile: src\.relPath \}\)/, "logs go to the terminal");
	assert.match(table, /openSheet\("build", \{ dockerfile: src\.relPath, context: src\.dir === "\.\/" \? "\." : src\.dir\.replace/, "a build opens the sheet prefilled, context and all");
	assert.match(table, /noCache: true/, "and the no-cache build carries it");
});

test("the board hands a source path to the editor, and the drawer closes first", () => {
	assert.match(board, /openWorkspaceFile: \(relPath\) => \{ kontainerDrawer\.close\(\); exEditOpen\(relPath, "edit"\); \}/, "the drawer rolls up and the file opens");
	assert.match(kontainerSource, /export function createKontainerDrawer\(\{ workspace, typingSomewhere, openTerminalCommand, openWorkspaceFile \}\)/, "the drawer takes the door");
	assert.match(kontainerSource, /function openSourceFile\(relPath\) \{\n\s*if \(typeof openWorkspaceFile === "function"\) openWorkspaceFile\(relPath\);\n\s*else toast\(relPath\);/, "and toasts the path when the board gave none");
	// Card actions never select the card they sit on.
	assert.match(kontainerSource, /openBtn\.onclick = \(e\) => \{ e\.stopPropagation\(\); openSourceFile\(src\.relPath\); \};/, "open stops propagation");
	assert.match(kontainerSource, /up\.onclick = \(e\) => \{ e\.stopPropagation\(\); postAction\(\{ action: "compose\.up", file: src\.relPath \}/, "so does up -d");
});

test("the source inspector previews the file and details its services or build", () => {
	assert.match(kontainerSource, /if \(kind === "source"\) return renderSourceInspector\(findSource\(id\)\);/, "a source click opens its inspector");
	assert.match(kontainerSource, /state\.tab = card\.dataset\.kind === "source" \? "preview"/, "and lands on the preview tab");
	assert.match(kontainerSource, /function renderSourceInspector\(src\) \{/, "the builder exists");
	assert.match(kontainerSource, /inspHead\(src\.kind, src\.relPath, actions\)/, "the head names the kind and the path");
	assert.match(kontainerSource, /actBtn\("compose up -d", "k-primary"/, "compose up -d is primary");
	assert.match(kontainerSource, /actBtn\(src\.unbuilt \? "build image" : "rebuild image", "k-primary"/, "a dockerfile builds or rebuilds");
	assert.match(kontainerSource, /box\.textContent = src\.preview \|\| "\(empty file\)"/, "the preview is text, never html");
	assert.match(kontainerSource, /kvRow\("workspace path", src\.relPath\)/, "the preview tab names the path");
	assert.match(kontainerSource, /kvRow\("base image", src\.baseImage \|\| "—"\)/, "details name the base image");
	assert.match(kontainerSource, /kvRow\("build stages", \(src\.stages \|\| \[\]\)\.length/, "and the stages");
	assert.match(kontainerSource, /kvRow\("exposed ports", \(src\.exposedPorts \|\| \[\]\)\.length/, "and the ports");
});

test("the build sheet takes a preset object with a build context", () => {
	assert.match(kontainerSource, /const presetObj = preset && typeof preset === "object" \? preset : null;/, "an object preset is read as one");
	assert.match(kontainerSource, /presetObj \? String\(presetObj\.dockerfile \|\| ""\) : typeof preset === "string" \? preset : ""/, "and a string preset still works");
	assert.match(kontainerSource, /field\("Build Context", "kBuildContext", presetObj\?\.context \|\| "\."\)/, "the context field pre-fills");
	assert.match(kontainerSource, /field\("Image tag", "kBuildTag", presetObj\?\.tag \|\|/, "so does the tag");
	assert.match(kontainerSource, /const noCache = check\("no cache", "kBuildNoCache", !!presetObj\?\.noCache\);/, "and the no-cache box");
	assert.match(kontainerSource, /action: "build", dockerfile: df\.value\.trim\(\), context: ctx\.value\.trim\(\) \|\| "\."/, "the build carries the context");
	assert.match(kontainerSource, /Array\.isArray\(state\.data\?\.sources\)/, "older payloads synthesize sources instead of crashing");
});

test("an empty workspace hint stays accurate when sources are recognized, and unavailable runtimes keep their scanned sources", () => {
	assert.match(kontainerSource, /\(s\.workspaceContainers \?\? 0\) === 0 && \(s\.allContainers \?\? 0\) > 0 && sources\(\)\.length === 0/, "sources suppress the every-container claim");
	assert.match(kontainerSource, /if \(data\.available === false\) \{ showUnavailable\(data\.reason \|\| "no container runtime is available", data\); return; \}/, "showUnavailable receives the state payload");
	assert.match(kontainerSource, /sources: Array\.isArray\(existing\?\.sources\) \? existing\.sources : \[\],/, "and preserves recognized sources when no engine socket is up");
});

/** The terminal drawer's `runCommand`, on the page it reads and the socket it writes to. */
class FakeElement {
	textContent = "";
	title = "";
	hidden = false;
	disabled = false;
	inert = true;
	className = "";
	offsetParent: unknown = {};
	isConnected = true;
	focused = false;
	children: FakeElement[] = [];
	attributes = new Map<string, string>();
	classes = new Set<string>();
	listeners: Array<{ type: string; fn: () => void }> = [];

	classList = {
		toggle: (name: string, on: boolean) => (on ? this.classes.add(name) : this.classes.delete(name)),
		contains: (name: string) => this.classes.has(name),
		add: (name: string) => void this.classes.add(name),
		remove: (name: string) => void this.classes.delete(name),
	};

	setAttribute(name: string, value: string) {
		this.attributes.set(name, value);
	}

	getAttribute(name: string) {
		return this.attributes.get(name) ?? null;
	}

	addEventListener(type: string, fn: () => void) {
		this.listeners.push({ type, fn });
	}

	append(child: FakeElement) {
		this.children.push(child);
	}

	focus() {
		this.focused = true;
	}

	blur() {
		this.focused = false;
	}

	get parentElement() {
		return new FakeElement();
	}
}

/** The board's page, as much of it as the terminal drawer looks at. */
function standInPage() {
	const ids = ["termDrawer", "termHost", "termBtn", "tdClose", "tdStatus", "tdWorkspace", "termGrip"];
	const elements = new Map(ids.map((id) => [id, new FakeElement()]));
	const body = new FakeElement();
	const store = new Map<string, string>();
	Object.assign(globalThis, {
		document: {
			body,
			activeElement: null,
			documentElement: { style: { setProperty: () => {} } },
			getElementById: (id: string) => elements.get(id) ?? null,
			createElement: () => new FakeElement(),
		},
		localStorage: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, value),
		},
		Element: FakeElement,
		window: { addEventListener: () => {}, innerHeight: 1000 },
		location: { protocol: "http:", host: "127.0.0.1" },
	});
	return body;
}

class FakeTerminal {
	cols = 100;
	rows = 30;

	constructor(_opts: Record<string, unknown>) {}
	loadAddon(_addon: unknown) {}
	open(_host: unknown) {}
	onData(_fn: (data: string) => void) {}
	write(_data: string) {}
	focus() {}
	reset() {}
}

/** A socket that starts where the platform starts one: connecting, not yet open. */
class FakeSocket {
	static OPEN = 1;
	static instances: FakeSocket[] = [];
	readyState = 0;
	sent: string[] = [];
	listeners = new Map<string, Array<(event: unknown) => void>>();

	constructor(_url: string) {
		FakeSocket.instances.push(this);
	}

	addEventListener(type: string, fn: (event: unknown) => void) {
		const held = this.listeners.get(type) ?? [];
		held.push(fn);
		this.listeners.set(type, held);
	}

	fire(type: string, event: unknown = {}) {
		if (type === "open") this.readyState = FakeSocket.OPEN;
		for (const fn of this.listeners.get(type) ?? []) fn(event);
	}

	send(data: string) {
		this.sent.push(data);
	}

	close() {
		this.readyState = 3;
	}
}

/** The module, loaded once with the stand-in page and the vendored library already in place. */
async function drawerFor(workspace: string) {
	Object.assign(globalThis, { Terminal: FakeTerminal, FitAddon: { FitAddon: class { fit() {} } }, WebSocket: FakeSocket });
	const module = (await import(new URL("../public/client/terminal-drawer.js", import.meta.url).href)) as {
		createTerminalDrawer: (init: { workspace: string; typingSomewhere: () => boolean }) => {
			isOpen: () => boolean;
			open: () => void;
			close: () => void;
			runCommand: (command: string) => void;
		};
	};
	return module.createTerminalDrawer({ workspace, typingSomewhere: () => false });
}

test("a command handed over before the socket is up is typed in when it opens", async () => {
	standInPage();
	FakeSocket.instances = [];
	const drawer = await drawerFor("b08b6688eaf9");
	drawer.runCommand("docker logs -f 1a2b3c");
	assert.equal(drawer.isOpen(), true, "the command rolls the drawer up");
	assert.equal(FakeSocket.instances.length, 1, "the first command starts the shell");
	const socket = FakeSocket.instances[0];
	assert.deepEqual(socket.sent, [], "nothing is written to a socket that is still opening");
	socket.fire("open");
	const typed = socket.sent.map((one) => JSON.parse(one)).filter((one) => one.type === "input");
	assert.deepEqual(typed, [{ type: "input", data: "docker logs -f 1a2b3c\r" }], "the enter the human would have pressed is part of it");
});

test("a command handed over to an open shell goes straight in", async () => {
	standInPage();
	FakeSocket.instances = [];
	const drawer = await drawerFor("b08b6688eaf9");
	drawer.open();
	const socket = FakeSocket.instances[0];
	socket.fire("open");
	drawer.runCommand("docker exec -it 1a2b3c sh");
	const typed = socket.sent.map((one) => JSON.parse(one)).filter((one) => one.type === "input");
	assert.deepEqual(typed, [{ type: "input", data: "docker exec -it 1a2b3c sh\r" }]);
	assert.equal(FakeSocket.instances.length, 1, "the shell that is up is the one the command goes into");
});

test("an empty command neither rolls the drawer up nor starts a shell", async () => {
	standInPage();
	FakeSocket.instances = [];
	const drawer = await drawerFor("b08b6688eaf9");
	drawer.runCommand("");
	assert.equal(drawer.isOpen(), false);
	assert.equal(FakeSocket.instances.length, 0);
});

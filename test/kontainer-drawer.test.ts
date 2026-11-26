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

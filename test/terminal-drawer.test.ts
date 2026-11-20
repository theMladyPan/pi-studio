import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The terminal drawer's bar, without a browser.
 *
 * `public/client/terminal-drawer.js` reads six elements of the board's page and one listener on
 * `window`, so a stand-in carrying exactly that much answers it. The terminal library is absent
 * here, so opening the drawer stops at "the terminal library did not load" and never touches a
 * socket — which is what this covers: the bar's name, the roll up and down, and the no-folder
 * board that says so instead of connecting.
 */

/** One element as far as the drawer touches it: its text, its classes, its attributes and its listeners. */
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

type Page = { elements: Map<string, FakeElement>; body: FakeElement; style: Map<string, string>; store: Map<string, string> };

/** The board's page, as much of it as the drawer looks at. */
function standInPage(): Page {
	const ids = ["termDrawer", "termHost", "termBtn", "tdClose", "tdStatus", "tdWorkspace", "termGrip"];
	const elements = new Map(ids.map((id) => [id, new FakeElement()]));
	const body = new FakeElement();
	const style = new Map<string, string>();
	const store = new Map<string, string>();
	Object.assign(globalThis, {
		document: {
			body,
			activeElement: null,
			documentElement: { style: { setProperty: (name: string, value: string) => void style.set(name, value) } },
			getElementById: (id: string) => elements.get(id) ?? null,
			createElement: () => new FakeElement(),
		},
		localStorage: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, value),
		},
		// The drawer asks whether what had the focus is an `Element`, so the name has to exist.
		Element: FakeElement,
		window: { addEventListener: () => {}, innerHeight: 1000 },
		location: { protocol: "http:", host: "127.0.0.1" },
	});
	return { elements, body, style, store };
}

/** One pointer event on an element, as the grip's listeners take it. */
function fire(el: FakeElement, type: string, event: Record<string, unknown>) {
	for (const { type: held, fn } of el.listeners) if (held === type) (fn as (e: Record<string, unknown>) => void)(event);
}

/** The module, loaded once with the stand-in page already in place. */
async function drawerFor(workspace: string) {
	const module = (await import(new URL("../public/client/terminal-drawer.js", import.meta.url).href)) as {
		createTerminalDrawer: (init: { workspace: string; typingSomewhere: () => boolean }) => {
			isOpen: () => boolean;
			toggle: () => void;
			open: () => void;
			close: () => void;
			setName: (name?: string) => void;
		};
	};
	return module.createTerminalDrawer({ workspace, typingSomewhere: () => false });
}

test("the bar says the workspace id until it is told the name", async () => {
	const { elements } = standInPage();
	const label = elements.get("tdWorkspace")!;
	const drawer = await drawerFor("b08b6688eaf9");
	assert.equal(label.textContent, "· b08b6688eaf9");
	drawer.setName("pi-studio");
	assert.equal(label.textContent, "· pi-studio");
	// A board that has heard no name yet keeps the id rather than dropping it for an empty bar.
	drawer.setName();
	assert.equal(label.textContent, "· b08b6688eaf9");
});

test("one press rolls the drawer up and the next rolls it down", async () => {
	const { elements, body } = standInPage();
	const btn = elements.get("termBtn")!;
	const drawer = await drawerFor("b08b6688eaf9");
	assert.equal(drawer.isOpen(), false);
	drawer.toggle();
	assert.equal(drawer.isOpen(), true, "one press rolls the drawer up");
	assert.equal(body.classList.contains("term-open"), true, "the body class is the animation");
	assert.equal(btn.getAttribute("aria-expanded"), "true");
	assert.match(btn.title, /\(x\)/, "the button names the key it answers");
	drawer.toggle();
	assert.equal(drawer.isOpen(), false, "and the next rolls it down");
	assert.equal(body.classList.contains("term-open"), false);
	assert.equal(btn.getAttribute("aria-expanded"), "false");
});

test("dragging the top edge resizes the drawer, clamped, and remembers the height", async () => {
	const { elements, body, style, store } = standInPage();
	const grip = elements.get("termGrip")!;
	const drawer = await drawerFor("b08b6688eaf9");
	assert.equal(drawer.isOpen(), false);
	// Press on the top edge and drag up: a 1000px screen with the cursor 300px from the top
	// leaves a 700px drawer.
	fire(grip, "pointerdown", { button: 0, pointerId: 1, preventDefault: () => {} });
	assert.equal(body.classList.contains("term-resizing"), true, "the drag holds the board's resize cursor");
	fire(grip, "pointermove", { clientY: 300 });
	assert.equal(style.get("--term"), "700px");
	assert.equal(store.get("board.termHeight"), "700", "the height is remembered, the way the rail's width is");
	// Past the ceiling the drawer stops at 720, and past the floor at 220.
	fire(grip, "pointermove", { clientY: 50 });
	assert.equal(style.get("--term"), "720px");
	fire(grip, "pointermove", { clientY: 950 });
	assert.equal(style.get("--term"), "220px");
	fire(grip, "pointerup", { pointerId: 1 });
	assert.equal(body.classList.contains("term-resizing"), false, "letting go ends the drag");
});

test("a height the drawer was left at is restored on the next board", async () => {
	const { style, store } = standInPage();
	store.set("board.termHeight", "500");
	const drawer = await drawerFor("b08b6688eaf9");
	assert.equal(drawer.isOpen(), false);
	assert.equal(style.get("--term"), "500px");
});

test("closing does not give the keyboard to a hidden toolbox button", async () => {
	const { elements, body } = standInPage();
	const btn = elements.get("termBtn")!;
	const drawer = await drawerFor("b08b6688eaf9");
	(globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement = body;
	body.offsetParent = null;
	drawer.toggle();
	assert.equal(drawer.isOpen(), true);
	// The button now lives in the toolbox menu, so it is hidden whenever the menu is shut.
	btn.offsetParent = null;
	drawer.toggle();
	assert.equal(drawer.isOpen(), false);
	assert.equal(btn.focused, false, "a hidden menu item takes no focus");
});

test("a board with no folder says so instead of opening a terminal", async () => {
	const { elements } = standInPage();
	const host = elements.get("termHost")!;
	const drawer = await drawerFor("");
	assert.equal(host.children.length, 1, "the note stands where the terminal would");
	assert.match(host.children[0].textContent, /no folder/);
	// Opening it still rolls the panel up and down without connecting anywhere.
	drawer.open();
	assert.equal(drawer.isOpen(), true);
	drawer.close();
	assert.equal(drawer.isOpen(), false);
});

/** The vendored terminal library and the socket, as the drawer touches them. */
class FakeTerminal {
	readonly opts: Record<string, unknown>;
	cols = 100;
	rows = 30;
	focused = false;
	resetCount = 0;
	opened = false;

	constructor(opts: Record<string, unknown>) {
		this.opts = opts;
	}

	loadAddon(_addon: unknown) {}
	open(_host: unknown) {
		this.opened = true;
	}
	onData(_fn: (data: string) => void) {}
	write(_data: string) {}
	focus() {
		this.focused = true;
	}
	reset() {
		this.resetCount++;
	}
}

class FakeFit {
	fit() {}
}

class FakeWebSocket {
	static OPEN = 1;
	static instances: FakeWebSocket[] = [];
	readyState = FakeWebSocket.OPEN;
	sent: string[] = [];
	listeners = new Map<string, Array<(event: unknown) => void>>();
	url: string;

	constructor(url: string) {
		this.url = url;
		FakeWebSocket.instances.push(this);
	}

	addEventListener(type: string, fn: (event: unknown) => void) {
		const held = this.listeners.get(type) ?? [];
		held.push(fn);
		this.listeners.set(type, held);
	}

	fire(type: string, event: unknown = {}) {
		for (const fn of this.listeners.get(type) ?? []) fn(event);
	}

	send(data: string) {
		this.sent.push(data);
	}

	close() {
		this.readyState = 3;
		this.fire("close");
	}
}

test("a shell that ends rolls the drawer down, and the next roll up opens a new socket", async () => {
	const { elements, body } = standInPage();
	FakeWebSocket.instances = [];
	Object.assign(globalThis, {
		Terminal: FakeTerminal,
		FitAddon: { FitAddon: FakeFit },
		WebSocket: FakeWebSocket,
	});
	try {
		const drawer = await drawerFor("b08b6688eaf9");
		drawer.open();
		assert.equal(drawer.isOpen(), true);
		assert.equal(FakeWebSocket.instances.length, 1, "the first roll up connects");
		const socket = FakeWebSocket.instances[0];
		socket.fire("open");

		// Ctrl+D ends the shell: the daemon says the shell exited.
		socket.fire("message", { data: JSON.stringify({ type: "exit", code: 0 }) });
		assert.equal(drawer.isOpen(), false, "the drawer rolls down on the shell's end");
		assert.equal(body.classList.contains("term-open"), false);
		assert.equal(socket.readyState, 3, "the dead socket closes with it");

		// The next roll up connects again — a fresh shell, not the dead one.
		drawer.open();
		assert.equal(drawer.isOpen(), true);
		assert.equal(FakeWebSocket.instances.length, 2, "the second roll up connects anew");
		assert.notEqual(FakeWebSocket.instances[1], socket);
	} finally {
		delete (globalThis as Record<string, unknown>).Terminal;
		delete (globalThis as Record<string, unknown>).FitAddon;
		delete (globalThis as Record<string, unknown>).WebSocket;
	}
});

test("a shell that could not start keeps the drawer up with its reason", async () => {
	const { elements, body } = standInPage();
	const status = elements.get("tdStatus")!;
	FakeWebSocket.instances = [];
	Object.assign(globalThis, {
		Terminal: FakeTerminal,
		FitAddon: { FitAddon: FakeFit },
		WebSocket: FakeWebSocket,
	});
	try {
		const drawer = await drawerFor("b08b6688eaf9");
		drawer.open();
		assert.equal(drawer.isOpen(), true);
		const socket = FakeWebSocket.instances[0];
		socket.fire("open");

		// This machine has no pty helper: the daemon says so, and the drawer stays up to be read
		// rather than rolling down over the reason it was told.
		const reason = "this machine has no terminal helper, so no shell can start";
		socket.fire("message", { data: JSON.stringify({ type: "error", data: reason }) });
		assert.equal(drawer.isOpen(), true, "the drawer keeps the reason on screen");
		assert.equal(body.classList.contains("term-open"), true);
		assert.equal(status.textContent, reason);
		assert.equal(status.title, reason, "the whole reason is there to hover, past the bar's cut");
		assert.equal(elements.get("tdClose")!.focused, true, "the bar's button takes the keyboard a dead screen would eat");
		assert.equal(socket.readyState, 3, "the refused socket closes, so the next roll up can start fresh");

		// The daemon's socket closes behind that answer, and the bar keeps the reason rather than
		// replacing it with a disconnection nobody can act on.
		socket.fire("message", { data: JSON.stringify({ type: "exit", code: null }) });
		assert.equal(drawer.isOpen(), true, "a shell that never started did not exit");
		assert.equal(status.textContent, reason);

		// The next roll up connects anew and starts from a quiet bar.
		drawer.close();
		drawer.open();
		assert.equal(FakeWebSocket.instances.length, 2, "the failed socket is not reused");
		FakeWebSocket.instances[1].fire("open");
		assert.equal(status.textContent, "");
	} finally {
		delete (globalThis as Record<string, unknown>).Terminal;
		delete (globalThis as Record<string, unknown>).FitAddon;
		delete (globalThis as Record<string, unknown>).WebSocket;
	}
});

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
	children: FakeElement[] = [];
	attributes = new Map<string, string>();
	classes = new Set<string>();
	listeners: Array<{ type: string; fn: () => void }> = [];

	classList = {
		toggle: (name: string, on: boolean) => (on ? this.classes.add(name) : this.classes.delete(name)),
		contains: (name: string) => this.classes.has(name),
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

	focus() {}

	get parentElement() {
		return new FakeElement();
	}
}

type Page = { elements: Map<string, FakeElement>; body: FakeElement };

/** The board's page, as much of it as the drawer looks at. */
function standInPage(): Page {
	const ids = ["termDrawer", "termHost", "termBtn", "tdClose", "tdStatus", "tdWorkspace"];
	const elements = new Map(ids.map((id) => [id, new FakeElement()]));
	const body = new FakeElement();
	Object.assign(globalThis, {
		document: {
			body,
			activeElement: null,
			getElementById: (id: string) => elements.get(id) ?? null,
			createElement: () => new FakeElement(),
		},
		// The drawer asks whether what had the focus is an `Element`, so the name has to exist.
		Element: FakeElement,
		window: { addEventListener: () => {} },
		location: { protocol: "http:", host: "127.0.0.1" },
	});
	return { elements, body };
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

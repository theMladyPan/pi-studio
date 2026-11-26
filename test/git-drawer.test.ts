import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The header label, without a browser.
 *
 * `public/client/git-drawer.js` reads five elements of the board's page and two listeners on `window`, so
 * a stand-in carrying exactly that much answers it. What this covers is the one thing the header label
 * does: it is shown only while the drawer is open.
 */

/** One element as far as the drawer touches it: its text, its classes, its attributes and its listeners. */
class FakeElement {
	textContent = "";
	title = "";
	hidden = false;
	disabled = false;
	inert = true;
	className = "";
	contentWindow: null = null;
	src = "";
	offsetParent: unknown = {};
	isConnected = true;
	focused = false;
	children: FakeElement[] = [];
	attributes = new Map<string, string>();
	classes = new Set<string>();
	listeners: Array<{ type: string; fn: () => void }> = [];

	classList = {
		toggle: (name: string, on: boolean) => (on ? this.classes.add(name) : this.classes.delete(name)),
		replace: (from: string, to: string) => {
			this.classes.delete(from);
			this.classes.add(to);
		},
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

/** The board's page, as much of it as the drawer looks at, with `#openPanelName` left for the test. */
function standInPage() {
	const ids = ["gitDrawer", "gitScrim", "gdFrame", "gitBtn", "openPanelName"];
	const elements = new Map(ids.map((id) => [id, new FakeElement()]));
	Object.assign(globalThis, {
		document: {
			body: new FakeElement(),
			activeElement: null,
			getElementById: (id: string) => elements.get(id) ?? null,
			createElement: () => new FakeElement(),
		},
		// The drawer asks whether what had the focus is an `Element`, so the name has to exist.
		Element: FakeElement,
		window: { addEventListener: () => {}, open: () => null },
		location: { origin: "http://127.0.0.1" },
	});
	return elements.get("openPanelName") as FakeElement;
}

/** The module, loaded once with the stand-in page already in place. */
async function drawerFor(workspace: string) {
	const module = (await import(new URL("../public/client/git-drawer.js", import.meta.url).href)) as {
		createGitDrawer: (init: { workspace: string; typingSomewhere: () => boolean }) => {
			isOpen: () => boolean;
			toggle: () => void;
			open: () => void;
			close: () => void;
		};
	};
	return module.createGitDrawer({ workspace, typingSomewhere: () => false });
}

test("the header label shows only while the drawer is open", async () => {
	const label = standInPage();
	const drawer = await drawerFor("b08b6688eaf9");
	assert.equal(label.hidden, true, "nothing is visualized while no drawer is open");
	drawer.toggle();
	assert.equal(label.hidden, false, "rolling down names the open drawer");
	drawer.toggle();
	assert.equal(label.hidden, true, "rolling up takes the name with it");
});

test("the drawer keeps the members the board drives", async () => {
	standInPage();
	const drawer = await drawerFor("b08b6688eaf9");
	assert.equal(drawer.isOpen(), false);
	drawer.toggle();
	assert.equal(drawer.isOpen(), true, "one press rolls the drawer down");
	drawer.toggle();
	assert.equal(drawer.isOpen(), false, "and the next rolls it up");
});

test("closing does not give the keyboard to a hidden toolbox button", async () => {
	standInPage();
	const drawer = await drawerFor("b08b6688eaf9");
	const doc = (globalThis as unknown as { document: { body: FakeElement; activeElement: unknown; getElementById: (id: string) => FakeElement | null } }).document;
	const btn = doc.getElementById("gitBtn")!;
	doc.activeElement = doc.body;
	doc.body.offsetParent = null;
	drawer.toggle();
	assert.equal(drawer.isOpen(), true);
	// The button now lives in the toolbox menu, so it is hidden whenever the menu is shut.
	btn.offsetParent = null;
	drawer.toggle();
	assert.equal(drawer.isOpen(), false);
	assert.equal(btn.focused, false, "a hidden menu item takes no focus");
});

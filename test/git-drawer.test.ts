import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The drawer's bar, without a browser.
 *
 * `public/client/git-drawer.js` reads six elements of the board's page and two listeners on `window`, so
 * a stand-in carrying exactly that much answers it. What this covers is the one thing the bar says: the
 * workspace name it is told, and the workspace id it falls back to until it hears one.
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

	focus() {}

	get parentElement() {
		return new FakeElement();
	}
}

/** The board's page, as much of it as the drawer looks at, with `#gdWorkspace` left for the test. */
function standInPage() {
	const ids = ["gitDrawer", "gitScrim", "gdFrame", "gdTab", "gdClose", "gitBtn", "gdWorkspace"];
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
	return elements.get("gdWorkspace") as FakeElement;
}

/** The module, loaded once with the stand-in page already in place. */
async function drawerFor(workspace: string) {
	const module = (await import(new URL("../public/client/git-drawer.js", import.meta.url).href)) as {
		createGitDrawer: (init: { workspace: string; typingSomewhere: () => boolean }) => {
			isOpen: () => boolean;
			toggle: () => void;
			open: () => void;
			close: () => void;
			setName: (name?: string) => void;
		};
	};
	return module.createGitDrawer({ workspace, typingSomewhere: () => false });
}

test("the bar says the workspace id until it is told the name", async () => {
	const label = standInPage();
	const drawer = await drawerFor("b08b6688eaf9");
	assert.equal(label.textContent, "· b08b6688eaf9");
	drawer.setName("pi-studio");
	assert.equal(label.textContent, "· pi-studio");
	// A board that has heard no name yet keeps the id rather than dropping it for an empty bar.
	drawer.setName();
	assert.equal(label.textContent, "· b08b6688eaf9");
});

test("being told the name keeps the members the board drives", async () => {
	const label = standInPage();
	const drawer = await drawerFor("b08b6688eaf9");
	drawer.setName("pi-studio");
	assert.equal(drawer.isOpen(), false);
	drawer.toggle();
	assert.equal(drawer.isOpen(), true, "one press rolls the drawer down");
	drawer.toggle();
	assert.equal(drawer.isOpen(), false, "and the next rolls it up");
	assert.equal(label.textContent, "· pi-studio", "rolling the drawer changes nothing the bar says");
});

import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * The shared text surface, without a browser.
 *
 * `public/client/text-preview.js` is one module for two pages: the drawer's editor and the git graph's
 * reader. Its colouring is pure and is tested directly; its surface is a `<pre>` and a `<textarea>`
 * under a container, so a stand-in carrying exactly what the builder touches answers it. What that
 * leaves uncovered is how the layers line up and scroll together, which is the page's CSS and is
 * checked by eye.
 */

/** The module, loaded as the pages load it. Nothing at its top level reaches for the page. */
const module = async () =>
	(await import(new URL("../public/client/text-preview.js", import.meta.url).href)) as {
		escapeHtml: (text: unknown) => string;
		languageOf: (path: string) => string;
		highlight: (raw: string, language?: string) => string;
		PLAIN_LANGUAGE: string;
		createTextPreview: (
			container: FakeElement,
			options?: { readOnly?: boolean; onInput?: (text: string) => void },
		) => {
			setDocument: (next: { path: string; content: string }) => void;
			getText: () => string;
			focus: () => void;
			setLine: (line: number) => void;
			getPath: () => string;
		};
	};

/** One element as far as the surface touches it: its name, its text, its attributes and its children. */
class FakeElement {
	className = "";
	textContent = "";
	value = "";
	readOnly = false;
	spellcheck = true;
	scrollTop = 0;
	scrollLeft = 0;
	innerHTML = "";
	children: FakeElement[] = [];
	attributes = new Map<string, string>();
	classes = new Set<string>();
	listeners: Array<{ type: string; fn: () => void }> = [];
	ownerDocument: FakeElement | null = null;

	classList = {
		add: (name: string) => this.classes.add(name),
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

	append(...children: FakeElement[]) {
		this.children.push(...children);
	}

	replaceChildren(...children: FakeElement[]) {
		this.children = [...children];
	}

	focus() {}
}

/** A container with the stand-in page behind it, which is all `createTextPreview` needs. */
function standInContainer() {
	const document = { createElement: () => new FakeElement() };
	const container = new FakeElement();
	container.ownerDocument = document as unknown as FakeElement;
	return container;
}

test("content that looks like HTML is escaped, never handed to the page as markup", async () => {
	const { highlight } = await module();
	const raw = '<img src=x onerror="alert(1)">';
	for (const language of ["plain", "html", "md", "js"]) {
		const out = highlight(raw, language);
		assert.ok(!out.includes("<img"), `${language} leaves no bare tag behind`);
		assert.ok(!out.includes('onerror="'), `${language} leaves no bare attribute behind`);
		assert.ok(out.includes("&lt;img"), `${language} keeps the text, escaped`);
	}
	// The ampersand is escaped first, so a double escape is what a reader sees rather than a second read.
	assert.equal(highlight("a & b", "plain"), "a &amp; b");
	// The one substitution that is not text is the placeholder a blank line is given.
	assert.equal(highlight("", "plain"), "&nbsp;");
});

test("each language colours its own keywords, strings and comments", async () => {
	const { highlight, languageOf } = await module();
	const kinds = (out: string) => ({ keyword: out.includes('class="k"'), string: out.includes('class="s"'), comment: out.includes('class="c"') });

	const python = highlight('def f(x):\n    return "s"  # note\n', languageOf("a.py"));
	assert.deepEqual(kinds(python), { keyword: true, string: true, comment: true });

	const javascript = highlight('const x = "s"; foo(1); // hi\n', languageOf("a.ts"));
	assert.deepEqual(kinds(javascript), { keyword: true, string: true, comment: true });
	// The name in front of a `(` is the tokenizer's one guess, and it wears the board's `f` colour.
	assert.equal(kinds(highlight("foo(1)", languageOf("a.js"))).keyword, false);
	assert.ok(highlight("foo(1)", languageOf("a.js")).includes('<span class="f">foo</span>'));

	const json = highlight('{ "a": true, "b": 3 }', languageOf("a.json"));
	assert.deepEqual(kinds(json), { keyword: true, string: true, comment: false });

	const markdown = highlight("# Title\n\n`code`\n", languageOf("a.md"));
	assert.ok(markdown.includes('<span class="k"># Title</span>'), "the heading is one keyword");
	assert.ok(markdown.includes('<span class="s">`code`</span>'), "inline code is a string");

	const shell = highlight('if [ -f x ]; then echo "hi" # c\nfi', languageOf("a.sh"));
	assert.deepEqual(kinds(shell), { keyword: true, string: true, comment: true });

	const css = highlight("@media screen { color: #fff; }\n/* c */", languageOf("a.css"));
	assert.deepEqual(kinds(css), { keyword: true, string: false, comment: true });

	const html = highlight('<div class="x">hi</div>\n<!-- c -->', languageOf("a.html"));
	assert.deepEqual(kinds(html), { keyword: true, string: true, comment: true });

	const yaml = highlight("name: value\ntrue: no # c\n", languageOf("a.yml"));
	assert.deepEqual(kinds(yaml), { keyword: true, string: false, comment: true });
});

test("a path chooses its language by extension, and an unknown one is plain", async () => {
	const { languageOf, highlight, PLAIN_LANGUAGE } = await module();
	assert.equal(languageOf("a.py"), "py");
	for (const name of ["a.js", "a.mjs", "a.cjs", "a.ts", "a.tsx", "a.jsx"]) assert.equal(languageOf(name), "js", name);
	assert.equal(languageOf("a.json"), "json");
	assert.equal(languageOf("a.md"), "md");
	assert.equal(languageOf("a.sh"), "sh");
	assert.equal(languageOf("a.css"), "css");
	assert.equal(languageOf("a.html"), "html");
	for (const name of ["a.yaml", "a.yml"]) assert.equal(languageOf(name), "yaml", name);
	// A folder's dots are not the file's extension, and a dotfile has none at all.
	assert.equal(languageOf("dir.with.dots/a.js"), "js");
	assert.equal(languageOf("Makefile"), PLAIN_LANGUAGE);
	assert.equal(languageOf(".bashrc"), PLAIN_LANGUAGE);
	assert.equal(languageOf("a."), PLAIN_LANGUAGE);
	assert.equal(languageOf("query.sql"), PLAIN_LANGUAGE);
	assert.equal(languageOf(""), PLAIN_LANGUAGE);
	// Plain is the board's generic grammar: it colours what the code panels always coloured and nothing
	// a language of its own would.
	const out = highlight("SELECT * FROM t", languageOf("query.sql"));
	assert.ok(!out.includes('<span class="k">'), "no keyword is invented for an unknown extension");
});

test("the surface gives the document back, both before and after a human types into it", async () => {
	const { createTextPreview } = await module();
	const container = standInContainer();
	const preview = createTextPreview(container);
	const content = "def f():\n    return 1\n";
	preview.setDocument({ path: "src/a.py", content });
	assert.equal(preview.getPath(), "src/a.py");
	assert.equal(preview.getText(), content, "the document round-trips untouched");
	// The area is the truth: the second child is the textarea, and its own value is what is read back.
	const area = container.children[1];
	assert.equal(area.value, content);
	assert.ok(container.classes.has("tp"), "the container is the surface the pages style");
	assert.equal(container.children.length, 2, "one layer to read, one to type into");
	area.value = `${content}# typed\n`;
	assert.equal(preview.getText(), `${content}# typed\n`, "what was typed is what would be saved");
	// A read-only surface still shows its text; it only refuses the caret.
	const readOnly = standInContainer();
	const reader = createTextPreview(readOnly, { readOnly: true });
	reader.setDocument({ path: "src/a.py", content });
	assert.equal(readOnly.children[1].readOnly, true);
	assert.equal(reader.getText(), content);
});

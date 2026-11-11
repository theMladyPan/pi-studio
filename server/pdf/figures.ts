/**
 * The charts and diagrams of a note, as pages a browser draws and pixels this daemon keeps.
 *
 * The board draws both of them in the browser with two bundles it already ships, so the drawing here is the
 * board's own: the same chart bundle, the same diagram bundle, the same colours when a config names none.
 * The only difference is the paper — a card is dark and a page is white — so the palette and the diagram's
 * theme are the light ones.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { PUBLIC_DIR } from "../paths.ts";
import { figuresOf } from "./card-pdf.ts";
import type { Figure } from "./card-pdf.ts";
import { SCALE, chromeOnPath, drawPage } from "./chrome.ts";
import type { Picture } from "./write.ts";

/** How many fences one note may have drawn: past this the wait is longer than the page is worth. */
const MOST = 8;

/** A chart is drawn at the card's own size, so the page shows the chart the reader saw. */
const CHART = { width: 400, height: 240 };

/**
 * A diagram is whatever size its own text makes it, and that size is only known once it is drawn, so the
 * page it is drawn on is bigger than any diagram worth putting on a card and the empty paper is cut off.
 */
const DIAGRAM = { width: 1400, height: 1100 };

/** Where a bundle the board already serves lives, as the browser that draws the page will ask for it. */
function served(name: string): string {
	return pathToFileURL(join(PUBLIC_DIR, "client", name)).href;
}

/**
 * A note's own text put into a page as a string, not as html: a fence may hold anything, and the only way it
 * reaches the script is through a literal. The `<` is spelled out because a fence can close the tag itself.
 */
function literal(text: string): string {
	return JSON.stringify(text).replace(/</g, "\\u003c");
}

/**
 * The board's palette, applied only where the config named nothing, so a chart that asked for its own colours
 * keeps them. Copied from the card's own rule rather than shared, because the card's lives in the browser.
 */
const PALETTE = `
function faded(hex) {
  const n = parseInt(hex.slice(1), 16);
  return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + ",0.22)";
}
const colours = ["#58a6ff", "#d29922", "#3fb950", "#db61a2", "#a371f7"];
const sets = Array.isArray(config.data && config.data.datasets) ? config.data.datasets : [];
sets.forEach(function (set, index) {
  if (!set || typeof set !== "object") return;
  const colour = colours[index % colours.length];
  const kind = set.type || config.type;
  if (set.backgroundColor === undefined) set.backgroundColor = kind === "line" || kind === "radar" ? faded(colour) : colour;
  if (set.borderColor === undefined) set.borderColor = colour;
});
`;

/**
 * The head every drawn page starts with: white paper, no margin of its own, no scrollbar to lose pixels, and a
 * rule about what the page may reach for. A fence is a note's own text, and a note can be written by a model or
 * pasted from anywhere, so the page is told the one thing it is allowed to load: the bundle beside it, named by
 * `script`. Everything else — a picture at an address, a stylesheet, an iframe, a font — is refused by the
 * engine before the request leaves the machine, whatever markup the fence carried in.
 */
function start(script = false): string {
	// A page that draws with a bundle allows inline script and a script from a file, which is where the bundle
	// is. A page that only holds a drawing allows no script at all: nothing in a fence has any business running.
	const sources = `default-src 'none'; script-src ${script ? "'unsafe-inline' file:" : "'none'"}; style-src 'unsafe-inline'; img-src data:`;
	return `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${sources}">
<style>
html, body { margin: 0; padding: 0; background: #fff; overflow: hidden; }
body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
</style>`;
}

/** A chart fence, handed to the bundle the board draws it with. */
function chartPage(body: string): string {
	return `${start(true)}<canvas id="chart" width="${CHART.width}" height="${CHART.height}"></canvas>
<script src="${served("chart-umd-min.js")}"></script>
<script>
Chart.defaults.color = "#57606a";
Chart.defaults.borderColor = "#d0d7de";
Chart.defaults.font.family = "system-ui, -apple-system, 'Segoe UI', sans-serif";
const config = JSON.parse(${literal(body)});
${PALETTE}
new Chart(document.getElementById("chart"), {
  ...config,
  options: {
    ...config.options,
    responsive: false,
    maintainAspectRatio: false,
    animation: false,
    devicePixelRatio: ${SCALE},
  },
});
</script>`;
}

/** A diagram fence, drawn by the bundle the card draws it with, in the light theme a page needs. */
function diagramPage(body: string): string {
	return `${start(true)}<div id="out"></div><script src="${served("mermaid-min.js")}"></script>
<script>
mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  // A diagram with a typo in it would otherwise be drawn as a picture of the typo, which is worse than the
  // sentence the card already carries. Silence leaves the page blank, and blank means "keep the description".
  suppressErrorRendering: true,
  theme: "base",
  themeVariables: {
    darkMode: false,
    background: "#ffffff",
    primaryColor: "#eef2f7",
    primaryTextColor: "#1f2328",
    primaryBorderColor: "#9aa4b2",
    secondaryColor: "#f6f8fa",
    tertiaryColor: "#ffffff",
    lineColor: "#57606a",
    textColor: "#1f2328",
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    fontSize: "12px",
  },
});
// The text is read before it is drawn: a diagram with a typo in it is refused here, and the page stays
// blank, which is what tells the daemon to keep the sentence the card already carries instead of handing the
// reader a picture of a syntax error.
const said = ${literal(body)};
mermaid.parse(said).then(function (read) {
  if (read === false) throw new Error("refused");
  return mermaid.render("pi-studio-draw", said);
}).then(function (drawn) {
  document.getElementById("out").innerHTML = drawn.svg;
}).catch(function () {});
</script>`;
}

/**
 * What a drawing fence may keep: the elements a diagram is drawn with. An allowlist rather than a list of the
 * things to take out, because the things to take out are every element the format may grow next year — a
 * `<script>` that never closes, an `<img>` at an address, a `<foreignObject>` carrying html, a `<use>` pointing
 * off the page. A tag that is not named here is dropped with its content, so what is left is a picture.
 */
const SVG_ELEMENTS = new Set([
	"svg", "g", "defs", "symbol", "marker", "pattern", "clipPath", "mask", "linearGradient", "radialGradient",
	"stop", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "textPath",
	"title", "desc", "use", "filter", "feGaussianBlur", "feOffset", "feMerge", "feMergeNode", "feColorMatrix",
	"feBlend", "feDropShadow",
]);

/** Elements whose content is code rather than drawing, so the content goes with the tag. */
const SVG_WITH_CONTENT = new Set(["script", "style", "foreignObject", "iframe", "object", "embed"]);

/**
 * A drawing fence with everything but drawing taken out. Attributes go the same way: an `on…` is an event, and
 * a `href` or `src` is a place the page would reach for. The page's own rule refuses those anyway, so this is
 * the second lock on the same door, and the one that holds if the first is ever loosened.
 */
export function cleanSvg(body: string): string {
	let out = "";
	let at = 0;
	while (at < body.length) {
		const open = body.indexOf("<", at);
		if (open < 0) break;
		out += body.slice(at, open);
		const close = body.indexOf(">", open);
		if (close < 0) break;
		const tag = body.slice(open, close + 1);
		const name = /^<\/?\s*([a-zA-Z][\w:-]*)/.exec(tag);
		const drawn = name && SVG_ELEMENTS.has(name[1]);
		if (drawn) {
			out += tag.replace(/\s+([a-zA-Z_:][\w:.-]*)\s*=\s*("[^"]*"|'[^']*')/g, (whole, key: string) => (/^(on|href|src|xlink:href|style$)/i.test(key) ? "" : whole));
			at = close + 1;
			continue;
		}
		// A tag the page does not draw: a script, a stylesheet or an embedded document goes with everything
		// inside it, and any other unknown tag goes alone, so its words are kept and its effect is not.
		if (name && SVG_WITH_CONTENT.has(name[1]) && !tag.startsWith("</")) {
			const end = body.toLowerCase().indexOf(`</${name[1].toLowerCase()}`, close);
			at = end < 0 ? body.length : end;
			continue;
		}
		at = close + 1;
	}
	return out;
}

/** A drawing fence: what the card inlines, inlined here once everything but the drawing is gone. */
function drawingPage(body: string): string {
	return `${start()}<style>svg { max-width: ${DIAGRAM.width - 60}px; height: auto; }</style><div id="out">${cleanSvg(body)}</div>`;
}

/** The page a fence becomes, and the size of paper it is drawn on. */
function drawingOf(figure: Figure): { html: string; viewport: { width: number; height: number } } {
	if (figure.lang === "chart") return { html: chartPage(figure.body), viewport: CHART };
	if (figure.lang === "mermaid") return { html: diagramPage(figure.body), viewport: DIAGRAM };
	return { html: drawingPage(figure.body), viewport: DIAGRAM };
}

/**
 * Every picture a note asks for, by the place it holds among the note's fences. A fence the browser could not
 * draw is left out, and the page keeps the description it would have carried on a machine with no browser at
 * all: a broken diagram is one missing picture, not a missing document. A note with more fences than one press
 * should wait for keeps descriptions past the eighth, which is still a page worth having.
 */
export async function drawFigures(markdown: string, chrome = chromeOnPath()): Promise<Map<number, Picture>> {
	const drawn = new Map<number, Picture>();
	const figures = figuresOf(markdown).slice(0, MOST);
	if (!figures.length || !chrome) return drawn;
	for (const [index, figure] of figures.entries()) {
		try {
			const { html, viewport } = drawingOf(figure);
			drawn.set(index, await drawPage(html, viewport, chrome));
		} catch {
			// The description stands in, which is the whole point of asking the browser rather than depending on it.
		}
	}
	return drawn;
}

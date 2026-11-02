/* pi board — canvas client. Cards arrive from the daemon over server-sent events. */
const world = document.getElementById("world");
const viewport = document.getElementById("viewport");
// `overflow: clip` keeps the viewport out of the scroll containers, but an engine that ignores
// it (and falls back to `hidden`) would still scroll when the composer or an editor takes
// focus, leaving the pan state behind. Zeroing the offset holds the invariant on every engine.
viewport.addEventListener("scroll", () => {
  viewport.scrollTop = 0;
  viewport.scrollLeft = 0;
});
const emptyHint = document.getElementById("empty");
const live = document.getElementById("live");
const liveText = document.getElementById("liveText");
const liveClock = document.getElementById("liveClock");
const resetBtn = document.getElementById("reset");
const params = new URLSearchParams(location.search);
const token = params.get("token") || "";
// The board is one page for every workspace; the path names the one this tab belongs to, and every
// board route has to carry it.
const workspace = (location.pathname.match(/^\/w\/([0-9a-f]{6,64})\/?$/) || [])[1] || "";
const auth = `token=${encodeURIComponent(token)}${workspace ? `&workspace=${encodeURIComponent(workspace)}` : ""}`;
// The path already says what this page is: `/w/<id>` is a board of threads, whose field lives
// inside a card. Waiting for a frame from the server to decide that left a board looking like a
// one-session board whenever the stream was slow, stale or dead.
if (workspace) document.body.classList.add("threads");

// Kept in step with the code font size in index.html: 13px text, 20px rows.
const LINE_HEIGHT = 20;
const GUTTER = 56;
const view = { x: 0, y: 0, k: 1 };
const cards = [];
const byId = new Map();
let z = 1;
// Z order inside a thread: the newest card on top by default. Someone who wants the other
// way wants it every time, so the choice lives beside the rail's width.
const ORDER_KEY = "board.threadOrder";
let newestFirst = true;
try {
  newestFirst = localStorage.getItem(ORDER_KEY) !== "oldest";
} catch {}
const occupied = [];
let sawFirstCard = false;
/**
 * What a field was carrying, keyed by the card it is written for, `""` being the board itself. A draft
 * belongs to one card, so a card that leaves the board and comes back keeps its words.
 */
const drafts = new Map();
// A snapshot is what is already on the board, so nothing in it is new to the reader.
let replaying = false;
// Only the first snapshot of a session frames the board: a reconnect restores cards the human
// already arranged, so it must leave the view exactly where they left it.
let framedView = false;
let freshCount = 0;

const GAP = 18;
const STEP = 24;

// Cards are sized in columns rather than pixels: code reads at 120 monospace columns, prose and
// chat at 120 characters. Both are measured from the fonts actually in use.
const SOURCE_COLS = 120;
const NOTE_COLS = 120;
let charWidths;

function measureCharWidths() {
  if (charWidths) return charWidths;
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const probe = (font, text) => {
    const span = document.createElement("span");
    span.style.cssText = `position:absolute;left:-9999px;top:0;white-space:pre;font:${font}`;
    span.textContent = text;
    document.body.appendChild(span);
    const perChar = span.getBoundingClientRect().width / text.length;
    span.remove();
    return perChar;
  };
  const prose = "the quick brown fox jumps over a lazy dog, then writes another long line of ordinary prose";
  charWidths = {
    mono: probe(`13px ${cssVar("--mono")}`, "M".repeat(100)),
    prose: probe(getComputedStyle(document.body).font || "13px system-ui, sans-serif", prose),
  };
  return charWidths;
}

/**
 * Default width: gutter, text padding and borders included, so the columns really fit. A note and
 * the question card that answers it share one width, so a thread reads as one column.
 */
function defaultWidth(kind) {
  const widths = measureCharWidths();
  if (kind === "source") return Math.round(52 + 24 + 2 + widths.mono * SOURCE_COLS);
  return Math.round(24 + 2 + widths.prose * NOTE_COLS);
}

const overlaps = (a, b) =>
  a.x < b.x + b.w + GAP && a.x + a.w + GAP > b.x && a.y < b.y + b.h + GAP && a.y + a.h + GAP > b.y;

/** Closest free spot to an anchor, searched outward in rings. The board owns placement, never the agent. */
function findFreeSpot(w, h, anchor) {
  const ax = anchor ? anchor.x : 60;
  const ay = anchor ? anchor.y : 60;
  let best = null;
  let bestScore = Infinity;
  for (let ring = 0; ring < 60; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const x = Math.round((ax + dx * STEP) / STEP) * STEP;
        const y = Math.round((ay + dy * STEP) / STEP) * STEP;
        if (x < 0 || y < 0) continue;
        const rect = { x, y, w, h };
        if (occupied.some((other) => overlaps(rect, other))) continue;
        const score = Math.hypot(x - ax, y - ay);
        if (score < bestScore) {
          bestScore = score;
          best = rect;
        }
      }
    }
    if (best) return best;
  }
  // Every ring was searched and none was free: put the card clear of the whole board, right of
  // the rightmost card and level with the highest one, instead of stacking it on the card that
  // already sits at the anchor.
  const right = occupied.reduce((far, spot) => Math.max(far, spot.x + spot.w), -Infinity);
  const top = occupied.reduce((high, spot) => Math.min(high, spot.y), Infinity);
  // Nothing placed yet (or nothing with a positive edge): the anchor is the whole board.
  if (right === -Infinity || top === Infinity) return { x: ax, y: ay, w, h };
  return { x: right + GAP, y: top, w, h };
}

/** The cards one reply spawned, oldest first: the order they arrived in. */
const threadMates = (thread) => cards.filter((card) => card.dataset.threadRoot === thread);

/**
 * A thread cascades from the card the reply was asked on, like a stack of windows: each card
 * one header lower and a little right, so every title stays readable. A long thread wraps into
 * a column right of the one before it instead of running off the canvas.
 */
const THREAD_STEP_Y = 34;
const THREAD_ROWS = 8;
const rectOf = (card) => JSON.parse(card.dataset.rect);

/**
 * One slot in a cascade: the column origin `right` the cascade opens from, the row it lands on,
 * and the card's size. Column 0 sits under the anchor; a later column clears the widest card of
 * the one before it, so both callers agree on the geometry.
 */
function cascadeSpot(origin, right, position, width, height) {
  const column = Math.floor((position - 1) / THREAD_ROWS);
  const step = ((position - 1) % THREAD_ROWS) + 1;
  return {
    x: (column ? right + GAP : origin.x) + step * STEP,
    y: origin.y + step * THREAD_STEP_Y,
    w: width,
    h: height,
  };
}

function threadSpot(thread, width, height) {
  const anchor = thread ? byId.get(thread) : null;
  const base = anchor && anchor.card.dataset.rect ? rectOf(anchor.card) : null;
  // An anchor that is gone, or a card with no thread, keeps the free-spot rule.
  if (!base) return null;
  const mates = threadMates(thread);
  const placed = [base, ...mates.map(rectOf)];
  const mine = new Set([thread, ...mates.map((card) => card.dataset.id)]);
  // Where the thread already reaches, read from the cards as they sit so sideways drift is
  // included and closing one cannot narrow the column it left behind. A wrap clears this.
  const right = placed.reduce((far, rect) => Math.max(far, rect.x + rect.w), -Infinity);
  // The first slot nobody else holds: a closed sibling leaves a hole, and the next arrival takes
  // it instead of landing exactly on a card that is still there.
  for (let position = 1; position <= cards.length + 1; position++) {
    const rect = cascadeSpot(base, right, position, width, height);
    // A card that is neither the anchor nor a sibling is in the way, so the cascade gives up
    // rather than opening a note buried under a card the human is reading.
    if (cards.some((card) => !mine.has(card.dataset.id) && overlaps(rect, rectOf(card)))) return null;
    if (!placed.some((other) => other.x === rect.x && other.y === rect.y)) return rect;
  }
  return null;
}

/**
 * Z within one thread only, so cards outside it keep the order the human gave them. The anchor
 * is the thread's oldest card and is ordered with its members; the restamp starts from the lowest
 * z the group already holds, so the thread keeps its place among the other cards however often
 * the pass runs.
 */
function applyThreadOrder(thread) {
  const anchor = byId.get(thread);
  const stack = anchor ? [anchor.card, ...threadMates(thread)] : threadMates(thread);
  if (!newestFirst) stack.reverse();
  let next = stack.reduce((low, card) => Math.min(low, Number(card.style.zIndex) || z), z);
  for (const card of stack) card.style.zIndex = next++;
  z = Math.max(z, next);
}

function applyAllThreadOrder() {
  for (const thread of new Set(cards.map((card) => card.dataset.threadRoot))) {
    if (thread) applyThreadOrder(thread);
  }
}

const viewportCenter = () => ({
  x: (viewport.clientWidth / 2 - view.x) / view.k,
  y: (viewport.clientHeight / 2 - view.y) / view.k,
});

// ---------- helpers ------------------------------------------------------
const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const el = (tag, cls) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
};
/** The card dot's colour, in one place so the card and its rail row cannot drift apart. */
const dotKind = (kind) =>
  kind === "source" ? "code" : kind === "question" ? "question" : kind === "sticky" ? "sticky" : "note";
/**
 * The world is zoomed with the CSS `zoom` property, so text is laid out at the size it is
 * shown at and never softens the way a scaled bitmap does. `zoom` scales the element's own
 * offsets too, hence dividing the pan by the scale.
 */
const ZOOM_SUPPORTED = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("zoom", "2");
const applyView = () => {
  if (ZOOM_SUPPORTED) {
    world.style.zoom = view.k;
    world.style.left = `${view.x / view.k}px`;
    world.style.top = `${view.y / view.k}px`;
  } else {
    // Older browsers only have the bitmap scale, which softens text while it catches up.
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
  }
  // Below this zoom a board is a map of its threads, and a fan of arrows over a fan of cards is
  // noise. The cards and the rail still say who follows from whom.
  arrows.classList.toggle("away", view.k < ARROW_MIN_ZOOM);
  if (typeof recomputePill === "function") recomputePill();
  resetBtn.textContent = `${Math.round(view.k * 100)}%`;
  // The board's zoom scales the focus ring drawn inside it too, so the rule in index.html
  // divides the ring by this to keep it the same thickness at every zoom.
  document.documentElement.style.setProperty("--zoom", String(view.k));
  // Every pan, zoom and fit comes through here, so the minimap has one place to hear about them.
  scheduleMap();
};

  // ---------- predecessor arrows -------------------------------------------
  // A card may arrive with `after`: the ids of the cards its work follows from. One arrow each,
  // drawn in a single SVG inside the world, so the lines scale with the board for free.
  const ARROW_NS = "http://www.w3.org/2000/svg";
  const ARROW_INK = "#94a3b8";
  // The zoom under which the arrows stop being drawn: they are read at the size of a conversation.
  const ARROW_MIN_ZOOM = 0.6;
  const arrows = document.createElementNS(ARROW_NS, "svg");
  // Under the cards: they carry z-index from 1 up, while this layer stays at 0.
  arrows.style.cssText = "position:absolute;left:0;top:0;overflow:visible;pointer-events:none;z-index:0";
  arrows.setAttribute("aria-hidden", "true");
  arrows.innerHTML =
    `<defs><marker id="predHead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" markerUnits="strokeWidth" orient="auto">` +
    `<path d="M2,1 L9,5 L2,9" fill="none" stroke="${ARROW_INK}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></marker></defs>`;
  const arrowGroup = document.createElementNS(ARROW_NS, "g");
  arrows.append(arrowGroup);
  world.insertBefore(arrows, world.firstChild);

  /** The ids of the cards a card follows from, kept on the element so a redraw reads no map. */
  function setAfter(card, after) {
    if (Array.isArray(after) && after.length) card.dataset.after = JSON.stringify(after);
    else card.dataset.after = "";
    scheduleArrows();
  }

  /** A card's box in board units, the same measure boardBounds takes. */
  const cardBox = (card) => ({
    x: parseFloat(card.style.left),
    y: parseFloat(card.style.top),
    w: card.offsetWidth,
    h: card.offsetHeight,
  });

  /** A box a line can actually be drawn between: a card mid-arrival has no position yet. */
  const drawable = (box) => Number.isFinite(box.x) && Number.isFinite(box.y) && box.w > 0 && box.h > 0;

  /**
   * The line from one card to the card that follows it: out of the facing edges, with a slight S so
   * a long hop reads as a route rather than a straight rule.
   */
  function arrowPath(a, b) {
    const dx = b.x + b.w / 2 - (a.x + a.w / 2);
    const dy = b.y + b.h / 2 - (a.y + a.h / 2);
    // Mostly under or over: the arrow leaves a bottom edge and lands on a top edge.
    if (Math.abs(dy) > Math.abs(dx)) {
      const [sy, ey] = dy > 0 ? [a.y + a.h, b.y] : [a.y, b.y + b.h];
      const sx = a.x + a.w / 2;
      const ex = b.x + b.w / 2;
      const my = (sy + ey) / 2;
      return `M${sx},${sy} C${sx},${my} ${ex},${my} ${ex},${ey}`;
    }
    const [sx, ex] = dx > 0 ? [a.x + a.w, b.x] : [a.x, b.x + b.w];
    const sy = a.y + a.h / 2;
    const ey = b.y + b.h / 2;
    const mx = (sx + ex) / 2;
    return `M${sx},${sy} C${mx},${sy} ${mx},${ey} ${ex},${ey}`;
  }

  /** Rebuild the group: one path per predecessor that still has a card on the board. */
  function paintArrows() {
    const lines = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const card of cards) {
      const after = card.dataset.after;
      if (!after) continue;
      // The dash belongs to the child: a run is going under it while it reads `sent`.
      const running = byId.get(card.dataset.id)?.data.status === "sent";
      const to = cardBox(card);
      if (!drawable(to)) continue;
      for (const id of JSON.parse(after)) {
        const from = byId.get(id);
        // An id nothing on the board answers to draws nothing at all.
        if (!from) continue;
        const at = cardBox(from.card);
        if (!drawable(at)) continue;
        lines.push({ d: arrowPath(at, to), running });
        minX = Math.min(minX, at.x, to.x);
        minY = Math.min(minY, at.y, to.y);
        maxX = Math.max(maxX, at.x + at.w, to.x + to.w);
        maxY = Math.max(maxY, at.y + at.h, to.y + to.h);
      }
    }
    if (!lines.length) {
      arrowGroup.replaceChildren();
      arrows.style.display = "none";
      return;
    }
    arrowGroup.replaceChildren(
      ...lines.map((line) => {
        const path = document.createElementNS(ARROW_NS, "path");
        path.setAttribute("d", line.d);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", ARROW_INK);
        path.setAttribute("stroke-width", "1.5");
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("marker-end", "url(#predHead)");
        if (line.running) path.setAttribute("stroke-dasharray", "6 5");
        return path;
      }),
    );
    // Padding covers the arrowhead, and the viewBox is the board space drawn into, so a card left
    // of zero or above it is drawn where it is instead of being clipped.
    const pad = 16;
    const x = minX - pad;
    const y = minY - pad;
    const w = maxX - minX + pad * 2;
    const h = maxY - minY + pad * 2;
    arrows.style.left = `${x}px`;
    arrows.style.top = `${y}px`;
    arrows.style.width = `${w}px`;
    arrows.style.height = `${h}px`;
    arrows.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
    arrows.style.display = "";
  }

  let arrowQueued = false;
  /** One redraw per frame: a drag or a fit asks for dozens and still costs one paint. */
  function scheduleArrows() {
    if (arrowQueued) return;
    arrowQueued = true;
    requestAnimationFrame(() => {
      arrowQueued = false;
      paintArrows();
    });
  }
  addEventListener("resize", scheduleArrows);

  // ---------- syntax highlighting -----------------------------------------

// ---------- syntax highlighting -----------------------------------------
const TOKENS =
  /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:[^`\\]|\\.)*`)|(#.*$|\/\/.*$)|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_]\w*(?=\())|(\b(?:def|class|return|if|elif|else|for|while|import|from|as|try|except|finally|with|lambda|yield|await|async|const|let|var|function|export|default|new|throw|catch|switch|case|break|continue|type|interface|struct|fn|pub|use|mod|match|impl|self|this|True|False|None|null|true|false|nil|end|do|then)\b)/g;

function highlight(raw) {
  let out = "";
  let last = 0;
  for (const match of raw.matchAll(TOKENS)) {
    const [text] = match;
    out += escapeHtml(raw.slice(last, match.index));
    const cls = match[1] ? "s" : match[2] ? "c" : match[3] ? "n2" : match[4] ? "f" : "k";
    out += `<span class="${cls}">${escapeHtml(text)}</span>`;
    last = match.index + text.length;
  }
  out += escapeHtml(raw.slice(last));
  return out || "&nbsp;";
}

// ---------- markdown -----------------------------------------------------
/**
 * The footnote state of one body: the notes its definitions carried, and the labels a marker has
 * pointed at, in the order the reader meets them. Numbering lives here rather than in the text, so a
 * marker can be written as `[^why]` and still read as `1`.
 */
function footnoteState(defs) {
  return { defs, order: [] };
}

function inlineMd(text, notes = null) {
  let out = escapeHtml(text);
  // Cross-references jump to another card, but a key inside inline code stays literal.
  out = out
    .split(/(`[^`]+`)/)
    .map((piece) => {
      if (piece.startsWith("`")) return piece;
      const linked = piece.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, key, label) => {
        const name = key.trim();
        return `<a class="xref" href="#" data-key="${name}" title="jump to ${name}">${(label || name).trim()}</a>`;
      });
      // A marker is numbered by the order it is met, so the same note referred to twice keeps one
      // number. A label with no definition stays as written: a typo reads better than a lost marker.
      if (!notes) return linked;
      return linked.replace(/\[\^([^\]\s]+)\]/g, (whole, label) => {
        if (!notes.defs.has(label)) return whole;
        let index = notes.order.indexOf(label);
        if (index < 0) index = notes.order.push(label) - 1;
        return `<sup class="fn">${index + 1}</sup>`;
      });
    })
    .join("");
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|\W)\*([^*]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return out;
}

function sanitizeSvg(svg) {
  return svg
    .replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript:/gi, "");
}

// ---------- mermaid -------------------------------------------------------
// The bundle is 3.5 MB and most cards hold no diagram, so it is fetched the first time a card asks
// for one and never before that. A board that only shows markdown never pays for it.
let mermaidReady = null;

function loadMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (!mermaidReady) {
    mermaidReady = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "/client/mermaid-min.js";
      script.onload = () => {
        // The board's own palette, so a diagram lands looking like the card around it instead of
        // like mermaid's default purple.
        window.mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          themeVariables: {
            darkMode: true,
            background: "#0d1117",
            primaryColor: "#1c2128",
            primaryTextColor: "#e6edf3",
            primaryBorderColor: "#30363d",
            secondaryColor: "#161b22",
            tertiaryColor: "#21262d",
            lineColor: "#7d8590",
            textColor: "#e6edf3",
            edgeLabelBackground: "#0d1117",
            fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
            fontSize: "14px",
          },
        });
        resolve(window.mermaid);
      };
      // A missing bundle leaves the next card free to try again rather than failing for the session.
      script.onerror = () => {
        mermaidReady = null;
        reject(new Error("mermaid-min.js did not load"));
      };
      document.head.appendChild(script);
    });
  }
  return mermaidReady;
}

// ---------- chart.js ------------------------------------------------------
// The same bargain as mermaid: a card that holds no chart never pays for a charting library. Chart.js
// arrives as a lazy global, and its defaults take the board's palette once so a config draws in the
// card's own colours without naming them.
let chartReady = null;

/** The board's own series colours, so a config that names none still draws as part of this page. */
const SERIES_COLOURS = ["#58a6ff", "#d29922", "#3fb950", "#db61a2", "#a371f7"];
/** The 10px type a value label and a goal rule are drawn in, and the two colours the card already uses. */
const CHART_LABEL_FONT = "10px system-ui, -apple-system, 'Segoe UI', sans-serif";
const CHART_LABEL_COLOUR = "#7d8590";
const CHART_GOAL_COLOUR = "#d29922";
/** A card holds a dozen marks before a number on every one of them reads as grit instead of values. */
const MAX_VALUE_MARKS = 12;
const MAX_VALUE_SERIES = 2;

const between = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));

/**
 * A tick number the eye can take on a 400px card: `1250000` is `1.25M`, `1800` is `1.8k`, and `0.45`
 * is left alone. This is the reason the board sets the tick callback itself: a config is JSON, and JSON
 * cannot carry a function.
 */
function compactNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
  // Only a fraction has zeros worth dropping: `340.0` is `340k`, and `340` stays `340`.
  const trim = (text) => (text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text);
  const size = Math.abs(value);
  if (size >= 1e6) return `${trim((value / 1e6).toFixed(2))}M`;
  if (size >= 1e3) return `${trim((value / 1e3).toFixed(1))}k`;
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(3)));
}

/** The same colour, thin enough to sit under a line without reading as a block. */
function faded(colour, alpha = 0.22) {
  const hex = colour.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** An option the board itself reads, taken from the object the config was written with. */
function boardOption(chart, name) {
  const written = chart.config?.options ?? chart.options ?? {};
  return written[name];
}

/** `indexAxis: "y"` turns a bar on its side, which is the one thing that moves a value label. */
function sideways(chart) {
  return chart.options?.indexAxis === "y";
}

/**
 * The palette is filled before the draw: Chart.js otherwise opens with its own red and teal, which are
 * not this board's, and the model rarely names a colour. A colour the config did name is kept.
 */
function fillPalette(config) {
  const sets = Array.isArray(config.data?.datasets) ? config.data.datasets : [];
  sets.forEach((dataset, index) => {
    if (!dataset || typeof dataset !== "object") return;
    const colour = SERIES_COLOURS[index % SERIES_COLOURS.length];
    const kind = dataset.type || config.type;
    if (dataset.backgroundColor === undefined) {
      // A line or a radar is a shape, so its fill goes under the stroke rather than over the plot.
      dataset.backgroundColor = kind === "line" || kind === "radar" ? faded(colour) : colour;
    }
    if (dataset.borderColor === undefined) dataset.borderColor = colour;
  });
}

/**
 * Each datum's value, written just past the end of its mark. Registered once on the bundle, so every
 * chart on the board gets it and no config has to ask; `options.valueLabels: false` is the way out.
 */
const boardValues = {
  id: "boardValues",
  afterDatasetsDraw(chart) {
    if (boardOption(chart, "valueLabels") === false) return;
    const sets = chart.data?.datasets ?? [];
    const marks = sets.reduce((total, set) => total + (Array.isArray(set?.data) ? set.data.length : 0), 0);
    if (!marks || marks > MAX_VALUE_MARKS || sets.length > MAX_VALUE_SERIES) return;
    const area = chart.chartArea;
    if (!area) return;
    const { ctx } = chart;
    ctx.save();
    ctx.font = CHART_LABEL_FONT;
    ctx.fillStyle = CHART_LABEL_COLOUR;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    sets.forEach((set, index) => {
      const meta = chart.getDatasetMeta(index);
      // A slice or a radar blade has no end to sit a number past, so only a bar and a line take one.
      if (meta?.type !== "bar" && meta?.type !== "line") return;
      const bar = meta.type === "bar";
      (set.data ?? []).forEach((value, at) => {
        // A mark of zero draws no length, and a nought beside it is a number nobody set out to read.
        if (typeof value !== "number" || !Number.isFinite(value) || value === 0) return;
        const mark = meta.data?.[at];
        if (!mark) return;
        const text = compactNumber(value);
        const width = ctx.measureText(text).width;
        // Above a vertical bar, and right of the bar's end or of the point, whichever this is.
        const right = !bar || sideways(chart);
        const left = right ? mark.x + 4 : mark.x - width / 2;
        const top = right ? mark.y - 5 : mark.y - 13;
        // A label that runs off the canvas is worth nothing, so it is held inside the plot area.
        ctx.fillText(text, between(left, area.left, area.right - width), between(top, area.top, area.bottom - 10));
      });
    });
    ctx.restore();
  },
};

/**
 * A rule at the one value that matters, drawn by the board: `options: { goal: 250 }` is a plain number,
 * so it survives JSON, and the model never has to find a way to draw a line itself.
 */
const boardGoal = {
  id: "boardGoal",
  afterDatasetsDraw(chart) {
    const goal = boardOption(chart, "goal");
    if (typeof goal !== "number" || !Number.isFinite(goal)) return;
    const area = chart.chartArea;
    if (!area) return;
    const upright = sideways(chart);
    const at = chart.scales?.[upright ? "x" : "y"]?.getPixelForValue(goal);
    if (!Number.isFinite(at)) return;
    const { ctx } = chart;
    const text = `goal ${compactNumber(goal)}`;
    ctx.save();
    ctx.font = CHART_LABEL_FONT;
    ctx.fillStyle = CHART_GOAL_COLOUR;
    ctx.strokeStyle = CHART_GOAL_COLOUR;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    if (upright) {
      ctx.moveTo(at, area.top);
      ctx.lineTo(at, area.bottom);
    } else {
      ctx.moveTo(area.left, at);
      ctx.lineTo(area.right, at);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    // The label sits at the end of the rule, held inside the plot so it cannot be clipped away.
    if (upright) {
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(text, between(at + 4, area.left, area.right - ctx.measureText(text).width), area.top + 2);
    } else {
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      ctx.fillText(text, area.right - 2, between(at - 2, area.top + 10, area.bottom));
    }
    ctx.restore();
  },
};

function loadChartJs() {
  if (window.Chart) return Promise.resolve(window.Chart);
  if (!chartReady) {
    chartReady = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "/client/chart-umd-min.js";
      script.onload = () => {
        window.Chart.defaults.color = "#c9d1d9";
        window.Chart.defaults.borderColor = "#30363d";
        window.Chart.defaults.font.family = "system-ui, -apple-system, 'Segoe UI', sans-serif";
        window.Chart.defaults.font.size = 11;
        window.Chart.defaults.animation = false;
        // A number on a tick is how a chart is read, and no config can carry the formatter that writes
        // one, so the two scales that hold values take it here, once, for every chart on the board.
        for (const scale of [window.Chart.defaults.scales.linear, window.Chart.defaults.scales.logarithmic]) {
          if (scale?.ticks) scale.ticks.callback = (value) => compactNumber(value);
        }
        // The goal rule is drawn first so a value label sits over it rather than under a dash.
        window.Chart.register(boardGoal, boardValues);
        resolve(window.Chart);
      };
      // A missing bundle leaves the next card free to try again rather than failing for the session.
      script.onerror = () => {
        chartReady = null;
        reject(new Error("chart-umd-min.js did not load"));
      };
      document.head.appendChild(script);
    });
  }
  return chartReady;
}

/** Drawn diagrams by source: a card re-renders on every tick of the board, and parsing is not free. */
const diagrams = new Map();
/**
 * Charts by fence body, holding a PNG data URL: a card re-renders on every tick of the board, and a
 * redraw that has not changed must not pay for Chart.js at all.
 */
const charts = new Map();
let diagramSeq = 0;

/**
 * Mermaid fits its drawing to the width on offer by putting `width="100%"` and a matching
 * `max-width` on the svg. A card is about 430px wide, so a sequence diagram that way becomes 6px
 * text. The drawing keeps its own size here and the wrapper scrolls instead.
 */
function naturalSize(svg) {
  const view = svg.match(/viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/);
  if (!view) return svg;
  return svg.replace(/<svg\b([^>]*)>/, (_m, attrs) => {
    const kept = attrs
      .replace(/\sstyle="[^"]*max-width[^"]*"/i, "")
      .replace(/\swidth="100%"/, "");
    return `<svg${kept} width="${Math.ceil(Number(view[1]))}" height="${Math.ceil(Number(view[2]))}">`;
  });
}

/**
 * A mermaid fence draws itself once the bundle arrives. The holder is in place first, so the card
 * keeps its place while the drawing is on its way, and a diagram that will not parse shows its own
 * source with one line saying why, instead of an empty box.
 */
function drawDiagram(holder, source) {
  const drawn = diagrams.get(source);
  if (drawn) {
    holder.innerHTML = drawn;
    return;
  }
  const id = `diagram-${(diagramSeq += 1)}`;
  loadMermaid()
    .then((mermaid) => mermaid.render(id, source))
    .then(({ svg }) => {
      const clean = sanitizeSvg(naturalSize(svg));
      diagrams.set(source, clean);
      holder.innerHTML = clean;
    })
    .catch((error) => {
      // A failed render leaves mermaid's own error drawing behind in the document; drop it.
      for (const left of [id, `d${id}`]) document.getElementById(left)?.remove();
      const pre = el("pre");
      const code = el("code");
      code.textContent = source;
      pre.appendChild(code);
      const why = el("p", "diagram-error");
      why.textContent = `mermaid could not draw this: ${String(error.message || error).split("\n")[0]}`;
      holder.replaceChildren(pre, why);
    });
}

/** The size a chart is drawn at, in CSS pixels. A card is about 430px wide, so the card's CSS scales it. */
const CHART_WIDTH = 400;
const CHART_HEIGHT = 240;
/** Past this the body is too large to draw, and the card says so instead of parsing it. */
const CHART_BODY_LIMIT = 20000;

function chartImage(png) {
  const img = document.createElement("img");
  img.src = png;
  // The drawing says nothing a screen reader could not take from the sentence above it.
  img.alt = "";
  return img;
}

/**
 * A chart fence that will not parse shows why, and the one line that says what the block is meant to
 * be. The model wrote the block, so the error is addressed to the model: never a blank box.
 */
function chartProblem(why) {
  const pre = el("pre");
  const code = el("code");
  code.textContent = why;
  pre.appendChild(code);
  const hint = el("p");
  hint.textContent = "a chart block is a Chart.js config as JSON, see prompts/skills/chart.md";
  return [pre, hint];
}

/**
 * A chart fence is a Chart.js config written as JSON, and it reaches the card as a PNG. A card body is
 * rebuilt on every tick of the board, so no Chart instance may outlive the paint: the drawing is
 * snapshotted and destroyed in the same turn, and the data URL is what the next tick reuses.
 */
function drawChart(holder, body) {
  const drawn = charts.get(body);
  if (drawn) {
    holder.appendChild(chartImage(drawn));
    return;
  }
  let config;
  // Checked before the parse, so an oversized body names the number instead of failing inside the parser.
  if (body.length > CHART_BODY_LIMIT) {
    holder.replaceChildren(...chartProblem(`a chart block holds at most ${CHART_BODY_LIMIT} characters, and this one is ${body.length}`));
    return;
  }
  try {
    // The body is data, so it is parsed and never evaluated: a config cannot run, by construction.
    config = JSON.parse(body);
  } catch (error) {
    holder.replaceChildren(...chartProblem(String(error.message || error)));
    return;
  }
  if (!config || typeof config !== "object" || !config.type || !config.data) {
    holder.replaceChildren(...chartProblem("a chart config needs a `type` and a `data` object"));
    return;
  }
  loadChartJs()
    .then((Chart) => {
      const ratio = window.devicePixelRatio || 1;
      const canvas = document.createElement("canvas");
      // Chart.js reads these as the CSS size and multiplies by `devicePixelRatio` into the backing
      // store, so the snapshot is 400px wide on any screen and sharp on a retina one.
      canvas.width = CHART_WIDTH;
      canvas.height = CHART_HEIGHT;
      // The colours are the board's unless the config named its own, so this runs before the draw.
      fillPalette(config);
      const chart = new Chart(canvas, {
        ...config,
        options: {
          ...config.options,
          // A card cannot be a live canvas, so the options that would tie the drawing to one are the
          // board's to set, and the config may style every other thing it likes.
          responsive: false,
          maintainAspectRatio: false,
          animation: false,
          devicePixelRatio: ratio,
        },
      });
      let png;
      try {
        // A canvas outside the document is never laid out by the browser, so Chart.js leaves the
        // first paint to the caller. One update lays it out and draws it.
        chart.update();
        png = canvas.toDataURL("image/png");
      } finally {
        chart.destroy();
      }
      charts.set(body, png);
      holder.replaceChildren(chartImage(png));
    })
    .catch((error) => holder.replaceChildren(...chartProblem(String(error.message || error))));
}

/** `|---|:--:|` under a header row is what makes the block above it a table. */
function isTableRule(line) {
  return typeof line === "string" && line.includes("-") && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line);
}

function tableCells(line) {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderTable(headerLine, ruleLine, bodyLines, notes = null) {
  const wrap = el("div", "table-wrap");
  const table = el("table");
  const align = tableCells(ruleLine).map((spec) =>
    spec.startsWith(":") && spec.endsWith(":") ? "center" : spec.endsWith(":") ? "right" : spec.startsWith(":") ? "left" : "",
  );
  const head = el("thead");
  const headRow = el("tr");
  tableCells(headerLine).forEach((cell, column) => {
    const th = el("th");
    th.innerHTML = inlineMd(cell, notes);
    if (align[column]) th.style.textAlign = align[column];
    headRow.appendChild(th);
  });
  head.appendChild(headRow);
  const body = el("tbody");
  for (const line of bodyLines) {
    const row = el("tr");
    const cells = tableCells(line);
    // Rows shorter than the header still line up, and extra cells are kept rather than lost.
    const width = Math.max(cells.length, headRow.childElementCount);
    for (let column = 0; column < width; column += 1) {
      const td = el("td");
      td.innerHTML = inlineMd(cells[column] ?? "", notes);
      if (align[column]) td.style.textAlign = align[column];
      row.appendChild(td);
    }
    body.appendChild(row);
  }
  table.append(head, body);
  wrap.appendChild(table);
  return wrap;
}

function renderMarkdown(markdown) {
  const holder = el("div");
  const fences = [];
  let tickIndex = 0;
  // A fence is three or more backticks and closes on a run of the same length, so a task packet
  // that quotes its own code block can still travel inside one fence of its own.
  const stripped = markdown.replace(/(`{3,})([a-zA-Z0-9_-]*)\n([\s\S]*?)\1/g, (_m, _fence, lang, body) => {
    const index = fences.push({ lang: lang.toLowerCase(), body }) - 1;
    return `\u0000FENCE${index}\u0000`;
  });

  // A fence may follow text on the next single newline, so give every marker its own block.
  const spaced = stripped.replace(/(\u0000FENCE\d+\u0000)/g, "\n\n$1\n\n");
  // Footnotes: a definition is `[^label]: text` at the start of a line, and the lines indented under
  // it belong to it. Definitions are lifted out of the body before any block is drawn, so the notes
  // end up at the foot of the card and the body only carries the markers.
  const notes = footnoteState(new Map());
  const body = [];
  let openNote = null;
  for (const line of spaced.split("\n")) {
    const definition = line.match(/^\[\^([^\]\s]+)\]:[ \t]*(.*)$/);
    if (definition) {
      openNote = { text: definition[2] };
      notes.defs.set(definition[1], openNote);
      continue;
    }
    if (openNote && /^(?: {2,}|\t)\S/.test(line)) {
      openNote.text += ` ${line.trim()}`;
      continue;
    }
    openNote = null;
    body.push(line);
  }
  for (const block of body.join("\n").split(/\n{2,}/)) {
    const fenceTag = block.match(/^\u0000FENCE(\d+)\u0000$/);
    if (fenceTag) {
      const { lang, body } = fences[Number(fenceTag[1])];
      if (lang === "svg") {
        const wrap = el("div", "svg-wrap");
        wrap.innerHTML = sanitizeSvg(body);
        holder.appendChild(wrap);
      } else if (lang === "mermaid") {
        const wrap = el("div", "svg-wrap diagram-wrap");
        drawDiagram(wrap, body.trim());
        holder.appendChild(wrap);
      } else if (lang === "chart") {
        const wrap = el("div", "svg-wrap chart-wrap");
        drawChart(wrap, body);
        holder.appendChild(wrap);
      } else {
        const pre = el("pre");
        const code = el("code");
        code.textContent = body.replace(/\n$/, "");
        pre.appendChild(code);
        holder.appendChild(pre);
      }
      continue;
    }
    // Lines are walked one by one, so a list can be followed by a paragraph with no blank
    // line between them, which is what typing under a list produces.
    const lines = block.split("\n");
    let list = null;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      // A table is a header row, a separator row, then body rows until something else.
      // The separator needs a pipe of its own and must line up with the header, otherwise a
      // paragraph that ends in a pipe and is followed by `---` would become a table.
      if (
        /\|/.test(line) &&
        isTableRule(lines[index + 1]) &&
        lines[index + 1].includes("|") &&
        tableCells(line).length === tableCells(lines[index + 1]).length
      ) {
        const rows = [];
        let cursor = index + 2;
        while (cursor < lines.length && /\|/.test(lines[cursor])) rows.push(lines[cursor++]);
        holder.appendChild(renderTable(line, lines[index + 1], rows, notes));
        list = null;
        index = cursor - 1;
        continue;
      }
      const item = line.match(/^\s*[-*+]\s+(.*)$/);
      // A number and a dot (or a bracket) is an ordered item. The number the reader types is the one
      // the list starts at, so a card can continue a count the body began in prose.
      const numbered = item ? null : line.match(/^\s*(\d{1,3})[.)]\s+(.*)$/);
      if (item || numbered) {
        const tag = item ? "ul" : "ol";
        if (!list || list.tagName.toLowerCase() !== tag) {
          list = el(tag);
          if (numbered && numbered[1] !== "1") list.start = Number(numbered[1]);
          holder.appendChild(list);
        }
        const li = el("li");
        const box = item ? item[1].match(/^\[([ xX])\]\s*(.*)$/) : null;
        li.innerHTML = box
          ? `<span class="tick" title="tick it">${box[1].trim() ? "☑" : "☐"}</span> ${inlineMd(box[2], notes)}`
          : inlineMd(item ? item[1] : numbered[2], notes);
        if (box) li.dataset.tick = String(tickIndex++);
        list.appendChild(li);
        continue;
      }
      list = null;
      if (!line.trim()) continue;
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        // The level is kept up to h3: a deeper heading is as small as a card can show it.
        const h = el(`h${Math.min(heading[1].length, 3)}`);
        h.innerHTML = inlineMd(heading[2], notes);
        holder.appendChild(h);
        continue;
      }
      if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
        holder.appendChild(el("hr"));
        continue;
      }
      // `>` lines group into one quote; a bare `>` splits it into paragraphs.
      const quoted = line.match(/^\s*>\s?(.*)$/);
      if (quoted) {
        const pieces = [];
        let cursor = index;
        while (cursor < lines.length) {
          const next = lines[cursor].match(/^\s*>\s?(.*)$/);
          if (!next) break;
          pieces.push(next[1]);
          cursor += 1;
        }
        const quote = el("blockquote");
        const para = [];
        const flush = () => {
          if (!para.length) return;
          const p = el("p");
          p.innerHTML = inlineMd(para.join(" "), notes);
          quote.appendChild(p);
          para.length = 0;
        };
        for (const piece of pieces) {
          if (piece.trim()) para.push(piece.trim());
          else flush();
        }
        flush();
        holder.appendChild(quote);
        list = null;
        index = cursor - 1;
        continue;
      }
      const p = el("p");
      p.innerHTML = inlineMd(line, notes);
      holder.appendChild(p);
    }
  }
  // The notes the body pointed at, numbered the way the markers were numbered. A definition nothing
  // referred to is dropped with the label it was written under, because an unmarked note is text the
  // reader has no reason to go looking for.
  if (notes.order.length) {
    const list = el("ol", "fn-list");
    for (const label of notes.order) {
      const li = el("li");
      li.innerHTML = inlineMd(notes.defs.get(label).text);
      list.appendChild(li);
    }
    holder.appendChild(list);
  }
  return holder;
}

// ---------- bodies -------------------------------------------------------
/** Virtualized code view: only visible lines exist in the DOM. */
function sourceBody(data) {
  const lines = data.content.split("\n");
  const scroll = el("div", "code-scroll");
  const inner = el("div", "code-inner");
  const width = lines.reduce((max, line) => Math.max(max, line.length), 0);
  inner.style.height = `${lines.length * LINE_HEIGHT}px`;
  inner.style.width = `${GUTTER + Math.min(width, 260) * measureCharWidths().mono + 30}px`;
  scroll.appendChild(inner);

  let first = -1;
  let last = -1;
  const hit = data.line;

  const renderWindow = () => {
    const height = scroll.clientHeight || 320;
    const start = Math.max(0, Math.floor(scroll.scrollTop / LINE_HEIGHT) - 6);
    const end = Math.min(lines.length - 1, Math.ceil((scroll.scrollTop + height) / LINE_HEIGHT) + 6);
    if (start === first && end === last) return;
    first = start;
    last = end;
    const fragment = document.createDocumentFragment();
    for (let i = start; i <= end; i++) {
      const row = el("div", "row" + (hit === i + 1 ? " hit" : ""));
      row.style.top = `${i * LINE_HEIGHT}px`;
      row.innerHTML = `<span class="n">${i + 1}</span><span class="t">${highlight(lines[i])}</span>`;
      fragment.appendChild(row);
    }
    inner.replaceChildren(fragment);
  };

  let scheduled = false;
  scroll.addEventListener("scroll", () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      renderWindow();
    });
  });
  new ResizeObserver(() => renderWindow()).observe(scroll);
  renderWindow();
  requestAnimationFrame(() => {
    if (hit && hit > 0) {
      scroll.scrollTop = Math.max(0, (hit - 1) * LINE_HEIGHT - (scroll.clientHeight / 2 - LINE_HEIGHT / 2));
    }
    renderWindow();
  });
  return scroll;
}

/**
 * The questions a card asks, in the one shape that draws them.
 *
 * One question is the card the board always had: its options answer it where they are drawn, and a
 * click is the answer. A card that asks several draws a tab per question and one send under them,
 * because the call that asked is held until every tab has an answer.
 */
function questionBody(data, entry) {
  const asked = Array.isArray(data.questions) ? data.questions.filter((one) => one && one.question) : [];
  if (asked.length > 1) return tabbedQuestions(data, entry, asked);
  // A card that carries its one question in the list form reads the same once it is spread flat.
  return oneQuestion(asked.length ? { ...data, ...asked[0] } : data, entry);
}

/** A settled question names its answer, and the boxes it left ticked keep their ticks. */
function oneQuestion(data, entry) {
  // A question that ran out of time is as settled as an answered one: its buttons are dead and
  // the header says which of the two happened.
  const settled = data.status === "answered" || data.status === "expired";
  // A question that takes several answers is filled in and then sent: one click would answer it
  // half way, so its options are boxes and the row under them is what sends.
  const multiple = data.multiple === true;
  const holder = el("div", "q-body");
  const text = el("div", "q-text");
  text.innerHTML = inlineMd(data.question || "");
  holder.appendChild(text);

  // The arrival lands the keyboard here, so a focused option cannot answer on Space or Enter.
  const buttons = el("div", "q-options");
  buttons.tabIndex = -1;
  // What this card says was chosen. A question saved before the picks were kept has only the one
  // joined line, and that line is the whole answer.
  const chosen = new Set(
    settled ? (Array.isArray(data.answers) && data.answers.length ? data.answers : data.answer ? [data.answer] : []) : [],
  );

  // Built before the options are wired: every answer path hands the row to submitAnswer, which
  // takes it out of the card while the send is in flight and puts it back if the send fails. A
  // question that takes several answers always has the row, because that is where `send` lives.
  let freeRow = null;
  let input = null;
  let send = null;
  if (!settled && (data.allowFreeText || multiple)) {
    freeRow = el("div", "q-free");
    if (data.allowFreeText) {
      input = el("input");
      input.placeholder = multiple ? "or add a note…" : "or type an answer…";
      freeRow.appendChild(input);
    }
    send = el("button", "q-opt");
    send.textContent = "send";
    // Nothing ticked and nothing typed is not an answer, so the button says so by being dead.
    if (multiple) send.disabled = true;
    freeRow.appendChild(send);
  }

  // The ticks, in the order the options are drawn, plus whatever was typed beside them.
  const picksNow = () => [...buttons.querySelectorAll(".q-opt.picked")].map((button) => button.textContent);
  const typedNow = () => (input ? input.value.trim() : "");
  const sendPicks = () => {
    const picks = picksNow();
    const typed = typedNow();
    if (typed) picks.push(typed);
    if (picks.length) submitAnswer(entry, picks, buttons, freeRow);
  };
  const sendTyped = () => {
    const typed = typedNow();
    if (typed) submitAnswer(entry, typed, buttons, freeRow);
  };
  const refreshSend = () => {
    if (send) send.disabled = !picksNow().length && !typedNow();
  };
  if (input) {
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      if (multiple) sendPicks();
      else sendTyped();
    });
    if (multiple) input.addEventListener("input", refreshSend);
  }
  if (send) send.addEventListener("click", multiple ? sendPicks : sendTyped);

  for (const option of data.options || []) {
    const button = el("button", multiple ? "q-opt q-check" : "q-opt");
    button.textContent = option;
    if (settled) {
      button.disabled = true;
      if (chosen.has(option)) button.classList.add("picked");
      // A settled box still says which way it was left, so the card reads the same before and after.
      if (multiple) button.setAttribute("aria-pressed", chosen.has(option) ? "true" : "false");
    } else if (multiple) {
      // A box, not an answer: clicking it fills the question in and lets the human pick a second.
      button.setAttribute("aria-pressed", "false");
      button.addEventListener("click", () => {
        const on = button.classList.toggle("picked");
        button.setAttribute("aria-pressed", on ? "true" : "false");
        refreshSend();
      });
    } else {
      button.addEventListener("click", () => submitAnswer(entry, option, buttons, freeRow));
    }
    buttons.appendChild(button);
  }
  holder.appendChild(buttons);
  if (freeRow) holder.appendChild(freeRow);

  if (data.status === "answered") {
    const done = el("div", "q-done");
    done.textContent = `answered: ${data.answer || "—"}`;
    holder.appendChild(done);
  }
  return holder;
}

/**
 * A card that asks several questions: a numbered tab per question, a radio or a box under each, and
 * one send at the foot. The tabs are numbers because five questions do not fit across a card, and a
 * tab that already has an answer carries a tick, so the reader sees what is left without opening each.
 */
function tabbedQuestions(data, entry, asked) {
  // A question that ran out of time is as settled as an answered one, and every tab keeps what it was
  // answered with: the card is the record of the exchange, not only the form for it.
  const settled = data.status === "answered" || data.status === "expired";
  const said = settled && Array.isArray(data.answers) ? data.answers : [];
  const holder = el("div", "q-body");
  const tabs = el("div", "q-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "questions");
  holder.appendChild(tabs);
  const panels = [];
  const tabButtons = [];

  // What one tab has been answered with: the picks for a question that takes several, else one answer.
  const valueAt = (at) => {
    const panel = panels[at];
    const picks = [...panel.querySelectorAll(".q-opt.picked")].map((button) => button.textContent);
    const typed = panel.querySelector(".q-free input")?.value.trim() || "";
    // Typing and picking are two ways to say one thing: on a question with one answer the words are the
    // answer, and on a question of boxes they are one more box.
    if (asked[at].multiple === true) return typed ? [...picks, typed] : picks;
    return typed || picks[0] || "";
  };
  const answeredAt = (at) => {
    const value = valueAt(at);
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  };
  const setTab = (at, focus) => {
    tabButtons.forEach((button, index) => {
      const on = index === at;
      button.classList.toggle("on", on);
      button.setAttribute("aria-selected", on ? "true" : "false");
      // One tab is in the tab order, so Tab reaches the row once and the arrows move inside it.
      button.tabIndex = on ? 0 : -1;
      panels[index].hidden = !on;
    });
    if (focus) tabButtons[at].focus();
    // A tab taller than the one before it would be cut off by the card's height, and the send row lives
    // under the last option, so the card is fitted again on every switch. fitContent only ever grows a
    // card, so a tab that needs less room never pulls the one under it back up.
    fitContent(entry, data);
  };
  // The tab stands for its question: a tick says it is answered, and the panel below carries the words.
  const markTabs = () => {
    tabButtons.forEach((button, at) => {
      const done = settled ? Boolean(said[at]) : answeredAt(at);
      button.classList.toggle("done", done);
      button.title = settled && said[at] ? `${asked[at].question}\nanswered: ${said[at]}` : asked[at].question;
    });
  };

  let foot = null;
  let send = null;
  let count = null;
  const refresh = () => {
    markTabs();
    if (settled) return;
    const missing = asked.filter((one, at) => !answeredAt(at)).length;
    count.textContent = missing ? `${asked.length - missing} of ${asked.length} answered` : "all answered — send";
    send.disabled = missing > 0;
  };

  // The arrows walk the tab row, as a tab list is expected to.
  tabs.addEventListener("keydown", (event) => {
    const at = tabButtons.indexOf(document.activeElement);
    if (at < 0) return;
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    setTab((at + step + tabButtons.length) % tabButtons.length, true);
  });

  asked.forEach((one, at) => {
    const tab = el("button", "q-tab");
    tab.type = "button";
    tab.setAttribute("role", "tab");
    tab.textContent = String(at + 1);
    tab.addEventListener("click", () => setTab(at, false));
    tabs.appendChild(tab);
    tabButtons.push(tab);

    const panel = el("div", "q-panel");
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-label", `question ${at + 1}`);
    panels.push(panel);

    const text = el("div", "q-text");
    text.innerHTML = inlineMd(one.question || "");
    panel.appendChild(text);

    const buttons = el("div", "q-options");
    buttons.tabIndex = -1;
    const multiple = one.multiple === true;
    // A settled tab shows what was ticked rather than a form nobody can send again.
    const chosen = new Set(settled && said[at] ? String(said[at]).split(", ") : []);
    let input = null;
    let freeRow = null;
    if (!settled && one.allowFreeText !== false) {
      freeRow = el("div", "q-free");
      input = el("input");
      input.placeholder = multiple ? "or add a note…" : "or type an answer…";
      input.addEventListener("input", () => {
        // One question has one answer, so typed words clear the picked option and the option clears them.
        if (!multiple) for (const button of buttons.children) button.classList.remove("picked");
        refresh();
      });
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        send.click();
      });
      freeRow.appendChild(input);
    }

    for (const option of one.options || []) {
      const button = el("button", multiple ? "q-opt q-check" : "q-opt");
      button.type = "button";
      button.textContent = option;
      if (settled) {
        button.disabled = true;
        if (chosen.has(option)) button.classList.add("picked");
        if (multiple) button.setAttribute("aria-pressed", chosen.has(option) ? "true" : "false");
      } else if (multiple) {
        // A box, not an answer: clicking it fills the tab in and lets the human tick a second.
        button.setAttribute("aria-pressed", "false");
        button.addEventListener("click", () => {
          const on = button.classList.toggle("picked");
          button.setAttribute("aria-pressed", on ? "true" : "false");
          refresh();
        });
      } else {
        button.setAttribute("aria-pressed", "false");
        button.addEventListener("click", () => {
          for (const other of buttons.children) {
            other.classList.remove("picked");
            other.setAttribute("aria-pressed", "false");
          }
          button.classList.add("picked");
          button.setAttribute("aria-pressed", "true");
          if (input) input.value = "";
          refresh();
          // One click is the whole answer to a question with one answer, so the empty tab after it is
          // where the reader goes next. The keyboard lands on the options, not on a button Space presses.
          const after = asked.findIndex((other, index) => index > at && !answeredAt(index));
          const next = after > -1 ? after : asked.findIndex((other, index) => !answeredAt(index));
          if (next > -1) {
            setTab(next, false);
            panels[next].querySelector(".q-options")?.focus({ preventScroll: true });
          }
        });
      }
      buttons.appendChild(button);
    }
    panel.appendChild(buttons);
    if (freeRow) panel.appendChild(freeRow);
    if (settled && said[at]) {
      const done = el("div", "q-done");
      done.textContent = `answered: ${said[at]}`;
      panel.appendChild(done);
    }
    holder.appendChild(panel);
  });

  if (!settled) {
    foot = el("div", "q-actions");
    count = el("span", "q-count");
    send = el("button", "q-opt q-send");
    send.type = "button";
    send.textContent = "send answers";
    send.addEventListener("click", () => {
      // A send that left a tab empty would wake the child with half a form, so the button walks to the
      // question it is waiting on instead of sending.
      const missing = asked.findIndex((one, at) => !answeredAt(at));
      if (missing > -1) {
        setTab(missing, true);
        return;
      }
      void sendTabbed(entry, holder, asked.map((one, at) => valueAt(at)), foot);
    });
    foot.appendChild(count);
    foot.appendChild(send);
    holder.appendChild(foot);
  }

  setTab(0, false);
  refresh();
  return holder;
}

/** Send every tab at once, and put the form back to being filled in when the send failed. */
async function sendTabbed(entry, holder, answers, foot) {
  const live = [...holder.querySelectorAll("button, input")];
  for (const node of live) node.disabled = true;
  foot.hidden = true;
  const problem = await postAnswer(entry, { answers });
  if (!problem) return;
  for (const node of live) node.disabled = false;
  foot.hidden = false;
  showProblem(holder, problem);
}

/** Send one answer to the daemon, and hand back what went wrong, or nothing at all. */
async function postAnswer(entry, body) {
  try {
    const response = await fetch(`/answer?${auth}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardId: entry.id, ...body }),
    });
    // A 409 means the question expired or another tab answered it, so nothing was delivered.
    if (!response.ok) return (await response.text()).trim() || "could not send — the question may have expired";
  } catch {
    return "could not reach the board server";
  }
  return "";
}

/** A send that failed says so where the answer was given, styled as a failure rather than a note. */
function showProblem(holder, problem) {
  let warn = holder.querySelector(".q-done");
  if (!warn) {
    warn = el("div", "q-done");
    warn.setAttribute("role", "alert");
    holder.appendChild(warn);
  }
  warn.classList.add("q-problem");
  warn.textContent = problem;
}

async function submitAnswer(entry, answer, buttons, freeRow) {
  // An answer that is a list came from the boxes. The ticks stay on screen while the send is in
  // flight: they are the question being filled in, and a failed send must not undo them.
  const multi = Array.isArray(answer);
  const options = [...buttons.querySelectorAll("button")];
  options.forEach((button) => (button.disabled = true));
  if (freeRow) freeRow.remove();
  if (!multi) {
    for (const button of options) {
      if (button.textContent === answer) button.classList.add("picked");
    }
  }
  const problem = await postAnswer(entry, multi ? { answers: answer } : { answer });
  if (!problem) return;
  // The agent got nothing, so the card goes back to looking unanswered: a picked option and
  // dead buttons would read as sent. On a question with boxes the ticks are the human's work, so
  // only the buttons come back to life.
  for (const button of options) button.disabled = false;
  if (!multi) for (const button of options) button.classList.remove("picked");
  if (freeRow) buttons.after(freeRow);
  showProblem(buttons.parentElement, problem);
}

/**
 * What a run said on the way, drawn again from the text as it now reads: one muted block per message
 * it wrote before calling a tool. The blocks are only rebuilt when one has been added, so the tick that
 * grows the answer leaves a selection in the narration alone.
 */
function paintInterim(wrap, turn) {
  const interim = wrap.querySelector(".turn-interim");
  if (!interim) return;
  const notes = Array.isArray(turn.interim) ? turn.interim : [];
  const drawn = notes.join("\u0000");
  if (interim.dataset.drawn === drawn) return;
  interim.dataset.drawn = drawn;
  interim.replaceChildren(
    ...notes.map((text) => {
      // The note body is what every other markdown on the board is drawn with, so a paragraph of
      // narration keeps its lists, links and code; only its size and colour are the card's own.
      const block = el("div", "turn-note note-body");
      block.appendChild(renderMarkdown(text));
      return block;
    }),
  );
}

/**
 * The answer of one turn, drawn again from the text as it now reads. A run writes into this
 * element about ten times a second, so it is the one node that gets repainted on its own instead
 * of the card being rebuilt around it.
 */
function paintAnswer(wrap, turn) {
  paintInterim(wrap, turn);
  const answer = wrap.querySelector(".turn-a");
  if (!answer) return;
  answer.replaceChildren();
  if (turn.reply) {
    const body = renderMarkdown(turn.reply);
    answer.appendChild(body);
    // The caret is the only thing that says the text is still arriving: the status line says
    // `sent` for a run that is going, which reads the same as one that has stalled.
    if (turn.streaming) {
      const caret = el("span", "caret");
      caret.setAttribute("aria-hidden", "true");
      // Inside the last paragraph, so it sits after the last word instead of on a line of its own.
      const lastBlock = body.lastElementChild;
      if (lastBlock && lastBlock.tagName === "P") lastBlock.append(caret);
      else answer.appendChild(caret);
    }
  } else if (turn.streaming) {
    const caret = el("span", "caret");
    caret.setAttribute("aria-hidden", "true");
    answer.appendChild(caret);
  }
}

/**
 * What a turn's own line says. The two that matter read apart at a glance: a message the child has been
 * given is the one the run is working on, and a message waiting behind the run is a draft that can still
 * be changed.
 */
function turnLabel(turn) {
  if (turn.status === "answered") return "answered";
  if (turn.status === "stopped") return turn.error ? `stopped · ${turn.error}` : "stopped";
  if (turn.status === "sent") return turn.mode === "steer" ? "steered into the run" : "sent to the agent";
  return "queued · waits for the run";
}

/** One follow-up exchange: your question, what happened to it, then the answer. */
function turnNode(entry, turn, index) {
  const wrap = el("div", `turn ${turn.status || "queued"}`);
  const question = el("div", "turn-q");
  question.textContent = turn.text || "";
  wrap.appendChild(question);
  // The child has not been told this one yet, so its words are still the human's to change.
  if (turn.status === "queued") {
    question.title = "press twice to rewrite this message";
    question.addEventListener("dblclick", () => startEditingTurn(entry, wrap, index));
  }
  const status = el("div", `turn-status ${turn.status || "queued"}`);
  const label = el("span", "turn-label");
  label.textContent = turnLabel(turn);
  status.appendChild(label);
  if (turn.status === "queued") status.appendChild(queuedActs(entry, wrap, index));
  // A connection error fits on this line; a longer reason is readable in full on hover.
  if (turn.error) status.title = turn.error;
  wrap.appendChild(status);
  if (turn.images) {
    const shot = el("div", "turn-status");
    shot.textContent = `${turn.images} image${turn.images > 1 ? "s" : ""} attached`;
    wrap.appendChild(shot);
  }
  // What the run said on the way, above the answer: one block each, ruled apart, muted. It draws
  // nothing at all on a run that answered in one message.
  wrap.appendChild(el("div", "turn-interim"));
  // Always there, even before the answer has a word: an empty one draws nothing, and having it
  // from the start means a growing answer is one element to fill, not a node to add.
  wrap.appendChild(el("div", "turn-a note-body"));
  paintAnswer(wrap, turn);
  return wrap;
}

/** The two things a message the child has not read may still be given: new words, or none. */
function queuedActs(entry, wrap, index) {
  const acts = el("div", "turn-acts");
  const edit = el("button", "turn-act");
  edit.type = "button";
  edit.textContent = "edit";
  edit.title = "rewrite this message before the agent reads it";
  edit.setAttribute("aria-label", "rewrite this queued message");
  // A press here must not take the caret out of the field next door: that blur would save the words being
  // typed, shorten the turn under the pointer, and the press would land on the card instead of the button.
  edit.addEventListener("pointerdown", (event) => event.preventDefault());
  edit.addEventListener("click", (event) => {
    event.stopPropagation();
    startEditingTurn(entry, wrap, index);
  });
  const drop = el("button", "turn-act drop");
  drop.type = "button";
  drop.textContent = "×";
  drop.title = "take this message back before the agent reads it";
  drop.setAttribute("aria-label", "withdraw this queued message");
  drop.addEventListener("pointerdown", (event) => event.preventDefault());
  drop.addEventListener("click", (event) => {
    event.stopPropagation();
    // The words in the field are not a reason to keep a message the human is taking back: the field goes
    // first, and what is withdrawn is the message the daemon holds.
    entry.finishTurnEdit?.();
    void dropQueued(entry, index);
  });
  acts.append(edit, drop);
  return acts;
}

/**
 * The words of a message the child has not read yet become a field holding themselves. Enter keeps what
 * was typed, Shift+Enter breaks the line, Escape drops it, and a press elsewhere keeps it — the note
 * editor's rules, on the card's own conversation.
 */
function startEditingTurn(entry, wrap, index) {
  if (wrap.dataset.editing) return;
  const turn = Array.isArray(entry.data?.turns) ? entry.data.turns[index] : null;
  if (!turn || turn.status !== "queued") return;
  // One field at a time: a press on another waiting message keeps what the open one holds and closes it.
  entry.finishTurnEdit?.(true);
  const bubble = wrap.querySelector(".turn-q");
  if (!bubble) return;
  wrap.dataset.editing = "1";
  const area = el("textarea", "turn-edit");
  area.value = turn.text || "";
  area.spellcheck = false;
  area.rows = 2;
  bubble.title = "";
  bubble.replaceChildren(area);
  // A field that grows with its words: a queued message is often longer than the two rows it opens with.
  const grow = () => {
    area.style.height = "auto";
    area.style.height = `${area.scrollHeight}px`;
  };
  area.addEventListener("input", grow);
  grow();
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
  const finish = (commit) => {
    if (!wrap.dataset.editing) return;
    delete wrap.dataset.editing;
    entry.finishTurnEdit = null;
    const wanted = area.value.trim();
    // The field goes before anything is saved, and the words go back into the bubble as they now read.
    // A repaint here would take the node under the pointer with it, and the × beside an editor that was
    // just closed would swallow the click that closed it.
    area.remove();
    bubble.title = "press twice to rewrite this message";
    bubble.textContent = commit && wanted ? wanted : turn.text || "";
    if (commit && wanted && wanted !== turn.text) {
      void saveTurnText(entry, index, wanted);
      return;
    }
    // Something was said on this card while the field was open and was held back rather than drawn over it.
    // Nothing else will come along now, so the conversation is painted from what the daemon holds.
    if (entry.threadHeldBack) {
      entry.threadHeldBack = false;
      entry.turnNodes = undefined;
      paintCard(entry, entry.data);
    }
  };
  // The × beside the field closes it without keeping what was typed, so it can reach the same finish.
  entry.finishTurnEdit = () => finish(false);
  area.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      // The editor takes Escape first: dropping an edit must not give up the selection either.
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      finish(true);
    }
  });
  area.addEventListener("blur", () => finish(true));
}

/**
 * The rewritten words go back to the daemon, which is holding the queue: the card is drawn from the answer
 * it sends, so the field and the message that will be sent cannot drift apart.
 */
async function saveTurnText(entry, index, text) {
  try {
    const response = await fetch(`/message/edit?${auth}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardId: entry.id, turn: index, text }),
    });
    if (!response.ok) throw new Error((await response.text()).slice(0, 120) || response.statusText);
    footNote("queued message rewritten");
  } catch (error) {
    footNote(`could not rewrite the queued message: ${error.message || error}`, true);
    // Words that never reached the queue are not words the card stands behind, so it is drawn again from
    // what the daemon actually holds. The conversation is forgotten first, because the field already put
    // the words on screen and a paint that trusts what is drawn would rebuild nothing.
    entry.turnNodes = undefined;
    paintCard(entry, entry.data);
  }
}

/** A message taken back before the child reads it. The daemon stops the turn, so nothing is drawn here. */
async function dropQueued(entry, index) {
  try {
    const response = await fetch(`/message/drop?${auth}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardId: entry.id, turn: index }),
    });
    if (!response.ok) throw new Error((await response.text()).slice(0, 120) || response.statusText);
    footNote("queued message withdrawn");
  } catch (error) {
    footNote(`could not withdraw the queued message: ${error.message || error}`, true);
  }
}

/** What a turn draws besides its answer. A turn that changes here has to be redrawn whole. */
function turnShape(turn) {
  const notes = Array.isArray(turn.interim) ? turn.interim : [];
  return [turn.text, turn.status, turn.mode, turn.images, turn.error, notes.length, notes.join("\u0000")].join("\u0000");
}

/**
 * Follow-ups live in the card they are about, below its body, so asking again never pushes a
 * new card onto the canvas.
 */
function paintThread(entry, data) {
  const turns = Array.isArray(data.turns) ? data.turns : [];
  const last = turns[turns.length - 1];
  // News is a turn that was not there before, or the last turn's answer landing; a thread the
  // card is created with is history. Either way it fires once per real answer.
  const seen = entry.threadSeen ?? { count: turns.length, answered: Boolean(last?.reply) };
  const fresh = turns.length > seen.count || (Boolean(last?.reply) && !seen.answered);
  entry.threadSeen = { count: turns.length, answered: Boolean(last?.reply) };
  entry.thread.hidden = turns.length === 0;
  // Reading position: an answer growing under someone who is already at the bottom keeps them
  // there; someone who scrolled up to read is left where they are.
  const atBottom = entry.scroll.scrollHeight - entry.scroll.scrollTop - entry.scroll.clientHeight < 24;
  // A reply arriving in deltas would otherwise rebuild the whole conversation ten times a second,
  // taking the column's scroll and any selection being read with it. While nothing but an answer
  // moves, only that answer is repainted.
  const drawn = entry.turnNodes ?? (entry.turnNodes = []);
  const settled =
    drawn.length === turns.length && turns.every((turn, at) => turnShape(turn) === turnShape(drawn[at].turn));
  if (settled) {
    // The run writes into the turn it was asked about, which is not always the last one: a message
    // queued behind the run sits after it, and the answer under it keeps arriving while it waits.
    const moved = turns.findIndex((turn, at) => {
      const before = drawn[at].turn;
      return (
        turn.reply !== before.reply ||
        (turn.interim ?? []).join("\u0000") !== (before.interim ?? []).join("\u0000") ||
        Boolean(turn.streaming) !== Boolean(before.streaming)
      );
    });
    if (moved >= 0) {
      paintAnswer(drawn[moved].node, turns[moved]);
      drawn[moved].turn = { ...turns[moved] };
    }
  } else if (entry.thread.querySelector(".turn-edit")) {
    // Someone is rewriting a queued message. Rebuilding the conversation under the field would take
    // the words being typed with it, so the paint is held rather than dropped: the editor replays it when
    // it closes, and the next broadcast draws the turn once the edit is done.
    entry.threadHeldBack = true;
  } else {
    const nodes = turns.map((turn, at) => turnNode(entry, turn, at));
    entry.thread.replaceChildren(...nodes);
    entry.turnNodes = turns.map((turn, at) => ({ turn: { ...turn }, node: nodes[at] }));
  }
  if (!fresh && !(Boolean(last?.streaming) && atBottom)) return;
  // The note above the thread can be taller than the card, so the answer would land below the
  // fold with nothing moving: the card's own column scrolls down to it.
  requestAnimationFrame(() => {
    entry.scroll.scrollTop = entry.scroll.scrollHeight;
  });
}

/** A message from the user, with the agent's answer attached once it arrives. */
function stickyBody(data) {
  const holder = el("div", "sticky-body");
  // A thread card keeps its conversation in the turns, and the daemon sends no text of its own: an
  // empty one is not a message, so it draws no bubble and no state line beside it.
  const said = String(data.text ?? "").trim();
  if (said) {
    const text = el("div", "sticky-text");
    text.textContent = said;
    holder.appendChild(text);
    if (data.images) {
      const shot = el("div", "sticky-status");
      shot.textContent = `${data.images} image${data.images > 1 ? "s" : ""} attached`;
      holder.appendChild(shot);
    }
    const status = el("div", `sticky-status ${data.status || "queued"}`);
    status.textContent =
      data.status === "answered"
        ? "answered"
        : data.status === "stopped"
          ? "stopped"
          : data.status === "sent"
            ? "sent"
            : `queued · ${data.mode === "steer" ? "steer" : "queue"}`;
    holder.appendChild(status);
  }
  if (data.reply) {
    const reply = el("div", "sticky-reply note-body");
    reply.appendChild(renderMarkdown(data.reply));
    holder.appendChild(reply);
  }
  // The tree this thread works in, so its branch can be found without reading what the agent was
  // told. A thread with no tree says why: the folder is not a repository, or git refused.
  if (data.worktree) holder.appendChild(worktreeLine(data.worktree));
  return holder;
}

/** The branch a thread commits on, and the path its work sits at, in one muted line. */
function worktreeLine(tree) {
  const line = el("div", "sticky-worktree");
  if (tree.skipped) {
    line.textContent = `no worktree: ${tree.skipped}`;
    line.classList.add("skipped");
    return line;
  }
  const branch = el("span", "tree-branch");
  // A tree on its detached base has no branch until the child cuts one, and the line says which base
  // it is standing on rather than leaving an empty slot the human has to interpret.
  branch.textContent = tree.branch ?? `detached on ${tree.base}`;
  line.appendChild(branch);
  if (tree.ignored === false) {
    const warn = el("span", "tree-warn");
    warn.textContent = ".agents/ not ignored";
    warn.title = `${tree.path}\n.gitignore does not cover .agents/, so this tree shows in git status`;
    line.appendChild(warn);
  }
  line.title = tree.path ? `${tree.path}\ncut from ${tree.base}` : "";
  return line;
}

/**
 * The fold's state per card id: a repaint rebuilds the body on every tick and a reconnect replays
 * the snapshot, so the open state and the scroll offset cannot live on the entry.
 */
const foldState = new Map();

/**
 * The folded detail under a card: the full prompt a delegate was given and what it spent.
 */
function detailsBlock(details, entry) {
  const state = foldState.get(entry.id) ?? { open: false, top: 0 };
  foldState.set(entry.id, state);
  const box = el("details", "card-details");
  const summary = el("summary");
  summary.textContent = "prompt and usage";
  const inner = el("div", "details-body");
  inner.appendChild(renderMarkdown(details));
  box.append(summary, inner);
  box.open = state.open;
  box.addEventListener("toggle", () => {
    state.open = box.open;
    // A settled run is never re-broadcast, so nothing else grows the card for the fold and the
    // human would get a scroller inside a scroller.
    if (box.open) fitContent(entry, entry.data);
  });
  inner.addEventListener("scroll", () => {
    state.top = inner.scrollTop;
  });
  // The inner body is a new element on every repaint and starts at the top, so put it back.
  requestAnimationFrame(() => {
    inner.scrollTop = state.top;
  });
  return box;
}

function bodyFor(data, entry) {
  if (data.type === "source") return { node: sourceBody(data), cls: "source-body" };
  if (data.type === "sticky") return { node: stickyBody(data), cls: "" };
  if (data.type === "question") return { node: questionBody(data, entry), cls: "" };
  const note = renderMarkdown(data.markdown || "");
  // Into the renderer's own holder, so `.note-body > :first-child` still finds the note's first
  // element instead of a wrapper. A note without details keeps the body it had before the fold.
  if (data.details) note.appendChild(detailsBlock(data.details, entry));
  return { node: note, cls: "note-body" };
}

// ---------- cards --------------------------------------------------------
/** Half a card on screen for this long is a card the human has had a chance to read. */
const SEEN_MS = 1500;
const seenTimers = new Map();
/** Only the cards the observer last called on screen may start a countdown. */
const inView = new Set();
/** A ratio reported as an int can sit a hair under the threshold the card just crossed. */
const RATIO_EPS = 0.01;

function forgetSeen(card) {
  const timer = seenTimers.get(card);
  if (timer) clearTimeout(timer);
  seenTimers.delete(card);
}

function armSeen(card) {
  // A hidden tab is nobody looking, so it schedules nothing: visibilitychange starts over.
  if (document.hidden || seenTimers.has(card)) return;
  seenTimers.set(
    card,
    setTimeout(() => {
      seenTimers.delete(card);
      if (!document.hidden) clearFresh(card);
    }, SEEN_MS),
  );
}

/**
 * "New" has to expire on its own, or every card ends up wearing the same border and badge and
 * the mark stops meaning anything. The countdown belongs to the time the card is on screen: a
 * card scrolled away before it fires is still new when it comes back.
 */
const seenObserver = new IntersectionObserver(
  (hits) => {
    for (const hit of hits) {
      // The root is the canvas, not the window: a card the rail or the bars clip is not in
      // front of the human even when it sits inside the window. Half of whichever is smaller,
      // so a card taller than the canvas still counts once half the canvas shows it.
      const half = Math.min(hit.boundingClientRect.height, viewport.clientHeight) * 0.5;
      const onScreen = hit.isIntersecting && (hit.intersectionRatio >= 0.5 - RATIO_EPS || hit.intersectionRect.height >= half);
      if (onScreen) {
        inView.add(hit.target);
        armSeen(hit.target);
      } else {
        inView.delete(hit.target);
        forgetSeen(hit.target);
      }
    }
    // The pill counts what the same rule does not call on screen, so the two cannot disagree.
    recomputePill();
  },
  { root: viewport, threshold: [0, 0.5] },
);

/**
 * The one place a card stops being new: the border, the badge, the rail row and the pill all
 * read .fresh, so they have to change together or the board contradicts itself.
 */
function clearFresh(card) {
  if (!card || !card.classList.contains("fresh")) return;
  card.classList.remove("fresh");
  forgetSeen(card);
  inView.delete(card);
  seenObserver.unobserve(card);
  // Hidden, not removed: dropping the badge would shift the buttons under the pointer.
  const badge = card.querySelector(".new-badge");
  if (badge) badge.style.visibility = "hidden";
  syncRailCard(byId.get(card.dataset.id));
  recomputePill();
}

/** A delegate card reports its own progress, so it redraws far more often than a note. */
function isDelegate(data) {
  return typeof data.key === "string" && data.key.startsWith("delegate-");
}

/**
 * The pin is drawn rather than typed: no font's pin glyph is monochrome on every machine, and this one
 * has to take the amber of the pinned state. The button outlines it until the card is pinned.
 */
const PIN_GLYPH =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.6 1.6h6.8v1.7H2.6zM4.2 3.3h3.6L6.9 6.4H5.1zM6 6.4V10.8"/></svg>';

function makeCard(data, quiet = false) {
  const isSource = data.type === "source";
  const isQuestion = data.type === "question";
  const kind = data.type;
  const isNote = data.type === "note";
  const width = data.rect ? data.rect.w : defaultWidth(kind);
  // A delegate card opens small and grows as the run reports; a normal note wants the room. A thread's
  // card is taller than a note because the field at its foot takes a share of the height, and the
  // conversation above it still has to be readable.
  const delegate = isDelegate(data);
  const defaultHeight = isSource ? 430 : isQuestion ? 300 : isNote ? (delegate ? 220 : 420) : 440;
  const height = data.rect ? data.rect.h : defaultHeight;
  // An agent knows the shape of what it wrote, not how wide a card is, so `size` is a preset on the
  // defaults above rather than a size. A rect the user dragged always wins over the preset.
  const preset =
    data.size === "compact"
      ? { w: Math.round(width * 0.72), h: 240 }
      : data.size === "wide"
        ? { w: Math.round(width * 1.45), h: height }
        : data.size === "tall"
          ? { w: width, h: 640 }
          : { w: width, h: height };
  const cardWidth = data.rect ? width : preset.w;
  const cardHeight = data.rect ? height : preset.h;

  // The server remembers where a card was put, so a refresh and other tabs agree. A card
  // without a place cascades under the card its reply was asked on, and without a thread goes
  // in the nearest free area to the middle of what you are looking at.
  const spot = data.rect
    ? { x: data.rect.x, y: data.rect.y, w: cardWidth, h: cardHeight }
    : threadSpot(data.threadRoot, cardWidth, cardHeight) ?? findFreeSpot(cardWidth, cardHeight, viewportCenter());
  occupied.push(spot);
  if (!data.rect) void saveLayout(data.id, spot);

  const card = el("div", kind === "sticky" ? "card sticky" : "card");
  card.style.cssText = `left:${spot.x}px; top:${spot.y}px; width:${cardWidth}px; height:${cardHeight}px; z-index:${z++}`;
  card.dataset.rect = JSON.stringify(spot);
  card.dataset.kind = kind;
  card.dataset.size = data.size || "normal";
  card.dataset.id = data.id;
  if (data.threadRoot) card.dataset.threadRoot = data.threadRoot;
  setAfter(card, data.after);

  const head = el("div", "head");
  head.innerHTML = `
    <span class="dot ${dotKind(kind)}"></span>
    <span class="title"></span>
    <span class="role-chip"></span>
    <span class="mode-chip"></span>
    <span class="sub"></span>
    <span class="spacer"></span>
    <button type="button" class="ask-pill" aria-label="centre this question">answer needed</button>
    <span class="chip"></span>
    <button type="button" class="copy-id" title="copy this card's id">⧉</button>
    <button class="pin" title="pin this card" aria-label="pin this card">${PIN_GLYPH}</button>
    <button class="min" title="minimize this card" aria-label="minimize this card">▾</button>
    <button class="reply" title="ask a follow-up about this card" aria-label="ask a follow-up about this card">↩</button>
    <button class="edit" title="edit this note" aria-label="edit this note">✎</button>
    <button class="close" title="close" aria-label="close">×</button>`;
  // One scroll column holds the note and its follow-ups, so a long card has one scrollbar.
  const scroll = el("div", "card-scroll");
  const body = el("div", "body");
  const thread = el("div", "thread");
  thread.hidden = true;
  // What the thread is doing right now, drawn in the same rows the log keeps: the live step is read
  // where the answer will appear, and it leaves for the log the moment it settles. Pinned under the
  // answer rather than inside the scrolling column, so a long note cannot hide the run.
  const live = el("div", "card-live");
  scroll.append(body, thread);
  const grip = el("div", "resize");
  card.append(head, scroll, live, grip);
  world.appendChild(card);
  cards.push(card);
  scheduleMap();
  // A new card takes its place in the stack; a replay settles every thread once it is done.
  if (data.threadRoot && !replaying) applyThreadOrder(data.threadRoot);

  const badge = el("span", "new-badge");
  // A restored card is one you already had, so it does not carry a "new" tag.
  if (replaying || quiet) badge.style.visibility = "hidden";
  badge.textContent = "new";
  head.insertBefore(badge, head.querySelector(".close"));
  if (!replaying) {
    card.classList.add("fresh");
    // Watched only while it can still stop being new.
    seenObserver.observe(card);
  }
  // A card the human clicks is seen at once, without waiting for the observer's countdown. A
  // middle press is the workspace grab and belongs to the canvas, so it reads as neither a click
  // nor a raise: it must not mark a card read, lift it, or take the selection away.
  card.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button === 1) return;
      clearFresh(card);
    },
    true,
  );

  const entry = {
    id: data.id,
    card,
    head,
    scroll,
    body,
    thread,
    live,
    titleEl: head.querySelector(".title"),
    roleEl: head.querySelector(".role-chip"),
    modeEl: head.querySelector(".mode-chip"),
    subEl: head.querySelector(".sub"),
    chipEl: head.querySelector(".chip"),
    askPill: head.querySelector(".ask-pill"),
    data,
  };
  byId.set(data.id, entry);
  // A thread's card is where its conversation is written and read, so it carries the field. A note, a
  // source and a question are read through the thread above them and never grow one.
  if (kind === "sticky") {
    const inst = makeComposer(entry);
    entry.composer = inst;
    card.insertBefore(inst.root, grip);
    restoreDraft(inst);
    paintRuntime(inst);
  }
  entry.askPill.addEventListener("click", (event) => {
    event.stopPropagation();
    centreQuestion(entry);
  });
  // The id is how a card is named in a message and in a bug report, and nothing on the board shows it:
  // one press puts it on the clipboard, and the footer repeats it in case the clipboard is refused.
  const copyId = head.querySelector(".copy-id");
  copyId.title = `copy this card's id · ${data.id}`;
  copyId.setAttribute("aria-label", `copy the id of ${data.title || "this card"}`);
  copyId.addEventListener("click", (event) => {
    event.stopPropagation();
    copyText(entry.id)
      .then(() => footNote(`card id copied · ${entry.id}`))
      .catch(() => footNote(`the clipboard refused, so the card id is here · ${entry.id}`));
  });
  if (data.mini) setMini(card, true);
  capField(card, height);
  paintCard(entry, data);
  // A card that arrives while another is selected must not arrive brighter than the rest.
  paintFocus();

  card.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button === 1) return;
      card.style.zIndex = z++;
      selectCard(card);
    },
    true,
  );

  // The keyboard and the mouse agree on which card is current: focus landing inside a card marks it,
  // so the outline, `r` and the digit keys follow the keyboard rather than the last click. A press in
  // the card's own field selects the card as well: the field is written in that card, not about it.
  card.addEventListener("focusin", (event) => {
    selectCard(card);
    reveal(event.target);
  });

  head.querySelector(".min").addEventListener("click", (event) => {
    event.stopPropagation();
    const mini = !card.classList.contains("mini");
    setMini(card, mini);
    const rect = JSON.parse(card.dataset.rect || "{}");
    void saveLayout(entry.id, rect, mini);
  });

  head.querySelector(".pin").addEventListener("click", (event) => {
    event.stopPropagation();
    togglePin(entry);
  });

  head.querySelector(".reply").addEventListener("click", (event) => {
    event.stopPropagation();
    replyToCard(entry);
  });

  // The pencil toggles. A press while the editor is open closes it, and it has to happen on
  // pointerdown: the press blurs the textarea, the blur commits and repaints, and by the time the
  // click arrives the card reads as not editing, so it would open a fresh editor on the note the
  // reader had just finished with.
  let editPressClosed = false;
  head.querySelector(".edit").addEventListener("pointerdown", (event) => {
    if (!entry.editing) return;
    event.preventDefault();
    editPressClosed = true;
    entry.finishEdit?.(true);
  });
  head.querySelector(".edit").addEventListener("click", (event) => {
    event.stopPropagation();
    if (editPressClosed) {
      editPressClosed = false;
      return;
    }
    startEditing(entry);
  });

  head.querySelector(".close").addEventListener("click", (event) => {
    event.stopPropagation();
    closeCard(entry);
  });

  head.addEventListener("pointerdown", (event) => {
    // Buttons in the header are for clicking, not for dragging the card. The middle button pans
    // the canvas even here, so it belongs to the workspace rather than to the card.
    // Ctrl (or command) is the reading modifier: the press belongs to the text, not to the card.
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.target.closest(INTERACTIVE)) return;
    // Two presses on the name in quick succession rename the card, the way a file manager does.
    // The press that starts a rename belongs to the name, so the card does not begin to drag.
    const named = event.target.closest(".title");
    if (named && doubledOnTitle(named)) {
      event.preventDefault();
      event.stopPropagation();
      startRenaming(entry);
      return;
    }
    startCardDrag(card, entry, event);
  });

  // The whole card is a handle. Dragging its text used to select the text, which made reading a
  // board feel like a web page rather than a surface: hold ctrl for that instead, the same modifier
  // the wheel uses for zoom.
  card.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey) return;
    // The head starts the same drag on its own press, and preventing the default there does not
    // stop the event from reaching here.
    if (card.classList.contains("dragging")) return;
    if (event.target.closest(INTERACTIVE)) return;
    startCardDrag(card, entry, event);
  });

  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    const sx = event.clientX;
    const sy = event.clientY;
    const ow = card.offsetWidth;
    const oh = card.offsetHeight;
    const move = (ev) => {
      card.style.width = `${Math.max(240, ow + (ev.clientX - sx) / view.k)}px`;
      card.style.height = `${Math.max(120, oh + (ev.clientY - sy) / view.k)}px`;
      // A size the user chose wins over growing to fit later answers.
      card.dataset.sized = "user";
      card.classList.remove("auto-height");
      scheduleMap();
      scheduleArrows();
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      const rect = {
        x: Math.round(parseFloat(card.style.left)),
        y: Math.round(parseFloat(card.style.top)),
        w: card.offsetWidth,
        h: card.offsetHeight,
      };
      placeCard(entry, rect);
      void saveLayout(entry.id, rect);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  });

  updateEmpty();
  return entry;
}

/** What the daemon last said about each thread, taken from the cards that speak for it. */
const threadFacts = new Map();

function compact(number) {
  const value = Number(number) || 0;
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

/** The last meta the daemon sent, which is where the board-wide totals come from. */
let boardMetaCache = {};

/**
 * The footer is the numbers of whatever you are reading: the selected card's thread, in full, or
 * the whole board when nothing is selected. It is the same rule the wheel and the dimming follow.
 */
function paintFooter() {
  const model = document.getElementById("statModel");
  const tokens = document.getElementById("statTokens");
  const cost = document.getElementById("statCost");
  const footCtx = document.getElementById("footCtx");
  const footRun = document.getElementById("footRun");
  const selected = document.querySelector(".card.active");
  const data = selected ? byId.get(selected.dataset.id)?.data : null;
  const threadId = data ? (data.type === "sticky" ? data.id : (data.answersWith?.thread ?? data.threadRoot)) : null;
  const held = threadId ? threadFacts.get(threadId) : null;
  const money = (value) => (value > 0 ? `$${value < 0.01 ? value.toFixed(4) : value.toFixed(3)}` : "");
  const counts = (stats) => [stats.messages ? `${stats.messages} msgs` : "", stats.tools ? `${stats.tools} tools` : ""].filter(Boolean).join(" · ");

  if (held) {
    // One thread: everything the daemon knows about it, because that is what a selection asks.
    const stats = held.stats ?? {};
    // Who answered, named in full: a footer that said only `deepseek-v4.1` left the reader guessing
    // which endpoint it came from.
    const where = [held.provider, held.model].filter(Boolean).join("/");
    model.textContent = where;
    model.title = where;
    tokens.innerHTML = stats.input || stats.output ? `↑${shortNum(stats.input)} ↓${shortNum(stats.output)}${stats.cacheRead ? ` cache ${shortNum(stats.cacheRead)}` : ""}` : "";
    cost.textContent = money(stats.cost);
    footCtx.textContent = stats.context ? `ctx ${compact(stats.context)}${stats.contextMax ? `/${compact(stats.contextMax)} · ${Math.round((stats.context / stats.contextMax) * 100)}%` : ""}` : "";
    footRun.textContent = held.running ? "running" : counts(stats);
    return;
  }

  // Nothing selected: the board's own totals, summed, with the largest context since those do not add.
  let cache = 0;
  let context = 0;
  let max = 0;
  let running = 0;
  let threads = 0;
  let msgs = 0;
  let tools = 0;
  for (const thread of threadFacts.values()) {
    if (thread.running) running += 1;
    const stats = thread.stats;
    if (!stats) continue;
    threads += 1;
    cache += stats.cacheRead ?? 0;
    msgs += stats.messages ?? 0;
    tools += stats.tools ?? 0;
    if ((stats.context ?? 0) > context) {
      context = stats.context;
      max = stats.contextMax ?? 0;
    }
  }
  const meta = boardMetaCache ?? {};
  const where = [boardConfig.provider, meta.model].filter(Boolean).join("/");
  model.textContent = where;
  model.title = `the board's default · ${where}`;
  tokens.innerHTML = meta.tokensIn || meta.tokensOut ? `↑${shortNum(meta.tokensIn)} ↓${shortNum(meta.tokensOut)}${cache ? ` cache ${shortNum(cache)}` : ""}` : "";
  cost.textContent = money(meta.cost);
  footCtx.textContent = context ? `ctx ${compact(context)}${max ? `/${compact(max)} · ${Math.round((context / max) * 100)}%` : ""}` : "";
  footRun.textContent = [threads ? `${threads} thread${threads > 1 ? "s" : ""}` : "", running ? `${running} running` : "", msgs ? `${msgs} msgs` : "", tools ? `${tools} tools` : ""].filter(Boolean).join(" · ");
}

/** A section says what its thread costs and offers the stop the card's head also offers. */
function paintSections() {
  for (const entry of railSections.values()) {
    const held = threadFacts.get(entry.id);
    const stats = held?.stats;
    const bits = [];
    if (stats?.context) bits.push(`${compact(stats.context)}${stats.contextMax ? `/${compact(stats.contextMax)}` : ""} ctx`);
    if (stats?.cost) bits.push(`$${stats.cost < 1 ? stats.cost.toFixed(2) : compact(stats.cost)}`);
    entry.head.children[3].textContent = bits.join(" · ");
    entry.head.children[4].hidden = held?.running !== true;
    // The role arrives with the thread's card, which can land after its first activity row.
    const { role = "" } = threadMeta.get(entry.id) ?? {};
    entry.roleEl.textContent = role;
    entry.roleEl.hidden = !role;
    orderRail();
  }
}

/**
 * The thread a card belongs to. A thread card is its own; a plain card belongs to the thread that
 * made it, which is also the card it cascades under. Two cards share a family when they are the same
 * conversation.
 */
function familyOf(entry) {
  const data = entry?.data ?? {};
  if (!entry) return "";
  return data.type === "sticky" ? entry.id : data.threadRoot || entry.id;
}

/**
 * Reading one conversation dims the others, so a board of a dozen threads stays readable while the
 * one you picked keeps its weight. With nothing selected, or with the feature off, everything is equal.
 */
function paintFocus() {
  const on = boardConfig.dimOthers !== false;
  const selected = on ? cards.find((card) => card.classList.contains("active")) : undefined;
  const family = selected ? familyOf(byId.get(selected.dataset.id)) : "";
  for (const card of cards) {
    const entry = byId.get(card.dataset.id);
    card.classList.toggle("dim", Boolean(selected) && Boolean(entry) && familyOf(entry) !== family);
  }
  // The footer reads the selected thread too, so a selection change is a footer change.
  paintFooter();
}

/**
 * One place marks which card the board is reading. Reading a card is not typing into it: the field sits
 * in every thread card already, and the caret goes there with the `↩` in the head or with `r`.
 */
function selectCard(card) {
  for (const other of cards) other.classList.toggle("active", other === card);
  // Reading another card gives the keyboard back to the board. A field left with the caret in a card
  // nobody is reading would take `r` and the digit keys as letters, which is exactly the key that names
  // the card just clicked.
  const typing = focusedComposer();
  const was = cardOf(typing);
  if (typing && was !== (card ? byId.get(card.dataset.id) : null)) document.activeElement.blur();
  paintFocus();
}

/**
 * What answers this card is doing. A thread card says it itself — the daemon sends `sent` while a run
 * is live — and a plain card says it through the child that owns it.
 */
/** A thread that has been asked to stop. A stop that does not land turns into a kill. */
const stopping = new Set();

/**
 * What a pointer down on a card may not grab: the controls in its head, the field inside it, a link or a
 * checkbox, the resize corner. Everything else is surface, which drags the card.
 */
const INTERACTIVE =
  ".close, .edit, .reply, .min, .ask-pill, .resize, input, textarea, button, a, [contenteditable], .xref, .tick, .q-options, .composer";

/** Move a card by dragging it, in board units, so the card keeps up at any zoom. */
function startCardDrag(card, entry, event) {
  // The text is not being selected, so the browser must not start selecting it.
  event.preventDefault();
  card.classList.add("dragging");
  const sx = event.clientX;
  const sy = event.clientY;
  const ox = parseFloat(card.style.left);
  const oy = parseFloat(card.style.top);
  const move = (ev) => {
    card.style.left = `${ox + (ev.clientX - sx) / view.k}px`;
    card.style.top = `${oy + (ev.clientY - sy) / view.k}px`;
    scheduleMap();
    scheduleArrows();
  };
  const up = () => {
    card.classList.remove("dragging");
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    const rect = {
      x: Math.round(parseFloat(card.style.left)),
      y: Math.round(parseFloat(card.style.top)),
      w: card.offsetWidth,
      h: card.offsetHeight,
    };
    placeCard(entry, rect);
    void saveLayout(entry.id, rect);
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
}

/** The agent is blocked on this card until the question on it is answered. */
function questionWants(data) {
  return Boolean(data) && data.type === "question" && data.status === "open";
}

/**
 * What a thread is, as far as the board knows it: its title, the role it was spawned with, and the
 * thread that spawned it. A thread card carries all three, so this fills in as cards arrive and
 * needs nothing new from the daemon. The rail reads it to nest a child under its master, and the
 * sub line reads it for a master whose card is closed.
 */
const threadMeta = new Map();

function rememberThread(data) {
  if (data.type !== "sticky") return;
  const known = threadMeta.get(data.id) ?? {};
  const title = data.title || known.title || "";
  const role = data.role || "";
  const parent = data.parentThread || "";
  const status = data.status || "";
  if (known.title === title && known.role === role && known.parent === parent && known.status === status) return;
  threadMeta.set(data.id, { title, role, parent, status });
  // A master's sub line says which child it is waiting on, so a child that starts or settles repaints the
  // card above it. One level is all the depth rule allows, so this cannot walk a chain.
  if (parent && known.status !== status) {
    const master = byId.get(parent);
    if (master && !master.editing) paintCard(master, master.data);
  }
}

/** The child a boss is waiting on, if one of its children is still running. */
function runningChild(threadId) {
  for (const meta of threadMeta.values()) {
    if (meta.parent === threadId && meta.status === "sent") return meta.title || "a child";
  }
  return "";
}

/** The name of the thread that spawned this one, if the board still knows it. */
function masterTitle(threadId) {
  return byId.get(threadId)?.data?.title || threadMeta.get(threadId)?.title || "";
}

/**
 * A spawned card says who spawned it. Its own status follows, because a child that has not spoken
 * yet has no body line to carry it, and `queued` is the one word a human needs there.
 */
function stickySub(data) {
  const status = data.status || "queued";
  if (!data.parentThread) return status;
  // A hidden master has no card on the board, so the child carries its name in the payload.
  const master = masterTitle(data.parentThread) || data.parentTitle || "";
  return master ? `spawned by ${master} · ${status}` : `spawned · ${status}`;
}

/**
 * A boss that is blocked in a spawn says what it is waiting for: the card is otherwise a thread that
 * looks idle while its children run.
 */
function bossSub(data, entry) {
  if (data.mode === "boss") {
    const waiting = runningChild(entry.id);
    if (waiting) return `waiting on ${waiting}`;
  }
  return stickySub(data);
}

/** A note says when it arrived, or when it last changed once it has changed. */
function noteSub(data, entry) {
  if (!entry.updatedAt) return new Date(data.at || Date.now()).toLocaleTimeString();
  // Hours and minutes only: a card repainted on every run step must not flicker as seconds tick.
  return `updated ${new Date(entry.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

/**
 * An open question says when it gives up, so the wait has a visible end, and a card of tabs says how
 * many it asks. A settled one says what actually happened: an answer, or a question the board abandoned.
 */
function questionSub(data) {
  const tabs = Array.isArray(data.questions) && data.questions.length > 1 ? `${data.questions.length} questions · ` : "";
  if (data.status === "answered") return `${tabs}answered`;
  if (data.status === "expired") return `${tabs}expired — no answer sent`;
  if (!data.expiresAt) return `${tabs}waiting for you`;
  return `${tabs}expires ${new Date(data.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function paintCard(entry, data) {
  const isSource = data.type === "source";
  const isOpenQuestion = questionWants(data);
  entry.data = data;
  // The pin is the server's word, so a reload paints the card the way the click left it.
  setPinned(entry.card, data.pinned === true);
  if (entry.editing) return;
  // While a name is being typed, its field sits beside this span, so a repaint writes where nobody
  // is looking and the hidden span keeps the words the rail row shows. A thread is named by its first
  // request, so until then it has no name at all: an invented one like `thread 1` is a label the
  // human has to unlearn.
  const shownTitle =
    data.title ||
    (isSource ? data.path : data.type === "question" ? "question" : data.type === "sticky" ? "" : "note");
  entry.titleEl.textContent = shownTitle;
  entry.titleEl.title = shownTitle;
  // The thread is remembered before the sub line is written: a boss's line asks which of its children is
  // still running, and that answer comes from what the cards have said so far.
  rememberThread(data);
  entry.subEl.textContent = isSource
    ? `${data.content.split("\n").length} lines`
    : data.type === "question"
      ? questionSub(data)
      : data.type === "sticky"
        ? bossSub(data, entry)
        : noteSub(data, entry);
  // The role is the promise a child was started under, so the card wears it as a chip. A thread the
  // human made has no role and the chip takes no space.
  const role = data.type === "sticky" ? data.role || "" : "";
  entry.roleEl.textContent = role;
  entry.roleEl.title = role ? `spawned with the ${role} role` : "";
  entry.roleEl.style.display = role ? "" : "none";
  // A boss is a thread the human started that spawns instead of working, so its chip carries the flow it
  // runs; `auto` is the boss still deciding.
  const mode = data.type === "sticky" ? data.mode || "" : "";
  const shownMode = mode === "boss" && data.path ? `boss · ${data.path}` : mode;
  entry.modeEl.textContent = shownMode;
  entry.modeEl.title = mode
    ? mode === "boss"
      ? `a boss: it spawns children and does no work itself${data.pathChosenBy === "auto" && data.path !== "auto" ? `, flow chosen by the model` : ""}`
      : `a ${mode} thread`
    : "";
  // An agent is the baseline the board always had, so it wears nothing; a planner and a boss say so.
  entry.modeEl.style.display = mode && mode !== "agent" ? "" : "none";
  entry.subEl.classList.toggle("expired", data.type === "question" && data.status === "expired");
  // The pink ring and the pill belong to the question the agent is blocked on, so both go
  // away the moment it is settled.
  entry.card.classList.toggle("waiting", isOpenQuestion);
  entry.askPill.style.display = isOpenQuestion ? "" : "none";
  const editBtn = entry.head.querySelector(".edit");
  if (editBtn) editBtn.style.display = data.type === "note" ? "" : "none";
  // A thread is sent without `pinned`, so its head shows no pin rather than one that forgets itself.
  const pinBtn = entry.head.querySelector(".pin");
  if (pinBtn) pinBtn.style.display = data.type === "sticky" ? "none" : "";
  // One slot, two meanings: stop the run that is going, or end the child that is sitting idle. A card
  // with neither has nothing to stop, so it shows nothing.
  const closeBtn = entry.head.querySelector(".close");
  // Closing an open question would leave the agent waiting for an answer with nothing on
  // screen to click, so the button appears only once it has been answered or has expired.
  if (closeBtn) closeBtn.style.display = isOpenQuestion ? "none" : "";
  entry.chipEl.textContent = isSource && data.line ? `line ${data.line}` : "";
  entry.chipEl.style.display = entry.chipEl.textContent ? "" : "none";

  const { node, cls } = bodyFor(data, entry);
  entry.body.className = cls ? `body ${cls}` : "body";
  entry.body.replaceChildren(node);
  paintThread(entry, data);
  fitContent(entry, data);
  syncRailCard(entry);
}

/**
 * A note that holds more than its default height grows to fit, up to the CSS limit, so
 * nothing hides behind an inner scrollbar. It never shrinks on its own, and a card the user
 * resized keeps that size. An answered sticky does the same for its reply.
 */
function fitContent(entry, data) {
  if (entry.card.dataset.sized === "user" || entry.card.classList.contains("mini")) return;
  // An answer still being written would make the card grow, and grow it again, and every growth
  // writes this card's place to the daemon. It fits once, when the run has settled.
  if (Array.isArray(data.turns) && data.turns.some((turn) => turn.streaming)) return;
  const answeredSticky = data.type === "sticky" && Boolean(data.reply);
  const threaded = Array.isArray(data.turns) && data.turns.length > 0;
  // A question grows too: long options and the free-text row would otherwise hide behind the
  // column's scrollbar while the card sits at its default height.
  if (data.type !== "note" && data.type !== "question" && !answeredSticky && !threaded) return;
  requestAnimationFrame(() => {
    if (entry.card.dataset.sized === "user") return;
    // The note and its follow-ups share one column, so one measurement covers both.
    const tight = entry.scroll.scrollHeight > entry.scroll.clientHeight + 2;
    if (!tight) return;
    entry.card.classList.add("auto-height");
    requestAnimationFrame(() => {
      // The card can be closed between the two frames, and a snapshot replay clears and
      // re-creates the same id, so only this same entry may still claim a place.
      if (byId.get(entry.id) !== entry) return;
      const rect = {
        x: Math.round(parseFloat(entry.card.style.left)),
        y: Math.round(parseFloat(entry.card.style.top)),
        w: entry.card.offsetWidth,
        h: entry.card.offsetHeight,
      };
      // Through placeCard, so the space the card grew into is the space later cards avoid.
      placeCard(entry, rect);
      void saveLayout(entry.id, rect);
    });
  });
}

/**
 * The fields a repaint actually draws. A refresh that rewrites the same text is not news, and
 * a delegate card is re-broadcast every few seconds whether or not anything moved.
 */
function cardChanged(before, after) {
  // A mode or a flow is repainted too: `/mode` and `/thread/path` change nothing else on the card.
  const fields = ["title", "markdown", "details", "text", "question", "reply", "status", "mode", "path", "pathChosenBy"];
  if (fields.some((field) => before[field] !== after[field])) return true;
  if (JSON.stringify(before.worktree ?? null) !== JSON.stringify(after.worktree ?? null)) return true;
  // A follow-up's answer settles into the turn it was asked with, so the thread changes without
  // gaining a turn: compare what each turn draws, not only how many there are.
  const was = before.turns || [];
  const now = after.turns || [];
  if (was.length !== now.length) return true;
  return now.some((turn, at) => {
    const old = was[at] || {};
    return (
      old.text !== turn.text ||
      old.status !== turn.status ||
      old.reply !== turn.reply ||
      old.images !== turn.images ||
      (old.interim ?? []).join("\u0000") !== (turn.interim ?? []).join("\u0000")
    );
  });
}

/**
 * A card that changed says so. The ring is rate-limited because a progress card is re-broadcast
 * every few seconds; the header stamp is not, because it is cheap and has to be true.
 */
function markUpdated(entry) {
  const now = Date.now();
  // A delegate card rebuilds its markdown with the elapsed time, so every progress tick would
  // move this stamp and pin the rail age near zero. Its body already shows that time.
  if (!isDelegate(entry.data)) entry.updatedAt = now;
  const card = entry.card;
  // A card that is still new already wears the mark, so a ring on top of it says nothing.
  if (card.classList.contains("fresh")) return;
  if (entry.flashedAt && now - entry.flashedAt < 10000) return;
  entry.flashedAt = now;
  flashCard(card);
}

/**
 * What a card's body is built from. A quiet refresh that leaves all of this alone only has its
 * conversation repainted, so a note being answered does not lose the reader's selection ten times
 * a second.
 */
function bodySame(before, after) {
  if (JSON.stringify(before.worktree ?? null) !== JSON.stringify(after.worktree ?? null)) return false;
  return ["type", "markdown", "text", "path", "content", "line", "question", "status", "answer", "details"].every(
    (field) => before[field] === after[field],
  );
}

function applyMessage(data, quiet = false) {
  const existing = byId.get(data.id);
  if (existing) {
    if (!replaying && !quiet) {
      // An identical re-broadcast would only wipe a selection and reset a scrolled body.
      if (!cardChanged(existing.data, data)) {
        // The paint is skipped, but the record still has to be current: what answers a card is not
        // drawn on it, and a stale copy would leave the composer's pickers showing an old model.
        existing.data = data;
        return;
      }
      markUpdated(existing);
    }
    if (quiet && !replaying && bodySame(existing.data, data)) {
      existing.data = data;
      paintThread(existing, data);
      refreshXrefs();
      return;
    }
    paintCard(existing, data);
    refreshXrefs();
    return;
  }
  const entry = makeCard(data, quiet);
  // A card that arrives can be what another card's link was waiting for.
  refreshXrefs();
  recomputePill();
  if (!sawFirstCard) {
    sawFirstCard = true;
    if (!replaying) fitAll();
  }
  // An off-screen arrival is announced by the new-card pill, and a question has its own
  // centring below, so no scroll into view is needed (and the viewport cannot scroll).
  // A question blocks the agent, so it lands under the eye and the keyboard. A replay brings
  // back cards the user already has, so it never pulls the view or steals the focus.
  // A question already on screen keeps the view: a second one must not pull it away.
  const onScreen = [...byId.values()].some(
    (record) => record !== entry && record.data.type === "question" && record.data.status === "open" && isVisible(record.card),
  );
  if (!replaying && !quiet && data.type === "question" && data.status === "open" && !onScreen && !typingSomewhere()) {
    // One frame later: fitContent grows the card in its own rAF, so centring now would measure
    // the default height and leave the lower options under the fold.
    requestAnimationFrame(() => centreQuestion(entry));
  }
}

function clearBoard() {
  // Every field lives inside a card, so they go with the cards. A field's words are kept under its card
  // so a snapshot that rebuilds the board puts the same draft back.
  for (const inst of composers.values()) parkDraft(inst);
  composers.clear();
  activeComposer = null;
  for (const card of cards) card.remove();
  cards.length = 0;
  byId.clear();
  threadMeta.clear();
  scheduleArrows();
  // A replay rebuilds every card, so the observer must let go of the dead ones.
  seenObserver.disconnect();
  inView.clear();
  for (const timer of seenTimers.values()) clearTimeout(timer);
  seenTimers.clear();
  occupied.length = 0;
  freshCount = 0;
  clearRailCards();
  clearRailLog();
  applyClosed([]);
  paintPill();
  sawFirstCard = false;
  updateEmpty();
  scheduleMap();
}

/** Close a card here and on the server, so a refresh does not bring it back. */
function closeCard(entry) {
  dropCard(entry);
  void fetch(`/close?${auth}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cardId: entry.id }),
  }).catch(() => {});
}

/** Remove a card from the board and let later cards fill the space it held. */
function dropCard(entry) {
  const record = byId.get(entry.id);
  if (!record) return;
  // Compared by id: a remote remove arrives as a bare { id } and would never match the entry. A card
  // with a field takes its words with it, so they are put aside under its id for a card put back later.
  const held = record.composer;
  if (held) {
    parkDraft(held);
    composers.delete(held.key);
    if (activeComposer === held) activeComposer = null;
  }
  record.card.remove();
  forgetSeen(record.card);
  inView.delete(record.card);
  seenObserver.unobserve(record.card);
  const at = cards.indexOf(record.card);
  if (at >= 0) cards.splice(at, 1);
  byId.delete(record.id);
  // A closed card is a thread the board no longer draws, so it stops being a child its master waits on.
  threadMeta.delete(record.id);
  foldState.delete(record.id);
  // Links pointing at the card that just went have to stop looking live.
  refreshXrefs();
  dropRailCard(record.id);
  releaseSpot(record.card);
  recomputePill();
  updateEmpty();
  paintFocus();
  scheduleMap();
}

/** Free the rectangle a closed card was holding so later cards can fill the gap. */
function releaseSpot(card) {
  const rect = card.dataset.rect ? JSON.parse(card.dataset.rect) : null;
  if (!rect) return;
  const index = occupied.findIndex((candidate) => candidate.x === rect.x && candidate.y === rect.y);
  if (index >= 0) occupied.splice(index, 1);
}

/** Deliberate re-pack of everything, only ever triggered by the user. */
function tidy() {
  occupied.length = 0;
  const ordered = [...cards].sort((a, b) => (a.dataset.kind === "source" ? -1 : 0) - (b.dataset.kind === "source" ? -1 : 0));
  let cursor = { x: 60, y: 60 };
  for (const card of ordered) {
    const rect = findFreeSpot(card.offsetWidth, card.offsetHeight, cursor);
    occupied.push(rect);
    card.style.left = `${rect.x}px`;
    card.style.top = `${rect.y}px`;
    card.dataset.rect = JSON.stringify(rect);
    const record = byId.get(card.dataset.id);
    if (record) void saveLayout(record.id, { ...rect, w: card.offsetWidth, h: card.offsetHeight });
  }
  fitAll();
}

/**
 * Re-cascade every thread from its root, as if the cards had just arrived. Roots are visited in
 * arrival order, so a thread nested inside another cascades from a root that already moved. The
 * human pressed a button that moves furniture, so a card is placed by position even where
 * something stands; two threads that then overlap are left for tidy to sort out.
 */
function stack() {
  for (const thread of new Set(cards.map((card) => card.dataset.threadRoot))) {
    if (!thread) continue;
    const root = byId.get(thread);
    // threadMates already answers in arrival order, which is the order the cascade climbs.
    const mates = threadMates(thread).map((card) => byId.get(card.dataset.id)).filter(Boolean);
    // A closed root hands the anchor to the earliest member still open, which stays where it is.
    const anchor = root || mates[0];
    if (!anchor || !anchor.card.dataset.rect) continue;
    const base = rectOf(anchor.card);
    // A card that names its own thread is root and member at once; as the anchor it stays put.
    const rest = mates.filter((member) => member !== anchor);
    // A column opens once, from the widest card of the column that finished, so its rows cannot
    // march right by a whole card each time.
    let column = 0;
    let right = base.x + base.w;
    let widest = right;
    for (const [index, member] of rest.entries()) {
      const at = Math.floor(index / THREAD_ROWS);
      if (at !== column) {
        column = at;
        right = widest;
      }
      const now = member.card.dataset.rect ? rectOf(member.card) : null;
      // A folded card measures as its header only; the stored height is the one to unfold into.
      const h = member.card.classList.contains("mini") && now ? now.h : member.card.offsetHeight;
      const rect = cascadeSpot(base, right, index + 1, member.card.offsetWidth, h);
      widest = Math.max(widest, rect.x + rect.w);
      // Already where the cascade wants it: nothing to move and nothing to save.
      if (now && now.x === rect.x && now.y === rect.y && now.w === rect.w && now.h === rect.h) continue;
      placeCard(member, rect);
      // One request per moved card, no batch: the client keeps no queue of its own and the human
      // asked for one action, so there is nothing to merge a batch out of.
      void saveLayout(member.id, rect);
    }
    applyThreadOrder(thread);
  }
  fitAll();
}

function paintPill() {
  const pill = document.getElementById("newPill");
  if (!pill) return;
  pill.textContent = freshCount > 0 ? `${freshCount} new` : "";
  pill.style.display = freshCount > 0 ? "" : "none";
}

/** The count follows the observer, so a card the pill counts is a card whose mark still counts. */
function recomputePill() {
  freshCount = cards.filter((card) => card.classList.contains("fresh") && !inView.has(card)).length;
  paintPill();
}

function jumpToFresh() {
  const record = attentionCard();
  if (!record) return;
  view.k = Math.min(1.1, Math.max(view.k, 0.6));
  // A question takes the keyboard with it, the way it does when it arrives.
  if (questionWants(record.data)) centreQuestion(record);
  else centerOn(record);
  // One click clears one mark, so a second click moves on to the next card.
  clearFresh(record.card);
}

/**
 * What the pill leads to: an arrival the human has not looked at outranks a question that has
 * already waited out its mark, a question wins inside its group because it blocks the agent, and
 * the latest event beats the latest arrival.
 */
function attentionCard() {
  const entries = (list) => list.map((card) => byId.get(card.dataset.id)).filter(Boolean);
  // A fresh card is one the pill counts, so the same rule picks it here.
  const fresh = entries(cards.filter((card) => card.classList.contains("fresh") && !inView.has(card)));
  const pool = fresh.length
    ? fresh
    : entries(cards.filter((card) => !isVisible(card))).filter((entry) => questionWants(entry.data));
  // The change stamp is later than the arrival the card opened with, so it is the newer event.
  const stamp = (entry) => entry.updatedAt || new Date(entry.data.at || 0).getTime() || 0;
  const ranked = pool.sort(
    (a, b) => Number(questionWants(b.data)) - Number(questionWants(a.data)) || stamp(b) - stamp(a),
  );
  return ranked[0] || null;
}

function isVisible(card) {
  const x = parseFloat(card.style.left) * view.k + view.x;
  const y = parseFloat(card.style.top) * view.k + view.y;
  return x < viewport.clientWidth && x + card.offsetWidth * view.k > 0 && y < viewport.clientHeight && y + card.offsetHeight * view.k > 0;
}

/**
 * Bring the focused control into view, moving the view as little as it can. A control already
 * fully on screen is left alone, so tabbing through a card never drags the canvas out from under
 * the reader, and a card taller than the screen shows the field the focus is on, not its top.
 */
function reveal(node) {
  // A control touched to the header or the composer edge reads as cramped, so it keeps a margin.
  const margin = 12;
  const box = node.getBoundingClientRect();
  const area = viewport.getBoundingClientRect();
  const right = box.right - area.right;
  const bottom = box.bottom - area.bottom;
  if (box.left >= area.left + margin && box.top >= area.top + margin && right <= -margin && bottom <= -margin) return;
  if (box.left < area.left + margin) view.x += area.left + margin - box.left;
  else if (right > -margin) view.x -= right + margin;
  if (box.top < area.top + margin) view.y += area.top + margin - box.top;
  else if (bottom > -margin) view.y -= bottom + margin;
  applyView();
}

function updateEmpty() {
  if (emptyHint) emptyHint.style.display = cards.length ? "none" : "grid";
}

// ---------- view ---------------------------------------------------------
/**
 * Ctrl (or Cmd) plus wheel zooms around the pointer. Otherwise the selection decides what the
 * wheel moves: with a card selected the wheel scrolls that card, wherever the pointer happens to
 * be, and with nothing selected it pans the board. Panning moves nothing on the board, so a stray
 * scroll still cannot rearrange it.
 */
/** Tell the server where a card sits, so placement survives a refresh. */
function saveLayout(cardId, rect, mini, pinned) {
  const body = { cardId, rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h } };
  // Only sent when it is asked for, so an ordinary move never clears a folded card or a pin.
  if (typeof mini === "boolean") body.mini = mini;
  if (typeof pinned === "boolean") body.pinned = pinned;
  return fetch(`/layout?${auth}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

/**
 * Folding keeps the card's real height on the server, so restoring it puts the card back
 * exactly as it was. Only the header stays on the canvas.
 */
function setMini(card, mini) {
  card.classList.toggle("mini", mini);
  card.dataset.mini = mini ? "1" : "0";
  const button = card.querySelector(".min");
  if (button) {
    button.textContent = mini ? "▸" : "▾";
    button.title = mini ? "restore this card" : "minimize this card";
    // The glyph says nothing out loud, so the spoken name follows the tooltip.
    button.setAttribute("aria-label", button.title);
  }
  // A folded card is as tall as its header, and the minimap draws the size the eye sees.
  scheduleMap();
}

/**
 * A pin is the human's: the card stays when the board has to make room for a new one, and no thread may
 * close it. Nothing here decides that — it says which state the card is in, for the eye at the head.
 */
function setPinned(card, pinned) {
  card.classList.toggle("pinned", pinned);
  const button = card.querySelector(".pin");
  if (!button) return;
  button.classList.toggle("on", pinned);
  button.title = pinned ? "unpin this card" : "pin this card";
  // The glyph says nothing out loud, so the spoken name follows the tooltip.
  button.setAttribute("aria-label", button.title);
}

/** Flip a card's pin: the board shows it at once and the board's own repaint is what confirms it. */
function togglePin(entry) {
  // Only a plain card carries `pinned` back on every repaint and through a reload. A thread is sent
  // without it, so a pin there would be forgotten by the next turn: no button, and no key either.
  if (entry.data.type === "sticky") return;
  const pinned = !entry.card.classList.contains("pinned");
  setPinned(entry.card, pinned);
  const rect = JSON.parse(entry.card.dataset.rect || "{}");
  void saveLayout(entry.id, rect, undefined, pinned);
}

/**
 * How tall the field in a card may be dragged, from the height the card has: the head, the field's own
 * rows and a little of the conversation always stay, so the field's drag corner never leaves the card.
 */
function capField(card, height) {
  const room = Math.max(52, Math.min(340, Math.round(height) - 200));
  card.style.setProperty("--field-max", `${room}px`);
}

/** Move a card locally and take the space it now holds into account. */
function placeCard(record, rect) {
  const card = record.card;
  card.style.left = `${rect.x}px`;
  card.style.top = `${rect.y}px`;
  if (rect.w) card.style.width = `${rect.w}px`;
  if (rect.h) card.style.height = `${rect.h}px`;
  if (rect.h) capField(card, rect.h);
  const old = card.dataset.rect ? JSON.parse(card.dataset.rect) : null;
  if (old) {
    const at = occupied.findIndex((spot) => spot.x === old.x && spot.y === old.y);
    if (at >= 0) occupied.splice(at, 1);
  }
  card.dataset.rect = JSON.stringify(rect);
  occupied.push(rect);
  scheduleMap();
  scheduleArrows();
}

/** Save a note the user changed: a ticked box, or text typed in the editor. */
async function saveNote(entry, markdown) {
  entry.data = { ...entry.data, markdown };
  paintCard(entry, entry.data);
  try {
    await fetch(`/edit?${auth}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardId: entry.id, markdown }),
    });
  } catch {
    // A failed save leaves the text on screen; the next reload shows the server's copy.
  }
}

/** Give a card the name the human typed, and keep it on screen while the daemon agrees. */
async function renameCard(entry, title) {
  entry.data = { ...entry.data, title };
  paintCard(entry, entry.data);
  try {
    await fetch(`/rename?${auth}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardId: entry.id, title }),
    });
  } catch {
    // A failed rename keeps the new name on screen; the next reload shows the daemon's copy.
  }
}

/** Flip the Nth task marker, so the tick lands on the line the user clicked. */
function flipTask(markdown, index) {
  let seen = -1;
  return markdown.replace(/^(\s*[-*+]\s+)\[([ xX])\]/gm, (whole, lead, state) => {
    seen += 1;
    if (seen !== index) return whole;
    return `${lead}[${state.trim() ? " " : "x"}]`;
  });
}

/** The note body becomes a textarea holding its own markdown: no rich text, no surprises. */
function startEditing(entry) {
  if (entry.data.type !== "note") return;
  entry.editing = true;
  const pencil = entry.head.querySelector(".edit");
  if (pencil) pencil.title = "save and close";
  // Read the card's height before the body is swapped. A textarea carries no height of its own, so
  // an auto-sized card would shrink to its minimum the moment the note became an editor, and the
  // editor would open as a slit where the note used to be.
  const readingHeight = entry.card.offsetHeight;
  const area = el("textarea", "note-edit");
  area.value = entry.data.markdown || "";
  area.spellcheck = false;
  entry.body.replaceChildren(area);
  if (!entry.card.style.height) {
    const headHeight = entry.head.offsetHeight;
    area.style.minHeight = `${Math.max(200, readingHeight - headHeight - 2)}px`;
  }
  area.focus();
  const finish = (commit) => {
    if (!entry.editing) return;
    entry.editing = false;
    entry.finishEdit = null;
    if (pencil) pencil.title = "edit this note";
    const value = area.value;
    if (commit && value !== entry.data.markdown) void saveNote(entry, value);
    else paintCard(entry, entry.data);
  };
  entry.finishEdit = finish;
  area.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      // The editor takes Escape first: cancelling an edit must not give up the selection, and so
      // must not put a reply away either.
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      finish(true);
    }
  });
  area.addEventListener("blur", () => finish(true));
}

/**
 * A press that lands on the name soon after the last one is a double click. The card drags from
 * the same press, so this is counted here rather than left to the browser's own event, which a
 * prevented pointer down can swallow.
 */
let lastTitlePress = { at: 0, node: null };
function doubledOnTitle(node) {
  const now = Date.now();
  const again = lastTitlePress.node === node && now - lastTitlePress.at < 400;
  lastTitlePress = again ? { at: 0, node: null } : { at: now, node };
  return again;
}

/**
 * The name becomes a field holding itself. Enter or a click elsewhere keeps what was typed,
 * Escape drops it, and an empty name is no name at all, so the card keeps the one it had.
 */
function startRenaming(entry) {
  if (entry.renaming || entry.editing) return;
  const titleEl = entry.titleEl;
  const current = titleEl.textContent.trim();
  // Measured before the span is hidden, and wide enough for a name longer than the one there.
  const width = Math.max(120, Math.min(420, titleEl.offsetWidth + 80));
  entry.renaming = true;
  const field = el("input", "title-edit");
  field.type = "text";
  field.value = current;
  field.spellcheck = false;
  field.style.width = `${width}px`;
  titleEl.after(field);
  // Hidden rather than emptied: the rail row and a repaint both read this span.
  titleEl.style.display = "none";
  field.focus();
  field.select();
  const finish = (commit) => {
    if (!entry.renaming) return;
    entry.renaming = false;
    const wanted = field.value.trim();
    field.remove();
    titleEl.style.display = "";
    if (commit && wanted && wanted !== current) void renameCard(entry, wanted);
    else paintCard(entry, entry.data);
  };
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    }
    if (event.key === "Escape") {
      // The board gives up its selection on Escape too, and a dropped name should not cost it.
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }
  });
  field.addEventListener("blur", () => finish(true));
}

/** Ring a card once, through the same class a reference jump uses. */
function flashCard(card) {
  card.classList.add("flash");
  setTimeout(() => card.classList.remove("flash"), 1400);
}

/** Centre the view on a card and ring it, so a reference lands where it points. */
function centerOn(record) {
  const card = record.card;
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  const x = parseFloat(card.style.left) + card.offsetWidth / 2;
  const y = parseFloat(card.style.top) + card.offsetHeight / 2;
  const fits = Math.min(width / (card.offsetWidth + 80), height / (card.offsetHeight + 80));
  view.k = Math.min(view.k, Math.max(0.3, fits));
  view.x = width / 2 - x * view.k;
  view.y = height / 2 - y * view.k;
  applyView();
  flashCard(card);
  selectCard(card);
}

/** Centre a question and put the keyboard on its options, so the number keys are one press away. */
function centreQuestion(record) {
  // The rule jumpToFresh uses: never arrive so far out that the ring and the text stop reading.
  view.k = Math.min(1.1, Math.max(view.k, 0.6));
  centerOn(record);
  // A card of tabs starts on its tab row; a single question has only its options. preventScroll:
  // centring already moved the canvas, and a second jump would fight it.
  const target = record.body.querySelector(".q-tab.on") || record.body.querySelector(".q-options");
  target?.focus({ preventScroll: true });
}

/** True while the keystroke belongs to a field the user is typing in. */
function typingSomewhere() {
  const active = document.activeElement;
  return Boolean(active && active.closest("input, textarea"));
}

/**
 * The question a number key answers: the active one, and only while it is on screen and open. A
 * folded or scrolled-away question is one the user cannot see, so a digit must not answer it.
 */
function openQuestion() {
  const marked = document.querySelector(".card.active");
  const record = marked ? byId.get(marked.dataset.id) : null;
  if (!record || !questionWants(record.data)) return null;
  if (record.card.classList.contains("mini") || !isVisible(record.card)) return null;
  return record;
}

/** Follow a [[key]] reference: by key first, then by card title. */
/**
 * Where a cross-reference can land right now: what each card carries as its key, and its name.
 * A card that was closed takes both with it, so a link to it is dead and has to look it.
 */
function linkTargets() {
  const keys = new Set();
  for (const record of byId.values()) {
    if (record.data.key) keys.add(String(record.data.key).toLowerCase());
    const title = record.titleEl.textContent.trim().toLowerCase();
    if (title) keys.add(title);
  }
  return keys;
}

/** Mark every link nothing on the board answers, so a closed card is not a silent click. */
function refreshXrefs() {
  const keys = linkTargets();
  for (const record of byId.values()) {
    // The whole card, not only its body: a thread's replies are drawn in `entry.thread` beside it,
    // and a markdown note's links are in the body. A link may be in either.
    for (const link of record.card.querySelectorAll(".xref")) {
      const key = String(link.dataset.key ?? "");
      const known = keys.has(key.toLowerCase());
      link.classList.toggle("stale", !known);
      link.title = known
        ? `jump to ${key}`
        : `${key} is not on this board: that card was closed or never written`;
    }
  }
}

function jumpToKey(key) {
  const wanted = key.toLowerCase();
  for (const record of byId.values()) {
    if (record.data.key && record.data.key.toLowerCase() === wanted) {
      centerOn(record);
      return true;
    }
  }
  for (const record of byId.values()) {
    const title = record.titleEl.textContent.trim().toLowerCase();
    if (title && title === wanted) {
      centerOn(record);
      return true;
    }
  }
  return false;
}

viewport.addEventListener("click", (event) => {
  const tick = event.target.closest(".tick");
  if (tick) {
    const card = tick.closest(".card");
    const record = card ? byId.get(card.dataset.id) : null;
    const item = tick.closest("li");
    if (record && record.data.type === "note" && item && item.dataset.tick != null) {
      void saveNote(record, flipTask(record.data.markdown || "", Number(item.dataset.tick)));
    }
    return;
  }
  const link = event.target.closest(".xref");
  if (!link) return;
  event.preventDefault();
  const key = String(link.dataset.key ?? "");
  // A link whose card was closed points at nothing, and a click that does nothing reads as a broken
  // board. Say which card is missing instead.
  if (!jumpToKey(key)) footNote(`${key} is not on this board: that card was closed or never written`);
});

/** A wheel reports pixels, lines or pages, so one factor turns any of them into pixels. */
const wheelPixels = (event, delta) =>
  delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);

/**
 * The open editor under the pointer, if any. It is a textarea with its own overflow, so a wheel
 * over it scrolls the text you are writing. Only an editor counts here: any card with comments
 * has a scrollable body too, and taking the wheel for whichever card the pointer crossed would
 * pin the board to it, selected or not.
 */
function editorAt(target) {
  const area = target instanceof Element ? target.closest("textarea") : null;
  return area && area.scrollHeight - area.clientHeight > 1 ? area : null;
}

viewport.addEventListener("wheel", (event) => {
  if (!event.ctrlKey && !event.metaKey) {
    // One target per wheel: whatever scrolls under the pointer first, because that is what the
    // reader is looking at; otherwise the selection decides, so a board you are reading a card on
    // keeps still while you scroll that card, and a board with nothing selected pans.
    const selected = document.querySelector(".card.active");
    const scroller = editorAt(event.target) ?? selected?.querySelector(".card-scroll");
    const room = scroller ? scroller.scrollHeight - scroller.clientHeight : 0;
    if (room > 1) {
      event.preventDefault();
      scroller.scrollTop += wheelPixels(event, event.deltaY) || wheelPixels(event, event.deltaX);
      return;
    }
    event.preventDefault();
    view.x -= wheelPixels(event, event.deltaX);
    view.y -= wheelPixels(event, event.deltaY);
    applyView();
    return;
  }
  event.preventDefault();
  const k = Math.min(3, Math.max(0.25, view.k * Math.exp(-wheelPixels(event, event.deltaY) * 0.0015)));
  const rect = viewport.getBoundingClientRect();
  const px = event.clientX - rect.left;
  const py = event.clientY - rect.top;
  view.x = px - (px - view.x) * (k / view.k);
  view.y = py - (py - view.y) * (k / view.k);
  view.k = k;
  applyView();
}, { passive: false });

/** True once the middle drag that just ended actually moved, read by the `auxclick` below. */
let middleDragMoved = () => false;

/**
 * Panning is one gesture wherever it starts: the canvas moves under the pointer and the release
 * ends it, wherever the pointer happens to be by then. Both the background drag and the middle
 * button come through here, so they cannot drift apart.
 */
function beginPan(event) {
  viewport.classList.add("dragging");
  let lastX = event.clientX;
  let lastY = event.clientY;
  let moved = false;
  // Movement is applied as it happens rather than from the press, so a zoom or a fit in the
  // middle of a drag is not undone by the next inch of the pointer.
  const move = (ev) => {
    // A release the page never heard about would otherwise leave the board sliding on hover.
    if (!ev.buttons) return up();
    if (Math.abs(ev.clientX - lastX) + Math.abs(ev.clientY - lastY) > 2) moved = true;
    view.x += ev.clientX - lastX;
    view.y += ev.clientY - lastY;
    lastX = ev.clientX;
    lastY = ev.clientY;
    applyView();
  };
  const up = () => {
    viewport.classList.remove("dragging");
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    removeEventListener("pointercancel", up);
  };
  // A middle click that never travelled is a click, and a middle click on a link opens it. Only
  // the drag is swallowed.
  if (event.button === 1) middleDragMoved = () => moved;
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
  addEventListener("pointercancel", up);
}

// The left button pans the background. Over a card it belongs to the card, which drags, resizes
// and selects with it, so this gesture never starts there. Ctrl (or command) is the reading
// modifier: under it neither that drag nor this pan starts, so the press belongs to the text.
// The resize grip, the rail grip, the minimap and the middle button keep their own gestures.
viewport.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || event.ctrlKey || event.metaKey) return;
  if (event.target.closest(".card")) return;
  selectCard(null);
  beginPan(event);
});

/**
 * The reading modifier is held on the body, so the cursor says text while ctrl (or command) is
 * down. It is watched on the window, since the key is usually pressed with the pointer already
 * resting on a card, and the release is taken from a blur too: a window that loses focus never
 * hears the keyup, and the board would keep the reading cursor for good.
 */
const heldModifier = (on) => document.body.classList.toggle("text-select", on);
addEventListener("keydown", (event) => {
  if (event.key === "Control" || event.key === "Meta") heldModifier(true);
});
addEventListener("keyup", (event) => {
  if (event.key === "Control" || event.key === "Meta") heldModifier(false);
});
addEventListener("blur", () => heldModifier(false));

// The middle button is the workspace grab, so it works over anything the canvas holds: a card, the
// rail, the composer. The one exception is a detail panel, which is a dialog rather than part
// of the surface and reads better when a stray middle drag does not slide the board behind it.
document.addEventListener("pointerdown", (event) => {
  if (event.button !== 1 || !(event.target instanceof Element)) return;
  if (event.target.closest(".sheet")) return;
  // Chromium opens its autoscroll compass on a middle press and would keep the pointer for it.
  event.preventDefault();
  beginPan(event);
});
document.addEventListener("auxclick", (event) => {
  if (event.button !== 1 || !middleDragMoved()) return;
  event.preventDefault();
  middleDragMoved = () => false;
});

/**
 * Every card's outer edges in board units, or null on an empty board. One place measures the
 * board's extent, so a fit and the minimap cannot disagree about where it ends.
 */
function boardBounds() {
  if (!cards.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const card of cards) {
    const x = parseFloat(card.style.left);
    const y = parseFloat(card.style.top);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + card.offsetWidth);
    maxY = Math.max(maxY, y + card.offsetHeight);
  }
  return { minX, minY, maxX, maxY };
}

function fitAll() {
  const bounds = boardBounds();
  if (!bounds) return;
  const { minX, minY, maxX, maxY } = bounds;
  const pad = 40;
  const k = Math.min(
    (viewport.clientWidth - pad * 2) / (maxX - minX),
    (viewport.clientHeight - pad * 2) / (maxY - minY),
    1.15,
  );
  view.k = Math.max(0.3, k);
  view.x = (viewport.clientWidth - (maxX - minX) * view.k) / 2 - minX * view.k;
  view.y = (viewport.clientHeight - (maxY - minY) * view.k) / 2 - minY * view.k;
  applyView();
}

/**
 * `100%` is real size without losing your place, so the zoom pivots on a card that is really on
 * the board: the active one, or else the one nearest the middle of the screen. Its position on
 * screen stays put, which is what keeps 100% from landing on empty canvas. An empty board only
 * changes the zoom, because there is nothing to hold still.
 */
function resetZoom() {
  if (!cards.length) {
    view.k = 1;
    applyView();
    return;
  }
  // A board that is entirely off screen is framed first: 100% of empty canvas is still empty.
  if (!cards.some(isVisible)) fitAll();
  const mid = viewportCenter();
  const away = (card) => {
    const x = parseFloat(card.style.left) + card.offsetWidth / 2 - mid.x;
    const y = parseFloat(card.style.top) + card.offsetHeight / 2 - mid.y;
    return x * x + y * y;
  };
  const pivot =
    document.querySelector(".card.active") || cards.reduce((best, card) => (away(best) <= away(card) ? best : card));
  const px = parseFloat(pivot.style.left) + pivot.offsetWidth / 2;
  const py = parseFloat(pivot.style.top) + pivot.offsetHeight / 2;
  // Where the pivot sits on screen right now, which is where 100% has to leave it.
  const sx = px * view.k + view.x;
  const sy = py * view.k + view.y;
  view.k = 1;
  view.x = sx - px;
  view.y = sy - py;
  applyView();
}

// ---------- minimap ------------------------------------------------------
// The board at a glance: every card as a rectangle in its kind's colour, the window you are
// looking at drawn over them, and the rest dimmed. It draws what this page already holds, so
// nothing about it reaches the daemon.
const MAP_W = 208;
const MAP_H = 140;
const MAP_PAD = 8;
const MAP_COLOUR = { note: "#7d8590", code: "#d2a8ff", sticky: "#d29922", question: "#db61a2" };
const mapCanvas = document.getElementById("minimap");
const mapCtx = mapCanvas.getContext("2d");
const mapBtn = document.getElementById("mapBtn");
let mapOn = true;
let mapQueued = false;
/** The projection the last paint used, so a press lands where the eye saw the picture. */
let mapShown = null;

/** Board units to map pixels: one scale for both axes, letterboxed in the frame. */
function mapProjection(bounds) {
  const bw = Math.max(1, bounds.maxX - bounds.minX);
  const bh = Math.max(1, bounds.maxY - bounds.minY);
  const s = Math.min((MAP_W - MAP_PAD * 2) / bw, (MAP_H - MAP_PAD * 2) / bh);
  return { s, ox: (MAP_W - bw * s) / 2 - bounds.minX * s, oy: (MAP_H - bh * s) / 2 - bounds.minY * s };
}

/** What the canvas is showing right now, in board units. */
const windowBounds = () => ({
  minX: -view.x / view.k,
  minY: -view.y / view.k,
  maxX: (viewport.clientWidth - view.x) / view.k,
  maxY: (viewport.clientHeight - view.y) / view.k,
});

function paintMap() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(MAP_W * dpr);
  const h = Math.round(MAP_H * dpr);
  if (mapCanvas.width !== w || mapCanvas.height !== h) {
    mapCanvas.width = w;
    mapCanvas.height = h;
  }
  mapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mapCtx.clearRect(0, 0, MAP_W, MAP_H);
  const screen = windowBounds();
  // An empty board still has a window, so the map shows where you are with nothing on it.
  const p = mapProjection(boardBounds() ?? screen);
  mapShown = p;
  for (const card of cards) {
    const colour = MAP_COLOUR[dotKind(card.dataset.kind)];
    const x = p.ox + parseFloat(card.style.left) * p.s;
    const y = p.oy + parseFloat(card.style.top) * p.s;
    const w = Math.max(2, card.offsetWidth * p.s);
    const h = Math.max(2, card.offsetHeight * p.s);
    // Filled so a small card still reads, outlined so two of them never merge into one shape.
    mapCtx.globalAlpha = 0.5;
    mapCtx.fillStyle = colour;
    mapCtx.fillRect(x, y, w, h);
    mapCtx.globalAlpha = 0.85;
    mapCtx.strokeStyle = colour;
    mapCtx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.max(0, Math.round(w) - 1), Math.max(0, Math.round(h) - 1));
  }
  mapCtx.globalAlpha = 1;
  // The card being read keeps its accent ring here too, so the map says where the reading is.
  const active = document.querySelector(".card.active");
  if (active && active.style.left) {
    mapCtx.strokeStyle = "#58a6ff";
    mapCtx.strokeRect(
      Math.round(p.ox + parseFloat(active.style.left) * p.s) - 0.5,
      Math.round(p.oy + parseFloat(active.style.top) * p.s) - 0.5,
      Math.max(2, Math.round(active.offsetWidth * p.s)) + 1,
      Math.max(2, Math.round(active.offsetHeight * p.s)) + 1,
    );
  }
  // The window, clipped to the frame: a window wider than the board covers the whole map.
  const left = Math.max(0, Math.min(MAP_W, p.ox + screen.minX * p.s));
  const top = Math.max(0, Math.min(MAP_H, p.oy + screen.minY * p.s));
  const right = Math.max(0, Math.min(MAP_W, p.ox + screen.maxX * p.s));
  const bottom = Math.max(0, Math.min(MAP_H, p.oy + screen.maxY * p.s));
  // The window is tinted from the inside rather than the board dimmed from the outside: the map has
  // no panel behind it, and a scrim over everything else would put the dark box back.
  mapCtx.fillStyle = "rgba(88,166,255,.14)";
  mapCtx.fillRect(left, top, right - left, bottom - top);
  mapCtx.strokeStyle = "#58a6ff";
  mapCtx.strokeRect(Math.round(left) + 0.5, Math.round(top) + 0.5, right - left, bottom - top);
}

/** One paint per frame at most, and none while the map is hidden. */
function scheduleMap() {
  if (!mapOn || mapQueued) return;
  mapQueued = true;
  requestAnimationFrame(() => {
    mapQueued = false;
    if (mapOn) paintMap();
  });
}

/** The board point under a point on the map, read from the picture that is on screen. */
const mapToBoard = (local) =>
  mapShown ? { x: (local.x - mapShown.ox) / mapShown.s, y: (local.y - mapShown.oy) / mapShown.s } : null;

/** Put a board point in the middle of the screen; applyView tells the map to follow. */
function centreAt(point) {
  view.x = viewport.clientWidth / 2 - point.x * view.k;
  view.y = viewport.clientHeight / 2 - point.y * view.k;
  applyView();
}

/** The card under a point on the map; the last drawn wins, so the one on top is the one hit. */
function mapCardAt(local) {
  for (let index = cards.length - 1; index >= 0; index -= 1) {
    const card = cards[index];
    const x = mapShown.ox + parseFloat(card.style.left) * mapShown.s;
    const y = mapShown.oy + parseFloat(card.style.top) * mapShown.s;
    if (
      local.x >= x &&
      local.x <= x + Math.max(2, card.offsetWidth * mapShown.s) &&
      local.y >= y &&
      local.y <= y + Math.max(2, card.offsetHeight * mapShown.s)
    ) {
      return card;
    }
  }
  return null;
}

// The map is a handle on the board: a press puts the window over that point, a drag keeps it under
// the pointer, and a press on a card goes to that card the way a rail row or a link does.
mapCanvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !mapShown) return;
  event.preventDefault();
  const box = mapCanvas.getBoundingClientRect();
  const from = { x: event.clientX - box.left, y: event.clientY - box.top };
  const hit = mapCardAt(from);
  const record = hit ? byId.get(hit.dataset.id) : null;
  if (record) centerOn(record);
  else centreAt(mapToBoard(from));
  mapCanvas.setPointerCapture(event.pointerId);
  let dragging = false;
  const move = (ev) => {
    const at = { x: ev.clientX - box.left, y: ev.clientY - box.top };
    // A press that barely moved is the click above; past that the window follows the pointer.
    if (!dragging && Math.abs(at.x - from.x) + Math.abs(at.y - from.y) < 3) return;
    dragging = true;
    centreAt(mapToBoard(at));
  };
  const up = () => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    removeEventListener("pointercancel", up);
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
  addEventListener("pointercancel", up);
});

function paintMapBtn() {
  mapBtn.setAttribute("aria-pressed", mapOn ? "true" : "false");
  mapBtn.title = mapOn ? "hide the board overview (m)" : "show the board overview (m)";
}

/**
 * The map is a session's choice: it starts on at every load, and `m` or the header button hides it
 * until the next one. Nothing is stored, so a stray keypress cannot leave the board without a map
 * that no press on the board explains.
 */
function setMap(on) {
  mapOn = on;
  document.body.classList.toggle("map-on", on);
  paintMapBtn();
  if (on) scheduleMap();
}

paintMapBtn();
document.body.classList.toggle("map-on", mapOn);
mapBtn.addEventListener("click", () => setMap(!mapOn));
// The window rect is measured against the canvas, so the map follows the box it is drawn in:
// a resized window and a rail that opens, closes or is dragged all land here.
new ResizeObserver(() => scheduleMap()).observe(viewport);

document.getElementById("fit").addEventListener("click", fitAll);
document.getElementById("tidy").addEventListener("click", tidy);
document.getElementById("stack").addEventListener("click", stack);
// The thread order is the human's furniture too: the button says what the board does now, and
// its title says what a click will do.
const orderBtn = document.getElementById("threadOrder");
function paintOrderBtn() {
  orderBtn.textContent = newestFirst ? "newest" : "oldest";
  orderBtn.setAttribute("aria-pressed", newestFirst ? "true" : "false");
  orderBtn.title = newestFirst
    ? "newest card in a thread sits on top — click to put the oldest on top"
    : "oldest card in a thread sits on top — click to put the newest on top";
}
function flipOrder() {
  newestFirst = !newestFirst;
  try {
    localStorage.setItem(ORDER_KEY, newestFirst ? "newest" : "oldest");
  } catch {}
  paintOrderBtn();
  applyAllThreadOrder();
}
paintOrderBtn();
orderBtn.addEventListener("click", flipOrder);
// Another tab flipping the order repaints this one, so the two agree without a reload.
window.addEventListener("storage", (event) => {
  if (event.key !== ORDER_KEY) return;
  newestFirst = event.newValue !== "oldest";
  paintOrderBtn();
  applyAllThreadOrder();
});
document.getElementById("newPill").addEventListener("click", jumpToFresh);
resetBtn.addEventListener("click", resetZoom);

// ---------- git strip ----------------------------------------------------
// The workspace's branches, under the minimap: the daemon reads the graph and this draws it. One
// lane per branch, refs as pills on the dot's own line, the subject under it, an amber ring where
// work is uncommitted and a breathing halo where a thread is running. It draws what arrives on the
// stream and nothing else, so it costs the board no requests of its own.
// Twenty rows are what the column is sized for, and a row is tall enough for a pill above its dot
// and a caption under it. The first dot sits low enough that its pill is on the canvas.
const GIT_LANE = 13;
const GIT_LANE_X = 12;
const GIT_TEXT_GAP = 12;
const GIT_PAD_TOP = 16;
const GIT_TARGET_ROWS = 20;
const GIT_MIN_STEP = 26;
const GIT_MAX_STEP = 40;
const GIT_FONT = '9.5px ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';
const TAU = Math.PI * 2;
// A lane keeps its colour by its index. The order is stable for a repository nobody is rebasing
// underneath the reader, which is the case that matters: a lane whose colour flickers is a lane
// the eye has to find again.
const GIT_COLOURS = ["#58a6ff", "#db61a2", "#3fb950", "#d29922", "#d2a8ff", "#39c5cf", "#f85149", "#e3b341"];
const GIT_PILL = {
  head: ["#1f6feb", "#e6edf3"],
  branch: ["#6e2f5b", "#f0d4e6"],
  remote: ["#30363d", "#c9d1d9"],
  tag: ["#4a3a12", "#e3b341"],
};
const gitStrip = document.getElementById("gitstrip");
const gitCanvas = document.getElementById("gitgraph");
const gitCtx = gitCanvas.getContext("2d");
let gitShown = null;
let gitLayout = null;
let gitStamp = "";
let gitPulse = 0;
let gitFrame = 0;

/**
 * Lanes for the rows the graph came in: which column each commit sits in, and which lanes carry a
 * parent through the row, so a line can be drawn where the history is, not where the labels are.
 */
function layoutGraph(commits) {
  const lanes = [];
  const rows = [];
  let width = 1;
  for (const commit of commits) {
    let lane = lanes.indexOf(commit.hash);
    if (lane === -1) {
      lane = lanes.indexOf(null);
      if (lane === -1) {
        lanes.push(null);
        lane = lanes.length - 1;
      }
      lanes[lane] = commit.hash;
    }
    const before = lanes.slice();
    // Two lanes naming the same commit are one history: the other lane has merged into this one.
    for (let index = 0; index < lanes.length; index += 1) {
      if (index !== lane && lanes[index] === commit.hash) lanes[index] = null;
    }
    lanes[lane] = commit.parents[0] ?? null;
    const moves = [];
    // A merge commit opens a lane for each parent after the first, and takes the nearest free one:
    // a bend of one column reads as a fork, a bend of five reads as a line across the graph.
    for (const parent of commit.parents.slice(1)) {
      const free = lanes.map((held, column) => (held === null ? column : -1)).filter((column) => column !== -1);
      let into = free.length
        ? free.reduce((best, column) => (Math.abs(column - lane) < Math.abs(best - lane) ? column : best), free[0])
        : -1;
      if (into === -1) {
        lanes.push(parent);
        into = lanes.length - 1;
      } else lanes[into] = parent;
      if (!moves.includes(into)) moves.push(into);
    }
    // The ref that matters is the one the checkout is on: head, then local, then remote, then tag.
    const rank = { head: 0, branch: 1, remote: 2, tag: 3 };
    commit.refs.sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9));
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    width = Math.max(width, before.length, lanes.length);
    rows.push({ commit, lane, before, after: lanes.slice(), moves });
  }
  return { rows, width };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** The most of `text` that fits `max` pixels, ending in an ellipsis when it had to be cut. */
function fitted(text, max) {
  if (max <= 8 || !text) return "";
  if (gitCtx.measureText(text).width <= max) return text;
  let cut = text;
  while (cut.length > 1 && gitCtx.measureText(`${cut}\u2026`).width > max) cut = cut.slice(0, -1);
  return cut.length > 1 ? `${cut}\u2026` : "";
}

/**
 * A ref name as a pill can carry it. The end of a name is what tells two branches apart — a thread's
 * branch ends with its own id — so a long one keeps its type, an ellipsis and its tail.
 */
function shortRef(name) {
  if (name.length <= 18) return name;
  const [head, ...rest] = name.split("/");
  const tail = rest.join("/");
  const id = /([0-9a-f]{8})$/.exec(tail);
  if (id && head.length + id[1].length + 2 <= 18) return `${head}/\u2026${id[1]}`;
  return `\u2026${name.slice(-17)}`;
}

/** One ref as a pill on the commit's own line; `y` is where the row's dot sits. */
function drawPill(label, x, y, maxWidth, kind) {
  const [bg, fg] = GIT_PILL[kind] ?? GIT_PILL.branch;
  const text = fitted(shortRef(label), maxWidth - 9);
  if (!text) return x;
  const w = Math.min(maxWidth, gitCtx.measureText(text).width + 9);
  gitCtx.fillStyle = bg;
  gitCtx.beginPath();
  roundRect(gitCtx, x, y - 13, w, 13, 3);
  gitCtx.fill();
  gitCtx.fillStyle = fg;
  gitCtx.fillText(text, x + 4.5, y - 3);
  return x + w + 3;
}

/**
 * One segment of the history: straight when the two lanes line up, and a right angle with a 3px
 * corner when they do not. It runs from one commit's dot to the next commit's dot, so it is drawn
 * once and both of its ends are dots that exist.
 */
function link(x0, y0, x1, y1) {
  gitCtx.beginPath();
  gitCtx.moveTo(x0, y0);
  if (x0 !== x1) {
    const mid = (y0 + y1) / 2;
    const radius = Math.min(3, Math.abs(x1 - x0) / 2, (y1 - y0) / 3);
    const dir = Math.sign(x1 - x0);
    gitCtx.lineTo(x0, mid - radius);
    gitCtx.quadraticCurveTo(x0, mid, x0 + dir * radius, mid);
    gitCtx.lineTo(x1 - dir * radius, mid);
    gitCtx.quadraticCurveTo(x1, mid, x1, mid + radius);
  }
  gitCtx.lineTo(x1, y1);
  gitCtx.stroke();
}

function paintGit() {
  const width = gitStrip.clientWidth;
  const height = gitStrip.clientHeight;
  if (!width || !height) return;
  const dpr = window.devicePixelRatio || 1;
  if (gitCanvas.width !== Math.round(width * dpr) || gitCanvas.height !== Math.round(height * dpr)) {
    gitCanvas.width = Math.round(width * dpr);
    gitCanvas.height = Math.round(height * dpr);
  }
  gitCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  gitCtx.clearRect(0, 0, width, height);
  if (!gitShown || !gitLayout) return;
  // The row grows with the window, so the column shows about twenty commits at any height rather
  // than a fixed spacing that leaves a band empty or clips a handful.
  const step = Math.max(GIT_MIN_STEP, Math.min(GIT_MAX_STEP, Math.floor((height - GIT_PAD_TOP) / GIT_TARGET_ROWS)));
  const rows = gitLayout.rows;
  const shown = Math.min(rows.length, Math.max(1, Math.floor((height - GIT_PAD_TOP) / step)));
  if (shown <= 0) return;
  // Lanes crowd the left edge as branches pile up, so the spacing gives way before the text does.
  const lanes = Math.max(1, gitLayout.width);
  const laneStep = Math.min(GIT_LANE, Math.max(7, Math.floor((70 - GIT_LANE_X) / Math.max(1, lanes - 1))));
  const laneX = (index) => GIT_LANE_X + index * laneStep;
  const textX = laneX(lanes - 1) + GIT_TEXT_GAP;
  const colour = (index) => GIT_COLOURS[index % GIT_COLOURS.length];

  // How much uncommitted work stands on a commit, and how many threads are working there. Two
  // trees on one base are two indicators, so both are counted instead of one of them winning.
  const dirty = new Map();
  const live = new Map();
  const addDirty = (head, count) => {
    if (head && count) dirty.set(head, (dirty.get(head) ?? 0) + count);
  };
  addDirty(gitShown.root?.head, gitShown.root?.dirty);
  for (const tree of gitShown.trees ?? []) {
    addDirty(tree.head, tree.dirty);
    if (tree.live && tree.head) live.set(tree.head, (live.get(tree.head) ?? 0) + 1);
  }

  gitCtx.font = GIT_FONT;
  gitCtx.textBaseline = "alphabetic";
  gitCtx.lineWidth = 2.2;

  for (let index = 0; index < shown; index += 1) {
    const row = rows[index];
    const next = index + 1 < shown ? rows[index + 1] : null;
    const y = GIT_PAD_TOP + index * step;
    const nodeX = laneX(row.lane);
    const commit = row.commit;

    // One segment per lane the commit leaves behind, from this dot to where that lane stands on the
    // next row: a lane born here starts at the dot, and one the next commit ends stops at that
    // commit's dot. Both ends come from the layout, so no line can fall short of a dot it belongs to.
    // Every segment is drawn at the same strength, because a lane that fades where it passes a commit
    // reads as two different lanes.
    for (let column = 0; column < row.after.length; column += 1) {
      const hash = row.after[column];
      if (!hash) continue;
      const born = column === row.lane || row.moves.includes(column);
      const ends = Boolean(next) && next.commit.hash === hash;
      gitCtx.strokeStyle = colour(column);
      link(born ? nodeX : laneX(column), y, ends ? laneX(next.lane) : laneX(column), y + step);
    }

    const merge = commit.parents.length > 1;
    const radius = merge ? 6.4 : 5.2;
    // A thread working here breathes, and two threads on one commit breathe as two rings.
    const running = live.get(commit.hash) ?? 0;
    gitCtx.fillStyle = colour(row.lane);
    for (let at = 0; at < running; at += 1) {
      gitCtx.globalAlpha = 0.12 + 0.26 * gitPulse;
      gitCtx.beginPath();
      gitCtx.arc(nodeX, y, radius + 3 + at * 3.4 + 3.5 * gitPulse, 0, TAU);
      gitCtx.fill();
    }
    // A filled dot: hollow read as a gap in the line on a board already covered in dots.
    gitCtx.globalAlpha = 1;
    gitCtx.beginPath();
    gitCtx.arc(nodeX, y, radius, 0, TAU);
    gitCtx.fill();
    // The amber ring says work is uncommitted here; the number on the right says how much.
    const uncommitted = dirty.get(commit.hash) ?? 0;
    if (uncommitted) {
      gitCtx.globalAlpha = 0.9;
      gitCtx.strokeStyle = "#d29922";
      gitCtx.beginPath();
      gitCtx.arc(nodeX, y, radius + 3, 0, TAU);
      gitCtx.stroke();
      gitCtx.globalAlpha = 1;
    }

    // The refs on the commit's own line, above; its subject is the caption under the dot.
    let cursor = textX;
    for (const ref of commit.refs.slice(0, 2)) {
      const room = width - 24 - cursor;
      if (room < 26) break;
      cursor = drawPill(ref.name, cursor, y, room, ref.kind);
    }
    const subject = fitted(commit.subject, width - 6 - textX);
    if (subject) {
      gitCtx.fillStyle = "#8b949e";
      gitCtx.fillText(subject, textX, y + 11);
    }
    // Right aligned, so a long pill never pushes the count off the edge of the strip.
    if (uncommitted) {
      gitCtx.textAlign = "right";
      gitCtx.fillStyle = "#d29922";
      gitCtx.fillText(String(uncommitted), width - 4, y - 3);
      gitCtx.textAlign = "left";
    }
  }
}

/** The pulse the halo breathes with, running only while some thread is working in a tree. */
function startPulse() {
  if (gitFrame) return;
  if (!gitShown || !(gitShown.trees ?? []).some((tree) => tree.live) || document.hidden) return;
  const step = () => {
    gitFrame = 0;
    if (!gitShown || !(gitShown.trees ?? []).some((tree) => tree.live) || document.hidden) return;
    gitPulse = (Math.sin(performance.now() / 420) + 1) / 2;
    paintGit();
    gitFrame = requestAnimationFrame(step);
  };
  gitFrame = requestAnimationFrame(step);
}

/** What a screen reader is told about the strip, in the words the picture says it in. */
function gitLabel(picture) {
  const root = picture.root ?? {};
  const branches = 1 + (picture.trees?.length ?? 0);
  const working = (picture.trees ?? []).filter((tree) => tree.live).length;
  return [
    `${picture.graph.length} commits on ${branches} branch${branches === 1 ? "" : "es"}`,
    `${root.branch || "detached"} ${root.dirty ? `${root.dirty} uncommitted` : "clean"}`,
    working ? `${working} thread${working === 1 ? "" : "s"} working` : "nothing running",
  ].join(", ");
}

/** A new picture from the daemon: repaint only when it says something the last one did not. */
function applyGit(picture) {
  // The moment it was read is not news; only what it says is.
  const stamp = picture ? JSON.stringify({ ...picture, at: 0 }) : "";
  if (stamp === gitStamp) return;
  gitStamp = stamp;
  gitShown = picture && picture.graph?.length ? picture : null;
  gitLayout = gitShown ? layoutGraph(gitShown.graph) : null;
  document.body.classList.toggle("git-on", Boolean(gitShown));
  if (!gitShown) return;
  gitCanvas.setAttribute("aria-label", gitLabel(gitShown));
  paintGit();
  startPulse();
}

// The strip's box is the drawn size, so a resized window, a rail that opens and the map's own
// toggle all repaint it rather than leave the last picture sitting in the wrong place.
new ResizeObserver(() => paintGit()).observe(gitStrip);
document.addEventListener("visibilitychange", startPulse);

// ---------- activity rail ------------------------------------------------
const stopBtn = document.getElementById("stop");
const railNow = document.getElementById("railNow");
const railLog = document.getElementById("railLog");
const railRunning = document.getElementById("railRunning");
const railOpenCount = document.getElementById("railOpenCount");
const actEls = new Map();
/** A thought with no patch for this long is stalled, and its row says so with the clock. */
const THOUGHT_STALL_MS = 3000;

// The rail is the user's furniture: its width and whether it is showing survive a reload.
const RAIL_MIN = 160;
const RAIL_MAX = 720;
const root = document.documentElement;

function railWidth(px) {
  const width = Math.max(RAIL_MIN, Math.min(RAIL_MAX, Math.round(px)));
  root.style.setProperty("--rail", `${width}px`);
  try {
    localStorage.setItem("board.railWidth", String(width));
  } catch {}
  return width;
}

function railShown(shown) {
  document.body.classList.toggle("rail-off", !shown);
  try {
    localStorage.setItem("board.railOff", shown ? "0" : "1");
  } catch {}
}

function restoreRail() {
  let saved = 0;
  let off = "0";
  try {
    saved = Number(localStorage.getItem("board.railWidth")) || 0;
    off = localStorage.getItem("board.railOff") || "0";
  } catch {}
  if (saved) railWidth(saved);
  if (off === "1") railShown(false);
}
restoreRail();
document.getElementById("railToggle").onclick = () => railShown(false);

// ---------- the conversation behind a thread ------------------------------
//
// The rail summarises a thread in rows and the card shows one answer; this is the whole of it, from
// the session file pi writes. It reads while it is open and costs nothing while it is closed.
const trPanel = document.getElementById("transcript");
const trBody = document.getElementById("trBody");
const trTitleEl = trPanel.querySelector(".tr-title");
const trNoteEl = trPanel.querySelector(".tr-note");
const trFollowBtn = document.getElementById("trFollow");
const TR_MARKS = { user: "›", answer: "●", thinking: "▸", call: "▸", result: "·" };
let trThread = "";
let trFollow = true;
let trTimer = 0;
let trDrawn = "";

function trEntryNode(entry) {
  const node = el("div", `tr-entry ${entry.kind}`);
  node.dataset.mark = TR_MARKS[entry.kind] ?? "";
  node.textContent = entry.kind === "thinking" ? `thinking: ${entry.text}` : entry.text;
  return node;
}

async function trLoad() {
  if (!trThread) return;
  let data;
  try {
    const res = await fetch(`/transcript/${encodeURIComponent(trThread)}?${auth}`);
    if (!res.ok) {
      trNoteEl.textContent = res.status === 404 ? "no session file yet" : `error ${res.status}`;
      return;
    }
    data = await res.json();
  } catch {
    trNoteEl.textContent = "the daemon did not answer";
    return;
  }
  trTitleEl.textContent = data.title || data.threadId.slice(0, 8);
  trNoteEl.textContent = [data.status, data.branch || (data.base ? `detached on ${data.base}` : "")]
    .filter(Boolean)
    .join(" · ");
  // A repaint keeps the reader's place unless they were at the bottom, and an unchanged transcript is
  // not painted at all: the poll runs every few seconds for as long as the drawer is open.
  const drawn = JSON.stringify(data.entries.map((entry) => [entry.kind, entry.text]));
  if (drawn === trDrawn) return;
  trDrawn = drawn;
  const atBottom = trBody.scrollHeight - trBody.scrollTop - trBody.clientHeight < 60;
  trBody.replaceChildren(...data.entries.map(trEntryNode));
  if (trFollow && atBottom) trBody.scrollTop = trBody.scrollHeight;
}

function trOpen(threadId) {
  trThread = threadId;
  trDrawn = "";
  trPanel.hidden = false;
  trTitleEl.textContent = "";
  trNoteEl.textContent = "reading…";
  trBody.replaceChildren();
  void trLoad();
  clearInterval(trTimer);
  trTimer = setInterval(() => {
    if (trFollow) void trLoad();
  }, 2500);
}

function trClose() {
  trThread = "";
  trDrawn = "";
  trPanel.hidden = true;
  clearInterval(trTimer);
  trTimer = 0;
  trBody.replaceChildren();
}

document.getElementById("trClose").addEventListener("click", trClose);
trFollowBtn.addEventListener("click", () => {
  trFollow = !trFollow;
  trFollowBtn.classList.toggle("on", trFollow);
  if (trFollow) void trLoad();
});
// Right click a thread in the rail to read it. The section is the thread, so the press lands on a row
// or on the head and names the same conversation either way.
railLog.addEventListener("contextmenu", (event) => {
  const section = event.target.closest(".rail-thread");
  const threadId = section?.dataset.thread;
  if (!threadId) return;
  event.preventDefault();
  trOpen(threadId);
});

document.getElementById("railOpen").onclick = () => railShown(true);

(() => {
  const grip = document.getElementById("railGrip");
  let dragging = false;
  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    dragging = true;
    grip.setPointerCapture(event.pointerId);
    document.body.classList.add("rail-resizing");
    event.preventDefault();
  });
  grip.addEventListener("pointermove", (event) => {
    if (dragging) railWidth(event.clientX);
  });
  const stop = (event) => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("rail-resizing");
    if (grip.hasPointerCapture?.(event.pointerId)) grip.releasePointerCapture(event.pointerId);
  };
  grip.addEventListener("pointerup", stop);
  grip.addEventListener("pointercancel", stop);
})();

// The rail is the overview of the board: every card, newest first, with the one state worth
// knowing. A row is the way back to its card.
const railCards = document.getElementById("railCards");
const railCardCount = document.getElementById("railCardCount");
const railRows = new Map();
/** Arrival order of the rows, so a list that nests can still put the newest thread on top. */
let cardSeq = 0;

/** An age short enough to share a row with a title. */
function agoText(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/** The one state word a row has room for, in the words the card itself already uses. */
function railState(entry) {
  const data = entry.data || {};
  // "updated" rides on the arrival badge's own .fresh class, so there is one notion of new.
  const updated = entry.card.classList.contains("fresh");
  const wants = questionWants(data);
  if (data.type === "question" && data.status === "expired") return { text: "expired", wants: false, updated };
  if (wants) return { text: "answer needed", wants, updated };
  if (updated) return { text: "updated", wants, updated };
  if (data.type === "sticky") return { text: data.status || "queued", wants, updated };
  // A changed card is as old as its change, so the row does not keep counting from arrival.
  return { text: agoText(Date.now() - (entry.updatedAt || data.at || Date.now())), wants, updated };
}

function paintRailCount() {
  railCardCount.textContent = railRows.size ? String(railRows.size) : "";
  syncTicker();
}

/** Just the state word and its tone, so the clock and a repaint share one writer. */
function paintRailState(entry) {
  const row = railRows.get(entry.id);
  if (!row) return;
  const { text, wants, updated } = railState(entry);
  // The clock calls this every second, so a word that has not changed must not touch the DOM.
  if (row.children[2].textContent !== text) {
    row.children[2].textContent = text;
    row.classList.toggle("wants", wants);
    row.classList.toggle("updated", updated);
    row.title = `${row.children[1].textContent} · ${text}`;
  }
}

/**
 * Where a card follows from: the thread that spawned it, or the card its own note was written for.
 * Both are kept, in that order, because a spawned thread whose card the board does not draw leaves
 * only the card it was written on to hang from.
 */
const railParentsOf = (entry) => {
  const data = entry.data || {};
  return [data.parentThread || "", data.threadRoot || ""].filter((id) => id && id !== entry.id);
};

/**
 * One row per card, built once and patched in place: this runs on every card repaint, so it
 * must not rebuild the list or touch any other card's DOM. A new card is prepended where it
 * arrived, and only a card whose parent changed asks the list to be put in order again.
 */
function syncRailCard(entry) {
  if (!entry) return;
  let row = railRows.get(entry.id);
  const parents = railParentsOf(entry).join(" ");
  if (!row) {
    row = el("button", "rail-card");
    row.type = "button";
    row.dataset.id = entry.id;
    row.dataset.seq = String(++cardSeq);
    row.append(el("span", "dot"), el("span", "rail-title"), el("span", "rail-state"));
    row.addEventListener("click", () => {
      const record = byId.get(row.dataset.id);
      if (record) centerOn(record);
    });
    railRows.set(entry.id, row);
    railCards.prepend(row);
  }
  row.children[0].className = `dot ${dotKind(entry.data.type)}`;
  row.children[1].textContent = entry.titleEl.textContent;
  paintRailState(entry);
  paintRailCount();
  // A newborn row may be the child of one that is already here, and a card can be told where it
  // follows from after it landed, so the order is recomputed for both. It costs nothing while the
  // list already reads right: every row is where it is wanted, so no node moves.
  if (row.dataset.parent !== parents) orderRailCards();
}

function dropRailCard(id) {
  const row = railRows.get(id);
  if (!row) return;
  row.remove();
  railRows.delete(id);
  paintRailCount();
  // The rows that were indented under this one are top rows again, not children of nothing.
  orderRailCards();
}

/**
 * Where the card rows sit: the newest arrival on top, and a card directly under the card it follows
 * from, one indent per level. A row whose parent is not on the rail is a top row of its own, so
 * closing a parent hands its children back instead of hiding them under a head that is gone.
 */
function orderRailCards() {
  const ranked = [...railRows.values()].sort((a, b) => Number(b.dataset.seq || 0) - Number(a.dataset.seq || 0));
  // Every row says where it follows from, so one pass both learns the shape of the list and places
  // what it found there.
  for (const [id, row] of railRows) {
    const entry = byId.get(id);
    row.dataset.parent = entry ? railParentsOf(entry).join(" ") : "";
  }
  // The first of a row's parents that the rail still holds, so closing a parent hands its children
  // back to the next one it names, or makes them top rows of their own.
  const parentOf = (row) =>
    (row.dataset.parent || "").split(" ").find((id) => id && id !== row.dataset.id && railRows.has(id)) || "";
  const wanted = [];
  const placed = new Set();
  const place = (row, depth) => {
    if (placed.has(row)) return;
    placed.add(row);
    row.classList.toggle("child", depth > 0);
    row.style.setProperty("--rail-depth", String(depth));
    wanted.push(row);
    for (const kid of ranked) if (parentOf(kid) === row.dataset.id) place(kid, depth + 1);
  };
  for (const row of ranked) if (!parentOf(row)) place(row, 0);
  // A chain that loops has no top to hang from, so those rows keep the places they already have and
  // the pass moves on: the guard against a card that somehow follows from itself.
  let cursor = railCards.firstElementChild;
  for (const row of wanted) {
    if (row === cursor) {
      cursor = cursor.nextElementSibling;
      continue;
    }
    railCards.insertBefore(row, cursor);
  }
}

function clearRailCards() {
  railCards.replaceChildren();
  railRows.clear();
  cardSeq = 0;
  paintRailCount();
}

// A card the human closed while it still held a conversation is not gone: the board keeps it, and
// the rail offers it back. The list is the board's, not this tab's, so a second tab sees the same
// closed cards and the one that puts a card back takes the row from both.
const railClosed = document.getElementById("railClosed");
const railClosedHead = document.getElementById("railClosedHead");
const railClosedCount = document.getElementById("railClosedCount");

/** Redrawn whole: the list is short, and the server only says it when it changes. */
function applyClosed(rows) {
  railClosed.replaceChildren();
  for (const row of Array.isArray(rows) ? rows : []) {
    const button = el("button", "rail-card");
    button.type = "button";
    button.dataset.id = row.id;
    const name = row.title || "thread";
    const turns = Number(row.turns) || 0;
    const dot = el("span", "dot");
    dot.className = `dot ${dotKind("sticky")}`;
    const title = el("span", "rail-title");
    title.textContent = name;
    const state = el("span", "rail-state");
    // The row's one action is the reason it is here, so the action is what the row says.
    state.textContent = "reopen";
    button.append(dot, title, state);
    button.title = `${name} · closed ${agoText(Date.now() - (Number(row.closedAt) || Date.now()))} ago · ${turns} turn${turns === 1 ? "" : "s"} · click to put it back`;
    button.setAttribute("aria-label", `reopen the card ${name}`);
    button.addEventListener("click", () => reopenCard(row, name));
    railClosed.appendChild(button);
  }
  railClosedHead.hidden = railClosed.childElementCount === 0;
  railClosedCount.textContent = railClosed.childElementCount ? String(railClosed.childElementCount) : "";
}

/**
 * `ctrl+z` puts back the card that was closed last. The × and `q` both take a card off the board, and a
 * note closed by accident is otherwise only in the rail when it held a conversation. The daemon keeps
 * what a close removed, so the card returns with its id, its place and its key intact.
 */
function undoClose() {
  void fetch(`/undo?${auth}`, { method: "POST" })
    .then(async (response) => {
      if (response.ok) return;
      const said = (await response.text()).trim();
      hintLine(said === "nothing to undo" ? "nothing to undo" : `could not undo: ${said}`, true);
    })
    .catch(() => hintLine("could not reach the board server", true));
}

/**
 * Put a closed card back. The card comes with the turns it had and lands where it was, so this is one
 * request: the row goes when the board says the list has changed, not when the click lands.
 */
function reopenCard(row, name) {
  void fetch(`/reopen?${auth}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cardId: row.id }),
  })
    .then(async (response) => {
      if (response.ok) return;
      const said = (await response.text()).trim();
      hintLine(said === "no such card" ? `${name} is no longer on the board` : `could not reopen ${name}`, true);
    })
    .catch(() => hintLine("could not reach the board server", true));
}

/**
 * What a running call is working on, for the lines under its name: the command it is shelling, the file
 * it is reading. The summary a settled row shows does not exist yet, so the arguments are what there is
 * to read while the call is in flight.
 */
function liveDetail(row) {
  const args = row.args ?? {};
  const said = [args.command, args.path ?? args.file_path, args.url, args.pattern, args.selector, args.query].find(
    (value) => typeof value === "string" && value.trim(),
  );
  return String(said ?? row.summary ?? row.target ?? "").trim();
}

function actRow(row, inCard = false) {
  const thinking = row.kind === "thinking";
  const node = el("div", `act ${row.kind === "reply" ? "reply" : ""} ${thinking ? "thinking" : ""} ${row.status}`);
  // The row carries its kind and status so a patch can update it in place and the one clock can
  // leave a thinking row's rate alone.
  node.dataset.kind = String(row.kind ?? "");
  node.dataset.status = String(row.status ?? "");
  // The thread a row belongs to rides on the node, so a row that arrives before its card can be put
  // where it belongs once the board finds that card.
  node.dataset.thread = String(row.thread?.id ?? "");
  const top = el("div", "top");
  top.appendChild(el("span", "dot"));
  const name = el("span", "name");
  // A row that is still running says which tool it is in one word and gives the lines below to what
  // that tool is working on: the command, the file, the page. A long command in the signpost left the
  // row with nothing to grow into, and a command cut in one line is not readable anyway.
  name.textContent = row.status === "running" && row.tool
    ? row.tool
    : row.kind === "reply"
      ? "answer"
      : thinking
        ? "thinking"
        : row.label || row.tool || "tool";
  if (row.tool) name.title = row.label || row.tool;
  top.appendChild(name);
  // A running row waits in the rail strip when its thread's card is not here, and no section names
  // the thread that is working, so the row says it itself. In the card the thread is the card, and a
  // settled row is filed under its thread: neither needs the label.
  if (row.status === "running" && !inCard && row.thread?.title) {
    const who = el("span", "who");
    who.textContent = row.thread.title;
    who.title = `thread: ${row.thread.title}`;
    top.appendChild(who);
  }
  const timing = el("span", "ms");
  top.appendChild(timing);
  // A running row is re-rendered by the ticker in place, so it carries its own start time.
  node.dataset.startedAt = String(row.startedAt ?? "");
  node.appendChild(top);
  // Opening is the only thing a row does besides being read, so it is a button for the keyboard
  // too. A drag that selected text was a read, not a click, and must not open the panel. A row
  // with no payload behind it cannot open anything, so it stays plain text.
  if (!row.plain) {
    node.tabIndex = 0;
    node.setAttribute("role", "button");
    node.setAttribute("aria-label", `open details: ${name.textContent}`);
    node.addEventListener("click", () => {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      openActPanel(row);
    });
    node.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openActPanel(row);
    });
  }
  if (thinking) {
    node.appendChild(el("div", "tail"));
    paintThought(node, row);
    return node;
  }
  timing.textContent = row.durationMs
    ? `${(row.durationMs / 1000).toFixed(row.durationMs < 1000 ? 2 : 1)}s`
    : row.status === "running"
      ? Number.isFinite(row.startedAt)
        ? rowClock(Date.now() - row.startedAt)
        : "…"
      : "";
  const detail = row.kind === "reply" ? row.text || "" : row.status === "running" ? liveDetail(row) : row.summary || row.target || "";
  // A running row keeps its two detail lines whether or not it has something to put there, so the box
  // is the same size from one step of a run to the next and nothing below it moves.
  if (detail || row.status === "running") {
    const note = el("div", row.kind === "reply" ? "note" : "target");
    note.textContent = detail;
    if (detail) note.title = detail;
    node.appendChild(note);
  }
  return node;
}

// ---------- row detail panel ---------------------------------------------
// A rail row is one line. This sheet holds everything the row leaves out, fetched when the row
// is opened and refreshed while it still runs, so the rail itself stays cheap on the wire.
const actPanel = document.getElementById("actDetail");
const actPanelName = document.getElementById("actDetailName");
const actPanelMeta = document.getElementById("actDetailMeta");
const actPanelBody = document.getElementById("actDetailBody");
const actPanelClose = document.getElementById("actDetailClose");
/** The row the panel belongs to, or null while it is closed. */
let actPanelId = null;
/** When the last fetch was sent, so a streaming row cannot ask faster than four times a second. */
let actPanelAskedAt = 0;
let actPanelTimer = 0;

const PANEL_CUT_NOTICE = "cut at 64 K characters by the board server";

/** One titled block of monospace text, saying when the server cut it. */
function panelSection(title, text, cut) {
  const box = el("section");
  box.appendChild(el("h4")).textContent = title;
  const pre = el("pre");
  pre.textContent = text;
  box.appendChild(pre);
  if (cut) box.appendChild(el("div", "cut")).textContent = PANEL_CUT_NOTICE;
  return box;
}

/** A titled block holding whatever a renderer built, so a diff, a picture or a note lands in the sheet. */
function panelBlock(title, node, cut) {
  if (!node) return null;
  const box = el("section");
  box.appendChild(el("h4")).textContent = title;
  box.appendChild(node);
  if (cut) box.appendChild(el("div", "cut")).textContent = PANEL_CUT_NOTICE;
  return box;
}

/** Argument rows: the name of the thing, then what it was. */
function panelFields(pairs) {
  const box = el("div", "act-kv");
  for (const [label, value] of pairs) {
    if (value === undefined || value === null || value === "") continue;
    const row = el("div", "act-row");
    row.append(el("span", "k"), el("span", "v"));
    row.children[0].textContent = label;
    row.children[1].textContent = String(value);
    box.appendChild(row);
  }
  return box.children.length ? box : null;
}

/** Lines with a gutter, numbered from `first` so a slice of a file starts where the file does. */
function panelCode(text, first = 1) {
  const box = el("div", "act-code");
  String(text)
    .replace(/\n$/, "")
    .split("\n")
    .forEach((line, index) => {
      const row = el("div", "act-line");
      row.append(el("span", "n"), el("span", "t"));
      row.children[0].textContent = String(first + index);
      row.children[1].innerHTML = highlight(line);
      box.appendChild(row);
    });
  return box;
}

/** A unified diff: the sign in the gutter, the line tinted by what it does. */
function panelDiff(text) {
  const box = el("div", "act-code act-diff");
  String(text)
    .replace(/\n$/, "")
    .split("\n")
    .forEach((line) => {
      const sign = line.startsWith("+") || line.startsWith("-") ? line[0] : "";
      const tone = sign === "+" ? "add" : sign === "-" ? "del" : line.startsWith("@@") ? "hunk" : "";
      const row = el("div", `act-line ${tone}`);
      row.append(el("span", "n"), el("span", "t"));
      row.children[0].textContent = sign;
      row.children[1].innerHTML = highlight(sign ? line.slice(1) : line);
      box.appendChild(row);
    });
  return box;
}

/** An edit that came back without a diff still shows what it replaced and what it put there. */
function diffFromEdits(edits) {
  if (!Array.isArray(edits)) return "";
  const lines = [];
  edits.forEach((edit, index) => {
    const before = String(edit?.oldText ?? "").replace(/\n$/, "");
    const after = String(edit?.newText ?? "").replace(/\n$/, "");
    if (!before && !after) return;
    lines.push(`@@ block ${index + 1} @@`);
    if (before) lines.push(...before.split("\n").map((line) => `-${line}`));
    if (after) lines.push(...after.split("\n").map((line) => `+${line}`));
  });
  return lines.join("\n");
}

/** The picture a call took, or the reason there is none left to draw. */
function panelPicture(payload) {
  const images = Array.isArray(payload.images) ? payload.images : [];
  if (!images.length) return null;
  const image = images[images.length - 1];
  if (!image?.data) {
    const gone = el("div", "gone");
    gone.textContent = "the picture from this run is not kept after a restart";
    return panelBlock("image", gone);
  }
  const img = el("img", "act-img");
  img.src = `data:${image.mime || "image/png"};base64,${image.data}`;
  img.alt = "what the browser saw";
  return panelBlock("image", img);
}

/** One browser action on a line: what it did, and to what. */
function stepLine(step) {
  const at = step?.selector || step?.url || (step?.x !== undefined ? `${step.x},${step.y}` : "");
  const more = step?.text ?? (step?.ms !== undefined ? `${step.ms} ms` : "");
  return [String(step?.action ?? ""), at, more].filter(Boolean).join(" ");
}

/** The words a tool said, once the daemon has parsed them out of its result. */
const actOutput = (payload) => (typeof payload.output === "string" ? payload.output : "");

/** A unified diff is worth colouring wherever a tool produced one. */
const looksLikeDiff = (text) => /^(diff --git |--- a\/|@@ )/m.test(String(text || ""));

/**
 * What the sheet draws for one call. Each tool says how its input reads and how its output reads, so
 * a shell command is a command and a file is text with line numbers, rather than a JSON dump of a
 * result object with every newline escaped into it.
 */
const ACT_VIEWS = {
  bash(payload, args, cut, add) {
    if (typeof args.command === "string") add(panelSection("command", `$ ${args.command}`, cut.has("args")));
    const said = actOutput(payload);
    if (!said) return;
    add(
      looksLikeDiff(said)
        ? panelBlock("diff", panelDiff(said), cut.has("output"))
        : panelBlock("output", panelCode(said), cut.has("output")),
    );
  },
  edit(payload, args, cut, add) {
    add(panelFields([["path", args.path ?? args.file_path]]));
    // pi hands the change over as a diff already; the arguments are the fallback for a run without one.
    const diff = typeof payload.diff === "string" && payload.diff ? payload.diff : diffFromEdits(args.edits);
    if (diff) add(panelBlock("diff", panelDiff(diff), cut.has("diff") || cut.has("args")));
    const said = actOutput(payload);
    if (said) add(panelSection("result", said, cut.has("output")));
  },
  write(payload, args, cut, add) {
    add(panelFields([["path", args.path ?? args.file_path]]));
    if (typeof args.content === "string" && args.content) add(panelBlock("content", panelCode(args.content), cut.has("args")));
    const said = actOutput(payload);
    if (said) add(panelSection("result", said, cut.has("output")));
  },
  read(payload, args, cut, add) {
    const offset = Number(args.offset);
    const limit = Number(args.limit);
    const range = Number.isFinite(offset) ? `${offset}${Number.isFinite(limit) ? `–${offset + limit - 1}` : "+"}` : "";
    add(panelFields([["path", args.path ?? args.file_path], ["lines", range]]));
    add(panelPicture(payload));
    const said = actOutput(payload);
    if (said) add(panelBlock("output", panelCode(said, Number.isFinite(offset) ? offset : 1), cut.has("output")));
  },
  board_source(payload, args, cut, add) {
    add(
      panelFields([
        ["path", args.path],
        ["line", Number.isFinite(Number(args.line)) ? args.line : ""],
        ["title", args.title],
        ["key", args.key],
      ]),
    );
    const said = actOutput(payload);
    if (said) add(panelSection("result", said, cut.has("output")));
  },
  board_note(payload, args, cut, add) {
    add(panelFields([["title", args.title], ["key", args.key]]));
    // The note is markdown that the board draws anyway, so the sheet draws the card the call wrote.
    if (typeof args.markdown === "string" && args.markdown) {
      const note = el("div", "act-note");
      note.appendChild(renderMarkdown(args.markdown));
      add(panelBlock("note", note, cut.has("args")));
    }
    const said = actOutput(payload);
    if (said) add(panelSection("result", said, cut.has("output")));
  },
  board_ask(payload, args, cut, add) {
    // A card may ask one question or several: the sheet reads the arguments, so it draws whichever
    // arrived as the tabs the card will draw.
    const asked = Array.isArray(args.questions) && args.questions.length ? args.questions : null;
    if (asked) {
      const list = el("ol", "act-options");
      for (const one of asked) {
        const row = el("li");
        row.textContent = `${one?.question ?? ""}${one?.multiple === true ? " (any of them)" : ""}`;
        list.appendChild(row);
      }
      add(panelBlock("questions", list, cut.has("args")));
    } else {
      if (typeof args.question === "string") add(panelSection("question", args.question, cut.has("args")));
      const options = Array.isArray(args.options) ? args.options : [];
      if (options.length) {
        const list = el("ol", "act-options");
        for (const option of options) list.appendChild(el("li")).textContent = String(option);
        add(panelBlock("options", list));
      }
    }
    add(
      panelFields([
        ["title", args.title],
        ["tabs", asked ? String(asked.length) : ""],
        ["picks", args.multiple === true ? "any of them" : "one of them"],
        ["free text", args.allowFreeText === false ? "no" : "yes"],
      ]),
    );
    const said = actOutput(payload);
    if (said) add(panelSection("result", said, cut.has("output")));
  },
  browser_screenshot(payload, args, cut, add) {
    const actions = Array.isArray(args.actions) ? args.actions : [];
    if (actions.length) add(panelSection("actions", actions.map(stepLine).join("\n")));
    add(panelPicture(payload));
    const said = actOutput(payload);
    if (said) add(panelSection("result", said, cut.has("output")));
  },
};

/**
 * A row saved before the daemon parsed tool results still holds the JSON dump of one, so a string
 * that is a result object is unpacked here: an old board reads like a new one, with no migration.
 */
function actParsed(payload) {
  const raw = payload.output;
  if (typeof raw !== "string" || !raw.trimStart().startsWith("{")) return payload;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return payload;
  }
  const content = Array.isArray(parsed?.content) ? parsed.content : null;
  if (!content) return payload;
  const text = content
    .filter((part) => part?.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("\n");
  const image = content.find((part) => part?.type === "image" && part.data);
  return {
    ...payload,
    output: text || raw,
    diff: payload.diff ?? parsed.details?.diff,
    exitCode: payload.exitCode ?? parsed.structuredContent?.exit_code,
    ...(image && !payload.images ? { images: [{ mime: image.mimeType || "image/png", data: image.data }] } : {}),
  };
}

/** Prose in the sheet: wrapped, readable, no monospace and no gutter. */
function panelProse(text) {
  const box = el("div", "act-prose");
  box.textContent = String(text);
  return box;
}

function paintActPanel(row) {
  const payload = actParsed(row);
  const args = payload.args && typeof payload.args === "object" ? payload.args : {};
  actPanelName.textContent =
    payload.kind === "reply" ? "answer" : payload.kind === "thinking" ? "thinking" : payload.tool || "tool";
  const took =
    typeof payload.durationMs === "number"
      ? payload.durationMs
      : payload.status === "running"
        ? Date.now() - payload.startedAt
        : 0;
  const exit = Number.isFinite(payload.exitCode) ? `exit ${payload.exitCode}` : "";
  const tokens =
    payload.kind === "thinking" && typeof payload.tokens === "number"
      ? `${payload.tokensEstimated ? "~" : ""}${payload.tokens} tok`
      : "";
  actPanelMeta.textContent = [payload.status, exit, tokens, payload.truncated ? "truncated" : "", took ? rowClock(took) : ""]
    .filter(Boolean)
    .join(" · ");
  const cut = new Set(payload.cut || []);
  const parts = [];
  const add = (node) => {
    if (node) parts.push(node);
  };
  const view = payload.kind === "tool" ? ACT_VIEWS[String(payload.tool || "")] : null;
  if (payload.kind === "thinking") {
    // The row carries the tail while it streams and the whole block once it ends, so the sheet draws
    // the whole one and never the tail beside it.
    const body = typeof payload.thinking === "string" && payload.thinking ? payload.thinking : actOutput(payload);
    add(panelBlock("thinking", body ? panelProse(body) : null, cut.has("thinking") || cut.has("output")));
  } else if (view) {
    view(payload, args, cut, add);
  } else {
    if (payload.args !== undefined) {
      // The server hands arguments over as an object, or as their JSON when it had to cut them.
      const text = typeof payload.args === "string" ? payload.args : JSON.stringify(payload.args, null, 2);
      add(panelSection("input", text || "", cut.has("args")));
    }
    add(panelPicture(payload));
    for (const [field, title] of [
      ["log", "log"],
      ["output", "output"],
      ["thinking", "thinking"],
      ["text", "answer"],
    ]) {
      const text = payload[field];
      if (typeof text !== "string" || !text) continue;
      add(panelSection(title, text, cut.has(field)));
    }
  }
  if (!parts.length) {
    const gone = el("div", "gone");
    gone.textContent = "nothing kept for this row";
    parts.push(gone);
  }
  // A row that is still streaming repaints four times a second, and a sheet that jumped back to the
  // top with every paint could not be read: the reader keeps their place, and a reader already at the
  // bottom follows the newest text.
  const atBottom = actPanelBody.scrollHeight - actPanelBody.scrollTop - actPanelBody.clientHeight < 40;
  const kept = actPanelBody.scrollTop;
  actPanelBody.replaceChildren(...parts);
  actPanelBody.scrollTop = atBottom ? actPanelBody.scrollHeight : kept;
}

async function fetchActDetail(id) {
  actPanelAskedAt = Date.now();
  let running = false;
  try {
    const response = await fetch(`/activity/${encodeURIComponent(id)}?${auth}`);
    // A slow answer for a panel the user already closed must not paint over the next one.
    if (actPanelId !== id) return;
    if (!response.ok) {
      // A missing payload is final: the row settled, was trimmed, or never had one, and nothing
      // will bring it back, so the panel stops asking.
      const why = el("div", "gone");
      why.textContent = (await response.text()).trim() || "no detail kept for this row";
      actPanelBody.replaceChildren(why);
      return;
    }
    const payload = await response.json();
    paintActPanel(payload);
    running = payload.status === "running";
  } catch {
    const why = el("div", "gone");
    why.textContent = "could not reach the board server";
    actPanelBody.replaceChildren(why);
    return;
  }
  // The loop drives itself: a tool that only streams an update never broadcasts a row, so a
  // timer armed from the board's stream would leave its panel frozen until the tool finished.
  if (running && actPanelId === id) {
    actPanelTimer = setTimeout(() => {
      if (actPanelId === id) void fetchActDetail(id);
    }, Math.max(0, 250 - (Date.now() - actPanelAskedAt)));
  }
}

function openActPanel(row) {
  if (!row) return;
  clearTimeout(actPanelTimer);
  actPanelId = row.id;
  actPanel.hidden = false;
  actPanelName.textContent = row.kind === "reply" ? "answer" : row.kind === "thinking" ? "thinking" : row.tool || "tool";
  actPanelMeta.textContent = String(row.status || "");
  actPanelBody.replaceChildren();
  // The panel itself takes the focus, so a second Enter goes nowhere instead of closing what just
  // opened. Tab walks in from here.
  actPanel.focus();
  void fetchActDetail(row.id);
}

function closeActPanel() {
  if (actPanel.hidden) return;
  const id = actPanelId;
  actPanelId = null;
  clearTimeout(actPanelTimer);
  actPanel.hidden = true;
  actPanelBody.replaceChildren();
  // The row may have been rebuilt while the panel was up, so the focus goes to the one there now.
  actEls.get(id)?.focus();
}

actPanelClose.addEventListener("click", closeActPanel);
actPanel.addEventListener("click", (event) => {
  if (event.target === actPanel) closeActPanel();
});
actPanel.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeActPanel();
    return;
  }
  // The panel holds the keyboard while it is open, so tab cannot walk the board behind it. Two
  // stops are inside: the close button and the body, and tab cycles between them both ways.
  if (event.key === "Tab") {
    event.preventDefault();
    const stops = [actPanelClose, actPanelBody];
    const at = stops.indexOf(document.activeElement);
    const step = event.shiftKey ? stops.length - 1 : 1;
    stops[at < 0 ? (event.shiftKey ? stops.length - 1 : 0) : (at + step) % stops.length].focus();
  }
});

/**
 * A thought's count leads, then its rate while it runs or the time it took once it ends. A tilde
 * means the number is our estimate rather than one the provider reported.
 */
function thoughtTiming(row) {
  const mark = row.tokensEstimated ? "~" : "";
  const tokens = typeof row.tokens === "number" ? `${mark}${row.tokens} tok` : "";
  const pace = row.status === "running" && row.rate ? `~${row.rate} tok/s` : "";
  const took = row.durationMs ? `${(row.durationMs / 1000).toFixed(row.durationMs < 1000 ? 2 : 1)}s` : "";
  return [tokens, pace || took].filter(Boolean).join(" · ");
}

/**
 * The live parts of a thinking row: its timing, the tail and the stamp the ticker reads. Patching
 * them in place keeps the dot's pulse running and leaves the user's text selection alone.
 */
function paintThought(node, row) {
  const timing = node.querySelector(".ms");
  timing.textContent = thoughtTiming(row);
  timing.title = row.tokensEstimated
    ? "thinking tokens estimated from the characters streamed, about four per token"
    : "thinking tokens reported by the provider";
  node.querySelector(".tail").textContent = thoughtTail(row.text);
  node.dataset.patchedAt = String(Date.now());
}

/**
 * A thought streams in paragraphs, so the rail keeps its newest lines and lets the CSS clamp hold
 * the height. Every newline costs a clamp line, so the newest five lines are kept whole and only a
 * very long line falls back to a character cut, which moves past a low surrogate so that no emoji
 * ends up as a box.
 */
function thoughtTail(text, keep = 180) {
  const flat = String(text || "").replace(/\s+$/, "");
  let tail = flat.split("\n").slice(-5).join("\n");
  if (tail.length > keep) {
    const start = tail.length - keep;
    tail = tail.slice(/[\uDC00-\uDFFF]/.test(tail[start]) ? start + 1 : start);
  }
  return tail.length < flat.length ? `…${tail}` : tail;
}

// Settled rows are filed under the thread that wrote them, one foldable section per thread, newest
// thread on top. A row that is still running is read in its own thread's card, where its answer will
// appear; the strip above the log holds it only when that card is not on this board, so a run is
// never invisible and the log below is only ever about what has already happened.
const railSections = new Map();
/** A section the reader folded shut. Session only: a reload shows everything again. */
const foldedSections = new Set();
let heldRows = 0;

function applyFold(entry) {
  entry.section.classList.toggle("folded", foldedSections.has(entry.id));
  entry.head.setAttribute("aria-expanded", foldedSections.has(entry.id) ? "false" : "true");
}

/** The rail's rows in the order they arrived, so the oldest is findable by its number. */
let railSeq = 0;

function railSection(row) {
  const id = row.thread?.id || "";
  let entry = railSections.get(id);
  if (!entry) {
    const section = el("section", "rail-thread");
    const head = el("button", "rail-thread-head");
    head.type = "button";
    head.append(
      el("span", "chev"),
      el("span", "rail-thread-title"),
      el("span", "rail-thread-count"),
      el("span", "rail-thread-stats"),
      el("button", "rail-thread-stop"),
      el("span", "rail-thread-role"),
    );
    const stop = head.children[4];
    stop.type = "button";
    stop.textContent = "■";
    stop.title = "stop this thread's run";
    stop.addEventListener("click", (event) => {
      // The section's own press must not fold it, which is what the head's click does.
      event.stopPropagation();
      stopThread(id);
    });
    const body = el("div", "rail-thread-body");
    section.append(head, body);
    head.addEventListener("click", () => {
      if (foldedSections.has(id)) foldedSections.delete(id);
      else foldedSections.add(id);
      applyFold(entry);
    });
    // The section says which thread it is, so a right click can read that thread's conversation.
    section.dataset.thread = id;
    entry = { section, head, body, id, title: "", roleEl: head.children[5], at: 0 };
    entry.roleEl.hidden = true;
    railSections.set(id, entry);
    applyFold(entry);
  }
  const title = row.thread?.title || "earlier";
  if (title !== entry.title) {
    entry.title = title;
    entry.head.children[1].textContent = title;
    entry.head.title = title;
  }
  return entry;
}

/**
 * Where the sections sit. The thread that spoke last is on top, so a busy board reads as a stack of
 * conversations, and a child always sits directly under the master that spawned it. The log itself
 * stays a flat list, because trimming, folding and the replay all assume that, so the order is
 * recomputed and only the sections that are out of place are moved.
 */
function orderRail() {
  const parentOf = (entry) => threadMeta.get(entry.id)?.parent || "";
  const ranked = [...railSections.values()].sort((a, b) => b.at - a.at);
  const wanted = [];
  for (const master of ranked) {
    // A child is only nested while the section it hangs under is still there; a master whose own
    // rows were trimmed away has no head left to sit under, so the child reads as a thread of its own.
    const nested = Boolean(parentOf(master)) && railSections.has(parentOf(master));
    master.section.classList.toggle("child", nested);
    if (nested) continue;
    wanted.push(master);
    for (const kid of ranked) {
      if (kid === master || parentOf(kid) !== master.id) continue;
      kid.section.classList.add("child");
      wanted.push(kid);
    }
  }
  let cursor = railLog.firstElementChild;
  for (const entry of wanted) {
    if (entry.section === cursor) {
      cursor = cursor.nextElementSibling;
      continue;
    }
    railLog.insertBefore(entry.section, cursor);
  }
}

/** The oldest row in the log, whichever section it sits in. */
function oldestRailRow() {
  let oldest = null;
  let at = Infinity;
  for (const entry of railSections.values()) {
    const row = entry.body.lastElementChild;
    const seen = Number(row?.dataset.seq ?? NaN);
    if (row && seen < at) {
      oldest = row;
      at = seen;
    }
  }
  return oldest;
}

/** The log is a tail, not a history: the oldest row goes first, whatever section it belongs to. */
function trimRail() {
  while (heldRows > 200) {
    const row = oldestRailRow();
    if (!row) return;
    for (const [id, elem] of actEls) if (elem === row) actEls.delete(id);
    const section = row.closest(".rail-thread");
    row.remove();
    heldRows--;
    // A section with no rows left says nothing, so it goes: its children then sort as threads of
    // their own instead of nesting under a head that is no longer there.
    if (section && !section.querySelector(".rail-thread-body")?.childElementCount) {
      section.remove();
      for (const [id, entry] of railSections) if (entry.section === section) railSections.delete(id);
    }
  }
}

function clearRailLog() {
  railLog.replaceChildren();
  railSections.clear();
  foldedSections.clear();
  actEls.clear();
  heldRows = 0;
  // A live row can sit in a card, so a replay empties those boxes as well as the log.
  for (const entry of byId.values()) entry.live?.replaceChildren();
  paintLive();
}

/**
 * The card a thread draws on: the card the daemon made with the thread's own id. A card the thread
 * wrote carries `answersWith.thread` as well, and `threadFacts` keeps whichever of them was painted
 * last, so that map must not be asked which card is the thread's own — a note the agent wrote is not
 * where its run is read. Only a hidden thread, which has no card of its own, is read through the card
 * it answers for.
 */
function cardOfThread(threadId) {
  if (!threadId) return null;
  const own = byId.get(threadId);
  if (own?.live) return own;
  for (const entry of byId.values()) {
    const data = entry.data || {};
    if (data.type === "sticky") continue;
    if (data.answersWith?.thread === threadId && entry.live) return entry;
  }
  return null;
}

/**
 * Whether this card is where a run is being read, which is the one card that wears a strip.
 *
 * A thread card is the run's own surface, so it is live while it answers. A card a hidden child answers
 * for is live while that child writes one of its turns, because the card is the only place the child is
 * read. A card a drawn thread owns is written by nobody — its question and its answer land on the
 * thread card — so an artifact of a busy thread must not wear a strip that looks like work there:
 * `answersWith.running` names that thread's whole run, and it is true for every card it ever made. That
 * is how a thread and the note it once wrote both came up saying `waiting`.
 */
function threadOn(entry) {
  const data = entry.data || {};
  if (data.type === "sticky") return data.status === "sent";
  return Array.isArray(data.turns) && data.turns.some((turn) => turn.streaming === true);
}

/** Whether this card's last turn is having its answer written right now. */
function answerArriving(entry) {
  const turns = Array.isArray(entry.data?.turns) ? entry.data.turns : [];
  const last = turns[turns.length - 1];
  return Boolean(last?.streaming && last?.reply);
}

/**
 * A run between two steps: the model is being prefilled, a network hop is being taken, or the answer is
 * being written, and no row has arrived to read. The wait row is the height of a running row, so the
 * answer above it stays where it is when one step settles and the next arrives, and its blinking caret
 * is what says the run is still going.
 */
function waitRow(word) {
  const node = el("div", "act wait running");
  node.dataset.status = "running";
  node.title = "the run is going and no step has started";
  const top = el("div", "top");
  top.appendChild(el("span", "dot"));
  const name = el("span", "name");
  name.textContent = word;
  top.appendChild(name);
  const caret = el("span", "caret");
  caret.setAttribute("aria-hidden", "true");
  top.appendChild(caret);
  top.appendChild(el("span", "ms"));
  node.appendChild(top);
  // The lines a running row gives to what it is working on, left empty: their height is the point.
  node.appendChild(el("div", "target"));
  return node;
}

/**
 * Whether a card is showing a live step, and what fills its strip while it shows none. The card keeps
 * its own height and the column scrolls, so a field that grows under the answer moves nothing else on
 * the board; and the strip is one row tall whether it holds a step or a wait row, so a step settling
 * does not move the answer either.
 */
function paintLive() {
  for (const entry of byId.values()) {
    if (!entry.live) continue;
    const on = threadOn(entry);
    const wait = entry.live.querySelector(".act.wait");
    const step = [...entry.live.children].some((node) => !node.classList.contains("wait"));
    if (on && !step) {
      const word = answerArriving(entry) ? "answering" : "waiting";
      if (wait) wait.querySelector(".name").textContent = word;
      else entry.live.appendChild(waitRow(word));
    } else if (wait) {
      wait.remove();
    }
    entry.card.classList.toggle("live", on);
  }
}

/** Every row that is still running, wherever it is drawn: the count the rail head and the tab show. */
function runningCount() {
  let running = 0;
  for (const node of actEls.values()) if (node.dataset.status === "running") running++;
  return running;
}

/**
 * Where a running row is read: its thread's card while that card is here, and the rail strip when it is
 * not, so a run always has somewhere to be seen. Moving a node that is already home is not moving it.
 */
function homeRunning(node) {
  const card = cardOfThread(node.dataset.thread);
  const box = card ? card.live : railNow;
  if (node.parentElement !== box) box.prepend(node);
}

/**
 * A snapshot replays its activity rows before the cards that should hold them, so a row can arrive at a
 * board with nowhere to live yet. This runs after every repaint, when the board knows which card draws
 * which thread, and puts the rows that are still running where they belong.
 */
function homeLiveRows() {
  for (const node of actEls.values()) if (node.dataset.status === "running") homeRunning(node);
  paintLive();
}

function applyActivity(row) {
  // A row that just settled gets one fetch, the one that carries its full output. A running row
  // is polled by fetchActDetail itself.
  if (actPanelId === row.id && row.status !== "running") {
    clearTimeout(actPanelTimer);
    void fetchActDetail(row.id);
  }
  const previous = actEls.get(row.id);
  // A thought patches four times a second while its status stays put. Rebuilding the node would
  // restart the dot's pulse and drop a text selection, so it is updated where it stands.
  if (previous && row.kind === "thinking" && previous.dataset.status === row.status) {
    homeRunning(previous);
    paintThought(previous, row);
    return;
  }
  const card = row.status === "running" ? cardOfThread(row.thread?.id) : null;
  const node = actRow(row, card !== null);
  // The row carries when it arrived, so trimming can find the oldest one without trusting the order
  // of the sections, which the rail reorders to keep a child under its master.
  node.dataset.seq = String(++railSeq);
  if (previous) previous.remove();
  actEls.set(row.id, node);
  if (row.status === "running") {
    homeRunning(node);
  } else {
    const section = railSection(row);
    section.body.prepend(node);
    section.at = railSeq;
    section.head.children[2].textContent = String(section.body.childElementCount);
    // The thread that just spoke goes on top, so a board with many threads reads like a stack of
    // conversations rather than one long line of tool calls. A child goes under its master instead.
    orderRail();
    heldRows++;
    trimRail();
  }
  paintLive();
  const running = runningCount();
  railRunning.textContent = running ? String(running) : "";
  railOpenCount.textContent = running ? String(running) : "";
  syncTicker();
}

// ---------- composer -----------------------------------------------------
// Every thread card carries a field, so a message is written where its answer will be read and the
// field is always there rather than moving to whichever card was clicked last. A card that is only
// named in a message never grows one: it joins a neighbouring field as a reference, and one message
// can name several.
const composerTpl = document.getElementById("composerTpl");
const composerHome = document.getElementById("composerHome");
const footHint = document.getElementById("footHint");
let footTimer = 0;
const statCtx = document.getElementById("statCtx");
const statCtxValue = document.getElementById("statCtxValue");
/** Every field on the board, by the card it belongs to. `""` is the bottom bar of a one-session board. */
const composers = new Map();
/** The field the keyboard was last in: where a hint lands, and where a reference is added. */
let activeComposer = null;
/** A note that outranks the usual hint until it has been read. */
let hintTimer = null;

/** The card a field belongs to, or null for the bottom bar. */
const cardOf = (inst) => (inst ? inst.entry : null);

/** The field built for a card, if that card has one. */
const composerOf = (entry) => (entry ? composers.get(entry.id) ?? null : null);

/** The field that holds the caret, if one does. `activeComposer` is the last one used, which is not the same. */
function focusedComposer() {
  const caret = document.activeElement;
  return caret && activeComposer && activeComposer.root.contains(caret) ? activeComposer : null;
}

/**
 * One field, built once per thread card and once for the bottom bar a one-session board keeps. Its
 * whole state lives here, so two cards never share a draft, an attachment or a reference.
 */
function makeComposer(entry) {
  const key = entry ? entry.id : "";
  if (composers.has(key)) return composers.get(key);
  const root = composerTpl.content.firstElementChild.cloneNode(true);
  const inst = {
    key,
    entry: entry ?? null,
    root,
    msg: root.querySelector(".msg"),
    send: root.querySelector(".send"),
    hintEl: root.querySelector(".hintline"),
    refRow: root.querySelector(".refs"),
    paths: root.querySelector(".paths"),
    shots: root.querySelector(".shots"),
    modeBtn: root.querySelector(".mode-toggle"),
    forkBtn: root.querySelector(".fork"),
    pickModeBtn: root.querySelector(".mode-pick"),
    pickPathBtn: root.querySelector(".path-pick"),
    modelBtn: root.querySelector(".model-pick"),
    thinkBtn: root.querySelector(".think-pick"),
    ctxBtn: root.querySelector(".ctx-btn"),
    ctxLabel: root.querySelector(".ctx-label"),
    filesBtn: root.querySelector(".files"),
    // Steering cuts a run short, so it is a choice about this message rather than about the board.
    sendMode: "queue",
    // A fork asks a new thread instead of the one that answers the card, and is one send's choice.
    forkNext: false,
    // The thread whose compaction is in flight, so the meter says so until the figures come back.
    compacting: "",
    /** The cards this message names beside the one it is written in. */
    named: [],
    /** Images pasted into this field and paths picked for it: both travel with the message. */
    images: [],
    picked: new Map(),
  };
  wireComposer(inst);
  composers.set(key, inst);
  return inst;
}

/** Everything the field does: typing, sending, the chips that choose how it answers, and the pickers. */
function wireComposer(inst) {
  // The keyboard and the board agree on which card is current: a focus landing in the field makes its
  // card the one being read.
  inst.root.addEventListener("focusin", () => {
    activeComposer = inst;
    if (inst.entry) selectCard(inst.entry.card);
    paintReferenceRings();
  });
  inst.root.addEventListener("focusout", (event) => {
    // A press on one of the field's own buttons is not a leaving: the chips it names stay ringed.
    if (event.relatedTarget && inst.root.contains(event.relatedTarget)) return;
    paintReferenceRings();
    // A field that gave the keyboard away takes its `@` list with it; what was typed stays.
    if (atInst === inst) closeAtPick();
  });
  inst.msg.addEventListener("keydown", (event) => {
    // The `@` list owns the keys it puts on screen: Enter takes its row, Escape shuts it without
    // giving the keyboard back, and neither may reach the send and blur below.
    if (atPickKey(inst, event)) return;
    if (event.key === "Escape") {
      // The field keeps what was written: Escape gives the keyboard back to the board, and the ×
      // on a reference is what drops it.
      event.preventDefault();
      event.stopPropagation();
      inst.msg.blur();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage(inst);
    }
  });
  inst.msg.addEventListener("input", () => typedInAtPick(inst));
  inst.msg.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    event.preventDefault();
    for (const file of files.slice(0, 4)) {
      const reader = new FileReader();
      reader.addEventListener("load", async () => {
        const shot = await shrinkImage(String(reader.result), file.type);
        inst.images.push(shot);
        drawAttachments(inst);
      });
      reader.readAsDataURL(file);
    }
  });
  inst.send.addEventListener("click", () => void sendMessage(inst));
  inst.modeBtn.addEventListener("click", () => {
    inst.sendMode = inst.sendMode === "steer" ? "queue" : "steer";
    paintHint(inst);
  });
  inst.forkBtn.addEventListener("click", () => {
    inst.forkNext = !inst.forkNext;
    paintFork(inst);
    paintHint(inst);
  });
  inst.pickModeBtn.addEventListener("click", () => void openPick("mode", inst.pickModeBtn, false, inst));
  inst.pickPathBtn.addEventListener("click", () => void openPick("path", inst.pickPathBtn, false, inst));
  inst.modelBtn.addEventListener("click", () => void openPick("model", inst.modelBtn, false, inst));
  inst.thinkBtn.addEventListener("click", () => void openPick("thinking", inst.thinkBtn, false, inst));
  inst.ctxBtn.addEventListener("click", () => void compactField(inst));
  inst.filesBtn.addEventListener("click", () => {
    // Attaching files is a question the picker asks of one field, so it becomes the current one.
    activeComposer = inst;
    if (!picker.hidden) closePicker();
    else void browse(pickerAt);
  });
}

// A board with a single session behind it keeps one field in the bottom bar. A board of threads hides
// the bar: every thread card carries its own field, built where the card is.
composerHome.appendChild(makeComposer(null).root);

// ---------- hints ---------------------------------------------------------
/**
 * What the field says under its buttons: whether the message leaves now, waits behind a run, or cuts
 * it short. A stream that is down leaves the field readable on purpose, so it is the hint that has to
 * stop promising a send.
 */
function paintHint(inst) {
  const running = metaRunning === true;
  const forkable = forkTarget(inst);
  inst.modeBtn.textContent = inst.sendMode;
  inst.modeBtn.classList.toggle("steer", inst.sendMode === "steer");
  inst.modeBtn.title = running
    ? inst.sendMode === "steer"
      ? "steer: this message interrupts the run in flight — click for queue"
      : "queue: this message waits for the run in flight — click for steer"
    : "nothing is running, so this message goes now — click to choose steer next time";
  inst.hintEl.classList.remove("bad");
  inst.hintEl.textContent = !linkUp
    ? "offline"
    : !running
      ? "sends now"
      : inst.sendMode === "steer"
        ? "interrupts the run"
        : forkable && inst.forkNext
          ? "asks a new thread"
          : "waits for this run to finish";
}

/** Every field on the board, because a run boundary changes what all of them would do. */
function paintComposer() {
  for (const inst of composers.values()) paintHint(inst);
}

/**
 * Something the board did rather than the field: say it, then go back to the usual hint. Nothing to
 * say it in — a board with no thread card on it — and the footer says it instead, because that is on
 * screen whatever the board is doing.
 */
function hintLine(text, bad = false, inst = activeComposer) {
  const into = inst && composers.has(inst.key) ? inst : activeComposer;
  if (!into) return footNote(text, bad);
  into.hintEl.textContent = text;
  into.hintEl.classList.toggle("bad", bad);
  clearTimeout(hintTimer);
  hintTimer = setTimeout(paintComposer, 6000);
}

/** One line in the footer, which is on screen whatever the fields are doing. */
function footNote(text, bad = false) {
  if (!footHint) return;
  footHint.textContent = text;
  footHint.classList.toggle("bad", bad);
  clearTimeout(footTimer);
  footTimer = setTimeout(() => {
    footHint.textContent = "";
  }, 8000);
}

/**
 * Text onto the clipboard. A board opened over the network is not a secure context, where the modern
 * call does not exist, so the old selection trick stands in for it.
 */
function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    const box = el("textarea");
    box.value = text;
    box.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.appendChild(box);
    box.select();
    try {
      if (document.execCommand("copy")) resolve();
      else reject(new Error("copy refused"));
    } finally {
      box.remove();
    }
  });
}

// Compaction is the agent's own housekeeping, so the board asks the session for it and reports
// what came back. The server refuses while a run is in flight: compaction aborts that run first.
statCtx.addEventListener("click", async () => {
  statCtx.disabled = true;
  hintLine("compacting…");
  try {
    const response = await fetch(`/compact?${auth}`, { method: "POST" });
    if (!response.ok) hintLine((await response.text()).trim() || "could not compact", true);
  } catch {
    hintLine("could not reach the board server", true);
  } finally {
    statCtx.disabled = false;
  }
});

// ---------- the context meter in a field ----------------------------------
// A field answers for the thread whose card holds it, and that thread's context is the number a
// compaction changes, so the button that presses it sits in the row of buttons beside the field
// rather than in the header. See `answeringRuntime` for what answers a field.
/** Half the window is where the number turns from a statistic into a warning. */
const CTX_HOT = 50;
/** Near the edge the same heat goes red: the next answer is the one at risk. */
const CTX_FULL = 80;

/**
 * What answers this field. A thread card carries its own runtime; the bottom bar of a one-session
 * board has nothing under it, and its chips speak for the board's defaults instead.
 */
function answeringRuntime(inst = activeComposer) {
  return cardOf(inst)?.data ?? null;
}

/** The context of the thread this field talks to, against the window it talks into. */
function answeringCtx(inst) {
  const held = cardOf(inst);
  if (!held) return null;
  const stats = held.data.stats ?? {};
  const context = Number(stats.context) || 0;
  const max = Number(stats.contextMax) || 0;
  // The daemon divides for the same reason the footer does; the ratio is the fallback for a board
  // written before it worked out the percentage itself.
  const said = Number(stats.contextPercent);
  const percent = Number.isFinite(said) ? said : context && max ? (context / max) * 100 : NaN;
  // A thread nobody has asked anything has no figure at all, and then there is nothing to draw. A
  // thread whose window pi has not reported is different: it has a size, and pressing the button is
  // still the thing to do, so it says the size and leaves the fill out.
  if (!context) return null;
  return { threadId: held.id, context, max, percent, running: held.data.status === "sent" };
}

function paintCtx(inst) {
  const held = answeringCtx(inst);
  inst.ctxBtn.hidden = !held;
  if (!held) return;
  const known = Number.isFinite(held.percent);
  const percent = known ? Math.round(held.percent) : 0;
  const busy = inst.compacting === held.threadId;
  const shown = Math.max(0, Math.min(100, percent));
  inst.ctxLabel.textContent = busy ? "compacting…" : known ? `ctx ${percent}%` : `ctx ${compact(held.context)}`;
  inst.ctxBtn.style.setProperty("--fill", `${known ? shown : 0}%`);
  inst.ctxBtn.classList.toggle("hot", known && percent >= CTX_HOT && percent < CTX_FULL);
  inst.ctxBtn.classList.toggle("full", known && percent >= CTX_FULL);
  inst.ctxBtn.classList.toggle("working", busy);
  const size = held.context && held.max ? `ctx ${compact(held.context)}/${compact(held.max)}` : `${compact(held.context)} tokens in this thread, window not reported yet`;
  inst.ctxBtn.title = held.running
    ? `${size} · compaction waits until this thread stops answering`
    : `${size} · compact the context, the same as /compact`;
  inst.ctxBtn.setAttribute("aria-label", known ? `context ${percent}% used, compact it` : `compact the context, ${compact(held.context)} tokens`);
}

async function compactField(inst) {
  const held = answeringCtx(inst);
  // One thread at a time, and only the button that is waiting says so: a compaction in another card
  // leaves this one working.
  if (!held || inst.compacting === held.threadId) return;
  inst.compacting = held.threadId;
  paintCtx(inst);
  footNote("compacting the context…");
  try {
    const response = await fetch(`/compact?${auth}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardId: held.threadId }),
    });
    if (!response.ok) throw new Error((await response.text()).trim() || response.statusText);
    const payload = await response.json();
    const before = Number(payload.tokensBefore);
    const after = Number(payload.estimatedTokensAfter);
    footNote(Number.isFinite(after) && Number.isFinite(before) ? `compacted · ${compact(before)} → ${compact(after)} tokens` : "compacted");
  } catch (error) {
    footNote(`could not compact: ${error.message || error}`, true);
  } finally {
    inst.compacting = "";
    paintCtx(inst);
  }
}

// ---------- what a field is carrying --------------------------------------
/**
 * Put a field's work aside under its card. Nothing moves a field from card to card any more, so this
 * is only for a card that leaves the board: a closed card put back with ctrl+z keeps its words, its
 * attachments and the cards it was about.
 */
function parkDraft(inst) {
  if (!inst) return;
  const held = { text: inst.msg.value, images: [...inst.images], picked: [...inst.picked], named: [...inst.named] };
  const used = held.text.trim() !== "" || held.images.length > 0 || held.picked.length > 0 || held.named.length > 0;
  if (used) drafts.set(inst.key, held);
  else drafts.delete(inst.key);
}

/** What was put aside for this card, back in the field the card was rebuilt with. */
function restoreDraft(inst) {
  const held = drafts.get(inst.key);
  if (!held) return;
  inst.msg.value = held.text ?? "";
  inst.images.splice(0, inst.images.length, ...(held.images ?? []));
  inst.picked.clear();
  for (const [path, meta] of held.picked ?? []) inst.picked.set(path, meta);
  inst.named.splice(0, inst.named.length, ...(held.named ?? []));
  drawAttachments(inst);
  drawChips(inst);
  paintRefs(inst);
}

/**
 * The card that stands for the thread which answers this card: a thread card is its own window, and a note,
 * source or question is read on the window of the thread that wrote it. The thread that answers comes first,
 * because that is the thread the server sends the message to; a thread with no card of its own is read
 * through the card it answers, so the walk carries on from there. A card with no thread card above it at
 * all — one whose thread was closed — stays its own window.
 */
function windowOf(entry) {
  if (!entry) return null;
  const seen = new Set();
  let held = entry;
  while (held && !seen.has(held.id)) {
    if (held.data.type === "sticky") return held;
    seen.add(held.id);
    held = byId.get(held.data.ownerThread) ?? byId.get(held.data.threadRoot) ?? byId.get(held.data.answersWith?.thread);
  }
  return entry;
}

// ---------- what a message names ------------------------------------------
/** What a card is called in a reference chip: a thread by its title, anything else by its own name. */
function cardName(entry) {
  const data = entry?.data ?? {};
  const words = data.type === "sticky" ? data.title || "this thread" : entry?.titleEl?.textContent || data.type || "card";
  return words.replace(/\s+/g, " ").trim().slice(0, 32) || "card";
}

/**
 * Names one card in a field's message, once. A message can name several cards, and each one travels to
 * the agent as the card it is about, so the answer lands beside the artifact the human is reading.
 */
function addReference(inst, entry) {
  if (!inst || !entry) return false;
  // The card the field is written in is what the message answers; naming it again would be noise.
  if (inst.key === entry.id || inst.named.includes(entry.id)) return false;
  inst.named.push(entry.id);
  paintRefs(inst);
  paintReferenceRings();
  return true;
}

/** One chip per card the message names, each droppable on its own. */
function paintRefs(inst) {
  // A card that left the board is not a reference any more, so the row drops it rather than naming
  // something a click would miss.
  inst.named = inst.named.filter((id) => byId.has(id));
  inst.refRow.hidden = inst.named.length === 0;
  inst.refRow.replaceChildren(
    ...inst.named.map((id) => {
      const entry = byId.get(id);
      const chip = el("div", "ref");
      const name = el("span");
      name.textContent = `about “${cardName(entry)}”`;
      name.title = `this message names ${entry.data.path || id}`;
      const drop = el("button");
      drop.type = "button";
      drop.textContent = "×";
      drop.title = "drop this reference";
      drop.addEventListener("click", () => {
        inst.named = inst.named.filter((one) => one !== id);
        paintRefs(inst);
        paintReferenceRings();
        inst.msg.focus();
      });
      chip.append(name, drop);
      return chip;
    }),
  );
  paintFork(inst);
  paintHint(inst);
}

/** The cards the message being written names, ringed so the board says what the field is about. */
function paintReferenceRings() {
  const typing = focusedComposer();
  const named = new Set(typing ? typing.named : []);
  for (const record of byId.values()) record.card.classList.toggle("referenced", named.has(record.id));
}

/** The keyboard goes into one field, and the cards it names light up with it. */
function focusComposer(inst) {
  if (!inst) return;
  activeComposer = inst;
  paintReferenceRings();
  inst.msg.focus();
  reveal(inst.msg);
}

/**
 * What `r` and the `↩` in a card's head do: name that card in a field. A thread card has a field of its
 * own, so the caret goes there; a note, source or question joins the message being written, or the
 * message of the thread that answers it when nothing is being written.
 */
function replyToCard(entry) {
  if (!entry) return;
  const own = entry.data.type === "sticky" ? entry : null;
  const house = composerOf(own ?? windowOf(entry));
  if (!house) {
    footNote("this card has no thread card to answer it", true);
    return;
  }
  if (own) return focusComposer(house);
  // A field with the keyboard is the message being written, and a card picked while writing is what
  // the message is about.
  const into = focusedComposer() ?? house;
  const added = addReference(into, entry);
  focusComposer(into);
  footNote(
    added
      ? `named “${cardName(entry)}” in the message${cardOf(into) ? ` in “${cardName(cardOf(into))}”` : " on the board"}`
      : `“${cardName(entry)}” is already named in that message`,
  );
}

// ---------- what a thread is for -------------------------------------------
// What a new thread is born with. `pathNext` empty means the board's own flow, so a board that always
// works the same way is not overridden by a picker nobody touched.
let modeNext = "agent";
let pathNext = "";

/** The three names a thread's mode can have. A card's `mode` is also the queue mode of its last turn. */
const THREAD_MODES = ["agent", "plan", "boss"];

/** What the two buttons say: this card's mode, or the one a new thread would be born with. */
function modeShown(inst = pickInst ?? activeComposer) {
  const held = cardOf(inst);
  const mode = held ? (THREAD_MODES.includes(held.data.mode) ? held.data.mode : "agent") : modeNext;
  return {
    mode,
    path: held ? held.data.path || "auto" : pathNext || boardConfig.path || "auto",
  };
}

/**
 * A mode decides whether the thread works, plans, or spawns; a boss also runs a flow. Both are the
 * human's choice, so they live in the field beside the model and the thinking level rather than on
 * the board, where a press that spawns work would read like a press that does work. No argument paints
 * every field.
 */
function paintMode(inst) {
  if (!inst) {
    for (const one of composers.values()) paintMode(one);
    return;
  }
  const { mode, path } = modeShown(inst);
  inst.pickModeBtn.textContent = mode;
  inst.pickModeBtn.classList.toggle("on", mode !== "agent");
  inst.pickModeBtn.title =
    mode === "boss"
      ? "a boss: it spawns children with roles and does no work itself"
      : mode === "plan"
        ? "a planner: a plan and throwaway checks under /tmp, no edits"
        : "an agent: it does the work itself";
  inst.pickPathBtn.hidden = mode !== "boss";
  inst.pickPathBtn.textContent = path;
  inst.pickPathBtn.title =
    path === "auto"
      ? "the boss picks the flow at its first turn and says which one"
      : `the ${path} flow, read from prompts/flows/${path}.md`;
}

/**
 * The card a fork would ask, if the message names one: a fork differs only when something already
 * answers a named card, and `answersWith` is how a card reports having a thread behind it.
 */
function forkTarget(inst) {
  for (const id of inst.named) {
    const held = byId.get(id);
    if (held && held.data.type !== "sticky" && held.data.answersWith) return held;
  }
  return null;
}

function paintFork(inst) {
  const owned = Boolean(forkTarget(inst));
  inst.forkBtn.hidden = !owned;
  inst.forkBtn.disabled = !owned;
  inst.forkBtn.classList.toggle("on", owned && inst.forkNext);
  inst.forkBtn.title = inst.forkNext
    ? "a new thread will answer in its own conversation"
    : "ask a new thread instead of the one that made that card";
}

// ---------- what answers ---------------------------------------------------
// A field answers with the model and thinking level of the thread behind its card, so the two chips
// name that thread and edit it. The bottom bar of a one-session board has no card, so its chips edit
// what the next thread starts with.
const runtimePick = document.getElementById("runtimePick");
const runtimeSearch = document.getElementById("runtimeSearch");
const runtimeList = document.getElementById("runtimeList");
/** {models, levels} from the daemon, read on the first open of either chip. */
let catalog = null;
/**
 * Whether the picker shows the whole catalogue instead of the scope pi cycles. A taste about this
 * browser, so it lives here rather than in the board's settings.
 */
const SHOW_ALL_KEY = "board.allModels";
let showAllModels = localStorage.getItem(SHOW_ALL_KEY) === "1";
/** Said in the panel when a refresh failed but an older catalogue is still on screen. */
let catalogStale = "";
/** Which chip opened the panel: "model", "thinking", or "" when it is closed. */
let picking = "";
/** The board's own settings: what a new thread starts with, and which features are on. */
let boardConfig = {};
/** Where the panel hangs off, when something other than a field's chip opened it. */
let pickAnchor = null;
/** True when the picker is editing the board's defaults rather than one card's thread. */
let pickBoard = false;
/** The field whose chip opened the picker, when it was one: the board's settings are nobody's. */
let pickInst = null;

function pickNote(text) {
  const node = el("div", "pick-note");
  node.textContent = text;
  return node;
}

/** What the picker is editing: one card's thread, or the board's defaults. */
function pickRuntime() {
  return pickBoard ? boardConfig : (answeringRuntime(pickInst) ?? boardConfig);
}

function shortModel(model) {
  return String(model ?? "").split("/").pop() || "model";
}

/**
 * The heat the think chip wears, as an ironbow ramp that stops at yellow. The coldest level is the
 * deep indigo a thermal image starts from and the hottest is yellow, so asking for the hardest
 * think reads warm instead of white-hot and never looks like a warning. `off` is not on the ramp:
 * the chip keeps the plain border every other button in the row has.
 */
const HEAT_RAMP = [
  [0, [42, 15, 94]],
  [0.2, [84, 26, 138]],
  [0.35, [130, 24, 137]],
  [0.5, [176, 26, 99]],
  [0.65, [214, 52, 40]],
  [0.82, [237, 122, 18]],
  [1, [242, 197, 61]],
];
/** Where pi's seven levels sit on that ramp, coldest first. `off` is absent on purpose. */
const HEAT_AT = new Map([
  ["minimal", 0.2],
  ["low", 0.35],
  ["medium", 0.5],
  ["high", 0.65],
  ["xhigh", 0.82],
  ["max", 1],
]);

/** The ramp's colour at `t`, as the three bytes a CSS colour wants. */
function heatColor(t) {
  let from = HEAT_RAMP[0];
  let to = HEAT_RAMP[HEAT_RAMP.length - 1];
  for (let index = 1; index < HEAT_RAMP.length; index += 1) {
    if (t <= HEAT_RAMP[index][0]) {
      from = HEAT_RAMP[index - 1];
      to = HEAT_RAMP[index];
      break;
    }
  }
  const span = to[0] - from[0] || 1;
  const at = Math.min(1, Math.max(0, (t - from[0]) / span));
  return from[1].map((byte, channel) => Math.round(byte + (to[1][channel] - byte) * at)).join(", ");
}

/** Paints the chip for one level, or takes the paint off when nothing is thinking. */
function paintHeat(inst, level) {
  const at = HEAT_AT.get(level);
  if (at === undefined) {
    inst.thinkBtn.style.removeProperty("--heat-tint");
    inst.thinkBtn.style.removeProperty("--heat-haze");
    return;
  }
  const color = heatColor(at);
  inst.thinkBtn.style.setProperty("--heat-tint", `rgb(${color})`);
  inst.thinkBtn.style.setProperty("--heat-haze", `rgba(${color}, .5)`);
}

/**
 * What answers what. A chip names the thread behind its own card, so each field paints itself; the
 * board-wide part — what every thread is doing and what it has spent — is one pass over the cards, and
 * it is done once however many fields are open. No argument paints every field.
 */
function paintRuntime(inst) {
  if (!inst) {
    for (const one of composers.values()) paintRuntime(one);
    paintBoardFacts();
    return;
  }
  const held = cardOf(inst);
  const runtime = (held ? held.data : boardConfig) ?? {};
  inst.modelBtn.textContent = shortModel(runtime.model);
  inst.thinkBtn.textContent = runtime.thinking ? `think ${runtime.thinking}` : "think off";
  paintHeat(inst, runtime.thinking);
  const where = held ? `“${cardName(held)}” answers with` : "a new thread starts with";
  inst.modelBtn.title = `${where} ${runtime.provider ?? ""}/${runtime.model ?? ""}`;
  inst.thinkBtn.title = `${held ? "this card" : "a new thread"} thinks at ${runtime.thinking || "off"}`;
  paintCtx(inst);
  paintMode(inst);
  paintHint(inst);
}

/** What the board itself says: each thread's cost, the live rows, the footer and the tool switches. */
function paintBoardFacts() {
  // The bottom bar of a one-session board has no card of its own, so its chips speak for the board's
  // default, which is whatever the newest thread was started with until a new choice is made.
  const bar = composers.get("");
  if (bar && !boardConfig.model) {
    const newest = [...byId.values()]
      .filter((entry) => entry.data.type === "sticky")
      .sort((left, right) => (right.data.at ?? 0) - (left.data.at ?? 0))[0];
    if (newest) {
      boardConfig = { ...boardConfig, provider: newest.data.provider, model: newest.data.model, thinking: newest.data.thinking };
    }
  }
  paintConfig();
  // One pass over the cards says what every thread is doing and what it has spent, because a card is
  // where a thread is read — its own card, or the card a hidden child answers for.
  threadFacts.clear();
  for (const entry of byId.values()) {
    const data = entry.data || {};
    const id = data.type === "sticky" ? entry.id : data.answersWith?.thread;
    if (!id) continue;
    const runtime = data.type === "sticky" ? data : (data.answersWith ?? {});
    threadFacts.set(id, {
      cardId: entry.id,
      stats: runtime.stats,
      running: data.type === "sticky" ? data.status === "sent" : runtime.running === true,
      provider: runtime.provider,
      model: runtime.model,
    });
  }
  paintSections();
  homeLiveRows();
  paintFooter();
}

function closePick() {
  const wasOpen = !runtimePick.hidden;
  picking = "";
  pickAnchor = null;
  pickBoard = false;
  pickInst = null;
  runtimePick.hidden = true;
  runtimeSearch.value = "";
  // A picker opened from the board's settings has written the daemon's copy by now, through a route of
  // its own. The panel is drawn from the document, so it is reread instead of guessed at from that
  // answer, which names a setting its own way.
  if (wasOpen) refreshSettings();
}

function placeRuntimePick() {
  // The panel hangs off the chip that opened it, which the open call names: a field's own chip, or a
  // row in the board's settings.
  const anchor = pickAnchor ?? (picking === "thinking" ? pickInst?.thinkBtn : pickInst?.modelBtn);
  const chip = anchor ? anchor.getBoundingClientRect() : { left: 12, top: 12, bottom: 30 };
  const width = runtimePick.offsetWidth;
  const height = runtimePick.offsetHeight;
  runtimePick.style.left = `${Math.max(10, Math.min(window.innerWidth - width - 10, chip.left))}px`;
  // Above the thing it hangs off, unless that would push it off the top: then below, so a panel in
  // the corner does not have its own picker covering the row that opened it.
  const above = chip.top - height - 8;
  const top = above >= 10 ? above : Math.min(window.innerHeight - height - 10, chip.bottom + 8);
  runtimePick.style.top = `${Math.max(10, top)}px`;
}

function pickRow(text, meta, on, onPick) {
  const row = el("button", on ? "pick-row on" : "pick-row");
  row.type = "button";
  const name = el("span");
  name.textContent = text;
  row.appendChild(name);
  if (meta) {
    const aside = el("span", "pick-meta");
    aside.textContent = meta;
    row.appendChild(aside);
  }
  row.addEventListener("click", onPick);
  return row;
}

function pickHead(text) {
  const head = el("div", "pick-group");
  head.textContent = text;
  return head;
}

/** One model, with the provider that offers it when the list has no provider heading, and the rest. */
function modelRow(one, aside) {
  const here = pickRuntime();
  const on = one.provider === here.provider && one.model === here.model;
  const meta = [aside, one.context, one.thinking ? "thinks" : "", one.images ? "images" : ""].filter(Boolean).join(" · ");
  return pickRow(one.model, meta, on, () => void chooseRuntime("model", one));
}

/** A pattern pi holds that this machine has no model for: said in the list, never passed over. */
function problemRows() {
  return (catalog?.problems ?? []).map((pattern) => pickNote(`pi: “${pattern}” matched no model here`));
}

/**
 * The row that swaps the picker between pi's scope and the whole catalogue. It is the only place the
 * choice lives, so the list has one way in and one way out; the browser remembers which you chose.
 */
function revealRow(towardsAll, position) {
  const count = (catalog?.models ?? []).length;
  const row = el("button", `pick-row pick-more ${position}`);
  row.type = "button";
  const name = el("span");
  name.textContent = towardsAll ? `all ${count} models` : "scoped only";
  row.appendChild(name);
  row.title = towardsAll ? "every model this machine can run" : "back to the models pi cycles";
  row.addEventListener("click", () => {
    showAllModels = towardsAll;
    localStorage.setItem(SHOW_ALL_KEY, showAllModels ? "1" : "0");
    drawModels(runtimeSearch.value);
    placeRuntimePick();
  });
  return row;
}

function drawModels(query) {
  const needle = query.trim().toLowerCase();
  const here = pickRuntime();
  const all = catalog?.models ?? [];
  // What pi cycles, from `enabledModels` in its settings: the one list the human edits with
  // /scoped-models, so nothing here is stored a second time.
  const scoped = catalog?.scoped ?? [];
  const rows = [];
  if (catalogStale) rows.push(pickNote(catalogStale));
  // A search is a question about one model, so it asks the whole catalogue whatever the row below
  // says. The scope decides what browsing starts from, not what can be found.
  if (scoped.length && !showAllModels && !needle) {
    const head = pickHead("scoped");
    // What pi holds, in pi's own words, so a scope of one word is still readable as a scope.
    if (catalog?.scope?.length) head.title = `pi cycles: ${catalog.scope.join(", ")}`;
    rows.push(head);
    // The model this card answers with keeps its row here even when pi's scope no longer names it:
    // a thread that is running stays the thread that answers.
    const held = all.find((one) => one.provider === here.provider && one.model === here.model);
    const named = scoped.some((one) => one.provider === here.provider && one.model === here.model);
    if (held && !named) rows.push(modelRow(held, `not scoped · ${held.provider}`));
    // A scope has one heading, so each row names the provider itself: two twins read the same without it.
    for (const one of scoped) rows.push(modelRow(one, one.provider));
    rows.push(...problemRows());
    rows.push(revealRow(true, "last"));
    runtimeList.replaceChildren(...rows);
    return;
  }
  if (needle) {
    const hits = all.filter((one) => one.model.toLowerCase().includes(needle) || one.provider.toLowerCase().includes(needle));
    if (hits.length) rows.push(pickHead(hits.length > 200 ? `matches · first 200 of ${hits.length}` : "matches"));
    for (const one of hits.slice(0, 200)) rows.push(modelRow(one, one.provider));
  } else {
    // The whole catalogue, asked for by name, so it is all of it; every row is cheap and the panel scrolls.
    if (scoped.length) rows.push(revealRow(false, "first"));
    // Said here too: a scope that resolved to nothing is the case where this is the only list on screen.
    rows.push(...problemRows());
    let group = "";
    for (const one of all) {
      if (one.provider !== group) {
        group = one.provider;
        rows.push(pickHead(group));
      }
      rows.push(modelRow(one, ""));
    }
  }
  runtimeList.replaceChildren(...(rows.length ? rows : [pickNote("no model matches")]));
}

/**
 * A tool with its state on the right. A click flips it and the list redraws where it stands.
 * The word carries the state and the muted row backs it up: a list of twelve tools where eight are
 * on must not read as twelve accents.
 */
function toolRow(name, on, onClick) {
  const row = pickRow(name, on ? "on" : "off", false, onClick);
  row.classList.toggle("tool-off", !on);
  row.setAttribute("aria-pressed", on ? "true" : "false");
  row.title = on ? `${name} is given to a new thread` : `${name} is kept from a new thread`;
  return row;
}

/**
 * The tools a new thread gets: pi's own four, then one row per extension folder. Each list carries a
 * row that turns the whole group on or off, because a pass over the list usually starts there.
 */
function drawTools(query) {
  if (!toolCatalogue) {
    runtimeList.replaceChildren(
      pickNote(toolsTrouble ? `the tool list is unavailable: ${toolsTrouble}` : "asking the daemon for its tools…"),
    );
    return;
  }
  const needle = query.trim().toLowerCase();
  const toolsOff = boardConfig.toolsOff ?? [];
  const extensionsOff = boardConfig.extensionsOff ?? [];
  const builtin = toolCatalogue.builtin ?? [];
  const extensions = (toolCatalogue.extensions ?? []).map((one) => one.name);
  const rows = [];
  const matches = (name) => !needle || name.toLowerCase().includes(needle);
  const group = (head, names, off, patchFor) => {
    const shown = names.filter(matches);
    if (!shown.length) return;
    rows.push(pickHead(`${head} · ${names.length - off.length} of ${names.length} on`));
    rows.push(
      pickRow("all of them", off.length ? "turn on" : "turn off", false, () => void setTools(patchFor(off.length ? [] : [...names]))),
    );
    for (const name of shown) {
      const on = !off.includes(name);
      // A click flips the row: one that is on joins the list of tools this board keeps out, and one
      // that is off leaves it.
      const next = on ? [...off, name] : off.filter((one) => one !== name);
      rows.push(toolRow(name, on, () => void setTools(patchFor(next))));
    }
  };
  group("built-in", builtin, toolsOff, (list) => ({ toolsOff: list }));
  group("extensions", extensions, extensionsOff, (list) => ({ extensionsOff: list }));
  if (!extensions.length) rows.push(pickNote("no extensions installed beside the board's own bridge"));
  runtimeList.replaceChildren(...(rows.length ? rows : [pickNote("no tool matches")]));
}

/**
 * One change to the board's tool switches. The list redraws where it stands rather than closing,
 * because choosing tools is a pass over several rows and not a single pick.
 */
async function setTools(patch) {
  try {
    const response = await fetch(`/config?${auth}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!response.ok) throw new Error((await response.text()).slice(0, 80) || response.statusText);
    applyConfig((await response.json()).config);
    drawTools(runtimeSearch.value);
    placeRuntimePick();
  } catch (error) {
    hintLine(`could not change it: ${error.message || error}`, true);
  }
}

function drawLevels() {
  const here = pickRuntime();
  const chosen = (catalog?.models ?? []).find((one) => one.provider === here.provider && one.model === here.model);
  // Pi clamps whatever it is given, so a model without reasoning only offers being off.
  const levels = chosen && chosen.thinking === false ? ["off"] : (catalog?.levels ?? []);
  // No level is stored until one is chosen, and that means pi's own default, which reads as off.
  const current = here.thinking || "off";
  const rows = levels.map((level) => pickRow(level, "", level === current, () => void chooseRuntime("thinking", level)));
  if (chosen && chosen.thinking === false) rows.push(pickNote(`${shortModel(here.model)} does not think`));
  runtimeList.replaceChildren(...(rows.length ? rows : [pickNote("no level to choose")]));
}

/** Stop one thread from its section, and kill it if the stop does not land. */
function stopThread(threadId) {
  const held = threadFacts.get(threadId);
  if (!held) return;
  const kill = stopping.has(threadId);
  if (kill) stopping.delete(threadId);
  else stopping.add(threadId);
  void fetch(`/${kill ? "kill" : "stop"}?${auth}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cardId: held.cardId }),
  });
}

async function openPick(which, anchor = null, forBoard = false, inst = null) {
  if (picking === which && pickBoard === forBoard && pickInst === inst) {
    closePick();
    return;
  }
  picking = which;
  pickAnchor = anchor;
  pickBoard = forBoard;
  // A list opened from a field edits that field's thread; one opened from the settings panel edits the
  // board's defaults, and belongs to nobody's card.
  pickInst = forBoard ? null : inst;
  runtimePick.hidden = false;
  // A mode, a flow, how a child's work comes back and the two card settings are short lists this page
  // already holds, so they open at once and the search box has nothing to search: no request, no waiting.
  if (
    which === "mode" ||
    which === "path" ||
    which === "childIntegration" ||
    which === "verbosity" ||
    which === "audience" ||
    which in CARD_LEVEL_KEYS
  ) {
    runtimeSearch.hidden = true;
    if (which === "mode") drawModePick();
    else if (which === "path") drawPathPick();
    else if (which === "childIntegration") drawChildIntegrationPick();
    else drawCardPick(which);
    placeRuntimePick();
    return;
  }
  runtimeSearch.hidden = which === "thinking";
  runtimeSearch.placeholder = which === "tools" ? "search tools…" : "search models…";
  // The tools are a question of their own, so they are asked for on their own: pi's four names and
  // this machine's extension folders, in one cheap request.
  if (which === "tools") {
    runtimeSearch.value = "";
    runtimeList.replaceChildren(
      pickNote(toolsTrouble ? `the tool list is unavailable: ${toolsTrouble}` : "asking the daemon for its tools…"),
    );
    await loadTools();
    if (picking !== "tools") return; // closed while the list was loading
    drawTools("");
    placeRuntimePick();
    runtimeSearch.focus();
    return;
  }
  runtimeList.replaceChildren(pickNote("reading what this machine has…"));
  // Read on every open, not once per page: the scope is pi's, and the human edits it in a console pi
  // while this tab is open. The catalogue behind it is cached by the daemon, so this is one cheap
  // request. A failed read keeps what the panel already had, because an old list beats an empty one.
  try {
    const response = await fetch(`/models?${auth}`);
    if (!response.ok) throw new Error("the daemon would not list models");
    catalog = await response.json();
    catalogStale = "";
  } catch (error) {
    if (!catalog) {
      runtimeList.replaceChildren(pickNote(error.message || "could not read the models"));
      return;
    }
    // An old list beats an empty panel, but not silently: the scope on screen may not be pi's any more.
    catalogStale = `could not reread pi's scope: ${error.message || error}`;
  }
  if (picking !== which) return; // closed while the catalog was loading
  if (which === "model") {
    runtimeSearch.value = "";
    drawModels("");
    runtimeSearch.focus();
  } else {
    drawLevels();
  }
  placeRuntimePick();
}

/** Hand the choice to the daemon: the thread behind one card, or the default for a new one. */
async function chooseRuntime(kind, value) {
  const body = kind === "model" ? { provider: value.provider, model: value.model } : { level: value };
  // A field's own card is what the daemon resolves to a thread. Editing the board's defaults from the
  // settings panel sends no card, which is what makes it the default.
  const target = pickBoard ? null : cardOf(pickInst);
  if (target) body.cardId = target.id;
  try {
    const response = await fetch(`/${kind === "model" ? "model" : "thinking"}?${auth}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error((await response.text()).slice(0, 80) || response.statusText);
    const payload = await response.json();
    if (payload.config) boardConfig = { ...boardConfig, ...payload.config };
    hintLine(kind === "model" ? `model: ${shortModel(value.model)}` : `thinking: ${value}`, false, pickInst);
    closePick();
    paintRuntime();
  } catch (error) {
    hintLine(`could not set it: ${error.message || error}`, true);
  }
}

/** The flow a new boss starts on, written on the board rather than on a thread. */
async function setBoardPath(path) {
  try {
    const response = await fetch(`/config?${auth}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (!response.ok) throw new Error((await response.text()).slice(0, 80) || response.statusText);
    const payload = await response.json();
    if (payload.config) applyConfig(payload.config);
    paintConfig();
  } catch (error) {
    hintLine(`could not set it: ${error.message || error}`, true);
  }
}

/** What each mode and flow is, in the words the picker shows beside the name. */
const MODE_HINTS = [
  ["agent", "does the work itself"],
  ["plan", "a plan and /tmp checks, no edits"],
  ["boss", "spawns children, does no work"],
];
const PATH_HINTS = [
  ["auto", "the boss picks, and says which"],
  ["simple", "one step with checks"],
  ["advanced", "a plan, a review that reads it"],
  ["complex", "triage, parallel scouts, re-review"],
];

/** How often a card is written, and who it is written for, in the words the picker shows. */
const VERBOSITY_HINTS = [
  ["quiet", "a card only when you ask"],
  ["normal", "a card for something to see"],
  ["verbose", "a card for every finding"],
];
const AUDIENCE_HINTS = [
  ["programmer", "the fact, no walkthrough"],
  ["data-analyst", "tables, units, counts"],
  ["designer", "screens, states, spacing"],
  ["vibecoder", "plain words, no code"],
  ["junior", "one idea, jargon defined"],
  ["mathematician", "notation, defined symbols"],
];
/** The three levels every content switch has, and what each one asks of a card. */
const LEVEL_HINTS = [
  ["none", "not on a card unless you ask"],
  ["some", "where it carries the point"],
  ["many", "as much as it takes"],
];
/** How a child's commits reach the branch it was cut from, in the words the picker shows. */
const CHILD_INTEGRATION_HINTS = [
  ["merge", "keeps the merge in the history"],
  ["cherry-pick", "lifts the commits across"],
  ["rebase", "replays them"],
];
/** The four switches, by the id their pick list is opened with. */
const CARD_LEVEL_KEYS = {
  code: "showCodeFragments",
  math: "showMathFormulas",
  charts: "showCharts",
  refs: "showReferences",
};

/** The two lists are local, so the panel draws them without asking the daemon for anything. */
function drawModePick() {
  const { mode } = modeShown();
  runtimeList.replaceChildren(
    pickHead("what this thread is for"),
    ...MODE_HINTS.map(([name, hint]) => pickRow(name, hint, mode === name, () => void pickMode(name))),
  );
}

function drawPathPick() {
  const path = pickBoard ? boardConfig.path || "auto" : modeShown().path;
  runtimeList.replaceChildren(
    pickHead(pickBoard ? "the flow a new boss starts on" : "the flow a boss runs"),
    ...PATH_HINTS.map(([name, hint]) => pickRow(name, hint, path === name, () => void pickPath(name))),
  );
}

/** How a child's work comes back: three ways, each one a line of what it does to the history. */
function drawChildIntegrationPick() {
  const now = boardConfig.childIntegration || "merge";
  runtimeList.replaceChildren(
    pickHead("how a child's work comes back"),
    ...CHILD_INTEGRATION_HINTS.map(([name, hint]) => pickRow(name, hint, now === name, () => void pickChildIntegration(name))),
  );
}

/** How often, who for, and how much of each thing: the six card settings, one list each. */
function drawCardPick(which) {
  const list = which === "verbosity" ? VERBOSITY_HINTS : which === "audience" ? AUDIENCE_HINTS : LEVEL_HINTS;
  const now = cardValue(which);
  const head =
    which === "verbosity"
      ? "how often a thread opens a card"
      : which === "audience"
        ? "who the cards are written for"
        : `${which}: how much of it a card carries`;
  runtimeList.replaceChildren(
    pickHead(head),
    ...list.map(([name, hint]) => pickRow(name, hint, now === name, () => void pickCard(which, name))),
  );
}

/** What the board holds for one of the six, as the pick list and the panel read it. */
function cardValue(which) {
  if (which === "verbosity") return boardConfig.cardsVerbosity || "normal";
  if (which === "audience") return boardConfig.cardsAudience || "programmer";
  return boardConfig[CARD_LEVEL_KEYS[which]] || "some";
}

/** One change to this board's settings, whatever it is: the daemon answers with the whole config. */
async function patchConfig(body) {
  try {
    const response = await fetch(`/config?${auth}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error((await response.text()).slice(0, 80) || response.statusText);
    const payload = await response.json();
    if (payload.config) applyConfig(payload.config);
    paintConfig();
    return true;
  } catch (error) {
    hintLine(`could not change it: ${error.message || error}`, true);
    return false;
  }
}

async function pickCard(which, value) {
  const key = which === "verbosity" ? "cardsVerbosity" : which === "audience" ? "cardsAudience" : CARD_LEVEL_KEYS[which];
  if (await patchConfig({ [key]: value })) hintLine(`${which}: ${value}`);
  closePick();
}

/** How a child's work lands, written on the board the way a card setting is. */
async function pickChildIntegration(value) {
  if (await patchConfig({ childIntegration: value })) hintLine(`a child's work comes back by: ${value}`);
  closePick();
}

/**
 * A mode or a flow chosen from the list. Opened from a field it is written on that field's thread; with
 * no card behind the field it is what the next thread is born with, which is what the bottom bar is for.
 */
async function pickMode(mode) {
  const target = cardOf(pickInst);
  if (target) await chooseMode(mode, target.id);
  else modeNext = mode;
  if (mode !== "boss") pathNext = "";
  closePick();
  paintMode();
  hintLine(`mode: ${mode}`);
}

async function pickPath(path) {
  const target = cardOf(pickInst);
  if (pickBoard) await setBoardPath(path);
  else if (target) await choosePath(path, target.id);
  else pathNext = path === "auto" ? "" : path;
  closePick();
  paintMode();
  hintLine(`path: ${path}`);
}

/** Writes the mode on one thread, or leaves it as the next thread's. */
async function chooseMode(mode, cardId) {
  if (!cardId) return;
  await postThreadField("/mode", { cardId, mode });
}

async function choosePath(path, cardId) {
  if (!cardId) return;
  await postThreadField("/thread/path", { cardId, path });
}

async function postThreadField(route, body) {
  try {
    const response = await fetch(`${route}?${auth}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error((await response.text()).slice(0, 80) || response.statusText);
    const payload = await response.json();
    if (payload.card) applyMessage(payload.card);
  } catch (error) {
    hintLine(`could not set it: ${error.message || error}`, true);
  }
}

// ---------- this board's settings ------------------------------------------
// The panel has no rows of its own any more: it is a tree drawn from the document `/settings/board`
// serves, so a setting the daemon gains is a setting this panel shows.
const configBtn = document.getElementById("configBtn");
const configPanel = document.getElementById("boardConfig");
const cfgTree = document.getElementById("cfgTree");
// The document the panel is drawn from, and what was drawn from it: every leaf in document order, and
// every group with the leaves under it, so a config that arrives repaints all of them.
let boardDoc = null;
let treeLeaves = [];
let treeGroups = [];
const pePanel = document.getElementById("promptEditor");
const pePick = document.getElementById("pePick");
const peText = document.getElementById("peText");
const peHint = document.getElementById("peHint");
const peSave = document.getElementById("peSave");

/**
 * The tools a thread can be given, as the daemon sees them: pi's own four by name, and the extension
 * folders installed on this machine. Read on the first open of the list and kept, because only a
 * daemon restart with a new extension installed changes the answer.
 */
let toolCatalogue = null;
let toolsTrouble = "";

async function loadTools() {
  if (toolCatalogue || toolsTrouble) return toolCatalogue;
  try {
    const response = await fetch(`/tools?${auth}`);
    if (!response.ok) throw new Error((await response.text()).slice(0, 80) || response.statusText);
    toolCatalogue = await response.json();
  } catch (error) {
    toolsTrouble = error.message || String(error);
  }
  return toolCatalogue;
}

/** The daemon's copy of the configuration is the truth; whatever arrives is what the panel shows. */
function applyConfig(config) {
  if (!config || !config.model) return;
  boardConfig = { ...boardConfig, ...config };
  paintRuntime();
  paintFocus();
}

/**
 * Every leaf and every folded sum, from the settings the board holds. A setting whose config key is the
 * one its write template fills is read off the config; anything else keeps what the document said, so a
 * config that arrives repaints the tree without a request.
 */
function paintConfig() {
  for (const leaf of treeLeaves) {
    const shown = configValue(leaf.field);
    if (shown !== undefined) leaf.field.value = shown;
  }
  paintTree();
}

function shownConfig(on) {
  configPanel.hidden = !on;
  configBtn.setAttribute("aria-expanded", on ? "true" : "false");
  // The prompt editor was opened from this panel and belongs to it, so it leaves when the panel does.
  if (!on) pePanel.hidden = true;
}

// ---------- the settings tree ---------------------------------------------
// One walk over the document, and a leaf that says what it is: a `toggle` writes the flip of what it
// holds, a `prompt` opens the file, and anything with a `pick` opens the picker of that name, which
// posts the choice itself. Nothing here knows a setting by name.

/** Where this board keeps which groups it has folded. Two boards keep two shapes. */
function foldKey() {
  return `pi-studio.board.collapsed.v1.${workspace}`;
}

/** The folded shape the human left, by dotted group path; a group nobody has touched is absent. */
function foldsRead() {
  try {
    const held = JSON.parse(localStorage.getItem(foldKey()) || "{}");
    return held && typeof held === "object" && !Array.isArray(held) ? held : {};
  } catch {
    return {};
  }
}

/** Whether a group opens: the shape the human left, else the document's own default. */
function foldOpen(path, group) {
  const held = foldsRead()[path];
  return typeof held === "boolean" ? held : group.open !== false;
}

/** One group folded or unfolded, remembered for this board alone. */
function foldRemember(path, open) {
  const held = foldsRead();
  held[path] = open;
  try {
    localStorage.setItem(foldKey(), JSON.stringify(held));
  } catch {}
}

/**
 * The panel is drawn from the daemon's document, so it is read on every open: the same page serves every
 * board, and a setting added to the daemon shows up here without a reload.
 */
async function loadBoardSettings() {
  try {
    const response = await fetch(`/settings/board?${auth}`);
    if (!response.ok) throw new Error((await response.text()).slice(0, 80) || response.statusText);
    boardDoc = await response.json();
    renderTree(boardDoc);
  } catch (error) {
    boardDoc = null;
    treeLeaves = [];
    treeGroups = [];
    const line = el("p", "cfg-failure");
    line.textContent = `could not read this board's settings: ${error.message || error}`;
    cfgTree.replaceChildren(line);
  }
}

/** A write has landed and the panel is on screen, so the document behind it is read again. */
function refreshSettings() {
  if (configPanel.hidden) return;
  void loadBoardSettings();
}

/** The whole panel: what the board is, the groups, and the one line under them. */
function renderTree(doc) {
  treeLeaves = [];
  treeGroups = [];
  const nodes = [];
  if (doc.title) {
    const head = el("p", "cfg-head");
    head.textContent = doc.title;
    nodes.push(head);
  }
  if (doc.subtitle) {
    const sub = el("p", "cfg-sub");
    sub.textContent = doc.subtitle;
    nodes.push(sub);
  }
  for (const group of doc.groups ?? []) nodes.push(renderGroup(group, "").fold);
  if (doc.foot) {
    const foot = el("p", "cfg-note");
    foot.textContent = doc.foot;
    nodes.push(foot);
  }
  cfgTree.replaceChildren(...nodes);
  paintConfig();
}

/** One group: a `<details>` whose leaves come first and whose own groups follow, to any depth. */
function renderGroup(group, parentPath) {
  const path = parentPath ? `${parentPath}.${group.id}` : group.id;
  const fold = el("details", "cfg-group");
  fold.open = foldOpen(path, group);
  fold.title = group.help ?? "";
  const summary = document.createElement("summary");
  const label = el("span");
  label.textContent = group.label ?? group.id;
  const preview = el("span", "cfg-preview");
  summary.append(label, preview);
  const kids = el("div", "cfg-kids");
  const mine = [];
  for (const field of group.fields ?? []) {
    const leaf = renderLeaf(field);
    kids.append(leaf.row);
    mine.push(leaf);
  }
  for (const child of group.groups ?? []) {
    const drawn = renderGroup(child, path);
    kids.append(drawn.fold);
    mine.push(...drawn.leaves);
  }
  fold.append(summary, kids);
  fold.addEventListener("toggle", () => foldRemember(path, fold.open));
  treeGroups.push({ preview, leaves: mine });
  return { fold, leaves: mine };
}

/** One leaf: a label, its value, and the click that changes it. */
function renderLeaf(field) {
  const row = el("button", "cfg-row");
  row.type = "button";
  row.title = field.help ?? "";
  const label = el("span");
  label.textContent = field.label ?? field.id;
  const value = el("b");
  row.append(label, value);
  row.addEventListener("click", () => void openLeaf(field, row));
  const leaf = { field, row, value };
  treeLeaves.push(leaf);
  return leaf;
}

/** What a leaf says on its right: a yes or a no, how much is off, or the value itself. */
function leafShown(field) {
  if (field.type === "toggle") return field.value === true ? "on" : "off";
  if (field.type === "list") {
    const off = Array.isArray(field.value) ? field.value.length : 0;
    return off ? `${off} off` : "all on";
  }
  if (field.type === "prompt") return "";
  const text = String(field.value ?? "");
  return text ? shortModel(text) : "";
}

/**
 * What one leaf says in a folded group: its label and then its value, because a value alone — an `on`, a
 * `some` — says nothing about what it is the value of. A leaf with nothing to show is its label alone.
 */
function leafLine(leaf) {
  const label = leaf.field.label ?? leaf.field.id;
  const shown = leafShown(leaf.field);
  return shown ? `${label} ${shown}` : label;
}

/** What a folded group says: its leaves in order, or how many files when they are all prompt files. */
function groupPreview(leaves) {
  if (!leaves.length) return "";
  if (leaves.every((leaf) => leaf.field.type === "prompt")) {
    return `${leaves.length} file${leaves.length === 1 ? "" : "s"}`;
  }
  return leaves.map(leafLine).join(" · ");
}

/**
 * What the board's config says a leaf is worth, read from the template the field writes rather than
 * from its name: the keys the template fills are the keys the config answers in, and the two halves of
 * a split value come back joined with the same split. A setting the config names otherwise (a picker's
 * route answers `thinking` for the `level` it is given) is left to the reread that follows a write.
 */
function configValue(field) {
  const body = field.write?.body;
  if (!body || typeof body !== "object") return undefined;
  const keysFilledWith = (token) => Object.keys(body).filter((key) => body[key] === token);
  const whole = keysFilledWith("@value");
  if (field.type === "list") {
    // A list of names can arrive split over two keys, the built-in tools and the extensions, and the
    // row counts what is off in both.
    const held = whole.map((key) => boardConfig[key]).filter(Array.isArray);
    return held.length === whole.length && whole.length ? held.flat() : undefined;
  }
  if (whole.length) {
    const [key] = whole;
    if (!(key in boardConfig)) return undefined;
    if (field.type === "toggle") return boardConfig[key] !== false;
    const text = String(boardConfig[key] ?? "");
    return text ? text : undefined;
  }
  const [head] = keysFilledWith("@head");
  const [rest] = keysFilledWith("@rest");
  if (!head || !rest || !boardConfig[head] || !boardConfig[rest]) return undefined;
  return `${boardConfig[head]}${field.split ?? "/"}${boardConfig[rest]}`;
}

/** The values on every row, and the sum on every folded group. */
function paintTree() {
  for (const leaf of treeLeaves) leaf.value.textContent = leafShown(leaf.field);
  for (const group of treeGroups) group.preview.textContent = groupPreview(group.leaves);
}

/**
 * One leaf written through the route the document names, with the template it carries: `@value` is the
 * control's own value, `@head` and `@rest` are the halves of `split` at the first separator, and any
 * other string is a literal the daemon expects (a prompt name, say).
 */
async function writeLeaf(field, value) {
  const write = field.write;
  if (!write?.route) return null;
  const split = field.split ?? "/";
  const text = String(value ?? "");
  const at = text.indexOf(split);
  const head = at < 0 ? text : text.slice(0, at);
  const rest = at < 0 ? "" : text.slice(at + split.length);
  const body = {};
  for (const [key, slot] of Object.entries(write.body ?? {})) {
    body[key] = slot === "@value" ? value : slot === "@head" ? head : slot === "@rest" ? rest : slot;
  }
  try {
    const response = await fetch(`${write.route}?${auth}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error((await response.text()).slice(0, 80) || response.statusText);
    const payload = await response.json();
    if (payload.config) applyConfig(payload.config);
    // The row says what it wrote at once; the daemon's frame then rereads the document, which is the
    // whole truth about this setting.
    field.value = value;
    paintConfig();
    return payload;
  } catch (error) {
    hintLine(`could not change it: ${error.message || error}`, true);
    return null;
  }
}

/** A leaf pressed: flip a switch, open a file, or hand the work to the picker that names it. */
async function openLeaf(field, row) {
  if (field.type === "toggle") {
    await writeLeaf(field, field.value !== true);
    return;
  }
  if (field.type === "prompt") {
    pePanel.hidden = false;
    try {
      await loadPrompts();
      await openPrompt(field.file ?? field.value);
    } catch (error) {
      peHint.textContent = `could not read it: ${error.message || error}`;
    }
    return;
  }
  // Every picker here writes the board's default itself and broadcasts the config that follows, so the
  // choice is never posted twice.
  if (field.pick) await openPick(field.pick, row, true);
}

// ---------- clean and new ------------------------------------------------
// Cleaning is safe, so it happens on the click. Starting over throws away every card, so the same
// button turns into a question and the second click is the answer.
const cleanBtn = document.getElementById("cleanBtn");
const newBtn = document.getElementById("newBtn");
let newArmed = 0;

async function postBoardAction(path) {
  try {
    const response = await fetch(`/${path}?${auth}`, { method: "POST" });
    if (!response.ok) throw new Error((await response.text()).slice(0, 80) || response.statusText);
    return await response.json();
  } catch (error) {
    hintLine(`could not ${path === "new" ? "start over" : "clean"}: ${error.message || error}`, true);
    return null;
  }
}

// ---------- the clean summary ---------------------------------------------
// One clean can report a dozen worktrees, and the footer is one line: the whole answer opens in a sheet
// shaped like the row detail one, and the footer keeps only the receipt.
const cleanPanel = document.getElementById("cleanDetail");
const cleanPanelName = document.getElementById("cleanDetailName");
const cleanPanelMeta = document.getElementById("cleanDetailMeta");
const cleanPanelBody = document.getElementById("cleanDetailBody");
const cleanPanelClose = document.getElementById("cleanDetailClose");

/** A number and the word beside it, as the rest of the board words its counts. */
const counted = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The whole answer to a clean: one row per worktree that went, one per worktree the sweep would not
 * touch, then the threads and rail rows it forgot. A section with nothing in it is left out, so a clean
 * that took one worktree does not fill the sheet with empty headings.
 */
function openCleanSheet({ kept, removed, dead, rows }) {
  cleanPanelName.textContent = [
    removed.length ? `${counted(removed.length, "worktree")} removed` : "",
    kept.length ? `${kept.length} kept` : "",
  ]
    .filter(Boolean)
    .join(", ");
  cleanPanelMeta.textContent = [dead ? counted(dead, "dead thread") : "", rows ? counted(rows, "rail row") : ""]
    .filter(Boolean)
    .join(" · ");
  const parts = [];
  const add = (node) => {
    if (node) parts.push(node);
  };
  // What the sweep knows and the folder no longer shows: the ignored files that went with a tree, and a
  // branch git would not delete. Both are said in plain words, because the human may still want either
  // one back.
  add(
    panelBlock(
      "what went",
      panelFields(
        removed.map((tree) => {
          const beside = [
            tree.ignoredPaths ? counted(tree.ignoredPaths, "ignored file") : "",
            tree.branchKept ? "branch left behind" : "",
          ]
            .filter(Boolean)
            .join(", ");
          return [tree.branch || tree.path, beside || tree.note || "removed"];
        }),
      ),
    ),
  );
  // The reason is the sweep's own sentence, passed through as it came: the tree holds work, and only the
  // human can decide what happens to it.
  const stayed = panelFields(kept.map((tree) => [tree.branch || tree.path, tree.kept]));
  if (stayed) {
    const warning = el("div", "gone");
    warning.textContent = "these hold work only you can decide about";
    stayed.appendChild(warning);
    add(panelBlock("what stayed", stayed));
  }
  add(
    panelBlock(
      "the rest",
      panelFields([
        [dead ? "threads" : "", dead ? `${counted(dead, "dead thread")} forgotten` : ""],
        [rows ? "rows" : "", rows ? `${counted(rows, "rail row")} dropped` : ""],
      ]),
    ),
  );
  cleanPanelBody.replaceChildren(...parts);
  cleanPanel.hidden = false;
  // The sheet itself takes the focus, so a second Enter goes nowhere instead of closing what just
  // opened. Tab walks in from here.
  cleanPanel.focus();
}

function closeCleanSheet() {
  if (cleanPanel.hidden) return;
  cleanPanel.hidden = true;
  cleanPanelBody.replaceChildren();
  // Cleaning is a click on the clean button, so the focus goes back to it while the footer keeps the
  // receipt of what the click did.
  cleanBtn.focus();
}

cleanPanelClose.addEventListener("click", closeCleanSheet);
cleanPanel.addEventListener("click", (event) => {
  if (event.target === cleanPanel) closeCleanSheet();
});
cleanPanel.addEventListener("keydown", (event) => {
  // The sheet covers the board, so a board shortcut behind it would act on what is out of reach. The
  // key stops at the sheet, which saves every board handler its own check.
  event.stopPropagation();
  if (event.key === "Escape") {
    event.preventDefault();
    closeCleanSheet();
    return;
  }
  // The sheet holds the keyboard while it is open, so tab cannot walk the board behind it. Two stops are
  // inside: the close button and the body, and tab cycles between them both ways.
  if (event.key === "Tab") {
    event.preventDefault();
    const stops = [cleanPanelClose, cleanPanelBody];
    const at = stops.indexOf(document.activeElement);
    const step = event.shiftKey ? stops.length - 1 : 1;
    stops[at < 0 ? (event.shiftKey ? stops.length - 1 : 0) : (at + step) % stops.length].focus();
  }
});

cleanBtn.addEventListener("click", async () => {
  const result = await postBoardAction("clean");
  if (!result) return;
  // A tree the sweep would not touch is the one thing here that needs saying: it holds work, and
  // the human is the only one who can decide what happens to it.
  const kept = (result.trees ?? []).filter((tree) => tree.kept);
  const removed = (result.trees ?? []).filter((tree) => tree.removed);
  const dead = (result.removed ?? []).length;
  const rows = Number(result.rows) || 0;
  if (!removed.length && !kept.length && !dead) {
    footNote("nothing to clean");
    return;
  }
  openCleanSheet({ kept, removed, dead, rows });
  // The sheet covers the board, so the footer keeps the receipt alone: what the click did, in one
  // clause short enough for a strip that shares its line with the board's own figures.
  const went = [removed.length ? counted(removed.length, "worktree") : "", dead ? counted(dead, "thread") : ""].filter(Boolean);
  footNote(went.length ? `cleaned ${went.join(" and ")}` : `${counted(kept.length, "worktree")} kept`);
});

newBtn.addEventListener("click", async () => {
  const now = Date.now();
  if (now - newArmed > 4000) {
    newArmed = now;
    newBtn.textContent = "sure?";
    newBtn.classList.add("armed");
    setTimeout(() => {
      if (Date.now() - newArmed < 4000) return;
      newBtn.textContent = "new";
      newBtn.classList.remove("armed");
    }, 4200);
    return;
  }
  newArmed = 0;
  newBtn.textContent = "new";
  newBtn.classList.remove("armed");
  const result = await postBoardAction("new");
  if (!result) return;
  // The board arrives as a fresh snapshot, so there is nothing to clear here.
  hintLine("a new board in the same workspace");
});

configBtn.addEventListener("click", () => {
  closePick();
  const on = configPanel.hidden;
  shownConfig(on);
  if (!on) return;
  // A document already in hand is drawn at once, so the panel never opens blank; the read that follows
  // is what it settles on.
  if (boardDoc) renderTree(boardDoc);
  void loadBoardSettings();
});

// ---------- the prompt files ----------------------------------------------
// A role, a mode and a flow are markdown under `prompts/`. They are read when a thread starts, so an
// edit changes the next run and never rewrites one already going.
async function loadPrompts() {
  // Read afresh each time the editor opens: a file added to `prompts/` by hand is a prompt the human
  // should see without restarting the daemon.
  const response = await fetch(`/prompts?${auth}`);
  if (!response.ok) throw new Error((await response.text()).slice(0, 80) || response.statusText);
  const { prompts } = await response.json();
  pePick.replaceChildren(
    ...prompts.map((one) => {
      const option = document.createElement("option");
      option.value = one.name;
      option.textContent = `${one.kind} · ${one.title}`;
      return option;
    }),
  );
}

async function openPrompt(name) {
  const chosen = name || pePick.value;
  if (!chosen) return;
  const response = await fetch(`/prompt?${auth}&name=${encodeURIComponent(chosen)}`);
  if (!response.ok) throw new Error((await response.text()).slice(0, 80) || response.statusText);
  const { text } = await response.json();
  pePick.value = chosen;
  peText.value = text;
  peHint.textContent = chosen;
}

pePick.addEventListener("change", () => {
  void openPrompt(pePick.value).catch((error) => {
    peHint.textContent = `could not read it: ${error.message || error}`;
  });
});

peSave.addEventListener("click", async () => {
  try {
    const response = await fetch(`/prompt?${auth}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: pePick.value, text: peText.value }),
    });
    if (!response.ok) throw new Error((await response.text()).slice(0, 80) || response.statusText);
    peHint.textContent = `saved ${pePick.value} — the next thread reads it`;
  } catch (error) {
    peHint.textContent = `could not save it: ${error.message || error}`;
  }
});

runtimeSearch.addEventListener("input", () => (picking === "tools" ? drawTools(runtimeSearch.value) : drawModels(runtimeSearch.value)));
window.addEventListener("resize", () => {
  if (!runtimePick.hidden) placeRuntimePick();
});
document.addEventListener(
  "pointerdown",
  (event) => {
    // The prompt editor is opened from this panel and is part of it: a press inside it is not a press
    // outside the settings, which would otherwise shut the panel the editor was opened from.
    if (event.target.closest("#runtimePick, .composer, #boardConfig, #configBtn, #promptEditor")) return;
    if (!runtimePick.hidden) closePick();
    if (!configPanel.hidden) shownConfig(false);
  },
  true,
);
// The panels take Escape first, so closing one never sends the draft to the board instead.
document.addEventListener(
  "keydown",
  (event) => {
    if (event.key !== "Escape") return;
    if (!runtimePick.hidden) {
      event.stopPropagation();
      closePick();
      return;
    }
    if (configPanel.hidden) return;
    event.stopPropagation();
    shownConfig(false);
  },
  true,
);

// ---------- the crossroads -------------------------------------------------
// Choosing a workspace is not this page's job any more: it lives on `/`, in its own tab, so a board
// never has to be paused to pick another one. The header label goes back there.
document.getElementById("sess").addEventListener("click", () => {
  window.open(`/?token=${encodeURIComponent(token)}`, "pi-studio-crossroads");
});

// Images pasted into a field travel with its message, so a screenshot reaches the agent without
// leaving the board for the terminal.
function drawAttachments(inst = activeComposer) {
  if (!inst) return;
  inst.shots.replaceChildren();
  for (const [index, image] of inst.images.entries()) {
    const holder = el("div", "shot");
    const thumb = document.createElement("img");
    thumb.src = image.dataUrl;
    thumb.title = image.mimeType;
    const remove = el("button", "");
    remove.textContent = "×";
    remove.title = "remove";
    remove.addEventListener("click", () => {
      inst.images.splice(index, 1);
      drawAttachments(inst);
    });
    holder.append(thumb, remove);
    inst.shots.appendChild(holder);
  }
}

// A screenshot is several megabytes once base64 encoded, which is slow to push and slow to
// replay. Shrinking it to a size that still reads well keeps the message small.
const MAX_IMAGE_EDGE = 1568;
function shrinkImage(dataUrl, mimeType) {
  const original = { dataUrl, mimeType, data: dataUrl.slice(dataUrl.indexOf(",") + 1) };
  return new Promise((resolve) => {
    const image = new Image();
    image.addEventListener("load", () => {
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      if (Math.max(width, height) <= MAX_IMAGE_EDGE && dataUrl.length < 400_000) {
        resolve(original);
        return;
      }
      const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      const shrunk = canvas.toDataURL("image/jpeg", 0.85);
      resolve({ dataUrl: shrunk, mimeType: "image/jpeg", data: shrunk.slice(shrunk.indexOf(",") + 1) });
    });
    // Anything the browser cannot decode travels untouched rather than disappearing.
    image.addEventListener("error", () => resolve(original));
    image.src = dataUrl;
  });
}

// ---------- file picker --------------------------------------------------
// The agent works on paths, so the picker attaches paths: it lists a folder's names and never
// pulls file contents through the browser. Picking starts at the folder the board was opened on
// and walks anywhere the server can read, which is what the user asked for when attaching a file.
const picker = document.getElementById("picker");
const pickList = document.getElementById("pickList");
const pickPathInput = document.getElementById("pickPath");
const pickFilter = document.getElementById("pickFilter");
const pickHidden = document.getElementById("pickHidden");
const pickUp = document.getElementById("pickUp");
const pickCount = document.getElementById("pickCount");
const pickError = document.getElementById("pickError");
/**
 * The paths the open picker is attaching. They belong to the field it was opened from, and survive
 * walking to another folder, so one message can name files from several places.
 */
const pickPaths = () => activeComposer?.picked ?? new Map();
let pickerAt = "";
let listed = [];
/**
 * The folder this tab's board was opened on, from the last meta the daemon sent. A page with no
 * board behind it has none yet, and the listing then starts where the daemon itself stands.
 */
const boardFolder = () => boardMetaCache?.cwd || "";
let listedTotal = 0;
/**
 * The row the arrow keys are on, which the filter keeps the focus away from so typing works.
 * `-1` is no row: a fresh list starts unhighlighted, so Enter never attaches what the list
 * happened to open on.
 */
let pickAt = -1;
/** Every listing bumps this, so a slow reply cannot land on top of a newer one. */
let browseSeq = 0;
let filterTimer = 0;

/** `~` in place of the home folder keeps a chip short enough to read in a row. */
function shortenPath(path) {
  const home = picker.dataset.home || "";
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function drawChips(inst = activeComposer) {
  if (!inst) return;
  const held = inst.picked;
  inst.paths.replaceChildren();
  for (const [path, meta] of held) {
    const chip = el("div", meta.dir ? "chip folder" : "chip");
    chip.title = path;
    const label = el("span", "");
    label.textContent = shortenPath(path);
    const remove = el("button", "");
    remove.textContent = "×";
    remove.title = "remove";
    remove.addEventListener("click", () => {
      held.delete(path);
      drawChips(inst);
      drawList();
    });
    chip.append(label, remove);
    inst.paths.appendChild(chip);
  }
  const count = held.size;
  pickCount.textContent = count === 0 ? "nothing picked" : count === 1 ? "1 path" : `${count} paths`;
}

function drawList() {
  pickList.replaceChildren();
  if (listed.length === 0) {
    const hint = el("div", "p-empty");
    hint.textContent = pickFilter.value.trim() ? "nothing matches" : "empty folder";
    pickList.appendChild(hint);
    return;
  }
  const held = pickPaths();
  for (const entry of listed) {
    const isPicked = held.has(entry.path);
    // A real button, so the list can be walked with the keyboard: Enter or Space is a pick.
    const row = el("button", `p-item${entry.dir ? " dir" : ""}${isPicked ? " on" : ""}`);
    row.type = "button";
    row.title = entry.path;
    const tick = el("span", "p-tick");
    tick.textContent = isPicked ? "●" : "○";
    // The row's name is the file, so the glyph says nothing out loud and `aria-pressed` says it.
    tick.setAttribute("aria-hidden", "true");
    row.setAttribute("aria-pressed", String(isPicked));
    const name = el("span", "p-name");
    name.textContent = entry.name;
    row.append(tick, name);
    // A click picks; the chevron opens, because walking a tree and choosing in it are two acts.
    // A button cannot hold another button, so the chevron is decoration the row listens for.
    row.addEventListener("click", (event) => {
      if (event.target.classList.contains("p-open")) return void browse(entry.path);
      if (isPicked) held.delete(entry.path);
      else held.set(entry.path, { dir: entry.dir });
      drawList();
      drawChips();
    });
    if (entry.dir) {
      const open = el("span", "p-open");
      open.textContent = "›";
      open.title = "open this folder";
      // ArrowRight opens from the keyboard, so the glyph is not a second control to stop at.
      open.setAttribute("aria-hidden", "true");
      row.appendChild(open);
    }
    pickList.appendChild(row);
  }
  markHighlight();
  if (listedTotal > listed.length) {
    const note = el("div", "p-empty");
    note.textContent = `${listedTotal - listed.length} more — type in the filter to narrow it`;
    pickList.appendChild(note);
  }
}

/** Paint the row the arrows are on; the filter keeps the focus so typing keeps filtering. */
function markHighlight() {
  const rows = [...pickList.querySelectorAll(".p-item")];
  rows.forEach((row, at) => row.classList.toggle("hl", at === pickAt));
}

/** The list hangs off the composer's top edge, which is where the field is however the page moves. */
function placePicker() {
  // The list hangs off the field it was opened from, so a pick made in one card's field lands there.
  const box = (activeComposer?.root ?? composerHome).getBoundingClientRect();
  const width = Math.min(430, window.innerWidth - 28);
  picker.style.width = `${width}px`;
  const left = Math.min(Math.max(14, box.left + 14), window.innerWidth - width - 14);
  picker.style.left = `${left}px`;
  // Anchored by its bottom, so the list grows upward and never drifts across the field.
  picker.style.bottom = `${Math.max(14, window.innerHeight - box.top + 8)}px`;
}

async function browse(path, { focus = true } = {}) {
  const seq = (browseSeq += 1);
  pickError.hidden = true;
  try {
    // A caller that names no folder asks for the board's own, so the picker opens where the human
    // works. It is asked by path rather than by workspace id: this picker walks anywhere the server
    // can read, which is what attaching a file needs.
    const asked = path || boardFolder();
    const query = new URLSearchParams({ token, path: asked });
    if (pickHidden.checked) query.set("hidden", "1");
    const needle = pickFilter.value.trim();
    // Filtering happens on the server because the server is what caps how many names travel.
    if (needle) query.set("q", needle);
    const response = await fetch(`/browse?${query}`);
    if (seq !== browseSeq) return;
    if (!response.ok) throw new Error((await response.text()).slice(0, 120) || response.statusText);
    const data = await response.json();
    if (seq !== browseSeq) return;
    pickerAt = data.path;
    picker.dataset.home = data.home || "";
    pickPathInput.value = shortenPath(data.path);
    pickUp.disabled = data.parent === data.path;
    pickUp.dataset.parent = data.parent;
    listed = data.entries;
    listedTotal = data.total ?? data.entries.length;
    // A new folder starts the walk nowhere, so no row is armed until an arrow key moves.
    pickAt = -1;
    drawList();
    drawChips();
    picker.hidden = false;
    placePicker();
    // Typing a filter must not have its text selected out from under it, so only an
    // open or a deliberate move takes focus.
    if (focus) {
      pickFilter.focus();
      pickFilter.select();
    }
  } catch (error) {
    if (seq !== browseSeq) return;
    // The folder already open stays open: a typo in a path should not wipe the list.
    pickError.textContent = error.message || String(error);
    pickError.hidden = false;
    picker.hidden = false;
    placePicker();
  }
}

const closePicker = () => {
  // A keyboard user inside the list gets the keyboard back on the control that opened it; a
  // click elsewhere has already chosen its own target.
  const inside = !picker.hidden && picker.contains(document.activeElement);
  picker.hidden = true;
  // Whatever is still in flight belongs to a picker that is gone.
  browseSeq += 1;
  clearTimeout(filterTimer);
  // Picking files is rarely the end of the message, so a draft in hand takes the keyboard back.
  const back = activeComposer;
  if (!inside) return;
  if (back && back.msg.value.trim()) back.msg.focus();
  else if (back) back.filesBtn.focus();
};

document.getElementById("pickDone").addEventListener("click", closePicker);
document.getElementById("pickClose").addEventListener("click", closePicker);
document.getElementById("pickHere").addEventListener("click", () => {
  if (!pickerAt) return;
  const held = pickPaths();
  if (held.has(pickerAt)) held.delete(pickerAt);
  else held.set(pickerAt, { dir: true });
  drawList();
  drawChips();
});
pickUp.addEventListener("click", () => {
  if (pickUp.dataset.parent) void browse(pickUp.dataset.parent);
});
document.getElementById("pickHome").addEventListener("click", () => void browse("~"));
document.getElementById("pickCwd").addEventListener("click", () => void browse(""));
pickHidden.addEventListener("change", () => void browse(pickerAt, { focus: false }));
pickFilter.addEventListener("input", () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    if (!picker.hidden) void browse(pickerAt, { focus: false });
  }, 160);
});
// The whole overlay answers the keyboard, so Escape leaves from a row or the hidden box, not
// only from the two fields, and the arrows walk the list while the filter keeps the focus.
picker.addEventListener("keydown", (event) => {
  // The path field already took this keystroke (it browses what was typed).
  if (event.defaultPrevented) return;
  if (event.key === "Escape") {
    // The overlay takes Escape first, so leaving it does not also give up the board's selection
    // and the reply the field is holding.
    event.preventDefault();
    event.stopPropagation();
    closePicker();
    return;
  }
  const rows = [...pickList.querySelectorAll(".p-item")];
  const onRow = event.target.closest(".p-item");
  // Walking continues from the row the focus is on, which Tab can reach without the arrows.
  const from = onRow ? rows.indexOf(onRow) : pickAt;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (!listed.length) return;
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    pickAt = (from + step + listed.length) % listed.length;
    markHighlight();
    if (onRow) rows[pickAt]?.focus();
    rows[pickAt]?.scrollIntoView({ block: "nearest" });
    return;
  }
  if (event.key === "Enter" && !event.target.closest("button")) {
    // A row is a button, so Enter on one clicks it natively, and every other button in the
    // dialog keeps its own Enter; only a field hands the keystroke to the highlight.
    if (!rows[pickAt]) return;
    event.preventDefault();
    rows[pickAt].click();
    return;
  }
  // Right only opens a folder from a row, so it stays a caret move inside the fields.
  if (event.key === "ArrowRight" && onRow && listed[from] && listed[from].dir) {
    event.preventDefault();
    void browse(listed[from].path);
  }
});
pickPathInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  void browse(pickPathInput.value.trim() || "/");
});
window.addEventListener("resize", () => {
  if (!picker.hidden) placePicker();
});
// A click anywhere else puts the picker away, the same as closing it. The chip row is part of
// the composer's own furniture, so removing a pick is not a click on the board.
document.addEventListener(
  "pointerdown",
  (event) => {
    if (picker.hidden || event.target.closest("#picker, .composer")) return;
    closePicker();
  },
  true,
);

// ---------- the `@` list in a field ------------------------------------------
// Typing `@` at the start of a word opens the folder the token names, and a row takes the path
// into the text as the human typed it. One element serves every field: whatever `@` was last typed
// in owns it, and the board moves it there.
const atPick = document.getElementById("atPick");
const atList = document.getElementById("atList");
/** The field the list is serving, and the token under its caret: `{ start, end, dir, frag }`. */
let atInst = null;
let atToken = null;
let atRows = [];
let atAt = -1;
/** Every listing bumps this, so a slow reply cannot land on top of a newer one. */
let atSeq = 0;
/**
 * Where a dismissed list was typed. Escape and Enter shut the list and keep the text, and the token
 * under the caret is still the one they shut, so this is what stops the next keystroke reopening it.
 * A new `@` starts at another offset, or follows no token at all, which is how typing gets a list back.
 */
let atMute = null;

/**
 * The `@` token the caret sits in, or null. `@` counts only at the start of a word: `foo@bar` is an
 * address rather than a path, and the list has nothing to say about it.
 */
function atTokenAt(area) {
  const caret = area.selectionStart;
  if (caret !== area.selectionEnd) return null;
  // A caret inside a word is not at the end of the token the list would replace, and taking a row
  // from there would leave the rest of the word behind.
  if (caret < area.value.length && !/\s/.test(area.value[caret])) return null;
  const before = area.value.slice(0, caret);
  const match = /(^|\s)@(\S*)$/.exec(before);
  if (!match) return null;
  const body = match[2];
  const cut = body.lastIndexOf("/");
  return {
    start: caret - body.length - 1,
    end: caret,
    // What the human typed before the last slash, kept as typed so the row inserts that prefix.
    dir: cut < 0 ? "" : body.slice(0, cut + 1),
    frag: cut < 0 ? body : body.slice(cut + 1),
  };
}

/** The list hangs off the field's top edge, the same way the picker does, so it never covers the text. */
function placeAtPick() {
  if (!atInst) return;
  const box = atInst.root.getBoundingClientRect();
  const width = Math.min(430, window.innerWidth - 28);
  atPick.style.width = `${width}px`;
  const left = Math.min(Math.max(14, box.left + 14), window.innerWidth - width - 14);
  atPick.style.left = `${left}px`;
  atPick.style.bottom = `${Math.max(14, window.innerHeight - box.top + 8)}px`;
}

function closeAtPick() {
  atPick.hidden = true;
  // Whatever is still in flight belongs to a list that is gone.
  atSeq += 1;
  atList.replaceChildren();
  atInst = null;
  atToken = null;
  atRows = [];
  atAt = -1;
}

/** Paint the rows the last listing brought back, plus one muted row when a folder holds nothing. */
function drawAtPick() {
  atList.replaceChildren();
  if (atRows.length === 0) {
    const none = el("div", "p-empty");
    none.textContent = "no files";
    atList.appendChild(none);
    return;
  }
  atRows.forEach((entry, index) => {
    const row = el("button", `p-item${entry.dir ? " dir" : ""}`);
    row.type = "button";
    // The field keeps the keyboard, so a row is never a tab stop and never takes focus.
    row.tabIndex = -1;
    row.title = entry.path || entry.name;
    const name = el("span", "p-name");
    name.textContent = entry.dir ? `${entry.name}/` : entry.name;
    row.append(name);
    // On the press, not the click: taking the row must not first hand the selection to the button,
    // because the caret it replaces the text at is the one the field is holding.
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      takeAtRow(entry);
    });
    row.addEventListener("pointerenter", () => markAt(index));
    atList.appendChild(row);
  });
  markAt(atAt);
}

/** Paint the row the arrows are on without rebuilding the list under the pointer. */
function markAt(at) {
  atAt = at;
  [...atList.children].forEach((row, index) => row.classList.toggle("hl", index === at));
  atList.children[at]?.scrollIntoView({ block: "nearest" });
}

/** The listing for one token. A non-200 shuts the list and leaves what was typed alone. */
async function loadAtPick(tok) {
  const seq = (atSeq += 1);
  const query = new URLSearchParams({ token, path: tok.dir.replace(/\/+$/, "") });
  if (workspace) query.set("workspace", workspace);
  if (tok.frag) query.set("q", tok.frag);
  try {
    const response = await fetch(`/browse?${query}`);
    if (seq !== atSeq) return;
    if (!response.ok) return closeAtPick();
    const data = await response.json();
    if (seq !== atSeq) return;
    atRows = Array.isArray(data.entries) ? data.entries : [];
    drawAtPick();
  } catch {
    if (seq !== atSeq) return;
    closeAtPick();
  }
}

/** Show the list for the token under the field's caret, or shut it when there is no token. */
function openAtPick(inst, token) {
  atInst = inst;
  atToken = token;
  // The previous folder's rows go before the fetch, so Enter cannot take one while this listing is
  // still travelling. Nothing is armed until a reply lands, and Enter with no row shuts the list.
  atRows = [];
  atAt = -1;
  atList.replaceChildren();
  atPick.hidden = false;
  placeAtPick();
  void loadAtPick(token);
}

/** A keystroke in the field: the list follows the token, and a dismissed one stays shut. */
function typedInAtPick(inst) {
  const token = atTokenAt(inst.msg);
  if (!token) {
    atMute = null;
    if (atInst === inst) closeAtPick();
    return;
  }
  if (atMute && atMute.inst === inst && atMute.start === token.start) return;
  atMute = null;
  openAtPick(inst, token);
}

/**
 * Take one row into the text: a folder opens in the list, a file is named and the list closes. The
 * text is the path as the human typed it — the directory prefix plus the name — because that is
 * what the agent's own tools read from the workspace root.
 */
function takeAtRow(entry) {
  if (!atInst || !atToken) return;
  const inst = atInst;
  // The caret is the authority: a click in the text since the last keystroke moves it without a
  // keystroke, and a path written at a stale offset lands in the wrong place.
  const token = atTokenAt(inst.msg);
  if (!token || token.start !== atToken.start) return closeAtPick();
  if (entry.dir) {
    inst.msg.setRangeText(`@${token.dir}${entry.name}/`, token.start, token.end, "end");
    inst.msg.focus();
    // Drilling in is what the token now says, so the list follows the text it just wrote.
    const drilled = atTokenAt(inst.msg);
    if (drilled) openAtPick(inst, drilled);
    else closeAtPick();
    return;
  }
  inst.msg.setRangeText(`@${token.dir}${entry.name} `, token.start, token.end, "end");
  inst.msg.focus();
  // The space ends the token, so the next `@` is a new one and nothing reopens the list by itself.
  closeAtPick();
}

/**
 * The keys the open list owns. True means it took the keystroke, so the field does not send with it
 * and does not give the keyboard back.
 */
function atPickKey(inst, event) {
  if (atPick.hidden || atInst !== inst || !atToken) return false;
  const key = event.key;
  if (key === "ArrowDown" || key === "ArrowUp") {
    event.preventDefault();
    event.stopPropagation();
    if (atRows.length === 0) return true;
    const step = key === "ArrowDown" ? 1 : -1;
    const next = atAt < 0 ? (step > 0 ? 0 : atRows.length - 1) : (atAt + step + atRows.length) % atRows.length;
    markAt(next);
    return true;
  }
  if (key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    // The text stays as it is and the field keeps the keyboard: shutting a list is not leaving it.
    atMute = { inst, start: atToken.start };
    closeAtPick();
    return true;
  }
  if (key !== "Enter" && key !== "Tab") return false;
  event.preventDefault();
  event.stopPropagation();
  const taken = atRows[atAt < 0 ? 0 : atAt];
  if (taken) {
    takeAtRow(taken);
    return true;
  }
  // Nothing to take: the key shuts the list rather than sending a message that names no file.
  atMute = { inst, start: atToken.start };
  closeAtPick();
  return true;
}

window.addEventListener("resize", () => {
  if (!atPick.hidden) placeAtPick();
});

// ---------- sending ------------------------------------------------------
/** Paths travel as text, which the agent's own file tools read directly. */
function pickedPathsText() {
  const lines = [...pickPaths()].map(([path, meta]) => `${path}${meta.dir ? "/" : ""}`);
  return `Files and folders:\n${lines.join("\n")}`;
}

async function sendMessage(inst = activeComposer) {
  if (!inst || inst.send.disabled) return;
  // Enter fires again while the first send is in flight; a second body would carry a new id,
  // slip past the server's duplicate guard and deliver the message twice.
  const draft = inst.msg.value;
  const typed = draft.trim();
  if (!typed && inst.images.length === 0 && inst.picked.size === 0) return;
  const text = inst.picked.size === 0 ? typed : `${typed}${typed ? "\n\n" : ""}${pickedPathsText()}`;
  // What this message carries, so a pick or a keystroke made while it travels is still there.
  const sentPaths = [...inst.picked.keys()];
  const sentImages = [...inst.images];
  const sentNamed = [...inst.named];
  // A fork is the human's choice for this one send, and is asked on behalf of a card the message names:
  // it is answered in a card the board has not drawn yet, so the caret follows the new card when it arrives.
  const sentFork = inst.forkNext ? forkTarget(inst) : null;
  const card = cardOf(inst);
  inst.send.disabled = true;
  // Both attempts carry the same id, so a retry after a reset cannot deliver twice.
  const body = JSON.stringify({
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    // A fork is asked about the card it is forked from; anything else answers the field's own thread.
    cardId: sentFork ? sentFork.id : card?.id,
    // The cards the message names travel beside the one it answers, so the agent is told about each.
    refs: sentFork ? sentNamed.filter((id) => id !== sentFork.id) : sentNamed,
    fork: Boolean(sentFork) || undefined,
    text,
    mode: inst.sendMode,
    images: sentImages.map((image) => ({ data: image.data, mimeType: image.mimeType })),
  });
  try {
    let response;
    // A socket the browser thought was alive can be closed under it, which loses the
    // request silently. One retry turns that into a delivered message.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await fetch(`/message?${auth}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        break;
      } catch (error) {
        if (attempt === 1 || !(error instanceof TypeError)) throw error;
      }
    }
    if (!response.ok) throw new Error((await response.text()).slice(0, 80) || response.statusText);
    // Which thread answered: a fork is a new one, drawn as a card of its own, and the answer is read there.
    const made = sentFork ? await response.json().catch(() => null) : null;
    // Only what was sent leaves the field: a keystroke or a pick made while it travelled stays.
    if (inst.msg.value === draft) inst.msg.value = "";
    for (const image of sentImages) {
      const at = inst.images.indexOf(image);
      if (at >= 0) inst.images.splice(at, 1);
    }
    drawAttachments(inst);
    for (const path of sentPaths) inst.picked.delete(path);
    drawChips(inst);
    // The cards the message named were for that message, and the thread now holds what they said.
    inst.named = inst.named.filter((id) => !sentNamed.includes(id));
    paintRefs(inst);
    paintReferenceRings();
    closePicker();
    // The send button keeps the keyboard inside the field, so a list left open would float over the
    // field the send just emptied until the next keystroke, Enter or blur.
    closeAtPick();
    // A fork is one send's choice, so the next comment goes to the thread of the card again.
    inst.forkNext = false;
    if (made?.id) {
      // A fork answers in its own card, so the caret follows the answer instead of staying behind.
      focusThread(made.id);
    }
    // With no run in flight the message is being sent, not queued behind one.
    inst.hintEl.textContent = metaRunning !== true ? "sent" : inst.sendMode === "steer" ? "steered" : "queued";
    // The footer says where the message went when that is not simply this card: a fork is answered in a
    // new card, and a message about another card is worth naming.
    if (sentFork && made?.id) footNote(`a new thread answers ↳ ${cardName(sentFork)}`);
    else if (sentNamed.length === 1) footNote(`asked about ↳ ${cardName(byId.get(sentNamed[0]))}`);
  } catch (error) {
    const gone = error instanceof TypeError; // fetch rejects like this when nothing answers
    inst.hintEl.textContent = gone
      ? "board connection lost — reload the page"
      : `failed: ${error.message || error}`;
  } finally {
    inst.send.disabled = false;
  }
}

// ---------- threads -------------------------------------------------------
// A thread is a card with an agent behind it. The server creates it, and it arrives on the
// stream like any other card, so this waits for it rather than assuming it is already here.
const newThreadBtn = document.getElementById("newThread");

function focusThread(id) {
  let tries = 0;
  const wait = () => {
    const entry = byId.get(id);
    if (!entry) {
      // A card that never arrives is a dead board, not a slow one, so it stops asking.
      if (tries++ < 60) setTimeout(wait, 50);
      else console.error("pi-studio: the new thread never arrived");
      return;
    }
    centerOn(entry);
    // A new thread arrives with an empty field at its foot, so the caret goes there and the first
    // message is one keystroke away.
    focusComposer(composerOf(entry));
  };
  wait();
}

/**
 * The one way to start a thread, for the `+` and for `t`. The request is in flight while the button
 * is disabled, so a second press in either hand waits rather than creating a card nobody asked for.
 */
async function startThread() {
  if (newThreadBtn.disabled) return;
  newThreadBtn.disabled = true;
  try {
    const response = await fetch(`/thread?${auth}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // A new thread is born with the mode the composer is showing. A flow is named only when the human
      // picked one: otherwise the board's own default decides, which is what `/config` is for.
      body: JSON.stringify({ mode: modeNext, ...(modeNext === "boss" && pathNext ? { path: pathNext } : {}) }),
    });
    if (!response.ok) throw new Error((await response.text()).slice(0, 80) || response.statusText);
    const created = await response.json();
    if (created.threadId) focusThread(created.threadId);
  } catch (error) {
    console.error(`pi-studio: could not start a thread: ${error.message || error}`);
    hintLine(`could not start a thread: ${error.message || error}`, true);
  } finally {
    newThreadBtn.disabled = false;
  }
}

newThreadBtn.addEventListener("click", () => void startThread());

// Stop asks the server to abort the run, then waits for meta to confirm it settled.
stopBtn.addEventListener("click", async () => {
  stopBtn.disabled = true;
  stopBtn.textContent = "stopping…";
  try {
    await fetch(`/stop?${auth}`, { method: "POST" });
  } catch {
    stopBtn.disabled = false;
    stopBtn.textContent = "stop";
  }
});

/**
 * The sheet that is up, if one is: the activity detail and the clean receipt are dialogs drawn over the
 * board. A key press belongs to the sheet while it is open, and to nothing behind it.
 */
const openSheet = () => document.querySelector(".sheet:not([hidden])");

// The selection is a reading position, so Escape gives it up: the board stops dimming and the wheel
// goes back to moving the board. A panel or an editor takes Escape first and stops it there.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  // The `@` list is its own surface and takes Escape first, so shutting it does not also drop
  // the card being read.
  if (!atPick.hidden) return;
  // A click on the sheet's padding leaves the focus on the body, so the sheet's own handler never sees
  // the press: it is closed here, which also keeps it from giving up the card it hides.
  const sheet = openSheet();
  if (sheet) {
    event.preventDefault();
    if (sheet === actPanel) closeActPanel();
    else closeCleanSheet();
    return;
  }
  if (!document.querySelector(".card.active")) return;
  selectCard(null);
});

// `r` names the card you last clicked in a field, `p` pins it and `q` closes it. A field keeps its own
// keys, so a message being typed is never cut short.
document.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  if ((key !== "r" && key !== "q" && key !== "p") || event.metaKey || event.ctrlKey || event.altKey) return;
  if (typingSomewhere()) return;
  // The panel covers the board, so its closing key wins over the card it hides. The other sheet has no
  // closing key of its own, so every board key waits behind it.
  const sheet = openSheet();
  if (sheet) {
    if (key === "q" && sheet === actPanel) {
      event.preventDefault();
      closeActPanel();
    }
    return;
  }
  // The picker is its own surface: a board shortcut behind it would act on what is out of reach.
  if (!picker.hidden || !atPick.hidden) return;
  const active = document.querySelector(".card.active");
  const record = active ? byId.get(active.dataset.id) : null;
  if (!record) return;
  if (key === "q") {
    // The × is hidden on an open question, so the key does not go where the button cannot:
    // closing one would leave the agent waiting with nothing left to answer.
    if (questionWants(record.data)) return;
    event.preventDefault();
    closeCard(record);
    return;
  }
  event.preventDefault();
  if (key === "p") {
    // A pin is the human's alone, and a thread cannot close a pinned card: the same press takes it off.
    togglePin(record);
    return;
  }
  replyToCard(record);
});

// `ctrl+z` is the undo a close needs: the daemon holds the last cards a close removed, so one key puts
// back the one that went by mistake. A field keeps its own undo, so half-typed text is never replaced.
document.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() !== "z" || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
  if (typingSomewhere() || !atPick.hidden || openSheet()) return;
  event.preventDefault();
  undoClose();
});

// `1`–`6` answer the question the agent is waiting on, so a decision needs no mouse. A card of tabs
// answers inside the tab the human is reading, not the first one of five.
document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey || !/^[1-6]$/.test(event.key)) return;
  if (typingSomewhere()) return;
  if (openSheet() || !atPick.hidden) return;
  const record = openQuestion();
  if (!record) return;
  // The option buttons carry their own click handler, so this reuses the whole answer path.
  const shown = record.body.querySelector(".q-panel:not([hidden])") || record.body;
  const button = shown.querySelectorAll(".q-options .q-opt")[Number(event.key) - 1];
  if (!button || button.disabled) return;
  event.preventDefault();
  button.click();
});

// The board is drivable without a mouse: `f` frames it, `0` is real size, `m` the map, `n` is
// what is next. The composer keeps its plain letters, because a field the user is typing in is
// never read.
document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (typingSomewhere()) return;
  // The picker is its own surface: a board shortcut behind it would move what is out of reach.
  if (!picker.hidden || openSheet() || !atPick.hidden) return;
  if (event.key === "f") {
    event.preventDefault();
    fitAll();
  } else if (event.key === "0") {
    event.preventDefault();
    resetZoom();
  } else if (event.key === "m") {
    event.preventDefault();
    setMap(!mapOn);
  } else if (event.key === "n") {
    event.preventDefault();
    jumpToFresh();
  } else if (event.key === "o") {
    event.preventDefault();
    flipOrder();
  } else if (event.key === "t") {
    // `t` is the keyboard's `+`. A selected card is a reading position and keeps the letters, and a
    // board with one session behind it has no threads for the key to start.
    if (!document.body.classList.contains("threads") || document.querySelector(".card.active")) return;
    event.preventDefault();
    void startThread();
  }
});

// ---------- transport ----------------------------------------------------
// ---------- session header -----------------------------------------------
const shortNum = (value) => {
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}m`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(value);
};

function applyMeta(meta) {
  if (!meta) return;
  // A board of threads has no single session behind it, so the field lives in the card and the
  // bottom bar is gone. Same client, two backends, one visual language.
  document.body.classList.toggle("threads", workspace !== "" || meta.mode === "threads");
  const wasRunning = metaRunning === true;
  metaRunning = meta.running === true;
  // What the daemon starts a new thread with. The chips say this when no card is being answered, so
  // they cannot be left guessing from whichever thread happens to be newest.
  applyConfig(meta.config);
  // Steering means nothing with no run in flight, so the composer follows the same state. Meta
  // also arrives at every assistant message, so only a run boundary repaints: a repaint would
  // wipe the "sent" or "failed: …" line the composer is showing while the stream is alive.
  if (metaRunning !== wasRunning) paintComposer();
  // A board served by an older pi has no runStartedAt, so the header says waiting instead
  // of inventing an elapsed time from the moment this tab happened to hear about the run.
  runStartedAt = typeof meta.runStartedAt === "number" ? meta.runStartedAt : null;
  // A run that settled without closing its row would keep it counting for ever, so the rail
  // settles it here and the header and the ticker cannot disagree.
  if (!metaRunning) {
    for (const node of actEls.values()) {
      if (node.dataset.status !== "running") continue;
      node.dataset.status = "error";
      node.classList.replace("running", "error");
    }
  }
  renderLive();
  syncTicker();
  // The stop button exists only while there is something to stop.
  stopBtn.style.display = meta.running ? "" : "none";
  if (!meta.running) {
    stopBtn.disabled = false;
    stopBtn.textContent = "stop";
  }
  // The label names the workspace this tab belongs to; clicking it goes back to the crossroads,
  // where another one can be opened in a tab of its own.
  const folder = meta.workspace?.name || meta.folder || "session";
  const sess = document.getElementById("sess");
  sess.innerHTML = "";
  sess.append("board of ");
  const name = document.createElement("b");
  name.textContent = folder;
  sess.append(name);
  // A second daemon answering here says so in the header: the tab title is not always on screen.
  if (meta.instance) {
    const which = document.createElement("span");
    which.className = "instance";
    which.textContent = meta.instance;
    sess.append(which);
  }
  sess.title = meta.workspace
    ? `${meta.workspace.folder} · click for the crossroads`
    : `${meta.cwd || folder} · port ${meta.port}`;
  setBaseTitle(meta.instance ? `pi - ${folder} · ${meta.instance}` : `pi - ${folder}`);
  boardMetaCache = meta;
  paintFooter();
  // The context chip carries the compact action, so it is hidden outright when there is no
  // figure to show rather than left as a button with nothing in it.
  const known = typeof meta.contextPercent === "number";
  statCtx.hidden = !known;
  statCtxValue.textContent = known ? `ctx ${Math.round(meta.contextPercent)}%` : "";
  // The action word is hidden until hover, so the name has to carry it for a screen reader.
  if (known) statCtx.setAttribute("aria-label", `ctx ${Math.round(meta.contextPercent)}%, compact the context`);
  // Compaction aborts a run in flight, so the chip stops offering it while one is happening.
  statCtx.classList.toggle("busy", meta.running === true);
}

// A background tab announces new material the way a chat app does: the title blinks
// until the tab is looked at again.
let baseTitle = document.title || "pi - board";
let flashTimer = null;

function setBaseTitle(text) {
  baseTitle = text;
  if (!flashTimer) document.title = text;
}

function startFlash() {
  if (flashTimer || !document.hidden) return;
  let on = false;
  flashTimer = setInterval(() => {
    on = !on;
    document.title = on ? `● new · ${baseTitle}` : baseTitle;
  }, 800);
}

function stopFlash() {
  if (flashTimer) {
    clearInterval(flashTimer);
    flashTimer = null;
  }
  document.title = baseTitle;
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  stopFlash();
  // A hidden tab schedules nothing, so what is on screen now starts its countdown from here.
  for (const card of inView) armSeen(card);
});
addEventListener("focus", stopFlash);

// What the header line is built from: the stream, the run, and the note a broken link leaves.
let linkUp = false;
let linkNote = "connecting";
/** Pending timer that puts the dimmed down state on screen. */
let dimTimer = null;
/** null until the first meta says whether a run is in flight. */
let metaRunning = null;
let runStartedAt = null;
let ticker = null;
// The first paint waits until here: the composer section runs before the run and link state
// above exist, and its hardcoded hint contradicted what paintComposer says.
paintComposer();

// The header line is one decision: a broken link wins, because without the stream the agent's
// state is unknown and an elapsed time would be a guess.
function renderLive() {
  const working = linkUp && metaRunning === true;
  live.classList.toggle("down", !linkUp);
  live.classList.toggle("working", working);
  // The clock ticks every second, so it is kept out of the spoken text and hidden: a screen
  // reader hears "working" once instead of a count read out every second.
  liveClock.textContent = "";
  if (!linkUp) {
    liveText.textContent = linkNote || "reconnecting";
    return;
  }
  // Nothing is known about the run until the first meta arrives, so claim nothing.
  if (metaRunning === null) {
    liveText.textContent = "connecting";
    return;
  }
  if (!working) {
    liveText.textContent = "idle";
    return;
  }
  if (runStartedAt === null) {
    liveText.textContent = "waiting";
    return;
  }
  liveText.textContent = "working";
  liveClock.textContent = `· ${clockText(Date.now() - runStartedAt)}`;
}

// Elapsed time the header can read at a glance: minutes, then hours once the minutes run out.
function clockText(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

// A rail row shows seconds, then whole minutes and seconds, so the width stays steady.
function rowClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(total / 3600)}h ${String(Math.floor((total % 3600) / 60)).padStart(2, "0")}m`;
}

// One clock drives the header and every running row. It runs only while something is worth
// ticking, so an idle board does not wake its tab every second.
function tick() {
  if (metaRunning === true) renderLive();
  for (const node of actEls.values()) {
    // A row lives in its thread's card or in the rail strip, so the clock walks the rows themselves
    // rather than either box.
    if (node.dataset.status !== "running") continue;
    const started = Number(node.dataset.startedAt);
    const timing = node.querySelector(".ms");
    if (!started || !timing) continue;
    // A thought's rate only moves when a patch lands, so a few still seconds hand the row back to
    // the clock and a stalled thought stops looking live.
    if (node.dataset.kind === "thinking" && Date.now() - Number(node.dataset.patchedAt) < THOUGHT_STALL_MS) {
      continue;
    }
    timing.textContent = rowClock(Date.now() - started);
  }
  // Rail ages are derived from stored data, so re-reading them here is the only thing that
  // keeps the word current while nothing repaints the card.
  for (const id of railRows.keys()) {
    const entry = byId.get(id);
    if (entry) paintRailState(entry);
  }
}

function syncTicker() {
  const wanted = metaRunning === true || runningCount() > 0 || railRows.size > 0;
  if (wanted && !ticker) {
    ticker = setInterval(tick, 1000);
  } else if (!wanted && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

function setLive(up, note = "") {
  const flipped = linkUp !== up;
  linkUp = up;
  if (!up) linkNote = note;
  // The last painted board stays on screen, so the content has to say it is stale too. A wake or
  // a roam can break the stream for one retry cycle, so the down state waits a second and a link
  // that returns first cancels it.
  if (up) {
    clearTimeout(dimTimer);
    dimTimer = null;
    document.body.classList.remove("link-down");
  } else if (!dimTimer && !document.body.classList.contains("link-down")) {
    dimTimer = setTimeout(() => {
      dimTimer = null;
      document.body.classList.add("link-down");
    }, 1000);
  }
  // A retry that changes nothing leaves the hint alone, so a transient line survives it.
  if (flipped) paintComposer();
  renderLive();
}

function connect() {
  const source = new EventSource(`/events?${auth}`);
  source.onopen = () => setLive(true);
  source.onerror = () => {
    // The browser tells the two failures apart: an HTTP error, such as a token the board no
    // longer knows, closes the stream for good, while a network error leaves it retrying.
    if (source.readyState === EventSource.CLOSED) {
      setLive(false, "token refused — reopen the link pi printed");
    } else {
      setLive(false, "pi not reachable — retrying");
    }
  };
  source.onmessage = (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (payload.type === "meta") {
      applyMeta(payload.meta);
    } else if (payload.type === "git") {
      applyGit(payload.git);
    } else if (payload.type === "snapshot") {
      applyMeta(payload.meta);
      applyGit(payload.git);
      // A reconnect replays what is already on the board, and a draft survives it: every field puts its
      // words aside under its card before the cards go, and the rebuilt card picks them up again.
      clearBoard();
      replaying = true;
      // A card that throws mid-replay must not leave the flag set: the tab would then never
      // badge, centre or restore a target again.
      try {
        for (const row of payload.activity || []) applyActivity(row);
        for (const card of payload.cards || []) applyMessage(card);
        applyClosed(payload.closed);
      } finally {
        replaying = false;
      }
      // A snapshot is the whole board, so a draft whose card is not in it has nowhere to go.
      for (const id of [...drafts.keys()]) if (id && !byId.has(id)) drafts.delete(id);
      // Every thread comes back in the order the human chose, not the order the server lists.
      applyAllThreadOrder();
      sawFirstCard = (payload.cards || []).length > 0;
      // The chips say what a thread answers with, and the snapshot is the first time any thread is
      // known: without this they stay blank until some other card changes.
      paintRuntime();
      // Armed on the first snapshot even when it is empty: the usual start is an empty snapshot
      // and the first card frames through the new-card path, and the first reconnect must not
      // throw that framing away.
      if (!framedView) {
        framedView = true;
        if (cards.length) fitAll();
      }
    } else if (payload.type === "move") {
      const record = byId.get(payload.id);
      if (record && payload.rect) placeCard(record, payload.rect);
      if (record && typeof payload.mini === "boolean") setMini(record.card, payload.mini);
      // A pin set in another tab is this tab's too, so the head agrees wherever it is looked at.
      if (record && typeof payload.pinned === "boolean") setPinned(record.card, payload.pinned);
    } else if (payload.type === "remove") {
      dropCard({ id: payload.id });
    } else if (payload.type === "config") {
      // Another tab changed this board's settings, so this one follows without a reload.
      applyConfig(payload.config);
    } else if (payload.type === "activity") {
      applyActivity(payload.row);
    } else if (payload.type === "card" || payload.type === "update") {
      const known = byId.has(payload.card.id);
      // An open question is re-broadcast on every update, so its blink has to key on the
      // transition into blocking the agent, not on the state the tab already shows.
      const wasOpen = known && questionWants(byId.get(payload.card.id).data);
      // A card put back by an undo was on the board once already: it is drawn the way a replay draws
      // it, so it carries no new tag and takes no place in the new-card pill.
      const wasReplaying = replaying;
      if (payload.restored === true) replaying = true;
      try {
        applyMessage(payload.card, payload.quiet === true);
      } finally {
        replaying = wasReplaying;
      }
      paintRuntime();
      // A quiet repaint and a card the tab already holds are not news; only an arrival or a
      // question that has just started blocking the agent is worth a blink in a background tab.
      const record = byId.get(payload.card.id);
      if ((!known && payload.quiet !== true && payload.restored !== true) || (record && !wasOpen && questionWants(record.data))) {
        startFlash();
      }
    } else if (payload.type === "closed") {
      applyClosed(payload.closed);
    } else if (payload.type === "hint") {
      hintLine(payload.text || "");
    } else if (payload.type === "clear") {
      clearBoard();
    }
  };
}

const BOARD_START = () => {
  applyView();
  updateEmpty();
  paintRuntime();
  if (!token) {
    // No stream exists here, so nothing on the page is stale: only the header says why the board
    // is blank.
    linkNote = "missing token";
    renderLive();
    return;
  }
  connect();
};

// A module runs after the page is parsed, so there is no inline call left to wait for.
BOARD_START();

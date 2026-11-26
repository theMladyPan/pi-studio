/**
 * The logs drawer: the daemon's own log in a narrow panel that rolls in from the right edge with `l`.
 *
 * Everything the daemon had to say before this went to the terminal it was started from — the git
 * command that refused, the Docker call that answered no, the provider error behind a stopped run, a
 * child's stderr. The daemon keeps those lines in a ring (`server/logs.ts`) and streams them here, so
 * the board answers "what just happened" without a second window.
 *
 * The panel is the right edge on purpose: the header's toolbox keys and the left column stay reachable,
 * and the drawer never covers the card being read. It opens and rolls out by itself — `l`, Escape or
 * its own button — and the left drawers, which own the same board from the other side, are left alone.
 *
 * One rule is absolute: log text is never markup. Every source name, message and meta value reaches the
 * page through `textContent`, so a child that printed a `<script>` tag shows it as characters.
 */

/** The roll itself is the shared sliding drawer: the class, the button and the focus return. */
import { bindDragHeight, createSlidingDrawer } from "./drawer-common.js";

/** How much of a message the shut row shows before the expansion is the only way to read the rest. */
const SHUT_CHARS = 120;

/** How many rows are drawn at most. The daemon's ring is 5000 lines, so this is the same bound. */
const ROW_LIMIT = 5000;

/** Where the human left the verbosity. It is furniture, so a reload opens at the same filter. */
const FILTER_KEY = "board.logsFilter";

/** The width the human dragged the drawer to. Same furniture the rail's width is. */
const WIDTH_KEY = "board.logsWidth";

/** Worst first, the way the filter reads: a filter shows its own rank and every worse one. */
const RANK = { error: 0, warning: 1, info: 2, debug: 3 };

/** The three filters the segmented control offers, and the strictest rank each one keeps. */
const FILTER_RANK = { error: 1, info: 2, debug: 3 };

/** The one-word pill a level wears. `warning` is too long for a row that also carries a timestamp. */
const PILL = { error: "err", warning: "warn", info: "info", debug: "debug" };

/** A timestamp as the row shows it: the clock, because the buffer never holds more than a few days. */
function clockOf(ts) {
  const at = String(ts ?? "");
  return at.length >= 19 ? at.slice(11, 19) : at;
}

/** One line, cut for the shut row. The cut is visible, so a long message never reads as a short one. */
function shut(message) {
  const text = String(message ?? "").replace(/\s+/g, " ").trim();
  return text.length > SHUT_CHARS ? `${text.slice(0, SHUT_CHARS)}…` : text;
}

/** One drawer, for the whole life of the page. It owns no keyboard of its own: `l` and Escape are the
 * board's letters, answered in `board.js` the way the git drawer's `g` is, so the guards a field, a
 * panel and a sheet already earn are the same ones here. */
export function createLogsDrawer() {
  const drawer = document.getElementById("logsDrawer");
  const btn = document.getElementById("logsBtn");
  const closeBtn = document.getElementById("logsClose");
  const listEl = document.getElementById("logsList");
  const liveEl = document.getElementById("logsLive");
  const liveText = document.getElementById("logsLiveText");
  const pauseBtn = document.getElementById("logsPause");
  const followBtn = document.getElementById("logsFollow");
  const clearBtn = document.getElementById("logsClear");
  const countEl = document.getElementById("logsCount");
  const footEl = document.getElementById("logsFoot");
  const nWarn = document.getElementById("logsNWarn");
  const nInfo = document.getElementById("logsNInfo");
  const nDebug = document.getElementById("logsNDebug");
  const filters = [...document.querySelectorAll("#logsDrawer .logs-seg button")];
  const nameLabel = document.getElementById("openPanelName");
  const grip = document.getElementById("logsGrip");
  // The width is furniture, like the rail's: a reload opens at the width it was left.
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY)) || 0;
    if (saved >= 320) drawer.style.width = `${Math.min(Math.round(saved), Math.floor(window.innerWidth * 0.85))}px`;
  } catch {}
  bindDragHeight(grip, {
    bodyClass: "rail-resizing",
    resolvePx: (event) => {
      const width = Math.max(320, Math.min(Math.floor(window.innerWidth * 0.85), Math.floor(window.innerWidth - event.clientX)));
      drawer.style.width = `${width}px`;
      try { localStorage.setItem(WIDTH_KEY, String(width)); } catch {}
    },
  });

  /** Every line the daemon has streamed, oldest first. The daemon's ring is 5000; this follows it. */
  let entries = [];
  /** Lines that arrived while the tail was paused, so resuming does not lose them. */
  let held = [];
  /** The tail runs unless the human paused it. */
  let paused = false;
  /** New lines are followed to the bottom unless the human scrolled away. */
  let follow = true;
  /** The view was cleared: the buffer is kept, and nothing is drawn until the human undoes it. */
  let cleared = false;
  /** The filter the human left last time, and the one this page opens with. */
  let filter = "info";
  try {
    const kept = localStorage.getItem(FILTER_KEY);
    if (kept && kept in FILTER_RANK) filter = kept;
  } catch {}

  /** The stream, opened on the first roll down and kept after that. */
  let stream = null;
  /** What the header's shared label said before this drawer took it, so the roll out puts it back. The
   * left column keeps its own name there, and opening this strip never rolls it up. */
  let labelBefore = null;

  function paintLive() {
    liveEl.classList.toggle("paused", paused);
    liveText.textContent = paused ? "paused" : "live";
    pauseBtn.setAttribute("aria-pressed", paused ? "true" : "false");
    pauseBtn.textContent = paused ? "resume" : "pause";
  }

  function paintFilter() {
    for (const button of filters) button.setAttribute("aria-pressed", button.dataset.filter === filter ? "true" : "false");
  }

  /** Whether a line passes the filter. The daemon's own rule, restated because the client answers it. */
  const passes = (entry) => (RANK[entry.level] ?? 3) <= FILTER_RANK[filter];

  /** The counts the segmented control carries: how many lines each choice would show. */
  function paintCounts() {
    let warn = 0;
    let info = 0;
    for (const entry of entries) {
      const rank = RANK[entry.level] ?? 3;
      if (rank <= 1) warn += 1;
      if (rank <= 2) info += 1;
    }
    nWarn.textContent = ` ${warn}`;
    nInfo.textContent = ` ${info}`;
    nDebug.textContent = ` ${entries.length}`;
    countEl.textContent = `${entries.length} in buffer${paused ? " · paused" : ""}`;
  }

  /** The meta grid: the five fields the daemon puts on a command, then whatever else the source sent. */
  function metaGrid(entry) {
    const grid = document.createElement("div");
    grid.className = "logs-meta";
    const pairs = Object.entries(entry.meta ?? {});
    if (pairs.length === 0) {
      const key = document.createElement("span");
      key.className = "k";
      key.textContent = "source";
      const value = document.createElement("b");
      value.textContent = `${entry.source} — no command behind this line`;
      grid.append(key, value);
      return grid;
    }
    for (const [key, value] of pairs) {
      const name = document.createElement("span");
      name.className = "k";
      name.textContent = key;
      const said = document.createElement("b");
      said.textContent = typeof value === "string" ? value : JSON.stringify(value);
      grid.append(name, said);
    }
    return grid;
  }

  /** One row, built as nodes: nothing here is ever markup, because a line may say anything. */
  function rowOf(entry) {
    const row = document.createElement("div");
    row.className = "log";
    row.dataset.level = entry.level;

    const head = document.createElement("button");
    head.type = "button";
    head.className = "log-head";
    const chevron = document.createElement("span");
    chevron.className = "chev";
    chevron.textContent = "›";
    const clock = document.createElement("span");
    clock.className = "ts";
    clock.textContent = clockOf(entry.ts);
    const pill = document.createElement("span");
    pill.className = `lvl ${PILL[entry.level] ?? "debug"}`;
    pill.textContent = PILL[entry.level] ?? entry.level;
    const source = document.createElement("span");
    source.className = "src";
    source.textContent = entry.source;
    source.title = entry.source;
    const said = document.createElement("span");
    said.className = "msg";
    said.textContent = shut(entry.message);
    head.append(chevron, clock, pill, source, said);

    const detail = document.createElement("div");
    detail.className = "log-detail";
    const full = document.createElement("pre");
    const hasOutput = entry.output !== undefined && entry.output !== null && entry.output !== "";
    const hasMeta = entry.meta && typeof entry.meta === "object" && Object.keys(entry.meta).length > 0;
    if (hasOutput) full.textContent = String(entry.output);
    else if (hasMeta) {
      // A command that answered nothing (an empty stash list, a quiet status) has no output to show:
      // say so dimly instead of repeating the command that already stands in the head and the meta grid.
      // The class is `no-output` and not `empty`: the page's global `.empty` is a full-container
      // centred placeholder, and its absolute, centred rules would stretch this block over the row.
      full.className = "no-output";
      full.textContent = "[no output]";
    } else full.textContent = String(entry.message ?? "");
    const actions = document.createElement("div");
    actions.className = "actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "copy full";
    const collapse = document.createElement("button");
    collapse.type = "button";
    collapse.textContent = "collapse";
    actions.append(copy, collapse);
    detail.append(metaGrid(entry), full, actions);

    const shutRow = () => {
      row.classList.remove("open");
      chevron.textContent = "›";
    };
    head.addEventListener("click", () => {
      const open = row.classList.toggle("open");
      chevron.textContent = open ? "⌄" : "›";
    });
    copy.addEventListener("click", () => {
      const base = entry.meta ? `${entry.message}\n\n${JSON.stringify(entry.meta, null, 2)}` : String(entry.message ?? "");
      const text = entry.output ? `${base}\n\n${entry.output}` : base;
      navigator.clipboard?.writeText(text).catch(() => {});
    });
    collapse.addEventListener("click", shutRow);

    row.append(head, detail);
    return row;
  }

  /** A note in the place of the list: what the drawer has to say about itself, and no rows. */
  function emptyNote(text, action) {
    const note = document.createElement("p");
    note.className = "logs-empty";
    note.textContent = text;
    if (action) note.append(action);
    return note;
  }

  /** Draw the whole list from the buffer. Used on the first paint, on a filter change and on a resume. */
  function render() {
    listEl.replaceChildren();
    if (cleared) {
      const undo = document.createElement("button");
      undo.type = "button";
      undo.textContent = "undo clear";
      undo.addEventListener("click", () => {
        cleared = false;
        render();
      });
      listEl.append(emptyNote("cleared — the buffer is kept", undo));
    } else {
      const shown = entries.filter(passes);
      if (shown.length === 0) listEl.append(emptyNote(entries.length ? "no lines at this verbosity" : "no lines yet"));
      else listEl.append(...shown.map(rowOf));
    }
    paintCounts();
    footEl.textContent = entries.length ? `last line ${clockOf(entries[entries.length - 1].ts)}` : "";
    if (follow && !paused) listEl.scrollTop = listEl.scrollHeight;
  }

  /** One new line: appended where it belongs, without redrawing the rows already on screen. */
  function appended(entry) {
    entries.push(entry);
    // The daemon's ring is bounded, so this side's copy is too: a tab left open for a day costs what
    // the daemon costs, not a morning of lines.
    if (entries.length > ROW_LIMIT) entries.splice(0, entries.length - ROW_LIMIT);
    paintCounts();
    if (cleared || !passes(entry)) return;
    if (listEl.querySelector(".logs-empty")) {
      render();
      return;
    }
    listEl.append(rowOf(entry));
    // The rows follow the same bound the buffer does: a tab left open for a day draws five thousand
    // lines, the way the daemon keeps five thousand, rather than one row per line ever written.
    while (listEl.childElementCount > ROW_LIMIT) listEl.firstElementChild.remove();
    if (follow) listEl.scrollTop = listEl.scrollHeight;
    footEl.textContent = `last line ${clockOf(entry.ts)}`;
  }

  /** Take the snapshot the stream or the route answered with, and paint it. */
  function takeSnapshot(entries_) {
    entries = Array.isArray(entries_) ? entries_.slice(-ROW_LIMIT) : [];
    held = [];
    render();
  }

  /**
   * The tail. A late joiner gets the daemon's ring as its first event and every new line after it, so
   * a drawer opened an hour after the daemon started shows the hour rather than only what comes next.
   * Opened on the first roll down and kept: a closed stream is reopened by the next roll.
   */
  function connect() {
    if (stream) return;
    stream = new EventSource("/logs/stream");
    stream.addEventListener("snapshot", (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      takeSnapshot(payload?.entries);
    });
    stream.addEventListener("entry", (event) => {
      let entry;
      try {
        entry = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!entry) return;
      if (!paused) appended(entry);
      else {
        // A pause is a reading position, not a promise to keep everything: the held lines follow the
        // same bound the buffer does, so an hour paused costs five thousand entries and no more.
        held.push(entry);
        if (held.length > ROW_LIMIT) held.splice(0, held.length - ROW_LIMIT);
      }
    });
    stream.onerror = () => {
      // A stream the daemon dropped is reopened by the browser on its own, and the bar says so rather
      // than showing `live` over a tap that has stopped running.
      liveEl.classList.add("paused");
      liveText.textContent = "reconnecting";
    };
  }

  /** The roll itself is the shared sliding drawer: the class, the button and the focus return. */
  const sliding = createSlidingDrawer({
    drawer,
    btn,
    bodyClass: "logs-open",
    openTitle: "roll the logs drawer out (l)",
    shutTitle: "roll the logs drawer in from the right (l)",
    beforeOpen() {
      connect();
    },
    afterOpen() {
      // The label is shared with the other drawers, and each says its own name on the way up rather
      // than trusting the last writer — and gives back what it found on the way out, because a left
      // drawer may have been naming itself there when this strip rolled in over it.
      if (nameLabel) {
        labelBefore = { text: nameLabel.textContent, hidden: nameLabel.hidden };
        nameLabel.textContent = "logs";
        nameLabel.hidden = false;
      }
      listEl.scrollTop = listEl.scrollHeight;
      closeBtn.focus();
    },
    afterClose() {
      if (!nameLabel || !labelBefore) return;
      nameLabel.textContent = labelBefore.text;
      nameLabel.hidden = labelBefore.hidden;
      labelBefore = null;
    },
  });

  pauseBtn.addEventListener("click", () => {
    paused = !paused;
    paintLive();
    if (!paused && held.length) {
      // What arrived during the pause is drawn now, in the order it arrived.
      for (const entry of held) appended(entry);
      held = [];
    }
    paintCounts();
  });

  followBtn.addEventListener("click", () => {
    follow = !follow;
    followBtn.setAttribute("aria-pressed", follow ? "true" : "false");
    if (follow) listEl.scrollTop = listEl.scrollHeight;
  });

  clearBtn.addEventListener("click", () => {
    cleared = !cleared;
    render();
  });

  closeBtn.addEventListener("click", () => sliding.close());

  for (const button of filters) {
    button.addEventListener("click", () => {
      filter = button.dataset.filter;
      try {
        localStorage.setItem(FILTER_KEY, filter);
      } catch {}
      paintFilter();
      render();
    });
  }

  // A press that scrolls away from the bottom stops the follow, the way a console's tail does: the
  // human is reading, and a line arriving under their eyes is a line they did not ask to move.
  listEl.addEventListener("scroll", () => {
    const atBottom = listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 24;
    if (atBottom || !follow) return;
    follow = false;
    followBtn.setAttribute("aria-pressed", "false");
  });

  paintLive();
  paintFilter();
  paintCounts();
  footEl.textContent = "";

  return { isOpen: sliding.isOpen, toggle: sliding.toggle, open: sliding.open, close: sliding.close };
}

"use strict";
/**
 * The shelf: one column of workspaces, one dual-purpose omnibar, and a settings page rendered from the
 * JSON document the daemon serves at /settings/defaults. It never becomes a board — a workspace is a
 * page, not a state. One file on purpose: `bin/check-imports.mjs` does not know this page, so a second
 * client module here would 404 at runtime with every check green.
 */
(() => {
  const token = new URLSearchParams(location.search).get("token") || "";
  // The token rides on every request, the stream included: the daemon accepts nothing without it.
  const qs = () => `token=${encodeURIComponent(token)}`;

  /** Where the human left the settings tree, one entry per dotted group path. */
  const COLLAPSE_KEY = "pi-studio.settings.collapsed.v1";
  /** Unsaved prompt text, one entry per field id: the page is reloaded far more often than it is closed. */
  const DRAFTS_KEY = "pi-studio.welcome.drafts.v1";
  /** How long a keystroke's draft waits before the store is written; a human types next faster than this. */
  const DRAFT_WRITE_MS = 400;
  /** A prompt box grows with its text to this height and scrolls after it: ten whole files are not a page. */
  const PROMPT_MAX_H = 26 * 17 + 12;

  const nodes = {
    brand: document.getElementById("mastheadContext"),
    sep: document.getElementById("mastheadSep"),
    back: document.getElementById("backToShelfBtn"),
    door: document.getElementById("openSettingsBtn"),
    shelfView: document.getElementById("shelfView"),
    settingsView: document.getElementById("settingsView"),
    omni: document.getElementById("omniInput"),
    modeBadge: document.getElementById("omniModeBadge"),
    browse: document.getElementById("browseBtn"),
    pathRow: document.getElementById("pathActionRow"),
    pathLabel: document.getElementById("pathActionLabel"),
    pathText: document.getElementById("pathActionText"),
    list: document.getElementById("wsList"),
    empty: document.getElementById("emptyShelf"),
    emptyTitle: document.getElementById("emptyTitle"),
    emptyCopy: document.getElementById("emptyCopy"),
    readout: document.getElementById("selectedPathReadout"),
    docTitle: document.getElementById("docTitle"),
    docVersion: document.getElementById("docVersion"),
    docHelp: document.getElementById("docHelp"),
    saveStatus: document.getElementById("saveStatus"),
    foldAll: document.getElementById("toggleAllGroupsBtn"),
    tree: document.getElementById("settingsTree"),
    settingsReadout: document.getElementById("settingsFootReadout"),
  };

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // ---------- markdown in the prompt box -----------------------------------
  //
  // A prompt is markdown and its box shows it as markdown with the markers still on show: `**bold**`
  // reads bold and keeps its asterisks, `## Title` reads as a heading and keeps its hashes. One textarea
  // holds the caret; a mirror behind it draws the same characters styled. Every character is escaped
  // before a span goes round it, so a prompt can never add an element of its own.

  /** The four characters a prompt may type that html would otherwise read. */
  function escaped(text) {
    return text.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]);
  }

  /** Bold, italics, a card key and a link, inside text already escaped. */
  function markWords(text) {
    return text
      .replace(/(\*\*[^*\n]+\*\*)/g, '<span class="md-strong">$1</span>')
      .replace(/(^|[\s(])(\*[^*\n]+\*)(?![*])/g, '$1<span class="md-em">$2</span>')
      .replace(/(\[\[[^\]\n]+\]\])/g, '<span class="md-key">$1</span>')
      .replace(/(\[[^\]\n]+\]\([^)\s]+\))/g, '<span class="md-link">$1</span>');
  }

  /** Inline code is drawn as code and holds nothing else: a `**` inside backticks stays two asterisks. */
  function markInline(text) {
    return text
      .split(/(`[^`\n]+`)/g)
      .map((piece) => (piece.startsWith("`") ? `<span class="md-code">${piece}</span>` : markWords(piece)))
      .join("");
  }

  /** One line: a fence, a heading, a list item or a quote keeps its marker and tints what follows. */
  function markLine(line) {
    const safe = escaped(line);
    if (/^\s*```/.test(safe)) return `<span class="md-fence">${safe}</span>`;
    const head = /^(#{1,6})(\s+)([\s\S]*)$/.exec(safe);
    if (head) {
      const level = Math.min(head[1].length, 3);
      return `<span class="md-h md-h${level}"><span class="md-mark">${head[1]}</span>${head[2]}${markInline(head[3])}</span>`;
    }
    const item = /^(\s*)([-*+]|\d+[.)])(\s+)([\s\S]*)$/.exec(safe);
    if (item) return `${item[1]}<span class="md-mark">${item[2]}</span>${item[3]}${markInline(item[4])}`;
    const quote = /^(\s*)(&gt;\s?)([\s\S]*)$/.exec(safe);
    if (quote) return `${quote[1]}<span class="md-mark">${quote[2]}</span><span class="md-quote">${markInline(quote[3])}</span>`;
    return markInline(safe);
  }

  /** The mirror's html. The closing newline keeps a last empty line, which html would otherwise drop. */
  function markPrompt(text) {
    return `${text.split("\n").map(markLine).join("\n")}\n`;
  }

  /** `1,487 B · 38 lines`: a prompt is a file a thread reads whole, so its size is worth seeing. */
  function sizeLine(text) {
    const bytes = new TextEncoder().encode(text).length;
    const lines = text ? text.split("\n").length : 0;
    return `${bytes.toLocaleString()} B · ${lines} line${lines === 1 ? "" : "s"}`;
  }

  /**
   * Insert at the caret through the editing command, so one press of a key stays one step of undo; a
   * plain splice into `value` would throw the browser's undo stack away. The fallback fires the same
   * `input` event, because every reader of this box — drafts, dirty state, the mirror — listens for it.
   */
  function insertAt(area, text) {
    if (document.execCommand && document.execCommand("insertText", false, text)) return;
    area.setRangeText(text, area.selectionStart, area.selectionEnd, "end");
    area.dispatchEvent(new Event("input"));
  }

  /**
   * The keys that keep a hand on the keyboard in a markdown box: Tab indents instead of leaving the
   * field, Enter carries a list on, and ⌘B/⌘I wrap the selection in the markers the mirror then draws.
   */
  function markdownKeys(area) {
    area.addEventListener("keydown", (event) => {
      const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
      if (event.key === "Tab" && plain) {
        event.preventDefault();
        if (event.shiftKey) outdentLine(area);
        else insertAt(area, "  ");
        return;
      }
      if (event.key === "Enter" && plain && !event.shiftKey) {
        const from = area.value.lastIndexOf("\n", area.selectionStart - 1) + 1;
        const item = /^(\s*)([-*+]|(\d+)[.)])(\s+)(\S?)/.exec(area.value.slice(from, area.selectionStart));
        if (!item) return;
        event.preventDefault();
        if (!item[4]) {
          // Enter on an item with nothing after its marker ends the list rather than adding another.
          area.setRangeText("", from, area.selectionStart, "end");
          area.dispatchEvent(new Event("input"));
          return;
        }
        const next = item[3] ? `${Number(item[3]) + 1}.` : item[2];
        insertAt(area, `\n${item[1]}${next} `);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && !event.altKey) {
        const marker = event.key.toLowerCase() === "b" ? "**" : event.key.toLowerCase() === "i" ? "*" : "";
        if (!marker) return;
        event.preventDefault();
        const from = area.selectionStart;
        const to = area.selectionEnd;
        area.setRangeText(`${marker}${area.value.slice(from, to)}${marker}`, from, to, "end");
        // The words stay selected, so the next look at them is the marker going round them.
        area.setSelectionRange(from + marker.length, to + marker.length);
        area.dispatchEvent(new Event("input"));
      }
    });
  }

  /** Shift+Tab in a single-level list: the two spaces the caret sits behind go, and the caret follows. */
  function outdentLine(area) {
    const from = area.value.lastIndexOf("\n", area.selectionStart - 1) + 1;
    const head = /^ {1,2}/.exec(area.value.slice(from, area.selectionStart));
    if (!head) return;
    area.setRangeText("", from, from + head[0].length, "end");
    area.dispatchEvent(new Event("input"));
  }

  /** Every prompt box drawn in the tree, so a narrower window can re-wrap them all at once. */  const repaintPrompts = new Set();
  window.addEventListener("resize", () => {
    for (const repaint of repaintPrompts) repaint();
  });
  // A group that opens gives its prompts a layout for the first time. `toggle` does not bubble, but it
  // still reaches a listener in the capture phase, and that is where the boxes measure themselves.
  nodes.tree.addEventListener("toggle", () => {
    for (const repaint of repaintPrompts) repaint();
  }, true);

  // ---------- the shelf ----------------------------------------------------

  /** @type {any[]} */
  let workspaces = [];
  let selectedId = null;
  /** The daemon's own words for the last refusal, shown on the path line until the next keystroke. */
  let pathError = "";
  /** Set when the workspace list could not be read: the empty shelf says so rather than lying. */
  let listError = "";
  let view = "shelf";

  /** A path-shaped entry is a folder to open, not a filter: the shapes a shell would accept. */
  function looksLikePath(text) {
    return text.startsWith("/") || text.startsWith("~/") || text.startsWith("./");
  }

  /** The thread that is running, if one is: its title is the honest one-line answer to "what is this". */
  function busyThread(workspace) {
    return (workspace.threads || []).find((thread) => thread.status === "running") ?? null;
  }

  /** Running thread title, or the folder it holds — the same line in both states, never empty. */
  function contextLine(workspace) {
    return busyThread(workspace)?.title || workspace.folder;
  }

  /** Everything a typed filter may match, so a thread title finds the workspace it runs in. */
  function haystack(workspace) {
    return [workspace.name, workspace.folder, ...(workspace.threads || []).map((thread) => thread.title)]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  function age(ms) {
    if (!ms) return "";
    const seconds = Math.round((Date.now() - ms) / 1000);
    if (seconds < 90) return "just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  function rowFor(workspace) {
    const row = el("li", "ws-row");
    row.setAttribute("role", "option");
    row.dataset.id = workspace.id;
    row.dataset.match = haystack(workspace);
    if (workspace.running) row.classList.add("is-running");
    if (workspace.missing) row.classList.add("is-missing");

    const dot = el("span", `status-dot ${workspace.missing ? "missing" : workspace.running ? "running" : "idle"}`);
    dot.title = workspace.missing
      ? "folder missing from disk"
      : workspace.running
        ? `${workspace.running} running`
        : `idle · ${workspace.threadCount || 0} thread${workspace.threadCount === 1 ? "" : "s"}`;

    const left = el("div", "ws-left");
    left.append(dot, el("span", "ws-name", workspace.name), el("span", "ws-context", contextLine(workspace)));

    const right = el("div", "ws-right");
    if (workspace.missing) right.append(el("span", "sig-missing", "folder missing"));
    else if (workspace.running) right.append(el("span", "sig-running", `${workspace.running} running`));
    else {
      // An idle row says when it was last touched. A workspace nothing has happened in yet was touched
      // when its folder was opened, which is the only age it has; a row with nothing there reads as a
      // row that failed to load.
      const at = workspace.lastActivity?.at ?? workspace.openedAt;
      if (at) right.append(el("span", "sig-quiet", age(at)));
    }
    const glyph = el("span", "enter-glyph", "↵");
    glyph.setAttribute("aria-hidden", "true");
    right.append(glyph);

    row.append(left, right);
    row.addEventListener("click", () => {
      selectedId = workspace.id;
      applyFilter();
      openBoard(workspace.id);
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        selectedId = workspace.id;
        markSelected(workspace.id);
        openBoard(workspace.id);
      }
    });
    return row;
  }

  /**
   * The tab a workspace belongs to. Named, so opening it twice focuses the tab you already have rather
   * than piling up new ones.
   */
  function openBoard(id) {
    const workspace = workspaces.find((candidate) => candidate.id === id);
    if (!workspace || workspace.missing) return;
    const url = `/w/${workspace.id}?${qs()}`;
    const tab = window.open(url, `pi-studio-${workspace.id}`);
    // A tab that already carries this name is only focused, not reloaded, so a board left open from an
    // older build would keep its stale client. Navigating it again costs one reload and means the tab
    // always runs the code the daemon is serving now.
    if (tab) tab.location.replace(url);
  }

  function markSelected(id) {
    for (const row of nodes.list.children) {
      const active = row.dataset.id === id;
      row.setAttribute("aria-selected", String(active));
      row.tabIndex = active ? 0 : -1;
    }
    const selected = workspaces.find((workspace) => workspace.id === id);
    nodes.readout.textContent = selected
      ? selected.missing
        ? `${selected.folder} (missing on disk)`
        : selected.folder
      : "";
    nodes.readout.style.color = selected?.missing ? "var(--bad)" : "";
  }

  /** Filter, selection, path line and footer, from what is on screen right now. No rebuild, no refetch. */
  function applyFilter() {
    const text = nodes.omni.value.trim();
    const query = text.toLowerCase();
    const rows = [...nodes.list.children];
    let shown = 0;
    for (const row of rows) {
      row.hidden = Boolean(query) && !row.dataset.match.includes(query);
      if (!row.hidden) shown++;
    }
    const visible = rows.filter((row) => !row.hidden);
    if (visible.length && !visible.some((row) => row.dataset.id === selectedId)) {
      selectedId = visible[0].dataset.id;
    }
    markSelected(selectedId);

    const isPath = looksLikePath(text);
    nodes.modeBadge.hidden = !isPath;
    nodes.pathRow.hidden = !(isPath || pathError);
    nodes.pathRow.classList.toggle("is-error", Boolean(pathError));
    nodes.pathLabel.textContent = pathError ? "Not opened: " : "Open folder as workspace: ";
    nodes.pathText.textContent = pathError || text;

    nodes.empty.hidden = shown > 0;
    nodes.list.hidden = shown === 0;
    if (shown === 0) {
      if (listError) {
        nodes.emptyTitle.textContent = "Could not read the workspace list.";
        nodes.emptyCopy.textContent = listError;
      } else if (!workspaces.length) {
        nodes.emptyTitle.textContent = "No workspaces opened yet.";
        nodes.emptyCopy.textContent =
          "A workspace is any folder on this machine. Type a path above and press Enter, or press browse… to pick one.";
      } else {
        nodes.emptyTitle.textContent = `No workspace matches “${text}”.`;
        nodes.emptyCopy.textContent = "Press Esc to clear the filter.";
      }
    }
  }

  function paintBrand() {
    if (view === "settings") {
      nodes.sep.textContent = "/";
      nodes.brand.textContent = "settings";
      return;
    }
    nodes.sep.textContent = "·";
    const running = workspaces.reduce((sum, workspace) => sum + (workspace.running || 0), 0);
    const count = `${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"}`;
    nodes.brand.replaceChildren(
      document.createTextNode(`${count} · `),
      el("span", running ? "live-count" : "", `${running} running`),
    );
  }

  function adopt(list) {
    workspaces = Array.isArray(list) ? list : [];
    listError = "";
    nodes.list.replaceChildren(...workspaces.map(rowFor));
    paintBrand();
    applyFilter();
  }

  async function load() {
    try {
      const response = await fetch(`/workspaces?${qs()}`);
      if (!response.ok) throw new Error((await response.text()).slice(0, 120) || response.statusText);
      const data = await response.json();
      adopt(data.workspaces);
    } catch (error) {
      listError = `${error.message || error}`;
      workspaces = [];
      nodes.list.replaceChildren();
      paintBrand();
      applyFilter();
    }
  }

  /** Open a folder as a workspace, through the daemon, and then its board. Refusals stay on the line. */
  async function openPath(folder) {
    pathError = "";
    applyFilter();
    try {
      const response = await fetch(`/workspace?${qs()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder }),
      });
      if (!response.ok) throw new Error((await response.text()).slice(0, 160) || response.statusText);
      const data = await response.json();
      nodes.omni.value = "";
      await load();
      if (data.workspace?.id) selectedId = data.workspace.id;
      applyFilter();
      openBoard(data.workspace?.id ?? selectedId);
    } catch (error) {
      pathError = `could not open ${folder}: ${error.message || error}`;
      applyFilter();
    }
  }

  async function browse() {
    pathError = "";
    applyFilter();
    try {
      // A browser cannot hand us an absolute path, so the daemon asks the machine's own dialog.
      const response = await fetch(`/pick-folder?${qs()}`, { method: "POST" });
      if (!response.ok) throw new Error((await response.text()).slice(0, 140) || response.statusText);
      const data = await response.json();
      if (data.cancelled) return;
      nodes.omni.value = data.folder;
      applyFilter();
      nodes.omni.focus();
    } catch (error) {
      pathError = `no folder dialog: ${error.message || error} — type the path instead`;
      applyFilter();
    }
  }

  /** Enter means one thing: open the path if there is one, otherwise the selected workspace. */
  function actOnEnter() {
    const text = nodes.omni.value.trim();
    if (looksLikePath(text)) {
      void openPath(text);
      return;
    }
    const visible = [...nodes.list.children].filter((row) => !row.hidden);
    const chosen = visible.find((row) => row.dataset.id === selectedId) || visible[0];
    if (chosen) {
      openBoard(chosen.dataset.id);
      return;
    }
    if (text) {
      pathError = `“${text}” is not a folder path — one starts with /, ~/ or ./`;
      applyFilter();
    }
  }

  // ---------- the settings page -------------------------------------------

  /** The document exactly as the daemon served it, or null when it could not be read. */
  let doc = null;
  /** field id -> { field, row, error, message, lastGood, set }, so a value can be painted back. */
  const entries = new Map();
  /**
   * field id -> text somebody typed into a prompt textarea and has not saved. The tree is rebuilt from the
   * daemon's document on every visit, so text that only lived in a textarea would be gone after `Esc` and
   * back; it is kept here instead and put back, still marked unsaved, when the view is drawn again. The
   * store reads it back, so a reload is no different from a switch to the shelf and back.
   */
  const drafts = new Map(Object.entries(readDraftStore()));
  /** The pending write of the store, if a keystroke has not been followed by silence yet. */
  let draftWriteTimer = 0;
  /** details element -> { group, preview }, so a closed group's summary follows a change. */
  const previews = new Map();

  /** The drafts a previous visit left behind, as field id -> text. */
  function readDraftStore() {
    try {
      const kept = JSON.parse(localStorage.getItem(DRAFTS_KEY) || "{}");
      return kept && typeof kept === "object" && !Array.isArray(kept) ? kept : {};
    } catch {
      return {};
    }
  }

  /**
   * The drafts as they stand: an empty map removes the key, so nothing is left behind for a prompt nobody
   * is editing. A field's draft goes when its save is accepted and when `revert` is pressed; a refusal
   * keeps it, because the text is still the human's.
   */
  function saveDrafts() {
    // The timer and a save or a revert write the same thing, so a write made now leaves a pending one nothing
    // to say.
    clearTimeout(draftWriteTimer);
    draftWriteTimer = 0;
    try {
      if (!drafts.size) localStorage.removeItem(DRAFTS_KEY);
      else localStorage.setItem(DRAFTS_KEY, JSON.stringify(Object.fromEntries(drafts)));
    } catch {
      // A browser that refuses storage still keeps the draft in memory, which is what it did before.
    }
  }

  /**
   * The store, one pause after the keystroke. `input` fires on every character typed or deleted, and each of
   * those used to serialise every dirty prompt into localStorage with nothing reading it in between. Quiet
   * for a moment is what makes the text a draft worth writing; a page that goes away writes what is pending.
   */
  function saveDraftsSoon() {
    clearTimeout(draftWriteTimer);
    draftWriteTimer = setTimeout(saveDrafts, DRAFT_WRITE_MS);
  }

  window.addEventListener("pagehide", () => {
    if (draftWriteTimer) saveDrafts();
  });

  function readCollapseMap() {
    try {
      return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "{}") || {};
    } catch {
      return {};
    }
  }

  function writeCollapse(path, collapsed) {
    try {
      const map = readCollapseMap();
      map[path] = collapsed;
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(map));
    } catch {
      // A browser that refuses storage still gets a working page; it just forgets the shape.
    }
  }

  /** Every leaf under a group, at any depth: a closed group has to summarise what it hides. */
  function leavesOf(group) {
    const found = [...(group.fields || [])];
    for (const child of group.groups || []) found.push(...leavesOf(child));
    return found;
  }

  function lineOf(field) {
    const labels = Array.isArray(field.labels) ? field.labels : ["off", "on"];
    if (field.type === "toggle") return `${field.label}: ${field.value ? labels[labels.length - 1] : labels[0]}`;
    // A prompt's value is a whole file, so a folded group names the file and says nothing about its text.
    if (field.type === "prompt") return field.label;
    const value = String(field.value ?? "");
    if (!value) return `${field.label}: none`;
    const parts = value.split("/");
    return `${field.label}: ${parts.length > 2 ? `${parts[0]}/…/${parts[parts.length - 1]}` : value}`;
  }

  function previewText(group) {
    const leaves = leavesOf(group);
    // A group whose every leaf is a prompt counts them: ten file names in a line that is clipped anyway say
    // less than "10 prompts". A group of settings keeps the `label: value` preview its leaves give. Both
    // rules read the leaves, so a group added to the document tomorrow is summarised without a line here.
    if (leaves.length && leaves.every((field) => field.type === "prompt")) return countLine(leaves.length, group.label);
    return leaves.map(lineOf).join(" · ");
  }

  /**
   * "10 prompts", "1 prompt": the noun is the group's own label, and a label whose singular is not its
   * plural minus an `s` is spelled out below. A label nobody spelled out stays as it is, because slicing
   * `-ies` or `-es` produces a word nobody wrote.
   */
  const SINGULARS = { prompts: "prompt" };
  function countLine(count, label) {
    const noun = String(label || "item").toLowerCase();
    return count === 1 ? `1 ${SINGULARS[noun] ?? noun}` : `${count} ${noun}`;
  }

  /** The footer's readout: how many prompts are waiting to be saved, or what the page does when none are. */
  function readoutText(fallback) {
    if (!drafts.size) return fallback;
    return `unsaved · ${drafts.size} prompt${drafts.size === 1 ? "" : "s"} kept`;
  }

  function refreshPreviews() {
    for (const { group, preview } of previews.values()) preview.textContent = previewText(group);
  }

  function setSaved(state, text) {
    nodes.saveStatus.dataset.state = state;
    nodes.saveStatus.textContent = text;
  }

  /** The badge for text somebody typed and did not save, which came back with it across a view switch. */
  function draftBadge() {
    if (!drafts.size) return ["", ""];
    if (drafts.size > 1) return ["dirty", `not saved · ${drafts.size} prompts`];
    const entry = entries.get(drafts.keys().next().value);
    return ["dirty", `not saved · ${entry?.field.label ?? "a prompt"}`];
  }

  function showFieldError(entry, message) {
    entry.message.textContent = message;
    entry.error.hidden = false;
    entry.row.classList.add("has-error");
  }

  function clearFieldError(entry) {
    entry.error.hidden = true;
    entry.row.classList.remove("has-error");
  }

  /** One control can write two keys: the document says how, so no field is special-cased here. */
  function patchOf(field, value) {
    const store = field.store;
    if (store && typeof store.split === "string" && Array.isArray(store.keys) && store.keys.length >= 2) {
      const text = String(value ?? "");
      const cut = text.indexOf(store.split);
      // A box without its separator is a half-typed answer: let the daemon refuse it in its own words.
      if (cut < 1) return { [store.keys[0]]: "", [store.keys[1]]: text };
      return { [store.keys[0]]: text.slice(0, cut), [store.keys[1]]: text.slice(cut + store.split.length) };
    }
    return { [field.id]: value };
  }

  /**
   * What the daemon says it now holds for a field. The answer to a write is the only account of what was
   * saved, so the readout is painted from it: a value that did not reach the store is never reported as
   * the value on disk.
   */
  function savedValueOf(field, defaults, fallback) {
    if (!defaults || typeof defaults !== "object") return fallback;
    const keys = field.store?.keys;
    if (Array.isArray(keys)) {
      const parts = keys.map((key) => defaults[key]);
      if (parts.length && parts.every((one) => one !== undefined && one !== null && one !== "")) {
        return parts.join(field.store?.split ?? "/");
      }
      return fallback;
    }
    return Object.hasOwn(defaults, field.id) ? defaults[field.id] : fallback;
  }

  /**
   * The body a field's own `write` mapping asks for: its fixed keys as written, and `@value` standing for
   * the control's value. Nothing here knows which route a field names.
   */
  function bodyOf(write, value) {
    const body = {};
    for (const [key, given] of Object.entries(write.keys || {})) body[key] = given === "@value" ? value : given;
    return body;
  }

  /** A field that carries a `write` mapping is saved when the human says so, not on every change. */
  async function commitWrite(entry, value, paint) {
    const field = entry.field;
    const write = field.write;
    if (!write?.route) return;
    const method = write.method || "POST";
    const route = `${write.route}${write.route.includes("?") ? "&" : "?"}${qs()}`;
    const body = bodyOf(write, value);
    paint("saving…", "dirty");
    setSaved("dirty", `saving… · ${field.label}`);
    try {
      const response = await fetch(route, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const reason = (await response.text()).slice(0, 160) || response.statusText;
        showFieldError(entry, `${response.status} ${reason}`);
        setSaved("error", `not saved · ${field.label}`);
        nodes.settingsReadout.textContent = `${method} ${write.route} → ${response.status} · ${field.label}`;
        paint("not saved", "error");
        return;
      }
      await response.json();
      // The daemon keeps the bytes it was given, so what it accepted is what the field holds now.
      entry.lastGood = value;
      field.value = value;
      clearFieldError(entry);
      setSaved("saved", `saved · ${field.label}`);
      nodes.settingsReadout.textContent = `${method} ${write.route} → 200 · ${field.label}`;
      paint("saved", "saved");
      refreshPreviews();
    } catch (error) {
      showFieldError(entry, `${error.message || error}`);
      setSaved("error", `not saved · ${field.label}`);
      nodes.settingsReadout.textContent = `not saved · ${field.label}`;
      paint("not saved", "error");
    }
  }

  async function commit(entry, value) {
    const field = entry.field;
    const patch = patchOf(field, value);
    setSaved("dirty", "saving…");
    try {
      const response = await fetch(`/defaults?${qs()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!response.ok) {
        const reason = (await response.text()).slice(0, 160) || response.statusText;
        showFieldError(entry, `${response.status} ${reason}`);
        setSaved("error", `not saved · ${field.label}`);
        nodes.settingsReadout.textContent = `POST /defaults ${JSON.stringify(patch)} → ${response.status}`;
        refreshPreviews();
        return;
      }
      const answer = await response.json();
      field.value = savedValueOf(field, answer?.defaults, value);
      entry.lastGood = field.value;
      clearFieldError(entry);
      setSaved("saved", `saved · ${field.label}`);
      nodes.settingsReadout.textContent = lineOf(field);
      refreshPreviews();
    } catch (error) {
      showFieldError(entry, `${error.message || error}`);
      setSaved("error", `not saved · ${field.label}`);
      // A request that never got an answer leaves the store where it was, so the readout says that
      // rather than keeping the last value standing.
      nodes.settingsReadout.textContent = `not saved · ${field.label}`;
      refreshPreviews();
    }
  }

  /** The route a field's values come from, as one muted tag; `wording` says what the route holds. */
  function sourceTag(field, wording) {
    const tag = el("span", "cfg-source-tag", field.source);
    tag.title = `${wording} ${field.source}`;
    return tag;
  }

  /**
   * The control a field draws, decided by its `type` and by the lists in the document. Nothing here
   * knows a field's id: a fourth field, or a fifth level, arrives with the document alone.
   */
  function controlFor(field, entry) {
    const options = field.options || field.levels || [];
    const disabled = Boolean(field.disabled);
    const line = el("div", "cfg-control-line");

    if (field.type === "combo") {
      const listId = `options-${field.id}`;
      const input = el("input", "cfg-input");
      input.type = "text";
      input.id = `field-${field.id}`;
      input.value = String(field.value ?? "");
      input.placeholder = field.placeholder || "";
      input.spellcheck = false;
      input.autocomplete = "off";
      input.disabled = disabled;
      input.setAttribute("list", listId);
      const catalog = document.createElement("datalist");
      catalog.id = listId;
      for (const option of options) {
        const item = document.createElement("option");
        item.value = String(option);
        catalog.append(item);
      }
      input.addEventListener("change", () => void commit(entry, input.value.trim()));
      entry.set = (value) => {
        input.value = String(value ?? "");
      };
      line.append(input, catalog);
    } else if (field.type === "select" && options.length > 6) {
      // Too many levels to read as a segmented row: a plain select keeps the row one line tall.
      const select = el("select", "cfg-select");
      select.id = `field-${field.id}`;
      select.disabled = disabled;
      for (const option of options) {
        const item = document.createElement("option");
        item.value = String(option);
        item.textContent = String(option);
        item.selected = field.value === option;
        select.append(item);
      }
      select.addEventListener("change", () => void commit(entry, select.value));
      entry.set = (value) => {
        select.value = String(value ?? "");
      };
      line.append(select);
    } else if (field.type === "select" || field.type === "toggle") {
      const labels = Array.isArray(field.labels) ? field.labels : ["off", "on"];
      const choices =
        field.type === "toggle"
          ? [
              [true, labels[labels.length - 1]],
              [false, labels[0]],
            ]
          : options.map((option) => [option, String(option)]);
      const seg = el("div", "seg-row");
      seg.setAttribute("role", "group");
      seg.setAttribute("aria-label", field.label);
      const buttons = new Map();
      for (const [value, text] of choices) {
        const button = el("button", "", String(text));
        button.type = "button";
        button.disabled = disabled;
        button.setAttribute("aria-pressed", String(field.value === value));
        button.addEventListener("click", () => {
          for (const [other, node] of buttons) node.setAttribute("aria-pressed", String(other === value));
          void commit(entry, value);
        });
        buttons.set(value, button);
        seg.append(button);
      }
      entry.set = (value) => {
        for (const [other, node] of buttons) node.setAttribute("aria-pressed", String(other === value));
      };
      line.append(seg);
    } else if (field.type === "prompt") {
      // A prompt is a file, not a setting: the text stays dirty until the human presses this field's own
      // save, because a file written on every keystroke is not a file anybody meant. `write` says where
      // the text goes, so the same control serves any field that names a route.
      line.classList.add("cfg-control-stack");
      // The box holds the text and takes the caret; the mirror behind it draws the same characters as
      // markdown, so the markers are visible while they are being typed rather than only after a save.
      const shell = el("div", "cfg-editor");
      const mirror = el("pre", "cfg-mark");
      mirror.setAttribute("aria-hidden", "true");
      const area = el("textarea", "cfg-prompt");
      area.id = `field-${field.id}`;
      area.value = String(field.value ?? "");
      area.rows = 10;
      area.spellcheck = false;
      area.disabled = disabled;
      const actions = el("div", "cfg-prompt-actions");
      const size = el("span", "cfg-prompt-size", "");
      /**
       * The mirror's html, the box's height and the size readout, all three from the text. The box grows
       * with the prompt instead of scrolling inside itself: an inner scrollbar would leave one layer
       * narrower than the other, and the two would then wrap different lines.
       */
      const repaint = () => {
        mirror.innerHTML = markPrompt(area.value);
        size.textContent = sizeLine(area.value);
        // A box inside a closed group has no layout to measure, so it is left at the height its own text
        // will ask for; the capture listener on the tree repaints it the moment that group opens.
        if (!area.scrollHeight) return;
        area.style.height = "auto";
        area.style.height = `${Math.min(area.scrollHeight, PROMPT_MAX_H)}px`;
        // Once the box is tall enough to scroll, the mirror takes the width the scrollbar took from the
        // box and follows it down: a mirror one scrollbar wider would wrap the same text on other lines.
        mirror.style.width = `${area.clientWidth}px`;
        mirror.scrollTop = area.scrollTop;
      };
      area.addEventListener("scroll", () => {
        mirror.scrollTop = area.scrollTop;
      });
      repaintPrompts.add(repaint);
      markdownKeys(area);
      const save = el("button", "cfg-prompt-save", "save");
      save.type = "button";
      save.disabled = disabled;
      const back = el("button", "cfg-revert", "revert");
      back.type = "button";
      back.title = "put the last saved text back";
      back.disabled = disabled;
      const state = el("span", "cfg-prompt-state", "");
      const paint = (text, tone) => {
        state.textContent = text;
        state.dataset.state = tone || "";
      };
      area.addEventListener("input", () => {
        repaint();
        // Only text that differs from the file on disk is a draft; typing a character and deleting it again
        // puts the field back where it was, and says so.
        const dirty = area.value !== String(entry.lastGood ?? "");
        if (dirty) drafts.set(field.id, area.value);
        else drafts.delete(field.id);
        saveDraftsSoon();
        paint(dirty ? "unsaved" : "saved", dirty ? "dirty" : "saved");
      });
      // Text typed before the tree was last rebuilt is still the human's, and comes back unsaved. A draft
      // that now matches the file was saved from another tab, so it is not a draft any more; the store is
      // written once the whole tree is drawn, not once per field.
      const draft = drafts.get(field.id);
      if (draft !== undefined && draft === String(field.value ?? "")) drafts.delete(field.id);
      else if (draft !== undefined) {
        area.value = draft;
        paint("unsaved", "dirty");
      }
      repaint();
      save.addEventListener("click", () => {
        void commitWrite(entry, area.value, paint).then(() => {
          // What the daemon accepted is no longer a draft; a refusal keeps the text, so nothing is lost.
          if (entry.field.value === area.value) {
            drafts.delete(field.id);
            saveDrafts();
          }
        });
      });
      back.addEventListener("click", () => {
        area.value = String(entry.lastGood ?? "");
        repaint();
        drafts.delete(field.id);
        saveDrafts();
        clearFieldError(entry);
        paint("reverted", "saved");
        // A revert answers a refusal, so the header badge and the footer stop saying "not saved" — unless
        // another prompt is still dirty, and then they keep saying how many are.
        const [state, text] = draftBadge();
        setSaved(state || "saved", text || `reverted · ${field.label}`);
        nodes.settingsReadout.textContent = readoutText(lineOf(field));
      });
      entry.set = (value) => {
        area.value = String(value ?? "");
        repaint();
      };
      actions.append(save, back, state, size);
      // A prompt's source is the file its text is read from, so the tag rides the line its save and revert
      // sit on rather than taking a row of its own under them.
      if (field.source) actions.append(sourceTag(field, "this text is read from and written to"));
      shell.append(mirror, area);
      line.append(shell, actions);
    } else {
      // `text` and `number`, and any type a later document adds: an input is the honest fallback.
      const input = el("input", "cfg-input");
      input.type = field.type === "number" ? "number" : "text";
      input.id = `field-${field.id}`;
      input.value = String(field.value ?? "");
      if (field.placeholder) input.placeholder = field.placeholder;
      if (field.min !== undefined) input.min = String(field.min);
      if (field.max !== undefined) input.max = String(field.max);
      if (field.step !== undefined) input.step = String(field.step);
      input.disabled = disabled;
      input.addEventListener("change", () => {
        void commit(entry, input.type === "number" ? Number(input.value) : input.value);
      });
      entry.set = (value) => {
        input.value = String(value ?? "");
      };
      line.append(input);
    }

    // A field the page writes to a route reads its text from that route; every other source is the list the
    // daemon fills the options from. The prompt case is answered above, on its own actions line.
    if (field.source && !field.write) line.append(sourceTag(field, "options filled in by the daemon from"));
    return line;
  }

  function fieldRow(field) {
    // A prompt is a file of text, so its row is shaped for one: label above, control across the group.
    const wide = field.type === "prompt" ? " is-wide" : "";
    const row = el("div", `cfg-field${field.disabled ? " is-disabled" : ""}${wide}`);
    row.dataset.fieldId = field.id;

    const meta = el("div", "cfg-field-meta");
    const label = el("label", "cfg-field-label", field.label);
    label.htmlFor = `field-${field.id}`;
    meta.append(label, el("span", "cfg-field-id", field.store?.keys ? field.store.keys.join(" + ") : field.id));

    const control = el("div", "cfg-field-control");
    const entry = { field, row, lastGood: field.value, set: () => {}, error: null, message: null };
    control.append(controlFor(field, entry));
    if (field.help) control.append(el("p", "cfg-field-help", field.help));

    // A refusal belongs to the field that caused it, next to the way back to the last good value.
    const error = el("p", "cfg-field-error");
    const message = el("span");
    const revert = el("button", "cfg-revert", "revert");
    revert.type = "button";
    revert.title = "put the last saved value back";
    revert.addEventListener("click", () => {
      entry.set(entry.lastGood);
      entry.field.value = entry.lastGood;
      clearFieldError(entry);
      setSaved("saved", `reverted · ${field.label}`);
      nodes.settingsReadout.textContent = lineOf(field);
      refreshPreviews();
    });
    error.append(message);
    // A field with its own `write` already carries its own revert beside the control, so this row only
    // says what the daemon said.
    if (!field.write) error.append(revert);
    error.hidden = true;
    entry.error = error;
    entry.message = message;
    control.append(error);

    entries.set(field.id, entry);
    row.append(meta, control);
    return row;
  }

  function paintFoldAll() {
    const groups = [...nodes.tree.querySelectorAll(".cfg-group")];
    nodes.foldAll.textContent = groups.some((group) => group.open) ? "collapse all" : "expand all";
  }

  /** One recursive walk: any depth of groups, any mix of fields and children, becomes the tree. */
  function walkGroup(group, depth, parentPath, collapseMap) {
    const path = parentPath ? `${parentPath}.${group.id}` : group.id;
    const details = el("details", "cfg-group");
    details.dataset.depth = String(depth);
    details.dataset.path = path;
    const collapsed = path in collapseMap ? Boolean(collapseMap[path]) : Boolean(group.collapsed);
    details.open = !collapsed;

    const summary = el("summary", "cfg-summary");
    const left = el("div", "cfg-sum-left");
    const caret = el("span", "cfg-caret", "▸");
    caret.setAttribute("aria-hidden", "true");
    left.append(caret, el("span", "cfg-label", group.label));
    if (group.status) left.append(el("span", "cfg-status-badge", group.status));
    if (group.help) left.append(el("span", "cfg-inline-help", group.help));

    const right = el("div", "cfg-sum-right");
    const preview = el("span", "cfg-folded-preview", previewText(group));
    right.append(preview);
    summary.append(left, right);
    details.append(summary);

    // A group remembers itself, so a reload keeps the shape the human left the tree in.
    details.addEventListener("toggle", () => {
      writeCollapse(path, !details.open);
      paintFoldAll();
    });

    const body = el("div", "cfg-body");
    if (group.fields?.length) {
      const rows = el("div", "cfg-fields");
      for (const field of group.fields) rows.append(fieldRow(field));
      body.append(rows);
    }
    for (const child of group.groups || []) body.append(walkGroup(child, depth + 1, path, collapseMap));
    details.append(body);

    previews.set(details, { group, preview });
    return details;
  }

  function renderDocument() {
    entries.clear();
    previews.clear();
    repaintPrompts.clear();
    nodes.docTitle.textContent = doc.title || "Settings";
    // The head counts settings: a prompt is a file the page also carries, and is not one of them.
    const settings = leavesOf(doc).filter((field) => field.type !== "prompt").length;
    nodes.docVersion.textContent = `v${doc.version ?? 1} · ${settings} settings`;
    nodes.docHelp.textContent = doc.help || "";
    const collapseMap = readCollapseMap();
    nodes.tree.replaceChildren(...(doc.groups || []).map((group) => walkGroup(group, 0, "", collapseMap)));
    // A prompt file that left the disk takes its draft with it; the rest were just put back into the tree.
    // The store is written here, once, for every draft the drawing itself dropped.
    for (const id of [...drafts.keys()]) if (!entries.has(id)) drafts.delete(id);
    saveDrafts();
    paintFoldAll();
  }

  async function loadDocument() {
    try {
      const response = await fetch(`/settings/defaults?${qs()}`);
      if (!response.ok) throw new Error((await response.text()).slice(0, 160) || response.statusText);
      doc = await response.json();
      renderDocument();
      // The tree opens as the daemon just read it, so no badge: a badge reports an action somebody took,
      // and nobody has taken one yet. Unsaved text that came back with the tree is the one exception.
      setSaved(...draftBadge());
      nodes.settingsReadout.textContent = readoutText("defaults save on change · prompts when you press save");
    } catch (error) {
      doc = null;
      entries.clear();
      previews.clear();
      nodes.docTitle.textContent = "Settings";
      nodes.docVersion.textContent = "";
      nodes.docHelp.textContent = "";
      nodes.tree.replaceChildren(
        el("p", "settings-failure", `could not read the settings document from the daemon: ${error.message || error}`),
      );
      setSaved("", "");
      nodes.settingsReadout.textContent = "";
    }
  }

  // ---------- the two views ------------------------------------------------

  function showView(next) {
    view = next;
    const settings = next === "settings";
    nodes.settingsView.hidden = !settings;
    nodes.shelfView.hidden = settings;
    nodes.back.hidden = !settings;
    nodes.door.hidden = settings;
    document.title = settings ? "pi-studio · settings" : "pi-studio";
    paintBrand();
    if (settings) {
      void loadDocument().then(() => nodes.tree.focus());
      return;
    }
    nodes.omni.focus();
  }

  nodes.door.addEventListener("click", () => showView("settings"));
  nodes.back.addEventListener("click", () => showView("shelf"));
  nodes.browse.addEventListener("click", () => void browse());
  nodes.omni.addEventListener("input", () => {
    // Typing clears the last refusal: the human is already answering it.
    pathError = "";
    applyFilter();
  });
  nodes.foldAll.addEventListener("click", () => {
    const groups = [...nodes.tree.querySelectorAll(".cfg-group")];
    const open = !groups.some((group) => group.open);
    for (const group of groups) {
      group.open = open;
      writeCollapse(group.dataset.path, !open);
    }
    paintFoldAll();
  });

  document.addEventListener("keydown", (event) => {
    if (event.altKey && event.key.toLowerCase() === "m") {
      event.preventDefault();
      showView(view === "settings" ? "shelf" : "settings");
      return;
    }

    if (event.key === "Escape") {
      if (view === "settings") {
        event.preventDefault();
        showView("shelf");
        return;
      }
      if (nodes.omni.value || pathError) {
        event.preventDefault();
        nodes.omni.value = "";
        pathError = "";
        applyFilter();
        nodes.omni.focus();
      }
      return;
    }

    if (view !== "shelf") return;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const visible = [...nodes.list.children].filter((row) => !row.hidden);
      if (!visible.length) return;
      event.preventDefault();
      const at = visible.findIndex((row) => row.dataset.id === selectedId);
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = visible[Math.min(Math.max(at < 0 ? 0 : at + step, 0), visible.length - 1)];
      selectedId = next.dataset.id;
      markSelected(selectedId);
      // A row that had the keyboard keeps it; the omnibar is where it usually lives.
      if (document.activeElement?.classList.contains("ws-row")) next.focus();
      return;
    }

    if (event.key === "Enter") {
      const active = document.activeElement;
      // Buttons own their own Enter: browse… must not also open a board.
      if (active === nodes.browse) return;
      if (active === nodes.omni || active === document.body || active?.classList.contains("ws-row")) {
        event.preventDefault();
        actOnEnter();
      }
    }
  });

  if (!token) {
    nodes.list.hidden = true;
    nodes.empty.hidden = false;
    nodes.emptyTitle.textContent = "This page was opened without a token.";
    nodes.emptyCopy.textContent = "Use the URL pi-studio printed, the one ending in ?token=…";
    return;
  }

  showView("shelf");
  void load();

  // Counts on this page are live: a thread that starts or settles elsewhere shows up here.
  const stream = new EventSource(`/events?scope=welcome&${qs()}`);
  stream.onmessage = (message) => {
    try {
      const payload = JSON.parse(message.data);
      if (payload.type === "workspaces") adopt(payload.workspaces);
    } catch {
      // A frame that is not JSON is not worth breaking the page over.
    }
  };
})();

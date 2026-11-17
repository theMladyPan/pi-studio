/**
 * The glue between a browser tab and mhutchie's Git Graph bundle.
 *
 * The bundle was written for an editor panel. It expects a global `acquireVsCodeApi` before it is
 * parsed, three globals — `initialState`, `globalState`, `workspaceState` — before it draws, and a
 * `message` event on `window` for every reply. An editor supplied all of that, plus a diff editor and a
 * clipboard; this file supplies the same three things over HTTP and hands the diff to the page's own
 * viewer.
 *
 * What it is not: it holds no graph code, no protocol knowledge beyond three command names, and no
 * state of its own. Every command goes to `POST /git/msg` and every reply is delivered to the bundle
 * exactly as an editor would have delivered it, so the bundle cannot tell the difference and this file
 * never has to grow a second copy of its logic.
 */
import { showView } from "./viewer.js";

// ---------- where this page is ----------

/** The workspace id in the path, which is the only thing that tells two tabs apart. */
const WORKSPACE_ID = /^\/git\/([0-9a-f]{6,64})\/?$/.exec(location.pathname)?.[1] ?? "";
const ORIGIN = location.origin;
const STORAGE_KEY = `pi-studio.gitgraph.v1.${WORKSPACE_ID}`;

/** The commands the page answers itself: a browser has a clipboard and a tab, a daemon has neither. */
const LOCAL_COMMANDS = new Set(["copyToClipboard", "copyFilePath", "openExternalUrl"]);

/** True when this page is in an iframe on the board, which decides whether the board hears from it. */
const FRAMED = window.parent !== window;

// ---------- the page's own storage ----------

/** What the bundle saved last time, or null: a store the browser blocks is not a reason to fail. */
function readState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Save what the bundle asked to keep. A blocked or full store is ignored on purpose. */
function writeState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private modes and full quotas both land here, and neither is worth breaking a graph over.
  }
}

// ---------- the clipboard, without an editor ----------

/**
 * Put text on the clipboard, falling back to a selection the human can copy by hand.
 *
 * The async clipboard API is refused in a frame that has not been granted `clipboard-write`, which is
 * the normal case for a page inside a board, so the fallback is the path that actually runs there.
 */
async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Refused by the browser's permission rules: the textarea below is the answer.
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  try {
    document.execCommand("copy");
  } catch {
    // Nothing left to try: the daemon is told the copy failed, and the bundle says so.
  }
  field.remove();
}

// ---------- what the bundle is handed instead of an editor ----------

/**
 * `acquireVsCodeApi`, which the bundle calls at parse time and expects to be there.
 *
 * One cached object, because the bundle treats it as a singleton: `getState` and `setState` persist to
 * this page's own key in `localStorage`, which is closer to what the editor did than a second HTTP
 * round trip per scroll position.
 */
function installVsCodeApi() {
  let state = readState();
  const api = {
    getState: () => state,
    setState: (next) => {
      state = next;
      writeState(next);
    },
    postMessage: (message) => {
      void deliver(message);
    },
  };
  window.acquireVsCodeApi = () => api;
}

/** Hand one reply to the bundle, exactly as an editor's `postMessage` would have. */
function toPage(reply) {
  window.dispatchEvent(new MessageEvent("message", { data: reply }));
}

/**
 * One message from the bundle: the three the page answers itself, and everything else sent to the
 * daemon.
 *
 * A reply carrying text is shown in the viewer first, because that is the one thing the editor did
 * that the bundle cannot: it asked VS Code to open a diff document. The bundle still sees the reply
 * afterwards, which is how it closes the spinner it opened and reports an error it was given.
 */
async function deliver(message) {
  if (!message || typeof message !== "object") return;
  const command = message.command;
  if (LOCAL_COMMANDS.has(command)) {
    toPage(await local(command, message));
    return;
  }
  let replies;
  try {
    const response = await fetch(`/git/msg?workspace=${encodeURIComponent(WORKSPACE_ID)}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    if (response.status === 403) {
      notice("this tab is not signed in", "open the board from the link the daemon printed");
      return;
    }
    replies = await response.json();
  } catch (error) {
    toPage({ command, error: `the daemon could not be reached: ${error.message}` });
    return;
  }
  for (const reply of Array.isArray(replies) ? replies : []) {
    if (reply && reply.view) showView(reply.view);
    toPage(reply);
  }
}

/** The three commands a browser answers for itself, each returning the reply the bundle expects. */
async function local(command, message) {
  try {
    if (command === "copyToClipboard") {
      await copyText(String(message.data ?? ""));
    } else if (command === "copyFilePath") {
      await copyText(message.absolute ? `${message.repo}/${message.filePath}` : message.filePath);
    } else {
      // `noopener,noreferrer` because the address came out of a commit message: a link a human may
      // follow and must not hand this tab's state to.
      window.open(message.url, "_blank", "noopener,noreferrer");
    }
    return { command, error: null };
  } catch (error) {
    return { command, error: error.message };
  }
}

// ---------- what the board says to this page ----------

/**
 * The board's own control messages. Only a message from the tab that framed this one, on this origin,
 * is worth reading: anything else is a stranger's.
 */
window.addEventListener("message", (event) => {
  if (event.origin !== ORIGIN || event.source !== window.parent) return;
  const data = event.data;
  if (!data || data.source !== "pi-studio") return;
  if (data.type === "focus") document.getElementById("view")?.focus();
});

// ---------- starting the bundle ----------

/**
 * Load the vendor bundle and start it.
 *
 * The bundle does all of its work inside one `window` `load` listener guarded by a once flag, with no
 * `readyState` fallback: a page that loads it after the document has already finished loading would
 * leave it asleep forever. So the event is dispatched by hand after the script has run, which is the
 * only moment the handler it installed can be reached.
 */
function startBundle() {
  const script = document.createElement("script");
  script.src = "/gitgraph/vendor/out.min.js";
  script.onerror = () => notice("the Git Graph bundle could not be loaded", "the daemon answered /gitgraph/vendor/out.min.js with an error. Reopen this tab; if it comes back, run `npm run check` to see why the vendor route fails.");
  script.onload = () => {
    window.dispatchEvent(new Event("load"));
    if (FRAMED) window.parent.postMessage({ source: "pi-gitgraph", type: "ready" }, ORIGIN);
  };
  document.body.append(script);
}

/** Ask the daemon what this page may draw, and either start the bundle or say why it cannot. */
async function init() {
  if (!WORKSPACE_ID) {
    notice("this address is not a Git Graph page", "the workspace id is missing from the path. Open the board's Git Graph tab again.");
    return;
  }
  let payload;
  try {
    const response = await fetch(`/git/init?workspace=${encodeURIComponent(WORKSPACE_ID)}`, { credentials: "same-origin" });
    if (response.status === 403) {
      notice("this tab is not signed in", "open the board from the link the daemon printed.");
      return;
    }
    if (!response.ok) {
      notice("the Git Graph view could not start", `the daemon answered /git/init with ${response.status}.`);
      return;
    }
    payload = await response.json();
  } catch (error) {
    notice("the daemon could not be reached", error.message);
    return;
  }
  if (!payload || !payload.available) {
    notice("this tab cannot draw a graph", (payload && payload.reason) || "the daemon did not say why.");
    return;
  }
  window.initialState = payload.initialState;
  window.globalState = payload.globalState;
  window.workspaceState = payload.workspaceState;
  document.getElementById("ggNotice").hidden = true;
  document.getElementById("view").hidden = false;
  startBundle();
}

// ---------- the two keys the board owns ----------

/**
 * What is open, and therefore what a `g` or an `Escape` must not steal.
 *
 * The bundle listens on `document` in the bubbling phase and swallows the keys it handles, so an event
 * that reaches this listener has not been used by it. These are the surfaces it considers open: its
 * context menu, its dialogs, an open dropdown, its find bar, its settings panel and its commit details
 * view. `#ggViewer` is the page's own: a diff drawn over the graph is as open as any of them.
 */
const OPEN_SURFACE = "ul.contextMenu, div.dialog, .dropdown.dropdownOpen, .findWidget.active, #settingsWidget.active, #cdv, #ggViewer:not([hidden])";

/** Whether the human is typing, in which case a letter belongs to the field and not to the board. */
function typing(target) {
  return target instanceof Element && target.closest("input, textarea, select, [contenteditable]") !== null;
}

/**
 * Close the board's Git Graph tab, which is a decision this page cannot make: `g`, or `Escape` where
 * nothing else wanted it. Installed only when the page is framed, because a page opened on its own has
 * no tab to close.
 */
window.addEventListener("keydown", (event) => {
  if (!FRAMED) return;
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
  if (typing(event.target)) return;
  if (document.querySelector(OPEN_SURFACE) !== null) return;
  if (event.key !== "g" && event.key !== "Escape") return;
  event.preventDefault();
  window.parent.postMessage({ source: "pi-gitgraph", type: "close" }, ORIGIN);
});

// ---------- saying why there is nothing ----------

/**
 * Replace the graph with a sentence. A page that has nothing to draw owes the human the reason, and
 * hiding `#view` keeps a half-built controls row from looking like a broken graph.
 */
function notice(title, detail) {
  const box = document.getElementById("ggNotice");
  document.getElementById("ggNoticeTitle").textContent = title;
  document.getElementById("ggNoticeDetail").textContent = detail;
  box.hidden = false;
  document.getElementById("view").hidden = true;
}

installVsCodeApi();
void init();

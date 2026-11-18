/**
 * The glue between a browser tab and the Git Graph Libre bundle.
 *
 * The bundle was written for an editor panel. It expects a global
 * `acquireVsCodeApi` before it is parsed, two globals — `viewState` and
 * `l10n` — before it draws, and a `message` event on `window` for every
 * reply. An editor supplied all of that, plus a diff editor and a clipboard;
 * this file supplies the same over HTTP and hands the diff to the page's own
 * viewer.
 *
 * What it is not: it holds no graph code, no protocol knowledge beyond that
 * the replies come back, and no state of its own beyond this page's
 * `localStorage` slot. Every command goes to `POST /git/msg` and every reply
 * is delivered to the bundle exactly as an editor would have delivered it.
 */
import { showView } from "./viewer.js";

/** The workspace id in the path, which is the only thing that tells two tabs apart. */
const WORKSPACE_ID = /^\/git\/([0-9a-f]{6,64})\/?$/.exec(location.pathname)?.[1] ?? "";
const ORIGIN = location.origin;
const STORAGE_KEY = `pi-studio.gitgraph.v1.${WORKSPACE_ID}`;

/** The commands the page answers itself: a browser has a clipboard and a tab, a daemon has neither. */
const LOCAL_COMMANDS = new Set(["copyToClipboard", "openExternalUrl"]);

/** True when this page is in an iframe on the board, which decides whether the board hears from it. */
const FRAMED = window.parent !== window;

// ---------- storage ----------

function readState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function writeState(state) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
}

// ---------- l10n ----------

/**
 * Turn the bundle's raw `bundle.l10n.json` (`ui.repo`, `dialog.addTag.title`, …)
 * into the `l10n` global the webview reads (`repo`, `dialogAddTagTitle`, …).
 * The two prefixes the webview drops are stripped; everything else is
 * camel-cased. A proxy falls back to a case-insensitive hit and then to the
 * key itself, so one irregular key (`time.dateformat`) never blanks the view.
 */
function buildL10n(raw) {
  const out = {};
  const camel = (key) => {
    const parts = key.split(".");
    if (parts[0] === "ui" || parts[0] === "error" || parts[0] === "action") parts.shift();
    if (parts.length === 0) return key;
    return parts[0] + parts.slice(1).map((p) => p ? p[0].toUpperCase() + p.slice(1) : "").join("");
  };
  for (const [k, v] of Object.entries(raw || {})) out[camel(k)] = v;
  out.locale = "en";
  out.localeIsRtl = false;
  out.outputChannel = out.outputChannel || "Git Graph Libre";
  return new Proxy(out, {
    get(target, prop) {
      if (typeof prop !== "string") return target[prop];
      if (prop in target) return target[prop];
      const lower = Object.keys(target).find((k) => k.toLowerCase() === prop.toLowerCase());
      if (lower) return target[lower];
      return prop;
    },
    has(target, prop) { return prop in target; },
  });
}

// ---------- clipboard ----------

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return; }
  } catch {}
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed"; field.style.opacity = "0";
  document.body.append(field); field.select();
  try { document.execCommand("copy"); } catch {}
  field.remove();
}

// ---------- vscode api ----------

function installVsCodeApi() {
  let state = readState();
  const api = {
    getState: () => state,
    setState: (next) => { state = next; writeState(next); },
    postMessage: (message) => { void deliver(message); },
  };
  window.acquireVsCodeApi = () => api;
}
function toPage(reply) { window.dispatchEvent(new MessageEvent("message", { data: reply, origin: ORIGIN, source: window })); }

async function deliver(message) {
  if (!message || typeof message !== "object") return;
  const command = message.command;
  if (LOCAL_COMMANDS.has(command)) { toPage(await local(command, message)); return; }
  let replies;
  try {
    const response = await fetch(`/git/msg?workspace=${encodeURIComponent(WORKSPACE_ID)}`, {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    if (response.status === 403) { notice("this tab is not signed in", "open the board from the link the daemon printed"); return; }
    replies = await response.json();
  } catch (error) {
    toPage({ command, error: { message: `the daemon could not be reached: ${error.message}`, stderr: null, exitCode: null, task: null } });
    return;
  }
  for (const reply of Array.isArray(replies) ? replies : []) {
    if (reply && reply.view) showView(reply.view);
    if (reply && reply.command === "refresh") { toPage({ command: "refresh" }); continue; }
    toPage(reply);
  }
}
async function local(command, message) {
  try {
    if (command === "copyToClipboard") await copyText(String(message.data ?? ""));
    else if (command === "openExternalUrl") window.open(message.url, "_blank", "noopener,noreferrer");
    return { command, success: true };
  } catch (error) { return { command, success: false }; }
}

// ---------- board messages ----------

window.addEventListener("message", (event) => {
  if (event.origin !== ORIGIN || event.source !== window.parent) return;
  const data = event.data;
  if (!data || data.source !== "pi-studio") return;
  if (data.type === "focus") {
    const top = document.getElementById("findBtn") || document.getElementById("refreshBtn") || document.body;
    top?.focus?.();
  } else if (data.command === "refresh") {
    // The drawer's soft reload: the webview's own refresh response re-runs repo info,
    // branches and commits without touching scroll or the expanded commit.
    toPage({ command: "refresh" });
  }
});

// ---------- starting ----------

function startBundle() {
  const script = document.createElement("script");
  script.src = "/gitgraph/vendor/web.min.js";
  script.onerror = () => notice("the Git Graph bundle could not be loaded", "the daemon answered /gitgraph/vendor/web.min.js with an error. Reopen this tab; if it comes back, run `npm run check` to see why the vendor route fails.");
  script.onload = () => {
    if (FRAMED) window.parent.postMessage({ source: "pi-gitgraph", type: "ready" }, ORIGIN);
  };
  document.body.append(script);
}

async function init() {
  if (!WORKSPACE_ID) { notice("this address is not a Git Graph page", "the workspace id is missing from the path. Open the board's Git Graph tab again."); return; }
  let payload;
  try {
    const response = await fetch(`/git/init?workspace=${encodeURIComponent(WORKSPACE_ID)}`, { credentials: "same-origin" });
    if (response.status === 403) { notice("this tab is not signed in", "open the board from the link the daemon printed."); return; }
    if (!response.ok) { notice("the Git Graph view could not start", `the daemon answered /git/init with ${response.status}.`); return; }
    payload = await response.json();
  } catch (error) { notice("the daemon could not be reached", error.message); return; }
  if (!payload || !payload.available) { notice("this tab cannot draw a graph", (payload && payload.reason) || "the daemon did not say why."); return; }
  window.viewState = payload.viewState;
  // The bundle's English strings, borrowed from the same installed copy as the code.
  let l10n = buildL10n({});
  try {
    const raw = await fetch("/gitgraph/vendor/bundle.l10n.json", { credentials: "same-origin" }).then((r) => r.ok ? r.json() : {});
    l10n = buildL10n(raw);
  } catch {}
  window.l10n = l10n;
  document.getElementById("ggNotice").hidden = true;
  document.getElementById("topBar").hidden = false;
  document.getElementById("content").hidden = false;
  const gv = document.getElementById("gitVersion");
  if (gv && payload.version) gv.textContent = `v${payload.version}`;
  startBundle();
}

// ---------- keys the board owns ----------

const OPEN_SURFACE = "#contextMenu.active, #dialog.active, #dialogBacking.active, #settingsWidget.active, #ggViewer:not([hidden])";

function typing(target) {
  return target instanceof Element && target.closest("input, textarea, select, [contenteditable]") !== null;
}
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

function notice(title, detail) {
  const box = document.getElementById("ggNotice");
  document.getElementById("ggNoticeTitle").textContent = title;
  document.getElementById("ggNoticeDetail").textContent = detail;
  box.hidden = false;
  document.getElementById("topBar").hidden = true;
  document.getElementById("content").hidden = true;
}

installVsCodeApi();
void init();

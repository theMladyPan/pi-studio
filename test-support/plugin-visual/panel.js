/**
 * The conversation an example plugin panel has with the board — and the whole of it.
 *
 * The frame this page runs in has no origin of its own, so it holds no cookie and has nothing to ask the
 * daemon with. What it has is one message to the board above it, and the board asks with the session the
 * tab already has. The words are:
 *
 *   board → here   { type: "pi-studio.host.hello", nonce, plugin }
 *   here → board   { type: "pi-studio.visual.request", nonce, id, method, params }
 *   board → here   { type: "pi-studio.visual.result", nonce, id, result }
 *   board → here   { type: "pi-studio.visual.error", nonce, id, error: { code, message } }
 *
 * The `nonce` is the board's own secret for the panel it loaded. Nothing is asked before the greeting says
 * what it is, and the greeting names the plugin the board is showing, which is the plugin this page's own
 * calls reach: the page never names one.
 */
let nonce = "";
let nextId = 0;
const pending = new Map();

const status = document.getElementById("status");
const log = document.getElementById("log");

function say(line) {
  log.textContent = `${log.textContent}${line}\n`;
}

window.addEventListener("message", (event) => {
  // The board is the only frame above this one, so a message from anywhere else is not for this page.
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "pi-studio.host.hello") {
    nonce = typeof data.nonce === "string" ? data.nonce : "";
    status.textContent = `connected to ${data.plugin}`;
    return;
  }
  if (nonce === "" || data.nonce !== nonce) return;
  const settle = pending.get(data.id);
  if (!settle) return;
  pending.delete(data.id);
  if (data.type === "pi-studio.visual.result") settle.resolve(data.result);
  else if (data.type === "pi-studio.visual.error") settle.reject(new Error(data.error?.message || "the call failed"));
});

/** One call into the plugin, sent as a message and settled by the answer that comes back. */
function ask(method, params = {}) {
  const id = (nextId += 1);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // `"*"` because this document has no origin of its own to name; the board checks where the message
    // came from rather than where it said it was from.
    window.parent.postMessage({ type: "pi-studio.visual.request", nonce, id, method, params }, "*");
  });
}

document.getElementById("echo").addEventListener("click", async () => {
  try {
    say(JSON.stringify(await ask("echo", { from: "the panel" })));
  } catch (error) {
    say(`refused: ${error.message}`);
  }
});

document.getElementById("now").addEventListener("click", async () => {
  try {
    say(JSON.stringify(await ask("now")));
  } catch (error) {
    say(`refused: ${error.message}`);
  }
});

document.getElementById("close").addEventListener("click", () => {
  window.parent.postMessage({ type: "pi-studio.visual.close", nonce }, "*");
});

/**
 * The terminal drawer: a real shell in a panel that rolls up from the bottom of the board with `x`.
 *
 * Like the git drawer it is one drawer for the life of the page: the terminal screen and its
 * scrollback are made once and kept, so rolling the drawer up and down never loses the shell, its
 * prompt or its scroll position. The shell itself lives on the daemon (one per board, in the
 * workspace folder) and is reached over a socket that is opened on the first roll down and kept;
 * a tab that closes only detaches, and the shell outlives it.
 *
 * The screen is drawn by the vendored terminal library (`Terminal` and the `FitAddon`), loaded as
 * plain scripts before the board module, the way the git graph's page carries its own bundle.
 *
 * Its height is the user's furniture, the way the left rail's width is: a drag on the top edge
 * sets the `--term` property, the shell refits through the same observer that fits it on open,
 * and the height is remembered so a reload rolls it up at the height it was left.
 */

/** One drawer, for the whole life of the page. `typingSomewhere` comes from the board rather than a
 * second copy of the selector here, so the drawer and the board's letters agree on what a field is.
 * It is also what tells an `x` in the shell from an `x` that rolls the drawer up: the terminal's
 * helper is a textarea, so while it holds the keyboard `typingSomewhere` is true and the letter
 * belongs to the shell. */
import { bindDragHeight, createSlidingDrawer, setTermHeight } from "./drawer-common.js";

export function createTerminalDrawer({ workspace, typingSomewhere }) {
  const drawer = document.getElementById("termDrawer");
  const host = document.getElementById("termHost");
  const btn = document.getElementById("termBtn");
  const closeBtn = document.getElementById("tdClose");
  const statusEl = document.getElementById("tdStatus");
  const workspaceLabel = document.getElementById("tdWorkspace");
  const grip = document.getElementById("termGrip");

  // The drawer is the user's furniture: its height survives a reload, the way the rail's width
  // does. What sets it is the shared drawer furniture, since the strips across the board size it too.
  // The last height the drawer was left at, restored before anything is drawn.
  try {
    const saved = Number(localStorage.getItem("board.termHeight")) || 0;
    if (saved) setTermHeight(saved);
  } catch {}

  // Drag handle, the rail grip on its side: press on the top edge, drag up or down, and the
  // drawer follows the cursor. The observer on the host refits the shell as it grows, so no
  // size is told to the daemon here the way it is at connect.
  bindDragHeight(grip, { bodyClass: "term-resizing", resolvePx: (event) => setTermHeight(window.innerHeight - event.clientY) });

  /** The bar names the board the way a human knows it, as the git drawer's bar does. */
  function setName(name) {
    workspaceLabel.textContent = workspace ? `· ${name || workspace}` : "";
  }
  setName("");

  /** Why the shell never started, when it did not. The drawer stays up to let it be read, and the
   * next roll up is a fresh socket rather than a reconnect to a shell that refused. */
  let failed = "";
  /** The terminal screen, made once on the first roll up and kept after that. */
  let term = null;
  let fit = null;
  /** The socket to the daemon's shell, opened on the first roll up and kept. */
  let socket = null;

  // A board with no folder of its own has no workspace to run in, so the drawer says that in the
  // space the terminal would have used rather than opening a socket that cannot answer.
  if (!workspace) {
    const note = document.createElement("p");
    note.className = "td-note";
    note.textContent = "this board has no folder of its own, so there is no terminal to run";
    host.append(note);
  }

  function said(text) {
    statusEl.textContent = text || "";
    // The bar is one line, so a long reason is cut on screen and read in full on hover.
    statusEl.title = text || "";
  }

  /** The roll itself is the shared sliding drawer: the class, the button and the focus return. What is
   * the terminal's is not: the screen, the socket and the fit. */
  const sliding = createSlidingDrawer({
    drawer,
    btn,
    bodyClass: "term-open",
    openTitle: "roll the terminal drawer down (x)",
    shutTitle: "roll the terminal drawer up from the bottom (x)",
    afterOpen() {
      if (ensureTerminal()) {
        connect();
        fitNow();
        term.focus();
      }
    },
  });

  function send(message) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  /** The pty keeps the size it was born with, so a resize is told to the daemon once, at connect. */
  function sendSize() {
    if (term) send({ type: "resize", cols: term.cols, rows: term.rows });
  }

  /** Fit the terminal to its host and tell the shell the size it should have. */
  function fitNow() {
    if (!term || !fit) return;
    try {
      fit.fit();
    } catch {
      // A hidden host has no cell size to fit to; the next open fits again.
    }
    sendSize();
  }

  function connect() {
    if (!workspace) return;
    if (socket && socket.readyState <= WebSocket.OPEN) return;
    failed = "";
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${scheme}//${location.host}/terminal?workspace=${encodeURIComponent(workspace)}`);
    socket.addEventListener("open", () => {
      said("");
      // A fresh socket means a fresh shell: the old screen is cleared so the new prompt does
      // not sit under the dead shell's scrollback. A drawer that was only rolled down never
      // reconnects, so its scrollback survives untouched.
      if (term) term.reset();
      sendSize();
    });
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === "output" && term) term.write(message.data);
      else if (message.type === "exit") {
        // The shell is gone — Ctrl+D, or `exit` typed at the prompt. The drawer rolls
        // down rather than sitting on a dead prompt, and the socket closes with it,
        // so the next roll up connects a fresh shell. An exit that arrives while
        // the drawer is already down still closes the socket. A shell that never
        // started did not exit, though: its reason stays on the bar with the drawer up.
        socket.close();
        if (!failed) close();
      } else if (message.type === "error") {
        // No shell could be made — this machine has no pty helper, or the helper refused. The
        // drawer stays up to say why, and the socket closes so the next roll up starts a new
        // shell instead of writing into one that cannot answer.
        failed = message.data;
        said(failed);
        socket.close();
        // A dead screen would keep the keyboard and eat the `x` that rolls the drawer down, so the
        // bar's own button takes it: the letter that closes the drawer stays a letter of the board.
        if (closeBtn.offsetParent !== null) closeBtn.focus();
      }
    });
    socket.addEventListener("close", () => {
      if (!failed) said("terminal disconnected");
    });
  }

  /** Make the screen once, then keep it: a second roll up finds the same shell and scrollback. */
  function ensureTerminal() {
    if (term) return true;
    if (!workspace) return false;
    if (typeof Terminal === "undefined" || typeof FitAddon === "undefined") {
      said("the terminal library did not load");
      return false;
    }
    term = new Terminal({
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 1000,
    });
    fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(host);
    term.onData((data) => send({ type: "input", data }));
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(() => {
        if (sliding.isOpen()) fitNow();
      }).observe(host);
    }
    return true;
  }

  const close = sliding.close;

  /**
   * `x` reaches this window only while the drawer is up and the focus is outside the terminal.
   * Inside the terminal the letter belongs to the shell (`typingSomewhere` says so), and it
   * listens on the way down so the board's own `x`, which opens the drawer, never sees the press
   * that rolled it down.
   *
   * Escape is the opposite way round: the terminal screen swallows every key in its helper
   * textarea on capture, so a press inside the shell would never reach the board's escape
   * handler and the drawer could not be rolled down from the keyboard while typing. It is taken
   * here instead, before the screen sees it, which means Escape always rolls the drawer down
   * and never reaches the shell — the bar and the `x` key stay the ways back in, and a shell
   * that needed the escape key works with it rolled down.
   */
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (!sliding.isOpen()) return;
      if (event.key === "x") {
        if (typingSomewhere()) return;
      } else if (event.key === "Escape") {
        if (!typingSomewhere()) return;
      } else return;
      event.preventDefault();
      event.stopPropagation();
      close();
    },
    true,
  );

  closeBtn.addEventListener("click", () => close());

  return { isOpen: sliding.isOpen, toggle: sliding.toggle, open: sliding.open, close: sliding.close, setName };
}

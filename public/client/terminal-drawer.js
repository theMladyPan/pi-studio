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
 */

/** One drawer, for the whole life of the page. `typingSomewhere` comes from the board rather than a
 * second copy of the selector here, so the drawer and the board's letters agree on what a field is.
 * It is also what tells an `x` in the shell from an `x` that rolls the drawer up: the terminal's
 * helper is a textarea, so while it holds the keyboard `typingSomewhere` is true and the letter
 * belongs to the shell. */
export function createTerminalDrawer({ workspace, typingSomewhere }) {
  const drawer = document.getElementById("termDrawer");
  const host = document.getElementById("termHost");
  const btn = document.getElementById("termBtn");
  const closeBtn = document.getElementById("tdClose");
  const statusEl = document.getElementById("tdStatus");
  const workspaceLabel = document.getElementById("tdWorkspace");

  /** The bar names the board the way a human knows it, as the git drawer's bar does. */
  function setName(name) {
    workspaceLabel.textContent = workspace ? `· ${name || workspace}` : "";
  }
  setName("");

  /** Is the drawer up. Named apart from the `open` verb below, which is what rolls it up. */
  let shown = false;
  /** The terminal screen, made once on the first roll up and kept after that. */
  let term = null;
  let fit = null;
  /** The socket to the daemon's shell, opened on the first roll up and kept. */
  let socket = null;
  /** What had the focus before the drawer took it, so rolling down puts it back. */
  let back = null;

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
  }

  /** The body class is the whole animation, and the button says which way it now stands. */
  function paint() {
    document.body.classList.toggle("term-open", shown);
    btn.setAttribute("aria-expanded", shown ? "true" : "false");
    // Every button in the header names the key it answers, and this one answers the same key both ways.
    btn.title = shown ? "roll the terminal drawer down (x)" : "roll the terminal drawer up from the bottom (x)";
  }

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
        // the drawer is already down still closes the socket.
        socket.close();
        close();
      } else if (message.type === "error") said(message.data);
    });
    socket.addEventListener("close", () => {
      said("terminal disconnected");
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
        if (shown) fitNow();
      }).observe(host);
    }
    return true;
  }

  function open() {
    if (shown) return;
    shown = true;
    // Remembered before the focus moves, so rolling down gives the keyboard back where it came from.
    back = document.activeElement instanceof Element ? document.activeElement : null;
    drawer.inert = false;
    paint();
    if (ensureTerminal()) {
      connect();
      fitNow();
      term.focus();
    }
  }

  function close() {
    if (!shown) return;
    shown = false;
    drawer.inert = true;
    paint();
    // The screen keeps its scrollback and the shell keeps running: rolling down never reloads
    // either. A remembered `body` is no place to put the keyboard, so the button that owns the
    // key takes it instead — unless that button now lives in a shut toolbox menu, where a hidden
    // element takes no focus and the keyboard goes nowhere.
    const visible = (el) => el instanceof Element && el.isConnected && el.offsetParent !== null;
    const target = visible(back) ? back : visible(btn) ? btn : null;
    back = null;
    if (target) target.focus();
    else if (document.activeElement instanceof Element && document.activeElement !== document.body) document.activeElement.blur();
  }

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
      if (!shown) return;
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

  return { isOpen: () => shown, toggle: () => (shown ? close() : open()), open, close, setName };
}

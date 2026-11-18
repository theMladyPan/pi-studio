/**
 * The git drawer: the Git Graph page in a panel that rolls down from under the header, opened and
 * rolled up with `g`.
 *
 * It deliberately is not a second git implementation. Every question about commits, branches, stashes
 * and diffs belongs to the page inside, which has its own vendor bundle and its own keyboard. This
 * file owns only the panel: when the page is loaded, who has the focus, and the two messages that keep
 * the page in step between rolls.
 *
 * The page says two things: `{ source: "pi-gitgraph", type: "ready" }` once its graph is alive, and
 * `{ source: "pi-gitgraph", type: "close" }` when the human pressed `g` or Escape in there with
 * nothing else open. This file says two: `{ source: "pi-studio", type: "focus" }` to hand the page
 * the keyboard, and `{ source: "pi-studio", command: "refresh" }` to ask for a soft reload that keeps
 * the expanded commit and the scroll position.
 */

/**
 * One drawer, for the whole life of the page. `typingSomewhere` comes from the board rather than a
 * second copy of the selector here, so the drawer and the board's letters agree on what a field is.
 */
export function createGitDrawer({ workspace, typingSomewhere }) {
  const drawer = document.getElementById("gitDrawer");
  const scrim = document.getElementById("gitScrim");
  const frame = document.getElementById("gdFrame");
  const tabBtn = document.getElementById("gdTab");
  const closeBtn = document.getElementById("gdClose");
  const btn = document.getElementById("gitBtn");
  const workspaceLabel = document.getElementById("gdWorkspace");

  /**
   * The bar names the board the way a human knows it. A workspace id is a folder's identity in the
   * state folder, not something anyone reads, so it is what the bar falls back to before the board has
   * heard the name.
   */
  function setName(name) {
    workspaceLabel.textContent = `· ${name || workspace}`;
  }
  setName("");

  /** Is the drawer down. Named apart from the `open` verb below, which is what rolls it down. */
  let shown = false;
  /** Has the frame ever been pointed at the page. The page is loaded once and kept after that. */
  let loaded = false;
  /** Has the page announced itself. Nothing may be posted before it does. */
  let ready = false;
  /** What had the focus before the drawer took it, so rolling up puts it back. */
  let back = null;

  // A board with no folder of its own has no repository to draw, and `/git/` with no id is a page that
  // cannot answer. The drawer says so in the space the graph would have used.
  if (!workspace) {
    frame.hidden = true;
    tabBtn.disabled = true;
    const note = document.createElement("p");
    note.className = "gd-note";
    note.textContent = "this board has no folder of its own, so there is no repository to draw";
    frame.parentElement.append(note);
  }

  /**
   * The page drops every message sent before its own listener exists, so `ready` is the gate for all
   * of them rather than a hint.
   */
  function post(message) {
    if (!ready || !frame.contentWindow) return;
    frame.contentWindow.postMessage({ source: "pi-studio", ...message }, location.origin);
  }

  /** The page reads its keys off its own window, so the drawer's last act of opening is the focus. */
  function takeKeyboard() {
    if (!frame.contentWindow) return;
    frame.focus();
    post({ type: "focus" });
  }

  function refreshNow() {
    post({ command: "refresh" });
  }

  /** The body class is the whole animation, and the button says which way it now stands. */
  function paint() {
    document.body.classList.toggle("git-open", shown);
    btn.setAttribute("aria-expanded", shown ? "true" : "false");
    // Every button in the header names the key it answers, and this one answers the same key both ways.
    btn.title = shown ? "roll the git graph up (g)" : "roll the git graph down (g)";
  }

  function open() {
    if (shown) return;
    shown = true;
    if (!loaded && workspace) {
      loaded = true;
      // Loaded on the first roll down and never again: a second `g` finds the same scroll position,
      // the same expanded commit and the same repository, because the page never went away.
      frame.src = `/git/${encodeURIComponent(workspace)}`;
    }
    // Remembered before the focus moves, so rolling up gives the keyboard back where it came from.
    back = document.activeElement instanceof Element ? document.activeElement : null;
    scrim.hidden = false;
    // `inert` is the shut state: a closed drawer takes no focus and no clicks, and costs nothing.
    drawer.inert = false;
    paint();
    // The page takes the keyboard once it is alive. Before its first `ready` the board keeps it, so a
    // quick `g` or Escape still reaches the handlers that roll the drawer back up.
    if (ready) takeKeyboard();
    // The page still holds what it last drew, so every roll down asks it for the repository as it stands now.
    if (ready) refreshNow();
  }

  function close() {
    if (!shown) return;
    shown = false;
    drawer.inert = true;
    paint();
    // The frame keeps its src and its state: rolling up never reloads the page. A remembered `body` is
    // no place to put the keyboard, so the button that owns the key takes it instead — unless that button
    // now lives in a shut toolbox menu, where a hidden element takes no focus and the keyboard goes nowhere.
    const visible = (el) => el instanceof Element && el.isConnected && el.offsetParent !== null;
    const target = visible(back) ? back : visible(btn) ? btn : null;
    back = null;
    if (target) target.focus();
    else if (document.activeElement instanceof Element && document.activeElement !== document.body) document.activeElement.blur();
  }

  /**
   * The page speaks for itself and nothing else does. Both halves are checked because either one alone
   * is reachable: another origin can embed this page, and this origin can hold other windows.
   */
  window.addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.source !== "pi-gitgraph") return;
    if (data.type === "ready") {
      ready = true;
      if (!shown) return;
      takeKeyboard();
      refreshNow();
    } else if (data.type === "close") {
      // A key pressed inside the page never reaches this window, so its `close` is the way back.
      close();
    }
  });

  /**
   * `g` reaches this window only while the drawer is down and the focus is outside the frame; the press
   * inside the page comes back as its `close` message. It listens on the way down so the board's own
   * `g`, which opens the drawer, never sees the press that rolled it up.
   */
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "g" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (!shown || typingSomewhere()) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    },
    true,
  );

  // The same named window the crossroads uses for boards: asking twice focuses the tab already open.
  tabBtn.addEventListener("click", () => {
    window.open(`/git/${encodeURIComponent(workspace)}`, `pi-studio-gitgraph-${workspace}`);
  });
  closeBtn.addEventListener("click", () => close());

  return { isOpen: () => shown, toggle: () => (shown ? close() : open()), open, close, setName };
}

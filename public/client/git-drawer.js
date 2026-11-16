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

/** The shortest gap between two refreshes: a thread committing in bursts restarts the graph once. */
const REFRESH_GAP = 1500;

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
  /** Did the repository change while the page could not hear about it. */
  let stale = false;
  /** What had the focus before the drawer took it, so rolling up puts it back. */
  let back = null;
  let lastRefresh = 0;
  let trailing = 0;

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
    lastRefresh = Date.now();
    stale = false;
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
    // Commits that landed while the drawer was shut are in the picture the page still holds, so the
    // one refresh it was owed is spent now.
    if (stale && ready) refreshNow();
  }

  function close() {
    if (!shown) return;
    shown = false;
    drawer.inert = true;
    paint();
    // The frame keeps its src and its state: rolling up never reloads the page. A remembered `body` is
    // no place to put the keyboard, so the button that owns the key takes it instead.
    const target = back && back !== document.body && back.isConnected ? back : btn;
    back = null;
    target.focus();
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
      if (stale) refreshNow();
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

  /**
   * The repository changed. An open page is told, at most once per `REFRESH_GAP` with one trailing
   * call; a shut one is told on the next roll down, in one refresh rather than one per commit.
   */
  function notifyChanged() {
    // A page that was never loaded has nothing to update: it reads the repository as it starts.
    if (!loaded) return;
    // No listener exists yet, so the news waits for the page to say `ready` or for the next open.
    if (!shown || !ready) {
      stale = true;
      return;
    }
    const wait = REFRESH_GAP - (Date.now() - lastRefresh);
    if (wait <= 0) {
      refreshNow();
      return;
    }
    if (trailing) return;
    trailing = setTimeout(() => {
      trailing = 0;
      if (shown && ready) refreshNow();
      else stale = true;
    }, wait);
  }

  return { isOpen: () => shown, toggle: () => (shown ? close() : open()), open, close, notifyChanged, setName };
}

/**
 * The drawer furniture the sliding drawers share, so the git drawer and the terminal drawer roll,
 * size and hand the keyboard back the same way rather than four times.
 *
 * Three pieces: `setTermHeight` for the shared terminal height (the terminal drawer and the strips
 * across the board are one height, the user's furniture), `createSlidingDrawer` for the binary
 * shown state, `inert`, the body-class paint and the focus return, and `createDetailSheet` with
 * its `detailSection`/`detailBlock` for the modal that holds a row's full text (activity detail,
 * task detail). Each drawer keeps what is its own: its shell lifecycle, its socket, its keys.
 */

const TERM_MIN = 220;
const TERM_MAX = 720;

/** Set the shared terminal height, clamped the way the terminal drawer always kept it. It is the
 * user's furniture, so the height is remembered and a reload rolls up at the height it was left. */
export function setTermHeight(px) {
  const viewport = typeof window !== "undefined" && Number.isFinite(window.innerHeight) ? window.innerHeight : 0;
  const ceiling = viewport > 0 ? Math.max(TERM_MIN, Math.min(TERM_MAX, Math.floor(viewport * 0.85))) : TERM_MAX;
  const height = Math.max(TERM_MIN, Math.min(ceiling, Math.round(px)));
  document.documentElement?.style.setProperty("--term", `${height}px`);
  try {
    localStorage.setItem("board.termHeight", String(height));
  } catch {}
  return height;
}

/** A drag on the grip, the rail grip on its side. Press on the strip, drag, and it follows the cursor
 * into `resolvePx(event)`; the sizing itself stays with the caller. The take of the press mirrors the
 * rail grip exactly: only the main button, only with a finite viewport, always released. */
export function bindDragHeight(grip, { bodyClass, resolvePx }) {
  if (!grip) return;
  let dragging = false;
  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    dragging = true;
    grip.setPointerCapture?.(event.pointerId);
    document.body.classList.add(bodyClass);
    event.preventDefault();
  });
  grip.addEventListener("pointermove", (event) => {
    if (!dragging || typeof window === "undefined" || !Number.isFinite(window.innerHeight)) return;
    resolvePx(event);
  });
  const stop = (event) => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove(bodyClass);
    if (grip.hasPointerCapture?.(event.pointerId)) grip.releasePointerCapture(event.pointerId);
  };
  grip.addEventListener("pointerup", stop);
  grip.addEventListener("pointercancel", stop);
}

/**
 * One sliding drawer for the whole life of the page: the shown flag, the inert shut state, the body
 * class that is the whole animation, the header button that says which way it stands, and the focus
 * return (a remembered element that is gone or hidden is no place to put the keyboard, so the owning
 * button takes it instead). `beforeOpen` and `afterOpen` hold what is each drawer's own: which src it
 * loads, which shell it connects, which page it focuses. `afterClose` holds what leaves with the roll:
 * which name the header stops showing.
 */
export function createSlidingDrawer({ drawer, btn, bodyClass, openTitle, shutTitle, beforeOpen, afterOpen, afterClose }) {
  let shown = false;
  /** What had the focus before the drawer took it, so rolling the other way puts it back. */
  let back = null;

  /** The body class is the whole animation, and the button says which way it now stands. */
  function paint() {
    document.body.classList.toggle(bodyClass, shown);
    btn.setAttribute("aria-expanded", shown ? "true" : "false");
    // Every button in the header names the key it answers, and this one answers the same key both ways.
    btn.title = shown ? openTitle : shutTitle;
  }

  function open() {
    if (shown) return;
    shown = true;
    beforeOpen?.();
    // Remembered before the focus moves, so rolling down gives the keyboard back where it came from.
    back = document.activeElement instanceof Element ? document.activeElement : null;
    drawer.inert = false;
    paint();
    afterOpen?.();
  }

  function close() {
    if (!shown) return;
    shown = false;
    drawer.inert = true;
    paint();
    afterClose?.();
    // A remembered `body` is no place to put the keyboard, so the button that owns the key takes it
    // instead — unless that button now lives in a shut toolbox menu, where a hidden element takes no
    // focus and the keyboard goes nowhere.
    const visible = (el) => el instanceof Element && el.isConnected && el.offsetParent !== null;
    const target = visible(back) ? back : visible(btn) ? btn : null;
    back = null;
    if (target) target.focus();
    else if (document.activeElement instanceof Element && document.activeElement !== document.body) document.activeElement.blur();
  }

  return { isOpen: () => shown, toggle: () => (shown ? close() : open()), open, close };
}

export const DETAIL_CUT_NOTICE = "cut at 64 K characters by the board server";

/** One titled block of monospace text, saying when the server cut it. */
export function detailSection(title, text, cut) {
  const box = document.createElement("section");
  box.appendChild(document.createElement("h4")).textContent = title;
  const pre = document.createElement("pre");
  pre.textContent = text;
  box.appendChild(pre);
  if (cut) {
    const notice = document.createElement("div");
    notice.className = "cut";
    notice.textContent = DETAIL_CUT_NOTICE;
    box.appendChild(notice);
  }
  return box;
}

/** A titled block holding whatever a renderer built, so a diff, a picture or a note lands in the sheet. */
export function detailBlock(title, node, cut) {
  if (!node) return null;
  const box = document.createElement("section");
  box.appendChild(document.createElement("h4")).textContent = title;
  box.appendChild(node);
  if (cut) {
    const notice = document.createElement("div");
    notice.className = "cut";
    notice.textContent = DETAIL_CUT_NOTICE;
    box.appendChild(notice);
  }
  return box;
}

/**
 * One detail modal for the life of the page or drawer: the shown flag on `root`, the head names
 * and the scroll body it fills, the close press, the backdrop press and the Escape and Tab keys.
 * The content itself stays with the caller — `detailSection`/`detailBlock` build it — so the
 * activity rows and the task cards speak the same sheet without sharing a data shape.
 */
export function createDetailSheet({ root, name: nameEl, meta: metaEl, body: bodyEl, close: closeEl, onClose }) {
  function isOpen() {
    return Boolean(root) && !root.hidden;
  }
  /** Name and meta in the head, the panel up and taking the focus. The body is filled separately. */
  function show({ name: title, meta: sub }) {
    if (!root) return;
    if (nameEl) nameEl.textContent = title ?? "";
    if (metaEl) metaEl.textContent = sub ?? "";
    root.hidden = false;
    root.focus();
  }
  function setBody(nodes) {
    if (bodyEl) bodyEl.replaceChildren(...nodes);
  }
  function hide() {
    if (!root || root.hidden) return;
    root.hidden = true;
    if (bodyEl) bodyEl.replaceChildren();
    onClose?.();
  }
  closeEl?.addEventListener("click", hide);
  root?.addEventListener("click", (event) => {
    if (event.target === root) hide();
  });
  root?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      hide();
      return;
    }
    // The panel holds the keyboard while it is open, so tab cannot walk the board behind it. Two
    // stops are inside: the close button and the body, and tab cycles between them both ways.
    if (event.key === "Tab") {
      event.preventDefault();
      const stops = [closeEl, bodyEl].filter(Boolean);
      const at = stops.indexOf(document.activeElement);
      const step = event.shiftKey ? stops.length - 1 : 1;
      stops[at < 0 ? (event.shiftKey ? stops.length - 1 : 0) : (at + step) % stops.length].focus();
    }
  });
  return { isOpen, show, setBody, hide };
}

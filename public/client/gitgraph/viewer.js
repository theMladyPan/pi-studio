/**
 * The reader for what the daemon answers instead of opening an editor: a diff, or a file at a revision.
 *
 * The bundle used to ask VS Code for a diff document, which came with a scrollbar, coloured additions
 * and a copy button. This is that, and deliberately no more: no editing, no side-by-side. A diff stays a
 * table with the three kinds of line it has; a whole file is the board's own text surface, imported so
 * that the drawer's editor and this reader colour a file the same way.
 */
import { createTextPreview } from "../text-preview.js";
import { createDiffTable } from "../diff-table.js";
const viewer = document.getElementById("ggViewer");
const titleBar = document.getElementById("ggViewerTitle");
const flagsBar = document.getElementById("ggViewerFlags");
const body = document.getElementById("ggViewerBody");
const copyButton = document.getElementById("ggViewerCopy");
const closeButton = document.getElementById("ggViewerClose");

/** What had the focus before the viewer opened, so closing it puts the human back where they were. */
let wasFocused = null;

/** What the viewer is showing, which is what "copy" copies. */
let showing = "";

/**
 * Draw one diff or file. A binary file and a truncated one are said in the bar rather than dropped:
 * a human who opened something and sees an empty pane has to be told which of the two happened.
 */
function render(view) {
  body.replaceChildren();
  showing = view.binary ? "" : view.content;
  const flags = [];
  if (view.binary) flags.push("binary — this file is not text, so there is nothing to show");
  if (view.truncated) flags.push("truncated — only the first 2 MB is shown");
  flagsBar.textContent = flags.join(" · ");
  copyButton.disabled = showing === "";
  if (showing === "") {
    const empty = document.createElement("div");
    empty.className = "ggViewerEmpty";
    empty.textContent = view.binary ? "This file is not text." : "This file is empty.";
    body.append(empty);
    return;
  }
  // A file has no hunks, so it is read as text rather than numbered as a diff.
  if (view.kind === "file") return renderFile(view);
  body.append(createDiffTable(showing));
}

/**
 * A whole file, on the surface the board's editor uses. Read-only, because this page reads history: the
 * file it shows is a revision, and a revision is not something to type over here.
 */
function renderFile(view) {
  const host = document.createElement("div");
  host.className = "ggViewerText";
  const preview = createTextPreview(host, { readOnly: true });
  preview.setDocument({ path: view.filePath ?? view.title ?? "", content: view.content });
  body.append(host);
}

/** Show one view, which the host passes whenever a reply carries text. */
export function showView(view) {
  if (!view || typeof view !== "object") return;
  wasFocused = document.activeElement;
  titleBar.textContent = view.title || view.filePath || "Diff";
  render(view);
  viewer.hidden = false;
  closeButton.focus();
}

/** Close it, and hand the focus back to whatever had it: a menu entry the human just used. */
export function closeView() {
  viewer.hidden = true;
  body.replaceChildren();
  if (wasFocused && typeof wasFocused.focus === "function") wasFocused.focus();
  wasFocused = null;
}

// A click on the backdrop closes it; a click inside the panel does not.
viewer.addEventListener("click", (event) => {
  if (event.target === viewer || event.target.classList.contains("ggViewerBackdrop")) closeView();
});

closeButton.addEventListener("click", () => closeView());

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(showing);
    copyButton.textContent = "Copied";
  } catch {
    copyButton.textContent = "Copy failed";
  }
  setTimeout(() => {
    copyButton.textContent = "Copy";
  }, 1500);
});

// Capture phase on the document, so this Escape closes the viewer before the bundle's own ladder of
// menus, dialogs and dropdowns has a chance to close one of those instead.
document.addEventListener(
  "keydown",
  (event) => {
    if (viewer.hidden || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closeView();
  },
  true,
);

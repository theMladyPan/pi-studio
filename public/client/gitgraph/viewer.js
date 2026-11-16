/**
 * The reader for what the daemon answers instead of opening an editor: a diff, or a file at a revision.
 *
 * The bundle used to ask VS Code for a diff document, which came with a scrollbar, coloured additions
 * and a copy button. This is that, and deliberately no more: no editing, no side-by-side, no syntax
 * colouring beyond the three kinds of line a unified diff has. Keeping it small is the point — it is a
 * reader, and every feature it does not have is one the page does not have to keep working.
 */
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

/** A row of the diff table: the number on each side, and the line itself. */
function row(oldNumber, newNumber, text, kind) {
  const tr = document.createElement("tr");
  for (const number of [oldNumber, newNumber]) {
    const cell = document.createElement("td");
    cell.className = "ggViewerNum";
    cell.textContent = number === null ? "" : String(number);
    tr.append(cell);
  }
  const cell = document.createElement("td");
  cell.className = kind ? `ggViewerLine_${kind}` : "";
  cell.textContent = text;
  tr.append(cell);
  return tr;
}

/** Which of the four kinds of line this one is, in the words a unified diff uses. */
function kindOf(line) {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file") || line.startsWith("similarity") || line.startsWith("rename ") || line.startsWith("\\")) return "meta";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "";
}

/** The line numbers a hunk header starts each side at: `@@ -a,b +c,d @@`. */
function hunkStart(line) {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  return match ? { old: Number(match[1]), next: Number(match[2]) } : null;
}

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
  const table = document.createElement("table");
  table.className = "ggViewerTable";
  const tbody = document.createElement("tbody");
  let oldNumber = null;
  let newNumber = null;
  for (const line of showing.split("\n")) {
    const start = hunkStart(line);
    if (start) {
      oldNumber = start.old;
      newNumber = start.next;
      tbody.append(row(null, null, line, "hunk"));
      continue;
    }
    const kind = kindOf(line);
    // A file has no hunks, so its lines are numbered from one; a diff's numbers follow its hunks and
    // only move on the side the line belongs to.
    if (kind === "" && newNumber === null && oldNumber === null) {
      oldNumber = 1;
      newNumber = 1;
    }
    if (kind === "added") {
      tbody.append(row(null, newNumber, line, kind));
      if (newNumber !== null) newNumber += 1;
    } else if (kind === "removed") {
      tbody.append(row(oldNumber, null, line, kind));
      if (oldNumber !== null) oldNumber += 1;
    } else if (kind === "" && oldNumber !== null && newNumber !== null) {
      tbody.append(row(oldNumber, newNumber, line, kind));
      oldNumber += 1;
      newNumber += 1;
    } else {
      tbody.append(row(null, null, line, kind));
    }
  }
  table.append(tbody);
  body.append(table);
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

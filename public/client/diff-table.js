/**
 * One unified diff as a table: the number on each side, and the line itself.
 *
 * Shared by the git graph page's viewer and the board's source control modal, so both pages draw a
 * diff the same way: one implementation, imported by each. The line kinds and the hunk numbers are
 * pure, and the tests read them without a browser; only the table needs the document.
 */

/** Which of the four kinds of line this one is, in the words a unified diff uses. */
export function diffKindOf(line) {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("new file") || line.startsWith("deleted file") || line.startsWith("similarity") || line.startsWith("rename ") || line.startsWith("\\")) return "meta";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "";
}

/** The line numbers a hunk header starts each side at: `@@ -a,b +c,d @@`. */
export function diffHunkStart(line) {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  return match ? { old: Number(match[1]), next: Number(match[2]) } : null;
}

/** A row of the diff table: the number on each side, and the line itself. */
export function createDiffTable(content) {
  const doc = globalThis.document;
  const row = (oldNumber, newNumber, text, kind) => {
    const tr = doc.createElement("tr");
    for (const number of [oldNumber, newNumber]) {
      const cell = doc.createElement("td");
      cell.className = "ggViewerNum";
      cell.textContent = number === null ? "" : String(number);
      tr.append(cell);
    }
    const cell = doc.createElement("td");
    cell.className = kind ? `ggViewerLine_${kind}` : "";
    cell.textContent = text;
    tr.append(cell);
    return tr;
  };
  const table = doc.createElement("table");
  table.className = "ggViewerTable";
  const tbody = doc.createElement("tbody");
  let oldNumber = null;
  let newNumber = null;
  for (const line of String(content ?? "").split("\n")) {
    const start = diffHunkStart(line);
    if (start) {
      oldNumber = start.old;
      newNumber = start.next;
      tbody.append(row(null, null, line, "hunk"));
      continue;
    }
    const kind = diffKindOf(line);
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
  return table;
}

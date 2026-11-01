/* A `chart` fence drawn as static svg: no script, no style block, no animation, no CSS class. The
   output has to be inert by construction, because the card inserts it as markup. A card is about
   400px wide, so every number below is chosen to stay legible at that width, and a drawing that
   cannot fit says so in `warnings` instead of growing a horizontal scrollbar nobody uses. */

const COLORS = ["#58a6ff", "#d29922", "#3fb950", "#db61a2", "#a371f7"];
const TEXT = "#c9d1d9";
const MUTED = "#7d8590";
const GRID = "#30363d";
const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";
/** One character of 11px type, which is what the layout here budgets for. */
const CHAR = 7;
const MIN_GUTTER = 34;
const MAX_BAR = 28;
const BAR_GAP = 2;
const TYPES = ["bar", "hbar", "line", "area"];
const X_KINDS = ["category", "time", "number"];
const SCALES = ["linear", "log"];
const SORTS = ["none", "asc", "desc"];
const LABELS = ["auto", "all", "none"];
const KEYS = new Set(["type", "title", "x", "y", "scale", "sort", "labels", "goal"]);

export function renderChart(source, { width = 420, height = 220 } = {}) {
  const W = pixels(width, 420, 200);
  const H = pixels(height, 220, 120);
  const warnings = [];
  try {
    const model = readChart(source, warnings);
    if (!model.points.length) {
      warnings.push("no chart data: the chart fence holds no rows to draw");
      return { svg: emptySvg(W, H), warnings };
    }
    return { svg: drawChart(model, W, H, warnings), warnings };
  } catch (error) {
    // A chart never costs a card: whatever went wrong, the reader gets a line saying so.
    warnings.push(`no chart data: ${error?.message ?? "the chart could not be drawn"}`);
    return { svg: emptySvg(W, H), warnings };
  }
}

// ---------- reading the fence ---------------------------------------------

function readChart(source, warnings) {
  const model = { type: "bar", title: "", x: "category", scale: "linear", sort: null, labels: "auto", goal: null, declared: [], points: [], series: [] };
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const separator = lines.findIndex((line) => line.trim() === "---");
  const rows = [];

  if (separator < 0) {
    // No `---`: the whole body is one two-column table, header lines and rows mixed. A key the tool
    // knows is a header; anything else that carries a `:` or a `|` is a row.
    for (const line of lines) {
      if (!line.trim() || readHeaderLine(line, model, warnings, { loose: false })) continue;
      rows.push(rowCells(line));
    }
  } else {
    for (const line of lines.slice(0, separator)) if (line.trim()) readHeaderLine(line, model, warnings, { loose: true });
    for (const line of lines.slice(separator + 1)) if (line.trim()) rows.push(rowCells(line));
  }

  const declared = model.declared;
  const widestRow = rows.reduce((max, cells) => Math.max(max, cells.length - 1), 0);
  let seriesCount = declared.length || Math.max(1, widestRow);
  let skipped = 0;

  if (widestRow === 0) {
    // Rows of one cell each: the values are the rows, in the order they were written, and the category
    // is the row's place in that order.
    seriesCount = 1;
    rows.forEach((cells, index) => {
      const value = number(cells[0]);
      if (value === null) skipped += 1;
      else model.points.push({ x: String(index + 1), values: [value] });
    });
  } else {
    for (const cells of rows) {
      const values = [];
      let bad = false;
      for (let index = 0; index < seriesCount; index += 1) {
        const cell = cells[index + 1];
        if (cell === undefined || cell === "") {
          values.push(null);
          continue;
        }
        const value = number(cell);
        if (value === null) {
          bad = true;
          break;
        }
        values.push(value);
      }
      if (bad) skipped += 1;
      else model.points.push({ x: String(cells[0] ?? ""), values });
    }
  }
  // One line for every dropped row: a broken row is worth naming once, not once per row, and a fence
  // that held no numbers at all is one message, not two.
  if (skipped && model.points.length) warnings.push(`${skipped} row${skipped === 1 ? "" : "s"} skipped: a value that is not a number`);

  model.series = Array.from({ length: seriesCount }, (_, index) => {
    const said = declared[index];
    return {
      label: said?.label || (seriesCount === 1 ? "value" : `series ${index + 1}`),
      unit: said?.unit || "",
      right: Boolean(said?.right),
      color: COLORS[index % COLORS.length],
    };
  });

  // `hbar` leads with the biggest bar because a horizontal chart is nearly always a ranking. An explicit
  // `sort` is reported, so the model knows the order it asked for is the order that was drawn.
  const asked = model.sort;
  const order = asked ?? (model.type === "hbar" ? "desc" : "none");
  if (order !== "none") {
    model.points.sort((a, b) => {
      const left = a.values[0] === null ? -Infinity : a.values[0];
      const right = b.values[0] === null ? -Infinity : b.values[0];
      return order === "asc" ? left - right : right - left;
    });
    if (asked) warnings.push(`sorted ${asked} by ${model.series[0].label}`);
  }
  return model;
}

/** `true` when the line was consumed as a header, so the caller knows it is not a data row. */
function readHeaderLine(line, model, warnings, { loose }) {
  const known = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.+)$/);
  if (!known || !KEYS.has(known[1].toLowerCase())) {
    const named = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (loose && named) {
      warnings.push(`ignored key "${named[1].toLowerCase()}"`);
      return true;
    }
    return false;
  }
  const key = known[1].toLowerCase();
  const value = known[2].trim();
  if (key === "title") model.title = value;
  else if (key === "type") model.type = pick(value, TYPES, "bar", "type", warnings);
  else if (key === "x") model.x = pick(value, X_KINDS, "category", "x", warnings);
  else if (key === "scale") model.scale = pick(value, SCALES, "linear", "scale", warnings);
  else if (key === "sort") model.sort = pick(value, SORTS, "none", "sort", warnings);
  else if (key === "labels") model.labels = pick(value, LABELS, "auto", "labels", warnings);
  else if (key === "goal") {
    const goal = number(value);
    if (goal === null) warnings.push(`goal "${value}" is not a number`);
    else model.goal = goal;
  } else if (key === "y") model.declared = readSeriesList(value);
  return true;
}

function pick(value, allowed, fallback, name, warnings) {
  const said = value.toLowerCase();
  if (allowed.includes(said)) return said;
  warnings.push(`${name} "${value}" is not ${allowed.join(", ")}; using ${fallback}`);
  return fallback;
}

/** `p95 (ms), retries (count) right` -> named series, with the unit and the axis each declares. */
function readSeriesList(value) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const right = /\s+right$/i.test(entry);
      const rest = right ? entry.replace(/\s+right$/i, "").trim() : entry;
      const unit = rest.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
      return {
        label: (unit ? unit[1] : rest).trim() || "value",
        unit: unit ? unit[2].trim() : "",
        right,
      };
    });
}

/**
 * One data row's cells. `|` is the documented separator; a comma is accepted because that is how the
 * chart skill writes its own examples; `label: value` is the two-column fallback.
 */
function rowCells(line) {
  const text = line.trim();
  if (text.includes("|")) return text.split("|").map((cell) => cell.trim());
  if (text.includes(",")) return text.split(",").map((cell) => cell.trim());
  const pair = text.match(/^(.*?)\s*:\s*(.+)$/);
  if (pair) return [pair[1].trim(), pair[2].trim()];
  return [text];
}

// ---------- numbers and text ----------------------------------------------

function pixels(value, fallback, floor) {
  const size = Number(value);
  return Number.isFinite(size) && size > 0 ? Math.max(floor, Math.round(size)) : fallback;
}

/** `1,200`, `12.5%` and `-3` are all numbers here; anything else is `null` and the row is dropped. */
function number(value) {
  const cleaned = String(value ?? "").replace(/[\s,_%]/g, "");
  if (!cleaned || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A tick header, never a raw `1300000`: `1.3M`, `1.2k`, `4.1B`, two decimals at most. */
function formatTick(value) {
  const abs = Math.abs(value);
  for (const [size, suffix] of [[1e9, "B"], [1e6, "M"], [1e3, "k"]]) {
    if (abs >= size) return `${short(value / size)}${suffix}`;
  }
  return short(value);
}

function short(value) {
  const rounded = Math.round(value * 100) / 100;
  return String(Number.isInteger(rounded) ? rounded : Number(rounded.toFixed(2)));
}

const esc = (text) =>
  String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const estimated = (text) => String(text).length * CHAR;
const round = (value) => Math.round(value * 100) / 100;
/** Bars are laid out on half-pixel edges so a 2px gap stays a 2px gap at any zoom. */
const half = (value) => Math.round(value * 2) / 2;

function elide(text, limit = 10) {
  const said = String(text);
  return said.length > limit ? `${said.slice(0, limit)}…` : said;
}

/** A series named in the legend: `p95 (ms)`, never a bare `p95` with its unit lost. */
const withUnit = (series) => (series ? (series.unit ? `${series.label} (${series.unit})` : series.label) : "");

// ---------- the value axis ------------------------------------------------

function domainFor(points, indexes, { zeroBase, goal, log, warnings }) {
  const values = [];
  for (const point of points) for (const index of indexes) if (Number.isFinite(point.values[index])) values.push(point.values[index]);
  if (Number.isFinite(goal)) values.push(goal);
  let lo = values.length ? Math.min(...values) : 0;
  let hi = values.length ? Math.max(...values) : 1;
  if (log) {
    const lost = values.filter((value) => value <= 0).length;
    if (lost) warnings.push(`log scale left out ${lost} value${lost === 1 ? "" : "s"} at or below zero`);
    const positive = values.filter((value) => value > 0);
    if (!positive.length) return { lo: 1, hi: 10, log: false };
    lo = Math.pow(10, Math.floor(Math.log10(Math.min(...positive))));
    hi = Math.pow(10, Math.ceil(Math.log10(Math.max(...positive))));
    if (hi <= lo) hi = lo * 10;
    return { lo, hi, log: true };
  }
  if (zeroBase) lo = Math.min(0, lo);
  if (hi === lo) hi = lo + (lo === 0 ? 1 : Math.abs(lo) * 0.1);
  return { lo, hi, log: false };
}

function ticksOf(domain, count) {
  if (domain.log) {
    const ticks = [];
    for (let power = Math.log10(domain.lo); power <= Math.log10(domain.hi) + 1e-9; power += 1) ticks.push(Number(Math.pow(10, power).toPrecision(6)));
    return ticks.length >= 2 ? ticks : [domain.lo, domain.hi];
  }
  const rough = (domain.hi - domain.lo) / count;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough || 1)));
  const norm = rough / magnitude;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * magnitude;
  const ticks = [];
  // The last tick has to reach the largest value, or the tallest bar is drawn past the top of the plot.
  const start = Math.floor(domain.lo / step + 1e-9) * step;
  const end = Math.ceil(domain.hi / step - 1e-9) * step;
  for (let value = start; value <= end + step * 1e-6; value += step) ticks.push(Number(value.toPrecision(10)));
  return ticks;
}

/** A snapped axis: the ticks the reader sees, their labels, and where a value sits between 0 and 1. */
function axisFor(domain, count) {
  const ticks = ticksOf(domain, count);
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const project = (value) => (domain.log ? Math.log10(value) : value);
  const span = project(hi) - project(lo) || 1;
  return {
    lo,
    hi,
    ticks,
    labels: ticks.map(formatTick),
    frac: (value) => (Number.isFinite(value) && (!domain.log || value > 0) ? (project(value) - project(lo)) / span : null),
  };
}

// ---------- drawing -------------------------------------------------------

function emptySvg(W, H) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${FONT}" font-size="11" role="img" aria-label="no chart data"><text x="${W / 2}" y="${H / 2}" fill="${MUTED}" text-anchor="middle" dominant-baseline="middle">no chart data</text></svg>`;
}

function drawChart(model, W, H, warnings) {
  const points = model.points;
  const series = model.series;
  const horizontal = model.type === "hbar";
  const log = model.scale === "log";

  // A series asking for the second axis gets one, unless every series asks and then there is no first.
  let onRight = series.map((entry) => entry.right);
  if (onRight.every(Boolean)) onRight = onRight.map(() => false);
  // A horizontal bar has one measurable edge, so a `right` series there is measured on the first axis
  // rather than against ticks the drawing does not have.
  if (horizontal && onRight.some(Boolean)) {
    warnings.push("a horizontal bar chart has one value axis: a series marked right is drawn against the left ticks");
    onRight = onRight.map(() => false);
  }
  const dual = onRight.some(Boolean);
  const leftIndexes = series.map((_, index) => index).filter((index) => !onRight[index]);
  const rightIndexes = series.map((_, index) => index).filter((index) => onRight[index]);

  const left = axisFor(domainFor(points, leftIndexes, { zeroBase: model.type !== "line", goal: model.goal, log, warnings }), 4);
  const right = dual ? axisFor(domainFor(points, rightIndexes, { zeroBase: model.type !== "line", goal: null, log, warnings }), 3) : null;
  // The axis colour is the colour of the series measured on it, so tick, legend and bar agree.
  const leftColor = series[leftIndexes[0]]?.color ?? MUTED;
  const rightColor = series[rightIndexes[0]]?.color ?? MUTED;

  // `x: number` says the first column is a quantity, so it is written the way every tick is written:
  // `1300000` never reaches the axis, `1.3M` does. A category or a time is drawn as it was typed.
  const categories = points.map((point) => {
    const value = number(point.x);
    return model.x === "number" && value !== null ? formatTick(value) : point.x;
  });
  const widestCategory = categories.reduce((widest, label) => Math.max(widest, estimated(label)), 0);
  const legendRows = series.length > 1 ? 1 : 0;
  const titleH = model.title ? 16 : 0;
  const legendH = legendRows ? 14 : 0;

  let leftGutter;
  let rightGutter;
  let bottom;
  let rotate = false;
  let labels = categories;

  if (horizontal) {
    // The category owns the left edge: it is the longest word in the drawing, and it keeps as much of
    // the width as the bars can spare.
    leftGutter = Math.min(Math.max(MIN_GUTTER, widestCategory + 10), Math.round(W * 0.62));
    rightGutter = 10;
    bottom = 26;
    if (widestCategory + 10 > leftGutter) {
      labels = categories.map((label) => elide(label, Math.max(4, Math.floor((leftGutter - 10) / CHAR))));
      warnings.push(`x labels elided: ${categories.length} in ${W}px, use size="wide" or fewer points`);
    }
  } else {
    leftGutter = Math.max(MIN_GUTTER, Math.max(...left.labels.map(estimated)) + 8);
    rightGutter = right ? Math.max(MIN_GUTTER, Math.max(...right.labels.map(estimated)) + 8) : 8;
    bottom = 34;
  }

  const plotProbe = Math.max(20, W - leftGutter - rightGutter);
  if (!horizontal && categories.length) {
    const slot = plotProbe / categories.length;
    if (widestCategory > slot) {
      // A -35deg label leans over its neighbour: its footprint is 0.82 of its width, and it needs 0.57
      // of that width in height, which the bottom gutter has to pay for. A label too wide even for
      // that is cut, because a rotated label that runs into the next one is worse than a short one.
      if (widestCategory * 0.82 <= slot) {
        rotate = true;
        warnings.push(`${categories.length} x labels rotated -35deg in ${W}px, use size="wide" or fewer points`);
        bottom = Math.min(34 + Math.round(widestCategory * 0.57), Math.round(H * 0.45));
      } else {
        labels = categories.map((label) => elide(label, 10));
        warnings.push(`x labels elided: ${categories.length} in ${W}px, use size="wide" or fewer points`);
      }
    }
  }

  const plotX = leftGutter;
  const plotRight = W - rightGutter;
  const plotW = Math.max(20, plotRight - plotX);
  const plotTop = titleH + legendH + 6;
  const plotBottom = H - bottom;
  const plotH = Math.max(20, plotBottom - plotTop);

  const valueX = (frac) => plotX + (frac ?? 0) * plotW;
  const valueY = (frac) => plotBottom - (frac ?? 0) * plotH;
  // Bars hang from zero, not from the floor of the plot: a negative value has to fall below the axis
  // it is measured against.
  const baseline = Math.min(plotBottom, Math.max(plotTop, valueY(left.frac(0) ?? 0)));

  const parts = [];
  const open = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${FONT}" font-size="11" role="img" aria-label="${esc(model.title || `${model.type} chart`)}">`;
  const text = (x, y, content, { anchor = "start", fill = MUTED, size = 11, rotate: angle = null } = {}) =>
    `<text x="${round(x)}" y="${round(y)}" fill="${fill}" font-size="${size}"${anchor === "start" ? "" : ` text-anchor="${anchor}"`}${angle === null ? "" : ` transform="rotate(${angle} ${round(x)} ${round(y)})"`}>${esc(content)}</text>`;
  const gridLine = (x1, y1, x2, y2, color = GRID, dashed = false) =>
    `<line x1="${round(x1)}" y1="${round(y1)}" x2="${round(x2)}" y2="${round(y2)}" stroke="${color}" stroke-width="1"${dashed ? ' stroke-dasharray="4 3"' : ""}/>`;

  if (model.title) parts.push(text(plotX, 12, elide(model.title, Math.max(8, Math.floor(plotW / CHAR))), { fill: TEXT, size: 12 }));

  if (legendRows) {
    // Two axes get a two-item legend, one item per axis; one axis gets one item per series.
    const items = dual
      ? [
          { color: leftColor, label: `left: ${withUnit(series[leftIndexes[0]])}` },
          { color: rightColor, label: `right: ${withUnit(series[rightIndexes[0]])}` },
        ]
      : series.map((entry) => ({ color: entry.color, label: withUnit(entry) }));
    let cursor = plotX;
    const y = titleH + 10;
    for (const item of items) {
      parts.push(`<rect x="${round(cursor)}" y="${round(y - 6)}" width="7" height="7" fill="${item.color}" rx="1"/>`);
      const room = Math.max(4, Math.floor((plotRight - cursor - 12) / CHAR));
      const label = elide(item.label, room);
      parts.push(text(cursor + 11, y, label, { fill: MUTED }));
      cursor += 11 + estimated(label) + 12;
    }
  }

  if (horizontal) {
    // Values run left to right, so the goal is a vertical rule and the ticks sit under the plot.
    for (const tick of left.ticks) {
      const x = valueX(left.frac(tick));
      parts.push(gridLine(x, plotTop, x, plotBottom));
    }
    parts.push(text(plotX, plotBottom + 14, left.labels[0] ?? "", { fill: leftColor }));
    parts.push(text(plotRight, plotBottom + 14, left.labels[left.labels.length - 1] ?? "", { anchor: "end", fill: leftColor }));
    const middle = Math.floor(left.labels.length / 2);
    if (left.labels.length > 2) parts.push(text(valueX(left.frac(left.ticks[middle])), plotBottom + 14, left.labels[middle], { anchor: "middle", fill: leftColor }));
    if (Number.isFinite(model.goal)) {
      const x = valueX(left.frac(model.goal) ?? 0);
      parts.push(gridLine(x, plotTop, x, plotBottom, MUTED, true));
      parts.push(text(x, plotTop - 2, `goal ${formatTick(model.goal)}`, { anchor: "middle", fill: MUTED, size: 10 }));
    }
  } else {
    for (const tick of left.ticks) {
      const y = valueY(left.frac(tick));
      parts.push(gridLine(plotX, y, plotRight, y));
    }
    left.ticks.forEach((tick, index) => {
      parts.push(text(plotX - 6, valueY(left.frac(tick)) + 3.5, left.labels[index], { anchor: "end", fill: leftColor }));
    });
    if (right) {
      // The second axis is read on the right edge, in its own colour, so a count never passes for a rate.
      right.ticks.forEach((tick, index) => {
        parts.push(text(plotRight + 6, valueY(right.frac(tick)) + 3.5, right.labels[index], { fill: rightColor }));
      });
    }
    if (Number.isFinite(model.goal)) {
      const y = valueY(left.frac(model.goal) ?? 0);
      parts.push(gridLine(plotX, y, plotRight, y, MUTED, true));
      parts.push(text(plotRight - 2, y - 3, `goal ${formatTick(model.goal)}`, { anchor: "end", fill: MUTED, size: 10 }));
    }
  }

  // The value axis already draws its own grid line at zero, so a baseline here is only for `hbar`, whose
  // grid runs the other way.
  if (horizontal) parts.push(gridLine(plotX, baseline, plotRight, baseline, GRID));

  // Category labels.
  if (horizontal) {
    const rowH = plotH / points.length;
    labels.forEach((label, index) => {
      parts.push(text(plotX - 6, plotTop + index * rowH + rowH / 2 + 3.5, label, { anchor: "end", fill: TEXT }));
    });
  } else {
    const slot = plotW / points.length;
    labels.forEach((label, index) => {
      const x = plotX + index * slot + slot / 2;
      // A rotated label hangs from its right end, so it leans back over the slot it belongs to.
      if (rotate) parts.push(text(x, plotBottom + 14, label, { anchor: "end", fill: MUTED, rotate: -35 }));
      else parts.push(text(x, plotBottom + 14, label, { anchor: "middle", fill: MUTED }));
    });
  }

  // Marks, and the boxes their value labels would take.
  const marks = [];

  if (model.type === "bar") {
    const slot = plotW / points.length;
    const groupW = Math.min(slot - BAR_GAP, series.length * MAX_BAR + (series.length - 1) * BAR_GAP);
    const barW = Math.max(1, half((groupW - (series.length - 1) * BAR_GAP) / series.length));
    points.forEach((point, index) => {
      const groupX = plotX + index * slot + (slot - groupW) / 2;
      series.forEach((entry, column) => {
        const axis = onRight[column] ? right : left;
        const frac = axis?.frac(point.values[column]);
        if (frac === null || frac === undefined) return;
        const top = valueY(frac);
        const y = Math.min(top, baseline);
        const height = Math.max(0.5, Math.abs(top - baseline));
        const x = groupX + column * (barW + BAR_GAP);
        parts.push(`<rect x="${round(x)}" y="${round(y)}" width="${round(barW)}" height="${round(height)}" fill="${entry.color}"/>`);
        marks.push({ x, y, w: barW, h: height, value: point.values[column], column });
      });
    });
  } else if (model.type === "hbar") {
    const rowH = plotH / points.length;
    const barH = Math.max(1, half(Math.min(MAX_BAR, rowH - BAR_GAP)));
    points.forEach((point, index) => {
      const rowTop = plotTop + index * rowH;
      series.forEach((entry, column) => {
        const axis = onRight[column] ? right : left;
        const frac = axis?.frac(point.values[column]);
        if (frac === null || frac === undefined) return;
        const start = valueX(left.frac(0) ?? 0);
        const end = valueX(frac);
        const x = Math.min(start, end);
        const width = Math.max(0.5, Math.abs(end - start));
        const y = rowTop + (rowH - (series.length * barH + (series.length - 1) * BAR_GAP)) / 2 + column * (barH + BAR_GAP);
        parts.push(`<rect x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(barH)}" fill="${entry.color}"/>`);
        marks.push({ x: end, y, w: 0, h: barH, value: point.values[column], column });
      });
    });
  } else {
    const slot = plotW / points.length;
    // A line or an area sits on its category's centre, so one point per slot keeps the spacing even
    // however uneven the values are.
    const spots = points.map((point, index) =>
      series.map((_, column) => {
        const axis = onRight[column] ? right : left;
        const frac = axis?.frac(point.values[column]);
        return frac === null || frac === undefined ? null : { x: plotX + index * slot + slot / 2, y: valueY(frac), value: point.values[column] };
      }),
    );
    series.forEach((entry, column) => {
      const axis = onRight[column] ? right : left;
      const track = spots.map((spot) => spot[column]).filter(Boolean);
      if (!track.length) return;
      if (model.type === "area") {
        const floor = Math.min(plotBottom, valueY(axis.frac(0) ?? 0));
        const body = track.map((spot) => `${round(spot.x)},${round(spot.y)}`).join(" ");
        parts.push(`<polygon points="${round(track[0].x)},${round(floor)} ${body} ${round(track[track.length - 1].x)},${round(floor)}" fill="${entry.color}" fill-opacity="0.18"/>`);
      }
      parts.push(`<polyline points="${track.map((spot) => `${round(spot.x)},${round(spot.y)}`).join(" ")}" fill="none" stroke="${entry.color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`);
      for (const spot of track) marks.push({ x: spot.x, y: spot.y, w: 0, h: 0, value: spot.value, column });
    });
  }

  // Value labels. `auto` draws them only where they still read; a collision drops the lot, because a
  // half-labelled chart invites the reader to guess which number belongs to which mark.
  const wantsLabels = model.labels === "all" || (model.labels === "auto" && points.length <= 8 && series.length === 1);
  if (wantsLabels && marks.length) {
    const boxes = marks.map((mark) => {
      const said = formatTick(mark.value ?? 0);
      const w = estimated(said);
      return model.type === "hbar"
        ? { x: mark.x + 4, y: mark.y + mark.h / 2 - 5.5, w, h: 11 }
        : { x: mark.x + mark.w / 2 - w / 2, y: mark.y - 14, w, h: 11 };
    });
    const collides = boxes.some((a, index) => boxes.some((b, other) => other > index && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h));
    if (collides) {
      warnings.push("value labels dropped: they would overlap at this width");
    } else {
      marks.forEach((mark, index) => {
        const box = boxes[index];
        const said = formatTick(mark.value ?? 0);
        if (model.type === "hbar") {
          // A label past the right edge is unreadable, so a bar that fills the plot carries it inside.
          const inside = box.x + box.w > plotRight;
          parts.push(inside ? text(mark.x - 4, box.y + 9, said, { anchor: "end", fill: TEXT, size: 10 }) : text(box.x, box.y + 9, said, { fill: TEXT, size: 10 }));
        } else parts.push(text(box.x + box.w / 2, box.y + 9, said, { anchor: "middle", fill: TEXT, size: 10 }));
      });
    }
  }

  parts.push("</svg>");
  return `${open}${parts.join("")}`;
}

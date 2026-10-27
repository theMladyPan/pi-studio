/* pi board — canvas client. Cards arrive from the extension over server-sent events. */
(function () {
  "use strict";

  const world = document.getElementById("world");
  const viewport = document.getElementById("viewport");
  // `overflow: clip` keeps the viewport out of the scroll containers, but an engine that ignores
  // it (and falls back to `hidden`) would still scroll when the composer or an editor takes
  // focus, leaving the pan state behind. Zeroing the offset holds the invariant on every engine.
  viewport.addEventListener("scroll", () => {
    viewport.scrollTop = 0;
    viewport.scrollLeft = 0;
  });
  const emptyHint = document.getElementById("empty");
  const live = document.getElementById("live");
  const liveText = document.getElementById("liveText");
  const liveClock = document.getElementById("liveClock");
  const resetBtn = document.getElementById("reset");
  const params = new URLSearchParams(location.search);
  const token = params.get("token") || "";
  // The board is one page for every workspace; the path names the one this tab belongs to, and every
  // board route has to carry it.
  const workspace = (location.pathname.match(/^\/w\/([0-9a-f]{6,64})\/?$/) || [])[1] || "";
  const auth = `token=${encodeURIComponent(token)}${workspace ? `&workspace=${encodeURIComponent(workspace)}` : ""}`;
  // The path already says what this page is: `/w/<id>` is a board of threads, whose field lives
  // inside a card. Waiting for a frame from the server to decide that left a board looking like a
  // one-session board whenever the stream was slow, stale or dead.
  if (workspace) document.body.classList.add("threads");

  // Kept in step with the code font size in index.html: 13px text, 20px rows.
  const LINE_HEIGHT = 20;
  const GUTTER = 56;
  const view = { x: 0, y: 0, k: 1 };
  const cards = [];
  const byId = new Map();
  let z = 1;
  // Z order inside a thread: the newest card on top by default. Someone who wants the other
  // way wants it every time, so the choice lives beside the rail's width.
  const ORDER_KEY = "board.threadOrder";
  let newestFirst = true;
  try {
    newestFirst = localStorage.getItem(ORDER_KEY) !== "oldest";
  } catch {}
  const occupied = [];
  let sawFirstCard = false;
  /** The card the composer is currently replying into, or null for a fresh message. */
  let replyTarget = null;
  // A snapshot is what is already on the board, so nothing in it is new to the reader.
  let replaying = false;
  // Only the first snapshot of a session frames the board: a reconnect restores cards the human
  // already arranged, so it must leave the view exactly where they left it.
  let framedView = false;
  let freshCount = 0;

  const GAP = 18;
  const STEP = 24;

  // Cards are sized in columns rather than pixels: code reads best at 120 monospace
  // columns, prose at 80. Both are measured from the fonts actually in use.
  const SOURCE_COLS = 120;
  const NOTE_COLS = 90;
  let charWidths;

  function measureCharWidths() {
    if (charWidths) return charWidths;
    const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const probe = (font, text) => {
      const span = document.createElement("span");
      span.style.cssText = `position:absolute;left:-9999px;top:0;white-space:pre;font:${font}`;
      span.textContent = text;
      document.body.appendChild(span);
      const perChar = span.getBoundingClientRect().width / text.length;
      span.remove();
      return perChar;
    };
    const prose = "the quick brown fox jumps over a lazy dog, then writes another long line of ordinary prose";
    charWidths = {
      mono: probe(`13px ${cssVar("--mono")}`, "M".repeat(100)),
      prose: probe(getComputedStyle(document.body).font || "13px system-ui, sans-serif", prose),
    };
    return charWidths;
  }

  /** Default width: gutter, text padding and borders included, so the columns really fit. */
  function defaultWidth(kind) {
    const widths = measureCharWidths();
    if (kind === "source") return Math.round(52 + 24 + 2 + widths.mono * SOURCE_COLS);
    if (kind === "question") return 460;
    return Math.round(24 + 2 + widths.prose * NOTE_COLS);
  }

  const overlaps = (a, b) =>
    a.x < b.x + b.w + GAP && a.x + a.w + GAP > b.x && a.y < b.y + b.h + GAP && a.y + a.h + GAP > b.y;

  /** Closest free spot to an anchor, searched outward in rings. The board owns placement, never the agent. */
  function findFreeSpot(w, h, anchor) {
    const ax = anchor ? anchor.x : 60;
    const ay = anchor ? anchor.y : 60;
    let best = null;
    let bestScore = Infinity;
    for (let ring = 0; ring < 60; ring++) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const x = Math.round((ax + dx * STEP) / STEP) * STEP;
          const y = Math.round((ay + dy * STEP) / STEP) * STEP;
          if (x < 0 || y < 0) continue;
          const rect = { x, y, w, h };
          if (occupied.some((other) => overlaps(rect, other))) continue;
          const score = Math.hypot(x - ax, y - ay);
          if (score < bestScore) {
            bestScore = score;
            best = rect;
          }
        }
      }
      if (best) return best;
    }
    // Every ring was searched and none was free: put the card clear of the whole board, right of
    // the rightmost card and level with the highest one, instead of stacking it on the card that
    // already sits at the anchor.
    const right = occupied.reduce((far, spot) => Math.max(far, spot.x + spot.w), -Infinity);
    const top = occupied.reduce((high, spot) => Math.min(high, spot.y), Infinity);
    // Nothing placed yet (or nothing with a positive edge): the anchor is the whole board.
    if (right === -Infinity || top === Infinity) return { x: ax, y: ay, w, h };
    return { x: right + GAP, y: top, w, h };
  }

  /** The cards one reply spawned, oldest first: the order they arrived in. */
  const threadMates = (thread) => cards.filter((card) => card.dataset.threadRoot === thread);

  /**
   * A thread cascades from the card the reply was asked on, like a stack of windows: each card
   * one header lower and a little right, so every title stays readable. A long thread wraps into
   * a column right of the one before it instead of running off the canvas.
   */
  const THREAD_STEP_Y = 34;
  const THREAD_ROWS = 8;
  const rectOf = (card) => JSON.parse(card.dataset.rect);

  /**
   * One slot in a cascade: the column origin `right` the cascade opens from, the row it lands on,
   * and the card's size. Column 0 sits under the anchor; a later column clears the widest card of
   * the one before it, so both callers agree on the geometry.
   */
  function cascadeSpot(origin, right, position, width, height) {
    const column = Math.floor((position - 1) / THREAD_ROWS);
    const step = ((position - 1) % THREAD_ROWS) + 1;
    return {
      x: (column ? right + GAP : origin.x) + step * STEP,
      y: origin.y + step * THREAD_STEP_Y,
      w: width,
      h: height,
    };
  }

  function threadSpot(thread, width, height) {
    const anchor = thread ? byId.get(thread) : null;
    const base = anchor && anchor.card.dataset.rect ? rectOf(anchor.card) : null;
    // An anchor that is gone, or a card with no thread, keeps the free-spot rule.
    if (!base) return null;
    const mates = threadMates(thread);
    const placed = [base, ...mates.map(rectOf)];
    const mine = new Set([thread, ...mates.map((card) => card.dataset.id)]);
    // Where the thread already reaches, read from the cards as they sit so sideways drift is
    // included and closing one cannot narrow the column it left behind. A wrap clears this.
    const right = placed.reduce((far, rect) => Math.max(far, rect.x + rect.w), -Infinity);
    // The first slot nobody else holds: a closed sibling leaves a hole, and the next arrival takes
    // it instead of landing exactly on a card that is still there.
    for (let position = 1; position <= cards.length + 1; position++) {
      const rect = cascadeSpot(base, right, position, width, height);
      // A card that is neither the anchor nor a sibling is in the way, so the cascade gives up
      // rather than opening a note buried under a card the human is reading.
      if (cards.some((card) => !mine.has(card.dataset.id) && overlaps(rect, rectOf(card)))) return null;
      if (!placed.some((other) => other.x === rect.x && other.y === rect.y)) return rect;
    }
    return null;
  }

  /**
   * Z within one thread only, so cards outside it keep the order the human gave them. The anchor
   * is the thread's oldest card and is ordered with its members; the restamp starts from the lowest
   * z the group already holds, so the thread keeps its place among the other cards however often
   * the pass runs.
   */
  function applyThreadOrder(thread) {
    const anchor = byId.get(thread);
    const stack = anchor ? [anchor.card, ...threadMates(thread)] : threadMates(thread);
    if (!newestFirst) stack.reverse();
    let next = stack.reduce((low, card) => Math.min(low, Number(card.style.zIndex) || z), z);
    for (const card of stack) card.style.zIndex = next++;
    z = Math.max(z, next);
  }

  function applyAllThreadOrder() {
    for (const thread of new Set(cards.map((card) => card.dataset.threadRoot))) {
      if (thread) applyThreadOrder(thread);
    }
  }

  const viewportCenter = () => ({
    x: (viewport.clientWidth / 2 - view.x) / view.k,
    y: (viewport.clientHeight / 2 - view.y) / view.k,
  });

  // ---------- helpers ------------------------------------------------------
  const escapeHtml = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const el = (tag, cls) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  };
  /** The card dot's colour, in one place so the card and its rail row cannot drift apart. */
  const dotKind = (kind) =>
    kind === "source" ? "code" : kind === "question" ? "question" : kind === "sticky" ? "sticky" : "note";
  /**
   * The world is zoomed with the CSS `zoom` property, so text is laid out at the size it is
   * shown at and never softens the way a scaled bitmap does. `zoom` scales the element's own
   * offsets too, hence dividing the pan by the scale.
   */
  const ZOOM_SUPPORTED = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("zoom", "2");
  const applyView = () => {
    if (ZOOM_SUPPORTED) {
      world.style.zoom = view.k;
      world.style.left = `${view.x / view.k}px`;
      world.style.top = `${view.y / view.k}px`;
    } else {
      // Older browsers only have the bitmap scale, which softens text while it catches up.
      world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
    }
    if (typeof recomputePill === "function") recomputePill();
    // The button says the zoom it is showing, not a fixed promise of 100%.
    resetBtn.textContent = `${Math.round(view.k * 100)}%`;
    // The board's zoom scales the focus ring drawn inside it too, so the rule in index.html
    // divides the ring by this to keep it the same thickness at every zoom.
    document.documentElement.style.setProperty("--zoom", String(view.k));
  };

  // ---------- syntax highlighting -----------------------------------------
  const TOKENS =
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:[^`\\]|\\.)*`)|(#.*$|\/\/.*$)|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_]\w*(?=\())|(\b(?:def|class|return|if|elif|else|for|while|import|from|as|try|except|finally|with|lambda|yield|await|async|const|let|var|function|export|default|new|throw|catch|switch|case|break|continue|type|interface|struct|fn|pub|use|mod|match|impl|self|this|True|False|None|null|true|false|nil|end|do|then)\b)/g;

  function highlight(raw) {
    let out = "";
    let last = 0;
    for (const match of raw.matchAll(TOKENS)) {
      const [text] = match;
      out += escapeHtml(raw.slice(last, match.index));
      const cls = match[1] ? "s" : match[2] ? "c" : match[3] ? "n2" : match[4] ? "f" : "k";
      out += `<span class="${cls}">${escapeHtml(text)}</span>`;
      last = match.index + text.length;
    }
    out += escapeHtml(raw.slice(last));
    return out || "&nbsp;";
  }

  // ---------- markdown -----------------------------------------------------
  function inlineMd(text) {
    let out = escapeHtml(text);
    // Cross-references jump to another card, but a key inside inline code stays literal.
    out = out
      .split(/(`[^`]+`)/)
      .map((piece) =>
        piece.startsWith("`")
          ? piece
          : piece.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, key, label) => {
              const name = key.trim();
              return `<a class="xref" href="#" data-key="${name}" title="jump to ${name}">${(label || name).trim()}</a>`;
            }),
      )
      .join("");
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|\W)\*([^*]+)\*/g, "$1<em>$2</em>");
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return out;
  }

  function sanitizeSvg(svg) {
    return svg
      .replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, "")
      .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      .replace(/javascript:/gi, "");
  }

  /** `|---|:--:|` under a header row is what makes the block above it a table. */
  function isTableRule(line) {
    return typeof line === "string" && line.includes("-") && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line);
  }

  function tableCells(line) {
    return line
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((cell) => cell.trim());
  }

  function renderTable(headerLine, ruleLine, bodyLines) {
    const wrap = el("div", "table-wrap");
    const table = el("table");
    const align = tableCells(ruleLine).map((spec) =>
      spec.startsWith(":") && spec.endsWith(":") ? "center" : spec.endsWith(":") ? "right" : spec.startsWith(":") ? "left" : "",
    );
    const head = el("thead");
    const headRow = el("tr");
    tableCells(headerLine).forEach((cell, column) => {
      const th = el("th");
      th.innerHTML = inlineMd(cell);
      if (align[column]) th.style.textAlign = align[column];
      headRow.appendChild(th);
    });
    head.appendChild(headRow);
    const body = el("tbody");
    for (const line of bodyLines) {
      const row = el("tr");
      const cells = tableCells(line);
      // Rows shorter than the header still line up, and extra cells are kept rather than lost.
      const width = Math.max(cells.length, headRow.childElementCount);
      for (let column = 0; column < width; column += 1) {
        const td = el("td");
        td.innerHTML = inlineMd(cells[column] ?? "");
        if (align[column]) td.style.textAlign = align[column];
        row.appendChild(td);
      }
      body.appendChild(row);
    }
    table.append(head, body);
    wrap.appendChild(table);
    return wrap;
  }

  function renderMarkdown(markdown) {
    const holder = el("div");
    const fences = [];
    let tickIndex = 0;
    // A fence is three or more backticks and closes on a run of the same length, so a task packet
    // that quotes its own code block can still travel inside one fence of its own.
    const stripped = markdown.replace(/(`{3,})([a-zA-Z0-9_-]*)\n([\s\S]*?)\1/g, (_m, _fence, lang, body) => {
      const index = fences.push({ lang: lang.toLowerCase(), body }) - 1;
      return `\u0000FENCE${index}\u0000`;
    });

    // A fence may follow text on the next single newline, so give every marker its own block.
    const spaced = stripped.replace(/(\u0000FENCE\d+\u0000)/g, "\n\n$1\n\n");
    for (const block of spaced.split(/\n{2,}/)) {
      const fenceTag = block.match(/^\u0000FENCE(\d+)\u0000$/);
      if (fenceTag) {
        const { lang, body } = fences[Number(fenceTag[1])];
        if (lang === "svg") {
          const wrap = el("div", "svg-wrap");
          wrap.innerHTML = sanitizeSvg(body);
          holder.appendChild(wrap);
        } else {
          const pre = el("pre");
          const code = el("code");
          code.textContent = body.replace(/\n$/, "");
          pre.appendChild(code);
          holder.appendChild(pre);
        }
        continue;
      }
      // Lines are walked one by one, so a list can be followed by a paragraph with no blank
      // line between them, which is what typing under a list produces.
      const lines = block.split("\n");
      let ul = null;
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        // A table is a header row, a separator row, then body rows until something else.
        // The separator needs a pipe of its own and must line up with the header, otherwise a
        // paragraph that ends in a pipe and is followed by `---` would become a table.
        if (
          /\|/.test(line) &&
          isTableRule(lines[index + 1]) &&
          lines[index + 1].includes("|") &&
          tableCells(line).length === tableCells(lines[index + 1]).length
        ) {
          const rows = [];
          let cursor = index + 2;
          while (cursor < lines.length && /\|/.test(lines[cursor])) rows.push(lines[cursor++]);
          holder.appendChild(renderTable(line, lines[index + 1], rows));
          ul = null;
          index = cursor - 1;
          continue;
        }
        const item = line.match(/^\s*[-*+]\s+(.*)$/);
        if (item) {
          if (!ul) {
            ul = el("ul");
            holder.appendChild(ul);
          }
          const li = el("li");
          const box = item[1].match(/^\[([ xX])\]\s*(.*)$/);
          li.innerHTML = box
            ? `<span class="tick" title="tick it">${box[1].trim() ? "☑" : "☐"}</span> ${inlineMd(box[2])}`
            : inlineMd(item[1]);
          if (box) li.dataset.tick = String(tickIndex++);
          ul.appendChild(li);
          continue;
        }
        ul = null;
        if (!line.trim()) continue;
        const heading = line.match(/^(#{1,6})\s+(.*)$/);
        if (heading) {
          // The level is kept up to h3: a deeper heading is as small as a card can show it.
          const h = el(`h${Math.min(heading[1].length, 3)}`);
          h.innerHTML = inlineMd(heading[2]);
          holder.appendChild(h);
          continue;
        }
        if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
          holder.appendChild(el("hr"));
          continue;
        }
        // `>` lines group into one quote; a bare `>` splits it into paragraphs.
        const quoted = line.match(/^\s*>\s?(.*)$/);
        if (quoted) {
          const pieces = [];
          let cursor = index;
          while (cursor < lines.length) {
            const next = lines[cursor].match(/^\s*>\s?(.*)$/);
            if (!next) break;
            pieces.push(next[1]);
            cursor += 1;
          }
          const quote = el("blockquote");
          const para = [];
          const flush = () => {
            if (!para.length) return;
            const p = el("p");
            p.innerHTML = inlineMd(para.join(" "));
            quote.appendChild(p);
            para.length = 0;
          };
          for (const piece of pieces) {
            if (piece.trim()) para.push(piece.trim());
            else flush();
          }
          flush();
          holder.appendChild(quote);
          ul = null;
          index = cursor - 1;
          continue;
        }
        const p = el("p");
        p.innerHTML = inlineMd(line);
        holder.appendChild(p);
      }
    }
    return holder;
  }

  // ---------- bodies -------------------------------------------------------
  /** Virtualized code view: only visible lines exist in the DOM. */
  function sourceBody(data) {
    const lines = data.content.split("\n");
    const scroll = el("div", "code-scroll");
    const inner = el("div", "code-inner");
    const width = lines.reduce((max, line) => Math.max(max, line.length), 0);
    inner.style.height = `${lines.length * LINE_HEIGHT}px`;
    inner.style.width = `${GUTTER + Math.min(width, 260) * measureCharWidths().mono + 30}px`;
    scroll.appendChild(inner);

    let first = -1;
    let last = -1;
    const hit = data.line;

    const renderWindow = () => {
      const height = scroll.clientHeight || 320;
      const start = Math.max(0, Math.floor(scroll.scrollTop / LINE_HEIGHT) - 6);
      const end = Math.min(lines.length - 1, Math.ceil((scroll.scrollTop + height) / LINE_HEIGHT) + 6);
      if (start === first && end === last) return;
      first = start;
      last = end;
      const fragment = document.createDocumentFragment();
      for (let i = start; i <= end; i++) {
        const row = el("div", "row" + (hit === i + 1 ? " hit" : ""));
        row.style.top = `${i * LINE_HEIGHT}px`;
        row.innerHTML = `<span class="n">${i + 1}</span><span class="t">${highlight(lines[i])}</span>`;
        fragment.appendChild(row);
      }
      inner.replaceChildren(fragment);
    };

    let scheduled = false;
    scroll.addEventListener("scroll", () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        renderWindow();
      });
    });
    new ResizeObserver(() => renderWindow()).observe(scroll);
    renderWindow();
    requestAnimationFrame(() => {
      if (hit && hit > 0) {
        scroll.scrollTop = Math.max(0, (hit - 1) * LINE_HEIGHT - (scroll.clientHeight / 2 - LINE_HEIGHT / 2));
      }
      renderWindow();
    });
    return scroll;
  }

  function questionBody(data, entry) {
    // A question that ran out of time is as settled as an answered one: its buttons are dead and
    // the header says which of the two happened.
    const settled = data.status === "answered" || data.status === "expired";
    const holder = el("div", "q-body");
    const text = el("div", "q-text");
    text.innerHTML = inlineMd(data.question || "");
    holder.appendChild(text);

    // The arrival lands the keyboard here, so a focused option cannot answer on Space or Enter.
    const buttons = el("div", "q-options");
    buttons.tabIndex = -1;
    // Built before the options are wired: every answer path hands the row to submitAnswer, which
    // takes it out of the card while the send is in flight and puts it back if the send fails.
    let freeRow = null;
    if (data.allowFreeText && !settled) {
      freeRow = el("div", "q-free");
      const input = el("input");
      input.placeholder = "or type an answer…";
      const send = el("button", "q-opt");
      send.textContent = "send";
      const fire = () => {
        const value = input.value.trim();
        if (value) submitAnswer(entry, value, buttons, freeRow);
      };
      send.addEventListener("click", fire);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") fire();
      });
      freeRow.append(input, send);
    }

    for (const option of data.options || []) {
      const button = el("button", "q-opt");
      button.textContent = option;
      if (settled) {
        button.disabled = true;
        if (data.answer === option) button.classList.add("picked");
      } else {
        button.addEventListener("click", () => submitAnswer(entry, option, buttons, freeRow));
      }
      buttons.appendChild(button);
    }
    holder.appendChild(buttons);
    if (freeRow) holder.appendChild(freeRow);

    if (data.status === "answered") {
      const done = el("div", "q-done");
      done.textContent = `answered: ${data.answer || "—"}`;
      holder.appendChild(done);
    }
    return holder;
  }

  async function submitAnswer(entry, answer, buttons, freeRow) {
    buttons.querySelectorAll("button").forEach((button) => (button.disabled = true));
    if (freeRow) freeRow.remove();
    for (const button of buttons.querySelectorAll("button")) {
      if (button.textContent === answer) button.classList.add("picked");
    }
    let problem = "";
    try {
      const response = await fetch(`/answer?${auth}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId: entry.id, answer }),
      });
      // A 409 means the question expired or another tab answered it, so nothing was delivered.
      if (!response.ok) problem = (await response.text()).trim() || "could not send — the question may have expired";
    } catch {
      problem = "could not reach the board server";
    }
    if (!problem) return;
    // The agent got nothing, so the card goes back to looking unanswered: a picked option and
    // dead buttons would read as sent.
    for (const button of buttons.querySelectorAll("button")) {
      button.disabled = false;
      button.classList.remove("picked");
    }
    if (freeRow) buttons.after(freeRow);
    const holder = buttons.parentElement;
    let warn = holder.querySelector(".q-done");
    if (!warn) {
      warn = el("div", "q-done");
      warn.setAttribute("role", "alert");
      holder.appendChild(warn);
    }
    // Styled as a failure, so it does not read as a muted "answered: …" line.
    warn.classList.add("q-problem");
    warn.textContent = problem;
  }

  /** One follow-up exchange: your question, what happened to it, then the answer. */
  function turnNode(turn) {
    const wrap = el("div", `turn ${turn.status || "queued"}`);
    const question = el("div", "turn-q");
    question.textContent = turn.text || "";
    wrap.appendChild(question);
    const status = el("div", `turn-status ${turn.status || "queued"}`);
    status.textContent =
      turn.status === "answered"
        ? "answered"
        : turn.status === "stopped"
          ? "stopped"
          : turn.status === "sent"
            ? "sent"
            : `queued · ${turn.mode === "steer" ? "steer" : "queue"}`;
    wrap.appendChild(status);
    if (turn.images) {
      const shot = el("div", "turn-status");
      shot.textContent = `${turn.images} image${turn.images > 1 ? "s" : ""} attached`;
      wrap.appendChild(shot);
    }
    if (turn.reply) {
      const answer = el("div", "turn-a note-body");
      answer.appendChild(renderMarkdown(turn.reply));
      wrap.appendChild(answer);
    }
    return wrap;
  }

  /**
   * Follow-ups live in the card they are about, below its body, so asking again never pushes a
   * new card onto the canvas.
   */
  function paintThread(entry, data) {
    const turns = Array.isArray(data.turns) ? data.turns : [];
    const last = turns[turns.length - 1];
    // News is a turn that was not there before, or the last turn's answer landing; a thread the
    // card is created with is history. Either way it fires once per real answer.
    const seen = entry.threadSeen ?? { count: turns.length, answered: Boolean(last?.reply) };
    const fresh = turns.length > seen.count || (Boolean(last?.reply) && !seen.answered);
    entry.threadSeen = { count: turns.length, answered: Boolean(last?.reply) };
    entry.thread.hidden = turns.length === 0;
    entry.thread.replaceChildren(...turns.map(turnNode));
    if (!fresh) return;
    // The note above the thread can be taller than the card, so the answer would land below the
    // fold with nothing moving: the card's own column scrolls down to it.
    requestAnimationFrame(() => {
      entry.scroll.scrollTop = entry.scroll.scrollHeight;
    });
  }

  /** A message from the user, with the agent's answer attached once it arrives. */
  function stickyBody(data) {
    const holder = el("div", "sticky-body");
    // A thread card keeps its conversation in the turns, and the daemon sends no text of its own: an
    // empty one is not a message, so it draws no bubble and no state line beside it.
    const said = String(data.text ?? "").trim();
    if (said) {
      const text = el("div", "sticky-text");
      text.textContent = said;
      holder.appendChild(text);
      if (data.images) {
        const shot = el("div", "sticky-status");
        shot.textContent = `${data.images} image${data.images > 1 ? "s" : ""} attached`;
        holder.appendChild(shot);
      }
      const status = el("div", `sticky-status ${data.status || "queued"}`);
      status.textContent =
        data.status === "answered"
          ? "answered"
          : data.status === "stopped"
            ? "stopped"
            : data.status === "sent"
              ? "sent"
              : `queued · ${data.mode === "steer" ? "steer" : "queue"}`;
      holder.appendChild(status);
    }
    if (data.reply) {
      const reply = el("div", "sticky-reply note-body");
      reply.appendChild(renderMarkdown(data.reply));
      holder.appendChild(reply);
    }
    return holder;
  }

  /**
   * The fold's state per card id: a repaint rebuilds the body on every tick and a reconnect replays
   * the snapshot, so the open state and the scroll offset cannot live on the entry.
   */
  const foldState = new Map();

  /**
   * The folded detail under a card: the full prompt a delegate was given and what it spent.
   */
  function detailsBlock(details, entry) {
    const state = foldState.get(entry.id) ?? { open: false, top: 0 };
    foldState.set(entry.id, state);
    const box = el("details", "card-details");
    const summary = el("summary");
    summary.textContent = "prompt and usage";
    const inner = el("div", "details-body");
    inner.appendChild(renderMarkdown(details));
    box.append(summary, inner);
    box.open = state.open;
    box.addEventListener("toggle", () => {
      state.open = box.open;
      // A settled run is never re-broadcast, so nothing else grows the card for the fold and the
      // human would get a scroller inside a scroller.
      if (box.open) fitContent(entry, entry.data);
    });
    inner.addEventListener("scroll", () => {
      state.top = inner.scrollTop;
    });
    // The inner body is a new element on every repaint and starts at the top, so put it back.
    requestAnimationFrame(() => {
      inner.scrollTop = state.top;
    });
    return box;
  }

  function bodyFor(data, entry) {
    if (data.type === "source") return { node: sourceBody(data), cls: "source-body" };
    if (data.type === "sticky") return { node: stickyBody(data), cls: "" };
    if (data.type === "question") return { node: questionBody(data, entry), cls: "" };
    const note = renderMarkdown(data.markdown || "");
    // Into the renderer's own holder, so `.note-body > :first-child` still finds the note's first
    // element instead of a wrapper. A note without details keeps the body it had before the fold.
    if (data.details) note.appendChild(detailsBlock(data.details, entry));
    return { node: note, cls: "note-body" };
  }

  // ---------- cards --------------------------------------------------------
  /** Half a card on screen for this long is a card the human has had a chance to read. */
  const SEEN_MS = 1500;
  const seenTimers = new Map();
  /** Only the cards the observer last called on screen may start a countdown. */
  const inView = new Set();
  /** A ratio reported as an int can sit a hair under the threshold the card just crossed. */
  const RATIO_EPS = 0.01;

  function forgetSeen(card) {
    const timer = seenTimers.get(card);
    if (timer) clearTimeout(timer);
    seenTimers.delete(card);
  }

  function armSeen(card) {
    // A hidden tab is nobody looking, so it schedules nothing: visibilitychange starts over.
    if (document.hidden || seenTimers.has(card)) return;
    seenTimers.set(
      card,
      setTimeout(() => {
        seenTimers.delete(card);
        if (!document.hidden) clearFresh(card);
      }, SEEN_MS),
    );
  }

  /**
   * "New" has to expire on its own, or every card ends up wearing the same border and badge and
   * the mark stops meaning anything. The countdown belongs to the time the card is on screen: a
   * card scrolled away before it fires is still new when it comes back.
   */
  const seenObserver = new IntersectionObserver(
    (hits) => {
      for (const hit of hits) {
        // The root is the canvas, not the window: a card the rail or the bars clip is not in
        // front of the human even when it sits inside the window. Half of whichever is smaller,
        // so a card taller than the canvas still counts once half the canvas shows it.
        const half = Math.min(hit.boundingClientRect.height, viewport.clientHeight) * 0.5;
        const onScreen = hit.isIntersecting && (hit.intersectionRatio >= 0.5 - RATIO_EPS || hit.intersectionRect.height >= half);
        if (onScreen) {
          inView.add(hit.target);
          armSeen(hit.target);
        } else {
          inView.delete(hit.target);
          forgetSeen(hit.target);
        }
      }
      // The pill counts what the same rule does not call on screen, so the two cannot disagree.
      recomputePill();
    },
    { root: viewport, threshold: [0, 0.5] },
  );

  /**
   * The one place a card stops being new: the border, the badge, the rail row and the pill all
   * read .fresh, so they have to change together or the board contradicts itself.
   */
  function clearFresh(card) {
    if (!card || !card.classList.contains("fresh")) return;
    card.classList.remove("fresh");
    forgetSeen(card);
    inView.delete(card);
    seenObserver.unobserve(card);
    // Hidden, not removed: dropping the badge would shift the buttons under the pointer.
    const badge = card.querySelector(".new-badge");
    if (badge) badge.style.visibility = "hidden";
    syncRailCard(byId.get(card.dataset.id));
    recomputePill();
  }

  /** A delegate card reports its own progress, so it redraws far more often than a note. */
  function isDelegate(data) {
    return typeof data.key === "string" && data.key.startsWith("delegate-");
  }

  function makeCard(data, quiet = false) {
    const isSource = data.type === "source";
    const isQuestion = data.type === "question";
    const kind = data.type;
    const isNote = data.type === "note";
    const width = data.rect ? data.rect.w : defaultWidth(kind);
    // A delegate card opens small and grows as the run reports; a normal note wants the room.
    const delegate = isDelegate(data);
    const defaultHeight = isSource ? 430 : isQuestion ? 300 : isNote ? (delegate ? 220 : 420) : 300;
    const height = data.rect ? data.rect.h : defaultHeight;

    // The server remembers where a card was put, so a refresh and other tabs agree. A card
    // without a place cascades under the card its reply was asked on, and without a thread goes
    // in the nearest free area to the middle of what you are looking at.
    const spot = data.rect
      ? { x: data.rect.x, y: data.rect.y, w: width, h: height }
      : threadSpot(data.threadRoot, width, height) ?? findFreeSpot(width, height, viewportCenter());
    occupied.push(spot);
    if (!data.rect) void saveLayout(data.id, spot);

    const card = el("div", kind === "sticky" ? "card sticky" : "card");
    card.style.cssText = `left:${spot.x}px; top:${spot.y}px; width:${width}px; height:${height}px; z-index:${z++}`;
    card.dataset.rect = JSON.stringify(spot);
    card.dataset.kind = kind;
    card.dataset.id = data.id;
    if (data.threadRoot) card.dataset.threadRoot = data.threadRoot;

    const head = el("div", "head");
    head.innerHTML = `
      <span class="dot ${dotKind(kind)}"></span>
      <span class="title"></span>
      <span class="sub"></span>
      <span class="spacer"></span>
      <button type="button" class="ask-pill" aria-label="centre this question">answer needed</button>
      <span class="chip"></span>
      <button class="stop" title="stop this thread" aria-label="stop this thread">■</button>
      <button class="min" title="minimize this card" aria-label="minimize this card">▾</button>
      <button class="reply" title="ask a follow-up about this card" aria-label="ask a follow-up about this card">↩</button>
      <button class="edit" title="edit this note" aria-label="edit this note">✎</button>
      <button class="close" title="close" aria-label="close">×</button>`;
    // One scroll column holds the note and its follow-ups, so a long card has one scrollbar.
    const scroll = el("div", "card-scroll");
    const body = el("div", "body");
    const thread = el("div", "thread");
    thread.hidden = true;
    scroll.append(body, thread);
    const grip = el("div", "resize");
    card.append(head, scroll, grip);
    world.appendChild(card);
    cards.push(card);
    // A new card takes its place in the stack; a replay settles every thread once it is done.
    if (data.threadRoot && !replaying) applyThreadOrder(data.threadRoot);

    const badge = el("span", "new-badge");
    // A restored card is one you already had, so it does not carry a "new" tag.
    if (replaying || quiet) badge.style.visibility = "hidden";
    badge.textContent = "new";
    head.insertBefore(badge, head.querySelector(".close"));
    if (!replaying) {
      card.classList.add("fresh");
      // Watched only while it can still stop being new.
      seenObserver.observe(card);
    }
    // A card the human clicks is seen at once, without waiting for the observer's countdown. A
    // middle press is the workspace grab and belongs to the canvas, so it reads as neither a click
    // nor a raise: it must not mark a card read, lift it, or take the selection away.
    card.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button === 1) return;
        clearFresh(card);
      },
      true,
    );

    const entry = {
      id: data.id,
      card,
      head,
      scroll,
      body,
      thread,
      titleEl: head.querySelector(".title"),
      subEl: head.querySelector(".sub"),
      chipEl: head.querySelector(".chip"),
      askPill: head.querySelector(".ask-pill"),
      data,
    };
    byId.set(data.id, entry);
    entry.askPill.addEventListener("click", (event) => {
      event.stopPropagation();
      centreQuestion(entry);
    });
    if (data.mini) setMini(card, true);
    paintCard(entry, data);
    // A card that arrives while another is selected must not arrive brighter than the rest.
    paintFocus();

    card.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button === 1) return;
        card.style.zIndex = z++;
        cards.forEach((c) => c.classList.toggle("active", c === card));
        paintFocus();
      },
      true,
    );

    // The keyboard and the mouse agree on which card is current: focus landing inside a card marks
    // it, so the outline, `r` and the digit keys follow the keyboard rather than the last click.
    card.addEventListener("focusin", (event) => {
      cards.forEach((c) => c.classList.toggle("active", c === card));
      paintFocus();
      reveal(event.target);
    });

    head.querySelector(".stop").addEventListener("click", (event) => {
      event.stopPropagation();
      // The same control does what its own face says: stop while the run is going, then kill if the stop
      // does not land. Nothing else remembers a mode for it.
      const kill = threadState(entry.data).running && stopping.has(entry.id);
      if (kill) stopping.delete(entry.id);
      else stopping.add(entry.id);
      void fetch(`/${kill ? "kill" : "stop"}?${auth}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId: entry.id }),
      });
    });

    head.querySelector(".min").addEventListener("click", (event) => {
      event.stopPropagation();
      const mini = !card.classList.contains("mini");
      setMini(card, mini);
      const rect = JSON.parse(card.dataset.rect || "{}");
      void saveLayout(entry.id, rect, mini);
    });

    head.querySelector(".reply").addEventListener("click", (event) => {
      event.stopPropagation();
      setReplyTarget(entry);
    });

    head.querySelector(".edit").addEventListener("click", (event) => {
      event.stopPropagation();
      startEditing(entry);
    });

    head.querySelector(".close").addEventListener("click", (event) => {
      event.stopPropagation();
      closeCard(entry);
    });

    head.addEventListener("pointerdown", (event) => {
      // Buttons in the header are for clicking, not for dragging the card. The middle button pans
      // the canvas even here, so it belongs to the workspace rather than to the card.
      if (event.button !== 0 || event.target.closest(INTERACTIVE)) return;
      startCardDrag(card, entry, event);
    });

    // The whole card is a handle. Dragging its text used to select the text, which made reading a
    // board feel like a web page rather than a surface: hold ctrl for that instead, the same modifier
    // the wheel uses for zoom.
    card.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey) return;
      // The head starts the same drag on its own press, and preventing the default there does not
      // stop the event from reaching here.
      if (card.classList.contains("dragging")) return;
      if (event.target.closest(INTERACTIVE)) return;
      startCardDrag(card, entry, event);
    });

    grip.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      const sx = event.clientX;
      const sy = event.clientY;
      const ow = card.offsetWidth;
      const oh = card.offsetHeight;
      const move = (ev) => {
        card.style.width = `${Math.max(240, ow + (ev.clientX - sx) / view.k)}px`;
        card.style.height = `${Math.max(120, oh + (ev.clientY - sy) / view.k)}px`;
        // A size the user chose wins over growing to fit later answers.
        card.dataset.sized = "user";
        card.classList.remove("auto-height");
      };
      const up = () => {
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", up);
        const rect = {
          x: Math.round(parseFloat(card.style.left)),
          y: Math.round(parseFloat(card.style.top)),
          w: card.offsetWidth,
          h: card.offsetHeight,
        };
        placeCard(entry, rect);
        void saveLayout(entry.id, rect);
      };
      addEventListener("pointermove", move);
      addEventListener("pointerup", up);
    });

    updateEmpty();
    return entry;
  }

  /** What the daemon last said about each thread, taken from the cards that speak for it. */
  const threadFacts = new Map();

  function compact(number) {
    const value = Number(number) || 0;
    if (value < 1000) return String(Math.round(value));
    if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
    return `${(value / 1_000_000).toFixed(1)}m`;
  }

  /** A section says what its thread costs and offers the stop the card's head also offers. */
  function paintSections() {
    for (const entry of railSections.values()) {
      const held = threadFacts.get(entry.id);
      const stats = held?.stats;
      const bits = [];
      if (stats?.context) bits.push(`${compact(stats.context)}${stats.contextMax ? `/${compact(stats.contextMax)}` : ""} ctx`);
      if (stats?.cost) bits.push(`$${stats.cost < 1 ? stats.cost.toFixed(2) : compact(stats.cost)}`);
      entry.head.children[3].textContent = bits.join(" · ");
      entry.head.children[4].hidden = held?.running !== true;
    }
  }

  /**
   * The thread a card belongs to. A thread card is its own; a plain card belongs to the thread that
   * made it, which is also the card it cascades under. Two cards share a family when they are the same
   * conversation.
   */
  function familyOf(entry) {
    const data = entry?.data ?? {};
    if (!entry) return "";
    return data.type === "sticky" ? entry.id : data.threadRoot || entry.id;
  }

  /**
   * Reading one conversation dims the others, so a board of a dozen threads stays readable while the
   * one you picked keeps its weight. With nothing selected, or with the feature off, everything is equal.
   */
  function paintFocus() {
    const on = boardConfig.dimOthers !== false;
    const selected = on ? cards.find((card) => card.classList.contains("active")) : undefined;
    const family = selected ? familyOf(byId.get(selected.dataset.id)) : "";
    for (const card of cards) {
      const entry = byId.get(card.dataset.id);
      card.classList.toggle("dim", Boolean(selected) && Boolean(entry) && familyOf(entry) !== family);
    }
  }

  /**
   * What answers this card is doing. A thread card says it itself — the daemon sends `sent` while a run
   * is live — and a plain card says it through the child that owns it.
   */
  function threadState(data) {
    if (!data) return { running: false };
    if (data.type === "sticky") return { running: data.status === "sent" };
    return { running: data.answersWith?.running === true };
  }

  /** A thread that has been asked to stop. A stop that does not land turns into a kill. */
  const stopping = new Set();

  /**
   * What a pointer down on a card may not grab: the controls in its head, the composer docked inside
   * it, a link or a checkbox, the resize corner. Everything else is surface, which drags the card.
   */
  const INTERACTIVE =
    ".close, .edit, .reply, .min, .stop, .ask-pill, .resize, input, textarea, button, a, [contenteditable], .xref, .tick, .q-options, #composer";

  /** Move a card by dragging it, in board units, so the card keeps up at any zoom. */
  function startCardDrag(card, entry, event) {
    // The text is not being selected, so the browser must not start selecting it.
    event.preventDefault();
    card.classList.add("dragging");
    const sx = event.clientX;
    const sy = event.clientY;
    const ox = parseFloat(card.style.left);
    const oy = parseFloat(card.style.top);
    const move = (ev) => {
      card.style.left = `${ox + (ev.clientX - sx) / view.k}px`;
      card.style.top = `${oy + (ev.clientY - sy) / view.k}px`;
    };
    const up = () => {
      card.classList.remove("dragging");
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      const rect = {
        x: Math.round(parseFloat(card.style.left)),
        y: Math.round(parseFloat(card.style.top)),
        w: card.offsetWidth,
        h: card.offsetHeight,
      };
      placeCard(entry, rect);
      void saveLayout(entry.id, rect);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  }

  /** The agent is blocked on this card until the question on it is answered. */
  function questionWants(data) {
    return Boolean(data) && data.type === "question" && data.status === "open";
  }

  /** A note says when it arrived, or when it last changed once it has changed. */
  function noteSub(data, entry) {
    if (!entry.updatedAt) return new Date(data.at || Date.now()).toLocaleTimeString();
    // Hours and minutes only: a card repainted on every run step must not flicker as seconds tick.
    return `updated ${new Date(entry.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }

  /**
   * An open question says when it gives up, so the wait has a visible end. A settled one says
   * what actually happened: an answer, or a question the board abandoned.
   */
  function questionSub(data) {
    if (data.status === "answered") return "answered";
    if (data.status === "expired") return "expired — no answer sent";
    if (!data.expiresAt) return "waiting for you";
    return `expires ${new Date(data.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }

  function paintCard(entry, data) {
    const isSource = data.type === "source";
    const isOpenQuestion = questionWants(data);
    entry.data = data;
    if (entry.editing) return;
    entry.titleEl.textContent =
      data.title || (isSource ? data.path : data.type === "question" ? "question" : data.type === "sticky" ? "you" : "note");
    entry.titleEl.title = entry.titleEl.textContent;
    entry.subEl.textContent = isSource
      ? `${data.content.split("\n").length} lines`
      : data.type === "question"
        ? questionSub(data)
        : data.type === "sticky"
          ? data.status || "queued"
          : noteSub(data, entry);
    entry.subEl.classList.toggle("expired", data.type === "question" && data.status === "expired");
    // The pink ring and the pill belong to the question the agent is blocked on, so both go
    // away the moment it is settled.
    entry.card.classList.toggle("waiting", isOpenQuestion);
    entry.askPill.style.display = isOpenQuestion ? "" : "none";
    const editBtn = entry.head.querySelector(".edit");
    if (editBtn) editBtn.style.display = data.type === "note" ? "" : "none";
    // One slot, two meanings: stop the run that is going, or end the child that is sitting idle. A card
    // with neither has nothing to stop, so it shows nothing.
    const stopBtn = entry.head.querySelector(".stop");
    const state = threadState(data);
    if (stopBtn) {
      // Gone quiet again, so the next stop starts over as a stop.
      if (!state.running) stopping.delete(data.id);
      const kill = state.running && stopping.has(data.id);
      stopBtn.style.display = state.running ? "" : "none";
      stopBtn.textContent = kill ? "⊗" : "■";
      stopBtn.classList.toggle("killing", kill);
      stopBtn.title = kill ? "kill this thread's child" : "stop this thread's run";
      stopBtn.setAttribute("aria-label", stopBtn.title);
    }
    const closeBtn = entry.head.querySelector(".close");
    // Closing an open question would leave the agent waiting for an answer with nothing on
    // screen to click, so the button appears only once it has been answered or has expired.
    if (closeBtn) closeBtn.style.display = isOpenQuestion ? "none" : "";
    entry.chipEl.textContent = isSource && data.line ? `line ${data.line}` : "";
    entry.chipEl.style.display = entry.chipEl.textContent ? "" : "none";

    const { node, cls } = bodyFor(data, entry);
    entry.body.className = cls ? `body ${cls}` : "body";
    entry.body.replaceChildren(node);
    paintThread(entry, data);
    fitContent(entry, data);
    renumberQueue();
    syncRailCard(entry);
  }

  /**
   * A note that holds more than its default height grows to fit, up to the CSS limit, so
   * nothing hides behind an inner scrollbar. It never shrinks on its own, and a card the user
   * resized keeps that size. An answered sticky does the same for its reply.
   */
  function fitContent(entry, data) {
    if (entry.card.dataset.sized === "user" || entry.card.classList.contains("mini")) return;
    const answeredSticky = data.type === "sticky" && Boolean(data.reply);
    const threaded = Array.isArray(data.turns) && data.turns.length > 0;
    // A question grows too: long options and the free-text row would otherwise hide behind the
    // column's scrollbar while the card sits at its default height.
    if (data.type !== "note" && data.type !== "question" && !answeredSticky && !threaded) return;
    requestAnimationFrame(() => {
      if (entry.card.dataset.sized === "user") return;
      // The note and its follow-ups share one column, so one measurement covers both.
      const tight = entry.scroll.scrollHeight > entry.scroll.clientHeight + 2;
      if (!tight) return;
      entry.card.classList.add("auto-height");
      requestAnimationFrame(() => {
        // The card can be closed between the two frames, and a snapshot replay clears and
        // re-creates the same id, so only this same entry may still claim a place.
        if (byId.get(entry.id) !== entry) return;
        const rect = {
          x: Math.round(parseFloat(entry.card.style.left)),
          y: Math.round(parseFloat(entry.card.style.top)),
          w: entry.card.offsetWidth,
          h: entry.card.offsetHeight,
        };
        // Through placeCard, so the space the card grew into is the space later cards avoid.
        placeCard(entry, rect);
        void saveLayout(entry.id, rect);
      });
    });
  }

  /**
   * Pending messages read as next, 2nd, 3rd in the order they will be answered, and the
   * labels shift up as each one is dealt with.
   */
  function ordinalPosition(position) {
    if (position === 1) return "next";
    const suffix = ["th", "st", "nd", "rd"];
    const rest = position % 100;
    return `${position}${suffix[(rest - 20) % 10] || suffix[rest] || suffix[0]}`;
  }

  function renumberQueue() {
    let position = 0;
    for (const card of cards) {
      const record = byId.get(card.dataset.id);
      if (!record || record.data.type !== "sticky") continue;
      if (record.data.status === "answered" || record.data.status === "stopped") continue;
      position += 1;
      record.chipEl.textContent = ordinalPosition(position);
      record.chipEl.classList.add("queue-pos");
      record.chipEl.style.display = "";
    }
  }

  /**
   * The fields a repaint actually draws. A refresh that rewrites the same text is not news, and
   * a delegate card is re-broadcast every few seconds whether or not anything moved.
   */
  function cardChanged(before, after) {
    const fields = ["title", "markdown", "details", "text", "question", "reply", "status"];
    if (fields.some((field) => before[field] !== after[field])) return true;
    // A follow-up's answer settles into the turn it was asked with, so the thread changes without
    // gaining a turn: compare what each turn draws, not only how many there are.
    const was = before.turns || [];
    const now = after.turns || [];
    if (was.length !== now.length) return true;
    return now.some((turn, at) => {
      const old = was[at] || {};
      return old.text !== turn.text || old.status !== turn.status || old.reply !== turn.reply || old.images !== turn.images;
    });
  }

  /**
   * A card that changed says so. The ring is rate-limited because a progress card is re-broadcast
   * every few seconds; the header stamp is not, because it is cheap and has to be true.
   */
  function markUpdated(entry) {
    const now = Date.now();
    // A delegate card rebuilds its markdown with the elapsed time, so every progress tick would
    // move this stamp and pin the rail age near zero. Its body already shows that time.
    if (!isDelegate(entry.data)) entry.updatedAt = now;
    const card = entry.card;
    // A card that is still new already wears the mark, so a ring on top of it says nothing.
    if (card.classList.contains("fresh")) return;
    if (entry.flashedAt && now - entry.flashedAt < 10000) return;
    entry.flashedAt = now;
    flashCard(card);
  }

  function applyMessage(data, quiet = false) {
    const existing = byId.get(data.id);
    if (existing) {
      if (!replaying && !quiet) {
        // An identical re-broadcast would only wipe a selection and reset a scrolled body.
        if (!cardChanged(existing.data, data)) {
          // The paint is skipped, but the record still has to be current: what answers a card is not
          // drawn on it, and a stale copy would leave the composer's pickers showing an old model.
          existing.data = data;
          return;
        }
        markUpdated(existing);
      }
      paintCard(existing, data);
      return;
    }
    const entry = makeCard(data, quiet);
    recomputePill();
    if (!sawFirstCard) {
      sawFirstCard = true;
      if (!replaying) fitAll();
    }
    // An off-screen arrival is announced by the new-card pill, and a question has its own
    // centring below, so no scroll into view is needed (and the viewport cannot scroll).
    // A question blocks the agent, so it lands under the eye and the keyboard. A replay brings
    // back cards the user already has, so it never pulls the view or steals the focus.
    // A question already on screen keeps the view: a second one must not pull it away.
    const onScreen = [...byId.values()].some(
      (record) => record !== entry && record.data.type === "question" && record.data.status === "open" && isVisible(record.card),
    );
    if (!replaying && !quiet && data.type === "question" && data.status === "open" && !onScreen && !typingSomewhere()) {
      // One frame later: fitContent grows the card in its own rAF, so centring now would measure
      // the default height and leave the lower options under the fold.
      requestAnimationFrame(() => centreQuestion(entry));
    }
  }

  function clearBoard() {
    // The composer may be docked inside a card, so it comes home first: removing the cards
    // would take the field with them and leave nothing to type into.
    setReplyTarget(null);
    for (const card of cards) card.remove();
    cards.length = 0;
    byId.clear();
    // A replay rebuilds every card, so the observer must let go of the dead ones.
    seenObserver.disconnect();
    inView.clear();
    for (const timer of seenTimers.values()) clearTimeout(timer);
    seenTimers.clear();
    occupied.length = 0;
    freshCount = 0;
    clearRailCards();
    clearRailLog();
    paintPill();
    sawFirstCard = false;
    updateEmpty();
  }

  /** Close a card here and on the server, so a refresh does not bring it back. */
  function closeCard(entry) {
    dropCard(entry);
    void fetch(`/close?${auth}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardId: entry.id }),
    }).catch(() => {});
  }

  /** Remove a card from the board and let later cards fill the space it held. */
  function dropCard(entry) {
    const record = byId.get(entry.id);
    if (!record) return;
    // Compared by id: a remote remove arrives as a bare { id } and would never match the entry.
    if (replyTarget && replyTarget.id === record.id) setReplyTarget(null);
    record.card.remove();
    forgetSeen(record.card);
    inView.delete(record.card);
    seenObserver.unobserve(record.card);
    const at = cards.indexOf(record.card);
    if (at >= 0) cards.splice(at, 1);
    byId.delete(record.id);
    foldState.delete(record.id);
    dropRailCard(record.id);
    releaseSpot(record.card);
    renumberQueue();
    recomputePill();
    updateEmpty();
    paintFocus();
  }

  /** Free the rectangle a closed card was holding so later cards can fill the gap. */
  function releaseSpot(card) {
    const rect = card.dataset.rect ? JSON.parse(card.dataset.rect) : null;
    if (!rect) return;
    const index = occupied.findIndex((candidate) => candidate.x === rect.x && candidate.y === rect.y);
    if (index >= 0) occupied.splice(index, 1);
  }

  /** Deliberate re-pack of everything, only ever triggered by the user. */
  function tidy() {
    occupied.length = 0;
    const ordered = [...cards].sort((a, b) => (a.dataset.kind === "source" ? -1 : 0) - (b.dataset.kind === "source" ? -1 : 0));
    let cursor = { x: 60, y: 60 };
    for (const card of ordered) {
      const rect = findFreeSpot(card.offsetWidth, card.offsetHeight, cursor);
      occupied.push(rect);
      card.style.left = `${rect.x}px`;
      card.style.top = `${rect.y}px`;
      card.dataset.rect = JSON.stringify(rect);
      const record = byId.get(card.dataset.id);
      if (record) void saveLayout(record.id, { ...rect, w: card.offsetWidth, h: card.offsetHeight });
    }
    fitAll();
  }

  /**
   * Re-cascade every thread from its root, as if the cards had just arrived. Roots are visited in
   * arrival order, so a thread nested inside another cascades from a root that already moved. The
   * human pressed a button that moves furniture, so a card is placed by position even where
   * something stands; two threads that then overlap are left for tidy to sort out.
   */
  function stack() {
    for (const thread of new Set(cards.map((card) => card.dataset.threadRoot))) {
      if (!thread) continue;
      const root = byId.get(thread);
      // threadMates already answers in arrival order, which is the order the cascade climbs.
      const mates = threadMates(thread).map((card) => byId.get(card.dataset.id)).filter(Boolean);
      // A closed root hands the anchor to the earliest member still open, which stays where it is.
      const anchor = root || mates[0];
      if (!anchor || !anchor.card.dataset.rect) continue;
      const base = rectOf(anchor.card);
      // A card that names its own thread is root and member at once; as the anchor it stays put.
      const rest = mates.filter((member) => member !== anchor);
      // A column opens once, from the widest card of the column that finished, so its rows cannot
      // march right by a whole card each time.
      let column = 0;
      let right = base.x + base.w;
      let widest = right;
      for (const [index, member] of rest.entries()) {
        const at = Math.floor(index / THREAD_ROWS);
        if (at !== column) {
          column = at;
          right = widest;
        }
        const now = member.card.dataset.rect ? rectOf(member.card) : null;
        // A folded card measures as its header only; the stored height is the one to unfold into.
        const h = member.card.classList.contains("mini") && now ? now.h : member.card.offsetHeight;
        const rect = cascadeSpot(base, right, index + 1, member.card.offsetWidth, h);
        widest = Math.max(widest, rect.x + rect.w);
        // Already where the cascade wants it: nothing to move and nothing to save.
        if (now && now.x === rect.x && now.y === rect.y && now.w === rect.w && now.h === rect.h) continue;
        placeCard(member, rect);
        // One request per moved card, no batch: the client keeps no queue of its own and the human
        // asked for one action, so there is nothing to merge a batch out of.
        void saveLayout(member.id, rect);
      }
      applyThreadOrder(thread);
    }
    fitAll();
  }

  function paintPill() {
    const pill = document.getElementById("newPill");
    if (!pill) return;
    pill.textContent = freshCount > 0 ? `${freshCount} new` : "";
    pill.style.display = freshCount > 0 ? "" : "none";
  }

  /** The count follows the observer, so a card the pill counts is a card whose mark still counts. */
  function recomputePill() {
    freshCount = cards.filter((card) => card.classList.contains("fresh") && !inView.has(card)).length;
    paintPill();
  }

  function jumpToFresh() {
    const record = attentionCard();
    if (!record) return;
    view.k = Math.min(1.1, Math.max(view.k, 0.6));
    // A question takes the keyboard with it, the way it does when it arrives.
    if (questionWants(record.data)) centreQuestion(record);
    else centerOn(record);
    // One click clears one mark, so a second click moves on to the next card.
    clearFresh(record.card);
  }

  /**
   * What the pill leads to: an arrival the human has not looked at outranks a question that has
   * already waited out its mark, a question wins inside its group because it blocks the agent, and
   * the latest event beats the latest arrival.
   */
  function attentionCard() {
    const entries = (list) => list.map((card) => byId.get(card.dataset.id)).filter(Boolean);
    // A fresh card is one the pill counts, so the same rule picks it here.
    const fresh = entries(cards.filter((card) => card.classList.contains("fresh") && !inView.has(card)));
    const pool = fresh.length
      ? fresh
      : entries(cards.filter((card) => !isVisible(card))).filter((entry) => questionWants(entry.data));
    // The change stamp is later than the arrival the card opened with, so it is the newer event.
    const stamp = (entry) => entry.updatedAt || new Date(entry.data.at || 0).getTime() || 0;
    const ranked = pool.sort(
      (a, b) => Number(questionWants(b.data)) - Number(questionWants(a.data)) || stamp(b) - stamp(a),
    );
    return ranked[0] || null;
  }

  function isVisible(card) {
    const x = parseFloat(card.style.left) * view.k + view.x;
    const y = parseFloat(card.style.top) * view.k + view.y;
    return x < viewport.clientWidth && x + card.offsetWidth * view.k > 0 && y < viewport.clientHeight && y + card.offsetHeight * view.k > 0;
  }

  /**
   * Bring the focused control into view, moving the view as little as it can. A control already
   * fully on screen is left alone, so tabbing through a card never drags the canvas out from under
   * the reader, and a card taller than the screen shows the field the focus is on, not its top.
   */
  function reveal(node) {
    // A control touched to the header or the composer edge reads as cramped, so it keeps a margin.
    const margin = 12;
    const box = node.getBoundingClientRect();
    const area = viewport.getBoundingClientRect();
    const right = box.right - area.right;
    const bottom = box.bottom - area.bottom;
    if (box.left >= area.left + margin && box.top >= area.top + margin && right <= -margin && bottom <= -margin) return;
    if (box.left < area.left + margin) view.x += area.left + margin - box.left;
    else if (right > -margin) view.x -= right + margin;
    if (box.top < area.top + margin) view.y += area.top + margin - box.top;
    else if (bottom > -margin) view.y -= bottom + margin;
    applyView();
  }

  function updateEmpty() {
    if (emptyHint) emptyHint.style.display = cards.length ? "none" : "grid";
  }

  // ---------- view ---------------------------------------------------------
  /**
   * Ctrl (or Cmd) plus wheel zooms around the pointer. Otherwise the selection decides what the
   * wheel moves: with a card selected the wheel scrolls that card, wherever the pointer happens to
   * be, and with nothing selected it pans the board. Panning moves nothing on the board, so a stray
   * scroll still cannot rearrange it.
   */
  /** Tell the server where a card sits, so placement survives a refresh. */
  function saveLayout(cardId, rect, mini) {
    const body = { cardId, rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h } };
    // Only sent when it is asked for, so an ordinary move never clears a folded card.
    if (typeof mini === "boolean") body.mini = mini;
    return fetch(`/layout?${auth}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});
  }

  /**
   * Folding keeps the card's real height on the server, so restoring it puts the card back
   * exactly as it was. Only the header stays on the canvas.
   */
  function setMini(card, mini) {
    card.classList.toggle("mini", mini);
    card.dataset.mini = mini ? "1" : "0";
    const button = card.querySelector(".min");
    if (button) {
      button.textContent = mini ? "▸" : "▾";
      button.title = mini ? "restore this card" : "minimize this card";
      // The glyph says nothing out loud, so the spoken name follows the tooltip.
      button.setAttribute("aria-label", button.title);
    }
  }

  /** Move a card locally and take the space it now holds into account. */
  function placeCard(record, rect) {
    const card = record.card;
    card.style.left = `${rect.x}px`;
    card.style.top = `${rect.y}px`;
    if (rect.w) card.style.width = `${rect.w}px`;
    if (rect.h) card.style.height = `${rect.h}px`;
    const old = card.dataset.rect ? JSON.parse(card.dataset.rect) : null;
    if (old) {
      const at = occupied.findIndex((spot) => spot.x === old.x && spot.y === old.y);
      if (at >= 0) occupied.splice(at, 1);
    }
    card.dataset.rect = JSON.stringify(rect);
    occupied.push(rect);
  }

  /** Save a note the user changed: a ticked box, or text typed in the editor. */
  async function saveNote(entry, markdown) {
    entry.data = { ...entry.data, markdown };
    paintCard(entry, entry.data);
    try {
      await fetch(`/edit?${auth}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId: entry.id, markdown }),
      });
    } catch {
      // A failed save leaves the text on screen; the next reload shows the server's copy.
    }
  }

  /** Flip the Nth task marker, so the tick lands on the line the user clicked. */
  function flipTask(markdown, index) {
    let seen = -1;
    return markdown.replace(/^(\s*[-*+]\s+)\[([ xX])\]/gm, (whole, lead, state) => {
      seen += 1;
      if (seen !== index) return whole;
      return `${lead}[${state.trim() ? " " : "x"}]`;
    });
  }

  /** The note body becomes a textarea holding its own markdown: no rich text, no surprises. */
  function startEditing(entry) {
    if (entry.data.type !== "note") return;
    entry.editing = true;
    const area = el("textarea", "note-edit");
    area.value = entry.data.markdown || "";
    area.spellcheck = false;
    entry.body.replaceChildren(area);
    area.focus();
    const finish = (commit) => {
      if (!entry.editing) return;
      entry.editing = false;
      const value = area.value;
      if (commit && value !== entry.data.markdown) void saveNote(entry, value);
      else paintCard(entry, entry.data);
    };
    area.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        finish(true);
      }
    });
    area.addEventListener("blur", () => finish(true));
  }

  /** Ring a card once, through the same class a reference jump uses. */
  function flashCard(card) {
    card.classList.add("flash");
    setTimeout(() => card.classList.remove("flash"), 1400);
  }

  /** Centre the view on a card and ring it, so a reference lands where it points. */
  function centerOn(record) {
    const card = record.card;
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    const x = parseFloat(card.style.left) + card.offsetWidth / 2;
    const y = parseFloat(card.style.top) + card.offsetHeight / 2;
    const fits = Math.min(width / (card.offsetWidth + 80), height / (card.offsetHeight + 80));
    view.k = Math.min(view.k, Math.max(0.3, fits));
    view.x = width / 2 - x * view.k;
    view.y = height / 2 - y * view.k;
    applyView();
    flashCard(card);
    cards.forEach((c) => c.classList.toggle("active", c === card));
    paintFocus();
  }

  /** Centre a question and put the keyboard on its options, so the number keys are one press away. */
  function centreQuestion(record) {
    // The rule jumpToFresh uses: never arrive so far out that the ring and the text stop reading.
    view.k = Math.min(1.1, Math.max(view.k, 0.6));
    centerOn(record);
    // preventScroll: centring already moved the canvas, and a second jump would fight it.
    record.body.querySelector(".q-options")?.focus({ preventScroll: true });
  }

  /** True while the keystroke belongs to a field the user is typing in. */
  function typingSomewhere() {
    const active = document.activeElement;
    return Boolean(active && active.closest("input, textarea"));
  }

  /**
   * The question a number key answers: the active one, and only while it is on screen and open. A
   * folded or scrolled-away question is one the user cannot see, so a digit must not answer it.
   */
  function openQuestion() {
    const marked = document.querySelector(".card.active");
    const record = marked ? byId.get(marked.dataset.id) : null;
    if (!record || !questionWants(record.data)) return null;
    if (record.card.classList.contains("mini") || !isVisible(record.card)) return null;
    return record;
  }

  /** Follow a [[key]] reference: by key first, then by card title. */
  function jumpToKey(key) {
    const wanted = key.toLowerCase();
    for (const record of byId.values()) {
      if (record.data.key && record.data.key.toLowerCase() === wanted) return centerOn(record);
    }
    for (const record of byId.values()) {
      const title = record.titleEl.textContent.trim().toLowerCase();
      if (title && title === wanted) return centerOn(record);
    }
  }

  viewport.addEventListener("click", (event) => {
    const tick = event.target.closest(".tick");
    if (tick) {
      const card = tick.closest(".card");
      const record = card ? byId.get(card.dataset.id) : null;
      const item = tick.closest("li");
      if (record && record.data.type === "note" && item && item.dataset.tick != null) {
        void saveNote(record, flipTask(record.data.markdown || "", Number(item.dataset.tick)));
      }
      return;
    }
    const link = event.target.closest(".xref");
    if (!link) return;
    event.preventDefault();
    jumpToKey(link.dataset.key);
  });

  /** A wheel reports pixels, lines or pages, so one factor turns any of them into pixels. */
  const wheelPixels = (event, delta) =>
    delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);

  viewport.addEventListener("wheel", (event) => {
    if (!event.ctrlKey && !event.metaKey) {
      // One target per wheel, chosen by what is selected rather than by what the pointer is over: a
      // board you are reading a card on keeps still while you scroll that card, and a board with
      // nothing selected pans wherever the pointer happens to be.
      const selected = document.querySelector(".card.active");
      const scroller = selected?.querySelector(".card-scroll");
      const room = scroller ? scroller.scrollHeight - scroller.clientHeight : 0;
      if (room > 1) {
        event.preventDefault();
        scroller.scrollTop += wheelPixels(event, event.deltaY) || wheelPixels(event, event.deltaX);
        return;
      }
      event.preventDefault();
      view.x -= wheelPixels(event, event.deltaX);
      view.y -= wheelPixels(event, event.deltaY);
      applyView();
      return;
    }
    event.preventDefault();
    const k = Math.min(3, Math.max(0.25, view.k * Math.exp(-wheelPixels(event, event.deltaY) * 0.0015)));
    const rect = viewport.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    view.x = px - (px - view.x) * (k / view.k);
    view.y = py - (py - view.y) * (k / view.k);
    view.k = k;
    applyView();
  }, { passive: false });

  /** True once the middle drag that just ended actually moved, read by the `auxclick` below. */
  let middleDragMoved = () => false;

  /**
   * Panning is one gesture wherever it starts: the canvas moves under the pointer and the release
   * ends it, wherever the pointer happens to be by then. Both the background drag and the middle
   * button come through here, so they cannot drift apart.
   */
  function beginPan(event) {
    viewport.classList.add("dragging");
    let lastX = event.clientX;
    let lastY = event.clientY;
    let moved = false;
    // Movement is applied as it happens rather than from the press, so a zoom or a fit in the
    // middle of a drag is not undone by the next inch of the pointer.
    const move = (ev) => {
      // A release the page never heard about would otherwise leave the board sliding on hover.
      if (!ev.buttons) return up();
      if (Math.abs(ev.clientX - lastX) + Math.abs(ev.clientY - lastY) > 2) moved = true;
      view.x += ev.clientX - lastX;
      view.y += ev.clientY - lastY;
      lastX = ev.clientX;
      lastY = ev.clientY;
      applyView();
    };
    const up = () => {
      viewport.classList.remove("dragging");
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
    };
    // A middle click that never travelled is a click, and a middle click on a link opens it. Only
    // the drag is swallowed.
    if (event.button === 1) middleDragMoved = () => moved;
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  }

  // The left button pans the background. Over a card it belongs to the card, which drags, resizes
  // and selects with it, so this gesture never starts there.
  viewport.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest(".card")) return;
    cards.forEach((c) => c.classList.remove("active"));
    paintFocus();
    beginPan(event);
  });

  // The middle button is the workspace grab, so it works over anything the canvas holds: a card, the
  // rail, the composer. The one exception is the detail panel, which is a dialog rather than part
  // of the surface and reads better when a stray middle drag does not slide the board behind it.
  document.addEventListener("pointerdown", (event) => {
    if (event.button !== 1 || !(event.target instanceof Element)) return;
    if (event.target.closest("#actDetail")) return;
    // Chromium opens its autoscroll compass on a middle press and would keep the pointer for it.
    event.preventDefault();
    beginPan(event);
  });
  document.addEventListener("auxclick", (event) => {
    if (event.button !== 1 || !middleDragMoved()) return;
    event.preventDefault();
    middleDragMoved = () => false;
  });

  function fitAll() {
    if (!cards.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const card of cards) {
      const x = parseFloat(card.style.left);
      const y = parseFloat(card.style.top);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + card.offsetWidth);
      maxY = Math.max(maxY, y + card.offsetHeight);
    }
    const pad = 40;
    const k = Math.min(
      (viewport.clientWidth - pad * 2) / (maxX - minX),
      (viewport.clientHeight - pad * 2) / (maxY - minY),
      1.15,
    );
    view.k = Math.max(0.3, k);
    view.x = (viewport.clientWidth - (maxX - minX) * view.k) / 2 - minX * view.k;
    view.y = (viewport.clientHeight - (maxY - minY) * view.k) / 2 - minY * view.k;
    applyView();
  }

  /**
   * `100%` is real size without losing your place, so the zoom pivots on a card that is really on
   * the board: the active one, or else the one nearest the middle of the screen. Its position on
   * screen stays put, which is what keeps 100% from landing on empty canvas. An empty board only
   * changes the zoom, because there is nothing to hold still.
   */
  function resetZoom() {
    if (!cards.length) {
      view.k = 1;
      applyView();
      return;
    }
    // A board that is entirely off screen is framed first: 100% of empty canvas is still empty.
    if (!cards.some(isVisible)) fitAll();
    const mid = viewportCenter();
    const away = (card) => {
      const x = parseFloat(card.style.left) + card.offsetWidth / 2 - mid.x;
      const y = parseFloat(card.style.top) + card.offsetHeight / 2 - mid.y;
      return x * x + y * y;
    };
    const pivot =
      document.querySelector(".card.active") || cards.reduce((best, card) => (away(best) <= away(card) ? best : card));
    const px = parseFloat(pivot.style.left) + pivot.offsetWidth / 2;
    const py = parseFloat(pivot.style.top) + pivot.offsetHeight / 2;
    // Where the pivot sits on screen right now, which is where 100% has to leave it.
    const sx = px * view.k + view.x;
    const sy = py * view.k + view.y;
    view.k = 1;
    view.x = sx - px;
    view.y = sy - py;
    applyView();
  }

  document.getElementById("fit").addEventListener("click", fitAll);
  document.getElementById("tidy").addEventListener("click", tidy);
  document.getElementById("stack").addEventListener("click", stack);
  // The thread order is the human's furniture too: the button says what the board does now, and
  // its title says what a click will do.
  const orderBtn = document.getElementById("threadOrder");
  function paintOrderBtn() {
    orderBtn.textContent = newestFirst ? "newest" : "oldest";
    orderBtn.setAttribute("aria-pressed", newestFirst ? "true" : "false");
    orderBtn.title = newestFirst
      ? "newest card in a thread sits on top — click to put the oldest on top"
      : "oldest card in a thread sits on top — click to put the newest on top";
  }
  function flipOrder() {
    newestFirst = !newestFirst;
    try {
      localStorage.setItem(ORDER_KEY, newestFirst ? "newest" : "oldest");
    } catch {}
    paintOrderBtn();
    applyAllThreadOrder();
  }
  paintOrderBtn();
  orderBtn.addEventListener("click", flipOrder);
  // Another tab flipping the order repaints this one, so the two agree without a reload.
  window.addEventListener("storage", (event) => {
    if (event.key !== ORDER_KEY) return;
    newestFirst = event.newValue !== "oldest";
    paintOrderBtn();
    applyAllThreadOrder();
  });
  document.getElementById("newPill").addEventListener("click", jumpToFresh);
  resetBtn.addEventListener("click", resetZoom);

  // ---------- activity rail ------------------------------------------------
  const stopBtn = document.getElementById("stop");
  const railNow = document.getElementById("railNow");
  const railLog = document.getElementById("railLog");
  const railRunning = document.getElementById("railRunning");
  const railOpenCount = document.getElementById("railOpenCount");
  const actEls = new Map();
  /** A thought with no patch for this long is stalled, and its row says so with the clock. */
  const THOUGHT_STALL_MS = 3000;

  // The rail is the user's furniture: its width and whether it is showing survive a reload.
  const RAIL_MIN = 160;
  const RAIL_MAX = 720;
  const root = document.documentElement;

  function railWidth(px) {
    const width = Math.max(RAIL_MIN, Math.min(RAIL_MAX, Math.round(px)));
    root.style.setProperty("--rail", `${width}px`);
    try {
      localStorage.setItem("board.railWidth", String(width));
    } catch {}
    return width;
  }

  function railShown(shown) {
    document.body.classList.toggle("rail-off", !shown);
    try {
      localStorage.setItem("board.railOff", shown ? "0" : "1");
    } catch {}
  }

  function restoreRail() {
    let saved = 0;
    let off = "0";
    try {
      saved = Number(localStorage.getItem("board.railWidth")) || 0;
      off = localStorage.getItem("board.railOff") || "0";
    } catch {}
    if (saved) railWidth(saved);
    if (off === "1") railShown(false);
  }
  restoreRail();
  document.getElementById("railToggle").onclick = () => railShown(false);
  document.getElementById("railOpen").onclick = () => railShown(true);

  (() => {
    const grip = document.getElementById("railGrip");
    let dragging = false;
    grip.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      dragging = true;
      grip.setPointerCapture(event.pointerId);
      document.body.classList.add("rail-resizing");
      event.preventDefault();
    });
    grip.addEventListener("pointermove", (event) => {
      if (dragging) railWidth(event.clientX);
    });
    const stop = (event) => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("rail-resizing");
      if (grip.hasPointerCapture?.(event.pointerId)) grip.releasePointerCapture(event.pointerId);
    };
    grip.addEventListener("pointerup", stop);
    grip.addEventListener("pointercancel", stop);
  })();

  // The rail is the overview of the board: every card, newest first, with the one state worth
  // knowing. A row is the way back to its card.
  const railCards = document.getElementById("railCards");
  const railCardCount = document.getElementById("railCardCount");
  const railRows = new Map();

  /** An age short enough to share a row with a title. */
  function agoText(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
  }

  /** The one state word a row has room for, in the words the card itself already uses. */
  function railState(entry) {
    const data = entry.data || {};
    // "updated" rides on the arrival badge's own .fresh class, so there is one notion of new.
    const updated = entry.card.classList.contains("fresh");
    const wants = questionWants(data);
    if (data.type === "question" && data.status === "expired") return { text: "expired", wants: false, updated };
    if (wants) return { text: "answer needed", wants, updated };
    if (updated) return { text: "updated", wants, updated };
    if (data.type === "sticky") return { text: data.status || "queued", wants, updated };
    // A changed card is as old as its change, so the row does not keep counting from arrival.
    return { text: agoText(Date.now() - (entry.updatedAt || data.at || Date.now())), wants, updated };
  }

  function paintRailCount() {
    railCardCount.textContent = railRows.size ? String(railRows.size) : "";
    syncTicker();
  }

  /** Just the state word and its tone, so the clock and a repaint share one writer. */
  function paintRailState(entry) {
    const row = railRows.get(entry.id);
    if (!row) return;
    const { text, wants, updated } = railState(entry);
    // The clock calls this every second, so a word that has not changed must not touch the DOM.
    if (row.children[2].textContent !== text) {
      row.children[2].textContent = text;
      row.classList.toggle("wants", wants);
      row.classList.toggle("updated", updated);
      row.title = `${row.children[1].textContent} · ${text}`;
    }
  }

  /**
   * One row per card, built once and patched in place: this runs on every card repaint, so it
   * must not rebuild the list or touch any other card's DOM. Arrival order is the order the
   * cards array keeps, so a new card is only ever prepended.
   */
  function syncRailCard(entry) {
    if (!entry) return;
    let row = railRows.get(entry.id);
    if (!row) {
      row = el("button", "rail-card");
      row.type = "button";
      row.dataset.id = entry.id;
      row.append(el("span", "dot"), el("span", "rail-title"), el("span", "rail-state"));
      row.addEventListener("click", () => {
        const record = byId.get(row.dataset.id);
        if (record) centerOn(record);
      });
      railRows.set(entry.id, row);
      railCards.prepend(row);
    }
    row.children[0].className = `dot ${dotKind(entry.data.type)}`;
    row.children[1].textContent = entry.titleEl.textContent;
    paintRailState(entry);
    paintRailCount();
  }

  function dropRailCard(id) {
    const row = railRows.get(id);
    if (!row) return;
    row.remove();
    railRows.delete(id);
    paintRailCount();
  }

  function clearRailCards() {
    railCards.replaceChildren();
    railRows.clear();
    paintRailCount();
  }

  function actRow(row) {
    const thinking = row.kind === "thinking";
    const node = el("div", `act ${row.kind === "reply" ? "reply" : ""} ${thinking ? "thinking" : ""} ${row.status}`);
    // The row carries its kind and status so a patch can update it in place and the one clock can
    // leave a thinking row's rate alone.
    node.dataset.kind = String(row.kind ?? "");
    node.dataset.status = String(row.status ?? "");
    const top = el("div", "top");
    top.appendChild(el("span", "dot"));
    const name = el("span", "name");
    // The phrase says what the call does; the tool name stays available on hover.
    name.textContent = row.kind === "reply" ? "answer" : thinking ? "thinking" : row.label || row.tool || "tool";
    if (row.tool) name.title = row.tool;
    top.appendChild(name);
    const timing = el("span", "ms");
    top.appendChild(timing);
    // A running row is re-rendered by the ticker in place, so it carries its own start time.
    node.dataset.startedAt = String(row.startedAt ?? "");
    node.appendChild(top);
    // Opening is the only thing a row does besides being read, so it is a button for the keyboard
    // too. A drag that selected text was a read, not a click, and must not open the panel. A row
    // with no payload behind it cannot open anything, so it stays plain text.
    if (!row.plain) {
      node.tabIndex = 0;
      node.setAttribute("role", "button");
      node.setAttribute("aria-label", `open details: ${name.textContent}`);
      node.addEventListener("click", () => {
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed) return;
        openActPanel(row);
      });
      node.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openActPanel(row);
      });
    }
    if (thinking) {
      node.appendChild(el("div", "tail"));
      paintThought(node, row);
      return node;
    }
    timing.textContent = row.durationMs
      ? `${(row.durationMs / 1000).toFixed(row.durationMs < 1000 ? 2 : 1)}s`
      : row.status === "running"
        ? Number.isFinite(row.startedAt)
          ? rowClock(Date.now() - row.startedAt)
          : "…"
        : "";
    const detail = row.kind === "reply" ? row.text || "" : row.summary || row.target || "";
    if (detail) {
      const note = el("div", row.kind === "reply" ? "note" : "target");
      note.textContent = detail;
      note.title = detail;
      node.appendChild(note);
    }
    return node;
  }

  // ---------- row detail panel ---------------------------------------------
  // A rail row is one line. This sheet holds everything the row leaves out, fetched when the row
  // is opened and refreshed while it still runs, so the rail itself stays cheap on the wire.
  const actPanel = document.getElementById("actDetail");
  const actPanelName = document.getElementById("actDetailName");
  const actPanelMeta = document.getElementById("actDetailMeta");
  const actPanelBody = document.getElementById("actDetailBody");
  const actPanelClose = document.getElementById("actDetailClose");
  /** The row the panel belongs to, or null while it is closed. */
  let actPanelId = null;
  /** When the last fetch was sent, so a streaming row cannot ask faster than four times a second. */
  let actPanelAskedAt = 0;
  let actPanelTimer = 0;

  /** One titled block of monospace text, saying when the server cut it. */
  function panelSection(title, text, cut) {
    const box = el("section");
    box.appendChild(el("h4")).textContent = title;
    const pre = el("pre");
    pre.textContent = text;
    box.appendChild(pre);
    if (cut) box.appendChild(el("div", "cut")).textContent = "cut at 64 K characters by the board server";
    return box;
  }

  function paintActPanel(payload) {
    actPanelName.textContent =
      payload.kind === "reply" ? "answer" : payload.kind === "thinking" ? "thinking" : payload.tool || "tool";
    const took =
      typeof payload.durationMs === "number"
        ? payload.durationMs
        : payload.status === "running"
          ? Date.now() - payload.startedAt
          : 0;
    actPanelMeta.textContent = [payload.status, took ? rowClock(took) : ""].filter(Boolean).join(" · ");
    const cut = new Set(payload.cut || []);
    const parts = [];
    if (payload.args !== undefined) {
      // The server hands arguments over as an object, or as their JSON when it had to cut them.
      const text = typeof payload.args === "string" ? payload.args : JSON.stringify(payload.args, null, 2);
      parts.push(panelSection("input", text || "", cut.has("args")));
    }
    for (const [field, title] of [
      ["log", "log"],
      ["output", "output"],
      ["thinking", "thinking"],
      ["text", "answer"],
    ]) {
      const text = payload[field];
      if (typeof text !== "string" || !text) continue;
      parts.push(panelSection(title, text, cut.has(field)));
    }
    if (!parts.length) {
      const gone = el("div", "gone");
      gone.textContent = "nothing kept for this row";
      parts.push(gone);
    }
    actPanelBody.replaceChildren(...parts);
  }

  async function fetchActDetail(id) {
    actPanelAskedAt = Date.now();
    let running = false;
    try {
      const response = await fetch(`/activity/${encodeURIComponent(id)}?${auth}`);
      // A slow answer for a panel the user already closed must not paint over the next one.
      if (actPanelId !== id) return;
      if (!response.ok) {
        // A missing payload is final: the row settled, was trimmed, or never had one, and nothing
        // will bring it back, so the panel stops asking.
        const why = el("div", "gone");
        why.textContent = (await response.text()).trim() || "no detail kept for this row";
        actPanelBody.replaceChildren(why);
        return;
      }
      const payload = await response.json();
      paintActPanel(payload);
      running = payload.status === "running";
    } catch {
      const why = el("div", "gone");
      why.textContent = "could not reach the board server";
      actPanelBody.replaceChildren(why);
      return;
    }
    // The loop drives itself: a tool that only streams an update never broadcasts a row, so a
    // timer armed from the board's stream would leave its panel frozen until the tool finished.
    if (running && actPanelId === id) {
      actPanelTimer = setTimeout(() => {
        if (actPanelId === id) void fetchActDetail(id);
      }, Math.max(0, 250 - (Date.now() - actPanelAskedAt)));
    }
  }

  function openActPanel(row) {
    if (!row) return;
    clearTimeout(actPanelTimer);
    actPanelId = row.id;
    actPanel.hidden = false;
    actPanelName.textContent = row.kind === "reply" ? "answer" : row.kind === "thinking" ? "thinking" : row.tool || "tool";
    actPanelMeta.textContent = String(row.status || "");
    actPanelBody.replaceChildren();
    // The panel itself takes the focus, so a second Enter goes nowhere instead of closing what just
    // opened. Tab walks in from here.
    actPanel.focus();
    void fetchActDetail(row.id);
  }

  function closeActPanel() {
    if (actPanel.hidden) return;
    const id = actPanelId;
    actPanelId = null;
    clearTimeout(actPanelTimer);
    actPanel.hidden = true;
    actPanelBody.replaceChildren();
    // The row may have been rebuilt while the panel was up, so the focus goes to the one there now.
    actEls.get(id)?.focus();
  }

  actPanelClose.addEventListener("click", closeActPanel);
  actPanel.addEventListener("click", (event) => {
    if (event.target === actPanel) closeActPanel();
  });
  actPanel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeActPanel();
      return;
    }
    // The panel holds the keyboard while it is open, so tab cannot walk the board behind it. Two
    // stops are inside: the close button and the body, and tab cycles between them both ways.
    if (event.key === "Tab") {
      event.preventDefault();
      const stops = [actPanelClose, actPanelBody];
      const at = stops.indexOf(document.activeElement);
      const step = event.shiftKey ? stops.length - 1 : 1;
      stops[at < 0 ? (event.shiftKey ? stops.length - 1 : 0) : (at + step) % stops.length].focus();
    }
  });

  /**
   * A thought's count leads, then its rate while it runs or the time it took once it ends. A tilde
   * means the number is our estimate rather than one the provider reported.
   */
  function thoughtTiming(row) {
    const mark = row.tokensEstimated ? "~" : "";
    const tokens = typeof row.tokens === "number" ? `${mark}${row.tokens} tok` : "";
    const pace = row.status === "running" && row.rate ? `~${row.rate} tok/s` : "";
    const took = row.durationMs ? `${(row.durationMs / 1000).toFixed(row.durationMs < 1000 ? 2 : 1)}s` : "";
    return [tokens, pace || took].filter(Boolean).join(" · ");
  }

  /**
   * The live parts of a thinking row: its timing, the tail and the stamp the ticker reads. Patching
   * them in place keeps the dot's pulse running and leaves the user's text selection alone.
   */
  function paintThought(node, row) {
    const timing = node.querySelector(".ms");
    timing.textContent = thoughtTiming(row);
    timing.title = row.tokensEstimated
      ? "thinking tokens estimated from the characters streamed, about four per token"
      : "thinking tokens reported by the provider";
    node.querySelector(".tail").textContent = thoughtTail(row.text);
    node.dataset.patchedAt = String(Date.now());
  }

  /**
   * A thought streams in paragraphs, so the rail keeps its newest lines and lets the CSS clamp hold
   * the height. Every newline costs a clamp line, so the newest five lines are kept whole and only a
   * very long line falls back to a character cut, which moves past a low surrogate so that no emoji
   * ends up as a box.
   */
  function thoughtTail(text, keep = 180) {
    const flat = String(text || "").replace(/\s+$/, "");
    let tail = flat.split("\n").slice(-5).join("\n");
    if (tail.length > keep) {
      const start = tail.length - keep;
      tail = tail.slice(/[\uDC00-\uDFFF]/.test(tail[start]) ? start + 1 : start);
    }
    return tail.length < flat.length ? `…${tail}` : tail;
  }

  // Settled rows are filed under the thread that wrote them, one foldable section per thread, newest
  // thread on top. A running row stays in the strip above: that strip is what you look at while a run
  // is in flight, and the sections are what you read afterwards.
  const railSections = new Map();
  /** A section the reader folded shut. Session only: a reload shows everything again. */
  const foldedSections = new Set();
  let heldRows = 0;

  function applyFold(entry) {
    entry.section.classList.toggle("folded", foldedSections.has(entry.id));
    entry.head.setAttribute("aria-expanded", foldedSections.has(entry.id) ? "false" : "true");
  }

  function railSection(row) {
    const id = row.thread?.id || "";
    let entry = railSections.get(id);
    if (!entry) {
      const section = el("section", "rail-thread");
      const head = el("button", "rail-thread-head");
      head.type = "button";
      head.append(
        el("span", "chev"),
        el("span", "rail-thread-title"),
        el("span", "rail-thread-count"),
        el("span", "rail-thread-stats"),
        el("button", "rail-thread-stop"),
      );
      const stop = head.children[4];
      stop.type = "button";
      stop.textContent = "■";
      stop.title = "stop this thread's run";
      stop.addEventListener("click", (event) => {
        // The section's own press must not fold it, which is what the head's click does.
        event.stopPropagation();
        stopThread(id);
      });
      const body = el("div", "rail-thread-body");
      section.append(head, body);
      head.addEventListener("click", () => {
        if (foldedSections.has(id)) foldedSections.delete(id);
        else foldedSections.add(id);
        applyFold(entry);
      });
      entry = { section, head, body, id, title: "" };
      railSections.set(id, entry);
      applyFold(entry);
    }
    const title = row.thread?.title || "earlier";
    if (title !== entry.title) {
      entry.title = title;
      entry.head.children[1].textContent = title;
      entry.head.title = title;
    }
    return entry;
  }

  /** The log is a tail, not a history: the oldest row of the oldest section goes first, then the shell. */
  function trimRail() {
    while (heldRows > 200) {
      const section = railLog.lastElementChild;
      const row = section?.querySelector(".rail-thread-body")?.lastElementChild;
      if (!section || !row) {
        section?.remove();
        if (section) for (const [id, entry] of railSections) if (entry.section === section) railSections.delete(id);
        return;
      }
      for (const [id, elem] of actEls) if (elem === row) actEls.delete(id);
      row.remove();
      heldRows--;
    }
  }

  function clearRailLog() {
    railLog.replaceChildren();
    railSections.clear();
    foldedSections.clear();
    actEls.clear();
    heldRows = 0;
  }

  function applyActivity(row) {
    // A row that just settled gets one fetch, the one that carries its full output. A running row
    // is polled by fetchActDetail itself.
    if (actPanelId === row.id && row.status !== "running") {
      clearTimeout(actPanelTimer);
      void fetchActDetail(row.id);
    }
    const previous = actEls.get(row.id);
    // A thought patches four times a second while its status stays put. Rebuilding the node would
    // restart the dot's pulse and drop a text selection, so it is updated where it stands.
    if (previous && row.kind === "thinking" && previous.dataset.status === row.status) {
      paintThought(previous, row);
      return;
    }
    const node = actRow(row);
    if (previous) previous.remove();
    actEls.set(row.id, node);
    if (row.status === "running") {
      railNow.prepend(node);
    } else {
      const section = railSection(row);
      section.body.prepend(node);
      section.head.children[2].textContent = String(section.body.childElementCount);
      // The thread that just spoke goes on top, so a board with many threads reads like a stack of
      // conversations rather than one long line of tool calls.
      railLog.prepend(section.section);
      heldRows++;
      trimRail();
    }
    const running = railNow.childElementCount ? String(railNow.childElementCount) : "";
    railRunning.textContent = running;
    railOpenCount.textContent = running;
    syncTicker();
  }

  // ---------- composer -----------------------------------------------------
  const msgBox = document.getElementById("msg");
  const sendBtn = document.getElementById("send");
  const forkBtn = document.getElementById("forkMode");
  const composerHint = document.getElementById("composerHint");
  const statCtx = document.getElementById("statCtx");
  const statCtxValue = document.getElementById("statCtxValue");
  const replyChip = document.getElementById("replyChip");
  const replyChipText = document.getElementById("replyChipText");
  let sendMode = "queue";
  /**
   * A comment on a card without a child goes to the thread that made it. Fork asks a new thread
   * instead, which is what a clone of the card is for: same question, its own conversation.
   */
  let forkNext = false;
  /** A note that outranks the usual hint until it has been read. */
  let hintTimer = null;

  /**
   * The mode buttons choose between steering the run and queueing behind it, so they say nothing
   * while the agent is idle. Hidden then, and the hint says the message leaves now instead of
   * claiming it waits for a run that is not happening. A stream that is down leaves the composer
   * readable on purpose, so it is the hint that has to stop promising a send.
   */
  function paintComposer() {
    const running = metaRunning === true;
    for (const button of document.querySelectorAll("#composer .modes button[data-mode]")) {
      button.hidden = !running;
    }
    composerHint.classList.remove("bad");
    composerHint.textContent = !linkUp
      ? "offline"
      : !running
        ? "sends now"
        : sendMode === "steer"
          ? "interrupts the run"
          : forkNext && replyTarget
            ? "asks a new thread"
            : "waits for this run to finish";
  }

  /** Something the board did rather than the composer: say it, then go back to the usual hint. */
  function hintLine(text, bad = false) {
    composerHint.textContent = text;
    composerHint.classList.toggle("bad", bad);
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => paintComposer(), 6000);
  }

  // Compaction is the agent's own housekeeping, so the board asks the session for it and reports
  // what came back. The server refuses while a run is in flight: compaction aborts that run first.
  statCtx.addEventListener("click", async () => {
    statCtx.disabled = true;
    hintLine("compacting…");
    try {
      const response = await fetch(`/compact?${auth}`, { method: "POST" });
      if (!response.ok) hintLine((await response.text()).trim() || "could not compact", true);
    } catch {
      hintLine("could not reach the board server", true);
    } finally {
      statCtx.disabled = false;
    }
  });

  /**
   * A reply is aimed at one card, so the composer shows which until it is sent or cleared.
   * Without this the follow-up would arrive as a new sticky and the thread would be lost.
   */
  function setReplyTarget(entry) {
    replyTarget = entry && byId.has(entry.id) ? entry : null;
    for (const record of byId.values()) record.card.classList.toggle("replying", record === replyTarget);
    dockComposer(replyTarget);
    replyChip.hidden = !replyTarget;
    // Forking only differs when there is a thread that would otherwise answer, so the button says
    // nothing on a thread card or on a card nobody has asked about yet.
    paintFork();
    // The model and thinking chips name the thread that answers this card.
    paintRuntime();
    if (replyTarget) {
      // A sticky is titled "you", so it is named by its own words instead.
      const name =
        replyTarget.data.type === "sticky"
          ? (replyTarget.data.text || "message").replace(/\s+/g, " ").trim().slice(0, 40)
          : replyTarget.titleEl.textContent;
      // A card is answered by a thread that has no card of its own, so there is no name to show: the
      // chip names the card, and says when a fork is the thing that will answer.
      const owned = replyTarget.data.type !== "thread" && Boolean(replyTarget.data.answersWith);
      replyChipText.textContent = forkNext && owned ? `in “${name}” · a new thread answers` : `in “${name}”`;
      msgBox.placeholder = "ask a follow-up about this card…  (esc to send to the board instead)";
      msgBox.focus();
    } else {
      msgBox.placeholder = "message the agent…  (enter sends, shift+enter for a new line, paste an image or pick files)";
    }
    paintComposer();
  }

  document.getElementById("replyChipClear").addEventListener("click", () => setReplyTarget(null));

  function paintFork() {
    // Forking only differs when something already answers the card, and that something is the thread
    // behind it: `answersWith` is how the card reports having one.
    const owned = Boolean(replyTarget && replyTarget.data.type !== "thread" && replyTarget.data.answersWith);
    forkBtn.hidden = !owned;
    forkBtn.disabled = !owned;
    forkBtn.classList.toggle("on", owned && forkNext);
    forkBtn.title = forkNext
      ? "a new thread will answer in its own conversation"
      : "ask a new thread instead of the one that made this card";
  }

  forkBtn.addEventListener("click", () => {
    forkNext = !forkNext;
    paintFork();
    if (replyTarget) setReplyTarget(replyTarget);
    paintComposer();
  });

  // ---------- what answers ---------------------------------------------------
  // A card answers with the model and thinking level of the thread behind it, so the two chips
  // follow the card being replied to and edit that thread. With no card chosen they edit what the
  // next thread starts with.
  const modelChip = document.getElementById("modelPick");
  const thinkChip = document.getElementById("thinkPick");
  const runtimePick = document.getElementById("runtimePick");
  const runtimeSearch = document.getElementById("runtimeSearch");
  const runtimeList = document.getElementById("runtimeList");
  /** {models, levels} from the daemon, read on the first open of either chip. */
  let catalog = null;
  /** Which chip opened the panel: "model", "thinking", or "" when it is closed. */
  let picking = "";
  /** The board's own settings: what a new thread starts with, and which features are on. */
  let boardConfig = {};
  /** Where the panel hangs off, when something other than the composer's chips opened it. */
  let pickAnchor = null;
  /** True when the picker is editing the board's defaults rather than one card's thread. */
  let pickBoard = false;

  function pickNote(text) {
    const node = el("div", "pick-note");
    node.textContent = text;
    return node;
  }

  /**
   * What the message will be answered with. A thread card carries its own runtime; a card that has a
   * thread behind it carries that thread's, because the thread itself is never drawn.
   */
  function answeringRuntime() {
    if (!replyTarget) return null;
    // A thread card is its own runtime; a plain card carries the runtime of the child that answers it.
    if (replyTarget.data.type === "sticky") return replyTarget.data;
    return replyTarget.data.answersWith ?? null;
  }

  /** What the picker is editing: one card's thread, or the board's defaults. */
  function pickRuntime() {
    return pickBoard ? boardConfig : (answeringRuntime() ?? boardConfig);
  }

  function shortModel(model) {
    return String(model ?? "").split("/").pop() || "model";
  }

  function paintRuntime() {
    const answering = answeringRuntime();
    // With nothing to reply to, the chips speak for the board's default, which is whatever the
    // newest thread was started with until a new choice is made.
    if (!answering && !boardConfig.model) {
      const newest = [...byId.values()]
        .filter((entry) => entry.data.type === "sticky")
        .sort((left, right) => (right.data.at ?? 0) - (left.data.at ?? 0))[0];
      if (newest) {
        boardConfig = { ...boardConfig, provider: newest.data.provider, model: newest.data.model, thinking: newest.data.thinking };
      }
    }
    const runtime = answering ?? boardConfig;
    paintConfig();
    // One pass over the cards says what every thread is doing and what it has spent, because a card is
    // where a thread is read — its own card, or the card a hidden child answers for.
    threadFacts.clear();
    for (const entry of byId.values()) {
      const data = entry.data || {};
      const id = data.type === "sticky" ? entry.id : data.answersWith?.thread;
      if (!id) continue;
      threadFacts.set(id, {
        cardId: entry.id,
        stats: data.type === "sticky" ? data.stats : data.answersWith?.stats,
        running: data.type === "sticky" ? data.status === "sent" : data.answersWith?.running === true,
      });
    }
    paintSections();
    modelChip.textContent = shortModel(runtime.model);
    thinkChip.textContent = runtime.thinking ? `think ${runtime.thinking}` : "think off";
    const where = answering ? "this card answers with" : "a new thread starts with";
    modelChip.title = `${where} ${runtime.provider ?? ""}/${runtime.model ?? ""}`;
    thinkChip.title = `${answering ? "this card" : "a new thread"} thinks at ${runtime.thinking || "off"}`;
  }

  function closePick() {
    picking = "";
    pickAnchor = null;
    pickBoard = false;
    runtimePick.hidden = true;
    runtimeSearch.value = "";
  }

  function placeRuntimePick() {
    const chip = (pickAnchor ?? (picking === "thinking" ? thinkChip : modelChip)).getBoundingClientRect();
    const width = runtimePick.offsetWidth;
    const height = runtimePick.offsetHeight;
    runtimePick.style.left = `${Math.max(10, Math.min(window.innerWidth - width - 10, chip.left))}px`;
    // Above the thing it hangs off, unless that would push it off the top: then below, so a panel in
    // the corner does not have its own picker covering the row that opened it.
    const above = chip.top - height - 8;
    const top = above >= 10 ? above : Math.min(window.innerHeight - height - 10, chip.bottom + 8);
    runtimePick.style.top = `${Math.max(10, top)}px`;
  }

  function pickRow(text, meta, on, onPick) {
    const row = el("button", on ? "pick-row on" : "pick-row");
    row.type = "button";
    const name = el("span");
    name.textContent = text;
    row.appendChild(name);
    if (meta) {
      const aside = el("span", "pick-meta");
      aside.textContent = meta;
      row.appendChild(aside);
    }
    row.addEventListener("click", onPick);
    return row;
  }

  function drawModels(query) {
    const needle = query.trim().toLowerCase();
    const here = pickRuntime();
    const models = (catalog?.models ?? []).filter(
      (one) => !needle || one.model.toLowerCase().includes(needle) || one.provider.toLowerCase().includes(needle),
    );
    const rows = [];
    let group = "";
    // The list is long, so it is grouped by provider and cut short: a search narrows it, and past
    // a couple of hundred rows scrolling is slower than typing.
    for (const one of models.slice(0, 200)) {
      if (one.provider !== group) {
        group = one.provider;
        const head = el("div", "pick-group");
        head.textContent = group;
        rows.push(head);
      }
      const on = one.provider === here.provider && one.model === here.model;
      const meta = [one.context, one.thinking ? "thinks" : "", one.images ? "images" : ""].filter(Boolean).join(" · ");
      rows.push(pickRow(one.model, meta, on, () => void chooseRuntime("model", one)));
    }
    runtimeList.replaceChildren(...(rows.length ? rows : [pickNote("no model matches")]));
  }

  function drawLevels() {
    const here = pickRuntime();
    const chosen = (catalog?.models ?? []).find((one) => one.provider === here.provider && one.model === here.model);
    // Pi clamps whatever it is given, so a model without reasoning only offers being off.
    const levels = chosen && chosen.thinking === false ? ["off"] : (catalog?.levels ?? []);
    // No level is stored until one is chosen, and that means pi's own default, which reads as off.
    const current = here.thinking || "off";
    const rows = levels.map((level) => pickRow(level, "", level === current, () => void chooseRuntime("thinking", level)));
    if (chosen && chosen.thinking === false) rows.push(pickNote(`${shortModel(here.model)} does not think`));
    runtimeList.replaceChildren(...(rows.length ? rows : [pickNote("no level to choose")]));
  }

  /** Stop one thread from its section, and kill it if the stop does not land. */
  function stopThread(threadId) {
    const held = threadFacts.get(threadId);
    if (!held) return;
    const kill = stopping.has(threadId);
    if (kill) stopping.delete(threadId);
    else stopping.add(threadId);
    void fetch(`/${kill ? "kill" : "stop"}?${auth}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardId: held.cardId }),
    });
  }

  async function openPick(which, anchor = null, forBoard = false) {
    if (picking === which && pickBoard === forBoard) {
      closePick();
      return;
    }
    picking = which;
    pickAnchor = anchor;
    pickBoard = forBoard;
    runtimePick.hidden = false;
    runtimeSearch.hidden = which !== "model";
    runtimeList.replaceChildren(pickNote("reading what this machine has…"));
    if (!catalog) {
      try {
        const response = await fetch(`/models?${auth}`);
        if (!response.ok) throw new Error("the daemon would not list models");
        catalog = await response.json();
      } catch (error) {
        runtimeList.replaceChildren(pickNote(error.message || "could not read the models"));
        return;
      }
    }
    if (picking !== which) return; // closed while the catalog was loading
    if (which === "model") {
      runtimeSearch.value = "";
      drawModels("");
      runtimeSearch.focus();
    } else {
      drawLevels();
    }
    placeRuntimePick();
  }

  /** Hand the choice to the daemon: this card's thread, or the default for a new one. */
  async function chooseRuntime(kind, value) {
    const body = kind === "model" ? { provider: value.provider, model: value.model } : { level: value };
    // A plain card's id is enough: the daemon finds the thread behind it, which the board never draws.
    // Editing the board's defaults sends no card, which is what makes it the default.
    if (replyTarget && !pickBoard) body.cardId = replyTarget.id;
    try {
      const response = await fetch(`/${kind === "model" ? "model" : "thinking"}?${auth}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error((await response.text()).slice(0, 80) || response.statusText);
      const payload = await response.json();
      if (payload.config) boardConfig = { ...boardConfig, ...payload.config };
      hintLine(kind === "model" ? `model: ${shortModel(value.model)}` : `thinking: ${value}`);
      closePick();
      paintRuntime();
    } catch (error) {
      hintLine(`could not set it: ${error.message || error}`, true);
    }
  }

  modelChip.addEventListener("click", () => void openPick("model"));
  thinkChip.addEventListener("click", () => void openPick("thinking"));

  // ---------- this board's settings ------------------------------------------
  const configBtn = document.getElementById("configBtn");
  const configPanel = document.getElementById("boardConfig");
  const cfgDim = document.getElementById("cfgDim");
  const cfgDimValue = document.getElementById("cfgDimValue");
  const cfgModel = document.getElementById("cfgModel");
  const cfgModelValue = document.getElementById("cfgModelValue");
  const cfgThinking = document.getElementById("cfgThinking");
  const cfgThinkingValue = document.getElementById("cfgThinkingValue");

  /** The daemon's copy of the configuration is the truth; whatever arrives is what the panel shows. */
  function applyConfig(config) {
    if (!config || !config.model) return;
    boardConfig = { ...boardConfig, ...config };
    paintRuntime();
    paintFocus();
  }

  function paintConfig() {
    cfgDimValue.textContent = boardConfig.dimOthers === false ? "off" : "on";
    cfgModelValue.textContent = shortModel(boardConfig.model);
    cfgThinkingValue.textContent = boardConfig.thinking || "off";
  }

  function shownConfig(on) {
    configPanel.hidden = !on;
    configBtn.setAttribute("aria-expanded", on ? "true" : "false");
  }

  // ---------- clean and new ------------------------------------------------
  // Cleaning is safe, so it happens on the click. Starting over throws away every card, so the same
  // button turns into a question and the second click is the answer.
  const cleanBtn = document.getElementById("cleanBtn");
  const newBtn = document.getElementById("newBtn");
  let newArmed = 0;

  async function postBoardAction(path) {
    try {
      const response = await fetch(`/${path}?${auth}`, { method: "POST" });
      if (!response.ok) throw new Error((await response.text()).slice(0, 80) || response.statusText);
      return await response.json();
    } catch (error) {
      hintLine(`could not ${path === "new" ? "start over" : "clean"}: ${error.message || error}`, true);
      return null;
    }
  }

  cleanBtn.addEventListener("click", async () => {
    const result = await postBoardAction("clean");
    if (!result) return;
    hintLine(result.removed.length ? `cleaned ${result.removed.length} dead thread${result.removed.length > 1 ? "s" : ""} and ${result.rows} rows` : "nothing to clean");
  });

  newBtn.addEventListener("click", async () => {
    const now = Date.now();
    if (now - newArmed > 4000) {
      newArmed = now;
      newBtn.textContent = "sure?";
      newBtn.classList.add("armed");
      setTimeout(() => {
        if (Date.now() - newArmed < 4000) return;
        newBtn.textContent = "new";
        newBtn.classList.remove("armed");
      }, 4200);
      return;
    }
    newArmed = 0;
    newBtn.textContent = "new";
    newBtn.classList.remove("armed");
    const result = await postBoardAction("new");
    if (!result) return;
    // The board arrives as a fresh snapshot, so there is nothing to clear here.
    hintLine("a new board in the same workspace");
  });

  configBtn.addEventListener("click", () => {
    closePick();
    shownConfig(configPanel.hidden);
    paintConfig();
  });

  cfgDim.addEventListener("click", async () => {
    const want = boardConfig.dimOthers === false;
    try {
      const response = await fetch(`/config?${auth}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dimOthers: want }),
      });
      if (!response.ok) throw new Error((await response.text()).slice(0, 80) || response.statusText);
      applyConfig((await response.json()).config);
    } catch (error) {
      hintLine(`could not change it: ${error.message || error}`, true);
    }
  });

  cfgModel.addEventListener("click", () => void openPick("model", cfgModel, true));
  cfgThinking.addEventListener("click", () => void openPick("thinking", cfgThinking, true));
  runtimeSearch.addEventListener("input", () => drawModels(runtimeSearch.value));
  window.addEventListener("resize", () => {
    if (!runtimePick.hidden) placeRuntimePick();
  });
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (event.target.closest("#runtimePick, #modelPick, #thinkPick, #boardConfig, #configBtn")) return;
      if (!runtimePick.hidden) closePick();
      if (!configPanel.hidden) shownConfig(false);
    },
    true,
  );
  // The panels take Escape first, so closing one never sends the draft to the board instead.
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape") return;
      if (!runtimePick.hidden) {
        event.stopPropagation();
        closePick();
        return;
      }
      if (configPanel.hidden) return;
      event.stopPropagation();
      shownConfig(false);
    },
    true,
  );

  // ---------- the crossroads -------------------------------------------------
  // Choosing a workspace is not this page's job any more: it lives on `/`, in its own tab, so a board
  // never has to be paused to pick another one. The header label goes back there.
  document.getElementById("sess").addEventListener("click", () => {
    window.open(`/?token=${encodeURIComponent(token)}`, "pi-studio-crossroads");
  });

  for (const button of document.querySelectorAll("#composer .modes button[data-mode]")) {
    button.addEventListener("click", () => {
      sendMode = button.dataset.mode === "steer" ? "steer" : "queue";
      for (const other of document.querySelectorAll("#composer .modes button[data-mode]")) {
        other.classList.toggle("on", other === button);
      }
      paintComposer();
    });
  }

  // Images pasted into the composer travel with the message, so a screenshot reaches the
  // agent without leaving the board for the terminal.
  const attachments = document.getElementById("attachments");
  const pendingImages = [];

  function drawAttachments() {
    attachments.replaceChildren();
    for (const [index, image] of pendingImages.entries()) {
      const holder = el("div", "shot");
      const thumb = document.createElement("img");
      thumb.src = image.dataUrl;
      thumb.title = image.mimeType;
      const remove = el("button", "");
      remove.textContent = "×";
      remove.title = "remove";
      remove.addEventListener("click", () => {
        pendingImages.splice(index, 1);
        drawAttachments();
      });
      holder.append(thumb, remove);
      attachments.appendChild(holder);
    }
  }

  // A screenshot is several megabytes once base64 encoded, which is slow to push and slow to
  // replay. Shrinking it to a size that still reads well keeps the message small.
  const MAX_IMAGE_EDGE = 1568;
  function shrinkImage(dataUrl, mimeType) {
    const original = { dataUrl, mimeType, data: dataUrl.slice(dataUrl.indexOf(",") + 1) };
    return new Promise((resolve) => {
      const image = new Image();
      image.addEventListener("load", () => {
        const width = image.naturalWidth;
        const height = image.naturalHeight;
        if (Math.max(width, height) <= MAX_IMAGE_EDGE && dataUrl.length < 400_000) {
          resolve(original);
          return;
        }
        const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        const shrunk = canvas.toDataURL("image/jpeg", 0.85);
        resolve({ dataUrl: shrunk, mimeType: "image/jpeg", data: shrunk.slice(shrunk.indexOf(",") + 1) });
      });
      // Anything the browser cannot decode travels untouched rather than disappearing.
      image.addEventListener("error", () => resolve(original));
      image.src = dataUrl;
    });
  }

  msgBox.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    event.preventDefault();
    for (const file of files.slice(0, 4)) {
      const reader = new FileReader();
      reader.addEventListener("load", async () => {
        pendingImages.push(await shrinkImage(String(reader.result), file.type));
        drawAttachments();
      });
      reader.readAsDataURL(file);
    }
  });

  // ---------- file picker --------------------------------------------------
  // The agent works on paths, so the picker attaches paths: it lists a folder's names and never
  // pulls file contents through the browser. Picking starts at the session folder and walks
  // anywhere the server can read, which is what the user asked for when attaching a file.
  const picker = document.getElementById("picker");
  const pickList = document.getElementById("pickList");
  const pickPathInput = document.getElementById("pickPath");
  const pickFilter = document.getElementById("pickFilter");
  const pickHidden = document.getElementById("pickHidden");
  const pickUp = document.getElementById("pickUp");
  const pickCount = document.getElementById("pickCount");
  const pickError = document.getElementById("pickError");
  const pathChips = document.getElementById("pathChips");
  /** Picked paths survive navigation, so one message can name files from several folders. */
  const picked = new Map();
  let pickerAt = "";
  let listed = [];
  let listedTotal = 0;
  /**
   * The row the arrow keys are on, which the filter keeps the focus away from so typing works.
   * `-1` is no row: a fresh list starts unhighlighted, so Enter never attaches what the list
   * happened to open on.
   */
  let pickAt = -1;
  /** Every listing bumps this, so a slow reply cannot land on top of a newer one. */
  let browseSeq = 0;
  let filterTimer = 0;

  /** `~` in place of the home folder keeps a chip short enough to read in a row. */
  function shortenPath(path) {
    const home = picker.dataset.home || "";
    return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
  }

  function drawChips() {
    pathChips.replaceChildren();
    for (const [path, meta] of picked) {
      const chip = el("div", meta.dir ? "chip folder" : "chip");
      chip.title = path;
      const label = el("span", "");
      label.textContent = shortenPath(path);
      const remove = el("button", "");
      remove.textContent = "×";
      remove.title = "remove";
      remove.addEventListener("click", () => {
        picked.delete(path);
        drawChips();
        drawList();
      });
      chip.append(label, remove);
      pathChips.appendChild(chip);
    }
    const count = picked.size;
    pickCount.textContent = count === 0 ? "nothing picked" : count === 1 ? "1 path" : `${count} paths`;
  }

  function drawList() {
    pickList.replaceChildren();
    if (listed.length === 0) {
      const hint = el("div", "p-empty");
      hint.textContent = pickFilter.value.trim() ? "nothing matches" : "empty folder";
      pickList.appendChild(hint);
      return;
    }
    for (const entry of listed) {
      const isPicked = picked.has(entry.path);
      // A real button, so the list can be walked with the keyboard: Enter or Space is a pick.
      const row = el("button", `p-item${entry.dir ? " dir" : ""}${isPicked ? " on" : ""}`);
      row.type = "button";
      row.title = entry.path;
      const tick = el("span", "p-tick");
      tick.textContent = isPicked ? "●" : "○";
      // The row's name is the file, so the glyph says nothing out loud and `aria-pressed` says it.
      tick.setAttribute("aria-hidden", "true");
      row.setAttribute("aria-pressed", String(isPicked));
      const name = el("span", "p-name");
      name.textContent = entry.name;
      row.append(tick, name);
      // A click picks; the chevron opens, because walking a tree and choosing in it are two acts.
      // A button cannot hold another button, so the chevron is decoration the row listens for.
      row.addEventListener("click", (event) => {
        if (event.target.classList.contains("p-open")) return void browse(entry.path);
        if (isPicked) picked.delete(entry.path);
        else picked.set(entry.path, { dir: entry.dir });
        drawList();
        drawChips();
      });
      if (entry.dir) {
        const open = el("span", "p-open");
        open.textContent = "›";
        open.title = "open this folder";
        // ArrowRight opens from the keyboard, so the glyph is not a second control to stop at.
        open.setAttribute("aria-hidden", "true");
        row.appendChild(open);
      }
      pickList.appendChild(row);
    }
    markHighlight();
    if (listedTotal > listed.length) {
      const note = el("div", "p-empty");
      note.textContent = `${listedTotal - listed.length} more — type in the filter to narrow it`;
      pickList.appendChild(note);
    }
  }

  /** Paint the row the arrows are on; the filter keeps the focus so typing keeps filtering. */
  function markHighlight() {
    const rows = [...pickList.querySelectorAll(".p-item")];
    rows.forEach((row, at) => row.classList.toggle("hl", at === pickAt));
  }

  /** The list hangs off the composer's top edge, which is where the field is however the page moves. */
  function placePicker() {
    const box = document.getElementById("composer").getBoundingClientRect();
    const width = Math.min(430, window.innerWidth - 28);
    picker.style.width = `${width}px`;
    const left = Math.min(Math.max(14, box.left + 14), window.innerWidth - width - 14);
    picker.style.left = `${left}px`;
    // Anchored by its bottom, so the list grows upward and never drifts across the field.
    picker.style.bottom = `${Math.max(14, window.innerHeight - box.top + 8)}px`;
  }

  async function browse(path, { focus = true } = {}) {
    const seq = (browseSeq += 1);
    pickError.hidden = true;
    try {
      const query = new URLSearchParams({ token, path: path ?? "" });
      if (pickHidden.checked) query.set("hidden", "1");
      const needle = pickFilter.value.trim();
      // Filtering happens on the server because the server is what caps how many names travel.
      if (needle) query.set("q", needle);
      const response = await fetch(`/browse?${query}`);
      if (seq !== browseSeq) return;
      if (!response.ok) throw new Error((await response.text()).slice(0, 120) || response.statusText);
      const data = await response.json();
      if (seq !== browseSeq) return;
      pickerAt = data.path;
      picker.dataset.home = data.home || "";
      pickPathInput.value = shortenPath(data.path);
      pickUp.disabled = data.parent === data.path;
      pickUp.dataset.parent = data.parent;
      listed = data.entries;
      listedTotal = data.total ?? data.entries.length;
      // A new folder starts the walk nowhere, so no row is armed until an arrow key moves.
      pickAt = -1;
      drawList();
      drawChips();
      picker.hidden = false;
      placePicker();
      // Typing a filter must not have its text selected out from under it, so only an
      // open or a deliberate move takes focus.
      if (focus) {
        pickFilter.focus();
        pickFilter.select();
      }
    } catch (error) {
      if (seq !== browseSeq) return;
      // The folder already open stays open: a typo in a path should not wipe the list.
      pickError.textContent = error.message || String(error);
      pickError.hidden = false;
      picker.hidden = false;
      placePicker();
    }
  }

  const closePicker = () => {
    // A keyboard user inside the list gets the keyboard back on the control that opened it; a
    // click elsewhere has already chosen its own target.
    const inside = !picker.hidden && picker.contains(document.activeElement);
    picker.hidden = true;
    // Whatever is still in flight belongs to a picker that is gone.
    browseSeq += 1;
    clearTimeout(filterTimer);
    // Picking files is rarely the end of the message, so a draft in hand takes the keyboard back.
    if (inside && msgBox.value.trim()) msgBox.focus();
    else if (inside) document.getElementById("pickFiles").focus();
  };

  document.getElementById("pickFiles").addEventListener("click", () => {
    if (!picker.hidden) closePicker();
    else void browse(pickerAt);
  });
  document.getElementById("pickDone").addEventListener("click", closePicker);
  document.getElementById("pickClose").addEventListener("click", closePicker);
  document.getElementById("pickHere").addEventListener("click", () => {
    if (!pickerAt) return;
    if (picked.has(pickerAt)) picked.delete(pickerAt);
    else picked.set(pickerAt, { dir: true });
    drawList();
    drawChips();
  });
  pickUp.addEventListener("click", () => {
    if (pickUp.dataset.parent) void browse(pickUp.dataset.parent);
  });
  document.getElementById("pickHome").addEventListener("click", () => void browse("~"));
  document.getElementById("pickCwd").addEventListener("click", () => void browse(""));
  pickHidden.addEventListener("change", () => void browse(pickerAt, { focus: false }));
  pickFilter.addEventListener("input", () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      if (!picker.hidden) void browse(pickerAt, { focus: false });
    }, 160);
  });
  // The whole overlay answers the keyboard, so Escape leaves from a row or the hidden box, not
  // only from the two fields, and the arrows walk the list while the filter keeps the focus.
  picker.addEventListener("keydown", (event) => {
    // The path field already took this keystroke (it browses what was typed).
    if (event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closePicker();
      return;
    }
    const rows = [...pickList.querySelectorAll(".p-item")];
    const onRow = event.target.closest(".p-item");
    // Walking continues from the row the focus is on, which Tab can reach without the arrows.
    const from = onRow ? rows.indexOf(onRow) : pickAt;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!listed.length) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      pickAt = (from + step + listed.length) % listed.length;
      markHighlight();
      if (onRow) rows[pickAt]?.focus();
      rows[pickAt]?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (event.key === "Enter" && !event.target.closest("button")) {
      // A row is a button, so Enter on one clicks it natively, and every other button in the
      // dialog keeps its own Enter; only a field hands the keystroke to the highlight.
      if (!rows[pickAt]) return;
      event.preventDefault();
      rows[pickAt].click();
      return;
    }
    // Right only opens a folder from a row, so it stays a caret move inside the fields.
    if (event.key === "ArrowRight" && onRow && listed[from] && listed[from].dir) {
      event.preventDefault();
      void browse(listed[from].path);
    }
  });
  pickPathInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void browse(pickPathInput.value.trim() || "/");
  });
  window.addEventListener("resize", () => {
    if (!picker.hidden) placePicker();
  });
  // A click anywhere else puts the picker away, the same as closing it. The chip row is part of
  // the composer's own furniture, so removing a pick is not a click on the board.
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (picker.hidden || event.target.closest("#picker, #pickFiles, #pathChips")) return;
      closePicker();
    },
    true,
  );

  /** Paths travel as text, which the agent's own file tools read directly. */
  function pickedPathsText() {
    const lines = [...picked].map(([path, meta]) => `${path}${meta.dir ? "/" : ""}`);
    return `Files and folders:\n${lines.join("\n")}`;
  }

  async function sendMessage() {
    // Enter fires again while the first send is in flight; a second body would carry a new id,
    // slip past the server's duplicate guard and deliver the message twice.
    if (sendBtn.disabled) return;
    const draft = msgBox.value;
    const typed = draft.trim();
    if (!typed && pendingImages.length === 0 && picked.size === 0) return;
    const text = picked.size === 0 ? typed : `${typed}${typed ? "\n\n" : ""}${pickedPathsText()}`;
    // What this message carries, so a pick or a keystroke made while it travels is still there.
    const sentPaths = [...picked.keys()];
    const sentImages = [...pendingImages];
    const sentTarget = replyTarget;
    sendBtn.disabled = true;
    // Both attempts carry the same id, so a retry after a reset cannot deliver twice.
    const body = JSON.stringify({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      cardId: replyTarget ? replyTarget.id : undefined,
      fork: forkNext && replyTarget ? true : undefined,
      text,
      mode: sendMode,
      images: sentImages.map((image) => ({ data: image.data, mimeType: image.mimeType })),
    });
    try {
      let response;
      // A socket the browser thought was alive can be closed under it, which loses the
      // request silently. One retry turns that into a delivered message.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          response = await fetch(`/message?${auth}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          });
          break;
        } catch (error) {
          if (attempt === 1 || !(error instanceof TypeError)) throw error;
        }
      }
      if (!response.ok) throw new Error((await response.text()).slice(0, 80) || response.statusText);
      if (msgBox.value === draft) msgBox.value = "";
      for (const image of sentImages) {
        const at = pendingImages.indexOf(image);
        if (at >= 0) pendingImages.splice(at, 1);
      }
      drawAttachments();
      for (const path of sentPaths) picked.delete(path);
      drawChips();
      closePicker();
      // A thread is a conversation: the field stays in the card it just answered, so the next
      // message does not need the card clicked again. Escape puts it away.
      // A fork is one send's choice, so the next comment goes to the owner again.
      forkNext = false;
      if (replyTarget === sentTarget && sentTarget && byId.has(sentTarget.id)) setReplyTarget(sentTarget);
      else setReplyTarget(null);
      // With no run in flight the message is being sent, not queued behind one.
      composerHint.textContent = metaRunning !== true ? "sent" : sendMode === "steer" ? "steered" : "queued";
    } catch (error) {
      const gone = error instanceof TypeError; // fetch rejects like this when nothing answers
      composerHint.textContent = gone
        ? "board connection lost — reload the page"
        : `failed: ${error.message || error}`;
    } finally {
      sendBtn.disabled = false;
    }
  }

  sendBtn.addEventListener("click", () => void sendMessage());

  // ---------- threads -------------------------------------------------------
  // A thread is a card with an agent behind it. The server creates it, and it arrives on the
  // stream like any other card, so this waits for it rather than assuming it is already here.
  const newThreadBtn = document.getElementById("newThread");

  function focusThread(id) {
    let tries = 0;
    const wait = () => {
      const entry = byId.get(id);
      if (!entry) {
        // A card that never arrives is a dead board, not a slow one, so it stops asking.
        if (tries++ < 60) setTimeout(wait, 50);
        else console.error("pi-studio: the new thread never arrived");
        return;
      }
      centerOn(entry);
      setReplyTarget(entry);
      msgBox.focus();
    };
    wait();
  }

  newThreadBtn.addEventListener("click", async () => {
    newThreadBtn.disabled = true;
    try {
      const response = await fetch(`/thread?${auth}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error((await response.text()).slice(0, 80) || response.statusText);
      const created = await response.json();
      if (created.threadId) focusThread(created.threadId);
    } catch (error) {
      console.error(`pi-studio: could not start a thread: ${error.message || error}`);
      hintLine(`could not start a thread: ${error.message || error}`, true);
    } finally {
      newThreadBtn.disabled = false;
    }
  });

  // Stop asks the server to abort the run, then waits for meta to confirm it settled.
  stopBtn.addEventListener("click", async () => {
    stopBtn.disabled = true;
    stopBtn.textContent = "stopping…";
    try {
      await fetch(`/stop?${auth}`, { method: "POST" });
    } catch {
      stopBtn.disabled = false;
      stopBtn.textContent = "stop";
    }
  });
  const composer = document.getElementById("composer");
  const composerHome = composer.parentElement;
  let composerAt = composer.nextElementSibling;

  /**
   * The composer is a view of one piece of state, so it moves rather than being copied: while a
   * card is the reply target the field sits at the bottom of that card, and `esc` puts it back.
   */
  function dockComposer(entry) {
    // The field is about to move, so a list hanging off it is closed rather than left behind.
    closePicker();
    if (entry) {
      // A folded card has no room for a field, so replying unfolds it.
      if (entry.card.classList.contains("mini")) setMini(entry.card, false);
      entry.card.insertBefore(composer, entry.card.querySelector(".resize"));
      composer.classList.add("docked");
      return;
    }
    if (composer.parentElement !== composerHome) {
      composer.classList.remove("docked");
      composerHome.insertBefore(composer, composerAt);
    }
  }

  // The selection is a reading position, so Escape gives it up: the board stops dimming and the wheel
  // goes back to moving the board. A panel or an editor takes Escape first and stops it there.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!document.querySelector(".card.active")) return;
    for (const card of cards) card.classList.remove("active");
    paintFocus();
  });

  // `r` opens a thread on the card you last clicked and `q` closes it. The composer keeps its
  // own keys, so a message being typed is never cut short.
  document.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if ((key !== "r" && key !== "q") || event.metaKey || event.ctrlKey || event.altKey) return;
    if (typingSomewhere()) return;
    // The panel covers the board, so its closing key wins over the card it hides.
    if (!actPanel.hidden) {
      if (key === "q") {
        event.preventDefault();
        closeActPanel();
      }
      return;
    }
    // The picker is its own surface: a board shortcut behind it would act on what is out of reach.
    if (!picker.hidden) return;
    const active = document.querySelector(".card.active");
    const record = active ? byId.get(active.dataset.id) : null;
    if (!record) return;
    if (key === "q") {
      // The × is hidden on an open question, so the key does not go where the button cannot:
      // closing one would leave the agent waiting with nothing left to answer.
      if (questionWants(record.data)) return;
      event.preventDefault();
      closeCard(record);
      return;
    }
    event.preventDefault();
    setReplyTarget(record);
  });

  // `1`–`6` answer the question the agent is waiting on, so a decision needs no mouse.
  document.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || !/^[1-6]$/.test(event.key)) return;
    if (typingSomewhere()) return;
    if (!actPanel.hidden) return;
    const record = openQuestion();
    if (!record) return;
    // The option buttons carry their own click handler, so this reuses the whole answer path.
    const button = record.body.querySelectorAll(".q-options .q-opt")[Number(event.key) - 1];
    if (!button || button.disabled) return;
    event.preventDefault();
    button.click();
  });

  // The board is drivable without a mouse: `f` frames it, `0` is real size, `n` is what is next.
  // The composer keeps its plain letters, because a field the user is typing in is never read.
  document.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (typingSomewhere()) return;
    // The picker is its own surface: a board shortcut behind it would move what is out of reach.
    if (!picker.hidden || !actPanel.hidden) return;
    if (event.key === "f") {
      event.preventDefault();
      fitAll();
    } else if (event.key === "0") {
      event.preventDefault();
      resetZoom();
    } else if (event.key === "n") {
      event.preventDefault();
      jumpToFresh();
    } else if (event.key === "o") {
      event.preventDefault();
      flipOrder();
    }
  });

  msgBox.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && replyTarget) {
      event.preventDefault();
      setReplyTarget(null);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  });

  // ---------- transport ----------------------------------------------------
  // ---------- session header -----------------------------------------------
  const shortNum = (value) => {
    if (value >= 1e6) return `${(value / 1e6).toFixed(1)}m`;
    if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
    return String(value);
  };

  function applyMeta(meta) {
    if (!meta) return;
    // A board of threads has no single session behind it, so the field lives in the card and the
    // bottom bar is gone. Same client, two backends, one visual language.
    document.body.classList.toggle("threads", workspace !== "" || meta.mode === "threads");
    const wasRunning = metaRunning === true;
    metaRunning = meta.running === true;
    // What the daemon starts a new thread with. The chips say this when no card is being answered, so
    // they cannot be left guessing from whichever thread happens to be newest.
    applyConfig(meta.config);
    // Steering means nothing with no run in flight, so the composer follows the same state. Meta
    // also arrives at every assistant message, so only a run boundary repaints: a repaint would
    // wipe the "sent" or "failed: …" line the composer is showing while the stream is alive.
    if (metaRunning !== wasRunning) paintComposer();
    // A board served by an older pi has no runStartedAt, so the header says waiting instead
    // of inventing an elapsed time from the moment this tab happened to hear about the run.
    runStartedAt = typeof meta.runStartedAt === "number" ? meta.runStartedAt : null;
    // A run that settled without closing its row would keep it counting for ever, so the rail
    // settles it here and the header and the ticker cannot disagree.
    if (!metaRunning) {
      for (const node of railNow.querySelectorAll(".act.running")) node.classList.replace("running", "error");
    }
    renderLive();
    syncTicker();
    // The stop button exists only while there is something to stop.
    stopBtn.style.display = meta.running ? "" : "none";
    if (!meta.running) {
      stopBtn.disabled = false;
      stopBtn.textContent = "stop";
    }
    // The label names the workspace this tab belongs to; clicking it goes back to the crossroads,
    // where another one can be opened in a tab of its own.
    const folder = meta.workspace?.name || meta.folder || "session";
    const sess = document.getElementById("sess");
    sess.innerHTML = "";
    sess.append("board of ");
    const name = document.createElement("b");
    name.textContent = folder;
    sess.append(name);
    sess.title = meta.workspace
      ? `${meta.workspace.folder} · click for the crossroads`
      : `${meta.cwd || folder} · port ${meta.port}`;
    setBaseTitle(`pi - ${folder}`);
    const model = document.getElementById("statModel");
    if (meta.model) {
      model.innerHTML = `<em>${meta.model.split("/").pop()}</em>`;
      model.title = meta.model;
    } else {
      model.innerHTML = "";
    }
    document.getElementById("statTokens").innerHTML =
      meta.tokensIn || meta.tokensOut ? `↑${shortNum(meta.tokensIn)} ↓${shortNum(meta.tokensOut)}` : "";
    document.getElementById("statCost").innerHTML =
      meta.cost > 0 ? `$${meta.cost < 0.01 ? meta.cost.toFixed(4) : meta.cost.toFixed(3)}` : "";
    // The context chip carries the compact action, so it is hidden outright when there is no
    // figure to show rather than left as a button with nothing in it.
    const known = typeof meta.contextPercent === "number";
    statCtx.hidden = !known;
    statCtxValue.textContent = known ? `ctx ${Math.round(meta.contextPercent)}%` : "";
    // The action word is hidden until hover, so the name has to carry it for a screen reader.
    if (known) statCtx.setAttribute("aria-label", `ctx ${Math.round(meta.contextPercent)}%, compact the context`);
    // Compaction aborts a run in flight, so the chip stops offering it while one is happening.
    statCtx.classList.toggle("busy", meta.running === true);
  }

  // A background tab announces new material the way a chat app does: the title blinks
  // until the tab is looked at again.
  let baseTitle = document.title || "pi - board";
  let flashTimer = null;

  function setBaseTitle(text) {
    baseTitle = text;
    if (!flashTimer) document.title = text;
  }

  function startFlash() {
    if (flashTimer || !document.hidden) return;
    let on = false;
    flashTimer = setInterval(() => {
      on = !on;
      document.title = on ? `● new · ${baseTitle}` : baseTitle;
    }, 800);
  }

  function stopFlash() {
    if (flashTimer) {
      clearInterval(flashTimer);
      flashTimer = null;
    }
    document.title = baseTitle;
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    stopFlash();
    // A hidden tab schedules nothing, so what is on screen now starts its countdown from here.
    for (const card of inView) armSeen(card);
  });
  addEventListener("focus", stopFlash);

  // What the header line is built from: the stream, the run, and the note a broken link leaves.
  let linkUp = false;
  let linkNote = "connecting";
  /** Pending timer that puts the dimmed down state on screen. */
  let dimTimer = null;
  /** null until the first meta says whether a run is in flight. */
  let metaRunning = null;
  let runStartedAt = null;
  let ticker = null;
  // The first paint waits until here: the composer section runs before the run and link state
  // above exist, and its hardcoded hint contradicted what paintComposer says.
  paintComposer();

  // The header line is one decision: a broken link wins, because without the stream the agent's
  // state is unknown and an elapsed time would be a guess.
  function renderLive() {
    const working = linkUp && metaRunning === true;
    live.classList.toggle("down", !linkUp);
    live.classList.toggle("working", working);
    // The clock ticks every second, so it is kept out of the spoken text and hidden: a screen
    // reader hears "working" once instead of a count read out every second.
    liveClock.textContent = "";
    if (!linkUp) {
      liveText.textContent = linkNote || "reconnecting";
      return;
    }
    // Nothing is known about the run until the first meta arrives, so claim nothing.
    if (metaRunning === null) {
      liveText.textContent = "connecting";
      return;
    }
    if (!working) {
      liveText.textContent = "idle";
      return;
    }
    if (runStartedAt === null) {
      liveText.textContent = "waiting";
      return;
    }
    liveText.textContent = "working";
    liveClock.textContent = `· ${clockText(Date.now() - runStartedAt)}`;
  }

  // Elapsed time the header can read at a glance: minutes, then hours once the minutes run out.
  function clockText(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = String(total % 60).padStart(2, "0");
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
  }

  // A rail row shows seconds, then whole minutes and seconds, so the width stays steady.
  function rowClock(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    if (total < 60) return `${total}s`;
    if (total < 3600) return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
    return `${Math.floor(total / 3600)}h ${String(Math.floor((total % 3600) / 60)).padStart(2, "0")}m`;
  }

  // One clock drives the header and every running row. It runs only while something is worth
  // ticking, so an idle board does not wake its tab every second.
  function tick() {
    if (metaRunning === true) renderLive();
    for (const node of railNow.querySelectorAll(".act.running")) {
      const started = Number(node.dataset.startedAt);
      const timing = node.querySelector(".ms");
      if (!started || !timing) continue;
      // A thought's rate only moves when a patch lands, so a few still seconds hand the row back to
      // the clock and a stalled thought stops looking live.
      if (node.dataset.kind === "thinking" && Date.now() - Number(node.dataset.patchedAt) < THOUGHT_STALL_MS) {
        continue;
      }
      timing.textContent = rowClock(Date.now() - started);
    }
    // Rail ages are derived from stored data, so re-reading them here is the only thing that
    // keeps the word current while nothing repaints the card.
    for (const id of railRows.keys()) {
      const entry = byId.get(id);
      if (entry) paintRailState(entry);
    }
  }

  function syncTicker() {
    const wanted = metaRunning === true || railNow.querySelector(".act.running") !== null || railRows.size > 0;
    if (wanted && !ticker) {
      ticker = setInterval(tick, 1000);
    } else if (!wanted && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  function setLive(up, note = "") {
    const flipped = linkUp !== up;
    linkUp = up;
    if (!up) linkNote = note;
    // The last painted board stays on screen, so the content has to say it is stale too. A wake or
    // a roam can break the stream for one retry cycle, so the down state waits a second and a link
    // that returns first cancels it.
    if (up) {
      clearTimeout(dimTimer);
      dimTimer = null;
      document.body.classList.remove("link-down");
    } else if (!dimTimer && !document.body.classList.contains("link-down")) {
      dimTimer = setTimeout(() => {
        dimTimer = null;
        document.body.classList.add("link-down");
      }, 1000);
    }
    // A retry that changes nothing leaves the hint alone, so a transient line survives it.
    if (flipped) paintComposer();
    renderLive();
  }

  function connect() {
    const source = new EventSource(`/events?${auth}`);
    source.onopen = () => setLive(true);
    source.onerror = () => {
      // The browser tells the two failures apart: an HTTP error, such as a token the board no
      // longer knows, closes the stream for good, while a network error leaves it retrying.
      if (source.readyState === EventSource.CLOSED) {
        setLive(false, "token refused — reopen the link pi printed");
      } else {
        setLive(false, "pi not reachable — retrying");
      }
    };
    source.onmessage = (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (payload.type === "meta") {
        applyMeta(payload.meta);
      } else if (payload.type === "snapshot") {
        applyMeta(payload.meta);
        // A reconnect replays what is already on the board, and the draft survives it. The thread
        // the draft is aimed at has to survive too, or a reply loses its card mid-conversation.
        const keptTarget = replyTarget ? replyTarget.id : null;
        clearBoard();
        replaying = true;
        // A card that throws mid-replay must not leave the flag set: the tab would then never
        // badge, centre or restore a target again.
        try {
          for (const row of payload.activity || []) applyActivity(row);
          for (const card of payload.cards || []) applyMessage(card);
        } finally {
          replaying = false;
        }
        if (keptTarget && byId.has(keptTarget)) setReplyTarget(byId.get(keptTarget));
        // Every thread comes back in the order the human chose, not the order the server lists.
        applyAllThreadOrder();
        sawFirstCard = (payload.cards || []).length > 0;
        // The chips say what a thread answers with, and the snapshot is the first time any thread is
        // known: without this they stay blank until some other card changes.
        paintRuntime();
        // Armed on the first snapshot even when it is empty: the usual start is an empty snapshot
        // and the first card frames through the new-card path, and the first reconnect must not
        // throw that framing away.
        if (!framedView) {
          framedView = true;
          if (cards.length) fitAll();
        }
      } else if (payload.type === "move") {
        const record = byId.get(payload.id);
        if (record && payload.rect) placeCard(record, payload.rect);
        if (record && typeof payload.mini === "boolean") setMini(record.card, payload.mini);
      } else if (payload.type === "remove") {
        dropCard({ id: payload.id });
      } else if (payload.type === "config") {
        // Another tab changed this board's settings, so this one follows without a reload.
        applyConfig(payload.config);
      } else if (payload.type === "activity") {
        applyActivity(payload.row);
      } else if (payload.type === "card" || payload.type === "update") {
        const known = byId.has(payload.card.id);
        // An open question is re-broadcast on every update, so its blink has to key on the
        // transition into blocking the agent, not on the state the tab already shows.
        const wasOpen = known && questionWants(byId.get(payload.card.id).data);
        applyMessage(payload.card, payload.quiet === true);
        paintRuntime();
        // A quiet repaint and a card the tab already holds are not news; only an arrival or a
        // question that has just started blocking the agent is worth a blink in a background tab.
        const record = byId.get(payload.card.id);
        if ((!known && payload.quiet !== true) || (record && !wasOpen && questionWants(record.data))) startFlash();
      } else if (payload.type === "hint") {
        hintLine(payload.text || "");
      } else if (payload.type === "clear") {
        clearBoard();
      }
    };
  }

  window.BOARD_START = () => {
    applyView();
    updateEmpty();
    paintRuntime();
    if (!token) {
      // No stream exists here, so nothing on the page is stale: only the header says why the board
      // is blank.
      linkNote = "missing token";
      renderLive();
      return;
    }
    connect();
  };
})();

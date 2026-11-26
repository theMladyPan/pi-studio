/**
 * The kontainer drawer: a live Docker/Podman topology (images → containers → wiring) in a panel
 * that rolls down from under the header with `k`, drawn in the approved Neon v2 style.
 * It keeps no state of its own beyond the session: every fact comes from `/kontainer/*` on the
 * daemon, refreshed over SSE plus the stats cadence the human picked (Eco/Balanced/Live).
 */
import { createSlidingDrawer } from "./drawer-common.js";

export function createKontainerDrawer({ workspace, typingSomewhere, openTerminalCommand }) {
  const drawer = document.getElementById("kontainerDrawer");
  const scrim = document.getElementById("kontainerScrim");
  const btn = document.getElementById("kontainerBtn");

  const $ = (id) => drawer.querySelector(`#${id}`);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  // Each threshold names its own divisor, so a size is never read in the unit above it (41 MB is not 0.0 GB).
  const fmtBytes = (b) => {
    if (b == null || !Number.isFinite(b)) return "—";
    if (b < 1024) return `${b} B`;
    if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`;
    if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(0)} MB`;
    if (b < 1024 ** 4) return `${(b / 1024 ** 3).toFixed(2).replace(/\.00$/, "")} GB`;
    return `${(b / 1024 ** 4).toFixed(2)} TB`;
  };
  const fmtDate = (t) => { if (!t) return "—"; const d = new Date(t); return Number.isNaN(d) ? String(t) : d.toLocaleString(); };
  const store = { get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

  /* ---------- DOM skeleton (own markup only; untrusted strings go through textContent) ---------- */
  drawer.innerHTML = `
    <div class="k-bar">
      <span class="k-title">kontainer</span><span class="k-ws" id="kWs"></span>
      <span class="k-pill" id="kPill"><span class="k-dot" id="kDot"></span><span><em id="kRun">0</em> up</span><span>·</span><span class="k-warn" id="kIssues">0 alerts</span><span>·</span><span id="kDisk">—</span></span>
      <span id="kRuntimeHost"></span>
      <span class="k-sep"></span>
      <span class="k-chip-group" id="kScopeGroup" role="group" aria-label="scope"></span>
      <span class="k-chip-group" id="kFilterGroup" role="group" aria-label="filter"></span>
      <span class="k-grow"></span>
      <span class="k-search-wrap"><input class="k-search" id="kSearch" type="text" placeholder="filter or > cmd" aria-label="filter topology" autocomplete="off" spellcheck="false"><span class="k-kbd">/</span></span>
      <select class="k-mode-sel" id="kMode" aria-label="refresh mode" title="refresh mode">
        <option value="eco">Eco</option><option value="balanced">Balanced</option><option value="live">Live</option>
      </select>
      <button class="k-bar-btn" id="kToolsBtn" type="button" aria-haspopup="menu" aria-expanded="false">tools ▾</button>
      <button class="k-bar-btn" id="kRollUp" type="button" title="roll up (k)">roll up (k)</button>
    </div>
    <div class="k-hint" id="kHint" hidden></div>
    <div class="k-body">
      <div class="k-viewport" id="kViewport">
        <div class="k-stage" id="kStage">
          <svg class="k-wires" id="kWireLayer" aria-hidden="true"></svg>
          <div class="k-grid">
            <div class="k-stratum"><div class="k-stratum-head"><span class="k-stratum-label"><span class="k-idx">01</span> Images · Lineage</span><span class="k-stratum-meta" id="kMetaImages"></span></div>
              <div class="k-col-list" id="kImages"></div><div class="k-unused-tray" id="kUnusedTray" hidden></div></div>
            <div class="k-stratum"><div class="k-stratum-head"><span class="k-stratum-label"><span class="k-idx">02</span> Runtime · Containers</span><span class="k-stratum-meta" id="kMetaRuntime"></span></div>
              <div class="k-col-list" id="kRuntime"></div></div>
            <div class="k-stratum"><div class="k-stratum-head"><span class="k-stratum-label"><span class="k-idx">03</span> Wiring · Exposure &amp; State</span><span class="k-stratum-meta" id="kMetaWiring"></span></div>
              <div class="k-col-list" id="kWiring"></div></div>
          </div>
        </div>
      </div>
      <aside class="k-inspector k-collapsed" id="kInspector" aria-label="selected node inspector"></aside>
      <div class="k-tools-menu" id="kToolsMenu" hidden role="menu"></div>
    </div>
    <div class="k-sheet-backdrop" id="kSheet" hidden><div class="k-sheet-panel" role="dialog" aria-modal="true">
      <div class="k-sheet-head"><span class="k-sheet-title" id="kSheetTitle"></span><span class="k-grow"></span><button class="k-insp-close" id="kSheetClose" type="button" title="close (esc)">×</button></div>
      <div class="k-sheet-body" id="kSheetBody"></div><div class="k-sheet-foot" id="kSheetFoot"></div>
    </div></div>
    <div class="k-toast" id="kToast" role="status"></div>`;

  const viewport = $("kViewport"), stage = $("kStage"), wires = $("kWireLayer"), inspector = $("kInspector");
  const searchInput = $("kSearch"), toolsBtn = $("kToolsBtn"), toolsMenu = $("kToolsMenu"), sheet = $("kSheet");

  /* ---------- state ---------- */
  const state = {
    data: null, filter: "all", search: "", scope: "workspace",
    runtime: store.get("kontainer.runtime", ""), mode: ["eco", "balanced", "live"].includes(store.get("kontainer.mode", "balanced")) ? store.get("kontainer.mode", "balanced") : "balanced",
    selected: null, hovered: null, tab: "logs", armedKill: null,
    stats: new Map(), history: new Map(), details: new Map(),
  };
  $("kMode").value = state.mode;
  let es = null, statsTimer = null, logsTimer = null, debounceTimer = null, toastTimer = null, rafPending = false, liveOn = false;

  const topo = () => state.data?.topology || { images: [], containers: [], wiring: { ports: [], networks: [], volumes: [] }, summary: {} };
  const images = () => topo().images || [];
  const containers = () => topo().containers || [];
  const wiring = () => topo().wiring || { ports: [], networks: [], volumes: [] };
  const summary = () => topo().summary || {};
  const findImage = (id) => images().find((i) => i.id === id);
  const findCtr = (id) => containers().find((c) => c.id === id);
  // A container's own id first, then the image its tag now names: a stale container still points at a
  // build this engine no longer holds under that id, and the local image with its name is its lineage.
  const imageOfCtr = (c) => findImage(c.imageId) || images().find((i) => i.name === c.imageName) || null;
  const imageIdOfCtr = (c) => imageOfCtr(c)?.id || c.imageId || "";
  const isRunning = (c) => ["running", "restarting"].includes(String(c.state || "").toLowerCase()) || /^up\b/i.test(c.statusText || "");
  // The bar's count, this column's filter and the backend's `summary.issues` are one definition.
  const isIssue = (c) => String(c.health || "").toLowerCase() === "unhealthy" || !!c.staleImage || !!c.oomKilled || (String(c.state || "").toLowerCase() === "exited" && c.exitCode !== null && c.exitCode !== 0) || String(c.state || "").toLowerCase() === "dead";
  const isUnusedImg = (i) => i.dangling || !i.inUse;
  const imgNameOf = (c) => { const i = imageOfCtr(c); return i ? `${i.repo}:${i.tag}` : c.imageName || ""; };
  const ctrWires = (c) => {
    const w = [];
    (wiring().ports || []).filter((p) => (p.containerIds || []).includes(c.id)).forEach((p) => w.push(p.id));
    (wiring().networks || []).filter((n) => (n.containerIds || []).includes(c.id)).forEach((n) => w.push(n.id));
    (wiring().volumes || []).filter((v) => (v.containerIds || []).includes(c.id)).forEach((v) => w.push(v.id));
    (c.networkIds || []).forEach((id) => { if (!w.includes(id)) w.push(id); });
    (c.volumeIds || []).forEach((id) => { if (!w.includes(id)) w.push(id); });
    return w;
  };
  const wireNode = (id) => {
    for (const [kind, list] of [["port", wiring().ports || []], ["net", wiring().networks || []], ["vol", wiring().volumes || []]]) {
      const n = list.find((x) => x.id === id); if (n) return { ...n, kind };
    } return null;
  };
  // The label the backend carries, so an unpublished port reads as one instead of `0.0.0.0:null`.
  const wireLabel = (w) => w.kind === "port" ? (w.label || `${w.hostIp || "0.0.0.0"}:${w.hostPort} → ${w.containerPort}${w.proto ? `/${w.proto}` : ""}`)
    : w.kind === "net" ? (w.name || w.id) : (w.label || w.source || w.id);
  function relatedSet(id) {
    if (!id) return null;
    const set = new Set([id]);
    const c = findCtr(id);
    if (c) { const imgId = imageIdOfCtr(c); if (imgId) set.add(imgId); ctrWires(c).forEach((w) => set.add(w)); return set; }
    const img = findImage(id);
    if (img) { containers().filter((x) => x.imageId === img.id || imgNameOf(x) === `${img.repo}:${img.tag}`).forEach((x) => { set.add(x.id); ctrWires(x).forEach((w) => set.add(w)); }); return set; }
    const w = wireNode(id);
    if (w) containers().filter((x) => ctrWires(x).includes(id)).forEach((x) => { set.add(x.id); const imgId = imageIdOfCtr(x); if (imgId) set.add(imgId); });
    return set;
  }
  function matches(node, kind) {
    const q = state.search.trim().toLowerCase();
    if (q && !q.startsWith(">")) {
      const hay = kind === "image" ? `${node.repo}:${node.tag} ${node.name || ""} ${node.shortId || ""}`
        : kind === "container" ? `${node.name || ""} ${node.shortId || ""} ${node.statusText || ""} ${node.state || ""} ${imgNameOf(node)} ${node.composeProject || ""}`
        : `${node.label || node.name || node.id} ${node.hostPort || ""} ${node.containerPort || ""} ${node.subnet || ""} ${node.source || ""}`;
      if (!hay.toLowerCase().includes(q)) return false;
    }
    if (state.filter === "all") return true;
    if (state.filter === "running") return kind === "container" ? isRunning(node) : containers().some((c) => (kind === "image" ? (c.imageId === node.id || imgNameOf(c) === `${node.repo}:${node.tag}`) : ctrWires(c).includes(node.id)) && isRunning(c));
    if (state.filter === "issues") return kind === "container" ? isIssue(node) : kind === "image" ? (node.drift || containers().some((c) => (c.imageId === node.id || imgNameOf(c) === `${node.repo}:${node.tag}`) && isIssue(c))) : containers().some((c) => ctrWires(c).includes(node.id) && isIssue(c));
    if (state.filter === "unused") return kind === "image" ? isUnusedImg(node) : kind === "container" ? !isRunning(node) : false;
    return true;
  }

  /* ---------- API ---------- */
  async function apiText(url, opts) {
    const r = await fetch(url, opts);
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    if (!r.ok) throw new Error(json?.error || json?.message || text || `request failed (${r.status})`);
    return json ?? text;
  }
  const qs = (extra = "") => `/kontainer/state?workspace=${encodeURIComponent(workspace || "")}&runtime=${encodeURIComponent(state.runtime || "")}&scope=${state.scope}${extra}`;
  async function loadState() {
    if (!workspace) { showUnavailable("this board has no folder of its own, so there is no runtime to draw"); return; }
    try {
      const data = await apiText(qs());
      state.data = data;
      if (data.available === false) { showUnavailable(data.reason || "no container runtime is available"); return; }
      if (data.activeRuntime && !state.runtime) state.runtime = data.activeRuntime;
      render();
    } catch (e) { toast(`kontainer: ${e.message}`); }
  }
  function showUnavailable(reason) {
    state.data = { available: false, reason, runtimes: [], topology: { images: [], containers: [], wiring: { ports: [], networks: [], volumes: [] }, summary: {} } };
    render();
  }
  async function postAction(payload, okMsg) {
    const data = await apiText(`/kontainer/action?workspace=${encodeURIComponent(workspace || "")}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runtime: state.runtime || undefined, ...payload }) });
    // The action route answers 200 either way, so its `ok` is the only verdict a failure carries.
    if (data?.ok === false) throw new Error(data?.error || "action failed");
    if (okMsg) toast(okMsg);
    await loadState();
    return data;
  }
  async function fetchStats(ids) {
    if (!ids.length || !workspace) return;
    try {
      const data = await apiText(`/kontainer/stats?workspace=${encodeURIComponent(workspace)}&runtime=${encodeURIComponent(state.runtime || "")}&ids=${encodeURIComponent(ids.join(","))}`);
      for (const [id, s] of Object.entries(data.stats || {})) {
        state.stats.set(id, s);
        const h = state.history.get(id) || { cpu: [], mem: [] };
        if (s && Number.isFinite(s.cpuPct)) { h.cpu.push(s.cpuPct); if (h.cpu.length > 30) h.cpu.shift(); }
        if (s && Number.isFinite(s.memUsed)) { h.mem.push(s.memUsed); if (h.mem.length > 30) h.mem.shift(); }
        state.history.set(id, h);
      }
      paintTelemetry(state.selected?.kind === "container" ? state.selected.id : null);
      paintMetrics(ids);
    } catch { /* stats are best-effort */ }
  }

  /* ---------- toasts ---------- */
  function toast(msg) {
    const t = $("kToast"); t.textContent = msg; t.classList.add("k-show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("k-show"), 3200);
  }

  /* ---------- render: bar ---------- */
  function renderRuntimeHost() {
    const host = $("kRuntimeHost"); host.replaceChildren();
    const runtimes = state.data?.runtimes || [];
    if (runtimes.length > 1) {
      const sel = el("select", "k-runtime-sel"); sel.setAttribute("aria-label", "runtime");
      const rid = (r) => (typeof r === "string" ? r : r.id);
      const rlabel = (r) => (typeof r === "string" ? r : r.label || r.id);
      for (const r of runtimes) { const o = el("option", null, rlabel(r)); o.value = rid(r); sel.append(o); }
      sel.value = state.runtime || state.data.activeRuntime || rid(runtimes[0]);
      sel.onchange = () => { state.runtime = sel.value; store.set("kontainer.runtime", state.runtime); loadState(); };
      host.append(sel);
    } else if (runtimes.length === 1) {
      host.append(el("span", "k-badge k-b-muted", (typeof runtimes[0] === "string" ? runtimes[0] : runtimes[0].label || runtimes[0].id) || "docker"));
    } else if (state.runtime) {
      host.append(el("span", "k-badge k-b-muted", state.runtime));
    }
  }
  function renderChips() {
    const s = summary();
    const scopeGroup = $("kScopeGroup"); scopeGroup.replaceChildren();
    for (const [value, label, count] of [["workspace", "workspace", s.workspaceContainers ?? containers().filter((c) => c.inWorkspace).length], ["all", "all host", s.allContainers ?? containers().length]]) {
      const b = el("button", `k-chip${state.scope === value ? " active" : ""}`, `${label} `);
      b.type = "button"; b.append(el("span", "k-cnt", String(count ?? 0)));
      b.onclick = () => { state.scope = value; loadState(); };
      scopeGroup.append(b);
    }
    const fg = $("kFilterGroup"); fg.replaceChildren();
    const counts = { all: containers().length, running: containers().filter(isRunning).length, issues: containers().filter(isIssue).length, unused: images().filter(isUnusedImg).length };
    for (const f of ["all", "running", "issues", "unused"]) {
      const b = el("button", `k-chip${state.filter === f ? " active" : ""}${f === "issues" ? " k-issues" : ""}`, f);
      b.type = "button"; b.append(el("span", "k-cnt", String(counts[f])));
      b.onclick = () => { state.filter = f; render(); };
      fg.append(b);
    }
  }
  function renderBar() {
    const s = summary();
    $("kRun").textContent = String(s.running ?? containers().filter(isRunning).length);
    $("kIssues").textContent = `${s.issues ?? containers().filter(isIssue).length} alerts`;
    $("kDisk").textContent = fmtBytes(s.totalImageBytes ?? images().reduce((a, i) => a + (i.sizeBytes || 0), 0));
    $("kDot").classList.toggle("bad", (s.issues ?? 0) > 0);
    $("kMetaImages").textContent = `${images().length} local`;
    const stacks = new Set(containers().map((c) => c.composeProject).filter(Boolean)).size;
    $("kMetaRuntime").textContent = `${stacks ? `${stacks} stack${stacks > 1 ? "s" : ""} · ` : ""}${containers().length} total`;
    $("kMetaWiring").textContent = `${(wiring().ports || []).length} ports · ${(wiring().networks || []).length} nets · ${(wiring().volumes || []).length} vols`;
    renderRuntimeHost(); renderChips();
    const hint = $("kHint");
    const unavailable = state.data?.available === false;
    const emptyWorkspace = !unavailable && state.scope === "workspace" && (s.workspaceContainers ?? 0) === 0 && (s.allContainers ?? 0) > 0;
    hint.hidden = !unavailable && !emptyWorkspace;
    if (unavailable) {
      const retry = el("button", "k-mini-btn", "retry"); retry.type = "button"; retry.onclick = () => loadState();
      hint.replaceChildren(el("span", null, state.data.reason || "Docker/Podman socket unavailable"), retry);
    } else if (emptyWorkspace) {
      hint.replaceChildren(el("span", null, "no containers in this workspace — every container on the host is shown instead"), (() => { const b = el("button", "k-mini-btn", "show all host"); b.type = "button"; b.onclick = () => { state.scope = "all"; loadState(); }; return b; })());
    }
  }

  /* ---------- render: topology ---------- */
  const LAYER_COLORS = ["#3d444d", "#1f6feb", "#58a6ff", "#3fb950", "#d29922", "#d2a8ff", "#f85149"];
  function focusClasses(card, id, related) {
    if (state.selected?.id === id) card.classList.add("k-selected");
    if (related) card.classList.toggle("k-related", related.has(id)), card.classList.toggle("k-dimmed", !related.has(id));
    card.addEventListener("click", (e) => { e.stopPropagation(); state.selected = { kind: card.dataset.kind, id }; state.tab = card.dataset.kind === "image" ? "layers" : "logs"; state.armedKill = null; if (state.mode === "eco") fetchStats([id]); render(); });
    card.addEventListener("mouseenter", () => { if (state.hovered?.id !== id) { state.hovered = { kind: card.dataset.kind, id }; paintFocus(); } });
    card.addEventListener("mouseleave", () => { if (state.hovered?.id === id) { state.hovered = null; paintFocus(); } });
  }
  function buildImageCard(img, related) {
    const card = el("div", `k-card${isUnusedImg(img) ? " k-unused-img" : ""}`); card.dataset.nodeId = img.id; card.dataset.kind = "image";
    const top = el("div", "k-img-top");
    const name = el("span", "k-img-name", `${img.repo || "<none>"}:`); name.append(el("span", "k-img-tag", img.tag || "<none>")); top.append(name);
    if (img.drift) top.append(el("span", "k-badge k-b-amber", "drift"));
    if (img.dangling) top.append(el("span", "k-badge k-b-red", "dangling"));
    const sub = el("div", "k-img-sub", `${fmtBytes(img.sizeBytes)} · ${img.layersCount ?? "—"} layers`);
    sub.append(el("span", null, fmtDate(img.created)));
    const bar = el("div", "k-layer-bar");
    const n = Math.max(1, img.layersCount || 1);
    for (let i = 0; i < n; i++) { const seg = el("span", "k-layer-seg"); seg.style.width = `${100 / n}%`; seg.style.background = LAYER_COLORS[i % LAYER_COLORS.length]; bar.append(seg); }
    card.append(top, sub, bar);
    const jack = el("span", "k-jack k-jack-r"); jack.dataset.jack = `${img.id}-out`; card.append(jack);
    focusClasses(card, img.id, related);
    return card;
  }
  function ctrStateClass(c) { return isIssue(c) && !isRunning(c) ? (c.exitCode > 0 || c.oomKilled ? "k-st-failed" : "k-st-warn") : isRunning(c) ? "k-st-running" : "k-st-stopped"; }
  function ctrDotClass(c) { return ctrStateClass(c).replace("k-st-", "k-"); }
  function buildContainerCard(c, related) {
    const card = el("div", `k-card k-ctr ${ctrStateClass(c)}`); card.dataset.nodeId = c.id; card.dataset.kind = "container";
    const row1 = el("div", "k-ctr-row1");
    row1.append(el("span", `k-sdot ${ctrDotClass(c)}`), el("span", "k-ctr-name", c.name || c.shortId || c.id), el("span", "k-ctr-id", c.shortId || ""));
    if (c.staleImage) row1.append(el("span", "k-badge k-b-amber", "stale"));
    if (c.oomKilled) row1.append(el("span", "k-badge k-b-red", "oom"));
    const row2 = el("div", "k-ctr-row2");
    const up = el("span", `k-uptime${c.exitCode > 0 ? " k-err" : c.staleImage ? " k-warn" : ""}`, c.statusText || c.state || "");
    row2.append(up, el("span", null, imgNameOf(c)));
    const metrics = el("div", "k-metrics"); metrics.dataset.metricsFor = c.id;
    paintMetricsInto(metrics, c);
    const jackL = el("span", "k-jack k-jack-l"); jackL.dataset.jack = `${c.id}-in`;
    const jackR = el("span", "k-jack k-jack-r"); jackR.dataset.jack = `${c.id}-out`;
    card.append(row1, row2, metrics, jackL, jackR);
    focusClasses(card, c.id, related);
    return card;
  }
  function sparkSvg(values, maxVal, color) {
    if (!values?.length) return "";
    const w = 136, h = 22, max = Math.max(1, maxVal || 0);
    const pts = values.map((v, i) => `${((i / Math.max(1, values.length - 1)) * w).toFixed(1)},${(h - 2 - (Math.min(max, v) / max) * (h - 4)).toFixed(1)}`).join(" ");
    return `<svg class="k-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polygon points="0,${h} ${pts} ${w},${h}" fill="${color}" fill-opacity="0.14"></polygon><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"></polyline></svg>`;
  }
  function paintMetricsInto(metrics, c) {
    const s = state.stats.get(c.id); const h = state.history.get(c.id) || { cpu: [], mem: [] };
    metrics.replaceChildren();
    if (s && Number.isFinite(s.cpuPct)) {
      const wrap = el("span", null, `cpu ${s.cpuPct.toFixed(0)}% `);
      const track = el("span", "k-bar-track"); const fill = el("span", "k-bar-fill");
      fill.style.width = `${Math.min(100, s.cpuPct)}%`; fill.style.background = s.cpuPct > 80 ? "var(--k-red)" : s.cpuPct > 35 ? "var(--k-amber)" : "var(--k-green)";
      track.append(fill); wrap.append(track); metrics.append(wrap);
    }
    if (s && Number.isFinite(s.memUsed)) {
      const pct = s.memLimit ? Math.min(100, (s.memUsed / s.memLimit) * 100) : 0;
      const wrap = el("span", null, `mem ${fmtBytes(s.memUsed)} `);
      const track = el("span", "k-bar-track"); const fill = el("span", "k-bar-fill");
      fill.style.width = `${pct}%`; fill.style.background = "var(--k-accent)";
      track.append(fill); wrap.append(track); metrics.append(wrap);
    }
    const ports = (c.ports || []);
    if (ports.length) {
      const p = ports[0];
      metrics.append(el("span", `k-port-chip${p.hostPort ? "" : " k-dead"}`, p.hostPort ? `${p.hostIp || "0.0.0.0"}:${p.hostPort}→${p.containerPort}${p.proto ? `/${p.proto}` : ""}` : `→${p.containerPort} (not published)`));
    }
    void h;
  }
  function paintMetrics(ids) {
    for (const id of ids) { const host = stage.querySelector(`[data-metrics-for="${CSS.escape(id)}"]`); const c = findCtr(id); if (host && c) paintMetricsInto(host, c); }
  }
  function paintTelemetryInto(host, id) {
    const s = state.stats.get(id); const h = state.history.get(id) || { cpu: [], mem: [] };
    host.replaceChildren();
    const cpuBox = el("div", "k-tele-box"); cpuBox.append(el("div", "k-tele-label", "CPU Usage"), el("div", "k-tele-val", s ? `${s.cpuPct?.toFixed(1) ?? "—"}%` : "—"));
    cpuBox.insertAdjacentHTML("beforeend", sparkSvg(h.cpu, 100, (s?.cpuPct || 0) > 35 ? "#d29922" : "#3fb950"));
    const memBox = el("div", "k-tele-box"); memBox.append(el("div", "k-tele-label", "Memory"), el("div", "k-tele-val", s ? `${fmtBytes(s.memUsed)} / ${fmtBytes(s.memLimit)}` : "—"));
    memBox.insertAdjacentHTML("beforeend", sparkSvg(h.mem, s?.memLimit || 0, "#58a6ff"));
    host.append(cpuBox, memBox);
  }
  /** Repaint the inspector's two metric cards in place; the log box under them is left alone. */
  function paintTelemetry(id) {
    if (!id) return;
    const host = inspector.querySelector(`[data-tele-for="${CSS.escape(id)}"]`);
    if (host) paintTelemetryInto(host, id);
  }
  function buildWireCard(w, related) {
    const card = el("div", "k-card k-wire-card"); card.dataset.nodeId = w.id; card.dataset.kind = "wire";
    const iconCls = w.kind === "port" ? `k-port${w.listening === false ? " k-unbound" : ""}` : w.kind === "net" ? "k-net" : "k-vol";
    const icon = el("span", `k-wire-icon ${iconCls}`, w.kind === "port" ? "⇄" : w.kind === "net" ? "⌘" : "▦");
    const info = el("div", "k-wire-info");
    const title = wireLabel(w);
    const meta = w.kind === "port" ? `${w.listening ? "listening" : "not listening"} · ${(w.containerIds || []).length} container(s)`
      : w.kind === "net" ? `${w.driver || ""} · ${w.subnet || ""} · ${(w.containerIds || []).length} container(s)`
      : `${w.kind || ""} · ${w.destination || ""}${w.rw === false ? " · ro" : ""} · ${(w.containerIds || []).length} container(s)`;
    info.append(el("div", "k-wire-title", title), el("div", "k-wire-meta", meta));
    const jack = el("span", "k-jack k-jack-l"); jack.dataset.jack = `${w.id}-in`;
    card.append(icon, info, jack);
    focusClasses(card, w.id, related);
    return card;
  }
  function renderTopology() {
    const related = relatedSet(state.hovered?.id || state.selected?.id);
    const imgHost = $("kImages"); imgHost.replaceChildren();
    const active = images().filter((i) => !isUnusedImg(i) && matches(i, "image"));
    const unused = images().filter((i) => isUnusedImg(i) && matches(i, "image"));
    if (!active.length) imgHost.append(el("div", "k-empty", images().length ? "no images match" : "no images"));
    active.forEach((i) => imgHost.append(buildImageCard(i, related)));
    const tray = $("kUnusedTray"); tray.replaceChildren();
    tray.hidden = !unused.length;
    if (unused.length) {
      const head = el("div", "k-unused-head", `unused · ${fmtBytes(unused.reduce((a, i) => a + (i.sizeBytes || 0), 0))}`);
      const prune = el("button", "k-link-act", "prune"); prune.type = "button"; prune.onclick = () => openSheet("prune");
      head.append(prune); tray.append(head);
      unused.forEach((i) => tray.append(buildImageCard(i, related)));
    }
    const rt = $("kRuntime"); rt.replaceChildren();
    const visibleCtrs = containers().filter((c) => matches(c, "container"));
    if (!visibleCtrs.length) rt.append(el("div", "k-empty", containers().length ? "no containers match" : "no containers"));
    const byProject = new Map();
    for (const c of visibleCtrs) { const key = c.composeProject || ""; if (!byProject.has(key)) byProject.set(key, []); byProject.get(key).push(c); }
    for (const [project, list] of byProject) {
      if (!project) continue;
      const grp = el("div", "k-compose-group");
      const head = el("div", "k-compose-head");
      head.append(el("span", "k-compose-tag", "compose"), el("span", "k-compose-title", project));
      const acts = el("span", "k-mini-acts");
      const restart = el("button", "k-mini-btn", "restart"); restart.type = "button";
      restart.onclick = (e) => { e.stopPropagation(); postAction({ action: "compose.restart", project }, `compose ${project} restarted`).catch((err) => toast(err.message)); };
      const logs = el("button", "k-mini-btn", "logs ↗"); logs.type = "button";
      const sample = list[0];
      logs.onclick = (e) => { e.stopPropagation(); execToTerminal({ mode: "compose-logs", service: sample.composeService, composeFile: sample.composeWorkingDir ? `${sample.composeWorkingDir}/compose.yaml` : undefined, id: sample.id }); };
      acts.append(restart, logs); head.append(acts); grp.append(head);
      list.forEach((c) => grp.append(buildContainerCard(c, related)));
      rt.append(grp);
    }
    const solo = byProject.get("") || [];
    if (solo.length) {
      rt.append(el("div", "k-wire-subhead", "standalone containers"));
      solo.forEach((c) => rt.append(buildContainerCard(c, related)));
    }
    const wHost = $("kWiring"); wHost.replaceChildren();
    const groups = [["port", "host ports", wiring().ports || []], ["net", "networks", wiring().networks || []], ["vol", "volumes & mounts", wiring().volumes || []]];
    let anyWire = false;
    for (const [kind, label, list] of groups) {
      const items = list.map((n) => ({ ...n, kind })).filter((n) => matches(n, "wire"));
      if (!items.length) continue;
      anyWire = true;
      wHost.append(el("div", "k-wire-subhead", label));
      items.forEach((n) => wHost.append(buildWireCard(n, related)));
    }
    if (!anyWire) wHost.append(el("div", "k-empty", "no wiring"));
    requestAnimationFrame(drawWires);
  }

  /* ---------- wires ---------- */
  function pointOf(node) {
    const r = node.getBoundingClientRect(), s = stage.getBoundingClientRect();
    return { x: r.left - s.left + r.width / 2, y: r.top - s.top + r.height / 2 };
  }
  function drawWires() {
    rafPending = false;
    const w = stage.scrollWidth, h = stage.scrollHeight;
    wires.setAttribute("width", w); wires.setAttribute("height", h); wires.setAttribute("viewBox", `0 0 ${w} ${h}`);
    wires.replaceChildren();
    const related = relatedSet(state.hovered?.id || state.selected?.id);
    const mk = (p1, p2, stroke, width, cls) => {
      const dx = Math.max(40, Math.abs(p2.x - p1.x) * 0.48);
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} C ${(p1.x + dx).toFixed(1)} ${p1.y.toFixed(1)}, ${(p2.x - dx).toFixed(1)} ${p2.y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`);
      path.setAttribute("stroke", stroke); path.setAttribute("stroke-width", width); path.setAttribute("class", `k-wire-path ${cls}`);
      wires.append(path);
    };
    const jack = (id) => stage.querySelector(`[data-jack="${CSS.escape(id)}"]`);
    for (const c of containers()) {
      const ctrIn = jack(`${c.id}-in`), ctrOut = jack(`${c.id}-out`);
      if (!ctrIn || !ctrOut) continue;
      const img = imageOfCtr(c);
      const imgOut = img ? jack(`${img.id}-out`) : null;
      if (imgOut) {
        const hit = !related || (related.has(c.id) && related.has(img.id));
        let stroke = "#3fb950", anim = isRunning(c) ? "k-flow" : "";
        if (img.drift || c.staleImage) { stroke = "#d29922"; anim = "k-drift"; }
        else if (c.exitCode > 0 || c.oomKilled) { stroke = "#f85149"; anim = ""; }
        else if (!isRunning(c)) stroke = "#6e7681";
        mk(pointOf(imgOut), pointOf(ctrIn), stroke, hit && related ? "2.2" : "1.5", `${anim} ${related ? (hit ? "k-lit" : "k-dimmed") : ""}`);
      }
      for (const wid of ctrWires(c)) {
        const wIn = jack(`${wid}-in`); if (!wIn) continue;
        const hit = !related || (related.has(c.id) && related.has(wid));
        const w = wireNode(wid);
        let stroke = "#58a6ff", anim = "";
        if (c.exitCode > 0 || c.oomKilled) stroke = "#f85149";
        else if (!isRunning(c)) stroke = "#6e7681";
        else if (w?.kind === "port") { stroke = "#3fb950"; anim = "k-flow"; }
        else if (w?.kind === "vol") stroke = "#d2a8ff";
        else if (w?.kind === "net") { stroke = "#58a6ff"; anim = "k-flow"; }
        mk(pointOf(ctrOut), pointOf(wIn), stroke, hit && related ? "2.1" : "1.4", `${anim} ${related ? (hit ? "k-lit" : "k-dimmed") : ""}`);
      }
    }
  }
  function scheduleWires() { if (!rafPending) { rafPending = true; requestAnimationFrame(drawWires); } }
  function paintFocus() { renderTopology(); }
  viewport.addEventListener("scroll", scheduleWires, { passive: true });
  if (window.ResizeObserver) new ResizeObserver(scheduleWires).observe(stage);
  window.addEventListener("resize", scheduleWires);
  viewport.addEventListener("click", () => { if (state.selected) { state.selected = null; state.armedKill = null; render(); } });

  /* ---------- inspector ---------- */
  function kvRow(k, v) { const r = el("div", "k-kv-row"); r.append(el("span", "k-kv-k", k), el("span", "k-kv-v", v)); return r; }
  function actBtn(label, cls, fn) { const b = el("button", `k-act ${cls || ""}`, label); b.type = "button"; b.onclick = fn; return b; }
  function inspHead(kind, name, actions) {
    const head = el("div", "k-insp-head");
    const row = el("div", "k-insp-title-row");
    row.append(el("span", "k-insp-kind", kind), el("span", "k-insp-name", name));
    const close = el("button", "k-insp-close", "×"); close.type = "button"; close.title = "clear selection (esc)";
    close.onclick = () => { state.selected = null; render(); };
    row.append(close); head.append(row);
    if (actions?.length) { const a = el("div", "k-insp-actions"); a.append(...actions); head.append(a); }
    return head;
  }
  function tabs(names) {
    const t = el("div", "k-tabs");
    for (const n of names) { const b = el("button", `k-tab${state.tab === n ? " k-active" : ""}`, n); b.type = "button"; b.onclick = () => { state.tab = n; renderInspector(); }; t.append(b); }
    return t;
  }
  function renderInspector(refresh = false) {
    inspector.replaceChildren();
    if (!state.selected) { inspector.classList.add("k-collapsed"); scheduleWires(); return; }
    inspector.classList.remove("k-collapsed");
    const { kind, id } = state.selected;
    if (kind === "container") return renderContainerInspector(findCtr(id), refresh);
    if (kind === "image") return renderImageInspector(findImage(id), refresh);
    if (kind === "wire") return renderWireInspector(wireNode(id));
  }
  function renderContainerInspector(c, refresh) {
    if (!c) { state.selected = null; return renderInspector(false); }
    const running = isRunning(c); const armed = state.armedKill === c.id;
    const actions = [];
    actions.push(running
      ? actBtn("stop", "", () => postAction({ action: "stop", id: c.id }, `stopped ${c.name}`).catch((e) => toast(e.message)))
      : actBtn("start", "k-primary", () => postAction({ action: "start", id: c.id }, `started ${c.name}`).catch((e) => toast(e.message))));
    actions.push(actBtn("restart", "", () => postAction({ action: "restart", id: c.id }, `restarted ${c.name}`).catch((e) => toast(e.message))));
    if (running) actions.push(actBtn("exec ↗", "", () => execToTerminal({ mode: "exec", id: c.id })));
    const kill = actBtn(armed ? "confirm kill" : "kill", `k-danger${armed ? " k-armed" : ""}`, () => {
      if (!armed) { state.armedKill = c.id; renderInspector(false); setTimeout(() => { if (state.armedKill === c.id) { state.armedKill = null; renderInspector(false); } }, 3000); return; }
      state.armedKill = null; postAction({ action: "kill", id: c.id }, `killed ${c.name}`).catch((e) => toast(e.message));
    });
    actions.push(kill);
    actions.push(actBtn("remove", "k-danger", () => postAction({ action: "remove", id: c.id }, `removed ${c.name}`).catch((e) => toast(e.message))));
    inspector.append(inspHead("container", c.name || c.shortId || c.id, actions));
    if (c.staleImage) {
      const banner = el("div", "k-banner");
      banner.append(el("span", null, "this container runs an older image build than the current one"));
      const rec = actBtn("recreate on latest build", "", () => postAction({ action: "recreate", id: c.id }, `recreated ${c.name}`).catch((e) => toast(e.message)));
      banner.append(rec); inspector.append(banner);
    }
    inspector.append(tabs(["logs", "inspect", "layers"]));
    const body = el("div", "k-insp-body"); inspector.append(body);
    const tab = state.tab;
    if (tab === "logs") {
      const tele = el("div", "k-tele-strip"); tele.dataset.teleFor = c.id;
      paintTelemetryInto(tele, c.id); body.append(tele);
      const row = el("div", "k-row-between"); row.append(el("span", "k-kv-k", "live stdout / stderr"));
      const tail = el("button", "k-link-act", "tail in terminal (x) ↗"); tail.type = "button";
      tail.onclick = () => execToTerminal({ mode: "logs", id: c.id });
      row.append(tail); body.append(row);
    }
    const box = el("div", tab === "inspect" ? "k-json" : "k-log-box"); body.append(box);
    paintDetail(box, "container", c.id, tab, refresh);
  }
  function renderImageInspector(img, refresh) {
    if (!img) { state.selected = null; return renderInspector(false); }
    const label = `${img.repo || "<none>"}:${img.tag || "<none>"}`;
    const actions = [
      actBtn("pull", "", () => postAction({ action: "image.pull", image: label }, `pulling ${label}`).catch((e) => toast(e.message))),
      actBtn("push", "", () => postAction({ action: "image.push", image: label }, `pushing ${label}`).catch((e) => toast(e.message))),
      actBtn("remove", "k-danger", () => postAction({ action: "image.remove", id: img.id }, `removed ${label}`).catch((e) => toast(e.message))),
    ];
    inspector.append(inspHead("image", label, actions));
    inspector.append(tabs(["layers", "inspect"]));
    const body = el("div", "k-insp-body"); inspector.append(body);
    const tab = state.tab === "inspect" ? "inspect" : "layers";
    const box = el("div", tab === "inspect" ? "k-json" : "k-log-box"); body.append(box);
    paintDetail(box, "image", img.id, tab, refresh);
  }
  function renderWireInspector(w) {
    if (!w) { state.selected = null; return renderInspector(false); }
    const label = wireLabel(w);
    inspector.append(inspHead("wire", label, []));
    const body = el("div", "k-insp-body"); inspector.append(body);
    const list = el("div", "k-kv-list");
    if (w.kind === "port") { list.append(kvRow("listening", w.listening ? "yes" : "no"), kvRow("protocol", w.proto || "tcp")); }
    if (w.kind === "net") list.append(kvRow("driver", w.driver || "—"), kvRow("subnet", w.subnet || "—"));
    if (w.kind === "vol") list.append(kvRow("kind", w.kind || "—"), kvRow("source", w.source || "—"), kvRow("destination", w.destination || "—"), kvRow("read-only", w.rw === false ? "yes" : "no"));
    body.append(list);
    body.append(el("div", "k-wire-subhead", "attached containers"));
    const attached = containers().filter((c) => (w.containerIds || []).includes(c.id) || ctrWires(c).includes(w.id));
    if (!attached.length) body.append(el("div", "k-empty", "none attached"));
    for (const c of attached) {
      const b = el("button", "k-ctr-link", `${c.name || c.shortId} · ${c.statusText || c.state || ""}`); b.type = "button";
      b.onclick = () => { state.selected = { kind: "container", id: c.id }; state.tab = "logs"; render(); };
      body.append(b);
    }
  }
  const detailKey = (kind, id, tab) => `${kind}:${id}:${tab}`;
  /** The last detail an entry fetched, so a re-render can draw it again instead of an empty box. */
  function rememberDetail(kind, id, tab, data) {
    state.details.set(detailKey(kind, id, tab), data);
    if (state.details.size > 48) state.details.delete(state.details.keys().next().value);
  }
  function fillDetail(box, tab, data) {
    if (tab === "logs") return fillLogs(box, data.lines);
    if (tab === "inspect") return fillJson(box, data.inspect ?? data);
    return fillLayers(box, data.layers ?? data);
  }
  /** Draw the cached detail at once, and fetch it when there is none to draw (or a refresh was asked). */
  function paintDetail(box, kind, id, tab, refresh) {
    const cached = state.details.get(detailKey(kind, id, tab));
    if (cached !== undefined) fillDetail(box, tab, cached);
    else box.textContent = "loading…";
    if (cached === undefined || refresh) fetchDetail(kind, id, tab, box);
  }
  async function fetchDetail(kind, id, tab, box) {
    try {
      const data = await apiText(`/kontainer/detail?workspace=${encodeURIComponent(workspace || "")}&runtime=${encodeURIComponent(state.runtime || "")}&kind=${kind}&id=${encodeURIComponent(id)}&tab=${tab}&tail=200`);
      if (state.selected?.id !== id) return;
      rememberDetail(kind, id, tab, data);
      fillDetail(box, tab, data);
    } catch (e) { toast(`detail: ${e.message}`); }
  }
  function logLineText(l) {
    if (typeof l === "string") return l;
    if (l && typeof l === "object") return String(l.text ?? l.message ?? l.line ?? JSON.stringify(l));
    return String(l ?? "");
  }
  function fillLogs(box, lines) {
    box.replaceChildren();
    const arr = Array.isArray(lines) ? lines : String(lines ?? "").split("\n");
    if (!arr.length) { box.textContent = "no log output"; return; }
    for (const l of arr.slice(-200)) {
      const div = el("div", "k-log-line");
      const text = logLineText(l);
      const m = text.match(/^(\S+\s+)?\[(info|warn|error|debug)\]\s*/i);
      if (m) { div.append(el("span", "k-log-ts", m[1] || ""), el("span", `k-log-${m[2].toLowerCase() === "error" ? "err" : m[2].toLowerCase() === "warn" ? "warn" : "info"}`, `[${m[2].toUpperCase()}] `), document.createTextNode(text.slice(m[0].length))); }
      else div.textContent = text;
      box.append(div);
    }
    box.scrollTop = box.scrollHeight;
  }
  function fillJson(box, value) { box.className = "k-json"; box.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2); }
  function fillLayers(box, layers) {
    box.replaceChildren();
    const arr = Array.isArray(layers) ? layers : layers?.layers || layers?.history || [];
    if (!arr.length) { box.textContent = typeof layers === "string" ? layers : "no layer data"; return; }
    for (const l of arr) {
      const div = el("div", "k-log-line");
      if (l && typeof l === "object") div.textContent = [l.size != null ? fmtBytes(l.size) : null, l.command || l.createdBy || l.id || l.diffId || ""].filter(Boolean).join("  ") || JSON.stringify(l);
      else div.textContent = String(l);
      box.append(div);
    }
  }

  /* ---------- terminal handoff ---------- */
  async function execToTerminal(payload) {
    try {
      const data = await postAction({ action: "exec.cmd", ...payload }, null);
      // Only the command the server built and validated is run; a failure never becomes one made up here.
      const cmd = data?.command;
      if (typeof cmd !== "string" || !cmd) { toast("kontainer: the server returned no command to run"); return; }
      if (typeof openTerminalCommand === "function") openTerminalCommand(cmd);
      else toast(cmd);
    } catch (e) { toast(e.message); }
  }

  /* ---------- sheets & tools ---------- */
  function openSheet(tool, preset) {
    toolsMenu.hidden = true; toolsBtn.setAttribute("aria-expanded", "false");
    const title = $("kSheetTitle"), body = $("kSheetBody"), foot = $("kSheetFoot");
    body.replaceChildren(); foot.replaceChildren();
    const close = () => { sheet.hidden = true; };
    const cancel = actBtn("cancel", "", close);
    const out = el("div", "k-log-box k-out", ""); out.hidden = true;
    const finish = (primary, fn) => { foot.append(cancel, actBtn(primary, "k-primary", async () => { try { out.hidden = false; out.textContent = "working…"; const r = await fn(); if (r != null) out.textContent = typeof r === "string" ? r : JSON.stringify(r, null, 2); } catch (e) { out.hidden = false; out.classList.add("k-err"); out.textContent = e.message; } })); };
    const field = (label, id, value, list) => {
      const wrap = el("div"); wrap.append(el("label", "k-field-label", label));
      const input = el("input", "k-field"); input.id = id; input.value = value ?? "";
      if (list) { input.setAttribute("list", list); }
      wrap.append(input); body.append(wrap); return input;
    };
    const check = (label, id, on) => {
      const wrap = el("label", "k-check"); const input = el("input"); input.type = "checkbox"; input.id = id; input.checked = !!on;
      wrap.append(input, document.createTextNode(label)); body.append(wrap); return input;
    };
    if (tool === "build") {
      title.textContent = "build Dockerfile";
      const files = [...(state.data?.dockerfiles || []), ...(state.data?.composeFiles || [])];
      const df = field("Dockerfile", "kBuildFile", preset || files[0] || "./Dockerfile");
      if (files.length > 1) { const dl = el("datalist"); dl.id = "kFiles"; files.forEach((f) => { const o = el("option"); o.value = f; dl.append(o); }); body.append(dl); df.setAttribute("list", "kFiles"); }
      const tag = field("Image tag", "kBuildTag", preset && preset.includes(":") ? preset : "");
      const noCache = check("no cache", "kBuildNoCache", false);
      body.append(out);
      finish("build image", () => postAction({ action: "build", dockerfile: df.value.trim(), tag: tag.value.trim() || undefined, noCache: noCache.checked }, `built ${tag.value || "image"}`));
    } else if (tool === "registry") {
      title.textContent = "registry · search, pull, push, login";
      const q = field("Image reference or search term", "kRegQuery", preset || "");
      const loginServer = field("Registry server (login)", "kLoginServer", "");
      const loginUser = field("Username", "kLoginUser", "");
      const loginPass = field("Password", "kLoginPass", ""); loginPass.type = "password";
      body.append(out);
      foot.append(cancel,
        actBtn("search", "", async () => { try { out.hidden = false; const r = await postAction({ action: "image.search", term: q.value.trim() }, "search done"); out.textContent = JSON.stringify(r, null, 2); } catch (e) { out.hidden = false; out.classList.add("k-err"); out.textContent = e.message; } }),
        actBtn("pull", "", async () => { try { out.hidden = false; await postAction({ action: "image.pull", image: q.value.trim() }, `pulled ${q.value}`); } catch (e) { out.hidden = false; out.classList.add("k-err"); out.textContent = e.message; } }),
        actBtn("push", "", async () => { try { out.hidden = false; await postAction({ action: "image.push", image: q.value.trim() }, `pushed ${q.value}`); } catch (e) { out.hidden = false; out.classList.add("k-err"); out.textContent = e.message; } }),
        actBtn("login", "k-primary", async () => { try { out.hidden = false; await postAction({ action: "registry.login", server: loginServer.value.trim(), username: loginUser.value.trim(), password: loginPass.value }, "logged in"); } catch (e) { out.hidden = false; out.classList.add("k-err"); out.textContent = e.message; } }));
    } else if (tool === "prune") {
      title.textContent = "housekeeping · prune unused";
      const unused = images().filter(isUnusedImg);
      const note = el("div", null, unused.length ? `Reclaim ${fmtBytes(unused.reduce((a, i) => a + (i.sizeBytes || 0), 0))} from ${unused.length} unused image(s). Running containers are never touched.` : "Nothing to prune — workspace is clean.");
      note.style.color = "var(--k-muted)"; body.append(note);
      const list = el("div", "k-kv-list");
      unused.forEach((i) => list.append(kvRow(`${fmtBytes(i.sizeBytes)} · ${fmtDate(i.created)}`, `${i.repo || "<none>"}:${i.tag || "<none>"} (${i.shortId || i.id})`)));
      body.append(list, out);
      finish(`prune ${unused.length} image(s)`, () => postAction({ action: "prune", target: "images" }, "pruned unused images"));
    } else if (tool === "df") {
      title.textContent = "system df";
      body.append(out);
      const done = actBtn("done", "k-primary", close); foot.append(done);
      apiText(`/kontainer/df?workspace=${encodeURIComponent(workspace || "")}&runtime=${encodeURIComponent(state.runtime || "")}`)
        .then((d) => { out.hidden = false; out.textContent = typeof d.df === "string" ? d.df : JSON.stringify(d.df ?? d, null, 2); })
        .catch((e) => { out.hidden = false; out.classList.add("k-err"); out.textContent = e.message; });
    }
    sheet.hidden = false;
    body.querySelector("input")?.focus();
  }
  $("kSheetClose").onclick = () => { sheet.hidden = true; };
  sheet.addEventListener("click", (e) => { if (e.target === sheet) sheet.hidden = true; });

  function buildToolsMenu() {
    toolsMenu.replaceChildren();
    const section = (label) => toolsMenu.append(el("div", "k-tm-section", label));
    const sep = () => toolsMenu.append(el("div", "k-tm-sep"));
    const item = (label, hint, fn, danger) => { const b = el("button", danger ? "k-danger-item" : "", ""); b.type = "button"; b.append(el("span", null, label), el("span", "k-tm-hint", hint || "")); b.onclick = fn; toolsMenu.append(b); };
    section(`Compose${state.data?.workspaceFolder ? ` · ${state.data.workspaceFolder}` : ""}`);
    item("compose up -d", "start stack", () => { toolsMenu.hidden = true; postAction({ action: "compose.up" }, "compose up").catch((e) => toast(e.message)); });
    item("compose restart", "restart stack", () => { toolsMenu.hidden = true; postAction({ action: "compose.restart" }, "compose restarted").catch((e) => toast(e.message)); });
    item("compose down", "stop stack", () => { toolsMenu.hidden = true; postAction({ action: "compose.down" }, "compose down").catch((e) => toast(e.message)); });
    item("compose logs -f", "terminal x", () => { toolsMenu.hidden = true; execToTerminal({ mode: "compose-logs" }); });
    sep(); section("Build & Registry");
    item("build Dockerfile…", "b", () => openSheet("build"));
    item("pull / push / search…", "r", () => openSheet("registry"));
    item("registry login…", "", () => openSheet("registry"));
    sep(); section("Housekeeping");
    item("prune unused images", fmtBytes(images().filter(isUnusedImg).reduce((a, i) => a + (i.sizeBytes || 0), 0)), () => openSheet("prune"), true);
    item("disk usage (system df)", "", () => openSheet("df"));
  }
  toolsBtn.onclick = (e) => { e.stopPropagation(); buildToolsMenu(); const opening = toolsMenu.hidden; toolsMenu.hidden = !opening; toolsBtn.setAttribute("aria-expanded", String(opening)); };
  document.addEventListener("click", (e) => { if (!toolsMenu.hidden && !toolsMenu.contains(e.target) && e.target !== toolsBtn) { toolsMenu.hidden = true; toolsBtn.setAttribute("aria-expanded", "false"); } });

  /* ---------- search / commands ---------- */
  searchInput.addEventListener("input", () => { state.search = searchInput.value; renderTopology(); });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const raw = searchInput.value.trim();
    if (!raw.startsWith(">")) return;
    e.preventDefault();
    const cmd = raw.slice(1).trim();
    searchInput.value = ""; state.search = "";
    runCommand(cmd); renderTopology();
  });
  function runCommand(cmd) {
    const [verb, ...rest] = cmd.split(/\s+/); const arg = rest.join(" ");
    if (verb === "build") return openSheet("build", arg || undefined);
    if (verb === "prune") return openSheet("prune");
    if (verb === "pull") return openSheet("registry", arg || undefined);
    if (verb === "push") return openSheet("registry", arg || undefined);
    if (verb === "search" || verb === "reg") return openSheet("registry", arg || undefined);
    if (verb === "login") return openSheet("registry");
    if (verb === "df") return openSheet("df");
    if (verb === "up") return postAction({ action: "compose.up" }, "compose up").catch((e) => toast(e.message));
    if (verb === "down") return postAction({ action: "compose.down" }, "compose down").catch((e) => toast(e.message));
    if (verb === "restart") return postAction({ action: "compose.restart" }, "compose restarted").catch((e) => toast(e.message));
    if (verb === "logs") return execToTerminal({ mode: "compose-logs" });
    toast(`unknown command: ${cmd} (try build, prune, pull, up, down, login)`);
  }

  /* ---------- live connections ---------- */
  function stopLive() {
    liveOn = false;
    try { es?.close(); } catch {} es = null;
    clearInterval(statsTimer); clearInterval(logsTimer); statsTimer = logsTimer = null;
    clearTimeout(debounceTimer); debounceTimer = null;
  }
  function startLive() {
    stopLive();
    if (!workspace || document.hidden) return;
    liveOn = true;
    try {
      es = new EventSource(`/kontainer/events?workspace=${encodeURIComponent(workspace)}&runtime=${encodeURIComponent(state.runtime || "")}`);
      es.addEventListener("change", () => { clearTimeout(debounceTimer); debounceTimer = setTimeout(loadState, 350); });
      es.onerror = () => {};
    } catch {}
    const pollStats = () => { const ids = containers().filter(isRunning).map((c) => c.id); if (ids.length) fetchStats(ids); else if (state.mode === "eco" && state.selected?.kind === "container") fetchStats([state.selected.id]); };
    if (state.mode === "balanced") statsTimer = setInterval(pollStats, 3000);
    if (state.mode === "live") {
      statsTimer = setInterval(pollStats, 1000);
      logsTimer = setInterval(() => { if (state.selected?.kind === "container" && state.tab === "logs") renderInspector(true); }, 2000);
    }
    pollStats();
  }
  $("kMode").onchange = () => { state.mode = $("kMode").value; store.set("kontainer.mode", state.mode); if (liveOn) startLive(); };
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopLive(); else if (sliding.isOpen()) { loadState(); startLive(); } });

  /* ---------- drawer shell ---------- */
  function setName(name) { $("kWs").textContent = workspace ? `· ${name || workspace}` : ""; }
  setName("");
  const sliding = createSlidingDrawer({
    drawer, btn, bodyClass: "kontainer-open",
    openTitle: "roll kontainer up (k)", shutTitle: "roll kontainer down (k)",
    beforeOpen() { scrim.hidden = false; },
    // The state arrives before the cadence starts, so the first stats read finds the containers and the
    // telemetry is there as the drawer lands instead of three seconds later.
    async afterOpen() { await loadState(); if (!sliding.isOpen()) return; startLive(); scheduleWires(); },
    afterClose() { scrim.hidden = true; stopLive(); },
  });
  scrim.addEventListener("click", () => sliding.close());
  $("kRollUp").onclick = () => sliding.close();

  function handleEscape() {
    if (!sliding.isOpen()) return false;
    if (!sheet.hidden) { sheet.hidden = true; return true; }
    if (!toolsMenu.hidden) { toolsMenu.hidden = true; toolsBtn.setAttribute("aria-expanded", "false"); return true; }
    if (document.activeElement === searchInput) { searchInput.blur(); return true; }
    if (state.selected) { state.selected = null; state.armedKill = null; render(); return true; }
    sliding.close(); return true;
  }
  window.addEventListener("keydown", (event) => {
    if (!sliding.isOpen()) return;
    if (event.key === "Escape" && handleEscape()) { event.preventDefault(); event.stopPropagation(); return; }
    if (event.key === "/" && !typingSomewhere()) { event.preventDefault(); searchInput.focus(); }
  }, true);

  function render() { renderBar(); renderTopology(); renderInspector(false); }

  return { isOpen: sliding.isOpen, toggle: sliding.toggle, open: sliding.open, close: sliding.close, setName, handleEscape };
}

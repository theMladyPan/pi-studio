"use strict";
/**
 * The crossroads: what workspaces exist, what is in the selected one, and a button that opens its
 * board in a tab of its own. It never becomes the board — a workspace is a page, not a state.
 */
(() => {
  const token = new URLSearchParams(location.search).get("token") || "";
  const qs = () => `token=${encodeURIComponent(token)}`;

  const nodes = {
    newWorkspace: document.getElementById("newWorkspace"),
    newForm: document.getElementById("newForm"),
    folder: document.getElementById("folder"),
    newError: document.getElementById("newError"),
    list: document.getElementById("wsList"),
    empty: document.getElementById("wsEmpty"),
    recentHead: document.getElementById("recentHead"),
    name: document.getElementById("wsName"),
    path: document.getElementById("wsPath"),
    hint: document.getElementById("previewHint"),
    body: document.getElementById("previewBody"),
    threads: document.getElementById("threads"),
    lastActivity: document.getElementById("lastActivity"),
    open: document.getElementById("open"),
    openHint: document.getElementById("openHint"),
    facts: document.getElementById("facts"),
    agent: document.getElementById("agent"),
    state: document.getElementById("state"),
  };

  /** @type {any[]} */
  let workspaces = [];
  let selected = null;

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function when(ms) {
    if (!ms) return "";
    const seconds = Math.round((Date.now() - ms) / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    return `${Math.round(hours / 24)} d ago`;
  }

  function bytes(size) {
    if (!size) return "0 B";
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${Math.round(size / 1024)} kB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

  /** The tab a workspace belongs to. Named, so opening it twice focuses the tab you already have. */
  function openBoard(threadId) {
    if (!selected) return;
    const url = `/w/${selected.id}?${qs()}${threadId ? `&thread=${encodeURIComponent(threadId)}` : ""}`;
    const tab = window.open(url, `pi-studio-${selected.id}`);
    // A tab that already carries this name is only focused, not reloaded, so a board left open from
    // an older build would keep its stale client. Navigating it again costs one reload and means the
    // tab always runs the code the daemon is serving now.
    if (tab) tab.location.replace(url);
  }

  function fill(node, rows) {
    node.replaceChildren();
    for (const [label, value, cls] of rows) {
      node.append(el("dt", "", label));
      node.append(el("dd", cls || "", value));
    }
  }

  function paintList() {
    nodes.list.replaceChildren();
    nodes.empty.hidden = workspaces.length > 0;
    nodes.recentHead.hidden = workspaces.length === 0;
    for (const workspace of workspaces) {
      const row = el("li");
      row.tabIndex = 0;
      row.setAttribute("role", "option");
      row.dataset.id = workspace.id;
      row.setAttribute("aria-selected", String(selected?.id === workspace.id));
      const name = el("div", "name");
      const dot = el("span", `dot ${workspace.running ? "running" : workspace.threadCount ? "idle" : ""}`);
      name.append(dot, el("span", "", workspace.name));
      const sub = el("div", "sub");
      if (workspace.missing) sub.append(el("span", "missing", "folder missing"));
      else sub.textContent = `${workspace.threadCount} thread${workspace.threadCount === 1 ? "" : "s"}${workspace.running ? ` · ${workspace.running} running` : ""}`;
      row.append(name, sub);
      row.addEventListener("click", () => select(workspace.id));
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          select(workspace.id);
          openBoard();
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const at = workspaces.findIndex((candidate) => candidate.id === workspace.id);
          const next = workspaces[at + (event.key === "ArrowDown" ? 1 : -1)];
          if (next) {
            select(next.id);
            nodes.list.querySelector(`li[data-id="${next.id}"]`)?.focus();
          }
        }
      });
      nodes.list.append(row);
    }
  }

  function paintPreview() {
    if (!selected) {
      nodes.name.textContent = "pi-studio";
      nodes.path.textContent = "";
      nodes.hint.hidden = false;
      nodes.body.hidden = true;
      nodes.open.disabled = true;
      nodes.openHint.textContent = "opens in a new tab, and reuses it next time";
      fill(nodes.facts, []);
      fill(nodes.agent, []);
      fill(nodes.state, []);
      return;
    }
    nodes.name.textContent = selected.name;
    nodes.path.textContent = selected.folder;
    nodes.hint.hidden = true;
    nodes.body.hidden = false;
    nodes.open.disabled = Boolean(selected.missing);
    nodes.openHint.textContent = selected.missing
      ? "that folder no longer exists"
      : "opens in a new tab, and reuses it next time";

    nodes.threads.replaceChildren();
    for (const thread of selected.threads || []) {
      const row = el("li");
      row.tabIndex = 0;
      row.append(el("span", `dot ${thread.status === "running" ? "running" : "idle"}`));
      row.append(el("span", "t", thread.title));
      row.append(el("span", "when", `${thread.turns} · ${when(thread.last)}`));
      row.addEventListener("click", () => openBoard(thread.id));
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openBoard(thread.id);
        }
      });
      nodes.threads.append(row);
    }
    if (!(selected.threads || []).length) nodes.threads.append(el("li", "hint", "no threads yet — + starts one on the board"));
    nodes.lastActivity.textContent = selected.lastActivity
      ? `last activity: ${selected.lastActivity.label} · ${when(selected.lastActivity.at)}`
      : "";

    fill(nodes.facts, [
      ["branch", selected.git?.branch ?? "—", selected.git ? "" : ""],
      ["changes", selected.git ? `${selected.git.modified} modified` : "not a repo", selected.git?.modified ? "warn" : ""],
      ["threads", String(selected.threadCount), selected.running ? "warn" : ""],
      ["sessions", `${selected.sessions?.count ?? 0} · ${bytes(selected.sessions?.bytes ?? 0)}`],
    ]);
    fill(nodes.agent, [
      ["provider", "klotilda"],
      ["model", "DeepSeek-V4.1-Flash"],
      ["tools", "read,bash,edit,write"],
    ]);
    fill(nodes.state, [
      ["opened", when(selected.openedAt)],
      ["folder", selected.missing ? "missing" : "ok", selected.missing ? "bad" : "good"],
    ]);
  }

  function select(id) {
    selected = workspaces.find((workspace) => workspace.id === id) || null;
    paintList();
    paintPreview();
  }

  function adopt(list) {
    const keep = selected?.id;
    workspaces = Array.isArray(list) ? list : [];
    // A count changing must not move the human's selection, so the id survives the repaint.
    selected = workspaces.find((workspace) => workspace.id === keep) || workspaces[0] || null;
    paintList();
    paintPreview();
  }

  async function load() {
    try {
      const response = await fetch(`/workspaces?${qs()}`);
      if (!response.ok) throw new Error((await response.text()).slice(0, 80) || response.statusText);
      const data = await response.json();
      adopt(data.workspaces);
    } catch (error) {
      nodes.newError.textContent = `could not read workspaces: ${error.message || error}`;
    }
  }

  async function openFolder(folder) {
    nodes.newError.textContent = "";
    try {
      const response = await fetch(`/workspace?${qs()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder }),
      });
      if (!response.ok) throw new Error((await response.text()).slice(0, 140) || response.statusText);
      const data = await response.json();
      await load();
      select(data.workspace.id);
      hideNewForm();
      openBoard();
    } catch (error) {
      nodes.newError.textContent = error.message || String(error);
    }
  }

  function showNewForm() {
    nodes.newForm.hidden = false;
    nodes.newWorkspace.hidden = true;
    nodes.folder.focus();
  }

  function hideNewForm() {
    nodes.newForm.hidden = true;
    nodes.newWorkspace.hidden = false;
    nodes.folder.value = "";
    nodes.newError.textContent = "";
  }

  nodes.newWorkspace.addEventListener("click", showNewForm);
  document.getElementById("cancelNew").addEventListener("click", hideNewForm);
  document.getElementById("browse").addEventListener("click", async () => {
    nodes.newError.textContent = "";
    try {
      // A browser cannot hand us an absolute path, so the daemon asks the machine's own dialog.
      const response = await fetch(`/pick-folder?${qs()}`, { method: "POST" });
      if (!response.ok) throw new Error((await response.text()).slice(0, 120) || response.statusText);
      const data = await response.json();
      if (data.cancelled) return;
      nodes.folder.value = data.folder;
      nodes.folder.focus();
    } catch (error) {
      nodes.newError.textContent = `no folder dialog: ${error.message || error} — type the path instead`;
      nodes.folder.focus();
    }
  });

  nodes.newForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const folder = nodes.folder.value.trim();
    if (folder) void openFolder(folder);
  });

  nodes.open.addEventListener("click", () => openBoard());

  document.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !nodes.newForm.hidden) return; // the form owns Enter
    if (event.key === "Enter" && selected && document.activeElement === document.body) openBoard();
  });

  if (!token) {
    nodes.newError.textContent = "this page was opened without a token — use the URL pi-studio printed";
    return;
  }

  void load();

  // Counts on this page are live: a thread that starts or settles elsewhere shows up here.
  const stream = new EventSource(`/events?scope=welcome&${qs()}`);
  stream.onmessage = (message) => {
    try {
      const payload = JSON.parse(message.data);
      if (payload.type === "workspaces") adopt(payload.workspaces);
    } catch {
      // A frame that is not JSON is not worth breaking the page over.
    }
  };
})();

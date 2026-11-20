(function () {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = MD.esc;
  const main = $("#main");
  const PRIOS = ["blocking", "soon", "whenever"];
  // Inbox status tabs -> API status filter. "active" (= not closed) is reached from the
  // Projects page and only shown as a tab while selected.
  const TABS = { open: "open", answered: "answered", requests: "requested,in_progress", closed: "closed,done", all: "all" };
  const HIDDEN_TABS = { active: "open,answered,requested,in_progress" };
  const statusQuery = (s) => TABS[s] || HIDDEN_TABS[s] || "open";
  const store = {
    get(k, d) { try { const v = localStorage.getItem("rd." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("rd." + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
    del(k) { try { localStorage.removeItem("rd." + k); } catch (e) { /* ignore */ } },
  };
  let state = { view: null, list: [], cursor: 0, item: null, refreshTimer: null };

  // ---------------------------------------------------------------- utils
  async function api(path, opts = {}) {
    const o = Object.assign({ headers: {} }, opts);
    if (o.json !== undefined) {
      o.body = JSON.stringify(o.json);
      o.headers["Content-Type"] = "application/json";
      delete o.json;
    }
    const r = await fetch(path, o);
    let data = null;
    try { data = await r.json(); } catch (e) { /* non-JSON */ }
    if (!r.ok) throw new Error((data && data.error) || r.status + " " + r.statusText);
    return data;
  }
  function when(iso) {
    if (!iso) return "";
    const d = new Date(iso), now = Date.now(), s = (now - d) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    if (s < 86400 * 7) return Math.floor(s / 86400) + "d ago";
    return d.toLocaleDateString();
  }
  const abs = (iso) => (iso ? new Date(iso).toLocaleString() : "");
  const timeEl = (iso) => '<time datetime="' + esc(iso) + '" title="' + esc(abs(iso)) + '">' + esc(when(iso)) + "</time>";
  function toast(msg, kind = "ok") {
    const t = $("#toast");
    t.textContent = msg;
    t.className = "show " + kind;
    clearTimeout(t._h);
    t._h = setTimeout(() => (t.className = ""), 4000);
  }
  function fmtSize(n) {
    if (n == null) return "";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }
  const badge = (cls, text) => '<span class="badge ' + cls + '">' + esc(text) + "</span>";
  const prioBadge = (p) => badge("p-" + p, p);
  const statusLabel = (s) => (s === "in_progress" ? "in progress" : s);
  const statusBadge = (s) => badge("s-" + s, statusLabel(s));
  const kindBadge = (it) => (it.kind === "workstream" ? badge("k-ws", "request") : it.kind === "todo" ? badge("k-todo", "to do") : "");
  function dueBadge(it) {
    if (!it.due) return "";
    const today = new Date().toISOString().slice(0, 10);
    const d = new Date(it.due + "T12:00:00");
    const label = "due " + d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const late = it.status === "open" && it.due < today;
    return '<span class="badge due' + (late ? " overdue" : it.due === today ? " today" : "") + '" title="' + esc("Due " + it.due + (late ? " (overdue)" : "")) + '">' + esc(late ? "overdue · " + label.slice(4) : label) + "</span>";
  }
  const dref = (id) => "D-" + id;
  function blockedBadge(ids, asLink) {
    if (!ids || !ids.length) return "";
    const text = "Blocked by " + dref(ids[0]) + (ids.length > 1 ? " +" + (ids.length - 1) : "");
    const title = "Waiting on " + ids.map(dref).join(", ");
    if (asLink) return '<a class="badge blocked" href="/item/' + ids[0] + '" data-nav title="' + esc(title) + '">' + esc(text) + "</a>";
    return '<span class="badge blocked" title="' + esc(title) + '">' + esc(text) + "</span>";
  }
  function linkHost(u) { try { return new URL(u).host; } catch (e) { return ""; } }
  function parseIds(s) {
    const ids = [], bad = [];
    for (const tok of String(s || "").split(/[\s,]+/).filter(Boolean)) {
      const m = tok.match(/^(?:D-?|#)?(\d{1,9})$/i);
      if (m) ids.push(+m[1]); else bad.push(tok);
    }
    return { ids: [...new Set(ids)], bad };
  }

  // Reference-linking config from /api/config (see README "References").
  const CFG = { pr_url_base: "", repo: "", commits: false, issue_prefixes: [] };
  function refHint() {
    const parts = ["<code>D-76</code> for desk items"];
    if (CFG.pr_url_base) parts.push("<code>#123</code> for PRs");
    if (CFG.issue_prefixes && CFG.issue_prefixes.length) parts.push("<code>" + esc(CFG.issue_prefixes[0]) + "-12</code> for issues");
    return "Write " + parts.join(", ") + "; they become links.";
  }

  // ------------------------------------------------------------- composer
  // Files for one message box: pasted (Ctrl/Cmd+V), dropped, or picked with the
  // fallback button. They are previewed as chips and uploaded WITH the message
  // when it is sent (so nothing is orphaned if the owner removes one or leaves).
  const MSG_MAX = 25 * 1024 * 1024, MSG_MAX_FILES = 20;
  let pasteSeq = 0;
  const isImage = (f) => /^image\//.test(f.type || "");
  const hasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
  function renamePasted(f) {
    // clipboard images arrive as "image.png"; give them a useful, unique name
    const ext = ((f.type.split("/")[1] || "png").replace("jpeg", "jpg").replace(/\+.*$/, "")).replace(/[^a-z0-9]/gi, "") || "png";
    const d = new Date(), pad = (n) => String(n).padStart(2, "0");
    const name = "pasted-" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + "-" + ++pasteSeq + "." + ext;
    try { return new File([f], name, { type: f.type }); } catch (e) { return f; }
  }
  function composer(ta, opts = {}) {
    const imagesOnly = !!opts.imagesOnly;
    const items = [];
    const tray = document.createElement("div");
    tray.className = "ctray";
    tray.hidden = true;
    ta.insertAdjacentElement("afterend", tray);
    if (opts.pickHost) {
      const lab = document.createElement("label");
      lab.className = "cpick";
      lab.innerHTML = '<input type="file" multiple' + (imagesOnly ? ' accept="image/*"' : "") + "><span>" + esc(opts.pickLabel || "Add image") + "</span>";
      const input = lab.querySelector("input");
      input.onchange = () => { add(Array.from(input.files)); input.value = ""; };
      opts.pickHost.replaceChildren(lab);
    }
    function render() {
      tray.hidden = !items.length;
      tray.innerHTML = items.map((x, i) => '<span class="cchip">' +
        (x.url ? '<img src="' + x.url + '" alt="">' : '<span class="cfile">file</span>') +
        '<span class="cname">' + esc(x.file.name) + '<span class="muted"> ' + fmtSize(x.file.size) + "</span></span>" +
        '<button type="button" class="cx" data-i="' + i + '" aria-label="Remove ' + esc(x.file.name) + '" title="Remove">×</button></span>').join("");
      $$(".cx", tray).forEach((b) => (b.onclick = () => {
        const [x] = items.splice(+b.dataset.i, 1);
        if (x && x.url) URL.revokeObjectURL(x.url);
        render();
        ta.focus();
      }));
    }
    function add(list) {
      let n = 0;
      for (let f of list) {
        if (imagesOnly && !isImage(f)) { toast(f.name + " is not an image", "err"); continue; }
        if (items.length >= MSG_MAX_FILES) { toast("At most " + MSG_MAX_FILES + " files per message", "err"); break; }
        const total = items.reduce((a, x) => a + x.file.size, 0) + f.size;
        if (total > MSG_MAX) { toast((f.name || "Image") + " is too big: one message can carry 25 MB (this would be " + fmtSize(total) + ")", "err"); continue; }
        if (isImage(f) && (!f.name || /^image\.\w+$/.test(f.name))) f = renamePasted(f);
        items.push({ file: f, url: isImage(f) ? URL.createObjectURL(f) : null });
        n++;
      }
      if (n) render();
      return n;
    }
    ta.addEventListener("paste", (e) => {
      const dt = e.clipboardData;
      if (!dt) return;
      let got = [];
      for (const it of Array.from(dt.items || [])) if (it.kind === "file") { const f = it.getAsFile(); if (f) got.push(f); }
      if (!got.length && dt.files) got = Array.from(dt.files);
      const imgs = got.filter(isImage);
      if (!imgs.length) return;            // plain text paste: leave it alone
      if (!dt.getData("text/plain")) e.preventDefault();
      if (add(imgs)) toast(imgs.length > 1 ? imgs.length + " images added" : "Image added");
    });
    ["dragenter", "dragover"].forEach((t) => ta.addEventListener(t, (e) => { if (hasFiles(e)) { e.preventDefault(); ta.classList.add("dropping"); } }));
    ["dragleave", "drop"].forEach((t) => ta.addEventListener(t, () => ta.classList.remove("dropping")));
    ta.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      add(Array.from(e.dataTransfer.files));
    });
    return {
      files: () => items.map((x) => x.file),
      clear() { items.forEach((x) => x.url && URL.revokeObjectURL(x.url)); items.length = 0; render(); },
      add,
    };
  }

  function go(path, replace) {
    if (replace) history.replaceState({}, "", path); else history.pushState({}, "", path);
    route();
  }
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-nav]");
    if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
      e.preventDefault();
      go(a.getAttribute("href"));
    }
  });
  window.addEventListener("popstate", route);

  function setNav(which) {
    $$(".topnav a").forEach((a) => a.classList.toggle("on", a.dataset.view === which));
  }

  function route() {
    clearInterval(state.refreshTimer);
    if (window.Viewer) Viewer.close();
    if (state.view === "queue") flushPending();
    window.scrollTo(0, 0);
    const p = location.pathname;
    refreshQueueCount();
    let m;
    if (p === "/queue") { setNav("queue"); return showQueue(); }
    if (p === "/todo") { setNav("todo"); return showTodos(); }
    if ((m = p.match(/^\/item\/(\d+)$/))) { setNav(""); return showItem(+m[1]); }
    if (p === "/projects") { setNav("projects"); return showProjects(); }
    if (p === "/new") { setNav("new"); return showNew(); }
    if ((m = p.match(/^\/ref\/(pr|commit|issue)\/([A-Za-z0-9-]+)$/))) { setNav(""); return showRef(m[1], m[2]); }
    setNav("inbox");
    // Deep links from the Projects page: /?project=docs&status=open
    const q = new URLSearchParams(location.search);
    if (q.has("project") || q.has("status")) {
      filt.tag = q.get("project") || "";
      if (q.get("status")) filt.status = q.get("status");
      saveFilt();
      history.replaceState({}, "", "/");
    }
    return showInbox();
  }

  function renderCounts(c) {
    const req = (c.requested || 0) + (c.in_progress || 0);
    $("#counts").innerHTML = '<span class="cnt">' + c.open + " open</span> · <span class=\"cnt\">" + c.answered + " answered</span>" +
      (req ? ' · <span class="cnt">' + req + " request" + (req > 1 ? "s" : "") + "</span>" : "");
  }

  // ---------------------------------------------------------------- inbox
  const filt = Object.assign({ status: "open", tag: "", priority: "", q: "", group: "priority" }, store.get("filters", {}));
  if (!TABS[filt.status] && !HIDDEN_TABS[filt.status]) filt.status = "open";

  function itemRow(it, opts = {}) {
    const meta = [];
    if (it.n_attachments) meta.push(it.n_attachments + " attachment" + (it.n_attachments > 1 ? "s" : ""));
    if (it.n_comments) meta.push(it.n_comments + " comment" + (it.n_comments > 1 ? "s" : ""));
    if (it.options && it.options.length) meta.push(it.options.length + " options");
    return '<li class="item' + (it.is_new ? " is-new" : "") + '" data-id="' + it.id + '">' +
      '<a href="/item/' + it.id + '" data-nav>' +
      '<span class="l1">' + (it.is_new ? '<span class="dot" title="new activity"></span>' : "") +
      '<span class="title">' + esc(it.title) + "</span></span>" +
      '<span class="l2">' + blockedBadge(it.open_blockers) + kindBadge(it) + dueBadge(it) + prioBadge(it.priority) + badge("tag", it.project) +
      (opts.showStatus || it.status !== "open" ? statusBadge(it.status) : "") +
      '<span class="meta">' + dref(it.id) + (it.updated ? " · " + timeEl(it.updated) : "") + (meta.length ? " · " + esc(meta.join(" · ")) : "") + "</span></span></a></li>";
  }

  async function showInbox(keepCursor) {
    state.view = "inbox";
    document.title = "Review Desk";
    let data;
    try {
      data = await api("/api/items?status=" + encodeURIComponent(statusQuery(filt.status)));
    } catch (e) {
      main.innerHTML = '<p class="error">Could not load items: ' + esc(e.message) + "</p>";
      return;
    }
    renderCounts(data.counts);
    const all = data.items;
    const tagCounts = {};
    for (const it of all) tagCounts[it.project] = (tagCounts[it.project] || 0) + 1;
    if (filt.tag && !tagCounts[filt.tag]) tagCounts[filt.tag] = 0;
    const q = filt.q.trim().toLowerCase();
    const items = all.filter((it) => (!filt.tag || it.project === filt.tag) && (!filt.priority || it.priority === filt.priority) &&
      (!q || (it.title + " " + it.project + " d-" + it.id + " d" + it.id).toLowerCase().includes(q)));
    const nNew = items.filter((it) => it.is_new && it.status !== "closed").length;

    const c = data.counts;
    const tabN = { open: c.open, answered: c.answered, requests: (c.requested || 0) + (c.in_progress || 0), closed: c.closed + (c.done || 0) };
    const tabs = Object.keys(TABS).concat(HIDDEN_TABS[filt.status] ? [filt.status] : []);
    const statusTabs = tabs.map((s) =>
      '<button class="tab' + (filt.status === s ? " on" : "") + '" data-status="' + s + '">' + s +
      (tabN[s] !== undefined ? ' <span class="n">' + tabN[s] + "</span>" : "") + "</button>").join("");
    const tagChips = ['<button class="chip' + (!filt.tag ? " on" : "") + '" data-tag="">all projects</button>']
      .concat(Object.keys(tagCounts).sort().map((t) => '<button class="chip' + (filt.tag === t ? " on" : "") + '" data-tag="' + esc(t) + '">' + esc(t) + ' <span class="n">' + tagCounts[t] + "</span></button>")).join("");

    let html = '<section class="filters">' +
      '<div class="tabs" role="tablist">' + statusTabs + "</div>" +
      '<div class="row2"><input id="q" type="search" placeholder="Search  /" value="' + esc(filt.q) + '" aria-label="Search">' +
      '<select id="prio" aria-label="Priority"><option value="">any priority</option>' + PRIOS.map((p) => "<option" + (filt.priority === p ? " selected" : "") + ">" + p + "</option>").join("") + "</select>" +
      '<select id="group" aria-label="Group by"><option value="priority"' + (filt.group === "priority" ? " selected" : "") + '>group: priority</option><option value="tag"' + (filt.group === "tag" ? " selected" : "") + ">group: project</option><option value=\"none\"" + (filt.group === "none" ? " selected" : "") + ">no grouping</option></select></div>" +
      '<div class="chips" aria-label="Project">' + tagChips + "</div></section>";
    if (nNew) html += '<p class="newnote"><span class="dot"></span>' + nNew + " item" + (nNew > 1 ? "s" : "") + " with new activity since you last looked</p>";

    state.list = items.map((it) => it.id);
    if (!items.length) {
      html += '<p class="empty">' + (all.length ? "Nothing matches these filters." : filt.status === "open" ? "Inbox zero. Nothing needs you right now." : "No items.") + "</p>";
    } else {
      const groups = [];
      if (filt.group === "none") groups.push(["", items]);
      else {
        const key = filt.group === "tag" ? (it) => it.project : (it) => it.priority;
        const order = filt.group === "tag" ? [...new Set(items.map(key))].sort() : PRIOS;
        for (const k of order) {
          const g = items.filter((it) => key(it) === k);
          if (g.length) groups.push([k, g]);
        }
      }
      state.list = groups.flatMap((g) => g[1].map((it) => it.id));
      for (const [k, g] of groups) {
        html += '<section class="group">' + (k ? "<h2>" + esc(k) + ' <span class="n">' + g.length + "</span></h2>" : "") + '<ul class="items">';
        html += g.map((it) => itemRow(it, { showStatus: filt.status !== "open" })).join("");
        html += "</ul></section>";
      }
    }
    main.innerHTML = html;

    $$(".tab", main).forEach((b) => (b.onclick = () => { filt.status = b.dataset.status; saveFilt(); showInbox(); }));
    $$(".chip", main).forEach((b) => (b.onclick = () => { filt.tag = b.dataset.tag; saveFilt(); showInbox(); }));
    $("#prio").onchange = (e) => { filt.priority = e.target.value; saveFilt(); showInbox(); };
    $("#group").onchange = (e) => { filt.group = e.target.value; saveFilt(); showInbox(); };
    const qi = $("#q");
    qi.oninput = () => { filt.q = qi.value; saveFilt(); clearTimeout(qi._t); qi._t = setTimeout(() => showInbox().then(() => { const n = $("#q"); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }), 200); };
    if (!keepCursor) state.cursor = Math.min(state.cursor, Math.max(0, state.list.length - 1));
    markCursor(false);
    state.refreshTimer = setInterval(() => {
      if (document.visibilityState === "visible" && state.view === "inbox" && document.activeElement !== $("#q")) showInbox(true);
    }, 30000);
  }
  function saveFilt() { store.set("filters", filt); }
  function markCursor(scroll) {
    $$(".item", main).forEach((li, i) => li.classList.toggle("cur", i === state.cursor));
    const cur = $$(".item", main)[state.cursor];
    if (cur && scroll) cur.scrollIntoView({ block: "nearest" });
  }

  // ------------------------------------------------------------- projects
  async function showProjects() {
    state.view = "projects";
    document.title = "Projects · Review Desk";
    let d;
    try { d = await api("/api/projects"); } catch (e) { main.innerHTML = '<p class="error">' + esc(e.message) + "</p>"; return; }
    api("/api/items?status=open").then((x) => renderCounts(x.counts)).catch(() => {});
    const L = (proj, status) => "/?project=" + encodeURIComponent(proj) + "&status=" + status;
    let html = '<header class="pagehead"><h1>Projects</h1><p class="muted">Every project with items on the desk. Tap a number to see those items.</p></header>';
    if (!d.projects.length) html += '<p class="empty">No items yet.</p>';
    html += '<div class="cards">';
    for (const c of d.projects) {
      const n = c.counts;
      const stat = (label, val, href, cls) => '<a class="stat' + (cls && val ? " " + cls : "") + (val ? "" : " zero") + '" href="' + href + '" data-nav><span class="sv">' + val + '</span><span class="sl">' + label + "</span></a>";
      html += '<section class="card' + (n.blocking ? " urgent" : "") + '"><h2><a href="' + L(c.project, "active") + '" data-nav>' + esc(c.project) + "</a>" +
        (n.blocking ? badge("p-blocking", n.blocking + " blocking") : "") + "</h2>" +
        '<div class="stats">' +
        stat("open", n.open, L(c.project, "active")) +
        stat("waiting on you", n.waiting, L(c.project, "open"), "hot") +
        stat("blocking", n.blocking, L(c.project, "open"), "block") +
        stat("answered", n.answered, L(c.project, "answered")) +
        stat("requests", n.requested, L(c.project, "requests")) +
        stat("to do", n.todo || 0, "/todo?project=" + encodeURIComponent(c.project), "todo") +
        stat("done", n.done || 0, "/todo?project=" + encodeURIComponent(c.project)) +
        stat("closed", n.closed, L(c.project, "closed")) + "</div>";
      if (c.blocked.length) {
        html += '<h3>Blocked</h3><ul class="mini">' + c.blocked.slice(0, 5).map((b) =>
          '<li><a href="/item/' + b.id + '" data-nav><span class="mref">' + dref(b.id) + "</span> " + esc(b.title) + "</a> " + blockedBadge(b.open_blockers) + "</li>").join("") + "</ul>" +
          (c.blocked.length > 5 ? '<p class="more"><a href="' + L(c.project, "active") + '" data-nav>+' + (c.blocked.length - 5) + " more blocked</a></p>" : "");
      }
      if (c.last) {
        const who = c.last.actor === "owner" ? "you" : "assistant";
        html += '<p class="last">Last: <a href="/item/' + c.last.item_id + '" data-nav>' + dref(c.last.item_id) + "</a> " +
          esc(c.last.title.length > 60 ? c.last.title.slice(0, 58) + "…" : c.last.title) + ' <span class="muted">· ' + esc(who + " " + c.last.kind) + " · " + timeEl(c.last.created) + "</span></p>";
      }
      html += "</section>";
    }
    html += "</div>";
    main.innerHTML = html;
  }

  // ------------------------------------------------------- new workstream
  async function showNew() {
    state.view = "new";
    document.title = "New workstream · Review Desk";
    const draft = store.get("wsdraft", {});
    let items = [];
    let projects = [];
    try {
      const d = await api("/api/items?status=all");
      items = d.items;
      projects = d.projects || d.tags || [];
      renderCounts(d.counts);
    } catch (e) { /* the form still works; ids are validated server-side */ }
    const byId = Object.fromEntries(items.map((x) => [x.id, x]));
    const prio = draft.priority || "soon";
    let html = '<nav class="crumbs"><a href="/" data-nav>← Inbox</a></nav>' +
      '<header class="pagehead"><h1>New workstream</h1><p class="muted">Ask the agents to start something. It lands on the desk as a request; an agent claims it on its next check and replies in its discussion.</p></header>' +
      '<form id="ws-form" class="wsform" novalidate>' +
      '<div class="field"><label for="ws-title">Title</label><input id="ws-title" name="title" required maxlength="300" autocomplete="off" placeholder="e.g. Docs: write the upgrade guide" value="' + esc(draft.title || "") + '"></div>' +
      '<div class="field"><label for="ws-project">Project</label><input id="ws-project" name="project" required list="ws-projects" autocomplete="off" autocapitalize="none" placeholder="docs" value="' + esc(draft.project || "") + '">' +
      '<datalist id="ws-projects">' + projects.map((p) => '<option value="' + esc(p) + '">').join("") + "</datalist>" +
      '<p class="hint">Pick an existing project or type a new one (lowercase, a–z 0–9 - _).</p></div>' +
      '<fieldset class="field seg"><legend>Priority</legend><div class="segs">' + PRIOS.map((p) =>
        '<label class="segopt p-' + p + '"><input type="radio" name="priority" value="' + p + '"' + (p === prio ? " checked" : "") + "><span>" + p + "</span></label>").join("") + "</div></fieldset>" +
      '<div class="field"><div class="labelrow"><label for="ws-body">Description</label><div class="mdtabs" role="tablist"><button type="button" class="tab on" data-mode="write">Write</button><button type="button" class="tab" data-mode="preview">Preview</button></div></div>' +
      '<textarea id="ws-body" name="body" rows="9" placeholder="What should happen, why, and what done looks like. Markdown ok; paste or drop images.">' + esc(draft.body || "") + "</textarea>" +
      '<div id="ws-preview" class="md preview" hidden></div>' +
      '<p class="hint">' + refHint() + "</p></div>" +
      '<details class="field rels"' + (draft.blocks || draft.blocked_by ? " open" : "") + '><summary>Blocking relationships <span class="muted">(optional)</span></summary>' +
      '<div class="field"><label for="ws-blocked-by">Blocked by</label><input id="ws-blocked-by" name="blocked_by" autocomplete="off" placeholder="D-76, D-80" value="' + esc(draft.blocked_by || "") + '"><div class="resolved" id="ws-blocked-by-r"></div></div>' +
      '<div class="field"><label for="ws-blocks">Blocks</label><input id="ws-blocks" name="blocks" autocomplete="off" placeholder="D-81" value="' + esc(draft.blocks || "") + '"><div class="resolved" id="ws-blocks-r"></div></div>' +
      "</details>" +
      '<div class="field"><span class="fieldlabel">Attachments <span class="muted">(optional, 25 MB total)</span></span><span class="cpickhost" id="ws-pick"></span>' +
      '<p class="hint">Or paste / drop images straight into the description.</p></div>' +
      '<div class="formrow actions"><a href="/" data-nav class="cancel">Cancel</a><button type="submit" class="primary" id="ws-submit">Request workstream</button></div>' +
      "</form>";
    main.innerHTML = html;

    const form = $("#ws-form");
    const saveDraft = () => store.set("wsdraft", {
      title: $("#ws-title").value, project: $("#ws-project").value, body: $("#ws-body").value,
      priority: (form.querySelector('input[name="priority"]:checked') || {}).value,
      blocks: $("#ws-blocks").value, blocked_by: $("#ws-blocked-by").value,
    });
    form.oninput = saveDraft;
    form.onchange = saveDraft;
    const resolve = (inp) => {
      const out = $("#" + inp.id + "-r");
      const { ids, bad } = parseIds(inp.value);
      out.innerHTML = ids.map((i) => byId[i] ? '<span class="rchip">' + dref(i) + " · " + esc(byId[i].title.slice(0, 50)) + " " + statusBadge(byId[i].status) + "</span>"
        : '<span class="rchip bad">' + dref(i) + " not found</span>").join("") + bad.map((b) => '<span class="rchip bad">' + esc(b) + " is not an id</span>").join("");
      return !bad.length && ids.every((i) => !items.length || byId[i]);
    };
    ["#ws-blocks", "#ws-blocked-by"].forEach((s) => { const i = $(s); i.addEventListener("input", () => resolve(i)); resolve(i); });
    $$(".mdtabs .tab", form).forEach((b) => (b.onclick = () => {
      const prev = b.dataset.mode === "preview";
      $$(".mdtabs .tab", form).forEach((x) => x.classList.toggle("on", x === b));
      const pv = $("#ws-preview"), ta = $("#ws-body");
      if (prev) { MD.setContext(null); pv.innerHTML = ta.value.trim() ? MD.render(ta.value) : '<p class="muted">Nothing to preview.</p>'; }
      pv.hidden = !prev;
      ta.hidden = prev;
    }));
    const wsC = composer($("#ws-body"), { pickHost: $("#ws-pick"), pickLabel: "Attach files or images" });
    form.onsubmit = async (e) => {
      e.preventDefault();
      const title = $("#ws-title").value.trim();
      const project = $("#ws-project").value.trim().toLowerCase();
      if (!title) { $("#ws-title").focus(); return toast("Give it a title", "err"); }
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(project)) { $("#ws-project").focus(); return toast("Project: lowercase letters, digits, - or _", "err"); }
      if (!resolve($("#ws-blocks")) || !resolve($("#ws-blocked-by"))) { form.querySelector("details.rels").open = true; return toast("Fix the blocking item ids", "err"); }
      const files = wsC.files();
      const fd = new FormData();
      fd.append("title", title);
      fd.append("project", project);
      fd.append("priority", form.querySelector('input[name="priority"]:checked').value);
      fd.append("body", $("#ws-body").value);
      parseIds($("#ws-blocks").value).ids.forEach((i) => fd.append("blocks", String(i)));
      parseIds($("#ws-blocked-by").value).ids.forEach((i) => fd.append("blocked_by", String(i)));
      files.forEach((f) => fd.append("file", f, f.name));
      const btn = $("#ws-submit");
      btn.disabled = true;
      btn.textContent = "Sending…";
      try {
        const it = await api("/api/requests", { method: "POST", body: fd });
        store.del("wsdraft");
        toast("Request sent");
        history.pushState({}, "", "/item/" + it.id);
        setNav("");
        await showItem(it.id, { confirm: "Request " + dref(it.id) + " sent. An agent picks it up on its next check." });
      } catch (err) {
        toast("Failed: " + err.message, "err");
        btn.disabled = false;
        btn.textContent = "Request workstream";
      }
    };
    if (!draft.title) $("#ws-title").focus();
  }

  // ------------------------------------------------------------ ref pages
  async function showRef(type, key) {
    state.view = "ref";
    let d;
    try { d = await api("/api/refs/" + type + "/" + encodeURIComponent(key)); } catch (e) {
      main.innerHTML = '<p><a href="/" data-nav>← Inbox</a></p><p class="error">' + esc(e.message) + "</p>"; return;
    }
    const kind = { pr: "Pull request", commit: "Commit", issue: "Issue" }[type];
    const title = type === "pr" ? "PR #" + d.key : type === "commit" ? "Commit " + d.key.slice(0, 9) : d.key;
    document.title = title + " · Review Desk";
    let html = '<nav class="crumbs"><a href="/" data-nav>← Inbox</a></nav>' +
      '<header class="pagehead refhead"><span class="lk">' + esc(kind) + "</span><h1>" + esc(title) + "</h1>" +
      (type === "commit" ? '<p class="mono muted">' + esc(d.key) + "</p>" : "") +
      (d.url ? '<p><a class="button" href="' + esc(d.url) + '" target="_blank" rel="noopener noreferrer">Open ' + esc(linkHost(d.url) || "link") + " ↗</a></p>" : "") + "</header>" +
      "<section><h2>Mentioned on the desk <span class=\"n\">" + d.items.length + "</span></h2>";
    if (!d.items.length) html += '<p class="muted">No desk item mentions this yet.</p>';
    else html += '<ul class="items">' + d.items.map((it) => itemRow(it, { showStatus: true })).join("") + "</ul>";
    html += "</section>";
    main.innerHTML = html;
  }

  // ----------------------------------------------------------------- item
  async function showItem(id, opts = {}) {
    state.view = "item";
    let it;
    try {
      it = await api("/api/items/" + id + (opts.noMarkSeen ? "" : "?view=owner"));
    } catch (e) {
      main.innerHTML = '<p><a href="/" data-nav>← Inbox</a></p><p class="error">' + esc(e.message) + "</p>";
      return;
    }
    if (opts.keepPrevSeen && state.item && state.item.id === id) it.prev_owner_seen = state.item.prev_owner_seen;
    state.item = it;
    MD.setContext(it.ref_ctx);
    const isWs = it.kind === "workstream";
    document.title = dref(it.id) + " " + it.title + " · Review Desk";
    const seen = it.prev_owner_seen;
    const isNew = (ts, author) => author !== "owner" && (!seen || ts > seen);
    const newTag = (ts, author) => (isNew(ts, author) ? '<span class="newtag">new</span>' : "");
    const itemAtts = it.attachments.filter((a) => a.answer_id == null && a.comment_id == null);

    let html = '<nav class="crumbs"><a href="/" data-nav>← Inbox</a><span class="pager"></span></nav>';
    html += '<article class="item-page"><header><h1>' + MD.inline(it.title) + "</h1>" +
      '<div class="l2">' + blockedBadge(it.open_blockers, true) + kindBadge(it) + prioBadge(it.priority) + badge("tag", it.project) + statusBadge(it.status) +
      '<span class="meta">' + dref(it.id) + " · " + (isWs ? "requested by you " : "created ") + timeEl(it.created) + " · updated " + timeEl(it.updated) + "</span></div></header>";
    if (isWs) {
      const claim = [...it.events].reverse().find((e) => e.kind === "claimed");
      html += '<p class="wsnote s-' + it.status + '">' + (it.status === "requested" ? "Waiting for an agent to claim this request."
        : it.status === "in_progress" ? "An agent claimed this " + (claim ? esc(when(claim.created)) : "") + ". Updates arrive in the discussion."
          : "This request is closed.") + "</p>";
    } else if (seen && it.assistant_activity > seen) html += '<p class="newnote"><span class="dot"></span>Updated since your last visit (' + esc(when(seen)) + "). New parts are marked.</p>";
    else if (!seen) html += '<p class="newnote"><span class="dot"></span>First time you are seeing this item.</p>';
    if (opts.confirm && isWs) html += '<div class="confirm"><strong>✓ ' + esc(opts.confirm) + "</strong></div>";

    html += '<div class="md body">' + (it.body ? MD.render(it.body) : '<p class="muted">(no description)</p>') + "</div>";
    if (itemAtts.length) html += '<section class="atts"><h2>Attachments</h2>' + renderAtts(itemAtts, isNew, newTag) + "</section>";

    if (it.blocks.length || it.blocked_by.length) {
      html += '<section class="rel"><h2>Blocking</h2>';
      if (it.blocked_by.length) html += '<h3>Blocked by</h3><ul class="mini rels">' + it.blocked_by.map((x) => relRow(x, "blocked_by", it.id)).join("") + "</ul>";
      if (it.blocks.length) html += '<h3>Blocks</h3><ul class="mini rels">' + it.blocks.map((x) => relRow(x, "blocks", it.id)).join("") + "</ul>";
      html += "</section>";
    }

    if (it.kind === "todo") {
      const doneEv = [...it.events].reverse().find((e) => e.kind === "done");
      html += '<section class="answer todo-panel"><h2>To do</h2>';
      if (it.status === "open") {
        html += '<p class="muted">An action for you. Mark it done when it is, with an optional note in the reply box below.</p>' +
          '<p class="todo-actions"><button type="button" class="primary" id="todo-done">Mark done</button></p>';
      } else {
        html += '<div class="current"><div class="picked">✓ ' + (it.status === "done" ? "Done" : "Closed") + "</div>" +
          (doneEv ? '<div class="ah">' + (doneEv.actor === "owner" ? "by you " : "by the assistant ") + timeEl(doneEv.created) + "</div>" : "") + "</div>" +
          '<p class="reopen"><button type="button" id="reopen" class="ghost">Reopen</button> <span class="muted">puts it back on your list</span></p>';
      }
      html += "</section>";
      if (it.options.length || it.answers.length) {
        // converted from a decision: keep what was asked and answered
        const lab = Object.fromEntries(it.options.map((o) => [o.key, o.label]));
        html += '<details class="prev-answers"><summary>Before this was a TODO (' + it.answers.length + " answer" + (it.answers.length === 1 ? "" : "s") + ")</summary>" +
          (it.options.length ? '<ul class="was-opts">' + it.options.map((o) => "<li>" + MD.inline(o.label) + (o.recommended ? " <span class=\"badge rec\">recommended</span>" : "") + "</li>").join("") + "</ul>" : "") +
          it.answers.map((a) => '<div class="prev"><div class="ah">You answered ' + timeEl(a.created) + "</div>" + (a.choices.length ? "<strong>" + esc(a.choices.map((k) => lab[k] || k).join(", ")) + "</strong>" : "") + (a.text ? '<div class="md">' + MD.render(a.text) + "</div>" : "") + "</div>").join("") + "</details>";
      }
    } else if (!isWs) {
      // answer form
      const last = it.answers[it.answers.length - 1];
      html += '<section class="answer"><h2>' + (last ? "Your answer" : "Answer") + "</h2>";
      if (last) {
        html += '<div class="current">' + renderAnswer(it, last) + "</div>";
      }
      html += '<form id="ans-form" class="' + (last ? "collapsed" : "") + '">';
      if (last) html += '<button type="button" class="link" id="ans-change">Change or add to my answer…</button>';
      html += '<div class="ans-fields">';
      if (it.options.length) {
        const type = it.multi ? "checkbox" : "radio";
        html += '<fieldset class="opts"><legend>' + (it.multi ? "Pick any that apply" : "Pick one") + "</legend>";
        it.options.forEach((o, i) => {
          const checked = last && last.choices.includes(o.key) ? " checked" : "";
          html += '<label class="opt' + (o.recommended ? " rec" : "") + '"><input type="' + type + '" name="choice" value="' + esc(o.key) + '"' + checked + ">" +
            '<span class="ot"><span class="ol">' + (i < 9 ? "<kbd>" + (i + 1) + "</kbd> " : "") + MD.inline(o.label) + (o.recommended ? ' <span class="badge rec">recommended</span>' : "") + "</span>" +
            (o.description ? '<span class="od md">' + MD.render(o.description) + "</span>" : "") + "</span></label>";
        });
        if (!it.multi) html += '<button type="button" class="link" id="clear-choice">clear selection</button>';
        html += "</fieldset>";
      }
      html += '<label class="fl" for="ans-text">' + (it.options.length ? "Comments / answer in your own words (optional)" : "Your answer") + "</label>" +
        '<textarea id="ans-text" name="text" rows="4" placeholder="Markdown ok. Paste or drop images. Ctrl+Enter to submit."></textarea>' +
        '<div class="formrow"><span class="cpickhost" id="ans-pick"></span>' +
        '<button type="submit" class="primary" id="ans-submit">' + (last ? "Submit new answer" : "Submit answer") + "</button></div>" +
        "</div></form>";
      html += '<div id="ans-confirm" class="confirm" hidden></div>';
      if (it.status !== "open") html += '<p class="reopen"><button type="button" id="reopen" class="ghost">Reopen this item</button> <span class="muted">puts it back in the open inbox for the assistant</span></p>';
      html += "</section>";

      if (it.answers.length > 1) {
        html += '<details class="prev-answers"><summary>Previous answers (' + (it.answers.length - 1) + ")</summary>" +
          it.answers.slice(0, -1).reverse().map((a) => '<div class="prev">' + renderAnswer(it, a) + "</div>").join("") + "</details>";
      }
    }

    // thread
    html += '<section class="thread"><h2>Discussion</h2>';
    if (!it.comments.length) html += '<p class="muted">' + (isWs ? "No replies yet." : "No comments yet.") + "</p>";
    html += it.comments.map((c) => '<div class="comment ' + c.author + (isNew(c.created, c.author) ? " new" : "") + '">' +
      '<div class="ch"><strong>' + (c.author === "owner" ? "You" : "Assistant") + "</strong> " + timeEl(c.created) + newTag(c.created, c.author) + "</div>" +
      (c.body ? '<div class="md">' + MD.render(c.body) + "</div>" : "") +
      (c.attachments && c.attachments.length ? '<div class="catts">' + renderAtts(c.attachments, () => false, () => "") + "</div>" : "") + "</div>").join("");
    html += '<form id="cmt-form"><label class="fl" for="cmt-text">Reply</label><textarea id="cmt-text" rows="3" placeholder="Ask a follow-up or add context. Paste or drop images. Ctrl+Enter to send."></textarea>' +
      '<div class="formrow"><span class="cpickhost" id="cmt-pick"></span><button type="submit" id="cmt-submit"' + (isWs ? ' class="primary"' : "") + ">Post comment</button></div></form></section>";

    // links: backlinks, external refs, add a blocking relationship
    html += '<section class="links-sec"><h2>Links</h2>';
    if (it.mentioned_by.length) html += '<h3>Mentioned by</h3><ul class="mini">' + it.mentioned_by.map((x) => miniRow(x)).join("") + "</ul>";
    if (it.xrefs.length) {
      html += '<h3>References</h3><ul class="mini xrefs">' + it.xrefs.map((x) => {
        const kind = { pr: "PR", commit: "commit", issue: "issue" }[x.type];
        return '<li><a class="ref ref-x" href="' + esc(x.url || x.href) + '" target="_blank" rel="noopener noreferrer">' + esc(x.label) + " ↗</a>" +
          ' <span class="muted">' + kind + "</span>" +
          (x.also.length ? ' <span class="alsoon">also on ' + x.also.map((i) => {
            const s = it.ref_ctx.items[i];
            return '<a href="/item/' + i + '" data-nav title="' + esc(s ? s.title : "") + '">' + dref(i) + "</a>";
          }).join(", ") + "</span>" : "") +
          ' <a class="allref" href="' + esc(x.href) + '" data-nav>desk page</a></li>';
      }).join("") + "</ul>";
    }
    if (!it.mentioned_by.length && !it.xrefs.length) html += '<p class="muted">No other desk item mentions this one, and it mentions no PRs, commits or issues.</p>';
    html += '<details class="addlink"><summary>Add a blocking relationship…</summary>' +
      '<form id="link-form" class="linkform"><label class="fl" for="link-rel">This item</label>' +
      '<div class="linkrow"><select id="link-rel" aria-label="Relationship"><option value="blocked_by">is blocked by</option><option value="blocks">blocks</option></select>' +
      '<input id="link-target" autocomplete="off" placeholder="D-76" aria-label="Desk item id" inputmode="text">' +
      '<button type="submit">Add</button></div><div class="resolved" id="link-target-r"></div></form></details>';
    html += "</section>";

    if (isWs) {
      html += '<p class="reopen">' + (it.status === "closed"
        ? '<button type="button" id="reopen" class="ghost">Reopen this request</button> <span class="muted">puts it back for an agent to claim</span>'
        : '<button type="button" id="withdraw" class="ghost">Withdraw this request</button> <span class="muted">closes it; agents stop working on it</span>') + "</p>";
    }

    html += '<details class="history"><summary>History (' + it.events.length + ")</summary><ul>" +
      it.events.map((e) => "<li>" + timeEl(e.created) + " <strong>" + (e.actor === "owner" ? "you" : "assistant") + "</strong> " + esc(e.kind) + (e.detail ? ": " + esc(e.detail) : "") + "</li>").join("") +
      "</ul></details></article>";
    main.innerHTML = html;
    if (opts.confirm && !isWs) showConfirm(opts.confirm);

    // pager (direct loads have no inbox list yet: fetch the current filter's)
    if (!state.list.length) {
      try {
        const d = await api("/api/items?status=" + encodeURIComponent(statusQuery(filt.status)));
        state.list = d.items.filter((x) => (!filt.tag || x.project === filt.tag) && (!filt.priority || x.priority === filt.priority)).map((x) => x.id);
      } catch (e) { /* pager is optional */ }
    }
    const idx = state.list.indexOf(it.id);
    if (idx >= 0) {
      const prev = state.list[idx - 1], next = state.list[idx + 1];
      $(".pager").innerHTML = (prev ? '<a href="/item/' + prev + '" data-nav title="p">‹ prev</a>' : "") +
        '<span class="muted">' + (idx + 1) + " / " + state.list.length + "</span>" + (next ? '<a href="/item/' + next + '" data-nav title="n">next ›</a>' : "");
    }
    wireItem(it);
    api("/api/items?status=open").then((d) => renderCounts(d.counts)).catch(() => {});
  }

  function miniRow(x) {
    return '<li><a href="/item/' + x.id + '" data-nav><span class="mref">' + dref(x.id) + "</span> " + esc(x.title) + "</a> " + statusBadge(x.status) + "</li>";
  }
  function relRow(x, rel, self) {
    // rel is from self's point of view: self is blocked_by x, or self blocks x
    const src = rel === "blocks" ? self : x.id, dst = rel === "blocks" ? x.id : self;
    return '<li class="relrow"><span class="relmain"><a href="/item/' + x.id + '" data-nav><span class="mref">' + dref(x.id) + "</span> " + esc(x.title) + "</a> " + statusBadge(x.status) + "</span>" +
      '<button type="button" class="ghost small unlink" data-src="' + src + '" data-dst="' + dst + '" aria-label="Remove link to ' + dref(x.id) + '">Remove</button></li>';
  }

  function renderAnswer(it, a) {
    const opts = Object.fromEntries(it.options.map((o) => [o.key, o.label]));
    let h = '<div class="ah">Submitted ' + timeEl(a.created) + "</div>";
    if (a.choices.length) h += '<ul class="picked">' + a.choices.map((k) => "<li>✓ " + esc(opts[k] || k) + "</li>").join("") + "</ul>";
    if (a.text) h += '<div class="md">' + MD.render(a.text) + "</div>";
    const files = it.attachments.filter((x) => x.answer_id === a.id);
    if (files.length) h += renderAtts(files, () => false, () => "");
    return h;
  }

  function renderAtts(atts, isNew, newTag) {
    const links = atts.filter((a) => a.kind === "link");
    const imgs = atts.filter((a) => a.kind === "file" && a.render === "image");
    const files = atts.filter((a) => a.kind === "file" && a.render !== "image");
    let h = "";
    if (links.length) h += '<div class="links">' + links.map((a) => {
      const host = linkHost(a.url);
      const kind = /github\.com\/.+\/pull\/\d+/.test(a.url) ? "pull request" : /github\.com/.test(a.url) ? "github" : host;
      return '<a class="linkcard' + (isNew(a.created, a.author) ? " new" : "") + '" href="' + esc(a.url) + '" target="_blank" rel="noopener noreferrer">' +
        '<span class="lk">' + esc(kind) + "</span><span class=\"lt\">" + esc(a.label) + newTag(a.created, a.author) + '</span><span class="lu">' + esc(a.url) + "</span></a>";
    }).join("") + "</div>";
    if (imgs.length) h += '<div class="imgs">' + imgs.map((a) =>
      '<figure class="' + (isNew(a.created, a.author) ? "new" : "") + '"><button type="button" class="thumb" data-id="' + a.id + '" data-src="' + esc(a.href) + '" data-cap="' + esc(a.label) + '" aria-label="Enlarge ' + esc(a.label) + '"><img src="' + esc(a.href) + '" alt="' + esc(a.label) + '" loading="lazy"></button>' +
      "<figcaption>" + esc(a.label) + newTag(a.created, a.author) + ' <a href="' + esc(a.href) + '" download>download</a></figcaption></figure>').join("") + "</div>";
    if (files.length) h += '<ul class="files">' + files.map((a) => {
      let extra = "";
      if (a.render === "markdown" || a.render === "text") extra = ' <button type="button" class="link toggle-view" data-id="' + a.id + '" data-href="' + esc(a.href) + '" data-render="' + a.render + '">view</button>';
      if (a.render === "html") extra = ' <button type="button" class="link toggle-view" data-id="' + a.id + '" data-href="' + esc(a.href) + '" data-render="html">preview (sandboxed)</button>';
      return '<li class="' + (isNew(a.created, a.author) ? "new" : "") + '"><a href="' + esc(a.href) + '" download>' + esc(a.label) + "</a>" +
        (a.label !== a.filename ? ' <span class="muted">' + esc(a.filename) + "</span>" : "") + ' <span class="muted">' + fmtSize(a.size) + "</span>" + newTag(a.created, a.author) + extra +
        '<div class="fileview" id="fv-' + a.id + '" hidden></div></li>';
    }).join("") + "</ul>";
    return h;
  }

  function showConfirm(c) {
    const el = $("#ans-confirm");
    if (!el) return;
    el.hidden = false;
    el.innerHTML = "<strong>✓ " + esc(c) + "</strong> The assistant will pick it up on its next check.";
    el.scrollIntoView({ block: "center" });
  }

  function wireItem(it) {
    // image viewer: every image attachment of the item, in attachment order
    const images = it.attachments.filter((a) => a.kind === "file" && a.render === "image")
      .map((a) => ({ id: a.id, href: a.href, label: a.label }));
    const openAtt = (id) => {
      const i = images.findIndex((x) => x.id === id);
      if (i >= 0) Viewer.open(images, i);
    };
    $$(".thumb", main).forEach((b) => (b.onclick = () => openAtt(+b.dataset.id)));
    $$("img.md-img", main).forEach((im) => {
      const m = (im.getAttribute("src") || "").match(/^\/files\/(\d+)\//);
      if (m && images.some((x) => x.id === +m[1])) {
        im.classList.add("zoomable");
        im.onclick = () => openAtt(+m[1]);
      }
    });
    const hm = location.hash.match(/^#att-(\d+)$/);
    if (hm) openAtt(+hm[1]);
    $$(".toggle-view", main).forEach((b) => (b.onclick = async () => {
      const box = $("#fv-" + b.dataset.id);
      if (!box.hidden) { box.hidden = true; box.innerHTML = ""; return; }
      box.hidden = false;
      if (b.dataset.render === "html") {
        box.innerHTML = '<iframe sandbox="" referrerpolicy="no-referrer" src="' + esc(b.dataset.href) + '?mode=sandbox" title="sandboxed preview"></iframe>';
        return;
      }
      box.innerHTML = '<p class="muted">Loading…</p>';
      try {
        const r = await fetch(b.dataset.href + "?mode=raw");
        const t = await r.text();
        box.innerHTML = b.dataset.render === "markdown" ? '<div class="md">' + MD.render(t) + "</div>" : "<pre>" + esc(t) + "</pre>";
      } catch (e) { box.innerHTML = '<p class="error">' + esc(e.message) + "</p>"; }
    }));
    const form = $("#ans-form");
    const ansC = form ? composer($("#ans-text"), { pickHost: $("#ans-pick"), pickLabel: "Attach file or image" }) : null;
    const cmtC = composer($("#cmt-text"), { pickHost: $("#cmt-pick"), pickLabel: "Add image", imagesOnly: true });
    if (form) {
      const ch = $("#ans-change");
      if (ch) ch.onclick = () => { form.classList.remove("collapsed"); $("#ans-text").focus(); };
      const clr = $("#clear-choice");
      if (clr) clr.onclick = () => $$('input[name="choice"]', form).forEach((x) => (x.checked = false));
      form.onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData();
        $$('input[name="choice"]:checked', form).forEach((x) => fd.append("choice", x.value));
        const text = $("#ans-text").value;
        fd.append("text", text);
        const files = ansC.files();
        files.forEach((f) => fd.append("file", f, f.name));
        if (!fd.getAll("choice").length && !text.trim() && !files.length) return toast("Pick an option or write something first", "err");
        const btn = $("#ans-submit");
        btn.disabled = true;
        btn.textContent = "Submitting…";
        try {
          await api("/api/items/" + it.id + "/answer", { method: "POST", body: fd });
          toast("Answer submitted");
          await showItem(it.id, { confirm: "Answer submitted " + new Date().toLocaleTimeString() + ".", keepPrevSeen: true });
        } catch (err) {
          toast("Failed: " + err.message, "err");
          btn.disabled = false;
          btn.textContent = "Submit answer";
        }
      };
    }
    $("#cmt-form").onsubmit = async (e) => {
      e.preventDefault();
      const body = $("#cmt-text").value.trim();
      const files = cmtC.files();
      if (!body && !files.length) return toast("Comment is empty", "err");
      const btn = $("#cmt-submit");
      btn.disabled = true;
      try {
        if (files.length) {
          const fd = new FormData();
          fd.append("body", body);
          fd.append("author", "owner");
          files.forEach((f) => fd.append("file", f, f.name));
          btn.textContent = "Uploading…";
          await api("/api/items/" + it.id + "/comments", { method: "POST", body: fd });
        } else {
          await api("/api/items/" + it.id + "/comments", { method: "POST", json: { body, author: "owner" } });
        }
        toast("Comment posted");
        await showItem(it.id, { keepPrevSeen: true });
        const last = $$(".comment", main).pop();
        if (last) last.scrollIntoView({ block: "center" });
      } catch (err) {
        toast("Failed: " + err.message, "err");
        btn.disabled = false;
        btn.textContent = "Post comment";
      }
    };
    const ro = $("#reopen");
    if (ro) ro.onclick = async () => {
      try {
        await api("/api/items/" + it.id + "/reopen", { method: "POST", json: {} });
        toast("Reopened");
        showItem(it.id, { keepPrevSeen: true });
      } catch (err) { toast("Failed: " + err.message, "err"); }
    };
    const td = $("#todo-done");
    if (td) td.onclick = async () => {
      td.disabled = true;
      try {
        await api("/api/items/" + it.id + "/done", { method: "POST", json: {} });
        toast("Done: " + dref(it.id));
        showItem(it.id, { keepPrevSeen: true, noMarkSeen: true });
      } catch (err) { td.disabled = false; toast("Failed: " + err.message, "err"); }
    };
    const wd = $("#withdraw");
    if (wd) wd.onclick = async () => {
      if (!confirm("Withdraw " + dref(it.id) + "? Agents will stop working on it.")) return;
      try {
        await api("/api/items/" + it.id + "/close?author=owner", { method: "POST", json: { comment: "Withdrawn by the owner." } });
        toast("Request withdrawn");
        showItem(it.id, { keepPrevSeen: true });
      } catch (err) { toast("Failed: " + err.message, "err"); }
    };
    $$(".unlink", main).forEach((b) => (b.onclick = async () => {
      try {
        await api("/api/links/" + b.dataset.src + "/blocks/" + b.dataset.dst + "?author=owner", { method: "DELETE" });
        toast("Removed: D-" + b.dataset.src + " no longer blocks D-" + b.dataset.dst);
        showItem(it.id, { keepPrevSeen: true, noMarkSeen: true });
      } catch (err) { toast("Failed: " + err.message, "err"); }
    }));
    const lf = $("#link-form");
    const lt = $("#link-target");
    lt.oninput = () => {
      const { ids, bad } = parseIds(lt.value);
      $("#link-target-r").innerHTML = bad.length ? '<span class="rchip bad">use a desk id like D-76</span>' : ids.length > 1 ? '<span class="rchip bad">one item at a time</span>' : "";
    };
    lf.onsubmit = async (e) => {
      e.preventDefault();
      const { ids, bad } = parseIds(lt.value);
      if (bad.length || ids.length !== 1) { lt.focus(); return toast("Enter one desk item id, like D-76", "err"); }
      const rel = $("#link-rel").value;
      try {
        await api("/api/links", { method: "POST", json: { src: it.id, dst: ids[0], kind: rel, author: "owner" } });
        toast(rel === "blocks" ? dref(it.id) + " now blocks " + dref(ids[0]) : dref(it.id) + " is now blocked by " + dref(ids[0]));
        await showItem(it.id, { keepPrevSeen: true, noMarkSeen: true });
      } catch (err) { toast("Failed: " + err.message, "err"); }
    };
  }

  // ------------------------------------------------------------ to-do list
  // Owner TODOs filed by agents (kind=todo): a checklist grouped by project,
  // priority then due date. Tap the circle to complete (Undo for 5 s).
  const T = { undo: null };
  async function showTodos() {
    state.view = "todo";
    document.title = "To do · Review Desk";
    const project = new URLSearchParams(location.search).get("project") || "";
    let d;
    try { d = await api("/api/todos" + (project ? "?project=" + encodeURIComponent(project) : "")); } catch (e) {
      main.innerHTML = '<p class="error">' + esc(e.message) + "</p>"; return;
    }
    const groups = new Map();
    for (const t of d.open) { if (!groups.has(t.project)) groups.set(t.project, []); groups.get(t.project).push(t); }
    // projects with the most urgent item first
    const order = [...groups.keys()].sort((a, b) => {
      const ka = groups.get(a)[0], kb = groups.get(b)[0];
      return (PRIOS.indexOf(ka.priority) - PRIOS.indexOf(kb.priority)) || ((ka.due || "9999") < (kb.due || "9999") ? -1 : (ka.due || "9999") > (kb.due || "9999") ? 1 : 0) || a.localeCompare(b);
    });
    const row = (t, done) => '<li class="trow' + (done ? " is-done" : "") + '" data-id="' + t.id + '">' +
      '<button type="button" class="tcheck" data-id="' + t.id + '" aria-pressed="' + (done ? "true" : "false") + '" aria-label="' + esc((done ? "Reopen " : "Mark done: ") + dref(t.id) + " " + t.title) + '" title="' + (done ? "Reopen" : "Mark done") + '"></button>' +
      '<a class="tmain" href="/item/' + t.id + '" data-nav><span class="ttitle">' + esc(t.title) + "</span>" +
      '<span class="l2">' + (done ? "" : blockedBadge(t.open_blockers)) + dueBadge(t) + (done ? "" : prioBadge(t.priority)) +
      (project || done ? badge("tag", t.project) : "") + '<span class="meta">' + dref(t.id) + (t.n_comments ? " · " + t.n_comments + " comment" + (t.n_comments > 1 ? "s" : "") : "") +
      (done && t.done_at ? " · done " + timeEl(t.done_at) : "") + "</span></span></a></li>";
    let html = '<header class="pagehead"><h1>To do</h1><p class="muted">Things the agents need you to do. Tap the circle when one is done.</p></header>' +
      (project ? '<p class="qfilter">Project <strong>' + esc(project) + '</strong> · <a href="/todo" data-nav>all projects</a></p>' : "");
    if (!d.open.length) html += '<div class="qdone"><div class="qcheck" aria-hidden="true">✓</div><h2>Nothing to do</h2><p class="muted">The agents have nothing waiting on you here.</p></div>';
    for (const p of order) {
      const g = groups.get(p);
      html += '<section class="tgroup"><h2><a href="/todo?project=' + encodeURIComponent(p) + '" data-nav>' + esc(p) + '</a> <span class="n">' + g.length + '</span></h2><ul class="tlist">' + g.map((t) => row(t, false)).join("") + "</ul></section>";
    }
    if (d.done.length) html += '<details class="tdone"><summary>Done (' + d.done.length + ')</summary><ul class="tlist">' + d.done.map((t) => row(t, true)).join("") + "</ul></details>";
    html += '<div id="qtoast" class="qtoast" role="status" aria-live="polite" hidden><span class="qtmsg"></span><button type="button" class="qtundo">Undo</button><span class="qtbar"></span></div>';
    main.innerHTML = html;
    refreshQueueCount();
    $$(".tcheck", main).forEach((b) => (b.onclick = () => toggleTodo(+b.dataset.id, b.getAttribute("aria-pressed") !== "true", b)));
  }

  async function toggleTodo(id, makeDone, btn) {
    const li = btn && btn.closest(".trow");
    if (li) li.classList.add(makeDone ? "checking" : "unchecking");
    try {
      await api("/api/items/" + id + (makeDone ? "/done" : "/reopen"), { method: "POST", json: {} });
      await new Promise((r) => setTimeout(r, 380)); // let the check animation land
      T.undo = { id, makeDone };
      await showTodos();
      qToast((makeDone ? "Done — " : "Reopened — ") + dref(id), UNDO_MS, () => toggleTodo(id, !makeDone, $('.tcheck[data-id="' + id + '"]')));
    } catch (e) {
      if (li) li.classList.remove("checking", "unchecking");
      toast("Failed: " + e.message, "err");
    }
  }

  // ---------------------------------------------------------- review queue
  // One card at a time over the items that need the owner (server: /api/queue).
  // Swipe left / S = snooze (to the back, stored server-side); swipe right /
  // Submit = answer (choices [+ text]) or comment (text only). A swipe right with
  // nothing chosen approves the recommended option after a 3 s undo window.
  const QUEUE_REASON = { answer: "Needs your answer", activity: "New since you looked", reply: "Agent replied on your request", snoozed: "Snoozed earlier", todo: "Your to-do" };
  const UNDO_MS = 5000, APPROVE_MS = 3000, BODY_PEEK_PX = 260;
  const Q = {
    list: [], pos: 0, waiting: [], project: "", item: null, cache: new Map(),
    stats: { answered: 0, commented: 0, approved: 0, snoozed: 0, done: 0 }, snoozedNow: new Set(),
    undo: null, pending: null, busy: false, composer: null,
  };

  async function refreshQueueCount() {
    try {
      const d = await api("/api/queue?count=1");
      const el = $("#qcount");
      if (el) { el.textContent = d.count; el.hidden = !d.count; }
      const te = $("#tcount");
      if (te) { te.textContent = d.todo || 0; te.hidden = !d.todo; }
    } catch (e) { /* header count is optional */ }
  }

  async function showQueue() {
    state.view = "queue";
    document.title = "Review · Review Desk";
    const qs = new URLSearchParams(location.search);
    Q.project = qs.get("project") || "";
    let d;
    try { d = await api("/api/queue" + (Q.project ? "?project=" + encodeURIComponent(Q.project) : "")); } catch (e) {
      main.innerHTML = '<p class="error">Could not load the queue: ' + esc(e.message) + "</p>"; return;
    }
    Object.assign(Q, { list: d.items, waiting: d.waiting, pos: 0, item: null, undo: null, cache: new Map(),
      stats: { answered: 0, commented: 0, approved: 0, snoozed: 0, done: 0 }, snoozedNow: new Set() });
    main.innerHTML = '<section class="queue">' +
      '<div class="qtop"><a href="/" data-nav class="qexit">← Exit</a>' +
      '<span class="qprog" id="qprog" aria-live="polite"></span>' +
      '<span class="qnavbtns"><button type="button" class="ghost" id="q-prev" aria-label="Previous card" title="Previous (←)">‹</button>' +
      '<button type="button" class="ghost" id="q-next" aria-label="Next card without answering" title="Next without answering (→)">›</button></span></div>' +
      (Q.waiting.length ? '<div class="qwaitwrap">' + waitingBlock() + "</div>" : "") +
      (Q.project ? '<p class="qfilter">Project <strong>' + esc(Q.project) + '</strong> · <a href="/queue" data-nav>all projects</a></p>' : "") +
      '<div id="qstage" class="qstage"></div>' +
      '<div class="qactions" id="qactions"><button type="button" class="ghost qsnooze" id="q-snooze" title="Snooze: move to the back (S, swipe left)">Snooze</button>' +
      '<button type="button" class="primary qsubmit" id="q-submit" title="Submit and go to the next (Enter, swipe right)">Submit</button></div>' +
      '<div id="qtoast" class="qtoast" role="status" aria-live="polite" hidden><span class="qtmsg"></span><button type="button" class="qtundo">Undo</button><span class="qtbar"></span></div>' +
      "</section>";
    $("#q-prev").onclick = () => move(-1);
    $("#q-next").onclick = () => move(1);
    $("#q-snooze").onclick = () => snooze();
    $("#q-submit").onclick = () => submitCard("button");
    $("#qtoast .qtundo").onclick = () => undo();
    renderCard();
  }

  const qActive = () => Q.list.filter((s, i) => i >= Q.pos);
  function qFinished() {
    if (Q.pos >= Q.list.length) return true;
    // only items already snoozed in this session are left: that's the end of this pass
    return qActive().every((s) => Q.snoozedNow.has(s.id) || s.handled);
  }

  function qProgress() {
    const st = Q.stats, done = st.answered + st.commented + st.approved + st.done;
    const total = Q.list.length;
    $("#qprog").innerHTML = (qFinished() ? "Done" : "<strong>" + Math.min(Q.pos + 1, total) + "</strong> of " + total) +
      ' <span class="muted">· ' + done + " done" + (st.snoozed ? " · " + st.snoozed + " snoozed" : "") + "</span>";
    $("#q-prev").disabled = Q.pos <= 0;
    $("#q-next").disabled = Q.pos >= Q.list.length - 1 || qFinished();
  }

  function waitingBlock() {
    if (!Q.waiting.length) return "";
    return '<details class="qwaiting"><summary>' + Q.waiting.length + " waiting on blockers</summary><ul class=\"mini\">" +
      Q.waiting.map((w) => '<li><a href="/item/' + w.id + '" data-nav><span class="mref">' + dref(w.id) + "</span> " + esc(w.title) + "</a> " + blockedBadge(w.open_blockers) + "</li>").join("") +
      "</ul></details>";
  }

  async function loadItem(id, markSeen) {
    if (!markSeen && Q.cache.has(id)) return Q.cache.get(id);
    const it = await api("/api/items/" + id + (markSeen ? "?view=owner" : ""));
    Q.cache.set(id, it);
    return it;
  }

  async function renderCard(dir) {
    const stage = $("#qstage");
    if (!stage) return;
    qProgress();
    if (qFinished()) return renderDone();
    $("#qactions").hidden = false;
    const ww = $(".qwaitwrap");
    if (ww) ww.hidden = false;
    const s = Q.list[Q.pos];
    let it;
    try {
      // Showing a card marks it seen, like opening the item page. A prefetched copy
      // renders at once; the seen-marking request still goes out.
      it = Q.cache.get(s.id);
      const fresh = loadItem(s.id, true);
      if (!it) it = await fresh; else fresh.catch(() => {});
    } catch (e) {
      stage.innerHTML = '<p class="error">' + esc(e.message) + "</p>"; return;
    }
    if (Q.list[Q.pos] !== s) return; // moved on while loading
    Q.item = it;
    MD.setContext(it.ref_ctx);
    const isTodo = it.kind === "todo";
    const opts = isTodo ? [] : it.options || [];
    $("#q-submit").textContent = isTodo ? "Done" : "Submit";
    $("#q-submit").title = isTodo ? "Mark done and go to the next (Enter, swipe right)" : "Submit and go to the next (Enter, swipe right)";
    const last = it.answers[it.answers.length - 1];
    const asst = it.comments.filter((c) => c.author === "assistant").slice(-2);
    const itemAtts = it.attachments.filter((a) => a.answer_id == null && a.comment_id == null);
    const prs = it.xrefs.filter((x) => x.type === "pr" || x.type === "issue");
    let h = '<form class="qcard" id="q-form" data-id="' + it.id + '" novalidate>' +
      '<div class="qhint qhint-l" aria-hidden="true">Snooze</div><div class="qhint qhint-r" aria-hidden="true">' + (isTodo ? "Done" : "Submit") + "</div>" +
      '<div class="qhead"><span class="qreason r-' + esc(s.reason) + '">' + esc(QUEUE_REASON[s.reason] || "") + (s.snoozed_at ? " · snoozed" : "") + "</span>" +
      '<a href="/item/' + it.id + '" data-nav class="qopen">Open full item</a></div>' +
      "<h2>" + MD.inline(it.title) + "</h2>" +
      '<div class="l2">' + blockedBadge(it.open_blockers, true) +
      (it.blocks.length ? '<a class="badge blocks" href="/item/' + it.blocks[0].id + '" data-nav title="' + esc("Blocks " + it.blocks.map((b) => dref(b.id)).join(", ")) + '">Blocks ' +
        dref(it.blocks[0].id) + (it.blocks.length > 1 ? " +" + (it.blocks.length - 1) : "") + "</a>" : "") +
      kindBadge(it) + dueBadge(it) + prioBadge(it.priority) + badge("tag", it.project) +
      '<span class="meta">' + dref(it.id) + " · opened " + timeEl(it.created) + (it.updated !== it.created ? " · updated " + timeEl(it.updated) : "") + "</span></div>";
    h += '<div class="qbody md" id="qbody">' + (it.body ? MD.render(it.body) : '<p class="muted">(no description)</p>') + "</div>" +
      '<button type="button" class="link qmore" id="qmore" hidden>Show more</button>';
    if (itemAtts.length) h += '<div class="qatts">' + renderAtts(itemAtts, () => false, () => "") + "</div>";
    if (prs.length) h += '<p class="qprs">' + prs.map((x) => '<a class="ref ref-x" href="' + esc(x.url) + '" target="_blank" rel="noopener noreferrer">' + esc(x.type === "pr" ? "PR " + x.label : x.label) + " ↗</a>").join("") + "</p>";
    if (asst.length) {
      h += '<div class="qcomments"><h3>Latest from the assistant</h3>' + asst.map((c) => '<div class="comment assistant"><div class="ch"><strong>Assistant</strong> ' + timeEl(c.created) + "</div>" +
        (c.body ? '<div class="md">' + MD.render(c.body) + "</div>" : "") +
        (c.attachments && c.attachments.length ? '<div class="catts">' + renderAtts(c.attachments, () => false, () => "") + "</div>" : "") + "</div>").join("") + "</div>";
    }
    if (last) {
      const lab = Object.fromEntries(opts.map((o) => [o.key, o.label]));
      h += '<div class="qprev"><span class="muted">Your answer ' + timeEl(last.created) + ":</span> " +
        esc(last.choices.map((k) => lab[k] || k).join(", ") || "") + (last.text ? ' <span class="muted">"' + esc(last.text.slice(0, 120)) + (last.text.length > 120 ? "…" : "") + '"</span>' : "") + "</div>";
    }
    if (opts.length) {
      const type = it.multi ? "checkbox" : "radio";
      h += '<fieldset class="opts qopts"><legend>' + (it.multi ? "Pick any that apply" : "Pick one") + "</legend>" +
        opts.map((o, i) => '<label class="opt' + (o.recommended ? " rec" : "") + '"><input type="' + type + '" name="qchoice" value="' + esc(o.key) + '">' +
          '<span class="ot"><span class="ol">' + (i < 9 ? "<kbd>" + (i + 1) + "</kbd> " : "") + MD.inline(o.label) + (o.recommended ? ' <span class="badge rec">recommended</span>' : "") + "</span>" +
          (o.description ? '<span class="od md">' + MD.render(o.description) + "</span>" : "") + "</span></label>").join("") + "</fieldset>";
    }
    h += '<label class="fl" for="q-text">' + (opts.length || isTodo ? "Add a note (optional)" : it.kind === "workstream" ? "Reply" : "Your answer or comment") + "</label>" +
      '<textarea id="q-text" rows="3" placeholder="' + (isTodo ? "Optional note for the agent. Paste or drop images. Ctrl+Enter = Done." : "Prose answer or comment. Paste or drop images. Ctrl+Enter submits.") + '"></textarea>' +
      '<div class="qpickrow"><span class="cpickhost" id="q-pick"></span>' +
      (isTodo ? '<button type="button" class="ghost small" id="q-noteonly" title="Send the note but leave the TODO open">Send note only</button>' : "") + "</div>" +
      "</form>";
    stage.innerHTML = h;
    const card = $("#q-form");
    if (dir) { card.classList.add("enter-" + dir); requestAnimationFrame(() => requestAnimationFrame(() => card.classList.remove("enter-" + dir))); }
    // collapse long bodies to a readable peek
    const body = $("#qbody");
    if (body.scrollHeight > BODY_PEEK_PX + 40) {
      body.classList.add("peek");
      const more = $("#qmore");
      more.hidden = false;
      more.onclick = () => { const p = body.classList.toggle("peek"); more.textContent = p ? "Show more" : "Show less"; };
    }
    Q.composer = composer($("#q-text"), { pickHost: $("#q-pick"), pickLabel: "Add image" });
    if (Q.restore && Q.restore.id === it.id) {
      $("#q-text").value = Q.restore.text || "";
      $$('input[name="qchoice"]', card).forEach((x) => (x.checked = (Q.restore.choices || []).includes(x.value)));
    }
    Q.restore = null;
    card.onsubmit = (e) => { e.preventDefault(); submitCard("button"); };
    const no = $("#q-noteonly");
    if (no) no.onclick = () => submitCard("note");
    // image viewer over every image of the item
    const images = it.attachments.filter((a) => a.kind === "file" && a.render === "image").map((a) => ({ id: a.id, href: a.href, label: a.label }));
    $$(".thumb", card).forEach((b) => (b.onclick = () => { const i = images.findIndex((x) => x.id === +b.dataset.id); if (i >= 0) Viewer.open(images, i); }));
    wireSwipe(card);
    // warm the next card
    const nx = Q.list[Q.pos + 1];
    if (nx && !Q.cache.has(nx.id)) loadItem(nx.id, false).catch(() => {});
    refreshQueueCount();
  }

  function renderDone() {
    $("#qactions").hidden = true;
    const ww = $(".qwaitwrap");
    if (ww) ww.hidden = true; // the done screen lists them itself
    const st = Q.stats, again = Q.list.filter((s) => Q.snoozedNow.has(s.id) && !s.handled).length;
    $("#qstage").innerHTML = '<div class="qdone"><div class="qcheck" aria-hidden="true">✓</div><h2>All caught up</h2>' +
      '<p class="qsum"><span><strong>' + (st.answered + st.approved) + "</strong> answered</span>" +
      (st.approved ? "<span><strong>" + st.approved + "</strong> approved by swipe</span>" : "") +
      "<span><strong>" + st.commented + "</strong> commented</span>" +
      (st.done ? "<span><strong>" + st.done + "</strong> to-dos done</span>" : "") +
      "<span><strong>" + st.snoozed + "</strong> snoozed</span></p>" +
      (again ? '<p><button type="button" class="ghost" id="q-again">Go through the ' + again + " snoozed again</button></p>" : "") +
      waitingBlock() +
      '<p class="qdonelinks"><a href="/" data-nav>Back to the inbox</a><a href="/projects" data-nav>Projects</a></p></div>';
    const ag = $("#q-again");
    if (ag) ag.onclick = () => { Q.snoozedNow.clear(); Q.pos = Q.list.findIndex((s) => !s.handled); if (Q.pos < 0) Q.pos = Q.list.length; renderCard(); };
    refreshQueueCount();
  }

  // ---- actions
  function cardInput() {
    const card = $("#q-form");
    if (!card) return null;
    return {
      choices: $$('input[name="qchoice"]:checked', card).map((x) => x.value),
      text: $("#q-text").value.trim(),
      files: Q.composer ? Q.composer.files() : [],
    };
  }
  function fly(dir) {
    const card = $("#q-form");
    if (card) { card.style.transform = ""; card.classList.add("fly-" + dir); }
    return new Promise((r) => setTimeout(r, 260));
  }
  function wiggle(msg) {
    const card = $("#q-form");
    if (card) { card.classList.remove("wiggle"); void card.offsetWidth; card.classList.add("wiggle"); card.style.transform = ""; }
    toast(msg, "err");
  }

  function qToast(msg, ms, onUndo) {
    const t = $("#qtoast");
    if (!t) return;
    clearTimeout(t._h);
    $(".qtmsg", t).textContent = msg;
    $(".qtundo", t).hidden = !onUndo;
    if (typeof onUndo === "function") $(".qtundo", t).onclick = () => { hideQToast(); onUndo(); };
    const bar = $(".qtbar", t);
    bar.style.transition = "none";
    bar.style.transform = "scaleX(1)";
    t.hidden = false;
    requestAnimationFrame(() => { bar.style.transition = "transform " + ms + "ms linear"; bar.style.transform = "scaleX(0)"; });
    t._h = setTimeout(() => { t.hidden = true; }, ms);
  }
  function hideQToast() { const t = $("#qtoast"); if (t) { clearTimeout(t._h); t.hidden = true; } }

  async function flushPending() {
    // Commit a swipe-approval now (leaving the queue, tab hidden, or another action).
    const p = Q.pending;
    if (!p) return;
    Q.pending = null;
    clearTimeout(p.timer);
    try {
      const a = await api("/api/items/" + p.id + "/answer", { method: "POST", json: { choices: p.choices, text: "" } });
      Q.undo = { type: "answer", rid: a.id, idx: p.idx, id: p.id, snoozed_at: p.snoozed_at, draft: { choices: [], text: "" }, stat: "approved" };
    } catch (e) {
      // put it back so nothing is silently lost
      const s = Q.list[p.idx];
      if (s) s.handled = null;
      Q.stats.approved--;
      toast("Approval of " + dref(p.id) + " failed: " + e.message, "err");
      if (state.view === "queue") qProgress();
    }
  }

  async function submitCard(how) {
    if (Q.busy || qFinished()) return;
    const inp = cardInput();
    const it = Q.item, s = Q.list[Q.pos];
    if (!inp || !it || !s) return;
    if (it.kind === "todo" && how !== "note") return doneCard(it, s, inp);
    if (!inp.choices.length && !inp.text && !inp.files.length) {
      const rec = (it.options || []).filter((o) => o.recommended);
      if (how === "swipe" && rec.length) return approve(it, s, it.multi ? rec : rec.slice(0, 1));
      return wiggle(it.options && it.options.length ? "Pick an option or write something first" : "Write a reply first");
    }
    if (!it.multi && inp.choices.length > 1) return wiggle("Pick just one");
    Q.busy = true;
    await flushPending();
    const btn = $("#q-submit");
    btn.disabled = true;
    try {
      let undoRec;
      if (inp.choices.length) {
        const fd = new FormData();
        inp.choices.forEach((c) => fd.append("choice", c));
        fd.append("text", inp.text);
        inp.files.forEach((f) => fd.append("file", f, f.name));
        const a = await api("/api/items/" + it.id + "/answer", { method: "POST", body: fd });
        undoRec = { type: "answer", rid: a.id, stat: "answered" };
      } else {
        let c;
        if (inp.files.length) {
          const fd = new FormData();
          fd.append("body", inp.text);
          fd.append("author", "owner");
          inp.files.forEach((f) => fd.append("file", f, f.name));
          c = await api("/api/items/" + it.id + "/comments", { method: "POST", body: fd });
        } else {
          c = await api("/api/items/" + it.id + "/comments", { method: "POST", json: { body: inp.text, author: "owner" } });
        }
        undoRec = { type: "comment", rid: c.id, stat: "commented" };
      }
      Q.stats[undoRec.stat]++;
      s.handled = undoRec.stat;
      Q.cache.delete(it.id);
      Q.undo = Object.assign(undoRec, { idx: Q.pos, id: it.id, snoozed_at: s.snoozed_at, draft: { choices: inp.choices, text: inp.text } });
      await fly("right");
      qToast((undoRec.type === "answer" ? "Submitted" : "Comment sent") + " — " + dref(it.id), UNDO_MS, true);
      Q.pos++;
      renderCard("right");
    } catch (e) {
      toast("Failed: " + e.message, "err");
      btn.disabled = false;
    } finally {
      Q.busy = false;
      const b = $("#q-submit");
      if (b) b.disabled = false;
    }
  }

  async function postNote(it, inp) {
    if (!inp.text && !inp.files.length) return null;
    if (inp.files.length) {
      const fd = new FormData();
      fd.append("body", inp.text);
      fd.append("author", "owner");
      inp.files.forEach((f) => fd.append("file", f, f.name));
      return api("/api/items/" + it.id + "/comments", { method: "POST", body: fd });
    }
    return api("/api/items/" + it.id + "/comments", { method: "POST", json: { body: inp.text, author: "owner" } });
  }

  async function doneCard(it, s, inp) {
    // TODO card: (optional note as a comment) + mark done, then move on; Undo reopens.
    Q.busy = true;
    await flushPending();
    const btn = $("#q-submit");
    btn.disabled = true;
    try {
      const c = await postNote(it, inp);
      await api("/api/items/" + it.id + "/done", { method: "POST", json: {} });
      Q.stats.done++;
      s.handled = "done";
      Q.cache.delete(it.id);
      Q.undo = { type: "done", id: it.id, idx: Q.pos, rid: c ? c.id : null, snoozed_at: s.snoozed_at, draft: { choices: [], text: inp.text }, stat: "done" };
      await fly("right");
      qToast("Done — " + dref(it.id), UNDO_MS, true);
      Q.pos++;
      renderCard("right");
    } catch (e) {
      toast("Failed: " + e.message, "err");
    } finally {
      Q.busy = false;
      const b = $("#q-submit");
      if (b) b.disabled = false;
    }
  }

  async function approve(it, s, recs) {
    // Swipe right with nothing chosen: approve the recommended option(s), but only
    // after a short window in which Undo cancels it (nothing is sent until then).
    await flushPending();
    const idx = Q.pos;
    $$('input[name="qchoice"]', $("#q-form")).forEach((x) => (x.checked = recs.some((r) => r.key === x.value)));
    Q.stats.approved++;
    s.handled = "approved";
    Q.pending = { id: it.id, idx, choices: recs.map((r) => r.key), snoozed_at: s.snoozed_at, timer: setTimeout(flushPending, APPROVE_MS) };
    Q.undo = { type: "pending", idx, id: it.id };
    await fly("right");
    qToast("Approving: " + recs.map((r) => r.label).join(", ") + " — " + dref(it.id), APPROVE_MS, true);
    Q.pos++;
    renderCard("right");
  }

  async function snooze() {
    if (Q.busy || qFinished()) return;
    const s = Q.list[Q.pos];
    if (!s) return;
    Q.busy = true;
    try {
      await flushPending();
      const r = await api("/api/items/" + s.id + "/snooze", { method: "POST", json: {} });
      const inp = cardInput();
      const from = Q.pos;
      Q.list.splice(from, 1);
      s.snoozed_at = r.snoozed_at;
      Q.list.push(s);
      Q.snoozedNow.add(s.id);
      Q.stats.snoozed++;
      Q.undo = { type: "snooze", id: s.id, idx: from, previous: r.previous, draft: inp };
      await fly("left");
      qToast("Snoozed " + dref(s.id) + " — moved to the back", UNDO_MS, true);
      renderCard("left");
    } catch (e) { toast("Snooze failed: " + e.message, "err"); }
    finally { Q.busy = false; }
  }

  async function undo() {
    const u = Q.undo;
    if (!u || Q.busy) return;
    Q.undo = null;
    hideQToast();
    Q.busy = true;
    try {
      if (u.type === "pending") {
        const p = Q.pending;
        if (p && p.id === u.id) { clearTimeout(p.timer); Q.pending = null; }
        Q.stats.approved--;
        Q.list[u.idx].handled = null;
        Q.pos = u.idx;
        toast("Approval cancelled");
      } else if (u.type === "snooze") {
        await api("/api/items/" + u.id + "/snooze", { method: "POST", json: { snoozed_at: u.previous } });
        const i = Q.list.findIndex((x) => x.id === u.id);
        const [s] = Q.list.splice(i, 1);
        s.snoozed_at = u.previous;
        Q.list.splice(u.idx, 0, s);
        Q.snoozedNow.delete(u.id);
        Q.stats.snoozed--;
        Q.pos = u.idx;
        Q.restore = Object.assign({ id: u.id }, u.draft || {});
        toast("Snooze undone");
      } else if (u.type === "done") {
        await api("/api/items/" + u.id + "/reopen", { method: "POST", json: {} });
        if (u.rid) await api("/api/comments/" + u.rid + "/retract", { method: "POST", json: { snoozed_at: u.snoozed_at || "" } });
        else if (u.snoozed_at) await api("/api/items/" + u.id + "/snooze", { method: "POST", json: { snoozed_at: u.snoozed_at } });
        Q.stats.done--;
        Q.list[u.idx].handled = null;
        Q.pos = u.idx;
        Q.cache.delete(u.id);
        Q.restore = Object.assign({ id: u.id }, u.draft);
        toast("Reopened " + dref(u.id));
      } else {
        await api("/api/" + (u.type === "answer" ? "answers" : "comments") + "/" + u.rid + "/retract", { method: "POST", json: { snoozed_at: u.snoozed_at || "" } });
        Q.stats[u.stat]--;
        Q.list[u.idx].handled = null;
        Q.pos = u.idx;
        Q.cache.delete(u.id);
        Q.restore = Object.assign({ id: u.id }, u.draft);
        toast(u.type === "answer" ? "Answer withdrawn" : "Comment withdrawn");
      }
      renderCard("left");
    } catch (e) { toast("Undo failed: " + e.message, "err"); }
    finally { Q.busy = false; }
  }

  async function move(d) {
    if (Q.busy) return;
    const to = Q.pos + d;
    if (to < 0 || to >= Q.list.length) return;
    await flushPending();
    Q.pos = to;
    renderCard(d > 0 ? "right" : "left");
  }

  // ---- swipe (touch / pen; mouse users have the buttons and keys)
  function wireSwipe(card) {
    let st = null;
    card.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" || e.target.closest("textarea, input, button, a, .opts, .thumb")) return;
      st = { x: e.clientX, y: e.clientY, id: e.pointerId, horiz: null };
    });
    card.addEventListener("pointermove", (e) => {
      if (!st || e.pointerId !== st.id) return;
      const dx = e.clientX - st.x, dy = e.clientY - st.y;
      if (st.horiz === null && Math.hypot(dx, dy) > 12) {
        st.horiz = Math.abs(dx) > Math.abs(dy) * 1.3;
        if (st.horiz) { try { card.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } card.classList.add("dragging"); }
      }
      if (!st.horiz) return;
      card.style.transform = "translateX(" + dx + "px) rotate(" + dx / 24 + "deg)";
      const k = Math.min(1, Math.abs(dx) / (card.offsetWidth * 0.3));
      card.style.setProperty("--hl", dx < 0 ? k : 0);
      card.style.setProperty("--hr", dx > 0 ? k : 0);
    });
    const end = (e) => {
      if (!st || e.pointerId !== st.id) return;
      const dx = e.clientX - st.x, horiz = st.horiz;
      st = null;
      card.classList.remove("dragging");
      card.style.setProperty("--hl", 0);
      card.style.setProperty("--hr", 0);
      if (!horiz) return;
      const th = card.offsetWidth * 0.3;
      if (dx < -th) snooze();
      else if (dx > th) submitCard("swipe");
      else card.style.transform = "";
    };
    card.addEventListener("pointerup", end);
    card.addEventListener("pointercancel", (e) => { if (st && e.pointerId === st.id) { st = null; card.classList.remove("dragging"); card.style.transform = ""; } });
  }

  function queueKey(e, k, t) {
    // returns true when handled
    if (k === "Escape") { go("/"); return true; }
    if (k === "s" || k === "S") { snooze(); return true; }
    if (k === "u" || k === "U") { undo(); return true; }
    if (k === "ArrowLeft") { move(-1); return true; }
    if (k === "ArrowRight") { move(1); return true; }
    if (k === "Enter" && !t.closest("a, button, summary")) { submitCard("button"); return true; }
    if (/^[1-9]$/.test(k)) {
      const box = $$('#q-form input[name="qchoice"]')[+k - 1];
      if (box) { box.checked = box.type === "radio" ? true : !box.checked; return true; }
    }
    return false;
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushPending(); });
  window.addEventListener("pagehide", () => flushPending());

  // ------------------------------------------------------------- keyboard
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    const typing = t.matches && t.matches("input[type=text], input[type=search], input:not([type]), textarea, select, [contenteditable]");
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && t.form) {
      e.preventDefault();
      t.form.requestSubmit();
      return;
    }
    if (e.key === "Escape" && typing) { t.blur(); return; }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if ($("dialog[open]")) return;
    const k = e.key;
    if (k === "?") { $("#help").showModal(); e.preventDefault(); return; }
    if (state.view === "queue" && queueKey(e, k, t)) { e.preventDefault(); return; }
    if ((k === "q" || k === "Q") && state.view !== "queue") { e.preventDefault(); go("/queue"); return; }
    if (k === "T" && state.view !== "todo") { e.preventDefault(); go("/todo"); return; }
    if (k === "P" && state.view !== "new") { go("/projects"); return; }
    if (k === "N" && state.view !== "new") { e.preventDefault(); go("/new"); return; }
    if (state.view === "inbox") {
      const n = state.list.length;
      if (k === "j" && n) { state.cursor = Math.min(n - 1, state.cursor + 1); markCursor(true); }
      else if (k === "k" && n) { state.cursor = Math.max(0, state.cursor - 1); markCursor(true); }
      else if ((k === "Enter" || k === "o") && n && !t.closest("a,button")) go("/item/" + state.list[state.cursor]);
      else if (k === "/") { e.preventDefault(); $("#q").focus(); }
      else return;
      e.preventDefault();
    } else if (state.view === "item") {
      if (k === "u" || k === "Escape") go("/");
      else if (k === "a") { const f = $("#ans-form"); if (f) { e.preventDefault(); f.classList.remove("collapsed"); $("#ans-text").focus(); } }
      else if (k === "c") { e.preventDefault(); $("#cmt-text").focus(); }
      else if (/^[1-9]$/.test(k)) {
        const box = $$('#ans-form input[name="choice"]')[+k - 1];
        if (box) { $("#ans-form").classList.remove("collapsed"); box.checked = box.type === "radio" ? true : !box.checked; box.focus(); }
      } else if (k === "n" || k === "p") {
        const idx = state.list.indexOf(state.item && state.item.id);
        const to = state.list[idx + (k === "n" ? 1 : -1)];
        if (idx >= 0 && to) { state.cursor = idx + (k === "n" ? 1 : -1); go("/item/" + to); }
      }
    } else if (state.view === "todo" && (k === "u" || k === "U")) {
      if (T.undo) { const u = T.undo; T.undo = null; toggleTodo(u.id, !u.makeDone, $('.tcheck[data-id="' + u.id + '"]')); }
    } else if ((state.view === "projects" || state.view === "ref" || state.view === "todo") && (k === "u" || k === "Escape")) go("/");
  });
  $("#help-btn").onclick = () => $("#help").showModal();

  api("/api/config").then((c) => { Object.assign(CFG, c); MD.configure(c); })
    .catch(() => { /* reference linking stays off */ }).finally(route);
})();

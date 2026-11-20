// Image viewer for attachments: prev/next, and 2D-CAD-style zoom + pan.
//
//   Viewer.open(images, index)   images = [{id, href, label}], in attachment order
//
// Model: the <img> sits at its natural pixel size, top-left at the stage origin,
// and is placed with transform: translate(tx, ty) scale(s). Zooming "about" a
// stage point (px, py) keeps the image pixel under that point fixed:
//   tx' = px - (px - tx) * k,  ty' = py - (py - ty) * k,  s' = s * k
(function () {
  "use strict";
  const MIN_OF_FIT = 0.1;   // can zoom out to 10 % of fit-to-screen
  const MAX_PIXEL = 32;     // ... and in to 32 screen px per image px
  const PIXELATED_AT = 4;   // crisp (nearest-neighbour) pixels from 400 %
  const SWIPE_PX = 60;      // horizontal travel that counts as a swipe
  const DOUBLE_TAP_MS = 300;

  let dlg, stage, img, posEl, capEl, zoomEl, dlEl, prevBtn, nextBtn, loadingEl;
  let list = [], idx = 0;
  let s = 1, tx = 0, ty = 0, fit = 1, natW = 0, natH = 0;
  let atFit = true;          // track "fit" so a resize refits
  let shown = "";            // src already fitted (cached images fire load twice)
  const ptrs = new Map();    // pointerId -> {x, y, type}
  let gesture = null;        // {kind: "pan"|"pinch"|"swipe", ...}
  let lastTap = { t: 0, x: 0, y: 0 };

  function build() {
    dlg = document.createElement("dialog");
    dlg.className = "viewer";
    dlg.setAttribute("aria-label", "Image viewer");
    dlg.innerHTML =
      '<div class="vbar">' +
      '<span class="vpos" aria-live="polite"></span><span class="vcap"></span>' +
      '<div class="vtools">' +
      '<button type="button" class="vbtn vzbtn" data-act="out" aria-label="Zoom out" title="Zoom out (-)">−</button>' +
      '<span class="vzoom" title="Zoom (1 = 100 %, 0 = fit)"></span>' +
      '<button type="button" class="vbtn vzbtn" data-act="in" aria-label="Zoom in" title="Zoom in (+)">+</button>' +
      '<button type="button" class="vbtn" data-act="fit" title="Fit to screen (0 or f)">Fit</button>' +
      '<a class="vbtn vdl" download title="Download">Download</a>' +
      '<button type="button" class="vbtn vclose" data-act="close" aria-label="Close" title="Close (Esc)">✕</button>' +
      "</div></div>" +
      '<div class="vstage"><img class="vimg" alt="" draggable="false"><p class="vloading">Loading…</p></div>' +
      '<button type="button" class="vnav vprev" data-act="prev" aria-label="Previous image" title="Previous (←)">‹</button>' +
      '<button type="button" class="vnav vnext" data-act="next" aria-label="Next image" title="Next (→)">›</button>';
    document.body.appendChild(dlg);
    stage = dlg.querySelector(".vstage");
    img = dlg.querySelector(".vimg");
    posEl = dlg.querySelector(".vpos");
    capEl = dlg.querySelector(".vcap");
    zoomEl = dlg.querySelector(".vzoom");
    dlEl = dlg.querySelector(".vdl");
    prevBtn = dlg.querySelector(".vprev");
    nextBtn = dlg.querySelector(".vnext");
    loadingEl = dlg.querySelector(".vloading");

    dlg.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      const act = b.dataset.act;
      if (act === "close") close();
      else if (act === "prev") step(-1);
      else if (act === "next") step(1);
      else if (act === "in") zoomBy(1.5, center(), true);
      else if (act === "out") zoomBy(1 / 1.5, center(), true);
      else if (act === "fit") fitView(true);
    });
    dlg.addEventListener("close", onClosed);
    dlg.addEventListener("keydown", onKey);
    stage.addEventListener("wheel", onWheel, { passive: false });
    stage.addEventListener("pointerdown", onDown);
    stage.addEventListener("pointermove", onMove);
    stage.addEventListener("pointerup", onUp);
    stage.addEventListener("pointercancel", onUp);
    stage.addEventListener("dblclick", (e) => { e.preventDefault(); toggleFit(local(e)); });
    stage.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });
    img.addEventListener("load", onLoad);
    window.addEventListener("resize", () => { if (dlg.open) { computeFit(); if (atFit) fitView(false); else apply(); } });
  }

  // ------------------------------------------------------------ navigation
  function open(images, index) {
    if (!images || !images.length) return;
    if (!dlg) build();
    list = images;
    idx = Math.max(0, Math.min(index || 0, list.length - 1));
    if (!dlg.open) dlg.showModal();
    show();
  }
  function step(d) {
    if (list.length < 2) return;
    idx = (idx + d + list.length) % list.length; // wraps at the ends
    show();
  }
  function show() {
    const a = list[idx];
    posEl.textContent = list.length > 1 ? idx + 1 + " / " + list.length : "";
    capEl.textContent = a.label || "";
    capEl.title = a.label || "";
    dlEl.href = a.href;
    prevBtn.hidden = nextBtn.hidden = list.length < 2;
    natW = natH = 0;
    shown = "";
    img.classList.remove("ready");
    loadingEl.hidden = false;
    img.src = a.href;
    if (img.complete && img.naturalWidth) onLoad();
    try { history.replaceState(history.state, "", location.pathname + location.search + "#att-" + a.id); } catch (e) { /* ignore */ }
    // warm the neighbours so arrowing through is instant
    [idx - 1, idx + 1].forEach((j) => { const n = list[(j + list.length) % list.length]; if (n) new Image().src = n.href; });
  }
  function onLoad() {
    // A cached image is complete right after src= (handled synchronously in show())
    // AND still fires "load" later; fit only once, or a late load undoes the user's zoom.
    if (!img.naturalWidth || shown === img.src) return;
    shown = img.src;
    natW = img.naturalWidth;
    natH = img.naturalHeight;
    loadingEl.hidden = true;
    img.classList.add("ready");
    computeFit();
    fitView(false);
  }
  function close() { if (dlg && dlg.open) dlg.close(); }
  function onClosed() {
    ptrs.clear();
    gesture = null;
    if (/^#att-\d+$/.test(location.hash)) {
      try { history.replaceState(history.state, "", location.pathname + location.search); } catch (e) { /* ignore */ }
    }
  }

  // -------------------------------------------------------------- geometry
  const rect = () => stage.getBoundingClientRect();
  const center = () => { const r = rect(); return { x: r.width / 2, y: r.height / 2 }; };
  const local = (e) => { const r = rect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  function computeFit() {
    const r = rect();
    fit = natW && natH ? Math.min(r.width / natW, r.height / natH) : 1;
  }
  const minS = () => fit * MIN_OF_FIT;
  const maxS = () => Math.max(MAX_PIXEL, fit);
  function apply(animate) {
    // keep at least 48 px of the image on screen so it can't be lost
    const r = rect(), w = natW * s, h = natH * s, m = 48;
    tx = Math.min(r.width - m, Math.max(m - w, tx));
    ty = Math.min(r.height - m, Math.max(m - h, ty));
    img.classList.toggle("anim", !!animate);
    img.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + s + ")";
    img.classList.toggle("px", s >= PIXELATED_AT);
    zoomEl.textContent = Math.round(s * 100) + "%";
  }
  function fitView(animate) {
    const r = rect();
    s = fit;
    tx = (r.width - natW * s) / 2;
    ty = (r.height - natH * s) / 2;
    atFit = true;
    apply(animate);
  }
  function zoomBy(k, p, animate) {
    if (!natW) return;
    const ns = Math.min(maxS(), Math.max(minS(), s * k));
    k = ns / s;
    tx = p.x - (p.x - tx) * k;
    ty = p.y - (p.y - ty) * k;
    s = ns;
    atFit = false;
    apply(animate);
  }
  const zoomTo = (target, p, animate) => zoomBy(target / s, p, animate);
  function toggleFit(p) {
    if (Math.abs(s - fit) / fit < 0.02) {
      // at fit: go to 100 % at that point (or 4x if the image already fits at ~100 %)
      zoomTo(Math.abs(fit - 1) < 0.05 ? 4 : 1, p, true);
    } else fitView(true);
  }
  function panBy(dx, dy) { tx += dx; ty += dy; atFit = false; apply(false); }

  // ----------------------------------------------------------------- wheel
  // Every wheel event zooms about the pointer (owner's choice): trackpad
  // two-finger scroll, trackpad pinch (reported as wheel + ctrlKey) and mouse
  // wheel all zoom. Panning is click-and-drag (or touch drag).
  // Kept as a function so tests and callers have one place to ask.
  function wheelIsZoom(e) { return true; }
  function onWheel(e) {
    e.preventDefault();
    if (!natW) return;
    // Use the dominant axis so a slightly diagonal two-finger scroll still zooms.
    const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    // normalise to pixels: one line ~ 33 px, one page ~ the stage height
    const px = e.deltaMode === 1 ? d * 33 : e.deltaMode === 2 ? d * rect().height : d;
    // pinch deltas are small and frequent; a mouse notch (100 px) ~ 1.2x;
    // a two-finger scroll sends many small deltas, so it zooms smoothly.
    const k = Math.exp(-px * (e.ctrlKey ? 0.01 : 0.0018));
    zoomBy(k, local(e), false);
  }

  // --------------------------------------------------------------- pointer
  const zoomed = () => s > fit * 1.02;
  function pinchInfo() {
    const [a, b] = [...ptrs.values()];
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
  }
  function onDown(e) {
    if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 1) return;
    if (e.button === 1) e.preventDefault(); // no autoscroll on middle-drag
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* synthetic or already gone */ }
    ptrs.set(e.pointerId, Object.assign(local(e), { type: e.pointerType }));
    if (ptrs.size === 2) {
      const p = pinchInfo();
      gesture = { kind: "pinch", cx: p.cx, cy: p.cy, d: p.d };
    } else if (ptrs.size === 1) {
      const p = local(e);
      if (e.pointerType === "touch" && !zoomed()) gesture = { kind: "swipe", x0: p.x, y0: p.y, x: p.x, y: p.y, tx0: tx };
      else gesture = { kind: "pan", x: p.x, y: p.y };
      stage.classList.add("grabbing");
    }
  }
  function onMove(e) {
    if (!ptrs.has(e.pointerId)) return;
    const p = local(e);
    ptrs.set(e.pointerId, Object.assign(p, { type: e.pointerType }));
    if (!gesture) return;
    if (gesture.kind === "pinch" && ptrs.size >= 2) {
      const q = pinchInfo();
      // pinch zooms about the (previous) pinch centre, then the centre's movement
      // pans: the image point under the fingers stays under the fingers.
      zoomBy(q.d / gesture.d, { x: gesture.cx, y: gesture.cy }, false);
      panBy(q.cx - gesture.cx, q.cy - gesture.cy);
      Object.assign(gesture, { cx: q.cx, cy: q.cy, d: q.d });
    } else if (gesture.kind === "pan") {
      panBy(p.x - gesture.x, p.y - gesture.y);
      gesture.x = p.x;
      gesture.y = p.y;
    } else if (gesture.kind === "swipe") {
      gesture.x = p.x;
      gesture.y = p.y;
      // follow the finger a little so the swipe feels physical
      img.classList.remove("anim");
      img.style.transform = "translate(" + (gesture.tx0 + (p.x - gesture.x0) * 0.6) + "px," + ty + "px) scale(" + s + ")";
    }
  }
  function onUp(e) {
    if (!ptrs.has(e.pointerId)) return;
    const p = local(e);
    ptrs.delete(e.pointerId);
    if (gesture && gesture.kind === "swipe") {
      const dx = gesture.x - gesture.x0, dy = gesture.y - gesture.y0;
      if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > 1.5 * Math.abs(dy) && list.length > 1) step(dx < 0 ? 1 : -1);
      else apply(true); // snap back
      if (Math.hypot(dx, dy) < 10) tapped(p);
    } else if (gesture && gesture.kind === "pan" && e.pointerType === "touch") {
      tapped(p);
    }
    if (ptrs.size === 1) {
      // pinch -> one finger left: keep panning with it
      const q = [...ptrs.values()][0];
      gesture = { kind: "pan", x: q.x, y: q.y };
    } else if (!ptrs.size) {
      gesture = null;
      stage.classList.remove("grabbing");
    }
  }
  function tapped(p) {
    // double tap toggles fit <-> 100 % at that point (mouse uses dblclick)
    const now = Date.now();
    if (now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) {
      lastTap.t = 0;
      toggleFit(p);
    } else lastTap = { t: now, x: p.x, y: p.y };
  }

  // -------------------------------------------------------------- keyboard
  function onKey(e) {
    const t = e.target;
    if (t && t.matches && t.matches("input, textarea, select, [contenteditable]")) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    let used = true;
    if (k === "ArrowLeft") step(-1);
    else if (k === "ArrowRight") step(1);
    else if (k === "+" || k === "=") zoomBy(1.5, center(), true);
    else if (k === "-" || k === "_") zoomBy(1 / 1.5, center(), true);
    else if (k === "0" || k === "f") fitView(true);
    else if (k === "1") zoomTo(1, center(), true);
    else used = false; // Esc: the dialog's own cancel closes it
    if (used) { e.preventDefault(); e.stopPropagation(); }
  }

  window.Viewer = { open, close, wheelIsZoom };
})();

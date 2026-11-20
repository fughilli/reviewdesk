// Browser test for owner TODOs: checklist (tick, undo, done section) and TODO
// cards in the review queue (Done, undo, note only, swipe). Throwaway project;
// node todo_test.js BASE [shotdir]   (tests/browser/run.js starts a throwaway server)
const { launch, png, client } = require("./lib");
const B = process.argv[2] || "http://127.0.0.1:8471";
const SHOTS = process.argv[3] || "";
let fails = 0;
const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) fails++; };
async function J(method, path, body) {
  const r = await fetch(B + path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { return t; }
}
const PROJ = "ttest" + Date.now().toString(36);
const created = [];
const mk = async (title, extra) => { const it = await J("POST", "/api/items", Object.assign({ title, project: PROJ, kind: "todo" }, extra)); created.push(it.id); return it; };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const tomorrow = new Date(Date.now() + 86400e3).toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86400e3).toISOString().slice(0, 10);

(async () => {
  const browser = await launch();
  try {
    for (const [sz, vp] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]]) {
      console.log(sz);
      for (const id of created.splice(0)) await J("DELETE", "/api/items/" + id);
      const a = await mk("Approve the staging cloud account", { priority: "blocking", due: tomorrow, body: "The deploy job needs it. See D-1." });
      const b = await mk("Rotate the shared test API key", { priority: "soon", due: yesterday, body: "The old one expires this week." });
      const c = await mk("Try the new onboarding flow on a phone and report", { priority: "whenever" });
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor || 1 });
      const p = await ctx.newPage();
      p.on("pageerror", (e) => { fails++; console.log("  pageerror", e.message); });

      // ---- checklist
      await p.goto(B + "/todo?project=" + PROJ, { waitUntil: "networkidle" });
      const rows = await p.$$eval(".tgroup .trow", (els) => els.map((e) => +e.dataset.id));
      ok(JSON.stringify(rows) === JSON.stringify([a.id, b.id, c.id]), "checklist sorted by priority then due: " + rows.join(","));
      ok(/overdue/.test(await p.textContent('.trow[data-id="' + b.id + '"]')), "overdue due date flagged");
      ok(/To do\s*\d+/.test(await p.textContent('.topnav a[data-view="todo"]')), "header has a To do tab with a count");
      if (SHOTS) await p.screenshot({ path: SHOTS + "/todo-list-" + sz + ".png", fullPage: true });
      await p.click('.tcheck[data-id="' + a.id + '"]');
      await p.locator("#qtoast:not([hidden])").waitFor();
      ok((await J("GET", "/api/items/" + a.id)).status === "done", "tapping the circle marks it done");
      ok(/Done — D-/.test(await p.textContent("#qtoast .qtmsg")), "Done toast with Undo");
      ok((await p.locator('.tdone .trow[data-id="' + a.id + '"]').count()) === 1 && !(await p.locator(".tdone").getAttribute("open")), "moves to the collapsed Done section");
      if (SHOTS) await p.screenshot({ path: SHOTS + "/todo-done-undo-" + sz + ".png" });
      await p.click("#qtoast .qtundo");
      await pause(900);
      ok((await J("GET", "/api/items/" + a.id)).status === "open", "Undo reopens it");
      ok((await p.locator('.tgroup .trow[data-id="' + a.id + '"]').count()) === 1, "back in the open list");
      await p.click('.tcheck[data-id="' + c.id + '"]');
      await pause(900);
      await p.keyboard.press("u");
      await pause(900);
      ok((await J("GET", "/api/items/" + c.id)).status === "open", "u undoes the last tick");
      // reopen from the Done section
      await J("POST", "/api/items/" + c.id + "/done", {});
      await p.reload({ waitUntil: "networkidle" });
      await p.click(".tdone summary");
      await p.click('.tdone .tcheck[data-id="' + c.id + '"]');
      await pause(900);
      ok((await J("GET", "/api/items/" + c.id)).status === "open", "tapping a done item reopens it");

      // ---- item page
      await p.goto(B + "/item/" + b.id, { waitUntil: "networkidle" });
      ok(await p.isVisible("#todo-done") && /to do/.test(await p.textContent(".item-page header")), "item page: to-do badge + Mark done");
      if (SHOTS) await p.screenshot({ path: SHOTS + "/todo-item-" + sz + ".png", fullPage: true });

      // ---- queue cards
      await p.goto(B + "/queue?project=" + PROJ, { waitUntil: "networkidle" });
      await p.locator('#q-form[data-id="' + a.id + '"]').waitFor();
      ok((await p.textContent("#q-submit")) === "Done", "TODO card's primary action is Done");
      ok(/Your to-do/.test(await p.textContent(".qreason")) && (await p.locator("#q-form .qopts").count()) === 0, "TODO card: reason label, no options");
      if (SHOTS) await p.screenshot({ path: SHOTS + "/queue-todo-card-" + sz + ".png" });
      await p.keyboard.press("Enter");
      await p.locator('#q-form[data-id="' + b.id + '"]').waitFor();
      ok((await J("GET", "/api/items/" + a.id)).status === "done", "Enter marks the TODO done and advances");
      if (SHOTS) { await pause(300); await p.screenshot({ path: SHOTS + "/queue-todo-done-undo-" + sz + ".png" }); }
      await p.keyboard.press("u");
      await p.locator('#q-form[data-id="' + a.id + '"]').waitFor();
      ok((await J("GET", "/api/items/" + a.id)).status === "open", "U reopens it and returns to the card");
      await p.keyboard.press("s");
      await p.locator('#q-form[data-id="' + b.id + '"]').waitFor();
      ok(!!(await J("GET", "/api/items/" + a.id)).snoozed_at, "Snooze works on TODO cards");
      await p.fill("#q-text", "Started, waiting on access first.");
      await p.click("#q-noteonly");
      await p.locator('#q-form[data-id="' + c.id + '"]').waitFor();
      let it = await J("GET", "/api/items/" + b.id);
      ok(it.status === "open" && it.comments.some((x) => x.author === "owner" && /access first/.test(x.body)), "Send note only: comment, TODO stays open");
      // swipe right = Done (with a note)
      await p.fill("#q-text", "Tried it, notes attached to the thread.");
      await p.locator("#q-form h2").click();
      await p.evaluate(() => {
        const t = document.querySelector("#q-form .qbody"), r = t.getBoundingClientRect(), x0 = r.left + r.width / 2, y = r.top + 10;
        const ev = (type, x) => t.dispatchEvent(new PointerEvent(type, { pointerId: 9, pointerType: "touch", clientX: x, clientY: y, bubbles: true }));
        ev("pointerdown", x0); for (let i = 1; i <= 8; i++) ev("pointermove", x0 + i * 32); ev("pointerup", x0 + 256);
      });
      await pause(900);
      it = await J("GET", "/api/items/" + c.id);
      ok(it.status === "done" && it.comments.some((x) => /notes attached/.test(x.body)), "swipe right = Done, note sent as a comment");
      const ch = await J("GET", "/api/changes?since=" + encodeURIComponent(new Date(Date.now() - 120000).toISOString()));
      ok(ch.todos_done.some((x) => x.id === c.id), "rd changes todos_done lists it");
      const ow = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      ok(ow <= 0, "no horizontal overflow");
      await ctx.close();
    }
  } finally {
    for (const id of created) await J("DELETE", "/api/items/" + id);
    await browser.close();
  }
  console.log(fails ? "FAILED " + fails : "PASS");
  process.exit(fails ? 1 : 0);
})();

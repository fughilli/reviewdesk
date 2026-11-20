// Browser test for the review queue. Creates its own items in a throwaway
// project on the given desk, drives /queue?project=..., and deletes everything
// afterwards.   node queue_test.js BASE [shotdir]   (tests/browser/run.js starts a throwaway server)
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
const PROJ = "qtest" + Date.now().toString(36);
const created = [];
async function mk(title, extra) {
  const it = await J("POST", "/api/items", Object.assign({ title, project: PROJ, body: "Body of " + title }, extra));
  created.push(it.id);
  return it;
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await launch();
  try {
    // ---- fixtures (created oldest first) ----
    const opts3 = [{ label: "Alpha", description: "first", recommended: true }, { label: "Beta" }, { label: "Gamma" }];
    const soon1 = await mk("[qt] soon, oldest", { priority: "soon", options: opts3 });
    await pause(20);
    const whenever = await mk("[qt] whenever", { priority: "whenever", options: [{ label: "Yes" }, { label: "No" }] });
    await pause(20);
    const blocking = await mk("[qt] blocking, newest", { priority: "blocking", options: opts3 });
    await pause(20);
    const soon2 = await mk("[qt] soon, multi", { priority: "soon", multi: true, options: [{ label: "One", recommended: true }, { label: "Two" }, { label: "Three", recommended: true }] });
    await pause(20);
    const soon3 = await mk("[qt] soon, prose only", { priority: "soon" });
    const blocker = await mk("[qt] the blocker", { priority: "whenever" });
    const blocked = await mk("[qt] blocked item", { priority: "blocking", blocked_by: [blocker.id] });

    console.log("queue API ordering + blocker exclusion");
    let q = await J("GET", "/api/queue?project=" + PROJ);
    const ids = q.items.map((x) => x.id);
    ok(JSON.stringify(ids) === JSON.stringify([blocking.id, soon1.id, soon2.id, soon3.id, whenever.id, blocker.id]),
      "order: blocking, then soon oldest-first, then whenever: " + ids.join(","));
    ok(q.waiting.length === 1 && q.waiting[0].id === blocked.id, "blocked item held back in `waiting`");

    for (const [sz, vp] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]]) {
      if (sz === "phone") {
        // reset state between passes: retract everything the desktop pass did
        for (const id of created) {
          const it = await J("GET", "/api/items/" + id);
          for (const a of it.answers) await J("POST", "/api/answers/" + a.id + "/retract", {});
          for (const c of it.comments.filter((c) => c.author === "owner")) await J("POST", "/api/comments/" + c.id + "/retract", {});
          await J("POST", "/api/items/" + id + "/snooze", { snoozed_at: null });
        }
      }
      console.log(sz);
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor || 1 });
      const p = await ctx.newPage();
      p.on("pageerror", (e) => { fails++; console.log("  pageerror", e.message); });
      const cardId = async () => +(await p.locator("#q-form").getAttribute("data-id"));
      const waitCard = async (id) => { await p.locator('#q-form[data-id="' + id + '"]').waitFor({ timeout: 5000 }); await pause(150); };
      const toastText = () => p.textContent("#qtoast .qtmsg");
      const swipe = (dx) => p.evaluate((dx) => {
        const card = document.querySelector("#q-form"), tgt = card.querySelector(".qbody");
        const r = tgt.getBoundingClientRect(), x0 = r.left + r.width / 2, y0 = r.top + 20;
        const ev = (type, x) => tgt.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: "touch", clientX: x, clientY: y0, bubbles: true, isPrimary: true }));
        ev("pointerdown", x0);
        for (let i = 1; i <= 8; i++) ev("pointermove", x0 + (dx * i) / 8);
        ev("pointerup", x0 + dx);
      }, dx);

      await p.goto(B + "/queue?project=" + PROJ, { waitUntil: "networkidle" });
      await waitCard(blocking.id);
      ok((await p.textContent("#qprog")).startsWith("1 of 6"), "progress shows 1 of 6: " + (await p.textContent("#qprog")));
      ok(/1 waiting on blockers/.test(await p.textContent(".qwaitwrap")), "\"1 waiting on blockers\" shown");
      ok((await J("GET", "/api/items/" + blocking.id)).owner_seen !== null, "showing a card marks it seen");
      ok(/Review\s*\d+/.test(await p.textContent(".qnav")), "header shows Review with a count");

      // 1) keyboard: pick option 2, Enter submits, then U undoes
      await p.keyboard.press("2");
      ok(await p.isChecked('#q-form input[value="o2"]'), "key 2 selects option 2");
      await p.keyboard.press("Enter");
      await waitCard(soon1.id);
      ok(/Submitted/.test(await toastText()) && await p.isVisible("#qtoast .qtundo"), "Enter submits → \"Submitted — Undo\" toast");
      let it = await J("GET", "/api/items/" + blocking.id);
      ok(it.answers.length === 1 && it.answers[0].choices.join() === "o2" && it.status === "answered", "answer stored (o2), status answered");
      if (sz === "desktop" && SHOTS) await p.screenshot({ path: SHOTS + "/queue-undo-toast-desktop.png" });
      if (sz === "phone" && SHOTS) await p.screenshot({ path: SHOTS + "/queue-undo-toast-phone.png" });
      await p.keyboard.press("u");
      await waitCard(blocking.id);
      it = await J("GET", "/api/items/" + blocking.id);
      ok(it.answers.length === 0 && it.status === "open", "U retracts the answer, status back to open");
      ok(await p.isChecked('#q-form input[value="o2"]'), "undo restores the card with the choice");
      const ch = await J("GET", "/api/changes?since=" + encodeURIComponent(new Date(Date.now() - 60000).toISOString()));
      ok(ch.events.some((e) => e.item_id === blocking.id && e.kind === "retracted"), "rd changes reports the retraction as an event");
      await p.keyboard.press("1"); await p.keyboard.press("Enter");
      await waitCard(soon1.id);

      // 2) swipe right with nothing selected → approve recommended after a 3 s undo window
      await swipe(260);
      await waitCard(soon2.id);
      ok(/^Approving: Alpha/.test(await toastText()), "swipe right, nothing picked → \"Approving: Alpha\": " + (await toastText()));
      ok((await J("GET", "/api/items/" + soon1.id)).answers.length === 0, "nothing sent during the undo window");
      await p.keyboard.press("u");
      await waitCard(soon1.id);
      await pause(3300);
      ok((await J("GET", "/api/items/" + soon1.id)).answers.length === 0, "undo during the window cancels the approval");
      await swipe(260);
      await waitCard(soon2.id);
      await pause(3400);
      it = await J("GET", "/api/items/" + soon1.id);
      ok(it.answers.length === 1 && it.answers[0].choices.join() === "o1", "after 3 s the recommended option is committed");

      // 3) multi-select: keys toggle; submit sends both
      await p.keyboard.press("2"); await p.keyboard.press("3"); await p.keyboard.press("2");
      ok(!(await p.isChecked('#q-form input[value="o2"]')) && await p.isChecked('#q-form input[value="o3"]'), "multi-select: keys toggle checkboxes");
      await p.keyboard.press("1");
      await p.click("#q-submit");
      await waitCard(soon3.id);
      ok((await J("GET", "/api/items/" + soon2.id)).answers[0].choices.join() === "o1,o3", "multi-select submit sends o1,o3");

      // 4) no options, no input: swipe right wiggles, nothing sent; text-only = comment
      await swipe(260);
      await pause(500);
      ok((await cardId()) === soon3.id && (await J("GET", "/api/items/" + soon3.id)).comments.length === 0, "no recommended + no input: swipe right wiggles, stays");
      await p.fill("#q-text", "Prose reply about D-" + soon1.id);
      await p.focus("#q-text");
      await p.keyboard.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
      await waitCard(whenever.id);
      it = await J("GET", "/api/items/" + soon3.id);
      ok(it.comments.length === 1 && it.comments[0].author === "owner" && it.status === "open", "text only → owner comment (Ctrl+Enter while typing)");
      ok(/Comment sent/.test(await toastText()), "comment toast shown");

      // 5) snooze: swipe left, item goes to the back (server-side), undo restores
      await swipe(-260);
      await waitCard(blocker.id);
      ok(/Snoozed/.test(await toastText()), "swipe left snoozes");
      await p.evaluate(() => { document.querySelector("#toast").className = ""; });
      if (SHOTS) await p.screenshot({ path: SHOTS + "/queue-snoozed-" + sz + ".png" });
      ok(!!(await J("GET", "/api/items/" + whenever.id)).snoozed_at, "snooze stored server-side");
      q = await J("GET", "/api/queue?project=" + PROJ);
      ok(q.items[q.items.length - 1].id === whenever.id, "snoozed item is last in /api/queue");
      await p.keyboard.press("u");
      await waitCard(whenever.id);
      ok(!(await J("GET", "/api/items/" + whenever.id)).snoozed_at, "undo snooze clears it");
      await p.keyboard.press("s");
      await waitCard(blocker.id);

      // 6) arrows move without answering
      await p.keyboard.press("ArrowLeft");
      await waitCard(soon3.id);
      await p.keyboard.press("ArrowRight");
      await waitCard(blocker.id);
      ok((await J("GET", "/api/items/" + soon3.id)).comments.length === 1, "←/→ move without sending anything");
      // typing in the text box: arrows / s / u don't trigger queue actions
      await p.fill("#q-text", "su"); await p.focus("#q-text");
      await p.keyboard.press("ArrowLeft"); await p.keyboard.type("s");
      ok((await cardId()) === blocker.id && (await p.inputValue("#q-text")) === "ssu", "keys while typing stay in the text box");
      await p.fill("#q-text", "");
      await p.locator("#q-form h2").click();

      // 7) finish the pass: blocker answered by comment → only snoozed left → All caught up
      await p.fill("#q-text", "done"); await p.click("#q-submit");
      await p.locator(".qdone").waitFor({ timeout: 5000 });
      ok(/All caught up/.test(await p.textContent(".qdone")), "All caught up at the end");
      const sum = await p.textContent(".qsum");
      ok(/3\s*answered/.test(sum) && /1\s*approved/.test(sum) && /2\s*commented/.test(sum) && /1\s*snoozed/.test(sum), "summary: " + sum.replace(/\s+/g, " "));
      ok(await p.isVisible("#q-again"), "offers to go through the snoozed ones again");
      await p.evaluate(() => { document.querySelector("#toast").className = ""; document.querySelector("#qtoast").hidden = true; });
      if (SHOTS) await p.screenshot({ path: SHOTS + "/queue-caught-up-" + sz + ".png", fullPage: true });
      await p.click("#q-again");
      await waitCard(whenever.id);
      ok(true, "snoozed item comes back on a second pass");
      await p.keyboard.press("Escape");
      await p.waitForURL(B + "/");
      ok(true, "Esc leaves the queue");
      // Q opens it from elsewhere
      await p.keyboard.press("q");
      await p.locator(".queue").waitFor();
      ok(p.url().endsWith("/queue"), "q opens the queue");
      const ow = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      ok(ow <= 0, "no horizontal overflow");
      await ctx.close();
    }
    // the flow reached the agents exactly like the item page
    const ch = await J("GET", "/api/changes?since=" + encodeURIComponent(new Date(Date.now() - 600000).toISOString()));
    ok(ch.answers.some((a) => a.item_id === soon2.id) && ch.comments.some((c) => c.item_id === soon3.id), "answers and comments appear in rd changes");
    ok(!ch.events.some((e) => e.kind === "snoozed"), "snoozes are UI state, not events");
  } finally {
    for (const id of created) await J("DELETE", "/api/items/" + id);
    await browser.close();
  }
  console.log(fails ? "FAILED " + fails : "PASS");
  process.exit(fails ? 1 : 0);
})();

const { launch, png, client } = require("./lib");
// Browser test for pasting / dropping images into a reply: node paste_test.js BASE [shotdir]
// Seeds its own item and deletes it afterwards.
const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) process.exitCode = 1; };
(async () => {
  const b = await launch();
  const [B, out] = process.argv.slice(2);
  const { J } = client(B);
  const item = await J("POST", "/api/items", { title: "[paste test] reply with images", project: "ptest" + Date.now().toString(36) });
  const iid = item.id;
  // fake clipboard image: a 320x200 canvas chart
  const pasteImg = (sel, w, h, hue) => p_.evaluate(async ([sel, w, h, hue]) => {
    const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 8; i++) { g.fillStyle = `hsl(${hue + i * 12},70%,50%)`; const bh = 20 + ((i * 37) % (h - 40)); g.fillRect(16 + i * (w - 32) / 8, h - 10 - bh, (w - 32) / 8 - 6, bh); }
    g.fillStyle = "#222"; g.font = "16px sans-serif"; g.fillText("pasted from clipboard", 16, 24);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const dt = new DataTransfer(); dt.items.add(new File([blob], "image.png", { type: "image/png" }));
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector(sel).dispatchEvent(ev);
    return ev.defaultPrevented;
  }, [sel, w, h, hue]);
  let p_;
  for (const [sz, vp] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]]) {
    console.log(sz);
    const p = p_ = await (await b.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor || 1 })).newPage();
    p.on("pageerror", (e) => console.log("pageerror", e.message));
    p.on("console", (m) => { if (m.type() === "error") console.log("console", m.text()); });
    await p.goto(B + "/item/" + iid, { waitUntil: "networkidle" });
    await p.fill("#cmt-text", "Here is what I see, see D-" + iid + ".");
    ok(await pasteImg("#cmt-text", 320, 200, 200), "image paste is handled (default prevented)");
    await pasteImg("#cmt-text", 280, 180, 20);
    ok((await p.locator(".ctray .cchip").count()) === 2, "two chips in the tray");
    ok(/^pasted-\d{8}-\d{6}-\d+\.png/.test(await p.locator(".cchip .cname").first().textContent()), "pasted image renamed: " + (await p.locator(".cchip .cname").first().textContent()));
    // drop a third (non-image must be refused in comments)
    await p.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File(["x"], "notes.txt", { type: "text/plain" })); const t = document.querySelector("#cmt-text"); t.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true })); t.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true })); });
    ok((await p.locator(".ctray .cchip").count()) === 2, "dropped non-image refused in a comment");
    // oversize
    const big = await p.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(26 * 1024 * 1024)], "huge.png", { type: "image/png" })); const t = document.querySelector("#cmt-text"); t.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true })); return document.querySelector("#toast").textContent; });
    ok(/25 MB/.test(big), "oversize image refused with a clear message: " + big);
    await p.locator("#cmt-form").scrollIntoViewIfNeeded();
    await p.waitForTimeout(300);
    await p.locator("#cmt-form").evaluate((el) => el.scrollIntoView({ block: "end" }));
    await p.mouse.wheel(0, 40); await p.evaluate(() => { document.querySelector("#toast").className = ""; }); await p.waitForTimeout(400);
    if (out) await p.screenshot({ path: `${out}/composer-pasted-${sz}.png` });
    // remove one, then send
    await p.locator(".cchip .cx").last().click();
    ok((await p.locator(".ctray .cchip").count()) === 1, "× removes a chip");
    if (sz === "desktop") await pasteImg("#cmt-text", 200, 120, 300);
    await p.click("#cmt-submit");
    await p.waitForTimeout(1500); await p.locator(".comment.owner .catts .thumb").first().waitFor({ timeout: 8000 });
    const n = await p.locator(".comment.owner").last().locator(".catts .thumb").count();
    ok(n === (sz === "desktop" ? 2 : 1), "sent comment shows its images inline: " + n);
    await p.locator(".comment.owner").last().locator(".catts .thumb").first().click();
    await p.waitForSelector("dialog.viewer[open] .vimg.ready");
    ok(true, "comment image opens in the viewer at " + (await p.textContent(".vpos")));
    await p.keyboard.press("Escape");
  }
  await J("DELETE", "/api/items/" + iid);
  await b.close();
  console.log(process.exitCode ? "FAILED" : "PASS");
})();

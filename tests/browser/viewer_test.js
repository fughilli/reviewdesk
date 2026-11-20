const { launch, png, client } = require("./lib");
// Browser test for the image viewer: node viewer_test.js BASE [shotdir]
// Seeds its own item with six images and deletes it afterwards.
const ok = (c, m) => { console.log((c ? "  ok: " : "  FAIL: ") + m); if (!c) process.exitCode = 1; };
(async () => {
  const b = await launch();
  const [B, out] = process.argv.slice(2);
  const { J, upload } = client(B);
  const item = await J("POST", "/api/items", { title: "[viewer test] six images", project: "vtest" + Date.now().toString(36) });
  for (let i = 0; i < 6; i++) await upload(item.id, "image-" + (i + 1) + ".png", png(1600 - i * 100, 1000 - i * 60, i * 40));
  const PAGE = B + "/item/" + item.id;
  for (const [sz, vp] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }]]) {
    console.log(sz);
    const ctx = await b.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor || 1 });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => console.log("pageerror", e.message));
    await p.goto(PAGE, { waitUntil: "networkidle" });
    await p.locator(".thumb").nth(2).click();
    await p.waitForSelector(".vimg.ready");
    const pos = () => p.textContent(".vpos"), zoom = () => p.textContent(".vzoom");
    const N = await p.locator(".thumb").count();
    ok((await pos()) === "3 / " + N, "opens on the clicked image: " + (await pos()));
    ok(/#att-\d+$/.test(p.url()), "hash set: " + p.url().split("/").pop());
    await p.keyboard.press("ArrowRight"); await p.waitForSelector(".vimg.ready");
    ok((await pos()) === "4 / " + N, "ArrowRight -> 4 / " + N);
    await p.keyboard.press("ArrowLeft"); await p.keyboard.press("ArrowLeft"); await p.keyboard.press("ArrowLeft"); await p.keyboard.press("ArrowLeft");
    await p.waitForSelector(".vimg.ready");
    ok((await pos()) === N + " / " + N, "ArrowLeft wraps -> " + (await pos()));
    const fitZ = await zoom();
    await p.keyboard.press("1"); await p.waitForTimeout(250);
    ok((await zoom()) === "100%", "1 -> 100% (fit was " + fitZ + ")");
    await p.keyboard.press("+"); await p.waitForTimeout(250);
    ok((await zoom()) === "150%", "+ -> 150%");
    await p.keyboard.press("0"); await p.waitForTimeout(250);
    ok((await zoom()) === fitZ, "0 -> fit");
    const st = await p.locator(".vstage").boundingBox();
    const cx = st.x + st.width / 2, cy = st.y + st.height / 2;
    const T = () => p.evaluate(() => document.querySelector(".vimg").style.transform);
    // image pixel under the cursor must stay put while zooming about it
    const under = (x, y) => p.evaluate(([x, y]) => { const im = document.querySelector(".vimg"), r = document.querySelector(".vstage").getBoundingClientRect(); const m = im.style.transform.match(/translate\(([-\d.e]+)px,\s*([-\d.e]+)px\) scale\(([-\d.e]+)\)/); return [(x - r.left - +m[1]) / +m[3], (y - r.top - +m[2]) / +m[3]]; }, [x, y]);
    if (sz === "desktop") {
      const u0 = await under(cx + 100, cy + 50);
      await p.mouse.move(cx + 100, cy + 50);
      await p.mouse.wheel(0, -100); await p.waitForTimeout(100); // mouse notch -> zoom
      const u1 = await under(cx + 100, cy + 50);
      ok(parseInt(await zoom()) > parseInt(fitZ), "mouse wheel notch zooms: " + (await zoom()));
      ok(Math.abs(u0[0] - u1[0]) < 0.5 && Math.abs(u0[1] - u1[1]) < 0.5, "zoom is about the cursor");
      const z1 = await zoom(), t1 = await T();
      await p.mouse.wheel(0, -40); await p.waitForTimeout(100);  // trackpad two-finger scroll -> zoom (owner's choice)
      ok(parseInt(await zoom()) > parseInt(z1), "two-finger scroll zooms in: " + (await zoom()));
      const r = await p.evaluate(() => [Viewer.wheelIsZoom({ ctrlKey: true, deltaMode: 0, deltaX: 0, deltaY: 3.2 }), Viewer.wheelIsZoom({ ctrlKey: false, deltaMode: 1, deltaX: 0, deltaY: 3 }), Viewer.wheelIsZoom({ ctrlKey: false, deltaMode: 0, deltaX: 0, deltaY: 4.5 }), Viewer.wheelIsZoom({ ctrlKey: false, deltaMode: 0, deltaX: 0, deltaY: 120 })]);
      ok(r.join() === "true,true,true,true", "wheelIsZoom: every wheel zooms = " + r.join());
      const t2 = await T();
      await p.mouse.move(cx, cy); await p.mouse.down(); await p.mouse.move(cx - 80, cy - 40, { steps: 4 }); await p.mouse.up();
      ok((await T()) !== t2, "left-drag pans");
      await p.mouse.dblclick(cx, cy); await p.waitForTimeout(250);
      ok((await zoom()) === fitZ, "double-click (zoomed) -> fit");
      await p.mouse.dblclick(cx, cy); await p.waitForTimeout(250);
      ok((await zoom()) === "100%", "double-click at fit -> 100%");
      for (let i = 0; i < 4; i++) { await p.mouse.wheel(0, -100); await p.waitForTimeout(30); }
      await p.waitForTimeout(250);
      if (out) await p.screenshot({ path: out + "/viewer-zoomed-desktop.png" });
      for (let i = 0; i < 60; i++) await p.mouse.wheel(0, -100);
      ok(parseInt(await zoom()) <= 3200, "zoom clamps at " + (await zoom()));
      ok(await p.evaluate(() => document.querySelector(".vimg").classList.contains("px")), "pixelated at high zoom");
    } else {
      // synthetic touch pointers: pinch out about a point, then two-finger drag, then swipe
      const touch = (type, id, x, y) => p.evaluate(([type, id, x, y]) => document.querySelector(".vstage").dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: "touch", clientX: x, clientY: y, bubbles: true, isPrimary: id === 1, button: 0 })), [type, id, x, y]);
      // swipe at fit -> next
      await touch("pointerdown", 1, cx + 120, cy); for (let i = 1; i <= 5; i++) await touch("pointermove", 1, cx + 120 - i * 40, cy); await touch("pointerup", 1, cx - 80, cy);
      await p.waitForSelector(".vimg.ready");
      ok((await pos()) === "1 / " + N, "swipe left at fit -> next (wraps to 1 / " + N + "): " + (await pos()));
      const u0 = await under(cx, cy);
      await touch("pointerdown", 1, cx - 30, cy); await touch("pointerdown", 2, cx + 30, cy);
      for (let i = 1; i <= 6; i++) { await touch("pointermove", 1, cx - 30 - i * 15, cy); await touch("pointermove", 2, cx + 30 + i * 15, cy); }
      const u1 = await under(cx, cy);
      ok(parseInt(await zoom()) > parseInt(fitZ) * 2, "pinch zooms: " + fitZ + " -> " + (await zoom()));
      ok(Math.abs(u0[0] - u1[0]) < 1 && Math.abs(u0[1] - u1[1]) < 1, "pinch is about its centre " + JSON.stringify([u0, u1]) + " " + (await T()));
      const t1 = await T();
      for (let i = 1; i <= 4; i++) { await touch("pointermove", 1, cx - 120 + i * 10, cy + i * 10); await touch("pointermove", 2, cx + 120 + i * 10, cy + i * 10); }
      await touch("pointerup", 1, cx - 80, cy + 40); await touch("pointerup", 2, cx + 160, cy + 40);
      ok((await T()) !== t1, "two-finger drag pans");
      const before = await pos(), z = await zoom();
      await touch("pointerdown", 1, cx + 120, cy); for (let i = 1; i <= 5; i++) await touch("pointermove", 1, cx + 120 - i * 40, cy); await touch("pointerup", 1, cx - 80, cy);
      ok((await pos()) === before && (await zoom()) === z, "zoomed swipe pans instead of changing image");
      await p.waitForTimeout(250);
      if (out) await p.screenshot({ path: out + "/viewer-zoomed-phone.png" });
      const ow = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      ok(ow <= 0, "no horizontal overflow");
    }
    await p.keyboard.press("Escape"); await p.waitForTimeout(150);
    ok(!(await p.evaluate(() => !!document.querySelector("dialog.viewer[open]"))) && !p.url().includes("#att-"), "Esc closes + clears hash");
    // deep link
    await p.goto(PAGE + "#att-" + (await p.evaluate(() => document.querySelectorAll(".thumb")[4].dataset.id)), { waitUntil: "networkidle" });
    await p.waitForSelector(".vimg.ready");
    ok((await pos()) === "5 / " + N, "#att-<id> deep link opens that image");
    await p.keyboard.press("Escape");
    // arrows while typing in a textarea do not page anything
    await p.fill("#cmt-text", "abc"); await p.focus("#cmt-text"); await p.keyboard.press("ArrowLeft");
    ok(!(await p.evaluate(() => !!document.querySelector("dialog.viewer[open]"))) && p.url().endsWith("/item/" + item.id), "arrow keys in a text field stay in the field");
    await ctx.close();
  }
  await J("DELETE", "/api/items/" + item.id);
  await b.close();
  console.log(process.exitCode ? "FAILED" : "PASS");
})();

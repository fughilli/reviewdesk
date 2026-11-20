// Render the README screenshots from a throwaway desk filled by scripts/seed_demo.py.
//   node screenshots.js [outdir]      (default: docs/screenshots)
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { launch } = require("./lib");

const ROOT = path.resolve(__dirname, "..", "..");
const OUT = path.resolve(process.argv[2] || path.join(ROOT, "docs", "screenshots"));
const PY = process.env.PYTHON || "python3";
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rd-shots-"));
  const port = await freePort();
  const base = "http://127.0.0.1:" + port;
  const env = Object.assign({}, process.env, { RD_DATA_DIR: path.join(tmp, "data"), RD_URL: base, RD_PR_URL_BASE: "https://github.com/example/webapp/pull/" });
  const srv = spawn(PY, [path.join(ROOT, "server.py"), "--port", String(port)], { env, stdio: "ignore" });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + "/healthz")).ok) break; } catch (e) { await pause(100); } }
  const seed = spawnSync(PY, [path.join(ROOT, "scripts", "seed_demo.py")], { env, stdio: "inherit" });
  if (seed.status !== 0) { srv.kill(); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launch();
  const desktop = { viewport: { width: 1200, height: 860 }, colorScheme: "light" };
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "light" };
  async function shot(name, opts, url, prep, full) {
    const ctx = await browser.newContext(opts);
    const p = await ctx.newPage();
    p.on("pageerror", (e) => { console.log(name + ": page error " + e.message); process.exitCode = 1; });
    await p.goto(base + url, { waitUntil: "networkidle" });
    await pause(300);
    if (prep) await prep(p);
    await p.screenshot({ path: path.join(OUT, name + ".png"), fullPage: !!full });
    console.log("wrote " + path.join(OUT, name + ".png"));
    await ctx.close();
  }
  // queue: move to the first decision card (D-1, with options) and pick the recommended one
  const toCard = async (p, id) => {
    await p.locator("#q-form").waitFor();
    for (let i = 0; i < 20 && (await p.locator("#q-form").getAttribute("data-id")) !== String(id); i++) { await p.keyboard.press("ArrowRight"); await pause(250); }
    await p.keyboard.press("1");
    await pause(300);
  };
  await shot("queue-desktop", Object.assign({}, desktop, { viewport: { width: 1200, height: 1320 } }), "/queue", (p) => toCard(p, 1));
  await shot("queue-phone", phone, "/queue", async (p) => {
    await toCard(p, 1);
    await p.locator(".qopts").evaluate((el) => el.scrollIntoView({ block: "center" }));
    await pause(300);
  });
  await shot("inbox-desktop", desktop, "/");
  await shot("item-desktop", desktop, "/item/1", null, true);
  await shot("viewer-desktop", desktop, "/item/1", async (p) => { await p.locator(".thumb").first().click(); await p.waitForSelector(".vimg.ready"); await pause(300); });
  await shot("todo-desktop", desktop, "/todo");
  await shot("projects-desktop", desktop, "/projects", null, true);
  await browser.close();
  srv.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
})();

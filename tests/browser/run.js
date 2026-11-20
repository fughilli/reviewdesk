// Run the browser tests against a throwaway Review Desk server.
//   cd tests/browser && npm install && npx playwright-core install chromium && node run.js [test ...]
// Env: CHROMIUM_PATH (optional), PYTHON (default python3), SHOTS=<dir> to keep screenshots.
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const ALL = ["viewer_test.js", "paste_test.js", "queue_test.js", "todo_test.js"];

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

(async () => {
  const tests = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rd-browser-"));
  const port = await freePort();
  const base = "http://127.0.0.1:" + port;
  const env = Object.assign({}, process.env, { RD_DATA_DIR: path.join(tmp, "data"), RD_PR_URL_BASE: "https://github.com/example/project/pull/" });
  const srv = spawn(process.env.PYTHON || "python3", [path.join(ROOT, "server.py"), "--port", String(port)], { env, stdio: ["ignore", "ignore", fs.openSync(path.join(tmp, "server.log"), "w")] });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(base + "/healthz")).ok; } catch (e) { await new Promise((r) => setTimeout(r, 100)); }
  }
  if (!up) { srv.kill(); console.error("server did not start"); process.exit(1); }
  const failed = [];
  for (const t of tests) {
    console.log("== " + t);
    const r = spawnSync(process.execPath, [path.join(__dirname, t), base, process.env.SHOTS || ""], { stdio: "inherit" });
    if (r.status !== 0) failed.push(t);
  }
  srv.kill();
  if (failed.length) console.log("server log kept: " + path.join(tmp, "server.log"));
  else fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed.length ? "FAILED: " + failed.join(", ") : "ALL PASS (" + tests.length + " files)");
  process.exit(failed.length ? 1 : 0);
})();

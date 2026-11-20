// Shared helpers for the browser tests: launch Chromium, make PNGs, call the API.
const { chromium } = require("playwright-core");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

// Chromium: $CHROMIUM_PATH, else the one `npx playwright-core install chromium` put in
// the Playwright cache (newest revision), else whatever playwright-core finds itself.
function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
  let dirs = [];
  try { dirs = fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => +b.split("-")[1] - +a.split("-")[1]); } catch (e) { return undefined; }
  for (const d of dirs) {
    for (const rel of ["chrome-linux/chrome", "chrome-linux64/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-win/chrome.exe"]) {
      const p = path.join(cache, d, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}

function launch() {
  return chromium.launch({ executablePath: chromiumPath(), args: ["--no-sandbox"] });
}

// A w x h RGB PNG with a colour gradient (hue shifts the palette).
function png(w = 64, h = 48, hue = 0) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    rows.push(0);
    for (let x = 0; x < w; x++) rows.push((x * 255 / w + hue) & 255, (y * 255 / h) & 255, (160 + hue) & 255);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.from(rows))), chunk("IEND", Buffer.alloc(0))]);
}

function client(base) {
  async function J(method, p, body) {
    const r = await fetch(base + p, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    try { return JSON.parse(t); } catch (e) { return t; }
  }
  async function upload(id, filename, data) {
    const r = await fetch(base + "/api/items/" + id + "/attachments?filename=" + encodeURIComponent(filename), { method: "POST", body: data });
    return r.json();
  }
  return { J, upload };
}

module.exports = { launch, png, client };

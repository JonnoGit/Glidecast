#!/usr/bin/env node
// Glidecast editor: `node server.js` then open http://localhost:4321
//
// A headless Chromium page (sized exactly like the render) is streamed to the UI as
// JPEG frames over Server-Sent Events. Wheel/click/drag input from the UI is applied
// to that page, so checkpoint scroll positions match the final render.

import http from "node:http";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { applyCss, GPU_ARGS, preScroll } from "./prep.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const RENDERS = path.join(ROOT, "renders");
const PORT = Number(process.env.PORT) || 4321;

await mkdir(RENDERS, { recursive: true });

// --- SSE ---------------------------------------------------------------------

const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

// --- Live page -----------------------------------------------------------------

let browser = null;
let context = null;
let page = null;
let pageCfg = { url: "", width: 1920, height: 1080, hideSelectors: [], injectCss: "" };
let lastFrame = null;
let loading = false;

// Serialize everything that touches the page so evaluate/screenshot calls don't interleave.
let chain = Promise.resolve();
const locked = (fn) => (chain = chain.then(fn, fn));

async function pageState() {
  if (!page) return { loaded: false };
  const { scrollY, maxScroll, title } = await page.evaluate(() => ({
    scrollY: window.scrollY,
    maxScroll: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
    title: document.title,
  }));
  return { loaded: true, url: page.url(), title, scrollY, maxScroll, width: pageCfg.width, height: pageCfg.height };
}

// Frame pump: capture whenever something changed, plus a slow refresh for animated pages.
let dirty = false;
let capturing = false;
const markDirty = () => {
  dirty = true;
  pump();
};
async function pump() {
  if (capturing || !dirty || !page || loading) return;
  capturing = true;
  dirty = false;
  try {
    await locked(async () => {
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const buf = await page.screenshot({ type: "jpeg", quality: 72, scale: "css" });
      const state = await pageState();
      lastFrame = { image: buf.toString("base64"), ...state };
      broadcast("frame", lastFrame);
    });
  } catch {
    // page navigating or closed; next pump will retry
  } finally {
    capturing = false;
    if (dirty) setTimeout(pump, 0);
  }
}
setInterval(() => page && clients.size && markDirty(), 1000);

async function loadPage({ url, width, height, hideSelectors = [], injectCss = "", hideCookieBanners = true }) {
  if (!/^https?:\/\//i.test(url) && !/^file:/i.test(url)) url = "https://" + url;
  loading = true;
  broadcast("status", { loading: true, message: `Loading ${url}…` });
  try {
    await locked(async () => {
      browser ??= await chromium.launch({ args: GPU_ARGS });
      if (context) await context.close();
      pageCfg = { url, width, height, hideSelectors, injectCss, hideCookieBanners };
      context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
      page = await context.newPage();
      page.on("load", () => {
        applyCss(page, pageCfg).catch(() => {});
        markDirty();
      });
      await page.goto(url, { waitUntil: "networkidle", timeout: 90_000 }).catch(async (err) => {
        // Some sites never go network-idle; fall back to whatever has loaded.
        if (!/Timeout/.test(err.message)) throw err;
      });
      await applyCss(page, pageCfg);
      broadcast("status", { loading: true, message: "Pre-scrolling to load lazy content…" });
      await preScroll(page, height);
      await page.waitForTimeout(300);
    });
  } finally {
    loading = false;
  }
  broadcast("status", { loading: false, message: "" });
  markDirty();
  return locked(pageState);
}

// Build a reasonably stable CSS selector for the element under a point. Prefers the
// outermost fixed/sticky ancestor, since that's usually the banner or widget to hide.
async function pickSelector(x, y) {
  return page.evaluate(
    ({ x, y }) => {
      let el = document.elementFromPoint(x, y);
      if (!el) return null;
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        const pos = getComputedStyle(n).position;
        if (pos === "fixed" || pos === "sticky") el = n;
      }
      const parts = [];
      for (let n = el; n && n.nodeType === 1 && n !== document.body && n !== document.documentElement; n = n.parentElement) {
        if (n.id && !/\d{3,}/.test(n.id)) {
          parts.unshift("#" + CSS.escape(n.id));
          break;
        }
        let s = n.tagName.toLowerCase();
        const siblings = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
        if (siblings.length > 1) s += `:nth-of-type(${siblings.indexOf(n) + 1})`;
        parts.unshift(s);
      }
      return parts.join(" > ") || null;
    },
    { x, y }
  );
}

// --- Rendering -----------------------------------------------------------------

let job = null;

async function startRender(config, { draft }) {
  if (job) throw new Error("A render is already running");
  const base = (config.output || "scroll.mp4").replace(/[^\w.\-]+/g, "_");
  const ext = path.extname(base) || ".mp4";
  // Never overwrite an earlier render: name.mp4, name_2.mp4, name_3.mp4…
  const baseStem = path.basename(base, ext) + (draft ? "_draft" : "");
  const exists = (p) => stat(p).then(() => true, () => false);
  let stem = baseStem;
  for (let n = 2; await exists(path.join(RENDERS, `${stem}${ext}`)); n++) stem = `${baseStem}_${n}`;
  const outName = `${stem}${ext}`;
  const configFile = path.join(RENDERS, `${stem}.json`);

  const cfg = { ...config, output: outName };
  if (draft) {
    cfg.viewport = { ...cfg.viewport, deviceScaleFactor: 1 };
    cfg.captureFormat = "jpeg";
  }
  // Carry the preview session into the render, so anything dismissed or accepted in the
  // preview (cookie banners, popups, logins) stays that way in the video.
  if (context && !loading) {
    const stateFile = `${stem}.state.json`;
    await locked(() => context.storageState({ path: path.join(RENDERS, stateFile) }));
    cfg.storageState = stateFile;
  }
  await writeFile(configFile, JSON.stringify(cfg, null, 2));

  const args = [path.join(ROOT, "record.js"), configFile, "--progress-json"];
  if (draft) args.push("--draft");
  const child = spawn(process.execPath, args, { cwd: ROOT });
  job = { child, draft, outName, log: [] };
  broadcast("render", { state: "running", draft, message: "Starting…" });

  const onLine = (line) => {
    if (!line.trim()) return;
    if (line.startsWith("@@PROGRESS ")) {
      broadcast("render", { state: "running", draft, progress: JSON.parse(line.slice(11)) });
    } else if (line.startsWith("@@STAGE ")) {
      broadcast("render", { state: "running", draft, message: "Encoding…", progress: null });
    } else {
      job.log.push(line);
      broadcast("render", { state: "running", draft, message: line.trim() });
    }
  };
  let buf = "";
  const onData = (d) => {
    buf += d;
    const lines = buf.split(/\r?\n|\r/);
    buf = lines.pop();
    lines.forEach(onLine);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("close", (code, signal) => {
    const log = job.log.slice(-12).join("\n");
    job = null;
    if (signal) broadcast("render", { state: "cancelled", draft });
    else if (code === 0) broadcast("render", { state: "done", draft, file: outName, url: `/renders/${encodeURIComponent(outName)}?t=${Date.now()}` });
    else broadcast("render", { state: "error", draft, message: log || `Recorder exited with code ${code}` });
  });
}

// --- HTTP ------------------------------------------------------------------------

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".json": "application/json" };

async function serveFile(req, res, file) {
  let info;
  try {
    info = await stat(file);
  } catch {
    res.writeHead(404).end("Not found");
    return;
  }
  const type = MIME[path.extname(file)] || "application/octet-stream";
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : info.size - 1;
    res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${info.size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Type": type, "Content-Length": info.size, "Accept-Ranges": "bytes", "Cache-Control": "no-store" });
    createReadStream(file).pipe(res);
  }
}

const readBody = async (req) => {
  let s = "";
  for await (const chunk of req) s += chunk;
  return s ? JSON.parse(s) : {};
};

const needPage = () => {
  if (!page || loading) throw Object.assign(new Error("No page loaded"), { status: 409 });
};

const routes = {
  "POST /api/load": async (b) => loadPage(b),

  "POST /api/scroll": async (b) => {
    needPage();
    await locked(() =>
      page.evaluate(({ y, dy }) => window.scrollTo({ top: y ?? window.scrollY + dy, behavior: "instant" }), b)
    );
    markDirty();
    return locked(pageState);
  },

  "POST /api/click": async ({ x, y }) => {
    needPage();
    await locked(() => page.mouse.click(x, y));
    setTimeout(markDirty, 50);
    setTimeout(markDirty, 400);
    return { ok: true };
  },

  "POST /api/pick": async ({ x, y }) => {
    needPage();
    return { selector: await locked(() => pickSelector(x, y)) };
  },

  "POST /api/css": async ({ hideSelectors = [], injectCss = "", hideCookieBanners = true }) => {
    pageCfg = { ...pageCfg, hideSelectors, injectCss, hideCookieBanners };
    if (page && !loading) {
      await locked(() => applyCss(page, pageCfg));
      markDirty();
    }
    return { ok: true };
  },

  "POST /api/render": async ({ config, draft }) => {
    await startRender(config, { draft: !!draft });
    return { ok: true };
  },

  "POST /api/cancel": async () => {
    job?.child.kill("SIGTERM");
    return { ok: true };
  },

  "POST /api/reveal": async ({ file }) => {
    const target = path.join(RENDERS, path.basename(file));
    spawn("open", ["-R", target]);
    return { ok: true };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write("retry: 1000\n\n");
      clients.add(res);
      if (lastFrame) res.write(`event: frame\ndata: ${JSON.stringify(lastFrame)}\n\n`);
      if (job) res.write(`event: render\ndata: ${JSON.stringify({ state: "running", draft: job.draft, message: "Rendering…" })}\n\n`);
      req.on("close", () => clients.delete(res));
      return;
    }

    const handler = routes[`${req.method} ${url.pathname}`];
    if (handler) {
      const result = await handler(await readBody(req));
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/renders/")) {
      return serveFile(req, res, path.join(RENDERS, path.basename(decodeURIComponent(url.pathname))));
    }
    if (req.method === "GET" && url.pathname === "/easing.js") {
      return serveFile(req, res, path.join(ROOT, "easing.js"));
    }
    if (req.method === "GET") {
      const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const file = path.join(PUBLIC, path.normalize(rel));
      if (!file.startsWith(PUBLIC)) return res.writeHead(403).end();
      return serveFile(req, res, file);
    }
    res.writeHead(404).end();
  } catch (err) {
    res.writeHead(err.status || 500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`Glidecast editor → http://localhost:${PORT}`));

const shutdown = async () => {
  job?.child.kill("SIGTERM");
  await browser?.close().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

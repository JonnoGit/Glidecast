#!/usr/bin/env node
// Headless scroll recorder with true motion blur.
//
// Usage:  node record.js <config.json> [--draft] [--out file.mp4]
//
// Rendering is frame-exact, not real-time: for every output frame we set the scroll
// position for several sub-frame instants inside the shutter window, screenshot each,
// and ffmpeg averages them. That gives real accumulation motion blur whose streak
// length follows the actual scroll velocity.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveEasing } from "./easing.js";
import { applyCss, getMaxScroll, GPU_ARGS, preScroll, START_PAUSED_SCRIPT, VIRTUAL_TIME_SCRIPT } from "./prep.js";

const DEFAULTS = {
  viewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
  fps: 60,
  // samples: max sub-frames per frame; maxStepPx: target spacing between sub-frames (smaller = smoother streaks)
  motionBlur: { enabled: true, samples: 64, shutterAngle: 180, maxStepPx: 1 },
  easing: "easeInOutCubic",
  start: 0,
  waitUntil: "networkidle",
  preScroll: true, // walk the page once first so lazy-loaded images/sections exist
  settleMs: 500,
  gpu: true, // hardware WebGL; set false if a page renders incorrectly
  freshStart: true, // reload after measuring so load-in and scroll-triggered animations aren't pre-played
  virtualTime: true, // step the page's clock with the video so animations play at real speed
  freezeAnimations: false, // stop CSS/Web Animations entirely (overrides virtual stepping for them)
  hideSelectors: [], // extra elements to hide
  hideCookieBanners: true, // hide known consent-manager banners (OneTrust, Cookiebot, …)
  storageState: null, // Playwright storage state JSON (cookies + localStorage) to start with
  injectCss: "",
  captureFormat: "png", // "jpeg" is faster but lossy before blur averaging
  quality: 16, // x264 CRF (lower = better); ignored for ProRes
};

function parseArgs(argv) {
  const args = { draft: false, progressJson: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--draft") args.draft = true;
    else if (a === "--progress-json") args.progressJson = true;
    else if (a === "--out") args.out = argv[++i];
    else if (!args.config) args.config = a;
  }
  if (!args.config) {
    console.error("Usage: node record.js <config.json> [--draft] [--out file.mp4]");
    process.exit(1);
  }
  return args;
}

// --- Target resolution -------------------------------------------------------

// Resolves a scroll target to an absolute scrollY in CSS px.
//   1200          absolute
//   "+600" "-300" relative to previous position
//   "50%"         percentage of the max scroll
//   "top" "bottom"
//   "#pricing"    selector (element top aligned to viewport top)
//   { "selector": "#pricing", "offset": -80, "align": "top" | "center" | "bottom" }
async function resolveTarget(page, target, current, maxScroll, vh) {
  const clamp = (y) => Math.max(0, Math.min(maxScroll, y));
  if (typeof target === "number") return clamp(target);
  if (typeof target === "string") {
    if (target === "top") return 0;
    if (target === "bottom") return maxScroll;
    if (/^[+-]\d+(\.\d+)?$/.test(target)) return clamp(current + Number(target));
    if (/^\d+(\.\d+)?%$/.test(target)) return clamp((parseFloat(target) / 100) * maxScroll);
    target = { selector: target };
  }
  const { selector, offset = 0, align = "top" } = target;
  const top = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    return { top: el.getBoundingClientRect().top + window.scrollY, height: el.getBoundingClientRect().height };
  }, selector);
  if (!top) throw new Error(`Selector not found: ${selector}`);
  let y = top.top;
  if (align === "center") y = top.top + top.height / 2 - vh / 2;
  if (align === "bottom") y = top.top + top.height - vh;
  return clamp(y + offset);
}

// Turns the timeline into segments on an absolute clock: { t0, t1, from, to, ease }.
async function buildTimeline(page, cfg, maxScroll) {
  const vh = cfg.viewport.height;
  let pos = await resolveTarget(page, cfg.start, 0, maxScroll, vh);
  let t = 0;
  const segments = [];
  for (const [i, step] of cfg.timeline.entries()) {
    if ("wait" in step || "hold" in step) {
      const d = Number(step.wait ?? step.hold);
      segments.push({ t0: t, t1: t + d, from: pos, to: pos, ease: (x) => x });
      t += d;
    } else if ("scroll" in step || "scrollTo" in step) {
      const to = await resolveTarget(page, step.scroll ?? step.scrollTo, pos, maxScroll, vh);
      const dist = Math.abs(to - pos);
      const d = step.duration ?? (step.speed ? dist / step.speed : null);
      if (d == null) throw new Error(`Timeline step ${i}: scroll needs "duration" (s) or "speed" (px/s)`);
      segments.push({ t0: t, t1: t + d, from: pos, to, ease: resolveEasing(step.easing ?? cfg.easing, d) });
      console.log(`  step ${i}: scroll ${Math.round(pos)} → ${Math.round(to)}px over ${d.toFixed(2)}s`);
      pos = to;
      t += d;
    } else {
      throw new Error(`Timeline step ${i}: expected "scroll" or "wait", got ${JSON.stringify(step)}`);
    }
  }
  return { segments, duration: t, finalPos: pos };
}

function scrollAt(timeline, time) {
  const { segments } = timeline;
  if (!segments.length) return 0;
  if (time <= 0) return segments[0].from;
  for (const s of segments) {
    if (time < s.t1) {
      const p = s.t1 === s.t0 ? 1 : (time - s.t0) / (s.t1 - s.t0);
      return s.from + (s.to - s.from) * s.ease(p);
    }
  }
  return timeline.finalPos;
}

// --- ffmpeg ------------------------------------------------------------------

function startEncoder(out, { fps, samples, captureFormat, quality }) {
  const ext = path.extname(out).toLowerCase();
  const filters = [];
  if (samples > 1) {
    // Average each block of `samples` sub-frames, keep the last frame of each block.
    filters.push(`tmix=frames=${samples}`, `select='eq(mod(n\\,${samples})\\,${samples - 1})'`);
  }
  filters.push(`settb=1/${fps}`, "setpts=N");

  let codec;
  if (ext === ".mov") {
    codec = ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"];
  } else if (ext === ".webm") {
    codec = ["-c:v", "libvpx-vp9", "-crf", String(quality + 10), "-b:v", "0", "-pix_fmt", "yuv420p"];
  } else {
    filters.push("scale=trunc(iw/2)*2:trunc(ih/2)*2"); // yuv420p needs even dimensions
    codec = ["-c:v", "libx264", "-preset", "slow", "-crf", String(quality), "-pix_fmt", "yuv420p", "-movflags", "+faststart"];
  }

  const ff = spawn(
    "ffmpeg",
    [
      "-y", "-loglevel", "error",
      "-f", "image2pipe", "-c:v", captureFormat === "jpeg" ? "mjpeg" : "png",
      "-framerate", String(fps * samples), "-i", "-",
      "-vf", filters.join(","),
      "-fps_mode", "cfr", "-r", String(fps),
      ...codec, out,
    ],
    { stdio: ["pipe", "inherit", "inherit"] }
  );
  const done = new Promise((resolve, reject) => {
    ff.on("error", reject);
    ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
  });
  let failure = null;
  ff.stdin.on("error", (err) => (failure = err));
  ff.on("close", (code) => code !== 0 && (failure ??= new Error(`ffmpeg exited with ${code}`)));
  const write = (buf) =>
    new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      if (ff.stdin.write(buf)) resolve();
      else ff.stdin.once("drain", resolve);
    });
  return { write, end: () => (ff.stdin.end(), done) };
}

// --- Main --------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = path.resolve(args.config);
  const user = JSON.parse(await readFile(configPath, "utf8"));
  const cfg = {
    ...DEFAULTS,
    ...user,
    viewport: { ...DEFAULTS.viewport, ...user.viewport },
    motionBlur: { ...DEFAULTS.motionBlur, ...user.motionBlur },
  };
  if (!cfg.url) throw new Error("Config needs a \"url\"");
  cfg.url = cfg.url.trim();
  if (!/^[a-z][a-z\d+.-]*:/i.test(cfg.url)) cfg.url = "https://" + cfg.url; // "fin.ai/operator" → https://…
  if (!Array.isArray(cfg.timeline)) throw new Error("Config needs a \"timeline\" array");

  const blur = cfg.motionBlur.enabled && !args.draft;
  const samples = blur ? Math.max(1, Math.round(cfg.motionBlur.samples)) : 1;
  const shutter = blur ? cfg.motionBlur.shutterAngle / 360 : 0; // fraction of frame interval
  const out = path.resolve(path.dirname(configPath), args.out ?? cfg.output ?? "scroll.mp4");

  const browser = await chromium.launch({ args: cfg.gpu ? GPU_ARGS : [] });
  const context = await browser.newContext({
    viewport: { width: cfg.viewport.width, height: cfg.viewport.height },
    deviceScaleFactor: cfg.viewport.deviceScaleFactor,
    reducedMotion: "no-preference",
    // Cookies/localStorage (e.g. a dismissed cookie banner) saved from the editor session.
    ...(cfg.storageState ? { storageState: path.resolve(path.dirname(configPath), cfg.storageState) } : {}),
  });
  // Virtual clock: runs in real time while loading, then gets paused and stepped exactly 1/fps
  // per frame, so animation (Rive, Lottie, GSAP, CSS, video) plays at true speed however slow capture is.
  if (cfg.virtualTime) await context.addInitScript(VIRTUAL_TIME_SCRIPT);
  const page = await context.newPage();

  try {
    console.log(`Loading ${cfg.url}`);
    await page.goto(cfg.url, { waitUntil: cfg.waitUntil, timeout: 90_000 });

    await applyCss(page, cfg);
    const getMax = () => getMaxScroll(page);

    if (cfg.preScroll) {
      console.log("Pre-scrolling to trigger lazy content…");
      await preScroll(page, cfg.viewport.height);
    }
    await page.waitForTimeout(cfg.settleMs);

    const cdp = await context.newCDPSession(page);
    if (cfg.freezeAnimations) {
      await cdp.send("Animation.enable");
      await cdp.send("Animation.setPlaybackRate", { playbackRate: 0 });
    }

    const maxScroll = await getMax();
    console.log(`Page scroll height: ${maxScroll + cfg.viewport.height}px (max scrollY ${maxScroll})`);
    const timeline = await buildTimeline(page, cfg, maxScroll);

    const totalFrames = Math.max(1, Math.round(timeline.duration * cfg.fps));
    const totalCaptures = totalFrames * samples;
    const dpr = cfg.viewport.deviceScaleFactor;
    console.log(
      `Rendering ${totalFrames} frames @ ${cfg.fps}fps (${timeline.duration.toFixed(2)}s), ` +
        (blur ? `${samples} samples, ${cfg.motionBlur.shutterAngle}° shutter` : "no motion blur") +
        ` → ${path.relative(process.cwd(), out)}`
    );

    const encoder = startEncoder(out, { fps: cfg.fps, samples, captureFormat: cfg.captureFormat, quality: cfg.quality });

    let lastY = null;
    let lastShot = null;
    let shots = 0;
    const started = Date.now();

    const clampTime = (t) => Math.min(timeline.duration, Math.max(0, t));
    const maxStep = cfg.motionBlur.maxStepPx ?? 3;

    let animMs = 0; // page time elapsed since the clock was paused
    if (cfg.freshStart) {
      // The warm-up load above measured the page and cached lazy assets, but it also played the
      // intro and fired scroll-triggered animations. Reload with the clock frozen from the first
      // script, so all of that plays from frame 0 / when the video actually scrolls there.
      console.log("Reloading for a fresh start (intro animations play from frame 0)…");
      if (cfg.virtualTime) await page.addInitScript(START_PAUSED_SCRIPT);
      await page.evaluate((y) => window.scrollTo(0, y), timeline.segments[0]?.from ?? 0);
      await page.reload({ waitUntil: "load", timeout: 90_000 }).catch((err) => {
        if (!/Timeout/.test(err.message)) throw err;
      });
      await applyCss(page, cfg);
      await page.evaluate(() => document.fonts?.ready);
      if (cfg.virtualTime) {
        // Let the page finish rendering its initial state without advancing time: dt=0 flushes
        // queued animation frames and zero-delay timers.
        const until = Date.now() + cfg.settleMs;
        while (Date.now() < until) {
          await page.evaluate(() => window.__srAdvance(0));
          await page.waitForTimeout(16);
        }
      } else {
        await page.waitForTimeout(cfg.settleMs);
      }
    } else if (cfg.virtualTime) {
      await page.evaluate(() => window.__srPause());
    }
    if (cfg.virtualTime) await page.evaluate((f) => (window.__srFreezeCss = f), !!cfg.freezeAnimations);

    for (let f = 0; f < totalFrames; f++) {
      // Adaptive sampling: only take as many distinct sub-frame shots as the motion inside
      // this frame's shutter window needs (spacing <= maxStepPx), then repeat each one so
      // ffmpeg always averages exactly `samples` images per frame.
      let unique = 1;
      if (samples > 1) {
        const yOpen = scrollAt(timeline, clampTime((f - shutter / 2) / cfg.fps));
        const yMid = scrollAt(timeline, clampTime(f / cfg.fps));
        const yClose = scrollAt(timeline, clampTime((f + shutter / 2) / cfg.fps));
        const travel = (Math.abs(yMid - yOpen) + Math.abs(yClose - yMid)) * dpr;
        unique = Math.min(samples, Math.max(1, Math.ceil(travel / maxStep)));
      }

      for (let s = 0; s < samples; s++) {
        const k = Math.floor((s * unique) / samples);
        // Sub-frame instants spread across the shutter window, centered on the frame time.
        const offset = unique > 1 ? ((k + 0.5) / unique - 0.5) * shutter : 0;
        const time = clampTime((f + offset) / cfg.fps);
        // Snap to device pixels: the compositor can't render finer than that anyway.
        const y = Math.round(scrollAt(timeline, time) * dpr) / dpr;

        // With a virtual clock the page keeps changing even when scroll doesn't, so capture every
        // distinct sub-frame instant (holds still collapse to one shot per frame via `unique`).
        const needShot = cfg.virtualTime ? s === 0 || k !== Math.floor(((s - 1) * unique) / samples) : y !== lastY;

        if (needShot || !lastShot) {
          if (cfg.virtualTime) {
            const target = time * 1000;
            const dt = target - animMs;
            animMs = target;
            await page.evaluate(({ y, dt }) => {
              window.scrollTo({ top: y, behavior: "instant" });
              return window.__srAdvance(dt); // resolves once any videos have seeked
            }, { y, dt });
          } else {
            await page.evaluate((y) => {
              window.scrollTo({ top: y, behavior: "instant" });
              return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            }, y);
          }
          const { data } = await cdp.send("Page.captureScreenshot", {
            format: cfg.captureFormat,
            ...(cfg.captureFormat === "jpeg" ? { quality: 95 } : {}),
            optimizeForSpeed: true,
          });
          lastShot = Buffer.from(data, "base64");
          lastY = y;
          shots++;
        }
        await encoder.write(lastShot);
      }

      if (f % 10 === 0 || f === totalFrames - 1) {
        const done = (f + 1) * samples;
        const elapsed = (Date.now() - started) / 1000;
        const eta = (elapsed / done) * (totalCaptures - done);
        if (args.progressJson) {
          console.log("@@PROGRESS " + JSON.stringify({ frame: f + 1, total: totalFrames, eta: Math.round(eta) }));
          continue;
        }
        process.stdout.write(
          `\r  frame ${f + 1}/${totalFrames}  (${Math.round((done / totalCaptures) * 100)}%, ${shots} unique shots, ETA ${eta.toFixed(0)}s)   `
        );
      }
    }
    process.stdout.write(args.progressJson ? "@@STAGE encoding\n" : "\n  encoding…\n");
    await encoder.end();
    console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s → ${out}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("\n" + (err.stack || err.message));
  process.exit(1);
});

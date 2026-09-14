// Page preparation shared by the recorder and the editor's live view, so scroll
// positions marked in the editor land on exactly the same content when rendering.

// Headless Chromium defaults to software WebGL (SwiftShader), which makes Rive/WebGL/canvas-heavy
// pages ~200x slower to render. These flags use the real GPU (Metal on macOS).
export const GPU_ARGS = ["--enable-gpu", "--ignore-gpu-blocklist", ...(process.platform === "darwin" ? ["--use-angle=metal"] : [])];

// Containers injected by the common consent-management platforms.
export const COOKIE_BANNER_SELECTORS = [
  "#onetrust-consent-sdk", "#onetrust-banner-sdk", ".onetrust-pc-dark-filter", // OneTrust
  "#CybotCookiebotDialog", "#CybotCookiebotDialogBodyUnderlay", // Cookiebot
  "#truste-consent-track", ".truste_box_overlay", ".truste_overlay", "#consent_blackbar", // TrustArc
  "#usercentrics-root", "#usercentrics-cmp-ui", // Usercentrics
  "#didomi-host", // Didomi
  ".osano-cm-window", ".osano-cm-dialog", // Osano
  ".qc-cmp2-container", ".fc-consent-root", '[id^="sp_message_container"]', // Quantcast, Funding Choices, Sourcepoint
  "#hs-eu-cookie-confirmation", "#iubenda-cs-banner", "#axeptio_overlay", "#cmpbox", "#cmpbox2",
  "#ketch-consent-banner", "#transcend-consent-manager", "#termly-code-snippet-support",
  "#cookiescript_injected", "#cookie-law-info-bar", ".cky-consent-container", ".cky-overlay", ".cc-window", ".cc-banner",
];

export function pageCss({ hideSelectors = [], injectCss = "", hideCookieBanners = true } = {}) {
  const hidden = [...(hideCookieBanners ? COOKIE_BANNER_SELECTORS : []), ...hideSelectors];
  return `
    html, body { scroll-behavior: auto !important; }
    ::-webkit-scrollbar { display: none !important; }
    html { scrollbar-width: none !important; }
    ${hidden.map((s) => `${s} { display: none !important; }`).join("\n")}
    ${injectCss}
  `;
}

export async function applyCss(page, cfg) {
  await page.evaluate((css) => {
    let el = document.getElementById("__glidecast_css");
    if (!el) {
      el = document.createElement("style");
      el.id = "__glidecast_css";
      document.head.appendChild(el);
    }
    el.textContent = css;
  }, pageCss(cfg));
}

// Injected before any page script. Wraps requestAnimationFrame, performance.now and Date so the
// recorder can switch the page from real time to manually stepped time. rAF-driven animation
// (Rive, Lottie, GSAP, three.js, canvas loops) then advances exactly with the video clock.
// Plain setTimeout/setInterval stay on real time, which keeps analytics/ad scripts from
// making stepping slow.
export const VIRTUAL_TIME_SCRIPT = `(() => {
  if (window.__srAdvance) return;
  const realRaf = window.requestAnimationFrame.bind(window);
  const realPerfNow = performance.now.bind(performance);
  const RealDate = Date;
  const realDateNow = RealDate.now;
  let manual = false, fake = 0, dateBase = 0, nextId = 1;
  const pending = new Map();

  performance.now = () => (manual ? fake : realPerfNow());
  const dateNow = () => (manual ? dateBase + fake : realDateNow());
  function FakeDate(...args) {
    if (!new.target) return new RealDate(dateNow()).toString();
    return args.length ? new RealDate(...args) : new RealDate(dateNow());
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = dateNow;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  window.Date = FakeDate;

  window.requestAnimationFrame = (cb) => {
    const id = nextId++;
    const entry = { cb };
    pending.set(id, entry);
    realRaf((ts) => {
      if (manual || entry.done) return; // in manual mode it's flushed by __srAdvance instead
      entry.done = true;
      pending.delete(id);
      cb(ts);
    });
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    const e = pending.get(id);
    if (e) { e.done = true; pending.delete(id); }
  };

  // Timers: live mode uses real timeouts; manual mode fires them in due order as time is stepped.
  const realSetTimeout = window.setTimeout.bind(window);
  const realClearTimeout = window.clearTimeout.bind(window);
  const timers = new Map();
  let timerId = 1, flushing = false;
  const schedule = (t) => {
    if (!manual) t.realId = realSetTimeout(() => fire(t), Math.max(0, t.due - realPerfNow()));
  };
  const fire = (t) => {
    if (timers.get(t.id) !== t) return;
    if (t.interval != null) {
      t.due = performance.now() + t.interval;
      schedule(t);
    } else {
      timers.delete(t.id);
    }
    try {
      typeof t.cb === "function" ? t.cb(...t.args) : (0, eval)(String(t.cb));
    } catch (err) {
      console.error(err);
    }
  };
  const addTimer = (cb, delay, args, repeat) => {
    // Minimum 1ms while stepping, so zero-delay rescheduling loops can't spin forever.
    const d = Math.max(flushing ? 1 : 0, Number(delay) || 0);
    const t = { id: timerId++, cb, args, due: performance.now() + d, interval: repeat ? Math.max(1, d) : null };
    timers.set(t.id, t);
    schedule(t);
    return t.id;
  };
  const clearTimer = (id) => {
    const t = timers.get(id);
    if (!t) return;
    if (t.realId != null) realClearTimeout(t.realId);
    timers.delete(id);
  };
  window.setTimeout = (cb, delay, ...args) => addTimer(cb, delay, args, false);
  window.setInterval = (cb, delay, ...args) => addTimer(cb, delay, args, true);
  window.clearTimeout = clearTimer;
  window.clearInterval = clearTimer;

  // CSS animations/transitions and <video> run on the compositor/media clock, not JS time, so in
  // manual mode we pause each one as soon as it appears and step its currentTime ourselves.
  window.__srFreezeCss = false;

  // Videos: players like Mux/media-chrome keep <video> inside shadow roots, so track elements as
  // they call play() and also walk shadow trees periodically. A controlled video keeps "playing"
  // (so player UIs don't show a paused state) but at playbackRate 0; we seek it forward each step.
  const videos = new Set();
  const findVideos = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.tagName === "VIDEO") videos.add(el);
      if (el.shadowRoot) findVideos(el.shadowRoot);
    }
  };
  const control = (v) => {
    videos.add(v);
    if (v.__sr) return;
    v.__sr = true;
    v.__srT = v.currentTime;
    v.defaultPlaybackRate = 0;
    v.playbackRate = 0;
    // Players reset the rate when they load a new source; keep it at 0.
    v.addEventListener("ratechange", () => { if (manual && v.playbackRate !== 0) v.playbackRate = 0; });
    v.addEventListener("loadedmetadata", () => { if (manual) { v.defaultPlaybackRate = 0; v.playbackRate = 0; } });
  };
  const realPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    if (manual && this instanceof HTMLVideoElement) control(this);
    return realPlay.apply(this, args);
  };

  let walkTick = 0;
  const takeOver = (walk) => {
    let anims = [];
    try { anims = document.getAnimations(); } catch {}
    for (const a of anims) {
      if (a.__sr) continue;
      a.__sr = true;
      a.pause();
    }
    if (walk) findVideos(document);
    for (const v of videos) if (!v.__sr && (!v.paused || v.autoplay)) control(v);
  };
  const stepMedia = (dt) => {
    let anims = [];
    try { anims = document.getAnimations(); } catch {}
    if (!window.__srFreezeCss) {
      for (const a of anims) if (a.__sr && a.currentTime != null) a.currentTime += dt;
    }
    const seeks = [];
    for (const v of videos) {
      if (!v.__sr || !v.isConnected) continue;
      if (v.paused && !v.autoplay) { v.__srT = v.currentTime; continue; } // paused by the page
      if (!(v.duration > 0)) continue;
      if (dt > 0) {
        v.__srT += dt / 1000;
        if (Number.isFinite(v.duration)) v.__srT = v.loop ? v.__srT % v.duration : Math.min(v.__srT, v.duration);
      }
      if (Math.abs(v.currentTime - v.__srT) < 0.001) continue;
      v.currentTime = v.__srT;
      // Wait for the decoded frame so the screenshot shows the right moment.
      seeks.push(new Promise((resolve) => {
        const done = () => { clearT(); v.removeEventListener("seeked", done); resolve(); };
        const id = realSetTimeout(done, 2000);
        const clearT = () => realClearTimeout(id);
        v.addEventListener("seeked", done);
      }));
    }
    return seeks;
  };

  window.__srPause = () => {
    if (manual) return;
    fake = realPerfNow();
    dateBase = realDateNow() - fake;
    manual = true;
    for (const t of timers.values()) {
      if (t.realId != null) realClearTimeout(t.realId);
      t.realId = null;
    }
    // Keep catching newly created animations between steps (e.g. while a fresh page loads).
    const guard = () => { takeOver(walkTick++ % 20 === 0); realRaf(guard); };
    guard();
  };
  window.__srAdvance = (dt) => {
    takeOver(true);
    const seeks = stepMedia(dt);
    const target = fake + dt;
    flushing = true;
    for (let n = 0; n < 5000; n++) {
      let next = null;
      for (const t of timers.values()) if (t.due <= target && (!next || t.due < next.due)) next = t;
      if (!next) break;
      fake = Math.max(fake, next.due);
      fire(next);
    }
    flushing = false;
    fake = target;
    const batch = [...pending.values()];
    pending.clear();
    for (const e of batch) {
      if (e.done) continue;
      e.done = true;
      try { e.cb(fake); } catch (err) { console.error(err); }
    }
    takeOver(false); // anything started by those callbacks begins from its first frame next step
    if (seeks.length) return Promise.all(seeks).then(() => new Promise((r) => realRaf(() => r())));
  };
})();`;

// Added before a reload so the fresh page's clock is frozen from its very first script.
// Only the top frame is controlled; iframes keep real time.
export const START_PAUSED_SCRIPT = `if (window.top === window && window.__srPause) window.__srPause();`;

export const getMaxScroll = (page) =>
  page.evaluate(() => Math.max(0, document.documentElement.scrollHeight - window.innerHeight));

// Walk the page once so lazy-loaded images and sections exist before measuring.
export async function preScroll(page, viewportHeight) {
  let max = await getMaxScroll(page);
  for (let y = 0; y <= max; y += viewportHeight * 0.75) {
    await page.evaluate((y) => window.scrollTo(0, y), y);
    await page.waitForTimeout(120);
    max = await getMaxScroll(page);
  }
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await page.evaluate(() => window.scrollTo(0, 0));
}

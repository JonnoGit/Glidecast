import { cameraRect, lerpCamera, normCamera } from "/camera.js";
import { cubicBezier } from "/easing.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const STORAGE_KEY = "scroll-recorder-project-v1";
const uid = () => Math.random().toString(36).slice(2, 9);

const SIZE_PRESETS = [
  ["1920×1080", 1920, 1080],
  ["1440×900", 1440, 900],
  ["1280×720", 1280, 720],
  ["2560×1440", 2560, 1440],
  ["1080×1920", 1080, 1920],
  ["390×844", 390, 844],
];

const BEZIER_PRESETS = [
  ["ease", [0.25, 0.1, 0.25, 1]],
  ["inOutCubic", [0.65, 0, 0.35, 1]],
  ["inOutQuart", [0.76, 0, 0.24, 1]],
  ["inOutExpo", [0.87, 0, 0.13, 1]],
  ["outQuint", [0.22, 1, 0.36, 1]],
  ["outExpo", [0.16, 1, 0.3, 1]],
  ["overshoot", [0.34, 1.56, 0.64, 1]],
  ["linear", [0, 0, 1, 1]],
];

function defaultProject() {
  const tokens = [
    { id: uid(), name: "Smooth", bezier: [0.65, 0, 0.35, 1], duration: 1200 },
    { id: uid(), name: "Snappy", bezier: [0.2, 0, 0, 1], duration: 700 },
    { id: uid(), name: "Glide", bezier: [0.4, 0, 0.2, 1], duration: 2000 },
    { id: uid(), name: "Overshoot", bezier: [0.34, 1.4, 0.64, 1], duration: 1000 },
  ];
  return {
    url: "",
    width: 1920,
    height: 1080,
    dpr: 1,
    fps: 60,
    format: "mp4",
    fileName: "scroll",
    blur: true,
    shutter: 180,
    blurQuality: 1,
    hideSelectors: [],
    hideCookieBanners: true,
    freshStart: true,
    tokens,
    selectedToken: tokens[0].id,
    start: { y: 0, hold: 1000, zoom: 1, anchor: [0.5, 0.5] },
    checkpoints: [],
  };
}

let state = loadProject();

function loadProject() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && Array.isArray(saved.tokens)) return { ...defaultProject(), ...saved };
  } catch {}
  return defaultProject();
}

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {}
  }, 200);
}

// Live page state (from the server)
const live = {
  loaded: false,
  loading: false,
  loadedSize: null,
  frameY: 0,
  maxScroll: 0,
  desiredY: 0,
  sentY: null,
  inflight: false,
  lastInteraction: 0,
  mode: "scroll",
  camera: null, // zoom shown while scrubbing or previewing the timeline
  anchorFor: null, // checkpoint id (or "start") whose zoom anchor is being picked
  anchorHover: null,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round2 = (v) => Math.round(v * 100) / 100;
const fmtS = (ms) => (ms / 1000).toFixed(2).replace(/\.?0+$/, "") + "s";

async function api(pathname, body) {
  const res = await fetch(pathname, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

let toastTimer;
function toast(msg) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2200);
}

const tokenById = (id) => state.tokens.find((t) => t.id === id) ?? state.tokens[0];
const itemById = (id) => (id === "start" ? state.start : state.checkpoints.find((c) => c.id === id));
const camOf = (item) => normCamera(item.zoom, item.anchor);
const round3 = (v) => Math.round(v * 1000) / 1000;
const fmtZoom = (z) => `${round2(z)}×`;

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------

function bindSettings() {
  $("url").value = state.url;
  $("width").value = state.width;
  $("height").value = state.height;
  $("dpr").value = state.dpr;
  $("fps").value = state.fps;
  $("format").value = state.format;
  $("fileName").value = state.fileName;
  $("blur").checked = state.blur;
  $("shutter").value = state.shutter;
  $("blurQuality").value = state.blurQuality;
  $("hideCookies").checked = state.hideCookieBanners;
  $("freshStart").checked = state.freshStart;
  renderSizePresets();
  updateBlurUi();

  const num = (id, key, after) =>
    $(id).addEventListener("input", (e) => {
      const v = Number(e.target.value);
      if (!Number.isFinite(v)) return;
      state[key] = v;
      save();
      after?.();
    });
  num("width", "width", onSizeChange);
  num("height", "height", onSizeChange);
  num("dpr", "dpr", updateStats);
  num("fps", "fps", updateStats);
  num("shutter", "shutter", updateBlurUi);
  num("blurQuality", "blurQuality");
  $("format").addEventListener("change", (e) => ((state.format = e.target.value), save()));
  $("fileName").addEventListener("input", (e) => ((state.fileName = e.target.value), save()));
  $("freshStart").addEventListener("change", (e) => ((state.freshStart = e.target.checked), save()));
  $("blur").addEventListener("change", (e) => ((state.blur = e.target.checked), save(), updateBlurUi()));
  $("url").addEventListener("input", (e) => ((state.url = e.target.value.trim()), save()));
}

function renderSizePresets() {
  $("sizePresets").innerHTML = SIZE_PRESETS.map(
    ([label, w, h]) => `<button data-w="${w}" data-h="${h}" class="${w === state.width && h === state.height ? "on" : ""}">${label}</button>`
  ).join("");
}
$("sizePresets").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  state.width = Number(b.dataset.w);
  state.height = Number(b.dataset.h);
  $("width").value = state.width;
  $("height").value = state.height;
  save();
  onSizeChange();
});

function onSizeChange() {
  renderSizePresets();
  const s = live.loadedSize;
  $("sizeWarn").hidden = !s || (s.width === state.width && s.height === state.height);
  layoutStage();
}

function updateBlurUi() {
  $("shutterVal").textContent = `${state.shutter}°`;
  $("blurControls").style.opacity = state.blur ? 1 : 0.4;
  $("blurControls").style.pointerEvents = state.blur ? "" : "none";
}

// Hidden elements
function renderHidden() {
  $("hiddenList").innerHTML = state.hideSelectors
    .map((s, i) => `<li><span title="${esc(s)}">${esc(s)}</span><button class="btn icon" data-i="${i}" title="Show again">✕</button></li>`)
    .join("");
}
function syncCss() {
  renderHidden();
  save();
  api("/api/css", { hideSelectors: state.hideSelectors, hideCookieBanners: state.hideCookieBanners }).catch(() => {});
}
function addHidden(sel) {
  sel = sel.trim();
  if (!sel || state.hideSelectors.includes(sel)) return;
  state.hideSelectors.push(sel);
  syncCss();
}
$("hiddenList").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-i]");
  if (!b) return;
  state.hideSelectors.splice(Number(b.dataset.i), 1);
  syncCss();
});
$("hideAdd").addEventListener("click", () => {
  addHidden($("hideInput").value);
  $("hideInput").value = "";
});
$("hideCookies").addEventListener("change", (e) => {
  state.hideCookieBanners = e.target.checked;
  syncCss();
});
$("hideInput").addEventListener("keydown", (e) => e.key === "Enter" && $("hideAdd").click());

// ---------------------------------------------------------------------------
// Live page view
// ---------------------------------------------------------------------------

$("urlForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.url) return $("url").focus();
  await loadPage();
});

async function loadPage() {
  $("loadBtn").disabled = true;
  try {
    const s = await api("/api/load", {
      url: state.url,
      width: state.width,
      height: state.height,
      hideSelectors: state.hideSelectors,
      hideCookieBanners: state.hideCookieBanners,
    });
    live.loaded = true;
    live.loadedSize = { width: s.width, height: s.height };
    // Name renders after the page unless the user already picked a name.
    if (!state.fileName || state.fileName === "scroll") {
      const u = new URL(s.url);
      state.fileName = (u.hostname.replace(/^www\./, "") + u.pathname).replace(/[^\w]+/g, "-").replace(/^-|-$/g, "") || "scroll";
      $("fileName").value = state.fileName;
      save();
    }
    live.maxScroll = s.maxScroll;
    live.desiredY = live.frameY = live.sentY = s.scrollY;
    onSizeChange();
    renderAll();
  } catch (err) {
    toast(`Couldn't load page: ${err.message}`);
  } finally {
    $("loadBtn").disabled = false;
  }
}

const events = new EventSource("/api/events");
events.addEventListener("frame", (e) => {
  const f = JSON.parse(e.data);
  const img = $("live");
  img.src = `data:image/jpeg;base64,${f.image}`;
  live.loaded = true;
  live.loadedSize ??= { width: f.width, height: f.height };
  live.frameY = f.scrollY;
  live.maxScroll = f.maxScroll;
  // If the user isn't driving the scroll, follow the page (e.g. an anchor link was clicked).
  if (!preview.playing && !live.inflight && performance.now() - live.lastInteraction > 600) {
    live.desiredY = live.sentY = f.scrollY;
  }
  $("empty").hidden = true;
  layoutStage();
  updateLiveUi();
});
events.addEventListener("status", (e) => {
  const s = JSON.parse(e.data);
  live.loading = s.loading;
  $("loading").hidden = !s.loading;
  $("loadingMsg").textContent = s.message;
});
events.addEventListener("render", (e) => onRenderEvent(JSON.parse(e.data)));

function viewSize() {
  return live.loadedSize ?? { width: state.width, height: state.height };
}

function stageScale() {
  const stage = $("stage");
  const { width, height } = viewSize();
  return Math.min(stage.clientWidth / width, stage.clientHeight / height, 1);
}

function layoutStage() {
  const { width, height } = viewSize();
  const s = stageScale();
  const frame = $("frame");
  frame.style.width = `${width * s}px`;
  frame.style.height = `${height * s}px`;
  frame.hidden = !live.loaded;
  updateLiveUi();
}
new ResizeObserver(() => {
  layoutStage();
  drawTimeline();
}).observe($("stage"));

function updateLiveUi() {
  const s = stageScale();
  // Optimistic scroll: shift the last frame toward where we've asked the page to be.
  const dy = (live.frameY - live.desiredY) * s;
  const cam = live.camera;
  if (cam && cam.zoom > 1) {
    const { width, height } = viewSize();
    const r = cameraRect(cam, width, height);
    $("live").style.transform = `scale(${cam.zoom}) translate(${-r.x * s}px, ${dy - r.y * s}px)`;
  } else {
    $("live").style.transform = `translateY(${dy}px)`;
  }
  renderZoomBox();
  $("scrollY").textContent = live.loaded ? Math.round(live.desiredY) : "–";
  $("maxScroll").textContent = live.loaded ? Math.round(live.maxScroll) : "–";
  renderScrubber();
  markActiveCards();
}

function scrollToY(y, { interaction = true, camera = null } = {}) {
  if (!live.loaded) return;
  live.desiredY = Math.round(clamp(y, 0, live.maxScroll));
  live.camera = camera;
  if (interaction) live.lastInteraction = performance.now();
  updateLiveUi();
  flushScroll();
}

function flushScroll() {
  if (live.inflight || live.sentY === live.desiredY || live.loading) return;
  live.inflight = true;
  const y = live.desiredY;
  live.sentY = y;
  api("/api/scroll", { y })
    .then((s) => {
      live.maxScroll = s.maxScroll;
    })
    .catch(() => {})
    .finally(() => {
      live.inflight = false;
      flushScroll();
    });
}

const stage = $("stage");
stage.addEventListener(
  "wheel",
  (e) => {
    if (!live.loaded) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? viewSize().height : 1;
    // Divide by scale so content tracks the fingers on a trackpad.
    scrollToY(live.desiredY + (e.deltaY * unit) / stageScale());
  },
  { passive: false }
);

// Clicks: forward to the page, or pick an element to hide.
let downAt = null;
$("frame").addEventListener("pointerdown", (e) => (downAt = { x: e.clientX, y: e.clientY }));
$("frame").addEventListener("pointerup", async (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return;
  downAt = null;
  const { x, y } = pagePoint(e);
  if (live.mode === "anchor") {
    const item = itemById(live.anchorFor);
    const { width, height } = viewSize();
    if (item) {
      item.anchor = [round3(clamp(x / width, 0, 1)), round3(clamp(y / height, 0, 1))];
      if (!(item.zoom > 1)) item.zoom = 2;
      save();
    }
    setMode("scroll");
    renderAll();
  } else if (live.mode === "pick") {
    try {
      const { selector } = await api("/api/pick", { x, y });
      if (!selector) return toast("Nothing to hide there");
      addHidden(selector);
      toast(`Hidden: ${selector}`);
    } catch (err) {
      toast(err.message);
    }
    setMode("scroll");
  } else {
    api("/api/click", { x, y }).catch(() => {});
  }
});

// Pointer position in page CSS px, accounting for the preview's zoom if one is showing.
function pagePoint(e) {
  const rect = $("frame").getBoundingClientRect();
  const s = stageScale();
  let x = (e.clientX - rect.left) / s;
  let y = (e.clientY - rect.top) / s;
  if (live.camera?.zoom > 1) {
    const { width, height } = viewSize();
    const r = cameraRect(live.camera, width, height);
    x = r.x + x / live.camera.zoom;
    y = r.y + y / live.camera.zoom;
  }
  return { x, y };
}

$("frame").addEventListener("pointermove", (e) => {
  if (live.mode !== "anchor") return;
  const { x, y } = pagePoint(e);
  const { width, height } = viewSize();
  live.anchorHover = [clamp(x / width, 0, 1), clamp(y / height, 0, 1)];
  renderZoomBox();
});
$("frame").addEventListener("pointerleave", () => {
  live.anchorHover = null;
  renderZoomBox();
});

function setMode(mode, anchorFor = null) {
  const wasAnchor = live.mode === "anchor";
  live.mode = mode;
  live.anchorFor = mode === "anchor" ? anchorFor : null;
  live.anchorHover = null;
  stage.classList.toggle("pick", mode === "pick");
  stage.classList.toggle("anchor", mode === "anchor");
  for (const b of $("modeSeg").children) b.classList.toggle("on", b.dataset.mode === mode);
  if (wasAnchor || mode === "anchor") renderCheckpoints();
  renderZoomBox();
}
$("modeSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) setMode(b.dataset.mode);
});

// Zoom box: outlines what a zoomed checkpoint will show, for the checkpoint at the current position
// (or the one whose anchor is being picked, following the pointer).
function renderZoomBox() {
  const box = $("zoomBox");
  let item = null;
  let anchor = null;
  if (live.mode === "anchor") {
    item = itemById(live.anchorFor);
    anchor = live.anchorHover;
  } else if (!live.camera) {
    const y = Math.round(live.desiredY);
    item = [state.start, ...state.checkpoints].find((c) => Math.abs(c.y - y) <= 1 && camOf(c).zoom > 1);
  }
  box.hidden = !live.loaded || !item;
  if (box.hidden) return;
  const cam = camOf({ zoom: item.zoom, anchor: anchor ?? item.anchor });
  const { width, height } = viewSize();
  const s = stageScale();
  const r = cameraRect(cam, width, height);
  Object.assign(box.style, { left: `${r.x * s}px`, top: `${r.y * s}px`, width: `${r.width * s}px`, height: `${r.height * s}px` });
  $("zoomLabel").textContent = fmtZoom(cam.zoom);
  // The anchor is the point that stays put on screen, so inside the box it sits at the same fraction.
  Object.assign($("anchorDot").style, { left: `${cam.anchor[0] * 100}%`, top: `${cam.anchor[1] * 100}%` });
}

// Scrubber
function renderScrubber() {
  const track = $("scrubber");
  const h = track.clientHeight;
  const { height } = viewSize();
  const max = live.maxScroll || 1;
  const thumbH = Math.max(20, (height / (max + height)) * h);
  const top = live.loaded ? (live.desiredY / max) * (h - thumbH) : 0;
  const thumb = $("thumb");
  thumb.style.height = `${thumbH}px`;
  thumb.style.top = `${top}px`;
  const yToTrack = (y) => (clamp(y, 0, max) / max) * (h - thumbH) + thumbH / 2;
  const ticks = [`<div class="tick start" data-n="S" data-y="${state.start.y}" style="top:${yToTrack(state.start.y)}px" title="Start · ${state.start.y}px"></div>`];
  state.checkpoints.forEach((cp, i) =>
    ticks.push(`<div class="tick" data-n="${i + 1}" data-y="${cp.y}" style="top:${yToTrack(cp.y)}px" title="${esc(cp.label || `Checkpoint ${i + 1}`)} · ${cp.y}px"></div>`)
  );
  $("ticks").innerHTML = live.loaded ? ticks.join("") : "";
}

{
  const track = $("scrubber");
  const seek = (e) => {
    const rect = track.getBoundingClientRect();
    const { height } = viewSize();
    const max = live.maxScroll || 1;
    const thumbH = Math.max(20, (height / (max + height)) * rect.height);
    const p = clamp((e.clientY - rect.top - thumbH / 2) / (rect.height - thumbH), 0, 1);
    scrollToY(p * max);
  };
  track.addEventListener("pointerdown", (e) => {
    const tick = e.target.closest(".tick");
    if (tick) return scrollToY(Number(tick.dataset.y));
    track.setPointerCapture(e.pointerId);
    seek(e);
    const move = (ev) => seek(ev);
    const up = () => {
      track.removeEventListener("pointermove", move);
      track.removeEventListener("pointerup", up);
    };
    track.addEventListener("pointermove", move);
    track.addEventListener("pointerup", up);
  });
}

// Keyboard
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, select, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
  const vh = viewSize().height;
  const keys = {
    m: markCheckpoint,
    M: markCheckpoint,
    ArrowDown: () => scrollToY(live.desiredY + 60),
    ArrowUp: () => scrollToY(live.desiredY - 60),
    PageDown: () => scrollToY(live.desiredY + vh * 0.9),
    PageUp: () => scrollToY(live.desiredY - vh * 0.9),
    " ": () => scrollToY(live.desiredY + (e.shiftKey ? -1 : 1) * vh * 0.9),
    Home: () => scrollToY(0),
    End: () => scrollToY(live.maxScroll),
    Escape: () => setMode("scroll"),
  };
  if (keys[e.key]) {
    e.preventDefault();
    keys[e.key]();
  }
});

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

function markCheckpoint() {
  if (!live.loaded) return toast("Load a page first");
  const last = state.checkpoints.at(-1);
  state.checkpoints.push({
    id: uid(),
    label: "",
    y: Math.round(live.desiredY),
    tokenId: last?.tokenId ?? state.selectedToken ?? state.tokens[0].id,
    hold: last?.hold ?? 1000,
    zoom: 1,
    anchor: [0.5, 0.5],
  });
  save();
  renderAll();
  const list = $("cpList");
  list.lastElementChild?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  toast(`Checkpoint ${state.checkpoints.length} at ${Math.round(live.desiredY)}px`);
}
$("markBtn").addEventListener("click", markCheckpoint);
$("setStartBtn").addEventListener("click", () => {
  if (!live.loaded) return toast("Load a page first");
  state.start.y = Math.round(live.desiredY);
  save();
  renderAll();
  toast(`Start set to ${state.start.y}px`);
});

function tokenOptions(selected) {
  return state.tokens.map((t) => `<option value="${t.id}" ${t.id === selected ? "selected" : ""}>${esc(t.name)} · ${t.duration}ms</option>`).join("");
}

function zoomRow(item, id) {
  const cam = camOf(item);
  const picking = live.mode === "anchor" && live.anchorFor === id;
  const text = picking ? "Click the preview…" : cam.zoom > 1 ? `⌖ ${Math.round(cam.anchor[0] * 100)}%, ${Math.round(cam.anchor[1] * 100)}%` : "⌖ Pick point";
  return `
        <div class="zoom-row">
          <label class="field"><span>Zoom (×)</span><input type="number" data-k="zoom" value="${round2(cam.zoom)}" min="1" max="10" step="0.25" /></label>
          <div class="field"><span>Zoom anchor</span><button class="btn anchor-btn ${picking ? "on" : ""}" data-act="anchor" title="Click a point in the preview. It stays in place while the view zooms around it.">${text}</button></div>
        </div>`;
}

function renderCheckpoints() {
  $("startCard").innerHTML = `
    <div class="card start-card" data-kind="start">
      <div class="badge" data-act="go" title="Go to start">S</div>
      <div class="card-title"><b>Start</b><span class="muted">first frame</span></div>
      <div class="card-actions"></div>
      <div class="card-body">
        <label class="field"><span>Scroll Y (px)</span>
          <div class="ypos"><input type="number" data-k="y" value="${state.start.y}" min="0" /><button class="btn icon" data-act="here" title="Use current position">⌖</button></div>
        </label>
        <label class="field"><span>Hold (ms)</span><input type="number" data-k="hold" value="${state.start.hold}" min="0" step="100" /></label>
        <div></div>${zoomRow(state.start, "start")}
      </div>
    </div>`;

  $("cpList").innerHTML = state.checkpoints
    .map(
      (cp, i) => `
    <li class="card" data-id="${cp.id}">
      <div class="badge" data-act="go" title="Go to checkpoint">${i + 1}</div>
      <div class="card-title"><input type="text" data-k="label" value="${esc(cp.label)}" placeholder="Checkpoint ${i + 1}" /></div>
      <div class="card-actions">
        <button class="btn icon" data-act="up" title="Move earlier" ${i === 0 ? "disabled" : ""}>↑</button>
        <button class="btn icon" data-act="down" title="Move later" ${i === state.checkpoints.length - 1 ? "disabled" : ""}>↓</button>
        <button class="btn icon" data-act="del" title="Delete">✕</button>
      </div>
      <div class="card-body">
        <label class="field"><span>Scroll Y (px)</span>
          <div class="ypos"><input type="number" data-k="y" value="${cp.y}" min="0" /><button class="btn icon" data-act="here" title="Use current position">⌖</button></div>
        </label>
        <label class="field"><span>Move easing</span><select data-k="tokenId">${tokenOptions(cp.tokenId)}</select></label>
        <label class="field"><span>Hold (ms)</span><input type="number" data-k="hold" value="${cp.hold}" min="0" step="100" /></label>${zoomRow(cp, cp.id)}
      </div>
    </li>`
    )
    .join("");

  $("cpCount").textContent = state.checkpoints.length || "";
  $("cpEmpty").hidden = state.checkpoints.length > 0;
  markActiveCards();
}

function markActiveCards() {
  const y = Math.round(live.desiredY);
  document.querySelector(".start-card")?.classList.toggle("active", live.loaded && Math.abs(state.start.y - y) <= 1);
  for (const li of $("cpList").children) {
    const cp = state.checkpoints.find((c) => c.id === li.dataset.id);
    li.classList.toggle("active", live.loaded && !!cp && Math.abs(cp.y - y) <= 1);
  }
}

function cardTarget(el) {
  const card = el.closest(".card");
  if (!card) return null;
  if (card.dataset.kind === "start") return { card, item: state.start, index: -1 };
  const index = state.checkpoints.findIndex((c) => c.id === card.dataset.id);
  return { card, item: state.checkpoints[index], index };
}

const panelRight = document.querySelector(".panel.right");
panelRight.addEventListener("input", (e) => {
  const k = e.target.dataset.k;
  const t = k && cardTarget(e.target);
  if (!t) return;
  if (k === "zoom") t.item.zoom = Math.max(1, Number(e.target.value) || 1);
  else t.item[k] = e.target.type === "number" ? Math.max(0, Number(e.target.value) || 0) : e.target.value;
  save();
  renderZoomBox();
  updateStats();
  drawTimeline();
  renderScrubber();
  if (k === "y") scrollToY(t.item.y);
});
panelRight.addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  const t = act && cardTarget(e.target);
  if (!t) return;
  const list = state.checkpoints;
  if (act === "go") scrollToY(t.item.y);
  if (act === "anchor") {
    if (!live.loaded) return toast("Load a page first");
    const id = t.index === -1 ? "start" : t.item.id;
    if (live.mode === "anchor" && live.anchorFor === id) return setMode("scroll");
    scrollToY(t.item.y);
    if (!(t.item.zoom > 1)) t.item.zoom = 2;
    save();
    setMode("anchor", id);
    renderAll();
    return toast("Click the point to zoom into");
  }
  if (act === "here") {
    if (!live.loaded) return toast("Load a page first");
    t.item.y = Math.round(live.desiredY);
  }
  if (act === "del") list.splice(t.index, 1);
  if (act === "up" && t.index > 0) [list[t.index - 1], list[t.index]] = [list[t.index], list[t.index - 1]];
  if (act === "down" && t.index < list.length - 1) [list[t.index + 1], list[t.index]] = [list[t.index], list[t.index + 1]];
  if (act !== "go") {
    save();
    renderAll();
  }
});

// ---------------------------------------------------------------------------
// Easing tokens
// ---------------------------------------------------------------------------

function drawCurve(canvas, bezier, { size, pad, yMin = -0.35, yMax = 1.35, handles = false }) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const w = size - pad * 2;
  const X = (x) => pad + x * w;
  const Y = (y) => pad + ((yMax - y) / (yMax - yMin)) * w;
  const [x1, y1, x2, y2] = bezier;

  if (handles) {
    ctx.strokeStyle = "#262930";
    ctx.lineWidth = 1;
    ctx.strokeRect(X(0), Y(1), w, Y(0) - Y(1));
  }
  ctx.beginPath();
  ctx.moveTo(X(0), Y(0));
  ctx.bezierCurveTo(X(x1), Y(y1), X(x2), Y(y2), X(1), Y(1));
  ctx.strokeStyle = "#a597ff";
  ctx.lineWidth = handles ? 2.5 : 1.75;
  ctx.stroke();

  if (handles) {
    ctx.strokeStyle = "#8a8f99";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(X(0), Y(0));
    ctx.lineTo(X(x1), Y(y1));
    ctx.moveTo(X(1), Y(1));
    ctx.lineTo(X(x2), Y(y2));
    ctx.stroke();
    for (const [hx, hy] of [[x1, y1], [x2, y2]]) {
      ctx.beginPath();
      ctx.arc(X(hx), Y(hy), 6, 0, Math.PI * 2);
      ctx.fillStyle = "#7c6cff";
      ctx.fill();
      ctx.strokeStyle = "white";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
  return { X, Y, w, pad, yMin, yMax };
}

function renderTokens() {
  const usage = (id) => state.checkpoints.filter((c) => c.tokenId === id).length;
  $("tokenList").innerHTML = state.tokens
    .map(
      (t) => `
    <li class="token ${t.id === state.selectedToken ? "on" : ""}" data-id="${t.id}">
      <canvas></canvas>
      <span class="name">${esc(t.name)}</span>
      <span class="meta">${t.duration}ms${usage(t.id) ? ` · ${usage(t.id)}×` : ""}</span>
    </li>`
    )
    .join("");
  [...$("tokenList").children].forEach((li) => drawCurve(li.querySelector("canvas"), tokenById(li.dataset.id).bezier, { size: 26, pad: 3, yMin: -0.2, yMax: 1.2 }));
  renderTokenEditor();
}

$("tokenList").addEventListener("click", (e) => {
  const li = e.target.closest(".token");
  if (!li) return;
  state.selectedToken = li.dataset.id;
  save();
  renderTokens();
});

$("addToken").addEventListener("click", () => {
  const src = tokenById(state.selectedToken);
  const t = { id: uid(), name: `${src.name} copy`, bezier: [...src.bezier], duration: src.duration };
  state.tokens.push(t);
  state.selectedToken = t.id;
  save();
  renderAll();
});

function renderTokenEditor() {
  const t = tokenById(state.selectedToken);
  const ed = $("tokenEditor");
  if (!t) return (ed.innerHTML = "");
  ed.innerHTML = `
    <div class="te-top">
      <label class="field"><span>Token name</span><input type="text" id="teName" value="${esc(t.name)}" /></label>
      <label class="field"><span>Duration (ms)</span><input type="number" id="teDur" value="${t.duration}" min="50" step="50" /></label>
    </div>
    <div class="te-main">
      <canvas class="bezier" id="teCanvas"></canvas>
      <div class="bz-values">
        ${["x1", "y1", "x2", "y2"].map((k, i) => `<label class="field"><span>${k}</span><input type="number" step="0.01" data-bz="${i}" value="${t.bezier[i]}" ${i % 2 === 0 ? 'min="0" max="1"' : ""} /></label>`).join("")}
        <div class="bz-css" id="teCss" title="Click to copy">cubic-bezier(${t.bezier.join(", ")})</div>
      </div>
    </div>
    <div class="bz-presets">${BEZIER_PRESETS.map(([n], i) => `<button data-preset="${i}">${n}</button>`).join("")}</div>
    <div class="te-foot">
      <div class="ball-track"><div class="ball" id="teBall"></div></div>
      <button class="btn small" id="teDelete" ${state.tokens.length <= 1 ? "disabled" : ""}>Delete token</button>
    </div>`;

  const canvas = $("teCanvas");
  let geo = drawCurve(canvas, t.bezier, { size: 150, pad: 14, handles: true });

  const refresh = ({ inputs = true } = {}) => {
    geo = drawCurve(canvas, t.bezier, { size: 150, pad: 14, handles: true });
    $("teCss").textContent = `cubic-bezier(${t.bezier.join(", ")})`;
    if (inputs) ed.querySelectorAll("[data-bz]").forEach((inp) => (inp.value = t.bezier[inp.dataset.bz]));
    save();
    drawTimeline();
    updateStats();
    const li = $("tokenList").querySelector(`[data-id="${t.id}"]`);
    if (li) {
      drawCurve(li.querySelector("canvas"), t.bezier, { size: 26, pad: 3, yMin: -0.2, yMax: 1.2 });
      li.querySelector(".meta").textContent = `${t.duration}ms`;
    }
  };

  $("teName").addEventListener("input", (e) => {
    t.name = e.target.value;
    save();
    const li = $("tokenList").querySelector(`[data-id="${t.id}"] .name`);
    if (li) li.textContent = t.name;
  });
  $("teName").addEventListener("change", renderCheckpoints);
  $("teDur").addEventListener("input", (e) => {
    t.duration = Math.max(0, Number(e.target.value) || 0);
    refresh();
  });
  $("teDur").addEventListener("change", renderCheckpoints);
  ed.querySelectorAll("[data-bz]").forEach((inp) =>
    inp.addEventListener("input", () => {
      const i = Number(inp.dataset.bz);
      const v = Number(inp.value);
      if (!Number.isFinite(v)) return;
      t.bezier[i] = i % 2 === 0 ? clamp(v, 0, 1) : v;
      refresh({ inputs: false });
    })
  );
  ed.querySelector(".bz-presets").addEventListener("click", (e) => {
    const b = e.target.closest("[data-preset]");
    if (!b) return;
    t.bezier = [...BEZIER_PRESETS[b.dataset.preset][1]];
    refresh();
  });
  $("teCss").addEventListener("click", () => {
    navigator.clipboard?.writeText($("teCss").textContent);
    toast("Copied");
  });
  $("teDelete").addEventListener("click", () => {
    if (state.tokens.length <= 1) return;
    state.tokens = state.tokens.filter((x) => x.id !== t.id);
    const fallback = state.tokens[0].id;
    state.checkpoints.forEach((c) => c.tokenId === t.id && (c.tokenId = fallback));
    state.selectedToken = fallback;
    save();
    renderAll();
  });

  // Drag handles
  let dragging = null;
  const toCurve = (e) => {
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    return {
      px,
      py,
      x: (px - geo.pad) / geo.w,
      y: geo.yMax - ((py - geo.pad) / geo.w) * (geo.yMax - geo.yMin),
    };
  };
  canvas.addEventListener("pointerdown", (e) => {
    const p = toCurve(e);
    const d1 = Math.hypot(p.px - geo.X(t.bezier[0]), p.py - geo.Y(t.bezier[1]));
    const d2 = Math.hypot(p.px - geo.X(t.bezier[2]), p.py - geo.Y(t.bezier[3]));
    const near = Math.min(d1, d2);
    dragging = near < 16 ? (d1 <= d2 ? 0 : 2) : p.x < 0.5 ? 0 : 2;
    canvas.setPointerCapture(e.pointerId);
    move(e);
  });
  const move = (e) => {
    if (dragging == null) return;
    const p = toCurve(e);
    t.bezier[dragging] = round2(clamp(p.x, 0, 1));
    t.bezier[dragging + 1] = round2(clamp(p.y, -1, 2));
    refresh();
  };
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", () => (dragging = null));

  startBall(t);
}

let ballRaf;
function startBall(t) {
  cancelAnimationFrame(ballRaf);
  let t0 = performance.now();
  const loop = (now) => {
    const ball = $("teBall");
    if (!ball) return;
    const dur = Math.max(1, t.duration);
    const cycle = dur + 500;
    const el = (now - t0) % cycle;
    const p = cubicBezier(...t.bezier)(Math.min(1, el / dur));
    const track = ball.parentElement.clientWidth - 8;
    ball.style.transform = `translateX(${p * track}px)`;
    ballRaf = requestAnimationFrame(loop);
  };
  ballRaf = requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------------
// Timeline model + graph
// ---------------------------------------------------------------------------

function buildTimeline() {
  const maxY = live.loaded ? live.maxScroll : Infinity;
  const cy = (y) => clamp(y, 0, maxY);
  const segs = [];
  let t = 0;
  let pos = cy(state.start.y);
  let cam = camOf(state.start);
  const hold = (ms, label) => {
    if (ms > 0) segs.push({ kind: "hold", t0: t, t1: t + ms, from: pos, to: pos, cam0: cam, cam1: cam, label });
    t += Math.max(0, ms);
  };
  hold(state.start.hold, "S");
  state.checkpoints.forEach((cp, i) => {
    const tok = tokenById(cp.tokenId);
    const to = cy(cp.y);
    const cam1 = camOf(cp);
    segs.push({ kind: "move", t0: t, t1: t + tok.duration, from: pos, to, cam0: cam, cam1, ease: cubicBezier(...tok.bezier), n: i + 1 });
    t += tok.duration;
    pos = to;
    cam = cam1;
    hold(cp.hold, i + 1);
  });
  return { segs, total: t, start: cy(state.start.y), startCam: camOf(state.start), end: { y: pos, cam } };
}

// Scroll position and zoom at a time: { y, cam }.
function stateAt(tl, ms) {
  for (const s of tl.segs) {
    if (ms < s.t1) {
      if (s.kind === "hold") return { y: s.from, cam: s.cam1 };
      const p = s.ease(clamp((ms - s.t0) / Math.max(1, s.t1 - s.t0), 0, 1));
      return { y: s.from + (s.to - s.from) * p, cam: lerpCamera(s.cam0, s.cam1, p) };
    }
  }
  return tl.end;
}
const yAt = (tl, ms) => stateAt(tl, ms).y;
const scrubTo = (st) => scrollToY(st.y, { camera: st.cam });

function updateStats() {
  const tl = buildTimeline();
  const frames = Math.round((tl.total / 1000) * state.fps);
  const w = state.width * state.dpr;
  const h = state.height * state.dpr;
  $("timelineStats").textContent = `${fmtS(tl.total)} · ${frames} frames @ ${state.fps}fps · ${w}×${h}`;
}

// t is the playhead (ms). Playback runs from `from` at `startedAt`; dragging holds it in place.
const preview = { playing: false, t: 0, hover: null, dragging: false, from: 0, startedAt: 0 };

function drawTimeline() {
  const canvas = $("timeline");
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const tl = buildTimeline();
  const padL = 52, padR = 12, padT = 12, padB = 20;
  const pw = W - padL - padR;
  const ph = H - padT - padB;
  const allY = [tl.start, ...tl.segs.map((s) => s.to), ...(live.loaded ? [live.maxScroll] : [])];
  const maxY = Math.max(1, ...allY);
  const total = Math.max(tl.total, 1000);
  const X = (ms) => padL + (ms / total) * pw;
  const Y = (y) => padT + (y / maxY) * ph;

  ctx.font = "10px -apple-system, system-ui, sans-serif";
  ctx.textBaseline = "middle";

  // Grid: seconds
  const step = total > 20000 ? 5000 : total > 8000 ? 2000 : 1000;
  for (let ms = 0; ms <= total; ms += step) {
    ctx.strokeStyle = "#1f2127";
    ctx.beginPath();
    ctx.moveTo(X(ms), padT);
    ctx.lineTo(X(ms), padT + ph);
    ctx.stroke();
    ctx.fillStyle = "#6b707a";
    ctx.textAlign = "center";
    ctx.fillText(`${ms / 1000}s`, X(ms), H - 8);
  }
  // Y labels
  ctx.textAlign = "right";
  for (const y of [0, maxY]) {
    ctx.fillStyle = "#6b707a";
    ctx.fillText(`${Math.round(y)}px`, padL - 8, Y(y));
    ctx.strokeStyle = "#1f2127";
    ctx.beginPath();
    ctx.moveTo(padL, Y(y));
    ctx.lineTo(padL + pw, Y(y));
    ctx.stroke();
  }

  if (!tl.segs.length) {
    ctx.fillStyle = "#6b707a";
    ctx.textAlign = "center";
    ctx.fillText("Mark checkpoints to build the timeline", padL + pw / 2, padT + ph / 2);
    return;
  }

  // Hold bands
  for (const s of tl.segs) {
    if (s.kind !== "hold") continue;
    ctx.fillStyle = "rgba(255,255,255,0.035)";
    ctx.fillRect(X(s.t0), padT, X(s.t1) - X(s.t0), ph);
  }

  // Curve
  ctx.beginPath();
  const n = Math.max(200, Math.round(pw));
  for (let i = 0; i <= n; i++) {
    const ms = (i / n) * tl.total;
    const px = X(ms);
    const py = Y(yAt(tl, ms));
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.strokeStyle = "#a597ff";
  ctx.lineWidth = 2;
  ctx.stroke();

  // Checkpoint dots
  ctx.textAlign = "center";
  const dot = (ms, y, label, color) => {
    ctx.beginPath();
    ctx.arc(X(ms), Y(y), 7, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.fillStyle = color === "#3ecf8e" ? "#06281a" : "white";
    ctx.font = "bold 9px -apple-system, system-ui, sans-serif";
    ctx.fillText(label, X(ms), Y(y) + 0.5);
  };
  dot(0, tl.start, "S", "#3ecf8e");
  for (const s of tl.segs) if (s.kind === "move") dot(s.t1, s.to, String(s.n), "#7c6cff");

  // Zoom labels beside zoomed checkpoints
  ctx.font = "10px -apple-system, system-ui, sans-serif";
  ctx.fillStyle = "#a597ff";
  ctx.textAlign = "left";
  const zoomLabel = (ms, y, cam) => cam.zoom > 1 && ctx.fillText(fmtZoom(cam.zoom), X(ms) + 10, Y(y) + (Y(y) > padT + ph - 10 ? -10 : 10));
  zoomLabel(0, tl.start, tl.startCam);
  for (const s of tl.segs) if (s.kind === "move" && (s.cam1.zoom !== s.cam0.zoom || s.cam1.anchor !== s.cam0.anchor)) zoomLabel(s.t1, s.to, s.cam1);

  // Hover line, then the playhead, labelled while it's in use (otherwise the hover gets the label)
  preview.t = Math.min(preview.t, tl.total);
  const line = (ms, color, width) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(X(ms), padT);
    ctx.lineTo(X(ms), padT + ph);
    ctx.stroke();
  };
  if (preview.hover != null && !preview.dragging) line(preview.hover, "rgba(255,255,255,0.3)", 1);
  line(preview.t, preview.playing ? "#ff6b6b" : "#e7e8ea", 1.5);
  ctx.beginPath();
  ctx.moveTo(X(preview.t) - 5, padT - 6);
  ctx.lineTo(X(preview.t) + 5, padT - 6);
  ctx.lineTo(X(preview.t), padT);
  ctx.fillStyle = preview.playing ? "#ff6b6b" : "#e7e8ea";
  ctx.fill();
  const head = preview.playing || preview.dragging || preview.hover == null ? preview.t : preview.hover;
  {
    ctx.fillStyle = "#e7e8ea";
    ctx.textAlign = X(head) > W - 90 ? "right" : "left";
    ctx.font = "10px -apple-system, system-ui, sans-serif";
    const st = stateAt(tl, head);
    ctx.fillText(`${fmtS(head)} · ${Math.round(st.y)}px${st.cam.zoom > 1.001 ? ` · ${fmtZoom(st.cam.zoom)}` : ""}`, X(head) + (ctx.textAlign === "left" ? 6 : -6), padT + 6);
  }

  canvas._map = { padL, pw, total };
}

{
  const canvas = $("timeline");
  const msAt = (e) => {
    const m = canvas._map;
    if (!m) return null;
    const x = e.clientX - canvas.getBoundingClientRect().left;
    const tl = buildTimeline();
    return clamp(((x - m.padL) / m.pw) * m.total, 0, tl.total);
  };
  // Click or drag to move the playhead. While playing, playback holds during the drag and carries
  // on from wherever it's released.
  const seek = (e) => {
    const ms = msAt(e);
    if (ms == null) return;
    preview.t = ms;
    scrubTo(stateAt(buildTimeline(), ms));
  };
  canvas.addEventListener("pointermove", (e) => {
    preview.hover = msAt(e);
    if (preview.dragging) seek(e);
    drawTimeline();
  });
  canvas.addEventListener("pointerleave", () => ((preview.hover = null), drawTimeline()));
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    preview.dragging = true;
    seek(e);
    drawTimeline();
  });
  const release = () => {
    if (!preview.dragging) return;
    preview.dragging = false;
    preview.from = preview.t;
    preview.startedAt = performance.now();
    drawTimeline();
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
}

function stopPreview() {
  preview.playing = false;
  $("previewBtn").textContent = "▶ Preview motion";
  drawTimeline();
}
$("previewBtn").addEventListener("click", () => {
  if (preview.playing) return stopPreview();
  if (!live.loaded) return toast("Load a page first");
  if (!state.checkpoints.length) return toast("Add a checkpoint first");
  // Play from the playhead, or from the start if it's at the end.
  if (preview.t >= buildTimeline().total - 1) preview.t = 0;
  preview.playing = true;
  preview.from = preview.t;
  preview.startedAt = performance.now();
  $("previewBtn").textContent = "❚❚ Pause";
  const tick = (now) => {
    if (!preview.playing) return;
    const tl = buildTimeline(); // picks up edits made while playing
    if (!preview.dragging) {
      preview.t = preview.from + (now - preview.startedAt);
      if (preview.t >= tl.total) {
        preview.t = tl.total;
        scrubTo(stateAt(tl, tl.total));
        return stopPreview();
      }
      scrubTo(stateAt(tl, preview.t));
    }
    drawTimeline();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function buildConfig() {
  const timeline = [];
  // Only write zoom into the config when the project uses it, so plain scroll configs stay tidy.
  const usesZoom = [state.start, ...state.checkpoints].some((c) => camOf(c).zoom > 1);
  const zoomOf = (c) => (usesZoom ? { zoom: camOf(c).zoom, anchor: camOf(c).anchor } : {});
  if (state.start.hold > 0) timeline.push({ wait: state.start.hold / 1000 });
  for (const cp of state.checkpoints) {
    const tok = tokenById(cp.tokenId);
    timeline.push({ scroll: cp.y, ...zoomOf(cp), duration: tok.duration / 1000, easing: tok.bezier, token: tok.name, ...(cp.label ? { label: cp.label } : {}) });
    if (cp.hold > 0) timeline.push({ wait: cp.hold / 1000 });
  }
  return {
    url: /^[a-z][a-z\d+.-]*:/i.test(state.url) ? state.url : `https://${state.url}`,
    output: `${(state.fileName || "scroll").trim()}.${state.format}`,
    viewport: { width: state.width, height: state.height, deviceScaleFactor: state.dpr },
    fps: state.fps,
    motionBlur: { enabled: state.blur, shutterAngle: state.shutter, samples: 64, maxStepPx: state.blurQuality },
    hideSelectors: state.hideSelectors,
    hideCookieBanners: state.hideCookieBanners,
    freshStart: state.freshStart,
    start: state.start.y,
    ...(usesZoom ? { startZoom: camOf(state.start).zoom, startAnchor: camOf(state.start).anchor } : {}),
    timeline,
  };
}

async function render(draft) {
  if (!state.url) return toast("Enter a URL first");
  if (!state.checkpoints.length) return toast("Add at least one checkpoint");
  const s = live.loadedSize;
  if (s && (s.width !== state.width || s.height !== state.height)) {
    if (!confirm("The page size changed since the preview loaded, so checkpoints may land in different places. Render anyway?")) return;
  }
  try {
    await api("/api/render", { config: buildConfig(), draft });
  } catch (err) {
    toast(err.message);
  }
}
$("draftBtn").addEventListener("click", () => render(true));
$("renderBtn").addEventListener("click", () => render(false));
$("cancelBtn").addEventListener("click", () => api("/api/cancel"));
$("revealBtn").addEventListener("click", () => api("/api/reveal", { file: $("revealBtn").dataset.file }));

function onRenderEvent(ev) {
  const running = ev.state === "running";
  $("renderBtn").disabled = $("draftBtn").disabled = running;
  $("progress").hidden = !running && ev.state !== "error";
  const prog = $("progress");
  if (running) {
    const label = ev.draft ? "Draft" : "Render";
    if (ev.progress) {
      prog.classList.remove("indeterminate");
      $("progressBar").style.width = `${(ev.progress.frame / ev.progress.total) * 100}%`;
      $("progressMsg").textContent = `${label}: frame ${ev.progress.frame}/${ev.progress.total} · ~${ev.progress.eta}s left`;
    } else {
      if (ev.progress === null || !prog.dataset.started) prog.classList.add("indeterminate");
      if (ev.message) $("progressMsg").textContent = `${label}: ${ev.message}`;
    }
    prog.dataset.started = "1";
    $("cancelBtn").hidden = false;
    $("progressMsg").classList.remove("error");
  } else {
    delete prog.dataset.started;
    prog.classList.remove("indeterminate");
  }
  if (ev.state === "done") {
    $("result").hidden = false;
    const video = $("resultVideo");
    const playable = !ev.file.endsWith(".mov");
    video.hidden = !playable;
    if (playable) video.src = ev.url;
    $("resultName").textContent = ev.file + (playable ? "" : " (ProRes can't preview in the browser)");
    $("revealBtn").dataset.file = ev.file;
    toast(`${ev.draft ? "Draft" : "Render"} finished`);
  }
  if (ev.state === "error") {
    $("progressBar").style.width = "0";
    $("progressMsg").textContent = ev.message;
    $("progressMsg").classList.add("error");
    $("cancelBtn").hidden = true;
  }
  if (ev.state === "cancelled") toast("Render cancelled");
}

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------

$("exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ project: state, config: buildConfig() }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${state.fileName || "scroll"}.project.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$("importBtn").addEventListener("click", () => $("importFile").click());
$("importFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const project = data.project ?? data;
    if (!Array.isArray(project.tokens)) throw new Error("Not a Glidecast project");
    state = { ...defaultProject(), ...project };
    save();
    bindSettings();
    renderHidden();
    renderAll();
    toast("Project imported. Press Load page to open it.");
  } catch (err) {
    toast(err.message);
  }
  e.target.value = "";
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function renderAll() {
  renderCheckpoints();
  renderTokens();
  renderScrubber();
  updateStats();
  drawTimeline();
}

bindSettings();
renderHidden();
renderAll();
layoutStage();

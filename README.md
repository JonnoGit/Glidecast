# Glidecast

Headlessly records a webpage scrolling and outputs a video, with real accumulation motion blur and full control over where it stops, how long it holds, and the easing and timing of each move.

## Setup

Requires Node 18+ and `ffmpeg` on PATH.

```bash
npm install
npx playwright install chromium
```

## Mac app

```bash
npm run app        # builds dist/Glidecast.app and installs it to /Applications
```

The app opens the editor in its own window. It starts the server when it launches and stops it when you quit. It runs the project from the folder it was built in, so rebuild it if you move the folder. The server log is at `~/Library/Logs/Glidecast.log`, and File → Open Renders Folder (⌘O) opens `renders/`.

## Quick start

```bash
npm start                                  # editor at http://localhost:4321
node record.js example.json                # CLI render, full quality
node record.js example.json --draft        # no blur, fast timing check
node record.js example.json --out cut2.mov
```

## Editor (web UI)

```bash
node server.js     # then open http://localhost:4321
```

1. Enter a URL and click **Load page**. It opens in a headless Chromium at the width × height you set, the same engine and prep the renderer uses, so positions match exactly.
2. Scroll the preview with your trackpad or wheel, drag the scrubber, or use the arrow keys, PgUp/PgDn, Space, Home, or End. Clicks go through to the page, so you can dismiss popups.
3. Press **M** (or click **Mark checkpoint**) wherever the video should stop. **Set start here** sets the first frame.
4. Each checkpoint has a **hold (ms)** and a **move easing** token. Tokens are reusable `cubic-bezier` + duration (ms) pairs. Edit them with the curve editor, and every checkpoint using a token updates.
5. To zoom, set a checkpoint's **Zoom** above 1× and click **Pick point**, then click the preview where the zoom should happen. That point stays fixed on screen while the view zooms around it. The zoom animates during the move into the checkpoint, with the same easing, and a box on the preview shows what will be in frame. Mark two checkpoints at the same scroll position to zoom without scrolling.
6. The **Timeline** graph shows scroll position over time. Click or drag it to scrub the page. **Preview motion** plays the timing live, with no blur and a rough frame rate.
7. **Draft render** gives a fast render with no blur. **Render video** gives the final render. Output goes to `renders/`, next to the generated config JSON, so you can re-run it from the CLI.

Use **Pick element to hide** and click a cookie banner, chat widget, or popup to remove it from the preview and the render. Popups that appear after a delay may only show up in the render. If one does, add its selector.

## How it works

Rendering is **frame-exact, not real-time**. For every output frame it sets the scroll position at several sub-frame instants inside the shutter window, screenshots each one, and ffmpeg averages them. That produces true motion blur: streaks are long when scrolling fast, get shorter as the scroll eases in, and disappear on holds. Holds cost one screenshot per frame, so only the moving sections are slow to render.

## Config

```jsonc
{
  "url": "https://example.com",
  "output": "scroll.mp4",            // .mp4 (H.264), .mov (ProRes 422 HQ, for After Effects), .webm
  "viewport": { "width": 1920, "height": 1080, "deviceScaleFactor": 1 },  // DPR 2 = 3840x2160 output
  "fps": 60,

  "motionBlur": {
    "enabled": true,
    "shutterAngle": 180,   // 180 = natural film look, 360 = maximum smear, 90 = crisp
    "samples": 64,         // max sub-frames per frame
    "maxStepPx": 1         // sub-frame spacing target; raise to 2–4 to render faster (may show faint stepping)
  },

  "easing": "easeInOutCubic",        // default for scroll steps
  "start": "top",                    // initial position (any target, see below)
  "startZoom": 1,                    // initial zoom (1 = none)
  "startAnchor": [0.5, 0.5],         // zoom anchor, as fractions of the viewport

  "timeline": [
    { "wait": 1.0 },                                                        // hold for 1s
    { "scroll": "#pricing", "duration": 1.2, "easing": [0.7, 0, 0.2, 1] },  // move and stop on an element
    { "wait": 2.0 },
    { "scroll": "+800", "speed": 1500 },                                    // or time it by px/second
    { "scroll": "#demo", "duration": 1.5, "zoom": 2, "anchor": [0.25, 0.4] }, // scroll and zoom together
    { "zoom": 1, "duration": 0.8 },                                         // zoom back out in place
    { "scroll": "bottom", "duration": 3, "easing": "linear" }
  ],

  // Page prep
  "waitUntil": "networkidle",
  "preScroll": true,                 // walk the page first so lazy-loaded content is in place
  "settleMs": 500,
  "hideSelectors": ["#cookie-banner", ".chat-widget"],
  "injectCss": "",
  "freezeAnimations": false,         // pause CSS animations so they don't flicker between sub-frames

  "captureFormat": "png",            // "jpeg" captures faster
  "quality": 16                      // x264 CRF, lower = better
}
```

### Scroll targets

| Target | Meaning |
|---|---|
| `1200` | absolute scrollY in px |
| `"+600"` / `"-300"` | relative to the current position |
| `"40%"` | percentage of the maximum scroll |
| `"top"` / `"bottom"` | page start or end |
| `"#features"` | element's top edge at the top of the viewport |
| `{ "selector": "#features", "offset": -80, "align": "center" }` | `align`: `top`, `center`, or `bottom`; `offset` in px |

### Zoom

A `scroll` step can also take `zoom` (1 = none, 2 = twice as close) and `anchor` (`[x, y]` as 0–1 fractions of the viewport). A step with only `zoom` zooms without scrolling. If a step leaves them out, the current zoom carries over. The anchor is the point that stays fixed on screen while zooming, like CSS `transform-origin`, so `[0, 0]` zooms into the top-left corner and the view never leaves the page. Zoom uses the step's easing and is re-rendered at the zoomed resolution, so text stays sharp, and motion blur covers zoom movement as well as scrolling.

The page doesn't know it's being zoomed, so the recorder tells it two things. Scroll-triggered animations (anything using `IntersectionObserver`, such as Framer Motion's `whileInView` or Rive's play-on-view) fire when an element enters the zoomed shot, not the full viewport. Canvases (Rive, Lottie, three.js) see a higher `devicePixelRatio`, so they draw at the zoomed resolution instead of being upscaled. The ratio is capped by `maxCanvasScale` (default 6). Code that tracks scroll position by hand, such as GSAP ScrollTrigger, still sees the full viewport.

With or without zoom, the outer `triggerInset` px of the frame (default 24, measured on screen) don't count as "in view". An element peeking a few pixels in at the edge won't start its animation (Rive starts on a single visible pixel) and then get paused and resumed partway through later.

### Easing

- **Presets:** `linear`, `easeIn/Out/InOut` + `Sine` `Quad` `Cubic` `Quart` `Quint` `Expo` (e.g. `easeOutQuint`)
- **CSS keywords:** `ease`, `ease-in`, `ease-out`, `ease-in-out`
- **Cubic bézier:** `[x1, y1, x2, y2]` or `"cubic-bezier(.7,0,.2,1)"`. This is the same as CSS, so you can copy curves from cubic-bezier.com or from AE/Figma graph values.
- **Spring:** `{ "spring": { "stiffness": 120, "damping": 14, "mass": 1 } }`. Lower damping gives overshoot and settle, and the step's `duration` should be long enough for the spring to come to rest.

## Tips

- Use `--draft` to iterate on timing, then do the full render once.
- Sites with smooth-scroll libraries (Lenis, Locomotive) hijack `window.scrollTo`. Disable them with `injectCss` or pick a page without one.
- **Animation timing:** rendering uses a virtual clock (`virtualTime`, on by default). The page's `requestAnimationFrame`, `performance.now`, `Date`, timers, CSS animations and `<video>` all advance exactly 1/fps per frame, so Rive, Lottie, GSAP and Framer Motion play at real speed however slow capture is. Set `freezeAnimations: true` to stop CSS animations instead.
- **Loading:** downloads finish on the real clock, not the page's clock. So before each frame, the recorder waits up to `waitForLoads` ms (default 3000) for pending requests, such as a Rive file or lazy image, without advancing the page. Loads take no video time, so animations start on the same frame every render. Set it to `0` to turn this off.
- **Intro animations:** with `freshStart` (on by default; "Capture intro animations" in the editor), the recorder loads and pre-scrolls the page once to measure it and cache lazy content, then reloads with the clock frozen from the first script. Load-in animations then play from frame 0, and scroll-triggered animations play when the video reaches them instead of during the pre-scroll.
- **GPU:** renders use hardware WebGL (`gpu: true`). Headless Chromium's default software WebGL was about 200× slower on Rive-heavy pages. Set `gpu: false` if a page renders wrong.
- **Cookie banners:** common consent tools (OneTrust, Cookiebot, TrustArc, Usercentrics…) are hidden automatically (`hideCookieBanners`). When rendering from the editor, your preview session's cookies are also passed to the render, so clicking "Reject All" in the preview carries over.
- Render time scales with how much motion there is × `1 / maxStepPx`. The 10-second example takes a few minutes on an M-series Mac.

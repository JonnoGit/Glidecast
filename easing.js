// Easing functions: t in [0,1] -> progress (usually [0,1], springs may overshoot).
//
// An easing spec can be:
//   "easeInOutCubic"            named preset (see PRESETS)
//   "ease-in-out"               CSS keyword
//   [0.65, 0, 0.35, 1]          cubic-bezier(x1, y1, x2, y2), same as CSS
//   { "spring": { "stiffness": 120, "damping": 14, "mass": 1 } }

const PRESETS = {
  linear: (t) => t,

  easeInSine: (t) => 1 - Math.cos((t * Math.PI) / 2),
  easeOutSine: (t) => Math.sin((t * Math.PI) / 2),
  easeInOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,

  easeInQuad: (t) => t * t,
  easeOutQuad: (t) => 1 - (1 - t) ** 2,
  easeInOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),

  easeInCubic: (t) => t ** 3,
  easeOutCubic: (t) => 1 - (1 - t) ** 3,
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),

  easeInQuart: (t) => t ** 4,
  easeOutQuart: (t) => 1 - (1 - t) ** 4,
  easeInOutQuart: (t) => (t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2),

  easeInQuint: (t) => t ** 5,
  easeOutQuint: (t) => 1 - (1 - t) ** 5,
  easeInOutQuint: (t) => (t < 0.5 ? 16 * t ** 5 : 1 - (-2 * t + 2) ** 5 / 2),

  easeInExpo: (t) => (t === 0 ? 0 : 2 ** (10 * t - 10)),
  easeOutExpo: (t) => (t === 1 ? 1 : 1 - 2 ** (-10 * t)),
  easeInOutExpo: (t) =>
    t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2,
};

const CSS_KEYWORDS = {
  ease: [0.25, 0.1, 0.25, 1],
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
};

export function cubicBezier(x1, y1, x2, y2) {
  const bx = (t) => 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t * t * (1 - t) + t ** 3;
  const by = (t) => 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t * t * (1 - t) + t ** 3;
  const dbx = (t) => 3 * x1 * (1 - t) ** 2 + 6 * (x2 - x1) * t * (1 - t) + 3 * (1 - x2) * t * t;

  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // Newton-Raphson, falling back to bisection.
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = bx(t) - x;
      if (Math.abs(err) < 1e-7) return by(t);
      const d = dbx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 60; i++) {
      const v = bx(t);
      if (Math.abs(v - x) < 1e-7) break;
      if (v < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return by(t);
  };
}

// Damped spring from 0 -> 1. `durationSec` maps normalized t onto real time so the
// spring's physical feel is independent of how the step is timed; the last frame snaps to 1.
export function spring({ stiffness = 120, damping = 14, mass = 1, velocity = 0 } = {}, durationSec = 1) {
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  return (t) => {
    if (t >= 1) return 1;
    const s = t * durationSec;
    let x;
    if (zeta < 1) {
      const wd = w0 * Math.sqrt(1 - zeta * zeta);
      x = Math.exp(-zeta * w0 * s) * (Math.cos(wd * s) + ((zeta * w0 - velocity) / wd) * Math.sin(wd * s));
    } else {
      x = Math.exp(-w0 * s) * (1 + (w0 - velocity) * s);
    }
    return 1 - x;
  };
}

export function resolveEasing(spec, durationSec) {
  if (spec == null) return PRESETS.easeInOutCubic;
  if (typeof spec === "function") return spec;
  if (Array.isArray(spec) && spec.length === 4) return cubicBezier(...spec);
  if (typeof spec === "string") {
    if (PRESETS[spec]) return PRESETS[spec];
    if (CSS_KEYWORDS[spec]) return cubicBezier(...CSS_KEYWORDS[spec]);
    const m = spec.match(/^cubic-bezier\(([^)]+)\)$/);
    if (m) return cubicBezier(...m[1].split(",").map(Number));
  }
  if (typeof spec === "object" && spec.spring) return spring(spec.spring, durationSec);
  throw new Error(`Unknown easing: ${JSON.stringify(spec)}. Presets: ${Object.keys(PRESETS).join(", ")}`);
}

export const EASING_NAMES = [...Object.keys(PRESETS), ...Object.keys(CSS_KEYWORDS)];

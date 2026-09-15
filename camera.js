// Zoom camera, shared by the recorder and the editor.
//
// A camera state is { zoom, anchor: [x, y] }. zoom 1 shows the whole viewport. The anchor is a
// point on the viewport as fractions (0–1), and it stays put on screen while zooming, like CSS
// transform-origin. So the zoomed view never leaves the page: [0, 0] zooms into the top-left corner.

export const DEFAULT_CAMERA = { zoom: 1, anchor: [0.5, 0.5] };

const clamp01 = (v) => Math.max(0, Math.min(1, v));

export function normCamera(zoom, anchor) {
  const [x = 0.5, y = 0.5] = Array.isArray(anchor) ? anchor : [anchor?.x, anchor?.y];
  return { zoom: Math.max(1, Number(zoom) || 1), anchor: [clamp01(Number(x)), clamp01(Number(y))] };
}

// Camera between a and b at eased progress p (may overshoot for springs).
export function lerpCamera(a, b, p) {
  // Zoom is interpolated in log space so zooming feels even. The anchor has no effect at 1×, so
  // zooming in from (or out to) 1× uses the zoomed side's anchor instead of sliding between them.
  const zoom = Math.max(1, Math.exp(Math.log(a.zoom) + (Math.log(b.zoom) - Math.log(a.zoom)) * p));
  const from = a.zoom <= 1 ? b.anchor : a.anchor;
  const to = b.zoom <= 1 ? a.anchor : b.anchor;
  return { zoom, anchor: [clamp01(from[0] + (to[0] - from[0]) * p), clamp01(from[1] + (to[1] - from[1]) * p)] };
}

// The visible part of the viewport, in viewport CSS px.
export function cameraRect({ zoom, anchor }, width, height) {
  const w = width / zoom;
  const h = height / zoom;
  return { x: anchor[0] * (width - w), y: anchor[1] * (height - h), width: w, height: h };
}

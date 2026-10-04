// Client-only canvas helpers for the signature pad. Everything here runs in the
// browser on a <canvas>/<Image> — NO network, no upload. A signature is a fill
// value and must never leave the device (zero-retention invariant); these
// helpers only ever read a local File/canvas and emit a data-URL string that the
// fill store carries and stampPdf embeds.
//
// Stage 1 exposes decode + downscale-to-transparent-PNG. Stage 2 adds the upload
// processing pipeline (auto-trim + background knockout) on top of these.

import { boxMean, toGray } from "./imageOps";

// Longest-edge cap applied before a signature PNG is written into fill state /
// device storage. Keeps the data-URL string (and the base64 inflation) small so
// the string-map carrier stays cheap — see the handoff's downscale rationale.
export const SIGNATURE_MAX_EDGE = 1000;

// Pure: the target pixel size that fits (w, h) within maxEdge on the long edge,
// preserving aspect ratio. Returns null when no downscale is needed (already
// within the cap, or degenerate). Split out so it's unit-testable without a DOM.
export function downscaleDims(
  w: number,
  h: number,
  maxEdge = SIGNATURE_MAX_EDGE,
): { w: number; h: number } | null {
  const longEdge = Math.max(w, h);
  if (longEdge <= maxEdge || longEdge === 0) return null;
  const scale = maxEdge / longEdge;
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

// Pure: decode a `data:image/...;base64,...` URL to raw bytes (for pdf-lib
// embedding). Client-safe (`atob` exists in browsers and Node). Returns null for
// a non-base64 / malformed data-URL.
export function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0 || !/;base64/i.test(dataUrl.slice(0, comma))) return null;
  const bin = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Pure: knock a photographed/scanned signature's light background out to
// transparent, in-place, on RGBA pixel data. Alpha ramps from 0 (background,
// luminance >= threshold) to 255 (ink, luminance <= floor) so stroke edges stay
// anti-aliased instead of jagged; surviving ink is darkened (contrast bump) so a
// faint pencil line still reads. Tolerant by design — the caller offers an undo.
export function knockoutBackground(data: Uint8ClampedArray, threshold = 210, floor = 120): void {
  const span = Math.max(1, threshold - floor);
  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    let alpha: number;
    if (lum >= threshold) alpha = 0;
    else if (lum <= floor) alpha = 255;
    else alpha = Math.round((1 - (lum - floor) / span) * 255);
    // Deepen the surviving ink toward black for a crisp stamp (keeps hue).
    data[i] = data[i] * 0.6;
    data[i + 1] = data[i + 1] * 0.6;
    data[i + 2] = data[i + 2] * 0.6;
    data[i + 3] = alpha;
  }
}

// Pure: knock a photographed/scanned signature's background out to transparent
// using a LOCAL (adaptive) threshold, in-place on RGBA pixel data. Unlike the
// global `knockoutBackground`, each pixel is compared to its own local background
// (a large-radius box mean of the luminance), so uneven lighting / shadow
// gradients — where a global threshold either keeps the shadow as fake "ink" or
// eats faint strokes — are removed cleanly. Alpha ramps from 0 (as bright as the
// local background, delta <= loMargin) to 255 (delta >= hiMargin, clearly darker
// = ink), anti-aliasing edges; surviving ink is darkened (×0.6) for a crisp stamp.
// Run this on the CROPPED region (small, uniform) — fast enough for the main
// thread at signature resolutions.
export function adaptiveKnockout(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  loMargin = 12,
  hiMargin = 45,
): void {
  if (width === 0 || height === 0) return;
  const gray = toGray(data, width, height);
  // Radius large enough to track a broad shadow gradient as "background" while a
  // thin ink stroke still reads far darker than its local mean.
  const radius = Math.max(8, Math.round(Math.max(width, height) / 40));
  const bg = boxMean(gray, width, height, radius);
  const span = Math.max(1, hiMargin - loMargin);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const delta = bg[i] - gray[i]; // how much darker than local background
    let alpha: number;
    if (delta <= loMargin) alpha = 0;
    else if (delta >= hiMargin) alpha = 255;
    else alpha = Math.round(((delta - loMargin) / span) * 255);
    data[p] = data[p] * 0.6;
    data[p + 1] = data[p + 1] * 0.6;
    data[p + 2] = data[p + 2] * 0.6;
    data[p + 3] = alpha;
  }
}

// Pure: the bounding box of the non-transparent (alpha > alphaMin) pixels in RGBA
// data, or null if the image is fully transparent. Used to auto-trim whitespace
// margins after knockout so the signature fills its box.
export function contentBounds(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  alphaMin = 8,
): { x: number; y: number; w: number; h: number } | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > alphaMin) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// Upload processing (DOM): adaptive background knockout on a canvas, returning a
// NEW transparent canvas of the SAME size. Non-mutating — the source is preserved
// so the caller can re-render with knockout toggled off. Framing/aspect is the
// caller's job (the crop tool); we deliberately do NOT trim to the ink here, or
// the user's aspect-locked crop would be undone. All in-canvas, no network.
export function knockoutCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const w = source.width;
  const h = source.height;
  const sctx = source.getContext("2d");
  if (!sctx || w === 0 || h === 0) return source;

  const img = sctx.getImageData(0, 0, w, h);
  adaptiveKnockout(img.data, w, h);

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const octx = out.getContext("2d");
  if (!octx) return source;
  octx.putImageData(img, 0, 0);
  return out;
}

// Detect the ink bounding box (in SOURCE px) of a photographed signature: run the
// adaptive knockout on a downscaled copy (sampleEdge cap — cheap + one-time) and
// find the opaque bounds. Used to auto-place the initial crop rect. Returns null
// when no ink survives. All in-canvas, no network.
export function detectInkBounds(
  source: HTMLCanvasElement,
  sampleEdge = 512,
): { x: number; y: number; w: number; h: number } | null {
  const w = source.width;
  const h = source.height;
  if (w === 0 || h === 0) return null;
  const scale = Math.min(1, sampleEdge / Math.max(w, h));
  const sw = Math.max(1, Math.round(w * scale));
  const sh = Math.max(1, Math.round(h * scale));
  const tmp = document.createElement("canvas");
  tmp.width = sw;
  tmp.height = sh;
  const ctx = tmp.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, sw, sh);
  const img = ctx.getImageData(0, 0, sw, sh);
  adaptiveKnockout(img.data, sw, sh);
  const b = contentBounds(img.data, sw, sh);
  if (!b) return null;
  const inv = 1 / scale;
  return { x: b.x * inv, y: b.y * inv, w: b.w * inv, h: b.h * inv };
}

// Export a canvas as a transparent PNG data-URL, downscaled so its longest edge
// is <= maxEdge. The source canvas must already be transparent where it should be
// (we never fill a background).
export function canvasToDownscaledPng(
  source: HTMLCanvasElement,
  maxEdge = SIGNATURE_MAX_EDGE,
): string {
  const dims = downscaleDims(source.width, source.height, maxEdge);
  if (!dims) return source.toDataURL("image/png");
  const out = document.createElement("canvas");
  out.width = dims.w;
  out.height = dims.h;
  const ctx = out.getContext("2d");
  if (!ctx) return source.toDataURL("image/png");
  ctx.drawImage(source, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

// Crop a rectangular region (in SOURCE pixels) of a canvas into a new canvas.
// The rect is clamped to the source bounds. All in-canvas, no network.
export function cropCanvas(
  src: HTMLCanvasElement,
  rect: { x: number; y: number; w: number; h: number },
): HTMLCanvasElement {
  const x = Math.min(Math.max(0, Math.round(rect.x)), Math.max(0, src.width - 1));
  const y = Math.min(Math.max(0, Math.round(rect.y)), Math.max(0, src.height - 1));
  const w = Math.max(1, Math.min(src.width - x, Math.round(rect.w)));
  const h = Math.max(1, Math.min(src.height - y, Math.round(rect.h)));
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d");
  if (!ctx) return src;
  ctx.drawImage(src, x, y, w, h, 0, 0, w, h);
  return out;
}

// Decode a local image File into a fresh canvas at its natural pixel size. Uses
// an object URL (local blob, no network) that is revoked once decoded. Rejects if
// the bytes aren't a decodable image.
export async function loadImageToCanvas(file: File): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => {
        resolve(el);
      };
      el.onerror = () => {
        reject(new Error("Could not decode the image."));
      };
      el.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable.");
    ctx.drawImage(img, 0, 0);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

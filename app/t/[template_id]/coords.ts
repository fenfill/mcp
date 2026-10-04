// Geometry helpers shared by the form editor.
//
// The v2 schema stores field boxes directly as PERCENT of the page image with a
// TOP-LEFT origin (xpct/ypct/wpct/hpct) — the same space the preview overlay and
// the drag/resize code already use, so no coordinate conversion is needed here.
// Conversion to actual PDF points happens only at stamp time (see FillForm).

import type { Field } from "@/types";

// A box expressed as percentages of the page, top-left origin (CSS space).
export interface Pct {
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
}

// Middle element of a sorted copy (upper-median for even counts); 0 when empty.
// Shared by the grouping/table heuristics, which all want the same definition.
export const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

// A field's stored percent box -> the editor/overlay Pct shape.
export const fieldPct = (f: Field): Pct => ({
  xPct: f.xpct,
  yPct: f.ypct,
  wPct: f.wpct,
  hPct: f.hpct,
});

// The editor Pct -> the field's stored percent box fields.
export const pctToFieldBox = (b: Pct): Pick<Field, "xpct" | "ypct" | "wpct" | "hpct"> => ({
  xpct: b.xPct,
  ypct: b.yPct,
  wpct: b.wPct,
  hpct: b.hPct,
});

// ---- Pixel <-> percent (smart editor) -------------------------------------
// The smart-snap floodfill works in IMAGE-PIXEL space (the natural resolution
// of the page preview PNG). These helpers bridge that space and the percent
// space the rest of the editor uses. Both are top-left origin.

// A rectangle in image-pixel space (top-left origin).
export interface PxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Image-pixel rect -> percent box.
export const pxRectToPct = (r: PxRect, imgW: number, imgH: number): Pct => ({
  xPct: (r.x / imgW) * 100,
  yPct: (r.y / imgH) * 100,
  wPct: (r.w / imgW) * 100,
  hPct: (r.h / imgH) * 100,
});

// Percent box -> image-pixel rect (rounded to whole pixels).
export const pctToPxRect = (b: Pct, imgW: number, imgH: number): PxRect => ({
  x: Math.round((b.xPct / 100) * imgW),
  y: Math.round((b.yPct / 100) * imgH),
  w: Math.round((b.wPct / 100) * imgW),
  h: Math.round((b.hPct / 100) * imgH),
});

// Bounding box (percent) over a list of percent boxes.
export const pctBBox = (boxes: Pct[]): Pct => {
  const x0 = Math.min(...boxes.map((b) => b.xPct));
  const y0 = Math.min(...boxes.map((b) => b.yPct));
  const x1 = Math.max(...boxes.map((b) => b.xPct + b.wPct));
  const y1 = Math.max(...boxes.map((b) => b.yPct + b.hPct));
  return { xPct: x0, yPct: y0, wPct: x1 - x0, hPct: y1 - y0 };
};

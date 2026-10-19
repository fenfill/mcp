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

// ---- Visible page frame: /Rotate + CropBox (stamp time) ----------------------
// Percent boxes are measured on the page AS SHOWN: the CropBox (clipped to the
// MediaBox) turned by the page's /Rotate. That is what the server raster (fitz
// get_pixmap, TOP-LEFT origin), pdf.js getViewport (quickfill) and the wand on
// either preview see. pdf-lib draws in the page's USER SPACE instead: BOTTOM-LEFT
// origin, unrotated, MediaBox coordinates. The stamp therefore draws in a
// "visible frame" (BOTTOM-LEFT origin, y up, points, `width` x `height` of the
// shown page) and installs `matrix` (visible -> user space) once per page, so
// every value, mark, image and footer lands where it was drawn and reads upright.

/** A rectangle in PDF USER SPACE (pdf-lib / pdf.js: BOTTOM-LEFT origin, y up, points). */
export interface PdfBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rectangle in the VISIBLE frame (BOTTOM-LEFT origin, y up, points). */
export interface PtRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A PDF affine matrix [a b c d e f]: (x, y) -> (a·x + c·y + e, b·x + d·y + f). */
export type PdfMatrix = [number, number, number, number, number, number];

export interface PageFrame {
  /** The shown page, in points (after /Rotate: a /Rotate 90 portrait page is landscape). */
  width: number;
  height: number;
  /** /Rotate normalized to 0/90/180/270 (clockwise, as a viewer turns the page). */
  rotate: 0 | 90 | 180 | 270;
  /** Visible frame (BOTTOM-LEFT, y up) -> user space (BOTTOM-LEFT, unrotated). */
  matrix: PdfMatrix;
  /** True when `matrix` is the identity (unrotated page, box starting at 0,0). */
  identity: boolean;
}

const normBox = (b: PdfBox) => {
  const x0 = Math.min(b.x, b.x + b.width);
  const y0 = Math.min(b.y, b.y + b.height);
  return { x0, y0, x1: x0 + Math.abs(b.width), y1: y0 + Math.abs(b.height) };
};

/** /Rotate (any multiple of 90, negative or > 360 included) -> 0/90/180/270. */
export const normRotate = (deg: number): PageFrame["rotate"] =>
  ((((Math.round(deg / 90) * 90) % 360) + 360) % 360) as PageFrame["rotate"];

/**
 * The visible frame of a page from its USER-SPACE MediaBox and CropBox (pass the
 * MediaBox again when the page has no CropBox) and its /Rotate. The shown area is
 * CropBox ∩ MediaBox, as pdf.js `page.view` and fitz `page.rect` take it.
 */
export function pageFrame(media: PdfBox, crop: PdfBox, rotateDeg: number): PageFrame {
  const m = normBox(media);
  const c = normBox(crop);
  let x0 = Math.max(m.x0, c.x0);
  let y0 = Math.max(m.y0, c.y0);
  let x1 = Math.min(m.x1, c.x1);
  let y1 = Math.min(m.y1, c.y1);
  // A CropBox outside the MediaBox: viewers fall back to the MediaBox.
  if (!(x1 > x0 && y1 > y0)) ({ x0, y0, x1, y1 } = m);
  const cw = x1 - x0;
  const ch = y1 - y0;
  const rotate = normRotate(rotateDeg);
  // Visible (u, v), BOTTOM-LEFT origin -> user (x, y), BOTTOM-LEFT origin. The
  // viewer turns the page clockwise by `rotate`:
  //   0:   x = x0 + u,       y = y0 + v
  //   90:  x = x1 - v,       y = y0 + u   (user +y reads to the right)
  //   180: x = x1 - u,       y = y1 - v
  //   270: x = x0 + v,       y = y1 - u   (user +x reads upward)
  const matrix: PdfMatrix =
    rotate === 90
      ? [0, 1, -1, 0, x1, y0]
      : rotate === 180
        ? [-1, 0, 0, -1, x1, y1]
        : rotate === 270
          ? [0, -1, 1, 0, x0, y1]
          : [1, 0, 0, 1, x0, y0];
  const sideways = rotate === 90 || rotate === 270;
  return {
    width: sideways ? ch : cw,
    height: sideways ? cw : ch,
    rotate,
    matrix,
    identity: rotate === 0 && x0 === 0 && y0 === 0,
  };
}

/** Percent box (visible page, TOP-LEFT origin) -> visible-frame points (BOTTOM-LEFT origin). */
export const pctToFrameRect = (f: Pick<PageFrame, "width" | "height">, b: Pct): PtRect => {
  const w = (b.wPct / 100) * f.width;
  const h = (b.hPct / 100) * f.height;
  return { x: (b.xPct / 100) * f.width, y: f.height - (b.yPct / 100) * f.height - h, w, h };
};

/** A visible-frame point (BOTTOM-LEFT) -> user space (BOTTOM-LEFT, unrotated). */
export const frameToUser = (f: PageFrame, x: number, y: number): { x: number; y: number } => {
  const [a, b, c, d, e, g] = f.matrix;
  return { x: a * x + c * y + e, y: b * x + d * y + g };
};

/** A user-space rect (BOTTOM-LEFT, unrotated; e.g. PDFium text boxes) -> the visible frame. */
export const userRectToFrame = (f: PageFrame, r: PtRect): PtRect => {
  const [a, b, c, d, e, g] = f.matrix;
  // The matrix is a rotation by a multiple of 90 plus a shift: its inverse is its
  // transpose, applied after undoing the shift.
  const inv = (x: number, y: number) => ({
    x: a * (x - e) + b * (y - g),
    y: c * (x - e) + d * (y - g),
  });
  const p = inv(r.x, r.y);
  const q = inv(r.x + r.w, r.y + r.h);
  const x = Math.min(p.x, q.x);
  const y = Math.min(p.y, q.y);
  return { x, y, w: Math.abs(q.x - p.x), h: Math.abs(q.y - p.y) };
};

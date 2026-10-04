// Pure text-fitting helpers shared by every render path (the exported PDF in
// stampPdf.ts, the read-only EDIT/Story stamps in PageStamps.tsx, and the live
// FILL inputs in PageControls.tsx). Keeping the math here is what stops the three
// paths from drifting.
//
// The model for a SINGLE-LINE text value: start at a fixed point size (the field's
// font_size, else DEFAULT_FONT_SIZE) — NEVER scaled up to the box height — and
// shrink it horizontally to fit the box width, down to MIN_FONT_SIZE. Then place
// the (possibly shrunk) text at one of 9 anchor points inside the box.

import {
  DEFAULT_FONT_SIZE,
  type Field,
  MIN_FONT_SIZE,
  type PageInfo,
  type TextAnchor,
  textMultilineOf,
} from "@/types";

export { DEFAULT_FONT_SIZE, MIN_FONT_SIZE };

// Inset (in PDF points) kept between the text and every edge of its box — used
// BOTH to narrow the shrink-to-fit width and to place the anchored line/inputs.
// Shared by all three render paths (stampPdf export, PageStamps read-only, and
// the live PageControls inputs) so on-screen filling matches the exported PDF.
export const TEXT_PAD_PT = 4;

// Cap on how much of a box dimension the per-side inset may consume. A fixed
// TEXT_PAD_PT (4pt) is negligible on a tall multiline box, but on a short table
// cell (~20pt) an 8pt top+bottom inset devours ~40% of the height, so even two
// wrapped lines at the multiline floor can't fit the ~12pt that remains and
// get clipped. Capping the inset at this fraction PER SIDE keeps small cells
// usable while leaving normal boxes at the full 4pt.
export const PAD_MAX_FRACTION = 0.18;

// The effective per-side inset for a box that is `boxDimPt` points along one axis:
// TEXT_PAD_PT, but never more than PAD_MAX_FRACTION of the box on that axis. Apply
// PER AXIS (width for the horizontal inset, height for the vertical) so a short but
// wide table cell keeps its full horizontal inset while its vertical inset shrinks.
// Multiline-only: single-line placement keeps the fixed TEXT_PAD_PT.
export function multilinePadPt(boxDimPt: number): number {
  return Math.min(TEXT_PAD_PT, Math.max(0, boxDimPt) * PAD_MAX_FRACTION);
}

// The constant DPI at which the backend rasterizes page previews
// (pipeline_geom.RENDER_DPI). Because the raster scale is uniform (no max-pixel
// cap), page_point_height = PageInfo.height * 72 / PREVIEW_DPI, which lets the
// on-screen paths convert an absolute point size to `cqh` without the true PDF
// point dimensions. Mirror of the Python constant — keep them in lockstep.
export const PREVIEW_DPI = 200;

// Font stack used to BOTH render and measure on-screen stamp text, so the
// auto-shrink decision matches what the user sees — AND matches the exported PDF.
// `InterStamp`/`DejaVuStamp` are @font-face'd (globals.css) from the very `.ttf`
// files stampPdf.ts embeds, so preview == print. The two-font stack mirrors the
// PDF's per-glyph Inter→DejaVu fallback (Inter primary; DejaVu covers the broad
// Unicode / RTL glyphs Inter lacks). See ensureStampFontsLoaded() below — the
// offscreen measuring canvas needs the faces loaded before it can measure them.
export const STAMP_FONT_FAMILY = '"InterStamp", "DejaVuStamp", sans-serif';

// Kick off loading the stamp faces so `measureCanvas` (an offscreen canvas, which
// does NOT itself trigger @font-face fetches) measures the real Inter/DejaVu
// metrics rather than a system fallback. Idempotent; safe to call on every
// editor/fill mount. Resolves when both faces are ready (or immediately in SSR /
// browsers without the Font Loading API). Callers can await it to re-measure and
// clear any first-paint shrink jitter.
let _stampFontsPromise: Promise<void> | null = null;
export function ensureStampFontsLoaded(): Promise<void> {
  if (_stampFontsPromise) return _stampFontsPromise;
  // The DOM lib types `document.fonts` (Font Loading API) as always present, but
  // it is genuinely absent in older browsers — cast to the honest optional so the
  // capability guard survives. The `typeof document` check MUST stay first so the
  // `.fonts` access is short-circuited (never reached) under SSR.
  if (typeof document === "undefined" || !(document.fonts as FontFaceSet | undefined)?.load) {
    _stampFontsPromise = Promise.resolve();
    return _stampFontsPromise;
  }
  _stampFontsPromise = Promise.all([
    document.fonts.load('16px "InterStamp"'),
    document.fonts.load('16px "DejaVuStamp"'),
  ])
    .then(() => undefined)
    .catch(() => undefined);
  return _stampFontsPromise;
}

// Text width at a font size, in some consistent unit. pdf-lib's
// `font.widthOfTextAtSize` (points) and a canvas 2d `measureText` (pixels) both
// satisfy this — fitFontSize only needs the measurement and `availWidth` to share
// a unit, since the shrink ratio is unitless.
export type MeasureText = (text: string, size: number) => number;

// Shrink `startSize` just enough that `text` fits within `availWidth`, never below
// MIN_FONT_SIZE, never above `startSize`. Text width is linear in font size for a
// given font, so a single proportional step is exact (no iteration needed).
export function fitFontSize(
  text: string,
  availWidth: number,
  startSize: number,
  measure: MeasureText,
): number {
  if (!text || availWidth <= 0) return startSize;
  const tw = measure(text, startSize);
  if (tw <= availWidth || tw <= 0) return startSize;
  return Math.max(MIN_FONT_SIZE, (startSize * availWidth) / tw);
}

// ─── Auto (box-proportional) start size ─────────────────────────────────────────

// Fraction of the FULL box height a single line occupies when a text/date field is
// left on Auto. The remaining (1 − FILL) is the breathing room above+below — a
// PROPORTIONAL padding that naturally shrinks on a short box rather than a fixed
// inset that devours it. ~0.72 keeps a comfortable gap on a normal box (e.g. a 16pt
// field → ~11.5pt text) while staying legible. Tune here to change Auto's size.
export const AUTO_HEIGHT_FILL = 0.72;

// Auto size for a CHECKBOX mark. The preset vector marks (✓ ✗ ■) carry their own
// inner inset, so a mark box sized exactly to the field box leaves a visible gap.
// We scale the mark box to this multiple of the field box so the mark reaches (and
// a touch past) the edges — centered, may slightly overflow, which is fine now that
// checkbox marks aren't clipped. Calibrated against small Polish-tax checkboxes: a
// ~6-7pt box reads perfectly at ~8pt (≈ box × 1.2). One knob — tune here.
export const CHECKBOX_AUTO_FILL = 1.2;

// Readability floor for Auto: form boxes are often short (~16pt), and below this
// size text is hard to read. When the proportional fit would fall under it we clamp
// UP to it — trading padding for legibility (the text eats into the breathing room,
// per the "prefer readability over padding on tight boxes" rule). Higher than the
// hard MIN_FONT_SIZE (6), which only the width shrink-to-fit may still reach.
export const AUTO_MIN_FONT_SIZE = 8;

// Auto start size (PDF points) for a SINGLE-LINE text/date field left on Auto:
// AUTO_HEIGHT_FILL of the box HEIGHT, so short boxes get proportionately smaller
// text with proportional padding — never the flat DEFAULT_FONT_SIZE. Clamped to
// [AUTO_MIN_FONT_SIZE, DEFAULT_FONT_SIZE]: capped so Auto is never larger than the
// historical baseline, floored at the readability minimum (padding yields before
// legibility does). The horizontal shrink-to-fit (fitFontSize) still applies on top.
// Shared by every render path (live FILL, EDIT stamp, exported PDF) so on-screen
// filling matches the exported PDF.
export function autoTextStartPt(boxHeightPt: number): number {
  const byHeight = boxHeightPt * AUTO_HEIGHT_FILL;
  return Math.min(DEFAULT_FONT_SIZE, Math.max(AUTO_MIN_FONT_SIZE, byHeight));
}

// The rounded Auto start size the renderer will use for `field`, resolved against
// the document's `pages` — so the SizeField "auto (n)" hint matches what actually
// gets stamped. Converts the box's height-percent to points via the page raster
// height (PageInfo.height is a PREVIEW_DPI raster; see ptToCqh). Handles:
//   • single-line text/date — the height-based autoTextStartPt; and
//   • checkbox — the mark's box-fit size (min(box) × CHECKBOX_AUTO_FILL), matching
//     the auto branch every render path uses for a mark left on Auto.
// Returns null when:
//   • the field's Auto has no single resolved size (multiline text auto-fits
//     vertically; signature fits the box as an image) — no single "n" to show; or
//   • the page is missing or has no dimensions (e.g. before a ghost page gets real
//     dims — for a checkbox we also need the width).
// Display-only (rounded): the render paths use the unrounded start sizes.
export function autoStartForField(
  field: Pick<Field, "type" | "format" | "page" | "hpct" | "wpct">,
  pages: readonly PageInfo[],
): number | null {
  const heightBased = field.type === "date" || (field.type === "text" && !textMultilineOf(field));
  const isCheckbox = field.type === "checkbox";
  if (!heightBased && !isCheckbox) return null;
  const pg = pages.find((p) => p.page === field.page);
  if (!pg || pg.height <= 0) return null;
  const pageHeightPt = (pg.height * 72) / PREVIEW_DPI;
  const boxHeightPt = (field.hpct / 100) * pageHeightPt;
  if (isCheckbox) {
    if (pg.width <= 0) return null;
    const pageWidthPt = (pg.width * 72) / PREVIEW_DPI;
    const boxWidthPt = (field.wpct / 100) * pageWidthPt;
    return Math.round(Math.min(boxHeightPt, boxWidthPt) * CHECKBOX_AUTO_FILL);
  }
  return Math.round(autoTextStartPt(boxHeightPt));
}

// ─── Multi-line wrapping + vertical auto-shrink ─────────────────────────────────

// Line advance as a multiple of the font size (baseline-to-baseline). ~1.2 is the
// conventional single-spacing leading; shared so the wrap-fit math, the exported
// PDF, and the on-screen preview all stack lines identically.
export const LINE_HEIGHT_FACTOR = 1.2;

// Floor for the multi-line vertical auto-shrink. Long-form paragraphs are shrunk
// aggressively to fit the whole value into the box, but never below this size —
// below it, text overflows (clips) rather than becoming illegible. Kept low (5pt,
// under the single-line MIN_FONT_SIZE of 6) so short table cells fit two wrapped
// lines before clipping. Shared by every multiline render path.
export const MULTILINE_MIN_FONT_SIZE = 5;

// Greedy word-wrap `text` to `availWidth` at font `size`. Splits on existing
// newlines first (preserving blank lines from "\n\n"), then packs words per line,
// breaking when the next word would overflow. A single word wider than the box is
// left to overflow on its own line (no mid-word break) — acceptable for form input.
export function wrapLines(
  text: string,
  availWidth: number,
  size: number,
  measure: MeasureText,
): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (para === "" || availWidth <= 0) {
      out.push(para);
      continue;
    }
    let line = "";
    for (const word of para.split(" ")) {
      const trial = line === "" ? word : `${line} ${word}`;
      if (line !== "" && measure(trial, size) > availWidth) {
        out.push(line);
        line = word;
      } else {
        line = trial;
      }
    }
    out.push(line);
  }
  return out;
}

// The multi-line counterpart to fitFontSize: wrap `text` to `availWidth` and, while
// the wrapped block is taller than `availHeight`, shrink the font a point at a time
// and RE-WRAP (a smaller font fits more words per line, so the line count changes) —
// down to `minSize`. Returns the chosen size and the final wrapped lines. Callers
// pass MULTILINE_MIN_FONT_SIZE (5pt) as the floor so paragraphs fit aggressively but
// stay readable.
export function fitWrapped(
  text: string,
  availWidth: number,
  availHeight: number,
  startSize: number,
  measure: MeasureText,
  minSize: number = MIN_FONT_SIZE,
): { size: number; lines: string[] } {
  let size = Math.max(startSize, minSize);
  for (;;) {
    const lines = wrapLines(text, availWidth, size, measure);
    const totalHeight = lines.length * size * LINE_HEIGHT_FACTOR;
    if (totalHeight <= availHeight || size <= minSize) return { size, lines };
    size = Math.max(minSize, size - 1);
  }
}

// Convert an absolute point size to on-screen `cqh` (percent of the query
// container's height). `1cqh` resolves against PageLayer's `containerType: size`
// div, whose height is the full rendered page. See PREVIEW_DPI.
export function ptToCqh(pt: number, pageHeightPx: number): number {
  if (pageHeightPx <= 0) return 0;
  return ((100 * PREVIEW_DPI) / 72) * (pt / pageHeightPx);
}

// Convert an absolute point size to preview-native pixels (for canvas measuring in
// the same space as a box width taken from PageInfo.width).
export function ptToPreviewPx(pt: number): number {
  return (pt * PREVIEW_DPI) / 72;
}

// Inverse of ptToPreviewPx: preview-native pixels back to PDF points. Used by the
// on-screen multiline paths to express the box HEIGHT in points, because
// fitWrapped's vertical math is in points (line height = size × factor) — mixing a
// px height with a point size silently defeats the vertical auto-shrink.
export function previewPxToPt(px: number): number {
  return (px * 72) / PREVIEW_DPI;
}

// ─── Anchor placement ──────────────────────────────────────────────────────────

type Vert = "top" | "middle" | "bottom";
type Horiz = "left" | "center" | "right";

function splitAnchor(anchor: TextAnchor): { vert: Vert; horiz: Horiz } {
  const [vert, horiz] = anchor.split("-") as [Vert, Horiz];
  return { vert, horiz };
}

// Flexbox + text-align mapping for the on-screen stamp <div> / input.
export function anchorCss(anchor: TextAnchor): {
  justifyContent: "flex-start" | "center" | "flex-end";
  alignItems: "flex-start" | "center" | "flex-end";
  textAlign: "left" | "center" | "right";
} {
  const { vert, horiz } = splitAnchor(anchor);
  return {
    justifyContent: horiz === "left" ? "flex-start" : horiz === "right" ? "flex-end" : "center",
    alignItems: vert === "top" ? "flex-start" : vert === "bottom" ? "flex-end" : "center",
    textAlign: horiz,
  };
}

// Approximate cap-height fraction of the font size (glyph top above the baseline).
// Matches the 0.7 factor the existing centered-mark path uses.
const CAP = 0.7;

// PDF-point placement (bottom-left origin) for a single line of width `tw` at
// `size`, anchored inside a box whose bottom-left is (x0, y0) with size (w, h).
export function anchorPdfXY({
  x0,
  y0,
  w,
  h,
  tw,
  size,
  anchor,
  pad,
}: {
  x0: number;
  y0: number;
  w: number;
  h: number;
  tw: number;
  size: number;
  anchor: TextAnchor;
  pad: number;
}): { x: number; y: number } {
  const { vert, horiz } = splitAnchor(anchor);
  const x = horiz === "left" ? x0 + pad : horiz === "right" ? x0 + w - pad - tw : x0 + (w - tw) / 2;
  const cap = size * CAP;
  const y =
    vert === "top"
      ? y0 + h - pad - cap // glyph top flush near the box top
      : vert === "bottom"
        ? y0 + pad // baseline near the box bottom
        : y0 + (h - cap) / 2; // cap band vertically centered
  return { x, y };
}

// PDF-point placement (bottom-left origin) for an image of size (dw, dh) anchored
// inside a box whose bottom-left is (x0, y0) with size (w, h). No baseline/pad — a
// fit-to-box image sits flush to the anchored edge; middle centers it. Used to
// place the (aspect-preserved, scale-shrunk) signature stamp per its 9-point anchor.
export function anchorImageXY({
  x0,
  y0,
  w,
  h,
  dw,
  dh,
  anchor,
}: {
  x0: number;
  y0: number;
  w: number;
  h: number;
  dw: number;
  dh: number;
  anchor: TextAnchor;
}): { x: number; y: number } {
  const { vert, horiz } = splitAnchor(anchor);
  const x = horiz === "left" ? x0 : horiz === "right" ? x0 + w - dw : x0 + (w - dw) / 2;
  const y = vert === "bottom" ? y0 : vert === "top" ? y0 + h - dh : y0 + (h - dh) / 2;
  return { x, y };
}

// PDF-point placement (bottom-left origin) for each line of a wrapped block. Lines
// stack downward from the anchor's vertical edge by one LINE_HEIGHT_FACTOR step;
// each line is placed horizontally by the anchor's horiz component using its own
// measured width. Multi-line fields almost always anchor top-left, but middle/
// bottom stay sane. `measure` shares the point unit with the box dims. `padX`/`padY`
// are the per-axis insets (see multilinePadPt) — they must match the insets the
// fit calc subtracted from the box, so placement and shrink-to-fit stay in lockstep.
export function layoutMultiline({
  x0,
  y0,
  w,
  h,
  size,
  lines,
  anchor,
  padX,
  padY,
  measure,
}: {
  x0: number;
  y0: number;
  w: number;
  h: number;
  size: number;
  lines: string[];
  anchor: TextAnchor;
  padX: number;
  padY: number;
  measure: MeasureText;
}): { text: string; x: number; y: number }[] {
  const { vert, horiz } = splitAnchor(anchor);
  const lineH = size * LINE_HEIGHT_FACTOR;
  const cap = size * CAP;
  const n = lines.length;
  // Baseline of the FIRST line. top: first cap flush under the top pad. bottom:
  // last line's baseline near the bottom pad. middle: block centered in the box.
  const firstBaseline =
    vert === "top"
      ? y0 + h - padY - cap
      : vert === "bottom"
        ? y0 + padY + (n - 1) * lineH
        : y0 + (h + n * lineH) / 2 - cap;
  return lines.map((text, i) => {
    const tw = measure(text, size);
    const x =
      horiz === "left" ? x0 + padX : horiz === "right" ? x0 + w - padX - tw : x0 + (w - tw) / 2;
    return { text, x, y: firstBaseline - i * lineH };
  });
}

// ─── On-screen measuring ────────────────────────────────────────────────────────

let _canvasCtx: CanvasRenderingContext2D | null | undefined;

function canvasCtx(): CanvasRenderingContext2D | null {
  if (_canvasCtx !== undefined) return _canvasCtx;
  _canvasCtx =
    typeof document === "undefined"
      ? null
      : (document.createElement("canvas").getContext("2d") ?? null);
  return _canvasCtx;
}

// Measure text width in CSS pixels using one lazily-created offscreen canvas.
// Returns 0 when no canvas is available (SSR) — callers then skip shrinking.
export function measureCanvas(text: string, fontPx: number, family = STAMP_FONT_FAMILY): number {
  const ctx = canvasCtx();
  if (!ctx) return 0;
  ctx.font = `${fontPx}px ${family}`;
  return ctx.measureText(text).width;
}

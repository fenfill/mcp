// Vector geometry for the preset checkbox/radio marks (✓ ✗ ■), shared by the
// on-screen overlays (<MarkSvg>, markVectors.tsx) and the exported PDF
// (drawMarkPdf, defined in stampPdf.ts). Drawing the marks as strokes/fills —
// instead of rendering a font glyph — makes them pixel-identical between the fill
// preview and the printed PDF and independent of whether any embedded font covers
// the Dingbats block. Custom (non-preset) symbols are NOT vectorized; they fall
// back to text in the stamp font on both surfaces.
//
// Pure data + one classifier: no React, no JSX, no `pdf-lib`. It is part of the
// Node-safe stamping core (fillCore.ts) that the @fenfill/mcp package bundles, so
// it must not pull `react/jsx-runtime` the way the .tsx component module does.

export type MarkShape = "check" | "cross" | "square";

// Geometry lives in a top-left-origin 0..1 box (SVG convention). Stroked shapes
// are polylines (point sequences); the filled square is a rect. The PDF drawer
// flips Y and centers this in a square inscribed in the cell, exactly as SVG
// `preserveAspectRatio="xMidYMid meet"` does on screen — so both surfaces match.
type Pt = readonly [number, number];

// Stroke width as a fraction of the (square) mark side.
export const MARK_STROKE = 0.16;

// Polyline point-sequences for the stroked marks.
export const MARK_LINES: Record<"check" | "cross", readonly (readonly Pt[])[]> = {
  // Two crossing diagonals.
  cross: [
    [
      [0.16, 0.16],
      [0.84, 0.84],
    ],
    [
      [0.84, 0.16],
      [0.16, 0.84],
    ],
  ],
  // A single check tick: down to the low point, then up to the tall right arm.
  check: [
    [
      [0.14, 0.55],
      [0.4, 0.82],
      [0.86, 0.2],
    ],
  ],
};

// Filled square (■), inset to match the stroked marks' visual extent (~0.14–0.86)
// so "Filled" reaches the box edges as much as ✓/✗ do.
export const MARK_SQUARE = { x: 0.14, y: 0.14, w: 0.72, h: 0.72 } as const;

// Map a preset symbol to its vector shape, or null for a custom/free-text glyph
// (which stays text on both surfaces). Kept strictly to the three preset marks
// declared in FieldFormatControls.tsx so a user's custom glyph is never hijacked.
export function classifyMark(symbol: string): MarkShape | null {
  switch (symbol) {
    case "✓":
      return "check";
    case "✗":
      return "cross";
    case "■":
      return "square";
    default:
      return null;
  }
}

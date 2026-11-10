// The PDF stamp's text widths without the fonts: a synchronous `MeasureText` that
// returns exactly what stampPdf's `embedStampFaces(...).measure` returns (pdf-lib
// over fontkit), read from a table generated from the stamp faces
// (stampAdvances.data.ts, scripts/gen_stamp_advances.ts). The flow split
// (splitFill.ts distributeFlow) breaks with it, so the fill UI, the browser stamp,
// mass fill and the MCP put the same words in the same box: no font load, no
// canvas, the same in Node, a worker and the browser (decision D2,
// P0B_FLOW_MEASUREMENT.md).
//
// Same routing as embedStampFaces' `pick`: a JP_FACE_RANGES code point goes to
// Noto Sans JP, else Inter where Inter has the glyph, else DejaVuSans; a
// variation selector or voicing mark after a JP-routed character stays in its
// run (joinsJpRun). Same arithmetic, in the same order, as pdf-lib's
// CustomFontEmbedder.widthOfTextAtSize per run: Σ advance·(1000/upm), then
// ·(size/1000), summed over the runs left to right. So it is bit-for-bit the
// stamp's width, except where a default GSUB substitution changes a glyph: the
// table holds the widest glyph a code point can become (Inter's `*` beside a
// digit), so it never measures less than the stamp, and it measures more where
// a ligature (Inter's `->` arrow) or a narrower alternate is drawn.
// stampAdvances.test.ts pins both, and the font files' SHA-256s.
//
// Pure and Node-safe (part of the fill core the MCP bundles). The table is
// decoded on first use (~25k code points, a few milliseconds).

import { inJpFaceRange, joinsJpRun, splitByCoverage } from "./fontRuns";
import { STAMP_ADVANCE_DATA } from "./stampAdvances.data";
import type { MeasureText } from "./textFit";

type FaceName = keyof typeof STAMP_ADVANCE_DATA;

interface Face {
  /** pdf-lib's per-face scale: 1000 / unitsPerEm. */
  scale: number;
  notdef: number;
  /** code point → advance in font units. For Inter its key set is also the
   *  routing set (the code points Inter has a glyph for). */
  adv: Map<number, number>;
}

// The data module's alphabet (gen_stamp_advances.ts ALPHABET): one character per
// 5 bits of a little-endian varint; values ≥ 32 mean "more follows".
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";

function decodeVarints(s: string): number[] {
  const out: number[] = [];
  let n = 0;
  let mult = 1;
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error("stampAdvances.data.ts: bad character");
    n += (v % 32) * mult;
    if (v >= 32) {
      mult *= 32;
    } else {
      out.push(n);
      n = 0;
      mult = 1;
    }
  }
  return out;
}

function decodeFace(d: (typeof STAMP_ADVANCE_DATA)[FaceName]): Face {
  const palette = decodeVarints(d.palette);
  const runs = decodeVarints(d.runs);
  const adv = new Map<number, number>();
  let end = 0;
  for (let i = 0; i + 2 < runs.length; i += 3) {
    const start = end + runs[i];
    const w = palette[runs[i + 2]];
    for (let k = 0; k < runs[i + 1]; k++) adv.set(start + k, w);
    end = start + runs[i + 1];
  }
  return { scale: 1000 / d.upm, notdef: d.notdef, adv };
}

let faces: Record<FaceName, Face> | undefined;
function getFaces(): Record<FaceName, Face> {
  faces ??= {
    inter: decodeFace(STAMP_ADVANCE_DATA.inter),
    deja: decodeFace(STAMP_ADVANCE_DATA.deja),
    jp: decodeFace(STAMP_ADVANCE_DATA.jp),
  };
  return faces;
}

// fontkit drops a variation selector (it only picks the glyph of the character
// before it), so it is 0 in every face. Not in the table: Inter's key set must
// stay its exact routing set.
const isVariationSelector = (cp: number) =>
  (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);

function pickFace(f: Record<FaceName, Face>, cp: number): Face {
  return inJpFaceRange(cp) ? f.jp : f.inter.adv.has(cp) ? f.inter : f.deja;
}

const unitsOf = (face: Face, cp: number): number =>
  isVariationSelector(cp) ? 0 : (face.adv.get(cp) ?? face.notdef);

/**
 * The stamp's width of `text` at `size` points, as `embedStampFaces(...).measure`
 * gives it (see the header). Text a mark draws after shaping (Arabic) must be
 * passed shaped, as the stamp measures it: splitFill.ts stampFlowMeasure.
 */
export const stampAdvanceMeasure: MeasureText = (text, size) => {
  const f = getFaces();
  let sum = 0;
  for (const run of splitByCoverage(text, (cp) => pickFace(f, cp), joinsJpRun)) {
    const face = run.key;
    let tw = 0;
    for (const ch of run.text) tw += unitsOf(face, ch.codePointAt(0) ?? 0) * face.scale;
    sum += tw * (size / 1000);
  }
  return sum;
};

/** Whether `cp` takes no width in the face the stamp draws it with (a combining
 *  mark, a variation selector): a hard break never cuts before one. */
export function stampZeroAdvance(cp: number): boolean {
  return unitsOf(pickFace(getFaces(), cp), cp) === 0;
}

/** The faces' SHA-256s the table was generated from (the pin test reads them). */
export const STAMP_ADVANCE_FONT_SHA256: Record<FaceName, string> = {
  inter: STAMP_ADVANCE_DATA.inter.sha256,
  deja: STAMP_ADVANCE_DATA.deja.sha256,
  jp: STAMP_ADVANCE_DATA.jp.sha256,
};

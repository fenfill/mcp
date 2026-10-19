// Split a string into maximal consecutive runs that map to the same value under
// `pick` (evaluated per Unicode code point). stampPdf uses this to group a value's
// characters by which embedded face renders them — Inter (brand primary) where it
// has the glyph, DejaVuSans as the broad-Unicode fallback, Noto Sans JP for the
// Japanese ranges below — so a mixed-script value (e.g. Latin + Cyrillic + Hebrew
// + Japanese) draws every glyph instead of tofu boxes.
//
// Pure and font-agnostic (no pdf-lib) so it's unit-testable and safe to import
// anywhere. Iterates by code point (`Array.from`) so astral-plane characters are
// treated as single units, not split across their surrogate halves.
//
// `joinsPrevious(cp, prevCp)`, when given, keeps a code point in the open run
// whatever `pick` says (a variation selector after a JP-routed ideograph must
// stay with it, or the face can't apply the variation sequence). Absent => the
// historical per-code-point split.
export function splitByCoverage<T>(
  text: string,
  pick: (cp: number) => T,
  joinsPrevious?: (cp: number, prevCp: number) => boolean,
): { key: T; text: string }[] {
  const runs: { key: T; text: string }[] = [];
  let current: { key: T; text: string } | undefined;
  let prevCp = -1;
  for (const ch of Array.from(text)) {
    const cp = ch.codePointAt(0) ?? 0;
    if (current !== undefined && joinsPrevious?.(cp, prevCp) === true) {
      current.text += ch;
      prevCp = cp;
      continue;
    }
    const key = pick(cp);
    prevCp = cp;
    // Extend the open run when the face is unchanged; else start a new one.
    if (current !== undefined && current.key === key) {
      current.text += ch;
    } else {
      current = { key, text: ch };
      runs.push(current);
    }
  }
  return runs;
}

/** How fontkit lays out a run that holds a code point: "rtl" when the
 *  character's script is right-to-left (Hebrew, Arabic, …), "ltr" for any other
 *  script, "neutral" for Common/Inherited ones (digits, punctuation, spaces,
 *  combining marks) that it skips when it picks a run's script. */
export type RunDirection = "rtl" | "ltr" | "neutral";

/**
 * Splits a VISUAL-order string into the pieces drawText can draw as-is or
 * reversed. pdf-lib lays text out through fontkit, which takes a string's
 * script from its first non-neutral code point and, when that script is
 * right-to-left, reverses the glyphs (it expects logical order). So a piece
 * never mixes an "rtl" and an "ltr" code point (neutral ones join whichever
 * piece is open), and `rtl` says fontkit will reverse it: the stamp hands such
 * a piece over reversed, and the two reversals cancel. Pure, so the split is
 * unit-tested; `dirOf` is stampPdf's fontkit-backed classifier.
 */
export function splitByDirection(
  text: string,
  dirOf: (cp: number) => RunDirection,
): { text: string; rtl: boolean }[] {
  const out: { text: string; rtl: boolean }[] = [];
  let cur: { text: string; rtl: boolean; ltr: boolean } | undefined;
  for (const ch of Array.from(text)) {
    const d = dirOf(ch.codePointAt(0) ?? 0);
    if (cur === undefined || (d === "rtl" && cur.ltr) || (d === "ltr" && cur.rtl)) {
      cur = { text: "", rtl: false, ltr: false };
      out.push(cur);
    }
    cur.text += ch;
    if (d === "rtl") cur.rtl = true;
    if (d === "ltr") cur.ltr = true;
  }
  return out.map(({ text: t, rtl }) => ({ text: t, rtl }));
}

// The third stamp face: public/fonts/NotoSansJP-Regular.ttf (SIL OFL 1.1, text in
// public/fonts/NotoSansJP-OFL.txt). A static glyf instance (wght=400, fontTools
// 4.62.1 varLib.instancer --static --update-name-table) of the Google Fonts
// variable release https://github.com/google/fonts/raw/main/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf
// (version 2.004, google/fonts commit 295d98a, variable sha256 c2f3b4d4…0fc68f),
// then re-saved with glyf.padding = 4: the instancer packs glyphs unpadded, and
// pdf-lib's subsetter writes a short loca that misaligns odd-length glyphs (they
// draw blank; cjkStamp.test.ts decodes the subset to catch it).
// Static file sha256 811055f9af5d0955fbf075c391ddfef287720593bbf48ff06d6812a7c2949f41.
// Full cmap, not subset, so rare kanji in names and addresses print.
export const JP_FACE_URL = "/fonts/NotoSansJP-Regular.ttf";
/** The static file's pin (the MCP package downloads the face and verifies it). */
export const JP_FACE_SHA256 = "811055f9af5d0955fbf075c391ddfef287720593bbf48ff06d6812a7c2949f41";
export const JP_FACE_BYTES = 5_793_848;

// The code points the JP face draws, as inclusive [first, last] blocks in
// ascending order. ONE table drives the print routing (stampPdf), the preview
// face's CSS unicode-range (globals.css `JPStamp`, kept in lockstep by a test)
// and the lazy load (needsJpFace). Inter and DejaVu cover none of these (pinned by
// a test), so "needs the JP face" is a pure range check and the browser and the
// PDF can never pick different faces for a character. Two kinds of row:
//  - the Japanese script blocks (JP_SCRIPT_RANGES): kana, kanji, CJK
//    punctuation, fullwidth forms. Plane 2/3 ideographs are whole blocks. These
//    are also the "CJK side" of textFit's line breaking.
//  - the symbol rows (JP_SYMBOL_RANGES): every other code point the JP face has
//    and Inter + DejaVu both lack (⑪–⑳, ⑴–⒇, ⓐ–ⓩ, 〈〉 U+2329/232A, ⌒, ⸺,
//    Bopomofo, Hangul compatibility jamo, CJK strokes, vertical and small form
//    variants, enclosed alphanumerics/ideographs, ⚽ …), generated from the
//    three cmaps: the run of JP-only code points, merged across gaps of ≤16 code
//    points that neither Inter nor DejaVu draws. None is Latin, Greek or
//    Cyrillic script. A coverage test recomputes the JP-only set from the fonts
//    and fails if any of it falls outside the table.
const JP_SCRIPT_RANGES: readonly (readonly [number, number])[] = [
  [0x2e80, 0x2fdf], // CJK Radicals Supplement + Kangxi Radicals
  [0x3000, 0x303f], // CJK Symbols and Punctuation
  [0x3040, 0x309f], // Hiragana
  [0x30a0, 0x30ff], // Katakana
  [0x31f0, 0x31ff], // Katakana Phonetic Extensions
  [0x3200, 0x32ff], // Enclosed CJK Letters and Months
  [0x3300, 0x33ff], // CJK Compatibility
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe30, 0xfe4f], // CJK Compatibility Forms
  [0xff00, 0xffef], // Halfwidth and Fullwidth Forms
  [0x20000, 0x2a6df], // Extension B
  [0x2a700, 0x2ebef], // Extensions C–F
  [0x2f800, 0x2fa1f], // CJK Compatibility Ideographs Supplement
  [0x30000, 0x3134f], // Extension G
];

// 20 rows, 645 code points the JP face draws (+ 51 unassigned or undrawn gap
// code points, which no face draws either way). See the comment above.
const JP_SYMBOL_RANGES: readonly (readonly [number, number])[] = [
  [0x20dd, 0x20de], // combining enclosing circle / square
  [0x210a, 0x210a], // ℊ script small g
  [0x2312, 0x2312], // ⌒ arc
  [0x2329, 0x232a], // 〈〉 angle brackets (Misc Technical)
  [0x23b0, 0x23cc], // ⎰⎱ ⎾–⏌ (Misc Technical)
  [0x23da, 0x23db], // ⏚⏛
  [0x246a, 0x24b5], // ⑪–⑳ ⑴–⒇ ⒈–⒛ ⒜–⒵
  [0x24d0, 0x24e9], // ⓐ–ⓩ
  [0x24eb, 0x24ff], // ⓫–⓴ ⓵–⓾ ⓿
  [0x26bd, 0x26be], // ⚽⚾
  [0x2934, 0x2935], // ⤴⤵
  [0x29bf, 0x29bf], // ⦿
  [0x2b95, 0x2b95], // ⮕
  [0x2e3a, 0x2e3b], // ⸺⸻ two- and three-em dash
  [0x2ff0, 0x2ffb], // Ideographic Description Characters
  [0x3105, 0x31e3], // Bopomofo, Hangul Compatibility Jamo, Kanbun, CJK Strokes
  [0xfe10, 0xfe19], // Vertical Forms
  [0xfe50, 0xfe6b], // Small Form Variants
  [0x1f100, 0x1f1ac], // Enclosed Alphanumeric Supplement (🄀–🆬)
  [0x1f200, 0x1f251], // Enclosed Ideographic Supplement (🈀–🉑)
];

export const JP_FACE_RANGES: readonly (readonly [number, number])[] = [
  ...JP_SCRIPT_RANGES,
  ...JP_SYMBOL_RANGES,
].sort((a, b) => a[0] - b[0]);

function inRanges(ranges: readonly (readonly [number, number])[], cp: number): boolean {
  for (const [a, b] of ranges) {
    if (cp < a) return false;
    if (cp <= b) return true;
  }
  return false;
}

/** Whether `cp` is in a Japanese script block (the table's first kind of row):
 *  textFit's CJK break points. The symbol rows don't change line breaking. */
export function inJpScriptRange(cp: number): boolean {
  return inRanges(JP_SCRIPT_RANGES, cp);
}

export function inJpFaceRange(cp: number): boolean {
  return inRanges(JP_FACE_RANGES, cp);
}

/** Whether `text` holds any code point only the JP face draws. */
export function needsJpFace(text: string): boolean {
  for (const ch of text) {
    if (inJpFaceRange(ch.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

/** The CSS `unicode-range` value for the table above. */
export const JP_FACE_UNICODE_RANGE = JP_FACE_RANGES.map(
  ([a, b]) => `U+${a.toString(16).toUpperCase()}-${b.toString(16).toUpperCase()}`,
).join(", ");

// Variation selectors (FE00–FE0F, E0100–E01EF; common in Japanese names) and the
// combining kana voicing marks join the run of the character before them, but
// only when that character is JP-routed, so Latin runs never change.
function isJpJoiner(cp: number): boolean {
  return (
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef) ||
    cp === 0x3099 ||
    cp === 0x309a
  );
}

/** splitByCoverage's `joinsPrevious` for a stamp that routes the JP ranges to the JP face. */
export function joinsJpRun(cp: number, prevCp: number): boolean {
  return isJpJoiner(cp) && inJpFaceRange(prevCp);
}

/** The one predicate the stamp (lazy JP load) and the MCP (refusal) share:
 *  whether any mark draws text the JP face is needed for. Text values, comb
 *  characters and custom checkbox symbols (〇, レ) are all `text` marks. */
export function marksNeedJpFace(
  marksByPage: ReadonlyMap<number, readonly { text: string }[]>,
): boolean {
  for (const marks of marksByPage.values()) {
    for (const m of marks) {
      if (m.text && needsJpFace(m.text)) return true;
    }
  }
  return false;
}

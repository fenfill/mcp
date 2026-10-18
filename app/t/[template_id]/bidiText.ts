// Right-to-left text rules shared by the print (stampPdf) and the preview. Pure:
// no bidi library, no pdf-lib, so it is cheap to import anywhere. The full
// Unicode Bidirectional Algorithm only runs on the print side, lazily, for text
// that needs it (rtlStamp.ts); this module only answers "does this value need
// it" and "which way does it read".
import type { TextAnchor } from "@/types";

// The Unicode blocks of the right-to-left scripts, inclusive [first, last]:
// Hebrew, Arabic, Syriac, Thaana, N'Ko, Samaritan, Mandaic, Arabic Supplement
// and Extended (0590–08FF), the Hebrew and Arabic presentation forms
// (FB1D–FDFF, FE70–FEFF), and the historic/RTL ranges of planes 1 (10800–10FFF,
// 1E800–1EFFF). Every character of bidi class R or AL lives in one of them, and
// no Latin, Cyrillic, Greek or CJK character does, so Latin and Japanese values
// never take the bidi path (their stamp stays byte-identical).
const RTL_BLOCKS: readonly (readonly [number, number])[] = [
  [0x0590, 0x08ff],
  [0xfb1d, 0xfdff],
  [0xfe70, 0xfeff],
  [0x10800, 0x10fff],
  [0x1e800, 0x1efff],
];

function inRtlBlock(cp: number): boolean {
  for (const [a, b] of RTL_BLOCKS) {
    if (cp < a) return false;
    if (cp <= b) return true;
  }
  return false;
}

// The explicit/implicit direction controls (ALM, LRM, RLM, the embeddings and
// overrides, the isolates). They steer the bidi algorithm and have no glyph:
// the stamp drops them once a line is in visual order (rtlStamp.ts), and the
// browser draws them zero-width.
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** `text` without its bidi direction controls: what is drawn of it, and so what
 *  is measured (the stamp's bidi path, the preview's canvas measure). */
export function stripBidiControls(text: string): string {
  return text.replace(BIDI_CONTROLS, "");
}

/** Whether `text` holds any character of a right-to-left block, i.e. whether
 *  the stamp must run it through the bidi path (rtlStamp.ts). Also true for
 *  Arabic-Indic digits alone, which the old path printed reversed. */
export function needsBidi(text: string): boolean {
  for (const ch of text) {
    if (inRtlBlock(ch.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

/** needsBidi over every mark that draws text (text values, comb characters,
 *  custom checkbox symbols): whether a stamp loads the bidi library at all. */
export function marksNeedBidi(
  marksByPage: ReadonlyMap<number, readonly { text: string }[]>,
): boolean {
  for (const marks of marksByPage.values()) {
    for (const m of marks) {
      if (m.text && needsBidi(m.text)) return true;
    }
  }
  return false;
}

// The modifier letters whose bidi class is ON (other neutral), not L: the only
// letters the block rule below would misclassify (pinned against bidi-js by
// bidiText.test.ts over every letter of planes 0–2).
const NEUTRAL_LETTERS: readonly (readonly [number, number])[] = [
  [0x02b9, 0x02ba],
  [0x02c6, 0x02cf],
  [0x02ec, 0x02ec],
  [0x0374, 0x0374],
  [0x2e2f, 0x2e2f],
  [0xa67f, 0xa67f],
  [0xa717, 0xa71f],
  [0xa788, 0xa788],
];

const LETTER = /\p{L}/u;

/** The UAX #9 strong direction of one character: "rtl" for bidi class R/AL,
 *  "ltr" for L, null for everything weak or neutral (digits, punctuation,
 *  spaces, marks). Letters plus the three implicit marks (LRM, RLM, ALM); a
 *  symbol or digit of class L (rare: circled Latin letters, Indic digits)
 *  counts as neutral here. */
export function strongDirection(ch: string): "rtl" | "ltr" | null {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp === 0x200f || cp === 0x061c) return "rtl"; // RLM, ALM
  if (cp === 0x200e) return "ltr"; // LRM
  if (!LETTER.test(ch)) return null;
  for (const [a, b] of NEUTRAL_LETTERS) if (cp >= a && cp <= b) return null;
  return inRtlBlock(cp) ? "rtl" : "ltr";
}

/** Whether a value reads right to left: its FIRST strong character is RTL — the
 *  same rule as the HTML `dir="auto"` attribute, so a preview input with
 *  dir="auto" and the print agree. No strong character (digits only, empty)
 *  => false. The print lays the value out with this as the paragraph direction
 *  and right-aligns it (bidiAnchor). */
export function isRtlDominant(text: string): boolean {
  for (const ch of text) {
    const d = strongDirection(ch);
    if (d) return d === "rtl";
  }
  return false;
}

/** The anchor an RTL-dominant value is drawn at: a left anchor (the default
 *  "middle-left", multiline "top-left") becomes the matching right one, so the
 *  value starts at the box's right edge like a dir="rtl" input. Centre and
 *  right anchors, and every LTR value, are unchanged. */
export function bidiAnchor(anchor: TextAnchor, rtl: boolean): TextAnchor {
  if (!rtl) return anchor;
  switch (anchor) {
    case "top-left":
      return "top-right";
    case "middle-left":
      return "middle-right";
    case "bottom-left":
      return "bottom-right";
    default:
      return anchor;
  }
}

/** Whether the stamp lays `text` out right to left: it holds an RTL-block
 *  character (so stampPdf takes the bidi path at all, needsBidi) AND reads right
 *  to left (isRtlDominant). Exactly stampPdf's `rtl`, so the on-screen preview
 *  picks the same paragraph direction and the same side of the box as print. */
export function stampsRtl(text: string): boolean {
  return needsBidi(text) && isRtlDominant(text);
}

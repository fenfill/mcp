// The stamp's right-to-left layer: Arabic shaping (arabicShaping.ts) plus the
// Unicode Bidirectional Algorithm (UAX #9, via bidi-js) that turns a value's
// wrapped lines from logical order (as typed) into visual order (as drawn, left
// to right). stampPdf imports this module dynamically, only when a mark holds a
// right-to-left character (bidiText.ts marksNeedBidi), so bidi-js never reaches
// first-load JS and Latin/Japanese stamps never load it. One bidi-js instance
// per module: a page, a mass-fill worker or the MCP process builds it once.
import bidiFactory, { type Bidi } from "bidi-js";

import { stripBidiControls } from "./bidiText";

export { shapeArabic } from "./arabicShaping";

let bidi: Bidi | undefined;

// bidi-js reads one UTF-16 code unit at a time, so each half of a surrogate
// pair (an emoji, a plane-2 kanji, a plane-1 Hebrew-like letter) would count as
// L. Before resolving levels, every astral character is swapped for two BMP
// characters of ITS class (bidi-js's own table, looked up by code point), so the
// string keeps its UTF-16 length and every index still points at the original.
// None of these is a bracket or mirrored, so the stand-ins never pair or mirror.
const STAND_IN: Readonly<Record<string, string>> = {
  L: "a",
  R: "\u05d0",
  AL: "\u0627",
  EN: "0",
  AN: "\u0660",
  ES: "+",
  ET: "#",
  CS: ",",
  NSM: "\u0300",
  BN: "\u200b",
  WS: " ",
  S: "\t",
  ON: "!",
};

function bmpStandIns(b: Bidi, text: string): string {
  let out = "";
  for (const ch of text) {
    out += ch.length === 1 ? ch : (STAND_IN[b.getBidiCharTypeName(ch)] ?? "a").repeat(2);
  }
  return out;
}

// The classes UAX #9 L1 resets to the paragraph level at the end of a line:
// whitespace, isolate controls, and the controls X9 removes (BN, embeddings).
const TRAILING = new Set([
  "WS",
  "S",
  "B",
  "LRI",
  "RLI",
  "FSI",
  "PDI",
  "BN",
  "LRE",
  "RLE",
  "LRO",
  "RLO",
  "PDF",
]);

/**
 * A value's wrapped lines in visual order: the characters of each line left to
 * right as they appear on the page, with brackets and other mirrored characters
 * swapped at right-to-left levels ("(" drawn as ")"). `text` is the whole
 * logical value and `lines` its wrapped lines in order (textFit.ts wrapLines:
 * each a piece of `text`, the spaces and newlines at the breaks dropped).
 * Levels are resolved ONCE over `text`, paragraph by paragraph (each `\n`
 * starts one), as the browser does before it wraps, so a line that starts with
 * digits still sees the words before the break (W2, W7); each line is then
 * reordered on its own (UAX #9 L1-L2). `rtl` is the paragraph direction (the
 * whole value's, bidiText.ts isRtlDominant), so every line reads the same way.
 * Digits and Latin inside Hebrew/Arabic keep their own left-to-right order.
 * Combining marks stay with their letter's reversed run (drawn just before it,
 * which is where DejaVu's zero-advance marks expect to be). Reordered by code
 * point, so a surrogate pair can never be split. A line that is not a piece of
 * `text` is resolved on its own.
 */
export function visualLines(text: string, lines: readonly string[], rtl: boolean): string[] {
  bidi ??= bidiFactory();
  const b = bidi;
  const base = rtl ? 1 : 0;
  const standIns = bmpStandIns(b, text);
  const { levels } = b.getEmbeddingLevels(standIns, rtl ? "rtl" : "ltr");
  const mirrored = b.getMirroredCharactersMap(standIns, levels);
  let at = 0; // where the next line is looked for in `text`, in UTF-16 units
  return lines.map((line) => {
    const cells: { ch: string; level: number; type: string }[] = [];
    const from = at;
    for (const ch of line) {
      // A break drops the spaces (or the newline) it falls on: skip them.
      while (
        at < text.length &&
        !text.startsWith(ch, at) &&
        (text[at] === " " || text[at] === "\n")
      ) {
        at++;
      }
      if (!text.startsWith(ch, at)) {
        // Not a piece of `text` (never so for wrapLines output): resolve the
        // line alone. It is a piece of itself, so this recurses once.
        at = from;
        return visualLine(line, rtl);
      }
      cells.push({
        ch: mirrored.get(at) ?? ch,
        level: levels[at],
        type: b.getBidiCharTypeName(standIns[at]),
      });
      at += ch.length;
    }
    // L1: whitespace and isolate/format controls ending the line go back to the
    // paragraph level, so a right-to-left line's trailing space stays at its end.
    for (let k = cells.length - 1; k >= 0 && TRAILING.has(cells[k].type); k--) {
      cells[k].level = base;
    }
    // The direction controls have done their work and have no glyph.
    return stripBidiControls(
      reorder(cells, base)
        .map((c) => c.ch)
        .join(""),
    );
  });
}

/** One unwrapped line in visual order: visualLines(line, [line], rtl). */
export function visualLine(line: string, rtl: boolean): string {
  return visualLines(line, [line], rtl)[0] ?? "";
}

// UAX #9 L2 over one line's cells (code points with their resolved levels):
// from the highest level down to the lowest odd one, reverse every maximal run
// at that level or higher. The lowest odd level counts levels not present (a
// line at levels 0 and 2 reverses at 2, then at 1).
function reorder<T extends { level: number }>(cells: T[], base: number): T[] {
  let max = base;
  let minOdd = Infinity;
  for (const c of cells) {
    max = Math.max(max, c.level);
    minOdd = Math.min(minOdd, c.level | 1);
  }
  const out = cells.slice();
  for (let lvl = max; lvl >= minOdd; lvl--) {
    for (let i = 0; i < out.length; i++) {
      if (out[i].level < lvl) continue;
      let j = i;
      while (j + 1 < out.length && out[j + 1].level >= lvl) j++;
      const run = out.slice(i, j + 1).reverse();
      out.splice(i, run.length, ...run);
      i = j;
    }
  }
  return out;
}

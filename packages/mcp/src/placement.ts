// Placement warnings after an edit: the two mistakes the phase-6 gold loop
// kept making with hand-placed boxes.
//   - font: a single-line box left on Auto stamps at AUTO_HEIGHT_FILL of its
//     height (textFit.autoTextStartPt), so a box drawn much taller than its
//     neighbours prints visibly larger text (lease p7);
//   - overlap: a box over printed text (a caption) stamps on top of it
//     (Schengen captions, the PAYE postcode hint). The covered text is quoted.
//     Pale text printed at the left edge of the box (or of its ruled cell) is
//     a hint the value is written over ("Name", "Address" on HMRC CH2): that
//     is a note, not a warning (the founder's rule of 2026-10-15);
//   - cell: a box that pokes a little past the ruled cell it sits in (PAYE
//     First names, 0.004 too high), read from the page render, so scans too;
//   - option: a choice's box on the other side of its caption from the
//     question's other boxes, or followed in reading order by another option's
//     caption (Schengen Q10's Widow(er) box beside "Divorced"). The founder's
//     rule W (2026-10-14) places a box with no room before its caption at the
//     end of the line above: there the next text is its own caption, so it
//     passes. Signature boxes get the overlap check too.
// edit_template checks only the items an edit touched, so an untouched form
// never flags there; preview_page checks every box the page (or crop) shows. Printed text comes from the PDF's text layer (PDFium); a scanned page
// has none and is skipped rather than guessed at from pixels.

import { autoTextStartPt } from "@/app/t/[template_id]/textFit";

import { type Field, type Group, isRec } from "./doc.js";
import type { Snapper } from "./edits.js";
import { type Glyph, pageText, type PageText } from "./render.js";
import { prepareSnapper } from "./snap.js";
import type { RenderSchema } from "./types.js";

/** Stamped size this many times the page's typical size (and FONT_MIN_PT more) warns. */
export const FONT_RATIO = 1.5;
const FONT_MIN_PT = 3;
/** Printed characters whose centre falls inside a box before it warns. */
export const OVERLAP_MIN_CHARS = 2;
/**
 * Past its ruled cell by more than this (fraction of the page; ≈ 6 px at 200 DPI),
 * a box warns. A box drawn onto the rule itself (≈ 0.002) is fine; the PAYE
 * First names box was 0.004 high.
 */
export const CELL_TOL = 0.0025;
/**
 * Characters that print the blank itself, not a caption: underscores, dot
 * leaders, dashes, ellipses and box-drawing rules (a typed form's "_____" line
 * is text in the PDF; see the underline note in CLAUDE.md).
 */
const BLANK_CHARS = /^[_.\-‐-―…·•‧⋯─━┄┅┈┉＿]$/u;
/**
 * Printed this light (luminance on white, 0–255) or lighter, text is pale: a
 * hint printed to be written over. HMRC CH2's hints print at 179 and 217, its
 * greyest caption ("HMRC use only") at 149, ordinary text near 0.
 */
export const PALE_LUM = 165;
const WHITE_LUM = 250;
/** The longest quote of covered text in a warning. */
const QUOTE_MAX = 40;

const multiline = (f: Field) => isRec(f.format) && f.format.variant === "multiline";
const singleLine = (f: Field) =>
  (f.type === "text" && !multiline(f)) || (f.type === "date" && !(f.cells && f.cells.length > 1));

function pinned(f: Field): number | null {
  const s = isRec(f.format) ? f.format.font_size : undefined;
  return typeof s === "number" ? s : null;
}

/** The size a single-line field's value starts at, in points (stampPdf's rule). */
export function stampedSize(f: Field, pageHeightPt: number): number {
  return pinned(f) ?? autoTextStartPt((f.hpct / 100) * pageHeightPt);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Fields an id stands for: a field, or a table's cells (choice/comb members are checkbox/char cells). */
function fieldsOf(render: RenderSchema, ids: Iterable<string>): Field[] {
  const byId = new Map((render.fields as Field[]).map((f) => [f.id, f]));
  const groups = new Map((render.groups as Group[]).map((g) => [g.id, g]));
  const out = new Map<string, Field>();
  for (const id of ids) {
    const f = byId.get(id);
    const owner = f && typeof f.group === "string" ? groups.get(f.group) : undefined;
    if (f && (!owner || owner.kind === "table")) out.set(f.id, f);
    const g = groups.get(id);
    if (g?.kind === "table" && Array.isArray(g.members)) {
      for (const m of g.members as string[]) {
        const mf = byId.get(m);
        if (mf) out.set(mf.id, mf);
      }
    }
  }
  return [...out.values()];
}

/** The size each single-line text/date field's value starts at (stampPdf's rule), by id. */
export async function stampedSizes(
  pdf: Uint8Array,
  render: RenderSchema,
  page: number,
): Promise<Map<string, { font_pt: number; font_auto: boolean }>> {
  const out = new Map<string, { font_pt: number; font_auto: boolean }>();
  let pt: PageText;
  try {
    pt = await pageText(pdf, page);
  } catch {
    return out;
  }
  for (const f of render.fields as Field[]) {
    if (f.page !== page || !singleLine(f)) continue;
    out.set(f.id, {
      font_pt: Math.round(stampedSize(f, pt.heightPt) * 2) / 2,
      font_auto: pinned(f) == null,
    });
  }
  return out;
}

/** Covered glyphs as text: a skipped index is a space or a line break. */
function quoteOf(gs: readonly Glyph[]): string {
  const sorted = [...gs].sort((a, b) => a.i - b.i);
  let out = "";
  sorted.forEach((g, k) => {
    if (k > 0 && g.i - sorted[k - 1].i > 1) out += " ";
    out += g.char;
  });
  return out.length > QUOTE_MAX ? `${out.slice(0, QUOTE_MAX - 1)}…` : out;
}

/** Whether covered text is a hint: all of it pale, and starting at the left
 *  edge of the box or of the ruled cell around it (within one box height, 8 to
 *  20 pt). */
function isHint(
  gs: readonly Glyph[],
  box: { x: number; w: number; h: number },
  cellX: number | null,
  pageW: number,
  pageH: number,
): boolean {
  // White is no tint: on paper it never shows, so it is an OCR layer standing
  // for the print under it (or text on a dark band), not a pale hint.
  if (!gs.every((g) => g.lum !== null && g.lum >= PALE_LUM && g.lum < WHITE_LUM)) return false;
  const start = Math.min(...gs.map((g) => g.x));
  const reach = Math.min(Math.max(box.h * pageH, 8), 20) / pageW;
  const near = (edge: number) => start >= edge - reach && start - edge <= reach;
  return near(box.x) || (cellX !== null && near(cellX));
}

export interface PlacementReport {
  /** "<id>: …" for each misplacement (the loop's gates read the id before the colon). */
  warnings: string[];
  /** "<id>: …" for what is fine as placed but worth knowing: a pale hint under a box. */
  notes: string[];
}

export async function placementWarnings(
  pdf: Uint8Array,
  render: RenderSchema,
  ids: Iterable<string>,
  opts: { pageWide?: boolean; cells?: boolean } = {},
): Promise<string[]> {
  return (await placementReport(pdf, render, ids, opts)).warnings;
}

export async function placementReport(
  pdf: Uint8Array,
  render: RenderSchema,
  ids: Iterable<string>,
  opts: { pageWide?: boolean; cells?: boolean } = {},
): Promise<PlacementReport> {
  const idList = [...ids];
  const checked = fieldsOf(render, idList).filter(
    (f) => f.type === "text" || f.type === "date" || f.type === "signature",
  );
  const choices = choicesOf(render, idList);
  const out: string[] = [];
  const notes: string[] = [];
  if (!checked.length && !choices.length) return { warnings: out, notes };
  let snap: Snapper | null = null;
  if (opts.cells) {
    try {
      snap = await prepareSnapper(pdf, [...new Set(checked.map((f) => f.page))]);
    } catch {
      snap = null; // no render: the cell check is skipped, never a failed call
    }
  }
  const texts = new Map<number, PageText>();
  const checkedIds = new Set(checked.map((f) => f.id));
  for (const f of checked) {
    let pt = texts.get(f.page);
    if (!pt) {
      try {
        pt = await pageText(pdf, f.page);
      } catch {
        continue; // a page the renderer can't open: no warnings, never a failed edit
      }
      texts.set(f.page, pt);
    }
    if (singleLine(f)) {
      const others = (render.fields as Field[]).filter(
        // An edit's own boxes don't set the typical size; a page-wide check
        // compares each box with every other one.
        (o) =>
          o.page === f.page &&
          (opts.pageWide ? o.id !== f.id : !checkedIds.has(o.id)) &&
          singleLine(o),
      );
      if (others.length >= 3) {
        const typical = median(others.map((o) => stampedSize(o, pt.heightPt)));
        const size = stampedSize(f, pt.heightPt);
        if (size >= typical * FONT_RATIO && size - typical >= FONT_MIN_PT) {
          out.push(
            `${f.id}: its value would print at about ${size.toFixed(0)} pt, against ${typical.toFixed(0)} pt for this page's other fields (${pinned(f) != null ? "its font_size is set" : "an Auto box's text size follows its height"}); make the box about as tall as its neighbours${pinned(f) != null ? ", or clear font_size" : ""}`,
          );
        }
      }
    }
    const bx = f.xpct / 100;
    const by = f.ypct / 100;
    const bw = f.wpct / 100;
    const bh = f.hpct / 100;
    const covered = pt.glyphs.filter((g) => {
      if (BLANK_CHARS.test(g.char)) return false;
      const cx = g.x + g.w / 2;
      const cy = g.y + g.h / 2;
      return cx > bx && cx < bx + bw && cy > by && cy < by + bh;
    });
    let cellX: number | null = null;
    if (snap && singleLine(f)) {
      const r = snap(f.page, { x: bx, y: by, w: bw, h: bh }, "cell");
      if ("box" in r) {
        const c = r.box;
        cellX = c.x;
        const past = {
          above: c.y - by,
          below: by + bh - (c.y + c.h),
          left: c.x - bx,
          right: bx + bw - (c.x + c.w),
        };
        // A small overshoot only: a box well outside the cell is another
        // problem (or another cell), not a misfit.
        const sides = Object.entries(past).filter(
          ([k, e]) => e > CELL_TOL && e < 0.5 * (k === "above" || k === "below" ? bh : bw),
        );
        if (sides.length) {
          out.push(
            `${f.id}: the box runs ${sides.map(([k, e]) => `${e.toFixed(3)} ${k}`).join(", ")} its ruled cell (cell x ${c.x.toFixed(4)}, y ${c.y.toFixed(4)}, w ${c.w.toFixed(4)}, h ${c.h.toFixed(4)}), so the value may print on the rule; set_box inside the cell, or snap: "answer" (the cell's blank part) / "cell"`,
          );
        }
      }
    }
    if (covered.length >= OVERLAP_MIN_CHARS) {
      const quote = JSON.stringify(quoteOf(covered));
      if (isHint(covered, { x: bx, w: bw, h: bh }, cellX, pt.widthPt, pt.heightPt)) {
        notes.push(
          `${f.id}: the box covers the pale hint ${quote} printed at its left edge; a hint is written over, so this is no misplacement`,
        );
      } else {
        out.push(
          `${f.id}: the box covers ${String(covered.length)} printed characters (${quote}), so the value would print over them; move or shrink it onto the blank (snap can help)`,
        );
      }
    }
  }
  for (const g of choices) {
    const page = g.page;
    if (typeof page !== "number") continue;
    let pt = texts.get(page);
    if (!pt) {
      try {
        pt = await pageText(pdf, page);
      } catch {
        continue;
      }
      texts.set(page, pt);
    }
    out.push(...optionWarnings(render, g, page, pt));
  }
  return { warnings: out, notes };
}

// ---- Option boxes ---------------------------------------------------------------------------

/** Printed tick boxes and check marks (and symbol-font codes): the print of a box, not a caption. */
const TICK_CHARS = /^[\u2610-\u2612\u25a0-\u25a1\u25fb-\u25fe\u2713-\u2718\uf000-\uf0ff]$/u;

/** A box or a printed word, in points, top-left origin. */
interface Pt {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Word extends Pt {
  text: string;
}

const norm = (s: string): string =>
  s
    .normalize("NFC")
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

/** The choice groups the ids stand for: a group, or the group of an option. */
function choicesOf(render: RenderSchema, ids: readonly string[]): Group[] {
  const groups = new Map((render.groups as Group[]).map((g) => [g.id, g]));
  const byId = new Map((render.fields as Field[]).map((f) => [f.id, f]));
  const out = new Map<string, Group>();
  for (const id of ids) {
    const f = byId.get(id);
    const g =
      groups.get(id) ?? (f && typeof f.group === "string" ? groups.get(f.group) : undefined);
    if (g?.kind === "choice") out.set(g.id, g);
  }
  return [...out.values()];
}

/** Each page text's words, built once: a page's every choice group reads them. */
const wordsMemo = new WeakMap<PageText, Word[]>();

function wordsOf(pt: PageText): Word[] {
  let words = wordsMemo.get(pt);
  if (!words) {
    words = buildWords(pt);
    wordsMemo.set(pt, words);
  }
  return words;
}

/** The page's printed words in points: glyphs joined while their text runs on
 *  (no skipped index, no wide gap, the same line). */
function buildWords(pt: PageText): Word[] {
  const gs = pt.glyphs
    .filter((g) => !BLANK_CHARS.test(g.char) && !TICK_CHARS.test(g.char))
    .map((g) => ({
      i: g.i,
      char: g.char,
      x: g.x * pt.widthPt,
      y: g.y * pt.heightPt,
      w: g.w * pt.widthPt,
      h: g.h * pt.heightPt,
    }))
    .sort((a, b) => a.i - b.i);
  const words: Word[] = [];
  let cur: typeof gs = [];
  const flush = () => {
    if (!cur.length) return;
    const x0 = Math.min(...cur.map((g) => g.x));
    const y0 = Math.min(...cur.map((g) => g.y));
    const x1 = Math.max(...cur.map((g) => g.x + g.w));
    const y1 = Math.max(...cur.map((g) => g.y + g.h));
    words.push({ text: cur.map((g) => g.char).join(""), x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    cur = [];
  };
  for (const g of gs) {
    const prev = cur.at(-1);
    if (
      prev &&
      (g.i - prev.i > 1 ||
        g.x - (prev.x + prev.w) > 0.5 * Math.max(prev.h, g.h) ||
        !sameLine(prev, g, 0.3))
    ) {
      flush();
    }
    cur.push(g);
  }
  flush();
  return words;
}

/** Whether two boxes share a line: they overlap vertically by `frac` of the shorter. */
function sameLine(a: Pt, b: Pt, frac = 0.4): boolean {
  const shared = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return shared >= frac * Math.min(a.h, b.h);
}

function gap(a: Pt, b: Pt): number {
  const dx = Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w));
  const dy = Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h));
  return Math.hypot(dx, dy);
}

/** How far (points) an option's caption may be from its box to be found. */
const CAPTION_REACH = 200;

/**
 * Rule W's warnings for one choice group (empty on a scan, or when fewer than
 * two captions are found to say which side the question's boxes are on).
 */
function optionWarnings(render: RenderSchema, g: Group, page: number, pt: PageText): string[] {
  const byId = new Map((render.fields as Field[]).map((f) => [f.id, f]));
  const options = (Array.isArray(g.members) ? (g.members as string[]) : [])
    .map((id) => byId.get(id))
    .filter((f): f is Field => !!f && f.page === page);
  if (options.length < 2) return [];
  const words = wordsOf(pt);
  if (!words.length) return [];
  const boxOf = (f: Field): Pt => ({
    x: (f.xpct / 100) * pt.widthPt,
    y: (f.ypct / 100) * pt.heightPt,
    w: (f.wpct / 100) * pt.widthPt,
    h: (f.hpct / 100) * pt.heightPt,
  });
  // The question's span: its boxes, give or take two box widths.
  const boxes = options.map(boxOf);
  const pad = Math.max(12, 2 * median(boxes.map((b) => b.w)));
  const left = Math.min(...boxes.map((b) => b.x)) - pad;
  const right = Math.max(...boxes.map((b) => b.x + b.w)) + pad;
  const inSpan = (w: Word) => w.x + w.w > left && w.x < right;
  // Each option's own caption: the nearest printed word in the question's span,
  // on the box's line or the next one, that starts its label (its first word
  // with a letter: "10, Inne:" is captioned "Inne"; a text layer that drops a
  // last letter, "wymian" for "wymianę", still matches).
  const matches = (t: string, first: string) =>
    t === first ||
    (first.length >= 4 && t.startsWith(first)) ||
    (t.length >= 4 && first.startsWith(t) && first.length - t.length <= 2);
  const found = new Map<
    string,
    { box: Pt; caption: Word; side: "before" | "after"; inline: boolean }
  >();
  // Every option's candidate captions, then one caption per option and one
  // option per caption, nearest pairs first: two options whose labels start
  // alike ("Other", "Other (specify)") never both claim one printed word.
  const claims: { o: Field; box: Pt; w: Word; d: number }[] = [];
  for (const o of options) {
    const label = typeof o.label === "string" ? o.label : "";
    const tokens = label.split(/\s+/).map(norm).filter(Boolean);
    const first = tokens.find((t) => t.length >= 2 && /\p{L}/u.test(t)) ?? tokens[0];
    if (!first) continue;
    const box = boxOf(o);
    const near = (w: Word) =>
      sameLine(w, box) ||
      Math.max(w.y - (box.y + box.h), box.y - (w.y + w.h)) <= 1.5 * Math.max(box.h, w.h);
    for (const w of words) {
      if (!inSpan(w) || !near(w) || !matches(norm(w.text), first)) continue;
      const d = gap(w, box);
      if (d <= CAPTION_REACH) claims.push({ o, box, w, d });
    }
  }
  claims.sort((a, b) => a.d - b.d);
  const claimed = new Set<Word>();
  for (const { o, box, w: best } of claims) {
    if (found.has(o.id) || claimed.has(best)) continue;
    claimed.add(best);
    // In reading order: a caption later on the box's line, or on a line below,
    // comes after the box (the box is printed before it).
    const inline = sameLine(best, box);
    const side = inline
      ? best.x + best.w / 2 >= box.x + box.w / 2
        ? "before"
        : "after"
      : best.y > box.y
        ? "before"
        : "after";
    found.set(o.id, { box, caption: best, side, inline });
  }
  const sides = [...found.values()].map((f) => f.side);
  const before = sides.filter((x) => x === "before").length;
  const after = sides.length - before;
  // A tie (most often a Yes/No) is not judged: a two-option question's
  // captions repeat all over a form of such questions, so the nearest "Yes" is
  // often a neighbour's, and judging ties put 18 false warnings on 6 of the 28
  // accepted loop templates (2026-10-15).
  if (before === after) return [];
  if (Math.max(before, after) < 2) return [];
  const usual = before > after ? "before" : "after";
  // Rule W's reading-order slot is for captions printed beside their boxes; a
  // question whose captions sit under (or over) the boxes reads by column.
  const inlineCount = [...found.values()].filter((f) => f.inline).length;
  const besideCaptions = inlineCount >= 2 && inlineCount * 2 > found.size;
  const captions = new Map([...found].map(([id, f]) => [f.caption, id]));
  const quote = (w: Word) => JSON.stringify(w.text);
  const out: string[] = [];
  for (const o of options) {
    const f = found.get(o.id);
    if (!f) continue;
    const why: string[] = [];
    if (f.side !== usual) {
      why.push(
        `its box is ${f.side === "before" ? "before" : "after"} its caption ${quote(f.caption)} in reading order, but this question's other boxes are ${usual} theirs (one question never mixes sides)`,
      );
    }
    // The printed text next to the box on its caption's side: on its line, or
    // when the box ends (starts) a line, the start (end) of the next (previous) line.
    const { box } = f;
    const ahead = usual === "before";
    if (!besideCaptions) {
      if (why.length) out.push(`${o.id}: ${why.join("; and ")}`);
      continue;
    }
    const onLine = words
      .filter((w) => inSpan(w) && sameLine(w, box) && norm(w.text))
      .filter((w) => (ahead ? w.x >= box.x + box.w * 0.5 : w.x + w.w <= box.x + box.w * 0.5))
      .sort((a, b) => (ahead ? a.x - b.x : b.x + b.w - (a.x + a.w)));
    let next: Word | undefined = onLine[0];
    if (!next) {
      const reach = 2.5 * Math.max(box.h, 8);
      const rows = words.filter(
        (w) =>
          inSpan(w) &&
          norm(w.text) &&
          !sameLine(w, box) &&
          (ahead
            ? w.y >= box.y + box.h * 0.5 && w.y - (box.y + box.h) <= reach
            : w.y + w.h <= box.y + box.h * 0.5 && box.y - (w.y + w.h) <= reach),
      );
      const edge = ahead
        ? rows.reduce<Word | undefined>((m, w) => (!m || w.y < m.y ? w : m), undefined)
        : rows.reduce<Word | undefined>((m, w) => (!m || w.y + w.h > m.y + m.h ? w : m), undefined);
      if (edge) {
        const line = rows.filter((w) => sameLine(w, edge));
        next = line.sort((a, b) => (ahead ? a.x - b.x : b.x + b.w - (a.x + a.w)))[0];
      }
    }
    const owner = next ? captions.get(next) : undefined;
    if (next && owner && owner !== o.id) {
      why.push(
        `the printed text ${ahead ? "after" : "before"} its box is ${quote(next)}, the caption of option ${owner}, so a tick there reads as that option`,
      );
    }
    if (why.length) {
      out.push(
        `${o.id}: ${why.join("; and ")}; a box goes ${usual === "before" ? "just before" : "just after"} its own caption ${quote(f.caption)} (on the line ${usual === "before" ? "above when its caption starts a line" : "below when its caption ends a line"})`,
      );
    }
  }
  return out;
}

// Placement warnings after an edit: the two mistakes the phase-6 gold loop
// kept making with hand-placed boxes.
//   - font: a single-line box left on Auto stamps at AUTO_HEIGHT_FILL of its
//     height (textFit.autoTextStartPt), so a box drawn much taller than its
//     neighbours prints visibly larger text (lease p7);
//   - overlap: a box over printed text (a caption or a hint) stamps on top of
//     it (Schengen captions, the PAYE postcode hint);
//   - cell: a box that pokes a little past the ruled cell it sits in (PAYE
//     First names, 0.004 too high), read from the page render, so scans too.
// edit_template checks only the items an edit touched, so an untouched form
// never flags there; preview_page checks every box the page (or crop) shows. Printed text comes from the PDF's text layer (PDFium); a scanned page
// has none and is skipped rather than guessed at from pixels.

import { autoTextStartPt } from "@/app/t/[template_id]/textFit";

import { type Field, type Group, isRec } from "./doc.js";
import type { Snapper } from "./edits.js";
import { pageText, type PageText } from "./render.js";
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

export async function placementWarnings(
  pdf: Uint8Array,
  render: RenderSchema,
  ids: Iterable<string>,
  opts: { pageWide?: boolean; cells?: boolean } = {},
): Promise<string[]> {
  const checked = fieldsOf(render, ids).filter((f) => f.type === "text" || f.type === "date");
  if (!checked.length) return [];
  const out: string[] = [];
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
    const inside = pt.glyphs.filter((g) => {
      if (BLANK_CHARS.test(g.char)) return false;
      const cx = g.x + g.w / 2;
      const cy = g.y + g.h / 2;
      return cx > bx && cx < bx + bw && cy > by && cy < by + bh;
    }).length;
    if (snap && singleLine(f)) {
      const r = snap(f.page, { x: bx, y: by, w: bw, h: bh }, "cell");
      if ("box" in r) {
        const c = r.box;
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
    if (inside >= OVERLAP_MIN_CHARS) {
      out.push(
        `${f.id}: the box covers ${String(inside)} printed characters (a caption or hint), so the value would print over them; move or shrink it onto the blank (snap can help)`,
      );
    }
  }
  return out;
}

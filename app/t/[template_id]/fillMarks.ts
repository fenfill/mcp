// Pure builder for the read-only "marks" — the text/symbol overlays that get
// stamped into the output PDF (and shown as EDIT-mode previews + the Story page).
//
// This used to be FillForm's `marksByPage` useMemo, whose dep array included
// `values`, so every fill keystroke re-iterated the WHOLE document to rebuild
// stamp positions — the #1 fill-mode bottleneck. Extracted here as a pure
// function it can be called ON DEMAND (once, at PDF-generation click time, from
// the fill store's snapshot) and PER PAGE (for the small set of pages a
// subscribing overlay actually shows), so a keystroke never rebuilds whole-doc
// marks again.
//
// Parity with the old inline builder is locked by fillMarks.test.ts.

import {
  checkboxFontSizeOf,
  checkboxFormatOf,
  dateFormatFullOf,
  type Field,
  fieldAnchorOf,
  fieldFontSizeOf,
  fieldIsAutoFontSize,
  type Group,
  groupFormatOf,
  signatureScaleOf,
  textFormatOf,
  textMultilineOf,
  textUppercaseOf,
} from "@/types";

import type { Pct } from "./coords";
import {
  boxPct,
  bucketRows,
  buildFieldById,
  cellToPct,
  choiceKey,
  expBodyRows,
  expKey,
  expLayout,
  fieldKey,
  resolveMembers,
  splitMulti,
} from "./fillKeys";
import type { Mark } from "./stampPdf";

export type { Mark };

// Single-line fields are stamped on one baseline, so any stray newline (pasted,
// AI-provided default, or a legacy value from before one-liners were true <input>s)
// must collapse to a space — otherwise the read-only overlay (white-space: pre) and
// the PDF disagree. Multiline values keep their newlines verbatim.
function flattenSingleLine(text: string, multiline: boolean): string {
  return multiline ? text : text.replace(/\s*\n\s*/g, " ");
}

export interface BuildMarksArgs {
  fields: readonly Field[];
  groups: readonly Group[];
  values: Record<string, string>;
  rowCounts: Record<string, number>;
  // When set, only build marks for this page (the per-page overlay path). Omit to
  // build the whole document (the PDF-generation path).
  pageFilter?: number;
}

// Mirrors FillForm's old `marksByPage` memo exactly. Returns a page -> marks map.
export function buildMarks({
  fields,
  groups,
  values,
  rowCounts,
  pageFilter,
}: BuildMarksArgs): Map<number, Mark[]> {
  const fieldById = buildFieldById(fields);
  const groupedFieldIds = new Set<string>();
  for (const g of groups) for (const id of g.members) groupedFieldIds.add(id);
  const visibleRows = (g: Group, capacity: number) => Math.min(rowCounts[g.id] ?? 1, capacity);

  // Explicit checkbox mark size (points) as a spreadable patch — omitted (empty)
  // when unset so the null/auto render path stays byte-identical to before.
  const cbSize = (f: Field): { markFontSize?: number; checkbox?: boolean } => {
    const s = checkboxFontSizeOf(f);
    // Every checkbox mark is flagged `checkbox`: it fills its box to the edges (no
    // 0.8 auto padding) and sizes freely — an explicit size renders at full size
    // and may overflow the (often tiny) box, so the size control is meaningful.
    return s != null ? { markFontSize: s, checkbox: true } : { checkbox: true };
  };

  // A centered text glyph (comb cell / multi-cell char) carries an EXPLICIT font size
  // as `markFontSize` (the centered render paths clamp it to the cell); omitted when
  // unset so the historical box-fit auto size is used. Combs stamp centered, so they
  // ride the same `markFontSize` channel checkboxes use rather than fontSize/anchor.
  const combSize = (f: Field): { markFontSize?: number } => {
    const s =
      (f.type === "date" ? dateFormatFullOf(f).font_size : textFormatOf(f).font_size) ?? null;
    return s != null ? { markFontSize: s } : {};
  };

  const out = new Map<number, Mark[]>();
  const onPage = (page: number) => pageFilter === undefined || page === pageFilter;
  const push = (page: number, m: Mark) => {
    if (!onPage(page)) return;
    let arr = out.get(page);
    if (!arr) {
      arr = [];
      out.set(page, arr);
    }
    arr.push(m);
  };

  // Stamp a (possibly multi-cell) field's text value into its box(es).
  // `forceCenter` centers a single-box text/date value (used for comb cells, whose
  // per-character boxes always center regardless of the member's own anchor).
  const stampValue = (f: Field, key: string, text: string, forceCenter = false) => {
    if (text === "") return;
    // A signature value is a client-side image data-URL (produced by the fill-UI
    // signature pad); emit an image Mark so stampPdf embeds it instead of drawing
    // the text. A stale non-data-URL value falls through to plain text (harmless).
    if (f.type === "signature" && text.startsWith("data:image/")) {
      push(f.page, {
        key,
        box: boxPct(f),
        page: f.page,
        text: "",
        center: true,
        image: { dataUrl: text },
        imageScale: signatureScaleOf(f),
        // 9-point placement of the shrunk image within the box (defaults to
        // centered — see signatureAnchorOf). Every render path reads this.
        anchor: fieldAnchorOf(f),
      });
      return;
    }
    if (f.type === "checkbox") {
      push(f.page, {
        key,
        box: boxPct(f),
        page: f.page,
        text: checkboxFormatOf(f).symbol,
        center: true,
        ...cbSize(f),
      });
      return;
    }
    const cells = f.cells ?? [];
    if (cells.length > 1) {
      const chars = Array.from(text);
      for (let i = 0; i < cells.length && i < chars.length; i++) {
        push(f.page, {
          key: `${key}#${i}`,
          box: cellToPct(cells[i]),
          page: f.page,
          text: chars[i],
          center: true,
          ...combSize(f),
        });
      }
    } else if (forceCenter) {
      // Comb cell: a centered glyph. An explicit size clamps to the cell (via
      // markFontSize, the same channel checkboxes use); a blank size box-fits.
      push(f.page, {
        key,
        box: boxPct(f),
        page: f.page,
        text: textUppercaseOf(f) ? text.toUpperCase() : text,
        center: true,
        ...combSize(f),
      });
    } else {
      // Text (and date) value: carry the field's size + anchor so every render
      // path stamps it consistently. `autoFit` flags a field left on Auto (blank
      // size): single-line Auto starts from the box HEIGHT (autoTextStartPt) then
      // shrinks to width; multiline Auto vertically auto-shrinks. A pinned size sets
      // autoFit:false and renders at exactly that size.
      const ml = textMultilineOf(f);
      push(f.page, {
        key,
        box: boxPct(f),
        page: f.page,
        text: flattenSingleLine(textUppercaseOf(f) ? text.toUpperCase() : text, ml),
        center: false,
        fontSize: fieldFontSizeOf(f),
        anchor: fieldAnchorOf(f),
        multiline: ml,
        autoFit: fieldIsAutoFontSize(f),
      });
    }
  };

  // Ungrouped fields.
  for (const f of fields) {
    if (groupedFieldIds.has(f.id)) continue;
    stampValue(f, fieldKey(f.id), values[fieldKey(f.id)] ?? "");
  }

  // Typed groups.
  for (const g of groups) {
    const members = resolveMembers(g, fieldById);
    if (members.length === 0) continue;
    if (g.kind === "choice") {
      const multi = groupFormatOf(g) === "multiple";
      const sel = multi
        ? new Set(splitMulti(values[choiceKey(g.id)]))
        : new Set([values[choiceKey(g.id)]].filter(Boolean));
      for (const m of members) {
        if (sel.has(m.id)) {
          push(g.page, {
            key: `c${g.id}.${m.id}`,
            box: boxPct(m),
            page: g.page,
            text: checkboxFormatOf(m).symbol,
            center: true,
            ...cbSize(m),
          });
        }
      }
    } else if (g.kind === "table" && groupFormatOf(g) === "expandable") {
      const { pitch, capacity } = expLayout(members);
      const count = visibleRows(g, capacity);
      // Real detected cells per row, aligned to the grid columns; empty for
      // legacy (no-grid) templates, which fall back to constant-pitch cloning.
      const body = expBodyRows(g, fieldById);
      const firstRow: (Field | null)[] = body.length > 0 ? body[0] : (bucketRows(members)[0] ?? []);
      for (let r = 0; r < count; r++) {
        for (let c = 0; c < firstRow.length; c++) {
          const m = firstRow[c];
          if (!m) continue; // grid hole with no column template
          const key = r === 0 ? fieldKey(m.id) : expKey(g.id, r, m.id);
          const raw = values[key] ?? "";
          if (raw === "") continue;
          const ml = m.type === "text" && textMultilineOf(m);
          // A ticked checkbox stores the "X" sentinel; stamp its configured mark.
          const text =
            m.type === "checkbox"
              ? checkboxFormatOf(m).symbol
              : flattenSingleLine(textUppercaseOf(m) ? raw.toUpperCase() : raw, ml);
          // Prefer the real detected cell for this row so marks stay glued to the
          // pre-drawn rows; only synthesize a box (clone the first row down the
          // pitch) for rows added past the detected grid or legacy no-grid tables.
          const real = body[r]?.[c] ?? null;
          const box: Pct = real
            ? { xPct: real.xpct, yPct: real.ypct, wPct: real.wpct, hPct: real.hpct }
            : { xPct: m.xpct, yPct: m.ypct + pitch * r, wPct: m.wpct, hPct: m.hpct };
          const isCheck = m.type === "checkbox";
          push(g.page, {
            key,
            box,
            page: g.page,
            text,
            center: isCheck,
            ...(isCheck
              ? cbSize(m)
              : {
                  fontSize: fieldFontSizeOf(m),
                  anchor: fieldAnchorOf(m),
                  multiline: ml,
                  autoFit: fieldIsAutoFontSize(m),
                }),
          });
        }
      }
    } else {
      // comb + classic / checkbox_matrix table: each member is its own input
      // (stampValue renders checkbox members with their symbol). Comb cells force
      // center — the per-character box always centers its glyph; classic-table
      // cells keep their own anchor.
      const combCenter = g.kind === "comb";
      for (const m of members) {
        stampValue(m, fieldKey(m.id), values[fieldKey(m.id)] ?? "", combCenter);
      }
    }
  }
  return out;
}

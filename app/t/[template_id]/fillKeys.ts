// Pure, dependency-free helpers shared by the fill-mode hot path: the value-map
// key scheme, the box/cell → overlay-percent coordinate adapters, and the
// table-row bucketing + expandable-layout maths.
//
// These used to be module-locals inside FillForm. They were lifted here so the
// new self-subscribing fill controls (fillControls/*), the pure mark builder
// (fillMarks.ts) and FillForm itself all share ONE definition — no drift, and
// the maths stays unit-testable without mounting React.

import type { Cell, Field, Group } from "@/types";

import type { Pct } from "./coords";

// ---- Field index ------------------------------------------------------------
// fieldId -> Field over a fields array. Lives in this dependency-free leaf so
// both the editor store (no React) and the fill hot path share ONE definition
// (re-exported from ./useDerived for the historical import site).
export function buildFieldById(fields: readonly Field[]): Map<string, Field> {
  const m = new Map<string, Field>();
  for (const f of fields) m.set(f.id, f);
  return m;
}

// ---- Value-map keys (fill answers are one flat Record<string,string>) -------
// f{id}            ungrouped field / group member / single comb cell
// c{gid}           choice group selection (single id, or MULTI_SEP-joined ids)
// e{gid}.{r}.{fid} a cloned (added) row cell of an expandable group
// f{id}#{i}        character i of a multi-cell (comb) field
export const fieldKey = (id: string) => `f${id}`;
export const choiceKey = (groupId: string) => `c${groupId}`;
export const expKey = (groupId: string, row: number, fieldId: string) =>
  `e${groupId}.${row}.${fieldId}`;

// Multi-select choice values are stored joined by this control char (U+0001,
// Start of Heading) — a byte that never appears in a member id.
export const MULTI_SEP = "\x01";
export const splitMulti = (v: string | undefined) => (v ?? "").split(MULTI_SEP).filter(Boolean);

// Combs longer than this render as a single textbox on the digital pane instead
// of a row of OTP boxes (still char-limited); the paperform pane keeps the cells.
export const COMB_INLINE_MAX = 8;

// A box as percent of the page (top-left origin) — the v2 coordinate space.
export const boxPct = (b: { xpct: number; ypct: number; wpct: number; hpct: number }): Pct => ({
  xPct: b.xpct,
  yPct: b.ypct,
  wPct: b.wpct,
  hPct: b.hpct,
});

// A character-cell slot ({x,y,w,h} percent) -> the overlay Pct shape.
export const cellToPct = (c: Cell): Pct => ({
  xPct: c.x,
  yPct: c.y,
  wPct: c.w,
  hPct: c.h,
});

// Bucket a flat list of table cells into rows by vertical position (cells whose
// top is within half a row-height of the current row's first cell join it),
// then sort each row left-to-right. Reconstructs the grid for irregular tables.
export function bucketRows(members: Field[]): Field[][] {
  const sorted = [...members].sort((a, b) => a.ypct - b.ypct || a.xpct - b.xpct);
  const rows: Field[][] = [];
  for (const m of sorted) {
    const last = rows.at(-1);
    const ref = last?.[0];
    if (ref && Math.abs(m.ypct - ref.ypct) <= Math.max(ref.hpct, m.hpct) * 0.5) {
      last.push(m);
    } else {
      rows.push([m]);
    }
  }
  for (const r of rows) r.sort((a, b) => a.xpct - b.xpct);
  return rows;
}

// Row-tolerant ordering of a group's member fields: cluster members into visual
// lines by vertical overlap, then order lines top-to-bottom and left-to-right
// within a line. A plain `ypct then xpct` sort lets a few px of vertical jitter
// between adjacent comb cells reorder the line, which makes fill-mode focus jump
// around instead of advancing left-to-right.
export function orderMembers(fs: Field[]): Field[] {
  if (fs.length <= 1) return fs;
  const rows: { top: number; bot: number; items: Field[] }[] = [];
  for (const f of [...fs].sort((a, b) => a.ypct - b.ypct || a.xpct - b.xpct)) {
    const top = f.ypct;
    const bot = f.ypct + f.hpct;
    const cen = top + f.hpct / 2;
    const row = rows.find((r) => {
      const overlap = Math.min(bot, r.bot) - Math.max(top, r.top);
      const small = Math.min(bot - top, r.bot - r.top);
      return (r.top <= cen && cen <= r.bot) || (small > 0 && overlap >= 0.5 * small);
    });
    if (!row) rows.push({ top, bot, items: [f] });
    else {
      row.items.push(f);
      row.top = Math.min(row.top, top);
      row.bot = Math.max(row.bot, bot);
    }
  }
  rows.sort((a, b) => a.top - b.top);
  return rows.flatMap((r) => r.items.sort((a, b) => a.xpct - b.xpct));
}

// Resolve a group's member ids to ordered Field objects (drops dangling ids).
export function resolveMembers(g: Group, fieldById: Map<string, Field>): Field[] {
  const fs = g.members.map((id) => fieldById.get(id)).filter((f): f is Field => !!f);
  return orderMembers(fs);
}

// Expandable group layout: base top, vertical pitch between rows, capacity.
export function expLayout(members: Field[]): { pitch: number; capacity: number } {
  const rows = bucketRows(members);
  const baseTop = Math.min(...members.map((m) => m.ypct));
  // Prefer the real spacing between detected rows so synthesized rows land on
  // the PDF's pre-drawn rows; fall back to a height-based heuristic.
  const pitch =
    rows.length > 1
      ? rows[1][0].ypct - rows[0][0].ypct
      : Math.max(...members.map((m) => m.hpct)) * 1.3;
  // How many rows physically fit from the first row down to the page bottom.
  const fit = Math.max(1, Math.floor((100 - baseTop - 1) / Math.max(pitch, 0.1)));
  // A multi-row grid means the form has that many pre-drawn record rows, so let
  // the user fill every one. A single detected row is a bare template we
  // synthesize downward, so bound it by the geometric fit instead.
  const capacity = rows.length > 1 ? rows.length : fit;
  return { pitch, capacity };
}

// The detected body rows of an expandable table, aligned to the group's grid
// columns: `[r][c]` is the real detected Field at that slot, or null for a hole.
// Empty when the group carries no reconstructed grid (legacy templates), in
// which case callers clone the first row down the detected `pitch` instead.
//
// The pre-drawn rows aren't uniformly pitched (printed grids drift by a pixel or
// two per row), so stamping every revealed row at its own real box — rather than
// `firstRow.ypct + pitch*r` — keeps the marks glued to the paper instead of
// accumulating a compressing drift over a tall table.
export function expBodyRows(group: Group, fieldById: Map<string, Field>): (Field | null)[][] {
  const grid = group.grid;
  if (!grid || grid.length === 0) return [];
  return grid.map((row) => row.map((id) => (id != null ? (fieldById.get(id) ?? null) : null)));
}

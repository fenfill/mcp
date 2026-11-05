// Shared Auto start heights: neighbouring boxes of nearly the same height (one
// table, one row, one stack of lines) start their Auto text at ONE size, the
// smallest box's, so a table whose rows the AI drew 14.4 and 14.8 pt tall
// doesn't print 10.4 pt in one row and 10.6 pt in the next (BIC 2031 table E),
// and CH2's address lines 1–4 + postcode print at one size.
//
// The result maps a field id to the height (percent of its page) its Auto start
// size is computed from (autoTextStartPt). Fields not in a cluster of 2+ are
// absent: they keep their own box height. Only the START size is shared; the
// width shrink-to-fit still applies per box.
//
// Mirrored by acroform_export.py `_auto_heights` (the fillable PDF's /DA
// sizes). tests/fixtures/auto_size/expected.json pins both to the same answer
// (autoSize.parity.test.ts, tests/test_auto_size.py) — change them together.

import { type Field, fieldIsAutoFontSize, type Group, textMultilineOf } from "@/types";

// Two boxes share a size only if the taller is at most this many times the shorter:
// a box drawn markedly taller on purpose keeps its larger text.
export const AUTO_SHARE_RATIO = 1.2;
// Two boxes are neighbours when the gap between their facing edges is at most this,
// in percent of the page along that axis (≈ 8 pt down / 6 pt across on A4).
export const AUTO_NEIGHBOUR_GAP_PCT = 1.0;
// …and they overlap across the other axis by at least this fraction of the
// smaller box (a stack shares columns, a row shares a band).
export const AUTO_NEIGHBOUR_OVERLAP = 0.5;

// A field whose value is one line sized from its box height: single-line text or a
// date, left on Auto, not drawn one character per cell.
function shareable(f: Field): boolean {
  if (f.type !== "text" && f.type !== "date") return false;
  if (f.type === "text" && textMultilineOf(f)) return false;
  if ((f.cells?.length ?? 0) > 1) return false;
  return fieldIsAutoFontSize(f);
}

function similar(a: Field, b: Field): boolean {
  const lo = Math.min(a.hpct, b.hpct);
  const hi = Math.max(a.hpct, b.hpct);
  return lo > 0 && hi <= lo * AUTO_SHARE_RATIO;
}

// The gap between two intervals (negative = they overlap by that much).
const gap = (a0: number, a1: number, b0: number, b1: number) => Math.max(a0, b0) - Math.min(a1, b1);

function neighbours(a: Field, b: Field): boolean {
  if (a.page !== b.page || !similar(a, b)) return false;
  const gy = gap(a.ypct, a.ypct + a.hpct, b.ypct, b.ypct + b.hpct);
  const gx = gap(a.xpct, a.xpct + a.wpct, b.xpct, b.xpct + b.wpct);
  const minW = Math.min(a.wpct, b.wpct);
  const minH = Math.min(a.hpct, b.hpct);
  // Stacked: touching (or nearly) top-to-bottom, sharing columns.
  const stacked =
    gy <= AUTO_NEIGHBOUR_GAP_PCT && gy >= -0.5 * minH && -gx >= AUTO_NEIGHBOUR_OVERLAP * minW;
  // In a row: touching (or nearly) side by side, sharing a band.
  const inRow =
    gx <= AUTO_NEIGHBOUR_GAP_PCT && gx >= -0.5 * minW && -gy >= AUTO_NEIGHBOUR_OVERLAP * minH;
  return stacked || inRow;
}

export function autoHeights(
  fields: readonly Field[],
  groups: readonly Group[],
): Map<string, number> {
  const ownerKind = new Map<string, Group["kind"]>();
  for (const g of groups)
    for (const id of g.members) if (!ownerKind.has(id)) ownerKind.set(id, g.kind);
  const byId = new Map(fields.map((f) => [f.id, f]));

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    for (let up = parent.get(r) ?? r; up !== r; up = parent.get(r) ?? r) r = up;
    let c = x;
    while (c !== r) {
      const n = parent.get(c) ?? r;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };

  // Ungrouped fields: neighbours on a page.
  const loose = fields.filter((f) => !ownerKind.has(f.id) && shareable(f));
  for (const f of loose) parent.set(f.id, f.id);
  const byPage = new Map<number, Field[]>();
  for (const f of loose) {
    const arr = byPage.get(f.page) ?? [];
    arr.push(f);
    byPage.set(f.page, arr);
  }
  for (const arr of byPage.values()) {
    arr.sort((a, b) => a.ypct - b.ypct || a.xpct - b.xpct || (a.id < b.id ? -1 : 1));
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i];
      const reach = a.ypct + a.hpct + AUTO_NEIGHBOUR_GAP_PCT;
      for (let j = i + 1; j < arr.length && arr[j].ypct <= reach; j++) {
        if (neighbours(a, arr[j])) union(a.id, arr[j].id);
      }
    }
  }

  // Tables: every pair of similar cells on one page, adjacent or not.
  for (const g of groups) {
    if (g.kind !== "table") continue;
    const cells = g.members
      .map((id) => byId.get(id))
      .filter((f): f is Field => !!f && shareable(f));
    for (const f of cells) if (!parent.has(f.id)) parent.set(f.id, f.id);
    for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        if (cells[i].page === cells[j].page && similar(cells[i], cells[j])) {
          union(cells[i].id, cells[j].id);
        }
      }
    }
  }

  const minOf = new Map<string, number>();
  const size = new Map<string, number>();
  for (const id of parent.keys()) {
    const r = find(id);
    const h = byId.get(id)?.hpct ?? Infinity;
    minOf.set(r, Math.min(minOf.get(r) ?? Infinity, h));
    size.set(r, (size.get(r) ?? 0) + 1);
  }
  const out = new Map<string, number>();
  for (const id of parent.keys()) {
    const r = find(id);
    const h = minOf.get(r);
    if ((size.get(r) ?? 0) > 1 && h != null) out.set(id, h);
  }
  return out;
}

// Memoized per (fields, groups) identity: the editor's size hints ask once per
// field per store change, and the store replaces these arrays on every edit.
const memo = new WeakMap<readonly Field[], WeakMap<readonly Group[], Map<string, number>>>();
export function autoHeightsCached(
  fields: readonly Field[],
  groups: readonly Group[],
): Map<string, number> {
  let inner = memo.get(fields);
  if (!inner) {
    inner = new WeakMap();
    memo.set(fields, inner);
  }
  let hit = inner.get(groups);
  if (!hit) {
    hit = autoHeights(fields, groups);
    inner.set(groups, hit);
  }
  return hit;
}

// `snap` for add / move / set_box: find the blank a box was meant for in the
// page render and fit the box to it, with the package's own rule finder
// (rules.ts) on a local PDFium render (nothing is sent anywhere). "cell" takes
// the ruled cell around the box's centre, "underline" the field on the rule
// under it, "answer" the cell's blank part below (or after) its printed
// caption. A snap is accepted only when it lands on the box it was asked for;
// otherwise the box is kept and the op says why.

import { createHash } from "node:crypto";

import type { Box } from "./doc.js";
import type { Snapper, SnapMode } from "./edits.js";
import { renderPage } from "./render.js";
import {
  answerArea,
  cellAt,
  findRules,
  inkMask,
  type Rect,
  type Rules,
  underlineFor,
} from "./rules.js";
import type { RenderSchema } from "./types.js";

/** Snap renders at 200 DPI (an A4 page ≈ 1654 × 2339 px); rules.ts's pixel sizes assume it. */
const SNAP_DPI = 200;

// A few recent pages, keyed by PDF hash + page: a correction batch snaps many
// boxes on the same page, and a render + rule pass costs ~100 ms.
const CACHE_MAX = 6;
const cache = new Map<string, Rules>();

async function pageRules(pdf: Uint8Array, hash: string, page: number): Promise<Rules> {
  const key = `${hash}:${String(page)}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const r = await renderPage(pdf, page, SNAP_DPI);
  const rules = findRules(inkMask(r.rgba, r.width, r.height));
  cache.set(key, rules);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return rules;
}

/** The page of a field or group by id or unambiguous prefix (undefined: unknown; the op then fails on its own). */
export function pageOfId(render: RenderSchema, id: string): number | undefined {
  const items = [...render.fields, ...render.groups] as { id: string; page?: unknown }[];
  const exact = items.find((x) => x.id === id);
  const hits = exact ? [exact] : items.filter((x) => x.id.startsWith(id));
  const p = hits.length === 1 ? hits[0].page : undefined;
  return typeof p === "number" ? p : undefined;
}

/** The pages a batch of ops snaps on (the `page` of an add; the item's page otherwise). */
export function snapPages(
  ops: readonly unknown[],
  pageOfId: (id: string) => number | undefined,
): number[] {
  const out = new Set<number>();
  for (const o of ops) {
    if (typeof o !== "object" || o === null) continue;
    const op = o as Record<string, unknown>;
    if (op.snap === undefined) continue;
    if (op.op === "add" && typeof op.page === "number") out.add(op.page);
    else if (typeof op.id === "string") {
      const p = pageOfId(op.id);
      if (p !== undefined) out.add(p);
    }
  }
  return [...out];
}

const area = (r: Rect) => Math.max(0, r.w) * Math.max(0, r.h);
function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Fit `box` (fractions) on one page's rules; pure, for tests. */
export function snapOnRules(rules: Rules, box: Box, mode: SnapMode) {
  const W = rules.ink.width;
  const H = rules.ink.height;
  const b: Rect = { x: box.x * W, y: box.y * H, w: box.w * W, h: box.h * H };
  const toBox = (r: Rect): Box => ({ x: r.x / W, y: r.y / H, w: r.w / W, h: r.h / H });
  const cx = b.x + b.w / 2;
  if (mode === "cell" || mode === "answer") {
    for (const fy of [0.5, 0.3, 0.7]) {
      const r = cellAt(rules, cx, b.y + b.h * fy);
      if (!r) continue;
      // The cell must be the one the box sits in: most of the smaller of the two
      // overlaps, and it isn't a whole region many times the box.
      const ov = overlap(r, b);
      if (ov >= 0.5 * Math.min(area(r), area(b)) && area(r) <= 6 * area(b)) {
        if (mode === "cell") return { box: toBox(r) };
        const a = answerArea(rules.ink, r);
        return a ? { box: toBox(a) } : { none: "no blank part in the cell around its caption" };
      }
    }
    return { none: "no ruled cell around the box" };
  }
  const line = underlineFor(rules, b);
  return line ? { box: toBox(line) } : { none: "no underline under the box" };
}

/** A sync Snapper over pre-rendered pages (render them first: the ops engine is sync). */
export async function prepareSnapper(pdf: Uint8Array, pages: readonly number[]): Promise<Snapper> {
  const hash = createHash("sha256").update(pdf).digest("hex");
  const ready = new Map<number, Rules>();
  for (const p of pages) ready.set(p, await pageRules(pdf, hash, p));
  return (page, box, mode) => {
    const rules = ready.get(page);
    if (!rules) return { none: "no render of that page" };
    return snapOnRules(rules, box, mode);
  };
}

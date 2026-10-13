// The order one page's top-level blocks (loose fields and whole groups) are
// read in, before sections are gathered into runs. ONE implementation for
// everything on the TypeScript side that lists a page's blocks: the fill UI's
// buildPageItems (pageLayout.ts), the layer panel's "Sort by position"
// (editorStore.ts) and the MCP's `reorder` op. agent_schema.py carries the
// Python port (`_lines` / `_page_blocks`); the two are held to the same pinned
// pages (readOrder.parity.test.ts, tests/test_read_order.py).
//
// A page where any block carries an explicit `order` is listed by those ranks.
// Blocks without one come last, and equal ranks fall back to top, then left.
// Nothing re-derives such a page: the order may be its owner's.
//
// Any other page is read by printed line. Blocks are taken top, then left. Each
// joins the latest-started line when it shares a line with EVERY block already
// there; failing that it starts a new line. Asking for every block is what
// keeps a block taller than one line from bridging the lines it spans: it joins
// the first of them, and a block of the next line down does not share a line
// with the short blocks beside it. Only the latest-started line is asked. An
// older line can still be open beside the block (a tall box), but joining it
// would list the block ahead of every line started since, so ahead of blocks
// printed above it; as it is, no block is listed before one printed wholly
// above it. Lines read top to bottom. Inside a line a block left of another
// comes first; two blocks that overlap horizontally keep top, then left, so a
// blank printed inside a wider block's span stays where it was. A block with no
// height shares a line with nothing.
//
// Pure, and free of imports: percent of the page, top-left origin, in and out.

/**
 * Two blocks stand on one printed line when their vertical overlap is at least
 * this share of the shorter one's height; put another way, the shorter block's
 * centre lies inside the other's span.
 */
export const LINE_OVERLAP_FRAC = 0.5;

/**
 * On one line a block is left of another when it ends at or before the other's
 * left edge, give or take this much (percent of the page width): neighbours
 * snapped to one printed rule share an edge or overlap by a hair.
 */
export const LEFT_OF_SLACK_PCT = 0.5;

/** A block's edges, percent of the page, top-left origin. */
export interface Edges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A stored percent box: a field's own. */
export interface PctBox {
  xpct: number;
  ypct: number;
  wpct: number;
  hpct: number;
}

/**
 * The edges of a percent box. Every caller gets a block's far edges from this
 * one sum, and the Python port adds them the same way, so a block has the same
 * edges, bit for bit, wherever its order is derived.
 */
export function boxEdges(box: PctBox): Edges {
  return {
    left: box.xpct,
    top: box.ypct,
    right: box.xpct + box.wpct,
    bottom: box.ypct + box.hpct,
  };
}

/**
 * The edges of a group: those of its members' bounding box, built as a percent
 * box first (the same arithmetic as the Python port). Null without members.
 */
export function membersEdges(members: readonly PctBox[]): Edges | null {
  if (members.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const m of members) {
    x0 = Math.min(x0, m.xpct);
    y0 = Math.min(y0, m.ypct);
    x1 = Math.max(x1, m.xpct + m.wpct);
    y1 = Math.max(y1, m.ypct + m.hpct);
  }
  return boxEdges({ xpct: x0, ypct: y0, wpct: x1 - x0, hpct: y1 - y0 });
}

export function sameLine(a: Edges, b: Edges): boolean {
  const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  const small = Math.min(a.bottom - a.top, b.bottom - b.top);
  return small > 0 && overlap >= LINE_OVERLAP_FRAC * small;
}

export function leftOf(a: Edges, b: Edges): boolean {
  return a.left < b.left && a.right <= b.left + LEFT_OF_SLACK_PCT;
}

/**
 * A page's blocks as printed lines: lines top to bottom, each line left to
 * right. The geometric order of a page, whatever explicit `order` it carries.
 */
export function readingLines<T extends Edges>(blocks: readonly T[]): T[][] {
  const lines: T[][] = []; // in the order they start, i.e. top to bottom
  let latest: T[] | undefined;
  for (const b of [...blocks].sort((p, q) => p.top - q.top || p.left - q.left)) {
    // Only the latest-started line is asked, never an older one still open
    // beside this block (see the header).
    if (latest?.every((o) => sameLine(b, o))) {
      latest.push(b);
    } else {
      latest = [b];
      lines.push(latest);
    }
  }
  return lines.map((ln) => {
    const row: T[] = [];
    for (const b of ln) {
      const at = row.findIndex((o) => leftOf(b, o));
      row.splice(at < 0 ? row.length : at, 0, b);
    }
    return row;
  });
}

/**
 * The page's blocks in the order they are read: by explicit `order` when any
 * block carries one, else by printed line (`readingLines`).
 */
export function orderBlocks<T extends Edges & { order?: number | null }>(
  blocks: readonly T[],
): T[] {
  if (!blocks.some((b) => b.order != null)) return readingLines(blocks).flat();
  return [...blocks].sort((a, b) => {
    const oa = a.order ?? Number.POSITIVE_INFINITY;
    const ob = b.order ?? Number.POSITIVE_INFINITY;
    if (oa !== ob) return oa - ob;
    return a.top - b.top || a.left - b.left;
  });
}

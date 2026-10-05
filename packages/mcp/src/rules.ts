// The package's own ruled-line finder, for `snap` and the ruled-cell placement
// check. It reads a page raster (PDFium, ~200 DPI) and finds:
//   - horizontal rules: thin bands of long ink runs (solid lines and typed
//     underscores; dotted leaders when nothing is printed right above or below
//     them; a solid filled bar counts too, its edges bound the cells around it);
//   - vertical rules: thin solid columns of ink.
// A cell is four rules that meet: the verticals reach both horizontals and the
// horizontals span both verticals (letter strokes never close a box like that).
//
// Deliberately simpler than the web editor's wand (which is not part of this
// package): one global ink threshold from the page's paper tone, no local
// contrast, so a very faint rule on a tinted scan (a ~225 grey border on ~235
// paper) is missed, and an underline's height comes from the clear space above
// it, capped. Pure: pixels in, page-pixel rectangles out.

/** Ink = a pixel this much darker than the paper tone. */
const INK_DELTA = 45;
/** A horizontal rule is at least this long (px; ≈ 3.8 mm at 200 DPI). */
const MIN_H_LEN = 30;
/** A vertical rule is at least this long (px). */
const MIN_V_LEN = 16;
/** A run counts as solid when this much of it has no gap wider than 1 px. */
const SOLID_RUN = 24;
/** Gap a horizontal run may bridge (dotted leaders, anti-aliasing). */
const H_GAP = 8;
/** Thickest band that is still a rule rather than text. */
const MAX_THICK = 6;
/** Dotted leaders: fill share, longest band, and clear margin above/below. */
const DOT_FILL = 0.3;
const DOT_MIN_LEN = 60;
const DOT_MAX_THICK = 4;
/** A filled bar: every row at least this full. */
const BAR_FILL = 0.9;
/** Slack where two rules "meet" (px). */
const MEET = 4;

export interface Ink {
  width: number;
  height: number;
  /** 1 = ink, row-major. */
  data: Uint8Array;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A horizontal rule: rows y0..y1, columns x0..x1 (inclusive px). */
export interface HRule {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** A vertical rule: columns x0..x1, rows y0..y1 (inclusive px). */
export interface VRule {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface Rules {
  ink: Ink;
  h: HRule[];
  v: VRule[];
}

/** The ink mask of an RGBA raster: darker than the paper tone (95th-percentile grey) by INK_DELTA. */
export function inkMask(rgba: ArrayLike<number>, width: number, height: number): Ink {
  const n = width * height;
  const gray = new Uint8Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const g = (rgba[i * 4] * 299 + rgba[i * 4 + 1] * 587 + rgba[i * 4 + 2] * 114) / 1000;
    gray[i] = g;
    hist[gray[i]]++;
  }
  let acc = 0;
  let paper = 255;
  for (let g = 0; g < 256; g++) {
    acc += hist[g];
    if (acc >= n * 0.95) {
      paper = g;
      break;
    }
  }
  const cut = Math.min(paper - INK_DELTA, 210);
  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) data[i] = gray[i] < cut ? 1 : 0;
  return { width, height, data };
}

interface Seg {
  a: number;
  b: number;
  count: number;
  longest: number;
}

/** Ink runs along one line, bridging gaps ≤ gapMax; `at(k)` reads position k. */
function segments(len: number, at: (k: number) => number, gapMax: number, minLen: number): Seg[] {
  const out: Seg[] = [];
  let a = -1;
  let last = -2;
  let count = 0;
  let run = 0;
  let longest = 0;
  const close = () => {
    if (a >= 0 && last - a + 1 >= minLen) out.push({ a, b: last, count, longest });
  };
  for (let k = 0; k < len; k++) {
    if (!at(k)) continue;
    if (a < 0 || k - last > gapMax + 1) {
      close();
      a = k;
      count = 0;
      run = 1;
      longest = 1;
    } else {
      // A 1-px gap (anti-aliasing) keeps a run solid; a wider one restarts it.
      run = k - last <= 2 ? run + (k - last) : 1;
      if (run > longest) longest = run;
    }
    count++;
    last = k;
  }
  close();
  return out;
}

interface Band {
  a: number;
  b: number;
  lo: number;
  hi: number;
  lastA: number;
  lastB: number;
  solid: boolean;
  dotted: boolean;
  full: boolean;
}

/** Group per-line segments of consecutive lines into bands. */
function bands(
  lines: number,
  segsOf: (i: number) => Seg[],
  accept: (s: Seg) => { solid: boolean; dotted: boolean } | null,
): Band[] {
  const done: Band[] = [];
  let open: Band[] = [];
  for (let i = 0; i < lines; i++) {
    const next: Band[] = [];
    for (const s of segsOf(i)) {
      const kind = accept(s);
      if (!kind) continue;
      const len = s.b - s.a + 1;
      const full = s.count / len >= BAR_FILL;
      // Same line only when the runs are alike: half the LONGER one overlaps,
      // so a short text stroke touching a rule never joins (and thickens) it.
      const j = open.findIndex(
        (o) =>
          Math.min(o.lastB, s.b) - Math.max(o.lastA, s.a) + 1 >=
          0.5 * Math.max(o.lastB - o.lastA + 1, len),
      );
      if (j >= 0) {
        const o = open.splice(j, 1)[0];
        o.a = Math.min(o.a, s.a);
        o.b = Math.max(o.b, s.b);
        o.hi = i;
        o.lastA = s.a;
        o.lastB = s.b;
        o.solid ||= kind.solid;
        o.dotted &&= kind.dotted;
        o.full &&= full;
        next.push(o);
      } else {
        next.push({
          a: s.a,
          b: s.b,
          lo: i,
          hi: i,
          lastA: s.a,
          lastB: s.b,
          solid: kind.solid,
          dotted: kind.dotted,
          full,
        });
      }
    }
    done.push(...open);
    open = next;
  }
  done.push(...open);
  return done;
}

/** Ink share of row y over columns x0..x1 (0 outside the page). */
function rowFill(m: Ink, y: number, x0: number, x1: number): number {
  if (y < 0 || y >= m.height) return 0;
  let n = 0;
  for (let x = x0; x <= x1; x++) n += m.data[y * m.width + x];
  return n / (x1 - x0 + 1);
}

/** A slightly rotated (scanned) rule rasterizes as steps: pieces this close end to end… */
const JOIN_GAP = 8;
/** …whose across-position moves by at most this much are one rule. */
const JOIN_STEP = 3;

interface Piece {
  a: number;
  b: number;
  lo: number;
  hi: number;
}

/** Join collinear pieces (along a..b, across lo..hi) into whole rules. */
function joinCollinear(pieces: Piece[]): Piece[] {
  const chains: { all: Piece; last: Piece }[] = [];
  for (const p of [...pieces].sort((x, y) => x.a - y.a)) {
    const c = chains.find(
      (ch) =>
        p.a <= ch.last.b + JOIN_GAP &&
        p.a >= ch.last.a &&
        Math.abs(p.lo - ch.last.lo) <= JOIN_STEP &&
        Math.abs(p.hi - ch.last.hi) <= JOIN_STEP,
    );
    if (c) {
      c.all = {
        a: c.all.a,
        b: Math.max(c.all.b, p.b),
        lo: Math.min(c.all.lo, p.lo),
        hi: Math.max(c.all.hi, p.hi),
      };
      c.last = p;
    } else chains.push({ all: { ...p }, last: p });
  }
  return chains.map((c) => c.all);
}

export function findRules(m: Ink): Rules {
  const { width: W, height: H, data } = m;
  const hb = bands(
    H,
    (y) => segments(W, (x) => data[y * W + x], H_GAP, MIN_H_LEN),
    (s) => {
      const len = s.b - s.a + 1;
      if (s.longest >= SOLID_RUN) return { solid: true, dotted: false };
      if (len >= DOT_MIN_LEN && s.count / len >= DOT_FILL) return { solid: false, dotted: true };
      return null;
    },
  );
  const hp: Piece[] = [];
  for (const b of hb) {
    const thick = b.hi - b.lo + 1;
    const rule = { a: b.a, b: b.b, lo: b.lo, hi: b.hi };
    if (b.full && b.solid)
      hp.push(rule); // a filled bar: its edges bound cells
    else if (b.solid && thick <= MAX_THICK) hp.push(rule);
    else if (b.dotted && thick <= DOT_MAX_THICK && b.b - b.a + 1 >= DOT_MIN_LEN) {
      // Dots alone on their line: nothing printed just above or below.
      const clear = [b.lo - 4, b.lo - 3, b.lo - 2, b.hi + 2, b.hi + 3, b.hi + 4].every(
        (y) => rowFill(m, y, b.a, b.b) < 0.05,
      );
      if (clear) hp.push(rule);
    }
  }
  const h: HRule[] = joinCollinear(hp).map((p) => ({ x0: p.a, x1: p.b, y0: p.lo, y1: p.hi }));
  const vb = bands(
    W,
    (x) => segments(H, (y) => data[y * W + x], 1, MIN_V_LEN),
    (s) => (s.longest >= MIN_V_LEN ? { solid: true, dotted: false } : null),
  );
  const v: VRule[] = joinCollinear(
    vb
      .filter((b) => b.hi - b.lo + 1 <= MAX_THICK)
      .map((b) => ({ a: b.a, b: b.b, lo: b.lo, hi: b.hi })),
  ).map((p) => ({ x0: p.lo, x1: p.hi, y0: p.a, y1: p.b }));
  return { ink: m, h, v };
}

/**
 * The ruled cell around a point (px): the nearest top/bottom rules spanning
 * it, closed by verticals that reach both; its interior, or null.
 */
export function cellAt(r: Rules, px: number, py: number): Rect | null {
  const spans = (h: HRule) => h.x0 - MEET <= px && px <= h.x1 + MEET;
  const tops = r.h.filter((h) => h.y1 < py && spans(h)).sort((a, b) => b.y1 - a.y1);
  const bottoms = r.h.filter((h) => h.y0 > py && spans(h)).sort((a, b) => a.y0 - b.y0);
  for (const top of tops.slice(0, 4)) {
    for (const bot of bottoms.slice(0, 4)) {
      const reaches = (v: VRule) => v.y0 <= top.y1 + MEET && v.y1 >= bot.y0 - MEET;
      const left = r.v
        .filter((v) => v.x1 < px && reaches(v))
        .sort((a, b) => b.x1 - a.x1)
        .find((v) => top.x0 <= v.x1 + MEET && bot.x0 <= v.x1 + MEET);
      const right = r.v
        .filter((v) => v.x0 > px && reaches(v))
        .sort((a, b) => a.x0 - b.x0)
        .find((v) => top.x1 >= v.x0 - MEET && bot.x1 >= v.x0 - MEET);
      if (!left || !right) continue;
      const x = left.x1 + 1;
      const y = top.y1 + 1;
      const w = right.x0 - x;
      const h = bot.y0 - y;
      if (w > 2 && h > 2) return { x, y, w, h };
    }
  }
  return null;
}

/** Underline height: the clear space above the rule, within these bounds (px; ≈ 11–16 pt at 200 DPI, a line of handwriting, as the editor's line snap sizes it). */
const LINE_MIN_H = 30;
const LINE_MAX_H = 45;

/**
 * The field on the rule under a box (px): the nearest horizontal rule whose
 * top lies from 30% down the box to 2.5 box-heights below its top, covering
 * at least half the narrower of the two; clipped by verticals crossing it near
 * the box, as tall as the clear space above it (30–45 px).
 */
export function underlineFor(r: Rules, b: Rect): Rect | null {
  const m = r.ink;
  const target = b.y + b.h;
  const cands = r.h
    .filter((h) => {
      const xOv = Math.min(h.x1, b.x + b.w) - Math.max(h.x0, b.x);
      return (
        h.y0 >= b.y + 0.3 * b.h &&
        h.y0 <= b.y + 2.5 * b.h &&
        xOv >= 0.5 * Math.min(h.x1 - h.x0 + 1, b.w)
      );
    })
    .sort((a, c) => Math.abs(a.y0 - target) - Math.abs(c.y0 - target));
  const line = cands.at(0);
  if (!line) return null;
  // A table's long rule: keep the stretch between the verticals around the box.
  const cx = b.x + b.w / 2;
  const crosses = (v: VRule) => v.y0 <= line.y0 - 4 && v.y1 >= line.y0 - MEET;
  let x0 = line.x0;
  let x1 = line.x1;
  for (const v of r.v) {
    if (!crosses(v)) continue;
    if (v.x1 < cx && v.x1 + 1 > x0) x0 = v.x1 + 1;
    if (v.x0 > cx && v.x0 - 1 < x1) x1 = v.x0 - 1;
  }
  if (x1 - x0 < 8) return null;
  const inner0 = Math.min(x1, x0 + 2);
  const inner1 = Math.max(x0, x1 - 2);
  const limit = Math.max(2, 0.01 * (x1 - x0));
  let clear = 0;
  for (let y = line.y0 - 1; y >= 0 && clear < LINE_MAX_H; y--) {
    let n = 0;
    for (let x = inner0; x <= inner1; x++) n += m.data[y * m.width + x];
    if (n > limit) break;
    clear++;
  }
  const h = Math.max(LINE_MIN_H, clear);
  return { x: x0, y: line.y0 - h, w: x1 - x0 + 1, h };
}

/** Pixels kept clear of the cell's own rules when reading its ink. */
const INSET = 2;
/** The blank band must be at least this share of the cell, and this many px (≈ 1.5 mm at 200 DPI). */
const BLANK_MIN_FRAC = 0.3;
const BLANK_MIN_PX = 12;
/** Gap left between the caption's ink and the answer box. */
const CAPTION_GAP = 3;

/**
 * The blank part of a ruled cell (its interior `r`, px): the whole cell when
 * nothing is printed in it; else the band below the lowest printed row, or
 * right of the rightmost printed column, when that band is big enough.
 */
export function answerArea(m: Ink, r: Rect): Rect | null {
  const W = m.width;
  const x0 = Math.ceil(r.x) + INSET;
  const x1 = Math.floor(r.x + r.w) - INSET;
  const y0 = Math.ceil(r.y) + INSET;
  const y1 = Math.floor(r.y + r.h) - INSET;
  if (x1 <= x0 || y1 <= y0) return null;
  let lastRow = -1;
  let lastCol = -1;
  for (let y = y0; y < y1; y++) {
    let n = 0;
    for (let x = x0; x < x1; x++) {
      if (m.data[y * W + x]) {
        n++;
        if (x > lastCol) lastCol = x;
      }
    }
    if (n >= 2) lastRow = y;
  }
  if (lastRow < 0) return r;
  const bottom = r.y + r.h;
  const below = bottom - (lastRow + 1 + CAPTION_GAP);
  if (below >= Math.max(BLANK_MIN_PX, BLANK_MIN_FRAC * r.h)) {
    return { x: r.x, y: lastRow + 1 + CAPTION_GAP, w: r.w, h: below };
  }
  const right = r.x + r.w;
  const after = right - (lastCol + 1 + CAPTION_GAP);
  if (after >= Math.max(BLANK_MIN_PX, BLANK_MIN_FRAC * r.w)) {
    return { x: lastCol + 1 + CAPTION_GAP, y: r.y, w: after, h: r.h };
  }
  return null;
}

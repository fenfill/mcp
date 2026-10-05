// The package's own rule finder (src/rules.ts), on synthetic ink masks shaped
// like the cases the real-PDF comparison against the editor's wand turned up.

import { describe, expect, it } from "vitest";

import { answerArea, cellAt, findRules, type Ink, inkMask, underlineFor } from "../src/rules.js";

function canvas(w: number, h: number) {
  const m: Ink = { width: w, height: h, data: new Uint8Array(w * h) };
  const fill = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m.data[y * w + x] = 1;
  };
  return { m, fill };
}

/** A ruled box: interior (x0+t … x1-t, y0+t … y1-t). */
function box(
  fill: (a: number, b: number, c: number, d: number) => void,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  t = 3,
) {
  fill(x0, y0, x1, y0 + t - 1);
  fill(x0, y1 - t + 1, x1, y1);
  fill(x0, y0, x0 + t - 1, y1);
  fill(x1 - t + 1, y0, x1, y1);
}

describe("rules.ts", () => {
  it("inkMask reads ink against the page's own paper tone", () => {
    const rgba = new Uint8Array(4 * 100).fill(235); // a tinted scan's paper
    for (let i = 0; i < 4; i++) rgba.fill(150, i * 4, i * 4 + 3); // 4 dark px
    const ink = inkMask(rgba, 100, 1);
    expect([...ink.data].reduce((a, b) => a + b, 0)).toBe(4);
  });

  it("finds a ruled cell, even with a caption stroke touching its wall", () => {
    const { m, fill } = canvas(400, 200);
    box(fill, 50, 40, 350, 140);
    fill(53, 60, 56, 75); // a "1." stroke against the left wall
    const r = findRules(m);
    expect(cellAt(r, 200, 100)).toEqual({ x: 53, y: 43, w: 295, h: 95 });
  });

  it("joins a slightly rotated (scanned) rule's steps into one", () => {
    const { m, fill } = canvas(600, 200);
    // Top rule stepping down 1 px every 100 px; the other sides straight.
    for (let k = 0; k < 5; k++) fill(50 + k * 100, 40 + k, 149 + k * 100, 42 + k);
    fill(50, 150, 549, 152);
    fill(50, 40, 52, 152);
    fill(547, 40, 549, 152);
    const r = findRules(m);
    expect(r.h.filter((h) => h.y0 < 60)).toHaveLength(1);
    expect(cellAt(r, 300, 100)).not.toBeNull();
  });

  it("takes dotted leaders (4 px dots, 7 px gaps) and fits a line-height box on them", () => {
    const { m, fill } = canvas(600, 300);
    for (let x = 100; x < 400; x += 11) fill(x, 200, x + 3, 201);
    const r = findRules(m);
    const f = underlineFor(r, { x: 120, y: 170, w: 200, h: 30 });
    expect(f).not.toBeNull();
    expect(f!.y + f!.h).toBe(200); // sits on the dots
    expect(f!.h).toBe(45); // clear above: capped at a line of handwriting
    expect(f!.x).toBe(100);
  });

  it("doesn't take a line of text for a rule", () => {
    const { m, fill } = canvas(600, 100);
    // Letters: 12 px tall strokes and bars with small gaps along a word.
    for (let x = 100; x < 400; x += 9) {
      fill(x, 40, x + 1, 52);
      fill(x, 40, x + 5, 41);
      fill(x, 46, x + 4, 47);
    }
    const r = findRules(m);
    expect(r.h).toEqual([]);
  });

  it("clips an underline to the cell walls crossing a long table rule", () => {
    const { m, fill } = canvas(600, 300);
    fill(20, 200, 580, 202); // table rule
    fill(300, 120, 302, 202); // a column wall crossing it from above
    const f = underlineFor(findRules(m), { x: 320, y: 170, w: 100, h: 30 });
    expect(f!.x).toBe(303);
    expect(f!.x + f!.w - 1).toBe(580);
  });

  it("answerArea: the band below a caption, or after a left hint", () => {
    const { m, fill } = canvas(400, 200);
    fill(60, 50, 120, 58); // caption at the cell's top
    expect(answerArea(m, { x: 55, y: 45, w: 290, h: 90 })).toEqual({
      x: 55,
      y: 62,
      w: 290,
      h: 73,
    });
    const { m: m2, fill: f2 } = canvas(400, 100);
    f2(60, 40, 100, 50); // a hint at the left, mid-height
    expect(answerArea(m2, { x: 55, y: 35, w: 300, h: 22 })).toEqual({
      x: 104,
      y: 35,
      w: 251,
      h: 22,
    });
  });
});

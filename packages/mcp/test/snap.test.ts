// snap on a real PDFium render: a ruled cell and an open underline drawn with
// pdf-lib, found from a rough box the way an agent would place one.

import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { applyOps } from "../src/edits.js";
import { placementWarnings } from "../src/placement.js";
import { prepareSnapper, snapPages } from "../src/snap.js";
import type { RenderSchema } from "../src/types.js";

const W = 595;
const H = 842;

async function ruledPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const p = doc.addPage([W, H]);
  // An open underline, top-left y = 300 pt, x 100–400.
  p.drawLine({ start: { x: 100, y: H - 300 }, end: { x: 400, y: H - 300 }, thickness: 1 });
  // A ruled cell, top-left (100, 500), 200 × 30 pt.
  p.drawRectangle({
    x: 100,
    y: H - 530,
    width: 200,
    height: 30,
    borderColor: rgb(0, 0, 0),
    borderWidth: 1,
  });
  return doc.save();
}

const schema = (): RenderSchema =>
  ({
    version: 5,
    pages: [{ page: 1, width: 1240, height: 1754, image: "https://example.invalid/p.png" }],
    fields: [],
    groups: [],
  }) as unknown as RenderSchema;

// A ruled cell with its caption printed at the top (Schengen style), and one
// with a grey hint at its left (PAYE Postcode style).
async function captionedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([W, H]);
  const cell = (x: number, y: number, w: number, h: number) =>
    p.drawRectangle({
      x,
      y: H - y - h,
      width: w,
      height: h,
      borderColor: rgb(0, 0, 0),
      borderWidth: 1,
    });
  cell(100, 600, 200, 40);
  p.drawText("6. Place of birth", { x: 104, y: H - 611, size: 8, font });
  cell(100, 700, 300, 20);
  p.drawText("Postcode", { x: 104, y: H - 714, size: 8, font });
  return doc.save();
}

describe("snap (PDFium render + the editor's wand)", () => {
  it("answer: the blank part of a cell, below a caption or after a hint", async () => {
    const snap = await prepareSnapper(await captionedPdf(), [1]);
    const below = snap(1, { x: 110 / W, y: 605 / H, w: 150 / W, h: 25 / H }, "answer");
    expect("box" in below).toBe(true);
    if ("box" in below) {
      expect(below.box.y * H).toBeGreaterThan(612); // under the caption's ink
      expect((below.box.y + below.box.h) * H).toBeGreaterThan(636);
      expect((below.box.y + below.box.h) * H).toBeLessThan(641);
      expect(below.box.w * W).toBeGreaterThan(190); // the cell's full width
    }
    const after = snap(1, { x: 110 / W, y: 703 / H, w: 250 / W, h: 14 / H }, "answer");
    expect("box" in after).toBe(true);
    if ("box" in after) {
      expect(after.box.x * W).toBeGreaterThan(135); // right of "Postcode"
      expect((after.box.x + after.box.w) * W).toBeGreaterThan(396);
    }
    // "cell" still takes the whole cell, caption included.
    const whole = snap(1, { x: 110 / W, y: 605 / H, w: 150 / W, h: 25 / H }, "cell");
    if ("box" in whole) expect(whole.box.y * H).toBeLessThan(604);
  });

  it("warns when a box pokes a little past its ruled cell, not when it sits inside", async () => {
    const pdf = await ruledPdf();
    const s = schema();
    const box = (id: string, y: number) => ({
      id,
      label: id,
      type: "text",
      format: { variant: "any" },
      page: 1,
      section_id: null,
      xpct: (110 / W) * 100,
      ypct: (y / H) * 100,
      wpct: (150 / W) * 100,
      hpct: (20 / H) * 100,
      group: null,
    });
    s.fields = [box("high", 496), box("inside", 504)] as unknown as RenderSchema["fields"];
    const w = await placementWarnings(pdf, s, ["high", "inside"], { cells: true });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^high: the box runs 0\.00\d above its ruled cell/);
  });

  it("fits a rough box into the ruled cell around it and onto the underline under it", async () => {
    const snap = await prepareSnapper(await ruledPdf(), [1]);
    const cell = snap(1, { x: 120 / W, y: 505 / H, w: 120 / W, h: 15 / H }, "cell");
    expect("box" in cell).toBe(true);
    if ("box" in cell) {
      expect(cell.box.x * W).toBeGreaterThan(98);
      expect(cell.box.x * W).toBeLessThan(104);
      expect((cell.box.x + cell.box.w) * W).toBeGreaterThan(296);
      expect(cell.box.y * H).toBeGreaterThan(498);
      expect((cell.box.y + cell.box.h) * H).toBeLessThan(532);
    }
    const line = snap(1, { x: 150 / W, y: 285 / H, w: 100 / W, h: 12 / H }, "underline");
    expect("box" in line).toBe(true);
    if ("box" in line) {
      // The field sits on the rule and spans it.
      expect((line.box.y + line.box.h) * H).toBeGreaterThan(296);
      expect((line.box.y + line.box.h) * H).toBeLessThan(304);
      expect(line.box.x * W).toBeLessThan(110);
      expect((line.box.x + line.box.w) * W).toBeGreaterThan(390);
    }
  });

  it("finds nothing on blank paper, and the op keeps its box with a warning", async () => {
    const snap = await prepareSnapper(await ruledPdf(), [1]);
    const r = applyOps(
      schema(),
      [
        {
          op: "add",
          page: 1,
          type: "text",
          box: { x: 0.5, y: 0.9, w: 0.2, h: 0.02 },
          label: "x",
          snap: "underline",
        },
      ],
      undefined,
      { snap },
    );
    expect(r.applied).toBe(1);
    expect(r.warnings.join(" ")).toMatch(/no underline under the box; the box was kept/);
    expect(r.render.fields[0].ypct).toBeCloseTo(90);
  });

  it("lists the pages a batch snaps on", () => {
    expect(
      snapPages(
        [
          { op: "add", page: 2, snap: "cell" },
          { op: "move", id: "f1", snap: "underline" },
          { op: "move", id: "f2" },
        ],
        (id) => (id === "f1" ? 3 : 1),
      ).sort(),
    ).toEqual([2, 3]);
  });
});

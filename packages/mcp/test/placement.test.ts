// Placement warnings on a real PDF: a box over a printed caption, and a box
// whose Auto text would print much larger than the page's other fields.

import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { placementWarnings } from "../src/placement.js";
import type { RenderSchema } from "../src/types.js";

const H = 842;

async function captionPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([595, H]);
  // "Postcode" at top-left (100, 200) pt, 10 pt tall.
  p.drawText("Postcode", { x: 100, y: H - 208, size: 10, font });
  // A typed blank: underscores and a dot leader are the line, not a caption.
  p.drawText("______________ ..........", { x: 100, y: H - 308, size: 10, font });
  return doc.save();
}

const f = (id: string, x: number, y: number, h: number, over: Record<string, unknown> = {}) => ({
  id,
  label: id,
  type: "text",
  format: { variant: "any" },
  page: 1,
  section_id: null,
  xpct: x,
  ypct: y,
  wpct: 20,
  hpct: h,
  group: null,
  ...over,
});

const render = (fields: unknown[]): RenderSchema =>
  ({
    version: 5,
    pages: [{ page: 1, width: 1240, height: 1754, image: "https://example.invalid/p.png" }],
    fields,
    groups: [],
  }) as unknown as RenderSchema;

describe("placementWarnings", () => {
  const typical = [f("n1", 60, 50, 1.5), f("n2", 60, 55, 1.5), f("n3", 60, 60, 1.5)];

  it("warns about a box over printed text, only for the touched ids", async () => {
    // 100/595 = 16.8%, 200/842 = 23.8%
    const over = f("over", 15, 23, 2);
    const clear = f("clear", 15, 40, 1.5);
    const typed = f("typed", 16, 35.5, 1.5); // over the "____ ....." blank at y ≈ 300 pt
    const s = render([...typical, over, clear, typed]);
    const w = await placementWarnings(await captionPdf(), s, ["over", "clear", "typed"]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^over: the box covers \d+ printed characters/);
    expect(await placementWarnings(await captionPdf(), s, ["n1"])).toEqual([]);
  });

  it("warns when an Auto box is much taller than its neighbours, or font_size is pinned large", async () => {
    const tall = f("tall", 15, 70, 3.5); // ~29.5 pt box → 14 pt vs ~9 pt
    const big = f("big", 15, 80, 1.5, { format: { variant: "any", font_size: 20 } });
    const ok = f("ok", 15, 85, 1.6);
    const s = render([...typical, tall, big, ok]);
    const w = await placementWarnings(await captionPdf(), s, ["tall", "big", "ok"]);
    expect(w.map((x) => x.split(":")[0]).sort()).toEqual(["big", "tall"]);
    expect(w.join(" ")).toMatch(/follows its height/);
    expect(w.join(" ")).toMatch(/clear font_size/);
  });

  it("pageWide checks every box against all its peers (preview_page)", async () => {
    const over = f("over", 15, 23, 2);
    const tall = f("tall", 15, 70, 3.5);
    const s = render([...typical, over, tall]);
    const all = ["n1", "n2", "n3", "over", "tall"];
    // Edit mode: checking every id leaves no untouched peers, so no size warning.
    const edit = await placementWarnings(await captionPdf(), s, all);
    expect(edit.map((x) => x.split(":")[0])).toEqual(["over"]);
    const page = await placementWarnings(await captionPdf(), s, all, { pageWide: true });
    expect(page.map((x) => x.split(":")[0]).sort()).toEqual(["over", "tall"]);
  });
});

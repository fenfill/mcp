// Placement warnings on a real PDF: a box over a printed caption, and a box
// whose Auto text would print much larger than the page's other fields; a pale
// hint under a box is a note instead.

import {
  degrees,
  PDFDocument,
  PDFName,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setTextRenderingMode,
  StandardFonts,
  TextRenderingMode,
} from "pdf-lib";
import { describe, expect, it } from "vitest";

import { placementReport, placementWarnings } from "../src/placement.js";
import { pageText, printedBoxes, renderPage } from "../src/render.js";
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

describe("pale hints", () => {
  // HMRC CH2 prints its in-box hints in a pale teal, rgb(128, 201, 197).
  const TEAL = rgb(128 / 255, 201 / 255, 197 / 255);
  async function hintPdf(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage([595, H]);
    // At the left edge of the box drawn at x 100 pt (16.8%), y 200 pt (23.75%).
    p.drawText("First name", { x: 103, y: H - 212, size: 10, font, color: TEAL });
    // The same pale colour, but part-way along the row: a caption (ruling R).
    p.drawText("Postcode", { x: 230, y: H - 312, size: 10, font, color: TEAL });
    // A black caption at the left edge.
    p.drawText("Surname", { x: 103, y: H - 412, size: 10, font });
    // Invisible text (an OCR layer): never a caption, never a hint.
    p.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible));
    p.drawText("Hidden words", { x: 103, y: H - 512, size: 10, font });
    p.pushOperators(popGraphicsState());
    return doc.save();
  }
  // Boxes 40% wide (238 pt) from x 100 pt, 2.4% (20 pt) tall, over each line.
  const box = (id: string, yPt: number) => f(id, 16.8, (yPt / H) * 100, 2.4, { wpct: 40 });

  it("notes a pale hint at the box's left edge instead of warning", async () => {
    const s = render([box("hint", 200)]);
    const r = await placementReport(await hintPdf(), s, ["hint"]);
    expect(r.warnings).toEqual([]);
    expect(r.notes).toEqual([
      'hint: the box covers the pale hint "First name" printed at its left edge; a hint is written over, so this is no misplacement',
    ]);
  });

  it("still warns, quoting it, about a pale caption part-way along the row", async () => {
    const s = render([box("mid", 300)]);
    const r = await placementReport(await hintPdf(), s, ["mid"]);
    expect(r.notes).toEqual([]);
    expect(r.warnings).toEqual([
      'mid: the box covers 8 printed characters ("Postcode"), so the value would print over them; move or shrink it onto the blank (snap can help)',
    ]);
  });

  it("still warns about a black caption at the left edge", async () => {
    const s = render([box("dark", 400)]);
    const w = await placementWarnings(await hintPdf(), s, ["dark"]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^dark: the box covers 7 printed characters \("Surname"\)/);
  });

  it("counts invisible text (an OCR layer over a scan) as the print it stands for", async () => {
    const s = render([box("ocr", 500)]);
    const w = await placementWarnings(await hintPdf(), s, ["ocr"]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^ocr: the box covers 11 printed characters \("Hidden words"\)/);
  });
});

describe("option boxes (rule W) and signatures", () => {
  // Schengen Q10 in miniature: tick boxes printed before their captions, four
  // options on line 1; Widow(er) starts line 2 at the cell's edge, so its box
  // belongs at the end of line 1 (the founder's rule W), after "Divorced".
  const W = 596;
  async function q10(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage([W, H]);
    const line1 = H - 308; // baseline: glyphs span top-left y ≈ 300–308
    const line2 = H - 322;
    for (const [text, x] of [
      ["Single", 112],
      ["Married", 172],
      ["Separated", 242],
      ["Divorced", 322],
    ] as const) {
      p.drawText(text, { x, y: line1, size: 10, font });
    }
    p.drawText("Widow(er)", { x: 98, y: line2, size: 10, font });
    p.drawText("Other", { x: 168, y: line2, size: 10, font });
    // A caption printed over a signature line, and one under a column of boxes.
    p.drawText("Signature of the applicant", { x: 100, y: H - 408, size: 10, font });
    for (const [text, x] of [
      ["Owner", 100],
      ["Tenant", 160],
      ["Lodger", 220],
    ] as const) {
      p.drawText(text, { x, y: H - 522, size: 8, font });
    }
    return doc.save();
  }
  const opt = (id: string, xPt: number, yPt: number, group: string) =>
    f(id, (xPt / W) * 100, (yPt / H) * 100, (8 / H) * 100, {
      type: "checkbox",
      wpct: (8 / W) * 100,
      label: id,
      group,
      format: {},
    });
  const civil = (widowAt: [number, number]) => {
    const fields = [
      { ...opt("single", 100, 300, "g"), label: "Single" },
      { ...opt("married", 160, 300, "g"), label: "Married" },
      { ...opt("separated", 230, 300, "g"), label: "Separated" },
      { ...opt("divorced", 310, 300, "g"), label: "Divorced" },
      { ...opt("widow", widowAt[0], widowAt[1], "g"), label: "Widow(er)" },
      { ...opt("other", 156, 314, "g"), label: "Other" },
    ];
    return {
      version: 5,
      pages: [{ page: 1, width: W, height: H, image: "https://example.invalid/p.png" }],
      fields,
      groups: [
        {
          id: "g",
          kind: "choice",
          format: "single",
          label: "Marital status",
          page: 1,
          members: fields.map((x) => x.id),
        },
      ],
    } as unknown as RenderSchema;
  };

  it("passes a box in rule W's slot: the end of the line above its caption", async () => {
    const s = civil([370, 300]);
    expect(await placementWarnings(await q10(), s, ["g"], { pageWide: true })).toEqual([]);
  });

  it("warns about a box after its own caption, beside another option's", async () => {
    // The gold's Widow(er) box: right after "Widow(er)", just before "Other".
    const s = civil([144, 314]);
    const w = await placementWarnings(await q10(), s, ["widow"]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^widow: its box is after its caption "Widow\(er\)" in reading order/);
    expect(w[0]).toMatch(/the printed text after its box is "Other", the caption of option other/);
  });

  it("gives a printed caption to one option only: the nearest", async () => {
    // "Other" and "Other (specify)" both start "Other"; the second's own words
    // are not in the text layer. It once claimed the first's caption, read as
    // after it, and was warned about though placed right.
    const s = civil([370, 300]);
    s.fields.push({ ...opt("specify", 210, 314, "g"), label: "Other (specify)" } as never);
    (s.groups[0] as { members: string[] }).members.push("specify");
    expect(await placementWarnings(await q10(), s, ["g"], { pageWide: true })).toEqual([]);
  });

  it("does not judge a question whose boxes split evenly between the sides (a Yes/No)", async () => {
    // Known limit: the swap below goes unflagged. Judging ties flagged 6 of the
    // 28 accepted loop templates falsely, through neighbouring Yes/No captions.
    const yesNo = (yes: number, no: number) => {
      const boxes = [
        { ...opt("yes", yes, 300, "q"), label: "Single" },
        { ...opt("no", no, 300, "q"), label: "Married" },
      ];
      return {
        ...civil([370, 300]),
        fields: boxes,
        groups: [
          {
            id: "q",
            kind: "choice",
            format: "single",
            label: "Q",
            page: 1,
            members: ["yes", "no"],
          },
        ],
      } as unknown as RenderSchema;
    };
    const pdf = await q10();
    expect(await placementWarnings(pdf, yesNo(100, 160), ["q"])).toEqual([]);
    expect(await placementWarnings(pdf, yesNo(160, 100), ["q"])).toEqual([]);
  });

  it("reads a question whose captions are printed under its boxes by column", async () => {
    const boxes = [
      { ...opt("owner", 100, 500, "h"), label: "Owner" },
      { ...opt("tenant", 160, 500, "h"), label: "Tenant" },
      { ...opt("lodger", 220, 500, "h"), label: "Lodger" },
    ];
    const s = {
      ...civil([370, 300]),
      fields: boxes,
      groups: [
        {
          id: "h",
          kind: "choice",
          format: "single",
          label: "Housing",
          page: 1,
          members: boxes.map((b) => b.id),
        },
      ],
    } as unknown as RenderSchema;
    expect(await placementWarnings(await q10(), s, ["h"])).toEqual([]);
  });

  it("checks a signature box for printed text under it", async () => {
    const s = {
      ...civil([370, 300]),
      fields: [f("sig", (95 / W) * 100, (398 / H) * 100, 2.4, { type: "signature", format: {} })],
      groups: [],
    } as unknown as RenderSchema;
    const w = await placementWarnings(await q10(), s, ["sig"]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^sig: the box covers \d+ printed characters \("Signature of the app/);
  });
});

describe("the text layer on a rotated or cropped page", () => {
  /** The box of the dark pixels of page 1 as rendered, fractions of the page. */
  const inked = async (pdf: Uint8Array) => {
    const r = await renderPage(pdf, 1, 72);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let y = 0; y < r.height; y++) {
      for (let x = 0; x < r.width; x++) {
        if (r.rgba[(y * r.width + x) * 4] > 128) continue;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x + 1);
        y1 = Math.max(y1, y + 1);
      }
    }
    return { x: x0 / r.width, y: y0 / r.height, w: (x1 - x0) / r.width, h: (y1 - y0) / r.height };
  };
  /** The box of every glyph pageText reads off page 1. */
  const glyphed = async (pdf: Uint8Array) => {
    const g = (await pageText(pdf, 1)).glyphs;
    const x0 = Math.min(...g.map((r) => r.x));
    const y0 = Math.min(...g.map((r) => r.y));
    return {
      x: x0,
      y: y0,
      w: Math.max(...g.map((r) => r.x + r.w)) - x0,
      h: Math.max(...g.map((r) => r.y + r.h)) - y0,
    };
  };
  const near = (a: { x: number; y: number; w: number; h: number }, b: typeof a) => {
    // Glyph boxes run a little past the ink (side bearings, ascent): 2% of the page.
    for (const k of ["x", "y", "w", "h"] as const) expect(Math.abs(a[k] - b[k])).toBeLessThan(0.02);
  };

  it("puts a glyph where the page shows it when the page is rotated", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 300]);
    page.drawText("CAPTION", { x: 40, y: 220, size: 24, font, color: rgb(0, 0, 0) });
    page.setRotation(degrees(90));
    const pdf = await doc.save();
    near(await glyphed(pdf), await inked(pdf));
    // The check copy draws in the page's own frame (pdf-lib, unrotated): its
    // tags keep off the print there, at 40 pt from the left of the 400 pt width.
    const drawn = (await printedBoxes(pdf, [1]))[1];
    expect(drawn[0].x).toBeGreaterThan(39);
    expect(drawn[0].x).toBeLessThan(42);
    expect(drawn[0].y).toBeGreaterThan(210); // the baseline at 220, less the descent
  });

  it("gives the check copy the shown glyphs in page points on a plain page", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([400, 300]).drawText("CAPTION", { x: 40, y: 220, size: 24, font });
    const pdf = await doc.save();
    const t = await pageText(pdf, 1);
    const drawn = (await printedBoxes(pdf, [1]))[1];
    t.glyphs.forEach((g, i) => {
      expect(drawn[i].x / 400).toBeCloseTo(g.x, 3);
      expect(1 - (drawn[i].y + drawn[i].h) / 300).toBeCloseTo(g.y, 3);
      expect(drawn[i].w / 400).toBeCloseTo(g.w, 3);
      expect(drawn[i].h / 300).toBeCloseTo(g.h, 3);
    });
  });

  it("gives the check copy page points on a page whose MediaBox is inherited", async () => {
    // PDFium's own MediaBox call reads only the page's dictionary: a rotated
    // page whose box sits on its parent was once scaled by the shown size.
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 300]);
    page.drawText("CAPTION", { x: 40, y: 220, size: 24, font });
    page.setRotation(degrees(90));
    const box = page.node.get(PDFName.of("MediaBox"))!;
    page.node.delete(PDFName.of("MediaBox"));
    doc.catalog.Pages().set(PDFName.of("MediaBox"), box);
    const pdf = await doc.save();
    const drawn = (await printedBoxes(pdf, [1]))[1];
    expect(drawn[0].x).toBeGreaterThan(39);
    expect(drawn[0].x).toBeLessThan(42);
    near(await glyphed(pdf), await inked(pdf));
  });

  it("puts a glyph where the page shows it when the crop box does not start at 0,0", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([500, 500]);
    page.drawText("CAPTION", { x: 120, y: 300, size: 24, font, color: rgb(0, 0, 0) });
    page.setCropBox(80, 100, 300, 300);
    const pdf = await doc.save();
    near(await glyphed(pdf), await inked(pdf));
  });

  it("reads a document's pages once: every page from one load, each page once per bytes", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const y of [100, 200, 300])
      doc.addPage([400, 400]).drawText("CAPTION", { x: 40, y, font });
    const pdf = await doc.save();
    const boxes = await printedBoxes(pdf, [1, 2, 3, 9]);
    expect(Object.keys(boxes)).toEqual(["1", "2", "3"]); // page 9 is not in the PDF
    const t = await pageText(pdf, 2); // read by printedBoxes, kept for pageText
    expect(t.own).toHaveLength(boxes[2].length);
    expect(await pageText(pdf, 2)).toBe(t);
    // Other bytes, same content: read again.
    expect(await pageText(pdf.slice(), 2)).not.toBe(t);
  });
});

// The check copy (fillAgentPdf with `check`, and preview_page on top of it): its
// page-1 banner (fill_form's check PDF keeps it, preview_page drops it — its
// JSON already carries the colour key), a table's headers in any script, and
// what a build that fails reports.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

import { PDFPage } from "pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { extractStampedText } from "@/e2e/helpers/pdfText";

import { agentEntries, fillAgentPdf, normalizeSchema } from "@/app/t/[template_id]/fillCore";

import { Cache } from "../src/cache.js";
import { applyOps } from "../src/edits.js";
import { ToolError } from "../src/errors.js";
import { loadImage, stampAndWrite } from "../src/fill.js";
import { loadFonts, toArrayBuffer } from "../src/fonts.js";
import { PREVIEW_MAX_SIDE_PX, previewPage } from "../src/preview.js";
import { pageText, printedBoxes } from "../src/render.js";
import type { RenderSchema } from "../src/types.js";
import { fixture, pdfFor, tmp } from "./helpers.js";

/** Page 1's text layer as PDFium reads it (what preview_page renders), one
 *  character per glyph. pageText skips whitespace. */
async function page1Chars(pdf: Uint8Array): Promise<string[]> {
  return (await pageText(pdf, 1)).glyphs.map((g) => g.char);
}

/** Whether page 1 prints `text` (whitespace ignored). Headers are drawn in an
 *  embedded face, so the content stream holds glyph ids, not the characters. */
async function page1Has(pdf: Uint8Array, text: string): Promise<boolean> {
  return (await page1Chars(pdf)).join("").includes(text.replace(/\s+/g, ""));
}

const isPng = (b: Uint8Array) =>
  Buffer.from(b.subarray(0, 8)).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );

/** fillAgentPdf with `check`, no values and no banner, as preview_page calls it. */
const checked = async (render: RenderSchema, pdf?: Uint8Array) =>
  fillAgentPdf({
    pdfBytes: toArrayBuffer(pdf ?? (await pdfFor(render))),
    render,
    input: {},
    fonts: loadFonts(),
    branding: null,
    logoBytes: null,
    loadImage,
    check: true,
    checkBanner: false,
  });

const preview = (render: RenderSchema, pdf: Uint8Array, page: number) =>
  previewPage({ pdfBytes: pdf, render, page, values: {}, fonts: loadFonts() });

/** How many colour samples of a preview PNG are not white (render.ts encodePng:
 *  8-bit RGB, one IDAT, filter 0 on every row). */
function ink(png: Uint8Array): number {
  const view = Buffer.from(png);
  const width = view.readUInt32BE(16);
  const height = view.readUInt32BE(20);
  const raw = inflateSync(view.subarray(41, 41 + view.readUInt32BE(33)));
  const stride = width * 3 + 1;
  let n = 0;
  for (let y = 0; y < height; y++) {
    for (let i = y * stride + 1; i < (y + 1) * stride; i++) if (raw[i] !== 255) n++;
  }
  return n;
}

/** Holds ł ą ę ż ź ć ń ó ś: of the nine, only ó is in WinAnsi. */
const POLISH = "Zażółć gęślą jaźń";
const TABLE = "391f4376-9964-5238-bb76-582e8a0772f7";

describe("check copy banner", () => {
  it("is on page 1 by default and gone with checkBanner: false", async () => {
    const { render } = fixture("classic_tables");
    const pdf = await pdfFor(render);
    const run = (checkBanner?: boolean) =>
      fillAgentPdf({
        pdfBytes: toArrayBuffer(pdf),
        render,
        input: {},
        fonts: loadFonts(),
        branding: null,
        logoBytes: null,
        loadImage,
        check: true,
        checkBanner,
      });
    const on = await run();
    const off = await run(false);
    expect(await page1Has(on.checkPdf!, "fenfill check copy")).toBe(true);
    expect(await page1Has(off.checkPdf!, "fenfill check copy")).toBe(false);
    // Tags are still drawn (the table's group tag, a short id prefix).
    expect(await page1Has(off.checkPdf!, "391f43")).toBe(true);
  });
});

describe("preview overlay", () => {
  /** classic_tables with a row and a column header, as a blank PDF. */
  const headed = async () => {
    const r = applyOps(fixture("classic_tables").render, [
      { op: "set_headers", id: TABLE, axis: "row", texts: ["Alpha"] },
      { op: "set_headers", id: TABLE, axis: "col", texts: ["Beta"] },
    ]);
    expect(r.rejected).toEqual([]);
    return { render: r.render, pdf: await pdfFor(r.render) };
  };
  const shot = (render: RenderSchema, pdf: Uint8Array, overlay?: "full" | "outline" | "none") =>
    previewPage({
      pdfBytes: pdf,
      render,
      page: 1,
      values: {},
      fonts: loadFonts(),
      dpi: 72,
      overlay,
    });

  it('"outline" keeps the boxes and draws no id tag and no table header', async () => {
    const { render, pdf } = await headed();
    const run = (checkTags?: boolean) =>
      fillAgentPdf({
        pdfBytes: toArrayBuffer(pdf),
        render,
        input: {},
        fonts: loadFonts(),
        branding: null,
        logoBytes: null,
        loadImage,
        check: true,
        checkBanner: false,
        checkTags,
      });
    const full = await run();
    const bare = await run(false);
    expect(await page1Has(full.checkPdf!, "391f43")).toBe(true);
    expect(await page1Has(full.checkPdf!, "R: Alpha")).toBe(true);
    // Nothing is written on the page at all: tags and headers were its only text.
    expect(await page1Chars(bare.checkPdf!)).toEqual([]);
    expect(bare.checkError).toBeUndefined();
    expect(bare.warnings).toEqual(full.warnings);

    const f = await shot(render, pdf, "full");
    const o = await shot(render, pdf, "outline");
    expect(ink(o.png)).toBeGreaterThan(0); // the outlines
    expect(ink(o.png)).toBeLessThan(ink(f.png));
    expect(o.legend).toEqual(f.legend);
    expect([o.width, o.height]).toEqual([f.width, f.height]);
  });

  it('"outline" raises no note for a header the tags would have shown as "?"', async () => {
    const r = applyOps(fixture("classic_tables").render, [
      { op: "set_headers", id: TABLE, axis: "col", texts: ["学校 School"] },
    ]);
    const pdf = await pdfFor(r.render);
    expect((await shot(r.render, pdf)).warnings.join(" ")).toMatch(/cannot draw some header/);
    expect((await shot(r.render, pdf, "outline")).warnings).toEqual([]);
  });

  it('"none" shows the page as a fill stamps it: no outline, only the values', async () => {
    const { render, pdf } = await headed();
    const f = await shot(render, pdf, "full");
    const n = await shot(render, pdf, "none");
    expect(ink(f.png)).toBeGreaterThan(0);
    expect(ink(n.png)).toBe(0); // a blank page, nothing stamped
    expect(n.legend).toEqual(f.legend);
    expect([n.width, n.height]).toEqual([f.width, f.height]);

    const cell = "ffb3a3e7-95f1-5573-8140-d59a4a2f666a";
    const stamped = await previewPage({
      pdfBytes: pdf,
      render,
      page: 1,
      values: { [TABLE]: { [cell]: "Ann" } },
      fonts: loadFonts(),
      dpi: 72,
      overlay: "none",
    });
    expect(stamped.filled).toBe(1);
    expect(ink(stamped.png)).toBeGreaterThan(0);
    expect(ink(stamped.png)).toBeLessThan(ink(f.png));
  });

  it("the default is the full overlay", async () => {
    const { render, pdf } = await headed();
    const byDefault = await shot(render, pdf);
    const full = await shot(render, pdf, "full");
    expect(Buffer.from(byDefault.png).equals(Buffer.from(full.png))).toBe(true);
  });
});

describe("check copy tags keep off the print", () => {
  // A dense option row, as on the Schengen form's question 10: each tick box
  // printed just before its caption, a line of text just above the row and one
  // just below, so a tag fits only beside a box, on the side away from its caption.
  const W = 595;
  const H = 842;
  const opt = (id: string, label: string, xpct: number) => ({
    id,
    label,
    type: "checkbox",
    page: 1,
    section_id: null,
    xpct,
    ypct: 30,
    wpct: 1.5,
    hpct: 1.1,
    group: "gq1111",
  });
  const options = [
    opt("o1aaaa", "Single", 10),
    opt("o2bbbb", "Married", 22),
    opt("o3cccc", "Divorced", 34),
  ];
  const render = {
    version: 5,
    pages: [{ page: 1, width: W, height: H, image: "", sections: [] }],
    fields: options,
    groups: [
      {
        id: "gq1111",
        kind: "choice",
        format: "single",
        label: "Civil status",
        page: 1,
        members: ["o1aaaa", "o2bbbb", "o3cccc"],
      },
    ],
  } as unknown as RenderSchema;
  const blank = async () => {
    const { PDFDocument, StandardFonts } = await import("pdf-lib");
    const doc = await PDFDocument.create();
    const page = doc.addPage([W, H]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const top = (pct: number) => H - (pct / 100) * H;
    const boxBottom = top(31.1);
    for (const f of options) {
      // The caption right after its box, on the box's line.
      page.drawText(f.label, {
        x: ((f.xpct + f.wpct) / 100) * W + 1,
        y: boxBottom + 1.5,
        size: 10,
        font,
      });
    }
    const line = "Civil status of the applicant on the date the application is made";
    page.drawText(line, { x: 0.1 * W, y: top(30) + 4, size: 10, font });
    page.drawText(line, { x: 0.1 * W, y: boxBottom - 11, size: 10, font });
    return doc.save();
  };
  /** The glyph boxes of a page in points (top-left origin). */
  const glyphs = async (pdf: Uint8Array) =>
    (await pageText(pdf, 1)).glyphs.map((g) => ({
      x: g.x * W,
      y: g.y * H,
      w: g.w * W,
      h: g.h * H,
      char: g.char,
    }));
  const meet = (
    a: { x: number; y: number; w: number; h: number },
    b: { x: number; y: number; w: number; h: number },
  ) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  it("draws every option's tag clear of the captions, the lines and the stamped tick", async () => {
    const pdf = await blank();
    const printed = await glyphs(pdf);
    const res = await fillAgentPdf({
      pdfBytes: toArrayBuffer(pdf),
      render,
      input: { gq1111: "Married" },
      fonts: loadFonts(),
      branding: null,
      logoBytes: null,
      loadImage,
      check: true,
      checkBanner: false,
      checkPrinted: await printedBoxes(pdf, [1]),
    });
    expect(res.filled).toBe(1);
    // The tags are the 5 pt text; the print is 10 pt.
    const tags = (await glyphs(res.checkPdf!)).filter((g) => g.h < 5);
    expect(tags.map((g) => g.char).join("")).toHaveLength(4 * 6); // three options + the group
    const tick = { x: 0.22 * W, y: 0.3 * H, w: 0.015 * W, h: 0.011 * H };
    for (const t of tags) {
      expect(printed.some((p) => meet(t, p))).toBe(false);
      expect(meet(t, tick)).toBe(false);
    }
  });

  it("preview_page's default overlay reads the page's print itself", async () => {
    const pdf = await blank();
    const shown = await previewPage({
      pdfBytes: pdf,
      render,
      page: 1,
      values: { gq1111: "Married" },
      fonts: loadFonts(),
      dpi: 72,
    });
    expect(isPng(shown.png)).toBe(true);
    expect(shown.filled).toBe(1);
  });
});

describe("preview legend size", () => {
  it("lists a comb's cells in a crop, not on a whole page", async () => {
    const render = fixture("canonical").render;
    const pdf = await pdfFor(render);
    const whole = await previewPage({
      pdfBytes: pdf,
      render,
      page: 1,
      values: {},
      fonts: loadFonts(),
      dpi: 72,
    });
    const comb = whole.legend.find((r) => r.id === "g-comb")!;
    expect(comb).toMatchObject({ max_length: 4, date_format: "DDMM" });
    expect(comb.comb_cells).toBeUndefined();
    const crop = await previewPage({
      pdfBytes: pdf,
      render,
      page: 1,
      values: {},
      fonts: loadFonts(),
      dpi: 72,
      crop: { x: 0, y: 0.45, w: 1, h: 0.1 },
    });
    expect(crop.legend.find((r) => r.id === "g-comb")?.comb_cells).toHaveLength(4);
  });
});

describe("preview size", () => {
  const a4 = (): RenderSchema => {
    const { render } = fixture("classic_tables");
    return { ...render, pages: render.pages.map((p) => ({ ...p, width: 595, height: 842 })) };
  };
  const shot = async (extra: Partial<Parameters<typeof previewPage>[0]>) => {
    const render = a4();
    return previewPage({
      pdfBytes: await pdfFor(render),
      render,
      page: 1,
      values: {},
      fonts: loadFonts(),
      ...extra,
    });
  };

  it("reports the dpi asked for when the image fits", async () => {
    const plain = await shot({});
    expect([plain.width, plain.height, plain.dpi]).toEqual([909, 1286, 110]);
    const crop = await shot({ dpi: 72, crop: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, zoom: 2.5 });
    expect(crop.dpi).toBe(180);
    expect([crop.width, crop.height]).toEqual([744, 1052]);
  });

  it("caps the longest side and reports the dpi it rendered at, not the one asked", async () => {
    const page = await shot({ dpi: 200 });
    expect(page.height).toBe(PREVIEW_MAX_SIDE_PX);
    expect(page.width).toBe(Math.round((595 * PREVIEW_MAX_SIDE_PX) / 842));
    expect(page.dpi).toBeCloseTo((PREVIEW_MAX_SIDE_PX / 842) * 72, 1); // about 171, not 200
    expect(page.dpi).toBeLessThan(200);

    const crop = await shot({ crop: { x: 0, y: 0.1, w: 1, h: 0.25 }, zoom: 8 });
    expect(crop.width).toBe(PREVIEW_MAX_SIDE_PX);
    expect(crop.dpi).toBeCloseTo((PREVIEW_MAX_SIDE_PX / 595) * 72, 1); // about 242, not 880
    // Sizes read off the image still convert: the region is a quarter of the page high.
    expect(crop.height / crop.width).toBeCloseTo((0.25 * 842) / 595, 2);
  });
});

describe("check copy table headers", () => {
  it("prints each table header beside its line (R: row, C: column)", async () => {
    const { render } = fixture("classic_tables");
    const gid = "391f4376-9964-5238-bb76-582e8a0772f7";
    const r = applyOps(render, [
      { op: "set_headers", id: gid, axis: "row", texts: ["Alpha"] },
      { op: "set_headers", id: gid, axis: "col", texts: ["Beta"] },
    ]);
    expect(r.rejected).toEqual([]);
    const out = await fillAgentPdf({
      pdfBytes: toArrayBuffer(await pdfFor(r.render)),
      render: r.render,
      input: {},
      fonts: loadFonts(),
      branding: null,
      logoBytes: null,
      loadImage,
      check: true,
      checkBanner: false,
    });
    expect(await page1Has(out.checkPdf!, "R: Alpha")).toBe(true);
    expect(await page1Has(out.checkPdf!, "C: Beta")).toBe(true);
  });

  it("draws headers outside WinAnsi, and every page still previews", async () => {
    // A second page with no table: one header used to fail the whole document.
    const { render: tables } = fixture("classic_tables");
    const page2 = fixture("ungrouped_fields").render.fields.filter((f) => f.page === 2);
    expect(page2.length).toBeGreaterThan(0);
    const two: RenderSchema = {
      ...tables,
      pages: [...tables.pages, { ...tables.pages[0], page: 2 }],
      fields: [...tables.fields, ...page2],
    };
    const r = applyOps(two, [
      { op: "set_headers", id: TABLE, axis: "row", texts: [`${POLISH} 1`, `${POLISH} 2`] },
      { op: "set_headers", id: TABLE, axis: "col", texts: [`${POLISH} A`, `${POLISH} B`] },
    ]);
    expect(r.rejected).toEqual([]);
    const pdf = await pdfFor(r.render);

    for (const page of [1, 2]) {
      const pv = await preview(r.render, pdf, page);
      expect(isPng(pv.png)).toBe(true);
      expect(pv.warnings).toEqual([]);
    }
    const out = await checked(r.render, pdf);
    expect(out.checkError).toBeUndefined();
    expect(out.warnings).toEqual([]);
    for (const text of [`R: ${POLISH} 1`, `R: ${POLISH} 2`, `C: ${POLISH} A`, `C: ${POLISH} B`]) {
      expect(await page1Has(out.checkPdf!, text)).toBe(true);
    }
  });

  it("previews a form whose field and option labels are outside WinAnsi", async () => {
    // Labels are never drawn (they go in the legend); they must not matter.
    const { render } = fixture("canonical");
    const options = [`${POLISH} tak`, `${POLISH} nie`];
    const r = applyOps(render, [
      { op: "relabel", id: "f-text", label: POLISH },
      { op: "set_options", id: "g-choice", options },
    ]);
    expect(r.rejected).toEqual([]);
    const pv = await preview(r.render, await pdfFor(r.render), 1);
    expect(isPng(pv.png)).toBe(true);
    // The fixture's own warning (a required field, no values), and nothing else.
    expect(pv.warnings).toEqual([`f-text: required ("${POLISH}") but left empty`]);
    expect(pv.legend.find((row) => row.id === "f-text")?.label).toBe(POLISH);
    expect(pv.legend.find((row) => row.id === "g-choice")?.options?.map((o) => o.label)).toEqual(
      options,
    );
  });

  it("puts a header with line breaks on one line, and uses the fallback face", async () => {
    // WinAnsi has no newline either, so this failed for plain English headers.
    // Hebrew is in DejaVuSans only: drawn, not replaced.
    const { render } = fixture("classic_tables");
    const r = applyOps(render, [
      { op: "set_headers", id: TABLE, axis: "col", texts: ["First\nsecond\tthird", "שלום"] },
    ]);
    expect(r.rejected).toEqual([]);
    const pdf = await pdfFor(r.render);
    const out = await checked(r.render, pdf);
    expect(out.warnings).toEqual([]);
    expect(await page1Has(out.checkPdf!, "C: First second third")).toBe(true);
    const chars = await page1Chars(out.checkPdf!);
    for (const ch of "שלום") expect(chars).toContain(ch);
    expect(chars).not.toContain("?");
    expect(isPng((await preview(r.render, pdf, 1)).png)).toBe(true);
  });

  it('shows a character neither face has as "?" and says so once per table', async () => {
    const { render } = fixture("classic_tables");
    const texts = ["学校 School", "年 Year", "Plain"];
    const r = applyOps(render, [{ op: "set_headers", id: TABLE, axis: "col", texts }]);
    expect(r.rejected).toEqual([]);
    const pdf = await pdfFor(r.render);
    const note = `${TABLE}: the check copy cannot draw some header characters (shown as "?"); the legend's header_rows / header_cols hold the full text`;

    const out = await checked(r.render, pdf);
    expect(out.checkError).toBeUndefined();
    expect(out.warnings).toEqual([note]);
    expect(await page1Has(out.checkPdf!, "C: ?? School")).toBe(true);
    expect(await page1Has(out.checkPdf!, "C: ? Year")).toBe(true);
    expect(await page1Has(out.checkPdf!, "C: Plain")).toBe(true);

    // preview_page lists the note with the page's warnings; the legend has the text.
    const pv = await preview(r.render, pdf, 1);
    expect(isPng(pv.png)).toBe(true);
    expect(pv.warnings).toEqual([note]);
    expect(pv.legend.find((row) => row.id === TABLE)?.header_cols).toEqual(texts);
  });

  it("leaves out one header that cannot be drawn, says which, and builds the rest", async () => {
    // The fixture's columns are Name, Born, School: the second one fails to draw.
    const { render } = fixture("classic_tables");
    const drawText = PDFPage.prototype.drawText;
    const spy = vi.spyOn(PDFPage.prototype, "drawText").mockImplementation(function (
      this: PDFPage,
      ...args: Parameters<PDFPage["drawText"]>
    ) {
      if (args[0].startsWith("C: Born")) throw new Error("no ink");
      drawText.apply(this, args);
    });
    try {
      const out = await checked(render);
      expect(out.checkError).toBeUndefined();
      // The header's index counts from 0, as edit_template's set_header does.
      expect(out.warnings).toEqual([
        `${TABLE}: column header 1 could not be drawn in the check copy: no ink`,
      ]);
      expect(await page1Has(out.checkPdf!, "C: Name")).toBe(true);
      expect(await page1Has(out.checkPdf!, "C: School")).toBe(true);
      expect(await page1Has(out.checkPdf!, "C: Born")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("a check copy that cannot be built", () => {
  // Every outline is a pdf-lib rectangle. With no values nothing else draws
  // one, so making it throw stops the build at its first box.
  const breakOutlines = () =>
    vi.spyOn(PDFPage.prototype, "drawRectangle").mockImplementation(() => {
      throw new Error("no rectangles today");
    });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const { render } = fixture("ungrouped_fields");
  const first = agentEntries(
    normalizeSchema(render as unknown as Parameters<typeof normalizeSchema>[0]),
  )[0].id;
  const cause = `The check copy could not be built (outline, ${first}): no rectangles today`;

  it("preview_page answers check_copy_failed with the stage and the id", async () => {
    const pdf = await pdfFor(render);
    breakOutlines();
    const err: unknown = await preview(render, pdf, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).toJSON()).toEqual({
      code: "check_copy_failed",
      message: cause,
      hint: `Fix or remove ${first} with edit_template, then preview again.`,
      stage: "outline",
      id: first,
    });
  });

  it('preview_page with overlay "none" needs no check copy, so it still renders', async () => {
    const pdf = await pdfFor(render);
    breakOutlines();
    const pv = await previewPage({
      pdfBytes: pdf,
      render,
      page: 1,
      values: {},
      fonts: loadFonts(),
      overlay: "none",
    });
    expect(isPng(pv.png)).toBe(true);
    expect(pv.legend.length).toBeGreaterThan(0);
    await expect(
      previewPage({
        pdfBytes: pdf,
        render,
        page: 1,
        values: {},
        fonts: loadFonts(),
        overlay: "outline",
      }),
    ).rejects.toMatchObject({ code: "check_copy_failed" });
  });

  it("a fill still writes its output, leaves check_path out and says why", async () => {
    const t = tmp();
    try {
      const pdf = await pdfFor(render);
      const out = join(t.dir, "filled.pdf");
      const check = join(t.dir, "filled.check.pdf");
      const nameId = render.fields.find((f) => f.label === "Full name")!.id;
      breakOutlines();
      const res = await stampAndWrite({
        pdfBytes: pdf,
        render,
        agentInput: { [nameId]: "Ada Lovelace" },
        fonts: loadFonts(),
        branding: null,
        logoBytes: null,
        outputAbs: out,
        overwrite: false,
        cache: new Cache(join(t.dir, "cache")),
        checkAbs: check,
      });
      expect(res).toMatchObject({ output_path: out, filled: 1 });
      expect(res).not.toHaveProperty("check_path");
      expect(existsSync(check)).toBe(false);
      expect(res.warnings.at(-1)).toBe(
        `No check copy was written; the filled PDF is complete. ${cause}`,
      );
      // The field prints in capitals.
      const written = new Uint8Array(readFileSync(out));
      expect((await extractStampedText(written, 0)).toLowerCase()).toContain("ada lovelace");
    } finally {
      t.cleanup();
    }
  });
});

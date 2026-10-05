// The check copy's page-1 banner: fill_form's check PDF keeps it, preview_page
// (checkBanner: false) drops it — its JSON already carries the colour key.

import { describe, expect, it } from "vitest";

import { decodePDFRawStream, PDFDocument, PDFRawStream } from "pdf-lib";

import { fillAgentPdf } from "@/app/t/[template_id]/fillCore";

import { applyOps } from "../src/edits.js";
import { loadImage } from "../src/fill.js";
import { loadFonts, toArrayBuffer } from "../src/fonts.js";
import { fixture, pdfFor } from "./helpers.js";

/** Page 1's content streams, decoded; pdf-lib writes Helvetica text as hex strings. */
async function page1Has(pdf: Uint8Array, text: string): Promise<boolean> {
  const doc = await PDFDocument.load(pdf);
  const hex = Buffer.from(text, "latin1").toString("hex").toUpperCase();
  const contents = doc.getPages()[0].node.Contents();
  const refs = contents ? ("asArray" in contents ? contents.asArray() : [contents]) : [];
  for (const r of refs) {
    const st = doc.context.lookup(r);
    if (!(st instanceof PDFRawStream)) continue;
    const body = Buffer.from(decodePDFRawStream(st).decode()).toString("latin1").toUpperCase();
    if (body.includes(hex) || body.includes(text.toUpperCase())) return true;
  }
  return false;
}

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
});

import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";

// -----------------------------------------------------------------------------
// Stamped-value oracle.
//
// The app FLATTENS filled text into the page content stream using a SUBSET
// embedded font (per-glyph run splitting, Inter/DejaVu). So the typed strings do
// NOT appear as readable ASCII in the content stream — they appear as 2-byte
// glyph indices (e.g. `<0001000200030004>`), which are meaningless without the
// font's cmap. The fixture's own Helvetica labels, by contrast, are 1-byte
// StandardEncoding and would match literally — but the stamped values will not.
//
// To assert the ACTUAL typed strings we decode the glyph indices back to text
// via each subset font's /ToUnicode CMap (fontkit embeds one). This gives a
// strong, exact-text oracle. `pdfContentStats` is the weakened fallback
// (page count + content-stream length) for cases where a decodable ToUnicode
// map isn't present.
// -----------------------------------------------------------------------------

function rawStreamToLatin1(stream: PDFRawStream): string {
  return Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1");
}

// Parse a /ToUnicode CMap body into a map of 4-hex-digit glyph code -> unicode.
function parseToUnicode(txt: string): Map<string, string> {
  const map = new Map<string, string>();
  const hx = (s: string): number => parseInt(s, 16);

  for (const blk of txt.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of blk[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const src = m[1].padStart(4, "0").toUpperCase();
      let u = "";
      for (let i = 0; i < m[2].length; i += 4) u += String.fromCharCode(hx(m[2].slice(i, i + 4)));
      map.set(src, u);
    }
  }
  for (const blk of txt.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of blk[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = hx(m[1]);
      const hi = hx(m[2]);
      let u = hx(m[3]);
      for (let c = lo; c <= hi; c++, u++) {
        map.set(c.toString(16).padStart(4, "0").toUpperCase(), String.fromCharCode(u));
      }
    }
  }
  return map;
}

function collectPageStreams(doc: PDFDocument, pageIndex: number): PDFRawStream[] {
  const ctx = doc.context;
  const contents = doc.getPage(pageIndex).node.Contents();
  const streams: PDFRawStream[] = [];
  if (contents instanceof PDFArray) {
    for (const ref of contents.asArray()) {
      const s = ctx.lookup(ref);
      if (s instanceof PDFRawStream) streams.push(s);
    }
  } else if (contents instanceof PDFRawStream) {
    streams.push(contents);
  }
  return streams;
}

// Decode the flattened text on page `pageIndex` back to readable unicode via the
// document's /ToUnicode CMaps. Returns all decoded glyph runs joined by spaces.
export async function extractStampedText(pdfBytes: Uint8Array, pageIndex = 0): Promise<string> {
  const doc = await PDFDocument.load(pdfBytes);
  const ctx = doc.context;

  const map = new Map<string, string>();
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    const tu = obj.get(PDFName.of("ToUnicode"));
    if (!tu) continue;
    const s = ctx.lookup(tu);
    if (s instanceof PDFRawStream) {
      for (const [k, v] of parseToUnicode(rawStreamToLatin1(s))) map.set(k, v);
    }
  }

  let content = "";
  for (const s of collectPageStreams(doc, pageIndex)) content += rawStreamToLatin1(s) + "\n";

  const decoded: string[] = [];
  for (const m of content.matchAll(/<([0-9A-Fa-f]{4,})>/g)) {
    const hex = m[1];
    let out = "";
    for (let i = 0; i + 4 <= hex.length; i += 4)
      out += map.get(hex.slice(i, i + 4).toUpperCase()) ?? "";
    if (out) decoded.push(out);
  }
  return decoded.join(" ");
}

// Weakened fallback oracle: page count + total decompressed content length of a
// page. A stamped page's content stream is meaningfully longer than the blank
// fixture's, which proves *something* was drawn even when ToUnicode decoding is
// unavailable.
export async function pdfContentStats(
  pdfBytes: Uint8Array,
  pageIndex = 0,
): Promise<{ pageCount: number; contentLength: number }> {
  const doc = await PDFDocument.load(pdfBytes);
  let contentLength = 0;
  for (const s of collectPageStreams(doc, pageIndex)) contentLength += rawStreamToLatin1(s).length;
  return { pageCount: doc.getPageCount(), contentLength };
}

// Pixel sizes of the image XObjects drawn on a page (e.g. a stamped signature
// PNG: pdf-lib's drawImage registers it in the page's /Resources /XObject).
export async function pageImageSizes(
  pdfBytes: Uint8Array,
  pageIndex = 0,
): Promise<{ width: number; height: number }[]> {
  const doc = await PDFDocument.load(pdfBytes);
  const xobjects = doc.getPage(pageIndex).node.Resources()?.lookup(PDFName.of("XObject"));
  if (!(xobjects instanceof PDFDict)) return [];
  const out: { width: number; height: number }[] = [];
  for (const [, ref] of xobjects.entries()) {
    const obj = doc.context.lookup(ref);
    const dict = obj instanceof PDFRawStream ? obj.dict : obj instanceof PDFDict ? obj : null;
    if (dict?.get(PDFName.of("Subtype"))?.toString() !== "/Image") continue;
    const num = (k: string) => Number(dict.get(PDFName.of(k))?.toString());
    out.push({ width: num("Width"), height: num("Height") });
  }
  return out;
}

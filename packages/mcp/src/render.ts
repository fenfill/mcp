// Page rasterizing for preview_page: PDFium compiled to WebAssembly
// (@embedpdf/pdfium, MIT; PDFium itself BSD-3/Apache-2.0), loaded lazily on the
// first preview, plus a small PNG encoder on node:zlib.
//
// No native addon, no postinstall, no network: the .wasm ships next to the
// bundle (dist/pdfium.wasm) and is handed to the loader as bytes, so the
// loader's CDN default is never used. The PDF and the pixels stay in this
// process's memory; nothing is written to disk.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import { ToolError } from "./errors.js";

export const DEFAULT_DPI = 110;
export const MAX_DPI = 200;
export const MIN_DPI = 36;
/** Longest rendered side, whatever the page size and dpi. */
export const MAX_SIDE_PX = 3000;

type Pdfium = Awaited<ReturnType<typeof import("@embedpdf/pdfium").init>>;

let loading: Promise<Pdfium> | null = null;

/** dist/pdfium.wasm next to the bundle; from the sources, the package's copy. */
export function wasmPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = join(here, "pdfium.wasm");
  if (existsSync(bundled)) return bundled;
  const req = createRequire(import.meta.url);
  return req.resolve("@embedpdf/pdfium/pdfium.wasm");
}

async function loadPdfium(): Promise<Pdfium> {
  let wasm: Buffer;
  try {
    wasm = readFileSync(wasmPath());
  } catch {
    throw new ToolError("renderer_missing", "The page renderer (pdfium.wasm) could not be read.", {
      hint: "Reinstall @fenfill/mcp (npx -y @fenfill/mcp@latest). fill_form's check_pdf still works without it.",
    });
  }
  const { init } = await import("@embedpdf/pdfium");
  const quiet = () => undefined;
  const mod = await init({
    wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
    // The loader would print to stdout, which is the JSON-RPC channel.
    print: quiet,
    printErr: quiet,
  } as Parameters<typeof init>[0]);
  mod.PDFiumExt_Init();
  return mod;
}

/** The shared PDFium instance (created on first use, then reused). */
export function pdfium(): Promise<Pdfium> {
  loading ??= loadPdfium().catch((e: unknown) => {
    loading = null;
    throw e;
  });
  return loading;
}

const FPDF_ANNOT = 0x01;
const FPDF_REVERSE_BYTE_ORDER = 0x10; // RGBA instead of BGRA

export interface Raster {
  width: number;
  height: number;
  /** RGBA, `width * 4` bytes per row. */
  rgba: Uint8Array;
}

/** A rendered page: its pixels and the scale they were drawn at. */
export interface Rendered extends Raster {
  /** Pixels per PDF point as rendered: the dpi asked for / 72, or less when
   *  the longest side hit the cap. */
  scale: number;
}

/** A region of the page in fractions, top-left origin. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A box in a page's own user space, in points, bottom-left origin. */
export interface PointBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Module = Pdfium;

type Heap = () => Uint8Array;

/** Open an in-memory PDF, run `fn` with it, and free everything. */
async function withDoc<T>(
  pdf: Uint8Array,
  fn: (m: Module, doc: number, heap: Heap) => T | Promise<T>,
): Promise<T> {
  const m = await pdfium();
  const p = m.pdfium;
  // The Emscripten heap view (typed loosely upstream); re-read after every
  // call that may grow memory.
  const heap = () => (p as unknown as { HEAPU8: Uint8Array }).HEAPU8;
  const ptr = p.wasmExports.malloc(pdf.length);
  if (!ptr) throw new ToolError("render_failed", "Not enough memory to render this page.");
  let doc = 0;
  try {
    heap().set(pdf, ptr);
    doc = m.FPDF_LoadMemDocument(ptr, pdf.length, "");
    if (!doc) {
      throw new ToolError("render_failed", "The page renderer couldn't open this PDF.", {
        hint: "Use fill_form with check_pdf instead and open the .check.pdf.",
      });
    }
    return await fn(m, doc, heap);
  } finally {
    if (doc) m.FPDF_CloseDocument(doc);
    p.wasmExports.free(ptr);
  }
}

/** Load one page (1-based) of an open document, run `fn`, and close the page. */
function onPage<T>(
  m: Module,
  doc: number,
  page: number,
  heap: Heap,
  fn: (m: Module, pg: number, heap: Heap) => T,
): T {
  const count = m.FPDF_GetPageCount(doc);
  if (page < 1 || page > count) {
    throw new ToolError("invalid_page", `The PDF has ${String(count)} pages.`, {
      hint: `Pass page between 1 and ${String(count)}.`,
    });
  }
  const pg = m.FPDF_LoadPage(doc, page - 1);
  if (!pg) throw new ToolError("render_failed", "The page renderer couldn't load this page.");
  try {
    return fn(m, pg, heap);
  } finally {
    m.FPDF_ClosePage(pg);
  }
}

/** Open one page (1-based) of an in-memory PDF, run `fn`, and free everything. */
function withPage<T>(
  pdf: Uint8Array,
  page: number,
  fn: (m: Module, pg: number, heap: Heap) => T,
): Promise<T> {
  return withDoc(pdf, (m, doc, heap) => onPage(m, doc, page, heap, fn));
}

/**
 * Render one page (1-based) of an in-memory PDF to RGBA pixels on white; with
 * `crop`, only that region of the page (at the same dpi). The longest output
 * side is capped at `maxSide`: the image is then drawn at a smaller scale,
 * which the result's `scale` says.
 */
export async function renderPage(
  pdf: Uint8Array,
  page: number,
  dpi: number,
  crop?: Region,
  maxSide: number = MAX_SIDE_PX,
): Promise<Rendered> {
  return withPage(pdf, page, (m, pg, heap) => {
    const wPt = m.FPDF_GetPageWidthF(pg);
    const hPt = m.FPDF_GetPageHeightF(pg);
    const c = crop ?? { x: 0, y: 0, w: 1, h: 1 };
    let scale = dpi / 72;
    const longest = Math.max(wPt * c.w, hPt * c.h) * scale;
    if (longest > maxSide) scale *= maxSide / longest;
    const fullW = Math.max(1, Math.round(wPt * scale));
    const fullH = Math.max(1, Math.round(hPt * scale));
    const x0 = Math.round(c.x * fullW);
    const y0 = Math.round(c.y * fullH);
    const width = Math.max(1, Math.min(fullW - x0, Math.round(c.w * fullW)));
    const height = Math.max(1, Math.min(fullH - y0, Math.round(c.h * fullH)));
    const bmp = m.FPDFBitmap_Create(width, height, 0);
    if (!bmp) throw new ToolError("render_failed", "Not enough memory to render this page.");
    try {
      m.FPDFBitmap_FillRect(bmp, 0, 0, width, height, 0xffffffff);
      // A crop renders the whole page shifted by (-x0, -y0) into a region-sized bitmap.
      m.FPDF_RenderPageBitmap(
        bmp,
        pg,
        -x0,
        -y0,
        fullW,
        fullH,
        0,
        FPDF_ANNOT | FPDF_REVERSE_BYTE_ORDER,
      );
      const stride = m.FPDFBitmap_GetStride(bmp);
      const buf = m.FPDFBitmap_GetBuffer(bmp);
      // Copy out (the wasm heap may grow and move on the next call).
      const rgba = new Uint8Array(width * 4 * height);
      const h8 = heap();
      for (let y = 0; y < height; y++) {
        const row = buf + y * stride;
        rgba.set(h8.subarray(row, row + width * 4), y * width * 4);
      }
      return { width, height, rgba, scale };
    } finally {
      m.FPDFBitmap_Destroy(bmp);
    }
  });
}

export interface Glyph extends Region {
  char: string;
  /** Its index in the page's text: a gap between two glyphs' indices is a space or a line break. */
  i: number;
  /** How dark it prints on white paper, 0 (black) to 255 (white), its fill's
   *  opacity counted; null when PDFium can't tell. Invisible text (an OCR layer
   *  over a scan) keeps its fill's: it stands for the print under it. */
  lum: number | null;
}

export interface PageText {
  widthPt: number;
  heightPt: number;
  /** Printed glyph boxes (whitespace skipped), fractions of the page as shown
   *  (rotated and cropped, as rendered), top-left origin. */
  glyphs: Glyph[];
  /** The same glyphs (index for index) in the page's own user space, in
   *  points (unrotated, uncropped): where pdf-lib, and so the check copy,
   *  draws. */
  own: { left: number; bottom: number; right: number; top: number }[];
}

/**
 * Each PDF's pages read so far, by its bytes: preview_page reads one page's
 * text for the tags, the placement checks and the stamped sizes, and a fill
 * with a check copy reads every page. Weak: gone with the bytes. A failed read
 * is not kept. Callers never change a PageText they are given.
 */
const textMemo = new WeakMap<Uint8Array, Map<number, Promise<PageText>>>();

function memoOf(pdf: Uint8Array): Map<number, Promise<PageText>> {
  let byPage = textMemo.get(pdf);
  if (!byPage) {
    byPage = new Map();
    textMemo.set(pdf, byPage);
  }
  return byPage;
}

/** The page's size in points and its text layer's glyph boxes (none on a scan). */
export function pageText(pdf: Uint8Array, page: number): Promise<PageText> {
  const byPage = memoOf(pdf);
  let text = byPage.get(page);
  if (!text) {
    text = withPage(pdf, page, readText);
    byPage.set(page, text);
    text.catch(() => byPage.delete(page));
  }
  return text;
}

/** pageText of an open page. */
function readText(m: Module, pg: number, heap: Heap): PageText {
  const widthPt = m.FPDF_GetPageWidthF(pg);
  const heightPt = m.FPDF_GetPageHeightF(pg);
  const glyphs: PageText["glyphs"] = [];
  const own: PageText["own"] = [];
  const tp = m.FPDFText_LoadPage(pg);
  if (!tp) return { widthPt, heightPt, glyphs, own };
  const p = m.pdfium;
  const out = p.wasmExports.malloc(32);
  const rgba = p.wasmExports.malloc(16);
  const dev = p.wasmExports.malloc(8);
  // A char box is in the page's own space (unrotated, from the MediaBox's
  // origin); the page as shown is rotated and cropped. PDFium maps a point
  // to the shown page, top-left origin, in whole device units: a device of
  // DEV units per point keeps it to 1/DEV pt.
  const DEV = 64;
  const devW = Math.max(1, Math.round(widthPt * DEV));
  const devH = Math.max(1, Math.round(heightPt * DEV));
  const shown = (x: number, y: number): [number, number] => {
    m.FPDF_PageToDevice(pg, 0, 0, devW, devH, 0, x, y, dev, dev + 4);
    const [dx, dy] = new Int32Array(heap().buffer, dev, 2);
    return [dx / devW, dy / devH];
  };
  try {
    if (!out || !rgba || !dev) {
      throw new ToolError("render_failed", "Not enough memory to read this page's text.");
    }
    const n = m.FPDFText_CountChars(tp);
    for (let i = 0; i < n; i++) {
      const u = m.FPDFText_GetUnicode(tp, i);
      if (u <= 32 || u === 0xa0 || u === 0xfffe || u === 0xffff) continue;
      if (!m.FPDFText_GetCharBox(tp, i, out, out + 8, out + 16, out + 24)) continue;
      const [left, right, bottom, top] = new Float64Array(heap().buffer, out, 4);
      if (!(right > left) || !(top > bottom)) continue;
      let lum: number | null = null;
      if (m.FPDFText_GetFillColor(tp, i, rgba, rgba + 4, rgba + 8, rgba + 12)) {
        const [r, g, b, a] = new Uint32Array(heap().buffer, rgba, 4);
        // On white paper: the fill blended with white by its opacity.
        lum = 255 - (255 - (0.299 * r + 0.587 * g + 0.114 * b)) * (a / 255);
      }
      const [ax, ay] = shown(left, top);
      const [bx, by] = shown(right, bottom);
      glyphs.push({
        x: Math.min(ax, bx),
        y: Math.min(ay, by),
        w: Math.abs(bx - ax),
        h: Math.abs(by - ay),
        char: String.fromCodePoint(u),
        i,
        lum,
      });
      own.push({ left, bottom, right, top });
    }
  } finally {
    if (out) p.wasmExports.free(out);
    if (rgba) p.wasmExports.free(rgba);
    if (dev) p.wasmExports.free(dev);
    m.FPDFText_ClosePage(tp);
  }
  return { widthPt, heightPt, glyphs, own };
}

/**
 * The printed glyph boxes of each of `pages` in each page's own user space (in
 * points, bottom-left origin: pdf-lib's, whatever the page's rotation, crop or
 * inherited boxes; the check copy maps them onto the visible page), for its id tags to
 * keep off. A page the renderer can't read (or a missing renderer) gives none:
 * the tags then avoid only the outlines and the stamped values.
 */
export async function printedBoxes(
  pdf: Uint8Array,
  pages: Iterable<number>,
): Promise<Record<number, PointBox[]>> {
  const out: Record<number, PointBox[]> = {};
  const wanted = [...new Set(pages)];
  const byPage = memoOf(pdf);
  // The pages not read yet, from one load of the document (a read already
  // under way is kept: it settles its own entry).
  if (wanted.some((page) => !byPage.has(page))) {
    try {
      await withDoc(pdf, (m, doc, heap) => {
        for (const page of wanted) {
          if (byPage.has(page)) continue;
          try {
            byPage.set(page, Promise.resolve(onPage(m, doc, page, heap, readText)));
          } catch {
            // no text layer to avoid on this page
          }
        }
      });
    } catch {
      // no renderer, or a PDF it can't open: no text to avoid
    }
  }
  for (const page of wanted) {
    const text = byPage.get(page);
    if (!text) continue;
    try {
      out[page] = (await text).own.map((g) => ({
        x: g.left,
        y: g.bottom,
        w: g.right - g.left,
        h: g.top - g.bottom,
      }));
    } catch {
      // no text layer to avoid on this page
    }
  }
  return out;
}

// ---- PNG -----------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** An opaque 8-bit RGB PNG of an RGBA raster (alpha dropped: the page is on white). */
export function encodePng(r: Raster): Uint8Array {
  const row = 1 + r.width * 3;
  const raw = Buffer.alloc(row * r.height);
  for (let y = 0; y < r.height; y++) {
    const src = y * r.width * 4;
    const dst = y * row;
    raw[dst] = 0; // filter: none
    for (let x = 0; x < r.width; x++) {
      const s = src + x * 4;
      const d = dst + 1 + x * 3;
      raw[d] = r.rgba[s];
      raw[d + 1] = r.rgba[s + 1];
      raw[d + 2] = r.rgba[s + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(r.width, 0);
  ihdr.writeUInt32BE(r.height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit, RGB, deflate, no filter, no interlace
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw, { level: 6 })),
      chunk("IEND", new Uint8Array(0)),
    ]),
  );
}

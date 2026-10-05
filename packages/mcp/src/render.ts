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

/** A region of the page in fractions, top-left origin. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Module = Pdfium;

/** Open one page (1-based) of an in-memory PDF, run `fn`, and free everything. */
async function withPage<T>(
  pdf: Uint8Array,
  page: number,
  fn: (m: Module, pg: number, heap: () => Uint8Array) => T,
): Promise<T> {
  const m = await pdfium();
  const p = m.pdfium;
  // The Emscripten heap view (typed loosely upstream); re-read after every
  // call that may grow memory.
  const heap = () => (p as unknown as { HEAPU8: Uint8Array }).HEAPU8;
  const ptr = p.wasmExports.malloc(pdf.length);
  if (!ptr) throw new ToolError("render_failed", "Not enough memory to render this page.");
  let doc = 0;
  let pg = 0;
  try {
    heap().set(pdf, ptr);
    doc = m.FPDF_LoadMemDocument(ptr, pdf.length, "");
    if (!doc) {
      throw new ToolError("render_failed", "The page renderer couldn't open this PDF.", {
        hint: "Use fill_form with check_pdf instead and open the .check.pdf.",
      });
    }
    const count = m.FPDF_GetPageCount(doc);
    if (page < 1 || page > count) {
      throw new ToolError("invalid_page", `The PDF has ${String(count)} pages.`, {
        hint: `Pass page between 1 and ${String(count)}.`,
      });
    }
    pg = m.FPDF_LoadPage(doc, page - 1);
    if (!pg) throw new ToolError("render_failed", "The page renderer couldn't load this page.");
    return fn(m, pg, heap);
  } finally {
    if (pg) m.FPDF_ClosePage(pg);
    if (doc) m.FPDF_CloseDocument(doc);
    p.wasmExports.free(ptr);
  }
}

/**
 * Render one page (1-based) of an in-memory PDF to RGBA pixels on white; with
 * `crop`, only that region of the page (at the same dpi). The longest output
 * side is capped at MAX_SIDE_PX.
 */
export async function renderPage(
  pdf: Uint8Array,
  page: number,
  dpi: number,
  crop?: Region,
): Promise<Raster> {
  return withPage(pdf, page, (m, pg, heap) => {
    const wPt = m.FPDF_GetPageWidthF(pg);
    const hPt = m.FPDF_GetPageHeightF(pg);
    const c = crop ?? { x: 0, y: 0, w: 1, h: 1 };
    let scale = dpi / 72;
    const longest = Math.max(wPt * c.w, hPt * c.h) * scale;
    if (longest > MAX_SIDE_PX) scale *= MAX_SIDE_PX / longest;
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
      return { width, height, rgba };
    } finally {
      m.FPDFBitmap_Destroy(bmp);
    }
  });
}

export interface PageText {
  widthPt: number;
  heightPt: number;
  /** Printed glyph boxes (whitespace skipped), fractions of the page, top-left origin. */
  glyphs: (Region & { char: string })[];
}

/** The page's size in points and its text layer's glyph boxes (none on a scan). */
export async function pageText(pdf: Uint8Array, page: number): Promise<PageText> {
  return withPage(pdf, page, (m, pg, heap) => {
    const widthPt = m.FPDF_GetPageWidthF(pg);
    const heightPt = m.FPDF_GetPageHeightF(pg);
    const glyphs: PageText["glyphs"] = [];
    const tp = m.FPDFText_LoadPage(pg);
    if (!tp) return { widthPt, heightPt, glyphs };
    const p = m.pdfium;
    const out = p.wasmExports.malloc(32);
    try {
      const n = m.FPDFText_CountChars(tp);
      for (let i = 0; i < n; i++) {
        const u = m.FPDFText_GetUnicode(tp, i);
        if (u <= 32 || u === 0xa0 || u === 0xfffe || u === 0xffff) continue;
        if (!m.FPDFText_GetCharBox(tp, i, out, out + 8, out + 16, out + 24)) continue;
        const [left, right, bottom, top] = new Float64Array(heap().buffer, out, 4);
        if (!(right > left) || !(top > bottom)) continue;
        glyphs.push({
          x: left / widthPt,
          y: (heightPt - top) / heightPt, // PDF space is bottom-left: invert Y
          w: (right - left) / widthPt,
          h: (top - bottom) / heightPt,
          char: String.fromCodePoint(u),
        });
      }
    } finally {
      p.wasmExports.free(out);
      m.FPDFText_ClosePage(tp);
    }
    return { widthPt, heightPt, glyphs };
  });
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

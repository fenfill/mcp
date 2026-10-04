// Pure PDF-stamping module — extracted from FillForm's generateFilledPDF.
// No React, no Zustand, no Supabase/pdfjs: the render core must
// import neither a data source nor a store. Input is already-computed marks +
// branding; output is the saved PDF bytes. The caller owns marks-computation,
// the blob/download, telemetry, and success state.
import type { PDFFont, PDFPage } from "pdf-lib";

import type { TextAnchor } from "@/types";
import {
  DEFAULT_FONT_SIZE,
  DEFAULT_SIGNATURE_ANCHOR,
  DEFAULT_TEXT_ANCHOR,
  MULTILINE_DEFAULT_FONT_SIZE,
} from "@/types";

import type { Pct } from "./coords";
import { flattenFormFields } from "./flattenForm";
import { splitByCoverage } from "./fontRuns";
import { classifyMark, MARK_LINES, MARK_SQUARE, MARK_STROKE, type MarkShape } from "./markGeometry";
import { dataUrlToBytes } from "./signatureImage";
import {
  anchorImageXY,
  anchorPdfXY,
  autoTextStartPt,
  CHECKBOX_AUTO_FILL,
  fitFontSize,
  fitWrapped,
  layoutMultiline,
  LINE_HEIGHT_FACTOR,
  MULTILINE_MIN_FONT_SIZE,
  multilinePadPt,
  TEXT_PAD_PT,
  wrapLines,
} from "./textFit";

export interface Mark {
  key: string;
  box: Pct;
  page: number;
  text: string;
  center: boolean;
  // Single-line text marks (center: false) only. Baseline size in PDF points and
  // 9-point placement, both from the field's TextFormat. Absent => the app
  // defaults (DEFAULT_FONT_SIZE / DEFAULT_TEXT_ANCHOR), so table/expandable text
  // cells that never set them still get the fixed, non-stretched treatment.
  fontSize?: number;
  anchor?: TextAnchor;
  // Long-form multi-line text: instead of one horizontally-shrunk line, the value
  // is word-wrapped to the box width and the font vertically auto-shrunk so the
  // block fits the box height (down to MULTILINE_MIN_FONT_SIZE), stacked from the
  // anchor.
  multiline?: boolean;
  // Whether the field is left on Auto (blank font size). true => size from the box:
  // single-line starts at autoTextStartPt(boxHeight) then shrinks to width;
  // multiline vertically auto-shrinks to fit the box height. false/undefined => the
  // author pinned an explicit size: render at exactly `fontSize` (single-line still
  // shrinks to width; multiline wraps only, no vertical shrink), so the size control
  // is authoritative. Set for every text/date value mark by fillMarks.
  autoFit?: boolean;
  // An image mark (e.g. a signature) carries a client-side data-URL instead of
  // text; `stamp()` embeds it into the box aspect-preserved. Mutually exclusive
  // with a non-empty `text`. The bytes never leave the browser (zero-retention).
  image?: { dataUrl: string };
  // Centered checkbox marks (center: true) only. Explicit mark size in PDF points
  // (CheckboxFormat.font_size). Absent => the historical box-relative auto size.
  markFontSize?: number;
  // Checkbox / choice marks only: the mark fills its box to the edges (no 0.8 auto
  // padding) and sizes freely — an explicit `markFontSize` is used as-is and may
  // exceed the box (overflowing, centered) rather than clamped to it. Comb / table-
  // cell glyphs never set this: they keep the 0.8 auto size + cell clamp.
  checkbox?: boolean;
  // Image marks (signature) only. A 0<s≤1 multiplier applied on top of the
  // aspect-preserved fit-to-box (SignatureFormat.scale). Absent => 1 (fill box).
  imageScale?: number;
}

export interface StampOptions {
  // Source bytes from the injected provider (signed Supabase URL for templates,
  // local File bytes for Quickfill) — the module never fetches the source PDF.
  pdfBytes: ArrayBuffer;
  marksByPage: ReadonlyMap<number, readonly Mark[]>;
  // Paid "Powered by" footer + workspace logo (pro/max).
  branding?: { watermark: boolean; logoUrl: string | null };
  // PLG bottom-margin watermark stamped on every page (Quickfill). null = none.
  watermarkText?: string | null;
  // Pre-fetched font bytes. When provided the two /fonts fetches are skipped —
  // a batch caller (mass fill) fetches once per batch instead of twice per
  // document. Absent => the historical per-call fetch, byte-identical output.
  fonts?: { inter: ArrayBuffer; deja: ArrayBuffer };
  // Pre-fetched workspace-logo bytes: same batch optimization for
  // branding.logoUrl (which is still required to opt the stamp in).
  logoBytes?: ArrayBuffer | null;
  // Custom keys written into the output's Info dictionary (the MCP tags its
  // outputs with MCP_OUTPUT_TAG). The browser never passes it.
  infoTags?: Record<string, string>;
  // Told how each text mark was laid out (the MCP turns it into placement
  // warnings). Observes only: the stamped bytes are the same with or without
  // it. The browser never passes it.
  onPlacement?: (p: Placement) => void;
}

/** How one text mark was laid out in its box (StampOptions.onPlacement). */
export interface Placement {
  key: string;
  page: number;
  multiline: boolean;
  /** The size it was drawn at, and the size it started from before shrinking. */
  size: number;
  startSize: number;
  /** False when the text still runs past its box at `size` (too wide even at
   *  the minimum, or too many wrapped lines for the box height). */
  fits: boolean;
}

/**
 * Loads the source PDF, stamps the marks plus the branding/PLG watermark and the
 * workspace logo, and returns the saved bytes. Throws on font-fetch failure; the
 * logo is best-effort and never blocks the result.
 */
export async function stampPdf({
  pdfBytes,
  marksByPage,
  branding,
  watermarkText = null,
  fonts,
  logoBytes = null,
  infoTags,
  onPlacement,
}: StampOptions): Promise<Uint8Array> {
  // pdf-lib (+ fontkit) ~150KB is only needed when the user actually downloads,
  // so it's loaded here instead of at the editor/quickfill module top level.
  const [pdfLib, { default: fontkit }] = await Promise.all([
    import("pdf-lib"),
    import("@pdf-lib/fontkit"),
  ]);
  const { PDFDocument, rgb, StandardFonts, LineCapStyle } = pdfLib;

  // An owner-password PDF (every USCIS form) opens without a password but pdf-lib
  // refuses it. Detect via isEncrypted (pdf-lib's EncryptedPDFError fails
  // instanceof), then decrypt with the lazily-loaded fork and reload the clean
  // bytes, unless its author forbids filling it in. Ordinary PDFs never load the
  // decrypt chunk.
  let pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  if (pdfDoc.isEncrypted) {
    const { assertFillPermitted, decryptPdf } = await import("./decryptPdf");
    assertFillPermitted(pdfDoc, pdfLib);
    pdfDoc = await PDFDocument.load(await decryptPdf(pdfBytes));
  }
  pdfDoc.registerFontkit(fontkit);
  // Bake + strip the source's own form fields first, so the output has nothing
  // editable and baked widget backgrounds sit under the stamped answers.
  flattenFormFields(pdfDoc, pdfLib);

  // Embed TWO faces and draw each glyph with the first that covers it: Inter (the
  // brand primary — Latin + Polish diacritics + Cyrillic + Greek) with DejaVuSans
  // as the broad-Unicode fallback (Hebrew, Arabic, …). Inter is also the on-screen
  // stamp face (globals.css `InterStamp`, textFit.ts STAMP_FONT_FAMILY), so the
  // preview matches the print. pdf-lib subsets each on embed, so the fetched ttf
  // size barely affects the output PDF.
  const [interBytes, dejaBytes] = fonts
    ? [fonts.inter, fonts.deja]
    : await Promise.all([
        fetch("/fonts/Inter-Regular.ttf").then((r) => {
          if (!r.ok) throw new Error("Could not load the embedded font.");
          return r.arrayBuffer();
        }),
        fetch("/fonts/DejaVuSans.ttf").then((r) => {
          if (!r.ok) throw new Error("Could not load the fallback font.");
          return r.arrayBuffer();
        }),
      ]);
  const interFont = await pdfDoc.embedFont(interBytes, { subset: true });
  const dejaFont = await pdfDoc.embedFont(dejaBytes, { subset: true });
  const pdfPages = pdfDoc.getPages();

  const INK = rgb(0.1, 0.1, 0.1);

  // Per-codepoint coverage of the primary face (fontkit reads the cmap). Glyphs
  // Inter lacks fall through to DejaVu.
  const interKit = fontkit.create(new Uint8Array(interBytes));
  const covers = (cp: number): boolean => {
    try {
      return interKit.hasGlyphForCodePoint(cp);
    } catch {
      return false;
    }
  };

  // Split a string into maximal runs sharing one face (Inter where covered, else
  // DejaVu), so a mixed-script value renders every glyph instead of tofu.
  const splitRuns = (t: string): { font: PDFFont; text: string }[] =>
    splitByCoverage(t, (cp) => (covers(cp) ? interFont : dejaFont)).map((r) => ({
      font: r.key,
      text: r.text,
    }));

  // Injected MeasureText for the font-agnostic fit helpers: total width across the
  // runs so shrink/wrap decisions account for the fallback face too.
  const measure = (t: string, s: number): number =>
    splitRuns(t).reduce((sum, r) => sum + r.font.widthOfTextAtSize(r.text, s), 0);

  // Draw a (possibly mixed-face) line with its left edge at (x, y), advancing x by
  // each run's width.
  const drawMixed = (page: PDFPage, t: string, x: number, y: number, s: number) => {
    let cx = x;
    for (const r of splitRuns(t)) {
      page.drawText(r.text, { x: cx, y, size: s, font: r.font, color: INK });
      cx += r.font.widthOfTextAtSize(r.text, s);
    }
  };

  // Draw a preset checkbox mark (✓ ✗ ■) as a vector, sized to a centered square
  // inscribed in the cell — mirroring the on-screen <MarkSvg> so preview == print.
  const drawMarkPdf = (
    page: PDFPage,
    shape: MarkShape,
    r: { x0: number; y0: number; w: number; h: number },
    // Explicit mark side in points (CheckboxFormat.font_size). Absent => the
    // historical full-cell auto size (min(w, h)), so unsized marks are unchanged.
    sizePt?: number,
    // When true an explicit sizePt is used as-is (may exceed the cell); otherwise
    // it is clamped to the inscribed square. Checkbox marks pass true.
    overflow?: boolean,
  ) => {
    const fit = Math.min(r.w, r.h);
    const side =
      sizePt != null
        ? overflow
          ? sizePt
          : Math.min(sizePt, fit)
        : overflow
          ? fit * CHECKBOX_AUTO_FILL
          : fit;
    const cx = r.x0 + r.w / 2;
    const cy = r.y0 + r.h / 2;
    // normalized top-left-origin (nx,ny) -> PDF points (y-up), centered square.
    const px = (nx: number) => cx + (nx - 0.5) * side;
    const py = (ny: number) => cy - (ny - 0.5) * side;
    if (shape === "square") {
      page.drawRectangle({
        x: px(MARK_SQUARE.x),
        y: py(MARK_SQUARE.y + MARK_SQUARE.h),
        width: MARK_SQUARE.w * side,
        height: MARK_SQUARE.h * side,
        color: INK,
      });
      return;
    }
    const thickness = MARK_STROKE * side;
    for (const pts of MARK_LINES[shape]) {
      for (let i = 0; i + 1 < pts.length; i++) {
        page.drawLine({
          start: { x: px(pts[i][0]), y: py(pts[i][1]) },
          end: { x: px(pts[i + 1][0]), y: py(pts[i + 1][1]) },
          thickness,
          color: INK,
          lineCap: LineCapStyle.Round,
        });
      }
    }
  };

  const stamp = async (pageNum: number, m: Mark) => {
    // A mark may reference a page beyond the loaded PDF (malformed schema/marks);
    // the index is honestly optional, so keep the out-of-range guard.
    const page = pdfPages[pageNum - 1] as PDFPage | undefined;
    if (!page) return;
    const { box, text, center } = m;
    const { width: pw, height: ph } = page.getSize();
    // Percent (top-left) -> PDF points (bottom-left).
    const x0 = (box.xPct / 100) * pw;
    const w = (box.wPct / 100) * pw;
    const h = (box.hPct / 100) * ph;
    const yTop = (box.yPct / 100) * ph;
    const y0 = ph - yTop - h;
    const pad = TEXT_PAD_PT;

    // Image mark (signature): embed the PNG/JPG and fit it into the box,
    // aspect-preserved + centered. Best-effort — a bad image is skipped, never
    // throws (mirrors the decorative logo below). Same magic-byte sniff.
    if (m.image) {
      try {
        const bytes = dataUrlToBytes(m.image.dataUrl);
        if (!bytes) return;
        const isPng = bytes[0] === 0x89 && bytes[1] === 0x50; // \x89 P N G
        const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8; // JPEG SOI
        const img = isPng
          ? await pdfDoc.embedPng(bytes)
          : isJpg
            ? await pdfDoc.embedJpg(bytes)
            : null;
        if (img) {
          // Aspect-preserved fit-to-box, then the author's optional shrink factor.
          const scale = Math.min(w / img.width, h / img.height) * (m.imageScale ?? 1);
          const dw = img.width * scale;
          const dh = img.height * scale;
          // Place the shrunk image by its 9-point anchor (defaults to centered).
          const { x, y } = anchorImageXY({
            x0,
            y0,
            w,
            h,
            dw,
            dh,
            anchor: m.anchor ?? DEFAULT_SIGNATURE_ANCHOR,
          });
          page.drawImage(img, { x, y, width: dw, height: dh });
        }
      } catch {
        // ignore — a signature image failure must never block the download
      }
      return;
    }

    if (text === "") return;

    if (center) {
      // Preset mark (✓ ✗ ■) -> font-independent vector; a comb single-character or
      // a custom glyph -> centered text in the stamp face(s).
      const shape = classifyMark(text);
      if (shape) {
        drawMarkPdf(page, shape, { x0, y0, w, h }, m.markFontSize, m.checkbox);
        return;
      }
      // Custom (non-preset) glyph as text: honor an explicit mark size (clamped to
      // the cell), else the historical auto size (0.8·min-side, capped 6..16pt).
      let size =
        m.markFontSize != null
          ? m.checkbox
            ? m.markFontSize
            : Math.min(m.markFontSize, Math.min(h, w))
          : m.checkbox
            ? Math.min(h, w) * CHECKBOX_AUTO_FILL
            : Math.min(Math.min(h, w) * 0.8, 16);
      size = Math.max(6, size);
      const tw = measure(text, size);
      drawMixed(page, text, x0 + (w - tw) / 2, y0 + (h - size * 0.7) / 2, size);
      return;
    }

    // Long-form multi-line text: word-wrap to the box width and vertically
    // auto-shrink the font so the wrapped block fits the box height (re-wrapping at
    // each step), then draw each line stacked down from the anchor.
    if (m.multiline) {
      const start = m.fontSize ?? MULTILINE_DEFAULT_FONT_SIZE;
      // Per-axis inset, capped so a short cell keeps usable height (see
      // multilinePadPt). Wide boxes stay at the full TEXT_PAD_PT horizontally.
      const padX = multilinePadPt(w);
      const padY = multilinePadPt(h);
      // autoFit === false => author pinned a size: draw at exactly `start` (wrap
      // only). Otherwise vertically auto-shrink from `start` to fit, floor 5pt.
      const { size, lines } =
        m.autoFit === false
          ? { size: start, lines: wrapLines(text, w - 2 * padX, start, measure) }
          : fitWrapped(text, w - 2 * padX, h - 2 * padY, start, measure, MULTILINE_MIN_FONT_SIZE);
      const placed = layoutMultiline({
        x0,
        y0,
        w,
        h,
        size,
        lines,
        anchor: m.anchor ?? DEFAULT_TEXT_ANCHOR,
        padX,
        padY,
        measure,
      });
      for (const p of placed) {
        if (p.text === "") continue;
        drawMixed(page, p.text, p.x, p.y, size);
      }
      onPlacement?.({
        key: m.key,
        page: pageNum,
        multiline: true,
        size,
        startSize: start,
        fits:
          lines.length * size * LINE_HEIGHT_FACTOR <= h - 2 * padY + 0.01 &&
          lines.every((l) => measure(l, size) <= w - 2 * padX + 0.01),
      });
      return;
    }

    // Single-line text: choose the start size, then shrink horizontally to fit the
    // box width (down to MIN_FONT_SIZE) and place the line at its 9-point anchor. On
    // Auto the start is derived from the box HEIGHT (autoTextStartPt) so short boxes
    // get proportionate text; a pinned size starts at exactly that size.
    const startPt = m.autoFit ? autoTextStartPt(h) : (m.fontSize ?? DEFAULT_FONT_SIZE);
    const size = fitFontSize(text, w - 2 * pad, startPt, measure);
    const tw = measure(text, size);
    const { x, y } = anchorPdfXY({
      x0,
      y0,
      w,
      h,
      tw,
      size,
      anchor: m.anchor ?? DEFAULT_TEXT_ANCHOR,
      pad,
    });
    drawMixed(page, text, x, y, size);
    onPlacement?.({
      key: m.key,
      page: pageNum,
      multiline: false,
      size,
      startSize: startPt,
      fits: tw <= w - 2 * pad + 0.01,
    });
  };

  for (const [pageNum, marks] of marksByPage) {
    for (const m of marks) await stamp(pageNum, m);
  }

  // Branding: a "Powered by" watermark (free tier) on every page. Helvetica
  // is built into pdf-lib (zero network bytes) so it stamps instantly even
  // on an otherwise-empty submission — the Inter/DejaVu content faces are only
  // fetched above.
  if (branding?.watermark) {
    const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const label = "Made with fenfill.com";
    const size = 7;
    for (const page of pdfPages) {
      const { width: pw } = page.getSize();
      const tw = helv.widthOfTextAtSize(label, size);
      page.drawText(label, {
        x: pw - tw - 12,
        y: 12,
        size,
        font: helv,
        color: rgb(0.6, 0.6, 0.6),
      });
    }
  }

  // PLG: Quickfill stamps a subtle bottom-margin watermark on every page to
  // drive registration. Helvetica is built into pdf-lib (no network bytes).
  if (watermarkText) {
    const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const size = 8;
    for (const page of pdfPages) {
      const { width: pw } = page.getSize();
      const tw = helv.widthOfTextAtSize(watermarkText, size);
      page.drawText(watermarkText, {
        x: (pw - tw) / 2,
        y: 14,
        size,
        font: helv,
        color: rgb(0.55, 0.55, 0.6),
      });
    }
  }

  // Branding: stamp the workspace logo (pro/max) footer-right on page 1.
  // Best-effort — a logo failure must never block the download.
  if (branding?.logoUrl) {
    try {
      const fetched = logoBytes
        ? null
        : await fetch(branding.logoUrl).then((r) => {
            if (!r.ok) throw new Error("logo fetch failed");
            return r.arrayBuffer();
          });
      const logoBuf = logoBytes ?? fetched;
      if (!logoBuf) throw new Error("logo unavailable");
      const head = new Uint8Array(logoBuf.slice(0, 4));
      const isPng = head[0] === 0x89 && head[1] === 0x50; // \x89 P N G
      const isJpg = head[0] === 0xff && head[1] === 0xd8; // JPEG SOI
      const img = isPng
        ? await pdfDoc.embedPng(logoBuf)
        : isJpg
          ? await pdfDoc.embedJpg(logoBuf)
          : null;
      const page1 = pdfPages[0] as PDFPage | undefined; // empty PDF => no page 1
      if (img && page1) {
        const { width: pw } = page1.getSize();
        const h = 24;
        const w = (img.width / img.height) * h;
        page1.drawImage(img, { x: pw - w - 16, y: 16, width: w, height: h });
      }
    } catch {
      // ignore — logo is decorative
    }
  }

  if (infoTags) {
    const { PDFDict, PDFHexString, PDFName } = pdfLib;
    const ctx = pdfDoc.context;
    const found = ctx.lookup(ctx.trailerInfo.Info);
    const info = found instanceof PDFDict ? found : PDFDict.withContext(ctx);
    if (info !== found) ctx.trailerInfo.Info = ctx.register(info);
    for (const [k, v] of Object.entries(infoTags)) {
      info.set(PDFName.of(k), PDFHexString.fromText(v));
    }
  }

  return pdfDoc.save();
}

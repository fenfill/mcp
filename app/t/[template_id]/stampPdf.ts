// Pure PDF-stamping module — extracted from FillForm's generateFilledPDF.
// No React, no Zustand, no Supabase/pdfjs: the render core must
// import neither a data source nor a store. Input is already-computed marks +
// branding; output is the saved PDF bytes. The caller owns marks-computation,
// the blob/download, telemetry, and success state.
import type { Color, PDFDocument, PDFFont, PDFPage } from "pdf-lib";

import type { TextAnchor } from "@/types";
import {
  DEFAULT_FONT_SIZE,
  DEFAULT_SIGNATURE_ANCHOR,
  DEFAULT_TEXT_ANCHOR,
  MULTILINE_DEFAULT_FONT_SIZE,
} from "@/types";

import { bidiAnchor, isRtlDominant, marksNeedBidi, needsBidi, stripBidiControls } from "./bidiText";
import type { Pct } from "./coords";
import { flattenFormFields } from "./flattenForm";
import {
  inJpFaceRange,
  joinsJpRun,
  marksNeedJpFace,
  type RunDirection,
  splitByCoverage,
  splitByDirection,
} from "./fontRuns";
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
  // `jp` is used only when a mark needs it; absent => loadJpStampFace.
  fonts?: StampFonts;
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

/** The stamp's face bytes. `jp` (Noto Sans JP) is optional: given => embedded
 *  and the JP ranges routed to it; absent => the two-face stamp, unchanged. */
export type StampFonts = { inter: ArrayBuffer; deja: ArrayBuffer; jp?: ArrayBuffer };

/** The stamp's faces on one document (embedStampFaces). */
export interface StampFaces {
  /** Width of `t` at size `s`, summed across its runs, so shrink/wrap decisions
   *  account for the fallback face too. */
  measure: (t: string, s: number) => number;
  /** Draws a (possibly mixed-face) line with its left edge at (x, y). */
  draw: (page: PDFPage, t: string, x: number, y: number, s: number, color: Color) => void;
  /** Like `draw`, for a line already in VISUAL order (rtlStamp.ts visualLines):
   *  every glyph lands left to right exactly as given. */
  drawVisual: (page: PDFPage, t: string, x: number, y: number, s: number, color: Color) => void;
  /** Whether any embedded face has a glyph for the code point; one none has
   *  prints as an empty box. */
  hasGlyph: (cp: number) => boolean;
}

/**
 * Embeds up to THREE faces in `pdfDoc` (which must have `fontkit` registered)
 * and draws each glyph with the one that covers it: Inter (the brand primary —
 * Latin + Polish diacritics + Cyrillic + Greek) with DejaVuSans as the
 * broad-Unicode fallback (Hebrew, Arabic, …), and, when `fonts.jp` is given,
 * Noto Sans JP for every code point in JP_FACE_RANGES (fontRuns.ts; Inter and
 * DejaVu cover none of them, so the routing is a pure range check). Inter is
 * also the on-screen stamp face (globals.css `InterStamp`, textFit.ts
 * STAMP_FONT_FAMILY), so the preview matches the print. pdf-lib subsets each on
 * embed, so the ttf size barely affects the output PDF. Without `fonts.jp` the
 * JP face is neither embedded nor consulted: the output is byte-identical to the
 * two-face stamp. Shared by stampPdf and the MCP's check copy (agentValues.ts),
 * so anything drawn on a stamped page can show what a stamped value can.
 */
export async function embedStampFaces(
  pdfDoc: PDFDocument,
  fontkit: Parameters<PDFDocument["registerFontkit"]>[0],
  fonts: StampFonts,
): Promise<StampFaces> {
  const interFont = await pdfDoc.embedFont(fonts.inter, { subset: true });
  const dejaFont = await pdfDoc.embedFont(fonts.deja, { subset: true });
  // Embedded only when given: pdf-lib writes every embedded font on save.
  const jpFont = fonts.jp ? await pdfDoc.embedFont(fonts.jp, { subset: true }) : undefined;

  // Per-codepoint coverage of the primary face (fontkit reads the cmap). Glyphs
  // Inter lacks fall through to DejaVu.
  const interKit = fontkit.create(new Uint8Array(fonts.inter));
  const covers = (cp: number): boolean => {
    try {
      return interKit.hasGlyphForCodePoint(cp);
    } catch {
      return false;
    }
  };

  // Split a string into maximal runs sharing one face (the JP face for its
  // ranges, else Inter where covered, else DejaVu), so a mixed-script value
  // renders every glyph instead of tofu. A variation selector or voicing mark
  // after a JP-routed character joins its run (joinsJpRun), JP stamps only.
  const pick = jpFont
    ? (cp: number) => (inJpFaceRange(cp) ? jpFont : covers(cp) ? interFont : dejaFont)
    : (cp: number) => (covers(cp) ? interFont : dejaFont);
  const splitRuns = (t: string): { font: PDFFont; text: string }[] =>
    (jpFont ? splitByCoverage(t, pick, joinsJpRun) : splitByCoverage(t, pick)).map((r) => ({
      font: r.key,
      text: r.text,
    }));

  // Injected MeasureText for the font-agnostic fit helpers: total width across the
  // runs so shrink/wrap decisions account for the fallback face too.
  const measure = (t: string, s: number): number =>
    splitRuns(t).reduce((sum, r) => sum + r.font.widthOfTextAtSize(r.text, s), 0);

  // Draw a (possibly mixed-face) line with its left edge at (x, y), advancing x by
  // each run's width.
  const draw = (page: PDFPage, t: string, x: number, y: number, s: number, color: Color) => {
    let cx = x;
    for (const r of splitRuns(t)) {
      page.drawText(r.text, { x: cx, y, size: s, font: r.font, color });
      cx += r.font.widthOfTextAtSize(r.text, s);
    }
  };

  // A visual-order line: fontkit would reverse every piece whose script is
  // right-to-left (it expects logical order), so such a piece is handed over
  // reversed and comes out as given (fontRuns.ts splitByDirection). Its width is
  // the same either way: pdf-lib sums advance widths.
  const drawVisual = (page: PDFPage, t: string, x: number, y: number, s: number, color: Color) => {
    let cx = x;
    for (const r of splitRuns(t)) {
      for (const piece of splitByDirection(r.text, (cp) => fontkitDirection(interKit, cp))) {
        const text = piece.rtl ? Array.from(piece.text).reverse().join("") : piece.text;
        page.drawText(text, { x: cx, y, size: s, font: r.font, color });
        cx += r.font.widthOfTextAtSize(text, s);
      }
    }
  };

  // The fallback's (and the JP face's) code points, read only once Inter lacks one.
  let dejaSet: Set<number> | undefined;
  let jpSet: Set<number> | undefined;
  const hasGlyph = (cp: number): boolean => {
    if (covers(cp)) return true;
    dejaSet ??= new Set(dejaFont.getCharacterSet());
    if (dejaSet.has(cp)) return true;
    if (!jpFont) return false;
    jpSet ??= new Set(jpFont.getCharacterSet());
    return jpSet.has(cp);
  };

  return { measure, draw, drawVisual, hasGlyph };
}

// fontkit's own answer, per code point, to "which way does a run holding this
// lay out": it picks a run's script from the first code point that isn't
// Common/Inherited and reverses right-to-left scripts. Asking its layout (a
// trailing Latin "a" or Hebrew alef tells "neutral" from a script of its own)
// instead of keeping a script table means the two can never disagree. The
// script is the font's business only through its cmap, so any face answers;
// memoized for the module.
const directionMemo = new Map<number, RunDirection>();
function fontkitDirection(
  kit: { layout: (t: string) => { direction: string | null } },
  cp: number,
): RunDirection {
  let d = directionMemo.get(cp);
  if (d === undefined) {
    const ch = String.fromCodePoint(cp);
    d =
      kit.layout(`${ch}a`).direction === "rtl"
        ? "rtl"
        : kit.layout(`${ch}\u05d0`).direction === "rtl"
          ? "neutral"
          : "ltr";
    directionMemo.set(cp, d);
  }
  return d;
}

// One fetch per module (the page, or a mass-fill worker): the 5.8 MB face is
// loaded on the first Japanese stamp and reused. Reset on failure so a retry
// fetches again (a mass-fill batch instead stops at its first failure, see
// batchJpStampFace).
let jpFacePromise: Promise<ArrayBuffer> | undefined;

/** Fetches the Japanese stamp face (fontRuns.ts JP_FACE_URL), memoized. Rejects
 *  with "Could not load the Japanese font." on a network, HTTP or body failure. */
export function loadJpStampFace(): Promise<ArrayBuffer> {
  jpFacePromise ??= fetch("/fonts/NotoSansJP-Regular.ttf")
    .then((r) => {
      if (!r.ok) throw new Error("HTTP " + String(r.status));
      return r.arrayBuffer();
    })
    .catch(() => {
      jpFacePromise = undefined;
      throw new Error("Could not load the Japanese font.");
    });
  return jpFacePromise;
}

/** A mass-fill batch's JP face: `face(marksByPage)` resolves the bytes when the
 *  marks need them (else undefined), fetching at most once per batch. After a
 *  failed fetch `failed` is true and every later call rejects with the same
 *  error, so the batch stops with one clear message instead of refetching, and
 *  failing, row by row. Interactive stamps keep loadJpStampFace's retry. */
export function batchJpStampFace(): {
  face: (marksByPage: ReadonlyMap<number, readonly Mark[]>) => Promise<ArrayBuffer | undefined>;
  readonly failed: boolean;
} {
  let pending: Promise<ArrayBuffer> | undefined;
  let failed = false;
  return {
    face: (marksByPage) => {
      if (!marksNeedJpFace(marksByPage)) return Promise.resolve(undefined);
      pending ??= loadJpStampFace().catch((err: unknown) => {
        failed = true;
        throw err;
      });
      return pending;
    },
    get failed() {
      return failed;
    },
  };
}

/** Test-only: forgets the memoized JP face so the next stamp fetches again. */
export function resetJpStampFaceForTests(): void {
  jpFacePromise = undefined;
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

  // The two stamp faces (Inter + the DejaVuSans fallback; see embedStampFaces).
  // The fetched ttf size barely affects the output: each is subset on embed.
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
  // The JP face only when a mark draws one of its characters: a passed-in but
  // unneeded `fonts.jp` is not embedded, so Latin output stays byte-identical.
  const jp = marksNeedJpFace(marksByPage) ? (fonts?.jp ?? (await loadJpStampFace())) : undefined;
  const faces = await embedStampFaces(pdfDoc, fontkit, {
    inter: interBytes,
    deja: dejaBytes,
    jp,
  });
  // Arabic shaping + the bidi algorithm, loaded only when a mark holds a
  // right-to-left character; every other mark draws exactly as before.
  const rtlLayer = marksNeedBidi(marksByPage) ? await import("./rtlStamp") : undefined;
  const pdfPages = pdfDoc.getPages();

  const INK = rgb(0.1, 0.1, 0.1);

  // Injected MeasureText for the font-agnostic fit helpers.
  const { measure } = faces;
  const drawMixed = (page: PDFPage, t: string, x: number, y: number, s: number) => {
    faces.draw(page, t, x, y, s, INK);
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

    // A value with a right-to-left character: shaped (Arabic joining forms) in
    // logical order, measured and wrapped as that, its bidi levels resolved
    // over the whole value and each line reordered to visual order just before
    // it is drawn (visualLines). An RTL-dominant value (first strong character
    // RTL, as dir="auto") reads right to left and starts at the box's right
    // edge. Every other value keeps the historical path untouched.
    const bidi = rtlLayer && needsBidi(text) ? rtlLayer : undefined;
    const rtl = bidi !== undefined && isRtlDominant(text);
    const body = bidi ? bidi.shapeArabic(text) : text;
    // What is drawn is measured: the bidi path drops the direction controls
    // (visualLines), so they take no width in the fit, wrap or anchor either.
    const measureText = bidi ? (t: string, s: number) => measure(stripBidiControls(t), s) : measure;
    // `lines` (logical, wrapped from `body`) as they are drawn.
    const toDraw = (lines: string[]): string[] =>
      bidi ? bidi.visualLines(body, lines, rtl) : lines;
    const drawLine = bidi
      ? (t: string, x: number, y: number, s: number) => {
          faces.drawVisual(page, t, x, y, s, INK);
        }
      : (t: string, x: number, y: number, s: number) => {
          drawMixed(page, t, x, y, s);
        };
    const anchorOf = (a: TextAnchor | undefined) => bidiAnchor(a ?? DEFAULT_TEXT_ANCHOR, rtl);

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
      const tw = measureText(body, size);
      drawLine(toDraw([body])[0], x0 + (w - tw) / 2, y0 + (h - size * 0.7) / 2, size);
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
          ? { size: start, lines: wrapLines(body, w - 2 * padX, start, measureText) }
          : fitWrapped(
              body,
              w - 2 * padX,
              h - 2 * padY,
              start,
              measureText,
              MULTILINE_MIN_FONT_SIZE,
            );
      const placed = layoutMultiline({
        x0,
        y0,
        w,
        h,
        size,
        lines,
        anchor: anchorOf(m.anchor),
        padX,
        padY,
        measure: measureText,
      });
      const drawn = toDraw(lines);
      placed.forEach((p, i) => {
        if (p.text !== "") drawLine(drawn[i], p.x, p.y, size);
      });
      onPlacement?.({
        key: m.key,
        page: pageNum,
        multiline: true,
        size,
        startSize: start,
        fits:
          lines.length * size * LINE_HEIGHT_FACTOR <= h - 2 * padY + 0.01 &&
          lines.every((l) => measureText(l, size) <= w - 2 * padX + 0.01),
      });
      return;
    }

    // Single-line text: choose the start size, then shrink horizontally to fit the
    // box width (down to MIN_FONT_SIZE) and place the line at its 9-point anchor. On
    // Auto the start is derived from the box HEIGHT (autoTextStartPt) so short boxes
    // get proportionate text; a pinned size starts at exactly that size.
    const startPt = m.autoFit ? autoTextStartPt(h) : (m.fontSize ?? DEFAULT_FONT_SIZE);
    const size = fitFontSize(body, w - 2 * pad, startPt, measureText);
    const tw = measureText(body, size);
    const { x, y } = anchorPdfXY({
      x0,
      y0,
      w,
      h,
      tw,
      size,
      anchor: anchorOf(m.anchor),
      pad,
    });
    drawLine(toDraw([body])[0], x, y, size);
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

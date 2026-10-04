import type * as PdfLibModule from "pdf-lib";
import type { PDFDict, PDFDocument, PDFObject } from "pdf-lib";

// Flatten the source PDF's own AcroForm before stamping, so the returned PDF is
// flattened. Every widget's current appearance
// (empty text box, unchecked "/Off" box, comb dividers, borders) is baked into the
// page content, then every widget annotation and the /AcroForm dictionary (with any
// XFA) are removed, so nothing in the downloaded PDF stays editable.
//
// Deliberately NOT pdf-lib's `form.flatten()`: it walks the field tree and throws on
// common real-world defects (a widget with no /AP, no /P, a malformed field tree).
// This walks each page's /Annots directly and isolates every widget in its own
// try/catch — a widget that can't be baked is still removed, never fails the export.
//
// Call it right after load and BEFORE drawing marks, so baked appearances (which may
// carry an opaque background) sit under the stamped answers, not on top of them.

type PdfLib = typeof PdfLibModule;

const ANNOT_FLAG_HIDDEN = 1 << 1;
const ANNOT_FLAG_NOVIEW = 1 << 5;

function numbers(pdfLib: PdfLib, obj: PDFObject | undefined, len: number): number[] | null {
  if (!(obj instanceof pdfLib.PDFArray) || obj.size() !== len) return null;
  const out: number[] = [];
  for (let i = 0; i < len; i++) {
    const n = obj.lookup(i);
    if (!(n instanceof pdfLib.PDFNumber)) return null;
    out.push(n.asNumber());
  }
  return out;
}

/**
 * Resolves the widget's normal appearance to an indirect stream ref, or null.
 * State dictionaries (checkbox / radio) pick the /AS state, falling back to /Off.
 */
function appearanceRef(pdfDoc: PDFDocument, pdfLib: PdfLib, widget: PDFDict) {
  const { PDFDict, PDFName, PDFRef, PDFStream } = pdfLib;
  const ap = widget.lookup(PDFName.of("AP"));
  if (!(ap instanceof PDFDict)) return null;
  let n: PDFObject | undefined = ap.get(PDFName.of("N"));
  const resolved = n instanceof PDFRef ? pdfDoc.context.lookup(n) : n;
  if (resolved instanceof PDFDict && !(resolved instanceof PDFStream)) {
    const as = widget.lookup(PDFName.of("AS"));
    n = (as instanceof PDFName ? resolved.get(as) : undefined) ?? resolved.get(PDFName.of("Off"));
  }
  if (n instanceof PDFStream) n = pdfDoc.context.register(n);
  if (!(n instanceof PDFRef)) return null;
  const stream = pdfDoc.context.lookup(n);
  return stream instanceof PDFStream ? { ref: n, stream } : null;
}

/**
 * Removes every form field from `pdfDoc`, baking visible widget appearances into
 * the page content first. Mutates the document; never throws for a bad widget.
 */
export function flattenFormFields(pdfDoc: PDFDocument, pdfLib: PdfLib): void {
  const {
    PDFArray,
    PDFDict,
    PDFName,
    PDFNumber,
    concatTransformationMatrix,
    drawObject,
    popGraphicsState,
    pushGraphicsState,
  } = pdfLib;
  const WIDGET = PDFName.of("Widget");
  // Removed widgets, for pruning the tagged-PDF structure tree afterwards.
  const removedRefs = new Set<PDFObject>();
  const removedStructParents = new Set<number>();

  for (const page of pdfDoc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;

    const kept: PDFObject[] = [];
    let removed = 0;
    for (let i = 0; i < annots.size(); i++) {
      const entry = annots.get(i);
      const annot = annots.lookup(i);
      if (!(annot instanceof PDFDict) || annot.lookup(PDFName.of("Subtype")) !== WIDGET) {
        kept.push(entry);
        continue;
      }
      removed++;
      removedRefs.add(entry);
      const sp = annot.lookup(PDFName.of("StructParent"));
      if (sp instanceof PDFNumber) removedStructParents.add(sp.asNumber());
      try {
        const flags = annot.lookup(PDFName.of("F"));
        const f = flags instanceof PDFNumber ? flags.asNumber() : 0;
        if (f & (ANNOT_FLAG_HIDDEN | ANNOT_FLAG_NOVIEW)) continue;

        const rect = numbers(pdfLib, annot.lookup(PDFName.of("Rect")), 4);
        const ap = appearanceRef(pdfDoc, pdfLib, annot);
        if (!rect || !ap) continue;
        const [rx0, ry0, rx1, ry1] = rect;
        const rx = Math.min(rx0, rx1);
        const ry = Math.min(ry0, ry1);
        const rw = Math.abs(rx1 - rx0);
        const rh = Math.abs(ry1 - ry0);
        if (rw <= 0 || rh <= 0) continue;

        // PDF 32000 §12.5.5: transform the form's /BBox by its /Matrix, then map
        // that box onto /Rect. (The XObject applies its own /Matrix on Do.)
        const bbox = numbers(pdfLib, ap.stream.dict.lookup(PDFName.of("BBox")), 4);
        const m = numbers(pdfLib, ap.stream.dict.lookup(PDFName.of("Matrix")), 6) ?? [
          1, 0, 0, 1, 0, 0,
        ];
        let cm = [1, 0, 0, 1, rx, ry];
        if (bbox) {
          const xs: number[] = [];
          const ys: number[] = [];
          for (const [x, y] of [
            [bbox[0], bbox[1]],
            [bbox[2], bbox[1]],
            [bbox[0], bbox[3]],
            [bbox[2], bbox[3]],
          ]) {
            xs.push(m[0] * x + m[2] * y + m[4]);
            ys.push(m[1] * x + m[3] * y + m[5]);
          }
          const bx = Math.min(...xs);
          const by = Math.min(...ys);
          const bw = Math.max(...xs) - bx;
          const bh = Math.max(...ys) - by;
          if (bw > 0 && bh > 0) {
            const sx = rw / bw;
            const sy = rh / bh;
            cm = [sx, 0, 0, sy, rx - bx * sx, ry - by * sy];
          }
        }

        const key = page.node.newXObject("FlatWidget", ap.ref);
        page.pushOperators(
          pushGraphicsState(),
          concatTransformationMatrix(cm[0], cm[1], cm[2], cm[3], cm[4], cm[5]),
          drawObject(key),
          popGraphicsState(),
        );
      } catch {
        // Unbakeable widget: still removed below (the export must never fail on it).
      }
    }

    if (removed === 0) continue;
    if (kept.length === 0) {
      page.node.delete(PDFName.of("Annots"));
    } else {
      const next = PDFArray.withContext(pdfDoc.context);
      for (const k of kept) next.push(k);
      page.node.set(PDFName.of("Annots"), next);
    }
  }

  // The field tree, NeedAppearances and any XFA all live under /AcroForm.
  pdfDoc.catalog.delete(PDFName.of("AcroForm"));

  if (removedRefs.size > 0) {
    try {
      pruneStructTree(pdfDoc, pdfLib, removedRefs, removedStructParents);
    } catch {
      // Best-effort accessibility cleanup: a malformed tree must never fail the export.
    }
  }
}

/**
 * Tagged PDFs (every USCIS form) point at each widget from the structure tree via an
 * /OBJR kid, keyed back through /ParentTree by the widget's /StructParent. Once the
 * widgets are gone those references dangle (MuPDF: "No common ancestor in structure
 * tree"; accessibility checkers flag it), so drop the /OBJR kids, any structure
 * element they leave empty, and the widgets' /ParentTree entries.
 */
function pruneStructTree(
  pdfDoc: PDFDocument,
  pdfLib: PdfLib,
  removedRefs: ReadonlySet<PDFObject>,
  removedStructParents: ReadonlySet<number>,
): void {
  const { PDFArray, PDFDict, PDFName, PDFNumber } = pdfLib;
  const K = PDFName.of("K");
  const root = pdfDoc.catalog.lookup(PDFName.of("StructTreeRoot"));
  if (!(root instanceof PDFDict)) return;

  const visited = new Set<PDFDict>();
  const isDeadObjr = (kid: PDFObject | undefined): boolean => {
    const d = kid instanceof pdfLib.PDFRef ? pdfDoc.context.lookup(kid) : kid;
    if (!(d instanceof PDFDict) || d.lookup(PDFName.of("Type")) !== PDFName.of("OBJR"))
      return false;
    const target = d.get(PDFName.of("Obj"));
    return target !== undefined && removedRefs.has(target);
  };
  // Prunes `elem`'s /K in place. True when pruning left it with no kids at all (an
  // element that started empty is left alone).
  const prune = (elem: PDFDict): boolean => {
    if (visited.has(elem)) return false;
    visited.add(elem);
    const k = elem.get(K);
    if (k === undefined) return false;
    const kids = k instanceof PDFArray ? k.asArray() : [k];
    const kept = kids.filter((kid) => {
      if (isDeadObjr(kid)) return false;
      const child = pdfDoc.context.lookup(kid);
      // A structure element child (has /S); marked-content ids and MCRs are kept.
      if (child instanceof PDFDict && child.has(PDFName.of("S")) && prune(child)) return false;
      return true;
    });
    if (kept.length === kids.length) return false;
    if (kept.length === 0) {
      elem.delete(K);
      return true;
    }
    elem.set(K, kept.length === 1 ? kept[0] : pdfDoc.context.obj(kept));
    return false;
  };
  prune(root);

  // /ParentTree is a number tree: drop the removed widgets' /StructParent keys.
  const pruneNumberTree = (node: PDFObject | undefined, depth: number): void => {
    if (!(node instanceof PDFDict) || depth > 32) return;
    const nums = node.lookup(PDFName.of("Nums"));
    if (nums instanceof PDFArray) {
      const next = PDFArray.withContext(pdfDoc.context);
      for (let i = 0; i + 1 < nums.size(); i += 2) {
        const key = nums.lookup(i);
        if (key instanceof PDFNumber && removedStructParents.has(key.asNumber())) continue;
        next.push(nums.get(i));
        next.push(nums.get(i + 1));
      }
      node.set(PDFName.of("Nums"), next);
    }
    const kids = node.lookup(PDFName.of("Kids"));
    if (kids instanceof PDFArray) {
      for (let i = 0; i < kids.size(); i++) pruneNumberTree(kids.lookup(i), depth + 1);
    }
  };
  pruneNumberTree(root.lookup(PDFName.of("ParentTree")), 0);
}

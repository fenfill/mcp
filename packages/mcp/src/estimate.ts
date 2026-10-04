// analyze_form(estimate: true): what an analyze would cost, worked out on this
// machine. Nothing is uploaded: the page count and the native-field probe read
// the local PDF (pdf-lib, already in the bundle); the only request is GET
// /v1/account for scans_remaining, and only when a key is configured.

import type { PDFDict as PDFDictT } from "pdf-lib";

import { pagesToSpec } from "./cache.js";
import { log } from "./log.js";
import type { Account } from "./types.js";

/** Button field flag: a push button (no value; never makes a native form). */
const PUSHBUTTON = 1 << 16;
/** How far up /Parent a widget's /FT and /Ff may be inherited. */
const MAX_FIELD_DEPTH = 64;

/**
 * The 1-based pages carrying a fillable native form field: a widget whose
 * field (its own /FT or an ancestor's) is text, choice, signature, or a check
 * box / radio button. The same widget types the server's probe takes
 * (acroform._FILLABLE_TYPES), so a page listed here makes analyze_form a free
 * AcroForm job. Null when the PDF can't be read this way.
 */
export async function nativeFieldPages(pdf: ArrayBuffer): Promise<Set<number> | null> {
  try {
    const { PDFDict, PDFDocument, PDFName, PDFNumber } = await import("pdf-lib");
    const doc = await PDFDocument.load(pdf, { ignoreEncryption: true, updateMetadata: false });
    const WIDGET = PDFName.of("Widget");
    const SUBTYPE = PDFName.of("Subtype");
    const PARENT = PDFName.of("Parent");
    const FT = PDFName.of("FT");
    const FF = PDFName.of("Ff");
    const BTN = PDFName.of("Btn");
    const FILLABLE = new Set([PDFName.of("Tx"), PDFName.of("Ch"), PDFName.of("Sig")]);
    const out = new Set<number>();
    doc.getPages().forEach((page, i) => {
      const annots = page.node.Annots();
      if (!annots) return;
      for (let k = 0; k < annots.size(); k++) {
        const a = annots.lookup(k);
        if (!(a instanceof PDFDict) || a.lookup(SUBTYPE) !== WIDGET) continue;
        let ft: unknown;
        let ff: unknown;
        let node: PDFDictT | undefined = a;
        for (let d = 0; node && d < MAX_FIELD_DEPTH; d++) {
          if (ft === undefined && node.has(FT)) ft = node.lookup(FT);
          if (ff === undefined && node.has(FF)) ff = node.lookup(FF);
          const p: unknown = node.lookup(PARENT);
          node = p instanceof PDFDict ? p : undefined;
        }
        const flags = ff instanceof PDFNumber ? ff.asNumber() : 0;
        if (
          (ft instanceof PDFName && FILLABLE.has(ft)) ||
          (ft === BTN && (flags & PUSHBUTTON) === 0)
        ) {
          out.add(i + 1);
          break;
        }
      }
    });
    return out;
  } catch {
    return null;
  }
}

export interface EstimateInput {
  pdf: ArrayBuffer;
  pageCount: number | null;
  /** The requested pages, or null for every page. */
  requested: number[] | null;
  /** Already analyzed on this machine for this request (free). */
  cached: boolean;
  /** detect_extra_blanks: an AcroForm PDF then costs one scan per chosen page. */
  detectExtraBlanks?: boolean;
  /** GET /v1/account, or null without a usable key / on failure. */
  account: () => Promise<Account | null>;
}

export interface Estimate {
  status: "estimate";
  page_count: number | null;
  pages: string;
  likely_mode: "acroform" | "ai" | "cached";
  estimated_scans: number;
  scans_remaining: number | null;
  native_field_pages?: string;
  /** AcroForm + the paid extra-blank pass. */
  detect_extra_blanks?: true;
  note: string;
}

/** What analyze_form would charge for this request, without uploading anything. */
export async function estimateAnalyze(e: EstimateInput): Promise<Estimate> {
  const all = e.pageCount ? Array.from({ length: e.pageCount }, (_, i) => i + 1) : [];
  const chosen = e.requested ?? all;
  const native = await nativeFieldPages(e.pdf);
  const nativeChosen = native ? chosen.filter((p) => native.has(p)) : [];
  let account: Account | null = null;
  try {
    account = await e.account();
  } catch {
    log("warn", "estimate: account lookup failed", {});
  }
  const remaining = typeof account?.scans_remaining === "number" ? account.scans_remaining : null;
  const base = {
    status: "estimate" as const,
    page_count: e.pageCount,
    pages: pagesToSpec(chosen),
    scans_remaining: remaining,
    ...(native && native.size
      ? { native_field_pages: pagesToSpec([...native].sort((a, b) => a - b)) }
      : {}),
  };
  if (e.cached) {
    return {
      ...base,
      likely_mode: "cached",
      estimated_scans: 0,
      note: "Already analyzed on this machine: analyze_form returns it free.",
    };
  }
  if (nativeChosen.length > 0 && !e.detectExtraBlanks) {
    return {
      ...base,
      likely_mode: "acroform",
      estimated_scans: 0,
      note: "The chosen pages have native form fields, so analyze_form reads those fields for free (no scans).",
    };
  }
  const scans = chosen.length;
  const extra = nativeChosen.length > 0;
  const notes = [
    extra
      ? `The native form fields are read free; detect_extra_blanks adds a scan of each chosen page for blanks without a native field: ${String(scans)} in all.`
      : `AI analysis: one scan per page, ${String(scans)} in all.`,
  ];
  if (!extra && e.detectExtraBlanks) {
    notes.push(
      "detect_extra_blanks changes nothing here: an AI analysis already looks at every blank.",
    );
  }
  if (account && e.requested === null && e.pageCount && e.pageCount > account.max_pages) {
    notes.push(
      `The PDF is longer than the plan's ${String(account.max_pages)}-page window: pass pages to analyze part of it.`,
    );
  }
  if (account && scans > account.max_pages_per_job) {
    notes.push(
      `One analyze covers at most ${String(account.max_pages_per_job)} pages: split it into several calls with pages.`,
    );
  }
  if (remaining !== null && remaining < scans) {
    notes.push(`Only ${String(remaining)} scans are left: analyze fewer pages.`);
  }
  if (remaining === null)
    notes.push("scans_remaining is unknown (no API key, or the lookup failed).");
  notes.push("Pages with nothing to fill cost a scan too: pass only the pages with blanks.");
  return {
    ...base,
    likely_mode: extra ? "acroform" : "ai",
    ...(extra ? { detect_extra_blanks: true } : {}),
    estimated_scans: scans,
    note: notes.join(" "),
  };
}

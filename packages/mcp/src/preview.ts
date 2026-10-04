// preview_page: the check copy of one page as a PNG, built and rendered in
// memory. The check copy is fill_form's own (fillAgentPdf with `check`):
// every field box outlined in its status colour and tagged with its short id,
// with the values stamped when the agent passes them.
//
// PRIVACY: the stamped PDF and the image exist only in this process's memory
// and in the tool result returned to the calling client. Nothing is written to
// disk and nothing is sent anywhere.

import { agentEntries, fillAgentPdf, normalizeSchema } from "@/app/t/[template_id]/fillCore";
import { shortIds } from "@/app/t/[template_id]/agentValues";

import { ToolError } from "./errors.js";
import {
  fillForbiddenError,
  isFillForbiddenError,
  isPasswordError,
  loadImage,
  passwordError,
} from "./fill.js";
import type { Fonts } from "./fonts.js";
import { toArrayBuffer } from "./fonts.js";
import { DEFAULT_DPI, encodePng, MAX_DPI, MIN_DPI, renderPage } from "./render.js";
import type { RenderSchema } from "./types.js";

export interface PreviewArgs {
  pdfBytes: Uint8Array;
  render: RenderSchema;
  page: number;
  values: Record<string, unknown>;
  dpi?: number;
  fonts: Fonts;
}

export interface LegendRow {
  tag: string;
  id: string;
  type: string;
  label: string;
  /** Fractions of the page, top-left origin (the edit_template convention). */
  box: { x: number; y: number; w: number; h: number };
  /** Options of a radio/multiselect group: their own tags. */
  options?: { tag: string; id: string; label: string }[];
}

export interface Preview {
  png: Uint8Array;
  width: number;
  height: number;
  dpi: number;
  legend: LegendRow[];
  filled: number;
  skipped: { id: string; reason: string }[];
  warnings: string[];
}

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

interface Pct {
  xpct: number;
  ypct: number;
  wpct: number;
  hpct: number;
}

function boxOf(fs: readonly Pct[]): LegendRow["box"] | null {
  if (!fs.length) return null;
  const x0 = Math.min(...fs.map((f) => f.xpct));
  const y0 = Math.min(...fs.map((f) => f.ypct));
  const x1 = Math.max(...fs.map((f) => f.xpct + f.wpct));
  const y1 = Math.max(...fs.map((f) => f.ypct + f.hpct));
  return { x: r4(x0 / 100), y: r4(y0 / 100), w: r4((x1 - x0) / 100), h: r4((y1 - y0) / 100) };
}

const topId = (id: string): string => id.split(/[.[]/, 1)[0];

export async function previewPage(a: PreviewArgs): Promise<Preview> {
  const dpi = Math.min(MAX_DPI, Math.max(MIN_DPI, Math.round(a.dpi ?? DEFAULT_DPI)));
  const schema = normalizeSchema(a.render as unknown as Parameters<typeof normalizeSchema>[0]);
  const pages = schema.pages.map((p) => p.page);
  if (!pages.includes(a.page)) {
    throw new ToolError("invalid_page", `Page ${String(a.page)} has no analyzed fields.`, {
      hint: `Pages with fields: ${pages.join(", ") || "none"}.`,
    });
  }
  let res: Awaited<ReturnType<typeof fillAgentPdf>>;
  try {
    res = await fillAgentPdf({
      pdfBytes: toArrayBuffer(a.pdfBytes),
      render: a.render,
      input: a.values,
      fonts: a.fonts,
      branding: null,
      logoBytes: null,
      loadImage,
      check: true,
    });
  } catch (e) {
    if (isPasswordError(e)) throw passwordError();
    if (isFillForbiddenError(e)) throw fillForbiddenError();
    throw e;
  }
  if (!res.checkPdf) throw new ToolError("internal_error", "The check copy could not be built.");

  // The legend: the same short tags the check copy prints (shortIds over every
  // outlined id: entries plus radio/multiselect options).
  const entries = agentEntries(schema);
  const allIds: string[] = [];
  for (const e of entries) {
    allIds.push(e.id);
    if (e.kind === "choice") for (const o of e.options) allIds.push(o.id);
  }
  const short = shortIds(allIds);
  const onPage = entries.filter((e) =>
    e.kind === "field" ? e.field.page === a.page : e.group.page === a.page,
  );
  const legend: LegendRow[] = [];
  for (const e of onPage) {
    const box = boxOf(e.kind === "field" ? [e.field] : e.members);
    if (!box) continue;
    const row: LegendRow = {
      tag: short.get(e.id) ?? e.id,
      id: e.id,
      type: e.type,
      label: e.label,
      box,
    };
    if (e.kind === "choice") {
      row.options = e.options.map((o) => ({
        tag: short.get(o.id) ?? o.id,
        id: o.id,
        label: typeof o.label === "string" ? o.label : "",
      }));
    }
    legend.push(row);
  }
  const ids = new Set(onPage.map((e) => e.id));
  const skipped = res.skipped.filter((s) => ids.has(topId(s.id)));
  const warnings = res.warnings.filter((w) => {
    const head = w.slice(0, Math.max(0, w.indexOf(":")));
    return head.split(" and ").some((id) => ids.has(topId(id.trim())));
  });

  const raster = await renderPage(res.checkPdf, a.page, dpi);
  return {
    png: encodePng(raster),
    width: raster.width,
    height: raster.height,
    dpi,
    legend,
    filled: res.filled,
    skipped,
    warnings,
  };
}

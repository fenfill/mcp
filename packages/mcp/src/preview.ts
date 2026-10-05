// preview_page: the check copy of one page as a PNG, built and rendered in
// memory. The check copy is fill_form's own (fillAgentPdf with `check`):
// every field box outlined in its status colour and tagged with its short id,
// with the values stamped when the agent passes them.
//
// PRIVACY: the stamped PDF and the image exist only in this process's memory
// and in the tool result returned to the calling client. Nothing is written to
// disk and nothing is sent anywhere.

import { checkTagIds, shortIds } from "@/app/t/[template_id]/agentValues";
import {
  agentEntries,
  buildFieldById,
  expBodyRows,
  fillAgentPdf,
  normalizeSchema,
} from "@/app/t/[template_id]/fillCore";

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
import { DEFAULT_DPI, encodePng, MAX_DPI, MIN_DPI, type Region, renderPage } from "./render.js";
import type { RenderSchema } from "./types.js";

export interface PreviewArgs {
  pdfBytes: Uint8Array;
  render: RenderSchema;
  page: number;
  values: Record<string, unknown>;
  dpi?: number;
  fonts: Fonts;
  /** Render only this region of the page (fractions, top-left origin). */
  crop?: Region;
  /** With crop: magnify (dpi × zoom, the image still capped at 3000 px). */
  zoom?: number;
}

/** The most a crop may magnify. */
export const MAX_ZOOM = 8;

export interface LegendRow {
  tag: string;
  id: string;
  type: string;
  label: string;
  /** Fractions of the page, top-left origin (the edit_template convention). */
  box: { x: number; y: number; w: number; h: number };
  /** Options of a radio/multiselect group: their own tags and tick boxes. */
  options?: { tag: string; id: string; label: string; box: LegendRow["box"] }[];
  /** A table's cells by (row, col), 0-based, with their own tags and boxes. */
  cells?: {
    tag: string;
    id: string;
    row: number;
    col: number;
    type: string;
    label: string;
    box: LegendRow["box"];
  }[];
  /** A table's typing: which axis drives the types, and the headers. */
  orientation?: "col" | "row";
  header_cols?: string[];
  header_rows?: string[];
  /** An expandable table's columns (fill values key rows by these ids); box = the first row's cell. */
  columns?: { tag: string; id: string; label: string; type: string; box: LegendRow["box"] }[];
  /** A text/date field's stored format (variant, date_format, font_size, text_anchor…). */
  format?: Record<string, unknown>;
  /** A single-line text/date field: the size its value starts at, and whether that follows the box (Auto). */
  font_pt?: number;
  font_auto?: boolean;
  /** legend "changed": how many cells/options/columns of this row changed (the lists then hold only those). */
  members_changed?: number;
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

/**
 * The legend of one page: every entry outlined on it with its tag (the same
 * short tags the check copy prints: shortIds over checkTagIds), type, label and
 * box, plus options, table cells and table typing. Pure.
 */
export function legendRows(render: RenderSchema, page: number): LegendRow[] {
  const schema = normalizeSchema(render as unknown as Parameters<typeof normalizeSchema>[0]);
  const entries = agentEntries(schema);
  const short = shortIds(checkTagIds(entries));
  const onPage = entries.filter((e) =>
    e.kind === "field" ? e.field.page === page : e.group.page === page,
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
    if (e.kind === "field") {
      const fmt = (e.field as { format?: unknown }).format;
      if (fmt && typeof fmt === "object" && !Array.isArray(fmt) && Object.keys(fmt).length) {
        row.format = fmt as Record<string, unknown>;
      }
    }
    if (e.kind === "choice") {
      row.options = e.options.map((o) => ({
        tag: short.get(o.id) ?? o.id,
        id: o.id,
        label: typeof o.label === "string" ? o.label : "",
        box: boxOf([o])!,
      }));
    }
    if (e.kind === "table" || e.kind === "table_rows") {
      const g = e.group as { orientation?: unknown; header_cols?: unknown; header_rows?: unknown };
      row.orientation = g.orientation === "row" ? "row" : "col";
      const strs = (v: unknown) =>
        Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : "")) : [];
      if (strs(g.header_cols).some(Boolean)) row.header_cols = strs(g.header_cols);
      if (strs(g.header_rows).some(Boolean)) row.header_rows = strs(g.header_rows);
    }
    if (e.kind === "table") {
      row.cells = e.cells.map((c) => ({
        tag: short.get(c.id) ?? c.id,
        id: c.id,
        row: c.row,
        col: c.col,
        type: c.type,
        label: c.label,
        box: boxOf([c.field])!,
      }));
    }
    if (e.kind === "table_rows") {
      row.columns = e.columns.map((c) => ({
        tag: short.get(c.id) ?? c.id,
        id: c.id,
        label: c.label,
        type: c.type,
        box: boxOf([c.field])!,
      }));
      // The printed rows' cells (geometry only: fill values go by column id).
      const body = expBodyRows(
        e.group as unknown as Parameters<typeof expBodyRows>[0],
        buildFieldById(schema.fields),
      );
      const colOf = new Map(e.columns.map((c, i) => [c.id, i]));
      const cells: NonNullable<LegendRow["cells"]> = [];
      body.forEach((rowFields, r) =>
        rowFields.forEach((m, c) => {
          if (!m) return;
          const col = body[0]?.[c] ? (colOf.get(body[0][c]!.id) ?? c) : c;
          cells.push({
            tag: short.get(m.id) ?? m.id,
            id: m.id,
            row: r,
            col,
            type: e.columns[col]?.type ?? "text",
            label: typeof m.label === "string" ? m.label : "",
            box: boxOf([m])!,
          });
        }),
      );
      if (cells.length) row.cells = cells;
    }
    legend.push(row);
  }
  return legend;
}

type Member = { id: string };
const membersOf = (r: LegendRow): Member[] => [
  ...(r.options ?? []),
  ...(r.cells ?? []),
  ...(r.columns ?? []),
];

/**
 * What legend: "changed" compares: each row's own properties (everything but
 * its tag and member lists) under its id, and each option/cell/column under
 * `rowId/memberId`, so a header edit doesn't list every cell of the table.
 */
export function legendPrints(rows: readonly LegendRow[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    const { tag: _tag, options: _o, cells: _c, columns: _cols, ...own } = r;
    out.set(r.id, JSON.stringify(own));
    for (const m of membersOf(r)) {
      const { tag: _t, ...rest } = m as Member & { tag?: string };
      out.set(`${r.id}/${m.id}`, JSON.stringify(rest));
    }
  }
  return out;
}

/**
 * Rows of `now` that differ from (or are missing in) `before` (legendPrints),
 * each listing only its changed members; ids `before` had at the top level
 * that are gone (`removed`), or now sit inside another row (`moved_into`:
 * a field adopted into a table, or grouped into a choice).
 */
export function legendChanges(
  before: ReadonlyMap<string, string>,
  now: readonly LegendRow[],
): { changed: LegendRow[]; removed: string[]; moved_into: { id: string; into: string }[] } {
  const prints = legendPrints(now);
  const changed: LegendRow[] = [];
  const parent = new Map<string, string>();
  for (const r of now) {
    for (const m of membersOf(r)) parent.set(m.id, r.id);
    const own = before.get(r.id) !== prints.get(r.id);
    const differs = (m: Member) => before.get(`${r.id}/${m.id}`) !== prints.get(`${r.id}/${m.id}`);
    const n = membersOf(r).filter(differs).length;
    if (!own && n === 0) continue;
    const row: LegendRow = { ...r };
    if (r.options) row.options = r.options.filter(differs);
    if (r.cells) row.cells = r.cells.filter(differs);
    if (r.columns) row.columns = r.columns.filter(differs);
    for (const k of ["options", "cells", "columns"] as const) {
      if (row[k]?.length === 0) delete row[k];
    }
    row.members_changed = n;
    changed.push(row);
  }
  const top = new Set(now.map((r) => r.id));
  const removed: string[] = [];
  const moved: { id: string; into: string }[] = [];
  for (const id of before.keys()) {
    if (id.includes("/") || top.has(id)) continue;
    const into = parent.get(id);
    if (into) moved.push({ id, into });
    else removed.push(id);
  }
  return { changed, removed, moved_into: moved };
}

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
      // preview_page's JSON carries the colour key; the banner would only
      // cover the top of page 1.
      checkBanner: false,
    });
  } catch (e) {
    if (isPasswordError(e)) throw passwordError();
    if (isFillForbiddenError(e)) throw fillForbiddenError();
    throw e;
  }
  if (!res.checkPdf) throw new ToolError("internal_error", "The check copy could not be built.");

  const legend = legendRows(a.render, a.page);
  const ids = new Set(legend.map((r) => r.id));
  const skipped = res.skipped.filter((s) => ids.has(topId(s.id)));
  const warnings = res.warnings.filter((w) => {
    const head = w.slice(0, Math.max(0, w.indexOf(":")));
    return head.split(" and ").some((id) => ids.has(topId(id.trim())));
  });

  const zoom = a.crop ? Math.min(MAX_ZOOM, Math.max(1, a.zoom ?? 2)) : 1;
  const raster = await renderPage(res.checkPdf, a.page, dpi * zoom, a.crop);
  // A crop's legend lists only what it shows.
  const shown = a.crop
    ? legend.filter((r) => {
        const c = a.crop!;
        return (
          r.box.x < c.x + c.w &&
          c.x < r.box.x + r.box.w &&
          r.box.y < c.y + c.h &&
          c.y < r.box.y + r.box.h
        );
      })
    : legend;
  return {
    png: encodePng(raster),
    width: raster.width,
    height: raster.height,
    dpi: dpi * zoom,
    legend: shown,
    filled: res.filled,
    skipped,
    warnings,
  };
}

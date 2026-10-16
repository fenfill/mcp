// preview_page: the check copy of one page as a PNG, built and rendered in
// memory. The check copy is fill_form's own (fillAgentPdf with `check`):
// every field box outlined in its status colour and tagged with its short id,
// with the values stamped when the agent passes them. `overlay` takes the
// tags away ("outline"), or the whole check copy ("none": the stamped page as
// a fill writes it), for when a tag or an outline covers what must be read.
//
// PRIVACY: the stamped PDF and the image exist only in this process's memory
// and in the tool result returned to the calling client. Nothing is written to
// disk and nothing is sent anywhere.

import { checkTagIds, shortIds } from "@/app/t/[template_id]/agentValues";
import { dateFormatOf } from "@/types";
import {
  agentEntries,
  buildFieldById,
  expBodyRows,
  fillAgentPdf,
  normalizeSchema,
} from "@/app/t/[template_id]/fillCore";

import { ToolError } from "./errors.js";
import {
  checkCopyFailed,
  fillForbiddenError,
  isFillForbiddenError,
  isPasswordError,
  loadImage,
  passwordError,
} from "./fill.js";
import type { Fonts } from "./fonts.js";
import { toArrayBuffer } from "./fonts.js";
import {
  DEFAULT_DPI,
  encodePng,
  MAX_DPI,
  MIN_DPI,
  printedBoxes,
  type Region,
  renderPage,
} from "./render.js";
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
  /** With crop: magnify (dpi × zoom, the image still capped at PREVIEW_MAX_SIDE_PX). */
  zoom?: number;
  /** What is drawn over the page (default "full"). */
  overlay?: Overlay;
}

/** "full": every box outlined and tagged, table headers printed. "outline":
 *  the boxes only. "none": nothing, the page as a fill stamps it. */
export const OVERLAYS = ["full", "outline", "none"] as const;
export type Overlay = (typeof OVERLAYS)[number];

/** The most a crop may magnify. */
export const MAX_ZOOM = 8;

/**
 * A preview's longest side, in pixels. A client shrinks a larger image before
 * the model sees it (the API takes no side over 2000 px once a conversation
 * holds more than 20 images), and the agent then reads positions off a
 * smaller image than the width and height this tool reported. Staying at the
 * limit keeps the two the same. Snap renders (snap.ts) keep render.ts's cap.
 */
export const PREVIEW_MAX_SIDE_PX = 2000;

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
    date_format?: string;
  }[];
  /** A table's typing: which axis drives the types, and the headers. */
  orientation?: "col" | "row";
  header_cols?: string[];
  header_rows?: string[];
  /** An expandable table's columns (fill values key rows by these ids); box = the first row's cell. */
  columns?: {
    tag: string;
    id: string;
    label: string;
    type: string;
    box: LegendRow["box"];
    date_format?: string;
  }[];
  /** A text/date field's stored format (variant, date_format, font_size, text_anchor…). */
  format?: Record<string, unknown>;
  /** A date field, table date cell or date comb: the format it prints (the default when unset). */
  date_format?: string;
  /** A comb: what its cells take, how many characters, and each printed cell in
   *  reading order (index: the cell of a member that spans several; date_part:
   *  the date_format letter a date comb's cell holds). preview_page lists the
   *  cells only in a crop. */
  cell_type?: string;
  max_length?: number;
  comb_cells?: { tag: string; index?: number; box: LegendRow["box"]; date_part?: string }[];
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
  /** The resolution the image was rendered at: dpi × zoom as asked, or less
   *  when its longest side hit the size cap. */
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

/** The printed cells of a comb's members in reading order (members come in
 *  resolveMembers order): a member over several cells gives each of them, with
 *  its index; any other member is one cell, its own box. */
function combCells(
  members: readonly (Pct & { id: string; cells?: unknown })[],
): { id: string; index?: number; box: LegendRow["box"] }[] {
  const out: { id: string; index?: number; box: LegendRow["box"] }[] = [];
  for (const m of members) {
    const cells = Array.isArray(m.cells)
      ? (m.cells as { x: number; y: number; w: number; h: number }[])
      : [];
    if (cells.length > 1) {
      cells.forEach((c, index) => {
        out.push({
          id: m.id,
          index,
          box: { x: r4(c.x / 100), y: r4(c.y / 100), w: r4(c.w / 100), h: r4(c.h / 100) },
        });
      });
    } else out.push({ id: m.id, box: boxOf([m])! });
  }
  return out;
}

const topId = (id: string): string => id.split(/[.[]/, 1)[0];

/** The page of every id a value key can name: an entry's own, and through its
 *  entry an option's, a table cell's or an expandable table's column's. */
function idPages(entries: ReturnType<typeof agentEntries>): Map<string, number> {
  const pages = new Map<string, number>();
  for (const e of entries) {
    const page = e.kind === "field" ? e.field.page : e.group.page;
    pages.set(e.id, page);
    const inner =
      e.kind === "choice"
        ? e.options
        : e.kind === "table"
          ? e.cells
          : e.kind === "table_rows"
            ? e.columns
            : [];
    for (const x of inner) if (!pages.has(x.id)) pages.set(x.id, page);
  }
  return pages;
}

/**
 * The legend of one page: every entry outlined on it with its tag (the same
 * short tags the check copy prints: shortIds over checkTagIds), type, label and
 * box, plus options, table cells and table typing. Pure.
 */
export function legendRows(render: RenderSchema, page: number): LegendRow[] {
  const schema = normalizeSchema(render as unknown as Parameters<typeof normalizeSchema>[0]);
  const entries = agentEntries(schema);
  const short = shortIds(checkTagIds(entries));
  // Comb cells get tags of their own, unique among every id, so the other tags
  // keep the lengths the check copy prints.
  let combShort: Map<string, string> | null = null;
  const combTag = (id: string): string => {
    combShort ??= shortIds([
      ...checkTagIds(entries),
      ...entries.flatMap((e) => (e.kind === "comb" ? e.members.map((m) => m.id) : [])),
    ]);
    return combShort.get(id) ?? id;
  };
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
      if (e.type === "date") row.date_format = dateFormatOf(e.field);
      if (e.type === "comb") {
        // A field drawn over several printed cells: it takes one character per
        // cell, as typed (a date too: no date_format lays it out), as
        // get_template lists it.
        row.max_length = combCells([e.field]).length;
        row.comb_cells = combCells([e.field]).map((c) => ({
          tag: combTag(c.id),
          index: c.index,
          box: c.box,
        }));
      }
    }
    if (e.kind === "comb") {
      row.cell_type = e.cellType;
      row.max_length = e.maxLength;
      if (e.dateFormat) row.date_format = e.dateFormat;
      const fmt = e.dateFormat ?? "";
      row.comb_cells = combCells(e.members).map((c, i) => ({
        tag: combTag(c.id),
        ...(c.index !== undefined ? { index: c.index } : {}),
        box: c.box,
        ...(fmt.length === e.maxLength && fmt[i] ? { date_part: fmt[i] } : {}),
      }));
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
        ...(c.type === "date" ? { date_format: dateFormatOf(c.field) } : {}),
      }));
    }
    if (e.kind === "table_rows") {
      row.columns = e.columns.map((c) => ({
        tag: short.get(c.id) ?? c.id,
        id: c.id,
        label: c.label,
        type: c.type,
        box: boxOf([c.field])!,
        ...(c.type === "date" ? { date_format: dateFormatOf(c.field) } : {}),
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
type CombCell = NonNullable<LegendRow["comb_cells"]>[number];
/** A comb cell's key in legendPrints: where it is on the page, not its tag (a
 *  tag's length follows every other id, so an unrelated add changes it) nor
 *  its place in the comb (one cell added at the front would shift them all).
 *  A cell that moved is listed as changed: its old key is not in `before`. */
const combKey = (c: CombCell): string =>
  `cell@${c.box.x.toFixed(4)},${c.box.y.toFixed(4)}` +
  (c.index !== undefined ? `#${String(c.index)}` : "");
/** A row's options, cells, columns and comb cells. */
const membersOf = (r: LegendRow): Member[] => [
  ...(r.options ?? []),
  ...(r.cells ?? []),
  ...(r.columns ?? []),
  ...(r.comb_cells ?? []).map((c) => ({ ...c, id: combKey(c) })),
];

/**
 * What legend: "changed" compares: each row's own properties (everything but
 * its tag and member lists) under its id, and each option/cell/column under
 * `rowId/memberId`, so a header edit doesn't list every cell of the table.
 */
export function legendPrints(rows: readonly LegendRow[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    const { tag: _tag, options: _o, cells: _c, columns: _cols, comb_cells: _cc, ...own } = r;
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
    if (r.comb_cells) row.comb_cells = r.comb_cells.filter((c) => differs({ id: combKey(c) }));
    for (const k of ["options", "cells", "columns", "comb_cells"] as const) {
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
    // A comb cell is listed by its tag: a field grouped into a comb is found by it.
    const into =
      parent.get(id) ?? now.find((r) => r.comb_cells?.some((c) => id.startsWith(c.tag)))?.id;
    if (into) moved.push({ id, into });
    else removed.push(id);
  }
  return { changed, removed, moved_into: moved };
}

export async function previewPage(a: PreviewArgs): Promise<Preview> {
  const dpi = Math.min(MAX_DPI, Math.max(MIN_DPI, Math.round(a.dpi ?? DEFAULT_DPI)));
  const overlay = a.overlay ?? "full";
  const schema = normalizeSchema(a.render as unknown as Parameters<typeof normalizeSchema>[0]);
  const pages = schema.pages.map((p) => p.page);
  if (!pages.includes(a.page)) {
    throw new ToolError("invalid_page", `Page ${String(a.page)} has no analyzed fields.`, {
      hint: `Pages with fields: ${pages.join(", ") || "none"}.`,
    });
  }
  // The tags keep off the page's print (the blank's text layer; none on a scan).
  const printed = overlay === "full" ? await printedBoxes(a.pdfBytes, [a.page]) : undefined;
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
      // "none" shows the stamped PDF itself: no check copy is built, so none can fail.
      check: overlay !== "none",
      // preview_page's JSON carries the colour key; the banner would only
      // cover the top of page 1.
      checkBanner: false,
      checkTags: overlay === "full",
      checkPrinted: printed,
    });
  } catch (e) {
    if (isPasswordError(e)) throw passwordError();
    if (isFillForbiddenError(e)) throw fillForbiddenError();
    throw e;
  }
  const shown = overlay === "none" ? res.pdf : res.checkPdf;
  if (!shown) {
    // The build says where it stopped (stage, and the id it was drawing), so
    // the caller can correct that one field or group and preview again.
    const err = res.checkError;
    throw new ToolError("check_copy_failed", checkCopyFailed(err), {
      hint: err?.id
        ? `Fix or remove ${err.id} with edit_template, then preview again.`
        : "Preview again; if it persists, fill_form / fill_template still write the filled PDF, without a check copy.",
      details: { stage: err?.stage, id: err?.id },
    });
  }

  const legend = legendRows(a.render, a.page);
  const ids = new Set(legend.map((r) => r.id));
  // A skip is this page's when its entry is on the page. A key that names
  // nothing in the form is nobody's, so it is reported too: a mistyped or
  // ambiguous id would otherwise vanish without a word on every page.
  const where = idPages(agentEntries(schema));
  const skipped = res.skipped.filter((s) => {
    const top = topId(s.id);
    const page = where.get(top);
    return ids.has(top) || page === undefined || page === a.page;
  });
  const warnings = res.warnings.filter((w) => {
    const head = w.slice(0, Math.max(0, w.indexOf(":")));
    return head.split(" and ").some((id) => ids.has(topId(id.trim())));
  });

  const zoom = a.crop ? Math.min(MAX_ZOOM, Math.max(1, a.zoom ?? 2)) : 1;
  const raster = await renderPage(shown, a.page, dpi * zoom, a.crop, PREVIEW_MAX_SIDE_PX);
  // A crop's legend lists only what it shows.
  const listed = a.crop
    ? legend.filter((r) => {
        const c = a.crop!;
        return (
          r.box.x < c.x + c.w &&
          c.x < r.box.x + r.box.w &&
          r.box.y < c.y + c.h &&
          c.y < r.box.y + r.box.h
        );
      })
    : // A whole page lists its combs without their cells: a dense page's
      // legend would outgrow what a client takes in one result (the PL licence
      // page 1, 74 fields, passed 25k tokens). A crop lists them.
      legend.map((r) => {
        if (!r.comb_cells) return r;
        const { comb_cells: _cells, ...rest } = r;
        return rest;
      });
  return {
    png: encodePng(raster),
    width: raster.width,
    height: raster.height,
    // What was rendered, not what was asked: a capped image is coarser, and
    // an agent reads sizes off it.
    dpi: Math.round(raster.scale * 72 * 10) / 10,
    legend: listed,
    filled: res.filled,
    skipped,
    warnings,
  };
}

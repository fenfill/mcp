// Table ops for edit_template, mirroring the web editor's table semantics:
// grouping.ts (reconstructGrid / buildTableGroup), the editor store's table
// actions (deleteTableLine / removeTableLine / setTableOrientation /
// addMembersAutosort) and TableAxisEditor (a whole driving-axis line is typed
// at once). The Single-Axis Data Type rule (types.ts) holds after every op: the
// driving axis (orientation, default "col") carries the types and every cell of
// one driving line shares a type; checkbox_matrix is all checkbox.
//
// The grid (rows × cols of field ids, null = empty slot) is the layout's source
// of truth. Boxes are percent of the page here, like the render schema.

import { randomUUID } from "node:crypto";

import { median as upperMedian } from "@/app/t/[template_id]/coords";
import { DATE_FORMATS } from "@/types";

import {
  bad,
  boxArg,
  type Doc,
  type Field,
  type Group,
  isRec,
  members,
  needField,
  needGroup,
  pushField,
  removeFields,
  removeGroup,
  resolveId,
} from "./doc.js";
import type { Issue } from "./validate.js";

type Axis = "col" | "row";
type Grid = (string | null)[][];

export const TABLE_FORMATS = ["classic", "expandable", "checkbox_matrix"] as const;

/**
 * The data types a driving line can take, and the field patch each one sets —
 * a copy of TableAxisEditor.tsx `patchForDataType` (keep the two in step).
 */
export const COLUMN_TYPES = ["text", "number", "currency", "date", "checkbox"] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

interface TypeAndFormat {
  type: string;
  format?: Record<string, unknown>;
}

function patchForDataType(t: ColumnType, dateFormat?: string): TypeAndFormat {
  switch (t) {
    case "text":
      return { type: "text", format: { variant: "any" } };
    case "number":
      return { type: "text", format: { variant: "number" } };
    case "currency":
      return { type: "text", format: { variant: "currency" } };
    case "date":
      return { type: "date", ...(dateFormat ? { format: { date_format: dateFormat } } : {}) };
    case "checkbox":
      return { type: "checkbox", format: { shape: "square", symbol: "✗" } };
  }
}

const DEFAULT_TEXT: TypeAndFormat = { type: "text", format: { variant: "any" } };

function variantOf(f: Field): string {
  return isRec(f.format) && typeof f.format.variant === "string" ? f.format.variant : "any";
}

/** Plain text/any: loses to any typed cell (normalizeSchema isDefaultText). */
function isDefaultText(f: Field): boolean {
  return f.type === "text" && variantOf(f) === "any";
}

/** What "the same type" means along a driving line. */
function typeKey(f: Field): string {
  return f.type === "text" ? `text:${variantOf(f)}` : String(f.type);
}

/** The agent-facing data type of a cell (number/currency/multiline are text variants). */
export function dataTypeOf(f: Field): string {
  if (f.type === "text") {
    const v = variantOf(f);
    return v === "any" ? "text" : v;
  }
  return String(f.type);
}

function setCellType(f: Field, tf: TypeAndFormat): void {
  f.type = tf.type as Field["type"];
  if (tf.format) f.format = structuredClone(tf.format);
  else delete f.format;
  delete f.primitive;
  delete f.signing_requirement;
}

function sameType(f: Field, tf: TypeAndFormat): boolean {
  const probe = { type: tf.type, format: tf.format } as Field;
  return typeKey(f) === typeKey(probe);
}

// ─── The table view ──────────────────────────────────────────────────────────

export interface TableView {
  g: Group;
  grid: Grid;
  rows: number;
  cols: number;
  /** the driving axis */
  axis: Axis;
  format: (typeof TABLE_FORMATS)[number];
}

function formatOf(g: Group): TableView["format"] {
  return g.format === "expandable" || g.format === "checkbox_matrix" ? g.format : "classic";
}

/** Is `grid` a usable layout for these members (every member placed once, nothing else)? */
function gridCovers(grid: unknown, ids: ReadonlySet<string>): grid is Grid {
  if (!Array.isArray(grid) || grid.length === 0) return false;
  const seen = new Set<string>();
  for (const row of grid) {
    if (!Array.isArray(row)) return false;
    for (const c of row) {
      if (c === null) continue;
      if (typeof c !== "string" || !ids.has(c) || seen.has(c)) return false;
      seen.add(c);
    }
  }
  return seen.size === ids.size;
}

/**
 * A table group's layout. A table whose grid is missing or doesn't match its
 * members (legacy templates) gets one rebuilt from geometry, as the editor's
 * "rebuild grid from layout" does; the rebuild is noted in `warnings`.
 */
export function tableView(d: Doc, g: Group, warnings: string[]): TableView {
  if (g.kind !== "table") bad(`${g.id} is a ${String(g.kind)} group, not a table`);
  const ms = members(d, g);
  const ids = new Set(ms.map((m) => m.id));
  let grid: Grid;
  if (gridCovers(g.grid, ids)) {
    grid = (g.grid as Grid).map((r) => [...r]);
  } else {
    grid = reconstructGrid(ms).grid;
    warnings.push(`table ${g.id} had no usable grid; it was rebuilt from the cells' layout`);
  }
  const cols = Math.max(0, ...grid.map((r) => r.length));
  for (const r of grid) while (r.length < cols) r.push(null);
  return {
    g,
    grid,
    rows: grid.length,
    cols,
    axis: g.orientation === "row" ? "row" : "col",
    format: formatOf(g),
  };
}

function fitHeaders(h: unknown, len: number): string[] {
  const src = Array.isArray(h) ? h : [];
  return Array.from({ length: len }, (_, i) => (typeof src[i] === "string" ? src[i] : ""));
}

/**
 * Write a view back to its group: grid, dims, headers sized to the dims, and
 * members = the grid's ids (existing order kept, new ones appended in reading
 * order). Returns false when the table ended up empty and was removed.
 */
function commit(d: Doc, v: TableView, headerCols?: string[], headerRows?: string[]): boolean {
  const g = v.g;
  // An all-empty line is legal (slots to fill later): dims follow the grid as written.
  const inGrid = v.grid.flat().filter((c): c is string => typeof c === "string");
  if (inGrid.length === 0) {
    removeGroup(d, g);
    return false;
  }
  const set = new Set(inGrid);
  const prev = (Array.isArray(g.members) ? (g.members as unknown[]) : []).filter(
    (m): m is string => typeof m === "string" && set.has(m),
  );
  const prevSet = new Set(prev);
  g.members = [...prev, ...inGrid.filter((id) => !prevSet.has(id))];
  g.grid = v.grid;
  g.rows = v.rows;
  g.cols = v.cols;
  g.header_cols = headerCols ?? fitHeaders(g.header_cols, v.cols);
  g.header_rows = headerRows ?? fitHeaders(g.header_rows, v.rows);
  for (const id of inGrid) {
    const f = d.field.get(id);
    if (f) f.group = g.id;
    d.owner.set(id, g);
  }
  return true;
}

function lineCount(v: TableView, axis: Axis): number {
  return axis === "col" ? v.cols : v.rows;
}

function lineIds(v: TableView, axis: Axis, i: number): string[] {
  const ids = axis === "col" ? v.grid.map((r) => r[i]) : (v.grid[i] ?? []);
  return ids.filter((x): x is string => typeof x === "string");
}

function lineFields(d: Doc, v: TableView, axis: Axis, i: number): Field[] {
  return lineIds(v, axis, i).flatMap((id) => {
    const f = d.field.get(id);
    return f ? [f] : [];
  });
}

/** The type a driving line holds: its first non-default cell (normalizeSchema's collapse rule). */
function lineType(d: Doc, v: TableView, i: number): TypeAndFormat | null {
  const cells = lineFields(d, v, v.axis, i);
  if (!cells.length) return null;
  const w = cells.find((c) => !isDefaultText(c)) ?? cells[0];
  return {
    type: String(w.type),
    ...(isRec(w.format) ? { format: structuredClone(w.format) } : {}),
  };
}

const axisWord = (a: Axis) => (a === "col" ? "column" : "row");

function checkAxis(v: unknown, name = "axis"): Axis {
  if (v !== "row" && v !== "col") return bad(`${name} must be "row" or "col"`);
  return v;
}

function checkIndex(v: unknown, n: number, name: string): number {
  if (!Number.isInteger(v) || (v as number) < 0 || (v as number) >= n) {
    return bad(
      `${name} must be a 0-based index below ${String(n)}${n === 0 ? " (there are none)" : ""}`,
    );
  }
  return v as number;
}

// A package-local copy of the editor's grouping.ts reconstructGrid +
// clusterCenters (pure box geometry, a port of pipeline.py:_reconstruct_grid):
// grouping.ts also carries the comb-date heuristics this package doesn't use.
// tableGrid.parity.test.ts (repo root) pins it to the editor's on random grids.

/** Cluster 1-D positions, splitting on gaps > `gap`; each cluster's mean. */
function clusterCenters(centers: number[], gap: number): number[] {
  if (centers.length === 0) return [];
  const ordered = [...centers].sort((a, b) => a - b);
  let cluster: number[] = [ordered[0]];
  const means: number[] = [];
  for (const c of ordered.slice(1)) {
    if (c - cluster[cluster.length - 1] > gap) {
      means.push(cluster.reduce((s, v) => s + v, 0) / cluster.length);
      cluster = [c];
    } else {
      cluster.push(c);
    }
  }
  means.push(cluster.reduce((s, v) => s + v, 0) / cluster.length);
  return means;
}

type Pct = { id: string; xpct: number; ypct: number; wpct: number; hpct: number };

/**
 * Rows × cols of member ids (null = empty) from box geometry: rows bucketed by
 * y-centre within half a median cell height, columns by clustered x-centres.
 */
export function reconstructGrid(members: readonly Pct[]): {
  rows: number;
  cols: number;
  grid: (string | null)[][];
} {
  if (members.length === 0) return { rows: 0, cols: 0, grid: [] };
  const cx = (f: Pct) => f.xpct + f.wpct / 2;
  const cy = (f: Pct) => f.ypct + f.hpct / 2;
  const medH = upperMedian(members.map((m) => m.hpct));
  const medW = upperMedian(members.map((m) => m.wpct));
  const byY = [...members].sort((a, b) => cy(a) - cy(b));
  const rowsArr: Pct[][] = [];
  for (const m of byY) {
    const last = rowsArr.at(-1);
    if (last && Math.abs(cy(m) - cy(last[last.length - 1])) <= medH * 0.5) last.push(m);
    else rowsArr.push([m]);
  }
  const colCenters = clusterCenters(members.map(cx), medW * 0.5);
  const colFor = (m: Pct): number => {
    const c = cx(m);
    let best = 0;
    let bestD = Infinity;
    colCenters.forEach((cc, i) => {
      const d = Math.abs(c - cc);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };
  const grid = rowsArr.map((row) => {
    const cells: (string | null)[] = Array.from({ length: colCenters.length }, () => null);
    for (const m of [...row].sort((a, b) => cx(a) - cx(b))) cells[colFor(m)] = m.id;
    return cells;
  });
  return { rows: rowsArr.length, cols: colCenters.length, grid };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The y band (percent) of a row, or the x band of a column: medians of its cells. */
function band(d: Doc, v: TableView, axis: Axis, i: number): { at: number; size: number } | null {
  const fs = lineFields(d, v, axis, i);
  if (!fs.length) return null;
  return axis === "row"
    ? { at: median(fs.map((f) => f.ypct)), size: median(fs.map((f) => f.hpct)) }
    : { at: median(fs.map((f) => f.xpct)), size: median(fs.map((f) => f.wpct)) };
}

/**
 * Where a new line goes at `index` along `axis` (percent). Between two lines it
 * sits centred in the gap (refused when the gap can't hold it); at either end it
 * sits one median pitch past the edge line.
 */
function interpolate(d: Doc, v: TableView, axis: Axis, k: number): { at: number; size: number } {
  const n = lineCount(v, axis);
  const bands = Array.from({ length: n }, (_, i) => band(d, v, axis, i));
  const known = bands.filter((b): b is { at: number; size: number } => !!b);
  if (!known.length) return bad(`the table has no ${axisWord(axis)} to measure; pass box`);
  const size = median(known.map((b) => b.size));
  const steps: number[] = [];
  for (let i = 1; i < n; i++) {
    const a = bands[i - 1];
    const b = bands[i];
    if (a && b) steps.push(b.at - a.at);
  }
  const pitch = steps.length ? median(steps) : size;
  const word = axisWord(axis);
  const need = (i: number) =>
    bands[i] ??
    bad(`${word} ${String(i)} has no cells to measure from; pass box for the new ${word}`);
  if (k === n) return { at: need(n - 1).at + pitch, size };
  if (k === 0) return { at: need(0).at - pitch, size };
  const a = need(k - 1);
  const b = need(k);
  const gap0 = a.at + a.size;
  const gap1 = b.at;
  if (gap1 - gap0 < size * 0.9) {
    return bad(
      `there is no room for a new ${word} between ${word}s ${String(k - 1)} and ${String(k)}; pass box with its ${axis === "row" ? "y and h" : "x and w"}`,
    );
  }
  return { at: (gap0 + gap1) / 2 - size / 2, size };
}

function cellLabel(v: TableView, r: number, c: number): string {
  const hc = fitHeaders(v.g.header_cols, v.cols)[c]?.trim();
  const hr = fitHeaders(v.g.header_rows, v.rows)[r]?.trim();
  return `${hc || `Column ${String(c + 1)}`} — ${hr || `row ${String(r + 1)}`}`;
}

function sectionOfTable(d: Doc, v: TableView): string | null {
  for (const m of members(d, v.g)) if (typeof m.section_id === "string") return m.section_id;
  return null;
}

function newCell(
  d: Doc,
  v: TableView,
  r: number,
  c: number,
  box: { x: number; y: number; w: number; h: number },
  tf: TypeAndFormat,
): Field {
  const eps = 1e-6;
  if (
    box.w <= 0 ||
    box.h <= 0 ||
    box.x < -eps ||
    box.y < -eps ||
    box.x + box.w > 100 + eps ||
    box.y + box.h > 100 + eps
  ) {
    bad(
      `the new cell at row ${String(r)}, column ${String(c)} would fall off the page; pass box to place it`,
    );
  }
  const f = {
    id: randomUUID(),
    label: cellLabel(v, r, c),
    type: tf.type,
    ...(tf.format ? { format: structuredClone(tf.format) } : {}),
    page: v.g.page,
    section_id: sectionOfTable(d, v),
    xpct: box.x,
    ypct: box.y,
    wpct: box.w,
    hpct: box.h,
    group: v.g.id,
  } as Field;
  pushField(d, f);
  return f;
}

/** The type a cell at (r, c) must take: its driving line's, or `fallback` for an empty line. */
function slotType(d: Doc, v: TableView, r: number, c: number, fallback = DEFAULT_TEXT) {
  if (v.format === "checkbox_matrix") return patchForDataType("checkbox");
  return lineType(d, v, v.axis === "col" ? c : r) ?? fallback;
}

// ─── Ops ─────────────────────────────────────────────────────────────────────

export interface TableOpResult {
  touched: string[];
  added?: string;
  deleted?: string[];
  /** tables whose structure the op changed (tableIssues runs on them) */
  tables: string[];
}

function checkDateFormat(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !(DATE_FORMATS as readonly string[]).includes(v)) {
    return bad(`date_format must be one of ${DATE_FORMATS.join(", ")}`);
  }
  return v;
}

/** `group` with kind "table": a table from loose fields. */
export function groupTable(
  d: Doc,
  op: Record<string, unknown>,
  warnings: string[],
): TableOpResult & { added: string } {
  if (typeof op.label !== "string") return bad("label is required (the table's caption)");
  const format = op.format ?? "classic";
  if (!(TABLE_FORMATS as readonly unknown[]).includes(format)) {
    return bad(`format must be one of ${TABLE_FORMATS.join(", ")}`);
  }
  const orientation = op.orientation ?? "col";
  if (orientation !== "col" && orientation !== "row")
    return bad('orientation must be "col" or "row"');
  if (format === "expandable" && orientation === "row") {
    return bad('an expandable table is typed by its columns: orientation must be "col"');
  }
  let grid: Grid;
  if (op.cells !== undefined) {
    if (op.ids !== undefined) return bad("pass cells (the grid) or ids, not both");
    if (
      !Array.isArray(op.cells) ||
      op.cells.length === 0 ||
      op.cells.some((r) => !Array.isArray(r) || r.length === 0)
    ) {
      return bad("cells must be a non-empty list of rows, each a list of field ids or null");
    }
    const width = (op.cells[0] as unknown[]).length;
    if ((op.cells as unknown[][]).some((r) => r.length !== width)) {
      return bad("every row of cells must have the same number of columns (use null for a gap)");
    }
    grid = (op.cells as unknown[][]).map((r) =>
      r.map((c) => (c === null ? null : resolveId(d, c, ["field", "group"], "cell id"))),
    );
  } else {
    if (!Array.isArray(op.ids) || op.ids.length < 2) {
      return bad(
        "a table needs cells (rows × cols of field ids, null for a gap) or ids (laid out from their boxes), with at least 2 fields",
      );
    }
    const fs = op.ids.map((id) => needField(d, id, "ids entry"));
    grid = reconstructGrid(fs as never).grid;
  }
  const ids = grid.flat().filter((x): x is string => x !== null);
  if (ids.length < 2) return bad("a table needs at least 2 fields");
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) return bad(`${dup} appears twice in the grid`);
  const fs = ids.map((id) => {
    const f = d.field.get(id);
    if (!f) return bad(`${id} is a group, not a field (groups can't be nested)`);
    const own = d.owner.get(id);
    if (own) return bad(`${id} already belongs to group ${own.id}; ungroup it first`);
    return f;
  });
  const page = fs[0].page;
  if (fs.some((f) => f.page !== page)) return bad("all of a table's cells must be on one page");
  const rows = grid.length;
  const cols = grid[0].length;
  const headers = (k: "header_cols" | "header_rows", len: number): string[] | undefined => {
    const h = op[k];
    if (h === undefined) return undefined;
    if (!Array.isArray(h) || h.some((x) => typeof x !== "string") || h.length !== len) {
      return bad(`${k} must be a list of ${String(len)} strings (one per ${k.slice(7, -1)})`);
    }
    return (h as string[]).map((x) => x.trim());
  };
  const headerCols = headers("header_cols", cols);
  const headerRows = headers("header_rows", rows);
  const gid = randomUUID();
  const g = {
    id: gid,
    kind: "table",
    format,
    label: op.label.trim(),
    page,
    members: [],
    orientation,
  } as unknown as Group;
  d.s.groups.push(g);
  d.group.set(gid, g);
  const v: TableView = {
    g,
    grid,
    rows,
    cols,
    axis: orientation,
    format: format as TableView["format"],
  };
  commit(
    d,
    v,
    headerCols ?? fitHeaders(undefined, cols),
    headerRows ?? fitHeaders(undefined, rows),
  );
  // Single-axis: a matrix is all checkbox; otherwise each driving line takes
  // the type of its first non-default cell (the load-time collapse's rule).
  if (v.format === "checkbox_matrix") {
    for (const f of fs) if (f.type !== "checkbox") setCellType(f, patchForDataType("checkbox"));
  } else {
    const changed: number[] = [];
    for (let i = 0; i < lineCount(v, v.axis); i++) {
      const tf = lineType(d, v, i);
      if (!tf) continue;
      const cells = lineFields(d, v, v.axis, i);
      if (cells.some((c) => !sameType(c, tf))) changed.push(i);
      for (const c of cells) setCellType(c, tf);
    }
    if (changed.length) {
      warnings.push(
        `table ${gid}: ${axisWord(v.axis)}s ${changed.join(", ")} mixed types, so each now takes one type (its first typed cell); use set_column_type to change a ${axisWord(v.axis)}'s type`,
      );
    }
  }
  return { touched: [gid], added: gid, tables: [gid] };
}

export function tableInsert(d: Doc, op: Record<string, unknown>, w: string[]): TableOpResult {
  const v = tableView(d, needGroup(d, op.id), w);
  const axis = checkAxis(op.axis);
  const n = lineCount(v, axis);
  if (!Number.isInteger(op.index) || (op.index as number) < 0 || (op.index as number) > n) {
    return bad(`index must be 0–${String(n)} (${String(n)} = after the last ${axisWord(axis)})`);
  }
  const k = op.index as number;
  if (op.header !== undefined && typeof op.header !== "string")
    return bad("header must be a string");
  let newType: TypeAndFormat | undefined;
  if (op.type !== undefined) {
    if (axis !== v.axis) {
      return bad(
        `type sets a new driving line's type; this table is typed by ${axisWord(v.axis)}s, so a new ${axisWord(axis)}'s cells take their ${axisWord(v.axis)}'s type`,
      );
    }
    if (!(COLUMN_TYPES as readonly unknown[]).includes(op.type)) {
      return bad(`type must be one of ${COLUMN_TYPES.join(", ")}`);
    }
    newType = patchForDataType(op.type as ColumnType, checkDateFormat(op.date_format));
  }
  let at: { at: number; size: number };
  if (op.box !== undefined) {
    if (!isRec(op.box)) return bad("box must be an object");
    const b = op.box;
    const [p, s] = axis === "row" ? ["y", "h"] : ["x", "w"];
    const pos = b[p];
    const size = b[s];
    if (typeof pos !== "number" || typeof size !== "number" || size <= 0) {
      return bad(
        `box for a new ${axisWord(axis)} is {${p}, ${s}} (fractions of the page); the cells' ${axis === "row" ? "x/w come from each column" : "y/h come from each row"}`,
      );
    }
    at = { at: pos * 100, size: size * 100 };
  } else {
    at = interpolate(d, v, axis, k);
  }
  // Types are read before the grid changes, from the lines the new cells join.
  const other: Axis = axis === "row" ? "col" : "row";
  const m = lineCount(v, other);
  const created: string[] = [];
  const bandsOther = Array.from({ length: m }, (_, j) => band(d, v, other, j));
  const types = Array.from({ length: m }, (_, j) =>
    v.format === "checkbox_matrix"
      ? patchForDataType("checkbox")
      : axis === v.axis
        ? (newType ?? DEFAULT_TEXT)
        : (lineType(d, v, j) ?? DEFAULT_TEXT),
  );
  const line: (string | null)[] = [];
  const dims = { rows: v.rows + (axis === "row" ? 1 : 0), cols: v.cols + (axis === "col" ? 1 : 0) };
  // Labels use the post-insert indices, so build a provisional header view.
  const hc = fitHeaders(v.g.header_cols, v.cols);
  const hr = fitHeaders(v.g.header_rows, v.rows);
  const header = typeof op.header === "string" ? op.header.trim() : "";
  if (axis === "row") hr.splice(k, 0, header);
  else hc.splice(k, 0, header);
  const labelView: TableView = { ...v, ...dims, g: { ...v.g, header_cols: hc, header_rows: hr } };
  for (let j = 0; j < m; j++) {
    const ob = bandsOther[j];
    if (!ob) {
      line.push(null);
      continue;
    }
    const r = axis === "row" ? k : j;
    const c = axis === "row" ? j : k;
    const box =
      axis === "row"
        ? { x: ob.at, y: at.at, w: ob.size, h: at.size }
        : { x: at.at, y: ob.at, w: at.size, h: ob.size };
    const f = newCell(d, labelView, r, c, box, types[j]);
    created.push(f.id);
    line.push(f.id);
  }
  if (!created.length) return bad("the table has no cells to align a new line with");
  if (axis === "row") v.grid.splice(k, 0, line);
  else v.grid.forEach((row, j) => row.splice(k, 0, line[j]));
  v.rows = dims.rows;
  v.cols = dims.cols;
  commit(d, v, hc, hr);
  return { touched: [v.g.id, ...created], tables: [v.g.id] };
}

export function tableDelete(d: Doc, op: Record<string, unknown>, w: string[]): TableOpResult {
  const v = tableView(d, needGroup(d, op.id), w);
  const axis = checkAxis(op.axis);
  const k = checkIndex(op.index, lineCount(v, axis), "index");
  if (op.keep_cells !== undefined && typeof op.keep_cells !== "boolean")
    return bad("keep_cells must be true or false");
  const ids = new Set(lineIds(v, axis, k));
  const hc = fitHeaders(v.g.header_cols, v.cols);
  const hr = fitHeaders(v.g.header_rows, v.rows);
  if (axis === "row") {
    v.grid.splice(k, 1);
    hr.splice(k, 1);
    v.rows--;
  } else {
    for (const row of v.grid) row.splice(k, 1);
    hc.splice(k, 1);
    v.cols--;
  }
  if (v.cols === 0) v.grid = [];
  v.rows = v.grid.length;
  const keep = op.keep_cells === true;
  if (keep) {
    for (const id of ids) {
      const f = d.field.get(id);
      if (f) f.group = null;
      d.owner.delete(id);
    }
  } else removeFields(d, ids);
  const alive = commit(d, v, hc, hr);
  if (!alive) w.push(`that was the last line of table ${v.g.id}, so the table was removed`);
  const deleted = [...(keep ? [] : ids), ...(alive ? [] : [v.g.id])];
  return {
    touched: [...(alive ? [v.g.id] : []), ...(keep ? ids : [])],
    deleted,
    tables: alive ? [v.g.id] : [],
  };
}

function slotArgs(v: TableView, op: Record<string, unknown>): { r: number; c: number } {
  const r = checkIndex(op.row, v.rows, "row");
  const c = checkIndex(op.col, v.cols, "col");
  const cur = v.grid[r][c];
  if (cur !== null) {
    bad(
      `row ${String(r)}, column ${String(c)} already holds ${cur}; delete it first, or pick an empty slot`,
    );
  }
  return { r, c };
}

export function tableAddCell(
  d: Doc,
  op: Record<string, unknown>,
  w: string[],
): TableOpResult & { added: string } {
  const v = tableView(d, needGroup(d, op.id), w);
  const { r, c } = slotArgs(v, op);
  let box: { x: number; y: number; w: number; h: number };
  if (op.box !== undefined) {
    const b = boxArg(op.box);
    box = { x: b.x * 100, y: b.y * 100, w: b.w * 100, h: b.h * 100 };
  } else {
    const rb = band(d, v, "row", r);
    const cb = band(d, v, "col", c);
    if (!rb || !cb) {
      return bad(
        `row ${String(r)} or column ${String(c)} has no other cells to align with; pass box`,
      );
    }
    box = { x: cb.at, y: rb.at, w: cb.size, h: rb.size };
  }
  const f = newCell(d, v, r, c, box, slotType(d, v, r, c));
  v.grid[r][c] = f.id;
  commit(d, v);
  return { touched: [v.g.id, f.id], added: f.id, tables: [v.g.id] };
}

export function tableAdopt(d: Doc, op: Record<string, unknown>, w: string[]): TableOpResult {
  const v = tableView(d, needGroup(d, op.id), w);
  const f = needField(d, op.field, "field");
  const own = d.owner.get(f.id);
  if (own) {
    return bad(
      own.id === v.g.id
        ? `${f.id} is already a cell of this table`
        : `${f.id} belongs to group ${own.id}; ungroup it first`,
    );
  }
  if (f.page !== v.g.page) return bad(`${f.id} is on another page than the table`);
  const { r, c } = slotArgs(v, op);
  const tf = slotType(d, v, r, c, {
    type: String(f.type),
    ...(isRec(f.format) ? { format: f.format } : {}),
  });
  if (!sameType(f, tf)) {
    w.push(
      `${f.id} was ${dataTypeOf(f)} and is now ${dataTypeOf({ ...f, ...tf } as Field)}, the type of its ${axisWord(v.axis)} (the table is typed by ${axisWord(v.axis)}s)`,
    );
  }
  setCellType(f, tf);
  v.grid[r][c] = f.id;
  commit(d, v);
  return { touched: [v.g.id, f.id], tables: [v.g.id] };
}

export function setColumnType(d: Doc, op: Record<string, unknown>, w: string[]): TableOpResult {
  const v = tableView(d, needGroup(d, op.id), w);
  if (v.format === "checkbox_matrix")
    return bad("a checkbox_matrix table is all checkboxes; its types can't be set");
  const k = checkIndex(op.index, lineCount(v, v.axis), "index");
  if (!(COLUMN_TYPES as readonly unknown[]).includes(op.type)) {
    return bad(`type must be one of ${COLUMN_TYPES.join(", ")}`);
  }
  const df = checkDateFormat(op.date_format);
  if (df && op.type !== "date") return bad("date_format applies to type date only");
  const tf = patchForDataType(op.type as ColumnType, df);
  const cells = lineFields(d, v, v.axis, k);
  if (!cells.length) return bad(`${axisWord(v.axis)} ${String(k)} has no cells`);
  for (const c of cells) setCellType(c, tf);
  commit(d, v);
  return { touched: [v.g.id], tables: [v.g.id] };
}

export function setOrientation(d: Doc, op: Record<string, unknown>, w: string[]): TableOpResult {
  const v = tableView(d, needGroup(d, op.id), w);
  const o = op.orientation;
  if (o !== "col" && o !== "row") return bad('orientation must be "col" or "row"');
  if (v.format === "expandable" && o === "row") {
    return bad('an expandable table is typed by its columns: orientation must be "col"');
  }
  if (v.axis === o) {
    w.push(`table ${v.g.id} is already typed by ${axisWord(o)}s; nothing changed`);
    return { touched: [v.g.id], tables: [v.g.id] };
  }
  v.g.orientation = o;
  v.axis = o;
  if (v.format !== "checkbox_matrix") {
    for (const f of members(d, v.g)) setCellType(f, DEFAULT_TEXT);
    w.push(
      `table ${v.g.id} is now typed by ${axisWord(o)}s; every cell was reset to text (as the editor does). Type each ${axisWord(o)} with set_column_type`,
    );
  }
  commit(d, v);
  return { touched: [v.g.id], tables: [v.g.id] };
}

export function setHeader(d: Doc, op: Record<string, unknown>, w: string[]): TableOpResult {
  const v = tableView(d, needGroup(d, op.id), w);
  const axis = checkAxis(op.axis);
  const k = checkIndex(op.index, lineCount(v, axis), "index");
  if (typeof op.text !== "string") return bad('text must be a string ("" clears the header)');
  const text = op.text.trim();
  const hc = fitHeaders(v.g.header_cols, v.cols);
  const hr = fitHeaders(v.g.header_rows, v.rows);
  if (axis === "col") hc[k] = text;
  else hr[k] = text;
  // An expandable table names a column by its cells' label (TableAxisEditor).
  if (v.format === "expandable" && axis === "col" && text) {
    for (const f of lineFields(d, v, "col", k)) f.label = text;
  }
  commit(d, v, hc, hr);
  return { touched: [v.g.id], tables: [v.g.id] };
}

/** set_headers: several headers of one axis in one op, from `start` (default 0). */
export function setHeaders(d: Doc, op: Record<string, unknown>, w: string[]): TableOpResult {
  const v = tableView(d, needGroup(d, op.id), w);
  const axis = checkAxis(op.axis);
  const n = lineCount(v, axis);
  if (
    !Array.isArray(op.texts) ||
    op.texts.length === 0 ||
    op.texts.some((t) => typeof t !== "string")
  )
    return bad('texts must be a non-empty list of strings ("" clears a header)');
  const start = op.start === undefined ? 0 : checkIndex(op.start, n, "start");
  if (start + op.texts.length > n)
    return bad(
      `this table has ${String(n)} ${axis === "col" ? "columns" : "rows"}; ${String(op.texts.length)} texts from start ${String(start)} run past the last one`,
    );
  const hc = fitHeaders(v.g.header_cols, v.cols);
  const hr = fitHeaders(v.g.header_rows, v.rows);
  (op.texts as string[]).forEach((raw, i) => {
    const k = start + i;
    const text = raw.trim();
    if (axis === "col") hc[k] = text;
    else hr[k] = text;
    if (v.format === "expandable" && axis === "col" && text) {
      for (const f of lineFields(d, v, "col", k)) f.label = text;
    }
  });
  commit(d, v, hc, hr);
  return { touched: [v.g.id], tables: [v.g.id] };
}

/**
 * set_format on a table cell: under the single-axis rule the format belongs to
 * the cell's whole driving line, so it is applied to every cell of that line
 * (a checkbox_matrix keeps per-cell formats).
 */
export function applyFormatToLine(
  d: Doc,
  g: Group,
  f: Field,
  format: Record<string, unknown> | undefined,
  w: string[],
): void {
  const v = tableView(d, g, w);
  if (v.format === "checkbox_matrix") return;
  let at: number | null = null;
  v.grid.forEach((row, r) =>
    row.forEach((id, c) => {
      if (id === f.id) at = v.axis === "col" ? c : r;
    }),
  );
  if (at === null) return;
  const cells = lineFields(d, v, v.axis, at);
  for (const c of cells) {
    if (c === f) continue;
    c.type = f.type;
    if (format) c.format = structuredClone(format);
    else delete c.format;
  }
  if (cells.length > 1) {
    w.push(
      `the format was applied to all ${String(cells.length)} cells of ${axisWord(v.axis)} ${String(at)} of table ${g.id}: a table is typed by ${axisWord(v.axis)}s`,
    );
  }
}

/** The structure invariants of a table an op reshaped. */
export function tableIssues(d: Doc, g: Group): Issue[] {
  const out: Issue[] = [];
  const at = (reason: string) => out.push({ id: g.id, path: `group ${g.id}`, reason });
  const grid = g.grid;
  if (!Array.isArray(grid) || grid.some((r) => !Array.isArray(r))) {
    at("has no grid");
    return out;
  }
  const rows = grid.length;
  const cols = rows ? (grid[0] as unknown[]).length : 0;
  if ((grid as unknown[][]).some((r) => r.length !== cols)) at("grid rows differ in length");
  if (g.rows !== rows || g.cols !== cols) at("rows/cols don't match the grid");
  if (Array.isArray(g.header_cols) && g.header_cols.length !== cols)
    at("header_cols length isn't the column count");
  if (Array.isArray(g.header_rows) && g.header_rows.length !== rows)
    at("header_rows length isn't the row count");
  const ids = (grid as unknown[][]).flat().filter((x): x is string => typeof x === "string");
  const mem = new Set(Array.isArray(g.members) ? (g.members as string[]) : []);
  if (new Set(ids).size !== ids.length) at("a cell appears twice in the grid");
  if (ids.some((id) => !mem.has(id)) || mem.size !== new Set(ids).size)
    at("members and grid cells differ");
  for (const id of ids) {
    const f = d.field.get(id);
    if (f && f.page !== g.page) at(`cell ${id} is on another page`);
  }
  const v: TableView = {
    g,
    grid: grid as Grid,
    rows,
    cols,
    axis: g.orientation === "row" ? "row" : "col",
    format: formatOf(g),
  };
  if (v.format === "checkbox_matrix") {
    if (ids.some((id) => d.field.get(id)?.type !== "checkbox"))
      at("a checkbox_matrix cell isn't a checkbox");
  } else {
    for (let i = 0; i < lineCount(v, v.axis); i++) {
      const keys = new Set(lineFields(d, v, v.axis, i).map(typeKey));
      if (keys.size > 1) at(`${axisWord(v.axis)} ${String(i)} mixes types`);
    }
  }
  return out;
}

// edit_template's ops, applied to a local working copy of a render schema.
//
// Ids are the agent ids analyze_form / get_template show: a field id, a
// group id (radio/multiselect/comb/table), or an option / cell id (the member
// fields of a group). Any id may be shortened to an unambiguous prefix of at
// least 6 characters, the length the check copy's tags show (doc.ts resolveId). Coordinates use the agent schema's box convention:
// fractions 0–1 of the page, TOP-LEFT origin (x right, y down). The render
// schema stores percent (0–100) of the page, also top-left; ×100 here.
//
// Each op is applied to a scratch copy and kept only if every item it touched
// still passes the server's validation (validate.ts); otherwise it is rejected
// with a reason and the copy is left as it was. The one exception is page
// bounds for geometry ops (move, resize, set_box): a box may pass off the page
// between ops of one batch (move then resize), so only its FINAL box is
// checked; a geometry op whose item ends up off the page is rejected and the
// batch is replayed without it. Nothing here touches the
// network or a fill value: labels, descriptions, placeholders and options hold
// the form's own wording.

import { randomUUID } from "node:crypto";

import {
  agentEntries,
  buildFieldById,
  normalizeSchema,
  resolveMembers,
} from "@/app/t/[template_id]/fillCore";
import { buildPageItems } from "@/app/t/[template_id]/pageLayout";
import { boxEdges, type Edges, membersEdges, orderBlocks } from "@/app/t/[template_id]/readOrder";
import { AUTOFILL_TOKENS, DATE_FORMATS } from "@/types";

import {
  bad,
  bbox,
  type Box,
  boxArg,
  checkFraction,
  type Doc,
  dropMembers,
  type Field,
  type Group,
  index,
  isRec,
  members,
  needField,
  needGroup,
  needId,
  ON_PAGE,
  OpError,
  onPage,
  pageOf,
  removeFields,
  REF_NAME,
  removeGroup,
  resolveId,
  round,
  transform,
} from "./doc.js";
import {
  applyFormatToLine,
  groupTable,
  lineWord,
  mixedLineCells,
  mixedLines,
  setColumnType,
  setHeader,
  setHeaders,
  setOrientation,
  tableAddCell,
  tableAdopt,
  tableDelete,
  tableInsert,
  tableIssues,
  type TableOpResult,
} from "./tables.js";
import { entryKey, type Refusal, type Screened } from "./echo.js";
import type { RenderSchema } from "./types.js";
import { fieldIssues, formatIssues, groupIssues, type Issue, sectionIssues } from "./validate.js";

export type { Box } from "./doc.js";

export const MAX_OPS = 200;

/** The field types an op may set (agent types; multiline = text + multiline variant). */
export const EDIT_FIELD_TYPES = ["text", "multiline", "date", "checkbox", "signature"] as const;
export type EditFieldType = (typeof EDIT_FIELD_TYPES)[number];

/** Where `snap` looks for the blank a box belongs to, in the page render. */
export const SNAP_MODES = ["underline", "cell", "answer"] as const;
export type SnapMode = (typeof SNAP_MODES)[number];

type Snap = { snap?: SnapMode };

export type Op =
  | ({ op: "move"; id: string; dx?: number; dy?: number; x?: number; y?: number } & Snap)
  | { op: "resize"; id: string; w: number; h: number }
  | ({ op: "set_box"; id: string; x: number; y: number; w: number; h: number } & Snap)
  | { op: "relabel"; id: string; label: string }
  | {
      op: "retype";
      id: string;
      type: string;
      cells?: number | Box[];
      cell_type?: string;
      date_format?: string;
    }
  | ({
      op: "add";
      page: number;
      type: EditFieldType;
      box: Box;
      label: string;
      section_id?: string;
      description?: string;
      placeholder?: string;
      required?: boolean;
    } & Snap)
  | {
      op: "add";
      page: number;
      type: "comb";
      /** The comb's outer box, cut into `cells` equal cells; or the cells' own boxes. */
      box?: Box;
      cells: number | Box[];
      label: string;
      cell_type?: string;
      date_format?: string;
      section_id?: string;
      description?: string;
      required?: boolean;
    }
  | { op: "delete"; id: string }
  | { op: "set_format"; id: string; format: Record<string, unknown> }
  | {
      op: "group";
      ids: string[];
      kind: "choice" | "comb";
      label: string;
      multiple?: boolean;
      cell_type?: string;
      date_format?: string;
    }
  | {
      op: "group";
      kind: "table";
      label: string;
      cells?: (string | null)[][];
      ids?: string[];
      header_cols?: string[];
      header_rows?: string[];
      orientation?: "col" | "row";
      format?: "classic" | "expandable" | "checkbox_matrix";
    }
  | { op: "ungroup"; id: string }
  | { op: "set_options"; id: string; options: (string | { id: string; label: string })[] }
  | { op: "add_option"; id: string; label: string; box: Box; index?: number }
  | { op: "remove_option"; id: string; option: string }
  | { op: "comb_add_cell"; id: string; box: Box; date_format?: string }
  | { op: "comb_remove_cell"; id: string; date_format?: string }
  | { op: "set_required"; id: string; required: boolean }
  | { op: "set_description"; id: string; description: string | null }
  | { op: "set_placeholder"; id: string; placeholder: string | null }
  | { op: "set_autofill"; id: string; autofill: string | null }
  | {
      op: "table_insert";
      id: string;
      axis: "row" | "col";
      index: number;
      box?: { x?: number; y?: number; w?: number; h?: number };
      header?: string;
      type?: string;
      date_format?: string;
    }
  | { op: "table_delete"; id: string; axis: "row" | "col"; index: number; keep_cells?: boolean }
  | { op: "table_add_cell"; id: string; row: number; col: number; box?: Box }
  | { op: "table_adopt"; id: string; field: string; row: number; col: number }
  | { op: "set_column_type"; id: string; index: number; type: string; date_format?: string }
  | { op: "set_orientation"; id: string; orientation: "col" | "row" }
  | { op: "set_header"; id: string; axis: "row" | "col"; index: number; text: string }
  | { op: "set_headers"; id: string; axis: "row" | "col"; texts: string[]; start?: number }
  | { op: "reorder"; page: number; ids: string[] }
  | { op: "set_section"; ids: string[]; section_id: string | null }
  | { op: "set_section_title"; page: number; section_id: string; title: string };

export const OP_NAMES = [
  "move",
  "resize",
  "set_box",
  "relabel",
  "retype",
  "add",
  "delete",
  "set_format",
  "group",
  "ungroup",
  "set_options",
  "add_option",
  "remove_option",
  "comb_add_cell",
  "comb_remove_cell",
  "set_required",
  "set_description",
  "set_placeholder",
  "set_autofill",
  "table_insert",
  "table_delete",
  "table_add_cell",
  "table_adopt",
  "set_column_type",
  "set_orientation",
  "set_header",
  "set_headers",
  "reorder",
  "set_section",
  "set_section_title",
] as const;

export interface Rejected {
  op_index: number;
  reason: string;
}

/** What a fill reads off a comb: its cell type, the date format in use, its length. */
export interface CombFormat {
  cell_type: "integer" | "char" | "date";
  date_format: string | null;
  max_length: number;
}

/** One applied op: its kind, whether a requested snap landed, and whether it changed nothing. */
export interface OpOutcome {
  op_index: number;
  op: string;
  snapped?: boolean;
  /** set_format on a comb group: the comb as a fill now reads it. */
  comb?: CombFormat;
  /** reorder: the page's top-level ids in the order now listed (each section one run). */
  order?: string[];
  /** set_section / set_section_title, add, group: the section it now stands in (null = none). */
  section?: SectionRef | null;
  /** group: the new group's members (its options or cells, ids unchanged) in reading order. */
  members?: string[];
  /** set_options: every option of the group with its label now, in reading order. */
  options?: { id: string; label: string }[];
  noop?: true;
}

/** A section of a page, as get_template names it. */
export interface SectionRef {
  id: string;
  title: string;
}

export interface Touched {
  id: string;
  kind: "field" | "group";
  type: string;
  label: string;
  page: number;
  box: Box;
}

export interface ApplyResult {
  render: RenderSchema;
  applied: number;
  rejected: Rejected[];
  /** Per-op-kind counts, plus the ids added and deleted. */
  diff_summary: {
    counts: Record<string, number>;
    added: { op_index: number; id: string }[];
    deleted: string[];
    touched: Touched[];
    /** Every applied op, in order. */
    ops: OpOutcome[];
  };
  warnings: string[];
  /** What the echo guard refused in this batch: `told` = the ops rejected for
   *  it (their reasons name the id and property), `confirmed` = the ops let
   *  through on confirmWording. They hold the wording, so they stay in the
   *  process and are never part of a tool result. */
  screened: { told: Refusal[]; confirmed: Refusal[] };
}

/**
 * Finds the blank a box was meant for in the page render (snap.ts): given a
 * box in fractions, the snapped box, or a reason it found none nearby.
 */
export type Snapper = (page: number, box: Box, mode: SnapMode) => { box: Box } | { none: string };

export interface ApplyOptions {
  snap?: Snapper;
  /** The agent says the wording of these ops is the form's own: a refusal it
   *  has already been told about (Refusal.shown) then applies, with a warning. */
  confirmWording?: boolean;
}

/** Move/scale an item's boxes to `nb` (percent). Page bounds are checked on the
 *  batch's final state (applyOps), not here. */
function placeBox(fs: readonly Field[], bb: Box, nb: Box): void {
  if (nb.w <= 0 || nb.h <= 0) bad("the box must have a positive width and height");
  transform(fs, bb, nb);
}

/** The section of the nearest field at or above a point (the web editor's sectionForPos). */
function sectionForPos(d: Doc, page: number, xPct: number, yPct: number): string | null {
  let best: Field | null = null;
  for (const f of d.s.fields as Field[]) {
    if (f.page !== page || f.ypct > yPct + 1) continue;
    if (!best || f.ypct > best.ypct || (f.ypct === best.ypct && f.xpct > best.xpct)) best = f;
  }
  if (best) return typeof best.section_id === "string" ? best.section_id : null;
  const pg = d.s.pages.find((p) => p.page === page) as
    | { sections?: { id?: unknown }[] }
    | undefined;
  const first = Array.isArray(pg?.sections) ? pg.sections[0] : undefined;
  return typeof first?.id === "string" ? first.id : null;
}

function sectionIds(d: Doc, page: number): Set<string> {
  const pg = d.s.pages.find((p) => p.page === page) as
    | { sections?: { id?: unknown }[] }
    | undefined;
  const out = new Set<string>();
  for (const s of Array.isArray(pg?.sections) ? pg.sections : []) {
    if (typeof s.id === "string") out.add(s.id);
  }
  return out;
}

/** The type + format a standalone field gets for an agent field type. */
function typeAndFormat(
  t: string,
  prev?: Field,
): { type: string; format?: Record<string, unknown> } {
  const prevFmt = isRec(prev?.format) ? prev.format : {};
  const keep = (keys: string[]) =>
    Object.fromEntries(keys.filter((k) => prevFmt[k] != null).map((k) => [k, prevFmt[k]]));
  switch (t) {
    case "text":
      return {
        type: "text",
        format: { ...keep(["font_size", "text_anchor", "uppercase"]), variant: "any" },
      };
    case "multiline":
      return {
        type: "text",
        format: { ...keep(["font_size", "uppercase"]), variant: "multiline" },
      };
    case "date":
      return {
        type: "date",
        format: {
          date_format: typeof prevFmt.date_format === "string" ? prevFmt.date_format : "DD/MM/YYYY",
          ...keep(["font_size", "text_anchor"]),
        },
      };
    case "checkbox":
      return { type: "checkbox", format: { shape: "square", symbol: "✗" } };
    case "signature":
      return { type: "signature" };
    default:
      return bad(`type must be one of ${EDIT_FIELD_TYPES.join(", ")}`);
  }
}

function setFieldType(f: Field, t: string): void {
  const { type, format } = typeAndFormat(t, f);
  f.type = type as Field["type"];
  if (format) f.format = format;
  else delete f.format;
  delete f.primitive;
  if (type !== "signature") delete f.signing_requirement;
}

function entryType(d: Doc, id: string): string {
  const g = d.group.get(id);
  if (g) {
    if (g.kind === "choice") return g.format === "multiple" ? "multiselect" : "radio";
    if (g.kind === "table") return g.format === "expandable" ? "table_rows" : "table";
    return String(g.kind);
  }
  const f = d.field.get(id);
  if (!f) return "?";
  if (f.type === "text" && isRec(f.format) && f.format.variant === "multiline") return "multiline";
  if ((f.type === "text" || f.type === "date") && Array.isArray(f.cells) && f.cells.length > 1)
    return "comb";
  return String(f.type);
}

function touchedOf(d: Doc, id: string): Touched | null {
  const g = d.group.get(id);
  const f = d.field.get(id);
  const fs = g ? members(d, g) : f ? [f] : [];
  const bb = bbox(fs);
  if (!bb || (!g && !f)) return null;
  const item = (g ?? f) as { label?: unknown; page?: unknown };
  return {
    id,
    kind: g ? "group" : "field",
    type: entryType(d, id),
    label: typeof item.label === "string" ? item.label : "",
    page: typeof item.page === "number" ? item.page : (fs[0]?.page ?? 0),
    box: { x: round(bb.x / 100), y: round(bb.y / 100), w: round(bb.w / 100), h: round(bb.h / 100) },
  };
}

interface OneResult {
  touched: string[];
  added?: string;
  deleted?: string[];
  geometry?: string;
  /** tables whose structure changed: tableIssues runs on them */
  tables?: string[];
  /** a snap the op asked for: whether it found its blank */
  snapped?: boolean;
  /** a comb whose format the op set: what a fill reads off it is echoed */
  comb?: string;
  /** reorder: the page's entries as now listed */
  order?: string[];
  /** set_section / set_section_title: the section the op left */
  section?: SectionRef | null;
  /** group: the new group's members (options, cells) in reading order */
  members?: string[];
  /** set_options: the group's options and labels in reading order */
  options?: { id: string; label: string }[];
  /** group (choice): the ids in the order the op gave them, for a later set_options of the batch */
  batchOrder?: { id: string; ids: string[] };
}

/** Snap a single field's box (percent) to the blank under it, if the op asked. */
function snapField(
  d: Doc,
  f: Field,
  op: Record<string, unknown>,
  opts: ApplyOptions,
  w: string[],
): boolean | undefined {
  if (op.snap === undefined) return undefined;
  if (!(SNAP_MODES as readonly unknown[]).includes(op.snap))
    bad(`snap must be one of ${SNAP_MODES.join(", ")}`);
  if (!opts.snap) bad("snap needs the page render, which isn't available for this edit");
  const box = { x: f.xpct / 100, y: f.ypct / 100, w: f.wpct / 100, h: f.hpct / 100 };
  const r = opts.snap!(f.page, box, op.snap as SnapMode);
  if ("none" in r) {
    w.push(`${f.id}: snap ${String(op.snap)} found ${r.none}; the box was kept as given`);
    return false;
  }
  transform(
    [f],
    { x: f.xpct, y: f.ypct, w: f.wpct, h: f.hpct },
    {
      x: r.box.x * 100,
      y: r.box.y * 100,
      w: r.box.w * 100,
      h: r.box.h * 100,
    },
  );
  return true;
}

function checkSnapTarget(g: Group | undefined, op: Record<string, unknown>): void {
  if (op.snap !== undefined && g) bad("snap applies to a single field, not a group");
}

function applyOne(d: Doc, op: Op, warnings: string[], opts: ApplyOptions): OneResult {
  if (!isRec(op) || typeof op.op !== "string") return bad("each op needs an `op` name");
  const raw = op as unknown as Record<string, unknown>;
  const table = (r: TableOpResult): OneResult => r;
  switch (op.op) {
    case "move": {
      const { f, g } = needId(d, op.id);
      checkSnapTarget(g, raw);
      const fs = g ? members(d, g) : [f as Field];
      const bb = bbox(fs);
      if (!bb) return bad("this group has no member boxes to move");
      let nx: number;
      let ny: number;
      if (op.x !== undefined || op.y !== undefined) {
        nx = op.x !== undefined ? checkFraction(op.x, "x") * 100 : bb.x;
        ny = op.y !== undefined ? checkFraction(op.y, "y") * 100 : bb.y;
        if (op.dx !== undefined || op.dy !== undefined) bad("pass either x/y or dx/dy, not both");
      } else if (op.dx !== undefined || op.dy !== undefined) {
        nx = bb.x + checkFraction(op.dx ?? 0, "dx", -1, 1) * 100;
        ny = bb.y + checkFraction(op.dy ?? 0, "dy", -1, 1) * 100;
      } else return bad("move needs x/y (new top-left) or dx/dy (offset)");
      placeBox(fs, bb, { x: nx, y: ny, w: bb.w, h: bb.h });
      const snapped = f ? snapField(d, f, raw, opts, warnings) : undefined;
      return { touched: [(g ?? f)!.id], geometry: (g ?? f)!.id, snapped };
    }
    case "resize": {
      const { f, g } = needId(d, op.id);
      const fs = g ? members(d, g) : [f as Field];
      const bb = bbox(fs);
      if (!bb) return bad("this group has no member boxes to resize");
      placeBox(fs, bb, {
        x: bb.x,
        y: bb.y,
        w: checkFraction(op.w, "w") * 100,
        h: checkFraction(op.h, "h") * 100,
      });
      return { touched: [(g ?? f)!.id], geometry: (g ?? f)!.id };
    }
    case "set_box": {
      const { f, g } = needId(d, op.id);
      checkSnapTarget(g, raw);
      const fs = g ? members(d, g) : [f as Field];
      const bb = bbox(fs);
      if (!bb) return bad("this group has no member boxes to place");
      placeBox(fs, bb, {
        x: checkFraction(op.x, "x") * 100,
        y: checkFraction(op.y, "y") * 100,
        w: checkFraction(op.w, "w") * 100,
        h: checkFraction(op.h, "h") * 100,
      });
      const snapped = f ? snapField(d, f, raw, opts, warnings) : undefined;
      return { touched: [(g ?? f)!.id], geometry: (g ?? f)!.id, snapped };
    }
    case "relabel": {
      const { f, g } = needId(d, op.id);
      if (typeof op.label !== "string") return bad("label must be a string");
      (g ?? f)!.label = op.label.trim();
      return { touched: [(g ?? f)!.id] };
    }
    case "retype": {
      const { f, g } = needId(d, op.id);
      if (typeof op.type !== "string") return bad("type is required");
      if (op.type === "comb") return retypeComb(d, op, g ? undefined : (f as Field), warnings);
      if (g) {
        if (g.kind === "table") {
          return bad(
            "a table's types live on its columns (or rows): use set_column_type {id, index, type}, or set_orientation",
          );
        }
        if (g.kind !== "choice") {
          return bad(
            "only a radio/multiselect group can be retyped (to radio or multiselect); ungroup other groups first",
          );
        }
        if (op.type !== "radio" && op.type !== "multiselect") {
          return bad("a choice group's type is radio or multiselect");
        }
        g.format = op.type === "multiselect" ? "multiple" : "single";
        return { touched: [g.id] };
      }
      const fld = f as Field;
      const own = d.owner.get(fld.id);
      if (own?.kind === "table") {
        return bad(
          `this is a cell of table ${own.id}, typed by its whole column (or row): use set_column_type {id: "${own.id}", index, type}`,
        );
      }
      if (own) {
        return bad(
          `this is an option/cell of group ${own.id}, whose kind fixes its type; ungroup it first to retype it`,
        );
      }
      setFieldType(fld, op.type);
      return { touched: [fld.id] };
    }
    case "add": {
      if (op.type === "comb") return addComb(d, op);
      const page = pageOf(d, op.page);
      const box = boxArg(op.box);
      if (typeof op.label !== "string")
        return bad("label is required (the form's caption for this blank)");
      let section: string | null;
      if (op.section_id !== undefined) {
        const sid = resolveId(d, op.section_id, ["section"], "section_id");
        if (!sectionIds(d, page).has(sid)) {
          return bad(`section_id ${sid} is not a section of page ${String(page)}`);
        }
        section = sid;
      } else section = sectionForPos(d, page, box.x * 100, box.y * 100);
      const id = randomUUID();
      const { type, format } = typeAndFormat(String(op.type));
      const f: Field = {
        id,
        label: op.label.trim(),
        type: type as Field["type"],
        ...(format ? { format } : {}),
        page,
        section_id: section,
        xpct: box.x * 100,
        ypct: box.y * 100,
        wpct: box.w * 100,
        hpct: box.h * 100,
        group: null,
      } as Field;
      if (typeof op.description === "string" && op.description.trim())
        f.description = op.description.trim();
      if (typeof op.placeholder === "string" && op.placeholder.trim())
        f.placeholder = op.placeholder.trim();
      if (op.required === true) f.required = true;
      d.s.fields.push(f);
      d.field.set(id, f);
      const snapped = snapField(d, f, raw, opts, warnings);
      return {
        touched: [id],
        added: id,
        geometry: id,
        snapped,
        section: sectionOf(d, page, id),
      };
    }
    case "delete": {
      const { f, g } = needId(d, op.id);
      const gone = new Set<string>();
      if (g) {
        for (const m of members(d, g)) gone.add(m.id);
        removeGroup(d, g);
      } else gone.add((f as Field).id);
      // A deleted option/cell leaves its group; a group left empty goes too.
      const reshaped: string[] = [];
      for (const og of [...d.s.groups] as Group[]) {
        const had = Array.isArray(og.members) && (og.members as string[]).some((m) => gone.has(m));
        if (dropMembers(d, og, gone)) {
          d.group.delete(og.id);
          warnings.push(
            `deleting removed the last member of group ${og.id}, so the group was removed too`,
          );
        } else if (had && og.kind === "table") {
          warnings.push(
            `the cell left an empty slot in table ${og.id}; fill it with table_add_cell or table_adopt, or drop the line with table_delete`,
          );
          reshaped.push(og.id);
        }
      }
      removeFields(d, gone);
      return { touched: [], deleted: g ? [g.id] : [...gone], tables: reshaped };
    }
    case "set_format": {
      const { f, g } = needId(d, op.id);
      if (!isRec(op.format)) return bad("format must be an object");
      if (g) {
        if (g.kind !== "comb") {
          return bad(
            g.kind === "table"
              ? "a table's formats live on its cells: set_format a cell (it applies to the cell's whole column or row), or set_column_type"
              : "set_format applies to a field, or to a comb group (cell_type, date_format)",
          );
        }
        return setCombFormat(d, g, op.format);
      }
      const fld = f as Field;
      const own = d.owner.get(fld.id);
      // A comb's cells share their comb's format: the op applies to the comb.
      if (own?.kind === "comb") {
        warnings.push(
          `${fld.id}: a comb's cell takes its comb's format; applied to comb ${own.id}`,
        );
        return setCombFormat(d, own, op.format);
      }
      if (own?.kind === "choice") {
        bad(`this is a member of choice group ${own.id}, whose kind fixes its format`);
      }
      if (fld.type === "signature" && !isRec(fld.format)) fld.format = {};
      const next: Record<string, unknown> = { ...(isRec(fld.format) ? fld.format : {}) };
      for (const [k, v] of Object.entries(op.format)) {
        if (k === "date_format" && v !== null && !(DATE_FORMATS as readonly unknown[]).includes(v))
          bad(`date_format must be one of ${DATE_FORMATS.join(", ")}`);
        if (v === null) delete next[k];
        else next[k] = v;
      }
      // A date field stored without a format prints in DATE_FORMATS[0]; a
      // partial format (just font_size) keeps that, since the server's date
      // format requires date_format.
      if (fld.type === "date" && next.date_format === undefined && Object.keys(next).length > 0)
        next.date_format = DATE_FORMATS[0];
      const issues = formatIssues(fld.type, next, fld.id, "format");
      if (issues.length) return bad(issues.map((i) => `${i.path} ${i.reason}`).join("; "));
      if (Object.keys(next).length === 0 && (fld.type === "signature" || fld.type === "date"))
        delete fld.format;
      else fld.format = next;
      if (own?.kind === "table") {
        applyFormatToLine(d, own, fld, isRec(fld.format) ? fld.format : undefined, warnings);
        return { touched: [fld.id, own.id], tables: [own.id] };
      }
      return { touched: [fld.id] };
    }
    case "group": {
      if (op.kind === "table") return table(groupTable(d, raw, warnings));
      if (!Array.isArray(op.ids) || op.ids.length < 1)
        return bad("ids must list the fields to group");
      if (op.kind !== "choice" && op.kind !== "comb")
        return bad('kind must be "choice", "comb" or "table"');
      if (typeof op.label !== "string") return bad("label is required (the question or caption)");
      const uniq = [
        ...new Set(op.ids.map((id) => resolveId(d, id, ["field", "group"], "ids entry"))),
      ];
      if (op.kind === "choice" && uniq.length < 2)
        return bad("a choice group needs at least 2 options");
      const fs = uniq.map((id) => {
        const f = d.field.get(id);
        if (!f) return bad(`${id} is not a field id (group ids can't be nested)`);
        if (d.owner.has(id))
          return bad(`${id} already belongs to group ${d.owner.get(id)!.id}; ungroup it first`);
        return f;
      });
      const page = fs[0].page;
      if (fs.some((f) => f.page !== page))
        return bad("all grouped fields must be on the same page");
      const gid = randomUUID();
      const g: Group = {
        id: gid,
        kind: op.kind,
        label: op.label.trim(),
        page,
        members: fs.map((f) => f.id),
        ...(op.kind === "choice"
          ? { format: op.multiple === true ? "multiple" : "single" }
          : { cell_type: "char" }),
      } as Group;
      for (const f of fs) {
        f.group = gid;
        if (op.kind === "choice") {
          if (f.type !== "checkbox") {
            f.type = "checkbox" as Field["type"];
            f.format = { shape: "square", symbol: "✗" };
          }
        } else {
          f.type = "text" as Field["type"];
          delete f.format;
        }
        delete f.primitive;
        delete f.signing_requirement;
        d.owner.set(f.id, g);
      }
      // The group stands where its earliest member stood (the editor's groupAs):
      // on a page with an explicit order it would otherwise fall to the end.
      const ranks = fs.map((f) => f.order).filter((o): o is number => typeof o === "number");
      if (ranks.length) g.order = Math.min(...ranks);
      d.s.groups.push(g);
      d.group.set(gid, g);
      if (op.kind === "comb") setCombTyping(d, g, op.cell_type, op.date_format);
      return {
        touched: [gid],
        added: gid,
        members: readingMembers(d, g).map((m) => m.id),
        section: sectionOf(d, page, gid),
        ...(op.kind === "comb"
          ? { comb: gid }
          : { batchOrder: { id: gid, ids: fs.map((f) => f.id) } }),
      };
    }
    case "ungroup": {
      const g = needGroup(d, op.id);
      if (g.kind === "table")
        warnings.push(`ungrouped table ${g.id}: its cells are now separate fields`);
      const ms = members(d, g);
      for (const m of ms) {
        m.group = null;
        d.owner.delete(m.id);
      }
      removeGroup(d, g);
      return { touched: ms.map((m) => m.id), deleted: [g.id] };
    }
    case "set_options": {
      const g = needGroup(d, op.id);
      if (g.kind !== "choice") return bad("set_options applies to a radio/multiselect group id");
      if (!Array.isArray(op.options) || op.options.length === 0)
        return bad("options must be a non-empty list");
      const opts = members(d, g);
      if (op.options.every((o) => typeof o === "string")) {
        if (op.options.length !== opts.length) {
          return bad(
            `this group has ${String(opts.length)} options; pass that many labels (they go in the order of the ids of this call's group op that made it, else in reading order, as get_template lists them), or [{id, label}] pairs. Add an option with add_option, or remove one with remove_option.`,
          );
        }
        // The order analyze/get_template list them (resolveMembers: reading order),
        // unless this batch's group op made the group: then the order of its ids,
        // while they are still exactly its options.
        const reading = readingMembers(d, g).map((m) => m.id);
        const given = d.batchGroups?.get(g.id);
        const current = new Set(opts.map((m) => m.id));
        const order =
          given && given.length === current.size && given.every((id) => current.has(id))
            ? given
            : reading;
        order.forEach((id, i) => {
          const live = d.field.get(id);
          if (live) live.label = (op.options[i] as string).trim();
        });
        if (order.some((id, i) => id !== reading[i])) {
          warnings.push(
            `options_order_differs_from_reading_order: group ${g.id}'s labels follow the ids order of its group op (${order.join(", ")}), not reading order (${reading.join(", ")}); check them, or pass [{id, label}]`,
          );
        }
      } else {
        for (const o of op.options) {
          if (!isRec(o) || typeof o.id !== "string" || typeof o.label !== "string") {
            return bad("options must be all strings, or all {id, label} pairs");
          }
          const oid = resolveId(d, o.id, ["field"], "option id");
          const f = opts.find((x) => x.id === oid);
          if (!f) return bad(`${oid} is not an option of this group`);
          f.label = o.label.trim();
        }
      }
      return {
        touched: [g.id],
        options: readingMembers(d, g).map((m) => ({
          id: m.id,
          label: typeof m.label === "string" ? m.label : "",
        })),
      };
    }
    case "add_option": {
      const g = needGroup(d, op.id);
      if (g.kind !== "choice") return bad("add_option applies to a radio/multiselect group id");
      if (typeof op.label !== "string" || !op.label.trim())
        return bad("label is required (the option's printed text)");
      const box = boxArg(op.box);
      const ms = members(d, g);
      const n = ms.length;
      if (op.index !== undefined && (!Number.isInteger(op.index) || op.index < 0 || op.index > n))
        return bad(`index must be 0–${String(n)} (${String(n)} = last)`);
      const sib = ms.find((m) => m.type === "checkbox" && isRec(m.format));
      const f = {
        id: randomUUID(),
        label: op.label.trim(),
        type: "checkbox",
        format: sib ? structuredClone(sib.format) : { shape: "square", symbol: "✗" },
        page: g.page,
        section_id: ms.find((m) => typeof m.section_id === "string")?.section_id ?? null,
        xpct: box.x * 100,
        ypct: box.y * 100,
        wpct: box.w * 100,
        hpct: box.h * 100,
        group: g.id,
      } as Field;
      d.s.fields.push(f);
      d.field.set(f.id, f);
      d.owner.set(f.id, g);
      const list = Array.isArray(g.members) ? [...(g.members as string[])] : [];
      list.splice(op.index ?? list.length, 0, f.id);
      g.members = list;
      return { touched: [g.id, f.id], added: f.id };
    }
    case "remove_option": {
      const g = needGroup(d, op.id);
      if (g.kind !== "choice") return bad("remove_option applies to a radio/multiselect group id");
      const oid = resolveId(d, op.option, ["field"], "option");
      if (d.owner.get(oid) !== g) return bad(`${oid} is not an option of group ${g.id}`);
      if (members(d, g).length <= 2) {
        return bad("a choice group needs at least 2 options; delete or ungroup the group instead");
      }
      dropMembers(d, g, new Set([oid]));
      removeFields(d, new Set([oid]));
      return { touched: [g.id], deleted: [oid] };
    }
    case "comb_add_cell": {
      const g = needGroup(d, op.id);
      if (g.kind !== "comb") return bad("comb_add_cell applies to a comb group id");
      const box = boxArg(op.box);
      const ms = members(d, g);
      const f = combCell(g, box, ms.find((m) => typeof m.section_id === "string")?.section_id);
      d.s.fields.push(f);
      d.field.set(f.id, f);
      d.owner.set(f.id, g);
      g.members = [...(Array.isArray(g.members) ? (g.members as string[]) : []), f.id];
      keepDateFormat(d, g, op.date_format);
      return {
        touched: [g.id, f.id],
        added: f.id,
        comb: g.id,
        members: readingMembers(d, g).map((m) => m.id),
      };
    }
    case "comb_remove_cell": {
      const f = needField(d, op.id);
      const g = d.owner.get(f.id);
      if (!g || g.kind !== "comb") return bad(`${f.id} is not a cell of a comb`);
      if (Array.isArray(f.cells) && f.cells.length > 1)
        return bad(
          `${f.id} is one field over ${String(f.cells.length)} printed cells: delete it, or retype the comb`,
        );
      if (combSlotCount(d, g) - 1 < 2)
        return bad("a comb keeps at least 2 cells; delete or ungroup it instead");
      dropMembers(d, g, new Set([f.id]));
      removeFields(d, new Set([f.id]));
      keepDateFormat(d, g, op.date_format);
      return {
        touched: [g.id],
        deleted: [f.id],
        comb: g.id,
        members: readingMembers(d, g).map((m) => m.id),
      };
    }
    case "set_required": {
      const { f, g } = needId(d, op.id);
      if (typeof op.required !== "boolean") return bad("required must be true or false");
      const item = (g ?? f)!;
      if (op.required) item.required = true;
      else delete item.required;
      return { touched: [item.id] };
    }
    case "set_description":
    case "set_placeholder": {
      const key = op.op === "set_description" ? "description" : "placeholder";
      const { f, g } = needId(d, op.id);
      const v = raw[key];
      if (v !== null && typeof v !== "string")
        return bad(`${key} must be a string (or null to clear it)`);
      const item = (g ?? f)! as Record<string, unknown> & { id: string };
      if (v === null || !(v as string).trim()) delete item[key];
      else item[key] = (v as string).trim();
      return { touched: [item.id] };
    }
    case "set_autofill": {
      const f = needField(d, op.id);
      const v = op.autofill;
      if (v === null) delete f.autofill;
      else if (typeof v === "string" && (AUTOFILL_TOKENS as readonly string[]).includes(v))
        f.autofill = v;
      else return bad(`autofill must be one of ${AUTOFILL_TOKENS.join(", ")}, or null to clear it`);
      return { touched: [f.id] };
    }
    case "table_insert":
      return table(tableInsert(d, raw, warnings));
    case "table_delete":
      return table(tableDelete(d, raw, warnings));
    case "table_add_cell":
      return table(tableAddCell(d, raw, warnings));
    case "table_adopt":
      return table(tableAdopt(d, raw, warnings));
    case "set_column_type":
      return table(setColumnType(d, raw, warnings));
    case "set_orientation":
      return table(setOrientation(d, raw, warnings));
    case "set_header":
      return table(setHeader(d, raw, warnings));
    case "set_headers":
      return table(setHeaders(d, raw, warnings));
    case "reorder":
      return reorder(d, raw, warnings);
    case "set_section":
      return setSection(d, raw);
    case "set_section_title":
      return setSectionTitle(d, raw);
    default:
      return bad(`unknown op "${String((op as { op: unknown }).op)}"; ops: ${OP_NAMES.join(", ")}`);
  }
}

/**
 * reorder: the listed entries (top-level fields and groups of one page) move
 * together, in the given order, to where the first of them sat; everything
 * else keeps its order. Every entry of the page then carries an explicit
 * integer `order` (the web editor's layer panel convention), which wins over
 * the box-geometry order in the fill UI and get_template. "Where the first
 * sat" is read off the page as the fill UI lists it (readOrder.ts, the one
 * implementation of that order): by `order` when the page has one, else line
 * by line.
 *
 * What a reader then sees is that order with every section gathered into one
 * run (listedOrder), so entries of different sections cannot stand together
 * whatever their ranks. The op returns the order now listed; it warns when the
 * listed entries did not all come out as asked, and is rejected when nothing
 * in the listing would change at all.
 */
function reorder(d: Doc, op: Record<string, unknown>, warnings: string[]): OneResult {
  const page = pageOf(d, op.page);
  if (!Array.isArray(op.ids) || op.ids.length === 0)
    return bad("ids must list the entries to order");
  type Block = Edges & { item: Field | Group; order: number | undefined };
  const orderOf = (item: Field | Group) =>
    typeof item.order === "number" ? item.order : undefined;
  const unordered: Block[] = [];
  for (const f of d.s.fields as Field[]) {
    if (f.page === page && !d.owner.has(f.id))
      unordered.push({ ...boxEdges(f), item: f, order: orderOf(f) });
  }
  for (const g of d.s.groups as Group[]) {
    if (g.page !== page) continue;
    const edges = membersEdges(members(d, g));
    if (edges) unordered.push({ ...edges, item: g, order: orderOf(g) });
  }
  const blocks = orderBlocks(unordered);
  const byId = new Map(blocks.map((b) => [b.item.id, b]));
  const want = op.ids.map((raw) => {
    const id = resolveId(d, raw, ["field", "group"], "ids entry");
    if (!byId.has(id)) {
      return bad(
        d.owner.has(id)
          ? `${id} is an option/cell of group ${d.owner.get(id)!.id}; reorder the group`
          : `${id} is not an entry of page ${String(page)}`,
      );
    }
    return id;
  });
  if (new Set(want).size !== want.length) return bad("ids lists an entry twice");
  const moving = new Set(want);
  const at = blocks.findIndex((b) => moving.has(b.item.id));
  const rest = blocks.filter((b) => !moving.has(b.item.id));
  const before = blocks.slice(0, at).filter((b) => !moving.has(b.item.id)).length;
  const next = [
    ...rest.slice(0, before),
    ...want.map((id) => byId.get(id)!),
    ...rest.slice(before),
  ];
  const was = listedOrder(d, page);
  next.forEach((b, i) => {
    b.item.order = i;
  });
  const listed = listedOrder(d, page);
  const from = listed.indexOf(want[0]);
  const asAsked = from !== -1 && want.every((id, k) => listed[from + k] === id);
  if (!asAsked) {
    const why = `a section is listed as one run, standing where its first entry stands, and these ids span several (${sectionsOf(d, page, want)})`;
    const fix =
      "set_section {ids, section_id} moves an entry to another section; inside one section any order works";
    if (listed.every((id, k) => id === was[k])) {
      return bad(
        `this order would change nothing in the listing: ${why}. ${fix[0].toUpperCase()}${fix.slice(1)}`,
      );
    }
    warnings.push(
      `reorder on page ${String(page)}: the ids are not all listed in the order asked, because ${why}. diff_summary.ops shows the order now listed; ${fix}`,
    );
  }
  return { touched: want, order: listed };
}

/** A page's sections (id + title), in stored order. */
function pageSections(d: Doc, page: number): SectionRef[] {
  const pg = d.s.pages.find((p) => p.page === page) as { sections?: unknown } | undefined;
  return (Array.isArray(pg?.sections) ? (pg.sections as unknown[]) : []).flatMap((s) =>
    isRec(s) && typeof s.id === "string"
      ? [{ id: s.id, title: typeof s.title === "string" ? s.title : "" }]
      : [],
  );
}

/** A group's members in reading order (the order the fill UI and get_template take them in). */
function readingMembers(d: Doc, g: Group): Field[] {
  if (!Array.isArray(g.members)) return [];
  const byId = buildFieldById(d.s.fields as unknown as Parameters<typeof buildFieldById>[0]);
  return resolveMembers(
    g as unknown as Parameters<typeof resolveMembers>[0],
    byId,
  ) as unknown as Field[];
}

/**
 * A page's top-level entries in the order a reader is shown them. It is the
 * fill UI's own listing (pageLayout.ts buildPageItems, which the server's
 * get_template order mirrors): the blocks by `order` or by printed line, then
 * every section gathered into one run standing where its first block stands.
 */
function listedOrder(d: Doc, page: number): string[] {
  type Args = Parameters<typeof buildPageItems>;
  const info = d.s.pages.find((p) => p.page === page) as Record<string, unknown> | undefined;
  const fields = (d.s.fields as Field[]).filter((f) => f.page === page && !d.owner.has(f.id));
  // A group whose members are not a list has none to place, so it is not listed.
  const groups = (d.s.groups as Group[]).filter((g) => g.page === page && Array.isArray(g.members));
  const byId = buildFieldById(d.s.fields as unknown as Parameters<typeof buildFieldById>[0]);
  const layout = buildPageItems(
    { ...info, page, sections: pageSections(d, page) } as unknown as Args[0],
    fields as unknown as Args[1],
    groups as unknown as Args[2],
    (g) => resolveMembers(g, byId),
  );
  return layout.items.flatMap((it) =>
    it.kind === "header" ? [] : [it.kind === "field" ? it.field.id : it.group.id],
  );
}

/** The section an entry is listed under: a field's own, a group's first member's
 *  (reading order); none when that names no section of the page. */
function sectionOf(d: Doc, page: number, id: string): SectionRef | null {
  const g = d.group.get(id);
  const sid = g ? readingMembers(d, g)[0]?.section_id : d.field.get(id)?.section_id;
  if (typeof sid !== "string") return null;
  return pageSections(d, page).find((s) => s.id === sid) ?? null;
}

/** `section "Income" (s2): id, id; no section: id` — at most three ids named per section. */
function sectionsOf(d: Doc, page: number, ids: readonly string[]): string {
  const by = new Map<string, { name: string; ids: string[] }>();
  for (const id of ids) {
    const sec = sectionOf(d, page, id);
    const key = sec ? sec.id : "";
    const row = by.get(key) ?? {
      name: sec ? `section ${JSON.stringify(sec.title)} (${sec.id})` : "no section",
      ids: [],
    };
    row.ids.push(id);
    by.set(key, row);
  }
  return [...by.values()]
    .map(
      (r) =>
        `${r.name}: ${r.ids.slice(0, 3).join(", ")}${r.ids.length > 3 ? ` and ${String(r.ids.length - 3)} more` : ""}`,
    )
    .join("; ");
}

/**
 * set_section: the listed fields and groups (of one page) move to another of
 * that page's sections, or out of every section (section_id: null). A group
 * moves through all its members: the fill UI reads its section off the first
 * member in reading order, this package's own helpers off the first in array
 * order, so every member has to agree.
 */
function setSection(d: Doc, op: Record<string, unknown>): OneResult {
  if (!Array.isArray(op.ids) || op.ids.length === 0)
    return bad("ids must list the fields or groups to move");
  const ids = [
    ...new Set(
      op.ids.map((raw) => {
        const id = resolveId(d, raw, ["field", "group"], "ids entry");
        const own = d.owner.get(id);
        if (own) return bad(`${id} is an option/cell of group ${own.id}; move the group`);
        return id;
      }),
    ),
  ];
  const pageOfEntry = (id: string) => (d.group.get(id) ?? d.field.get(id))?.page;
  const page = pageOfEntry(ids[0]);
  if (typeof page !== "number" || ids.some((id) => pageOfEntry(id) !== page))
    return bad("all ids must be on one page: a section belongs to one page");
  let section: SectionRef | null = null;
  if (op.section_id === undefined) {
    return bad("section_id is required (null takes the entries out of every section)");
  }
  if (op.section_id !== null) {
    const sid = resolveId(d, op.section_id, ["section"], "section_id");
    const found = pageSections(d, page).find((s) => s.id === sid);
    if (!found) {
      const have = pageSections(d, page).map((s) => `${s.id} ${JSON.stringify(s.title)}`);
      return bad(
        `section_id ${sid} is not a section of page ${String(page)} (${have.length ? `its sections: ${have.join(", ")}` : "the page has no sections"})`,
      );
    }
    section = found;
  }
  for (const id of ids) {
    const g = d.group.get(id);
    for (const f of g ? members(d, g) : [d.field.get(id) as Field]) {
      f.section_id = section ? section.id : null;
    }
  }
  return { touched: ids, section };
}

/** set_section_title: the heading of one section of one page (section ids can
 *  repeat from page to page, so the page is part of the address). */
function setSectionTitle(d: Doc, op: Record<string, unknown>): OneResult {
  const page = pageOf(d, op.page);
  const sid = resolveId(d, op.section_id, ["section"], "section_id");
  const pg = d.s.pages.find((p) => p.page === page) as { sections?: unknown } | undefined;
  const sec = (Array.isArray(pg?.sections) ? (pg.sections as unknown[]) : []).find(
    (s): s is Record<string, unknown> => isRec(s) && s.id === sid,
  );
  if (!sec) return bad(`section_id ${sid} is not a section of page ${String(page)}`);
  if (typeof op.title !== "string" || !op.title.trim())
    return bad("title is required: the heading the form prints over these fields");
  sec.title = op.title.trim();
  const issues = sectionIssues(sec, `section ${sid}`);
  if (issues.length) return bad(issues.map((i) => `${i.path} ${i.reason}`).join("; "));
  return { touched: [], section: { id: sid, title: sec.title as string } };
}

/** A comb's date_format: one D/M/Y letter per cell, e.g. DDMMYYYY for 8 cells. */
/** A comb's printed cells: one per member, or as many as a member spans. */
function combSlotCount(d: Doc, g: Group): number {
  return members(d, g).reduce(
    (n, m) => n + (Array.isArray(m.cells) && m.cells.length > 1 ? m.cells.length : 1),
    0,
  );
}

const CELL_TYPES: readonly unknown[] = ["char", "integer", "date"];
/** The most cells one comb op makes (an IBAN has 34). */
export const MAX_COMB_CELLS = 100;

/** A comb's cell: a text field with no label (nobody sees a cell's own). */
function combCell(g: Group, b: Box, section: unknown): Field {
  return {
    id: randomUUID(),
    label: "",
    type: "text",
    page: g.page,
    section_id: typeof section === "string" ? section : null,
    xpct: b.x * 100,
    ypct: b.y * 100,
    wpct: b.w * 100,
    hpct: b.h * 100,
    group: g.id,
  } as Field;
}

/** The cells of a new comb (fractions): `cells` boxes as given, or `box` cut into `cells` equal ones. */
function combBoxes(cells: unknown, box: () => Box): Box[] {
  if (Array.isArray(cells)) {
    if (cells.length < 2 || cells.length > MAX_COMB_CELLS)
      return bad(`cells lists 2–${String(MAX_COMB_CELLS)} cell boxes`);
    return cells.map((c, i) => boxArg(c, `cells[${String(i)}]`));
  }
  if (!Number.isInteger(cells) || (cells as number) < 2 || (cells as number) > MAX_COMB_CELLS) {
    return bad(
      `cells is the number of printed cells (2–${String(MAX_COMB_CELLS)}), cut from the box in equal widths, or a list of the cells' own boxes [{x, y, w, h}, …] (for cells split by printed separators)`,
    );
  }
  const b = box();
  const n = cells as number;
  return Array.from({ length: n }, (_, i) => ({
    x: b.x + (i * b.w) / n,
    y: b.y,
    w: b.w / n,
    h: b.h,
  }));
}

/** A new comb group over `boxes`, its cells added to the document. */
function newComb(
  d: Doc,
  a: {
    page: number;
    boxes: Box[];
    label: string;
    section: unknown;
    cellType?: unknown;
    dateFormat?: unknown;
  },
): Group {
  const g = {
    id: randomUUID(),
    kind: "comb",
    label: a.label,
    page: a.page,
    members: [],
    cell_type: "char",
  } as Group;
  const cells = a.boxes.map((b) => combCell(g, b, a.section));
  for (const f of cells) {
    d.s.fields.push(f);
    d.field.set(f.id, f);
    d.owner.set(f.id, g);
  }
  g.members = cells.map((f) => f.id);
  d.s.groups.push(g);
  d.group.set(g.id, g);
  setCombTyping(d, g, a.cellType, a.dateFormat);
  return g;
}

/** A comb's cell_type and date_format as an op gives them; a date_format makes it a date comb. */
function setCombTyping(d: Doc, g: Group, cellType: unknown, dateFormat: unknown): void {
  const comb = g as Record<string, unknown>;
  if (cellType !== undefined) {
    if (!CELL_TYPES.includes(cellType)) bad('cell_type is "char", "integer" or "date"');
    comb.cell_type = cellType;
  }
  if (dateFormat !== undefined && dateFormat !== null) {
    if (cellType !== undefined && cellType !== "date")
      bad('date_format needs cell_type "date": leave cell_type out, or pass "date"');
    checkCombDateFormat(d, g, dateFormat);
    comb.cell_type = "date";
    comb.date_format = dateFormat;
  }
}

/** After a cell is added or removed: a date comb's date_format (one letter per
 *  cell) must be given anew. */
function keepDateFormat(d: Doc, g: Group, given: unknown): void {
  const comb = g as Record<string, unknown>;
  if (given !== undefined && given !== null) return setCombTyping(d, g, undefined, given);
  if (comb.cell_type === "date" && typeof comb.date_format === "string" && comb.date_format) {
    bad(
      `comb ${g.id} is a date comb (date_format ${comb.date_format}, one letter per cell): pass date_format for its ${String(combSlotCount(d, g))} cells`,
    );
  }
}

/** set_format on a comb group: cell_type and date_format only. */
function setCombFormat(d: Doc, g: Group, format: Record<string, unknown>): OneResult {
  const comb = g as Record<string, unknown>;
  const dated = format.date_format !== undefined && format.date_format !== null;
  for (const [k, v] of Object.entries(format)) {
    if (k !== "cell_type" && k !== "date_format")
      bad(`a comb group's format keys are cell_type and date_format, not ${k}`);
    if (k === "date_format" && v !== null) checkCombDateFormat(d, g, v);
    if (v === null) delete comb[k];
    else comb[k] = v;
  }
  // A fill reads a comb's date_format only on date cells (agentValues.ts),
  // so giving one makes the comb a date comb.
  if (dated) {
    if (format.cell_type !== undefined && format.cell_type !== "date")
      bad('date_format needs cell_type "date": leave cell_type out, or pass "date"');
    comb.cell_type = "date";
  }
  return { touched: [g.id], comb: g.id };
}

/** add {type: "comb"}: a comb group made in one op. */
function addComb(d: Doc, op: Record<string, unknown>): OneResult {
  const page = pageOf(d, op.page);
  if (typeof op.label !== "string")
    return bad("label is required (the form's caption for this blank)");
  if (op.snap !== undefined)
    return bad("a comb takes no snap: give its cells' boxes, or its outer box and a cell count");
  const boxes = combBoxes(op.cells, () => boxArg(op.box));
  let section: string | null;
  if (op.section_id !== undefined) {
    const sid = resolveId(d, op.section_id, ["section"], "section_id");
    if (!sectionIds(d, page).has(sid)) {
      return bad(`section_id ${sid} is not a section of page ${String(page)}`);
    }
    section = sid;
  } else section = sectionForPos(d, page, boxes[0].x * 100, boxes[0].y * 100);
  const g = newComb(d, {
    page,
    boxes,
    label: op.label.trim(),
    section,
    cellType: op.cell_type,
    dateFormat: op.date_format,
  });
  if (typeof op.description === "string" && op.description.trim())
    g.description = op.description.trim();
  if (op.required === true) g.required = true;
  return {
    touched: [g.id],
    added: g.id,
    comb: g.id,
    members: readingMembers(d, g).map((m) => m.id),
    section: sectionOf(d, page, g.id),
  };
}

/** retype {type: "comb"}: a standalone text or date field becomes a comb over
 *  its box (or the cells given), keeping its label, section, order, required
 *  and description; the field itself is replaced. */
function retypeComb(
  d: Doc,
  op: Record<string, unknown>,
  f: Field | undefined,
  warnings: string[],
): OneResult {
  if (!f) return bad("only a field can be retyped to a comb; ungroup a group first");
  if (d.owner.has(f.id))
    return bad(`this is a member of group ${d.owner.get(f.id)!.id}; ungroup it first`);
  if (f.type !== "text" && f.type !== "date")
    return bad("only a text or date field can become a comb");
  const boxes = combBoxes(op.cells, () => ({
    x: f.xpct / 100,
    y: f.ypct / 100,
    w: f.wpct / 100,
    h: f.hpct / 100,
  }));
  let dateFormat = op.date_format;
  if (
    f.type === "date" &&
    (op.cell_type === undefined || op.cell_type === "date") &&
    dateFormat === undefined
  ) {
    // The field's printed date format, its separators dropped (DD/MM/YYYY → DDMMYYYY).
    const printed =
      isRec(f.format) && typeof f.format.date_format === "string"
        ? f.format.date_format
        : DATE_FORMATS[0];
    const letters = printed.replace(/[^DMY]/g, "");
    if (letters.length === boxes.length) dateFormat = letters;
    else
      warnings.push(
        `${f.id}: its date format ${printed} has ${String(letters.length)} digits, the comb ${String(boxes.length)} cells; set_format the comb's date_format (one D, M or Y per cell)`,
      );
  }
  const g = newComb(d, {
    page: f.page,
    boxes,
    label: typeof f.label === "string" ? f.label : "",
    section: f.section_id,
    cellType: op.cell_type,
    dateFormat,
  });
  if (f.required === true) g.required = true;
  if (typeof f.description === "string" && f.description.trim()) g.description = f.description;
  if (typeof f.order === "number") g.order = f.order;
  removeFields(d, new Set([f.id]));
  return {
    touched: [g.id],
    added: g.id,
    deleted: [f.id],
    comb: g.id,
    members: readingMembers(d, g).map((m) => m.id),
    section: sectionOf(d, f.page, g.id),
  };
}

function checkCombDateFormat(d: Doc, g: Group, v: unknown): void {
  const slots = combSlotCount(d, g);
  if (typeof v !== "string" || !/^[DMY]+$/.test(v) || v.length !== slots) {
    bad(
      `a comb's date_format has one letter (D, M or Y) per cell: this comb has ${String(slots)} cells (e.g. ${slots === 8 ? "DDMMYYYY" : slots === 6 ? "DDMMYY" : "D".repeat(Math.min(2, slots)) + "…"})`,
    );
  }
}

/** A comb as the fill core reads it off the schema (null when it reads none there). */
function combFormat(render: RenderSchema, id: string): CombFormat | null {
  try {
    const schema = normalizeSchema(
      structuredClone(render) as unknown as Parameters<typeof normalizeSchema>[0],
    );
    const e = agentEntries(schema).find((x) => x.id === id);
    if (e?.kind !== "comb") return null;
    return { cell_type: e.cellType, date_format: e.dateFormat, max_length: e.maxLength };
  } catch {
    return null;
  }
}

/** The validation issues of the items an op left behind (touched ids and their groups). */
function touchedIssues(d: Doc, ids: readonly string[], tables: readonly string[] = []): Issue[] {
  const out: Issue[] = [];
  const seen = new Set<string>();
  const check = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const f = d.field.get(id);
    if (f) out.push(...fieldIssues(f, `field ${id}`));
    const g = d.group.get(id);
    if (g) {
      out.push(...groupIssues(g, `group ${id}`));
      for (const m of members(d, g)) check(m.id);
    }
    const own = d.owner.get(id);
    if (own && d.group.has(own.id)) check(own.id);
  };
  for (const id of ids) check(id);
  for (const id of tables) {
    const g = d.group.get(id);
    if (g) out.push(...tableIssues(d, g));
  }
  return out;
}

/** Wording that repeats an answer (echo.ts EchoGuard.check). */
export type WordingScreen = (wording: readonly Wording[]) => Screened;

/**
 * Apply `ops` in order to a copy of `render`; each op is all-or-nothing.
 * `screen` (the echo guard) sees the wording each op adds or changes; an op
 * whose wording it refuses is rejected (the reason names the id and the
 * properties, never the text), one it warns about applies with a warning.
 * With `opts.confirmWording`, a refusal the agent has already been told about
 * applies instead, with a warning; one it has not seen is still rejected.
 */
export function applyOps(
  render: RenderSchema,
  ops: readonly unknown[],
  screen?: WordingScreen,
  opts: ApplyOptions = {},
): ApplyResult {
  // Geometry ops whose item ends up off the page are excluded and the batch
  // replayed without them (each replay excludes at least one more op, so it ends).
  const excluded = new Map<number, string>();
  for (;;) {
    const pass = applyPass(render, ops, excluded, screen, opts);
    if (!pass.offPage.size) return pass.result;
    for (const [i, reason] of pass.offPage) excluded.set(i, reason);
  }
}

function applyPass(
  render: RenderSchema,
  ops: readonly unknown[],
  excluded: ReadonlyMap<number, string>,
  screen: WordingScreen | undefined,
  opts: ApplyOptions,
): { result: ApplyResult; offPage: Map<number, string> } {
  let cur: RenderSchema = structuredClone(render);
  /** op index → the item its geometry op placed */
  const placed = new Map<number, string>();
  const rejected: Rejected[] = [];
  const counts: Record<string, number> = {};
  const added: { op_index: number; id: string }[] = [];
  const deleted: string[] = [];
  const touchedIds = new Set<string>();
  const warnings: string[] = [];
  const outcomes: OpOutcome[] = [];
  const told: Refusal[] = [];
  const confirmed: Refusal[] = [];
  // The batch's refs: what an op with `ref` added, for "$ref" in later ops.
  const refs = new Map<string, string>();
  // The batch's choice groups: the ids order their group op gave (set_options follows it).
  const batchGroups = new Map<string, string[]>();
  let applied = 0;
  ops.forEach((raw, i) => {
    const skip = excluded.get(i);
    if (skip !== undefined) {
      rejected.push({ op_index: i, reason: skip });
      return;
    }
    const draft = structuredClone(cur);
    const d = index(draft);
    d.refs = refs;
    d.batchGroups = batchGroups;
    const w: string[] = [];
    try {
      const given = isRec(raw) ? raw.ref : undefined;
      if (given !== undefined && (typeof given !== "string" || !REF_NAME.test(given)))
        bad('ref names what this op adds: a letter, then letters, digits, "_" or "-" (32 at most)');
      const ref = typeof given === "string" ? given : undefined;
      if (ref !== undefined && refs.has(ref))
        bad(`ref "${ref}" is already taken by an earlier op of this batch`);
      const r = applyOne(d, raw as Op, w, opts);
      if (ref !== undefined && !r.added)
        bad(
          "ref names what an op adds (add, group, add_option, comb_add_cell…); this op adds nothing",
        );
      let issues = touchedIssues(d, r.touched, r.tables);
      if (issues.length) {
        // An op answers only for the problems it brings: one the touched items
        // already had (a stored table whose columns mix types) does not block it.
        const before = index(cur);
        const had = new Set(
          touchedIssues(
            before,
            r.touched.filter((id) => before.field.has(id) || before.group.has(id)),
            (r.tables ?? []).filter((id) => before.group.has(id)),
          ).map((x) => `${x.path} ${x.reason}`),
        );
        // A mixed line is matched by its cells, not its index, which a column
        // insert or delete shifts: it was there if a line that already mixed
        // shares a cell with it and held every type it holds now.
        const stillMixed = (x: Issue): boolean => {
          const m = / (\d+) mixes types$/.exec(x.reason);
          const g = d.group.get(x.id ?? "");
          const was = before.group.get(x.id ?? "");
          if (!m || !g || !was) return false;
          const now = mixedLineCells(d, g).find((l) => l.index === Number(m[1]));
          return (
            !!now &&
            mixedLineCells(before, was).some(
              (l) =>
                now.ids.some((id) => l.ids.includes(id)) &&
                now.keys.every((k) => l.keys.includes(k)),
            )
          );
        };
        issues = issues.filter((x) => !had.has(`${x.path} ${x.reason}`) && !stillMixed(x));
      }
      if (issues.length) {
        bad(
          issues
            .slice(0, 5)
            .map((x) => `${x.path} ${x.reason}`)
            .join("; "),
        );
      }
      for (const id of r.tables ?? []) {
        const g = d.group.get(id);
        const mixed = g ? mixedLines(d, g) : [];
        if (!g || !mixed.length) continue;
        const word = lineWord(g);
        w.push(
          `table ${id}: ${mixed.map((n) => `${word} ${String(n)}`).join(", ")} still store${mixed.length === 1 ? "s" : ""} mixed types; fill, print and get_template use one type per ${word} (its first typed cell's), so set_column_type or set_format a cell of each to settle them`,
        );
      }
      let vouched: Refusal[] = [];
      if (screen) {
        const changed = changedWording(cur, draft);
        const echo = changed.length ? screen(changed) : null;
        if (echo?.refused.length) {
          // An entry this op makes has an id the agent never sees (and a new
          // one on every try): it is named as what it is.
          const known = index(cur);
          const name = (id: string) =>
            known.field.has(id) || known.group.has(id) || known.section.has(id)
              ? id
              : "the new entry";
          // Confirmable only once the agent has been told what matched: a flag
          // sent ahead of the refusal confirms nothing.
          if (opts.confirmWording === true && echo.refused.every((x) => x.shown)) {
            vouched = echo.refused;
            w.push(
              `${describeWording(echo.refused, name)}: matches an answer filled in this session; applied because confirm_wording says it is the form's own wording`,
            );
          } else {
            told.push(...echo.refused);
            bad(
              `${describeWording(echo.refused, name)} matches an answer filled in this session. Labels, descriptions, placeholders, options and formats hold the form's own wording, never an answer: answers go only in fill values. If this is the form's printed wording, send the op again with confirm_wording: true on the call`,
            );
          }
        }
        for (const id of echo?.warn ?? []) {
          w.push(
            `${describeWording(changed.filter((x) => x.id === id))}: short wording that matches a short answer from this session (allowed under 4 characters); check it is the form's own text`,
          );
        }
      }
      const name = (raw as Op).op;
      // An op that leaves the schema exactly as it was (set_format to the same
      // value, a move by 0) still counts as applied, flagged so the agent knows.
      const noop = JSON.stringify(draft) === JSON.stringify(cur);
      const comb = r.comb !== undefined ? combFormat(draft, r.comb) : null;
      outcomes.push({
        op_index: i,
        op: name,
        ...(r.snapped !== undefined ? { snapped: r.snapped } : {}),
        ...(comb ? { comb } : {}),
        ...(r.order ? { order: r.order } : {}),
        ...(r.section !== undefined ? { section: r.section } : {}),
        ...(r.members ? { members: r.members } : {}),
        ...(r.options ? { options: r.options } : {}),
        ...(noop ? { noop: true as const } : {}),
      });
      cur = draft;
      applied++;
      if (typeof ref === "string" && r.added) refs.set(ref, r.added);
      if (r.batchOrder) batchGroups.set(r.batchOrder.id, r.batchOrder.ids);
      confirmed.push(...vouched);
      counts[name] = (counts[name] ?? 0) + 1;
      if (r.added) added.push({ op_index: i, id: r.added });
      if (r.geometry) placed.set(i, r.geometry);
      for (const id of r.deleted ?? []) {
        deleted.push(id);
        touchedIds.delete(id);
      }
      for (const id of r.touched) touchedIds.add(id);
      warnings.push(...w);
    } catch (e) {
      if (!(e instanceof OpError)) throw e;
      rejected.push({ op_index: i, reason: e.message });
    }
  });
  const d = index(cur);
  // Page bounds of every item a geometry op placed, on the batch's final state.
  const offPage = new Map<number, string>();
  for (const [i, id] of placed) {
    const g = d.group.get(id);
    const f = d.field.get(id);
    const bb = bbox(g ? members(d, g) : f ? [f] : []);
    if (!bb) continue; // deleted later in the batch
    const box = { x: bb.x / 100, y: bb.y / 100, w: bb.w / 100, h: bb.h / 100 };
    if (!onPage(box)) {
      const b = { x: round(box.x), y: round(box.y), w: round(box.w), h: round(box.h) };
      offPage.set(
        i,
        `${ON_PAGE}; after the whole batch ${id} would be at x ${String(b.x)}, y ${String(b.y)}, w ${String(b.w)}, h ${String(b.h)}`,
      );
    }
  }
  const touched = [...touchedIds].flatMap((id) => {
    const t = touchedOf(d, id);
    return t ? [t] : [];
  });
  rejected.sort((a, b) => a.op_index - b.op_index);
  return {
    result: {
      render: cur,
      applied,
      rejected,
      diff_summary: { counts, added, deleted, touched, ops: outcomes },
      warnings,
      screened: { told, confirmed },
    },
    offPage,
  };
}

/** One string of a form's wording: the item id, the property it sits in. A
 *  section also carries its page: section ids repeat from page to page (`s1`,
 *  `s2`, …), so the id alone does not say which section it is. */
export interface Wording {
  id: string;
  page?: number;
  prop: string;
  text: string;
  /** A comb cell's label: nobody sees it, so one equal to an answer of under 4 characters is not warned about. */
  quiet?: true;
}

/**
 * Every free-text string of the form's wording in a schema (anything an edit
 * op can set to arbitrary text), with the id and property it belongs to.
 */
export function wordingOf(s: RenderSchema): Wording[] {
  const out: Wording[] = [];
  const add = (id: unknown, prop: string, v: unknown, page?: unknown, quiet = false) => {
    if (typeof v === "string" && v.trim() && typeof id === "string")
      out.push({
        id,
        ...(typeof page === "number" ? { page } : {}),
        prop,
        text: v,
        ...(quiet ? { quiet: true as const } : {}),
      });
  };
  const rec = (x: unknown): Record<string, unknown> | null =>
    typeof x === "object" && x !== null && !Array.isArray(x)
      ? (x as Record<string, unknown>)
      : null;
  // A comb's cells are never shown by their own label (the comb is one entry,
  // under the group's): a placeholder label on one ("D1") equal to an answer
  // too short to refuse is not warned about; a longer answer is refused.
  const combCells = new Set<unknown>();
  for (const g of s.groups as Record<string, unknown>[]) {
    if (g.kind === "comb" && Array.isArray(g.members)) for (const m of g.members) combCells.add(m);
  }
  for (const f of s.fields as Record<string, unknown>[]) {
    for (const k of ["label", "description", "placeholder"])
      add(f.id, k, f[k], undefined, k === "label" && combCells.has(f.id));
    const fmt = rec(f.format);
    if (fmt) for (const k of ["date_format", "symbol"]) add(f.id, `format.${k}`, fmt[k]);
  }
  for (const g of s.groups as Record<string, unknown>[]) {
    for (const k of ["label", "description", "placeholder", "date_format"]) add(g.id, k, g[k]);
    for (const k of ["header_cols", "header_rows"]) {
      const v = g[k];
      if (Array.isArray(v)) for (const h of v) add(g.id, k, h);
    }
    const fmt = rec(g.format);
    if (fmt) for (const k of ["date_format", "symbol"]) add(g.id, `format.${k}`, fmt[k]);
  }
  for (const p of s.pages as Record<string, unknown>[]) {
    const secs = Array.isArray(p.sections) ? (p.sections as Record<string, unknown>[]) : [];
    for (const sec of secs)
      for (const k of ["title", "description", "placeholder"]) add(sec.id, k, sec[k], p.page);
  }
  return out;
}

/** The wording of `next` that `prev` doesn't have (same entry + property + text). */
export function changedWording(prev: RenderSchema, next: RenderSchema): Wording[] {
  const at = (w: Wording) => `${entryKey(w)}\0${w.prop}\0${w.text}`;
  const before = new Set(wordingOf(prev).map(at));
  return wordingOf(next).filter((w) => !before.has(at(w)));
}

/** Changed wording as [{id, properties}] per entry (a section with its page):
 *  never the text itself. */
export function wordingChanges(
  changed: readonly Wording[],
): { id: string; page?: number; properties: string[] }[] {
  const by = new Map<string, { id: string; page?: number; props: Set<string> }>();
  for (const w of changed) {
    const key = entryKey(w);
    const entry = by.get(key) ?? {
      id: w.id,
      ...(w.page === undefined ? {} : { page: w.page }),
      props: new Set<string>(),
    };
    entry.props.add(w.prop);
    by.set(key, entry);
  }
  return [...by.values()].map(({ props, ...entry }) => ({
    ...entry,
    properties: [...props].sort(),
  }));
}

/** "the label of f-1, the title of s1 on page 2" — ids + properties only. */
export function describeWording(
  wording: readonly Wording[],
  name: (id: string) => string = (id) => id,
): string {
  return wordingChanges(wording)
    .map(
      (c) =>
        `the ${c.properties.join("/")} of ${name(c.id)}${c.page === undefined ? "" : ` on page ${String(c.page)}`}`,
    )
    .join(", ");
}

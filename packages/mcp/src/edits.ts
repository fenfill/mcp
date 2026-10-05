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

import { buildFieldById, resolveMembers } from "@/app/t/[template_id]/fillCore";
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
  removeGroup,
  resolveId,
  round,
  transform,
} from "./doc.js";
import {
  applyFormatToLine,
  groupTable,
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
import type { RenderSchema } from "./types.js";
import { fieldIssues, formatIssues, groupIssues, type Issue } from "./validate.js";

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
  | { op: "retype"; id: string; type: string }
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
  | { op: "delete"; id: string }
  | { op: "set_format"; id: string; format: Record<string, unknown> }
  | { op: "group"; ids: string[]; kind: "choice" | "comb"; label: string; multiple?: boolean }
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
  | { op: "reorder"; page: number; ids: string[] };

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
] as const;

export interface Rejected {
  op_index: number;
  reason: string;
}

/** One applied op: its kind, whether a requested snap landed, and whether it changed nothing. */
export interface OpOutcome {
  op_index: number;
  op: string;
  snapped?: boolean;
  noop?: true;
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
}

/**
 * Finds the blank a box was meant for in the page render (snap.ts): given a
 * box in fractions, the snapped box, or a reason it found none nearby.
 */
export type Snapper = (page: number, box: Box, mode: SnapMode) => { box: Box } | { none: string };

export interface ApplyOptions {
  snap?: Snapper;
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
      return { touched: [id], added: id, geometry: id, snapped };
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
        for (const [k, v] of Object.entries(op.format)) {
          if (k !== "cell_type" && k !== "date_format")
            bad(`a comb group's format keys are cell_type and date_format, not ${k}`);
          if (k === "date_format" && v !== null) checkCombDateFormat(d, g, v);
          if (v === null) delete (g as Record<string, unknown>)[k];
          else (g as Record<string, unknown>)[k] = v;
        }
        return { touched: [g.id] };
      }
      const fld = f as Field;
      const own = d.owner.get(fld.id);
      if (own && (own.kind === "comb" || own.kind === "choice")) {
        bad(`this is a member of ${String(own.kind)} group ${own.id}, whose kind fixes its format`);
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
      d.s.groups.push(g);
      d.group.set(gid, g);
      return { touched: [gid], added: gid };
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
            `this group has ${String(opts.length)} options; pass that many labels (in the order the options are listed), or [{id, label}] pairs. Add an option with add_option, or remove one with remove_option.`,
          );
        }
        // The order analyze/get_template list them (resolveMembers: reading order).
        const byId = buildFieldById(d.s.fields as unknown as Parameters<typeof buildFieldById>[0]);
        const ordered = resolveMembers(g as unknown as Parameters<typeof resolveMembers>[0], byId);
        ordered.forEach((f, i) => {
          const live = d.field.get(f.id);
          if (live) live.label = (op.options[i] as string).trim();
        });
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
      return { touched: [g.id] };
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
      return reorder(d, raw);
    default:
      return bad(`unknown op "${String((op as { op: unknown }).op)}"; ops: ${OP_NAMES.join(", ")}`);
  }
}

/**
 * reorder: the listed entries (top-level fields and groups of one page) move
 * together, in the given order, to where the first of them sat; everything
 * else keeps its order. Every entry of the page then carries an explicit
 * integer `order` (the web editor's layer panel convention), which wins over
 * the box-geometry order in the fill UI and get_template.
 */
function reorder(d: Doc, op: Record<string, unknown>): OneResult {
  const page = pageOf(d, op.page);
  if (!Array.isArray(op.ids) || op.ids.length === 0)
    return bad("ids must list the entries to order");
  type Block = { item: Field | Group; top: number; left: number };
  const blocks: Block[] = [];
  for (const f of d.s.fields as Field[]) {
    if (f.page === page && !d.owner.has(f.id)) blocks.push({ item: f, top: f.ypct, left: f.xpct });
  }
  for (const g of d.s.groups as Group[]) {
    if (g.page !== page) continue;
    const bb = bbox(members(d, g));
    if (bb) blocks.push({ item: g, top: bb.y, left: bb.x });
  }
  const orderOf = (b: Block) => (typeof b.item.order === "number" ? b.item.order : undefined);
  const hasOrder = blocks.some((b) => orderOf(b) !== undefined);
  blocks.sort(
    (a, b) =>
      (hasOrder ? (orderOf(a) ?? Infinity) - (orderOf(b) ?? Infinity) || 0 : 0) ||
      a.top - b.top ||
      a.left - b.left,
  );
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
  next.forEach((b, i) => {
    b.item.order = i;
  });
  return { touched: want };
}

/** A comb's date_format: one D/M/Y letter per cell, e.g. DDMMYYYY for 8 cells. */
function checkCombDateFormat(d: Doc, g: Group, v: unknown): void {
  const slots = members(d, g).reduce(
    (n, m) => n + (Array.isArray(m.cells) && m.cells.length > 1 ? m.cells.length : 1),
    0,
  );
  if (typeof v !== "string" || !/^[DMY]+$/.test(v) || v.length !== slots) {
    bad(
      `a comb's date_format has one letter (D, M or Y) per cell: this comb has ${String(slots)} cells (e.g. ${slots === 8 ? "DDMMYYYY" : slots === 6 ? "DDMMYY" : "D".repeat(Math.min(2, slots)) + "…"})`,
    );
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

/** Wording ids that repeat an answer (echo.ts EchoGuard.check). */
export type WordingScreen = (wording: readonly Wording[]) => { refuse: string[]; warn: string[] };

/**
 * Apply `ops` in order to a copy of `render`; each op is all-or-nothing.
 * `screen` (the echo guard) sees the wording each op adds or changes; an op
 * whose wording it refuses is rejected (the reason names the id and the
 * properties, never the text), one it warns about applies with a warning.
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
  let applied = 0;
  ops.forEach((raw, i) => {
    const skip = excluded.get(i);
    if (skip !== undefined) {
      rejected.push({ op_index: i, reason: skip });
      return;
    }
    const draft = structuredClone(cur);
    const d = index(draft);
    const w: string[] = [];
    try {
      const r = applyOne(d, raw as Op, w, opts);
      const issues = touchedIssues(d, r.touched, r.tables);
      if (issues.length) {
        bad(
          issues
            .slice(0, 5)
            .map((x) => `${x.path} ${x.reason}`)
            .join("; "),
        );
      }
      if (screen) {
        const changed = changedWording(cur, draft);
        const echo = changed.length ? screen(changed) : { refuse: [], warn: [] };
        if (echo.refuse.length) {
          bad(
            `${describeWording(changed, echo.refuse)} matches an answer filled in this session. Labels, descriptions, placeholders, options and formats hold the form's own wording, never an answer: answers go only in fill values`,
          );
        }
        for (const id of echo.warn) {
          w.push(
            `${describeWording(changed, [id])}: short wording that matches a short answer from this session (allowed under 4 characters); check it is the form's own text`,
          );
        }
      }
      const name = (raw as Op).op;
      // An op that leaves the schema exactly as it was (set_format to the same
      // value, a move by 0) still counts as applied, flagged so the agent knows.
      const noop = JSON.stringify(draft) === JSON.stringify(cur);
      outcomes.push({
        op_index: i,
        op: name,
        ...(r.snapped !== undefined ? { snapped: r.snapped } : {}),
        ...(noop ? { noop: true as const } : {}),
      });
      cur = draft;
      applied++;
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
    },
    offPage,
  };
}

/** One string of a form's wording: the item id, the property it sits in. */
export interface Wording {
  id: string;
  prop: string;
  text: string;
}

/**
 * Every free-text string of the form's wording in a schema (anything an edit
 * op can set to arbitrary text), with the id and property it belongs to.
 */
export function wordingOf(s: RenderSchema): Wording[] {
  const out: Wording[] = [];
  const add = (id: unknown, prop: string, v: unknown) => {
    if (typeof v === "string" && v.trim() && typeof id === "string")
      out.push({ id, prop, text: v });
  };
  const rec = (x: unknown): Record<string, unknown> | null =>
    typeof x === "object" && x !== null && !Array.isArray(x)
      ? (x as Record<string, unknown>)
      : null;
  for (const f of s.fields as Record<string, unknown>[]) {
    for (const k of ["label", "description", "placeholder"]) add(f.id, k, f[k]);
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
      for (const k of ["title", "description", "placeholder"]) add(sec.id, k, sec[k]);
  }
  return out;
}

/** The wording of `next` that `prev` doesn't have (same id + property + text). */
export function changedWording(prev: RenderSchema, next: RenderSchema): Wording[] {
  const before = new Set(wordingOf(prev).map((w) => `${w.id}\0${w.prop}\0${w.text}`));
  return wordingOf(next).filter((w) => !before.has(`${w.id}\0${w.prop}\0${w.text}`));
}

/** Changed wording as [{id, properties}] per id: never the text itself. */
export function wordingChanges(
  changed: readonly Wording[],
): { id: string; properties: string[] }[] {
  const by = new Map<string, Set<string>>();
  for (const w of changed) {
    const set = by.get(w.id) ?? new Set<string>();
    set.add(w.prop);
    by.set(w.id, set);
  }
  return [...by].map(([id, props]) => ({ id, properties: [...props].sort() }));
}

/** "the label of f-1, the format.date_format of g-2" — ids + properties only. */
function describeWording(changed: readonly Wording[], ids: readonly string[]): string {
  const want = new Set(ids);
  return wordingChanges(changed.filter((w) => want.has(w.id)))
    .map((c) => `the ${c.properties.join("/")} of ${c.id}`)
    .join(", ");
}

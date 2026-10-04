// edit_template's ops, applied to a local working copy of a render schema.
//
// Ids are the agent ids analyze_form / get_template show: a field id, a
// group id (radio/multiselect/comb/table), or an option / cell id (the member
// fields of a group). Coordinates use the agent schema's box convention:
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

import type { RenderSchema } from "./types.js";
import { fieldIssues, formatIssues, groupIssues, type Issue } from "./validate.js";

export const MAX_OPS = 200;

type Field = RenderSchema["fields"][number] & {
  label?: unknown;
  type?: unknown;
  format?: unknown;
  section_id?: unknown;
  xpct: number;
  ypct: number;
  wpct: number;
  hpct: number;
  cells?: { x: number; y: number; w: number; h: number }[];
};
type Group = RenderSchema["groups"][number] & {
  kind?: unknown;
  format?: unknown;
  label?: unknown;
  members?: unknown;
  grid?: unknown;
};

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The field types an op may set (agent types; multiline = text + multiline variant). */
export const EDIT_FIELD_TYPES = ["text", "multiline", "date", "checkbox", "signature"] as const;
export type EditFieldType = (typeof EDIT_FIELD_TYPES)[number];

export type Op =
  | { op: "move"; id: string; dx?: number; dy?: number; x?: number; y?: number }
  | { op: "resize"; id: string; w: number; h: number }
  | { op: "set_box"; id: string; x: number; y: number; w: number; h: number }
  | { op: "relabel"; id: string; label: string }
  | { op: "retype"; id: string; type: string }
  | {
      op: "add";
      page: number;
      type: EditFieldType;
      box: Box;
      label: string;
      section_id?: string;
      description?: string;
      placeholder?: string;
      required?: boolean;
    }
  | { op: "delete"; id: string }
  | { op: "set_format"; id: string; format: Record<string, unknown> }
  | { op: "group"; ids: string[]; kind: "choice" | "comb"; label: string; multiple?: boolean }
  | { op: "ungroup"; id: string }
  | { op: "set_options"; id: string; options: (string | { id: string; label: string })[] }
  | { op: "set_required"; id: string; required: boolean }
  | { op: "set_description"; id: string; description: string | null }
  | { op: "set_placeholder"; id: string; placeholder: string | null };

export interface Rejected {
  op_index: number;
  reason: string;
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
  };
  warnings: string[];
}

class OpError extends Error {}
const bad = (msg: string): never => {
  throw new OpError(msg);
};

const isRec = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

interface Doc {
  s: RenderSchema;
  field: Map<string, Field>;
  group: Map<string, Group>;
  /** member field id → its group */
  owner: Map<string, Group>;
}

function index(s: RenderSchema): Doc {
  const field = new Map<string, Field>();
  for (const f of s.fields as Field[]) if (f && typeof f.id === "string") field.set(f.id, f);
  const group = new Map<string, Group>();
  const owner = new Map<string, Group>();
  for (const g of s.groups as Group[]) {
    if (!g || typeof g.id !== "string") continue;
    group.set(g.id, g);
    if (Array.isArray(g.members)) {
      for (const m of g.members) if (typeof m === "string") owner.set(m, g);
    }
  }
  return { s, field, group, owner };
}

function members(d: Doc, g: Group): Field[] {
  const ids = Array.isArray(g.members) ? (g.members as unknown[]) : [];
  return ids.flatMap((m) => {
    const f = typeof m === "string" ? d.field.get(m) : undefined;
    return f ? [f] : [];
  });
}

/** Percent bbox of fields. */
function bbox(fs: readonly Field[]): { x: number; y: number; w: number; h: number } | null {
  if (!fs.length) return null;
  const x0 = Math.min(...fs.map((f) => f.xpct));
  const y0 = Math.min(...fs.map((f) => f.ypct));
  const x1 = Math.max(...fs.map((f) => f.xpct + f.wpct));
  const y1 = Math.max(...fs.map((f) => f.ypct + f.hpct));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Map every rect (field boxes and their comb cells) from bbox `a` to bbox `b`, in percent. */
function transform(fs: readonly Field[], a: Box, b: Box): void {
  const sx = a.w > 0 ? b.w / a.w : 1;
  const sy = a.h > 0 ? b.h / a.h : 1;
  const mx = (x: number) => b.x + (x - a.x) * sx;
  const my = (y: number) => b.y + (y - a.y) * sy;
  for (const f of fs) {
    const nx = mx(f.xpct);
    const ny = my(f.ypct);
    f.wpct = f.wpct * sx;
    f.hpct = f.hpct * sy;
    f.xpct = nx;
    f.ypct = ny;
    if (Array.isArray(f.cells)) {
      f.cells = f.cells.map((c) => ({ x: mx(c.x), y: my(c.y), w: c.w * sx, h: c.h * sy }));
    }
  }
}

function needId(d: Doc, id: unknown): { f?: Field; g?: Group } {
  if (typeof id !== "string" || !id) bad("id is required");
  const sid = id as string;
  const f = d.field.get(sid);
  if (f) return { f };
  const g = d.group.get(sid);
  if (g) return { g };
  return bad(`no field or group has id ${sid}`);
}

function checkFraction(v: unknown, name: string, min = 0, max = 1): number {
  if (!isNum(v)) bad(`${name} must be a number (a fraction of the page, 0–1)`);
  const n = v as number;
  if (n < min || n > max) {
    bad(`${name} must be between ${String(min)} and ${String(max)} (a fraction of the page)`);
  }
  return n;
}

const ON_PAGE = "the box must lie on the page (x + w ≤ 1, y + h ≤ 1, fractions of the page)";

function onPage(b: Box): boolean {
  const eps = 1e-6;
  return !(b.x < -eps || b.y < -eps || b.x + b.w > 1 + eps || b.y + b.h > 1 + eps);
}

function checkBoxOnPage(b: Box): void {
  if (b.w <= 0 || b.h <= 0) bad("the box must have a positive width and height");
  if (!onPage(b)) bad(ON_PAGE);
}

/** Move/scale an item's boxes to `nb` (percent). Page bounds are checked on the
 *  batch's final state (applyOps), not here. */
function placeBox(fs: readonly Field[], bb: Box, nb: Box): void {
  if (nb.w <= 0 || nb.h <= 0) bad("the box must have a positive width and height");
  transform(fs, bb, nb);
}

function pageOf(d: Doc, page: unknown): number {
  if (!Number.isInteger(page)) bad("page must be a 1-based page number");
  const p = page as number;
  if (!d.s.pages.some((x) => x && x.page === p)) {
    bad(
      `page ${String(p)} is not part of this form (pages: ${d.s.pages.map((x) => x.page).join(", ")})`,
    );
  }
  return p;
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

/** Remove `ids` from a group's members and grid; a group left empty goes too. */
function dropMembers(d: Doc, g: Group, ids: ReadonlySet<string>): boolean {
  if (Array.isArray(g.members))
    g.members = (g.members as unknown[]).filter((m) => !ids.has(m as string));
  if (Array.isArray(g.grid)) {
    g.grid = (g.grid as unknown[]).map((row) =>
      Array.isArray(row) ? row.map((c) => (typeof c === "string" && ids.has(c) ? null : c)) : row,
    );
  }
  if (Array.isArray(g.members) && g.members.length === 0) {
    d.s.groups = d.s.groups.filter((x) => x !== g);
    return true;
  }
  return false;
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

function applyOne(
  d: Doc,
  op: Op,
  warnings: string[],
): { touched: string[]; added?: string; deleted?: string[]; geometry?: string } {
  if (!isRec(op) || typeof op.op !== "string") return bad("each op needs an `op` name");
  switch (op.op) {
    case "move": {
      const { f, g } = needId(d, op.id);
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
      return { touched: [(g ?? f)!.id], geometry: (g ?? f)!.id };
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
      const fs = g ? members(d, g) : [f as Field];
      const bb = bbox(fs);
      if (!bb) return bad("this group has no member boxes to place");
      placeBox(fs, bb, {
        x: checkFraction(op.x, "x") * 100,
        y: checkFraction(op.y, "y") * 100,
        w: checkFraction(op.w, "w") * 100,
        h: checkFraction(op.h, "h") * 100,
      });
      return { touched: [(g ?? f)!.id], geometry: (g ?? f)!.id };
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
      if (!isRec(op.box))
        return bad("box {x, y, w, h} is required (fractions of the page, top-left origin)");
      const box: Box = {
        x: checkFraction(op.box.x, "box.x"),
        y: checkFraction(op.box.y, "box.y"),
        w: checkFraction(op.box.w, "box.w"),
        h: checkFraction(op.box.h, "box.h"),
      };
      checkBoxOnPage(box);
      if (typeof op.label !== "string")
        return bad("label is required (the form's caption for this blank)");
      let section: string | null;
      if (op.section_id !== undefined) {
        if (!sectionIds(d, page).has(op.section_id)) {
          return bad(
            `section_id ${String(op.section_id)} is not a section of page ${String(page)}`,
          );
        }
        section = op.section_id;
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
      return { touched: [id], added: id };
    }
    case "delete": {
      const { f, g } = needId(d, op.id);
      const gone = new Set<string>();
      if (g) {
        for (const m of members(d, g)) gone.add(m.id);
        d.s.groups = d.s.groups.filter((x) => x !== g);
        d.group.delete(g.id);
      } else gone.add((f as Field).id);
      // A deleted option/cell leaves its group; a group left empty goes too.
      for (const og of [...d.s.groups] as Group[]) {
        if (dropMembers(d, og, gone)) {
          d.group.delete(og.id);
          warnings.push(
            `deleting removed the last member of group ${og.id}, so the group was removed too`,
          );
        }
      }
      d.s.fields = d.s.fields.filter((x) => !gone.has(x.id));
      for (const id of gone) {
        d.field.delete(id);
        d.owner.delete(id);
      }
      return { touched: [], deleted: g ? [g.id] : [...gone] };
    }
    case "set_format": {
      const { f, g } = needId(d, op.id);
      if (!isRec(op.format)) return bad("format must be an object");
      if (g) {
        if (g.kind !== "comb")
          return bad("set_format applies to a field, or to a comb group (cell_type, date_format)");
        for (const [k, v] of Object.entries(op.format)) {
          if (k !== "cell_type" && k !== "date_format")
            bad(`a comb group's format keys are cell_type and date_format, not ${k}`);
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
        if (v === null) delete next[k];
        else next[k] = v;
      }
      const issues = formatIssues(fld.type, next, fld.id, "format");
      if (issues.length) return bad(issues.map((i) => `${i.path} ${i.reason}`).join("; "));
      if (Object.keys(next).length === 0 && (fld.type === "signature" || fld.type === "date"))
        delete fld.format;
      else fld.format = next;
      return { touched: [fld.id] };
    }
    case "group": {
      if (!Array.isArray(op.ids) || op.ids.length < 1)
        return bad("ids must list the fields to group");
      if (op.kind !== "choice" && op.kind !== "comb") return bad('kind must be "choice" or "comb"');
      if (typeof op.label !== "string") return bad("label is required (the question or caption)");
      const uniq = [...new Set(op.ids)];
      if (op.kind === "choice" && uniq.length < 2)
        return bad("a choice group needs at least 2 options");
      const fs = uniq.map((id) => {
        const f = d.field.get(id);
        if (!f) return bad(`${String(id)} is not a field id (group ids can't be nested)`);
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
      const g = d.group.get(op.id);
      if (!g) return bad(`${String(op.id)} is not a group id`);
      if (g.kind === "table")
        warnings.push(`ungrouped table ${g.id}: its cells are now separate fields`);
      for (const m of members(d, g)) {
        m.group = null;
        d.owner.delete(m.id);
      }
      d.s.groups = d.s.groups.filter((x) => x !== g);
      d.group.delete(g.id);
      return { touched: members(d, g).map((m) => m.id), deleted: [g.id] };
    }
    case "set_options": {
      const g = d.group.get(op.id);
      if (!g || g.kind !== "choice")
        return bad("set_options applies to a radio/multiselect group id");
      if (!Array.isArray(op.options) || op.options.length === 0)
        return bad("options must be a non-empty list");
      const opts = members(d, g);
      if (op.options.every((o) => typeof o === "string")) {
        if (op.options.length !== opts.length) {
          return bad(
            `this group has ${String(opts.length)} options; pass that many labels (in the order the options are listed), or [{id, label}] pairs. Add an option with add (a checkbox) + group, or remove one with delete.`,
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
          const f = opts.find((x) => x.id === o.id);
          if (!f) return bad(`${o.id} is not an option of this group`);
          f.label = o.label.trim();
        }
      }
      return { touched: [g.id] };
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
      const v = (op as Record<string, unknown>)[key];
      if (v !== null && typeof v !== "string")
        return bad(`${key} must be a string (or null to clear it)`);
      const item = (g ?? f)! as Record<string, unknown> & { id: string };
      if (v === null || !(v as string).trim()) delete item[key];
      else item[key] = (v as string).trim();
      return { touched: [item.id] };
    }
    default:
      return bad(
        `unknown op "${String((op as { op: unknown }).op)}"; ops: move, resize, set_box, relabel, retype, add, delete, set_format, group, ungroup, set_options, set_required, set_description, set_placeholder (table rows/columns can't be edited yet)`,
      );
  }
}

/** The validation issues of the items an op left behind (touched ids and their groups). */
function touchedIssues(d: Doc, ids: readonly string[]): Issue[] {
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
): ApplyResult {
  // Geometry ops whose item ends up off the page are excluded and the batch
  // replayed without them (each replay excludes at least one more op, so it ends).
  const excluded = new Map<number, string>();
  for (;;) {
    const pass = applyPass(render, ops, excluded, screen);
    if (!pass.offPage.size) return pass.result;
    for (const [i, reason] of pass.offPage) excluded.set(i, reason);
  }
}

function applyPass(
  render: RenderSchema,
  ops: readonly unknown[],
  excluded: ReadonlyMap<number, string>,
  screen?: WordingScreen,
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
      const r = applyOne(d, raw as Op, w);
      const issues = touchedIssues(d, r.touched);
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
      cur = draft;
      applied++;
      const name = (raw as Op).op;
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
      diff_summary: { counts, added, deleted, touched },
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

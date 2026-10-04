// Local validation of an edited render schema, mirroring the server's gate
// (schemas.py `validate_template`: Pydantic models with extra="forbid", the
// per-type format routing, the group kind/format pairing, the bounds) plus the
// referential checks the web app's write gate adds (group members and grid
// cells must name fields that exist) and the agent API's item cap. An edit the
// server would refuse is refused here first, with a reason, before anything is
// sent.

import type { RenderSchema } from "./types.js";

const MAX_ID = 200;
const MAX_LABEL = 2_000;
const MAX_TEXT = 5_000;
const MAX_TITLE = 2_000;
const MAX_IMAGE_URL = 4_096;
const MAX_DATE_FORMAT = 64;
const MAX_SYMBOL = 16;
const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 96;
const SIGNATURE_SCALE_MIN = 0.25;
const MAX_MEMBERS = 2_000;
/** The agent API's default cap on a saved template: fields + groups. */
export const MAX_ITEMS = 5_000;

export const FIELD_TYPES = ["text", "checkbox", "date", "signature"] as const;
const TEXT_VARIANTS = ["any", "number", "currency", "multiline"];
export const TEXT_ANCHORS = [
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "middle-center",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
];
const SHAPES = ["square", "round"];
const GROUP_KINDS = ["comb", "choice", "table"];
const CHOICE_FORMATS = ["single", "multiple"];
const TABLE_FORMATS = ["classic", "expandable", "checkbox_matrix"];

const FIELD_KEYS = new Set([
  "id",
  "label",
  "type",
  "format",
  "primitive",
  "page",
  "section_id",
  "xpct",
  "ypct",
  "wpct",
  "hpct",
  "cells",
  "group",
  "order",
  "description",
  "placeholder",
  "required",
  "autofill",
  "signing_requirement",
]);
const GROUP_KEYS = new Set([
  "id",
  "kind",
  "format",
  "label",
  "page",
  "members",
  "cell_type",
  "date_format",
  "orientation",
  "rows",
  "cols",
  "header_cols",
  "header_rows",
  "grid",
  "order",
  "description",
  "placeholder",
  "required",
]);
const SECTION_KEYS = new Set(["id", "title", "description", "placeholder", "required"]);
const TOP_KEYS = new Set(["version", "pages", "fields", "groups"]);
const FORMAT_KEYS: Record<string, Set<string>> = {
  text: new Set(["variant", "font_size", "text_anchor", "uppercase"]),
  checkbox: new Set(["shape", "symbol", "font_size"]),
  date: new Set(["date_format", "font_size", "text_anchor"]),
  signature: new Set(["scale", "text_anchor"]),
};

export interface Issue {
  /** The field/group/section id, when the problem is in one. */
  id?: string;
  path: string;
  reason: string;
}

const isRec = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isInt = (x: unknown): x is number => isNum(x) && Number.isInteger(x);

function checkStr(
  out: Issue[],
  v: unknown,
  max: number,
  at: { id?: string; path: string },
  optional: boolean,
): void {
  if (v === undefined || (optional && v === null)) {
    if (!optional) out.push({ ...at, reason: "is required" });
    return;
  }
  if (typeof v !== "string") out.push({ ...at, reason: "must be a string" });
  else if (v.length > max) out.push({ ...at, reason: `is longer than ${String(max)} characters` });
}

function checkCoord(out: Issue[], v: unknown, at: { id?: string; path: string }): void {
  if (!isNum(v)) out.push({ ...at, reason: "must be a finite number" });
  else if (v < -10_000 || v > 10_000) out.push({ ...at, reason: "is out of range" });
}

function checkFontSize(out: Issue[], v: unknown, at: { id?: string; path: string }): void {
  if (v === undefined || v === null) return;
  if (!isNum(v) || v < MIN_FONT_SIZE || v > MAX_FONT_SIZE) {
    out.push({
      ...at,
      reason: `font_size must be ${String(MIN_FONT_SIZE)}–${String(MAX_FONT_SIZE)} pt`,
    });
  }
}

function checkAnchor(out: Issue[], v: unknown, at: { id?: string; path: string }): void {
  if (v === undefined || v === null) return;
  if (typeof v !== "string" || !TEXT_ANCHORS.includes(v)) {
    out.push({ ...at, reason: `text_anchor must be one of ${TEXT_ANCHORS.join(", ")}` });
  }
}

/** A field's `format` against its `type` (schemas.py _route_format_by_type). */
export function formatIssues(type: unknown, fmt: unknown, id: string, path: string): Issue[] {
  const out: Issue[] = [];
  if (fmt === undefined || fmt === null) return out;
  if (!isRec(fmt)) return [{ id, path, reason: "format must be an object" }];
  const allowed = typeof type === "string" ? FORMAT_KEYS[type] : undefined;
  if (!allowed) return out; // an unknown type fails on its own
  for (const k of Object.keys(fmt)) {
    if (!allowed.has(k)) {
      out.push({ id, path: `${path}.${k}`, reason: `is not a ${String(type)} format key` });
    }
  }
  const at = (k: string) => ({ id, path: `${path}.${k}` });
  if (type === "text") {
    if (fmt.variant !== undefined && !TEXT_VARIANTS.includes(fmt.variant as string)) {
      out.push({ ...at("variant"), reason: `must be one of ${TEXT_VARIANTS.join(", ")}` });
    }
    checkFontSize(out, fmt.font_size, at("font_size"));
    checkAnchor(out, fmt.text_anchor, at("text_anchor"));
    if (fmt.uppercase !== undefined && fmt.uppercase !== null && typeof fmt.uppercase !== "boolean")
      out.push({ ...at("uppercase"), reason: "must be true or false" });
  } else if (type === "checkbox") {
    if (fmt.shape !== undefined && !SHAPES.includes(fmt.shape as string)) {
      out.push({ ...at("shape"), reason: "must be square or round" });
    }
    if (fmt.symbol !== undefined) checkStr(out, fmt.symbol, MAX_SYMBOL, at("symbol"), false);
    checkFontSize(out, fmt.font_size, at("font_size"));
  } else if (type === "date") {
    checkStr(out, fmt.date_format, MAX_DATE_FORMAT, at("date_format"), false);
    checkFontSize(out, fmt.font_size, at("font_size"));
    checkAnchor(out, fmt.text_anchor, at("text_anchor"));
  } else if (type === "signature") {
    const s = fmt.scale;
    if (s !== undefined && s !== null && (!isNum(s) || s < SIGNATURE_SCALE_MIN || s > 1)) {
      out.push({ ...at("scale"), reason: `must be ${String(SIGNATURE_SCALE_MIN)}–1` });
    }
    checkAnchor(out, fmt.text_anchor, at("text_anchor"));
  }
  return out;
}

export function fieldIssues(f: unknown, path: string): Issue[] {
  if (!isRec(f)) return [{ path, reason: "must be an object" }];
  const id = typeof f.id === "string" ? f.id : undefined;
  const out: Issue[] = [];
  const at = (k: string) => ({ id, path: `${path}.${k}` });
  for (const k of Object.keys(f)) {
    if (!FIELD_KEYS.has(k)) out.push({ ...at(k), reason: "is not a field key" });
  }
  checkStr(out, f.id, MAX_ID, at("id"), false);
  checkStr(out, f.label, MAX_LABEL, at("label"), false);
  if (!FIELD_TYPES.includes(f.type as (typeof FIELD_TYPES)[number])) {
    out.push({ ...at("type"), reason: `must be one of ${FIELD_TYPES.join(", ")}` });
  }
  out.push(...formatIssues(f.type, f.format, id ?? "", `${path}.format`));
  if (f.primitive !== undefined && f.primitive !== null)
    checkStr(out, f.primitive, 64, at("primitive"), false);
  if (!isInt(f.page)) out.push({ ...at("page"), reason: "must be an integer" });
  checkStr(out, f.section_id, MAX_ID, at("section_id"), true);
  for (const k of ["xpct", "ypct", "wpct", "hpct"]) checkCoord(out, f[k], at(k));
  if (f.cells !== undefined && f.cells !== null) {
    if (!Array.isArray(f.cells)) out.push({ ...at("cells"), reason: "must be a list" });
    else {
      f.cells.forEach((c: unknown, i: number) => {
        const cp = { id, path: `${path}.cells.${String(i)}` };
        if (!isRec(c)) {
          out.push({ ...cp, reason: "must be an object" });
          return;
        }
        for (const k of Object.keys(c)) {
          if (!["x", "y", "w", "h"].includes(k))
            out.push({ id, path: `${cp.path}.${k}`, reason: "is not a cell key" });
        }
        for (const k of ["x", "y", "w", "h"]) {
          checkCoord(out, c[k], { id, path: `${cp.path}.${k}` });
        }
      });
    }
  }
  checkStr(out, f.group, MAX_ID, at("group"), true);
  if (f.order !== undefined && f.order !== null && !isInt(f.order))
    out.push({ ...at("order"), reason: "must be an integer" });
  checkStr(out, f.description, MAX_TEXT, at("description"), true);
  checkStr(out, f.placeholder, MAX_TEXT, at("placeholder"), true);
  if (f.required !== undefined && f.required !== null && typeof f.required !== "boolean")
    out.push({ ...at("required"), reason: "must be true or false" });
  checkStr(out, f.autofill, 64, at("autofill"), true);
  checkStr(out, f.signing_requirement, 32, at("signing_requirement"), true);
  return out;
}

export function groupIssues(g: unknown, path: string): Issue[] {
  if (!isRec(g)) return [{ path, reason: "must be an object" }];
  const id = typeof g.id === "string" ? g.id : undefined;
  const out: Issue[] = [];
  const at = (k: string) => ({ id, path: `${path}.${k}` });
  for (const k of Object.keys(g)) {
    if (!GROUP_KEYS.has(k)) out.push({ ...at(k), reason: "is not a group key" });
  }
  checkStr(out, g.id, MAX_ID, at("id"), false);
  checkStr(out, g.label, MAX_LABEL, at("label"), false);
  if (!GROUP_KINDS.includes(g.kind as string)) {
    out.push({ ...at("kind"), reason: `must be one of ${GROUP_KINDS.join(", ")}` });
  } else if (g.format !== undefined && g.format !== null && g.kind !== "comb") {
    const ok = g.kind === "choice" ? CHOICE_FORMATS : TABLE_FORMATS;
    if (!ok.includes(g.format as string)) {
      out.push({ ...at("format"), reason: `must be one of ${ok.join(", ")}` });
    }
  }
  if (!isInt(g.page)) out.push({ ...at("page"), reason: "must be an integer" });
  if (!Array.isArray(g.members)) out.push({ ...at("members"), reason: "must be a list" });
  else {
    if (g.members.length > MAX_MEMBERS) out.push({ ...at("members"), reason: "has too many ids" });
    g.members.forEach((m: unknown, i: number) =>
      checkStr(out, m, MAX_ID, { id, path: `${path}.members.${String(i)}` }, false),
    );
  }
  if (g.cell_type !== undefined && g.cell_type !== null) {
    if (!["integer", "char", "date"].includes(g.cell_type as string))
      out.push({ ...at("cell_type"), reason: "must be integer, char or date" });
  }
  checkStr(out, g.date_format, MAX_DATE_FORMAT, at("date_format"), true);
  if (g.orientation !== undefined && g.orientation !== null) {
    if (g.orientation !== "col" && g.orientation !== "row")
      out.push({ ...at("orientation"), reason: "must be col or row" });
  }
  for (const k of ["rows", "cols", "order"]) {
    if (g[k] !== undefined && g[k] !== null && !isInt(g[k]))
      out.push({ ...at(k), reason: "must be an integer" });
  }
  for (const k of ["header_cols", "header_rows"]) {
    const v = g[k];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
      out.push({ ...at(k), reason: "must be a list of strings" });
  }
  if (g.grid !== undefined && g.grid !== null) {
    if (
      !Array.isArray(g.grid) ||
      g.grid.some(
        (r: unknown) => !Array.isArray(r) || r.some((c) => c !== null && typeof c !== "string"),
      )
    ) {
      out.push({ ...at("grid"), reason: "must be a list of rows of ids (or null)" });
    }
  }
  checkStr(out, g.description, MAX_TEXT, at("description"), true);
  checkStr(out, g.placeholder, MAX_TEXT, at("placeholder"), true);
  if (g.required !== undefined && g.required !== null && typeof g.required !== "boolean")
    out.push({ ...at("required"), reason: "must be true or false" });
  return out;
}

function sectionIssues(s: unknown, path: string): Issue[] {
  if (!isRec(s)) return [{ path, reason: "must be an object" }];
  const id = typeof s.id === "string" ? s.id : undefined;
  const out: Issue[] = [];
  const at = (k: string) => ({ id, path: `${path}.${k}` });
  for (const k of Object.keys(s)) {
    if (!SECTION_KEYS.has(k)) out.push({ ...at(k), reason: "is not a section key" });
  }
  checkStr(out, s.id, MAX_ID, at("id"), false);
  checkStr(out, s.title, MAX_TITLE, at("title"), false);
  checkStr(out, s.description, MAX_TEXT, at("description"), true);
  checkStr(out, s.placeholder, MAX_TEXT, at("placeholder"), true);
  return out;
}

/** Every reason the server's validate_template would refuse this schema (≤ `limit`). */
export function schemaIssues(schema: RenderSchema, limit = 50): Issue[] {
  const out: Issue[] = [];
  const s = schema as unknown as Record<string, unknown>;
  for (const k of Object.keys(s)) {
    if (!TOP_KEYS.has(k)) out.push({ path: k, reason: "is not a template key" });
  }
  if (s.version !== undefined && s.version !== 5)
    out.push({ path: "version", reason: "must be 5" });
  const pages = Array.isArray(s.pages) ? (s.pages as unknown[]) : [];
  if (!Array.isArray(s.pages)) out.push({ path: "pages", reason: "must be a list" });
  pages.forEach((p, i) => {
    const path = `pages.${String(i)}`;
    if (!isRec(p)) {
      out.push({ path, reason: "must be an object" });
      return;
    }
    for (const k of ["page", "width", "height"]) {
      if (!isInt(p[k])) out.push({ path: `${path}.${k}`, reason: "must be an integer" });
    }
    checkStr(out, p.image, MAX_IMAGE_URL, { path: `${path}.image` }, false);
    if (p.sections !== undefined) {
      if (!Array.isArray(p.sections))
        out.push({ path: `${path}.sections`, reason: "must be a list" });
      else
        p.sections.forEach((sec: unknown, j: number) =>
          out.push(...sectionIssues(sec, `${path}.sections.${String(j)}`)),
        );
    }
  });
  const fields = Array.isArray(s.fields) ? (s.fields as unknown[]) : [];
  const groups = Array.isArray(s.groups) ? (s.groups as unknown[]) : [];
  if (!Array.isArray(s.fields)) out.push({ path: "fields", reason: "must be a list" });
  if (!Array.isArray(s.groups)) out.push({ path: "groups", reason: "must be a list" });
  if (fields.length + groups.length > MAX_ITEMS) {
    out.push({ path: "fields", reason: `more than ${String(MAX_ITEMS)} fields and groups` });
  }
  fields.forEach((f, i) => out.push(...fieldIssues(f, `fields.${String(i)}`)));
  groups.forEach((g, i) => out.push(...groupIssues(g, `groups.${String(i)}`)));
  out.push(...referenceIssues(schema));
  return out.slice(0, limit);
}

/** Group members / grid cells naming fields that don't exist; duplicate ids. */
export function referenceIssues(schema: RenderSchema): Issue[] {
  const out: Issue[] = [];
  const ids = new Set<string>();
  schema.fields.forEach((f, i) => {
    if (ids.has(f.id))
      out.push({ id: f.id, path: `fields.${String(i)}.id`, reason: "is a duplicate id" });
    ids.add(f.id);
  });
  const gids = new Set<string>();
  schema.groups.forEach((g, gi) => {
    if (gids.has(g.id) || ids.has(g.id))
      out.push({ id: g.id, path: `groups.${String(gi)}.id`, reason: "is a duplicate id" });
    gids.add(g.id);
    const members = Array.isArray(g.members) ? (g.members as unknown[]) : [];
    members.forEach((m, mi) => {
      if (typeof m === "string" && !ids.has(m)) {
        out.push({
          id: g.id,
          path: `groups.${String(gi)}.members.${String(mi)}`,
          reason: `names a field that doesn't exist (${m})`,
        });
      }
    });
    const grid: unknown = g.grid;
    if (Array.isArray(grid)) {
      grid.forEach((row: unknown, ri: number) => {
        if (!Array.isArray(row)) return;
        row.forEach((c: unknown, ci: number) => {
          if (typeof c === "string" && !ids.has(c)) {
            out.push({
              id: g.id,
              path: `groups.${String(gi)}.grid.${String(ri)}.${String(ci)}`,
              reason: `names a field that doesn't exist (${c})`,
            });
          }
        });
      });
    }
  });
  return out;
}

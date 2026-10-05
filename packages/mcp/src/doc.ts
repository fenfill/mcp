// The working document edit ops act on: an indexed render schema plus the
// small helpers every op shares (id resolution, boxes, page checks). Pure: no
// network, no fill values. Boxes here are PERCENT of the page (the render
// schema's unit, top-left origin) unless a name says fraction.

import type { RenderSchema } from "./types.js";

export type Field = RenderSchema["fields"][number] & {
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
export type Group = RenderSchema["groups"][number] & {
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

export class OpError extends Error {}
export const bad = (msg: string): never => {
  throw new OpError(msg);
};

export const isRec = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
export const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
export const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

export interface Doc {
  s: RenderSchema;
  field: Map<string, Field>;
  group: Map<string, Group>;
  /** member field id → its group */
  owner: Map<string, Group>;
  /** section id → its page */
  section: Map<string, number>;
}

export function index(s: RenderSchema): Doc {
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
  const section = new Map<string, number>();
  for (const p of s.pages as { page?: unknown; sections?: unknown }[]) {
    if (!Array.isArray(p?.sections) || typeof p.page !== "number") continue;
    for (const sec of p.sections as { id?: unknown }[]) {
      if (typeof sec?.id === "string") section.set(sec.id, p.page);
    }
  }
  return { s, field, group, owner, section };
}

/** The shortest id prefix an op accepts: the length check-copy tags show (shortIds). */
export const MIN_ID_PREFIX = 6;

export type IdKind = "field" | "group" | "section";

/**
 * An id, or an unambiguous prefix of at least MIN_ID_PREFIX characters, among
 * the ids of `kinds`. An exact id always wins; an ambiguous prefix is refused
 * with the candidates listed.
 */
export function resolveId(
  d: Doc,
  raw: unknown,
  kinds: readonly IdKind[] = ["field", "group"],
  name = "id",
): string {
  if (typeof raw !== "string" || !raw) return bad(`${name} is required`);
  const pools: Map<string, unknown>[] = kinds.map((k) =>
    k === "field" ? d.field : k === "group" ? d.group : d.section,
  );
  if (pools.some((p) => p.has(raw))) return raw;
  const what =
    kinds.length === 1 ? `${kinds[0]}` : `${kinds.slice(0, -1).join(", ")} or ${kinds.at(-1)!}`;
  if (raw.length < MIN_ID_PREFIX) {
    return bad(
      `no ${what} has id ${raw} (a shortened id needs at least ${String(MIN_ID_PREFIX)} characters)`,
    );
  }
  const hits = new Set<string>();
  for (const p of pools) for (const id of p.keys()) if (id.startsWith(raw)) hits.add(id);
  if (hits.size === 1) return [...hits][0];
  if (hits.size === 0) return bad(`no ${what} has id ${raw}`);
  const list = [...hits].sort();
  return bad(
    `${name} ${raw} is ambiguous: it starts ${String(list.length)} ids (${list.slice(0, 8).join(", ")}${list.length > 8 ? ", …" : ""}); use more characters`,
  );
}

/** A field or group by id (or prefix). */
export function needId(d: Doc, id: unknown, name = "id"): { f?: Field; g?: Group } {
  const sid = resolveId(d, id, ["field", "group"], name);
  const f = d.field.get(sid);
  if (f) return { f };
  return { g: d.group.get(sid) };
}

export function needField(d: Doc, id: unknown, name = "id"): Field {
  const sid = resolveId(d, id, ["field", "group"], name);
  const f = d.field.get(sid);
  if (!f) return bad(`${name} ${sid} is a group, not a field`);
  return f;
}

export function needGroup(d: Doc, id: unknown, name = "id"): Group {
  const sid = resolveId(d, id, ["field", "group"], name);
  const g = d.group.get(sid);
  if (!g) return bad(`${name} ${sid} is a field, not a group`);
  return g;
}

export function members(d: Doc, g: Group): Field[] {
  const ids = Array.isArray(g.members) ? (g.members as unknown[]) : [];
  return ids.flatMap((m) => {
    const f = typeof m === "string" ? d.field.get(m) : undefined;
    return f ? [f] : [];
  });
}

/** Percent bbox of fields. */
export function bbox(fs: readonly Field[]): Box | null {
  if (!fs.length) return null;
  const x0 = Math.min(...fs.map((f) => f.xpct));
  const y0 = Math.min(...fs.map((f) => f.ypct));
  const x1 = Math.max(...fs.map((f) => f.xpct + f.wpct));
  const y1 = Math.max(...fs.map((f) => f.ypct + f.hpct));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Map every rect (field boxes and their comb cells) from bbox `a` to bbox `b`, in percent. */
export function transform(fs: readonly Field[], a: Box, b: Box): void {
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

export function checkFraction(v: unknown, name: string, min = 0, max = 1): number {
  if (!isNum(v)) bad(`${name} must be a number (a fraction of the page, 0–1)`);
  const n = v as number;
  if (n < min || n > max) {
    bad(`${name} must be between ${String(min)} and ${String(max)} (a fraction of the page)`);
  }
  return n;
}

export const ON_PAGE = "the box must lie on the page (x + w ≤ 1, y + h ≤ 1, fractions of the page)";

/** `b` in fractions. */
export function onPage(b: Box): boolean {
  const eps = 1e-6;
  return !(b.x < -eps || b.y < -eps || b.x + b.w > 1 + eps || b.y + b.h > 1 + eps);
}

export function checkBoxOnPage(b: Box): void {
  if (b.w <= 0 || b.h <= 0) bad("the box must have a positive width and height");
  if (!onPage(b)) bad(ON_PAGE);
}

/** A {x, y, w, h} fraction box from an op argument, checked on the page. */
export function boxArg(v: unknown, name = "box"): Box {
  if (!isRec(v)) return bad(`${name} {x, y, w, h} is required (fractions of the page, top-left)`);
  const b: Box = {
    x: checkFraction(v.x, `${name}.x`),
    y: checkFraction(v.y, `${name}.y`),
    w: checkFraction(v.w, `${name}.w`),
    h: checkFraction(v.h, `${name}.h`),
  };
  checkBoxOnPage(b);
  return b;
}

export function pageOf(d: Doc, page: unknown): number {
  if (!Number.isInteger(page)) bad("page must be a 1-based page number");
  const p = page as number;
  if (!d.s.pages.some((x) => x && x.page === p)) {
    bad(
      `page ${String(p)} is not part of this form (pages: ${d.s.pages.map((x) => x.page).join(", ")})`,
    );
  }
  return p;
}

/** Remove `ids` from a group's members and grid; a group left empty goes too. */
export function dropMembers(d: Doc, g: Group, ids: ReadonlySet<string>): boolean {
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

/** Add a new standalone-shaped field to the doc. */
export function pushField(d: Doc, f: Field): void {
  d.s.fields.push(f);
  d.field.set(f.id, f);
}

/** Delete fields (and their membership) from the doc. */
export function removeFields(d: Doc, ids: ReadonlySet<string>): void {
  d.s.fields = d.s.fields.filter((x) => !ids.has(x.id));
  for (const id of ids) {
    d.field.delete(id);
    d.owner.delete(id);
  }
}

export function removeGroup(d: Doc, g: Group): void {
  d.s.groups = d.s.groups.filter((x) => x !== g);
  d.group.delete(g.id);
}

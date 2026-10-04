// Forward-normalize a stored template schema to the current v5 taxonomy.
//
// The same forward map that scripts/migrate_schema_v{3->4,4->5}.py apply to the
// database is applied here at load time, so a template stored under an older
// schema renders without first being migrated. It MUST be:
//  - idempotent: normalize(v5) deep-equals v5 (no churn for current templates);
//  - total/defensive: never throw on partial or unexpected data (drop/skip the
//    bad bit instead — see the defensive-coding guardrails).
//
// v3 -> v4 changes handled:
//  - field text+primitive:"date"  -> type:"date"
//  - field text+primitive:"number"-> format:{variant:"number"}
//  - field checkbox               -> format:{shape:"square",symbol:"✗"} (default)
//  - field type:"note"            -> dropped (floating notes are deprecated)
//  - schema.notes (any)           -> dropped (deprecated; never re-emitted)
//  - group classic_table          -> kind:"table",  format:"classic"
//  - group expandable_table       -> kind:"table",  format:"expandable"
//  - group single_choice          -> kind:"choice", format:"single"
//  - group multiple_choice        -> kind:"choice", format:"multiple"
//
// v4 -> v5 changes handled (table groups only):
//  - default orientation:"col" (the legacy/effective default — columns drove types)
//  - backfill header_cols/header_rows to length cols/rows (the label axis needs
//    its labels generally, not just on classic tables)
//  - Single-Axis Data Type: collapse every driving-axis LINE to one type+format
//    (first non-default cell wins) so no line carries conflicting cell types.
//    checkbox_matrix is exempt (it is always all-checkbox).

import {
  type Cell,
  type CheckboxFormat,
  DEFAULT_CHECKBOX_SYMBOL,
  type Field,
  type Group,
  type PageInfo,
  SCHEMA_VERSION,
  type SigningRequirement,
  type TemplateSchema,
} from "@/types";

// Loose shapes for legacy data we read defensively (fields/groups predate the
// narrowed v4 unions, so we cannot assume the current types on input). These
// are intentionally standalone (not Partial<Field>) so `type`/`kind` stay plain
// strings and can be compared against retired values like "note"/"classic_table".
type RawField = {
  id?: string;
  label?: string;
  text?: string;
  type?: string;
  primitive?: string;
  format?: unknown;
  page?: number;
  section_id?: string | null;
  xpct?: number;
  ypct?: number;
  wpct?: number;
  hpct?: number;
  cells?: Cell[];
  group?: string | null;
  order?: number;
  signing_requirement?: string;
};

// Fold the signature `signing_requirement` axis into the current vocabulary:
// legacy "wet"/"certified" -> "external"; keep "appearance"/"external"; anything
// else (including undefined) -> undefined (the silent "appearance" default).
function normalizeSigningRequirement(req: string | undefined): SigningRequirement | undefined {
  if (req === "wet" || req === "certified" || req === "external") return "external";
  if (req === "appearance") return "appearance";
  return undefined;
}
type RawGroup = Omit<Partial<Group>, "kind" | "format"> & {
  kind?: string;
  format?: string;
};
type RawSchema = {
  version?: number;
  pages?: PageInfo[];
  // Persisted JSON is untrusted: array entries may be null/malformed, so the
  // element types stay honestly nullable and the guards below are load-bearing.
  fields?: (RawField | null)[];
  groups?: (RawGroup | null)[];
  // Deprecated floating notes; read defensively and discarded.
  notes?: unknown;
};

function normalizeField(f: RawField | null): Field | null {
  if (!f || typeof f.id !== "string") return null;
  const out = { ...f } as Field & { primitive?: string };

  if (f.type === "text" && f.primitive === "date") {
    out.type = "date";
    out.format = undefined;
    out.primitive = undefined;
  } else if (f.type === "text" && f.primitive === "number" && !f.format) {
    out.type = "text";
    out.format = { variant: "number" };
  } else if (f.type === "checkbox") {
    out.type = "checkbox";
    const cf = (f.format ?? {}) as Partial<CheckboxFormat>;
    out.format = {
      shape: cf.shape === "round" ? "round" : "square",
      symbol: typeof cf.symbol === "string" && cf.symbol ? cf.symbol : DEFAULT_CHECKBOX_SYMBOL,
      // Preserve an author-set mark size (additive/optional); omit when unset so
      // the reconstructed format stays byte-identical for unsized checkboxes.
      ...(typeof cf.font_size === "number" ? { font_size: cf.font_size } : {}),
    };
  } else if (f.type === "text" || f.type === "date" || f.type === "signature") {
    out.type = f.type;
  } else {
    // Unknown/legacy field type that isn't a note (handled by caller): coerce
    // to a plain text field rather than dropping the box.
    out.type = "text";
  }

  // signing_requirement (signature fields only): fold the legacy "wet"/"certified"
  // vocabulary into the single "external" value; keep "appearance"/"external";
  // drop anything else to undefined (silent "appearance" default). Idempotent.
  out.signing_requirement = normalizeSigningRequirement(f.signing_requirement);
  if (out.signing_requirement === undefined) delete out.signing_requirement;

  delete (out as { primitive?: unknown }).primitive;
  return out;
}

const GROUP_KIND_MAP: Record<string, { kind: Group["kind"]; format?: Group["format"] }> = {
  classic_table: { kind: "table", format: "classic" },
  expandable_table: { kind: "table", format: "expandable" },
  single_choice: { kind: "choice", format: "single" },
  multiple_choice: { kind: "choice", format: "multiple" },
};

function normalizeGroup(g: RawGroup | null): Group | null {
  if (!g || typeof g.id !== "string") return null;
  const mapped = g.kind ? GROUP_KIND_MAP[g.kind] : undefined;
  if (mapped) {
    return withTableDefaults({
      ...g,
      kind: mapped.kind,
      format: g.format ?? mapped.format,
    } as Group);
  }
  // Already-v4 kinds (comb/choice/table) pass through with defaults filled in.
  if (g.kind === "table")
    return withTableDefaults({ ...g, format: g.format ?? "classic" } as Group);
  if (g.kind === "choice" && !g.format) return { ...g, format: "single" } as Group;
  return g as Group;
}

// Pad/trim a header array to exactly `len`, keeping existing labels and filling
// the rest with empty strings. Returns the same array reference when it already
// matches (so the idempotent path produces no churn).
function fitHeaders(header: string[] | undefined, len: number): string[] {
  const src = Array.isArray(header) ? header : [];
  if (src.length === len && src.every((s) => typeof s === "string")) return src;
  return Array.from({ length: len }, (_, i) => (typeof src[i] === "string" ? src[i] : ""));
}

// Apply the v4 -> v5 table defaults (orientation + header backfill). Geometry is
// untouched (the grid stays authoritative); the single-axis type collapse needs
// the field objects, so it runs as a separate pass in normalizeSchema.
function withTableDefaults(g: Group): Group {
  if (g.kind !== "table") return g;
  // Rows come from untrusted JSON, so a row may be missing/null at runtime (the
  // Group type is optimistic); keep them honestly nullable so `grid[0]?.length`
  // stays a real `number | undefined` and the header-length fallback survives.
  const grid: ((string | null)[] | null)[] = Array.isArray(g.grid) ? g.grid : [];
  const cols =
    g.cols ?? grid[0]?.length ?? (Array.isArray(g.header_cols) ? g.header_cols.length : 0);
  // grid.length is always a number, so a further `?? header_rows.length` was dead.
  const rows = g.rows ?? grid.length;
  const orientation = g.orientation === "row" ? "row" : "col";
  const header_cols = fitHeaders(g.header_cols, cols);
  const header_rows = fitHeaders(g.header_rows, rows);
  // Preserve referential identity where nothing changed (idempotency / no churn).
  if (
    g.orientation === orientation &&
    g.rows === rows &&
    g.cols === cols &&
    g.header_cols === header_cols &&
    g.header_rows === header_rows
  ) {
    return g;
  }
  // Backfill rows/cols too — legacy templates persisted only `grid`, leaving the
  // group's own rows/cols undefined so the card header rendered "0×0".
  return { ...g, orientation, rows, cols, header_cols, header_rows };
}

// A cell that carries no meaningful type (plain text, "any" variant) — these
// lose to any typed cell when collapsing a driving-axis line.
function isDefaultText(f: Field): boolean {
  return (
    f.type === "text" &&
    ((f.format as { variant?: string } | undefined)?.variant ?? "any") === "any"
  );
}

// Single-Axis Data Type collapse: every line along the table's driving axis is
// forced to one type+format (the first non-default cell wins; all-default lines
// stay text/any). Mutates the member field objects in place — they are fresh
// copies produced by normalizeField, never the caller's. checkbox_matrix is
// exempt (group enforcement already makes every cell a checkbox).
function collapseDrivingAxis(g: Group, byId: Map<string, Field>): void {
  if (g.kind !== "table" || (g.format ?? "classic") === "checkbox_matrix") return;
  // Untrusted JSON: a grid row may be missing/null at runtime even though the
  // Group type says otherwise, so keep the rows honestly nullable — the `?.`/`??`
  // guards below defend real cases the optimistic type would hide.
  const grid: ((string | null)[] | null)[] | undefined = g.grid;
  if (!Array.isArray(grid)) return;
  const axis = g.orientation === "row" ? "row" : "col";
  const lineCount = axis === "col" ? (g.cols ?? grid[0]?.length ?? 0) : (g.rows ?? grid.length);
  for (let i = 0; i < lineCount; i++) {
    const ids =
      axis === "col"
        ? grid.map((row) => row?.[i]).filter((id): id is string => !!id)
        : (grid[i] ?? []).filter((id): id is string => !!id);
    const cells = ids.map((id) => byId.get(id)).filter((f): f is Field => !!f);
    if (cells.length === 0) continue;
    const winner = cells.find((c) => !isDefaultText(c)) ?? cells[0];
    for (const c of cells) {
      c.type = winner.type;
      // Clone the format per cell so members never share a mutable object.
      c.format = winner.format ? { ...winner.format } : undefined;
    }
  }
}

// Normalize any stored schema into a current-version TemplateSchema. Always
// returns version === SCHEMA_VERSION with fields/groups present. Any deprecated
// floating notes (top-level `notes` or legacy `type:"note"` fields) are dropped.
export function normalizeSchema(raw: RawSchema | null | undefined): TemplateSchema {
  const pages = raw?.pages ?? [];
  const rawFields = Array.isArray(raw?.fields) ? raw.fields : [];
  const rawGroups = Array.isArray(raw?.groups) ? raw.groups : [];

  const fields: Field[] = [];
  for (const f of rawFields) {
    if (f?.type === "note") continue; // deprecated floating note — discard
    const nf = normalizeField(f);
    if (nf) fields.push(nf);
  }

  const groups: Group[] = [];
  for (const g of rawGroups) {
    const ng = normalizeGroup(g);
    if (ng) groups.push(ng);
  }

  // v4 -> v5 Single-Axis collapse: needs the field objects, so it runs after both
  // are normalized. Mutates field copies in `fields` via the shared id index.
  const byId = new Map(fields.map((f) => [f.id, f] as const));
  for (const g of groups) collapseDrivingAxis(g, byId);

  return {
    version: SCHEMA_VERSION,
    pages,
    fields,
    groups,
  };
}

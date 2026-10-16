// The agent schema of a render schema, computed here: get_template lists a
// local working copy (edit_template) this way, so new option ids, deleted rows,
// sections and order show before anything is saved.
//
// A port of agent_schema.py's `_project` (what /v1 returns), limited to what
// get_template's compact view lists: no `box` and no fill-key parity. It is
// held to the server's output by a test over the four agent-schema fixtures.
// Entry ids, types, options, cells and columns come from agentEntries (the
// stamping core's own projection); order and sections from buildPageItems, the
// editor's page layout, which the Python ports.

import {
  agentEntries,
  buildFieldById,
  normalizeSchema,
  resolveMembers,
} from "@/app/t/[template_id]/fillCore";
import { buildPageItems } from "@/app/t/[template_id]/pageLayout";
import { dateFormatOf, type Field, type Group } from "@/types";

import type { AgentEntry, AgentSchema } from "./types.js";

type Core = ReturnType<typeof agentEntries>[number];

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const optStr = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** agent_schema.py `_typing`: a date's printed format, a number/currency text's variant. */
function typing(f: Field, type: string): Record<string, unknown> {
  if (type === "date") return { date_format: dateFormatOf(f) };
  const variant = (f.format as { variant?: unknown } | undefined)?.variant;
  if (type === "text" && (variant === "number" || variant === "currency")) return { variant };
  return {};
}

function entryOf(e: Core, page: number, section: AgentEntry["section"]): AgentEntry {
  const item = e.kind === "field" ? e.field : e.group;
  const base: AgentEntry = {
    id: e.id,
    type: e.type,
    label: str(item.label),
    page,
    section,
    required: item.required === true,
    description: optStr(item.description),
    placeholder: optStr(item.placeholder),
    autofill: e.kind === "field" ? optStr(e.field.autofill) : null,
  };
  switch (e.kind) {
    case "field": {
      const f = e.field;
      if (e.type === "comb") base.max_length = Array.isArray(f.cells) ? f.cells.length : 0;
      Object.assign(base, typing(f, e.type));
      if (e.type === "signature") base.signing_requirement = f.signing_requirement ?? "appearance";
      return base;
    }
    case "choice":
      base.options = e.options.map((o) => ({ id: o.id, label: str(o.label) }));
      return base;
    case "comb":
      base.max_length = e.maxLength;
      base.cell_type = e.cellType;
      base.date_format = e.cellType === "date" ? optStr(e.group.date_format) : null;
      return base;
    case "table_rows":
      base.columns = e.columns.map((c) => ({
        id: c.id,
        label: c.label,
        type: c.type,
        ...typing(c.field, c.type),
      }));
      base.max_rows = e.maxRows;
      return base;
    case "table": {
      const g = e.group as Group & { header_cols?: unknown; header_rows?: unknown };
      const heads = (v: unknown) => (Array.isArray(v) ? v.map((h) => str(h)) : []);
      base.orientation = g.orientation === "row" ? "row" : "col";
      base.header_cols = heads(g.header_cols);
      base.header_rows = heads(g.header_rows);
      base.cells = e.cells.map((c) => ({
        id: c.id,
        row: c.row,
        col: c.col,
        type: c.type,
        label: c.label,
        ...typing(c.field, c.type),
      }));
      return base;
    }
  }
}

/** The agent schema's `fields` (and page list) of a render schema, in fenfill's order. */
export function projectAgentSchema(
  render: unknown,
  meta: { template_id?: string | null; name?: string | null } = {},
): AgentSchema {
  const schema = normalizeSchema(render as Parameters<typeof normalizeSchema>[0]);
  const byId = new Map(agentEntries(schema).map((e) => [e.id, e]));
  const fieldById = buildFieldById(schema.fields);
  const grouped = new Set(schema.groups.flatMap((g) => g.members));
  const fields: AgentEntry[] = [];
  const pages: AgentSchema["pages"] = [];
  const seen = new Set<number>();
  for (const p of schema.pages) {
    if (seen.has(p.page)) continue;
    seen.add(p.page);
    pages.push({ page: p.page, width: p.width, height: p.height });
    const { items } = buildPageItems(
      p,
      schema.fields.filter((f) => f.page === p.page && !grouped.has(f.id)),
      schema.groups.filter((g) => g.page === p.page),
      (g) => resolveMembers(g, fieldById),
    );
    let section: AgentEntry["section"] = null;
    for (const it of items) {
      if (it.kind === "header") {
        section = { id: it.section.id, title: str(it.section.title) };
        continue;
      }
      const sid = it.kind === "field" ? it.field.section_id : (it.members[0]?.section_id ?? null);
      const e = byId.get(it.kind === "field" ? it.field.id : it.group.id);
      if (!e) continue;
      fields.push(entryOf(e, p.page, sid != null && section?.id === sid ? section : null));
    }
  }
  return {
    schema_version: 1,
    template_id: meta.template_id ?? null,
    name: meta.name ?? null,
    page_count: pages.length,
    pages,
    fields,
  };
}

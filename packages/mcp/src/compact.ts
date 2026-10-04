// The agent-facing view of an agent schema: `box` dropped, entries nested under
// their (page, section) block, null/false keys stripped. Past ~60k characters a
// multi-page view collapses to a per-page overview, and the agent narrows with
// `pages` (free on a cached form). A single page is always listed in full.

import { pagesToSpec } from "./cache.js";
import type { AgentEntry, AgentSchema } from "./types.js";

export const COMPACT_MAX_CHARS = 60_000;
const OVERVIEW_TITLES_PER_PAGE = 20;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Drop null/false/undefined keys, recursively through objects and arrays. */
export function strip(v: unknown): Json | undefined {
  if (v === null || v === false || v === undefined) return undefined;
  if (Array.isArray(v)) {
    return v.map((x) => strip(x)).filter((x): x is Json => x !== undefined);
  }
  if (typeof v === "object") {
    const out: { [k: string]: Json } = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const s = strip(x);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  return undefined;
}

function compactEntry(e: AgentEntry): Json {
  const { box: _box, page: _page, section: _section, ...rest } = e;
  return strip(rest) ?? {};
}

export interface SectionBlock {
  page: number;
  title?: string;
  fields: Json[];
}

export interface CompactForm {
  name?: string;
  /** Spec of the pages this view lists, e.g. "1-3,5". */
  pages: string;
  field_count: number;
  sections: SectionBlock[];
}

export interface OverviewForm {
  name?: string;
  pages: string;
  field_count: number;
  too_large: true;
  overview: { page: number; fields: number; required: number; sections?: string[] }[];
  next: string;
}

function selectEntries(agent: AgentSchema, requested: readonly number[] | null): AgentEntry[] {
  if (!requested) return agent.fields;
  const want = new Set(requested);
  return agent.fields.filter((e) => want.has(e.page));
}

function listedPages(agent: AgentSchema, requested: readonly number[] | null): number[] {
  const have = agent.pages.map((p) => p.page);
  if (!requested) return have;
  const want = new Set(requested);
  return have.filter((p) => want.has(p));
}

/** Nest entries by (page, section), in first-appearance (reading) order. */
export function nestBySection(entries: readonly AgentEntry[]): SectionBlock[] {
  const blocks = new Map<string, SectionBlock>();
  for (const e of entries) {
    const sid = e.section?.id ?? "";
    const key = `${String(e.page)}\u0000${sid}`;
    let b = blocks.get(key);
    if (!b) {
      const title = e.section?.title;
      b = { page: e.page, ...(title ? { title } : {}), fields: [] };
      blocks.set(key, b);
    }
    b.fields.push(compactEntry(e));
  }
  return [...blocks.values()];
}

export function compactView(
  agent: AgentSchema,
  requested: readonly number[] | null,
  next: string,
  maxChars = COMPACT_MAX_CHARS,
): CompactForm | OverviewForm {
  const entries = selectEntries(agent, requested);
  const pages = listedPages(agent, requested);
  const base = {
    ...(agent.name ? { name: agent.name } : {}),
    pages: pagesToSpec(pages),
    field_count: entries.length,
  };
  const full: CompactForm = { ...base, sections: nestBySection(entries) };
  if (pages.length <= 1 || JSON.stringify(full).length <= maxChars) return full;

  const overview = pages.map((page) => {
    const onPage = entries.filter((e) => e.page === page);
    const titles: string[] = [];
    for (const e of onPage) {
      const t = e.section?.title;
      if (t && !titles.includes(t)) titles.push(t);
    }
    const row: OverviewForm["overview"][number] = {
      page,
      fields: onPage.length,
      required: onPage.filter((e) => e.required === true).length,
    };
    if (titles.length) row.sections = titles.slice(0, OVERVIEW_TITLES_PER_PAGE);
    return row;
  });
  return { ...base, too_large: true, overview, next };
}

// Merges every cached analysis of one blank PDF (same sha256) into one form,
// PER PAGE: for each page, the newest analysis that covered it wins, and that
// page's fields, groups and page entry (with its sections) all come from that
// one analysis — so a group always travels with its own members. A long PDF
// analyzed in chunks (`pages`) therefore fills as a single form.
//
// "Covered" means the pages the job actually analyzed (the job's `pages`), not
// the render schema's page list: an AI job renders every page but only the
// selected ones carry fields.
//
// "Newest" is an analysis's recency: when it was fetched, or when a cache hit
// last showed it alone (a template view) — the last view the agent saw is what
// fill_form fills.
//
// One exception: an AcroForm extra-blank pass (`extra_blanks_pages`) maps every
// native-field page but scanned only some. Its other pages rank below any
// analysis that is complete for them, so a later pass over page 2 never hides
// what an earlier pass found on page 1.

import {
  accessOf,
  type AnalyzeOptions,
  type ApiIdentity,
  type CachedAnalysis,
  extraBlanksPagesOf,
  sameAccount,
} from "./cache.js";
import { parsePageSpec } from "./pages.js";
import type { AgentEntry, AgentSchema, RenderSchema } from "./types.js";

export interface MergedForm {
  render: RenderSchema;
  agent: AgentSchema;
  /** Ascending pages with an analysis. */
  covered: number[];
  /** The analysis each page came from. */
  sources: Map<number, CachedAnalysis>;
}

function recency(e: CachedAnalysis): string {
  return typeof e.served_at === "string" && e.served_at > e.at ? e.served_at : e.at;
}

function byAge(a: CachedAnalysis, b: CachedAnalysis): number {
  const ra = recency(a);
  const rb = recency(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  return a.job_id < b.job_id ? -1 : a.job_id > b.job_id ? 1 : 0;
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * An agent entry narrowed to what the merged render can fill: options, cells
 * and columns whose field came from another analysis are dropped (a group
 * whose members span pages won by different analyses), a comb group's length
 * follows its remaining members, and an entry left with nothing is dropped.
 */
function pruneEntry(
  e: AgentEntry,
  present: ReadonlyMap<string, RenderSchema["fields"][number]>,
  group: RenderSchema["groups"][number] | undefined,
): AgentEntry | null {
  let out: AgentEntry = e;
  let lists = 0;
  let kept = 0;
  for (const k of ["options", "cells", "columns"] as const) {
    const list: unknown = e[k];
    if (!Array.isArray(list)) continue;
    lists++;
    const left = list.filter((x) => isRecord(x) && typeof x.id === "string" && present.has(x.id));
    kept += left.length;
    if (left.length !== list.length) out = { ...out, [k]: left };
  }
  if (lists > 0 && kept === 0) return null;
  if (group && typeof e.max_length === "number") {
    const ids = Array.isArray(group.members) ? (group.members as unknown[]) : [];
    let len = 0;
    for (const id of ids) {
      const f = typeof id === "string" ? present.get(id) : undefined;
      if (!f) continue;
      const n = Array.isArray(f.cells) ? f.cells.length : 0;
      len += n > 1 ? n : 1;
    }
    if (len === 0) return null;
    if (len !== e.max_length) out = { ...out, max_length: len };
  }
  return out;
}

function groupPage(
  g: RenderSchema["groups"][number],
  fieldPage: Map<string, number>,
): number | undefined {
  if (typeof g.page === "number") return g.page;
  const members = Array.isArray(g.members) ? (g.members as unknown[]) : [];
  for (const m of members) {
    if (typeof m === "string" && fieldPage.has(m)) return fieldPage.get(m);
  }
  return undefined;
}

export function mergeAnalyses(entries: readonly CachedAnalysis[]): MergedForm | null {
  if (entries.length === 0) return null;
  const ordered = [...entries].sort(byAge);
  const sources = new Map<number, CachedAnalysis>();
  const complete = new Set<number>();
  for (const e of ordered) {
    const extra = extraBlanksPagesOf(e);
    for (const p of e.pages) {
      const partial = !!extra && !extra.includes(p);
      if (partial && complete.has(p)) continue;
      sources.set(p, e);
      if (!partial) complete.add(p);
    }
  }
  const covered = [...sources.keys()].sort((a, b) => a - b);
  const newest = ordered[ordered.length - 1];

  const render: RenderSchema = {
    version: newest.render.version ?? 5,
    pages: [],
    fields: [],
    groups: [],
  };
  const agentPages: AgentSchema["pages"] = [];
  const agentFields: AgentEntry[] = [];

  // Per-source lookups, built once.
  const fieldPageOf = new Map<CachedAnalysis, Map<string, number>>();
  const lookup = (e: CachedAnalysis) => {
    let m = fieldPageOf.get(e);
    if (!m) {
      m = new Map();
      for (const f of Array.isArray(e.render.fields) ? e.render.fields : []) {
        if (f && typeof f.id === "string" && typeof f.page === "number") m.set(f.id, f.page);
      }
      fieldPageOf.set(e, m);
    }
    return m;
  };

  for (const p of covered) {
    const src = sources.get(p);
    if (!src) continue;
    const rPages = Array.isArray(src.render.pages) ? src.render.pages : [];
    const pageEntry = rPages.find((x) => x && x.page === p);
    if (pageEntry) render.pages.push(pageEntry);
    for (const f of Array.isArray(src.render.fields) ? src.render.fields : []) {
      if (f && f.page === p) render.fields.push(f);
    }
    const fp = lookup(src);
    for (const g of Array.isArray(src.render.groups) ? src.render.groups : []) {
      if (g && groupPage(g, fp) === p) render.groups.push(g);
    }
    const aPage = src.agent.pages.find((x) => x.page === p);
    if (aPage) agentPages.push(aPage);
    for (const entry of src.agent.fields) if (entry.page === p) agentFields.push(entry);
  }

  // Advertise only what the merged render can fill.
  const present = new Map(render.fields.map((f) => [f.id, f] as const));
  const groupById = new Map(render.groups.map((g) => [g.id, g] as const));
  const fillable: AgentEntry[] = [];
  for (const entry of agentFields) {
    const kept = pruneEntry(entry, present, groupById.get(entry.id));
    if (kept) fillable.push(kept);
  }

  const agent: AgentSchema = {
    schema_version: newest.agent.schema_version,
    template_id: null,
    name: newest.agent.name,
    page_count: agentPages.length,
    pages: agentPages,
    fields: fillable,
  };
  return { render, agent, covered, sources };
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

/**
 * Does a set of analyzed pages satisfy a request? `requested` null = "every
 * page": satisfied by an analysis that was itself run without `pages` (the
 * server's own notion of the whole document, up to the plan's page window),
 * or by chunks covering every local page.
 */
export function satisfies(
  covered: ReadonlySet<number>,
  options: readonly AnalyzeOptions[],
  requested: readonly number[] | null,
  pageCount: number | null,
): boolean {
  if (requested === null) {
    if (options.some((o) => o.pages === null)) return true;
    return pageCount != null && pageCount > 0 && range(pageCount).every((p) => covered.has(p));
  }
  return requested.length > 0 && requested.every((p) => covered.has(p));
}

export interface CacheHit {
  merged: MergedForm;
  template_id: string | null;
  /** A view of ONE analysis that isn't already the newest: serving it must
   *  bump its recency, so fill_form fills the ids this view shows. */
  bump: CachedAnalysis | null;
}

/**
 * The cached answer to an analyze request, or null (a miss).
 *
 * save_as_template=true is only met by ONE saved analysis of this API account
 * (`who`) covering the whole request (a template is one analysis) and saved
 * with the same `access`; its view is that analysis alone, so the ids match
 * the template fill_template will load.
 * Schemas are shared across accounts (they describe the blank form), template
 * ids never are.
 */
export function cacheHit(
  entries: readonly CachedAnalysis[],
  requested: readonly number[] | null,
  saveAsTemplate: boolean,
  pageCount: number | null,
  who: ApiIdentity | null,
  access: "public" | "restricted" = "public",
  extraBlanks = false,
): CacheHit | null {
  // detect_extra_blanks wants every blank found: an AI analysis (vision ran)
  // or an AcroForm one that ran the extra pass — and only on the pages that
  // pass scanned. A plain AcroForm entry is a miss.
  if (extraBlanks) entries = entries.filter(coversExtraBlanks);
  const pagesOf = (e: CachedAnalysis) => (extraBlanks ? extraBlankPages(e) : e.pages);
  if (saveAsTemplate) {
    const saved = entries
      .filter(
        (e) =>
          e.template_id &&
          sameAccount(e, who) &&
          accessOf(e.options) === access &&
          satisfies(new Set(pagesOf(e)), [e.options], requested, pageCount),
      )
      .sort(byAge);
    const best = saved[saved.length - 1];
    if (!best) return null;
    const merged = mergeAnalyses([best]);
    if (!merged) return null;
    const newest = entries.every((e) => e === best || byAge(e, best) < 0);
    return { merged, template_id: best.template_id, bump: newest ? null : best };
  }
  const merged = mergeAnalyses(entries);
  if (!merged) return null;
  // Extra blanks: a page counts only when the analysis it came from scanned it.
  const covered = extraBlanks
    ? merged.covered.filter((p) => {
        const src = merged.sources.get(p);
        return !!src && extraBlankPages(src).includes(p);
      })
    : merged.covered;
  const ok = satisfies(
    new Set(covered),
    entries.map((e) => e.options),
    requested,
    pageCount,
  );
  if (!ok) return null;
  return { merged, template_id: soleTemplateId(merged, requested, who), bump: null };
}

/** Did this analysis look for blanks beyond the native form fields (on any page)? */
export function coversExtraBlanks(e: CachedAnalysis): boolean {
  return e.mode !== "acroform" || e.options?.detect_extra_blanks === true;
}

/**
 * The pages of an analysis that were looked at for blanks beyond the native
 * fields: an AcroForm extra pass's own `extra_blanks_pages` (its `pages` are
 * every native-field page, most never scanned); without that list (an AI job,
 * or an older entry) what a detect_extra_blanks request asked for, else every
 * analyzed page (vision ran on all of them). None on a plain AcroForm entry.
 */
export function extraBlankPages(e: CachedAnalysis): number[] {
  if (!coversExtraBlanks(e)) return [];
  const own = new Set(e.pages);
  const extra = extraBlanksPagesOf(e);
  if (extra) return extra.filter((p) => own.has(p));
  if (e.options?.detect_extra_blanks === true && typeof e.options.pages === "string") {
    try {
      return parsePageSpec(e.options.pages).filter((p) => own.has(p));
    } catch {
      return [];
    }
  }
  return e.pages;
}

/** The template id when every requested page came from one saved analysis of
 *  this API account (another account's template id is never shown). */
export function soleTemplateId(
  merged: MergedForm,
  requested: readonly number[] | null,
  who: ApiIdentity | null,
): string | null {
  const pages = requested ?? merged.covered;
  const srcs = new Set(pages.map((p) => merged.sources.get(p)));
  if (srcs.size !== 1) return null;
  const [only] = [...srcs];
  return only && sameAccount(only, who) ? only.template_id : null;
}

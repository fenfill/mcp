import { describe, expect, it } from "vitest";

import type { ApiIdentity, CachedAnalysis } from "../src/cache.js";
import { analysisName, pagesToSpec } from "../src/cache.js";
import { jobCovers } from "../src/analyze.js";
import { COMPACT_MAX_CHARS, compactView, strip } from "../src/compact.js";
import { cacheHit, extraBlankPages, mergeAnalyses } from "../src/merge.js";
import { parsePageSpec } from "../src/pages.js";
import type { AgentEntry, AgentSchema, RenderSchema } from "../src/types.js";
import { fixture, reId } from "./helpers.js";

const SHA = "a".repeat(64);
const WHO: ApiIdentity = {
  api_origin: "https://api.fenfill.com",
  account: { workspace_id: "ws-1", key_sha: "k1" },
};

function analysis(
  over: Partial<CachedAnalysis> & Pick<CachedAnalysis, "pages" | "render" | "agent" | "at">,
): CachedAnalysis {
  return {
    v: 1,
    sha256: SHA,
    options: { pages: pagesToSpec(over.pages), save_as_template: false },
    job_id: `job-${over.at}`,
    template_id: null,
    mode: "ai",
    cost: over.pages.length,
    page_count: 2,
    ...over,
  };
}

describe("page specs", () => {
  it("parses like /v1 and canonicalizes", () => {
    expect(parsePageSpec(" 3 , 1-2,2-4 ")).toEqual([1, 2, 3, 4]);
    expect(pagesToSpec([5, 1, 2, 3, 9, 10])).toBe("1-3,5,9-10");
    expect(() => parsePageSpec("0")).toThrow(/start at 1/);
    expect(() => parsePageSpec("4-2")).toThrow(/low to high/);
    expect(() => parsePageSpec("1-3", 2)).toThrow(/has 2 pages/);
    expect(() => parsePageSpec("a")).toThrow();
  });
});

describe("mergeAnalyses (chunked pages)", () => {
  const { render, agent } = fixture("expandable_tables"); // 2 pages, a table on each

  it("takes each page from the newest analysis that covered it", () => {
    const p1 = reId(render, agent, "A");
    const p2 = reId(render, agent, "B");
    // Chunk 1 analyzed page 1, chunk 2 page 2. Each render lists BOTH pages and
    // all fields (an AI job renders every page), but only its covered page counts.
    const merged = mergeAnalyses([
      analysis({ pages: [1], at: "2026-09-29T10:00:00.000Z", ...p1 }),
      analysis({ pages: [2], at: "2026-09-29T11:00:00.000Z", ...p2 }),
    ]);
    expect(merged?.covered).toEqual([1, 2]);
    const ids = merged!.render.fields.map((f) => `${f.id}@${String(f.page)}`);
    expect(ids.every((s) => (s.endsWith("@1") ? s.startsWith("A-") : s.startsWith("B-")))).toBe(
      true,
    );
    expect(merged!.render.fields).toHaveLength(render.fields.length);
    // A group travels with its members' analysis.
    const fieldIds = new Set(merged!.render.fields.map((f) => f.id));
    for (const g of merged!.render.groups) {
      for (const m of g.members as string[]) expect(fieldIds.has(m)).toBe(true);
    }
    expect(merged!.agent.fields.map((e) => e.id[0])).toEqual(["A", "A", "B"]);
    expect(merged!.agent.pages.map((p) => p.page)).toEqual([1, 2]);
  });

  it("a newer re-analysis of a page replaces the older one", () => {
    const old = reId(render, agent, "OLD");
    const fresh = reId(render, agent, "NEW");
    const merged = mergeAnalyses([
      analysis({ pages: [1, 2], at: "2026-09-29T10:00:00.000Z", ...old }),
      analysis({ pages: [1], at: "2026-09-29T12:00:00.000Z", ...fresh }),
    ]);
    const byPage = (p: number) =>
      merged!.render.fields.filter((f) => f.page === p).map((f) => f.id);
    expect(byPage(1).every((id) => id.startsWith("NEW-"))).toBe(true);
    expect(byPage(2).every((id) => id.startsWith("OLD-"))).toBe(true);
  });

  it("serves requests from the merged coverage", () => {
    const a = analysis({ pages: [1], at: "2026-09-29T10:00:00.000Z", ...reId(render, agent, "A") });
    const b = analysis({ pages: [2], at: "2026-09-29T11:00:00.000Z", ...reId(render, agent, "B") });
    expect(cacheHit([a], [1], false, 2, WHO)).not.toBeNull();
    expect(cacheHit([a], [2], false, 2, WHO)).toBeNull();
    expect(cacheHit([a], null, false, 2, WHO)).toBeNull();
    expect(cacheHit([a, b], null, false, 2, WHO)).not.toBeNull();
    // save_as_template needs ONE saved analysis covering the request.
    expect(cacheHit([a, b], [1], true, 2, WHO)).toBeNull();
    const saved = { ...a, template_id: "tpl-1", api_origin: WHO.api_origin, account: WHO.account };
    expect(cacheHit([saved, b], [1], true, 2, WHO)?.template_id).toBe("tpl-1");
  });
});

describe("cache entries of another API or account (dev vs prod)", () => {
  const { render, agent } = fixture("expandable_tables");
  const saved = analysis({
    pages: [1, 2],
    at: "2026-09-29T10:00:00.000Z",
    ...reId(render, agent, "S"),
    template_id: "tpl-dev",
    options: { pages: null, save_as_template: true },
    api_origin: "http://localhost:8000",
    account: { workspace_id: "ws-dev", key_sha: "kdev" },
  });

  it("never serves or shows another origin's or workspace's template id", () => {
    const prod: ApiIdentity = {
      api_origin: "https://api.fenfill.com",
      account: { workspace_id: "ws-dev", key_sha: "kdev" },
    };
    const otherWs: ApiIdentity = {
      api_origin: "http://localhost:8000",
      account: { workspace_id: "ws-other", key_sha: "kdev" },
    };
    for (const who of [prod, otherWs, null]) {
      expect(cacheHit([saved], null, true, 2, who)).toBeNull();
      // The schema itself is still served (it describes the blank form)…
      const hit = cacheHit([saved], null, false, 2, who);
      expect(hit?.merged.agent.fields.length).toBeGreaterThan(0);
      // …but never the other account's template id.
      expect(hit?.template_id).toBeNull();
    }
  });

  it("matches the same workspace under a rotated key, or the same key without a workspace id", () => {
    const rotated: ApiIdentity = {
      api_origin: "http://localhost:8000",
      account: { workspace_id: "ws-dev", key_sha: "k-new" },
    };
    const keyOnly: ApiIdentity = {
      api_origin: "http://localhost:8000",
      account: { workspace_id: null, key_sha: "kdev" },
    };
    for (const who of [rotated, keyOnly]) {
      expect(cacheHit([saved], null, true, 2, who)?.template_id).toBe("tpl-dev");
      expect(cacheHit([saved], null, false, 2, who)?.template_id).toBe("tpl-dev");
    }
  });

  it("treats an entry without identity (an older cache) as another account's", () => {
    const legacy = { ...saved, api_origin: undefined, account: undefined };
    expect(cacheHit([legacy], null, true, 2, WHO)).toBeNull();
    expect(cacheHit([legacy], null, false, 2, WHO)?.template_id).toBeNull();
  });
});

describe("the view shown is what fill_form fills", () => {
  const { render, agent } = fixture("expandable_tables");
  const saved = analysis({
    pages: [1, 2],
    at: "2026-09-29T10:00:00.000Z",
    ...reId(render, agent, "S"),
    template_id: "tpl-1",
    api_origin: WHO.api_origin,
    account: WHO.account,
  });
  const newer = analysis({
    pages: [1, 2],
    at: "2026-09-29T11:00:00.000Z",
    ...reId(render, agent, "N"),
  });

  it("a template view of an older analysis asks for a bump; once served it wins the merge", () => {
    const hit = cacheHit([saved, newer], null, true, 2, WHO)!;
    expect(hit.merged.agent.fields.every((e) => e.id.startsWith("S-"))).toBe(true);
    expect(hit.bump).toBe(saved);
    // Before the bump fill_form (the merge) would fill N's ids…
    expect(mergeAnalyses([saved, newer])!.agent.fields.every((e) => e.id.startsWith("N-"))).toBe(
      true,
    );
    // …after it, S's: the ids the agent was shown.
    const served = { ...saved, served_at: "2026-09-29T12:00:00.000Z" };
    expect(mergeAnalyses([served, newer])!.agent.fields.every((e) => e.id.startsWith("S-"))).toBe(
      true,
    );
    expect(cacheHit([served, newer], null, true, 2, WHO)!.bump).toBeNull();
  });
});

describe("the merged view lists only what the merged render can fill", () => {
  // Page 1's table (from A) has members on pages 1 AND 2; page 2 came from B.
  const f = (id: string, page: number, extra: Record<string, unknown> = {}) => ({
    id,
    page,
    type: "text",
    label: id,
    xpct: 10,
    ypct: 10,
    wpct: 10,
    hpct: 3,
    ...extra,
  });
  const entry = (id: string, page: number, extra: Record<string, unknown>): AgentEntry => ({
    id,
    type: "table",
    label: id,
    page,
    section: null,
    ...extra,
  });
  const renderA: RenderSchema = {
    version: 5,
    pages: [{ page: 1 }, { page: 2 }],
    fields: [
      f("a-c1", 1, { group: "a-tab" }),
      f("a-c2", 2, { group: "a-tab" }),
      f("a-o1", 2, { group: "a-choice", type: "checkbox" }),
      f("a-k1", 1, { group: "a-comb" }),
      f("a-k2", 2, { group: "a-comb", cells: [{}, {}, {}] }),
      f("a-solo", 1),
    ],
    groups: [
      { id: "a-tab", kind: "table", page: 1, members: ["a-c1", "a-c2"] },
      { id: "a-choice", kind: "choice", page: 1, members: ["a-o1"] },
      { id: "a-comb", kind: "comb", page: 1, members: ["a-k1", "a-k2"] },
    ],
  };
  const agentA: AgentSchema = {
    schema_version: 1,
    template_id: null,
    name: null,
    page_count: 2,
    pages: [
      { page: 1, width: 1, height: 1 },
      { page: 2, width: 1, height: 1 },
    ],
    fields: [
      entry("a-tab", 1, {
        cells: [
          { id: "a-c1", row: 0, col: 0, type: "text", label: "c1" },
          { id: "a-c2", row: 1, col: 0, type: "text", label: "c2" },
        ],
      }),
      entry("a-choice", 1, { type: "radio", options: [{ id: "a-o1", label: "o1" }] }),
      entry("a-comb", 1, { type: "comb", max_length: 4, cell_type: "char" }),
      entry("a-solo", 1, { type: "text" }),
    ],
  };
  const renderB: RenderSchema = {
    version: 5,
    pages: [{ page: 1 }, { page: 2 }],
    fields: [f("b-x", 2)],
    groups: [],
  };
  const agentB: AgentSchema = {
    ...agentA,
    fields: [entry("b-x", 2, { type: "text" })],
  };

  it("drops cells, options and comb cells whose field lost its page, and emptied entries", () => {
    const merged = mergeAnalyses([
      analysis({ pages: [1, 2], at: "2026-09-29T10:00:00.000Z", render: renderA, agent: agentA }),
      analysis({ pages: [2], at: "2026-09-29T11:00:00.000Z", render: renderB, agent: agentB }),
    ])!;
    const byId = Object.fromEntries(merged.agent.fields.map((e) => [e.id, e]));
    expect(Object.keys(byId).sort()).toEqual(["a-comb", "a-solo", "a-tab", "b-x"]);
    expect((byId["a-tab"].cells as { id: string }[]).map((c) => c.id)).toEqual(["a-c1"]);
    expect(byId["a-comb"].max_length).toBe(1); // a-k2's 3 cells went with page 2
    // Nothing advertised that the merged render can't fill.
    const present = new Set(merged.render.fields.map((x) => x.id));
    for (const e of merged.agent.fields) {
      for (const k of ["cells", "options", "columns"]) {
        for (const x of (e[k] as { id: string }[] | undefined) ?? []) {
          expect(present.has(x.id), x.id).toBe(true);
        }
      }
    }
  });

  it("leaves a fully-present form untouched", () => {
    const merged = mergeAnalyses([
      analysis({ pages: [1, 2], at: "2026-09-29T10:00:00.000Z", render: renderA, agent: agentA }),
    ])!;
    expect(merged.agent.fields).toEqual(agentA.fields);
  });
});

describe("compactView", () => {
  const { agent } = fixture("canonical");

  it("drops box, nests by section and strips null/false", () => {
    const v = compactView(agent, null, "narrow");
    expect("sections" in v).toBe(true);
    if (!("sections" in v)) return;
    expect(v.sections).toHaveLength(1);
    expect(v.sections[0]).toMatchObject({ page: 1, title: "Personal details" });
    const text = JSON.stringify(v);
    expect(text).not.toContain('"box"');
    expect(text).not.toContain("null");
    expect(text).not.toContain("false");
    expect(v.sections[0].fields[0]).toEqual({
      id: "f-text",
      type: "text",
      label: "Amount",
      required: true,
      description: "Total due in PLN",
      placeholder: "0.00",
    });
  });

  it("keeps zeros and nested option/cell data", () => {
    expect(strip({ a: 0, b: false, c: null, d: [{ row: 0, x: null }] })).toEqual({
      a: 0,
      d: [{ row: 0 }],
    });
  });

  it("collapses a large multi-page form to a per-page overview", () => {
    const big: AgentSchema = { ...agent, pages: [], fields: [] };
    for (let p = 1; p <= 20; p++) {
      big.pages.push({ page: p, width: 1000, height: 1400 });
      for (let i = 0; i < 60; i++) {
        big.fields.push({
          id: `p${String(p)}-f${String(i)}`,
          type: "text",
          label: `A reasonably descriptive field label number ${String(i)}`,
          page: p,
          section: { id: `s${String(p)}`, title: `Section ${String(p)}` },
          required: i % 7 === 0,
          description: "Some help text for this field",
          placeholder: null,
          autofill: null,
        } as AgentEntry);
      }
    }
    const v = compactView(big, null, "narrow with pages");
    expect(JSON.stringify(v).length).toBeLessThan(COMPACT_MAX_CHARS);
    expect(v).toMatchObject({
      too_large: true,
      pages: "1-20",
      field_count: 1200,
      next: "narrow with pages",
    });
    if (!("overview" in v)) throw new Error("expected an overview");
    expect(v.overview[0]).toEqual({ page: 1, fields: 60, required: 9, sections: ["Section 1"] });

    const narrowed = compactView(big, [2, 3], "n");
    expect("sections" in narrowed && narrowed.pages).toBe("2-3");
    // One page is always listed in full, however large.
    const one = compactView(big, [5], "n", 100);
    expect("sections" in one).toBe(true);
  });
});

describe("detect_extra_blanks coverage (an AcroForm job's extra pass)", () => {
  const { render, agent } = fixture("expandable_tables"); // 2 pages
  // A2: reported mode "ai", `pages` = every native-field page, but the vision
  // pass scanned only extra_blanks_pages.
  const a2 = analysis({
    pages: [1, 2],
    at: "2026-09-29T10:00:00.000Z",
    options: { pages: "1", save_as_template: false, detect_extra_blanks: true },
    extra_blanks_pages: [1],
    ...reId(render, agent, "X"),
  });

  it("a cached pass covers only the pages it scanned", () => {
    expect(extraBlankPages(a2)).toEqual([1]);
    expect(cacheHit([a2], [1], false, 2, WHO, "public", true)).not.toBeNull();
    expect(cacheHit([a2], [2], false, 2, WHO, "public", true)).toBeNull();
    expect(cacheHit([a2], null, false, 2, WHO, "public", true)).toBeNull();
    // A plain request is still served from every analyzed page.
    expect(cacheHit([a2], [2], false, 2, WHO)).not.toBeNull();
    // Saved: the same rule.
    const saved = { ...a2, template_id: "tpl-x", api_origin: WHO.api_origin, account: WHO.account };
    expect(cacheHit([saved], [1], true, 2, WHO, "public", true)?.template_id).toBe("tpl-x");
    expect(cacheHit([saved], [2], true, 2, WHO, "public", true)).toBeNull();
    // A true AI analysis scanned all its pages.
    const ai = analysis({
      pages: [1, 2],
      at: "2026-09-29T09:00:00.000Z",
      ...reId(render, agent, "A"),
    });
    expect(extraBlankPages(ai)).toEqual([1, 2]);
    // An older entry without the list: what the request asked for.
    const legacy = { ...a2, extra_blanks_pages: undefined };
    expect(extraBlankPages(legacy)).toEqual([1]);
  });

  it("a running pass covers only its extra_blanks_pages (not the job's pages)", () => {
    const want = (pages: number[]) => ({
      options: {
        pages: pagesToSpec(pages),
        save_as_template: false,
        detect_extra_blanks: true as const,
      },
      requested: pages,
      pageCount: 2,
    });
    const job = {
      options: { pages: "1", save_as_template: false, detect_extra_blanks: true as const },
      mode: "ai",
      pages: [1, 2],
      extra_blanks_pages: [1],
    };
    expect(jobCovers(job, want([1]))).toBe(true);
    expect(jobCovers(job, want([2]))).toBe(false);
    expect(jobCovers({ ...job, extra_blanks_pages: undefined }, want([2]))).toBe(false);
    // A plain request is covered by every page the job reads.
    expect(jobCovers(job, { ...want([2]), options: { pages: "2", save_as_template: false } })).toBe(
      true,
    );
  });

  it("merging: a pass's unscanned pages rank below an analysis complete for them", () => {
    const b = analysis({
      pages: [1, 2],
      at: "2026-09-29T11:00:00.000Z",
      options: { pages: "2", save_as_template: false, detect_extra_blanks: true },
      extra_blanks_pages: [2],
      ...reId(render, agent, "Y"),
    });
    const m = mergeAnalyses([a2, b])!;
    expect(m.sources.get(1)).toBe(a2);
    expect(m.sources.get(2)).toBe(b);
    expect(cacheHit([a2, b], null, false, 2, WHO, "public", true)).not.toBeNull();
    // An unscanned page alone still serves (native fields), and a complete
    // newer analysis wins as usual.
    expect(mergeAnalyses([b])!.sources.get(1)).toBe(b);
    const plain = analysis({
      pages: [1, 2],
      at: "2026-09-29T12:00:00.000Z",
      mode: "acroform",
      ...reId(render, agent, "P"),
    });
    expect(mergeAnalyses([a2, b, plain])!.sources.get(1)).toBe(plain);
  });

  it("names an extra pass by its scanned pages; other entries keep their names", () => {
    const b = { ...a2, extra_blanks_pages: [2], options: { ...a2.options, pages: "2" } };
    expect(analysisName(a2)).toBe("p1-2.e-p1.u.json");
    expect(analysisName(b)).toBe("p1-2.e-p2.u.json");
    const plain = analysis({ pages: [1, 2], at: "x", ...reId(render, agent, "P") });
    expect(analysisName(plain)).toBe("p1-2.u.json");
    expect(analysisName({ ...plain, template_id: "tpl-1" })).toBe("p1-2.s-tpl-1.json");
  });
});

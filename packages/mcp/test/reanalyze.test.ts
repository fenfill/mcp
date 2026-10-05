// reanalyze_template end to end over the MCP client (mocked /v1), plus the pure
// pageDiff.

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Cache, rerunHash, type TemplatePendingEntry } from "../src/cache.js";
import { pageDiff } from "../src/reanalyze.js";
import type { RenderSchema } from "../src/types.js";
import {
  apiError,
  connect,
  json,
  type Connected,
  env,
  fixture,
  MockApi,
  onlyPages,
  pdfFor,
  rerunFlow,
  testIdentity,
  tmp,
  virtualClock,
} from "./helpers.js";

const JOB = "11111111-2222-4333-8444-555555555555";
const RJOB = "99999999-2222-4333-8444-555555555555";
const TPL = "3f1b953e-0fe9-5154-84f2-285d8aff38f5";
const V1 = "2026-10-05T12:00:00.000000+00:00";
const V2 = "2026-10-05T12:09:00.000000+00:00";

const raw = fixture("ungrouped_fields");
const render: RenderSchema = {
  ...raw.render,
  fields: raw.render.fields.filter((f) => f.type !== "note"),
};
const agent = raw.agent;
const full = {
  render,
  agent: { ...agent, pages: agent.pages.map((p) => ({ ...p, analyzed: true })) },
};
const page1Only = onlyPages(render, agent, [1]);
const nameId = agent.fields.find((e) => e.label === "Full name")!.id;
const page2Ids = render.fields.filter((f) => f.page === 2).map((f) => f.id);

let t: ReturnType<typeof tmp>;
let cacheDir: string;
const open: Connected[] = [];

beforeEach(() => {
  t = tmp();
  cacheDir = join(t.dir, "cache");
});
afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
  t.cleanup();
});

async function server(mock: MockApi, extra: Record<string, string> = {}) {
  const c = await connect({ env: env(cacheDir, extra), fetchImpl: mock.fetch, ...virtualClock() });
  open.push(c);
  return c;
}

const ls = (d: string) => (existsSync(d) ? readdirSync(d) : []);
const rerunPosts = (m: MockApi) => m.count("POST", new RegExp(`^/v1/templates/${TPL}/analyze$`));

describe("reanalyze_template", () => {
  it("analyzes a never-analyzed page: one POST with pages + expected_updated_at, then the page's diff", async () => {
    const mock = new MockApi();
    const flow = rerunFlow(mock, {
      templateId: TPL,
      jobId: RJOB,
      before: page1Only,
      after: full,
      v1: V1,
      v2: V2,
      pages: [2],
    });
    const c = await server(mock);

    // get_template shows the never-analyzed page.
    const g = await c.call("get_template", { template_id: TPL });
    expect(g.data.unanalyzed_pages).toEqual([2]);
    expect(g.data.has_local_edits).toBe(false);
    expect(g.data.field_count_total).toBe(g.data.field_count); // no pages filter: the same

    const r = await c.call("reanalyze_template", { template_id: TPL, pages: "2" });
    expect(r.isError).toBe(false);
    expect(flow.posts).toEqual([{ pages: "2", expected_updated_at: V1 }]); // no kind: scratch
    expect(r.data).toMatchObject({
      status: "done",
      job_id: RJOB,
      kind: "scratch",
      cost: 1,
      template_id: TPL,
      updated_at: V2,
      analyzed_pages: [1, 2],
      pages: "2",
      field_count: 3,
    });
    expect(r.data.unanalyzed_pages).toBeUndefined();
    const changed = r.data.changed_pages as {
      page: number;
      added: { id: string; label: string; type: string }[];
      removed: unknown[];
      changed: unknown[];
    }[];
    expect(changed).toHaveLength(1);
    expect(changed[0].page).toBe(2);
    expect(changed[0].added.map((a) => a.id).sort()).toEqual([...page2Ids].sort());
    expect(changed[0].added.find((a) => a.label === "City")).toMatchObject({ type: "text" });
    expect(changed[0].removed).toEqual([]);
    expect(String(r.data.next)).toMatch(/preview_page/);
    expect(String(r.data.next)).toMatch(/edit_template/);
    expect(ls(join(cacheDir, "pending"))).toEqual([]); // marker cleared

    // get_template now: nothing unanalyzed.
    const g2 = await c.call("get_template", { template_id: TPL });
    expect(g2.data.unanalyzed_pages).toBeUndefined();
  });

  it("estimate prices the run (no version, no job, no template read)", async () => {
    const mock = new MockApi();
    const flow = rerunFlow(mock, {
      templateId: TPL,
      jobId: RJOB,
      before: full,
      after: full,
      v1: V1,
      v2: V2,
      pages: [1, 2],
      estimate: {
        kind: "label_missing",
        pages: [1, 2],
        cost: 0,
        free_label_pages: 2,
        free_label_pages_left: 48,
        scans_left: 7,
        insufficient: false,
      },
    });
    const c = await server(mock);
    const r = await c.call("reanalyze_template", {
      template_id: TPL,
      pages: "2,1",
      kind: "label_missing",
      estimate: true,
    });
    expect(r.isError).toBe(false);
    expect(flow.posts).toEqual([{ pages: "1-2", kind: "label_missing", estimate: true }]);
    expect(r.data).toMatchObject({
      status: "estimate",
      cost: 0,
      free_label_pages: 2,
      scans_left: 7,
      insufficient: false,
    });
    expect(mock.count("GET", /^\/v1\/jobs\//)).toBe(0);
    expect(mock.count("GET", /^\/v1\/templates\//)).toBe(0);
  });

  it("refuses while local edits exist; discard: true drops them when the run finishes", async () => {
    const mock = new MockApi();
    const flow = rerunFlow(mock, {
      templateId: TPL,
      jobId: RJOB,
      before: full,
      after: full,
      v1: V1,
      v2: V2,
      pages: [1],
    });
    const c = await server(mock);
    const e = await c.call("edit_template", {
      template_id: TPL,
      ops: [{ op: "relabel", id: nameId, label: "Name" }],
    });
    expect(e.data.applied).toBe(1);
    expect(ls(join(cacheDir, "edits"))).toHaveLength(1);

    const refused = await c.call("reanalyze_template", {
      template_id: TPL,
      pages: "1",
      kind: "find",
    });
    expect(refused.isError).toBe(true);
    expect(refused.data.error).toMatchObject({ code: "local_edits_pending" });
    expect(String((refused.data.error as { hint: string }).hint)).toMatch(
      /save_template.*discard: true/,
    );
    expect(flow.posts).toHaveLength(0);

    const r = await c.call("reanalyze_template", {
      template_id: TPL,
      pages: "1",
      kind: "find",
      discard: true,
    });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ status: "done", discarded: true, kind: "find" });
    expect(flow.posts).toEqual([{ pages: "1", kind: "find", expected_updated_at: V1 }]);
    expect(ls(join(cacheDir, "edits"))).toEqual([]);
    expect(r.data.changed_pages).toEqual([]); // nothing changed on page 1
    expect(String(r.data.note)).toMatch(/No field changed/);

    // save_template now has nothing to save, and says why.
    const s = await c.call("save_template", { template_id: TPL });
    expect(s.data).toMatchObject({ saved: false, nothing_to_save: true });
    expect(String(s.data.note)).toMatch(/reanalyze_template/);
  });

  it("returns running past the wait budget; the same call resumes the same job without re-posting", async () => {
    const mock = new MockApi();
    const flow = rerunFlow(mock, {
      templateId: TPL,
      jobId: RJOB,
      before: page1Only,
      after: full,
      v1: V1,
      v2: V2,
      pages: [2],
      states: ["queued", "queued"],
    });
    const c = await server(mock, { FENFILL_ANALYZE_WAIT_SECONDS: "5" });
    const first = await c.call("reanalyze_template", { template_id: TPL, pages: "2" });
    expect(first.data).toMatchObject({ status: "running", job_id: RJOB });
    expect(String(first.data.next)).toMatch(/same arguments/);
    expect(ls(join(cacheDir, "pending"))).toHaveLength(1);
    expect(ls(join(cacheDir, "pending"))[0]).toMatch(
      new RegExp(`^t-${TPL}\\.[0-9a-f]{16}\\.json$`),
    );

    // A different process resumes it too (the marker is on disk).
    const later = await server(mock, { FENFILL_ANALYZE_WAIT_SECONDS: "60" });
    const done = await later.call("reanalyze_template", { template_id: TPL, pages: "2" });
    expect(done.data).toMatchObject({ status: "done", job_id: RJOB, analyzed_pages: [1, 2] });
    expect(flow.posts).toHaveLength(1);
    // The diff is against the template as it was when the run started.
    const changed = done.data.changed_pages as { page: number; added: unknown[] }[];
    expect(changed[0].added).toHaveLength(3);
    expect(ls(join(cacheDir, "pending"))).toEqual([]);
  });

  it("maps refusals to actionable hints and leaves no marker", async () => {
    for (const [status, code, hint] of [
      [422, "kind_required", /"find"/],
      [409, "job_in_progress", /get_template/],
      [409, "template_conflict", /get_template/],
      [402, "insufficient_scans", /estimate: true/],
      [403, "template_frozen", /frozen/],
    ] as const) {
      const mock = new MockApi();
      rerunFlow(mock, {
        templateId: TPL,
        jobId: RJOB,
        before: full,
        after: full,
        v1: V1,
        v2: V2,
        pages: [1],
        refuse: () => apiError(status, code, { need: 2, have: 0, current_updated_at: V2 }),
      });
      const c = await server(mock);
      const r = await c.call("reanalyze_template", { template_id: TPL, pages: "1" });
      expect(r.isError, code).toBe(true);
      expect(r.data.error, code).toMatchObject({ code });
      expect(String((r.data.error as { hint: string }).hint), code).toMatch(hint);
      expect(rerunPosts(mock), code).toBe(1); // never re-sent
      expect(ls(join(cacheDir, "pending")), code).toEqual([]);
    }
  });

  it("waits out a 429 refused before any job exists, then posts again", async () => {
    const mock = new MockApi();
    rerunFlow(mock, {
      templateId: TPL,
      jobId: RJOB,
      before: page1Only,
      after: full,
      v1: V1,
      v2: V2,
      pages: [2],
      refuse: (_b, n) =>
        n === 1 ? apiError(429, "too_many_active_jobs", { retry_after: 5 }) : null,
    });
    const c = await server(mock);
    const r = await c.call("reanalyze_template", { template_id: TPL, pages: "2" });
    expect(r.data.status).toBe("done");
    expect(rerunPosts(mock)).toBe(2);
  });

  it("a job error leaves the template's state alone and says the scans are refunded", async () => {
    const mock = new MockApi()
      .on("GET", new RegExp(`^/v1/templates/${TPL}\\?include=render$`), () =>
        Response.json({ ...full.agent, template_id: TPL, updated_at: V1, render }),
      )
      .on("POST", new RegExp(`^/v1/templates/${TPL}/analyze$`), () =>
        Response.json(
          { job_id: RJOB, status: "queued", mode: "ai", pages: [1], cost: 1 },
          {
            status: 202,
          },
        ),
      )
      .on("GET", new RegExp(`^/v1/jobs/${RJOB}\\?include=render$`), () =>
        Response.json({
          job_id: RJOB,
          status: "error",
          mode: "ai",
          phase: null,
          progress: 0,
          pages: [1],
          cost: 1,
          created_at: "x",
          template_id: null,
          error: { code: "internal_error", message: "boom" },
          result: null,
        }),
      );
    const c = await server(mock);
    const r = await c.call("reanalyze_template", { template_id: TPL, pages: "1", kind: "find" });
    expect(r.data.error).toMatchObject({ code: "internal_error", job_id: RJOB });
    expect(String((r.data.error as { hint: string }).hint)).toMatch(/unchanged.*refunded/);
    expect(ls(join(cacheDir, "pending"))).toEqual([]);
  });

  it("refreshes the template's cached analyses so analyze_form serves the new page free", async () => {
    // Saved from page 1 only (the 0.1.0 case: page 2 was never analyzed).
    const pdfPath = join(t.dir, "form.pdf");
    writeFileSync(pdfPath, await pdfFor(render));
    const mock = new MockApi().analyzeFlow({
      jobId: JOB,
      render: page1Only.render,
      agent: page1Only.agent,
      pages: [1],
      templateId: TPL,
    });
    rerunFlow(mock, {
      templateId: TPL,
      jobId: RJOB,
      before: page1Only,
      after: full,
      v1: V1,
      v2: V2,
      pages: [2],
    });
    const c = await server(mock);
    const a = await c.call("analyze_form", { path: pdfPath, pages: "1", save_as_template: true });
    expect(a.data).toMatchObject({ status: "done", template_id: TPL });

    const r = await c.call("reanalyze_template", { template_id: TPL, pages: "2" });
    expect(r.data.status).toBe("done");

    const analyzes = mock.count("POST", /^\/v1\/forms\/analyze$/);
    const p2 = await c.call("analyze_form", { path: pdfPath, pages: "2" });
    expect(p2.data).toMatchObject({ status: "done", cached: true, cost: 0, template_id: TPL });
    expect(p2.data.field_count).toBe(3);
    expect(mock.count("POST", /^\/v1\/forms\/analyze$/)).toBe(analyzes); // no new upload

    // …and an edit → save round trip on the re-analyzed template works.
    const e = await c.call("edit_template", {
      template_id: TPL,
      ops: [{ op: "relabel", id: page2Ids[0], label: "Town" }],
    });
    expect(e.data.applied).toBe(1);
  });

  it("rejects a malformed page spec before any request", async () => {
    const mock = new MockApi();
    const c = await server(mock);
    const r = await c.call("reanalyze_template", { template_id: TPL, pages: "3-1" });
    expect(r.data.error).toMatchObject({ code: "invalid_request" });
    expect(mock.calls).toHaveLength(0);
  });
});

describe("reanalyze_template: a POST of unknown outcome never charges twice", () => {
  /** A template whose first re-analysis POST really started a run. */
  function serverSide(opts: { firstRun: "finished" | "running"; lose: boolean }) {
    let version = V1;
    let state = page1Only;
    const posts: Record<string, unknown>[] = [];
    const mock = new MockApi()
      .on("GET", new RegExp(`^/v1/templates/${TPL}\\?include=render$`), () =>
        json(200, { ...state.agent, template_id: TPL, updated_at: version, render: state.render }),
      )
      .on("POST", new RegExp(`^/v1/templates/${TPL}/analyze$`), (req) => {
        const body = JSON.parse(req.body) as Record<string, unknown>;
        posts.push(body);
        if (body.expected_updated_at !== version) {
          return apiError(409, "template_conflict", { current_updated_at: version });
        }
        if (posts.length === 1) {
          // The run starts (and, here, finishes) …
          if (opts.firstRun === "finished") {
            version = V2;
            state = full;
          }
          // … but its 202 never arrives.
          if (opts.lose) throw new TypeError("fetch failed");
        }
        if (opts.firstRun === "running") return apiError(409, "job_in_progress");
        return json(202, { job_id: RJOB, status: "queued", mode: "ai", pages: [2], cost: 1 });
      });
    return { mock, posts, finishedVersion: () => version };
  }

  it("outcome_unknown keeps the version; the repeat re-sends it and gets template_conflict, not a second run", async () => {
    const { mock, posts } = serverSide({ firstRun: "finished", lose: true });
    const c = await server(mock);
    const first = await c.call("reanalyze_template", { template_id: TPL, pages: "2" });
    expect(first.data.error).toMatchObject({ code: "outcome_unknown" });
    const hint = String((first.data.error as { hint: string }).hint);
    expect(hint).toMatch(/get_template/);
    expect(hint).not.toMatch(/no extra charge/);
    expect(ls(join(cacheDir, "pending"))).toHaveLength(1); // kept

    const again = await c.call("reanalyze_template", { template_id: TPL, pages: "2" });
    expect(again.isError).toBe(true);
    expect(again.data.error).toMatchObject({
      code: "template_conflict",
      earlier_run_likely_finished: true,
    });
    expect(String((again.data.error as { hint: string }).hint)).toMatch(
      /get_template.*pages\[\]\.analyzed/,
    );
    // Both POSTs carried the ORIGINAL version, so only the first could run.
    expect(posts.map((p) => p.expected_updated_at)).toEqual([V1, V1]);

    // Still guarded on a third call (the marker lives out its TTL).
    const third = await c.call("reanalyze_template", { template_id: TPL, pages: "2" });
    expect(third.data.error).toMatchObject({ code: "template_conflict" });
    expect(posts.map((p) => p.expected_updated_at)).toEqual([V1, V1, V1]);
  });

  it("a first run still going answers job_in_progress, without promising a resume", async () => {
    const { mock, posts } = serverSide({ firstRun: "running", lose: true });
    const c = await server(mock);
    expect(
      (await c.call("reanalyze_template", { template_id: TPL, pages: "2" })).data.error,
    ).toMatchObject({ code: "outcome_unknown" });
    const again = await c.call("reanalyze_template", { template_id: TPL, pages: "2" });
    expect(again.data.error).toMatchObject({ code: "job_in_progress" });
    const hint = String((again.data.error as { hint: string }).hint);
    expect(hint).toMatch(/get_template/);
    expect(hint).not.toMatch(/no extra charge/);
    expect(posts.map((p) => p.expected_updated_at)).toEqual([V1, V1]);
    expect(ls(join(cacheDir, "pending"))).toHaveLength(1);
  });

  async function deadLock(createdMsAgo: number) {
    const now = Date.parse("2026-09-29T12:00:00Z"); // virtualClock's start
    const entry: TemplatePendingEntry = {
      v: 1,
      template_id: TPL,
      pages: "2",
      kind: null,
      created_at: new Date(now - createdMsAgo).toISOString(),
      pid: 999_999_999, // gone: died after its POST, before recording the job id
      token: "dead",
      ...testIdentity(),
      before: page1Only.render,
      before_updated_at: V1,
    };
    await new Cache(cacheDir).updateTemplatePending(
      entry,
      rerunHash(TPL, "2", null, testIdentity()),
    );
  }

  it("a dead holder's lock without a job id re-sends its recorded version", async () => {
    // The dead process's POST went through and the run finished: now V2.
    const mock = new MockApi();
    const flow = rerunFlow(mock, {
      templateId: TPL,
      jobId: RJOB,
      before: full,
      after: full,
      v1: V2,
      v2: V2,
      pages: [2],
      refuse: (b) =>
        b.expected_updated_at !== V2
          ? apiError(409, "template_conflict", { current_updated_at: V2 })
          : null,
    });
    await deadLock(60_000);
    const c = await server(mock);
    const r = await c.call("reanalyze_template", { template_id: TPL, pages: "2" });
    expect(r.data.error).toMatchObject({
      code: "template_conflict",
      earlier_run_likely_finished: true,
    });
    expect(flow.posts).toEqual([{ pages: "2", expected_updated_at: V1 }]);
    expect(mock.count("GET", /^\/v1\/templates\//)).toBe(0); // no fresh read of the version
  });

  it("…and runs normally when that POST had never reached fenfill", async () => {
    const mock = new MockApi();
    const flow = rerunFlow(mock, {
      templateId: TPL,
      jobId: RJOB,
      before: page1Only,
      after: full,
      v1: V1,
      v2: V2,
      pages: [2],
    });
    await deadLock(60_000);
    const c = await server(mock);
    const r = await c.call("reanalyze_template", { template_id: TPL, pages: "2" });
    expect(r.data).toMatchObject({ status: "done", job_id: RJOB });
    expect(flow.posts).toEqual([{ pages: "2", expected_updated_at: V1 }]);
    expect((r.data.changed_pages as { added: unknown[] }[])[0].added).toHaveLength(3);
    expect(ls(join(cacheDir, "pending"))).toEqual([]);
  });

  it("past the marker's 24 h TTL, an explicit call starts fresh with the current version", async () => {
    const mock = new MockApi();
    const flow = rerunFlow(mock, {
      templateId: TPL,
      jobId: RJOB,
      before: full,
      after: full,
      v1: V2,
      v2: V2,
      pages: [2],
    });
    await deadLock(25 * 60 * 60 * 1000);
    const c = await server(mock);
    const r = await c.call("reanalyze_template", { template_id: TPL, pages: "2", kind: "find" });
    // (kind differs → another request; same pages without kind would also be fresh)
    expect(r.data.status).toBe("done");
    const r2 = await c.call("reanalyze_template", { template_id: TPL, pages: "2" });
    expect(r2.data.status).toBe("done");
    expect(flow.posts.map((p) => p.expected_updated_at)).toEqual([V2, V2]);
  });
});

describe("pageDiff", () => {
  const f = (id: string, page: number, extra: Record<string, unknown> = {}) => ({
    id,
    page,
    type: "text",
    label: id.toUpperCase(),
    xpct: 10,
    ypct: 10,
    wpct: 20,
    hpct: 3,
    group: null,
    ...extra,
  });
  const schema = (fields: RenderSchema["fields"], groups: RenderSchema["groups"] = []) =>
    ({
      version: 5,
      pages: [{ page: 1 }, { page: 2 }, { page: 3 }],
      fields,
      groups,
    }) as RenderSchema;

  it("reports added, removed and changed (label, type, box) by id, per scoped page", () => {
    const before = schema([
      f("keep", 1),
      f("gone", 2),
      f("rename", 2),
      f("retype", 2),
      f("moved", 2),
      f("same", 2),
      f("outside", 3),
    ]);
    const after = schema([
      f("keep", 1, { label: "CHANGED BUT OUT OF SCOPE" }),
      f("rename", 2, { label: "New label" }),
      f("retype", 2, { type: "date" }),
      f("moved", 2, { xpct: 50 }),
      f("same", 2),
      f("new", 2, { type: "checkbox" }),
      f("outside", 3, { label: "x" }),
    ]);
    const d = pageDiff(before, after, [2]);
    expect(d).toEqual([
      {
        page: 2,
        added: [{ id: "new", label: "NEW", type: "checkbox" }],
        removed: [{ id: "gone", label: "GONE", type: "text" }],
        changed: [
          {
            id: "rename",
            label: "New label",
            type: "text",
            changes: ["label"],
            was: { label: "RENAME" },
          },
          { id: "retype", label: "RETYPE", type: "date", changes: ["type"], was: { type: "text" } },
          { id: "moved", label: "MOVED", type: "text", changes: ["box"] },
        ],
      },
    ]);
  });

  it("lists only pages with a change, and none when nothing changed", () => {
    const s = schema([f("a", 1), f("b", 2)]);
    expect(pageDiff(s, s, [1, 2])).toEqual([]);
    const after = schema([f("a", 1), f("b", 2), f("c", 3)]);
    expect(pageDiff(s, after, [1, 2, 3]).map((p) => p.page)).toEqual([3]);
  });

  it("treats a group as one item: members' types, labels and boxes change it", () => {
    const members = [f("m1", 1, { group: "g" }), f("m2", 1, { group: "g" })];
    const g = { id: "g", kind: "table", label: "Lines", page: 1, members: ["m1", "m2"] };
    const before = schema(members, [g]);
    const after = schema([members[0], { ...members[1], type: "date" }], [g]);
    expect(pageDiff(before, after, [1])).toEqual([
      {
        page: 1,
        added: [],
        removed: [],
        changed: [{ id: "g", label: "Lines", type: "table", changes: ["members"] }],
      },
    ]);
    // A choice group reads as radio / multiselect; its page comes from its members.
    const choice = { id: "c", kind: "choice", multiple: true, label: "Pick", members: ["m1"] };
    const added = pageDiff(schema([]), schema([members[0]], [choice]), [1]);
    expect(added[0].added).toEqual([{ id: "c", label: "Pick", type: "multiselect" }]);
  });

  it("is tolerant of a multiline text and a missing label", () => {
    const before = schema([]);
    const after = schema([f("n", 1, { label: undefined, format: { variant: "multiline" } })]);
    expect(pageDiff(before, after, [1])[0].added).toEqual([
      { id: "n", label: null, type: "multiline" },
    ]);
  });
});

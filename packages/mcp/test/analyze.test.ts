import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { analyzeForm, LIVE_OWNERS } from "../src/analyze.js";
import { FenfillApi } from "../src/api.js";
import {
  type AnalyzeOptions,
  type ApiIdentity,
  Cache,
  type CachedAnalysis,
  optionsHash,
  type PendingEntry,
  sha256Hex,
} from "../src/cache.js";
import type { AgentSchema, RenderSchema } from "../src/types.js";
import {
  API_KEY,
  API_URL,
  apiError,
  connect,
  type Connected,
  env,
  fixture,
  json,
  MockApi,
  pdfFor,
  reId,
  testIdentity,
  tmp,
  virtualClock,
} from "./helpers.js";

const JOB = "11111111-2222-4333-8444-555555555555";
const JOB2 = "66666666-7777-4888-8999-000000000000";

let t: ReturnType<typeof tmp>;
let cacheDir: string;
let pdfPath: string;
let pdfBytes: Uint8Array;
const open: Connected[] = [];

const { render, agent } = fixture("ungrouped_fields"); // 2 pages

async function server(
  mock: MockApi | null,
  extraEnv: Record<string, string> = {},
  clock = virtualClock(),
) {
  const c = await connect({
    env: mock ? env(cacheDir, extraEnv) : { FENFILL_CACHE_DIR: cacheDir, ...extraEnv },
    fetchImpl: mock?.fetch ?? ((() => Promise.reject(new Error("network used"))) as typeof fetch),
    now: clock.now,
    sleep: clock.sleep,
  });
  open.push(c);
  return c;
}

const analyzePosts = (m: MockApi) => m.count("POST", /^\/v1\/forms\/analyze$/);

beforeEach(async () => {
  t = tmp();
  cacheDir = join(t.dir, "cache");
  pdfPath = join(t.dir, "form.pdf");
  pdfBytes = await pdfFor(render);
  writeFileSync(pdfPath, pdfBytes);
});

afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
  t.cleanup();
});

describe("analyze_form", () => {
  it("POSTs once, polls to done with increasing progress, caches, then serves free and offline", async () => {
    const mock = new MockApi().analyzeFlow({
      jobId: JOB,
      render,
      agent,
      pages: [1, 2],
      states: ["queued", "queued", "running", "running"],
    });
    const c = await server(mock);
    const progress: number[] = [];
    const r = await c.call(
      "analyze_form",
      { path: pdfPath },
      { onprogress: (p) => progress.push(p.progress) },
    );
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({
      status: "done",
      cached: false,
      cost: 2,
      job_id: JOB,
      pages: "1-2",
    });
    expect(r.data.field_count).toBe(agent.fields.length);
    expect(analyzePosts(mock)).toBe(1);
    expect(progress).toEqual([0, 40]);

    // Cached: no API key, no network, no charge.
    const offline = await server(null);
    const again = await offline.call("analyze_form", { path: pdfPath });
    expect(again.data).toMatchObject({ status: "done", cached: true, cost: 0 });
    // Narrowing with pages is free too.
    const p2 = await offline.call("analyze_form", { path: pdfPath, pages: "2" });
    expect(p2.data).toMatchObject({ cached: true, pages: "2", field_count: 3 });
    expect(
      existsSync(join(cacheDir, "pending")) ? readdirSync(join(cacheDir, "pending")) : [],
    ).toEqual([]);
  });

  it("shares ONE POST between concurrent calls", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const mock = new MockApi();
    mock.on("POST", /^\/v1\/forms\/analyze$/, async () => {
      await gate;
      return json(202, { job_id: JOB, status: "queued", mode: "ai", pages: [1, 2], cost: 2 });
    });
    mock.analyzeFlow({ jobId: JOB, render, agent, pages: [1, 2] });
    const c = await server(mock);
    const calls = [1, 2, 3].map(() => c.call("analyze_form", { path: pdfPath }));
    while (analyzePosts(mock) === 0) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 50));
    release();
    const results = await Promise.all(calls);
    for (const r of results) expect(r.data).toMatchObject({ status: "done" });
    expect(analyzePosts(mock)).toBe(1);
  });

  it("shares the POST across server instances (processes) through the lock file", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const mock = new MockApi();
    mock.on("POST", /^\/v1\/forms\/analyze$/, async () => {
      await gate;
      return json(202, { job_id: JOB, status: "queued", mode: "ai", pages: [1, 2], cost: 2 });
    });
    mock.analyzeFlow({ jobId: JOB, render, agent, pages: [1, 2] });
    const a = await server(mock);
    const b = await server(mock);
    const ra = a.call("analyze_form", { path: pdfPath });
    while (analyzePosts(mock) === 0) await new Promise((r) => setTimeout(r, 5));
    const rb = b.call("analyze_form", { path: pdfPath });
    await new Promise((r) => setTimeout(r, 50));
    release();
    const [x, y] = await Promise.all([ra, rb]);
    expect(x.data.status).toBe("done");
    expect(["done", "running"]).toContain(y.data.status);
    expect(analyzePosts(mock)).toBe(1);
  });

  it("returns running when the budget runs out, then a later session resumes without a new POST", async () => {
    const mock = new MockApi().analyzeFlow({
      jobId: JOB,
      render,
      agent,
      pages: [1, 2],
      states: Array.from({ length: 30 }, () => "running" as const),
    });
    const c = await server(mock, { FENFILL_ANALYZE_WAIT_SECONDS: "20" });
    const r = await c.call("analyze_form", { path: pdfPath });
    expect(r.data).toMatchObject({ status: "running", job_id: JOB, progress: 40 });
    expect(String(r.data.next)).toMatch(/call analyze_form again with the same path/);
    const pend = readdirSync(join(cacheDir, "pending"));
    expect(pend).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(cacheDir, "pending", pend[0]), "utf8")).job_id).toBe(JOB);

    const later = await server(mock, { FENFILL_ANALYZE_WAIT_SECONDS: "600" });
    const done = await later.call("analyze_form", { path: pdfPath });
    expect(done.data).toMatchObject({ status: "done", job_id: JOB });
    expect(analyzePosts(mock)).toBe(1);
    expect(readdirSync(join(cacheDir, "pending"))).toEqual([]);
  });

  it("resumes a job recorded in a pending entry (no POST)", async () => {
    const cache = new Cache(cacheDir);
    const options = { pages: null, save_as_template: false };
    const who = testIdentity();
    await cache.updatePending(
      {
        v: 1,
        sha256: sha256Hex(pdfBytes),
        options,
        created_at: new Date(virtualClock().now()).toISOString(),
        pid: 999999,
        job_id: JOB,
        pages: [1, 2],
        mode: "ai",
        cost: 2,
        ...who,
      },
      optionsHash(options, who),
    );
    const mock = new MockApi().analyzeFlow({ jobId: JOB, render, agent, pages: [1, 2] });
    const r = await (await server(mock)).call("analyze_form", { path: pdfPath });
    expect(r.data).toMatchObject({ status: "done", job_id: JOB });
    expect(analyzePosts(mock)).toBe(0);
  });

  it("after an upload with an unknown outcome, refuses to re-POST for 10 minutes", async () => {
    let n = 0;
    const mock = new MockApi();
    mock.on("POST", /^\/v1\/forms\/analyze$/, () => {
      n++;
      if (n === 1) {
        return Promise.reject(
          Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }),
        );
      }
      return json(202, { job_id: JOB2, status: "queued", mode: "ai", pages: [1, 2], cost: 2 });
    });
    mock.analyzeFlow({ jobId: JOB2, render, agent, pages: [1, 2] });
    const clock = virtualClock();
    const c = await server(mock, {}, clock);
    const first = await c.call("analyze_form", { path: pdfPath });
    expect(first.data).toMatchObject({ error: { code: "upload_outcome_unknown" } });
    const second = await c.call("analyze_form", { path: pdfPath });
    expect(second.data).toMatchObject({ error: { code: "upload_outcome_unknown" } });
    expect(n).toBe(1);
    clock.advance(11 * 60 * 1000);
    const third = await c.call("analyze_form", { path: pdfPath });
    expect(third.data).toMatchObject({ status: "done", job_id: JOB2 });
    expect(n).toBe(2);
  });

  it("waits out a 429 refused before any job existed, re-POSTs once, and notes how to keep edits", async () => {
    let n = 0;
    const mock = new MockApi();
    mock.on("POST", /^\/v1\/forms\/analyze$/, () =>
      ++n === 1
        ? apiError(429, "too_many_active_jobs", { retry_after: 5 }, { "retry-after": "5" })
        : json(202, { job_id: JOB, status: "queued", mode: "ai", pages: [1, 2], cost: 2 }),
    );
    mock.analyzeFlow({ jobId: JOB, render, agent, pages: [1, 2] });
    const c = await server(mock);
    const r = await c.call("analyze_form", { path: pdfPath });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ status: "done", job_id: JOB, template_id: null });
    expect(r.data.save_note).toMatch(/save_as_template: true/);
    expect(analyzePosts(mock)).toBe(2);
    // The cached view says it too.
    const again = await c.call("analyze_form", { path: pdfPath });
    expect(again.data.save_note).toMatch(/can't be saved/);
  });

  it("reports a 429 it could not wait out, and clears the lock", async () => {
    const mock = new MockApi().on("POST", /^\/v1\/forms\/analyze$/, () =>
      apiError(429, "queue_full", { retry_after: 600 }, { "retry-after": "600" }),
    );
    const c = await server(mock);
    const r = await c.call("analyze_form", { path: pdfPath });
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatchObject({ code: "queue_full", retry_after: 600 });
    expect(analyzePosts(mock)).toBe(1);
    expect(readdirSync(join(cacheDir, "pending"))).toEqual([]);
  });

  it("a refused POST clears the lock and reports need/have", async () => {
    const mock = new MockApi().on("POST", /^\/v1\/forms\/analyze$/, () =>
      apiError(402, "insufficient_scans", { need: 2, have: 0 }),
    );
    const c = await server(mock);
    const r = await c.call("analyze_form", { path: pdfPath });
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatchObject({ code: "insufficient_scans", need: 2, have: 0 });
    expect(readdirSync(join(cacheDir, "pending"))).toEqual([]);
    await c.call("analyze_form", { path: pdfPath });
    expect(analyzePosts(mock)).toBe(2);
  });

  it("a failed job clears its pending entry and returns the job's error", async () => {
    const mock = new MockApi()
      .on("POST", /^\/v1\/forms\/analyze$/, () =>
        json(202, { job_id: JOB, status: "queued", mode: "ai", pages: [1, 2], cost: 2 }),
      )
      .on("GET", /^\/v1\/jobs\//, () =>
        json(200, {
          job_id: JOB,
          status: "error",
          mode: "ai",
          phase: null,
          progress: 0,
          pages: [1, 2],
          cost: 2,
          created_at: "x",
          template_id: null,
          error: { code: "no_fields_found", message: "No fillable fields were found." },
          result: null,
        }),
      );
    const r = await (await server(mock)).call("analyze_form", { path: pdfPath });
    expect(r.data.error).toMatchObject({ code: "no_fields_found", job_id: JOB });
    expect(readdirSync(join(cacheDir, "pending"))).toEqual([]);
  });

  it("a 410 while polling clears the pending entry", async () => {
    const mock = new MockApi()
      .on("POST", /^\/v1\/forms\/analyze$/, () =>
        json(202, { job_id: JOB, status: "queued", mode: "ai", pages: [1, 2], cost: 2 }),
      )
      .on("GET", /^\/v1\/jobs\//, () => apiError(410, "result_expired"));
    const r = await (await server(mock)).call("analyze_form", { path: pdfPath });
    expect(r.data.error).toMatchObject({ code: "result_expired" });
    expect(readdirSync(join(cacheDir, "pending"))).toEqual([]);
  });

  it("chunks: page-scoped analyses merge into one form for fill_form and whole-form requests", async () => {
    const mock = new MockApi()
      .on("POST", /^\/v1\/forms\/analyze$/, (req) => {
        const two = req.body.includes("pages=2");
        return json(202, {
          job_id: two ? JOB2 : JOB,
          status: "queued",
          mode: "ai",
          pages: two ? [2] : [1],
          cost: 1,
        });
      })
      .analyzeFlow({ jobId: JOB, render, agent, pages: [1] })
      .analyzeFlow({ jobId: JOB2, render, agent, pages: [2] });
    const c = await server(mock);
    const r1 = await c.call("analyze_form", { path: pdfPath, pages: "1" });
    expect(r1.data).toMatchObject({ status: "done", pages: "1", analyzed_pages: "1", cost: 1 });
    const r2 = await c.call("analyze_form", { path: pdfPath, pages: "2" });
    // analyzed_pages is what this view lists; the earlier chunk is named apart.
    expect(r2.data).toMatchObject({
      status: "done",
      pages: "2",
      analyzed_pages: "2",
      other_analyzed_pages: "1",
    });
    const whole = await c.call("analyze_form", { path: pdfPath });
    expect(whole.data).toMatchObject({ status: "done", cached: true, cost: 0, pages: "1-2" });
    expect(whole.data.field_count).toBe(agent.fields.length);
    expect(analyzePosts(mock)).toBe(2);

    // fill_form sees both chunks as one form.
    const page1 = agent.fields.find((e) => e.page === 1 && e.type === "text")!;
    const page2 = agent.fields.find((e) => e.page === 2 && e.type === "text")!;
    const out = join(t.dir, "chunked-out.pdf");
    const filled = await c.call("fill_form", {
      path: pdfPath,
      values: { [page1.id]: "One", [page2.id]: "Two" },
      output_path: out,
    });
    expect(filled.data).toMatchObject({ filled: 2, skipped: [] });
  });

  it("force re-analyzes; save_as_template is only met by a saved analysis", async () => {
    let n = 0;
    const mock = new MockApi()
      .on("POST", /^\/v1\/forms\/analyze$/, (req) => {
        n++;
        const save = req.body.includes("save_as_template=true");
        return json(202, {
          job_id: save ? JOB2 : JOB,
          status: "queued",
          mode: "ai",
          pages: [1, 2],
          cost: 2,
        });
      })
      .analyzeFlow({ jobId: JOB, render, agent, pages: [1, 2] })
      .analyzeFlow({ jobId: JOB2, render, agent, pages: [1, 2], templateId: "tpl-9" });
    const c = await server(mock);
    await c.call("analyze_form", { path: pdfPath });
    expect(n).toBe(1);
    await c.call("analyze_form", { path: pdfPath, force: true });
    expect(n).toBe(2);
    const saved = await c.call("analyze_form", { path: pdfPath, save_as_template: true });
    expect(saved.data).toMatchObject({ status: "done", cached: false, template_id: "tpl-9" });
    expect(n).toBe(3);
    const again = await c.call("analyze_form", { path: pdfPath, save_as_template: true });
    expect(again.data).toMatchObject({ cached: true, template_id: "tpl-9" });
    expect(n).toBe(3);
  });

  it('access: "restricted" is sent with the save, and a public template never answers it', async () => {
    const JOB3 = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
    const bodies: string[] = [];
    const mock = new MockApi()
      .on("POST", /^\/v1\/forms\/analyze$/, (req) => {
        bodies.push(req.body);
        const restricted = /^access=restricted$/m.test(req.body);
        return json(202, {
          job_id: restricted ? JOB3 : JOB2,
          status: "queued",
          mode: "ai",
          pages: [1, 2],
          cost: 2,
        });
      })
      .analyzeFlow({ jobId: JOB2, render, agent, pages: [1, 2], templateId: "tpl-public" })
      .analyzeFlow({ jobId: JOB3, render, agent, pages: [1, 2], templateId: "tpl-restricted" });
    const c = await server(mock);

    const bad = await c.call("analyze_form", { path: pdfPath, access: "restricted" });
    expect(bad.data.error).toMatchObject({ code: "invalid_argument" });
    expect(bodies).toHaveLength(0);

    const pub = await c.call("analyze_form", { path: pdfPath, save_as_template: true });
    expect(pub.data).toMatchObject({ template_id: "tpl-public" });
    expect(bodies[0]).not.toMatch(/^access=/m);

    const restricted = { path: pdfPath, save_as_template: true, access: "restricted" };
    const r = await c.call("analyze_form", restricted);
    expect(r.data).toMatchObject({ cached: false, template_id: "tpl-restricted" });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatch(/^access=restricted$/m);

    // Each access is served from its own saved analysis from then on; an
    // explicit "public" is the default.
    const again = await c.call("analyze_form", restricted);
    expect(again.data).toMatchObject({ cached: true, template_id: "tpl-restricted" });
    const pub2 = await c.call("analyze_form", {
      path: pdfPath,
      save_as_template: true,
      access: "public",
    });
    expect(pub2.data).toMatchObject({ cached: true, template_id: "tpl-public" });
    expect(bodies).toHaveLength(2);
  });
});

describe("analyze_form estimate", () => {
  const ACCOUNT = {
    workspace_id: "ws",
    tier: "pro",
    scans_remaining: 1,
    max_pages: 100,
    max_pages_per_job: 60,
    max_file_mb: 50,
    branding: { logo: false, watermark: false },
  };

  /** A 3-page PDF with a native text field on page 2 (and a push button on page 3). */
  async function acroPdf(): Promise<string> {
    const doc = await PDFDocument.create();
    const pages = [doc.addPage(), doc.addPage(), doc.addPage()];
    const form = doc.getForm();
    form.createTextField("name").addToPage(pages[1], { x: 50, y: 700, width: 200, height: 20 });
    form.createButton("go").addToPage("Go", pages[2], { x: 50, y: 600, width: 60, height: 20 });
    const p = join(t.dir, "acro.pdf");
    writeFileSync(p, await doc.save());
    return p;
  }

  it("prices a flat PDF locally: no upload, and no network at all without a key", async () => {
    const c = await server(null);
    const r = await c.call("analyze_form", { path: pdfPath, estimate: true });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({
      status: "estimate",
      page_count: 2,
      pages: "1-2",
      likely_mode: "ai",
      estimated_scans: 2,
      scans_remaining: null,
    });
    expect(r.data.note).toMatch(/one scan per page/);
    expect(
      existsSync(join(cacheDir, "pending")) && readdirSync(join(cacheDir, "pending")).length,
    ).toBeFalsy();
  });

  it("with a key, compares the cost with scans_remaining (GET /account only)", async () => {
    const mock = new MockApi().on("GET", /^\/v1\/account$/, () => json(200, ACCOUNT));
    const c = await server(mock);
    const r = await c.call("analyze_form", { path: pdfPath, pages: "2", estimate: true });
    expect(r.data).toMatchObject({ pages: "2", estimated_scans: 1, scans_remaining: 1 });
    const both = await c.call("analyze_form", { path: pdfPath, estimate: true });
    expect(both.data.note).toMatch(/Only 1 scans are left/);
    expect(analyzePosts(mock)).toBe(0);
    expect(mock.calls.every((x) => x.method === "GET")).toBe(true);
  });

  it("spots native form fields on the chosen pages (push buttons don't count)", async () => {
    const p = await acroPdf();
    const c = await server(null);
    const all = await c.call("analyze_form", { path: p, estimate: true });
    expect(all.data).toMatchObject({
      likely_mode: "acroform",
      estimated_scans: 0,
      native_field_pages: "2",
    });
    const page3 = await c.call("analyze_form", { path: p, pages: "3", estimate: true });
    expect(page3.data).toMatchObject({ likely_mode: "ai", estimated_scans: 1 });
  });

  it("says cached when the analysis is already on this machine", async () => {
    const mock = new MockApi().analyzeFlow({ jobId: JOB, render, agent, pages: [1, 2] });
    const c = await server(mock);
    await c.call("analyze_form", { path: pdfPath });
    const offline = await server(null);
    const r = await offline.call("analyze_form", { path: pdfPath, estimate: true });
    expect(r.data).toMatchObject({ likely_mode: "cached", estimated_scans: 0 });
    expect(analyzePosts(mock)).toBe(1);
  });
});

describe("analyze_form cancellation", () => {
  it("a cancelled call never aborts its upload; the next call resumes that job", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let aborted = false;
    const mock = new MockApi();
    mock.on("POST", /^\/v1\/forms\/analyze$/, async (req) => {
      void req;
      await gate;
      return json(202, { job_id: JOB, status: "queued", mode: "ai", pages: [1, 2], cost: 2 });
    });
    mock.analyzeFlow({ jobId: JOB, render, agent, pages: [1, 2] });
    const inner = mock.fetch;
    const spyFetch = ((url: string, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", () => (aborted = true));
      return inner(url, init);
    }) as typeof fetch;
    const c = await connect({ env: env(cacheDir), fetchImpl: spyFetch });
    open.push(c);
    const ac = new AbortController();
    const first = c.call("analyze_form", { path: pdfPath }, { signal: ac.signal });
    while (analyzePosts(mock) === 0) await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    await expect(first).rejects.toThrow();
    release();
    // The upload completes after the cancel and records its job id.
    for (let i = 0; i < 100; i++) {
      const pend = existsSync(join(cacheDir, "pending"))
        ? readdirSync(join(cacheDir, "pending"))
        : [];
      if (pend.length && readFileSync(join(cacheDir, "pending", pend[0]), "utf8").includes(JOB))
        break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(aborted).toBe(false);
    const again = await c.call("analyze_form", { path: pdfPath });
    expect(again.data).toMatchObject({ status: "done", job_id: JOB });
    expect(analyzePosts(mock)).toBe(1);
  });
});

describe("password-protected PDFs", () => {
  async function userPasswordPdf(): Promise<Uint8Array> {
    const { PDFDocument: Cantoo } = await import("@cantoo/pdf-lib");
    const doc = await Cantoo.create();
    const page = doc.addPage([612, 792]);
    doc.getForm().createTextField("n").addToPage(page, { x: 50, y: 700, width: 100, height: 20 });
    doc.encrypt({
      ownerPassword: "owner",
      userPassword: "user",
      algorithm: "AES-128",
      allowWeakCryptography: true,
      permissions: { fillingForms: true, modifying: false },
    });
    return doc.save();
  }

  it("analyze_form and fill_form both say a password is needed", async () => {
    const bytes = await userPasswordPdf();
    const p = join(t.dir, "locked.pdf");
    writeFileSync(p, bytes);
    const mock = new MockApi();
    const c = await server(mock);
    const a = await c.call("analyze_form", { path: p });
    expect(a.data.error).toMatchObject({ code: "pdf_password_required" });
    expect(mock.calls).toHaveLength(0);

    await new Cache(cacheDir).saveAnalysis({
      v: 1,
      sha256: sha256Hex(bytes),
      options: { pages: null, save_as_template: false },
      job_id: JOB,
      template_id: null,
      mode: "ai",
      cost: 1,
      pages: [1],
      page_count: 1,
      render,
      agent,
      at: new Date().toISOString(),
    });
    const f = await c.call("fill_form", {
      path: p,
      values: {},
      output_path: join(t.dir, "locked-out.pdf"),
    });
    expect(f.data.error).toMatchObject({ code: "pdf_password_required" });
  });

  it("fill_form refuses a PDF whose author forbids filling", async () => {
    const { PDFDocument: Cantoo } = await import("@cantoo/pdf-lib");
    const doc = await Cantoo.create();
    const page = doc.addPage([612, 792]);
    doc.getForm().createTextField("n").addToPage(page, { x: 50, y: 700, width: 100, height: 20 });
    doc.encrypt({
      ownerPassword: "owner",
      userPassword: "",
      algorithm: "AES-128",
      allowWeakCryptography: true,
      permissions: { fillingForms: false, annotating: false },
    });
    const bytes = await doc.save();
    const p = join(t.dir, "no-fill.pdf");
    writeFileSync(p, bytes);
    const c = await server(new MockApi());
    await new Cache(cacheDir).saveAnalysis({
      v: 1,
      sha256: sha256Hex(bytes),
      options: { pages: null, save_as_template: false },
      job_id: JOB,
      template_id: null,
      mode: "ai",
      cost: 1,
      pages: [1],
      page_count: 1,
      render,
      agent,
      at: new Date().toISOString(),
    });
    const f = await c.call("fill_form", {
      path: p,
      values: {},
      output_path: join(t.dir, "no-fill-out.pdf"),
    });
    expect(f.data.error).toMatchObject({ code: "pdf_fill_forbidden" });
  });
});

describe("analyze_form refuses non-blank PDFs", () => {
  it("refuses a PDF fill_form produced (Info tag) and one in the outputs registry", async () => {
    const mock = new MockApi().analyzeFlow({ jobId: JOB, render, agent, pages: [1, 2] });
    const c = await server(mock);
    await c.call("analyze_form", { path: pdfPath });
    const out = join(t.dir, "filled.pdf");
    const filled = await c.call("fill_form", {
      path: pdfPath,
      values: { [agent.fields[0].id]: "Ada" },
      output_path: out,
    });
    expect(filled.isError).toBe(false);
    const tagged = await c.call("analyze_form", { path: out });
    expect(tagged.data.error).toMatchObject({ code: "filled_output" });

    // Registry: strip the tag by re-saving the output's pages into a new doc,
    // then register that file's hash as an output.
    const src = await PDFDocument.load(readFileSync(out));
    const copy = await PDFDocument.create();
    for (const p of await copy.copyPages(src, src.getPageIndices())) copy.addPage(p);
    const untagged = await copy.save();
    const untaggedPath = join(t.dir, "untagged.pdf");
    writeFileSync(untaggedPath, untagged);
    await new Cache(cacheDir).registerOutput(sha256Hex(untagged));
    const reg = await c.call("analyze_form", { path: untaggedPath });
    expect(reg.data.error).toMatchObject({ code: "filled_output" });
    expect(analyzePosts(mock)).toBe(1);
  });

  it("refuses a PDF whose own form fields are filled in", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const tf = doc.getForm().createTextField("name");
    tf.addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
    tf.setText("Someone");
    const p = join(t.dir, "prefilled.pdf");
    writeFileSync(p, await doc.save());
    const mock = new MockApi();
    const r = await (await server(mock)).call("analyze_form", { path: p });
    expect(r.data.error).toMatchObject({ code: "prefilled_form" });
    expect(mock.calls).toHaveLength(0);
  });

  it("rejects a non-PDF locally", async () => {
    const p = join(t.dir, "x.pdf");
    writeFileSync(p, "hello");
    const mock = new MockApi();
    const r = await (await server(mock)).call("analyze_form", { path: p });
    expect(r.data.error).toMatchObject({ code: "not_pdf" });
    expect(mock.calls).toHaveLength(0);
  });
});

// ---- review fixes: covering jobs, accounts, wedges, lock races ---------------------------

const ECONNRESET = () =>
  Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }));
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A job poll answer: running (Retry-After 3 s) or done with a schema. */
function jobAnswer(
  jobId: string,
  status: "running" | "done",
  o: {
    pages: number[];
    mode?: "ai" | "acroform";
    templateId?: string | null;
    render?: RenderSchema;
    agent?: AgentSchema;
  },
) {
  const base = {
    job_id: jobId,
    mode: o.mode ?? "ai",
    pages: o.pages,
    cost: o.pages.length,
    created_at: "2026-09-29T00:00:00Z",
    error: null,
  };
  if (status === "running") {
    return json(
      200,
      { ...base, status, phase: "labels", progress: 40, template_id: null, result: null },
      { "retry-after": "3" },
    );
  }
  const tpl = o.templateId ?? null;
  return json(200, {
    ...base,
    status,
    phase: "done",
    progress: 100,
    template_id: tpl,
    result: { ...(o.agent ?? agent), template_id: tpl },
    render: o.render ?? render,
  });
}

const accepted = (jobId: string, pages: number[], mode: "ai" | "acroform" = "ai") =>
  json(202, { job_id: jobId, status: "queued", mode, pages, cost: pages.length });

const pendingFiles = () =>
  existsSync(join(cacheDir, "pending"))
    ? readdirSync(join(cacheDir, "pending")).filter((f) => f.endsWith(".json"))
    : [];

const readPendingFiles = () =>
  pendingFiles().map(
    (f) => JSON.parse(readFileSync(join(cacheDir, "pending", f), "utf8")) as PendingEntry,
  );

async function seedPending(over: Partial<PendingEntry>, who: ApiIdentity | null = testIdentity()) {
  const options: AnalyzeOptions = over.options ?? { pages: null, save_as_template: false };
  const entry: PendingEntry = {
    v: 1,
    sha256: sha256Hex(pdfBytes),
    options,
    created_at: new Date(virtualClock().now()).toISOString(),
    pid: 999999,
    ...(who ?? {}),
    ...over,
  };
  await new Cache(cacheDir).updatePending(entry, optionsHash(options, who));
}

const viewIds = (d: Record<string, unknown>) =>
  ((d.sections ?? []) as { fields: { id: string }[] }[]).flatMap((s) => s.fields.map((f) => f.id));

describe("a running job that covers the request is reused", () => {
  it("a whole-document job serves a later pages request: one POST", async () => {
    let finished = false;
    const mock = new MockApi()
      .on("POST", /^\/v1\/forms\/analyze$/, () => accepted(JOB, [1, 2]))
      .on("GET", new RegExp(`^/v1/jobs/${JOB}\\?include=render$`), () =>
        jobAnswer(JOB, finished ? "done" : "running", { pages: [1, 2] }),
      );
    const c = await server(mock, { FENFILL_ANALYZE_WAIT_SECONDS: "5" });
    expect((await c.call("analyze_form", { path: pdfPath })).data).toMatchObject({
      status: "running",
      job_id: JOB,
    });
    // The same pages spelled out, and a subset: both wait on the running job.
    expect((await c.call("analyze_form", { path: pdfPath, pages: "1-2" })).data).toMatchObject({
      status: "running",
      job_id: JOB,
    });
    finished = true;
    const one = await c.call("analyze_form", { path: pdfPath, pages: "1" });
    expect(one.data).toMatchObject({
      status: "done",
      job_id: JOB,
      pages: "1",
      analyzed_pages: "1",
      other_analyzed_pages: "2",
    });
    expect(analyzePosts(mock)).toBe(1);
    expect(pendingFiles()).toEqual([]);
    const whole = await c.call("analyze_form", { path: pdfPath });
    expect(whole.data).toMatchObject({ status: "done", cached: true, cost: 0 });
    expect(analyzePosts(mock)).toBe(1);
  });

  it("concurrent calls in one process share one POST across options (before any lock file)", async () => {
    // The lock file is held back, so the second call can only find the first
    // one's acquisition in this process's in-flight map.
    const who = testIdentity();
    let posts = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (init.method === "POST") {
        posts++;
        return accepted(JOB, [1, 2]);
      }
      if (/\/account$/.test(url)) return apiError(404, "not_found");
      return jobAnswer(JOB, "done", { pages: [1, 2] });
    }) as typeof fetch;
    const cache = new Cache(cacheDir);
    let releaseLock!: () => void;
    const lockGate = new Promise<void>((r) => (releaseLock = r));
    const create = cache.tryCreatePending.bind(cache);
    cache.tryCreatePending = async (...a: Parameters<Cache["tryCreatePending"]>) => {
      await lockGate;
      return create(...a);
    };
    const deps = {
      cache,
      api: () => new FenfillApi({ apiKey: API_KEY, apiUrl: API_URL }, { fetchImpl }),
      identity: () => Promise.resolve(who),
      now: Date.now,
      sleep: (ms: number) => delay(Math.min(ms, 5)),
      waitSeconds: 5,
      inFlight: new Map(),
      posts: new Set<Promise<unknown>>(),
      owner: "inflight-test",
    };
    const ctx = { signal: new AbortController().signal };
    const whole = analyzeForm(deps, { path: pdfPath }, ctx);
    while (deps.inFlight.size === 0) await delay(1);
    const page2 = analyzeForm(deps, { path: pdfPath, pages: "2" }, ctx);
    await delay(50);
    expect(pendingFiles()).toEqual([]); // no lock on disk yet
    releaseLock();
    const [w, p] = await Promise.all([whole, page2]);
    expect(w).toMatchObject({ status: "done", job_id: JOB, pages: "1-2" });
    expect(p).toMatchObject({ status: "done", pages: "2", field_count: 3 });
    expect(posts).toBe(1);
  });

  it("a forced call sharing an acquisition that ends in the cache still POSTs its own job", async () => {
    const who = testIdentity();
    let posts = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (init.method === "POST") {
        posts++;
        return accepted(JOB2, [1, 2]);
      }
      if (/\/account$/.test(url)) return apiError(404, "not_found");
      return jobAnswer(JOB2, "done", { pages: [1, 2] });
    }) as typeof fetch;
    const cache = new Cache(cacheDir);
    let releaseLock!: () => void;
    const lockGate = new Promise<void>((r) => (releaseLock = r));
    const create = cache.tryCreatePending.bind(cache);
    cache.tryCreatePending = async (...a: Parameters<Cache["tryCreatePending"]>) => {
      await lockGate;
      return create(...a);
    };
    const deps = {
      cache,
      api: () => new FenfillApi({ apiKey: API_KEY, apiUrl: API_URL }, { fetchImpl }),
      identity: () => Promise.resolve(who),
      now: Date.now,
      sleep: (ms: number) => delay(Math.min(ms, 5)),
      waitSeconds: 5,
      inFlight: new Map(),
      posts: new Set<Promise<unknown>>(),
      owner: "force-share-test",
    };
    const ctx = { signal: new AbortController().signal };
    const plain = analyzeForm(deps, { path: pdfPath }, ctx);
    while (deps.inFlight.size === 0) await delay(1);
    const forced = analyzeForm(deps, { path: pdfPath, force: true }, ctx);
    await delay(20);
    // The plain call's post-lock cache check will now find an analysis.
    await new Cache(cacheDir).saveAnalysis({
      v: 1,
      sha256: sha256Hex(pdfBytes),
      options: { pages: null, save_as_template: false },
      job_id: JOB,
      template_id: null,
      mode: "ai",
      cost: 2,
      pages: [1, 2],
      page_count: 2,
      render,
      agent,
      at: new Date().toISOString(),
      ...who,
    });
    releaseLock();
    const [p, f] = await Promise.all([plain, forced]);
    expect(p).toMatchObject({ status: "done", cached: true });
    expect(f).toMatchObject({ status: "done", cached: false, job_id: JOB2 });
    expect(posts).toBe(1);
  });

  it("a saving job covers a plain request, never the reverse", async () => {
    const posted: string[] = [];
    const mock = new MockApi()
      .on("POST", /^\/v1\/forms\/analyze$/, (req) => {
        const save = req.body.includes("save_as_template=true");
        posted.push(save ? "save" : "plain");
        return accepted(save ? JOB2 : JOB, [1, 2]);
      })
      .on("GET", /^\/v1\/jobs\//, (req) =>
        jobAnswer(req.url.includes(JOB2) ? JOB2 : JOB, "running", { pages: [1, 2] }),
      );
    const c = await server(mock, { FENFILL_ANALYZE_WAIT_SECONDS: "5" });
    await c.call("analyze_form", { path: pdfPath, save_as_template: true });
    const plain = await c.call("analyze_form", { path: pdfPath });
    expect(plain.data).toMatchObject({ status: "running", job_id: JOB2 });
    expect(posted).toEqual(["save"]);

    // A plain job never stands in for a template request.
    t.cleanup();
    t = tmp();
    cacheDir = join(t.dir, "cache");
    pdfPath = join(t.dir, "form.pdf");
    writeFileSync(pdfPath, pdfBytes);
    posted.length = 0;
    const c2 = await server(mock, { FENFILL_ANALYZE_WAIT_SECONDS: "5" });
    await c2.call("analyze_form", { path: pdfPath });
    const save = await c2.call("analyze_form", { path: pdfPath, save_as_template: true });
    expect(save.data).toMatchObject({ status: "running", job_id: JOB2 });
    expect(posted).toEqual(["plain", "save"]);
  });

  it("an AcroForm job covers every page, whatever `pages` it was started with", async () => {
    let finished = false;
    const mock = new MockApi()
      .on("POST", /^\/v1\/forms\/analyze$/, () => accepted(JOB, [1], "acroform"))
      .on("GET", new RegExp(`^/v1/jobs/${JOB}\\?include=render$`), () =>
        jobAnswer(JOB, finished ? "done" : "running", { pages: [1, 2], mode: "acroform" }),
      );
    const c = await server(mock, { FENFILL_ANALYZE_WAIT_SECONDS: "5" });
    expect((await c.call("analyze_form", { path: pdfPath, pages: "1" })).data.status).toBe(
      "running",
    );
    finished = true;
    const whole = await c.call("analyze_form", { path: pdfPath });
    expect(whole.data).toMatchObject({ status: "done", job_id: JOB, pages: "1-2" });
    expect(analyzePosts(mock)).toBe(1);
  });
});

describe("the cache is scoped to the API origin and account", () => {
  it("tags analyses and pending jobs with the origin and account, never the key", async () => {
    let finished = false;
    const mock = new MockApi()
      .on("GET", /^\/v1\/account$/, () => json(200, { workspace_id: "ws-7", tier: "pro" }))
      .on("POST", /^\/v1\/forms\/analyze$/, () => accepted(JOB, [1, 2]))
      .on("GET", new RegExp(`^/v1/jobs/${JOB}\\?include=render$`), () =>
        jobAnswer(JOB, finished ? "done" : "running", { pages: [1, 2] }),
      );
    const c = await server(mock, { FENFILL_ANALYZE_WAIT_SECONDS: "5" });
    await c.call("analyze_form", { path: pdfPath });
    const who = testIdentity("ws-7");
    expect(readPendingFiles()).toEqual([expect.objectContaining({ job_id: JOB, ...who })]);
    finished = true;
    await c.call("analyze_form", { path: pdfPath });
    const dir = join(cacheDir, "forms", sha256Hex(pdfBytes));
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const raw = readFileSync(join(dir, files[0]), "utf8");
    expect(JSON.parse(raw)).toMatchObject(who);
    expect(raw).not.toContain(API_KEY);
    // The workspace id is looked up once per key, for the process lifetime.
    expect(mock.count("GET", /^\/v1\/account$/)).toBe(1);
  });

  it("never resumes another origin's or workspace's pending job", async () => {
    const mine = testIdentity("ws-prod");
    await seedPending(
      { job_id: "dead0000-0000-4000-8000-000000000001" },
      { ...mine, api_origin: "http://localhost:8000" },
    );
    await seedPending(
      { job_id: "dead0000-0000-4000-8000-000000000002" },
      { api_origin: API_URL, account: { workspace_id: "ws-other", key_sha: "0123456789abcdef" } },
    );
    await seedPending({ job_id: "dead0000-0000-4000-8000-000000000003" }, null); // pre-identity
    const mock = new MockApi()
      .on("GET", /^\/v1\/account$/, () => json(200, { workspace_id: "ws-prod" }))
      .analyzeFlow({ jobId: JOB, render, agent, pages: [1, 2] });
    const r = await (await server(mock)).call("analyze_form", { path: pdfPath });
    expect(r.data).toMatchObject({ status: "done", job_id: JOB });
    expect(analyzePosts(mock)).toBe(1);
    expect(mock.count("GET", /^\/v1\/jobs\/dead/)).toBe(0);
  });

  it("serves another origin's saved analysis as schema only, never its template id", async () => {
    const dev: CachedAnalysis = {
      v: 1,
      sha256: sha256Hex(pdfBytes),
      options: { pages: null, save_as_template: true },
      job_id: JOB,
      template_id: "dev-template-id",
      mode: "ai",
      cost: 2,
      pages: [1, 2],
      page_count: 2,
      render,
      agent,
      at: new Date(virtualClock().now()).toISOString(),
      api_origin: "http://localhost:8000",
      account: testIdentity("ws-dev").account,
    };
    await new Cache(cacheDir).saveAnalysis(dev);
    const mock = new MockApi()
      .on("POST", /^\/v1\/forms\/analyze$/, () => accepted(JOB2, [1, 2]))
      .on("GET", new RegExp(`^/v1/jobs/${JOB2}\\?include=render$`), () =>
        jobAnswer(JOB2, "done", { pages: [1, 2], templateId: "tpl-prod" }),
      );
    const c = await server(mock);
    const plain = await c.call("analyze_form", { path: pdfPath });
    expect(plain.data).toMatchObject({ status: "done", cached: true, template_id: null });
    expect(mock.calls).toHaveLength(0);
    const saved = await c.call("analyze_form", { path: pdfPath, save_as_template: true });
    expect(saved.data).toMatchObject({ cached: false, job_id: JOB2, template_id: "tpl-prod" });
    expect(analyzePosts(mock)).toBe(1);
  });
});

describe("a pending job never wedges a file", () => {
  it("force drops a wedged job id and re-posts", async () => {
    const mock: MockApi = new MockApi()
      .on(
        "POST",
        /^\/v1\/forms\/analyze$/,
        (): Response => accepted(analyzePosts(mock) === 1 ? JOB : JOB2, [1, 2]),
      )
      .on("GET", new RegExp(`^/v1/jobs/${JOB}\\?`), () => apiError(500, "internal_error"))
      .on("GET", new RegExp(`^/v1/jobs/${JOB2}\\?`), () =>
        jobAnswer(JOB2, "done", { pages: [1, 2] }),
      );
    const c = await server(mock);
    expect((await c.call("analyze_form", { path: pdfPath })).data.error).toMatchObject({
      code: "internal_error",
    });
    const forced = await c.call("analyze_form", { path: pdfPath, force: true });
    expect(forced.data).toMatchObject({ status: "done", job_id: JOB2 });
    expect(analyzePosts(mock)).toBe(2);
    expect(pendingFiles()).toEqual([]);
  });

  it("drops a job after 3 non-retryable poll failures in a row, then starts afresh", async () => {
    const mock: MockApi = new MockApi()
      .on(
        "POST",
        /^\/v1\/forms\/analyze$/,
        (): Response => accepted(analyzePosts(mock) === 1 ? JOB : JOB2, [1, 2]),
      )
      .on("GET", new RegExp(`^/v1/jobs/${JOB}\\?`), () => apiError(500, "internal_error"))
      .on("GET", new RegExp(`^/v1/jobs/${JOB2}\\?`), () =>
        jobAnswer(JOB2, "done", { pages: [1, 2] }),
      );
    const c = await server(mock);
    for (const n of [1, 2]) {
      const r = await c.call("analyze_form", { path: pdfPath });
      expect(r.data.error).toMatchObject({ code: "internal_error" });
      expect(readPendingFiles()).toEqual([
        expect.objectContaining({ job_id: JOB, poll_errors: n }),
      ]);
    }
    const third = await c.call("analyze_form", { path: pdfPath });
    expect(third.data.error).toMatchObject({ code: "internal_error", job_id: JOB });
    expect(String((third.data.error as { hint: string }).hint)).toMatch(/dropped/);
    expect(pendingFiles()).toEqual([]);
    expect(analyzePosts(mock)).toBe(1);
    const fresh = await c.call("analyze_form", { path: pdfPath });
    expect(fresh.data).toMatchObject({ status: "done", job_id: JOB2 });
    expect(analyzePosts(mock)).toBe(2);
  });

  it("a successful poll resets the failure count; network errors never count", async () => {
    const answers = [
      () => apiError(500, "internal_error"),
      () => ECONNRESET() as unknown as Response,
      () => apiError(500, "internal_error"),
      () => jobAnswer(JOB, "running", { pages: [1, 2] }),
      () => apiError(500, "internal_error"),
      () => apiError(500, "internal_error"),
    ];
    const mock = new MockApi()
      .on("POST", /^\/v1\/forms\/analyze$/, () => accepted(JOB, [1, 2]))
      .on("GET", new RegExp(`^/v1/jobs/${JOB}\\?`), () => answers.shift()!());
    const c = await server(mock, { FENFILL_ANALYZE_WAIT_SECONDS: "2" });
    for (let i = 0; i < 6; i++) await c.call("analyze_form", { path: pdfPath });
    expect(readPendingFiles()).toEqual([expect.objectContaining({ job_id: JOB, poll_errors: 2 })]);
  });

  it("a frozen template while polling is terminal", async () => {
    const mock = new MockApi()
      .on("POST", /^\/v1\/forms\/analyze$/, () => accepted(JOB, [1, 2]))
      .on("GET", /^\/v1\/jobs\//, () => apiError(403, "template_frozen"));
    const r = await (
      await server(mock)
    ).call("analyze_form", {
      path: pdfPath,
      save_as_template: true,
    });
    expect(r.data.error).toMatchObject({ code: "template_frozen" });
    expect(String((r.data.error as { hint: string }).hint)).toMatch(/list_templates/);
    expect(pendingFiles()).toEqual([]);
  });

  it("a pending job older than 24 h is dropped (its result is gone)", async () => {
    const clock = virtualClock();
    await seedPending({
      job_id: "dead0000-0000-4000-8000-000000000009",
      created_at: new Date(clock.now() - 25 * 60 * 60 * 1000).toISOString(),
      pages: [1, 2],
    });
    const mock = new MockApi().analyzeFlow({ jobId: JOB, render, agent, pages: [1, 2] });
    const r = await (await server(mock, {}, clock)).call("analyze_form", { path: pdfPath });
    expect(r.data).toMatchObject({ status: "done", job_id: JOB });
    expect(mock.count("GET", /^\/v1\/jobs\/dead/)).toBe(0);
    expect(pendingFiles()).toEqual([]);
  });

  it("a plain call resumes a forced re-analysis instead of serving the cache it replaces", async () => {
    let finished = false;
    const mock: MockApi = new MockApi()
      .on(
        "POST",
        /^\/v1\/forms\/analyze$/,
        (): Response => accepted(analyzePosts(mock) === 1 ? JOB : JOB2, [1, 2]),
      )
      .on("GET", new RegExp(`^/v1/jobs/${JOB}\\?`), () => jobAnswer(JOB, "done", { pages: [1, 2] }))
      .on("GET", new RegExp(`^/v1/jobs/${JOB2}\\?`), () =>
        jobAnswer(JOB2, finished ? "done" : "running", { pages: [1, 2] }),
      );
    const c = await server(mock, { FENFILL_ANALYZE_WAIT_SECONDS: "5" });
    expect((await c.call("analyze_form", { path: pdfPath })).data.job_id).toBe(JOB);
    const forced = await c.call("analyze_form", { path: pdfPath, force: true });
    expect(forced.data).toMatchObject({ status: "running", job_id: JOB2 });
    expect(String(forced.data.next)).toMatch(/WITHOUT force/);
    const plain = await c.call("analyze_form", { path: pdfPath });
    expect(plain.data).toMatchObject({ status: "running", job_id: JOB2 });
    finished = true;
    const done = await c.call("analyze_form", { path: pdfPath });
    expect(done.data).toMatchObject({ status: "done", cached: false, job_id: JOB2 });
    expect(analyzePosts(mock)).toBe(2);
  });
});

describe("lock bookkeeping (L4, L5)", () => {
  it("two processes taking over one stale lock POST once (compare-and-delete)", async () => {
    const who = testIdentity();
    const options: AnalyzeOptions = { pages: null, save_as_template: false };
    const sha = sha256Hex(pdfBytes);
    const long = new Date(Date.now() - 11 * 60_000).toISOString();
    await new Cache(cacheDir).updatePending(
      {
        v: 1,
        sha256: sha,
        options,
        created_at: long,
        pid: process.pid,
        owner: "dead",
        unknown_outcome: true,
        failed_at: long,
        ...who,
      },
      optionsHash(options, who),
    );
    let posts = 0;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      if (init.method === "POST") {
        posts++;
        await delay(100);
        return accepted(`00000000-0000-4000-8000-00000000000${String(posts)}`, [1, 2]);
      }
      if (/\/account$/.test(_url)) return apiError(404, "not_found");
      return jobAnswer("x", "running", { pages: [1, 2] });
    }) as typeof fetch;
    // Barrier: both "processes" judged the stale lock before either removes it.
    let arrived = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const owners: string[] = [];
    const mkDeps = (owner: string, first: boolean) => {
      const cache = new Cache(cacheDir);
      const orig = cache.removePending.bind(cache);
      let used = false;
      cache.removePending = async (...a: Parameters<Cache["removePending"]>) => {
        if (!used) {
          used = true;
          arrived++;
          if (arrived === 2) open();
          await gate;
          if (!first) await delay(50);
        }
        return orig(...a);
      };
      LIVE_OWNERS.add(owner);
      owners.push(owner);
      return {
        cache,
        api: () => new FenfillApi({ apiKey: API_KEY, apiUrl: API_URL }, { fetchImpl }),
        identity: () => Promise.resolve(who),
        now: Date.now,
        sleep: async (ms: number) => delay(Math.min(ms, 5)),
        waitSeconds: 2,
        inFlight: new Map(),
        posts: new Set<Promise<unknown>>(),
        owner,
      };
    };
    const ctx = { signal: new AbortController().signal };
    try {
      const results = await Promise.all([
        analyzeForm(mkDeps("race-A", true), { path: pdfPath }, ctx).catch((e: unknown) => e),
        analyzeForm(mkDeps("race-B", false), { path: pdfPath }, ctx).catch((e: unknown) => e),
      ]);
      await delay(200);
      expect(posts).toBe(1);
      for (const r of results) expect(r).toMatchObject({ status: "running" });
    } finally {
      for (const o of owners) LIVE_OWNERS.delete(o);
    }
  });

  it("the unknown-outcome lockout runs 10 minutes from the failure, not from the lock", async () => {
    const clock = virtualClock();
    let n = 0;
    const mock = new MockApi();
    mock.on("POST", /^\/v1\/forms\/analyze$/, () => {
      n++;
      if (n === 1) {
        clock.advance(9 * 60 * 1000); // a slow upload that then breaks
        return ECONNRESET();
      }
      return accepted(JOB2, [1, 2]);
    });
    mock.analyzeFlow({ jobId: JOB2, render, agent, pages: [1, 2] });
    const c = await server(mock, {}, clock);
    expect((await c.call("analyze_form", { path: pdfPath })).data.error).toMatchObject({
      code: "upload_outcome_unknown",
    });
    clock.advance(2 * 60 * 1000); // 11 min after the lock, 2 after the failure
    expect((await c.call("analyze_form", { path: pdfPath })).data.error).toMatchObject({
      code: "upload_outcome_unknown",
    });
    expect(n).toBe(1);
    clock.advance(9 * 60 * 1000);
    expect((await c.call("analyze_form", { path: pdfPath })).data).toMatchObject({
      status: "done",
      job_id: JOB2,
    });
    expect(n).toBe(2);
  });
});

describe("saved analyses and the view fill_form fills (L7, L8)", () => {
  it("a later unsaved analysis of the same pages never overwrites a saved one", async () => {
    const mock = new MockApi()
      .on("POST", /^\/v1\/forms\/analyze$/, (req) =>
        accepted(req.body.includes("save_as_template=true") ? JOB2 : JOB, [1, 2]),
      )
      .analyzeFlow({ jobId: JOB2, render, agent, pages: [1, 2], templateId: "tpl-9" })
      .analyzeFlow({ jobId: JOB, render, agent, pages: [1, 2] });
    const c = await server(mock);
    await c.call("analyze_form", { path: pdfPath, save_as_template: true });
    await c.call("analyze_form", { path: pdfPath, force: true });
    expect(analyzePosts(mock)).toBe(2);
    const again = await c.call("analyze_form", { path: pdfPath, save_as_template: true });
    expect(again.data).toMatchObject({ cached: true, cost: 0, template_id: "tpl-9" });
    expect(analyzePosts(mock)).toBe(2);
  });

  it("after a template view, fill_form fills exactly the ids that view showed", async () => {
    const S = reId(render, agent, "S");
    const N = reId(render, agent, "N");
    const mock = new MockApi()
      .on("POST", /^\/v1\/forms\/analyze$/, (req) =>
        accepted(req.body.includes("save_as_template=true") ? JOB2 : JOB, [1, 2]),
      )
      .analyzeFlow({ jobId: JOB2, ...S, pages: [1, 2], templateId: "tpl-9" })
      .analyzeFlow({ jobId: JOB, ...N, pages: [1, 2] });
    const clock = virtualClock();
    const c = await server(mock, {}, clock);
    await c.call("analyze_form", { path: pdfPath, save_as_template: true });
    clock.advance(1000);
    const plain = await c.call("analyze_form", { path: pdfPath, force: true });
    expect(viewIds(plain.data).every((id) => id.startsWith("N-"))).toBe(true);
    clock.advance(1000);
    const tplView = await c.call("analyze_form", { path: pdfPath, save_as_template: true });
    expect(tplView.data).toMatchObject({ cached: true, template_id: "tpl-9" });
    const shown = viewIds(tplView.data);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((id) => id.startsWith("S-"))).toBe(true);

    const nameId = S.agent.fields.find((e) => e.label === "Full name")!.id;
    const filled = await c.call("fill_form", {
      path: pdfPath,
      values: { [nameId]: "Ada" },
      output_path: join(t.dir, "tpl-view.pdf"),
    });
    expect(filled.data).toMatchObject({ filled: 1, skipped: [] });
    // …and a plain cached view now agrees with it.
    const after = await c.call("analyze_form", { path: pdfPath });
    expect(viewIds(after.data).every((id) => id.startsWith("S-"))).toBe(true);
  });
});

describe("progress notifications (L15)", () => {
  it("are never sent without a progressToken", async () => {
    const methods: string[] = [];
    const tap = (m: unknown) => {
      const method = (m as { method?: unknown }).method;
      if (typeof method === "string") methods.push(method);
    };
    const flow = () =>
      new MockApi().analyzeFlow({ jobId: JOB, render, agent, pages: [1, 2], states: ["running"] });
    const clock = virtualClock();
    const quiet = await connect({ env: env(cacheDir), fetchImpl: flow().fetch, ...clock, tap });
    open.push(quiet);
    expect((await quiet.call("analyze_form", { path: pdfPath })).data.status).toBe("done");
    expect(methods).not.toContain("notifications/progress");

    // Control: with a token, the same flow does report progress.
    const other = join(t.dir, "cache2");
    const loud = await connect({ env: env(other), fetchImpl: flow().fetch, ...clock, tap });
    open.push(loud);
    await loud.call("analyze_form", { path: pdfPath }, { onprogress: () => undefined });
    expect(methods).toContain("notifications/progress");
  });
});

// API test keys (ff_test_) over the MCP client, against a mocked /v1:
// list_sample_forms, the sample analyze that is done at once, the test-mode
// refusals and their hints, the wording the model reads, and test and live
// analyses of one workspace kept apart in the local cache.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { jobCovers } from "../src/analyze.js";
import { sameAccount, sha256Hex } from "../src/cache.js";
import { pageText } from "../src/render.js";
import { SAMPLE_SLACK_BYTES, samplePath } from "../src/samples.js";
import { SAMPLE_PATH_NOTE, TEST_MODE_LINE, TEST_MODE_NOTE, TOOL_NAMES } from "../src/server.js";
import type { RenderSchema } from "../src/types.js";
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
  rerunFlow,
  tmp,
  virtualClock,
} from "./helpers.js";

const TEST_KEY = `ff_test_${"t".repeat(43)}`;
const JOB = "51111111-2222-4333-8444-555555555555";
const LIVE_JOB = "61111111-2222-4333-8444-555555555555";
const RJOB = "99999999-2222-4333-8444-555555555555";
const TEST_TPL = "7f1b953e-0fe9-5154-84f2-285d8aff38f5";
const LIVE_TPL = "3f1b953e-0fe9-5154-84f2-285d8aff38f5";
const MARK = "TEST · fenfill test key";

const raw = fixture("ungrouped_fields");
const render: RenderSchema = {
  ...raw.render,
  fields: raw.render.fields.filter((f) => f.type !== "note"),
};
const agent = raw.agent;
const nameId = agent.fields.find((e) => e.label === "Full name")!.id;

const ACCOUNT = {
  workspace_id: "ws-1",
  tier: "free",
  scans_remaining: 0,
  max_pages: 10,
  max_pages_per_job: 10,
  max_file_mb: 10,
  branding: { logo: false, watermark: false },
};

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

/** A server on `key` (default: the test key), with sleeps counted. */
async function server(mock: MockApi, key = TEST_KEY, fetchImpl: typeof fetch = mock.fetch) {
  const clock = virtualClock();
  const sleeps: number[] = [];
  const c = await connect({
    env: env(cacheDir, { FENFILL_API_KEY: key }),
    fetchImpl,
    now: clock.now,
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      await clock.sleep(ms, signal);
    },
  });
  open.push(c);
  return { c, sleeps };
}

/** /v1/account as fenfill answers it for a key of `mode`. */
const account = (mode: "live" | "test") => () => json(200, { ...ACCOUNT, mode });

/** A test key's sample analyze: 202 already done (mode sample, cost 0), then the job. */
function sampleFlow(mock: MockApi, opts: { jobId?: string; templateId?: string | null } = {}) {
  const jobId = opts.jobId ?? JOB;
  const templateId = opts.templateId ?? null;
  return mock
    .on("POST", /^\/v1\/forms\/analyze$/, () =>
      json(
        202,
        { job_id: jobId, status: "done", mode: "sample", pages: [1, 2], cost: 0 },
        { location: `/v1/jobs/${jobId}`, "fenfill-mode": "test" },
      ),
    )
    .on("GET", new RegExp(`^/v1/jobs/${jobId}\\?include=render$`), () =>
      json(200, {
        job_id: jobId,
        status: "done",
        mode: "sample",
        phase: "done",
        progress: 100,
        pages: [1, 2],
        cost: 0,
        created_at: "2026-11-06T00:00:00Z",
        template_id: templateId,
        error: null,
        result: { ...agent, template_id: templateId },
        render,
      }),
    );
}

async function blankPdf(): Promise<{ path: string; bytes: Uint8Array }> {
  const bytes = await pdfFor(render);
  const path = join(t.dir, "sample.pdf");
  writeFileSync(path, bytes);
  return { path, bytes };
}

/** How many times each page prints the TEST mark, as PDFium reads the text. */
async function marksPerPage(pdf: Uint8Array): Promise<number[]> {
  const n = (await PDFDocument.load(pdf)).getPageCount();
  const out: number[] = [];
  for (let p = 1; p <= n; p++) {
    const { glyphs } = await pageText(pdf, p);
    const text = glyphs
      .map((g, k) => (k > 0 && g.i > glyphs[k - 1].i + 1 ? " " : "") + g.char)
      .join("");
    out.push(text.split(MARK).length - 1);
  }
  return out;
}

describe("list_sample_forms", () => {
  it("GETs /v1/samples with nothing but the key, and returns the list", async () => {
    const samples = [
      {
        slug: "us-irs-w-9",
        title: "Request for Taxpayer Identification Number and Certification",
        issuer: "IRS",
        form_code: "W-9",
        pages: 6,
        field_count: 23,
        sha256: "a".repeat(64),
        bytes: 140_000,
        pdf_url: "https://fenfill.com/forms/us-irs-w-9.pdf",
      },
    ];
    const mock = new MockApi().on("GET", /^\/v1\/samples$/, () => json(200, { samples }));
    const { c } = await server(mock);
    const r = await c.call("list_sample_forms", {});
    expect(r).toEqual({ isError: false, data: { samples } });
    expect(mock.calls).toHaveLength(1);
    const [call] = mock.calls;
    expect(call.method).toBe("GET");
    expect(new URL(call.url).pathname).toBe("/v1/samples");
    expect(new URL(call.url).search).toBe("");
    expect(call.body).toBe("");

    const { tools } = await c.client.listTools();
    const tool = tools.find((x) => x.name === "list_sample_forms")!;
    expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(["download"]);
    expect(tool.inputSchema.required ?? []).toEqual([]);
    expect(tool.annotations).toMatchObject({ readOnlyHint: true });
    expect(tool.description).toMatch(/pdf_url/);
    expect(tool.description).toMatch(/unchanged/);
    expect(tool.description).toMatch(/sha256/);
  });

  it("works with a live key too", async () => {
    const mock = new MockApi().on("GET", /^\/v1\/samples$/, () => json(200, { samples: [] }));
    const { c } = await server(mock, API_KEY);
    expect(await c.call("list_sample_forms", {})).toEqual({
      isError: false,
      data: { samples: [] },
    });
  });
});

describe("list_sample_forms with download", () => {
  const PDF_URL = "https://fenfill.com/forms/ss-4/23d295529950.pdf";
  const PDF_PATH = /^\/forms\/ss-4\/23d295529950\.pdf$/;

  /** The listing entry fenfill gives for `pdf` (overrides on top). */
  const entryFor = (pdf: Uint8Array, over: Record<string, unknown> = {}) => ({
    slug: "ss-4",
    title: "Application for Employer Identification Number",
    issuer: "IRS",
    form_code: "SS-4",
    pages: 2,
    field_count: 12,
    sha256: sha256Hex(pdf),
    bytes: pdf.byteLength,
    pdf_url: PDF_URL,
    ...over,
  });

  /** /v1/samples lists `entry`; its PDF answers with `pdf()`. */
  const samplesMock = (entry: Record<string, unknown>, pdf: () => Response) =>
    new MockApi()
      .on("GET", /^\/v1\/samples$/, () => json(200, { samples: [entry] }))
      .on("GET", PDF_PATH, pdf);

  const pdfResponse = (bytes: Uint8Array) => () =>
    new Response(new Uint8Array(bytes), { headers: { "content-type": "application/pdf" } });
  const pdfCalls = (mock: MockApi) =>
    mock.calls.filter((x) => PDF_PATH.test(new URL(x.url).pathname));
  const saved = () => {
    const d = join(cacheDir, "samples");
    return existsSync(d) ? readdirSync(d) : [];
  };

  it("saves the sample's PDF in the cache, hash-checked, fetched without the API key", async () => {
    const bytes = await pdfFor(render);
    const entry = entryFor(bytes);
    const mock = samplesMock(entry, pdfResponse(bytes));
    const inits: RequestInit[] = [];
    const fetchImpl = ((input: string, init?: RequestInit) => {
      if (String(input) === PDF_URL) inits.push(init ?? {});
      return mock.fetch(input, init);
    }) as typeof fetch;
    const { c } = await server(mock, TEST_KEY, fetchImpl);

    const r = await c.call("list_sample_forms", { download: "ss-4" });
    const path = join(cacheDir, "samples", `ss-4-${entry.sha256.slice(0, 12)}.pdf`);
    expect(samplePath(cacheDir, entry)).toBe(path);
    expect(r).toEqual({
      isError: false,
      data: { sample: entry, path, cached: false, note: SAMPLE_PATH_NOTE },
    });
    expect(SAMPLE_PATH_NOTE).toMatch(/analyze_form unchanged/);
    expect(new Uint8Array(readFileSync(path))).toEqual(new Uint8Array(bytes));
    expect(saved()).toEqual([basename(path)]); // no temp file left behind

    // The /v1 list carries the key; the PDF is a bare GET of the listed URL without it.
    expect(mock.calls).toHaveLength(2);
    const [list, pdf] = mock.calls;
    expect(new URL(list.url).pathname).toBe("/v1/samples");
    expect(list.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(pdf.url).toBe(PDF_URL);
    expect(pdf.method).toBe("GET");
    expect(pdf.body).toBe("");
    expect(Object.keys(pdf.headers).sort()).toEqual(["accept", "user-agent"]);
    expect(JSON.stringify(pdf.headers)).not.toContain(TEST_KEY);
    expect(inits).toHaveLength(1);
    expect(inits[0].redirect).toBe("error");

    // The path goes to analyze_form as is: the very bytes are uploaded.
    sampleFlow(mock).on("GET", /^\/v1\/account$/, account("test"));
    const a = await c.call("analyze_form", { path });
    expect(a.data).toMatchObject({ status: "done", mode: "sample" });
    const post = mock.calls.find((x) => x.method === "POST")!;
    expect(post.body).toContain(Buffer.from(bytes).toString("latin1"));
  });

  it("reuses a verified file without fetching it again, and replaces a changed one", async () => {
    const bytes = await pdfFor(render);
    const entry = entryFor(bytes);
    const mock = samplesMock(entry, pdfResponse(bytes));
    const { c } = await server(mock);
    const first = await c.call("list_sample_forms", { download: "ss-4" });
    expect(first.data.cached).toBe(false);
    const path = first.data.path as string;

    const again = await c.call("list_sample_forms", { download: "ss-4" });
    expect(again.data).toMatchObject({ path, cached: true });
    expect(pdfCalls(mock)).toHaveLength(1);
    expect(mock.count("GET", /^\/v1\/samples$/)).toBe(2);

    // A copy that no longer matches (opened and saved again) is fetched afresh.
    writeFileSync(path, "%PDF-1.7 not the sample");
    const fresh = await c.call("list_sample_forms", { download: "ss-4" });
    expect(fresh.data).toMatchObject({ path, cached: false });
    expect(pdfCalls(mock)).toHaveLength(2);
    expect(new Uint8Array(readFileSync(path))).toEqual(new Uint8Array(bytes));
  });

  it("refuses a file whose sha256 isn't the listed one, saving nothing", async () => {
    const bytes = await pdfFor(render);
    const other = new Uint8Array(bytes);
    other[other.length - 8] ^= 1; // same size, one bit off
    const mock = samplesMock(entryFor(bytes), pdfResponse(other));
    const { c } = await server(mock);
    const r = await c.call("list_sample_forms", { download: "ss-4" });
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatchObject({ code: "sample_hash_mismatch" });
    expect((r.data.error as { hint: string }).hint).toMatch(/list_sample_forms/);
    expect(pdfCalls(mock)).toHaveLength(1);
    expect(saved()).toEqual([]);
  });

  it("an unknown slug is refused with a pointer to the list, and nothing is fetched", async () => {
    const bytes = await pdfFor(render);
    const mock = samplesMock(entryFor(bytes), pdfResponse(bytes));
    const { c } = await server(mock);
    const r = await c.call("list_sample_forms", { download: "w-9" });
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatchObject({ code: "sample_not_found" });
    expect((r.data.error as { hint: string }).hint).toMatch(/list_sample_forms without arguments/);
    expect(pdfCalls(mock)).toHaveLength(0);
    expect(saved()).toEqual([]);
  });

  it("refuses a download that ends on another origin, and a pdf_url that isn't https", async () => {
    const bytes = await pdfFor(render);
    // A fetch that ended elsewhere (as a followed redirect would): refused.
    const moved = samplesMock(entryFor(bytes), () => {
      const res = pdfResponse(bytes)();
      Object.defineProperty(res, "url", { value: "https://cdn.elsewhere.example/ss-4.pdf" });
      return res;
    });
    const { c } = await server(moved);
    const r = await c.call("list_sample_forms", { download: "ss-4" });
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatchObject({ code: "sample_download_refused" });
    expect((r.data.error as { message: string }).message).toContain("https://fenfill.com");
    expect(saved()).toEqual([]);

    // A listed plain-http URL off localhost is never requested.
    const plain = new MockApi().on("GET", /^\/v1\/samples$/, () =>
      json(200, {
        samples: [entryFor(bytes, { pdf_url: PDF_URL.replace("https:", "http:") })],
      }),
    );
    const { c: c2 } = await server(plain);
    const r2 = await c2.call("list_sample_forms", { download: "ss-4" });
    expect(r2.data.error).toMatchObject({ code: "sample_download_refused" });
    expect(plain.calls).toHaveLength(1);
    expect(saved()).toEqual([]);
  });

  it("stops a download that runs past the listed size, saving nothing", async () => {
    const bytes = await pdfFor(render);
    const entry = entryFor(bytes);
    // An endless body: the cap stops reading it.
    let pulled = 0;
    const endless = samplesMock(
      entry,
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(ctl) {
              pulled += 1;
              ctl.enqueue(new Uint8Array(16 * 1024));
            },
          }),
        ),
    );
    const { c } = await server(endless);
    const r = await c.call("list_sample_forms", { download: "ss-4" });
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatchObject({ code: "sample_too_large" });
    expect(pulled).toBeLessThan(5);
    expect(saved()).toEqual([]);

    // A Content-Length past the cap is refused before the body is read.
    const over = entry.bytes + SAMPLE_SLACK_BYTES + 1;
    const declared = samplesMock(
      entry,
      () =>
        new Response(new Uint8Array(over), {
          headers: { "content-type": "application/pdf", "content-length": String(over) },
        }),
    );
    const { c: c2 } = await server(declared);
    const r2 = await c2.call("list_sample_forms", { download: "ss-4" });
    expect(r2.data.error).toMatchObject({ code: "sample_too_large" });
    expect(saved()).toEqual([]);
  });
});

describe("a sample form analyzed with a test key", () => {
  it("is done at once: one POST, one GET of the job, no waiting, cost 0", async () => {
    const { path } = await blankPdf();
    const mock = sampleFlow(new MockApi()).on("GET", /^\/v1\/account$/, account("test"));
    const { c, sleeps } = await server(mock);
    const progress: number[] = [];
    const r = await c.call(
      "analyze_form",
      { path },
      { onprogress: (p) => progress.push(p.progress) },
    );
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({
      status: "done",
      cached: false,
      job_id: JOB,
      mode: "sample",
      cost: 0,
      template_id: null,
      analyzed_pages: "1-2",
    });
    expect(r.data).not.toHaveProperty("extra_blanks_note");
    expect(sleeps).toEqual([]);
    expect(progress).toEqual([]);
    expect(mock.count("POST", /^\/v1\/forms\/analyze$/)).toBe(1);
    expect(mock.count("GET", new RegExp(`^/v1/jobs/${JOB}$`))).toBe(1);

    // Cached whole: any page, and detect_extra_blanks, are free from now on.
    for (const args of [{}, { pages: "2" }, { detect_extra_blanks: true }]) {
      const again = await c.call("analyze_form", { path, ...args });
      expect(again.data, JSON.stringify(args)).toMatchObject({
        status: "done",
        cached: true,
        cost: 0,
      });
    }
    expect(mock.count("POST", /^\/v1\/forms\/analyze$/)).toBe(1);

    // fill_form fills it, with the TEST mark on every page.
    const out = join(t.dir, "filled.pdf");
    const fill = await c.call("fill_form", {
      path,
      values: { [nameId]: "Ada Lovelace" },
      output_path: out,
    });
    expect(fill.isError).toBe(false);
    expect(fill.data.filled).toBe(1);
    const pdf = new Uint8Array(readFileSync(out));
    expect(await marksPerPage(pdf)).toEqual([1, 1]);
  });

  it("saved as a template: fill_template-ready id, no waiting", async () => {
    const { path } = await blankPdf();
    const mock = sampleFlow(new MockApi(), { templateId: TEST_TPL }).on(
      "GET",
      /^\/v1\/account$/,
      account("test"),
    );
    const { c, sleeps } = await server(mock);
    const r = await c.call("analyze_form", { path, save_as_template: true });
    expect(r.data).toMatchObject({
      status: "done",
      mode: "sample",
      cost: 0,
      template_id: TEST_TPL,
    });
    expect(r.data).not.toHaveProperty("save_note");
    expect(sleeps).toEqual([]);
    // The POST asked for a save and sent no access (a test template is restricted).
    const post = mock.calls.find((x) => x.method === "POST")!;
    expect(post.body).toContain("save_as_template=true");
    expect(post.body).not.toContain("access=");
  });

  it("a pending sample job covers any pages, and detect_extra_blanks", () => {
    const job = {
      options: { pages: "1", save_as_template: false },
      pages: [1, 2],
      mode: "sample",
    };
    const want = (pages: string | null, extra: boolean) => ({
      options: {
        pages,
        save_as_template: false,
        ...(extra ? { detect_extra_blanks: true as const } : {}),
      },
      requested: pages === null ? null : [Number(pages)],
      pageCount: 2,
    });
    expect(jobCovers(job, want(null, false))).toBe(true);
    expect(jobCovers(job, want("2", false))).toBe(true);
    expect(jobCovers(job, want("2", true))).toBe(true);
    // An AcroForm job still doesn't cover extra blanks it never looked for.
    expect(jobCovers({ ...job, mode: "acroform" }, want("2", true))).toBe(false);
  });

  it("estimate: no scans, nothing sent, and the file's sha256 to match", async () => {
    const { path, bytes } = await blankPdf();
    const mock = new MockApi();
    const { c } = await server(mock);
    const r = await c.call("analyze_form", { path, estimate: true });
    expect(r.data).toMatchObject({
      status: "estimate",
      page_count: 2,
      pages: "1-2",
      likely_mode: "sample",
      estimated_scans: 0,
      scans_remaining: null,
      sha256: sha256Hex(bytes),
    });
    expect(String(r.data.note)).toMatch(/no page scans/);
    expect(String(r.data.note)).not.toMatch(/scans are left|unknown/);
    expect(mock.calls).toEqual([]);
  });
});

describe("test-mode refusals carry their hints", () => {
  it("test_mode_sample_only: list_sample_forms, and a live key on Pro or Business", async () => {
    const { path } = await blankPdf();
    const mock = new MockApi()
      .on("GET", /^\/v1\/account$/, account("test"))
      .on("POST", /^\/v1\/forms\/analyze$/, () =>
        apiError(403, "test_mode_sample_only", {
          message:
            "Test keys work with fenfill's sample forms. List them with GET /v1/samples. To analyse your own forms, use a live key on Pro or Business.",
        }),
      );
    const { c } = await server(mock);
    const r = await c.call("analyze_form", { path });
    expect(r.isError).toBe(true);
    const err = r.data.error as Record<string, unknown>;
    expect(err.code).toBe("test_mode_sample_only");
    expect(err.message).toMatch(/sample forms/);
    expect(err.hint).toMatch(/list_sample_forms/);
    expect(err.hint).toMatch(/pdf_url/);
    expect(err.hint).toMatch(/live key \(ff_live_\) on Pro or Business/);
    // Refused before any job existed: the next call may upload again at once.
    const again = await c.call("analyze_form", { path });
    expect((again.data.error as Record<string, unknown>).code).toBe("test_mode_sample_only");
    expect(mock.count("POST", /^\/v1\/forms\/analyze$/)).toBe(2);
  });

  it("test_mode_no_links on create_recipient_link", async () => {
    const mock = new MockApi().on(
      "POST",
      new RegExp(`^/v1/templates/${TEST_TPL}/recipients$`),
      () => apiError(403, "test_mode_no_links"),
    );
    const { c } = await server(mock);
    const r = await c.call("create_recipient_link", { template_id: TEST_TPL, label: "Client" });
    const err = r.data.error as Record<string, unknown>;
    expect(err.code).toBe("test_mode_no_links");
    expect(err.hint).toMatch(/can't create links/);
    expect(err.hint).toMatch(/fill_form or fill_template/);
    expect(err.hint).toMatch(/live key \(ff_live_\) on Pro or Business/);
  });

  it("test_mode_not_available on reanalyze_template, and on an estimate", async () => {
    const mock = new MockApi().on("GET", /^\/v1\/account$/, account("test"));
    const flow = rerunFlow(mock, {
      templateId: TEST_TPL,
      jobId: RJOB,
      before: { render, agent },
      after: { render, agent },
      v1: "2026-11-06T00:00:00Z",
      v2: "2026-11-06T00:01:00Z",
      pages: [2],
      refuse: () => apiError(403, "test_mode_not_available"),
    });
    const { c } = await server(mock);
    for (const extra of [{}, { estimate: true }]) {
      const r = await c.call("reanalyze_template", {
        template_id: TEST_TPL,
        pages: "2",
        kind: "find",
        ...extra,
      });
      const err = r.data.error as Record<string, unknown>;
      expect(err.code, JSON.stringify(extra)).toBe("test_mode_not_available");
      expect(err.hint).toMatch(/reanalyze_template isn't available with a test key/);
      expect(err.hint).toMatch(/edit_template \+ save_template/);
      expect(err.hint).toMatch(/live key \(ff_live_\) on Pro or Business/);
    }
    expect(flow.posts).toHaveLength(2);
    expect(flow.done()).toBe(false);
  });
});

describe("what the model reads", () => {
  const CHANGED = ["analyze_form", "fill_form", "fill_template", "make_fillable", "get_account"];

  async function listing(key: string | null) {
    const e = env(cacheDir);
    if (key === null) delete (e as Record<string, string | undefined>).FENFILL_API_KEY;
    else e.FENFILL_API_KEY = key;
    const c = await connect({ env: e, fetchImpl: new MockApi().fetch });
    open.push(c);
    const { tools } = await c.client.listTools();
    return {
      instructions: c.client.getInstructions() ?? "",
      byName: Object.fromEntries(tools.map((x) => [x.name, x.description ?? ""])),
    };
  }

  it("a live key's text is unchanged; a test key adds one line to five tools", async () => {
    const live = await listing(API_KEY);
    const test = await listing(TEST_KEY);
    const none = await listing(null);
    expect(Object.keys(live.byName).sort()).toEqual([...TOOL_NAMES].sort());
    expect(none).toEqual(live);

    // Live: no test-mode wording anywhere but list_sample_forms' own description.
    expect(live.instructions).not.toContain(TEST_MODE_LINE);
    expect(live.instructions).not.toMatch(/ff_test_|test key/);
    for (const [name, d] of Object.entries(live.byName)) {
      expect(d, name).not.toContain(TEST_MODE_LINE);
      if (name !== "list_sample_forms") expect(d, name).not.toMatch(/ff_test_|test key/);
    }

    // Test: exactly the live text plus the line (make_fillable: plus its plan note).
    expect(test.instructions).toBe(`${live.instructions} ${TEST_MODE_LINE}`);
    for (const name of TOOL_NAMES) {
      const want = CHANGED.includes(name)
        ? `${live.byName[name]} ${TEST_MODE_LINE}${name === "make_fillable" ? " With a test key, make_fillable works on any plan." : ""}`
        : live.byName[name];
      expect(test.byName[name], name).toBe(want);
      expect(test.byName[name].length, name).toBeLessThan(1500);
    }
    expect(TEST_MODE_LINE).toMatch(/list_sample_forms/);
    expect(TEST_MODE_LINE).toMatch(/TEST mark/);
    expect(TEST_MODE_LINE).toMatch(/recipient links can't be created/);
    expect(TEST_MODE_LINE).toMatch(/live key \(ff_live_\) on Pro or Business/);
    expect(TEST_MODE_LINE).not.toMatch(/\bfree\b|\bAI\b/i);
  });

  it("get_account adds test_mode_note when fenfill says the key is a test key", async () => {
    const mock = new MockApi().on("GET", /^\/v1\/account$/, account("test"));
    const { c } = await server(mock);
    const r = await c.call("get_account", {});
    expect(r).toEqual({
      isError: false,
      data: { ...ACCOUNT, mode: "test", test_mode_note: TEST_MODE_NOTE },
    });
    expect(TEST_MODE_NOTE).not.toMatch(/\.\s\S/); // one sentence
  });

  it("get_account with a live key is fenfill's answer as is", async () => {
    const mock = new MockApi().on("GET", /^\/v1\/account$/, account("live"));
    const { c } = await server(mock, API_KEY);
    const r = await c.call("get_account", {});
    expect(r).toEqual({ isError: false, data: { ...ACCOUNT, mode: "live" } });
  });
});

describe("test and live keys of one workspace never share templates or jobs", () => {
  it("sameAccount tells test from live, even with the same workspace id", () => {
    const live = { api_origin: API_URL, account: { workspace_id: "ws-1", key_sha: "kl" } };
    const test = {
      api_origin: API_URL,
      account: { workspace_id: "ws-1", key_sha: "kt", mode: "test" as const },
    };
    const test2 = { ...test, account: { ...test.account, key_sha: "kt2" } };
    expect(sameAccount(live, live)).toBe(true);
    expect(sameAccount(test, test2)).toBe(true); // a rotated test key
    expect(sameAccount(live, test)).toBe(false);
    expect(sameAccount(test, live)).toBe(false);
    // Without workspace ids, the key hash already differs; the mode still decides.
    const bare = { api_origin: API_URL, account: { workspace_id: null, key_sha: "kt" } };
    expect(sameAccount(bare, test)).toBe(false);
  });

  it("a live template of the same form is never shown to a test key, nor the reverse", async () => {
    const { path } = await blankPdf();
    // A live key analyzes and saves the form first.
    const liveMock = new MockApi().on("GET", /^\/v1\/account$/, account("live")).analyzeFlow({
      jobId: LIVE_JOB,
      render,
      agent,
      pages: [1, 2],
      templateId: LIVE_TPL,
    });
    const { c: liveC } = await server(liveMock, API_KEY);
    const saved = await liveC.call("analyze_form", { path, save_as_template: true });
    expect(saved.data.template_id).toBe(LIVE_TPL);

    // The test key: the schema is shared (it describes the blank form), the
    // live template id is not.
    const testMock = sampleFlow(new MockApi(), { templateId: TEST_TPL }).on(
      "GET",
      /^\/v1\/account$/,
      account("test"),
    );
    const { c: testC } = await server(testMock);
    const unsaved = await testC.call("analyze_form", { path });
    expect(unsaved.data).toMatchObject({ status: "done", cached: true, template_id: null });
    const own = await testC.call("analyze_form", { path, save_as_template: true });
    expect(own.data).toMatchObject({ cached: false, mode: "sample", template_id: TEST_TPL });
    expect(testMock.count("POST", /^\/v1\/forms\/analyze$/)).toBe(1);

    // And back: the live key keeps seeing its own template, never the test one.
    const back = await liveC.call("analyze_form", { path, save_as_template: true });
    expect(back.data).toMatchObject({ cached: true, template_id: LIVE_TPL });
    expect(liveMock.count("POST", /^\/v1\/forms\/analyze$/)).toBe(1);
  });
});

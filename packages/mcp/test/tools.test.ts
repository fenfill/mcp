// preview_page, edit_template, save_template and detect_extra_blanks, end to
// end over the MCP client (mocked /v1).

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractStampedText } from "@/e2e/helpers/pdfText";

import type { RenderSchema } from "../src/types.js";
import {
  apiError,
  connect,
  type Connected,
  env,
  fixture,
  json,
  MockApi,
  pdfFor,
  tmp,
  virtualClock,
} from "./helpers.js";

const JOB = "11111111-2222-4333-8444-555555555555";
const TPL = "3f1b953e-0fe9-5154-84f2-285d8aff38f5";
const V1 = "2026-10-04T12:00:00.123456+00:00";
const V2 = "2026-10-04T12:05:00.000000+00:00";

let t: ReturnType<typeof tmp>;
let cacheDir: string;
const open: Connected[] = [];
// The fixture carries a legacy floating note (type "note"), which the server's
// validate_template refuses; a real saved template never has one.
const raw = fixture("ungrouped_fields");
const render: RenderSchema = {
  ...raw.render,
  fields: raw.render.fields.filter((f) => f.type !== "note"),
};
const agent = raw.agent;
const nameId = agent.fields.find((e) => e.label === "Full name")!.id;
const cityId = agent.fields.find((e) => e.label === "City")!.id;

beforeEach(() => {
  t = tmp();
  cacheDir = join(t.dir, "cache");
});
afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
  t.cleanup();
});

async function server(mock: MockApi | null) {
  const c = await connect({
    env: mock ? env(cacheDir) : { FENFILL_CACHE_DIR: cacheDir },
    fetchImpl: mock?.fetch ?? ((() => Promise.reject(new Error("no network"))) as typeof fetch),
    ...virtualClock(),
  });
  open.push(c);
  return c;
}

function walk(d: string): string[] {
  let out: string[] = [];
  try {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      out = e.isDirectory() ? out.concat(walk(p)) : out.concat(p);
    }
  } catch {
    // missing dir
  }
  return out;
}

/** preview_page's raw result (image + JSON text). */
async function preview(c: Connected, args: Record<string, unknown>) {
  const r = await c.client.callTool({ name: "preview_page", arguments: args }, undefined, {
    timeout: 120_000,
  });
  const content = r.content as { type: string; text?: string; data?: string; mimeType?: string }[];
  return { isError: r.isError === true, content };
}

function pngDims(b64: string): { w: number; h: number; sig: boolean } {
  const b = Buffer.from(b64, "base64");
  return {
    sig: b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    w: b.readUInt32BE(16),
    h: b.readUInt32BE(20),
  };
}

/** A template mock: GET (+render, updated_at), PDF, account, PATCH via `patch`. */
function templateMock(
  tplPdf: Uint8Array,
  patch: (body: Record<string, unknown>) => Response = (body) =>
    json(200, {
      template_id: TPL,
      updated_at: V2,
      result: { ...agent, template_id: TPL, updated_at: V2 },
      echoed_fields: (body.schema as RenderSchema).fields.length,
    }),
) {
  let version = V1;
  const mock = new MockApi()
    .on("GET", new RegExp(`^/v1/templates/${TPL}\\?include=render$`), () =>
      json(200, { ...agent, template_id: TPL, updated_at: version, render }),
    )
    .on("GET", new RegExp(`^/v1/templates/${TPL}$`), () =>
      json(200, { ...agent, template_id: TPL, updated_at: version }),
    )
    .on("GET", new RegExp(`^/v1/templates/${TPL}/pdf$`), () => new Response(new Uint8Array(tplPdf)))
    .on("GET", /^\/v1\/account$/, () =>
      json(200, {
        workspace_id: "ws-1",
        tier: "team",
        scans_remaining: 5,
        max_pages: 100,
        max_pages_per_job: 60,
        max_file_mb: 50,
        branding: { logo: false, watermark: false },
      }),
    )
    .on("PATCH", new RegExp(`^/v1/templates/${TPL}$`), (req) => {
      const res = patch(JSON.parse(req.body) as Record<string, unknown>);
      if (res.status === 200) version = V2;
      return res;
    });
  return { mock, setVersion: (v: string) => (version = v) };
}

describe("preview_page", () => {
  it("renders a page of an analyzed file as a PNG + legend, offline, leaving no file", async () => {
    const pdfPath = join(t.dir, "form.pdf");
    writeFileSync(pdfPath, await pdfFor(render));
    const mock = new MockApi().analyzeFlow({ jobId: JOB, render, agent, pages: [1, 2] });
    const c = await server(mock);
    expect((await c.call("analyze_form", { path: pdfPath })).data.status).toBe("done");
    const before = mock.calls.length;
    const filesBefore = walk(t.dir).sort();

    const r = await preview(c, { path: pdfPath, page: 1, values: { [nameId]: "Ada" }, dpi: 72 });
    expect(r.isError).toBe(false);
    expect(r.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    const d = pngDims(r.content[0].data!);
    expect(d.sig).toBe(true);
    expect([d.w, d.h]).toEqual([1240, 1754]); // the fixture's page, 1 px per pt at 72 dpi
    const meta = JSON.parse(r.content[1].text!) as {
      legend: { id: string; tag: string; label: string; box: { x: number } }[];
      filled: number;
      edited: boolean;
      source: string;
    };
    expect(meta.edited).toBe(false); // no working copy: the analyzed version
    expect(meta.source).toMatch(/analysis/);
    const name = meta.legend.find((l) => l.id === nameId)!;
    expect(name.label).toBe("Full name");
    expect(name.box.x).toBeCloseTo(0.1);
    expect(nameId.startsWith(name.tag)).toBe(true);
    expect(meta.filled).toBe(1);

    expect(mock.calls.length).toBe(before); // no request
    expect(walk(t.dir).sort()).toEqual(filesBefore); // nothing written
  });

  it("works on a saved template (blank downloaded once) and rejects bad targets", async () => {
    const { mock } = templateMock(await pdfFor(render));
    const c = await server(mock);
    const r = await preview(c, { template_id: TPL, page: 2 });
    expect(r.isError).toBe(false);
    expect(pngDims(r.content[0].data!).sig).toBe(true);
    expect(JSON.parse(r.content[1].text!)).toMatchObject({
      edited: false,
      source: "saved template (no local edits)",
    });
    const bad = await c.call("preview_page", { page: 1 });
    expect(bad.isError).toBe(true);
    expect(bad.data.error).toMatchObject({ code: "invalid_argument" });
    const off = await preview(c, { template_id: TPL, page: 7 });
    expect(off.isError).toBe(true);
  });
});

describe("edit_template → fill/preview → save_template", () => {
  it("edits a template locally, fills with the edits, then saves them with expected_updated_at", async () => {
    const tplPdf = await pdfFor(render);
    const { mock } = templateMock(tplPdf);
    const c = await server(mock);

    const e = await c.call("edit_template", {
      template_id: TPL,
      ops: [
        { op: "relabel", id: nameId, label: "Full legal name" },
        { op: "move", id: cityId, dy: 0.05 },
        {
          op: "add",
          page: 2,
          type: "date",
          box: { x: 0.6, y: 0.85, w: 0.2, h: 0.03 },
          label: "Date signed",
        },
        { op: "delete", id: "missing-id" },
      ],
    });
    expect(e.isError).toBe(false);
    expect(e.data).toMatchObject({ applied: 3, saveable: true, has_edits: true });
    expect(e.data.rejected).toEqual([{ op_index: 3, reason: expect.stringMatching(/missing-id/) }]);
    const added = (e.data.diff_summary as { added: { id: string }[] }).added[0].id;
    expect(walk(join(cacheDir, "edits"))).toHaveLength(1);
    expect(mock.count("PATCH", /./)).toBe(0); // nothing sent yet

    // fill_template uses the working copy (the added field is fillable) and says so.
    const out = join(t.dir, "out.pdf");
    const f = await c.call("fill_template", {
      template_id: TPL,
      values: { [added]: "2026-10-04", [nameId]: "Ada" },
      output_path: out,
    });
    expect(f.isError).toBe(false);
    expect(f.data).toMatchObject({ edited: true, filled: 2 });
    expect(await extractStampedText(new Uint8Array(readFileSync(out)), 1)).toContain("2026-10-04");

    const pv = await preview(c, { template_id: TPL, page: 2 });
    const meta = JSON.parse(pv.content[1].text!) as { edited: boolean; legend: { id: string }[] };
    expect(meta.edited).toBe(true);
    expect(meta.legend.map((l) => l.id)).toContain(added);

    const s = await c.call("save_template", { template_id: TPL });
    expect(s.isError).toBe(false);
    expect(s.data).toMatchObject({ saved: true, updated_at: V2 });
    const patch = mock.calls.find((x) => x.method === "PATCH")!;
    const body = JSON.parse(patch.body) as { schema: RenderSchema; expected_updated_at: string };
    expect(Object.keys(body).sort()).toEqual(["expected_updated_at", "schema"]);
    expect(body.expected_updated_at).toBe(V1);
    expect(Object.keys(body.schema).sort()).toEqual(Object.keys(render).sort());
    expect(body.schema.pages).toEqual(render.pages); // pages exactly as received
    expect(body.schema.fields.find((x) => x.id === nameId)!.label).toBe("Full legal name");
    expect(body.schema.fields.some((x) => x.id === added)).toBe(true);
    expect(walk(join(cacheDir, "edits"))).toHaveLength(0); // cleared

    const again = await c.call("save_template", { template_id: TPL });
    expect(again.data.error).toMatchObject({ code: "no_local_edits" });
  });

  it("409 keeps the local edits and reports the current version; discard starts over", async () => {
    const { mock, setVersion } = templateMock(await pdfFor(render), () =>
      apiError(409, "template_conflict", { current_updated_at: V2 }),
    );
    const c = await server(mock);
    await c.call("edit_template", {
      template_id: TPL,
      ops: [{ op: "relabel", id: nameId, label: "Name" }],
    });
    setVersion(V2);
    const s = await c.call("save_template", { template_id: TPL });
    expect(s.isError).toBe(true);
    expect(s.data.error).toMatchObject({
      code: "template_conflict",
      current_updated_at: V2,
      local_edits_kept: true,
    });
    expect(walk(join(cacheDir, "edits"))).toHaveLength(1);
    const d = await c.call("edit_template", { template_id: TPL, ops: [], discard: true });
    expect(d.data).toMatchObject({ discarded: true, has_edits: false });
    expect(walk(join(cacheDir, "edits"))).toHaveLength(0);
  });

  it("422 reports per-item reasons with the item's id", async () => {
    const { mock } = templateMock(await pdfFor(render), () =>
      apiError(422, "invalid_schema", {
        details: [{ path: "fields.0.label", reason: "too long" }],
      }),
    );
    const c = await server(mock);
    await c.call("edit_template", {
      template_id: TPL,
      ops: [{ op: "relabel", id: nameId, label: "Name" }],
    });
    const s = await c.call("save_template", { template_id: TPL });
    expect(s.data.error).toMatchObject({
      code: "invalid_schema",
      details: [{ path: "fields.0.label", reason: "too long", id: render.fields[0].id }],
    });
  });

  it("other save errors map through the envelope (403/404/413/429)", async () => {
    for (const [status, code] of [
      [403, "template_frozen"],
      [404, "not_found"],
      [413, "request_too_large"],
      [429, "rate_limited"],
    ] as const) {
      const { mock } = templateMock(await pdfFor(render), () => apiError(status, code));
      const c = await server(mock);
      await c.call("edit_template", {
        template_id: TPL,
        ops: [{ op: "relabel", id: nameId, label: "Name" }],
      });
      const s = await c.call("save_template", { template_id: TPL });
      expect(s.data.error, code).toMatchObject({ code });
      expect(mock.count("PATCH", /./), code).toBe(1); // never retried
      await c.call("edit_template", { template_id: TPL, ops: [], discard: true });
    }
  });

  it("an unsaved analysis is editable (fill_form uses it) but not saveable", async () => {
    const pdfPath = join(t.dir, "form.pdf");
    writeFileSync(pdfPath, await pdfFor(render));
    const mock = new MockApi().analyzeFlow({ jobId: JOB, render, agent, pages: [1, 2] });
    const c = await server(mock);
    await c.call("analyze_form", { path: pdfPath });
    const e = await c.call("edit_template", {
      path: pdfPath,
      ops: [{ op: "resize", id: nameId, w: 0.5, h: 0.05 }],
    });
    expect(e.data).toMatchObject({ applied: 1, saveable: false, target: { path: pdfPath } });
    expect(String(e.data.next)).toMatch(/save_as_template: true/);
    const out = join(t.dir, "o.pdf");
    const f = await c.call("fill_form", {
      path: pdfPath,
      values: { [nameId]: "Ada" },
      output_path: out,
    });
    expect(f.data).toMatchObject({ edited: true, filled: 1 });
    const again = await c.call("analyze_form", { path: pdfPath });
    expect(again.data.local_edits).toBeTruthy();
    const s = await c.call("save_template", { template_id: TPL });
    expect(s.data.error).toMatchObject({ code: "no_local_edits" });
    expect(String((s.data.error as { hint: string }).hint)).toMatch(/save_as_template: true/);
  });

  it("caps ops at 200 per call", async () => {
    const c = await server(templateMock(await pdfFor(render)).mock);
    const ops = Array.from({ length: 201 }, () => ({ op: "relabel", id: nameId, label: "x" }));
    const r = await c.call("edit_template", { template_id: TPL, ops });
    expect(r.isError).toBe(true);
  });
});

describe("the echo guard (Q3)", () => {
  it("rejects an edit that repeats a filled answer before the working copy is written; warns under 4", async () => {
    const { mock } = templateMock(await pdfFor(render));
    const c = await server(mock);
    const SECRET = "Kowalska-Sentinel 77";
    await c.call("fill_template", {
      template_id: TPL,
      values: { [nameId]: SECRET, [cityId]: "NY" },
      output_path: join(t.dir, "a.pdf"),
    });
    const e = await c.call("edit_template", {
      template_id: TPL,
      ops: [
        { op: "set_placeholder", id: nameId, placeholder: ` ${SECRET.toUpperCase()} ` },
        { op: "relabel", id: nameId, label: `Name (e.g. ${SECRET})` }, // contains it
      ],
    });
    expect(e.data).toMatchObject({ applied: 0, has_edits: false });
    expect((e.data.rejected as { op_index: number }[]).map((r) => r.op_index)).toEqual([0, 1]);
    expect(String((e.data.rejected as { reason: string }[])[0].reason)).toMatch(
      /matches an answer filled in this session/,
    );
    expect(JSON.stringify(e.data)).not.toContain(SECRET);
    // Nothing was written: the answer is nowhere in the cache.
    expect(walk(join(cacheDir, "edits"))).toHaveLength(0);
    const hits = walk(cacheDir).filter((f) => readFileSync(f, "latin1").includes(SECRET));
    expect(hits).toEqual([]);

    // A short echo applies with a warning, and saves with one.
    const w = await c.call("edit_template", {
      template_id: TPL,
      ops: [{ op: "relabel", id: cityId, label: "ny" }],
    });
    expect(w.data).toMatchObject({ applied: 1 });
    expect((w.data.warnings as string[]).join(" ")).toContain(cityId);
    const ok = await c.call("save_template", { template_id: TPL });
    expect(ok.isError).toBe(false);
    expect(String((ok.data.warnings as string[])[0])).toContain(cityId);
  });

  it("save_template refuses wording that repeats an answer filled after the edit", async () => {
    const { mock } = templateMock(await pdfFor(render));
    const c = await server(mock);
    const SECRET = "Kowalska-Sentinel 77";
    await c.call("edit_template", {
      template_id: TPL,
      ops: [{ op: "set_placeholder", id: nameId, placeholder: `e.g. ${SECRET}` }],
    });
    await c.call("fill_template", {
      template_id: TPL,
      values: { [nameId]: SECRET },
      output_path: join(t.dir, "a.pdf"),
    });
    const s = await c.call("save_template", { template_id: TPL });
    expect(s.data.error).toMatchObject({ code: "answer_in_template", ids: [nameId] });
    expect(JSON.stringify(s.data)).not.toContain(SECRET);
    expect(mock.count("PATCH", /./)).toBe(0);
  });
});

describe("save_template: wording from an earlier session (confirm_wording)", () => {
  const editsFile = () => walk(join(cacheDir, "edits"))[0];

  it("needs confirm_wording, listing ids + properties but never the text", async () => {
    const { mock } = templateMock(await pdfFor(render));
    const a = await server(mock);
    await a.call("edit_template", {
      template_id: TPL,
      ops: [
        { op: "relabel", id: nameId, label: "Full legal name" },
        { op: "move", id: cityId, dy: 0.01 },
      ],
    });
    const wc = JSON.parse(readFileSync(editsFile(), "utf8")) as { writer: { pid: number } };
    expect(wc.writer.pid).toBe(process.pid);
    await a.close();

    const b = await server(mock); // a later session over the same cache
    const s = await b.call("save_template", { template_id: TPL });
    expect(s.data.error).toMatchObject({
      code: "confirm_wording_needed",
      changed: [{ id: nameId, properties: ["label"] }],
    });
    expect(JSON.stringify(s.data)).not.toContain("Full legal name");
    expect(mock.count("PATCH", /./)).toBe(0);
    // Editing it in this session doesn't vouch for the earlier wording.
    await b.call("edit_template", {
      template_id: TPL,
      ops: [{ op: "move", id: cityId, dy: 0.01 }],
    });
    const again = await b.call("save_template", { template_id: TPL });
    expect(again.data.error).toMatchObject({ code: "confirm_wording_needed" });

    const ok = await b.call("save_template", { template_id: TPL, confirm_wording: true });
    expect(ok.data).toMatchObject({ saved: true });
    expect(mock.count("PATCH", /./)).toBe(1);
  });

  it("a copy without a writer (older version) needs it too; layout-only copies don't", async () => {
    const { mock } = templateMock(await pdfFor(render));
    const a = await server(mock);
    await a.call("edit_template", {
      template_id: TPL,
      ops: [{ op: "move", id: cityId, dy: 0.01 }],
    });
    await a.close();
    const b = await server(mock);
    const plain = await b.call("save_template", { template_id: TPL });
    expect(plain.data).toMatchObject({ saved: true }); // no wording changed

    await b.call("edit_template", {
      template_id: TPL,
      ops: [{ op: "relabel", id: nameId, label: "Given names" }],
    });
    const f = editsFile();
    const wc = JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
    delete wc.writer;
    writeFileSync(f, JSON.stringify(wc));
    const s = await b.call("save_template", { template_id: TPL });
    expect(s.data.error).toMatchObject({ code: "confirm_wording_needed" });
  });
});

describe("a PDF saved as a template never uses its stale unsaved-analysis copy", () => {
  it("fill_form ignores the f- copy once the file is a template; a template copy or save drops it", async () => {
    const pdfPath = join(t.dir, "form.pdf");
    writeFileSync(pdfPath, await pdfFor(render));
    const JOB2 = "22222222-2222-4333-8444-555555555555";
    const done = (jobId: string, tpl: string | null) =>
      json(200, {
        job_id: jobId,
        status: "done",
        mode: "ai",
        phase: "done",
        progress: 100,
        pages: [1, 2],
        cost: 2,
        created_at: "2026-10-04T00:00:00Z",
        template_id: tpl,
        error: null,
        result: { ...agent, template_id: tpl },
        render,
      });
    const { mock } = templateMock(await pdfFor(render));
    mock
      .on("POST", /^\/v1\/forms\/analyze$/, (req) => {
        const save = req.body.includes("save_as_template=true");
        return json(202, {
          job_id: save ? JOB2 : JOB,
          status: "queued",
          mode: "ai",
          pages: [1, 2],
          cost: 2,
        });
      })
      .on("GET", new RegExp(`^/v1/jobs/${JOB}\\?include=render$`), () => done(JOB, null))
      .on("GET", new RegExp(`^/v1/jobs/${JOB2}\\?include=render$`), () => done(JOB2, TPL));
    const c = await server(mock);
    await c.call("analyze_form", { path: pdfPath });
    await c.call("edit_template", {
      path: pdfPath,
      ops: [{ op: "resize", id: nameId, w: 0.5, h: 0.05 }],
    });
    const names = () => walk(join(cacheDir, "edits")).map((f) => f.split("/").pop()!);
    expect(names()).toEqual([expect.stringMatching(/^f-/)]);

    const saved = await c.call("analyze_form", { path: pdfPath, save_as_template: true });
    expect(saved.data).toMatchObject({ template_id: TPL });
    expect(saved.data.local_edits).toBeUndefined();
    const out = join(t.dir, "o.pdf");
    const f = await c.call("fill_form", {
      path: pdfPath,
      values: { [nameId]: "Ada" },
      output_path: out,
    });
    expect(f.isError).toBe(false);
    expect(f.data.edited).toBeUndefined(); // not the stale f- copy

    // Editing the file now edits the template, and drops the f- copy.
    const e = await c.call("edit_template", {
      path: pdfPath,
      ops: [{ op: "relabel", id: nameId, label: "Full legal name" }],
    });
    expect(e.data).toMatchObject({ applied: 1, target: { template_id: TPL } });
    expect(names()).toEqual([`t-${TPL}.json`]);
  });
});

describe("analyze_form detect_extra_blanks", () => {
  async function acroPdf(): Promise<string> {
    const doc = await PDFDocument.create();
    const pages = [doc.addPage(), doc.addPage()];
    doc
      .getForm()
      .createTextField("name")
      .addToPage(pages[0], { x: 50, y: 700, width: 200, height: 20 });
    const p = join(t.dir, "acro.pdf");
    writeFileSync(p, await doc.save());
    return p;
  }

  it("prices the extra pass at one scan per chosen page in the estimate", async () => {
    const p = await acroPdf();
    const c = await server(null);
    const free = await c.call("analyze_form", { path: p, estimate: true });
    expect(free.data).toMatchObject({ likely_mode: "acroform", estimated_scans: 0 });
    const paid = await c.call("analyze_form", {
      path: p,
      estimate: true,
      detect_extra_blanks: true,
    });
    expect(paid.data).toMatchObject({
      likely_mode: "acroform",
      estimated_scans: 2,
      detect_extra_blanks: true,
    });
    const one = await c.call("analyze_form", {
      path: p,
      pages: "2",
      estimate: true,
      detect_extra_blanks: true,
    });
    expect(one.data).toMatchObject({ estimated_scans: 1 });
  });

  it("surfaces extra_blanks_available from the 202, sends the flag only when asked, and a flagged request misses a plain AcroForm cache", async () => {
    const p = await acroPdf();
    const r2: RenderSchema = {
      ...render,
      pages: render.pages.map((x) => ({ ...x, width: 612, height: 792 })),
    };
    let posts = 0;
    let lastForm = "";
    const mock = new MockApi()
      .on("POST", /^\/v1\/forms\/analyze$/, (req) => {
        posts++;
        lastForm = req.body;
        const extra = req.body.includes("detect_extra_blanks=true");
        return json(202, {
          job_id: extra ? "22222222-2222-4333-8444-555555555555" : JOB,
          status: "queued",
          mode: extra ? "ai" : "acroform",
          pages: [1, 2],
          cost: extra ? 2 : 0,
          ...(extra
            ? { extra_blanks: true, extra_blanks_pages: [1, 2] }
            : { extra_blanks_available: true }),
        });
      })
      .on("GET", /^\/v1\/jobs\/([0-9a-f-]+)\?include=render$/, (_req, m) =>
        json(200, {
          job_id: m[1],
          status: "done",
          mode: m[1] === JOB ? "acroform" : "ai",
          phase: "done",
          progress: 100,
          pages: [1, 2],
          cost: m[1] === JOB ? 0 : 2,
          created_at: "2026-10-04T00:00:00Z",
          template_id: null,
          error: null,
          result: agent,
          render: r2,
        }),
      );
    const c = await server(mock);
    const a = await c.call("analyze_form", { path: p });
    expect(a.data).toMatchObject({
      status: "done",
      mode: "acroform",
      extra_blanks_available: true,
    });
    expect(lastForm).not.toContain("detect_extra_blanks");
    // Cache hit: still surfaced.
    const hit = await c.call("analyze_form", { path: p });
    expect(hit.data).toMatchObject({ cached: true, extra_blanks_available: true });
    expect(posts).toBe(1);
    // Opting in is a different request: a new (paid) job.
    const x = await c.call("analyze_form", { path: p, detect_extra_blanks: true });
    expect(x.data).toMatchObject({ status: "done", cached: false, cost: 2 });
    expect(lastForm).toContain("detect_extra_blanks=true");
    expect(posts).toBe(2);
    expect(x.data.extra_blanks_available).toBeUndefined();
    // …and now cached for both.
    const both = await c.call("analyze_form", { path: p, detect_extra_blanks: true });
    expect(both.data).toMatchObject({ cached: true });
    expect(posts).toBe(2);
  });

  it("a pass over some pages never serves another page's request; each pass keeps its own cache entry", async () => {
    const p = await acroPdf();
    const r2: RenderSchema = {
      ...render,
      pages: render.pages.map((x) => ({ ...x, width: 612, height: 792 })),
    };
    const jobs: string[] = [];
    const extraOf = new Map<string, number[]>();
    const mock = new MockApi()
      .on("POST", /^\/v1\/forms\/analyze$/, (req) => {
        const page = Number(/pages=(\d+)/.exec(req.body)![1]);
        const id = `3333333${String(jobs.length)}-2222-4333-8444-555555555555`;
        jobs.push(id);
        extraOf.set(id, [page]);
        // A2: every native-field page is mapped, only the chosen one scanned.
        return json(202, {
          job_id: id,
          status: "queued",
          mode: "ai",
          pages: [1, 2],
          cost: 1,
          extra_blanks: true,
          extra_blanks_pages: [page],
        });
      })
      .on("GET", /^\/v1\/jobs\/([0-9a-f-]+)\?include=render$/, (_req, m) =>
        json(200, {
          job_id: m[1],
          status: "done",
          mode: "ai",
          phase: "done",
          progress: 100,
          pages: [1, 2], // the job status carries no extra_blanks_pages
          cost: 1,
          created_at: "2026-10-04T00:00:00Z",
          template_id: null,
          error: null,
          result: agent,
          render: r2,
        }),
      );
    const c = await server(mock);
    const one = await c.call("analyze_form", { path: p, pages: "1", detect_extra_blanks: true });
    expect(one.data).toMatchObject({ status: "done", cached: false });
    expect(jobs).toHaveLength(1);
    expect(
      (await c.call("analyze_form", { path: p, pages: "1", detect_extra_blanks: true })).data,
    ).toMatchObject({ cached: true });
    // Page 2 was never scanned for extra blanks: a new pass, not a free cache hit.
    const two = await c.call("analyze_form", { path: p, pages: "2", detect_extra_blanks: true });
    expect(two.data).toMatchObject({ status: "done", cached: false });
    expect(jobs).toHaveLength(2);
    // Both passes stay cached (distinct names), so both are free now.
    const sha = readdirSync(join(cacheDir, "forms"))[0];
    expect(readdirSync(join(cacheDir, "forms", sha)).sort()).toEqual([
      "p1-2.e-p1.u.json",
      "p1-2.e-p2.u.json",
    ]);
    for (const pages of ["1", "2"]) {
      const r = await c.call("analyze_form", { path: p, pages, detect_extra_blanks: true });
      expect(r.data, pages).toMatchObject({ cached: true });
    }
    expect(jobs).toHaveLength(2);
  });
});

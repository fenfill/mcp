// preview_page, edit_template, save_template and detect_extra_blanks, end to
// end over the MCP client (mocked /v1).

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
  reId,
  testIdentity,
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
const bornId = agent.fields.find((e) => e.label === "Date of birth")!.id;

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
    // Always present, so [] reads as "checked, clean", never "not computed".
    const raw = JSON.parse(r.content[1].text!) as Record<string, unknown>;
    expect(Array.isArray(raw.warnings)).toBe(true);
    expect(Array.isArray(raw.placement_warnings)).toBe(true);
    // A single-line text field reports the size its value starts at.
    const nameRow = (raw.legend as Record<string, unknown>[]).find((l) => l.id === nameId)!;
    expect(typeof nameRow.font_pt).toBe("number");
    expect(typeof nameRow.font_auto).toBe("boolean");

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

describe("preview_page overlay", () => {
  it("the result says which overlay was drawn, and keeps legend and placement checks", async () => {
    const { mock } = templateMock(await pdfFor(render));
    const c = await server(mock);
    type Meta = {
      overlay?: string;
      colours?: string;
      legend: unknown[];
      placement_warnings: unknown[];
    };
    const shot = async (overlay?: string) => {
      const pv = await preview(c, { template_id: TPL, page: 1, dpi: 72, overlay });
      expect(pv.isError).toBe(false);
      expect(pngDims(pv.content[0].data!).sig).toBe(true);
      return JSON.parse(pv.content[1].text!) as Meta;
    };
    const full = await shot();
    expect("overlay" in full).toBe(false);
    expect(full.colours).toMatch(/tagged beside it, off its caption/);
    expect(await shot("full")).toEqual(full);

    const outline = await shot("outline");
    expect(outline.overlay).toBe("outline");
    expect(outline.colours).toMatch(/grey dashed = empty/);
    expect(outline.colours).not.toMatch(/tagged/);

    const none = await shot("none");
    expect(none.overlay).toBe("none");
    expect("colours" in none).toBe(false);
    for (const m of [outline, none]) {
      expect(m.legend).toEqual(full.legend);
      expect(m.placement_warnings).toEqual(full.placement_warnings);
    }
    const bad = await preview(c, { template_id: TPL, page: 1, overlay: "tags" });
    expect(bad.isError).toBe(true);
  });
});

describe("values keyed by short ids", () => {
  type Meta = { filled: number; skipped?: { id: string; reason: string }[] };
  const metaOf = (pv: Awaited<ReturnType<typeof preview>>) =>
    JSON.parse(pv.content[1].text!) as Meta;

  it("preview_page stamps them, and reports a key that names nothing", async () => {
    const { mock } = templateMock(await pdfFor(render));
    const c = await server(mock);
    const values = {
      [nameId.slice(0, 8)]: "Ada",
      [cityId]: "Paris",
      [bornId]: "not a date",
      "zzzzzzzz-nope": "x",
    };
    // Page 1 holds the name and the date of birth; the city is on page 2.
    const p1 = metaOf(await preview(c, { template_id: TPL, page: 1, values, legend: "none" }));
    expect(p1.filled).toBe(2);
    expect(p1.skipped?.map((s) => s.id).sort()).toEqual([bornId, "zzzzzzzz-nope"].sort());
    expect(p1.skipped?.find((s) => s.id === "zzzzzzzz-nope")?.reason).toBe("unknown id");
    // Another page's skip stays off this page; the key that names nothing does not.
    const p2 = metaOf(await preview(c, { template_id: TPL, page: 2, values, legend: "none" }));
    expect(p2.skipped?.map((s) => s.id)).toEqual(["zzzzzzzz-nope"]);
  });

  it("fill_template stamps them, and the echo guard remembers what was stamped", async () => {
    const { mock } = templateMock(await pdfFor(render));
    const c = await server(mock);
    const SECRET = "Kowalska-Sentinel 77";
    const out = join(t.dir, "short.pdf");
    const f = await c.call("fill_template", {
      template_id: TPL,
      values: { [nameId.slice(0, 8)]: SECRET },
      output_path: out,
    });
    expect(f.data).toMatchObject({ filled: 1, skipped: [] });
    expect(
      (await extractStampedText(new Uint8Array(readFileSync(out)), 0)).toLowerCase(),
    ).toContain(SECRET.toLowerCase());
    const e = await c.call("edit_template", {
      template_id: TPL,
      ops: [{ op: "set_placeholder", id: cityId, placeholder: SECRET }],
    });
    expect(e.data).toMatchObject({ applied: 0 });
    expect(JSON.stringify(e.data)).not.toContain(SECRET);
  });

  it("preview_page values count as answers for the guard, short ids too", async () => {
    const { mock } = templateMock(await pdfFor(render));
    const c = await server(mock);
    const SECRET = "Kowalska-Sentinel 77";
    await preview(c, { template_id: TPL, page: 1, values: { [nameId.slice(0, 8)]: SECRET } });
    const e = await c.call("edit_template", {
      template_id: TPL,
      ops: [{ op: "relabel", id: cityId, label: SECRET }],
    });
    expect(e.data).toMatchObject({ applied: 0, has_edits: false });
    expect(String((e.data.rejected as { reason: string }[])[0].reason)).toMatch(
      /matches an answer filled in this session/,
    );
  });
});

describe("concurrent edit_template calls (H-15-001)", () => {
  const editsFile = () => join(cacheDir, "edits", `t-${TPL}.json`);
  const labelOf = (wc: { render: RenderSchema }, id: string) =>
    wc.render.fields.find((f) => f.id === id)?.label;

  it("two calls in flight on one template both land", async () => {
    const { mock } = templateMock(await pdfFor(render));
    const c = await server(mock);
    const [a, b] = await Promise.all([
      c.call("edit_template", {
        template_id: TPL,
        ops: [{ op: "relabel", id: nameId, label: "Full legal name" }],
      }),
      c.call("edit_template", {
        template_id: TPL,
        ops: [{ op: "relabel", id: cityId, label: "Town" }],
      }),
    ]);
    expect(a.data).toMatchObject({ applied: 1, has_edits: true });
    expect(b.data).toMatchObject({ applied: 1, has_edits: true });
    const wc = JSON.parse(readFileSync(editsFile(), "utf8")) as {
      render: RenderSchema;
      ops_applied: number;
    };
    expect(labelOf(wc, nameId)).toBe("Full legal name");
    expect(labelOf(wc, cityId)).toBe("Town");
    expect(wc.ops_applied).toBe(2);
  });

  it("refuses to overwrite a copy another process wrote meanwhile", async () => {
    const { mock } = templateMock(await pdfFor(render));
    // Another process writes its copy after this call has read the (absent) one.
    let other: Record<string, unknown> | null = null;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!other && url.includes("include=render")) {
        const theirs: RenderSchema = JSON.parse(JSON.stringify(render));
        theirs.fields.find((f) => f.id === bornId)!.label = "Birth date (other process)";
        const iso = "2026-10-04T12:00:00.000Z";
        other = {
          v: 1,
          key: `t-${TPL}`,
          template_id: TPL,
          sha256: null,
          base_updated_at: V1,
          base: render,
          render: theirs,
          created_at: iso,
          updated_at: iso,
          ops_applied: 1,
          ...testIdentity(),
          writer: { pid: 1, started_at: iso, owner: "other-process" },
        };
        mkdirSync(join(cacheDir, "edits"), { recursive: true });
        writeFileSync(editsFile(), JSON.stringify(other));
      }
      return mock.fetch(input, init);
    }) as typeof fetch;
    const c = await connect({ env: env(cacheDir), fetchImpl, ...virtualClock() });
    open.push(c);
    const r = await c.call("edit_template", {
      template_id: TPL,
      ops: [{ op: "relabel", id: nameId, label: "Full legal name" }],
    });
    expect(r.data.error).toMatchObject({ code: "edit_conflict" });
    expect(String((r.data.error as { hint: string }).hint)).toMatch(/again/);
    // The other process's edit survives; this call wrote nothing.
    const wc = JSON.parse(readFileSync(editsFile(), "utf8")) as { render: RenderSchema };
    expect(labelOf(wc, bornId)).toBe("Birth date (other process)");
    expect(labelOf(wc, nameId)).not.toBe("Full legal name");
    // Called again, it applies on top of that copy.
    const again = await c.call("edit_template", {
      template_id: TPL,
      ops: [{ op: "relabel", id: nameId, label: "Full legal name" }],
    });
    expect(again.data).toMatchObject({ applied: 1 });
    const after = JSON.parse(readFileSync(editsFile(), "utf8")) as { render: RenderSchema };
    expect(labelOf(after, bornId)).toBe("Birth date (other process)");
    expect(labelOf(after, nameId)).toBe("Full legal name");
  });
});

describe("get_template with local edits", () => {
  it("lists the working copy (edited: true), or with version saved fenfill's", async () => {
    const tplPdf = await pdfFor(render);
    const { mock } = templateMock(tplPdf);
    const c = await server(mock);
    const before = await c.call("get_template", { template_id: TPL });
    expect(before.data).toMatchObject({ has_local_edits: false, edited: false });

    const e = await c.call("edit_template", {
      template_id: TPL,
      ops: [
        { op: "relabel", id: nameId, label: "Full legal name" },
        { op: "delete", id: cityId },
        {
          op: "add",
          page: 2,
          type: "date",
          box: { x: 0.6, y: 0.85, w: 0.2, h: 0.03 },
          label: "Date signed",
        },
      ],
    });
    expect(e.data).toMatchObject({ applied: 3, has_edits: true });
    const added = (e.data.diff_summary as { added: { id: string }[] }).added[0].id;

    const listed = (r: { data: Record<string, unknown> }) =>
      (r.data.sections as { fields: { id: string; label: string }[] }[]).flatMap((b) => b.fields);
    const g = await c.call("get_template", { template_id: TPL });
    expect(g.data).toMatchObject({ has_local_edits: true, edited: true });
    const ids = listed(g).map((x) => x.id);
    expect(ids).toContain(added);
    expect(ids).not.toContain(cityId);
    expect(listed(g).find((x) => x.id === nameId)?.label).toBe("Full legal name");
    expect(g.data.local_edits).toMatch(/your local working copy/);

    const s = await c.call("get_template", { template_id: TPL, version: "saved" });
    expect(s.data).toMatchObject({ has_local_edits: true, edited: false });
    expect(listed(s).map((x) => x.id)).toContain(cityId);
    expect(listed(s).map((x) => x.id)).not.toContain(added);
    expect(mock.count("PATCH", /./)).toBe(0);
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
    // A date stamps in the field's date_format (DD/MM/YYYY for a new date field).
    expect(await extractStampedText(new Uint8Array(readFileSync(out)), 1)).toContain("04/10/2026");

    const pv = await preview(c, { template_id: TPL, page: 2 });
    const meta = JSON.parse(pv.content[1].text!) as { edited: boolean; legend: { id: string }[] };
    expect(meta.edited).toBe(true);
    expect(meta.legend.map((l) => l.id)).toContain(added);
    // legend: "changed" — nothing since that preview; then just the relabeled field.
    const same = await preview(c, { template_id: TPL, page: 2, legend: "changed" });
    expect(JSON.parse(same.content[1].text!)).toMatchObject({ legend: [], legend_mode: "changed" });
    await c.call("edit_template", {
      template_id: TPL,
      ops: [{ op: "relabel", id: added.slice(0, 8), label: "Date of signature" }],
    });
    const changed = await preview(c, { template_id: TPL, page: 2, legend: "changed" });
    const cm = JSON.parse(changed.content[1].text!) as { legend: { id: string; label: string }[] };
    expect(cm.legend.map((l) => [l.id, l.label])).toEqual([[added, "Date of signature"]]);
    // crop: a region at zoom 2 renders that region's pixels and lists only its rows.
    const full = await preview(c, { template_id: TPL, page: 2, dpi: 72, legend: "none" });
    const crop = await preview(c, {
      template_id: TPL,
      page: 2,
      dpi: 72,
      crop: { x: 0.5, y: 0.8, w: 0.5, h: 0.2 },
      zoom: 2,
    });
    const fd = pngDims(full.content[0].data!);
    const cd = pngDims(crop.content[0].data!);
    expect(cd.w).toBeCloseTo(fd.w, -1); // half the width at twice the scale
    expect(cd.h).toBeCloseTo(fd.h * 0.4, -1);
    expect("legend" in JSON.parse(full.content[1].text!)).toBe(false);
    const cl = JSON.parse(crop.content[1].text!) as { legend: { id: string }[]; dpi: number };
    expect(cl.dpi).toBe(144);
    expect(cl.legend.map((l) => l.id)).toEqual([added]);

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
    expect(again.data).toMatchObject({ saved: false, nothing_to_save: true });
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

  it("discard works without ops; a call with neither is refused", async () => {
    const { mock } = templateMock(await pdfFor(render));
    const c = await server(mock);
    await c.call("edit_template", {
      template_id: TPL,
      ops: [{ op: "relabel", id: nameId, label: "Name" }],
    });
    expect(walk(join(cacheDir, "edits"))).toHaveLength(1);
    const d = await c.call("edit_template", { template_id: TPL, discard: true });
    expect(d.isError).toBe(false);
    expect(d.data).toMatchObject({ discarded: true, has_edits: false });
    expect(walk(join(cacheDir, "edits"))).toHaveLength(0);
    const none = await c.call("edit_template", { template_id: TPL });
    expect(none.data.error).toMatchObject({ code: "invalid_argument" });
  });

  it("a batch that changes nothing writes no working copy and leaves an existing one alone", async () => {
    const { mock } = templateMock(await pdfFor(render));
    const c = await server(mock);
    const n = await c.call("edit_template", {
      template_id: TPL,
      ops: [
        { op: "relabel", id: nameId, label: "Full name" },
        { op: "set_required", id: cityId, required: false },
      ],
    });
    expect(n.data).toMatchObject({ applied: 2, has_edits: false, ops_applied_total: 0 });
    const ops = (n.data.diff_summary as { ops: { noop?: boolean }[] }).ops;
    expect(ops.map((o) => o.noop)).toEqual([true, true]);
    expect(walk(join(cacheDir, "edits"))).toHaveLength(0);
    const s = await c.call("save_template", { template_id: TPL });
    expect(s.data).toMatchObject({ saved: false, nothing_to_save: true });

    // Ops that undo each other leave nothing to write either.
    const undone = await c.call("edit_template", {
      template_id: TPL,
      ops: [
        { op: "relabel", id: nameId, label: "Name" },
        { op: "relabel", id: nameId, label: "Full name" },
      ],
    });
    expect(undone.data).toMatchObject({ applied: 2, has_edits: false });
    expect(walk(join(cacheDir, "edits"))).toHaveLength(0);

    const relabel = { template_id: TPL, ops: [{ op: "relabel", id: nameId, label: "Name" }] };
    await c.call("edit_template", relabel);
    const file = walk(join(cacheDir, "edits"))[0];
    const before = readFileSync(file, "utf8");
    const again = await c.call("edit_template", relabel);
    expect(again.data).toMatchObject({ applied: 1, has_edits: true, ops_applied_total: 1 });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("another account's copy on disk is not this account's local edits", async () => {
    const { mock } = templateMock(await pdfFor(render));
    const a = await server(mock);
    await a.call("edit_template", {
      template_id: TPL,
      ops: [{ op: "relabel", id: nameId, label: "Name" }],
    });
    await a.close();
    const other = await connect({
      env: env(cacheDir, { FENFILL_API_KEY: `ff_live_${"b".repeat(43)}` }),
      fetchImpl: mock.fetch,
      ...virtualClock(),
    });
    open.push(other);
    // For this account the template is as fenfill has it, so this changes nothing.
    const n = await other.call("edit_template", {
      template_id: TPL,
      ops: [{ op: "relabel", id: nameId, label: "Full name" }],
    });
    expect(n.data).toMatchObject({ applied: 1, has_edits: false, ops_applied_total: 0 });
    const s = await other.call("save_template", { template_id: TPL });
    expect(s.data).toMatchObject({ saved: false, nothing_to_save: true });
  });

  it("set_format {date_format} on a plain date field changes how its date prints", async () => {
    const { mock } = templateMock(await pdfFor(render));
    const c = await server(mock);
    const e = await c.call("edit_template", {
      template_id: TPL,
      ops: [
        {
          op: "add",
          page: 2,
          type: "date",
          box: { x: 0.6, y: 0.85, w: 0.2, h: 0.03 },
          label: "Date signed",
        },
      ],
    });
    const added = (e.data.diff_summary as { added: { id: string }[] }).added[0].id;
    const f = await c.call("edit_template", {
      template_id: TPL,
      ops: [{ op: "set_format", id: added, format: { date_format: "MM/DD/YYYY" } }],
    });
    expect(f.data).toMatchObject({ applied: 1, rejected: [] });
    const out = join(t.dir, "dated.pdf");
    const filled = await c.call("fill_template", {
      template_id: TPL,
      values: { [added]: "2026-10-04" },
      output_path: out,
    });
    expect(filled.data).toMatchObject({ filled: 1 });
    expect(await extractStampedText(new Uint8Array(readFileSync(out)), 1)).toContain("10/04/2026");
    const pv = await preview(c, { template_id: TPL, page: 2 });
    const meta = JSON.parse(pv.content[1].text!) as {
      legend: { id: string; format?: { date_format?: string } }[];
    };
    expect(meta.legend.find((l) => l.id === added)?.format?.date_format).toBe("MM/DD/YYYY");
  });

  it("a renamed section and a moved field reach the PATCH body; pages are otherwise as received", async () => {
    const { mock } = templateMock(await pdfFor(render));
    const c = await server(mock);
    const [personal, declaration] = render.pages[0].sections as { id: string; title: string }[];
    const e = await c.call("edit_template", {
      template_id: TPL,
      ops: [
        { op: "set_section_title", page: 1, section_id: personal.id, title: "Applicant" },
        { op: "set_section", ids: [nameId], section_id: declaration.id },
      ],
    });
    expect(e.data).toMatchObject({ applied: 2, rejected: [] });
    const outcomes = (e.data.diff_summary as { ops: { section?: unknown }[] }).ops;
    expect(outcomes.map((o) => o.section)).toEqual([
      { id: personal.id, title: "Applicant" },
      { id: declaration.id, title: declaration.title },
    ]);
    const s = await c.call("save_template", { template_id: TPL });
    expect(s.data).toMatchObject({ saved: true });
    const patch = mock.calls.find((x) => x.method === "PATCH")!;
    const body = JSON.parse(patch.body) as { schema: RenderSchema };
    expect(body.schema.pages[0]).toEqual({
      ...render.pages[0],
      sections: [{ ...personal, title: "Applicant" }, declaration],
    });
    expect(body.schema.pages[1]).toEqual(render.pages[1]);
    expect(body.schema.fields.find((x) => x.id === nameId)!.section_id).toBe(declaration.id);
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
    expect(s.data).toMatchObject({ saved: false, nothing_to_save: true });
    expect(String(s.data.note)).toMatch(/save_as_template: true/);
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

  /** Three text cells labelled `labels`, grouped into a comb; returns the cell ids. */
  const combOfCells = async (c: Awaited<ReturnType<typeof server>>, labels: string[]) => {
    const e = await c.call("edit_template", {
      template_id: TPL,
      ops: labels.map((label, i) => ({
        op: "add",
        page: 1,
        type: "text",
        box: { x: 0.5 + 0.03 * i, y: 0.9, w: 0.03, h: 0.03 },
        label,
      })),
    });
    const cells = (e.data.diff_summary as { added: { id: string }[] }).added.map((a) => a.id);
    const g = await c.call("edit_template", {
      template_id: TPL,
      ops: [{ op: "group", kind: "comb", ids: cells, label: "Code" }],
    });
    expect(g.data).toMatchObject({ applied: 1 });
    return cells;
  };

  it("save_template passes a comb cell's placeholder label equal to a short answer, without a warning", async () => {
    // A corrector building a comb cell by cell gave each cell a placeholder
    // label; a test answer equal to one ("D1") must not block the save.
    const { mock } = templateMock(await pdfFor(render));
    const c = await server(mock);
    const cells = await combOfCells(c, ["D1", "D2", "D3"]);
    await c.call("fill_template", {
      template_id: TPL,
      values: { [nameId]: "D1" },
      output_path: join(t.dir, "a.pdf"),
    });
    const s = await c.call("save_template", { template_id: TPL });
    expect(s.isError).toBe(false);
    expect(s.data).toMatchObject({ saved: true });
    expect(JSON.stringify(s.data.warnings ?? [])).not.toContain(cells[0]);
  });

  it("save_template refuses a comb cell's label equal to an answer of 4+ characters", async () => {
    // A PIN or a postcode written into a cell's label would reach the server.
    const { mock } = templateMock(await pdfFor(render));
    const c = await server(mock);
    const cells = await combOfCells(c, ["1234", "SW1A", "C3"]);
    await c.call("fill_template", {
      template_id: TPL,
      values: { [nameId]: "1234", [cityId]: "SW1A" },
      output_path: join(t.dir, "a.pdf"),
    });
    const s = await c.call("save_template", { template_id: TPL });
    expect(s.data.error).toMatchObject({ code: "answer_in_template" });
    expect((s.data.error as { ids: string[] }).ids.sort()).toEqual([cells[0], cells[1]].sort());
    expect(mock.count("PATCH", /./)).toBe(0);
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

  it("the flag on the first save of an earlier session's copy gets the list first", async () => {
    const { mock } = templateMock(await pdfFor(render));
    const a = await server(mock);
    await a.call("edit_template", {
      template_id: TPL,
      ops: [{ op: "relabel", id: nameId, label: "Full legal name" }],
    });
    await a.close();
    const b = await server(mock);
    const first = await b.call("save_template", { template_id: TPL, confirm_wording: true });
    expect(first.data.error).toMatchObject({
      code: "confirm_wording_needed",
      changed: [{ id: nameId, properties: ["label"] }],
    });
    expect(mock.count("PATCH", /./)).toBe(0);
    // More wording changed since that list: it is listed again before it can go.
    await b.call("edit_template", {
      template_id: TPL,
      ops: [{ op: "relabel", id: cityId, label: "Town" }],
    });
    const second = await b.call("save_template", { template_id: TPL, confirm_wording: true });
    expect(second.data.error).toMatchObject({ code: "confirm_wording_needed" });
    expect((second.data.error as { changed: unknown[] }).changed).toHaveLength(2);
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

describe("confirming wording that shares a word with a value of this session", () => {
  const VALUE = "Middle"; // a test value an agent stamps to check a placement
  const LABEL = "Middle name"; // the caption the form really prints
  const relabel = (extra: Record<string, unknown> = {}) => ({
    template_id: TPL,
    ops: [{ op: "relabel", id: cityId, label: LABEL }],
    ...extra,
  });
  const reasons = (data: Record<string, unknown>) =>
    (data.rejected as { reason: string }[]).map((r) => r.reason);

  it("an op is refused with the property named, applies when repeated with confirm_wording, and saves", async () => {
    const { mock } = templateMock(await pdfFor(render));
    const c = await server(mock);
    await preview(c, { template_id: TPL, page: 1, values: { [nameId]: VALUE } });

    const no = await c.call("edit_template", relabel());
    expect(no.data).toMatchObject({ applied: 0, has_edits: false });
    expect(reasons(no.data)[0]).toMatch(
      new RegExp(`^the label of ${cityId} matches an answer filled in this session`),
    );
    expect(reasons(no.data)[0]).toMatch(/confirm_wording: true/);
    expect(JSON.stringify(no.data)).not.toMatch(/middle/i);
    expect(walk(join(cacheDir, "edits"))).toHaveLength(0);

    const yes = await c.call("edit_template", relabel({ confirm_wording: true }));
    expect(yes.data).toMatchObject({ applied: 1, rejected: [], has_edits: true });
    expect((yes.data.warnings as string[])[0]).toMatch(
      new RegExp(`^the label of ${cityId}: matches an answer filled in this session; applied`),
    );

    // The save does not ask again, and names what went out on the agent's word.
    const s = await c.call("save_template", { template_id: TPL });
    expect(s.data).toMatchObject({ saved: true });
    expect((s.data.warnings as string[])[0]).toMatch(
      new RegExp(`^the label of ${cityId}: matches an answer .* saved because you confirmed`),
    );
    const patch = mock.calls.find((x) => x.method === "PATCH")!;
    const body = JSON.parse(patch.body) as { schema: RenderSchema };
    expect(body.schema.fields.find((x) => x.id === cityId)!.label).toBe(LABEL);
  });

  it("the flag does not let through a match the agent has not been shown", async () => {
    const { mock } = templateMock(await pdfFor(render));
    const c = await server(mock);
    await preview(c, { template_id: TPL, page: 1, values: { [nameId]: VALUE } });
    const blind = await c.call("edit_template", relabel({ confirm_wording: true }));
    expect(blind.data).toMatchObject({ applied: 0, has_edits: false });
    expect(JSON.stringify(blind.data)).not.toMatch(/middle/i);
    const again = await c.call("edit_template", relabel({ confirm_wording: true }));
    expect(again.data).toMatchObject({ applied: 1 });
  });

  it("wording set before the value is refused at save with the property, and saved once confirmed", async () => {
    const { mock } = templateMock(await pdfFor(render));
    const c = await server(mock);
    const e = await c.call("edit_template", relabel());
    expect(e.data).toMatchObject({ applied: 1 }); // nothing to match yet
    await preview(c, { template_id: TPL, page: 1, values: { [nameId]: VALUE } });

    // Even with the flag: this match has not been listed yet.
    const first = await c.call("save_template", { template_id: TPL, confirm_wording: true });
    expect(first.data.error).toMatchObject({
      code: "answer_in_template",
      ids: [cityId],
      matched: [{ id: cityId, properties: ["label"] }],
    });
    expect((first.data.error as { hint: string }).hint).toMatch(/confirm_wording: true/);
    expect("changed" in (first.data.error as object)).toBe(false); // this session's own copy
    expect(JSON.stringify(first.data)).not.toMatch(/middle/i);
    expect(mock.count("PATCH", /./)).toBe(0);

    const plain = await c.call("save_template", { template_id: TPL });
    expect(plain.data.error).toMatchObject({ code: "answer_in_template" });
    expect(mock.count("PATCH", /./)).toBe(0);

    const ok = await c.call("save_template", { template_id: TPL, confirm_wording: true });
    expect(ok.data).toMatchObject({ saved: true });
    expect((ok.data.warnings as string[])[0]).toMatch(
      new RegExp(`^the label of ${cityId}: .* saved because you confirmed`),
    );
    expect(mock.count("PATCH", /./)).toBe(1);
  });

  it("a save lists every matching entry itself before the flag covers it", async () => {
    const { mock } = templateMock(await pdfFor(render));
    const c = await server(mock);
    const emailId = agent.fields.find((e) => e.label === "Email")!.id;
    // The city gets the caption before any value exists, so nothing refuses it.
    await c.call("edit_template", relabel());
    await preview(c, { template_id: TPL, page: 1, values: { [nameId]: VALUE } });
    // The same wording on another entry is refused, and that refusal names only that entry.
    const other = await c.call("edit_template", {
      template_id: TPL,
      ops: [{ op: "relabel", id: emailId, label: "middle  NAME" }],
    });
    expect(reasons(other.data)[0]).toMatch(new RegExp(`^the label of ${emailId} matches`));

    // The city was never named: the flag does not cover it yet.
    const first = await c.call("save_template", { template_id: TPL, confirm_wording: true });
    expect(first.data.error).toMatchObject({
      code: "answer_in_template",
      matched: [{ id: cityId, properties: ["label"] }],
    });
    expect(mock.count("PATCH", /./)).toBe(0);
    const ok = await c.call("save_template", { template_id: TPL, confirm_wording: true });
    expect(ok.data).toMatchObject({ saved: true });
  });

  it("an add whose label matches is refused as 'the new entry', and applies once confirmed", async () => {
    const { mock } = templateMock(await pdfFor(render));
    const c = await server(mock);
    await preview(c, { template_id: TPL, page: 1, values: { [nameId]: VALUE } });
    const add = (extra: Record<string, unknown> = {}) => ({
      template_id: TPL,
      ops: [
        {
          op: "add",
          page: 2,
          type: "text",
          box: { x: 0.1, y: 0.7, w: 0.3, h: 0.03 },
          label: LABEL,
        },
      ],
      ...extra,
    });
    const no = await c.call("edit_template", add());
    expect(reasons(no.data)[0]).toMatch(/^the label of the new entry matches an answer/);
    const yes = await c.call("edit_template", add({ confirm_wording: true }));
    expect(yes.data).toMatchObject({ applied: 1, rejected: [] });
    const s = await c.call("save_template", { template_id: TPL });
    expect(s.data).toMatchObject({ saved: true });
  });

  it("a word that only starts with the value is not a match", async () => {
    const { mock } = templateMock(await pdfFor(render));
    const c = await server(mock);
    await preview(c, { template_id: TPL, page: 1, values: { [nameId]: "EXEMPT" } });
    const e = await c.call("edit_template", {
      template_id: TPL,
      ops: [{ op: "relabel", id: cityId, label: "Exemption from FATCA reporting code" }],
    });
    expect(e.data).toMatchObject({ applied: 1, rejected: [], warnings: [] });
    const s = await c.call("save_template", { template_id: TPL });
    expect(s.data).toMatchObject({ saved: true });
    expect("warnings" in s.data).toBe(false);
  });

  it("an earlier session's copy: a new match is listed (with what changed) before any confirmation counts", async () => {
    const { mock } = templateMock(await pdfFor(render));
    const a = await server(mock);
    await a.call("edit_template", relabel());
    await a.close();

    const b = await server(mock);
    const needs = await b.call("save_template", { template_id: TPL });
    expect(needs.data.error).toMatchObject({ code: "confirm_wording_needed" });
    // A value given after that error makes a match the agent has not been shown.
    await preview(b, { template_id: TPL, page: 1, values: { [nameId]: VALUE } });
    const listed = await b.call("save_template", { template_id: TPL, confirm_wording: true });
    expect(listed.data.error).toMatchObject({
      code: "answer_in_template",
      matched: [{ id: cityId, properties: ["label"] }],
      changed: [{ id: cityId, properties: ["label"] }],
    });
    expect(mock.count("PATCH", /./)).toBe(0);
    const ok = await b.call("save_template", { template_id: TPL, confirm_wording: true });
    expect(ok.data).toMatchObject({ saved: true });
    expect(mock.count("PATCH", /./)).toBe(1);
  });
});

describe("what the guard remembers of an answer", () => {
  const rejected = (data: Record<string, unknown>) =>
    (data.rejected as { op_index: number }[]).map((r) => r.op_index);

  it("a date is caught in the form the page prints, not only as it was passed", async () => {
    const { mock } = templateMock(await pdfFor(render));
    const c = await server(mock);
    // Date of birth prints as DD.MM.YYYY: the preview shows 17.05.1990.
    await preview(c, { template_id: TPL, page: 1, values: { [bornId]: "1990-05-17" } });
    const e = await c.call("edit_template", {
      template_id: TPL,
      ops: [
        { op: "set_placeholder", id: bornId, placeholder: "1990-05-17" },
        { op: "set_placeholder", id: bornId, placeholder: "17.05.1990" },
        { op: "relabel", id: cityId, label: "Born 17.05.1990 in" },
        { op: "relabel", id: cityId, label: "Town" },
      ],
    });
    expect(rejected(e.data)).toEqual([0, 1, 2]);
    expect(e.data).toMatchObject({ applied: 1 });
    expect(JSON.stringify(e.data)).not.toContain("17.05.1990");
    expect(JSON.stringify(e.data)).not.toContain("1990-05-17");
  });

  it("an answer of several lines is caught line by line", async () => {
    const { mock } = templateMock(await pdfFor(render));
    const c = await server(mock);
    const notesId = agent.fields.find((e) => e.label === "Additional notes")!.id;
    await preview(c, {
      template_id: TPL,
      page: 1,
      values: { [notesId]: "ul. Długa 5\n00-001 Warszawa" },
    });
    const e = await c.call("edit_template", {
      template_id: TPL,
      ops: [
        { op: "relabel", id: cityId, label: "ul. Długa 5" },
        { op: "set_description", id: cityId, description: "e.g. 00-001 Warszawa" },
      ],
    });
    expect(rejected(e.data)).toEqual([0, 1]);
  });

  it("the values of a fill that failed before the form was read are remembered", async () => {
    const { mock } = templateMock(await pdfFor(render));
    const c = await server(mock);
    const out = join(t.dir, "already-there.pdf");
    writeFileSync(out, "not ours to overwrite");
    const f = await c.call("fill_template", {
      template_id: TPL,
      values: { [nameId]: "Jan Kowalski" },
      output_path: out,
    });
    expect(f.data.error).toMatchObject({ code: "output_exists" });
    expect(mock.count("GET", /./)).toBe(0); // refused before the template was fetched
    const e = await c.call("edit_template", {
      template_id: TPL,
      ops: [{ op: "relabel", id: cityId, label: "Jan Kowalski" }],
    });
    expect(e.data).toMatchObject({ applied: 0, has_edits: false });
    expect(rejected(e.data)).toEqual([0]);
  });
});

describe("where an entry was named", () => {
  const TPL_B = "7c0a4e5d-2b1f-4c8e-9a3d-5e6f7a8b9c0d";
  const VALUE = "Middle";
  const TITLE = "Middle name";
  const sectionId = (render.pages[0].sections as { id: string }[])[0].id;

  /** Two saved templates of the same form: other field ids, the same section
   *  ids (the pipeline numbers sections per page, in every template alike). */
  function twoTemplates(tplPdf: Uint8Array) {
    const b = reId(render, agent, "b");
    const of = (id: string) => (id === TPL ? { render, agent } : b);
    const ids = `(${TPL}|${TPL_B})`;
    const patched: Record<string, RenderSchema> = {};
    const mock = new MockApi()
      .on("GET", new RegExp(`^/v1/templates/${ids}\\?include=render$`), (_req, m) =>
        json(200, {
          ...of(m[1]).agent,
          template_id: m[1],
          updated_at: V1,
          render: of(m[1]).render,
        }),
      )
      .on(
        "GET",
        new RegExp(`^/v1/templates/${ids}/pdf$`),
        () => new Response(new Uint8Array(tplPdf)),
      )
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
      .on("PATCH", new RegExp(`^/v1/templates/${ids}$`), (req, m) => {
        patched[m[1]] = (JSON.parse(req.body) as { schema: RenderSchema }).schema;
        return json(200, {
          template_id: m[1],
          updated_at: V2,
          result: { ...of(m[1]).agent, template_id: m[1], updated_at: V2 },
        });
      });
    return { mock, patched };
  }
  const retitle = (id: string) => ({
    template_id: id,
    ops: [{ op: "set_section_title", page: 1, section_id: sectionId, title: TITLE }],
  });

  it("a section named in one template is not thereby named in another", async () => {
    const { mock, patched } = twoTemplates(await pdfFor(render));
    const c = await server(mock);
    // Both titles are written before any value exists: nothing to match yet.
    for (const id of [TPL, TPL_B]) {
      expect((await c.call("edit_template", retitle(id))).data).toMatchObject({ applied: 1 });
    }
    await preview(c, { template_id: TPL, page: 1, values: { [nameId]: VALUE } });

    const named = { id: sectionId, page: 1, properties: ["title"] };
    const first = await c.call("save_template", { template_id: TPL, confirm_wording: true });
    expect(first.data.error).toMatchObject({ code: "answer_in_template", matched: [named] });
    // The other template's section has the same id and the same title, but no
    // refusal has named it: the flag sent ahead confirms nothing there.
    const other = await c.call("save_template", { template_id: TPL_B, confirm_wording: true });
    expect(other.data.error).toMatchObject({ code: "answer_in_template", matched: [named] });
    expect(mock.count("PATCH", /./)).toBe(0);
    expect(JSON.stringify(other.data)).not.toMatch(/middle/i);

    const ok = await c.call("save_template", { template_id: TPL_B, confirm_wording: true });
    expect(ok.data).toMatchObject({ saved: true });
    expect((ok.data.warnings as string[])[0]).toMatch(
      new RegExp(`^the title of ${sectionId} on page 1: matches an answer`),
    );
    expect((patched[TPL_B].pages[0].sections as { title: string }[])[0].title).toBe(TITLE);
    expect(patched[TPL]).toBeUndefined();
  });
});

describe("save_template: an earlier session's copy is listed again when its wording changes", () => {
  const relabelName = (label: string) => ({
    template_id: TPL,
    ops: [{ op: "relabel", id: nameId, label }],
  });
  const needsList = {
    code: "confirm_wording_needed",
    changed: [{ id: nameId, properties: ["label"] }],
  };

  it("another text in a property already listed is listed again before the flag counts", async () => {
    const { mock } = templateMock(await pdfFor(render));
    const a = await server(mock);
    await a.call("edit_template", relabelName("Full legal name"));
    await a.close();

    const b = await server(mock); // the long-lived session
    const listed = await b.call("save_template", { template_id: TPL, confirm_wording: true });
    expect(listed.data.error).toMatchObject(needsList);

    // Another process rewrites the property the list named. Its ids and
    // properties read the same; the wording is not the one that was listed.
    const other = await server(mock);
    await other.call("edit_template", relabelName("Jan Kowalski"));
    await other.close();
    const again = await b.call("save_template", { template_id: TPL, confirm_wording: true });
    expect(again.data.error).toMatchObject(needsList);
    expect(mock.count("PATCH", /./)).toBe(0);
    expect(
      (await b.call("save_template", { template_id: TPL, confirm_wording: true })).data,
    ).toMatchObject({ saved: true });
    expect(mock.count("PATCH", /./)).toBe(1);
  });

  it("a later copy of the same template is listed afresh after a save", async () => {
    const { mock } = templateMock(await pdfFor(render));
    const a = await server(mock);
    await a.call("edit_template", relabelName("Full legal name"));
    await a.close();

    const b = await server(mock);
    await b.call("save_template", { template_id: TPL });
    expect(
      (await b.call("save_template", { template_id: TPL, confirm_wording: true })).data,
    ).toMatchObject({ saved: true });

    // A new copy, from yet another process, naming the same property.
    const later = await server(mock);
    await later.call("edit_template", relabelName("Jan Kowalski"));
    await later.close();
    const first = await b.call("save_template", { template_id: TPL, confirm_wording: true });
    expect(first.data.error).toMatchObject(needsList);
    expect(mock.count("PATCH", /./)).toBe(1);
  });
});

describe("a save refreshes the file's cached analysis", () => {
  it("the cached pages keep their images and take the saved section titles", async () => {
    const pdfPath = join(t.dir, "form.pdf");
    writeFileSync(pdfPath, await pdfFor(render));
    const { mock } = templateMock(await pdfFor(render));
    mock
      .on("POST", /^\/v1\/forms\/analyze$/, () =>
        json(202, { job_id: JOB, status: "queued", mode: "ai", pages: [1, 2], cost: 2 }),
      )
      .on("GET", new RegExp(`^/v1/jobs/${JOB}\\?include=render$`), () =>
        json(200, {
          job_id: JOB,
          status: "done",
          mode: "ai",
          phase: "done",
          progress: 100,
          pages: [1, 2],
          cost: 2,
          created_at: "2026-10-04T00:00:00Z",
          template_id: TPL,
          error: null,
          result: { ...agent, template_id: TPL },
          render,
        }),
      );
    const c = await server(mock);
    const a = await c.call("analyze_form", { path: pdfPath, save_as_template: true });
    expect(a.data).toMatchObject({ template_id: TPL });
    const [personal] = render.pages[0].sections as { id: string }[];
    const e = await c.call("edit_template", {
      path: pdfPath,
      ops: [{ op: "set_section_title", page: 1, section_id: personal.id, title: "Applicant" }],
    });
    expect(e.data).toMatchObject({ applied: 1, target: { template_id: TPL } });
    const s = await c.call("save_template", { template_id: TPL });
    expect(s.data).toMatchObject({ saved: true });

    type Cached = { template_id?: string; render?: RenderSchema };
    const cached = walk(cacheDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(f, "utf8")) as Cached)
      .filter((x) => x.template_id === TPL && x.render);
    expect(cached.length).toBeGreaterThan(0);
    for (const x of cached) {
      const page = x.render!.pages[0];
      expect((page.sections as { title: string }[])[0].title).toBe("Applicant");
      expect(page.image).toBe(render.pages[0].image);
      expect(x.render!.pages[1]).toEqual(render.pages[1]);
    }
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

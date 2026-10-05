// PRIVACY: fill values never leave the machine. A recorder over EVERY tool, fed
// distinctive sentinel values, proves no sentinel reaches a request (URL,
// headers, body), stderr/console, or any file under FENFILL_CACHE_DIR.

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { extractStampedText } from "@/e2e/helpers/pdfText";

import { setLogSink } from "../src/log.js";
import { TOOL_NAMES } from "../src/server.js";
import { connect, env, fixture, json, MockApi, pdfFor, pngBytes, tmp } from "./helpers.js";

const JOB = "11111111-2222-4333-8444-555555555555";
const RJOB = "99999999-2222-4333-8444-555555555555";
const TPL = "3f1b953e-0fe9-5154-84f2-285d8aff38f5";

const SENTINELS = [
  "Zqxv7Sentinel",
  "Wkjp3Sentinel",
  "Sentinel-Street 42",
  "SentinelDir9",
  "Qwerty8Sentinel",
];

let t: ReturnType<typeof tmp>;
const stderrChunks: string[] = [];

beforeEach(() => {
  t = tmp();
  stderrChunks.length = 0;
  setLogSink((line) => stderrChunks.push(line));
  const capture = (chunk: unknown) => {
    stderrChunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString(),
    );
    return true;
  };
  vi.spyOn(process.stderr, "write").mockImplementation(capture as typeof process.stderr.write);
  vi.spyOn(process.stdout, "write").mockImplementation(capture as typeof process.stdout.write);
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      stderrChunks.push(a.map(String).join(" "));
    });
  }
});

afterEach(() => {
  setLogSink(null);
  vi.restoreAllMocks();
  t.cleanup();
});

function walkFiles(d: string): string[] {
  let out: string[] = [];
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    out = e.isDirectory() ? out.concat(walkFiles(p)) : out.concat(p);
  }
  return out;
}

function leaks(haystack: string): string[] {
  const low = haystack.toLowerCase();
  return SENTINELS.filter((s) => low.includes(s.toLowerCase()));
}

describe("sentinel recorder over every tool", () => {
  it("no fill value reaches the network, stderr/console, or the cache", async () => {
    const cacheDir = join(t.dir, "cache");
    const fx = fixture("ungrouped_fields");
    const agent = fx.agent;
    // (The fixture's legacy floating note is dropped: the server refuses it on save.)
    const render = { ...fx.render, fields: fx.render.fields.filter((f) => f.type !== "note") };
    const pdfPath = join(t.dir, "form.pdf");
    writeFileSync(pdfPath, await pdfFor(render));
    const tplPdf = await pdfFor(render);

    // A signature image under a sentinel-named folder: its PATH is a value too.
    const sigDir = join(t.dir, "SentinelDir9");
    mkdirSync(sigDir);
    const sigPath = join(sigDir, "sig.png");
    writeFileSync(sigPath, pngBytes(120, 40));

    const mock = new MockApi()
      .analyzeFlow({ jobId: JOB, render, agent, pages: [1, 2] })
      .on("GET", /^\/v1\/account$/, () =>
        json(200, {
          workspace_id: "ws-1",
          tier: "team",
          scans_remaining: 5,
          max_pages: 100,
          max_pages_per_job: 60,
          max_file_mb: 50,
          branding: { logo: true, watermark: false },
        }),
      )
      .on("GET", /^\/v1\/account\/logo$/, () => new Response(pngBytes()))
      .on("GET", /^\/v1\/templates\?/, () =>
        json(200, { templates: [{ id: TPL, name: "Tax" }], next_cursor: null }),
      )
      .on("GET", new RegExp(`^/v1/templates/${TPL}\\?include=render$`), () =>
        json(200, { ...agent, template_id: TPL, updated_at: "2026-10-04T12:00:00Z", render }),
      )
      .on("PATCH", new RegExp(`^/v1/templates/${TPL}$`), () =>
        json(200, {
          template_id: TPL,
          updated_at: "2026-10-04T12:01:00Z",
          result: { ...agent, template_id: TPL, updated_at: "2026-10-04T12:01:00Z" },
        }),
      )
      .on("GET", new RegExp(`^/v1/templates/${TPL}$`), () =>
        json(200, { ...agent, template_id: TPL }),
      )
      .on(
        "GET",
        new RegExp(`^/v1/templates/${TPL}/pdf$`),
        () => new Response(new Uint8Array(tplPdf)),
      )
      .on("POST", new RegExp(`^/v1/templates/${TPL}/recipients$`), () =>
        json(201, { id: "r1", label: "Client", url: "https://fenfill.com/r/x", status: "pending" }),
      )
      .on("GET", new RegExp(`^/v1/templates/${TPL}/recipients$`), () =>
        json(200, { recipients: [] }),
      )
      .on("POST", new RegExp(`^/v1/templates/${TPL}/analyze$`), (req) => {
        // Only pages, kind and the version: never a value, never a file.
        const body = JSON.parse(req.body) as Record<string, unknown>;
        expect(Object.keys(body).sort()).toEqual(["expected_updated_at", "kind", "pages"]);
        return json(202, { job_id: RJOB, status: "queued", mode: "ai", pages: [2], cost: 1 });
      })
      .on("GET", new RegExp(`^/v1/jobs/${RJOB}\\?include=render$`), () =>
        json(200, {
          job_id: RJOB,
          status: "done",
          mode: "ai",
          phase: "done",
          progress: 100,
          pages: [2],
          cost: 1,
          created_at: "2026-10-05T00:00:00Z",
          template_id: TPL,
          error: null,
          result: { ...agent, template_id: TPL, updated_at: "2026-10-04T12:00:30Z" },
          render,
        }),
      );

    const c = await connect({ env: env(cacheDir), fetchImpl: mock.fetch });
    const byLabel = (l: string) => agent.fields.find((e) => e.label === l)!.id;
    const values = {
      [byLabel("Full name")]: SENTINELS[0],
      [byLabel("Additional notes")]: `${SENTINELS[1]}\n${SENTINELS[2]}`,
      [byLabel("City")]: SENTINELS[4],
      [byLabel("I agree to the terms")]: true,
      [byLabel("Signature")]: { image_path: sigPath },
      [byLabel("Date of birth")]: `not-a-date ${SENTINELS[1]}`,
      [`unknown-${SENTINELS[0]}`]: SENTINELS[2],
    };

    const results: Record<string, { isError: boolean; data: Record<string, unknown> }> = {};
    results.get_account = await c.call("get_account", {});
    results.list_templates = await c.call("list_templates", { limit: 5 });
    results.analyze_form = await c.call("analyze_form", { path: pdfPath });
    // The zero-retention session: analyze → reanalyze → edit → fill → preview → save.
    results.reanalyze_template = await c.call("reanalyze_template", {
      template_id: TPL,
      pages: "2",
      kind: "find",
    });
    const edit1 = await c.call("edit_template", {
      path: pdfPath,
      ops: [{ op: "move", id: byLabel("City"), dx: 0.01 }],
    });
    expect(edit1.isError).toBe(false);
    const out1 = join(t.dir, "filled-form.pdf");
    results.fill_form = await c.call("fill_form", { path: pdfPath, values, output_path: out1 });
    expect(results.fill_form.data.edited).toBe(true);
    const pv = await c.client.callTool({
      name: "preview_page",
      arguments: { path: pdfPath, page: 1, values, dpi: 50 },
    });
    results.preview_page = {
      isError: pv.isError === true,
      data: JSON.parse((pv.content as { text?: string }[])[1].text ?? "{}") as Record<
        string,
        unknown
      >,
    };
    results.get_template = await c.call("get_template", { template_id: TPL });
    const out2 = join(t.dir, "filled-template.pdf");
    results.fill_template = await c.call("fill_template", {
      template_id: TPL,
      values,
      output_path: out2,
    });
    results.edit_template = await c.call("edit_template", {
      template_id: TPL,
      ops: [
        { op: "relabel", id: byLabel("City"), label: "City / town" },
        {
          op: "add",
          page: 1,
          type: "text",
          box: { x: 0.1, y: 0.9, w: 0.3, h: 0.03 },
          label: "Phone",
        },
        // The 0.2.0 ops: a table built from loose fields and grown by a row, a
        // choice group, an autofill token — layout and wording only.
        {
          op: "group",
          kind: "table",
          label: "Identity",
          cells: [
            [byLabel("Full name"), byLabel("Email")],
            [byLabel("Date of birth"), byLabel("Issue date")],
          ],
          header_cols: ["Name", "Contact"],
        },
        {
          op: "group",
          kind: "choice",
          label: "Consent",
          ids: [byLabel("I agree to the terms"), byLabel("Witness signature")],
        },
        { op: "set_autofill", id: byLabel("Postal code").slice(0, 8), autofill: "postal-code" },
      ],
    });
    expect(results.edit_template.data.rejected).toEqual([]);
    const added = (
      results.edit_template.data.diff_summary as { added: { op_index: number; id: string }[] }
    ).added;
    const tableId = added.find((a) => a.op_index === 2)!.id;
    const choiceId = added.find((a) => a.op_index === 3)!.id;
    const more = await c.call("edit_template", {
      template_id: TPL,
      ops: [
        { op: "table_insert", id: tableId, axis: "row", index: 2 },
        { op: "set_column_type", id: tableId, index: 1, type: "text" },
        {
          op: "add_option",
          id: choiceId,
          label: "Maybe",
          box: { x: 0.3, y: 0.8, w: 0.02, h: 0.02 },
        },
      ],
    });
    expect(more.data.rejected).toEqual([]);
    await c.client.callTool({
      name: "preview_page",
      arguments: { template_id: TPL, page: 1, values },
    });
    results.save_template = await c.call("save_template", { template_id: TPL });
    // Re-analyzing after answers were filled this session still sends none of them.
    const again = await c.call("reanalyze_template", {
      template_id: TPL,
      pages: "2",
      kind: "relabel",
    });
    expect(again.isError).toBe(false);
    results.create_recipient_link = await c.call("create_recipient_link", {
      template_id: TPL,
      label: "Client",
    });
    results.get_recipient_status = await c.call("get_recipient_status", { template_id: TPL });
    await c.close();

    // Every tool ran, and succeeded.
    expect(Object.keys(results).sort()).toEqual([...TOOL_NAMES].sort());
    for (const [name, r] of Object.entries(results)) expect(r.isError, name).toBe(false);
    expect(results.fill_form.data.filled).toBeGreaterThanOrEqual(4);
    expect(results.fill_template.data.filled).toBeGreaterThanOrEqual(4);
    expect(results.save_template.data.saved).toBe(true);
    expect(mock.count("PATCH", /./)).toBe(1);
    expect(mock.count("POST", new RegExp(`^/v1/templates/${TPL}/analyze$`))).toBe(2);

    // The sentinels really were stamped (so the checks below are not vacuous)…
    const stamped = await extractStampedText(new Uint8Array(readFileSync(out1)), 0);
    expect(leaks(stamped).length).toBeGreaterThan(0);

    // …but never sent,
    expect(mock.calls.length).toBeGreaterThan(5);
    for (const call of mock.calls) {
      expect(leaks(call.url), call.url).toEqual([]);
      expect(leaks(JSON.stringify(call.headers)), call.url).toEqual([]);
      expect(leaks(call.body), call.url).toEqual([]);
    }
    // …never logged,
    expect(stderrChunks.length).toBeGreaterThan(0);
    expect(leaks(stderrChunks.join("\n"))).toEqual([]);
    // …and never cached (file names and contents, text and UTF-16).
    const files = walkFiles(cacheDir);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const raw = readFileSync(f);
      expect(leaks(f), f).toEqual([]);
      expect(leaks(raw.toString("latin1")), f).toEqual([]);
      expect(leaks(raw.toString("utf16le")), f).toEqual([]);
      expect(statSync(f).isFile()).toBe(true);
    }
  });
});

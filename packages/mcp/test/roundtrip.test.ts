// A real MCP client ↔ server round trip over the SDK's InMemoryTransport.

import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TOOL_NAMES } from "../src/server.js";
import { apiError, connect, type Connected, env, fixture, json, MockApi, tmp } from "./helpers.js";

let t: ReturnType<typeof tmp>;
let c: Connected | null = null;

beforeEach(() => {
  t = tmp();
});
afterEach(async () => {
  await c?.close();
  c = null;
  t.cleanup();
});

describe("InMemoryTransport round trip", () => {
  it("lists exactly the twelve tools, with annotations and no outputSchema", async () => {
    c = await connect({ env: env(join(t.dir, "cache")), fetchImpl: new MockApi().fetch });
    const { tools } = await c.client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(tools).toHaveLength(12);
    expect(tools.map((x) => x.name)).not.toContain("make_fillable");
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      // fill_form / fill_template carry the value-format guide (VALUE_SHAPES).
      expect(tool.description!.length, tool.name).toBeLessThan(1200);
      expect(tool.annotations, tool.name).toBeDefined();
      expect(tool.outputSchema, tool.name).toBeUndefined();
    }
    const byName = Object.fromEntries(tools.map((x) => [x.name, x]));
    for (const name of ["fill_form", "fill_template"]) {
      const d = byName[name].description!;
      for (const shape of [
        "YYYY-MM-DD",
        "boolean",
        "option id or label",
        "bare option text",
        "stamped exactly as given",
        "printed in the field's date_format",
        'signing_requirement "external"',
        "{cellId: value}",
        "image_path",
      ]) {
        expect(d, `${name}: ${shape}`).toContain(shape);
      }
    }
    expect(byName.fill_form.annotations).toMatchObject({ openWorldHint: false });
    expect(byName.get_account.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.analyze_form.inputSchema.properties).toHaveProperty("save_as_template");
    expect(byName.analyze_form.inputSchema.properties).toHaveProperty("detect_extra_blanks");
    expect(byName.preview_page.description).toMatch(/nothing is written to disk/);
    expect(byName.edit_template.description).toMatch(/never the user's answers/);
    expect(byName.save_template.description).toMatch(/never fill values/);
    const re = byName.reanalyze_template.description!;
    for (const must of [
      /unanalyzed_pages/,
      /analyzed_pages vs page_count/,
      /"scratch"/,
      /"find"/,
      /"relabel"/,
      /"label_missing"/,
      /1 page scan per page/,
      /free-label allowance/,
      /estimate: true/,
      /nothing is uploaded/,
      /relabel may reset table column types\/orientation; check get_template after/,
      /save_template\) or dropped \(discard: true\)/,
    ]) {
      expect(re).toMatch(must);
    }
    expect(byName.reanalyze_template.inputSchema.properties).toHaveProperty("kind");
    expect(c.client.getServerVersion()?.name).toBe("fenfill");
    expect(c.client.getInstructions()).toMatch(/never leave this machine/);
  });

  it("returns JSON text results, and isError with the API code and a hint", async () => {
    const account = {
      workspace_id: "ws",
      tier: "pro",
      scans_remaining: 3,
      max_pages: 100,
      max_pages_per_job: 60,
      max_file_mb: 50,
      branding: { logo: false, watermark: false },
    };
    let fail = false;
    const mock = new MockApi().on("GET", /^\/v1\/account$/, () =>
      fail ? apiError(401, "key_revoked") : json(200, account),
    );
    c = await connect({ env: env(join(t.dir, "cache")), fetchImpl: mock.fetch });
    const ok = await c.call("get_account", {});
    expect(ok).toEqual({ isError: false, data: account });
    fail = true;
    const bad = await c.call("get_account", {});
    expect(bad.isError).toBe(true);
    expect(bad.data.error).toMatchObject({
      code: "key_revoked",
      hint: expect.stringMatching(/new one/),
    });
  });

  it("get_template returns the compact view, narrowed by pages", async () => {
    const { agent } = fixture("expandable_tables");
    const id = "3f1b953e-0fe9-5154-84f2-285d8aff38f5";
    const mock = new MockApi().on("GET", new RegExp(`^/v1/templates/${id}$`), () =>
      json(200, { ...agent, template_id: id, name: "Expenses" }),
    );
    c = await connect({ env: env(join(t.dir, "cache")), fetchImpl: mock.fetch });
    const all = await c.call("get_template", { template_id: id });
    expect(all.data).toMatchObject({
      template_id: id,
      name: "Expenses",
      pages: "1-2",
      field_count: 3,
    });
    expect(JSON.stringify(all.data)).not.toContain('"box"');
    const p2 = await c.call("get_template", { template_id: id, pages: "2" });
    expect(p2.data).toMatchObject({ pages: "2", field_count: 1 });
  });

  it("a network tool without a key says how to fix it", async () => {
    c = await connect({
      env: { FENFILL_CACHE_DIR: join(t.dir, "cache") },
      fetchImpl: new MockApi().fetch,
    });
    const r = await c.call("list_templates", {});
    expect(r.data.error).toMatchObject({ code: "missing_api_key" });
  });
});

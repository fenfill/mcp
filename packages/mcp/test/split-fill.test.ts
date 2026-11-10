// Filling a split group through the MCP (P2b): a parts split takes ONE amount,
// which the shared fillCore `distributeParts` cuts over its [int, frac] boxes;
// a refusal is a skipped entry with the core's reason; a flow split (P4a-2)
// takes ONE string, stored under its flowKey and wrapped over its boxes by
// buildMarks; an edit + save keeps the split group.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildMarks, mapAgentValues, normalizeSchema } from "@/app/t/[template_id]/fillCore";
import { extractStampedText } from "@/e2e/helpers/pdfText";

import { EchoGuard } from "../src/echo.js";
import { applyOps } from "../src/edits.js";
import { legendRows } from "../src/preview.js";
import { projectAgentSchema } from "../src/project.js";
import type { RenderSchema } from "../src/types.js";
import { schemaIssues } from "../src/validate.js";
import { expandValueKeys } from "../src/values.js";
import {
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

/** split_groups without its malformed splits (g-loss and g-city name a missing
 *  box, which the server's validate_template refuses): a template that can be
 *  saved. */
function splitRender(): RenderSchema {
  const bad = new Set(["g-loss", "g-city"]);
  const r = structuredClone(fixture("split_groups").render);
  r.groups = r.groups.filter((g) => !bad.has(g.id));
  for (const f of r.fields) if (f.group && bad.has(f.group)) f.group = null;
  return r;
}
const render = splitRender();
const agent = projectAgentSchema(render, { name: "Split form" });

/** The fill-store values one agent `values` map makes, as fill_form maps them. */
function mapped(values: Record<string, unknown>) {
  const schema = normalizeSchema(render as unknown as Parameters<typeof normalizeSchema>[0]);
  return mapAgentValues(schema, expandValueKeys(render, values), {
    loadImage: () => new Uint8Array(),
  });
}

/** The text each member box stamps (buildMarks, the stamping core's own marks). */
function stamped(values: Record<string, unknown>): Record<string, string> {
  const m = mapped(values);
  const schema = normalizeSchema(render as unknown as Parameters<typeof normalizeSchema>[0]);
  const marks = buildMarks({
    fields: schema.fields,
    groups: schema.groups,
    values: m.values,
    rowCounts: m.rowCounts,
    pages: schema.pages,
  });
  const out: Record<string, string> = {};
  for (const page of marks.values()) for (const mk of page) out[mk.key] = mk.text;
  return out;
}

describe("a parts split takes one amount", () => {
  it("is listed as one number entry; a flow split as one text entry", () => {
    expect(schemaIssues(render)).toEqual([]);
    const byId = new Map(agent.fields.map((e) => [e.id, e]));
    expect(byId.get("g-income")).toMatchObject({
      type: "number",
      kind: "split",
      rule: "parts",
      frac_digits: 2,
      autofill: "transaction-amount",
    });
    expect(byId.has("f-inc-zl")).toBe(false);
    expect(byId.get("g-addr")).toMatchObject({
      type: "text",
      kind: "split",
      rule: "flow",
      label: "Home address",
      autofill: "street-address",
    });
    expect(byId.get("g-addr")).not.toHaveProperty("frac_digits");
    // D3: an unlabeled flow reads its first box's label.
    expect(byId.get("g-fn")).toMatchObject({ type: "text", label: "First names" });
    for (const id of ["f-addr-1", "f-addr-2", "f-addr-3", "f-fn-1"])
      expect(byId.has(id)).toBe(false);
  });

  it.each([
    [1234.56, "1234", "56"],
    ["1234.56", "1234", "56"],
    ["1 234,56", "1234", "56"],
    [1234, "1234", "00"],
    ["12.5", "12", "50"],
    [12.5, "12", "50"],
  ])("%j stamps its integer and fraction boxes", (v, int, frac) => {
    const r = mapped({ "g-income": v });
    expect(r.skipped).toEqual([]);
    expect(r.values).toMatchObject({ "ff-inc-zl": int, "ff-inc-gr": frac });
    expect(stamped({ "g-income": v })).toMatchObject({ "ff-inc-zl": int, "ff-inc-gr": frac });
  });

  it("a whole amount leaves the fraction box empty when pad_frac is false (and 0 digits)", () => {
    const r = mapped({ "g-tax": 1234 });
    expect(r.values).toMatchObject({ "ff-tax-zl": "1234", "ff-tax-gr": "" });
    expect(stamped({ "g-tax": 1234 })).not.toHaveProperty("ff-tax-gr");
  });

  it.each([
    [12.345, "This amount takes at most 2 decimal places."],
    ["12.345", "This amount takes at most 2 decimal places."],
    [-5, "Enter an amount without a minus sign."],
    ["-5", "Enter an amount without a minus sign."],
  ])("%j is refused with the core's reason, nothing stamped", (v, reason) => {
    const r = mapped({ "g-income": v });
    expect(r.skipped).toEqual([{ id: "g-income", reason }]);
    expect(r.values).not.toHaveProperty("ff-inc-zl");
    expect(r.values).not.toHaveProperty("ff-inc-gr");
  });

  it("an amount given to one of its boxes is pointed at the split", () => {
    const r = mapped({ "f-inc-zl": "1234" });
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].id).toBe("f-inc-zl");
    expect(r.skipped[0].reason).toMatch(/g-income/);
  });

  it("a flow split takes one string, stored whole and wrapped over its boxes", () => {
    const v = "ul. Długa 5\n00-950 Warszawa\nPolska";
    const r = mapped({ "g-addr": v });
    expect([r.skipped, r.filled]).toEqual([[], 1]);
    // D11: one value under s{gid}; nothing stored per box.
    expect(r.values).toEqual({ "sg-addr": v });
    // A line break moves on to the next box.
    expect(stamped({ "g-addr": v })).toEqual({
      "ff-addr-1": "ul. Długa 5",
      "ff-addr-2": "00-950 Warszawa",
      "ff-addr-3": "Polska",
    });
    // A box given at the top level is pointed at its flow.
    const box = mapped({ "f-addr-2": "x" });
    expect(box.skipped).toHaveLength(1);
    expect(box.skipped[0]).toMatchObject({
      id: "f-addr-2",
      reason: expect.stringMatching(/g-addr/),
    });
  });

  it("the preview legend lists a parts split as a number, a flow split as text", () => {
    const rows = legendRows(render, 1);
    expect(rows.find((r) => r.id === "g-income")).toMatchObject({
      type: "number",
      rule: "parts",
      frac_digits: 2,
    });
    const flow = rows.find((r) => r.id === "g-addr");
    expect(flow).toMatchObject({ type: "text", rule: "flow" });
    expect(flow).not.toHaveProperty("frac_digits");
    expect(rows.some((r) => r.id === "f-inc-zl" || r.id === "f-addr-2")).toBe(false);
  });

  it("the echo guard remembers a flow's text whole and line by line", () => {
    const g = new EchoGuard();
    g.remember(render, { "g-addr": "ul. Długa 5\n00-950 Warszawa" });
    const hit = (text: string) => g.check([{ id: "x", prop: "label", text }]).refuse.length > 0;
    expect(hit("ul. Długa 5")).toBe(true);
    expect(hit("00-950 Warszawa")).toBe(true);
    expect(hit("Home address")).toBe(false);
  });

  it("the echo guard remembers the amount as given and as its boxes read back", () => {
    const g = new EchoGuard();
    g.remember(render, { "g-income": "1 234,5" });
    const hit = (text: string) => g.check([{ id: "x", prop: "label", text }]).refuse.length > 0;
    expect(hit("1 234,5")).toBe(true); // as passed
    expect(hit("1234.50")).toBe(true); // joinSplit of the stamped boxes
    expect(hit("1234")).toBe(true); // the integer box
    expect(hit("Income gr")).toBe(false);
  });
});

describe("fill_form / edit_template / save_template with split groups", () => {
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

  async function server(mock: MockApi) {
    const c = await connect({ env: env(cacheDir), fetchImpl: mock.fetch, ...virtualClock() });
    open.push(c);
    return c;
  }

  it("fill_form stamps an amount over its boxes and reports a refused one as skipped", async () => {
    const pdfPath = join(t.dir, "form.pdf");
    writeFileSync(pdfPath, await pdfFor(render));
    const c = await server(new MockApi().analyzeFlow({ jobId: JOB, render, agent, pages: [1] }));
    expect((await c.call("analyze_form", { path: pdfPath })).data.status).toBe("done");

    const out = join(t.dir, "out.pdf");
    const r = await c.call("fill_form", {
      path: pdfPath,
      values: { "g-income": "1 234,56", "g-tax": 12.345, "g-addr": "Warszawa" },
      output_path: out,
    });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ filled: 2 });
    expect(r.data.warnings ?? []).toEqual([]);
    expect(r.data.skipped).toEqual([
      { id: "g-tax", reason: "This amount takes whole numbers only." },
    ]);
    const text = await extractStampedText(new Uint8Array(readFileSync(out)), 0);
    expect(text.split(" ")).toEqual(expect.arrayContaining(["1234", "56", "Warszawa"]));
    expect(text).not.toContain("1 234");

    // A flow too long for its boxes: the last box clips, and fill_form reports
    // it under the flow's id like an overlong text field.
    const long = Array.from({ length: 80 }, (_, i) => `Name${String(i)}`).join(" ");
    const out2 = join(t.dir, "out2.pdf");
    const r2 = await c.call("fill_form", {
      path: pdfPath,
      values: { "g-fn": long },
      output_path: out2,
    });
    expect(r2.isError).toBe(false);
    expect(r2.data).toMatchObject({ filled: 1, skipped: [] });
    expect(r2.data.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^g-fn: the text is wider than its box even at [\d.]+pt/),
      ]),
    );
    const text2 = await extractStampedText(new Uint8Array(readFileSync(out2)), 0);
    expect(text2).toContain("Name0");
  });

  it("an edit and a save keep the split groups, attributes and all", async () => {
    const r = applyOps(render, [
      { op: "relabel", id: "f-name", label: "Full legal name" },
      { op: "move", id: "g-income", dx: 0, dy: 0.01 },
    ]);
    expect(r.rejected).toEqual([]);
    expect(r.render.groups).toEqual(render.groups);
    // A box the split needs cannot be deleted on its own; the split can.
    const gr = applyOps(render, [{ op: "delete", id: "f-inc-gr" }]);
    expect(gr.rejected).toEqual([
      { op_index: 0, reason: expect.stringMatching(/split g-income.*both its boxes/) },
    ]);
    const flow = applyOps(render, [{ op: "delete", id: "f-addr-3" }]);
    expect(flow.rejected).toEqual([]);
    expect(flow.render.groups.find((g) => g.id === "g-addr")?.members).toEqual([
      "f-addr-1",
      "f-addr-2",
    ]);
    // ... but not below two boxes: that would break the flow.
    const fn = applyOps(render, [{ op: "delete", id: "f-fn-2" }]);
    expect(fn.rejected).toEqual([
      { op_index: 0, reason: expect.stringMatching(/split g-fn.*at least 2 boxes/) },
    ]);
    expect(applyOps(flow.render, [{ op: "delete", id: "f-addr-1" }]).rejected).toHaveLength(1);
    const whole = applyOps(render, [{ op: "delete", id: "g-income" }]);
    expect(whole.rejected).toEqual([]);
    expect(schemaIssues(whole.render)).toEqual([]);

    const tplPdf = await pdfFor(render);
    const mock = new MockApi()
      .on("GET", new RegExp(`^/v1/templates/${TPL}\\?include=render$`), () =>
        json(200, { ...agent, template_id: TPL, updated_at: V1, render }),
      )
      .on("GET", new RegExp(`^/v1/templates/${TPL}$`), () =>
        json(200, { ...agent, template_id: TPL, updated_at: V1 }),
      )
      .on(
        "GET",
        new RegExp(`^/v1/templates/${TPL}/pdf$`),
        () => new Response(new Uint8Array(tplPdf)),
      )
      .on("PATCH", new RegExp(`^/v1/templates/${TPL}$`), () =>
        json(200, { template_id: TPL, updated_at: V2, result: { ...agent, updated_at: V2 } }),
      );
    const c = await server(mock);
    const e = await c.call("edit_template", {
      template_id: TPL,
      ops: [{ op: "relabel", id: "g-income", label: "Annual income" }],
    });
    expect(e.data).toMatchObject({ applied: 1, rejected: [], saveable: true });
    const touched = (e.data.diff_summary as { touched: { id: string; type: string }[] }).touched;
    expect(touched).toEqual([expect.objectContaining({ id: "g-income", type: "number" })]);
    const s = await c.call("save_template", { template_id: TPL });
    expect(s.data).toMatchObject({ saved: true });
    const patch = mock.calls.find((x) => x.method === "PATCH")!;
    const body = JSON.parse(patch.body) as { schema: RenderSchema };
    expect(body.schema.groups).toEqual(
      render.groups.map((g) => (g.id === "g-income" ? { ...g, label: "Annual income" } : g)),
    );
    expect(body.schema.fields).toEqual(render.fields);
  });
});

// edit_template's ops engine, the local validation mirror, the echo guard and
// the PNG renderer, as units.

import { inflateSync } from "node:zlib";

import { PDFDocument, rgb } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { EchoGuard } from "../src/echo.js";
import { applyOps, changedWording, MAX_OPS, wordingOf } from "../src/edits.js";
import { encodePng, renderPage } from "../src/render.js";
import type { RenderSchema } from "../src/types.js";
import { schemaIssues } from "../src/validate.js";
import { fixture } from "./helpers.js";

const canon = (): RenderSchema => fixture("canonical").render;
const field = (s: RenderSchema, id: string) => s.fields.find((f) => f.id === id)!;
const group = (s: RenderSchema, id: string) => s.groups.find((g) => g.id === id)!;

describe("applyOps", () => {
  it("move (dx/dy and x/y) and resize work in page fractions, top-left origin", () => {
    const r = applyOps(canon(), [
      { op: "move", id: "f-text", dx: 0.05, dy: -0.02 },
      { op: "resize", id: "f-date", w: 0.3, h: 0.05 },
      { op: "move", id: "g-choice", x: 0.5, y: 0.5 },
    ]);
    expect(r.rejected).toEqual([]);
    expect(r.applied).toBe(3);
    const t = field(r.render, "f-text");
    expect(t.xpct).toBeCloseTo(15.5);
    expect(t.ypct).toBeCloseTo(10);
    const d = field(r.render, "f-date");
    expect(d.wpct).toBeCloseTo(30);
    expect(d.hpct).toBeCloseTo(5);
    // A group moves as a whole: its bbox top-left lands on (x, y), spacing kept.
    expect(field(r.render, "f-checkbox").xpct).toBeCloseTo(50);
    expect(field(r.render, "f-checkbox2").xpct).toBeCloseTo(58);
    expect(field(r.render, "f-checkbox").ypct).toBeCloseTo(50);
    const touched = r.diff_summary.touched.find((x) => x.id === "f-text")!;
    expect(touched.box.x).toBeCloseTo(0.155);
    expect(r.diff_summary.counts).toEqual({ move: 2, resize: 1 });
  });

  it("comb cells follow their field through move and resize", () => {
    const s = canon();
    const f = field(s, "f-text") as RenderSchema["fields"][number] & { cells: unknown[] };
    f.cells = [
      { x: 10.5, y: 12, w: 10, h: 4.5 },
      { x: 20.5, y: 12, w: 10, h: 4.5 },
    ];
    const r = applyOps(s, [{ op: "resize", id: "f-text", w: 0.1, h: 0.045 }]);
    const cells = field(r.render, "f-text").cells as { x: number; w: number }[];
    expect(cells[1].x).toBeCloseTo(15.5);
    expect(cells[1].w).toBeCloseTo(5);
  });

  it("relabel, retype, set_required/description/placeholder, set_format", () => {
    const r = applyOps(canon(), [
      { op: "relabel", id: "f-text", label: "  Total  " },
      { op: "retype", id: "f-date", type: "multiline" },
      { op: "retype", id: "g-choice", type: "multiselect" },
      { op: "set_required", id: "f-date", required: true },
      { op: "set_description", id: "f-text", description: null },
      { op: "set_placeholder", id: "g-choice", placeholder: "Pick one" },
      { op: "set_format", id: "f-text", format: { font_size: 9, text_anchor: null } },
    ]);
    expect(r.rejected).toEqual([]);
    const t = field(r.render, "f-text");
    expect(t.label).toBe("Total");
    expect(t.description).toBeUndefined();
    expect(t.format).toEqual({ variant: "currency", font_size: 9 });
    const d = field(r.render, "f-date");
    expect(d.type).toBe("text");
    expect(d.format).toMatchObject({ variant: "multiline" });
    expect(d.required).toBe(true);
    expect(group(r.render, "g-choice").format).toBe("multiple");
    expect(group(r.render, "g-choice").placeholder).toBe("Pick one");
    expect(schemaIssues(r.render)).toEqual([]);
  });

  it("add returns a new id; delete removes fields, members and emptied groups", () => {
    const r = applyOps(canon(), [
      {
        op: "add",
        page: 1,
        type: "signature",
        box: { x: 0.1, y: 0.8, w: 0.3, h: 0.05 },
        label: "Signature of spouse",
      },
      { op: "delete", id: "f-checkbox2" },
      { op: "delete", id: "f-comb" },
      { op: "delete", id: "g-table" },
    ]);
    expect(r.rejected).toEqual([]);
    const id = r.diff_summary.added[0].id;
    expect(r.diff_summary.added[0].op_index).toBe(0);
    const added = field(r.render, id);
    expect(added).toMatchObject({
      type: "signature",
      page: 1,
      xpct: 10,
      ypct: 80,
      section_id: "sec-1",
    });
    expect(group(r.render, "g-choice").members).toEqual(["f-checkbox"]);
    expect(r.render.groups.find((g) => g.id === "g-comb")).toBeUndefined(); // emptied
    expect(r.render.groups.find((g) => g.id === "g-table")).toBeUndefined();
    expect(r.render.fields.find((f) => f.id === "f-t1")).toBeUndefined();
    expect(r.diff_summary.deleted).toEqual(expect.arrayContaining(["f-checkbox2", "g-table"]));
    expect(schemaIssues(r.render)).toEqual([]);
  });

  it("group / ungroup / set_options", () => {
    const r = applyOps(canon(), [
      {
        op: "add",
        page: 1,
        type: "text",
        box: { x: 0.1, y: 0.9, w: 0.02, h: 0.02 },
        label: "A",
      },
      { op: "ungroup", id: "g-choice" },
    ]);
    const a = r.diff_summary.added[0].id;
    const r2 = applyOps(r.render, [
      { op: "group", ids: ["f-checkbox", a], kind: "choice", label: "Pick" },
      { op: "set_options", id: "PLACEHOLDER", options: ["x"] },
    ]);
    const gid = r2.diff_summary.added[0].id;
    expect(group(r2.render, gid)).toMatchObject({
      kind: "choice",
      format: "single",
      members: ["f-checkbox", a],
    });
    expect(field(r2.render, a)).toMatchObject({ type: "checkbox", group: gid });
    expect(r2.rejected[0].op_index).toBe(1);
    const r3 = applyOps(r2.render, [
      { op: "set_options", id: gid, options: ["Yes please", "Other"] },
      { op: "set_options", id: gid, options: [{ id: a, label: "Something else" }] },
      { op: "set_options", id: gid, options: ["only one"] },
    ]);
    expect(field(r3.render, "f-checkbox").label).toBe("Yes please");
    expect(field(r3.render, a).label).toBe("Something else");
    expect(r3.rejected.map((x) => x.op_index)).toEqual([2]);
    expect(r3.rejected[0].reason).toMatch(/has 2 options/);
    expect(schemaIssues(r3.render)).toEqual([]);
  });

  it("rejects bad ops with reasons and leaves the schema untouched", () => {
    const before = canon();
    const r = applyOps(before, [
      { op: "move", id: "nope", dx: 0.1 },
      { op: "move", id: "f-text", x: 0.95 }, // runs off the page
      { op: "resize", id: "f-text", w: 2, h: 0.1 },
      { op: "retype", id: "f-checkbox", type: "text" }, // a choice option
      { op: "retype", id: "f-text", type: "radio" },
      { op: "add", page: 9, type: "text", box: { x: 0, y: 0, w: 0.1, h: 0.1 }, label: "x" },
      { op: "set_format", id: "f-text", format: { font_size: 2 } },
      { op: "set_format", id: "f-text", format: { colour: "red" } },
      { op: "relabel", id: "f-text", label: "x".repeat(2001) },
      { op: "group", ids: ["f-text", "f-checkbox"], kind: "choice", label: "x" },
      { op: "add_row", id: "g-table" },
      { op: "set_description", id: "f-text", description: 42 },
    ]);
    expect(r.applied).toBe(0);
    expect(r.rejected.map((x) => x.op_index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const reasons = r.rejected.map((x) => x.reason).join("\n");
    expect(reasons).toMatch(/no field or group has id nope/);
    expect(reasons).toMatch(/lie on the page/);
    expect(reasons).toMatch(/font_size must be 6–96/);
    expect(reasons).toMatch(/colour is not a text format key/);
    expect(reasons).toMatch(/longer than 2000/);
    expect(reasons).toMatch(/already belongs to group g-choice/);
    expect(reasons).toMatch(/table rows\/columns can't be edited yet/);
    expect(r.render).toEqual(before);
  });

  it("checks page bounds on the batch's final state: move then resize is fine", () => {
    // f-text is 0.2 wide: at x 0.9 it overhangs the page until the resize.
    const r = applyOps(canon(), [
      { op: "move", id: "f-text", x: 0.9, y: 0.5 },
      { op: "resize", id: "f-text", w: 0.05, h: 0.03 },
    ]);
    expect(r.rejected).toEqual([]);
    expect(r.applied).toBe(2);
    const t = field(r.render, "f-text");
    expect(t.xpct).toBeCloseTo(90);
    expect(t.wpct).toBeCloseTo(5);
    expect(schemaIssues(r.render)).toEqual([]);
  });

  it("rejects only the geometry ops whose item ends off the page, keeping the rest", () => {
    const before = canon();
    const r = applyOps(before, [
      { op: "move", id: "f-text", x: 0.95 }, // still overhangs at the end
      { op: "relabel", id: "f-text", label: "Total" },
      { op: "resize", id: "f-date", w: 0.3, h: 0.05 },
      { op: "move", id: "nope", dx: 0.1 }, // structural: unknown id
    ]);
    expect(r.applied).toBe(2);
    expect(r.rejected.map((x) => x.op_index)).toEqual([0, 3]);
    expect(r.rejected[0].reason).toMatch(/lie on the page.*after the whole batch f-text/);
    expect(r.rejected[1].reason).toMatch(/no field or group has id nope/);
    const t = field(r.render, "f-text");
    expect(t.label).toBe("Total");
    expect(t.xpct).toBeCloseTo(field(before, "f-text").xpct as number);
    expect(field(r.render, "f-date").wpct).toBeCloseTo(30);
  });

  it("set_box places a field or a group absolutely in one step", () => {
    const r = applyOps(canon(), [
      { op: "set_box", id: "f-text", x: 0.5, y: 0.6, w: 0.3, h: 0.04 },
      { op: "set_box", id: "g-choice", x: 0.1, y: 0.8, w: 0.2, h: 0.05 },
      { op: "set_box", id: "f-date", x: 0.9, y: 0.1, w: 0.3, h: 0.05 }, // off the page
      { op: "set_box", id: "f-date", x: 0.1, y: 0.1, w: 0, h: 0.05 },
    ]);
    expect(r.rejected.map((x) => x.op_index)).toEqual([2, 3]);
    expect(r.rejected[0].reason).toMatch(/lie on the page/);
    expect(r.rejected[1].reason).toMatch(/positive width and height/);
    const t = field(r.render, "f-text");
    expect(
      [t.xpct, t.ypct, t.wpct, t.hpct].map((n) => Math.round((n as number) * 100) / 100),
    ).toEqual([50, 60, 30, 4]);
    const box = r.diff_summary.touched.find((x) => x.id === "g-choice")!.box;
    expect(box).toEqual({ x: 0.1, y: 0.8, w: 0.2, h: 0.05 });
    expect(r.diff_summary.counts).toEqual({ set_box: 2 });
  });

  it(`caps nothing itself but MAX_OPS is ${String(MAX_OPS)}`, () => {
    expect(MAX_OPS).toBe(200);
  });
});

describe("schemaIssues (the server's validate_template, mirrored)", () => {
  it("accepts every agent-schema fixture it is given clean, and refuses what the server would", () => {
    expect(schemaIssues(canon())).toEqual([]);
    const s = canon();
    (s.fields[0] as Record<string, unknown>).value = "x"; // a value-like key
    (s.fields[1] as Record<string, unknown>).format = { shape: "hex" };
    (s.groups[0] as Record<string, unknown>).format = "classic";
    (s.groups[0] as Record<string, unknown>).members = ["ghost"];
    (s as Record<string, unknown>).notes = [];
    const msgs = schemaIssues(s).map((i) => `${i.path} ${i.reason}`);
    expect(msgs).toEqual(
      expect.arrayContaining([
        "fields.0.value is not a field key",
        "fields.1.format.shape must be square or round",
        "groups.0.format must be one of single, multiple",
        "groups.0.members.0 names a field that doesn't exist (ghost)",
        "notes is not a template key",
      ]),
    );
  });
});

describe("EchoGuard", () => {
  it("remembers free-text answers only, refuses ≥4 chars, warns below", () => {
    const g = new EchoGuard();
    g.remember(canon(), {
      "f-text": "  1234.50 ",
      "f-date": "2020-01-02",
      "g-comb": "AB",
      "g-choice": "Yes", // an option choice: not remembered
      "g-table": { "f-t1": true },
    });
    const res = g.check([
      { id: "a", text: "1234.50" },
      { id: "b", text: "ab" },
      { id: "c", text: "Yes" },
      { id: "d", text: "2020-01-02 " },
    ]);
    expect(res.refuse.sort()).toEqual(["a", "d"]);
    expect(res.warn).toEqual(["b"]);
  });

  it("catches an answer inside longer wording (6+ chars), exact-only at 4-5, warns under 4", () => {
    const g = new EchoGuard();
    g.remember(canon(), { "f-text": "Jan Kowalski", "f-date": "Kraj", "g-comb": "PL" });
    const res = g.check([
      { id: "a", text: "Name:  JAN kowalski (as in passport)" }, // contains a 12-char answer
      { id: "b", text: "Krajowy" }, // contains a 4-char answer: not an echo
      { id: "c", text: " kraj " }, // equals it
      { id: "d", text: "pl" }, // equals a 2-char answer: warn
      { id: "e", text: "Place of birth" }, // contains "pl"… but too short to matter
    ]);
    expect(res.refuse.sort()).toEqual(["a", "c"]);
    expect(res.warn).toEqual(["d"]);
  });

  it("applyOps rejects an op whose wording (label, description, date format, symbol…) echoes an answer, never naming the text", () => {
    const g = new EchoGuard();
    g.remember(canon(), { "f-text": "Jan Kowalski", "f-date": "Kraj", "g-comb": "PL" });
    const added = applyOps(canon(), [
      {
        op: "add",
        page: 1,
        type: "checkbox",
        box: { x: 0.1, y: 0.9, w: 0.02, h: 0.02 },
        label: "I agree",
      },
    ]);
    const box = added.diff_summary.added[0].id;
    const r = applyOps(
      added.render,
      [
        { op: "relabel", id: "f-text", label: "Name: Jan Kowalski" }, // 0 contains
        { op: "relabel", id: "f-signature", label: "Krajowy podpis" }, // 1 ok
        { op: "set_description", id: "f-text", description: "KRAJ" }, // 2 exact 4
        { op: "set_format", id: "f-date", format: { date_format: "jan kowalski" } }, // 3
        { op: "set_format", id: "g-comb", format: { date_format: "Kraj" } }, // 4
        { op: "set_format", id: box, format: { symbol: "kraj" } }, // 5
        { op: "set_placeholder", id: "f-text", placeholder: "PL" }, // 6 warn
        {
          op: "add",
          page: 1,
          type: "text",
          box: { x: 0.1, y: 0.8, w: 0.2, h: 0.03 },
          label: "Jan Kowalski",
        }, // 7
      ],
      (w) => g.check(w),
    );
    expect(r.rejected.map((x) => x.op_index)).toEqual([0, 2, 3, 4, 5, 7]);
    expect(r.applied).toBe(2);
    const reasons = JSON.stringify(r.rejected);
    expect(reasons).not.toMatch(/kowalski|kraj/i);
    expect(r.rejected[0].reason).toMatch(/label of f-text/);
    expect(r.rejected[2].reason).toMatch(/format\.date_format of f-date/);
    expect(r.rejected[4].reason).toMatch(/format\.symbol/);
    expect(r.warnings.join(" ")).toMatch(/placeholder of f-text: short wording/);
    expect(field(r.render, "f-text").label).not.toMatch(/kowalski/i);
    expect(field(r.render, "f-signature").label).toBe("Krajowy podpis");
    // Without a screen nothing changes.
    expect(
      applyOps(canon(), [{ op: "relabel", id: "f-text", label: "Jan Kowalski" }]).applied,
    ).toBe(1);
  });

  it("changedWording reports id + property of new or changed text", () => {
    const next = applyOps(canon(), [
      { op: "relabel", id: "f-text", label: "Amount due" },
      { op: "set_format", id: "f-date", format: { date_format: "YYYY" } },
    ]).render;
    expect(
      changedWording(canon(), next)
        .map((w) => `${w.id}:${w.prop}`)
        .sort(),
    ).toEqual(["f-date:format.date_format", "f-text:label"]);
  });

  it("wordingOf lists labels, descriptions, placeholders, options and section titles", () => {
    const w = wordingOf(canon()).map((x) => x.text);
    expect(w).toEqual(
      expect.arrayContaining(["Amount", "Total due in PLN", "0.00", "Yes", "Confirm"]),
    );
    // …and the free-text formats: a checkbox symbol, a comb's date format.
    const props = wordingOf(canon()).map((x) => `${x.id}:${x.prop}`);
    expect(props).toEqual(
      expect.arrayContaining(["f-checkbox:format.symbol", "g-comb:date_format"]),
    );
  });
});

describe("render (pdfium wasm) + PNG", () => {
  it("renders a page to a valid PNG with the right dimensions", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.drawRectangle({ x: 72, y: 72, width: 144, height: 72, color: rgb(1, 0, 0) });
    const pdf = await doc.save();
    const r = await renderPage(pdf, 1, 72);
    expect([r.width, r.height]).toEqual([612, 792]);
    // The red box is there (pdf-lib bottom-left y=72 → raster row 792-72-36 from the top).
    const px = (x: number, y: number) => [
      ...r.rgba.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 3),
    ];
    expect(px(144, 792 - 108)).toEqual([255, 0, 0]);
    expect(px(10, 10)).toEqual([255, 255, 255]);
    const png = encodePng(r);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = Buffer.from(png);
    expect(view.toString("latin1", 12, 16)).toBe("IHDR");
    expect(view.readUInt32BE(16)).toBe(612);
    expect(view.readUInt32BE(20)).toBe(792);
    const idatLen = view.readUInt32BE(33);
    expect(view.toString("latin1", 37, 41)).toBe("IDAT");
    expect(inflateSync(view.subarray(41, 41 + idatLen)).length).toBe((612 * 3 + 1) * 792);
    await expect(renderPage(pdf, 2, 72)).rejects.toMatchObject({ code: "invalid_page" });
  });
});

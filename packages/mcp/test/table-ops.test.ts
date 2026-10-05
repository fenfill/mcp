// The 0.2.0 edit ops: tables (group table, insert/delete a line, add/adopt a
// cell, column types, orientation, headers), choice options, autofill, date
// formats, short ids and snap — against small hand-built schemas shaped like
// the gold corrections (the intake hospitalization grid, Schengen §42).

import { describe, expect, it } from "vitest";

import { applyOps, type Snapper } from "../src/edits.js";
import { legendChanges, legendPrints, legendRows } from "../src/preview.js";
import type { RenderSchema } from "../src/types.js";
import { schemaIssues } from "../src/validate.js";
import { fixture } from "./helpers.js";

type F = RenderSchema["fields"][number];
type G = RenderSchema["groups"][number];

const fld = (id: string, x: number, y: number, over: Record<string, unknown> = {}): F =>
  ({
    id,
    label: id,
    type: "text",
    format: { variant: "any" },
    page: 1,
    section_id: "sec-1",
    xpct: x,
    ypct: y,
    wpct: 20,
    hpct: 3,
    group: null,
    ...over,
  }) as F;

/** Three loose rows of (date, reason) — the intake p1 hospitalization entries. */
function loose(): RenderSchema {
  return {
    version: 5,
    pages: [
      {
        page: 1,
        width: 1000,
        height: 1400,
        image: "https://example.invalid/p1.png",
        sections: [{ id: "sec-1", title: "History" }],
      },
    ],
    fields: [
      fld("aaaaaa01-d0", 10, 20, { type: "date", format: { date_format: "DD/MM/YYYY" } }),
      fld("aaaaaa01-r0", 40, 20),
      fld("aaaaaa02-d1", 10, 25), // typed text: the group op makes the column date
      fld("aaaaaa02-r1", 40, 25),
      fld("aaaaaa03-d2", 10, 30),
      fld("aaaaaa03-r2", 40, 30),
      fld("bbbbbb01-a", 10, 60, { type: "checkbox", format: { shape: "round", symbol: "●" } }),
      fld("bbbbbb02-b", 20, 60, { type: "checkbox", format: { shape: "round", symbol: "●" } }),
      fld("cccccc01-name", 10, 80, { autofill: "name" }),
    ],
    groups: [
      {
        id: "gggggg-choice",
        kind: "choice",
        format: "single",
        label: "Marital status",
        page: 1,
        members: ["bbbbbb01-a", "bbbbbb02-b"],
      } as G,
    ],
  } as RenderSchema;
}

const F_ = (s: RenderSchema, id: string) => s.fields.find((f) => f.id === id)!;
const G_ = (s: RenderSchema, id: string) => s.groups.find((g) => g.id === id)!;

const GRID = [
  ["aaaaaa01-d0", "aaaaaa01-r0"],
  ["aaaaaa02-d1", "aaaaaa02-r1"],
  ["aaaaaa03-d2", "aaaaaa03-r2"],
];

function tabled(extra: Record<string, unknown> = {}) {
  const r = applyOps(loose(), [
    {
      op: "group",
      kind: "table",
      label: "Hospitalizations",
      cells: GRID,
      header_cols: ["Date", "Reason"],
      ...extra,
    },
  ]);
  expect(r.rejected).toEqual([]);
  const gid = r.diff_summary.added[0].id;
  return { r, s: r.render, gid };
}

describe("group kind table", () => {
  it("builds a table from a grid of loose fields, typing each column by its first typed cell", () => {
    const { r, s, gid } = tabled();
    const g = G_(s, gid);
    expect(g).toMatchObject({
      kind: "table",
      format: "classic",
      orientation: "col",
      rows: 3,
      cols: 2,
      grid: GRID,
      header_cols: ["Date", "Reason"],
      header_rows: ["", "", ""],
    });
    expect(F_(s, "aaaaaa02-d1")).toMatchObject({ type: "date", group: gid });
    expect(F_(s, "aaaaaa03-r2").type).toBe("text");
    expect(r.warnings.join(" ")).toMatch(/columns 0 mixed types/);
    expect(r.diff_summary.touched[0]).toMatchObject({ id: gid, type: "table" });
    expect(schemaIssues(s)).toEqual([]);
  });

  it("lays out ids from their boxes when no grid is given (the editor's reconstructGrid)", () => {
    const r = applyOps(loose(), [
      { op: "group", kind: "table", label: "T", ids: GRID.flat().reverse() },
    ]);
    expect(r.rejected).toEqual([]);
    expect(G_(r.render, r.diff_summary.added[0].id).grid).toEqual(GRID);
  });

  it("refuses ragged grids, grouped fields, wrong header lengths, row-typed expandable", () => {
    const r = applyOps(loose(), [
      { op: "group", kind: "table", label: "T", cells: [["aaaaaa01-d0"], ["aaaaaa01-r0", null]] },
      { op: "group", kind: "table", label: "T", cells: [["bbbbbb01-a", "aaaaaa01-r0"]] },
      { op: "group", kind: "table", label: "T", cells: GRID, header_cols: ["Date"] },
      {
        op: "group",
        kind: "table",
        label: "T",
        cells: GRID,
        format: "expandable",
        orientation: "row",
      },
      { op: "group", kind: "table", label: "T", cells: [["aaaaaa01-d0", "aaaaaa01-d0"]] },
    ]);
    expect(r.applied).toBe(0);
    const reasons = r.rejected.map((x) => x.reason);
    expect(reasons[0]).toMatch(/same number of columns/);
    expect(reasons[1]).toMatch(/already belongs to group gggggg-choice/);
    expect(reasons[2]).toMatch(/header_cols must be a list of 2 strings/);
    expect(reasons[3]).toMatch(/expandable table is typed by its columns/);
    expect(reasons[4]).toMatch(/appears twice/);
  });

  it("a checkbox_matrix makes every cell a checkbox", () => {
    const { s } = tabled({ format: "checkbox_matrix" });
    expect(GRID.flat().every((id) => F_(s, id).type === "checkbox")).toBe(true);
  });
});

describe("table_insert / table_delete", () => {
  it("appends a row one pitch below, cells aligned to their columns and typed by them", () => {
    const { s, gid } = tabled();
    const r = applyOps(s, [{ op: "table_insert", id: gid, axis: "row", index: 3 }]);
    expect(r.rejected).toEqual([]);
    const g = G_(r.render, gid);
    expect(g.rows).toBe(4);
    expect(g.header_rows).toEqual(["", "", "", ""]);
    const [d3, r3] = (g.grid as string[][])[3];
    expect(F_(r.render, d3)).toMatchObject({ type: "date", xpct: 10, ypct: 35, hpct: 3 });
    expect(F_(r.render, r3)).toMatchObject({ type: "text", xpct: 40, ypct: 35 });
    expect(F_(r.render, d3).label).toBe("Date — row 4");
    expect(schemaIssues(r.render)).toEqual([]);
  });

  it("inserts a column between two with an explicit x/w, as a new typed driving line", () => {
    const { s, gid } = tabled();
    const r = applyOps(s, [
      {
        op: "table_insert",
        id: gid,
        axis: "col",
        index: 1,
        box: { x: 0.31, w: 0.08 },
        header: "Hospital",
        type: "number",
      },
    ]);
    expect(r.rejected).toEqual([]);
    const g = G_(r.render, gid);
    expect(g.header_cols).toEqual(["Date", "Hospital", "Reason"]);
    const mid = (g.grid as string[][]).map((row) => row[1]);
    expect(mid.map((id) => F_(r.render, id).format)).toEqual(Array(3).fill({ variant: "number" }));
    expect(F_(r.render, mid[0])).toMatchObject({ xpct: 31, wpct: 8, ypct: 20 });
  });

  it("refuses a between-rows insert with no room unless a box is given", () => {
    const { s, gid } = tabled();
    const r = applyOps(s, [{ op: "table_insert", id: gid, axis: "row", index: 1 }]);
    expect(r.rejected[0].reason).toMatch(/no room for a new row between rows 0 and 1; pass box/);
  });

  it("deletes a row with its cells, or keeps them as loose fields", () => {
    const { s, gid } = tabled();
    const del = applyOps(s, [{ op: "table_delete", id: gid, axis: "row", index: 0 }]);
    expect(G_(del.render, gid).rows).toBe(2);
    expect(del.render.fields.some((f) => f.id === "aaaaaa01-d0")).toBe(false);
    expect(del.diff_summary.deleted).toEqual(["aaaaaa01-d0", "aaaaaa01-r0"]);
    const keep = applyOps(s, [
      { op: "table_delete", id: gid, axis: "col", index: 1, keep_cells: true },
    ]);
    expect(G_(keep.render, gid)).toMatchObject({ cols: 1, header_cols: ["Date"] });
    expect(F_(keep.render, "aaaaaa01-r0").group).toBeNull();
    expect(schemaIssues(keep.render)).toEqual([]);
  });
});

describe("table_add_cell / table_adopt", () => {
  function withHole() {
    const { s, gid } = tabled();
    const r = applyOps(s, [{ op: "delete", id: "aaaaaa02-r1" }]);
    expect(r.warnings.join(" ")).toMatch(/empty slot in table/);
    return { s: r.render, gid };
  }

  it("fills an empty slot from its row × column geometry, typed by its column", () => {
    const { s, gid } = withHole();
    const r = applyOps(s, [{ op: "table_add_cell", id: gid, row: 1, col: 1 }]);
    expect(r.rejected).toEqual([]);
    const id = r.diff_summary.added[0].id;
    expect((G_(r.render, gid).grid as string[][])[1][1]).toBe(id);
    expect(F_(r.render, id)).toMatchObject({ xpct: 40, ypct: 25, type: "text", group: gid });
    const again = applyOps(r.render, [{ op: "table_add_cell", id: gid, row: 1, col: 1 }]);
    expect(again.rejected[0].reason).toMatch(/already holds/);
  });

  it("adopts a loose field into a slot and retypes it to its column, with a warning", () => {
    const { s, gid } = withHole();
    const r = applyOps(s, [
      { op: "add", page: 1, type: "date", box: { x: 0.4, y: 0.25, w: 0.2, h: 0.03 }, label: "x" },
    ]);
    const loose = r.diff_summary.added[0].id;
    const a = applyOps(r.render, [{ op: "table_adopt", id: gid, field: loose, row: 1, col: 1 }]);
    expect(a.rejected).toEqual([]);
    expect(F_(a.render, loose)).toMatchObject({ type: "text", group: gid });
    expect(a.warnings.join(" ")).toMatch(/was date and is now text/);
    expect(schemaIssues(a.render)).toEqual([]);
  });

  it("refuses to adopt a field already in a group", () => {
    const { s, gid } = withHole();
    const r = applyOps(s, [{ op: "table_adopt", id: gid, field: "bbbbbb01-a", row: 1, col: 1 }]);
    expect(r.rejected[0].reason).toMatch(/belongs to group gggggg-choice/);
  });
});

describe("set_column_type / set_orientation / set_header / set_format on a cell", () => {
  it("types a whole column at once (TableAxisEditor), with an optional date format", () => {
    const { s, gid } = tabled();
    const r = applyOps(s, [
      { op: "set_column_type", id: gid, index: 1, type: "currency" },
      { op: "set_column_type", id: gid, index: 0, type: "date", date_format: "DD.MM.YYYY" },
      { op: "set_column_type", id: gid, index: 0, type: "date", date_format: "D/M" },
    ]);
    expect(r.applied).toBe(2);
    expect(r.rejected[0].reason).toMatch(/date_format must be one of/);
    expect(F_(r.render, "aaaaaa03-r2").format).toEqual({ variant: "currency" });
    expect(F_(r.render, "aaaaaa03-d2").format).toEqual({ date_format: "DD.MM.YYYY" });
  });

  it("flips orientation, resetting every cell to text", () => {
    const { s, gid } = tabled();
    const r = applyOps(s, [{ op: "set_orientation", id: gid, orientation: "row" }]);
    expect(G_(r.render, gid).orientation).toBe("row");
    expect(F_(r.render, "aaaaaa01-d0")).toMatchObject({ type: "text", format: { variant: "any" } });
    expect(r.warnings.join(" ")).toMatch(/reset to text/);
  });

  it("set_format on one cell applies to its whole column; retype on a cell points to set_column_type", () => {
    const { s, gid } = tabled();
    const r = applyOps(s, [
      { op: "set_format", id: "aaaaaa01-r0", format: { variant: "number" } },
      { op: "retype", id: "aaaaaa01-r0", type: "date" },
      { op: "retype", id: gid, type: "date" },
    ]);
    expect(r.applied).toBe(1);
    expect(F_(r.render, "aaaaaa03-r2").format).toMatchObject({ variant: "number" });
    expect(r.warnings.join(" ")).toMatch(/applied to all 3 cells of column 1/);
    expect(r.rejected[0].reason).toMatch(/use set_column_type/);
    expect(r.rejected[1].reason).toMatch(/use set_column_type/);
  });

  it("sets a header", () => {
    const { s, gid } = tabled();
    const r = applyOps(s, [{ op: "set_header", id: gid, axis: "row", index: 2, text: "Third" }]);
    expect(G_(r.render, gid).header_rows).toEqual(["", "", "Third"]);
  });

  it("works on a fixture table without rebuilding its grid", () => {
    const s = fixture("classic_tables").render;
    const gid = "391f4376-9964-5238-bb76-582e8a0772f7";
    const r = applyOps(s, [{ op: "table_add_cell", id: gid, row: 1, col: 2 }]);
    expect(r.rejected).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(G_(r.render, gid).grid as unknown[][]).toHaveLength(2);
  });
});

describe("choice options", () => {
  it("add_option keeps the group id and copies a sibling's checkbox format", () => {
    const r = applyOps(loose(), [
      {
        op: "add_option",
        id: "gggggg-choice",
        label: "Divorced",
        box: { x: 0.3, y: 0.6, w: 0.02, h: 0.02 },
      },
    ]);
    expect(r.rejected).toEqual([]);
    const id = r.diff_summary.added[0].id;
    expect(G_(r.render, "gggggg-choice").members).toEqual(["bbbbbb01-a", "bbbbbb02-b", id]);
    expect(F_(r.render, id)).toMatchObject({
      type: "checkbox",
      group: "gggggg-choice",
      format: { shape: "round", symbol: "●" },
    });
    expect(r.diff_summary.touched.map((t) => t.id).sort()).toEqual(["gggggg-choice", id].sort());
  });

  it("remove_option deletes the option but keeps the group, never below 2", () => {
    const added = applyOps(loose(), [
      {
        op: "add_option",
        id: "gggggg-choice",
        label: "C",
        box: { x: 0.3, y: 0.6, w: 0.02, h: 0.02 },
      },
    ]).render;
    const r = applyOps(added, [
      { op: "remove_option", id: "gggggg-choice", option: "bbbbbb01-a" },
      { op: "remove_option", id: "gggggg-choice", option: "bbbbbb02-b" },
    ]);
    expect(r.applied).toBe(1);
    expect(r.rejected[0].reason).toMatch(/at least 2 options/);
    expect(G_(r.render, "gggggg-choice").members).not.toContain("bbbbbb01-a");
  });
});

describe("set_autofill and date formats", () => {
  it("clears or sets a WHATWG token; anything else is refused with the list", () => {
    const r = applyOps(loose(), [
      { op: "set_autofill", id: "cccccc01-name", autofill: null },
      { op: "set_autofill", id: "aaaaaa01-r0", autofill: "postal-code" },
      { op: "set_autofill", id: "aaaaaa01-r0", autofill: "surname" },
      { op: "set_autofill", id: "gggggg-choice", autofill: "name" },
    ]);
    expect(r.applied).toBe(2);
    expect("autofill" in F_(r.render, "cccccc01-name")).toBe(false);
    expect(F_(r.render, "aaaaaa01-r0").autofill).toBe("postal-code");
    expect(r.rejected[0].reason).toMatch(/autofill must be one of name, given-name/);
    expect(r.rejected[1].reason).toMatch(/is a group, not a field/);
  });

  it("set_format date_format accepts only DATE_FORMATS", () => {
    const r = applyOps(loose(), [
      { op: "set_format", id: "aaaaaa01-d0", format: { date_format: "DD.MM.YYYY" } },
      { op: "set_format", id: "aaaaaa01-d0", format: { date_format: "D MMM YYYY" } },
    ]);
    expect(r.applied).toBe(1);
    expect(r.rejected[0].reason).toBe(
      "date_format must be one of DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD, DD.MM.YYYY, DD-MM-YYYY",
    );
  });
});

describe("short ids", () => {
  it("takes an unambiguous prefix of 6+ characters for any id argument", () => {
    const r = applyOps(loose(), [
      { op: "relabel", id: "cccccc", label: "Full name" },
      { op: "group", kind: "table", label: "T", cells: [["aaaaaa01-d", "aaaaaa01-r"]] },
    ]);
    expect(r.rejected).toEqual([]);
    expect(F_(r.render, "cccccc01-name").label).toBe("Full name");
  });

  it("refuses an ambiguous prefix with the candidates, and one under 6 characters", () => {
    const r = applyOps(loose(), [
      { op: "relabel", id: "aaaaaa", label: "x" },
      { op: "relabel", id: "ccccc", label: "x" },
    ]);
    expect(r.rejected[0].reason).toMatch(
      /id aaaaaa is ambiguous: it starts 6 ids \(aaaaaa01-d0, aaaaaa01-r0, .*\); use more characters/,
    );
    expect(r.rejected[1].reason).toMatch(/at least 6 characters/);
  });

  it("resolves an id added earlier in the same batch", () => {
    const r = applyOps(loose(), [
      { op: "add", page: 1, type: "text", box: { x: 0.5, y: 0.9, w: 0.1, h: 0.02 }, label: "x" },
    ]);
    const id = r.diff_summary.added[0].id;
    const r2 = applyOps(r.render, [{ op: "relabel", id: id.slice(0, 8), label: "y" }]);
    expect(r2.rejected).toEqual([]);
  });
});

describe("snap", () => {
  const snapper: Snapper = (_page, box, mode) =>
    mode === "underline"
      ? { box: { x: box.x, y: 0.5, w: 0.3, h: 0.02 } }
      : { none: "no ruled cell near the box" };

  it("replaces the op's box with the snapped one, or keeps it with a warning", () => {
    const r = applyOps(
      loose(),
      [
        { op: "set_box", id: "aaaaaa01-r0", x: 0.4, y: 0.49, w: 0.2, h: 0.03, snap: "underline" },
        { op: "move", id: "aaaaaa02-r1", dy: 0.01, snap: "cell" },
        { op: "move", id: "gggggg-choice", dy: 0.01, snap: "cell" },
      ],
      undefined,
      { snap: snapper },
    );
    expect(r.applied).toBe(2);
    expect(F_(r.render, "aaaaaa01-r0")).toMatchObject({ ypct: 50, wpct: 30, hpct: 2 });
    expect(F_(r.render, "aaaaaa02-r1").ypct).toBeCloseTo(26);
    expect(r.warnings.join(" ")).toMatch(/snap cell found no ruled cell near the box/);
    expect(r.rejected[0].reason).toMatch(/snap applies to a single field/);
  });

  it("refuses snap when no render is available", () => {
    const r = applyOps(loose(), [{ op: "move", id: "aaaaaa01-r0", dy: 0.01, snap: "underline" }]);
    expect(r.rejected[0].reason).toMatch(/needs the page render/);
  });
});

describe("0.2.0 polish: set_headers, reorder, per-op outcomes, partial date formats", () => {
  it("set_headers writes several headers of one axis in one op, from start", () => {
    const { s, gid } = tabled();
    const r = applyOps(s, [
      { op: "set_headers", id: gid, axis: "row", texts: ["One", "Two"] },
      { op: "set_headers", id: gid, axis: "row", texts: ["Three"], start: 2 },
      { op: "set_headers", id: gid, axis: "col", texts: ["A", "B", "C"] },
    ]);
    expect(r.applied).toBe(2);
    expect(r.rejected[0].reason).toMatch(
      /has 2 columns; 3 texts from start 0 run past the last one/,
    );
    expect(G_(r.render, gid).header_rows).toEqual(["One", "Two", "Three"]);
  });

  it("reorder moves the listed entries together to where the first one sat, stamping order", () => {
    const s = loose();
    // Reading order by geometry: the 6 row fields (y 20–30), the choice (y 60), the name (y 80).
    const r = applyOps(s, [{ op: "reorder", page: 1, ids: ["cccccc01-name", "gggggg-choice"] }]);
    expect(r.rejected).toEqual([]);
    const order = (id: string) =>
      (r.render.fields.find((f) => f.id === id) ?? r.render.groups.find((g) => g.id === id))!.order;
    // The choice sat first of the two (y 60): the pair lands there, name first.
    expect(order("aaaaaa03-r2")).toBe(5);
    expect(order("cccccc01-name")).toBe(6);
    expect(order("gggggg-choice")).toBe(7);
    // Options aren't entries: reorder their group.
    const bad = applyOps(s, [{ op: "reorder", page: 1, ids: ["bbbbbb01-a"] }]);
    expect(bad.rejected[0].reason).toMatch(
      /option\/cell of group gggggg-choice; reorder the group/,
    );
    expect(schemaIssues(r.render)).toEqual([]);
  });

  it("diff_summary.ops flags a no-op and says whether a snap landed", () => {
    const snap: Snapper = (_p, box) =>
      box.x < 0.3 ? { box: { ...box, y: box.y + 0.01 } } : { none: "no ruled cell around the box" };
    const r = applyOps(
      loose(),
      [
        { op: "set_format", id: "aaaaaa01-d0", format: { date_format: "DD/MM/YYYY" } },
        { op: "set_box", id: "aaaaaa01-r0", x: 0.1, y: 0.4, w: 0.2, h: 0.03, snap: "cell" },
        { op: "set_box", id: "aaaaaa02-r1", x: 0.5, y: 0.4, w: 0.2, h: 0.03, snap: "answer" },
      ],
      undefined,
      { snap },
    );
    expect(r.diff_summary.ops).toEqual([
      { op_index: 0, op: "set_format", noop: true },
      { op_index: 1, op: "set_box", snapped: true },
      { op_index: 2, op: "set_box", snapped: false },
    ]);
  });

  it("set_format {font_size} on a date field without a stored format keeps the default date format", () => {
    const s = loose();
    delete (F_(s, "aaaaaa01-d0") as { format?: unknown }).format;
    const r = applyOps(s, [{ op: "set_format", id: "aaaaaa01-d0", format: { font_size: 9 } }]);
    expect(r.rejected).toEqual([]);
    expect(F_(r.render, "aaaaaa01-d0").format).toEqual({ date_format: "DD/MM/YYYY", font_size: 9 });
    const kept = applyOps(loose(), [
      { op: "set_format", id: "aaaaaa01-d0", format: { font_size: 9 } },
    ]);
    expect(F_(kept.render, "aaaaaa01-d0").format).toEqual({
      date_format: "DD/MM/YYYY",
      font_size: 9,
    });
  });
});

describe("preview legend: changed mode and boxes", () => {
  it("reports fields adopted into a table as moved_into, not removed", () => {
    const before = legendPrints(legendRows(loose(), 1));
    const { s, gid } = tabled();
    const d = legendChanges(before, legendRows(s, 1));
    expect(d.removed).toEqual([]);
    expect(d.moved_into.map((m) => m.into)).toEqual(Array(6).fill(gid));
    expect(d.moved_into.map((m) => m.id).sort()).toEqual(GRID.flat().sort());
  });

  it("a header-only edit lists the table without its unchanged cells", () => {
    const { s, gid } = tabled();
    const before = legendPrints(legendRows(s, 1));
    const r = applyOps(s, [{ op: "set_header", id: gid, axis: "col", index: 0, text: "When" }]);
    const d = legendChanges(before, legendRows(r.render, 1));
    expect(d.changed.map((x) => x.id)).toEqual([gid]);
    expect(d.changed[0].members_changed).toBe(0);
    expect(d.changed[0].cells).toBeUndefined();
    const r2 = applyOps(r.render, [{ op: "relabel", id: "aaaaaa02-r1", label: "Why" }]);
    const d2 = legendChanges(legendPrints(legendRows(r.render, 1)), legendRows(r2.render, 1));
    expect(d2.changed[0].cells?.map((c) => c.id)).toEqual(["aaaaaa02-r1"]);
    expect(d2.changed[0].members_changed).toBe(1);
  });

  it("gives every option its own box", () => {
    const row = legendRows(loose(), 1).find((r) => r.id === "gggggg-choice")!;
    expect(row.options?.map((o) => o.box)).toEqual([
      { x: 0.1, y: 0.6, w: 0.2, h: 0.03 },
      { x: 0.2, y: 0.6, w: 0.2, h: 0.03 },
    ]);
  });

  it("lists a list (table_rows) table's column boxes and printed cells", () => {
    const { s, gid } = tabled({ format: "expandable" });
    const row = legendRows(s, 1).find((r) => r.id === gid)!;
    expect(row.columns?.map((c) => c.box.x)).toEqual([0.1, 0.4]);
    expect(row.cells?.map((c) => [c.row, c.col])).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
      [2, 0],
      [2, 1],
    ]);
    expect(row.cells?.[3]).toMatchObject({ id: "aaaaaa02-r1", box: { y: 0.25 } });
  });
});

// The 0.2.0 edit ops: tables (group table, insert/delete a line, add/adopt a
// cell, column types, orientation, headers), choice options, autofill, date
// formats, short ids and snap — against small hand-built schemas shaped like
// the gold corrections (the intake hospitalization grid, Schengen §42).

import { describe, expect, it } from "vitest";

import { EchoGuard } from "../src/echo.js";
import { applyOps, type Snapper, wordingChanges, wordingOf } from "../src/edits.js";
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

  /** Two blanks on one printed line (the right box starts half a percent higher) and one below. */
  const oneLine = (ranks: Record<string, number> = {}): RenderSchema => {
    const at = (id: string, x: number, y: number) =>
      fld(id, x, y, id in ranks ? { order: ranks[id] } : {});
    return {
      ...loose(),
      fields: [
        at("dddddd01-right", 60, 10),
        at("dddddd02-left", 10, 10.5),
        at("dddddd03-below", 10, 30),
      ],
      groups: [],
    } as RenderSchema;
  };
  const orders = (s: RenderSchema) => Object.fromEntries(s.fields.map((f) => [f.id, f.order]));

  it("reorder reads a page without order line by line: a same-line pair counts left first", () => {
    // The page is listed left, right, below, so `left` is where the first of
    // the two sat: the pair lands there, ahead of `right`.
    const r = applyOps(oneLine(), [
      { op: "reorder", page: 1, ids: ["dddddd03-below", "dddddd02-left"] },
    ]);
    expect(r.rejected).toEqual([]);
    expect(orders(r.render)).toEqual({
      "dddddd03-below": 0,
      "dddddd02-left": 1,
      "dddddd01-right": 2,
    });
    expect(schemaIssues(r.render)).toEqual([]);
  });

  it("reorder on a ranked page goes by the ranks, a same-line pair as ranked", () => {
    // Ranked right, left, below: `left` sits second, and stays behind `right`.
    const ranked = oneLine({ "dddddd01-right": 0, "dddddd02-left": 1, "dddddd03-below": 2 });
    const r = applyOps(ranked, [
      { op: "reorder", page: 1, ids: ["dddddd03-below", "dddddd02-left"] },
    ]);
    expect(r.rejected).toEqual([]);
    expect(orders(r.render)).toEqual({
      "dddddd01-right": 0,
      "dddddd03-below": 1,
      "dddddd02-left": 2,
    });
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

describe("0.2.2: reorder reports the listing, set_section, set_section_title", () => {
  const SECTIONS = [
    { id: "sec-a", title: "Header" },
    { id: "sec-b", title: "Income" },
  ];
  const A1 = "aaaaaa01-a1";
  const A2 = "aaaaaa02-a2";
  const B1 = "bbbbbb01-b1";
  const B2 = "bbbbbb02-b2";
  const LOOSE = "cccccc01-loose";
  /** Section "Header" (a1, a2), then section "Income" (b1, b2), top to bottom;
   *  with `loose`, a field in no section between the two. */
  const sectioned = (loose = false): RenderSchema =>
    ({
      version: 5,
      pages: [
        {
          page: 1,
          width: 1000,
          height: 1400,
          image: "https://example.invalid/p1.png",
          sections: structuredClone(SECTIONS),
        },
      ],
      fields: [
        fld(A1, 10, 10, { section_id: "sec-a" }),
        fld(A2, 10, 20, { section_id: "sec-a" }),
        ...(loose ? [fld(LOOSE, 10, 30, { section_id: null })] : []),
        fld(B1, 10, 40, { section_id: "sec-b" }),
        fld(B2, 10, 50, { section_id: "sec-b" }),
      ],
      groups: [],
    }) as RenderSchema;
  const outcome = (r: ReturnType<typeof applyOps>, i = 0) => r.diff_summary.ops[i];
  const stamped = (s: RenderSchema) => s.fields.some((f) => f.order !== undefined);

  it("reorder returns the order now listed; inside one section it comes out as asked", () => {
    const r = applyOps(sectioned(true), [{ op: "reorder", page: 1, ids: [A2, A1] }]);
    expect(r.rejected).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(outcome(r)).toEqual({ op_index: 0, op: "reorder", order: [A2, A1, LOOSE, B1, B2] });
  });

  it("a page asked for the order it already has applies, and is stamped", () => {
    const all = [A1, A2, LOOSE, B1, B2];
    const r = applyOps(sectioned(true), [{ op: "reorder", page: 1, ids: all }]);
    expect(r.rejected).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(outcome(r).order).toEqual(all);
    expect(r.render.fields.map((f) => f.order)).toEqual([0, 1, 2, 3, 4]);
  });

  it("across sections: what moved is applied with a warning that names the sections", () => {
    // b2 and a1 go to where a1 sat, but each is listed with its own section.
    const r = applyOps(sectioned(true), [{ op: "reorder", page: 1, ids: [B2, A1] }]);
    expect(r.rejected).toEqual([]);
    expect(outcome(r).order).toEqual([B2, B1, A1, A2, LOOSE]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(
      /^reorder on page 1: the ids are not all listed in the order asked/,
    );
    expect(r.warnings[0]).toContain(`section "Income" (sec-b): ${B2}`);
    expect(r.warnings[0]).toContain(`section "Header" (sec-a): ${A1}`);
    expect(r.warnings[0]).toMatch(/set_section \{ids, section_id\}/);
  });

  it("across sections: an order that changes nothing in the listing is rejected, also when repeated", () => {
    // b1 before a2 would need b1 inside "Header": the listing stays a1, a2, b1, b2.
    const ops = [{ op: "reorder", page: 1, ids: [B1, A2] }];
    const r = applyOps(sectioned(), ops);
    expect(r.applied).toBe(0);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0].reason).toMatch(/^this order would change nothing in the listing/);
    expect(r.rejected[0].reason).toContain(`section "Income" (sec-b): ${B1}`);
    expect(r.rejected[0].reason).toContain(`section "Header" (sec-a): ${A2}`);
    expect(r.rejected[0].reason).toMatch(/Set_section \{ids, section_id\} moves an entry/);
    expect(stamped(r.render)).toBe(false); // nothing was written
    expect(applyOps(r.render, ops).rejected).toHaveLength(1);
  });

  it("set_section moves the entry, and the same reorder then comes out as asked", () => {
    const r = applyOps(sectioned(), [
      { op: "set_section", ids: [B1], section_id: "sec-a" },
      { op: "reorder", page: 1, ids: [B1, A2] },
    ]);
    expect(r.rejected).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(outcome(r, 0)).toEqual({
      op_index: 0,
      op: "set_section",
      section: { id: "sec-a", title: "Header" },
    });
    expect(F_(r.render, B1).section_id).toBe("sec-a");
    expect(outcome(r, 1).order).toEqual([A1, B1, A2, B2]);
    expect(schemaIssues(r.render)).toEqual([]);
  });

  it("set_section: null takes an entry out of every section; the same section again is a no-op", () => {
    const r = applyOps(sectioned(), [
      { op: "set_section", ids: [A2, B2], section_id: null },
      { op: "set_section", ids: [A1], section_id: "sec-a" },
    ]);
    expect(r.rejected).toEqual([]);
    expect([F_(r.render, A2).section_id, F_(r.render, B2).section_id]).toEqual([null, null]);
    expect(outcome(r, 0).section).toBeNull();
    expect(outcome(r, 1)).toMatchObject({ noop: true, section: { id: "sec-a" } });
  });

  it("set_section moves a group through all its members, and refuses what it cannot place", () => {
    const s = loose();
    (s.pages[0].sections as unknown[]).push({ id: "sec-2", title: "Status" });
    s.pages.push({ ...s.pages[0], page: 2, sections: [{ id: "sec-p2", title: "Page two" }] });
    s.fields.push(fld("eeeeee01-p2", 10, 10, { page: 2, section_id: "sec-p2" }));
    const r = applyOps(s, [
      { op: "set_section", ids: ["gggggg-choice"], section_id: "sec-2" },
      { op: "set_section", ids: ["bbbbbb01-a"], section_id: "sec-2" }, // an option
      { op: "set_section", ids: ["cccccc01-name"], section_id: "sec-p2" }, // another page's
      { op: "set_section", ids: ["cccccc01-name", "eeeeee01-p2"], section_id: "sec-2" },
      { op: "set_section", ids: ["cccccc01-name"] },
      { op: "set_section", ids: [], section_id: "sec-2" },
    ]);
    expect(r.applied).toBe(1);
    expect(["bbbbbb01-a", "bbbbbb02-b"].map((id) => F_(r.render, id).section_id)).toEqual([
      "sec-2",
      "sec-2",
    ]);
    expect(r.diff_summary.touched.map((t) => t.id)).toEqual(["gggggg-choice"]);
    expect(r.rejected.map((x) => x.reason)).toEqual([
      expect.stringMatching(/option\/cell of group gggggg-choice; move the group/),
      expect.stringMatching(
        /sec-p2 is not a section of page 1 \(its sections: sec-1 "History", sec-2 "Status"\)/,
      ),
      expect.stringMatching(/all ids must be on one page/),
      expect.stringMatching(/section_id is required \(null takes/),
      expect.stringMatching(/ids must list the fields or groups to move/),
    ]);
  });

  it("set_section_title renames one section of one page, as the form's wording", () => {
    const r = applyOps(sectioned(), [
      { op: "set_section_title", page: 1, section_id: "sec-a", title: "  Personal details " },
      { op: "set_section_title", page: 1, section_id: "sec-b", title: "   " },
      { op: "set_section_title", page: 1, section_id: "sec-zzz", title: "X" },
      { op: "set_section_title", section_id: "sec-a", title: "X" },
    ]);
    expect(r.applied).toBe(1);
    expect(r.render.pages[0].sections).toEqual([
      { id: "sec-a", title: "Personal details" },
      { id: "sec-b", title: "Income" },
    ]);
    expect(outcome(r)).toEqual({
      op_index: 0,
      op: "set_section_title",
      section: { id: "sec-a", title: "Personal details" },
    });
    expect(r.rejected.map((x) => x.reason)).toEqual([
      expect.stringMatching(/title is required/),
      expect.stringMatching(/no section has id sec-zzz/),
      expect.stringMatching(/page must be a 1-based page number/),
    ]);
    expect(schemaIssues(r.render)).toEqual([]);

    // A title is wording: the echo guard screens it like a label.
    const g = new EchoGuard();
    g.remember(sectioned(), { [A1]: "Kowalska" });
    const screened = applyOps(
      sectioned(),
      [{ op: "set_section_title", page: 1, section_id: "sec-a", title: "Mrs Kowalska" }],
      (w) => g.check(w),
    );
    expect(screened.applied).toBe(0);
    expect(screened.rejected[0].reason).toMatch(/^the title of sec-a on page 1 matches an answer/);
  });

  it("a section is told apart by its page: the same id on two pages is two entries of wording", () => {
    // The pipeline numbers sections page by page (s1, s2, …), so ids repeat.
    const s = sectioned();
    (s.pages[0].sections as { title: string }[])[0].title = "Mrs Kowalska";
    s.pages.push({ ...s.pages[0], page: 2, sections: [{ id: "sec-a", title: "Other" }] });
    const titles = (x: RenderSchema) =>
      wordingOf(x)
        .filter((w) => w.id === "sec-a")
        .map((w) => [w.page, w.text]);
    expect(titles(s)).toEqual([
      [1, "Mrs Kowalska"],
      [2, "Other"],
    ]);

    const g = new EchoGuard();
    g.remember(s, { [A1]: "Kowalska" });
    // Page 1's title reads so already; the same text on page 2 is a change of
    // its own, screened and named with its page.
    const op = { op: "set_section_title", page: 2, section_id: "sec-a", title: "Mrs Kowalska" };
    const r = applyOps(s, [op], (w) => g.check(w, "t-x"));
    expect(r.applied).toBe(0);
    expect(r.rejected[0].reason).toMatch(/^the title of sec-a on page 2 matches an answer/);
    g.tell(r.screened.told);

    // Named on page 2 only: page 1's title is another entry, listed apart.
    const both = wordingOf(applyOps(s, [op]).render).filter((w) => w.id === "sec-a");
    expect(g.check(both, "t-x").refused.map((x) => [x.page, x.listed])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(wordingChanges(both)).toEqual([
      { id: "sec-a", page: 1, properties: ["title"] },
      { id: "sec-a", page: 2, properties: ["title"] },
    ]);
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

  it("does not list an untouched comb when another id lengthens its cells' tags", () => {
    const withComb = (): RenderSchema => {
      const s = loose();
      s.fields.push(
        fld("kkkkkk01-c0", 10, 90, { wpct: 3, group: "kkkkkk-comb" }),
        fld("mmmmmm01-c1", 13, 90, { wpct: 3, group: "kkkkkk-comb" }),
      );
      s.groups.push({
        id: "kkkkkk-comb",
        kind: "comb",
        label: "Code",
        page: 1,
        members: ["kkkkkk01-c0", "mmmmmm01-c1"],
      } as G);
      return s;
    };
    const s = withComb();
    const before = legendPrints(legendRows(s, 1));
    // A new field sharing "mmmmmm01" makes the second cell's tag longer.
    const r = applyOps(s, [
      { op: "add", page: 1, type: "text", box: { x: 0.5, y: 0.9, w: 0.1, h: 0.03 }, label: "X" },
    ]);
    r.render.fields.at(-1)!.id = "mmmmmm01-other";
    const now = legendRows(r.render, 1);
    const tags = (rows: typeof now) =>
      rows.find((x) => x.id === "kkkkkk-comb")!.comb_cells!.map((c) => c.tag);
    expect(tags(now)).not.toEqual(tags(legendRows(s, 1)));
    const d = legendChanges(before, now);
    expect(d.changed.map((x) => x.id)).toEqual(["mmmmmm01-other"]);
    // A cell added in front lists that cell only, not every cell after it.
    const r2 = applyOps(s, [
      { op: "comb_add_cell", id: "kkkkkk-comb", box: { x: 0.07, y: 0.9, w: 0.03, h: 0.03 } },
    ]);
    expect(r2.rejected).toEqual([]);
    const d2 = legendChanges(before, legendRows(r2.render, 1));
    const comb = d2.changed.find((x) => x.id === "kkkkkk-comb")!;
    expect(comb.comb_cells?.map((c) => c.box.x)).toEqual([0.07]);
    expect(comb.members_changed).toBe(1);
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

describe("preview legend: what a comb and a date print", () => {
  it("lists a date comb's cells, max_length, cell_type and date_format", () => {
    const row = legendRows(fixture("canonical").render, 1).find((r) => r.id === "g-comb")!;
    expect(row).toMatchObject({ cell_type: "date", max_length: 4, date_format: "DDMM" });
    // One member over four printed cells: each cell by index, with its date letter.
    expect(row.comb_cells?.map((c) => [c.index, c.date_part])).toEqual([
      [0, "D"],
      [1, "D"],
      [2, "M"],
      [3, "M"],
    ]);
    expect(row.comb_cells?.[1].box).toEqual({ x: 0.2, y: 0.5, w: 0.1, h: 0.04 });
  });

  it("lists a comb built of one field per cell by each cell's tag", () => {
    const base = fixture("canonical").render;
    const cells = [0, 1, 2].map((i) =>
      fld(`cccccc0${String(i)}-cell`, 50 + i * 3, 80, { wpct: 3, hpct: 3 }),
    );
    const s = { ...base, fields: [...base.fields, ...cells] } as RenderSchema;
    const r = applyOps(s, [
      { op: "group", kind: "comb", ids: cells.map((c) => c.id), label: "Code" },
    ]);
    expect(r.rejected).toEqual([]);
    const row = legendRows(r.render, 1).find((x) => x.type === "comb" && x.id !== "g-comb")!;
    expect(row).toMatchObject({ cell_type: "char", max_length: 3 });
    expect(row.date_format).toBeUndefined();
    expect(row.comb_cells?.map((c) => c.tag)).toEqual(["cccccc00", "cccccc01", "cccccc02"]);
    // The other tags keep the lengths the check copy prints.
    expect(row.tag).toHaveLength(6);
  });

  it("lists a single field drawn over cells by its length, never as a date comb", () => {
    // A date field over printed cells takes one character per cell, as typed.
    const r = applyOps(fixture("canonical").render, [
      { op: "ungroup", id: "g-comb" },
      { op: "retype", id: "f-comb", type: "date" },
    ]);
    expect(r.rejected).toEqual([]);
    const row = legendRows(r.render, 1).find((x) => x.id === "f-comb")!;
    expect(row).toMatchObject({ type: "comb", max_length: 4 });
    expect(row.date_format).toBeUndefined();
    expect(row.cell_type).toBeUndefined();
    expect(row.comb_cells?.map((c) => c.index)).toEqual([0, 1, 2, 3]);
  });

  it("gives every date field and table date cell the format it prints", () => {
    const canon = legendRows(fixture("canonical").render, 1);
    // No stored format: the default.
    expect(canon.find((r) => r.id === "f-date")?.date_format).toBe("DD/MM/YYYY");
    expect(canon.find((r) => r.id === "f-text")?.date_format).toBeUndefined();
  });

  it("agrees with the agent schema on every date format, comb length and cell type", () => {
    for (const name of [
      "canonical",
      "classic_tables",
      "expandable_tables",
      "ungrouped_fields",
    ] as const) {
      const { render, agent } = fixture(name);
      const pages = [...new Set(render.pages.map((p) => p.page))];
      const rows = pages.flatMap((p) => legendRows(render, p));
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const e of agent.fields as unknown as Record<string, unknown>[]) {
        const row = byId.get(e.id as string);
        expect(row, `${name}: ${String(e.id)}`).toBeDefined();
        if (e.type === "date") expect(row!.date_format).toBe(e.date_format);
        if (e.type === "comb") {
          expect(row!.max_length).toBe(e.max_length);
          expect(row!.cell_type).toBe(e.cell_type);
          expect(row!.date_format ?? null).toBe(e.date_format ?? null);
        }
        for (const c of (e.cells as Record<string, unknown>[] | undefined) ?? []) {
          const cell = row!.cells?.find((x) => x.id === c.id);
          expect(cell?.date_format ?? null, `${name}: cell ${String(c.id)}`).toBe(
            c.date_format ?? null,
          );
        }
        for (const c of (e.columns as Record<string, unknown>[] | undefined) ?? []) {
          const col = row!.columns?.find((x) => x.id === c.id);
          expect(col?.date_format ?? null).toBe(c.date_format ?? null);
        }
      }
    }
  });
});

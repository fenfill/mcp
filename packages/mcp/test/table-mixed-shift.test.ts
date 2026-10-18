// A stored mixed column that a table_insert / table_delete only shifts is a
// problem the op did not bring: the op applies, and the warning names the
// column where the mix now stands.

import { describe, expect, it } from "vitest";

import { applyOps } from "../src/edits.js";
import type { RenderSchema } from "../src/types.js";

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

/** 3×2 col table: column 0 clean text, column 1 a stored text/multiline mix. */
function mixedTable(): RenderSchema {
  const ml = { format: { variant: "multiline" } };
  const cells = [
    [fld("tttttt01-a0", 10, 20), fld("tttttt01-b0", 40, 20, ml)],
    [fld("tttttt02-a1", 10, 25), fld("tttttt02-b1", 40, 25)],
    [fld("tttttt03-a2", 10, 30), fld("tttttt03-b2", 40, 30, ml)],
  ];
  const grid = cells.map((row) => row.map((f) => f.id));
  for (const f of cells.flat()) f.group = "tttttt-table";
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
    fields: cells.flat(),
    groups: [
      {
        id: "tttttt-table",
        kind: "table",
        format: "classic",
        orientation: "col",
        label: "Entries",
        page: 1,
        rows: 3,
        cols: 2,
        grid,
        members: grid.flat(),
      } as G,
    ],
  } as RenderSchema;
}

describe("a column op that only shifts a stored mixed column", () => {
  it("table_insert of a column before the mixed column applies and warns about it at its new index", () => {
    const r = applyOps(mixedTable(), [
      { op: "table_insert", id: "tttttt-table", axis: "col", index: 1, box: { x: 0.32, w: 0.05 } },
    ]);
    expect(r.rejected).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/table tttttt-table: column 2 still stores? mixed types/);
  });

  it("table_delete of the clean column applies and warns about the mix now at column 0", () => {
    const r = applyOps(mixedTable(), [
      { op: "table_delete", id: "tttttt-table", axis: "col", index: 0 },
    ]);
    expect(r.rejected).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/table tttttt-table: column 0 still stores? mixed types/);
  });
});

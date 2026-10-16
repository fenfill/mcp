// Short ids in `values` keys (values.ts): what is written out in full, what is
// left as typed, and that the echo guard sees the same keys as the stamp.

import { describe, expect, it } from "vitest";

import { EchoGuard } from "../src/echo.js";
import { legendRows } from "../src/preview.js";
import type { RenderSchema } from "../src/types.js";
import { expandValueKeys } from "../src/values.js";
import { fixture } from "./helpers.js";

const fld = (id: string, y: number) => ({
  id,
  label: id,
  type: "text",
  format: { variant: "any" },
  page: 1,
  section_id: null,
  xpct: 10,
  ypct: y,
  wpct: 20,
  hpct: 3,
  group: null,
});

/** Three loose fields; the first two share their first 8 characters. */
const three = (): RenderSchema =>
  ({
    version: 5,
    pages: [
      {
        page: 1,
        width: 1000,
        height: 1400,
        image: "https://example.invalid/p1.png",
        sections: [],
      },
    ],
    fields: [fld("aaaaaa01-first", 10), fld("aaaaaa01-second", 20), fld("bbbbbb02-third", 30)],
    groups: [],
  }) as unknown as RenderSchema;

const CHILDREN = "391f4376-9964-5238-bb76-582e8a0772f7";
const CHILD_NAME = "ffb3a3e7-95f1-5573-8140-d59a4a2f666a";
const CHILD_BORN = "b8e28281-b29d-5c01-9389-9de5b72fde4b";
const LINES = "cbbe0368-86fb-5d94-9ddd-7b635232d1d4";
const LINE_ITEM = "ea8e75d9-0be0-50f7-9928-26cc1f09bc8b";
const LINE_PAID = "1b245c20-c312-51f7-bb03-f3dea8c6f912";

describe("expandValueKeys", () => {
  it("writes an unambiguous prefix of 4+ characters out in full, in the order given", () => {
    const out = expandValueKeys(three(), { bbbbbb: "c", "aaaaaa01-f": "a" });
    expect(Object.entries(out)).toEqual([
      ["bbbbbb02-third", "c"],
      ["aaaaaa01-first", "a"],
    ]);
    // 0.2.2 took only 6+ ("only the 6-character legend tags worked"); any case.
    expect(expandValueKeys(three(), { bbbbb: 1 })).toEqual({ "bbbbbb02-third": 1 });
    expect(expandValueKeys(three(), { BBBB: 1 })).toEqual({ "bbbbbb02-third": 1 });
  });

  it("leaves a key that is too short, ambiguous or unknown as typed", () => {
    const given = { bbb: 1, aaaaaa01: 2, "zzzzzzzz-nope": 3, "aaaaaa01-second": 4 };
    expect(expandValueKeys(three(), given)).toEqual(given);
  });

  it("leaves a prefix alone when its full id, or another prefix of it, is given too", () => {
    expect(expandValueKeys(three(), { "bbbbbb02-third": "a", bbbbbb: "b" })).toEqual({
      "bbbbbb02-third": "a",
      bbbbbb: "b",
    });
    expect(expandValueKeys(three(), { bbbbbb: "a", bbbbbb0: "b" })).toEqual({
      "bbbbbb02-third": "a",
      bbbbbb0: "b",
    });
  });

  it("expands a table's cell ids and an expandable table's column ids inside its value", () => {
    const table = fixture("classic_tables").render;
    expect(
      expandValueKeys(table, { "391f4376": { ffb3a3e7: "Ann", b8e28281: "2020-01-02", x: 1 } }),
    ).toEqual({ [CHILDREN]: { [CHILD_NAME]: "Ann", [CHILD_BORN]: "2020-01-02", x: 1 } });

    const rows = fixture("expandable_tables").render;
    expect(
      expandValueKeys(rows, {
        cbbe0368: [{ ea8e75d9: "Pens", "1b245c20": true }, { Item: "Ink" }],
      }),
    ).toEqual({ [LINES]: [{ [LINE_ITEM]: "Pens", [LINE_PAID]: true }, { Item: "Ink" }] });
  });

  it("moves a table cell given at the top level into its table's value", () => {
    const table = fixture("classic_tables").render;
    // The 2026-10-14 notes: {"524cb7": "X1"} was "unknown id".
    expect(expandValueKeys(table, { ffb3a3: "Ann" })).toEqual({
      [CHILDREN]: { [CHILD_NAME]: "Ann" },
    });
    // Merged into the table's own value, after it.
    expect(
      expandValueKeys(table, { ffb3a3e7: "Ann", "391f4376": { b8e28281: "2020-01-02" } }),
    ).toEqual({ [CHILDREN]: { [CHILD_BORN]: "2020-01-02", [CHILD_NAME]: "Ann" } });
    // The same cell given twice: the top-level one is left for the core to report.
    expect(expandValueKeys(table, { [CHILD_NAME]: "Ann", "391f4376": { ffb3a3e7: "Bo" } })).toEqual(
      { [CHILD_NAME]: "Ann", [CHILDREN]: { [CHILD_NAME]: "Bo" } },
    );
  });

  it("makes an option given true its group's value", () => {
    const canon = fixture("canonical").render;
    expect(expandValueKeys(canon, { "f-checkbox2": true })).toEqual({ "g-choice": "f-checkbox2" });
    // false or null: left blank.
    expect(expandValueKeys(canon, { "f-checkbox2": false, "f-checkbox": null })).toEqual({});
    // A radio given both ways: the option is left as typed for the core to report.
    expect(expandValueKeys(canon, { "g-choice": "Yes", "f-checkbox2": true })).toEqual({
      "g-choice": "Yes",
      "f-checkbox2": true,
    });
    // A multiselect gathers its options, after any list given for it.
    const multi = JSON.parse(JSON.stringify(canon)) as RenderSchema;
    (multi.groups as { id: string; format?: string }[]).find((g) => g.id === "g-choice")!.format =
      "multiple";
    expect(expandValueKeys(multi, { "f-checkbox2": true, "f-checkbox": true })).toEqual({
      "g-choice": ["f-checkbox2", "f-checkbox"],
    });
    expect(expandValueKeys(multi, { "g-choice": "Yes", "f-checkbox2": true })).toEqual({
      "g-choice": ["Yes", "f-checkbox2"],
    });
  });

  it("takes the tags the legend shows, though an entry's tag also starts a comb cell's id", () => {
    // The legend's 6-character tags are unique among the tagged ids (entries,
    // options, table cells); comb cells get longer tags, unique among all.
    const cell = (id: string, x: number) => ({
      ...fld(id, 50),
      xpct: x,
      wpct: 3,
      group: "zzzzzzzz-comb",
    });
    const s = {
      ...three(),
      fields: [fld("abcdef01-entry", 10), cell("abcdef02-cell1", 10), cell("abcdef02-cell2", 13)],
      groups: [
        {
          id: "zzzzzzzz-comb",
          kind: "comb",
          page: 1,
          label: "Code",
          members: ["abcdef02-cell1", "abcdef02-cell2"],
        },
      ],
    } as unknown as RenderSchema;
    const legend = legendRows(s, 1);
    const entryTag = legend.find((r) => r.id === "abcdef01-entry")!.tag;
    const cellTag = legend.find((r) => r.id === "zzzzzzzz-comb")!.comb_cells![0].tag;
    expect(entryTag).toBe("abcdef");
    expect(cellTag).toBe("abcdef02-cell1");
    expect(expandValueKeys(s, { [entryTag]: "x" })).toEqual({ "abcdef01-entry": "x" });
    // A prefix of a comb cell's id that starts no tagged id is written out too
    // (the core then reports it as a cell of its comb).
    expect(expandValueKeys(s, { "abcdef02-cell1": 1 })).toEqual({ "abcdef02-cell1": 1 });
    expect(expandValueKeys(s, { "ABCDEF02-CELL2": 1 })).toEqual({ "abcdef02-cell2": 1 });
    // A prefix that starts two comb cells stays as typed.
    expect(expandValueKeys(s, { abcdef02: 1 })).toEqual({ abcdef02: 1 });
  });

  it("takes a comb cell's legend tag that also starts an expandable table's printed-row id", () => {
    // A comb cell's tag is made unique among the tagged ids and the comb cells,
    // not an expandable table's printed rows (6a3d06e1-… is one).
    const s = JSON.parse(JSON.stringify(fixture("expandable_tables").render)) as RenderSchema;
    const page = (s.fields[0] as { page: number }).page;
    const cell = (id: string, x: number) => ({
      ...fld(id, 95),
      page,
      section_id: s.fields[0].section_id,
      xpct: x,
      wpct: 3,
      group: "zzzzzzzz-comb",
    });
    s.fields.push(cell("6a3d06e1-comb-0", 10) as never, cell("yyyyyyyy-comb-1", 13) as never);
    s.groups.push({
      id: "zzzzzzzz-comb",
      kind: "comb",
      page,
      label: "Code",
      members: ["6a3d06e1-comb-0", "yyyyyyyy-comb-1"],
    } as never);
    const tag = legendRows(s, page).find((r) => r.id === "zzzzzzzz-comb")!.comb_cells![0].tag;
    expect(tag).toBe("6a3d06");
    expect(expandValueKeys(s, { [tag]: 1 })).toEqual({ "6a3d06e1-comb-0": 1 });
  });

  it("keeps every key an own key, whatever it is named", () => {
    const given = JSON.parse('{"__proto__": "x", "constructor": "y", "bbbbbb": "c"}') as Record<
      string,
      unknown
    >;
    const out = expandValueKeys(three(), given);
    expect(Object.keys(out)).toEqual(["__proto__", "constructor", "bbbbbb02-third"]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  it("leaves the values as given when the schema has nothing to match them against", () => {
    const given = { anything: "x", abcdefgh: [{ k: 1 }] };
    expect(expandValueKeys(null, given)).toEqual(given);
    expect(expandValueKeys({ version: 5, pages: [], fields: [], groups: [] }, given)).toEqual(
      given,
    );
  });
});

describe("the echo guard sees the keys the stamp sees", () => {
  const SECRET = "Kowalska-Sentinel 77";
  const hit = (g: EchoGuard) => g.check([{ id: "x", text: SECRET }]).refuse;

  it("remembers a value under a short id only once the key is written out", () => {
    const rows = fixture("expandable_tables").render;
    const short = { cbbe0368: [{ ea8e75d9: SECRET }] };
    const before = new EchoGuard();
    before.remember(rows, short);
    expect(before.size).toBe(0);
    const g = new EchoGuard();
    g.remember(rows, expandValueKeys(rows, short));
    expect(hit(g)).toEqual(["x"]);
  });

  it("remembers a table cell given at the top level once it is moved into its table", () => {
    const table = fixture("classic_tables").render;
    const g = new EchoGuard();
    g.remember(table, expandValueKeys(table, { ffb3a3e7: SECRET }));
    expect(hit(g)).toEqual(["x"]);
  });

  it("remembers a table_rows cell given under its column's label", () => {
    const rows = fixture("expandable_tables").render;
    const g = new EchoGuard();
    g.remember(rows, { [LINES]: [{ Item: SECRET, Paid: true }] });
    expect(hit(g)).toEqual(["x"]);
    expect(g.size).toBe(1);
  });
});

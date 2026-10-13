// Short ids in `values` keys (values.ts): what is written out in full, what is
// left as typed, and that the echo guard sees the same keys as the stamp.

import { describe, expect, it } from "vitest";

import { EchoGuard } from "../src/echo.js";
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
  it("writes an unambiguous prefix of 6+ characters out in full, in the order given", () => {
    const out = expandValueKeys(three(), { bbbbbb: "c", "aaaaaa01-f": "a" });
    expect(Object.entries(out)).toEqual([
      ["bbbbbb02-third", "c"],
      ["aaaaaa01-first", "a"],
    ]);
  });

  it("leaves a key that is too short, ambiguous or unknown as typed", () => {
    const given = { bbbbb: 1, aaaaaa01: 2, "zzzzzzzz-nope": 3, "aaaaaa01-second": 4 };
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

  it("remembers a table_rows cell given under its column's label", () => {
    const rows = fixture("expandable_tables").render;
    const g = new EchoGuard();
    g.remember(rows, { [LINES]: [{ Item: SECRET, Paid: true }] });
    expect(hit(g)).toEqual(["x"]);
    expect(g.size).toBe(1);
  });
});

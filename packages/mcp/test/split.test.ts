// The `split` group kind (parts | flow) in the local mirror of the server's
// validate_template. Mirrors tests/test_split_group_schema.py and
// lib/validation/templateSchema.split.test.ts.

import { describe, expect, it } from "vitest";

import type { RenderSchema } from "../src/types.js";
import { schemaIssues } from "../src/validate.js";
import { fixture } from "./helpers.js";

type Rec = Record<string, unknown>;

const text = (id: string, group: string) => ({
  id,
  label: "",
  type: "text",
  format: { variant: "any" },
  page: 1,
  section_id: "sec-1",
  group,
  xpct: 1,
  ypct: 1,
  wpct: 1,
  hpct: 1,
});

function withSplits(): RenderSchema {
  const s = fixture("canonical").render;
  s.fields.push(
    text("s-int", "g-parts"),
    text("s-frac", "g-parts"),
    text("s-l1", "g-flow"),
    text("s-l2", "g-flow"),
    text("s-l3", "g-flow"),
  );
  s.groups.push(
    {
      id: "g-parts",
      kind: "split",
      rule: "parts",
      value_type: "number",
      frac_digits: 2,
      pad_frac: true,
      label: "Amount",
      page: 1,
      members: ["s-int", "s-frac"],
    },
    {
      id: "g-flow",
      kind: "split",
      rule: "flow",
      label: "Address",
      page: 1,
      members: ["s-l1", "s-l2", "s-l3"],
    },
  );
  return s;
}

const group = (s: RenderSchema, id: string) => s.groups.find((g) => g.id === id) as Rec;
const field = (s: RenderSchema, id: string) => s.fields.find((f) => f.id === id) as Rec;

describe("schemaIssues — split groups", () => {
  it("accepts a valid parts split and a valid flow split", () => {
    expect(schemaIssues(withSplits())).toEqual([]);
  });

  it("accepts a parts split with its optional attributes absent", () => {
    const s = withSplits();
    const g = group(s, "g-parts");
    delete g.value_type;
    delete g.frac_digits;
    delete g.pad_frac;
    expect(schemaIssues(s)).toEqual([]);
  });

  const rejects: [string, (s: RenderSchema) => void, string][] = [
    [
      "parts with 3 members",
      (s) => (group(s, "g-parts").members as string[]).push("s-l1"),
      "members a parts split has exactly 2 members",
    ],
    [
      "flow with 1 member",
      (s) => (group(s, "g-flow").members = ["s-l1"]),
      "members a flow split has at least 2 members",
    ],
    [
      "a non-text member",
      (s) => {
        const f = field(s, "s-l2");
        f.type = "checkbox";
        f.format = { shape: "square", symbol: "x" };
      },
      "members.1 a split member must be a text field",
    ],
    [
      "a cross-page member",
      (s) => (field(s, "s-l2").page = 2),
      "members.1 a split member must be on the group's page",
    ],
    [
      'value_type "date"',
      (s) => (group(s, "g-parts").value_type = "date"),
      "value_type must be number for a parts split",
    ],
    ["frac_digits 5", (s) => (group(s, "g-parts").frac_digits = 5), "frac_digits must be 0–4"],
    [
      "frac_digits on flow",
      (s) => (group(s, "g-flow").frac_digits = 2),
      "frac_digits is only for a parts split",
    ],
    ["a split without a rule", (s) => delete group(s, "g-flow").rule, "rule a split group needs"],
    [
      "rule on a comb group",
      (s) => (group(s, "g-comb").rule = "flow"),
      "rule is only for a split group",
    ],
  ];
  for (const [name, mutate, reason] of rejects) {
    it(`rejects ${name}`, () => {
      const s = withSplits();
      mutate(s);
      const msgs = schemaIssues(s).map((i) => `${i.path} ${i.reason}`);
      expect(msgs.some((m) => m.includes(reason))).toBe(true);
    });
  }

  it("leaves the comb/choice/table fixture clean (old templates unchanged)", () => {
    expect(schemaIssues(fixture("canonical").render)).toEqual([]);
  });
});

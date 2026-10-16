// project.ts against the server: get_template lists a working copy through the
// local projection, so it must list exactly what /v1 lists for the same schema.

import { describe, expect, it } from "vitest";

import { compactView } from "../src/compact.js";
import { applyOps } from "../src/edits.js";
import { projectAgentSchema } from "../src/project.js";
import { fixture } from "./helpers.js";

const FIXTURES = ["canonical", "classic_tables", "expandable_tables", "ungrouped_fields"] as const;

describe("projectAgentSchema", () => {
  for (const name of FIXTURES) {
    it(`lists ${name} as agent_schema.py does`, () => {
      const { render, agent } = fixture(name);
      const mine = projectAgentSchema(render, { name: agent.name });
      expect(compactView(mine, null, "")).toEqual(compactView(agent, null, ""));
      expect(mine.fields.map((e) => [e.id, e.page, e.section?.id ?? null])).toEqual(
        agent.fields.map((e) => [e.id, e.page, e.section?.id ?? null]),
      );
    });
  }

  it("lists an edit at once: a new option, a deleted field", () => {
    const { render } = fixture("canonical");
    const r = applyOps(render, [
      {
        op: "add_option",
        id: "g-choice",
        label: "Maybe",
        box: { x: 0.26, y: 0.2, w: 0.03, h: 0.03 },
      },
      { op: "delete", id: "f-signature" },
    ]);
    expect(r.rejected).toEqual([]);
    const fields = projectAgentSchema(r.render).fields;
    expect(fields.map((e) => e.id)).not.toContain("f-signature");
    const choice = fields.find((e) => e.id === "g-choice")!;
    expect((choice.options as { label: string }[]).map((o) => o.label)).toEqual([
      "Yes",
      "No",
      "Maybe",
    ]);
  });
});

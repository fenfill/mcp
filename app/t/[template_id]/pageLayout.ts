// Per-page document-order layout: the pure builder behind FillForm's `grouped`
// memo. Lifted out of FillForm so (a) it can be cached per page (an edit on one
// page only rebuilds that page — see usePageDerived) and (b) the ordering maths
// stays unit-testable without mounting React.
//
// Input is ONE page's already-partitioned slices: its ungrouped fields and the
// groups that live on it. Output is the flat reading-order `items` list the
// canvas + sidebar render: interleaved section headers, loose fields, and
// groups, with each section collapsed into one contiguous unit anchored at its
// earliest member. `resolve(group)` returns the group's ordered member fields
// (FillForm injects `resolveMembers(g, fieldById)`), keeping member ordering in
// one place.

import type { Field, Group, PageInfo, Section } from "@/types";

import { boxEdges, type Edges, membersEdges, orderBlocks } from "./readOrder";

export type PageBlock =
  | { kind: "field"; top: number; left: number; key: string; field: Field }
  | { kind: "group"; top: number; left: number; key: string; group: Group; members: Field[] };

export type PageItem = { kind: "header"; key: string; section: Section } | PageBlock;

export interface PageLayout {
  page: PageInfo;
  items: PageItem[];
}

// A block's explicit rank on its page (Field.order / Group.order), if it has one.
const orderOf = (b: PageBlock): number | undefined =>
  b.kind === "field" ? b.field.order : b.group.order;

// Whether any of these items carries an explicit `order`. When one does, the
// page's fill order is the `items` sequence itself rather than box geometry, and
// every consumer that lists the page's blocks (the sidebar, Story's cards, the
// phone field sheet, the on-page controls' DOM and so Tab order) follows it. A
// page with none keeps each consumer's own geometry / array order.
export function hasExplicitOrder(items: readonly PageItem[]): boolean {
  return items.some((it) => it.kind !== "header" && orderOf(it) != null);
}

// Build one page's flat reading-order items from its ungrouped fields + groups.
// `pageFields` MUST already be filtered to this page's ungrouped fields, and
// `pageGroups` to groups on this page (the caller partitions once).
export function buildPageItems(
  page: PageInfo,
  pageFields: readonly Field[],
  pageGroups: readonly Group[],
  resolve: (g: Group) => Field[],
): PageLayout {
  // Each block with the whole box the read order goes by (a group's is its
  // members' bounding box). The far edges stay beside the block, not on it: a
  // PageBlock is the same object it always was.
  type Placed = Edges & { block: PageBlock; order: number | undefined };
  const placed: Placed[] = [];
  const place = (block: PageBlock, edges: Edges) => {
    placed.push({ ...edges, block, order: orderOf(block) });
  };
  for (const f of pageFields) {
    place({ kind: "field", top: f.ypct, left: f.xpct, key: `f${f.id}`, field: f }, boxEdges(f));
  }
  for (const g of pageGroups) {
    const members = resolve(g);
    const edges = membersEdges(members);
    if (!edges) continue; // no member resolved: nothing to list
    const { top, left } = edges;
    place({ kind: "group", top, left, key: `g${g.id}`, group: g, members }, edges);
  }

  // Section of a block (group section = first member's section).
  const sectionOf = (b: PageBlock): string | null =>
    b.kind === "field" ? b.field.section_id : (b.members[0]?.section_id ?? null);

  // Flat reading order: sections and section-less ("loose") fields share one
  // ordering, so a loose field can sit above, between, or below sections —
  // exactly where it was dropped. An explicit per-block `order` (stamped by the
  // layer panel, the MCP's reorder or the pipeline's two-column stamp) wins
  // when present; otherwise the page reads by printed line (readOrder.ts).
  const sorted = orderBlocks(placed).map((p) => p.block);

  // Build top-level units: each section is ONE contiguous unit, anchored at its
  // earliest member; each loose block is its own unit. Iterating the globally-
  // sorted blocks places a section at its first (min-order) member and keeps the
  // rest of its members attached, while loose blocks fall wherever their
  // order/geometry lands them between sections.
  const secById = new Map(page.sections.map((s) => [s.id, s] as const));
  type Unit = { section: Section | null; blocks: PageBlock[] };
  const units: Unit[] = [];
  const sectionUnit = new Map<string, Unit>();
  for (const b of sorted) {
    const sid = sectionOf(b);
    const sec = sid != null ? secById.get(sid) : undefined;
    if (!sec) {
      // Loose (or pointing at a deleted section) → its own unit.
      units.push({ section: null, blocks: [b] });
      continue;
    }
    let u = sectionUnit.get(sec.id);
    if (!u) {
      u = { section: sec, blocks: [] };
      sectionUnit.set(sec.id, u);
      units.push(u);
    }
    u.blocks.push(b);
  }

  const items: PageItem[] = [];
  for (const u of units) {
    if (u.section) items.push({ kind: "header", key: `h${u.section.id}`, section: u.section });
    for (const b of u.blocks) items.push(b);
  }
  return { page, items };
}

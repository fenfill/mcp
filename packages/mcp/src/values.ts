// The `values` argument of fill_form / fill_template / preview_page, with
// shortened ids written out in full.
//
// edit_template takes any id as an unambiguous prefix of 6+ characters (the
// length the preview's tags show), so agents pass the same short ids as value
// keys. The stamping core matches keys exactly, so they are written out here
// first: a top-level key against the form's entry ids, a table value's keys
// against that table's cells (an expandable table's rows against its columns).
// A key that is too short, starts several ids, or whose full id is given too
// stays as it is, and the core reports it as skipped.
//
// PRIVACY: the values pass through unchanged and go nowhere else. The echo
// guard must be given the result, not the argument, or a value under a short
// key would be stamped without being remembered.

import { agentEntries, normalizeSchema } from "@/app/t/[template_id]/fillCore";

import { isRec, MIN_ID_PREFIX } from "./doc.js";

type Entry = ReturnType<typeof agentEntries>[number];

/** The keys of `values` written out in full against `pool`; the values untouched. */
function expandKeys(
  values: Record<string, unknown>,
  pool: readonly string[],
): Record<string, unknown> {
  const given = Object.keys(values);
  const taken = new Set<string>();
  const pairs: [string, unknown][] = [];
  for (const key of given) {
    let id = key;
    if (!pool.includes(key) && key.length >= MIN_ID_PREFIX) {
      const hits = pool.filter((p) => p.startsWith(key));
      // Its full id given as well, or a second prefix of one id: left as typed.
      if (hits.length === 1 && !given.includes(hits[0]) && !taken.has(hits[0])) id = hits[0];
    }
    taken.add(id);
    pairs.push([id, values[key]]);
  }
  // Own keys whatever they are named: "__proto__" stays a key the core reports.
  return Object.fromEntries(pairs);
}

function expandNested(e: Entry, v: unknown): unknown {
  if (e.kind === "table" && isRec(v)) {
    return expandKeys(
      v,
      e.cells.map((c) => c.id),
    );
  }
  if (e.kind === "table_rows" && Array.isArray(v)) {
    const columns = e.columns.map((c) => c.id);
    return v.map((row: unknown) => (isRec(row) ? expandKeys(row, columns) : row));
  }
  return v;
}

/** `values` with every unambiguous short id (6+ characters) written out in full. */
export function expandValueKeys(
  render: unknown,
  values: Record<string, unknown>,
): Record<string, unknown> {
  let entries: Entry[];
  try {
    entries = agentEntries(normalizeSchema(render as Parameters<typeof normalizeSchema>[0]));
  } catch {
    return values;
  }
  const byId = new Map(entries.map((e) => [e.id, e]));
  const top = expandKeys(values, [...byId.keys()]);
  return Object.fromEntries(
    Object.entries(top).map(([id, v]) => {
      const e = byId.get(id);
      return [id, e ? expandNested(e, v) : v];
    }),
  );
}

// The `values` argument of fill_form / fill_template / preview_page, with
// shortened ids written out in full and nested ids moved to where they belong.
//
// Agents pass the ids the preview's legend shows: an entry's tag, a table
// cell's tag, an option's tag. The stamping core matches keys exactly, so they
// are written out here first. Any unambiguous prefix of MIN_VALUE_PREFIX (4)+
// characters is taken (case-insensitive): a top-level key against the ids the
// legend tags (entries, options, table cells, columns), then, when it starts
// none of them, against those and the comb cells, then against every nested
// id (an expandable table's printed rows); a table value's
// keys against that table's cells (an expandable table's rows against its
// columns). Which ids are nested is agentValues' nestedIdOwners, the core's own.
//   - a classic table's cell given at the top level goes into its table's value;
//   - an option given `true` becomes its group's value (a radio's option, or
//     one more item of a multiselect's list); `false` or null leaves it blank.
// A key that is too short, starts several ids, or whose full id is given too
// stays as it is, and the core reports it as skipped (an ambiguous one with
// its candidates; a nested one with the entry it belongs to).
//
// PRIVACY: the values pass through unchanged and go nowhere else. The echo
// guard must be given the result, not the argument, or a value under a short
// key (or a cell moved into its table) would be stamped without being remembered.

import {
  agentEntries,
  checkTagIds,
  nestedIdOwners,
  normalizeSchema,
  prefixHits,
} from "@/app/t/[template_id]/fillCore";

import { isRec } from "./doc.js";

type Entry = ReturnType<typeof agentEntries>[number];

/** `key` written out against `pool`, or `key` itself when it names no one id. */
function fullId(key: string, pool: readonly string[], given: readonly string[]): string {
  if (pool.includes(key)) return key;
  const hits = prefixHits(key, pool);
  // Its full id given as well: left as typed.
  return hits.length === 1 && !given.includes(hits[0]) ? hits[0] : key;
}

/**
 * A top-level `key` written out as the legend made its tags: an exact id
 * anywhere; else a prefix among the tagged ids (entries, options, table cells,
 * columns: the pool the legend's tags are unique in); else among those and
 * the comb cells (the pool a comb cell's tag is unique in); else among every
 * nested id. So a tag the legend shows never turns ambiguous through an id it
 * was not made unique against.
 */
function topId(
  key: string,
  pools: readonly (readonly string[])[],
  given: readonly string[],
): string {
  const all = pools[pools.length - 1];
  if (all.includes(key)) return key;
  const pool = pools.find((p) => prefixHits(key, p).length > 0) ?? all;
  return fullId(key, pool, given);
}

/** The keys of an object written out in full against `pool`; the values untouched. */
function expandKeys(
  obj: Record<string, unknown>,
  pool: readonly string[],
): Record<string, unknown> {
  const given = Object.keys(obj);
  const taken = new Set<string>();
  const pairs: [string, unknown][] = [];
  for (const key of given) {
    let id = fullId(key, pool, given);
    // A second prefix of one id: left as typed.
    if (id !== key && taken.has(id)) id = key;
    taken.add(id);
    pairs.push([id, obj[key]]);
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

/**
 * `values` with every unambiguous short id (4+ characters) written out in full,
 * a table cell given at the top level moved into its table, and an option
 * given `true` moved into its group.
 */
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
  const nested = nestedIdOwners(entries);
  const tagged = [...new Set([...byId.keys(), ...checkTagIds(entries)])];
  const combCells = entries.flatMap((e) => (e.kind === "comb" ? e.members.map((m) => m.id) : []));
  const pool = [...byId.keys(), ...nested.keys()];
  const pools = [tagged, [...tagged, ...combCells], pool];
  const given = Object.keys(values);
  const taken = new Set<string>();
  const pairs: [string, unknown][] = [];
  // Moved in after the top-level keys, so an entry's own value is seen first.
  const moved: { owner: Entry; id: string; key: string; v: unknown }[] = [];
  for (const key of given) {
    const raw = values[key];
    let id = topId(key, pools, given);
    if (id !== key && taken.has(id)) id = key;
    taken.add(id);
    const n = byId.has(id) ? undefined : nested.get(id);
    if (n?.kind === "cell") {
      moved.push({ owner: n.owner, id, key, v: raw });
      continue;
    }
    if (n?.kind === "option" && (raw === true || raw === false || raw == null)) {
      if (raw === true) moved.push({ owner: n.owner, id, key, v: raw });
      continue; // false / null: left blank
    }
    const e = byId.get(id);
    pairs.push([id, e ? expandNested(e, raw) : raw]);
  }
  const top = Object.fromEntries(pairs);
  for (const m of moved) {
    const gid = m.owner.id;
    const has = Object.prototype.hasOwnProperty.call(top, gid);
    const cur: unknown = has ? top[gid] : undefined;
    if (m.owner.kind === "table") {
      if (!has) top[gid] = Object.fromEntries([[m.id, m.v]]);
      else if (isRec(cur) && !Object.prototype.hasOwnProperty.call(cur, m.id)) {
        top[gid] = Object.fromEntries([...Object.entries(cur), [m.id, m.v]]);
      } else top[m.key] = m.v; // clashes with the table's own value: the core reports it
    } else if (m.owner.kind === "choice") {
      if (
        m.owner.type === "multiselect" &&
        (!has || Array.isArray(cur) || typeof cur === "string")
      ) {
        const list: unknown[] = !has ? [] : Array.isArray(cur) ? cur : [cur];
        top[gid] = [...list, m.id];
      } else if (!has) top[gid] = m.id;
      else top[m.key] = m.v; // a radio given twice: the core reports the option
    }
  }
  return top;
}

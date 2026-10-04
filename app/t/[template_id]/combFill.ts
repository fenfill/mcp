// Pure comb-group fill logic, shared by the fill UI (SidebarComb) and the agent
// value mapper (agentValues.ts) so a comb filled by an agent lands in the fill
// store exactly as one typed or date-picked in the browser.
//
// A comb group's members hold its characters in reading order (resolveMembers).
// Each member is one store SLOT: a single-cell member stores one character
// under f{id} (setValue); a multi-cell member stores `len` characters in one
// f{id} value, space-padded so each character stays on its cell index
// (fillStore.setCombChar). Node-safe: no React, no store, no DOM.

import type { Field } from "@/types";

import { fieldKey } from "./fillKeys";

/** One comb member's store slot: its value key and how many cells it holds. */
export interface CombSlot {
  key: string;
  len: number;
}

/** The comb's slots in member order: a member with more than one cell is one
 *  multi-cell slot of that many characters, any other member one character. */
export function combSlots(members: readonly Pick<Field, "id" | "cells">[]): CombSlot[] {
  return members.map((m) => {
    const n = (m.cells ?? []).length;
    return { key: fieldKey(m.id), len: n > 1 ? n : 1 };
  });
}

/** fillStore.setCombChar's reducer: put `ch` at cell `i` of a `len`-cell value,
 *  padding gaps with spaces; an all-blank result collapses to "". */
export function combCharAt(cur: string, len: number, i: number, ch: string): string {
  const out = Array.from(cur);
  while (out.length < len) out.push(" ");
  out[i] = ch === "" ? " " : ch;
  const str = out.slice(0, len).join("");
  return str.trim() === "" ? "" : str;
}

/** The store entries a whole comb value produces when every cell is written in
 *  order (the browser's collapsed-textbox writeback): cell i gets `chars[i]`, or
 *  "" past the end. Starts from blank cells, so the result depends only on
 *  `chars`. */
export function combEntries(
  slots: readonly CombSlot[],
  chars: readonly string[],
): [key: string, value: string][] {
  const out: [string, string][] = [];
  let at = 0;
  for (const s of slots) {
    if (s.len > 1) {
      let v = "";
      for (let i = 0; i < s.len; i++) v = combCharAt(v, s.len, i, chars[at + i] ?? "");
      out.push([s.key, v]);
    } else {
      out.push([s.key, chars[at] ?? ""]);
    }
    at += s.len;
  }
  return out;
}

/** True when a date comb's format is made only of D/M/Y letters (any case). */
export function isDmyFormat(fmt: string): boolean {
  return /^[DMY]+$/i.test(fmt);
}

/**
 * The cell writes a picked ISO date makes on a date comb (SidebarComb's
 * `onPick`), in the browser's order: the day cells, then month, then year.
 * `fmt` is the upper-cased printed format, one letter per cell. Each role gets
 * the picked part's last N digits, zero-padded to its N cells; with fewer than 4
 * year cells the year is first cut to its last 2 digits. An empty `iso` clears
 * every D/M/Y cell. Cells whose letter is not D, M or Y are never written.
 */
export function combDateWrites(iso: string, fmt: string): [cell: number, ch: string][] {
  const roles = fmt.split(""); // one of D / M / Y per cell
  const idxsOf = (r: string) =>
    roles.reduce<number[]>((a, rr, i) => (rr === r ? [...a, i] : a), []);
  const [Y = "", M = "", D = ""] = iso ? iso.split("-") : [];
  const out: [number, string][] = [];
  const put = (r: string, digits: string) => {
    const idxs = idxsOf(r);
    const padded = digits ? digits.slice(-idxs.length).padStart(idxs.length, "0") : "";
    idxs.forEach((cell, k) => {
      out.push([cell, padded[k] ?? ""]);
    });
  };
  put("D", D);
  put("M", M);
  put("Y", idxsOf("Y").length >= 4 ? Y : Y.slice(-2));
  return out;
}

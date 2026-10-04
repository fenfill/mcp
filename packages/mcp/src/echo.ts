// The echo guard. Labels, descriptions, placeholders, options, date formats
// and checkbox symbols are the FORM's wording; an agent that copies an answer
// into one would write it to the edits/ working copy and send it to fenfill
// with save_template. So this process remembers the free-text answers it was
// given (fill_form / fill_template / preview_page: text, multiline, date and
// comb values, never checkbox or option choices). edit_template rejects an op
// whose new wording matches one BEFORE the working copy is written, and
// save_template checks the whole copy again before any request. A match is
// wording that contains a remembered answer of 6+ characters ("Name: Jan
// Kowalski" holds "Jan Kowalski"), or equals one of 4-5 (refused) or 1-3
// characters (a warning only: too short to tell from the form's own text).
//
// PRIVACY: the list lives in this process's memory only. It is never written
// to the cache, a log or a request, and it is gone when the server exits.

import { agentEntries, normalizeSchema } from "@/app/t/[template_id]/fillCore";

export const ECHO_REFUSE_MIN = 4;
/** Answers this long are caught inside longer wording too (shorter: exact only,
 *  so "Yes" or "PL" never flags a caption that merely contains it). */
export const ECHO_CONTAINS_MIN = 6;
/** Distinct values remembered (oldest dropped first). */
const MAX_REMEMBERED = 5_000;
const MAX_LEN = 2_000;

const FREE_TEXT = new Set(["text", "multiline", "date", "comb"]);

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

export class EchoGuard {
  private readonly seen = new Set<string>();

  private add(v: unknown): void {
    if (typeof v === "number" && Number.isFinite(v)) v = String(v);
    if (typeof v !== "string") return;
    const n = norm(v);
    if (!n || n.length > MAX_LEN) return;
    this.seen.delete(n);
    this.seen.add(n);
    if (this.seen.size > MAX_REMEMBERED) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  /** Remember the free-text values of one fill/preview call. */
  remember(render: unknown, values: Record<string, unknown>): void {
    let entries: ReturnType<typeof agentEntries>;
    try {
      entries = agentEntries(normalizeSchema(render as Parameters<typeof normalizeSchema>[0]));
    } catch {
      return;
    }
    const isRec = (x: unknown): x is Record<string, unknown> =>
      typeof x === "object" && x !== null && !Array.isArray(x);
    for (const e of entries) {
      const v = values[e.id];
      if (v === undefined) continue;
      if (e.kind === "field" || e.kind === "comb") {
        if (FREE_TEXT.has(e.type)) this.add(v);
      } else if (e.kind === "table" && isRec(v)) {
        for (const c of e.cells) if (FREE_TEXT.has(c.type)) this.add(v[c.id]);
      } else if (e.kind === "table_rows" && Array.isArray(v)) {
        for (const row of v) {
          if (!isRec(row)) continue;
          for (const c of e.columns) if (FREE_TEXT.has(c.type)) this.add(row[c.id]);
        }
      }
    }
  }

  /** Wording that repeats a remembered answer: refusals (it contains one of
   *  6+ chars, or equals one of 4+) and warnings (equals a shorter one). */
  check(wording: readonly { id: string; text: string }[]): { refuse: string[]; warn: string[] } {
    const refuse = new Set<string>();
    const warn = new Set<string>();
    if (this.seen.size === 0) return { refuse: [], warn: [] };
    for (const w of wording) {
      const n = norm(w.text);
      if (!n) continue;
      if (this.seen.has(n)) {
        (n.length >= ECHO_REFUSE_MIN ? refuse : warn).add(w.id);
        continue;
      }
      if (n.length < ECHO_CONTAINS_MIN) continue;
      for (const v of this.seen) {
        if (v.length >= ECHO_CONTAINS_MIN && n.includes(v)) {
          refuse.add(w.id);
          break;
        }
      }
    }
    return { refuse: [...refuse], warn: [...warn].filter((id) => !refuse.has(id)) };
  }

  get size(): number {
    return this.seen.size;
  }
}

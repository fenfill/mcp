// The echo guard. Labels, descriptions, placeholders, options, date formats
// and checkbox symbols are the FORM's wording; an agent that copies an answer
// into one would write it to the edits/ working copy and send it to fenfill
// with save_template. So this process remembers the free-text answers it was
// given (fill_form / fill_template / preview_page: text, multiline, date and
// comb values, never checkbox or option choices). edit_template rejects an op
// whose new wording matches one BEFORE the working copy is written, and
// save_template checks the whole copy again before any request. A match is
// wording that holds a remembered answer of 6+ characters ("Name: Jan
// Kowalski" holds "Jan Kowalski"), or equals one of 4-5 (refused) or 1-3
// characters (a warning only: too short to tell from the form's own text). A
// one-word answer is held only as a whole word, so the test value "exempt" does
// not flag the caption "exemption"; an answer of several words, or one without
// letters (a number, a phone number, a date), is caught wherever it occurs.
//
// An answer is remembered as it was passed AND as the page shows it: the
// stamping core prints a date in its field's format ("1990-05-17" as
// "17.05.1990"), writes a comb's characters without the separators typed
// between them, and an agent that copies what it reads off a preview copies
// that form. The shown form is read from the marks the core would stamp, so
// its rules are not written a second time here. Text is compared in NFC, and
// an answer of several lines also line by line. The values of a call that
// failed before its form was read are remembered too, whatever they were meant
// for. A value under a key that names nothing is left out: the call reports
// that key, and the corrected call is remembered like any other.
//
// A form's own caption can hold a word the agent also typed as a value ("Middle
// name" after a test value "Middle"), so a refusal can be confirmed, but only
// after the agent has been told what matched. An op goes through on
// confirm_wording once a refusal has named that wording (property + text: the
// entry an add or a group makes has a new id every time). A save goes through
// once every matching entry has itself been named: that entry of that working
// copy, a section by its page as well (section ids repeat from page to page
// and from template to template). What the agent confirmed is the wording, so
// it is not asked about again in this process, on any entry.
//
// PRIVACY: the answers, and the wording refused or confirmed, live in this
// process's memory only. They are never written to the cache, a log or a
// request, and are gone when the server exits. No error or warning built from
// a refusal carries its text: only the entry id and the property name.

import {
  agentEntries,
  buildMarks,
  mapAgentValues,
  normalizeSchema,
} from "@/app/t/[template_id]/fillCore";

export const ECHO_REFUSE_MIN = 4;
/** Answers this long are caught inside longer wording too (shorter: exact only,
 *  so "Yes" or "PL" never flags a caption that merely contains it). */
export const ECHO_CONTAINS_MIN = 6;
/** Distinct values remembered (oldest dropped first). */
const MAX_REMEMBERED = 5_000;
const MAX_LEN = 2_000;

const FREE_TEXT = new Set(["text", "multiline", "date", "comb"]);

const norm = (s: string) => s.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();

const isRec = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/** The guard maps fill values only to read what would be stamped: a signature's
 *  image is not read for that (the core then skips the signature). */
const NO_IMAGE = (): Uint8Array => {
  throw new Error("not read by the echo guard");
};

/** A date comb's digits with the separators its printed format has between
 *  them ("17051990" in "DD.MM.YYYY" is shown as "17.05.1990"): a format's
 *  letters are the digit cells. "" when the digits do not fill the format. */
function inPrintedFormat(digits: string, fmt: string): string {
  const d = Array.from(digits);
  const cells = Array.from(fmt);
  const isLetter = (c: string) => HAS_LETTER.test(c);
  if (!d.length || !d.every((c) => /^\p{Nd}$/u.test(c))) return "";
  if (d.length !== cells.filter(isLetter).length) return "";
  let i = 0;
  return cells.map((c) => (isLetter(c) ? d[i++] : c)).join("");
}

// Cased letters (with their marks) read on as one word, digits as one number.
// Scripts without case and punctuation have no such runs: there a remembered
// answer is caught wherever it occurs.
const LETTER = "[\\p{Lu}\\p{Ll}\\p{Lt}\\p{Lm}\\p{M}]";
const HAS_LETTER = new RegExp(LETTER, "u");
const DIGIT = "\\p{Nd}";
const ENDS = [new RegExp(`${LETTER}$`, "u"), new RegExp(`${DIGIT}$`, "u")];
const STARTS = [new RegExp(`^${LETTER}`, "u"), new RegExp(`^${DIGIT}`, "u")];

/** Whether one word or number runs on across the cut between `left` and `right`. */
const runsOn = (left: string, right: string): boolean =>
  ENDS.some((end, i) => end.test(left) && STARTS[i].test(right));

/** Whether wording `n`, which contains the answer `v`, holds it. A one-word
 *  answer must stand as a whole word somewhere, with no letter or digit running
 *  on past either end ("exemption" only starts with "exempt"). Several words,
 *  or no letter at all, are an answer wherever they occur: "Jan Kowalskiego"
 *  holds "Jan Kowalski", "+48600123456" holds "600123456". */
function holds(n: string, v: string): boolean {
  if (v.includes(" ") || !HAS_LETTER.test(v)) return true;
  for (let i = n.indexOf(v); i !== -1; i = n.indexOf(v, i + 1)) {
    if (!runsOn(n.slice(0, i), v) && !runsOn(v, n.slice(i + v.length))) return true;
  }
  return false;
}

/** Wording the guard matched, and what the agent has been told of it in this
 *  session (only then can it be confirmed). `text` holds the answer, so a
 *  Refusal never leaves this process. */
export interface Refusal {
  id: string;
  /** A section's page: its id alone does not say which section it is. */
  page?: number;
  prop: string;
  text: string;
  /** A refusal has named this wording (property + text), on some entry. */
  shown: boolean;
  /** A refusal has named it on this very entry, in this working copy. */
  listed: boolean;
  /** The working copy the entry is in (what `listed` is told for). */
  scope?: string;
}

/** One entry of a schema: its id, and for a section its page as well. */
export const entryKey = (w: { id: string; page?: number }): string =>
  w.page === undefined ? w.id : `${w.id}\0${String(w.page)}`;

export interface Screened {
  /** Ids with refused wording, and ids with a short match that only warns. */
  refuse: string[];
  warn: string[];
  /** The refused wording, one per id and property. */
  refused: Refusal[];
  /** Matching wording the agent confirmed as the form's own: let through. */
  confirmed: Refusal[];
}

const keyOf = (r: { prop: string; text: string }) => `${r.prop}\0${norm(r.text)}`;
/** That wording on that entry of that working copy. */
const placeOf = (r: { id: string; page?: number; prop: string; text: string; scope?: string }) =>
  `${r.scope ?? ""}\0${entryKey(r)}\0${keyOf(r)}`;

function keep(set: Set<string>, key: string): void {
  set.delete(key);
  set.add(key);
  if (set.size > MAX_REMEMBERED) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
}

export class EchoGuard {
  private readonly seen = new Set<string>();
  /** Refused wording the agent has been told about (property + text), and the
   *  entries it was named on (working copy + entry + property + text). */
  private readonly told = new Set<string>();
  private readonly toldAt = new Set<string>();
  /** Wording the agent confirmed as the form's own (property + text: an id
   *  does not survive group / ungroup, and the wording is what was vouched). */
  private readonly vouched = new Set<string>();

  private add(v: unknown): void {
    if (typeof v === "number" && Number.isFinite(v)) v = String(v);
    if (typeof v !== "string") return;
    const n = norm(v);
    if (!n || n.length > MAX_LEN) return;
    keep(this.seen, n);
    // An answer of several lines is an answer line by line too (an address's
    // street line copied into a caption), from the length a match refuses at.
    if (!/[\r\n]/.test(v)) return;
    for (const line of v.split(/\r\n|\r|\n/)) {
      const l = norm(line);
      if (l.length >= ECHO_REFUSE_MIN && l.length <= MAX_LEN) keep(this.seen, l);
    }
  }

  /** Every text in `v`, whatever it was meant for (no entry tells a free-text
   *  answer from a choice here), from the length a match refuses at. */
  private addAny(v: unknown, depth = 0): void {
    if (depth > 4) return;
    if (Array.isArray(v)) for (const x of v) this.addAny(x, depth + 1);
    else if (isRec(v)) for (const x of Object.values(v)) this.addAny(x, depth + 1);
    else {
      const s = typeof v === "number" && Number.isFinite(v) ? String(v) : v;
      if (typeof s === "string" && norm(s).length >= ECHO_REFUSE_MIN) this.add(s);
    }
  }

  /** Remember the values of a call that failed before its form was read (so
   *  `remember` never saw them): the agent has typed them all the same, and one
   *  can come back as wording on its next call. */
  rememberUnread(values: Record<string, unknown>): void {
    this.addAny(values);
  }

  /** The same answers as the page shows them: the text of every mark the core
   *  would stamp for these values (a date in its field's format, text as
   *  normalized), a comb's cells joined into one answer. */
  private addShown(
    schema: ReturnType<typeof normalizeSchema>,
    entries: ReturnType<typeof agentEntries>,
    values: Record<string, unknown>,
  ): void {
    const shown = new Map<string, string>(); // mark key → text (`key#i` cells joined)
    try {
      const mapped = mapAgentValues(schema, values, { loadImage: NO_IMAGE });
      const marks = buildMarks({
        fields: schema.fields,
        groups: schema.groups,
        values: mapped.values,
        rowCounts: mapped.rowCounts,
      });
      for (const page of marks.values()) {
        for (const m of page) {
          if (m.image || m.checkbox) continue; // a signature, a tick: not free text
          const key = m.key.split("#")[0];
          shown.set(key, (shown.get(key) ?? "") + m.text);
        }
      }
    } catch {
      return; // the answers as passed are remembered already
    }
    for (const e of entries) {
      if (e.kind !== "comb") continue;
      let cells = "";
      for (const s of e.slots) {
        cells += shown.get(s.key) ?? "";
        shown.delete(s.key); // one character of an answer is not an answer
      }
      this.add(cells);
      if (e.dateFormat) this.add(inPrintedFormat(cells, e.dateFormat));
    }
    for (const [, text] of shown) this.add(text);
  }

  /** Remember the free-text values of one fill/preview call. */
  remember(render: unknown, values: Record<string, unknown>): void {
    let schema: ReturnType<typeof normalizeSchema>;
    let entries: ReturnType<typeof agentEntries>;
    try {
      schema = normalizeSchema(render as Parameters<typeof normalizeSchema>[0]);
      entries = agentEntries(schema);
    } catch {
      this.addAny(values);
      return;
    }
    this.addShown(schema, entries, values);
    for (const e of entries) {
      const v = values[e.id];
      if (v === undefined) continue;
      if (e.kind === "field" || e.kind === "comb") {
        if (FREE_TEXT.has(e.type)) this.add(v);
      } else if (e.kind === "table" && isRec(v)) {
        for (const c of e.cells) if (FREE_TEXT.has(c.type)) this.add(v[c.id]);
      } else if (e.kind === "table_rows" && Array.isArray(v)) {
        const ids = new Set(e.columns.map((c) => c.id));
        for (const row of v) {
          if (!isRec(row)) continue;
          for (const c of e.columns) if (FREE_TEXT.has(c.type)) this.add(row[c.id]);
          // A cell may also be given under its column's label (the stamping
          // core takes that): remembered whatever the column's type.
          for (const [k, cell] of Object.entries(row)) if (!ids.has(k)) this.add(cell);
        }
      }
    }
  }

  /** Wording that repeats a remembered answer: refusals (it holds one of 6+
   *  chars, or equals one of 4+) and warnings (equals a shorter one). Wording
   *  the agent confirmed is listed apart and refuses nothing. `scope` is the
   *  working copy the wording is in: an entry named in one copy is not thereby
   *  named in another (section ids, and a copied template's ids, repeat). */
  check(
    wording: readonly {
      id: string;
      page?: number;
      prop?: string;
      text: string;
      /** Wording nobody sees (a comb cell's label): a placeholder there ("D1")
       *  equal to an answer shorter than ECHO_REFUSE_MIN is not warned about;
       *  one equal to a longer answer ("SW1A", "1234") or holding one of
       *  ECHO_CONTAINS_MIN+ characters is refused as anywhere else. */
      quiet?: boolean;
    }[],
    scope = "",
  ): Screened {
    const refuse = new Set<string>();
    const warn = new Set<string>();
    const refused: Refusal[] = [];
    const confirmed: Refusal[] = [];
    if (this.seen.size === 0) return { refuse: [], warn: [], refused, confirmed };
    for (const w of wording) {
      const n = norm(w.text);
      if (!n) continue;
      let hit = false;
      if (this.seen.has(n)) {
        if (n.length < ECHO_REFUSE_MIN) {
          if (!w.quiet) warn.add(w.id);
          continue;
        }
        hit = true;
      } else if (n.length >= ECHO_CONTAINS_MIN) {
        for (const v of this.seen) {
          if (v.length >= ECHO_CONTAINS_MIN && n.includes(v) && holds(n, v)) {
            hit = true;
            break;
          }
        }
      }
      if (!hit) continue;
      const r = {
        id: w.id,
        ...(w.page === undefined ? {} : { page: w.page }),
        prop: w.prop ?? "",
        text: w.text,
        ...(scope ? { scope } : {}),
      };
      const key = keyOf(r);
      if (this.vouched.has(key)) confirmed.push({ ...r, shown: true, listed: true });
      else {
        refuse.add(w.id);
        refused.push({ ...r, shown: this.told.has(key), listed: this.toldAt.has(placeOf(r)) });
      }
    }
    return {
      refuse: [...refuse],
      warn: [...warn].filter((id) => !refuse.has(id)),
      refused,
      confirmed,
    };
  }

  /** The agent has now been told about these refusals (an op's rejection, a
   *  save's answer_in_template): from here on it can confirm them. */
  tell(refused: readonly Refusal[]): void {
    for (const r of refused) {
      keep(this.told, keyOf(r));
      keep(this.toldAt, placeOf(r));
    }
  }

  /** The agent confirmed these as the form's own wording. */
  confirm(refused: readonly Refusal[]): void {
    for (const r of refused) keep(this.vouched, keyOf(r));
  }

  get size(): number {
    return this.seen.size;
  }
}

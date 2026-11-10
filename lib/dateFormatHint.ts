// A standalone date field's printed format, read from a pattern hint in its
// label: "Date of birth (MM/DD/YYYY)" asks for month-first, "Data urodzenia
// (DD.MM.RRRR)" for day-first with dots. dateFormatOf (types.ts) uses it for a
// field stored without a date_format; an explicit date_format always wins.
//
// Mirrors date_format_hint.py exactly (the extraction pipeline writes the same
// result into new fields, and agent_schema.py tells /v1 agents the same thing);
// both sides are held to tests/fixtures/date_format_hint/cases.json. Rules and
// vocabulary are documented in date_format_hint.py. Pure: part of
// FILL_CORE_FILES, so the Node-side fills (@fenfill/mcp) can bundle it.

// Python's [^\W\d_]: letters plus non-decimal numerics.
const WORD_RE = /[\p{L}\p{Nl}\p{No}]+/gu;
const GAP_RE = /^(?:\s*[./,\-–]\s*|\s+)$/u;

type Part = "D" | "M" | "Y";

const WORDS: Record<string, Part> = {
  // day
  day: "D",
  dzień: "D",
  dzien: "D",
  tag: "D",
  jour: "D",
  día: "D",
  dia: "D",
  giorno: "D",
  dag: "D",
  // month
  month: "M",
  mo: "M",
  miesiąc: "M",
  miesiac: "M",
  monat: "M",
  mois: "M",
  mes: "M",
  mese: "M",
  maand: "M",
  // year
  year: "Y",
  yr: "Y",
  rok: "Y",
  jahr: "Y",
  année: "Y",
  annee: "Y",
  año: "Y",
  ano: "Y",
  anno: "Y",
  jaar: "Y",
};

const DAY_FIRST: Record<string, string> = {
  "/": "DD/MM/YYYY",
  ".": "DD.MM.YYYY",
  "-": "DD-MM-YYYY",
  " ": "DD/MM/YYYY",
};

// The date parts (D/M/Y) one token can stand for; empty when none.
function roles(word: string): Set<Part> {
  const w = word.toLowerCase();
  const out = new Set<Part>();
  if (Object.hasOwn(WORDS, w)) {
    out.add(WORDS[w]);
    return out;
  }
  // A pattern token: one ASCII letter repeated, at most four long.
  if (!/^([a-z])\1{0,3}$/.test(w)) return out;
  const c = w[0];
  const n = w.length;
  if ("dtjg".includes(c) && n <= 2) out.add("D");
  if (c === "m" && n <= 2) out.add("M");
  if ((c === "y" && n !== 3) || ("rja".includes(c) && (n === 2 || n === 4))) out.add("Y");
  return out;
}

// The normalized separator between two tokens, or null if `text` is not one.
function gap(text: string): string | null {
  if (!GAP_RE.test(text)) return null;
  for (const ch of text) {
    if (ch === "/" || ch === "." || ch === "-") return ch;
    if (ch === "–") return "-";
  }
  return " "; // whitespace or a comma
}

function order(a: Set<Part>, b: Set<Part>, c: Set<Part>): string | null {
  const orders = new Set<string>();
  for (const x of a)
    for (const y of b) for (const z of c) if (new Set([x, y, z]).size === 3) orders.add(x + y + z);
  return orders.size === 1 ? [...orders][0] : null;
}

function format(ord: string, sep: string): string | null {
  if (ord === "DMY") return DAY_FIRST[sep] ?? null;
  if (ord === "MDY") return "MM/DD/YYYY";
  if (ord === "YMD") return "YYYY-MM-DD";
  return null;
}

// A separator-less hint written as one word ("MMDDYYYY", "yyyymmdd"): three
// runs of a repeated letter, each at least two long.
function compact(word: string): string | null {
  const runs = word.toLowerCase().match(/(.)\1*/gu) ?? [];
  if (runs.length !== 3 || runs.some((r) => r.length < 2)) return null;
  const ord = order(roles(runs[0]), roles(runs[1]), roles(runs[2]));
  return ord ? format(ord, " ") : null;
}

/** The DATE_FORMATS entry a label's printed pattern hint asks for, or null. */
export function dateFormatFromLabel(label: unknown): string | null {
  if (typeof label !== "string" || !label) return null;
  const words = [...label.matchAll(WORD_RE)].map((m) => ({
    text: m[0],
    start: m.index,
    end: m.index + m[0].length,
  }));
  const found = new Set<string>();
  for (const w of words) {
    const f = compact(w.text);
    if (f) found.add(f);
  }
  for (let i = 0; i + 2 < words.length; i++) {
    const [w0, w1, w2] = [words[i], words[i + 1], words[i + 2]];
    const s1 = gap(label.slice(w0.end, w1.start));
    const s2 = gap(label.slice(w1.end, w2.start));
    if (s1 === null || s1 !== s2) continue;
    const ord = order(roles(w0.text), roles(w1.text), roles(w2.text));
    const f = ord ? format(ord, s1) : null;
    if (f) found.add(f);
  }
  return found.size === 1 ? [...found][0] : null;
}

// Agent values → fill-store values, and the agent's local PDF fill.
//
// The @fenfill/mcp package fills PDFs on the user's machine: an agent sends
// `{ "<agent id>": value }` (ids and types from the /v1 agent schema,
// agent_schema.py), and this module turns them into the exact `values` /
// `rowCounts` the browser's fill store would hold for the same answers, then
// runs the browser's own buildMarks → stampPdf. Fill values never leave the
// machine: nothing here touches the network.
//
// Which ids exist, and their types, mirrors agent_schema.py `_project`
// (agentValues.parity.test.ts proves it on every tests/fixtures/agent_schema
// fixture): only fields on pages listed in `pages[]` (each page number once),
// only groups with at least one resolvable member, only known group kinds; a
// field that is a member of ANY group is never exposed on its own.
//
// Node-safe: no fs, no DOM, no React, no store. pdf-lib is imported lazily,
// like stampPdf. Signature images are read through the injected `loadImage`.

import type * as PdfLibModule from "pdf-lib";
import type { PDFDict, PDFDocument, PDFObject } from "pdf-lib";

import { type Field, type Group, groupFormatOf, type TemplateSchema } from "@/types";

import { combDateWrites, combEntries, type CombSlot, combSlots, isDmyFormat } from "./combFill";
import {
  bucketRows,
  buildFieldById,
  choiceKey,
  expKey,
  expLayout,
  fieldKey,
  MULTI_SEP,
  resolveMembers,
} from "./fillKeys";
import { buildMarks } from "./fillMarks";
import { normalizeSchema } from "./normalizeSchema";
import { dataUrlToBytes } from "./signatureImage";
import { type Mark, type Placement, stampPdf } from "./stampPdf";

/** Info-dictionary key the MCP writes into every PDF it fills (and refuses to analyze). */
export const MCP_OUTPUT_TAG = "FenfillMcpOutput";

/** A value that was not applied. A nested cell's `id` is `<table id>.<cell id>`,
 *  a table_rows cell's `<table id>[<row>].<column key>`. */
export interface AgentSkip {
  id: string;
  reason: string;
  suggestions?: string[];
}

export interface AgentValuesResult {
  /** fillStore-shaped: f{id}, c{gid}, e{gid}.{row}.{col}. */
  values: Record<string, string>;
  rowCounts: Record<string, number>;
  /** Top-level agent entries applied (a table counts once). */
  filled: number;
  skipped: AgentSkip[];
  warnings: string[];
}

/** Reads a signature image. The MCP reads files; the core never touches fs. */
export type LoadImage = (path: string) => Uint8Array;

// ---- The agent's view of a schema (mirrors agent_schema.py) -----------------

/** An input's agent type (a field, a table cell, a table_rows column). */
export type AgentFieldType = "text" | "multiline" | "date" | "checkbox" | "signature" | "comb";

export type AgentType = AgentFieldType | "radio" | "multiselect" | "table" | "table_rows";

export interface AgentCell {
  id: string;
  row: number;
  col: number;
  type: AgentFieldType;
  label: string;
  field: Field;
}

export interface AgentColumn {
  id: string;
  label: string;
  type: AgentFieldType;
  field: Field;
}

interface EntryBase {
  id: string;
  label: string;
  required: boolean;
}

interface GroupBase extends EntryBase {
  group: Group;
  /** resolveMembers order. */
  members: Field[];
}

/** One agent id: an ungrouped field or a group. */
export type AgentEntry =
  | (EntryBase & { kind: "field"; type: AgentFieldType; field: Field; external: boolean })
  | (GroupBase & {
      kind: "comb";
      type: "comb";
      slots: CombSlot[];
      maxLength: number;
      cellType: "integer" | "char" | "date";
      dateFormat: string | null;
    })
  | (GroupBase & { kind: "choice"; type: "radio" | "multiselect"; options: Field[] })
  | (GroupBase & { kind: "table"; type: "table"; cells: AgentCell[] })
  | (GroupBase & {
      kind: "table_rows";
      type: "table_rows";
      columns: AgentColumn[];
      maxRows: number;
    });

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const strOf = (v: unknown): string => (typeof v === "string" ? v : "");
const labelOf = (x: { label?: unknown }): string => strOf(x.label);
const cellCount = (f: { cells?: unknown }): number => (Array.isArray(f.cells) ? f.cells.length : 0);

// agent_schema.py `_value_type`.
function valueType(f: Field, combOk: boolean): AgentFieldType {
  const t: unknown = f.type;
  if (combOk && (t === "text" || t === "date") && cellCount(f) > 1) return "comb";
  if (t === "text") {
    const fmt: unknown = f.format;
    return isRecord(fmt) && fmt.variant === "multiline" ? "multiline" : "text";
  }
  if (t === "date" || t === "checkbox" || t === "signature") return t;
  return "text";
}

// agent_schema.py `exp_body_rows` (tolerant of junk rows, like the Python).
function bodyRows(g: Group, fieldById: Map<string, Field>): (Field | null)[][] {
  const grid: unknown = g.grid;
  if (!Array.isArray(grid) || grid.length === 0) return [];
  return grid.map((row: unknown) =>
    (Array.isArray(row) ? row : []).map((id: unknown) =>
      typeof id === "string" ? (fieldById.get(id) ?? null) : null,
    ),
  );
}

// agent_schema.py `_classic_rows` (SidebarTable's cell placement).
function classicRows(
  g: Group,
  members: Field[],
  fieldById: Map<string, Field>,
): (Field | null)[][] {
  const grid: unknown = g.grid;
  if (Array.isArray(grid) && grid.length > 0) {
    const rows = grid.map((r: unknown): unknown[] => (Array.isArray(r) ? r : []));
    const colCount = Math.max(Math.max(...rows.map((r) => r.length)), 1);
    return rows.map((row) => {
      const cells: (Field | null)[] = Array.from({ length: colCount }, () => null);
      row.forEach((id, c) => {
        if (id != null) cells[c] = typeof id === "string" ? (fieldById.get(id) ?? null) : null;
      });
      return cells;
    });
  }
  const rows = bucketRows(members);
  if (rows.length === 0) return [];
  const colCount = Math.max(Math.max(...rows.map((r) => r.length)), 1);
  const widest = rows.reduce((a, b) => (b.length > a.length ? b : a), rows[0]);
  const centers = Array.from({ length: colCount }, (_, c) =>
    c < widest.length ? widest[c].xpct + widest[c].wpct / 2 : ((c + 0.5) / colCount) * 100,
  );
  const colFor = (m: Field) => {
    const cx = m.xpct + m.wpct / 2;
    let best = 0;
    let bestD = Infinity;
    centers.forEach((center, i) => {
      const d = Math.abs(cx - center);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };
  return rows.map((rowMembers) => {
    const cells: (Field | null)[] = Array.from({ length: colCount }, () => null);
    for (const m of rowMembers) cells[colFor(m)] = m;
    return cells;
  });
}

function groupEntry(g: Group, members: Field[], fieldById: Map<string, Field>): AgentEntry | null {
  const base = { id: g.id, label: labelOf(g), required: g.required === true, group: g, members };
  const kind: unknown = g.kind;
  if (kind === "choice") {
    const multi = groupFormatOf(g) === "multiple";
    return { ...base, kind: "choice", type: multi ? "multiselect" : "radio", options: members };
  }
  if (kind === "comb") {
    const slots = combSlots(members);
    const cellType = g.cell_type === "integer" || g.cell_type === "date" ? g.cell_type : "char";
    const fmt = strOf(g.date_format);
    return {
      ...base,
      kind: "comb",
      type: "comb",
      slots,
      maxLength: slots.reduce((n, s) => n + s.len, 0),
      cellType,
      dateFormat: cellType === "date" && fmt !== "" ? fmt : null,
    };
  }
  if (kind !== "table") return null; // unknown kinds render nothing, so expose nothing
  if (groupFormatOf(g) === "expandable") {
    const body = bodyRows(g, fieldById);
    const firstRow = body.length > 0 ? body[0] : (bucketRows(members)[0] ?? []);
    const headerCols: unknown[] = Array.isArray(g.header_cols) ? g.header_cols : [];
    const columns: AgentColumn[] = [];
    firstRow.forEach((m, c) => {
      if (!m) return;
      let label = labelOf(m);
      if (!label && c < headerCols.length) label = strOf(headerCols[c]);
      columns.push({ id: m.id, label, type: valueType(m, false), field: m });
    });
    const { capacity } = expLayout(members);
    return { ...base, kind: "table_rows", type: "table_rows", columns, maxRows: capacity };
  }
  const matrix = groupFormatOf(g) === "checkbox_matrix";
  const cells: AgentCell[] = [];
  classicRows(g, members, fieldById).forEach((row, r) => {
    row.forEach((m, c) => {
      if (!m) return;
      const type = matrix ? "checkbox" : valueType(m, true);
      cells.push({ id: m.id, row: r, col: c, type, label: labelOf(m), field: m });
    });
  });
  return { ...base, kind: "table", type: "table", cells };
}

/** The agent entries of a (normalized) schema, page by page — the same ids and
 *  types agent_schema.py projects. Not in reading order. */
export function agentEntries(schema: TemplateSchema): AgentEntry[] {
  const fields: Field[] = Array.isArray(schema.fields) ? schema.fields : [];
  const groups: Group[] = Array.isArray(schema.groups) ? schema.groups : [];
  const pages: unknown[] = Array.isArray(schema.pages) ? schema.pages : [];
  const fieldById = buildFieldById(fields);
  const grouped = new Set<unknown>();
  for (const g of groups) {
    const ids: unknown = g.members;
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") grouped.add(id);
  }
  const out: AgentEntry[] = [];
  const seenPages = new Set<unknown>();
  for (const p of pages) {
    if (!isRecord(p) || seenPages.has(p.page)) continue;
    const pno = p.page;
    seenPages.add(pno);
    for (const f of fields) {
      if (grouped.has(f.id) || f.page !== pno) continue;
      const type = valueType(f, true);
      out.push({
        kind: "field",
        id: f.id,
        type,
        label: labelOf(f),
        required: f.required === true,
        field: f,
        // signingRequirement.ts isExternalSigning, inlined (that module imports icons)
        external:
          type === "signature" && !!f.signing_requirement && f.signing_requirement !== "appearance",
      });
    }
    for (const g of groups) {
      if (g.page !== pno) continue;
      const members = Array.isArray(g.members) ? resolveMembers(g, fieldById) : [];
      if (members.length === 0) continue;
      const e = groupEntry(g, members, fieldById);
      if (e) out.push(e);
    }
  }
  return out;
}

// ---- Value coercion ------------------------------------------------------------

type ImageKind = "png" | "jpeg";
interface Img {
  kind: ImageKind;
}
type Coerced = { value: string; warn?: string; image?: Img } | { reason: string };

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const COMB_SEPARATORS = /[\s./\\-]/g;
// Mass-fill's checkbox vocabulary (case-insensitive, trimmed).
const TRUE_WORDS = new Set(["x", "✗", "✓", "✔", "yes", "y", "true", "1", "tak"]);
const FALSE_WORDS = new Set(["", "no", "n", "false", "0", "nie", "-", "–"]);
const EXTERNAL_REASON =
  "this signature is signed outside the app (print & sign / e-sign), so it is left blank, as in the browser";

const normLabel = (s: string): string =>
  s.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

const kindOf = (v: unknown): string =>
  Array.isArray(v) ? "an array" : v === null ? "null" : `a ${typeof v}`;

function isIsoDate(s: string): boolean {
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= days[mo - 1];
}

function coerceText(raw: unknown, multiline: boolean): Coerced {
  let s: string;
  if (typeof raw === "string") s = raw;
  else if (typeof raw === "number" && Number.isFinite(raw)) s = String(raw);
  else return { reason: `expected a string (or a number), got ${kindOf(raw)}` };
  s = s.normalize("NFC");
  if (multiline) return { value: s.replace(/\r\n/g, "\n") };
  if (/\r?\n/.test(s)) {
    return {
      value: s.replace(/\r?\n/g, " "),
      warn: "newlines were replaced with spaces (a single-line field)",
    };
  }
  return { value: s };
}

function coerceDate(raw: unknown): Coerced {
  const s = typeof raw === "string" ? raw.trim() : null;
  if (s === null || !isIsoDate(s)) {
    return { reason: "expected a valid calendar date as an ISO string YYYY-MM-DD" };
  }
  return { value: s };
}

function coerceCheckbox(raw: unknown): Coerced {
  if (typeof raw === "boolean") return { value: raw ? "X" : "" };
  if (raw === 1 || raw === 0) return { value: raw === 1 ? "X" : "" };
  if (typeof raw === "string") {
    const w = raw.normalize("NFC").trim().toLowerCase();
    if (TRUE_WORDS.has(w)) return { value: "X" };
    if (FALSE_WORDS.has(w)) return { value: "" };
  }
  return { reason: 'expected true/false (or 1/0, "yes"/"no", "x"/"")' };
}

/** A non-negative safe integer as its digits (a comb takes one as a string). */
const wholeNumber = (v: unknown): string | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? String(v) : null;

function coerceCombField(raw: unknown, maxLen: number): Coerced {
  const num = wholeNumber(raw);
  if (typeof raw !== "string" && num === null) {
    return {
      reason: `expected a string (or a non-negative whole number) of at most ${maxLen} characters, got ${typeof raw === "number" ? "a negative or fractional number" : kindOf(raw)}`,
    };
  }
  const s = (num ?? (raw as string)).normalize("NFC");
  if (Array.from(s).length > maxLen) return { reason: `longer than its ${maxLen} cells` };
  return { value: s };
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 without Buffer/btoa (the core stays runtime-agnostic). */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = "";
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const b1 = i + 1 < n ? bytes[i + 1] : 0;
    const b2 = i + 2 < n ? bytes[i + 2] : 0;
    const t = (bytes[i] << 16) | (b1 << 8) | b2;
    chunk +=
      B64[(t >> 18) & 63] +
      B64[(t >> 12) & 63] +
      (i + 1 < n ? B64[(t >> 6) & 63] : "=") +
      (i + 2 < n ? B64[t & 63] : "=");
    if (chunk.length >= 65536) {
      parts.push(chunk);
      chunk = "";
    }
  }
  parts.push(chunk);
  return parts.join("");
}

function sniffImage(b: Uint8Array): ImageKind | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length >= 8 && png.every((x, i) => b[i] === x)) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  return null;
}

// Whether a PNG can be transparent: an alpha colour type (4 grey+alpha, 6 RGBA)
// or a tRNS chunk before the image data.
function pngHasAlpha(b: Uint8Array): boolean {
  if (b.length < 26) return false;
  if (b[25] === 4 || b[25] === 6) return true;
  for (let off = 8; off + 8 <= b.length; ) {
    const len = ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
    const type = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
    if (type === "tRNS") return true;
    if (type === "IDAT" || type === "IEND") return false;
    off += 12 + len;
  }
  return false;
}

function coerceSignature(raw: unknown, loadImage: LoadImage): Coerced {
  const path = typeof raw === "string" ? raw : isRecord(raw) ? strOf(raw.image_path) : "";
  if (path.trim() === "") {
    return {
      reason: 'expected {"image_path": "<absolute path to a PNG or JPEG>"} or a path string',
    };
  }
  let bytes: Uint8Array;
  try {
    bytes = loadImage(path);
  } catch (e) {
    return {
      reason: `could not read the image: ${e instanceof Error ? e.message : "read failed"}`,
    };
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) return { reason: "the image is larger than 5 MB" };
  const kind = sniffImage(bytes);
  if (!kind) return { reason: "not a PNG or JPEG image" };
  const opaque = kind === "jpeg" || !pngHasAlpha(bytes);
  return {
    value: `data:image/${kind};base64,${bytesToBase64(bytes)}`,
    image: { kind },
    ...(opaque
      ? {
          warn: `the ${kind === "jpeg" ? "JPEG" : "PNG (no transparency)"} is stamped as-is, with no background removal (unlike the browser's signature upload); a transparent PNG looks cleanest`,
        }
      : {}),
  };
}

function coerceValue(type: AgentFieldType, raw: unknown, f: Field, loadImage: LoadImage): Coerced {
  switch (type) {
    case "text":
      return coerceText(raw, false);
    case "multiline":
      return coerceText(raw, true);
    case "date":
      return coerceDate(raw);
    case "checkbox":
      return coerceCheckbox(raw);
    case "signature":
      return coerceSignature(raw, loadImage);
    case "comb":
      return coerceCombField(raw, cellCount(f));
  }
}

// A comb group's value → one character per cell (browser writeback order).
function combGroupChars(
  e: Extract<AgentEntry, { kind: "comb" }>,
  raw: unknown,
): { chars: string[] } | { reason: string } {
  const max = e.maxLength;
  // An integer comb also takes a non-negative whole number.
  const num = e.cellType === "integer" ? wholeNumber(raw) : null;
  if (typeof raw !== "string" && num === null) {
    return {
      reason:
        e.cellType === "integer" && typeof raw === "number"
          ? "expected digits (a string, or a non-negative whole number)"
          : `expected a string, got ${kindOf(raw)}`,
    };
  }
  let s = (num ?? (raw as string)).normalize("NFC");
  if (e.cellType === "integer") {
    s = s.replace(COMB_SEPARATORS, "");
    if (!/^\d*$/.test(s)) return { reason: "expected digits only" };
  } else if (e.cellType === "date") {
    // SidebarComb uses its date picker whenever the printed format has one
    // character per cell (`fmt.length === slots`), separators included
    // ("DD.MM.YYYY" over 10 cells); picking writes only the D/M/Y cells. The
    // agent may pass an ISO date exactly then (a format with no D/M/Y letter,
    // e.g. "RRRR", has nowhere to put one).
    const fmt = (e.dateFormat ?? "").toUpperCase();
    const pickable = fmt.length === max && /[DMY]/.test(fmt);
    const separated = pickable && !isDmyFormat(fmt);
    const iso = s.trim();
    if (ISO_DATE.test(iso)) {
      if (!pickable) {
        return {
          reason: `this comb's printed format (${e.dateFormat ?? "unknown"}) does not take an ISO date: pass exactly ${max} digits in the printed order`,
        };
      }
      if (!isIsoDate(iso)) return { reason: "not a valid calendar date" };
      const [y, mo, d] = iso.split("-");
      const count = (r: string) => fmt.split("").filter((x) => x === r).length;
      const lossy = (digits: string, n: number) =>
        n > 0 && digits.length > n && /[1-9]/.test(digits.slice(0, digits.length - n));
      const yc = count("Y");
      if (lossy(d, count("D")) || lossy(mo, count("M")) || lossy(yc >= 4 ? y : y.slice(-2), yc)) {
        return {
          reason: `the date does not fit this comb's ${fmt} cells: pass exactly ${max} digits`,
        };
      }
      const chars = Array.from({ length: max }, () => "");
      for (const [cell, ch] of combDateWrites(iso, fmt)) chars[cell] = ch;
      return { chars };
    }
    // The cells as printed: digits in the D/M/Y cells and a separator in each
    // other one ("17.05.2024" over DD.MM.YYYY).
    const cells = Array.from(s);
    const asPrinted = (ch: string, i: number) =>
      /[DMY]/.test(fmt[i]) ? /^\d$/.test(ch) : ch === fmt[i] || /^[\s./\\-]$/.test(ch);
    if (separated && cells.length === max && cells.every(asPrinted)) return { chars: cells };
    s = s.replace(COMB_SEPARATORS, "");
    if (s !== "" && (!/^\d+$/.test(s) || s.length !== max)) {
      return {
        reason: separated
          ? `expected an ISO date YYYY-MM-DD, exactly ${max} digits, or the ${max} characters as printed (${e.dateFormat ?? fmt})`
          : pickable
            ? `expected an ISO date YYYY-MM-DD or exactly ${max} digits`
            : `expected exactly ${max} digits in the printed order${e.dateFormat ? ` (${e.dateFormat})` : ""}`,
      };
    }
  }
  const chars = Array.from(s);
  if (chars.length > max) return { reason: `longer than the comb's ${max} cells` };
  return { chars };
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Ids to suggest for an unknown key among `items`: exact (normalized) label
// matches, then id prefixes, then the nearest ids by edit distance.
function suggestIds(key: string, items: readonly { id: string; label: string }[]): string[] {
  const out: string[] = [];
  const add = (id: string) => {
    if (!out.includes(id)) out.push(id);
  };
  const nk = normLabel(key);
  if (nk) for (const it of items) if (normLabel(it.label) === nk) add(it.id);
  const lk = key.toLowerCase();
  if (lk.length >= 4) for (const it of items) if (it.id.toLowerCase().startsWith(lk)) add(it.id);
  if (lk.length <= 64) {
    const limit = Math.max(2, Math.floor(lk.length / 4));
    items
      .map((it) => ({ id: it.id, d: editDistance(lk, it.id.toLowerCase()) }))
      .filter((x) => x.d <= limit)
      .sort((x, y) => x.d - y.d)
      .slice(0, 3)
      .forEach((x) => {
        add(x.id);
      });
  }
  return out.slice(0, 5);
}

const skipOf = (id: string, reason: string, suggestions?: string[]): AgentSkip =>
  suggestions && suggestions.length > 0 ? { id, reason, suggestions } : { id, reason };

type OptionMatch = { id: string } | { reason: string; suggestions: string[] };

// Separators between a question and its answer in a composite option label
// ("Smoke? No", "Status: Married", "Smoke - No").
const QUESTION_SEP = /^[\s?:\-–—,.;/|]+/;

/** `label` without `prefix` (both normalized), at a separator, or null. */
function afterPrefix(label: string, prefix: string): string | null {
  if (!prefix || !label.startsWith(prefix) || label.length === prefix.length) return null;
  const rest = label.slice(prefix.length);
  // A cut inside a word ("Yesterday" after "Yes") is no prefix.
  if (!QUESTION_SEP.test(rest) && !/[\s?:\-–—,.;/|]$/.test(prefix)) return null;
  const bare = rest.replace(QUESTION_SEP, "").trim();
  return bare || null;
}

/** The options' shared leading words ("smoke? " of "Smoke? Yes" / "Smoke? No"),
 *  cut back to the last separator, normalized; "" when they share none. */
function sharedPrefix(labels: string[]): string {
  if (labels.length < 2) return "";
  let p = labels[0];
  for (const l of labels.slice(1)) {
    let i = 0;
    while (i < p.length && i < l.length && p[i] === l[i]) i++;
    p = p.slice(0, i);
  }
  const m = /^(.*[\s?:\-–—,.;/|])/.exec(p);
  return m ? m[1] : "";
}

/**
 * The short forms an option also answers to besides its full label: the
 * label without the group's own label in front ("Smoke? No" in group "Smoke"),
 * without the words every option of the group starts with, and the part after
 * its last "?" or ":". Normalized.
 */
function bareForms(label: string, groupLabel: string, shared: string): string[] {
  const n = normLabel(label);
  const out = new Set<string>();
  const add = (s: string | null) => {
    if (s && s !== n) out.add(s);
  };
  add(afterPrefix(n, normLabel(groupLabel)));
  add(afterPrefix(n, shared));
  const q = Math.max(n.lastIndexOf("?"), n.lastIndexOf(":"));
  if (q >= 0) add(n.slice(q + 1).trim());
  return [...out];
}

function matchOption(options: Field[], raw: unknown, groupLabel = ""): OptionMatch {
  const ids = options.map((o) => o.id);
  const v = typeof raw === "number" && Number.isFinite(raw) ? String(raw) : raw;
  if (typeof v !== "string") {
    return { reason: `expected an option id or label, got ${kindOf(raw)}`, suggestions: ids };
  }
  const exact = options.find((o) => o.id === v);
  if (exact) return { id: exact.id };
  const n = normLabel(v);
  if (!n) {
    return {
      reason: "empty value: omit the id (or pass null) to leave it unselected",
      suggestions: ids,
    };
  }
  const hits = [...new Set(options.filter((o) => normLabel(labelOf(o)) === n).map((o) => o.id))];
  if (hits.length === 1) return { id: hits[0] };
  if (hits.length > 1) {
    return {
      reason: "ambiguous: several options have this label; pass the option id",
      suggestions: hits,
    };
  }
  // The bare option text of a composite label ("No" for "Smoke? No"), when
  // exactly one option answers to it.
  const shared = sharedPrefix(options.map((o) => normLabel(labelOf(o))));
  const bare = [
    ...new Set(
      options.filter((o) => bareForms(labelOf(o), groupLabel, shared).includes(n)).map((o) => o.id),
    ),
  ];
  if (bare.length === 1) return { id: bare[0] };
  if (bare.length > 1) {
    return {
      reason: "ambiguous: several options end in this text; pass the full option label or id",
      suggestions: bare,
    };
  }
  const labels = options.map((o) => JSON.stringify(labelOf(o))).join(", ");
  return { reason: `no option has this id or label (options: ${labels})`, suggestions: ids };
}

type ColumnMatch = { col: AgentColumn } | { reason: string; suggestions: string[] };

function matchColumn(columns: AgentColumn[], key: string): ColumnMatch {
  const byId = columns.find((c) => c.id === key);
  if (byId) return { col: byId };
  const n = normLabel(key);
  const hits = n ? columns.filter((c) => normLabel(c.label) === n) : [];
  if (hits.length === 1) return { col: hits[0] };
  if (hits.length > 1) {
    return {
      reason: "ambiguous: several columns have this label; use the column id",
      suggestions: hits.map((c) => c.id),
    };
  }
  return { reason: "unknown column", suggestions: suggestIds(key, columns) };
}

// ---- Mapping ---------------------------------------------------------------------

interface PendingImage extends Img {
  key: string;
  skipId: string;
  top: boolean;
  warning?: string;
}

interface Mapped extends AgentValuesResult {
  images: PendingImage[];
  /** Fill-store key → the agent id its value came from (a nested cell's
   *  `<table id>.<cell id>`), for placement warnings. */
  keyIds: Map<string, string>;
  /** Top-level ids that counted as filled. */
  filledIds: Set<string>;
  entries: AgentEntry[];
}

const MAX_SUGGESTED = 50;

// Every id nested inside an entry (options, comb cells, table cells, columns),
// so an agent passing one at the top level is told where it belongs.
function nestedOwners(entries: AgentEntry[]): Map<string, { what: string; owner: AgentEntry }> {
  const out = new Map<string, { what: string; owner: AgentEntry }>();
  const put = (id: string, what: string, owner: AgentEntry) => {
    if (!out.has(id)) out.set(id, { what, owner });
  };
  for (const e of entries) {
    if (e.kind === "choice") for (const o of e.options) put(o.id, "an option", e);
    if (e.kind === "table_rows") for (const c of e.columns) put(c.id, "a column", e);
    if (e.kind !== "field") for (const m of e.members) put(m.id, "a cell", e);
  }
  return out;
}

function mapInternal(
  schema: TemplateSchema,
  input: Record<string, unknown>,
  loadImage: LoadImage,
): Mapped {
  if (!isRecord(input)) throw new TypeError("values must be an object keyed by agent id");
  const entries = agentEntries(schema);
  const byId = new Map(entries.map((e) => [e.id, e] as const));
  let owners: Map<string, { what: string; owner: AgentEntry }> | null = null;
  const out: Mapped = {
    values: {},
    rowCounts: {},
    filled: 0,
    skipped: [],
    warnings: [],
    images: [],
    keyIds: new Map(),
    filledIds: new Set(),
    entries,
  };
  let suggested = 0;

  const write = (
    key: string,
    c: { value: string; warn?: string; image?: Img },
    skipId: string,
    top: boolean,
  ) => {
    out.values[key] = c.value;
    out.keyIds.set(key, skipId);
    const warning = c.warn ? `${skipId}: ${c.warn}` : undefined;
    if (warning) out.warnings.push(warning);
    if (c.image) out.images.push({ ...c.image, key, skipId, top, warning });
  };
  const skip = (id: string, reason: string, suggestions?: string[]) => {
    out.skipped.push(skipOf(id, reason, suggestions));
  };

  // Applies one entry's value; true when it counts as filled.
  const apply = (e: AgentEntry, raw: unknown): boolean => {
    switch (e.kind) {
      case "field": {
        if (e.external) {
          skip(e.id, EXTERNAL_REASON);
          return false;
        }
        const c = coerceValue(e.type, raw, e.field, loadImage);
        if ("reason" in c) {
          skip(e.id, c.reason);
          return false;
        }
        write(fieldKey(e.id), c, e.id, true);
        return true;
      }
      case "comb": {
        const c = combGroupChars(e, raw);
        if ("reason" in c) {
          skip(e.id, c.reason);
          return false;
        }
        for (const [k, v] of combEntries(e.slots, c.chars)) {
          out.values[k] = v;
          out.keyIds.set(k, e.id);
        }
        return true;
      }
      case "choice": {
        const items: unknown[] = e.type === "multiselect" && Array.isArray(raw) ? raw : [raw];
        const picked = new Set<string>();
        for (const it of items) {
          const m = matchOption(e.options, it, e.label);
          if ("reason" in m) {
            skip(e.id, m.reason, m.suggestions);
            return false;
          }
          picked.add(m.id);
        }
        const ids = [...new Set(e.options.map((o) => o.id))].filter((id) => picked.has(id));
        out.values[choiceKey(e.id)] = ids.join(MULTI_SEP);
        out.keyIds.set(choiceKey(e.id), e.id);
        return true;
      }
      case "table": {
        if (!isRecord(raw)) {
          skip(e.id, `expected an object {"<cell id>": value, ...}, got ${kindOf(raw)}`);
          return false;
        }
        let applied = 0;
        for (const [cellId, v] of Object.entries(raw)) {
          const sid = `${e.id}.${cellId}`;
          const cell = e.cells.find((c) => c.id === cellId);
          if (!cell) {
            skip(sid, "not a cell of this table", suggestIds(cellId, e.cells));
            continue;
          }
          if (v === null || v === undefined) continue;
          const c = coerceValue(cell.type, v, cell.field, loadImage);
          if ("reason" in c) {
            skip(sid, c.reason);
            continue;
          }
          write(fieldKey(cell.id), c, sid, false);
          applied++;
        }
        // `{}` or all-null is left blank, not filled.
        return applied > 0;
      }
      case "table_rows": {
        if (!Array.isArray(raw)) {
          skip(
            e.id,
            `expected an array of rows [{"<column id or label>": value, ...}], got ${kindOf(raw)}`,
          );
          return false;
        }
        let rows: unknown[] = raw;
        if (rows.length > e.maxRows) {
          out.warnings.push(
            `${e.id}: ${rows.length} rows given but the form holds ${e.maxRows}; rows after row ${e.maxRows} were dropped`,
          );
          rows = rows.slice(0, e.maxRows);
        }
        let applied = 0;
        rows.forEach((row, r) => {
          if (row === null || row === undefined) return;
          if (!isRecord(row)) {
            skip(
              `${e.id}[${r}]`,
              `expected an object {"<column id or label>": value}, got ${kindOf(row)}`,
            );
            return;
          }
          for (const [colKey, v] of Object.entries(row)) {
            const sid = `${e.id}[${r}].${colKey}`;
            const m = matchColumn(e.columns, colKey);
            if ("reason" in m) {
              skip(sid, m.reason, m.suggestions);
              continue;
            }
            if (v === null || v === undefined) continue;
            if (m.col.type === "signature") {
              skip(sid, "signatures in expandable-table rows can't be stamped; sign on paper");
              continue;
            }
            const c = coerceValue(m.col.type, v, m.col.field, loadImage);
            if ("reason" in c) {
              skip(sid, c.reason);
              continue;
            }
            write(r === 0 ? fieldKey(m.col.id) : expKey(e.id, r, m.col.id), c, sid, false);
            applied++;
          }
        });
        out.rowCounts[e.id] = Math.max(1, rows.length);
        // `[]` (or rows of nulls) is left blank, not filled.
        return applied > 0;
      }
    }
  };

  for (const [key, raw] of Object.entries(input)) {
    const e = byId.get(key);
    if (!e) {
      owners ??= nestedOwners(entries);
      const own = owners.get(key);
      if (own) {
        skip(
          key,
          `not a top-level id: this is ${own.what} of "${own.owner.label}" (${own.owner.id}); pass it inside that entry's value`,
          [own.owner.id],
        );
      } else {
        skip(key, "unknown id", suggested++ < MAX_SUGGESTED ? suggestIds(key, entries) : undefined);
      }
      continue;
    }
    if (raw === null || raw === undefined) continue; // left blank
    if (apply(e, raw)) {
      out.filled++;
      out.filledIds.add(e.id);
    }
  }

  // Required entries left empty (an external signature is signed on paper).
  const nonEmpty = (k: string) => (out.values[k] ?? "") !== "";
  for (const e of entries) {
    if (!e.required || (e.kind === "field" && e.external)) continue;
    let keys: string[];
    if (e.kind === "field") keys = [fieldKey(e.id)];
    else if (e.kind === "choice") keys = [choiceKey(e.id)];
    else if (e.kind === "comb") keys = e.slots.map((s) => s.key);
    else if (e.kind === "table") keys = e.cells.map((c) => fieldKey(c.id));
    else {
      const n = out.rowCounts[e.id] ?? 1;
      keys = e.columns.flatMap((c) =>
        Array.from({ length: n }, (_, r) => (r === 0 ? fieldKey(c.id) : expKey(e.id, r, c.id))),
      );
    }
    if (!keys.some(nonEmpty)) out.warnings.push(`${e.id}: required ("${e.label}") but left empty`);
  }
  return out;
}

/**
 * Maps agent values (keyed by agent id) onto fill-store values, exactly as the
 * browser's fill controls would store the same answers. Never throws on a bad
 * value — it is skipped with a reason (unknown ids get did-you-mean
 * suggestions). Signature images are only sniffed here; `fillAgentPdf` also
 * trial-embeds them.
 */
export function mapAgentValues(
  schema: TemplateSchema,
  input: Record<string, unknown>,
  opts: { loadImage: LoadImage },
): AgentValuesResult {
  const { values, rowCounts, filled, skipped, warnings } = mapInternal(
    schema,
    input,
    opts.loadImage,
  );
  return { values, rowCounts, filled, skipped, warnings };
}

// stampPdf swallows an image it can't embed, so trial-embed every signature in
// a scratch document first — the exact bytes stampPdf will decode from the
// stored data URL — and turn a failure into a skip.
async function verifyImages(m: Mapped): Promise<void> {
  if (m.images.length === 0) return;
  const { PDFDocument } = await import("pdf-lib");
  const scratch = await PDFDocument.create();
  for (const img of m.images) {
    try {
      const bytes = dataUrlToBytes(m.values[img.key] ?? "");
      if (!bytes) throw new Error("not a data URL");
      if (img.kind === "png") await scratch.embedPng(bytes);
      else await scratch.embedJpg(bytes);
    } catch {
      m.values = Object.fromEntries(Object.entries(m.values).filter(([k]) => k !== img.key));
      m.skipped.push({
        id: img.skipId,
        reason: "the image could not be embedded (a corrupt or unsupported PNG/JPEG)",
      });
      if (img.warning) m.warnings = m.warnings.filter((w) => w !== img.warning);
      if (img.top) {
        m.filled--;
        m.filledIds.delete(img.skipId);
      }
    }
  }
}

// ---- Placement warnings + the check PDF ---------------------------------------------

/** A single-line value shrunk below this (pt), or to under SHRINK_WARN_RATIO
 *  of its start size, is reported as hard to read. */
const SHRINK_WARN_PT = 7;
const SHRINK_WARN_RATIO = 0.6;
/** Two filled boxes overlapping by this share of the smaller one print over
 *  each other. */
const OVERLAP_WARN_SHARE = 0.25;
const MAX_OVERLAP_WARNINGS = 20;

/** The agent id a mark's value came from: its fill key, minus a comb cell's
 *  `#i`, or a choice option mark's `.optionId`. */
function ownerOf(markKey: string, keyIds: ReadonlyMap<string, string>): string {
  const base = markKey.replace(/#\d+$/, "");
  const direct = keyIds.get(base);
  if (direct) return direct;
  const dot = base.indexOf(".");
  if (base.startsWith("c") && dot > 0) return keyIds.get(base.slice(0, dot)) ?? base;
  return base;
}

/** The top-level agent id of a skip/warning id ("tbl.cell" → "tbl", "rows[2].qty" → "rows"). */
const topId = (id: string): string => id.split(/[.[]/, 1)[0];

function placementWarnings(placements: Placement[], keyIds: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  const pt = (n: number) => `${n.toFixed(1).replace(/\.0$/, "")}pt`;
  for (const p of placements) {
    const id = ownerOf(p.key, keyIds);
    if (!p.fits) {
      out.push(
        p.multiline
          ? `${id}: the text doesn't fit its box even at ${pt(p.size)}; its last lines run past the box (shorten it)`
          : `${id}: the text is wider than its box even at ${pt(p.size)} and runs past the box edge (shorten or abbreviate it)`,
      );
    } else if (
      p.size < p.startSize - 0.05 &&
      (p.size < SHRINK_WARN_PT || p.size < p.startSize * SHRINK_WARN_RATIO)
    ) {
      out.push(
        `${id}: the text was shrunk to ${pt(p.size)} (from ${pt(p.startSize)}) to fit its box and may be hard to read; consider abbreviating it`,
      );
    }
  }
  return out;
}

/** Filled boxes that overlap another filled box of a different id, page by page. */
function overlapWarnings(
  marksByPage: ReadonlyMap<number, readonly Mark[]>,
  keyIds: ReadonlyMap<string, string>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [page, marks] of marksByPage) {
    const filled = marks
      .filter((mk) => mk.text !== "" || mk.image)
      .map((mk) => ({ id: ownerOf(mk.key, keyIds), b: mk.box }));
    for (let i = 0; i < filled.length; i++) {
      for (let j = i + 1; j < filled.length; j++) {
        const a = filled[i];
        const c = filled[j];
        if (a.id === c.id) continue;
        const w = Math.min(a.b.xPct + a.b.wPct, c.b.xPct + c.b.wPct) - Math.max(a.b.xPct, c.b.xPct);
        const h = Math.min(a.b.yPct + a.b.hPct, c.b.yPct + c.b.hPct) - Math.max(a.b.yPct, c.b.yPct);
        if (w <= 0 || h <= 0) continue;
        const smaller = Math.min(a.b.wPct * a.b.hPct, c.b.wPct * c.b.hPct);
        if (smaller <= 0 || (w * h) / smaller < OVERLAP_WARN_SHARE) continue;
        const pair = [a.id, c.id].sort().join("\u0000");
        if (seen.has(pair)) continue;
        seen.add(pair);
        if (out.length < MAX_OVERLAP_WARNINGS) {
          out.push(
            `${a.id} and ${c.id}: their boxes overlap on page ${String(page)}, so the two values print over each other; check that each value went to the right field`,
          );
        }
      }
    }
  }
  return out;
}

interface BoxPct {
  xpct: number;
  ypct: number;
  wpct: number;
  hpct: number;
}

function bboxOf(fields: readonly Field[]): BoxPct | null {
  if (fields.length === 0) return null;
  const x0 = Math.min(...fields.map((f) => f.xpct));
  const y0 = Math.min(...fields.map((f) => f.ypct));
  const x1 = Math.max(...fields.map((f) => f.xpct + f.wpct));
  const y1 = Math.max(...fields.map((f) => f.ypct + f.hpct));
  return { xpct: x0, ypct: y0, wpct: x1 - x0, hpct: y1 - y0 };
}

/** Each id's shortest unique prefix, at least `min` characters. */
export function shortIds(ids: readonly string[], min = 6): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of ids) {
    let n = Math.min(min, id.length);
    while (n < id.length && ids.some((o) => o !== id && o.startsWith(id.slice(0, n)))) n++;
    out.set(id, id.slice(0, n));
  }
  return out;
}

type CheckStatus = "filled" | "warned" | "skipped" | "empty";

/**
 * The check copy of a filled PDF: every agent entry's box outlined in its
 * status colour and tagged with a short id prefix (radio options too), plus a
 * legend on page 1. Built from the stamped bytes, so it shows exactly what
 * the output holds. Local only, like the output itself.
 */
async function buildCheckPdf(
  stamped: Uint8Array,
  entries: readonly AgentEntry[],
  status: (id: string) => CheckStatus,
): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.load(stamped, { updateMetadata: false });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const COLORS: Record<CheckStatus, ReturnType<typeof rgb>> = {
    filled: rgb(0.1, 0.55, 0.2),
    warned: rgb(0.9, 0.5, 0),
    skipped: rgb(0.85, 0.1, 0.1),
    empty: rgb(0.55, 0.55, 0.6),
  };
  const boxes: { id: string; page: number; box: BoxPct; st: CheckStatus; thin: boolean }[] = [];
  for (const e of entries) {
    const st = status(e.id);
    if (e.kind === "field") {
      boxes.push({ id: e.id, page: e.field.page, box: e.field, st, thin: false });
      continue;
    }
    const bb = bboxOf(e.members);
    if (bb) boxes.push({ id: e.id, page: e.group.page, box: bb, st, thin: false });
    if (e.kind === "choice") {
      for (const o of e.options) boxes.push({ id: o.id, page: o.page, box: o, st, thin: true });
    }
  }
  const short = shortIds(boxes.map((b) => b.id));
  const SIZE = 5;
  for (const b of boxes) {
    const page = pages[b.page - 1] as (typeof pages)[number] | undefined;
    if (!page) continue;
    const { width: pw, height: ph } = page.getSize();
    // Percent, TOP-LEFT origin → PDF points, BOTTOM-LEFT origin (pdf-lib).
    const x = (b.box.xpct / 100) * pw;
    const w = (b.box.wpct / 100) * pw;
    const h = (b.box.hpct / 100) * ph;
    const y = ph - (b.box.ypct / 100) * ph - h;
    const color = COLORS[b.st];
    page.drawRectangle({
      x,
      y,
      width: w,
      height: h,
      borderColor: color,
      borderWidth: b.thin ? 0.4 : 0.8,
      borderDashArray: b.st === "empty" || b.thin ? [2, 1.5] : undefined,
      opacity: 0,
      borderOpacity: 0.9,
    });
    const tag = short.get(b.id) ?? b.id;
    const tw = helv.widthOfTextAtSize(tag, SIZE);
    // The tag sits just above the box: at its top-right corner when the box is
    // wide (a printed caption usually starts at the left), else top-left; inside
    // its top when the box touches the top of the page. An option's tag goes
    // under its box, clear of its group's tag above the same corner.
    const above = y + h + 1 + SIZE <= ph ? y + h + 1 : y + h - SIZE - 0.5;
    const ty = b.thin && y - SIZE - 1.5 >= 0 ? y - SIZE - 1 : above;
    const tx = w > 3 * (tw + 1.6) ? x + w - tw - 1.6 : x;
    page.drawRectangle({
      x: tx,
      y: ty - 0.8,
      width: tw + 1.6,
      height: SIZE + 1.2,
      color: rgb(1, 1, 1),
      opacity: 0.85,
    });
    page.drawText(tag, { x: tx + 0.8, y: ty, size: SIZE, font: helv, color });
  }
  const first = pages[0] as (typeof pages)[number] | undefined;
  if (first) {
    const legend =
      "fenfill check copy: green = filled, orange = filled with a warning, red = skipped, grey = left empty. Tags are field-id prefixes.";
    const { height: ph } = first.getSize();
    first.drawText(legend, { x: 6, y: ph - 7, size: SIZE, font: helv, color: rgb(0.3, 0.3, 0.35) });
  }
  return doc.save();
}

export interface FillAgentPdfArgs {
  pdfBytes: ArrayBuffer;
  /** The raw v5 schema_json, exactly as /v1 returns it under ?include=render. */
  render: unknown;
  input: Record<string, unknown>;
  fonts: { inter: ArrayBuffer; deja: ArrayBuffer };
  branding: { watermark: boolean; logoUrl: string | null } | null;
  logoBytes: ArrayBuffer | null;
  loadImage: LoadImage;
  infoTags?: Record<string, string>;
  /** Also build the check copy (`checkPdf`): boxes outlined and tagged. */
  check?: boolean;
}

export interface FillAgentPdfResult {
  pdf: Uint8Array;
  filled: number;
  skipped: AgentSkip[];
  /** Mapping warnings, then placement warnings (text shrunk hard or running
   *  past its box, filled boxes printing over each other). */
  warnings: string[];
  checkPdf?: Uint8Array;
}

/** normalizeSchema → mapAgentValues → buildMarks (whole document) → stampPdf,
 *  then the placement checks (and, with `check`, the check copy). */
export async function fillAgentPdf(a: FillAgentPdfArgs): Promise<FillAgentPdfResult> {
  if (!isRecord(a.render)) throw new TypeError("render must be the template's schema object");
  const schema = normalizeSchema(a.render);
  const m = mapInternal(schema, a.input, a.loadImage);
  await verifyImages(m);
  const marksByPage = buildMarks({
    fields: schema.fields,
    groups: schema.groups,
    values: m.values,
    rowCounts: m.rowCounts,
  });
  const placements: Placement[] = [];
  const pdf = await stampPdf({
    pdfBytes: a.pdfBytes,
    marksByPage,
    branding: a.branding ?? undefined,
    watermarkText: null,
    fonts: a.fonts,
    logoBytes: a.logoBytes,
    infoTags: a.infoTags,
    onPlacement: (p) => placements.push(p),
  });
  const placed = [
    ...placementWarnings(placements, m.keyIds),
    ...overlapWarnings(marksByPage, m.keyIds),
  ];
  const warnings = [...m.warnings, ...placed];
  const res: FillAgentPdfResult = { pdf, filled: m.filled, skipped: m.skipped, warnings };
  if (a.check) {
    const skippedIds = new Set(m.skipped.map((s) => topId(s.id)));
    // Placement warnings name ids first ("<id>: …", "<a> and <b>: …").
    const warned = new Set(
      placed.flatMap((w) => w.slice(0, w.indexOf(":")).split(" and ").map(topId)),
    );
    res.checkPdf = await buildCheckPdf(pdf, m.entries, (id) =>
      skippedIds.has(id)
        ? "skipped"
        : warned.has(id)
          ? "warned"
          : m.filledIds.has(id)
            ? "filled"
            : "empty",
    );
  }
  return res;
}

// ---- Source-PDF guards -------------------------------------------------------------

type PdfLib = typeof PdfLibModule;

function countPrefilled(doc: PDFDocument, pdfLib: PdfLib): number {
  const { PDFArray, PDFDict, PDFHexString, PDFName, PDFNull, PDFNumber, PDFRawStream, PDFString } =
    pdfLib;
  const acro = doc.catalog.lookup(PDFName.of("AcroForm"));
  if (acro === undefined || acro === PDFNull) return 0;
  if (!(acro instanceof PDFDict)) throw new Error("/AcroForm is not a dictionary");
  const top = acro.lookup(PDFName.of("Fields"));
  if (top === undefined || top === PDFNull) return 0;
  if (!(top instanceof PDFArray)) throw new Error("/AcroForm /Fields is not an array");

  const V = PDFName.of("V");
  const DV = PDFName.of("DV");
  const FT = PDFName.of("FT");
  const OFF = PDFName.of("Off");
  const BTN = PDFName.of("Btn");
  const TX = PDFName.of("Tx");
  const FF = PDFName.of("Ff");
  const AS = PDFName.of("AS");
  const AP = PDFName.of("AP");
  const N = PDFName.of("N");
  const FIELD_KEYS = ["T", "FT", "V", "Kids"].map((k) => PDFName.of(k));
  const text = (o: PDFObject): string | null => {
    if (o instanceof PDFString || o instanceof PDFHexString) return o.decodeText();
    if (o instanceof PDFRawStream) {
      return Array.from(pdfLib.decodePDFRawStream(o).decode(), (c) => String.fromCharCode(c)).join(
        "",
      );
    }
    return null;
  };
  const blank = (o: PDFObject | undefined): boolean => {
    if (o === undefined || o === PDFNull) return true;
    if (o instanceof PDFName) return o === OFF || o.asString() === "/";
    if (o instanceof PDFArray) return o.asArray().every((_, i) => blank(o.lookup(i)));
    const t = text(o);
    return t !== null && t.trim() === "";
  };
  const same = (a: PDFObject | undefined, b: PDFObject | undefined): boolean => {
    if (a === undefined || b === undefined) return false;
    if (a instanceof PDFName || b instanceof PDFName) return a === b;
    if (a instanceof PDFNumber && b instanceof PDFNumber) return a.asNumber() === b.asNumber();
    if (a instanceof PDFArray && b instanceof PDFArray) {
      return a.size() === b.size() && a.asArray().every((_, i) => same(a.lookup(i), b.lookup(i)));
    }
    const ta = text(a);
    return ta !== null && ta === text(b);
  };
  // A read-only text field holding a zero amount ("0", "0.00", "0,00") is a
  // computed total on a blank form (e.g. AO 239), never a user's answer. Any
  // other read-only text still counts.
  const readOnlyZero = (
    ft: PDFObject | undefined,
    ff: PDFObject | undefined,
    v: PDFObject | undefined,
  ): boolean => {
    if (ft !== TX || !(ff instanceof PDFNumber) || (ff.asNumber() & 1) === 0) return false;
    const t = v === undefined ? null : text(v);
    return t !== null && /^0+(?:[.,]0+)?$/.test(t.trim());
  };
  // Resolves a /Fields or /Kids array to its dictionaries (dangling refs skipped).
  const dicts = (arr: PDFObject | undefined): PDFDict[] => {
    if (arr === undefined || arr === PDFNull) return [];
    if (!(arr instanceof PDFArray)) throw new Error("/Kids is not an array");
    const out: PDFDict[] = [];
    for (let i = 0; i < arr.size(); i++) {
      const d = arr.lookup(i);
      if (d === undefined || d === PDFNull) continue;
      if (!(d instanceof PDFDict)) throw new Error("a form field is not a dictionary");
      out.push(d);
    }
    return out;
  };

  // A check box / radio value selects nothing when no widget shows it: not its
  // /AS, not one of its on-states (e.g. /V /Yes over widgets whose states are
  // /0, /1, all at /Off — as XFA-converted blank forms ship). Buttons only:
  // text values stay fail-closed (bar readOnlyZero). Without a readable widget
  // it still counts.
  const selectsNothing = (widgets: PDFDict[], value: PDFObject | undefined): boolean => {
    if (!(value instanceof PDFName) || widgets.length === 0) return false;
    for (const w of widgets) {
      if (w.lookup(AS) === value) return false;
      const ap = w.lookup(AP);
      const normal = ap instanceof PDFDict ? ap.lookup(N) : undefined;
      if (!(normal instanceof PDFDict)) return false; // no appearances: can't tell
      if (normal.has(value)) return false;
    }
    return true;
  };

  let count = 0;
  const seen = new Set<PDFDict>();
  // Walks the field tree like flattenForm's widgets: /V, /DV, /FT and /Ff
  // inherit down /Kids; a node whose kids are only widgets is one terminal field.
  const visit = (
    node: PDFDict,
    v: PDFObject | undefined,
    dv: PDFObject | undefined,
    ft: PDFObject | undefined,
    ff: PDFObject | undefined,
    depth: number,
  ) => {
    if (depth > 64) throw new Error("the form field tree is too deep");
    if (seen.has(node)) return;
    seen.add(node);
    const ownV = node.has(V) ? node.lookup(V) : v;
    const ownDv = node.has(DV) ? node.lookup(DV) : dv;
    const ownFt = node.has(FT) ? node.lookup(FT) : ft;
    const ownFf = node.has(FF) ? node.lookup(FF) : ff;
    const all = dicts(node.lookup(PDFName.of("Kids")));
    const kids = all.filter((k) => FIELD_KEYS.some((key) => k.has(key)));
    if (kids.length === 0) {
      if (blank(ownV) || same(ownV, ownDv) || readOnlyZero(ownFt, ownFf, ownV)) return;
      // The field's widgets: its widget kids, or the field dict itself.
      const widgets = all.length > 0 ? all : node.has(AS) || node.has(AP) ? [node] : [];
      if (ownFt === BTN && selectsNothing(widgets, ownV)) return;
      count++;
      return;
    }
    for (const k of kids) visit(k, ownV, ownDv, ownFt, ownFf, depth + 1);
  };
  for (const f of dicts(top)) visit(f, undefined, undefined, undefined, undefined, 0);
  return count;
}

/**
 * How many of a PDF's own form fields already hold a value (non-blank, not
 * /Off, not the field's /DV default, and not a read-only text field's zero
 * amount). 0 when it has no /AcroForm. Throws
 * (fail-closed) when an existing /AcroForm tree can't be read.
 */
export async function prefilledAcroFieldCount(pdfBytes: ArrayBuffer): Promise<number> {
  const pdfLib = await import("pdf-lib");
  const { PDFDocument, PDFName } = pdfLib;
  let doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });
  let hasForm = true; // an unreadable catalog is decided after decryption
  try {
    hasForm = doc.catalog.has(PDFName.of("AcroForm"));
  } catch {
    // fall through
  }
  if (!hasForm) return 0;
  // Like stampPdf: an owner-password PDF is decrypted, then reloaded (its /V
  // strings are encrypted until then).
  if (doc.isEncrypted) {
    const { decryptPdf } = await import("./decryptPdf");
    doc = await PDFDocument.load(await decryptPdf(pdfBytes), { updateMetadata: false });
  }
  try {
    return countPrefilled(doc, pdfLib);
  } catch (e) {
    throw new Error(
      `Could not read this PDF's form fields (${e instanceof Error ? e.message : "parse error"}).`,
    );
  }
}

/** Whether the PDF's Info dictionary carries `key` (e.g. MCP_OUTPUT_TAG). */
export async function hasInfoTag(pdfBytes: ArrayBuffer, key: string): Promise<boolean> {
  const pdfLib = await import("pdf-lib");
  const opts = { ignoreEncryption: true, updateMetadata: false };
  const doc = await pdfLib.PDFDocument.load(pdfBytes, opts);
  const info = doc.context.lookup(doc.context.trailerInfo.Info);
  return info instanceof pdfLib.PDFDict && info.has(pdfLib.PDFName.of(key));
}

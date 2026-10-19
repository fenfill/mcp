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

import { needsBidi, stampsRtl, stripBidiControls } from "./bidiText";
import { combDateWrites, combEntries, type CombSlot, combSlots, isDmyFormat } from "./combFill";
import { type PageFrame, pctToFrameRect, userRectToFrame } from "./coords";
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
import { marksNeedJpFace, needsJpFace } from "./fontRuns";
import { normalizeSchema } from "./normalizeSchema";
import { dataUrlToBytes } from "./signatureImage";
import {
  embedStampFaces,
  FENFILL_OUTPUT_TAG,
  type Mark,
  type Placement,
  type StampFonts,
  stampPdf,
  visibleFrames,
} from "./stampPdf";

/** Info-dictionary key the MCP writes into every PDF it fills (and refuses to analyze). */
export const MCP_OUTPUT_TAG = "FenfillMcpOutput";

/** Every Info key that marks a PDF as a fenfill fill: the one stampPdf writes
 *  on every output, and the MCP's own (also on outputs of MCP <= 0.2.4). */
export const FILLED_OUTPUT_TAGS: readonly string[] = [FENFILL_OUTPUT_TAG, MCP_OUTPUT_TAG];
export { FENFILL_OUTPUT_TAG };

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
  for (let off = 8; off + 8 <= b.length;) {
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

/** The shortest id prefix a value key (or an option id in a value) is taken as. */
export const MIN_VALUE_PREFIX = 4;

/** The ids among `ids` that `key` is a prefix of (case-insensitive), when it is long enough. */
export function prefixHits(key: string, ids: Iterable<string>): string[] {
  const lk = key.toLowerCase();
  if (lk.length < MIN_VALUE_PREFIX) return [];
  return [...new Set([...ids].filter((id) => id.toLowerCase().startsWith(lk)))];
}

const ambiguous = (hits: string[]): string =>
  `ambiguous: it starts ${String(hits.length)} ids; give more characters`;

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
  for (const id of prefixHits(
    key,
    items.map((it) => it.id),
  ))
    add(id);
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
  // A shortened option id, as the preview's legend tags show it.
  const pre = prefixHits(v, ids);
  if (pre.length === 1) return { id: pre[0] };
  if (pre.length > 1) return { reason: ambiguous(pre), suggestions: pre.slice(0, 5) };
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

/** What a nested id is in its entry: `kind` says where a value given under it
 *  belongs (an option or a classic table's cell can be moved there; a column
 *  or any other member is only named), `what` says it to the agent. */
export interface NestedOwner {
  kind: "option" | "cell" | "column" | "member";
  what: string;
  owner: AgentEntry;
}

/**
 * Every id nested inside an entry (options, table cells, columns, then every
 * other member: comb cells, an expandable table's printed rows), so an agent
 * passing one at the top level is told where it belongs. The one definition
 * the MCP's value-key expansion (packages/mcp/src/values.ts) also reads.
 */
export function nestedIdOwners(entries: readonly AgentEntry[]): Map<string, NestedOwner> {
  const out = new Map<string, NestedOwner>();
  const put = (id: string, kind: NestedOwner["kind"], what: string, owner: AgentEntry) => {
    if (!out.has(id)) out.set(id, { kind, what, owner });
  };
  for (const e of entries) {
    if (e.kind === "field") continue;
    if (e.kind === "choice") for (const o of e.options) put(o.id, "option", "an option", e);
    if (e.kind === "table") for (const c of e.cells) put(c.id, "cell", "a cell", e);
    if (e.kind === "table_rows") for (const c of e.columns) put(c.id, "column", "a column", e);
    for (const m of e.members) put(m.id, "member", "a cell", e);
  }
  return out;
}

/** The entry a nested id (or a unique prefix of one) belongs to. */
function nestedOwner(owners: Map<string, NestedOwner>, key: string): NestedOwner | undefined {
  const exact = owners.get(key);
  if (exact) return exact;
  const hits = prefixHits(key, owners.keys());
  return hits.length === 1 ? owners.get(hits[0]) : undefined;
}

function mapInternal(
  schema: TemplateSchema,
  input: Record<string, unknown>,
  loadImage: LoadImage,
): Mapped {
  if (!isRecord(input)) throw new TypeError("values must be an object keyed by agent id");
  const entries = agentEntries(schema);
  const byId = new Map(entries.map((e) => [e.id, e] as const));
  let owners: Map<string, NestedOwner> | null = null;
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
            owners ??= nestedIdOwners(entries);
            const own = nestedOwner(owners, cellId);
            skip(
              sid,
              own && own.owner.id !== e.id
                ? `not a cell of this table: it is ${own.what} of "${own.owner.label}" (${own.owner.id})`
                : "not a cell of this table",
              suggestIds(cellId, e.cells),
            );
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
      owners ??= nestedIdOwners(entries);
      // Exact, or a unique prefix among every id (an entry's id counts too).
      const hits = owners.has(key) ? [] : prefixHits(key, [...byId.keys(), ...owners.keys()]);
      const own = owners.get(key) ?? (hits.length === 1 ? owners.get(hits[0]) : undefined);
      if (own) {
        // A prefix is named in full: the core matches ids exactly.
        const full = owners.has(key) ? key : hits[0];
        const what = full === key ? own.what : `${own.what} (${full})`;
        skip(
          key,
          own.what === "an option"
            ? `not a top-level id: this is ${what} of "${own.owner.label}" (${own.owner.id}); pass it as that group's value, or give it alone with true (a radio takes one option)`
            : `not a top-level id: this is ${what} of "${own.owner.label}" (${own.owner.id}); pass it inside that entry's value`,
          full === key ? [own.owner.id] : [own.owner.id, full],
        );
      } else if (hits.length > 1) {
        skip(key, ambiguous(hits), hits.slice(0, 5));
      } else if (hits.length === 1) {
        // A unique prefix of an entry's id that reached here unexpanded: the
        // MCP writes a prefix out unless its full id is given too.
        skip(
          key,
          Object.prototype.hasOwnProperty.call(input, hits[0])
            ? `a short id of ${hits[0]}, which is given too: give each entry once`
            : `unknown id: did you mean ${hits[0]}? give the full id`,
          hits,
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
 * Every id the check copy outlines, in one list for shortIds: entries, radio /
 * multiselect options, and table cells (columns of an expandable table). The
 * check copy's tags and preview_page's legend both take their prefixes from
 * this list, so a tag always means the same id in both.
 */
export function checkTagIds(entries: readonly AgentEntry[]): string[] {
  const ids: string[] = [];
  for (const e of entries) {
    ids.push(e.id);
    if (e.kind === "choice") for (const o of e.options) ids.push(o.id);
    if (e.kind === "table") for (const c of e.cells) ids.push(c.id);
    if (e.kind === "table_rows") for (const c of e.columns) ids.push(c.id);
  }
  return ids;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const hits = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const causeOf = (e: unknown): string => (e instanceof Error && e.message ? e.message : String(e));

/** Header text on one line: each run of whitespace and control characters is one space. */
const oneLine = (s: string): string => s.replace(/[\s\p{Cc}]+/gu, " ").trim();

/** Printable ASCII, anything else as "?": Helvetica (WinAnsi) throws on a
 *  character it cannot encode. */
const asciiOnly = (s: string): string => s.replace(/[^\x20-\x7e]/g, "?");

/** What the check copy's build was doing: a stage, and the id it was on. */
interface CheckStep {
  stage: string;
  id?: string;
}

/** A failed check copy: the step it stopped at, and the cause as its message. */
class CheckCopyError extends Error {
  readonly at: CheckStep;

  constructor(at: CheckStep, cause: unknown) {
    super(causeOf(cause));
    this.name = "CheckCopyError";
    this.at = { ...at };
  }
}

/**
 * The check copy of a filled PDF: every agent entry's box outlined in its
 * status colour and tagged with a short id prefix (radio options too; table
 * cells get a thin untagged outline, their tags are in preview_page's legend),
 * plus a legend line on page 1 unless `banner` is false. With `tags` false
 * only the outlines are drawn: no id tags and no table header texts, so
 * nothing covers the print beside a box. Built from the stamped bytes, so it
 * shows exactly what the output holds. Local only, like the output itself.
 *
 * `notes` say what it could not draw as written (a table header, in the
 * warnings' `<id>: …` form). A failure is thrown as a CheckCopyError naming the
 * step it stopped at.
 */
async function buildCheckPdf(
  stamped: Uint8Array,
  entries: readonly AgentEntry[],
  status: (id: string) => CheckStatus,
  fonts: StampFonts,
  banner = true,
  tags = true,
  avoid: TagObstacles = {},
): Promise<{ pdf: Uint8Array; notes: string[] }> {
  const at: CheckStep = { stage: "load" };
  try {
    return await drawCheckPdf(stamped, entries, status, fonts, banner, tags, avoid, at);
  } catch (e) {
    throw new CheckCopyError(at, e);
  }
}

/** A box in the page's own user space, in points: bottom-left origin,
 *  unrotated and uncropped, the space pdf-lib (and so the check copy) draws in. */
export interface PageRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What the check copy's id tags keep off besides the outlines: the printed
 *  text, by page, and the stamped values. */
interface TagObstacles {
  printed?: Readonly<Record<number, readonly PageRegion[]>>;
  marks?: ReadonlyMap<number, readonly Mark[]>;
}

/** How far (points) a tag may move from its box, joined to it by a leader line. */
const TAG_REACH = 30;

/** The gap (points) between two rects; 0 when they touch or overlap. */
function gapOf(a: Rect, b: Rect): number {
  const dx = Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w));
  const dy = Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h));
  return Math.hypot(dx, dy);
}

type Point = { x: number; y: number };

/** A leader line from a tag's edge to the nearest point of its box. */
function leaderOf(tag: Rect, box: Rect): { start: Point; end: Point } {
  const cx = tag.x + tag.w / 2;
  const cy = tag.y + tag.h / 2;
  const end = {
    x: Math.min(Math.max(cx, box.x), box.x + box.w),
    y: Math.min(Math.max(cy, box.y), box.y + box.h),
  };
  const start = {
    x: Math.min(Math.max(end.x, tag.x), tag.x + tag.w),
    y: Math.min(Math.max(end.y, tag.y), tag.y + tag.h),
  };
  return { start, end };
}

/** Whether the segment a→b passes through rect r (Liang–Barsky clipping). */
function crosses(a: Point, b: Point, r: Rect): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const edges: [number, number][] = [
    [-dx, a.x - r.x],
    [dx, r.x + r.w - a.x],
    [-dy, a.y - r.y],
    [dy, r.y + r.h - a.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

/** The area two rects share. */
function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * The side of a small box its caption is printed on: the nearer printed text on
 * the box's own line, left or right (null when none is near).
 */
function captionSide(box: Rect, printed: readonly Rect[]): "left" | "right" | null {
  let left = Infinity;
  let right = Infinity;
  const reach = Math.max(4 * box.h, 24);
  for (const g of printed) {
    const shared = Math.min(g.y + g.h, box.y + box.h) - Math.max(g.y, box.y);
    if (shared < 0.4 * Math.min(g.h, box.h)) continue;
    if (g.x >= box.x + box.w) right = Math.min(right, g.x - (box.x + box.w));
    else if (g.x + g.w <= box.x) left = Math.min(left, box.x - (g.x + g.w));
  }
  if (Math.min(left, right) > reach) return null;
  return left < right ? "left" : "right";
}

/** buildCheckPdf's body. `at` is kept on the step in progress. */
async function drawCheckPdf(
  stamped: Uint8Array,
  entries: readonly AgentEntry[],
  status: (id: string) => CheckStatus,
  fonts: StampFonts,
  banner: boolean,
  tags: boolean,
  avoid: TagObstacles,
  at: CheckStep,
): Promise<{ pdf: Uint8Array; notes: string[] }> {
  const step = (stage: string, id?: string) => {
    at.stage = stage;
    at.id = id;
  };
  const notes: string[] = [];
  const pdfLib = await import("pdf-lib");
  const { PDFDocument, StandardFonts, rgb } = pdfLib;
  const doc = await PDFDocument.load(stamped, { updateMetadata: false });
  step("fonts");
  // Ids (tags) and the legend line are ASCII: Helvetica, with no font bytes.
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  // Everything is drawn in each page's visible frame (rotated CropBox, BOTTOM-LEFT
  // origin, points; see stampPdf visibleFrames), as the values were stamped.
  const frames = visibleFrames(pdfLib);
  const COLORS: Record<CheckStatus, ReturnType<typeof rgb>> = {
    filled: rgb(0.1, 0.55, 0.2),
    warned: rgb(0.9, 0.5, 0),
    skipped: rgb(0.85, 0.1, 0.1),
    empty: rgb(0.55, 0.55, 0.6),
  };
  type Outline = {
    id: string;
    page: number;
    box: BoxPct;
    st: CheckStatus;
    thin: boolean;
    tagged: boolean;
    /** An option's group: its outline holds the option, so it never blocks the option's tag. */
    owner?: string;
  };
  const boxes: Outline[] = [];
  for (const e of entries) {
    step("outline", e.id);
    const st = status(e.id);
    if (e.kind === "field") {
      boxes.push({ id: e.id, page: e.field.page, box: e.field, st, thin: false, tagged: true });
      continue;
    }
    const bb = bboxOf(e.members);
    if (bb) boxes.push({ id: e.id, page: e.group.page, box: bb, st, thin: false, tagged: true });
    if (e.kind === "choice") {
      for (const o of e.options)
        boxes.push({ id: o.id, page: o.page, box: o, st, thin: true, tagged: true, owner: e.id });
    }
    if (e.kind === "table") {
      for (const c of e.cells)
        boxes.push({ id: c.id, page: c.field.page, box: c.field, st, thin: true, tagged: false });
    }
  }
  step("tag");
  const short = shortIds(checkTagIds(entries));
  const SIZE = 5;
  // Page-point rects of every outline per page: a tag must not cover a box
  // (or another tag) when it has anywhere else to go.
  // Percent (visible page, TOP-LEFT origin) -> visible-frame points (BOTTOM-LEFT).
  const rectOf = (b: Outline, f: PageFrame): Rect =>
    pctToFrameRect(f, { xPct: b.box.xpct, yPct: b.box.ypct, wPct: b.box.wpct, hPct: b.box.hpct });
  const placedTags = new Map<number, Rect[]>();
  // The print and the stamped values of a page, in page points: a tag never
  // covers them when it has anywhere else to go.
  const inkByPage = new Map<number, Rect[]>();
  const inkOf = (page: number, f: PageFrame): Rect[] => {
    let ink = inkByPage.get(page);
    if (!ink) {
      ink = [];
      // The printed boxes come in USER SPACE (BOTTOM-LEFT, unrotated): into the frame.
      for (const r of avoid.printed?.[page] ?? []) ink.push(userRectToFrame(f, r));
      for (const mk of avoid.marks?.get(page) ?? []) ink.push(pctToFrameRect(f, mk.box));
      inkByPage.set(page, ink);
    }
    return ink;
  };
  // A table's headers, printed small inside the first cell of each line
  // (R: row header, C: column header) so the agent can compare them with the
  // form's printed headers beside them. Cells carry no tags, so it's free.
  const HEAD = 4;
  const headColor = rgb(0.15, 0.35, 0.75);
  interface Head {
    gid: string;
    axis: "row" | "column";
    /** 0-based, as edit_template's set_header counts. */
    index: number;
    text: string;
    cell: AgentCell;
    page: (typeof pages)[number];
    below: number;
  }
  const wanted: Head[] = [];
  for (const e of entries) {
    // Without tags no header is wanted, so none is laid out, drawn or noted.
    if (!tags || e.kind !== "table") continue;
    step("table headers", e.id);
    const g = e.group as { header_rows?: unknown; header_cols?: unknown };
    const texts = (v: unknown): unknown[] => (Array.isArray(v) ? (v as unknown[]) : []);
    const lineOf = (raw: unknown): string => (typeof raw === "string" ? oneLine(raw) : "");
    const firstOf = (key: "row" | "col", k: number): AgentCell | undefined =>
      e.cells
        .filter((c) => c[key] === k)
        .sort((a, b) => (key === "row" ? a.col - b.col : a.row - b.row))
        .at(0);
    const want = (
      axis: Head["axis"],
      index: number,
      raw: unknown,
      cell: AgentCell | undefined,
      below: number,
    ) => {
      const text = lineOf(raw);
      if (!text || !cell) return;
      const page = pages[cell.field.page - 1] as (typeof pages)[number] | undefined;
      if (page) wanted.push({ gid: e.id, axis, index, text, cell, page, below });
    };
    texts(g.header_rows).forEach((t, r) => {
      want("row", r, t, firstOf("row", r), 0);
    });
    // A column header shares the top-left cell with row 0's: put it one line lower there.
    texts(g.header_cols).forEach((t, c) => {
      const cell = firstOf("col", c);
      const shared = cell !== undefined && cell.col === firstOf("row", cell.row)?.col;
      const rowHead = cell ? lineOf(texts(g.header_rows)[cell.row]) : "";
      want("column", c, t, cell, shared && rowHead ? HEAD + 0.6 : 0);
    });
  }
  const heads: { head: Head; draw: () => void }[] = [];
  const dropped = (h: Head, e: unknown) =>
    `${h.gid}: ${h.axis} header ${String(h.index)} could not be drawn in the check copy: ${causeOf(e)}`;
  if (wanted.length > 0) {
    // Headers are the form's own wording, in any script, so they are drawn with
    // the stamp's two faces. Those are embedded only when a header is drawn: a
    // check copy without one stays byte for byte what Helvetica alone makes it.
    step("fonts");
    const { default: fontkit } = await import("@pdf-lib/fontkit");
    doc.registerFontkit(fontkit);
    const faces = await embedStampFaces(doc, fontkit, fonts);
    // A Hebrew/Arabic header goes through the stamp's RTL layer (shaped, then
    // reordered to visual order), loaded only when one is drawn.
    const rtlLayer = wanted.some((h) => needsBidi(h.text)) ? await import("./rtlStamp") : undefined;
    const unreadable = new Set<string>();
    for (const h of wanted) {
      step("table headers", h.gid);
      // One header that cannot be laid out is left out and reported, never fatal.
      try {
        const { cell, page } = h;
        const prefix = h.axis === "row" ? "R" : "C";
        const { width: pw, height: ph } = frames.frameOf(page);
        const cx = (cell.field.xpct / 100) * pw;
        const top = ph - (cell.field.ypct / 100) * ph;
        const w = (cell.field.wpct / 100) * pw;
        const ht = (cell.field.hpct / 100) * ph;
        // Inside the cell when it has room; a narrow cell (a checkbox grid) gets
        // the row header just left of it and the column header just above it.
        const inside = w >= 40 && ht >= HEAD + 1;
        const room = inside ? w - 1 : prefix === "R" ? Math.min(120, cx - 1) : Math.max(2 * w, 30);
        // By code point (no split surrogate pairs). A character neither face has
        // would print as an empty box: show "?" and say so, once per table.
        const chars = Array.from(h.text, (ch) =>
          faces.hasGlyph(ch.codePointAt(0) ?? 0) ? ch : "?",
        );
        if (chars.join("") !== h.text && !unreadable.has(h.gid)) {
          unreadable.add(h.gid);
          notes.push(
            `${h.gid}: the check copy cannot draw some header characters (shown as "?"); the legend's header_rows / header_cols hold the full text`,
          );
        }
        // A Hebrew/Arabic header (stampsRtl: its own first strong character, not
        // the Latin prefix's) reads right to left, so its prefix is isolated
        // left to right ("R:" at the right end, read first) and a cut's "…"
        // follows the kept words on the left.
        const bidi = rtlLayer && needsBidi(h.text) ? rtlLayer : undefined;
        const rtl = stampsRtl(h.text);
        const lead = rtl ? `\u2066${prefix}:\u2069 ` : `${prefix}: `;
        // What is drawn is measured: shaped, and without the controls the bidi
        // path drops (a header with no RTL letter measures as before).
        const shaped = (t: string) => (bidi ? bidi.shapeArabic(t) : t);
        const width = (t: string) =>
          faces.measure(bidi ? stripBidiControls(bidi.shapeArabic(t)) : t, HEAD);
        // Too wide: the longest prefix that fits, plus "…", found by bisection
        // (one text layout per probe, not one per dropped character). The
        // 3-character "R: …" is kept even when that is still too wide.
        const cut = (n: number) => `${lead}${chars.slice(0, n).join("")}…`;
        let text = `${lead}${chars.join("")}`;
        if (chars.length > 1 && width(text) > room) {
          let lo = 0;
          let hi = chars.length - 2;
          while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (width(cut(mid)) <= room) lo = mid;
            else hi = mid - 1;
          }
          text = cut(lo);
        }
        const body = shaped(text);
        const tw = width(text);
        // Inside the cell an RTL header starts at the cell's right edge.
        const x = inside
          ? rtl
            ? cx + w - 0.6 - tw
            : cx + 0.6
          : prefix === "R"
            ? cx - tw - 0.8
            : cx;
        const y = inside
          ? top - HEAD - 0.4 - h.below
          : prefix === "R"
            ? top - ht / 2 - HEAD / 2
            : top + 0.6; // outside: the row header sits left, so no clash to dodge
        heads.push({
          head: h,
          draw: () => {
            if (bidi) {
              faces.drawVisual(page, bidi.visualLine(body, rtl), x, y, HEAD, headColor);
            } else {
              faces.draw(page, text, x, y, HEAD, headColor);
            }
          },
        });
        // Reserve the spot: the id tags placed next steer clear of it.
        const taken = placedTags.get(cell.field.page) ?? [];
        taken.push({ x, y, w: tw, h: HEAD + 0.6 });
        placedTags.set(cell.field.page, taken);
      } catch (e) {
        notes.push(dropped(h, e));
      }
    }
  }
  for (const b of boxes) {
    step("outline", b.id);
    const page = pages[b.page - 1] as (typeof pages)[number] | undefined;
    if (!page) continue;
    const frame = frames.frameOf(page);
    const { width: pw, height: ph } = frame;
    const { x, y, w, h } = rectOf(b, frame);
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
    if (!tags || !b.tagged) continue;
    step("tag", b.id);
    const tag = asciiOnly(short.get(b.id) ?? b.id);
    const tw = helv.widthOfTextAtSize(tag, SIZE) + 1.6;
    const th = SIZE + 1.2;
    // Candidate spots, preferred first: just above the box (top-right when the
    // box is wide, since a printed caption usually starts at the left, else
    // top-left); an option's tag first goes under its box, then above it, then
    // on the side away from its caption. The first spot that is on the page and
    // clear of the print, the stamped values, every other outline and tag wins.
    // When none is, the nearest clear spot within TAG_REACH, joined to the box
    // by a leader line; then inside the box's top when that is clear of print
    // and values; and last the spot that covers the least of them.
    const self = { x, y, w, h };
    const right = x + w - tw;
    const wide = w > 3 * tw;
    const above = { x: wide ? right : x, y: y + h + 0.2 };
    const aboveOther = { x: wide ? x : right, y: y + h + 0.2 };
    const below = { x, y: y - th - 0.2 };
    const belowRight = { x: right, y: y - th - 0.2 };
    const side = { x: x + w + 0.8, y: y + h - th };
    const left = { x: x - tw - 0.8, y: y + h - th };
    const inside = { x, y: y + h - th - 0.2 };
    const win: Rect = {
      x: x - TAG_REACH - tw,
      y: y - TAG_REACH - th,
      w: w + 2 * (TAG_REACH + tw),
      h: h + 2 * (TAG_REACH + th),
    };
    const ink = inkOf(b.page, frame).filter((r) => hits(r, win));
    const caption = b.thin ? captionSide(self, ink) : null;
    const candidates = b.thin
      ? caption === "left"
        ? [below, belowRight, above, aboveOther, side, left]
        : [below, belowRight, above, aboveOther, left, side]
      : [above, aboveOther, below, belowRight, side, left];
    const others = boxes
      .filter((o) => o !== b && o.page === b.page && o.id !== b.owner)
      .map((o) => rectOf(o, frame))
      .filter((r) => hits(r, win));
    const taken = placedTags.get(b.page) ?? [];
    // Only the tags near enough to matter (every tag is kept for the next box).
    const takenNear = taken.filter((r) => hits(r, win));
    const rectAt = (c: { x: number; y: number }): Rect => ({ x: c.x, y: c.y, w: tw, h: th });
    const onPage = (r: Rect) => r.x >= 0 && r.y >= 0 && r.x + r.w <= pw && r.y + r.h <= ph;
    const clearOfInk = (r: Rect) => !ink.some((o) => hits(r, o));
    const fits = (c: { x: number; y: number }) => {
      const r = rectAt(c);
      return (
        onPage(r) &&
        clearOfInk(r) &&
        !others.some((o) => hits(r, o)) &&
        !takenNear.some((o) => hits(r, o))
      );
    };
    let spot = candidates.find(fits);
    let leader = false;
    if (!spot) {
      // `fits` is worked out once per spot, when first asked.
      const ring: { x: number; y: number; d: number; fits?: boolean }[] = [];
      const stepX = Math.max(2, tw / 3);
      const stepY = Math.max(1.5, th / 2);
      for (let yy = y - TAG_REACH - th; yy <= y + h + TAG_REACH; yy += stepY) {
        for (let xx = x - TAG_REACH - tw; xx <= x + w + TAG_REACH; xx += stepX) {
          const r = rectAt({ x: xx, y: yy });
          if (hits(r, self)) continue;
          const d = gapOf(r, self);
          if (d <= TAG_REACH) ring.push({ x: xx, y: yy, d });
        }
      }
      ring.sort((p, q) => p.d - q.d);
      const fitsAt = (c: (typeof ring)[number]) => (c.fits ??= fits(c));
      // The nearest clear spot, give or take a few points: a leader that
      // crosses print reads as underlining it, and a tag on the box's own line
      // reads as beside it.
      const DETOUR = 12;
      const crossesInk = (c: { x: number; y: number; d: number }) => {
        if (c.d <= 1.5) return false;
        const { start, end } = leaderOf(rectAt(c), self);
        // Padded: a leader through the gap between two letters still crosses the word.
        return ink.some((o) =>
          crosses(start, end, { x: o.x - 1, y: o.y - 1, w: o.w + 2, h: o.h + 2 }),
        );
      };
      const sameLine = (c: { y: number }) => c.y + th / 2 >= y && c.y + th / 2 <= y + h;
      const first = ring.find(fitsAt);
      let near: { x: number; y: number; d: number } | undefined;
      let best = Infinity;
      for (const c of ring) {
        if (!first || c.d > first.d + DETOUR) break;
        if (!fitsAt(c)) continue;
        const score = c.d + (crossesInk(c) ? DETOUR : 0) + (sameLine(c) ? 0 : DETOUR / 2);
        if (score < best) {
          best = score;
          near = c;
        }
      }
      if (near) {
        spot = near;
        leader = near.d > 1.5;
      }
    }
    if (!spot && onPage(rectAt(inside)) && clearOfInk(rectAt(inside))) spot = inside;
    if (!spot) {
      // Nothing clear: the spot that covers the least print and values (then
      // the fewest outlines and tags), the plain candidates first.
      const cost = (c: { x: number; y: number }) => {
        const r = rectAt(c);
        const covered = ink.reduce((n, o) => n + overlapArea(r, o), 0);
        const crowd = [...others, ...takenNear].filter((o) => hits(r, o)).length;
        return covered * 100 + crowd;
      };
      spot =
        [...candidates, inside]
          .filter((c) => onPage(rectAt(c)))
          .reduce<{ x: number; y: number } | undefined>(
            (best, c) => (!best || cost(c) < cost(best) ? c : best),
            undefined,
          ) ?? inside;
    }
    taken.push(rectAt(spot));
    placedTags.set(b.page, taken);
    if (leader) {
      const { start, end } = leaderOf(rectAt(spot), self);
      page.drawLine({ start, end, thickness: 0.3, color, opacity: 0.8 });
    }
    page.drawRectangle({
      x: spot.x,
      y: spot.y,
      width: tw,
      height: th,
      color: rgb(1, 1, 1),
      opacity: 0.85,
    });
    page.drawText(tag, { x: spot.x + 0.8, y: spot.y + 0.8, size: SIZE, font: helv, color });
  }
  for (const h of heads) {
    step("table headers", h.head.gid);
    try {
      h.draw();
    } catch (e) {
      notes.push(dropped(h.head, e));
    }
  }
  step("banner");
  const first = pages[0] as (typeof pages)[number] | undefined;
  if (first && banner) {
    const legend =
      "fenfill check copy: green = filled, orange = filled with a warning, red = skipped, grey = left empty. Tags are field-id prefixes.";
    const { height: ph } = frames.frameOf(first);
    first.drawText(legend, { x: 6, y: ph - 7, size: SIZE, font: helv, color: rgb(0.3, 0.3, 0.35) });
  }
  frames.close();
  step("save");
  return { pdf: await doc.save(), notes };
}

/** A fill whose values need the JP face when `fonts.jp` wasn't given: outside a
 *  browser the stamp can't fetch it, so the fill is refused rather than printed
 *  as tofu. `ids` are the offending fields' agent ids, in mark order. */
export class UnsupportedScriptError extends Error {
  readonly ids: string[];

  constructor(ids: string[]) {
    super(`These values need a Japanese font that wasn't provided: ${ids.join(", ")}`);
    this.name = "UnsupportedScriptError";
    this.ids = ids;
  }
}

export interface FillAgentPdfArgs {
  pdfBytes: ArrayBuffer;
  /** The raw v5 schema_json, exactly as /v1 returns it under ?include=render. */
  render: unknown;
  input: Record<string, unknown>;
  fonts: StampFonts;
  branding: { watermark: boolean; logoUrl: string | null } | null;
  logoBytes: ArrayBuffer | null;
  loadImage: LoadImage;
  infoTags?: Record<string, string>;
  /** Also build the check copy (`checkPdf`): boxes outlined and tagged. */
  check?: boolean;
  /** The check copy's legend line on page 1 (default true; preview_page passes false). */
  checkBanner?: boolean;
  /** The check copy's id tags and table header texts (default true). False
   *  leaves the outlines alone, so nothing is drawn over the print beside a box. */
  checkTags?: boolean;
  /** The printed text of the check copy's pages, by page (boxes in each
   *  page's own USER SPACE: points, BOTTOM-LEFT origin, unrotated; the check
   *  copy maps them onto the visible page it draws on): its id tags keep off it, as they keep
   *  off the stamped values. The browser has no text layer to give; the MCP reads it
   *  with PDFium (none on a scan). */
  checkPrinted?: Readonly<Record<number, readonly PageRegion[]>>;
}

export interface FillAgentPdfResult {
  pdf: Uint8Array;
  filled: number;
  skipped: AgentSkip[];
  /** Mapping warnings, then placement warnings (text shrunk hard or running
   *  past its box, filled boxes printing over each other), then, with `check`,
   *  what the check copy could not draw as written (a table header). */
  warnings: string[];
  checkPdf?: Uint8Array;
  /** With `check`, when the check copy could not be built: the stage it stopped
   *  at (load, fonts, table headers, outline, tag, banner, save), the id of the
   *  field, option, cell or group it was on, and the cause. `pdf` is complete
   *  either way: the check copy is built from it afterwards. */
  checkError?: { stage: string; id?: string; message: string };
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
  // The whole document, not just the pages a caller looks at: stampPdf's own
  // fallback fetches the face by relative URL, which only resolves on the web.
  if (!a.fonts.jp && marksNeedJpFace(marksByPage)) {
    const ids = new Set<string>();
    for (const marks of marksByPage.values()) {
      for (const mk of marks) if (needsJpFace(mk.text)) ids.add(ownerOf(mk.key, m.keyIds));
    }
    throw new UnsupportedScriptError([...ids]);
  }
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
    // The output never depends on the check copy: a failed one is reported
    // (checkError), not thrown.
    try {
      const built = await buildCheckPdf(
        pdf,
        m.entries,
        (id) =>
          skippedIds.has(id)
            ? "skipped"
            : warned.has(id)
              ? "warned"
              : m.filledIds.has(id)
                ? "filled"
                : "empty",
        a.fonts,
        a.checkBanner !== false,
        a.checkTags !== false,
        { printed: a.checkPrinted, marks: marksByPage },
      );
      res.checkPdf = built.pdf;
      warnings.push(...built.notes);
    } catch (e) {
      const at: CheckStep = e instanceof CheckCopyError ? e.at : { stage: "build" };
      res.checkError = { stage: at.stage, ...(at.id ? { id: at.id } : {}), message: causeOf(e) };
    }
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

/** What a blank-form check sees beyond the AcroForm values (see userMarkupCount). */
export interface UserMarkup {
  /** Page annotations that carry content someone added. */
  annotations: number;
  /** The 1-based pages they are on. */
  annotationPages: number[];
  /** XFA datasets values that differ from the form's own defaults. */
  xfaValues: number;
  /** Every counted item, annotations first, and why it counted. Always set. */
  details?: MarkupDetail[];
}

/** One item userMarkupCount counted; `summary` is a human-readable line. */
export type MarkupDetail =
  | {
      kind: "xfa";
      /** The datasets element name the value sits under. */
      name: string;
      /** Its path below `<data>`, e.g. `form1.Page1.Name`. */
      path: string;
      /** The value, at most 40 characters. */
      value: string;
      /** The template default(s) compared against, or "none found". */
      default: string;
      rule: "no_template" | "no_default" | "differs_from_default" | "undecodable";
      summary: string;
    }
  | {
      kind: "annotation";
      page: number;
      subtype: string;
      /** The annotation dictionary's keys, sorted. */
      keys: string[];
      /** /F, or null when absent. */
      flags: number | null;
      /** /M as written, or null. */
      modified: string | null;
      /** The document's /CreationDate as written, or null. */
      creationDate: string | null;
      /** What made it count. */
      trace: string;
      summary: string;
    };

const clip = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Shapes and stamps: what Preview and Acrobat add as a check mark, a circled
// answer or a signature, but also what an issuer ships on a blank (an
// "OMB approved" stamp, a box around a section). See markupAnnot for the split.
const SHAPES = new Set(["Stamp", "Square", "Circle", "Line", "Polygon", "PolyLine"]);
// Annotation /F bits (PDF 32000-1 §12.5.3): ReadOnly (7), Locked (8),
// LockedContents (10). Neither Preview nor Fill & Sign sets them on what they add.
const F_LOCKED = (1 << 6) | (1 << 7) | (1 << 9);

/** A PDF date (`D:YYYYMMDDHHmmSSOHH'mm'`) as epoch ms; NaN when unreadable. */
function pdfDateMs(s: string): number {
  const m =
    /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:([Zz+-])(\d{2})?'?(\d{2})?'?)?/.exec(
      s.trim(),
    );
  if (!m) return NaN;
  const n = (v: string | undefined, d: number) => (v === undefined ? d : Number(v));
  const t = Date.UTC(Number(m[1]), n(m[2], 1) - 1, n(m[3], 1), n(m[4], 0), n(m[5], 0), n(m[6], 0));
  if (m[7] !== "+" && m[7] !== "-") return t;
  const off = (n(m[8], 0) * 60 + n(m[9], 0)) * 60_000;
  return m[7] === "+" ? t - off : t + off;
}

// ---- XFA ------------------------------------------------------------------------------------

type XmlToken =
  | { kind: "open"; name: string; attrs: string; empty: boolean }
  | { kind: "close"; name: string }
  | { kind: "text"; text: string };

function xmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (all, e: string) => {
    const k = e.toLowerCase();
    if (k.startsWith("#")) {
      const cp = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : all;
    }
    const named: Record<string, string | undefined> = {
      lt: "<",
      gt: ">",
      amp: "&",
      quot: '"',
      apos: "'",
    };
    return named[k] ?? all;
  });
}

/** A forgiving XML tokenizer: element names lose their namespace prefix;
 *  comments, PIs and doctypes are dropped; CDATA is text. */
function* xmlTokens(xml: string): Generator<XmlToken> {
  const re =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<![^>]*>|<(\/?)([\w.:-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
  for (const match of xml.matchAll(re)) {
    const m = match as (string | undefined)[];
    if (m[1] !== undefined) yield { kind: "text", text: m[1] };
    else if (m[3] !== undefined) {
      const name = m[3].replace(/^[\w.-]*:/, "");
      yield m[2]
        ? { kind: "close", name }
        : { kind: "open", name, attrs: m[4] ?? "", empty: m[5] === "/" };
    } else if (m[6] !== undefined) yield { kind: "text", text: xmlEntities(m[6]) };
  }
}

function xmlAttr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)(?:[\\w.-]+:)?${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(
    attrs,
  );
  if (!m) return undefined;
  const g = m as (string | undefined)[];
  return xmlEntities(g[1] ?? g[2] ?? "");
}

/** Whitespace-only differences never make a value someone's answer. */
const xfaNorm = (s: string) => s.replace(/\s+/g, " ").trim();

/** What the blank form itself puts under one data node. */
interface XfaSlot {
  /** Normalized values the form supplies on its own. */
  defaults: Set<string>;
  /** Whether any field bound here takes input (not readOnly / protected /
   *  nonInteractive, not hidden / inactive). */
  editable: boolean;
}

/** Where the template's fields bind their data (see xfaTemplateBindings). */
interface XfaBindings {
  /** By data path below `<data>`, indexes dropped: `form1.Page1.Name`. */
  byPath: Map<string, XfaSlot>;
  /** `match="global"` fields, by name: they bind a node of that name anywhere. */
  global: Map<string, XfaSlot>;
  /** Every bound field by the last step of its path, for data a path doesn't
   *  reach (scopes this reading gets wrong). */
  byName: Map<string, XfaSlot>;
  /** AcroForm /DV values by field name (last step, index dropped). */
  dv: Map<string, Set<string>>;
}

interface XfaFieldCtx {
  name: string;
  /** "normal" | "none" | "global" | "dataRef" (XFA 3.3 §4 `bind.match`). */
  match: string;
  ref: string;
  value: string | null;
  items: string[][];
  check: boolean;
  editable: boolean;
  isGroup: boolean;
  group: XfaFieldCtx | null;
  defaults: Set<string>;
}

/** The steps of a SOM reference, `[n]` / `[*]` dropped. */
const somSteps = (ref: string) =>
  ref
    .split(".")
    .map((s) => s.replace(/\[[^\]]*\]$/, "").trim())
    .filter(Boolean);

/** A bind ref as a data path, given the data scope it is read in; null when it
 *  leaves the data DOM. `$` is the current data scope, `$record` the root
 *  subform's record, `$data` the `<data>` element; a bare ref is relative. */
function resolveXfaRef(ref: string, scope: readonly string[]): string[] | null {
  const steps = somSteps(ref);
  const head = steps[0] ?? "";
  if (head === "$") return [...scope, ...steps.slice(1)];
  if (head === "$record") return [...scope.slice(0, 1), ...steps.slice(1)];
  if (head === "$data") return steps.slice(1);
  if (head.startsWith("$") || head.startsWith("!")) return null;
  return [...scope, ...steps];
}

/**
 * Where the template packet's fields bind data, and what each supplies; null
 * when the XML holds no `<template>`. A named subform opens a data scope (its
 * name below its parent's), an unnamed one or one bound `none` doesn't, one
 * bound by `dataRef` opens the ref's. A field (or exclGroup) binds by name in
 * its scope (`match="normal"`), at its ref (`dataRef`), by name anywhere
 * (`global`), or not at all (`none`); an exclGroup's member fields bind
 * through the group. Its defaults: its own `<value>` (not a caption's), a check
 * button's off state (the second `<items>` entry, `0` when it has none), and
 * for an exclGroup every member's default and off state.
 */
function xfaTemplateBindings(xml: string): XfaBindings | null {
  const b: XfaBindings = { byPath: new Map(), global: new Map(), byName: new Map(), dv: new Map() };
  type Frame = {
    tag: string;
    ctx?: XfaFieldCtx;
    near?: XfaFieldCtx;
    valueCtx?: XfaFieldCtx;
    itemCtx?: XfaFieldCtx;
    items?: boolean;
    /** A subform's data scope, and the one it was opened in. */
    scope?: string[];
    base?: string[];
  };
  const stack: Frame[] = [];
  let seen = false;
  let depth = -1; // stack depth of the open <template>
  const scopeOf = () => {
    for (let k = stack.length - 1; k >= 0; k--) {
      const s = stack[k].scope;
      if (s) return s;
    }
    return [];
  };
  const put = (m: Map<string, XfaSlot>, key: string, c: XfaFieldCtx) => {
    const s = m.get(key) ?? { defaults: new Set<string>(), editable: false };
    for (const d of c.defaults) s.defaults.add(d);
    s.editable ||= c.editable;
    m.set(key, s);
  };
  const close = (f: Frame) => {
    const c = f.ctx;
    if (!c) return;
    if (c.value !== null && xfaNorm(c.value)) c.defaults.add(xfaNorm(c.value));
    if (c.check) {
      if (c.items.length === 0) c.defaults.add("0");
      for (const list of c.items) if (list.length > 1) c.defaults.add(xfaNorm(list[1]));
    }
    if (c.group) {
      for (const d of c.defaults) c.group.defaults.add(d);
      return; // a member binds through its exclGroup
    }
    if (c.match === "none") return;
    if (c.match === "global") {
      if (c.name) {
        put(b.global, c.name, c);
        put(b.byName, c.name, c);
      }
      return;
    }
    const path =
      c.match === "dataRef"
        ? resolveXfaRef(c.ref, scopeOf())
        : c.name
          ? [...scopeOf(), c.name]
          : null;
    if (!path?.length) return;
    put(b.byPath, path.join("."), c);
    put(b.byName, path[path.length - 1], c);
  };
  for (const t of xmlTokens(xml)) {
    if (t.kind === "open") {
      if (depth < 0) {
        if (t.name !== "template") continue;
        seen = true;
        depth = stack.length;
        if (t.empty) depth = -1;
        else stack.push({ tag: t.name, scope: [] });
        continue;
      }
      const p = stack[stack.length - 1];
      const f: Frame = { tag: t.name, near: p.near };
      if (t.name === "field" || t.name === "exclGroup") {
        const access = xmlAttr(t.attrs, "access") ?? "";
        const presence = xmlAttr(t.attrs, "presence") ?? "";
        f.ctx = f.near = {
          name: xmlAttr(t.attrs, "name") ?? "",
          match: "normal",
          ref: "",
          value: null,
          items: [],
          check: false,
          editable:
            !["readOnly", "protected", "nonInteractive"].includes(access) &&
            !["hidden", "inactive"].includes(presence),
          isGroup: t.name === "exclGroup",
          group: t.name === "field" && p.ctx?.isGroup ? p.ctx : null,
          defaults: new Set(),
        };
      } else if (t.name === "subform") {
        const base = scopeOf();
        const name = xmlAttr(t.attrs, "name");
        f.base = base;
        f.scope = name ? [...base, name] : base;
      } else if (p.ctx && t.name === "value") {
        f.valueCtx = p.ctx;
        p.ctx.value = "";
      } else if (p.ctx && t.name === "items") {
        f.items = true;
        f.itemCtx = p.ctx;
        p.ctx.items.push([]);
      } else if (p.items && p.itemCtx) {
        p.itemCtx.items[p.itemCtx.items.length - 1].push("");
        f.itemCtx = p.itemCtx;
      } else if (t.name === "bind" && (p.ctx || p.base)) {
        const match = xmlAttr(t.attrs, "match") ?? "once";
        const ref = xmlAttr(t.attrs, "ref") ?? "";
        if (p.ctx) {
          if (match === "none" || match === "global") p.ctx.match = match;
          else if (match === "dataRef" && ref) {
            p.ctx.match = "dataRef";
            p.ctx.ref = ref;
          }
        } else if (p.base) {
          if (match === "none") p.scope = p.base;
          else if (match === "dataRef" && ref) p.scope = resolveXfaRef(ref, p.base) ?? p.scope;
        }
      } else if (t.name === "checkButton" && f.near) {
        f.near.check = true;
      } else {
        f.valueCtx = p.valueCtx;
        f.itemCtx = p.items ? undefined : p.itemCtx;
      }
      if (t.empty) close(f);
      else stack.push(f);
    } else if (t.kind === "close") {
      if (depth < 0) continue;
      const f = stack.pop();
      if (f) close(f);
      if (stack.length <= depth) depth = -1;
    } else if (depth >= 0) {
      const f = stack[stack.length - 1];
      if (f.valueCtx && f.valueCtx.value !== null) f.valueCtx.value += t.text;
      else if (f.itemCtx && !f.items) {
        const list = f.itemCtx.items[f.itemCtx.items.length - 1];
        if (list.length) list[list.length - 1] += t.text;
      }
    }
  }
  return seen ? b : null;
}

/**
 * The values under an XFA datasets packet's `<data>` element (CDATA too) that
 * the blank form doesn't supply itself. A value is a leaf element's own text,
 * whitespace collapsed; text on an element that has child elements (a subform's
 * data group) is not. Its field is the one bound at its path, else a `global`
 * field of its name, else any bound field of its name. With a template
 * (`hasTemplate`), a value no field binds doesn't count: no one can type into
 * a field that doesn't exist. A bound value counts unless no field there takes
 * input or it equals one of the defaults (template, plus AcroForm /DV, see
 * userMarkupCount). Without a template every value counts unless it equals the
 * /DV of a field of its name.
 */
function xfaDataValues(
  xml: string,
  bindings: XfaBindings | null,
  hasTemplate: boolean,
): MarkupDetail[] {
  type Frame = { tag: string; text: string; parent: boolean };
  const stack: Frame[] = [];
  let data = -1; // stack depth of <data>
  const n: MarkupDetail[] = [];
  // Start at the datasets packet: a whole XDP's template comes first.
  const ds = /<([\w.-]+:)?datasets\b/.exec(xml);
  if (ds) xml = xml.slice(ds.index);
  const done = (f: Frame) => {
    const v = xfaNorm(f.text);
    if (!v || f.parent) return;
    const steps = stack
      .slice(data + 1)
      .map((x) => x.tag)
      .concat([f.tag]);
    const path = steps.join(".");
    const s =
      bindings?.byPath.get(path) ?? bindings?.global.get(f.tag) ?? bindings?.byName.get(f.tag);
    if (!s && hasTemplate) return;
    const dv = bindings?.dv.get(f.tag);
    if (dv?.has(v)) return;
    if (s && (!s.editable || s.defaults.has(v))) return;
    const defaults = [...(s?.defaults ?? []), ...(dv ?? [])];
    const rule = defaults.length ? "differs_from_default" : !s ? "no_template" : "no_default";
    const value = clip(v);
    const def = defaults.length
      ? clip(defaults.map((d) => JSON.stringify(d)).join(" | "))
      : "none found";
    const why = {
      no_template: "the form has no XFA template to compare with",
      no_default: "its field has no default",
      differs_from_default: `the default is ${def}`,
    }[rule];
    n.push({
      kind: "xfa",
      name: f.tag,
      path,
      value,
      default: def,
      rule,
      summary: `XFA value ${JSON.stringify(value)} at ${path} (${why})`,
    });
  };
  for (const t of xmlTokens(xml)) {
    if (t.kind === "open") {
      const parent = stack.at(-1);
      if (data < 0 && t.name === "data" && (!parent || parent.tag === "datasets")) {
        if (t.empty) return n;
        data = stack.length;
      }
      if (parent) parent.parent = true;
      if (!t.empty) stack.push({ tag: t.name, text: "", parent: false });
    } else if (t.kind === "close") {
      const f = stack.pop();
      if (data >= 0 && f) {
        done(f);
        if (stack.length <= data) return n;
      }
    } else if (data >= 0 && stack.length > data) {
      stack[stack.length - 1].text += t.text;
    }
  }
  // An unterminated packet: what is still open counts too.
  if (data >= 0) {
    for (let f = stack.pop(); f && stack.length >= data; f = stack.pop()) done(f);
  }
  return n;
}

/**
 * The content a person may have added to a PDF outside its AcroForm values,
 * which `prefilledAcroFieldCount` does not see. Throws when the PDF can't be
 * read.
 *
 * Annotations: FreeText with /Contents or an appearance, a Text note with
 * /Contents, and Ink always count. A stamp or shape (SHAPES) counts when it
 * carries an authoring trace: /Contents, an author /T, /RC, an /IT intent, an
 * `AAPL:` key, or a /M later than the document's /CreationDate (any /M when
 * there is none) unless its /F is ReadOnly, Locked or LockedContents. That is
 * what the tools people use write: macOS Preview (PDFKit) sets /T to the
 * user's name, /M, and its `AAPL:AKExtras` dictionary on everything it adds;
 * Acrobat's comment tools and Fill & Sign set /T, /M and /CreationDate (Fill &
 * Sign's text is FreeText, /IT /FreeTextTypeWriter); pdf.js's editor sets /M.
 * A stamp or shape without any of that, or a locked one stamped before the
 * document was made, is the issuer's: some official blanks ship them.
 *
 * XFA: the values of the datasets packet that sit in a field someone can type
 * into and differ from what the form supplies itself (xfaDataValues): the
 * template packet's defaults for the field bound there (xfaTemplateBindings
 * resolves `<bind>`) and the /DV of the AcroForm field of the same name.
 * Government XFA blanks ship datasets full of such defaults (dates, country
 * codes, zeros, option states) and of data no field binds. With no template
 * packet (or one that can't be decoded) every non-empty value counts, as does a
 * datasets stream that can't be decoded (fail-closed).
 */
export async function userMarkupCount(pdfBytes: ArrayBuffer): Promise<UserMarkup> {
  const pdfLib = await import("pdf-lib");
  const { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFStream } = pdfLib;
  let doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });
  if (doc.isEncrypted) {
    const { decryptPdf } = await import("./decryptPdf");
    doc = await PDFDocument.load(await decryptPdf(pdfBytes), { updateMetadata: false });
  }
  const text = (v: unknown) =>
    v instanceof pdfLib.PDFString || v instanceof pdfLib.PDFHexString ? v.decodeText().trim() : "";
  const nameOrText = (v: unknown) => (v instanceof PDFName ? v.decodeText() : text(v));

  let created = NaN;
  let createdRaw: string | null = null;
  try {
    const info = doc.context.lookup(doc.context.trailerInfo.Info);
    if (info instanceof PDFDict) createdRaw = text(info.lookup(PDFName.of("CreationDate"))) || null;
    created = doc.getCreationDate()?.getTime() ?? NaN;
  } catch {
    // An unreadable /CreationDate: every /M is then later.
  }
  /** What makes the annotation someone's markup, or null when it isn't. */
  const markupTrace = (a: PDFDict, type: string): string | null => {
    const contents = text(a.lookup(PDFName.of("Contents")));
    if (type === "Ink") return "Ink (always counted)";
    if (type === "FreeText") {
      if (contents !== "") return "FreeText with /Contents";
      return a.has(PDFName.of("AP")) ? "FreeText with an appearance (/AP)" : null;
    }
    if (type === "Text") return contents !== "" ? "Text note with /Contents" : null;
    if (!SHAPES.has(type)) return null;
    const traces: string[] = [];
    if (contents !== "") traces.push("/Contents");
    if (text(a.lookup(PDFName.of("T"))) !== "") traces.push("/T author");
    if (a.has(PDFName.of("RC"))) traces.push("/RC");
    if (a.has(PDFName.of("IT"))) traces.push("/IT");
    if (a.keys().some((k) => k.decodeText().startsWith("AAPL:"))) traces.push("AAPL: key");
    if (traces.length) return traces.join(", ");
    const m = text(a.lookup(PDFName.of("M")));
    if (m === "") return null;
    const f = a.lookup(PDFName.of("F"));
    const locked = f instanceof PDFNumber && (f.asNumber() & F_LOCKED) !== 0;
    if (locked || pdfDateMs(m) <= created) return null;
    return Number.isNaN(created)
      ? "/M with no /CreationDate to compare"
      : "/M later than /CreationDate";
  };
  const details: MarkupDetail[] = [];

  let annotations = 0;
  const annotationPages: number[] = [];
  doc.getPages().forEach((page, i) => {
    const list = page.node.lookup(PDFName.of("Annots"));
    if (!(list instanceof PDFArray)) return;
    let here = 0;
    for (let k = 0; k < list.size(); k++) {
      const a = list.lookup(k);
      if (!(a instanceof PDFDict)) continue;
      const sub = a.lookup(PDFName.of("Subtype"));
      const type = sub instanceof PDFName ? sub.decodeText() : "";
      const trace = markupTrace(a, type);
      if (trace === null) continue;
      here++;
      const f = a.lookup(PDFName.of("F"));
      const modified = text(a.lookup(PDFName.of("M"))) || null;
      details.push({
        kind: "annotation",
        page: i + 1,
        subtype: type,
        keys: a
          .keys()
          .map((key) => key.decodeText())
          .sort(),
        flags: f instanceof PDFNumber ? f.asNumber() : null,
        modified,
        creationDate: createdRaw,
        trace,
        summary: `${type || "untyped"} annotation on page ${String(i + 1)} (${trace})`,
      });
    }
    if (here > 0) {
      annotations += here;
      annotationPages.push(i + 1);
    }
  });

  let xfaValues = 0;
  const acro = doc.catalog.lookup(PDFName.of("AcroForm"));
  const xfa = acro instanceof PDFDict ? acro.lookup(PDFName.of("XFA")) : undefined;
  const decode = (st: unknown) => {
    if (!(st instanceof PDFRawStream)) throw new Error("not a stream");
    return new TextDecoder("utf-8").decode(pdfLib.decodePDFRawStream(st).decode());
  };
  // An XFA array alternates packet names and streams; a lone stream is the
  // whole XDP (or, as some writers do, just the datasets packet).
  const datasets: unknown[] = [];
  const others: unknown[] = [];
  if (xfa instanceof PDFArray) {
    for (let k = 0; k + 1 < xfa.size(); k += 2) {
      (text(xfa.lookup(k)) === "datasets" ? datasets : others).push(xfa.lookup(k + 1));
    }
  } else if (xfa instanceof PDFStream) {
    datasets.push(xfa);
    others.push(xfa);
  }
  if (datasets.length === 0) return { annotations, annotationPages, xfaValues, details };

  let bindings: XfaBindings | null = null;
  try {
    bindings = xfaTemplateBindings(others.map(decode).join("\n"));
  } catch {
    bindings = null; // an undecodable template: as if there were none
  }
  const hasTemplate = bindings !== null;
  // AcroForm /DV (static XFA forms mirror their fields as `form1[0].Name[0]`).
  const fields = acro instanceof PDFDict ? acro.lookup(PDFName.of("Fields")) : undefined;
  const dvs: [string, string][] = [];
  const walk = (node: unknown, depth: number) => {
    if (!(node instanceof PDFDict) || depth > 32) return;
    const dv = xfaNorm(nameOrText(node.lookup(PDFName.of("DV"))));
    const t = text(node.lookup(PDFName.of("T"))).replace(/\[\d+\]$/, "");
    if (dv && t) dvs.push([t, dv]);
    const kids = node.lookup(PDFName.of("Kids"));
    if (kids instanceof PDFArray)
      for (let k = 0; k < kids.size(); k++) walk(kids.lookup(k), depth + 1);
  };
  if (fields instanceof PDFArray) for (let k = 0; k < fields.size(); k++) walk(fields.lookup(k), 0);
  if (dvs.length) {
    bindings ??= { byPath: new Map(), global: new Map(), byName: new Map(), dv: new Map() };
    for (const [name, dv] of dvs) {
      const set = bindings.dv.get(name) ?? new Set<string>();
      set.add(dv);
      bindings.dv.set(name, set);
    }
  }

  for (const st of datasets) {
    try {
      const found = xfaDataValues(decode(st), bindings, hasTemplate);
      xfaValues += found.length;
      details.push(...found);
    } catch {
      xfaValues += 1;
      details.push({
        kind: "xfa",
        name: "",
        path: "",
        value: "",
        default: "none found",
        rule: "undecodable",
        summary: "an XFA datasets stream that can't be decoded",
      });
    }
  }
  return { annotations, annotationPages, xfaValues, details };
}

/** Whether the PDF's Info dictionary carries `key`, or one of `key` when it is
 *  a list (e.g. FILLED_OUTPUT_TAGS). */
export async function hasInfoTag(
  pdfBytes: ArrayBuffer,
  key: string | readonly string[],
): Promise<boolean> {
  const pdfLib = await import("pdf-lib");
  const opts = { ignoreEncryption: true, updateMetadata: false };
  const doc = await pdfLib.PDFDocument.load(pdfBytes, opts);
  const info = doc.context.lookup(doc.context.trailerInfo.Info);
  if (!(info instanceof pdfLib.PDFDict)) return false;
  return (typeof key === "string" ? [key] : key).some((k) => info.has(pdfLib.PDFName.of(k)));
}

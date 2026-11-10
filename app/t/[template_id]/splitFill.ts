// Pure split-group fill logic (sibling of combFill.ts), shared by the fill UI,
// the agent value mapper (agentValues.ts), mass-fill and the MCP package, so a
// split value lands in the fill store the same way from every path.
//
// A split group shows the filler ONE input; its value is distributed into the
// member slots (f{id}), which hold ordinary text the stamp / export paths never
// need to know about. Two rules:
//  - `parts`: a number cut into an integer box and a fraction box (PIT-37
//    `zł | gr`), written into the member slots. The member roles are
//    order-derived: group.members = [int, frac] (stored order, not geometry).
//  - `flow`: one text wrapped box to box (PAYE "Home address" over three lines).
//    Its value is ONE string under the group's flowKey; the member strings are
//    derived where marks are built (fillMarks.ts → distributeFlow) and never
//    stored, because breaks are not invertible (collapsed spaces, hard breaks).
//    The breaks are measured with the stamp's advance table (stampAdvances.ts),
//    so every surface that builds marks (fill UI, browser stamp, mass fill, the
//    MCP) puts the same words in the same box (decision D2).
//
// Node-safe: no React, no store, no DOM.

import {
  type Field,
  fieldFontSizeOf,
  fieldIsAutoFontSize,
  type Group,
  MIN_FONT_SIZE,
  type PageInfo,
  splitFracDigitsOf,
  splitPadFracOf,
  textMultilineOf,
  textUppercaseOf,
} from "@/types";

import { shapeArabic } from "./arabicShaping";
import { needsBidi, stripBidiControls } from "./bidiText";
import { fieldKey } from "./fillKeys";
import { stampAdvanceMeasure, stampZeroAdvance } from "./stampAdvances";
import {
  autoTextStartPt,
  cjkPieces,
  fitFontSize,
  hangIdeoSpaces,
  type MeasureText,
  PREVIEW_DPI,
  TEXT_PAD_PT,
} from "./textFit";

/** A parts value, parsed: the integer digits and the fraction digits as given
 *  (never rounded; zeros past `frac_digits` trimmed), or why it was refused.
 *  `int` and `frac` are both "" for an empty value. */
export type PartsParse = { ok: true; int: string; frac: string } | { ok: false; reason: string };

/** The store writes a split value makes, or why it was refused. */
export type SplitWrite =
  { ok: true; entries: [key: string, value: string][] } | { ok: false; reason: string };

/** The group attributes the parts rule reads (absent ones are defaults). */
export type PartsGroup = Pick<Group, "members" | "frac_digits" | "pad_frac">;

// Thousands separators the integer part may carry: a space, a no-break space
// (U+00A0) and a narrow no-break space (U+202F, what Intl prints for pl-PL).
const THOUSANDS = "[ \\u00a0\\u202f]";
const PLAIN_INT = /^\d+$/;
const GROUPED_INT = new RegExp(`^\\d{1,3}(?:${THOUSANDS}\\d{3})+$`);
const SEPARATOR = new RegExp(THOUSANDS, "g");

const fracWord = (n: number) => (n === 1 ? "1 decimal place" : `${String(n)} decimal places`);

/**
 * Parses an amount for a parts split with `fracDigits` fraction digits.
 * Accepts `1234.56`, `1234,56`, `1 234,56` (space, no-break or narrow no-break
 * space between groups of three), `1234`, `1234.` and a non-negative finite
 * number. Refuses negatives (a loss goes in its own position), more fraction
 * digits than the box holds (money is never rounded; trailing zeros past it
 * are fine: `12.50` with 1 digit is `12.5`), a fraction with no integer part
 * (`.56`), and anything else that is not a plain amount. Leading zeros of the
 * integer part are dropped (`007` → `7`, `0` stays).
 */
export function parseParts(raw: string | number, fracDigits: number): PartsParse {
  let s: string;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { ok: false, reason: "Enter an amount, such as 1234.56." };
    if (raw < 0) return { ok: false, reason: "Enter an amount without a minus sign." };
    s = String(raw);
    if (/e/i.test(s)) {
      return { ok: false, reason: "Enter the amount as written digits, such as 1234.56." };
    }
  } else {
    s = raw.normalize("NFC").trim();
  }
  if (s === "") return { ok: true, int: "", frac: "" };
  if (s.startsWith("-") || s.startsWith("−")) {
    return { ok: false, reason: "Enter an amount without a minus sign." };
  }
  const seps = s.match(/[.,]/g) ?? [];
  if (seps.length > 1) {
    return {
      ok: false,
      reason: "Use one decimal separator and no thousands commas, such as 1234.56 or 1 234,56.",
    };
  }
  const at = s.search(/[.,]/);
  const intPart = at < 0 ? s : s.slice(0, at);
  let frac = at < 0 ? "" : s.slice(at + 1);
  if (intPart === "") {
    return { ok: false, reason: "Enter the whole part too, such as 0,56." };
  }
  if (!PLAIN_INT.test(intPart) && !GROUPED_INT.test(intPart)) {
    return { ok: false, reason: "Enter an amount using digits only, such as 1234.56." };
  }
  if (frac !== "" && !PLAIN_INT.test(frac)) {
    return { ok: false, reason: "Enter an amount using digits only, such as 1234.56." };
  }
  if (frac.length > fracDigits) {
    if (frac.replace(/0+$/, "").length > fracDigits) {
      return {
        ok: false,
        reason:
          fracDigits === 0
            ? "This amount takes whole numbers only."
            : `This amount takes at most ${fracWord(fracDigits)}.`,
      };
    }
    frac = frac.slice(0, fracDigits); // only zeros are cut
  }
  const int = intPart.replace(SEPARATOR, "").replace(/^0+(?=\d)/, "");
  return { ok: true, int, frac };
}

/** The group's [int, frac] member fields, in group.members order (D1), or
 *  null when it does not name exactly two members that both resolve. */
export function partsMembers<F extends Pick<Field, "id">>(
  group: Pick<Group, "members">,
  members: readonly F[],
): [int: F, frac: F] | null {
  const ids: unknown = group.members;
  if (!Array.isArray(ids) || ids.length !== 2) return null;
  const int = members.find((m) => m.id === ids[0]);
  const frac = members.find((m) => m.id === ids[1]);
  return int && frac && int !== frac ? [int, frac] : null;
}

/**
 * The store writes a parts value makes: the integer box gets its digits with
 * no separator; a fraction the value GIVES is always right-padded with zeros
 * to `frac_digits` (`12.5` → `12`|`50`: printing `5` would read as 5 gr).
 * `pad_frac` only decides a WHOLE amount's fraction box: true → zeros
 * (`1234` → `1234`|`00`), false → left empty (`1234` → `1234`|``). With
 * `frac_digits` 0 the fraction box is always "". An empty value clears both.
 * `members` are the group's member fields in any order (keys follow
 * group.members).
 */
export function distributeParts(
  value: string | number,
  group: PartsGroup,
  members: readonly Pick<Field, "id">[],
): SplitWrite {
  const pair = partsMembers(group, members);
  if (!pair) return { ok: false, reason: "This amount needs exactly two boxes." };
  const digits = splitFracDigitsOf(group);
  const p = parseParts(value, digits);
  if (!p.ok) return p;
  const [intField, fracField] = pair;
  let frac = "";
  if (p.int !== "" && digits > 0 && (p.frac !== "" || splitPadFracOf(group)))
    frac = p.frac.padEnd(digits, "0");
  return {
    ok: true,
    entries: [
      [fieldKey(intField.id), p.int],
      [fieldKey(fracField.id), frac],
    ],
  };
}

/**
 * The one value a parts split shows in its fill input, read back from its
 * member slots: `int.frac` with "." as the separator (`1234.56`; locale display
 * is the UI's call), just `int` when the fraction box is empty or the group
 * takes no fraction, "" when both are empty. A fraction with an empty integer
 * box reads as `0.frac`, so it parses back. Values are shown as stored.
 */
export function joinSplit(
  group: PartsGroup,
  members: readonly Pick<Field, "id">[],
  values: Readonly<Record<string, string | undefined>>,
): string {
  const pair = partsMembers(group, members);
  if (!pair) return "";
  const int = (values[fieldKey(pair[0].id)] ?? "").trim();
  const frac = (values[fieldKey(pair[1].id)] ?? "").trim();
  if (frac === "" || splitFracDigitsOf(group) === 0) return int;
  return `${int === "" ? "0" : int}.${frac}`;
}

/** A parts split as it prints: each box's text as drawn ("" prints nothing)
 *  and the ONE size both boxes are drawn at. */
export interface PartsLayout {
  texts: [int: string, frac: string];
  sizePt: number;
}

/**
 * A parts split's two boxes at ONE size (`1234` | `56` never at 11 pt and 9 pt):
 * each non-empty box's own size, its pinned font_size or else the Auto start
 * from its canonical box height (flowMemberOf, the schema page size, never the
 * live frame), shrunk to fit its own text with the stamp's advance table
 * (stampFlowMeasure, as a flow line), and the smaller of the two. buildMarks
 * pins both marks to it and the on-page control shows it, so the fill view,
 * the stamp, the export and the MCP all print one size. `pair` is [int, frac]
 * (partsMembers). null when there is nothing to print, or it cannot be
 * measured (a box's page has no size yet, a box that is not single-line text):
 * each box is then stamped like an ordinary field.
 */
export function partsLayout(
  pair: readonly [
    Pick<Field, "id" | "type" | "format" | "wpct" | "hpct" | "page">,
    Pick<Field, "id" | "type" | "format" | "wpct" | "hpct" | "page">,
  ],
  raw: readonly [string, string],
  pages: ReadonlyMap<number, FlowPage>,
  autoHPct?: (id: string) => number | undefined,
): PartsLayout | null {
  if (pair.some((m) => m.type !== "text" || textMultilineOf(m))) return null;
  // What the stamp draws: one line, capitals when the box asks for them.
  const texts = pair.map((m, i) => {
    const t = raw[i].replace(/\s*\n\s*/g, " ");
    return textUppercaseOf(m) ? t.toUpperCase() : t;
  }) as [string, string];
  let sizePt = Infinity;
  for (let i = 0; i < 2; i++) {
    if (texts[i] === "") continue;
    const m = pair[i];
    const spec = flowMemberOf(m, pages.get(m.page), autoHPct?.(m.id));
    if (!spec) return null;
    sizePt = Math.min(sizePt, fitFontSize(texts[i], spec.availPt, spec.sizePt, stampFlowMeasure));
  }
  return Number.isFinite(sizePt) ? { texts, sizePt } : null;
}

// ---- flow ----------------------------------------------------------------------

/** One box of a flow split, in canonical PDF points (see flowMemberOf). */
export interface FlowMember {
  /** Usable line width: the box width (from the schema's page size, never the
   *  live page frame) less 2·TEXT_PAD_PT. */
  availPt: number;
  /** Start size: the member's pinned font_size, or its Auto start size from the
   *  canonical box height. */
  sizePt: number;
}

/** none: every member fits at its start size. shrunk: some member (normally
 *  the last used one) had to shrink, and fits at or above the minimum size.
 *  clipped: some member still runs past its box at the minimum size (flagged
 *  like an overlong single-line field). */
export type FlowOverflow = "none" | "shrunk" | "clipped";

export interface FlowResult {
  /** One string per member, in member order; "" for an unused member. */
  parts: string[];
  /** The size each member is drawn at: its sizePt unless it had to shrink. */
  sizes: number[];
  overflow: FlowOverflow;
}

export interface FlowOptions {
  /** Break points inside a space-delimited word. Default: textFit's cjkPieces
   *  (the same kinsoku as multi-line wrapping). */
  split?: (word: string) => string[];
  /** A code point that stays glued to the one before it when a word is
   *  hard-broken. Default: zero-width in the stamp face (combining marks,
   *  variation selectors), ZWJ and the kana voicing marks. */
  joins?: (cp: number) => boolean;
  /** The shrink floor. Default MIN_FONT_SIZE, as single-line fields. */
  minSize?: number;
}

const defaultJoins = (cp: number): boolean =>
  cp === 0x200d || cp === 0x3099 || cp === 0x309a || stampZeroAdvance(cp);

/** The stamp's width of a flow line: stampAdvanceMeasure over what the stamp
 *  measures for it. A line holding a right-to-left character is shaped (Arabic
 *  joining forms) and drops its bidi controls, exactly as stampPdf measures a
 *  mark's text. Shaping a line alone equals shaping it in place: Arabic joining
 *  never crosses a space, and a hard break makes two words on every surface. */
export const stampFlowMeasure: MeasureText = (text, size) =>
  stampAdvanceMeasure(needsBidi(text) ? stripBidiControls(shapeArabic(text)) : text, size);

interface Piece {
  text: string;
  /** Put before the piece when it follows another on the same line: " " for a
   *  new word, "" for the next CJK piece of a word or a hard-broken word's tail. */
  sep: "" | " ";
  /** First piece of a paragraph (an explicit newline before it). */
  paraStart: boolean;
}

// Only U+0020 and TAB separate words: a no-break space (U+00A0, U+202F) keeps
// its neighbours together. Runs collapse; leading/trailing spaces go.
function paragraphPieces(text: string, split: (word: string) => string[]): Piece[] {
  const out: Piece[] = [];
  for (const para of text.replace(/\r\n?/g, "\n").split("\n")) {
    let first = true;
    for (const word of para.split(/[ \t]+/)) {
      if (word === "") continue;
      split(word).forEach((p, i) => {
        out.push({ text: p, sep: i === 0 ? " " : "", paraStart: first && i === 0 });
      });
      first = false;
    }
  }
  return out;
}

// The longest code-point prefix of `piece` that fits `avail`, never cut before a
// joining code point, and at least one unit (so a box narrower than one glyph
// still makes progress). Widths only grow with the prefix (advances ≥ 0).
function hardBreak(
  piece: string,
  avail: number,
  size: number,
  measure: MeasureText,
  joins: (cp: number) => boolean,
): [head: string, tail: string] {
  const cps = Array.from(piece);
  const cuts: number[] = [];
  for (let i = 1; i < cps.length; i++) if (!joins(cps[i].codePointAt(0) ?? 0)) cuts.push(i);
  let best = cuts.length > 0 ? cuts[0] : cps.length;
  for (const c of cuts) {
    if (measure(hangIdeoSpaces(cps.slice(0, c).join("")), size) <= avail) best = c;
    else break;
  }
  return [cps.slice(0, best).join(""), cps.slice(best).join("")];
}

/**
 * Distributes `text` over a flow split's `members` (reading order).
 *
 * Greedy, word by word, measuring each whole trial line (as wrapLines does):
 *  - words break on spaces and tabs only, and Japanese inside a word at its
 *    kinsoku break points; runs of spaces collapse, and no box starts or ends
 *    with one (trailing ideographic spaces hang off a box's end, as in wrapping);
 *  - an explicit newline moves to the next box; blank lines are dropped; on the
 *    last box a new paragraph joins with a space (a box holds one line);
 *  - a word wider than an EMPTY box that is not the last is hard-broken at the
 *    longest prefix that fits, and its tail starts the next box with no space;
 *  - the last box takes the rest. A box that is still too wide (the last one,
 *    or a box narrower than one character) shrinks like a single-line field
 *    (fitFontSize: one proportional step, floor `minSize`); if that is not
 *    enough the result is "clipped".
 *
 * Deterministic in every engine: only `measure`, plain string operations,
 * ASCII-only regexes and IEEE arithmetic in a fixed order (no Intl, no Unicode
 * property classes). With stampFlowMeasure and the same members, the fill UI,
 * the browser stamp and the MCP get the same parts and sizes.
 */
export function distributeFlow(
  text: string,
  members: readonly FlowMember[],
  measure: MeasureText,
  opts: FlowOptions = {},
): FlowResult {
  const split = opts.split ?? cjkPieces;
  const joins = opts.joins ?? defaultJoins;
  const minSize = opts.minSize ?? MIN_FONT_SIZE;
  const n = members.length;
  const parts: string[] = members.map(() => "");
  const sizes = members.map((m) => m.sizePt);
  if (n === 0) return { parts, sizes, overflow: "none" };

  const queue = paragraphPieces(text, split);
  let m = 0;
  let line = "";
  const close = () => {
    parts[m] = hangIdeoSpaces(line);
    m += 1;
    line = "";
  };
  for (let q = 0; q < queue.length; q++) {
    const piece = queue[q];
    const last = m === n - 1;
    if (last) {
      // The last box takes everything; a paragraph joins with a space.
      const sep = line === "" ? "" : piece.paraStart ? " " : piece.sep;
      line = line + sep + piece.text;
      continue;
    }
    if (line !== "" && piece.paraStart) {
      close(); // a newline: next box
      q -= 1;
      continue;
    }
    const trial = line === "" ? piece.text : line + piece.sep + piece.text;
    const { availPt, sizePt } = members[m];
    if (measure(hangIdeoSpaces(trial), sizePt) <= availPt) {
      line = trial;
      continue;
    }
    if (line !== "") {
      close(); // the piece starts the next box
      q -= 1;
      continue;
    }
    // Alone in an empty box and still too wide: hard-break it; the tail continues
    // the same word in the next box (glued, not a new paragraph).
    const [head, tail] = hardBreak(piece.text, availPt, sizePt, measure, joins);
    line = head;
    close();
    if (tail !== "") queue.splice(q + 1, 0, { text: tail, sep: "", paraStart: false });
  }
  if (line !== "") parts[m] = m < n - 1 ? hangIdeoSpaces(line) : line;

  let shrunk = false;
  let clipped = false;
  for (let i = 0; i < n; i++) {
    const body = parts[i];
    if (body === "") continue;
    const { availPt, sizePt } = members[i];
    // fitFontSize, with the fit flag the stamp reports (Placement.fits).
    const tw = measure(body, sizePt);
    if (availPt > 0 && (tw <= availPt || tw <= 0)) continue;
    const size = availPt > 0 ? Math.max(minSize, (sizePt * availPt) / tw) : sizePt;
    sizes[i] = size;
    if (size !== sizePt) shrunk = true;
    if (!(measure(body, size) <= availPt + 0.01)) clipped = true;
  }
  return { parts, sizes, overflow: clipped ? "clipped" : shrunk ? "shrunk" : "none" };
}

/** The page size a flow member is measured against: the schema's PageInfo
 *  (preview raster pixels at PREVIEW_DPI), never a live PDF page frame. */
export type FlowPage = Pick<PageInfo, "page" | "width" | "height">;

/**
 * A flow member's canonical box: width from the schema page size less the text
 * padding, and its start size (a pinned font_size, or the Auto start size from
 * the box height, `autoHPct` when it shares one with its neighbours). Every
 * surface computes it from the schema, so every surface flows into the same
 * widths (the live page frame differs from the raster by up to a pixel, enough
 * to move a word). null when the page has no size yet.
 */
export function flowMemberOf(
  field: Pick<Field, "type" | "format" | "wpct" | "hpct">,
  page: FlowPage | undefined,
  autoHPct?: number,
): FlowMember | null {
  if (!page || !(page.width > 0) || !(page.height > 0)) return null;
  const pageWidthPt = (page.width * 72) / PREVIEW_DPI;
  const pageHeightPt = (page.height * 72) / PREVIEW_DPI;
  const availPt = (field.wpct / 100) * pageWidthPt - 2 * TEXT_PAD_PT;
  const sizePt = fieldIsAutoFontSize(field)
    ? autoTextStartPt(((autoHPct ?? field.hpct) / 100) * pageHeightPt)
    : fieldFontSizeOf(field);
  return { availPt, sizePt };
}

/** A well-formed flow split's boxes in group.members order, each once, or null
 *  when the group is not a flow split or fewer than two of its boxes resolve.
 *  Only a well-formed flow is ONE value (flowKey) to the agent schema, mass
 *  fill and the fill counters; a malformed one is filled box by box (f{id}),
 *  like plain text fields. agent_schema.py `_split_flow`. */
export function flowSplitBoxes<F extends Pick<Field, "id">>(
  group: Pick<Group, "kind" | "rule" | "members">,
  fieldById: ReadonlyMap<string, F>,
): F[] | null {
  if (group.kind !== "split" || group.rule !== "flow" || !Array.isArray(group.members)) return null;
  const boxes = [...new Set(flowMembers(group, fieldById))];
  return boxes.length >= 2 ? boxes : null;
}

/** A flow split's member fields in group.members order (the authored reading
 *  order, not geometry); dangling ids are dropped. */
export function flowMembers<F extends Pick<Field, "id">>(
  group: Pick<Group, "members">,
  fieldById: ReadonlyMap<string, F>,
): F[] {
  const out: F[] = [];
  for (const id of group.members) {
    const f = fieldById.get(id);
    if (f) out.push(f);
  }
  return out;
}

/** A flow value laid out over its boxes: what buildMarks stamps, and what the
 *  fill inputs show and flag. `text` is the value as measured (capitalized when
 *  a member asks for capitals: one value, one case). `flow` is null when a box's
 *  page has no size yet (a dimension-less ghost page). */
export interface FlowLayout<F> {
  members: F[];
  text: string;
  flow: FlowResult | null;
}

/**
 * The ONE derivation of a flow split's boxes (decision D2): buildMarks stamps it
 * and the fill UI displays it, so the input, the on-page boxes and the PDF can
 * never break the value differently. `autoHPct` is a box's shared Auto height
 * (autoSize.ts), when it has one.
 */
export function flowLayout<
  F extends Pick<Field, "id" | "type" | "format" | "wpct" | "hpct" | "page">,
>(
  group: Pick<Group, "members">,
  fieldById: ReadonlyMap<string, F>,
  pages: ReadonlyMap<number, FlowPage>,
  raw: string,
  autoHPct?: (id: string) => number | undefined,
): FlowLayout<F> {
  const members = flowMembers(group, fieldById);
  const text = members.some((m) => textUppercaseOf(m)) ? raw.toUpperCase() : raw;
  const specs = members.map((m) => flowMemberOf(m, pages.get(m.page), autoHPct?.(m.id)));
  const ok = specs.filter((sp): sp is FlowMember => sp !== null);
  const flow =
    members.length > 0 && ok.length === specs.length
      ? distributeFlow(text, ok, stampFlowMeasure)
      : null;
  return { members, text, flow };
}

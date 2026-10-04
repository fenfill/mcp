// Shared types for the parsed-PDF schema. This shape is produced by the
// FastAPI pipeline and stored verbatim as `templates.schema_json`.
//
// v5 contract: coordinates are PERCENT of the page preview image (top-left
// origin). Field/group ids are PERSISTENT UUIDs (strings). A field has
// one of four `type`s (text/checkbox/date/signature) plus an optional, nested
// `format` carrying that type's formatting knobs (text variant, checkbox
// shape+symbol, date format). Grouping is top-level and typed
// (comb / choice / table); a group's `format` is its subtype (choice
// single/multiple; table classic/expandable/checkbox_matrix). Author guidance
// lives on the item itself as `description` (help text); fields/groups also
// carry an optional `placeholder` and a `required` flag.
//
// v4 -> v5: a table carries an explicit `orientation` ("col" | "row", default
// "col") naming its DRIVING axis — the one axis that holds data types. The other
// axis holds plain string labels only ("Single-Axis Data Type" rule), so cells
// never carry conflicting types. checkbox_matrix is exempt (always all-checkbox).

export const SCHEMA_VERSION = 5;

// Canonical browser-autofill vocabulary (Field.autofill). A curated subset of the
// WHATWG HTML `autocomplete` tokens covering the common personal-data fields a
// form asks for — the only values a browser can autofill from a saved profile.
// This is the source of truth; `schemas.py`'s AUTOFILL_TOKENS mirrors it (same
// hand-maintained parity as FieldType), and the extraction LLM must choose from it.
export const AUTOFILL_TOKENS = [
  "name",
  "given-name",
  "additional-name",
  "family-name",
  "honorific-prefix",
  "email",
  "tel",
  "tel-national",
  "street-address",
  "address-line1",
  "address-line2",
  "address-level1", // region / voivodeship / state
  "address-level2", // city / locality
  "postal-code",
  "country", // ISO country code
  "country-name",
  "organization",
  "organization-title",
  "bday",
  "sex",
] as const;

export type AutofillToken = (typeof AUTOFILL_TOKENS)[number];

// How a signature field is expected to be signed — a bounded, label-ONLY axis
// (no filler data, no behavior). "appearance": an in-app drawn/typed/uploaded
// signature image (the default when absent). "external": produced OUTSIDE the app
// — printed and signed by hand, or applied by a certified/qualified e-signature
// provider; in fill mode the field is read-only and the filler is reminded to sign
// it after downloading. (Legacy "wet"/"certified" both fold into "external" via
// normalizeSchema.) Source of truth; `schemas.py`'s SIGNING_REQUIREMENTS frozenset
// mirrors it (same hand-maintained parity as AUTOFILL_TOKENS).
export const SIGNING_REQUIREMENTS = ["appearance", "external"] as const;

export type SigningRequirement = (typeof SIGNING_REQUIREMENTS)[number];

// ─── Fields ────────────────────────────────────────────────────────────────

// The four fillable field types (output of the cell-identification agent).
export type FieldType = "text" | "checkbox" | "date" | "signature";

// Tier-1 data primitives (the database-level abstraction behind a field).
// Optional/derived: compute with primitiveOf() rather than reading it directly.
export type Primitive = "string" | "number" | "boolean" | "date" | "file";

// Per-type formatting. Interpret by Field.type: text -> TextFormat,
// checkbox -> CheckboxFormat, date -> DateFormat, signature -> SignatureFormat.
export type TextVariant = "any" | "number" | "currency" | "multiline";
// The 9-point anchor for a single-line text value inside its box. Absent =>
// DEFAULT_TEXT_ANCHOR ("middle-left": vertically centered, flush left). Source of
// truth; schemas.py's TextAnchor enum + templateSchema.ts's TEXT_ANCHORS mirror it
// (same hand-maintained parity as SIGNING_REQUIREMENTS).
export const TEXT_ANCHORS = [
  "top-left",
  "top-center",
  "top-right",
  "middle-left",
  "middle-center",
  "middle-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const;
export type TextAnchor = (typeof TEXT_ANCHORS)[number];
export interface TextFormat {
  variant: TextVariant;
  // Rendered baseline font size in PDF points. Optional/nullable: absent/null =>
  // DEFAULT_FONT_SIZE. The renderer sizes text at this value (NOT the box height)
  // and shrinks it horizontally to fit the box width, never below MIN_FONT_SIZE.
  font_size?: number | null;
  // 9-point placement of the text within the box (see TEXT_ANCHORS). Optional/
  // additive: absent => DEFAULT_TEXT_ANCHOR.
  text_anchor?: TextAnchor;
  // Force the filler's entry to BLOCK CAPITALS — the paper-form "please write in
  // capital letters" convention. Optional/additive: absent => false. Applied at
  // the stamp/preview boundary (fillMarks) and shown live via CSS on the input.
  uppercase?: boolean;
}
export type CheckboxShape = "square" | "round";
export interface CheckboxFormat {
  shape: CheckboxShape;
  // The glyph stamped into a ticked box. Defaults to "x".
  symbol: string;
  // Rendered size of the mark glyph in PDF points, mirroring TextFormat.font_size:
  // absent/null => auto-fit the mark to the box (the historical behaviour). When
  // set, the mark (vector ✓/✗/■ or a custom glyph) is drawn at this point size,
  // centered and clamped so it never overflows the box. Optional/additive.
  font_size?: number | null;
}
// A signature is stamped as an image (drawn / uploaded / typed-cursive PNG). The
// only formatting today is `scale`: a 0<s≤1 multiplier applied on top of the
// aspect-preserved fit-to-box, so the author can shrink the mark within its box.
// Absent/null => 1 (fill the box). Optional/additive — a signature field with no
// format renders exactly as before.
export interface SignatureFormat {
  scale?: number | null;
  // 9-point placement of the (aspect-preserved, `scale`-shrunk) stamped image
  // within its box (see TEXT_ANCHORS). Optional/additive: absent =>
  // DEFAULT_SIGNATURE_ANCHOR ("middle-center"), i.e. the historical centered
  // placement — so a signature field with no anchor renders exactly as before.
  text_anchor?: TextAnchor;
}
export interface DateFormat {
  // Printed order tokens, e.g. "DD/MM/YYYY". See DATE_FORMATS for the options.
  date_format: string;
  // Rendered baseline font size in PDF points, mirroring TextFormat.font_size:
  // absent/null => DEFAULT_FONT_SIZE. Optional/additive.
  font_size?: number | null;
  // 9-point placement of the formatted date within the box (see TEXT_ANCHORS).
  // Optional/additive: absent => DEFAULT_TEXT_ANCHOR.
  text_anchor?: TextAnchor;
}
export type FieldFormat = TextFormat | CheckboxFormat | DateFormat | SignatureFormat;

// Selectable options for a standalone date field's format dropdown.
export const DATE_FORMATS = [
  "DD/MM/YYYY",
  "MM/DD/YYYY",
  "YYYY-MM-DD",
  "DD.MM.YYYY",
  "DD-MM-YYYY",
] as const;

// A per-character slot inside a `comb` field. Percent, top-left.
export interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Field {
  id: string; // persistent uuid
  label: string;
  type: FieldType;
  // Nested per-type formatting. Optional/additive: when absent, defaults apply
  // (text -> "any", checkbox -> square/"x", date -> default format).
  format?: FieldFormat;
  // Tier-1 primitive. Optional/derived: when absent, derive via primitiveOf().
  primitive?: Primitive;
  page: number;
  section_id: string | null;
  // Box geometry as percent of the page image (top-left origin).
  xpct: number;
  ypct: number;
  wpct: number;
  hpct: number;
  // Present only for multi-cell records (dates, PESEL/SSN, postal codes).
  cells?: Cell[];
  // Id of the group this field belongs to, or null/undefined if ungrouped.
  group?: string | null;
  // Explicit flow order within a page (assigned when an owner reorders the
  // field-properties layer panel). Absent => fall back to reading-order
  // geometry, so legacy templates are unaffected. See flowOrder.ts.
  order?: number;
  // Author guidance + input hints. All optional/additive (legacy templates omit
  // them). `description` is help text (tooltip in Classic, sub-heading in
  // Story); `placeholder` seeds the empty input; `required` flags a must-fill.
  description?: string;
  placeholder?: string;
  required?: boolean;
  // Native browser-autofill hint: a WHATWG HTML `autocomplete` token (see
  // AUTOFILL_TOKENS) that lets Chrome/Safari offer saved-profile autofill on
  // common personal-data fields (name/email/address). Optional/additive; absent
  // for form-specific values (PESEL/NIP/case numbers) that have no profile datum.
  // Emitted by the extraction LLM, sanitized against AUTOFILL_TOKENS at the
  // assemble boundary, and author-overridable in the editor.
  autofill?: string;
  // Signature-only, label-ONLY signing expectation (see SIGNING_REQUIREMENTS).
  // Optional/additive: absent => "appearance". Author-set in the editor; surfaced
  // to the filler as guidance text only — no behavior is wired to it.
  signing_requirement?: SigningRequirement;
}

// ─── Groups ──────────────────────────────────────────────────────────────────

// Tier 3 — relational groups (output of the grouping agent). Each kind carries
// a formatting subtype: comb via cell_type/date_format; choice and table via
// the `format` discriminator.
export type GroupKind = "comb" | "choice" | "table";

export type ChoiceFormat = "single" | "multiple";
export type TableFormat = "classic" | "expandable" | "checkbox_matrix";

export interface Group {
  id: string; // persistent uuid
  kind: GroupKind;
  // Subtype. choice: "single" | "multiple". table: "classic" | "expandable" |
  // "checkbox_matrix". Absent on comb (comb uses cell_type/date_format).
  format?: ChoiceFormat | TableFormat;
  label: string;
  page: number;
  members: string[]; // Field.id[]
  // comb: whether each cell is a digit, any character, or part of a date. A
  // "date" comb also carries date_format: one letter per cell in printed order
  // (D=day, M=month, Y=year), e.g. "DDMMYYYY".
  cell_type?: "integer" | "char" | "date";
  date_format?: string;
  // table: which axis DRIVES data types — "col" (columns hold the types, rows
  // are labels) or "row" (rows hold the types, columns are labels). Absent =>
  // "col" (the legacy/effective default). The non-driving axis is label-only.
  orientation?: "col" | "row";
  // table: matrix dimensions.
  rows?: number;
  cols?: number;
  // table: printed header-row text (length = cols) and left-column label
  // text (length = rows). Optional/additive: legacy templates omit them.
  header_cols?: string[];
  header_rows?: string[];
  // table: authoritative per-cell placement reconstructed in the pipeline
  // (rows x cols of Field.id, or null for an empty cell). The single source of
  // truth for layout; falls back to geometry.
  grid?: (string | null)[][];
  // Explicit flow order within a page (see Field.order). Absent => geometry.
  order?: number;
  // Author guidance + input hints (see Field). All optional/additive.
  description?: string;
  placeholder?: string;
  required?: boolean;
}

// ─── Derivations / helpers ───────────────────────────────────────────────────

// Derive a field's Tier-1 primitive when it is absent (legacy/partial schemas).
export function primitiveOf(field: Pick<Field, "type" | "format" | "primitive">): Primitive {
  if (field.primitive) return field.primitive;
  switch (field.type) {
    case "checkbox":
      return "boolean";
    case "signature":
      return "file";
    case "date":
      return "date";
    case "text":
    default: {
      const v = (field.format as TextFormat | undefined)?.variant;
      return v === "number" || v === "currency" ? "number" : "string";
    }
  }
}

// A text field's variant, defaulting to "any".
export function textVariantOf(field: Pick<Field, "type" | "format">): TextVariant {
  if (field.type !== "text") return "any";
  return (field.format as TextFormat | undefined)?.variant ?? "any";
}

// Single-line text rendering defaults (see TextFormat). font size is in PDF
// points; the renderer never scales text to the box height — it starts at the
// field's font_size (or DEFAULT_FONT_SIZE) and shrinks horizontally to fit,
// never below MIN_FONT_SIZE.
export const DEFAULT_FONT_SIZE = 14;
// Default starting size for a multi-line field (smaller than single-line: paragraphs
// pack more text, so a 12pt start fits more before the vertical auto-shrink kicks in).
export const MULTILINE_DEFAULT_FONT_SIZE = 12;
export const MIN_FONT_SIZE = 6;
// Ceiling for an author-set single-line size; mirrors MAX_FONT_SIZE in schemas.py
// and templateSchema.ts (the write gates). The editor clamps to [MIN, MAX].
export const MAX_FONT_SIZE = 96;
export const DEFAULT_TEXT_ANCHOR: TextAnchor = "middle-left";
// Signatures default to centered placement (not middle-left) so an anchor-less
// signature field keeps the historical fit-to-box-then-center rendering.
export const DEFAULT_SIGNATURE_ANCHOR: TextAnchor = "middle-center";

// Preset sizes offered in the SizeField dropdown (an "Auto" row is prepended by
// the control). Common typographic point sizes for text/date/checkbox-mark; a
// short percent ladder for the signature scale.
export const PT_PRESETS = [8, 10, 12, 14, 18, 24];
export const SIGNATURE_PCT_PRESETS = [50, 75, 100];

// A text field's font size in points. An explicit font_size always wins; when
// absent, single-line defaults to DEFAULT_FONT_SIZE and multi-line to the smaller
// MULTILINE_DEFAULT_FONT_SIZE.
export function textFontSizeOf(field: Pick<Field, "type" | "format">): number {
  if (field.type !== "text") return DEFAULT_FONT_SIZE;
  const f = field.format as TextFormat | undefined;
  if (f?.font_size != null) return f.font_size;
  return f?.variant === "multiline" ? MULTILINE_DEFAULT_FONT_SIZE : DEFAULT_FONT_SIZE;
}

// Whether the author pinned an explicit font size (vs leaving it on the default).
// For multi-line, an explicit size is treated as fixed (rendered exactly, no
// vertical auto-shrink); a blank size auto-fits the text into the box.
export function hasExplicitFontSize(field: Pick<Field, "type" | "format">): boolean {
  if (field.type !== "text") return false;
  return (field.format as TextFormat | undefined)?.font_size != null;
}

// A text field's 9-point anchor. Defaults to DEFAULT_TEXT_ANCHOR ("middle-left")
// for single-line text, but to "top-left" for a multi-line field (long-form text
// fills a tall box from the top). An explicit text_anchor always wins.
export function textAnchorOf(field: Pick<Field, "type" | "format">): TextAnchor {
  if (field.type !== "text") return DEFAULT_TEXT_ANCHOR;
  const f = field.format as TextFormat | undefined;
  if (f?.text_anchor) return f.text_anchor;
  return f?.variant === "multiline" ? "top-left" : DEFAULT_TEXT_ANCHOR;
}

// Whether a text field forces block capitals. False for any non-text field.
export function textUppercaseOf(field: Pick<Field, "type" | "format">): boolean {
  if (field.type !== "text") return false;
  return (field.format as TextFormat | undefined)?.uppercase ?? false;
}

// Whether a text field holds long-form multi-line text — rendered as a growing
// <textarea> in the filler and word-wrapped + vertically auto-shrunk (not
// horizontally) when stamped. False for any non-text field.
export function textMultilineOf(field: Pick<Field, "type" | "format">): boolean {
  return textVariantOf(field) === "multiline";
}

// A text field's full format with variant + anchor defaulted and font_size kept
// as-is (null when unset, so the editor shows "Default"). The editor commits a
// full format because updateField replaces `format` wholesale — spreading this
// preserves the other knobs when one changes.
export function textFormatOf(field: Pick<Field, "type" | "format">): TextFormat {
  const f = field.format as TextFormat | undefined;
  const variant = (field.type === "text" ? f?.variant : undefined) ?? "any";
  return {
    variant,
    font_size: f?.font_size ?? null,
    text_anchor: f?.text_anchor ?? (variant === "multiline" ? "top-left" : DEFAULT_TEXT_ANCHOR),
    uppercase: f?.uppercase ?? false,
  };
}

// The mark stamped inside a ticked checkbox when none is specified.
export const DEFAULT_CHECKBOX_SYMBOL = "✗";

// A checkbox field's shape + symbol, with defaults (square, "✗"). font_size is
// kept as-is (null when unset, so the editor shows "Default" / auto-fit).
export function checkboxFormatOf(field: Pick<Field, "format">): CheckboxFormat {
  const f = field.format as CheckboxFormat | undefined;
  return {
    shape: f?.shape ?? "square",
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty-string symbol is treated as unset; fall back to the default glyph
    symbol: f?.symbol || DEFAULT_CHECKBOX_SYMBOL,
    font_size: f?.font_size ?? null,
  };
}

// A checkbox mark's explicit point size, or null when unset (auto-fit to box).
// Render paths that support explicit sizing read this; a null means "use the
// historical box-relative auto size".
export function checkboxFontSizeOf(field: Pick<Field, "type" | "format">): number | null {
  if (field.type !== "checkbox") return null;
  return (field.format as CheckboxFormat | undefined)?.font_size ?? null;
}

// Smallest signature scale the size control allows (25% of the fit-to-box size);
// mirrored by SIGNATURE_SCALE_MIN in schemas.py's bounds check.
export const SIGNATURE_SCALE_MIN = 0.25;

// A signature field's full format with scale kept as-is (null when unset, so the
// editor shows "100%"). Like textFormatOf, the editor commits a full format
// because updateField replaces `format` wholesale.
export function signatureFormatOf(field: Pick<Field, "format">): SignatureFormat {
  const f = field.format as SignatureFormat | undefined;
  return { scale: f?.scale ?? null, text_anchor: f?.text_anchor ?? DEFAULT_SIGNATURE_ANCHOR };
}

// A signature field's 9-point image placement, defaulting to
// DEFAULT_SIGNATURE_ANCHOR ("middle-center" — the historical centered stamp).
export function signatureAnchorOf(field: Pick<Field, "type" | "format">): TextAnchor {
  if (field.type !== "signature") return DEFAULT_SIGNATURE_ANCHOR;
  return (field.format as SignatureFormat | undefined)?.text_anchor ?? DEFAULT_SIGNATURE_ANCHOR;
}

// A signature field's resolved image scale: the explicit 0<s≤1 multiplier, or 1
// when unset. Clamped to [SIGNATURE_SCALE_MIN, 1] so a bad value never blows up
// or hides the mark. Used by every render path that stamps the signature image.
export function signatureScaleOf(field: Pick<Field, "type" | "format">): number {
  if (field.type !== "signature") return 1;
  const s = (field.format as SignatureFormat | undefined)?.scale;
  if (s == null || !Number.isFinite(s)) return 1;
  return Math.min(1, Math.max(SIGNATURE_SCALE_MIN, s));
}

// A date field's printed format, defaulting to the first DATE_FORMATS option.
export function dateFormatOf(field: Pick<Field, "format">): string {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty-string date_format is treated as unset; fall back to the default format
  return (field.format as DateFormat | undefined)?.date_format || DATE_FORMATS[0];
}

// A date field's rendered font size in points. An explicit font_size always
// wins; when absent, defaults to DEFAULT_FONT_SIZE. Mirrors textFontSizeOf.
export function dateFontSizeOf(field: Pick<Field, "type" | "format">): number {
  if (field.type !== "date") return DEFAULT_FONT_SIZE;
  return (field.format as DateFormat | undefined)?.font_size ?? DEFAULT_FONT_SIZE;
}

// A date field's 9-point anchor, defaulting to DEFAULT_TEXT_ANCHOR
// ("middle-left"). Mirrors textAnchorOf.
export function dateAnchorOf(field: Pick<Field, "type" | "format">): TextAnchor {
  if (field.type !== "date") return DEFAULT_TEXT_ANCHOR;
  return (field.format as DateFormat | undefined)?.text_anchor ?? DEFAULT_TEXT_ANCHOR;
}

// A date field's full format with date_format defaulted and font_size kept as-is
// (null when unset, so the editor shows "Default"). Like textFormatOf, the editor
// commits a full format because updateField replaces `format` wholesale.
export function dateFormatFullOf(field: Pick<Field, "format">): DateFormat {
  const f = field.format as DateFormat | undefined;
  return {
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty-string date_format is treated as unset; fall back to the default format
    date_format: f?.date_format || DATE_FORMATS[0],
    font_size: f?.font_size ?? null,
    text_anchor: f?.text_anchor ?? DEFAULT_TEXT_ANCHOR,
  };
}

// A single-cell field's rendered font size / anchor, dispatched by type: date
// reads its DateFormat, everything else its TextFormat (default for signature).
// Used by every render path that stamps a lone text-or-date value into one box.
export function fieldFontSizeOf(field: Pick<Field, "type" | "format">): number {
  return field.type === "date" ? dateFontSizeOf(field) : textFontSizeOf(field);
}
export function fieldAnchorOf(field: Pick<Field, "type" | "format">): TextAnchor {
  if (field.type === "date") return dateAnchorOf(field);
  if (field.type === "signature") return signatureAnchorOf(field);
  return textAnchorOf(field);
}

// Whether a lone text-or-date field is left on Auto (no pinned font size) — the
// dispatched twin of fieldFontSizeOf. Auto fields size from the box height; pinned
// fields render at their exact size. Non-text/date fields are never "text Auto".
export function fieldIsAutoFontSize(field: Pick<Field, "type" | "format">): boolean {
  if (field.type === "date") {
    return (field.format as DateFormat | undefined)?.font_size == null;
  }
  return field.type === "text" && !hasExplicitFontSize(field);
}

// A group's subtype with legacy fallbacks: table -> "classic", choice ->
// "single". Comb returns undefined (it has no `format`).
export function groupFormatOf(
  group: Pick<Group, "kind" | "format">,
): ChoiceFormat | TableFormat | undefined {
  if (group.kind === "table") return group.format ?? "classic";
  if (group.kind === "choice") return group.format ?? "single";
  return undefined;
}

// A table's driving axis (the one that carries data types), defaulting to "col".
// The label axis is the other one. Meaningless for non-table groups (returns the
// default), so guard on kind === "table" at the call site.
export type Axis = "col" | "row";
export function drivingAxis(group: Pick<Group, "orientation">): Axis {
  return group.orientation === "row" ? "row" : "col";
}
export function labelAxis(group: Pick<Group, "orientation">): Axis {
  return drivingAxis(group) === "col" ? "row" : "col";
}

// The effective field type a member should render/stamp as, accounting for a
// group that overwrites its members' type (comb -> text cells; choice and
// checkbox_matrix tables -> checkbox). Falls back to the field's own type.
export function effectiveMemberType(
  group: Pick<Group, "kind" | "format"> | undefined,
  field: Pick<Field, "type">,
): FieldType {
  if (!group) return field.type;
  if (group.kind === "comb") return "text";
  if (group.kind === "choice") return "checkbox";
  // kind is narrowed to "table" here (comb/choice handled above); groupFormatOf
  // only yields "checkbox_matrix" for tables, so no explicit kind guard is needed.
  if (groupFormatOf(group) === "checkbox_matrix") return "checkbox";
  return field.type;
}

// Rewrite member fields in place to satisfy the group's enforced type. Returns
// the patched members (new objects) so callers can commit them. Comb leaves the
// underlying type "text" but defers cell rendering to the group; choice and
// checkbox_matrix coerce members to checkbox with default formatting.
export function enforceMemberTypes<T extends Field>(
  group: Pick<Group, "kind" | "format">,
  members: T[],
): T[] {
  const target = effectiveMemberType(group, { type: "text" });
  if (group.kind === "comb") {
    // Comb members stay text; clear any stale checkbox/date format.
    return members.map((m) =>
      m.type === "text" && m.format === undefined ? m : { ...m, type: "text", format: undefined },
    );
  }
  if (target === "checkbox") {
    return members.map((m) =>
      m.type === "checkbox" ? m : { ...m, type: "checkbox", format: checkboxFormatOf(m) },
    );
  }
  return members;
}

// ─── Pages / schema ──────────────────────────────────────────────────────────

export interface Section {
  id: string;
  title: string;
  // Author guidance + input hints (see Field). All optional/additive.
  description?: string;
  placeholder?: string;
  required?: boolean;
}

export interface PageInfo {
  page: number;
  width: number; // preview image pixel width
  height: number; // preview image pixel height
  image: string; // Supabase Storage URL of the page preview PNG
  sections: Section[];
  degraded?: boolean; // true = boxes detected but not labeled; fields shipped "(unlabeled)"
}

// The full parse result, stored as templates.schema_json.
export interface TemplateSchema {
  version?: number; // SCHEMA_VERSION; absent => legacy (incompatible) template
  pages: PageInfo[];
  fields: Field[];
  groups: Group[];
}

// A field's box as a percent rectangle (top-left origin).
export interface Pct {
  xpct: number;
  ypct: number;
  wpct: number;
  hpct: number;
}

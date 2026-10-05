// Pure date helpers shared by the date picker (DatePicker.tsx) and the stamping
// core (fillMarks.ts). Local-time only; never round-trips through UTC. No React,
// no DOM: this module is part of FILL_CORE_FILES (eslint.config.mjs), so the
// Node-side fills (@fenfill/mcp, the worker-free agent path) can bundle it.
//
// Stored date values are ISO `yyyy-mm-dd`; a field's `date_format` (e.g.
// "DD/MM/YYYY", or a comb's separator-less "DDMMYYYY") governs only display and
// the PDF stamp.

export type YMD = { y: number; m: number; d: number }; // m is 1-12
export type DateRole = "D" | "M" | "Y";

export function parseISO(iso: string): YMD | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

export function toISO({ y, m, d }: YMD): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Splits a format string into consecutive same-role letter runs (D+/M+/Y+) plus
// any literal separator runs between them, e.g. "DD/MM/YYYY" -> D,/,M,/,Y runs.
export function dateFormatTokens(fmt: string): { order: DateRole[]; lens: number[]; sep: string } {
  const runs = fmt.match(/D+|M+|Y+|[^DMY]+/g) ?? [];
  const order: DateRole[] = [];
  const lens: number[] = [];
  let sep = "";
  for (const run of runs) {
    const c = run[0];
    if (c === "D" || c === "M" || c === "Y") {
      order.push(c);
      lens.push(run.length);
    } else if (!sep) {
      sep = run[0];
    }
  }
  return { order, lens, sep: sep || "/" };
}

// Renders a date per the format's role order + digit widths + separator. A
// 2-digit year role always prints/parses as 20xx — mirrors the existing
// date-comb convention in SidebarFields.tsx (no 19xx pivot).
export function formatYMD(ymd: YMD, fmt: string): string {
  const { order, lens, sep } = dateFormatTokens(fmt);
  const pad = (n: number, len: number) => String(n).padStart(len, "0");
  return order
    .map((role, i) => {
      const len = lens[i];
      if (role === "Y") return len < 4 ? pad(ymd.y % 100, len) : pad(ymd.y, len);
      if (role === "M") return pad(ymd.m, len);
      return pad(ymd.d, len);
    })
    .join(sep);
}

// Digits-only, order-aware parse — lenient about literal separators (accepts
// "5/3/2024", "05.03.2024", "05032024" alike) since the format's job is to
// disambiguate ORDER, not to police punctuation. Returns null until every
// digit group implied by `fmt` is filled and the result is a real calendar date.
export function parseTyped(input: string, fmt: string): YMD | null {
  const { order, lens } = dateFormatTokens(fmt);
  const digits = input.replace(/\D/g, "");
  const total = lens.reduce((a, b) => a + b, 0);
  if (digits.length !== total) return null;
  const parts: Record<DateRole, number> = { D: 0, M: 0, Y: 0 };
  let idx = 0;
  for (let i = 0; i < order.length; i++) {
    const len = lens[i];
    parts[order[i]] = Number(digits.slice(idx, idx + len));
    idx += len;
  }
  const yLen = lens[order.indexOf("Y")] ?? 4;
  const y = yLen < 4 ? 2000 + (parts.Y % 100) : parts.Y;
  const { M: m, D: d } = parts;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return { y, m, d };
}

// The stamp boundary: an ISO value prints in `fmt`; anything else (legacy or
// free-typed) passes through unchanged.
export function formatISOAs(value: string, fmt: string): string {
  const ymd = parseISO(value);
  return ymd ? formatYMD(ymd, fmt) : value;
}

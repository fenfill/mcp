// 1-based page specs ("1-3,5"), parsed the way /v1 parses them
// (v1_ingest.parse_page_spec): comma-separated numbers and low-high ranges,
// spaces allowed, overlaps merged, result sorted and de-duplicated.

import { ToolError } from "./errors.js";

const ITEM = /^\s*([0-9]{1,6})\s*(?:-\s*([0-9]{1,6})\s*)?$/;
const MAX_SPEC_LEN = 2000;
const MAX_PAGES = 100_000;

export function parsePageSpec(spec: string, pageCount: number | null = null): number[] {
  const bad = (msg: string) =>
    new ToolError("invalid_request", msg, {
      hint: 'Pass pages like "1-3,5": 1-based page numbers and ranges, comma-separated.',
    });
  if (spec.length > MAX_SPEC_LEN) throw bad("pages is too long.");
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const m = ITEM.exec(part);
    if (!m) throw bad('pages must look like "1-3,5".');
    const first = Number(m[1]);
    const last = m[2] ? Number(m[2]) : first;
    if (first < 1) throw bad("Page numbers start at 1.");
    if (last < first) throw bad("A page range must run low to high (e.g. 2-4).");
    if (pageCount != null && last > pageCount) {
      throw bad(`The PDF has ${String(pageCount)} pages; page ${String(last)} is out of range.`);
    }
    if (last - first + out.size > MAX_PAGES) throw bad("pages selects too many pages.");
    for (let p = first; p <= last; p++) out.add(p);
  }
  return [...out].sort((a, b) => a - b);
}

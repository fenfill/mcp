// Split a string into maximal consecutive runs that map to the same value under
// `pick` (evaluated per Unicode code point). stampPdf uses this to group a value's
// characters by which embedded face renders them — Inter (brand primary) where it
// has the glyph, DejaVuSans as the broad-Unicode fallback — so a mixed-script value
// (e.g. Latin + Cyrillic + Hebrew) draws every glyph instead of tofu boxes.
//
// Pure and font-agnostic (no pdf-lib) so it's unit-testable and safe to import
// anywhere. Iterates by code point (`Array.from`) so astral-plane characters are
// treated as single units, not split across their surrogate halves.
export function splitByCoverage<T>(
  text: string,
  pick: (cp: number) => T,
): { key: T; text: string }[] {
  const runs: { key: T; text: string }[] = [];
  let current: { key: T; text: string } | undefined;
  for (const ch of Array.from(text)) {
    const key = pick(ch.codePointAt(0) ?? 0);
    // Extend the open run when the face is unchanged; else start a new one.
    // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- `current?.key` loses the null-narrowing TS needs for the `current.text` mutation below
    if (current !== undefined && current.key === key) {
      current.text += ch;
    } else {
      current = { key, text: ch };
      runs.push(current);
    }
  }
  return runs;
}

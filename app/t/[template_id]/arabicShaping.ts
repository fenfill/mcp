// Arabic contextual shaping for the stamp: maps each Arabic letter to its
// presentation form (isolated / final / initial / medial) and lam + alef to the
// mandatory lam-alef ligature, so the PDF draws joined script from plain code
// points. Pure and font-agnostic; runs on the LOGICAL text, before the line is
// wrapped and reordered (rtlStamp.ts), so a word's joining never depends on how
// the line is later split into face runs.
//
// The forms are Arabic Presentation Forms-B (FE70–FEFF) for the Arabic letters
// and Presentation Forms-A (FB50–FDFF) for the Persian ones (peh, tcheh, jeh,
// keheh, gaf, farsi yeh) and alef maksura's initial/medial. DejaVuSans (the
// stamp's fallback face) has a glyph for every one of them, and they are the
// very glyphs its own GSUB picks when a browser shapes the logical text, so the
// preview and the print draw the same outlines.
//
// Marks: combining marks (harakat, shadda, superscript alef, Quranic marks; any
// Mn/Me/Cf other than ZWNJ/ZWJ) are transparent: skipped when deciding how the
// letters around them join, and kept in place after their letter. Between lam
// and alef they move after the ligature. Not handled: letters outside the table
// (Urdu tteh, ddal, rreh, noon ghunna, heh goal, yeh barree and the rarer
// extended letters), which keep their nominal code point and so print
// isolated; and mark stacking/positioning, which is left to the face.

type Joining = "D" | "R" | "C" | "U" | "T";

// [isolated, final, initial, medial]; a right-joining letter has two forms.
const FORMS: ReadonlyMap<number, readonly number[]> = new Map<number, readonly number[]>([
  [0x0621, [0xfe80]], // hamza (non-joining)
  [0x0622, [0xfe81, 0xfe82]], // alef with madda above
  [0x0623, [0xfe83, 0xfe84]], // alef with hamza above
  [0x0624, [0xfe85, 0xfe86]], // waw with hamza above
  [0x0625, [0xfe87, 0xfe88]], // alef with hamza below
  [0x0626, [0xfe89, 0xfe8a, 0xfe8b, 0xfe8c]], // yeh with hamza above
  [0x0627, [0xfe8d, 0xfe8e]], // alef
  [0x0628, [0xfe8f, 0xfe90, 0xfe91, 0xfe92]], // beh
  [0x0629, [0xfe93, 0xfe94]], // teh marbuta
  [0x062a, [0xfe95, 0xfe96, 0xfe97, 0xfe98]], // teh
  [0x062b, [0xfe99, 0xfe9a, 0xfe9b, 0xfe9c]], // theh
  [0x062c, [0xfe9d, 0xfe9e, 0xfe9f, 0xfea0]], // jeem
  [0x062d, [0xfea1, 0xfea2, 0xfea3, 0xfea4]], // hah
  [0x062e, [0xfea5, 0xfea6, 0xfea7, 0xfea8]], // khah
  [0x062f, [0xfea9, 0xfeaa]], // dal
  [0x0630, [0xfeab, 0xfeac]], // thal
  [0x0631, [0xfead, 0xfeae]], // reh
  [0x0632, [0xfeaf, 0xfeb0]], // zain
  [0x0633, [0xfeb1, 0xfeb2, 0xfeb3, 0xfeb4]], // seen
  [0x0634, [0xfeb5, 0xfeb6, 0xfeb7, 0xfeb8]], // sheen
  [0x0635, [0xfeb9, 0xfeba, 0xfebb, 0xfebc]], // sad
  [0x0636, [0xfebd, 0xfebe, 0xfebf, 0xfec0]], // dad
  [0x0637, [0xfec1, 0xfec2, 0xfec3, 0xfec4]], // tah
  [0x0638, [0xfec5, 0xfec6, 0xfec7, 0xfec8]], // zah
  [0x0639, [0xfec9, 0xfeca, 0xfecb, 0xfecc]], // ain
  [0x063a, [0xfecd, 0xfece, 0xfecf, 0xfed0]], // ghain
  [0x0641, [0xfed1, 0xfed2, 0xfed3, 0xfed4]], // feh
  [0x0642, [0xfed5, 0xfed6, 0xfed7, 0xfed8]], // qaf
  [0x0643, [0xfed9, 0xfeda, 0xfedb, 0xfedc]], // kaf
  [0x0644, [0xfedd, 0xfede, 0xfedf, 0xfee0]], // lam
  [0x0645, [0xfee1, 0xfee2, 0xfee3, 0xfee4]], // meem
  [0x0646, [0xfee5, 0xfee6, 0xfee7, 0xfee8]], // noon
  [0x0647, [0xfee9, 0xfeea, 0xfeeb, 0xfeec]], // heh
  [0x0648, [0xfeed, 0xfeee]], // waw
  [0x0649, [0xfeef, 0xfef0, 0xfbe8, 0xfbe9]], // alef maksura (init/medi in Forms-A)
  [0x064a, [0xfef1, 0xfef2, 0xfef3, 0xfef4]], // yeh
  [0x067e, [0xfb56, 0xfb57, 0xfb58, 0xfb59]], // peh
  [0x0686, [0xfb7a, 0xfb7b, 0xfb7c, 0xfb7d]], // tcheh
  [0x0698, [0xfb8a, 0xfb8b]], // jeh
  [0x06a9, [0xfb8e, 0xfb8f, 0xfb90, 0xfb91]], // keheh
  [0x06af, [0xfb92, 0xfb93, 0xfb94, 0xfb95]], // gaf
  [0x06cc, [0xfbfc, 0xfbfd, 0xfbfe, 0xfbff]], // farsi yeh
]);

const LAM = 0x0644;
// Alef variant -> [isolated, final] lam-alef ligature.
const LAM_ALEF: ReadonlyMap<number, readonly [number, number]> = new Map([
  [0x0622, [0xfef5, 0xfef6] as const],
  [0x0623, [0xfef7, 0xfef8] as const],
  [0x0625, [0xfef9, 0xfefa] as const],
  [0x0627, [0xfefb, 0xfefc] as const],
]);

const TRANSPARENT = /[\p{Mn}\p{Me}\p{Cf}]/u;

/** The joining type (ArabicShaping.txt) of one code point, for the letters the
 *  table shapes: D dual-joining, R right-joining, C join-causing (tatweel,
 *  ZWJ), T transparent (marks), U non-joining (everything else, ZWNJ too). */
export function joiningType(cp: number): Joining {
  const forms = FORMS.get(cp);
  if (forms) return forms.length === 4 ? "D" : forms.length === 2 ? "R" : "U";
  if (cp === 0x0640 || cp === 0x200d) return "C";
  if (cp === 0x200c) return "U";
  return TRANSPARENT.test(String.fromCodePoint(cp)) ? "T" : "U";
}

const joinsLeft = (j: Joining | undefined) => j === "D" || j === "C";
const joinsRight = (j: Joining | undefined) => j === "D" || j === "R" || j === "C";

/** `text` with every tabled Arabic letter replaced by its contextual
 *  presentation form and each lam + alef by the lam-alef ligature. Text without
 *  a tabled letter comes back unchanged. */
export function shapeArabic(text: string): string {
  const cps = Array.from(text, (ch) => ch.codePointAt(0) ?? 0);
  if (!cps.some((cp) => FORMS.has(cp))) return text;
  const types = cps.map(joiningType);
  // The nearest non-transparent neighbour's index on each side (-1 = none).
  const prevOf = (i: number) => {
    let j = i - 1;
    while (j >= 0 && types[j] === "T") j--;
    return j;
  };
  const nextOf = (i: number) => {
    let j = i + 1;
    while (j < cps.length && types[j] === "T") j++;
    return j < cps.length ? j : -1;
  };

  const out: number[] = [];
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    const forms = FORMS.get(cp);
    if (!forms) {
      out.push(cp);
      continue;
    }
    const p = prevOf(i);
    const n = nextOf(i);
    const joinPrev = joinsRight(types[i]) && p >= 0 && joinsLeft(types[p]);

    // Lam followed (across marks) by an alef: one ligature, right-joining, then
    // the marks that sat between them.
    const lig = cp === LAM && n >= 0 ? LAM_ALEF.get(cps[n]) : undefined;
    if (lig) {
      out.push(joinPrev ? lig[1] : lig[0]);
      for (let k = i + 1; k < n; k++) out.push(cps[k]);
      i = n;
      continue;
    }

    const joinNext = joinsLeft(types[i]) && n >= 0 && joinsRight(types[n]);
    // [isolated, final, initial, medial]
    const form =
      forms.length === 4
        ? joinPrev
          ? joinNext
            ? 3
            : 1
          : joinNext
            ? 2
            : 0
        : joinPrev && forms.length === 2
          ? 1
          : 0;
    out.push(forms[form]);
  }
  return out.map((c) => String.fromCodePoint(c)).join("");
}

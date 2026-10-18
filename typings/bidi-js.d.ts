// bidi-js 1.0.3 ships no types: the part of its API the stamp uses
// (app/t/[template_id]/rtlStamp.ts). Indices are UTF-16 code units.
declare module "bidi-js" {
  export interface EmbeddingLevels {
    paragraphs: { start: number; end: number; level: number }[];
    levels: Uint8Array;
  }
  export interface Bidi {
    getEmbeddingLevels(text: string, direction?: "ltr" | "rtl" | "auto"): EmbeddingLevels;
    /** [start, end] (inclusive) ranges to reverse, in order. */
    getReorderSegments(
      text: string,
      levels: EmbeddingLevels,
      start?: number,
      end?: number,
    ): [number, number][];
    /** Index -> mirrored character, for the characters at an odd level. Takes
     *  the `levels` array itself (it indexes it), not the EmbeddingLevels. */
    getMirroredCharactersMap(
      text: string,
      levels: Uint8Array,
      start?: number,
      end?: number,
    ): Map<number, string>;
    getMirroredCharacter(ch: string): string | null;
    getBidiCharTypeName(ch: string): string;
  }
  export default function bidiFactory(): Bidi;
}

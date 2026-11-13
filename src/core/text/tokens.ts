/**
 * @fileoverview Token estimation for the embedder's fixed input signature.
 *
 * The LiteRT model only accepts inputs up to its signature length (512
 * tokens), and longer inputs fail outright, so text is sized by an estimated
 * token count rather than by characters. The estimate is deliberately
 * pessimistic: over-counting only makes chunks smaller, under-counting makes
 * embedding fail.
 *
 * Counting works on UTF-16 code units, exactly like the v0.5.0 PoC, because
 * chunk boundaries (and so stored chunks) depend on it.
 */

/** Inclusive UTF-16 ranges that cost about one token per character. */
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3000, 0x303f], // CJK symbols and punctuation
  [0x3040, 0x30ff], // Hiragana, Katakana
  [0x3400, 0x4dbf], // CJK unified ideographs extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xac00, 0xd7af], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xff00, 0xffef], // Halfwidth and fullwidth forms
];

/** Tokens charged per CJK character (slightly over one, to stay safe). */
const CJK_TOKENS_PER_CHAR = 1.2;

/** ASCII characters that fit in one token (Latin text, numbers, code). */
const ASCII_CHARS_PER_TOKEN = 3;

/**
 * Tokens charged per other UTF-16 code unit. Emoji and other symbols may fall
 * back to several byte tokens each; an emoji is two code units.
 */
const OTHER_TOKENS_PER_UNIT = 2;

function isCjk(code: number): boolean {
  return CJK_RANGES.some(([lo, hi]) => code >= lo && code <= hi);
}

/**
 * Estimates how many model tokens a string uses, erring on the high side.
 *
 * @param text Input text.
 * @return Estimated token count; 0 for an empty string.
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let ascii = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isCjk(code)) cjk++;
    else if (code <= 0x7f) ascii++;
  }
  const other = text.length - cjk - ascii;
  return Math.ceil(
    cjk * CJK_TOKENS_PER_CHAR +
      ascii / ASCII_CHARS_PER_TOKEN +
      other * OTHER_TOKENS_PER_UNIT,
  );
}

/**
 * Returns the longest prefix of a string whose estimated size fits a budget.
 *
 * Cuts on UTF-16 code units like the PoC, so a cut can land inside a
 * surrogate pair; the embedder tolerates the lone half.
 *
 * @param text Input text.
 * @param maxTokens Token budget for the prefix.
 * @return The input itself when it fits, otherwise its longest fitting prefix
 *     (possibly empty).
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

/**
 * @fileoverview Splits a search query into weighted keyword terms for the
 * keyword part of hybrid ranking.
 */

/** One keyword term and how much a match counts. */
export interface QueryTerm {
  /** Lowercased term. */
  t: string;
  /** Weight: 1 for a whole word, {@link SHINGLE_WEIGHT} for a shingle. */
  w: number;
}

/** Separators between words: whitespace and ASCII or CJK punctuation. */
const SEPARATORS = /[\s,，。、;；:：/|()（）"'「」]+/;

/** Words shorter than this (in UTF-16 code units) are ignored. */
const MIN_WORD_LENGTH = 2;

/**
 * Non-ASCII words longer than this also yield 2-character shingles, because
 * CJK text has no spaces between words.
 */
const SHINGLE_MIN_WORD_LENGTH = 4;

/** Weight of a 2-character shingle relative to a whole word. */
const SHINGLE_WEIGHT = 0.4;

/** Most terms kept per query. */
const MAX_TERMS = 24;

function isAscii(word: string): boolean {
  for (let i = 0; i < word.length; i++) {
    if (word.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

/**
 * Extracts keyword terms from a query, matching the v0.5.0 PoC.
 *
 * Every word of two or more characters is a term of weight 1. A non-ASCII
 * word longer than three characters also adds each 2-character shingle at
 * weight 0.4, so 「編譯失敗」 still matches text containing 「編譯」.
 *
 * @param query Raw query text.
 * @return Up to 24 distinct terms in first-seen order.
 */
export function queryTerms(query: string): QueryTerm[] {
  const terms = new Map<string, number>();
  for (const word of String(query).toLowerCase().trim().split(SEPARATORS)) {
    if (word.length < MIN_WORD_LENGTH) continue;
    terms.set(word, 1);
    if (isAscii(word) || word.length < SHINGLE_MIN_WORD_LENGTH) continue;
    for (let i = 0; i < word.length - 1; i++) {
      const shingle = word.slice(i, i + 2);
      if (!terms.has(shingle)) terms.set(shingle, SHINGLE_WEIGHT);
    }
  }
  return [...terms].slice(0, MAX_TERMS).map(([t, w]) => ({t, w}));
}

/**
 * @fileoverview Hybrid ranking for semantic search: chunk cosine max-pooled
 * per page, plus a keyword boost, a small recency boost and a penalty for
 * title-only history entries. Extracted from the v0.5.0 PoC
 * `VectorIndex.search`; the weights must stay identical to keep result order.
 */

import type {QueryTerm} from './query_terms';

/** Boost per term weight when the term is in the page title or URL. */
export const KEYWORD_TITLE_BOOST = 0.08;

/** Boost per term weight when the term is only in the matched chunk. */
export const KEYWORD_BODY_BOOST = 0.05;

/** Upper bound of the summed keyword boost. */
export const KEYWORD_BOOST_CAP = 0.24;

/** Recency boost for a page visited just now. */
export const RECENCY_BOOST = 0.03;

/** Time constant, in days, of the recency boost's exponential decay. */
export const RECENCY_DECAY_DAYS = 30;

/** Subtracted from history-only pages, which have just a title, no text. */
export const HISTORY_PENALTY = 0.04;

const MS_PER_DAY = 86_400_000;

/** One indexed chunk, as far as ranking needs it. */
export interface ChunkRow {
  /** URL of the page the chunk belongs to. */
  url: string;
}

/** Best-matching chunk of one page. */
export interface ChunkHit {
  /** Index of the chunk in the row list and the vector matrix. */
  row: number;
  /** Cosine similarity of that chunk to the query. */
  sem: number;
}

/** Page fields the ranking reads. */
export interface RankablePage {
  /** Page URL. */
  url: string;
  /** Page title. */
  title: string;
  /** Last visit time, ms since the epoch. */
  ts: number;
  /** Where the record came from, e.g. "page", "history", "clip". */
  source: string;
}

/** Final score of a page and the parts the UI shows. */
export interface PageScore {
  /** Ranking score: sem + kw + recency boost + history penalty. */
  score: number;
  /** Cosine similarity of the best chunk. */
  sem: number;
  /** Keyword boost after the cap. */
  kw: number;
}

/**
 * Finds each page's most similar chunk (max pooling).
 *
 * @param rows Chunk rows, in matrix order.
 * @param mat Row-major matrix of normalized chunk vectors, `dim` per row.
 * @param dim Vector dimension.
 * @param qvec Normalized query vector, at least `dim` long.
 * @param include Whether a page takes part (search filters); called once per
 *     URL.
 * @return Map from page URL to its best chunk. On a tie the earlier row wins.
 */
export function bestChunkPerPage(
  rows: readonly ChunkRow[],
  mat: Float32Array,
  dim: number,
  qvec: ArrayLike<number>,
  include: (url: string) => boolean,
): Map<string, ChunkHit> {
  const best = new Map<string, ChunkHit>();
  const included = new Map<string, boolean>();
  rows.forEach(({url}, row) => {
    let pass = included.get(url);
    if (pass === undefined) {
      pass = include(url);
      included.set(url, pass);
    }
    if (!pass) return;
    let sem = 0;
    const offset = row * dim;
    for (let j = 0; j < dim; j++) sem += mat[offset + j]! * qvec[j]!;
    const current = best.get(url);
    if (!current || sem > current.sem) best.set(url, {row, sem});
  });
  return best;
}

/**
 * Keyword boost: each term found in the title or URL adds 0.08 × its weight,
 * otherwise each term found in the matched chunk adds 0.05 × its weight;
 * the sum is capped at 0.24.
 *
 * @param terms Query terms from queryTerms.
 * @param page Page whose title and URL are searched.
 * @param snippet Text of the page's best chunk.
 * @return Boost in [0, 0.24].
 */
export function keywordBoost(
  terms: readonly QueryTerm[],
  page: Pick<RankablePage, 'title' | 'url'>,
  snippet: string,
): number {
  const hay = (page.title + '\n' + page.url).toLowerCase();
  const body = snippet.toLowerCase();
  let kw = 0;
  for (const {t, w} of terms) {
    if (hay.includes(t)) kw += KEYWORD_TITLE_BOOST * w;
    else if (body.includes(t)) kw += KEYWORD_BODY_BOOST * w;
  }
  return Math.min(kw, KEYWORD_BOOST_CAP);
}

/**
 * Recency boost: 0.03 for a page visited now, decaying exponentially with a
 * 30-day time constant.
 *
 * @param ts Last visit time, ms since the epoch.
 * @param now Current time, ms since the epoch.
 * @return Boost in (0, 0.03] for past visits.
 */
export function recencyBoost(ts: number, now: number): number {
  return (
    RECENCY_BOOST * Math.exp(-(now - ts) / MS_PER_DAY / RECENCY_DECAY_DAYS)
  );
}

/**
 * Scores one page from its best chunk.
 *
 * @param page Page being ranked.
 * @param sem Cosine similarity of the page's best chunk.
 * @param snippet Text of that chunk.
 * @param terms Query terms from queryTerms.
 * @param now Current time, ms since the epoch.
 * @return Score and its semantic and keyword parts.
 */
export function scorePage(
  page: RankablePage,
  sem: number,
  snippet: string,
  terms: readonly QueryTerm[],
  now: number,
): PageScore {
  const kw = keywordBoost(terms, page, snippet);
  const penalty = page.source === 'history' ? -HISTORY_PENALTY : 0;
  return {score: sem + kw + recencyBoost(page.ts, now) + penalty, sem, kw};
}

/**
 * Sorts by score, highest first (stable for equal scores), and keeps the top
 * `k`.
 *
 * @param items Scored items; not modified.
 * @param k Number of items to keep.
 * @return New array of at most `k` items.
 */
export function topByScore<T extends {score: number}>(
  items: readonly T[],
  k: number,
): T[] {
  return [...items].sort((a, b) => b.score - a.score).slice(0, k);
}

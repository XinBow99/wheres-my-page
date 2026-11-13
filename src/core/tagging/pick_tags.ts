/**
 * @fileoverview Multi-label auto-tagging rule: picks categories from the
 * similarity scores of a page against every category prototype.
 */

/** Similarity of a page to one category. */
export interface CategoryScore {
  /** Category id. */
  id: string;
  /** Cosine similarity to the category prototype. */
  s: number;
}

/** Thresholds of the auto-tagging rule. */
export interface TagOptions {
  /** Lowest score a picked category may have. */
  minScore: number;
  /** Categories within this distance of the best score are picked too. */
  margin: number;
  /** Most categories picked per page. */
  maxTags: number;
  /**
   * How far the best score must be above the mean of all scores; below this
   * the page fits no category in particular.
   */
  minLift: number;
}

/** v0.5.0 defaults, also the base that partial options are merged over. */
export const TAG_DEFAULTS: Readonly<TagOptions> = Object.freeze({
  minScore: 0.2,
  margin: 0.04,
  maxTags: 3,
  minLift: 0.03,
});

/** Digits kept in the score stored with an auto tag. */
const STORED_SCORE_DIGITS = 3;

/**
 * Picks categories for a page.
 *
 * Nothing is picked if the best score is below `minScore`, or (with more than
 * one category) less than `minLift` above the mean score. Otherwise every
 * category within `margin` of the best and at least `minScore` is picked, up
 * to `maxTags`.
 *
 * @param scores Scores against every category, in any order; not modified.
 * @param opts Thresholds; missing fields fall back to {@link TAG_DEFAULTS}.
 * @return Picked scores, best first.
 */
export function pickTags<T extends CategoryScore>(
  scores: readonly T[],
  opts: Partial<TagOptions> = TAG_DEFAULTS,
): T[] {
  const o = {...TAG_DEFAULTS, ...opts};
  const sorted = [...scores].sort((a, b) => b.s - a.s);
  const best = sorted[0];
  if (!best) return [];
  const top = best.s;
  const mean = sorted.reduce((sum, x) => sum + x.s, 0) / sorted.length;
  if (top < o.minScore) return [];
  if (sorted.length > 1 && top - mean < o.minLift) return [];
  const floor = Math.max(o.minScore, top - o.margin);
  return sorted.filter(x => x.s >= floor).slice(0, o.maxTags);
}

/**
 * Auto tags for a page. Categories the user tagged by hand or removed are
 * left to the user, so they are never auto-tagged.
 *
 * @param scores Scores against every category.
 * @param manual Category ids the user added to the page.
 * @param removed Category ids the user removed from the page.
 * @param opts Thresholds for {@link pickTags}.
 * @return Auto tags, best first, with scores rounded to 3 decimals as stored.
 */
export function autoTags(
  scores: readonly CategoryScore[],
  manual: readonly string[],
  removed: readonly string[],
  opts: Partial<TagOptions> = TAG_DEFAULTS,
): CategoryScore[] {
  const userDecided = new Set([...manual, ...removed]);
  return pickTags(scores, opts)
    .filter(x => !userDecided.has(x.id))
    .map(x => ({id: x.id, s: +x.s.toFixed(STORED_SCORE_DIGITS)}));
}

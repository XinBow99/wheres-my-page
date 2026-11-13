/**
 * @fileoverview Category prototypes: each category is represented by its
 * description's embedding plus the vectors of pages the user tagged with it
 * by hand, so manual tags teach the auto-tagger.
 */

import {dot, normalize} from '../search/vector_math';
import type {CategoryScore} from './pick_tags';

/** The description counts as this many example pages in a prototype. */
export const DESC_WEIGHT = 2;

/** Category fields a prototype is built from. */
export interface PrototypeCategory {
  /** Category id. */
  id: string;
  /** Embedding of the description; categories without one are skipped. */
  vec?: ArrayLike<number> | null;
}

/** Page fields a prototype is built from. */
export interface PrototypePage {
  /** Page vector (normalized mean of its chunks), if computed. */
  vec?: ArrayLike<number> | null;
  /** Category ids the user tagged the page with. */
  tagsManual?: readonly string[];
}

/** A category's prototype vector. */
export interface Prototype {
  /** Normalized prototype vector. */
  vec: Float32Array;
  /** Number of manually tagged pages folded in. */
  examples: number;
}

/**
 * Builds the prototype of every category that has a description vector.
 *
 * @param categories Categories, in display order.
 * @param pages All pages; manually tagged ones contribute their vector.
 * @param dim Vector dimension.
 * @return Map from category id to prototype, in `categories` order.
 */
export function buildPrototypes(
  categories: Iterable<PrototypeCategory>,
  pages: readonly PrototypePage[],
  dim: number,
): Map<string, Prototype> {
  const protos = new Map<string, Prototype>();
  for (const cat of categories) {
    const desc = cat.vec;
    if (!desc) continue;
    // Float32 accumulation, as in the PoC, so stored scores stay identical.
    const acc = new Float32Array(dim);
    for (let i = 0; i < dim; i++) acc[i] = desc[i]! * DESC_WEIGHT;
    let examples = 0;
    for (const page of pages) {
      const vec = page.vec;
      if (!vec || !page.tagsManual?.includes(cat.id)) continue;
      for (let i = 0; i < dim; i++) acc[i]! += vec[i]!;
      examples++;
    }
    protos.set(cat.id, {vec: normalize(acc), examples});
  }
  return protos;
}

/**
 * Scores a page vector against every prototype.
 *
 * @param vec Normalized page vector.
 * @param protos Prototypes from {@link buildPrototypes}.
 * @param dim Vector dimension.
 * @return One score per prototype, highest first.
 */
export function scoreCategories(
  vec: ArrayLike<number>,
  protos: ReadonlyMap<string, Prototype>,
  dim: number,
): CategoryScore[] {
  const out: CategoryScore[] = [];
  for (const [id, proto] of protos) out.push({id, s: dot(vec, proto.vec, dim)});
  return out.sort((a, b) => b.s - a.s);
}

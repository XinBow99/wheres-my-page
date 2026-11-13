/**
 * @fileoverview Typed access to the v0.5.0 PoC golden fixtures in
 * test/fixtures/poc/ (regenerate with `npm run golden`).
 *
 * Fixtures are read as text and parsed with JSON.parse: truncated emoji leave
 * lone UTF-16 surrogates in the strings, which JSON.parse accepts but Vite's
 * JSON import rejects.
 */

import {readFileSync} from 'node:fs';

/** One corpus entry of text.json with the PoC chunk.js outputs. */
export interface TextGoldenCase {
  /** Corpus entry name. */
  name: string;
  /** Input text. */
  text: string;
  /** PoC estimateTokens(text). */
  estimateTokens: number;
  /** PoC truncateToTokens(text, 40). */
  truncate40: string;
  /** PoC chunkText(text) with default options. */
  chunks: string[];
  /** PoC chunkText(text, {maxTokens: 80, overlapTokens: 20, maxChunks: 8}). */
  chunksSmall: string[];
}

/** Contents of text.json. */
export interface TextGolden {
  /** PoC TOKEN_BUDGET. */
  tokenBudget: number;
  /** One entry per corpus text. */
  cases: TextGoldenCase[];
}

/** A category score as the PoC wrote it. */
export interface GoldenScore {
  /** Category id. */
  id: string;
  /** Score. */
  s: number;
}

/** One pickTags case of math.json. */
export interface PickTagsCase {
  /** Input scores. */
  scores: GoldenScore[];
  /** PoC pickTags(scores). */
  defaults: GoldenScore[];
  /** PoC pickTags(scores, {minScore: 0.45}). */
  strict: GoldenScore[];
}

/** Contents of math.json: PoC store.js pure functions. */
export interface MathGolden {
  /** PoC TAG_DEFAULTS. */
  tagDefaults: Record<string, number>;
  /** Four seeded 8-dimensional input vectors. */
  vectors: number[][];
  /** PoC normalize(v) per input vector. */
  normalize: number[][];
  /** PoC normalize of a 4-dimensional zero vector. */
  normalizeZero: number[];
  /** PoC dot(v0, v1) and dot(v0, v1, 3). */
  dot: number[];
  /** PoC meanVec(vectors, 8). */
  meanVec: number[];
  /** PoC toDim(v2 as array, 4) and toDim(v3 as array, 8). */
  toDim: number[][];
  /** pickTags cases. */
  pickTags: PickTagsCase[];
  /** PoC queryTerms(q) per query. */
  queryTerms: Array<{q: string; terms: Array<{t: string; w: number}>}>;
}

/** A page record in the PoC v2 database. */
export interface GoldenPage {
  url: string;
  title: string;
  domain: string;
  source: string;
  ts: number;
  vec: number[];
  tagsManual: string[];
  tagsRemoved: string[];
  tagsAuto: GoldenScore[];
}

/** A chunk record in the PoC v2 database. */
export interface GoldenChunk {
  id: number;
  url: string;
  idx: number;
  text: string;
  vec: number[];
}

/** A category record in the PoC v2 database. */
export interface GoldenCategory {
  id: string;
  name: string;
  order: number;
  vec: number[] | null;
}

/** A search result as the PoC returned it (only the fields used here). */
export interface GoldenResult {
  url: string;
  snippet: string;
  score: number;
  sem: number;
  kw: number;
}

/** Contents of store.json: a PoC-written database plus query outputs. */
export interface StoreGolden {
  /** Frozen Date.now of the generator. */
  now: number;
  /** Vector dimension. */
  dim: number;
  /** IndexedDB dump. */
  db: {
    name: string;
    version: number;
    stores: {
      pages: GoldenPage[];
      chunks: GoldenChunk[];
      categories: GoldenCategory[];
    };
  };
  /** VectorIndex.search calls. */
  search: Array<{
    query: string;
    qvec: number[];
    opts: {k: number; sinceTs?: number; domain?: string; tag?: string};
    results: GoldenResult[];
  }>;
  /** VectorIndex.listCategories(). */
  categories: {categories: Array<{id: string; examples: number}>};
  /** VectorIndex.scoreCategories of the whisper page vector. */
  scoreWhisper: GoldenScore[];
}

/**
 * Reads and parses one fixture file.
 *
 * @param name File name under test/fixtures/poc/.
 * @return Parsed JSON.
 */
function readFixture(name: string): unknown {
  const url = new URL(`./fixtures/poc/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
}

/** PoC chunk.js golden outputs. */
export const textGolden = readFixture('text.json') as TextGolden;

/** PoC store.js pure-function golden outputs. */
export const mathGolden = readFixture('math.json') as MathGolden;

/** PoC VectorIndex golden database and outputs. */
export const storeGolden = readFixture('store.json') as StoreGolden;

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

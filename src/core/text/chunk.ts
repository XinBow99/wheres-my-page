/**
 * @fileoverview Splits page text into overlapping chunks that fit the
 * embedder's input signature.
 */

import {cleanText} from './preprocess';
import {estimateTokens, truncateToTokens} from './tokens';

/**
 * Token budget for one chunk body. The embedder takes 512 tokens; the rest is
 * left for the task prompt and the page title.
 */
export const TOKEN_BUDGET = 360;

/** Tokens repeated from the end of one chunk at the start of the next. */
const DEFAULT_OVERLAP_TOKENS = 50;

/** Most chunks kept per page; the rest of a very long page is dropped. */
const DEFAULT_MAX_CHUNKS = 32;

/** Options for {@link chunkText}; omitted fields use the defaults. */
export interface ChunkOptions {
  /** Token budget per chunk. Defaults to {@link TOKEN_BUDGET}. */
  maxTokens?: number;
  /** Tokens of overlap between neighbouring chunks. Defaults to 50. */
  overlapTokens?: number;
  /** Maximum number of chunks returned. Defaults to 32. */
  maxChunks?: number;
}

/**
 * Length, in UTF-16 code units, of the overlap taken from the end of a chunk:
 * the longest suffix (counted in code points from the end) that fits the
 * overlap budget.
 *
 * @param text Chunk or piece the overlap is taken from.
 * @param overlapTokens Token budget for the overlap.
 */
function overlapLength(text: string, overlapTokens: number): number {
  const reversed = [...text].reverse().join('');
  return truncateToTokens(reversed, overlapTokens).length;
}

/**
 * Splits text into paragraphs, hard-splitting any paragraph over budget into
 * overlapping pieces.
 *
 * @param clean Text already normalized by cleanText.
 * @param maxTokens Token budget per piece.
 * @param overlapTokens Token budget for the overlap between split pieces.
 */
function splitPieces(
  clean: string,
  maxTokens: number,
  overlapTokens: number,
): string[] {
  const pieces: string[] = [];
  const paragraphs = clean
    .split(/\n+/)
    .map(p => p.trim())
    .filter(Boolean);
  for (const paragraph of paragraphs) {
    let rest = paragraph;
    while (estimateTokens(rest) > maxTokens) {
      const head = truncateToTokens(rest, maxTokens);
      pieces.push(head);
      const back = overlapLength(head, overlapTokens);
      rest = rest.slice(Math.max(1, head.length - back));
    }
    if (rest) pieces.push(rest);
  }
  return pieces;
}

/**
 * Chunks page text for embedding, matching the v0.5.0 PoC output exactly.
 *
 * Paragraphs are packed into chunks up to the token budget. When a chunk is
 * full, the next one starts with the tail of the previous chunk as overlap if
 * that still fits; a paragraph longer than the budget is hard-split with
 * overlap first.
 *
 * @param text Raw page text.
 * @param options Chunk budget, overlap and count limit.
 * @return Chunks in page order; empty when the text has no visible content.
 */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const {
    maxTokens = TOKEN_BUDGET,
    overlapTokens = DEFAULT_OVERLAP_TOKENS,
    maxChunks = DEFAULT_MAX_CHUNKS,
  } = options;
  const clean = cleanText(text);
  if (!clean) return [];

  const chunks: string[] = [];
  let current = '';
  for (const piece of splitPieces(clean, maxTokens, overlapTokens)) {
    const joined = current ? current + '\n' + piece : piece;
    if (current && estimateTokens(joined) > maxTokens) {
      chunks.push(current);
      if (chunks.length >= maxChunks) return chunks;
      const tail = current.slice(
        -Math.max(1, overlapLength(current, overlapTokens)),
      );
      const withOverlap = tail + '\n' + piece;
      current = estimateTokens(withOverlap) <= maxTokens ? withOverlap : piece;
    } else {
      current = joined;
    }
  }
  if (current && chunks.length < maxChunks) chunks.push(current);
  return chunks;
}

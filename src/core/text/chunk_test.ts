import {describe, expect, it} from 'vitest';

import {textGolden as golden} from '../../../test/golden';
import {TOKEN_BUDGET, chunkText} from './chunk';
import {estimateTokens} from './tokens';

/** Options the golden `chunksSmall` output was generated with. */
const SMALL = {maxTokens: 80, overlapTokens: 20, maxChunks: 8};

const cases = golden.cases.map(c => [c.name, c] as const);

/**
 * Whether some non-empty end of one chunk is repeated at the start of the next.
 *
 * @param a Earlier chunk.
 * @param b Following chunk.
 */
function overlaps(a: string, b: string): boolean {
  for (let k = Math.min(a.length, b.length); k > 0; k--) {
    if (a.endsWith(b.slice(0, k))) return true;
  }
  return false;
}

describe('chunkText', () => {
  it('uses the PoC token budget', () => {
    expect(TOKEN_BUDGET).toBe(golden.tokenBudget);
  });

  it.each(cases)('matches the PoC chunks for %s', (_, c) => {
    expect(chunkText(c.text)).toEqual(c.chunks);
  });

  it.each(cases)('matches the PoC chunks with small options for %s', (_, c) => {
    expect(chunkText(c.text, SMALL)).toEqual(c.chunksSmall);
  });

  it.each(cases)('keeps every chunk within budget for %s', (_, c) => {
    for (const chunk of chunkText(c.text)) {
      expect(estimateTokens(chunk)).toBeLessThanOrEqual(TOKEN_BUDGET);
    }
    for (const chunk of chunkText(c.text, SMALL)) {
      expect(estimateTokens(chunk)).toBeLessThanOrEqual(SMALL.maxTokens);
    }
  });

  it('stops at maxChunks', () => {
    const text = '語意搜尋'.repeat(1500);
    expect(chunkText(text)).toHaveLength(24);
    expect(chunkText(text, {maxChunks: 5})).toHaveLength(5);
    expect(chunkText(text, SMALL)).toHaveLength(SMALL.maxChunks);
  });

  it.each([
    ['a hard-split paragraph', '語意搜尋'.repeat(1500)],
    ['packed paragraphs', '在本機執行嵌入模型時要注意輸入長度。\n'.repeat(120)],
  ])('overlaps neighbouring chunks for %s', (_, text) => {
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      expect(overlaps(chunks[i - 1]!, chunks[i]!)).toBe(true);
    }
  });

  it('returns no chunks for text without visible content', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText(' \n\t\u200b\ufeff ')).toEqual([]);
  });
});

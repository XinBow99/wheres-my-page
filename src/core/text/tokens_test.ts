import {describe, expect, it} from 'vitest';

import {textGolden as golden} from '../../../test/golden';
import {estimateTokens, truncateToTokens} from './tokens';

const cases = golden.cases.map(c => [c.name, c] as const);

describe('estimateTokens', () => {
  it.each(cases)('matches the PoC estimate for %s', (_, c) => {
    expect(estimateTokens(c.text)).toBe(c.estimateTokens);
  });

  it.each([
    ['', 0],
    ['abc', 1], // 3 ASCII characters per token
    ['abcd', 2], // rounded up
    ['中文', 3], // 1.2 per CJK character
    ['한국어', 4], // Hangul counts as CJK
    ['ｶﾀｶﾅ', 5], // halfwidth forms count as CJK
    ['é', 2], // other BMP characters cost 2
    ['😀', 4], // an emoji is two UTF-16 units
  ])('estimates %j as %i tokens', (text, expected) => {
    expect(estimateTokens(text)).toBe(expected);
  });
});

describe('truncateToTokens', () => {
  it.each(cases)('matches the PoC truncation for %s', (_, c) => {
    expect(truncateToTokens(c.text, 40)).toBe(c.truncate40);
  });

  it('returns the input unchanged when it fits', () => {
    expect(truncateToTokens('short', 10)).toBe('short');
  });

  it('returns the longest prefix that fits', () => {
    const cut = truncateToTokens('中文字測試', 4);
    expect(cut).toBe('中文字');
    expect(estimateTokens(cut)).toBeLessThanOrEqual(4);
    expect(estimateTokens('中文字測')).toBeGreaterThan(4);
  });

  it('returns an empty string when not even one character fits', () => {
    expect(truncateToTokens('中', 0)).toBe('');
  });
});

import {describe, expect, it} from 'vitest';

import {mathGolden as golden} from '../../../test/golden';
import {queryTerms} from './query_terms';

describe('queryTerms', () => {
  it.each(golden.queryTerms.map(c => [c.q, c.terms] as const))(
    'matches the PoC for %j',
    (q, terms) => {
      expect(queryTerms(q)).toEqual(terms);
    },
  );

  it('is empty for an empty or whitespace-only query', () => {
    expect(queryTerms('')).toEqual([]);
    expect(queryTerms('  \t ')).toEqual([]);
  });

  it('drops one-character words', () => {
    expect(queryTerms('a 中 b')).toEqual([]);
  });

  it('adds 2-character shingles for a Chinese query', () => {
    expect(queryTerms('語意搜尋')).toEqual([
      {t: '語意搜尋', w: 1},
      {t: '語意', w: 0.4},
      {t: '意搜', w: 0.4},
      {t: '搜尋', w: 0.4},
    ]);
  });

  it('adds no shingles for a 3-character Chinese word', () => {
    expect(queryTerms('錯誤碼')).toEqual([{t: '錯誤碼', w: 1}]);
  });

  it('adds no shingles for a long ASCII word', () => {
    expect(queryTerms('Template')).toEqual([{t: 'template', w: 1}]);
  });

  it('gives a word weight 1 even if it was a shingle earlier', () => {
    expect(queryTerms('搜尋引擎 搜尋')).toEqual([
      {t: '搜尋引擎', w: 1},
      {t: '搜尋', w: 1},
      {t: '尋引', w: 0.4},
      {t: '引擎', w: 0.4},
    ]);
  });

  it('splits on CJK punctuation', () => {
    expect(queryTerms('「錯誤碼」，C2975；template').map(x => x.t)).toEqual([
      '錯誤碼',
      'c2975',
      'template',
    ]);
  });

  it('keeps at most 24 terms', () => {
    const words = Array.from({length: 30}, (_, i) => `w${i}`).join(' ');
    expect(queryTerms(words)).toHaveLength(24);
  });
});

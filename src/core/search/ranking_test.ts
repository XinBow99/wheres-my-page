import {describe, expect, it} from 'vitest';

import {expectClose} from '../../../test/expect_close';
import {type GoldenPage, storeGolden as golden} from '../../../test/golden';
import {queryTerms} from './query_terms';
import {
  HISTORY_PENALTY,
  KEYWORD_BOOST_CAP,
  RECENCY_BOOST,
  bestChunkPerPage,
  keywordBoost,
  recencyBoost,
  scorePage,
  topByScore,
} from './ranking';

const DAY = 86_400_000;
const {dim, now} = golden;
const chunks = [...golden.db.stores.chunks].sort((a, b) => a.id - b.id);
const pages = new Map(golden.db.stores.pages.map(p => [p.url, p]));
const mat = new Float32Array(chunks.length * dim);
chunks.forEach((c, i) => mat.set(c.vec.slice(0, dim), i * dim));

type SearchOpts = (typeof golden.search)[number]['opts'];

/**
 * The PoC search filters used by the golden queries. Category filters other
 * than clips belong to the tag service and are not exercised here.
 *
 * @param page Candidate page.
 * @param opts Golden query options.
 */
function passes(page: GoldenPage, opts: SearchOpts): boolean {
  if (opts.sinceTs && page.ts < opts.sinceTs) return false;
  if (opts.domain && page.domain !== opts.domain) return false;
  if (opts.tag && opts.tag !== '__clips__') {
    throw new Error(`unsupported golden tag filter ${opts.tag}`);
  }
  if (opts.tag && page.source !== 'clip') return false;
  return true;
}

/**
 * Runs the extracted ranking the way VectorIndex.search composed it.
 *
 * @param qvec Query vector.
 * @param query Query text.
 * @param opts Golden query options.
 */
function search(qvec: number[], query: string, opts: SearchOpts) {
  const terms = queryTerms(query);
  const hits = bestChunkPerPage(chunks, mat, dim, qvec, url => {
    const page = pages.get(url);
    return !!page && passes(page, opts);
  });
  const scored = [...hits].map(([url, {row, sem}]) => {
    const snippet = chunks[row]!.text;
    const score = scorePage(pages.get(url)!, sem, snippet, terms, now);
    return {url, snippet, ...score};
  });
  return topByScore(scored, opts.k);
}

describe('ranking against the PoC VectorIndex.search', () => {
  it.each(golden.search.map(s => [s.query, s] as const))(
    'matches the PoC order and scores for %j',
    (_, s) => {
      const results = search(s.qvec, s.query, s.opts);
      expect(results.map(r => r.url)).toEqual(s.results.map(r => r.url));
      results.forEach((r, i) => {
        const want = s.results[i]!;
        expect(r.snippet).toBe(want.snippet);
        expectClose(r.score, want.score);
        expectClose(r.sem, want.sem);
        expectClose(r.kw, want.kw);
      });
    },
  );
});

describe('bestChunkPerPage', () => {
  const rows = [{url: 'a'}, {url: 'b'}, {url: 'a'}, {url: 'a'}];
  const m = Float32Array.from([1, 0, 0, 1, 0.6, 0.8, 0.6, 0.8]);

  it('keeps the most similar chunk of each page', () => {
    const best = bestChunkPerPage(rows, m, 2, [0, 1], () => true);
    expect(best.get('a')).toEqual({row: 2, sem: expect.closeTo(0.8, 6)});
    expect(best.get('b')).toEqual({row: 1, sem: 1});
  });

  it('keeps the earlier chunk on a tie', () => {
    const best = bestChunkPerPage(rows, m, 2, [0.6, 0.8], () => true);
    expect(best.get('a')?.row).toBe(2);
  });

  it('skips excluded pages and asks once per URL', () => {
    const asked: string[] = [];
    const best = bestChunkPerPage(rows, m, 2, [1, 0], url => {
      asked.push(url);
      return url === 'b';
    });
    expect([...best.keys()]).toEqual(['b']);
    expect(asked).toEqual(['a', 'b']);
  });

  it('is empty for an empty index', () => {
    expect(
      bestChunkPerPage([], new Float32Array(0), 2, [1, 0], () => true),
    ).toEqual(new Map());
  });
});

describe('keywordBoost', () => {
  const page = {title: 'vLLM KV cache 調整', url: 'https://docs.vllm.ai/x'};

  it('counts a title or URL match more than a body match', () => {
    expectClose(keywordBoost([{t: 'vllm', w: 1}], page, ''), 0.08);
    expectClose(keywordBoost([{t: 'gpu', w: 1}], page, 'GPU memory'), 0.05);
  });

  it('scales by the term weight', () => {
    expectClose(keywordBoost([{t: '調整', w: 0.4}], page, ''), 0.032);
  });

  it('is zero when nothing matches', () => {
    expect(keywordBoost([{t: 'kyoto', w: 1}], page, 'body')).toBe(0);
    expect(keywordBoost([], page, 'body')).toBe(0);
  });

  it('is capped', () => {
    const terms = queryTerms('vllm kv cache docs https');
    expect(keywordBoost(terms, page, '')).toBe(KEYWORD_BOOST_CAP);
  });
});

describe('recencyBoost', () => {
  it('is the full boost for a visit just now', () => {
    expect(recencyBoost(now, now)).toBe(RECENCY_BOOST);
  });

  it('decays by 1/e every 30 days', () => {
    expectClose(recencyBoost(now - 30 * DAY, now), RECENCY_BOOST / Math.E);
  });
});

describe('scorePage', () => {
  const base = {url: 'https://x.test/', title: 'T', ts: now, source: 'page'};

  it('adds the semantic score, keyword boost and recency boost', () => {
    const s = scorePage(base, 0.5, 'gpu', [{t: 'gpu', w: 1}], now);
    expect(s.sem).toBe(0.5);
    expectClose(s.kw, 0.05);
    expectClose(s.score, 0.5 + 0.05 + RECENCY_BOOST);
  });

  it('penalizes history-only pages', () => {
    const page = scorePage(base, 0.5, '', [], now);
    const history = scorePage({...base, source: 'history'}, 0.5, '', [], now);
    expectClose(page.score - history.score, HISTORY_PENALTY);
  });
});

describe('topByScore', () => {
  it('sorts highest first, keeps ties in order and truncates', () => {
    const items = [
      {id: 'a', score: 0.1},
      {id: 'b', score: 0.5},
      {id: 'c', score: 0.5},
      {id: 'd', score: 0.3},
    ];
    expect(topByScore(items, 3).map(x => x.id)).toEqual(['b', 'c', 'd']);
    expect(items.map(x => x.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

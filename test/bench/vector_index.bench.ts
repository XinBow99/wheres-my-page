/**
 * @fileoverview Search latency of VectorIndex over 20,000 chunks of 256
 * dimensions (docs/CONSTRAINTS.md ratchet "語意搜尋延遲"). Pure computation:
 * the index is filled in memory, without IndexedDB.
 *
 * Run with `npm run bench` (`vitest bench`); prints p50/p99 in ms.
 */

import {expect, test} from 'vitest';

import {DIM} from '../../src/shared/constants';
import {VectorIndex} from '../../src/storage/vector_index';

const CHUNKS = 20_000;
const CHUNKS_PER_PAGE = 8;

/**
 * Deterministic unit vector.
 *
 * @param seed Seed.
 * @return Unit vector of length DIM.
 */
function unitVec(seed: number): Float32Array {
  let a = seed >>> 0;
  const v = Float32Array.from({length: DIM}, () => {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    return a / 2 ** 31 - 1;
  });
  const norm = Math.hypot(...v);
  return v.map(x => x / norm);
}

const index = new VectorIndex(DIM);
index.mat = new Float32Array(CHUNKS * DIM);
for (let i = 0; i < CHUNKS; i++) {
  const url = `https://example.com/p${Math.floor(i / CHUNKS_PER_PAGE)}`;
  index.rows.push({
    id: i,
    url,
    idx: i % CHUNKS_PER_PAGE,
    text: `chunk ${i} cuda kv cache 語音辨識`,
  });
  index.mat.set(unitVec(i + 1), i * DIM);
  if (!index.pages.has(url)) {
    index.pages.set(url, {
      url,
      title: `page ${i} 標題`,
      domain: 'example.com',
      hash: 'h',
      source: 'page',
      ts: Date.now() - i * 1000,
      tagsManual: [],
      tagsAuto: [],
    });
  }
}
const qvec = unitVec(424242);

test(`VectorIndex.search, ${CHUNKS} chunks × ${DIM}`, async ({bench}) => {
  const keywords = await bench('query with keywords, k = 60', () => {
    index.search(qvec, 'kv cache 語音', {k: 60});
  }).run();
  const filtered = await bench('filtered by domain and time', () => {
    index.search(qvec, 'cuda', {k: 60, domain: 'example.com', sinceTs: 1});
  }).run();
  for (const r of [keywords, filtered]) {
    const {p50, p99} = r.latency;
    console.log(
      `${r.name}: p50 ${p50?.toFixed(2)} ms, p99 ${p99?.toFixed(2)} ms`,
    );
    expect(p50).toBeGreaterThan(0);
  }
});

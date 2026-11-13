import {describe, expect, it} from 'vitest';

import {expectClose, expectVecClose} from '../../../test/expect_close';
import {storeGolden as golden} from '../../../test/golden';
import {DESC_WEIGHT, buildPrototypes, scoreCategories} from './prototypes';

const {dim} = golden;
const {pages, categories} = golden.db.stores;
const ordered = [...categories].sort((a, b) => a.order - b.order);
const whisper = pages.find(p => p.url === 'https://example.com/whisper')!;

describe('buildPrototypes against the PoC', () => {
  const protos = buildPrototypes(ordered, pages, dim);

  it('counts manually tagged examples like listCategories', () => {
    const examples = golden.categories.categories.map(c => [
      c.id,
      protos.get(c.id)?.examples ?? 0,
    ]);
    expect(examples).toEqual(
      golden.categories.categories.map(c => [c.id, c.examples]),
    );
  });

  it('matches the PoC scoreCategories of the whisper page', () => {
    const scores = scoreCategories(whisper.vec, protos, dim);
    expect(scores.map(x => x.id)).toEqual(golden.scoreWhisper.map(x => x.id));
    scores.forEach((x, i) => expectClose(x.s, golden.scoreWhisper[i]!.s));
  });
});

describe('buildPrototypes', () => {
  it('weights the description as DESC_WEIGHT example pages', () => {
    const protos = buildPrototypes(
      [{id: 'c', vec: [1, 0]}],
      [
        {vec: [0, 1], tagsManual: ['c']},
        {vec: [0, 1], tagsManual: ['other']},
        {vec: null, tagsManual: ['c']},
        {vec: [0, 1]},
      ],
      2,
    );
    const norm = Math.hypot(DESC_WEIGHT, 1);
    expect(protos.get('c')?.examples).toBe(1);
    expectVecClose(protos.get('c')!.vec, [DESC_WEIGHT / norm, 1 / norm]);
  });

  it('skips categories without a description vector', () => {
    const protos = buildPrototypes(
      [{id: 'a', vec: null}, {id: 'b'}, {id: 'c', vec: [0, 2]}],
      [],
      2,
    );
    expect([...protos.keys()]).toEqual(['c']);
    expectVecClose(protos.get('c')!.vec, [0, 1]);
  });
});

describe('scoreCategories', () => {
  it('scores every prototype, highest first', () => {
    const protos = buildPrototypes(
      [
        {id: 'x', vec: [1, 0]},
        {id: 'y', vec: [0, 1]},
      ],
      [],
      2,
    );
    expect(scoreCategories([0.6, 0.8], protos, 2)).toEqual([
      {id: 'y', s: expect.closeTo(0.8, 6)},
      {id: 'x', s: expect.closeTo(0.6, 6)},
    ]);
  });

  it('is empty without prototypes', () => {
    expect(scoreCategories([1, 0], new Map(), 2)).toEqual([]);
  });
});

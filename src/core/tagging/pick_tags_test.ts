import {describe, expect, it} from 'vitest';

import {mathGolden, storeGolden} from '../../../test/golden';
import {TAG_DEFAULTS, autoTags, pickTags} from './pick_tags';
import {buildPrototypes, scoreCategories} from './prototypes';

const cases = mathGolden.pickTags.map((c, i) => [i, c] as const);

describe('pickTags', () => {
  it('uses the PoC defaults', () => {
    expect({...TAG_DEFAULTS}).toEqual(mathGolden.tagDefaults);
  });

  it.each(cases)('matches the PoC with defaults for case %i', (_, c) => {
    expect(pickTags(c.scores)).toEqual(c.defaults);
  });

  it.each(cases)('matches the PoC with minScore 0.45 for case %i', (_, c) => {
    expect(pickTags(c.scores, {minScore: 0.45})).toEqual(c.strict);
  });

  it('sorts unsorted scores and does not modify them', () => {
    const scores = [
      {id: 'b', s: 0.38},
      {id: 'z', s: 0},
      {id: 'a', s: 0.4},
    ];
    expect(pickTags(scores).map(x => x.id)).toEqual(['a', 'b']);
    expect(scores.map(x => x.id)).toEqual(['b', 'z', 'a']);
  });

  it('picks nothing when the best barely beats the mean', () => {
    const flat = ['a', 'b', 'c', 'd'].map(id => ({id, s: 0.5}));
    expect(pickTags(flat)).toEqual([]);
  });

  it('honours maxTags and margin', () => {
    const scores = [
      {id: 'a', s: 0.6},
      {id: 'b', s: 0.58},
      {id: 'c', s: 0.5},
      {id: 'd', s: 0},
    ];
    expect(pickTags(scores, {maxTags: 1}).map(x => x.id)).toEqual(['a']);
    expect(pickTags(scores, {margin: 0.2}).map(x => x.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('keeps extra fields of the score objects', () => {
    const scores = [{id: 'a', s: 0.9, name: 'A'}];
    expect(pickTags(scores)[0]?.name).toBe('A');
  });
});

describe('autoTags', () => {
  const scores = [
    {id: 'a', s: 0.41234},
    {id: 'b', s: 0.40001},
    {id: 'c', s: 0.39},
    {id: 'd', s: 0},
  ];

  it('rounds stored scores to 3 decimals', () => {
    expect(autoTags(scores, [], [])).toEqual([
      {id: 'a', s: 0.412},
      {id: 'b', s: 0.4},
      {id: 'c', s: 0.39},
    ]);
  });

  it('leaves manual and removed categories to the user', () => {
    expect(autoTags(scores, ['a'], ['c']).map(x => x.id)).toEqual(['b']);
  });

  it('does not refill the slots of skipped categories', () => {
    const many = [...scores, {id: 'e', s: 0.395}];
    expect(autoTags(many, ['a'], [], {margin: 0.1}).map(x => x.id)).toEqual([
      'b',
      'e',
    ]);
  });

  it('matches the auto tags stored by the PoC', () => {
    const {pages, categories} = storeGolden.db.stores;
    const ordered = [...categories].sort((a, b) => a.order - b.order);
    const protos = buildPrototypes(ordered, pages, storeGolden.dim);
    for (const page of pages) {
      const scores = scoreCategories(page.vec, protos, storeGolden.dim);
      expect(autoTags(scores, page.tagsManual, page.tagsRemoved)).toEqual(
        page.tagsAuto,
      );
    }
  });
});

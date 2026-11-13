import {describe, expect, it} from 'vitest';

import {sharedGolden as golden} from '../../test/golden';
import {
  DEFAULT_DENYLIST,
  DIM,
  IMAGE_DB_NAME,
  MODELS,
  MODEL_CACHE_NAME,
  PRESET_CATEGORIES,
  PROMPT,
  TEXT_DB_NAME,
  VISION_MODEL,
} from './constants';

describe('constants', () => {
  it('match the PoC models, dimension and vision model', () => {
    expect(MODELS).toEqual(golden.models);
    expect(DIM).toBe(golden.dim);
    expect(VISION_MODEL).toBe(golden.visionModel);
  });

  it('match the PoC preset categories', () => {
    expect(PRESET_CATEGORIES).toEqual(golden.presetCategories);
  });

  it('match the PoC default denylist', () => {
    expect(DEFAULT_DENYLIST).toBe(golden.defaultDenylist);
  });

  it('keep the v0.5.0 storage names', () => {
    expect([TEXT_DB_NAME, IMAGE_DB_NAME, MODEL_CACHE_NAME]).toEqual([
      'semhist',
      'semhist-img',
      'semhist-models-v1',
    ]);
  });

  it('are frozen', () => {
    expect(Object.isFrozen(MODELS.eg2_270m)).toBe(true);
    expect(Object.isFrozen(PRESET_CATEGORIES[0])).toBe(true);
    expect(Object.isFrozen(PROMPT)).toBe(true);
  });
});

describe('PROMPT', () => {
  it.each(golden.prompt.query.map(c => [c.q, c.out] as const))(
    'query(%j) matches the PoC',
    (q, out) => {
      expect(PROMPT.query(q)).toBe(out);
    },
  );

  it.each(golden.prompt.doc.map(c => [c.title, c.text, c.out] as const))(
    'doc(%j, %j) matches the PoC',
    (title, text, out) => {
      expect(PROMPT.doc(title ?? undefined, text)).toBe(out);
    },
  );

  it.each(
    golden.prompt.category.map(c => [c.name, c.description, c.out] as const),
  )('category(%j, %j) matches the PoC', (name, description, out) => {
    expect(PROMPT.category(name, description)).toBe(out);
  });

  it('omits the separator when a category has no description', () => {
    expect(PROMPT.category('AI')).toBe('task: search result | query: AI');
  });
});

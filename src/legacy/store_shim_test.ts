import {IDBFactory} from 'fake-indexeddb';
import {afterEach, describe, expect, it, vi} from 'vitest';

import * as poc from './store_shim';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dist/store.js shim', () => {
  it('keeps the v0.5.0 export names', () => {
    expect(Object.keys(poc).sort()).toEqual([
      'TAG_DEFAULTS',
      'VectorIndex',
      'dot',
      'meanVec',
      'normalize',
      'pickTags',
      'queryTerms',
      'toDim',
    ]);
  });

  it('mirrors the localStorage model into the text index only', async () => {
    vi.stubGlobal('localStorage', {getItem: () => 'eg2_440m'});
    const idb = new IDBFactory();
    const text = await new poc.VectorIndex(16, idb).open();
    const images = await new poc.VectorIndex(16, idb, 'semhist-img').open();
    expect(text.dbName).toBe('semhist');
    expect(text.textModel).toBe('eg2_440m');
    expect(images.textModel).toBe(null);
  });

  it('works without localStorage (e.g. in a worker)', async () => {
    vi.stubGlobal('localStorage', undefined);
    vi.stubGlobal('indexedDB', new IDBFactory());
    const index = await new poc.VectorIndex(16).open();
    expect(index.textModel).toBe(null);
  });
});

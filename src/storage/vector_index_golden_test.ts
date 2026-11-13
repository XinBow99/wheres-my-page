/**
 * @fileoverview VectorIndex against the v0.5.0 golden database: a database
 * written by the PoC store.js (test/fixtures/poc/store.json) is restored
 * into fake IndexedDB, opened with the new code, and every stored record
 * and query output is compared.
 */

import {IDBFactory} from 'fake-indexeddb';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';

import {storeGolden as golden} from '../../test/golden';
import {plain} from '../../test/plain';
import {PRESET_CATEGORIES} from '../shared/constants';
import {STORES, done, openDb} from './db';
import {VectorIndex} from './vector_index';

/**
 * Copy of a dumped record with its `vec` back as a Float32Array.
 *
 * @param rec Dumped record.
 * @return Record as IndexedDB held it.
 */
function revive<T extends {vec?: number[] | null}>(rec: T): T {
  return Array.isArray(rec.vec)
    ? {...rec, vec: Float32Array.from(rec.vec)}
    : rec;
}

/**
 * Writes the golden dump into a fresh database.
 *
 * @param idb Factory to write into.
 * @param name Database name.
 */
async function restore(idb: IDBFactory, name: string): Promise<void> {
  const db = await openDb(idb, name);
  const {stores} = golden.db;
  const tx = db.transaction(Object.values(STORES), 'readwrite');
  for (const p of stores.pages) tx.objectStore(STORES.pages).put(revive(p));
  for (const c of stores.chunks) tx.objectStore(STORES.chunks).put(revive(c));
  for (const c of stores.categories) {
    tx.objectStore(STORES.categories).put(revive(c));
  }
  tx.objectStore(STORES.meta).put({key: 'seeded', value: true});
  await done(tx);
  db.close();
}

describe('VectorIndex on the v0.5.0 golden database', () => {
  let index: VectorIndex;

  beforeAll(async () => {
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(golden.now);
    const idb = new IDBFactory();
    await restore(idb, 'semhist');
    index = await new VectorIndex(golden.dim, idb).open(PRESET_CATEGORIES);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it('loads every page record unchanged', () => {
    expect(plain([...index.pages.values()])).toEqual(golden.db.stores.pages);
  });

  it('loads every chunk in order', () => {
    const chunks = golden.db.stores.chunks;
    expect(index.rows).toEqual(
      chunks.map(({id, url, idx, text}) => ({id, url, idx, text})),
    );
    expect(plain(index.mat)).toEqual(chunks.flatMap(c => c.vec));
  });

  it('loads the categories without seeding them again', () => {
    expect(plain([...index.cats.values()])).toEqual(
      golden.db.stores.categories,
    );
  });

  it.each(golden.search.map(s => [s.query, s] as const))(
    'search "%s" matches the PoC',
    (_, {qvec, query, opts, results}) => {
      expect(plain(index.search(Float32Array.from(qvec), query, opts))).toEqual(
        results,
      );
    },
  );

  it('browses like the PoC', () => {
    expect(plain(index.browse({k: 10}))).toEqual(golden.browse.all);
    expect(plain(index.browse({k: 10, tag: 'gpu'}))).toEqual(golden.browse.gpu);
    expect(plain(index.browse({k: 10, tag: '__none__'}))).toEqual(
      golden.browse.none,
    );
  });

  it('lists categories, stats and category scores like the PoC', () => {
    expect(plain(index.listCategories())).toEqual(golden.categories);
    expect(index.stats()).toEqual(golden.stats);
    const whisper = index.pages.get('https://example.com/whisper')!;
    expect(plain(index.scoreCategories(whisper.vec!))).toEqual(
      golden.scoreWhisper,
    );
  });
});

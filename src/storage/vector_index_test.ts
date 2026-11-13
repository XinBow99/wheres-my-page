import {IDBFactory} from 'fake-indexeddb';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {plain} from '../../test/plain';
import {PRESET_CATEGORIES} from '../shared/constants';
import type {PageSource} from '../shared/types';
import {
  LEGACY_MODEL_KEY,
  META_TEXT_MODEL,
  readMeta,
  readTextModel,
  writeMeta,
} from './db';
import {type PageInput, type PageRecord, VectorIndex} from './vector_index';

const DIM = 16;
/** Vectors are longer than DIM, like real 768-d embeddings. */
const FULL = 24;
const T0 = Date.UTC(2026, 10, 1);
const DAY = 86_400_000;

/** The subset of the PoC VectorIndex API the differential test drives. */
interface PocIndex {
  pages: Map<string, unknown>;
  cats: Map<string, unknown>;
  rows: unknown[];
  mat: Float32Array;
  tagOpts: unknown;
  open(presets: readonly unknown[]): Promise<unknown>;
  upsert(
    page: PageInput,
    chunks: string[],
    vecs: Float32Array[],
  ): Promise<boolean>;
  touch(url: string): Promise<void>;
  delete(url: string): Promise<void>;
  deleteDomain(domain: string): Promise<number>;
  clear(): Promise<void>;
  setTag(url: string, catId: string, on: boolean): Promise<boolean>;
  putCategory(cat: object, vec: Float32Array | null): Promise<unknown>;
  setCategoryVec(id: string, vec: Float32Array): Promise<void>;
  deleteCategory(id: string): Promise<boolean>;
  setTagOptions(opts: object): Promise<number>;
  retagAll(): Promise<number>;
  isCurrent(url: string, hash: string): boolean;
  stats(): unknown;
  clipsOf(url: string): unknown[];
  categoriesNeedingVec(): unknown[];
  scoreCategories(vec: Float32Array): unknown;
  tagsOf(page: unknown): unknown;
  hasTag(page: unknown, id: string): boolean;
  listCategories(): unknown;
  search(qvec: Float32Array, query: string, opts: object): unknown;
  browse(opts: object): unknown;
}

type PocCtor = new (dim: number, idb: IDBFactory, name: string) => PocIndex;

/** The frozen v0.5.0 store.js (a variable keeps TS from resolving it). */
const POC_STORE = '../../store.js';

async function pocVectorIndex(): Promise<PocCtor> {
  const mod = (await import(/* @vite-ignore */ POC_STORE)) as {
    VectorIndex: PocCtor;
  };
  return mod.VectorIndex;
}

/**
 * Deterministic PRNG (mulberry32) with helpers.
 *
 * @param seed Seed.
 * @return Generators.
 */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!;
  const vec = (n = FULL) => {
    const v = Float32Array.from({length: n}, () => next() * 2 - 1);
    const norm = Math.hypot(...v);
    return v.map(x => x / norm);
  };
  return {next, int, pick, vec};
}

const DOMAINS = ['a.example', 'b.example', 'docs.example'];
const URLS = DOMAINS.flatMap(d => [1, 2, 3, 4].map(i => `https://${d}/p${i}`));
const WORDS = [
  'cuda',
  'kv cache',
  '語音辨識',
  '殖利率',
  '京都',
  'flash-attn',
  'ETF',
  '字幕',
  'error C2975',
  '珍珠奶茶',
];
const CAT_IDS = [
  ...PRESET_CATEGORIES.map(c => c.id),
  'c_new1',
  'c_new2',
  'nope',
];
const SOURCES: PageSource[] = [
  'page',
  'page',
  'page',
  'history',
  'clip',
  'image',
];
const TAG_FILTERS = [
  '',
  '',
  'ai',
  'gpu',
  '__none__',
  '__clips__',
  '__images__',
];

/**
 * Comparable snapshot of an index's in-memory state.
 *
 * @param x Either index.
 * @return Plain JSON.
 */
function state(
  x: Pick<PocIndex, 'pages' | 'cats' | 'rows' | 'mat' | 'tagOpts'>,
) {
  return plain({
    pages: [...x.pages.values()],
    cats: [...x.cats.values()],
    rows: x.rows,
    mat: x.mat,
    tagOpts: x.tagOpts,
  });
}

describe('VectorIndex vs v0.5.0 store.js (differential)', () => {
  beforeEach(() => {
    vi.useFakeTimers({toFake: ['Date']});
    // putCategory ids without an explicit id use Math.random.
    vi.spyOn(Math, 'random').mockReturnValue(0.4242);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([1, 2, 3, 4, 5, 6])(
    'seed %i: same state and outputs after random operations',
    async seed => {
      const Poc = await pocVectorIndex();
      const r = rng(seed);
      let now = T0;
      vi.setSystemTime(now);
      const pocIdb = new IDBFactory();
      const newIdb = new IDBFactory();
      const poc = new Poc(DIM, pocIdb, 'semhist');
      const ours = new VectorIndex(DIM, newIdb, 'semhist');
      await poc.open(PRESET_CATEGORIES);
      await ours.open(PRESET_CATEGORIES);

      // Most categories get a description vector; one stays without.
      for (const c of PRESET_CATEGORIES.slice(1)) {
        const v = r.vec();
        await poc.setCategoryVec(c.id, v);
        await ours.setCategoryVec(c.id, v);
      }

      const both = async <T>(f: (x: PocIndex) => T | Promise<T>) => {
        const a = await f(poc);
        const b = await f(ours as unknown as PocIndex);
        expect(plain(b)).toEqual(plain(a));
      };

      for (let step = 0; step < 120; step++) {
        now += r.int(3 * DAY);
        vi.setSystemTime(now);
        // Draw everything up front: both indexes must get the same arguments.
        const url = r.pick(URLS);
        const op = r.int(100);
        const catId = r.pick(CAT_IDS);
        const on = r.next() < 0.6;
        const domain = r.pick(DOMAINS);
        const minScore = r.pick([0.05, 0.2, 0.35]);
        const hash = `h${r.int(3)}`;
        if (op < 40) {
          const source = r.pick(SOURCES);
          const n = 1 + r.int(4);
          const chunks = Array.from({length: n}, () =>
            Array.from({length: 1 + r.int(4)}, () => r.pick(WORDS)).join(' '),
          );
          const vecs = chunks.map(() => r.vec());
          const page: PageInput = {
            url,
            title: r.pick(WORDS),
            domain: new URL(url).hostname,
            hash: `h${r.int(3)}`,
            source,
            ...(r.next() < 0.5 ? {ts: now - r.int(60) * DAY} : {}),
            ...(source === 'clip' || source === 'image'
              ? {
                  parentUrl: url.replace(/p\d$/, 'p1'),
                  linkUrl: `${url}#x`,
                  note: r.pick(WORDS),
                }
              : {}),
          };
          await both(x => x.upsert(page, chunks, vecs));
        } else if (op < 48) {
          await both(x => x.touch(url));
        } else if (op < 62) {
          await both(x => x.setTag(url, catId, on));
        } else if (op < 69) {
          const id = r.pick([...CAT_IDS, undefined]);
          const cat = {
            ...(id ? {id} : {}),
            name: r.pick(['', '  旅遊 ', 'Rust']),
            ...(r.next() < 0.5 ? {description: r.pick(WORDS)} : {}),
            ...(r.next() < 0.5 ? {color: '#123456'} : {}),
            ...(r.next() < 0.4 ? {allowCreateWithId: true} : {}),
          };
          const v = r.next() < 0.7 ? r.vec() : null;
          await both(x => x.putCategory(cat, v));
        } else if (op < 73) {
          const v = r.vec();
          await both(x => x.setCategoryVec(catId, v));
        } else if (op < 76) {
          await both(x => x.deleteCategory(catId));
        } else if (op < 86) {
          await both(x => x.delete(url));
        } else if (op < 90) {
          await both(x => x.deleteDomain(domain));
        } else if (op < 95) {
          await both(x => x.setTagOptions({minScore}));
        } else if (op < 97) {
          await both(x => x.retagAll());
        } else {
          await both(x => x.clear());
        }
        expect(state(ours)).toEqual(state(poc));

        // Read-only outputs.
        const qvec = r.vec();
        const opts = {
          k: 1 + r.int(8),
          ...(r.next() < 0.3 ? {sinceTs: now - r.int(30) * DAY} : {}),
          ...(r.next() < 0.3 ? {domain: r.pick(DOMAINS)} : {}),
          tag: r.pick(TAG_FILTERS),
        };
        const query = Array.from({length: r.int(3)}, () => r.pick(WORDS)).join(
          ' ',
        );
        await both(x => x.search(qvec, query, opts));
        await both(x => x.browse(opts));
        await both(x => x.listCategories());
        await both(x => x.stats());
        await both(x => x.scoreCategories(qvec));
        await both(x => x.clipsOf(url.replace(/p\d$/, 'p1')));
        await both(x => x.categoriesNeedingVec());
        await both(x => x.isCurrent(url, hash));
        for (const tag of TAG_FILTERS) {
          await both(x =>
            [...x.pages.values()].map(p => [x.tagsOf(p), x.hasTag(p, tag)]),
          );
        }
      }

      // Both persisted the same data: reopen from their databases.
      const pocAgain = new Poc(DIM, pocIdb, 'semhist');
      const oursAgain = new VectorIndex(DIM, newIdb, 'semhist');
      await pocAgain.open(PRESET_CATEGORIES);
      await oursAgain.open(PRESET_CATEGORIES);
      expect(state(oursAgain)).toEqual(state(pocAgain));
      // getAll returns pages by URL; in memory they are in insertion order.
      const byUrl = (x: VectorIndex) =>
        plain([...x.pages.values()].sort((m, n) => (m.url < n.url ? -1 : 1)));
      expect(byUrl(oursAgain)).toEqual(byUrl(ours));
    },
  );
});

describe('VectorIndex', () => {
  let idb: IDBFactory;
  let index: VectorIndex;
  const v = (seed: number) => rng(seed).vec();
  const page = (url: string, source: PageSource = 'page'): PageInput => ({
    url,
    title: 't',
    domain: new URL(url).hostname,
    hash: 'h',
    source,
  });

  beforeEach(async () => {
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(T0);
    idb = new IDBFactory();
    index = await new VectorIndex(DIM, idb).open(PRESET_CATEGORIES);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const reopen = () => new VectorIndex(DIM, idb).open(PRESET_CATEGORIES);

  it('fails clearly when used before open()', async () => {
    const closed = new VectorIndex(DIM, idb, 'x');
    await expect(closed.clear()).rejects.toThrow('x: open() was not called');
  });

  it('seeds the presets once, in order', async () => {
    expect([...index.cats.keys()]).toEqual(PRESET_CATEGORIES.map(c => c.id));
    await index.deleteCategory('ai');
    const again = await reopen();
    expect(again.cats.has('ai')).toBe(false);
    expect(again.cats.get('gpu')).toMatchObject({builtin: true, order: 1});
  });

  it('opens without presets and without seeding', async () => {
    const bare = await new VectorIndex(DIM, new IDBFactory()).open();
    expect(bare.cats.size).toBe(0);
  });

  it('keeps an indexed page when a history title arrives', async () => {
    await index.upsert(page('https://a.example/x'), ['body'], [v(1)]);
    expect(
      await index.upsert(
        page('https://a.example/x', 'history'),
        ['title'],
        [v(2)],
      ),
    ).toBe(false);
    expect(index.pages.get('https://a.example/x')!.source).toBe('page');
    // A history entry may be upgraded to a page.
    await index.upsert(page('https://a.example/h', 'history'), ['t'], [v(3)]);
    expect(
      await index.upsert(page('https://a.example/h'), ['body'], [v(4)]),
    ).toBe(true);
  });

  it('persists upserts, deletes and clears across reopen', async () => {
    await index.upsert(page('https://a.example/1'), ['a', 'b'], [v(1), v(2)]);
    await index.upsert(page('https://b.example/2'), ['c'], [v(3)]);
    await index.upsert(page('https://b.example/3'), ['d'], [v(4)]);
    expect((await reopen()).rows.map(r => r.text)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);

    await index.delete('https://a.example/1');
    expect(await index.deleteDomain('b.example')).toBe(2);
    const empty = await reopen();
    expect(empty.pages.size).toBe(0);
    expect(empty.rows).toEqual([]);

    await index.upsert(page('https://a.example/1'), ['a'], [v(1)]);
    await index.clear();
    expect((await reopen()).stats()).toMatchObject({pages: 0, chunks: 0});
  });

  it('learns from a manual tag and forgets it when the page is deleted', async () => {
    await index.setCategoryVec('ai', v(10));
    await index.upsert(page('https://a.example/1'), ['a'], [v(11)]);
    await index.setTag('https://a.example/1', 'ai', true);
    const examples = () =>
      index.listCategories().categories.find(c => c.id === 'ai')!.examples;
    expect(examples()).toBe(1);
    await index.delete('https://a.example/1');
    expect(examples()).toBe(0);
  });

  it('refuses tags for unknown pages or categories', async () => {
    expect(await index.setTag('https://nowhere/', 'ai', true)).toBe(false);
    await index.upsert(page('https://a.example/1'), ['a'], [v(1)]);
    expect(await index.setTag('https://a.example/1', 'nope', true)).toBe(false);
  });

  it('creates categories with generated ids and refuses unknown ids', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const rec = await index.putCategory({name: ' 旅遊 '}, null);
    expect(rec).toMatchObject({
      id: `c_${T0.toString(36)}i`,
      name: '旅遊',
      description: '',
      color: '#2f5bd3',
      builtin: false,
      order: PRESET_CATEGORIES.length,
      vec: null,
    });
    expect(await index.putCategory({id: 'missing', name: 'x'}, null)).toBe(
      null,
    );
    expect(await index.deleteCategory('missing')).toBe(false);
    await index.setCategoryVec('missing', v(1));
    expect(index.cats.has('missing')).toBe(false);
    vi.restoreAllMocks();
  });

  it('fills page vectors missing from v1 records on open', async () => {
    await index.upsert(page('https://a.example/1'), ['a', 'b'], [v(1), v(2)]);
    const expected = plain(index.pages.get('https://a.example/1')!.vec);
    const tx = index.db!.transaction('pages', 'readwrite');
    const v1: Partial<PageRecord> = {
      ...index.pages.get('https://a.example/1')!,
    };
    delete v1.vec;
    tx.objectStore('pages').put(v1);
    await new Promise(resolve => (tx.oncomplete = resolve));
    const migrated = await reopen();
    expect(plain(migrated.pages.get('https://a.example/1')!.vec)).toEqual(
      expected,
    );
    expect(
      plain((await reopen()).pages.get('https://a.example/1')!.vec),
    ).toEqual(expected);
  });

  it('ignores touch for unknown pages and counts visits', async () => {
    await index.touch('https://nowhere/');
    await index.upsert(page('https://a.example/1'), ['a'], [v(1)]);
    vi.setSystemTime(T0 + DAY);
    await index.touch('https://a.example/1');
    expect(index.pages.get('https://a.example/1')).toMatchObject({
      visits: 2,
      ts: T0 + DAY,
      firstTs: T0,
    });
  });

  it('does not retag when the tag options are unchanged', async () => {
    expect(await index.setTagOptions({minScore: 0.2})).toBe(0);
  });
});

describe('meta.textModel', () => {
  const legacy = (value: string | null) => ({getItem: vi.fn(() => value)});

  it('copies the v0.5.0 localStorage model on open', async () => {
    const idb = new IDBFactory();
    const storage = legacy('eg2_440m');
    const index = await new VectorIndex(DIM, idb, 'semhist', {
      legacyStorage: storage,
    }).open();
    expect(storage.getItem).toHaveBeenCalledWith(LEGACY_MODEL_KEY);
    expect(index.textModel).toBe('eg2_440m');
    expect(await readMeta(index.db!, META_TEXT_MODEL)).toBe('eg2_440m');
  });

  it('follows later changes made by the PoC code', async () => {
    const idb = new IDBFactory();
    const open = (value: string | null) =>
      new VectorIndex(DIM, idb, 'semhist', {
        legacyStorage: legacy(value),
      }).open();
    await open('eg2_440m');
    expect((await open('eg2_270m')).textModel).toBe('eg2_270m');
    // Nothing (or junk) in localStorage keeps what meta has.
    expect((await open(null)).textModel).toBe('eg2_270m');
    expect((await open('gpt-4')).textModel).toBe('eg2_270m');
  });

  it('is left alone without legacy storage', async () => {
    const index = await new VectorIndex(DIM, new IDBFactory()).open();
    expect(index.textModel).toBe(null);
    expect(await readTextModel(index.db!)).toBe(null);
    await writeMeta(index.db!, META_TEXT_MODEL, 'unknown-model');
    expect(await readTextModel(index.db!)).toBe(null);
  });
});

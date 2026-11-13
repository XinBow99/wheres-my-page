/**
 * @fileoverview Persistent vector index with categories: IndexedDB for
 * durability, one flat Float32Array in memory for brute-force cosine search.
 *
 * Port of v0.5.0 store.js `VectorIndex` with the same public API (the
 * dist/store.js shim re-exports it to the PoC offscreen code) and the same
 * stored records. Ranking, prototypes and tag picking are the pure functions
 * in src/core; this class owns the records and their persistence.
 *
 * Categories are tagged automatically by comparing each page's vector with a
 * per-category prototype: the description's embedding plus the vectors of
 * pages the user tagged by hand, so manual tags teach the auto-tagger.
 */

import {bestChunkPerPage, scorePage, topByScore} from '../core/search/ranking';
import {queryTerms} from '../core/search/query_terms';
import {meanVec} from '../core/search/vector_math';
import {
  type CategoryScore,
  TAG_DEFAULTS,
  type TagOptions,
  autoTags,
} from '../core/tagging/pick_tags';
import {
  type Prototype,
  buildPrototypes,
  scoreCategories,
} from '../core/tagging/prototypes';
import type {ModelKey} from '../shared/constants';
import type {
  CategoryInfo,
  CategoryList,
  IndexStats,
  PageSource,
  SearchResult,
  Tag,
} from '../shared/types';
import {
  type LegacyStorage,
  META_SEEDED,
  STORES,
  done,
  openDb,
  req,
  syncTextModel,
} from './db';

/** Page fields the caller provides to {@link VectorIndex.upsert}. */
export interface PageInput {
  /** Entry key: page URL, or clip/image URL with its fragment. */
  url: string;
  /** Title. */
  title: string;
  /** Hostname. */
  domain: string;
  /** Text hash (image id for images). */
  hash: string;
  /** Where the entry came from. */
  source: PageSource;
  /** Visit time; defaults to now. */
  ts?: number;
  /** Clip and image fields. */
  parentUrl?: string;
  linkUrl?: string;
  note?: string;
  selector?: string;
  /** Image-only fields. */
  caption?: string;
  srcUrl?: string;
  thumb?: string;
  width?: number;
  height?: number;
  from?: string;
}

/**
 * A stored page. Tag fields are optional because v1 databases lack them.
 */
export interface PageRecord extends PageInput {
  ts: number;
  /** First visit time. */
  firstTs?: number;
  /** Times indexed or revisited. */
  visits?: number;
  /** Chunks stored for the page. */
  chunkCount?: number;
  /** Mean of its chunk vectors; null when it has none. */
  vec?: Float32Array | null;
  /** Categories the user added. */
  tagsManual?: string[];
  /** Categories the user removed. */
  tagsRemoved?: string[];
  /** Auto tags with stored scores. */
  tagsAuto?: CategoryScore[];
}

/** A stored category. */
export interface CategoryRecord {
  id: string;
  name: string;
  description: string;
  color: string;
  builtin: boolean;
  /** Display order. */
  order: number;
  /** Description embedding; null until computed. */
  vec: Float32Array | null;
}

/** A category to create or update with {@link VectorIndex.putCategory}. */
export interface CategoryPut {
  id?: string;
  name?: string;
  description?: string;
  color?: string;
  /** Create the category under `id` if it does not exist (image index sync). */
  allowCreateWithId?: boolean;
}

/** A preset category written on first open. */
export interface PresetInput {
  id: string;
  name: string;
  description: string;
  color: string;
}

/** One in-memory chunk; its vector is the same row of `mat`. */
export interface ChunkRow {
  /** IndexedDB key. */
  id: number;
  url: string;
  /** Position within the page. */
  idx: number;
  text: string;
}

/** Search and browse filters. */
export interface SearchOptions {
  /** Results to return. */
  k?: number;
  /** Only entries visited at or after this time. */
  sinceTs?: number;
  /** Only this hostname. */
  domain?: string;
  /** Category id or `__none__` / `__clips__` / `__images__`. */
  tag?: string;
}

/** Options of the VectorIndex constructor beyond the PoC's. */
export interface VectorIndexOptions {
  /** Sync `meta.textModel` from v0.5.0's localStorage key on open. */
  legacyStorage?: LegacyStorage;
}

/** Stored chunk record. */
interface ChunkRecord {
  id: number;
  url: string;
  idx: number;
  text: string;
  vec: Float32Array;
}

const MS_PER_MB = 1_048_576;

/** Name given to a category saved with an empty name. */
const UNNAMED_CATEGORY = '未命名';

/** Color of a category saved without one. */
const DEFAULT_CATEGORY_COLOR = '#2f5bd3';

/** In-memory vector index over one IndexedDB database. */
export class VectorIndex {
  /** Open database; null before open(). */
  db: IDBDatabase | null = null;
  /** url → page record. */
  readonly pages = new Map<string, PageRecord>();
  /** id → category record, in insertion order. */
  readonly cats = new Map<string, CategoryRecord>();
  /** Chunk rows in matrix order. */
  rows: ChunkRow[] = [];
  /** Row-major chunk vectors, `dim` per row. */
  mat = new Float32Array(0);
  /** Auto-tagging thresholds. */
  tagOpts: TagOptions = {...TAG_DEFAULTS};
  /** Model of the stored text vectors, when legacyStorage was given. */
  textModel: ModelKey | null = null;
  private protos: Map<string, Prototype> | null = null;

  /**
   * @param dim Stored vector dimension.
   * @param idb IndexedDB factory.
   * @param dbName Database name.
   * @param options Extra options.
   */
  constructor(
    readonly dim: number,
    readonly idb: IDBFactory = globalThis.indexedDB,
    readonly dbName = 'semhist',
    private readonly options: VectorIndexOptions = {},
  ) {}

  /**
   * Opens the database and loads everything into memory. Seeds the preset
   * categories once, and fills in page vectors missing from v1 records.
   *
   * @param presets Categories to write on first open.
   * @return This index.
   */
  async open(presets: readonly PresetInput[] = []): Promise<this> {
    const db = await openDb(this.idb, this.dbName);
    this.db = db;

    const tx = db.transaction(
      [STORES.pages, STORES.chunks, STORES.categories, STORES.meta],
      'readonly',
    );
    const pages = (await req(
      tx.objectStore(STORES.pages).getAll(),
    )) as PageRecord[];
    for (const p of pages) this.pages.set(p.url, p);
    const cats = (await req(
      tx.objectStore(STORES.categories).getAll(),
    )) as CategoryRecord[];
    for (const c of cats) this.cats.set(c.id, c);
    const seeded: unknown = await req(
      tx.objectStore(STORES.meta).get(META_SEEDED),
    );
    const chunks = (await req(
      tx.objectStore(STORES.chunks).getAll(),
    )) as ChunkRecord[];
    this.rows = [];
    this.mat = new Float32Array(chunks.length * this.dim);
    chunks.forEach((c, i) => {
      this.rows.push({id: c.id, url: c.url, idx: c.idx, text: c.text});
      this.mat.set(c.vec.subarray(0, this.dim), i * this.dim);
    });

    if (!seeded && presets.length) {
      const wtx = db.transaction([STORES.categories, STORES.meta], 'readwrite');
      presets.forEach((p, i) => {
        const cat = {...p, builtin: true, order: i} as CategoryRecord;
        wtx.objectStore(STORES.categories).put(cat);
        this.cats.set(cat.id, cat);
      });
      wtx.objectStore(STORES.meta).put({key: META_SEEDED, value: true});
      await done(wtx);
    }

    // Migration from v1: pages had no page-level vector.
    const missing = [...this.pages.values()].filter(p => !p.vec);
    if (missing.length) {
      for (const p of missing) p.vec = this.pageVecFromRows(p.url);
      await this.savePages(missing.filter(p => p.vec));
    }

    if (this.options.legacyStorage) {
      this.textModel = await syncTextModel(db, this.options.legacyStorage);
    }
    return this;
  }

  // ---- pages ----------------------------------------------------------------

  /**
   * Whether the stored page text has this hash.
   *
   * @param url Page URL.
   * @param hash Text hash.
   * @return True when a page-sourced entry with the same text exists.
   */
  isCurrent(url: string, hash: string): boolean {
    const p = this.pages.get(url);
    return !!p && p.source === 'page' && p.hash === hash;
  }

  /**
   * Records a revisit of unchanged text.
   *
   * @param url Page URL.
   */
  async touch(url: string): Promise<void> {
    const p = this.pages.get(url);
    if (!p) return;
    p.ts = Date.now();
    p.visits = (p.visits || 1) + 1;
    await this.savePages([p]);
  }

  /**
   * Adds or replaces an entry and its chunks. A history title never replaces
   * an entry indexed from page text, a clip or an image.
   *
   * @param page Page fields.
   * @param chunks Chunk texts.
   * @param vecs Normalized chunk vectors (at least `dim` long), one per chunk.
   * @return False when skipped because of the history rule.
   */
  async upsert(
    page: PageInput,
    chunks: readonly string[],
    vecs: readonly Float32Array[],
  ): Promise<boolean> {
    const prev = this.pages.get(page.url);
    if (prev && prev.source !== 'history' && page.source === 'history') {
      return false;
    }

    await this.deleteChunks(page.url);
    const now = Date.now();
    const rec: PageRecord = {
      ...page,
      ts: page.ts ?? now,
      firstTs: prev?.firstTs ?? page.ts ?? now,
      visits: (prev?.visits || 0) + 1,
      chunkCount: chunks.length,
      vec: meanVec(
        vecs.map(v => v.subarray(0, this.dim)),
        this.dim,
      ),
      tagsManual: prev?.tagsManual || [],
      tagsRemoved: prev?.tagsRemoved || [],
      tagsAuto: [],
    };
    // A manually tagged page's vector feeds prototypes; if it changed, so do they.
    if (rec.tagsManual!.length) this.protos = null;
    this.autoTag(rec);

    const tx = this.database().transaction(
      [STORES.pages, STORES.chunks],
      'readwrite',
    );
    tx.objectStore(STORES.pages).put(rec);
    const store = tx.objectStore(STORES.chunks);
    const newIds = (await Promise.all(
      chunks.map((text, idx) =>
        req(store.add({url: page.url, idx, text, vec: vecs[idx]})),
      ),
    )) as number[];
    await done(tx);

    this.pages.set(page.url, rec);
    const base = this.rows.length;
    const grown = new Float32Array((base + chunks.length) * this.dim);
    grown.set(this.mat);
    chunks.forEach((text, idx) => {
      this.rows.push({id: newIds[idx]!, url: page.url, idx, text});
      grown.set(vecs[idx]!.subarray(0, this.dim), (base + idx) * this.dim);
    });
    this.mat = grown;
    return true;
  }

  /**
   * Removes an entry and its chunks.
   *
   * @param url Entry URL.
   */
  async delete(url: string): Promise<void> {
    const p = this.pages.get(url);
    await this.deleteChunks(url);
    const tx = this.database().transaction(STORES.pages, 'readwrite');
    tx.objectStore(STORES.pages).delete(url);
    await done(tx);
    this.pages.delete(url);
    if (p?.tagsManual?.length) await this.retagAll();
  }

  /**
   * Removes every entry of a hostname.
   *
   * @param domain Hostname.
   * @return Entries removed.
   */
  async deleteDomain(domain: string): Promise<number> {
    const urls = [...this.pages.values()]
      .filter(p => p.domain === domain)
      .map(p => p.url);
    for (const u of urls) await this.delete(u);
    return urls.length;
  }

  /** Removes every entry; categories stay. */
  async clear(): Promise<void> {
    const tx = this.database().transaction(
      [STORES.pages, STORES.chunks],
      'readwrite',
    );
    tx.objectStore(STORES.pages).clear();
    tx.objectStore(STORES.chunks).clear();
    await done(tx);
    this.pages.clear();
    this.rows = [];
    this.mat = new Float32Array(0);
    this.protos = null;
  }

  /**
   * @return Entry counts by source, chunk count and vector memory.
   */
  stats(): IndexStats {
    let page = 0;
    let history = 0;
    let clips = 0;
    let images = 0;
    for (const p of this.pages.values()) {
      if (p.source === 'history') history++;
      else if (p.source === 'clip') clips++;
      else if (p.source === 'image') images++;
      else page++;
    }
    return {
      pages: page,
      historyTitles: history,
      clips,
      images,
      chunks: this.rows.length,
      mb: +(this.mat.byteLength / MS_PER_MB).toFixed(1),
    };
  }

  /**
   * @param parentUrl Page URL.
   * @return Clips and images saved from that page.
   */
  clipsOf(parentUrl: string): PageRecord[] {
    return [...this.pages.values()].filter(
      p =>
        (p.source === 'clip' || p.source === 'image') &&
        p.parentUrl === parentUrl,
    );
  }

  // ---- categories and tagging -----------------------------------------------

  /**
   * @return Categories whose description embedding is missing.
   */
  categoriesNeedingVec(): CategoryRecord[] {
    return [...this.cats.values()].filter(c => !c.vec);
  }

  /**
   * Scores a vector against every category prototype.
   *
   * @param vec Normalized vector.
   * @return Scores, highest first.
   */
  scoreCategories(vec: ArrayLike<number>): CategoryScore[] {
    return scoreCategories(vec, this.prototypes(), this.dim);
  }

  /**
   * Recomputes every page's auto tags (after a category or manual tag
   * change) and saves the pages whose tags changed.
   *
   * @return Pages whose auto tags changed.
   */
  async retagAll(): Promise<number> {
    this.protos = null;
    const changed: PageRecord[] = [];
    for (const p of this.pages.values()) if (this.autoTag(p)) changed.push(p);
    await this.savePages(changed);
    return changed.length;
  }

  /**
   * Changes the auto-tagging thresholds; retags when they changed.
   *
   * @param opts Thresholds to change.
   * @return Pages whose auto tags changed.
   */
  async setTagOptions(opts: Partial<TagOptions>): Promise<number> {
    const next = {...this.tagOpts, ...opts};
    if (JSON.stringify(next) === JSON.stringify(this.tagOpts)) return 0;
    this.tagOpts = next;
    return this.retagAll();
  }

  /**
   * Tags to display: manual first, then auto; unknown categories skipped.
   *
   * @param page Page record.
   * @return Tags.
   */
  tagsOf(page: PageRecord): Tag[] {
    const out: Tag[] = [];
    for (const id of page.tagsManual || []) {
      const c = this.cats.get(id);
      if (c) out.push({id, name: c.name, color: c.color, auto: false});
    }
    for (const t of page.tagsAuto || []) {
      const c = this.cats.get(t.id);
      if (c && !out.some(x => x.id === t.id)) {
        out.push({id: t.id, name: c.name, color: c.color, auto: true, s: t.s});
      }
    }
    return out;
  }

  /**
   * Whether a page matches a tag filter.
   *
   * @param page Page record.
   * @param id Category id, or `__none__`, `__clips__`, `__images__`.
   * @return True when it matches.
   */
  hasTag(page: PageRecord, id: string): boolean {
    if (id === '__none__') {
      return !(page.tagsManual?.length || page.tagsAuto?.length);
    }
    if (id === '__clips__') return page.source === 'clip';
    if (id === '__images__') return page.source === 'image';
    return !!(
      page.tagsManual?.includes(id) || page.tagsAuto?.some(t => t.id === id)
    );
  }

  /**
   * Adds or removes a manual tag, then retags (the prototype learns from it).
   *
   * @param url Entry URL.
   * @param catId Category id.
   * @param on Add (true) or remove (false).
   * @return False when the entry or the category does not exist.
   */
  async setTag(url: string, catId: string, on: boolean): Promise<boolean> {
    const p = this.pages.get(url);
    if (!p || !this.cats.has(catId)) return false;
    const manual = new Set(p.tagsManual || []);
    const removed = new Set(p.tagsRemoved || []);
    if (on) {
      manual.add(catId);
      removed.delete(catId);
    } else {
      manual.delete(catId);
      removed.add(catId);
    }
    p.tagsManual = [...manual];
    p.tagsRemoved = [...removed];
    await this.savePages([p]);
    await this.retagAll();
    return true;
  }

  /**
   * Creates or updates a category, then retags.
   *
   * @param cat Fields; without `id` a new category is created.
   * @param vec New description embedding; null keeps the old one.
   * @return The record, or null for an unknown id.
   */
  async putCategory(
    cat: CategoryPut,
    vec: Float32Array | null,
  ): Promise<CategoryRecord | null> {
    const prev = cat.id ? this.cats.get(cat.id) : undefined;
    const id =
      cat.id ||
      'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (cat.id && !prev && !cat.allowCreateWithId) return null;
    const rec: CategoryRecord = {
      id,
      name: String(cat.name || '').trim() || UNNAMED_CATEGORY,
      description: String(cat.description ?? prev?.description ?? '').trim(),
      color: cat.color || prev?.color || DEFAULT_CATEGORY_COLOR,
      builtin: prev?.builtin || false,
      order: prev?.order ?? this.cats.size,
      vec: vec
        ? Float32Array.from(vec.subarray(0, this.dim))
        : prev?.vec || null,
    };
    const tx = this.database().transaction(STORES.categories, 'readwrite');
    tx.objectStore(STORES.categories).put(rec);
    await done(tx);
    this.cats.set(id, rec);
    await this.retagAll();
    return rec;
  }

  /**
   * Stores a category's description embedding (no retag; callers batch).
   *
   * @param id Category id.
   * @param vec Embedding.
   */
  async setCategoryVec(id: string, vec: Float32Array): Promise<void> {
    const c = this.cats.get(id);
    if (!c) return;
    c.vec = Float32Array.from(vec.subarray(0, this.dim));
    const tx = this.database().transaction(STORES.categories, 'readwrite');
    tx.objectStore(STORES.categories).put(c);
    await done(tx);
    this.protos = null;
  }

  /**
   * Deletes a category and every manual or removed mark of it, then retags.
   *
   * @param id Category id.
   * @return False for an unknown id.
   */
  async deleteCategory(id: string): Promise<boolean> {
    if (!this.cats.has(id)) return false;
    const tx = this.database().transaction(STORES.categories, 'readwrite');
    tx.objectStore(STORES.categories).delete(id);
    await done(tx);
    this.cats.delete(id);
    const touched: PageRecord[] = [];
    for (const p of this.pages.values()) {
      if (p.tagsManual?.includes(id) || p.tagsRemoved?.includes(id)) {
        p.tagsManual = (p.tagsManual || []).filter(x => x !== id);
        p.tagsRemoved = (p.tagsRemoved || []).filter(x => x !== id);
        touched.push(p);
      }
    }
    await this.savePages(touched);
    await this.retagAll();
    return true;
  }

  /**
   * @return Categories in display order with entry counts, plus the count
   *     of untagged entries. `images` is filled in by the caller that merges
   *     the image index.
   */
  listCategories(): {
    categories: Array<Omit<CategoryInfo, 'images'>>;
    uncategorized: CategoryList['uncategorized'];
  } {
    const counts = new Map<string, number>();
    let none = 0;
    for (const p of this.pages.values()) {
      const tags = this.tagsOf(p);
      if (!tags.length) none++;
      for (const t of tags) counts.set(t.id, (counts.get(t.id) || 0) + 1);
    }
    const protos = this.prototypes();
    const categories = [...this.cats.values()]
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map(c => ({
        id: c.id,
        name: c.name,
        description: c.description,
        color: c.color,
        builtin: c.builtin,
        count: counts.get(c.id) || 0,
        ready: !!c.vec,
        examples: protos.get(c.id)?.examples || 0,
      }));
    return {categories, uncategorized: none};
  }

  // ---- search ---------------------------------------------------------------

  /**
   * Hybrid search: each page's best chunk by cosine, plus keyword and
   * recency boosts and the history penalty (src/core/search/ranking).
   *
   * @param qvec Normalized query vector.
   * @param query Query text, for the keyword boost.
   * @param opts Filters and result count (default 20).
   * @return Results, best first.
   */
  search(
    qvec: ArrayLike<number>,
    query: string,
    opts: SearchOptions = {},
  ): SearchResult[] {
    const {k = 20} = opts;
    const terms = queryTerms(query);
    const best = bestChunkPerPage(this.rows, this.mat, this.dim, qvec, url => {
      const page = this.pages.get(url);
      return !!page && this.pass(page, opts);
    });
    const now = Date.now();
    const out: SearchResult[] = [];
    for (const [url, {row, sem}] of best) {
      const page = this.pages.get(url)!;
      const chunk = this.rows[row]!;
      const score = scorePage(page, sem, chunk.text, terms, now);
      out.push(this.result(page, chunk, score));
    }
    return topByScore(out as Array<SearchResult & {score: number}>, k);
  }

  /**
   * Lists entries newest first, without a query.
   *
   * @param opts Filters and result count (default 50).
   * @return Entries with their first chunk as snippet and a null score.
   */
  browse(opts: SearchOptions = {}): SearchResult[] {
    const {k = 50} = opts;
    const firstRow = new Map<string, ChunkRow>();
    for (const r of this.rows) {
      const cur = firstRow.get(r.url);
      if (!cur || r.idx < cur.idx) firstRow.set(r.url, r);
    }
    return [...this.pages.values()]
      .filter(p => this.pass(p, opts))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, k)
      .map(p => this.result(p, firstRow.get(p.url), {score: null}));
  }

  // ---- internals ------------------------------------------------------------

  private database(): IDBDatabase {
    if (!this.db) throw new Error(`${this.dbName}: open() was not called`);
    return this.db;
  }

  private pageVecFromRows(url: string): Float32Array | null {
    const vecs: Float32Array[] = [];
    this.rows.forEach((r, i) => {
      if (r.url === url) {
        vecs.push(this.mat.subarray(i * this.dim, (i + 1) * this.dim));
      }
    });
    return vecs.length ? meanVec(vecs, this.dim) : null;
  }

  private async savePages(pages: readonly PageRecord[]): Promise<void> {
    if (!pages.length) return;
    const tx = this.database().transaction(STORES.pages, 'readwrite');
    for (const p of pages) tx.objectStore(STORES.pages).put(p);
    await done(tx);
  }

  private async deleteChunks(url: string): Promise<void> {
    if (!this.rows.some(r => r.url === url)) return;
    const tx = this.database().transaction(STORES.chunks, 'readwrite');
    const store = tx.objectStore(STORES.chunks);
    const keys = await req(store.index('url').getAllKeys(url));
    for (const k of keys) store.delete(k);
    await done(tx);
    this.compact(r => r.url !== url);
  }

  private compact(keep: (row: ChunkRow) => boolean): void {
    const rows: ChunkRow[] = [];
    const sources: number[] = [];
    this.rows.forEach((r, i) => {
      if (keep(r)) {
        rows.push(r);
        sources.push(i);
      }
    });
    const mat = new Float32Array(rows.length * this.dim);
    sources.forEach((src, dst) => {
      mat.set(
        this.mat.subarray(src * this.dim, (src + 1) * this.dim),
        dst * this.dim,
      );
    });
    this.rows = rows;
    this.mat = mat;
  }

  private prototypes(): Map<string, Prototype> {
    this.protos ??= buildPrototypes(
      this.cats.values(),
      [...this.pages.values()],
      this.dim,
    );
    return this.protos;
  }

  /** Sets `page.tagsAuto`; returns whether it changed. */
  private autoTag(page: PageRecord): boolean {
    if (!page.vec) {
      page.tagsAuto = [];
      return false;
    }
    const before = JSON.stringify(page.tagsAuto || []);
    page.tagsAuto = autoTags(
      this.scoreCategories(page.vec),
      page.tagsManual || [],
      page.tagsRemoved || [],
      this.tagOpts,
    );
    return JSON.stringify(page.tagsAuto) !== before;
  }

  private pass(page: PageRecord, opts: SearchOptions): boolean {
    const {sinceTs = 0, domain = '', tag = ''} = opts;
    if (sinceTs && page.ts < sinceTs) return false;
    if (domain && page.domain !== domain) return false;
    if (tag && !this.hasTag(page, tag)) return false;
    return true;
  }

  private result(
    page: PageRecord,
    row: ChunkRow | undefined,
    extra: {score: number | null; sem?: number; kw?: number},
  ): SearchResult {
    return {
      url: page.url,
      linkUrl: page.linkUrl || page.url,
      parentUrl: page.parentUrl || null,
      note: page.note || '',
      thumb: page.thumb || null,
      title: page.title,
      domain: page.domain,
      ts: page.ts,
      visits: page.visits,
      source: page.source,
      snippet: row?.text || '',
      tags: this.tagsOf(page),
      ...extra,
    };
  }
}

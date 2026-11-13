/**
 * @fileoverview dist/store.js: the v0.5.0 store.js exports, now backed by
 * src/storage and src/core (docs/tasks/todo.md T11).
 */

import {VectorIndex as StorageVectorIndex} from '../storage/vector_index';

export {TAG_DEFAULTS, pickTags} from '../core/tagging/pick_tags';
export {dot, meanVec, normalize, toDim} from '../core/search/vector_math';
export {queryTerms} from '../core/search/query_terms';

/**
 * PoC constructor signature. The text index ("semhist") also mirrors the
 * PoC's localStorage `semhist_model` into `meta.textModel` on open.
 */
export class VectorIndex extends StorageVectorIndex {
  /**
   * @param dim Stored vector dimension.
   * @param idb IndexedDB factory.
   * @param dbName Database name.
   */
  constructor(dim: number, idb = globalThis.indexedDB, dbName = 'semhist') {
    super(
      dim,
      idb,
      dbName,
      dbName === 'semhist' && typeof localStorage !== 'undefined'
        ? {legacyStorage: localStorage}
        : {},
    );
  }
}

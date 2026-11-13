/**
 * @fileoverview IndexedDB access for the vector indexes: schema, promise
 * wrappers and the `meta` store. Runs in the offscreen document only.
 *
 * The schema is v0.5.0's (version 2: pages, chunks with a `url` index,
 * categories, meta); existing profiles open without migration.
 */

import {MODELS, type ModelKey} from '../shared/constants';

/** Schema version; v0.5.0 wrote 2. */
export const DB_VERSION = 2;

/** Object store names. */
export const STORES = Object.freeze({
  pages: 'pages',
  chunks: 'chunks',
  categories: 'categories',
  meta: 'meta',
} as const);

/** `meta` key: preset categories were written once. */
export const META_SEEDED = 'seeded';

/** `meta` key: model that produced the stored text vectors. */
export const META_TEXT_MODEL = 'textModel';

/** localStorage key where v0.5.0 kept the text model. */
export const LEGACY_MODEL_KEY = 'semhist_model';

/** The part of localStorage the model migration reads. */
export interface LegacyStorage {
  /** localStorage.getItem. */
  getItem(key: string): string | null;
}

/**
 * Settles with a request's result.
 *
 * @param r Request.
 * @return Its result; rejects with its error.
 */
export function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/**
 * Settles when a transaction commits.
 *
 * @param tx Transaction.
 * @return Resolves on complete; rejects on error or abort.
 */
export function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

/**
 * Opens (and if needed creates) an index database.
 *
 * @param idb IndexedDB factory.
 * @param name Database name ("semhist" for text, "semhist-img" for images).
 * @return Open database.
 */
export function openDb(idb: IDBFactory, name: string): Promise<IDBDatabase> {
  const open = idb.open(name, DB_VERSION);
  open.onupgradeneeded = () => {
    const db = open.result;
    const has = (s: string) => db.objectStoreNames.contains(s);
    if (!has(STORES.pages))
      db.createObjectStore(STORES.pages, {keyPath: 'url'});
    if (!has(STORES.chunks)) {
      db.createObjectStore(STORES.chunks, {
        keyPath: 'id',
        autoIncrement: true,
      }).createIndex('url', 'url');
    }
    if (!has(STORES.categories)) {
      db.createObjectStore(STORES.categories, {keyPath: 'id'});
    }
    if (!has(STORES.meta)) db.createObjectStore(STORES.meta, {keyPath: 'key'});
  };
  return req(open);
}

/**
 * Reads a `meta` value.
 *
 * @param db Open database.
 * @param key Meta key.
 * @return Stored value, or undefined.
 */
export async function readMeta(db: IDBDatabase, key: string): Promise<unknown> {
  const tx = db.transaction(STORES.meta, 'readonly');
  const row: unknown = await req(tx.objectStore(STORES.meta).get(key));
  return typeof row === 'object' && row !== null && 'value' in row
    ? row.value
    : undefined;
}

/**
 * Writes a `meta` value.
 *
 * @param db Open database.
 * @param key Meta key.
 * @param value Structured-cloneable value.
 */
export async function writeMeta(
  db: IDBDatabase,
  key: string,
  value: unknown,
): Promise<void> {
  const tx = db.transaction(STORES.meta, 'readwrite');
  tx.objectStore(STORES.meta).put({key, value});
  await done(tx);
}

/**
 * Whether `x` names a known model.
 *
 * @param x Value.
 * @return True for a MODELS key.
 */
function isModelKey(x: unknown): x is ModelKey {
  return typeof x === 'string' && Object.hasOwn(MODELS, x);
}

/**
 * Model of the stored text vectors.
 *
 * @param db Open text database.
 * @return Model key, or null when nothing was indexed yet.
 */
export async function readTextModel(db: IDBDatabase): Promise<ModelKey | null> {
  const value = await readMeta(db, META_TEXT_MODEL);
  return isModelKey(value) ? value : null;
}

/**
 * Brings `meta.textModel` in line with v0.5.0's localStorage key. While the
 * PoC offscreen code runs (strangler phase) it keeps writing localStorage,
 * so localStorage stays the source of truth and is copied on every open;
 * the key is left in place for that code.
 *
 * @param db Open text database.
 * @param legacy localStorage of the offscreen document.
 * @return The text model after syncing, or null.
 */
export async function syncTextModel(
  db: IDBDatabase,
  legacy: LegacyStorage,
): Promise<ModelKey | null> {
  const stored = await readTextModel(db);
  const legacyValue = legacy.getItem(LEGACY_MODEL_KEY);
  if (!isModelKey(legacyValue) || legacyValue === stored) return stored;
  await writeMeta(db, META_TEXT_MODEL, legacyValue);
  return legacyValue;
}

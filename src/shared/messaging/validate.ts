/**
 * @fileoverview Runtime validation of incoming messages (SPEC D2:
 * hand-written type guards, no schema library).
 *
 * A receiver calls {@link validateEnvelope} on whatever chrome.runtime
 * delivered; nothing reaches a handler unless its payload passes the guard
 * for its type. Guards reject missing fields, wrong types, unknown fields,
 * non-finite numbers and strings over their limit.
 */

import {type ErrorCode, type Result, type WireError} from '../errors';
import {MODELS, type ModelKey} from '../constants';
import type {CategoryInput, Rect} from '../types';
import {
  type ClipRequest,
  type EmptyRequest,
  type EngineSettings,
  type Envelope,
  type HistoryItem,
  type ImageRequest,
  type IndexPageRequest,
  MAX_CLIP_TEXT_LENGTH,
  MAX_IMAGE_DATA_URL_LENGTH,
  MAX_PAGE_TEXT_LENGTH,
  type MessageType,
  type OffscreenImageRequest,
  PROTOCOL_VERSION,
  type RequestOf,
  type SearchRequest,
  type Target,
} from './contract';

/**
 * A type guard over untrusted input.
 *
 * @template T Type it narrows to.
 */
export type Guard<T> = (x: unknown) => x is T;

/** Longest URL accepted (Chrome itself caps URLs at 2 MB; pages use far less). */
export const MAX_URL_LENGTH = 8_192;

/** Longest title, note, caption, selector or other short text. */
export const MAX_SHORT_TEXT_LENGTH = 4_096;

/** Longest search query. */
export const MAX_QUERY_LENGTH = 1_000;

/** Longest id, hostname, color or tag filter. */
export const MAX_NAME_LENGTH = 256;

/** Longest visible-tab screenshot data URL (a 4K PNG in base64). */
export const MAX_SCREENSHOT_DATA_URL_LENGTH = 32 * 1024 * 1024;

/** Most history entries in one import (v0.5.0 asked for at most 3000). */
export const MAX_HISTORY_ITEMS = 10_000;

/** Most results one search may ask for. */
export const MAX_RESULTS = 500;

/** Longest history window to import, in days. */
export const MAX_HISTORY_DAYS = 3_650;

/** Largest devicePixelRatio accepted. */
const MAX_DPR = 16;

// ---- building blocks --------------------------------------------------------

/**
 * Whether `x` is a plain object (what JSON deserialization produces).
 *
 * @param x Value.
 * @return True for `{…}` objects, false for arrays, null and class instances.
 */
function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const proto: unknown = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

/**
 * String guard.
 *
 * @param max Longest length in UTF-16 code units.
 * @param min Shortest length.
 * @return Guard.
 */
function str(max: number, min = 0): Guard<string> {
  return (x): x is string =>
    typeof x === 'string' && x.length >= min && x.length <= max;
}

/**
 * Finite number guard.
 *
 * @param min Smallest value.
 * @param max Largest value.
 * @param integer Whether only integers pass.
 * @return Guard.
 */
function num(min: number, max: number, integer = false): Guard<number> {
  return (x): x is number =>
    typeof x === 'number' &&
    Number.isFinite(x) &&
    x >= min &&
    x <= max &&
    (!integer || Number.isInteger(x));
}

const bool: Guard<boolean> = (x): x is boolean => typeof x === 'boolean';

/**
 * Guard for one of a fixed set of strings.
 *
 * @param values Allowed values.
 * @return Guard.
 */
function oneOf<T extends string>(values: readonly T[]): Guard<T> {
  return (x): x is T => typeof x === 'string' && values.some(v => v === x);
}

/**
 * Guard that also accepts null.
 *
 * @param guard Guard for non-null values.
 * @return Guard.
 */
function nullable<T>(guard: Guard<T>): Guard<T | null> {
  return (x): x is T | null => x === null || guard(x);
}

/**
 * Guard for an optional field: absent (undefined) or valid.
 *
 * @param guard Guard for present values.
 * @return Guard.
 */
function optional<T>(guard: Guard<T>): Guard<T | undefined> {
  return (x): x is T | undefined => x === undefined || guard(x);
}

/**
 * Array guard.
 *
 * @param guard Guard for each element.
 * @param max Most elements.
 * @return Guard.
 */
function arrayOf<T>(guard: Guard<T>, max: number): Guard<readonly T[]> {
  return (x): x is readonly T[] =>
    Array.isArray(x) && x.length <= max && x.every(e => guard(e));
}

/**
 * One guard per field of `T`; optional fields take an {@link optional}
 * guard.
 *
 * @template T Object type.
 */
type Fields<T> = {readonly [K in keyof T]-?: Guard<Pick<T, K>[K]>};

/**
 * Plain-object guard: every listed field passes its guard and no other field
 * is present.
 *
 * @param fields Guard per field.
 * @return Guard.
 */
function objectOf<T>(fields: Fields<T>): Guard<T> {
  const keys = Object.keys(fields) as Array<keyof T & string>;
  return (x): x is T =>
    isPlainObject(x) &&
    Object.keys(x).every(k => Object.hasOwn(fields, k)) &&
    keys.every(k => fields[k](x[k]));
}

const url = str(MAX_URL_LENGTH, 1);
const shortText = str(MAX_SHORT_TEXT_LENGTH);
const name = str(MAX_NAME_LENGTH);
const id = str(MAX_NAME_LENGTH, 1);
const timestamp = num(0, Number.MAX_SAFE_INTEGER);
const coordinate = num(-1e6, 1e6);
const extent = num(0, 1e6);

const isRect: Guard<Rect> = objectOf<Rect>({
  left: coordinate,
  top: coordinate,
  width: extent,
  height: extent,
});

/**
 * Data URL guard.
 *
 * @param max Longest length.
 * @return Guard.
 */
function dataUrl(max: number): Guard<string> {
  const s = str(max);
  return (x): x is string => s(x) && x.startsWith('data:');
}

// ---- requests ---------------------------------------------------------------

/** Request with no fields: `{}`. */
export const isEmptyRequest: Guard<EmptyRequest> = objectOf<EmptyRequest>({});

/** `index.page`. */
export const isIndexPageRequest: Guard<IndexPageRequest> =
  objectOf<IndexPageRequest>({
    url,
    title: shortText,
    text: str(MAX_PAGE_TEXT_LENGTH),
  });

/** `index.clip`. */
export const isClipRequest: Guard<ClipRequest> = objectOf<ClipRequest>({
  parentUrl: url,
  linkUrl: url,
  title: shortText,
  text: str(MAX_CLIP_TEXT_LENGTH),
  note: shortText,
  selector: shortText,
});

const imageFields: Fields<ImageRequest> = {
  parentUrl: url,
  linkUrl: url,
  title: shortText,
  caption: shortText,
  note: shortText,
  srcUrl: str(MAX_URL_LENGTH),
  selector: shortText,
  auto: bool,
  image: nullable(dataUrl(MAX_IMAGE_DATA_URL_LENGTH)),
  rect: nullable(isRect),
  dpr: num(Number.MIN_VALUE, MAX_DPR),
};

/** `index.image` from a content script. */
export const isImageRequest: Guard<ImageRequest> =
  objectOf<ImageRequest>(imageFields);

/** `index.image` forwarded to the offscreen document. */
export const isOffscreenImageRequest: Guard<OffscreenImageRequest> =
  objectOf<OffscreenImageRequest>({
    ...imageFields,
    shot: nullable(dataUrl(MAX_SCREENSHOT_DATA_URL_LENGTH)),
  });

/** Requests that only name a page: `page.info`, `index.deletePage`, … */
export const isUrlRequest: Guard<{readonly url: string}> = objectOf<{
  readonly url: string;
}>({url});

/** `tag.set`. */
export const isTagSetRequest: Guard<RequestOf<'background', 'tag.set'>> =
  objectOf<RequestOf<'background', 'tag.set'>>({url, catId: id, on: bool});

/** `search.query`. */
export const isSearchRequest: Guard<SearchRequest> = objectOf<SearchRequest>({
  query: str(MAX_QUERY_LENGTH),
  k: num(1, MAX_RESULTS, true),
  sinceTs: timestamp,
  domain: name,
  tag: name,
});

/** `index.deleteDomain`. */
export const isDeleteDomainRequest: Guard<
  RequestOf<'background', 'index.deleteDomain'>
> = objectOf<RequestOf<'background', 'index.deleteDomain'>>({domain: id});

/** `history.import` from an extension page. */
export const isHistoryImportRequest: Guard<
  RequestOf<'background', 'history.import'>
> = objectOf<RequestOf<'background', 'history.import'>>({
  days: num(1, MAX_HISTORY_DAYS, true),
  max: optional(num(1, MAX_HISTORY_ITEMS, true)),
});

const isHistoryItem: Guard<HistoryItem> = objectOf<HistoryItem>({
  url,
  title: shortText,
  lastVisitTime: timestamp,
});

/** `history.import` forwarded to the offscreen document. */
export const isHistoryItemsRequest: Guard<
  RequestOf<'offscreen', 'history.import'>
> = objectOf<RequestOf<'offscreen', 'history.import'>>({
  items: arrayOf(isHistoryItem, MAX_HISTORY_ITEMS),
});

/** `category.put`. */
export const isCategoryPutRequest: Guard<
  RequestOf<'background', 'category.put'>
> = objectOf<RequestOf<'background', 'category.put'>>({
  cat: objectOf<CategoryInput>({
    id: optional(id),
    name: str(MAX_NAME_LENGTH, 1),
    description: shortText,
    color: name,
  }),
});

/** `category.delete`. */
export const isCategoryDeleteRequest: Guard<
  RequestOf<'background', 'category.delete'>
> = objectOf<RequestOf<'background', 'category.delete'>>({id});

/** `ui.openSearch`. */
export const isOpenSearchRequest: Guard<
  RequestOf<'background', 'ui.openSearch'>
> = objectOf<RequestOf<'background', 'ui.openSearch'>>({
  q: str(MAX_QUERY_LENGTH),
});

/** `settings.sync`. */
export const isEngineSettings: Guard<EngineSettings> = objectOf<EngineSettings>(
  {
    model: oneOf(Object.keys(MODELS) as ModelKey[]),
    tagMinScore: num(0, 1),
  },
);

/** `clip.selection`. */
export const isClipSelectionRequest: Guard<
  RequestOf<'content', 'clip.selection'>
> = objectOf<RequestOf<'content', 'clip.selection'>>({
  text: str(MAX_CLIP_TEXT_LENGTH),
});

/** `clip.image`. */
export const isClipImageRequest: Guard<RequestOf<'content', 'clip.image'>> =
  objectOf<RequestOf<'content', 'clip.image'>>({srcUrl: str(MAX_URL_LENGTH)});

/** The payload guard of every message; the mapped type forces full coverage. */
export const REQUEST_GUARDS: {
  readonly [T in Target]: {
    readonly [K in MessageType<T>]: Guard<RequestOf<T, K>>;
  };
} = Object.freeze({
  background: Object.freeze({
    'index.page': isIndexPageRequest,
    'index.clip': isClipRequest,
    'index.image': isImageRequest,
    'page.info': isUrlRequest,
    'index.deletePage': isUrlRequest,
    'tag.set': isTagSetRequest,
    'ui.openSearch': isOpenSearchRequest,
    'policy.isDenied': isUrlRequest,
    'status.get': isEmptyRequest,
    'search.query': isSearchRequest,
    'model.load': isEmptyRequest,
    'index.domains': isEmptyRequest,
    'index.deleteDomain': isDeleteDomainRequest,
    'index.clear': isEmptyRequest,
    'history.import': isHistoryImportRequest,
    'category.list': isEmptyRequest,
    'category.put': isCategoryPutRequest,
    'category.delete': isCategoryDeleteRequest,
    'category.scorePage': isUrlRequest,
  }),
  offscreen: Object.freeze({
    'index.page': isIndexPageRequest,
    'index.clip': isClipRequest,
    'index.image': isOffscreenImageRequest,
    'page.info': isUrlRequest,
    'index.deletePage': isUrlRequest,
    'tag.set': isTagSetRequest,
    'status.get': isEmptyRequest,
    'search.query': isSearchRequest,
    'model.load': isEmptyRequest,
    'index.domains': isEmptyRequest,
    'index.deleteDomain': isDeleteDomainRequest,
    'index.clear': isEmptyRequest,
    'history.import': isHistoryItemsRequest,
    'category.list': isEmptyRequest,
    'category.put': isCategoryPutRequest,
    'category.delete': isCategoryDeleteRequest,
    'category.scorePage': isUrlRequest,
    'settings.sync': isEngineSettings,
  }),
  content: Object.freeze({
    'index.now': isEmptyRequest,
    'picker.start': isEmptyRequest,
    'clip.context': isEmptyRequest,
    'clip.selection': isClipSelectionRequest,
    'clip.image': isClipImageRequest,
  }),
});

// ---- envelope ---------------------------------------------------------------

const ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  'v',
  'target',
  'type',
  'payload',
]);

/**
 * INVALID_MESSAGE error.
 *
 * @param message What was wrong.
 * @return Failed result.
 */
function invalid(message: string): {ok: false; error: WireError} {
  const code: ErrorCode = 'INVALID_MESSAGE';
  return {ok: false, error: {code, message, retryable: false}};
}

/**
 * Checks a received message: envelope shape, protocol version, receiving
 * context, a known type and a payload that passes that type's guard.
 *
 * @param x Received value.
 * @param target Context doing the check.
 * @return The envelope, or INVALID_MESSAGE saying what failed.
 */
export function validateEnvelope<T extends Target>(
  x: unknown,
  target: T,
): Result<Envelope<T>> {
  if (!isPlainObject(x)) return invalid('message is not an object');
  const extra = Object.keys(x).filter(k => !ENVELOPE_KEYS.has(k));
  if (extra.length)
    return invalid(`unknown envelope fields: ${extra.join(', ')}`);
  if (x['v'] !== PROTOCOL_VERSION) {
    return invalid(
      `protocol version ${String(x['v'])}, expected ${PROTOCOL_VERSION}`,
    );
  }
  if (x['target'] !== target) {
    return invalid(`target ${String(x['target'])}, expected ${target}`);
  }
  const type = x['type'];
  const guards: Readonly<Record<string, Guard<unknown>>> =
    REQUEST_GUARDS[target];
  if (typeof type !== 'string' || !Object.hasOwn(guards, type)) {
    return invalid(`unknown message type ${String(type)} for ${target}`);
  }
  if (!guards[type]!(x['payload'])) {
    return invalid(`invalid payload for ${type}`);
  }
  return {ok: true, data: x as unknown as Envelope<T>};
}

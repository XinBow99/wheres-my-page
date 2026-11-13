/**
 * @fileoverview The messaging contract: every request/response pair that
 * crosses a context boundary, who may send it, and how long to wait for it
 * (docs/SPEC.md "通訊契約").
 *
 * Direction: content scripts and extension pages → background → offscreen;
 * background and extension pages → content (chrome.tabs.sendMessage). UI
 * never talks to the offscreen document directly.
 *
 * Every payload and reply must survive JSON serialization; {@link Checked}
 * rejects a map whose types do not (e.g. a Float32Array vector).
 */

import type {ModelKey} from '../constants';
import type {
  CategoryInput,
  CategoryList,
  CategoryScore,
  EngineStatus,
  Jsonable,
  PageInfo,
  Rect,
  SearchResult,
  Tag,
} from '../types';

/** Wire protocol version; a content script left over from an update fails loudly. */
export const PROTOCOL_VERSION = 1;

/** Context that receives a message. */
export type Target = 'background' | 'offscreen' | 'content';

/**
 * Kind of sender, as the router classifies it: an extension page (popup,
 * search page, side panel), a content script (sender has a tab and a
 * non-extension URL), or the service worker.
 */
export type Sender = 'extension-page' | 'content-script' | 'background';

/** Request with no fields. */
export type EmptyRequest = Record<string, never>;

/**
 * Why a page was not indexed. Not an error: the badge shows it as
 * "not indexed" with the reason.
 */
export type SkipReason =
  /** Automatic indexing is off. */
  | 'disabled'
  /** Incognito tab. */
  | 'incognito'
  /** URL matches the denylist. */
  | 'denylist'
  /** Text produced no chunks. */
  | 'empty'
  /** Too little text on the page (content script). */
  | 'no-content'
  /** A password field is visible (content script). */
  | 'secret-input';

/** Outcome of indexing a page. */
export type IndexOutcome =
  | {
      readonly kind: 'indexed';
      /** Chunks written. */
      readonly chunks: number;
      /** Tags after indexing. */
      readonly tags: readonly Tag[];
    }
  | {
      /** Same text as already stored; only the visit was recorded. */
      readonly kind: 'unchanged';
      /** Stored tags. */
      readonly tags: readonly Tag[];
    }
  | {readonly kind: 'skipped'; readonly reason: SkipReason};

/** A page to index. */
export interface IndexPageRequest {
  /** Canonical page URL. */
  readonly url: string;
  /** Page title. */
  readonly title: string;
  /** Extracted text, at most MAX_PAGE_TEXT_LENGTH. */
  readonly text: string;
}

/** A text block the user picked or selected. */
export interface ClipRequest {
  /** Canonical URL of the page. */
  readonly parentUrl: string;
  /** Page URL with a text fragment pointing at the block. */
  readonly linkUrl: string;
  /** Page title. */
  readonly title: string;
  /** Block text, at most MAX_CLIP_TEXT_LENGTH. */
  readonly text: string;
  /** User note. */
  readonly note: string;
  /** CSS path of the block; empty for a selection. */
  readonly selector: string;
}

/** A saved clip. */
export interface ClipResult {
  /** Entry URL (`parentUrl#semhist-clip-<hash>`). */
  readonly url: string;
  /** Text hash. */
  readonly hash: string;
  /** Chunks written. */
  readonly chunks: number;
  /** Tags of the clip. */
  readonly tags: readonly Tag[];
}

/** An image the user picked, or one found by the automatic image pass. */
export interface ImageRequest {
  /** Canonical URL of the page. */
  readonly parentUrl: string;
  /** Page URL, with a text fragment at the caption when there is one. */
  readonly linkUrl: string;
  /** Page title. */
  readonly title: string;
  /** Nearby caption text. */
  readonly caption: string;
  /** User note. */
  readonly note: string;
  /** Image source URL; empty for canvas, SVG or CSS backgrounds. */
  readonly srcUrl: string;
  /** CSS path of the element. */
  readonly selector: string;
  /** Automatic pass: follows the page-indexing rules, never screenshots. */
  readonly auto: boolean;
  /**
   * Original image as a data URL, fetched by the content script under the
   * page's CORS rules (SPEC D6); null when it could not be fetched.
   */
  readonly image: string | null;
  /** Element rectangle for the screenshot fallback; null on the auto pass. */
  readonly rect: Rect | null;
  /** devicePixelRatio of the tab. */
  readonly dpr: number;
}

/** {@link ImageRequest} as forwarded to the offscreen document. */
export interface OffscreenImageRequest extends ImageRequest {
  /**
   * Visible-tab screenshot as a PNG data URL, taken by the background when
   * `image` is null; `rect` and `dpr` locate the element in it.
   */
  readonly shot: string | null;
}

/** Outcome of indexing an image. */
export type ImageOutcome =
  | {
      readonly kind: 'indexed';
      /** Entry URL (`parentUrl#semhist-img-<id>`). */
      readonly url: string;
      /** Image id. */
      readonly hash: string;
      /** Whether the pixels came from the original file or a screenshot. */
      readonly from: 'original' | 'screenshot';
      /** Tags of the image. */
      readonly tags: readonly Tag[];
    }
  | {
      readonly kind: 'skipped';
      /** `exists`: the auto pass already has this image. */
      readonly reason: 'disabled' | 'denylist' | 'exists';
    };

/** Badge and picker check of the current page. */
export type PageCheck =
  | {readonly state: 'disabled'}
  | {readonly state: 'denied'; readonly reason: 'incognito' | 'denylist'}
  | {readonly state: 'allowed'; readonly info: PageInfo};

/** Search or browse (empty query) request. */
export interface SearchRequest {
  /** Query text; empty to browse newest first. */
  readonly query: string;
  /** Maximum text results. */
  readonly k: number;
  /** Only entries visited at or after this time (ms); 0 for no limit. */
  readonly sinceTs: number;
  /** Only this hostname; empty for all. */
  readonly domain: string;
  /**
   * Category id, or a pseudo-category: `__images__`, `__clips__`,
   * `__none__`. Empty for all.
   */
  readonly tag: string;
}

/** Search results. */
export interface SearchResponse {
  /** Text results. */
  readonly results: readonly SearchResult[];
  /** Image results. */
  readonly images: readonly SearchResult[];
  /** Search time in ms; missing when the index is empty. */
  readonly ms?: number;
  /** The index is empty. */
  readonly empty?: boolean;
  /** Results are a listing, not a ranked search. */
  readonly browse?: boolean;
}

/** One history entry passed to the offscreen document for import. */
export interface HistoryItem {
  /** Page URL. */
  readonly url: string;
  /** Page title. */
  readonly title: string;
  /** Last visit, ms since epoch. */
  readonly lastVisitTime: number;
}

/** Settings the offscreen document needs (it cannot read chrome.storage). */
export interface EngineSettings {
  /** Text model. */
  readonly model: ModelKey;
  /** Auto-tagging threshold. */
  readonly tagMinScore: number;
}

/** Tags of an entry after a change. */
export interface TagsReply {
  /** Current tags. */
  readonly tags: readonly Tag[];
}

/** Pages per hostname, most first. */
export interface DomainsReply {
  /** `[hostname, entry count]` pairs. */
  readonly domains: ReadonlyArray<readonly [string, number]>;
}

/** Category list after a create or update, with the affected id. */
export interface CategoryPutReply extends CategoryList {
  /** Id of the created or updated category. */
  readonly id: string;
}

/**
 * Requests both the background and the offscreen document handle with the
 * same payload (the background applies policy, then forwards).
 */
interface ForwardedRequests {
  'index.page': {req: IndexPageRequest; res: IndexOutcome};
  'index.clip': {req: ClipRequest; res: ClipResult};
  'tag.set': {
    req: {
      readonly url: string;
      readonly catId: string;
      readonly on: boolean;
    };
    res: TagsReply;
  };
  'index.deletePage': {req: {readonly url: string}; res: null};
  'status.get': {req: EmptyRequest; res: EngineStatus};
  'search.query': {req: SearchRequest; res: SearchResponse};
  'model.load': {req: EmptyRequest; res: null};
  'index.domains': {req: EmptyRequest; res: DomainsReply};
  'index.deleteDomain': {
    req: {readonly domain: string};
    res: {readonly removed: number};
  };
  'index.clear': {req: EmptyRequest; res: null};
  'category.list': {req: EmptyRequest; res: CategoryList};
  'category.put': {req: {readonly cat: CategoryInput}; res: CategoryPutReply};
  'category.delete': {req: {readonly id: string}; res: CategoryList};
  'category.scorePage': {
    req: {readonly url: string};
    res: {readonly scores: readonly CategoryScore[]};
  };
}

/**
 * A request map whose every payload and reply is JSON-serializable. A type
 * that is not (a Float32Array, Map, Date, function, …) fails here.
 *
 * @template M Map from message type to `{req, res}`.
 */
export type Checked<
  M extends {
    [K in keyof M]: {
      req: Jsonable<M[K]['req']>;
      res: Jsonable<M[K]['res']>;
    };
  },
> = M;

/** Requests handled by the service worker. */
export type BackgroundRequests = Checked<
  ForwardedRequests & {
    'index.image': {req: ImageRequest; res: ImageOutcome};
    'page.info': {req: {readonly url: string}; res: PageCheck};
    'history.import': {
      req: {readonly days: number; readonly max?: number};
      res: {readonly added: number};
    };
    'ui.openSearch': {req: {readonly q: string}; res: null};
    'policy.isDenied': {
      req: {readonly url: string};
      res: {readonly denied: boolean};
    };
  }
>;

/** Requests handled by the offscreen document (sent by the background only). */
export type OffscreenRequests = Checked<
  ForwardedRequests & {
    'index.image': {req: OffscreenImageRequest; res: ImageOutcome};
    'page.info': {req: {readonly url: string}; res: PageInfo};
    'history.import': {
      req: {readonly items: readonly HistoryItem[]};
      res: {readonly added: number};
    };
    /** Pushed by the background whenever the settings change. */
    'settings.sync': {req: EngineSettings; res: null};
  }
>;

/** Requests handled by content scripts (chrome.tabs.sendMessage). */
export type ContentRequests = Checked<{
  /** Index the page now, ignoring dwell time; replies when done. */
  'index.now': {req: EmptyRequest; res: IndexOutcome};
  'picker.start': {req: EmptyRequest; res: null};
  /** Context menu "index this block" on the right-clicked element. */
  'clip.context': {req: EmptyRequest; res: null};
  'clip.selection': {req: {readonly text: string}; res: null};
  'clip.image': {req: {readonly srcUrl: string}; res: null};
}>;

/** Every message, by receiving context. */
export interface RequestMap {
  /** Service worker. */
  background: BackgroundRequests;
  /** Offscreen document. */
  offscreen: OffscreenRequests;
  /** Content scripts. */
  content: ContentRequests;
}

/**
 * Message types a context handles.
 *
 * @template T Receiving context.
 */
export type MessageType<T extends Target> = keyof RequestMap[T] & string;

/**
 * Payload of a message.
 *
 * @template T Receiving context.
 * @template K Message type.
 */
export type RequestOf<
  T extends Target,
  K extends MessageType<T>,
> = RequestMap[T][K] extends {req: infer R} ? R : never;

/**
 * Reply data of a message (inside Result).
 *
 * @template T Receiving context.
 * @template K Message type.
 */
export type ResponseOf<
  T extends Target,
  K extends MessageType<T>,
> = RequestMap[T][K] extends {res: infer R} ? R : never;

/**
 * Wire envelope of a request.
 *
 * @template T Receiving context.
 * @template K Message type.
 */
export interface Envelope<
  T extends Target = Target,
  K extends MessageType<T> = MessageType<T>,
> {
  /** Protocol version; see PROTOCOL_VERSION. */
  readonly v: typeof PROTOCOL_VERSION;
  /** Receiving context. */
  readonly target: T;
  /** Message type. */
  readonly type: K;
  /** Request payload. */
  readonly payload: RequestOf<T, K>;
}

/** Delivery rules of one message type. */
export interface MessageSpec {
  /** Senders the router accepts; any other gets DENIED. */
  readonly allowedFrom: readonly Sender[];
  /** Default reply timeout in ms; callers may override. */
  readonly timeoutMs: number;
}

/** Longest page text a content script sends (v0.5.0 MAX_TEXT). */
export const MAX_PAGE_TEXT_LENGTH = 30_000;

/** Longest clip text the picker sends (v0.5.0 MAX_CLIP). */
export const MAX_CLIP_TEXT_LENGTH = 8_000;

/** Largest image data URL accepted, in UTF-16 code units (SPEC D6: 8 MB). */
export const MAX_IMAGE_DATA_URL_LENGTH = 8 * 1024 * 1024;

/** Replies that only read in-memory state. */
const QUICK_MS = 5_000;

/** Replies that wait for the offscreen document and the database to open. */
const OPEN_MS = 15_000;

/**
 * Replies that may first download and load a model (hundreds of MB on the
 * first run); progress is reported over a Port, not by this timeout.
 */
const MODEL_MS = 5 * 60_000;

/** History import: a model load plus one embedding per history entry. */
const IMPORT_MS = 30 * 60_000;

/** "Index now" in a tab: v0.5.0 waited 60 s for the state machine. */
const INDEX_NOW_MS = 65_000;

const EXTENSION_PAGE: readonly Sender[] = Object.freeze(['extension-page']);
const CONTENT_SCRIPT: readonly Sender[] = Object.freeze(['content-script']);
const ANY_PAGE: readonly Sender[] = Object.freeze([
  'content-script',
  'extension-page',
]);
const BACKGROUND: readonly Sender[] = Object.freeze(['background']);
const TO_TAB: readonly Sender[] = Object.freeze([
  'background',
  'extension-page',
]);

/**
 * Builds a frozen MessageSpec.
 *
 * @param allowedFrom Accepted senders.
 * @param timeoutMs Default timeout.
 * @return The spec.
 */
function spec(allowedFrom: readonly Sender[], timeoutMs: number): MessageSpec {
  return Object.freeze({allowedFrom, timeoutMs});
}

/**
 * Background messages that delete data or act with extension privileges.
 * Only extension pages may send them: a compromised renderer can forge
 * content-script messages (Chrome "message passing" security guidance).
 */
export const PRIVILEGED_MESSAGES: ReadonlyArray<MessageType<'background'>> =
  Object.freeze([
    'index.clear',
    'index.deleteDomain',
    'history.import',
    'category.put',
    'category.delete',
  ]);

/** Delivery rules for every message; the mapped type forces full coverage. */
export const MESSAGE_SPECS: {
  readonly [T in Target]: {readonly [K in MessageType<T>]: MessageSpec};
} = Object.freeze({
  background: Object.freeze({
    'index.page': spec(CONTENT_SCRIPT, MODEL_MS),
    'index.clip': spec(CONTENT_SCRIPT, MODEL_MS),
    'index.image': spec(CONTENT_SCRIPT, MODEL_MS),
    'page.info': spec(CONTENT_SCRIPT, OPEN_MS),
    // The badge and the picker remove their own page's entries; the
    // background must check the URL belongs to the sender's tab.
    'index.deletePage': spec(ANY_PAGE, OPEN_MS),
    'tag.set': spec(ANY_PAGE, OPEN_MS),
    'ui.openSearch': spec(ANY_PAGE, QUICK_MS),
    'policy.isDenied': spec(EXTENSION_PAGE, QUICK_MS),
    'status.get': spec(EXTENSION_PAGE, OPEN_MS),
    'search.query': spec(EXTENSION_PAGE, MODEL_MS),
    'model.load': spec(EXTENSION_PAGE, MODEL_MS),
    'index.domains': spec(EXTENSION_PAGE, OPEN_MS),
    'index.deleteDomain': spec(EXTENSION_PAGE, OPEN_MS),
    'index.clear': spec(EXTENSION_PAGE, OPEN_MS),
    'history.import': spec(EXTENSION_PAGE, IMPORT_MS),
    'category.list': spec(EXTENSION_PAGE, OPEN_MS),
    'category.put': spec(EXTENSION_PAGE, MODEL_MS),
    'category.delete': spec(EXTENSION_PAGE, OPEN_MS),
    'category.scorePage': spec(EXTENSION_PAGE, OPEN_MS),
  }),
  offscreen: Object.freeze({
    'index.page': spec(BACKGROUND, MODEL_MS),
    'index.clip': spec(BACKGROUND, MODEL_MS),
    'index.image': spec(BACKGROUND, MODEL_MS),
    'page.info': spec(BACKGROUND, OPEN_MS),
    'index.deletePage': spec(BACKGROUND, OPEN_MS),
    'tag.set': spec(BACKGROUND, OPEN_MS),
    'status.get': spec(BACKGROUND, OPEN_MS),
    'search.query': spec(BACKGROUND, MODEL_MS),
    'model.load': spec(BACKGROUND, MODEL_MS),
    'index.domains': spec(BACKGROUND, OPEN_MS),
    'index.deleteDomain': spec(BACKGROUND, OPEN_MS),
    'index.clear': spec(BACKGROUND, OPEN_MS),
    'history.import': spec(BACKGROUND, IMPORT_MS),
    'category.list': spec(BACKGROUND, OPEN_MS),
    'category.put': spec(BACKGROUND, MODEL_MS),
    'category.delete': spec(BACKGROUND, OPEN_MS),
    'category.scorePage': spec(BACKGROUND, OPEN_MS),
    'settings.sync': spec(BACKGROUND, OPEN_MS),
  }),
  content: Object.freeze({
    'index.now': spec(TO_TAB, INDEX_NOW_MS),
    'picker.start': spec(TO_TAB, QUICK_MS),
    'clip.context': spec(TO_TAB, QUICK_MS),
    'clip.selection': spec(TO_TAB, QUICK_MS),
    'clip.image': spec(TO_TAB, QUICK_MS),
  }),
});

/** A message type in some context. */
export type AnyMessageType = {[T in Target]: MessageType<T>}[Target];

/**
 * v0.5.0 message names → contract types, for the legacy adapter. A PoC name
 * sent to both the background and the offscreen document maps to the same
 * type in each.
 */
export const LEGACY_MESSAGE_TYPES: Readonly<Record<string, AnyMessageType>> =
  Object.freeze({
    INDEX: 'index.page',
    CLIP: 'index.clip',
    IMAGE: 'index.image',
    PAGE_INFO: 'page.info',
    TAG_SET: 'tag.set',
    DELETE: 'index.deletePage',
    OPEN_SEARCH: 'ui.openSearch',
    IS_DENIED: 'policy.isDenied',
    STATUS: 'status.get',
    SEARCH: 'search.query',
    LOAD: 'model.load',
    DOMAINS: 'index.domains',
    DELETE_DOMAIN: 'index.deleteDomain',
    CLEAR: 'index.clear',
    IMPORT_HISTORY: 'history.import',
    CATEGORIES: 'category.list',
    CAT_PUT: 'category.put',
    CAT_DELETE: 'category.delete',
    SCORE_PAGE: 'category.scorePage',
    INDEX_NOW: 'index.now',
    PICK_START: 'picker.start',
    CLIP_CONTEXT: 'clip.context',
    CLIP_SELECTION: 'clip.selection',
    CLIP_IMAGE: 'clip.image',
  });

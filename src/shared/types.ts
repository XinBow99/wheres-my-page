/**
 * @fileoverview Domain types shared by every context, and the JSON
 * constraint that keeps message payloads serializable.
 *
 * Shapes follow what v0.5.0 sends between contexts, minus the `ok`/`error`
 * fields that the Result wrapper now carries.
 */

import type {ModelKey} from './constants';

/** A value that survives JSON.stringify / JSON.parse unchanged in type. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | {readonly [key: string]: JsonValue};

/**
 * `T` narrowed to what JSON can carry: functions, symbols, bigints and class
 * instances such as Float32Array, Map or Date map to `never` (their methods
 * cannot be serialized), so `T extends Jsonable<T>` fails for them. Unlike
 * JsonValue it accepts interfaces and optional fields.
 *
 * @template T Type to check.
 */
export type Jsonable<T> = T extends string | number | boolean | null
  ? T
  : T extends undefined | bigint | symbol
    ? never
    : T extends (...args: never[]) => unknown
      ? never
      : T extends readonly unknown[]
        ? {readonly [I in keyof T]: Jsonable<T[I]>}
        : T extends object
          ? {readonly [K in keyof T]: Jsonable<T[K]>}
          : never;

/**
 * `true` when every value of `T` can be sent as a message payload.
 *
 * @template T Type to check.
 */
export type IsJsonable<T> = [T] extends [Jsonable<T>] ? true : false;

/** Where a stored entry came from. */
export type PageSource = 'page' | 'history' | 'clip' | 'image';

/** A category attached to a page. */
export interface Tag {
  /** Category id. */
  readonly id: string;
  /** Category name. */
  readonly name: string;
  /** CSS color of the chip. */
  readonly color: string;
  /** Assigned by auto-tagging rather than by the user. */
  readonly auto: boolean;
  /** Auto-tagging score; only on auto tags. */
  readonly s?: number;
}

/** One search or browse hit. */
export interface SearchResult {
  /** Entry key: the page URL, or the clip/image URL with its fragment. */
  readonly url: string;
  /** URL to open (a text fragment link for clips). */
  readonly linkUrl: string;
  /** Page a clip or image belongs to; null for pages. */
  readonly parentUrl: string | null;
  /** User note of a clip or image. */
  readonly note: string;
  /** Image thumbnail as a data URL; null for text entries. */
  readonly thumb: string | null;
  /** Page title. */
  readonly title: string;
  /** Hostname. */
  readonly domain: string;
  /** Last visit time, ms since epoch. */
  readonly ts: number;
  /** Visit count; missing in entries written before visits were counted. */
  readonly visits?: number;
  /** Where the entry came from. */
  readonly source: PageSource;
  /** Best matching chunk (search) or first chunk (browse). */
  readonly snippet: string;
  /** Categories of the entry. */
  readonly tags: readonly Tag[];
  /** Ranking score; null when browsing without a query. */
  readonly score: number | null;
  /** Semantic part of the score. */
  readonly sem?: number;
  /** Keyword part of the score. */
  readonly kw?: number;
}

/** A category as listed in the UI. */
export interface CategoryInfo {
  /** Category id. */
  readonly id: string;
  /** Name. */
  readonly name: string;
  /** Description used for its embedding. */
  readonly description: string;
  /** CSS color. */
  readonly color: string;
  /** Shipped preset rather than user-created. */
  readonly builtin: boolean;
  /** Text and image entries in the category. */
  readonly count: number;
  /** Image entries in the category. */
  readonly images: number;
  /** Whether its embedding exists. */
  readonly ready: boolean;
  /** Manually tagged pages that shape its prototype. */
  readonly examples: number;
}

/** All categories plus the count of untagged text entries. */
export interface CategoryList {
  /** Categories in display order. */
  readonly categories: readonly CategoryInfo[];
  /** Text entries without any category. */
  readonly uncategorized: number;
}

/** A category to create (no id) or update. */
export interface CategoryInput {
  /** Existing id; omitted to create. */
  readonly id?: string;
  /** Name. */
  readonly name: string;
  /** Description used for its embedding. */
  readonly description: string;
  /** CSS color. */
  readonly color: string;
}

/** Score of a page against one category. */
export interface CategoryScore {
  /** Category id. */
  readonly id: string;
  /** Cosine score against the category prototype. */
  readonly s: number;
  /** Category name. */
  readonly name?: string;
}

/** Index size counters. */
export interface IndexStats {
  /** Pages indexed from their text. */
  readonly pages: number;
  /** Pages known only by their history title. */
  readonly historyTitles: number;
  /** Text clips. */
  readonly clips: number;
  /** Images. */
  readonly images: number;
  /** Text chunks in memory. */
  readonly chunks: number;
  /** Vector memory, MB with one decimal. */
  readonly mb: number;
}

/** Engine state shown in the popup and the search page. */
export interface EngineStatus extends IndexStats {
  /** Model of the text index; null before the first load. */
  readonly model: ModelKey | null;
  /** Whether the vision model is loaded. */
  readonly visionLoaded: boolean;
  /** Whether a model is loading now. */
  readonly loading: boolean;
  /** Last model or inference error. */
  readonly error: string | null;
  /** Whether WebGPU is available. */
  readonly webgpu: boolean;
}

/** A clip or image saved from a page. */
export interface SavedBlock {
  /** Entry URL. */
  readonly url: string;
  /** Content hash. */
  readonly hash: string;
  /** CSS path of the block on the page. */
  readonly selector: string;
  /** 'clip' or 'image'. */
  readonly source: PageSource;
  /** Image source URL; empty for clips. */
  readonly srcUrl: string;
}

/** What the index knows about one page (badge, picker hints). */
export interface PageInfo {
  /** Whether the page text is indexed. */
  readonly indexed: boolean;
  /** Last visit time, when known. */
  readonly ts?: number;
  /** Chunk count, when indexed. */
  readonly chunks?: number;
  /** Categories of the page. */
  readonly tags: readonly Tag[];
  /** All categories, for the badge's tag menu. */
  readonly categories: ReadonlyArray<
    Pick<CategoryInfo, 'id' | 'name' | 'color'>
  >;
  /** Number of saved blocks. */
  readonly clips: number;
  /** Saved blocks. */
  readonly blocks: readonly SavedBlock[];
}

/** A viewport rectangle in CSS pixels. */
export interface Rect {
  /** Left edge. */
  readonly left: number;
  /** Top edge. */
  readonly top: number;
  /** Width. */
  readonly width: number;
  /** Height. */
  readonly height: number;
}

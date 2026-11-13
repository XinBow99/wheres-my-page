/**
 * @fileoverview Dwell-based indexing state machine of the content script
 * (pure). The content script feeds it events (visibility, timer ticks,
 * background replies) and renders the badge from the resulting context; all
 * side effects stay in the caller.
 */

/** Where a page is in the indexing flow. */
export type DwellState =
  /** Just loaded or SPA navigation; asking the background about the page. */
  | 'INIT'
  /** Denylisted, incognito, a visible password field, or too little text. */
  | 'INELIGIBLE'
  /** The user turned automatic indexing off. */
  | 'DISABLED'
  /** Visible; accumulating dwell time. */
  | 'WAITING'
  /** Tab hidden; dwell timer paused. */
  | 'PAUSED'
  /** Sent for indexing; waiting for the embeddings. */
  | 'INDEXING'
  /** Indexed (detail says whether the text was new or unchanged). */
  | 'INDEXED'
  /** Model load or inference failed; can be retried. */
  | 'ERROR'
  /** The user removed the page; not auto-indexed again during this visit. */
  | 'REMOVED';

/** Every state, in declaration order. */
export const DWELL_STATES: readonly DwellState[] = Object.freeze([
  'INIT',
  'INELIGIBLE',
  'DISABLED',
  'WAITING',
  'PAUSED',
  'INDEXING',
  'INDEXED',
  'ERROR',
  'REMOVED',
]);

/**
 * Machine context. Fields not relevant to the current state keep their last
 * value, as in v0.5.0.
 *
 * @template T Tag type reported by the background (opaque here).
 */
export interface DwellContext<T> {
  /** Current state. */
  state: DwellState;
  /** Whether the page is already in the index. */
  known: boolean;
  /** Visible time accumulated so far, in ms. */
  dwellMs: number;
  /** Chunk count of the last successful indexing. */
  chunks: number;
  /** In INDEXED: whether the text was new or unchanged. */
  detail: 'new' | 'unchanged' | null;
  /** Why the page is INELIGIBLE (e.g. "denylist", "no-content"). */
  reason?: string | null;
  /** Message of the last error. */
  error: string | null;
  /** Tags of the page as last reported. */
  tags: readonly T[];
  /** Whether the current or last indexing was requested by the user. */
  manual?: boolean;
}

/**
 * Reply of the background to an index request.
 *
 * @template T Tag type.
 */
export interface IndexReply<T> {
  /** Whether the request was handled. */
  ok?: boolean;
  /** Chunks written; non-zero when the page was (re)indexed. */
  chunks?: number;
  /** Why nothing was indexed: "unchanged", "disabled", "denylist", … */
  skipped?: string;
  /** Failure reason code, e.g. "no-content". */
  reason?: string;
  /** Failure message. */
  error?: string;
  /** Tags of the page after indexing. */
  tags?: readonly T[];
}

/**
 * Events the content script feeds the machine.
 *
 * @template T Tag type.
 */
export type DwellEvent<T> =
  | {type: 'URL_CHANGED'}
  | {type: 'SETTINGS_DISABLED'}
  | {type: 'SETTINGS_ENABLED'}
  | {
      type: 'CHECK_RESULT';
      /** Automatic indexing is off. */
      disabled?: boolean;
      /** The page must not be indexed. */
      denied?: boolean;
      /** Why it is denied. */
      reason?: string;
      /** Whether the page is already indexed. */
      indexed?: boolean;
      /** Tags of the page, if indexed. */
      tags?: readonly T[];
      /** Whether the tab is visible now. */
      visible?: boolean;
    }
  | {type: 'HIDDEN'}
  | {type: 'VISIBLE'}
  | {
      type: 'TICK';
      /** Elapsed visible ms. */ ms: number;
      /** Dwell needed. */ needMs: number;
    }
  | {type: 'INDEX_NOW'}
  | {
      type: 'RESULT';
      /** Background reply; missing on transport failure. */ result?: IndexReply<T> | null;
    }
  | {type: 'REMOVED'};

/** Shown when a failed reply carries no message. */
const UNKNOWN_ERROR = '未知錯誤';

/**
 * INELIGIBLE reasons the user may override with "index now": the page had
 * too little text (an SPA may have loaded more since) or a visible password
 * field. Denylist and incognito never yield.
 */
const OVERRIDABLE_REASONS: ReadonlySet<string | null | undefined> = new Set([
  'no-content',
  'secret-input',
]);

/**
 * Context of a freshly loaded page.
 *
 * @return New INIT context.
 */
export function initialDwell<T>(): DwellContext<T> {
  return {
    state: 'INIT',
    known: false,
    dwellMs: 0,
    chunks: 0,
    detail: null,
    reason: null,
    error: null,
    tags: [],
  };
}

function assertNever(state: never): never {
  throw new Error(`unknown dwell state ${String(state)}`);
}

function onResult<T>(
  c: DwellContext<T>,
  reply: IndexReply<T> | null | undefined,
): DwellContext<T> {
  const r = reply || {};
  if (r.ok && r.chunks) {
    const tags = r.tags || [];
    return {
      ...c,
      state: 'INDEXED',
      detail: 'new',
      chunks: r.chunks,
      known: true,
      tags,
    };
  }
  if (r.ok && r.skipped === 'unchanged') {
    return {
      ...c,
      state: 'INDEXED',
      detail: 'unchanged',
      known: true,
      tags: r.tags || [],
    };
  }
  if (r.ok && r.skipped === 'disabled') return {...c, state: 'DISABLED'};
  if (r.ok && r.skipped) return {...c, state: 'INELIGIBLE', reason: r.skipped};
  if (r.reason === 'no-content') {
    return {...c, state: 'INELIGIBLE', reason: 'no-content'};
  }
  return {...c, state: 'ERROR', error: r.error || UNKNOWN_ERROR};
}

/**
 * Next context for an event, matching the v0.5.0 content script exactly.
 * Events that do not apply in the current state leave it unchanged.
 *
 * @param ctx Current context; not modified.
 * @param ev Event.
 * @return Next context (a new object, or a copy of `ctx`).
 */
export function transition<T>(
  ctx: DwellContext<T>,
  ev: DwellEvent<T>,
): DwellContext<T> {
  const c = {...ctx};
  // Global events first.
  if (ev.type === 'URL_CHANGED') return initialDwell();
  if (ev.type === 'SETTINGS_DISABLED') return {...c, state: 'DISABLED'};
  if (ev.type === 'SETTINGS_ENABLED') {
    return c.state === 'DISABLED' ? initialDwell() : c;
  }

  switch (c.state) {
    case 'INIT':
      if (ev.type !== 'CHECK_RESULT') return c;
      if (ev.disabled) return {...c, state: 'DISABLED'};
      if (ev.denied) return {...c, state: 'INELIGIBLE', reason: ev.reason};
      return {
        ...c,
        known: !!ev.indexed,
        tags: ev.tags || [],
        state: ev.visible ? 'WAITING' : 'PAUSED',
      };

    case 'WAITING':
      if (ev.type === 'HIDDEN') return {...c, state: 'PAUSED'};
      if (ev.type === 'TICK') {
        const dwellMs = c.dwellMs + ev.ms;
        return dwellMs >= ev.needMs
          ? {...c, dwellMs, state: 'INDEXING', manual: false}
          : {...c, dwellMs};
      }
      if (ev.type === 'INDEX_NOW')
        return {...c, state: 'INDEXING', manual: true};
      return c;

    case 'PAUSED':
      if (ev.type === 'VISIBLE') return {...c, state: 'WAITING'};
      if (ev.type === 'INDEX_NOW')
        return {...c, state: 'INDEXING', manual: true};
      return c;

    case 'INDEXING':
      return ev.type === 'RESULT' ? onResult(c, ev.result) : c;

    case 'INDEXED':
      if (ev.type === 'REMOVED') return {...c, state: 'REMOVED', known: false};
      if (ev.type === 'INDEX_NOW')
        return {...c, state: 'INDEXING', manual: true};
      return c;

    case 'ERROR':
    case 'REMOVED':
      if (ev.type === 'INDEX_NOW') {
        return {...c, state: 'INDEXING', error: null, manual: true};
      }
      return c;

    case 'INELIGIBLE':
      if (ev.type === 'INDEX_NOW' && OVERRIDABLE_REASONS.has(c.reason)) {
        return {...c, state: 'INDEXING', manual: true};
      }
      return c;

    case 'DISABLED':
      return c;

    default:
      return assertNever(c.state);
  }
}

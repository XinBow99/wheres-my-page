/**
 * @fileoverview Sending side of the messaging contract. Every call resolves
 * to a Result and never rejects: transport failures, timeouts and malformed
 * replies all become WireErrors.
 *
 * Retries: only errors marked `retryable` are retried (NO_RECEIVER while the
 * offscreen document or a content script is starting), with exponential
 * backoff. This replaces v0.5.0's regex over error strings.
 */

import {type Result, type WireError, isWireError} from '../errors';
import {
  type Envelope,
  MESSAGE_SPECS,
  type MessageType,
  PROTOCOL_VERSION,
  type RequestOf,
  type ResponseOf,
  type Target,
} from './contract';

/** Contexts reached with chrome.runtime.sendMessage. */
export type RuntimeTarget = Exclude<Target, 'content'>;

/** Per-call overrides. */
export interface SendOptions {
  /** Total time for all attempts, ms; defaults to the message's timeoutMs. */
  readonly timeoutMs?: number;
  /** Retries after the first attempt for retryable errors. */
  readonly retries?: number;
  /** Delay before the first retry, ms; doubles on each retry. */
  readonly retryDelayMs?: number;
}

/** Retries for retryable errors (v0.5.0 tried 5 times in all). */
export const DEFAULT_RETRIES = 4;

/** First retry delay, ms (v0.5.0 waited 150 ms × attempt). */
export const DEFAULT_RETRY_DELAY_MS = 150;

/**
 * Chrome's errors when nobody receives the message. "Receiving end does not
 * exist" (no listener yet) is worth retrying; a closed port or an
 * invalidated context (the tab navigated, the extension was updated) is not.
 */
const NO_RECEIVER_ERRORS: ReadonlyArray<readonly [RegExp, boolean]> = [
  [/Receiving end does not exist|Could not establish connection/i, true],
  [/message port closed|Extension context invalidated/i, false],
];

/**
 * Normalizes an error thrown by chrome.runtime/tabs.sendMessage (Chrome's
 * promise API turns runtime.lastError into a rejection).
 *
 * @param e Rejection reason.
 * @return Wire error: NO_RECEIVER for delivery failures, else INTERNAL.
 */
export function fromTransportError(e: unknown): WireError {
  const message = e instanceof Error ? e.message : String(e);
  for (const [re, retryable] of NO_RECEIVER_ERRORS) {
    if (re.test(message)) return {code: 'NO_RECEIVER', message, retryable};
  }
  return {code: 'INTERNAL', message, retryable: false};
}

/**
 * Whether a reply has the Result shape. The data itself is not checked: it
 * comes from this extension's own contexts.
 *
 * @param x Reply.
 * @return True for `{ok: true, data}` or `{ok: false, error: WireError}`.
 */
function isResult(x: unknown): x is Result<unknown> {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return r['ok'] === true
    ? 'data' in r
    : r['ok'] === false && isWireError(r['error']);
}

/**
 * One delivery attempt.
 *
 * @param post Transport.
 * @param envelope Request.
 * @return Reply, or the delivery failure.
 */
async function attempt(
  post: (envelope: Envelope) => Promise<unknown>,
  envelope: Envelope,
): Promise<Result<unknown>> {
  let reply: unknown;
  try {
    reply = await post(envelope);
  } catch (e) {
    return {ok: false, error: fromTransportError(e)};
  }
  if (isResult(reply)) return reply;
  if (reply === undefined) {
    const message = `no reply to ${envelope.type}`;
    return {ok: false, error: {code: 'NO_RECEIVER', message, retryable: true}};
  }
  const message = `malformed reply to ${envelope.type}`;
  return {ok: false, error: {code: 'INTERNAL', message, retryable: false}};
}

/**
 * Sends with retries and an overall timeout.
 *
 * @param post Transport.
 * @param envelope Request.
 * @param defaultTimeoutMs Timeout from the contract.
 * @param opts Overrides.
 * @return Result of the last attempt, or TIMEOUT.
 */
async function deliver(
  post: (envelope: Envelope) => Promise<unknown>,
  envelope: Envelope,
  defaultTimeoutMs: number,
  opts: SendOptions,
): Promise<Result<unknown>> {
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const delayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async (): Promise<Result<unknown>> => {
    for (let i = 0; ; i++) {
      const r = await attempt(post, envelope);
      if (r.ok || !r.error.retryable || i >= retries) return r;
      await new Promise(resolve => setTimeout(resolve, delayMs * 2 ** i));
      // Timed out while waiting: the caller has its answer, send no more.
      if (finished) return r;
    }
  };
  const timeout = new Promise<Result<unknown>>(resolve => {
    timer = setTimeout(() => {
      const message = `no reply to ${envelope.type} within ${timeoutMs} ms`;
      resolve({ok: false, error: {code: 'TIMEOUT', message, retryable: false}});
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    finished = true;
    clearTimeout(timer);
  }
}

/**
 * Sends a request to the background or the offscreen document.
 *
 * @param target Receiving context.
 * @param type Message type.
 * @param payload Request payload.
 * @param opts Timeout and retry overrides.
 * @return Reply data, or why there is none.
 */
export async function send<T extends RuntimeTarget, K extends MessageType<T>>(
  target: T,
  type: K,
  payload: RequestOf<T, K>,
  opts: SendOptions = {},
): Promise<Result<ResponseOf<T, K>>> {
  const envelope = {v: PROTOCOL_VERSION, target, type, payload} as Envelope;
  const spec = (MESSAGE_SPECS[target] as Record<string, {timeoutMs: number}>)[
    type
  ]!;
  return (await deliver(
    e => chrome.runtime.sendMessage(e),
    envelope,
    spec.timeoutMs,
    opts,
  )) as Result<ResponseOf<T, K>>;
}

/**
 * Sends a request to the content script of a tab.
 *
 * @param tabId Tab.
 * @param type Message type.
 * @param payload Request payload.
 * @param opts Timeout and retry overrides.
 * @return Reply data, or why there is none.
 */
export async function sendToTab<K extends MessageType<'content'>>(
  tabId: number,
  type: K,
  payload: RequestOf<'content', K>,
  opts: SendOptions = {},
): Promise<Result<ResponseOf<'content', K>>> {
  const envelope = {
    v: PROTOCOL_VERSION,
    target: 'content',
    type,
    payload,
  } as Envelope;
  return (await deliver(
    e => chrome.tabs.sendMessage(tabId, e),
    envelope,
    MESSAGE_SPECS.content[type].timeoutMs,
    opts,
  )) as Result<ResponseOf<'content', K>>;
}

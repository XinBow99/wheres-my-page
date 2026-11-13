/**
 * @fileoverview Error codes, the AppError class and the Result type that
 * every cross-context reply uses (docs/SPEC.md "通訊契約").
 *
 * Replies carry a WireError instead of an Error object: message passing
 * JSON-serializes payloads, and an Error serializes to `{}`.
 */

/** Why a request failed. */
export type ErrorCode =
  /** The message failed validation. */
  | 'INVALID_MESSAGE'
  /** The offscreen document or the tab is not listening yet. */
  | 'NO_RECEIVER'
  /** No reply within the message's timeout. */
  | 'TIMEOUT'
  /** WebGPU is missing or the adapter request failed. */
  | 'WEBGPU_UNAVAILABLE'
  /** The model file could not be downloaded or opened. */
  | 'MODEL_DOWNLOAD_FAILED'
  /** Inference failed. */
  | 'EMBED_FAILED'
  /** IndexedDB or the Cache API failed. */
  | 'STORAGE_FAILED'
  /** Refused by policy (denylist, incognito) or by the sender check. */
  | 'DENIED'
  /** The page, category or tab does not exist. */
  | 'NOT_FOUND'
  /** Anything else; a bug. */
  | 'INTERNAL';

/** Every error code, in declaration order. */
export const ERROR_CODES: readonly ErrorCode[] = Object.freeze([
  'INVALID_MESSAGE',
  'NO_RECEIVER',
  'TIMEOUT',
  'WEBGPU_UNAVAILABLE',
  'MODEL_DOWNLOAD_FAILED',
  'EMBED_FAILED',
  'STORAGE_FAILED',
  'DENIED',
  'NOT_FOUND',
  'INTERNAL',
]);

/**
 * Codes the client retries by default. Only NO_RECEIVER: the offscreen
 * document or a content script may still be starting (v0.5.0 retried
 * "Receiving end does not exist" only). A TIMEOUT is not retried because the
 * receiver may still be running the first request (a model download, a
 * history import).
 */
const RETRYABLE_BY_DEFAULT: ReadonlySet<ErrorCode> = new Set(['NO_RECEIVER']);

/** An error as it crosses a context boundary (JSON-serializable). */
export interface WireError {
  /** Machine-readable reason. */
  readonly code: ErrorCode;
  /** English message for developers; UI text comes from the code. */
  readonly message: string;
  /** Whether sending the same request again may succeed. */
  readonly retryable: boolean;
}

/**
 * Outcome of a request.
 *
 * @template T Data of a successful reply.
 */
export type Result<T> =
  | {readonly ok: true; readonly data: T}
  | {readonly ok: false; readonly error: WireError};

/** Options of {@link AppError}. */
export interface AppErrorOptions {
  /** Overrides the code's default. */
  readonly retryable?: boolean;
  /** Original error. */
  readonly cause?: unknown;
}

/** An error with a code, thrown inside a context and sent as a WireError. */
export class AppError extends Error {
  /** Machine-readable reason. */
  readonly code: ErrorCode;
  /** Whether sending the same request again may succeed. */
  readonly retryable: boolean;

  /**
   * @param code Machine-readable reason.
   * @param message English message for developers.
   * @param options Retry override and cause.
   */
  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, {cause: options.cause});
    this.name = 'AppError';
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE_BY_DEFAULT.has(code);
  }
}

/**
 * Converts anything thrown into a WireError. AppErrors keep their code;
 * anything else becomes INTERNAL with its message kept, never swallowed.
 *
 * @param e Thrown value.
 * @return Serializable error.
 */
export function toWireError(e: unknown): WireError {
  if (e instanceof AppError) {
    return {code: e.code, message: e.message, retryable: e.retryable};
  }
  const message = e instanceof Error ? e.message : String(e);
  return {code: 'INTERNAL', message, retryable: false};
}

/**
 * Successful result.
 *
 * @param data Reply data.
 * @return `{ok: true, data}`.
 */
export function ok<T>(data: T): Result<T> {
  return {ok: true, data};
}

/**
 * Failed result.
 *
 * @param error Error to send.
 * @return `{ok: false, error}`.
 */
export function err<T = never>(error: WireError): Result<T> {
  return {ok: false, error};
}

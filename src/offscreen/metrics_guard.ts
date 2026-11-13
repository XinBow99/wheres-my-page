/**
 * @fileoverview Blocks the usage metrics MediaPipe sends from the offscreen
 * document (docs/tasks/plan.md Open Question 3, option A).
 *
 * The `@mediapipe/tasks-*` bundles start a logger whenever a task is created
 * and POST protobuf usage statistics to odml.pa.googleapis.com every 60 s and
 * on close(), with no option to turn it off. The logger calls the global
 * fetch; a rejected fetch makes it clear its timer, so after the first
 * attempt nothing is retried. No request leaves the machine.
 */

/** Hosts the offscreen document must never contact. */
export const BLOCKED_HOSTS: ReadonlySet<string> = new Set([
  'odml.pa.googleapis.com',
]);

/** Message of the error a blocked fetch rejects with. */
export const BLOCKED_MESSAGE =
  "Blocked by Where's My Page: MediaPipe usage metrics are not sent";

/**
 * Host a fetch would contact, or null when the input is not a valid URL.
 *
 * @param input First argument of fetch.
 * @param base Base for relative URLs.
 * @return Lower-case hostname, or null.
 */
function hostOf(input: RequestInfo | URL, base: string): string | null {
  const raw =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  // URL.canParse needs Chrome 120; the manifest allows 116.
  try {
    return new URL(raw, base).hostname;
  } catch {
    // Not a URL: nothing to block. The real fetch rejects the same input
    // with its own TypeError, so the caller still sees the failure.
    return null;
  }
}

/**
 * Wraps fetch so requests to BLOCKED_HOSTS fail like a network error without
 * being sent. Every other request goes to `fetchFn` unchanged.
 *
 * @param fetchFn The real fetch.
 * @param base Base URL for relative inputs (the document URL).
 * @return Guarded fetch.
 */
export function guardFetch(fetchFn: typeof fetch, base: string): typeof fetch {
  return (input, init) => {
    const host = hostOf(input, base);
    if (host !== null && BLOCKED_HOSTS.has(host)) {
      return Promise.reject(new TypeError(BLOCKED_MESSAGE));
    }
    return fetchFn(input, init);
  };
}

/** The part of the global object the guard replaces. */
export interface FetchScope {
  /** The global fetch. */
  fetch: typeof fetch;
}

/**
 * Replaces `scope.fetch` with the guarded version. Must run before the
 * MediaPipe bundle is loaded.
 *
 * @param scope Global object of the offscreen document.
 * @param base Document URL.
 */
export function installMetricsGuard(scope: FetchScope, base: string): void {
  scope.fetch = guardFetch(scope.fetch.bind(scope), base);
}

/**
 * @fileoverview Denylist: sites that are never indexed, as user-editable
 * globs.
 */

/** Characters escaped when a glob becomes a regex; `*` becomes `.*`. */
const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

/**
 * Compiles one glob, case-insensitively and anchored at both ends. Only `*`
 * is a wildcard. As in v0.5.0, `?` is not escaped, so it keeps its regex
 * meaning (the preceding character is optional).
 *
 * @param glob One denylist line.
 */
function globToRegex(glob: string): RegExp {
  const body = glob.trim().replace(REGEX_SPECIALS, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${body}$`, 'i');
}

/**
 * Splits denylist text into globs: one per line, trimmed, blank lines
 * skipped.
 *
 * @param denylist Denylist text from the settings.
 * @return Non-empty globs in order.
 */
export function parseDenylist(denylist: string): string[] {
  return denylist
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

/**
 * Whether a page must not be indexed.
 *
 * Anything that is not an http(s) URL is denied. Otherwise the page is
 * denied when some glob matches either its hostname or its hostname followed
 * by its path (so `*.gov.tw/login*` denies only the login pages).
 *
 * @param url Page URL.
 * @param denylist Denylist text, one glob per line.
 * @return True when the page must not be indexed.
 */
export function isDenied(url: string, denylist: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Fail closed: a string that is not a URL is never indexed.
    return true;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
  const host = parsed.hostname;
  const hostAndPath = host + parsed.pathname;
  return parseDenylist(denylist).some(glob => {
    const re = globToRegex(glob);
    return re.test(host) || re.test(hostAndPath);
  });
}

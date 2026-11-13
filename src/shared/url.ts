/**
 * @fileoverview URL helpers shared by the content scripts and the extension:
 * the canonical page key and the hostname.
 */

/**
 * Query parameters that only track where a visit came from: any name
 * starting with `utm_`, `fbclid`, `gclid` or `ref_src`, and exactly `ref`.
 */
const TRACKING_PARAM = /^(utm_|fbclid|gclid|ref$|ref_src)/;

/**
 * The URL a page is indexed under: the fragment and tracking parameters are
 * removed, so the same article reached from different links is one page.
 * Must stay identical to v0.5.0, because indexed pages are keyed by it.
 *
 * @param href Absolute URL of the page.
 * @return Canonical URL, serialized by the URL parser (lowercase host,
 *     punycode, percent-encoded path).
 * @throws {TypeError} If `href` is not an absolute URL.
 */
export function canonicalUrl(href: string): string {
  const url = new URL(href);
  url.hash = '';
  for (const name of [...url.searchParams.keys()]) {
    if (TRACKING_PARAM.test(name)) url.searchParams.delete(name);
  }
  return url.toString();
}

/**
 * Hostname of a URL, used to group and filter pages by site.
 *
 * @param url Any string.
 * @return Lowercase hostname, or "" when `url` is not an absolute URL.
 */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    // Not an absolute URL: the record simply has no site; nothing to report.
    return '';
  }
}

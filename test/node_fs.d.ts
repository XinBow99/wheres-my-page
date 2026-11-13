/**
 * @fileoverview The one Node API the test helpers use. Declared here instead
 * of installing the Node type package, so Node globals such as `process` stay invisible
 * to the type check of src/ (which runs in the browser).
 */

declare module 'node:fs' {
  /**
   * Reads a whole file as text.
   *
   * @param path File URL to read.
   * @param encoding Always 'utf8'.
   * @return File contents.
   */
  export function readFileSync(path: URL, encoding: 'utf8'): string;
}

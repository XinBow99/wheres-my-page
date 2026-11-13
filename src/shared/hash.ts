/**
 * @fileoverview Small stable string hash shared by every execution context.
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * Hashes a string with 32-bit FNV-1a over UTF-16 code units.
 *
 * Used to detect unchanged pages and to derive clip and image ids, so the
 * output is persisted in IndexedDB and must stay identical to the v0.5.0 PoC.
 * Not a cryptographic hash.
 *
 * @param text Input string.
 * @return Lowercase hex digest, not zero-padded.
 */
export function hashText(text: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16);
}

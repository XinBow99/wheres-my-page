/**
 * @fileoverview Normalizes extracted page text before it is chunked.
 */

/**
 * Whether a UTF-16 code unit is dropped: C0 controls except tab and newline
 * (carriage return is handled separately), DEL, zero-width and direction
 * marks, the Unicode line and paragraph separators, and the byte order mark.
 *
 * @param code UTF-16 code unit.
 */
function isStripped(code: number): boolean {
  return (
    code <= 0x08 ||
    code === 0x0b ||
    code === 0x0c ||
    (code >= 0x0e && code <= 0x1f) ||
    code === 0x7f ||
    (code >= 0x200b && code <= 0x200f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0xfeff
  );
}

function stripInvisible(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (!isStripped(text.charCodeAt(i))) out += text[i];
  }
  return out;
}

/**
 * Cleans page text the way the v0.5.0 PoC did before chunking: removes
 * control and zero-width characters and carriage returns, collapses runs of
 * spaces, tabs and no-break spaces into one space, limits blank lines to one,
 * and trims both ends.
 *
 * @param text Raw text extracted from a page.
 * @return Normalized text; empty when nothing visible remains.
 */
export function cleanText(text: string): string {
  return stripInvisible(text)
    .replace(/\r/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

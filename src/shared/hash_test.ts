import {describe, expect, it} from 'vitest';

import {hashText} from './hash';

describe('hashText', () => {
  // Golden values produced by the v0.5.0 PoC (chunk.js hashText). Stored
  // clip ids are derived from these, so they must never change.
  it.each([
    ['', '811c9dc5'],
    ['a', 'e40c292c'],
    ['hello world', 'd58b3fa7'],
    ['上週看的 flash-attn Windows 編譯失敗', 'cd50646f'],
    ['emoji 😀 test', 'fccccb26'],
    ['https://example.com/a?b=1', '8d2ce3a0'],
  ])('hashes %j to the PoC value %s', (input, expected) => {
    expect(hashText(input)).toBe(expected);
  });

  it('returns lowercase hex without zero padding, like the PoC', () => {
    expect(hashText('x')).toMatch(/^[0-9a-f]{1,8}$/);
  });
});

import {describe, expect, it} from 'vitest';

import {cleanText} from './preprocess';

describe('cleanText', () => {
  it.each([
    [
      'control characters',
      'a\u0000b\u0008c\u000bd\u000ce\u001ff\u007fg',
      'abcdefg',
    ],
    [
      'zero-width and direction marks',
      'a\u200bb\u200cc\u200dd\u200ee\u200ff',
      'abcdef',
    ],
    ['line and paragraph separators', 'a\u2028b\u2029c', 'abc'],
    ['byte order mark', '\ufeffhello', 'hello'],
    ['carriage returns', 'one\r\ntwo\rthree', 'one\ntwothree'],
    ['runs of spaces, tabs and no-break spaces', 'a  \t\u00a0 b', 'a b'],
    ['three or more newlines', 'a\n\n\n\nb\n\nc', 'a\n\nb\n\nc'],
    ['surrounding whitespace', '  \n text \n ', 'text'],
  ])('removes or collapses %s', (_, input, expected) => {
    expect(cleanText(input)).toBe(expected);
  });

  it('keeps tabs and newlines meaningful as separators', () => {
    expect(cleanText('a\tb\nc')).toBe('a b\nc');
  });

  it('keeps CJK text, emoji and full-width spaces', () => {
    expect(cleanText('中文\u3000全形 😀')).toBe('中文\u3000全形 😀');
  });

  it('returns an empty string when only invisible characters remain', () => {
    expect(cleanText('\u0000\u200b\ufeff \t')).toBe('');
  });
});

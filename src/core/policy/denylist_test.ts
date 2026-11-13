import {describe, expect, it} from 'vitest';

import {denylistGolden as golden} from '../../../test/golden';
import {DEFAULT_DENYLIST} from '../../shared/constants';
import {isDenied, parseDenylist} from './denylist';

const cases = golden.cases.map(c => [c.url, c] as const);

describe('isDenied', () => {
  it('uses the PoC default denylist', () => {
    expect(DEFAULT_DENYLIST).toBe(golden.defaultDenylist);
  });

  it.each(cases)('matches the PoC default list for %s', (url, c) => {
    expect(isDenied(url, golden.defaultDenylist)).toBe(c.defaultDenied);
  });

  it.each(cases)('matches the PoC custom list for %s', (url, c) => {
    expect(isDenied(url, golden.custom)).toBe(c.customDenied);
  });

  it.each([
    ['https://example.com/x', 'example.com', true],
    ['https://www.example.com/x', 'example.com', false],
    ['https://www.example.com/x', '*.example.com', true],
    ['https://EXAMPLE.COM/', 'example.com', true],
    ['https://docs.example.org/private/a', 'docs.example.org/private*', true],
    ['https://docs.example.org/public', 'docs.example.org/private*', false],
    ['https://a.internal/', '*.internal', true],
    ['https://exampleXcom/', 'example.com', false],
    ['https://example.com/', '  example.com  ', true],
    ['https://example.com/', 'a.(b)+[c]|^$\\', false],
  ])('isDenied(%j) with %j is %j', (url, list, denied) => {
    expect(isDenied(url, list)).toBe(denied);
  });

  it('keeps the PoC meaning of ? (optional preceding character)', () => {
    expect(isDenied('https://exampl.com/', 'example?.com')).toBe(true);
  });

  it('denies non-http(s) URLs even with an empty list', () => {
    for (const url of ['ftp://a.test/', 'chrome://newtab', 'data:,x', 'x']) {
      expect(isDenied(url, '')).toBe(true);
    }
  });

  it('allows any http(s) URL with an empty list', () => {
    expect(isDenied('http://a.test/', '')).toBe(false);
    expect(isDenied('https://a.test/', '\n \n')).toBe(false);
  });
});

describe('parseDenylist', () => {
  it('trims lines and skips blank ones', () => {
    expect(parseDenylist(' a.com \n\n*.b\r\n  ')).toEqual(['a.com', '*.b']);
  });
});

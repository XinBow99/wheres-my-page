import {describe, expect, it} from 'vitest';

import {sharedGolden as golden} from '../../test/golden';
import {canonicalUrl, domainOf} from './url';

describe('canonicalUrl', () => {
  it.each(golden.canonicalUrl.map(c => [c.url, c.out] as const))(
    'matches the PoC for %s',
    (url, out) => {
      expect(canonicalUrl(url)).toBe(out);
    },
  );

  it('keeps parameters that only start like a tracking one', () => {
    expect(canonicalUrl('https://a.test/?refs=1&referrer=2&utm=3')).toBe(
      'https://a.test/?refs=1&referrer=2&utm=3',
    );
  });

  it('throws on a relative URL', () => {
    expect(() => canonicalUrl('/path')).toThrow(TypeError);
  });
});

describe('domainOf', () => {
  it.each([
    ['https://Docs.Example.com:8080/a?b#c', 'docs.example.com'],
    ['http://例子.測試/', 'xn--fsqu00a.xn--g6w251d'],
    ['file:///C:/x.html', ''],
    ['not a url', ''],
    ['', ''],
  ])('domainOf(%j) is %j', (url, host) => {
    expect(domainOf(url)).toBe(host);
  });
});

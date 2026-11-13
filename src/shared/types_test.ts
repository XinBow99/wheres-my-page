import {describe, expectTypeOf, it} from 'vitest';

import type {IsJsonable, SearchResult, Tag} from './types';

interface WithOptional {
  readonly a?: number;
  readonly b: string | null;
  readonly c: readonly [string, number];
}

describe('IsJsonable', () => {
  it('accepts JSON shapes, interfaces and optional fields', () => {
    expectTypeOf<
      IsJsonable<{a: Array<number | string | null>; b: {c: boolean}}>
    >().toEqualTypeOf<true>();
    expectTypeOf<IsJsonable<WithOptional>>().toEqualTypeOf<true>();
    expectTypeOf<IsJsonable<readonly Tag[]>>().toEqualTypeOf<true>();
    expectTypeOf<IsJsonable<SearchResult>>().toEqualTypeOf<true>();
    expectTypeOf<IsJsonable<Record<string, never>>>().toEqualTypeOf<true>();
    expectTypeOf<IsJsonable<null>>().toEqualTypeOf<true>();
  });

  it('rejects typed arrays, Map, Set and Date, also nested', () => {
    expectTypeOf<IsJsonable<Float32Array>>().toEqualTypeOf<false>();
    expectTypeOf<IsJsonable<{vec: Float32Array}>>().toEqualTypeOf<false>();
    expectTypeOf<IsJsonable<{m: Map<string, number>}>>().toEqualTypeOf<false>();
    expectTypeOf<IsJsonable<{s: Set<string>}>>().toEqualTypeOf<false>();
    expectTypeOf<IsJsonable<{when: Date}>>().toEqualTypeOf<false>();
    expectTypeOf<IsJsonable<{deep: {list: Date[]}}>>().toEqualTypeOf<false>();
    expectTypeOf<IsJsonable<ArrayBuffer>>().toEqualTypeOf<false>();
  });

  it('rejects functions, undefined, bigint and symbol', () => {
    expectTypeOf<IsJsonable<{f: () => void}>>().toEqualTypeOf<false>();
    expectTypeOf<IsJsonable<undefined>>().toEqualTypeOf<false>();
    expectTypeOf<IsJsonable<{n: bigint}>>().toEqualTypeOf<false>();
    expectTypeOf<IsJsonable<{s: symbol}>>().toEqualTypeOf<false>();
    expectTypeOf<IsJsonable<{u: string | undefined}>>().toEqualTypeOf<false>();
  });
});

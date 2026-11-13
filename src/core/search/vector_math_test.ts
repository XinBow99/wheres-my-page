import {describe, expect, it} from 'vitest';

import {expectClose, expectVecClose} from '../../../test/expect_close';
import {mathGolden as golden} from '../../../test/golden';
import {dot, meanVec, normalize, toDim} from './vector_math';

const [v0, v1, v2, v3] = golden.vectors as [
  number[],
  number[],
  number[],
  number[],
];

describe('normalize', () => {
  it.each(golden.vectors.map((v, i) => [i, v] as const))(
    'matches the PoC for vector %i',
    (i, v) => {
      expectVecClose(normalize(v), golden.normalize[i]!);
    },
  );

  it('returns unit length', () => {
    expectClose(dot(normalize(v0), normalize(v0)), 1);
  });

  it('keeps a zero vector zero instead of NaN', () => {
    expect(Array.from(normalize(new Float32Array(4)))).toEqual(
      golden.normalizeZero,
    );
    expect(Array.from(normalize([0, 0, 0, 0]))).toEqual([0, 0, 0, 0]);
  });

  it('accepts an empty vector', () => {
    expect(normalize([]).length).toBe(0);
  });

  it('does not modify its input', () => {
    const input = Float32Array.from([3, 4]);
    normalize(input);
    expect(Array.from(input)).toEqual([3, 4]);
  });
});

describe('dot', () => {
  it('matches the PoC over all dimensions', () => {
    expectClose(dot(v0, v1), golden.dot[0]!);
  });

  it('matches the PoC over the leading dimensions', () => {
    expectClose(dot(v0, v1, 3), golden.dot[1]!);
  });

  it('is zero against a zero vector', () => {
    expect(dot([1, 2, 3], [0, 0, 0])).toBe(0);
  });
});

describe('meanVec', () => {
  it('matches the PoC', () => {
    expectVecClose(meanVec(golden.vectors, 8), golden.meanVec);
  });

  it('averages only the leading dimensions', () => {
    expectVecClose(
      meanVec(
        [
          [3, 0, 9],
          [0, 4, 9],
        ],
        2,
      ),
      [0.6, 0.8],
    );
  });

  it('is a zero vector when there is nothing to average', () => {
    expect(Array.from(meanVec([], 3))).toEqual([0, 0, 0]);
  });
});

describe('toDim', () => {
  it('matches the PoC when truncating', () => {
    expectVecClose(toDim(v2, 4), golden.toDim[0]!);
  });

  it('matches the PoC at full length', () => {
    expectVecClose(toDim(v3, 8), golden.toDim[1]!);
  });

  it('keeps a shorter vector at its own length', () => {
    expectVecClose(toDim([3, 4], 8), [0.6, 0.8]);
  });

  it('accepts a Float32Array', () => {
    expectVecClose(toDim(Float32Array.from([0, 5, 1]), 2), [0, 1]);
  });
});

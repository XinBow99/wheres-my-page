/**
 * @fileoverview Float comparison against golden outputs, which store Float32
 * values with 9 significant digits.
 */

import {expect} from 'vitest';

/** Tolerance for comparing floats with golden outputs (docs/tasks/todo.md T5). */
export const GOLDEN_TOLERANCE = 1e-6;

/**
 * Asserts two vectors have the same length and are element-wise within
 * {@link GOLDEN_TOLERANCE}.
 *
 * @param actual Computed vector.
 * @param expected Golden vector.
 */
export function expectVecClose(
  actual: ArrayLike<number>,
  expected: readonly number[],
): void {
  expect(actual.length).toBe(expected.length);
  expected.forEach((x, i) => {
    expect(Math.abs(actual[i]! - x)).toBeLessThanOrEqual(GOLDEN_TOLERANCE);
  });
}

/**
 * Asserts two numbers are within {@link GOLDEN_TOLERANCE}.
 *
 * @param actual Computed number.
 * @param expected Golden number.
 */
export function expectClose(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(GOLDEN_TOLERANCE);
}

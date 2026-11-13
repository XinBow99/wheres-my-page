/**
 * @fileoverview Vector helpers for embeddings: L2 normalization, dot product,
 * mean of vectors and Matryoshka truncation.
 */

/**
 * Scales a vector to unit length. A zero vector stays zero instead of
 * becoming NaN.
 *
 * @param v Input vector.
 * @return New unit-length Float32Array of the same length.
 */
export function normalize(v: ArrayLike<number>): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm;
  return out;
}

/**
 * Dot product over the first `n` dimensions; the cosine similarity when both
 * vectors are normalized.
 *
 * @param a First vector.
 * @param b Second vector, at least `n` long.
 * @param n Number of leading dimensions to use. Defaults to `a.length`.
 * @return Sum of the element-wise products.
 */
export function dot(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  n = a.length,
): number {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i]! * b[i]!;
  return sum;
}

/**
 * Normalized mean direction of several vectors, e.g. a page vector from its
 * chunk vectors.
 *
 * @param vecs Vectors, each at least `dim` long.
 * @param dim Number of leading dimensions to average.
 * @return Unit-length Float32Array of length `dim`; zero when `vecs` is empty.
 */
export function meanVec(
  vecs: Iterable<ArrayLike<number>>,
  dim: number,
): Float32Array {
  const sum = new Float32Array(dim);
  for (const v of vecs) {
    for (let i = 0; i < dim; i++) sum[i]! += v[i]!;
  }
  return normalize(sum);
}

/**
 * Truncates an embedding to its first `dim` dimensions (Matryoshka) and
 * renormalizes it.
 *
 * @param vec Full-length embedding.
 * @param dim Target dimension.
 * @return Unit-length Float32Array of length `min(dim, vec.length)`.
 */
export function toDim(vec: ArrayLike<number>, dim: number): Float32Array {
  const head = Float32Array.from(
    {length: Math.min(dim, vec.length)},
    (_, i) => vec[i]!,
  );
  return normalize(head);
}

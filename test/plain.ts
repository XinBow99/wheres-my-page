/**
 * @fileoverview Converts index state to the JSON form the golden generator
 * (scripts/gen-golden.mjs) writes, so records and query outputs compare
 * with toEqual.
 */

/**
 * Float32 value printed with 9 significant digits (round-trips exactly).
 *
 * @param x Float32 value.
 * @return Rounded number.
 */
function f32(x: number): number {
  return Number(Math.fround(x).toPrecision(9));
}

/**
 * JSON form of a value: Float32Arrays become number arrays, undefined
 * fields disappear; undefined itself stays undefined.
 *
 * @param x Value.
 * @return Plain JSON value.
 */
export function plain(x: unknown): unknown {
  const json = JSON.stringify(x, (_key, value: unknown) =>
    value instanceof Float32Array ? Array.from(value, f32) : value,
  ) as string | undefined;
  return json === undefined ? undefined : JSON.parse(json);
}

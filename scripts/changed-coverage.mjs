/**
 * @fileoverview Coverage of changed lines, per docs/CONSTRAINTS.md.
 *
 * Intersects coverage/lcov.info (written by `vitest run --coverage`, so the
 * suite is not run twice) with the lines added since the merge base. Only
 * executable lines (lcov DA records) in the measured modules count.
 *
 * Usage: node scripts/changed-coverage.mjs [--base <ref>] [--min <percent>]
 * Exit codes: 0 ok (or nothing to measure), 1 below threshold, 2 could not run.
 */

import {existsSync, readFileSync} from 'node:fs';
import {relative, resolve} from 'node:path';

import {baseFromArgs, collectDiff} from './lib/diff.mjs';

/** docs/CONSTRAINTS.md: changed lines in these modules must be >= 80%. */
const DEFAULT_MIN_PERCENT = 80;
const MEASURED = /^src\/(core|shared|storage)\/.*\.ts$/;
const isTest = f => /_test\.ts$/.test(f);
const LCOV = 'coverage/lcov.info';

/**
 * Parses lcov into a map of repo-relative file -> (line -> hit count).
 * @param {string} text lcov.info content.
 * @return {Map<string, Map<number, number>>}
 */
function parseLcov(text) {
  const files = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      const file = relative(process.cwd(), resolve(line.slice(3).trim()))
        .split('\\')
        .join('/');
      current = new Map();
      files.set(file, current);
    } else if (line.startsWith('DA:') && current) {
      const [lineNo, hits] = line.slice(3).split(',').map(Number);
      current.set(lineNo, hits);
    } else if (line.startsWith('end_of_record')) {
      current = null;
    }
  }
  return files;
}

/**
 * Reads `--min <percent>` from argv.
 * @return {number}
 */
function minFromArgs() {
  const i = process.argv.indexOf('--min');
  return i > -1 ? Number(process.argv[i + 1]) : DEFAULT_MIN_PERCENT;
}

function main() {
  const {added} = collectDiff(baseFromArgs());
  const changed = added.filter(l => MEASURED.test(l.file) && !isTest(l.file));
  if (changed.length === 0) {
    console.log('changed-coverage: no changed lines in measured modules');
    return 0;
  }
  if (!existsSync(LCOV)) {
    throw new Error(`${LCOV} not found; run \`vitest run --coverage\` first`);
  }
  const lcov = parseLcov(readFileSync(LCOV, 'utf8'));

  let executable = 0;
  let covered = 0;
  const uncovered = new Map(); // file -> line numbers
  for (const {file, line} of changed) {
    const hits = lcov.get(file);
    if (!hits) {
      // A measured file absent from lcov was never loaded by any test.
      executable++;
      uncovered.set(file, [...(uncovered.get(file) ?? []), line]);
      continue;
    }
    if (!hits.has(line)) continue; // not executable (comment, type, blank)
    executable++;
    if (hits.get(line) > 0) covered++;
    else uncovered.set(file, [...(uncovered.get(file) ?? []), line]);
  }

  if (executable === 0) {
    console.log('changed-coverage: no executable changed lines');
    return 0;
  }
  const percent = (covered / executable) * 100;
  const min = minFromArgs();
  console.log(
    `changed-coverage: ${covered}/${executable} changed executable lines ` +
      `covered (${percent.toFixed(1)}%, minimum ${min}%)`,
  );
  if (percent >= min) return 0;
  for (const [file, lines] of uncovered) {
    console.error(`  uncovered ${file}: ${lines.join(', ')}`);
  }
  return 1;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`changed-coverage: could not run: ${error.message}`);
  process.exitCode = 2;
}

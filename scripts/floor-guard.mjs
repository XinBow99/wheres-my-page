/**
 * @fileoverview Diff-scoped enforcement of the docs/CONSTRAINTS.md floor.
 *
 * Adapted from the constraint-driven-development floor-guard reference.
 * Detects moves that lower the bar: a silenced checker, unfinished work, a
 * test made easier or deleted, a weakened or removed CONSTRAINTS rule, and a
 * new exception row. Tightening is silent; loosening is loud.
 *
 * Usage: node scripts/floor-guard.mjs [--base <ref>]   (default: main)
 * Exit codes: 0 clean, 1 floor violation, 2 the guard could not run.
 */

import {existsSync, readFileSync} from 'node:fs';

import {baseFromArgs, collectDiff} from './lib/diff.mjs';

/** Only source files are scanned for suppressions, stubs and skips. */
const CODE_FILE = /\.(ts|tsx|js|mjs|cjs)$/;
const isTest = f => /(_test|\.test|\.spec)\.[cm]?[jt]sx?$/.test(f);
const isConstraints = f => /(^|\/)CONSTRAINTS\.md$/.test(f);

// 1. Silenced checker: only real comment directives, not prose mentioning them.
const SUPPRESSION = new RegExp(
  String.raw`(\/\/|\/\*|<!--)\s*(@ts-ignore|@ts-nocheck|@ts-expect-error|` +
    String.raw`eslint-disable|prettier-ignore|istanbul ignore|c8 ignore|` +
    String.raw`v8 ignore|nosemgrep|gitleaks:allow|Stryker disable)`,
);
// 4. Unfinished work. "TO" + "DO" so this file does not flag itself; a
// to-do is allowed only with a tracked issue: TODO(#12).
const STUB = new RegExp(
  [
    String.raw`throw new Error\(\s*['"\x60]Not implemented`,
    String.raw`\bcatch\s*(\(\s*\w*\s*\))?\s*\{\s*\}`,
    String.raw`\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*(\{\s*\}|undefined|null)\s*\)`,
    String.raw`\bTO` + String.raw`DO\b(?!\(#\d+\))`,
  ].join('|'),
);
// 2. A test made easier.
const SKIP = /\b(it|test|describe)\.(skip|todo)\b|\bx(it|describe)\(/;

/**
 * Loads glob patterns from .constraintsignore (one per line, # comments).
 * Every entry must cite an exception id from docs/CONSTRAINTS.md.
 * @return {RegExp[]}
 */
function loadIgnores() {
  if (!existsSync('.constraintsignore')) return [];
  return readFileSync('.constraintsignore', 'utf8')
    .split('\n')
    .map(l => l.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map(
      glob =>
        new RegExp(
          '^' +
            glob
              .replace(/[.+^${}()|[\]\\]/g, '\\$&')
              .split('**')
              .map(part => part.replace(/\*/g, '[^/]*'))
              .join('.*') +
            '$',
        ),
    );
}

/**
 * Identifies a CONSTRAINTS rule: a table row by its first cell, a bullet by
 * its bold title or the text before its first (full- or half-width) colon.
 * @param {string} text Line text.
 * @return {string|null} Rule key, or null for prose.
 */
function ruleKey(text) {
  const s = text.trim();
  if (/^\|[\s-:|]+\|$/.test(s)) return null; // table separator row
  if (s.startsWith('|')) {
    return (
      s
        .split('|')
        .map(c => c.trim())
        .filter(Boolean)[0] ?? ''
    );
  }
  if (/^[-*] /.test(s)) {
    const bold = /^[-*] \*\*(.+?)\*\*/.exec(s);
    return bold ? bold[1] : s.slice(2).split(/[:：]/)[0].trim();
  }
  return null;
}

const isException = t => /^\| *(W|E)\d+ *\|/.test(t.trim());
const MIN_BEFORE =
  /(>=|>|≥|at least|minimum|\bmin\b|no less than|not fall|not drop|至少|不低於)\s*$/;
const MAX_BEFORE =
  /(<=|<|≤|at most|maximum|\bmax\b|no more than|under|below|not grow|not exceed|至多|上限|不超過)\s*$/;
const MIN_AFTER =
  /^\s*\S*\s*(?:\|\s*)?(or more|or higher|must not fall|must not drop|以上|不得下降)/;
const MAX_AFTER =
  /^\s*\S*\s*(?:\|\s*)?(or less|or lower|must not grow|must not exceed|以下|不得上升|不得增加)/;

/**
 * Extracts numbers with the direction that makes them stricter.
 * @param {string} text Rule line.
 * @return {{n: number, dir: 'min'|'max'|null}[]}
 */
function thresholds(text) {
  const out = [];
  const re = /\d+(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
    const after = text
      .slice(m.index + m[0].length, m.index + m[0].length + 40)
      .toLowerCase();
    const dir =
      MIN_BEFORE.test(before) || MIN_AFTER.test(after)
        ? 'min'
        : MAX_BEFORE.test(before) || MAX_AFTER.test(after)
          ? 'max'
          : null;
    out.push({n: Number(m[0]), dir});
  }
  return out;
}

function main() {
  const {added, removed, deleted} = collectDiff(baseFromArgs());
  const ignores = loadIgnores();
  const ignored = f => ignores.some(re => re.test(f));
  const findings = [];
  const flag = (rule, file, text) =>
    findings.push({rule, file, text: text.trim().slice(0, 140)});

  for (const {file, text} of added) {
    if (ignored(file)) continue;
    if (CODE_FILE.test(file)) {
      if (SUPPRESSION.test(text)) flag('silenced-checker', file, text);
      if (STUB.test(text)) flag('unfinished-work', file, text);
      if (isTest(file) && SKIP.test(text)) flag('test-made-easier', file, text);
    }
    if (isConstraints(file) && isException(text)) {
      flag('new-exception', file, text);
    }
  }

  for (const f of deleted)
    if (isTest(f)) flag('test-deleted', f, 'file deleted');
  for (const {file, text} of removed) {
    const testStillExists = isTest(file) && !deleted.includes(file);
    if (testStillExists && /\b(expect|assert|should)\b/.test(text)) {
      flag('assertion-removed', file, text);
    }
  }

  const removedRules = removed.filter(
    l => isConstraints(l.file) && ruleKey(l.text) !== null,
  );
  const addedRules = added.filter(
    l => isConstraints(l.file) && ruleKey(l.text) !== null,
  );
  for (const r of removedRules) {
    const a = addedRules.find(x => ruleKey(x.text) === ruleKey(r.text));
    if (!a) {
      // Dropping an exception tightens the bar: silent.
      if (!isException(r.text)) flag('rule-removed', r.file, r.text);
      continue;
    }
    const before = thresholds(r.text);
    const after = thresholds(a.text);
    let verdict = null;
    for (const dir of ['min', 'max', null]) {
      const was = before.filter(x => x.dir === dir);
      const now = after.filter(x => x.dir === dir);
      was.forEach((b, i) => {
        const n = now[i];
        if (verdict) return;
        if (!n) verdict = 'threshold-removed';
        else if (n.n === b.n) return;
        else if (dir === 'min' ? n.n < b.n : dir === 'max' ? n.n > b.n : true) {
          verdict = dir ? 'threshold-loosened' : 'threshold-changed';
        }
      });
    }
    if (verdict) flag(verdict, r.file, `${r.text}  ->  ${a.text}`);
  }

  if (findings.length === 0) {
    console.log('floor-guard: clean');
    return 0;
  }
  console.error(`floor-guard: ${findings.length} floor violation(s):`);
  for (const f of findings) console.error(`  [${f.rule}] ${f.file}: ${f.text}`);
  console.error(
    '\nEach is a move that lowers the bar. Fix the code, or route it through' +
      ' a tracked exception in docs/CONSTRAINTS.md.\n' +
      'rule-removed / threshold-removed can also mean a rule was renamed or a' +
      ' number lost its direction words: rename and retune in separate commits.',
  );
  return 1;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`floor-guard: could not run: ${error.message}`);
  process.exitCode = 2;
}

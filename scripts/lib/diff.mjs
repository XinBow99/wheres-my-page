/**
 * @fileoverview Diff plumbing shared by floor-guard and changed-coverage.
 *
 * Collects the change between the merge base with `base` and the working
 * tree, including staged and untracked files (git diff alone misses new
 * files). Any git failure throws, and callers map that to exit 2 so a guard
 * that could not run never reads as clean.
 */

import {execFileSync} from 'node:child_process';

/**
 * Runs git and returns stdout, or null on failure.
 * `git diff --no-index` exits 1 when the sides differ, which is the normal
 * case for a new file, so that output is kept when `diffExit` is set.
 * @param {string[]} args Git arguments.
 * @param {{diffExit?: boolean}} [options]
 * @return {string|null}
 */
function git(args, {diffExit = false} = {}) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    if (diffExit && error.status === 1 && typeof error.stdout === 'string') {
      return error.stdout;
    }
    return null;
  }
}

/**
 * @typedef {{file: string, line: number, text: string}} DiffLine
 * @typedef {{added: DiffLine[], removed: DiffLine[], deleted: string[]}} Diff
 */

/**
 * Collects added/removed lines (with new-file line numbers for added lines)
 * and deleted files between the merge base with `base` and the work tree.
 * @param {string} base Branch or ref to diff against.
 * @return {Diff}
 */
export function collectDiff(base) {
  const top = git(['rev-parse', '--show-toplevel'])?.trim();
  if (!top) throw new Error('not inside a git work tree');
  process.chdir(top);

  const mergeBase = git(['merge-base', base, 'HEAD'])?.trim();
  if (!mergeBase) throw new Error(`no merge base against ${base}`);

  const tracked = git(['diff', '--unified=0', '--no-color', mergeBase, '--']);
  if (tracked === null) throw new Error(`could not diff against ${mergeBase}`);

  const untrackedList = git(['ls-files', '--others', '--exclude-standard']);
  if (untrackedList === null) throw new Error('could not list untracked files');
  const untracked = untrackedList
    .split('\n')
    .filter(Boolean)
    .map(file => {
      const out = git(
        ['diff', '--no-index', '--unified=0', '--no-color', '/dev/null', file],
        {diffExit: true},
      );
      if (out === null) throw new Error(`could not diff untracked ${file}`);
      return out;
    });

  return parseUnifiedDiff([tracked, ...untracked].join('\n'));
}

/**
 * Parses a unified diff. `---`/`+++` are headers only between a `diff` line
 * and the first `@@`; inside a hunk every line is content.
 * @param {string} diff Unified diff text with --unified=0.
 * @return {Diff}
 */
export function parseUnifiedDiff(diff) {
  const added = [];
  const removed = [];
  const deleted = [];
  const pathOf = s => s.replace(/^[ab]\//, '');
  let file = '';
  let oldFile = '';
  let inHeader = false;
  let newLine = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff ')) {
      inHeader = true;
    } else if (line.startsWith('@@')) {
      inHeader = false;
      newLine = Number(/\+(\d+)/.exec(line)?.[1] ?? 0);
    } else if (inHeader) {
      if (line.startsWith('--- ')) oldFile = pathOf(line.slice(4));
      else if (line.startsWith('+++ ')) {
        const newFile = pathOf(line.slice(4));
        file = newFile === '/dev/null' ? oldFile : newFile;
        if (newFile === '/dev/null') deleted.push(file);
      }
    } else if (line.startsWith('+')) {
      added.push({file, line: newLine++, text: line.slice(1)});
    } else if (line.startsWith('-')) {
      removed.push({file, line: 0, text: line.slice(1)});
    }
  }
  return {added, removed, deleted};
}

/**
 * Reads the base ref from `--base <ref>`, defaulting to `main`.
 * @return {string}
 */
export function baseFromArgs() {
  const i = process.argv.indexOf('--base');
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : 'main';
}

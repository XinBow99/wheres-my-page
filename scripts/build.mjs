/**
 * @fileoverview Builds the unpacked extension into dist/.
 *
 * Strangler phase: the frozen v0.5.0 PoC files are copied as-is, and the
 * MediaPipe runtime comes from node_modules instead of vendored copies.
 * Later tasks replace PoC files one at a time with esbuild outputs from src/.
 */

import {cpSync, existsSync, mkdirSync, readdirSync, rmSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const MEDIAPIPE = join(ROOT, 'node_modules', '@mediapipe', 'tasks-retrieval');

/** Frozen PoC files (docs/CONSTRAINTS.md exception W1), copied verbatim. */
const POC_FILES = [
  'manifest.json',
  'background.js',
  'chunk.js',
  'content.js',
  'offscreen.html',
  'offscreen.js',
  'picker.js',
  'popup.html',
  'popup.js',
  'search.css',
  'search.html',
  'search.js',
  'shared.js',
  'store.js',
];

/**
 * MediaPipe files the extension loads, as [source in package, dest in dist].
 * Only the non-module wasm variant is used (same as the PoC), which keeps the
 * unused 24 MB module_internal variant out of dist/.
 */
const MEDIAPIPE_FILES = [
  ['retrieval_bundle.mjs', 'lib/retrieval_bundle.mjs'],
  ['wasm/retrieval_wasm_internal.js', 'wasm/retrieval_wasm_internal.js'],
  ['wasm/retrieval_wasm_internal.wasm', 'wasm/retrieval_wasm_internal.wasm'],
];

/**
 * Copies one file, failing loudly if the source is missing.
 * @param {string} from Absolute source path.
 * @param {string} to Absolute destination path.
 */
function copyFile(from, to) {
  if (!existsSync(from)) {
    throw new Error(`build: missing source file ${from}`);
  }
  mkdirSync(dirname(to), {recursive: true});
  cpSync(from, to);
}

/**
 * Copies a directory tree file by file. Recursive cpSync on a directory
 * crashes Node 22 on Windows without any error when the path contains
 * non-ASCII characters (e.g. a checkout under 桌面), so it is avoided here.
 * @param {string} from Absolute source directory.
 * @param {string} to Absolute destination directory.
 */
function copyDir(from, to) {
  for (const entry of readdirSync(from, {withFileTypes: true})) {
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory()) {
      copyDir(src, dest);
    } else {
      copyFile(src, dest);
    }
  }
}

function build() {
  rmSync(DIST, {recursive: true, force: true});
  mkdirSync(DIST, {recursive: true});

  for (const file of POC_FILES) {
    copyFile(join(ROOT, file), join(DIST, file));
  }
  copyDir(join(ROOT, 'icons'), join(DIST, 'icons'));

  if (!existsSync(MEDIAPIPE)) {
    throw new Error(
      'build: @mediapipe/tasks-retrieval not installed; run `npm ci` first',
    );
  }
  for (const [from, to] of MEDIAPIPE_FILES) {
    copyFile(join(MEDIAPIPE, from), join(DIST, to));
  }
  console.log(`build: wrote ${DIST}`);
}

build();

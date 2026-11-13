/**
 * @fileoverview Builds the unpacked extension into dist/.
 *
 * Strangler phase: the frozen v0.5.0 PoC files are copied as-is, and the
 * MediaPipe runtime comes from node_modules instead of vendored copies.
 * PoC files are replaced one at a time by esbuild outputs from src/legacy
 * shims (LEGACY_SHIMS).
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {build as esbuild} from 'esbuild';

import {EXTENSION_KEY} from './extension-key.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const MEDIAPIPE = join(ROOT, 'node_modules', '@mediapipe', 'tasks-retrieval');

/**
 * Frozen PoC files (docs/CONSTRAINTS.md exception W1), copied verbatim.
 * manifest.json is written separately because it gets the fixed `key`.
 * A file replaced by a shim in LEGACY_SHIMS is no longer listed here.
 */
const POC_FILES = [
  'background.js',
  'content.js',
  'offscreen.html',
  'offscreen.js',
  'picker.js',
  'popup.html',
  'popup.js',
  'search.css',
  'search.html',
  'search.js',
  'store.js',
];

/**
 * PoC modules rebuilt from src/, as [entry under src/legacy, output in dist].
 * Each shim keeps the PoC file's name and export names, so the remaining PoC
 * files import the new code without changes (docs/tasks/plan.md decision 1).
 */
const LEGACY_SHIMS = [
  ['chunk_shim.ts', 'chunk.js'],
  ['shared_shim.ts', 'shared.js'],
];

/** Oldest Chrome the manifest allows (minimum_chrome_version). */
const CHROME_TARGET = 'chrome116';

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

/**
 * Writes the PoC manifest with the fixed `key`, so the unpacked extension
 * keeps the same ID wherever dist/ is loaded from (scripts/extension-key.mjs).
 * The root manifest.json is left alone: it is the PoC loaded from the repo
 * root, whose path-based ID holds the old v0.5.0 index.
 */
function writeManifest() {
  const manifest = JSON.parse(
    readFileSync(join(ROOT, 'manifest.json'), 'utf8'),
  );
  writeFileSync(
    join(DIST, 'manifest.json'),
    `${JSON.stringify({...manifest, key: EXTENSION_KEY}, null, 2)}\n`,
  );
}

/**
 * Bundles each legacy shim from src/ into a standalone ES module in dist/.
 */
async function buildShims() {
  for (const [entry, out] of LEGACY_SHIMS) {
    await esbuild({
      entryPoints: [join(ROOT, 'src', 'legacy', entry)],
      outfile: join(DIST, out),
      bundle: true,
      format: 'esm',
      target: CHROME_TARGET,
      logLevel: 'warning',
    });
  }
}

async function build() {
  rmSync(DIST, {recursive: true, force: true});
  mkdirSync(DIST, {recursive: true});

  writeManifest();
  for (const file of POC_FILES) {
    copyFile(join(ROOT, file), join(DIST, file));
  }
  await buildShims();
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

await build();

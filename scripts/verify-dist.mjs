/**
 * @fileoverview Verifies dist/ is a loadable extension and reports its size.
 *
 * Checks that every file referenced by the manifest, by HTML pages
 * (script src / link href) and by relative ES module imports exists, plus the
 * MediaPipe wasm files whose path is only built at runtime.
 *
 * Exit codes: 0 ok, 1 missing files, 2 the check itself could not run.
 */

import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {dirname, join, posix, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

/** Loaded via a runtime-built path (FilesetResolver), so no static reference. */
const RUNTIME_FILES = ['wasm/retrieval_wasm_internal.js', 'wasm/retrieval_wasm_internal.wasm'];

/**
 * Lists all files under a directory as dist-relative POSIX paths.
 * @param {string} dir Absolute directory path.
 * @return {string[]}
 */
function listFiles(dir) {
  return readdirSync(dir, {recursive: true, withFileTypes: true})
    .filter((entry) => entry.isFile())
    .map((entry) => relative(DIST, join(entry.parentPath, entry.name)).split('\\').join('/'));
}

/**
 * Collects dist-relative paths referenced by manifest.json.
 * @param {Record<string, any>} manifest Parsed manifest.
 * @return {string[]}
 */
function manifestRefs(manifest) {
  const refs = [];
  const add = (value) => {
    if (typeof value === 'string') refs.push(value);
  };
  add(manifest.background?.service_worker);
  add(manifest.action?.default_popup);
  add(manifest.side_panel?.default_path);
  add(manifest.options_page);
  for (const icon of Object.values(manifest.icons ?? {})) add(icon);
  for (const icon of Object.values(manifest.action?.default_icon ?? {})) add(icon);
  for (const script of manifest.content_scripts ?? []) {
    for (const file of [...(script.js ?? []), ...(script.css ?? [])]) add(file);
  }
  return refs;
}

/**
 * Collects relative references from an HTML page or a JS module.
 * @param {string} file Dist-relative path of the referencing file.
 * @return {string[]} Dist-relative paths of the referenced files.
 */
function fileRefs(file) {
  const text = readFileSync(join(DIST, file), 'utf8');
  const patterns = file.endsWith('.html')
    ? [/<script[^>]*\ssrc="([^"]+)"/g, /<link[^>]*\shref="([^"]+)"/g]
    : [/\bfrom\s*["'](\.{1,2}\/[^"']+)["']/g, /\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g];
  const refs = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const target = match[1];
      if (/^[a-z]+:/i.test(target)) continue; // absolute URL, not a packaged file
      refs.push(posix.normalize(posix.join(posix.dirname(file), target)));
    }
  }
  return refs;
}

function main() {
  if (!existsSync(join(DIST, 'manifest.json'))) {
    console.error('verify-dist: dist/manifest.json not found; run `npm run build` first');
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
  const files = listFiles(DIST);

  const refs = new Map(); // referenced path -> files that reference it
  const addRef = (ref, from) => refs.set(ref, [...(refs.get(ref) ?? []), from]);
  for (const ref of manifestRefs(manifest)) addRef(ref, 'manifest.json');
  for (const ref of RUNTIME_FILES) addRef(ref, 'runtime (FilesetResolver)');
  for (const file of files.filter((f) => /\.(html|js|mjs)$/.test(f))) {
    for (const ref of fileRefs(file)) addRef(ref, file);
  }

  const missing = [...refs].filter(([ref]) => !existsSync(join(DIST, ref)));
  for (const [ref, from] of missing) {
    console.error(`verify-dist: missing ${ref} (referenced by ${from.join(', ')})`);
  }

  const bytes = (f) => statSync(join(DIST, f)).size;
  const total = files.reduce((sum, f) => sum + bytes(f), 0);
  const withoutWasm = files.filter((f) => !f.endsWith('.wasm')).reduce((sum, f) => sum + bytes(f), 0);
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  console.log(`verify-dist: ${files.length} files, ${refs.size} references checked`);
  console.log(`verify-dist: total ${kb(total)}, excluding wasm ${kb(withoutWasm)}`);
  for (const f of files.filter((f) => /\.(js|mjs)$/.test(f))) {
    console.log(`  ${f.padEnd(40)} ${kb(bytes(f))}`);
  }
  process.exit(missing.length ? 1 : 0);
}

try {
  main();
} catch (error) {
  console.error(`verify-dist: could not run: ${error instanceof Error ? error.message : error}`);
  process.exit(2);
}

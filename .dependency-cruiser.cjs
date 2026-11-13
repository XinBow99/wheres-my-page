/**
 * @fileoverview Module boundaries from docs/CONSTRAINTS.md
 * ("模組依賴規則"). An arrow not allowed there is forbidden here.
 */

/**
 * Builds a rule forbidding `from` modules to import any `to` module.
 * @param {string} name Rule name.
 * @param {string} comment Why the boundary exists.
 * @param {string} from Path regex of the importing module.
 * @param {string} to Path regex of the forbidden target.
 * @return {object} dependency-cruiser forbidden rule.
 */
function forbid(name, comment, from, to) {
  return {name, comment, severity: 'error', from: {path: from}, to: {path: to}};
}

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'Circular imports hide layering problems.',
      severity: 'error',
      from: {},
      to: {circular: true},
    },
    forbid(
      'shared-is-a-leaf',
      'src/shared may only import src/shared.',
      '^src/shared/',
      '^src/(?!shared/)',
    ),
    forbid(
      'core-is-pure',
      'src/core may only import src/core and src/shared.',
      '^src/core/',
      '^src/(?!core/|shared/)',
    ),
    forbid(
      'storage-below-offscreen',
      'src/storage may only import storage, core and shared.',
      '^src/storage/',
      '^src/(?!storage/|core/|shared/)',
    ),
    forbid(
      'offscreen-not-other-contexts',
      'The offscreen document talks to other contexts only via messaging.',
      '^src/offscreen/',
      '^src/(background|content|ui)/',
    ),
    forbid(
      'background-not-other-contexts',
      'The service worker must not own the model or the index.',
      '^src/background/',
      '^src/(storage|offscreen|content|ui)/',
    ),
    forbid(
      'content-not-other-contexts',
      'Content scripts are untrusted and talk to the extension via messaging.',
      '^src/content/',
      '^src/(storage|offscreen|background|ui)/',
    ),
    forbid(
      'ui-not-other-contexts',
      'Extension pages talk to the service worker via messaging only.',
      '^src/ui/',
      '^src/(storage|offscreen|background|content)/',
    ),
    forbid(
      'mediapipe-only-in-offscreen',
      'Only the offscreen document hosts the model runtime.',
      '^src/(?!offscreen/)',
      '@mediapipe/',
    ),
    forbid(
      'no-test-imports-in-source',
      'Production code must not import test files or test helpers.',
      '^src/.*(?<!_test)\\.ts$',
      '(_test\\.ts$|^test/)',
    ),
  ],
  options: {
    doNotFollow: {path: 'node_modules'},
    tsPreCompilationDeps: true,
    tsConfig: {fileName: 'tsconfig.json'},
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.js', '.mjs'],
    },
  },
};

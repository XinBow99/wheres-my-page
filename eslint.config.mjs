/**
 * @fileoverview ESLint flat config: Google TypeScript Style (gts) plus the
 * project rules from docs/CONSTRAINTS.md. Run with --max-warnings 0.
 */

import gts from 'gts';
import jsdoc from 'eslint-plugin-jsdoc';
import globals from 'globals';

/** Frozen v0.5.0 PoC files: docs/CONSTRAINTS.md exception W1. */
const POC_FILES = [
  'background.js',
  'chunk.js',
  'content.js',
  'offscreen.js',
  'picker.js',
  'popup.js',
  'search.js',
  'shared.js',
  'store.js',
];

/** DOM sinks that parse HTML; dynamic data must go through textContent. */
const HTML_SINKS = ['innerHTML', 'outerHTML', 'insertAdjacentHTML'].map(
  property => ({
    property,
    message: 'Build DOM nodes and use textContent (docs/CONSTRAINTS.md).',
  }),
);

/** Browser and storage APIs that src/core must not touch (pure logic). */
const CORE_FORBIDDEN_GLOBALS = [
  'chrome',
  'document',
  'window',
  'navigator',
  'indexedDB',
  'localStorage',
  'caches',
  'fetch',
].map(name => ({
  name,
  message: 'src/core is environment-free; pass data in from the caller.',
}));

export default [
  {
    ignores: [
      'dist/',
      'coverage/',
      'node_modules/',
      'test/fixtures/',
      'lib/',
      'wasm/',
      ...POC_FILES,
    ],
  },
  {
    // An eslint-disable comment has no effect: fix the code instead.
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: 'error',
    },
  },
  ...gts,
  {
    files: ['scripts/**/*.mjs', 'eslint.config.mjs', 'vitest.config.mjs'],
    languageOptions: {globals: globals.node},
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    ...jsdoc.configs['flat/recommended-typescript-error'],
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    settings: {
      // Google JS/TS style tag names.
      jsdoc: {tagNamePreference: {returns: 'return', file: 'fileoverview'}},
    },
    rules: {
      // Google style: a blank line between the description and the tags.
      'jsdoc/tag-lines': ['error', 'any', {startLines: 1}],
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: true,
          require: {
            FunctionDeclaration: true,
            ClassDeclaration: true,
            MethodDefinition: true,
          },
          contexts: ['TSInterfaceDeclaration', 'TSTypeAliasDeclaration'],
        },
      ],
      'jsdoc/require-returns': ['error', {publicOnly: true}],
      'jsdoc/require-param': ['error', {contexts: ['FunctionDeclaration']}],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-expect-error': true,
          'ts-check': false,
        },
      ],
      'no-restricted-exports': [
        'error',
        {
          restrictDefaultExports: {
            direct: true,
            named: true,
            defaultFrom: true,
          },
        },
      ],
      'no-restricted-properties': [
        'error',
        // Kept from gts: no focused tests.
        {object: 'describe', property: 'only'},
        {object: 'it', property: 'only'},
        ...HTML_SINKS,
        {object: 'document', property: 'write'},
      ],
    },
  },
  {
    files: ['src/**/*_test.ts', 'test/**/*.ts'],
    rules: {
      // Test cases document themselves through their names.
      'jsdoc/require-jsdoc': 'off',
    },
  },
  {
    files: ['src/core/**/*.ts'],
    rules: {'no-restricted-globals': ['error', ...CORE_FORBIDDEN_GLOBALS]},
  },
];

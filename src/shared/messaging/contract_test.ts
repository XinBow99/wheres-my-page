import {readFileSync} from 'node:fs';

import {describe, expect, expectTypeOf, it} from 'vitest';

import type {IsJsonable} from '../types';
import {
  LEGACY_MESSAGE_TYPES,
  MESSAGE_SPECS,
  type MessageType,
  PRIVILEGED_MESSAGES,
  type RequestMap,
  type RequestOf,
  type ResponseOf,
  type SearchRequest,
  type SearchResponse,
  type Target,
} from './contract';

const TARGETS = Object.keys(MESSAGE_SPECS) as Target[];

/**
 * Reads a frozen v0.5.0 file from the repository root.
 *
 * @param name File name.
 * @return Source text.
 */
function poc(name: string): string {
  return readFileSync(new URL(`../../../${name}`, import.meta.url), 'utf8');
}

/**
 * Collects regex group 1 over every match.
 *
 * @param source Text to scan.
 * @param re Global regex with one capture group.
 * @return Captured names.
 */
function captures(source: string, re: RegExp): string[] {
  return [...source.matchAll(re)].map(m => m[1] ?? '');
}

/**
 * Message names v0.5.0 sends or handles. content.js and picker.js also use
 * `type:` for dwell machine events, so only their send() calls and listener
 * checks count; in the other files every upper-case `type:` is a message.
 *
 * @return Sorted unique names.
 */
function pocMessageNames(): string[] {
  const names = new Set<string>();
  const sendCall = /\bsend\(\{\s*type:\s*"([A-Z_]+)"/g;
  const tabsSend = /sendMessage\([^{]*\{\s*type:\s*"([A-Z_]+)"/g;
  const listener = /msg\?\.type\s*[!=]==\s*"([A-Z_]+)"/g;
  const anyType = /\btype:\s*"([A-Z_]+)"/g;
  const switchCase = /\bcase\s+"([A-Z_]+)"/g;
  for (const file of ['content.js', 'picker.js']) {
    const src = poc(file);
    for (const re of [sendCall, tabsSend, listener]) {
      captures(src, re).forEach(n => names.add(n));
    }
  }
  for (const file of [
    'background.js',
    'offscreen.js',
    'popup.js',
    'search.js',
  ]) {
    const src = poc(file);
    for (const re of [anyType, switchCase, listener]) {
      captures(src, re).forEach(n => names.add(n));
    }
  }
  return [...names].sort();
}

describe('LEGACY_MESSAGE_TYPES', () => {
  const names = pocMessageNames();

  it('finds the v0.5.0 messages in the PoC source', () => {
    // Guards the extraction regexes: v0.5.0 has 24 message names.
    expect(names).toHaveLength(24);
    expect(names).toEqual(expect.arrayContaining(['INDEX', 'INDEX_NOW']));
  });

  it('maps every PoC message, and nothing else', () => {
    expect(Object.keys(LEGACY_MESSAGE_TYPES).sort()).toEqual(names);
  });

  it('maps to message types that exist in the contract', () => {
    const known = new Set(TARGETS.flatMap(t => Object.keys(MESSAGE_SPECS[t])));
    for (const type of Object.values(LEGACY_MESSAGE_TYPES)) {
      expect(known).toContain(type);
    }
  });

  it('maps PoC names one-to-one', () => {
    const types = Object.values(LEGACY_MESSAGE_TYPES);
    expect(new Set(types).size).toBe(types.length);
  });
});

describe('MESSAGE_SPECS', () => {
  const entries = TARGETS.flatMap(target =>
    Object.entries(MESSAGE_SPECS[target]).map(
      ([type, spec]) => [`${target} ${type}`, target, spec] as const,
    ),
  );

  it.each(entries)('%s has senders and a timeout', (_, target, spec) => {
    expect(spec.allowedFrom.length).toBeGreaterThan(0);
    expect(new Set(spec.allowedFrom).size).toBe(spec.allowedFrom.length);
    expect(spec.allowedFrom).not.toContain(target);
    expect(Number.isInteger(spec.timeoutMs)).toBe(true);
    expect(spec.timeoutMs).toBeGreaterThan(0);
  });

  it('accepts privileged messages from extension pages only', () => {
    expect(PRIVILEGED_MESSAGES).toEqual(
      expect.arrayContaining([
        'index.clear',
        'index.deleteDomain',
        'history.import',
        'category.put',
        'category.delete',
      ]),
    );
    for (const type of PRIVILEGED_MESSAGES) {
      expect(MESSAGE_SPECS.background[type].allowedFrom).toEqual([
        'extension-page',
      ]);
    }
  });

  it('accepts content-script messages only where the PoC sent them', () => {
    const fromContent = Object.entries(MESSAGE_SPECS.background)
      .filter(([, spec]) => spec.allowedFrom.includes('content-script'))
      .map(([type]) => type)
      .sort();
    expect(fromContent).toEqual([
      'index.clip',
      'index.deletePage',
      'index.image',
      'index.page',
      'page.info',
      'tag.set',
      'ui.openSearch',
    ]);
  });

  it('lets only the background talk to the offscreen document', () => {
    for (const spec of Object.values(MESSAGE_SPECS.offscreen)) {
      expect(spec.allowedFrom).toEqual(['background']);
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(MESSAGE_SPECS)).toBe(true);
    for (const target of TARGETS) {
      expect(Object.isFrozen(MESSAGE_SPECS[target])).toBe(true);
    }
    expect(Object.isFrozen(MESSAGE_SPECS.background['index.clear'])).toBe(true);
  });
});

/** `true` when every request and reply of `T` is JSON-serializable. */
type AllJsonable<T extends Target> = {
  [K in MessageType<T>]: IsJsonable<RequestMap[T][K]>;
}[MessageType<T>];

describe('contract types', () => {
  it('only carry JSON-serializable payloads and replies', () => {
    expectTypeOf<AllJsonable<'background'>>().toEqualTypeOf<true>();
    expectTypeOf<AllJsonable<'offscreen'>>().toEqualTypeOf<true>();
    expectTypeOf<AllJsonable<'content'>>().toEqualTypeOf<true>();
  });

  // Checked<M> requires IsJsonable of each entry's req and res.
  it('reject a Float32Array, Map or Date payload', () => {
    expectTypeOf<
      IsJsonable<{req: {vec: Float32Array}; res: null}>
    >().toEqualTypeOf<false>();
    expectTypeOf<
      IsJsonable<{req: {seen: Map<string, number>}; res: null}>
    >().toEqualTypeOf<false>();
    expectTypeOf<
      IsJsonable<{req: null; res: {at: Date}}>
    >().toEqualTypeOf<false>();
  });

  it('resolves payload and reply types per target', () => {
    expectTypeOf<
      RequestOf<'background', 'search.query'>
    >().toEqualTypeOf<SearchRequest>();
    expectTypeOf<
      ResponseOf<'offscreen', 'search.query'>
    >().toEqualTypeOf<SearchResponse>();
    expectTypeOf<RequestOf<'offscreen', 'history.import'>>().toHaveProperty(
      'items',
    );
    expectTypeOf<RequestOf<'background', 'history.import'>>().toHaveProperty(
      'days',
    );
  });
});

import {describe, expect, it} from 'vitest';

import {
  MAX_CLIP_TEXT_LENGTH,
  MAX_IMAGE_DATA_URL_LENGTH,
  MAX_PAGE_TEXT_LENGTH,
  MESSAGE_SPECS,
  type MessageType,
  type RequestOf,
  type Target,
} from './contract';
import {
  type Guard,
  MAX_HISTORY_ITEMS,
  MAX_NAME_LENGTH,
  MAX_QUERY_LENGTH,
  MAX_SCREENSHOT_DATA_URL_LENGTH,
  MAX_SHORT_TEXT_LENGTH,
  MAX_URL_LENGTH,
  REQUEST_GUARDS,
  isCategoryPutRequest,
  isClipImageRequest,
  isClipRequest,
  isClipSelectionRequest,
  isEmptyRequest,
  isEngineSettings,
  isHistoryImportRequest,
  isHistoryItemsRequest,
  isImageRequest,
  isOffscreenImageRequest,
  isSearchRequest,
  validateEnvelope,
} from './validate';

const URL_A = 'https://example.com/a';
const PNG = 'data:image/png;base64,AAAA';

const PAYLOADS: {
  readonly [T in Target]: {readonly [K in MessageType<T>]: RequestOf<T, K>};
} = (() => {
  const page = {url: URL_A, title: '標題', text: '中文內文'};
  const clip = {
    parentUrl: URL_A,
    linkUrl: `${URL_A}#:~:text=block`,
    title: '標題',
    text: 'block text',
    note: '',
    selector: 'div > p',
  };
  const image = {
    parentUrl: URL_A,
    linkUrl: URL_A,
    title: '標題',
    caption: '圖說',
    note: '',
    srcUrl: `${URL_A}.png`,
    selector: 'img',
    auto: false,
    image: PNG,
    rect: {left: 0, top: 10, width: 100, height: 50},
    dpr: 2,
  };
  const forwarded = {
    'index.page': page,
    'index.clip': clip,
    'tag.set': {url: URL_A, catId: 'ai', on: true},
    'index.deletePage': {url: URL_A},
    'status.get': {},
    'search.query': {
      query: '珍珠奶茶',
      k: 60,
      sinceTs: 0,
      domain: '',
      tag: '',
    },
    'model.load': {},
    'index.domains': {},
    'index.deleteDomain': {domain: 'example.com'},
    'index.clear': {},
    'category.list': {},
    'category.put': {
      cat: {id: 'ai', name: 'AI', description: '人工智慧', color: '#4a7'},
    },
    'category.delete': {id: 'ai'},
    'category.scorePage': {url: URL_A},
  } as const;
  return {
    background: {
      ...forwarded,
      'index.image': image,
      'page.info': {url: URL_A},
      'history.import': {days: 30, max: 3000},
      'ui.openSearch': {q: '標題'},
      'policy.isDenied': {url: URL_A},
    },
    offscreen: {
      ...forwarded,
      'index.image': {...image, shot: null},
      'page.info': {url: URL_A},
      'history.import': {
        items: [{url: URL_A, title: '標題', lastVisitTime: 1_700_000_000_000}],
      },
      'settings.sync': {model: 'eg2_270m', tagMinScore: 0.2},
    },
    content: {
      'index.now': {},
      'picker.start': {},
      'clip.context': {},
      'clip.selection': {text: 'selected text'},
      'clip.image': {srcUrl: `${URL_A}.png`},
    },
  };
})();

/** Longest length of each string field, by field name. */
const STRING_LIMITS: Readonly<Record<string, number>> = {
  url: MAX_URL_LENGTH,
  parentUrl: MAX_URL_LENGTH,
  linkUrl: MAX_URL_LENGTH,
  srcUrl: MAX_URL_LENGTH,
  title: MAX_SHORT_TEXT_LENGTH,
  note: MAX_SHORT_TEXT_LENGTH,
  caption: MAX_SHORT_TEXT_LENGTH,
  selector: MAX_SHORT_TEXT_LENGTH,
  description: MAX_SHORT_TEXT_LENGTH,
  query: MAX_QUERY_LENGTH,
  q: MAX_QUERY_LENGTH,
  domain: MAX_NAME_LENGTH,
  tag: MAX_NAME_LENGTH,
  catId: MAX_NAME_LENGTH,
  id: MAX_NAME_LENGTH,
  name: MAX_NAME_LENGTH,
  color: MAX_NAME_LENGTH,
  image: MAX_IMAGE_DATA_URL_LENGTH,
};

/** Fields whose limit depends on the message. */
const TEXT_LIMITS: Readonly<Record<string, number>> = {
  'index.page': MAX_PAGE_TEXT_LENGTH,
  'index.clip': MAX_CLIP_TEXT_LENGTH,
  'clip.selection': MAX_CLIP_TEXT_LENGTH,
};

/** String fields checked against a fixed set of values instead. */
const ENUM_FIELDS = new Set(['model']);

/** Optional fields: may be left out. */
const OPTIONAL = new Set(['max']);

/**
 * A value of the wrong JSON type for `value`.
 *
 * @param value Valid value.
 * @return Value of another type.
 */
function wrongType(value: unknown): unknown {
  if (typeof value === 'string') return 42;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return 1;
  if (Array.isArray(value)) return {length: 0};
  return 'not an object';
}

/**
 * `s` padded with "a" to `length`.
 *
 * @param s Valid string (its prefix, e.g. "data:", is kept).
 * @param length Target length.
 * @return Padded string.
 */
function padTo(s: string, length: number): string {
  return s + 'a'.repeat(length - s.length);
}

/**
 * Copy of `obj` without `key`.
 *
 * @param obj Object.
 * @param key Field to leave out.
 * @return New object.
 */
function without(obj: object, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
}

const ENTRIES = (Object.keys(PAYLOADS) as Target[]).flatMap(target =>
  Object.entries(PAYLOADS[target]).map(([type, payload]) => ({
    label: `${target} ${type}`,
    target,
    type,
    payload: payload as Readonly<Record<string, unknown>>,
    guard: (REQUEST_GUARDS[target] as Readonly<Record<string, Guard<unknown>>>)[
      type
    ]!,
  })),
);

describe('REQUEST_GUARDS', () => {
  it('covers exactly the contract', () => {
    for (const target of Object.keys(MESSAGE_SPECS) as Target[]) {
      expect(Object.keys(REQUEST_GUARDS[target]).sort()).toEqual(
        Object.keys(MESSAGE_SPECS[target]).sort(),
      );
      expect(Object.keys(PAYLOADS[target]).sort()).toEqual(
        Object.keys(MESSAGE_SPECS[target]).sort(),
      );
    }
  });

  describe.each(ENTRIES)('$label', ({type, payload, guard}) => {
    const fields = Object.keys(payload);

    it('accepts a valid payload', () => {
      expect(guard(payload)).toBe(true);
      expect(guard(JSON.parse(JSON.stringify(payload)))).toBe(true);
    });

    it.each([null, undefined, 'x', 1, [], [payload]])(
      'rejects %j as payload',
      bad => {
        expect(guard(bad)).toBe(false);
      },
    );

    it('rejects an unknown field', () => {
      expect(guard({...payload, extra: 1})).toBe(false);
      expect(guard({...payload, __proto__: null, extra: 1})).toBe(false);
    });

    if (!fields.length) return;

    it.each(fields)('rejects a missing %s unless optional', field => {
      expect(guard(without(payload, field))).toBe(OPTIONAL.has(field));
    });

    it.each(fields)('rejects a wrongly typed %s', field => {
      expect(guard({...payload, [field]: wrongType(payload[field])})).toBe(
        false,
      );
    });

    const strings = fields.filter(
      f => typeof payload[f] === 'string' && !ENUM_FIELDS.has(f),
    );
    it.each(strings)('limits the length of %s', field => {
      const limit = field === 'text' ? TEXT_LIMITS[type] : STRING_LIMITS[field];
      expect(limit).toBeDefined();
      const value = payload[field] as string;
      expect(guard({...payload, [field]: padTo(value, limit!)})).toBe(true);
      expect(guard({...payload, [field]: padTo(value, limit! + 1)})).toBe(
        false,
      );
    });

    const numbers = fields.filter(f => typeof payload[f] === 'number');
    it.each(numbers)('rejects NaN and ±Infinity as %s', field => {
      for (const bad of [NaN, Infinity, -Infinity]) {
        expect(guard({...payload, [field]: bad})).toBe(false);
      }
    });
  });
});

describe('field rules', () => {
  const page = PAYLOADS.background['index.page'];
  const image = PAYLOADS.background['index.image'];
  const search = PAYLOADS.background['search.query'];

  it('requires non-empty URLs and ids', () => {
    expect(REQUEST_GUARDS.background['index.page']({...page, url: ''})).toBe(
      false,
    );
    expect(REQUEST_GUARDS.background['category.delete']({id: ''})).toBe(false);
  });

  it('accepts null for the image and the rect', () => {
    expect(isImageRequest({...image, image: null, rect: null})).toBe(true);
  });

  it('only accepts data URLs as image data', () => {
    expect(isImageRequest({...image, image: 'https://example.com/a.png'})).toBe(
      false,
    );
    const offscreen = PAYLOADS.offscreen['index.image'];
    expect(isOffscreenImageRequest({...offscreen, shot: PNG})).toBe(true);
    expect(isOffscreenImageRequest({...offscreen, shot: 'AAAA'})).toBe(false);
    expect(
      isOffscreenImageRequest({
        ...offscreen,
        shot: padTo('data:', MAX_SCREENSHOT_DATA_URL_LENGTH + 1),
      }),
    ).toBe(false);
  });

  it('checks the rect fields', () => {
    const rect = {left: 0, top: 0, width: 10, height: 10};
    expect(isImageRequest({...image, rect: {...rect, width: NaN}})).toBe(false);
    expect(isImageRequest({...image, rect: {...rect, height: -1}})).toBe(false);
    expect(isImageRequest({...image, rect: {...rect, z: 1}})).toBe(false);
    expect(isImageRequest({...image, rect: {left: 0, top: 0}})).toBe(false);
    expect(isImageRequest({...image, rect: {...rect, left: -20}})).toBe(true);
  });

  it('wants a positive devicePixelRatio', () => {
    expect(isImageRequest({...image, dpr: 0})).toBe(false);
    expect(isImageRequest({...image, dpr: 0.5})).toBe(true);
    expect(isImageRequest({...image, dpr: 17})).toBe(false);
  });

  it.each([0, -1, 1.5, 501])('rejects k = %d', k => {
    expect(isSearchRequest({...search, k})).toBe(false);
  });

  it('rejects a negative sinceTs', () => {
    expect(isSearchRequest({...search, sinceTs: -1})).toBe(false);
  });

  it('bounds the history window and the import size', () => {
    expect(isHistoryImportRequest({days: 7})).toBe(true);
    expect(isHistoryImportRequest({days: 0})).toBe(false);
    expect(isHistoryImportRequest({days: 7, max: 0})).toBe(false);
    expect(isHistoryImportRequest({days: 7, max: MAX_HISTORY_ITEMS + 1})).toBe(
      false,
    );
  });

  it('checks every history item', () => {
    const item = {url: URL_A, title: 't', lastVisitTime: 1};
    expect(isHistoryItemsRequest({items: []})).toBe(true);
    expect(isHistoryItemsRequest({items: [item, {...item, url: ''}]})).toBe(
      false,
    );
    expect(isHistoryItemsRequest({items: [{...item, extra: 1}]})).toBe(false);
    expect(
      isHistoryItemsRequest({
        items: Array.from({length: MAX_HISTORY_ITEMS + 1}, () => item),
      }),
    ).toBe(false);
  });

  it('lets category.put create without an id', () => {
    const cat = {name: '旅遊', description: '', color: '#fa0'};
    expect(isCategoryPutRequest({cat})).toBe(true);
    expect(isCategoryPutRequest({cat: {...cat, name: ''}})).toBe(false);
    expect(isCategoryPutRequest({cat: {...cat, builtin: true}})).toBe(false);
  });

  it('only accepts known models and a score in [0, 1]', () => {
    expect(isEngineSettings({model: 'eg2_440m', tagMinScore: 0})).toBe(true);
    expect(isEngineSettings({model: 'gpt', tagMinScore: 0.2})).toBe(false);
    expect(isEngineSettings({model: 'toString', tagMinScore: 0.2})).toBe(false);
    expect(isEngineSettings({model: 'eg2_270m', tagMinScore: 1.1})).toBe(false);
  });

  it('accepts null-prototype objects but not class instances', () => {
    const bare = Object.assign(Object.create(null) as object, {text: 'x'});
    expect(isClipSelectionRequest(bare)).toBe(true);
    expect(isEmptyRequest(new Date())).toBe(false);
    expect(isEmptyRequest(new Map())).toBe(false);
    expect(isClipImageRequest({srcUrl: ''})).toBe(true);
  });

  it('does not count inherited fields', () => {
    const inherited = Object.create({text: 'x'}) as object;
    expect(isClipSelectionRequest(inherited)).toBe(false);
  });

  it('is the guard used for the clip messages', () => {
    expect(REQUEST_GUARDS.background['index.clip']).toBe(isClipRequest);
  });
});

describe('validateEnvelope', () => {
  const envelope = {
    v: 1,
    target: 'background',
    type: 'search.query',
    payload: PAYLOADS.background['search.query'],
  };

  /**
   * Error message of a rejected envelope.
   *
   * @param x Envelope.
   * @param target Receiving context.
   * @return The message; fails the test if the envelope passed.
   */
  function rejection(x: unknown, target: Target = 'background'): string {
    const r = validateEnvelope(x, target);
    if (r.ok) throw new Error('expected INVALID_MESSAGE');
    expect(r.error.code).toBe('INVALID_MESSAGE');
    expect(r.error.retryable).toBe(false);
    return r.error.message;
  }

  it.each(ENTRIES)('accepts $label', ({target, type, payload}) => {
    const x = {v: 1, target, type, payload};
    expect(validateEnvelope(x, target)).toEqual({ok: true, data: x});
  });

  it.each([0, 2, '1', null, undefined])('rejects version %j', v => {
    expect(rejection({...envelope, v})).toMatch(/protocol version/);
  });

  it('rejects a missing version', () => {
    expect(rejection(without(envelope, 'v'))).toMatch(
      /protocol version undefined/,
    );
  });

  it('rejects a message for another context', () => {
    expect(rejection(envelope, 'offscreen')).toMatch(/expected offscreen/);
  });

  it.each(['SEARCH', 'toString', '__proto__', 'settings.sync', 42])(
    'rejects the type %j for the background',
    type => {
      expect(rejection({...envelope, type})).toMatch(/unknown message type/);
    },
  );

  it('rejects an invalid payload', () => {
    const payload = {...envelope.payload, k: NaN};
    expect(rejection({...envelope, payload})).toMatch(
      /invalid payload for search\.query/,
    );
    expect(rejection(without(envelope, 'payload'))).toMatch(/invalid payload/);
  });

  it('rejects unknown envelope fields', () => {
    expect(rejection({...envelope, model: 'eg2_270m', extra: 1})).toMatch(
      /unknown envelope fields: model, extra/,
    );
  });

  it.each([null, 'INDEX', [envelope], 1])('rejects %j', x => {
    expect(rejection(x)).toMatch(/not an object/);
  });

  it('rejects a v0.5.0 message', () => {
    expect(
      rejection({type: 'INDEX', url: URL_A, title: 't', text: 'x'}),
    ).toMatch(/unknown envelope fields/);
  });
});

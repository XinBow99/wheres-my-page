/**
 * @fileoverview Generates golden fixtures from the frozen v0.5.0 PoC.
 *
 * The refactored modules are characterization-tested against these files, so
 * the tests keep working after the PoC is deleted (T26). The output is
 * deterministic: seeded vectors, frozen Date.now, fresh fake IndexedDB.
 * Re-running must leave `git diff test/fixtures/poc` empty.
 *
 * Usage: node scripts/gen-golden.mjs
 */

import 'fake-indexeddb/auto';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'test', 'fixtures', 'poc');

/** 2026-01-01T00:00:00Z: every PoC timestamp is derived from this. */
const NOW = 1767225600000;
const DAY = 86400000;
Date.now = () => NOW;

// ---------------------------------------------------------------------------
// Minimal extension environment so PoC modules with top-level chrome.* calls
// can be imported in Node. Listeners are recorded but never invoked.
// ---------------------------------------------------------------------------
const noopEvent = {addListener() {}, removeListener() {}};
globalThis.chrome = {
  runtime: {
    onMessage: noopEvent,
    onInstalled: noopEvent,
    sendMessage: () => Promise.resolve({ok: true}),
    getURL: p => `chrome-extension://golden/${p}`,
  },
  storage: {
    local: {get: () => Promise.resolve({}), set: () => Promise.resolve()},
    onChanged: noopEvent,
  },
  commands: {onCommand: noopEvent},
  contextMenus: {onClicked: noopEvent},
  omnibox: {
    onInputChanged: noopEvent,
    onInputEntered: noopEvent,
    setDefaultSuggestion() {},
  },
};

/** Mulberry32: small seeded PRNG for reproducible vectors. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Float32 values printed with 9 significant digits round-trip exactly. */
function f32(x) {
  return Number(Math.fround(x).toPrecision(9));
}

/** Serializes typed arrays and rounds floats so fixtures stay small. */
function replacer(_key, value) {
  if (value instanceof Float32Array) return Array.from(value, f32);
  return value;
}

function write(name, data) {
  mkdirSync(OUT, {recursive: true});
  writeFileSync(
    join(OUT, name),
    JSON.stringify(data, replacer, 1).replace(/\r\n/g, '\n') + '\n',
  );
  console.log(`gen-golden: wrote test/fixtures/poc/${name}`);
}

// ---------------------------------------------------------------------------
// Corpus (original text written for these fixtures).
// ---------------------------------------------------------------------------
const ZH_PARAGRAPH =
  '在本機用 WebGPU 執行嵌入模型時，最常見的問題是輸入長度超過模型的固定簽章。' +
  '中文大約一個字就是一個 token，所以用字元數切塊很容易超出上限。' +
  '這篇筆記整理了 flash-attn 在 Windows 上編譯失敗的原因，以及 vLLM 的 KV cache 不夠時該怎麼調整。';
const CORPUS = {
  empty: '',
  whitespace: '   \n\n\t  ',
  controlOnly: '\u0000\u0001\u200b\ufeff',
  shortEnglish: 'Fix C2975 when building flash-attn on Windows with MSVC.',
  shortChinese: '上週看的 flash-attn Windows 編譯失敗',
  emoji: '今天天氣很好 😀🎉 適合出去走走 👍'.repeat(20),
  mixedParagraphs: [
    'vLLM KV cache 不夠的那篇',
    'The KV cache is allocated up front; lower gpu_memory_utilization.',
    ZH_PARAGRAPH,
    '',
    'Error code C2975: invalid template argument.',
  ].join('\n'),
  longChinese: Array.from({length: 12}, () => ZH_PARAGRAPH).join('\n\n'),
  hugeSingleParagraph: '語意搜尋'.repeat(1500),
  longEnglish: Array.from(
    {length: 80},
    (_, i) =>
      `Paragraph ${i}: the embedder rejects inputs longer than its signature, ` +
      'so chunks are sized by estimated tokens rather than characters.',
  ).join('\n'),
  crlfAndTabs: 'line one\r\nline\ttwo\r\n\r\n\r\n\r\nline three',
};

// ---------------------------------------------------------------------------
// chunk.js: token estimation, truncation, chunking.
// ---------------------------------------------------------------------------
async function genText() {
  const {estimateTokens, truncateToTokens, chunkText, TOKEN_BUDGET} =
    await import('../chunk.js');
  const cases = Object.entries(CORPUS).map(([name, text]) => ({
    name,
    text,
    estimateTokens: estimateTokens(text),
    truncate40: truncateToTokens(text, 40),
    chunks: chunkText(text),
    chunksSmall: chunkText(text, {
      maxTokens: 80,
      overlapTokens: 20,
      maxChunks: 8,
    }),
  }));
  write('text.json', {tokenBudget: TOKEN_BUDGET, cases});
}

// ---------------------------------------------------------------------------
// store.js pure functions.
// ---------------------------------------------------------------------------
function randomVec(seed, dim, scale = 1) {
  const r = rng(seed);
  return Float32Array.from({length: dim}, () => (r() * 2 - 1) * scale);
}

async function genMath() {
  const {normalize, dot, meanVec, toDim, pickTags, queryTerms, TAG_DEFAULTS} =
    await import('../store.js');
  const vectors = [1, 2, 3, 4].map(s => randomVec(s, 8));
  const tagCases = [
    [],
    [{id: 'a', s: 0.1}],
    [{id: 'a', s: 0.35}],
    [
      {id: 'a', s: 0.4},
      {id: 'b', s: 0.38},
      {id: 'c', s: 0.37},
      {id: 'd', s: 0.1},
    ],
    [
      {id: 'a', s: 0.3},
      {id: 'b', s: 0.29},
      {id: 'c', s: 0.29},
    ],
    [
      {id: 'a', s: 0.5},
      {id: 'b', s: 0.47},
      {id: 'c', s: 0.46},
      {id: 'd', s: 0.45},
      {id: 'e', s: 0.0},
    ],
  ];
  write('math.json', {
    tagDefaults: TAG_DEFAULTS,
    vectors,
    normalize: vectors.map(v => normalize(v)),
    normalizeZero: normalize(new Float32Array(4)),
    dot: [dot(vectors[0], vectors[1]), dot(vectors[0], vectors[1], 3)],
    meanVec: meanVec(vectors, 8),
    toDim: [toDim(Array.from(vectors[2]), 4), toDim(Array.from(vectors[3]), 8)],
    pickTags: tagCases.map(scores => ({
      scores,
      defaults: pickTags(scores),
      strict: pickTags(scores, {minScore: 0.45}),
    })),
    queryTerms: [
      '',
      'a',
      'flash-attn Windows 編譯失敗',
      'vLLM KV cache 不夠的那篇',
      'C2975，「錯誤碼」/ (template)',
      '語意搜尋瀏覽紀錄的擴充功能真的很好用而且不會上傳資料到雲端伺服器喔',
    ].map(q => ({q, terms: queryTerms(q)})),
  });
}

// ---------------------------------------------------------------------------
// background.js denylist.
// ---------------------------------------------------------------------------
async function genDenylist() {
  const {isDenied} = await import('../background.js');
  const {DEFAULT_DENYLIST} = await import('../shared.js');
  const urls = [
    'https://mail.google.com/mail/u/0/',
    'https://www.google.com/search?q=x',
    'https://mybank.com.tw/login',
    'https://online.bankofexample.com/',
    'https://www.gov.tw/login/index',
    'https://www.moi.gov.tw/login/page',
    'http://localhost:3000/',
    'http://127.0.0.1/',
    'https://github.com/vllm-project/vllm/issues/1',
    'chrome://extensions',
    'file:///C:/x.html',
    'not a url',
    'https://WEB.WHATSAPP.COM/',
  ];
  const custom = 'example.com\n*.internal\ndocs.example.org/private*\n\n  ';
  write('denylist.json', {
    defaultDenylist: DEFAULT_DENYLIST,
    custom,
    cases: urls.map(url => ({
      url,
      defaultDenied: isDenied(url, DEFAULT_DENYLIST),
      customDenied: isDenied(url, custom),
    })),
  });
}

// ---------------------------------------------------------------------------
// content.js dwell state machine (exposed as window.__semhist).
// ---------------------------------------------------------------------------
async function genDwell() {
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0; // keep the PoC tick loop from running
  // Settings never arrive, so the PoC never starts its page check or renders
  // its badge: only the pure transition() is exercised.
  globalThis.chrome.storage.local.get = () => new Promise(() => {});
  globalThis.window = globalThis;
  globalThis.top = globalThis;
  globalThis.location = {
    href: 'https://example.com/a',
    hostname: 'example.com',
  };
  globalThis.document = {
    visibilityState: 'visible',
    title: 'Example',
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  await import('../content.js');
  globalThis.setInterval = realSetInterval;
  const {S, transition, initial} = globalThis.__semhist;

  const base = {...initial(), dwellMs: 5000, chunks: 3, known: false};
  const states = [
    ...Object.values(S).map(state => ({...base, state})),
    {...base, state: S.INELIGIBLE, reason: 'no-content'},
    {...base, state: S.INELIGIBLE, reason: 'secret-input'},
    {...base, state: S.INELIGIBLE, reason: 'denylist'},
    {...base, state: S.WAITING, known: true},
  ];
  const events = [
    {type: 'URL_CHANGED'},
    {type: 'SETTINGS_DISABLED'},
    {type: 'SETTINGS_ENABLED'},
    {type: 'CHECK_RESULT', disabled: true},
    {type: 'CHECK_RESULT', denied: true, reason: 'denylist'},
    {type: 'CHECK_RESULT', indexed: true, tags: [{id: 'ai'}], visible: true},
    {type: 'CHECK_RESULT', indexed: false, visible: false},
    {type: 'HIDDEN'},
    {type: 'VISIBLE'},
    {type: 'TICK', ms: 1000, needMs: 20000},
    {type: 'TICK', ms: 15000, needMs: 20000},
    {type: 'INDEX_NOW'},
    {type: 'RESULT', result: {ok: true, chunks: 4, tags: [{id: 'gpu'}]}},
    {type: 'RESULT', result: {ok: true, skipped: 'unchanged', tags: []}},
    {type: 'RESULT', result: {ok: true, skipped: 'disabled'}},
    {type: 'RESULT', result: {ok: true, skipped: 'denylist'}},
    {type: 'RESULT', result: {ok: false, reason: 'no-content'}},
    {type: 'RESULT', result: {ok: false, error: 'WebGPU missing'}},
    {type: 'RESULT', result: {ok: false}},
    {type: 'REMOVED'},
  ];
  write('dwell.json', {
    states: Object.values(S),
    initial: initial(),
    cases: states.flatMap(ctx =>
      events.map(ev => ({ctx, ev, next: transition(ctx, ev)})),
    ),
  });
}

// ---------------------------------------------------------------------------
// store.js VectorIndex: a v2 database written by the PoC, plus search output.
// ---------------------------------------------------------------------------
const TOPICS = ['gpu', 'speech', 'finance', 'travel'];

/** A unit vector near a topic direction, so search has meaningful order. */
function topicVec(topic, seed, dim) {
  const center = randomVec(1000 + TOPICS.indexOf(topic), dim);
  const noise = randomVec(seed, dim, 0.6);
  const v = center.map((x, i) => x + noise[i]);
  const n = Math.hypot(...v);
  return v.map(x => x / n);
}

async function dumpDb(name) {
  const db = await new Promise((resolve, reject) => {
    const req = globalThis.indexedDB.open(name);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const stores = {};
  for (const store of Array.from(db.objectStoreNames).sort()) {
    stores[store] = await new Promise((resolve, reject) => {
      const req = db.transaction(store).objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  const version = db.version;
  db.close();
  return {name, version, stores};
}

async function genStore() {
  const {VectorIndex} = await import('../store.js');
  const {chunkText} = await import('../chunk.js');
  const {DIM, PRESET_CATEGORIES} = await import('../shared.js');

  const index = new VectorIndex(DIM, globalThis.indexedDB, 'golden-semhist');
  await index.open(PRESET_CATEGORIES);
  let seed = 1;
  const catTopic = {
    gpu: 'gpu',
    speech: 'speech',
    finance: 'finance',
    life: 'travel',
  };
  for (const c of index.cats.values()) {
    const topic = catTopic[c.id] ?? TOPICS[seed % TOPICS.length];
    await index.setCategoryVec(c.id, topicVec(topic, 500 + seed++, DIM));
  }

  const pages = [
    {
      url: 'https://github.com/x/flash-attn/issues/1',
      title: 'flash-attn Windows build fails with C2975',
      topic: 'gpu',
      source: 'page',
      text: CORPUS.mixedParagraphs,
      age: 1,
    },
    {
      url: 'https://docs.vllm.ai/kv-cache',
      title: 'vLLM KV cache 調整',
      topic: 'gpu',
      source: 'page',
      text: CORPUS.longChinese,
      age: 3,
    },
    {
      url: 'https://example.com/whisper',
      title: 'Whisper 語音辨識筆記',
      topic: 'speech',
      source: 'page',
      text: '語音辨識 Whisper 模型的字幕對齊與 TTS 合成。'.repeat(8),
      age: 10,
    },
    {
      url: 'https://news.example.com/etf',
      title: 'ETF 配息整理',
      topic: 'finance',
      source: 'page',
      text: '台股 ETF 的配息與殖利率整理，美股 ETF 比較。'.repeat(6),
      age: 40,
    },
    {
      url: 'https://travel.example.com/kyoto',
      title: '京都三天兩夜',
      topic: 'travel',
      source: 'history',
      text: '京都三天兩夜\ntravel.example.com kyoto',
      age: 5,
    },
    {
      url: 'https://docs.example.com/page#semhist-clip-abc',
      title: 'A clipped paragraph',
      topic: 'gpu',
      source: 'clip',
      text: 'CUDA out of memory: reduce the batch size.',
      age: 2,
      extra: {
        parentUrl: 'https://docs.example.com/page',
        linkUrl: 'https://docs.example.com/page#:~:text=CUDA',
        note: '記憶體不足',
        selector: 'main > p:nth-of-type(3)',
      },
    },
  ];
  for (const p of pages) {
    const chunks =
      p.source === 'history' ? [p.text] : chunkText(p.text, {maxChunks: 4});
    const vecs = chunks.map(() => topicVec(p.topic, seed++, DIM));
    await index.upsert(
      {
        url: p.url,
        title: p.title,
        domain: new URL(p.url).hostname,
        hash: `h${seed}`,
        source: p.source,
        ts: NOW - p.age * DAY,
        ...p.extra,
      },
      chunks,
      vecs,
    );
  }
  // A manual tag teaches the prototype; a removed auto tag must stay removed.
  await index.setTag('https://example.com/whisper', 'ai', true);
  await index.setTag('https://docs.vllm.ai/kv-cache', 'gpu', false);

  const queries = [
    {query: 'flash-attn C2975', topic: 'gpu', opts: {k: 5}},
    {query: 'KV cache 不夠', topic: 'gpu', opts: {k: 5}},
    {query: '語音 字幕', topic: 'speech', opts: {k: 3}},
    {query: 'ETF', topic: 'finance', opts: {k: 5, sinceTs: NOW - 30 * DAY}},
    {query: 'kyoto', topic: 'travel', opts: {k: 5}},
    {query: 'cuda', topic: 'gpu', opts: {k: 5, tag: '__clips__'}},
    {query: 'cache', topic: 'gpu', opts: {k: 5, domain: 'docs.vllm.ai'}},
  ];
  const search = queries.map(({query, topic, opts}) => {
    const qvec = topicVec(topic, 9000 + query.length, DIM);
    return {query, qvec, opts, results: index.search(qvec, query, opts)};
  });

  write('store.json', {
    now: NOW,
    dim: DIM,
    db: await dumpDb('golden-semhist'),
    search,
    browse: {
      all: index.browse({k: 10}),
      gpu: index.browse({k: 10, tag: 'gpu'}),
      none: index.browse({k: 10, tag: '__none__'}),
    },
    categories: index.listCategories(),
    stats: index.stats(),
    scoreWhisper: index.scoreCategories(
      index.pages.get('https://example.com/whisper').vec,
    ),
  });
}

await genText();
await genMath();
await genDenylist();
await genDwell();
await genStore();

// Offscreen document: owns the embedders (WebGPU), the text index, the image index and
// the categories. All work is serialized through one queue.
//
// Two vector spaces:
//   - text index  ("semhist")     — the model chosen in settings (default 270M text-only)
//   - image index ("semhist-img") — always EmbeddingGemma-2 Text-Vision 440M, because only
//     that model accepts images. It is loaded lazily, only once an image is indexed.
// Scores from the two spaces are never mixed; image hits are returned separately.

import { UniversalEmbedder, FilesetResolver } from "./lib/retrieval_bundle.mjs";
import { MODELS, DIM, PROMPT, PRESET_CATEGORIES, VISION_MODEL } from "./shared.js";
import { VectorIndex, toDim } from "./store.js";
import { chunkText, hashText, truncateToTokens, estimateTokens } from "./chunk.js";

const index = new VectorIndex(DIM);
const imgIndex = new VectorIndex(DIM, indexedDB, "semhist-img");
const indexReady = Promise.all([index.open(PRESET_CATEGORIES), imgIndex.open(PRESET_CATEGORIES)]);
const queryCache = new Map();
let lastError = null;
let fileset = null;

// ---- embedders -----------------------------------------------------------------------
const embedders = new Map();   // modelKey -> UniversalEmbedder
const loadingModels = new Map();
let textModel = null;          // modelKey used for the text index

async function fetchModelBytes(url) {
  const store = await caches.open("semhist-models-v1");
  let res = await store.match(url);
  if (!res) {
    const net = await fetch(url);
    if (!net.ok) throw new Error(`下載模型失敗 HTTP ${net.status}`);
    await store.put(url, net.clone());
    res = net;
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function getEmbedder(modelKey) {
  if (embedders.has(modelKey)) return embedders.get(modelKey);
  if (!loadingModels.has(modelKey)) {
    loadingModels.set(modelKey, (async () => {
      if (!navigator.gpu) throw new Error("此瀏覽器沒有 WebGPU（chrome://gpu 檢查 WebGPU 狀態）");
      const spec = MODELS[modelKey] ?? MODELS.eg2_270m;
      fileset ??= await FilesetResolver.forRetrievalTasks(chrome.runtime.getURL("wasm"));
      const bytes = await fetchModelBytes(spec.url);
      const e = await UniversalEmbedder.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: bytes, delegate: "GPU" },
        l2Normalize: true,
        maxInputLength: 512,
      });
      embedders.set(modelKey, e);
      return e;
    })().finally(() => loadingModels.delete(modelKey)));
  }
  try { return await loadingModels.get(modelKey); }
  catch (e) { lastError = String(e?.message ?? e); throw e; }
}

// Text index model; switching models invalidates stored text vectors.
async function load(modelKey) {
  await indexReady;
  if (textModel === modelKey && embedders.has(modelKey)) return;
  await getEmbedder(modelKey);
  lastError = null;
  const indexedWith = localStorage.getItem("semhist_model");
  if (indexedWith && indexedWith !== modelKey) {
    await index.clear();
    for (const c of index.cats.values()) c.vec = null;
  }
  localStorage.setItem("semhist_model", modelKey);
  if (textModel && textModel !== modelKey && textModel !== VISION_MODEL) {
    try { embedders.get(textModel)?.close(); } catch {}
    embedders.delete(textModel);
  }
  textModel = modelKey;
  queryCache.clear();
  await ensureCategoryVecs(index, modelKey);
}

// The model rejects inputs longer than its signature ("Failed to compute text embedding").
// Chunks are already token-budgeted; if the estimate was still too optimistic, shrink and retry.
const SAFE_TOKENS = 480;
async function vec(modelKey, text) {
  const emb = await getEmbedder(modelKey);
  let input = String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim() || " ";
  if (estimateTokens(input) > SAFE_TOKENS) input = truncateToTokens(input, SAFE_TOKENS);
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await emb.embedText(input);
      const e = r.embeddings[0];
      return toDim(e.floatEmbedding ?? Array.from(e.quantizedEmbedding ?? []), DIM);
    } catch (err) {
      const m = String(err?.message ?? err);
      if (attempt >= 4 || input.length < 24 || !/embedding|signature|sequence length|INVALID_ARGUMENT/i.test(m)) throw err;
      input = input.slice(0, Math.floor(input.length * 0.6));
      console.warn("[語意回憶] embed retry with shorter input", input.length, m);
    }
  }
}
const embed = text => vec(textModel, text);

async function ensureCategoryVecs(idx, modelKey) {
  const todo = idx.categoriesNeedingVec();
  for (const c of todo) await idx.setCategoryVec(c.id, await vec(modelKey, PROMPT.category(c.name, c.description)));
  if (todo.length) await idx.retagAll();
}

let chain = Promise.resolve();
function serialize(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

function domainOf(url) { try { return new URL(url).hostname; } catch { return ""; } }
const indexOf = url => (imgIndex.pages.has(url) ? imgIndex : index);

async function applySettings(msg) {
  await indexReady;
  if (typeof msg.tagMinScore === "number") {
    await index.setTagOptions({ minScore: msg.tagMinScore });
    await imgIndex.setTagOptions({ minScore: msg.tagMinScore });
  }
}

// ---- text pages & clips ---------------------------------------------------------------
async function indexPage({ url, title, text, model }) {
  const hash = hashText(text);
  if (index.isCurrent(url, hash)) { await index.touch(url); return { ok: true, skipped: "unchanged", tags: index.tagsOf(index.pages.get(url)) }; }
  await load(model);
  const chunks = chunkText(text);
  if (!chunks.length) return { ok: true, skipped: "empty" };
  const vecs = [];
  for (const c of chunks) vecs.push(await embed(PROMPT.doc(title, c)));
  await index.upsert({ url, title, domain: domainOf(url), hash, source: "page" }, chunks, vecs);
  return { ok: true, chunks: chunks.length, tags: index.tagsOf(index.pages.get(url)) };
}

// A clip is one DOM block the user picked. Its id is the text hash, so indexing the
// same block twice updates instead of duplicating.
async function indexClip({ parentUrl, linkUrl, title, text, note, selector, model }) {
  const body = String(text || "").trim();
  if (body.length < 15) return { ok: false, error: "選取的區塊文字太少" };
  await load(model);
  const hash = hashText(body);
  const chunks = chunkText(note ? `${note}\n${body}` : body, { maxChunks: 8 });
  const vecs = [];
  for (const c of chunks) vecs.push(await embed(PROMPT.doc(title, c)));
  const url = `${parentUrl}#semhist-clip-${hash}`;
  await index.upsert({
    url, title, domain: domainOf(parentUrl), hash, source: "clip",
    parentUrl, linkUrl, note: note || "", selector: selector || "",
  }, chunks, vecs);
  return { ok: true, url, hash, chunks: chunks.length, tags: index.tagsOf(index.pages.get(url)) };
}

// ---- images --------------------------------------------------------------------------
async function blobFromDataUrl(dataUrl) { return (await fetch(dataUrl)).blob(); }

// Get image pixels: prefer the original file (full resolution); fall back to a crop of
// the visible-tab screenshot (works for canvas, SVG, CSS backgrounds, cross-origin images).
async function imageBlob({ srcUrl, shot, rect, dpr }) {
  if (srcUrl && /^(https?:|data:)/.test(srcUrl)) {
    try {
      const r = await fetch(srcUrl, { credentials: "include" });
      if (r.ok && /^image\//.test(r.headers.get("content-type") || "image/")) {
        const b = await r.blob();
        if (b.size > 0 && !/svg/.test(b.type)) return { blob: b, from: "original" };
      }
    } catch { /* fall through to screenshot */ }
  }
  if (!shot || !rect) throw new Error("無法取得圖片內容");
  const full = await createImageBitmap(await blobFromDataUrl(shot));
  const s = dpr || 1;
  const sx = Math.max(0, Math.round(rect.left * s)), sy = Math.max(0, Math.round(rect.top * s));
  const sw = Math.min(full.width - sx, Math.round(rect.width * s)), sh = Math.min(full.height - sy, Math.round(rect.height * s));
  if (sw < 8 || sh < 8) throw new Error("圖片不在可見範圍內");
  const c = new OffscreenCanvas(sw, sh);
  c.getContext("2d").drawImage(full, sx, sy, sw, sh, 0, 0, sw, sh);
  return { blob: await c.convertToBlob({ type: "image/png" }), from: "screenshot" };
}

async function normalizeImage(blob, maxSide) {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);   // flatten transparency
  ctx.drawImage(bmp, 0, 0, w, h);
  return { canvas: c, w: bmp.width, h: bmp.height };
}

async function toDataUrl(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:${blob.type};base64,${btoa(bin)}`;
}

async function indexImage({ parentUrl, linkUrl, title, caption, note, srcUrl, shot, rect, dpr, selector, auto }) {
  await indexReady;
  if (auto && srcUrl) {   // automatic pass: don't re-embed an image we already have
    const known = `${parentUrl}#semhist-img-${hashText(srcUrl)}`;
    if (imgIndex.pages.has(known)) return { ok: true, skipped: "exists", url: known };
  }
  const { blob, from } = await imageBlob({ srcUrl, shot, rect, dpr });
  const forModel = await normalizeImage(blob, 768);
  const pngBytes = new Uint8Array(await (await forModel.canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
  const thumbBlob = await (await normalizeImage(blob, 240)).canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
  const thumb = await toDataUrl(thumbBlob);

  const emb = await getEmbedder(VISION_MODEL);
  await ensureCategoryVecs(imgIndex, VISION_MODEL);
  const r = await emb.embedImage(pngBytes);
  const e = r.embeddings[0];
  const v = toDim(e.floatEmbedding ?? Array.from(e.quantizedEmbedding ?? []), DIM);

  const key = srcUrl && !srcUrl.startsWith("data:") ? srcUrl : hashText(thumb);
  const id = hashText(key);
  const url = `${parentUrl}#semhist-img-${id}`;
  const text = [note, caption].filter(Boolean).join("\n") || title;
  await imgIndex.upsert({
    url, title, domain: domainOf(parentUrl), hash: id, source: "image",
    parentUrl, linkUrl: linkUrl || parentUrl, note: note || "", caption: caption || "", selector: selector || "",
    srcUrl: srcUrl || "", thumb, width: forModel.w, height: forModel.h, from,
  }, [text], [v]);
  return { ok: true, url, hash: id, from, tags: imgIndex.tagsOf(imgIndex.pages.get(url)) };
}

// ---- search -----------------------------------------------------------------------------
async function search({ query, k, sinceTs, domain, tag, model }) {
  await indexReady;
  const total = index.pages.size + imgIndex.pages.size;
  if (!total) return { ok: true, results: [], images: [], empty: true };
  const t0 = performance.now();
  const q = String(query || "").trim();
  const opts = { sinceTs, domain, tag };

  if (!q) {
    const results = tag === "__images__" ? [] : index.browse({ ...opts, k: k || 50 });
    const images = imgIndex.pages.size && (tag === "__images__" || (tag && !tag.startsWith("__"))) ? imgIndex.browse({ ...opts, tag: tag === "__images__" ? "" : tag, k: 60 }) : [];
    return { ok: true, results, images, ms: Math.round(performance.now() - t0), browse: true };
  }

  let results = [];
  if (tag !== "__images__" && index.pages.size) {
    await load(model);
    let qv = queryCache.get(q);
    if (!qv) {
      qv = await embed(PROMPT.query(q));
      queryCache.set(q, qv);
      if (queryCache.size > 200) queryCache.delete(queryCache.keys().next().value);
    }
    results = index.search(qv, q, { ...opts, k });
  }

  let images = [];
  if (imgIndex.pages.size && tag !== "__clips__" && tag !== "__none__") {
    const key = "img|" + q;
    let iv = queryCache.get(key);
    if (!iv) { iv = await vec(VISION_MODEL, PROMPT.query(q)); queryCache.set(key, iv); }
    images = imgIndex.search(iv, q, { ...opts, tag: tag === "__images__" ? "" : tag, k: 12 });
  }
  return { ok: true, results, images, ms: Math.round(performance.now() - t0) };
}

// ---- categories (kept in sync across both indexes) ---------------------------------------
async function putCategory({ cat, model }) {
  await load(model);
  const prev = cat.id ? index.cats.get(cat.id) : null;
  const textChanged = !prev || prev.name !== cat.name || (prev.description || "") !== (cat.description || "");
  const v = textChanged ? await vec(textModel, PROMPT.category(cat.name, cat.description)) : null;
  const rec = await index.putCategory(cat, v);
  if (!rec) return { ok: false, error: "分類不存在" };
  if (imgIndex.pages.size || embedders.has(VISION_MODEL)) {
    const iv = textChanged ? await vec(VISION_MODEL, PROMPT.category(rec.name, rec.description)) : null;
    await imgIndex.putCategory({ ...cat, id: rec.id, allowCreateWithId: true }, iv);
  } else {
    // vision model not loaded yet: store definition without vector; embedded when first needed
    await imgIndex.putCategory({ ...cat, id: rec.id, allowCreateWithId: true }, null);
    const ic = imgIndex.cats.get(rec.id);
    if (ic && textChanged) ic.vec = null;
  }
  return { ok: true, id: rec.id, ...listCategories() };
}

function listCategories() {
  const a = index.listCategories(), b = imgIndex.listCategories();
  const imgCount = new Map(b.categories.map(c => [c.id, c.count]));
  return {
    categories: a.categories.map(c => ({ ...c, count: c.count + (imgCount.get(c.id) || 0), images: imgCount.get(c.id) || 0 })),
    uncategorized: a.uncategorized,
  };
}

function pageInfo(url) {
  const p = index.pages.get(url);
  const blocks = [...index.clipsOf(url), ...imgIndex.clipsOf(url)].map(c => ({
    url: c.url, hash: c.hash, selector: c.selector, source: c.source, srcUrl: c.srcUrl || "",
  }));
  return {
    ok: true,
    indexed: !!p && p.source === "page",
    ts: p?.ts, chunks: p?.chunkCount,
    tags: p ? index.tagsOf(p) : [],
    categories: listCategories().categories.map(c => ({ id: c.id, name: c.name, color: c.color })),
    clips: blocks.length,
    blocks,
  };
}

function stats() {
  const a = index.stats(), b = imgIndex.stats();
  return { ...a, images: b.images, mb: +(a.mb + b.mb).toFixed(1) };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return false;
  const run = fn => serialize(async () => { await applySettings(msg); return fn(); });
  let job;
  switch (msg.type) {
    case "INDEX": job = run(() => indexPage(msg)); break;
    case "CLIP": job = run(() => indexClip(msg)); break;
    case "IMAGE": job = run(() => indexImage(msg)); break;
    case "IMPORT_HISTORY": job = run(() => importHistory(msg)); break;
    case "SEARCH": job = run(() => search(msg)); break;
    case "LOAD": job = run(() => load(msg.model).then(() => ({ ok: true }))); break;
    case "DELETE": job = run(async () => { await indexOf(msg.url).delete(msg.url); return { ok: true }; }); break;
    case "DELETE_DOMAIN": job = run(async () => ({ ok: true, removed: (await index.deleteDomain(msg.domain)) + (await imgIndex.deleteDomain(msg.domain)) })); break;
    case "CLEAR": job = run(async () => { await index.clear(); await imgIndex.clear(); return { ok: true }; }); break;
    case "PAGE_INFO": job = run(() => pageInfo(msg.url)); break;
    case "CATEGORIES": job = run(() => ({ ok: true, ...listCategories() })); break;
    case "CAT_PUT": job = run(() => putCategory(msg)); break;
    case "CAT_DELETE": job = run(async () => {
      await index.deleteCategory(msg.id); await imgIndex.deleteCategory(msg.id);
      return { ok: true, ...listCategories() };
    }); break;
    case "TAG_SET": job = run(async () => {
      const idx = indexOf(msg.url);
      await idx.setTag(msg.url, msg.catId, !!msg.on);
      const p = idx.pages.get(msg.url);
      return { ok: true, tags: p ? idx.tagsOf(p) : [] };
    }); break;
    case "SCORE_PAGE": job = run(() => {
      const idx = indexOf(msg.url);
      const p = idx.pages.get(msg.url);
      return { ok: true, scores: p?.vec ? idx.scoreCategories(p.vec).map(x => ({ ...x, name: idx.cats.get(x.id)?.name })) : [] };
    }); break;
    case "STATUS":
      job = indexReady.then(() => ({ ok: true, model: textModel, visionLoaded: embedders.has(VISION_MODEL), loading: loadingModels.size > 0, error: lastError, webgpu: !!navigator.gpu, ...stats() }));
      break;
    case "DOMAINS":
      job = indexReady.then(() => {
        const counts = {};
        for (const idx of [index, imgIndex]) for (const p of idx.pages.values()) counts[p.domain] = (counts[p.domain] || 0) + 1;
        return { ok: true, domains: Object.entries(counts).sort((a, b) => b[1] - a[1]) };
      });
      break;
    default: return false;
  }
  job.then(sendResponse, e => sendResponse({ ok: false, error: String(e?.message ?? e) }));
  return true;
});

async function importHistory({ items, model }) {
  await load(model);
  let added = 0;
  for (const it of items) {
    if (index.pages.has(it.url)) continue;
    const u = new URL(it.url);
    const text = `${it.title}\n${u.hostname}${decodeURIComponent(u.pathname).replace(/[-_/]+/g, " ")}`;
    const v = await embed(PROMPT.doc(it.title, text));
    if (await index.upsert({ url: it.url, title: it.title, domain: u.hostname, hash: "", source: "history", ts: it.lastVisitTime }, [text], [v])) added++;
  }
  return { ok: true, added };
}

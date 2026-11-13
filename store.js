// Persistent vector index + categories.
// IndexedDB for durability; flat Float32Array in memory for brute-force cosine search.
//
// Categories (分類) are tagged automatically by comparing each page's vector with a
// per-category *prototype*: the category description's embedding plus the vectors of
// every page the user tagged by hand. Manual tags therefore teach the auto-tagger.

const DB_VERSION = 2;
const DESC_WEIGHT = 2; // the description counts as this many example pages in a prototype

export const TAG_DEFAULTS = { minScore: 0.2, margin: 0.04, maxTags: 3, minLift: 0.03 };

function req(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
function done(tx) {
  return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = tx.onabort = () => rej(tx.error); });
}

export function normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

export function dot(a, b, n = a.length) {
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export function meanVec(vecs, dim) {
  const m = new Float32Array(dim);
  for (const v of vecs) for (let i = 0; i < dim; i++) m[i] += v[i];
  return normalize(m);
}

/**
 * Multi-label rule. scores: [{id, s}].
 * - nothing if the best score is too low, or barely above the average (page fits no category)
 * - otherwise every category within `margin` of the best (and above minScore), up to maxTags
 */
export function pickTags(scores, opts = TAG_DEFAULTS) {
  const o = { ...TAG_DEFAULTS, ...opts };
  if (!scores.length) return [];
  const sorted = [...scores].sort((a, b) => b.s - a.s);
  const top = sorted[0].s;
  const mean = sorted.reduce((a, x) => a + x.s, 0) / sorted.length;
  if (top < o.minScore) return [];
  if (sorted.length > 1 && top - mean < o.minLift) return [];
  const floor = Math.max(o.minScore, top - o.margin);
  return sorted.filter(x => x.s >= floor).slice(0, o.maxTags);
}

export class VectorIndex {
  constructor(dim, idb = globalThis.indexedDB, dbName = "semhist") {
    this.dim = dim;
    this.dbName = dbName;
    this.idb = idb;
    this.db = null;
    this.pages = new Map();     // url -> page record (see upsert)
    this.cats = new Map();      // id -> {id,name,description,color,vec?,builtin,order}
    this.rows = [];             // per chunk: {id,url,idx,text}
    this.mat = new Float32Array(0);
    this.tagOpts = { ...TAG_DEFAULTS };
    this._protos = null;
  }

  async open(presets = []) {
    const open = this.idb.open(this.dbName, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("pages")) db.createObjectStore("pages", { keyPath: "url" });
      if (!db.objectStoreNames.contains("chunks")) {
        const s = db.createObjectStore("chunks", { keyPath: "id", autoIncrement: true });
        s.createIndex("url", "url");
      }
      if (!db.objectStoreNames.contains("categories")) db.createObjectStore("categories", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    this.db = await req(open);

    const tx = this.db.transaction(["pages", "chunks", "categories", "meta"], "readonly");
    for (const p of await req(tx.objectStore("pages").getAll())) this.pages.set(p.url, p);
    for (const c of await req(tx.objectStore("categories").getAll())) this.cats.set(c.id, c);
    const seeded = await req(tx.objectStore("meta").get("seeded"));
    const chunks = await req(tx.objectStore("chunks").getAll());
    this.rows = [];
    this.mat = new Float32Array(chunks.length * this.dim);
    chunks.forEach((c, i) => {
      this.rows.push({ id: c.id, url: c.url, idx: c.idx, text: c.text });
      this.mat.set(c.vec.subarray(0, this.dim), i * this.dim);
    });

    if (!seeded && presets.length) {
      const wtx = this.db.transaction(["categories", "meta"], "readwrite");
      presets.forEach((p, i) => {
        const cat = { ...p, builtin: true, order: i };
        wtx.objectStore("categories").put(cat);
        this.cats.set(cat.id, cat);
      });
      wtx.objectStore("meta").put({ key: "seeded", value: true });
      await done(wtx);
    }

    // Migration from v1: pages had no page-level vector.
    const missing = [...this.pages.values()].filter(p => !p.vec);
    if (missing.length) {
      for (const p of missing) p.vec = this._pageVecFromRows(p.url);
      await this._savePages(missing.filter(p => p.vec));
    }
    return this;
  }

  // ---------------------------------------------------------------------------
  // Pages
  // ---------------------------------------------------------------------------
  _pageVecFromRows(url) {
    const vecs = [];
    this.rows.forEach((r, i) => { if (r.url === url) vecs.push(this.mat.subarray(i * this.dim, (i + 1) * this.dim)); });
    return vecs.length ? meanVec(vecs, this.dim) : null;
  }

  async _savePages(pages) {
    if (!pages.length) return;
    const tx = this.db.transaction("pages", "readwrite");
    for (const p of pages) tx.objectStore("pages").put(p);
    await done(tx);
  }

  isCurrent(url, hash) {
    const p = this.pages.get(url);
    return !!p && p.source === "page" && p.hash === hash;
  }

  async touch(url) {
    const p = this.pages.get(url);
    if (!p) return;
    p.ts = Date.now();
    p.visits = (p.visits || 1) + 1;
    await this._savePages([p]);
  }

  // page: {url,title,domain,hash,source,ts?}; chunks: string[]; vecs: Float32Array[] (normalised, length >= dim)
  async upsert(page, chunks, vecs) {
    const prev = this.pages.get(page.url);
    if (prev && prev.source !== "history" && page.source === "history") return false;

    await this._deleteChunks(page.url);
    const now = Date.now();
    const rec = {
      ...page,
      ts: page.ts ?? now,
      firstTs: prev?.firstTs ?? page.ts ?? now,
      visits: (prev?.visits || 0) + 1,
      chunkCount: chunks.length,
      vec: meanVec(vecs.map(v => v.subarray(0, this.dim)), this.dim),
      tagsManual: prev?.tagsManual || [],
      tagsRemoved: prev?.tagsRemoved || [],
      tagsAuto: [],
    };
    // A manually tagged page's vector feeds prototypes; if it changed, prototypes change too.
    if (rec.tagsManual.length) this._protos = null;
    this._autoTag(rec);

    const tx = this.db.transaction(["pages", "chunks"], "readwrite");
    tx.objectStore("pages").put(rec);
    const store = tx.objectStore("chunks");
    const newIds = await Promise.all(chunks.map((text, idx) => req(store.add({ url: page.url, idx, text, vec: vecs[idx] }))));
    await done(tx);

    this.pages.set(page.url, rec);
    const base = this.rows.length;
    const grown = new Float32Array((base + chunks.length) * this.dim);
    grown.set(this.mat);
    chunks.forEach((text, idx) => {
      this.rows.push({ id: newIds[idx], url: page.url, idx, text });
      grown.set(vecs[idx].subarray(0, this.dim), (base + idx) * this.dim);
    });
    this.mat = grown;
    return true;
  }

  async _deleteChunks(url) {
    if (!this.rows.some(r => r.url === url)) return;
    const tx = this.db.transaction("chunks", "readwrite");
    const keys = await req(tx.objectStore("chunks").index("url").getAllKeys(url));
    for (const k of keys) tx.objectStore("chunks").delete(k);
    await done(tx);
    this._compact(r => r.url !== url);
  }

  _compact(keep) {
    const rows = [], parts = [];
    this.rows.forEach((r, i) => { if (keep(r)) { rows.push(r); parts.push(i); } });
    const mat = new Float32Array(rows.length * this.dim);
    parts.forEach((src, dst) => mat.set(this.mat.subarray(src * this.dim, (src + 1) * this.dim), dst * this.dim));
    this.rows = rows;
    this.mat = mat;
  }

  async delete(url) {
    const p = this.pages.get(url);
    await this._deleteChunks(url);
    const tx = this.db.transaction("pages", "readwrite");
    tx.objectStore("pages").delete(url);
    await done(tx);
    this.pages.delete(url);
    if (p?.tagsManual?.length) await this.retagAll();
  }

  async deleteDomain(domain) {
    const urls = [...this.pages.values()].filter(p => p.domain === domain).map(p => p.url);
    for (const u of urls) await this.delete(u);
    return urls.length;
  }

  async clear() {
    const tx = this.db.transaction(["pages", "chunks"], "readwrite");
    tx.objectStore("pages").clear();
    tx.objectStore("chunks").clear();
    await done(tx);
    this.pages.clear();
    this.rows = [];
    this.mat = new Float32Array(0);
    this._protos = null;
  }

  stats() {
    let page = 0, history = 0, clips = 0, images = 0;
    for (const p of this.pages.values()) {
      if (p.source === "history") history++; else if (p.source === "clip") clips++; else if (p.source === "image") images++; else page++;
    }
    return { pages: page, historyTitles: history, clips, images, chunks: this.rows.length, mb: +(this.mat.byteLength / 1048576).toFixed(1) };
  }

  clipsOf(parentUrl) {
    return [...this.pages.values()].filter(p => (p.source === "clip" || p.source === "image") && p.parentUrl === parentUrl);
  }

  // ---------------------------------------------------------------------------
  // Categories & tagging
  // ---------------------------------------------------------------------------
  categoriesNeedingVec() {
    return [...this.cats.values()].filter(c => !c.vec);
  }

  _prototypes() {
    if (this._protos) return this._protos;
    const protos = new Map();
    for (const c of this.cats.values()) {
      if (!c.vec) continue;
      const acc = new Float32Array(this.dim);
      for (let i = 0; i < this.dim; i++) acc[i] = c.vec[i] * DESC_WEIGHT;
      let examples = 0;
      for (const p of this.pages.values()) {
        if (p.vec && p.tagsManual?.includes(c.id)) {
          for (let i = 0; i < this.dim; i++) acc[i] += p.vec[i];
          examples++;
        }
      }
      protos.set(c.id, { vec: normalize(acc), examples });
    }
    this._protos = protos;
    return protos;
  }

  scoreCategories(vec) {
    const out = [];
    for (const [id, p] of this._prototypes()) out.push({ id, s: dot(vec, p.vec, this.dim) });
    return out.sort((a, b) => b.s - a.s);
  }

  _autoTag(page) {
    if (!page.vec) { page.tagsAuto = []; return false; }
    const before = JSON.stringify(page.tagsAuto || []);
    const removed = new Set(page.tagsRemoved || []);
    const manual = new Set(page.tagsManual || []);
    // Manual and removed categories are decided by the user; auto only fills the rest.
    const scores = this.scoreCategories(page.vec);
    page.tagsAuto = pickTags(scores, this.tagOpts)
      .filter(x => !removed.has(x.id) && !manual.has(x.id))
      .map(x => ({ id: x.id, s: +x.s.toFixed(3) }));
    return JSON.stringify(page.tagsAuto) !== before;
  }

  async retagAll() {
    this._protos = null;
    const changed = [];
    for (const p of this.pages.values()) if (this._autoTag(p)) changed.push(p);
    await this._savePages(changed);
    return changed.length;
  }

  async setTagOptions(opts) {
    const next = { ...this.tagOpts, ...opts };
    if (JSON.stringify(next) === JSON.stringify(this.tagOpts)) return 0;
    this.tagOpts = next;
    return this.retagAll();
  }

  // Effective tags for display: manual first, then auto. [{id,name,color,auto,s}]
  tagsOf(page) {
    const out = [];
    for (const id of page.tagsManual || []) {
      const c = this.cats.get(id);
      if (c) out.push({ id, name: c.name, color: c.color, auto: false });
    }
    for (const t of page.tagsAuto || []) {
      const c = this.cats.get(t.id);
      if (c && !out.some(x => x.id === t.id)) out.push({ id: t.id, name: c.name, color: c.color, auto: true, s: t.s });
    }
    return out;
  }

  hasTag(page, id) {
    if (id === "__none__") return !(page.tagsManual?.length || page.tagsAuto?.length);
    if (id === "__clips__") return page.source === "clip";
    if (id === "__images__") return page.source === "image";
    return !!(page.tagsManual?.includes(id) || page.tagsAuto?.some(t => t.id === id));
  }

  async setTag(url, catId, on) {
    const p = this.pages.get(url);
    if (!p || !this.cats.has(catId)) return false;
    const manual = new Set(p.tagsManual || []);
    const removed = new Set(p.tagsRemoved || []);
    if (on) { manual.add(catId); removed.delete(catId); }
    else { manual.delete(catId); removed.add(catId); }
    p.tagsManual = [...manual];
    p.tagsRemoved = [...removed];
    await this._savePages([p]);
    await this.retagAll(); // prototypes learned from this correction
    return true;
  }

  // cat: {id?, name, description, color}; vec: Float32Array | null (null keeps the old one)
  async putCategory(cat, vec) {
    const prev = cat.id ? this.cats.get(cat.id) : null;
    const id = cat.id || "c_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (cat.id && !prev && !cat.allowCreateWithId) return null;
    const rec = {
      id,
      name: String(cat.name || "").trim() || "未命名",
      description: String(cat.description ?? prev?.description ?? "").trim(),
      color: cat.color || prev?.color || "#2f5bd3",
      builtin: prev?.builtin || false,
      order: prev?.order ?? this.cats.size,
      vec: vec ? Float32Array.from(vec.subarray(0, this.dim)) : prev?.vec || null,
    };
    const tx = this.db.transaction("categories", "readwrite");
    tx.objectStore("categories").put(rec);
    await done(tx);
    this.cats.set(id, rec);
    await this.retagAll();
    return rec;
  }

  async setCategoryVec(id, vec) {
    const c = this.cats.get(id);
    if (!c) return;
    c.vec = Float32Array.from(vec.subarray(0, this.dim));
    const tx = this.db.transaction("categories", "readwrite");
    tx.objectStore("categories").put(c);
    await done(tx);
    this._protos = null;
  }

  async deleteCategory(id) {
    if (!this.cats.has(id)) return false;
    const tx = this.db.transaction("categories", "readwrite");
    tx.objectStore("categories").delete(id);
    await done(tx);
    this.cats.delete(id);
    const touched = [];
    for (const p of this.pages.values()) {
      if (p.tagsManual?.includes(id) || p.tagsRemoved?.includes(id)) {
        p.tagsManual = (p.tagsManual || []).filter(x => x !== id);
        p.tagsRemoved = (p.tagsRemoved || []).filter(x => x !== id);
        touched.push(p);
      }
    }
    await this._savePages(touched);
    await this.retagAll();
    return true;
  }

  listCategories() {
    const counts = new Map();
    let none = 0;
    for (const p of this.pages.values()) {
      const tags = this.tagsOf(p);
      if (!tags.length) none++;
      for (const t of tags) counts.set(t.id, (counts.get(t.id) || 0) + 1);
    }
    const protos = this._prototypes();
    const cats = [...this.cats.values()]
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map(c => ({
        id: c.id, name: c.name, description: c.description, color: c.color, builtin: c.builtin,
        count: counts.get(c.id) || 0, ready: !!c.vec, examples: protos.get(c.id)?.examples || 0,
      }));
    return { categories: cats, uncategorized: none };
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------
  _pass(page, { sinceTs = 0, domain = "", tag = "" }) {
    if (sinceTs && page.ts < sinceTs) return false;
    if (domain && page.domain !== domain) return false;
    if (tag && !this.hasTag(page, tag)) return false;
    return true;
  }

  _result(page, row, extra = {}) {
    return {
      url: page.url, linkUrl: page.linkUrl || page.url, parentUrl: page.parentUrl || null, note: page.note || "",
      thumb: page.thumb || null,
      title: page.title, domain: page.domain, ts: page.ts, visits: page.visits, source: page.source,
      snippet: row?.text || "", tags: this.tagsOf(page), ...extra,
    };
  }

  /**
   * Hybrid search: chunk cosine max-pooled per page + keyword boost (exact terms such as
   * error codes) + small recency boost. opts: {k, sinceTs, domain, tag}
   */
  search(qvec, query, opts = {}) {
    const { k = 20 } = opts;
    const dim = this.dim, n = this.rows.length;
    const terms = queryTerms(query);
    const best = new Map();
    const passCache = new Map();
    for (let i = 0; i < n; i++) {
      const row = this.rows[i];
      let pass = passCache.get(row.url);
      if (pass === undefined) {
        const page = this.pages.get(row.url);
        pass = !!page && this._pass(page, opts);
        passCache.set(row.url, pass);
      }
      if (!pass) continue;
      let d = 0;
      const off = i * dim;
      for (let j = 0; j < dim; j++) d += this.mat[off + j] * qvec[j];
      const cur = best.get(row.url);
      if (!cur || d > cur.sem) best.set(row.url, { sem: d, row });
    }

    const now = Date.now();
    const out = [];
    for (const [url, { sem, row }] of best) {
      const page = this.pages.get(url);
      const hay = (page.title + "\n" + url).toLowerCase();
      const body = row.text.toLowerCase();
      let kw = 0;
      for (const { t, w } of terms) {
        if (hay.includes(t)) kw += 0.08 * w;
        else if (body.includes(t)) kw += 0.05 * w;
      }
      kw = Math.min(kw, 0.24);
      const recency = 0.03 * Math.exp(-(now - page.ts) / 86400000 / 30);
      const historyPenalty = page.source === "history" ? -0.04 : 0;
      out.push(this._result(page, row, { score: sem + kw + recency + historyPenalty, sem, kw }));
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, k);
  }

  // No query: list pages (e.g. everything in a category), newest first.
  browse(opts = {}) {
    const { k = 50 } = opts;
    const firstRow = new Map();
    for (const r of this.rows) if (!firstRow.has(r.url) || r.idx < firstRow.get(r.url).idx) firstRow.set(r.url, r);
    return [...this.pages.values()]
      .filter(p => this._pass(p, opts))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, k)
      .map(p => this._result(p, firstRow.get(p.url), { score: null }));
  }
}

export function queryTerms(q) {
  const s = String(q).toLowerCase().trim();
  const terms = new Map(); // term -> weight (full words 1, CJK 2-char shingles 0.4)
  for (const w of s.split(/[\s,，。、;；:：/|()（）"'「」]+/)) {
    if (!w || w.length < 2) continue;
    terms.set(w, 1);
    if (!/^[\x00-\x7f]+$/.test(w) && w.length > 3) {
      for (let i = 0; i < w.length - 1; i++) {
        const sh = w.slice(i, i + 2);
        if (!terms.has(sh)) terms.set(sh, 0.4);
      }
    }
  }
  return [...terms].slice(0, 24).map(([t, w]) => ({ t, w }));
}

// Truncate (Matryoshka) and L2-normalise.
export function toDim(vec, dim) {
  return normalize(Float32Array.from(vec.slice(0, dim)));
}

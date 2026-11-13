import { MODELS, getSettings, DEFAULTS } from "./shared.js";
import { queryTerms } from "./store.js";

const $ = id => document.getElementById(id);
const send = msg => chrome.runtime.sendMessage(msg).catch(e => ({ ok: false, error: String(e?.message ?? e) }));
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let timer = null;
let seq = 0;
let tagFilter = new URL(location.href).searchParams.get("tag") || "";
let cats = [];            // [{id,name,color,description,count,examples,ready}]
let uncategorized = 0;
let clipCount = 0;
let imageCount = 0;
let last = null;          // last SEARCH response; thresholds filter it without re-querying
let lastQuery = "";
let minSim = 0, imgMinSim = 0;
let saveSimTimer = null;

function highlight(text, query) {
  let html = esc(text);
  if (!query) return html;
  const terms = queryTerms(query).filter(t => t.w === 1).map(t => t.t).sort((a, b) => b.length - a.length);
  for (const t of terms) {
    const re = new RegExp(esc(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    html = html.replace(re, m => `<mark>${m}</mark>`);
  }
  return html;
}

function ago(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 3600) return Math.max(1, Math.round(d / 60)) + " 分鐘前";
  if (d < 86400) return Math.round(d / 3600) + " 小時前";
  if (d < 86400 * 30) return Math.round(d / 86400) + " 天前";
  return new Date(ts).toLocaleDateString("zh-TW");
}

// ---- category chips -------------------------------------------------------------
async function loadCategories() {
  const r = await send({ type: "CATEGORIES" });
  if (!r?.ok) return;
  cats = r.categories;
  uncategorized = r.uncategorized;
  const st = await send({ type: "STATUS" });
  clipCount = st?.clips || 0;
  imageCount = st?.images || 0;
  renderChips();
  renderCatManager();
}

function renderChips() {
  const chip = (id, label, n, color) =>
    `<span class="chip ${tagFilter === id ? "on" : ""}" data-tag="${esc(id)}">` +
    (color ? `<span class="dot" style="background:${esc(color)}"></span>` : "") +
    `${esc(label)}${n != null ? ` <span class="n">${n}</span>` : ""}</span>`;
  $("chips").innerHTML =
    chip("", "全部", null) +
    cats.map(c => chip(c.id, c.name, c.count, c.color)).join("") +
    chip("__none__", "未分類", uncategorized) +
    chip("__clips__", "📌 片段", clipCount) +
    chip("__images__", "🖼 圖片", imageCount) +
    `<span class="chip add" data-add="1">＋ 新增分類</span>`;
}

$("chips").addEventListener("click", e => {
  const el = e.target.closest(".chip");
  if (!el) return;
  if (el.dataset.add) {
    $("catPanel").open = true;
    $("catPanel").scrollIntoView({ behavior: "smooth" });
    $("catNew").elements.name.focus();
    return;
  }
  tagFilter = tagFilter === el.dataset.tag ? "" : el.dataset.tag;
  renderChips();
  run();
});

// ---- search / browse ---------------------------------------------------------------
async function run() {
  const query = $("q").value.trim();
  const url = new URL(location.href);
  query ? url.searchParams.set("q", query) : url.searchParams.delete("q");
  tagFilter ? url.searchParams.set("tag", tagFilter) : url.searchParams.delete("tag");
  history.replaceState(null, "", url);
  if (!query && !tagFilter) { last = null; $("results").innerHTML = ""; $("images").innerHTML = ""; $("imgSection").hidden = true; $("simbar").hidden = true; $("meta").textContent = ""; return; }

  const my = ++seq;
  $("meta").textContent = query ? "搜尋中…（第一次會載入模型）" : "讀取中…";
  const days = +$("since").value;
  const r = await send({
    type: "SEARCH", query, k: query ? 60 : 100, tag: tagFilter,
    sinceTs: days ? Date.now() - days * 86400000 : 0,
    domain: $("domain").value,
  });
  if (my !== seq) return;
  if (!r?.ok) { $("meta").textContent = "錯誤：" + r?.error; return; }
  $("empty").hidden = !r.empty;
  if (r.empty) { $("results").innerHTML = ""; $("images").innerHTML = ""; $("imgSection").hidden = true; $("meta").textContent = ""; $("simbar").hidden = true; return; }
  last = r; lastQuery = query;
  renderResults();
}

const range = xs => xs.length ? `${Math.min(...xs).toFixed(2)}–${Math.max(...xs).toFixed(2)}` : "";

// Apply the similarity thresholds to the cached response (browse mode has no scores).
function renderResults() {
  const r = last;
  if (!r) return;
  const query = lastQuery;
  const label = { __none__: "未分類", __clips__: "片段", __images__: "圖片" }[tagFilter] || cats.find(c => c.id === tagFilter)?.name;
  const allText = r.results, allImgs = r.images || [];
  const scored = !r.browse;
  const text = scored ? allText.filter(x => x.sem >= minSim) : allText;
  const imgs = scored ? allImgs.filter(x => x.sem >= imgMinSim) : allImgs;

  $("simbar").hidden = !scored || !allText.length;
  $("simInfo").textContent = scored && allText.length ? `本次相似度範圍 ${range(allText.map(x => x.sem))}` : "";
  $("imgSimInfo").textContent = scored && allImgs.length ? `範圍 ${range(allImgs.map(x => x.sem))}` : "";
  document.querySelector(".imgsim").style.display = scored ? "" : "none";

  const n = text.length + imgs.length;
  $("meta").textContent = (r.browse
    ? `「${label}」最近 ${n} 筆`
    : `${text.length} 筆結果${imgs.length ? ` ＋ ${imgs.length} 張圖片` : ""}${label ? `（${label}）` : ""}`) + ` · ${r.ms} ms`;
  $("imgSection").hidden = !allImgs.length;
  $("images").innerHTML = imgs.map(renderImage).join("") ||
    `<div class="hiddenNote">${allImgs.length} 張圖片都低於門檻 <button data-reset="img">顯示全部</button></div>`;
  const hiddenText = allText.length - text.length;
  $("results").innerHTML = text.map(x => renderResult(x, query)).join("") +
    (hiddenText ? `<li class="hiddenNote">另有 ${hiddenText} 筆相似度低於 ${minSim.toFixed(2)} 已隱藏 <button data-reset="text">顯示全部</button></li>` : "");
}

function setThreshold(kind, v, save = true) {
  v = Math.max(0, Math.min(0.9, +v || 0));
  if (kind === "text") { minSim = v; $("minSim").value = v; $("minSimVal").textContent = v.toFixed(2); }
  else { imgMinSim = v; $("imgMinSim").value = v; $("imgMinSimVal").textContent = v.toFixed(2); }
  renderResults();
  if (!save) return;
  clearTimeout(saveSimTimer);
  saveSimTimer = setTimeout(async () => {
    const { settings: cur = {} } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...(await getSettings()), ...cur, searchMinSim: minSim, imageMinSim: imgMinSim } });
  }, 400);
}

$("minSim").addEventListener("input", e => setThreshold("text", e.target.value));
$("imgMinSim").addEventListener("input", e => setThreshold("img", e.target.value));
document.addEventListener("click", e => {
  const b = e.target.closest("button[data-reset]");
  if (b) setThreshold(b.dataset.reset === "img" ? "img" : "text", 0);
});

function renderTags(x) {
  const has = new Set(x.tags.map(t => t.id));
  const chips = x.tags.map(t => `
    <span class="tag ${t.auto ? "auto" : ""}" style="background:${esc(t.color)};${t.auto ? `color:${esc(t.color)}` : ""}"
          title="${t.auto ? `自動分類（相似度 ${t.s}）· 點 × 移除後，之後不會再自動加回` : "手動分類"}">
      ${esc(t.name)}<button data-untag="${esc(t.id)}" title="移除這個分類">×</button>
    </span>`).join("");
  const options = cats.filter(c => !has.has(c.id)).map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
  return `<div class="tags" data-url="${esc(x.url)}">${chips}
    ${options ? `<select data-addtag><option value="">＋ 分類</option>${options}</select>` : ""}</div>`;
}

function renderImage(x) {
  const cap = x.note || x.snippet || x.title;
  return `
    <div class="imgcard result" data-url="${esc(x.url)}">
      <a class="thumb" href="${esc(x.linkUrl)}" target="_blank" rel="noopener" title="開啟來源頁面"><img src="${esc(x.thumb || "")}" alt="${esc(cap)}" loading="lazy"></a>
      <div class="cap">${esc(cap)}</div>
      <div class="src">${esc(x.domain)} · ${ago(x.ts)}</div>
      ${renderTags(x)}
      <div class="foot">${x.score != null ? `<span>相似度 ${x.sem.toFixed(2)}</span>` : "<span></span>"}<button data-del="1">移除</button></div>
    </div>`;
}

function renderResult(x, query) {
  const isClip = x.source === "clip";
  const snippet = x.source === "history" ? "（只有標題，尚未完整閱讀索引）" : x.snippet;
  return `
    <li class="result" data-url="${esc(x.url)}">
      <a class="title" href="${esc(x.linkUrl)}" target="_blank" rel="noopener">${isClip ? "📌 " : ""}${highlight(x.title || x.url, query)}</a>
      <div class="url">${esc(x.parentUrl || x.url)}</div>
      ${isClip && x.note ? `<div class="snippet"><b>備註：</b>${highlight(x.note, query)}</div>` : ""}
      <div class="snippet">${highlight(snippet, query)}</div>
      ${renderTags(x)}
      <div class="scores" hidden></div>
      <div class="foot">
        <span>${ago(x.ts)}</span>
        ${x.visits > 1 && !isClip ? `<span>造訪 ${x.visits} 次</span>` : ""}
        ${x.source === "history" ? `<span class="badge">紀錄標題</span>` : ""}
        ${isClip ? `<span class="badge">片段</span>` : ""}
        ${x.score != null ? `<span class="simbadge" title="排序分數 ${x.score.toFixed(3)} = 語意 ${x.sem.toFixed(3)} + 關鍵字 ${x.kw.toFixed(2)} + 近期">相似度 ${x.sem.toFixed(2)}</span>` : ""}
        <button data-scores="1">分類分數</button>
        <button class="del" data-del="1">從索引移除</button>
        ${isClip ? "" : `<button class="del" data-deldomain="${esc(x.domain)}">移除整個 ${esc(x.domain)}</button>`}
      </div>
    </li>`;
}

async function onResultClick(e) {
  const li = e.target.closest(".result");
  if (!li) return;
  const url = li.dataset.url;
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.untag) {
    const r = await send({ type: "TAG_SET", url, catId: b.dataset.untag, on: false });
    if (r?.ok) { await loadCategories(); run(); }
  } else if (b.dataset.del) {
    await send({ type: "DELETE", url });
    li.remove();
    loadCategories();
  } else if (b.dataset.deldomain && confirm(`從索引移除所有 ${b.dataset.deldomain} 的頁面？`)) {
    await send({ type: "DELETE_DOMAIN", domain: b.dataset.deldomain });
    run(); refreshStats(); loadCategories();
  } else if (b.dataset.scores) {
    const box = li.querySelector(".scores");
    if (!box.hidden) { box.hidden = true; return; }
    const r = await send({ type: "SCORE_PAGE", url });
    box.textContent = r?.ok ? "與各分類的相似度：" + r.scores.map(s => `${s.name} ${s.s.toFixed(3)}`).join(" · ") : "無法計算";
    box.hidden = false;
  }
}

async function onResultChange(e) {
  const sel = e.target.closest("select[data-addtag]");
  if (!sel || !sel.value) return;
  const url = sel.closest(".tags").dataset.url;
  const r = await send({ type: "TAG_SET", url, catId: sel.value, on: true });
  if (r?.ok) { await loadCategories(); run(); }
}

for (const id of ["results", "images"]) {
  $(id).addEventListener("click", onResultClick);
  $(id).addEventListener("change", onResultChange);
}

$("q").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 300); });
$("q").addEventListener("keydown", e => { if (e.key === "Enter") { clearTimeout(timer); run(); } });
$("since").onchange = run;
$("domain").onchange = run;

// ---- category manager ------------------------------------------------------------
function renderCatManager() {
  $("catList").innerHTML = cats.map(c => `
    <form class="catrow" data-id="${esc(c.id)}">
      <input type="color" name="color" value="${esc(c.color)}" title="顏色">
      <input name="name" value="${esc(c.name)}" required maxlength="24">
      <input name="description" value="${esc(c.description)}" placeholder="描述（越具體越準）" maxlength="200">
      <span class="info" title="手動標記的頁面會當成這個分類的範例">${c.count} 頁 · 範例 ${c.examples}${c.ready ? "" : " · 待載入模型"}</span>
      <span class="row"><button class="small" type="submit">儲存</button><button class="small danger" type="button" data-delcat="1">刪除</button></span>
    </form>`).join("") || `<p class="muted">還沒有分類。</p>`;
}

$("catList").addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target;
  $("catMsg").textContent = "儲存中…（重新計算所有頁面的分類）";
  const r = await send({ type: "CAT_PUT", cat: { id: f.dataset.id, name: f.elements.name.value, description: f.elements.description.value, color: f.elements.color.value } });
  $("catMsg").textContent = r?.ok ? "已儲存" : "錯誤：" + r?.error;
  await loadCategories(); run();
});

$("catList").addEventListener("click", async e => {
  if (!e.target.dataset.delcat) return;
  const f = e.target.closest("form");
  if (!confirm(`刪除分類「${f.elements.name.value}」？（頁面不會被刪除）`)) return;
  await send({ type: "CAT_DELETE", id: f.dataset.id });
  if (tagFilter === f.dataset.id) tagFilter = "";
  await loadCategories(); run();
});

$("catNew").addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target;
  $("catMsg").textContent = "新增中…（第一次會載入模型）";
  const r = await send({ type: "CAT_PUT", cat: { name: f.elements.name.value, description: f.elements.description.value, color: f.elements.color.value } });
  $("catMsg").textContent = r?.ok ? `已新增，並重新分類現有頁面` : "錯誤：" + r?.error;
  if (r?.ok) f.reset();
  await loadCategories(); run();
});

// ---- import / settings ---------------------------------------------------------------
document.querySelectorAll(".import").forEach(btn => btn.addEventListener("click", async () => {
  document.querySelectorAll(".import").forEach(b => b.disabled = true);
  $("settingsMsg").textContent = $("meta").textContent = "匯入中…（每筆約數十毫秒，第一次會先下載模型）";
  const r = await send({ type: "IMPORT_HISTORY", days: +btn.dataset.days });
  const msg = r?.ok ? `已匯入 ${r.added} 筆紀錄標題` : "錯誤：" + r?.error;
  $("settingsMsg").textContent = $("meta").textContent = msg;
  document.querySelectorAll(".import").forEach(b => b.disabled = false);
  $("empty").hidden = true;
  refreshStats(); refreshDomains(); loadCategories();
  if ($("q").value.trim() || tagFilter) run();
}));

async function initSettings() {
  const s = await getSettings();
  for (const [k, m] of Object.entries(MODELS)) $("model").add(new Option(m.label, k));
  $("enabled").checked = s.enabled;
  $("minDwellSec").value = s.minDwellSec;
  $("denylist").value = s.denylist;
  $("model").value = s.model;
  $("showBadge").checked = s.showBadge;
  $("blockMode").value = s.blockMode || "manual";
  $("autoImages").checked = !!s.autoImages;
  setThreshold("text", s.searchMinSim || 0, false);
  setThreshold("img", s.imageMinSim || 0, false);
  $("badgeHiddenDomains").value = (s.badgeHiddenDomains || []).join(", ");
  $("tagMinScore").value = s.tagMinScore;
  $("tagMinScoreVal").textContent = (+s.tagMinScore).toFixed(2);
  $("tagMinScore").oninput = () => { $("tagMinScoreVal").textContent = (+$("tagMinScore").value).toFixed(2); };
  $("saveBtn").onclick = async () => {
    const next = {
      enabled: $("enabled").checked,
      minDwellSec: Math.max(3, +$("minDwellSec").value || DEFAULTS.minDwellSec),
      denylist: $("denylist").value,
      model: $("model").value,
      showBadge: $("showBadge").checked,
      blockMode: $("blockMode").value,
      autoImages: $("autoImages").checked,
      searchMinSim: minSim,
      imageMinSim: imgMinSim,
      badgeHiddenDomains: $("badgeHiddenDomains").value.split(/[,，\s]+/).map(x => x.trim()).filter(Boolean),
      tagMinScore: +$("tagMinScore").value,
    };
    if (next.model !== s.model && !confirm("換模型會清空現有索引（不同模型的向量不相容），確定嗎？")) return;
    await chrome.storage.local.set({ settings: next });
    Object.assign(s, next);
    $("settingsMsg").textContent = "已儲存";
    await loadCategories(); // new threshold → retag happens on the next message
    run();
  };
  $("clearBtn").onclick = async () => {
    if (!confirm("確定清空整個索引？（分類設定會保留）")) return;
    await send({ type: "CLEAR" });
    $("settingsMsg").textContent = "已清空";
    refreshStats(); refreshDomains(); loadCategories(); run();
  };
}

async function refreshStats() {
  const s = await send({ type: "STATUS" });
  if (!s?.ok) { $("stats").textContent = "狀態未知"; return; }
  $("stats").textContent =
    `已索引 ${s.pages} 頁 · ${s.clips} 個片段 · ${s.images} 張圖片（${s.chunks} 段，${s.mb} MB）＋ ${s.historyTitles} 筆紀錄標題 · 模型 ${s.model ? "已載入" : "未載入"}` +
    (s.error ? ` · 錯誤：${s.error}` : "") + (s.webgpu === false ? " · ⚠ 沒有 WebGPU" : "");
  if (!s.pages && !s.historyTitles && !s.clips && !s.images) $("empty").hidden = false;
}

async function refreshDomains() {
  const r = await send({ type: "DOMAINS" });
  if (!r?.ok) return;
  const cur = $("domain").value;
  $("domain").innerHTML = `<option value="">所有網站</option>` +
    r.domains.slice(0, 60).map(([d, n]) => `<option value="${esc(d)}">${esc(d)} (${n})</option>`).join("");
  $("domain").value = cur;
}

const q0 = new URL(location.href).searchParams.get("q");
if (q0) $("q").value = q0;
initSettings();
refreshStats();
refreshDomains();
loadCategories().then(() => { if (q0 || tagFilter) run(); });

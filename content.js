// Content script: dwell-based indexing driven by an explicit state machine, plus an
// in-page status badge (shadow DOM) that shows where the page is in that machine.
(() => {
  "use strict";
  if (window.top !== window) return; // top frame only

  const MIN_TEXT = 300;
  const MAX_TEXT = 30000;

  // ===========================================================================
  // State machine (pure). ctx = { state, known, dwellMs, chunks, detail, reason, error }
  // ===========================================================================
  const S = Object.freeze({
    INIT: "INIT",             // 剛載入或 SPA 換頁，正在問背景這頁能不能索引、是否已在索引
    INELIGIBLE: "INELIGIBLE", // 排除清單 / 無痕 / 密碼頁 / 文字太少
    DISABLED: "DISABLED",     // 使用者關掉自動索引
    WAITING: "WAITING",       // 頁面可見，累計停留中
    PAUSED: "PAUSED",         // 分頁被切走，停留計時暫停
    INDEXING: "INDEXING",     // 已送出，等 embedding 完成
    INDEXED: "INDEXED",       // 完成（detail: "new" | "unchanged"）
    ERROR: "ERROR",           // 模型載入或推論失敗，可重試
    REMOVED: "REMOVED",       // 使用者從索引移除；這次造訪不再自動索引
  });

  const initial = () => ({ state: S.INIT, known: false, dwellMs: 0, chunks: 0, detail: null, reason: null, error: null, tags: [] });

  function transition(ctx, ev) {
    const c = { ...ctx };
    // Global events first.
    if (ev.type === "URL_CHANGED") return initial();
    if (ev.type === "SETTINGS_DISABLED") return { ...c, state: S.DISABLED };
    if (ev.type === "SETTINGS_ENABLED") return c.state === S.DISABLED ? initial() : c;

    switch (c.state) {
      case S.INIT:
        if (ev.type === "CHECK_RESULT") {
          if (ev.disabled) return { ...c, state: S.DISABLED };
          if (ev.denied) return { ...c, state: S.INELIGIBLE, reason: ev.reason };
          return { ...c, known: !!ev.indexed, tags: ev.tags || [], state: ev.visible ? S.WAITING : S.PAUSED };
        }
        return c;

      case S.WAITING:
        if (ev.type === "HIDDEN") return { ...c, state: S.PAUSED };
        if (ev.type === "TICK") {
          const dwellMs = c.dwellMs + ev.ms;
          return dwellMs >= ev.needMs ? { ...c, dwellMs, state: S.INDEXING, manual: false } : { ...c, dwellMs };
        }
        if (ev.type === "INDEX_NOW") return { ...c, state: S.INDEXING, manual: true };
        return c;

      case S.PAUSED:
        if (ev.type === "VISIBLE") return { ...c, state: S.WAITING };
        if (ev.type === "INDEX_NOW") return { ...c, state: S.INDEXING, manual: true };
        return c;

      case S.INDEXING:
        if (ev.type === "RESULT") {
          const r = ev.result || {};
          if (r.ok && r.chunks) return { ...c, state: S.INDEXED, detail: "new", chunks: r.chunks, known: true, tags: r.tags || [] };
          if (r.ok && r.skipped === "unchanged") return { ...c, state: S.INDEXED, detail: "unchanged", known: true, tags: r.tags || [] };
          if (r.ok && r.skipped === "disabled") return { ...c, state: S.DISABLED };
          if (r.ok && r.skipped) return { ...c, state: S.INELIGIBLE, reason: r.skipped };
          if (r.reason === "no-content") return { ...c, state: S.INELIGIBLE, reason: "no-content" };
          return { ...c, state: S.ERROR, error: r.error || "未知錯誤" };
        }
        return c;

      case S.INDEXED:
        if (ev.type === "REMOVED") return { ...c, state: S.REMOVED, known: false };
        if (ev.type === "INDEX_NOW") return { ...c, state: S.INDEXING, manual: true };
        return c;

      case S.ERROR:
      case S.REMOVED:
        if (ev.type === "INDEX_NOW") return { ...c, state: S.INDEXING, error: null, manual: true };
        return c;

      case S.INELIGIBLE:
        // Manual override when the page had too little text (SPA may have loaded more) or a
        // password field: an explicit request from the user wins. Denylist / incognito never do.
        if (ev.type === "INDEX_NOW" && (c.reason === "no-content" || c.reason === "secret-input")) return { ...c, state: S.INDEXING, manual: true };
        return c;

      default:
        return c;
    }
  }

  // ===========================================================================
  // Effects: extraction, messaging, timers
  // ===========================================================================
  let settings = { enabled: true, minDwellSec: 20, showBadge: true, badgeHiddenDomains: [], blockMode: "manual", autoImages: false };
  let imgStat = null;          // {found, done, failed} for this page when autoImages is on
  let imgRunFor = null;        // URL the auto-image pass already ran for
  let ctx = initial();
  let currentUrl = location.href;
  let lastTick = performance.now();
  let checkSeq = 0;

  const send = msg => chrome.runtime.sendMessage(msg).catch(e => ({ ok: false, error: String(e?.message ?? e) }));

  function canonicalUrl() {
    const u = new URL(location.href);
    u.hash = "";
    for (const p of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$|ref_src)/.test(p)) u.searchParams.delete(p);
    return u.toString();
  }

  // Only fields actually shown on screen count: many sites keep a hidden login modal
  // (with a password input) on every page, which must not block indexing.
  function isShown(el) {
    if (!el.getClientRects().length) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) return false;
      if (e.hidden || e.getAttribute("aria-hidden") === "true" || e.inert) return false;
    }
    return true;
  }

  function hasSecretInputs() {
    return [...document.querySelectorAll('input[type="password"], input[autocomplete="cc-number"], input[autocomplete="cc-csc"]')].some(isShown);
  }

  // Returns {url,title,text} | {skip: reason} | null (too little text).
  function extract(manual = false) {
    if (!manual && hasSecretInputs()) return { skip: "secret-input" };
    const root = document.querySelector("article") || document.querySelector("main") ||
                 document.querySelector('[role="main"]') || document.body;
    if (!root) return null;
    let text = root.innerText || "";
    if (text.length < MIN_TEXT && root !== document.body) text = document.body.innerText || "";
    text = text.replace(/\n\s*\n\s*\n+/g, "\n\n").trim().slice(0, MAX_TEXT);
    if (text.length < MIN_TEXT) return null;
    return { url: canonicalUrl(), title: (document.title || "").trim() || location.hostname, text };
  }

  function dispatch(ev) {
    const prev = ctx;
    ctx = transition(ctx, ev);
    if (ev.type === "URL_CHANGED") { imgStat = null; imgRunFor = null; }
    if (ctx.state !== prev.state || ev.type === "URL_CHANGED") onEnter(ctx.state, prev.state);
    render();
  }

  // Opt-in: once the page text is indexed, index its main images (original files only).
  async function maybeAutoImages() {
    const url = canonicalUrl();
    if (!settings.autoImages || imgRunFor === url || !window.__semhistPicker?.autoIndexImages) return;
    imgRunFor = url;
    imgStat = { found: 0, done: 0, failed: 0, running: true };
    render();
    imgStat = { ...(await window.__semhistPicker.autoIndexImages()), running: false };
    render();
  }

  async function onEnter(state) {
    if (state === S.INIT) return runCheck();
    if (state === S.INDEXED) return maybeAutoImages();
    if (state === S.INDEXING) {
      const data = extract(ctx.manual);
      const result = !data ? { ok: false, reason: "no-content" }
        : data.skip ? { ok: true, skipped: data.skip }
        : await send({ type: "INDEX", ...data });
      if (ctx.state === S.INDEXING) dispatch({ type: "RESULT", result });
    }
  }

  async function runCheck() {
    const my = ++checkSeq;
    const url = canonicalUrl();
    const r = await send({ type: "PAGE_INFO", url });
    if (my !== checkSeq || ctx.state !== S.INIT) return;
    dispatch({
      type: "CHECK_RESULT",
      disabled: r?.disabled,
      denied: r?.denied || hasSecretInputs(),
      reason: r?.denied ? (r.reason || "denylist") : hasSecretInputs() ? "secret-input" : null,
      indexed: r?.indexed,
      tags: r?.tags,
      visible: document.visibilityState === "visible",
    });
  }

  function tick() {
    const now = performance.now();
    const ms = now - lastTick;
    lastTick = now;
    if (location.href !== currentUrl) {            // SPA navigation
      currentUrl = location.href;
      return dispatch({ type: "URL_CHANGED" });
    }
    if (ctx.state === S.WAITING && document.visibilityState === "visible") {
      dispatch({ type: "TICK", ms, needMs: settings.minDwellSec * 1000 });
    }
  }

  document.addEventListener("visibilitychange", () => {
    lastTick = performance.now();
    dispatch({ type: document.visibilityState === "visible" ? "VISIBLE" : "HIDDEN" });
  });
  setInterval(tick, 1000);

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg?.type !== "INDEX_NOW") return false;
    dispatch({ type: "INDEX_NOW" });
    // Resolve once the machine leaves INDEXING.
    const started = Date.now();
    const wait = setInterval(() => {
      if (ctx.state !== S.INDEXING || Date.now() - started > 60000) {
        clearInterval(wait);
        sendResponse(ctx.state === S.INDEXED ? { ok: true, chunks: ctx.chunks, skipped: ctx.detail === "unchanged" ? "unchanged" : undefined }
          : ctx.state === S.INELIGIBLE ? { ok: true, skipped: ctx.reason, reason: ctx.reason }
          : { ok: false, error: ctx.error || ctx.state });
      }
    }, 200);
    return true;
  });

  chrome.storage.local.get("settings").then(s => {
    settings = { ...settings, ...(s.settings || {}) };
    if (!settings.enabled) dispatch({ type: "SETTINGS_DISABLED" });
    else onEnter(S.INIT);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) return;
    const was = settings.enabled;
    settings = { ...settings, ...(changes.settings.newValue || {}) };
    if (was && !settings.enabled) dispatch({ type: "SETTINGS_DISABLED" });
    if (!was && settings.enabled) dispatch({ type: "SETTINGS_ENABLED" });
    render();
  });

  // ===========================================================================
  // Badge (shadow DOM, bottom-right)
  // ===========================================================================
  const REASON_TEXT = {
    denylist: "此網站在排除清單", incognito: "無痕視窗不索引", "secret-input": "頁面上有顯示中的密碼欄位，自動索引已略過（可手動索引）",
    "no-content": "頁面文字太少", disabled: "自動索引已關閉",
  };

  let host = null, root = null, menuOpen = false, fadeTimer = null;
  let pageMeta = null; // PAGE_INFO while the menu is open: {tags, categories, clips}

  function ensureBadge() {
    if (host?.isConnected) return;
    host = document.createElement("semhist-badge");
    host.style.cssText = "all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483646;";
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { font: 12.5px/1.4 -apple-system, "Segoe UI", "Noto Sans TC", "PingFang TC", sans-serif; }
        .wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
        .dot { width: 30px; height: 30px; border-radius: 50%; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.25);
               display: grid; place-items: center; cursor: pointer; position: relative; transition: opacity .4s; }
        .dot.faded { opacity: .35; } .dot:hover { opacity: 1; }
        .dot svg { position: absolute; inset: 0; }
        .glyph { position: relative; font-size: 15px; font-weight: 700; color: #2f5bd3; }
        .tip { display: none; background: #1d2433; color: #fff; padding: 5px 9px; border-radius: 6px; white-space: nowrap; }
        .wrap:hover .tip { display: block; }
        .menu { background: #fff; border: 1px solid #e3e6ec; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.15);
                padding: 4px; min-width: 170px; color: #1d2433; }
        .menu button { all: unset; display: block; width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 5px; cursor: pointer; }
        .menu button:hover { background: #eef2fc; }
        .menu .head { padding: 6px 10px 4px; color: #6b7385; font-size: 11.5px; }
        .menu .cats { display: flex; flex-wrap: wrap; gap: 4px; padding: 2px 8px 6px; max-width: 260px; }
        .menu .cats button.cat { width: auto; display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px;
          border: 1px solid var(--c); color: var(--c); }
        .menu .cats button.cat.on { background: var(--c); color: #fff; }
        .menu .cats button.cat.on.auto { background: transparent; color: var(--c); border-style: dashed; font-weight: 600; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .spin { animation: spin .9s linear infinite; transform-origin: 50% 50%; }
        @media (prefers-color-scheme: dark) {
          .dot { background: #1d2129; } .menu { background: #1d2129; border-color: #2c313b; color: #e6e9ef; }
          .menu button:hover { background: #2a3140; }
        }
      </style>
      <div class="wrap">
        <div class="menu" hidden></div>
        <div class="tip"></div>
        <div class="dot" role="button" tabindex="0" aria-label="語意回憶索引狀態"></div>
      </div>`;
    root.querySelector(".dot").addEventListener("click", async e => {
      e.stopPropagation();
      menuOpen = !menuOpen;
      pageMeta = null;
      render();
      if (menuOpen) { pageMeta = await send({ type: "PAGE_INFO", url: canonicalUrl() }); render(); }
    });
    root.querySelector(".menu").addEventListener("click", onMenu);
    document.addEventListener("click", () => { if (menuOpen) { menuOpen = false; render(); } });
    document.documentElement.appendChild(host);
  }

  function ring(progress, color, spinning = false) {
    const r = 13, len = 2 * Math.PI * r;
    const dash = spinning ? `${len * 0.25} ${len}` : `${len * progress} ${len}`;
    return `<svg viewBox="0 0 30 30" class="${spinning ? "spin" : ""}">
      <circle cx="15" cy="15" r="${r}" fill="none" stroke="#e3e6ec" stroke-width="2.5"/>
      <circle cx="15" cy="15" r="${r}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round"
              stroke-dasharray="${dash}" transform="rotate(-90 15 15)"/></svg>`;
  }

  // State -> view
  function view() {
    const need = settings.minDwellSec;
    const sec = Math.min(need, Math.floor(ctx.dwellMs / 1000));
    switch (ctx.state) {
      case S.WAITING: return { svg: ring(ctx.dwellMs / (need * 1000), "#2f5bd3"), glyph: ctx.known ? "✓" : "", color: "#2f5bd3",
        tip: ctx.known ? `已在索引中，停留 ${sec}/${need} 秒後更新` : `停留 ${sec}/${need} 秒後索引`, faded: ctx.known };
      case S.PAUSED: return { svg: ring(ctx.dwellMs / (need * 1000), "#9aa3b5"), glyph: ctx.known ? "✓" : "‖", color: "#9aa3b5",
        tip: `分頁不在前景，計時暫停（${sec}/${need} 秒）`, faded: true };
      case S.INDEXING: return { svg: ring(0, "#2f5bd3", true), glyph: "", tip: "索引中…" };
      case S.INDEXED: return { svg: "", glyph: "✓", color: "#1f8a5b", bg: "#e8f6ef",
        tip: (ctx.detail === "unchanged" ? "已在索引中（內容未變）" : `已索引（${ctx.chunks} 段）`) +
             (ctx.tags?.length ? " · " + ctx.tags.map(t => t.name).join("、") : "") +
             (imgStat ? (imgStat.running ? " · 圖片索引中…" : imgStat.found ? ` · 圖片 ${imgStat.done}/${imgStat.found}` : " · 沒有符合條件的圖片") : ""),
        fadeLater: !imgStat?.running };
      case S.ERROR: return { svg: "", glyph: "!", color: "#d93a3a", bg: "#fdecec", tip: `索引失敗：${ctx.error}（點擊重試）` };
      case S.REMOVED: return { svg: "", glyph: "−", color: "#9aa3b5", tip: "已從索引移除（這次造訪不會自動索引）", faded: true };
      case S.INELIGIBLE: return ctx.reason === "no-content" || ctx.reason === "secret-input"
        ? { svg: "", glyph: ctx.reason === "secret-input" ? "🔒" : "∅", color: "#9aa3b5", faded: true,
            tip: ctx.reason === "secret-input" ? "頁面上有密碼欄位，自動索引已略過 · 點擊可手動索引" : "頁面文字太少，未索引" }
        : null; // 排除清單、密碼頁等：不顯示
      default: return null; // INIT, DISABLED
    }
  }

  function menuItems() {
    const items = settings.blockMode === "off" ? [] : [["pick", "📌 選取區塊索引…"]];
    if ([S.WAITING, S.PAUSED, S.ERROR, S.REMOVED].includes(ctx.state) ||
        (ctx.state === S.INELIGIBLE && (ctx.reason === "no-content" || ctx.reason === "secret-input"))) items.push(["index", ctx.state === S.ERROR ? "重試索引" : "立即索引"]);
    if (ctx.state === S.INDEXED) items.push(["reindex", "重新索引"], ["remove", "從索引移除此頁"]);
    items.push(["search", "開啟語意搜尋"], ["hide", `在 ${location.hostname} 隱藏此圖示`]);
    return items;
  }

  async function onMenu(e) {
    e.stopPropagation();
    const act = e.target.closest("button")?.dataset.act;
    if (!act) return;
    menuOpen = false;
    if (act === "pick") { render(); return window.__semhistPicker?.start(); }
    if (act.startsWith("tag:")) {
      const id = act.slice(4);
      const on = !(pageMeta?.tags || []).some(t => t.id === id);
      const r = await send({ type: "TAG_SET", url: canonicalUrl(), catId: id, on });
      if (r?.ok) { ctx = { ...ctx, tags: r.tags }; pageMeta = { ...pageMeta, tags: r.tags }; }
      menuOpen = true; // keep open for multiple toggles
      return render();
    }
    if (act === "index" || act === "reindex") dispatch({ type: "INDEX_NOW" });
    if (act === "remove") { await send({ type: "DELETE", url: canonicalUrl() }); dispatch({ type: "REMOVED" }); }
    if (act === "search") send({ type: "OPEN_SEARCH", q: document.title });
    if (act === "hide") {
      const hidden = [...new Set([...(settings.badgeHiddenDomains || []), location.hostname])];
      const { settings: s = {} } = await chrome.storage.local.get("settings");
      await chrome.storage.local.set({ settings: { ...s, badgeHiddenDomains: hidden } });
    }
    render();
  }

  function render() {
    const v = view();
    const hidden = !settings.showBadge || (settings.badgeHiddenDomains || []).includes(location.hostname);
    if (!v || hidden) { if (host) host.style.display = "none"; return; }
    ensureBadge();
    host.style.display = "";
    const dot = root.querySelector(".dot");
    dot.style.background = v.bg || "";
    dot.innerHTML = `${v.svg}<span class="glyph" style="color:${v.color || "#2f5bd3"}">${v.glyph}</span>`;
    root.querySelector(".tip").textContent = v.tip;
    clearTimeout(fadeTimer);
    dot.classList.toggle("faded", !!v.faded);
    if (v.fadeLater) fadeTimer = setTimeout(() => dot.classList.add("faded"), 3000);
    const menu = root.querySelector(".menu");
    menu.hidden = !menuOpen;
    if (menuOpen) {
      const escH = x => String(x).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
      let catHtml = "";
      if (ctx.state === S.INDEXED || ctx.known) {
        if (!pageMeta) catHtml = `<div class="head">分類載入中…</div>`;
        else if (pageMeta.ok && pageMeta.categories?.length) {
          const on = new Map((pageMeta.tags || []).map(t => [t.id, t]));
          catHtml = `<div class="head">分類（點擊切換；虛線＝自動）</div><div class="cats">` +
            pageMeta.categories.map(c => {
              const t = on.get(c.id);
              return `<button data-act="tag:${escH(c.id)}" class="cat ${t ? "on" : ""} ${t?.auto ? "auto" : ""}" style="--c:${escH(c.color)}">${t ? "✓ " : ""}${escH(c.name)}</button>`;
            }).join("") + `</div>`;
        }
      }
      const clips = pageMeta?.clips ? ` · 📌 ${pageMeta.clips} 個片段` : "";
      menu.innerHTML = `<div class="head">語意回憶 · ${ctx.state}${clips}</div>` + catHtml +
        menuItems().map(([a, label]) => `<button data-act="${a}">${label}</button>`).join("");
    }
  }

  // Exposed for tests / debugging in the isolated world.
  window.__semhist = { S, transition, initial, get ctx() { return ctx; }, dispatch };
})();

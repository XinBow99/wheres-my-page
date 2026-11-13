// Block indexing: index a single DOM block (text "clip" or image) instead of the whole page.
// Loaded before content.js in the same isolated world; exposes window.__semhistPicker.
//
// Setting blockMode:
//   "off"    — 關閉：no hints, no picker shortcut (context-menu actions explain it is off)
//   "manual" — 點了才選：DevTools-style picker on demand (shortcut / popup / badge menu)
//   "hints"  — 自動標出：after load, indexable blocks get a small marker (+ → ✓)
//
// Picker mode machine:
//   IDLE ──start──▶ PICKING ──click/Enter──▶ CONFIRM ──save──▶ SAVING ──ok──▶ IDLE (+toast)
//                    │ Esc                     │ Esc/取消            └─error─▶ CONFIRM
// Per-block hint machine (hints mode):  IDLE(+) ──click──▶ SAVING ──ok──▶ DONE(✓) ──click──▶ REMOVING ──▶ IDLE
//                                                           └─error─▶ ERROR(!) ──click──▶ SAVING
//
// Images are NEVER indexed automatically — only when the user picks one.
(() => {
  "use strict";
  if (window.top !== window) return;

  const MIN_CLIP = 15;
  const MAX_CLIP = 8000;
  const HINT_MIN_TEXT = 80;
  const HINT_MIN_IMG = 120;
  const MAX_HINTS = 400;
  const BLOCK_TAGS = new Set(["P", "LI", "PRE", "BLOCKQUOTE", "TD", "DD", "DT", "H1", "H2", "H3", "H4", "H5", "H6",
    "SECTION", "ARTICLE", "ASIDE", "FIGURE", "TABLE", "UL", "OL", "DL", "DETAILS", "DIV", "MAIN"]);
  const VISUAL_TAGS = new Set(["IMG", "PICTURE", "CANVAS", "SVG", "VIDEO"]);
  const CHROME_SEL = "nav, header, footer, aside, form, [role=navigation], [role=banner], [role=contentinfo], [aria-hidden=true], semhist-picker, semhist-badge, semhist-hints";
  // Images: hero banners live in <header>, carousels mark slides aria-hidden — keep those.
  const IMG_CHROME_SEL = "nav, footer, form, [role=navigation], [role=contentinfo], semhist-picker, semhist-badge, semhist-hints";
  const AUTO_IMG_MIN_W = 200, AUTO_IMG_MIN_H = 150, AUTO_IMG_MAX = 8;

  let blockMode = "manual";
  let mode = "IDLE";
  let current = null;
  let childStack = [];
  let selectionText = null;
  let asImage = false;
  let host = null, root = null;
  let lastContextTarget = null;

  // ---- helpers ---------------------------------------------------------------
  function canonicalUrl() {
    const u = new URL(location.href);
    u.hash = "";
    for (const p of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$|ref_src)/.test(p)) u.searchParams.delete(p);
    return u.toString();
  }

  // Must match chunk.js hashText (the offscreen side keys clips by it).
  function hashText(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16);
  }

  function textOf(el) {
    return (el?.innerText || el?.textContent || "").replace(/\n\s*\n\s*\n+/g, "\n\n").trim().slice(0, MAX_CLIP);
  }

  function textFragment(text) {
    const line = String(text || "").split("\n").map(s => s.trim()).find(s => s.length >= 4) || "";
    if (!line) return "";
    const cjk = /[㐀-鿿぀-ヿ가-힯]/.test(line);
    const start = cjk ? line.slice(0, 16) : line.split(/\s+/).slice(0, 7).join(" ");
    const enc = s => encodeURIComponent(s).replace(/-/g, "%2D").replace(/,/g, "%2C").replace(/&/g, "%26");
    return "#:~:text=" + enc(start);
  }

  function cssPath(el) {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.documentElement && parts.length < 8; e = e.parentElement) {
      if (e.id && /^[A-Za-z][\w-]*$/.test(e.id)) { parts.unshift("#" + e.id); break; }
      let i = 1;
      for (let s = e.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === e.tagName) i++;
      parts.unshift(`${e.tagName.toLowerCase()}:nth-of-type(${i})`);
    }
    return parts.join(" > ");
  }

  const isOurs = el => !!el?.closest?.("semhist-picker, semhist-badge, semhist-hints");
  const tagOf = el => (el?.tagName || "").toUpperCase();

  function isVisual(el) {
    if (!el) return false;
    if (VISUAL_TAGS.has(tagOf(el))) return true;
    try {
      const bg = getComputedStyle(el).backgroundImage;
      return !!bg && bg !== "none" && /url\(/.test(bg) && textOf(el).length < 20;
    } catch { return false; }
  }

  function imageSrc(el) {
    const t = tagOf(el);
    if (t === "IMG") return el.currentSrc || el.src || "";
    if (t === "PICTURE") { const i = el.querySelector("img"); return i?.currentSrc || i?.src || ""; }
    if (t === "VIDEO") return el.poster || "";
    try {
      const m = /url\(["']?([^"')]+)["']?\)/.exec(getComputedStyle(el).backgroundImage || "");
      return m ? new URL(m[1], location.href).href : "";
    } catch { return ""; }
  }

  function captionOf(el) {
    const own = el.getAttribute?.("alt") || el.getAttribute?.("title") || el.getAttribute?.("aria-label") || "";
    const fig = el.closest?.("figure")?.querySelector("figcaption");
    return [own, fig ? textOf(fig) : ""].filter(Boolean).join(" — ").slice(0, 300);
  }

  function nearestBlock(el) {
    if (isVisual(el)) return el;
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      if (BLOCK_TAGS.has(tagOf(e)) && textOf(e).length >= 40) return e;
    }
    return el;
  }

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const send = m => chrome.runtime.sendMessage(m).catch(e => ({ ok: false, error: String(e?.message ?? e) }));
  const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  // ---- indexing actions (shared by picker and hints) ---------------------------
  async function saveTextBlock(text, { note = "", el = null } = {}) {
    const parentUrl = canonicalUrl();
    return send({
      type: "CLIP", parentUrl, linkUrl: parentUrl + textFragment(text),
      title: (document.title || location.hostname).trim(), text, note, selector: el ? cssPath(el) : "",
    });
  }

  async function saveImageBlock(el, { note = "" } = {}) {
    const r0 = el.getBoundingClientRect();
    if (r0.top < 0 || r0.bottom > innerHeight || r0.left < 0 || r0.right > innerWidth) {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      await new Promise(r => setTimeout(r, 150));
    }
    // Hide our own UI so it is not in the screenshot.
    const hidden = [...document.querySelectorAll("semhist-picker, semhist-badge, semhist-hints")].map(h => [h, h.style.visibility]);
    hidden.forEach(([h]) => h.style.visibility = "hidden");
    await frame();
    const r = el.getBoundingClientRect();
    const caption = captionOf(el);
    const parentUrl = canonicalUrl();
    try {
      return await send({
        type: "IMAGE", parentUrl, linkUrl: parentUrl + (caption ? textFragment(caption) : ""),
        title: (document.title || location.hostname).trim(), caption, note, srcUrl: imageSrc(el),
        rect: { left: r.left, top: r.top, width: r.width, height: r.height }, dpr: devicePixelRatio || 1,
        selector: cssPath(el),
      });
    } finally {
      hidden.forEach(([h, v]) => h.style.visibility = v);
    }
  }

  // ---- picker overlay UI (shadow DOM) -------------------------------------------
  function ensureHost() {
    if (host?.isConnected) return;
    host = document.createElement("semhist-picker");
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { font: 12.5px/1.45 -apple-system, "Segoe UI", "Noto Sans TC", "PingFang TC", sans-serif; }
        .box { position: fixed; background: rgba(111,168,220,.45); outline: 1px solid rgba(47,91,211,.9); display: none; }
        .box.locked { background: rgba(31,138,91,.18); outline: 2px solid #1f8a5b; }
        .label { position: fixed; display: none; background: #fff; color: #1d2433; border-radius: 3px; padding: 1px 6px;
                 font: 11.5px/1.6 ui-monospace, Menlo, Consolas, monospace; box-shadow: 0 1px 3px rgba(0,0,0,.3); white-space: nowrap; }
        .label .tag { color: #881280; } .label .cls { color: #1a1aa6; } .label .dim { color: #6b7385; margin-left: 6px; }
        .bar { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); background: #1d2433; color: #fff;
               border-radius: 8px; padding: 7px 12px; box-shadow: 0 4px 16px rgba(0,0,0,.3); display: none; pointer-events: auto; }
        .bar kbd { border: 1px solid #555; border-radius: 3px; padding: 0 4px; font-size: 11px; }
        .panel { position: fixed; width: 360px; background: #fff; color: #1d2433; border-radius: 10px; padding: 12px;
                 box-shadow: 0 8px 28px rgba(0,0,0,.28); display: none; pointer-events: auto; }
        .panel .pv { max-height: 96px; overflow: auto; white-space: pre-line; font-size: 12px; color: #444;
                     background: #f6f7f9; border-radius: 6px; padding: 6px 8px; margin: 6px 0; }
        .panel .pv.img { color: #6b7385; }
        .panel input.note { width: 100%; box-sizing: border-box; font: inherit; padding: 6px 8px; border: 1px solid #e3e6ec; border-radius: 6px; }
        .panel label.asimg { display: flex; gap: 6px; align-items: center; margin-top: 6px; font-size: 12px; cursor: pointer; }
        .panel .row { display: flex; gap: 8px; justify-content: flex-end; align-items: center; margin-top: 8px; }
        .panel .row .muted { margin-right: auto; color: #6b7385; font-size: 11.5px; }
        .panel button { font: inherit; padding: 5px 12px; border-radius: 6px; border: 1px solid #2f5bd3; background: #2f5bd3; color: #fff; cursor: pointer; }
        .panel button.ghost { background: #fff; color: #2f5bd3; }
        .panel button:disabled { opacity: .5; }
        .panel .err { color: #d93a3a; font-size: 12px; margin-top: 6px; }
        .toast { position: fixed; right: 56px; bottom: 18px; background: #1d2433; color: #fff; padding: 8px 12px; border-radius: 8px;
                 box-shadow: 0 4px 16px rgba(0,0,0,.3); display: none; max-width: 380px; }
        @media (prefers-color-scheme: dark) {
          .panel { background: #1d2129; color: #e6e9ef; } .panel .pv { background: #15181e; color: #c9cfdb; }
          .panel input.note { background: #15181e; border-color: #2c313b; color: inherit; }
        }
      </style>
      <div class="box"></div><div class="label"></div>
      <div class="bar">滑鼠移到要索引的區塊 · <kbd>↑</kbd> 父層 <kbd>↓</kbd> 子層 · 點擊或 <kbd>Enter</kbd> 選定 · <kbd>Esc</kbd> 取消 <span class="len"></span></div>
      <div class="panel">
        <b class="ttl">📌 索引這個區塊</b>
        <div class="pv"></div>
        <input class="note" placeholder="備註（選填）：之後搜尋也會比對這段文字" maxlength="200">
        <label class="asimg"><input type="checkbox" class="imgchk"> 🖼 以圖片索引（找得到原圖用原圖，否則截取畫面）</label>
        <div class="err"></div>
        <div class="row"><span class="muted"></span><button class="ghost cancel">取消</button><button class="save">索引</button></div>
      </div>
      <div class="toast"></div>`;
    root.querySelector(".cancel").addEventListener("click", stop);
    root.querySelector(".save").addEventListener("click", save);
    root.querySelector(".imgchk").addEventListener("change", e => { asImage = e.target.checked; refreshConfirm(); });
    root.querySelector(".note").addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") save();
      if (e.key === "Escape") stop();
    });
    document.documentElement.appendChild(host);
  }

  const $ = sel => root.querySelector(sel);

  function drawBox(el, locked = false) {
    const box = $(".box"), label = $(".label");
    if (!el) { box.style.display = label.style.display = "none"; return; }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    box.classList.toggle("locked", locked);
    const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    label.innerHTML = `<span class="tag">${el.tagName.toLowerCase()}</span><span class="cls">${esc(cls)}</span>` +
      `<span class="dim">${(+r.width.toFixed(1))} × ${(+r.height.toFixed(1))}</span>`;
    label.style.display = "block";
    const top = r.top - 22 >= 0 ? r.top - 22 : r.bottom + 4;
    Object.assign(label.style, { left: Math.max(4, r.left) + "px", top: top + "px" });
    $(".len").textContent = isVisual(el) ? "· 圖片" : `· ${textOf(el).length} 字`;
  }

  function placePanel(rect) {
    const panel = $(".panel");
    panel.style.display = "block";
    const w = 360, h = panel.offsetHeight || 220;
    const left = Math.min(Math.max(8, rect.left), innerWidth - w - 8);
    let top = rect.bottom + 8;
    if (top + h > innerHeight - 8) top = Math.max(8, rect.top - h - 8);
    Object.assign(panel.style, { left: left + "px", top: top + "px" });
  }

  function toast(text, ms = 3500) {
    ensureHost();
    const t = $(".toast");
    t.textContent = text;
    t.style.display = "block";
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.style.display = "none"; cleanupIfIdle(); }, ms);
  }

  function cleanupIfIdle() { if (mode === "IDLE" && host && $(".toast").style.display === "none") { host.remove(); host = null; } }

  // ---- picker modes ----------------------------------------------------------------
  function start() {
    if (blockMode === "off") return toast("區塊索引已關閉（可在設定改成「點了才選」或「自動標出」）");
    if (mode !== "IDLE") return;
    ensureHost();
    mode = "PICKING";
    current = null; childStack = []; selectionText = null;
    $(".bar").style.display = "block";
    $(".panel").style.display = "none";
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("scroll", onScroll, true);
  }

  function stop() {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("scroll", onScroll, true);
    mode = "IDLE";
    current = null; selectionText = null;
    if (!host) return;
    $(".bar").style.display = "none";
    $(".panel").style.display = "none";
    drawBox(null);
    cleanupIfIdle();
  }

  // Cards often put a transparent link/gradient layer over the image; if the top element
  // has (almost) no text of its own, pick the image underneath instead.
  function pickAt(x, y) {
    const top = document.elementFromPoint(x, y);
    if (!top || isVisual(top) || textOf(top).length >= 20) return top;
    const stack = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [];
    return stack.find(el => !isOurs(el) && isVisual(el)) || top;
  }

  function onMove(e) {
    if (mode !== "PICKING") return;
    const el = pickAt(e.clientX, e.clientY);
    if (!el || isOurs(el) || el === document.documentElement || el === document.body) return;
    if (el !== current) { current = el; childStack = []; drawBox(el); }
  }

  function onScroll() { if (mode === "PICKING" || mode === "CONFIRM") drawBox(current, mode === "CONFIRM"); }

  function onClick(e) {
    if (mode !== "PICKING" || isOurs(e.target)) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    if (current) confirmElement(current);
  }

  function onKey(e) {
    if (mode !== "PICKING" && mode !== "CONFIRM") return;
    if (isOurs(e.target) && e.key !== "Escape") return;
    if (!["Escape", "ArrowUp", "ArrowDown", "Enter"].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === "Escape") return stop();
    if (!current) return;
    if (e.key === "ArrowUp") {
      const p = current.parentElement;
      if (p && p !== document.body && p !== document.documentElement) { childStack.push(current); current = p; }
    } else if (e.key === "ArrowDown") {
      current = childStack.pop() || current.firstElementChild || current;
    } else if (e.key === "Enter" && mode === "PICKING") {
      return confirmElement(current);
    }
    if (mode === "CONFIRM") { asImage = isVisual(current); refreshConfirm(); } else drawBox(current);
  }

  function confirmElement(el, { forceImage = null } = {}) {
    ensureHost();
    current = el;
    selectionText = null;
    asImage = forceImage ?? isVisual(el);
    if (mode === "IDLE") {
      document.addEventListener("keydown", onKey, true);
      document.addEventListener("scroll", onScroll, true);
    }
    mode = "CONFIRM";
    $(".bar").style.display = "none";
    $(".note").value = "";
    refreshConfirm();
    setTimeout(() => $(".note").focus(), 0);
  }

  function refreshConfirm() {
    const chk = $(".imgchk");
    chk.checked = asImage;
    $(".asimg").style.display = selectionText != null ? "none" : "flex";
    $(".ttl").textContent = asImage ? "🖼 索引這張圖片" : "📌 索引這個區塊";
    let canSave;
    if (asImage) {
      const cap = captionOf(current);
      $(".pv").className = "pv img";
      $(".pv").textContent = (cap ? `說明文字：${cap}\n` : "") + (imageSrc(current) ? "會使用原始圖片檔" : "會截取畫面上這個區塊");
      $(".panel .muted").textContent = `<${current.tagName.toLowerCase()}> · 圖片 · 需要 Text-Vision 440M 模型`;
      $(".err").textContent = "";
      canSave = true;
    } else {
      const text = selectionText ?? textOf(current);
      $(".pv").className = "pv";
      $(".pv").textContent = text.slice(0, 600) + (text.length > 600 ? "…" : "");
      $(".panel .muted").textContent = selectionText != null ? `選取文字 · ${text.length} 字` : `<${current.tagName.toLowerCase()}> · ${text.length} 字 · ↑↓ 調整範圍`;
      canSave = text.length >= MIN_CLIP;
      $(".err").textContent = canSave ? "" : (isVisual(current) ? "這是圖片：勾選「以圖片索引」" : "文字太少，按 ↑ 選大一點的區塊");
    }
    $(".save").disabled = !canSave;
    if (current) drawBox(current, true);
    placePanel(current ? current.getBoundingClientRect() : selectionRect());
  }

  function selectionRect() {
    const sel = getSelection();
    if (sel?.rangeCount) return sel.getRangeAt(0).getBoundingClientRect();
    return { left: innerWidth / 2 - 180, top: innerHeight / 3, bottom: innerHeight / 3 };
  }

  function confirmSelection(text) {
    ensureHost();
    const t = String(text || getSelection()?.toString() || "").trim().slice(0, MAX_CLIP);
    if (!t) return toast("沒有選取到文字");
    current = null;
    selectionText = t;
    asImage = false;
    if (mode === "IDLE") document.addEventListener("keydown", onKey, true);
    mode = "CONFIRM";
    $(".bar").style.display = "none";
    drawBox(null);
    $(".note").value = "";
    refreshConfirm();
    setTimeout(() => $(".note").focus(), 0);
  }

  async function save() {
    if (mode !== "CONFIRM" || $(".save").disabled) return;
    mode = "SAVING";
    $(".save").disabled = true;
    $(".save").textContent = asImage ? "處理圖片中…" : "索引中…";
    const note = $(".note").value.trim();
    const el = current;
    const res = asImage
      ? await saveImageBlock(el, { note })
      : await saveTextBlock(selectionText ?? textOf(el), { note, el });
    $(".save").textContent = "索引";
    if (!res?.ok) {
      mode = "CONFIRM";
      $(".save").disabled = false;
      $(".err").textContent = "失敗：" + (res?.error || "未知錯誤");
      return;
    }
    const tags = (res.tags || []).map(t => t.name).join("、");
    stop();
    toast(asImage
      ? `🖼 已索引圖片${res.from === "screenshot" ? "（截圖）" : ""}${tags ? " · 分類：" + tags : ""}`
      : `📌 已索引片段（${res.chunks} 段）${tags ? " · 分類：" + tags : ""}`);
    hints.refresh();
  }

  // =================================================================================
  // Hints mode: markers on indexable blocks
  // =================================================================================
  const hints = (() => {
    let hhost = null, hroot = null;
    let blocks = [];                 // [{el, kind:'text'|'image', key, text?, state, url?}]
    let byEl = new Map();
    let visible = new Set();
    let known = { hashes: new Map(), images: new Map() }; // hash/srcUrl/selector -> url
    let io = null, mo = null, rescanTimer = null, raf = 0, enabled = false;

    function isHiddenChrome(el) { return !!el.closest(CHROME_SEL); }
    function isImgChrome(el) { return !!el.closest(IMG_CHROME_SEL); }

    function candidates() {
      const out = [];
      const textSel = "p, li, pre, blockquote, td, dd";
      for (const el of document.querySelectorAll(textSel)) {
        if (out.length >= MAX_HINTS) break;
        if (isHiddenChrome(el)) continue;
        // Prefer the innermost text container (e.g. a <li> that wraps <p>s gets markers on the <p>s).
        if ([...el.querySelectorAll(textSel)].some(d => textOf(d).length >= HINT_MIN_TEXT)) continue;
        const t = textOf(el);
        if (t.length < HINT_MIN_TEXT) continue;
        if (!el.getClientRects().length) continue;
        out.push({ el, kind: "text", text: t, key: hashText(t) });
      }
      for (const el of document.querySelectorAll("img, canvas, video, svg")) {
        if (out.length >= MAX_HINTS) break;
        if (isImgChrome(el) || (tagOf(el) === "SVG" && el.parentElement?.closest("svg"))) continue;
        if (!el.getClientRects().length) continue;
        const r = el.getBoundingClientRect();
        if (r.width < HINT_MIN_IMG || r.height < HINT_MIN_IMG) continue;
        out.push({ el, kind: "image", key: imageSrc(el) || cssPath(el) });
      }
      return out;
    }

    function ensureHHost() {
      if (hhost?.isConnected) return;
      hhost = document.createElement("semhist-hints");
      hhost.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483645;pointer-events:none;";
      hroot = hhost.attachShadow({ mode: "open" });
      hroot.innerHTML = `
        <style>
          .m { position: fixed; width: 20px; height: 20px; border-radius: 50%; pointer-events: auto; cursor: pointer;
               display: grid; place-items: center; font: 700 12px/1 -apple-system, "Segoe UI", sans-serif;
               background: #fff; color: #2f5bd3; border: 1.5px solid #2f5bd3; box-shadow: 0 1px 3px rgba(0,0,0,.25);
               opacity: .35; transition: opacity .15s, transform .15s; }
          .m:hover { opacity: 1; transform: scale(1.12); }
          .m.image { font-size: 11px; }
          .m.done { background: #1f8a5b; border-color: #1f8a5b; color: #fff; opacity: .9; }
          .m.error { background: #d93a3a; border-color: #d93a3a; color: #fff; opacity: 1; }
          .m.saving { opacity: 1; border-color: #c9d4f3; border-top-color: #2f5bd3; animation: spin .8s linear infinite; color: transparent; }
          @keyframes spin { to { transform: rotate(360deg); } }
          .outline { position: fixed; outline: 2px dashed #2f5bd3; background: rgba(47,91,211,.06); display: none; pointer-events: none; }
          .outline.done { outline-color: #1f8a5b; background: rgba(31,138,91,.06); }
        </style>
        <div class="outline"></div><div class="layer"></div>`;
      hroot.querySelector(".layer").addEventListener("click", onMarkerClick);
      hroot.querySelector(".layer").addEventListener("mouseover", e => outline(e.target.closest(".m")));
      hroot.querySelector(".layer").addEventListener("mouseout", () => outline(null));
      document.documentElement.appendChild(hhost);
    }

    function glyph(b) {
      if (b.state === "done") return "✓";
      if (b.state === "error") return "!";
      if (b.state === "saving") return "";
      return b.kind === "image" ? "🖼" : "+";
    }

    function title(b) {
      if (b.state === "done") return b.kind === "image" ? "已索引這張圖片 · 點擊移除" : "已索引這個區塊 · 點擊移除";
      if (b.state === "error") return "失敗：" + (b.error || "") + " · 點擊重試";
      if (b.state === "saving") return "索引中…";
      return b.kind === "image" ? "索引這張圖片" : "索引這個區塊";
    }

    function outline(m) {
      const o = hroot?.querySelector(".outline");
      if (!o) return;
      const b = m ? blocks[+m.dataset.i] : null;
      if (!b) { o.style.display = "none"; return; }
      const r = b.el.getBoundingClientRect();
      Object.assign(o.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
      o.classList.toggle("done", b.state === "done");
    }

    function layout() {
      raf = 0;
      if (!enabled || !hroot) return;
      const layer = hroot.querySelector(".layer");
      const html = [];
      for (const i of visible) {
        const b = blocks[i];
        if (!b || !b.el.isConnected) continue;
        const r = b.el.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight) continue;
        const left = Math.min(innerWidth - 24, Math.max(2, r.right + 4 <= innerWidth - 24 ? r.right + 4 : r.right - 24));
        const top = Math.max(2, Math.min(innerHeight - 24, r.top + 2));
        html.push(`<div class="m ${b.kind} ${b.state}" data-i="${i}" title="${esc(title(b))}" style="left:${left}px;top:${top}px">${glyph(b)}</div>`);
      }
      layer.innerHTML = html.join("");
    }

    const schedule = () => { if (!raf) raf = requestAnimationFrame(layout); };

    async function loadKnown() {
      const info = await send({ type: "PAGE_INFO", url: canonicalUrl() });
      known = { hashes: new Map(), images: new Map() };
      for (const c of info?.blocks || []) {
        if (c.source === "clip") known.hashes.set(c.hash, c.url);
        if (c.source === "image") { if (c.srcUrl) known.images.set(c.srcUrl, c.url); if (c.selector) known.images.set(c.selector, c.url); }
      }
    }

    function applyKnown(b) {
      const url = b.kind === "text" ? known.hashes.get(b.key) : (known.images.get(b.key) || known.images.get(cssPath(b.el)));
      if (url) { b.state = "done"; b.url = url; } else if (b.state === "done") { b.state = "idle"; b.url = null; }
    }

    async function scan() {
      if (!enabled) return;
      ensureHHost();
      const found = candidates();
      const old = byEl;
      blocks = found.map(f => {
        const prev = old.get(f.el);
        return prev && prev.key === f.key ? prev : { ...f, state: "idle" };
      });
      byEl = new Map(blocks.map(b => [b.el, b]));
      blocks.forEach(applyKnown);
      io?.disconnect();
      visible = new Set();
      io = new IntersectionObserver(entries => {
        for (const e of entries) {
          const i = blocks.findIndex(b => b.el === e.target);
          if (i < 0) continue;
          e.isIntersecting ? visible.add(i) : visible.delete(i);
        }
        schedule();
      }, { rootMargin: "200px 0px" });
      blocks.forEach(b => io.observe(b.el));
      schedule();
    }

    async function onMarkerClick(e) {
      const m = e.target.closest(".m");
      if (!m) return;
      e.preventDefault(); e.stopPropagation();
      const b = blocks[+m.dataset.i];
      if (!b || b.state === "saving") return;
      if (b.state === "done") {
        b.state = "saving"; schedule();
        const r = await send({ type: "DELETE", url: b.url });
        b.state = r?.ok ? "idle" : "done"; if (r?.ok) b.url = null;
        if (r?.ok) toast(b.kind === "image" ? "已從索引移除這張圖片" : "已從索引移除這個區塊", 2000);
        return schedule();
      }
      b.state = "saving"; b.error = null; schedule();
      const r = b.kind === "image" ? await saveImageBlock(b.el) : await saveTextBlock(b.text, { el: b.el });
      if (r?.ok) {
        b.state = "done"; b.url = r.url;
        const tags = (r.tags || []).map(t => t.name).join("、");
        toast((b.kind === "image" ? "🖼 已索引圖片" : "📌 已索引區塊") + (tags ? " · " + tags : ""), 2500);
      } else { b.state = "error"; b.error = r?.error || "未知錯誤"; }
      schedule();
    }

    function enable() {
      if (enabled) return;
      enabled = true;
      addEventListener("scroll", schedule, true);
      addEventListener("resize", schedule);
      mo = new MutationObserver(muts => {
        if (muts.every(m => isOurs(m.target))) return;
        clearTimeout(rescanTimer);
        rescanTimer = setTimeout(scan, 1500);
      });
      mo.observe(document.body, { childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ["src", "srcset", "style", "class", "hidden", "aria-hidden"] });
      document.addEventListener("load", onImgLoad, true);   // lazy images reaching full size
      loadKnown().then(scan);
    }

    function disable() {
      if (!enabled) return;
      enabled = false;
      removeEventListener("scroll", schedule, true);
      removeEventListener("resize", schedule);
      mo?.disconnect(); io?.disconnect();
      document.removeEventListener("load", onImgLoad, true);
      clearTimeout(rescanTimer);
      hhost?.remove(); hhost = null; hroot = null;
      blocks = []; byEl = new Map(); visible = new Set();
    }

    function onImgLoad(e) {
      if (tagOf(e.target) !== "IMG" || isOurs(e.target)) return;
      clearTimeout(rescanTimer);
      rescanTimer = setTimeout(scan, 600);
    }

    async function refresh() { if (enabled) { await loadKnown(); blocks.forEach(applyKnown); schedule(); } }

    return { enable, disable, refresh, scan, get blocks() { return blocks; }, get enabled() { return enabled; } };
  })();

  // Opt-in (settings.autoImages): after the page is auto-indexed, index the main content
  // images too. Uses the original image file only — never scrolls or screenshots the page.
  function autoImageCandidates() {
    const root = document.querySelector("article") || document.querySelector("main") ||
                 document.querySelector('[role="main"]') || document.body;
    const seen = new Set();
    const out = [];
    for (const img of root.querySelectorAll("img")) {
      if (out.length >= AUTO_IMG_MAX) break;
      if (img.closest(IMG_CHROME_SEL + ", aside, [role=complementary]")) continue;
      const src = img.currentSrc || img.src || "";
      if (!/^https?:/.test(src) || seen.has(src) || /\.svg(\?|$)/i.test(src)) continue;
      const r = img.getBoundingClientRect();
      if (r.width < AUTO_IMG_MIN_W || r.height < AUTO_IMG_MIN_H) continue;
      if (img.naturalWidth && img.naturalWidth < AUTO_IMG_MIN_W) continue;
      seen.add(src);
      out.push(img);
    }
    return out;
  }

  async function autoIndexImages() {
    const imgs = autoImageCandidates();
    let done = 0, failed = 0;
    for (const img of imgs) {
      const caption = captionOf(img);
      const parentUrl = canonicalUrl();
      const r = await send({
        type: "IMAGE", auto: true, parentUrl, linkUrl: parentUrl + (caption ? textFragment(caption) : ""),
        title: (document.title || location.hostname).trim(), caption, note: "",
        srcUrl: img.currentSrc || img.src, selector: cssPath(img),
      });
      if (r?.ok && !r.skipped) done++; else if (!r?.ok) failed++;
    }
    hints.refresh();
    return { found: imgs.length, done, failed };
  }

  function applyMode(m) {
    blockMode = m || "manual";
    if (blockMode === "hints") hints.enable(); else hints.disable();
    if (blockMode === "off" && mode !== "IDLE") stop();
  }

  // ---- entry points ---------------------------------------------------------------
  document.addEventListener("contextmenu", e => { lastContextTarget = e.target; }, true);

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    const offMsg = () => toast("區塊索引已關閉（可在設定改成「點了才選」或「自動標出」）");
    if (msg?.type === "PICK_START") start();
    else if (msg?.type === "CLIP_CONTEXT") {
      if (blockMode === "off") offMsg();
      else if (lastContextTarget && !isOurs(lastContextTarget)) confirmElement(nearestBlock(lastContextTarget));
      else start();
    } else if (msg?.type === "CLIP_SELECTION") { blockMode === "off" ? offMsg() : confirmSelection(msg.text); }
    else if (msg?.type === "CLIP_IMAGE") {
      if (blockMode === "off") offMsg();
      else {
        let el = lastContextTarget && isVisual(lastContextTarget) ? lastContextTarget : null;
        if (!el && msg.srcUrl) el = [...document.images].find(i => (i.currentSrc || i.src) === msg.srcUrl) || null;
        el ? confirmElement(el, { forceImage: true }) : toast("找不到這張圖片");
      }
    } else return false;
    sendResponse({ ok: true });
    return false;
  });

  chrome.storage.local.get("settings").then(s => applyMode(s.settings?.blockMode));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) applyMode(changes.settings.newValue?.blockMode);
  });

  window.__semhistPicker = {
    start, stop, confirmElement, confirmSelection, nearestBlock, textFragment, cssPath, hashText, isVisual, hints,
    autoIndexImages, autoImageCandidates, pickAt,
    get mode() { return mode; }, get current() { return current; }, get blockMode() { return blockMode; },
  };
})();

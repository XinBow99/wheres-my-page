// Service worker: routes messages to the offscreen document (which owns the model
// and the index), applies the denylist, and powers the omnibox ("ss" + query).

import { getSettings } from "./shared.js";

const OFFSCREEN_URL = "offscreen.html";
let creating = null;

async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (ctx.length) return;
  creating ??= chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["WORKERS"],
    justification: "Run the on-device EmbeddingGemma model (WebGPU) and the local vector index for semantic history search.",
  }).finally(() => { creating = null; });
  await creating;
}

async function toOffscreen(msg) {
  await ensureOffscreen();
  const { model, tagMinScore } = await getSettings();
  for (let i = 0; ; i++) {
    try {
      return await chrome.runtime.sendMessage({ model, tagMinScore, ...msg, target: "offscreen" });
    } catch (e) {
      if (i >= 4 || !/Receiving end does not exist/i.test(String(e?.message))) throw e;
      await new Promise(r => setTimeout(r, 150 * (i + 1)));
    }
  }
}

// ---- denylist ----------------------------------------------------------------
function globToRegex(g) {
  return new RegExp("^" + g.trim().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i");
}
export function isDenied(url, denylist) {
  let u;
  try { u = new URL(url); } catch { return true; }
  if (!/^https?:$/.test(u.protocol)) return true;
  const target = u.hostname + u.pathname;
  return denylist.split("\n").map(s => s.trim()).filter(Boolean).some(pat => {
    const re = globToRegex(pat);
    return re.test(u.hostname) || re.test(target);
  });
}

// ---- messages ------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === "offscreen") return false;
  (async () => {
    const settings = await getSettings();
    switch (msg?.type) {
      case "INDEX": {
        if (!settings.enabled) return { ok: true, skipped: "disabled" };
        if (sender.tab?.incognito) return { ok: true, skipped: "incognito" };
        if (isDenied(msg.url, settings.denylist)) return { ok: true, skipped: "denylist" };
        const r = await toOffscreen({ type: "INDEX", url: msg.url, title: msg.title, text: msg.text });
        if (r?.ok && r.chunks && sender.tab?.id != null) {
          chrome.action.setBadgeText({ tabId: sender.tab.id, text: "✓" });
          chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: "#1f8a5b" });
        }
        return r;
      }
      case "IMPORT_HISTORY": {
        const items = await chrome.history.search({ text: "", startTime: Date.now() - (msg.days || 30) * 86400000, maxResults: msg.max || 3000 });
        const clean = items
          .filter(i => i.title && i.title.length >= 4 && !isDenied(i.url, settings.denylist))
          .map(i => ({ url: i.url, title: i.title, lastVisitTime: i.lastVisitTime }));
        return toOffscreen({ type: "IMPORT_HISTORY", items: clean });
      }
      case "SEARCH": case "STATUS": case "LOAD": case "DELETE": case "DELETE_DOMAIN": case "CLEAR": case "DOMAINS":
      case "CATEGORIES": case "CAT_PUT": case "CAT_DELETE": case "TAG_SET": case "SCORE_PAGE":
        return toOffscreen(msg);
      case "CLIP": {
        if (sender.tab?.incognito) return { ok: false, error: "無痕視窗不索引" };
        return toOffscreen({ type: "CLIP", ...msg });
      }
      case "IMAGE": {
        if (sender.tab?.incognito) return { ok: false, error: "無痕視窗不索引" };
        if (msg.auto) {   // automatic pass: same rules as page indexing, never screenshots
          if (!settings.enabled || !settings.autoImages) return { ok: true, skipped: "disabled" };
          if (isDenied(msg.parentUrl, settings.denylist)) return { ok: true, skipped: "denylist" };
          return toOffscreen({ ...msg, type: "IMAGE", rect: null, shot: null });
        }
        let shot = null;
        if (msg.rect && sender.tab?.windowId != null) {
          try { shot = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" }); }
          catch (e) { if (!msg.srcUrl) return { ok: false, error: "無法擷取畫面：" + (e?.message ?? e) }; }
        }
        return toOffscreen({ ...msg, type: "IMAGE", shot });
      }
      case "PAGE_INFO": {
        if (!settings.enabled) return { ok: true, disabled: true };
        if (sender.tab?.incognito) return { ok: true, denied: true, reason: "incognito" };
        if (isDenied(msg.url, settings.denylist)) return { ok: true, denied: true, reason: "denylist" };
        return toOffscreen({ type: "PAGE_INFO", url: msg.url });
      }
      case "OPEN_SEARCH":
        await openSearch(msg.q || "");
        return { ok: true };
      case "IS_DENIED":
        return { ok: true, denied: !settings.enabled || isDenied(msg.url, settings.denylist) };
      default:
        return { ok: false, error: "unknown message" };
    }
  })().then(sendResponse, e => sendResponse({ ok: false, error: String(e?.message ?? e) }));
  return true;
});

// ---- commands -------------------------------------------------------------------
async function openSearch(q = "") {
  const url = chrome.runtime.getURL("search.html") + (q ? "?q=" + encodeURIComponent(q) : "");
  await chrome.tabs.create({ url });
}

chrome.commands.onCommand.addListener(async cmd => {
  if (cmd === "open-search") return openSearch();
  if (cmd === "pick-block") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id != null) chrome.tabs.sendMessage(tab.id, { type: "PICK_START" }).catch(() => {});
    return;
  }
  if (cmd === "index-page") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id != null) chrome.tabs.sendMessage(tab.id, { type: "INDEX_NOW" }).catch(() => {});
  }
});

// ---- context menu: right-click a block or a selection ---------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "semhist-clip-element", title: "語意回憶：索引這個區塊", contexts: ["page", "link"] });
    chrome.contextMenus.create({ id: "semhist-clip-selection", title: "語意回憶：索引選取的文字", contexts: ["selection"] });
    chrome.contextMenus.create({ id: "semhist-clip-image", title: "語意回憶：索引這張圖片", contexts: ["image"] });
    chrome.contextMenus.create({ id: "semhist-pick", title: "語意回憶：選取區塊…", contexts: ["page", "link", "image", "selection"] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (tab?.id == null) return;
  const msg = info.menuItemId === "semhist-clip-selection" ? { type: "CLIP_SELECTION", text: info.selectionText }
            : info.menuItemId === "semhist-clip-image" ? { type: "CLIP_IMAGE", srcUrl: info.srcUrl }
            : info.menuItemId === "semhist-clip-element" ? { type: "CLIP_CONTEXT" }
            : { type: "PICK_START" };
  chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
});

// ---- omnibox: type "ss" + space + query in the address bar ----------------------
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
let omniTimer = null;

chrome.omnibox.setDefaultSuggestion({ description: "語意搜尋你讀過的網頁：<match>%s</match>（Enter 開啟完整結果）" });

chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  clearTimeout(omniTimer);
  if (text.trim().length < 2) return;
  omniTimer = setTimeout(async () => {
    const r = await toOffscreen({ type: "SEARCH", query: text.trim(), k: 6 }).catch(() => null);
    if (!r?.ok) return;
    suggest(r.results.map(x => ({
      content: x.url,
      description: `${esc(x.title || x.url)} <dim>— ${esc(x.domain)}</dim> <url>${esc(x.url)}</url>`,
    })));
  }, 250);
});

chrome.omnibox.onInputEntered.addListener((text, disposition) => {
  if (/^https?:\/\//.test(text)) {
    if (disposition === "currentTab") chrome.tabs.update({ url: text });
    else chrome.tabs.create({ url: text, active: disposition === "newForegroundTab" });
  } else {
    openSearch(text);
  }
});

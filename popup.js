import { getSettings } from "./shared.js";

const $ = id => document.getElementById(id);
const send = msg => chrome.runtime.sendMessage(msg);

function openSearch(q = "") {
  chrome.tabs.create({ url: chrome.runtime.getURL("search.html") + (q ? "?q=" + encodeURIComponent(q) : "") });
  window.close();
}

$("f").onsubmit = e => { e.preventDefault(); openSearch($("q").value.trim()); };
$("openBtn").onclick = () => openSearch();

(async () => {
  const settings = await getSettings();
  $("enabled").checked = settings.enabled;
  $("autoImages").checked = !!settings.autoImages;
  $("autoImages").onchange = async () => {
    const { settings: cur = {} } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...settings, ...cur, autoImages: $("autoImages").checked } });
  };
  $("enabled").onchange = async () => {
    const { settings: cur = {} } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...settings, ...cur, enabled: $("enabled").checked } });
  };

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const denied = tab?.url ? await send({ type: "IS_DENIED", url: tab.url }).catch(() => null) : null;
  if (!tab?.url || !/^https?:/.test(tab.url)) {
    $("pageState").textContent = "這個頁面無法索引"; $("indexBtn").disabled = true;
  } else if (denied?.denied) {
    $("pageState").textContent = "此網站在排除清單或已停用"; $("indexBtn").disabled = true;
  } else {
    $("pageState").textContent = "停留一陣子會自動索引";
  }

  $("blockMode").value = settings.blockMode || "manual";
  $("blockMode").onchange = async () => {
    const { settings: cur = {} } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...settings, ...cur, blockMode: $("blockMode").value } });
    $("pickBtn").disabled = $("blockMode").value === "off";
  };
  $("pickBtn").disabled = !tab?.url || !/^https?:/.test(tab.url) || settings.blockMode === "off";
  $("pickBtn").onclick = async () => {
    await chrome.tabs.sendMessage(tab.id, { type: "PICK_START" }).catch(() => {});
    window.close();
  };

  $("indexBtn").onclick = async () => {
    $("indexBtn").disabled = true;
    $("pageState").textContent = "索引中…";
    const r = await chrome.tabs.sendMessage(tab.id, { type: "INDEX_NOW" }).catch(e => ({ ok: false, error: "請重新整理頁面後再試" }));
    if (r?.ok && r.chunks) { $("pageState").textContent = `✓ 已索引（${r.chunks} 段）`; $("pageState").className = "ok"; }
    else if (r?.skipped === "unchanged") { $("pageState").textContent = "✓ 已在索引中（內容沒變）"; $("pageState").className = "ok"; }
    else if (r?.skipped) {
      const why = { denylist: "此網站在排除清單", incognito: "無痕視窗不索引", disabled: "自動索引已關閉",
                    "no-content": "頁面文字太少", "secret-input": "頁面上有密碼欄位", empty: "頁面沒有可索引的文字" }[r.skipped] || r.skipped;
      $("pageState").textContent = "略過：" + why;
    }
    else { $("pageState").textContent = (r?.reason === "no-content" ? "頁面文字太少" : "錯誤：" + (r?.error || "未知")); $("pageState").className = "err"; }
    $("indexBtn").disabled = false;
  };

  const s = await send({ type: "STATUS" }).catch(() => null);
  $("stats").textContent = s?.ok
    ? `已索引 ${s.pages} 頁 · ${s.clips} 個片段 · ${s.images} 張圖片 · ${s.historyTitles} 筆紀錄標題 · ${s.mb} MB` + (s.error ? `（錯誤：${s.error}）` : "")
    : "狀態未知";
})();

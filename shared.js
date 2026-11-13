// Shared constants and settings (ES module). content.js keeps its own copy of the
// few settings it needs because content scripts cannot import modules.

export const MODELS = {
  eg2_270m: {
    label: "EmbeddingGemma-2 Text 270M（推薦）",
    url: "https://huggingface.co/litert-community/embeddinggemma-2-text-270m-litert-lm/resolve/main/embeddinggemma-2-text-270m.litertlm",
  },
  eg2_440m: {
    label: "EmbeddingGemma-2 Text-Vision 440M",
    url: "https://huggingface.co/litert-community/embeddinggemma-2-text-vision-440m-litert-lm/resolve/main/embeddinggemma-2-text-vision-440m.litertlm",
  },
};

// Images can only be embedded by the text-vision model; the image index always uses it.
export const VISION_MODEL = "eg2_440m";

// Matryoshka: EmbeddingGemma-2 vectors can be truncated and re-normalised.
// 256 dims keeps ~20k chunks around 20 MB in memory.
export const DIM = 256;

// EmbeddingGemma task prompts (asymmetric retrieval). Tune here if results look off.
export const PROMPT = {
  // Titles/queries are clipped so prompt + chunk always fits the 512-token signature.
  query: q => `task: search result | query: ${String(q).slice(0, 200)}`,
  doc: (title, text) => `title: ${String(title || "none").slice(0, 60)} | text: ${text}`,
  // A category plays the "query" side when matched against page documents.
  category: (name, description) => `task: search result | query: ${String(name).slice(0, 40)}${description ? "：" + String(description).slice(0, 200) : ""}`,
};

// 預設分類（可在搜尋頁修改、刪除）。description 越具體，自動分類越準。
export const PRESET_CATEGORIES = [
  { id: "ai",      name: "AI／機器學習", color: "#7c4dff", description: "大型語言模型、深度學習、模型訓練與推論、論文、Hugging Face 模型卡、prompt" },
  { id: "gpu",     name: "GPU／CUDA",   color: "#2e7d32", description: "CUDA kernel、GPU 記憶體、TensorRT、vLLM、驅動與編譯問題、推論效能優化" },
  { id: "speech",  name: "語音 ASR／TTS", color: "#00838f", description: "語音辨識、語音合成、字幕、音訊處理、Whisper、Azure Speech" },
  { id: "debug",   name: "除錯／解法",   color: "#d84315", description: "GitHub issue、Stack Overflow、錯誤訊息、例外、bug 回報與解決方法" },
  { id: "docs",    name: "文件／教學",   color: "#1565c0", description: "官方文件、API reference、安裝設定、教學文章、範例程式碼" },
  { id: "devops",  name: "部署／雲端",   color: "#5d4037", description: "Docker、Kubernetes、AWS、Azure、CI/CD、伺服器與網路設定" },
  { id: "finance", name: "投資理財",     color: "#c62828", description: "台股、美股、ETF、財經新聞、財報、總體經濟" },
  { id: "news",    name: "新聞時事",     color: "#455a64", description: "新聞報導、社會議題、國際局勢、政治" },
  { id: "life",    name: "生活旅遊",     color: "#ef6c00", description: "旅遊攻略、景點、餐廳美食、購物、日常生活" },
];

export const DEFAULT_DENYLIST = [
  "mail.google.com", "outlook.live.com", "outlook.office.com", "accounts.google.com",
  "login.microsoftonline.com", "web.whatsapp.com", "messenger.com", "web.telegram.org",
  "*bank*", "*.gov.tw/login*", "localhost", "127.0.0.1",
].join("\n");

export const DEFAULTS = {
  enabled: true,
  minDwellSec: 20,          // 頁面可見累計多少秒才索引
  denylist: DEFAULT_DENYLIST,
  model: "eg2_270m",
  showBadge: true,          // 在網頁右下角顯示索引狀態圖示
  badgeHiddenDomains: [],   // 這些網域不顯示圖示（仍會索引）
  tagMinScore: 0.2,         // 自動分類的最低相似度（越高越保守）
  autoImages: false,        // 自動索引頁面時，一併索引內文裡的圖片（只用原圖，不截圖）
  searchMinSim: 0,          // 搜尋結果：文字相似度門檻（0 = 全部顯示）
  imageMinSim: 0,           // 搜尋結果：圖片相似度門檻
  blockMode: "manual",      // 區塊索引："off" 關閉 | "manual" 點了才選 | "hints" 自動標出可索引區塊
};

export async function getSettings() {
  const s = await chrome.storage.local.get("settings");
  return { ...DEFAULTS, ...(s.settings || {}) };
}

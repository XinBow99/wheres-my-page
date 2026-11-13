# Spec: Where's My Page? — v0.5.0 PoC → 正式架構重構

Status: **已確認**（2026-11-13）。決策見文末「決策紀錄」。

## 我的假設（有錯請現在指正）

1. **只支援桌面版 Chrome**，`minimum_chrome_version` 維持 **116**（`chrome.sidePanel.open()` 需要 116+）。
2. **功能等價重構**：README v0.5.0 列出的功能全部保留、行為不變，唯一新增的是 Side Panel。其他新功能不在這次範圍內。
3. **既有使用者資料必須保留**：IndexedDB 名稱 `semhist`／`semhist-img`、schema v2、Cache 名稱 `semhist-models-v1` 不改。如需改 schema，只能做相容的遷移（`DB_VERSION` 遞增 + `onupgradeneeded`）。
4. **UI 不用框架**：vanilla TypeScript + 一個小型 DOM helper。理由：popup 要秒開、bundle 要小、目前的 UI 複雜度不需要 React。
5. **UI 文字維持繁體中文**，但從程式碼中抽出集中管理（見 Open Questions：是否改用 `chrome.i18n`）。
6. **識別字、JSDoc、commit message 用英文**；使用者看得到的字串和專案文件用繁體中文。

---

## Objective

**是什麼**：Chrome MV3 擴充功能。在本機用 EmbeddingGemma-2（MediaPipe + WebGPU）索引使用者讀過的網頁，資料存在 IndexedDB，用自然語言做語意搜尋。網頁內容和向量都不會上傳。

**為什麼要重構**：PoC 已經證明可行，但目前的程式碼：
- 程式碼在不同執行環境之間手動複製（`canonicalUrl`、`hashText` 在 `content.js`／`picker.js` 各有一份並註解「必須一致」；設定預設值在 `content.js` 另有一份；`esc()` 有 4 份）
- 訊息是沒有型別的字串（約 25 種），沒有驗證、沒有錯誤碼；重試是用 regex 比對 `"Receiving end does not exist"`
- 錯誤被吞掉（`.catch(() => {})`、空的 `catch {}`），使用者看不到原因
- UI 用 `innerHTML` 樣板加手動跳脫字元；分類 chip 是 `<span>` 加 click handler，無法用鍵盤操作；結果與狀態沒有 `aria-live`
- README 提到的 jsdom／fake-indexeddb 測試不在 repo 裡

**使用者**：開發者／重度閱讀者，需要找回「上週看過的那篇」。

**成功的樣子**：見下方 Success Criteria。

---

## Tech Stack

| 項目 | 選擇 | 版本 |
|---|---|---|
| 語言 | TypeScript（`strict`） | 5.x（Slice 0 鎖定確切版本） |
| 風格 | Google TypeScript Style Guide，以 `gts` 強制 | 7.0.0 |
| 打包 | esbuild（多 entry；content script 輸出 IIFE，其餘輸出 ESM） | Slice 0 鎖定 |
| 推論 | `@mediapipe/tasks-retrieval`（`UniversalEmbedder`、WebGPU delegate） | **1.2.3**（已確認 PoC 內的 `lib/`、`wasm/` 與 npm 套件逐位元組相同） |
| 模型 | EmbeddingGemma-2 Text 270M／Text-Vision 440M（LiteRT，執行期從 Hugging Face 下載，存 Cache API） | — |
| Chrome 型別 | `@types/chrome` | Slice 0 鎖定 |
| 測試 | Vitest + `@vitest/coverage-v8`；`fake-indexeddb`（storage）；`happy-dom` 或 `jsdom`（content 擷取邏輯） | Slice 0 鎖定 |
| 架構檢查 | dependency-cruiser | Slice 0 鎖定 |

所有相依版本固定（不用 `^`），以 `package-lock.json` 為準，安裝一律用 `npm ci`。

---

## Commands

```bash
npm ci                         # 安裝（含 MediaPipe runtime）
npm run build                  # esbuild → dist/（含 manifest、html、icons、MediaPipe wasm）
npm run dev                    # watch 模式重新建置 dist/
npm test                       # vitest run
npm run check:fast             # tsc --noEmit && gts lint                       （每次編輯，< 5 秒）
npm run check:task             # check:fast + vitest --coverage + depcruise
                               #   + floor-guard + build + verify-dist         （任務結束，< 90 秒）
npm run fix                    # gts fix（自動修正格式）
```

載入：`chrome://extensions` →「開發人員模式」→「載入未封裝項目」→ 選 **`dist/`**（不是 repo 根目錄）。

---

## Project Structure

檔名用 `snake_case.ts`（Google style）。測試與原始碼放在同一目錄，命名 `*_test.ts`。

```
wheres-my-page/
├─ public/                         原樣複製到 dist/
│  ├─ manifest.json
│  └─ icons/
├─ src/
│  ├─ shared/                      跨執行環境共用；只能 import shared 自己
│  │  ├─ types.ts                  領域型別：Page、Chunk、SearchResult、Category、Tag…
│  │  ├─ constants.ts              DIM、MODELS、PROMPT 樣板、預設分類、DB／Cache 名稱
│  │  ├─ settings.ts               Settings 型別、DEFAULTS、驗證（純函式）
│  │  ├─ url.ts                    canonicalUrl、domainOf（純函式，取代 2 份複本）
│  │  ├─ hash.ts                   hashText（FNV-1a，取代 2 份複本）
│  │  ├─ errors.ts                 ErrorCode、AppError、Result<T>
│  │  ├─ strings.ts                所有 UI 文字（zh-Hant）
│  │  ├─ messaging/                ★ 通訊契約（見下方）
│  │  │  ├─ contract.ts            每種訊息的 request／response 型別對照表
│  │  │  ├─ validate.ts            執行期驗證（收到訊息時）
│  │  │  ├─ client.ts              send()：timeout、重試、錯誤正規化
│  │  │  ├─ router.ts              createRouter(handlers)：給 onMessage 用
│  │  │  └─ progress.ts            Port 串流：模型下載、匯入、索引進度
│  │  └─ platform/                 薄薄一層 chrome.* 包裝
│  │     ├─ settings_store.ts      chrome.storage.local：get／update(patch)／onChange
│  │     └─ logger.ts
│  ├─ core/                        純領域邏輯：不碰 chrome／DOM／indexedDB／fetch
│  │  ├─ text/                     tokens.ts（估計 token）、preprocess.ts（中文清理）、chunk.ts
│  │  ├─ search/                   vector_math.ts（normalize／dot／cosine／toDim）、query_terms.ts、ranking.ts（混合排序）
│  │  ├─ tagging/                  pick_tags.ts、prototypes.ts
│  │  ├─ policy/                   denylist.ts（glob 比對、isDenied）
│  │  └─ dwell/                    state_machine.ts（content 的停留狀態機，原 transition()）
│  ├─ storage/                     IndexedDB 資料層（只在 offscreen 執行）
│  │  ├─ db.ts                     open、schema、遷移（v1→v2 既有邏輯）、meta（取代 localStorage）
│  │  └─ vector_index.ts           記憶體矩陣 + 持久化（原 VectorIndex，拆出純計算到 core）
│  ├─ offscreen/                   模型宿主：WebGPU 推論 + 索引服務
│  │  ├─ offscreen.html
│  │  ├─ main.ts                   entry：註冊 router
│  │  ├─ embedder.ts               UniversalEmbedder 生命週期、模型快取、縮短重試
│  │  ├─ job_queue.ts              序列化所有工作
│  │  └─ services/                 index_service、search_service、image_service、category_service、history_import
│  ├─ background/                  Service Worker
│  │  ├─ main.ts                   entry：所有 listener 在頂層同步註冊
│  │  ├─ offscreen_host.ts         ensureOffscreen()
│  │  ├─ router.ts                 訊息路由 + 政策檢查（排除清單、無痕）
│  │  ├─ commands.ts、context_menus.ts、omnibox.ts、side_panel.ts、history.ts
│  ├─ content/                     內容腳本（打包成單一 IIFE）
│  │  ├─ main.ts
│  │  ├─ extractor.ts              文字擷取、顯示中的密碼欄位偵測
│  │  ├─ dwell_controller.ts       狀態機的副作用（計時、送出、SPA 換頁）
│  │  ├─ badge/                    右下角狀態圓點（shadow DOM）
│  │  └─ picker/                   區塊選取、自動標示、自動圖片
│  └─ ui/
│     ├─ components/               dom.ts（h() helper）、result_card、category_chips、status_banner、threshold_slider
│     ├─ styles/                   tokens.css（顏色、間距、深色模式）、base.css
│     ├─ search_app/               搜尋 App 本體，Side Panel 與完整分頁共用
│     ├─ sidepanel/                sidepanel.html + main.ts（窄版，320px 起）
│     ├─ search/                   search.html + main.ts（寬版 + 設定 + 分類管理）
│     └─ popup/                    popup.html + main.ts（狀態 + 快速動作）
├─ scripts/
│  ├─ build.mjs                    esbuild 設定 + 複製 public/、MediaPipe wasm
│  ├─ verify-dist.mjs              檢查 manifest 引用的檔案都存在、輸出大小
│  └─ floor-guard.mjs              CONSTRAINTS.md 的 Floor 檢查
├─ CONSTRAINTS.md、SPEC.md、README.md、CLAUDE.md
└─ dist/                           （gitignored）
```

模組依賴方向：見 `CONSTRAINTS.md`「模組依賴規則」，由 dependency-cruiser 強制。

### 與你指定目錄的差異
你指定了 `background`、`offscreen`、`content`、`storage`、`ui`、`shared`。我**多加了 `src/core/`**：存放不依賴任何瀏覽器 API 的純演算法（切塊、token 估計、cosine、排序、分類規則、排除清單、狀態機）。分開的理由：
- `shared/` 放的是「跨環境的契約與小工具」，`core/` 放的是「領域演算法」。混在一起的話，`shared/` 會變成什麼都往裡丟的雜物間。
- `core/` 可以用 ESLint 禁止使用 `chrome`、`document`、`indexedDB`，保證能在 Node 中單元測試。要你補齊單元測試的那幾項，幾乎全部住在這裡。

---

## 執行環境與 MV3 生命週期

| 環境 | 能用的 API | 職責 | 不做的事 |
|---|---|---|---|
| **Service Worker**（`background/`） | 全部 `chrome.*`；閒置約 30 秒會被終止 | 路由、政策檢查、指令、右鍵選單、omnibox、Side Panel、`chrome.history`、`captureVisibleTab`、管理 offscreen 生命週期 | 不持有模型、不存索引、不依賴全域變數的狀態 |
| **Offscreen Document**（`offscreen/`） | **只有 `chrome.runtime`**；DOM、WebGPU、IndexedDB、Cache API | 載入模型、embedding、向量索引、IndexedDB 讀寫 | 不讀 `chrome.storage`（無法使用），設定由 SW 隨訊息帶入或推送 |
| **Content Script**（`content/`） | `chrome.runtime`、`chrome.storage`；isolated world | 停留計時、擷取文字、狀態圓點、區塊選取 | 不能 import ES module，因此打包成 IIFE |
| **UI 頁面**（`ui/`） | 全部 `chrome.*` | Side Panel、Popup、完整搜尋頁 | 不直接碰 IndexedDB（索引歸 offscreen 所有） |

### 官方文件查證（Source-driven，2026-11-13 查閱）

入口：[Chrome 擴充功能開發文件](https://developer.chrome.com/docs/extensions/develop?hl=zh-tw)

| # | 官方文件怎麼說 | 對本專案的決策 |
|---|---|---|
| 1 | [Offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen)：「runtime API is the only extensions API supported by offscreen documents」；一個擴充功能同時只能有一個；除了 `AUDIO_PLAYBACK` 之外沒有存活時間限制。Reason 列表裡**沒有 WebGPU 專用項目**。 | 維持 `WORKERS`，並把 justification 寫清楚（WebGPU 推論）。`localStorage` 搬到 IndexedDB `meta` 之後，就不需要 `LOCAL_STORAGE`。設定由 SW 推送給 offscreen（offscreen 讀不到 `chrome.storage`）。 |
| 2 | [What's new](https://developer.chrome.com/docs/extensions/whats-new) / [WebGPU in Chrome 124](https://developer.chrome.com/blog/new-in-webgpu-124)：Chrome 124 起，extension service worker 可以用 WebGPU。[SW 生命週期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)：閒置 30 秒會被終止，單一請求超過 5 分鐘也會終止；「Any global variables you set will be lost」。 | **維持 offscreen 作為模型宿主**。放在 SW 的話，每次被終止都要重新載入 270M 模型；第一次下載加上 `importHistory` 很容易超過 5 分鐘上限。 |
| 3 | [SW 事件](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/events)：listener 必須「at the top level of the script and not be nested inside functions」。 | `background/main.ts` 在頂層同步註冊所有 listener；在 `await` 之後或函式內部註冊 listener，屬於 code review 必擋項目。 |
| 4 | [Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)：用 JSON 序列化，`undefined` 會變成 `null`，上限 64 MiB；「From Chrome 148, you can return a promise」，但仍在逐步推出，`return true` 在所有版本都有效。`Port.onDisconnect`「may fire more than once」。 | 契約型別必須能 JSON 序列化（不能有 `Float32Array`、`Map`、`Date`、`undefined`），用型別層級的 `JsonValue` 約束來保證。router 一律用 `return true` + `sendResponse`（最低版本 116）。Port 的斷線處理必須冪等。 |
| 5 | [Stay secure](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure)：「Assume that messages from a content script might have been crafted by an attacker」；「Do not allow content scripts to trigger requests to arbitrary URLs」；避免 `innerHTML`；權限最小化。 | router 依 `sender` 分級（見下方契約）。UI 改用 DOM API。**PoC 的圖片索引會讓 content script 傳來的 `srcUrl` 被 offscreen 帶 cookie fetch**，違反這條（見 Open Question 6）。 |
| 6 | [Side Panel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)：需要 `sidePanel` 權限與 `side_panel.default_path`；`open()` 在 Chrome 116 加入，「may only be called in response to a user action」（action 點擊、快捷鍵、右鍵選單、擴充頁面或 content script 中的使用者手勢）。文件**沒有說明** `openPanelOnActionClick` 與 `default_popup` 同時存在時的行為。 | 不依賴未記載的行為：保留 popup，用 popup 按鈕、快捷鍵、右鍵選單呼叫 `sidePanel.open({windowId})`。要在真實 Chrome 驗證 popup 按鈕觸發的 `open()` 算不算使用者手勢。 |
| 7 | [Commands](https://developer.chrome.com/docs/extensions/reference/api/commands)：「at most four suggested keyboard shortcuts」；必須包含 `Ctrl` 或 `Alt`，不可使用 `Ctrl+Alt`。 | 目前有 3 組，加上 `open-side-panel` 正好 4 組，`Alt+Shift+*` 符合規則。 |
| 8 | Stay secure：權限最小化；CSP 只在需要 WebAssembly 時加 `'wasm-unsafe-eval'`。 | `<all_urls>` 已涵蓋 Hugging Face，移除三條多餘的 HF host 規則。`wasm-unsafe-eval` 確實需要（MediaPipe）。在 `/plan` 階段評估加上 `default-src 'self'; connect-src 'self' https://huggingface.co https://*.hf.co` 收緊 CSP，需要實測模型下載的 redirect 目的地。 |

---

## 通訊契約（Contract-first，細節在 `api-and-interface-design` 階段定稿）

**方向**：`content`／`ui` → `background` → `offscreen`。`background` → `content`（`chrome.tabs.sendMessage`）。UI 永遠不直接跟 offscreen 說話。

```ts
// src/shared/messaging/contract.ts（示意）

/** Every request/response pair crossing a context boundary. */
export interface RequestMap {
  'index.page': {req: IndexPageRequest; res: IndexPageResult};
  'search.query': {req: SearchRequest; res: SearchResponse};
  'status.get': {req: Record<string, never>; res: EngineStatus};
  // …其餘約 25 種，由現有 PoC 訊息一對一對應
}

export type MessageType = keyof RequestMap;

/** Wire envelope. `v` lets old content scripts on open tabs fail loudly. */
export interface Envelope<K extends MessageType = MessageType> {
  readonly v: 1;
  readonly target: 'background' | 'offscreen' | 'content';
  readonly type: K;
  readonly payload: RequestMap[K]['req'];
}

export type Result<T> =
  | {readonly ok: true; readonly data: T}
  | {readonly ok: false; readonly error: WireError};

export interface WireError {
  readonly code: ErrorCode;
  readonly message: string;   // 給開發者看的英文訊息
  readonly retryable: boolean;
}

export type ErrorCode =
  | 'INVALID_MESSAGE'      // 驗證失敗
  | 'NO_RECEIVER'          // offscreen／分頁尚未就緒
  | 'TIMEOUT'
  | 'WEBGPU_UNAVAILABLE'
  | 'MODEL_DOWNLOAD_FAILED'
  | 'EMBED_FAILED'
  | 'STORAGE_FAILED'
  | 'DENIED'               // 排除清單／無痕
  | 'NOT_FOUND'
  | 'INTERNAL';
```

語意規則：
- **接收端一定驗證**：`validate.ts` 對 `unknown` 收窄；不合格回 `INVALID_MESSAGE`，絕不丟進 handler。
- **依發送者分級**（官方：content script 的訊息可能是偽造的）：每種訊息在契約中宣告 `allowedFrom: 'extension-page' | 'content-script' | 'background'`。router 先確認 `sender.id === chrome.runtime.id`，再判斷來源：有 `sender.tab` 且 URL 不是擴充功能 origin 的，就是 content script。破壞性或特權操作（`index.clear`、`index.deleteDomain`、`history.import`、`category.put/delete`）**只接受 extension page**，content script 發送一律回 `DENIED`。
- **所有 payload 與回應都必須能 JSON 序列化**（官方：message passing 使用 JSON 序列化）。
- **每種訊息都有預設 timeout**（例如 `search.query` 第一次需要載入模型，與 `status.get` 不同），呼叫端可覆寫。逾時回 `TIMEOUT`，不會無限等待。
- **只有 `retryable: true` 的錯誤會自動重試**（指數退避，最多 N 次），取代現在用 regex 比對錯誤字串的做法。
- **長時間工作用 Port 回報進度**（模型下載 %、歷史匯入 n/total、圖片索引）：解決目前「搜尋中…（第一次會載入模型）」之後一片空白的問題，也取代 content script 每 200ms 輪詢的 `INDEX_NOW`。
- **設定傳遞**：offscreen 無法讀 `chrome.storage`，所以由 SW 在 `settings_store.onChange` 時推送 `settings.sync` 給 offscreen，不再在每則訊息中夾帶 `model`／`tagMinScore`。

---

## Code Style

以 `gts` 為準，下面是參考範例：

```ts
import {estimateTokens, truncateToTokens} from './tokens';

/** Token budget for one chunk body; leaves room for prompt + title within 512. */
export const CHUNK_TOKEN_BUDGET = 360;

/** Options for {@link chunkText}. */
export interface ChunkOptions {
  readonly maxTokens?: number;
  readonly overlapTokens?: number;
  readonly maxChunks?: number;
}

/**
 * Splits page text into overlapping chunks that fit the embedder's input signature.
 *
 * Chunks are sized by estimated tokens, not characters: CJK text costs about one
 * token per character, so a character budget overflows the 512-token signature.
 *
 * @param text Raw page text; control and zero-width characters are removed.
 * @return Chunks in document order, at most `maxChunks`.
 */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const {maxTokens = CHUNK_TOKEN_BUDGET, overlapTokens = 50, maxChunks = 32} = options;
  // ...
}
```

規則重點：
- **只用 named export**，不用 `export default`（Google TS）
- `const` 優先，禁止 `var`；`===`；單引號；2 空白縮排
- 類別成員用 TypeScript 的 `private`／`readonly`，不用 `#private`（Google TS）
- 命名：`lowerCamelCase` 函式／變數、`UpperCamelCase` 型別／類別、`CONSTANT_CASE` 模組層級常數
- 不用 `any`；邊界輸入一律是 `unknown`，再用型別守衛收窄
- 不用 `enum` 表示訊息型別，改用字串字面值 union（序列化友善）
- UI 與 content 不用 `innerHTML` 拼接使用者資料；用 `textContent` 或 `h()` helper 建立 DOM

---

## Testing Strategy

| 層 | 工具 | 範圍 | 覆蓋率要求 |
|---|---|---|---|
| 單元（純函式） | Vitest（Node） | `core/**`：切塊、token 估計、中文前處理、cosine／向量數學、查詢詞、混合排序、`pickTags`、排除清單、停留狀態機；`shared/**`：URL 正規化、hash、設定驗證、**訊息 schema 驗證** | 變更行 ≥ 80% |
| 整合（資料層） | Vitest + `fake-indexeddb` | `storage/**`：upsert／search／delete／domain 刪除／重開後持久化／v1→v2 遷移／分類同步 | 變更行 ≥ 80% |
| 整合（DOM） | Vitest + happy-dom | `content/extractor`、`content/dwell_controller`、badge 狀態對應 | 不設門檻 |
| 契約 | Vitest | 每種訊息：合法 payload 通過、缺欄位／型別錯誤回 `INVALID_MESSAGE`、timeout、retryable 語意 | 計入 shared |
| 效能 | `vitest bench` | `VectorIndex.search` 在 2 萬段、256 維下的耗時（ratchet 基準） | ratchet |
| 瀏覽器實測 | 真實 Chrome + DevTools | `CONSTRAINTS.md`「每個切片的手動驗收」五項 | 每個切片 |

**特性測試（characterization test）先行**：每個從 PoC 搬過來的純函式，先用 PoC 原始實作寫測試（尤其是中文切塊與 token 估計的邊界案例），再搬移與重構，確保行為沒變。

---

## Boundaries

- **一定要做**
  - 每次 commit 前通過 `npm run check:task`
  - 會碰到 WebGPU／IndexedDB／Chrome API 的切片，commit 前在真實 Chrome 走過手動驗收清單
  - 一個切片一個（或少數幾個）小 commit，Conventional Commits 格式
  - Chrome API 用法對照官方 MV3 文件，並在 PR／commit 中附上連結
- **先問再做**
  - 新增任何 npm 相依套件（包括執行期驗證函式庫）
  - 變更 IndexedDB schema、DB 名稱、Cache 名稱
  - 新增 manifest 權限或 `host_permissions`
  - 新增任何網路請求目的地
  - 修改 `CONSTRAINTS.md` 的門檻
  - 推送到 `origin`
- **絕對不做**
  - 為了通過檢查而停用 lint、型別或測試
  - 提交模型權重、`node_modules/`、`dist/`、MediaPipe wasm
  - 修改根目錄的 PoC 檔案（它們是行為參考，到期刪除）
  - 把網頁內容或向量送出本機

---

## Success Criteria

1. **功能等價**：README v0.5.0 的每項功能都能從 `dist/` 正常運作：自動索引、手動索引、區塊／片段、圖片、分類（自動／手動／原型學習）、相似度門檻、網域／時間篩選、omnibox `ss`、3 組快捷鍵、右鍵選單、歷史匯入。
2. **資料相容**：v0.5.0 建立的 IndexedDB 升級後，不需重建索引即可搜尋。
3. **PoC 檔案全部移除**，`CONSTRAINTS.md` 例外 W1 關閉。
4. **`npm run check:task` 全綠**；`src/` 中零抑制註解。
5. **契約**：每則跨環境訊息都在 `RequestMap` 中定義；不合法訊息回 `INVALID_MESSAGE`；任何請求都不會無限等待。
6. **Side Panel**：在 320px 寬度下可完整搜尋、篩選、移除結果，沒有水平捲軸。
7. **狀態回饋**：模型下載顯示百分比；WebGPU 不可用時顯示原因與可行的處理方式（`chrome://gpu`）；索引錯誤顯示錯誤碼對應的中文說明，而不是原始例外字串。
8. **無障礙（WCAG 2.1 AA）**：所有互動元件可只用鍵盤操作且有可見焦點；文字對比 ≥ 4.5:1；搜尋結果數與狀態變化透過 `aria-live` 播報；分類 chip 是 `<button aria-pressed>`。
9. **效能**：暖機後搜尋延遲不高於重構前基準（ratchet）。

---

## 重構策略（概要，細節在 `/plan`）

採用 **strangler** 方式，確保每個 commit 都能載入、能用：

0. **工具鏈**：`package.json`、tsconfig、gts、esbuild、Vitest、dependency-cruiser、floor-guard、verify-dist。第一版 build 先把 PoC 原樣複製到 `dist/`，再從 npm 補上 MediaPipe，確認 `dist/` 可以載入並正常運作，作為基準。
1. **`core/` + 特性測試**：搬移純函式，補齊單元測試。不改變執行期行為。
2. **訊息契約**：`shared/messaging` + 驗證 + 測試。
3. **`storage/` + `offscreen/`**：換成 TS 版本。
4. **`background/`**：換成 TS 版本。
5. **`content/`**：換成 TS 版本（打包成 IIFE，消除重複程式碼）。
6. **`ui/`**：共用元件、Side Panel、Popup 改版、完整搜尋頁。
7. **清理**：刪除 PoC 檔案，更新 README。

每一步都替換 manifest 中的一個 entry，舊新版本靠同一份契約溝通。

---

## 決策紀錄（2026-11-13 確認）

| # | 問題 | 決策 |
|---|---|---|
| D1 | 是否新增 `src/core/` | **採用**。純領域演算法放這裡，禁止使用瀏覽器 API。 |
| D2 | 執行期訊息驗證 | **手寫型別守衛**，不新增相依套件。每種訊息一個 `isXxxRequest(x: unknown): x is XxxRequest`，放在 `shared/messaging/validate.ts`，並用表格驅動測試覆蓋。 |
| D3 | 顯示名稱與 i18n | 改用 `chrome.i18n`，`default_locale: "zh_TW"`。`public/_locales/zh_TW/messages.json`：`name` =「Where's My Page? 語意回憶」；`public/_locales/en/messages.json`：`name` =「Where's My Page?」。**只有 manifest 字串**（name、description、commands、action title）走 `_locales`；UI 文字維持 `shared/strings.ts`（zh-Hant），完整 UI 翻譯不在這次範圍內。 |
| D4 | Popup 角色 | **只顯示狀態與快速動作**：目前頁面狀態、索引此頁、選取區塊、開啟 Side Panel、自動索引開關、模型／WebGPU 狀態。搜尋框移到 Side Panel。 |
| D5 | 完整搜尋頁 | **保留**。作為寬版搜尋，並承載設定與分類管理；與 Side Panel 共用 `ui/search_app`。 |
| D6 | 圖片原檔抓取 | **(a) 由 content script 在頁面 context 抓取**，受頁面 CORS 限制。抓不到就由 SW 以 `captureVisibleTab` 截圖裁切。圖片以 data URL（JSON 可序列化）傳給 offscreen，單張上限 8 MB。offscreen **不再 fetch 任何來自訊息的 URL**，唯一的網路請求是下載模型。 |

---

## 開發流程（參考 [AWS：How frontier teams are reinventing AI-native development](https://aws.amazon.com/tw/blogs/machine-learning/how-frontier-teams-are-reinventing-ai-native-development/)）

文章中適用於本專案的做法：

| 文章的做法 | 在本專案中的落實 |
|---|---|
| 寫 agent 用的 steering 檔：慣例、標準、測試方式、如何瀏覽程式碼 | `CLAUDE.md`（入口）→ `CONSTRAINTS.md`（標準）→ `SPEC.md`（架構與契約）。每個 `src/*` 模組放一份簡短的 `README.md`，說明職責與對外介面。 |
| 寫程式前先定義「完成」；複雜功能走 spec-driven | 本檔的 Success Criteria，以及 `/plan` 中每個任務的驗收條件。 |
| 事先把工作拆成範圍清楚的任務，維持穩定的 backlog | `tasks/plan.md` + `tasks/todo.md`；每個任務 ≤ 5 個檔案，都附上驗證指令。 |
| **Shift testing left**：讓 agent 能在本機跑完所有測試並自我修正 | `npm run check:task` 必須在 90 秒內跑完全部檢查，agent 在交回工作前自己跑過。 |
| 人工 review 從風格與命名轉向**介面定義與架構決策** | 風格完全交給 `gts`／`tsc` 自動處理。人工 review 只看：契約變更（`shared/messaging/contract.ts`）、依賴規則、IndexedDB schema、manifest 權限。這四類檔案的變更必須在 commit message 中獨立說明。 |
| 第一、二週會比較慢 | 預期 Slice 0–2（工具鏈、純函式、契約）不會產生使用者看得到的變化，這是正常的。 |

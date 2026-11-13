# Tasks: v0.5.0 PoC → 正式架構

## 進度與交接（2026-11-13）

- 分支：`refactor/architecture`
- 已完成：T1、T2、T3；另修正 build（Node 22 在含非 ASCII 字元的路徑下，`cpSync` 複製目錄會無聲崩潰）
- **已決定**：`dist/` 使用固定 extension ID `iogmdngpbdmhfphilnennjocdhclneok`（build 注入 manifest `key`，見 `docs/tasks/plan.md` 決策 6）。repo 根目錄 PoC 的舊索引不搬移，在新 ID 下重建
- **下一步：Checkpoint 0 的人工驗收**：`npm ci && npm run build`，在 `chrome://extensions` 停用從 repo 根目錄載入的舊版，以「載入未封裝項目」選擇 `dist/`，確認 ID 是 `iogmdngpbdmhfphilnennjocdhclneok`，再走過 `docs/CONSTRAINTS.md` 的手動驗收 1–4 項（第 5 項此時不適用：新 ID 下沒有舊資料）。這次建立的索引要保留，作為 T11／Checkpoint 3 的 v0.5.0 相容資料
- Checkpoint 0 通過後接著做 T4（`core/text`，第一次引入 esbuild）

計畫與決策見 `docs/tasks/plan.md`。每個任務另外還要通過 `docs/tasks/plan.md`「每個任務的共同驗證」。
Scope：XS = 1 檔、S = 1–2 檔、M = 3–5 檔。測試檔與原始碼放在同一目錄（`*_test.ts`）。

---

## Phase 0：Foundation

### T1：Build pipeline：PoC → `dist/`，MediaPipe 從 npm 取得
**說明**：建立 `package.json`（版本全部固定），加入 `@mediapipe/tasks-retrieval@1.2.3` 與 esbuild。`scripts/build.mjs` 先把 PoC 檔案、icons、manifest 原樣複製到 `dist/`，再從 `node_modules` 複製 `retrieval_bundle.mjs` → `dist/lib/`、`wasm/*` → `dist/wasm/`。`scripts/verify-dist.mjs` 檢查 manifest 引用的每個檔案都存在，並輸出各檔案大小。
**驗收**
- [x] `npm ci && npm run build` 產出 `dist/`；`node scripts/verify-dist.mjs` 結果為 exit 0（缺檔案時 exit 1、沒有 dist 時 exit 2，皆已驗證）
- [ ] 從 `dist/` 載入的擴充功能行為與 v0.5.0 相同（**待人工在 Chrome 驗證，併入 Checkpoint 0**）。build 只從 `node_modules` 讀取 MediaPipe，不依賴根目錄的 `lib/`、`wasm/`
- [x] `dist/wasm/*.wasm` 與 `dist/lib/retrieval_bundle.mjs` 的 SHA-256 與先前 vendored 版本一致
- 註：esbuild 延到第一個需要打包的任務（T4）才加入，避免安裝了卻沒用到的相依套件
**驗證**：手動驗收五項（中文頁索引 → IndexedDB → 中文查詢命中）
**依賴**：無
**檔案**：`package.json`、`package-lock.json`、`scripts/build.mjs`、`scripts/verify-dist.mjs`
**Scope**：S

### T2：型別／lint／測試工具鏈 + `shared/hash`
**說明**：`tsconfig.json`（`strict`、`noUncheckedIndexedAccess`、`types: ["chrome"]`）、`gts` + `eslint-plugin-jsdoc` 的 flat config（加上 `no-restricted-properties` 禁止 `innerHTML` 等屬性）、`vitest.config.ts`（`**/*_test.ts`、coverage v8 lcov）。用第一個真實模組 `src/shared/hash.ts`（FNV-1a，與 PoC 的輸出逐位元相同）把整條工具鏈跑通。
**驗收**
- [x] `npm run check:fast` 在乾淨程式碼上通過，在**刻意違規**時失敗：`any`、缺 JSDoc、`innerHTML`、格式錯誤各試一次（依 constraint skill 的要求，驗證檢查真的會擋）
- [x] `hashText` 對 golden 字串（中文、emoji、空字串）的輸出與 PoC 相同
- 註：TypeScript 鎖在 6.0.3（typescript-eslint 8.72 只支援 < 6.1）；gts 7.0.0 根目錄的 `eslint.config.js` 引用了不存在的檔案，因此改從套件 main（`build/src/index.js`）載入規則集
**驗證**：`npm run check:fast && npm test`
**依賴**：T1
**檔案**：`tsconfig.json`、`eslint.config.mjs`、`vitest.config.ts`、`src/shared/hash.ts`、`src/shared/hash_test.ts`
**Scope**：M

### T3：架構與 floor 檢查、`check:task`、PoC golden fixtures
**說明**：`.dependency-cruiser.cjs` 實作 `docs/CONSTRAINTS.md` 的依賴規則表；`scripts/floor-guard.mjs` 依 constraint skill 的 reference 改寫（suppression、空 catch、skip、刪除斷言、CONSTRAINTS 弱化）；`check:task` script 加上 lcov 與 diff 交集的變更行覆蓋率檢查。`scripts/gen-golden.mjs` 用 PoC 的 `chunk.js`／`store.js` + fake-indexeddb 產生 `test/fixtures/poc/*.json`（切塊、token 估計、排序、v2 DB 快照）。
**驗收**
- [x] depcruise、floor-guard、覆蓋率三項檢查，各自在一個刻意違規的範例上失敗、在乾淨的對照組上通過；檢查器本身出錯時以 exit 2 失敗
- [x] golden fixtures 已 commit，而且可以重新產生（重跑後 `git diff` 為空）
- 註：floor-guard 在任務結束時用 `--base HEAD`（pre-commit hook），review 時用 `npm run check:review`（`--base main`）。原因：對 `main` 比較時，已核准的 W1 例外會一直被列出
- 註：dwell 狀態機的 golden（原本預計在 T7）也一併在這裡產生了
**驗證**：`npm run check:task`
**依賴**：T2
**檔案**：`.dependency-cruiser.cjs`、`scripts/floor-guard.mjs`、`scripts/changed-coverage.mjs`、`scripts/gen-golden.mjs`、`test/fixtures/poc/`
**Scope**：M

### ✅ Checkpoint 0
- [ ] 每一項檢查都已證明「會擋」
- [ ] `dist/` 行為與 v0.5.0 相同
- [ ] 與你 review 工具鏈選擇後再繼續

---

## Phase 1：純核心（T4–T7 可平行）

### T4：`core/text` + shim `dist/chunk.js`
**說明**：`tokens.ts`（`estimateTokens`、`truncateToTokens`）、`preprocess.ts`（控制字元與零寬字元清理、空白正規化）、`chunk.ts`（`chunkText`）。`src/legacy/chunk_shim.ts` 以 PoC 的 export 名稱重新匯出，build 產出 `dist/chunk.js` 覆蓋 PoC 版本。
**驗收**
- [ ] golden corpus（中文長文、中英混合、emoji、超長單段、只有控制字元）的切塊結果與 PoC 逐字相同
- [ ] 不變量測試：每個 chunk 的 `estimateTokens` ≤ budget；chunk 數 ≤ `maxChunks`；相鄰 chunk 之間有重疊
- [ ] 在 shim 版本下，真實 Chrome 中的中文頁面索引成功，chunk 數與 PoC 相同
**驗證**：`npm test -- core/text`；手動驗收 2–4 項
**依賴**：T3
**檔案**：`src/core/text/{tokens,preprocess,chunk}.ts` + 測試、`src/legacy/chunk_shim.ts`、`scripts/build.mjs`
**Scope**：M

### T5：`core/search` + `core/tagging`
**說明**：`vector_math.ts`（`normalize`、`dot`、`meanVec`、`toDim`）、`query_terms.ts`、`ranking.ts`（從 `VectorIndex.search` 抽出的計分：關鍵字加分 0.08／0.05，上限 0.24；近期加分；history 扣分，所有權重都是具名常數）、`tagging/pick_tags.ts`、`tagging/prototypes.ts`（原型向量的純計算）。
**驗收**
- [ ] 每個函式的輸出與 golden 相同（浮點數比對容許 1e-6）
- [ ] 邊界情況：零向量、維度不足、空查詢、純中文查詢產生 2 字 shingle
- [ ] `ranking` 與 `pickTags` 的排序與 golden 完全一致
**驗證**：`npm test -- core/search core/tagging`
**依賴**：T3
**檔案**：`src/core/search/{vector_math,query_terms,ranking}.ts`、`src/core/tagging/{pick_tags,prototypes}.ts` + 測試
**Scope**：M

### T6：`shared` 基礎 + denylist + `settings_store` + shim `dist/shared.js`
**說明**：`shared/constants.ts`（MODELS、DIM、PROMPT、預設分類、DB／Cache 名稱）、`shared/settings.ts`（型別、DEFAULTS、`parseSettings(unknown)` 對壞值回退到預設）、`shared/url.ts`（`canonicalUrl`、`domainOf`）、`core/policy/denylist.ts`、`shared/platform/settings_store.ts`（`get`／`update(patch)`／`onChange`，取代 popup 中容易 race 的 read-modify-write）。用 shim 產出 `dist/shared.js`。
**驗收**
- [ ] denylist：glob、hostname 與路徑、非 http(s)、無效 URL 等情況的結果與 PoC 相同
- [ ] `parseSettings` 對缺欄位、型別錯誤、超出範圍的值都回傳合法設定（表格驅動測試）
- [ ] `canonicalUrl` 會移除 hash 與 utm／fbclid／gclid／ref 參數，結果與 PoC 相同
**驗證**：`npm test -- shared core/policy`；手動確認搜尋頁的設定可以儲存與讀回
**依賴**：T3
**檔案**：`src/shared/{constants,settings,url}.ts`、`src/core/policy/denylist.ts`、`src/shared/platform/settings_store.ts` + 測試、`src/legacy/shared_shim.ts`
**Scope**：M

### T7：`core/dwell` 停留狀態機
**說明**：把 PoC `content.js` 的 `transition()` 搬到 `core/dwell/state_machine.ts`，改用 discriminated union 表示 state 與 event。
**驗收**
- [ ] 窮舉測試：每個 state × 每個 event 的結果與 PoC 相同（以 golden 表格表示）
- [ ] 型別層級保證：`switch` 窮舉（`never` 檢查）
**驗證**：`npm test -- core/dwell`
**依賴**：T3
**檔案**：`src/core/dwell/state_machine.ts` + 測試
**Scope**：S

### ✅ Checkpoint 1
- [ ] `check:task` 綠；core 覆蓋率 ≥ 80%
- [ ] 以 shim 版本的 `dist/` 做中文索引與搜尋，結果與 PoC 一致

---

## Phase 2：通訊契約

### T8：`shared/errors` + `messaging/contract`
**說明**：`ErrorCode`、`AppError`、`Result<T>`、`toWireError(unknown)`。`RequestMap` 一對一涵蓋 PoC 的全部訊息：content／UI → background 約 20 種、background → offscreen、background → content 的 5 種（`INDEX_NOW`、`PICK_START`、`CLIP_*`）。每種訊息宣告 `allowedFrom` 與預設 `timeoutMs`。`JsonValue` 約束確保 payload 都能 JSON 序列化。附上 PoC 訊息名稱 → 新名稱的對照表（給 legacy adapter 使用）。
**驗收**
- [ ] 型別測試（`expectTypeOf`）：含 `Float32Array`／`Map`／`Date` 的 payload 型別編譯失敗
- [ ] PoC 的每種訊息在對照表中都有對應，沒有遺漏（測試：從 PoC 原始碼萃取出的訊息清單 ⊆ 對照表）
- [ ] 破壞性訊息的 `allowedFrom` 只包含 `extension-page`
**驗證**：`npm test -- shared/messaging shared/errors`
**依賴**：T4、T5、T6、T7
**檔案**：`src/shared/errors.ts`、`src/shared/types.ts`、`src/shared/messaging/contract.ts` + 測試
**Scope**：M

### T9：`messaging/validate`（D2：手寫型別守衛）
**說明**：每種 request 一個 `isXxxRequest(x: unknown)`，加上 `validateEnvelope`。
**驗收**
- [ ] 表格驅動測試：每種訊息至少涵蓋合法、缺欄位、型別錯誤、多餘欄位、超大字串（例如 text > 30000）、`NaN`／`Infinity`
- [ ] 錯誤的 `v`（版本）回傳 `INVALID_MESSAGE`
**驗證**：`npm test -- shared/messaging/validate`
**依賴**：T8
**檔案**：`src/shared/messaging/validate.ts` + 測試
**Scope**：S

### T10：`messaging/client`、`router`、`progress`
**說明**：`send(target, type, payload, opts)`：timeout、只對 `retryable` 錯誤做指數退避、把 `chrome.runtime.lastError` 與「沒有接收端」正規化為 `NO_RECEIVER`。`createRouter(handlers)`：驗證 → 檢查 `sender.id` → 依來源分級（`allowedFrom`）→ 呼叫 handler → 包成 `Result`，一律 `return true`。`progress.ts`：Port 串流，`onDisconnect` 處理冪等。
**驗收**
- [ ] 用 fake `chrome.runtime` 測試：逾時 → `TIMEOUT`；不可重試的錯誤不重試；可重試錯誤在 N 次後放棄
- [ ] content script 發送破壞性訊息 → `DENIED`；外部擴充功能（`sender.id` 不符）→ 拒絕
- [ ] handler 拋出例外 → `INTERNAL`，原始訊息保留在 `message`，不會吞掉
**驗證**：`npm test -- shared/messaging`
**依賴**：T9
**檔案**：`src/shared/messaging/{client,router,progress}.ts` + 測試、`test/fakes/chrome_runtime.ts`
**Scope**：M

### ✅ Checkpoint 2（人工介面 review）
- [ ] 你 review `src/shared/messaging/contract.ts` 與 `errors.ts`
- [ ] 契約確認後才開始 Phase 3

---

## Phase 3：資料層 + Offscreen

### T11：`storage/db` + `vector_index` + shim `dist/store.js` + 資料相容
**說明**：`db.ts`：開啟資料庫、v1→v2 遷移（沿用 PoC 邏輯），新增 `meta` 鍵 `textModel`，並在第一次開啟時遷移 `localStorage.semhist_model`。`vector_index.ts`：記憶體矩陣與持久化，計算改呼叫 `core`。public API 與 PoC `VectorIndex` 相容（給 shim 使用）。
**驗收**
- [ ] 用 T3 的 v0.5.0 DB 快照開啟：頁數、chunk 數、分類、標籤完全一致；對同一個查詢向量的搜尋結果與 golden 相同
- [ ] fake-indexeddb 測試：upsert（含 history 不覆蓋 page）、delete、deleteDomain、clear、關閉後重開仍保留、分類 CRUD 後重新標記、手動標籤影響原型
- [ ] `vitest bench`：2 萬段 × 256 維的搜尋耗時記錄到 `docs/CONSTRAINTS.md` 的 ratchet 表
**驗證**：`npm test -- storage`；手動：用 v0.5.0 的真實 profile 載入新 `dist/`，既有索引仍可搜尋
**依賴**：T10
**檔案**：`src/storage/{db,vector_index}.ts` + 測試、`src/legacy/store_shim.ts`、`docs/CONSTRAINTS.md`（只填入基準值）
**Scope**：M

### T12：`offscreen/embedder` + `job_queue`
**說明**：`Embedder` 介面 + MediaPipe 實作：Cache API 模型快取（`semhist-models-v1`），用 streaming fetch 回報下載進度，WebGPU 偵測 → `WEBGPU_UNAVAILABLE`，下載失敗 → `MODEL_DOWNLOAD_FAILED`（retryable）。「輸入過長時縮短 40% 重試，最多 4 次」抽成可測試的純函式。`job_queue.ts` 負責序列化。
**驗收**
- [ ] 用 fake embedder 測試：縮短重試的次數、停止條件、非相關錯誤不重試
- [ ] queue：前一個工作失敗不會卡住後續工作；工作依序執行
- [ ] 真實 Chrome（暫時以 dev-only 的測試頁呼叫）：中文句子的 embedding 是 256 維且已正規化
**驗證**：`npm test -- offscreen`；手動 embedding 驗證
**依賴**：T11
**檔案**：`src/offscreen/{embedder,job_queue}.ts` + 測試、`src/offscreen/model_cache.ts`
**Scope**：M

### T13：offscreen 文字服務 + router + legacy adapter
**說明**：`services/index_service.ts`（page、clip）、`search_service.ts`（文字 + 圖片兩個向量空間，查詢快取）、`category_service.ts`（兩個索引同步），`main.ts` 以 `createRouter` 註冊，`legacy_adapter.ts` 把 PoC background 的舊格式訊息（含夾帶的 `model`／`tagMinScore`）轉成新格式。這一步**還不切換 entry**。
**驗收**
- [ ] 服務層測試（fake embedder + fake-indexeddb）：索引、內容未變時略過、搜尋、分類增刪改後重新標記
- [ ] legacy adapter：每種舊格式訊息都有測試，轉換結果通過 validate
**驗證**：`npm test -- offscreen`
**依賴**：T12
**檔案**：`src/offscreen/services/{index_service,search_service,category_service}.ts`、`src/offscreen/main.ts`、`src/offscreen/legacy_adapter.ts` + 測試
**Scope**：M

### T14：offscreen 圖片服務 + 歷史匯入 + status；切換 entry
**說明**：`image_service.ts` **只接受 data URL**（D6；單張上限 8 MB，超過回 `INVALID_MESSAGE`），沿用縮圖與正規化流程。`history_import.ts`（匯入時回報進度）。`status`／`domains`。`dist/offscreen.html` 改用 TS bundle。
**驗收**
- [ ] 圖片服務測試：拒絕 http(s) URL；拒絕超過 8 MB；data URL 可正常處理（OffscreenCanvas 以 fake 取代）
- [ ] 真實 Chrome：右鍵 →「索引這張圖片」可以用截圖路徑完成；歷史匯入顯示 n／total
- [ ] 完整手動驗收五項通過
**驗證**：`npm test`；手動驗收
**依賴**：T13
**檔案**：`src/offscreen/services/{image_service,history_import,status_service}.ts` + 測試、`public/offscreen.html`
**Scope**：M

### ✅ Checkpoint 3
- [ ] 完整手動驗收（含 v0.5.0 舊資料）
- [ ] ratchet 基準已記錄：覆蓋率、搜尋延遲、`dist/` 大小
- [ ] 已知降級：自動圖片暫時只剩截圖（T21 修復），已寫入 commit message

---

## Phase 4：Background

### T15：SW 核心 + 切換 entry
**說明**：`main.ts` 在頂層同步註冊所有 listener；`offscreen_host.ts`（`getContexts` + 防止重複建立；reason `WORKERS`）；`settings_sync.ts`：`settings_store.onChange` 以及 offscreen 建立時推送 `settings.sync`；`router.ts`：政策檢查（排除清單、無痕）+ 依發送者分級；`legacy_inbound.ts`（接收 PoC content／popup／search）、`legacy_outbound.ts`（送給 PoC content）。拆除 `offscreen/legacy_adapter.ts`。
**驗收**
- [ ] router 測試：無痕 → `DENIED`；排除清單 → 略過；content script 發送 `index.clear` → `DENIED`
- [ ] 在 DevTools 手動停止 SW 後，下一則訊息會重新啟動 SW 並重建 offscreen，功能正常
- [ ] 完整手動驗收五項通過
**驗證**：`npm test -- background`；手動驗收
**依賴**：T14、T6
**檔案**：`src/background/{main,offscreen_host,settings_sync,router}.ts`、`src/background/legacy_{inbound,outbound}.ts` + 測試（刪除 `src/offscreen/legacy_adapter.ts`）
**Scope**：M

### T16：SW 功能
**說明**：`commands.ts`、`context_menus.ts`、`omnibox.ts`（debounce、XML 跳脫）、`history.ts`（`chrome.history` 篩選後交給 offscreen）。
**驗收**
- [ ] omnibox：標題中的 `<`、`&` 正確跳脫（測試）
- [ ] 3 組快捷鍵、4 個右鍵選單項目、`ss` omnibox 在真實 Chrome 中可用
**驗證**：`npm test -- background`；手動
**依賴**：T15
**檔案**：`src/background/{commands,context_menus,omnibox,history}.ts` + 測試
**Scope**：M

### T17：manifest：i18n、權限、CSP
**說明**：`public/_locales/{zh_TW,en}/messages.json`（D3）；manifest 改用 `__MSG_*__`，並保留 build 注入的固定 `key`（決策 6）；移除三條 Hugging Face host 規則；評估 CSP `connect-src`（實測模型下載的 redirect 目的地，可以收緊才收緊）。
**驗收**
- [ ] Chrome 語言為 zh-TW 時名稱顯示「Where's My Page? 語意回憶」，為 en 時顯示「Where's My Page?」
- [ ] 移除 host 規則後，模型仍可下載（清空 Cache 後重新下載驗證）
- [ ] CSP 的決策與實測結果寫入 `docs/SPEC.md` 的查證表
**驗證**：`npm run build && node scripts/verify-dist.mjs`；手動
**依賴**：T16
**檔案**：`public/manifest.json`、`public/_locales/zh_TW/messages.json`、`public/_locales/en/messages.json`、`docs/SPEC.md`
**Scope**：S

### ✅ Checkpoint 4
- [ ] 完整手動驗收；SW 被終止後可以復原

---

## Phase 5：Content

### T18：`content/extractor` + `dwell_controller`
**說明**：`extractor.ts`（article／main 選取、顯示中的密碼欄位偵測）；`dwell_controller.ts` 以 `core/dwell` 驅動，`INDEX_NOW` 直接 await 結果，取代 PoC 每 200ms 輪詢最多 60 秒的做法。暫時保留 `window.__semhistPicker` 介面，讓 PoC `picker.js` 繼續運作。esbuild 輸出 IIFE，取代 `dist/content.js`。
**驗收**
- [ ] happy-dom 測試：隱藏的登入彈窗不算密碼頁；文字少於 300 字 → `no-content`；SPA 換頁會重新計時
- [ ] `INDEX_NOW` 的回應與 PoC 語意相同（測試）
- [ ] 真實 Chrome：GitHub（SPA）換頁後重新計時並索引
**驗證**：`npm test -- content`；手動
**依賴**：T17、T7
**檔案**：`src/content/{main,extractor,dwell_controller}.ts` + 測試、`scripts/build.mjs`
**Scope**：M

### T19：`content/badge`
**說明**：shadow DOM 狀態圓點；view 是 `(ctx) => ViewModel` 純函式；圓點與選單都用 `<button>`，有 `aria-label`／`aria-expanded`，`Esc` 可關閉選單；不用 innerHTML 插入任何動態資料。
**驗收**
- [ ] `view()` 對每個 state 的 ViewModel 測試（文字、圖示、是否淡出）
- [ ] 鍵盤：Tab 可以聚焦圓點，Enter 開啟選單，方向鍵與 Esc 可操作
- [ ] 分類名稱含 `<img onerror>` 時以純文字顯示（測試）
**驗證**：`npm test -- content/badge`；手動
**依賴**：T18
**檔案**：`src/content/badge/{badge,view,styles}.ts` + 測試
**Scope**：M

### T20：`content/picker` + `hints`（文字片段）
**說明**：拆解 PoC `picker.js` 的文字部分：選取模式（hover、↑↓、點擊、Esc）、右鍵找最近的段落、選取文字、text fragment 編碼、hints 模式（+ → ✓）。共用 `shared/hash`、`shared/url`，消除重複程式碼。
**驗收**
- [ ] text fragment 編碼（含中文與 `-`）結果與 golden 相同
- [ ] 選取模式的 state machine 測試；點擊不會觸發網頁上的連結
- [ ] 真實 Chrome：AWS 文件頁選取一段 `<p>` 索引，搜尋結果連結會捲動到該段並反白
**驗證**：`npm test -- content/picker`；手動
**依賴**：T19
**檔案**：`src/content/picker/{picker,hints,fragment,overlay}.ts` + 測試
**Scope**：M

### T21：`content/picker` 圖片（D6）+ 自動圖片；移除 PoC picker
**說明**：`image_capture.ts`：在頁面 context fetch 原圖 → data URL（受 CORS 限制，≤ 8 MB），失敗時請 SW 截圖；`auto_images.ts`（每頁最多 8 張、≥ 200×150、排除規則）。從 build 移除 PoC `picker.js`；拆除 `background/legacy_outbound.ts`。
**驗收**
- [ ] 同源圖片：以原圖索引（`from: original`）；跨源且沒有 CORS 的圖片：退回截圖
- [ ] 自動圖片恢復運作（解除 T14 的降級）
- [ ] 整個流程中，offscreen 和 SW 都不會 fetch 來自訊息的 URL（code review + 測試）
**驗證**：`npm test -- content`；手動
**依賴**：T20
**檔案**：`src/content/picker/{image_capture,auto_images}.ts` + 測試、`scripts/build.mjs`（刪除 `src/background/legacy_outbound.ts`）
**Scope**：M

### ✅ Checkpoint 5
- [ ] 完整手動驗收；片段與圖片功能等價

---

## Phase 6：UI

### T22：UI 基礎
**說明**：`styles/tokens.css`（亮／暗兩組 token，文字對比 ≥ 4.5:1，可見焦點）、`base.css`；`components/dom.ts`（`h(tag, props, ...children)`，只用 `textContent` 設定文字）；`status_banner.ts`（`aria-live="polite"`，用來顯示模型下載進度與 WebGPU 錯誤）；`shared/strings.ts`；`ErrorCode` → 中文說明對照。
**驗收**
- [ ] `h()` 測試：字串一律成為 text node；不接受 `innerHTML` prop
- [ ] 每個 `ErrorCode` 都有對應的中文說明（型別層級窮舉）
- [ ] token 的對比數值寫在 CSS 註解中，並以測試計算驗證 ≥ 4.5
**驗證**：`npm test -- ui shared/strings`
**依賴**：T17
**檔案**：`src/ui/styles/{tokens,base}.css`、`src/ui/components/{dom,status_banner}.ts`、`src/shared/strings.ts` + 測試
**Scope**：M

### T23：`search_app` + Side Panel
**說明**：搜尋 App，窄版優先：搜尋框、結果卡片、分類 chip（`<button aria-pressed>`）、相似度門檻、時間與網域篩選、移除結果。`sidepanel.html` + manifest `side_panel` + `sidePanel` 權限 + `open-side-panel` 快捷鍵（第 4 組）+ 右鍵選單。**先實測** popup 按鈕呼叫 `sidePanel.open()` 是否可行。
**驗收**
- [ ] 320px 寬度下沒有水平捲軸；只用鍵盤可以完成搜尋 → 篩選 → 開啟結果 → 移除
- [ ] 結果數與狀態變化會被 `aria-live` 播報；第一次查詢時顯示模型下載進度
- [ ] Side Panel 可以由快捷鍵與右鍵選單開啟
**驗證**：`npm test -- ui`；手動（Chrome DevTools 模擬 320px、鍵盤操作）
**依賴**：T22
**檔案**：`src/ui/search_app/{app,results,filters,chips}.ts`、`src/ui/sidepanel/{sidepanel.html,main.ts}`、`public/manifest.json`
**Scope**：M

### T24：完整搜尋頁（D5）
**說明**：`search.html` 重用 `search_app`（寬版排版），加上設定面板（`settings_store.update`）與分類管理，以及「換模型會清空索引」的確認對話框（`<dialog>`，取代 `confirm()`）。
**驗收**
- [ ] README 中與搜尋頁相關的功能全部可用（匯入紀錄、門檻、分類 CRUD、排除清單、清空索引）
- [ ] 設定表單有 `<label>` 關聯、錯誤以 `aria-describedby` 呈現
**驗證**：`npm test -- ui`；手動
**依賴**：T23
**檔案**：`src/ui/search/{search.html,main.ts}`、`src/ui/search/{settings_panel,category_manager}.ts`
**Scope**：M

### T25：Popup 改版（D4）；移除 legacy inbound
**說明**：popup 顯示目前頁面的真實索引狀態（`page.info`，而不只是 PoC 的 `IS_DENIED`）、索引此頁、選取區塊、開啟 Side Panel、自動索引開關、模型／WebGPU 狀態（透過 Port 接收進度）。拆除 `background/legacy_inbound.ts`。
**驗收**
- [ ] popup 開啟後 200ms 內顯示內容（status 回來前先顯示骨架）
- [ ] WebGPU 不可用時顯示原因與 `chrome://gpu` 提示
- [ ] `src/` 中沒有任何 legacy 訊息處理程式碼（grep + depcruise）
**驗證**：`npm test`；手動
**依賴**：T24
**檔案**：`src/ui/popup/{popup.html,main.ts,view}.ts`（刪除 `src/background/legacy_inbound.ts`）
**Scope**：M

### ✅ Checkpoint 6
- [ ] 無障礙手動稽核：鍵盤、焦點、對比、`aria-live`、320px
- [ ] 完整手動驗收

---

## Phase 7：收尾

### T26：清理
**說明**：刪除根目錄 PoC 檔案、`src/legacy/`、`build.mjs` 中的 PoC 複製步驟；`docs/CONSTRAINTS.md` 例外 W1 關閉；README 改寫（安裝方式改為從 `dist/` 載入、新架構圖）；每個 `src/*` 新增簡短的 `README.md`（職責、對外介面、不可以做的事）。
**驗收**
- [ ] repo 根目錄沒有 `*.js` 原始碼；`check:task` 綠
- [ ] golden 測試仍然通過（不依賴 PoC 原始碼）
**驗證**：`npm run check:task`；完整手動驗收
**依賴**：T21、T25
**檔案**：PoC 檔案（刪除）、`src/legacy/`（刪除）、`README.md`、`docs/CONSTRAINTS.md`、`src/*/README.md`
**Scope**：M（大多是刪除）

### T27：Review、簡化、量測
**說明**：`/review` 與 `/code-simplify`；ratchet 比對；用 DevTools 量測搜尋延遲（暖機後）、offscreen 記憶體、content script 執行時間；逐條核對 `docs/SPEC.md` 的 Success Criteria。
**驗收**
- [ ] review 中的 Critical／Important 發現全部處理
- [ ] Success Criteria 1–9 每一條都附上證據（測試名稱、截圖或量測數字）
**驗證**：review 報告 + 量測紀錄
**依賴**：T26
**檔案**：依 review 結果而定
**Scope**：視結果而定

### ✅ Checkpoint Final
- [ ] 所有 Success Criteria 達成
- [ ] 決定推送與合併方式

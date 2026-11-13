# Implementation Plan: v0.5.0 PoC → 正式架構

依據：`docs/SPEC.md`（已確認，決策 D1–D6）、`docs/CONSTRAINTS.md`（已確認）。
任務清單與每個任務的驗收條件：`docs/tasks/todo.md`。

## Overview

把根目錄的 v0.5.0 PoC（純 JS、約 25 種無型別訊息）逐步替換成 `src/` 下分層的 TypeScript 架構（shared / core / storage / offscreen / background / content / ui），並新增 Side Panel。**每個任務完成後，`dist/` 都必須能載入並正常運作**；不做「全部寫完再一次切換」。

## Architecture Decisions（規劃層級）

1. **Strangler + legacy shim**：第一版 build 把 PoC 原樣複製到 `dist/`。之後每完成一層，就由 esbuild 產出**同名、同 export 介面**的檔案覆蓋 PoC 版本。例如 `src/legacy/chunk_shim.ts` → `dist/chunk.js`，PoC 的 `offscreen.js` 會在不知情的情況下改用新實作。這讓純函式層在搬移當下就能在真實 Chrome 中驗證，而不是等到最後才整合。shim 只放在 `src/legacy/`，在 T26 全部刪除。
2. **Legacy 訊息 adapter 只放在接收端，而且有明確的拆除時間點**：

   | adapter | 用途 | 建立 | 拆除 |
   |---|---|---|---|
   | `offscreen/legacy_adapter.ts` | 接收 PoC background 的舊格式訊息 | T13 | T15（background 改送新格式） |
   | `background/legacy_inbound.ts` | 接收 PoC content／popup／search 的舊格式訊息 | T15 | T25（最後一個 PoC sender 被替換） |
   | `background/legacy_outbound.ts` | 送舊格式訊息給 PoC content／picker | T15 | T21（picker 被替換） |
3. **Golden fixtures 取代「對照 PoC 原始碼」**：T3 寫一個腳本，用 PoC 的 `chunk.js`／`store.js`（純 ESM，可在 Node 執行）產出 golden 輸出：中文／英文／emoji 切塊結果、排序結果，以及一份由 PoC `VectorIndex` 寫入 fake-indexeddb 的 v2 資料庫快照。結果以 JSON 存到 `test/fixtures/poc/`。特性測試比對的是這些 fixture，所以 T26 刪掉 PoC 之後測試依然有效。
4. **介面先行，人工 review 集中在介面上**（AWS 文章）：Phase 2 的契約做完後設一個人工 review checkpoint，之後的實作才以這份契約為準。
5. **高風險項目提前**：資料相容（T11）排在 offscreen 服務之前；MediaPipe／WebGPU 的行為在 T12 就以真實 Chrome 驗證。
6. **固定 extension ID**（Checkpoint 0 決定）：build 在 `dist/manifest.json` 注入固定的 `key`（`scripts/extension-key.mjs`，只有 public key），ID 為 `iogmdngpbdmhfphilnennjocdhclneok`，不隨 `dist/` 的路徑或電腦改變；`verify-dist` 檢查 key 推導出的 ID。從 repo 根目錄載入的 PoC 是另一個 ID，那份舊索引不搬移，在新 ID 下重建。Checkpoint 0 用 PoC 原樣的 `dist/` 建立的索引，就是之後 T11／Checkpoint 3 驗證「v0.5.0 舊資料相容」用的真實資料。T17 把 manifest 移到 `public/` 時要保留這個 `key`。
7. **自動分類改用 `@mediapipe/tasks-decision`**（2026-11-13 決定）：PoC 以原始 cosine 搭配絕對門檻（`pickTags`：最高分 ≥ 0.2、比平均高 0.03）決定分類，但短文字套上同一個 prompt 模板後，原始 cosine 普遍落在 0.6–0.7（例：「皇宮」與「黃仁勳」為 68%），描述籠統的分類（新聞時事、生活旅遊、投資理財）又對任何頁面都有偏高的基準分（例：〈珍珠奶茶〉被標成「投資理財」）。改用 DecisionMaker 的 `evaluateChoice`：所有分類一起做 softmax（模型校準的 temperature），並以 `normalizePrior` 扣掉空輸入 `[None]` 的先驗分布。已知代價：`dist/` 多約 26 MB wasm、offscreen 同時跑兩套 runtime、270M 模型在 GPU 上載入兩份。T5 仍是 PoC 行為的原樣搬移（golden 相同）；T5b 先做實驗量測，正式整合放在 T13。

## 每個任務的共同驗證（Definition of Done）

除了各任務自己的驗收條件之外，每個任務都必須：
- [ ] `npm run check:task` 全綠（T3 之後；T1–T2 只執行當下已存在的檢查）
- [ ] `npm run build` 後以 `dist/` 載入 Chrome，SW／Offscreen console 沒有新錯誤
- [ ] 若碰到 WebGPU／IndexedDB／Chrome API：走過 `docs/CONSTRAINTS.md`「每個切片的手動驗收」五項，結果寫在 commit message
- [ ] 一個任務一個 commit（Conventional Commits）；契約、依賴規則、DB schema、manifest 權限的變更在 commit message 中獨立一段說明

## Task List（細節見 `docs/tasks/todo.md`）

### Phase 0：Foundation
- [x] T1：Build pipeline：PoC → `dist/`，MediaPipe 從 npm 取得
- [x] T2：型別／lint／測試工具鏈 + 第一個模組 `shared/hash`
- [x] T3：架構與 floor 檢查、`check:task`、PoC golden fixtures
- [ ] **Checkpoint 0**：所有檢查都已驗證「會擋」；`dist/` 行為與 v0.5.0 相同

### Phase 1：純核心（T4–T7 彼此獨立，可平行）
- [ ] T4：`core/text`（token 估計、中文前處理、切塊）+ shim `dist/chunk.js`
- [ ] T5：`core/search` + `core/tagging`（向量數學、查詢詞、混合排序、pickTags）
- [ ] T6：`shared` 常數／設定／URL + `core/policy/denylist` + `settings_store` + shim `dist/shared.js`
- [ ] T7：`core/dwell` 停留狀態機
- [ ] **Checkpoint 1**：中文頁面在 shim 版本下索引與搜尋結果與 golden 一致

### Phase 2：通訊契約
- [x] T8：`shared/errors` + `messaging/contract`（全部訊息型別、JSON 約束、`allowedFrom`）
- [x] T9：`messaging/validate`（手寫型別守衛，D2）
- [ ] T10：`messaging/client`、`router`、`progress`（timeout、重試、發送者分級、Port）
- [ ] **Checkpoint 2（人工介面 review）**：你 review `contract.ts`，確認後才進入 Phase 3

### Phase 3：資料層 + Offscreen
- [ ] T11：`storage/db` + `storage/vector_index` + shim `dist/store.js` + v0.5.0 資料相容測試
- [ ] T12：`offscreen/embedder` + `job_queue`（模型快取、縮短重試、WebGPU 偵測、下載進度）
- [ ] T13：offscreen 文字服務（index／clip／search／category）+ router + legacy adapter
- [ ] T14：offscreen 圖片服務（只接受 data URL，D6）+ 歷史匯入 + status；切換 `offscreen.html` entry
- [ ] **Checkpoint 3**：完整手動驗收；記錄 ratchet 基準（搜尋延遲、覆蓋率、dist 大小）

### Phase 4：Background
- [ ] T15：SW 核心：offscreen host、設定推送、router + 發送者政策、legacy in/outbound；切換 SW entry
- [ ] T16：SW 功能：commands、context menus、omnibox、歷史匯入
- [ ] T17：manifest：`_locales`（D3）、移除多餘 host 權限、CSP 評估
- [ ] **Checkpoint 4**

### Phase 5：Content
- [ ] T18：`content/extractor` + `dwell_controller`（IIFE bundle 取代 `content.js`）
- [ ] T19：`content/badge`（shadow DOM、無 innerHTML、鍵盤可操作）
- [ ] T20：`content/picker` + `hints`（文字片段）
- [ ] T21：`content/picker` 圖片（D6：在頁面 context 抓圖）+ 自動圖片；移除 `picker.js` 與 legacy outbound
- [ ] **Checkpoint 5**

### Phase 6：UI
- [ ] T22：UI 基礎：design tokens（亮／暗、AA 對比）、`h()` helper、status banner、`strings.ts`
- [ ] T23：`search_app` + Side Panel（manifest、快捷鍵、右鍵選單）
- [ ] T24：完整搜尋頁（寬版 + 設定 + 分類管理，D5）
- [ ] T25：Popup 改版（D4）+ 進度 Port；移除 legacy inbound
- [ ] **Checkpoint 6**：320px、純鍵盤、對比、`aria-live` 手動稽核

### Phase 7：收尾
- [ ] T26：刪除 PoC、shim、adapter；關閉 W1；更新 README 與各模組 README
- [ ] T27：`/review` + `/code-simplify`；ratchet 比對；DevTools 效能量測；逐條核對 Success Criteria
- [ ] **Checkpoint Final**

## 依賴圖

```
T1 → T2 → T3 ─┬─ T4 ─┐
              ├─ T5 ─┤
              ├─ T6 ─┼─ T8 → T9 → T10 ─┬─ T11 → T12 → T13 → T14 ─ T15 → T16 → T17
              └─ T7 ─┘                  │                          │
                                        │                          ├─ T18 → T19 → T20 → T21
                                        │                          └─ T22 → T23 → T24 → T25
                                        └──────────────────────────────────────────────── T26 → T27
```
- T11 依賴 T4、T5（chunk 與向量數學）。T18 依賴 T7。T15 依賴 T6（denylist、settings_store）。
- Phase 5 與 Phase 6 在 T17 之後可以**平行**進行，因為兩者都只依賴契約與 background。但它們都會修改 manifest，合併時要協調；建議循序進行。

## Risks and Mitigations

| 風險 | 影響 | 緩解 |
|---|---|---|
| 新的 storage 層無法讀取既有的 v0.5.0 IndexedDB，使用者索引遺失 | **高** | T11 以 PoC `VectorIndex` 產生的 DB 快照做相容測試；`DB_VERSION` 只能遞增；`localStorage` 的 `semhist_model` 鍵遷移到 `meta` 時保留舊值；Checkpoint 3 用真實的 v0.5.0 profile 實測。 |
| MediaPipe 1.2.3 在 TS 下的行為與 PoC 不同（型別定義與實際 API 不一致） | 中 | T12 直接使用套件內附的 `retrieval.d.ts`；embedder 以介面隔離，單元測試用 fake；T12 結束時在真實 Chrome 驗證中文 embedding。 |
| `chrome.sidePanel.open()` 從 popup 按鈕觸發時，不被視為使用者手勢 | 低 | T23 一開始先實測；退路是 popup 按鈕改為開啟完整搜尋頁，Side Panel 只由快捷鍵與右鍵選單開啟。 |
| T14–T21 之間自動圖片索引降級：PoC content 仍傳 `srcUrl`，但新的 offscreen 不再 fetch（D6），所以只剩截圖可用 | 低 | 自動圖片預設關閉；在 T14 的 commit message 與 README 註明；T21 恢復功能。 |
| content script bundle 太大，拖慢每個網頁的載入 | 中 | `verify-dist` 輸出 `content.js` 大小並納入 ratchet；content 不得 import `storage`／`offscreen`（depcruise 擋）。 |
| `gts` 7 與所選的 TypeScript／ESLint flat config 版本不相容 | 低 | T2 先鎖定可行的版本組合；若不相容，以 gts 的 ESLint 規則集為準，手動組合 flat config，並在 CONSTRAINTS 註明。 |
| 沒有 CI：所有檢查只在本機執行 | 中 | `check:task` 是 commit 前的必要步驟（Definition of Done）。CI 不在本次範圍內（見 Open Questions）。 |

## Parallelization

- **可平行**：T4／T5／T6／T7（純函式、互不依賴）；T17 之後的 Phase 5 與 Phase 6（需協調 manifest）。
- **必須循序**：Phase 2（契約）→ 所有實作；T11 → T12 → T13 → T14（共享 offscreen 狀態）；所有 legacy adapter 的拆除順序。

## Open Questions

1. **CI**：要不要在 Phase 0 加 GitHub Actions，在 push／PR 時跑 `check:task`？目前規劃是不加，只在本機執行。
2. **推送時機**：分支 `refactor/architecture` 要在每個 Checkpoint 推到 `origin`，還是全部完成後再推？
3. **MediaPipe 使用統計（2026-11-13 發現，待使用者決定）**：T5b 的隱私檢查先以靜態方式查過套件。`@mediapipe/tasks-retrieval@1.2.3`（PoC 與目前的 `dist/` 都在用）和 `@mediapipe/tasks-decision@1.2.3` 的 bundle 都內建同一個 logger：`UniversalEmbedder`、`SemanticRetriever`、`DecisionMaker` 一建立就無條件啟用，每 60 秒與 `close()` 時以 `fetch` POST 到 `https://odml.pa.googleapis.com/v1/log`（附套件內建的 Google API key，`credentials` 不帶 cookie）。內容是作業系統類型、套件版本、任務類型、初始化耗時與呼叫次數／延遲統計，**不含網頁文字或向量**；官方 README 的 Privacy Notice 也寫明會送出 metrics。沒有關閉的 API 選項。manifest 有 `<all_urls>` 且 CSP 沒有 `connect-src`，所以這些請求在擴充功能裡實際會送出。這不是重構新增的請求，而是 v0.5.0 就有，但與 CONSTRAINTS「除了模型權重與使用者主動索引的圖片，不得有其他網路請求」以及商店說明「網頁內容不離開你的電腦」的精神不一致。選項：
   - **A（建議）**：offscreen 啟動時包一層 `fetch`，對 `odml.pa.googleapis.com` 直接拒絕（不會真的發出請求；logger 第一次失敗後會自己停掉計時器）。改動小、可單元測試、不需要新權限。可在 T12 做，或先在 build 對 `dist/offscreen.html` 加一段前置 script，讓 PoC 階段就生效
   - B：`declarativeNetRequest` 靜態規則擋掉這個網域。需要新權限，安裝時會多一條權限警告
   - C：CSP `connect-src` 白名單。不可行：offscreen 要從任意網址抓使用者索引的圖片原檔，白名單只能開到 `https:`，擋不到這個網域
   - D：保留現狀，改為在說明與隱私權政策中揭露

# Constraints

Last reviewed: 2026-11-13 by XinBow99
Status: **已確認**（2026-11-13）。表格中的指令在 Slice 0（工具鏈）中安裝並驗證；Slice 0 完成之前，Floor 以人工 review 執行。

這份文件定義「可以合併」的最低標準。`docs/CONSTRAINTS.md` 是唯一的權威來源；`package.json` 的 scripts 只是它的包裝，兩者不一致時以本檔為準。

---

## Floor（永遠生效，不需設定）

- **不得新增抑制註解**（ESLint 已設 `noInlineConfig: true`，`eslint-disable` 註解本身不會生效，還會被當成 warning 擋下）：`@ts-ignore`、`@ts-nocheck`、`@ts-expect-error`、`eslint-disable*`、`prettier-ignore`、`istanbul ignore`、`c8 ignore`。型別或 lint 錯誤要修程式，不是關掉檢查。
- **不得吞掉錯誤**：禁止空的 `catch {}`、`.catch(() => {})`、`catch` 後只 `console.log` 然後繼續當作成功。每個錯誤要嘛往上拋，要嘛轉成契約中定義的 `ErrorCode` 回傳給呼叫端，要嘛附上註解說明為何可以安全忽略（例如「分頁已關閉，訊息無人接收是預期行為」），並以 `logger.debug` 記錄。
- **不得留下未實作的殘骸**：`throw new Error('Not implemented')`、沒有追蹤 issue 的 `TODO`、只回傳假資料的函式。
- **不得跳過或刪除測試**，除非 commit message 寫明原因。`it.skip`、`describe.skip`、`it.todo` 都算。
- **不得在原始碼中放入密鑰**（API key、token）。本專案理論上不需要任何密鑰。
- **不得混用 MV2 寫法**：`chrome.extension.getBackgroundPage`、`background.page`、`browser_action`、`webRequestBlocking`、持久背景頁、遠端程式碼（`eval`、`new Function`、從 CDN 載入 script）一律禁止。
- **不信任 content script 的訊息**（[官方 Stay secure](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure)）：每則訊息在接收端驗證 payload 與 `sender`；content script 不得觸發破壞性操作，也不得觸發對任意 URL 的請求。
- **不用 `innerHTML`／`outerHTML`／`insertAdjacentHTML`／`document.write` 插入任何動態資料**：一律用 DOM API 與 `textContent`（官方 Stay secure）。由 ESLint `no-restricted-properties` 強制。
- **Service Worker 的 listener 必須在頂層同步註冊**（[官方 SW events](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/events)），不得依賴 SW 全域變數保存狀態。
- **網頁內容與向量不得離開本機**：除了下載模型權重（Hugging Face）和使用者主動索引的圖片原檔之外，不得新增任何網路請求。新增 `fetch` 目的地需先詢問。
- **不得為了通過檢查而弱化本檔**：門檻調低、規則刪除、把檢查從 fast 移到更晚的階段，都需要獨立的 commit 和使用者同意，不得與「因此才通過」的功能變更放在同一個 commit。

## 有數字的強制門檻

| 面向 | 規則 | 檢查指令 | 執行時機 | 失敗時 |
|---|---|---|---|---|
| 型別 | `strict: true` + `noUncheckedIndexedAccess`，零錯誤；禁止 `any`（含隱式），邊界一律用 `unknown` 再收窄 | `tsc --noEmit -p .` | 每次編輯 | 阻擋 |
| 風格 | Google TypeScript Style Guide，以 Google 官方 `gts` 設定為準；零 error、零 warning | `eslint . --max-warnings 0`（`eslint.config.mjs` 載入 gts 7.0.0 規則集；`gts lint` CLI 不擋 warning，所以不用它） | 每次編輯 | 阻擋 |
| 格式 | Prettier（gts 內建設定），LF 換行 | `prettier/prettier` 規則（含於上一列的 eslint） | 每次編輯 | 阻擋 |
| 文件 | 每個 export 的函式／類別／型別都有 JSDoc；`@param`／`@return` 描述語意而非重複型別 | `eslint-plugin-jsdoc`（含於上一列的 eslint；Google 標籤名稱 `@return`／`@fileoverview`） | 每次編輯 | 阻擋 |
| 架構邊界 | 零違規（規則見下方「模組依賴規則」） | `depcruise src --config .dependency-cruiser.cjs` | 任務結束、CI | 阻擋 |
| 測試 | 全部通過 | `vitest run` | 任務結束、CI | 阻擋 |
| 覆蓋率 | 變更行數中，`src/core/**`、`src/shared/**`、`src/storage/**` 的行覆蓋率 ≥ 80% | `vitest run --coverage` + `node scripts/changed-coverage.mjs --base HEAD`（讀 lcov，與 `git diff` 交集） | 任務結束（pre-commit） | 阻擋 |
| Floor guard | 上方 Floor 的 diff 檢查 | 任務結束：`node scripts/floor-guard.mjs --base HEAD`（pre-commit，檢查這次的變更）；review：`npm run check:review`（`--base main`，W1 列在 T26 前預期會被列出） | 任務結束（pre-commit）、review | 阻擋 |
| 建置 | `dist/` 產出成功，且 `dist/manifest.json` 引用的每個檔案都存在 | `npm run build && node scripts/verify-dist.mjs` | 任務結束、CI | 阻擋 |

每一列都有可執行指令。沒有指令的數字只是願望，不是約束。

`npm run check:task` 依序執行上表所有「任務結束」的檢查，並由 `.githooks/pre-commit` 在每次 commit 前自動執行（`npm install` 時由 `prepare` script 設定 `core.hooksPath`）。用 `--no-verify` 跳過屬於 Floor 違規，除非使用者明確要求。

**為什麼是這些數字**
- **80% 變更行覆蓋率**：高到逼你寫測試，低到允許一行設定或防禦性分支不測。只限純邏輯與資料層，因為 `offscreen/`（WebGPU）、`content/`（真實 DOM）、`ui/` 的價值主要靠瀏覽器實測驗證，硬設覆蓋率只會換來無意義的 mock 測試。
- **型別與 lint 零錯誤**：這是全新的 TypeScript 程式碼，沒有歷史包袱，從第一天就可以做到零錯誤。
- **全部「阻擋」**：一般建議是 floor 以外的項目先「警告」兩週。這裡選擇全部阻擋，因為新程式碼是從零寫的，沒有既有違規要消化；而且警告在無人值守的 agent 迴圈裡等於不存在。

### 模組依賴規則（dependency-cruiser）

箭頭方向＝「可以 import」。未列出的方向一律禁止，且禁止循環依賴。

| 模組 | 可以 import | 禁止 |
|---|---|---|
| `src/shared` | 只有 `src/shared` | 任何其他 `src/*` |
| `src/core` | `src/shared` | `chrome.*`、DOM、`indexedDB`、`fetch`（以 ESLint `no-restricted-globals` 強制，保證純函式可在 Node 測試） |
| `src/storage` | `core`、`shared` | `chrome.*`、DOM |
| `src/offscreen` | `storage`、`core`、`shared`、`@mediapipe/tasks-retrieval` | `background`、`content`、`ui` |
| `src/background` | `core`、`shared` | `storage`、`offscreen`、`content`、`ui`、`@mediapipe/*` |
| `src/content` | `core`、`shared` | `storage`、`offscreen`、`background`、`ui` |
| `src/ui` | `core`、`shared` | `storage`、`offscreen`、`background`、`content` |

跨執行環境的溝通只能透過 `src/shared/messaging` 定義的訊息契約，不能直接 import 對方的模組。

## 已量測、尚未強制（Ratchet：只能變好，不能變差）

在 Slice 0／Slice 1 完成後記錄基準值。容許誤差 0.5%。

| 指標 | 今日數值 | 方向 | 量測方式 |
|---|---|---|---|
| 專案整體覆蓋率（core/shared/storage） | 待量測（目前無測試） | 不得下降 | `vitest run --coverage` |
| 語意搜尋延遲 p50（暖機後，2 萬段） | 待量測 | 不得上升超過 20% | `vitest bench`（`VectorIndex.search` 純計算）+ DevTools 實測 |
| `dist/` 大小（不含 MediaPipe wasm） | 待量測 | 不得增加超過 10% | `scripts/verify-dist.mjs` 輸出 |

## 每個切片的手動驗收（無法機械化，必須在真實 Chrome 執行）

WebGPU、MediaPipe、`captureVisibleTab` 這些行為在 Node 測試環境中無法驗證，因此每個會碰到它們的切片在 commit 前要在真實 Chrome 走過下列清單，並把結果寫進 commit message 或 PR：

1. 以 `dist/` 載入未封裝擴充功能，Service Worker 與 Offscreen 的 console 沒有錯誤
2. 開一篇**中文**長文，停留後自動索引成功（徽章 ✓），chunk 數合理
3. DevTools → Application → IndexedDB → `semhist`：新增 `pages`／`chunks` 紀錄
4. 用中文自然語言查詢，命中剛才那頁；記錄搜尋耗時
5. **既有資料相容**：用 v0.5.0 建立的索引升級後仍可搜尋（DB 名稱與 schema 不得破壞）

## 例外

| ID | 規則 | 路徑 | 原因 | 負責人 | 到期 |
|---|---|---|---|---|---|
| W1 | 型別、風格、文件、架構、覆蓋率全部不檢查 | 根目錄的 PoC 檔案（`background.js`、`content.js`、`picker.js`、`offscreen.js`、`store.js`、`chunk.js`、`shared.js`、`popup.js`、`search.js`） | v0.5.0 PoC 原樣保留作為行為參考，會在對應切片完成後刪除；不得再修改它們 | XinBow99 | 2027-02-11 |

## 外部意見

本檔大部分的檢查是「專案自己定的規則」或「自己寫的測試」。屬於外部標準、agent 無法自己說服的檢查：`gts`（Google 官方風格設定）、`@types/chrome`（Chrome API 型別定義）。目前沒有安全或無障礙的外部掃描；若之後要加，建議先加 `osv-scanner`（相依套件弱點，CI-only）與 axe-core（WCAG 2.1 AA）。

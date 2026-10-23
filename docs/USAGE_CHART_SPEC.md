# Usage Chart（用量圖表 UI）— Enhancement Spec

> SilverFileSystem 功能增強規格（**只做唯讀圖表**）  
> 狀態：Proposed  
> 相關：`/tree`、`/drive-usage`、`GET /api/folder-tree`  
> **完整 Disk Map／清理腳本見 [DISK_MAP_SPEC.md](./DISK_MAP_SPEC.md)；本文件只做圖表 UI。**

---

## 1. Background / Problem

`/drive-usage` 只顯示碟級 free／used 趨勢；`/tree` 係清單＋麵包屑導航，睇大塊空間唔直觀。使用者想喺網站上用 **treemap／空間地圖** 一眼睇到邊個資料夾食位最大，尤其係 `C:\AI_Server` 這類已掃入 DB 嘅根。

現有 `folder_tree`（`recursive_size` 等）已經有足夠數據做圖；唔需要為此先做清理腳本或另一次全機掃碟。

---

## 2. Goals / Non-goals

### Goals

1. 本機／已登入網站提供 **唯讀** 用量視覺化（treemap 或同等空間圖）。
2. **優先用現有數據**：`folder_tree` via `GET /api/folder-tree`；可選顯示 `/drive-usage` 最新碟摘要作頁頂 context。
3. 支援選定根路徑（例如 `C:\AI_Server`）下鑽（drill-down），顯示大小標籤，並連去 `/tree` 對應路徑。
4. UI 必須 **披露** `folder_tree` 已知低估（見 §6）。
5. Auth 同其他資料 UI 一致（見 §7）。

### Non-goals（明確不做）

- 清理腳本產生（`.ps1`／bash）
- 「可以直接清／先讓我看過」分類、`safe_clean`／`review` 規則
- `sizes.csv` 清理追蹤、增長警報（屬 Disk Map）
- Git worktree remove、TEMP 清理規則
- Server-side 刪檔、自動刪、`ALLOW_PLAIN_DELETE`
- 強制 live 重掃 `node_modules` 等 excluded 路徑（可列為未來選項，**唔屬本 MVP**）

上述能力若要做，跟 [DISK_MAP_SPEC.md](./DISK_MAP_SPEC.md)，**唔擴呢份 Usage Chart 規格**。

---

## 3. Relationship to Existing Features

| 表面 | 關係 |
|------|------|
| `/tree` + `GET /api/folder-tree` | **數據主來源**；Usage Chart 係視覺層，點擊可跳 `/tree?path=...` |
| `/drive-usage` | 可選頁頂「C: free/used」摘要；唔取代碟級歷史圖 |
| `/backup`、`/deleted-archive` | 無關 |
| `/cli-tools` | 無關；唔經 CLI execute 產圖 |
| [DISK_MAP_SPEC.md](./DISK_MAP_SPEC.md) | 更廣：分類、腳本、安全刪除流程；**本規格係其子集之「只畫地圖」** |

---

## 4. Recommendation：新頁 `/usage-chart`（唔直接改 `/tree`）

**建議：新建 `/usage-chart` + `public/usage-chart.html`，Dashboard 加連結。**

| 方案 | 利 | 弊 |
|------|----|----|
| **A. `/usage-chart`（建議）** | `/tree` 保持清單導航唔變肥；圖表可用全闊版面、獨立 loading；日後若接 Disk Map 可同頁進化 | 多一個入口 |
| B. 嵌喺 `/tree` | 少一個 URL | `tree.html` 已大；treemap 同表格式 UX 爭位；風險高 |
| C. 嵌喺 `/drive-usage` | 靠近「用量」語義 | drive-usage 係 **碟級** history，folder treemap 係 **路徑級**；混一頁易混淆 |

**結論：** MVP 用 **方案 A**。頁內提供「喺 Folder Tree 打開」按鈕／點擊矩形 → `/tree?path=`。可選喺 `/tree` header 加細連結「Usage chart」。

---

## 5. UX

### 5.1 版面

- **頂：** 根路徑選擇（預設例如 `C:\AI_Server`，或 API 回傳嘅頂層 folder 列表）、重新載入、`Dashboard` 返回。
- **可選條：** 來自 `GET /api/drive-usage` 嘅最新 C:（或對應碟）free／used／總量。
- **主區：** Treemap（子資料夾按 `recursive_size` 面積比例）。
- **懸浮／圖例：** 路徑、`recursive_size`（`formatBytes`）、檔案數（若 API 有）。
- **底或側：** 簡短披露文案（§6）。

### 5.2 互動

- **Click** 某一塊：若有子資料夾 → drill-down（該 path 做新根重繪）；同時可提供「開 /tree」連結。
- **Breadcrumb：** 同 `/tree` 類似，點上層返回。
- **空／錯：** 無 `folder_tree` 資料時提示先用 CLI：`node bin/cli.js scan "<path>" --db`（唔喺 UI 自動掃，除非已有 rebuild API 且產品決定呼叫——MVP **只讀**）。

### 5.3 視覺最低要求

- 面積 ∝ size（0 或極細可合併為「其他」塊，避免上千微塊）。
- 標籤：空間夠先顯示資料夾名 + 大小；唔夠就 hover 先顯示。
- 深色主題跟現有 `tree.html`／`drive-usage.html`。

---

## 6. Data Gap（必須披露）

預設 scanner `excludePatterns` 包含 `node_modules`、`.cache`、`temp`、`tmp` 等，因此：

- `folder_tree.recursive_size` **會低估**真實碟佔用（尤其 Coding 專案）。
- Usage Chart **畫嘅係 DB 已索引嘅階層**，唔係 Live `du`。

**MVP UI 必須常駐提示**（建議中文）：

> 圖表基於已掃描嘅 `folder_tree`。預設會排除 `node_modules` 等路徑，數字可能細過 Windows 資源管理員。要更新某根路徑請用 CLI `scan --db`。完整「可清／先睇」地圖與清理腳本見 Disk Map 規格（未實作前僅文件）。

唔好喺圖上假裝係「全碟真實用量」。

---

## 7. Auth

- 頁面同 `GET /api/folder-tree`：**同現有** `requireAuthWrapper`／`requireAuth`（與 `/tree` 一致）。
- **唔強制** `requireAdmin`（除非專案政策將全部 folder 路徑視為敏感——若如此，跟 `/tree` 現行行為，唔好單方面加嚴 Usage Chart）。
- 唯讀；無 delete／script endpoint。

---

## 8. Architecture（MVP）

```
public/usage-chart.html     新增
server.js                   GET /usage-chart → serve HTML
public/dashboard.html       加入口（挨近 Drive Usage／Folder Tree）
（可選）重用現有 GET /api/folder-tree，唔新增 API
（可選）GET /api/drive-usage 只取 latest 作摘要
```

**優先：零新 API。** 若現有 `/api/folder-tree` query（`path`／`parent`／children）已夠 drill-down，前端直接組 treemap。

若現有 API 一次只回一層、前端要多次請求——可接受；若效能差，Phase 2 再加 `GET /api/usage-chart?root=&depth=2` 聚合（仍唯讀）。

**唔新增：** `lib/disk-map.js`、script 路由、CSV cleanup。

依賴：瀏覽器端 treemap（輕量自繪、或專案若已有 chart lib；避免為 MVP 拉大型新依賴——實作時擇一並寫入 PR）。

---

## 9. API Usage（現有）

### 9.1 `GET /api/folder-tree`（主）

- 依現有契約傳 path／id，取 children：`folder_id`、`recursive_size`、`recursive_count`／`file_count` 等。
- Treemap nodes = 當層 children；面積用 `recursive_size`。

### 9.2 `GET /api/drive-usage`（可選）

- 只用 `latest` 做頁頂；唔改 drive usage 寫入邏輯。

### 9.3 本規格 **唔加** 嘅 endpoint

- `POST /api/disk-map/script`、任何 cleanup、任何 delete。

---

## 10. MVP Checklist

- [ ] `GET /usage-chart` + `public/usage-chart.html`
- [ ] 選根（至少支援 `C:\AI_Server` 或 DB 內已有頂層）
- [ ] Treemap：`recursive_size` 比例、名／大小、hover
- [ ] Drill-down + breadcrumb
- [ ] 連結到 `/tree?path=...`
- [ ] 常駐低估披露（§6）
- [ ] Auth 同 `/tree`
- [ ] Dashboard 入口
- [ ] README／AGENTS 一行：新增 `/usage-chart`（可選，小改）

### Phase 2（可選，仍屬圖表、非清理）

- [ ] 「其他」合併微塊、色盲友善配色
- [ ] 同屏對比 drive free vs `folder_tree` 總和差距
- [ ] `depth=2` 聚合 API
- [ ] 手動 trigger `rebuild-folder-tree`（admin）後刷新圖——仍然唔做 clean script

---

## 11. Acceptance Criteria

1. 已登入使用者打開 `/usage-chart`，揀 `C:\AI_Server`（或同等已掃根）見到 treemap，最大子塊面積明顯大於細塊。
2. 點擊可下鑽；breadcrumb 可返回；有入口去 `/tree` 同一 path。
3. 頁面可見「排除 node_modules 等／可能低估」說明。
4. 全程 **無** 下載 `.ps1`、無清理分類 UI、無刪檔按鈕（相對 Disk Map）。
5. 非登入行為同 `/tree`／`folder-tree` API（redirect 或 401）。
6. 唔讀、唔顯示 `.env` secrets。

---

## 12. Out of Scope

見 §2 Non-goals；另：

- 實作 Disk Map 清理腳本
- 改 scanner 預設 exclude
- 為圖表單獨加 Cloudflare 特殊規則（跟現有 auth 即可；本功能無危險 write API）

---

## Appendix — 交叉連結

- [DISK_MAP_SPEC.md](./DISK_MAP_SPEC.md) — 完整地圖＋清理腳本（更廣；**本文件唔實作其清理部分**）
- [AGENTS.md](../AGENTS.md) — `folder_tree`、`scan --db`、`loadConfig()`
- [README.md](../README.md) — 頁面清單（實作後加上 `/usage-chart`）

---

*規格完。實作前確認用 `/usage-chart`；改 code 前向使用者說明會改邊啲檔。唔改動 [DISK_MAP_SPEC.md](./DISK_MAP_SPEC.md)。*

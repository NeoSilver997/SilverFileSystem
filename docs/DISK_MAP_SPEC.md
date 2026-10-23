# Disk Map / Cleanup Script — Enhancement Spec

> SilverFileSystem 功能增強規格（Windows-first）  
> 狀態：Proposed · 分支建議：`feature/disk-map`（或跟現有 `feature/face-detection` 合流前獨立 PR）  
> 相關頁面：`/drive-usage`、`/tree`、`/backup`、`/deleted-archive`、`/cli-tools`  
> 本文件**唔包含**密碼、JWT、Google secret；設定一律經 `loadConfig()` / `.env`（agent 只可確認非 secret 鍵名）。

---

## 1. Background / Problem

用 AI 同開發工具一段時間之後，硬碟會「莫名其妙」少幾百 GB。常見來源：

- 套件下載快取（`npm` / `uv` / `bun` / conda）
- AI 對話／session 紀錄（Codex、Claude Code 等）
- 本機模型（Ollama、ComfyUI `.safetensors`）
- Docker 映像／volume、系統 TEMP

呢啲多數喺隱藏或唔常開嘅資料夾（例如 `%LOCALAPPDATA%`、`%USERPROFILE%\.codex`）。使用者唔知邊個食位，亦唔敢亂刪。

現有 SilverFileSystem 已經可以：

- 睇碟級用量（`/drive-usage`）
- 睇已掃路徑階層大小（`/tree` + `folder_tree`）
- 查 duplicate／backup、DB 層刪除 archive

但**未有**：按「可以直接清／先讓我看過／只標示」分類、treemap 地圖、產生本機清理腳本、sizes 增長追蹤。

另外，預設 scanner `excludePatterns` 包含 `node_modules`、`.cache`、`temp`、`tmp`，所以 `folder_tree`／`/tree` **會低估**開發快取真實佔用；Disk Map 必須對規則路徑做 **live size-only** 量度，唔可以只靠 DB。

---

## 2. Goals / Non-goals

### Goals

1. **唯讀**掃描已知開發／AI／暫存位置，**只量大小**，唔打開檔案內容。
2. 本機 HTML 頁 `/disk-map`：左邊 treemap，右邊分組可勾選清單。
3. 分三類：
   - **可以直接清**：可重建快取（工具原生 clean 指令優先）
   - **先讓我看過**：對話紀錄、模型、Docker 等
   - **只標示**：作品／影片專案／ComfyUI models — 地圖顯示，**唔入**清理建議
4. 使用者勾選後，**下載**清理腳本（Windows：`.ps1`）；腳本要輸入 `yes` 先執行。
5. **永不**由 server／web UI 自動刪碟上檔案。
6. 每次掃描把各項大小 append 到 `sizes.csv`，標示「變大咗」嘅項目。
7. API／頁面需 **admin**；公網 Cloudflare host 上亦只允許下載腳本，唔允許遠端執行刪除。

### Non-goals

- 取代 `/tree` 通用瀏覽或 `/drive-usage` 碟級歷史。
- Server 端直接 `Remove-Item`／`rm`／執行 cleanup（包括經 `/api/cli/execute`）。
- 讀取對話／模型檔內容、上傳用戶檔案到雲端。
- 自動排程清碟（MVP／Phase 2 都唔做）。
- macOS／Linux 完整對等（可預留規則表結構；本機實作以 Windows 為準）。
- 修改預設 scanner exclude 令所有 scan 都入 `node_modules`（Disk Map 自己 live 掃）。

---

## 3. Relationship to Existing Features

| 現有表面 | 路徑／入口 | 同 Disk Map 關係 |
|----------|------------|------------------|
| Drive Usage | `/drive-usage`、`GET/POST /api/drive-usage*`、`checkDriveUsage()` | 碟級 free/used；Disk Map 解釋「邊個資料夾食位」 |
| Folder Tree | `/tree`、`GET /api/folder-tree`、`folder_tree.recursive_size` | 已掃路徑導航；可作 treemap 輔助，但 cache 類要 live 補 |
| Tree delete | `POST /api/tree/delete-file`、`check-deleted` | **只改 DB／archive**，檔留喺碟；同 Disk Map 腳本「真刪碟」要 UI 寫死分別 |
| Backup | `/backup`、`/api/backup-analysis` | Duplicate copy 分析；唔產清理腳本 |
| Deleted Archive | `/deleted-archive` | DB archive restore／purge |
| CLI Tools UI | `/cli-tools`、`POST /api/cli/execute` | 而家只示範指令；**唔好**擴成真刪 |
| Scanner / Large | `lib/scanner.js`、`lib/large.js`、`bin/cli.js scan`／`large-files` | 可重用 size 掃描思路；Disk Map 用獨立規則表 |
| VLM cleanup | `POST /api/vlm/cleanup` | 分類資料過期；無關硬碟快取 |

**職責分工：**

- `/drive-usage` → 碟總量趨勢  
- `/tree` → 已掃階層  
- `/disk-map` → 可重建快取／AI 暫存分類地圖 + **本機**清理腳本  

Dashboard（`public/dashboard.html`）應加入口，挨近 Drive Usage／Folder Tree。

---

## 4. UX — `/disk-map`

### 4.1 版面

- **左**：矩形樹狀圖（treemap），按佔用空間比例；顏色區分三組（可清／先睇／只標示）。
- **右**：兩個可勾選清單：
  - 「可以直接清」
  - 「先讓我看過」
- 「只標示」項目出現喺地圖（同可選只讀清單），**checkbox 禁用或不出現**。
- 每項顯示：路徑、大小、刪咗會點（簡短說明）、上次大小／增長（若有 CSV）。
- **底**：`下載清理腳本`（依勾選產生 `.ps1`）；提示「喺本機 PowerShell 執行，要輸入 yes」。
- Header：連返 Dashboard；顯示掃描時間、總可清／先睇 GB。

### 4.2 互動原則

- 預設「先讓我看過」**唔勾選**；「可以直接清」可預設勾選或全唔勾（實作時二選一，建議 **預設全唔勾**，避免誤下載過大腳本）。
- Chat「最近 14 天」項：標「不建議刪」，預設唔勾、可強制勾但腳本內加 warning comment。
- Loading／progress：長掃描顯示進度（已處理路徑數）；可取消（best-effort）。
- 錯誤：權限不足、路徑唔存在 → 跳過並喺結果列 `skipped` 原因，唔整頁失敗。

### 4.3 永不自動刪

- UI、API、server job **都唔會**刪碟上檔案。
- 唯一刪除途徑：使用者下載腳本 → 本機 terminal → 手動輸入 `yes`。

---

## 5. Classification Rules（Windows）

規則以 **規則表**（`lib/disk-map.js` 內常數或 JSON）維護。下列為初始建議；實作可按本機探测結果增刪。

### 5.1 可以直接清（rebuildable caches）

| ID（例） | 路徑（例） | 說明 | 建議清理指令 |
|----------|------------|------|--------------|
| `npm-cache` | `%LOCALAPPDATA%\npm-cache` | npm 下載快取 | `npm cache clean --force` |
| `npm-user` | `%USERPROFILE%\.npm` | 用戶 npm 相關快取 | 工具指令優先；否則 plain 需 `ALLOW_PLAIN_DELETE` |
| `uv-cache` | `%LOCALAPPDATA%\uv` | uv 快取 | `uv cache clean` |
| `bun-cache` | `%USERPROFILE%\.bun\install\cache`（若存在） | bun | `bun pm cache rm` 或文件化指令 |
| `conda-pkgs` | `%USERPROFILE%\.conda\pkgs` 或 Miniconda `pkgs`（若存在） | conda 包快取 | `conda clean -a`（需確認 conda 喺 PATH） |
| `user-cache` | `%USERPROFILE%\.cache` 內可識別子項 | 通用 cache；只列已知安全子目錄 | 按子項；不明子項改「先讓我看過」 |
| `project-node-modules`（可選 Phase 2） | 掃描根下閒置專案 `node_modules` | 刪咗要 `npm i`／`pnpm i` | 預設 plain 略過；或只建議唔自動勾 |

**本機已確認存在（規格撰寫時探测，非保證永久）：**  
`%LOCALAPPDATA%\npm-cache`、`%LOCALAPPDATA%\uv`、`%USERPROFILE%\.cache`、`.npm`、`.bun`。

### 5.2 先讓我看過

| ID | 路徑（例） | 規則 |
|----|------------|------|
| `codex-chat-old` | `%USERPROFILE%\.codex` 內對話／session（**排除 memory**） | **超過 14 天**未改 → 可勾，仍屬「先睇」 |
| `codex-chat-recent` | 同上 | **最近 14 天** → 標「不建議刪」 |
| `claude-chat-old` / `claude-chat-recent` | `%USERPROFILE%\.claude`（排除 memory） | 同上 14 日拆分 |
| `ollama` | `%USERPROFILE%\.ollama` | 模型；先睇 |
| `docker-data` | Docker 資料根（若可安全探测） | 先睇；優先建議 `docker system prune` 類指令字串，唔直接 rm |
| `ai-session-temp` | AI 工具 session 暫存 | 只列 **超過 3 天無任何變動** 嘅；其餘唔列 |

**Skip：** 任何名為／路徑含 `memory` 嘅 AI memory 資料夾 — **唔列進清單**。

### 5.3 只標示（地圖有、清理建議無）

| ID | 路徑（例） | 原因 |
|----|------------|------|
| `comfyui-models` | `C:\AI_Server\ComfyUI_windows_portable_nvidia\ComfyUI\models`（及同系 models） | 大模型權重；刪咗難重建 |
| `work-video` / `work-export` | 由資料夾名／規則判斷嘅影片專案、輸出、照片匯出 | 作品 |
| `coding-root-summary`（可選） | `C:\AI_Server\Coding` 總覽塊 | 可用 `folder_tree` 輔助顯示；細部清理由規則項負責 |

### 5.4 跳過／唔掃

- 會觸發系統權限彈窗嘅受保護路徑（盡量避）
- 外接碟（除非使用者明示加入 roots）
- 雲端同步根（OneDrive 等）除非 allowlist
- Reparse point／junction：量 size 時 **唔 follow** 到其他 volume 嘅目標（同 scanner `followSymlinks: false` 精神）；清理腳本對 junction **預設略過**

### 5.5 路徑解析

- 用 Node `os.homedir()`、`process.env.LOCALAPPDATA`、`TEMP` 等解析；規則表存「邏輯鍵」+ 解析函式。
- 路徑顯示用 Windows 反斜線；API JSON 可用正規化字串。

---

## 6. Git Worktree Rules（Phase 2 可實作，MVP 文件化）

只有同時滿足先建議刪：

1. **無未 commit 改動**（`git status --porcelain` 空）
2. **已合併進主線**（相對 `main`／`master`／預設 upstream）
3. **7 天無改動**（worktree 目錄 mtime 或最後 commit 時間）
4. **無程式正在該目錄跑**（process 路徑檢查，best-effort）

刪法：

- 腳本使用 `git worktree remove "<path>"`（或 `git worktree remove --force` 僅喺額外 flag）
- **禁止**對 worktree 預設 `Remove-Item -Recurse`
- 腳本註解提醒：被 `.gitignore` 忽略、只存在該 worktree 嘅輸出檔會一併冇

檢查 worktree 時可用 git 指令；**唔算**打開檔案內容。

MVP：可喺 UI 顯示「Worktree 規則尚未啟用」或略過整組。

---

## 7. TEMP（家目錄外暫存）

- 主要：`%LOCALAPPDATA%\Temp` / `%TEMP%`
- **只量大小**；內容唔讀
- 列入「可以直接清」或「先讓我看過」條件：
  - 可重建快取類型（實作以 allowlist 副檔名／子目錄名為準，例如明確 npm／pip 臨時目錄）
  - **超過 3 天**未改
  - best-effort 確認無行程鎖住
- 不明大檔 → 「先讓我看過」或唔列
- AI session 暫存：見 §5.2（>3 天無變動先列「先睇」）

---

## 8. Architecture

```
bin/cli.js                  += disk-map / disk-map-script
lib/disk-map.js             新增：規則、量 size、分類、CSV、腳本產生
lib/scanner.js / utils.js   可重用 formatBytes 等；唔強制改 exclude
server.js                   += 頁面路由 + /api/disk-map*
public/disk-map.html        新增 UI
public/dashboard.html       加入口連結
docs/DISK_MAP_SPEC.md       本規格
%USERPROFILE%\disk-report\sizes.csv   增長紀錄（見 §11）
```

### 8.1 `lib/disk-map.js`（建議匯出）

- `listRuleTargets()` — 解析後路徑 + 分類 + 指令模板
- `measurePath(path, options)` — 唯讀遞迴 size（跳過 reparse／權限錯誤）
- `scanDiskMap(options)` — 回傳分類結果 + totals
- `appendSizesCsv(rows)` / `readPreviousSizes()`
- `buildCleanupScriptPs1(selectedIds, options)` — 字串
- `checkWorktrees(options)` — Phase 2

### 8.2 CLI

```bash
node bin/cli.js disk-map [--json] [--roots <path>] [--out report.json]
node bin/cli.js disk-map-script --ids npm-cache,uv-cache --out cleanup.ps1
```

- CLI 用 `loadConfig()`；DB **非必須**（MVP 可不寫 DB）。若要併 `folder_tree` 摘要，先連 `silver_files_db`（經 `.env`），**唔好**用舊 `config.json` 空庫。
- Spinner／logging 跟現有 CLI 風格。

### 8.3 Web

- `GET /disk-map` → serve `public/disk-map.html`
- API 見 §9

---

## 9. API Contracts

全部需登入且 **`requireAdmin`**（`authMiddleware` + `adminMiddleware`）。非 admin → `403`。

### 9.1 `GET /api/disk-map`

回傳上次掃描快取（記憶體或細 JSON 檔），若無則 `404` 或空結果 + `scannedAt: null`。

```json
{
  "scannedAt": "2026-10-23T10:00:00+08:00",
  "totals": {
    "safeCleanBytes": 0,
    "reviewBytes": 0,
    "labelOnlyBytes": 0
  },
  "items": [
    {
      "id": "npm-cache",
      "group": "safe_clean",
      "path": "C:\\Users\\...\\AppData\\Local\\npm-cache",
      "bytes": 0,
      "prevBytes": null,
      "grew": false,
      "blurb": "刪咗之後下次 install 會重新下載",
      "cleanCommand": "npm cache clean --force",
      "allowPlainDelete": false,
      "recommend": true
    }
  ],
  "skipped": [{ "id": "...", "reason": "not_found|access_denied|reparse" }]
}
```

`group`: `safe_clean` | `review` | `label_only`

### 9.2 `POST /api/disk-map/scan`

- Body（可選）：`{ "roots": [] }` 額外根（admin）；預設用規則表
- 行為：唯讀量 size → 更新快取 → append CSV → 回傳同 GET 形狀
- 長時間：MVP 同步 + 足夠 timeout；Phase 2 可改 job id + poll
- **唔刪任何檔**

### 9.3 `POST /api/disk-map/script`

- Body：`{ "ids": ["npm-cache", "uv-cache"], "allowPlainDelete": false }`
- Response：
  - `Content-Type: application/octet-stream` 或 `text/plain`
  - `Content-Disposition: attachment; filename="silverfs-cleanup.ps1"`
  - Body = PowerShell 腳本文本
- 校驗：只接受已知規則 `id`；`label_only` id → `400`
- **唔**喺 server 執行腳本

### 9.4 明確唔提供

- `DELETE /api/disk-map/...` 刪碟路徑
- 經 `/api/cli/execute` 觸發 cleanup

---

## 10. PowerShell Script Requirements

產生嘅 `.ps1` 必須：

1. **開頭**：提示將刪咩；要求使用者輸入 `yes`（精確匹配）先繼續；其他輸入即退出。
2. **工具原生指令優先**（`npm cache clean --force`、`uv cache clean`、`conda clean`、`docker ...` 等）。
3. **無專用指令**嘅項目：預設只 `Write-Host`「略過」；只有 `$env:ALLOW_PLAIN_DELETE -eq '1'`（或參數 `-AllowPlainDelete`）先用 `Remove-Item -LiteralPath ... -Recurse -Force`。
4. 預設 `ALLOW_PLAIN_DELETE` = **關閉（0）**。
5. 每步：印路徑、結果、錯誤唔令成個腳本 silent fail（`$ErrorActionPreference` 要清晰）。
6. Worktree（Phase 2）：`git worktree remove`，唔用 plain rm。
7. Encoding：UTF-8 BOM 可選，確保中文路徑；註解可用中文。
8. **唔**要求使用者把腳本貼進 chat／遠端執行；頁面只提供下載。

---

## 11. `sizes.csv` Growth Tracking

- **路徑（預設）：** `%USERPROFILE%\disk-report\sizes.csv`
- 若目錄唔存在 → 建立 `disk-report`
- 格式（建議）：

```csv
timestamp,id,path,bytes
2026-10-23T18:00:00+08:00,npm-cache,C:\Users\...\npm-cache,123456789
```

- 每次成功 scan **append** 新列（唔覆寫歷史）
- UI／API：對每個 `id` 取上次同 `id` 最新一列作 `prevBytes`；`grew = bytes > prevBytes`
- 可選 Phase 2：搬去專案 `data/disk-report/` 或 DB 表；MVP 用 user profile CSV 即可

---

## 12. Security

1. **Cloudflare 公網**（例如 `medialib2.tcghk.trade`）轉發到本機 Express：Disk Map API **必須 admin**；腳本 **只下載**。
2. **永不** server-side delete／`exec` cleanup 腳本。
3. 唔好擴 `/api/cli/execute` 去做真刪。
4. 路徑只能量規則表 + admin 顯式 allow 嘅 roots；防 path traversal（`..`、非法根）。
5. 本文件同程式註解 **唔寫** `.env` 密碼、JWT、Google client secret。
6. DB 若用到：一律 `loadConfig()`；正確庫為 `.env` 嘅 `DB_*`（本機常見 `13306` / `silver_files_db`）；唔好用過時 `config.json` 空庫當真相。
7. 建議（Phase 2）：額外限制 script 下載只來自 localhost／內網，或二次確認 token。

---

## 13. MVP vs Phase 2

### MVP Checklist

- [ ] `lib/disk-map.js` 規則表（Windows 核心路徑）+ size-only measure
- [ ] 分類：`safe_clean` / `review` / `label_only`（含 ComfyUI models 只標示）
- [ ] Skip memory 資料夾
- [ ] `GET/POST /api/disk-map`、`POST /api/disk-map/script` + `requireAdmin`
- [ ] `public/disk-map.html` treemap + 兩組 checkbox + 下載 `.ps1`
- [ ] `.ps1`：yes gate、工具指令、`ALLOW_PLAIN_DELETE` 預設關
- [ ] `%USERPROFILE%\disk-report\sizes.csv` append + grew 標記
- [ ] CLI `disk-map`、`disk-map-script`
- [ ] Dashboard 連結；`AGENTS.md`／`README.md` 簡短 Agent notes（admin、唔自動刪）
- [ ] 單元測試：規則分組、腳本含 yes gate、拒絕 `label_only` id

### Phase 2 Checklist

- [ ] Codex／Claude **14 日**拆分 + 最近「不建議刪」
- [ ] Git worktree 四條件 + `git worktree remove`
- [ ] TEMP／AI session >3 日規則精細化
- [ ] 非同步 scan job + progress API
- [ ] 閒置專案 `node_modules` 探测（謹慎預設）
- [ ] Localhost-only 或額外確認下載腳本
- [ ] 併 `folder_tree` 大塊摘要進 treemap
- [ ] macOS／Linux 規則映射（可選）

---

## 14. Acceptance Criteria

1. Admin 開啟 `/disk-map`，跑 scan 後見到至少 npm／uv／已知存在路徑嘅大小（本機有則顯示）。
2. ComfyUI models（若路徑存在）只喺地圖／label_only，**唔出現**喺可清勾選清單。
3. Memory 相關路徑唔出現喺任何清理建議。
4. 下載嘅 `.ps1` 未輸入 `yes` 前唔會刪任何嘢；無 `ALLOW_PLAIN_DELETE` 時 plain rm 路徑只印略過。
5. 呼叫 script API 帶 `label_only` id → `400`；非 admin → `403`。
6. Scan 期間同完成後，碟上檔案數／內容唔因 Disk Map 而減少（唯讀）。
7. 連續兩次 scan，第二次 UI 能標示相對 CSV 變大嘅項（若大小有變）。
8. `/tree` 嘅「Delete File」仍然只刪 DB；文案或本功能說明唔會誤導成 Disk Map 等同 tree delete。
9. 文件同 UI 無洩漏 secrets。

---

## 15. Out of Scope

- 自動排程清碟、開機清、服務帳號代清
- 經公網一鍵 Remote Wipe
- 加密磁碟／BitLocker 解鎖流程
- 完整 macOS Disk Map UI 對等（除非另開規格）
- 改變預設全域 scanner 令所有 `node_modules` 入庫
- 刪除使用者「作品」目錄、ComfyUI 模型、Ollama 模型嘅預設建議勾選
- 實作本規格時讀取或提交 `.env` 秘密值

---

## Appendix A — 參考命令（開發用，非自動執行）

```bash
# 掃描分類（唯讀）
node bin/cli.js disk-map --json

# 產生腳本（唔執行）
node bin/cli.js disk-map-script --ids npm-cache,uv-cache --out %USERPROFILE%\disk-report\cleanup.ps1

# 本機執行（使用者手動）
powershell -NoProfile -ExecutionPolicy Bypass -File %USERPROFILE%\disk-report\cleanup.ps1
```

## Appendix B — 同現有文件交叉連結

- [AGENTS.md](../AGENTS.md) — DB／`loadConfig()`、`/tree`、PORT、Cloudflare
- [README.md](../README.md) — Agent notes、頁面清單（實作後應加上 `/disk-map`）
- [SERVER_GUIDE.md](../SERVER_GUIDE.md) — 伺服器運作
- [SECURITY_SUMMARY.md](../SECURITY_SUMMARY.md) — 安全總覽（實作後可補 Disk Map 一節）

---

*規格完。實作前向使用者確認 MVP 範圍；改 code 前說明會改邊啲檔。*

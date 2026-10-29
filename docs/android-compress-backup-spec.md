# Android Compress Archive — Product + API Spec

> SilverFileSystem 手機壓縮歸檔規格（Android）  
> 狀態：**Proposed** · 分支：`feature/face-detection`  
> 相關：每日 pipeline（thumb → embed → classify）、`scripts/compress-strip-motion.cjs`、`config/embed-categories.json`、`lib/auth.js` JWT  
> 本文件**唔包含**密碼、JWT secret、Google secret；設定一律經 server `loadConfig()` / `.env`。  
> **本階段只寫 SPEC，唔實作 Android app。**  
> 更新（本版）：**壓縮喺 Android 本機做**，目標係**慳手機儲存空間**；壓縮後 **replace／archive 本機檔**。Server **只**用檔名→hash 查庫，確認「已有原檔備份」先可安全縮小本機 copy。**Server 唔負責再壓**。人物 Motion Photo 仍**喺本機**分開儲存靜態圖 + 短片。

---

## 0. Summary

### 一句話

其他 App 負責「原檔上載入庫」；本 App 負責「確認 server 已有 → **喺手機壓縮** → **縮小／替換本機檔** 慳空間」。

### 角色分工（強制）

| 邊度 | 做咩 | 唔做咩 |
|---|---|---|
| **Android App（本產品）** | 讀本機相、lookup、**本機有損壓縮**、人物 Motion 本機拆片、**replace／archive 本機檔** | 唔當首次上載客戶端；唔依賴 server 壓圖 |
| **其他備份／同步 App** | 原檔上載到 SilverFS 可見路徑（例：`H:\...\DCIM\Camera\...`） | — |
| **SilverFS Server** | `lookup`（檔名→hash）證明庫內已有同一張；可選回分類／`already_local_shrunk` 狀態；可選輕量「已本機壓縮」標記 | **唔接收壓縮檔去再壓**；**唔做 JPEG recompress**；唔當本 App 嘅壓縮引擎 |

### 核心流程

1. 掃手機本機相 → 用 **檔名先查 server**，再以 **content hash 核對**係咪同一張（確認已備份）  
2. **只喺 Android 本機**按類別有損壓縮（＋人物 Motion 本機拆短片）  
3. 壓縮後對**手機儲存**：`replace_local`（預設，慳空間）或 `archive_local`（本機平行資料夾保留原檔）  
4. Server 可選收到「本機已縮」metadata（**唔强制上傳壓縮 bytes**）

| 內容類（中文） | SilverFS embed label | JPEG quality（**本機**） |
|---|---|---:|
| 人物 | `人物單人` / `人物合照` | **92** |
| 食物 | `食物` | **80** |
| 收據／餐牌／資料 | `收據餐牌資料` | **60** |
| 其他（風景、動物、截圖…） | 其餘 label／`其他` | **85**（預設，可調） |

**Motion Photo 規則（本機）**

| qualityClass | Motion Photo 處理（全部喺手機做） |
|---|---|
| `person`（人物） | **本機分開儲存**：靜態 JPEG（q92）+ 獨立 MP4 trailer；用 `originalContentHash`／`motionPairId` 互聯 |
| `food` / `docs` / `other` | **本機剝走短片**（只留壓縮 JPEG；唔另存 MP4） |

伺服器端對齊現有 Express + MySQL（`scanned_files`、`folder_tree`、embedding／classify）。本 SPEC 提出 **lookup／status** endpoints（見 §4）；查重對齊 `name`＋`hash`／`md5`／`quick_hash`。

---

## 1. Goals / Non-goals / UX

### 1.1 Goals

1. **慳 Android 儲存空間**：對已確認「server 庫內有同一張原檔」嘅本機相，喺**手機上**做 lossy JPEG 壓縮，然後 replace／archive **本機檔**。  
2. 查庫順序：**先檔名（basename）** → 命中後用 **content hash 核對**（避免同名唔同相）。未通過核對 → **唔縮小本機檔**。  
3. 按內容類別揀 JPEG quality（上表）；壓縮引擎跑喺 **device**（Bitmap／ImageEncoder／libjpeg-turbo 等），**唔**交 bytes 畀 server 再壓。  
4. 本機模式可選（設定）：  
   - **`replace_local`（預設，目標慳空間）**：用壓縮版覆寫 MediaStore／檔案系統上嘅本機原檔（可先寫本機 `_bak` 再 overlay；用家確認後刪 bak）  
   - **`archive_local`**：壓縮版寫去本機平行資料夾（例：`Pictures/SilverFS_Compressed/...`），原相保留；用家之後可手動刪原相  
5. 人物 Motion：**本機**拆 still + MP4；非人物 **本機** strip trailer。  
6. 支援手動選相／自動掃描；只處理「庫內已有對應」項目；未入庫標記「未在庫／請用其他 App 先上傳」——本 App **唔上傳原檔**。  
7. 顯示進度：排隊、查檔名、核 hash、**本機壓縮中**、本機 replace／archive、skip、失敗重試；人物另顯示「短片已本機分開」。  
8. 設定：Wi‑Fi only（若要打 lookup／可選 status API）、可選充電先跑、每批上限、品質覆寫、本機模式、Motion 開關。  
9. （可選）壓縮完成後 `POST /api/archive/mark-local-shrunk` 只傳 metadata；**唔**上傳壓縮 JPEG 作主路徑。Server 庫內原檔通常**保持唔變**（因為慳嘅係手機空間，唔係 NAS）。

### 1.2 Non-goals（明確不做 — MVP）

- **唔喺 server 做壓縮／recompress**——任何「交原檔／縮圖畀 server 壓完再下載」都唔屬本產品。  
- **唔做「第一次上傳原檔入庫」**——其他 App／手動同步責任。  
- **唔以「上載壓縮版到 `*_compressed` on NAS」作為主目標**——主目標係手機空間；PC／server 端 `compress-strip-motion.cjs` 另案。  
- 唔取代現有 PC 端壓縮腳本／`/tree` 手動整理。  
- 唔做 iOS（可另開 SPEC）。  
- 唔做「相簿入面獨立長片／純 MP4」全庫處理（人物 Motion trailer 除外）。  
- 唔喺手機訓練模型；唔強制離線高精度分類。  
- 唔做端到端加密雲。  
- 唔一次過重做全庫 70 萬張舊相（server／PC job）。  
- 唔假裝完整 MobileBackup 客戶端。

### 1.3 UX flow（高層 — 本機壓縮慳空間）

```text
[Onboarding] → [登入 / Server URL] → [權限]
    ↓
[設定]  Wi‑Fi only · 本機模式(replace_local/archive_local) · 品質表 · Motion 開關
    ↓
[圖庫揀相] → [類別覆核] → [壓縮預覽 before/after（本機預估）] → [確認縮小本機]
    ↓
每張：讀本機檔 → 偵測 Motion → 分類 → 定 quality
    ↓
POST /api/archive/lookup  （先 name，再可選 hash 核對）
    ├─ not_found          → UI「未在庫」→ 提示用其他 App 先上傳（本 App 唔上傳、亦唔縮）
    ├─ name_match_hash_mismatch → UI「同名唔同檔」→ skip／人手（唔縮）
    ├─ already_local_shrunk → Skip
    └─ matched            → 安全縮小閘門打開
    ↓
  ★ 全部壓縮喺 Android 本機 ★
  ┌─ person + Motion ──► 本機拆 still + mp4
  │     still: strip trailer → hash → compress q92 → replace/archive 本機圖
  │     mp4:   extract trailer → 本機另存（link pair）；MVP 唔再壓短片
  └─ 其他 (+ Motion) ──► 本機 strip trailer（丟短片）→ compress → replace/archive 本機圖
    ↓
（可選）POST /api/archive/mark-local-shrunk 只送 metadata
    ↓
本機空間釋放；完成通知（顯示慳咗幾多 MB）
```

詳細畫面見 **§12 UI Design**。

---

## 2. Classification（點樣決定類別）

### 2.1 目標 mapping

App 內部用 **quality class** 三＋一：

| `qualityClass` | 對應 SilverFS labels | quality（本機 JPEG） |
|---|---|---:|
| `person` | `人物單人`, `人物合照` | 92 |
| `food` | `食物` | 80 |
| `docs` | `收據餐牌資料` | 60 |
| `other` | `風景`/`動物`/`貓`/`狗`/`車`/`花卉`/`螢幕截圖`/`其他`/unknown | 85 |

雙 tag（dual tag，cosine ≥ 0.50）時：**取較「保守」quality**（數字較低＝壓多啲），即 `min(q1,q2)`。  
例：`人物單人`+`食物` → quality 80。

**Motion 決策跟最終 `qualityClass`**：非 `person` → 只 strip、唔另存短片。只有 `person` 先本機分開存 MP4。

### 2.2 推薦做法

**線上（優先）**

1. App 產生細 thumbnail（最長邊 ≤ 512，JPEG q70）打 **`POST /api/archive/classify-preview`**（§4.5）。  
   - 注意：呢個係 **分類預覽**，**唔係**叫 server 壓縮。  
2. Server 用現有 EmbeddingGemma + classifier → `labels[]`。  
3. 若 lookup 已命中且庫內有 tag，可直接用 server labels。

**離線 fallback**

1. 用家手動 tag（四掣）— MVP 必備。  
2. 輕量 heuristic：Face → `person`；文字密集 → `docs`；其餘 `other@85`。  
3. 唔建議 MVP 上完整 on-device classifier。

### 2.3 用家覆寫

每張／每批可強制 `qualityClass`。覆寫優先過 API／heuristic。

---

## 3. Identity：檔名先，再 hash（安全縮小閘門）

Server lookup **唯一主用途**：證明「呢張本機相已喺 NAS／庫內有備份」，先至可以安全刪／覆寫本機大檔。

### 3.1 對齊現有 DB

| Column | 用途 |
|---|---|
| `name` / path basename | **第一輪 lookup 鍵** |
| `path` | 完整路徑；區分多碟同名 |
| `hash` / `md5` / `quick_hash` | 核對同一內容 |
| `size` | 弱核對 |

### 3.2 Lookup 順序（強制）

```text
1) basename（例：IMG_20261029_153012.jpg）
   → 0 命中：not_found（未在庫）→ 唔縮本機
   → 1 命中：進入 hash 核對
   → N 命中：candidates[]；仍多過一個 → needs_disambiguation

2) hash 核對（client 提供；對「剝 Motion 後、壓縮前」靜態圖 bytes）
   - originalContentHash = MD5(strip_motion(original_bytes))
   - 可選 originalQuickHash、originalSize、capturedAt

   → hash_match → matched（允許本機壓縮＋replace/archive）
   → name 命中但 hash 唔對 → name_match_hash_mismatch（禁止縮小）
   → 庫內無 hash → needs_hash_verify（預設唔准 replace_local）
```

**原則**：未通過 hash（或明確「庫內無 hash + 用家確認」）→ **唔做 `replace_local`**。`archive_local` 預設同樣要求 hash OK。

### 3.3 App 要計嘅 hash（本機）

1. **`originalContentHash`** — 剝 Motion 後、有損重壓**之前**全檔 MD5。  
2. **`originalQuickHash`（可選）**。  
3. **`compressedContentHash` / size** — 本機壓縮後，供 mark-local-shrunk／除錯。  
4. 人物短片：**`motionVideoContentHash`**、**`motionPairId`**（= `originalContentHash`）。

### 3.4 「已本機縮小」判斷

- 本機 Room 有同一 `originalContentHash` 且 status=done  
- 或 server `mark-local-shrunk` 已記（可選）  
- 或 EXIF／MediaStore 標記 `CompressedBy=SilverFS-Android-Local`

已做過 → **Skip**。

---

## 4. Proposed REST API

Base URL（示例）：`https://medialib2.tcghk.trade`  
Auth：`Authorization: Bearer <JWT>`（`requireAuth` + `requirePhotoPermission`）。  
登入：`POST /api/auth/login`。

> **現況**：repo **未有** 呢批 endpoint → **全部為新增**。  
> **語意轉變**：舊稿「upload／submit 壓縮檔上 NAS」**降級／唔做主路徑**；主路徑係 **lookup 閘門 + 本機壓縮**。Server **永不**對收到嘅圖做 JPEG recompress。

### 4.1 `POST /api/archive/lookup`（核心：先 name，再 hash）

**Request**

```http
POST /api/archive/lookup
Authorization: Bearer <jwt>
Content-Type: application/json
```

```json
{
  "name": "IMG_20261029_153012.jpg",
  "originalContentHash": "a1b2c3d4e5f6789012345678abcdef01",
  "originalQuickHash": "f0e1d2c3b4a5968778695a4b3c2d1e0f",
  "originalSize": 4821934,
  "capturedAt": "2026-10-29T15:30:12+08:00",
  "deviceId": "xiaomi-14t-pro",
  "pathHint": "H:\\silverchan\\Photos\\MobileBackup\\Xiaomi 14T Pro\\DCIM\\Camera\\2026\\10\\"
}
```

`name` **必填**；hash／size／capturedAt／pathHint **強烈建議**。

**Response 200 — matched**（可以安全本機縮小）

```json
{
  "status": "matched",
  "matchType": "name_then_hash",
  "fileId": 123456,
  "path": "H:\\silverchan\\Photos\\MobileBackup\\Xiaomi 14T Pro\\DCIM\\Camera\\2026\\10\\IMG_20261029_153012.jpg",
  "name": "IMG_20261029_153012.jpg",
  "size": 4821934,
  "safeToShrinkLocal": true,
  "alreadyLocalShrunk": false,
  "serverLabels": ["人物單人"],
  "hasMotionOnDisk": true
}
```

**Response 200 — not_found**

```json
{
  "status": "not_found",
  "matchType": "none",
  "name": "IMG_20261029_153012.jpg",
  "safeToShrinkLocal": false,
  "hint": "Upload original with your backup app first; this app will not shrink until backed up"
}
```

**Response 200 — name_match_hash_mismatch**

```json
{
  "status": "name_match_hash_mismatch",
  "safeToShrinkLocal": false,
  "candidates": [
    {
      "fileId": 123456,
      "path": "H:\\...\\IMG_20261029_153012.jpg",
      "size": 5000001,
      "md5": "deadbeef..."
    }
  ]
}
```

**Response 200 — needs_disambiguation**

```json
{
  "status": "needs_disambiguation",
  "safeToShrinkLocal": false,
  "candidates": [
    { "fileId": 1, "path": "H:\\...\\2026\\10\\IMG_....jpg", "size": 1, "quickHash": "..." },
    { "fileId": 2, "path": "P:\\...\\IMG_....jpg", "size": 2, "quickHash": "..." }
  ]
}
```

**Response 200 — already_local_shrunk**

```json
{
  "status": "already_local_shrunk",
  "safeToShrinkLocal": false,
  "fileId": 123456,
  "shrunkAt": "2026-10-29T20:00:00+08:00",
  "deviceId": "xiaomi-14t-pro"
}
```

**Errors**：`401`／`403`／`400`（缺 name）。

### 4.2 `POST /api/archive/lookup/batch`

一次最多 100 項。回 `results[]`，每項含 `safeToShrinkLocal`。

### 4.3 `POST /api/archive/mark-local-shrunk`（可選 metadata；唔傳圖）

只通知 server「呢個 device 已對呢張庫內檔做過本機壓縮」。**唔上傳 JPEG／MP4 bytes**。Server **唔**因此改 NAS 上原檔、**唔** recompress。

```json
{
  "sourceFileId": 123456,
  "name": "IMG_20261029_153012.jpg",
  "originalContentHash": "a1b2c3d4e5f6789012345678abcdef01",
  "compressedContentHash": "11223344556677889900aabbccddeeff",
  "originalSize": 4821934,
  "compressedSize": 410000,
  "qualityClass": "person",
  "jpegQuality": 92,
  "localMode": "replace_local",
  "motionPolicy": "split",
  "motionVideoContentHash": "99887766554433221100ffeeddccbbaa",
  "deviceId": "xiaomi-14t-pro",
  "idempotencyKey": "local-shrunk:a1b2...:xiaomi-14t-pro"
}
```

Response：`{ "ok": true, "deduped": false }`。  
用途：跨裝置 skip、統計；**唔係**壓縮引擎。

### 4.4 （非目標／明確不做）上載壓縮檔畀 server 再壓或落地為主路徑

| 舊／易混淆 | 本 SPEC |
|---|---|
| `POST /api/backup/upload` 首次上傳原檔 | **不做** |
| `POST /api/archive/submit` 上載壓縮 JPEG 去 `*_compressed` | **非 MVP 主路徑**；主目標係本機空間。若將來要 NAS 端亦留壓縮 copy，另開 RFC，且 server 只 **存檔、唔 recompress** |
| `POST /api/archive/replace` 叫 server 覆寫 NAS 原檔 | **非 MVP**；本 App 覆寫嘅係**手機**檔 |
| Server-side JPEG quality 再壓 | **永遠不做**（non-goal） |

### 4.5 `POST /api/archive/classify-preview`（可選）

細圖 → labels（唔持久化、**唔壓縮原圖**）。可帶 `sourceFileId`：庫內已有 tag 直接回。

### 4.6 `GET /api/archive/pair/:motionPairId`（可選）

若有 mark-local-shrunk 紀錄，查本機縮小狀態；**唔**代表 server 存咗短片。

---

## 5. Compression rules（全部喺 Android）

1. **偵測 Motion Photo**（本機）：JPEG 尾部／XMP `MotionPhoto`／`MicroVideo`。  
2. **人物 (`person`)**（本機）：  
   - 靜態：剝 trailer → JPEG quality **92** → replace／archive **本機**  
   - 短片：trailer **原樣**另存本機 MP4（MVP 唔再壓）→ 與 still 用 `motionPairId` 互聯  
3. **食物／收據／其他**（本機）：剝 trailer（丟短片）→ quality **80／60／85** → 只留本機靜態圖。  
4. **HEIC**：本機能解碼則轉 JPEG 再壓；唔能 → 失敗列。  
5. **EXIF**：預設保留時間／GPS（可關 GPS）；寫 `CompressedBy=SilverFS-Android-Local`、`QualityClass=...`。  
6. **同 PC 工具語意對齊**（演算法），但 **執行位置係手機**；PC `compress-strip-motion.cjs` 繼續只服務 NAS／桌面。

### 5.1 本機落地（慳空間）

**`replace_local`（預設）**

```text
Before:  /storage/.../DCIM/Camera/IMG_xxx.jpg          (e.g. 4.8 MB, maybe with motion)
After:   /storage/.../DCIM/Camera/IMG_xxx.jpg          (compressed still, e.g. 0.4 MB)
Optional bak (until confirmed):
         /storage/.../SilverFS_bak/IMG_xxx.jpg
Person motion:
         /storage/.../Pictures/SilverFS_Motion/IMG_xxx_motion.mp4
```

**`archive_local`**

```text
Original kept:  .../DCIM/Camera/IMG_xxx.jpg
Compressed:     .../Pictures/SilverFS_Compressed/2026/10/IMG_xxx.jpg
Person motion:  .../Pictures/SilverFS_Compressed/motion/IMG_xxx_motion.mp4
```

用家之後可刪原相；App 可提供「刪已確認備份嘅原相」批量（要二次確認）。

---

## 6. Storage path — Server vs Phone

| 位置 | 角色 |
|---|---|
| Server／NAS（例 `H:\...\2026\10\`） | **原檔備份所在**（由其他 App 放入）；lookup 對呢度；MVP **唔改**呢啲檔 |
| Android 本機相簿 | **要慳空間嘅對象**；壓縮＋replace／archive 發生喺呢度 |
| 本機 `SilverFS_Compressed`／`SilverFS_Motion`／`SilverFS_bak` | 本機 archive／短片／臨時備份 |

Config（server，可選）：`archive.android.trackLocalShrunk=true`。  
**冇** `archive.android.recompressOnServer`——呢個 flag 唔應存在。

---

## 7. Offline queue / retries / privacy

- 本機 Room／SQLite queue：uri、name、hashes、`sourceFileId`、localMode、狀態。  
- **未 lookup 成功** → `awaiting_library`；**唔會**自動上傳原檔，**亦唔會**本機縮小。  
- 無網：可本機預覽壓縮效果，但 **replace_local 必須先有成功 matched lookup**（可用上次快取嘅 matched，TTL 可調；預設要在線核一次）。  
- Wi‑Fi only 主要管 lookup／mark API；純本機壓縮計算唔使網。  
- 失敗指數退避；JWT 過期保留 queue。  
- 私隱：可剝 GPS；classify-preview 臨時圖唔持久化。  
- 人物短片設定寫明會本機另存；非人物短片唔留。

---

## 8. MVP phases

### Phase 0 — Server stubs（閘門，唔係壓縮引擎）

- Migration：`mobile_local_shrink_events`（deviceId、sourceFileId、hashes、sizes、quality、motionPolicy）  
- `POST /api/archive/lookup`（+ batch；**name then hash**；回 `safeToShrinkLocal`）  
- `POST /api/archive/mark-local-shrunk`（metadata only）  
- 可選 classify-preview  
- curl smoke：matched／mismatch／not_found／idempotent mark  
- **驗收**：code path **零** JPEG encode／quality recompress on server

### Phase 1 — Android MVP（本機壓縮慳空間）

- Onboarding（強調：其他 App 先上傳；本 App **本機壓縮慳空間**；server 只查庫）  
- Login + 權限  
- 手動選相 → lookup → 未在庫唔縮  
- **本機** Motion：人物 split；其他 strip  
- **本機** JPEG 品質表；手動四類  
- 壓縮預覽（本機 before/after size）→ queue → `replace_local`  
- Settings：本機模式、品質、Motion  
- 可選 mark-local-shrunk

### Phase 2 — Smart classify + 自動掃

- classify-preview／庫內 tags  
- MediaStore observer：只對 **matched** 自動入 queue  
- Batch lookup  
- `archive_local` +「確認後刪原相」  
- 統計累計慳咗幾多 GB

### Phase 3 — Polish

- HEIC、雙 tag、bak 清理策略  
- 多機 already_local_shrunk  
- （可選 RFC）同步一份壓縮 copy 去 NAS——**仍然唔喺 server recompress**

---

## 9. Open questions

1. **`not_found` 要唔要 deep link 去另一個上傳 App？**  
2. **多個同名 UI**：列表揀 path，定強制 pathHint？  
3. **庫內無 hash**：server 即時讀碟計 hash，定禁止 `replace_local`？  
4. **`replace_local` 本機 bak 保留幾耐？** 確認後可唔可以一掣清空？  
5. **`originalContentHash` MD5 vs SHA-256？** MVP 對齊 `md5`。  
6. **快取 matched lookup 離線幾耐仍准縮？**  
7. **GPS／截圖相簿** 預設排除？  
8. **人物短片本機放邊？** 獨立 `SilverFS_Motion` vs 同相簿？  
9. **Quota**：每日本機處理張數？  
10. **App 分發**：內部分 APK vs Play 內測？  
11. **雙 tag person+food → q80 兼 strip 短片**：用家接受？  
12. **將來要唔要可選把壓縮版亦 copy 去 NAS？**（另 RFC；server 只存唔壓）

---

## 10. Implementation notes（畀之後 coding agent）

- 新 route：`lib/android-archive.js`——**lookup + mark**；**禁止**引入 server-side sharp／mozjpeg recompress。  
- Lookup **必須** name-first；`safeToShrinkLocal` 只喺 hash OK 時為 true。  
- Android：壓縮用本機 encoder；WorkManager 跑 batch；MediaStore 更新 size。  
- Hash 公式同 `computeQuickHash` bit-identical。  
- Label 同 `config/embed-categories.json` 一字不差。  
- 測試：人物 Motion → 本機圖+mp4；食物 Motion → 只有本機圖；not_found／hash mismatch → 本機檔 size 唔變。  
- Commit／PR 唔寫 secret。

---

## 11. Acceptance criteria（實作時）

- [ ] 庫內已有原檔：lookup `matched` + `safeToShrinkLocal:true` → **本機**壓縮後檔細咗；**NAS 原檔 size 不變**（MVP）。  
- [ ] Server 日誌／code：**無**對呢條路徑做 JPEG recompress。  
- [ ] `not_found`／`name_match_hash_mismatch` → 本機原檔完全唔改。  
- [ ] 同一張重複 → skip／mark `deduped`。  
- [ ] `person`/`food`/`docs` 本機 quality 92／80／60。  
- [ ] 非人物 Motion：本機靜態無 trailer、無另存短片。  
- [ ] 人物 Motion：本機靜態 q92 無 trailer + 本機獨立 MP4；pair 可互查。  
- [ ] `replace_local`：MediaStore 顯示新 size；可選 bak。  
- [ ] Wi‑Fi only 管 API；JWT 過期 queue 保留。  
- [ ] UI／文案清楚寫「慳手機空間」，唔寫「上載去 server 壓縮」。

---

## 12. UI Design（詳細 — 本機壓縮慳空間）

設計原則：Material 3；SilverFS 深色風；**Dark mode**；觸控 ≥ 48dp；繁中為主。文案用「本機壓縮／慳空間／縮小本機檔」，避免「上載壓縮去伺服器」。

### 12.1 Navigation map

```text
Splash / Onboarding — 其他 App 先上傳；本 App 本機壓縮慳空間；server 只查庫
    └─ Server URL + Login
         └─ Permission gate
              └─ Main (Bottom nav)
                   ├─ Shrink（預設）— 揀相 / 開始本機壓縮
                   ├─ Queue — 本機處理隊列
                   └─ Settings
              疊加：
                   Gallery picker
                   Category review
                   Compress preview（本機 before/after）
                   Not in library
                   Already shrunk
                   Disambiguation
                   Space saved summary
```

### 12.2 Screen-by-screen

#### A. Onboarding（3 頁）

| 頁 | 標題 | 內文重點 | 主按鈕 |
|---|---|---|---|
| 1 | 慳手機空間 | 相已由其他 App 上載；呢度**喺手機壓縮**，釋放空間 | 下一頁 |
| 2 | 先查庫再縮 | 檔名→雜湊確認伺服器已有原檔，先至安全縮小本機 copy | 下一頁 |
| 3 | 人物動態相 | 人物：本機圖+短片分開；其他：只留壓縮圖；伺服器**唔再壓** | 開始設定 |

**Wireframe**

```text
┌─────────────────────┐
│ ○ ○ ●               │
│   [Illustration]    │
│  慳手機空間          │
│  壓縮喺 Android 本機 │
│  Server 只查庫閘門   │
│  人物短片本機分開存  │
│  [ 開始設定 ]        │
└─────────────────────┘
```

#### B. Login / Server URL

Server URL、Username、Password、測試連線、登入。JWT → EncryptedSharedPreferences。

#### C. Permission gate

`READ_MEDIA_IMAGES`／（replace 可能要）寫入相簿權限／通知。唔强制 MANAGE_EXTERNAL_STORAGE。

#### D. Main — Shrink tab

- 今日摘要：「待縮小 N」「今日已慳 X MB」「未在庫 U」「已 skip K」「人物短片 P」。  
- 主 CTA：`揀相片本機壓縮`、`處理今日相機相`。  
- Banner：「未在庫請先用備份 App 上傳；本 App 唔上傳原檔、亦唔喺伺服器壓縮」。

**Wireframe**

```text
┌─────────────────────┐
│ SilverFS Shrink     │
│ ┌─今日摘要─────────┐ │
│ │ 待縮小 128        │ │
│ │ 已慳 1.2 GB       │ │
│ │ 未在庫 7 · skip 9 │ │
│ └───────────────────┘ │
│ [ 揀相片本機壓縮 ]   │
│ [ 處理今日相機相 ]   │
│ 模式：replace 本機檔 │
│ ════ Local Queue ══ │
└─────────────────────┘
```

#### E. Gallery picker

系統 Photo Picker；Motion「Live」badge；下一步 → Category review。

#### F. Category review

縮圖 + qualityClass chip；Motion：`Live→本機分開`／`Live→剝走`；四掣覆寫。

#### G. Compress preview（本機）

Before／after **本機**預估 size；合計將慳；人物「短片將本機另存」；底 CTA：`加入本機壓縮隊列`（**唔**寫「上載歸檔」）。

#### H. Local queue

狀態：`lookup` → `compressing_on_device` → `replacing_local`／`archiving_local` → `done`／`skipped`／`not_in_library`／`hash_mismatch`／`error`。  
人物 pair 子列短片。Bulk：暫停／重試／清空完成。  
**唔提供**「改為上傳原檔」或「交伺服器壓縮」。

#### I. Not in library / Conflict / Already shrunk / Disambiguation

| 狀態 | UI |
|---|---|
| `not_found` | 「未在伺服器圖庫」→ 唔縮小；提示其他 App 先上傳 |
| `already_local_shrunk` | Skip；顯示已慳 size |
| `name_match_hash_mismatch` | 警告；唔改本機檔 |
| `needs_disambiguation` | 列表揀 path 再繼續 |
| `replace_local` 確認 | Dialog：會改本機相簿檔；server 原檔唔變 |

#### J. Settings

1. 連線：URL、帳號、登出、deviceId  
2. 網絡：Wi‑Fi only（lookup／mark）  
3. **本機模式**：`覆寫本機原檔（慳空間，建議）`／`寫入本機 *_Compressed 資料夾`  
4. 自動掃描；充電先跑  
5. 品質覆寫：92／80／60／85  
6. Motion：人物本機分開存短片（預設 ON）  
7. 私隱：GPS、EXIF  
8. 關於：寫明「壓縮僅喺本機；伺服器唔再壓」

### 12.3 Key components

| Component | 用途 |
|---|---|
| `QualityClassChip` | person/food/docs/other + q |
| `MotionBadge` | Live→本機分開 / Live→剝走 |
| `SpaceSavedHeader` | 今日／累計慳 MB |
| `QueueItemRow` | 圖+可選短片子列 |
| `BeforeAfterSize` | `12.4 MB → 1.1 MB`（本機） |
| `LibraryStatusChip` | 在庫可縮／未在庫／已縮／hash 不符 |
| `SafeShrinkBanner` | 已確認 server 有原檔 |

### 12.4 Empty / error states

| 場景 | 文案方向 | CTA |
|---|---|---|
| 未登入 | 請先連線以便查庫 | 去登入 |
| 無權限 | 無法讀取／寫入相片 | 開設定 |
| Queue 空 | 暫無本機壓縮任務 | 揀相片 |
| 全部未在庫 | 請先用備份 App 上傳；本 App 唔會縮未備份檔 | 好 |
| 全數已縮 | 所選本機都已壓縮 | 返回 |
| hash 不符 | 檔名相同但內容唔同，已跳過（本機未改） | 詳情 |
| 短片失敗、圖成功 | 圖已縮小，短片另存失敗 | 只重試短片 |

### 12.5 Dark mode / 12.6 Accessibility

跟隨系統；大字；Motion 讀屏：「動態相片，將喺本機分開儲存短片」／「只保留靜態圖」。

### 12.7 Copy deck（主要字串）

| key | zh-HK |
|---|---|
| `onboarding.role.title` | 慳手機空間 |
| `onboarding.role.body` | 相片請先用其他 App 上傳到伺服器；本 App 喺手機壓縮，釋放空間。伺服器唔會再壓。 |
| `onboarding.lookup.body` | 先用檔名搵庫內檔，再用雜湊核對；確認已備份先縮小本機 copy。 |
| `onboarding.motion.body` | 人物會喺本機分開儲存相片同短片；其他類別只保留壓縮相片。 |
| `main.cta` | 揀相片本機壓縮 |
| `preview.motion.split` | 將喺本機另存動態短片（唔再壓縮） |
| `preview.motion.strip` | 會移除動態短片，只留壓縮相片 |
| `queue.compressing` | 本機壓縮中 |
| `queue.replacing` | 覆寫本機檔 |
| `status.not_in_library` | 未在庫（唔縮小） |
| `status.already_shrunk` | 本機已壓縮，已跳過 |
| `status.hash_mismatch` | 同名但內容唔同 |
| `conflict.not_found` | 伺服器未有呢張相，請先用備份 App 上傳 |
| `settings.mode.replace` | 覆寫本機原檔（慳空間） |
| `settings.mode.archive` | 寫入本機 Compressed 資料夾 |
| `settings.note.no_server_recompress` | 壓縮只喺手機進行；伺服器只負責查庫 |
| `settings.wifi_only` | 只在 Wi‑Fi 查庫 |

---

*End of spec.*

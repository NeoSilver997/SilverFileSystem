# Android Compress Archive — Product + API Spec

> SilverFileSystem 手機壓縮歸檔規格（Android）  
> 狀態：**Proposed** · 分支：`feature/face-detection`  
> 相關：每日 pipeline（thumb → embed → classify）、`scripts/compress-strip-motion.cjs`、`config/embed-categories.json`、`lib/auth.js` JWT  
> 本文件**唔包含**密碼、JWT secret、Google secret；設定一律經 server `loadConfig()` / `.env`。  
> **本階段只寫 SPEC，唔實作 Android app。**  
> 更新（本版）：相已由**其他 App 上傳到 server**；本 App **只做壓縮＋歸檔**，**唔做主上傳**。查重：**先檔名，再 hash 核對**。人物 Motion Photo 仍**分開儲存**靜態圖 + 短片；品質表同 UI 改為歸檔流程。

---

## 0. Summary

用家相已經由**另一個備份／同步 App**（例如既有 MobileBackup、廠商雲、手動 copy）上載到 SilverFS 可見路徑（例如 `H:\...\DCIM\Camera\...`）。  
呢個 Android App **唔負責第一次入庫**；職責係：

1. 喺手機本機搵相 → 用 **檔名先查 server**，再以 **content hash 核對**係咪同一張  
2. 按類別 **有損壓縮**（＋人物 Motion 拆短片）  
3. 將壓縮結果 **歸檔**到 server 約定路徑（或要求 server **in-place 覆寫**成壓縮版）

| 內容類（中文） | SilverFS embed label | JPEG quality |
|---|---|---:|
| 人物 | `人物單人` / `人物合照` | **92** |
| 食物 | `食物` | **80** |
| 收據／餐牌／資料 | `收據餐牌資料` | **60** |
| 其他（風景、動物、截圖…） | 其餘 label／`其他` | **85**（預設，可調） |

**Motion Photo 規則（重要）**

| qualityClass | Motion Photo 處理 |
|---|---|
| `person`（人物） | **分開儲存**：靜態 JPEG（q92）+ 獨立 MP4 trailer；用 `originalContentHash`／`motionPairId` 互聯 |
| `food` / `docs` / `other` | **剝走短片**（只歸檔壓縮 JPEG；唔另存 MP4），同 PC `compress-strip-motion.cjs` 語意一致 |

伺服器端對齊現有 Express + MySQL（`scanned_files`、`folder_tree`、embedding／classify）。本 SPEC 提出 **lookup／archive** endpoints（見 §4）；查重會對齊現有 `name`＋`hash`／`md5`／`quick_hash` 語意。

**一句話**：其他 App 負責「原檔入庫」；本 App 負責「搵到庫內檔 → 壓縮 → 歸檔／替換」。

---

## 1. Goals / Non-goals / UX

### 1.1 Goals

1. Android 上對**已在 server 庫內**（或即將對齊）嘅相做 **lossy JPEG 壓縮**；非人物類 **剝走** Motion Photo trailer；**人物類** **拆開**靜態圖同短片分開歸檔。  
2. 查庫順序：**先檔名（basename）** → 命中後用 **content hash 核對**（避免同名唔同相）。  
3. 按內容類別揀 JPEG quality（上表）。  
4. 歸檔模式可選（設定）：  
   - **`archive_path`（預設）**：壓縮版寫去平行 archive 路徑（例：`...\2026\10_compressed\`），原路徑保留原檔  
   - **`replace_in_place`**：server 將庫內原檔換成壓縮版（先備份再覆寫；危險，要二次確認）  
5. 支援 **手動選相** 同 **自動掃描本機相簿**，只處理「庫內已有對應檔」嘅項目；未入庫嘅相標記「未在庫／請用其他 App 先上傳」。  
6. 顯示進度：排隊、查檔名、核 hash、壓縮中、上載歸檔、已 skip、失敗重試；人物類另顯示「短片已分開歸檔」。  
7. 設定：**只限 Wi‑Fi**（預設開）、可選充電先跑、每批上限、品質覆寫、歸檔模式。  
8. 歸檔完成後 server 更新 `scanned_files` 大小／清 hash，之後可由現有 daily pipeline 補 thumb／embed／tag。

### 1.2 Non-goals（明確不做 — MVP）

- **唔做「第一次上傳原檔入庫」**——呢個係其他 App／手動同步嘅責任。  
- 唔取代現有 PC 端 `compress-strip-motion.cjs`／`/tree` 手動整理（本 App 係手機側同類能力）。  
- 唔做 iOS（可另開 SPEC）。  
- 唔做「相簿入面獨立拍攝長片／純 MP4」全庫歸檔（人物 Motion trailer 除外）。  
- 唔喺手機上訓練模型；唔強制離線高精度分類。  
- 唔做端到端加密雲（檔案以用家自有 NAS／`H:` 路徑落地，靠現有 JWT＋權限）。  
- 唔一次過重做全庫 70 萬張舊相壓縮（那是 server job／PC 腳本）。  
- 唔假裝自己係完整 MobileBackup 客戶端（無「未入庫就自動首次上傳」）。

### 1.3 UX flow（高層 — 歸檔）

```text
[Onboarding] → [登入 / Server URL] → [權限]
    ↓
[設定]  Wi‑Fi only · 歸檔模式(archive/replace) · 品質表 · Motion 開關
    ↓
[圖庫揀相] → [類別覆核] → [壓縮預覽 before/after] → [確認歸檔]
    ↓
每張：讀本機檔 → 偵測 Motion → 分類 → 定 quality
    ↓
POST /api/archive/lookup  （先 name，再可選 hash 核對）
    ├─ not_found          → UI「未在庫」→ 提示用其他 App 先上傳（本 App 唔上傳原檔）
    ├─ name_match_hash_mismatch → UI「同名唔同檔」→ skip／人手處理
    └─ matched            → 繼續
    ↓
  ┌─ person + Motion ──► 拆 still + mp4
  │     still: strip trailer → hash → compress q92 → archive image
  │     mp4:   extract trailer → hash(video) → archive motion-video（link pair）
  └─ 其他 (+ Motion) ──► strip trailer（丟短片）→ hash → compress → archive image only
    ↓
POST /api/archive/submit（或 replace）→ 完成通知
```

詳細畫面、元件、空態／錯態見 **§12 UI Design**（已改為歸檔用語）。

---

## 2. Classification（點樣決定類別）

### 2.1 目標 mapping

App 內部用 **quality class** 三＋一：

| `qualityClass` | 對應 SilverFS labels | quality |
|---|---|---:|
| `person` | `人物單人`, `人物合照` | 92 |
| `food` | `食物` | 80 |
| `docs` | `收據餐牌資料` | 60 |
| `other` | `風景`/`動物`/`貓`/`狗`/`車`/`花卉`/`螢幕截圖`/`其他`/unknown | 85 |

雙 tag（dual tag，cosine ≥ 0.50）時：**取較「保守」quality**（數字較低＝壓多啲），即 `min(q1,q2)`。  
例：`人物單人`+`食物` → quality 80（唔好用 92 令食物檔過大）。

**Motion 決策跟最終 `qualityClass`**：若覆寫／雙 tag 結果變成非 `person`，即使原檔係 Motion Photo，亦 **只 strip、唔另存短片**。只有最終 class = `person` 先分開存 MP4。

### 2.2 推薦做法（實用）

**線上（優先）**

1. App 產生細 thumbnail（最長邊 ≤ 512，JPEG q70）打 **`POST /api/archive/classify-preview`**（見 §4.6）。  
2. Server 用現有 EmbeddingGemma + `lib/embed-classifier.js` + `config/embed-categories.json` 做 cosine prototype classify。  
3. 回 `labels[]` + scores → App map 去 `qualityClass`。  
4. 若 lookup 已命中 `fileId` 且庫內已有 classify tag，可直接用 server labels（唔使再傳 preview）。

**離線 fallback（無網／server 忙）**

1. 用家手動 tag（四掣：人物／食物／文件／其他）— 最準、MVP 必備。  
2. 輕量 heuristic（可選）：EXIF／檔名 + ML Kit Face → `person`；文字密集 → `docs`；其餘 → `other@85`。  
3. **唔建議** MVP 就上完整 on-device image classifier。

### 2.3 用家覆寫

每張／每批可強制 `qualityClass`。覆寫優先過 API／heuristic。  
伺服器應記錄 `client_quality_class` 同 `server_labels`（若有），方便之後 audit。

---

## 3. Identity：檔名先，再 hash

### 3.1 對齊現有 DB

`scanned_files` 相關欄位：

| Column | 用途（現況） |
|---|---|
| `name` / path basename | **第一輪 lookup 鍵** |
| `path` | 完整路徑；可區分多碟同名 |
| `hash` | 完整／主要內容 hash（唔保證每列都有） |
| `md5` | 全檔 MD5 |
| `quick_hash` | `MD5( head[0..min(64KiB,size)] ∥ tail[last min(64KiB,size)] ∥ ascii(size) )` |
| `size` | 檔案大小（弱核對） |

### 3.2 Lookup 順序（強制）

```text
1) basename（例：IMG_20261029_153012.jpg）
   → 0 命中：not_found（未在庫）
   → 1 命中：進入 hash 核對
   → N 命中：回 candidates[]；client 用 hash／size／capturedAt 收窄；仍多過一個 → needs_disambiguation

2) hash 核對（client 提供；對「剝 Motion 後、壓縮前」靜態圖 bytes）
   - originalContentHash = MD5(strip_motion(original_bytes))  （hex lowercase）
   - 可選 originalQuickHash（同 server computeQuickHash）
   - 可選 originalSize、capturedAt

   核對結果：
   - hash_match（或 md5／quick_hash+size 強／中匹配）→ matched
   - 有 name 命中但 hash 唔對 → name_match_hash_mismatch（唔好盲目壓縮覆蓋）
   - 庫內該列仲未有 hash：回 needs_hash_verify；server 可即時對碟上檔計 hash（I/O），或等 client 上傳 quick_hash 再比
```

**原則**：檔名只係入口；**未通過 hash（或明確「庫內無 hash + 用家確認」）唔好 replace_in_place**。`archive_path` 模式喺只有 name 命中、hash 未核時，可允許「寫入 archive 但標記 `unverifiedPairing: true`」（設定預設：**唔允許**，要 hash OK）。

### 3.3 App 要計嘅 hash

對**每一張靜態圖**：

1. **`originalContentHash`** — 全檔 MD5；對象：剝走 Motion trailer 之後、JPEG 有損重壓**之前**。  
2. **`originalQuickHash`（可選）** — 同上 bytes，server 同一套 quick_hash。  
3. **`compressedQuickHash` + `compressedSize`** — 歸檔後 server 對落地檔再計（權威）。

對**人物類拆出嘅短片**：

4. **`motionVideoContentHash`** — 純 MP4 bytes 全檔 MD5。  
5. **`motionPairId`** — 建議 = `originalContentHash`（靜態圖）。

### 3.4 「已壓縮歸檔」判斷

除咗 identity lookup，仲要知「呢張係咪已經做過壓縮歸檔」：

- `mobile_archive_jobs`／`mobile_archive_outputs` 有同一 `sourceFileId` + `originalContentHash` 且 status=done  
- 或 archive 路徑已存在對應檔（見 §6）  
- 或 `replace_in_place` 後原 path 已係壓縮版（靠 metadata flag `compressedBy=android-archive`／EXIF comment／DB 欄）

已做過 → UI **Skip（已歸檔）**，唔重複傳。

---

## 4. Proposed REST API

Base URL（示例）：`https://medialib2.tcghk.trade`  
Auth：所有 `/api/archive/*` 要 `Authorization: Bearer <JWT>`（`requireAuth` + `requirePhotoPermission`）。  
登入重用：`POST /api/auth/login` → `{ token, user }`。

> **現況**：repo **未有** 呢批 archive endpoint → **全部為新增**。舊稿 `/api/backup/upload` 語意（首次上傳）**唔採用**；改用 lookup + submit／replace。

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

欄位說明：`name` **必填**；hash／size／capturedAt／pathHint **強烈建議**（有先核得準）。

**Response 200 — matched**

```json
{
  "status": "matched",
  "matchType": "name_then_hash",
  "fileId": 123456,
  "path": "H:\\silverchan\\Photos\\MobileBackup\\Xiaomi 14T Pro\\DCIM\\Camera\\2026\\10\\IMG_20261029_153012.jpg",
  "name": "IMG_20261029_153012.jpg",
  "size": 4821934,
  "alreadyArchived": false,
  "archivePath": null,
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
  "hint": "Upload original with your backup app first"
}
```

**Response 200 — name_match_hash_mismatch**

```json
{
  "status": "name_match_hash_mismatch",
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

**Response 200 — needs_disambiguation**（多個同名）

```json
{
  "status": "needs_disambiguation",
  "candidates": [
    { "fileId": 1, "path": "H:\\...\\2026\\10\\IMG_....jpg", "size": 1, "quickHash": "..." },
    { "fileId": 2, "path": "P:\\...\\IMG_....jpg", "size": 2, "quickHash": "..." }
  ]
}
```

**Response 200 — already_archived**

```json
{
  "status": "already_archived",
  "fileId": 123456,
  "path": "H:\\...\\10\\IMG_....jpg",
  "archivePath": "H:\\...\\10_compressed\\IMG_....jpg",
  "archivedAt": "2026-10-29T20:00:00+08:00",
  "motionVideoArchivePath": "H:\\...\\10_compressed\\motion\\IMG_...._motion.mp4"
}
```

**Errors**：`401`／`403`／`400`（缺 name）。

### 4.2 `POST /api/archive/lookup/batch`

一次最多 100 項（每項至少 `name`；建議連 hash）。回 `results[]`，每項同單筆 `status`。

### 4.3 `POST /api/archive/submit`（預設：寫 archive 路徑）

將**壓縮後**靜態圖寫入 archive 路徑；**唔改**原 path 檔案（除非另見 replace）。

Multipart form：

| Field | Type | 說明 |
|---|---|---|
| `file` | file | 壓縮後 JPEG（必填） |
| `sourceFileId` | int | lookup 得到嘅 `fileId`（必填） |
| `name` | string | basename（必填；須同 source 一致） |
| `originalContentHash` | string | 必填；server 再核對 |
| `originalQuickHash` | string | 可選 |
| `originalSize` | int | 剝 Motion 後、壓縮前 |
| `compressedSize` | int | client 聲稱 |
| `quality` | int | 用過嘅 JPEG quality |
| `qualityClass` | string | `person`\|`food`\|`docs`\|`other` |
| `clientLabels` | string | JSON array，可選 |
| `deviceId` | string | 裝置識別 |
| `hadMotionPhoto` | string | `"true"`/`"false"` |
| `motionPolicy` | string | `split`\|`strip`\|`none` |
| `motionPairId` | string | 人物+Motion 時必填 |
| `motionVideoPending` | string | `"true"` 若稍後再交短片 |
| `mode` | string | 固定建議 `"archive_path"` |
| `idempotencyKey` | string | 建議：`archive:` + `sourceFileId` + `:` + `originalContentHash` |

**Response 201**

```json
{
  "ok": true,
  "mode": "archive_path",
  "sourceFileId": 123456,
  "archiveFileId": 123500,
  "archivePath": "H:\\silverchan\\Photos\\MobileBackup\\Xiaomi 14T Pro\\DCIM\\Camera\\2026\\10_compressed\\IMG_20261029_153012.jpg",
  "size": 412088,
  "quickHash": "aabbccddeeff00112233445566778899",
  "deduped": false,
  "motionPairId": "a1b2c3d4e5f6789012345678abcdef01",
  "expectMotionVideo": true
}
```

若已歸檔：**200** + `{ "ok": true, "deduped": true, ... }`。

Hash 同 `sourceFileId` 對唔上：**409** `{ "ok": false, "error": "hash_mismatch" }`。

### 4.4 `POST /api/archive/replace`（進階：in-place 覆寫）

語意：對 `sourceFileId` 指向嘅**原 path**，先備份（server 側 `_bak_before_compress` 或等價）再寫入壓縮 JPEG。

- 同樣 multipart 欄位；`mode` = `"replace_in_place"`。  
- **必須** `originalContentHash` 同碟上現檔一致，否則 409。  
- Response 含 `backupPath`、`path`（同一原 path）、`previousSize`、`size`。  
- App UI 必須二次確認；Settings 預設 **關閉** 此模式。

### 4.5 `POST /api/archive/submit-motion-video`

人物 Motion 短片歸檔（只喺 `motionPolicy=split`）。

| Field | 說明 |
|---|---|
| `file` | 抽出嘅 MP4 |
| `sourceFileId` | 靜態圖對應庫內 id |
| `motionPairId` | 同靜態圖 |
| `motionVideoContentHash` | MP4 MD5 |
| `mode` | `archive_path` 或 `replace_in_place`（短片唔 replace 原 JPG；只寫 `motion\` 目錄） |
| `idempotencyKey` | `motion:` + hash |

落地建議：`{archiveOrSourceDir}/motion/{basename}_motion.mp4`。

### 4.6 `POST /api/archive/classify-preview`（可選）

細圖 → labels（唔持久化）。可帶 `sourceFileId`：若庫內已有 tag 直接回，唔跑 embedding。

### 4.7 `GET /api/archive/pair/:motionPairId`

查靜態圖／短片 archive 路徑同狀態。

### 4.8 明確唔做／廢棄語意

| 舊／易混淆 | 本 SPEC |
|---|---|
| `POST /api/backup/upload` 首次上傳原檔 | **不做**（其他 App） |
| `POST /api/backup/check-hash` 只靠 hash | 改為 **`/api/archive/lookup`：name → hash** |
| App 當完整 backup client | **只係 compress + archive** |

---

## 5. Compression rules

1. **偵測 Motion Photo**：掃描 JPEG 尾部／XMP `MotionPhoto`／`MicroVideo`；有 MP4 trailer 則標記。  
2. **人物 (`person`)**：  
   - 靜態：剝 trailer → JPEG quality **92** → 歸檔  
   - 短片：trailer **原樣**另存 MP4（MVP 唔再壓）→ 歸檔到 `motion\`  
3. **食物／收據／其他**：剝 trailer（丟短片）→ 對應 quality **80／60／85** → 只歸檔靜態圖。  
4. **HEIC**：能解碼則轉 JPEG 再按上表；唔能解碼 → 失敗列，可手動 skip。  
5. **EXIF**：預設保留時間／GPS（設定可關 GPS）；寫入標記 `CompressedBy=SilverFS-Android-Archive`、`QualityClass=...`。  
6. **同 PC 工具對齊**：非人物行為同 `scripts/compress-strip-motion.cjs`；人物多咗「短片分開歸檔」。

---

## 6. Storage path / folder mapping

假設原檔已在（由其他 App 放好）：

```text
H:\silverchan\Photos\MobileBackup\<Device>\DCIM\Camera\2026\10\IMG_xxx.jpg
```

**`archive_path`（預設）**

```text
H:\...\DCIM\Camera\2026\10_compressed\IMG_xxx.jpg
H:\...\DCIM\Camera\2026\10_compressed\motion\IMG_xxx_motion.mp4   # 僅 person+Motion
```

（對齊先前 PC 操作：壓縮版喺 `10_compressed`，原 `10` 保留。）

**`replace_in_place`**

```text
H:\...\DCIM\Camera\2026\10\IMG_xxx.jpg          # 變成壓縮版
H:\...\DCIM\Camera\2026\10\_bak_before_compress\IMG_xxx.jpg  # server 備份
H:\...\DCIM\Camera\2026\10\motion\IMG_xxx_motion.mp4         # 人物短片
```

Config key 建議：`archive.android.root`、`archive.suffix=_compressed`、`archive.allowReplace=false`。

歸檔後：更新／插入 `scanned_files`；清掉舊 hash 以便 thumb／embed 重做；可 enqueue 細批 `thumb-hash`。

---

## 7. Offline queue / retries / privacy

- 本機 Room／SQLite queue：每項含 uri、name、hashes、`sourceFileId`（lookup 後）、mode、狀態。  
- **未 lookup 成功**（`not_found`）→ 狀態 `awaiting_library`；**唔會**自動改去上傳原檔。  
- Wi‑Fi only；失敗指數退避；JWT 過期保留 queue。  
- 私隱：可剝 GPS；classify-preview 臨時圖唔持久化。  
- 人物短片設定頁寫明會另存；非人物短片唔歸檔。

---

## 8. MVP phases

### Phase 0 — Server stubs

- Migration：`mobile_archive_jobs`、`mobile_archive_outputs`、`mobile_archive_motion_videos`  
- `POST /api/archive/lookup`（+ batch；**name then hash**）  
- `POST /api/archive/submit`（archive_path）  
- `POST /api/archive/replace`（可先 feature-flag 關）  
- `POST /api/archive/submit-motion-video`  
- 可選 classify-preview、pair GET  
- curl smoke：同名命中、hash mismatch、not_found、idempotent submit

### Phase 1 — Android MVP

- Onboarding（強調：其他 App 先上傳；本 App 壓縮歸檔）  
- Login + 權限 + Wi‑Fi only  
- 手動選相 → lookup → 未在庫提示  
- Motion：人物 split；其他 strip  
- JPEG 品質表；手動四類  
- 壓縮預覽 → submit queue  
- Settings：archive 模式、品質、Motion

### Phase 2 — Smart classify + 自動掃

- classify-preview／沿用庫內 tags  
- MediaStore observer：只對 **lookup matched** 自動入 queue  
- Batch lookup  
- 歸檔後觸發 thumb job  
- Pair 詳情

### Phase 3 — Polish

- replace_in_place 完整備份流程、雙 tag、HEIC、統計慳幾多 MB  
- 同 PC `_compressed` 對賬報告  
- Refresh token、多 profile

---

## 9. Open questions

1. **`not_found` 時要唔要 deep link 去「另一個上傳 App」？** 定只顯示文案？  
2. **多個同名（needs_disambiguation）UI**：列表揀 path，定強制要 pathHint？  
3. **庫內無 hash**：server 即時讀碟計 hash（可能慢）定標記 `unverified` 只准 archive_path？  
4. **replace_in_place 備份保留幾耐？** 用家確認後可唔可以 API 刪 `_bak`？  
5. **`originalContentHash` MD5 vs SHA-256？** MVP 對齊 `md5`；長遠可加 sha256。  
6. **已存在未壓縮原檔 + 已有 `_compressed`**：skip 定允許更高／更低 quality 再壓？  
7. **GPS／截圖相簿** 預設排除？  
8. **Embedding 未起**：自動掃用 `other@85` 定暫停？  
9. **Quota**：每日歸檔張數／GB？短片計唔計？  
10. **App 分發**：內部分 APK vs Play 內測？  
11. **H: 離線**：server staging 再搬？  
12. **雙 tag person+food → q80 兼 strip 短片**：用家接受？

---

## 10. Implementation notes（畀之後 coding agent）

- 新 route 獨立 module：`lib/android-archive.js`（唔好同舊「backup upload」稿混淆）。  
- Lookup **必須** name-first；hash 係核對唔係唯一入口（雖然 batch 可同時交）。  
- Hash 公式同 `computeQuickHash` bit-identical。  
- Label 字串同 `config/embed-categories.json` 一字不差。  
- 歸檔後 enqueue 細批 `thumb-hash`／`embed`／`classify`。  
- 測試：人物 Motion → 圖+mp4 + pair；食物 Motion → 只有圖；同名唔同 hash → 拒絕 replace。  
- Commit／PR 唔寫 secret。

---

## 11. Acceptance criteria（實作時）

- [ ] 庫內已有原檔：lookup `matched` → 壓縮 → `10_compressed` 有檔；原 `10` 未改（archive_path）。  
- [ ] 同一張重複 submit → `deduped: true`。  
- [ ] 只有檔名命中、hash 唔同 → `name_match_hash_mismatch`，唔寫檔。  
- [ ] 庫內冇呢張 → `not_found`；App **唔**上傳原檔。  
- [ ] `person`/`food`/`docs` 樣本 quality 92／80／60。  
- [ ] 非人物 Motion：靜態無 trailer、無另存短片。  
- [ ] 人物 Motion：靜態 q92 無 trailer + `motion\` MP4；pair 可互查。  
- [ ] replace_in_place（若開）：先有備份，hash 核對失敗會 409。  
- [ ] Wi‑Fi only；JWT 過期 queue 保留。  
- [ ] 新 archive 路徑可被 `/tree`／rescan 見到。

---

## 12. UI Design（詳細 — 歸檔流程）

設計原則：Material 3；對齊 SilverFS 深色風；**Dark mode**；觸控 ≥ 48dp；繁中為主。文案全面用「歸檔／壓縮」而唔係「首次備份上載」。

### 12.1 Navigation map

```text
Splash / Onboarding (首次) — 講明：其他 App 先上傳；本 App 壓縮歸檔
    └─ Server URL + Login
         └─ Permission gate
              └─ Main (Bottom nav)
                   ├─ Archive（預設）— 揀相 / 開始壓縮歸檔
                   ├─ Queue — 歸檔隊列與進度
                   └─ Settings
              疊加／子頁：
                   Gallery picker
                   Category review
                   Compress preview
                   Item detail / Conflict
                   Not in library（未在庫）
                   Already archived
                   Disambiguation（同名多個）
```

### 12.2 Screen-by-screen

#### A. Onboarding（3 頁）

| 頁 | 標題 | 內文重點 | 主按鈕 |
|---|---|---|---|
| 1 | 壓縮歸檔 | 相已由其他 App 上載到伺服器；呢度只做壓縮同歸檔 | 下一頁 |
| 2 | 分類品質 | 人物 92／食物 80／收據 60 | 下一頁 |
| 3 | 人物動態相 | 人物：圖+短片分開歸檔；其他：只留壓縮圖 | 開始設定 |

**Wireframe**

```text
┌─────────────────────┐
│ ○ ○ ●               │
│   [Illustration]    │
│  壓縮歸檔            │
│  其他 App 負責上傳   │
│  本 App：壓縮＋歸檔  │
│  查庫：先檔名再 hash │
│  [ 開始設定 ]        │
└─────────────────────┘
```

#### B. Login / Server URL

同前：Server URL、Username、Password、測試連線、登入。JWT 存 EncryptedSharedPreferences。

#### C. Permission gate

`READ_MEDIA_IMAGES`／通知／可選電池優化。唔強制 MANAGE_EXTERNAL_STORAGE。

#### D. Main — Archive tab

- 今日摘要：「待歸檔 N」「今日已歸檔 M」「未在庫 U」「已 skip（已歸檔）K」「人物短片 P」。  
- 主 CTA：`揀相片壓縮歸檔`、`處理今日相機相`。  
- 次要：自動掃描開關；上次 run 狀態。  
- Banner（可關）：「未在庫的相請先用備份 App 上傳」。

**Wireframe**

```text
┌─────────────────────┐
│ SilverFS Archive    │
│ ┌─今日摘要─────────┐ │
│ │ 待歸檔 128        │ │
│ │ 已歸檔 40 · skip 9│ │
│ │ 未在庫 7 · 短片 3 │ │
│ └───────────────────┘ │
│ [ 揀相片壓縮歸檔 ]   │
│ [ 處理今日相機相 ]   │
│ 自動掃描  ────○     │
│ 模式：寫入 *_compressed │
│ ════ Archive Queue ═ │
└─────────────────────┘
```

#### E. Gallery picker

系統 Photo Picker／grid；Motion「Live」badge；底欄下一步 → Category review。

#### F. Category review

縮圖 + qualityClass chip；Motion：`Live→分開歸檔`／`Live→剝走`；四掣覆寫；`用伺服器分類`。

#### G. Compress preview

Before／after size；合計；人物短片「將原樣另存」；底 CTA：`加入歸檔隊列`（唔寫「上載備份」）。

#### H. Archive queue

分段：進行中／等候／完成／失敗／未在庫。  
狀態 pill：`lookup` → `compressing` → `archiving_image`／`archiving_video` → `done`／`skipped_archived`／`not_in_library`／`hash_mismatch`／`error`。  
人物 pair 子列短片。Bulk：暫停／重試失敗／清空已完成。  
**唔提供**「改為上傳原檔」按鈕（non-goal）。

#### I. Not in library / Conflict / Already archived / Disambiguation

| 狀態 | UI |
|---|---|
| `not_found` | 「未在伺服器圖庫」+ 說明用其他 App 先上傳；可「稍後再查」 |
| `already_archived` | Skip；顯示 archive path；可開 `/tree` 連結（若有） |
| `name_match_hash_mismatch` | 警告同名唔同內容；預設 skip；進階先唔開放 replace |
| `needs_disambiguation` | 列表揀正確 path／fileId 再開歸檔 |
| replace 確認（僅設定開啟時） | 二次 dialog：會改原檔並留 `_bak` |

#### J. Settings

1. 連線：URL、帳號、登出、deviceId  
2. 網絡：Wi‑Fi only  
3. **歸檔模式**：`寫入 *_compressed（建議）`／`原地替換原檔（危險）`  
4. 自動掃描：開關、充電先跑  
5. 品質覆寫：92／80／60／85  
6. Motion：人物分開存短片（預設 ON）  
7. 私隱：GPS、EXIF 時間  
8. 關於：版本、診斷 log（無 token）

### 12.3 Key components

| Component | 用途 |
|---|---|
| `QualityClassChip` | person/food/docs/other + q |
| `MotionBadge` | Live→分開歸檔 / Live→剝走 |
| `ArchiveProgressHeader` | 總數、ok、skip、not_in_library、fail |
| `QueueItemRow` | 圖+可選短片子列 |
| `BeforeAfterSize` | `12.4 MB → 1.1 MB` |
| `WifiGateBanner` | 非 Wi‑Fi 警告 |
| `LibraryStatusChip` | 在庫／未在庫／已歸檔／hash 不符 |
| `PairStatus` | 圖／短片齊未 |
| `EmptyState` / `ErrorBanner` | 空態／錯態 |

### 12.4 Empty / error states

| 場景 | 文案方向 | CTA |
|---|---|---|
| 未登入 | 請先連線伺服器 | 去登入 |
| 無權限 | 無法讀取相片 | 開設定 |
| 揀相空白 | 未選任何相片 | 去圖庫 |
| Queue 空 | 暫無歸檔任務 | 揀相片 |
| 全數已歸檔 | 所選都已有壓縮版 | 返回 |
| 全部未在庫 | 請先用備份 App 上傳原檔 | 好 |
| 無網絡 | 已離線排隊（lookup 稍後） | 好 |
| 非 Wi‑Fi | 已暫停歸檔上載 | 等 Wi‑Fi |
| JWT 過期 | 隊列已保留 | 重新登入 |
| hash 不符 | 檔名相同但內容唔同，已跳過 | 詳情 |
| 短片失敗、圖成功 | 圖已歸檔，短片失敗 | 只重試短片 |

### 12.5 Dark mode

跟隨系統；Settings 可強制；狀態色＋ icon＋文字；before/after 用 monospace。

### 12.6 Accessibility

`contentDescription`；大字唔截主 CTA；進度有百分比；Motion 讀屏：「動態相片，將分開歸檔短片」／「只保留靜態圖」。

### 12.7 Copy deck（主要字串）

| key | zh-HK |
|---|---|
| `onboarding.role.title` | 壓縮歸檔 |
| `onboarding.role.body` | 相片請先用其他 App 上傳到伺服器；本 App 只負責壓縮同歸檔。 |
| `onboarding.lookup.body` | 先用檔名搵庫內檔，再用雜湊核對係咪同一張。 |
| `onboarding.motion.body` | 人物會分開歸檔相片同短片；其他類別只保留壓縮相片。 |
| `main.cta` | 揀相片壓縮歸檔 |
| `preview.motion.split` | 將另存動態短片（唔再壓縮） |
| `preview.motion.strip` | 會移除動態短片，只歸檔相片 |
| `queue.lookup` | 查庫中（檔名→雜湊） |
| `queue.archiving` | 歸檔中 |
| `status.not_in_library` | 未在庫 |
| `status.already_archived` | 已歸檔，已跳過 |
| `status.hash_mismatch` | 同名但內容唔同 |
| `conflict.not_found` | 伺服器未有呢張相，請先用備份 App 上傳 |
| `settings.mode.archive` | 寫入 *_compressed 資料夾 |
| `settings.mode.replace` | 原地替換原檔（先備份） |
| `settings.wifi_only` | 只在 Wi‑Fi 歸檔上載 |

---

*End of spec.*

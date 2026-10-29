# Android Compress Backup — Product + API Spec

> SilverFileSystem 手機備份規格（Android）  
> 狀態：**Proposed** · 分支：`feature/face-detection`  
> 相關：每日 pipeline（thumb → embed → classify）、`scripts/compress-strip-motion.cjs`、`config/embed-categories.json`、`lib/auth.js` JWT  
> 本文件**唔包含**密碼、JWT secret、Google secret；設定一律經 server `loadConfig()` / `.env`。  
> **本階段只寫 SPEC，唔實作 Android app。**  
> 更新：人物 Motion Photo **分開儲存**靜態圖 + 短片；補齊詳細 UI 設計（§12）。

---

## 0. Summary

用家想喺 Android 上：**分類 → 有損壓縮 → 用 hash 問 API 有冇已經備份 → 先上傳**，慳流量同伺服器空間。品質按內容類別：

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
| `food` / `docs` / `other` | **剝走短片**（只上壓縮 JPEG；唔另存 MP4），同 PC `compress-strip-motion.cjs` 語意一致 |

伺服器端對齊現有 Express + MySQL（`scanned_files`、`folder_tree`、embedding／classify）。**而家未有 multipart upload API**，本 SPEC 提出新 endpoints（見 §4）；hash 查重會對齊現有 `hash`／`md5`／`quick_hash` 語意。

---

## 1. Goals / Non-goals / UX

### 1.1 Goals

1. Android app 喺上載前做 **lossy JPEG 壓縮**；非人物類 **剝走** Motion Photo／Live Photo 嵌喺 JPG 入面嘅短片；**人物類**則 **拆開** 靜態圖同短片分開存。
2. 上載前用 **影像 hash** 打 API：**已備份就 skip**（唔重複傳）。
3. 按內容類別揀 JPEG quality（上表）。
4. 支援 **手動選相** 同 **自動備份**（相簿監聽／定時）。
5. 顯示進度：排隊、壓縮中、查 hash、上載中、已 skip、失敗重試；人物類另顯示「短片已分開上載」。
6. 設定：**只限 Wi‑Fi**（預設開）、可選充電先跑、每批上限、品質覆寫。
7. 上載後 server 將檔放入約定路徑，之後可由現有 daily pipeline 補 EXIF／thumb／embed／tag。

### 1.2 Non-goals（明確不做 — MVP）

- 唔做 iOS（可另開 SPEC）。
- 唔做「相簿入面獨立拍嘅長片／純 MP4」全庫備份（人物 Motion trailer 除外）。
- 唔喺手機上訓練模型；唔強制離線高精度分類。
- 唔取代現有 PC 端 `compress-strip-motion.cjs`／`/tree` 手動整理。
- 唔做端到端加密雲（檔案以用家自有 NAS／`H:` 路徑落地，靠現有 JWT＋權限）。
- 唔一次過重做全庫 70 萬張舊相壓縮（那是 server job）。

### 1.3 UX flow（高層）

```text
[Onboarding] → [登入 / Server URL] → [權限]
    ↓
[設定]  Wi‑Fi only · 自動備份 · 目標資料夾 · 品質表（可覆寫）
    ↓
[圖庫揀相] → [類別覆核] → [壓縮預覽 before/after] → [確認上載]
    ↓
每張：讀檔 → 偵測 Motion → 分類 → 定 quality
    ↓
  ┌─ person + Motion ──► 拆 still + mp4
  │     still: strip trailer → hash → compress q92 → upload image
  │     mp4:   extract trailer → hash(video) → upload motion-video（link pair）
  └─ 其他 (+ Motion) ──► strip trailer（丟短片）→ hash → compress → upload image only
    ↓
POST /api/backup/check-hash → alreadyExists? → SKIP（衝突／已備份 UI）
    ↓ 否
Upload queue（可暫停／重試）→ 完成通知
```

詳細畫面、元件、空態／錯態見 **§12 UI Design**。

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

1. App 產生細 thumbnail（最長邊 ≤ 512，JPEG q70）上傳去 **臨時 classify**，或重用 `POST /api/backup/classify-preview`（見 §4.4）。
2. Server 用現有 EmbeddingGemma + `lib/embed-classifier.js` + `config/embed-categories.json` 做 cosine prototype classify（同 `/jobs` classify 一致）。
3. 回 `labels[]` + scores → App map 去 `qualityClass`。

**離線 fallback（無網／server 忙）**

1. 用家手動 tag（四掣：人物／食物／文件／其他）— 最準、MVP 必備。
2. 輕量 heuristic（可選，準度有限）：
   - EXIF／檔名含 `IMG_` 相機相 + 人臉偵測（ML Kit Face）→ `person`
   - 高對比文字密集（ML Kit Text Recognition 字數多）→ `docs`
   - 其餘 → `other`（用 85；唔亂猜 `food`）
3. **唔建議** MVP 就上完整 on-device image classifier（APK 大、維護成本高）；等線上 classify 穩再考慮。

### 2.3 用家覆寫

每張／每批可強制 `qualityClass`。覆寫優先過 API／heuristic。  
伺服器應記錄 `client_quality_class` 同 `server_labels`（若有），方便之後 audit。

---

## 3. Hash scheme

### 3.1 對齊現有 DB

`scanned_files` 有三個相關欄位（見 `DATABASE.md`／`lib/database.js`）：

| Column | 用途（現況） |
|---|---|
| `hash` | 完整／主要內容 hash（歷史欄位；唔保證每列都有） |
| `md5` | 全檔 MD5（faces 等流程會用） |
| `quick_hash` | **快速 hash**：`MD5( head[0..min(64KiB,size)] ∥ tail[last min(64KiB,size)] ∥ ascii(size) )`（見 `server.js` `computeQuickHash`、`lib/daily-pipeline-job.js`） |

Thumbnail cache key：`file_hash` ∈ {`hash`,`md5`,`quick_hash`} + `file_size`。

### 3.2 App 要計嘅 hash

對**每一張靜態圖**建議計：

1. **`originalContentHash`（查重主鍵 — 靜態圖）**  
   - 演算法：全檔 **MD5**（hex lowercase）  
   - 對象位元組：讀入原檔 → **剝走 Motion Photo trailer 之後**、**JPEG 有損重壓之前** 嘅 JPEG／影像 bytes  
   - 為什麼：壓縮後 size／bytes 變，唔可以用壓縮後 hash 對「同一張原相」；剝 Motion 後先 hash，避免同一張相有／無 trailer 被當成兩張。

2. **`originalQuickHash`（可選、加速對庫）**  
   - 同上「剝 Motion 後、壓縮前」bytes，用 server 同一套 quick_hash 公式。

3. **`compressedQuickHash` + `compressedSize`**  
   - 上載完成後，server 對落地檔再計一次（權威）；client 可附帶作完整性核對。

對**人物類拆出嘅短片**另計：

4. **`motionVideoContentHash`**  
   - 演算法：抽出嚟嘅 **純 MP4 bytes** 全檔 MD5（hex lowercase）。  
   - 查重主鍵（短片）：`POST /api/backup/check-hash` 可帶 `mediaKind: "motion_video"` + 呢個 hash。

5. **`motionPairId`（配對 ID）**  
   - 建議：`motionPairId = originalContentHash`（靜態圖嘅 content hash），短片同靜態圖都帶同一值。  
   - 替代：server 喺 image upload 回 `pairId`，之後 video upload 引用；MVP 用 client 端 `originalContentHash` 即可。

### 3.3 Check-before-upload 邏輯

`POST /api/backup/check-hash` 輸入 `originalContentHash`（靜態圖必填）或 `motionVideoContentHash`（短片），可選 `mediaKind`、`originalQuickHash`、`originalSize`、`name`。

Server 視為 **alreadyExists** 若任一命中：

1. 新表 `mobile_backup_uploads.content_hash`（靜態）或 `mobile_backup_motion_videos.video_content_hash`（短片）  
2. 或 `scanned_files.md5` 命中對應 hash  
3. 或（弱匹配）`scanned_files.quick_hash` + size（僅 hint）

回應應清楚：`exists`、`matchType`、`mediaKind`、可選 `fileId`／`path`／`pairedImageFileId`／`pairedVideoFileId`。

**注意**：壓縮後嘅檔 **唔應該** 用嚟當「原相已備份」嘅唯一證據；查重永遠用剝 Motion 後／抽出短片後嘅 content hash。

---

## 4. Proposed REST API

Base URL（示例）：`https://medialib2.tcghk.trade`  
Auth：所有 `/api/backup/*` 要 `Authorization: Bearer <JWT>`（同現有 `requireAuth` + `requirePhotoPermission`）。  
登入重用：`POST /api/auth/login` → `{ token, user }`（JWT expiry 約 24h，見 `lib/auth.js`）。

> **現況**：repo **未有** multipart upload／backup check endpoint → **全部為新增**；實作時掛喺 `server.js`，權限同 `/api/photos` 一致。

### 4.1 `POST /api/backup/check-hash`

**Request**

```http
POST /api/backup/check-hash
Authorization: Bearer <jwt>
Content-Type: application/json
```

```json
{
  "mediaKind": "image",
  "originalContentHash": "a1b2c3d4e5f6789012345678abcdef01",
  "originalQuickHash": "f0e1d2c3b4a5968778695a4b3c2d1e0f",
  "originalSize": 4821934,
  "name": "IMG_20261029_153012.jpg",
  "deviceId": "xiaomi-14t-pro",
  "motionPairId": "a1b2c3d4e5f6789012345678abcdef01"
}
```

短片查重示例：

```json
{
  "mediaKind": "motion_video",
  "motionVideoContentHash": "11223344556677889900aabbccddeeff",
  "originalSize": 8901234,
  "name": "IMG_20261029_153012_motion.mp4",
  "deviceId": "xiaomi-14t-pro",
  "motionPairId": "a1b2c3d4e5f6789012345678abcdef01"
}
```

**Response 200**

```json
{
  "exists": true,
  "mediaKind": "image",
  "matchType": "backup_table",
  "fileId": 123456,
  "path": "H:\\silverchan\\Photos\\MobileBackup\\AndroidApp\\xiaomi-14t-pro\\2026\\10\\IMG_20261029_153012.jpg",
  "uploadedAt": "2026-10-29T15:40:00+08:00",
  "pairedVideoFileId": 123460,
  "pairedVideoPath": "H:\\silverchan\\Photos\\MobileBackup\\AndroidApp\\xiaomi-14t-pro\\2026\\10\\motion\\IMG_20261029_153012_motion.mp4"
}
```

```json
{
  "exists": false,
  "mediaKind": "image",
  "matchType": "none"
}
```

**Errors**：`401` 無／過期 token；`403` 無 photo permission；`400` 缺 hash。

### 4.2 `POST /api/backup/check-hash/batch`（建議 MVP+）

一次最多 100 個 hash，減少 RTT。每項可帶 `mediaKind`。

```json
{
  "items": [
    { "mediaKind": "image", "originalContentHash": "...", "originalSize": 1, "name": "a.jpg" },
    { "mediaKind": "motion_video", "motionVideoContentHash": "...", "motionPairId": "...", "name": "a_motion.mp4" }
  ]
}
```

```json
{
  "results": [
    { "originalContentHash": "...", "mediaKind": "image", "exists": false, "matchType": "none" },
    { "motionVideoContentHash": "...", "mediaKind": "motion_video", "exists": true, "matchType": "motion_table", "fileId": 99, "motionPairId": "..." }
  ]
}
```

### 4.3 `POST /api/backup/upload`（靜態圖）

Multipart form：

| Field | Type | 說明 |
|---|---|---|
| `file` | file | 壓縮後 JPEG（必填） |
| `mediaKind` | string | 固定 `"image"`（可選，預設 image） |
| `originalContentHash` | string | 查重主鍵（必填） |
| `originalQuickHash` | string | 可選 |
| `originalSize` | int | 剝 Motion 後、壓縮前 size |
| `compressedSize` | int | client 聲稱；server 以實際為準 |
| `quality` | int | 用咗嘅 JPEG quality |
| `qualityClass` | string | `person`\|`food`\|`docs`\|`other` |
| `clientLabels` | string | JSON array，可選 |
| `capturedAt` | string | ISO8601，可選（EXIF DateTime 優先） |
| `deviceId` | string | 裝置識別 |
| `relativeName` | string | 建議檔名（server sanitise） |
| `hadMotionPhoto` | string | `"true"`/`"false"` — 原檔係咪 Motion |
| `motionPolicy` | string | `split`（人物分開存）\|`strip`（其他類剝走）\|`none` |
| `motionPairId` | string | 人物+Motion 時必填；建議 = `originalContentHash` |
| `motionVideoPending` | string | `"true"` 若稍後會再 upload 配對短片 |
| `stripMotion` | string | `"true"`/`"false"` — client 有冇剝過（非 split 時） |
| `idempotencyKey` | string | 建議：`image:` + `originalContentHash` |

**Response 201**

```json
{
  "ok": true,
  "mediaKind": "image",
  "fileId": 123457,
  "path": "H:\\silverchan\\Photos\\MobileBackup\\AndroidApp\\xiaomi-14t-pro\\2026\\10\\IMG_20261029_153012.jpg",
  "size": 412088,
  "quickHash": "aabbccddeeff00112233445566778899",
  "deduped": false,
  "motionPairId": "a1b2c3d4e5f6789012345678abcdef01",
  "expectMotionVideo": true
}
```

若 hash 已存在：**200** + `{ "ok": true, "deduped": true, ... }`（唔寫第二份檔；idempotent）。

**Response 413**：檔太大（見 §5.4）。  
**Response 415**：非 JPEG／唔支援格式。

**Server 處理步驟（建議）**

1. Auth + photo permission。  
2. 以 `originalContentHash` 再 check 一次（防 race）。  
3. 落地去 §6 路徑（atomic write：`.partial` → rename）。  
4. 插入／更新 `mobile_backup_uploads`；若 `motionPairId` 有值，寫入配對欄。  
5. 確保 `folder_tree` 有父資料夾；`scanned_files` insert。  
6. （可選）enqueue `thumb-hash`／之後 embed／classify job。  
7. **唔好**信任 client 嘅 compressed hash；server 自計。

### 4.3b `POST /api/backup/upload-motion-video`（人物 Motion 短片）

僅喺 `qualityClass=person` 且原檔含 Motion trailer 時使用。其他類別 **唔呼叫** 呢個 API。

Multipart form：

| Field | Type | 說明 |
|---|---|---|
| `file` | file | 抽出嘅 MP4（必填；`video/mp4`） |
| `mediaKind` | string | 固定 `"motion_video"` |
| `motionVideoContentHash` | string | 短片全檔 MD5（必填） |
| `motionPairId` | string | 必填；同配對靜態圖嘅 `originalContentHash`／pair id |
| `pairedImageContentHash` | string | 建議同 `motionPairId`（明確指出配對圖） |
| `originalSize` | int | MP4 byte size |
| `durationMs` | int | 可選 |
| `deviceId` | string | 裝置識別 |
| `relativeName` | string | 建議：`{stem}_motion.mp4` |
| `capturedAt` | string | ISO8601，可選 |
| `idempotencyKey` | string | 建議：`motion:` + `motionVideoContentHash` |

**Response 201**

```json
{
  "ok": true,
  "mediaKind": "motion_video",
  "fileId": 123460,
  "path": "H:\\silverchan\\Photos\\MobileBackup\\AndroidApp\\xiaomi-14t-pro\\2026\\10\\motion\\IMG_20261029_153012_motion.mp4",
  "size": 8901234,
  "deduped": false,
  "motionPairId": "a1b2c3d4e5f6789012345678abcdef01",
  "pairedImageFileId": 123457,
  "pairedImagePath": "H:\\silverchan\\Photos\\MobileBackup\\AndroidApp\\xiaomi-14t-pro\\2026\\10\\IMG_20261029_153012.jpg"
}
```

若靜態圖尚未上載：仍接受短片落地，回 `pairedImageFileId: null` + `pairStatus: "orphan_pending"`；待 image upload 帶同一 `motionPairId` 時 server 補 link。  
若 image 已存在、video 重試：**200** + `deduped: true`。

**Errors**：`400` 缺 `motionPairId`／非 mp4；`413` 過大；`415` 格式錯。

**順序建議（App）**

1. 先 upload 壓縮靜態圖（`motionVideoPending=true`）。  
2. 再 upload motion video（帶同一 `motionPairId`）。  
3. 任一失敗：queue 分開重試；UI 顯示「圖已上、短片待傳」或相反。

### 4.4 `POST /api/backup/classify-preview`（建議；可 Phase 2）

細圖 classify，唔寫碟。

```json
{
  "labels": [
    { "label": "食物", "score": 0.71 },
    { "label": "其他", "score": 0.22 }
  ],
  "qualityClass": "food",
  "quality": 80,
  "motionPolicyHint": "strip"
}
```

`person` 時 `motionPolicyHint` = `"split"`；其他 = `"strip"`。  
重用 `embed-classifier` prototypes；若 embedding server 未起，回 `503` + `Retry-After`，App fallback 用家 tag／heuristic。

### 4.5 DB：新表（建議）

```sql
CREATE TABLE IF NOT EXISTS mobile_backup_uploads (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  content_hash CHAR(32) NOT NULL,          -- originalContentHash (MD5 hex)
  compressed_quick_hash VARCHAR(64) NULL,
  file_id BIGINT NULL,                    -- scanned_files.id
  user_id INT NOT NULL,
  device_id VARCHAR(128) NULL,
  quality TINYINT NULL,
  quality_class VARCHAR(16) NULL,
  original_size BIGINT NULL,
  compressed_size BIGINT NULL,
  path VARCHAR(1024) NOT NULL,
  had_motion_photo TINYINT(1) DEFAULT 0,
  motion_policy VARCHAR(16) NULL,         -- split | strip | none
  motion_pair_id CHAR(32) NULL,           -- links to motion video
  motion_video_file_id BIGINT NULL,       -- scanned_files.id of paired mp4
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_content_hash (content_hash),
  INDEX idx_device_created (device_id, created_at),
  INDEX idx_file_id (file_id),
  INDEX idx_motion_pair (motion_pair_id)
);

CREATE TABLE IF NOT EXISTS mobile_backup_motion_videos (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  video_content_hash CHAR(32) NOT NULL,  -- motionVideoContentHash
  file_id BIGINT NULL,                    -- scanned_files.id
  user_id INT NOT NULL,
  device_id VARCHAR(128) NULL,
  motion_pair_id CHAR(32) NOT NULL,      -- = paired image originalContentHash
  paired_image_content_hash CHAR(32) NULL,
  paired_image_file_id BIGINT NULL,
  path VARCHAR(1024) NOT NULL,
  size_bytes BIGINT NULL,
  duration_ms INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_video_hash (video_content_hash),
  INDEX idx_motion_pair (motion_pair_id),
  INDEX idx_paired_image (paired_image_content_hash)
);
```

Migration 掛入現有 `lib/database.js` version chain。

### 4.6 Auth 備註

- Header：`Authorization: Bearer …`（優先）；cookie `silverfs_token` 主要畀瀏覽器 img，App 唔依賴 cookie。  
- Token 24h：App 要 refresh（重新 login）或日後加 refresh token（open question）。  
- 需要 `requirePhotoPermission`；backup 寫入可視為 photo 寫權限（若將來拆 `backup` permission，另加）。

### 4.7 可選：`GET /api/backup/pair/:motionPairId`

回一對檔嘅狀態（image／video 齊未、path、size），畀「已備份詳情」同 debug。

```json
{
  "motionPairId": "a1b2c3d4e5f6789012345678abcdef01",
  "image": { "fileId": 123457, "path": "...", "size": 412088 },
  "video": { "fileId": 123460, "path": "...", "size": 8901234 },
  "complete": true
}
```

---

## 5. Compression rules

對齊 PC 腳本 `scripts/compress-strip-motion.cjs`，手機端用同等語意（Android：`Bitmap`/`ImageDecoder` + 自寫 Motion strip，或 DocumentFile + native）。

### 5.1 Pipeline（每張）

1. 讀原檔 bytes。  
2. 偵測 Motion Photo（Google XMP `MotionPhoto` / `MicroVideoOffset`、Xiaomi MVIMG）。  
3. **分支**：  
   - **`person` + 有 Motion**：抽出 trailer → 另存暫存 MP4；靜態部分繼續下面步驟（`motionPolicy=split`）。  
   - **非 person + 有 Motion**：剝走 trailer 並丟棄短片（`motionPolicy=strip`）。  
   - **無 Motion**：`motionPolicy=none`。  
4. 若 HEIC／HEIF：decode → 轉 JPEG（再入下面 quality）。  
5. 計 `originalContentHash`／可選 `originalQuickHash`；若有抽出 MP4，計 `motionVideoContentHash`。  
6. `check-hash`（image；人物再 check video）→ skip 或 continue。  
7. Lossy recompress JPEG（quality 見表；`4:2:0`；保留合理 max side）。  
8. 盡量保留拍攝時間：寫回 EXIF `DateTimeOriginal`／GPS（若私隱設定允許）。  
9. Upload image；若 `split`，再 upload motion video。

### 5.2 Quality table（保持不變）

| qualityClass | JPEG quality | 典型用途 |
|---|---:|---|
| `person` | **92** | 人像要靚 |
| `food` | **80** | 食物可再壓 |
| `docs` | **60** | 收據餐牌資料，可讀字即可 |
| `other` | **85** | 預設 |

### 5.3 尺寸／格式

- 靜態輸出：**JPEG only**（`.jpg`）。  
- 人物 Motion 短片輸出：**MP4**（原 trailer bytes，MVP **唔再壓片**；Phase 3 可選轉碼）。  
- 最長邊上限（建議）：`person` 4096；`food`/`other` 3072；`docs` 2560（可設定）。超過先 downscale 再壓。  
- 已係細圖（例如 < 200KB 且最長邊 < 1600）而且 class≠`docs`：可 **skip recompress**（仍按政策處理 Motion + 仍 check-hash）。  
- 相簿入面**獨立** `.mp4`（唔喺 JPG 內）：MVP **忽略**；設定頁可顯示「已跳過 N 個獨立短片」。人物 Motion trailer **唔算**呢類。

### 5.4 Size limits（server）

- 單檔 image upload body 上限建議 **32 MB**。  
- Motion video upload 上限建議 **64 MB**（trailer 通常數 MB 至十幾 MB）。  
- Batch 並行：App 端最多 2–3 條上載；server 可用現有 rate limit middleware。

### 5.5 同 PC 腳本差異

| | PC `compress-strip-motion` | Android app |
|---|---|---|
| 預設 quality | 固定 85 | 按類別 92／80／60／85 |
| Motion | 一律 strip | **人物 split**；其他 strip |
| 輸出位置 | 可另 folder `10_compressed` | 直接上 server 約定 path（圖 + 可選 `motion\`） |
| 原檔 | 本機 `_bak_before_compress` | 留喺手機相簿；server 收壓縮圖（+ 人物短片） |

---

## 6. Storage path / folder mapping

### 6.1 建議落地根（靜態圖）

同現有 MobileBackup 習慣對齊：

```text
H:\silverchan\Photos\MobileBackup\AndroidApp\<deviceId>\<YYYY>\<MM>\<filename>.jpg
```

### 6.2 人物 Motion 短片路徑

同月目錄下設 `motion\` 子資料夾，檔名帶 `_motion`：

```text
H:\silverchan\Photos\MobileBackup\AndroidApp\<deviceId>\<YYYY>\<MM>\motion\<stem>_motion.mp4
```

例：

```text
...\2026\10\IMG_20261029_153012.jpg
...\2026\10\motion\IMG_20261029_153012_motion.mp4
```

- `<deviceId>`：App 設定（例如 `xiaomi-14t-pro`），sanitise `[A-Za-z0-9_-]`。  
- `<YYYY>/<MM>`：優先 EXIF 拍攝日；否則 file mtime；再否則上載當日（Asia/Hong_Kong）。  
- 檔名：保留原名（衝突時加 `_<shortHash6>`）；短片 stem 同靜態圖一致方便人手對。  
- DB 以 `motion_pair_id` 為準互聯，**唔單靠檔名**。

可選第二用家根（設定）：

```text
H:\JennyNg\Photos\MobileBackup\AndroidApp\<deviceId>\...
```

### 6.3 同 daily rescan 關係

- 將 `...\AndroidApp` 加落 `config/daily-refresh-folders.json`（或 pathPrefix=`H:\` 已覆蓋）。  
- 03:00 rescan 會發現新檔（含 `motion\`）；03:30 thumb → 04:30 embed → 05:30 classify 主要針對靜態圖；MP4 入庫即可，MVP 唔強制 embed 短片。  
- Upload handler 亦可即刻 enqueue 細批 `thumb-hash`（可選加速）。

### 6.4 唔寫入

- 唔寫入 `_bak_before_compress`、recycle、`10_compressed` 舊實驗路徑（除非用家明示）。

---

## 7. Offline queue / retries / privacy

### 7.1 Offline queue

- Room DB（或同等）：pending items = uri、contentHash、qualityClass、motionPolicy、motionPairId、state、attempts、lastError。  
- 人物 Motion 一張原相可產生 **兩條 queue item**（`image` + `motion_video`），共用 `motionPairId`。  
- 無網／非 Wi‑Fi：只做本地壓縮＋拆片＋hash，upload 暫停。  
- 有網恢復：先 `check-hash/batch`，再 upload 未存在嘅。

### 7.2 Retries

- 指數退避：1m / 5m / 15m / 1h；最多 N=8。  
- `401`：清 token、提示重新登入，唔盲 retry。  
- `409`／dedupe：當成功 skip。  
- 可部分失敗：其餘繼續；pair 唔齊時 UI 顯示「配對未完成」。

### 7.3 Privacy

- JWT／密碼只放 EncryptedStorage；log 唔印 token。  
- 預設 **上載前剝 GPS** 可作選項（預設：保留 EXIF 時間、GPS 跟用家開關，預設「保留」以對齊現有相庫）。  
- 非人物 Motion 短片剝走後 **唔上載**。  
- 人物 Motion 短片會上載：設定頁要寫明「人物動態相片會另外備份短片」。  
- classify-preview 臨時圖：server **唔持久化**（記憶體／temp 即刪）。  
- 用家可「暫停自動備份」、可刪本機 queue（唔刪已上載）。

---

## 8. MVP phases

### Phase 0 — Server stubs（約小）

- Migration `mobile_backup_uploads` + `mobile_backup_motion_videos`  
- `POST /api/backup/check-hash`（+ batch；支援 `mediaKind`）  
- `POST /api/backup/upload`（multipart、idempotent）  
- `POST /api/backup/upload-motion-video`  
- 可選 `GET /api/backup/pair/:motionPairId`  
- 權限、大小限制、路徑設定（config key，例如 `backup.androidRoot`）  
- 手動用 `curl`／小 script smoke test

### Phase 1 — Android MVP

- Onboarding + Login + Server URL + 權限  
- Wi‑Fi only + 手動選相  
- Motion：人物 split；其他 strip  
- JPEG compress（固定 quality 表）  
- 手動 `qualityClass` 四掣  
- 壓縮預覽 before／after  
- check-hash → upload queue → 衝突／已備份 UI  
- Offline queue + 基本 retry  
- Settings：Wi‑Fi、品質覆寫

### Phase 2 — Smart classify

- `classify-preview` 接 embedding  
- 自動備份（MediaStore observer + WorkManager）  
- Batch check-hash  
- 上傳後觸發 thumb job  
- Pair 詳情頁

### Phase 3 — Polish

- 雙 tag 保守 quality、HEIC 完善、統計頁（慳咗幾多 MB）  
- Motion 短片可選轉碼／再壓  
- Refresh token、多 profile（silverchan／JennyNg）  
- 可選：同 PC compressed folder 工具對賬報告

---

## 9. Open questions

1. **原檔要唔要同時留一份喺 server？** 而家 SPEC 假設 **只存壓縮版**（人物另加 trailer MP4）；若要「原檔 archive」，要另 path／另 opt-in。  
2. **`originalContentHash` 用全檔 MD5 定 SHA-256？** 為對齊 `scanned_files.md5`，MVP 建議 **MD5**；長遠可加 `content_sha256` 欄。  
3. **已存在嘅係「未壓縮原檔」時，要唔要上傳壓縮版覆蓋？** 建議預設 **skip、唔覆蓋**；另提供「replace with compressed」進階操作（危險，要確認）。  
4. **GPS／人臉私隱預設？** 保留 GPS vs 剝離；自動備份是否排除「截圖」相簿。  
5. **多用戶／多機**：`deviceId` 撞名點辦？要唔要綁 `user_id`+hardware id。  
6. **Embedding server 未起**：classify-preview 失敗時，自動備份用 `other@85` 定暫停等人手 tag？  
7. **Quota**：每用家每日上載張數／GB 上限？短片算唔算入 quota？  
8. **App 簽名同分發**：只內部分 APK，定 Play 內測？  
9. **路徑碟符**：server 係咪永遠有 `H:`？離線時 upload 應 queue 喺 server 定直接 503？（建議 server 本地 staging 再搬去 `H:`）  
10. **同現有 `H:\...\DCIM\Camera\2026\10` 原檔並存**：用家要唔要 UI 顯示「庫內已有原檔，已 skip」連去 `/tree`？  
11. **人物短片要唔要再壓縮／轉碼？** MVP 原樣保存 trailer；若要慳空間，Phase 3 再定 bitrate。  
12. **雙 tag `person`+`food` 用 q80 時**：跟非 person 政策 strip 短片 — 確認用家可接受「有人有食物嘅動態相唔留短片」。

---

## 10. Implementation notes（畀之後 coding agent）

- **唔好**喺 SPEC 階段改 production 行為以外嘅大重構；新 route 獨立 module 例如 `lib/android-backup.js` 再 mount。  
- Hash 公式必須同 `computeQuickHash` bit-identical（64KiB head/tail + size string + md5 hex）。  
- 分類 label 字串必須同 `config/embed-categories.json` **一字不差**（`人物單人`、`收據餐牌資料`…）。  
- 上載後避免重複巨型 daily-pipeline；優先 enqueue 細批 `thumb-hash`／`embed`／`classify`（現有 split job types）。  
- 測試：用已知 Motion Photo 樣本（見先前 `2026\10` dry-run）驗證：人物 → 圖+mp4 齊且 `motion_pair_id` 一致；食物 → 只有圖、無 mp4。  
- Commit／PR 描述唔好寫 secret；config 只加非 secret 鍵名。

---

## 11. Acceptance criteria（SPEC 完成後實作時）

- [ ] 同一張相（剝 Motion 後）重複上載第二次 → `deduped: true`，碟上得一份。  
- [ ] `person`/`food`/`docs` 三張樣本壓完 quality 分別為 92／80／60（Exif／encoder 設定可驗證）。  
- [ ] **非人物** Motion Photo 上載後靜態檔唔再含 MP4 trailer，且 **冇** 另存短片。  
- [ ] **人物** Motion Photo：靜態 JPEG（q92、無 trailer）+ `motion\` 下獨立 MP4；兩邊 `motion_pair_id`／`originalContentHash` 可互查。  
- [ ] 只重傳短片或只重傳圖時 idempotent，唔產生重複檔。  
- [ ] Wi‑Fi only 開啟時，模擬流動網絡唔會發 upload。  
- [ ] JWT 過期會提示重新登入，queue 保留。  
- [ ] 新檔出現喺約定 `AndroidApp\...` 路徑（含 `motion\`），且可被 `/tree`／daily rescan 見到。

---

## 12. UI Design（詳細）

設計原則：Material 3；主色跟 SilverFS 網頁深色風格可對；**支援 Dark mode**（跟隨系統，設定可強制）；觸控目標 ≥ 48dp；重要操作有確認；中文（繁體）為主文案，可留英文 key。

### 12.1 Navigation map

```text
Splash / Onboarding (首次)
    └─ Server URL + Login
         └─ Permission gate
              └─ Main (Bottom nav)
                   ├─ Backup（預設）— 揀相 / 開始備份
                   ├─ Queue — 上載隊列與進度
                   └─ Settings
              疊加／子頁：
                   Gallery picker
                   Category review
                   Compress preview
                   Item detail / Conflict
                   Already backed up
```

### 12.2 Screen-by-screen

#### A. Onboarding（首次啟動，3 頁可滑）

| 頁 | 標題 | 內文重點 | 主按鈕 |
|---|---|---|---|
| 1 | 智能壓縮備份 | 上載前壓縮，慳流量同空間 | 下一頁 |
| 2 | 分類品質 | 人物 92／食物 80／收據 60；可之後改 | 下一頁 |
| 3 | 人物動態相 | 人物會**分開保存**相片同短片；其他類別只保留相片 | 開始設定 |

- 可「跳過」直入 Server URL。  
- 空態：無。  
- 無障礙：每頁標題 `heading`；插圖加 `contentDescription`。

**Wireframe（直向）**

```text
┌─────────────────────┐
│ ○ ○ ●  (page dots)  │
│                     │
│     [Illustration]  │
│                     │
│  人物動態相          │
│  人物：圖 + 短片分開  │
│  其他：只留壓縮圖     │
│                     │
│  [ 開始設定 ]        │
│  跳過                │
└─────────────────────┘
```

#### B. Login / Server URL

- 欄位：`Server URL`（預填 `https://medialib2.tcghk.trade`）、`Username`、`Password`。  
- 動作：`測試連線`（輕量 ping／`/api/auth/login` dry）、`登入`。  
- 成功：存 JWT（EncryptedSharedPreferences）→ Permission。  
- 錯誤：紅字 inline —「無法連線」「帳密錯誤」「無相片權限（403）」。  
- 空態：URL 空白時 Disable 登入。  
- Dark：輸入框 outline 用 on-surface variant。

**Wireframe**

```text
┌─────────────────────┐
│ ←  SilverFS Backup  │
│                     │
│ Server URL          │
│ ┌─────────────────┐ │
│ │ https://...     │ │
│ └─────────────────┘ │
│ Username            │
│ ┌─────────────────┐ │
│ └─────────────────┘ │
│ Password            │
│ ┌─────────────────┐ │
│ └─────────────────┘ │
│ [測試連線]  [登入]   │
│ 錯誤：…              │
└─────────────────────┘
```

#### C. Permission gate

- 需要：Photos／Media（Android 13+ `READ_MEDIA_IMAGES`；舊版 storage）、通知（隊列完成）、可選「忽略電池優化」說明。  
- 逐項列：已授權 ✓／未授權 →「授予」。  
- 全部 OK → 入 Main。  
- 拒絕：顯示「無法讀相簿」空態 + 開系統設定 deep link。  
- **唔**喺呢頁要所有檔案存取（MANAGE_EXTERNAL_STORAGE）除非之後證明必要。

#### D. Main — Backup tab

- 頂：今日摘要卡 —「待備份約 N」「今日已上 M」「已 skip K」「人物短片 P」。  
- 主 CTA：`揀相片備份`、`備份今曰相機相`（捷徑）。  
- 次要：`自動備份：開／關` 開關（跳 Settings 詳情）。  
- 最近一次 run 狀態條（成功／失敗／進行中）。

**Wireframe**

```text
┌─────────────────────┐
│ SilverFS    [頭像]  │
│ ┌─今日摘要─────────┐ │
│ │ 待備份 128        │ │
│ │ 已上 40 · skip 9  │ │
│ │ 短片已分開 3      │ │
│ └───────────────────┘ │
│                     │
│ [ 揀相片備份 ]       │
│ [ 備份今日相機相 ]   │
│                     │
│ 自動備份  ⚪───     │
│ 上次：今日 03:30 OK │
│                     │
│ ════ Backup Queue ⚙ │
└─────────────────────┘
```

#### E. Gallery picker

- 系統 Photo Picker（優先）或內建 grid（MediaStore）。  
- 多選；頂欄顯示已選 N；`全選今日`。  
- Filter chips：全部／相機／截圖；標記已有 Motion 嘅 item（小「Live」badge）。  
- 底欄：`下一步（N）` → Category review。  
- 空態：無相 —「相簿空白或無權限」。  
- 錯誤：讀 uri 失敗 — snackbar「略過 1 張無法讀取」。

#### F. Category review

- 列表／2 欄 grid：縮圖 + 建議 `qualityClass` chip + quality 數字。  
- Motion badge：`Live→分開`（僅當 class=person）或 `Live→剝走`（其他）。  
- 點一張 → 底部 sheet：四掣 人物／食物／文件／其他；開關「強制當人物（保留短片）」。  
- 頂：`全部套用為…`；`用伺服器分類`（有網時）。  
- 底：`預覽壓縮` → Compress preview。

**Wireframe（一列）**

```text
┌──────┬──────────────────┐
│ thumb│ 人物單人  q92     │
│ LIVE │ Live→分開儲存     │
│      │ [改分類]          │
└──────┴──────────────────┘
```

#### G. Compress preview（before / after）

- 每張或摘要模式：  
  - Before：原 size、有無 Motion、預估短片 size。  
  - After：預計 JPEG size、quality、是否上短片。  
- 合計：`原 1.2 GB → 約 280 MB（圖）+ 90 MB（人物短片）`。  
- 並排或 slider 對比（可選：decode 預覽圖；大圖用抽樣）。  
- 警告：人物短片「將原樣保存，唔再壓縮」。  
- 底：`加入上載隊列`。  
- 空態：無選項。  
- 錯誤：壓縮失敗列紅 —「HEIC 無法解碼」可移除或改試。

#### H. Upload queue

- 分段：進行中／等候／完成／失敗。  
- 每列：縮圖、檔名、狀態 pill（壓縮中／查 hash／上載圖／上載短片／已 skip／失敗）、進度 bar、size 變化。  
- 人物 pair：子列「短片」縮排，狀態可獨立（圖 OK／短片重試中）。  
- 頂部 bulk：暫停全部／繼續／只重試失敗／清空已完成。  
- 點入 Item detail。

**狀態 pill 色**

| 狀態 | 色意 |
|---|---|
| queued | 灰 |
| compressing / hashing | 藍 |
| uploading_image / uploading_video | 藍動畫 |
| skipped_exists | 綠描邊 |
| done | 綠 |
| error | 紅 |
| paused | 橙 |

#### I. Conflict / Already backed up

- 當 `exists: true`：預設 **Skip**，列標記「已在庫」。  
- 點開：顯示 server path、uploadedAt、matchType；若有 pair，顯示短片 path。  
- 進階（預設摺叠）：`仍要上傳新壓縮版`（危險，要二次確認；MVP 可隱藏）。  
- 批次結束摘要 sheet：「新增 40 · 已存在 skip 12 · 失敗 2 · 短片新增 5」。

#### J. Settings

分組：

1. **連線**：Server URL、帳號、登出、裝置 ID（可編輯）。  
2. **網絡**：Wi‑Fi only（預設 ON）；「今次允許流動數據」臨時掣（Queue 頁亦可）。  
3. **自動備份**：開關、充電先跑、每日大概時段說明（同 server 03:30 無關；本機 WorkManager）。  
4. **品質覆寫**：四個 slider／stepper（92／80／60／85 預設；範圍 40–95）；「重設預設」。  
5. **Motion**：說明文案；開關「人物動態相分開存短片」（預設 ON；關則人物亦 strip——進階）。  
6. **私隱**：保留 GPS（預設 ON）、保留 EXIF 時間。  
7. **關於**：版本、開源授權、診斷（匯出 queue log，唔含 token）。

### 12.3 Key components（共用）

| Component | 用途 |
|---|---|
| `QualityClassChip` | person/food/docs/other + q 數字 |
| `MotionBadge` | Live→分開 / Live→剝走 / 無 |
| `BackupProgressHeader` | 總數、ok、skip、fail、ETA |
| `QueueItemRow` | 圖+可選短片子列 |
| `BeforeAfterSize` | `12.4 MB → 1.1 MB` |
| `WifiGateBanner` | 非 Wi‑Fi 時頂欄警告 |
| `PairStatus` | 圖／短片齊未（icon 雙勾） |
| `EmptyState` | 圖示+標題+副文+CTA |
| `ErrorBanner` | 可重試 |

### 12.4 Empty / error states（摘要）

| 場景 | 文案方向 | CTA |
|---|---|---|
| 未登入 | 請先連線伺服器 | 去登入 |
| 無權限 | 無法讀取相片 | 開設定 |
| 揀相空白 | 未選任何相片 | 去圖庫 |
| Queue 空 | 暫無上載任務 | 揀相片備份 |
| 全數已備份 | 所選相片都已在庫 | 返回 |
| 無網絡 | 已改為離線排隊 | 好 |
| 非 Wi‑Fi | 已暫停上載（Wi‑Fi only） | 允許流動數據／等 Wi‑Fi |
| JWT 過期 | 登入已過期，隊列已保留 | 重新登入 |
| H:／server 滿或 503 | 伺服器暫不可寫 | 稍後重試 |
| 短片上載失敗、圖成功 | 相片已備份，動態短片失敗 | 只重試短片 |

### 12.5 Dark mode

- 跟隨系統；Settings 可選 Light／Dark／System。  
- 表面：深灰背景；主 CTA 用高對比淺色字。  
- 狀態色保持語意（綠／紅／橙），唔單靠色：同時用 icon＋文字。  
- 預覽 before/after 數字用 monospace，暗底淺字。

### 12.6 Accessibility

- 所有圖像按鈕有 `contentDescription`（中文）。  
- Focus 順序：頂欄 → 主內容 → 底 CTA → bottom nav。  
- 動態字體：布局用 `sp`，大字模式唔截斷主 CTA。  
- 進度唔只靠顏色：`ProgressBar` + 百分比文字。  
- Motion badge 讀屏：「動態相片，將分開儲存短片」／「動態相片，只保留靜態圖」。  
- 減少動態：尊重系統「移除動畫」時停用 indeterminate 裝飾動畫。

### 12.7 Copy deck（主要字串 key）

| key | zh-HK |
|---|---|
| `onboarding.motion.title` | 人物動態相 |
| `onboarding.motion.body` | 人物會分開保存相片同短片；其他類別只保留壓縮相片。 |
| `preview.motion.split` | 將另存動態短片（唔再壓縮） |
| `preview.motion.strip` | 會移除動態短片，只上載相片 |
| `queue.uploading_video` | 上載短片中 |
| `conflict.exists` | 已在庫，已跳過 |
| `settings.wifi_only` | 只在 Wi‑Fi 上載 |
| `settings.quality_override` | 品質覆寫 |

---

*End of spec.*

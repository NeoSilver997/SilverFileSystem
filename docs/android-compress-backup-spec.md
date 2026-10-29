# Android Compress Backup — Product + API Spec

> SilverFileSystem 手機備份規格（Android）  
> 狀態：**Proposed** · 分支：`feature/face-detection`  
> 相關：每日 pipeline（thumb → embed → classify）、`scripts/compress-strip-motion.cjs`、`config/embed-categories.json`、`lib/auth.js` JWT  
> 本文件**唔包含**密碼、JWT secret、Google secret；設定一律經 server `loadConfig()` / `.env`。  
> **本階段只寫 SPEC，唔實作 Android app。**

---

## 0. Summary

用家想喺 Android 上：**分類 → 有損壓縮 → 用 hash 問 API 有冇已經備份 → 先上傳**，慳流量同伺服器空間。品質按內容類別：

| 內容類（中文） | SilverFS embed label | JPEG quality |
|---|---|---:|
| 人物 | `人物單人` / `人物合照` | **92** |
| 食物 | `食物` | **80** |
| 收據／餐牌／資料 | `收據餐牌資料` | **60** |
| 其他（風景、動物、截圖…） | 其餘 label／`其他` | **85**（預設，可調） |

伺服器端對齊現有 Express + MySQL（`scanned_files`、`folder_tree`、embedding／classify）。**而家未有 multipart upload API**，本 SPEC 提出新 endpoints（見 §4）；hash 查重會對齊現有 `hash`／`md5`／`quick_hash` 語意。

---

## 1. Goals / Non-goals / UX

### 1.1 Goals

1. Android app 喺上載前做 **lossy JPEG 壓縮**，並 **剝走 Motion Photo／Live Photo 嵌喺 JPG 入面嘅短片**。
2. 上載前用 **影像 hash** 打 API：**已備份就 skip**（唔重複傳）。
3. 按內容類別揀 JPEG quality（上表）。
4. 支援 **手動選相** 同 **自動備份**（相簿監聽／定時）。
5. 顯示進度：排隊、壓縮中、查 hash、上載中、已 skip、失敗重試。
6. 設定：**只限 Wi‑Fi**（預設開）、可選充電先跑、每批上限。
7. 上載後 server 將檔放入約定路徑，之後可由現有 daily pipeline 補 EXIF／thumb／embed／tag。

### 1.2 Non-goals（明確不做 — MVP）

- 唔做 iOS（可另開 SPEC）。
- 唔做影片／純 MP4 備份（獨立 Motion 短片可選「忽略」）。
- 唔喺手機上訓練模型；唔強制離線高精度分類。
- 唔取代現有 PC 端 `compress-strip-motion.cjs`／`/tree` 手動整理。
- 唔做端到端加密雲（檔案以用家自有 NAS／`H:` 路徑落地，靠現有 JWT＋權限）。
- 唔一次過重做全庫 70 萬張舊相壓縮（那是 server job）。

### 1.3 UX flow

```text
[登入] → JWT 存 Android Keystore / EncryptedSharedPreferences
    ↓
[設定]  Wi‑Fi only · 自動備份開關 · 目標裝置資料夾 · 品質表（可睇，MVP 鎖定）
    ↓
[手動] 揀相／成個相簿    或    [自動] MediaStore 新相 + WorkManager
    ↓
每張：讀檔 →（可選）剝 Motion → 分類 → 定 quality
    ↓
計 originalContentHash（剝 Motion 後、壓縮前）
    ↓
POST /api/backup/check-hash  →  alreadyExists? → SKIP（標「已在庫」）
    ↓ 否
壓縮 JPEG → 計 compressedQuickHash / size
    ↓
POST /api/backup/upload (multipart) → 寫碟 + 入 DB（或標 pending-rescan）
    ↓
通知／進度列：ok / skip / fail；失敗入 offline queue
```

**Progress UI 最低要求**

- 總數、已處理、skip、fail、剩餘估計時間（粗略）。
- 可暫停／繼續；暫停唔丟 queue。
- 單張可睇：檔名、類別、quality、原 size → 新 size、hash 狀態。

**Wi‑Fi only**

- 預設 `true`。流動網絡時 queue 暫停，唔取消。
- 用家可強制「今次用流動數據」（一次有效）。

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

### 2.2 推薦做法（實用）

**線上（優先）**

1. App 產生細 thumbnail（最長邊 ≤ 512，JPEG q70）上傳去 **臨時 classify**，或重用將來 `POST /api/backup/classify-preview`（見 §4.4）。
2. Server 用現有 EmbeddingGemma + `lib/embed-classifier.js` + `config/embed-categories.json` 做 cosine prototype classify（同 `/jobs` classify 一致）。
3. 回 `labels[]` + scores → App map 去 `qualityClass`。

**離線 fallback（無網／server 忙）**

1. 用家手動 tag（三掣：人物／食物／文件／其他）— 最準、MVP 必備。
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
| `quick_hash` | **快速 hash**：`MD5( head[0..min(64KiB,size)] ‖ tail[last min(64KiB,size)] ‖ ascii(size) )`（見 `server.js` `computeQuickHash`、`lib/daily-pipeline-job.js`） |

Thumbnail cache key：`file_hash` ∈ {`hash`,`md5`,`quick_hash`} + `file_size`。

### 3.2 App 要計嘅 hash

對**每一張**建議計兩組：

1. **`originalContentHash`（查重主鍵）**  
   - 演算法：全檔 **MD5**（hex lowercase）  
   - 對象位元組：讀入原檔 → **剝走 Motion Photo trailer 之後**、**JPEG 有損重壓之前** 嘅 JPEG／影像 bytes  
   - 為什麼：壓縮後 size／bytes 變，唔可以用壓縮後 hash 對「同一張原相」；剝 Motion 後先 hash，避免同一張相有／無 trailer 被當成兩張。

2. **`originalQuickHash`（可選、加速對庫）**  
   - 同上「剝 Motion 後、壓縮前」bytes，用 server 同一套 quick_hash 公式。  
   - 用途：同已經掃入庫、未壓縮嘅 `H:\...\Camera\...` 原檔對位。

3. **`compressedQuickHash` + `compressedSize`**  
   - 上載完成後，server 對落地檔再計一次（權威）；client 可附帶作完整性核對。

### 3.3 Check-before-upload 邏輯

`POST /api/backup/check-hash` 輸入 `originalContentHash`（必填）、可選 `originalQuickHash`、`originalSize`、`name`。

Server 視為 **alreadyExists** 若任一命中：

1. 新表 `mobile_backup_uploads.content_hash = originalContentHash`（推薦，見 §4.5）  
2. 或 `scanned_files.md5 = originalContentHash`  
3. 或（弱匹配）`scanned_files.quick_hash = originalQuickHash` **且** `size` 接近／相等（僅作 hint；MVP 可用嚟「可能已有原檔」，仍建議以 content_hash 為準）

回應應清楚：`exists`、`matchType`（`backup_table`|`scanned_md5`|`scanned_quick_hash`|`none`）、可選 `fileId`／`path`。

**注意**：壓縮後嘅檔 **唔應該** 用嚟當「原相已備份」嘅唯一證據；查重永遠用 `originalContentHash`。

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
  "originalContentHash": "a1b2c3d4e5f6789012345678abcdef01",
  "originalQuickHash": "f0e1d2c3b4a5968778695a4b3c2d1e0f",
  "originalSize": 4821934,
  "name": "IMG_20261029_153012.jpg",
  "deviceId": "xiaomi-14t-pro"
}
```

**Response 200**

```json
{
  "exists": true,
  "matchType": "backup_table",
  "fileId": 123456,
  "path": "H:\\silverchan\\Photos\\MobileBackup\\AndroidApp\\xiaomi-14t-pro\\2026\\10\\IMG_20261029_153012.jpg",
  "uploadedAt": "2026-10-29T15:40:00+08:00"
}
```

```json
{
  "exists": false,
  "matchType": "none"
}
```

**Errors**：`401` 無／過期 token；`403` 無 photo permission；`400` 缺 hash。

### 4.2 `POST /api/backup/check-hash/batch`（建議 MVP+）

一次最多 100 個 hash，減少 RTT。

```json
{
  "items": [
    { "originalContentHash": "...", "originalSize": 1, "name": "a.jpg" },
    { "originalContentHash": "...", "originalSize": 2, "name": "b.jpg" }
  ]
}
```

```json
{
  "results": [
    { "originalContentHash": "...", "exists": false, "matchType": "none" },
    { "originalContentHash": "...", "exists": true, "matchType": "scanned_md5", "fileId": 99 }
  ]
}
```

### 4.3 `POST /api/backup/upload`

Multipart form：

| Field | Type | 說明 |
|---|---|---|
| `file` | file | 壓縮後 JPEG（必填） |
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
| `stripMotion` | string | `"true"`/`"false"` — client 有冇剝過 |
| `idempotencyKey` | string | 建議：`originalContentHash`（重試安全） |

**Response 201**

```json
{
  "ok": true,
  "fileId": 123457,
  "path": "H:\\silverchan\\Photos\\MobileBackup\\AndroidApp\\xiaomi-14t-pro\\2026\\10\\IMG_20261029_153012.jpg",
  "size": 412088,
  "quickHash": "aabbccddeeff00112233445566778899",
  "deduped": false
}
```

若 hash 已存在：**200** + `{ "ok": true, "deduped": true, ... }`（唔寫第二份檔；idempotent）。

**Response 413**：檔太大（見 §5.4）。  
**Response 415**：非 JPEG／唔支援格式。

**Server 處理步驟（建議）**

1. Auth + photo permission。  
2. 以 `originalContentHash` 再 check 一次（防 race）。  
3. 落地去 §6 路徑（atomic write：`.partial` → rename）。  
4. 插入／更新 `mobile_backup_uploads`；確保 `folder_tree` 有父資料夾；`scanned_files` insert（name/size/mtime/`md5`=`originalContentHash` 或另存欄、`quick_hash`=壓縮檔 quick_hash）。  
5. （可選）enqueue `thumb-hash`／之後 embed／classify job（同現有 split pipeline）。  
6. **唔好**信任 client 嘅 compressed hash；server 自計。

### 4.4 `POST /api/backup/classify-preview`（建議；可 Phase 2）

細圖 classify，唔寫碟。

```json
// multipart: thumb (≤512px JPEG) 或 raw base64
{
  "labels": [
    { "label": "食物", "score": 0.71 },
    { "label": "其他", "score": 0.22 }
  ],
  "qualityClass": "food",
  "quality": 80
}
```

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
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_content_hash (content_hash),
  INDEX idx_device_created (device_id, created_at),
  INDEX idx_file_id (file_id)
);
```

Migration 掛入現有 `lib/database.js` version chain。

### 4.6 Auth 備註

- Header：`Authorization: Bearer …`（優先）；cookie `silverfs_token` 主要畀瀏覽器 img，App 唔依賴 cookie。  
- Token 24h：App 要 refresh（重新 login）或日後加 refresh token（open question）。  
- 需要 `requirePhotoPermission`；backup 寫入可視為 photo 寫權限（若將來拆 `backup` permission，另加）。

---

## 5. Compression rules

對齊 PC 腳本 `scripts/compress-strip-motion.cjs`，手機端用同等語意（Android：`Bitmap`/`ImageDecoder` + 自寫 Motion strip，或 DocumentFile + native）。

### 5.1 Pipeline（每張）

1. 讀原檔 bytes。  
2. **Strip Motion Photo**（Google XMP `MotionPhoto` / `MicroVideoOffset`、Xiaomi MVIMG 語意）→ 淨 JPEG。  
3. 若 HEIC／HEIF：decode → 轉 JPEG（再入下面 quality）。  
4. 計 `originalContentHash`／可選 `originalQuickHash`。  
5. `check-hash` → skip 或 continue。  
6. Lossy recompress JPEG（quality 見表；`4:2:0`；保留合理 max side，見下）。  
7. 盡量保留拍攝時間：寫回 EXIF `DateTimeOriginal`／GPS（若私隱設定允許）。  
8. Upload。

### 5.2 Quality table

| qualityClass | JPEG quality | 典型用途 |
|---|---:|---|
| `person` | **92** | 人像要靚 |
| `food` | **80** | 食物可再壓 |
| `docs` | **60** | 收據餐牌資料，可讀字即可 |
| `other` | **85** | 預設 |

### 5.3 尺寸／格式

- 輸出：**JPEG only**（`.jpg`）。  
- 最長邊上限（建議）：`person` 4096；`food`/`other` 3072；`docs` 2560（可設定）。超過先 downscale 再壓。  
- 已係細圖（例如 &lt; 200KB 且最長邊 &lt; 1600）而且 class≠`docs`：可 **skip recompress**（仍剝 Motion + 仍 check-hash）。  
- 獨立 `.mp4`（唔喺 JPG 內）：MVP **忽略**；設定頁可顯示「已跳過 N 個短片」。

### 5.4 Size limits（server）

- 單檔 upload body 上限建議 **32 MB**（壓縮後理應遠低於呢個）。  
- Batch 並行：App 端最多 2–3 條上載；server 可用現有 rate limit middleware。

### 5.5 同 PC 腳本差異

| | PC `compress-strip-motion` | Android app |
|---|---|---|
| 預設 quality | 固定 85 | 按類別 92／80／60／85 |
| 輸出位置 | 可另 folder `10_compressed` | 直接上 server 約定 path |
| 原檔 | 本機 `_bak_before_compress` | 留喺手機相簿；server 只收壓縮版 |

---

## 6. Storage path / folder mapping

### 6.1 建議落地根

同現有 MobileBackup 習慣對齊：

```text
H:\silverchan\Photos\MobileBackup\AndroidApp\<deviceId>\<YYYY>\<MM>\<filename>.jpg
```

- `<deviceId>`：App 設定（例如 `xiaomi-14t-pro`），sanitise `[A-Za-z0-9_-]`。  
- `<YYYY>/<MM>`：優先 EXIF 拍攝日；否則 file mtime；再否則上載當日（Asia/Hong_Kong）。  
- 檔名：保留原名（衝突時加 `_<shortHash6>`）。

可選第二用家根（設定）：

```text
H:\JennyNg\Photos\MobileBackup\AndroidApp\<deviceId>\...
```

### 6.2 同 daily rescan 關係

- 將 `...\AndroidApp` 加落 `config/daily-refresh-folders.json`（或 pathPrefix=`H:\` 已覆蓋）。  
- 03:00 rescan 會發現新檔；03:30 thumb → 04:30 embed → 05:30 classify 會補齊。  
- Upload handler 亦可即刻 enqueue 細批 `thumb-hash`（可選加速）。

### 6.3 唔寫入

- 唔寫入 `_bak_before_compress`、recycle、`10_compressed` 舊實驗路徑（除非用家明示）。

---

## 7. Offline queue / retries / privacy

### 7.1 Offline queue

- Room DB（或同等）：pending items = uri、contentHash、qualityClass、state、attempts、lastError。  
- 無網／非 Wi‑Fi：只做本地壓縮＋hash，upload 暫停。  
- 有網恢復：先 `check-hash/batch`，再 upload 未存在嘅。

### 7.2 Retries

- 指數退避：1m / 5m / 15m / 1h；最多 N=8。  
- `401`：清 token、提示重新登入，唔盲 retry。  
- `409`／dedupe：當成功 skip。  
- 可部分失敗：其餘繼續。

### 7.3 Privacy

- JWT／密碼只放 EncryptedStorage；log 唔印 token。  
- 預設 **上載前剝 GPS** 可作選項（預設：保留 EXIF 時間、GPS 跟用家開關，預設「保留」以對齊現有相庫）。  
- Motion 短片剝走後唔上載（除非將來獨立 opt-in）。  
- classify-preview 臨時圖：server **唔持久化**（記憶體／temp 即刪）。  
- 用家可「暫停自動備份」、可刪本機 queue（唔刪已上載）。

---

## 8. MVP phases

### Phase 0 — Server stubs（約小）

- Migration `mobile_backup_uploads`  
- `POST /api/backup/check-hash`（+ batch）  
- `POST /api/backup/upload`（multipart、idempotent）  
- 權限、大小限制、路徑設定（config key，例如 `backup.androidRoot`）  
- 手動用 `curl`／小 script smoke test

### Phase 1 — Android MVP

- Login + Wi‑Fi only + 手動選相  
- Motion strip + JPEG compress（固定 quality 表）  
- 手動 `qualityClass` 三＋一掣（未接 classify API 都可用）  
- check-hash → upload → 進度 UI  
- Offline queue + 基本 retry

### Phase 2 — Smart classify

- `classify-preview` 接 embedding  
- 自動備份（MediaStore observer + WorkManager）  
- Batch check-hash  
- 上傳後觸發 thumb job

### Phase 3 — Polish

- 雙 tag 保守 quality、HEIC 完善、統計頁（慳咗幾多 MB）  
- Refresh token、多 profile（silverchan／JennyNg）  
- 可選：同 PC compressed folder 工具對賬報告

---

## 9. Open questions

1. **原檔要唔要同時留一份喺 server？** 而家 SPEC 假設 **只存壓縮版**；若要「原檔 archive」，要另 path／另 opt-in（空間差好大）。  
2. **`originalContentHash` 用全檔 MD5 定 SHA-256？** 為對齊 `scanned_files.md5`，MVP 建議 **MD5**；長遠可加 `content_sha256` 欄。  
3. **已存在嘅係「未壓縮原檔」時，要唔要上傳壓縮版覆蓋？** 建議預設 **skip、唔覆蓋**；另提供「replace with compressed」進階操作（危險，要確認）。  
4. **GPS／人臉私隱預設？** 保留 GPS vs 剝離；自動備份是否排除「截圖」相簿。  
5. **多用戶／多機**：`deviceId` 撞名點辦？要唔要綁 `user_id`+hardware id。  
6. **Embedding server 未起**：classify-preview 失敗時，自動備份用 `other@85` 定暫停等人手 tag？  
7. **Quota**：每用家每日上載張數／GB 上限？  
8. **App 簽名同分發**：只內部分 APK，定 Play 內測？影響 deep link／認證 redirect。  
9. **路徑碟符**：server 係咪永遠有 `H:`？離線時 upload 應 queue 喺 server 定直接 503？（建議 server 本地 staging 再搬去 `H:`）  
10. **同現有 `H:\...\DCIM\Camera\2026\10` 原檔並存**：用家要唔要 UI 顯示「庫內已有原檔，已 skip」連去 `/tree`？

---

## 10. Implementation notes（畀之後 coding agent）

- **唔好**喺 SPEC 階段改 production 行為以外嘅大重構；新 route 獨立 module 例如 `lib/android-backup.js` 再 mount。  
- Hash 公式必須同 `computeQuickHash` bit-identical（64KiB head/tail + size string + md5 hex）。  
- 分類 label 字串必須同 `config/embed-categories.json` **一字不差**（`人物單人`、`收據餐牌資料`…）。  
- 上載後避免重複巨型 daily-pipeline；優先 enqueue 細批 `thumb-hash`／`embed`／`classify`（現有 split job types）。  
- 測試：用已知 Motion Photo 樣本（見先前 `2026\10` dry-run）驗證 strip → hash 穩定。  
- Commit／PR 描述唔好寫 secret；config 只加非 secret 鍵名。

---

## 11. Acceptance criteria（SPEC 完成後實作時）

- [ ] 同一張相（剝 Motion 後）重複上載第二次 → `deduped: true`，碟上得一份。  
- [ ] `person`/`food`/`docs` 三張樣本壓完 quality 分別為 92／80／60（Exif／encoder 設定可驗證）。  
- [ ] Motion Photo 上載後檔案唔再含 MP4 trailer。  
- [ ] Wi‑Fi only 開啟時，模擬流動網絡唔會發 upload。  
- [ ] JWT 過期會提示重新登入，queue 保留。  
- [ ] 新檔出現喺約定 `AndroidApp\...` 路徑，且可被 `/tree`／daily rescan 見到。

---

*End of spec.*

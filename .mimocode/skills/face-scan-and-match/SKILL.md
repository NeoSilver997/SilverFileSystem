---
name: face-scan-and-match
description: Scan photos for faces, embed with InsightFace, and match to named groups
---

# Face Scan and Match

Scan photos for faces, compute InsightFace embeddings, and match to named groups.

## Steps

1. **Scan photos:**
   ```bash
   node bin/cli.js face-scan --limit 500 --min-confidence 0.5
   ```

2. **Re-embed with InsightFace** (if needed):
   - Faces without InsightFace embeddings need re-embedding
   - Use `scripts/face_yunet_insightface.py` for YuNet detection + InsightFace embedding
   - Or use persistent worker for batch processing

3. **Match to named groups:**
   - `lib/face-detector.js` → `findMatchingGroup()`
   - Uses cosine similarity on 512-dim ArcFace embeddings
   - Threshold: 0.82 (with MagFace quality filtering)
   - Sets `suggested_group_id` for review

4. **Review in UI:**
   - Open `/faces` → Review tab
   - Confirm/reject matches
   - Or use bulk confirm/reject

## Update All Thumbnails

When bbox logic changes (e.g., switching from InsightFace bbox to YuNet bbox), update all existing thumbnails:

```bash
node scripts/update-all-thumbnails.js
```

This script:
- Reads all faces from `faces_v2` table
- Re-runs YuNet detection on each file to get correct bbox
- Regenerates thumbnails from the correct head area
- Updates bbox and thumbnail in the database

## Key Files
- `lib/face-detector.js` — matching logic
- `scripts/face_yunet_insightface.py` — YuNet detection + InsightFace embedding
- `scripts/face_multimodel.py` — multi-model fallback
- `scripts/update-all-thumbnails.js` — batch thumbnail update
- `bin/cli.js` — face-scan command

## Notes
- Persistent worker mode is default (37x speed improvement)
- Threshold 0.82 prevents false positives between similar-looking people
- MagFace quality filtering removes low-quality embeddings
- Bbox uses YuNet detection (full head area), NOT InsightFace's tight face bbox

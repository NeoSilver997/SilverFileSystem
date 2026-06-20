---
name: re-embed-faces
description: Re-embed faces with InsightFace ArcFace 512-dim embeddings
---

# Re-Embed Faces

Re-embed faces that have old/incompatible embeddings with InsightFace ArcFace 512-dim.

## When to Use
- Faces have old embeddings (no `model` field in face_descriptor)
- Need consistent embeddings across all faces
- Improving matching accuracy

## Steps

1. **Check embedding status:**
   ```sql
   SELECT COUNT(*) as c FROM detected_faces
   WHERE face_descriptor IS NOT NULL
   AND JSON_EXTRACT(face_descriptor, '$.model') IS NULL
   ```

2. **Re-embed with YuNet+InsightFace:**
   - Use `scripts/face_yunet_insightface.py` (primary detector)
   - YuNet detects faces, InsightFace computes embeddings
   - Persistent worker mode for batch processing

3. **Update face_descriptor:**
   ```json
   {
     "thumbnail": "...",
     "phash": 123456,
     "dhash": 789012,
     "embedding": [float, float, ...],  // 512-dim
     "model": "yunet+buffalo_l"
   }
   ```

4. **Verify:**
   ```sql
   SELECT COUNT(*) as c FROM detected_faces
   WHERE JSON_EXTRACT(face_descriptor, '$.model') IS NOT NULL
   ```

## Key Files
- `scripts/face_yunet_insightface.py` — YuNet detection + InsightFace embedding
- `scripts/face_multimodel.py` — multi-model fallback
- `lib/face-detector.js` — persistent worker management

## Notes
- YuNet downscaled to 1024px for detection
- InsightFace computes 512-dim ArcFace embeddings
- Persistent worker: model loads once (15s), then 0.6s per image
- All named group samples must have embeddings for matching to work

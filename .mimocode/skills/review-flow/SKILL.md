---
name: review-flow
description: Review and confirm/reject face matches in the named group system
---

# Face Match Review Flow

Review auto-matched faces and confirm/reject before final linking.

## How It Works

1. **Auto-match** sets `suggested_group_id` (not `face_group_id`)
2. **Review tab** shows faces with suggested group
3. **User confirms** → moves to `face_group_id` (final link)
4. **User rejects** → clears suggestion

## Review API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/faces/review` | GET | List pending reviews |
| `/api/faces/review/:faceId/confirm` | POST | Confirm match |
| `/api/faces/review/:faceId/reject` | POST | Reject match |
| `/api/faces/review/:faceId/reassign` | POST | Reassign to different group |
| `/api/faces/review/bulk-confirm` | POST | Confirm all for a group |
| `/api/faces/review/bulk-reject` | POST | Reject all for a group |

## UI Features

- **Review tab** shows faces grouped by target group
- **Confidence score** displayed (cosine similarity)
- **Model tag** shows which InsightFace model was used
- **Per-face buttons**: Confirm ✓, Reject ✕, Reassign ↗
- **Bulk actions**: Confirm All / Reject All per group

## Key Files
- `server.js` — Review API endpoints
- `public/faces.html` — Review tab UI
- `lib/face-detector.js` — `findMatchingGroup()` logic

## Notes
- Threshold 0.82 prevents false positives
- MagFace quality filtering removes low-quality embeddings
- Grace and Jenny are mother/daughter — 0.58 cosine similarity is expected

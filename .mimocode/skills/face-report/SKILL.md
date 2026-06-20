---
name: face-report
description: Generate HTML report showing face matching scores against named groups
---

# Face Report Generation

Generate HTML report showing face thumbnails with similarity scores against all named groups.

## Steps

1. **Query faces:**
   ```sql
   SELECT df.id, df.confidence, df.gender, df.age, df.face_descriptor, sf.name
   FROM detected_faces df
   JOIN scanned_files sf ON df.file_id = sf.id
   WHERE df.confidence >= 0.5
   AND df.face_group_id IS NULL
   AND df.face_descriptor IS NOT NULL
   AND JSON_EXTRACT(df.face_descriptor, '$.embedding') IS NOT NULL
   AND JSON_EXTRACT(df.face_descriptor, '$.model') IS NOT NULL
   ORDER BY df.confidence DESC
   LIMIT 50
   ```

2. **Compute scores:**
   - For each face, compute cosine similarity against all named group samples
   - Use `face-detector.js` → `findMatchingGroup()` with threshold=0
   - Sort scores descending per face

3. **Generate HTML:**
   - Face thumbnails (base64)
   - Scores color-coded: green (≥0.75), yellow (≥0.5), gray (<0.5)
   - Match badge for scores ≥0.75
   - Named group reference thumbnails

4. **Save and serve:**
   - Save to `public/face_report_<timestamp>.html`
   - Open in browser: `http://localhost:4001/face_report_<timestamp>.html`

## Key Files
- `lib/face-detector.js` — `findMatchingGroup()`, `cosineSimilarity()`
- `public/face_matching_v2.html` — latest report template

## Notes
- Use unique filenames with timestamps to avoid browser caching issues
- Verify scores are non-zero before showing to user
- Report shows actual cosine similarity, not binary match/no-match

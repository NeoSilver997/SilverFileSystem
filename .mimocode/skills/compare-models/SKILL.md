---
name: compare-models
description: Compare InsightFace model variants for face detection and embedding accuracy
---

# Compare InsightFace Models

Test different InsightFace model variants to find the best for your use case.

## Available Models

| Model | Architecture | Training Data | Size | Best For |
|-------|-------------|---------------|------|----------|
| buffalo_l | ResNet50 | WebFace600K | 326MB | Balance of speed/accuracy |
| antelopev2 | ResNet100 | Glint360K | 408MB | Highest accuracy |
| buffalo_m | ResNet50 | WebFace600K | 313MB | Similar to buffalo_l |
| buffalo_s | MobileFaceNet | WebFace600K | 158MB | Mobile/edge |
| buffalo_sc | MobileFaceNet | WebFace600K | 15MB | Compact/fastest |

## Testing

1. **Test detection quality:**
   ```bash
   node scripts/_compare_models.js
   ```

2. **Compare embedding quality:**
   - Compute cosine similarity between same-person pairs
   - Check self-similarity within groups
   - Measure cross-group separation

3. **Benchmark speed:**
   - Model load time
   - Per-image inference time
   - Batch processing throughput

## Key Findings

- **buffalo_l/antelopev2** detect ~206 faces per batch (best)
- **buffalo_s/buffalo_sc** detect ~151 faces (miss ~27%)
- **antelopev2** has highest accuracy but slower
- **buffalo_l** best balance of speed/accuracy

## Key Files
- `scripts/face_multimodel.py` — multi-model support
- `lib/face-detector.js` — model selection logic
- `~/.insightface/models/` — installed models

## Notes
- All 5 models confirmed working after fixing nested directory structure
- antelopev2/buffalo_m had files in nested subdirectories
- Model detection quality varies significantly

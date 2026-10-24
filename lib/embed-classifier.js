/**
 * Embedding-based coarse image taxonomy via text prototypes (EmbeddingGemma).
 * Labels align with VLM photo_classifications ENUM — does NOT write photo_classifications.
 */
import { EmbeddingClient } from './embedding-client.js';

/** Same labels as VLM: 人物單人|人物合照|風景|動物|食物|收據餐牌資料|螢幕截圖|其他 */
export const EMBED_CATEGORY_PROTOTYPES = [
  {
    label: '人物單人',
    prompt:
      'task: image classification | query: 單人肖像 selfie portrait of one person alone close-up face single person photo'
  },
  {
    label: '人物合照',
    prompt:
      'task: image classification | query: 多人合照群相 group photo family friends several people together crowd gathering'
  },
  {
    label: '風景',
    prompt:
      'task: image classification | query: 風景山水城市天空 landscape scenery mountains beach city skyline outdoor vista nature view'
  },
  {
    label: '動物',
    prompt:
      'task: image classification | query: 動物寵物貓狗鳥 wildlife animal pet cat dog bird creature fauna'
  },
  {
    label: '食物',
    prompt:
      'task: image classification | query: 食物食譜菜式餐點甜品 recipe food dish meal cooking plated cuisine dessert restaurant plate'
  },
  {
    label: '收據餐牌資料',
    prompt:
      'task: image classification | query: 收據發票文件餐牌菜單表格 document receipt invoice menu form paper text document scan'
  },
  {
    label: '螢幕截圖',
    prompt:
      'task: image classification | query: 螢幕截圖手機畫面UI介面 screenshot of phone or computer screen app UI interface capture'
  }
];

export const EMBED_CATEGORY_OTHER = '其他';

export function cosineSimilarity(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (!denom) return 0;
  return dot / denom;
}

export function classifyAgainstPrototypes(embedding, prototypes, minScore = 0.25) {
  const scores = {};
  let best = null;
  let bestScore = -Infinity;
  for (const p of prototypes) {
    const s = cosineSimilarity(embedding, p.embedding);
    scores[p.label] = s;
    if (s > bestScore) {
      bestScore = s;
      best = p.label;
    }
  }
  if (!best || bestScore < minScore) {
    return { category: EMBED_CATEGORY_OTHER, score: bestScore > 0 ? bestScore : 0, scores };
  }
  return { category: best, score: bestScore, scores };
}

export class EmbedClassifier {
  constructor(config = {}) {
    this.client = config.client || new EmbeddingClient(config.embedConfig || {});
    this.minScore = parseFloat(
      config.minScore ?? process.env.EMBED_CLASSIFY_MIN_SCORE ?? '0.25'
    );
    this.model = this.client.model;
  }

  async ensurePrototypes(db, { forceRefresh = false } = {}) {
    const existing = await db.listEmbeddingCategoryPrototypes(this.model);
    const byLabel = new Map(existing.map((r) => [r.label, r]));
    const out = [];

    for (const proto of EMBED_CATEGORY_PROTOTYPES) {
      const row = byLabel.get(proto.label);
      if (row && !forceRefresh && Array.isArray(row.embedding) && row.embedding.length) {
        out.push({
          label: proto.label,
          prompt: row.prompt_text || proto.prompt,
          embedding: row.embedding,
          dims: row.dims,
          model: row.model
        });
        continue;
      }
      const emb = await this.client.embedText(proto.prompt);
      await db.upsertEmbeddingCategoryPrototype({
        label: proto.label,
        model: emb.model || this.model,
        dims: emb.dims,
        embedding: emb.embedding,
        promptText: proto.prompt
      });
      out.push({
        label: proto.label,
        prompt: proto.prompt,
        embedding: emb.embedding,
        dims: emb.dims,
        model: emb.model || this.model
      });
    }
    return out;
  }

  classify(embedding, prototypes) {
    return classifyAgainstPrototypes(embedding, prototypes, this.minScore);
  }
}

export default EmbedClassifier;

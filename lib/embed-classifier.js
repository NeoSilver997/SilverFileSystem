/**
 * Embedding-based coarse image taxonomy via text prototypes (EmbeddingGemma).
 * Labels align with VLM photo_classifications ENUM — does NOT write photo_classifications.
 * Category list + keywords live in config/embed-categories.json (or EMBED_CATEGORIES_PATH).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { EmbeddingClient } from './embedding-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config', 'embed-categories.json');

/** Built-in fallback if config file is missing */
export const EMBED_CATEGORY_PROTOTYPES = [
  {
    label: '人物單人',
    keywords: ['單人肖像', 'selfie', 'portrait', 'one person', 'alone', 'close-up face', 'single person photo'],
    prompt: 'task: image classification | query: 人物單人 單人肖像 selfie portrait of one person alone close-up face single person photo'
  },
  {
    label: '人物合照',
    keywords: ['多人合照', '群相', 'group photo', 'family', 'friends', 'several people', 'crowd', 'gathering'],
    prompt: 'task: image classification | query: 人物合照 多人合照 群相 group photo family friends several people crowd gathering'
  },
  {
    label: '風景',
    keywords: ['風景', '山水', '城市', '天空', 'landscape', 'scenery', 'mountains', 'beach', 'skyline', 'outdoor', 'nature view'],
    prompt: 'task: image classification | query: 風景 山水 城市 天空 landscape scenery mountains beach skyline outdoor nature view'
  },
  {
    label: '動物',
    keywords: ['動物', '野生動物', '鳥', 'wildlife', 'animal', 'bird', 'fauna', 'creature'],
    prompt: 'task: image classification | query: 動物 野生動物 鳥 wildlife animal bird fauna creature'
  },
  {
    label: '貓',
    keywords: ['貓', '貓咪', '小貓', 'cat', 'kitten', 'feline', 'kitty'],
    prompt: 'task: image classification | query: 貓 貓咪 小貓 cat kitten feline kitty'
  },
  {
    label: '狗',
    keywords: ['狗', '小狗', '犬', 'dog', 'puppy', 'canine', 'hound'],
    prompt: 'task: image classification | query: 狗 小狗 犬 dog puppy canine hound'
  },
  {
    label: '車',
    keywords: ['車', '汽車', '電單車', '巴士', '貨車', '交通工具', 'car', 'motorcycle', 'motorbike', 'bus', 'truck', 'vehicle', 'automobile'],
    prompt: 'task: image classification | query: 車 汽車 電單車 巴士 貨車 交通工具 car motorcycle motorbike bus truck vehicle automobile'
  },
  {
    label: '花卉',
    keywords: ['花', '花卉', '植物', '盆栽', '園藝', 'flower', 'flowers', 'plant', 'plants', 'bloom', 'garden', 'botanical'],
    prompt: 'task: image classification | query: 花卉 花 植物 盆栽 園藝 flower flowers plant plants bloom garden botanical'
  },
  {
    label: '食物',
    keywords: ['食物', '食譜', '菜式', '餐點', '甜品', 'recipe', 'food', 'dish', 'meal', 'cooking', 'cuisine', 'dessert', 'restaurant plate'],
    prompt: 'task: image classification | query: 食物 食譜 菜式 餐點 甜品 recipe food dish meal cooking cuisine dessert restaurant plate'
  },
  {
    label: '收據餐牌資料',
    keywords: ['收據', '發票', '文件', '餐牌', '菜單', '表格', 'document', 'receipt', 'invoice', 'menu', 'form', 'paper', 'scan'],
    prompt: 'task: image classification | query: 收據餐牌資料 收據 發票 文件 餐牌 菜單 表格 document receipt invoice menu form paper scan'
  },
  {
    label: '螢幕截圖',
    keywords: ['螢幕截圖', '手機畫面', 'UI', '介面', 'screenshot', 'phone screen', 'computer screen', 'app UI', 'interface capture'],
    prompt: 'task: image classification | query: 螢幕截圖 手機畫面 UI 介面 screenshot phone screen computer screen app UI interface capture'
  }
];

export const EMBED_CATEGORY_OTHER = '其他';

export function resolveCategoriesPath(overridePath) {
  if (overridePath && String(overridePath).trim()) return path.resolve(String(overridePath).trim());
  if (process.env.EMBED_CATEGORIES_PATH && process.env.EMBED_CATEGORIES_PATH.trim()) {
    return path.resolve(process.env.EMBED_CATEGORIES_PATH.trim());
  }
  return DEFAULT_CONFIG_PATH;
}

export function buildPromptFromKeywords(label, keywords = []) {
  const parts = [label, ...(Array.isArray(keywords) ? keywords : [])].filter(Boolean);
  return 'task: image classification | query: ' + parts.join(' ');
}

function normalizeCategory(entry, fallbackOther = EMBED_CATEGORY_OTHER) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.enabled === false) return null;
  const label = String(entry.label || '').trim();
  if (!label || label === fallbackOther) return null;
  const keywords = Array.isArray(entry.keywords)
    ? entry.keywords.map((k) => String(k).trim()).filter(Boolean)
    : [];
  const promptOverride = entry.prompt != null ? String(entry.prompt).trim() : '';
  const prompt = promptOverride || buildPromptFromKeywords(label, keywords);
  return { label, keywords, prompt };
}

/**
 * Load categories from JSON config. Falls back to built-in defaults if missing/invalid.
 */
export function loadEmbedCategoriesConfig(overridePath) {
  const configPath = resolveCategoriesPath(overridePath);
  const fallback = {
    path: configPath,
    exists: false,
    mtimeMs: null,
    minScore: parseFloat(process.env.EMBED_CLASSIFY_MIN_SCORE || '0.25'),
    dualMinScore: parseFloat(process.env.EMBED_CLASSIFY_DUAL_MIN || '0.5'),
    maxTags: Math.max(1, Math.min(2, parseInt(process.env.EMBED_CLASSIFY_MAX_TAGS || '2', 10) || 2)),
    otherLabel: EMBED_CATEGORY_OTHER,
    conflictRules: [
      {
        preferLabels: ['人物單人', '人物合照'],
        dropLabels: ['貓', '狗'],
        minPreferScore: 0.5
      }
    ],
    categories: EMBED_CATEGORY_PROTOTYPES.map((p) => ({
      label: p.label,
      keywords: [...(p.keywords || [])],
      prompt: p.prompt
    })),
    suggestedExtras: []
  };

  try {
    if (!fs.existsSync(configPath)) return fallback;
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    const st = fs.statSync(configPath);
    const otherLabel = String(parsed.otherLabel || EMBED_CATEGORY_OTHER).trim() || EMBED_CATEGORY_OTHER;
    const minScore = Number.isFinite(Number(parsed.minScore))
      ? Number(parsed.minScore)
      : fallback.minScore;
    const dualMinScore = Number.isFinite(Number(parsed.dualMinScore))
      ? Number(parsed.dualMinScore)
      : fallback.dualMinScore;
    const maxTags = Math.max(1, Math.min(2, parseInt(parsed.maxTags ?? fallback.maxTags, 10) || 2));
    const list = Array.isArray(parsed.categories) ? parsed.categories : [];
    const categories = [];
    for (const entry of list) {
      const norm = normalizeCategory(entry, otherLabel);
      if (norm) categories.push(norm);
    }
    if (!categories.length) {
      return { ...fallback, exists: true, mtimeMs: st.mtimeMs, minScore, dualMinScore, maxTags, otherLabel, conflictRules: fallback.conflictRules };
    }
    const suggestedExtras = Array.isArray(parsed.suggestedExtras)
      ? parsed.suggestedExtras.filter((e) => e && e.label).map((e) => ({
          label: String(e.label).trim(),
          keywords: Array.isArray(e.keywords) ? e.keywords.map((k) => String(k).trim()).filter(Boolean) : [],
          note: e.note || null,
          prompt: e.prompt ? String(e.prompt).trim() : null
        }))
      : [];
    const conflictRules = normalizeConflictRules(parsed.conflictRules, fallback.conflictRules);
    return {
      path: configPath,
      exists: true,
      mtimeMs: st.mtimeMs,
      minScore,
      dualMinScore,
      maxTags,
      otherLabel,
      conflictRules,
      categories,
      suggestedExtras
    };
  } catch (err) {
    console.warn('[embed-classifier] Failed to load', configPath, err.message, '— using built-in defaults');
    return fallback;
  }
}


export function normalizeConflictRules(raw, fallback = []) {
  const src = Array.isArray(raw) && raw.length ? raw : fallback;
  const out = [];
  for (const rule of src || []) {
    if (!rule || typeof rule !== 'object') continue;
    const preferLabels = Array.isArray(rule.preferLabels)
      ? rule.preferLabels.map((x) => String(x).trim()).filter(Boolean)
      : [];
    const dropLabels = Array.isArray(rule.dropLabels)
      ? rule.dropLabels.map((x) => String(x).trim()).filter(Boolean)
      : [];
    if (!preferLabels.length || !dropLabels.length) continue;
    const minPreferScore = Number.isFinite(Number(rule.minPreferScore))
      ? Number(rule.minPreferScore)
      : 0.5;
    out.push({ preferLabels, dropLabels, minPreferScore });
  }
  return out;
}

/**
 * When a prefer label (e.g. person) and a drop label (e.g. cat) both score high,
 * keep the person tag and remove the animal — cuts cute-kid / daughter false positives.
 */
export function applyConflictRules(ranked, tags, scores, conflictRules = [], dualMinScore = 0.5) {
  if (!Array.isArray(conflictRules) || !conflictRules.length) {
    return { ranked, tags };
  }
  let nextRanked = ranked.map((r) => ({ ...r }));
  let nextTags = tags.map((tg) => ({ ...tg }));
  const scoreOf = (label) =>
    Number.isFinite(Number(scores?.[label])) ? Number(scores[label]) : 0;
  // Prefer must be within this gap of the animal score to overturn a clear animal primary
  const MARGIN = 0.06;

  for (const rule of conflictRules) {
    const preferHits = rule.preferLabels
      .map((label) => ({ label, score: scoreOf(label) }))
      .filter((x) => x.score >= rule.minPreferScore)
      .sort((a, b) => b.score - a.score);
    if (!preferHits.length) continue;

    const dropSet = new Set(rule.dropLabels);
    const dropHits = rule.dropLabels
      .map((label) => ({ label, score: scoreOf(label) }))
      .filter((x) => x.score >= dualMinScore)
      .sort((a, b) => b.score - a.score);
    if (!dropHits.length) continue;

    const bestPrefer = preferHits[0];
    const bestDrop = dropHits[0];
    const tagLabels = new Set(nextTags.map((tg) => tg.label));
    const bothInTags = preferHits.some((p) => tagLabels.has(p.label)) && dropHits.some((d) => tagLabels.has(d.label));
    const topIsDrop = nextRanked[0] && dropSet.has(nextRanked[0].label);
    const preferCompetitive = bestPrefer.score + MARGIN >= bestDrop.score;

    // Dual person+cat: always drop the animal tag (keeps person)
    if (bothInTags) {
      nextTags = nextTags.filter((tg) => !dropSet.has(tg.label));
      nextRanked = nextRanked.filter((r) => !dropSet.has(r.label));
      continue;
    }

    // Animal primary but person nearly as high → prefer person, drop animal
    if (topIsDrop && preferCompetitive) {
      nextRanked = [
        { label: bestPrefer.label, score: bestPrefer.score },
        ...nextRanked.filter((r) => r.label !== bestPrefer.label && !dropSet.has(r.label))
      ];
      nextTags = nextTags.filter((tg) => !dropSet.has(tg.label));
      if (!nextTags.some((tg) => tg.label === bestPrefer.label)) {
        nextTags.unshift({ label: bestPrefer.label, score: bestPrefer.score });
      }
      continue;
    }

    // Clear animal win (person lagging by > MARGIN): keep animal primary; still strip
    // person+animal dual if somehow present (handled above). Do nothing else.
  }

  const seen = new Set();
  nextTags = nextTags.filter((tg) => {
    if (seen.has(tg.label)) return false;
    seen.add(tg.label);
    return true;
  });
  nextTags.sort((a, b) => b.score - a.score);
  return { ranked: nextRanked, tags: nextTags };
}

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

export function classifyAgainstPrototypes(embedding, prototypes, minScore = 0.25, otherLabel = EMBED_CATEGORY_OTHER, opts = {}) {
  const dualMinScore = Number.isFinite(Number(opts.dualMinScore)) ? Number(opts.dualMinScore) : 0.5;
  const maxTags = Math.max(1, Math.min(2, parseInt(opts.maxTags ?? 2, 10) || 2));
  const conflictRules = Array.isArray(opts.conflictRules) ? opts.conflictRules : [];
  const scores = {};
  let ranked = [];
  for (const p of prototypes) {
    const s = cosineSimilarity(embedding, p.embedding);
    scores[p.label] = s;
    ranked.push({ label: p.label, score: s });
  }
  ranked.sort((a, b) => b.score - a.score);
  let top1 = ranked[0] || null;
  let top1Score = top1 ? top1.score : 0;
  if (!top1 || top1Score < minScore) {
    const score = top1Score > 0 ? top1Score : 0;
    return {
      category: otherLabel,
      score,
      category2: null,
      score2: null,
      tags: [{ label: otherLabel, score }],
      scores
    };
  }
  let tags = [{ label: top1.label, score: top1Score }];
  // Provisional dual before conflict — both must clear dualMinScore
  if (
    maxTags >= 2 &&
    ranked[1] &&
    top1Score >= dualMinScore &&
    ranked[1].score >= dualMinScore
  ) {
    tags.push({ label: ranked[1].label, score: ranked[1].score });
  }

  const resolved = applyConflictRules(ranked, tags, scores, conflictRules, dualMinScore);
  ranked = resolved.ranked;
  tags = resolved.tags;
  top1 = ranked[0] || tags[0] || null;
  top1Score = top1 ? top1.score : 0;
  if (!top1 || top1Score < minScore) {
    const score = top1Score > 0 ? top1Score : 0;
    return {
      category: otherLabel,
      score,
      category2: null,
      score2: null,
      tags: [{ label: otherLabel, score }],
      scores
    };
  }

  // Rebuild dual from post-conflict ranked list
  tags = [{ label: top1.label, score: top1Score }];
  let category2 = null;
  let score2 = null;
  if (
    maxTags >= 2 &&
    ranked[1] &&
    top1Score >= dualMinScore &&
    ranked[1].score >= dualMinScore
  ) {
    category2 = ranked[1].label;
    score2 = ranked[1].score;
    tags.push({ label: category2, score: score2 });
  }
  return {
    category: top1.label,
    score: top1Score,
    category2,
    score2,
    tags,
    scores
  };
}

export class EmbedClassifier {
  constructor(config = {}) {
    this.client = config.client || new EmbeddingClient(config.embedConfig || {});
    this.configPath = resolveCategoriesPath(config.categoriesPath);
    this._loaded = loadEmbedCategoriesConfig(this.configPath);
    const envMin = parseFloat(process.env.EMBED_CLASSIFY_MIN_SCORE || '0.25');
    this.minScore = parseFloat(
      config.minScore ?? this._loaded.minScore ?? envMin
    );
    const envDual = parseFloat(process.env.EMBED_CLASSIFY_DUAL_MIN || '0.5');
    this.dualMinScore = parseFloat(
      config.dualMinScore ?? this._loaded.dualMinScore ?? envDual
    );
    this.maxTags = Math.max(
      1,
      Math.min(
        2,
        parseInt(config.maxTags ?? this._loaded.maxTags ?? process.env.EMBED_CLASSIFY_MAX_TAGS ?? '2', 10) || 2
      )
    );
    this.conflictRules = normalizeConflictRules(config.conflictRules ?? this._loaded.conflictRules, this._loaded.conflictRules || []);
    this.otherLabel = this._loaded.otherLabel || EMBED_CATEGORY_OTHER;
    this.model = this.client.model;
  }

  /** Reload JSON from disk (picks up keyword edits). */
  reloadConfig() {
    this._loaded = loadEmbedCategoriesConfig(this.configPath);
    this.otherLabel = this._loaded.otherLabel || EMBED_CATEGORY_OTHER;
    if (Number.isFinite(Number(this._loaded.minScore))) this.minScore = Number(this._loaded.minScore);
    if (Number.isFinite(Number(this._loaded.dualMinScore))) this.dualMinScore = Number(this._loaded.dualMinScore);
    if (this._loaded.maxTags != null) {
      this.maxTags = Math.max(1, Math.min(2, parseInt(this._loaded.maxTags, 10) || 2));
    }
        this.conflictRules = normalizeConflictRules(this._loaded.conflictRules, this._loaded.conflictRules || []);
    return this._loaded;
  }

  getCategories() {
    return this._loaded.categories;
  }

  getConfigMeta() {
    return {
      path: this._loaded.path,
      exists: this._loaded.exists,
      mtimeMs: this._loaded.mtimeMs,
      minScore: this.minScore,
      dualMinScore: this.dualMinScore,
      maxTags: this.maxTags,
      conflictRules: this.conflictRules,
      otherLabel: this.otherLabel,
      categories: this._loaded.categories.map((c) => ({
        label: c.label,
        keywords: c.keywords,
        prompt: c.prompt
      })),
      suggestedExtras: this._loaded.suggestedExtras || []
    };
  }

  async ensurePrototypes(db, { forceRefresh = false } = {}) {
    // Always re-read config so keyword edits take effect without app restart
    this.reloadConfig();
    const categories = this._loaded.categories;
    const existing = await db.listEmbeddingCategoryPrototypes(this.model);
    const byLabel = new Map(existing.map((r) => [r.label, r]));
    const out = [];

    for (const proto of categories) {
      const row = byLabel.get(proto.label);
      const promptChanged = row && String(row.prompt_text || '') !== String(proto.prompt || '');
      const needsRefresh =
        forceRefresh ||
        !row ||
        !Array.isArray(row.embedding) ||
        !row.embedding.length ||
        promptChanged;

      if (!needsRefresh) {
        out.push({
          label: proto.label,
          keywords: proto.keywords,
          prompt: row.prompt_text || proto.prompt,
          embedding: row.embedding,
          dims: row.dims,
          model: row.model
        });
        continue;
      }
      if (promptChanged && !forceRefresh) {
        console.log('[embed-classifier] Prototype prompt changed for', proto.label, '— refreshing embedding');
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
        keywords: proto.keywords,
        prompt: proto.prompt,
        embedding: emb.embedding,
        dims: emb.dims,
        model: emb.model || this.model
      });
    }
    return out;
  }

  classify(embedding, prototypes) {
    return classifyAgainstPrototypes(embedding, prototypes, this.minScore, this.otherLabel, {
      dualMinScore: this.dualMinScore,
      maxTags: this.maxTags,
      conflictRules: this.conflictRules
    });
  }
}

export default EmbedClassifier;

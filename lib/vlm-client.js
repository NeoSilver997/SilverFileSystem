import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const FAST_PROMPT = `Analyze this image. Return ONLY a JSON object:
{"category":"[人物單人|人物合照|風景|動物|食物|收據餐牌資料|螢幕截圖|其他]","subject":"who/what is in the image, 1 sentence","action":"what they are doing, 1 sentence","background":"where this is, 1 sentence","style":"art style and lighting, 1 sentence","ai_prompt":"English prompt for Midjourney/SD to recreate this image","tags":["tag1","tag2","tag3"],"mood":"emotion/atmosphere","color_palette":"dominant colors","lighting":"light type","camera_angle":"shot type","confidence":0.85}`;

const DETAIL_PROMPT = `Analyze this image in detail. Return ONLY a JSON object:
{"category":"[人物單人|人物合照|風景|動物|食物|收據餐牌資料|螢幕截圖|其他]","subject":"Detailed description: gender, age, hair, clothing, accessories","action":"Detailed pose, gesture, expression, emotion","background":"Detailed environment: foreground, midground, background elements","style":"Art style, lighting technique, color theory, camera angle","ai_prompt":"High-quality English prompt for Midjourney/SD/DALL-E to recreate this","tags":["tag1","tag2","tag3","tag4","tag5"],"mood":"Overall atmosphere","color_palette":"Color scheme description","lighting":"Lighting description","camera_angle":"Camera perspective","confidence":0.85}`;

const SIZE_PRESETS = { tiny: 256, small: 384, medium: 512, large: 768, xl: 1024 };

function resolveMaxWidth(input, fallback = 384) {
  if (input == null || input === '') return fallback;
  if (typeof input === 'number' && Number.isFinite(input)) {
    return Math.min(2048, Math.max(64, Math.round(input)));
  }
  const key = String(input).trim().toLowerCase();
  if (SIZE_PRESETS[key] != null) return SIZE_PRESETS[key];
  const n = parseInt(key, 10);
  if (Number.isFinite(n)) return Math.min(2048, Math.max(64, n));
  return fallback;
}


function truncateBase64(dataUrlOrB64, keep = 48) {
  const s = String(dataUrlOrB64 || '');
  const m = s.match(/^(data:[^;]+;base64,)(.+)$/i);
  if (m) {
    return m[1] + m[2].slice(0, keep) + '…[' + m[2].length + ' chars]';
  }
  if (s.length > keep * 2) return s.slice(0, keep) + '…[' + s.length + ' chars]';
  return s;
}

function sanitizePayloadForDebug(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const out = JSON.parse(JSON.stringify(payload));
  const scrubMsg = (msg) => {
    if (!msg || typeof msg !== 'object') return msg;
    if (Array.isArray(msg.content)) {
      msg.content = msg.content.map((part) => {
        if (!part || typeof part !== 'object') return part;
        if (part.type === 'image_url' && part.image_url?.url) {
          return { ...part, image_url: { ...part.image_url, url: truncateBase64(part.image_url.url) } };
        }
        if (part.type === 'image' && part.image) {
          return { ...part, image: truncateBase64(part.image) };
        }
        return part;
      });
    }
    if (Array.isArray(msg.images)) {
      msg.images = msg.images.map((img) => truncateBase64(img));
    }
    return msg;
  };
  if (Array.isArray(out.messages)) out.messages = out.messages.map(scrubMsg);
  return out;
}

function buildDebugInfo({ prompt, question, mode, payload, rawApi, imageInfo, lmstudioUrl, attempt }) {
  return {
    lmstudioUrl: lmstudioUrl || null,
    endpoint: '/v1/chat/completions',
    model: payload?.model || null,
    mode: mode || null,
    prompt: prompt != null ? String(prompt) : null,
    question: question != null ? String(question) : null,
    request: sanitizePayloadForDebug(payload),
    response: rawApi || null,
    imageInfo: imageInfo || null,
    attempt: attempt || 1,
    at: new Date().toISOString()
  };
}

export { SIZE_PRESETS, resolveMaxWidth, sanitizePayloadForDebug, buildDebugInfo };

export class VLMClient {
  constructor(config = {}) {
    this.lmstudioUrl = config.lmstudioUrl || process.env.LMSTUDIO_URL || process.env.VLM_URL || 'http://127.0.0.1:8080';
    this.model = config.model || process.env.VLM_MODEL || 'qwen3.8-flash-next-iq2_xs-V-vision-128k-kv64k';
    this.timeout = config.timeout || 120000;
    this.maxImageWidth = resolveMaxWidth(config.maxImageWidth ?? process.env.VLM_MAX_WIDTH, 384);
    this.jpegQuality = Math.min(95, Math.max(30, parseInt(config.jpegQuality || process.env.VLM_JPEG_QUALITY || '55', 10) || 55));
    this.retryAttempts = config.retryAttempts || 1;
    this.retryDelay = config.retryDelay || 1000;
    // openai = Strata / OpenAI vision parts; lmstudio = legacy { content, images: [b64] }
    this.imageMode = config.imageMode || process.env.VLM_IMAGE_MODE || 'openai';
    this.apiKey = config.apiKey || process.env.VLM_API_KEY || '';
    if (!this.apiKey) {
      const keyFile = config.apiKeyFile || process.env.VLM_API_KEY_FILE || '';
      if (keyFile) {
        try {
          this.apiKey = fs.readFileSync(keyFile, 'utf8').trim();
        } catch {
          this.apiKey = '';
        }
      }
    }
  }

  authHeaders(extra = {}) {
    const headers = { ...extra };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  /** Build user message content for chat/completions (OpenAI multimodal or LM Studio legacy). */
  buildUserMessage(text, base64Jpeg) {
    if (this.imageMode === 'lmstudio') {
      return { role: 'user', content: text, images: [base64Jpeg] };
    }
    const url = base64Jpeg.startsWith('data:') ? base64Jpeg : `data:image/jpeg;base64,${base64Jpeg}`;
    return {
      role: 'user',
      content: [
        { type: 'text', text: String(text || '') },
        { type: 'image_url', image_url: { url } }
      ]
    };
  }

  async checkConnection() {
    try {
      const resp = await fetch(`${this.lmstudioUrl}/v1/models`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5000)
      });
      if (!resp.ok) return false;
      const data = await resp.json();
      const ids = (data.data || []).map(m => m.id);
      if (ids.includes(this.model)) return true;
      // Strata often exposes one loaded model; accept if list non-empty and model unset/aliased
      if ((this.model === 'strata' || this.model === 'default') && ids.length > 0) return true;
      return false;
    } catch {
      return false;
    }
  }

  async getAvailableModels() {
    try {
      const resp = await fetch(`${this.lmstudioUrl}/v1/models`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5000)
      });
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data.data || []).map(m => m.id);
    } catch {
      return [];
    }
  }

  /**
   * Prepare JPEG base64 from a raw image buffer (e.g. thumbnail_cache or disk read).
   * @param {Buffer} inputBuffer
   * @param {object} opts
   */
  async prepareImageBuffer(inputBuffer, opts = {}) {
    const limit = resolveMaxWidth(opts.maxWidth ?? this.maxImageWidth, this.maxImageWidth);
    const quality = this.jpegQuality;
    let buffer = Buffer.isBuffer(inputBuffer) ? inputBuffer : Buffer.from(inputBuffer);
    const meta = await sharp(buffer).metadata();
    let outWidth = meta.width || 0;
    let outHeight = meta.height || 0;
    const needsResize = (meta.width || 0) > limit || (meta.height || 0) > limit;
    const format = String(meta.format || '').toLowerCase();
    const isJpeg = format === 'jpeg' || format === 'jpg';

    if (needsResize) {
      const out = await sharp(buffer)
        .resize(limit, limit, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer({ resolveWithObject: true });
      buffer = out.data;
      outWidth = out.info.width;
      outHeight = out.info.height;
    } else if (!isJpeg) {
      buffer = await sharp(buffer).jpeg({ quality }).toBuffer();
    }

    return {
      base64: buffer.toString('base64'),
      originalSize: opts.originalSize != null ? opts.originalSize : buffer.length,
      processedSize: buffer.length,
      width: outWidth,
      height: outHeight,
      originalWidth: meta.width,
      originalHeight: meta.height,
      maxWidth: limit,
      jpegQuality: quality,
      source: opts.source || 'buffer'
    };
  }

  async prepareImage(filePath, maxWidth = this.maxImageWidth) {
    const limit = resolveMaxWidth(maxWidth, this.maxImageWidth);
    const stat = fs.statSync(filePath);
    const buffer = fs.readFileSync(filePath);
    return this.prepareImageBuffer(buffer, {
      maxWidth: limit,
      originalSize: stat.size,
      source: 'disk'
    });
  }

  async resolveImageInfo(filePath, options = {}) {
    const maxWidth = resolveMaxWidth(
      options.maxWidth ?? options.size ?? this.maxImageWidth,
      this.maxImageWidth
    );
    if (options.imageBuffer) {
      return this.prepareImageBuffer(options.imageBuffer, {
        maxWidth,
        originalSize: options.originalSize,
        source: options.source || 'thumbnail'
      });
    }
    return this.prepareImage(filePath, maxWidth);
  }

  async classifyImage(filePath, mode = 'fast', options = {}) {
    const prompt = mode === 'detail' ? DETAIL_PROMPT : FAST_PROMPT;
    const defaultW = mode === 'detail' ? 768 : this.maxImageWidth;
    const maxWidth = resolveMaxWidth(options.maxWidth ?? options.size ?? defaultW, defaultW);
    const maxTokens = mode === 'detail' ? 1536 : 768;
    let lastError = null;

    for (let attempt = 0; attempt <= this.retryAttempts; attempt++) {
      try {
        const imageInfo = await this.resolveImageInfo(filePath, { ...options, maxWidth });

        const payload = {
          model: this.model,
          messages: [this.buildUserMessage(prompt, imageInfo.base64)],
          temperature: 0.1,
          max_tokens: maxTokens,
          reasoning_effort: 'none'
        };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        const resp = await fetch(`${this.lmstudioUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: this.authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(payload),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          throw new Error(`LM Studio HTTP ${resp.status}: ${errText.slice(0, 200)}`);
        }

        const result = await resp.json();
        const content = result.choices?.[0]?.message?.content?.trim() || '';

        if (!content) throw new Error('Empty response from VLM');

        const classification = this.parseResponse(content);
        const imageMeta = {
          width: imageInfo.width,
          height: imageInfo.height,
          originalSize: imageInfo.originalSize,
          processedSize: imageInfo.processedSize,
          maxWidth: imageInfo.maxWidth,
          source: imageInfo.source || 'disk'
        };

        return {
          success: true,
          classification,
          model: this.model,
          mode,
          imageInfo: imageMeta,
          rawResponse: content,
          debug: buildDebugInfo({
            prompt,
            mode,
            payload,
            rawApi: result,
            imageInfo: imageMeta,
            lmstudioUrl: this.lmstudioUrl,
            attempt: attempt + 1
          }),
          attempt: attempt + 1
        };

      } catch (err) {
        lastError = err;
        if (attempt < this.retryAttempts) {
          await new Promise(r => setTimeout(r, this.retryDelay * (attempt + 1)));
        }
      }
    }

    return {
      success: false,
      error: lastError?.message || 'Unknown error',
      attempt: this.retryAttempts + 1
    };
  }


  /* __EGEMMA_MARK_ask__ */
  async askAboutImage(filePath, question, history = [], options = {}) {
    if (!question || !String(question).trim()) {
      return { success: false, error: 'question is required' };
    }
    const maxWidth = resolveMaxWidth(options.maxWidth ?? options.size ?? this.maxImageWidth, this.maxImageWidth);

    let lastError = null;
    for (let attempt = 0; attempt <= this.retryAttempts; attempt++) {
      try {
        const imageInfo = await this.resolveImageInfo(filePath, { ...options, maxWidth });
        const messages = [];
        for (const turn of history || []) {
          if (!turn?.role || !turn?.content) continue;
          messages.push({ role: turn.role, content: String(turn.content) });
        }
        messages.push(this.buildUserMessage(String(question), imageInfo.base64));

        const payload = {
          model: this.model,
          messages,
          temperature: 0.4,
          max_tokens: 1024,
          reasoning_effort: 'none'
        };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);
        const resp = await fetch(`${this.lmstudioUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: this.authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          throw new Error(`LM Studio HTTP ${resp.status}: ${errText.slice(0, 200)}`);
        }

        const result = await resp.json();
        const content = result.choices?.[0]?.message?.content?.trim() || '';
        if (!content) throw new Error('Empty response from VLM');
        const imageMeta = {
          width: imageInfo.width,
          height: imageInfo.height,
          originalSize: imageInfo.originalSize,
          processedSize: imageInfo.processedSize,
          maxWidth: imageInfo.maxWidth,
          source: imageInfo.source || 'disk'
        };

        return {
          success: true,
          answer: content,
          model: this.model,
          imageInfo: imageMeta,
          rawResponse: content,
          debug: buildDebugInfo({
            question: String(question),
            mode: 'ask',
            payload,
            rawApi: result,
            imageInfo: imageMeta,
            lmstudioUrl: this.lmstudioUrl,
            attempt: attempt + 1
          })
        };
      } catch (err) {
        lastError = err;
        if (attempt < this.retryAttempts) {
          await new Promise(r => setTimeout(r, this.retryDelay * (attempt + 1)));
        }
      }
    }

    return {
      success: false,
      error: lastError?.message || 'Unknown error'
    };
  }

  parseResponse(content) {
    let cleaned = content;
    const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenceMatch) cleaned = fenceMatch[1].trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleaned = jsonMatch[0];

    try {
      const parsed = JSON.parse(cleaned);
      return {
        category: this.validateCategory(parsed.category),
        subject: String(parsed.subject || ''),
        action: String(parsed.action || ''),
        background: String(parsed.background || ''),
        style: String(parsed.style || ''),
        ai_prompt: String(parsed.ai_prompt || ''),
        tags: Array.isArray(parsed.tags) ? parsed.tags.map(t => String(t)) : [],
        mood: String(parsed.mood || ''),
        color_palette: String(parsed.color_palette || ''),
        lighting: String(parsed.lighting || ''),
        camera_angle: String(parsed.camera_angle || ''),
        confidence: Math.min(1, Math.max(0, parseFloat(parsed.confidence) || 0.5))
      };
    } catch {
      return {
        category: '其他', subject: '', action: '', background: '', style: '',
        ai_prompt: '', tags: [], mood: '', color_palette: '', lighting: '',
        camera_angle: '', confidence: 0.1, _rawParseError: content.slice(0, 500)
      };
    }
  }

  validateCategory(category) {
    const valid = ['人物單人', '人物合照', '風景', '動物', '食物', '收據餐牌資料', '螢幕截圖', '其他'];
    if (valid.includes(category)) return category;
    const lower = String(category).toLowerCase();
    if (lower.includes('人') && lower.includes('合')) return '人物合照';
    if (lower.includes('人')) return '人物單人';
    if (lower.includes('風') || lower.includes('景') || lower.includes('land')) return '風景';
    if (lower.includes('動') || lower.includes('animal')) return '動物';
    if (lower.includes('食') || lower.includes('food')) return '食物';
    if (lower.includes('收') || lower.includes('據') || lower.includes('receipt')) return '收據餐牌資料';
    if (lower.includes('截') || lower.includes('screenshot')) return '螢幕截圖';
    return '其他';
  }

  isDataCategory(category) {
    return ['收據餐牌資料', '螢幕截圖'].includes(category);
  }

  isHighQualityCategory(category) {
    return ['人物單人', '人物合照', '風景', '動物', '食物'].includes(category);
  }
}

export class FastPreClassifier {
  constructor() {
    this.screenRatios = [
      { w: 9, h: 19.5, name: 'phone' },
      { w: 9, h: 20, name: 'phone' },
      { w: 9, h: 16, name: 'phone' },
      { w: 9, h: 18, name: 'phone' },
    ];
  }

  async analyze(filePath, exifData = {}) {
    const t0 = Date.now();
    const buffer = fs.readFileSync(filePath);
    const meta = await sharp(buffer).metadata();
    const stats = await sharp(buffer).stats();
    const stat = fs.statSync(filePath);

    const result = {
      width: meta.width,
      height: meta.height,
      format: meta.format,
      size: stat.size,
      channels: meta.channels,
      hasAlpha: meta.hasAlpha,
      dominance: this.getDominance(stats),
      brightness: this.getBrightness(stats),
      contrast: this.getContrast(stats),
      isPortrait: meta.height > meta.width * 1.3,
      isLandscape: meta.width > meta.height * 1.3,
      isSquare: Math.abs(meta.width - meta.height) < meta.width * 0.1,
      aspectRatio: (meta.width / meta.height).toFixed(2),
      hasCameraData: !!(exifData.camera?.make || exifData.camera?.model),
      hasGPS: !!(exifData.location?.latitude),
      hasDate: !!(exifData.datetime?.taken),
      fastCategory: null,
      confidence: 0,
      analyzeTime: 0
    };

    result.fastCategory = this.guessCategory(result);
    result.confidence = result.fastCategory ? 0.7 : 0.3;
    result.analyzeTime = Date.now() - t0;

    return result;
  }

  getDominance(stats) {
    const channels = stats.channels;
    if (!channels || channels.length < 3) return { r: 0, g: 0, b: 0, dominant: 'unknown' };

    const r = channels[0].mean;
    const g = channels[1].mean;
    const b = channels[2].mean;
    const max = Math.max(r, g, b);

    let dominant = 'neutral';
    if (r > g && r > b && r > 120) dominant = 'red';
    else if (g > r && g > b && g > 120) dominant = 'green';
    else if (b > r && b > g && b > 120) dominant = 'blue';
    else if (r > 150 && g > 150 && b < 100) dominant = 'yellow';
    else if (r > 150 && g < 100 && b > 100) dominant = 'magenta';
    else if (r < 80 && g < 80 && b < 80) dominant = 'dark';
    else if (r > 200 && g > 200 && b > 200) dominant = 'bright';

    return { r: Math.round(r), g: Math.round(g), b: Math.round(b), dominant };
  }

  getBrightness(stats) {
    const channels = stats.channels;
    if (!channels || channels.length < 3) return 0.5;
    const avg = (channels[0].mean + channels[1].mean + channels[2].mean) / 3;
    return Math.round(avg / 255 * 100) / 100;
  }

  getContrast(stats) {
    const channels = stats.channels;
    if (!channels || channels.length < 3) return 0;
    const stdDev = (channels[0].stdev + channels[1].stdev + channels[2].stdev) / 3;
    return Math.round(stdDev / 255 * 100) / 100;
  }

  guessCategory(info) {
    if (this.isScreenshot(info)) return '螢幕截圖';
    if (this.isReceiptish(info)) return '收據餐牌資料';
    if (info.dominance.dominant === 'green' && info.isLandscape) return '風景';
    if (info.dominance.dominant === 'blue' && info.isLandscape) return '風景';
    if (info.brightness > 0.7 && info.dominance.dominant === 'bright') return '風景';
    return null;
  }

  isScreenshot(info) {
    if (info.hasCameraData) return false;
    for (const ratio of this.screenRatios) {
      const r = info.width / info.height;
      const expected = ratio.w / ratio.h;
      if (Math.abs(r - expected) < 0.05) return true;
    }
    return false;
  }

  isReceiptish(info) {
    if (info.isPortrait && info.width > 800 && info.width < 2500) {
      if (info.brightness > 0.6 && info.contrast > 0.15) return true;
    }
    return false;
  }
}

export default VLMClient;

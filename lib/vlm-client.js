import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const FAST_PROMPT = `Analyze this image. Return ONLY a JSON object:
{"category":"[人物單人|人物合照|風景|動物|食物|收據餐牌資料|螢幕截圖|其他]","subject":"who/what is in the image, 1 sentence","action":"what they are doing, 1 sentence","background":"where this is, 1 sentence","style":"art style and lighting, 1 sentence","ai_prompt":"English prompt for Midjourney/SD to recreate this image","tags":["tag1","tag2","tag3"],"mood":"emotion/atmosphere","color_palette":"dominant colors","lighting":"light type","camera_angle":"shot type","confidence":0.85}`;

const DETAIL_PROMPT = `Analyze this image in detail. Return ONLY a JSON object:
{"category":"[人物單人|人物合照|風景|動物|食物|收據餐牌資料|螢幕截圖|其他]","subject":"Detailed description: gender, age, hair, clothing, accessories","action":"Detailed pose, gesture, expression, emotion","background":"Detailed environment: foreground, midground, background elements","style":"Art style, lighting technique, color theory, camera angle","ai_prompt":"High-quality English prompt for Midjourney/SD/DALL-E to recreate this","tags":["tag1","tag2","tag3","tag4","tag5"],"mood":"Overall atmosphere","color_palette":"Color scheme description","lighting":"Lighting description","camera_angle":"Camera perspective","confidence":0.85}`;

export class VLMClient {
  constructor(config = {}) {
    this.lmstudioUrl = config.lmstudioUrl || process.env.LMSTUDIO_URL || 'http://localhost:12355';
    this.model = config.model || process.env.VLM_MODEL || 'google/gemma-4-12b-qat';
    this.timeout = config.timeout || 120000;
    this.maxImageWidth = config.maxImageWidth || 512;
    this.retryAttempts = config.retryAttempts || 1;
    this.retryDelay = config.retryDelay || 1000;
  }

  async checkConnection() {
    try {
      const resp = await fetch(`${this.lmstudioUrl}/v1/models`, {
        signal: AbortSignal.timeout(5000)
      });
      if (!resp.ok) return false;
      const data = await resp.json();
      return (data.data || []).some(m => m.id === this.model);
    } catch {
      return false;
    }
  }

  async getAvailableModels() {
    try {
      const resp = await fetch(`${this.lmstudioUrl}/v1/models`, {
        signal: AbortSignal.timeout(5000)
      });
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data.data || []).map(m => m.id);
    } catch {
      return [];
    }
  }

  async prepareImage(filePath, maxWidth = 512) {
    const stat = fs.statSync(filePath);
    let buffer = fs.readFileSync(filePath);
    const meta = await sharp(buffer).metadata();

    if (meta.width > maxWidth || meta.height > maxWidth) {
      buffer = await sharp(buffer)
        .resize(maxWidth, maxWidth, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 60 })
        .toBuffer();
    } else if (!filePath.toLowerCase().endsWith('.jpg') && !filePath.toLowerCase().endsWith('.jpeg')) {
      buffer = await sharp(buffer).jpeg({ quality: 60 }).toBuffer();
    }

    return {
      base64: buffer.toString('base64'),
      originalSize: stat.size,
      processedSize: buffer.length,
      width: meta.width,
      height: meta.height
    };
  }

  async classifyImage(filePath, mode = 'fast') {
    const prompt = mode === 'detail' ? DETAIL_PROMPT : FAST_PROMPT;
    const maxWidth = mode === 'detail' ? 768 : 512;
    const maxTokens = mode === 'detail' ? 1536 : 768;
    let lastError = null;

    for (let attempt = 0; attempt <= this.retryAttempts; attempt++) {
      try {
        const imageInfo = await this.prepareImage(filePath, maxWidth);

        const payload = {
          model: this.model,
          messages: [{
            role: 'user',
            content: prompt,
            images: [imageInfo.base64]
          }],
          temperature: 0.1,
          max_tokens: maxTokens
        };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        const resp = await fetch(`${this.lmstudioUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
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

        return {
          success: true,
          classification,
          model: this.model,
          mode,
          imageInfo: {
            width: imageInfo.width,
            height: imageInfo.height,
            originalSize: imageInfo.originalSize,
            processedSize: imageInfo.processedSize
          },
          rawResponse: content,
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

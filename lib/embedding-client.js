import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const DEFAULT_IMAGE_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.heic', '.avif', '.tif', '.tiff'
]);

/**
 * Client for EmbeddingGemma 2 via llama-server (DigUp-style multimodal embeddings).
 * Expects llama-server started with --embeddings and --mmproj for vision.
 */
export class EmbeddingClient {
  constructor(config = {}) {
    this.baseUrl = (config.baseUrl || process.env.EMBEDDING_URL || 'http://127.0.0.1:12333').replace(/\/$/, '');
    this.model = config.model || process.env.EMBEDDING_MODEL || 'embeddinggemma-2';
    this.timeout = parseInt(config.timeout || process.env.EMBEDDING_TIMEOUT || '120000', 10);
    this.maxImageWidth = parseInt(config.maxImageWidth || process.env.EMBEDDING_MAX_IMAGE || '768', 10);
    this.dims = parseInt(config.dims || process.env.EMBEDDING_DIMS || '768', 10);
  }

  async checkConnection() {
    try {
      const resp = await fetch(`${this.baseUrl}/v1/models`, {
        signal: AbortSignal.timeout(5000)
      });
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
      const data = await resp.json();
      const models = (data.data || []).map(m => m.id);
      return {
        ok: true,
        models,
        modelConfigured: this.model,
        baseUrl: this.baseUrl
      };
    } catch (err) {
      return { ok: false, error: err.message, baseUrl: this.baseUrl };
    }
  }

  async prepareImageBase64(filePath, maxWidth = this.maxImageWidth) {
    let buffer = fs.readFileSync(filePath);
    const meta = await sharp(buffer).metadata();
    if ((meta.width || 0) > maxWidth || (meta.height || 0) > maxWidth) {
      buffer = await sharp(buffer)
        .resize(maxWidth, maxWidth, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
    } else if (!/\.jpe?g$/i.test(filePath)) {
      buffer = await sharp(buffer).jpeg({ quality: 85 }).toBuffer();
    }
    return {
      base64: buffer.toString('base64'),
      mime: 'image/jpeg',
      width: meta.width,
      height: meta.height
    };
  }

  /**
   * Embed an image file. Uses nested content parts required by EmbeddingGemma 2 on llama-server.
   * @returns {{ embedding: number[], dims: number, model: string }}
   */
  async embedImage(filePath) {
    const img = await this.prepareImageBase64(filePath);
    const payload = {
      model: this.model,
      input: [{
        content: [{
          type: 'image_url',
          image_url: { url: `data:${img.mime};base64,${img.base64}` }
        }]
      }]
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    let resp;
    try {
      resp = await fetch(`${this.baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        throw Object.assign(new Error('Embedding server timeout'), { statusCode: 503 });
      }
      throw Object.assign(
        new Error(`Embedding server unreachable at ${this.baseUrl}: ${err.message}`),
        { statusCode: 503 }
      );
    }
    clearTimeout(timeoutId);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      const statusCode = resp.status === 404 || resp.status >= 500 ? 503 : resp.status;
      throw Object.assign(
        new Error(`Embedding HTTP ${resp.status}: ${errText.slice(0, 300)}`),
        { statusCode }
      );
    }

    const data = await resp.json();
    const embedding = data.data?.[0]?.embedding || data.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new Error('Embedding response missing vector');
    }
    return {
      embedding,
      dims: embedding.length,
      model: this.model,
      image: { width: img.width, height: img.height }
    };
  }

  /**
   * Embed plain text (for future semantic search queries).
   */
  async embedText(text) {
    const payload = {
      model: this.model,
      input: String(text || '')
    };
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    let resp;
    try {
      resp = await fetch(`${this.baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (err) {
      clearTimeout(timeoutId);
      throw Object.assign(
        new Error(`Embedding server unreachable at ${this.baseUrl}: ${err.message}`),
        { statusCode: 503 }
      );
    }
    clearTimeout(timeoutId);
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw Object.assign(
        new Error(`Embedding HTTP ${resp.status}: ${errText.slice(0, 300)}`),
        { statusCode: resp.status >= 500 ? 503 : resp.status }
      );
    }
    const data = await resp.json();
    const embedding = data.data?.[0]?.embedding || data.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new Error('Embedding response missing vector');
    }
    return { embedding, dims: embedding.length, model: this.model };
  }

  static isImagePath(filePath) {
    const ext = path.extname(filePath || '').toLowerCase();
    return DEFAULT_IMAGE_EXTS.has(ext);
  }

  static imageExtensions() {
    return [...DEFAULT_IMAGE_EXTS];
  }

  static toBuffer(embedding) {
    return Buffer.from(new Float32Array(embedding).buffer);
  }

  static fromBuffer(buf) {
    if (!buf) return null;
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    return Array.from(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)));
  }
}

export default EmbeddingClient;

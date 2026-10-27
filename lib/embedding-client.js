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
// ---------------------------------------------------------------------------
// Lazy start / idle stop for the local llama-server (EmbeddingGemma 2).
// Env:
//   EMBEDDING_AUTO_START=1 (default on; set 0 to disable)
//   EMBEDDING_SERVER_EXE   (default C:\AI_Server\Coding\LLM\llama-b11849-win-vulkan-x64\llama-server.exe)
//   EMBEDDING_MODEL_DIR    (default C:\AI_Server\Coding\LLM\embeddinggemma-2)
//   EMBEDDING_SERVER_ARGS  (extra args, optional)
//   EMBEDDING_IDLE_UNLOAD_SECONDS=300 (stop server we started after idle; 0 = never)
// Only a process started by THIS Node process is ever stopped.
// ---------------------------------------------------------------------------
const serverState = { child: null, starting: null, lastUsed: 0, idleTimer: null, startedAt: null, lastError: null };

function serverSettings() {
  const baseUrl = (process.env.EMBEDDING_URL || 'http://127.0.0.1:12333').replace(/\/$/, '');
  const port = (() => { try { return new URL(baseUrl).port || '12333'; } catch { return '12333'; } })();
  const modelDir = process.env.EMBEDDING_MODEL_DIR || 'C:\\AI_Server\\Coding\\LLM\\embeddinggemma-2';
  return {
    baseUrl, port, modelDir,
    exe: process.env.EMBEDDING_SERVER_EXE || 'C:\\AI_Server\\Coding\\LLM\\llama-b11849-win-vulkan-x64\\llama-server.exe',
    autoStart: process.env.EMBEDDING_AUTO_START !== '0',
    idleSec: parseInt(process.env.EMBEDDING_IDLE_UNLOAD_SECONDS ?? '300', 10),
    extra: (process.env.EMBEDDING_SERVER_ARGS || '').split(/\s+/).filter(Boolean)
  };
}

async function pingServer(baseUrl) {
  try {
    const r = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

function armIdleTimer() {
  const s = serverSettings();
  serverState.lastUsed = Date.now();
  if (!serverState.child || !(s.idleSec > 0)) return;
  if (serverState.idleTimer) clearTimeout(serverState.idleTimer);
  serverState.idleTimer = setTimeout(() => {
    if (Date.now() - serverState.lastUsed >= s.idleSec * 1000 - 50) {
      console.log(`[embedding] idle ${s.idleSec}s — stopping llama-server we started`);
      stopEmbeddingServer();
    } else armIdleTimer();
  }, s.idleSec * 1000);
  serverState.idleTimer.unref?.();
}

/** Ensure llama-server is reachable; start it if not (and allowed). */
export async function ensureEmbeddingServer({ timeoutMs = 120000, log = console.log } = {}) {
  const s = serverSettings();
  if (await pingServer(s.baseUrl)) { armIdleTimer(); return { ok: true, started: false, owned: !!serverState.child }; }
  if (!s.autoStart) return { ok: false, started: false, error: 'server down and EMBEDDING_AUTO_START=0' };
  if (serverState.starting) return serverState.starting;
  serverState.starting = (async () => {
    const { spawn } = await import('child_process');
    const args = ['-m', path.join(s.modelDir, 'embeddinggemma-2-Q8_0.gguf'),
      '--mmproj', path.join(s.modelDir, 'mmproj-embeddinggemma-2-Q8_0.gguf'),
      '--embeddings', '--host', '127.0.0.1', '--port', s.port, ...s.extra];
    if (!fs.existsSync(s.exe)) throw new Error(`llama-server not found: ${s.exe}`);
    const out = fs.openSync(path.join(s.modelDir, `server-${s.port}.out.log`), 'a');
    const err = fs.openSync(path.join(s.modelDir, `server-${s.port}.err.log`), 'a');
    log(`[embedding] starting: "${s.exe}" ${args.join(' ')}`);
    const child = spawn(s.exe, args, { cwd: s.modelDir, stdio: ['ignore', out, err], windowsHide: true });
    serverState.child = child; serverState.startedAt = new Date().toISOString();
    child.on('exit', (code) => { if (serverState.child === child) serverState.child = null; log(`[embedding] llama-server exited code=${code}`); });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!serverState.child) throw new Error('llama-server exited during startup (see server-*.err.log)');
      if (await pingServer(s.baseUrl)) { armIdleTimer(); log(`[embedding] ready after ${Math.round((Date.now() - (deadline - timeoutMs)) / 1000)}s`); return { ok: true, started: true, owned: true, pid: child.pid }; }
      await new Promise(r => setTimeout(r, 2000));
    }
    stopEmbeddingServer();
    throw new Error(`llama-server not healthy within ${timeoutMs / 1000}s`);
  })();
  try { return await serverState.starting; }
  catch (e) { serverState.lastError = e.message; return { ok: false, started: false, error: e.message }; }
  finally { serverState.starting = null; }
}

/** Stop llama-server only if this process started it. */
export function stopEmbeddingServer() {
  if (serverState.idleTimer) { clearTimeout(serverState.idleTimer); serverState.idleTimer = null; }
  const c = serverState.child;
  if (!c) return false;
  serverState.child = null;
  try { c.kill(); } catch {}
  return true;
}

export function getEmbeddingServerStatus() {
  const s = serverSettings();
  return { owned: !!serverState.child, pid: serverState.child?.pid || null, startedAt: serverState.startedAt,
    lastUsed: serverState.lastUsed ? new Date(serverState.lastUsed).toISOString() : null,
    idleUnloadSeconds: s.idleSec, autoStart: s.autoStart, exe: s.exe, lastError: serverState.lastError };
}

export class EmbeddingClient {
  constructor(config = {}) {
    this.baseUrl = (config.baseUrl || process.env.EMBEDDING_URL || 'http://127.0.0.1:12333').replace(/\/$/, '');
    this.model = config.model || process.env.EMBEDDING_MODEL || 'embeddinggemma-2';
    this.timeout = parseInt(config.timeout || process.env.EMBEDDING_TIMEOUT || '120000', 10);
    this.maxImageWidth = parseInt(config.maxImageWidth || process.env.EMBEDDING_MAX_IMAGE || '768', 10);
    this.dims = parseInt(config.dims || process.env.EMBEDDING_DIMS || '768', 10);
  }

  async _ensureServer() {
    if (process.env.EMBEDDING_AUTO_START === '0') return;
    const r = await ensureEmbeddingServer();
    if (!r.ok) throw Object.assign(new Error(`Embedding server unavailable: ${r.error}`), { statusCode: 503 });
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
    await this._ensureServer();
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
    await this._ensureServer();
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

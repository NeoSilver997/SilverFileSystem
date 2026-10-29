/**
 * Make JPEG thumbnail from an image path.
 * Sniffs magic bytes so misnamed files still work:
 *   - .HEIC that is actually JPEG → sharp
 *   - .JPG that is actually HEIC → heic-convert then sharp
 * Never moves/deletes user files; read-only.
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import heicConvert from 'heic-convert';

const DEFAULT_MAX = 400;

function sniffKind(buf) {
  if (!buf || buf.length < 12) return 'unknown';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buf.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.slice(8, 12).toString('ascii').toLowerCase();
    const heic = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'];
    if (heic.includes(brand) || brand === 'avif') return brand === 'avif' ? 'avif' : 'heic';
    return 'isobmff';
  }
  return 'unknown';
}

/**
 * @param {string} filePath
 * @param {{ max?: number, quality?: number }} [opts]
 * @returns {Promise<Buffer>}
 */
export async function makeThumb(filePath, opts = {}) {
  const max = opts.max || DEFAULT_MAX;
  const quality = opts.quality ?? 75;
  const buf = fs.readFileSync(filePath);
  const kind = sniffKind(buf);
  const ext = path.extname(filePath).toLowerCase();

  let input;
  const wantHeic = kind === 'heic' || kind === 'avif' ||
    ((ext === '.heic' || ext === '.heif' || ext === '.avif') && kind !== 'jpeg' && kind !== 'png' && kind !== 'webp' && kind !== 'gif');

  if (wantHeic || kind === 'heic' || kind === 'avif') {
    // Real HEIC/AVIF (or unknown with heic-like extension): convert first
    try {
      input = Buffer.from(await heicConvert({ buffer: buf, format: 'JPEG', quality: 0.9 }));
    } catch (e) {
      // Fall back to sharp in case sniff said heic but sharp can still read
      if (kind === 'jpeg' || kind === 'png' || kind === 'webp' || kind === 'gif') {
        input = buf;
      } else {
        throw e;
      }
    }
  } else {
    input = buf;
  }

  return sharp(input, { failOn: 'none' }).rotate()
    .resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality }).toBuffer();
}

export { sniffKind };

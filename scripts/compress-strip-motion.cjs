/**
 * Compress JPEG (lossy q85) and strip Xiaomi/Google Motion Photo video trailers.
 *
 * Usage:
 *   node scripts/compress-strip-motion.cjs --dir "H:\...\2026\10" --dry-run
 *   node scripts/compress-strip-motion.cjs --dir "H:\...\2026\10" --apply
 *
 * Safety: on --apply, copies each original to <dir>/_bak_before_compress/ before overwrite.
 * Tools: sharp (recompress), optional exiftool-vendored (copy dates, strip motion XMP).
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { spawnSync } = require('child_process');

function parseArgs(argv) {
  const out = { dir: null, dryRun: true, apply: false, quality: 85, limit: 0, skipExistingBak: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') { out.dryRun = true; out.apply = false; }
    else if (a === '--apply') { out.apply = true; out.dryRun = false; }
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--quality') out.quality = Number(argv[++i]);
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--help') out.help = true;
  }
  return out;
}

function findExiftool() {
  const candidates = [
    path.join(__dirname, '..', 'node_modules', 'exiftool-vendored.exe', 'bin', 'exiftool.exe'),
    path.join(__dirname, '..', 'node_modules', 'exiftool-vendored.pl', 'bin', 'exiftool'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

/** Parse Google Container MotionPhoto video length from XMP head. */
function parseMotionVideoLength(headLatin1) {
  // Match Container Item blocks; find Semantic=MotionPhoto with Mime=video/mp4
  const re = /<Container:Item\b([^>]*?)\/>/gis;
  let m;
  while ((m = re.exec(headLatin1))) {
    const attrs = m[1];
    if (/Item:Semantic\s*=\s*"MotionPhoto"/i.test(attrs) && /Item:Mime\s*=\s*"video\/mp4"/i.test(attrs)) {
      const len = attrs.match(/Item:Length\s*=\s*"(\d+)"/i);
      const pad = attrs.match(/Item:Padding\s*=\s*"(\d+)"/i);
      if (len) return { length: Number(len[1]), padding: pad ? Number(pad[1]) : 0, method: 'container-xmp' };
    }
  }
  // Fallback MicroVideoOffset = bytes from end
  const mv = headLatin1.match(/GCamera:MicroVideoOffset\s*=\s*"(\d+)"/i)
    || headLatin1.match(/MicroVideoOffset["'\s:=]+(\d+)/i);
  if (mv) return { length: Number(mv[1]), padding: 0, method: 'microvideo-offset' };
  return null;
}

function stripMotionVideo(buf) {
  const headLen = Math.min(buf.length, 1024 * 1024);
  const head = buf.subarray(0, headLen).toString('latin1');
  const hasMotionMeta = /GCamera:MotionPhoto\s*=\s*"1"/i.test(head) || /MotionPhoto/i.test(head);
  const parsed = parseMotionVideoLength(head);
  if (parsed && parsed.length > 0 && parsed.length + parsed.padding < buf.length - 1024) {
    const cut = buf.length - parsed.length - parsed.padding;
    // Ensure we cut at/after an EOI
    let eoi = -1;
    for (let i = cut - 1; i >= Math.max(0, cut - 1024 * 1024); i--) {
      if (buf[i] === 0xFF && buf[i + 1] === 0xD9) { eoi = i; break; }
    }
    if (eoi >= 0) {
      return {
        jpeg: buf.subarray(0, eoi + 2),
        trailer: buf.length - (eoi + 2),
        method: parsed.method,
        hadMotionMeta: hasMotionMeta,
      };
    }
    return {
      jpeg: buf.subarray(0, cut),
      trailer: buf.length - cut,
      method: parsed.method + '-rawcut',
      hadMotionMeta: hasMotionMeta,
    };
  }
  // Fallback: first EOI that is followed by ftyp within 64KB (keeps primary+gainmap, drops mp4)
  const ftyp = Buffer.from('ftyp');
  let searchFrom = 0;
  while (true) {
    const eoi = buf.indexOf(Buffer.from([0xFF, 0xD9]), searchFrom);
    if (eoi < 0) break;
    // Skip tiny EXIF thumbnail EOIs: require remaining payload large enough to be video
    const remaining = buf.length - (eoi + 2);
    if (remaining > 100 * 1024) {
      const after = buf.subarray(eoi + 2, Math.min(buf.length, eoi + 2 + 65536));
      if (after.includes(ftyp)) {
        return {
          jpeg: buf.subarray(0, eoi + 2),
          trailer: remaining,
          method: 'eoi+ftyp',
          hadMotionMeta: hasMotionMeta,
        };
      }
    }
    searchFrom = eoi + 2;
  }
  return { jpeg: buf, trailer: 0, method: 'none', hadMotionMeta: hasMotionMeta };
}

async function recompress(jpegBuf, quality) {
  return sharp(jpegBuf, { failOn: 'none', unlimited: true })
    .rotate()
    .jpeg({ quality, mozjpeg: true, chromaSubsampling: '4:2:0' })
    .toBuffer();
}

function copyMetadataWithExiftool(exiftool, srcBak, destFile) {
  // Copy useful tags from bak, then strip motion-photo related XMP
  const args = [
    '-overwrite_original',
    '-TagsFromFile', srcBak,
    '-All:All',
    '-XMP-GCamera:all=',
    '-XMP-Container:all=',
    '-XMP-Item:all=',
    '-Trailer:all=',
    destFile,
  ];
  const r = spawnSync(exiftool, args, { encoding: 'utf8' });
  return { ok: r.status === 0, stderr: (r.stderr || '').slice(0, 500), stdout: (r.stdout || '').slice(0, 300) };
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help || !opts.dir) {
    console.log(`Usage: node scripts/compress-strip-motion.cjs --dir <folder> [--dry-run|--apply] [--quality 85] [--limit N]`);
    process.exit(opts.help ? 0 : 1);
  }
  const dir = path.resolve(opts.dir);
  if (!fs.existsSync(dir)) {
    console.error('DIR_NOT_FOUND', dir);
    process.exit(1);
  }
  const bakDir = path.join(dir, '_bak_before_compress');
  const reportPath = path.join(dir, `_compress_report_${new Date().toISOString().slice(0,10)}.json`);
  const exiftool = findExiftool();
  const files = fs.readdirSync(dir)
    .filter((f) => /\.jpe?g$/i.test(f) && fs.statSync(path.join(dir, f)).isFile())
    .sort();
  const list = opts.limit > 0 ? files.slice(0, opts.limit) : files;

  console.log(JSON.stringify({
    mode: opts.apply ? 'apply' : 'dry-run',
    dir,
    bakDir,
    quality: opts.quality,
    jpegCount: list.length,
    exiftool: exiftool || null,
  }, null, 2));

  if (opts.apply && !fs.existsSync(bakDir)) fs.mkdirSync(bakDir, { recursive: true });

  const rows = [];
  let beforeTotal = 0, afterTotal = 0, trailerTotal = 0, stripped = 0, wrote = 0, skipped = 0, failed = 0;

  for (let i = 0; i < list.length; i++) {
    const name = list[i];
    const src = path.join(dir, name);
    try {
      const st = fs.statSync(src);
      const buf = fs.readFileSync(src);
      const { jpeg, trailer, method, hadMotionMeta } = stripMotionVideo(buf);
      const out = await recompress(jpeg, opts.quality);
      // Safety: never write if output somehow larger than 98% of input AND no strip (optional allow if still smaller)
      const saved = st.size - out.length;
      const row = {
        name,
        before: st.size,
        after: out.length,
        trailer,
        method,
        hadMotionMeta: !!hadMotionMeta,
        saved,
        savePct: +((1 - out.length / st.size) * 100).toFixed(1),
      };

      if (opts.apply) {
        if (out.length < 10 * 1024) {
          row.status = 'skip-too-small-output';
          skipped++;
        } else if (out.length >= st.size && trailer === 0) {
          row.status = 'skip-no-gain';
          skipped++;
        } else {
          const bakPath = path.join(bakDir, name);
          if (!fs.existsSync(bakPath)) fs.copyFileSync(src, bakPath);
          const tmp = src + '.compress_tmp.jpg';
          fs.writeFileSync(tmp, out);
          if (exiftool) {
            const meta = copyMetadataWithExiftool(exiftool, bakPath, tmp);
            row.exiftool = meta.ok ? 'ok' : meta.stderr;
          }
          // Verify tmp is valid jpeg
          const probe = await sharp(tmp, { failOn: 'none' }).metadata();
          if (!probe || !probe.width) {
            fs.unlinkSync(tmp);
            row.status = 'fail-invalid-output';
            failed++;
          } else {
            fs.copyFileSync(tmp, src);
          try { fs.unlinkSync(tmp); } catch (_) {}
            row.status = 'wrote';
            row.width = probe.width;
            row.height = probe.height;
            wrote++;
          }
        }
      } else {
        row.status = 'dry-run';
      }

      beforeTotal += st.size;
      afterTotal += out.length;
      trailerTotal += trailer;
      if (trailer > 0) stripped++;
      rows.push(row);
      if ((i + 1) % 25 === 0 || i === list.length - 1) {
        console.error(`progress ${i + 1}/${list.length} stripped=${stripped} wrote=${wrote}`);
      }
    } catch (e) {
      failed++;
      rows.push({ name, status: 'error', error: String(e && e.message ? e.message : e) });
      console.error('ERR', name, e.message || e);
    }
  }

  const summary = {
    mode: opts.apply ? 'apply' : 'dry-run',
    dir,
    bakDir: opts.apply ? bakDir : null,
    quality: opts.quality,
    count: list.length,
    motionStripped: stripped,
    wrote,
    skipped,
    failed,
    beforeBytes: beforeTotal,
    afterBytes: afterTotal,
    beforeGB: +(beforeTotal / 1e9).toFixed(3),
    afterGB: +(afterTotal / 1e9).toFixed(3),
    trailerBytesRemovedEst: trailerTotal,
    trailerGB: +(trailerTotal / 1e9).toFixed(3),
    savedBytes: beforeTotal - afterTotal,
    savedGB: +((beforeTotal - afterTotal) / 1e9).toFixed(3),
    savePct: beforeTotal ? +((1 - afterTotal / beforeTotal) * 100).toFixed(1) : 0,
    exiftool: exiftool || null,
    sample: rows.slice(0, 15),
  };
  fs.writeFileSync(reportPath, JSON.stringify({ summary, rows }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log('REPORT', reportPath);
}

main().catch((e) => { console.error(e); process.exit(1); });

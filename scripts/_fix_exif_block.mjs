import fs from 'fs';
let s = fs.readFileSync('lib/daily-pipeline-job.js', 'utf8');
const startMark = 'Object.assign(summary.exif, await extractPhotoMetaForFiles';
const endMark = 'void done;';
const start = s.indexOf(startMark);
const end = s.indexOf(endMark, start);
if (start < 0 || end < 0) {
  console.error('markers', start, end);
  // show nearby
  const i = s.indexOf('stages.includes(\'exif\')');
  console.log(s.slice(i, i + 1200));
  process.exit(1);
}
const neu = `Object.assign(summary.exif, await extractPhotoMetaForFiles(db, needMeta, {
          concurrency: 8,
          onFail: (st, f, e) => fail('exif-' + st, f, e)
        }));
        updateJob(jobId, {
          done: needMeta.length,
          total: needMeta.length,
          message: 'EXIF done ' + JSON.stringify({
            need: summary.exif.need,
            exif: summary.exif.exif,
            created: summary.exif.created,
            fail: summary.exif.fail
          })
        });`;
s = s.slice(0, start) + neu + s.slice(end + endMark.length);
s = s.replace('        let done = 0;\n        Object.assign(summary.exif', '        Object.assign(summary.exif');
fs.writeFileSync('lib/daily-pipeline-job.js', s);
console.log('ok', start, end);

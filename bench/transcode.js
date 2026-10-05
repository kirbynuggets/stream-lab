// How fast does the packaging pipeline go on this machine?
// Compares software x264 against Apple's hardware encoder, and parallel
// renditions against one-at-a-time.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeSample, package_ } from '../src/transcode.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-bench-'));
const SECONDS = Number(process.env.BENCH_SECONDS || 60);
const src = path.join(tmp, 'src.mp4');
process.stdout.write(`\nMaking a ${SECONDS}s 1080p test clip… `);
await makeSample(src, { seconds: SECONDS, width: 1920, height: 1080 });
console.log(`${(fs.statSync(src).size / 1048576).toFixed(1)} MB`);

const runs = [
  ['decode once, encode many (x264)', { mode: 'single', hwaccel: false }],
  ['one process per rendition, parallel', { mode: 'parallel', hwaccel: false, concurrency: 5 }],
  ['one process per rendition, serial', { mode: 'parallel', hwaccel: false, concurrency: 1 }],
  ['decode once, encode many (videotoolbox)', { mode: 'single', hwaccel: true }],
];
console.log(`\nTranscode benchmark · ${os.cpus()[0].model} · ${os.cpus().length} cores · source ${SECONDS}s 1080p`);
console.log('  pipeline                                 wall     × realtime   output');
const results = [];
for (const [label, opts] of runs) {
  const out = path.join(tmp, label.replace(/\W+/g, '-'));
  const m = await package_(src, out, opts);
  results.push({ label, ...m });
  console.log(`  ${label.padEnd(40)} ${(m.wallSeconds.toFixed(1) + 's').padStart(6)}   ${(m.speedVsRealtime + '×').padStart(10)}   ${(m.totalBytes / 1048576).toFixed(1)} MB`);
}
const base = results[0];
console.log('\n  Per rendition (decode once, x264):');
console.log('    rung      resolution    target    actual    segments   size');
for (const r of base.renditions) {
  console.log(`    ${r.name.padEnd(9)} ${`${r.width}×${r.height}`.padEnd(13)} ${(r.vkbps + 'k').padEnd(9)} ${(r.actualKbps + 'k').padEnd(9)} ${String(r.segments).padEnd(10)} ${(r.bytes / 1048576).toFixed(1)} MB`);
}
const [, par, serial, hw] = results;
console.log(`\n  Decode once vs one process per rendition (parallel): ${(par.wallSeconds / base.wallSeconds).toFixed(2)}× faster`);
console.log(`  Decode once vs serial:                               ${(serial.wallSeconds / base.wallSeconds).toFixed(2)}× faster`);
console.log(`  Hardware vs software (both decode once):             ${(base.wallSeconds / hw.wallSeconds).toFixed(2)}× faster, ${(hw.totalBytes / base.totalBytes).toFixed(2)}× the bytes\n`);
fs.rmSync(tmp, { recursive: true, force: true });

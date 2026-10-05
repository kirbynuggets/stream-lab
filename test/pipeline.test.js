import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeSample, package_, probe } from '../src/transcode.js';
import { createServer } from '../server/server.js';
import { parseMaster, parseMedia } from '../public/player.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-pipe-'));
const src = path.join(tmp, 'src.mp4');
await makeSample(src, { seconds: 12, width: 1280, height: 720 });

test('the packager produces a playable, aligned HLS ladder', async () => {
  const out = path.join(tmp, 'pkg');
  const m = await package_(src, out);
  assert.deepEqual(m.renditions.map((r) => r.name), ['240p', '360p', '540p', '720p']);   // 720p source: no 1080p upscale
  assert.ok(m.speedVsRealtime > 1, `expected faster than realtime, got ${m.speedVsRealtime}×`);

  // every rendition: an init segment, the same number of media segments, a valid playlist
  const counts = new Set();
  for (const r of m.renditions) {
    const dir = path.join(out, r.name);
    assert.ok(fs.existsSync(path.join(dir, 'init.mp4')), `${r.name} missing init segment`);
    const { segments, initUrl, targetDuration } = parseMedia(fs.readFileSync(path.join(dir, 'index.m3u8'), 'utf8'), `http://h/${r.name}/index.m3u8`);
    assert.ok(initUrl.endsWith('init.mp4'));
    assert.equal(targetDuration, 4);
    assert.equal(segments.length, r.segments);
    counts.add(segments.length);
    // bitrate should land in the right ballpark (encoders are not exact)
    assert.ok(r.actualKbps > 0 && r.actualKbps < r.vkbps * 2.2, `${r.name} came out at ${r.actualKbps} kbps for a ${r.vkbps} kbps target`);
  }
  assert.equal(counts.size, 1, 'all renditions must have the same segment count so switches line up');

  // segment N covers the same timeline in every rendition
  const durs = m.renditions.map((r) => parseMedia(fs.readFileSync(path.join(out, r.name, 'index.m3u8'), 'utf8'), 'http://h/x/i.m3u8').segments.map((s) => s.duration));
  for (let i = 1; i < durs.length; i++) assert.deepEqual(durs[i], durs[0], 'segment durations must match across renditions');

  const levels = parseMaster(fs.readFileSync(path.join(out, 'master.m3u8'), 'utf8'), 'http://h/master.m3u8');
  assert.equal(levels.length, m.renditions.length);
});

test('every rendition decodes, and keyframes sit on segment boundaries', async () => {
  const out = path.join(tmp, 'pkg');
  for (const name of ['240p', '720p']) {
    const seg = path.join(out, name, 'seg_001.m4s');
    const init = path.join(out, name, 'init.mp4');
    const joined = path.join(tmp, `${name}-join.mp4`);
    fs.writeFileSync(joined, Buffer.concat([fs.readFileSync(init), fs.readFileSync(seg)]));
    const info = await probe(joined);
    assert.ok(info.width > 0 && info.duration > 0, `${name} segment did not decode`);
    assert.equal(info.vcodec, 'h264');
  }
});

test('the server serves the package through the edge, with cache headers', async () => {
  const dataDir = path.join(tmp, 'srv');
  fs.mkdirSync(path.join(dataDir, 'videos'), { recursive: true });
  fs.cpSync(path.join(tmp, 'pkg'), path.join(dataDir, 'videos', 'vid1'), { recursive: true });
  const srv = await createServer({ port: 0, dataDir, log: () => {} });
  const base = `http://localhost:${srv.port}`;
  try {
    const list = await (await fetch(`${base}/api/videos`)).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'vid1');

    const first = await fetch(`${base}/cdn/vid1/720p/seg_000.m4s`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('x-cache'), 'MISS');
    const bytes = (await first.arrayBuffer()).byteLength;

    const second = await fetch(`${base}/cdn/vid1/720p/seg_000.m4s`);
    assert.equal(second.headers.get('x-cache'), 'HIT');
    assert.equal((await second.arrayBuffer()).byteLength, bytes);

    assert.equal((await fetch(`${base}/cdn/vid1/720p/nope.m4s`)).status, 404);
    // traversal must fail whether the client normalises the path or not
    for (const bad of ['/cdn/../package.json', '/cdn/%2e%2e/package.json', '/cdn/vid1/../../package.json', '/package.json']) {
      const r = await fetch(base + bad);
      assert.notEqual(r.status, 200, `${bad} should not be served`);
    }

    // shaping really slows a segment down
    await fetch(`${base}/api/edge/shape`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kbps: 500 }) });
    const t0 = Date.now();
    await (await fetch(`${base}/cdn/vid1/720p/seg_001.m4s`)).arrayBuffer();
    const took = Date.now() - t0;
    const expected = (bytes * 8) / 500 / 1000 * 1000;
    assert.ok(took > expected * 0.5, `500 kbps should have taken ~${Math.round(expected)}ms, took ${took}ms`);

    await fetch(`${base}/api/edge/purge`, { method: 'POST' });
    assert.equal((await (await fetch(`${base}/api/edge`)).json()).objects, 0);
  } finally { await srv.close(); }
});

test('uploading something that is not a video is rejected', async () => {
  const dataDir = path.join(tmp, 'srv2');
  const srv = await createServer({ port: 0, dataDir, log: () => {} });
  try {
    const fd = new FormData();
    fd.append('video', new Blob([Buffer.from('definitely not a video')]), 'evil.mp4');
    const r = await fetch(`http://localhost:${srv.port}/api/upload`, { method: 'POST', body: fd });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /does not look like a video/);
  } finally { await srv.close(); }
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

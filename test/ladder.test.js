import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LADDER, ladderFor, scaleTo, codecString, totalKbps, SEGMENT_SECONDS, GOP_SECONDS } from '../src/ladder.js';
import { parseMaster, parseMedia } from '../public/player.js';
import { writeMaster } from '../src/transcode.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('the ladder never upscales a small source', () => {
  assert.deepEqual(ladderFor(1080).map((r) => r.name), ['240p', '360p', '540p', '720p', '1080p']);
  assert.deepEqual(ladderFor(720).map((r) => r.name), ['240p', '360p', '540p', '720p']);
  assert.deepEqual(ladderFor(360).map((r) => r.name), ['240p', '360p']);
  assert.deepEqual(ladderFor(144).map((r) => r.name), ['240p']);   // always offer something
});

test('ladder rungs rise in both resolution and bitrate', () => {
  for (let i = 1; i < LADDER.length; i++) {
    assert.ok(LADDER[i].height > LADDER[i - 1].height, 'height must increase');
    assert.ok(totalKbps(LADDER[i]) > totalKbps(LADDER[i - 1]), 'bitrate must increase');
  }
});

test('scaling keeps the aspect ratio, stays even, and prefers macroblock-aligned widths', () => {
  for (const [w, h, target] of [[1920, 1080, 540], [1280, 720, 360], [1080, 1920, 360], [1999, 1081, 240], [1920, 1080, 240]]) {
    const s = scaleTo(w, h, target);
    assert.equal(s.width % 2, 0, 'width must be even');
    assert.equal(s.height % 2, 0, 'height must be even');
    const err = Math.abs(s.width / s.height - w / h) / (w / h);
    assert.ok(err <= 0.03, `aspect drift ${(err * 100).toFixed(1)}% too high`);
  }
  // 16:9 sources should land on macroblock-aligned widths
  for (const target of [240, 360, 540, 720, 1080]) assert.equal(scaleTo(1920, 1080, target).width % 16, 0, `${target}p width should align to 16`);
});

test('segment duration and keyframe interval match, so switches land on boundaries', () => {
  assert.equal(SEGMENT_SECONDS, GOP_SECONDS);
});

test('codec strings follow RFC 6381', () => {
  assert.equal(codecString('high', '4.1'), 'avc1.640029,mp4a.40.2');
  assert.equal(codecString('main', '3.1'), 'avc1.4D001F,mp4a.40.2');
  assert.equal(codecString('baseline', '3.0'), 'avc1.42001E,mp4a.40.2');
});

test('master playlist round-trips through the parser, lowest rung first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-m-'));
  const rungs = ladderFor(1080).map((r) => ({ ...r, ...scaleTo(1920, 1080, r.height), actualKbps: totalKbps(r) - 10, segments: 5, bytes: 1000 }));
  writeMaster(dir, rungs);
  const text = fs.readFileSync(path.join(dir, 'master.m3u8'), 'utf8');
  const levels = parseMaster(text, 'http://host/cdn/v/master.m3u8');
  assert.equal(levels.length, rungs.length);
  assert.deepEqual(levels.map((l) => l.name), ['240p', '360p', '540p', '720p', '1080p']);
  assert.equal(levels[0].url, 'http://host/cdn/v/240p/index.m3u8');
  assert.equal(levels[4].height, 1080);
  assert.ok(levels[4].codecs.startsWith('avc1.'));
  for (let i = 1; i < levels.length; i++) assert.ok(levels[i].bandwidth > levels[i - 1].bandwidth);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('media playlist parsing finds the init segment and segment durations', () => {
  const text = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:4', '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:4.000000,', 'seg_000.m4s', '#EXTINF:3.500000,', 'seg_001.m4s', '#EXT-X-ENDLIST'].join('\n');
  const { segments, targetDuration, initUrl } = parseMedia(text, 'http://host/cdn/v/720p/index.m3u8');
  assert.equal(targetDuration, 4);
  assert.equal(initUrl, 'http://host/cdn/v/720p/init.mp4');
  assert.deepEqual(segments.map((s) => s.duration), [4, 3.5]);
  assert.equal(segments[1].url, 'http://host/cdn/v/720p/seg_001.m4s');
  assert.deepEqual(segments.map((s) => s.index), [0, 1]);
});

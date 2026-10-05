/**
 * The transcoding pipeline: one source file in, a full HLS ladder out.
 *
 * Design notes
 *  - Renditions encode in parallel (one ffmpeg per rendition, capped by CPU
 *    count). A single ffmpeg with multiple outputs decodes once, but then one
 *    slow rendition blocks the rest, and progress per rendition is invisible.
 *    Separate processes decode N times but finish sooner on a multi-core box
 *    and give per-rendition progress, which the demo needs.
 *  - Keyframes are forced every GOP_SECONDS and scene-cut insertion is off, so
 *    every rendition has aligned segment boundaries. Without that, switching
 *    quality mid-stream can stutter or glitch.
 *  - Bitrate is capped (maxrate + bufsize) rather than left to the CRF
 *    encoder, because ABR assumes each rendition respects its advertised
 *    bandwidth.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LADDER, SEGMENT_SECONDS, GOP_SECONDS, ladderFor, scaleTo, codecString, totalKbps } from './ladder.js';

export const FFMPEG = process.env.FFMPEG || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE || 'ffprobe';

/* ------------------------------------------------------------------ probe */

export async function probe(file) {
  const out = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const info = JSON.parse(out.stdout);
  const v = info.streams.find((s) => s.codec_type === 'video');
  const a = info.streams.find((s) => s.codec_type === 'audio');
  if (!v) throw new Error('no video stream found');
  return {
    width: v.width, height: v.height,
    duration: Number(info.format.duration) || 0,
    fps: ratio(v.r_frame_rate) || 30,
    vcodec: v.codec_name, acodec: a ? a.codec_name : null, hasAudio: !!a,
    bytes: Number(info.format.size) || fs.statSync(file).size,
  };
}
const ratio = (s) => { if (!s) return 0; const [n, d] = s.split('/').map(Number); return d ? n / d : n; };

/* ------------------------------------------------------- one rendition */

function args({ input, outDir, src, r, hwaccel }) {
  const { width, height } = scaleTo(src.width, src.height, r.height);
  const gop = Math.max(1, Math.round(GOP_SECONDS * src.fps));
  const vcodec = hwaccel ? 'h264_videotoolbox' : 'libx264';
  const a = [
    '-hide_banner', '-nostdin', '-y',
    '-i', input,
    '-map', '0:v:0',
    ...(src.hasAudio ? ['-map', '0:a:0'] : []),
    '-vf', `scale=${width}:${height}:flags=bicubic`,
    '-c:v', vcodec,
    '-b:v', `${r.vkbps}k`, '-maxrate', `${Math.round(r.vkbps * 1.1)}k`, '-bufsize', `${r.vkbps * 2}k`,
    '-profile:v', r.profile, '-level:v', r.level,
    '-g', String(gop), '-keyint_min', String(gop),
    '-force_key_frames', `expr:gte(t,n_forced*${GOP_SECONDS})`,
    '-sc_threshold', '0',                       // no extra keyframes at scene cuts: boundaries must line up
  ];
  if (!hwaccel) a.push('-preset', process.env.X264_PRESET || 'veryfast', '-x264-params', `scenecut=0:open_gop=0:min-keyint=${gop}:repeat-headers=1`);
  if (src.hasAudio) a.push('-c:a', 'aac', '-b:a', `${r.akbps}k`, '-ac', '2', '-ar', '48000');
  a.push(
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SECONDS),
    '-hls_playlist_type', 'vod',
    // fMP4 (CMAF) rather than MPEG-TS: browsers can feed these straight into
    // MediaSource, so the hand-written player works outside Safari too.
    '-hls_segment_type', 'fmp4',
    '-hls_flags', 'independent_segments',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', path.join(outDir, r.name, 'seg_%03d.m4s'),
    '-progress', 'pipe:1', '-nostats',
    path.join(outDir, r.name, 'index.m3u8'),
  );
  return a;
}

/* ------------------------------------- one ffmpeg, every rendition at once */

/**
 * Decode once, encode many. `split` fans the decoded frames out to one scaler
 * per rung, and each encoder writes its own HLS output from the same ffmpeg
 * process. This is how production ladders are built: decoding a 1080p source
 * five times is pure waste.
 */
function singlePassArgs({ input, outDir, src, rungs, hwaccel }) {
  const gop = Math.max(1, Math.round(GOP_SECONDS * src.fps));
  const vcodec = hwaccel ? 'h264_videotoolbox' : 'libx264';
  const a = ['-hide_banner', '-nostdin', '-y', '-i', input];

  const filters = [`[0:v]split=${rungs.length}${rungs.map((_, i) => `[v${i}in]`).join('')}`];
  rungs.forEach((r, i) => {
    const { width, height } = scaleTo(src.width, src.height, r.height);
    filters.push(`[v${i}in]scale=${width}:${height}:flags=bicubic[v${i}]`);
  });
  a.push('-filter_complex', filters.join(';'));

  rungs.forEach((r, i) => {
    a.push('-map', `[v${i}]`);
    if (src.hasAudio) a.push('-map', '0:a:0');
    a.push(
      `-c:v:0`, vcodec,
      '-b:v', `${r.vkbps}k`, '-maxrate', `${Math.round(r.vkbps * 1.1)}k`, '-bufsize', `${r.vkbps * 2}k`,
      '-profile:v', r.profile, '-level:v', r.level,
      '-g', String(gop), '-keyint_min', String(gop),
      '-force_key_frames', `expr:gte(t,n_forced*${GOP_SECONDS})`,
      '-sc_threshold', '0',
    );
    if (!hwaccel) a.push('-preset', process.env.X264_PRESET || 'veryfast', '-x264-params', `scenecut=0:open_gop=0:min-keyint=${gop}:repeat-headers=1`);
    if (src.hasAudio) a.push('-c:a', 'aac', '-b:a', `${r.akbps}k`, '-ac', '2', '-ar', '48000');
    a.push(
      '-f', 'hls', '-hls_time', String(SEGMENT_SECONDS), '-hls_playlist_type', 'vod',
      '-hls_segment_type', 'fmp4', '-hls_flags', 'independent_segments',
      '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', path.join(outDir, r.name, 'seg_%03d.m4s'),
      path.join(outDir, r.name, 'index.m3u8'),
    );
  });
  a.push('-progress', 'pipe:1', '-nostats');
  return a;
}

/* ------------------------------------------------- the whole package */

/**
 * Transcode `input` into `outDir` as a complete HLS package.
 * onProgress({ rendition, percent, fps, speed, done }) fires as work proceeds.
 */
export async function package_(input, outDir, { onProgress = () => {}, hwaccel = false, mode = 'single', concurrency = Math.max(1, Math.min(4, os.cpus().length - 1)) } = {}) {
  const src = await probe(input);
  const rungs = ladderFor(src.height);
  fs.mkdirSync(outDir, { recursive: true });
  for (const r of rungs) fs.mkdirSync(path.join(outDir, r.name), { recursive: true });

  const t0 = Date.now();
  const results = new Map();
  const measure = (r, startedMs) => {
    const dir = path.join(outDir, r.name);
    const segs = fs.readdirSync(dir).filter((f) => f.endsWith('.m4s'));
    const bytes = segs.reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
    const initBytes = fs.existsSync(path.join(dir, 'init.mp4')) ? fs.statSync(path.join(dir, 'init.mp4')).size : 0;
    results.set(r.name, { ...r, ...scaleTo(src.width, src.height, r.height), segments: segs.length, bytes: bytes + initBytes, seconds: (Date.now() - startedMs) / 1000, actualKbps: src.duration ? Math.round(((bytes + initBytes) * 8) / src.duration / 1000) : 0 });
  };

  if (mode === 'single') {
    // one process decodes the source once and feeds every encoder
    const started = Date.now();
    await runFfmpeg(singlePassArgs({ input, outDir, src, rungs, hwaccel }), (p) => {
      if (p.out_time_us && src.duration) {
        const pct = Math.min(100, (p.out_time_us / 1e6 / src.duration) * 100);
        for (const r of rungs) onProgress({ rendition: r.name, percent: pct, fps: Number(p.fps) || 0, speed: p.speed || '' });
      }
    });
    for (const r of rungs) { measure(r, started); onProgress({ rendition: r.name, percent: 100, done: true }); }
  } else {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, rungs.length) }, async () => {
    while (next < rungs.length) {
      const r = rungs[next++];
      const started = Date.now();
      await runFfmpeg(args({ input, outDir, src, r, hwaccel }), (p) => {
        if (p.out_time_us && src.duration) onProgress({ rendition: r.name, percent: Math.min(100, (p.out_time_us / 1e6 / src.duration) * 100), fps: Number(p.fps) || 0, speed: p.speed || '' });
      });
      measure(r, started);
      onProgress({ rendition: r.name, percent: 100, done: true });
    }
  });
  await Promise.all(workers);
  }

  const ordered = rungs.map((r) => results.get(r.name));
  const master = writeMaster(outDir, ordered);
  const manifest = {
    source: { file: path.basename(input), ...src },
    createdAt: new Date().toISOString(),
    segmentSeconds: SEGMENT_SECONDS,
    encoder: `${hwaccel ? 'h264_videotoolbox (hardware)' : `libx264 ${process.env.X264_PRESET || 'veryfast'}`} · ${mode === 'single' ? 'decode once, encode many' : 'one process per rendition'}`,
    wallSeconds: (Date.now() - t0) / 1000,
    speedVsRealtime: src.duration ? +(src.duration / ((Date.now() - t0) / 1000)).toFixed(2) : 0,
    renditions: ordered,
    master: path.basename(master),
    totalBytes: ordered.reduce((n, r) => n + r.bytes, 0),
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** The master playlist: the only file a player needs to discover the ladder. */
export function writeMaster(outDir, rungs) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:6', ''];
  for (const r of rungs) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${totalKbps(r) * 1000},AVERAGE-BANDWIDTH=${(r.actualKbps || totalKbps(r)) * 1000},RESOLUTION=${r.width}x${r.height},CODECS="${codecString(r.profile, r.level)}"`);
    lines.push(`${r.name}/index.m3u8`);
  }
  const file = path.join(outDir, 'master.m3u8');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

/* ------------------------------------------------------------ process glue */

function runFfmpeg(argv, onProgress) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', buf = '';
    p.stdout.on('data', (d) => {
      buf += d.toString();
      const chunks = buf.split('progress=');
      buf = chunks.pop();
      for (const c of chunks) {
        const kv = {};
        for (const line of c.split('\n')) { const i = line.indexOf('='); if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
        onProgress(kv);
      }
    });
    p.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}\n${stderr.split('\n').slice(-12).join('\n')}`)));
  });
}

function run(cmd, argv) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => stdout += d);
    p.stderr.on('data', (d) => stderr += d);
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-500)}`)));
  });
}

/** Make a test clip with ffmpeg itself, so tests and demos need no downloads. */
export async function makeSample(file, { seconds = 20, width = 1280, height = 720, fps = 30 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await run(FFMPEG, [
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${fps}:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', file,
  ]);
  return file;
}

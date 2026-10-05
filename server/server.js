/**
 * Stream Lab server: upload → transcode → serve through a simulated CDN edge.
 *
 * Routes
 *   GET  /                      the player UI
 *   GET  /api/videos            every packaged video
 *   POST /api/upload            multipart upload, kicks off transcoding
 *   POST /api/sample            make a test clip with ffmpeg and package it
 *   GET  /api/jobs/:id          transcode progress (polled)
 *   GET  /api/edge              edge stats
 *   POST /api/edge/shape        { kbps, latencyMs } bandwidth shaping
 *   POST /api/edge/purge        empty the edge cache
 *   GET  /cdn/<video>/...       segments and playlists, via the edge
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { package_, makeSample, probe } from '../src/transcode.js';
import { Edge } from '../src/edge.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.mp4': 'video/mp4', '.svg': 'image/svg+xml' };
const MAX_UPLOAD = 500 * 1024 * 1024;

export async function createServer({ port = 8080, dataDir = path.join(ROOT, 'data'), log = console.log } = {}) {
  const videosDir = path.join(dataDir, 'videos'), uploadsDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(videosDir, { recursive: true }); fs.mkdirSync(uploadsDir, { recursive: true });
  const edge = new Edge();
  const jobs = new Map();

  const listVideos = () => fs.readdirSync(videosDir).filter((d) => fs.existsSync(path.join(videosDir, d, 'manifest.json')))
    .map((d) => ({ id: d, ...JSON.parse(fs.readFileSync(path.join(videosDir, d, 'manifest.json'), 'utf8')) }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  function startJob(input, name, hwaccel) {
    const id = randomUUID().slice(0, 8);
    const outDir = path.join(videosDir, id);
    const job = { id, name, status: 'running', startedAt: Date.now(), progress: {}, error: null };
    jobs.set(id, job);
    package_(input, outDir, {
      hwaccel,
      onProgress: (p) => { job.progress[p.rendition] = { percent: Math.round(p.percent), fps: p.fps, speed: p.speed, done: !!p.done }; },
    }).then((manifest) => {
      manifest.name = name; manifest.id = id;
      fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      job.status = 'done'; job.manifest = manifest;
      log(`[transcode] ${name} done in ${manifest.wallSeconds.toFixed(1)}s (${manifest.speedVsRealtime}× realtime, ${manifest.renditions.length} renditions)`);
    }).catch((e) => { job.status = 'error'; job.error = e.message; log(`[transcode] ${name} failed: ${e.message}`); });
    return job;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);
    try {
      /* ---------------- API ---------------- */
      if (p === '/api/videos') return json(res, listVideos());
      if (p === '/api/edge') return json(res, edge.summary());
      if (p === '/api/edge/shape' && req.method === 'POST') {
        const b = await body(req);
        edge.setShape({ kbps: b.kbps == null ? null : Math.max(50, Math.min(100_000, Number(b.kbps))), latencyMs: Math.max(0, Math.min(2000, Number(b.latencyMs) || 0)) });
        return json(res, edge.summary());
      }
      if (p === '/api/edge/purge' && req.method === 'POST') { edge.cache.clear(); edge.stats = { hits: 0, misses: 0, bytesServed: 0, requests: 0 }; return json(res, edge.summary()); }
      if (p.startsWith('/api/jobs/')) {
        const job = jobs.get(p.split('/')[3]);
        return job ? json(res, job) : json(res, { error: 'no such job' }, 404);
      }
      if (p === '/api/sample' && req.method === 'POST') {
        const b = await body(req);
        const seconds = Math.max(4, Math.min(120, Number(b.seconds) || 20));
        const file = path.join(uploadsDir, `sample-${Date.now()}.mp4`);
        await makeSample(file, { seconds, width: 1920, height: 1080 });
        return json(res, startJob(file, `Test pattern ${seconds}s 1080p`, !!b.hwaccel));
      }
      if (p === '/api/upload' && req.method === 'POST') {
        const { file, filename } = await saveUpload(req, uploadsDir);
        try { await probe(file); } catch { fs.rmSync(file, { force: true }); return json(res, { error: 'that file does not look like a video ffmpeg can read' }, 400); }
        return json(res, startJob(file, filename, url.searchParams.get('hwaccel') === '1'));
      }

      /* ---------------- CDN edge ---------------- */
      if (p.startsWith('/cdn/')) {
        const rel = p.slice(5);
        if (rel.includes('..')) return send(res, 400, 'bad path');
        const file = path.join(videosDir, rel);
        if (!file.startsWith(videosDir + path.sep)) return send(res, 400, 'bad path');
        const key = rel;
        let entry = edge.get(key);
        const hit = !!entry;
        if (!entry) {
          if (!fs.existsSync(file)) return send(res, 404, 'not found');
          entry = edge.put(key, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
          edge.stats.misses += 1;
        } else edge.stats.hits += 1;
        const { latencyMs, transferMs } = edge.plan(entry.body.length);
        return edge.send(res, entry.body, {
          headers: {
            'content-type': entry.type,
            'cache-control': path.extname(file) === '.m3u8' ? 'no-cache' : 'public, max-age=60',
            'x-cache': hit ? 'HIT' : 'MISS',
            'x-edge-shaped-ms': String(Math.round(latencyMs + transferMs)),
            'timing-allow-origin': '*',
            'access-control-expose-headers': 'x-cache, x-edge-shaped-ms, content-length',
          },
        });
      }

      /* ---------------- static ---------------- */
      const rel = p === '/' ? 'public/index.html' : p.replace(/^\/+/, '');
      const file = path.resolve(ROOT, rel);
      const allowed = ['public', 'src'].some((d) => file.startsWith(path.join(ROOT, d) + path.sep));
      if (!allowed || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'not found');
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      return fs.createReadStream(file).pipe(res);
    } catch (e) {
      log('server error:', e.message);
      if (!res.headersSent) json(res, { error: e.message }, 500);
      else res.end();
    }
  });

  return new Promise((resolve) => server.listen(port, () => resolve({
    port: server.address().port, edge, jobs, videosDir, listVideos,
    close: () => new Promise((d) => server.close(() => d())),
  })));
}

/* ------------------------------------------------------------ helpers */
const json = (res, obj, status = 200) => { const s = JSON.stringify(obj); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) }); res.end(s); };
const send = (res, status, text) => { res.writeHead(status, { 'content-type': 'text/plain' }); res.end(text); };

function body(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 1e6) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

/** Minimal multipart/form-data reader: enough for one video file field. */
function saveUpload(req, dir) {
  return new Promise((resolve, reject) => {
    const ct = req.headers['content-type'] || '';
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
    if (!m) return reject(new Error('expected multipart/form-data'));
    const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
    const chunks = []; let size = 0;
    req.on('data', (d) => { size += d.length; if (size > MAX_UPLOAD) { reject(new Error('file too large')); req.destroy(); return; } chunks.push(d); });
    req.on('error', reject);
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        const start = buf.indexOf(boundary);
        const headEnd = buf.indexOf('\r\n\r\n', start);
        if (start < 0 || headEnd < 0) return reject(new Error('malformed upload'));
        const head = buf.subarray(start, headEnd).toString();
        const fn = /filename="([^"]*)"/i.exec(head);
        const name = (fn && fn[1] ? path.basename(fn[1]) : 'upload.mp4').replace(/[^\w.\- ]/g, '_');
        const dataStart = headEnd + 4;
        const end = buf.indexOf(Buffer.concat([Buffer.from('\r\n'), boundary]), dataStart);
        const data = buf.subarray(dataStart, end < 0 ? buf.length : end);
        if (!data.length) return reject(new Error('empty file'));
        const file = path.join(dir, `${Date.now()}-${name}`);
        fs.writeFileSync(file, data);
        resolve({ file, filename: name });
      } catch (e) { reject(e); }
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8080;
  createServer({ port }).then(({ port: p }) => console.log(`Stream Lab running at http://localhost:${p}`));
}

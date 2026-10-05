// How well does the ABR logic actually do? Plays the same clip in a real
// browser across bandwidth profiles and reports what a viewer would experience.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { createServer } from '../server/server.js';
import { makeSample, package_ } from '../src/transcode.js';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SECONDS = Number(process.env.BENCH_SECONDS || 60);
const WATCH_MS = Number(process.env.BENCH_WATCH_MS || 26000);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-abr-'));
const src = path.join(tmp, 'src.mp4');
process.stdout.write(`\nPreparing a ${SECONDS}s 1080p clip… `);
await makeSample(src, { seconds: SECONDS, width: 1920, height: 1080 });
const videosDir = path.join(tmp, 'videos');
fs.mkdirSync(videosDir, { recursive: true });
const m = await package_(src, path.join(videosDir, 'bench'));
console.log(`${m.renditions.length} renditions, ${(m.totalBytes / 1048576).toFixed(1)} MB`);

const srv = await createServer({ port: 0, dataDir: tmp, log: () => {} });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });

const PROFILES = [
  { label: 'unlimited (local disk)', kbps: null, latencyMs: 0 },
  { label: 'good wifi  (8 Mbps)', kbps: 8000, latencyMs: 20 },
  { label: 'cafe wifi  (2.5 Mbps)', kbps: 2500, latencyMs: 60 },
  { label: 'mobile 3G  (1.2 Mbps)', kbps: 1200, latencyMs: 120 },
  { label: 'bad train  (600 kbps)', kbps: 600, latencyMs: 250 },
  { label: 'drops mid-play (8 → 0.6 Mbps)', kbps: 8000, latencyMs: 20, dropTo: { kbps: 600, latencyMs: 250 }, dropAfterMs: 9000 },
];

console.log(`\nABR benchmark · ${WATCH_MS / 1000}s of playback per profile · ladder ${m.renditions.map((r) => r.name).join('/')}`);
console.log('  network profile                 startup   avg rendition   switches  abandoned  stalls   lost      played');
for (const p of PROFILES) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 960, height: 540 });
  await fetch(`http://localhost:${srv.port}/api/edge/purge`, { method: 'POST' });
  await fetch(`http://localhost:${srv.port}/api/edge/shape`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kbps: p.kbps, latencyMs: p.latencyMs }) });
  await page.goto(`http://localhost:${srv.port}/?v=bench`);
  await page.waitForFunction(() => window.streamLab.player && window.streamLab.player.levels.length, { timeout: 30000 });
  if (p.dropTo) {
    await sleep(p.dropAfterMs);
    await fetch(`http://localhost:${srv.port}/api/edge/shape`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p.dropTo) });
    await sleep(WATCH_MS - p.dropAfterMs);
  } else await sleep(WATCH_MS);

  const s = await page.evaluate(() => {
    const pl = window.streamLab.player, snap = pl.snapshot();
    const names = pl.levels.map((l) => l.name);
    const counts = {};
    for (const sample of pl.stats.samples) counts[names[sample.level]] = (counts[names[sample.level]] || 0) + 1;
    const weighted = pl.stats.samples.reduce((n, x) => n + pl.levels[x.level].bandwidth / 1000, 0) / Math.max(1, pl.stats.samples.length);
    return { ...snap, played: +pl.video.currentTime.toFixed(1), counts, avgLadderKbps: Math.round(weighted) };
  });
  const avg = Object.entries(s.counts).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}×${c}`).join(' ');
  console.log(`  ${p.label.padEnd(30)} ${((s.startupMs || 0) + 'ms').padStart(7)}   ${String(s.avgLadderKbps + 'k').padStart(13)}   ${String(s.switches).padStart(8)}  ${String(s.abandoned).padStart(9)}  ${String(s.stalls).padStart(6)}  ${((s.stalledMs / 1000).toFixed(1) + 's').padStart(6)}   ${(s.played + 's').padStart(6)}   ${avg}`);
  await ctx.close();
}
console.log('');
await browser.close(); await srv.close();
fs.rmSync(tmp, { recursive: true, force: true });

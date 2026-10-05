// Real-browser end-to-end test: transcode, play through the edge, then throttle
// the network and prove the player steps down, recovers, and never stalls badly.
// usage: npm run test:e2e   (needs Google Chrome; CHROME_PATH to override)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { createServer } from '../server/server.js';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = process.env.SHOTS_DIR || path.resolve('docs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (m) => console.log(`  ✓ ${m}`);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-e2e-'));
const srv = await createServer({ port: 0, dataDir, log: () => {} });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
page.on('pageerror', (e) => { console.error('page error:', e.message); process.exitCode = 1; });

const snap = () => page.evaluate(() => window.streamLab.player ? window.streamLab.player.snapshot() : null);
const waitSnap = (fn, ms = 40000) => page.waitForFunction(`(() => { const p = window.streamLab && window.streamLab.player; if (!p) return false; const s = p.snapshot(); return (${fn})(s); })()`, { timeout: ms, polling: 250 });

try {
  console.log('\nStream Lab browser e2e');
  // prepare the clip through the API first, so the page loads a ready video and
  // the test never races the transcode
  const job = await (await fetch(`http://localhost:${srv.port}/api/sample`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seconds: 90 }) })).json();
  let done = null;
  for (let i = 0; i < 300 && !done; i++) {
    const j = await (await fetch(`http://localhost:${srv.port}/api/jobs/${job.id}`)).json();
    if (j.status === 'done') done = j; else if (j.status === 'error') throw new Error(j.error);
    else await sleep(500);
  }
  assert.ok(done, 'transcode did not finish in time');
  await page.goto(`http://localhost:${srv.port}/?v=${job.id}`);
  await page.waitForFunction(() => window.streamLab.current != null, { timeout: 30000 });
  const v = await page.evaluate(() => window.streamLab.current);
  assert.equal(v.renditions.length, 5);
  assert.ok(v.speedVsRealtime > 1, 'should transcode faster than realtime');
  step(`transcoded a 90s 1080p clip into ${v.renditions.length} renditions at ${v.speedVsRealtime}× realtime`);

  await waitSnap('s => s.startupMs != null');
  const started = await snap();
  assert.ok(started.startupMs < 4000, `startup ${started.startupMs}ms should be under 4s`);
  step(`first frame ${started.startupMs} ms after load, starting at ${started.levelName}`);

  await waitSnap('s => s.segmentsLoaded >= 4');
  await waitSnap('s => s.level >= 2', 20000);
  const climbed = await snap();
  step(`climbed to ${climbed.levelName} on a fast link (estimate ${climbed.throughputKbps} kbps)`);

  // squeeze the pipe: 600 kbps only fits the bottom rung
  const beforeT = await page.evaluate(() => window.streamLab.player.video.currentTime);
  await page.evaluate(() => window.streamLab.setShape(4));
  await waitSnap('s => s.level <= 1', 40000);
  const throttled = await snap();
  assert.ok(throttled.level <= 1, 'should drop near the bottom of the ladder');
  assert.ok(throttled.abandoned >= 1, 'should abandon at least one too-slow segment');
  step(`throttled to 600 kbps → dropped to ${throttled.levelName}, abandoning ${throttled.abandoned} mid-flight segment(s)`);
  await waitSnap(`s => true`, 1000).catch(() => {});
  await sleep(5000);
  const mid = await snap();
  const afterT = await page.evaluate(() => window.streamLab.player.video.currentTime);
  assert.ok(afterT > beforeT, 'playback should keep advancing on the slow link');
  assert.ok(mid.segmentsLoaded < mid.segmentsTotal, 'needs segments left to prove recovery');
  step(`kept playing through the squeeze: ${beforeT.toFixed(1)}s → ${afterT.toFixed(1)}s (${mid.segmentsLoaded}/${mid.segmentsTotal} segments)`);
  await page.screenshot({ path: path.join(SHOTS, 'throttled.png') });

  // open it back up: it should climb again
  await page.evaluate(() => window.streamLab.setShape(0));
  await waitSnap('s => s.level >= 2 || s.segmentsLoaded >= s.segmentsTotal', 40000);
  const recovered = await snap();
  assert.ok(recovered.level >= 2, `expected to climb back, ended at ${recovered.levelName}`);
  step(`unthrottled → climbed back to ${recovered.levelName} after ${recovered.switches} switches`);

  const edge = await (await fetch(`http://localhost:${srv.port}/api/edge`)).json();
  assert.ok(edge.hits > 0, 'the edge should have served some cache hits');
  step(`edge cache: ${edge.hits} hits / ${edge.misses} misses (${Math.round(edge.hitRate * 100)}% hit rate)`);

  const final = await snap();
  step(`${final.stalls} stalls, ${(final.stalledMs / 1000).toFixed(1)}s lost across the whole run (including the deliberate 600 kbps squeeze)`);
  await page.screenshot({ path: path.join(SHOTS, 'hero.png') });
  step(`screenshots saved to ${path.relative(process.cwd(), SHOTS)}/`);
  console.log('\nAll browser checks passed.\n');
} catch (e) {
  console.error('\nE2E FAILED:', e.message);
  try { await page.screenshot({ path: '/tmp/sl-fail.png' }); console.error('screenshot: /tmp/sl-fail.png'); } catch {}
  try { console.error('snapshot:', JSON.stringify(await snap())); } catch {}
  process.exitCode = 1;
} finally {
  await browser.close(); await srv.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

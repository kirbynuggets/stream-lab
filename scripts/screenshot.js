// README screenshots: a healthy stream, a throttled one, and mobile.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { createServer } from '../server/server.js';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-shots-'));
const srv = await createServer({ port: 0, dataDir: tmp, log: () => {} });
const base = `http://localhost:${srv.port}`;
process.stdout.write('preparing a clip… ');
const job = await (await fetch(`${base}/api/sample`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seconds: 90 }) })).json();
for (;;) { const j = await (await fetch(`${base}/api/jobs/${job.id}`)).json(); if (j.status === 'done') break; if (j.status === 'error') throw new Error(j.error); await sleep(500); }
console.log('done');

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
async function shot(name, { width, height, dsf = 2, mobile = false, shape = 0, waitMs = 9000, scrollTo = 0 }) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: dsf, isMobile: mobile, hasTouch: mobile });
  await page.goto(`${base}/?v=${job.id}`);
  await page.waitForFunction(() => window.streamLab.player && window.streamLab.player.levels.length, { timeout: 30000 });
  if (shape) { await sleep(4000); await page.evaluate((i) => window.streamLab.setShape(i), shape); }
  await sleep(waitMs);
  if (scrollTo) { await page.evaluate((y) => window.scrollTo(0, y), scrollTo); await sleep(400); }
  await page.screenshot({ path: `docs/${name}.png` });
  console.log(`docs/${name}.png`);
  await ctx.close();
}
await shot('hero', { width: 1440, height: 1000 });
await shot('throttled', { width: 1440, height: 1000, shape: 3, waitMs: 16000, scrollTo: 620 });
await shot('mobile', { width: 390, height: 844, dsf: 3, mobile: true });
await browser.close(); await srv.close();
fs.rmSync(tmp, { recursive: true, force: true });

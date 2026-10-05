import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Edge } from '../src/edge.js';

test('cache reports hits and misses, and honours its TTL', () => {
  const e = new Edge({ ttlMs: 30 });
  assert.equal(e.get('a'), null);
  e.put('a', Buffer.from('hello'), 'text/plain');
  assert.ok(e.get('a'));
  const then = Date.now;
  Date.now = () => then() + 1000;
  assert.equal(e.get('a'), null, 'expired entries are dropped');
  Date.now = then;
});

test('shaping turns bytes into a believable transfer time', () => {
  const e = new Edge();
  assert.deepEqual(e.plan(1_000_000), { latencyMs: 0, transferMs: 0 });   // unlimited
  e.setShape({ kbps: 1000, latencyMs: 40 });
  const p = e.plan(125_000);          // 1 Mbit at 1000 kbps = 1 second
  assert.equal(p.latencyMs, 40);
  assert.ok(Math.abs(p.transferMs - 1000) < 1, `expected ~1000ms, got ${p.transferMs}`);
});

test('shaped sends really do take that long, and arrive intact', async () => {
  const e = new Edge();
  e.setShape({ kbps: 2000, latencyMs: 20 });      // 250 KB ≈ 1s
  const body = Buffer.alloc(250_000, 7);
  const chunks = [];
  const res = fakeRes(chunks);
  const t0 = Date.now();
  await e.send(res, body);
  const took = Date.now() - t0;
  assert.ok(took > 700, `expected shaping to slow this down, took ${took}ms`);
  assert.equal(Buffer.concat(chunks).length, body.length);
  assert.ok(chunks.length > 1, 'should trickle in slices, not one lump');
  assert.equal(res.headers['content-length'], body.length);
});

test('stats add up', async () => {
  const e = new Edge();
  e.put('x', Buffer.alloc(10), 'application/octet-stream');
  e.stats.misses += 1; e.get('x'); e.stats.hits += 1;
  await e.send(fakeRes([]), Buffer.alloc(100));
  const s = e.summary();
  assert.equal(s.hitRate, 0.5);
  assert.equal(s.bytesServed, 100);
  assert.equal(s.objects, 1);
});

function fakeRes(chunks) {
  return {
    headers: null, writableEnded: false, destroyed: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(c) { chunks.push(Buffer.from(c)); return true; },
    end(c) { if (c) chunks.push(Buffer.from(c)); this.writableEnded = true; },
    once() {},
  };
}

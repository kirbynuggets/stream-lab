/**
 * A tiny CDN edge, standing in for CloudFront or Fastly.
 *
 * It does the three things that actually shape a viewer's experience:
 *   1. caches segments in memory with TTLs, reporting HIT / MISS like a real edge
 *   2. shapes bandwidth, so we can watch a player adapt to a slow link
 *   3. adds latency, because an edge is never zero distance away
 *
 * Shaping happens here rather than in the browser on purpose: throttling at the
 * edge is honest (the bytes really do arrive slowly), so the player's own ABR
 * logic has to cope, exactly as it would on a train.
 */

export class Edge {
  constructor({ ttlMs = 60_000 } = {}) {
    this.cache = new Map();         // key -> { body, type, at }
    this.ttlMs = ttlMs;
    this.stats = { hits: 0, misses: 0, bytesServed: 0, requests: 0 };
    // bandwidth in kbps (null = unlimited), extra latency per request in ms
    this.shape = { kbps: null, latencyMs: 0 };
  }

  setShape({ kbps = null, latencyMs = 0 }) { this.shape = { kbps, latencyMs }; }

  /** Look up a cached object, honouring the TTL. */
  get(key) {
    const e = this.cache.get(key);
    if (!e) return null;
    if (Date.now() - e.at > this.ttlMs) { this.cache.delete(key); return null; }
    return e;
  }

  put(key, body, type) {
    this.cache.set(key, { body, type, at: Date.now() });
    return this.cache.get(key);
  }

  /**
   * How long sending `bytes` should take, given the shaping, and the per-request
   * latency to wait first.
   */
  plan(bytes) {
    const { kbps, latencyMs } = this.shape;
    const transferMs = kbps ? (bytes * 8) / (kbps * 1000) * 1000 : 0;
    return { latencyMs, transferMs };
  }

  /**
   * Stream a body out of a Node response, paced to the shaped bandwidth.
   * Writes in ~50 ms slices so the client sees a steady trickle rather than
   * one lump after a delay, which is what a real slow link feels like.
   */
  async send(res, body, { status = 200, headers = {} } = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const { latencyMs, transferMs } = this.plan(buf.length);
    this.stats.requests += 1;
    this.stats.bytesServed += buf.length;
    res.writeHead(status, { 'content-length': buf.length, 'access-control-allow-origin': '*', ...headers });
    if (latencyMs) await sleep(latencyMs);
    if (!transferMs || transferMs < 30) { res.end(buf); return; }

    const sliceMs = 50;
    const slices = Math.max(1, Math.ceil(transferMs / sliceMs));
    const per = Math.ceil(buf.length / slices);
    for (let i = 0; i < slices; i++) {
      if (res.writableEnded || res.destroyed) return;
      const chunk = buf.subarray(i * per, Math.min(buf.length, (i + 1) * per));
      if (!res.write(chunk)) await once(res, 'drain');
      await sleep(sliceMs);
    }
    res.end();
  }

  summary() {
    const { hits, misses } = this.stats;
    return { ...this.stats, hitRate: hits + misses ? +(hits / (hits + misses)).toFixed(3) : 0, objects: this.cache.size, shape: this.shape };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const once = (emitter, ev) => new Promise((r) => emitter.once(ev, r));

/**
 * A small HLS player written from scratch: parse the playlists, fetch segments,
 * append them to a MediaSource, and switch rendition based on measured
 * throughput and how much buffer is left.
 *
 * Why not hls.js? Because the interesting part of this project *is* the ABR
 * logic, and owning it means every decision is visible and explainable:
 *
 *  - Throughput is an EWMA of real segment downloads, not a single sample, so
 *    one slow request does not panic the ladder.
 *  - Switching up needs the estimate to beat the next rung with a safety margin
 *    AND enough buffer to survive a mistake. Switching down happens as soon as
 *    the buffer looks unsafe, because a stall is far worse than a soft picture.
 *  - A dwell time stops the quality oscillating when throughput sits exactly
 *    between two rungs.
 */

export class HlsPlayer extends EventTarget {
  constructor(video, { safetyFactor = 0.8, upBufferSeconds = 6, panicBufferSeconds = 3.5, dwellMs = 2500, maxBufferSeconds = 16 } = {}) {   // a 16s cap keeps ABR responsive, like a low-latency player
    super();
    this.video = video;
    this.opts = { safetyFactor, upBufferSeconds, panicBufferSeconds, dwellMs, maxBufferSeconds };
    this.levels = [];           // low → high
    this.level = 0;
    this.autoLevel = true;
    this.segments = [];
    this.index = 0;
    this.throughputKbps = null; // EWMA
    this.lastSwitch = 0;
    this.stats = { switches: [], stalls: 0, stalledMs: 0, downloaded: 0, bytes: 0, hits: 0, misses: 0, startupMs: null, samples: [] };
    this.destroyed = false;
    this.mediaSource = null;
    this.sb = null;
    this.appending = false;
    this._onStall = () => { this.stats.stalls += 1; this._stallStart = performance.now(); this.emit('stall'); };
    this._onPlaying = () => { if (this._stallStart) { this.stats.stalledMs += performance.now() - this._stallStart; this._stallStart = null; this.emit('resume'); } };
    video.addEventListener('waiting', this._onStall);
    video.addEventListener('playing', this._onPlaying);
    this.watchMediaErrors();
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  /** A decode error is fatal for this media element, so surface it loudly. */
  watchMediaErrors() {
    this.video.addEventListener('error', () => {
      const e = this.video.error;
      if (e) this.emit('error', { message: `media error ${e.code}: ${e.message || 'decode failed'}`, fatal: true });
    });
  }

  /* ------------------------------------------------------------ loading */

  async load(masterUrl) {
    // resolve against the document so relative paths work as playlist bases
    this.masterUrl = new URL(masterUrl, (typeof location !== 'undefined' ? location.href : 'http://localhost/')).href;
    masterUrl = this.masterUrl;
    const t0 = performance.now();
    const master = await (await fetch(masterUrl, { cache: 'no-store' })).text();
    this.levels = parseMaster(master, masterUrl);
    if (!this.levels.length) throw new Error('no renditions in master playlist');
    this.level = this.pickStartLevel();
    await this.loadLevel(this.level);
    await this.attach();
    this.startupT0 = t0;
    this.pump();
    this.emit('ready', { levels: this.levels, level: this.level });
  }

  /** Start conservatively: second rung if we have one, since we know nothing about the link yet. */
  pickStartLevel() { return Math.min(1, this.levels.length - 1); }

  async loadLevel(i) {
    const text = await (await fetch(this.levels[i].url, { cache: 'no-store' })).text();
    const parsed = parseMedia(text, this.levels[i].url);
    this.levels[i].initUrl = parsed.initUrl;
    this.segments = parsed.segments;
    this.targetDuration = parsed.targetDuration;
    this.duration = parsed.segments.reduce((n, s) => n + s.duration, 0);
  }

  mimeFor(i) { return `video/mp4; codecs="${this.levels[i].codecs || 'avc1.4d401f,mp4a.40.2'}"`; }

  async attach() {
    // configure for the top rung: it covers every codec string in the ladder
    const mime = this.mimeFor(this.levels.length - 1);
    if (!('MediaSource' in window) || !MediaSource.isTypeSupported(mime)) {
      // no MSE for this codec: hand the master playlist to the browser and let
      // it do its own ABR (Safari). We lose our stats, but it still plays.
      this.useNative = true;
      this.video.src = this.masterUrl;
      return;
    }
    this.mediaSource = new MediaSource();
    this.video.src = URL.createObjectURL(this.mediaSource);
    await new Promise((r) => this.mediaSource.addEventListener('sourceopen', r, { once: true }));
    this.sb = this.mediaSource.addSourceBuffer(mime);
    this.sb.mode = 'segments';
    this.sbMime = mime;
  }

  /** Every rendition has its own init segment; a switch needs the new one appended first. */
  async appendInit(level) {
    const url = this.levels[level].initUrl;
    if (!url || this.initAppended === url) return;
    // Tell the decoder the stream's configuration just changed. This MUST happen
    // while the SourceBuffer is idle: calling it mid-append throws, and a missed
    // changeType shows up much later as an unexplained decode error.
    const mime = this.mimeFor(level);
    if (this.sb && this.sb.changeType && mime !== this.sbMime) {
      await this.whenIdle();
      try { this.sb.changeType(mime); this.sbMime = mime; }
      catch (e) { this.emit('error', { message: `changeType failed: ${e.name}` }); }
    }
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`init segment → ${res.status}`);
    await this.append(await res.arrayBuffer());
    this.initAppended = url;
  }

  /** Keep the buffer topped up, one segment at a time. */
  async pump() {
    if (this.destroyed || this.useNative) return;
    while (!this.destroyed && this.index < this.segments.length) {
      // Two caps, both needed. Buffered seconds is the honest measure, but on a
      // very fast link a browser can report an odd range while we race ahead; a
      // cap on playlist time already fetched keeps ABR getting decision points
      // instead of swallowing the whole file in one burst.
      const ahead = Math.max(this.bufferAhead(), this.fetchedAhead());
      if (ahead > this.opts.maxBufferSeconds) { await sleep(200); continue; }
      const seg = this.segments[this.index];
      const level = this.level;
      try {
        await this.appendInit(level);
        const got = await this.fetchSegment(seg, level);
        if (this.destroyed) return;
        if (got.abandoned) {
          // drop a rung (or as far as the measured throughput justifies) and retry this very segment
          const safe = (this.throughputKbps || 0) * this.opts.safetyFactor;
          let down = this.levels.findLastIndex((l) => l.bandwidth / 1000 <= safe);
          if (down < 0 || down >= this.level) down = this.level - 1;
          if (down < 0) down = 0;
          if (down !== this.level) await this.switchTo(down, { est: this.throughputKbps, buf: this.bufferAhead(), abandoned: true });
          continue;
        }
        await this.appendWithEviction(got.buffer);
        this.index += 1;
        this.fails = 0;
        if (this.stats.startupMs == null) { this.stats.startupMs = performance.now() - this.startupT0; this.emit('startup', { ms: this.stats.startupMs }); }
        if (this.autoLevel) this.decideLevel();
        this.emit('progress', this.snapshot());
      } catch (e) {
        if (this.destroyed) return;
        this.fails = (this.fails || 0) + 1;
        this.emit('error', { message: `${e.name || 'Error'}: ${e.message} (segment ${seg.index}, ${this.levels[level].name})`, fatal: this.fails > 6 });
        if (this.fails > 6) return;               // stop hammering a segment that will never append
        await sleep(400);
      }
    }
    if (!this.destroyed && this.mediaSource && this.mediaSource.readyState === 'open' && this.index >= this.segments.length) {
      try { this.mediaSource.endOfStream(); } catch {}
      this.emit('ended');
    }
  }

  /**
   * Download one segment, watching it as it streams in.
   *
   * A segment that turns slow mid-flight is the classic ABR trap: if we just
   * wait for it, the buffer drains and the player stalls before the next
   * decision point. So we estimate, as bytes arrive, whether this segment can
   * still land before the buffer runs dry. If it cannot, we abandon it and
   * report back so the caller can retry lower down the ladder.
   */
  async fetchSegment(seg, level) {
    const t0 = performance.now();
    const ctrl = new AbortController();
    const res = await fetch(seg.url, { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) throw new Error(`segment ${seg.index} → ${res.status}`);
    const cache = res.headers.get('x-cache');
    const expected = Number(res.headers.get('content-length')) || 0;

    let buffer;
    if (!res.body || level === 0) {
      buffer = await res.arrayBuffer();                      // bottom rung: nowhere left to drop to
    } else {
      const reader = res.body.getReader();
      const parts = [];
      let got = 0, abandoned = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value); got += value.length;
        const ms = performance.now() - t0;
        if (ms > 400 && expected > got) {
          const kbpsNow = (got * 8) / ms;                    // kbit/s so far
          const etaMs = ((expected - got) * 8) / Math.max(kbpsNow, 1);
          const safety = 1.2;
          if (etaMs * safety > this.bufferAhead() * 1000) { abandoned = true; break; }
        }
      }
      if (abandoned) {
        ctrl.abort();
        const ms = performance.now() - t0;
        const kbps = (got * 8) / ms;
        this.noteThroughput(kbps, cache);
        this.stats.samples.push({ t: Date.now(), kbps: Math.round(kbps), level, bytes: got, ms: Math.round(ms), cache, abandoned: true });
        this.stats.abandoned = (this.stats.abandoned || 0) + 1;
        this.emit('abandon', { index: seg.index, level, kbps: Math.round(kbps), bufferS: +this.bufferAhead().toFixed(1) });
        return { abandoned: true, kbps };
      }
      buffer = concat(parts);
    }

    const ms = performance.now() - t0;
    const kbps = (buffer.byteLength * 8) / ms;               // bytes*8/ms == kbit/s
    if (cache === 'HIT') this.stats.hits += 1; else if (cache === 'MISS') this.stats.misses += 1;
    this.stats.downloaded += 1; this.stats.bytes += buffer.byteLength;
    this.noteThroughput(kbps, cache);
    this.stats.samples.push({ t: Date.now(), kbps: Math.round(kbps), level, bytes: buffer.byteLength, ms: Math.round(ms), cache });
    if (this.stats.samples.length > 400) this.stats.samples.shift();
    return { buffer, ms, kbps };
  }

  /** Cached responses say nothing about the network, so they never move the estimate. */
  noteThroughput(kbps, cache) {
    if (cache === 'HIT') return;
    const alpha = this.throughputKbps == null ? 1 : 0.35;
    this.throughputKbps = this.throughputKbps == null ? kbps : alpha * kbps + (1 - alpha) * this.throughputKbps;
  }

  /**
   * Drop everything buffered after the playhead (keeping a moment of lead-in so
   * playback does not jolt) and report the timeline position to refill from.
   */
  async flushAhead() {
    const keepTo = this.video.currentTime + 0.5;
    await this.whenIdle();
    try {
      this.sb.remove(keepTo, Infinity);
      await this.whenIdle();
    } catch { /* nothing buffered ahead */ }
    return keepTo;
  }

  /** Which segment covers a given point on the timeline. */
  segmentIndexAt(time) {
    let t = 0;
    for (let i = 0; i < this.segments.length; i++) {
      t += this.segments[i].duration;
      if (t > time) return i;
    }
    return this.segments.length;
  }

  /** Resolve once the SourceBuffer is ready to accept another operation. */
  whenIdle() {
    if (!this.sb || !this.sb.updating) return Promise.resolve();
    return new Promise((r) => this.sb.addEventListener('updateend', r, { once: true }));
  }

  async append(buffer) {
    await this.whenIdle();
    return new Promise((resolve, reject) => {
      if (!this.sb) return resolve();
      const ok = () => { cleanup(); resolve(); };
      const bad = () => { cleanup(); reject(new Error('SourceBuffer rejected the segment')); };
      const cleanup = () => { this.sb.removeEventListener('updateend', ok); this.sb.removeEventListener('error', bad); };
      this.sb.addEventListener('updateend', ok, { once: true });
      this.sb.addEventListener('error', bad, { once: true });
      try { this.sb.appendBuffer(new Uint8Array(buffer)); } catch (e) { cleanup(); reject(e); }
    });
  }

  /** Append, and if the buffer is full, drop what has already played and try once more. */
  async appendWithEviction(buffer) {
    try { await this.append(buffer); }
    catch (e) {
      if (e.name !== 'QuotaExceededError') throw e;
      await this.evictPlayed();
      await this.append(buffer);
      this.emit('evict', { atTime: this.video.currentTime });
    }
  }

  evictPlayed() {
    return new Promise((resolve) => {
      const keepFrom = Math.max(0, this.video.currentTime - 4);
      if (!this.sb || keepFrom <= 0 || this.sb.updating) return resolve();
      this.sb.addEventListener('updateend', () => resolve(), { once: true });
      try { this.sb.remove(0, keepFrom); } catch { resolve(); }
    });
  }

  /* ------------------------------------------------------------ the ABR rule */

  decideLevel() {
    const est = this.throughputKbps;
    if (est == null) return;
    const buf = this.bufferAhead();
    const now = performance.now();
    const safe = est * this.opts.safetyFactor;
    let next = this.level;

    // down first, and immediately: stalls cost far more than softness
    if (buf < this.opts.panicBufferSeconds && this.level > 0) {
      next = this.levels.findLastIndex((l) => l.bandwidth / 1000 <= safe);
      if (next < 0) next = 0;
      if (next > this.level) next = this.level - 1;
    } else if (this.levels[this.level].bandwidth / 1000 > safe && this.level > 0) {
      next = Math.max(0, this.levels.findLastIndex((l) => l.bandwidth / 1000 <= safe));
    } else if (buf > this.opts.upBufferSeconds && now - this.lastSwitch > this.opts.dwellMs) {
      // jump straight to the best rung the measurement supports: climbing one
      // step at a time wastes a good connection for tens of seconds
      const best = this.levels.findLastIndex((l) => l.bandwidth / 1000 <= safe);
      if (best > this.level) next = best;
    }

    if (next !== this.level && next >= 0) this.switchTo(next, { est, buf });
  }

  async switchTo(i, why = {}) {
    const from = this.level;
    this.level = i;
    this.lastSwitch = performance.now();
    this.stats.switches.push({ t: Date.now(), from, to: i, reason: i > from ? 'up' : 'down', estKbps: Math.round(why.est || 0), bufferS: +(why.buf || 0).toFixed(1) });
    const playedIndex = this.index;
    await this.loadLevel(i);
    this.index = Math.min(playedIndex, this.segments.length);   // segments are aligned, so the index carries over
    if (this.sb) { try { await this.appendInit(i); } catch (e) { this.emit('error', { message: e.message }); } }
    this.emit('levelswitch', { from, to: i, level: this.levels[i], ...why });
  }

  setAuto(on) { this.autoLevel = on; if (on) this.decideLevel(); }
  async setLevel(i) { this.autoLevel = false; if (i !== this.level) await this.switchTo(i, { est: this.throughputKbps || 0, buf: this.bufferAhead() }); }

  /** Seconds of playlist already requested beyond the playhead. */
  fetchedAhead() {
    let t = 0;
    for (let i = 0; i < this.index && i < this.segments.length; i++) t += this.segments[i].duration;
    return Math.max(0, t - this.video.currentTime);
  }

  bufferAhead() {
    const v = this.video, b = v.buffered;
    for (let i = 0; i < b.length; i++) if (v.currentTime >= b.start(i) - 0.2 && v.currentTime <= b.end(i)) return b.end(i) - v.currentTime;
    return 0;
  }

  snapshot() {
    return {
      level: this.level, levelName: this.levels[this.level] && this.levels[this.level].name,
      throughputKbps: this.throughputKbps ? Math.round(this.throughputKbps) : null,
      bufferSeconds: +this.bufferAhead().toFixed(1),
      segmentsLoaded: this.index, segmentsTotal: this.segments.length,
      switches: this.stats.switches.length, abandoned: this.stats.abandoned || 0, stalls: this.stats.stalls, stalledMs: Math.round(this.stats.stalledMs),
      startupMs: this.stats.startupMs ? Math.round(this.stats.startupMs) : null,
      bytes: this.stats.bytes, cacheHits: this.stats.hits, cacheMisses: this.stats.misses,
      samples: this.stats.samples,
      autoLevel: this.autoLevel,
    };
  }

  destroy() {
    this.destroyed = true;
    this.video.removeEventListener('waiting', this._onStall);
    this.video.removeEventListener('playing', this._onPlaying);
    try { if (this.mediaSource && this.mediaSource.readyState === 'open') this.mediaSource.endOfStream(); } catch {}
    this.video.removeAttribute('src'); this.video.load();
  }
}

/* ------------------------------------------------------------ parsing */

export function parseMaster(text, baseUrl) {
  const out = [], lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const attrs = parseAttrs(lines[i].slice(lines[i].indexOf(':') + 1));
    const uri = (lines[i + 1] || '').trim();
    if (!uri || uri.startsWith('#')) continue;
    const res = (attrs.RESOLUTION || '').split('x');
    out.push({
      bandwidth: Number(attrs.BANDWIDTH) || 0,
      averageBandwidth: Number(attrs['AVERAGE-BANDWIDTH']) || 0,
      width: Number(res[0]) || 0, height: Number(res[1]) || 0,
      codecs: attrs.CODECS || '',
      name: res[1] ? `${res[1]}p` : `${Math.round((Number(attrs.BANDWIDTH) || 0) / 1000)}k`,
      url: new URL(uri, baseUrl).href,
    });
  }
  return out.sort((a, b) => a.bandwidth - b.bandwidth);
}

export function parseMedia(text, baseUrl) {
  const segments = []; let duration = 0, targetDuration = 0, i = 0, initUrl = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-MAP')) { const m = /URI="([^"]+)"/.exec(line); if (m) initUrl = new URL(m[1], baseUrl).href; }
    else if (line.startsWith('#EXT-X-TARGETDURATION')) targetDuration = Number(line.split(':')[1]) || 0;
    else if (line.startsWith('#EXTINF')) duration = parseFloat(line.split(':')[1]) || 0;
    else if (line && !line.startsWith('#')) { segments.push({ index: i++, duration, url: new URL(line, baseUrl).href }); duration = 0; }
  }
  return { segments, targetDuration, initUrl };
}

function parseAttrs(s) {
  const out = {};
  for (const m of s.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0), out = new Uint8Array(total);
  let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
  return out.buffer;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

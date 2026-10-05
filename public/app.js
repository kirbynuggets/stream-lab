import { HlsPlayer } from '/public/player.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const fmtMB = (b) => `${(b / 1048576).toFixed(1)} MB`;
const fmtKbps = (k) => k == null ? '—' : k >= 1000 ? `${(k / 1000).toFixed(1)} Mbps` : `${Math.round(k)} kbps`;

const SHAPES = [
  { label: 'Unlimited', kbps: null },
  { label: '5 Mbps', kbps: 5000 },
  { label: '2.5 Mbps', kbps: 2500 },
  { label: '1.2 Mbps', kbps: 1200 },
  { label: '600 kbps', kbps: 600 },
];
const LEVEL_COLORS = ['#ffb43a', '#4ea1ff', '#2fd27a', '#a569ff'];

let player = null, videos = [], current = null, pollTimer = null, jobTimer = null;

/* ------------------------------------------------------------ library */
async function loadLibrary(selectId) {
  videos = await (await fetch('/api/videos')).json();
  $('#library').innerHTML = videos.length
    ? videos.map((v) => `<option value="${v.id}">${esc(v.name || v.source.file)} · ${v.renditions.length} renditions · ${Math.round(v.source.duration)}s</option>`).join('')
    : '<option value="">no videos yet</option>';
  if (videos.length) { $('#library').value = selectId || videos[0].id; return $('#library').value; }
  return null;
}
$('#library').onchange = () => play($('#library').value);

/* ------------------------------------------------------------ ingest */
async function makeSample(seconds = 60) {
  toast('Generating a test clip with ffmpeg…');
  const job = await (await fetch('/api/sample', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seconds }) })).json();
  watchJob(job.id, `Test clip · ${seconds}s 1080p`);
}
$('#sample').onclick = () => makeSample(60);
$('#startSample').onclick = () => makeSample(60);
$('#upload').onchange = async (e) => {
  const file = e.target.files[0]; if (!file) return;
  const fd = new FormData(); fd.append('video', file);
  $('#overlay').hidden = false; $('#overlay').querySelector('h1').textContent = 'Uploading…';
  const r = await fetch('/api/upload', { method: 'POST', body: fd });
  const job = await r.json();
  if (job.error) { toast(job.error); return; }
  watchJob(job.id, file.name);
  e.target.value = '';
};

function watchJob(id, title) {
  $('#overlay').hidden = true;
  $('#jobcard').hidden = false;
  $('#jobTitle').textContent = `Transcoding ${title}`;
  clearInterval(jobTimer);
  jobTimer = setInterval(async () => {
    const job = await (await fetch(`/api/jobs/${id}`)).json();
    const rows = Object.entries(job.progress || {});
    $('#jobRows').innerHTML = rows.map(([name, p]) => `<div class="jobrow ${p.done ? 'done' : ''}"><span>${name}</span><i><b style="width:${p.percent}%"></b></i><span>${p.done ? 'done' : `${p.percent}%${p.speed ? ` · ${p.speed}` : ''}`}</span></div>`).join('') || '<small class="muted">starting ffmpeg…</small>';
    if (job.status === 'done') {
      clearInterval(jobTimer); jobTimer = null;
      $('#jobcard').hidden = true;
      const m = job.manifest;
      toast(`Transcoded in ${m.wallSeconds.toFixed(1)}s · ${m.speedVsRealtime}× realtime · ${m.renditions.length} renditions`);
      await loadLibrary(id);
      play(id);
    } else if (job.status === 'error') {
      clearInterval(jobTimer);
      $('#jobcard').hidden = true; $('#overlay').hidden = false;
      $('#overlay').querySelector('h1').textContent = 'Transcode failed';
      $('#overlay').querySelector('p').textContent = job.error;
      toast('Transcode failed: ' + job.error);
    }
  }, 400);
}

/* ------------------------------------------------------------ playback */
let playGen = 0;
async function play(id) {
  const v = videos.find((x) => x.id === id); if (!v) return;
  const gen = ++playGen;                       // a later play() always wins
  current = v;
  if (player) { player.destroy(); player = null; }
  $('#overlay').hidden = true;
  $('#badge').hidden = false;
  $('#log').innerHTML = '';
  renderLadder();
  $('#encInfo').textContent = `${v.source.width}×${v.source.height} · ${Math.round(v.source.duration)}s source → ${v.renditions.length} renditions · ${v.encoder} · packaged ${v.speedVsRealtime}× realtime · ${fmtMB(v.totalBytes)} total`;

  const video = $('#video');
  const p = new HlsPlayer(video);
  if (gen !== playGen) { p.destroy(); return; }
  player = p;
  player.addEventListener('ready', ({ detail }) => { renderPicker(); video.play().catch(() => {}); });
  player.addEventListener('levelswitch', ({ detail }) => {
    const { from, to, estKbps } = { ...detail, estKbps: Math.round(detail.est || 0) };
    logLine(to > from ? 'up' : 'down', `${player.levels[from].name} → ${player.levels[to].name}`, `${fmtKbps(estKbps)} est · ${detail.buf != null ? detail.buf.toFixed(1) + 's buffer' : ''}`);
    renderPicker(); renderLadder();
  });
  player.addEventListener('stall', () => logLine('stall', 'buffer ran dry', 'player stalled'));
  player.addEventListener('abandon', ({ detail }) => logLine('down', `abandoned segment ${detail.index}`, `too slow at ${fmtKbps(detail.kbps)} · ${detail.bufferS}s buffer left`));
  player.addEventListener('startup', ({ detail }) => logLine('', 'first frame', `${Math.round(detail.ms)} ms after load`));
  player.addEventListener('error', ({ detail }) => toast(detail.message));
  try {
    await p.load(`/cdn/${v.id}/master.m3u8`);
    if (gen !== playGen) { p.destroy(); return; }
    if (p.useNative) toast('Your browser lacks MSE for this codec: falling back to native HLS (stats unavailable)');
  } catch (e) { toast('Could not start playback: ' + e.message); }
}

/* ------------------------------------------------------------ shaping */
let shapeIdx = 0;
$('#shapes').innerHTML = SHAPES.map((s, i) => `<button data-i="${i}" class="${i ? '' : 'on'}">${s.label}</button>`).join('');
$$('#shapes button').forEach((b) => b.onclick = () => setShape(+b.dataset.i));
$('#latency').onchange = () => setShape(shapeIdx);
async function setShape(i) {
  shapeIdx = i;
  $$('#shapes button').forEach((b) => b.classList.toggle('on', +b.dataset.i === i));
  const kbps = SHAPES[i].kbps, latencyMs = Math.max(0, +$('#latency').value || 0);
  await fetch('/api/edge/shape', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kbps, latencyMs }) });
  $('#shapeNote').textContent = kbps
    ? `Edge is shaping to ${SHAPES[i].label}${latencyMs ? ` with ${latencyMs} ms added latency` : ''}. Watch the player step down, then recover.`
    : 'No shaping: segments arrive as fast as the disk allows.';
  logLine('', 'network changed', kbps ? `${SHAPES[i].label}${latencyMs ? ` +${latencyMs}ms` : ''}` : 'unlimited');
}
$('#purge').onclick = async () => { await fetch('/api/edge/purge', { method: 'POST' }); toast('Edge cache purged: next segments come from origin'); };
$('#auto').onchange = (e) => { player && player.setAuto(e.target.checked); $('#levelPicker').classList.toggle('off', e.target.checked); renderPicker(); };
$('#levelPicker').classList.toggle('off', true);

/* ------------------------------------------------------------ rendering */
function renderPicker() {
  if (!player || !player.levels.length) return;
  $('#levelPicker').innerHTML = player.levels.map((l, i) => `<button data-i="${i}" class="${i === player.level ? 'on' : ''}">${l.name}</button>`).join('');
  $$('#levelPicker button').forEach((b) => b.onclick = () => { player.setLevel(+b.dataset.i); $('#auto').checked = false; $('#levelPicker').classList.remove('off'); renderPicker(); });
}
function renderLadder() {
  if (!current) return;
  const rows = current.renditions.map((r, i) => `<tr class="${player && player.level === i ? 'on' : ''}"><td>${r.name}</td><td>${r.width}×${r.height}</td><td>${r.actualKbps} kbps</td><td>${r.segments} seg</td><td>${fmtMB(r.bytes)}</td></tr>`).reverse().join('');
  $('#ladder tbody').innerHTML = rows;
}
function logLine(kind, what, detail) {
  const li = document.createElement('li');
  li.innerHTML = `<span>${new Date().toLocaleTimeString([], { hour12: false })}</span><b class="${kind}">${esc(what)}</b><span>${esc(detail || '')}</span>`;
  $('#log').prepend(li);
  while ($('#log').children.length > 60) $('#log').lastChild.remove();
}

/* chart: throughput line + rendition band underneath */
const chart = $('#chart'), cctx = chart.getContext('2d');
function drawChart(samples) {
  const dpr = Math.min(devicePixelRatio || 1, 2), w = chart.clientWidth, h = 130;
  if (chart.width !== w * dpr) { chart.width = w * dpr; chart.height = h * dpr; }
  cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cctx.clearRect(0, 0, w, h);
  const pts = samples.slice(-80);
  if (!pts.length) { cctx.fillStyle = '#9c98a8'; cctx.font = '12px Inter, sans-serif'; cctx.fillText('waiting for segment downloads…', 12, h / 2); return; }
  const max = Math.max(...pts.map((p) => p.kbps), ...(player ? player.levels.map((l) => l.bandwidth / 1000) : [1000])) * 1.15;
  const x = (i) => (i / Math.max(1, pts.length - 1)) * (w - 8) + 4;
  const y = (k) => h - 22 - (k / max) * (h - 34);

  // ladder reference lines
  if (player) player.levels.forEach((l, i) => {
    const yy = y(l.bandwidth / 1000);
    cctx.strokeStyle = LEVEL_COLORS[i % LEVEL_COLORS.length] + '44'; cctx.lineWidth = 1; cctx.setLineDash([3, 3]);
    cctx.beginPath(); cctx.moveTo(4, yy); cctx.lineTo(w - 4, yy); cctx.stroke(); cctx.setLineDash([]);
  });
  // chosen rendition band
  pts.forEach((p, i) => {
    cctx.fillStyle = LEVEL_COLORS[p.level % LEVEL_COLORS.length] + 'cc';
    cctx.fillRect(x(i) - 1, h - 14, Math.max(2, (w - 8) / pts.length), 8);
  });
  // throughput line
  cctx.strokeStyle = '#f2f0f4'; cctx.lineWidth = 1.8; cctx.beginPath();
  pts.forEach((p, i) => i ? cctx.lineTo(x(i), y(p.kbps)) : cctx.moveTo(x(i), y(p.kbps)));
  cctx.stroke();
  // cache hits as dots
  pts.forEach((p, i) => { if (p.cache === 'HIT') { cctx.fillStyle = '#2fd27a'; cctx.beginPath(); cctx.arc(x(i), y(p.kbps), 2.4, 0, 6.3); cctx.fill(); } });
}
$('#chartKey').innerHTML = `<span><i style="background:#f2f0f4"></i>measured throughput</span><span><i style="background:#2fd27a"></i>cache hit</span>` +
  LEVEL_COLORS.map((c, i) => `<span><i style="background:${c}"></i>level ${i}</span>`).join('');

/* ------------------------------------------------------------ polling */
async function tick() {
  if (player && !player.useNative) {
    const s = player.snapshot();
    $('#sLevel').textContent = s.levelName ? `${s.levelName}${s.autoLevel ? '' : ' (manual)'}` : '—';
    $('#sEst').textContent = fmtKbps(s.throughputKbps);
    $('#sBuf').textContent = `${s.bufferSeconds.toFixed(1)} s`;
    $('#sStart').textContent = s.startupMs ? `${s.startupMs} ms` : '—';
    $('#sSwitch').textContent = s.switches + (s.abandoned ? ` · ${s.abandoned} abandoned` : '');
    $('#sStall').textContent = s.stalls + (s.stalledMs ? ` · ${(s.stalledMs / 1000).toFixed(1)}s lost` : '');
    $('#sBytes').textContent = fmtMB(s.bytes);
    $('#badgeLevel').textContent = s.levelName || '—';
    $('#badgeKbps').textContent = s.throughputKbps ? fmtKbps(s.throughputKbps) : '';
    drawChart(s.samples);
  }
  try {
    const e = await (await fetch('/api/edge')).json();
    $('#eHit').textContent = `${e.hits} hit / ${e.misses} miss${e.requests ? ` · ${Math.round(e.hitRate * 100)}%` : ''}`;
    $('#eObj').textContent = e.objects;
    $('#eBytes').textContent = fmtMB(e.bytesServed);
    $('#eReq').textContent = e.requests;
  } catch {}
}
setInterval(tick, 500);

let tt; function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 3200); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ------------------------------------------------------------ boot */
(async () => {
  const id = await loadLibrary();
  const want = new URLSearchParams(location.search).get('v');
  if (want && videos.some((v) => v.id === want)) play(want);
  else if (id) play(id);
  tick();
})();
window.streamLab = { get player() { return player; }, get current() { return current; }, setShape, play, makeSample };

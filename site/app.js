/* Pixflow landing — pixel-flow hero canvas + clone-wave feed from data/waves.json. */
'use strict';

/* ---------------- pixel-flow hero canvas ----------------
   The logo is a pixel arrow: ambient pixels drift right, and every few
   seconds scattered pixels snap together into a pixel arrow that sweeps
   across the hero and dissolves. No particle-network + blobs (Specta /
   RYCORE already used those). */
(function pixelFlow() {
  var canvas = document.getElementById('pixel-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var W = 0, H = 0, dpr = 1;
  var px = [];       // ambient drifting pixels
  var arrows = [];   // assembling pixel arrows
  var nextArrowAt = 1200;

  // 10x6 pixel arrow, pointing right (shaft 2 rows + head).
  var ARROW = [
    '......XX..',
    '.......XXX',
    'XXXXXXXXXX',
    'XXXXXXXXXX',
    '.......XXX',
    '......XX..',
  ];
  var ARROW_CELLS = [];
  ARROW.forEach(function (row, y) {
    for (var x = 0; x < row.length; x++) {
      if (row[x] === 'X') ARROW_CELLS.push({ x: x, y: y, head: x >= 8 });
    }
  });

  function resize() {
    var rect = canvas.parentElement.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    W = Math.max(1, Math.floor(rect.width));
    H = Math.max(1, Math.floor(rect.height));
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seedAmbient();
  }
  function seedAmbient() {
    var count = Math.min(130, Math.floor((W * H) / 9000));
    px = [];
    for (var i = 0; i < count; i++) {
      px.push({
        x: Math.random() * W,
        y: Math.random() * H,
        s: 2 + Math.random() * 4,
        v: 0.08 + Math.random() * 0.35,
        wob: Math.random() * Math.PI * 2,
        wobSpd: 0.0004 + Math.random() * 0.001,
        cyan: Math.random() < 0.18,
        a: 0.05 + Math.random() * 0.16,
      });
    }
  }
  function spawnArrow(now) {
    var cell = 9 + Math.random() * 4; // pixel size of this arrow
    var ay = 40 + Math.random() * Math.max(1, H - 120);
    var ax = -ARROW[0].length * cell - 30;
    var cells = ARROW_CELLS.map(function (c) {
      return {
        tx: c.x, ty: c.y, head: c.head,
        sx: c.x + (Math.random() - 0.5) * 14,
        sy: c.y + (Math.random() - 0.5) * 10,
      };
    });
    arrows.push({
      born: now, x: ax, y: ay, cell: cell, cells: cells,
      assemble: 1400 + Math.random() * 600, // ms to snap together
      cruise: 2600 + Math.random() * 1200,  // ms sweeping across
      hue: Math.random() < 0.5,
    });
    if (arrows.length > 2) arrows.shift();
  }
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
  function draw(now) {
    ctx.clearRect(0, 0, W, H);
    // ambient pixels
    for (var i = 0; i < px.length; i++) {
      var p = px[i];
      if (!reduceMotion) {
        p.x += p.v;
        p.wob += p.wobSpd * 16;
        if (p.x > W + 8) { p.x = -8; p.y = Math.random() * H; }
      }
      var y = p.y + Math.sin(p.wob) * 6;
      ctx.fillStyle = p.cyan
        ? 'rgba(34, 211, 238, ' + p.a + ')'
        : 'rgba(190, 208, 255, ' + p.a + ')';
      ctx.fillRect(p.x, y, p.s, p.s);
    }
    // arrows
    for (var a = arrows.length - 1; a >= 0; a--) {
      var ar = arrows[a];
      var age = now - ar.born;
      var asm = Math.min(1, age / ar.assemble);
      var total = ar.assemble + ar.cruise;
      var fade = age > total - 700 ? Math.max(0, (total - age) / 700) : 1;
      // drift right the whole time; faster once assembled
      var speed = asm < 1 ? 0.03 : 0.22;
      if (!reduceMotion) ar.x += speed * 16;
      var e = easeOut(asm);
      for (var k = 0; k < ar.cells.length; k++) {
        var c = ar.cells[k];
        var cx = (c.sx + (c.tx - c.sx) * e) * ar.cell + ar.x;
        var cy = (c.sy + (c.ty - c.sy) * e) * ar.cell + ar.y;
        var alpha = (0.18 + 0.5 * e) * fade;
        ctx.fillStyle = c.head
          ? 'rgba(34, 211, 238, ' + Math.min(1, alpha + 0.15) + ')'
          : 'rgba(214, 226, 255, ' + alpha + ')';
        ctx.fillRect(cx, cy, ar.cell - 1.5, ar.cell - 1.5);
      }
      if (age > total || ar.x > W + 60) arrows.splice(a, 1);
    }
  }
  function tick(now) {
    if (now >= nextArrowAt) {
      spawnArrow(now);
      nextArrowAt = now + 3400 + Math.random() * 2600;
    }
    draw(now);
    requestAnimationFrame(tick);
  }
  window.addEventListener('resize', resize);
  resize();
  if (reduceMotion) {
    // one frozen frame: ambient pixels + one assembled arrow
    spawnArrow(0);
    arrows[0].born = -10000;
    arrows[0].x = W * 0.35;
    draw(performance.now());
  } else {
    requestAnimationFrame(tick);
  }
})();

/* ---------------- clone-wave feed ---------------- */
var FALLBACK_WAVES = {
  snapshot_at: '2026-11-19T04:55:00+00:00',
  waves: [
    {
      symbol: 'DCTY', status: 'CANONICAL', cohort_size: 17,
      canonical: { address: '0x00a1f2056608025f695fd7768a50430ca2bb5f1e', buy_count: 448, progress_bps: 10000, graduated: true },
      dead_clone_buys: 490, dead_clone_buys_first_count: 332,
      reasoning: 'Earliest launch + graduated — the market settled it. The first DCTY launched graduated; the 16 clones after it are dead ends.',
      clones: [],
    },
    {
      symbol: 'MEOW', status: 'CONTESTED', cohort_size: 8, canonical: null,
      dead_clone_buys: 891, dead_clone_buys_first_count: 891, max_progress_bps: 389,
      reasoning: '8 clones, no leader above 389 bps — we refuse to guess. Pixflow reverts every MEOW buy until one token clearly wins.',
      clones: [],
    },
  ],
};

function shortAddr(a) { return a ? a.slice(0, 6) + '…' + a.slice(-4) : '—'; }
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function pxRow(label, cls, n, check) {
  var cells = '';
  for (var i = 0; i < n; i++) cells += '<span class="px"></span>';
  return '<div class="px-row ' + cls + '"><span class="px-label">' + label + '</span>' + cells
    + (check ? '<span class="px-check">✓ locked</span>' : '') + '</div>';
}
function cloneRows(clones) {
  if (!clones || !clones.length) return '<div class="clone-row"><span style="color:var(--muted)">Clone list ships with the live keeper feed.</span></div>';
  return clones.map(function (c) {
    var pct = c.progress_bps == null ? 0 : Math.min(100, c.progress_bps / 100);
    var w = Math.max(2, pct);
    return '<div class="clone-row' + (c.graduated ? ' grad' : '') + '">'
      + '<code>' + esc(c.address) + '</code>'
      + '<span class="buys">' + c.buy_count + ' buys</span>'
      + '<span class="prog">' + (c.progress_bps == null ? '—' : (c.progress_bps / 100).toFixed(2) + '%')
      + '<span class="clone-bar"><i style="width:' + w + '%"></i></span></span></div>';
  }).join('');
}
function waveCard(w) {
  var isCanon = w.status === 'CANONICAL';
  var badge = isCanon
    ? '<span class="badge badge-canonical">✓ CANONICAL</span>'
    : w.status === 'CONTESTED'
      ? '<span class="badge badge-contested">⚠ CONTESTED</span>'
      : '<span class="badge badge-unresolved">UNRESOLVED</span>';
  var canonBlock = isCanon && w.canonical
    ? '<div class="wave-canon"><span class="lbl">Canonical token</span><code>' + esc(w.canonical.address) + '</code>'
      + '<button class="copy-btn" data-copy="' + esc(w.canonical.address) + '">Copy</button></div>'
    : '<div class="wave-canon"><span class="lbl">Canonical token</span><b style="color:var(--amber)">None — Pixflow reverts every ' + esc(w.symbol) + ' buy</b></div>';
  var deadNote = (w.dead_clone_buys_first_count && w.dead_clone_buys !== w.dead_clone_buys_first_count)
    ? ' (first count ' + w.dead_clone_buys_first_count + ' — still growing)'
    : '';
  var viz = isCanon
    ? pxRow('clones ×' + (w.cohort_size - 1), 'dissolve', 12, false)
      + pxRow('canonical', 'lock', 12, true)
    : pxRow('clones ×' + w.cohort_size, 'dissolve', 12, false)
      + pxRow('canonical', 'dissolve', 12, false);
  var maxProg = w.max_progress_bps != null
    ? '<div><b>' + (w.max_progress_bps / 100).toFixed(2) + '%</b><span>max progress — no leader</span></div>'
    : '<div><b>' + (w.canonical && w.canonical.graduated ? 'Yes' : 'No') + '</b><span>canonical graduated</span></div>';
  return '<article class="wave-card' + (isCanon ? '' : ' contested') + '">'
    + '<div class="wave-head"><div class="wave-symbol">$' + esc(w.symbol) + '</div>' + badge + '</div>'
    + '<div class="wave-stats">'
    + '<div><b>' + w.cohort_size + '</b><span>tokens sharing the symbol</span></div>'
    + '<div><b>' + w.dead_clone_buys + '</b><span>buys into dead clones' + deadNote + '</span></div>'
    + maxProg
    + '</div>'
    + '<div class="px-viz" aria-hidden="true">' + viz + '</div>'
    + canonBlock
    + '<p class="wave-reason"><b>Resolver reasoning:</b> ' + esc(w.reasoning) + '</p>'
    + '<details class="wave-clones"><summary>See the ' + (w.clones ? w.clones.length : 0) + ' clone' + (w.clones && w.clones.length === 1 ? '' : 's') + ' in this wave</summary>'
    + '<div style="margin-top:8px">' + cloneRows(w.clones) + '</div></details>'
    + '</article>';
}
function renderWaves(data) {
  var feed = document.getElementById('waves-feed');
  if (!feed) return;
  if (!data || !data.waves || !data.waves.length) {
    feed.innerHTML = '<div class="feed-loading">Wave feed unavailable — the snapshot could not be loaded.</div>';
    return;
  }
  feed.innerHTML = data.waves.map(waveCard).join('');
  var snap = document.getElementById('snapshot-date');
  if (snap && data.snapshot_at) {
    var d = new Date(data.snapshot_at);
    if (!isNaN(d.getTime())) {
      snap.textContent = d.toLocaleString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
      });
    }
  }
}
fetch('data/waves.json', { cache: 'no-cache' })
  .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
  .then(renderWaves)
  .catch(function () { renderWaves(FALLBACK_WAVES); })
  .finally(function () { window.__shotReady = true; });

/* copy buttons (event delegation — cards are rendered dynamically) */
document.addEventListener('click', function (e) {
  var btn = e.target.closest('[data-copy]');
  if (!btn) return;
  var text = btn.getAttribute('data-copy');
  function done() {
    var old = btn.textContent;
    btn.textContent = 'Copied ✓';
    setTimeout(function () { btn.textContent = old; }, 1600);
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
  } else { fallbackCopy(text); done(); }
});
function fallbackCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (err) { /* clipboard unavailable */ }
  document.body.removeChild(ta);
}

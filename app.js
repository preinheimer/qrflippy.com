// Animated QR rendering.
//
// Every dark square on screen is a "piece" with a floating position (x, y in
// module units) and a presence value `q` (0 = gone, 1 = fully drawn).
//
// When the text changes:
//   1. Pieces already on (or heading to) a square that stays dark keep going.
//   2. Every other piece is free. Free pieces are paired with squares that need
//      filling, nearest pairs first, and travel there.
//   3. Leftover free pieces slide into the nearest block that stays dark and
//      merge with it. Leftover empty squares get a copy that splits off the
//      nearest block that stays dark and slides over.
//   4. Only when nothing is in range does a piece fade or grow in/out.
// Pieces caught mid-move are simply re-paired from wherever they are.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const input = $('text');
  const canvas = $('qr');
  const status = $('status');
  const ctx = canvas.getContext('2d');

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const EASINGS = {
    smooth: (t) => t * t * (3 - 2 * t),
    linear: (t) => t,
    out: (t) => 1 - (1 - t) ** 3,
    in: (t) => t ** 3,
  };

  // ---- Config ----------------------------------------------------------------

  const config = {};
  const controls = {
    travel: { el: $('travel'), read: (el) => el.checked },
    maxTravel: { el: $('max-travel'), read: (el) => Number(el.value), out: $('max-travel-out'), fmt: (v) => `${v} squares` },
    perSquare: { el: $('per-square'), read: (el) => Number(el.value), out: $('per-square-out'), fmt: (v) => `+${v} ms` },
    path: { el: $('path'), read: (el) => el.value },
    split: { el: $('split'), read: (el) => el.checked },
    merge: { el: $('merge'), read: (el) => el.checked },
    strict: { el: $('strict'), read: (el) => el.checked },
    effect: { el: $('effect'), read: (el) => el.value },
    duration: { el: $('speed'), read: (el) => Number(el.value), out: $('speed-out'), fmt: (v) => `${v} ms` },
    easing: { el: $('easing'), read: (el) => el.value },
    origin: { el: $('origin'), read: (el) => el.value },
    cascade: { el: $('cascade'), read: (el) => Number(el.value), out: $('cascade-out'), fmt: (v) => `${v.toFixed(1)}×` },
    jitter: { el: $('jitter'), read: (el) => Number(el.value), out: $('jitter-out'), fmt: (v) => `${v} ms` },
    ecl: { el: $('ecl'), read: (el) => el.value, reencode: true },
    quiet: { el: $('quiet'), read: (el) => Number(el.value), out: $('quiet-out'), fmt: (v) => `${v} modules` },
    dark: { el: $('dark'), read: (el) => el.value },
    light: { el: $('light'), read: (el) => el.value },
  };

  function readConfig() {
    for (const [name, c] of Object.entries(controls)) {
      config[name] = c.read(c.el);
      if (c.out) c.out.textContent = c.fmt(config[name]);
    }
  }

  function duration() {
    return reducedMotion.matches ? 0 : config.duration;
  }

  // ---- Stats -----------------------------------------------------------------

  const emptyCounts = () => ({
    changed: 0, toDark: 0, toLight: 0,
    travel: 0, split: 0, merge: 0, distance: 0, longest: 0,
    fade: 0, grow: 0, redirected: 0,
  });
  let last = { ...emptyCounts(), version: '–' };
  let total = { ...emptyCounts(), updates: 0 };
  let moving = 0;

  const statEls = document.querySelectorAll('[data-stat]');
  function renderStats() {
    const derive = (s) => ({ ...s, sliding: s.travel + s.split + s.merge, other: s.fade + s.grow });
    const groups = { last: derive(last), total: derive(total), live: { moving } };
    for (const el of statEls) {
      const [group, name] = el.dataset.stat.split('.');
      const v = groups[group][name];
      el.textContent = typeof v === 'number' ? Math.round(v).toLocaleString() : v;
    }
  }

  // ---- Animation state -------------------------------------------------------

  // piece: { x, y, r, c (destination), traveling, sx, sy, start, dur, merge,
  //          q, qTarget, qEffect, qStart }
  let pieces = [];
  let targets = null;      // Uint8Array of the current code, size*size
  let targetSize = 0;      // module count of the current code
  let shownSize = 21;      // animated module count used for scaling
  let sizeFrom = 21, sizeStart = 0;
  let lastFrame = 0, rafId = 0;

  // Delay grows with distance from the chosen origin, 0 at the origin and 1 at the far side.
  function cascadeDelay(r, c, size) {
    const n = Math.max(1, size - 1);
    let t;
    switch (config.origin) {
      case 'tl': t = (r + c) / (2 * n); break;
      case 'tr': t = (r + (n - c)) / (2 * n); break;
      case 'bl': t = ((n - r) + c) / (2 * n); break;
      case 'br': t = ((n - r) + (n - c)) / (2 * n); break;
      case 'center': t = (Math.abs(r - n / 2) + Math.abs(c - n / 2)) / n; break;
      default: t = 0;
    }
    return Math.min(1, Math.max(0, t)) * duration() * config.cascade + Math.random() * config.jitter;
  }

  // Nearest cell (Manhattan distance 1..maxDist) around (r, c) where ok(r, c) holds; ties broken randomly.
  function nearest(r, c, size, maxDist, ok) {
    for (let d = 1; d <= maxDist; d++) {
      const found = [];
      for (let dr = -d; dr <= d; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= size) continue;
        const dc = d - Math.abs(dr);
        for (const cc of dc ? [c - dc, c + dc] : [c]) {
          if (cc >= 0 && cc < size && ok(rr, cc)) found.push([rr, cc]);
        }
      }
      if (found.length) return found[Math.floor(Math.random() * found.length)];
    }
    return null;
  }

  function fallbackEffect() {
    if (config.effect === 'mixed') return Math.random() < 0.5 ? 'fade' : 'grow';
    return config.effect;
  }

  function travelDuration(dist) {
    return duration() + config.perSquare * Math.max(0, dist - 1);
  }

  function startTravel(p, r, c, start) {
    p.sx = p.x;
    p.sy = p.y;
    p.r = r;
    p.c = c;
    p.start = start;
    p.dur = travelDuration(Math.abs(p.x - c) + Math.abs(p.y - r));
    p.traveling = true;
  }

  function update() {
    const text = input.value;
    let modules = null;
    if (text) {
      try {
        modules = QR.encode(text, config.ecl).modules;
      } catch (e) {
        status.textContent = 'Too long to fit in a QR code.';
        return;
      }
    }

    const size = modules ? modules.length : 0;
    const isDark = (r, c) => r >= 0 && c >= 0 && r < size && c < size && modules[r][c];
    const version = (n) => (n ? (n - 17) / 4 : '–');
    status.textContent = modules ? `Version ${version(size)} · ${size}×${size}` : '';

    const counts = emptyCounts();
    counts.version = targetSize !== size ? `${version(targetSize)} → ${version(size)}` : String(version(size));
    const addMove = (kind, dist) => {
      counts[kind]++;
      counts.distance += dist;
      counts.longest = Math.max(counts.longest, dist);
    };

    // Blocks changed, compared against the previous code
    const wasDark = (r, c) => r < targetSize && c < targetSize && targets[r * targetSize + c] === 1;
    const span = Math.max(size, targetSize);
    for (let r = 0; r < span; r++) {
      for (let c = 0; c < span; c++) {
        const before = wasDark(r, c), after = isDark(r, c);
        if (before !== after) counts[after ? 'toDark' : 'toLight']++;
      }
    }
    counts.changed = counts.toDark + counts.toLight;

    const now = performance.now();
    const cascadeSize = Math.max(size, Math.round(shownSize));
    if (size && size !== targetSize) {
      sizeFrom = shownSize;
      sizeStart = now;
    }
    targetSize = size;
    targets = new Uint8Array(size * size);
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (modules[r][c]) targets[r * size + c] = 1;

    // Solid pieces sitting on their square before anything new starts moving
    const solidBefore = new Uint8Array(size * size);
    for (const p of pieces) {
      if (!p.traveling && p.q === 1 && p.qTarget === 1 && p.r < size && p.c < size) solidBefore[p.r * size + p.c] = 1;
    }

    // 1. Keep pieces whose destination is still dark
    const filled = new Uint8Array(size * size);
    const free = [];
    for (const p of pieces) {
      const idx = p.r * size + p.c;
      if (!p.merge && p.qTarget === 1 && isDark(p.r, p.c) && !filled[idx]) filled[idx] = 1;
      else free.push(p);
    }

    // 2. Pair free pieces with empty target squares, nearest first
    const openIndex = new Int32Array(size * size).fill(-1);
    const open = [];
    for (let i = 0; i < size * size; i++) {
      if (targets[i] && !filled[i]) {
        openIndex[i] = open.length;
        open.push({ r: Math.floor(i / size), c: i % size, taken: false });
      }
    }

    const R = config.travel ? config.maxTravel : 0;
    const candidates = [];
    if (R && open.length && free.length) {
      free.forEach((p, pi) => {
        const pr = Math.round(p.y), pc = Math.round(p.x);
        for (let dr = -R; dr <= R; dr++) {
          const r = pr + dr;
          if (r < 0 || r >= size) continue;
          const reach = R - Math.abs(dr);
          for (let dc = -reach; dc <= reach; dc++) {
            const c = pc + dc;
            if (c < 0 || c >= size) continue;
            const oi = openIndex[r * size + c];
            if (oi < 0) continue;
            const dist = Math.abs(p.x - c) + Math.abs(p.y - r);
            if (dist <= R) candidates.push({ dist: dist + Math.random() * 0.01, pi, oi });
          }
        }
      });
      candidates.sort((a, b) => a.dist - b.dist);
    }

    const matched = new Array(free.length).fill(null);
    for (const { pi, oi } of candidates) {
      if (matched[pi] || open[oi].taken) continue;
      matched[pi] = open[oi];
      open[oi].taken = true;
    }

    const freeSet = new Set(free);
    const survivors = pieces.filter((p) => !freeSet.has(p));
    free.forEach((p, pi) => {
      const wasMoving = p.traveling || p.q !== p.qTarget;
      const pr = Math.round(p.y), pc = Math.round(p.x);
      const dest = matched[pi];
      survivors.push(p);

      if (dest) {
        const dist = Math.abs(p.x - dest.c) + Math.abs(p.y - dest.r);
        p.merge = false;
        if (p.qTarget !== 1) {
          // It was on its way out; bring it back while it moves
          p.qTarget = 1;
          p.qEffect = 'fade';
          p.qStart = now;
        }
        if (dist > 0) startTravel(p, dest.r, dest.c, wasMoving ? now : now + cascadeDelay(pr, pc, cascadeSize));
        else Object.assign(p, { r: dest.r, c: dest.c, traveling: false }); // already there, e.g. hadn't left yet
        if (wasMoving) counts.redirected++;
        else addMove('travel', dist);
        return;
      }

      // 3a. Nothing needs this piece: slide into the nearest block that stays dark
      const into = config.merge && R ? nearest(pr, pc, size, R, (r, c) => targets[r * size + c] === 1) : null;
      if (into && p.qTarget !== 0) {
        p.merge = true;
        startTravel(p, into[0], into[1], wasMoving ? now : now + cascadeDelay(pr, pc, cascadeSize));
        if (wasMoving) counts.redirected++;
        else addMove('merge', Math.abs(p.x - into[1]) + Math.abs(p.y - into[0]));
        return;
      }

      // 4a. Nothing in range: disappear in place
      if (p.qTarget !== 0) {
        p.merge = false;
        p.qTarget = 0;
        p.qEffect = fallbackEffect();
        p.qStart = p.q === 1 && !p.traveling ? now + cascadeDelay(pr, pc, cascadeSize) : now;
        counts[p.qEffect]++;
      }
    });

    // 3b. Squares nobody could reach: split a copy off the nearest block that stays dark
    const isSource = (r, c) => solidBefore[r * size + c] === 1 && (!config.strict || targets[r * size + c] === 1);
    const splitRange = config.split ? Math.max(R, 1) : 0;
    for (const o of open) {
      if (o.taken) continue;
      const from = splitRange ? nearest(o.r, o.c, size, splitRange, isSource) : null;
      if (from) {
        const p = { x: from[1], y: from[0], q: 1, qTarget: 1, merge: false };
        startTravel(p, o.r, o.c, now + cascadeDelay(from[0], from[1], cascadeSize));
        survivors.push(p);
        addMove('split', Math.abs(from[0] - o.r) + Math.abs(from[1] - o.c));
        continue;
      }
      // 4b. Nothing in range: appear in place
      const qEffect = fallbackEffect();
      survivors.push({
        x: o.c, y: o.r, r: o.r, c: o.c, traveling: false, merge: false,
        q: 0, qTarget: 1, qEffect, qStart: now + cascadeDelay(o.r, o.c, cascadeSize),
      });
      counts[qEffect]++;
    }
    pieces = survivors;

    last = counts;
    total.updates++;
    for (const k of Object.keys(emptyCounts())) {
      total[k] = k === 'longest' ? Math.max(total[k], counts[k]) : total[k] + counts[k];
    }

    if (duration() === 0) settleAll();
    renderStats();
    kick();
  }

  function settleAll() {
    for (const p of pieces) {
      p.x = p.c;
      p.y = p.r;
      p.traveling = false;
      p.q = p.merge ? 0 : p.qTarget;
    }
    pieces = pieces.filter((p) => p.q > 0);
    if (targetSize) shownSize = targetSize;
  }

  function kick() {
    if (!rafId) {
      lastFrame = performance.now();
      rafId = requestAnimationFrame(frame);
    }
  }

  function advanceTravel(p, now, ease) {
    if (now < p.start) return;
    const t = p.dur ? Math.min(1, (now - p.start) / p.dur) : 1;
    const e = ease(t);
    const dx = p.c - p.sx, dy = p.r - p.sy;
    if (config.path === 'straight') {
      p.x = p.sx + dx * e;
      p.y = p.sy + dy * e;
    } else {
      // L-shaped path: first leg along one axis, then the other
      const horizontalFirst = config.path === 'hv';
      const first = horizontalFirst ? Math.abs(dx) : Math.abs(dy);
      const d = e * (Math.abs(dx) + Math.abs(dy));
      const a = Math.min(d, first), b = Math.max(0, d - first);
      if (horizontalFirst) {
        p.x = p.sx + Math.sign(dx) * a;
        p.y = p.sy + Math.sign(dy) * b;
      } else {
        p.y = p.sy + Math.sign(dy) * a;
        p.x = p.sx + Math.sign(dx) * b;
      }
    }
    if (t === 1) {
      p.x = p.c;
      p.y = p.r;
      p.traveling = false;
      if (p.merge) p.q = p.qTarget = 0; // absorbed into the block underneath
    }
  }

  function frame(now) {
    const dt = now - lastFrame;
    lastFrame = now;
    const dur = duration();
    const ease = EASINGS[config.easing];
    let animating = false;

    // Smoothly rescale when the QR version changes
    if (shownSize !== targetSize && targetSize) {
      const t = dur ? Math.min(1, (now - sizeStart) / dur) : 1;
      shownSize = sizeFrom + (targetSize - sizeFrom) * ease(t);
      if (t < 1) animating = true;
      else shownSize = targetSize;
    }

    let inMotion = 0;
    for (const p of pieces) {
      if (p.traveling) advanceTravel(p, now, ease);
      if (p.q !== p.qTarget && now >= p.qStart) {
        const step = dur ? dt / dur : 1;
        p.q = p.qTarget > p.q ? Math.min(1, p.q + step) : Math.max(0, p.q - step);
      }
      if (p.traveling || p.q !== p.qTarget) {
        inMotion++;
        animating = true;
      }
    }
    pieces = pieces.filter((p) => p.q > 0 || p.qTarget > 0);

    draw();
    if (inMotion !== moving) {
      moving = inMotion;
      renderStats();
    }
    rafId = animating ? requestAnimationFrame(frame) : 0;
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(canvas.clientWidth * dpr);
    if (canvas.width !== px || canvas.height !== px) {
      canvas.width = px;
      canvas.height = px;
    }

    ctx.fillStyle = config.light;
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = config.dark;
    const ease = EASINGS[config.easing];
    const s = px / (shownSize + config.quiet * 2);
    const origin = config.quiet * s;
    // Snap edges to whole pixels so adjacent dark modules don't show seams.
    const edge = (i) => Math.round(origin + i * s);

    for (const p of pieces) {
      if (p.q <= 0) continue;
      const x0 = edge(p.x), x1 = edge(p.x + 1);
      const y0 = edge(p.y), y1 = edge(p.y + 1);
      const w = x1 - x0, h = y1 - y0;

      if (p.q >= 1) {
        ctx.fillRect(x0, y0, w, h);
      } else if (p.qEffect === 'grow') {
        const e = ease(p.q), gw = w * e, gh = h * e;
        ctx.fillRect(x0 + (w - gw) / 2, y0 + (h - gh) / 2, gw, gh);
      } else {
        ctx.globalAlpha = ease(p.q);
        ctx.fillRect(x0, y0, w, h);
        ctx.globalAlpha = 1;
      }
    }
  }

  for (const c of Object.values(controls)) {
    c.el.addEventListener('input', () => {
      readConfig();
      if (c.reencode) update();
      else draw();
    });
  }
  $('reset').addEventListener('click', () => {
    total = { ...emptyCounts(), updates: 0 };
    renderStats();
  });
  input.addEventListener('input', update);
  new ResizeObserver(() => draw()).observe(canvas);

  readConfig();
  update();
})();

/* Cube 3D – a physical-feeling Rubik's Cube built with CSS 3D transforms.
 *
 * Coordinates are CSS coordinates: x → right, y → down, z → toward the viewer.
 * Every cubie keeps an integer position (-1..1 per axis) and an integer 3x3
 * orientation matrix, so moves are exact and never drift.
 * A move is {axis, layer, q}: turn the slice where pos[axis] === layer by q
 * quarter-turns about +axis (positive = the CSS rotate3d direction).
 */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const DEG = Math.PI / 180;

  /* ---------------------------------------------------------------- data */

  // Face order doubles as colour id. n = outward normal in cubie-local space.
  const FACES = [
    { id: 'U', n: [0, -1, 0] },
    { id: 'D', n: [0, 1, 0] },
    { id: 'F', n: [0, 0, 1] },
    { id: 'B', n: [0, 0, -1] },
    { id: 'R', n: [1, 0, 0] },
    { id: 'L', n: [-1, 0, 0] },
  ];

  // Clockwise (seen from outside the face) = +90° about the outward normal.
  const MOVES = {
    U: { axis: 1, layer: -1, q: -1 },
    D: { axis: 1, layer: 1, q: 1 },
    R: { axis: 0, layer: 1, q: 1 },
    L: { axis: 0, layer: -1, q: -1 },
    F: { axis: 2, layer: 1, q: 1 },
    B: { axis: 2, layer: -1, q: -1 },
    M: { axis: 0, layer: 0, q: -1 }, // follows L
    E: { axis: 1, layer: 0, q: 1 },  // follows D
    S: { axis: 2, layer: 0, q: 1 },  // follows F
  };

  function parseMove(str) {
    const m = { ...MOVES[str[0]] };
    if (str[1] === "'") m.q = -m.q;
    else if (str[1] === '2') m.q *= 2;
    return m;
  }
  const inverse = (m) => ({ ...m, q: -m.q });

  function moveName(m) {
    for (const k in MOVES) {
      const b = MOVES[k];
      if (b.axis === m.axis && b.layer === m.layer) {
        const r = m.q / b.q;
        return k + (Math.abs(r) === 2 ? '2' : r < 0 ? "'" : '');
      }
    }
    return '';
  }

  /* ---------------------------------------------------------------- math */

  const ident = () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

  function rotMat(axis, q) {
    const a = q * Math.PI / 2;
    const c = Math.round(Math.cos(a)) || 0;
    const s = Math.round(Math.sin(a)) || 0;
    const i = (axis + 1) % 3, j = (axis + 2) % 3;
    const R = ident();
    R[i][i] = c; R[i][j] = -s || 0;
    R[j][i] = s; R[j][j] = c;
    return R;
  }
  function mul(A, B) {
    const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        for (let k = 0; k < 3; k++) out[i][j] += A[i][k] * B[k][j];
    return out;
  }
  const apply = (R, v) => [0, 1, 2].map((r) => R[r][0] * v[0] + R[r][1] * v[1] + R[r][2] * v[2]);
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];

  const easeInOut = (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeOutBack = (t) => { const c1 = 1.2, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };

  const animate = (from, to, dur, ease, onUpdate, onDone) => {
    const t0 = performance.now();
    const step = (t) => {
      const p = dur <= 0 ? 1 : Math.min(1, (t - t0) / dur);
      onUpdate(from + (to - from) * ease(p));
      if (p < 1) requestAnimationFrame(step); else onDone && onDone();
    };
    requestAnimationFrame(step);
  };

  /* ------------------------------------------------------------- DOM refs */

  const root = document.documentElement;
  const stage = $('#stage');
  const cubeEl = $('#cube');
  const dock = $('#dock');
  const movesEl = $('#moves');
  const timerEl = $('#timer');
  const bestEl = $('#best');
  const lastEl = $('#last');
  const hintEl = $('#hint');
  const toastEl = $('#toast');
  const confettiEl = $('#confetti');
  const btn = {
    scramble: $('#scrambleBtn'), solve: $('#solveBtn'), undo: $('#undoBtn'),
    redo: $('#redoBtn'), reset: $('#resetBtn'), pad: $('#padBtn'),
  };
  const speedEl = $('#speed');
  const soundEl = $('#sound');
  const helpEl = $('#help');

  /* ---------------------------------------------------------------- state */

  const cubies = [];
  let size = 90;
  let rx = -28, ry = -38, zoom = 1;          // camera
  let layerAnim = null;                      // {axis, layer, angle}

  const queue = [];
  let busy = false;                          // an animation / drag-turn is running
  let lock = false;                          // scramble / auto-solve in progress
  let pendingKind = null;
  let history = [];                          // [{m, user}]
  let redoStack = [];
  let moves = 0;
  let phase = 'fresh';                       // 'fresh' | 'scrambled'
  let timerStart = null;
  let soundOn = true;

  function store(key, val) { try { localStorage.setItem(key, val); } catch (_) {} }
  function load(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }

  /* ---------------------------------------------------------------- build */

  function build() {
    cubeEl.innerHTML = '';
    cubies.length = 0;
    for (let x = -1; x <= 1; x++)
      for (let y = -1; y <= 1; y++)
        for (let z = -1; z <= 1; z++) {
          const el = document.createElement('div');
          el.className = 'cubie';
          const c = { pos: [x, y, z], home: [x, y, z], M: ident(), el, stickers: [] };
          const idx = cubies.length;
          FACES.forEach((f, fi) => {
            const outer = f.n.some((v, k) => v !== 0 && v === c.pos[k]);
            const face = document.createElement('div');
            face.className = 'face ' + f.id + (outer ? '' : ' inner');
            if (outer) {
              face.dataset.f = fi;
              face.dataset.c = idx;
              const st = document.createElement('i');
              st.className = 'sticker';
              face.appendChild(st);
              c.stickers.push(fi);
            }
            el.appendChild(face);
          });
          cubies.push(c);
          cubeEl.appendChild(el);
        }
    renderAll();
  }

  function resetCubies() {
    cubies.forEach((c) => { c.pos = c.home.slice(); c.M = ident(); });
    renderAll();
  }

  /* --------------------------------------------------------------- render */

  function cubieTransform(c) {
    const M = c.M, S = size;
    let t = `matrix3d(${M[0][0]},${M[1][0]},${M[2][0]},0,` +
            `${M[0][1]},${M[1][1]},${M[2][1]},0,` +
            `${M[0][2]},${M[1][2]},${M[2][2]},0,` +
            `${c.pos[0] * S},${c.pos[1] * S},${c.pos[2] * S},1)`;
    if (layerAnim && c.pos[layerAnim.axis] === layerAnim.layer) {
      const v = [0, 0, 0]; v[layerAnim.axis] = 1;
      t = `rotate3d(${v[0]},${v[1]},${v[2]},${layerAnim.angle}deg) ` + t;
    }
    return t;
  }

  function renderAll() {
    for (const c of cubies) c.el.style.transform = cubieTransform(c);
  }

  function renderCamera() {
    cubeEl.style.transform = `rotateX(${rx}deg) rotateY(${ry}deg) scale(${zoom})`;
  }

  function fit() {
    const w = stage.clientWidth, h = stage.clientHeight;
    size = Math.max(40, Math.min(112, Math.floor(Math.min(w / 4.4, h / 3.9))));
    root.style.setProperty('--s', size + 'px');
    renderAll();
  }

  /* ----------------------------------------------------------- move engine */

  function commit(axis, layer, q) {
    const R = rotMat(axis, q);
    for (const c of cubies) {
      if (c.pos[axis] === layer) {
        c.pos = apply(R, c.pos);
        c.M = mul(R, c.M);
      }
    }
  }

  function turnDuration(e) {
    const speed = +speedEl.value;
    let d = e.dur != null ? e.dur : 700 - 60 * speed;
    if (e.dur == null && queue.length > 3) d *= 0.6;
    return d * (Math.abs(e.m.q) === 2 ? 1.35 : 1);
  }

  function runMove(e, done) {
    const { axis, layer, q } = e.m;
    layerAnim = { axis, layer, angle: 0 };
    animate(0, q * 90, turnDuration(e), easeInOut, (a) => {
      layerAnim.angle = a;
      renderAll();
    }, () => {
      commit(axis, layer, q);
      layerAnim = null;
      renderAll();
      done();
    });
  }

  function pump() {
    if (busy) return;
    const e = queue.shift();
    if (!e) { onIdle(); return; }
    busy = true;
    updateUI();
    runMove(e, () => {
      busy = false;
      afterMove(e);
      pump();
    });
  }

  function afterMove(e) {
    switch (e.kind) {
      case 'user':
        history.push({ m: e.m, user: true });
        redoStack.length = 0;
        moves++;
        if (phase === 'scrambled' && timerStart === null) timerStart = performance.now();
        flashLast(e.m);
        break;
      case 'scramble':
        history.push({ m: e.m, user: false });
        break;
      case 'undo':
        if (e.entry.user) moves = Math.max(0, moves - 1);
        history.pop();
        redoStack.push(e.entry);
        flashLast(e.m);
        break;
      case 'redo':
        history.push(e.entry);
        if (e.entry.user) moves++;
        flashLast(e.m);
        break;
      case 'auto':
        history.pop();
        break;
    }
    if (e.kind !== 'scramble' && e.kind !== 'auto') click();
    updateUI();
  }

  function onIdle() {
    lock = false;
    if (pendingKind === 'scramble') {
      phase = 'scrambled';
      moves = 0;
      timerStart = null;
      redoStack.length = 0;
      showTimer(0);
      toast('Cube scrambled', 'Your timer starts on your first move', 1800);
    } else if (pendingKind === 'auto') {
      phase = 'fresh';
      moves = 0;
      timerStart = null;
      history = [];
      redoStack.length = 0;
      showTimer(0);
    } else if (phase === 'scrambled' && moves > 0 && isSolved()) {
      win();
    }
    pendingKind = null;
    updateUI();
  }

  /* -------------------------------------------------------------- commands */

  function userMove(str) {
    if (lock) return;
    hideHint();
    queue.push({ m: parseMove(str), kind: 'user' });
    pump();
  }

  function scramble() {
    if (busy || queue.length || lock) return;
    hideHint();
    history = []; redoStack = []; moves = 0; timerStart = null;
    showTimer(0);
    lock = true; pendingKind = 'scramble';
    const faces = 'UDLRFB';
    let last = '';
    for (let i = 0; i < 24; i++) {
      let f;
      do { f = faces[Math.floor(Math.random() * 6)]; } while (f === last);
      last = f;
      const suffix = ['', "'", '2'][Math.floor(Math.random() * 3)];
      queue.push({ m: parseMove(f + suffix), kind: 'scramble', dur: 80 });
    }
    pump();
  }

  function autoSolve() {
    if (busy || queue.length || lock || !history.length) return;
    lock = true; pendingKind = 'auto';
    timerStart = null;
    const seq = history.slice().reverse();
    seq.forEach((h) => queue.push({ m: inverse(h.m), kind: 'auto', dur: Math.max(70, 150 - seq.length * 2) }));
    pump();
  }

  function undo() {
    if (busy || queue.length || lock || !history.length) return;
    const entry = history[history.length - 1];
    queue.push({ m: inverse(entry.m), kind: 'undo', entry });
    pump();
  }

  function redo() {
    if (busy || queue.length || lock || !redoStack.length) return;
    const entry = redoStack.pop();
    queue.push({ m: entry.m, kind: 'redo', entry });
    pump();
  }

  function resetCube() {
    if (busy || queue.length || lock) return;
    resetCubies();
    history = []; redoStack = []; moves = 0; phase = 'fresh'; timerStart = null;
    showTimer(0);
    cubeEl.classList.remove('pop');
    void cubeEl.offsetWidth;
    cubeEl.classList.add('pop');
    click();
    updateUI();
  }

  /* ---------------------------------------------------------------- solved */

  function isSolved() {
    const seen = new Map();
    for (const c of cubies) {
      for (const fi of c.stickers) {
        const key = apply(c.M, FACES[fi].n).join(',');
        if (seen.has(key)) { if (seen.get(key) !== fi) return false; }
        else seen.set(key, fi);
      }
    }
    return true;
  }

  function win() {
    const t = performance.now() - (timerStart ?? performance.now());
    const hadTimer = timerStart !== null;
    timerStart = null;
    phase = 'fresh';
    showTimer(t);
    let sub = `${moves} moves`;
    if (hadTimer) {
      sub += ` · ${fmt(t)}`;
      const best = parseFloat(load('cube3d.best'));
      if (!best || t < best) { store('cube3d.best', String(t)); bestEl.textContent = fmt(t); sub += ' · new best!'; }
    }
    toast('Solved! 🎉', sub, 4200);
    confetti();
  }

  /* ------------------------------------------------------------------- UI */

  function fmt(ms) {
    const total = Math.floor(ms / 100);
    const tenth = total % 10;
    const secs = Math.floor(total / 10) % 60;
    const mins = Math.floor(total / 600);
    return `${mins}:${String(secs).padStart(2, '0')}.${tenth}`;
  }
  const showTimer = (ms) => { timerEl.textContent = fmt(ms); };

  setInterval(() => { if (timerStart !== null) showTimer(performance.now() - timerStart); }, 50);

  function updateUI() {
    movesEl.textContent = moves;
    const idle = !busy && !queue.length && !lock;
    btn.scramble.disabled = !idle;
    btn.reset.disabled = !idle;
    btn.undo.disabled = !idle || !history.length;
    btn.redo.disabled = !idle || !redoStack.length;
    btn.solve.disabled = !idle || !history.length;
  }

  let toastTimer;
  function toast(title, sub, ms) {
    toastEl.innerHTML = `${title}${sub ? `<small>${sub}</small>` : ''}`;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms || 2000);
  }

  function flashLast(m) {
    lastEl.textContent = moveName(m).replace("'", '′');
    lastEl.classList.remove('show');
    void lastEl.offsetWidth;
    lastEl.classList.add('show');
  }

  function hideHint() { hintEl.classList.add('hide'); }

  function confetti() {
    const colors = ['#f4f4f2', '#ffd300', '#00a14b', '#0051ba', '#c41e3a', '#ff5800'];
    for (let i = 0; i < 70; i++) {
      const p = document.createElement('i');
      p.style.left = Math.random() * 100 + '%';
      p.style.background = colors[i % colors.length];
      p.style.setProperty('--dx', (Math.random() * 160 - 80) + 'px');
      p.style.setProperty('--rot', (Math.random() * 900 - 450) + 'deg');
      p.style.animationDuration = 1.8 + Math.random() * 1.6 + 's';
      p.style.animationDelay = Math.random() * .5 + 's';
      confettiEl.appendChild(p);
      setTimeout(() => p.remove(), 4200);
    }
  }

  /* ----------------------------------------------------------------- audio */

  let actx;
  function click() {
    if (soundOn) {
      try {
        actx = actx || new (window.AudioContext || window.webkitAudioContext)();
        if (actx.state === 'suspended') actx.resume();
        const t = actx.currentTime;
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = 'triangle';
        o.frequency.setValueAtTime(230 + Math.random() * 70, t);
        o.frequency.exponentialRampToValueAtTime(90, t + .06);
        g.gain.setValueAtTime(.13, t);
        g.gain.exponentialRampToValueAtTime(.001, t + .09);
        o.connect(g); g.connect(actx.destination);
        o.start(t); o.stop(t + .1);
      } catch (_) { /* audio unavailable */ }
    }
    if (soundOn && navigator.vibrate) navigator.vibrate(6);
  }

  /* ------------------------------------------------------------- pointers */

  const pointers = new Map();
  let gesture = null;
  let inertia = 0;

  const pinchDist = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  // World vector → screen (x, y) for the current camera.
  function toScreen(v) {
    const a = ry * DEG, b = rx * DEG;
    const x1 = v[0] * Math.cos(a) + v[2] * Math.sin(a);
    const z1 = -v[0] * Math.sin(a) + v[2] * Math.cos(a);
    const y2 = v[1] * Math.cos(b) - z1 * Math.sin(b);
    return [x1, y2];
  }

  function clampCamera() { rx = Math.max(-89, Math.min(89, rx)); }

  stage.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    cancelAnimationFrame(inertia);
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (actx && actx.state === 'suspended') actx.resume();

    if (pointers.size === 2) {
      gesture = { type: 'pinch', d0: pinchDist(), z0: zoom };
      return;
    }
    const face = e.target.closest && e.target.closest('.face[data-f]');
    if (face && !busy && !lock && !queue.length) {
      gesture = { type: 'maybe', cubie: +face.dataset.c, f: +face.dataset.f, sx: e.clientX, sy: e.clientY };
    } else {
      gesture = { type: 'orbit', lx: e.clientX, ly: e.clientY, vx: 0, vy: 0, t: performance.now() };
    }
  });

  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId) || !gesture) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (gesture.type === 'pinch') {
      if (pointers.size >= 2) {
        zoom = Math.max(.55, Math.min(1.9, gesture.z0 * pinchDist() / gesture.d0));
        renderCamera();
      }
      return;
    }

    if (gesture.type === 'orbit') {
      const dx = e.clientX - gesture.lx, dy = e.clientY - gesture.ly;
      gesture.lx = e.clientX; gesture.ly = e.clientY;
      ry += dx * .45; rx -= dy * .45;
      clampCamera();
      gesture.vy = dx * .45; gesture.vx = -dy * .45;
      gesture.t = performance.now();
      renderCamera();
      hideHint();
      return;
    }

    if (gesture.type === 'maybe') {
      const dx = e.clientX - gesture.sx, dy = e.clientY - gesture.sy;
      if (Math.hypot(dx, dy) < 7) return;
      beginTurn(gesture, dx, dy);
    }
    if (gesture.type === 'turn') updateTurn(gesture, e);
  });

  function beginTurn(g, dx, dy) {
    const c = cubies[g.cubie];
    const n = apply(c.M, FACES[g.f].n);
    const nAxis = n.findIndex((v) => v !== 0);
    const p = [c.pos[0] + n[0] * .5, c.pos[1] + n[1] * .5, c.pos[2] + n[2] * .5];
    let best = null;
    for (let k = 0; k < 3; k++) {
      if (k === nAxis) continue;
      const a = [0, 0, 0]; a[k] = 1;
      const sv = toScreen(cross(a, p));          // screen motion for a +turn about axis k
      const d = sv[0] * dx + sv[1] * dy;
      if (!best || Math.abs(d) > Math.abs(best.d)) best = { k, sv, d };
    }
    const mag = Math.hypot(best.sv[0], best.sv[1]) || 1;
    g.type = 'turn';
    g.k = best.k;
    g.layer = c.pos[best.k];
    g.dir = [best.sv[0] / mag, best.sv[1] / mag];
    g.angle = 0; g.vel = 0; g.t = null;
    busy = true;
    layerAnim = { axis: g.k, layer: g.layer, angle: 0 };
    hideHint();
    updateUI();
  }

  function updateTurn(g, e) {
    const proj = (e.clientX - g.sx) * g.dir[0] + (e.clientY - g.sy) * g.dir[1];
    const ang = Math.max(-200, Math.min(200, proj * (55 / (size * zoom))));
    const now = performance.now();
    if (g.t !== null) {
      const dt = now - g.t;
      if (dt > 0) g.vel = .6 * g.vel + .4 * ((ang - g.angle) / dt);
    }
    g.t = now;
    g.angle = ang;
    layerAnim.angle = ang;
    renderAll();
  }

  function releaseTurn(g) {
    const stale = performance.now() - (g.t || 0) > 90;
    const vel = stale ? 0 : g.vel;
    let turns = Math.round((g.angle + vel * 130) / 90);
    if (turns === 0 && Math.abs(g.angle) > 24) turns = Math.sign(g.angle);
    turns = Math.max(-2, Math.min(2, turns));
    const from = g.angle, to = turns * 90;
    animate(from, to, 170 + Math.abs(to - from) * 3, easeOutBack, (a) => {
      layerAnim.angle = a;
      renderAll();
    }, () => {
      if (turns) commit(g.k, g.layer, turns);
      layerAnim = null;
      renderAll();
      busy = false;
      if (turns) afterMove({ m: { axis: g.k, layer: g.layer, q: turns }, kind: 'user' });
      pump();
    });
  }

  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    const g = gesture;
    if (!g) return;
    if (g.type === 'pinch') { if (pointers.size < 2) gesture = null; return; }
    gesture = null;
    if (g.type === 'turn') releaseTurn(g);
    else if (g.type === 'orbit' && performance.now() - g.t < 80) startInertia(g.vx, g.vy);
  }
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);

  function startInertia(vx, vy) {
    const step = () => {
      vx *= .94; vy *= .94;
      if (Math.abs(vx) < .02 && Math.abs(vy) < .02) return;
      ry += vy; rx += vx; clampCamera(); renderCamera();
      inertia = requestAnimationFrame(step);
    };
    inertia = requestAnimationFrame(step);
  }

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoom = Math.max(.55, Math.min(1.9, zoom * (1 - e.deltaY * .0012)));
    renderCamera();
  }, { passive: false });

  /* -------------------------------------------------------------- controls */

  btn.scramble.addEventListener('click', scramble);
  btn.solve.addEventListener('click', autoSolve);
  btn.undo.addEventListener('click', undo);
  btn.redo.addEventListener('click', redo);
  btn.reset.addEventListener('click', resetCube);
  btn.pad.addEventListener('click', () => {
    const open = dock.classList.toggle('open');
    btn.pad.setAttribute('aria-expanded', open);
    btn.pad.textContent = open ? 'Moves ▴' : 'Moves ▾';
    setTimeout(fit, 0);
  });
  document.querySelectorAll('.pad button').forEach((b) =>
    b.addEventListener('click', () => userMove(b.dataset.move)));

  speedEl.addEventListener('input', () => store('cube3d.speed', speedEl.value));
  soundEl.addEventListener('change', () => { soundOn = soundEl.checked; store('cube3d.sound', soundOn ? '1' : '0'); });

  $('#helpBtn').addEventListener('click', () => { helpEl.hidden = false; });
  $('#helpClose').addEventListener('click', () => { helpEl.hidden = true; });
  helpEl.addEventListener('click', (e) => { if (e.target === helpEl) helpEl.hidden = true; });

  window.addEventListener('keydown', (e) => {
    if (e.target.matches && e.target.matches('input')) return;
    const key = e.key;

    if (e.ctrlKey || e.metaKey) {
      const k = key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
      return;
    }
    if (e.altKey) return;

    if (key === 'Escape') { helpEl.hidden = true; return; }
    if (key === '?') { helpEl.hidden = !helpEl.hidden; return; }
    if (key === ' ' && document.activeElement === document.body) { e.preventDefault(); scramble(); return; }

    const up = key.toUpperCase();
    if (key.length === 1 && 'UDLRFBMES'.includes(up)) {
      e.preventDefault();
      userMove(up + (e.shiftKey ? "'" : ''));
      return;
    }
    const nudge = { ArrowLeft: [-12, 0], ArrowRight: [12, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[key];
    if (nudge) {
      e.preventDefault();
      ry += nudge[0]; rx -= nudge[1]; clampCamera(); renderCamera();
    }
  });

  window.addEventListener('resize', fit);

  /* ------------------------------------------------------------------ init */

  (function init() {
    const sp = load('cube3d.speed');
    if (sp) speedEl.value = sp;
    soundOn = load('cube3d.sound') !== '0';
    soundEl.checked = soundOn;
    const best = parseFloat(load('cube3d.best'));
    if (best) bestEl.textContent = fmt(best);
    if (window.innerWidth >= 760) { dock.classList.add('open'); btn.pad.textContent = 'Moves ▴'; btn.pad.setAttribute('aria-expanded', 'true'); }

    build();
    renderCamera();
    fit();
    updateUI();
    setTimeout(hideHint, 9000);
  })();
})();

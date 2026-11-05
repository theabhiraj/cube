/* Cube 3D – a physical-feeling Rubik's Cube (2x2 to 5x5) built with CSS 3D transforms.
 *
 * Coordinates are CSS coordinates: x → right, y → down, z → toward the viewer.
 * Every cubie keeps an integer position and an integer 3x3 orientation matrix, so
 * moves are exact and never drift. Positions use DOUBLED coordinates so even sizes
 * work: for N=3 the values are -2,0,2; for N=4 they are -3,-1,1,3.
 *
 * A move is {axis, layer, q}: turn the slice where pos[axis] === layer by q
 * quarter-turns about +axis (positive = the CSS rotate3d direction).
 *
 * The camera is a free trackball (a full 3x3 rotation matrix) so the cube can be
 * spun any number of turns in any direction.
 */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const DEG = Math.PI / 180;

  const KEY = {
    state: 'cube3d.state.v2', speed: 'cube3d.speed', sound: 'cube3d.sound',
    palette: 'cube3d.palette', labels: 'cube3d.labels', size: 'cube3d.size', best: 'cube3d.best.',
  };

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

  const PALETTES = {
    classic: { white: '#f4f4f2', yellow: '#ffd300', green: '#00a14b', blue: '#0051ba', red: '#c41e3a', orange: '#ff5800' },
    access:  { white: '#ffffff', yellow: '#f0e442', green: '#009e73', blue: '#0072b2', red: '#d55e00', orange: '#e69f00' },
    soft:    { white: '#fbfbfb', yellow: '#ffe28a', green: '#7ed6a0', blue: '#7aa7ff', red: '#ff7a8a', orange: '#ffb070' },
  };

  const ALGOS = [
    ['Sexy move (×6 = solved)', "R U R' U'"],
    ['Sune', "R U R' U R U2 R'"],
    ['Anti-Sune', "R U2 R' U' R U' R'"],
    ['Sledgehammer', "R' F R F'"],
    ['T-perm', "R U R' U' R' F R2 U' R' U' R U R' F'"],
    ['Checkerboard (odd sizes)', 'M2 E2 S2'],
  ];

  let N = 3; // cube size

  // Clockwise (seen from outside the face) = +90° about the outward normal.
  function moveTable() {
    const e = N - 1;
    const t = {
      U: { axis: 1, layer: -e, q: -1 },
      D: { axis: 1, layer: e, q: 1 },
      R: { axis: 0, layer: e, q: 1 },
      L: { axis: 0, layer: -e, q: -1 },
      F: { axis: 2, layer: e, q: 1 },
      B: { axis: 2, layer: -e, q: -1 },
    };
    if (N % 2 === 1) {
      t.M = { axis: 0, layer: 0, q: -1 }; // follows L
      t.E = { axis: 1, layer: 0, q: 1 };  // follows D
      t.S = { axis: 2, layer: 0, q: 1 };  // follows F
    }
    return t;
  }

  function parseMove(tok) {
    const mt = /^([UDLRFBMES])(2'?|')?$/.exec(tok);
    if (!mt) return null;
    const base = moveTable()[mt[1]];
    if (!base) return null;
    let q = base.q;
    const suf = mt[2] || '';
    if (suf.includes('2')) q *= 2;
    if (suf.includes("'")) q = -q;
    return { axis: base.axis, layer: base.layer, q };
  }

  function parseAlgorithm(text) {
    const toks = text.replace(/[’‘`´]/g, "'").replace(/[()[\]]/g, ' ').split(/[\s,]+/).filter(Boolean);
    const moves = [], bad = [];
    for (const t of toks) {
      const m = parseMove(t.toUpperCase());
      if (m) moves.push(m); else bad.push(t);
    }
    return { moves, bad };
  }

  const inverse = (m) => ({ ...m, q: -m.q });

  function moveName(m) {
    const t = moveTable();
    for (const k in t) {
      const b = t[k];
      if (b.axis === m.axis && b.layer === m.layer) {
        const r = m.q / b.q;
        return k + (Math.abs(r) === 2 ? '2' : r < 0 ? "'" : '');
      }
    }
    const idx = (m.layer + (N - 1)) / 2 + 1; // inner layers: x2, y3' …
    return 'xyz'[m.axis] + idx + (Math.abs(m.q) === 2 ? '2' : m.q < 0 ? "'" : '');
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

  // float rotations (CSS convention) for the camera
  const rotX = (a) => { const c = Math.cos(a), s = Math.sin(a); return [[1, 0, 0], [0, c, -s], [0, s, c]]; };
  const rotY = (a) => { const c = Math.cos(a), s = Math.sin(a); return [[c, 0, s], [0, 1, 0], [-s, 0, c]]; };

  function orthonormalize(m) {
    const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
    const r0 = norm(m[0]);
    const d = m[1][0] * r0[0] + m[1][1] * r0[1] + m[1][2] * r0[2];
    const r1 = norm([m[1][0] - d * r0[0], m[1][1] - d * r0[1], m[1][2] - d * r0[2]]);
    return [r0, r1, cross(r0, r1)];
  }

  function matToQuat(m) {
    const t = m[0][0] + m[1][1] + m[2][2];
    let w, x, y, z, s;
    if (t > 0) {
      s = Math.sqrt(t + 1) * 2; w = s / 4;
      x = (m[2][1] - m[1][2]) / s; y = (m[0][2] - m[2][0]) / s; z = (m[1][0] - m[0][1]) / s;
    } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
      s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
      w = (m[2][1] - m[1][2]) / s; x = s / 4; y = (m[0][1] + m[1][0]) / s; z = (m[0][2] + m[2][0]) / s;
    } else if (m[1][1] > m[2][2]) {
      s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
      w = (m[0][2] - m[2][0]) / s; x = (m[0][1] + m[1][0]) / s; y = s / 4; z = (m[1][2] + m[2][1]) / s;
    } else {
      s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
      w = (m[1][0] - m[0][1]) / s; x = (m[0][2] + m[2][0]) / s; y = (m[1][2] + m[2][1]) / s; z = s / 4;
    }
    return [w, x, y, z];
  }
  function quatToMat(q) {
    const [w, x, y, z] = q;
    return [
      [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ];
  }
  function slerp(a, b, t) {
    let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    if (d < 0) { b = b.map((v) => -v); d = -d; }
    if (d > 0.9995) {
      const r = a.map((v, i) => v + (b[i] - v) * t);
      const n = Math.hypot(...r);
      return r.map((v) => v / n);
    }
    const th = Math.acos(d), s = Math.sin(th);
    const k1 = Math.sin((1 - t) * th) / s, k2 = Math.sin(t * th) / s;
    return a.map((v, i) => k1 * v + k2 * b[i]);
  }

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
    spin: $('#spinBtn'), view: $('#viewResetBtn'), copy: $('#copyBtn'),
  };
  const speedEl = $('#speed'), speedOut = $('#speedOut');
  const soundEl = $('#sound'), labelsEl = $('#labels'), spinEl = $('#spin');
  const sizeSel = $('#sizeSel'), paletteSel = $('#paletteSel');
  const algoSel = $('#algoSel'), algoIn = $('#algoIn');
  const histText = $('#histText');
  const helpEl = $('#help'), settingsEl = $('#settings');
  const installBtn = $('#installBtn');

  /* ---------------------------------------------------------------- state */

  const cubies = [];
  let size = 90;
  let cam = mul(rotX(-28 * DEG), rotY(-38 * DEG));  // camera rotation (world → screen)
  let zoom = 1;
  const HOME_CAM = mul(rotX(-28 * DEG), rotY(-38 * DEG));
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
  let autoSpin = false;

  function store(key, val) { try { localStorage.setItem(key, val); } catch (_) { /* storage unavailable */ } }
  function load(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }

  /* ---------------------------------------------------------------- build */

  function build() {
    cubeEl.innerHTML = '';
    cubies.length = 0;
    const e = N - 1;
    const coords = Array.from({ length: N }, (_, i) => 2 * i - e);
    for (const x of coords) for (const y of coords) for (const z of coords) {
      // fully hidden pieces are skipped on big cubes to keep it fast
      if (N >= 4 && Math.abs(x) < e && Math.abs(y) < e && Math.abs(z) < e) continue;
      const el = document.createElement('div');
      el.className = 'cubie';
      const idx = cubies.length;
      const c = { pos: [x, y, z], home: [x, y, z], M: ident(), el, stickers: [], last: '' };
      FACES.forEach((f, fi) => {
        const outer = f.n.some((v, k) => v !== 0 && v * e === c.pos[k]);
        const face = document.createElement('div');
        face.className = 'face ' + f.id + (outer ? '' : ' inner');
        if (outer) {
          face.dataset.f = fi;
          face.dataset.c = idx;
          const st = document.createElement('i');
          st.className = 'sticker';
          st.dataset.l = f.id;
          face.appendChild(st);
          c.stickers.push(fi);
        }
        el.appendChild(face);
      });
      cubies.push(c);
      cubeEl.appendChild(el);
    }
    root.style.setProperty('--n', N);
    renderAll();
  }

  function resetCubies() {
    cubies.forEach((c) => { c.pos = c.home.slice(); c.M = ident(); });
    renderAll();
  }

  /* --------------------------------------------------------------- render */

  function cubieTransform(c) {
    const M = c.M, h = size / 2;
    let t = `matrix3d(${M[0][0]},${M[1][0]},${M[2][0]},0,` +
            `${M[0][1]},${M[1][1]},${M[2][1]},0,` +
            `${M[0][2]},${M[1][2]},${M[2][2]},0,` +
            `${c.pos[0] * h},${c.pos[1] * h},${c.pos[2] * h},1)`;
    if (layerAnim && c.pos[layerAnim.axis] === layerAnim.layer) {
      const v = [0, 0, 0]; v[layerAnim.axis] = 1;
      t = `rotate3d(${v[0]},${v[1]},${v[2]},${layerAnim.angle}deg) ` + t;
    }
    return t;
  }

  function renderAll() {
    for (const c of cubies) {
      const t = cubieTransform(c);
      if (t !== c.last) { c.el.style.transform = t; c.last = t; }
    }
  }

  function renderCamera() {
    cubeEl.style.transform =
      `matrix3d(${cam[0][0]},${cam[1][0]},${cam[2][0]},0,${cam[0][1]},${cam[1][1]},${cam[2][1]},0,` +
      `${cam[0][2]},${cam[1][2]},${cam[2][2]},0,0,0,0,1) scale(${zoom})`;
  }

  function fit() {
    const w = stage.clientWidth, h = stage.clientHeight;
    size = Math.max(28, Math.min(120, Math.floor(Math.min(w / (N * 1.75), h / (N * 1.45)))));
    root.style.setProperty('--s', size + 'px');
    for (const c of cubies) c.last = '';
    renderAll();
  }

  // Rotate the camera about the SCREEN axes (free trackball: no limits, any number of turns).
  function orbit(yawDeg, pitchDeg) {
    cam = orthonormalize(mul(mul(rotX(pitchDeg * DEG), rotY(yawDeg * DEG)), cam));
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

  // Milliseconds for one quarter turn at the chosen speed (1 = slow … 10 = fast).
  const baseDur = () => 1250 * Math.pow(0.83, (+speedEl.value) - 1);

  function turnDuration(e) {
    if (e.dur != null) return e.dur;
    let d = baseDur();
    if (queue.length > 3) d *= 0.6;
    return d * (Math.abs(e.m.q) === 2 ? 1.25 : 1);
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
    if (e.kind !== 'scramble' && e.kind !== 'auto') { click(); saveState(); }
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
      saveState();
    } else if (pendingKind === 'auto') {
      phase = 'fresh';
      moves = 0;
      timerStart = null;
      history = [];
      redoStack.length = 0;
      showTimer(0);
      saveState();
    } else if (phase === 'scrambled' && moves > 0 && isSolved()) {
      win();
    }
    pendingKind = null;
    updateUI();
  }

  /* -------------------------------------------------------------- commands */

  function userMove(str) {
    if (lock) return false;
    const m = parseMove(str);
    if (!m) return false;
    hideHint();
    queue.push({ m, kind: 'user' });
    pump();
    return true;
  }

  function runAlgorithm(text) {
    if (lock) return false;
    const { moves: seq, bad } = parseAlgorithm(text);
    if (!text.trim()) { toast('Type some moves', "e.g. R U R′ U′", 1800); return false; }
    if (bad.length) { toast('Unknown move', bad.slice(0, 3).join(' ') + (N % 2 === 0 && /[MES]/i.test(bad.join('')) ? ' (slices need an odd size)' : ''), 2400); return false; }
    hideHint();
    seq.forEach((m) => queue.push({ m, kind: 'user' }));
    pump();
    return true;
  }

  function scramble() {
    if (busy || queue.length || lock) return;
    hideHint();
    history = []; redoStack = []; moves = 0; timerStart = null;
    showTimer(0);
    lock = true; pendingKind = 'scramble';
    const count = { 2: 11, 3: 25, 4: 40, 5: 55 }[N];
    const dur = Math.max(90, Math.min(260, baseDur() * 0.3));
    const faces = 'UDLRFB';
    let last = '';
    for (let i = 0; i < count; i++) {
      let f;
      do { f = faces[Math.floor(Math.random() * 6)]; } while (f === last);
      last = f;
      const suffix = ['', "'", '2'][Math.floor(Math.random() * 3)];
      queue.push({ m: parseMove(f + suffix), kind: 'scramble', dur });
    }
    pump();
  }

  function autoSolve() {
    if (busy || queue.length || lock || !history.length) return;
    lock = true; pendingKind = 'auto';
    timerStart = null;
    const seq = history.slice().reverse();
    let dur = Math.max(70, Math.min(240, baseDur() * 0.3));
    if (seq.length > 30) dur = Math.max(60, dur * 0.6);
    seq.forEach((h) => queue.push({ m: inverse(h.m), kind: 'auto', dur }));
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
    saveState();
    updateUI();
  }

  function setSize(n) {
    if (n === N) return true;
    if (busy || queue.length || lock) { sizeSel.value = N; toast('Wait for the cube to stop', '', 1500); return false; }
    N = n;
    store(KEY.size, String(N));
    history = []; redoStack = []; moves = 0; phase = 'fresh'; timerStart = null;
    showTimer(0);
    build();
    fit();
    refreshBest();
    cubeEl.classList.remove('pop');
    void cubeEl.offsetWidth;
    cubeEl.classList.add('pop');
    sizeSel.value = String(N);
    saveState();
    updateUI();
    return true;
  }

  /* --------------------------------------------------------------- persist */

  function saveState() {
    try {
      localStorage.setItem(KEY.state, JSON.stringify({
        v: 2, n: N,
        c: cubies.map((c) => [c.pos, c.M]),
        h: history.map((h) => [h.m.axis, h.m.layer, h.m.q, h.user ? 1 : 0]),
        mv: moves, ph: phase,
        el: timerStart !== null ? performance.now() - timerStart : null,
      }));
    } catch (_) { /* storage unavailable */ }
  }

  function loadState() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY.state));
      if (!s || s.v !== 2 || ![2, 3, 4, 5].includes(s.n)) return false;
      N = s.n;
      build();
      if (!Array.isArray(s.c) || s.c.length !== cubies.length) throw new Error('bad state');
      const seen = new Set();
      s.c.forEach(([pos, M], i) => {
        if (!Array.isArray(pos) || pos.length !== 3 || !pos.every(Number.isInteger)) throw new Error('bad pos');
        if (!Array.isArray(M) || M.length !== 3 || !M.every((r) => Array.isArray(r) && r.length === 3 && r.every((v) => v === 0 || v === 1 || v === -1))) throw new Error('bad M');
        seen.add(pos.join());
        cubies[i].pos = pos; cubies[i].M = M;
      });
      const homes = new Set(cubies.map((c) => c.home.join()));
      if (seen.size !== homes.size || [...seen].some((k) => !homes.has(k))) throw new Error('bad perm');
      history = (s.h || []).map(([axis, layer, q, u]) => ({ m: { axis, layer, q }, user: !!u }));
      moves = s.mv | 0;
      phase = s.ph === 'scrambled' ? 'scrambled' : 'fresh';
      timerStart = typeof s.el === 'number' ? performance.now() - s.el : null;
      renderAll();
      return true;
    } catch (_) {
      N = 3; history = []; moves = 0; phase = 'fresh'; timerStart = null;
      build();
      return false;
    }
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
      const best = parseFloat(load(KEY.best + N));
      if (!best || t < best) { store(KEY.best + N, String(t)); refreshBest(); sub += ' · new best!'; }
    }
    toast('Solved! 🎉', sub, 4200);
    confetti();
    saveState();
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

  function refreshBest() {
    const b = parseFloat(load(KEY.best + N));
    bestEl.textContent = b ? fmt(b) : '—';
  }

  setInterval(() => { if (timerStart !== null) showTimer(performance.now() - timerStart); }, 50);

  function updateUI() {
    movesEl.textContent = moves;
    const idle = !busy && !queue.length && !lock;
    btn.scramble.disabled = !idle;
    btn.reset.disabled = !idle;
    btn.undo.disabled = !idle || !history.length;
    btn.redo.disabled = !idle || !redoStack.length;
    btn.solve.disabled = !idle || !history.length;
    const names = history.map((h) => moveName(h.m));
    histText.textContent = names.length ? names.join(' ') : 'No moves yet';
    btn.copy.disabled = !names.length;
    speedOut.textContent = (baseDur() / 1000).toFixed(2) + 's';
  }

  let toastTimer;
  function toast(title, sub, ms) {
    toastEl.innerHTML = '';
    toastEl.append(document.createTextNode(title));
    if (sub) { const s = document.createElement('small'); s.textContent = sub; toastEl.append(s); }
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
    const colors = Object.values(PALETTES[paletteSel.value] || PALETTES.classic);
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

  function applyPalette(name) {
    const p = PALETTES[name] || PALETTES.classic;
    for (const k in p) root.style.setProperty('--' + k, p[k]);
    paletteSel.value = PALETTES[name] ? name : 'classic';
  }

  function setAutoSpin(on) {
    autoSpin = on;
    spinEl.checked = on;
    btn.spin.classList.toggle('on', on);
    btn.spin.setAttribute('aria-pressed', on);
    if (on) kickCam();
  }

  /* ----------------------------------------------------------------- audio */

  let actx;
  function click() {
    if (!soundOn) return;
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
    if (navigator.vibrate) navigator.vibrate(6);
  }

  /* ------------------------------------------------------------- camera loop */

  const vel = { x: 0, y: 0 };   // yaw / pitch velocity in degrees per 16.7ms frame
  const ORBIT_SENS = 0.6;       // degrees per pixel dragged
  const AUTO_SPIN = 0.4;        // degrees per frame
  let camRaf = 0, lastTs = 0, viewToken = 0;

  function camLoop(ts) {
    const dt = lastTs ? Math.min(40, ts - lastTs) : 16.7;
    lastTs = ts;
    const f = dt / 16.7;
    const dragging = gesture && gesture.type === 'orbit';
    let active = false;
    if (!dragging) {
      if (Math.abs(vel.x) > .03 || Math.abs(vel.y) > .03) {
        orbit(vel.x * f, vel.y * f);
        const d = Math.pow(.975, f);
        vel.x *= d; vel.y *= d;
        active = true;
      } else {
        vel.x = vel.y = 0;
        if (autoSpin && !gesture) { orbit(AUTO_SPIN * f, 0); active = true; }
      }
    }
    if (active) renderCamera();
    camRaf = (active || autoSpin || dragging) ? requestAnimationFrame(camLoop) : 0;
    if (!camRaf) lastTs = 0;
  }
  function kickCam() { if (!camRaf) { lastTs = 0; camRaf = requestAnimationFrame(camLoop); } }

  function resetView() {
    const tok = ++viewToken;
    vel.x = vel.y = 0;
    const q0 = matToQuat(cam), q1 = matToQuat(HOME_CAM), z0 = zoom;
    animate(0, 1, 650, easeInOut, (t) => {
      if (tok !== viewToken) return;
      cam = orthonormalize(quatToMat(slerp(q0, q1, t)));
      zoom = z0 + (1 - z0) * t;
      renderCamera();
    });
  }

  /* ------------------------------------------------------------- pointers */

  const pointers = new Map();
  let gesture = null;

  const pinchDist = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  // World vector → screen (x, y) for the current camera.
  const toScreen = (v) => [
    cam[0][0] * v[0] + cam[0][1] * v[1] + cam[0][2] * v[2],
    cam[1][0] * v[0] + cam[1][1] * v[1] + cam[1][2] * v[2],
  ];

  stage.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    if (e.target.closest && e.target.closest('button')) return;
    viewToken++;                       // cancel any view-reset tween
    vel.x = vel.y = 0;                 // grab = stop the spin
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
      kickCam();
    }
  });

  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId) || !gesture) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (gesture.type === 'pinch') {
      if (pointers.size >= 2) {
        zoom = Math.max(.5, Math.min(2, gesture.z0 * pinchDist() / gesture.d0));
        renderCamera();
      }
      return;
    }

    if (gesture.type === 'orbit') {
      const g = gesture;
      const dx = e.clientX - g.lx, dy = e.clientY - g.ly;
      const now = performance.now();
      const dt = Math.max(1, now - g.t);
      g.lx = e.clientX; g.ly = e.clientY; g.t = now;
      const yaw = dx * ORBIT_SENS, pitch = -dy * ORBIT_SENS;
      orbit(yaw, pitch);
      const cap = (v) => Math.max(-45, Math.min(45, v));
      g.vx = cap(.6 * g.vx + .4 * (yaw / dt * 16.7));
      g.vy = cap(.6 * g.vy + .4 * (pitch / dt * 16.7));
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
    const p = [c.pos[0] / 2 + n[0] * .5, c.pos[1] / 2 + n[1] * .5, c.pos[2] / 2 + n[2] * .5];
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
    const ang = Math.max(-200, Math.min(200, proj * (165 / (N * size * zoom))));
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
    const vel0 = stale ? 0 : g.vel;
    let turns = Math.round((g.angle + vel0 * 130) / 90);
    if (turns === 0 && Math.abs(g.angle) > 24) turns = Math.sign(g.angle);
    turns = Math.max(-2, Math.min(2, turns));
    const from = g.angle, to = turns * 90;
    const scale = Math.max(.7, Math.min(1.6, baseDur() / 700));
    animate(from, to, (220 + Math.abs(to - from) * 3.5) * scale, easeOutBack, (a) => {
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
    else if (g.type === 'orbit') {
      if (performance.now() - g.t < 80) { vel.x = g.vx; vel.y = g.vy; }
      kickCam();
    }
  }
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);

  stage.addEventListener('dblclick', (e) => {
    if (e.target.closest && (e.target.closest('button') || e.target.closest('.face[data-f]'))) return;
    resetView();
  });

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoom = Math.max(.5, Math.min(2, zoom * (1 - e.deltaY * .0012)));
    renderCamera();
  }, { passive: false });

  /* -------------------------------------------------------------- controls */

  btn.scramble.addEventListener('click', scramble);
  btn.solve.addEventListener('click', autoSolve);
  btn.undo.addEventListener('click', undo);
  btn.redo.addEventListener('click', redo);
  btn.reset.addEventListener('click', resetCube);
  btn.view.addEventListener('click', resetView);
  btn.spin.addEventListener('click', () => setAutoSpin(!autoSpin));
  btn.pad.addEventListener('click', () => {
    const open = dock.classList.toggle('open');
    btn.pad.setAttribute('aria-expanded', open);
    btn.pad.textContent = open ? 'Moves ▴' : 'Moves ▾';
    setTimeout(fit, 0);
  });
  document.querySelectorAll('.pad button').forEach((b) =>
    b.addEventListener('click', () => userMove(b.dataset.move)));

  ALGOS.forEach(([name, seq]) => {
    const o = document.createElement('option');
    o.value = seq; o.textContent = name;
    algoSel.appendChild(o);
  });
  algoSel.addEventListener('change', () => { if (algoSel.value) { algoIn.value = algoSel.value; } });
  $('#algoRun').addEventListener('click', () => { runAlgorithm(algoIn.value); algoIn.blur(); });
  algoIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { runAlgorithm(algoIn.value); algoIn.blur(); } });

  btn.copy.addEventListener('click', async () => {
    const text = history.map((h) => moveName(h.m)).join(' ');
    try { await navigator.clipboard.writeText(text); toast('Copied', 'Move history is on your clipboard', 1500); }
    catch (_) { toast('Could not copy', '', 1500); }
  });

  speedEl.addEventListener('input', () => { store(KEY.speed, speedEl.value); updateUI(); });
  soundEl.addEventListener('change', () => { soundOn = soundEl.checked; store(KEY.sound, soundOn ? '1' : '0'); });
  labelsEl.addEventListener('change', () => { document.body.classList.toggle('labels', labelsEl.checked); store(KEY.labels, labelsEl.checked ? '1' : '0'); });
  spinEl.addEventListener('change', () => setAutoSpin(spinEl.checked));
  sizeSel.addEventListener('change', () => setSize(+sizeSel.value));
  paletteSel.addEventListener('change', () => { applyPalette(paletteSel.value); store(KEY.palette, paletteSel.value); });
  $('#clearBest').addEventListener('click', () => {
    [2, 3, 4, 5].forEach((n) => { try { localStorage.removeItem(KEY.best + n); } catch (_) { /* ignore */ } });
    refreshBest();
    toast('Best times cleared', '', 1400);
  });

  const closeAll = () => { helpEl.hidden = true; settingsEl.hidden = true; };
  $('#helpBtn').addEventListener('click', () => { settingsEl.hidden = true; helpEl.hidden = false; });
  $('#settingsBtn').addEventListener('click', () => { helpEl.hidden = true; settingsEl.hidden = false; });
  $('#helpClose').addEventListener('click', closeAll);
  $('#settingsClose').addEventListener('click', closeAll);
  [helpEl, settingsEl].forEach((o) => o.addEventListener('click', (e) => { if (e.target === o) closeAll(); }));

  let deferredInstall = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; installBtn.hidden = false; });
  installBtn.addEventListener('click', async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    try { await deferredInstall.userChoice; } catch (_) { /* ignore */ }
    deferredInstall = null; installBtn.hidden = true;
  });

  window.addEventListener('keydown', (e) => {
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const key = e.key;

    if (e.ctrlKey || e.metaKey) {
      const k = key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
      return;
    }
    if (e.altKey) return;

    if (key === 'Escape') { closeAll(); return; }
    if (key === '?') { settingsEl.hidden = true; helpEl.hidden = !helpEl.hidden; return; }
    if (key === ' ' && document.activeElement === document.body) { e.preventDefault(); scramble(); return; }
    if (key === 'Home') { e.preventDefault(); resetView(); return; }
    if (key.toLowerCase() === 'p') { setAutoSpin(!autoSpin); return; }

    const up = key.toUpperCase();
    if (key.length === 1 && 'UDLRFBMES'.includes(up)) {
      e.preventDefault();
      userMove(up + (e.shiftKey ? "'" : ''));
      return;
    }
    const nudge = { ArrowLeft: [-15, 0], ArrowRight: [15, 0], ArrowUp: [0, 15], ArrowDown: [0, -15] }[key];
    if (nudge) {
      e.preventDefault();
      orbit(nudge[0], nudge[1]); renderCamera();
    }
  });

  window.addEventListener('resize', fit);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveState(); });
  window.addEventListener('pagehide', saveState);

  /* ------------------------------------------------------------------ init */

  (function init() {
    const sp = load(KEY.speed);
    if (sp) speedEl.value = sp;
    soundOn = load(KEY.sound) !== '0';
    soundEl.checked = soundOn;
    const lb = load(KEY.labels) === '1';
    labelsEl.checked = lb;
    document.body.classList.toggle('labels', lb);
    applyPalette(load(KEY.palette) || 'classic');

    if (!loadState()) {
      const saved = parseInt(load(KEY.size), 10);
      if ([2, 3, 4, 5].includes(saved)) N = saved;
      build();
    }
    sizeSel.value = String(N);
    if (window.innerWidth >= 760) { dock.classList.add('open'); btn.pad.textContent = 'Moves ▴'; btn.pad.setAttribute('aria-expanded', 'true'); }

    renderCamera();
    fit();
    refreshBest();
    if (timerStart !== null) showTimer(performance.now() - timerStart);
    updateUI();
    setTimeout(hideHint, 9000);

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
    }
  })();

  // Small public API – handy for embedding, demos and automated tests.
  window.Cube3D = {
    move: userMove, algorithm: runAlgorithm, scramble, solve: autoSolve, reset: resetCube,
    undo, redo, isSolved, setSize, resetView,
    get size() { return N; }, get moves() { return moves; }, get busy() { return busy || queue.length > 0; },
  };
})();

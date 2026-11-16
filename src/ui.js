import { AudioInput } from './audio.js';

// Copy deck (§5.7). Strings are fixed; do not improvise.
const COPY = {
  idle: 'A dying star that burns in the colours of whatever your computer is playing.',
  note: 'In the picker, choose a tab (or Entire screen on Windows) and switch on Share audio. Sound is analysed in your browser and never leaves it.',
  noShare: "Sharing system sound isn't available on this device.",
  nosound: 'That share had no sound. Choose a tab and switch on Share audio.',
  unsupported: "This browser can't share sound. Use Chrome or Edge, or the microphone.",
  blocked: 'The microphone is blocked. Allow it from the address bar, then try again.',
  nomic: 'No microphone was found.',
  failed: "Couldn't start the audio. Pick a browser tab and switch on Share audio, or use the microphone.",
  ended: 'Sharing stopped.',
  insecure: 'This page needs a secure address. Open it over https or localhost.',
  waiting: 'Waiting for your choice…',
  silence: 'Nothing playing. Start some music.',
  paused: 'Paused',
};
const LISTENING = { display: 'Listening to system audio.', mic: 'Listening to the microphone.' };
const HIDE_AFTER = 3000;

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('soot.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('soot.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// The spectrum strip uses the same colours as the cloud, so it doubles as the legend. Keep in step with pal() in main.js.
const STOPS = [[255, 26, 18], [255, 128, 15], [255, 230, 56], [31, 230, 102], [20, 191, 255], [56, 71, 255], [199, 46, 255]];
const bandColour = (i, n) => {
  const t = Math.min(1, Math.max(0, (i / (n - 1)) ** 0.85)) * 6, k = Math.min(5, Math.floor(t)), f = t - k;
  return `rgb(${STOPS[k].map((c, j) => Math.round(c + (STOPS[k + 1][j] - c) * f)).join(',')})`;
};

function drawSpectrum(canvas, lv) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2), w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
  if (!w) return;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const g = canvas.getContext('2d'), n = lv.length, step = w / n, bw = Math.max(1, step * 0.7);
  g.clearRect(0, 0, w, h);
  for (let i = 0; i < n; i++) {
    const bh = Math.max(dpr * 2, Math.min(1, lv[i]) * h);
    g.fillStyle = bandColour(i, n);
    g.fillRect(i * step + (step - bw) / 2, h - bh, bw, bh);
  }
}

// app: { start(kind), setPaused(b), setSensitivity(v), setDetail(v, auto) }. Returns { frame(bands, silentFor) }.
export function initUI(app) {
  const el = {
    intro: $('intro'), statement: $('statement'), note: $('note'), a: $('btn-a'), b: $('btn-b'),
    bar: $('bar'), status: $('status'), specBar: $('spec-bar'), sens: $('sens'), sensLabel: $('sens-label'),
    detail: $('detail'), detailLabel: $('detail-label'), auto: $('auto'), pause: $('pause'), fs: $('fs'), live: $('live'),
    canvas: $('c'), segs: Array.from(document.querySelectorAll('.seg')),
    tune: $('tune'), tuneBtn: $('tune-btn'), tIn: ['amount', 'size', 'chaos', 'burst'].map((k) => $('t-' + k)),
  };
  const s = { running: false, requesting: false, paused: false, barHidden: true, hover: false, dragging: false, silent: false, tune: false, lastKind: store.get('source', 'display'), waitingMsg: false };
  let hideTimer = 0, wakeLock = null, labelTimer = 0;

  const announce = (t) => { el.live.textContent = ''; setTimeout(() => { el.live.textContent = t; }, 30); };

  // ---------- intro layout ----------
  function layout(code) {
    const share = AudioInput.canShare;
    let text = COPY.idle, note = share ? COPY.note : COPY.noShare, btns;
    if (!window.isSecureContext) { text = COPY.insecure; note = ''; btns = []; }
    else if (code === 'nosound') { text = COPY.nosound; note = ''; btns = [['Try again', 'display'], ['Use the microphone', 'mic']]; }
    else if (code === 'unsupported') { text = COPY.unsupported; note = ''; btns = [['Use the microphone', 'mic']]; }
    else if (code === 'blocked') { text = COPY.blocked; note = ''; btns = [['Try again', 'mic']]; }
    else if (code === 'failed') { text = COPY.failed; note = ''; btns = [['Try again', 'display'], ['Use the microphone', 'mic']]; }
    else if (code === 'nomic') { text = COPY.nomic; note = ''; btns = [['Listen to system audio', 'display']]; }
    else if (code === 'ended') { text = COPY.ended; note = ''; btns = [['Listen again', s.lastKind]]; }
    else btns = share ? [['Listen to system audio', 'display'], ['Use the microphone', 'mic']] : [['Listen with the microphone', 'mic']];
    el.statement.textContent = text;
    el.note.textContent = note;
    el.note.hidden = !note;
    [el.a, el.b].forEach((btn, i) => {
      btn.hidden = !btns[i];
      if (btns[i]) { btn.firstElementChild.textContent = btns[i][0]; btn.dataset.kind = btns[i][1]; btn.dataset.label = btns[i][0]; }
    });
    if (code) announce(text);
  }

  // ---------- starting ----------
  async function begin(kind, clicked) {
    if (s.requesting) return;
    s.requesting = true;
    if (s.running) setStatus(); else { [el.a, el.b].forEach((x) => { x.disabled = true; }); if (clicked) clicked.firstElementChild.textContent = COPY.waiting; }
    s.waitingMsg = true; setStatus();
    let r;
    try { r = await app.start(kind); } catch (e) { console.error(e); r = { ok: false, code: 'failed' }; }
    s.requesting = false; s.waitingMsg = false;
    if (r.ok) { enterRunning(kind); return; }
    if (!s.running) {
      [el.a, el.b].forEach((x) => { x.disabled = false; if (x.dataset.label) x.firstElementChild.textContent = x.dataset.label; });
      if (r.code !== 'cancelled') layout(r.code);       // cancelling is not an error: no message
    } else if (r.code !== 'cancelled') announce(COPY[r.code] || COPY.nosound);
    setStatus();
  }

  function enterRunning(kind) {
    s.lastKind = kind;
    store.set('source', kind);
    el.segs.forEach((x) => { const on = x.dataset.kind === kind; x.setAttribute('aria-checked', on); x.tabIndex = on ? 0 : -1; });
    if (!s.running) {
      s.running = true;
      document.body.classList.add('running');
      el.intro.inert = true;
    }
    s.paused = false; el.pause.setAttribute('aria-pressed', 'false'); el.pause.setAttribute('aria-label', 'Pause');
    document.title = 'Remnant · Listening';
    announce(LISTENING[kind]);
    wake();
    setStatus();
    showBar();
  }

  function enterEnded() {
    s.running = false;
    s.paused = false; s.silent = false;
    setTune(false);
    app.setPaused(false);
    el.pause.setAttribute('aria-pressed', 'false'); el.pause.setAttribute('aria-label', 'Pause');
    document.body.classList.remove('running');
    el.intro.inert = false;
    hideBar(true);
    layout('ended');
    document.title = 'Remnant';
    release();
    setStatus();
  }

  // ---------- control bar ----------
  function setStatus() {
    const t = s.waitingMsg ? COPY.waiting : s.paused ? COPY.paused : s.silent ? COPY.silence : '';
    if (el.status.textContent !== t) el.status.textContent = t;
  }
  function canHide() { return !s.hover && !s.dragging && !el.bar.contains(document.activeElement) && !s.silent && !s.tune; }
  function showBar() {
    if (!s.running) return;
    clearTimeout(hideTimer);
    if (s.barHidden) { s.barHidden = false; el.bar.inert = false; el.bar.classList.remove('is-hidden'); el.canvas.style.cursor = ''; }
    hideTimer = setTimeout(tryHide, HIDE_AFTER);
  }
  function tryHide() { if (canHide()) hideBar(); else hideTimer = setTimeout(tryHide, HIDE_AFTER); }
  function hideBar(force) {
    clearTimeout(hideTimer);
    if (s.barHidden && !force) return;
    s.barHidden = true;
    setTune(false);
    if (el.bar.contains(document.activeElement)) document.activeElement.blur();
    el.bar.inert = true;
    el.bar.classList.add('is-hidden');
    if (s.running) el.canvas.style.cursor = 'none';
  }

  function togglePause() {
    s.paused = !s.paused;
    app.setPaused(s.paused);
    el.pause.setAttribute('aria-pressed', s.paused);
    el.pause.setAttribute('aria-label', s.paused ? 'Resume' : 'Pause');
    announce(s.paused ? 'Paused' : 'Resumed');
    if (s.paused) release(); else wake();
    setStatus();
  }

  function toggleFullscreen() {
    if (!document.fullscreenEnabled) return;
    if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {});
  }
  el.fs.hidden = !document.fullscreenEnabled;
  document.addEventListener('fullscreenchange', () => {
    const on = !!document.fullscreenElement;
    el.fs.setAttribute('aria-pressed', on);
    el.fs.setAttribute('aria-label', on ? 'Leave fullscreen' : 'Enter fullscreen');
  });

  // ---------- sliders ----------
  function fill(input) { input.style.setProperty('--v', ((input.value - input.min) / (input.max - input.min)) * 100 + '%'); }
  function flashValue(label, text) {
    label.textContent = text;
    clearTimeout(labelTimer);
    labelTimer = setTimeout(() => { el.sensLabel.textContent = 'Sensitivity'; el.detailLabel.textContent = 'Detail'; }, 1000);
  }
  el.sens.value = store.get('sens', 50);
  el.detail.value = store.get('detail', 100);
  let auto = store.get('auto', true);
  el.auto.setAttribute('aria-pressed', auto);
  fill(el.sens); fill(el.detail);
  app.setSensitivity(el.sens.value / 100);
  app.setDetail(el.detail.value / 100, auto);
  el.sens.addEventListener('input', () => {
    fill(el.sens); store.set('sens', Number(el.sens.value));
    app.setSensitivity(el.sens.value / 100);
    flashValue(el.sensLabel, el.sens.value + '%');
  });
  el.detail.addEventListener('input', () => {
    auto = false; el.auto.setAttribute('aria-pressed', false);
    fill(el.detail); store.set('detail', Number(el.detail.value)); store.set('auto', false);
    app.setDetail(el.detail.value / 100, false);
    flashValue(el.detailLabel, el.detail.value + '%');
  });
  el.auto.addEventListener('click', () => {
    auto = !auto; el.auto.setAttribute('aria-pressed', auto); store.set('auto', auto);
    app.setDetail(el.detail.value / 100, auto);
  });
  for (const input of [el.sens, el.detail]) {
    input.addEventListener('pointerdown', () => { s.dragging = true; });
  }
  window.addEventListener('pointerup', () => { s.dragging = false; });
  window.addEventListener('pointercancel', () => { s.dragging = false; });

  // ---------- particle controls ----------
  // Four sliders, 50 is neutral. Amount: how much smoke. Size: fleck size. Chaos: turbulence and flicker. Burst: how hard hits shove the smoke outward.
  const tuneVals = store.get('tune4', [35, 0, 70, 10]);
  const pushTune = () => app.setTune(tuneVals.map((v) => v / 100));
  el.tIn.forEach((inp, i) => {
    inp.value = tuneVals[i]; fill(inp);
    inp.addEventListener('input', () => { tuneVals[i] = Number(inp.value); fill(inp); store.set('tune4', tuneVals); pushTune(); });
    inp.addEventListener('pointerdown', () => { s.dragging = true; });
  });
  pushTune();
  function setTune(open) {
    s.tune = open;
    el.tune.hidden = !open;
    el.tuneBtn.setAttribute('aria-expanded', open);
    if (open) showBar();
  }
  el.tuneBtn.addEventListener('click', () => setTune(!s.tune));

  // ---------- source segments (radiogroup) ----------
  el.segs.forEach((seg) => {
    seg.addEventListener('click', () => { if (seg.getAttribute('aria-checked') !== 'true') begin(seg.dataset.kind, null); });
    seg.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      const other = el.segs.find((x) => x !== seg);
      other.focus(); begin(other.dataset.kind, null);
    });
  });

  el.a.addEventListener('click', () => begin(el.a.dataset.kind, el.a));
  el.b.addEventListener('click', () => begin(el.b.dataset.kind, el.b));
  el.pause.addEventListener('click', togglePause);
  el.fs.addEventListener('click', toggleFullscreen);
  el.bar.addEventListener('pointerenter', () => { s.hover = true; });
  el.bar.addEventListener('pointerleave', () => { s.hover = false; showBar(); });

  // ---------- keyboard ----------
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (s.running && s.barHidden && e.key !== 'Escape') { showBar(); if (e.key !== 'Tab' && !/^F\d+$/.test(e.key)) e.preventDefault(); return; }   // first key only un-hides
    const inField = e.target instanceof HTMLInputElement || e.target instanceof HTMLButtonElement;
    const k = e.key.toLowerCase();
    if (k === 'h' && s.running) { hideBar(true); return; }
    if (k === 's' && !s.requesting) { begin('display', null); return; }
    if (k === 'm' && !s.requesting) { begin('mic', null); return; }
    if (!s.running) return;
    if (k === ' ' && !inField) { e.preventDefault(); togglePause(); }
    else if (k === 'f') toggleFullscreen();
    else if (k === 't') setTune(!s.tune);
    else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && document.activeElement === document.body) {
      e.preventDefault();
      el.sens.value = Math.max(0, Math.min(100, Number(el.sens.value) + (e.key === 'ArrowUp' ? 5 : -5)));
      el.sens.dispatchEvent(new Event('input'));
    }
    showBar();
  });

  // ---------- pointer: reveal the bar (dragging the canvas orbits the camera; see main.js) ----------
  let tapAt = 0, downX = 0, downY = 0, downT = 0;
  window.addEventListener('pointermove', () => showBar());
  el.canvas.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; downT = performance.now(); showBar(); });
  el.canvas.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'touch' || !s.running) return;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 10 || performance.now() - downT > 300) return;
    const now = performance.now();
    if (now - tapAt < 300) { toggleFullscreen(); tapAt = 0; return; }
    tapAt = now;
    if (s.barHidden) showBar(); else hideBar(true);
  });
  window.addEventListener('touchstart', () => showBar(), { passive: true });

  // ---------- wake lock ----------
  async function wake() {
    try { if (s.running && !s.paused && !document.hidden && !wakeLock && navigator.wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch { /* fail silently */ }
  }
  function release() { try { wakeLock?.release(); } catch { /* ignore */ } wakeLock = null; }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });

  app.onEnded = () => enterEnded();
  layout(null);
  // Reserve nothing else: the first frame of smoke is already drawn before this runs.

  return {
    // The governor owns the Detail value while Auto is on, so the slider follows it.
    setDetail(frac) { el.detail.value = Math.round(frac * 100); fill(el.detail); },
    // Called every frame: draws the spectrum strip and drives the silence message.
    frame(bands, silentFor) {
      if (s.running && !s.barHidden) drawSpectrum(el.specBar, bands);
      if (s.running) {
        const silent = silentFor > 4 && !s.paused;
        if (silent !== s.silent) { s.silent = silent; setStatus(); if (silent) showBar(); }
      }
    },
  };
}

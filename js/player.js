// Full-screen player with learning tools: speed, mirror, loop, ±5s, swipe between clips,
// and a "quick sort" mode for filing unsorted clips into categories one by one.
import { h, icon, setChildren, fmtDur, fmtBytes, lsGet, lsSet, clamp, haptic } from './util.js';
import { pushOverlay } from './ui.js';
import { videoUrl, stopListening, prefetchVideo, thumbUrl, cachedThumbUrl } from './media.js';

const SPEEDS = [0.25, 0.5, 0.75, 1];
const speedLabel = (s) => (s === 1 ? '1×' : String(s).replace('.', ','));

let P = null; // the open player

export function playerOpen() { return !!P; }
export function refreshPlayer() { P?.refresh(); }

export function openPlayer({ list, index = 0, app, sortMode = false, title = '' }) {
  if (P) return;
  const prefs = Object.assign({ speed: 1, mirror: false, loop: true }, lsGet('dansuri:player'));
  const savePrefs = () => lsSet('dansuri:player', prefs);

  const video = h('video', { class: 'pl-video', playsinline: true, 'webkit-playsinline': true, preload: 'auto', disablepictureinpicture: true });
  video.loop = prefs.loop;
  const poster = h('img', { class: 'pl-poster', alt: '' });
  const ringFg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  const loading = h('div', { class: 'pl-loading', hidden: true });
  const flash = h('div', { class: 'pl-flash', 'aria-hidden': 'true' });
  const stage = h('div', { class: 'pl-stage' }, poster, video, loading, flash);

  const closeBtn = h('button', { class: 'pl-btn', 'aria-label': 'Închide', onclick: () => dismiss() }, icon('x'));
  const counter = h('div', { class: 'pl-counter' });
  const favBtn = h('button', { class: 'pl-btn', 'aria-label': 'Favorit', onclick: () => { app.toggleFav(cur().id); haptic(8); } }, icon('star'));
  const moreBtn = h('button', { class: 'pl-btn', 'aria-label': 'Mai multe', onclick: () => app.mediaMenu(cur().id, { fromPlayer: true }) }, icon('more'));
  const top = h('div', { class: 'pl-top' }, closeBtn, counter, h('div', { class: 'pl-top-right' }, favBtn, moreBtn));

  const titleEl = h('button', { class: 'pl-title', onclick: () => app.editMedia(cur().id) });
  const metaEl = h('div', { class: 'pl-meta' });
  const info = h('div', { class: 'pl-info' }, titleEl, metaEl);

  const tCur = h('span', { class: 'pl-time' }, '0:00');
  const tDur = h('span', { class: 'pl-time' }, '0:00');
  const range = h('input', { type: 'range', class: 'pl-range', min: 0, max: 1000, value: 0, step: 1, 'aria-label': 'Poziție' });
  const scrub = h('div', { class: 'pl-scrub' }, tCur, range, tDur);

  const playBtn = h('button', { class: 'pl-btn pl-play', 'aria-label': 'Redă', onclick: () => togglePlay() }, icon('play'));
  const transport = h('div', { class: 'pl-transport' },
    h('button', { class: 'pl-btn', 'aria-label': 'Clipul anterior', onclick: () => go(-1) }, icon('skipPrev')),
    h('button', { class: 'pl-btn pl-seek', 'aria-label': 'Înapoi 5 secunde', onclick: () => seekBy(-5) }, '−5'),
    playBtn,
    h('button', { class: 'pl-btn pl-seek', 'aria-label': 'Înainte 5 secunde', onclick: () => seekBy(5) }, '+5'),
    h('button', { class: 'pl-btn', 'aria-label': 'Clipul următor', onclick: () => go(1) }, icon('skipNext')));

  const speedBtns = SPEEDS.map((sp) => h('button', { class: 'seg-btn', onclick: () => setSpeed(sp), 'aria-pressed': 'false' }, speedLabel(sp)));
  const mirrorBtn = h('button', { class: 'pl-toggle', onclick: () => setMirror(!prefs.mirror), 'aria-pressed': 'false' }, icon('mirror'), h('span', null, 'Oglindă'));
  const loopBtn = h('button', { class: 'pl-toggle icon-only', onclick: () => setLoop(!prefs.loop), 'aria-pressed': 'false', 'aria-label': 'Repetă clipul', title: 'Repetă clipul' }, icon('repeat'));
  const tools = h('div', { class: 'pl-tools' }, h('div', { class: 'seg', role: 'group', 'aria-label': 'Viteză' }, speedBtns), mirrorBtn, loopBtn);

  const unmute = h('button', { class: 'pl-unmute', hidden: true, onclick: () => { video.muted = false; unmute.hidden = true; } }, icon('muted'), 'Atinge pentru sunet');

  const sortBar = h('div', { class: 'pl-sort', hidden: !sortMode });
  const bottom = h('div', { class: 'pl-bottom' }, info, scrub, transport, tools, sortBar);
  const root = h('div', { class: 'player' + (sortMode ? ' sorting' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Clip' }, stage, top, unmute, bottom);

  let idx = clamp(index, 0, list.length - 1);
  let loadToken = 0;
  let progressFn = null;
  let wakeLock = null;
  let hideTimer = null;
  let scrubbing = false;
  const sortedHere = new Set();

  const cur = () => app.store.state.media[list[idx]];

  // ---------- loading ----------
  function setLoading(received, total) {
    if (received == null) { loading.hidden = true; return; }
    loading.hidden = false;
    const pct = total ? Math.round((received / total) * 100) : 0;
    loading.replaceChildren(
      h('div', { class: 'pl-ring', style: { '--p': pct } }, h('span', null, `${pct}%`)),
      h('div', { class: 'pl-loading-text' }, total ? `${fmtBytes(received)} din ${fmtBytes(total)}` : 'Se descarcă…'));
  }

  async function load() {
    const item = cur();
    if (!item) return;
    const token = ++loadToken;
    if (progressFn) { const prev = P?.lastItem; if (prev) stopListening(prev, progressFn); }
    P && (P.lastItem = item);
    video.pause();
    video.removeAttribute('src');
    video.load();
    root.classList.remove('ready');
    poster.src = cachedThumbUrl(item.id) || '';
    if (!poster.src) thumbUrl(item, 10).then((u) => { if (token === loadToken && u) poster.src = u; }).catch(() => {});
    refresh();
    setLoading(0, item.size);
    progressFn = (r, t) => { if (token === loadToken) setLoading(r, t); };
    try {
      const url = await videoUrl(item, progressFn);
      if (token !== loadToken) return;
      setLoading(null);
      video.src = url;
      video.playbackRate = prefs.speed;
      video.defaultPlaybackRate = prefs.speed;
      video.loop = prefs.loop;
      try { await video.play(); }
      catch {
        video.muted = true;
        unmute.hidden = false;
        await video.play().catch(() => {});
      }
      root.classList.add('ready');
      const next = app.store.state.media[list[idx + 1]];
      if (next) prefetchVideo(next).catch(() => {});
    } catch (e) {
      if (token !== loadToken) return;
      console.warn(e);
      loading.hidden = false;
      loading.replaceChildren(
        h('p', { class: 'pl-error' }, e?.status === 404 ? 'Fișierul clipului lipsește din repo.' : !navigator.onLine ? 'Nu ai internet, iar clipul nu e descărcat pe acest telefon.' : `Clipul nu s-a putut încărca (${e?.message || 'eroare'}).`),
        h('button', { class: 'btn btn-secondary', onclick: () => load() }, 'Reîncearcă'));
    }
  }

  // ---------- UI state ----------
  function refresh() {
    const item = cur();
    if (!item) return dismiss();
    const d = app.store.d;
    counter.textContent = sortMode ? `${Math.min(sortedHere.size + 1, list.length)} din ${list.length}` : `${idx + 1} / ${list.length}`;
    const fav = d.favSet.has(item.id);
    favBtn.classList.toggle('on', fav);
    favBtn.setAttribute('aria-pressed', String(fav));
    favBtn.replaceChildren(icon('star', fav ? 'filled' : ''));
    titleEl.replaceChildren(item.name ? item.name : h('span', { class: 'pl-title-empty' }, 'Adaugă un nume'), icon('edit', 'pl-title-edit'));
    const cats = (d.catOf[item.id] || []).map((cid) => app.store.state.cats[cid]).filter(Boolean);
    setChildren(metaEl,
      ...cats.map((c) => h('span', { class: 'chip-mini', style: { '--c': c.color } }, d.path(c.id).map((x) => x.name).join(' › '))),
      cats.length ? null : h('span', { class: 'chip-mini muted' }, 'Nesortat'),
      item.notes ? h('p', { class: 'pl-notes' }, item.notes) : null);
    speedBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(SPEEDS[i] === prefs.speed)));
    mirrorBtn.setAttribute('aria-pressed', String(prefs.mirror));
    loopBtn.setAttribute('aria-pressed', String(prefs.loop));
    video.classList.toggle('mirrored', prefs.mirror);
    poster.classList.toggle('mirrored', prefs.mirror);
    if (sortMode) renderSortBar();
  }

  function renderSortBar() {
    const d = app.store.d;
    const chips = d.tree.map(({ id, depth }) => {
      const c = app.store.state.cats[id];
      return h('button', { class: 'sort-chip', style: { '--c': c.color }, onclick: () => sortInto(id) },
        depth ? h('span', { class: 'sort-chip-parent' }, d.path(id).slice(0, -1).map((x) => x.name).join(' › ') + ' ›') : null,
        c.name);
    });
    sortBar.replaceChildren(
      h('div', { class: 'pl-sort-head' }, h('span', null, 'Unde îl pui?'),
        h('button', { class: 'linkish', onclick: () => app.createCategoryFor(cur().id).then((cid) => { if (cid) afterSort(); }) }, icon('plus'), 'Categorie nouă')),
      h('div', { class: 'pl-sort-chips no-swipe' }, chips),
      h('div', { class: 'pl-sort-foot' },
        h('button', { class: 'btn btn-ghost', onclick: () => { sortedHere.add(list[idx]); nextUnsorted(); } }, 'Sari peste'),
        h('button', { class: 'btn btn-ghost', onclick: () => dismiss() }, 'Gata pentru acum')));
  }

  function sortInto(catId) {
    app.moveMedia([cur().id], catId, { from: null, quiet: true });
    haptic(10);
    afterSort();
  }
  function afterSort() {
    sortedHere.add(list[idx]);
    flashText('✓');
    nextUnsorted();
  }
  function nextUnsorted() {
    const inbox = new Set(app.store.d.inbox);
    for (let k = 1; k <= list.length; k++) {
      const j = (idx + k) % list.length;
      if (!sortedHere.has(list[j]) && inbox.has(list[j])) { idx = j; return load(); }
    }
    app.toast(sortedHere.size ? 'Gata, ai trecut prin toate clipurile nesortate.' : 'Nu mai sunt clipuri nesortate.');
    dismiss();
  }

  function go(delta) {
    if (sortMode) { if (delta > 0) { sortedHere.add(list[idx]); nextUnsorted(); } return; }
    const j = idx + delta;
    if (j < 0 || j >= list.length) { flashText(j < 0 ? 'Primul clip' : 'Ultimul clip'); return; }
    idx = j;
    load();
  }

  function togglePlay() {
    if (!video.src) return;
    if (video.paused) { video.play().catch(() => {}); flashIcon('play'); }
    else { video.pause(); flashIcon('pause'); }
    showControls();
  }

  function seekBy(sec) {
    if (!video.duration) return;
    video.currentTime = clamp(video.currentTime + sec, 0, video.duration - 0.05);
    flashText(sec > 0 ? `+${sec}s` : `−${-sec}s`);
    showControls();
  }

  function setSpeed(sp) { prefs.speed = sp; video.playbackRate = sp; video.defaultPlaybackRate = sp; savePrefs(); refresh(); flashText(speedLabel(sp) + (sp === 1 ? '' : '×')); }
  function setMirror(on) { prefs.mirror = on; savePrefs(); refresh(); flashText(on ? 'Oglindă pornită' : 'Oglindă oprită'); }
  function setLoop(on) { prefs.loop = on; video.loop = on; savePrefs(); refresh(); flashText(on ? 'Repetă clipul' : 'Nu mai repetă'); }

  function flashIcon(name) { flash.replaceChildren(icon(name)); pulse(); }
  function flashText(t) { flash.replaceChildren(h('span', null, t)); pulse(); }
  function pulse() { flash.classList.remove('show'); void flash.offsetWidth; flash.classList.add('show'); }

  function showControls() {
    root.classList.remove('idle');
    clearTimeout(hideTimer);
    if (!video.paused) hideTimer = setTimeout(() => { if (!scrubbing && !video.paused && !sortMode) root.classList.add('idle'); }, 3200);
  }

  async function lockScreen(on) {
    try {
      if (on && !wakeLock && 'wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
      else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch {}
  }

  // ---------- events ----------
  video.addEventListener('play', () => { playBtn.replaceChildren(icon('pause')); playBtn.setAttribute('aria-label', 'Pauză'); lockScreen(true); showControls(); });
  video.addEventListener('pause', () => { playBtn.replaceChildren(icon('play')); playBtn.setAttribute('aria-label', 'Redă'); lockScreen(false); showControls(); });
  video.addEventListener('loadedmetadata', () => { tDur.textContent = fmtDur(video.duration); });
  const updateTime = () => {
    if (!scrubbing && video.duration) {
      range.value = String(Math.round((video.currentTime / video.duration) * 1000));
      range.style.setProperty('--fill', `${(video.currentTime / video.duration) * 100}%`);
    }
    tCur.textContent = fmtDur(video.currentTime);
  };
  video.addEventListener('timeupdate', updateTime);
  video.addEventListener('ended', () => { if (!prefs.loop && !sortMode) go(1); });
  range.addEventListener('input', () => {
    scrubbing = true;
    if (video.duration) {
      video.currentTime = (range.value / 1000) * video.duration;
      range.style.setProperty('--fill', `${range.value / 10}%`);
      tCur.textContent = fmtDur(video.currentTime);
    }
  });
  range.addEventListener('change', () => { scrubbing = false; showControls(); });

  // Tap = play/pause; horizontal swipe = next/previous; swipe down = close.
  let g = null;
  stage.addEventListener('pointerdown', (e) => { g = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  stage.addEventListener('pointerup', (e) => {
    if (!g) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    g = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.4) return go(dx < 0 ? 1 : -1);
    if (dy > 110 && Math.abs(dy) > Math.abs(dx) * 1.4) return dismiss();
    if (Math.abs(dx) < 12 && Math.abs(dy) < 12) {
      if (root.classList.contains('idle')) showControls();
      else togglePlay();
    }
  });
  stage.addEventListener('pointercancel', () => { g = null; });
  root.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') showControls(); });
  bottom.addEventListener('pointerdown', () => showControls());

  const onKey = (e) => {
    if (e.target.closest('input[type=text], textarea') || document.querySelector('.sheet.open, .dialog.open')) return;
    const k = e.key;
    if (k === ' ' || k === 'k') { e.preventDefault(); togglePlay(); }
    else if (k === 'ArrowLeft' || k === 'j') seekBy(-5);
    else if (k === 'ArrowRight' || k === 'l') seekBy(5);
    else if (k === 'ArrowDown' || k === 'PageDown') go(1);
    else if (k === 'ArrowUp' || k === 'PageUp') go(-1);
    else if (k === 'm') setMirror(!prefs.mirror);
    else if (k === 'r') setLoop(!prefs.loop);
    else if (k === ',') setSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(prefs.speed) - 1)]);
    else if (k === '.') setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(prefs.speed) + 1)]);
    else if (k === 'f') app.toggleFav(cur().id);
    else if (k === 'Escape') dismiss();
  };
  document.addEventListener('keydown', onKey);
  const onVis = () => { if (document.hidden) video.pause(); };
  document.addEventListener('visibilitychange', onVis);

  // ---------- open / close ----------
  const close = () => {
    loadToken++;
    video.pause();
    video.removeAttribute('src');
    video.load();
    lockScreen(false);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVis);
    clearTimeout(hideTimer);
    root.classList.remove('open');
    document.documentElement.classList.remove('player-open');
    setTimeout(() => root.remove(), 200);
    P = null;
    app.onPlayerClosed?.();
  };
  const dismiss = pushOverlay(close);

  P = { refresh, lastItem: null };
  document.getElementById('overlays').append(root);
  document.documentElement.classList.add('player-open');
  requestAnimationFrame(() => root.classList.add('open'));
  load();
}

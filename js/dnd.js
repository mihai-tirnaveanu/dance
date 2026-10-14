// Drag & drop for tiles: long-press on touch screens, press-and-move with a mouse.
// Tiles:      [data-drag][data-id][data-kind] inside a container [data-grid="<list>"]
// Drop zones: [data-zone] anywhere on the page (tray chips, subcategory chips).
import { haptic, reducedMotion } from './util.js';

const HOLD_MS = 380;
const SLOP = 10;

export function setupDnd(opts) {
  const { root } = opts;
  let s = null; // current gesture
  let suppressUntil = 0;
  let suppressEl = null; // null = any element
  let lastPointerType = 'mouse';

  const now = () => performance.now();
  // Swallow the click the browser sends right after a long-press or a drop,
  // without blocking a quick tap on another clip.
  const suppressClick = (el = null, ms = 450) => { suppressUntil = now() + ms; suppressEl = el; };

  root.addEventListener('click', (e) => {
    if (now() < suppressUntil && (!suppressEl || suppressEl.contains(e.target))) { e.stopPropagation(); e.preventDefault(); }
  }, true);

  root.addEventListener('contextmenu', (e) => {
    const el = e.target.closest('[data-drag]');
    if (!el || e.target.closest('[data-nodrag]')) return;
    e.preventDefault();
    if (lastPointerType === 'mouse' && (!s || s.state !== 'dragging')) opts.onHold?.(info(el), { via: 'mouse' });
  });

  function info(el) {
    return { el, id: el.dataset.id, kind: el.dataset.kind, grid: el.closest('[data-grid]') };
  }

  // ---------- touch ----------
  root.addEventListener('touchstart', (e) => {
    lastPointerType = 'touch';
    if (s) { if (e.touches.length > 1) cancel(); return; }
    if (e.touches.length !== 1) return;
    const el = e.target.closest('[data-drag]');
    if (!el || e.target.closest('[data-nodrag]') || opts.canDrag?.(info(el)) === false) return;
    const t = e.touches[0];
    s = { state: 'pressing', el, x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY, touchId: t.identifier };
    s.timer = setTimeout(arm, HOLD_MS);
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!s || s.touchId == null) return;
    const t = [...e.changedTouches].find((x) => x.identifier === s.touchId);
    if (!t) return;
    s.x = t.clientX; s.y = t.clientY;
    if (s.state === 'pressing') {
      if (Math.hypot(s.x - s.x0, s.y - s.y0) > SLOP) { clearTimeout(s.timer); s = null; }
      return;
    }
    if (e.cancelable) e.preventDefault();
    if (s.state === 'armed' && Math.hypot(s.x - s.ax, s.y - s.ay) > 6) startDrag();
    else if (s.state === 'dragging') move();
  }, { passive: false });

  const touchEnd = (e) => {
    if (!s || s.touchId == null) return;
    if (![...e.changedTouches].some((x) => x.identifier === s.touchId)) return;
    if (e.type === 'touchcancel') return cancel();
    if (s.state === 'pressing') { clearTimeout(s.timer); s = null; return; }
    if (e.cancelable) e.preventDefault();
    if (s.state === 'armed') {
      const el = s.el;
      suppressClick(el);
      el.classList.remove('dnd-armed');
      s = null;
      opts.onHold?.(info(el), { via: 'touch' });
      return;
    }
    suppressClick();
    if (s.state === 'dragging') drop();
  };
  document.addEventListener('touchend', touchEnd, { passive: false });
  document.addEventListener('touchcancel', touchEnd);

  function arm() {
    if (!s || s.state !== 'pressing') return;
    s.state = 'armed';
    s.ax = s.x; s.ay = s.y;
    s.el.classList.add('dnd-armed');
    haptic(12);
  }

  // ---------- mouse ----------
  root.addEventListener('pointerdown', (e) => {
    lastPointerType = e.pointerType;
    if (e.pointerType !== 'mouse' || e.button !== 0 || s) return;
    const el = e.target.closest('[data-drag]');
    if (!el || e.target.closest('[data-nodrag], input, textarea') || opts.canDrag?.(info(el)) === false) return;
    s = { state: 'pressing-mouse', el, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    window.addEventListener('pointermove', onMouseMove);
    window.addEventListener('pointerup', onMouseUp);
  });
  root.addEventListener('dragstart', (e) => { if (e.target.closest?.('[data-drag]')) e.preventDefault(); });

  function onMouseMove(e) {
    if (!s || e.pointerId !== s.pointerId) return;
    s.x = e.clientX; s.y = e.clientY;
    if (s.state === 'pressing-mouse' && Math.hypot(s.x - s.x0, s.y - s.y0) > 6) startDrag();
    else if (s.state === 'dragging') move();
  }
  function onMouseUp(e) {
    if (!s || e.pointerId !== s.pointerId) return;
    window.removeEventListener('pointermove', onMouseMove);
    window.removeEventListener('pointerup', onMouseUp);
    if (s.state === 'dragging') { suppressClick(); drop(); }
    else s = null;
  }

  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && s?.state === 'dragging') cancel(); });
  window.addEventListener('blur', () => { if (s) cancel(); });

  // ---------- dragging ----------
  function startDrag() {
    const el = s.el;
    el.classList.remove('dnd-armed');
    const r = el.getBoundingClientRect();
    s.state = 'dragging';
    s.offX = s.x - r.left; s.offY = s.y - r.top;
    s.info = info(el);
    s.grid = s.info.grid;
    s.reorder = !!s.grid && s.grid.dataset.grid !== 'none' && opts.canReorder?.(s.info) !== false;
    s.startNext = nextTile(el);
    const ghost = el.cloneNode(true);
    ghost.classList.add('dnd-ghost');
    ghost.removeAttribute('data-drag');
    Object.assign(ghost.style, { width: r.width + 'px', height: r.height + 'px', left: '0px', top: '0px' });
    document.body.append(ghost);
    s.ghost = ghost;
    el.classList.add('dnd-placeholder');
    document.documentElement.classList.add('dnd-active');
    haptic(8);
    opts.onStart?.(s.info);
    move();
    s.raf = requestAnimationFrame(tick);
  }

  function nextTile(el) {
    let n = el.nextElementSibling;
    while (n && !n.matches('[data-drag]')) n = n.nextElementSibling;
    return n;
  }

  function move() {
    if (!s || s.state !== 'dragging') return;
    s.ghost.style.transform = `translate3d(${s.x - s.offX}px, ${s.y - s.offY}px, 0) scale(1.06)`;
    hitTest();
  }

  function hitTest() {
    const target = document.elementFromPoint(s.x, s.y);
    let zone = target?.closest('[data-zone]') || null;
    while (zone && (zone === s.el || !(zone.dataset.accept || 'media').split(' ').includes(s.info.kind))) {
      zone = zone.parentElement?.closest('[data-zone]') || null;
    }
    if (zone !== s.zone) {
      s.zone?.classList.remove('dnd-over');
      zone?.classList.add('dnd-over');
      if (zone && zone !== s.zone) haptic(6);
      s.zone = zone;
    }
    opts.onMove?.({ x: s.x, y: s.y, zone, info: s.info });
    if (zone || !s.reorder) return;
    const tile = target?.closest('[data-drag]');
    if (!tile || tile === s.el || tile.parentElement !== s.el.parentElement) return;
    if (now() < (s.cooldown || 0)) return;
    const kids = [...s.el.parentElement.children];
    const from = kids.indexOf(s.el), to = kids.indexOf(tile);
    flip(s.el.parentElement, () => {
      if (from < to) tile.after(s.el);
      else tile.before(s.el);
    });
    s.cooldown = now() + 140;
  }

  function tick() {
    if (!s || s.state !== 'dragging') return;
    const vh = window.innerHeight;
    const top = opts.topInset?.() ?? 70;
    const bottom = vh - (opts.bottomInset?.() ?? 0);
    const edge = 72;
    let dy = 0;
    if (!s.zone) {
      if (s.y < top + edge) dy = -Math.ceil(((top + edge - s.y) / edge) * 16);
      else if (s.y > bottom - edge && s.y < bottom) dy = Math.ceil(((s.y - (bottom - edge)) / edge) * 16);
    }
    // Scroll inner lists marked [data-autoscroll] (e.g. the tray) when near their edges.
    const scroller = document.elementFromPoint(s.x, s.y)?.closest('[data-autoscroll]');
    if (scroller) {
      const r = scroller.getBoundingClientRect();
      if (s.y < r.top + 36) scroller.scrollTop -= 8;
      else if (s.y > r.bottom - 36) scroller.scrollTop += 8;
    }
    if (dy) { window.scrollBy(0, dy); hitTest(); }
    s.raf = requestAnimationFrame(tick);
  }

  function finish(animateTo, fade) {
    const { ghost, el } = s;
    cancelAnimationFrame(s.raf);
    s.zone?.classList.remove('dnd-over');
    document.documentElement.classList.remove('dnd-active');
    const cleanup = () => { ghost.remove(); el.classList.remove('dnd-placeholder'); };
    if (reducedMotion() || !animateTo) cleanup();
    else {
      ghost.style.transition = 'transform 180ms ease, opacity 180ms ease';
      ghost.style.transform = animateTo;
      if (fade) ghost.style.opacity = '0';
      setTimeout(cleanup, 190);
    }
    s = null;
  }

  function drop() {
    const st = s;
    const r = st.el.getBoundingClientRect();
    let result;
    if (st.zone) {
      const z = st.zone.getBoundingClientRect();
      result = { type: 'zone', zone: st.zone, data: { ...st.zone.dataset } };
      finish(`translate3d(${z.left + z.width / 2 - 20}px, ${z.top + z.height / 2 - 20}px, 0) scale(0.25)`, true);
    } else {
      const next = nextTile(st.el);
      const moved = st.reorder && next !== st.startNext;
      result = moved ? { type: 'reorder', beforeId: next ? next.dataset.id : null } : { type: 'cancel' };
      finish(`translate3d(${r.left}px, ${r.top}px, 0) scale(1)`);
    }
    opts.onDrop?.(st.info, result);
  }

  function cancel() {
    if (!s) return;
    if (s.state === 'pressing') clearTimeout(s.timer);
    if (s.state === 'armed') s.el.classList.remove('dnd-armed');
    if (s.state !== 'dragging') { s = null; return; }
    const st = s;
    // Put the placeholder back where it started.
    if (st.reorder) {
      flip(st.el.parentElement, () => { if (st.startNext) st.startNext.before(st.el); else st.el.parentElement.append(st.el); });
    }
    const r = st.el.getBoundingClientRect();
    finish(`translate3d(${r.left}px, ${r.top}px, 0) scale(1)`);
    opts.onDrop?.(st.info, { type: 'cancel' });
  }

  return {
    get active() { return !!s && s.state === 'dragging'; },
    cancel,
  };
}

/** Animate siblings from their old to their new positions after a DOM change. */
export function flip(container, mutate) {
  if (reducedMotion()) return mutate();
  const kids = [...container.children];
  const first = new Map(kids.map((k) => [k, k.getBoundingClientRect()]));
  mutate();
  for (const k of kids) {
    const a = first.get(k), b = k.getBoundingClientRect();
    const dx = a.left - b.left, dy = a.top - b.top;
    if (!dx && !dy) continue;
    k.style.transition = 'none';
    k.style.transform = `translate(${dx}px, ${dy}px)`;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      k.style.transition = 'transform 180ms cubic-bezier(.2,.8,.2,1)';
      k.style.transform = '';
      setTimeout(() => { k.style.transition = ''; }, 200);
    }));
  }
}

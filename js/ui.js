// Overlays (sheets, dialogs) wired to the browser history so the phone's
// Back button closes them, plus toasts.
import { h, icon } from './util.js';

const stack = [];
let popResolvers = [];

window.addEventListener('popstate', () => {
  const top = stack.pop();
  if (top) top.close();
  const rs = popResolvers;
  popResolvers = [];
  rs.forEach((r) => r());
});

export function overlayOpen() { return stack.length > 0; }

/** Register an overlay. Returns a function that dismisses it (via history.back()). */
export function pushOverlay(close) {
  const entry = { close };
  stack.push(entry);
  history.pushState({ overlay: stack.length }, '');
  return () => dismiss(entry);
}

export function dismiss(entry) {
  return new Promise((resolve) => {
    if (!stack.includes(entry)) return resolve();
    // Close any overlays opened above this one too.
    const n = stack.length - stack.indexOf(entry);
    popResolvers.push(resolve);
    history.go(-n);
    if (n > 1) {
      // history.go(-n) fires a single popstate; close the extra ones now.
      for (let i = 0; i < n - 1; i++) stack.pop()?.close();
    }
  });
}

export function dismissAll() {
  if (!stack.length) return Promise.resolve();
  return dismiss(stack[0]);
}

const layer = () => document.getElementById('overlays');

// ---------- Sheet (bottom sheet on phones, centered panel on wide screens) ----------
export function sheet({ title, subtitle, items, content, className = '', header, onClose }) {
  let closed = false;
  let chosen = null;
  const panel = h('div', { class: 'sheet-panel ' + className, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '' });
  const backdrop = h('div', { class: 'sheet-backdrop' });
  const wrap = h('div', { class: 'sheet' }, backdrop, panel);

  const close = () => {
    if (closed) return;
    closed = true;
    wrap.classList.remove('open');
    wrap.classList.add('closing');
    setTimeout(() => wrap.remove(), 220);
    onClose?.(chosen);
  };
  const doDismiss = pushOverlay(close);

  panel.append(h('div', { class: 'sheet-handle', 'aria-hidden': 'true' }));
  if (header) panel.append(header);
  else if (title) panel.append(h('div', { class: 'sheet-head' }, h('h2', { class: 'sheet-title' }, title), subtitle ? h('p', { class: 'sheet-sub' }, subtitle) : null));
  if (items) {
    const list = h('div', { class: 'sheet-items', role: 'menu' });
    for (const it of items) {
      if (!it) continue;
      if (it.sep) { list.append(h('div', { class: 'sheet-sep' })); continue; }
      list.append(h('button', {
        class: 'sheet-item' + (it.danger ? ' danger' : '') + (it.active ? ' active' : ''),
        role: 'menuitem',
        disabled: it.disabled,
        style: it.indent ? { paddingLeft: `${20 + it.indent * 18}px` } : null,
        onclick: async () => {
          if (it.keepOpen) return it.onClick?.();
          chosen = it;
          await doDismiss();
          it.onClick?.();
        },
      },
      it.swatch ? h('span', { class: 'swatch', style: { background: it.swatch } }) : it.icon ? icon(it.icon) : null,
      h('span', { class: 'sheet-item-label' }, it.label),
      it.hint ? h('span', { class: 'sheet-item-hint' }, it.hint) : null));
    }
    panel.append(list);
  }
  if (content) panel.append(content);

  backdrop.addEventListener('click', () => doDismiss());
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); doDismiss(); } });
  enableSwipeDown(panel, () => doDismiss());

  layer().append(wrap);
  requestAnimationFrame(() => {
    wrap.classList.add('open');
    const first = panel.querySelector('input, textarea, .sheet-item:not([disabled]), button');
    if (first && !matchMedia('(pointer: coarse)').matches) first.focus({ preventScroll: true });
  });
  return { el: panel, dismiss: doDismiss };
}

function enableSwipeDown(panel, onClose) {
  let y0 = null, dy = 0;
  panel.addEventListener('touchstart', (e) => {
    const t = e.target;
    if (panel.scrollTop > 0 || t.closest('input, textarea, .no-swipe')) { y0 = null; return; }
    y0 = e.touches[0].clientY; dy = 0;
  }, { passive: true });
  panel.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    dy = e.touches[0].clientY - y0;
    if (dy > 0) panel.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  panel.addEventListener('touchend', () => {
    if (y0 == null) return;
    panel.style.transform = '';
    if (dy > 90) onClose();
    y0 = null;
  });
}

// ---------- Dialog ----------
export function dialog({ title, body, actions, className = '' }) {
  return new Promise((resolve) => {
    let closed = false, result;
    const card = h('form', { class: 'dialog-card ' + className, role: 'dialog', 'aria-modal': 'true', 'aria-label': title, novalidate: true });
    const wrap = h('div', { class: 'dialog' }, h('div', { class: 'dialog-backdrop' }), card);
    const close = () => {
      if (closed) return;
      closed = true;
      wrap.classList.remove('open');
      setTimeout(() => wrap.remove(), 180);
      resolve(result);
    };
    const doDismiss = pushOverlay(close);
    const finish = (value) => { result = value; doDismiss(); };

    card.append(h('h2', { class: 'dialog-title' }, title));
    if (body) card.append(h('div', { class: 'dialog-body' }, body));
    const bar = h('div', { class: 'dialog-actions' });
    for (const a of actions) {
      const btn = h('button', { type: a.primary ? 'submit' : 'button', class: 'btn ' + (a.primary ? 'btn-primary' : a.danger ? 'btn-danger' : 'btn-ghost') }, a.label);
      if (!a.primary) btn.addEventListener('click', async () => {
        const v = a.onClick ? await a.onClick() : a.value;
        if (v !== false) finish(v);
      });
      bar.append(btn);
    }
    card.append(bar);
    card.addEventListener('submit', async (e) => {
      e.preventDefault();
      const a = actions.find((x) => x.primary);
      const v = a?.onClick ? await a.onClick() : a?.value;
      if (v !== false) finish(v);
    });
    wrap.querySelector('.dialog-backdrop').addEventListener('click', () => finish(undefined));
    wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); finish(undefined); } });
    layer().append(wrap);
    requestAnimationFrame(() => {
      wrap.classList.add('open');
      const f = card.querySelector('input, textarea');
      if (f) { f.focus(); if (f.select && f.value) f.select(); }
      else card.querySelector('.btn-primary, .btn-danger')?.focus();
    });
  });
}

export function confirmDialog({ title, message, confirmLabel = 'Confirmă', danger = false }) {
  return dialog({
    title,
    body: message ? h('p', { class: 'dialog-text' }, message) : null,
    actions: [
      { label: 'Anulează', value: false },
      danger ? { label: confirmLabel, danger: true, value: true } : { label: confirmLabel, primary: true, value: true },
    ],
  }).then((v) => v === true);
}

// ---------- Toast ----------
let toastEl = null, toastTimer = null;
export function toast(message, { action, onAction, duration = 4500, kind = '' } = {}) {
  const host = document.getElementById('toasts');
  if (toastEl) { toastEl.remove(); clearTimeout(toastTimer); }
  const el = h('div', { class: 'toast ' + kind, role: 'status', 'aria-live': 'polite' },
    h('span', { class: 'toast-msg' }, message),
    action ? h('button', { class: 'toast-action', onclick: () => { hide(); onAction?.(); } }, action) : null);
  const hide = () => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 200);
    if (toastEl === el) toastEl = null;
  };
  host.append(el);
  toastEl = el;
  requestAnimationFrame(() => el.classList.add('show'));
  toastTimer = setTimeout(hide, duration);
  return hide;
}

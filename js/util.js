import { ICONS } from './icons.js';

const SVGNS = 'http://www.w3.org/2000/svg';

/** Hyperscript helper: h('div', {class: 'x', onclick}, child, [children]) */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [sk, sv] of Object.entries(v)) {
          if (sv == null) continue;
          if (sk.startsWith('--')) el.style.setProperty(sk, sv);
          else el.style[sk] = sv;
        }
      }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Replace an element's children; accepts nested arrays, strings and null like h(). */
export function setChildren(el, ...children) {
  el.replaceChildren();
  return append(el, children);
}

export function icon(name, cls = '') {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'ic ' + cls);
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

/** Romanian plural: 1 clip, 2 clipuri, 20 de clipuri, 101 clipuri. */
export function plural(n, one, many, { withNumber = true } = {}) {
  let word;
  if (n === 1) word = one;
  else {
    const r = n % 100;
    word = n === 0 || (r >= 1 && r <= 19) ? many : 'de ' + many;
  }
  return withNumber ? `${n} ${word}` : word;
}

export const clips = (n) => plural(n, 'clip', 'clipuri');

export function fmtDur(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const nf1 = new Intl.NumberFormat('ro-RO', { maximumFractionDigits: 1 });
export function fmtBytes(n) {
  if (!n) return '0 MB';
  if (n < 1024 * 1024) return nf1.format(n / 1024) + ' KB';
  if (n < 1024 * 1024 * 1024) return nf1.format(n / 1024 / 1024) + ' MB';
  return nf1.format(n / 1024 / 1024 / 1024) + ' GB';
}

const dateFmt = new Intl.DateTimeFormat('ro-RO', { day: 'numeric', month: 'long', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('ro-RO', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Dates are stored as local, timezone-less ISO strings ("2026-10-10T19:34:24"). */
export function parseLocal(iso) {
  if (!iso) return new Date(0);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(iso);
  if (!m) return new Date(iso);
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}
export const fmtDay = (iso) => dateFmt.format(parseLocal(iso));
export const fmtDateTime = (iso) => dateTimeFmt.format(parseLocal(iso));

export function toLocalIso(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

export function uid(len = 10) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function debounce(fn, ms) {
  let t;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  d.flush = (...args) => { clearTimeout(t); fn(...args); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export function haptic(ms = 12) {
  try { navigator.vibrate?.(ms); } catch {}
}

export function normalize(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function lsGet(key, fallback = null) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
export function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}
export function lsDel(key) {
  try { localStorage.removeItem(key); } catch {}
}

/** Run async tasks with limited concurrency, highest priority first. */
export class Queue {
  constructor(concurrency = 4) { this.c = concurrency; this.running = 0; this.items = []; }
  push(fn, priority = 0) {
    return new Promise((resolve, reject) => {
      this.items.push({ fn, priority, resolve, reject });
      this.items.sort((a, b) => b.priority - a.priority);
      this.next();
    });
  }
  next() {
    while (this.running < this.c && this.items.length) {
      const it = this.items.shift();
      this.running++;
      Promise.resolve().then(it.fn).then(it.resolve, it.reject).finally(() => { this.running--; this.next(); });
    }
  }
}

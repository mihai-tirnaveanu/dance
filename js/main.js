import { CONFIG } from './config.js';
import { h, icon, setChildren, clips, plural, fmtDur, fmtBytes, fmtDay, fmtDateTime, uid, lsGet, lsSet, lsDel, debounce, normalize, haptic } from './util.js';
import { GitHub, isNetworkError } from './gh.js';
import { Store } from './store.js';
import * as media from './media.js';
import * as convert from './convert.js';
import { sheet, dialog, confirmDialog, toast, pushOverlay, dismissAll, overlayOpen } from './ui.js';
import { setupDnd } from './dnd.js';
import { openPlayer, refreshPlayer, playerOpen } from './player.js';
import qrcode from '../vendor/qrcode.mjs';

const COLORS = ['#ff6b4a', '#ec4f8f', '#35b5ac', '#f3b443', '#9a7bff', '#4fa7f0', '#9ccf63', '#dcb48c'];
const EMOJIS = ['', '💃', '🕺', '🔥', '⭐', '💜', '❤️', '🌙', '🌀', '👣', '🎯', '🏆', '🎵'];
const MAX_UPLOAD = convert.MAX_UPLOAD;

const settings = Object.assign({ cols: 3, sortAll: 'new', sortInbox: 'new' }, lsGet('dansuri:settings', {}));
const saveSettings = () => lsSet('dansuri:settings', settings);

const store = new Store();
const app = {
  store,
  gh: null,
  ctx: { list: [], listId: 'none', title: '' },
  selection: null,
  toast: (msg, o) => toast(msg, o),
};
window.__dansuri = app; // handy for debugging from the console

let dnd = null;
let renderPending = false;
let installPrompt = null;
const scrollMemory = new Map();
let currentKey = null;

// ---------------------------------------------------------------- shell
function shell() {
  const root = document.getElementById('app');
  root.replaceChildren(
    h('main', { id: 'view' }),
    h('div', { id: 'tray', class: 'tray', hidden: true }),
    h('div', { id: 'selbar', class: 'selbar', hidden: true }),
    h('button', { id: 'fab', class: 'fab', 'aria-label': 'Încarcă clipuri', hidden: true, onclick: () => pickFiles() }, icon('plus')),
    h('div', { id: 'uploads', class: 'uploads', hidden: true }),
    h('input', { id: 'file-input', type: 'file', accept: 'video/*', multiple: true, hidden: true, onchange: (e) => { const files = [...e.target.files]; e.target.value = ''; if (files.length) startUpload(files, uploadTarget()); } }),
    h('div', { id: 'toasts', class: 'toasts' }),
    h('div', { id: 'overlays' }));
  document.documentElement.style.setProperty('--cols', settings.cols);
}

// ---------------------------------------------------------------- routing
function route() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [name, ...rest] = raw.split('/');
  return { name: name || 'home', arg: rest.length ? decodeURIComponent(rest.join('/')) : null, key: raw || 'home' };
}
const nav = (path) => { location.hash = '#/' + path; };

// Track in-app navigation so the on-screen Back arrow and the phone's Back button agree.
const navStack = [];
let replacingNav = false;
function trackNav() {
  const key = route().key;
  if (replacingNav) { replacingNav = false; navStack[navStack.length - 1] = key; return; }
  if (navStack.length > 1 && navStack[navStack.length - 2] === key) navStack.pop();
  else if (navStack[navStack.length - 1] !== key) navStack.push(key);
}

window.addEventListener('hashchange', () => {
  if (location.hash.startsWith('#setup=')) return handleSetupLink();
  trackNav();
  if (currentKey) scrollMemory.set(currentKey, window.scrollY);
  if (app.selection) exitSelection(true);
  render(true);
});

// ---------------------------------------------------------------- render
function render(navigated = false) {
  if (!settings.token) return renderWelcome();
  if (dnd?.active) { renderPending = true; return; }
  const r = route();
  const views = { home: viewHome, c: viewCategory, nesortate: () => viewList('inbox'), favorite: () => viewList('favs'), toate: () => viewList('all'), cos: viewTrash, cauta: viewSearch, setari: viewSettings };
  const view = views[r.name] || viewHome;
  const y = window.scrollY;
  const node = view(r.arg);
  document.getElementById('view').replaceChildren(node);
  currentKey = r.key;
  window.scrollTo(0, navigated ? scrollMemory.get(r.key) || 0 : y);
  const fabViews = ['home', 'c', 'nesortate', 'favorite', 'toate'];
  document.getElementById('fab').hidden = !fabViews.includes(r.name) || !!app.selection;
  renderSelbar();
}

store.addEventListener('change', () => {
  render();
  refreshPlayer();
});
store.addEventListener('status', () => {
  document.querySelectorAll('.sync-btn').forEach((b) => b.replaceWith(syncButton()));
  const banner = document.querySelector('.auth-banner');
  if (store.status === 'auth' && !banner) render();
  if (store.status !== 'auth' && banner) render();
});

// ---------------------------------------------------------------- common pieces
function syncButton() {
  const st = store.status;
  const map = {
    saved: ['cloudCheck', 'Salvat pe GitHub', ''],
    idle: ['cloud', 'Sincronizare', ''],
    pending: ['spinner', 'Se salvează', 'spin'],
    saving: ['spinner', 'Se salvează', 'spin'],
    offline: ['cloudOff', 'Fără internet', 'warn'],
    error: ['alert', 'Eroare la salvare', 'bad'],
    auth: ['alert', 'Token invalid', 'bad'],
  };
  const [ic, label, cls] = map[st] || map.idle;
  return h('button', { class: `icon-btn sync-btn ${cls}`, 'aria-label': label, title: label, onclick: syncSheet }, icon(ic));
}

function syncSheet() {
  const st = store.status;
  const n = store.pending.length;
  const msg = {
    saved: 'Toate modificările sunt salvate în repo-ul tău GitHub.',
    idle: 'Se verifică biblioteca.',
    pending: `${plural(n, 'modificare', 'modificări')} se salvează acum.`,
    saving: `${plural(n, 'modificare', 'modificări')} se salvează acum.`,
    offline: `Nu ai internet. ${n ? plural(n, 'modificare așteaptă', 'modificări așteaptă') + ' și se salvează' : 'Modificările se salvează'} automat când revine conexiunea.`,
    error: `Salvarea a eșuat: ${store.error?.message || 'eroare necunoscută'}. Reîncerc automat.`,
    auth: 'GitHub nu mai acceptă token-ul. Pune unul nou în Setări.',
  }[st] || '';
  sheet({
    title: 'Sincronizare',
    subtitle: msg,
    items: [
      { icon: 'refresh', label: 'Verifică acum', onClick: () => { if (store.pending.length) store.save(); else store.refresh(); } },
      { icon: 'settings', label: 'Setări', onClick: () => nav('setari') },
    ],
  });
}

function appBar({ title, back, actions = [], brand = false, sub = null, color = null }) {
  return h('header', { class: 'appbar' + (brand ? ' brand' : '') },
    back ? h('button', { class: 'icon-btn', 'aria-label': 'Înapoi', onclick: () => goBack(back) }, icon('back')) : null,
    h('div', { class: 'appbar-title' },
      sub ? h('div', { class: 'appbar-sub' }, sub) : null,
      h('h1', { class: brand ? 'brand-title' : 'view-title', style: color ? { '--c': color } : null }, title)),
    h('div', { class: 'appbar-actions' }, syncButton(), ...actions));
}

function goBack(fallback) {
  const target = fallback === true ? 'home' : fallback;
  if (navStack.length > 1 && navStack[navStack.length - 2] === target) history.back();
  else { replacingNav = true; location.replace('#/' + (target === 'home' ? '' : target)); }
}

function authBanner() {
  if (store.status !== 'auth') return null;
  return h('div', { class: 'auth-banner' }, icon('alert'),
    h('span', null, 'GitHub nu mai acceptă token-ul. Modificările stau pe telefon până pui unul nou.'),
    h('button', { class: 'btn btn-small btn-primary', onclick: () => nav('setari') }, 'Schimbă'));
}

function emptyState(title, text, action) {
  return h('div', { class: 'empty-state' }, h('p', { class: 'empty-title' }, title), text ? h('p', { class: 'empty-text' }, text) : null, action || null);
}

// ---------------------------------------------------------------- tiles
const tileCache = new Map();
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    io.unobserve(e.target);
    loadThumb(e.target);
  }
}, { rootMargin: '400px 0px' });

function loadThumb(el) {
  const item = store.state.media[el.dataset.id];
  if (!item) return;
  const img = el.querySelector('img');
  media.thumbUrl(item, 1).then((url) => { if (url) { img.src = url; el.classList.add('has-img'); } }).catch(() => el.classList.add('no-img'));
}

function mediaTile(item, labels = null) {
  let el = tileCache.get(item.id);
  if (!el) {
    const more = h('button', { class: 'tile-more', type: 'button', 'aria-label': 'Opțiuni pentru clip', dataset: { nodrag: '' } }, icon('more'));
    more.addEventListener('click', (e) => { e.stopPropagation(); mediaMenu(el.dataset.id); });
    el = h('div', { class: 'tile', role: 'button', tabindex: '0', dataset: { drag: '', kind: 'media', id: item.id } },
      h('div', { class: 'tile-media' },
        h('img', { class: 'tile-img', alt: '', draggable: 'false', decoding: 'async' }),
        h('span', { class: 'tile-shade' }),
        h('span', { class: 'tile-name' }),
        h('span', { class: 'tile-dur' }),
        h('span', { class: 'tile-fav' }, icon('star', 'filled')),
        h('span', { class: 'tile-check' }, icon('check')),
        more),
      h('div', { class: 'tile-labels' }));
    el.addEventListener('click', () => onTileClick(el.dataset.id));
    el.addEventListener('keydown', (e) => {
      if (e.target !== el) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onTileClick(el.dataset.id); }
      else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); mediaMenu(el.dataset.id); }
    });
    const cached = media.cachedThumbUrl(item.id);
    if (cached) { el.querySelector('img').src = cached; el.classList.add('has-img'); }
    else io.observe(el);
    tileCache.set(item.id, el);
  }
  el.querySelector('.tile-dur').textContent = fmtDur(item.dur);
  el.querySelector('.tile-name').textContent = item.name || '';
  el.classList.toggle('named', !!item.name);
  el.classList.toggle('fav', store.d.favSet.has(item.id));
  el.classList.toggle('selected', !!app.selection?.ids.has(item.id));
  el.classList.toggle('landscape', item.w > item.h);
  // Subcategory labels under the clip (only in a category view that has subcategories).
  const box = el.querySelector('.tile-labels');
  box.replaceChildren(...(labels || []).map((c) => h('span', { class: 'tile-label', style: { '--c': c.color }, title: c.name }, c.name)));
  el.classList.toggle('has-labels', !!labels?.length);
  const where = labels?.length ? `, în ${labels.map((c) => c.name).join(', ')}` : '';
  el.setAttribute('aria-label', `${item.name || 'Clip fără nume'}, ${fmtDur(item.dur)}${where}`);
  return el;
}

function onTileClick(id) {
  if (app.selection) return toggleSelect(id);
  if (route().name === 'cos') return trashMenu(id);
  const list = app.ctx.list.includes(id) ? app.ctx.list : [id];
  openPlayer({ list, index: list.indexOf(id), app, title: app.ctx.title });
}

function grid(ids, listId, labelsFor = null) {
  const g = h('div', { class: 'grid' + (labelsFor ? ' with-labels' : ''), dataset: { grid: listId } });
  for (const id of ids) {
    const it = store.state.media[id];
    if (it) g.append(mediaTile(it, labelsFor ? labelsFor(id) : null));
  }
  return g;
}

/** Clips of a category and of all its subcategories: its own clips first, then the rest, in subcategory order. */
function categoryClips(id) {
  const d = store.d, s = store.state;
  const out = [], seen = new Set();
  const add = (cid) => {
    for (const m of d.items(cid)) if (!seen.has(m)) { seen.add(m); out.push(m); }
    for (const k of s.cats[cid]?.kids || []) add(k);
  };
  add(id);
  return out;
}

/** The subcategories (below `id`) that a clip belongs to, with names relative to `id`. */
function subLabels(id, mid) {
  const d = store.d, s = store.state;
  return (d.catOf[mid] || [])
    .filter((c) => c !== id && d.isDescendant(c, id))
    .map((c) => {
      const path = d.path(c);
      const rel = path.slice(path.findIndex((x) => x.id === id) + 1).map((x) => x.name).join(' › ');
      return { id: c, name: rel, color: s.cats[c].color };
    });
}

function setCtx(list, listId, title) { app.ctx = { list, listId, title }; }

// ---------------------------------------------------------------- views
function viewHome() {
  const d = store.d, s = store.state;
  setCtx(d.all, 'none', 'Toate');
  const loading = !store.hasData;
  const pills = h('nav', { class: 'pills', 'aria-label': 'Colecții' },
    pill('favorite', 'star', 'Favorite', d.favs.length),
    pill('nesortate', 'inbox', 'Nesortate', d.inbox.length),
    pill('toate', 'film', 'Toate', d.all.length));

  const callout = d.inbox.length && !loading ? h('section', { class: 'callout' },
    h('p', { class: 'callout-text' }, `${clips(d.inbox.length)} ${d.inbox.length === 1 ? 'așteaptă să fie sortat' : 'așteaptă să fie sortate'}.`),
    h('div', { class: 'callout-actions' },
      h('button', { class: 'btn btn-primary', onclick: () => quickSort() }, icon('zap'), 'Sortare rapidă'),
      h('button', { class: 'btn btn-ghost', onclick: () => nav('nesortate') }, 'Vezi lista'))) : null;

  const posters = h('div', { class: 'posters', dataset: { grid: 'k:root' } }, s.root.map((id) => poster(id)));
  posters.append(h('button', { class: 'poster poster-add', onclick: () => createCategory({ parent: null }) }, icon('plus'), h('span', null, 'Categorie nouă')));

  return h('div', { class: 'view view-home' },
    appBar({ title: 'Dansuri', brand: true, actions: [
      h('button', { class: 'icon-btn', 'aria-label': 'Caută', onclick: () => nav('cauta') }, icon('search')),
      h('button', { class: 'icon-btn', 'aria-label': 'Setări', onclick: () => nav('setari') }, icon('settings')),
    ] }),
    authBanner(),
    loading ? h('div', { class: 'loading-lib' }, h('div', { class: 'spinner-lg' }), 'Se încarcă biblioteca…') : [
      pills,
      callout,
      h('div', { class: 'section-head' }, h('h2', null, 'Categorii'), h('button', { class: 'btn btn-small btn-ghost', onclick: () => createCategory({ parent: null }) }, icon('plus'), 'Nouă')),
      posters,
      s.root.length > 1 && !lsGet('dansuri:moved') ? h('p', { class: 'hint' }, 'Ține apăsat pe o categorie ca s-o muți în altă poziție.') : null,
    ]);
}

function pill(path, ic, label, n) {
  return h('a', { class: 'pill', href: '#/' + path }, icon(ic), h('span', { class: 'pill-label' }, label), h('span', { class: 'pill-count' }, n));
}

function poster(id, { mini = false } = {}) {
  const s = store.state, d = store.d;
  const c = s.cats[id];
  const items = d.deepItems(id);
  const kids = c.kids.length;
  const covers = items.slice(0, items.length >= 4 ? 4 : 1);
  const art = h('div', { class: 'poster-art n' + covers.length });
  for (const mid of covers) {
    const img = h('img', { alt: '', draggable: 'false' });
    const it = s.media[mid];
    const cached = media.cachedThumbUrl(mid);
    if (cached) img.src = cached;
    else media.thumbUrl(it, 2).then((u) => { if (u) img.src = u; }).catch(() => {});
    art.append(img);
  }
  const countText = clips(items.length) + (kids ? `, ${plural(kids, 'subcategorie', 'subcategorii')}` : '');
  const el = h('div', {
    class: 'poster' + (items.length ? '' : ' empty') + (mini ? ' mini' : ''),
    role: 'link', tabindex: '0',
    style: { '--c': c.color },
    dataset: { drag: '', kind: 'cat', id, zone: 'cat', cat: id, accept: 'media' },
    'aria-label': `${c.name}, ${countText}`,
  },
  art,
  h('div', { class: 'poster-shade' }),
  h('div', { class: 'poster-text' },
    c.emoji ? h('span', { class: 'poster-emoji' }, c.emoji) : null,
    h('span', { class: 'poster-name' }, c.name),
    h('span', { class: 'poster-count' }, countText)));
  el.addEventListener('click', () => nav('c/' + id));
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') nav('c/' + id); });
  return el;
}

function viewCategory(id) {
  const s = store.state, d = store.d;
  const c = s.cats[id];
  if (!c) {
    return h('div', { class: 'view' }, appBar({ title: 'Categorie', back: true }),
      emptyState('Categoria nu mai există.', 'Poate a fost ștearsă de pe alt dispozitiv.', h('button', { class: 'btn btn-primary', onclick: () => nav('') }, 'Înapoi la categorii')));
  }
  const items = categoryClips(id);
  setCtx(items, 'c:' + id, c.name);
  const hasSubs = c.kids.length > 0;
  const path = d.path(id);
  const parentName = path.length > 1 ? path.slice(0, -1).map((x) => x.name).join(' › ') : null;
  const addSub = h('button', { class: 'poster mini poster-add', onclick: () => createCategory({ parent: id }) }, icon('plus'), h('span', null, 'Subcategorie'));
  const subs = c.kids.length
    ? h('div', { class: 'subcats', dataset: { grid: 'k:' + id } }, c.kids.map((k) => poster(k, { mini: true })), addSub)
    : null;

  return h('div', { class: 'view view-cat', style: { '--c': c.color } },
    appBar({
      title: (c.emoji ? c.emoji + ' ' : '') + c.name,
      color: c.color,
      sub: parentName ? h('a', { href: '#/c/' + c.parent, class: 'crumb' }, parentName) : null,
      back: c.parent ? 'c/' + c.parent : true,
      actions: [
        items.length ? h('button', { class: 'icon-btn', 'aria-label': 'Selectează', onclick: () => enterSelection(null) }, icon('select')) : null,
        h('button', { class: 'icon-btn', 'aria-label': 'Opțiuni categorie', onclick: () => catMenu(id) }, icon('more')),
      ],
    }),
    authBanner(),
    subs,
    h('div', { class: 'count-row' },
      h('p', { class: 'count-line' }, clips(items.length) + (items.length > 1 && !lsGet('dansuri:moved') ? '. Ține apăsat pe un clip ca să-l selectezi, sau ține și trage ca să-l muți.' : '')),
      subs ? null : h('button', { class: 'btn btn-small btn-ghost', onclick: () => createCategory({ parent: id }) }, icon('plus'), 'Subcategorie')),
    items.length ? grid(items, 'c:' + id, hasSubs ? (mid) => subLabels(id, mid) : null) : emptyState('Niciun clip aici încă.',
      'Ține apăsat pe un clip din Nesortate sau din altă categorie și trage-l în bara de jos. Poți și încărca clipuri noi cu butonul +.',
      d.inbox.length ? h('button', { class: 'btn btn-secondary', onclick: () => nav('nesortate') }, `Deschide Nesortate (${d.inbox.length})`) : null));
}

function viewList(kind) {
  const d = store.d;
  let ids, title, listId = 'none', empty, sortKey = null;
  if (kind === 'favs') {
    ids = d.favs; title = 'Favorite'; listId = 'favs';
    empty = emptyState('Niciun favorit încă.', 'Apasă steaua când te uiți la un clip și îl găsești aici, în ordinea pe care o alegi tu.');
  } else if (kind === 'inbox') {
    ids = settings.sortInbox === 'old' ? [...d.inbox].reverse() : d.inbox; title = 'Nesortate'; sortKey = 'sortInbox';
    empty = emptyState('Totul e sortat.', 'Clipurile noi apar aici până le muți într-o categorie.');
  } else {
    ids = settings.sortAll === 'old' ? [...d.all].reverse() : d.all; title = 'Toate clipurile'; sortKey = 'sortAll';
    empty = emptyState('Nu ai încă niciun clip.', 'Apasă + ca să încarci clipuri din galerie.');
  }
  setCtx(ids, listId, title);
  const actions = [];
  if (sortKey && ids.length > 1) {
    actions.push(h('button', { class: 'icon-btn', 'aria-label': settings[sortKey] === 'old' ? 'Cele mai noi primele' : 'Cele mai vechi primele', title: settings[sortKey] === 'old' ? 'Acum: cele mai vechi primele' : 'Acum: cele mai noi primele',
      onclick: () => { settings[sortKey] = settings[sortKey] === 'old' ? 'new' : 'old'; saveSettings(); render(); toast(settings[sortKey] === 'old' ? 'Cele mai vechi primele' : 'Cele mai noi primele'); } },
    icon('down', settings[sortKey] === 'old' ? 'flip' : '')));
  }
  if (ids.length) actions.push(h('button', { class: 'icon-btn', 'aria-label': 'Selectează', onclick: () => enterSelection(null) }, icon('select')));

  let body;
  if (!ids.length) body = empty;
  else if (kind === 'favs') body = [h('p', { class: 'count-line' }, clips(ids.length) + (ids.length > 1 && !lsGet('dansuri:moved') ? '. Ține apăsat ca să selectezi, sau ține și trage ca să schimbi ordinea.' : '')), grid(ids, 'favs')];
  else body = groupedByDay(ids);

  return h('div', { class: 'view' },
    appBar({ title, back: true, actions }),
    authBanner(),
    kind === 'inbox' && ids.length ? h('section', { class: 'callout slim' },
      h('p', { class: 'callout-text' }, 'Treci prin ele unul câte unul și alege categoria cu o atingere.'),
      h('button', { class: 'btn btn-primary', onclick: () => quickSort() }, icon('zap'), 'Sortare rapidă')) : null,
    body);
}

function groupedByDay(ids) {
  const groups = [];
  for (const id of ids) {
    const day = (store.state.media[id].date || '').slice(0, 10);
    if (!groups.length || groups[groups.length - 1].day !== day) groups.push({ day, ids: [] });
    groups[groups.length - 1].ids.push(id);
  }
  return groups.map((g) => h('section', { class: 'day' },
    h('div', { class: 'day-head' },
      h('h2', null, g.day ? fmtDay(g.day) : 'Fără dată'),
      h('span', { class: 'day-count' }, clips(g.ids.length)),
      h('button', { class: 'linkish', onclick: () => enterSelection(g.ids) }, 'Selectează tot')),
    grid(g.ids, 'none')));
}

function viewTrash() {
  const d = store.d;
  setCtx(d.trash, 'none', 'Coș');
  return h('div', { class: 'view' },
    appBar({ title: 'Coș', back: 'setari', actions: d.trash.length ? [h('button', { class: 'btn btn-small btn-ghost', onclick: emptyTrash }, 'Golește')] : [] }),
    d.trash.length ? [h('p', { class: 'count-line' }, `${clips(d.trash.length)}. Atinge un clip ca să-l readuci sau să-l ștergi definitiv.`), grid(d.trash, 'none')]
      : emptyState('Coșul e gol.', 'Clipurile mutate în coș stau aici până le ștergi definitiv.'));
}

function viewSearch() {
  setCtx([], 'none', 'Rezultate');
  const results = h('div', { class: 'search-results' });
  const input = h('input', { type: 'search', class: 'search-input', placeholder: 'Caută după nume, notițe sau categorie', 'aria-label': 'Caută', enterkeyhint: 'search', autocomplete: 'off' });
  const run = () => {
    const q = normalize(input.value.trim());
    sessionStorage.setItem('dansuri:q', input.value);
    if (!q) { setChildren(results, h('p', { class: 'hint' }, 'Dă un nume clipurilor (din player, apasă pe „Adaugă un nume”) ca să le găsești ușor aici.')); setCtx([], 'none', 'Rezultate'); return; }
    const s = store.state, d = store.d;
    const cats = d.tree.map((t) => s.cats[t.id]).filter((c) => normalize(c.name).includes(q));
    const ids = d.all.filter((id) => {
      const m = s.media[id];
      const catNames = (d.catOf[id] || []).map((c) => s.cats[c]?.name).join(' ');
      return normalize(`${m.name} ${m.notes} ${m.orig} ${catNames}`).includes(q);
    });
    setCtx(ids, 'none', 'Rezultate');
    setChildren(results,
      cats.length ? h('div', { class: 'subcats' }, cats.map((c) => poster(c.id, { mini: true }))) : null,
      ids.length ? [h('p', { class: 'count-line' }, clips(ids.length)), grid(ids, 'none')] : emptyState('Niciun clip găsit.', 'Încearcă alt cuvânt.'));
  };
  input.addEventListener('input', debounce(run, 150));
  input.value = sessionStorage.getItem('dansuri:q') || '';
  run();
  requestAnimationFrame(() => input.focus());
  const view = h('div', { class: 'view' }, appBar({ title: 'Caută', back: true }), h('div', { class: 'search-box' }, icon('search'), input), results);
  view.refresh = run;
  return view;
}

// ---------------------------------------------------------------- selection mode
function enterSelection(ids) {
  if (app.selection) return;
  app.selection = { ids: new Set(ids || []) };
  app.selection.dismiss = pushOverlay(() => exitSelection(true));
  document.documentElement.classList.add('selecting');
  render();
}
function exitSelection(fromHistory = false) {
  if (!app.selection) return;
  const sel = app.selection;
  app.selection = null;
  document.documentElement.classList.remove('selecting');
  if (!fromHistory) sel.dismiss();
  render();
}
function toggleSelect(id) {
  const ids = app.selection.ids;
  if (ids.has(id)) ids.delete(id); else ids.add(id);
  if (!ids.size) return exitSelection();
  tileCache.get(id)?.classList.toggle('selected', ids.has(id));
  renderSelbar();
}
function renderSelbar() {
  const bar = document.getElementById('selbar');
  if (!app.selection) { bar.hidden = true; return; }
  const ids = [...app.selection.ids];
  const n = ids.length;
  const listId = app.ctx.listId;
  const inCat = listId.startsWith('c:') ? listId.slice(2) : null;
  const allSelected = n && app.ctx.list.every((id) => app.selection.ids.has(id));
  bar.hidden = false;
  bar.replaceChildren(
    h('div', { class: 'selbar-top' },
      h('button', { class: 'icon-btn', 'aria-label': 'Ieși din selecție', onclick: () => exitSelection() }, icon('x')),
      h('span', { class: 'selbar-count' }, n ? `${n} ${n === 1 ? 'selectat' : 'selectate'}` : 'Atinge clipurile'),
      h('button', { class: 'linkish', onclick: () => { app.selection.ids = new Set(allSelected ? [] : app.ctx.list); render(); } }, allSelected ? 'Niciunul' : 'Toate')),
    h('div', { class: 'selbar-actions' },
      selAction('move', 'Mută în', n, () => pickCategory({ title: `Mută ${clips(n)} în`, allowNew: true }).then((cid) => cid && (moveMedia(ids, cid, { from: inCat }), exitSelection()))),
      selAction('addto', 'Adaugă în', n, () => pickCategory({ title: `Adaugă ${clips(n)} și în`, allowNew: true }).then((cid) => cid && (addMediaTo(ids, cid), exitSelection()))),
      selAction('star', 'Favorite', n, () => { favMany(ids); exitSelection(); }),
      route().name === 'cos'
        ? selAction('restore', 'Readu', n, () => { restoreMedia(ids); exitSelection(); })
        : selAction('trash', 'Coș', n, () => { trashMedia(ids); exitSelection(); })));
}
function selAction(ic, label, n, fn) {
  return h('button', { class: 'selbar-btn', disabled: !n, onclick: fn }, icon(ic), h('span', null, label));
}

// ---------------------------------------------------------------- actions: media
const catName = (id) => store.state.cats[id]?.name || '';

function undoToast(message, inv) {
  toast(message, { action: 'Anulează', onAction: () => store.undo(inv) });
}

app.toggleFav = (id) => {
  const on = !store.d.favSet.has(id);
  store.dispatch(on ? { t: 'ins', l: 'favs', id, i: 0 } : { t: 'rm', l: 'favs', id });
  toast(on ? 'Adăugat la favorite' : 'Scos de la favorite');
};

function favMany(ids) {
  const fav = store.d.favSet;
  const add = ids.filter((id) => !fav.has(id));
  const op = add.length
    ? { t: 'bulk', ops: add.reverse().map((id) => ({ t: 'ins', l: 'favs', id, i: 0 })) }
    : { t: 'bulk', ops: ids.map((id) => ({ t: 'rm', l: 'favs', id })) };
  const inv = store.dispatch(op);
  undoToast(add.length ? `${clips(add.length)} ${add.length === 1 ? 'adăugat' : 'adăugate'} la favorite` : 'Scoase de la favorite', inv);
}

/** Move clips into a category. from = category the user is looking at; null = take them out of every category. */
function moveMedia(ids, toCat, { from = null, quiet = false } = {}) {
  const d = store.d;
  const ops = [];
  for (const id of ids) {
    // From a category view: out of that category and its subcategories (everything that view shows).
    const sources = (d.catOf[id] || []).filter((c) => !from || c === from || d.isDescendant(c, from));
    for (const c of sources) if (c !== toCat) ops.push({ t: 'rm', l: 'c:' + c, id });
  }
  [...ids].reverse().forEach((id) => ops.push({ t: 'ins', l: 'c:' + toCat, id, i: 0 }));
  const inv = store.dispatch({ t: 'bulk', ops });
  const msg = ids.length === 1 ? `Mutat în ${catName(toCat)}` : `${clips(ids.length)} mutate în ${catName(toCat)}`;
  if (!quiet) undoToast(msg, inv);
  else toast(msg, { action: 'Anulează', onAction: () => store.undo(inv), duration: 2500 });
  return inv;
}
app.moveMedia = moveMedia;

function addMediaTo(ids, toCat) {
  const inv = store.dispatch({ t: 'bulk', ops: [...ids].reverse().map((id) => ({ t: 'ins', l: 'c:' + toCat, id, i: 0 })) });
  undoToast(ids.length === 1 ? `Adăugat și în ${catName(toCat)}` : `${clips(ids.length)} adăugate în ${catName(toCat)}`, inv);
}

function removeFromCat(ids, cat, { only = false } = {}) {
  const d = store.d;
  const ops = [];
  for (const id of ids) {
    for (const c of d.catOf[id] || []) if (c === cat || (!only && d.isDescendant(c, cat))) ops.push({ t: 'rm', l: 'c:' + c, id });
  }
  const inv = store.dispatch({ t: 'bulk', ops });
  undoToast(ids.length === 1 ? `Scos din ${catName(cat)}` : `${clips(ids.length)} scoase din ${catName(cat)}`, inv);
}

function moveToTop(id, listId) {
  const inv = store.dispatch({ t: 'ins', l: listId, id, i: 0 });
  undoToast('Mutat primul', inv);
}

function reorder(id, listId, beforeId) {
  const s = store.state;
  const list = (listId === 'favs' ? s.favs : listId === 'k:root' ? s.root : listId.startsWith('c:') ? s.cats[listId.slice(2)]?.items : s.cats[listId.slice(2)]?.kids) || [];
  const rest = list.filter((x) => x !== id);
  const i = beforeId ? rest.indexOf(beforeId) : rest.length;
  store.dispatch({ t: 'ins', l: listId, id, i: i < 0 ? rest.length : i });
}

function trashMedia(ids) {
  const now = new Date().toISOString();
  const inv = store.dispatch({ t: 'bulk', ops: ids.map((id) => ({ t: 'mpatch', id, p: { trashed: now } })) });
  undoToast(ids.length === 1 ? 'Mutat în coș' : `${clips(ids.length)} mutate în coș`, inv);
}

function restoreMedia(ids) {
  store.dispatch({ t: 'bulk', ops: ids.map((id) => ({ t: 'mpatch', id, p: { trashed: null } })) });
  toast(ids.length === 1 ? 'Clipul a fost readus' : `${clips(ids.length)} readuse`);
}

async function purgeMedia(ids) {
  const s = store.state;
  const items = ids.map((id) => s.media[id]).filter(Boolean);
  const ops = [];
  for (const it of items) {
    ops.push({ t: 'rm', l: 'favs', id: it.id });
    for (const c of Object.values(s.cats)) if (c.items.includes(it.id)) ops.push({ t: 'rm', l: 'c:' + c.id, id: it.id });
    ops.push({ t: 'mset', id: it.id, v: null });
  }
  store.dispatch({ t: 'bulk', ops }, { undoable: false });
  items.forEach((it) => { media.forgetMedia(it); tileCache.delete(it.id); });
  toast(items.length === 1 ? 'Clip șters definitiv' : `${clips(items.length)} șterse definitiv`);
  try {
    const changes = items.flatMap((it) => [{ path: it.path, sha: null }, it.thumb ? { path: it.thumb, sha: null } : null]).filter(Boolean);
    await app.gh.commit(changes, `Șterge ${clips(items.length)}`);
  } catch (e) {
    console.warn('delete files failed', e);
  }
}

async function emptyTrash() {
  const ids = store.d.trash;
  const ok = await confirmDialog({ title: 'Golești coșul?', message: `${clips(ids.length)} ${ids.length === 1 ? 'va fi șters' : 'vor fi șterse'} definitiv din repo. Nu se mai pot recupera din aplicație.`, confirmLabel: 'Golește coșul', danger: true });
  if (ok) purgeMedia(ids);
}

function trashMenu(id) {
  const it = store.state.media[id];
  sheet({
    header: mediaHeader(it),
    items: [
      { icon: 'restore', label: 'Readu clipul', onClick: () => restoreMedia([id]) },
      { icon: 'trash', label: 'Șterge definitiv', danger: true, onClick: async () => {
        if (await confirmDialog({ title: 'Ștergi definitiv clipul?', message: 'Fișierul se șterge din repo. Nu se mai poate recupera din aplicație.', confirmLabel: 'Șterge', danger: true })) purgeMedia([id]);
      } },
    ],
  });
}

function mediaHeader(it) {
  const img = h('img', { class: 'mh-thumb', alt: '' });
  media.thumbUrl(it, 5).then((u) => { if (u) img.src = u; }).catch(() => {});
  const cats = (store.d.catOf[it.id] || []).map((c) => catName(c)).join(', ');
  return h('div', { class: 'media-head' }, img,
    h('div', { class: 'mh-text' },
      h('p', { class: 'mh-name' }, it.name || 'Clip fără nume'),
      h('p', { class: 'mh-meta' }, `${fmtDur(it.dur)}, primit pe ${fmtDateTime(it.date)}` + (it.src ? `, copie ${Math.min(it.w, it.h)}p din ${Math.min(it.src.w, it.src.h) >= 2160 ? '4K' : `${it.src.w}×${it.src.h}`}` : '')),
      h('p', { class: 'mh-meta' }, cats ? `În: ${cats}` : 'Nesortat')));
}

function mediaMenu(id, { fromPlayer = false } = {}) {
  const it = store.state.media[id];
  if (!it) return;
  if (it.trashed) return trashMenu(id);
  const d = store.d;
  const listId = fromPlayer ? null : app.ctx.listId;
  const inCat = listId?.startsWith('c:') ? listId.slice(2) : null;
  const fav = d.favSet.has(id);
  const canTop = listId && (listId === 'favs' || inCat) && app.ctx.list[0] !== id;
  sheet({
    header: mediaHeader(it),
    items: [
      { icon: 'star', label: fav ? 'Scoate de la favorite' : 'Adaugă la favorite', onClick: () => app.toggleFav(id) },
      { icon: 'edit', label: 'Nume și notițe', onClick: () => app.editMedia(id) },
      { icon: 'move', label: 'Mută în…', onClick: () => pickCategory({ title: 'Mută în', exclude: inCat ? [inCat] : [], allowNew: true, mediaId: id }).then((cid) => cid && moveMedia([id], cid, { from: inCat })) },
      { icon: 'addto', label: 'Adaugă și în…', onClick: () => pickCategory({ title: 'Adaugă și în', exclude: d.catOf[id] || [], allowNew: true }).then((cid) => cid && addMediaTo([id], cid)) },
      canTop ? { icon: 'top', label: 'Mută primul', onClick: () => moveToTop(id, listId) } : null,
      ...(inCat ? subLabels(inCat, id).map((c) => ({ icon: 'remove', label: `Scoate din ${c.name}`, onClick: () => removeFromCat([id], c.id, { only: true }) })) : []),
      inCat ? { icon: 'remove', label: subLabels(inCat, id).length ? `Scoate din ${catName(inCat)} (cu subcategorii)` : `Scoate din ${catName(inCat)}`, onClick: () => removeFromCat([id], inCat) } : null,
      !fromPlayer && !app.selection ? { icon: 'select', label: 'Selectează mai multe', onClick: () => enterSelection([id]) } : null,
      { icon: 'download', label: 'Descarcă pe telefon', hint: 'pentru offline', onClick: () => media.prefetchVideo(it).then(() => toast('Clipul e descărcat pe acest dispozitiv')).catch((e) => toast('Descărcarea a eșuat: ' + e.message)) },
      { sep: true },
      { icon: 'trash', label: 'Mută în coș', danger: true, onClick: () => trashMedia([id]) },
    ],
  });
}
app.mediaMenu = mediaMenu;

app.editMedia = async (id) => {
  const it = store.state.media[id];
  if (!it) return;
  const name = h('input', { class: 'field', type: 'text', maxlength: 120, value: it.name || '', placeholder: 'de ex. Cambré cu ieșire pe dreapta', 'aria-label': 'Nume' });
  const notes = h('textarea', { class: 'field', rows: 4, maxlength: 2000, placeholder: 'Pași, numărătoare, ce să nu uiți…', 'aria-label': 'Notițe' });
  notes.value = it.notes || '';
  const ok = await dialog({
    title: 'Nume și notițe',
    body: h('div', { class: 'form' }, h('label', { class: 'label' }, 'Nume', name), h('label', { class: 'label' }, 'Notițe', notes)),
    actions: [{ label: 'Anulează', value: false }, { label: 'Salvează', primary: true, value: true }],
  });
  if (!ok) return;
  const p = { name: name.value.trim(), notes: notes.value.trim() };
  if (p.name !== (it.name || '') || p.notes !== (it.notes || '')) store.dispatch({ t: 'mpatch', id, p });
};

// ---------------------------------------------------------------- actions: categories
function categoryForm({ cat = null, parent = null, title, confirm }) {
  const name = h('input', { class: 'field', type: 'text', maxlength: 60, value: cat?.name || '', placeholder: 'de ex. Mișcări grele de bachata', 'aria-label': 'Nume', required: true });
  let color = cat?.color || (parent ? store.state.cats[parent]?.color : null) || COLORS[Object.keys(store.state.cats).length % COLORS.length];
  let emoji = cat?.emoji || '';
  const sw = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Culoare' });
  const drawSw = () => sw.replaceChildren(...COLORS.map((c) => h('button', { type: 'button', class: 'swatch-btn' + (c === color ? ' on' : ''), role: 'radio', 'aria-checked': String(c === color), 'aria-label': 'Culoare ' + c, style: { '--c': c }, onclick: () => { color = c; drawSw(); } })));
  drawSw();
  const em = h('div', { class: 'emojis', role: 'radiogroup', 'aria-label': 'Simbol' });
  const drawEm = () => em.replaceChildren(...EMOJIS.map((e) => h('button', { type: 'button', class: 'emoji-btn' + (e === emoji ? ' on' : ''), role: 'radio', 'aria-checked': String(e === emoji), 'aria-label': e || 'Fără simbol', onclick: () => { emoji = e; drawEm(); } }, e || '–')));
  drawEm();
  const err = h('p', { class: 'form-error', hidden: true });
  return dialog({
    title,
    body: h('div', { class: 'form' },
      parent ? h('p', { class: 'dialog-text' }, `Subcategorie în ${store.d.path(parent).map((x) => x.name).join(' › ')}`) : null,
      h('label', { class: 'label' }, 'Nume', name), err,
      h('div', { class: 'label' }, 'Culoare', sw),
      h('div', { class: 'label' }, 'Simbol (opțional)', em)),
    actions: [{ label: 'Anulează', value: null }, { label: confirm, primary: true, onClick: () => {
      const v = name.value.trim();
      if (!v) { err.textContent = 'Scrie un nume pentru categorie.'; err.hidden = false; name.focus(); return false; }
      return { name: v, color, emoji };
    } }],
  });
}

async function createCategory({ parent = null } = {}) {
  const res = await categoryForm({ parent, title: parent ? 'Subcategorie nouă' : 'Categorie nouă', confirm: 'Creează' });
  if (!res) return null;
  const id = uid(8);
  const list = parent ? 'k:' + parent : 'k:root';
  const len = parent ? store.state.cats[parent].kids.length : store.state.root.length;
  store.dispatch({ t: 'bulk', ops: [
    { t: 'cset', id, v: { id, name: res.name, color: res.color, emoji: res.emoji, parent, kids: [], items: [] } },
    { t: 'ins', l: list, id, i: len },
  ] });
  toast(`Categoria ${res.name} a fost creată`);
  return id;
}
app.createCategory = createCategory;

/** Create a category and move a clip into it (from the drag tray, quick sort or the menu). */
app.createCategoryFor = async (mediaId, { from = null } = {}) => {
  const id = await createCategory({ parent: null });
  if (id && mediaId) moveMedia([mediaId], id, { from });
  return id;
};

async function editCategory(id) {
  const c = store.state.cats[id];
  const res = await categoryForm({ cat: c, title: 'Editează categoria', confirm: 'Salvează' });
  if (res) store.dispatch({ t: 'cpatch', id, p: res });
}

function moveCategory(id, newParent, index = null) {
  const s = store.state;
  const c = s.cats[id];
  if (!c) return;
  if (newParent && (newParent === id || store.d.isDescendant(newParent, id))) return toast('O categorie nu poate fi mutată în ea însăși.');
  const from = c.parent ? 'k:' + c.parent : 'k:root';
  const to = newParent ? 'k:' + newParent : 'k:root';
  const len = newParent ? s.cats[newParent].kids.length : s.root.length;
  const inv = store.dispatch({ t: 'bulk', ops: [
    { t: 'rm', l: from, id },
    { t: 'ins', l: to, id, i: index ?? len },
    { t: 'cpatch', id, p: { parent: newParent } },
  ] });
  undoToast(newParent ? `${c.name} e acum în ${catName(newParent)}` : `${c.name} e acum categorie principală`, inv);
}

async function deleteCategory(id) {
  const s = store.state;
  const c = s.cats[id];
  if (!c) return;
  const ok = await confirmDialog({
    title: `Ștergi categoria ${c.name}?`,
    message: 'Clipurile nu se șterg. Cele care nu sunt și în altă categorie ajung la Nesortate.' + (c.kids.length ? ' Subcategoriile urcă un nivel.' : ''),
    confirmLabel: 'Șterge categoria',
    danger: true,
  });
  if (!ok) return;
  const parentList = c.parent ? 'k:' + c.parent : 'k:root';
  const plist = c.parent ? s.cats[c.parent].kids : s.root;
  const pos = plist.indexOf(id);
  const ops = [];
  c.kids.forEach((k, i) => {
    ops.push({ t: 'ins', l: parentList, id: k, i: pos + 1 + i });
    ops.push({ t: 'cpatch', id: k, p: { parent: c.parent } });
  });
  ops.push({ t: 'rm', l: parentList, id });
  ops.push({ t: 'cset', id, v: null });
  const inv = store.dispatch({ t: 'bulk', ops });
  if (route().name === 'c' && route().arg === id) nav(c.parent ? 'c/' + c.parent : '');
  undoToast(`Categoria ${c.name} a fost ștearsă`, inv);
}

function catMenu(id) {
  const c = store.state.cats[id];
  if (!c) return;
  const items = store.d.deepItems(id);
  sheet({
    title: c.name,
    subtitle: clips(items.length),
    items: [
      { icon: 'edit', label: 'Nume, culoare și simbol', onClick: () => editCategory(id) },
      { icon: 'plus', label: 'Subcategorie nouă', onClick: () => createCategory({ parent: id }) },
      { icon: 'move', label: 'Mută categoria…', onClick: () => pickCategory({ title: `Mută ${c.name} în`, exclude: [id], excludeTree: id, allowRoot: true }).then((p) => p !== null && p !== undefined && moveCategory(id, p === '__root' ? null : p)) },
      items.length ? { icon: 'download', label: 'Descarcă pentru offline', hint: clips(items.length), onClick: () => downloadMany(items, c.name) } : null,
      { sep: true },
      { icon: 'trash', label: 'Șterge categoria', danger: true, onClick: () => deleteCategory(id) },
    ],
  });
}

/** Choose a category. Resolves to its id, '__root' (top level), or null. */
function pickCategory({ title, exclude = [], excludeTree = null, allowNew = false, allowRoot = false, mediaId = null }) {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (v) => { if (!resolved) { resolved = true; resolve(v); } };
    const d = store.d, s = store.state;
    const items = [];
    if (allowNew) items.push({ icon: 'plus', label: 'Categorie nouă…', onClick: async () => done(await createCategory({ parent: null })) });
    if (allowRoot) items.push({ icon: 'layers', label: 'Nivel principal', onClick: () => done('__root') });
    for (const { id, depth } of d.tree) {
      if (exclude.includes(id) || (excludeTree && d.isDescendant(id, excludeTree))) continue;
      const c = s.cats[id];
      items.push({ swatch: c.color, label: (c.emoji ? c.emoji + ' ' : '') + c.name, hint: String(d.deepItems(id).length), indent: depth, onClick: () => done(id) });
    }
    sheet({ title, items, className: 'picker', onClose: (chosen) => { if (!chosen) done(null); } });
  });
}

// ---------------------------------------------------------------- drag & drop
function trayTargets(info) {
  const d = store.d, s = store.state;
  const listId = info.grid?.dataset.grid || 'none';
  if (info.kind === 'cat') {
    const c = s.cats[info.id];
    const chips = [];
    if (c.parent) chips.push(h('div', { class: 'tray-chip', dataset: { zone: 'root', accept: 'cat' } }, icon('layers'), 'Nivel principal'));
    for (const { id, depth } of d.tree) {
      if (id === info.id || id === c.parent || d.isDescendant(id, info.id)) continue;
      chips.push(trayChip(id, depth, 'cat'));
    }
    return { title: `Mută ${c.name} în`, chips };
  }
  const inCat = listId.startsWith('c:') ? listId.slice(2) : null;
  const chips = [
    h('div', { class: 'tray-chip fav', dataset: { zone: 'fav', accept: 'media' } }, icon('star'), 'Favorite'),
    h('div', { class: 'tray-chip new', dataset: { zone: 'newcat', accept: 'media' } }, icon('plus'), 'Categorie nouă'),
  ];
  if (inCat) chips.push(h('div', { class: 'tray-chip', dataset: { zone: 'uncat', accept: 'media' } }, icon('remove'), `Scoate din ${catName(inCat)}`));
  for (const { id, depth } of d.tree) if (id !== inCat) chips.push(trayChip(id, depth, 'media'));
  return { title: 'Mută în', chips };
}

function trayChip(id, depth, accept) {
  const c = store.state.cats[id];
  const parentPath = depth ? store.d.path(id).slice(0, -1).map((x) => x.name).join(' › ') : null;
  return h('div', { class: 'tray-chip', style: { '--c': c.color }, dataset: { zone: 'cat', cat: id, accept } },
    h('span', { class: 'dot' }),
    h('span', { class: 'tray-chip-text' }, parentPath ? h('small', null, parentPath + ' ›') : null, (c.emoji ? c.emoji + ' ' : '') + c.name));
}

function showTray(info) {
  const tray = document.getElementById('tray');
  const { title, chips } = trayTargets(info);
  tray.replaceChildren(
    h('div', { class: 'tray-bar' }, icon('move'), h('span', null, info.kind === 'cat' ? 'Trage aici ca s-o muți în altă categorie' : 'Trage aici ca să muți în altă categorie')),
    h('div', { class: 'tray-body', dataset: { autoscroll: '' } }, h('p', { class: 'tray-title' }, title), h('div', { class: 'tray-chips' }, chips)));
  tray.hidden = false;
  tray.classList.remove('expanded');
  requestAnimationFrame(() => tray.classList.add('show'));
}

function hideTray() {
  const tray = document.getElementById('tray');
  tray.classList.remove('show', 'expanded');
  setTimeout(() => { if (!tray.classList.contains('show')) tray.hidden = true; }, 200);
}

function initDnd() {
  dnd = setupDnd({
    root: document.getElementById('view'),
    canDrag: (info) => !app.selection && route().name !== 'cos' && !(info.kind === 'media' && !store.state.media[info.id]),
    canReorder: (info) => {
      const g = info.grid?.dataset.grid || 'none';
      return g === 'favs' || g.startsWith('c:') || g.startsWith('k:');
    },
    onHold: (info, { via } = {}) => {
      haptic(10);
      if (info.kind !== 'media') return catMenu(info.id);
      if (via === 'mouse') return mediaMenu(info.id);
      if (app.selection) toggleSelect(info.id);
      else enterSelection([info.id]);
    },
    onStart: (info) => showTray(info),
    onMove: ({ y }) => {
      const tray = document.getElementById('tray');
      const vh = window.innerHeight;
      if (!tray.classList.contains('expanded')) {
        if (y > vh - 84) tray.classList.add('expanded');
      } else {
        const top = tray.getBoundingClientRect().top;
        if (y < top - 40) tray.classList.remove('expanded');
      }
    },
    topInset: () => document.querySelector('.appbar')?.getBoundingClientRect().bottom || 64,
    bottomInset: () => document.getElementById('tray').getBoundingClientRect().height || 72,
    onDrop: (info, res) => {
      hideTray();
      handleDrop(info, res);
      if (renderPending) { renderPending = false; render(); }
    },
  });
}

function handleDrop(info, res) {
  const listId = info.grid?.dataset.grid || 'none';
  if (res.type !== 'cancel') lsSet('dansuri:moved', true);
  if (res.type === 'reorder') return reorder(info.id, listId, res.beforeId);
  if (res.type !== 'zone') return;
  const z = res.data;
  if (info.kind === 'cat') {
    if (z.zone === 'root') moveCategory(info.id, null);
    else if (z.zone === 'cat') moveCategory(info.id, z.cat);
    return;
  }
  const inCat = listId.startsWith('c:') ? listId.slice(2) : null;
  if (z.zone === 'fav') { if (!store.d.favSet.has(info.id)) app.toggleFav(info.id); else toast('E deja la favorite'); }
  else if (z.zone === 'newcat') app.createCategoryFor(info.id, { from: inCat });
  else if (z.zone === 'uncat' && inCat) removeFromCat([info.id], inCat);
  else if (z.zone === 'cat') {
    if (z.cat === inCat) return;
    moveMedia([info.id], z.cat, { from: inCat });
  }
}

// ---------------------------------------------------------------- quick sort
function quickSort() {
  const list = store.d.inbox;
  if (!list.length) return toast('Nu mai sunt clipuri nesortate.');
  openPlayer({ list: [...list], index: 0, app, sortMode: true, title: 'Sortare rapidă' });
}

// ---------------------------------------------------------------- offline downloads
let downloading = false;
async function downloadMany(ids, label) {
  if (downloading) return toast('O descărcare e deja în curs.');
  downloading = true;
  const items = ids.map((id) => store.state.media[id]).filter(Boolean);
  const cachedSet = await media.cachedVideoIds(items);
  const todo = items.filter((m) => !cachedSet.has(m.id));
  if (!todo.length) { downloading = false; return toast(`Toate clipurile din ${label} sunt deja pe acest dispozitiv.`); }
  await media.requestPersistence();
  let done = 0;
  const total = todo.reduce((a, m) => a + (m.size || 0), 0);
  toast(`Se descarcă ${clips(todo.length)} (${fmtBytes(total)})…`, { duration: 600000 });
  try {
    for (const m of todo) {
      await media.prefetchVideo(m);
      done++;
      toast(`Descărcat ${done} din ${todo.length}…`, { duration: 600000 });
    }
    toast(`Gata: ${label} merge și fără internet pe acest dispozitiv.`);
  } catch (e) {
    toast(`Descărcarea s-a oprit după ${clips(done)}: ${e.message}`);
  } finally {
    downloading = false;
  }
}

// ---------------------------------------------------------------- uploads
const uploads = { items: [], running: false, expanded: false };
app.uploads = uploads;

function uploadTarget() {
  const r = route();
  return r.name === 'c' && store.state.cats[r.arg] ? r.arg : null;
}

function pickFiles() {
  document.getElementById('file-input').click();
}

function startUpload(files, catId) {
  if (!uploads.running && uploads.items.every((j) => ['done', 'dup'].includes(j.status))) uploads.items = [];
  for (const f of files) uploads.items.push({ file: f, name: f.name, status: 'waiting', progress: 0, error: null, catId });
  renderUploads();
  if (!uploads.running) processUploads();
}

async function processUploads() {
  uploads.running = true;
  let lock = null;
  try { lock = await navigator.wakeLock?.request('screen'); } catch {}
  const paint = debounce(renderUploads, 120);
  for (;;) {
    const job = uploads.items.find((j) => j.status === 'waiting');
    if (!job) break;
    try {
      job.status = 'prep'; paint();
      const f = job.file;
      const id = await media.fileId(f);
      const existing = store.state.media[id];
      if (existing) {
        const ops = [];
        if (existing.trashed) ops.push({ t: 'mpatch', id, p: { trashed: null } });
        if (job.catId) ops.push({ t: 'ins', l: 'c:' + job.catId, id, i: 0 });
        if (ops.length) store.dispatch({ t: 'bulk', ops }, { undoable: false });
        job.status = 'dup'; paint();
        continue;
      }
      // 4K or too big for GitHub: make a 1080p copy on this device first.
      let blob = f, mime = f.type || 'video/mp4', ext = media.extFor(f), conv = null;
      const info = await convert.inspect(f);
      if (convert.shouldConvert(info, f.size)) {
        job.status = 'convert'; job.progress = 0; paint();
        try {
          conv = await convert.convert(f, { onProgress: (p) => { job.progress = p; paint(); } });
          blob = conv.blob; mime = 'video/mp4'; ext = 'mp4';
        } catch (e) {
          console.warn('conversion failed', e);
          if (f.size > MAX_UPLOAD) throw new Error(`nu s-a putut converti (${e.message}), iar originalul are ${fmtBytes(f.size)}, peste limita GitHub de 100 MB.`);
          job.note = 'trimis original';
        }
      } else if (f.size > MAX_UPLOAD) {
        throw new Error(`are ${fmtBytes(f.size)}; GitHub primește fișiere de maximum 100 MB.`);
      }
      job.status = 'prep'; job.progress = 0; paint();
      const meta = await media.probeVideo(blob);
      const path = `media/${id}.${ext}`;
      const thumbPath = meta.thumb ? `thumbs/${id}.jpg` : null;
      job.status = 'upload'; paint();
      const videoSha = await app.gh.createBlob(blob, { onProgress: (l, t) => { job.progress = l / t; paint(); } });
      const changes = [{ path, sha: videoSha }];
      if (meta.thumb) changes.push({ path: thumbPath, sha: await app.gh.createBlob(meta.thumb) });
      job.status = 'commit'; paint();
      await app.gh.commit(changes, `Adaugă ${f.name}`);
      const { date, seq } = media.dateFromName(f.name, f.lastModified);
      const item = {
        id, type: 'video', path, thumb: thumbPath, mime, name: '', notes: '', orig: f.name, date, seq,
        added: new Date().toISOString(), dur: Math.round((meta.dur || info?.dur || 0) * 100) / 100,
        w: meta.w || conv?.width || 0, h: meta.h || conv?.height || 0, size: blob.size,
      };
      if (conv) item.src = { w: info.width, h: info.height, size: f.size };
      if (meta.thumb) await media.putThumb(item, meta.thumb);
      await media.putVideo(item, blob);
      const ops = [{ t: 'mset', id, v: item }];
      if (job.catId && store.state.cats[job.catId]) ops.push({ t: 'ins', l: 'c:' + job.catId, id, i: 0 });
      store.dispatch({ t: 'bulk', ops }, { undoable: false });
      job.status = 'done';
      job.progress = 1;
    } catch (e) {
      console.warn('upload failed', e);
      job.status = 'error';
      job.error = isNetworkError(e) ? 'conexiunea s-a întrerupt.' : e.status === 401 ? 'token invalid.' : e.message;
    }
    paint();
  }
  uploads.running = false;
  try { await lock?.release(); } catch {}
  renderUploads();
  const failed = uploads.items.filter((j) => j.status === 'error').length;
  if (!failed) {
    const batch = uploads.items;
    setTimeout(() => { if (!uploads.running && uploads.items === batch) { uploads.items = []; renderUploads(); } }, 6000);
  }
}

function renderUploads() {
  const box = document.getElementById('uploads');
  const items = uploads.items;
  if (!items.length) { box.hidden = true; return; }
  box.hidden = false;
  const active = items.filter((j) => ['waiting', 'prep', 'convert', 'upload', 'commit'].includes(j.status));
  const done = items.filter((j) => j.status === 'done' || j.status === 'dup').length;
  const failed = items.filter((j) => j.status === 'error');
  const totalProgress = items.reduce((a, j) => a + (['done', 'dup', 'error'].includes(j.status) ? 1 : j.status === 'convert' ? (j.progress || 0) * 0.6 : j.status === 'upload' ? 0.6 + (j.progress || 0) * 0.4 : 0), 0) / items.length;
  const target = items.find((j) => j.catId)?.catId;
  const current = items.find((j) => ['prep', 'convert', 'upload', 'commit'].includes(j.status));
  const nth = `${Math.min(done + failed.length + 1, items.length)} din ${items.length}`;
  const label = active.length ? (current?.status === 'convert' ? `Se convertește la 1080p (${nth})` : `Se încarcă ${nth}`) : failed.length ? `${clips(failed.length)} nu s-au încărcat` : `Gata: ${clips(done)} ${done === 1 ? 'încărcat' : 'încărcate'}`;
  const statusText = (j) => ({ waiting: 'în așteptare', prep: 'se pregătește', convert: `se convertește la 1080p ${Math.round(j.progress * 100)}%`, upload: `se încarcă ${Math.round(j.progress * 100)}%`, commit: 'se salvează', done: j.note ? 'încărcat (' + j.note + ')' : 'încărcat', dup: 'există deja', error: 'eroare: ' + j.error }[j.status]);
  setChildren(box,
    h('div', { class: 'up-head' },
      h('button', { class: 'up-toggle', 'aria-expanded': String(uploads.expanded), onclick: () => { uploads.expanded = !uploads.expanded; renderUploads(); } },
        active.length ? h('span', { class: 'spinner-sm' }) : icon(failed.length ? 'alert' : 'checkCircle'),
        h('span', { class: 'up-label' }, label, target ? h('small', null, ` în ${catName(target)}`) : null)),
      !active.length ? h('button', { class: 'icon-btn', 'aria-label': 'Închide', onclick: () => { uploads.items = []; renderUploads(); } }, icon('x')) : null),
    h('div', { class: 'up-bar' }, h('span', { style: { width: `${Math.round(totalProgress * 100)}%` } })),
    uploads.expanded ? h('ul', { class: 'up-list' }, items.map((j) => h('li', { class: 'up-item ' + j.status }, h('span', { class: 'up-name' }, j.name), h('span', { class: 'up-status' }, statusText(j))))) : null,
    failed.length && !active.length ? h('button', { class: 'btn btn-small btn-secondary', onclick: () => { failed.forEach((j) => { j.status = 'waiting'; j.error = null; j.progress = 0; }); processUploads(); } }, 'Reîncearcă') : null);
}

// ---------------------------------------------------------------- settings
function viewSettings() {
  setCtx([], 'none', '');
  const qrBox = h('div', { class: 'qr-box' });
  const usage = h('span', { class: 'set-value' }, '…');
  media.storageInfo().then(({ usage: u }) => { usage.textContent = fmtBytes(u); });
  const totalSize = Object.values(store.state.media).filter((m) => !m.trashed).reduce((a, m) => a + (m.size || 0), 0);

  const copyLink = () => navigator.clipboard?.writeText(setupLink())
    .then(() => toast('Link copiat. Nu-l trimite altcuiva: conține token-ul.'))
    .catch(() => toast('Nu am putut copia linkul.'));
  const showQr = () => {
    const url = setupLink();
    const qr = qrcode(0, 'L');
    qr.addData(url);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    qrBox.replaceChildren(
      h('div', { class: 'qr', html: `<svg viewBox="-2 -2 ${n + 4} ${n + 4}" shape-rendering="crispEdges" role="img" aria-label="Cod QR pentru conectare"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#fff"/><path d="${d}" fill="#1b0e18"/></svg>` }),
      h('p', { class: 'hint left' }, 'Scanează codul cu camera telefonului. Codul conține token-ul tău, așa că nu-l arăta altcuiva.'));
  };
  qrBox.append(h('div', { class: 'set-buttons' },
    h('button', { class: 'btn btn-secondary', onclick: showQr }, icon('qr'), 'Arată codul QR'),
    h('button', { class: 'btn btn-ghost', onclick: copyLink }, icon('copy'), 'Copiază linkul')));

  const colsSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Coloane' }, [2, 3, 4].map((n) => h('button', { class: 'seg-btn', 'aria-pressed': String(settings.cols === n), onclick: () => { settings.cols = n; saveSettings(); document.documentElement.style.setProperty('--cols', n); render(); } }, String(n))));

  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;

  return h('div', { class: 'view view-settings' },
    appBar({ title: 'Setări', back: true }),
    h('section', { class: 'set-section' },
      h('h2', null, 'Pe ecranul principal'),
      standalone ? h('p', { class: 'set-text' }, 'Aplicația e instalată pe acest dispozitiv.')
        : installPrompt ? [h('p', { class: 'set-text' }, 'Instaleaz-o și o deschizi ca pe orice aplicație, pe tot ecranul.'), h('button', { class: 'btn btn-primary', onclick: async () => { installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; render(); } }, icon('phone'), 'Instalează aplicația')]
        : h('p', { class: 'set-text' }, isIos ? 'În Safari apasă butonul Partajare, apoi „Adaugă pe ecranul principal”. Deschide apoi aplicația de pe ecran și lipește linkul copiat de mai jos (aplicația instalată nu vede ce e salvat în Safari).' : 'În meniul browserului (⋮) alege „Instalează aplicația” sau „Adaugă pe ecranul principal”.')),
    h('section', { class: 'set-section' },
      h('h2', null, 'Deschide pe alt dispozitiv'),
      h('p', { class: 'set-text' }, 'Pe telefon, scanează codul QR și aplicația se conectează singură, fără să mai lipești token-ul. Pe iPhone, pentru aplicația pusă pe ecranul principal, copiază linkul și lipește-l în ea.'),
      qrBox),
    h('section', { class: 'set-section' },
      h('h2', null, 'Clipuri pe acest dispozitiv'),
      h('div', { class: 'set-row' }, h('span', null, 'Spațiu folosit'), usage),
      h('p', { class: 'set-text' }, `Clipurile se descarcă la prima vizionare și rămân salvate, ca să meargă și fără internet. Toată biblioteca are ${fmtBytes(totalSize)}.`),
      h('div', { class: 'set-buttons' },
        h('button', { class: 'btn btn-secondary', onclick: () => downloadMany(store.d.all, 'biblioteca') }, icon('download'), 'Descarcă tot'),
        h('button', { class: 'btn btn-ghost', onclick: async () => { if (await confirmDialog({ title: 'Ștergi clipurile descărcate?', message: 'Se șterg doar de pe acest dispozitiv. Rămân în GitHub și se descarcă din nou când le deschizi.', confirmLabel: 'Șterge descărcările', danger: true })) { await media.clearDownloads(); toast('Descărcările au fost șterse'); render(); } } }, 'Șterge descărcările'))),
    h('section', { class: 'set-section' },
      h('h2', null, 'Afișare'),
      h('div', { class: 'set-row' }, h('span', null, 'Coloane în grilă (pe telefon)'), colsSeg),
      h('a', { class: 'set-link', href: '#/cos' }, icon('trash'), h('span', null, 'Coș'), h('span', { class: 'set-value' }, String(store.d.trash.length)))),
    h('section', { class: 'set-section' },
      h('h2', null, 'Cont GitHub'),
      h('div', { class: 'set-row' }, h('span', null, 'Repo'), h('span', { class: 'set-value mono' }, `${settings.owner}/${settings.repo}`)),
      h('p', { class: 'set-text' }, 'Clipurile și categoriile stau în acest repo privat. Aplicația îl citește cu token-ul salvat doar pe acest dispozitiv.'),
      h('div', { class: 'set-buttons' },
        h('button', { class: 'btn btn-secondary', onclick: changeToken }, 'Schimbă token-ul'),
        h('button', { class: 'btn btn-ghost', onclick: logout }, icon('logout'), 'Deconectează'))),
    h('p', { class: 'version' }, `Dansuri ${CONFIG.version}`));
}

function setupLink() {
  const payload = btoa(JSON.stringify({ t: settings.token, o: settings.owner, r: settings.repo, b: settings.branch })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${location.origin}${location.pathname}#setup=${payload}`;
}

async function changeToken() {
  const input = h('input', { class: 'field', type: 'password', autocomplete: 'off', placeholder: 'github_pat_…', 'aria-label': 'Token nou' });
  const err = h('p', { class: 'form-error', hidden: true });
  const res = await dialog({
    title: 'Token nou',
    body: h('div', { class: 'form' }, h('p', { class: 'dialog-text' }, 'Lipește un token care are acces la repo-ul cu clipuri.'), input, err),
    actions: [{ label: 'Anulează', value: null }, { label: 'Salvează', primary: true, onClick: async () => {
      const t = input.value.trim();
      const check = await verifyAccess({ token: t, owner: settings.owner, repo: settings.repo, branch: settings.branch });
      if (!check.ok) { err.textContent = check.message; err.hidden = false; return false; }
      return t;
    } }],
  });
  if (!res) return;
  settings.token = res;
  saveSettings();
  connect();
  toast('Token-ul a fost actualizat');
}

async function logout() {
  const ok = await confirmDialog({ title: 'Te deconectezi?', message: 'Token-ul și clipurile descărcate se șterg de pe acest dispozitiv. În GitHub nu se schimbă nimic.', confirmLabel: 'Deconectează', danger: true });
  if (!ok) return;
  if (store.pending.length) await store.save().catch(() => {});
  await media.clearAllCaches();
  lsDel(store.key);
  delete settings.token;
  saveSettings();
  location.hash = '';
  location.reload();
}

// ---------------------------------------------------------------- welcome / connect
async function verifyAccess({ token, owner, repo, branch }) {
  if (!token) return { ok: false, message: 'Lipește token-ul.' };
  const gh = new GitHub({ token, owner, repo, branch });
  try {
    if (!owner) { const u = await gh.user(); owner = gh.owner = u.login; }
    const info = await gh.repoInfo();
    if (info.permissions && !info.permissions.push) return { ok: true, owner, warn: 'Token-ul poate doar citi: vei vedea clipurile, dar nu vei putea salva modificări.' };
    return { ok: true, owner, branch: info.default_branch || branch };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, message: 'Nu am putut contacta GitHub. Verifică internetul.' };
    if (e.status === 401) return { ok: false, message: 'GitHub nu acceptă token-ul. Verifică dacă l-ai copiat complet și dacă nu a expirat.' };
    if (e.status === 404 || e.status === 403) return { ok: false, message: `Token-ul nu are acces la repo-ul ${owner}/${repo}. La „Repository access” trebuie bifat acest repo.` };
    return { ok: false, message: `GitHub a răspuns: ${e.message}` };
  }
}

function renderWelcome(prefill = '') {
  document.getElementById('fab').hidden = true;
  const owner = h('input', { class: 'field', type: 'text', value: settings.owner || CONFIG.owner, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Utilizator GitHub' });
  const repo = h('input', { class: 'field', type: 'text', value: settings.repo || CONFIG.repo, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Repo' });
  const token = h('input', { class: 'field', type: 'password', value: prefill, placeholder: 'github_pat_… sau linkul de conectare', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Token GitHub' });
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const btn = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Conectează');
  const tokenUrl = `https://github.com/settings/personal-access-tokens/new?name=${encodeURIComponent('Dansuri telefon')}&description=${encodeURIComponent('Aplicatia Dansuri')}&expires_in=none&contents=write`;
  const form = h('form', { class: 'welcome-form', novalidate: true },
    h('label', { class: 'label' }, 'Token GitHub', token),
    err,
    btn,
    h('details', { class: 'help' },
      h('summary', null, 'De unde iau token-ul?'),
      h('ol', null,
        h('li', null, 'Deschide ', h('a', { href: tokenUrl, target: '_blank', rel: 'noopener' }, 'pagina de creare a token-ului'), ' (e precompletată).'),
        h('li', null, 'La „Repository access” alege „Only select repositories” și bifează repo-ul ', h('b', null, repo.value || CONFIG.repo), '.'),
        h('li', null, 'Apasă „Generate token”, copiază-l și lipește-l mai sus.')),
      h('p', null, 'Mai simplu: dacă aplicația e deja conectată pe calculator, deschide acolo Setări și scanează codul QR cu telefonul.'),
      h('p', null, 'Pe iPhone, aplicația pusă pe ecranul principal nu vede ce ai salvat în Safari. Copiază linkul din Setări (sau token-ul) și lipește-l aici, în aplicația instalată.')),
    h('details', { class: 'help' },
      h('summary', null, 'Alt repo'),
      h('label', { class: 'label' }, 'Utilizator GitHub', owner),
      h('label', { class: 'label' }, 'Repo cu clipuri', repo)));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Se verifică…';
    const cfg = { token: token.value.trim(), owner: owner.value.trim(), repo: repo.value.trim() || CONFIG.repo, branch: settings.branch || CONFIG.branch };
    const fromLink = parseSetup(cfg.token);
    if (fromLink) Object.assign(cfg, fromLink);
    const res = await verifyAccess(cfg);
    btn.disabled = false;
    btn.textContent = 'Conectează';
    if (!res.ok) { err.textContent = res.message; err.hidden = false; return; }
    Object.assign(settings, cfg, { owner: res.owner, branch: res.branch || cfg.branch });
    saveSettings();
    if (res.warn) toast(res.warn, { duration: 8000 });
    connect();
  });
  document.getElementById('view').replaceChildren(h('div', { class: 'welcome' },
    h('div', { class: 'welcome-hero' },
      h('h1', { class: 'welcome-title' }, 'Dansuri'),
      h('p', { class: 'welcome-sub' }, 'Clipurile tale de salsa, bachata și kizomba, puse în ordine pe categorii.')),
    form));
}

/** Decode a setup link ("…#setup=…") into {token, owner, repo, branch}. */
function parseSetup(text) {
  const m = /#setup=([A-Za-z0-9_-]+)/.exec(text || '');
  if (!m) return null;
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const cfg = JSON.parse(atob(b64 + '==='.slice((b64.length + 3) % 4)));
    if (!cfg.t) return null;
    return { token: cfg.t, owner: cfg.o || CONFIG.owner, repo: cfg.r || CONFIG.repo, branch: cfg.b || CONFIG.branch };
  } catch (e) {
    console.warn('bad setup link', e);
    return null;
  }
}

function handleSetupLink() {
  const cfg = parseSetup(location.hash);
  if (!location.hash.startsWith('#setup=')) return false;
  history.replaceState(null, '', location.pathname + location.search);
  if (cfg) {
    Object.assign(settings, cfg);
    saveSettings();
    connect();
    toast('Conectat. Bine ai venit!');
    return true;
  }
  toast('Linkul de conectare nu e valid.');
  return false;
}

// ---------------------------------------------------------------- boot
function connect() {
  settings.owner = settings.owner || CONFIG.owner;
  settings.repo = settings.repo || CONFIG.repo;
  settings.branch = settings.branch || CONFIG.branch;
  app.gh = new GitHub({ token: settings.token, owner: settings.owner, repo: settings.repo, branch: settings.branch });
  media.setRemote(app.gh);
  store.connect(app.gh);
  render(true);
  store.refresh();
  media.requestPersistence();
}

function registerSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  // Reload only after the person chose "Actualizează", never on the first install.
  let updateRequested = false;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw?.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          toast('Există o versiune nouă a aplicației.', { action: 'Actualizează', onAction: () => { updateRequested = true; nw.postMessage('skipWaiting'); }, duration: 20000 });
        }
      });
    });
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  }).catch((e) => console.warn('SW', e));
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updateRequested) { updateRequested = false; location.reload(); }
  });
}

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });
document.addEventListener('visibilitychange', () => {
  if (!settings.token || !app.gh) return;
  if (document.hidden) { if (store.pending.length) store.save(); }
  else if (!store.lastRefresh || Date.now() - store.lastRefresh > 20000) store.refresh();
});

function boot() {
  shell();
  trackNav();
  initDnd();
  registerSW();
  if (location.hash.startsWith('#setup=') && handleSetupLink()) return;
  if (!settings.token) return renderWelcome();
  connect();
}

boot();

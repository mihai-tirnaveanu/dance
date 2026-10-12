// Library state ("database") kept in data.json in the private repo.
// Every change is an operation; operations are applied locally right away,
// queued, and saved to GitHub in the background. If data.json changed
// elsewhere (another device), the queued operations are replayed on top
// of the latest version, so nothing is lost.
import { isNetworkError } from './gh.js';
import { lsGet, lsSet, clamp } from './util.js';

export const DATA_PATH = 'data.json';
const NOOP = { t: 'bulk', ops: [] };

export function emptyState() {
  return { v: 1, media: {}, cats: {}, root: [], favs: [] };
}

function getList(s, l) {
  if (l === 'favs') return s.favs;
  if (l === 'k:root') return s.root;
  if (l.startsWith('c:')) return s.cats[l.slice(2)]?.items;
  if (l.startsWith('k:')) return s.cats[l.slice(2)]?.kids;
  return undefined;
}

function memberExists(s, l, id) {
  return l.startsWith('k:') ? !!s.cats[id] : !!s.media[id];
}

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

/** Apply an operation to state s (mutates and returns s). Tolerates missing ids. */
export function apply(s, op) {
  switch (op.t) {
    case 'bulk':
      for (const o of op.ops) apply(s, o);
      break;
    case 'ins': {
      const L = getList(s, op.l);
      if (!L || !memberExists(s, op.l, op.id)) break;
      const j = L.indexOf(op.id);
      if (j >= 0) L.splice(j, 1);
      L.splice(clamp(op.i ?? 0, 0, L.length), 0, op.id);
      break;
    }
    case 'rm': {
      const L = getList(s, op.l);
      if (!L) break;
      const j = L.indexOf(op.id);
      if (j >= 0) L.splice(j, 1);
      break;
    }
    case 'mset':
      if (op.v == null) delete s.media[op.id];
      else s.media[op.id] = clone(op.v);
      break;
    case 'mpatch':
      if (s.media[op.id]) Object.assign(s.media[op.id], clone(op.p));
      break;
    case 'cset':
      if (op.v == null) delete s.cats[op.id];
      else s.cats[op.id] = clone(op.v);
      break;
    case 'cpatch':
      if (s.cats[op.id]) Object.assign(s.cats[op.id], clone(op.p));
      break;
  }
  return s;
}

/** The operation that undoes `op`, computed against the state before `op`. */
export function invert(s, op) {
  switch (op.t) {
    case 'bulk': {
      const tmp = clone(s);
      const inv = [];
      for (const o of op.ops) { inv.push(invert(tmp, o)); apply(tmp, o); }
      return { t: 'bulk', ops: inv.reverse() };
    }
    case 'ins': {
      const L = getList(s, op.l);
      if (!L || !memberExists(s, op.l, op.id)) return NOOP;
      const j = L.indexOf(op.id);
      return j < 0 ? { t: 'rm', l: op.l, id: op.id } : { t: 'ins', l: op.l, id: op.id, i: j };
    }
    case 'rm': {
      const L = getList(s, op.l);
      const j = L ? L.indexOf(op.id) : -1;
      return j < 0 ? NOOP : { t: 'ins', l: op.l, id: op.id, i: j };
    }
    case 'mset':
      return { t: 'mset', id: op.id, v: clone(s.media[op.id]) ?? null };
    case 'mpatch': {
      const m = s.media[op.id];
      if (!m) return NOOP;
      const p = {};
      for (const k of Object.keys(op.p)) p[k] = clone(m[k]) ?? null;
      return { t: 'mpatch', id: op.id, p };
    }
    case 'cset':
      return { t: 'cset', id: op.id, v: clone(s.cats[op.id]) ?? null };
    case 'cpatch': {
      const c = s.cats[op.id];
      if (!c) return NOOP;
      const p = {};
      for (const k of Object.keys(op.p)) p[k] = clone(c[k]) ?? null;
      return { t: 'cpatch', id: op.id, p };
    }
  }
  return NOOP;
}

/** Make any loaded data safe to use: fill missing fields, drop dangling references. */
export function normalizeState(data) {
  const s = Object.assign(emptyState(), clone(data) || {});
  s.media = s.media || {};
  s.cats = s.cats || {};
  for (const [id, c] of Object.entries(s.cats)) {
    c.id = id;
    c.kids = (c.kids || []).filter((k) => s.cats[k] && k !== id);
    c.items = [...new Set((c.items || []).filter((m) => s.media[m]))];
    c.parent = c.parent && s.cats[c.parent] ? c.parent : null;
  }
  s.root = [...new Set((s.root || []).filter((k) => s.cats[k]))];
  s.favs = [...new Set((s.favs || []).filter((m) => s.media[m]))];
  // Every category must be reachable exactly once.
  const seen = new Set();
  const walk = (ids) => ids.filter((k) => {
    if (seen.has(k)) return false;
    seen.add(k);
    s.cats[k].kids = walk(s.cats[k].kids);
    return true;
  });
  s.root = walk(s.root);
  for (const id of Object.keys(s.cats)) {
    if (!seen.has(id)) { s.cats[id].parent = null; s.root.push(id); seen.add(id); s.cats[id].kids = walk(s.cats[id].kids); }
  }
  for (const id of s.root) s.cats[id].parent = null;
  for (const c of Object.values(s.cats)) for (const k of c.kids) s.cats[k].parent = c.id;
  return s;
}

const byNewest = (a, b) =>
  (b.date || '').localeCompare(a.date || '') || (b.seq || 0) - (a.seq || 0) || a.id.localeCompare(b.id);

/** Derived lists used by the views. */
export function derive(s) {
  const catOf = {};
  for (const c of Object.values(s.cats)) for (const id of c.items) (catOf[id] ||= []).push(c.id);
  const alive = Object.values(s.media).filter((m) => !m.trashed);
  const all = alive.sort(byNewest).map((m) => m.id);
  const inbox = all.filter((id) => !catOf[id]?.length);
  const trash = Object.values(s.media)
    .filter((m) => m.trashed)
    .sort((a, b) => String(b.trashed).localeCompare(String(a.trashed)))
    .map((m) => m.id);
  const favs = s.favs.filter((id) => s.media[id] && !s.media[id].trashed);
  const favSet = new Set(favs);

  // Flattened category tree in display order, with depth.
  const tree = [];
  const walk = (ids, depth) => { for (const id of ids) { const c = s.cats[id]; if (!c) continue; tree.push({ id, depth }); walk(c.kids, depth + 1); } };
  walk(s.root, 0);

  const deepCache = {};
  const deepItems = (id) => {
    if (deepCache[id]) return deepCache[id];
    const c = s.cats[id];
    if (!c) return [];
    const set = new Set(c.items.filter((m) => s.media[m] && !s.media[m].trashed));
    for (const k of c.kids) for (const m of deepItems(k)) set.add(m);
    return (deepCache[id] = [...set]);
  };
  const items = (id) => (s.cats[id]?.items || []).filter((m) => s.media[m] && !s.media[m].trashed);
  const path = (id) => {
    const out = [];
    for (let c = s.cats[id]; c; c = c.parent ? s.cats[c.parent] : null) { out.unshift(c); if (out.length > 20) break; }
    return out;
  };
  const isDescendant = (id, ancestor) => path(id).some((c) => c.id === ancestor);
  return { catOf, all, inbox, trash, favs, favSet, tree, deepItems, items, path, isDescendant };
}

function describe(ops) {
  return `Actualizare din aplicație (${ops.length === 1 ? '1 modificare' : ops.length + ' modificări'})`;
}

export class Store extends EventTarget {
  constructor() {
    super();
    this.state = emptyState();
    this.sha = null;
    this.pending = [];
    this.status = 'idle'; // idle | saved | pending | saving | offline | error | auth
    this.error = null;
    this.version = 0;
    this.loadedRemote = false;
    this._derived = null;
    this.retryDelay = 2000;
    window.addEventListener('online', () => { if (this.pending.length) this.save(); else this.refresh(); });
  }

  connect(gh) {
    this.gh = gh;
    this.key = `dansuri:db:${gh.owner}/${gh.repo}`;
    const cached = lsGet(this.key);
    if (cached?.state) {
      this.state = normalizeState(cached.state);
      this.sha = cached.sha || null;
      this.pending = cached.pending || [];
      this.emit('local');
    }
  }

  get hasData() { return this.loadedRemote || Object.keys(this.state.media).length > 0 || !!this.sha; }

  get d() {
    if (!this._derived) this._derived = derive(this.state);
    return this._derived;
  }

  persist() {
    if (this.key) lsSet(this.key, { state: this.state, sha: this.sha, pending: this.pending, at: Date.now() });
  }

  emit(kind) {
    this.version++;
    this._derived = null;
    this.dispatchEvent(new CustomEvent('change', { detail: kind }));
  }

  setStatus(status, error = null) {
    this.status = status;
    this.error = error;
    this.dispatchEvent(new CustomEvent('status'));
  }

  /** Apply an operation. Returns the inverse operation (for undo). */
  dispatch(op, { undoable = true } = {}) {
    const inv = undoable ? invert(this.state, op) : null;
    apply(this.state, op);
    this.pending.push(op);
    this.persist();
    this.emit('local');
    this.scheduleSave();
    return inv;
  }

  undo(inv) {
    if (inv) this.dispatch(inv, { undoable: false });
  }

  rebase(remote) {
    const base = remote ? normalizeState(remote.data) : emptyState();
    this.state = normalizeState(this.pending.reduce((st, op) => apply(st, op), base));
    this.sha = remote ? remote.sha : null;
    this.persist();
    this.emit('remote');
  }

  async refresh() {
    if (!this.gh) return;
    if (this.saving) { this.refreshAfterSave = true; return; }
    this.lastRefresh = Date.now();
    try {
      const remote = await this.gh.getJSON(DATA_PATH);
      this.loadedRemote = true;
      if (!remote) {
        // No database yet: create one from what we have.
        if (!this.pending.length) this.pending.push(NOOP);
        this.sha = null;
        this.scheduleSave(0);
        this.emit('remote');
        return;
      }
      if (remote.sha !== this.sha) this.rebase(remote);
      else this.emit('remote');
      if (this.pending.length) this.scheduleSave(0);
      else this.setStatus('saved');
      this.retryDelay = 2000;
    } catch (e) {
      this.handleError(e, () => this.refresh());
    }
  }

  // Changes are batched: saved 2 s after the last one, but at least every 8 s while
  // changes keep coming (keeps the number of commits low; GitHub limits commit bursts).
  scheduleSave(delay = 2000) {
    clearTimeout(this.saveTimer);
    if (!navigator.onLine) { this.setStatus('offline'); return; } // saved by the 'online' listener
    if (!['offline', 'auth', 'saving'].includes(this.status)) this.setStatus('pending');
    if (!this.firstPendingAt) this.firstPendingAt = Date.now();
    const wait = Math.max(0, Math.min(delay, this.firstPendingAt + 8000 - Date.now()));
    this.saveTimer = setTimeout(() => this.save(), wait);
  }

  /** Save pending changes now (also used before leaving). */
  async save() {
    clearTimeout(this.saveTimer);
    if (!this.gh || !this.pending.length) return;
    if (this.saving) { this.saveAgain = true; return; }
    this.saving = true;
    this.firstPendingAt = 0;
    this.setStatus('saving');
    let failed = false;
    try {
      for (let attempt = 0; ; attempt++) {
        const n = this.pending.length;
        const snapshot = JSON.parse(JSON.stringify(this.state));
        try {
          this.sha = await this.gh.putJSON(DATA_PATH, snapshot, this.sha, describe(this.pending.slice(0, n)));
          this.pending = this.pending.slice(n);
          this.persist();
          break;
        } catch (e) {
          if ((e.status === 409 || e.status === 422) && attempt < 4) {
            this.rebase(await this.gh.getJSON(DATA_PATH));
            continue;
          }
          throw e;
        }
      }
      this.retryDelay = 2000;
      this.setStatus(this.pending.length ? 'pending' : 'saved');
    } catch (e) {
      failed = true;
      this.handleError(e, () => this.save());
    } finally {
      this.saving = false;
      if (!failed && (this.saveAgain || this.pending.length)) { this.saveAgain = false; this.scheduleSave(200); }
      else if (!failed && this.refreshAfterSave) { this.refreshAfterSave = false; this.refresh(); }
    }
  }

  handleError(e, retry) {
    console.warn('[sync]', e);
    clearTimeout(this.retryTimer);
    if (isNetworkError(e) || !navigator.onLine) {
      this.setStatus('offline', e);
    } else if (e.status === 401) {
      this.setStatus('auth', e);
      return;
    } else {
      this.setStatus('error', e);
    }
    this.retryTimer = setTimeout(retry, this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 60000);
  }
}

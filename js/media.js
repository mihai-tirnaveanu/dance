// Downloading, caching and preparing media files.
import { Queue, toLocalIso } from './util.js';

const MEDIA_CACHE = 'dansuri-media-v1';
const THUMB_CACHE = 'dansuri-thumbs-v1';
const keyFor = (path) => new URL(`./__media/${path}`, location.href).href;

const thumbUrls = new Map(); // id -> object URL
const thumbPending = new Map(); // id -> Promise
const thumbQueue = new Queue(6);
const videoUrls = new Map(); // id -> object URL (small LRU)
const videoPending = new Map(); // id -> {promise, listeners:Set}

let gh = null;
export function setRemote(remote) { gh = remote; }

async function openCache(name) {
  try { return await caches.open(name); } catch { return null; }
}

export function cachedThumbUrl(id) { return thumbUrls.get(id) || null; }

/** Get an object URL for a media item's thumbnail (downloads once, then cached). */
export function thumbUrl(item, priority = 0) {
  if (!item?.thumb) return Promise.resolve(null);
  if (thumbUrls.has(item.id)) return Promise.resolve(thumbUrls.get(item.id));
  if (thumbPending.has(item.id)) return thumbPending.get(item.id);
  const p = thumbQueue.push(async () => {
    const cache = await openCache(THUMB_CACHE);
    const key = keyFor(item.thumb);
    let blob = null;
    const hit = cache && (await cache.match(key));
    if (hit) blob = await hit.blob();
    else {
      blob = await gh.getRaw(item.thumb, { type: 'image/jpeg' });
      if (cache) await cache.put(key, new Response(blob, { headers: { 'Content-Type': 'image/jpeg' } })).catch(() => {});
    }
    const url = URL.createObjectURL(blob);
    thumbUrls.set(item.id, url);
    return url;
  }, priority).finally(() => thumbPending.delete(item.id));
  thumbPending.set(item.id, p);
  return p;
}

/** Store a freshly generated thumbnail locally (after an upload). */
export async function putThumb(item, blob) {
  const cache = await openCache(THUMB_CACHE);
  if (cache) await cache.put(keyFor(item.thumb), new Response(blob, { headers: { 'Content-Type': 'image/jpeg' } })).catch(() => {});
  if (!thumbUrls.has(item.id)) thumbUrls.set(item.id, URL.createObjectURL(blob));
}

export async function isVideoCached(item) {
  const cache = await openCache(MEDIA_CACHE);
  return !!(cache && (await cache.match(keyFor(item.path))));
}

export async function cachedVideoIds(items) {
  const cache = await openCache(MEDIA_CACHE);
  if (!cache) return new Set();
  const keys = new Set((await cache.keys()).map((r) => r.url));
  return new Set(items.filter((m) => keys.has(keyFor(m.path))).map((m) => m.id));
}

function rememberVideoUrl(id, url) {
  videoUrls.set(id, url);
  while (videoUrls.size > 4) {
    const [oldId, oldUrl] = videoUrls.entries().next().value;
    videoUrls.delete(oldId);
    URL.revokeObjectURL(oldUrl);
  }
}

/**
 * Get a playable object URL for a video. onProgress(received, total) is called while
 * downloading. Several callers can wait for the same download.
 */
export function videoUrl(item, onProgress) {
  if (videoUrls.has(item.id)) {
    const url = videoUrls.get(item.id);
    videoUrls.delete(item.id);
    videoUrls.set(item.id, url); // refresh LRU position
    return Promise.resolve(url);
  }
  let job = videoPending.get(item.id);
  if (!job) {
    job = { listeners: new Set() };
    job.promise = (async () => {
      const blob = await downloadVideo(item, (r, t) => job.listeners.forEach((fn) => fn(r, t)));
      const url = URL.createObjectURL(blob);
      rememberVideoUrl(item.id, url);
      return url;
    })().finally(() => videoPending.delete(item.id));
    videoPending.set(item.id, job);
  }
  if (onProgress) job.listeners.add(onProgress);
  return job.promise;
}

export function stopListening(item, onProgress) {
  videoPending.get(item.id)?.listeners.delete(onProgress);
}

async function downloadVideo(item, onProgress) {
  const type = item.mime || 'video/mp4';
  const cache = await openCache(MEDIA_CACHE);
  const key = keyFor(item.path);
  const hit = cache && (await cache.match(key));
  if (hit) {
    const b = await hit.blob();
    return b.type ? b : new Blob([b], { type });
  }
  const blob = await gh.getRaw(item.path, { onProgress, size: item.size, type });
  if (cache) await cache.put(key, new Response(blob, { headers: { 'Content-Type': type } })).catch(() => {});
  return blob;
}

/** Download a video into the local cache without creating a URL (offline use, prefetch). */
export async function prefetchVideo(item, onProgress) {
  if (videoUrls.has(item.id) || (await isVideoCached(item))) return;
  if (videoPending.has(item.id)) return videoPending.get(item.id).promise;
  await downloadVideo(item, onProgress || (() => {}));
}

export async function storageInfo() {
  let usage = 0, quota = 0;
  try { ({ usage = 0, quota = 0 } = await navigator.storage.estimate()); } catch {}
  return { usage, quota };
}

export async function clearDownloads() {
  for (const url of videoUrls.values()) URL.revokeObjectURL(url);
  videoUrls.clear();
  try { await caches.delete(MEDIA_CACHE); } catch {}
}

export async function clearAllCaches() {
  await clearDownloads();
  try { await caches.delete(THUMB_CACHE); } catch {}
  for (const url of thumbUrls.values()) URL.revokeObjectURL(url);
  thumbUrls.clear();
}

export async function forgetMedia(item) {
  const c1 = await openCache(MEDIA_CACHE);
  const c2 = await openCache(THUMB_CACHE);
  await c1?.delete(keyFor(item.path));
  await c2?.delete(keyFor(item.thumb));
}

export async function requestPersistence() {
  try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch {}
}

// ---------- Preparing uploads ----------

const NAME_PATTERNS = [
  // WhatsApp Web / Desktop: "WhatsApp Video 2026-10-10 at 19.34.24 (3).mp4"
  [/(\d{4})-(\d{2})-(\d{2}) at (\d{2})\.(\d{2})\.(\d{2})(?: \((\d+)\))?/, (m) => [m.slice(1, 7), +(m[7] || 0)]],
  // Camera apps: "VID_20231012_193424", "PXL_20231012_193424123", "20231012_193424"
  [/(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})/, (m) => [m.slice(1, 7), 0]],
  // WhatsApp on phones: "VID-20231012-WA0003"
  [/(\d{4})(\d{2})(\d{2})-WA(\d{4})/, (m) => [[m[1], m[2], m[3], '12', '00', '00'], +m[4]]],
];

export function dateFromName(name, fallbackMs) {
  for (const [re, fn] of NAME_PATTERNS) {
    const m = re.exec(name);
    if (m) {
      const [[y, mo, d, hh, mi, ss], seq] = fn(m);
      if (+y > 2000 && +mo >= 1 && +mo <= 12) return { date: `${y}-${mo}-${d}T${hh}:${mi}:${ss}`, seq };
    }
  }
  return { date: toLocalIso(new Date(fallbackMs || Date.now())), seq: 0 };
}

export async function sha256Hex(blob) {
  const buf = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

function once(el, ev, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); reject(new Error('timeout ' + ev)); }, ms);
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error('media error')); };
    const cleanup = () => { clearTimeout(t); el.removeEventListener(ev, ok); el.removeEventListener('error', bad); };
    el.addEventListener(ev, ok, { once: true });
    el.addEventListener('error', bad, { once: true });
  });
}

/**
 * Read duration/size of a video file and grab a thumbnail frame.
 * Never throws: if this browser can't decode the file, the clip is uploaded without a thumbnail.
 */
export async function probeVideo(file) {
  try {
    return await probeVideoInner(file);
  } catch (e) {
    console.warn('probe failed', e);
    return { dur: 0, w: 0, h: 0, thumb: null };
  }
}

async function probeVideoInner(file) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.preload = 'auto';
  v.src = url;
  try {
    await once(v, 'loadedmetadata', 10000);
    const dur = isFinite(v.duration) ? v.duration : 0;
    const w = v.videoWidth, h = v.videoHeight;
    let thumb = null;
    try {
      const t = Math.max(0, Math.min(dur * 0.2, dur - 0.5, 8));
      v.currentTime = t || 0.1;
      try { await once(v, 'seeked', 6000); }
      catch { await v.play().catch(() => {}); await new Promise((r) => setTimeout(r, 400)); v.pause(); }
      if (v.videoWidth) {
        const tw = 360, th = Math.round((v.videoHeight / v.videoWidth) * tw);
        const c = document.createElement('canvas');
        c.width = tw; c.height = th;
        c.getContext('2d').drawImage(v, 0, 0, tw, th);
        thumb = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
      }
    } catch (e) { console.warn('thumbnail failed', e); }
    return { dur, w, h, thumb };
  } finally {
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
  }
}

const EXT_BY_TYPE = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/3gpp': '3gp', 'video/x-matroska': 'mkv' };

export function extFor(file) {
  const m = /\.([a-z0-9]{2,5})$/i.exec(file.name);
  return (m ? m[1] : EXT_BY_TYPE[file.type] || 'mp4').toLowerCase();
}

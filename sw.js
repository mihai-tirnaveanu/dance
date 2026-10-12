// Offline support: the app itself is cached; clips are cached by the app (Cache Storage).
const VERSION = '1.0.1';
const SHELL_CACHE = 'dansuri-shell-' + VERSION;
const SHELL = [
  './', 'index.html', 'app.css', 'manifest.webmanifest',
  'js/main.js', 'js/config.js', 'js/util.js', 'js/icons.js', 'js/gh.js', 'js/store.js',
  'js/media.js', 'js/ui.js', 'js/dnd.js', 'js/player.js', 'vendor/qrcode.mjs',
  'fonts/bsd-latin.woff2', 'fonts/bsd-latin-ext.woff2',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('dansuri-shell-') && k !== SHELL_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.includes('/__media/')) return;
  if (req.mode === 'navigate') {
    // Network first for the page, so updates arrive; cached copy when offline.
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL_CACHE).then((c) => c.put('index.html', copy)); }
      return res;
    }).catch(() => caches.match('index.html')));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok && url.pathname.match(/\.(js|mjs|css|woff2|png|webmanifest)$/)) {
      const copy = res.clone();
      caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
    }
    return res;
  })));
});

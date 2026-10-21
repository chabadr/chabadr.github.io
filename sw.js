// Lets the class site open without internet. Every file the pages need
// (the pages, their scripts, the Firebase library, the fonts) is fetched from
// the network when possible - so a new version always arrives - and kept in
// a cache that is used only when the network can't be reached. The data
// itself is cached by Firestore (see initializeFirestore in index.html).
const CACHE = 'class-site-v1';
const CORE = [
  './', 'index.html', 'admin.html', 'page-nav.js', 'save-banner.js', 'firebase-config.js', 'sms-config.js',
  'manifest.webmanifest', 'manifest-z1.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(cache => Promise.all(CORE.map(url => cache.add(url).catch(() => {})))));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function isCacheable(url){
  if (url.origin === self.location.origin) return true;
  if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) return true;
  return url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!isCacheable(url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const fromCache = () => cache.match(req, { ignoreSearch: url.origin === self.location.origin });
    const fromNetwork = fetch(req).then(res => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    });
    // A very slow connection counts as none: after a few seconds the cached
    // copy is used (the network answer still refreshes the cache).
    const slow = new Promise(resolve => setTimeout(resolve, 4000, 'slow'));
    try{
      const first = await Promise.race([fromNetwork, slow]);
      if (first !== 'slow') return first;
      const cached = await fromCache();
      return cached || await fromNetwork;
    } catch(e){
      const cached = await fromCache();
      if (cached) return cached;
      throw e;
    }
  })());
});

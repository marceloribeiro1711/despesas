// Padel Coaching — Service Worker
// Compatível com Android 8 (Chrome 67+)

const CACHE_VERSION = 'v3.9.5';

const PRECACHE_URLS = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './manifest.json',
  './icons/icon-192x192.png',
  './icons/icon-512x512.png'
];

// ── MESSAGE ───────────────────────────────────────────────────
self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── INSTALL: pré-cache de todos os ficheiros essenciais ───────
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function(cache) {
      // Cachear um a um com catch individual — compatível com Chrome 67+
      var promises = PRECACHE_URLS.map(function(url) {
        return cache.add(url).catch(function(err) {
          console.warn('[SW] Failed to cache:', url, err);
        });
      });
      return Promise.all(promises);
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

// ── ACTIVATE: limpar caches antigos ───────────────────────────
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(key) { return key !== CACHE_VERSION; })
            .map(function(key) {
              console.log('[SW] Deleting old cache:', key);
              return caches.delete(key);
            })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// ── FETCH: Network First para código, Cache First para assets ─
self.addEventListener('fetch', function(event) {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;

  var url = new URL(event.request.url);
  var pathname = url.pathname;

  var isCode = pathname.endsWith('.html')
    || pathname.endsWith('.js')
    || pathname.endsWith('.css')
    || pathname.endsWith('.json')
    || pathname.endsWith('/');

  if (isCode) {
    // Network First — tenta rede, fallback para cache
    event.respondWith(
      fetch(event.request).then(function(response) {
        if (response && response.status === 200) {
          var toCache = response.clone();
          caches.open(CACHE_VERSION).then(function(cache) {
            cache.put(event.request, toCache);
          });
        }
        return response;
      }).catch(function() {
        return caches.match(event.request).then(function(cached) {
          if (cached) return cached;
          // Fallback final: servir index.html para qualquer navegação
          if (event.request.mode === 'navigate' || event.request.destination === 'document') {
            return caches.match('./index.html').then(function(idx) {
              if (idx) return idx;
              return caches.match('./');
            });
          }
        });
      })
    );
  } else {
    // Cache First — ícones e assets estáticos
    event.respondWith(
      caches.match(event.request).then(function(cached) {
        if (cached) return cached;
        return fetch(event.request).then(function(response) {
          if (response && response.status === 200) {
            var toCache = response.clone();
            caches.open(CACHE_VERSION).then(function(cache) {
              cache.put(event.request, toCache);
            });
          }
          return response;
        }).catch(function() {
          console.warn('[SW] Failed to fetch:', event.request.url);
        });
      })
    );
  }
});

/**
 * SecureKeep — Service Worker
 *
 * Strategy: Network-first with cache fallback for the app shell.
 * User data is NEVER cached here — it stays in encrypted IndexedDB only.
 *
 * Versioning: bump CACHE_VERSION on each deploy to invalidate old caches.
 */

const CACHE_VERSION  = 'sk-v1.3.110';
const CACHE_NAME     = `securekeep-${CACHE_VERSION}`;

// App shell files to pre-cache
const APP_SHELL = [
  './',
  './index.html',
  './css/app.css',
  './css/fonts.css',
  './fonts/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuFuYMZg.ttf',
  './fonts/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuGKYMZg.ttf',
  './fonts/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuI6fMZg.ttf',
  './fonts/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuLyfMZg.ttf',
  './js/config.js',
  './js/crypto.js',
  './js/storage.js',
  './js/drive.js',
  './js/sync.js',
  './js/vault.js',
  './js/password-generator.js',
  './js/ui.js',
  './js/app.js',
  './manifest.json',
  './icons/fingerprint.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/css-pattern-by-magicpattern.png',
  './js/lib/lottie/lottie-light.min.js',
  './js/lib/lottie/lottie-element.js',
  './js/lib/argon2-bundled.min.js',
  './js/lib/leaflet/leaflet.js',
  './js/lib/leaflet/leaflet.css',
  './js/lib/leaflet/images/marker-icon.png',
  './js/lib/leaflet/images/marker-icon-2x.png',
  './js/lib/leaflet/images/marker-shadow.png',
  './js/lib/leaflet/images/layers.png',
  './js/lib/leaflet/images/layers-2x.png',
];

// ─── Install: pre-cache app shell ────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(APP_SHELL);
    }).then(() => {
      // Skip waiting so the new SW activates immediately
      return self.skipWaiting();
    })
  );
});

// ─── Activate: clean old caches ──────────────────────────────────────────────

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key.startsWith('securekeep-') && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ─── Fetch: network-first for app shell, never cache API/Drive calls ─────────

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept Google API calls (auth, Drive) or cross-origin requests
  if (
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('accounts.google.com') ||
    url.hostname.includes('cdn.jsdelivr.net') ||
    url.origin !== self.location.origin
  ) {
    return; // Let the browser handle normally
  }

  // Never cache POST/PUT/DELETE
  if (event.request.method !== 'GET') return;

  // Network-first strategy for all same-origin GET requests (app shell)
  event.respondWith(
    fetch(event.request)
      .then(networkResponse => {
        // Cache the fresh response
        if (networkResponse.ok && networkResponse.status < 400) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        // Network failed — serve from cache
        return caches.match(event.request).then(cached => {
          if (cached) return cached;
          // For navigation requests, serve index.html
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
        });
      })
  );
});

// ─── Message: handle SKIP_WAITING from UI ────────────────────────────────────

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

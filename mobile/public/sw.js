// Ensync Mobile service worker.
//
// It keeps the PWA installable and lets the app open without a network, while
// every Ensync Sync request stays network-first so job state always live-updates
// straight from the paired Host. Encrypted job/event payloads are never cached.

const SHELL_CACHE = 'ensync-mobile-shell-v1'
const STATIC_CACHE = 'ensync-mobile-static-v1'
const SHELL_PATHS = ['./', './index.html', './manifest.webmanifest']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_PATHS)).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== SHELL_CACHE && key !== STATIC_CACHE).map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  // Never cache Sync: traffic must always reflect the live Host.
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, './index.html'))
    return
  }

  event.respondWith(cacheFirst(request))
})

async function networkFirst(request, fallbackPath) {
  const cache = await caches.open(SHELL_CACHE)
  try {
    const response = await fetch(request)
    if (response && response.ok) await cache.put(request, response.clone())
    return response
  } catch {
    const cached = await cache.match(request) ?? await cache.match(fallbackPath)
    return cached ?? Response.error()
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE)
  const cached = await cache.match(request)
  if (cached) return cached
  try {
    const response = await fetch(request)
    if (response && response.ok) await cache.put(request, response.clone())
    return response
  } catch {
    return Response.error()
  }
}

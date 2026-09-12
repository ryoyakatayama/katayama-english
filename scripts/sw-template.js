/* Generated at build time. No learning records are stored in Cache Storage. */
const VERSION = '__VERSION__';
const ASSETS = __ASSETS__;
const BASE = new URL('./', self.location.href);
const PREFIX = `katayama-static:${BASE.pathname}:`;
const CACHE = PREFIX + VERSION;
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        await cache.addAll(
          ASSETS.map(
            (path) => new Request(new URL(path, BASE), { cache: 'reload' }),
          ),
        );
      } catch (error) {
        await caches.delete(CACHE);
        throw error;
      }
      // Stay waiting while the old version has open tabs. The UI offers an update button.
    })(),
  );
});
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name.startsWith(PREFIX) && name !== CACHE)
          await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== 'GET' ||
    url.origin !== BASE.origin ||
    !url.pathname.startsWith(BASE.pathname)
  )
    return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (
        event.request.mode === 'navigate' ||
        url.pathname === BASE.pathname ||
        url.pathname === new URL('index.html', BASE).pathname
      ) {
        const index = await cache.match(new URL('index.html', BASE));
        if (index) return index;
      }
      const cached = await cache.match(event.request, { ignoreSearch: true });
      if (cached) return cached;
      try {
        return await fetch(event.request);
      } catch {
        return new Response('Offline', { status: 503 });
      }
    })(),
  );
});

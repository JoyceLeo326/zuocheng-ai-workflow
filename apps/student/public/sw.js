/* global self, caches, fetch, URL, Response */

const CACHE_PREFIX = 'zuocheng-shell-';
const SHELL_CACHE = `${CACHE_PREFIX}v3`;
const SHELL_FALLBACK = new URL('./', self.registration.scope).pathname;
const SCOPE_PATH = new URL(self.registration.scope).pathname;
const STATIC_PATH_PREFIXES = [
  `${SCOPE_PATH}assets/`,
  `${SCOPE_PATH}ocr/`,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.add(SHELL_FALLBACK))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key.startsWith(CACHE_PREFIX) && key !== SHELL_CACHE,
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (!isSafeGet(request, url)) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => response)
        .catch(async () => {
          const cached = await caches.match(SHELL_FALLBACK);
          return cached ?? Response.error();
        }),
    );
    return;
  }

  if (
    !STATIC_PATH_PREFIXES.some((prefix) =>
      url.pathname.startsWith(prefix),
    )
  ) {
    return;
  }

  event.respondWith(
    caches.match(request).then(async (cached) => {
      if (cached !== undefined) {
        return cached;
      }
      const response = await fetch(request);
      if (isCacheableStaticResponse(response)) {
        const cache = await caches.open(SHELL_CACHE);
        await cache.put(request, response.clone());
      }
      return response;
    }),
  );
});

function isSafeGet(request, url) {
  if (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    request.cache === 'no-store' ||
    request.headers.has('Authorization')
  ) {
    return false;
  }
  return !['/api/', '/v1/', '/admin/'].some((prefix) =>
    url.pathname.startsWith(prefix),
  );
}

function isCacheableStaticResponse(response) {
  if (!response.ok) {
    return false;
  }
  const cacheControl = response.headers.get('Cache-Control') ?? '';
  if (/(?:^|,)\s*(?:no-store|private)(?:\s|,|$)/iu.test(cacheControl)) {
    return false;
  }
  return response.headers.get('Vary') !== '*';
}

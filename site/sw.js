// Signal Harvester service worker — network-first with cache fallback so the
// last-loaded snapshot (app shell + data JSON) is readable offline.
const CACHE = "signal-harvester-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      try {
        const res = await fetch(req);
        // Cache a copy of successful same-origin responses for offline use.
        if (res && res.status === 200) {
          const cache = await caches.open(CACHE);
          cache.put(req, res.clone());
        }
        return res;
      } catch {
        const cached = await caches.match(req);
        if (cached) return cached;
        // Offline navigation: fall back to the cached app shell.
        if (req.mode === "navigate") {
          const shell = await caches.match(self.registration.scope);
          if (shell) return shell;
        }
        throw new Error("offline and uncached");
      }
    })(),
  );
});

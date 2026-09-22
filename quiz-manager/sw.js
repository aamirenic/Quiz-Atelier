/* Quiz Atelier service worker — app shell cache for offline use.
   Strategy:
   - App shell (HTML/CSS/JS inside index.html, manifest, icon): cache-first.
     A new HTML build is picked up on the next reload after a network probe.
   - API calls (/api/*) and Gemini: NETWORK ONLY — never cached, so logins,
     workspace sync and AI calls always reflect live state.
   - Everything else (e.g. YouTube thumbnails): network, no caching.
   Bump CACHE_VERSION on every webapp release so clients pick up new builds. */
const CACHE_VERSION = "qa-v1.7.8";
const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/favicon.ico",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // individual put() so one 404 can't fail the whole install
    await Promise.allSettled(SHELL.map((url) => cache.add(url)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;                       // POSTs (login, sync, AI) go to network
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/")) return;           // live data — never cached
  if (url.hostname.includes("generativelanguage")) return; // Gemini — never cached
  if (url.pathname.startsWith("/api")) return;            // safety net for path variants

  // App shell: cache-first, refresh in the background (stale-while-revalidate)
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(req, { ignoreSearch: req.url.endsWith("/") });
    const network = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (cached) {
      event.waitUntil(network); // keep revalidating without blocking the page
      return cached;
    }
    const fresh = await network;
    if (fresh) return fresh;
    // offline + not cached: fall back to the app shell (SPA-style routing)
    const shell = await cache.match("/index.html");
    if (shell) return shell;
    return new Response("Offline and not cached", { status: 503, statusText: "Offline" });
  })());
});

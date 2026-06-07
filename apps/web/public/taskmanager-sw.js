const CACHE_NAME = "luma-tasks-shell-v6";
const SHELL_URLS = [
  "/taskmanager",
  "/taskmanager.webmanifest",
  "/taskmanager-favicon.png",
  "/taskmanager-apple-touch-icon.png",
  "/icons/taskmanager-icon-192.png",
  "/icons/taskmanager-icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (event.request.mode === "navigate" && url.pathname.startsWith("/taskmanager")) {
    event.respondWith(fetch(event.request).catch(() => caches.match("/taskmanager")));
    return;
  }

  if (SHELL_URLS.includes(url.pathname)) {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
  }
});

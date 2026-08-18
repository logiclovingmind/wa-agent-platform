// The app shell, and nothing else.
//
// This deliberately does not cache a single customer row. Everything that matters here
// is same-origin static build output; conversations, messages and leads come from
// Supabase and the Worker on other origins, and a cached copy of those would be a
// dashboard confidently showing yesterday's inbox to someone deciding who to call. It
// would also be customer data sitting in a cache on a shared phone with no way to erase
// it when a DPDP request arrives.
//
// So: hashed assets are cache-first (their name changes when their content does), the
// document is network-first with the last good copy as the offline fallback, and every
// cross-origin request is left completely alone.
const CACHE = "flowin-shell-v1";

self.addEventListener("install", (event) => {
  // The document only. Hashed assets arrive on first fetch, and precaching them would
  // mean parsing the build manifest here to learn their names.
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(["/", "/manifest.webmanifest"])),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The partner brief is a static page that happens to share this origin. Through the
  // navigate branch below it would be stored as the cached "/" shell, and the next
  // offline launch of the installed dashboard would open a sales page.
  if (url.pathname.startsWith("/portfolio")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put("/", copy));
          return response;
        })
        .catch(() => caches.match("/").then((hit) => hit ?? Response.error())),
    );
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((response) => {
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(request, copy));
            return response;
          }),
      ),
    );
  }
});

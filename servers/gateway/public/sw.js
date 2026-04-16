/**
 * Crow Service Worker — PWA + Web Push
 *
 * Cache-first for static assets, network-first for API/dashboard.
 * Handles push events and notification clicks.
 */

const CACHE_NAME = "crow-v1";
const SHELL_ASSETS = ["/dashboard/nest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(SHELL_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  // Clean up old caches
  e.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = e.request.url;

  // Don't intercept cross-origin requests. When the SW re-fetches a
  // stylesheet/font that the <link> tag would have fetched natively, the
  // SW's fetch() call is subject to the page's connect-src (which is 'self'
  // here), even though the original request was allowed under style-src /
  // font-src. Letting cross-origin requests fall through avoids spurious
  // CSP violations (Google Fonts CSS was the offender).
  let reqOrigin;
  try { reqOrigin = new URL(url).origin; } catch { reqOrigin = null; }
  if (reqOrigin && reqOrigin !== self.location.origin) return;

  // Special case: /dashboard/nest is pre-cached for offline shell loading
  if (url.endsWith("/dashboard/nest")) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }

  // Other /dashboard/* routes: network-only, NO cache fallback.
  // Under Turbo Drive, a cache fallback would return stale HTML to the
  // body-swap machinery, potentially corrupting the UI. Let the browser's
  // native offline UI handle failed fetches.
  if (url.includes("/dashboard/")) {
    e.respondWith(fetch(e.request));
    return;
  }

  // API routes: network-first with cache fallback (existing behavior)
  if (url.includes("/api/")) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }

  // Cache-first for static assets (icons, fonts, etc.)
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});

self.addEventListener("push", (e) => {
  const data = e.data?.json() || {};
  e.waitUntil(
    self.registration.showNotification(data.title || "Crow", {
      body: data.body || "",
      icon: "/icons/crow-icon.svg",
      badge: "/icons/crow-icon.svg",
      data: { url: data.url || "/dashboard/nest" },
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data?.url || "/dashboard/nest";
  e.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        // Focus existing window if one is open
        for (const client of windowClients) {
          if (client.url.includes("/dashboard/") && "focus" in client) {
            client.navigate(url);
            return client.focus();
          }
        }
        // Otherwise open a new window
        return self.clients.openWindow(url);
      })
  );
});

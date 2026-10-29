/**
 * Crow Service Worker — PWA + Web Push
 *
 * Cache-first for static assets, network-first for API/dashboard.
 * Handles push events and notification clicks.
 */

// v3: drops a v2 cache that may hold the nest rendered inside the new shell.
const CACHE_NAME = "crow-v3";
const SHELL_ASSETS = ["/dashboard/nest"];

// The offline copy of the nest is kept only when the nest itself answered.
// A new-mode device's /dashboard/nest redirects to its new home (Chat), and a
// redirected response may not answer a navigation (redirect: "manual"), so
// such a device keeps no offline copy: it gets the browser's own offline page,
// as every other /dashboard/ route does. A failed fetch never fails install.
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => Promise.all(SHELL_ASSETS.map((path) =>
    fetch(path, { credentials: "same-origin", redirect: "manual" })
      .then((r) => (r.ok && r.type === "basic" && !r.redirected ? c.put(path, r) : undefined))
      .catch(() => undefined)))));
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

  // PR-F explicit guard (2026-09-13): the perch interactive API is
  // authenticated JSON, and its /events route is SSE. Never intercept
  // either. Authed responses must not touch any cache path — and even
  // respondWith(fetch()) on an event-stream route pipes the stream
  // through the SW's fetch layer instead of the browser's native
  // EventSource handling. No respondWith at all keeps both exactly as
  // if this worker were not there.
  if (url.includes("/dashboard/perch-api/")) return;
  if (e.request.destination === "eventsource") return;
  try {
    if ((e.request.headers.get("accept") || "").includes("text/event-stream")) return;
  } catch { /* header read on an odd request — let the branches below decide */ }

  // Special case: /dashboard/nest is pre-cached for offline shell loading
  // (a classic device only; see install). Online, the network answers, so a
  // new-mode device follows its redirect to Chat.
  if (url.endsWith("/dashboard/nest")) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  // The PWA's start_url, /dashboard, routes per mode; offline, it falls back
  // to the same cached nest (present for a classic device only).
  let path = null;
  try { path = new URL(url).pathname; } catch { /* odd URL: the branches below decide */ }
  if (path === "/dashboard" && e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).catch(() => caches.match("/dashboard/nest").then((r) => r || Response.error())));
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
      data: { url: data.url || "/dashboard" },
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  // /dashboard routes per device mode (new → Chat, classic → the nest).
  const url = e.notification.data?.url || "/dashboard";
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

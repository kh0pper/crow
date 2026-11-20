/**
 * The dashboard's CSRF token helper — ONE definition, loaded by every page that
 * needs a token (`<script src="/csrf-client.js"></script>` in the layout's head
 * and on the standalone pages: kiosk, Studio, the staged draft page).
 *
 * The token is SERVER-BOUND: the server computes HMAC(secret, session id) and
 * delivers it in `<meta name="crow-csrf" content="…">`. It is never stored in a
 * cookie and never read from one — `crow_csrf` is retired, and reading it would
 * be exactly the cookie-tossing hole this replaces (`ts.net` is a public suffix,
 * so a sibling host on the tailnet is the same SITE and can write such a cookie).
 *
 *   window.crowCsrf()         → the current token, synchronously ("" before one
 *                               is known). Prefer the cached value; fall back to
 *                               the meta tag so a Turbo body swap still works.
 *   window.crowCsrfSet(tok)   → adopt a fresh token (updates the meta tag too).
 *   window.crowCsrfRefresh()  → Promise<token>: GET /dashboard/csrf once
 *                               (same-origin, no-store) and cache it. This is the
 *                               endpoint-only path for pages rendered without a
 *                               meta tag; the shared fetch wrapper in layout.js
 *                               calls it once and retries on a 403 refusal.
 *
 * Classic script on purpose: it has to run before any panel script and must be
 * usable from a plain (non-module) page.
 */
(function () {
  if (typeof window === "undefined" || window.crowCsrf) return;

  var cached = "";

  function fromMeta() {
    try {
      var m = document.querySelector && document.querySelector('meta[name="crow-csrf"]');
      var v = m && m.getAttribute("content");
      return typeof v === "string" ? v : "";
    } catch (e) {
      return "";
    }
  }

  window.crowCsrf = function () {
    return cached || fromMeta() || "";
  };

  window.crowCsrfSet = function (token) {
    if (typeof token === "string" && token) {
      cached = token;
      try {
        var m = document.querySelector && document.querySelector('meta[name="crow-csrf"]');
        if (m) m.setAttribute("content", token);
      } catch (e) { /* no document: the cache is enough */ }
    }
    return window.crowCsrf();
  };

  window.crowCsrfRefresh = function () {
    if (typeof window.fetch !== "function") return Promise.resolve(window.crowCsrf());
    return window
      .fetch("/dashboard/csrf", {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      })
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .then(function (j) {
        return j && typeof j.token === "string" && j.token
          ? window.crowCsrfSet(j.token)
          : window.crowCsrf();
      })
      .catch(function () { return window.crowCsrf(); });
  };

  // A page rendered WITHOUT a meta tag (kiosk, Studio, the staged page, any
  // bundle page outside the dashboard layout) gets its token from the endpoint,
  // once, as soon as the document is parsed.
  function bootstrap() {
    if (!fromMeta() && !cached) window.crowCsrfRefresh();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();
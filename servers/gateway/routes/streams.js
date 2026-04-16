/**
 * Turbo Streams — server-pushed HTML fragments for live dashboard UI.
 *
 * All routes live under /dashboard/streams/*. This prefix is
 * intentionally omitted from `PUBLIC_FUNNEL_PREFIXES` in
 * servers/gateway/index.js so Tailscale Funnel traffic is rejected with
 * HTTP 403 before it reaches these handlers. Do NOT add /dashboard or
 * /dashboard/streams to the Funnel allowlist — doing so publishes every
 * stream's emitted data (unread counts, media state, orchestrator
 * events) to the public internet.
 *
 * Funnel smoke test (run after any router change that touches this
 * file):
 *   curl -H "Tailscale-Funnel-Request: 1" -i \
 *     http://localhost:3002/dashboard/streams/notifications
 *   # Expect: HTTP/1.1 403 Forbidden
 *
 * Escape contract: every Turbo Stream body is built via the `html`
 * tag function from streams/turbo-stream.js. Never interpolate user
 * data into `turboStream()` / `sseTurbo()` without routing through
 * `html\`\`` (or an explicit reviewed `raw()`).
 */

import { Router } from "express";
import { createDbClient } from "../../db.js";
import bus from "../../shared/event-bus.js";
import { openAuthedStream } from "../streams/authed-stream.js";
import { html, sseTurbo } from "../streams/turbo-stream.js";

export default function streamsRouter(dashboardAuth) {
  const router = Router();

  router.use("/dashboard/streams", dashboardAuth);

  // --- Notifications bell badge (C.2) ---
  //
  // Emits an `update` stream keyed on `#notif-badge-count` every time a
  // notification is created. The payload carries the fresh unread
  // count so the client does not have to re-fetch `/api/notifications/
  // count`. Fallback polling at 5 min (see shared/notifications.js)
  // stays in place as a safety net for transient SSE drops.
  router.get("/dashboard/streams/notifications", (req, res) => {
    const { sendRaw } = openAuthedStream(req, res);

    const handler = (payload) => {
      try {
        const count = Number(payload?.unreadCount ?? 0);
        const display = count > 99 ? "99+" : String(count);
        const style = count > 0 ? "display:flex" : "display:none";
        sseTurbo(
          sendRaw,
          "replace",
          "notif-badge",
          html`<span id="notif-badge" class="notif-badge" style="${style}">${display}</span>`,
        );
      } catch {
        // Subscriber isolation — never let a render error kill sibling streams.
      }
    };

    bus.on("notifications:changed", handler);
    res.on("close", () => bus.off("notifications:changed", handler));
    res.on("error", () => bus.off("notifications:changed", handler));
  });

  // --- Messages peer-badge updates (C.3) ---
  //
  // Two emit sites feed this stream:
  //   - servers/sharing/nostr.js      — live inbound peer message
  //   - servers/sharing/instance-sync.js::_applyEntry()
  //                                   — paired-instance synced rows
  // Both pre-compute the per-peer unread count. The stream replaces
  // the specific <span id="badge-peer-<contactId>"> so sibling badges
  // stay untouched. Badge-only here; message-body live updates are
  // deferred to a later plan.
  router.get("/dashboard/streams/messages", (req, res) => {
    const { sendRaw } = openAuthedStream(req, res);

    const handler = (payload) => {
      try {
        const contactId = payload?.contactId;
        if (contactId == null) return;
        const unread = Number(payload?.unread ?? 0);
        const unreadClass = unread > 0 ? "msg-unread-badge visible" : "msg-unread-badge";
        const display = unread > 0 ? String(unread) : "";
        sseTurbo(
          sendRaw,
          "replace",
          `badge-peer-${contactId}`,
          html`<span id="badge-peer-${contactId}" class="${unreadClass}" data-badge-peer="${contactId}">${display}</span>`,
        );
      } catch {
        // Subscriber isolation.
      }
    };

    bus.on("messages:changed", handler);
    res.on("close", () => bus.off("messages:changed", handler));
    res.on("error", () => bus.off("messages:changed", handler));
  });

  return router;
}

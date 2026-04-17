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
import { html, raw, sseTurbo } from "../streams/turbo-stream.js";

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

  // --- Orchestrator event timeline (C.4) ---
  //
  // Emits one `<turbo-stream action="prepend" target="orch-event-tbody">`
  // per new orchestrator_events row. Replaces the previous 5s
  // self-reload of the entire page with pushed HTML fragments. The
  // fallback reload stays at 5 min.
  //
  // Real event_type strings handled here (as of 2026-04-16):
  //   dispatch.{provider_ready,provider_failed,aborted,run_start,
  //             run_complete,run_error}
  //   lifecycle.{ref_inc,warm_existing,bundle_start,
  //              bundle_start_failed,warm_timeout,warmed,
  //              release_ignored_pinned,ref_dec,bundle_stop,released,
  //              refcounts_reset}
  // Every emit goes to the same target; the panel's client-side
  // doesn't branch by event_type (keeps the Stream surface narrow).
  // Filtered views (?run=...) do NOT mount a stream source; they rely
  // on the 5-min reload fallback.
  router.get("/dashboard/streams/orchestrator", (req, res) => {
    const { sendRaw } = openAuthedStream(req, res);

    const handler = (payload) => {
      try {
        const eventType = String(payload?.event_type ?? "");
        const provider = payload?.provider_id ?? "-";
        const runId = payload?.run_id ?? "";
        const at = String(payload?.at ?? "");
        const dataStr = payload?.data == null
          ? ""
          : typeof payload.data === "string"
            ? payload.data
            : (() => {
                try {
                  return JSON.stringify(payload.data);
                } catch {
                  return "";
                }
              })();
        const detailBits = [];
        if (payload?.preset) detailBits.push(`preset=${payload.preset}`);
        if (payload?.bundle_id) detailBits.push(`bundle=${payload.bundle_id}`);
        if (typeof payload?.refs === "number") detailBits.push(`refs=${payload.refs}`);
        const meta = detailBits.join(" · ");
        // runLink is pre-built escaped HTML; wrap in raw() so the
        // outer html`` tag doesn't double-escape its tags.
        const runLinkHtml = runId
          ? html`<a href="?run=${runId}" style="color:var(--crow-accent);text-decoration:none">${runId.slice(0, 14)}</a>`
          : "-";
        const detailSuffix = dataStr ? html` · ${dataStr}` : "";
        const row = html`<tr data-turbo-event="${eventType}">
          <td style="padding:4px 8px;color:var(--crow-text-muted);font-family:'JetBrains Mono',monospace;font-size:0.78rem;white-space:nowrap">${at.slice(11, 19)}</td>
          <td style="padding:4px 8px;font-family:'JetBrains Mono',monospace;font-size:0.8rem">${eventType}</td>
          <td style="padding:4px 8px;font-family:'JetBrains Mono',monospace;font-size:0.8rem">${provider}</td>
          <td style="padding:4px 8px;font-family:'JetBrains Mono',monospace;font-size:0.78rem;color:var(--crow-text-muted)">${raw(runLinkHtml)}</td>
          <td style="padding:4px 8px;font-size:0.78rem;color:var(--crow-text-muted)">${meta}${raw(detailSuffix)}</td>
        </tr>`;
        sseTurbo(sendRaw, "prepend", "orch-event-tbody", row);
      } catch {
        // Subscriber isolation.
      }
    };

    bus.on("orchestrator:event", handler);
    res.on("close", () => bus.off("orchestrator:event", handler));
    res.on("error", () => bus.off("orchestrator:event", handler));
  });

  return router;
}

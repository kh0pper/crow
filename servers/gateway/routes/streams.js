/**
 * Turbo Streams — server-pushed HTML fragments for live dashboard UI.
 *
 * All routes live under /dashboard/streams/*. This prefix is
 * intentionally omitted from `PUBLIC_FUNNEL_PREFIXES` in
 * servers/gateway/index.js so Tailscale Funnel traffic is rejected with
 * HTTP 403 before it reaches these handlers. Do NOT add /dashboard or
 * /dashboard/streams to the Funnel allowlist — doing so publishes every
 * stream's emitted data (unread counts, media state) to the public
 * internet.
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
// THE board lock predicate (job rail + session rail). This tick's snapshot is
// diffed against the SSR render's data-locked attribute by the panel client, so
// a second, narrower predicate here does not just mis-draw a badge — it makes
// the two sides permanently disagree and the client reload forever.
import { lockedCardIds } from "./board-lock.js";
import { html, raw, sseTurbo } from "../streams/turbo-stream.js";
// Instance-aware tasks.db resolution (CROW_TASKS_DB_PATH wins; else the db
// sits beside the crow.db actually in use). Same resolver bot-board-api uses.
import { tasksDbPath } from "../../../scripts/pi-bots/instance-paths.mjs";
// Board config resolution (Track 0 Phase A: project/cards boards; Phase B:
// slug/custom-tracker boards). Both defs live in tasks.db's board_defs.
import { resolveBoardDef, resolveSlugBoardDef } from "./board-defs.js";

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
    const stream = openAuthedStream(req, res);
    if (!stream) return;
    const { sendRaw } = stream;

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

  // --- Messages peer-badge updates + live named events (C.3, F-UI-4/6) ---
  //
  // Two emit sites feed the badge/crow-msg side of this stream:
  //   - servers/sharing/nostr.js      — live inbound peer message
  //   - servers/sharing/instance-sync.js::_applyEntry()
  //                                   — paired-instance synced rows
  // Both pre-compute the per-peer unread count. The stream replaces
  // the specific <span id="badge-peer-<contactId>"> so sibling badges
  // stay untouched. Alongside the badge turbo-stream frame, this route
  // ALSO emits a `crow-msg` NAMED SSE event with the same payload —
  // named events are invisible to <turbo-stream-source> (it only
  // consumes default "message" events), so a panel's own EventSource
  // (client.js) can react without disturbing the badge behavior above.
  //
  // A SEPARATE `crow-receipt` named event forwards `messages:receipt`
  // (emitted from servers/sharing/boot.js::handleDeliveryReceipt) so an
  // open conversation can flip ✓→✓✓ live. This is a distinct bus event
  // from messages:changed — that consumer contract stays badge-only.
  router.get("/dashboard/streams/messages", (req, res) => {
    const stream = openAuthedStream(req, res);
    if (!stream) return;
    const { sendRaw } = stream;

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
        // F-UI-4: named event for the panel's own EventSource (client.js).
        // Named events are invisible to <turbo-stream-source> (it only
        // consumes default "message" events), so badge behavior above is
        // untouched. Payload is server-derived numbers only.
        sendRaw(`event: crow-msg\ndata: ${JSON.stringify({ contactId: Number(contactId), unread })}\n\n`);
      } catch {
        // Subscriber isolation.
      }
    };

    // F-UI-6: delivery receipts flip ✓→✓✓ live in an open conversation. A
    // SEPARATE bus event from messages:changed — that consumer contract is
    // badge-only and reads payload.unread (see boot.js handleDeliveryReceipt).
    const receiptHandler = (payload) => {
      try {
        const contactId = payload?.contactId;
        if (contactId == null) return;
        const ids = (Array.isArray(payload?.ids) ? payload.ids : [])
          .map(Number)
          .filter(Number.isFinite);
        sendRaw(`event: crow-receipt\ndata: ${JSON.stringify({ contactId: Number(contactId), ids })}\n\n`);
      } catch {
        // Subscriber isolation.
      }
    };

    bus.on("messages:changed", handler);
    bus.on("messages:receipt", receiptHandler);
    res.on("close", () => { bus.off("messages:changed", handler); bus.off("messages:receipt", receiptHandler); });
    res.on("error", () => { bus.off("messages:changed", handler); bus.off("messages:receipt", receiptHandler); });
  });

  // --- Glasses media state (C.5) ---
  //
  // Emits JSON payloads over SSE (not Turbo Stream frames) because the
  // player bar's client-side logic in shared/player.js does more than
  // swap markup: it resolves `activeBackend` precedence (local audio
  // vs. glasses), keeps localStorage in sync across tabs, and drives
  // media-session metadata. Plain SSE lets player.js's
  // handleGlassesPollResult() consume the payload directly instead of
  // re-implementing that logic on the server.
  //
  // The stream is still gated by dashboardAuth and lives under
  // /dashboard/streams/* so the Funnel-reject middleware keeps it
  // private.
  //
  // Fallback poll in player.js keeps running at 5 min as a safety net.
  router.get("/dashboard/streams/glasses", (req, res) => {
    const stream = openAuthedStream(req, res);
    if (!stream) return;
    const { send } = stream;

    const handler = (payload) => {
      try {
        send("media", {
          device_id: payload?.deviceId || null,
          state: payload?.state || "idle",
          title: payload?.title || null,
          artist: payload?.artist || null,
          queue_length: payload?.queueLength || 0,
        });
      } catch {
        // Subscriber isolation.
      }
    };

    bus.on("glasses:media", handler);
    res.on("close", () => bus.off("glasses:media", handler));
    res.on("error", () => bus.off("glasses:media", handler));
  });

  // --- Extensions install/uninstall job progress (C.5) ---
  //
  // Emits JSON payloads over SSE. The Extensions panel's client-side
  // pollJob() is kept as a long fallback (in case the tab loses SSE
  // during an install), but the stream drives the log-line updates
  // that users want to see live. Status transitions are rare (one per
  // install) and narrowly scoped so we don't need per-job filtering
  // on the server — the client picks out its own job by id.
  router.get("/dashboard/streams/jobs", (req, res) => {
    const stream = openAuthedStream(req, res);
    if (!stream) return;
    const { send } = stream;

    const handler = (payload) => {
      try {
        send("job", {
          job_id: payload?.jobId || null,
          status: payload?.status || "running",
          addon_id: payload?.addonId || null,
          action: payload?.action || null,
          last_line: payload?.lastLine || "",
          started_at: payload?.startedAt || null,
          completed_at: payload?.completedAt || null,
        });
      } catch {
        // Subscriber isolation.
      }
    };

    bus.on("jobs:changed", handler);
    res.on("close", () => bus.off("jobs:changed", handler));
    res.on("error", () => bus.off("jobs:changed", handler));
  });

  // --- Bot Builder run monitor (Crow Bot Builder Phase 2.5) ---
  //
  // POLL-based, unlike the bus-driven streams above: the Bot Session Bridge
  // runs in a SEPARATE process (pibot-bridge.timer oneshot), so the gateway's
  // in-process event bus never sees its turns. bot_sessions in crow.db is the
  // runtime authority the bridge persists every turn — we stream that.
  //
  // ONE createDbClient() per SSE connection (NOT per tick): inside the gateway
  // process it inherits CROW_JOURNAL_MODE=DELETE + ensureKeeper(), the same
  // WAL-scar-safe path the gateway already uses everywhere — reused each tick,
  // closed on teardown. Defensive: bot_sessions is absent on the primary
  // gateway's crow.db, so a failed query just emits nothing that tick.
  router.get("/dashboard/streams/bot-sessions", (req, res) => {
    const stream = openAuthedStream(req, res);
    if (!stream) return;
    const { sendRaw } = stream;
    let db;
    try {
      db = createDbClient();
    } catch {
      db = null;
    }
    let timer = null;
    const COLOR = { active: "#1a7f37", "waiting-user": "#b8860b", stopped: "#888", done: "#2d6cdf", error: "#c0392b" };
    const tick = async () => {
      try {
        if (!db) return;
        const r = await db.execute({
          sql:
            "SELECT id, bot_id, status, model, escalated, control, card_id, gateway_thread_id, datetime(updated_at) AS updated_at " +
            "FROM bot_sessions ORDER BY updated_at DESC LIMIT 50",
          args: [],
        });
        const rows = r.rows || [];
        const trs = rows.length
          ? rows
              .map((s) => {
                const c = COLOR[s.status] || "#333";
                return html`<tr>
                  <td style="padding:4px 8px">${String(s.id)}</td>
                  <td style="padding:4px 8px">${String(s.bot_id || "")}</td>
                  <td style="padding:4px 8px;color:${c};font-weight:600">${String(s.status || "")}</td>
                  <td style="padding:4px 8px;font-family:monospace;font-size:.8rem">${String(s.model || "—")}</td>
                  <td style="padding:4px 8px">${Number(s.escalated) ? "yes" : "—"}</td>
                  <td style="padding:4px 8px">${String(s.control || "")}</td>
                  <td style="padding:4px 8px">${s.card_id == null ? "—" : String(s.card_id)}</td>
                  <td style="padding:4px 8px;font-family:monospace;font-size:.8rem">${String(s.gateway_thread_id || "").slice(0, 18)}</td>
                  <td style="padding:4px 8px;color:#888">${String(s.updated_at || "")}</td>
                </tr>`;
              })
              .join("")
          : html`<tr><td colspan="9" style="padding:8px;color:#888">No bot sessions yet.</td></tr>`;
        sseTurbo(
          sendRaw,
          "replace",
          "pibot-sessions-tbody",
          html`<tbody id="pibot-sessions-tbody">${raw(trs)}</tbody>`,
        );
      } catch {
        // table absent (primary gateway) / transient — emit nothing this tick.
      }
    };
    tick();
    timer = setInterval(tick, 5000);
    const cleanup = () => {
      if (timer) clearInterval(timer);
      timer = null;
      if (db) {
        try {
          db.close();
        } catch {
          /* already closed */
        }
        db = null;
      }
    };
    res.on("close", cleanup);
    res.on("error", cleanup);
  });

  // --- Bot Builder Kanban board live overlay (Crow Bot Builder Phase 4) ---
  //
  // POLL-based like the run monitor above, but a materially different
  // 2-client async workload: per `?project=N` it snapshots tasks.db cards +
  // the crow.db whole-card lock state every 5s, diffs vs the last sent, and
  // pushes the authoritative snapshot (a default-event `data:` JSON line,
  // consumed by the panel's native EventSource.onmessage) only when it
  // changed. The client reconciles by card id and never clobbers an
  // in-flight drag / open drawer (poll-authoritative + local echo, D4).
  //
  // Hardening (plan Step 4 — NOT a verbatim run-monitor mirror): both
  // clients opened with throw-closes-partial BEFORE the interval arms; a
  // re-entrancy guard (a tick awaits two cross-DB queries, each up to the
  // busy_timeout — it must never overlap itself); cleanup sets a closed
  // flag + clears the interval and closes the clients only when no tick is
  // in flight (else the tick's finally closes them — no use-after-close);
  // the lock read is delegated to board-lock.js's batched form (IN-list per
  // rail, no per-card loop — two rails, so two queries; the SSR render runs
  // the same call, which is what keeps the snapshot and the page convergent),
  // never a per-card loop ⇒ 3 queries/tick. createDbClient() inherits
  // CROW_JOURNAL_MODE=DELETE on this gateway (tasks.db opened DELETE — no
  // WAL flip); no direct better-sqlite3 constructor here. Defensive: on the
  // primary gateway the tables are absent, so the first tick errors, is
  // swallowed (stderr-only), the last snapshot is kept, the stream stays up.
  router.get("/dashboard/streams/bot-board", async (req, res) => {
    const stream = openAuthedStream(req, res);
    if (!stream) return;
    const { sendRaw } = stream;
    const TASKS_DB = tasksDbPath();

    // Resolve bot or project at connection time (once, not per tick)
    const botId = req.query.bot || null;
    const projectId = req.query.project != null ? Number(req.query.project) : null;
    let trackerType = "kanban";
    let trackerDefId = null;
    let resolvedProjectId = projectId;

    let tdb = null;
    let cdb = null;
    // Phase B: custom (slug) trackers converged into tasks.db too, so tdb is
    // opened for every board type now — not just kanban/task-list. The def
    // itself is resolved once here (never re-queried per tick) and reused
    // both for trackerDefId and for the board-config frame below.
    let slugDef = null;
    try {
      cdb = createDbClient();
      tdb = createDbClient(TASKS_DB);
      if (botId) {
        const botRow = (await cdb.execute({ sql: "SELECT definition, project_id FROM pi_bot_defs WHERE bot_id=?", args: [botId] })).rows[0];
        if (botRow) {
          let def; try { def = JSON.parse(botRow.definition || "{}"); } catch { def = {}; }
          const tc = def.tracker_config || {};
          trackerType = tc.type || "kanban";
          resolvedProjectId = botRow.project_id != null ? Number(botRow.project_id) : null;
          if (trackerType === "custom" && tc.tracker_slug) {
            slugDef = await resolveSlugBoardDef(tdb, tc.tracker_slug);
            if (slugDef) trackerDefId = slugDef.id;
          }
        }
      }
    } catch {
      if (tdb) { try { tdb.close(); } catch {} tdb = null; }
      if (cdb) { try { cdb.close(); } catch {} cdb = null; }
      return;
    }

    let closed = false;
    let tickInFlight = false;
    let timer = null;
    let last = null;

    // Track 0: the board's configured status list rides a SEPARATE named
    // event, once per stream open — deliberately OUTSIDE the diffed
    // {cards, locks} payload. Folding it into the default event would make a
    // def edit a permanent diff on every already-open board: the reload it
    // triggers re-detects the same difference forever (the exact reload-storm
    // the html.js tracker-query comment memorializes). The client compares
    // against its rendered columns and reloads at most once per guard window.
    if (tdb && trackerType === "custom" && slugDef) {
      try {
        sendRaw(`event: board-config\ndata: ${JSON.stringify({ statuses: slugDef.status_values })}\n\n`);
      } catch { /* config frame is best-effort; the board renders without it */ }
    // F5: this ELSE-IF is the PROJECT-board config frame — it must not fire
    // for a custom-typed bot whose slug def is missing/deleted (tdb is now
    // always open, so resolvedProjectId being an integer alone used to be
    // enough to reach here even when trackerType === "custom"). Without this
    // guard a custom bot with a bad tracker_slug — but a project_id still set
    // — got the PROJECT's board-config (wrong status list) instead of none.
    } else if (trackerType !== "custom" && tdb && Number.isInteger(resolvedProjectId)) {
      try {
        const def = await resolveBoardDef(tdb, { projectId: resolvedProjectId });
        sendRaw(`event: board-config\ndata: ${JSON.stringify({ statuses: def.status_values })}\n\n`);
      } catch { /* config frame is best-effort; the board renders without it */ }
    }

    const closeClients = () => {
      if (tdb) { try { tdb.close(); } catch {} tdb = null; }
      if (cdb) { try { cdb.close(); } catch {} cdb = null; }
    };
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (timer) { clearInterval(timer); timer = null; }
      if (!tickInFlight) closeClients();
    };

    const tick = async () => {
      if (closed || tickInFlight) return;
      tickInFlight = true;
      try {
        let cards = [];
        let locks = {};

        if (trackerType === "custom" && trackerDefId && tdb) {
          // D-T1.6: default view excludes archived — an archived-elsewhere
          // item must drop out of THIS tick's row set, which is what lets the
          // client's DOM-vs-frame removal check (client.js) catch it.
          const rows = (await tdb.execute({
            sql: "SELECT id, status, processing_lease_status FROM tasks_items WHERE board_id=? AND archived_at IS NULL ORDER BY priority ASC, id ASC",
            args: [trackerDefId],
          })).rows || [];
          cards = rows.map((r) => ({ id: Number(r.id), status: String(r.status) }));
          for (const r of rows) {
            if (String(r.processing_lease_status) === "in-progress") locks[Number(r.id)] = true;
          }
        } else if ((trackerType === "kanban" || trackerType === "task-list") && tdb && Number.isInteger(resolvedProjectId)) {
          const rows = (await tdb.execute({
            sql: "SELECT id, status FROM tasks_items WHERE project_id=? AND archived_at IS NULL ORDER BY priority ASC, id ASC",
            args: [resolvedProjectId],
          })).rows || [];
          cards = rows.map((c) => ({ id: Number(c.id), status: String(c.status) }));
          const ids = cards.map((c) => c.id).filter((n) => Number.isInteger(n));
          if (ids.length) {
            // Same predicate the SSR render uses (panels/bot-board/data-queries
            // lockMapFor also delegates here), so the stream snapshot and the
            // rendered board can always converge.
            for (const cid of await lockedCardIds(cdb, ids)) locks[cid] = true;
          }
        } else {
          return;
        }

        const json = JSON.stringify({ cards, locks });
        if (json !== last && !closed) {
          last = json;
          sendRaw(`data: ${json}\n\n`);
        }
      } catch (e) {
        process.stderr.write(`[bot-board-stream] tick error: ${e && e.message}\n`);
      } finally {
        tickInFlight = false;
        if (closed) closeClients();
      }
    };

    res.on("close", cleanup);
    res.on("error", cleanup);
    timer = setInterval(tick, 5000);
    tick();
  });

  return router;
}

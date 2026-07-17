/**
 * Crow's Nest Panel — PM Workspace
 *
 * Views (?view=):
 *   overview — today's due/overdue tasks, last digest, sync health
 *   notes    — note list + links to the drawing/markdown editors
 *   digests  — digest history; ?view=digests&id=N shows one digest's HTML
 *   sync     — pm_sync_log tail + manual "Run sync now" button
 *   planner  — approval queue for proposed calendar blocks (the dashboard
 *              gate surface), plus export/reconcile state
 *
 * Bundle-compatible: dynamic imports resolved from $CROW_HOME/bundles/
 * pm-workspace inside try/catch — the panel renders (degraded) even if
 * the bundle modules can't load.
 */

export default {
  id: "pm-workspace",
  name: "PM Workspace",
  icon: "book",
  route: "/dashboard/pm-workspace",
  navOrder: 40,
  category: "productivity",

  async handler(req, res, { db, layout, appRoot }) {
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");

    const componentsPath = join(appRoot, "servers/gateway/dashboard/shared/components.js");
    const { escapeHtml } = await import(pathToFileURL(componentsPath).href);

    const bundleDir = join(process.env.CROW_HOME || join(homedir(), ".crow"), "bundles", "pm-workspace");
    async function bundleImport(rel) {
      try {
        return await import(pathToFileURL(join(bundleDir, rel)).href);
      } catch {
        return null;
      }
    }

    // Ensure pm_* tables exist even if the MCP server hasn't started yet.
    try {
      const initMod = await bundleImport("server/init-tables.js");
      if (initMod) await initMod.initPmTables(db);
    } catch { /* degraded render below */ }

    const view = req.query.view || "overview";
    let body = "";

    // ── OVERVIEW ──
    if (view === "overview") {
      // Tasks due/overdue via the boards digest adapter (degrades if absent).
      let tasksHtml = '<p class="pm-muted">tasks adapter unavailable</p>';
      try {
        const boardsMod = await bundleImport("server/digest/adapters/boards.js");
        const configMod = await bundleImport("server/config.js");
        if (boardsMod && configMod) {
          const sections = await boardsMod.boardsSections(db, configMod.loadConfig());
          const tasks = sections.find((s) => s.title === "Tasks");
          if (tasks?.available && tasks.items?.length) {
            tasksHtml = tasks.items.map((item) => `
              <div class="pm-card${item.urgent ? " pm-urgent" : ""}">
                <strong>${escapeHtml(item.label)}</strong>
                ${item.detail ? `<div>${escapeHtml(item.detail)}</div>` : ""}
                ${item.meta ? `<div class="pm-muted">${escapeHtml(item.meta)}</div>` : ""}
              </div>`).join("");
          } else if (tasks?.available) {
            tasksHtml = `<p class="pm-muted">${escapeHtml(tasks.note || "No tasks due soon.")}</p>`;
          } else {
            tasksHtml = `<p class="pm-muted">${escapeHtml(tasks?.reason || "unavailable")}</p>`;
          }
        }
      } catch (err) {
        tasksHtml = `<p class="pm-muted">tasks unavailable: ${escapeHtml(err.message)}</p>`;
      }

      // Last digest
      let digestHtml = '<p class="pm-muted">No digests yet.</p>';
      try {
        const { rows } = await db.execute({
          sql: "SELECT digest_date, summary, sent_at, sent_via FROM pm_digests ORDER BY digest_date DESC LIMIT 1",
          args: [],
        });
        if (rows.length > 0) {
          const d = rows[0];
          digestHtml = `
            <div class="pm-card">
              <strong>${escapeHtml(d.digest_date)}</strong>
              <div>${escapeHtml(d.summary || "")}</div>
              <div class="pm-muted">${d.sent_at ? `sent ${escapeHtml(d.sent_at)} via ${escapeHtml(d.sent_via || "?")}` : "not sent"}</div>
            </div>`;
        }
      } catch { /* table missing */ }

      // Sync health tail
      let syncHtml = '<p class="pm-muted">No sync activity yet.</p>';
      try {
        const { rows } = await db.execute({
          sql: "SELECT run_at, action, board_id, item_ref, ok FROM pm_sync_log ORDER BY id DESC LIMIT 5",
          args: [],
        });
        if (rows.length > 0) {
          syncHtml = rows.map((r) => `
            <div class="pm-log-row${r.ok ? "" : " pm-urgent"}">
              <span class="pm-muted">${escapeHtml((r.run_at || "").slice(0, 16))}</span>
              ${escapeHtml(r.action)}${r.item_ref ? ` — ${escapeHtml(r.item_ref)}` : ""}${r.board_id ? ` <span class="pm-muted">(${escapeHtml(r.board_id)})</span>` : ""}
            </div>`).join("");
        }
      } catch { /* table missing */ }

      body = `
        <h3>Due &amp; overdue</h3>${tasksHtml}
        <h3>Last digest</h3>${digestHtml}
        <h3>Sync health</h3>${syncHtml}`;
    }

    // ── NOTES ──
    if (view === "notes") {
      let rowsHtml = "";
      try {
        const { rows } = await db.execute({
          sql: `SELECT id, title, kind, ocr_status, tags, updated_at FROM pm_notes ORDER BY updated_at DESC LIMIT 100`,
          args: [],
        });
        rowsHtml = rows.map((n) => `
          <tr>
            <td><a href="/pm/notes/${n.id}/edit">${escapeHtml(n.title || "Untitled")}</a></td>
            <td>${escapeHtml(n.kind)}</td>
            <td>${escapeHtml(n.kind === "drawing" ? n.ocr_status || "n/a" : "—")}</td>
            <td>${escapeHtml(n.tags || "")}</td>
            <td class="pm-muted">${escapeHtml((n.updated_at || "").slice(0, 16))}</td>
          </tr>`).join("");
      } catch (err) {
        rowsHtml = `<tr><td colspan="5" class="pm-muted">notes unavailable: ${escapeHtml(err.message)}</td></tr>`;
      }
      body = `
        <div style="margin-bottom:1rem;display:flex;gap:0.5rem">
          <a class="pm-btn" href="/pm/notes/new">+ Drawing note</a>
          <a class="pm-btn" href="/pm/notes/new-md">+ Markdown note</a>
        </div>
        <table class="pm-table">
          <thead><tr><th>Title</th><th>Kind</th><th>OCR</th><th>Tags</th><th>Updated</th></tr></thead>
          <tbody>${rowsHtml || '<tr><td colspan="5" class="pm-muted" style="text-align:center;padding:2rem">No notes yet.</td></tr>'}</tbody>
        </table>`;
    }

    // ── DIGESTS ──
    if (view === "digests") {
      const digestId = req.query.id ? Number(req.query.id) : null;
      if (digestId) {
        try {
          const { rows } = await db.execute({
            sql: "SELECT digest_date, html, summary FROM pm_digests WHERE id = ?",
            args: [digestId],
          });
          if (rows.length === 0) {
            body = '<p class="pm-muted">Digest not found.</p>';
          } else {
            body = `
              <p><a href="/dashboard/pm-workspace?view=digests">&larr; All digests</a></p>
              <h3>${escapeHtml(rows[0].digest_date)}</h3>
              <p class="pm-muted">${escapeHtml(rows[0].summary || "")}</p>
              <iframe sandbox="" srcdoc="${escapeHtml(rows[0].html || "")}"
                style="width:100%;height:70vh;border:1px solid var(--crow-border,#ccc);border-radius:8px;background:#fff"></iframe>`;
          }
        } catch (err) {
          body = `<p class="pm-muted">digests unavailable: ${escapeHtml(err.message)}</p>`;
        }
      } else {
        let rowsHtml = "";
        try {
          const { rows } = await db.execute({
            sql: "SELECT id, digest_date, summary, sent_at, sent_via FROM pm_digests ORDER BY digest_date DESC LIMIT 60",
            args: [],
          });
          rowsHtml = rows.map((d) => `
            <tr>
              <td><a href="/dashboard/pm-workspace?view=digests&id=${d.id}">${escapeHtml(d.digest_date)}</a></td>
              <td>${escapeHtml(d.summary || "")}</td>
              <td class="pm-muted">${d.sent_at ? `${escapeHtml(d.sent_via || "?")}` : "not sent"}</td>
            </tr>`).join("");
        } catch (err) {
          rowsHtml = `<tr><td colspan="3" class="pm-muted">digests unavailable: ${escapeHtml(err.message)}</td></tr>`;
        }
        body = `
          <div style="margin-bottom:1rem">
            <button class="pm-btn" onclick="pmDigestRun(true)">Preview today</button>
            <button class="pm-btn" onclick="pmDigestRun(false)">Run &amp; send now</button>
            <span id="pm-digest-status" class="pm-muted"></span>
          </div>
          <pre id="pm-digest-preview" style="display:none;white-space:pre-wrap;background:var(--crow-bg-surface,#f7f7f7);border:1px solid var(--crow-border,#ddd);border-radius:8px;padding:1rem;max-height:50vh;overflow:auto"></pre>
          <table class="pm-table">
            <thead><tr><th>Date</th><th>Summary</th><th>Sent</th></tr></thead>
            <tbody>${rowsHtml || '<tr><td colspan="3" class="pm-muted" style="text-align:center;padding:2rem">No digests yet.</td></tr>'}</tbody>
          </table>`;
      }
    }

    // ── SYNC ──
    if (view === "sync") {
      let stateHtml = "";
      try {
        const { rows } = await db.execute({
          sql: `SELECT board_id, local_kind, COUNT(*) AS n, MAX(last_synced_at) AS last
                FROM pm_sync_state GROUP BY board_id, local_kind ORDER BY board_id`,
          args: [],
        });
        stateHtml = rows.map((r) => `
          <tr><td>${escapeHtml(r.board_id)}</td><td>${escapeHtml(r.local_kind || "")}</td>
          <td>${r.n}</td><td class="pm-muted">${escapeHtml(r.last || "never")}</td></tr>`).join("");
      } catch { /* ignore */ }

      let logHtml = "";
      try {
        const { rows } = await db.execute({
          sql: `SELECT run_at, direction, board_id, action, item_ref, detail, ok
                FROM pm_sync_log ORDER BY id DESC LIMIT 40`,
          args: [],
        });
        logHtml = rows.map((r) => `
          <tr class="${r.ok ? "" : "pm-urgent"}">
            <td class="pm-muted">${escapeHtml((r.run_at || "").slice(0, 16))}</td>
            <td>${escapeHtml(r.action)}</td>
            <td>${escapeHtml(r.item_ref || "")}</td>
            <td class="pm-muted">${escapeHtml((r.detail || "").slice(0, 120))}</td>
          </tr>`).join("");
      } catch (err) {
        logHtml = `<tr><td colspan="4" class="pm-muted">sync log unavailable: ${escapeHtml(err.message)}</td></tr>`;
      }

      body = `
        <div style="margin-bottom:1rem">
          <button class="pm-btn" onclick="pmSyncRun()">Run sync now</button>
          <span id="pm-sync-status" class="pm-muted"></span>
        </div>
        <h3>Mapped boards</h3>
        <table class="pm-table">
          <thead><tr><th>Board</th><th>Target</th><th>Items</th><th>Last synced</th></tr></thead>
          <tbody>${stateHtml || '<tr><td colspan="4" class="pm-muted" style="text-align:center;padding:1.5rem">No boards synced yet.</td></tr>'}</tbody>
        </table>
        <h3>Recent activity</h3>
        <table class="pm-table">
          <thead><tr><th>When</th><th>Action</th><th>Item</th><th>Detail</th></tr></thead>
          <tbody>${logHtml || '<tr><td colspan="4" class="pm-muted" style="text-align:center;padding:1.5rem">No sync activity yet.</td></tr>'}</tbody>
        </table>`;
    }

    // ── PLANNER (approval queue) ──
    if (view === "planner") {
      let tz = "America/Chicago";
      try {
        const configMod = await bundleImport("server/config.js");
        if (configMod) tz = configMod.loadConfig().OUTLOOK_TZ || tz;
      } catch { /* default tz */ }

      const fmtWhen = (startUtc, endUtc) => {
        try {
          const opts = { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
          const s = new Date(startUtc).toLocaleString("en-US", opts);
          const e = new Date(endUtc).toLocaleString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
          return `${s} – ${e}`;
        } catch {
          return `${startUtc} – ${endUtc}`;
        }
      };

      let queue = [];
      let approved = [];
      let exported = [];
      let history = [];
      let plannerErr = null;
      try {
        const plannerMod = await bundleImport("server/planner.js");
        if (!plannerMod) throw new Error("planner module not available");
        queue = await plannerMod.list(db, { status: "proposed", limit: 100 });
        approved = await plannerMod.list(db, { status: "approved", limit: 100 });
        exported = await plannerMod.list(db, { status: "exported", limit: 100 });
        const all = await plannerMod.list(db, { limit: 60 });
        history = all.filter((e) => ["confirmed", "rejected", "cancelled"].includes(e.status)).slice(0, 20);
      } catch (err) {
        plannerErr = err.message;
      }

      const eventRow = (e, actions) => `
        <tr>
          <td><strong>${escapeHtml(e.title)}</strong>${e.location ? `<div class="pm-muted">${escapeHtml(e.location)}</div>` : ""}</td>
          <td>${escapeHtml(fmtWhen(e.start_utc, e.end_utc))}</td>
          <td class="pm-muted">${escapeHtml(e.source || "")}</td>
          <td>${actions}</td>
        </tr>`;

      const queueHtml = queue.map((e) => eventRow(e, `
        <button class="pm-btn" onclick="pmPlanDecide('${escapeHtml(e.uid)}','approved')">Approve</button>
        <button class="pm-btn pm-btn-danger" onclick="pmPlanDecide('${escapeHtml(e.uid)}','rejected')">Reject</button>`)).join("");

      const approvedHtml = approved.map((e) => eventRow(e, `
        <span class="pm-muted">approved ${escapeHtml((e.decided_at || "").slice(0, 16))} via ${escapeHtml(e.decided_via || "?")}</span>
        <button class="pm-btn pm-btn-danger" onclick="pmPlanDecide('${escapeHtml(e.uid)}','cancelled')">Cancel</button>`)).join("");

      const exportedHtml = exported.map((e) => eventRow(e, `
        <span class="pm-muted">exported ${escapeHtml((e.exported_at || "").slice(0, 16))} — awaiting confirmation</span>`)).join("");

      const historyHtml = history.map((e) => eventRow(e, `
        <span class="pm-muted">${escapeHtml(e.status)}${e.decided_via ? ` via ${escapeHtml(e.decided_via)}` : ""}</span>`)).join("");

      const table = (rows, empty) => `
        <table class="pm-table">
          <thead><tr><th>Block</th><th>When (${escapeHtml(tz)})</th><th>Source</th><th></th></tr></thead>
          <tbody>${rows || `<tr><td colspan="4" class="pm-muted" style="text-align:center;padding:1.5rem">${empty}</td></tr>`}</tbody>
        </table>`;

      body = plannerErr
        ? `<p class="pm-muted">planner unavailable: ${escapeHtml(plannerErr)}</p>`
        : `
        <div style="margin-bottom:1rem">
          <button class="pm-btn" onclick="pmPlanExport()">Export approved to feed now</button>
          <button class="pm-btn" onclick="pmPlanReconcile()">Reconcile confirmations</button>
          <span id="pm-plan-status" class="pm-muted"></span>
        </div>
        <h3>Awaiting your decision (${queue.length})</h3>
        ${table(queueHtml, "Nothing waiting — proposals land here.")}
        <h3>Approved, next export (${approved.length})</h3>
        ${table(approvedHtml, "Nothing approved and unexported.")}
        <h3>Exported, awaiting calendar confirmation (${exported.length})</h3>
        ${table(exportedHtml, "Nothing in flight.")}
        <h3>Recent history</h3>
        ${table(historyHtml, "No decided events yet.")}`;
    }

    // ── Nav + shell ──
    const views = [
      { id: "overview", label: "Overview" },
      { id: "notes", label: "Notes" },
      { id: "digests", label: "Digests" },
      { id: "sync", label: "Sync" },
      { id: "planner", label: "Planner" },
    ];
    const nav = views.map((v) => {
      const active = v.id === view;
      const style = active
        ? "background:var(--crow-accent);color:#fff"
        : "background:var(--crow-bg-surface);color:var(--crow-text-secondary);border:1px solid var(--crow-border)";
      return `<a href="/dashboard/pm-workspace?view=${v.id}"
        style="padding:0.4rem 0.9rem;border-radius:6px;text-decoration:none;font-size:0.85rem;${style}"
        ${active ? 'aria-current="true"' : ""}>${v.label}</a>`;
    }).join("\n");

    const content = `
      <style>
        .pm-tabs { display:flex; flex-wrap:wrap; gap:0.5rem; margin-bottom:1.5rem; }
        .pm-table { width:100%; border-collapse:collapse; margin-bottom:1.5rem; }
        .pm-table th { text-align:left; padding:0.5rem 0.75rem; border-bottom:1px solid var(--crow-border); }
        .pm-table td { padding:0.5rem 0.75rem; border-bottom:1px solid var(--crow-border); }
        .pm-muted { color:var(--crow-text-muted); font-size:0.85rem; }
        .pm-card { background:var(--crow-bg-surface); border:1px solid var(--crow-border); border-radius:8px; padding:0.75rem 1rem; margin-bottom:0.5rem; }
        .pm-card.pm-urgent, tr.pm-urgent td { border-left:3px solid var(--crow-error, #e74c3c); }
        .pm-log-row { padding:0.3rem 0; border-bottom:1px solid var(--crow-border); font-size:0.9rem; }
        .pm-btn { display:inline-block; padding:0.4rem 0.9rem; background:var(--crow-accent); color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:0.85rem; text-decoration:none; }
        .pm-btn-danger { background:var(--crow-error, #e74c3c); }
        h3 { margin:1.25rem 0 0.5rem; }
      </style>
      <nav class="pm-tabs" aria-label="PM Workspace sections">${nav}</nav>
      ${body}
      <script>
        async function pmSyncRun() {
          const el = document.getElementById('pm-sync-status');
          el.textContent = 'Running…';
          try {
            const res = await fetch('/api/pm/sync/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            const data = await res.json();
            el.textContent = res.ok ? JSON.stringify(data.totals || data) : ('Failed: ' + (data.error || res.status));
            if (res.ok) setTimeout(() => location.reload(), 1200);
          } catch (e) { el.textContent = 'Error: ' + e.message; }
        }
        async function pmDigestRun(previewOnly) {
          const el = document.getElementById('pm-digest-status');
          el.textContent = previewOnly ? 'Previewing…' : 'Running…';
          try {
            const res = await fetch('/api/pm/digest/run', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ preview: !!previewOnly, force: !previewOnly }),
            });
            const data = await res.json();
            if (!res.ok) { el.textContent = 'Failed: ' + (data.error || res.status); return; }
            if (previewOnly) {
              el.textContent = data.result.summary || 'preview ready';
              const pre = document.getElementById('pm-digest-preview');
              pre.textContent = data.result.text || '';
              pre.style.display = 'block';
            } else {
              el.textContent = 'Done: ' + (data.result.summary || '');
              setTimeout(() => location.reload(), 1200);
            }
          } catch (e) { el.textContent = 'Error: ' + e.message; }
        }
        async function pmPlanApi(path, payload, label) {
          const el = document.getElementById('pm-plan-status');
          if (el) el.textContent = label + '…';
          try {
            const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}) });
            const data = await res.json();
            if (!res.ok) { if (el) el.textContent = 'Failed: ' + (data.error || res.status); return; }
            if (el) el.textContent = 'Done';
            setTimeout(() => location.reload(), 600);
          } catch (e) { if (el) el.textContent = 'Error: ' + e.message; }
        }
        function pmPlanDecide(uid, decision) {
          if (decision !== 'approved' && !confirm('Mark this block ' + decision + '?')) return;
          pmPlanApi('/api/pm/plan/decide', { uid, decision }, decision);
        }
        function pmPlanExport() { pmPlanApi('/api/pm/plan/export', {}, 'Exporting'); }
        function pmPlanReconcile() { pmPlanApi('/api/pm/plan/reconcile', {}, 'Reconciling'); }
      </script>`;

    res.send(layout({ title: "PM Workspace", content }));
  },
};

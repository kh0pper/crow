/**
 * Crow's Nest — Orchestrator Timeline Panel
 *
 * Live view over orchestrator_events + current lifecycle snapshot.
 * Phase 5-polish: graduates the CLI tail (scripts/orchestrator-events-tail.js)
 * into an operator-facing UI with filtering and refcount state.
 */

import { escapeHtml } from "../shared/components.js";

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso.replace(" ", "T") + "Z");
  if (isNaN(d)) return iso;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtEventType(t) {
  if (!t) return "";
  if (t.startsWith("lifecycle.")) return t.slice("lifecycle.".length);
  if (t.startsWith("dispatch.")) return t.slice("dispatch.".length);
  return t;
}

function colorFor(t) {
  if (!t) return "var(--crow-text-muted)";
  if (t.includes("error") || t.includes("failed") || t.includes("aborted")) return "#e53935";
  if (t.includes("complete") || t.includes("warmed") || t.includes("ready")) return "#4caf50";
  if (t.includes("start") || t.includes("warm")) return "var(--crow-accent)";
  if (t.includes("release") || t.includes("stop")) return "#ff9800";
  return "var(--crow-text)";
}

export default {
  id: "orchestrator",
  name: "Orchestrator",
  icon: "cpu",
  route: "/dashboard/orchestrator",
  navOrder: 7,
  hidden: false,
  category: "system",

  async handler(req, res, { db, layout }) {
    if (req.method === "POST") {
      const { action } = req.body || {};
      if (action === "reset_refcounts") {
        try {
          const { resetAllRefcounts } = await import("../../../orchestrator/lifecycle.js");
          await resetAllRefcounts();
        } catch {}
        res.redirectAfterPost("/dashboard/orchestrator");
        return;
      }
    }

    // Fetch recent events (last ~200)
    let events = [];
    try {
      const { rows } = await db.execute({
        sql: "SELECT * FROM orchestrator_events ORDER BY id DESC LIMIT 200",
        args: [],
      });
      events = rows;
    } catch {}

    // Lifecycle snapshot (always fresh from memory)
    let snapshot = {};
    try {
      const { getLifecycleSnapshot } = await import("../../../orchestrator/lifecycle.js");
      snapshot = getLifecycleSnapshot();
    } catch {}

    // Group events by run_id for the "Active runs" panel
    const byRun = new Map();
    for (const e of events) {
      const k = e.run_id || "(lifecycle)";
      if (!byRun.has(k)) byRun.set(k, []);
      byRun.get(k).push(e);
    }

    const snapshotRows = Object.entries(snapshot).map(([k, v]) => {
      const age = v.lastReleasedAt
        ? `released ${Math.round((Date.now() - v.lastReleasedAt) / 1000)}s ago`
        : "";
      const refsClass = v.refs > 0 ? "active" : "idle";
      return `
        <tr>
          <td style="padding:6px 8px;font-family:'JetBrains Mono',monospace">${escapeHtml(k)}</td>
          <td style="padding:6px 8px;text-align:center"><span class="refs-badge ${refsClass}">${v.refs}</span></td>
          <td style="padding:6px 8px;color:var(--crow-text-muted);font-size:0.8rem">${escapeHtml(age)}</td>
        </tr>
      `;
    }).join("") || '<tr><td colspan="3" style="padding:12px;text-align:center;color:var(--crow-text-muted)">No providers tracked yet.</td></tr>';

    const eventRows = events.map((e) => {
      const color = colorFor(e.event_type);
      const metaBits = [];
      if (e.preset) metaBits.push(`preset=${e.preset}`);
      if (e.bundle_id) metaBits.push(`bundle=${e.bundle_id}`);
      if (typeof e.refs === "number") metaBits.push(`refs=${e.refs}`);
      const meta = metaBits.join(" · ");
      let dataStr = "";
      if (e.data) {
        try {
          const parsed = JSON.parse(e.data);
          if (typeof parsed === "object" && parsed) dataStr = Object.entries(parsed).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
          else dataStr = String(parsed);
        } catch { dataStr = e.data; }
      }
      const runId = e.run_id ? `<a href="?run=${encodeURIComponent(e.run_id)}" style="color:var(--crow-accent);text-decoration:none">${escapeHtml(e.run_id.slice(0, 14))}</a>` : "-";
      return `
        <tr>
          <td style="padding:4px 8px;color:var(--crow-text-muted);font-family:'JetBrains Mono',monospace;font-size:0.78rem;white-space:nowrap">${fmtTime(e.at)}</td>
          <td style="padding:4px 8px;font-family:'JetBrains Mono',monospace;font-size:0.8rem"><span style="color:${color}">${escapeHtml(fmtEventType(e.event_type))}</span></td>
          <td style="padding:4px 8px;font-family:'JetBrains Mono',monospace;font-size:0.8rem">${escapeHtml(e.provider_id || "-")}</td>
          <td style="padding:4px 8px;font-family:'JetBrains Mono',monospace;font-size:0.78rem;color:var(--crow-text-muted)">${runId}</td>
          <td style="padding:4px 8px;font-size:0.78rem;color:var(--crow-text-muted)">${escapeHtml(meta)}${dataStr ? '<br><span style="font-size:0.72rem">' + escapeHtml(dataStr) + '</span>' : ''}</td>
        </tr>
      `;
    }).join("") || '<tr><td colspan="5" style="padding:16px;text-align:center;color:var(--crow-text-muted)">No events yet. Run an orchestration via <code>crow_orchestrate</code> to see activity.</td></tr>';

    const activeRuns = [...byRun.entries()]
      .filter(([k]) => k !== "(lifecycle)")
      .map(([runId, evts]) => {
        const latest = evts[0];
        const tokens = evts.find((e) => e.event_type === "dispatch.run_complete");
        let tokenInfo = "";
        if (tokens?.data) {
          try { const d = JSON.parse(tokens.data); if (d.tokens_in) tokenInfo = `${d.tokens_in} in / ${d.tokens_out} out tokens`; } catch {}
        }
        const status = latest.event_type.includes("error") || latest.event_type.includes("aborted") ? "error" :
                       latest.event_type.includes("complete") ? "complete" :
                       "running";
        return `
          <div class="run-card run-${status}">
            <div style="display:flex;justify-content:space-between;font-family:'JetBrains Mono',monospace;font-size:0.82rem">
              <a href="?run=${encodeURIComponent(runId)}" style="color:var(--crow-accent);text-decoration:none">${escapeHtml(runId)}</a>
              <span style="color:var(--crow-text-muted);font-size:0.75rem">${fmtTime(latest.at)}</span>
            </div>
            <div style="color:var(--crow-text-muted);font-size:0.78rem;margin-top:2px">
              ${escapeHtml(latest.preset || "?")} · ${evts.length} events${tokenInfo ? " · " + tokenInfo : ""}
            </div>
          </div>
        `;
      }).slice(0, 6).join("") || '<div style="padding:12px;color:var(--crow-text-muted);font-size:0.85rem">No orchestration runs recorded.</div>';

    const filterNote = req.query.run
      ? `<div style="padding:8px;background:var(--crow-bg-deep);border-radius:4px;margin-bottom:1rem;font-size:0.85rem">
          Filtering by run: <code>${escapeHtml(req.query.run)}</code>
          · <a href="/dashboard/orchestrator" style="color:var(--crow-accent)">clear</a>
        </div>`
      : "";

    const filteredEvents = req.query.run
      ? events.filter((e) => e.run_id === req.query.run)
      : events;
    const finalEventRows = req.query.run
      ? filteredEvents.map((e) => {
          const color = colorFor(e.event_type);
          let dataStr = "";
          if (e.data) {
            try {
              const parsed = JSON.parse(e.data);
              if (typeof parsed === "object" && parsed) dataStr = Object.entries(parsed).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
              else dataStr = String(parsed);
            } catch { dataStr = e.data; }
          }
          return `
            <tr>
              <td style="padding:4px 8px;color:var(--crow-text-muted);font-family:'JetBrains Mono',monospace;font-size:0.78rem">${fmtTime(e.at)}</td>
              <td style="padding:4px 8px;font-family:'JetBrains Mono',monospace;font-size:0.8rem"><span style="color:${color}">${escapeHtml(fmtEventType(e.event_type))}</span></td>
              <td style="padding:4px 8px;font-family:'JetBrains Mono',monospace;font-size:0.8rem">${escapeHtml(e.provider_id || "-")}</td>
              <td style="padding:4px 8px;font-size:0.78rem;color:var(--crow-text-muted)">${escapeHtml(dataStr)}</td>
            </tr>
          `;
        }).join("")
      : eventRows;

    const content = `
      <style>
        .orch-grid { display:grid; grid-template-columns: 1fr 320px; gap:1rem; margin-bottom:1rem; }
        @media (max-width: 900px) { .orch-grid { grid-template-columns: 1fr; } }
        .orch-card { background:var(--crow-bg); border:1px solid var(--crow-border); border-radius:6px; padding:1rem; }
        .orch-card h3 { margin:0 0 0.75rem 0; font-size:0.95rem; font-weight:500; color:var(--crow-text-muted); text-transform:uppercase; letter-spacing:0.05em; }
        .orch-table { width:100%; border-collapse:collapse; }
        .orch-table th { text-align:left; padding:6px 8px; background:var(--crow-bg-deep); color:var(--crow-text-muted); font-weight:500; font-size:0.75rem; text-transform:uppercase; letter-spacing:0.03em; }
        .orch-table tr { border-bottom:1px solid var(--crow-border); }
        .refs-badge { display:inline-block; min-width:24px; padding:2px 6px; border-radius:10px; text-align:center; font-family:'JetBrains Mono',monospace; font-size:0.8rem; }
        .refs-badge.active { background:#4caf5033; color:#4caf50; }
        .refs-badge.idle { background:var(--crow-bg-deep); color:var(--crow-text-muted); }
        .run-card { padding:10px 12px; border-radius:4px; background:var(--crow-bg-deep); margin-bottom:6px; border-left:3px solid var(--crow-text-muted); }
        .run-card.run-running { border-left-color:var(--crow-accent); }
        .run-card.run-complete { border-left-color:#4caf50; }
        .run-card.run-error { border-left-color:#e53935; }
      </style>

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
        <div>
          <h1 style="margin:0;font-size:1.3rem">Orchestrator</h1>
          <p style="color:var(--crow-text-muted);font-size:0.85rem;margin:4px 0 0">
            Lifecycle refcounts + dispatch event timeline. Auto-refreshes every 5s.
          </p>
        </div>
        <form method="POST" onsubmit="return confirm('Reset all lifecycle refcounts? This reconciles against live provider health.');" style="margin:0">
          <input type="hidden" name="action" value="reset_refcounts">
          <button type="submit" class="btn btn-secondary btn-sm">Reset Refcounts</button>
        </form>
      </div>

      ${filterNote}

      <div class="orch-grid">
        <div class="orch-card">
          <h3>Active &amp; Recent Runs</h3>
          ${activeRuns}
        </div>
        <div class="orch-card">
          <h3>Lifecycle Snapshot</h3>
          <table class="orch-table" style="font-size:0.85rem">
            <thead><tr><th>Provider</th><th style="text-align:center">Refs</th><th>Status</th></tr></thead>
            <tbody>${snapshotRows}</tbody>
          </table>
        </div>
      </div>

      <div class="orch-card">
        <h3>Event Timeline ${req.query.run ? "(filtered)" : `(last ${filteredEvents.length})`}</h3>
        <div style="overflow-x:auto">
          <table class="orch-table">
            <thead><tr>
              <th>Time</th><th>Event</th><th>Provider</th>${req.query.run ? "" : "<th>Run</th>"}<th>Detail</th>
            </tr></thead>
            <tbody>${finalEventRows}</tbody>
          </table>
        </div>
      </div>

      <script>
        // Auto-refresh every 5s unless user is actively reading (cursor near top)
        let lastScroll = window.scrollY;
        setInterval(() => {
          if (document.visibilityState !== "visible") return;
          if (window.scrollY > 200) return; // user scrolled down, don't yank them
          window.location.reload();
        }, 5000);
      </script>
    `;

    return layout({ title: "Orchestrator", content });
  },
};

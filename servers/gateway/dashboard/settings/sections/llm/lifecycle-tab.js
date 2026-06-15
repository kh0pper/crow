/**
 * Lifecycle tab — GPU model lifecycle refcounts.
 *
 * Folds the keeper half of the retired standalone "Orchestrator" panel
 * (servers/gateway/dashboard/panels/orchestrator.js) into LLM settings,
 * next to Providers/Profiles/Health where model/GPU infra belongs. The
 * deletable half (the multi-agent orchestrator_events timeline) went away
 * with the orchestrator teardown (Plan B Part 2).
 *
 * Reads live in-memory state from servers/shared/lifecycle.js — the same
 * module gpu-orchestrator.js uses to warm/swap/refcount/release bundled
 * vLLM models. A Reset Refcounts button reconciles the counters against
 * live provider health (e.g. after a crash leaves a stale ref pinned).
 */

import { escapeHtml } from "../../../shared/components.js";
import { tJs } from "../../../shared/i18n.js";
import { getLifecycleSnapshot, resetAllRefcounts } from "../../../../../shared/lifecycle.js";

export default {
  async render({ lang }) {
    let snapshot = {};
    try { snapshot = getLifecycleSnapshot(); } catch {}

    const entries = Object.entries(snapshot);
    const rows = entries.map(([id, v]) => {
      const age = v.lastReleasedAt
        ? `released ${Math.round((Date.now() - v.lastReleasedAt) / 1000)}s ago`
        : "";
      const refsClass = v.refs > 0 ? "active" : "idle";
      return `<tr>
        <td style="padding:6px 8px;font-family:'JetBrains Mono',monospace">${escapeHtml(id)}</td>
        <td style="padding:6px 8px;text-align:center"><span class="llm-refs-badge ${refsClass}">${Number(v.refs)}</span></td>
        <td style="padding:6px 8px;color:var(--crow-text-muted);font-size:0.8rem">${escapeHtml(age)}</td>
      </tr>`;
    }).join("") || '<tr><td colspan="3" style="padding:14px;text-align:center;color:var(--crow-text-muted)">No models tracked yet. Refcounts populate as models are warmed.</td></tr>';

    return `<style>
      .llm-lifecycle-head { display:flex; justify-content:space-between; align-items:center; gap:1rem; margin-bottom:0.85rem; }
      .llm-lifecycle-table { width:100%; border-collapse:collapse; font-size:0.88rem; }
      .llm-lifecycle-table th { text-align:left; padding:6px 8px; background:var(--crow-bg-deep); color:var(--crow-text-muted); font-weight:500; font-size:0.75rem; text-transform:uppercase; letter-spacing:0.03em; }
      .llm-lifecycle-table tr { border-bottom:1px solid var(--crow-border); }
      .llm-refs-badge { display:inline-block; min-width:24px; padding:2px 6px; border-radius:10px; text-align:center; font-family:'JetBrains Mono',monospace; font-size:0.8rem; }
      .llm-refs-badge.active { background:#4caf5033; color:#4caf50; }
      .llm-refs-badge.idle { background:var(--crow-bg-deep); color:var(--crow-text-muted); }
    </style>
    <p class="llm-section-hint">Reference counts for bundled vLLM models managed by the GPU orchestrator. A model warms on first use (ref &gt; 0) and is released back to the GPU once idle. Use <strong>Reset Refcounts</strong> to reconcile the counters against live provider health if a count looks stuck.</p>
    <div class="llm-lifecycle-head">
      <span style="color:var(--crow-text-muted);font-size:0.82rem">${entries.length} model${entries.length === 1 ? "" : "s"} tracked</span>
      <form method="POST" onsubmit="return confirm('${tJs("orchestrator.confirmResetRefcounts", lang)}');" style="margin:0">
        <input type="hidden" name="action" value="reset_refcounts">
        <button type="submit" class="btn btn-secondary btn-sm">Reset Refcounts</button>
      </form>
    </div>
    <table class="llm-lifecycle-table">
      <thead><tr><th>Model</th><th style="text-align:center">Refs</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  },

  async handleAction({ res, action }) {
    if (action === "reset_refcounts") {
      try { await resetAllRefcounts(); } catch {}
      res.redirectAfterPost("?section=llm&tab=lifecycle");
      return true;
    }
    return false;
  },
};

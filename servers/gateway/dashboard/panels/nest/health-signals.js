/**
 * Nest Panel — Health Signals
 *
 * collectHealthSignals(db, opts) → { ok, issues, details }
 *
 * Each signal is wrapped in try/catch — a failing signal becomes state 'off'
 * and never throws. Results are cached for 30 s (injectable clock for tests).
 *
 * Signals:
 *   disk      — df-based free % (<10% → warn)
 *   storage   — MinIO availability (MINIO_ENDPOINT unset → info/off; unreachable → warn)
 *   agents    — pi_bot_defs enabled count (always ok, count display)
 *   peers     — crow_instances unseen >24h (info)
 *   updates   — auto_update_* version comparison (info if update available)
 *   backup    — newest file mtime in CROW_BACKUP_DIR (none → info; >7d → warn)
 *
 * Pure export shouldNotify(lastMap, issueId, nowMs) — used by the health monitor
 * for 24-hour dedupe. No I/O.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Module-level 30s cache ───────────────────────────────────────────────────

let _cache = null;
let _cacheTs = 0;
const CACHE_TTL = 30_000;

// ─── Exported pure helper ─────────────────────────────────────────────────────

/**
 * Dedupe helper for the health monitor.
 *
 * @param {Record<string, number>} lastMap   — issueId → last-notified epoch ms
 * @param {string} issueId
 * @param {number} nowMs
 * @returns {boolean}  true = should notify (issue is new or 24h window expired)
 */
export function shouldNotify(lastMap, issueId, nowMs) {
  const last = lastMap[issueId];
  if (last == null) return true;
  return nowMs - last >= 24 * 60 * 60 * 1000;
}

// ─── Internal signal collectors ──────────────────────────────────────────────

function diskSignal() {
  let diskFreePct = null;
  try {
    // df -BM --output=avail,size / — two columns: available MB, total MB
    const out = execFileSync("df", ["-BM", "--output=avail,size", "/"], {
      encoding: "utf-8", timeout: 5000,
    });
    const lines = out.trim().split("\n");
    if (lines.length > 1) {
      const parts = lines[1].trim().split(/\s+/);
      const avail = parseInt(parts[0], 10) || 0;
      const total = parseInt(parts[1], 10) || 0;
      if (total > 0) diskFreePct = Math.round((avail / total) * 100);
    }
  } catch {}

  if (diskFreePct === null) {
    return {
      id: "disk",
      severity: null,
      state: "off",
      label: "Disk",
      value: "unavailable",
    };
  }

  const usedPct = 100 - diskFreePct;
  const state = diskFreePct < 10 ? "warn" : "ok";
  return {
    id: "disk",
    severity: state === "warn" ? "warn" : null,
    state,
    label: "Disk",
    value: `${usedPct}% used`,
    issueLabel: "Disk space is low",
    actionLabel: "Free up space",
    actionHref: "/dashboard/files",
  };
}

async function storageSignal() {
  const endpoint = process.env.MINIO_ENDPOINT;
  if (!endpoint) {
    return {
      id: "storage",
      severity: null,
      state: "off",
      label: "File storage",
      value: "not set up",
      issueLabel: "File storage isn't set up",
      actionLabel: "Set up storage",
      actionHref: "/dashboard/files",
    };
  }

  let available = false;
  try {
    const { isAvailable } = await import("../../../../storage/s3-client.js");
    available = await isAvailable();
  } catch {}

  if (!available) {
    return {
      id: "storage",
      severity: "warn",
      state: "warn",
      label: "File storage",
      value: "unreachable",
      issueLabel: "File storage isn't responding",
      actionLabel: "Check files",
      actionHref: "/dashboard/files",
    };
  }

  return {
    id: "storage",
    severity: null,
    state: "ok",
    label: "File storage",
    value: "online",
  };
}

async function agentsSignal(db) {
  let count = 0;
  try {
    const { rows } = await db.execute({
      sql: "SELECT COUNT(*) AS c FROM pi_bot_defs WHERE enabled=1",
      args: [],
    });
    count = rows[0]?.c ?? 0;
  } catch {}

  return {
    id: "agents",
    severity: null,
    state: "ok",
    label: "Active agents",
    value: String(count),
  };
}

async function peersSignal(db) {
  const issues = [];
  const LAG_MS = 24 * 60 * 60 * 1000;
  try {
    const { rows } = await db.execute({
      sql: "SELECT name, last_seen_at FROM crow_instances WHERE trusted=1 AND status='active'",
      args: [],
    });
    const now = Date.now();
    for (const r of rows) {
      if (!r.last_seen_at) continue;
      const seenAt = new Date(r.last_seen_at).getTime();
      if (now - seenAt > LAG_MS) {
        const when = new Date(r.last_seen_at).toLocaleDateString("en-US", {
          month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
        });
        issues.push({ name: r.name, when });
      }
    }
  } catch {}

  if (issues.length === 0) {
    return {
      id: "peers",
      severity: null,
      state: "ok",
      label: "Peers",
      value: "all online",
    };
  }

  return {
    id: "peers",
    severity: "info",
    state: "info",
    label: "Peers",
    value: `${issues.length} offline`,
    issueLabel: `Peer ${issues[0].name} hasn't been seen since ${issues[0].when}`,
    actionLabel: "View instances",
    actionHref: "/dashboard/settings?section=pairedInstances",
  };
}

async function updatesSignal(db) {
  let current = null, latest = null;
  try {
    const { rows: curr } = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key='auto_update_current_version'",
      args: [],
    });
    const { rows: lat } = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key='auto_update_latest_version'",
      args: [],
    });
    current = curr[0]?.value ?? null;
    latest = lat[0]?.value ?? null;
  } catch {}

  if (!current || !latest || current === latest) {
    return {
      id: "updates",
      severity: null,
      state: "ok",
      label: "Updates",
      value: current ? `v${current}` : "up to date",
    };
  }

  return {
    id: "updates",
    severity: "info",
    state: "info",
    label: "Updates",
    value: `v${latest} available`,
    issueLabel: "An update is available",
    actionLabel: "Check updates",
    actionHref: "/dashboard/settings?section=updates",
  };
}

function backupSignal(nowFn) {
  const nowMs = nowFn();
  const dir = process.env.CROW_BACKUP_DIR || join(homedir(), ".crow", "backups");
  let newestMtimeMs = null;

  try {
    const files = readdirSync(dir).filter(f => f.endsWith(".db"));
    for (const f of files) {
      try {
        const m = statSync(join(dir, f)).mtimeMs;
        if (newestMtimeMs === null || m > newestMtimeMs) newestMtimeMs = m;
      } catch {}
    }
  } catch {}

  if (newestMtimeMs === null) {
    return {
      id: "backup",
      severity: "info",
      state: "info",
      label: "Backup",
      value: "never",
      issueLabel: "Backups aren't set up yet",
      actionLabel: "Run a backup",
      actionHref: "/dashboard/nest?action=backup",
    };
  }

  const ageDays = (nowMs - newestMtimeMs) / (24 * 60 * 60 * 1000);
  if (ageDays > 7) {
    const daysRounded = Math.floor(ageDays);
    return {
      id: "backup",
      severity: "warn",
      state: "warn",
      label: "Backup",
      value: `${daysRounded}d ago`,
      issueLabel: `Last backup was ${daysRounded} days ago`,
      actionLabel: "Run a backup",
      actionHref: "/dashboard/nest?action=backup",
    };
  }

  const daysAgo = ageDays < 1 ? "today" : `${Math.floor(ageDays)}d ago`;
  return {
    id: "backup",
    severity: null,
    state: "ok",
    label: "Backup",
    value: daysAgo,
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Collect all health signals.
 *
 * @param {object} db      libsql client
 * @param {object} [opts]
 * @param {function} [opts.now]  Injectable clock: () => number (ms since epoch)
 * @returns {Promise<{ok: boolean, issues: Array, details: Array}>}
 */
export async function collectHealthSignals(db, opts = {}) {
  const nowFn = opts.now ?? (() => Date.now());

  const ts = nowFn();
  if (_cache && ts - _cacheTs < CACHE_TTL) return _cache;

  const rawSignals = await Promise.all([
    diskSignal(),
    storageSignal(),
    agentsSignal(db),
    peersSignal(db),
    updatesSignal(db),
    backupSignal(nowFn),
  ].map(p => Promise.resolve(p).catch(err => ({
    id: "unknown",
    severity: null,
    state: "off",
    label: "Unknown",
    value: "error",
    _err: err?.message,
  }))));

  const details = rawSignals.map(s => ({
    id: s.id,
    label: s.label,
    value: s.value,
    state: s.state ?? "off",
  }));

  const issues = rawSignals
    .filter(s => s.state === "warn" || s.state === "info")
    .map(s => ({
      id: s.id,
      severity: s.severity ?? s.state,
      label: s.issueLabel ?? s.label,
      actionLabel: s.actionLabel ?? null,
      actionHref: s.actionHref ?? null,
    }));

  const ok = issues.filter(i => i.severity === "warn").length === 0;

  const result = { ok, issues, details };
  _cache = result;
  _cacheTs = ts;
  return result;
}

/**
 * Invalidate the cache (for testing).
 */
export function invalidateHealthCache() {
  _cache = null;
  _cacheTs = 0;
}

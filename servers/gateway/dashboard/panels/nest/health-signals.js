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
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { t } from "../../shared/i18n.js";
import { PUBLIC_FUNNEL_PREFIXES } from "../../../funnel.js";
import { isAuditDegraded } from "../../../../shared/cross-host-auth.js";
import { getReceiveHealth } from "../../../../sharing/receive-health.js";

// ─── Module-level 30s cache ───────────────────────────────────────────────────

let _cache = null;
let _cacheTs = 0;
let _cacheLang = null;
const CACHE_TTL = 30_000;

// ─── Exported pure helpers ────────────────────────────────────────────────────

/**
 * Dedupe helper for the health monitor.
 *
 * @param {Record<string, number>} lastMap   — issueId → last-notified epoch ms
 * @param {string} issueId
 * @param {number} nowMs
 * @param {number} [windowMs]  re-notify window (default 24h)
 * @returns {boolean}  true = should notify (issue is new or window expired)
 */
export function shouldNotify(lastMap, issueId, nowMs, windowMs = 24 * 60 * 60 * 1000) {
  const last = lastMap[issueId];
  if (last == null) return true;
  return nowMs - last >= windowMs;
}

/**
 * Incident-scoped dedupe reset. Returns a copy of lastMap keeping only the
 * entries whose issue id is still active, so a resolved-then-recurring issue
 * notifies again instead of staying silent under the 24h window.
 *
 * @param {Record<string, number>} lastMap
 * @param {string[]} activeIssueIds  ids of issues currently present (warn OR info)
 * @returns {Record<string, number>}
 */
export function pruneResolved(lastMap, activeIssueIds) {
  const active = new Set(activeIssueIds);
  const out = {};
  for (const [id, ts] of Object.entries(lastMap)) {
    if (active.has(id)) out[id] = ts;
  }
  return out;
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
    // The minio SDK has no connect timeout — a dead endpoint would otherwise
    // hang the nest render for the kernel's TCP timeout. Cap it hard.
    available = await Promise.race([
      isAvailable(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("storage check timed out")), 2000).unref?.(),
      ),
    ]);
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
    actionHref: "/dashboard/settings?section=paired-instances",
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

async function syncConflictsSignal(db) {
  let count = 0;
  try {
    const { rows } = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM sync_conflicts WHERE resolved = 0",
      args: [],
    });
    count = Number(rows[0]?.n ?? 0);
  } catch {
    // sync_conflicts table may not exist yet on older installs; treat as 0.
    return {
      id: "syncConflicts",
      severity: null,
      state: "ok",
      label: "Sync conflicts",
      value: "none",
    };
  }

  if (count === 0) {
    return {
      id: "syncConflicts",
      severity: null,
      state: "ok",
      label: "Sync conflicts",
      value: "none",
    };
  }

  return {
    id: "syncConflicts",
    severity: "warn",
    state: "warn",
    label: "Sync conflicts",
    value: `${count} unresolved`,
    issueLabel: `${count} sync conflict${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} review`,
    actionLabel: "Review conflicts",
    actionHref: "/dashboard/settings?section=sync-conflicts",
  };
}

// The default MUST match admin-backup.js's DEFAULT_DIR (~/backups/crow) — the
// signal previously read ~/.crow/backups (stale pre-upgrade snapshots) while
// real daily backups land in ~/backups/crow, so it under-reported (W2-4 fix).
function backupDir() {
  return process.env.CROW_BACKUP_DIR || join(homedir(), "backups", "crow");
}

async function backupSignal(db, nowFn, lang) {
  const nowMs = nowFn();
  const dir = backupDir();
  let newestMtimeMs = null;
  let newestPath = null;

  try {
    const files = readdirSync(dir).filter(f => f.endsWith(".db"));
    for (const f of files) {
      try {
        const full = join(dir, f);
        const m = statSync(full).mtimeMs;
        if (newestMtimeMs === null || m > newestMtimeMs) { newestMtimeMs = m; newestPath = full; }
      } catch {}
    }
  } catch {}

  const runAction = { actionLabel: t("health.runBackupNow", lang), actionHref: "/dashboard/nest?action=backup" };

  if (newestMtimeMs === null) {
    return {
      id: "backup", severity: "info", state: "info", label: t("signals.backup.label", lang),
      value: "never", issueLabel: t("signals.backup.neverIssue", lang), ...runAction,
    };
  }

  const ageDays = (nowMs - newestMtimeMs) / (24 * 60 * 60 * 1000);
  if (ageDays > 7) {
    const daysRounded = Math.floor(ageDays);
    return {
      id: "backup", severity: "warn", state: "warn", label: t("signals.backup.label", lang),
      value: `${daysRounded}d ago`, issueLabel: t("signals.backup.staleIssue", lang).replace("{n}", String(daysRounded)), ...runAction,
    };
  }

  // Age is fine — layer integrity verification on top.
  let verified = null;
  try {
    const { rows } = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key='backup_last_verified'", args: [] });
    if (rows[0]?.value) verified = JSON.parse(rows[0].value);
  } catch {}

  // Cheap readability/size check on the newest file (no PRAGMA in the hot path).
  let readable = false, sizeOk = false;
  try { const st = statSync(newestPath); readable = true; sizeOk = st.size > 0; } catch {}

  const verifiedFailedForNewest = verified && verified.path === newestPath && verified.ok === false;
  if (!readable || !sizeOk || verifiedFailedForNewest) {
    return {
      id: "backup", severity: "warn", state: "warn", label: t("signals.backup.label", lang),
      value: t("signals.backup.damaged", lang), issueLabel: t("signals.backup.damagedIssue", lang), ...runAction,
    };
  }

  const daysAgo = ageDays < 1 ? "today" : `${Math.floor(ageDays)}d ago`;

  if (!verified || verified.path !== newestPath) {
    // Newest backup predates the verification feature, or is an external/manual
    // copy — gentle nudge, never a false "damaged" warn (S5).
    return {
      id: "backup", severity: "info", state: "info", label: t("signals.backup.label", lang),
      value: daysAgo, issueLabel: t("signals.backup.unverifiedIssue", lang), ...runAction,
    };
  }

  // Verified healthy.
  return {
    id: "backup", severity: null, state: "ok", label: t("signals.backup.label", lang),
    value: `${daysAgo} · ${t("signals.backup.verified", lang)}`,
  };
}

// ─── Security-maintenance signals (W2) ────────────────────────────────────────

async function loginsSignal(db, lang) {
  let failures = 0, distinctIps = 0, lockouts = 0;
  try {
    const { rows } = await db.execute({
      sql: `SELECT COUNT(*) AS n, COUNT(DISTINCT ip_address) AS ips FROM audit_log
            WHERE event_type='auth_login_failure' AND created_at >= datetime('now','-24 hours')`,
      args: [],
    });
    failures = Number(rows[0]?.n ?? 0);
    distinctIps = Number(rows[0]?.ips ?? 0);
    const { rows: lk } = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM audit_log
            WHERE event_type='security_lockout_report' AND created_at >= datetime('now','-24 hours')`,
      args: [],
    });
    lockouts = Number(lk[0]?.n ?? 0);
  } catch {}

  if (failures === 0) {
    return { id: "logins", severity: null, state: "ok", label: t("signals.logins.label", lang), value: t("signals.logins.none", lang) };
  }

  const storm = lockouts > 0 || failures >= 10;   // warn → notifies
  const minor = failures >= 5;                     // info → strip only
  if (!storm && !minor) {
    // 1-4 failures = owner typos; surface the count but stay ok.
    return { id: "logins", severity: null, state: "ok", label: t("signals.logins.label", lang),
      value: t("signals.logins.count", lang).replace("{n}", String(failures)) };
  }
  const state = storm ? "warn" : "info";
  return {
    id: "logins", severity: state, state, label: t("signals.logins.label", lang),
    value: t("signals.logins.count", lang).replace("{n}", String(failures)),
    issueLabel: (storm ? t("signals.logins.storm", lang) : t("signals.logins.some", lang))
      .replace("{n}", String(failures)).replace("{ips}", String(distinctIps)),
    actionLabel: t("signals.logins.action", lang),
    actionHref: "/dashboard/settings?section=two-factor",
  };
}

// 5-min cache for the (external) tailscale query + injectable reader for tests.
let _tsServeCache = { ts: 0, raw: null };
let _tailscaleReader = () => execFileSync("tailscale", ["serve", "status", "-json"], { encoding: "utf-8", timeout: 2000 });
export function _setTailscaleReader(fn) { _tailscaleReader = fn; _tsServeCache = { ts: 0, raw: null }; }

// Returns funnel-exposed paths (array), or null when we couldn't determine
// (CLI absent / erroring / unexpected shape) → caller skips silently.
// C1: serve ≠ funnel. A healthy PRIVATE box mounts "/" under Web.<host> with
// NO AllowFunnel key — that must NOT be read as exposure. Only paths under a
// hostport with AllowFunnel===true are actually public.
function funnelExposedPaths(nowMs) {
  if (nowMs - _tsServeCache.ts < 5 * 60 * 1000) return _tsServeCache.raw;
  let paths = null;
  try {
    const cfg = JSON.parse(_tailscaleReader());
    const allow = cfg.AllowFunnel || {};
    const enabledHostports = Object.keys(allow).filter((hp) => allow[hp] === true);
    // Absent/empty AllowFunnel → fully private → empty list (not null).
    paths = [];
    for (const hp of enabledHostports) {
      const handlers = (cfg.Web && cfg.Web[hp] && cfg.Web[hp].Handlers) || {};
      for (const p of Object.keys(handlers)) paths.push(p);
    }
  } catch {
    paths = null; // CLI missing / not running / unexpected shape → skip
  }
  _tsServeCache = { ts: nowMs, raw: paths };
  return paths;
}

// Reuse funnel.js's exact prefix semantics (trailing-slash = subtree, else exact).
function isPublicSafePath(p) {
  return PUBLIC_FUNNEL_PREFIXES.some((pre) => pre.endsWith("/") ? p.startsWith(pre) : p === pre);
}

function exposureSignal(lang, nowFn) {
  const problems = [];
  if (process.env.CROW_DASHBOARD_PUBLIC === "true") problems.push(t("signals.exposure.public", lang));
  if (process.argv.includes("--no-auth")) problems.push(t("signals.exposure.noauth", lang));
  if (process.env.CROW_CSRF_STRICT === "0") problems.push(t("signals.exposure.csrf", lang));

  const exposed = funnelExposedPaths(nowFn());
  if (Array.isArray(exposed)) {
    const unsafe = exposed.filter((p) => !isPublicSafePath(p));
    if (unsafe.length > 0) problems.push(t("signals.exposure.funnel", lang));
  }

  if (problems.length === 0) {
    return { id: "exposure", severity: null, state: "ok", label: t("signals.exposure.label", lang), value: t("signals.exposure.private", lang) };
  }
  return {
    id: "exposure", severity: "warn", state: "warn", label: t("signals.exposure.label", lang),
    value: t("signals.exposure.open", lang), issueLabel: problems[0],
    actionLabel: t("signals.exposure.action", lang), actionHref: "/dashboard/settings?section=connections",
  };
}

async function integrationsSignal(db, lang) {
  const warnNames = [];   // real failure tracking → warn
  const infoNames = [];   // soft heuristic (Google) → info

  // 1. Project data backends with a recent error (Q4: 30-day recency gate).
  try {
    const { rows } = await db.execute({
      sql: `SELECT name FROM data_backends WHERE status='error' AND updated_at >= datetime('now','-30 days') LIMIT 5`,
      args: [],
    });
    for (const r of rows) warnNames.push(r.name || "a data source");
  } catch {}

  // 2. Trusted+active peers whose latest outbound call returned 401/403 in 7d.
  try {
    const { rows } = await db.execute({
      sql: `SELECT ci.name FROM crow_instances ci
            JOIN cross_host_calls c ON c.id = (
              SELECT id FROM cross_host_calls
              WHERE target_instance_id = ci.id AND direction='outbound' AND http_status IS NOT NULL
              ORDER BY at DESC LIMIT 1)
            WHERE ci.trusted=1 AND ci.status='active'
              AND c.http_status IN (401,403) AND c.at >= datetime('now','-7 days')`,
      args: [],
    });
    for (const r of rows) warnNames.push(r.name || "a paired instance");
  } catch {}

  // 3. Google token files — INFO only, provably-dead case (S1): expired >7d AND
  //    no refresh_token. Never log file contents (S2).
  try {
    const candidates = [];
    if (process.env.GOOGLE_TOKEN_FILE) candidates.push(process.env.GOOGLE_TOKEN_FILE);
    try {
      const cfgRoot = join(homedir(), ".config");
      for (const d of readdirSync(cfgRoot)) {
        if (!d.startsWith("google-workspace-mcp")) continue;
        try {
          for (const f of readdirSync(join(cfgRoot, d))) {
            if (f.endsWith(".json")) candidates.push(join(cfgRoot, d, f));
          }
        } catch {}
      }
    } catch {}
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    for (const file of candidates.slice(0, 10)) {
      try {
        const tok = JSON.parse(readFileSync(file, "utf-8"));
        const exp = tok.expiry ? new Date(tok.expiry).getTime() : NaN;
        if (tok.token && !tok.refresh_token && Number.isFinite(exp) && exp < Date.now() - SEVEN_DAYS) {
          infoNames.push("Google");
        }
      } catch {}
    }
  } catch {}

  if (warnNames.length === 0 && infoNames.length === 0) {
    return { id: "integrations", severity: null, state: "ok", label: t("signals.integrations.label", lang), value: t("signals.integrations.ok", lang) };
  }
  if (warnNames.length > 0) {
    return {
      id: "integrations", severity: "warn", state: "warn", label: t("signals.integrations.label", lang),
      value: t("signals.integrations.broken", lang).replace("{n}", String(warnNames.length + infoNames.length)),
      issueLabel: t("signals.integrations.issue", lang).replace("{name}", warnNames[0]),
      actionLabel: t("signals.integrations.action", lang), actionHref: "/dashboard/settings?section=integrations",
    };
  }
  // Only soft Google info.
  return {
    id: "integrations", severity: "info", state: "info", label: t("signals.integrations.label", lang),
    value: t("signals.integrations.broken", lang).replace("{n}", String(infoNames.length)),
    issueLabel: t("signals.integrations.maybe", lang).replace("{name}", infoNames[0]),
    actionLabel: t("signals.integrations.action", lang), actionHref: "/dashboard/settings?section=integrations",
  };
}

// Federation audit DB corruption — the in-process circuit-breaker in
// cross-host-auth.js trips when the cross_host_calls audit table goes
// structurally corrupt. Surface it in the nest so a malformed-audit-DB
// condition is LOUD (not the silent multi-day degradation that happened
// twice). No DB read — reads the per-process breaker flag.
function federationAuditSignal(lang) {
  if (!isAuditDegraded()) {
    return {
      id: "federationAudit", severity: null, state: "ok",
      label: t("signals.federationAudit.label", lang),
      value: t("signals.federationAudit.ok", lang),
    };
  }
  return {
    id: "federationAudit", severity: "warn", state: "warn",
    label: t("signals.federationAudit.label", lang),
    value: t("signals.federationAudit.degraded", lang),
    issueLabel: t("signals.federationAudit.issue", lang),
    actionLabel: t("signals.federationAudit.action", lang),
    actionHref: "/dashboard/nest",
  };
}

// Messages receive-path health (R8+R7). Reads the pure receive-health module —
// NEVER the sharing client (importing the live client opens relay sockets).
// Warn ONLY on a dead receive path or zero relays; a quiet mailbox, queued
// outbound retries, and decrypt failures are display-only, never issues.
function formatAge(ms) {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

async function messagesSignal(db, lang, nowFn) {
  const h = getReceiveHealth();
  const label = t("signals.messages.label", lang);
  const action = { actionLabel: t("signals.messages.action", lang), actionHref: "/dashboard/messages" };

  if (h.receiveWired === null) {
    return { id: "messages", severity: null, state: "off", label, value: t("signals.messages.off", lang) };
  }
  if (h.receiveWired === false) {
    return {
      id: "messages", severity: "warn", state: "warn", label,
      value: t("signals.messages.down", lang),
      issueLabel: t("signals.messages.downIssue", lang), ...action,
    };
  }
  if (h.relaysConnected === 0) {
    return {
      id: "messages", severity: "warn", state: "warn", label,
      value: t("signals.messages.noRelays", lang),
      issueLabel: t("signals.messages.noRelaysIssue", lang), ...action,
    };
  }

  // Healthy — everything below is display-only.
  let pendingOut = 0;
  try {
    const { rows } = await db.execute({ sql: "SELECT COUNT(*) AS n FROM message_retry_queue", args: [] });
    pendingOut = Number(rows[0]?.n ?? 0);
  } catch {} // table missing / DB hiccup → just omit the count

  const parts = [t("signals.messages.relays", lang).replace("{n}", String(h.relaysConnected))];
  if (h.lastInboundAt) {
    parts.push(t("signals.messages.lastIn", lang).replace("{age}", formatAge(nowFn() - h.lastInboundAt)));
  }
  if (pendingOut > 0) {
    parts.push(t("signals.messages.pending", lang).replace("{n}", String(pendingOut)));
  }
  if (h.decryptFailures > 0) {
    parts.push(t("signals.messages.undecryptable", lang).replace("{n}", String(h.decryptFailures)));
  }
  return { id: "messages", severity: null, state: "ok", label, value: parts.join(" · ") };
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
  const lang = opts.lang ?? "en";

  const ts = nowFn();
  if (_cache && ts - _cacheTs < CACHE_TTL && _cacheLang === lang) return _cache;

  const rawSignals = await Promise.all([
    diskSignal(),
    storageSignal(),
    agentsSignal(db),
    peersSignal(db),
    updatesSignal(db),
    backupSignal(db, nowFn, lang),
    syncConflictsSignal(db),
    loginsSignal(db, lang),
    exposureSignal(lang, nowFn),
    integrationsSignal(db, lang),
    federationAuditSignal(lang),
    messagesSignal(db, lang, nowFn),
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
  _cacheLang = lang;
  return result;
}

/**
 * Invalidate the cache (for testing).
 */
export function invalidateHealthCache() {
  _cache = null;
  _cacheTs = 0;
  _cacheLang = null;
}

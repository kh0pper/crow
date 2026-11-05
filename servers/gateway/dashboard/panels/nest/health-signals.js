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
 *   storage   — file storage availability (not configured → info/off; unreachable → warn)
 *   agents    — pi_bot_defs enabled count (always ok, count display)
 *   peerTrust — PT-1: a trust lookup that failed closed (warn), a paired but
 *               untrusted row holding a bearer/key, an orphan credential (info)
 *   peers     — paired peer's gateway URL failing /health >=2h (warn, pushed);
 *               else trusted peers unseen >24h (info)
 *   updates   — auto_update_* state: the last result auto-update wrote,
 *               classified by auto-update.js (failure → warn, a still-running CI
 *               only after 2x the interval of the result itself), a last check
 *               older than 2x the interval (never before the gateway has been
 *               up that long), else the version comparison (info if update
 *               available); disabled in settings OR by the env/--no-auth gate →
 *               neutral "off", never an ok "current"
 *   exposure  — Privacy: the gateway's actual bind (listen-host.js), the host
 *               firewall from ufw.conf (never root) and Funnel; bound beyond
 *               loopback + firewall off or unreadable → warn, any check that
 *               could not run → at most info naming it, never ok. INSIDE A
 *               CONTAINER the bind and firewall describe the container, not the
 *               host, so they are info that points at the container's published
 *               ports on the host; only the Funnel checks can still warn there.
 *   backup    — newest of THIS instance's files in CROW_BACKUP_DIR (none → info;
 *               >7d → warn; owned by another instance → warn)
 *   keychainExport — extension passwords that are in no keychain Export yet (info; no
 *               card when there are none)
 *   providers — alwaysResident provider residency (unreachable ≥threshold → warn)
 *   externalEngines — engines another machine runs (spec 2026-09-23): own id,
 *               info at most — never warn, never a push; no card when none
 *   syncOutbox — stdio→gateway outbox depth + oldest-row age (stuck >15min → warn)
 *   reservation — box reservation held (info; no card when the box is free).
 *               Box-reservation scope §3.5: "Box reserved by <owner> until
 *               <time>" for as long as the file exists.
 *   artifact-node — the Crow Artifacts sidecar Tailscale node (only when
 *               CROW_ARTIFACT_SIDECAR_SOCKET is set): logged out, key expiring
 *               within 14 days, Funnel on, or an unexpected Serve mapping →
 *               one warn issue per problem ("artifact-node:<code>"), so each
 *               distinct problem is pushed by the health monitor. An origin
 *               URL configured WITHOUT the socket warns "unmonitored".
 *   publishedPorts — the audit behind the engine fence (plan PR S5a), read from
 *               the fence's snapshot file (CROW_PUBLISH_SNAPSHOT): a publish on
 *               the wildcard/LAN/bridge/an empty host, a tailnet-address publish
 *               without the interface-pinned raw rule, a rule pinned to a
 *               different address, a Docker below the floor or a fence facts
 *               hash mismatch → warn; a fenced or allowlisted publish → info;
 *               loopback → silent. With NO snapshot (the default install) it
 *               asks Docker directly (`docker ps`, no root): a port published
 *               beyond loopback → warn + the engine-fence guide; none → info;
 *               Docker unreadable → info "unknown". A snapshot that exists but
 *               cannot be read stays "unknown" (info), never ok-looking.
 *               Lists the shapes it could not inspect (M4).
 *   bundleImages — how old the images the INSTALLED bundles run are (audit
 *               N1c-7). A bounded `docker ps` maps containers to
 *               <CROW_HOME>/bundles/<id> (the compose working-dir label), one
 *               `docker image inspect` reads their created times, and an image
 *               older than BUNDLE_IMAGE_STALE_DAYS gets ONE info line per bundle
 *               ("<bundle>: image is N days old") linking to that bundle's page.
 *               Never a warn — an aged image is information, not a failure.
 *               Docker unavailable, a timed-out exec or a ragged inspect answer →
 *               "unknown" (info), never ok. No card when nothing is installed.
 *   systemUpdates — OS security updates (audit K6): the installer turns on
 *               unattended-upgrades for the system plus the NodeSource, Docker
 *               and Caddy origins. A reboot still owed → warn (with up to 10
 *               package names from reboot-required.pkgs); the daily run switched
 *               off or missing → info linking to the guide; a last run (stamp or
 *               log mtime) older than 3 days while the timer is on → warn; no
 *               record of a run yet → info (a fresh box is not a failed check).
 *               The switch is read the way apt reads it: every file in
 *               apt.conf.d in name order, comments stripped, the LAST
 *               APT::Periodic::Unattended-Upgrade assignment winning. Node and
 *               Docker versions are information only (never a "latest" lookup);
 *               a Docker that is not installed is stated, not counted as a
 *               failed check. Any check that could not run → at most info,
 *               naming it, never ok. No apt (non-Debian, or a container) → no card.
 *
 * Pure export shouldNotify(lastMap, issueId, nowMs) — used by the health monitor
 * for 24-hour dedupe. No I/O.
 *
 * Also exports async runHealthNotifyCycle({ issues, lastMap, nowMs, notify }) —
 * the extracted notify loop (post-listen.js's health monitor and
 * tests/health-notify-cycle.test.js both drive it): applies shouldNotify's
 * dedupe per issue, calls `notify(issue)` for each one it allows, stamps its
 * marker only on a successful notify, and prunes resolved issue ids from
 * `lastMap`.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname, networkInterfaces } from "node:os";
import { t, fill } from "../../shared/i18n.js";
import { docsUrl } from "../../shared/components.js";
import { readSetting } from "../../settings/registry.js";
import { isFunnelPublicPath, effectiveFunnelPrefixes } from "../../../funnel.js";
import { gatewayListenPort } from "../../../listen-port.js";
import { gatewayListenHost } from "../../../listen-host.js";
import { DEFAULT_INTERVAL_HOURS, MIN_INTERVAL_HOURS, classifyUpdateResult, shouldStartAutoUpdate } from "../../../auto-update.js";
import { isAuditDegraded } from "../../../../shared/cross-host-auth.js";
import { getReceiveHealth } from "../../../../sharing/receive-health.js";
import { getProviderHealth } from "../../../provider-health.js";
import { getPeerProbeHealth } from "../../../peer-probe-health.js";
import { getPeerTrustHealth } from "../../../../shared/peer-trust-health.js";
import { getPeerDialHealth } from "../../../../shared/peer-dial-health.js";
import { readReservation } from "../../../box-reservation.js";
import { localBackupContext, newestBackupOwnership } from "../../../../shared/backup-naming.js";
import { getStats as getOutboxStats } from "../../../../sharing/sync-outbox-drain.js";
import { createSidecarHealthReader } from "../../../artifact-origin/sidecar-health.js";
import {
  inspectPublishedPorts,
  parseAllowlistSetting,
  parseDockerPsPorts,
  classifyHostIp,
  PUBLISHED_PORTS_ALLOWLIST_KEY,
  DOCKER_FLOOR,
} from "./published-ports.js";
import {
  BUNDLE_PS_FORMAT,
  bundleImageAges,
  parseImageCreated,
  parseRunningBundleImages,
  readInstalledBundleIds,
} from "./bundle-images.js";
import { unexportedCount } from "../../../keychain/reminder.js";
import { loadKeychainKey } from "../../../keychain/key.js";
import {
  expirableWhere,
  expiryColumns,
  readExpireDays,
} from "../../../../sharing/sync-conflict-expiry.js";

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

/**
 * One health-monitor notify pass — extracted from post-listen.js so it is
 * testable (external-engine review round 2). Pushes each WARN issue that
 * shouldNotify() allows (24 h per-id window), stamping its marker only when
 * `notify` resolves; then drops markers for ids no longer active (warn OR
 * info — pruneResolved). Returns the new map, whether it changed, and the ids
 * pushed. `notify(issue)` is the caller's createNotification wrapper.
 */
/**
 * The notification a pushed health issue becomes (post-listen.js's monitor
 * passes it to createNotification). It lands on the attention route.
 */
export function healthNotification(issue) {
  return {
    type: "system",
    source: `health-monitor:${issue.id}`,
    priority: "high",
    title: issue.label,
    body: issue.actionLabel ? `${issue.actionLabel} →` : undefined,
    action_url: "/dashboard/attention",
  };
}

export async function runHealthNotifyCycle({ issues, lastMap, nowMs, notify }) {
  const map = { ...lastMap };
  let dirty = false;
  const pushed = [];
  for (const issue of issues) {
    if (issue.severity !== "warn") continue; // info issues stay strip-only
    if (!shouldNotify(map, issue.id, nowMs)) continue;
    try {
      await notify(issue);
      map[issue.id] = nowMs;
      dirty = true;
      pushed.push(issue.id);
    } catch (notifErr) {
      console.warn(`[health-monitor] notification failed for ${issue.id}:`, notifErr.message);
    }
  }
  const pruned = pruneResolved(map, issues.map((i) => i.id));
  if (Object.keys(pruned).length !== Object.keys(map).length) dirty = true;
  return { lastMap: pruned, dirty, pushed };
}

// ─── Internal signal collectors ──────────────────────────────────────────────

// df -BM --output=avail,size / — two columns: available MB, total MB.
// Injectable (like _setTailscaleReader) so a test's `ok` never depends on how
// full the disk of the machine running it happens to be.
const defaultDiskReader = () => execFileSync("df", ["-BM", "--output=avail,size", "/"], {
  encoding: "utf-8", timeout: 5000,
});
let _diskReader = defaultDiskReader;
/** Test seam: replace the df reader (returns df's stdout); null restores the real one. */
export function _setDiskReader(fn) { _diskReader = fn || defaultDiskReader; }

function diskSignal() {
  let diskFreePct = null;
  try {
    const out = _diskReader();
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
  // Set up = the Shared Storage settings in the DB (what the gateway uses) or the
  // S3_* / MINIO_* env fallback — not MINIO_ENDPOINT alone.
  let configured = false;
  try {
    const { isConfigured } = await import("../../../../storage/s3-client.js");
    configured = isConfigured();
  } catch {}
  if (!configured) {
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

// A paired peer whose gateway URL has failed /health this long is a WARN
// (pushed via the health monitor, 24 h dedupe). Long enough that a rolling
// restart or a reboot never pages; short enough that a box logged out of
// Tailscale is caught the same day, not 5 days later (the home server, 2026-09).
export const PEER_UNREACHABLE_WARN_MS = 2 * 60 * 60 * 1000;

function parseSqliteUtc(ts) {
  if (!ts) return NaN;
  const s = String(ts);
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(" ", "T") + "Z").getTime();
}

async function peersSignal(db, lang = "en", nowFn = () => Date.now()) {
  const LAG_MS = 24 * 60 * 60 * 1000;
  const now = nowFn();
  const stale = [];
  const unreachable = [];
  try {
    // 'offline' rows count too: offline is exactly the state an unreachable
    // peer is in, and the old status='active' filter hid it.
    const { rows } = await db.execute({
      sql: "SELECT id, name, last_seen_at, gateway_url FROM crow_instances WHERE trusted=1 AND status IN ('active','offline')",
      args: [],
    });
    const probe = getPeerProbeHealth();
    for (const r of rows) {
      const p = probe[r.id];
      if (r.gateway_url && p?.failingSince != null && now - p.failingSince >= PEER_UNREACHABLE_WARN_MS) {
        unreachable.push({ id: r.id, name: r.name || String(r.id).slice(0, 12), hours: Math.floor((now - p.failingSince) / 3_600_000) });
        continue;
      }
      if (!r.last_seen_at) continue;
      const seenAt = parseSqliteUtc(r.last_seen_at);
      if (now - seenAt > LAG_MS) {
        const when = new Date(seenAt).toLocaleDateString("en-US", {
          month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
        });
        stale.push({ name: r.name, when });
      }
    }
  } catch {}

  const label = t("signals.peers.label", lang);
  if (unreachable.length > 0) {
    // One card, plus one warn issue PER peer (id "peers:<instanceId>"), so a
    // second peer going down inside the first one's 24 h dedupe window still
    // pushes (review M4).
    return [
      {
        id: "peers",
        severity: "warn",
        state: "warn",
        cardOnly: true,
        label,
        value: fill(t("signals.peers.unreachableCount", lang), { n: unreachable.length }),
      },
      ...unreachable.map((u) => ({
        id: `peers:${u.id}`,
        severity: "warn",
        state: "warn",
        issueOnly: true,
        label,
        issueLabel: fill(t("signals.peers.unreachable", lang), u),
        actionLabel: t("signals.peers.action", lang),
        actionHref: "/dashboard/settings?section=paired-instances",
      })),
    ];
  }

  if (stale.length === 0) {
    return {
      id: "peers",
      severity: null,
      state: "ok",
      label,
      value: t("signals.peers.ok", lang),
    };
  }

  return {
    id: "peers",
    severity: "info",
    state: "info",
    label,
    value: fill(t("signals.peers.staleCount", lang), { n: stale.length }),
    issueLabel: fill(t("signals.peers.stale", lang), stale[0]),
    actionLabel: t("signals.peers.action", lang),
    actionHref: "/dashboard/settings?section=paired-instances",
  };
}

// PT-1 peer trust: a trust lookup that failed closed (warn: a live peer may be
// refused), a paired-but-untrusted row that still holds a bearer or a key, and
// a stored credential with no paired instance (info). One issue per peer.
function peerTrustSignal(lang = "en", nowFn = () => Date.now()) {
  const h = getPeerTrustHealth(nowFn());
  const label = t("signals.peerTrust.label", lang);
  const out = [];
  const short = (id) => String(id).slice(0, 16);
  for (const id of Object.keys(h.lookupFailures)) {
    out.push({ id: `peer-trust:lookup:${id}`, severity: "warn", state: "warn", issueOnly: true, label,
      issueLabel: fill(t("signals.peerTrust.lookupFailed", lang), { name: short(id) }),
      actionLabel: t("signals.peers.action", lang), actionHref: "/dashboard/settings?section=paired-instances" });
  }
  for (const r of h.untrustedWithCreds) {
    out.push({ id: `peer-trust:untrusted:${r.id}`, severity: "info", state: "info", issueOnly: true, label,
      issueLabel: fill(t("signals.peerTrust.untrusted", lang), { name: r.name || short(r.id) }),
      actionLabel: t("signals.peers.action", lang), actionHref: "/dashboard/settings?section=paired-instances" });
  }
  for (const id of h.orphanKeys) {
    out.push({ id: `peer-trust:orphan:${id}`, severity: "info", state: "info", issueOnly: true, label,
      issueLabel: fill(t("signals.peerTrust.orphan", lang), { name: short(id) }),
      actionLabel: t("signals.peers.action", lang), actionHref: "/dashboard/settings?section=paired-instances" });
  }
  return out.length ? out : null;
}

// DIALER-RETRY (2026-10-03): a paired peer the tailnet instance-sync dialer
// has NO usable address for, with no link to it from either side, is a WARN —
// crow sat six weeks like this for the cloud VM with 928 entries queued and no
// signal anywhere. One issue per peer (id "peers-dial:<id>", own 24 h push
// window). The grace keeps a boot that is still learning addresses quiet.
export const NO_DIAL_ADDRESS_WARN_MS = 10 * 60 * 1000;
// Same id, second shape: the peer HAS dial candidates but every dial has
// failed for this long with no link (wrong port, ufw, dead tailnet path) —
// the /health probe over the Serve URL can stay green meanwhile.
export const DIAL_FAILING_WARN_MS = 30 * 60 * 1000;
export const DIAL_FAILING_MIN_ATTEMPTS = 5;

async function syncDialSignal(db, lang = "en", nowFn = () => Date.now()) {
  const dial = getPeerDialHealth();
  if (Object.keys(dial).length === 0) return null;
  const now = nowFn();
  const out = [];
  try {
    const { rows } = await db.execute({
      sql: "SELECT id, name FROM crow_instances WHERE status IN ('active','offline')",
      args: [],
    });
    for (const r of rows) {
      const h = dial[r.id];
      if (!h) continue;
      const name = r.name || String(r.id).slice(0, 12);
      const linkUp = h.linkedAt != null && h.linkClosedAt == null;
      let issueLabel = null;
      if (h.noAddressSince != null && now - h.noAddressSince >= NO_DIAL_ADDRESS_WARN_MS) {
        issueLabel = fill(t("signals.peers.noDialAddress", lang), { name, missing: (h.missing || []).join("; ") || "?" });
      } else if (!linkUp && h.failingSince != null && h.failCount >= DIAL_FAILING_MIN_ATTEMPTS
        && now - h.failingSince >= DIAL_FAILING_WARN_MS) {
        issueLabel = fill(t("signals.peers.dialFailing", lang), {
          name, minutes: Math.floor((now - h.failingSince) / 60_000), error: h.lastError || "?",
        });
      }
      if (!issueLabel) continue;
      out.push({
        id: `peers-dial:${r.id}`,
        severity: "warn",
        state: "warn",
        issueOnly: true,
        label: t("signals.peers.label", lang),
        issueLabel,
        actionLabel: t("signals.peers.action", lang),
        actionHref: "/dashboard/settings?section=paired-instances",
      });
    }
  } catch {}
  return out.length ? out : null;
}

let _reservationReader = (nowMs) => readReservation({ now: nowMs });
/** Test seam: replace the reservation reader; null restores the real one. */
export function _setReservationReader(fn) {
  _reservationReader = fn || ((nowMs) => readReservation({ now: nowMs }));
}

function reservationSignal(lang, nowFn) {
  const r = _reservationReader(nowFn());
  if (!r) return null; // box is free: no card (the scope asks for a card only while held)
  const label = t("signals.reservation.label", lang);
  if (r.corrupt) {
    return {
      id: "reservation", severity: "info", state: "info", label,
      value: t("signals.reservation.value", lang),
      issueLabel: t("signals.reservation.corrupt", lang),
    };
  }
  const until = new Date(r.expires_at).toLocaleString(lang === "es" ? "es" : "en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  const base = fill(t("signals.reservation.held", lang), { owner: r.owner, until });
  return {
    id: "reservation", severity: "info", state: "info", label,
    value: t("signals.reservation.value", lang),
    issueLabel: r.reason ? `${base} (${r.reason})` : base,
  };
}

// ─── Artifact sidecar node ───────────────────────────────────────────────────
// The reader caches for 5 minutes and returns null when no sidecar is
// configured (no card then).
let _artifactNodeReader = createSidecarHealthReader();
/** Test seam: replace the sidecar health reader; null restores the real one. */
export function _setArtifactNodeReader(fn) {
  _artifactNodeReader = fn || createSidecarHealthReader();
}

const ARTIFACT_NODE_PROBLEMS = ["logged-out", "key-expiring", "funnel-on", "unexpected-mapping", "unreachable"];
const ARTIFACT_NODE_KEYS = {
  "logged-out": "signals.artifactNode.loggedOut",
  "key-expiring": "signals.artifactNode.keyExpiring",
  "funnel-on": "signals.artifactNode.funnelOn",
  "unexpected-mapping": "signals.artifactNode.unexpectedMapping",
  "unreachable": "signals.artifactNode.unreachable",
};

async function artifactNodeSignal(lang) {
  const h = await _artifactNodeReader();
  const label = t("signals.artifactNode.label", lang);
  if (!h) {
    // Own-host mode with no sidecar socket means NOTHING is being watched
    // (review L5): warn instead of passing silently, because a logged-out or
    // expired node would break every artifact frame with no signal anywhere.
    if (process.env.CROW_ARTIFACT_ORIGIN_URL && !process.env.CROW_ARTIFACT_SIDECAR_SOCKET) {
      return {
        id: "artifact-node:unmonitored", severity: "warn", state: "warn", issueOnly: true, label,
        issueLabel: t("signals.artifactNode.unmonitored", lang),
      };
    }
    return null;
  }
  if (h.ok) return { id: "artifact-node", severity: null, state: "ok", label, value: t("signals.artifactNode.ok", lang) };
  const problems = (h.problems || []).filter((p) => ARTIFACT_NODE_PROBLEMS.includes(p));
  if (problems.length === 0) problems.push("unreachable");   // not ok without a known problem: fail closed
  const date = typeof h.keyExpiry === "string" ? h.keyExpiry.slice(0, 10) : "?";
  return [
    { id: "artifact-node", severity: "warn", state: "warn", cardOnly: true, label, value: t("signals.artifactNode.problem", lang) },
    ...problems.map((p) => ({
      id: `artifact-node:${p}`, severity: "warn", state: "warn", issueOnly: true, label,
      issueLabel: fill(t(ARTIFACT_NODE_KEYS[p], lang), { date }),
    })),
  ];
}

// Updates (audit N1c-1). The version pair alone cannot tell "up to date" from
// "every tick has been failing since Tuesday": auto-update's failure branches
// leave latest_version untouched, so the card read OK while nothing was being
// checked. The card now reads the result auto-update actually wrote — classified
// by auto-update.js itself (UPDATE_RESULT_PREFIXES, one source of truth) — plus
// the age of the last check and the interval the timer runs on.
const UPDATE_CAUSE_KEYS = {
  "not-on-main": "signals.updates.causeNotOnMain",
  "branch-unknown": "signals.updates.causeBranchUnknown",
  "ci-red": "signals.updates.causeCiRed",
  "ci-pending": "signals.updates.causeCiPending",
  // Review S2: GitHub answered, but without our three checks — a fork without
  // this repo's CI. Never "CI is still running" for days. Round 2: also the
  // partial fork (some checks present, nothing running), so the wording is
  // "didn't all run".
  "no-ci": "signals.updates.causeNoCi",
  // N1c-5: GitHub could not be asked. Two codes, so an outage that clears reads
  // differently from one that has paused updates for good.
  "ci-unavailable": "signals.updates.causeCiUnavailable",
  "ci-gate-unavailable": "signals.updates.causeCiUnavailablePaused",
  "branch-changed": "signals.updates.causeBranchChanged",
  "fetch-failed": "signals.updates.causeFetchFailed",
  "pull-failed": "signals.updates.causePullFailed",
  "update-error": "signals.updates.causeError",
  "migration-quarantined": "signals.updates.causeQuarantined",
  "migration-failed": "signals.updates.causeMigrationFailed",
  "init-db-failed": "signals.updates.causeInitDbFailed",
  other: "signals.updates.causeOther",
};

// auto_update_last_check is written as an ISO string (auto-update.js); anything
// unparseable counts as "no check recorded" rather than as fresh.
function settingTimeMs(value) {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

async function updatesSignal(db, nowFn, opts = {}) {
  const lang = opts.lang ?? "en";
  const label = t("signals.updates.label", lang);
  const action = {
    actionLabel: t("signals.updates.action", lang),
    actionHref: "/dashboard/settings?section=updates",
  };

  // Same defaults auto-update.js uses for a missing row (a fresh install is
  // enabled), so a DB read that fails open cannot read as "off".
  const settings = {
    auto_update_enabled: "true",
    auto_update_interval_hours: String(DEFAULT_INTERVAL_HOURS),
    auto_update_last_check: null,
    auto_update_last_result: null,
    auto_update_result_since: null,
    auto_update_current_version: null,
    auto_update_latest_version: null,
    auto_update_ci_gate: null,
  };
  try {
    const { rows } = await db.execute({
      sql: "SELECT key, value FROM dashboard_settings WHERE key LIKE 'auto_update_%'",
      args: [],
    });
    for (const row of rows || []) if (Object.hasOwn(settings, row.key)) settings[row.key] = row.value;
  } catch {}

  const current = settings.auto_update_current_version || null;
  const latest = settings.auto_update_latest_version || null;

  // Auto-update can be off for reasons the DB row never records: the
  // CROW_AUTO_UPDATE=0|false kill switch always wins, and a --no-auth gateway
  // defaults OFF until it opts in. Ask auto-update.js's own predicate — the
  // card must never show a stale warn for a timer that was never going to
  // start. `process.argv` is how this module reads gateway flags (see
  // exposureSignal's --no-auth check); opts.noAuth overrides it for callers
  // that hold the real flag.
  const noAuth = typeof opts.noAuth === "boolean" ? opts.noAuth : process.argv.includes("--no-auth");
  const envAllows = shouldStartAutoUpdate({ env: process.env, noAuth });

  // Disabled is its own neutral state: never ok-green, and never a version
  // claim that reads as "you are current".
  if (settings.auto_update_enabled !== "true" || !envAllows) {
    return { id: "updates", severity: null, state: "off", label, value: t("signals.updates.off", lang) };
  }

  const intervalHours = Math.max(
    MIN_INTERVAL_HOURS,
    parseInt(settings.auto_update_interval_hours, 10) || DEFAULT_INTERVAL_HOURS,
  );
  // N1c-5: an origin that is not GitHub has no CI to ask, so the CI gate can
  // never apply there. The card keeps its reading and gains ONE info line, so
  // "updates are not gated here" is stated instead of being guessed at. The
  // reading is re-recorded by an up-to-date tick as well (auto-update.js), so
  // the line does not vanish between pulls (review round 2).
  const withCiGate = (card) => settings.auto_update_ci_gate === "not-applicable"
    ? [card, {
      id: "updates:ci-gate", severity: "info", state: "info", issueOnly: true, label,
      issueLabel: t("signals.updates.ciGateNotApplicable", lang),
    }]
    : card;
  const stuckMs = 2 * intervalHours * 60 * 60 * 1000;
  const now = nowFn();
  const lastCheckMs = settingTimeMs(settings.auto_update_last_check);
  const resultSinceMs = settingTimeMs(settings.auto_update_result_since);
  const result = classifyUpdateResult(settings.auto_update_last_result);

  // A check older than two intervals means the timer itself stopped — but only
  // once this process has been up that long. A host that was off for days has a
  // days-old last_check and a five-minute uptime: that is a boot, not a stuck
  // timer, and it must not push "no update check for 2d" before its first tick.
  const upMs = Number.isFinite(opts.uptimeMs) ? opts.uptimeMs : process.uptime() * 1000;
  const checkAgeMs = lastCheckMs == null ? null : Math.max(0, now - lastCheckMs);
  const checkIsStale = Math.min(checkAgeMs ?? Infinity, upMs) > stuckMs;

  const causeOf = (code) => t(UPDATE_CAUSE_KEYS[code] || UPDATE_CAUSE_KEYS.other, lang);
  let cause = null;
  if (result && result.kind === "failure") {
    cause = causeOf(result.code);
  } else if (result && result.kind === "transient" && resultSinceMs != null) {
    // Every pending tick rewrites auto_update_last_check, so the CHECK's age can
    // never show a stuck transient. Age the RESULT instead: auto-update.js
    // stamps auto_update_result_since when the classification code changes and
    // leaves it alone while the same code keeps repeating. No stamp at all
    // means "unknown age", which is never a warn.
    const resultAgeMs = Math.max(0, now - resultSinceMs);
    if (resultAgeMs > stuckMs) {
      cause = fill(t("signals.updates.causeStuckTransient", lang), {
        cause: causeOf(result.code),
        age: formatAge(resultAgeMs),
      });
    }
  }
  if (!cause && checkIsStale) {
    cause = lastCheckMs == null
      ? t("signals.updates.causeNeverChecked", lang)
      : fill(t("signals.updates.causeStaleCheck", lang), { age: formatAge(checkAgeMs) });
  }

  if (cause) {
    return withCiGate({
      id: "updates",
      severity: "warn",
      state: "warn",
      label,
      value: cause,
      issueLabel: fill(t("signals.updates.stuckIssue", lang), { cause }),
      ...action,
    });
  }

  if (current && latest && current !== latest) {
    return withCiGate({
      id: "updates",
      severity: "info",
      state: "info",
      label,
      value: fill(t("signals.updates.availableValue", lang), { version: latest }),
      issueLabel: t("signals.updates.availableIssue", lang),
      ...action,
    });
  }

  return withCiGate({
    id: "updates",
    severity: null,
    state: "ok",
    label,
    value: current ? fill(t("signals.updates.currentValue", lang), { version: current }) : t("signals.updates.upToDate", lang),
  });
}

async function syncConflictsSignal(db) {
  let count = 0;
  try {
    // Only UNEXPIRED conflicts are still owed a look: a row the 6-hourly sweep
    // would clear on its own must not keep a warning card alive (363-month-old
    // rows being the reason this signal exists). A store that predates the
    // expiry columns counts every unresolved row, its old behaviour.
    const cols = await expiryColumns(db);
    let query = { sql: "SELECT COUNT(*) AS n FROM sync_conflicts WHERE resolved = 0", args: [] };
    const filtered = cols.has("opened_at");
    if (filtered) {
      const { sql: where, args } = expirableWhere(await readExpireDays(db));
      query = {
        sql: `SELECT COUNT(*) AS n FROM sync_conflicts WHERE resolved = 0 AND NOT (${where})`,
        args,
      };
    }
    let rows;
    try {
      ({ rows } = await db.execute(query));
    } catch (err) {
      // The expiry predicate failed (e.g. a malformed snapshot): count every
      // unresolved row rather than report "none" — a broken query must not
      // hide conflicts. A missing table still throws here and lands below.
      if (!filtered) throw err;
      ({ rows } = await db.execute({ sql: "SELECT COUNT(*) AS n FROM sync_conflicts WHERE resolved = 0", args: [] }));
    }
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

// Stdio→gateway sync outbox (stdio-sync-outbox, Task 7 "Observability" —
// spec: "health surface gains outbox depth + oldest-row age"). Reads
// sync-outbox-drain.js's getStats(db) — same depth/oldest-age shape the
// drain itself logs. A depth-only warn would be too eager (queued rows are
// normal between 60s drain ticks); the warn threshold instead mirrors the
// drain's own CLAIM_STALE_MINUTES (10 min) window with headroom — a row
// still queued past 15 minutes has survived several drain ticks and a
// stale-claim reclaim, so something (drain not running, every paired peer
// unarmed, gateway down) is actually stuck.
const OUTBOX_STALE_WARN_MS = 15 * 60 * 1000;

async function outboxSignal(db) {
  let stats;
  try {
    stats = await getOutboxStats(db);
  } catch {
    // Fresh install / stub db without executeMultiple — degrade quietly,
    // same as syncConflictsSignal's older-install catch above.
    return { id: "syncOutbox", severity: null, state: "ok", label: "Sync outbox", value: "empty" };
  }

  if (stats.depth === 0) {
    return { id: "syncOutbox", severity: null, state: "ok", label: "Sync outbox", value: "empty" };
  }

  const ageLabel = stats.oldestAgeMs != null ? formatAge(stats.oldestAgeMs) : "unknown age";
  const stale = stats.oldestAgeMs != null && stats.oldestAgeMs > OUTBOX_STALE_WARN_MS;

  if (stale) {
    return {
      id: "syncOutbox",
      severity: "warn",
      state: "warn",
      label: "Sync outbox",
      value: `${stats.depth} queued · oldest ${ageLabel}`,
      issueLabel: `${stats.depth} queued sync row${stats.depth === 1 ? "" : "s"} waiting, oldest ${ageLabel}`,
      actionLabel: "View instances",
      actionHref: "/dashboard/settings?section=paired-instances",
    };
  }

  return {
    id: "syncOutbox",
    severity: null,
    state: "ok",
    label: "Sync outbox",
    value: `${stats.depth} queued · oldest ${ageLabel}`,
  };
}

// Directory, file naming and ownership come from the same module admin-backup
// writes with (servers/shared/backup-naming.js), so the signal only ever looks
// at THIS instance's backups — a co-hosted instance's newer file in the same
// directory must not read as ours (2026-10-04: r4's backup masked the
// primary's missing one).
async function backupSignal(db, nowFn, lang) {
  const nowMs = nowFn();
  const { dir, label, tag, me } = localBackupContext(process.env);
  const own = newestBackupOwnership(dir, label, tag, me);
  const newestMtimeMs = own.newest ? own.newest.mtimeMs : null;
  const newestPath = own.newest ? own.newest.path : null;

  const runAction = { actionLabel: t("health.runBackupNow", lang), actionHref: "/dashboard/nest?action=backup" };

  if (newestMtimeMs === null) {
    return {
      id: "backup", severity: "info", state: "info", label: t("signals.backup.label", lang),
      value: "never", issueLabel: t("signals.backup.neverIssue", lang), ...runAction,
    };
  }

  if (own.status === "foreign" || own.status === "mismatch") {
    return {
      id: "backup", severity: "warn", state: "warn", label: t("signals.backup.label", lang),
      value: t("signals.backup.foreign", lang),
      issueLabel: own.status === "foreign"
        ? t("signals.backup.foreignIssue", lang).replace("{owner}", String(own.owner.crow_home || own.owner.instance_id || "?"))
        : t("signals.backup.mismatchIssue", lang),
      ...runAction,
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

  // A failed run keeps the previous good file (write-then-rename), so a failure
  // newer than our newest file also counts.
  const verifiedFailedForNewest = verified && verified.ok === false
    && (verified.path === newestPath || Date.parse(verified.checked_at || "") >= newestMtimeMs);
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

// Keychain Export reminder (recovery keys, queue item 30): a password an extension saved to the
// keychain that is in no keychain Export lives only on this machine. Info only (strip, never a push); no card
// when every generated key is exported or there are none.
async function keychainExportSignal(db, lang) {
  const n = await unexportedCount(db, loadKeychainKey()?.id);
  if (n <= 0) return null;
  return {
    id: "keychainExport", severity: "info", state: "info", label: t("signals.keychainExport.label", lang),
    value: String(n), issueLabel: fill(t("signals.keychainExport.issue", lang), { n }),
    actionLabel: t("signals.keychainExport.action", lang), actionHref: "/dashboard/settings?section=passwords",
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

// Returns what Funnel exposes — { handlers: [{ mount, kind, proxy }], tcpForwards:
// [port] } — or null when we couldn't determine it (CLI absent / erroring /
// unexpected shape) → caller skips silently.
// C1: serve ≠ funnel. A healthy PRIVATE box mounts "/" under Web.<host> with
// NO AllowFunnel key — that must NOT be read as exposure. Only handlers under a
// hostport with AllowFunnel===true are actually public.
function funnelExposure(nowMs) {
  if (nowMs - _tsServeCache.ts < 5 * 60 * 1000) return _tsServeCache.raw;
  let out = null;
  try {
    const cfg = JSON.parse(_tailscaleReader());
    const allow = cfg.AllowFunnel || {};
    const enabledHostports = Object.keys(allow).filter((hp) => allow[hp] === true);
    // Absent/empty AllowFunnel → fully private → empty lists (not null).
    out = { handlers: [], tcpForwards: [] };
    for (const hp of enabledHostports) {
      const handlers = (cfg.Web && cfg.Web[hp] && cfg.Web[hp].Handlers) || {};
      for (const [mount, h] of Object.entries(handlers)) {
        const proxy = typeof h?.Proxy === "string" && h.Proxy ? h.Proxy : null;
        out.handlers.push({ mount, kind: proxy ? "proxy" : "other", proxy });
      }
      // A raw TCP forwarder on a Funnel port never passes through the gateway's
      // Funnel-header middleware.
      const port = hp.slice(hp.lastIndexOf(":") + 1);
      const tcp = cfg.TCP && cfg.TCP[port];
      if (tcp && tcp.TCPForward) out.tcpForwards.push(port);
    }
  } catch {
    out = null; // CLI missing / not running / unexpected shape → skip
  }
  _tsServeCache = { ts: nowMs, raw: out };
  return out;
}

// Every name/address a Serve target could use to reach a listener on THIS host.
function defaultOwnHosts() {
  const hosts = new Set(["localhost", "0.0.0.0", "::", "::1"]);
  try {
    const h = hostname().toLowerCase();
    if (h) hosts.add(h);
  } catch {}
  try {
    for (const addrs of Object.values(networkInterfaces())) {
      for (const a of addrs || []) if (a && a.address) hosts.add(String(a.address).toLowerCase().split("%")[0]);
    }
  } catch {}
  return hosts;
}

// ::ffff:127.0.0.1 and ::ffff:7f00:1 (what URL normalises it to) → 127.0.0.1.
function unmapIPv4(h) {
  const dotted = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return h;
  const [a, b] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
}

// Known limit: an alias or MagicDNS name for this host that defaultOwnHosts()
// does not list classifies as another service (info, not warn). Layer 1 — the
// Funnel-header middleware in funnel.js — still enforces the allowlist there.
function isOwnHost(host, ownHosts) {
  const h = unmapIPv4(host.toLowerCase().replace(/^\[|\]$/g, ""));
  if (ownHosts.has(h)) return true;
  if (h.endsWith(".localhost")) return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(h)) return true;
  // The machine's own name under any domain (crow.local, crow.<tailnet>.ts.net).
  for (const o of ownHosts) if (/^[a-z]/.test(o) && h.startsWith(o + ".")) return true;
  return false;
}

/**
 * Classify a Tailscale Serve proxy target. Mirrors tailscale's expandProxyArg
 * (ipn/ipnlocal/serve.go): a bare port means http://127.0.0.1:<port>, host:port
 * means http://host:port, https+insecure:// is https. Returns
 * { own, backendPath, label }: own = the target is THIS gateway (or we can't
 * tell — unparseable and unix-socket targets count as own, so they warn);
 * backendPath = the path the gateway receives for a request at the mount itself.
 * Tailscale strips the mount and joins the remainder onto the target's path
 * (serveWebHandler's http.StripPrefix + reverseProxy SetURL), so a mount
 * proxied to a bare host:port hands the gateway "/" and everything under it.
 */
export function classifyFunnelTarget(proxy, { port = gatewayListenPort(), ownHosts = defaultOwnHosts() } = {}) {
  const raw = String(proxy || "");
  let urlStr;
  if (/^https?:\/\//i.test(raw)) urlStr = raw;
  else if (/^https\+insecure:\/\//i.test(raw)) urlStr = "https://" + raw.slice("https+insecure://".length);
  else if (/^\d+$/.test(raw)) urlStr = "http://127.0.0.1:" + raw;
  else if (raw && !raw.startsWith("unix:")) urlStr = "http://" + raw;
  let u = null;
  try { if (urlStr) u = new URL(urlStr); } catch { u = null; }
  if (!u || !u.hostname) return { own: true, backendPath: "/", label: raw };
  const targetPort = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  const local = isOwnHost(u.hostname, ownHosts);
  return {
    own: local && targetPort === port,
    backendPath: u.pathname || "/",
    label: local ? `:${targetPort}` : `${u.hostname}:${targetPort}`,
  };
}

// A backend path is public-safe when it is on the allowlist itself (an exact
// file like /robots.txt) or when its subtree is (/s-assets → /s-assets/…):
// either way the mapping targets a public surface, and the middleware 403s any
// stray path under it. "/" is never on the list (funnel.js refuses a lone "/").
function isPublicSafeBackendPath(p, prefixes) {
  const sub = p.endsWith("/") ? p : p + "/";
  return isFunnelPublicPath(p, prefixes) || isFunnelPublicPath(sub, prefixes);
}

// ─── Host firewall (audit N1c-16) ────────────────────────────────────────────
// UFW's config file is world-readable on Ubuntu/Mint; its RULES are not, so
// "ENABLED=yes/no" is the only firewall fact this card may state. Never run
// `ufw` or `sudo` from a health signal. A missing or unreadable file (not UFW,
// or a distro that keeps its state elsewhere) is "unknown", never "off" and
// never "on".
export const UFW_CONF_PATH = "/etc/ufw/ufw.conf";
const defaultFirewallReader = () => readFileSync(UFW_CONF_PATH, "utf-8");
let _firewallReader = defaultFirewallReader;
/** Test seam: replace the ufw.conf reader; null restores the real one. */
export function _setFirewallReader(fn) { _firewallReader = fn || defaultFirewallReader; }

/** "on" | "off" | "unknown", from ENABLED= in ufw.conf and nothing else. */
export function readHostFirewall() {
  let text;
  try {
    text = _firewallReader();
  } catch {
    return "unknown";
  }
  const m = /^\s*ENABLED\s*=\s*["']?(\w+)/m.exec(String(text ?? ""));
  if (!m) return "unknown";
  const v = m[1].toLowerCase();
  if (v === "yes" || v === "true") return "on";
  if (v === "no" || v === "false") return "off";
  return "unknown";
}

// ─── Container detection ─────────────────────────────────────────────────────
// Inside a container the gateway binds 0.0.0.0 (the default) and there is no
// /etc/ufw/ufw.conf, so the bind + firewall pair would be a PERMANENT warn on
// every container install (docker-compose.yml, Railway, render). Both facts
// describe the container, not the host: the host's firewall never shows up in
// here, and who can reach the dashboard is decided by which ports the container
// publishes on the host. So neither fact is ever a warn inside a container —
// the Funnel checks still are, because those are about THIS Crow's routes.
export const CONTAINER_MARKER_PATHS = Object.freeze(["/.dockerenv", "/run/.containerenv"]);
const defaultContainerReader = () => CONTAINER_MARKER_PATHS.some((p) => existsSync(p));
let _containerReader = defaultContainerReader;
/** Test seam: replace the container-marker check; null restores the real one. */
export function _setContainerReader(fn) { _containerReader = fn || defaultContainerReader; }

/** true when this process runs inside a container (`/.dockerenv` or `/run/.containerenv`). */
export function isRunningInContainer() {
  try {
    return !!_containerReader();
  } catch {
    return false; // an unreadable marker set is "not known to be a container"
  }
}

// Scope: this check guards THIS Crow's routes (CLAUDE.md "Network exposure
// invariant"). A Funnel proxy to another port/host belongs to another service
// (or another Crow on this host, which judges its own paths against its own
// allowlist), so it is surfaced as an info line — visible, never silent — not
// as this Crow's warning. Anything we cannot attribute (non-proxy handlers,
// TCP forwarders, unparseable targets) is treated as this Crow's and warns.
// A fixed-length key ("m1:" + sha256 hex): the ack route caps a key at 1024
// characters, and a target with many mounts would otherwise never be ackable.
export function foreignMappingKey(target, mounts) {
  return "m1:" + createHash("sha256").update(target + "|" + mounts.slice().sort().join(",")).digest("hex");
}

// Keys of acknowledged foreign mappings (a JSON array in a local setting).
// A missing or malformed value means nothing is acknowledged.
async function readForeignAcks(db) {
  try {
    const raw = await readSetting(db, "health_ack_exposure_foreign");
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter((k) => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

async function exposureSignal(db, lang, nowFn, opts = {}) {
  const label = t("signals.exposure.label", lang);
  const problems = [];
  if (process.env.CROW_DASHBOARD_PUBLIC === "true") problems.push(t("signals.exposure.public", lang));
  if (process.argv.includes("--no-auth")) problems.push(t("signals.exposure.noauth", lang));
  if (process.env.CROW_CSRF_STRICT === "0") problems.push(t("signals.exposure.csrf", lang));

  const exposed = funnelExposure(nowFn());
  const foreign = new Map(); // target label → [mount]
  if (exposed) {
    const prefixes = effectiveFunnelPrefixes();
    const port = gatewayListenPort();
    const ownHosts = defaultOwnHosts();
    let unsafe = false;
    for (const h of exposed.handlers) {
      if (h.kind !== "proxy") { unsafe = true; continue; }
      const c = classifyFunnelTarget(h.proxy, { port, ownHosts });
      if (!c.own) {
        if (!foreign.has(c.label)) foreign.set(c.label, []);
        foreign.get(c.label).push(h.mount);
        continue;
      }
      if (!isPublicSafeBackendPath(c.backendPath, prefixes)) unsafe = true;
    }
    if (exposed.tcpForwards.length > 0) problems.push(t("signals.exposure.tcp", lang));
    if (unsafe) problems.push(t("signals.exposure.funnel", lang));
  }

  // Three separate facts, none of which may be skipped (audit N1c-16):
  //  (a) the bind, taken from the gateway's own listener (listen-host.js) so
  //      this card can never disagree with what index.js actually binds;
  //  (b) the host firewall, from ufw.conf only — never root;
  //  (c) Funnel, above: a failed `tailscale` call is UNKNOWN, never "private".
  const bindHost = opts.bind ?? gatewayListenHost();
  const bindKind = classifyHostIp(bindHost).kind;
  const everyInterface = bindKind === "wildcard" || bindKind === "empty";
  // Anything that is not loopback and not this machine's tailnet address is
  // reachable from the local network — including a bind shape we cannot read,
  // which must not be reported as private.
  const onLocalNetwork = !(bindKind === "loopback" || bindKind === "tailnet");
  const firewall = readHostFirewall();
  const inContainer = isRunningInContainer();

  // A noun phrase, so the value line and the issue sentence can share it.
  const where = everyInterface
    ? t("signals.exposure.everyInterface", lang)
    : fill(t("signals.exposure.bindAddress", lang), { bind: bindHost });
  const bindLine = fill(t("signals.exposure.bindValue", lang), { where });
  const firewallText = firewall === "on"
    ? t("signals.exposure.firewallOn", lang)
    : firewall === "off"
      ? t("signals.exposure.firewallOff", lang)
      : t("signals.exposure.firewallUnknown", lang);

  const unknowns = [];
  if (!exposed) unknowns.push(t("signals.exposure.checkFunnel", lang));
  const unknownSuffix = unknowns.length
    ? fill(t("signals.exposure.unknownList", lang), { list: unknowns.join(", ") })
    : "";
  const withUnknowns = (value) => (unknownSuffix ? `${value} · ${unknownSuffix}` : value);
  // Bound anywhere the local network can reach, with a firewall that is off OR
  // could not be read, is a WARN: nothing confirms the local network is kept
  // out, so the card must not read as protected. Other unknown checks (Funnel)
  // are at most info, and inside a container neither the bind nor the firewall
  // is a warn at all (see the container branch below).
  const settingsAction = {
    actionLabel: t("signals.exposure.action", lang),
    actionHref: "/dashboard/settings?section=connections",
  };
  const bindAction = {
    actionLabel: t("signals.exposure.bindAction", lang),
    // The connections section, not the bare settings page: the mascot sheet's
    // own Settings link is the bare URL, and an issue must not stand in for it.
    actionHref: "/dashboard/settings?section=connections",
  };

  const out = [];
  if (problems.length > 0) {
    out.push({
      id: "exposure", severity: "warn", state: "warn", label,
      value: withUnknowns(t("signals.exposure.open", lang)), issueLabel: problems[0],
      ...settingsAction,
    });
  } else if (inContainer) {
    // The bind and the (missing) ufw.conf describe the CONTAINER, not the host:
    // warning on them would be a permanent false alarm on every container
    // install. Info instead, pointing at the only fact that matters there — the
    // ports the container publishes on the host. Funnel problems, above, still
    // warn the same way they do on a host.
    out.push({
      id: "exposure", severity: "info", state: "info", label,
      value: withUnknowns(fill(t("signals.exposure.containerValue", lang), { bind: bindLine })),
      issueLabel: t("signals.exposure.containerIssue", lang),
      ...bindAction,
    });
  } else if (onLocalNetwork && (firewall === "off" || firewall === "unknown")) {
    out.push({
      id: "exposure", severity: "warn", state: "warn", label,
      value: withUnknowns(`${bindLine}; ${firewallText}`),
      // "off" and "unknown" are different facts and get different sentences: a
      // firewall that could not be read (firewalld, nftables, no ufw.conf) is
      // not the same claim as a firewall known to be off.
      issueLabel: fill(t(
        firewall === "unknown" ? "signals.exposure.lanIssueUnknown" : "signals.exposure.lanIssue",
        lang,
      ), { where }),
      ...bindAction,
    });
  } else if (onLocalNetwork) {
    out.push({
      id: "exposure", severity: "info", state: "info", label,
      value: withUnknowns(`${bindLine}; ${firewallText}`),
      issueLabel: fill(t("signals.exposure.lanInfo", lang), { where, firewall: firewallText }),
      ...bindAction,
    });
  } else if (unknowns.length > 0) {
    // Bound where LAN traffic cannot reach it, but a check could not run:
    // "at most info", and the value names what is unverified instead of "private".
    out.push({
      id: "exposure", severity: "info", state: "info", label,
      value: fill(t("signals.exposure.unknownValue", lang), { list: unknowns.join(", ") }),
      issueLabel: fill(t("signals.exposure.unknownIssue", lang), { list: unknowns.join(", ") }),
      ...settingsAction,
    });
  } else {
    out.push({ id: "exposure", severity: null, state: "ok", label, value: t("signals.exposure.private", lang) });
  }
  if (foreign.size > 0) {
    const acked = await readForeignAcks(db);
    for (const [target, mounts] of foreign) {
      const sorted = mounts.slice().sort();
      const key = foreignMappingKey(target, sorted);
      if (acked.has(key)) continue;
      out.push({
        id: `exposure:foreign:${target}`, severity: "info", state: "info", issueOnly: true,
        label: fill(t("signals.exposure.foreign", lang), { list: `${sorted.join(", ")} → ${target}` }),
        actionLabel: t("signals.exposure.action", lang), actionHref: "/dashboard/settings?section=connections",
        ack: { kind: "exposure-foreign", key },
      });
    }
  }
  return out;
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
    // ?open=1 is the classic Nest's explicit form: a bare /dashboard/nest
    // would send a new-mode device back to Chat instead of showing it.
    actionHref: "/dashboard/nest?open=1",
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

// Provider residency (F-HEALTH-1). Reads the pure provider-health module —
// zero-import state written by the orchestrator's residency poll. A provider is
// "in outage" when it is not ready and has been so for >= notReadyWarnMs since
// its last-ready (or, if never ready, since ownership was taken). The embed-vs
// non-embed issue copy is DERIVED from the down providers' embed flags: crow
// only ever owns crow-voice (no embed model), so a hardcoded "embeddings
// degraded" line would send the operator after the wrong subsystem.
function notReadyWarnMs() {
  const n = Number(process.env.CROW_PROVIDER_NOT_READY_WARN_MS);
  return Number.isFinite(n) && n > 0 ? n : 10 * 60 * 1000;
}

async function providersSignal(lang, nowFn) {
  const health = getProviderHealth();
  const label = t("signals.providers.label", lang);
  const action = {
    actionLabel: t("signals.providers.action", lang),
    actionHref: "/dashboard/settings?section=llm&tab=health",
  };

  if (!health.initialized) {
    return { id: "providers", severity: null, state: "off", label, value: t("signals.providers.notStarted", lang) };
  }
  const names = Object.keys(health.providers);
  if (names.length === 0) {
    return { id: "providers", severity: null, state: "off", label, value: t("signals.providers.off", lang) };
  }

  const now = nowFn();
  const threshold = notReadyWarnMs();
  const down = [];
  let readyCount = 0;
  let warmingCount = 0;
  for (const name of names) {
    const p = health.providers[name];
    if (p.ready) { readyCount++; continue; }
    const origin = p.lastReadyAt ?? p.firstOwnedAt;
    if (now - origin >= threshold) {
      down.push({ name, embed: !!p.embed, age: formatAge(now - origin) });
    } else {
      warmingCount++;
    }
  }

  if (down.length > 0) {
    const value = down.length === 1
      ? t("signals.providers.down", lang).replace("{name}", down[0].name).replace("{age}", down[0].age)
      : t("signals.providers.downMulti", lang).replace("{n}", String(down.length));

    // Always NAME the provider when exactly one is down — this string becomes the
    // notification title (post-listen.js sets title: issue.label). The embed-vs-voice
    // split is derived from the provider's own embed flag, never hardcoded: crow only
    // ever owns crow-voice, which carries no embed model.
    let issueLabel;
    if (down.length === 1) {
      const key = down[0].embed ? "signals.providers.downIssueEmbed" : "signals.providers.downIssue";
      issueLabel = t(key, lang).replace("{name}", down[0].name);
    } else {
      issueLabel = t("signals.providers.downIssueMulti", lang)
        .replace("{n}", String(down.length))
        .replace("{names}", down.map(d => d.name).join(", "));
    }
    return { id: "providers", severity: "warn", state: "warn", label, value, issueLabel, ...action };
  }

  const parts = [t("signals.providers.resident", lang).replace("{n}", String(readyCount))];
  if (warmingCount > 0) {
    parts.push(t("signals.providers.warming", lang).replace("{n}", String(warmingCount)));
  }
  return { id: "providers", severity: null, state: "ok", label, value: parts.join(" · ") };
}

// External engines (spec 2026-09-23 external-engine-provider §2.4, review
// rounds 1+2). OWN id, never "providers": the monitor's dedupe is per issue id
// and pruneResolved keeps a marker alive while ANY issue with that id is active,
// so an external info under "providers" would keep the resident warn's marker
// alive and swallow the next real resident push. INFO AT MOST, never warn:
// these engines are operated from outside Crow (raven's prod windows stop
// halogen for hours by design). Labels/hosts are free text replicated from
// peers — fill() (no $-pattern mangling); the nest escapes HTML.
async function externalEnginesSignal(lang, nowFn) {
  const health = getProviderHealth();
  const external = health.external || {};
  const names = Object.keys(external);
  if (!health.initialized || names.length === 0) return null; // nothing watched → no card
  const label = t("signals.externalEngines.label", lang);
  const now = nowFn();
  const lines = [];
  const notUp = [];
  for (const name of names) {
    const e = external[name];
    const vars = { label: e.label || name, host: e.engineHost || "?" };
    if (e.ready) {
      lines.push(fill(t("signals.externalEngines.up", lang), vars));
      continue;
    }
    let line;
    if (e.lastReadyAt != null) {
      const age = formatAge(now - e.lastReadyAt);
      line = fill(t("signals.externalEngines.downFor", lang), { ...vars, age: age === "now" ? "<1m" : age });
    } else {
      line = fill(t("signals.externalEngines.unreachable", lang), vars);
    }
    lines.push(line);
    notUp.push(line);
  }
  if (notUp.length > 0) {
    return {
      id: "externalEngines", severity: "info", state: "info", label,
      value: lines.join(" · "), issueLabel: notUp.join("; "),
      actionLabel: t("signals.externalEngines.action", lang),
      actionHref: "/dashboard/settings?section=llm&tab=providers",
    };
  }
  return { id: "externalEngines", severity: null, state: "ok", label, value: lines.join(" · ") };
}

// Published ports (plan PR S5a) — the audit behind the engine fence. Reads ONE
// JSON file (see published-ports.js): never iptables, so this signal cannot hang
// on a wedged firewall and cannot change anything. A tailnet-address publish is
// INFO only with the interface-pinned raw rule in the snapshot; anything
// unfenced is a WARN per (container, port); loopback is silent; a snapshot that
// cannot be read is "unknown" (info), never ok-looking.
//
// With NO snapshot at all — the ordinary default install, where the card used to
// read "unknown — no fence snapshot" forever (audit N1c-17) — it asks Docker for
// the published ports it already reports on the nest home screen (bounded
// `docker ps`, no root, no sudo). Only the missing-file case: a snapshot that
// EXISTS but cannot be read is the fence's problem, not Docker's.
const PUBLISHED_PORTS_CODE_KEYS = {
  wildcard: "signals.publishedPorts.wildcard",
  "empty-host": "signals.publishedPorts.emptyHost",
  bridge: "signals.publishedPorts.bridge",
  lan: "signals.publishedPorts.lan",
  unfenced: "signals.publishedPorts.unfenced",
  "fence-unknown": "signals.publishedPorts.fenceUnknown",
  "address-mismatch": "signals.publishedPorts.addressMismatch",
  "unknown-host": "signals.publishedPorts.unknownHost",
  "unfenced-protocol": "signals.publishedPorts.unfencedProtocol",
  "host-network-engine": "signals.publishedPorts.hostNetworkEngine",
  "host-network": "signals.publishedPorts.hostNetwork",
};

const PUBLISHED_PORTS_BLIND_KEYS = {
  "host-network": "signals.publishedPorts.blindHostNetwork",
  "userland-proxy-false": "signals.publishedPorts.blindUserlandProxy",
  "rootless-or-podman": "signals.publishedPorts.blindRootless",
  "other-netns": "signals.publishedPorts.blindNetns",
};

// The no-snapshot fallback: the same bounded `docker ps` the nest home screen
// already runs (data-queries.js) — no root, no sudo, no iptables. Injectable so
// no test depends on the Docker state of the machine it runs on.
const DOCKER_PS_TIMEOUT_MS = 5000;
const defaultDockerPortsReader = () => execFileSync("docker", ["ps", "--format", "{{.Ports}}"], {
  encoding: "utf-8", timeout: DOCKER_PS_TIMEOUT_MS,
});
let _dockerPortsReader = defaultDockerPortsReader;
/** Test seam: replace the `docker ps` reader (returns its stdout); null restores the real one. */
export function _setDockerPortsReader(fn) { _dockerPortsReader = fn || defaultDockerPortsReader; }

/**
 * What Docker publishes, without root: { known, beyond, total }. `known:false`
 * means the daemon or CLI could not be read (the card then keeps "unknown").
 */
function dockerPublishedPorts() {
  let out;
  try {
    out = _dockerPortsReader();
  } catch {
    return { known: false, beyond: [], total: 0 };
  }
  const all = parseDockerPsPorts(out);
  return { known: true, beyond: all.filter((p) => p.kind !== "loopback"), total: all.length };
}

async function publishedPortsSignal(db, lang, nowFn, opts = {}) {
  const label = t("signals.publishedPorts.label", lang);
  const action = {
    actionLabel: t("signals.publishedPorts.action", lang),
    actionHref: "/dashboard/extensions",
  };

  // The operator's allowlist is a LOCAL setting (never synced): a malformed or
  // unreadable value can only make the audit stricter, never hide a publish.
  let allowlist = [];
  try {
    allowlist = parseAllowlistSetting(await readSetting(db, PUBLISHED_PORTS_ALLOWLIST_KEY));
  } catch {}

  let audit;
  try {
    // `opts.inspect` is a test seam only (a throwing inspector must degrade to
    // 'off' like every other signal, never escape).
    const inspect = typeof opts.inspect === "function" ? opts.inspect : inspectPublishedPorts;
    audit = inspect({
      nowMs: nowFn(),
      snapshotPath: opts.snapshotPath,
      readFile: opts.readFile,
      allowlist,
      repoBundlesDir: opts.repoBundlesDir,
      installedBundlesDir: opts.installedBundlesDir,
    });
  } catch {
    return {
      id: "publishedPorts", severity: null, state: "off", label,
      value: t("signals.publishedPorts.off", lang),
    };
  }

  // M4: name the shapes this audit could not inspect, in the signal's own output.
  const blindList = (audit.blindSpots || [])
    .filter((b) => !b.inspected)
    .map((b) => t(PUBLISHED_PORTS_BLIND_KEYS[b.code] || b.code, lang))
    .join(", ");
  const withBlind = (value) => (blindList
    ? `${value} · ${fill(t("signals.publishedPorts.blind", lang), { list: blindList })}`
    : value);

  if (!audit.hasRows) {
    // No fence snapshot at all = the default install. Ask Docker rather than
    // report "unknown" on every install forever (audit N1c-17). A snapshot that
    // exists but cannot be read keeps "unknown" — that is the fence's problem.
    const probe = audit.status === "missing" ? dockerPublishedPorts() : { known: false, beyond: [], total: 0 };
    if (probe.known && probe.beyond.length > 0) {
      const shown = probe.beyond.slice(0, 5).map((p) => `${p.port}/${p.proto}`).join(", ");
      const rest = probe.beyond.length - Math.min(5, probe.beyond.length);
      return {
        id: "publishedPorts", severity: "warn", state: "warn", label,
        value: withBlind(fill(t("signals.publishedPorts.unfencedDockerValue", lang), {
          n: probe.beyond.length,
          list: rest > 0 ? `${shown} +${rest}` : shown,
        })),
        issueLabel: t("signals.publishedPorts.unfencedDocker", lang),
        actionLabel: t("signals.publishedPorts.fenceAction", lang),
        actionHref: docsUrl("guide/engine-fence"),
      };
    }
    if (probe.known) {
      return {
        id: "publishedPorts", severity: "info", state: "info", label,
        value: withBlind(t("signals.publishedPorts.noDockerPorts", lang)),
        issueLabel: t("signals.publishedPorts.noDockerPortsWhy", lang),
        actionLabel: t("signals.publishedPorts.fenceAction", lang),
        actionHref: docsUrl("guide/engine-fence"),
      };
    }
    // Missing / unreadable / malformed snapshot AND Docker not readable either:
    // "unknown" is the whole answer — info, never a warn.
    return {
      id: "publishedPorts", severity: "info", state: "info", label,
      value: withBlind(t("signals.publishedPorts.unknown", lang)),
      issueLabel: fill(t("signals.publishedPorts.unknownWhy", lang), { reason: audit.status }),
    };
  }

  const issues = [];
  let warnCount = 0;
  // Three separate counts: a publish that carries a real fence rule, one the
  // operator (or a first-party manifest) allowlisted, and everything else.
  // Only the first is ever called "fenced".
  let fencedCount = 0;
  let allowlistedCount = 0;

  // One issue per (container, port) — the id the plan names — so a v4 and a v6
  // binding on the same port cannot produce two issues under one id. A warn
  // always wins over an info for the same id.
  const byId = new Map();
  for (const p of audit.publishes) {
    const prev = byId.get(p.id);
    if (!prev || (prev.severity !== "warn" && p.severity === "warn")) byId.set(p.id, p);
  }

  for (const p of byId.values()) {
    const vars = {
      name: p.name || String(p.containerId || "container").slice(0, 12),
      port: p.port ?? "?",
      addr: p.hostIp || (p.kind === "empty" ? "0.0.0.0" : "?"),
      proto: p.proto || "?",
      kind: p.fenced === "port-only"
        ? t("signals.publishedPorts.kindPortOnly", lang)
        : t("signals.publishedPorts.kindAddressed", lang),
    };
    if (p.severity === "warn") {
      warnCount++;
      const key = PUBLISHED_PORTS_CODE_KEYS[p.code] || PUBLISHED_PORTS_CODE_KEYS["unknown-host"];
      issues.push({
        id: p.id, severity: "warn", state: "warn", issueOnly: true, label,
        issueLabel: fill(t(key, lang), vars), ...action,
      });
    } else {
      // Allowlisted, fenced and host-network entries are listed, never hidden.
      // The message follows the entry's OWN code: a host-network container
      // publishes no port, so it has no rule to describe and must never be
      // rendered as fenced.
      let key;
      if (p.code === "allowlisted") {
        key = "signals.publishedPorts.infoAllowlisted";
        allowlistedCount++;
      } else if (p.code === "host-network" || p.code === "host-network-engine") {
        key = "signals.publishedPorts.hostNetwork";
      } else {
        key = "signals.publishedPorts.infoFenced";
      }
      // …and only an entry that actually carries a fence rule joins the
      // "fenced" count: an allowlisted publish, a host-network entry and the
      // docker-version note are not fenced.
      if (p.code === "fenced" || p.code === "fenced-port-only") fencedCount++;
      issues.push({
        id: p.id, severity: "info", state: "info", issueOnly: true, label,
        issueLabel: fill(t(key, lang), vars), ...action,
      });
    }
  }

  // Docker floor (shared constant with the engine-bind rules, PR S3).
  if (audit.docker.belowFloor === true) {
    warnCount++;
    issues.push({
      id: "published-ports:docker-floor", severity: "warn", state: "warn", issueOnly: true, label,
      issueLabel: fill(t("signals.publishedPorts.dockerFloor", lang), {
        version: audit.docker.version, floor: DOCKER_FLOOR,
      }), ...action,
    });
  } else if (audit.docker.belowFloor === null) {
    // Not "fenced" and not a review item: an unreadable Docker version is
    // listed on its own, and never joins either count.
    issues.push({
      id: "published-ports:docker-version", severity: "info", state: "info", issueOnly: true, label,
      issueLabel: t("signals.publishedPorts.dockerUnknown", lang), ...action,
    });
  }

  // M4: a saved-facts / conf / docker-flags hash mismatch means the boot apply
  // would refuse until the operator re-checks the fence.
  if ((audit.fence.hashMismatch || []).length > 0) {
    warnCount++;
    issues.push({
      id: "published-ports:fence-hashes", severity: "warn", state: "warn", issueOnly: true, label,
      issueLabel: fill(t("signals.publishedPorts.hashMismatch", lang), {
        changes: audit.fence.hashMismatch.join(", "),
      }), ...action,
    });
  }

  const parts = [];
  if (!audit.trusted && audit.ageMs != null) {
    // A future-dated snapshot has a negative age: print "in the future", never
    // a negative number of minutes.
    parts.push(audit.ageMs < 0
      ? t("signals.publishedPorts.futureValue", lang)
      : fill(t("signals.publishedPorts.staleValue", lang), { age: formatAge(audit.ageMs) }));
  }
  if (warnCount > 0) parts.push(fill(t("signals.publishedPorts.review", lang), { n: warnCount }));
  // An allowlisted publish got there by the operator's decision or a
  // first-party manifest — not by a fence rule — so it gets its own count.
  if (allowlistedCount > 0) parts.push(fill(t("signals.publishedPorts.allowlistedCount", lang), { n: allowlistedCount }));
  if (fencedCount > 0) parts.push(fill(t("signals.publishedPorts.fenced", lang), { n: fencedCount }));
  const value = withBlind(parts.length
    ? parts.join(" · ")
    : t(issues.length ? "signals.publishedPorts.listed" : "signals.publishedPorts.ok", lang));

  const state = warnCount > 0 ? "warn" : parts.length || issues.length ? "info" : "ok";
  const card = {
    id: "publishedPorts",
    severity: state === "ok" ? null : state,
    state,
    cardOnly: issues.length > 0, // per-publish issues carry the detail
    label,
    value,
  };
  return issues.length ? [card, ...issues] : card;
}

// ─── Bundle images (audit N1c-7) ─────────────────────────────────────────────
// Every bundle now pins its image tag, so an installed bundle keeps the release
// it installed with until the owner reinstalls — an image can age for years with
// no card saying so. Two bounded exec calls answer it: a `docker ps` (no root)
// that maps running containers to installed bundle directories, then ONE
// `docker image inspect` for the distinct images. Both carry a hard timeout, so
// a wedged daemon can never hold the nest render.
//
// INFO ONLY, on purpose: an old image is a fact for the owner to judge (their
// NAS image being 100 days old may be exactly what they want). Only a signal
// that cannot read Docker WHILE DOCKER EXISTS says "unknown" — and that is info
// too, never ok. No `docker` binary at all is not a failure to report: a host
// with only MCP-style bundles never needs it (see the ENOENT branches below).
const BUNDLE_IMAGES_TIMEOUT_MS = 5000;

const defaultBundleContainersReader = () => execFileSync("docker", ["ps", "--format", BUNDLE_PS_FORMAT], {
  encoding: "utf-8", timeout: BUNDLE_IMAGES_TIMEOUT_MS,
});

// One call for every image: an inspect per image would be one timeout each on a
// host where Docker is hung. `--` ends the option list, so an image name that
// starts with `-` can never be read as a flag.
const defaultBundleImageCreatedReader = (images) => execFileSync("docker", [
  "image", "inspect", "--format", "{{.Created}}", "--", ...images,
], { encoding: "utf-8", timeout: BUNDLE_IMAGES_TIMEOUT_MS });

let _bundleContainersReader = defaultBundleContainersReader;
let _bundleImageCreatedReader = defaultBundleImageCreatedReader;
let _installedBundleIdsReader = () => readInstalledBundleIds();

/** Test seams: any subset of { containers, created, installed }; omitted ones stay as they are. */
export function _setBundleImageReaders({ containers, created, installed } = {}) {
  if (containers !== undefined) _bundleContainersReader = containers || defaultBundleContainersReader;
  if (created !== undefined) _bundleImageCreatedReader = created || defaultBundleImageCreatedReader;
  if (installed !== undefined) _installedBundleIdsReader = installed || (() => readInstalledBundleIds());
}

async function bundleImagesSignal(lang, nowFn) {
  const label = t("signals.bundleImages.label", lang);
  const action = {
    actionLabel: t("signals.bundleImages.action", lang),
    actionHref: "/dashboard/extensions",
  };
  const unknown = (reason) => ({
    id: "bundleImages", severity: "info", state: "info", label,
    value: t("signals.bundleImages.unknown", lang),
    issueLabel: fill(t("signals.bundleImages.unknownWhy", lang), { reason }),
    ...action,
  });

  let installedIds = [];
  try { installedIds = _installedBundleIdsReader() || []; } catch { installedIds = []; }
  if (installedIds.length === 0) return null; // nothing installed → nothing to age

  let containersOut;
  try {
    containersOut = _bundleContainersReader();
  } catch (err) {
    // No docker binary → no card at all. Nothing is aged, and an owner who never
    // installed a container bundle should not be shown a permanent "unknown".
    if (err?.code === "ENOENT") return null;
    return unknown(t("signals.bundleImages.reasonDocker", lang));
  }

  const images = parseRunningBundleImages(containersOut, { installedIds });
  if (images.length === 0) {
    // Installed, but no bundle container is running: nothing is aged by an image.
    return { id: "bundleImages", severity: null, state: "ok", label, value: t("signals.bundleImages.ok", lang) };
  }

  const names = [...new Set(images.map((i) => i.image))];
  let created;
  try {
    created = parseImageCreated(_bundleImageCreatedReader(names), names);
  } catch (err) {
    // Same as above: the binary disappearing is not a signal worth a card.
    if (err?.code === "ENOENT") return null;
    return unknown(t("signals.bundleImages.reasonInspect", lang));
  }
  // No creation time for ANY image is a failed read, not a young image.
  if (created.size === 0) return unknown(t("signals.bundleImages.reasonInspect", lang));

  const { old } = bundleImageAges({ images, created, nowMs: nowFn() });
  if (old.length === 0) {
    return { id: "bundleImages", severity: null, state: "ok", label, value: t("signals.bundleImages.ok", lang) };
  }

  // Card for the strip + one issue per bundle, so each line carries its OWN link
  // to that bundle's page (the Extensions search box) and its own dedupe id.
  return [
    {
      id: "bundleImages", severity: "info", state: "info", cardOnly: true, label,
      value: fill(t("signals.bundleImages.count", lang), { n: old.length }),
    },
    ...old.map((o) => ({
      id: `bundleImages:${o.bundleId}`, severity: "info", state: "info", issueOnly: true, label,
      issueLabel: fill(t("signals.bundleImages.old", lang), { name: o.bundleId, days: o.days }),
      actionLabel: action.actionLabel,
      actionHref: `/dashboard/extensions?q=${encodeURIComponent(o.bundleId)}`,
    })),
  ];
}

// ─── System updates (security audit K6) ──────────────────────────────────────
// The installer turns on unattended-upgrades for the OS plus the NodeSource,
// Docker and Caddy repositories, with automatic reboots OFF. This card says how
// current that leaves the box: a reboot still owed, whether the daily run is
// still on, and when it last ran (a stamp older than three days means the timer
// stopped, which is exactly the state nothing used to report).
//
// Rootless and read-only: three file reads and ONE bounded `docker version`. The
// versions are information about what is installed — never a lookup of "latest",
// which would need the network and a privacy decision this card must not make.
// Outside the Debian/Ubuntu family there is no apt, and inside a container these
// files describe the image rather than the host, so the signal returns no card.
// A check that cannot run is at most info and NAMES itself — never ok.
export const APT_CONF_DIR = "/etc/apt/apt.conf.d";
export const AUTO_UPGRADES_CONF = "20auto-upgrades";
// apt reads a file in apt.conf.d when its name is [A-Za-z0-9_.-] and either
// carries no dot at all (`20auto-upgrades`) or ends in `.conf` (`99-local.conf`).
// Anything else is not a setting apt would load: a subdirectory, a
// `99-local.conf.bak` (a `.conf`-suffixed name is still not one), `.dpkg-old`.
const APT_CONF_NAME_RE = /^(?:[A-Za-z0-9_-]+|[A-Za-z0-9_.-]*\.conf)$/;
export const REBOOT_REQUIRED_PATH = "/var/run/reboot-required";
export const REBOOT_PKGS_PATH = "/var/run/reboot-required.pkgs";
export const UNATTENDED_STAMP_PATH = "/var/lib/apt/periodic/unattended-upgrades-stamp";
export const UNATTENDED_LOG_PATH = "/var/log/unattended-upgrades/unattended-upgrades.log";
// Three days: the daily timer runs once, so one missed day is a late run and
// two in a row means something is wrong (a stopped timer, a broken hook).
export const UPDATES_STALE_DAYS = 3;
const SYSTEM_UPDATES_EXEC_TIMEOUT_MS = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

const defaultAptPresenceReader = () => existsSync("/etc/apt");
const defaultAptConfListReader = (dir) => readdirSync(dir);
const defaultUpdatesExistsReader = (p) => existsSync(p);
const defaultUpdatesStatReader = (p) => statSync(p).mtimeMs;
const defaultUpdatesFileReader = (p) => readFileSync(p, "utf-8");
const defaultUpdatesDockerVersionReader = () => execFileSync(
  "docker", ["version", "--format", "{{.Server.Version}}"],
  { encoding: "utf-8", timeout: SYSTEM_UPDATES_EXEC_TIMEOUT_MS },
);

let _aptPresenceReader = defaultAptPresenceReader;
let _aptConfListReader = defaultAptConfListReader;
let _updatesExistsReader = defaultUpdatesExistsReader;
let _updatesStatReader = defaultUpdatesStatReader;
let _updatesFileReader = defaultUpdatesFileReader;
let _updatesDockerVersionReader = defaultUpdatesDockerVersionReader;

/** Test seams for the systemUpdates signal: any subset; omitted ones stay as they are. */
export function _setSystemUpdateReaders({ aptPresent, listConfDir, exists, stat, readFile, dockerVersion } = {}) {
  if (aptPresent !== undefined) _aptPresenceReader = aptPresent || defaultAptPresenceReader;
  if (listConfDir !== undefined) _aptConfListReader = listConfDir || defaultAptConfListReader;
  if (exists !== undefined) _updatesExistsReader = exists || defaultUpdatesExistsReader;
  if (stat !== undefined) _updatesStatReader = stat || defaultUpdatesStatReader;
  if (readFile !== undefined) _updatesFileReader = readFile || defaultUpdatesFileReader;
  if (dockerVersion !== undefined) _updatesDockerVersionReader = dockerVersion || defaultUpdatesDockerVersionReader;
}

/** The guide section that explains all of this (and how to turn it off). */
export function systemUpdatesDocsHref(lang = "en") {
  return docsUrl((lang === "es" ? "es/" : "") + "guide/auto-update") + "#system-updates";
}

/**
 * The daily-unattended-upgrade switch as unattended-upgrades ends up seeing it:
 * apt.conf comments removed, the LAST assignment winning (apt(5): a later value
 * replaces an earlier one), and a value of 1 or more meaning "on". Returns null
 * when the file says nothing about it.
 */
function unattendedUpgradeSwitch(text) {
  const stripped = String(text ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, " ") // /* block comments */
    .replace(/\/\/[^\n]*/g, " ");        // // line comments
  const re = /^\s*APT::Periodic::Unattended-Upgrade\s+"?(\d+)"?\s*;/gm;
  let last = null;
  for (const m of stripped.matchAll(re)) last = Number(m[1]);
  return last;
}

async function systemUpdatesSignal(lang, nowFn) {
  // Not apt's machine: nothing to report rather than a permanent red card on
  // every non-Debian host, container image or Docker install.
  if (isRunningInContainer()) return null;
  let aptPresent = false;
  try {
    aptPresent = !!_aptPresenceReader();
  } catch {
    aptPresent = false;
  }
  if (!aptPresent) return null;

  const label = t("signals.systemUpdates.label", lang);
  const now = nowFn();
  const problems = []; // warn: a reboot owed, or a run long overdue
  const notYet = [];   // info: the timer is on but has never run
  const infos = [];    // info: the timer is off
  const unknowns = []; // checks that could not run — at most info, never ok

  // (a) A reboot owed. The installer never reboots, so this is the operator's
  // call, with the packages that asked for it when the list is readable.
  let rebootNeeded = null;
  try {
    rebootNeeded = !!_updatesExistsReader(REBOOT_REQUIRED_PATH);
  } catch {
    unknowns.push(t("signals.systemUpdates.checkReboot", lang));
  }
  if (rebootNeeded === true) {
    let packages = [];
    try {
      packages = String(_updatesFileReader(REBOOT_PKGS_PATH) ?? "")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 10); // package names only, capped: this line goes to a notification
    } catch {} // the packages file is optional
    const text = packages.length
      ? fill(t("signals.systemUpdates.rebootNeededPkgs", lang), { packages: packages.join(", ") })
      : t("signals.systemUpdates.rebootNeeded", lang);
    problems.push({ kind: "reboot", text, issue: text });
  }

  // (b) Is the daily run still on? apt reads EVERY file in apt.conf.d in name
  // order and the last assignment wins, so read them all: an operator turning
  // this off may use a later file, and a commented-out line is not a setting.
  let autoOn = null;
  let switchSeen = false;
  let confUnreadable = false;
  let confFiles = [];
  try {
    confFiles = _aptConfListReader(APT_CONF_DIR).filter((f) => APT_CONF_NAME_RE.test(f)).sort();
  } catch {
    confUnreadable = true;
  }
  if (!confUnreadable) {
    for (const file of confFiles) {
      let value = null;
      try {
        value = unattendedUpgradeSwitch(_updatesFileReader(join(APT_CONF_DIR, file)));
      } catch {
        // apt would read this file and we cannot: the switch is unknown.
        confUnreadable = true;
        continue;
      }
      if (value !== null) {
        autoOn = value >= 1;
        switchSeen = true;
      }
    }
  }
  if (confUnreadable) {
    unknowns.push(t("signals.systemUpdates.checkAuto", lang));
  } else if (!switchSeen) {
    autoOn = false; // nothing in apt.conf.d switches the daily run on
  }

  if (autoOn === false) {
    infos.push({
      text: t("signals.systemUpdates.autoOff", lang),
      issue: t("signals.systemUpdates.autoOffIssue", lang),
      action: true,
    });
  }

  // (c) When did it last run? Only meaningful while the timer is on.
  let lastRunMs = null;
  let lastRunKnown = false;
  if (autoOn === true) {
    let statError = null;
    for (const p of [UNATTENDED_STAMP_PATH, UNATTENDED_LOG_PATH]) {
      try {
        const m = _updatesStatReader(p);
        if (Number.isFinite(m)) {
          lastRunMs = m;
          lastRunKnown = true;
          break;
        }
      } catch (err) {
        statError = err; // keep the error: ENOENT and EACCES mean different things
      }
    }
    if (!lastRunKnown) {
      // No stamp and no log. Missing files are a fresh install (the daily run
      // has not come round yet), not a check Crow could not run; any other read
      // failure is a real unknown. Either way it is not "current".
      if (statError && statError.code !== "ENOENT") {
        unknowns.push(t("signals.systemUpdates.checkLastRun", lang));
      } else {
        notYet.push({
          text: t("signals.systemUpdates.notRunYet", lang),
          issue: t("signals.systemUpdates.notRunYetIssue", lang),
        });
      }
    } else {
      const days = Math.floor((now - lastRunMs) / DAY_MS);
      if (days >= UPDATES_STALE_DAYS) {
        problems.push({
          kind: "stale",
          text: fill(t("signals.systemUpdates.staleRun", lang), { days }),
          issue: fill(t("signals.systemUpdates.staleRunIssue", lang), { days }),
        });
      }
    }
  }

  // (d) What is installed, as information only. A version is not a promise:
  // looking up the newest release would need the network, so this never does.
  const nodeVersion = process.version.replace(/^v/, "");
  let dockerVersion = null;
  let dockerMissing = false;
  try {
    dockerVersion = String(_updatesDockerVersionReader() ?? "").trim() || null;
  } catch (err) {
    // A box without Docker is a legitimate state, not a failed check: only a
    // Docker that exists and cannot answer is an unknown, or the card could
    // never reach ok here.
    dockerMissing = err?.code === "ENOENT";
    dockerVersion = null;
  }
  if (!dockerVersion && !dockerMissing) unknowns.push(t("signals.systemUpdates.checkDocker", lang));
  const versionsLine = fill(t("signals.systemUpdates.versions", lang), {
    node: nodeVersion,
    docker: dockerVersion
      || t(dockerMissing ? "signals.systemUpdates.dockerNotInstalled" : "signals.systemUpdates.dockerUnknown", lang),
  });

  const lines = [...problems.map((p) => p.text), ...notYet.map((n) => n.text), ...infos.map((i) => i.text)];
  if (unknowns.length > 0) {
    lines.push(fill(t("signals.systemUpdates.unknown", lang), { list: unknowns.join(", ") }));
  }
  lines.push(versionsLine);

  const state = problems.length > 0
    ? "warn"
    : (notYet.length + infos.length + unknowns.length > 0 ? "info" : "ok");
  // "current" is a claim, so it is only made when every check actually ran.
  if (state === "ok") lines.unshift(t("signals.systemUpdates.ok", lang));
  const card = {
    id: "systemUpdates",
    severity: state === "ok" ? null : state,
    state,
    label,
    value: lines.join(" · "),
  };
  if (state === "ok") return card;

  // One issue per subject, each with its own id: the health monitor dedupes
  // pushes per id for 24 h, so a reboot warning must not swallow a stale-run
  // warning (or the other way round). The card itself is display only.
  const entries = [];
  for (const p of problems) {
    entries.push({
      id: `systemUpdates:${p.kind}`, severity: "warn", state: "warn",
      label, issueLabel: p.issue,
    });
  }
  for (const n of notYet) {
    entries.push({
      id: "systemUpdates:pending", severity: "info", state: "info",
      label, issueLabel: n.issue,
    });
  }
  if (infos.length > 0) {
    entries.push({
      id: "systemUpdates:off", severity: "info", state: "info",
      label, issueLabel: infos[0].issue,
      // Automatic updates off is the one actionable state, so it links to the
      // guide section that explains what is off and how to turn it back on.
      actionLabel: t("signals.systemUpdates.action", lang),
      actionHref: systemUpdatesDocsHref(lang),
    });
  }
  if (unknowns.length > 0) {
    entries.push({
      id: "systemUpdates:check", severity: "info", state: "info",
      label,
      issueLabel: fill(t("signals.systemUpdates.unknownIssue", lang), { list: unknowns.join(", ") }),
    });
  }
  return [{ ...card, cardOnly: true }, ...entries.map((e) => ({ ...e, issueOnly: true }))];
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Collect all health signals.
 *
 * @param {object} db      libsql client
 * @param {object} [opts]
 * @param {function} [opts.now]  Injectable clock: () => number (ms since epoch)
 * @param {string} [opts.lang]
 * @param {object} [opts.publishedPorts]  test seams for the publishedPorts signal:
 *   { snapshotPath, readFile, repoBundlesDir, installedBundlesDir, inspect }
 * @param {string} [opts.bind]  test seam: the gateway's listen host (otherwise
 *   read from listen-host.js, the same expression index.js binds with)
 * @param {number} [opts.uptimeMs]  test seam for the Updates card: how long this
 *   gateway process has been up (otherwise process.uptime())
 * @param {boolean} [opts.noAuth]  test seam for the Updates card: the gateway's
 *   --no-auth flag (otherwise read from process.argv, like exposureSignal)
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
    peersSignal(db, lang, nowFn),
    syncDialSignal(db, lang, nowFn),
    Promise.resolve().then(() => peerTrustSignal(lang, nowFn)),
    updatesSignal(db, nowFn, { lang, uptimeMs: opts.uptimeMs, noAuth: opts.noAuth }),
    backupSignal(db, nowFn, lang),
    keychainExportSignal(db, lang),
    syncConflictsSignal(db),
    outboxSignal(db),
    loginsSignal(db, lang),
    exposureSignal(db, lang, nowFn, { bind: opts.bind }),
    integrationsSignal(db, lang),
    federationAuditSignal(lang),
    messagesSignal(db, lang, nowFn),
    providersSignal(lang, nowFn),
    externalEnginesSignal(lang, nowFn),
    // Deferred so a throwing reader lands in the per-signal catch below
    // instead of escaping the array literal (review M8).
    Promise.resolve().then(() => reservationSignal(lang, nowFn)),
    Promise.resolve().then(() => publishedPortsSignal(db, lang, nowFn, opts.publishedPorts || {})),
    Promise.resolve().then(() => bundleImagesSignal(lang, nowFn)),
    Promise.resolve().then(() => systemUpdatesSignal(lang, nowFn)),
    artifactNodeSignal(lang),
    import("../../../satellites/nest-signals.js").then((m) => m.satellitesSignal(db, lang, nowFn)),
  ].map(p => Promise.resolve(p).catch(err => ({
    id: "unknown",
    severity: null,
    state: "off",
    label: "Unknown",
    value: "error",
    _err: err?.message,
  }))));

  // A signal may opt out by returning null (externalEngines when nothing is watched).
  // A signal may also return an ARRAY: one card plus per-subject issue
  // entries (issueOnly: true — an issue, not a card), e.g. one unreachable
  // peer per issue id so each peer gets its own 24 h push window.
  const present = rawSignals.flat().filter(Boolean);
  const details = present.filter(s => !s.issueOnly).map(s => ({
    id: s.id,
    label: s.label,
    value: s.value,
    state: s.state ?? "off",
  }));

  const issues = present
    .filter(s => !s.cardOnly && (s.state === "warn" || s.state === "info"))
    .map(s => ({
      id: s.id,
      severity: s.severity ?? s.state,
      label: s.issueLabel ?? s.label,
      actionLabel: s.actionLabel ?? null,
      actionHref: s.actionHref ?? null,
      ack: s.ack ?? null,
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

/**
 * boot/bot-identity-notice.js — the BELL for "Bots can't read Crow's identity
 * file" (item-70 channel 3).
 *
 * The boot check (scripts/pi-bots/bot-identity-guard.mjs) answers a yes/no
 * question about the sandbox plans, and its `[containment]` line goes to the
 * journal. A journal line is not where an operator looks: a host whose bot
 * sandbox stopped masking the master seed must reach the bell, the same way the
 * other instance security signals do (createNotification → the bell badge, web
 * push and this instance's ntfy topic; the health monitor's cycle is the model).
 *
 * So this module turns a FAILED check into one notification:
 *   - `type: "system"`, `source: "bot-identity"` (the row is findable by source),
 *     `priority: "high"`, and a link to the Bot Runtime settings section, which
 *     renders the same containment facts;
 *   - the body is the invariant, the findings, and — only when one of them came
 *     from a BOT'S PLAN — the one next step (`RESTART_HOSTS_HINT`: a host that
 *     runs bots from its own `pibot-gateways@*` units keeps the OLD bridge after
 *     an auto-update until those units restart). A host-tier finding
 *     (`CROW_PI_SANDBOX=off`, no bubblewrap, no PID namespace) carries no restart
 *     step, because restarting a bot host does not change the host's tier;
 *   - it never carries a file's content, only paths and reasons the check
 *     itself produced.
 *
 * No bots, no bell. A check that found no enabled bot (`noBots`) has nothing
 * that could read the seed: the guard records its "no bots" note and this module
 * sends nothing, so a host that runs no bots never rings for its sandbox tier.
 *
 * Dedupe without a new settings key (a `bot_*` dashboard_settings row would need
 * instance-scope registration and would sync like an ordinary setting): the
 * module reads the newest `source: "bot-identity"` notification and keeps the
 * finding signature in its own `metadata`. The same finding rings once, and
 * rings again after NOTICE_COOLDOWN_MS (24 h) — so a failure that came back
 * after a fix is still announced, without turning every boot into a nag. A pass
 * sends nothing.
 *
 * Never throws into the boot path.
 */
import { createNotification } from "../../shared/notifications.js";
import { t } from "../dashboard/shared/i18n.js";
import { BOT_IDENTITY_TEXT, RESTART_HOSTS_HINT, findingsFromPlans } from "../../../scripts/pi-bots/bot-identity-guard.mjs";

/** The notification source (queried for the dedupe row). */
export const NOTICE_SOURCE = "bot-identity";
export const NOTICE_TITLE_KEY = "notif.botIdentity.title";
export const NOTICE_BODY_KEY = "notif.botIdentity.body";
/** Settings → Bot Runtime shows the sandbox status and the containment list. */
export const NOTICE_ACTION_URL = "/dashboard/settings?section=bot-runtime";
/** Same findings within this window do not ring again. */
export const NOTICE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** The stable identity of one FAILED check: its findings (or notes), joined. */
export function botIdentitySignature(result) {
  const r = result || {};
  const found = (Array.isArray(r.findings) ? r.findings : []).filter(Boolean);
  const why = found.length ? found : (Array.isArray(r.notes) ? r.notes : []).filter(Boolean);
  return why.join(" | ");
}

/** The newest bot-identity notification's `{signature, at}`, or null. */
async function lastNotice(db) {
  const res = await db.execute({
    sql: "SELECT metadata, created_at FROM notifications WHERE source = ? ORDER BY id DESC LIMIT 1",
    args: [NOTICE_SOURCE],
  });
  const row = (res && res.rows && res.rows[0]) || null;
  if (!row) return null;
  let signature = null;
  if (row.metadata) {
    try {
      const meta = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
      signature = meta && typeof meta.signature === "string" ? meta.signature : null;
    } catch { signature = null; }
  }
  const at = parseSqlTime(row.created_at);
  return { signature, at };
}

/** A SQLite timestamp (`datetime('now')`: "YYYY-MM-DD HH:MM:SS", UTC) as ms, or null. */
function parseSqlTime(s) {
  if (!s) return null;
  const raw = String(s);
  // datetime('now') is UTC but carries no zone; an already-zoned value keeps its own.
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw.replace(" ", "T") : raw.replace(" ", "T") + "Z";
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

async function readLanguage(db) {
  try {
    const res = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: ["language"] });
    return (res && res.rows && res.rows[0] && res.rows[0].value) || "en";
  } catch {
    return "en";
  }
}

/**
 * Raise (or skip) the bell for one check result.
 *
 * @param {object} o
 * @param {{execute: Function}} o.db the gateway's db client
 * @param {object} o.result the check's result (ok/findings/tierFindings/notes/noBots)
 * @param {Function} [o.notify] createNotification-shaped seam
 * @param {string} [o.lang] force a language (else dashboard_settings.language)
 * @param {number} [o.now] clock seam (ms)
 * @param {object} [o.log] console-shaped logger
 * @returns {Promise<{sent:boolean, reason:string}>}
 */
export async function notifyBotIdentityFailure({
  db,
  result,
  notify = createNotification,
  lang = null,
  now = () => Date.now(),
  log = console,
} = {}) {
  const r = result || {};
  // A pass says nothing: the journal line already says pass, and there is no
  // bell for "everything is fine".
  if (r.ok === true) return { sent: false, reason: "pass" };
  // No enabled bots: nothing can spawn, so nothing can read the seed. The guard
  // records its "no bots" note and this stays silent — a host that runs no bots
  // must not get a high-priority bell for its sandbox tier.
  if (r.noBots === true) return { sent: false, reason: "no-bots" };
  if (!db || typeof db.execute !== "function") return { sent: false, reason: "no-db" };

  const signature = botIdentitySignature(r);
  let last = null;
  try { last = await lastNotice(db); } catch (err) {
    // Cannot read the dedupe row: say nothing rather than ring on every boot?
    // No — a failed security check matters more than a duplicate, and the boot
    // check itself ran. Ring, and let the next boot try the dedupe again.
    log.warn("[bot-identity] could not read the last notice: " + (err && err.message ? err.message : String(err)));
  }
  if (last && last.signature === signature && last.at != null && now() - last.at < NOTICE_COOLDOWN_MS) {
    return { sent: false, reason: "already" };
  }

  const language = lang || (await readLanguage(db));
  const found = (Array.isArray(r.findings) ? r.findings : []).filter(Boolean);
  // The restart step belongs to a finding a bot's plan produced: a host-tier
  // finding is the operator's switch or the host itself, which a bot host's
  // restart does not change (the same rule as formatBotIdentityLine).
  const hint = findingsFromPlans(r).length ? " " + RESTART_HOSTS_HINT : "";
  const body = t(NOTICE_BODY_KEY, language) +
    (found.length ? " " + found.join("; ") : "") +
    hint;
  try {
    await notify(db, {
      title: t(NOTICE_TITLE_KEY, language),
      body,
      type: "system",
      source: NOTICE_SOURCE,
      priority: "high",
      action_url: NOTICE_ACTION_URL,
      metadata: { kind: "bot-identity", signature, invariant: BOT_IDENTITY_TEXT, findings: found },
    });
  } catch (err) {
    log.warn("[bot-identity] notice could not be sent: " + (err && err.message ? err.message : String(err)));
    return { sent: false, reason: "error" };
  }
  return { sent: true, reason: "sent" };
}
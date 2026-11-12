/**
 * Bot Builder — Safety tab: per-bot git access (PR C, tasks C1–C4).
 *
 * The card is its own <section> with its OWN small forms, appended AFTER the
 * Safety form's closing tag (editor.js → tab-safety.js): nested forms are
 * invalid HTML, and every one of these actions is a separate POST.
 *
 * "Git access is on" is a fact about the DISK, not about the definition: a key
 * dir under the instance's 0700 secrets dir (servers/shared/bot-git/store.js).
 * Nothing here writes pi_bot_defs — a bot can edit its own definition, so a def
 * flag would be bot-writable, while the secrets dir is a read-only tmpfs inside
 * every bot's sandbox. The owner's own POST is the only thing that creates or
 * removes a key, and it must come from this Crow's own password session
 * (isLocalPasswordSessionOn: never a peer-SSO session, never a request from
 * this machine itself, never a signed peer call).
 *
 * The state list below is evaluated in order, first match wins, and is
 * re-evaluated server-side by git_on: a button that was rendered on a host
 * that could not really do it (an older bubblewrap, a host with no
 * openssh-client, a bot that turns out to run in the contain tier) refuses
 * instead of creating a key nothing can protect or use. Every refusal is
 * fail-closed: no key dir is made, and the page says why.
 *
 * Operator ruling R13 (2026-11-12) is ACCEPTED for v1: every bot on this Crow
 * runs as the same Linux account, so a bot with a shell could, with effort,
 * reach another git-enabled bot's key through /proc. The card says so plainly,
 * above the key, before the owner adds it to a repo. The separate per-bot
 * users are a queued follow-up, not a promise made here.
 *
 * The contain-tier state (5) is DISPLAY ONLY. This gateway's
 * CROW_PI_CONTAIN_BOTS may differ from the env of the process that really
 * spawns bots, and a recorded level exists only in the spawning process, so a
 * card that says "available" for a bot that spawns contained only means git
 * does not work there — the enforcement is spawn-side (bot_git_spawn.mjs).
 *
 * Two owner-only flows run through this module's POSTs and hold their one
 * intermediate state in THIS process only (task C3's host confirm, task C4's
 * connection test):
 *
 *  - A host the owner wants to add is scanned first (ssh-keyscan, ssh.js), and
 *    what it answered is held under a random one-time nonce for 10 minutes. The
 *    page then shows every key with its SHA256 fingerprint and takes ONE
 *    Confirm POST per key. Nothing is trusted because a scan said so: the only
 *    thing that ever writes `confirmed_hosts` is that POST, and only when the
 *    fingerprint in it is one the scan really returned. A forged, expired or
 *    other-bot nonce, and any fingerprint that is not in the entry, are refused
 *    with the same sentence — a stale scan is never "almost right".
 *  - A connection test's outcome is held the same way for 5 minutes, so the
 *    redirect can carry a nonce instead of a sentence and the page renders the
 *    classified result (ssh.js's ok/denied/hostkey/timeout/busy) with the
 *    scrubbed excerpt. The test itself only ever runs against github.com or a
 *    host this bot has confirmed.
 *
 * Neither map is persisted: a restart forgets them, and the TTL keeps a scan
 * the owner walked away from from being confirmable much later. Both are
 * capped, oldest evicted, so a page refreshed in a loop cannot grow them.
 */
import { randomBytes } from "node:crypto";
import { escapeHtml } from "../../shared/components.js";
import { csrfInput } from "../../shared/csrf.js";
import { t, fill } from "../../shared/i18n.js";
import { card } from "./ui.js";
import { isLocalPasswordSessionOn } from "../../local-session.js";
import { containmentBots, currentProbe } from "../../settings/sections/bot-runtime.js";
import { isVoiceBotId } from "../../../../shared/voice-bot.js";
import { FINGERPRINT_RE, GITHUB_HOST, knownHostsName, normalizeHost } from "../../../../shared/bot-git/host-keys.js";
import { gitconfigText, noReplyEmail } from "../../../../shared/bot-git/identity.js";
import { botGitDirReal, gitAllowedForInstance, isSafeKeyPath, isValidGitBotId } from "../../../../shared/bot-git/paths.js";
import { keyscan, testConnection } from "../../../../shared/bot-git/ssh.js";
import {
  addConfirmedHost, botKeyStatus, generateBotKey, removeBotKey, removeConfirmedHost, sshToolsAvailable,
} from "../../../../shared/bot-git/store.js";
import { emitBotDefsChanged } from "./defs-changed.js";
import { countEnabledPiBots } from "../../../../../scripts/pi-bots/bot_git_spawn.mjs";
import { containSelected } from "../../../../../scripts/pi-bots/pi_contain.mjs";
import { LEVEL_CONTAINED, LEVEL_PARTLY } from "../../../../../scripts/pi-bots/containment-status.mjs";
import { piSandboxMode } from "../../../../../scripts/pi-bots/pi_sandbox.mjs";

/** A scan / test nonce: 16 random bytes, lower-case hex. */
const NONCE_RE = /^[0-9a-f]{32}$/;

/** How long a scanned host key may still be confirmed (C3). */
const SCAN_TTL_MS = 10 * 60 * 1000;
/** How long a connection test's result is shown (C4). */
const TEST_TTL_MS = 5 * 60 * 1000;
/** Live nonces kept per flow; past this the oldest is evicted. */
const NONCE_MAX = 20;

/**
 * The two nonce maps: a scan waiting to be confirmed, and a test result waiting
 * to be rendered. Both are this process's only, hold nothing secret (public host
 * keys, an already-scrubbed excerpt) and are dropped on expiry, on use, or when
 * the cap evicts them.
 */
const scanStore = new Map();
const testStore = new Map();

let nowMs = () => Date.now();

/** TEST ONLY: move the nonce clock. Call with null to restore the real one. */
export function _setNowForTest(fn) { nowMs = typeof fn === "function" ? fn : () => Date.now(); }

/** TEST ONLY: forget every live nonce and restore the clock. */
export function _resetGitActionsForTest() {
  scanStore.clear();
  testStore.clear();
  nowMs = () => Date.now();
}

/**
 * Store one entry under a fresh random nonce, evicting the oldest when the cap
 * is reached (Map keeps insertion order, so the first key IS the oldest).
 * @returns {string} the nonce
 */
function putNonce(store, entry) {
  while (store.size >= NONCE_MAX) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
  const nonce = randomBytes(16).toString("hex");
  store.set(nonce, entry);
  return nonce;
}

/**
 * The live entry a nonce names for THIS bot, or null. An expired entry is
 * dropped on sight; an entry that belongs to another bot is left alone (its own
 * page may still use it) and answering null keeps the refusal identical.
 */
function liveNonce(store, nonce, botId, ttl) {
  if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) return null;
  const entry = store.get(nonce);
  if (!entry) return null;
  if (!(nowMs() - entry.at < ttl)) { store.delete(nonce); return null; }
  return entry.botId === botId ? entry : null;
}

/** The sentences each state shows (C1's list, in order). */
const STATE_KEY = {
  no_bwrap: "botbuilder.gitNoBwrap",
  no_pidns: "botbuilder.gitNoPidns",
  old_bwrap: "botbuilder.gitOldBwrap",
  policy: "botbuilder.gitPolicy",
  no_tools: "botbuilder.gitNoTools",
  bad_path: "botbuilder.gitBadPath",
  contained: "botbuilder.gitContained",
  off: "botbuilder.gitOffLead",
};

/** The error code a refused git_on (or a host/test action) redirects with, per state. */
const STATE_ERROR = {
  no_bwrap: "git_no_bwrap",
  no_pidns: "git_no_pidns",
  old_bwrap: "git_old_bwrap",
  policy: "git_policy",
  no_tools: "git_no_tools",
  bad_path: "git_bad_path",
  contained: "git_contained",
  on: "git_already_on",
};

/** The git actions that need this bot's key to exist and be usable here (C3, C4). */
const ON_ONLY_ACTIONS = new Set(["git_host_scan", "git_host_confirm", "git_host_remove", "git_test"]);

// ---- test seam --------------------------------------------------------------
// One seam, for the one fact a test cannot control: whether this box has
// openssh-client. Everything else is either the section's own probe seam
// (_setHostBwrapProbeForTest, bot-runtime.js) or the real thing.
let sshTools = null;
/** TEST ONLY: replace sshToolsAvailable(). null restores the real check. */
export function _setSshToolsForTest(fn) { sshTools = typeof fn === "function" ? fn : null; }

function sshToolsOk() {
  try {
    const r = sshTools ? sshTools() : sshToolsAvailable();
    return !!(r && r.ok === true);
  } catch {
    return false;
  }
}

// The ssh probes' own seam: ssh-keyscan and ssh may not run in a test (no
// network, no openssh-client), so a test hands them an execFile stub exactly the
// way the A5 tests do. The real default is ssh.js's promisified execFile.
let sshExec = null;
/** TEST ONLY: replace the execFile the ssh probes run through. null restores it. */
export function _setSshExecForTest(fn) { sshExec = typeof fn === "function" ? fn : null; }

/** The `execFileImpl` option for keyscan/testConnection (nothing when not stubbed). */
function sshExecOpt() {
  return sshExec ? { execFileImpl: sshExec } : {};
}

/** The sandbox probe as three plain facts; a hostile seam is "no sandbox". */
function probeFacts() {
  try {
    const p = currentProbe() || {};
    // A probe without a pidns field means the full tier (pi_sandbox.mjs).
    return { ok: p.ok === true, pidns: p.pidns !== false, bindFd: p.bindFd === true };
  } catch {
    return { ok: false, pidns: false, bindFd: false };
  }
}

/** True when this process is told not to sandbox pi at all. */
function sandboxOff() {
  try { return piSandboxMode(process.env) === "off"; } catch { return false; }
}

/** Enabled pi bots on this instance — the count the R13 switch reads. */
async function enabledPiBotCount(db) {
  try {
    const r = await db.execute({ sql: "SELECT enabled, definition FROM pi_bot_defs", args: [] });
    return countEnabledPiBots((r && r.rows) || []);
  } catch {
    return 0;
  }
}

/**
 * Whether this bot runs in the contain tier, by either of the two things that
 * can say so: this process's own env (containSelected, what wrapPiSpawn reads)
 * and the last spawn's recorded level (bot-runtime.js's containmentBots).
 * Display only — see the header.
 */
async function inContainTier(db, botId) {
  try { if (containSelected(process.env, botId)) return true; } catch { /* no env answer */ }
  try {
    const bots = await containmentBots(db);
    const mine = (Array.isArray(bots) ? bots : []).find((b) => b && String(b.botId) === String(botId));
    return !!mine && (mine.level === LEVEL_CONTAINED || mine.level === LEVEL_PARTLY);
  } catch {
    return false;
  }
}

/**
 * The bot row's `created_at`, or null.
 *
 * C5 housekeeping, NOT a security boundary: a key dir whose `meta.json`
 * carries a different `created_at` than the row was made for an earlier bot
 * with the same (recycled) id, so the spawn side refuses it
 * (bot_git_spawn.mjs gitPreSpawn). `created_at` has one-second resolution and
 * crow.db is bot-writable in the default tier, so this only keeps the card
 * honest about a key git will not use.
 */
async function rowCreatedAt(db, botId) {
  try {
    const r = await db.execute({ sql: "SELECT created_at FROM pi_bot_defs WHERE bot_id=?", args: [botId] });
    const row = (r && r.rows && r.rows[0]) || null;
    return row && typeof row.created_at === "string" && row.created_at ? row.created_at : null;
  } catch {
    return null;
  }
}

/**
 * Whether this key dir was made for THIS bot row. A row with no readable
 * timestamp answers true: the spawn side refuses a two-unknown match on its own
 * (gitPreSpawn), and the card must not hide a working key because a read
 * failed.
 */
async function keyDirForThisRow(db, botId, status) {
  const rowAt = await rowCreatedAt(db, botId);
  if (!rowAt) return true;
  return status.createdAt === rowAt;
}

/**
 * The Git access state of one bot: `{state, status}`.
 *
 * `state` is one of "on", "off", "unknown" (no card at all) or a blocked state
 * whose i18n sentence says why (`STATE_KEY`). `status` is store.js's read-only
 * key status (never key material except the PUBLIC half).
 *
 * Never throws: a failed read is the "unknown" state, and the page then shows
 * no git card rather than a broken Safety tab.
 */
export async function gitAccessState({ db, botId } = {}) {
  try {
    if (!isValidGitBotId(botId)) return { state: "unknown", status: { on: false } };
    const status = botKeyStatus(botId);
    const probe = probeFacts();
    if (probe.ok !== true || sandboxOff()) return { state: "no_bwrap", status };
    if (probe.pidns !== true) return { state: "no_pidns", status };
    if (probe.bindFd !== true) return { state: "old_bwrap", status };
    const allowed = gitAllowedForInstance({ enabledPiBotCount: await enabledPiBotCount(db) });
    if (!allowed) return { state: "policy", status };
    if (!sshToolsOk()) return { state: "no_tools", status };
    // The key dir path goes into a shell string git runs (GIT_SSH_COMMAND):
    // a home folder with a space would disable git, so no key is made there.
    if (!isSafeKeyPath(botGitDirReal(botId))) return { state: "bad_path", status };
    if (await inContainTier(db, botId)) return { state: "contained", status };
    // A key dir left by an earlier bot with the same recycled id is not this
    // bot's key: the spawn side refuses it (created_at mismatch), so the card
    // must not claim git is on. Turning git on again replaces the stale dir,
    // because generateBotKey removes one made for another row first (C5).
    if (status.on && !(await keyDirForThisRow(db, botId, status))) return { state: "off", status };
    return { state: status.on ? "on" : "off", status };
  } catch {
    return { state: "unknown", status: { on: false } };
  }
}

/** Whether this request is the owner at this Crow (the same rule the Safety save uses). */
async function isOwner(db, req) {
  if (!req) return false;
  try { return (await isLocalPasswordSessionOn(db, req)) === true; } catch { return false; }
}

/** Every git form's hidden fields: the action, the bot, and the CSRF token. */
function formFields(req, botId, action, extra = "") {
  return `<input type="hidden" name="action" value="${escapeHtml(action)}">` +
    `<input type="hidden" name="bot_id" value="${escapeHtml(botId)}">` + csrfInput(req) + extra;
}

/** A POST form for one git action (never nested: the card is outside #btb-safety-form). */
function gitForm(req, botId, action, inner, extra = "") {
  return `<form method="POST" class="btb-form btb-git-form">${formFields(req, botId, action, extra)}${inner}</form>`;
}

function button(labelKey, lang, cls = "btb-btn btb-btn-sm") {
  return `<button type="submit" class="${cls}">${escapeHtml(t(labelKey, lang))}</button>`;
}

/** The Copy control: a plain button (not a submit), wired by COPY_SCRIPT. */
function copyButton(lang) {
  return `<button type="button" id="btb-git-copy" class="btb-btn btb-btn-sm btb-btn-sec">` +
    `${escapeHtml(t("botbuilder.gitCopy", lang))}</button>`;
}

/** The commit identity the bot's generated gitconfig will carry (identity.js). */
function commitIdentity({ displayName, botId }) {
  try {
    const cfg = gitconfigText({ displayName, botId });
    const name = /\tname = "(.*)"\n/.exec(cfg);
    const email = /\temail = (\S+)\n/.exec(cfg);
    return {
      // Unescape for DISPLAY only (git reads the escaped form): the value is
      // escaped again by escapeHtml where it is rendered.
      name: name ? name[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\") : String(displayName || botId),
      email: email ? email[1] : noReplyEmail({ botId }),
    };
  } catch {
    return { name: String(displayName || botId), email: noReplyEmail({ botId }) };
  }
}

/** The redirect notices the Safety tab renders inside the card. */
function noticeHtml(q, lang) {
  if (q && q.git === "off") {
    const fp = typeof q.fp === "string" && FINGERPRINT_RE.test(q.fp) ? q.fp : null;
    const text = fp ? fill(t("botbuilder.gitOffNotice", lang), { fp }) : t("botbuilder.gitOffNoticeNoFp", lang);
    return `<p class="btb-notice-ok" role="status" data-testid="git-notice">${escapeHtml(text)}</p>`;
  }
  if (q && q.git === "on") {
    return `<p class="btb-notice-ok" role="status" data-testid="git-notice">${escapeHtml(t("botbuilder.gitOnNotice", lang))}</p>`;
  }
  if (q && q.git === "host_added") {
    return `<p class="btb-notice-ok" role="status" data-testid="git-notice">${escapeHtml(t("botbuilder.gitHostAddedNotice", lang))}</p>`;
  }
  if (q && q.git === "host_removed") {
    return `<p class="btb-notice-ok" role="status" data-testid="git-notice">${escapeHtml(t("botbuilder.gitHostRemovedNotice", lang))}</p>`;
  }
  return "";
}

/**
 * The host part of an owner's input, lower-cased, port and brackets removed —
 * just enough to recognise the pinned host BEFORE normalizeHost refuses it.
 */
function hostNameOf(raw) {
  const s = String(raw == null ? "" : raw).trim().toLowerCase();
  if (!s) return "";
  if (s.startsWith("[")) return s.slice(1).split("]")[0];
  return s.split(":")[0];
}

/** True for `github.com` and anything under it: pinned, so never confirmable. */
function pinnedHostInput(raw) {
  const host = hostNameOf(raw);
  return host === GITHUB_HOST || host.endsWith("." + GITHUB_HOST);
}

/**
 * The host a connection test may run against: the pinned `github.com`, or a host
 * the owner confirmed FOR THIS BOT. Accepts what the card's own <select> posts —
 * `host`, `host:port` and known_hosts' `[host]:port` — and nothing else. A
 * refusal here happens BEFORE ssh runs (the A5 probe refuses the same set again;
 * this is the one that keeps the child process from starting at all).
 * `github.com` is recognised in any of those spellings, before normalizeHost —
 * which has to refuse the pinned host, because only the pinned keys are used for
 * it.
 *
 * @returns {{host: string, port: number}|null}
 */
function testTarget(raw, hosts) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return null;
  // The pinned host, whatever spelling of it the page (or a hand-made POST) used.
  if (/^\[?github\.com\]?(?::22)?$/i.test(s)) return { host: GITHUB_HOST, port: 22 };
  let cand = null;
  const bracketed = /^\[([^\]]+)\]:(\d{1,5})$/.exec(s);
  if (bracketed) cand = normalizeHost(bracketed[1] + ":" + bracketed[2]);
  else cand = normalizeHost(s);
  if (!cand) return null;
  if (cand.host === GITHUB_HOST && cand.port === 22) return cand;
  const list = Array.isArray(hosts) ? hosts : [];
  return list.some((h) => h && h.host === cand.host && Number(h.port) === cand.port) ? cand : null;
}

/** The sentence each classified test result gets (ssh.js's own result set). */
const TEST_KEY = {
  ok: "botbuilder.gitTestOk",
  denied: "botbuilder.gitTestDenied",
  hostkey: "botbuilder.gitTestHostkey",
  timeout: "botbuilder.gitTestTimeout",
  busy: "botbuilder.gitTestBusy",
  refused: "botbuilder.gitTestRefused",
  failed: "botbuilder.gitTestFailed",
};

/**
 * The first-use confirm block (C3): what the host answered, one Confirm form per
 * key, the check-whoever-runs-it sentence, and Cancel. Every value shown came
 * from the stored scan entry and is escaped again here; the forms carry the
 * nonce and the fingerprint, never a host or a key — the server takes those from
 * the entry it holds.
 */
function scanBlock({ scan, nonce, req, botId, lang }) {
  const name = knownHostsName({ host: scan.host, port: scan.port });
  const rows = (Array.isArray(scan.keys) ? scan.keys : []).map((k) => {
    if (!k || typeof k.type !== "string") return "";
    const fp = typeof k.fingerprint === "string" && FINGERPRINT_RE.test(k.fingerprint) ? k.fingerprint : null;
    if (!fp) return "";
    return `<li data-testid="git-scan-key"><code>${escapeHtml(k.type)}</code> ` +
      `<code data-testid="git-scan-fp">${escapeHtml(fp)}</code> ` +
      gitForm(req, botId, "git_host_confirm", button("botbuilder.gitHostConfirmBtn", lang),
        `<input type="hidden" name="nonce" value="${escapeHtml(nonce)}">` +
        `<input type="hidden" name="fingerprint" value="${escapeHtml(fp)}">`) + `</li>`;
  }).join("");
  return `<div class="btb-git-scan" data-testid="git-scan">` +
    `<p class="btb-hint">${escapeHtml(fill(t("botbuilder.gitScanHost", lang), { host: name, port: String(scan.port) }))}</p>` +
    `<ul class="btb-git-hosts">${rows}</ul>` +
    `<p class="btb-hint btb-warn" data-testid="git-scan-check">${escapeHtml(t("botbuilder.gitScanCheck", lang))}</p>` +
    `<p><a href="/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&amp;tab=safety">` +
    `${escapeHtml(t("common.cancel", lang))}</a></p>` +
    `</div>`;
}

/** One connection test's outcome (C4): its sentence, then the scrubbed excerpt. */
function testBlock({ result, excerpt, lang }) {
  const key = Object.hasOwn(TEST_KEY, String(result)) ? TEST_KEY[String(result)] : TEST_KEY.failed;
  const cls = result === "ok" ? "btb-hint" : "btb-hint btb-warn";
  const note = typeof excerpt === "string" ? excerpt : "";
  return `<div class="btb-git-test" data-testid="git-test">` +
    `<p class="${cls}" data-testid="git-test-result">${escapeHtml(t(key, lang))}</p>` +
    (note
      ? `<p class="btb-hint">${escapeHtml(t("botbuilder.gitTestExcerpt", lang))}</p>` +
        `<pre class="btb-git-pub" data-testid="git-test-excerpt">${escapeHtml(note)}</pre>`
      : "") +
    `</div>`;
}

/** "Copy" — copies the <pre> it is next to. No client-built strings, no backticks. */
const COPY_SCRIPT = `<script>(function(){var b=document.getElementById('btb-git-copy');` +
  `var p=document.getElementById('btb-git-pub');if(!b||!p)return;` +
  `b.addEventListener('click',function(){try{navigator.clipboard.writeText(p.textContent);}catch(e){}});})();</script>`;

/** The public key, its fingerprint and the one thing to do with it. */
function keyBlock({ status, owner, req, botId, lang }) {
  const fp = typeof status.fingerprint === "string" ? status.fingerprint : null;
  const publicKey = typeof status.publicKey === "string" ? status.publicKey : "";
  return `<p class="btb-hint">${escapeHtml(t("botbuilder.gitPublicKey", lang))}</p>` +
    `<pre id="btb-git-pub" class="btb-git-pub" data-testid="git-pubkey">${escapeHtml(publicKey)}</pre>` +
    (owner ? `<p>${copyButton(lang)}</p>` + COPY_SCRIPT : "") +
    (fp ? `<p class="btb-hint" data-testid="git-fingerprint">${escapeHtml(fill(t("botbuilder.gitFingerprint", lang), { fp }))}</p>` : "") +
    `<p class="btb-hint">${escapeHtml(t("botbuilder.gitAddSpec", lang))}</p>`;
}

/** The hosts this bot's git may reach: the pinned one, then the confirmed ones. */
function hostsBlock({ status, owner, req, botId, lang }) {
  const hosts = Array.isArray(status.hosts) ? status.hosts : [];
  const rows = [`<li><code>${escapeHtml(GITHUB_HOST)}</code> ` +
    `<span class="btb-muted">· ${escapeHtml(t("botbuilder.gitHostPinned", lang))}</span></li>`];
  for (const h of hosts) {
    if (!h || typeof h.host !== "string" || !h.host) continue;
    const name = knownHostsName({ host: h.host, port: h.port == null ? 22 : h.port });
    const remove = owner
      ? gitForm(req, botId, "git_host_remove",
        button("botbuilder.gitHostRemove", lang, "btb-btn btb-btn-sm btb-btn-sec"),
        `<input type="hidden" name="git_host" value="${escapeHtml(h.host)}">` +
        `<input type="hidden" name="git_port" value="${escapeHtml(String(h.port == null ? 22 : h.port))}">`)
      : "";
    rows.push(`<li><code>${escapeHtml(name)}</code> ` +
      `<span class="btb-muted">· ${escapeHtml(t("botbuilder.gitHostConfirmed", lang))}</span>` +
      (remove ? ` ${remove}` : "") + `</li>`);
  }
  const add = owner
    ? gitForm(req, botId, "git_host_scan",
      `<p class="btb-hint"><label for="btb-git-host">${escapeHtml(t("botbuilder.gitHostAddLabel", lang))}</label>` +
      `<input type="text" id="btb-git-host" name="git_host" class="btb-input" autocomplete="off" spellcheck="false"></p>` +
      `<p class="btb-hint">${escapeHtml(t("botbuilder.gitHostAddHint", lang))}</p>` +
      button("botbuilder.gitHostScanBtn", lang))
    : "";
  const options = [GITHUB_HOST, ...hosts.filter((h) => h && typeof h.host === "string" && h.host)
    .map((h) => knownHostsName({ host: h.host, port: h.port == null ? 22 : h.port }))];
  const test = owner
    ? gitForm(req, botId, "git_test",
      `<p class="btb-hint"><label for="btb-git-test">${escapeHtml(t("botbuilder.gitTestLabel", lang))}</label>` +
      `<select id="btb-git-test" name="git_test_host" class="btb-input">` +
      options.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("") +
      `</select></p>` + button("botbuilder.gitTestBtn", lang))
    : "";
  return `<p class="btb-hint">${escapeHtml(t("botbuilder.gitHostsTitle", lang))}</p>` +
    `<ul class="btb-git-hosts" data-testid="git-hosts">${rows.join("")}</ul>` + add + test;
}

/**
 * The Git access card for one bot, or "" (a voice bot, an unknown bot, or an
 * unexpected failure — this card must never break the Safety tab).
 *
 * @param {{req?: object, db?: object, bot?: object, botId?: string, lang?: string, q?: object}} ctx
 * @returns {Promise<string>}
 */
export async function renderGitAccessCard(ctx = {}) {
  const { req, db, bot, botId, lang = "en", q = {} } = ctx || {};
  const id = String(botId || "");
  try {
    // The Crow voice bot answers as Crow and has no key of its own; its editor
    // is a separate page anyway (api-handlers.js refuses every generic action).
    if (!id || isVoiceBotId(id)) return "";
    const st = await gitAccessState({ db, botId: id });
    const state = st.state;
    if (state === "unknown") return "";
    const status = st.status || { on: false };
    const owner = await isOwner(db, req);
    const ownerOnly = owner ? "" : `<p class="btb-hint btb-warn" data-testid="git-owner-only">` +
      `${escapeHtml(t("botbuilder.gitOwnerOnly", lang))}</p>`;
    const body = [noticeHtml(q, lang)];
    if (state === "on") {
      // R13 first: the risk is stated plainly, above the key, not folded away
      // (operator ruling, 2026-11-12).
      body.push(`<p class="btb-hint btb-warn" data-testid="git-risk">` +
        `${escapeHtml(t("botbuilder.gitR13Warn", lang))}</p>`);
      body.push(keyBlock({ status, owner, req, botId: id, lang }));
      body.push(hostsBlock({ status, owner, req, botId: id, lang }));
      // A scan waiting for its Confirm, and a connection test's outcome, are
      // both owner-only: a non-owner never has a nonce (only the owner's own
      // POST mints one), and every Confirm form here is an owner action.
      if (owner && q && typeof q.git_scan === "string") {
        const scan = liveNonce(scanStore, q.git_scan, id, SCAN_TTL_MS);
        if (scan) body.push(scanBlock({ scan, nonce: q.git_scan, req, botId: id, lang }));
      }
      if (q && typeof q.git_test === "string") {
        const tested = liveNonce(testStore, q.git_test, id, TEST_TTL_MS);
        if (tested) body.push(testBlock({ result: tested.result, excerpt: tested.excerpt, lang }));
      }
      if (owner) body.push(gitForm(req, id, "git_off", button("botbuilder.gitTurnOff", lang, "btb-btn btb-btn-sm btb-btn-danger")));
      else body.push(ownerOnly);
    } else if (state === "off") {
      const ident = commitIdentity({ displayName: bot && bot.display_name, botId: id });
      body.push(`<p class="btb-hint" data-testid="git-state-sentence">${escapeHtml(t(STATE_KEY.off, lang))}</p>`);
      // The risk is stated BEFORE the switch as well as beside the key: the
      // owner learns what a key costs before asking for one (R13 ruling).
      body.push(`<p class="btb-hint btb-warn" data-testid="git-risk">` +
        `${escapeHtml(t("botbuilder.gitR13Warn", lang))}</p>`);
      body.push(`<p class="btb-hint" data-testid="git-identity">` +
        `${escapeHtml(fill(t("botbuilder.gitIdentity", lang), { name: ident.name + " (Crow bot)", email: ident.email }))}</p>`);
      body.push(owner ? gitForm(req, id, "git_on", button("botbuilder.gitTurnOn", lang)) : ownerOnly);
    } else {
      // A blocked state: the sentence says why, and a key that exists anyway
      // is marked inactive and can still be turned OFF (removal needs none of
      // what is missing here).
      body.push(`<p class="btb-hint" data-testid="git-state-sentence">${escapeHtml(t(STATE_KEY[state] || "botbuilder.gitNoBwrap", lang))}</p>`);
      if (status.on) body.push(`<p class="btb-hint btb-warn" data-testid="git-inactive">${escapeHtml(t("botbuilder.gitInactive", lang))}</p>`);
      if (owner) {
        if (status.on) body.push(gitForm(req, id, "git_off", button("botbuilder.gitTurnOff", lang, "btb-btn btb-btn-sm btb-btn-danger")));
      } else {
        body.push(ownerOnly);
      }
    }
    return card(t("botbuilder.gitTitle", lang),
      `<div class="btb-git" data-testid="git-access" data-state="${escapeHtml(state)}">${body.join("")}</div>`);
  } catch {
    return "";
  }
}

/** The def row a git action may touch (read-only: these actions never write it). */
async function rowFor(db, botId) {
  try {
    const r = await db.execute({
      sql: "SELECT bot_id, display_name, created_at, definition FROM pi_bot_defs WHERE bot_id=?",
      args: [botId],
    });
    return (r && r.rows && r.rows[0]) || null;
  } catch {
    return null;
  }
}

/**
 * POST handler for every git_* action (dispatched from api-handlers.js).
 *
 * The common gate, in this order: the owner's own local password session, a
 * usable bot id whose row exists, and a bot that is not the Crow voice bot.
 * Then the action, which never writes pi_bot_defs: git_on asks the store for a
 * key (refused unless the re-evaluated state is "off"), git_off removes the key
 * dir and reports its fingerprint so the owner can take the deploy key off the
 * forge. Both emit defs-changed so a running engine re-reads the state on its
 * next spawn.
 *
 * Nothing here echoes a filesystem error: a failed keygen or removal is one
 * plain sentence, and generateBotKey's own stderr (which can carry a path) is
 * never forwarded.
 *
 * The C3 and C4 actions all require the card's "on" state: they exist to
 * confirm a host FOR a key and to test a key, so a bot whose key is off (or whose
 * host cannot run git at all) is refused with the sentence the card shows for
 * that state instead — never a half-done host confirm, and never an ssh child
 * process started for a bot that could not use the answer.
 */
export async function handleGitAction(req, res, { db } = {}) {
  const b = (req && req.body) || {};
  const action = String(b.action || "");
  const botId = String(b.bot_id || "").trim();
  const back = (query) => res.redirectAfterPost(
    `/dashboard/bot-builder?bot=${encodeURIComponent(botId)}&tab=safety&${query}`);

  if (!(await isOwner(db, req))) {
    return isValidGitBotId(botId)
      ? back("error=git_owner_only")
      : res.redirectAfterPost("/dashboard/bot-builder?error=git_owner_only");
  }
  if (!isValidGitBotId(botId)) return res.redirectAfterPost("/dashboard/bot-builder?error=unknown_bot");
  const row = await rowFor(db, botId);
  if (!row) return back("error=unknown_bot");
  if (isVoiceBotId(botId)) return back("error=voice_bot_readonly");

  if (action === "git_on") {
    const st = await gitAccessState({ db, botId });
    // Every refusal the card can show is re-checked here, from this process.
    if (st.state !== "off") return back("error=" + (STATE_ERROR[st.state] || "git_unsupported"));
    try {
      generateBotKey({ botId, createdAt: row.created_at });
    } catch {
      return back("error=git_key_failed");
    }
    emitBotDefsChanged(botId);
    return back("git=on");
  }

  if (action === "git_off") {
    const was = await gitAccessState({ db, botId });
    const r = removeBotKey(botId);
    if (!r.removed && was.status && was.status.on) return back("error=git_off_failed");
    emitBotDefsChanged(botId);
    const fp = typeof r.fingerprint === "string" && FINGERPRINT_RE.test(r.fingerprint) ? r.fingerprint : null;
    return back("git=off" + (fp ? "&fp=" + encodeURIComponent(fp) : ""));
  }

  // Host confirm / removal / connection test (C3, C4): every one of them needs
  // this bot's key to exist and to be usable here.
  let on = null;
  if (ON_ONLY_ACTIONS.has(action)) {
    on = await requireOn(db, botId);
    if (!on.ok) return back("error=" + on.code);
  }

  // ---- C3 step 1: look up what a host says its host key is -----------------
  // Nothing is written: the answer is held under a nonce and the page asks for
  // one Confirm POST per key. `github.com` is refused by NAME first, because
  // normalizeHost has to refuse it too (its keys are pinned, so a confirmed
  // line for it would defeat the pin) and the owner deserves the real reason.
  if (action === "git_host_scan") {
    const raw = String(b.git_host == null ? "" : b.git_host);
    if (pinnedHostInput(raw)) return back("error=git_host_pinned");
    const target = normalizeHost(raw);
    if (!target) return back("error=git_host_invalid");
    let keys = null;
    try { keys = await keyscan({ host: target.host, port: target.port, ...sshExecOpt() }); } catch { keys = null; }
    if (keys === null) return back("error=git_host_invalid");
    if (!keys.length) return back("error=git_scan_empty");
    const nonce = putNonce(scanStore, { botId, host: target.host, port: target.port, keys, at: nowMs() });
    return back("git_scan=" + nonce);
  }

  // ---- C3 step 2: the owner confirms ONE of the scanned keys ----------------
  if (action === "git_host_confirm") {
    const nonce = String(b.nonce == null ? "" : b.nonce);
    const entry = liveNonce(scanStore, nonce, botId, SCAN_TTL_MS);
    if (!entry) return back("error=git_scan_stale");
    const fp = String(b.fingerprint == null ? "" : b.fingerprint);
    // The posted fingerprint selects the key IN THE ENTRY; the host, the port,
    // the type and the key material all come from the scan the owner was shown.
    const key = FINGERPRINT_RE.test(fp)
      ? (Array.isArray(entry.keys) ? entry.keys : []).find((k) => k && k.fingerprint === fp)
      : null;
    if (!key || typeof key.type !== "string" || typeof key.key !== "string") return back("error=git_scan_stale");
    const added = addConfirmedHost(botId, { host: entry.host, port: entry.port, type: key.type, key: key.key });
    if (!added.ok) return back("error=git_host_failed");
    scanStore.delete(nonce);          // a confirmed scan is spent, whatever happens next
    return back("git=host_added");
  }

  // ---- a confirmed host the owner wants gone -------------------------------
  if (action === "git_host_remove") {
    const host = String(b.git_host == null ? "" : b.git_host);
    const port = String(b.git_port == null ? "" : b.git_port).trim();
    const target = normalizeHost(/^\d{1,5}$/.test(port) ? host + ":" + port : host);
    if (!target) return back("error=git_host_invalid");
    const removed = removeConfirmedHost(botId, target.host, target.port);
    if (!removed.ok) return back("error=git_host_failed");
    return back("git=host_removed");
  }

  // ---- C4: test the bot's key against a host it may reach ------------------
  // The host is checked HERE, against the pinned host and this bot's confirmed
  // list, so an unconfirmed host never reaches ssh at all (ssh.js refuses the
  // same set again). The result is held under a nonce for the redirect, so the
  // page renders one sentence per classified outcome plus the scrubbed excerpt.
  if (action === "git_test") {
    const target = testTarget(b.git_test_host, on.state.status && on.state.status.hosts);
    if (!target) return back("error=git_test_invalid");
    let r = null;
    try {
      r = await testConnection({ botId, host: target.host, port: target.port, ...sshExecOpt() });
    } catch {
      r = null;
    }
    const result = r && typeof r.result === "string" ? r.result : "failed";
    const excerpt = r && typeof r.excerpt === "string" ? r.excerpt : "";
    const nonce = putNonce(testStore, { botId, result, excerpt, at: nowMs() });
    return back("git_test=" + nonce);
  }

  return back("error=git_unsupported");
}

/**
 * The card's "on" state, or the redirect code for why these actions cannot run.
 * "off" has its own sentence (there is nothing to confirm or test yet); every
 * blocked state reuses the code the card shows for it, so one wording covers
 * both places.
 */
async function requireOn(db, botId) {
  const state = await gitAccessState({ db, botId });
  if (state.state === "on") return { ok: true, state };
  const code = state.state === "off" ? "git_not_on" : (STATE_ERROR[state.state] || "git_unsupported");
  return { ok: false, code };
}
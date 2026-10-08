/**
 * Bot bash policy: the stored vocabulary and the `auto` policy's safety
 * classifier resolver. Pure except resolveClassifierEndpoint (DNS). Callers read the
 * `bot_safety_classifier` setting and the providers rows themselves (the
 * bridge over better-sqlite3, the dashboard over its async client).
 *
 * Stored values of def.permission_policy.bash:
 *   deny      no shell (the default)
 *   ask       every command asks a person; a channel turn with nobody to
 *             ask is refused
 *   auto      a local safety classifier judges each command: safe ones run,
 *             the rest ask (interactive) or are refused (unattended)
 *   allowlist only commands starting with a bash_allow entry (advanced)
 * The catastrophic-command backstop in pi-lab applies under every value.
 *
 * "sandbox" was offered by older Bot Builders but never implemented — it
 * always blocked every command. It is not a valid value any more; a stored
 * one reads as deny until the owner confirms the offered switch to auto once
 * in Bot Builder (owner save path only), so nothing widens without the
 * operator choosing it.
 */

export const BASH_POLICIES = Object.freeze(["deny", "ask", "auto", "allowlist"]);

export function isValidBashPolicy(v) {
  return typeof v === "string" && BASH_POLICIES.includes(v);
}

/** What a stored value means today, and whether it had to be mapped. */
export function normalizeStoredBashPolicy(v) {
  if (isValidBashPolicy(v)) return { value: v, migratedFrom: null, offerAuto: false };
  if (v == null || v === "") return { value: "deny", migratedFrom: null, offerAuto: false };
  // The retired "sandbox" (exactly that string) stays DENY until the owner
  // confirms the switch to auto once in Bot Builder (Kevin's ruling, rev c:
  // a legacy value must not silently become a shell). Unknown stays deny.
  if (v === "sandbox") return { value: "deny", migratedFrom: "sandbox", offerAuto: true };
  return { value: "deny", migratedFrom: typeof v === "string" ? v : JSON.stringify(v), offerAuto: false };
}

/** Catalog model ids that can serve as the classifier, best first. */
export const CLASSIFIER_CANDIDATE_MODELS = Object.freeze(["qwen3.5-4b"]);
export const CLASSIFIER_SETTING_KEY = "bot_safety_classifier";
export const CLASSIFIER_TIMEOUT_MS = 6000;

const INSTANCE_ID_RE = /^[0-9a-f]{32}$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

function ipv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase(); } catch { return null; }
}

/** Loopback, a tailnet IPv4 (100.64.0.0/10) or Tailscale IPv6 (fd7a:115c:a1e0::/48). */
export function isTailnetOrLoopbackIp(h) {
  if (!h) return false;
  if (LOOPBACK.has(h)) return true;
  const o = ipv4(h);
  if (o) return o[0] === 127 || (o[0] === 100 && o[1] >= 64 && o[1] <= 127);
  return /^fd7a:115c:a1e0:/i.test(h);
}

/**
 * The classifier trust boundary. Commands sent to the classifier carry paths,
 * file names and sometimes secrets, so the endpoint must be on this machine
 * or the operator's tailnet: loopback, a tailnet IP, or a *.ts.net name (which
 * resolveClassifierEndpoint then resolves and pins to a tailnet IP). Never a
 * public host, never plain LAN (RFC1918 addresses can be anyone's).
 */
export function isTrustedClassifierUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  const h = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return isTailnetOrLoopbackIp(h) || (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(h) && !ipv4(h));
}

export function parseClassifierSetting(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (s.startsWith("{")) {
    try {
      const o = JSON.parse(s);
      if (o && typeof o.url === "string" && typeof o.model === "string" && o.model.trim()) return { url: o.url.trim(), model: o.model.trim() };
    } catch {}
    return null;
  }
  if (s.startsWith('"')) { try { s = String(JSON.parse(s)).trim(); } catch { return null; } }
  const i = s.indexOf("/");
  if (i <= 0 || i === s.length - 1) return null;
  return { provider: s.slice(0, i), model: s.slice(i + 1) };
}

function parseJson(v, fallback) {
  if (v == null) return fallback;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return fallback; }
}
function modelIds(row) {
  const ms = parseJson(row.models, []);
  return Array.isArray(ms) ? ms.map((m) => (m && typeof m === "object" ? m.id : m)).filter((x) => typeof x === "string") : [];
}
function isEnabled(row) { return !Number(row.disabled || 0); }

/** The URL's host is this machine (loopback or one of its own addresses). */
function servedHere(url, ownAddresses) {
  const h = hostOf(url);
  if (!h) return false;
  if (LOOPBACK.has(h) || /^127\./.test(h)) return true;
  return !!(ownAddresses && typeof ownAddresses.has === "function" && ownAddresses.has(h));
}

/** Written by THIS instance (providers rows sync between paired instances). */
function ownRow(row, ownInstanceId) {
  // Fail closed on shape: a caller that did not select instance_id cannot
  // vouch for the row's origin (that was a dead check — both callers once
  // omitted the column, so every row looked locally written).
  if (!row || !Object.prototype.hasOwnProperty.call(row, "instance_id")) return false;
  if (INSTANCE_ID_RE.test(String(row.host || "")) && row.host !== ownInstanceId) return false;
  const w = row.instance_id;
  if (ownInstanceId != null && w === ownInstanceId) return true;
  // A NULL/empty origin is trusted only for a loopback row (a local seed,
  // which never routes anywhere else). A synced row always carries its
  // origin, so a non-loopback row without one is not vouched for (review F3).
  if (w == null || w === "") {
    const h = hostOf(row.base_url);
    return !!h && (LOOPBACK.has(h) || /^127\./.test(h));
  }
  return false;
}

function withWhere(sel, ownAddresses) {
  return { ...sel, where: hostOf(sel.url) || "?", here: servedHere(sel.url, ownAddresses) };
}
const clean = (u) => String(u).replace(/\/+$/, "");

/**
 * Pick the classifier (pure; names are resolved by resolveClassifierEndpoint).
 *   setting {url, model}     an endpoint the operator named; trusted URL only
 *   setting provider/model   a row THIS instance wrote; trusted URL only
 *   no setting               auto-detect: an enabled row this instance wrote,
 *                            served by this machine on loopback/tailnet,
 *                            serving a candidate model (resident first)
 * An invalid setting is an error, never a silent fallback.
 */
export function selectBotClassifier({ setting, providers, ownAddresses = null, ownInstanceId = null }) {
  const rows = Array.isArray(providers) ? providers : [];
  const installModel = CLASSIFIER_CANDIDATE_MODELS[0];
  const ref = parseClassifierSetting(setting);
  if (setting != null && String(setting).trim() !== "" && !ref) return { ok: false, reason: "setting-invalid", installModel };
  if (ref && ref.url) {
    if (!isTrustedClassifierUrl(ref.url)) return { ok: false, reason: "setting-not-tailnet", ref: ref.url, installModel };
    return withWhere({ ok: true, providerId: null, model: ref.model, url: clean(ref.url), source: "setting-endpoint" }, ownAddresses);
  }
  if (ref) {
    const row = rows.find((r) => r.id === ref.provider);
    const refStr = `${ref.provider}/${ref.model}`;
    if (!row) return { ok: false, reason: "setting-provider-missing", ref: refStr, installModel };
    if (!isEnabled(row)) return { ok: false, reason: "setting-provider-disabled", ref: refStr, installModel };
    if (!ownRow(row, ownInstanceId)) return { ok: false, reason: "setting-row-not-own", ref: refStr, installModel };
    if (!isTrustedClassifierUrl(row.base_url)) return { ok: false, reason: "setting-not-tailnet", ref: refStr, installModel };
    if (!modelIds(row).includes(ref.model)) return { ok: false, reason: "setting-model-missing", ref: refStr, installModel };
    return withWhere({ ok: true, providerId: row.id, model: ref.model, url: clean(row.base_url), source: "setting" }, ownAddresses);
  }
  const found = [];
  for (const row of rows) {
    if (!isEnabled(row) || row.host === "cloud" || !ownRow(row, ownInstanceId)) continue;
    if (!servedHere(row.base_url, ownAddresses) || !isTailnetOrLoopbackIp(hostOf(row.base_url))) continue;
    const ids = modelIds(row);
    const rank = CLASSIFIER_CANDIDATE_MODELS.findIndex((c) => ids.includes(c));
    if (rank < 0) continue;
    const resident = parseJson(row.gpu_policy, {})?.alwaysResident === true;
    found.push({ row, model: CLASSIFIER_CANDIDATE_MODELS[rank], rank, resident });
  }
  found.sort((a, b) => (a.rank - b.rank) || (Number(b.resident) - Number(a.resident)) || String(a.row.id).localeCompare(String(b.row.id)));
  const best = found[0];
  if (!best) return { ok: false, reason: "none", installModel };
  return withWhere({ ok: true, providerId: best.row.id, model: best.model, url: clean(best.row.base_url), source: "auto" }, ownAddresses);
}

/**
 * Pin a *.ts.net name to a tailnet IP: every address it resolves to must be
 * on the tailnet (a Funnel or public name is refused), and the URL handed to
 * pi-lab carries the IP (pi-lab accepts IP literals only), so DNS cannot move
 * commands later. Names need http — TLS to a bare IP would not verify; the
 * tailnet is already encrypted. IP endpoints pass through untouched.
 */
export async function resolveClassifierEndpoint(sel, { lookup } = {}) {
  if (!sel || !sel.ok) return sel;
  let u;
  try { u = new URL(sel.url); } catch { return { ok: false, reason: "setting-invalid", installModel: CLASSIFIER_CANDIDATE_MODELS[0] }; }
  const h = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isTailnetOrLoopbackIp(h)) return sel;
  if (u.protocol !== "http:") return { ok: false, reason: "https-name-unsupported", ref: sel.url, installModel: CLASSIFIER_CANDIDATE_MODELS[0] };
  const doLookup = lookup || (async (name) => (await import("node:dns/promises")).lookup(name, { all: true }));
  let addrs;
  try { addrs = await doLookup(h); } catch { return { ok: false, reason: "name-unresolved", ref: sel.url, installModel: CLASSIFIER_CANDIDATE_MODELS[0] }; }
  if (!Array.isArray(addrs) || !addrs.length || !addrs.every((a) => isTailnetOrLoopbackIp(String(a.address).toLowerCase()))) {
    return { ok: false, reason: "name-resolves-off-tailnet", ref: sel.url, installModel: CLASSIFIER_CANDIDATE_MODELS[0] };
  }
  const pick = addrs.find((a) => a.family === 4) || addrs[0];
  u.hostname = pick.family === 6 ? `[${pick.address}]` : pick.address;
  return { ...sel, url: clean(u.toString()), where: `${h} (${pick.address})` };
}

/** The block the bridge puts in PI_BOT_PERMISSION_POLICY.classifier. No key:
 *  the bot can read its own environment once it has a shell. */
export function classifierPolicyBlock(sel) {
  if (!sel || !sel.ok) return null;
  return { url: sel.url, model: sel.model, timeout_ms: CLASSIFIER_TIMEOUT_MS };
}

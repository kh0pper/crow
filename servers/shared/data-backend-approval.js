/**
 * Data-backend approval — an `mcp_server` backend is a command the gateway
 * will execute, so registering one must not be enough to run it.
 *
 * - An AI client or bot (the crow_register_backend MCP tool) can only create
 *   a row in `pending_approval`.
 * - The dashboard owner approves it on the Projects page (session-authed,
 *   CSRF-checked POST). Approval runs the launcher check and stores, in
 *   `approved_ref_sha256`, an HMAC-SHA256 (`hmac1:<hex>`) over one SHA-256 of
 *   the exact `connection_ref` text AND the current contents of every
 *   non-root-owned file the command line names (the launcher, and any
 *   argument that is an existing file — the script an interpreter runs) AND
 *   the row's id and the nonce recorded for that id outside the database.
 * - The HMAC key is 32 random bytes in `<CROW_HOME>/secrets/`, and the nonce
 *   lives in a per-row record beside it (see data-backend-approval-key.js),
 *   never in crow.db: a process that can write the row cannot compute an
 *   approval for it, cannot replay an old value after a revoke (the nonce is
 *   gone) and cannot copy one row's value onto another (different id, no
 *   nonce). The bare-64-hex value older versions stored is LEFTOVER, not an
 *   approval (isLegacyApproval): those rows stay stopped until the owner
 *   approves them again.
 * - The gateway starts a row only while that HMAC still matches: any later
 *   edit of the command, args, env-var names, or of one of those files,
 *   voids the approval. Code fetched at start (npx/uvx packages) and files a
 *   script opens on its own are NOT covered — the page says so.
 * - It starts from an allowlisted environment (the bot env basics, no
 *   secret-looking names) plus only the env vars it declares, never the
 *   gateway's whole environment.
 * - Rows never arrive from peers: data_backends is not an instance-sync
 *   table, and project clone bundles carry backend manifests without
 *   inserting them.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { resolveAddonCommand, checkLauncherArgs, sha256File } from "./resolve-command.js";
import { buildBotBaseEnv } from "./bot-env.js";
import {
  ensureApprovalKey, readApprovalKey, readApprovalRecord, approvalNonce, newApprovalNonce, setApprovalNonce, clearApprovalNonce,
} from "./data-backend-approval-key.js";

export const PENDING_STATUS = "pending_approval";

/** The approved value's prefix: `hmac1:<64 hex>`. */
export const APPROVAL_PREFIX = "hmac1:";
const KEYED_APPROVAL = /^hmac1:[0-9a-f]{64}$/;
const BARE_SHA256 = /^[0-9a-f]{64}$/;

/** What the owner is told (and what the row's last_error carries) about an old approval. */
export const LEGACY_APPROVAL_MESSAGE = "Approved before Crow keyed its approvals; approve it again on the Projects page";

/**
 * What the owner is told about an approval this machine cannot verify at all:
 * the approval key or the row's nonce is missing, which is what a restore on
 * another machine leaves behind (secrets/ is never backed up).
 */
export const MACHINE_APPROVAL_MESSAGE = "Its approval does not match this machine's approval key (for example after a restore); approve it again on the Projects page";

/**
 * What the owner is told about a keyed value that belongs to ANOTHER row: this
 * machine has the key and has nonces on record — just not for this row, so the
 * value was copied from a row that was approved, or forged with a nonce of its
 * own. Distinct from MACHINE_APPROVAL_MESSAGE, which is the restore case (no
 * key, or a record with nothing in it at all).
 */
export const NOT_FOR_THIS_BACKEND_MESSAGE = "Its approval was not made for this backend; approve it again on the Projects page";

/**
 * What the owner is told when a stop was written but the approval record could
 * not be: the row's value is gone, its nonce is not, so a value put back into
 * the row would verify again until the record can be written.
 */
export const REVOKE_PARTIAL_MESSAGE = "Stopped, but Crow could not update its approval record; this stop is not permanent until it can. Check the folder permissions of Crow's secrets directory.";

export function refHash(connectionRef) {
  return createHash("sha256").update(String(connectionRef ?? ""), "utf8").digest("hex");
}

/** Largest file a backend approval pins by content. */
export const MAX_PINNED_FILE_BYTES = 16 * 1024 * 1024;

/** Root-owned, not group/world-writable all the way up: trusted like a system launcher. */
function rootOwnedPath(real) {
  let cur = real;
  for (;;) {
    let st;
    try { st = statSync(cur); } catch { return false; }
    if (st.uid !== 0 || (st.mode & 0o022)) return false;
    const up = dirname(cur);
    if (up === cur) return true;
    cur = up;
  }
}

/**
 * The files an approval pins: the launcher (when it is a path) and every
 * argument that names an existing regular file (absolute, or relative to the
 * gateway's working directory), except root-owned ones. Stat only — nothing
 * is read here.
 * @returns {{ path: string, real: string }[]}
 */
export function pinnedFiles(spec, cwd = process.cwd()) {
  const out = [];
  const seen = new Set();
  const consider = (p) => {
    if (typeof p !== "string" || !p || p.startsWith("-") || p.length > 4096) return;
    const abs = isAbsolute(p) ? p : resolvePath(cwd, p);
    let real;
    try { real = realpathSync(abs); } catch { return; }
    let st;
    try { st = statSync(real); } catch { return; }
    if (!st.isFile() || seen.has(real) || rootOwnedPath(real)) return;
    seen.add(real);
    out.push({ path: p, real });
  };
  if (spec.command.includes("/")) consider(spec.command);
  for (const a of spec.args) consider(a);
  return out;
}

/**
 * One hash over the stored connection_ref text and the contents of every
 * pinned file. null when a pinned file cannot be hashed (gone, not regular,
 * over MAX_PINNED_FILE_BYTES) — such a spec cannot be approved or started.
 */
export function approvalHash(connectionRef, cwd = process.cwd()) {
  const parsed = parseStoredSpec(connectionRef);
  if (!parsed.ok) return null;
  const h = createHash("sha256").update(String(connectionRef ?? ""), "utf8");
  for (const f of pinnedFiles(parsed.spec, cwd)) {
    const fh = sha256File(f.real, { maxBytes: MAX_PINNED_FILE_BYTES });
    if (!fh) return null;
    h.update(`\n${f.real}\0${fh}`, "utf8");
  }
  return h.digest("hex");
}

/** Domain separation: this HMAC signs an approval and nothing else keyed with this key. */
const APPROVAL_DOMAIN = "crow-data-backend-approval\0v1\0";

/** The stored form of an approval: `hmac1:` + HMAC-SHA256(key, domain, row id, nonce, pin). */
function hmacFor(key, rowId, nonce, pin) {
  return APPROVAL_PREFIX + createHmac("sha256", key)
    .update(`${APPROVAL_DOMAIN}${String(rowId)}\0${nonce}\0${pin}`, "utf8")
    .digest("hex");
}

/**
 * The keyed approval value for a row: `hmac1:<hmac>`, or null when the
 * reference cannot be hashed (a pinned file is gone or unreadable). The value
 * covers the row's id and the nonce recorded for it, so it belongs to that row
 * and cannot be replayed after a revoke.
 */
export function keyedApproval(key, rowId, nonce, connectionRef) {
  const pin = approvalHash(connectionRef);
  if (!pin || !Buffer.isBuffer(key) || typeof nonce !== "string" || !nonce) return null;
  return hmacFor(key, rowId, nonce, pin);
}

/**
 * True when `row` (an mcp_server data_backends row) is owner-approved as it
 * stands — command line AND pinned file contents — under THIS machine's
 * approval key and the nonce recorded for this row. Hashes files: call it at
 * start, never while rendering a page. Never creates the key or the record: a
 * missing (or unreadable, or refused) one means no approval is valid. An old
 * bare-64-hex value is not an approval.
 */
export function isApproved(row, { crowHome } = {}) {
  if (!row || typeof row.approved_ref_sha256 !== "string") return false;
  if (!KEYED_APPROVAL.test(row.approved_ref_sha256)) return false;
  const key = readApprovalKey({ crowHome });
  if (!key) return false;
  const nonce = approvalNonce(row.id, { crowHome });
  if (!nonce) return false;
  const want = keyedApproval(key, row.id, nonce, row.connection_ref);
  if (!want) return false;
  const got = Buffer.from(row.approved_ref_sha256.slice(APPROVAL_PREFIX.length), "hex");
  const expected = Buffer.from(want.slice(APPROVAL_PREFIX.length), "hex");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/**
 * True when a keyed value cannot be checked on this machine at all: the
 * approval key or the row's record entry is missing (a restore on another
 * machine, since secrets/ is never backed up). Two small files outside crow.db,
 * never a pinned file, so the dashboard may call it while rendering to tell this
 * apart from "what it pins changed". A value copied from another row reads as
 * this too (its own entry is missing); approvalForAnotherBackend tells the two
 * apart for the sentence the owner sees.
 */
export function approvalNotFromThisMachine(row, { crowHome } = {}) {
  if (!row || typeof row.approved_ref_sha256 !== "string") return false;
  if (!KEYED_APPROVAL.test(row.approved_ref_sha256)) return false;
  return !readApprovalKey({ crowHome }) || !approvalNonce(row.id, { crowHome });
}

/**
 * True when the value is keyed, this machine has its key, and the record holds
 * nonces for OTHER rows but none for this one: the value was made for a
 * different row (copied off an approved row, or forged). Reads the same two
 * small files outside crow.db as approvalNotFromThisMachine, never a pinned
 * file.
 */
export function approvalForAnotherBackend(row, { crowHome } = {}) {
  if (!row || typeof row.approved_ref_sha256 !== "string") return false;
  if (!KEYED_APPROVAL.test(row.approved_ref_sha256)) return false;
  if (!readApprovalKey({ crowHome })) return false;
  const id = row.id === undefined || row.id === null ? "" : String(row.id);
  const rec = readApprovalRecord({ crowHome });
  return Object.keys(rec.rows).length > 0 && !Object.hasOwn(rec.rows, id);
}

/** Display only (no file reads): a keyed approval is on record; it is re-checked at start. */
export function hasApproval(row) {
  return !!row && typeof row.approved_ref_sha256 === "string" && KEYED_APPROVAL.test(row.approved_ref_sha256);
}

/**
 * Display only: the value is the bare SHA-256 older versions stored, made when
 * the hash sat in the same row it protects. It proves nothing now — the row is
 * stopped until the owner approves it again.
 */
export function isLegacyApproval(row) {
  return !!row && typeof row.approved_ref_sha256 === "string" && BARE_SHA256.test(row.approved_ref_sha256);
}

/** The environment an approved backend starts with: allowlisted basics plus its declared vars. */
export function backendEnv(declared = [], source = process.env) {
  const base = buildBotBaseEnv({ ...source, CROW_BOT_ENV_PASSTHROUGH: "" }, { extraAllow: "" });
  const env = { ...base };
  for (const v of declared) if (typeof source[v] === "string") env[v] = source[v];
  return env;
}

/** Names (never values) of exactly what backendEnv would pass, declared ones included. */
export function backendEnvNames(declared = [], source = process.env) {
  const base = Object.keys(buildBotBaseEnv({ ...source, CROW_BOT_ENV_PASSTHROUGH: "" }, { extraAllow: "" }));
  return [...new Set([...base, ...declared])].sort();
}

// The launch spec is exactly what the gateway spawns: command, args and the
// env-var NAMES passed through. Nothing else in connection_ref is used (no
// cwd, no env values), so any other key is refused rather than shown-but-
// ignored or ignored-but-hashed. Limits keep the approval view complete: a
// spec too long to show in full is refused, never truncated.
export const SPEC_KEYS = Object.freeze(["command", "args", "envVars", "command_sha256"]);
export const MAX_COMMAND_LEN = 512;
export const MAX_ARG_LEN = 1024;
export const MAX_ARGS = 64;
export const MAX_ENV_VARS = 32;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * Validate a parsed connection_ref as a launch spec.
 * @returns {{ ok: true, spec: { command: string, args: string[], envVars: string[] } } | { ok: false, reason: string }}
 */
export function parseLaunchSpec(connRef) {
  if (!connRef || typeof connRef !== "object" || Array.isArray(connRef)) return { ok: false, reason: "connection_ref must be a JSON object" };
  const extra = Object.keys(connRef).filter((k) => !SPEC_KEYS.includes(k));
  if (extra.length) return { ok: false, reason: `connection_ref has keys that are never used to start it: ${extra.join(", ")} (allowed: ${SPEC_KEYS.join(", ")})` };
  const { command } = connRef;
  if (typeof command !== "string" || !command) return { ok: false, reason: "connection_ref has no command" };
  if (command.length > MAX_COMMAND_LEN) return { ok: false, reason: `command is longer than ${MAX_COMMAND_LEN} characters` };
  const args = connRef.args === undefined ? [] : connRef.args;
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return { ok: false, reason: "args must be a list of strings" };
  if (args.length > MAX_ARGS) return { ok: false, reason: `more than ${MAX_ARGS} args` };
  if (args.some((a) => a.length > MAX_ARG_LEN)) return { ok: false, reason: `an arg is longer than ${MAX_ARG_LEN} characters` };
  const envVars = connRef.envVars === undefined ? [] : connRef.envVars;
  if (!Array.isArray(envVars) || !envVars.every((v) => typeof v === "string" && ENV_NAME.test(v))) {
    return { ok: false, reason: "envVars must be a list of environment variable NAMES" };
  }
  if (envVars.length > MAX_ENV_VARS) return { ok: false, reason: `more than ${MAX_ENV_VARS} envVars` };
  const pin = connRef.command_sha256;
  if (pin !== undefined && !(typeof pin === "string" && /^[0-9a-f]{64}$/.test(pin))) {
    return { ok: false, reason: "command_sha256 must be 64 lowercase hex characters" };
  }
  return { ok: true, spec: { command, args, envVars, ...(pin ? { command_sha256: pin } : {}) } };
}

/**
 * The one canonical text of a launch spec: the keys that are present, in
 * SPEC_KEYS order, serialized by JSON.stringify. Registration stores exactly
 * this, and every reader (approval page, approval hash, spawner) goes
 * through parseStoredSpec, which refuses any stored text that is not already
 * canonical — so duplicate keys, reordered keys, extra whitespace or
 * alternative escapes can never make two readers see different specs.
 */
export function canonicalSpecText(ref) {
  const o = {};
  for (const k of SPEC_KEYS) if (Object.prototype.hasOwnProperty.call(ref, k)) o[k] = ref[k];
  return JSON.stringify(o);
}

/**
 * The single parser for a stored connection_ref, used by the approval page,
 * the approval hash and the spawner alike.
 * @returns {{ ok: true, spec: object, text: string } | { ok: false, reason: string }}
 */
export function parseStoredSpec(connectionRef) {
  const text = String(connectionRef ?? "");
  let ref;
  try { ref = JSON.parse(text); } catch { return { ok: false, reason: "connection_ref is not valid JSON" }; }
  const r = parseLaunchSpec(ref);
  if (!r.ok) return r;
  if (canonicalSpecText(ref) !== text) {
    return { ok: false, reason: "connection_ref is not in canonical form (duplicate or reordered keys, extra spaces, or unusual escapes); register it again" };
  }
  return { ok: true, spec: r.spec, text };
}

/**
 * Every character visible: printable ASCII stays as is (backslash doubled),
 * a space shows as "␣", and anything else — control characters, zero-width
 * and bidi marks, any non-ASCII letter that could pass for an ASCII one — is
 * shown as \u{hex}. keepSpaces leaves spaces alone (prose that quotes the
 * command, such as an error reason). Returns plain text; HTML-escape it.
 */
export function visibleText(str, { keepSpaces = false } = {}) {
  let out = "";
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (cp === 0x20) out += keepSpaces ? " " : "\u2423";
    else if (cp > 0x20 && cp < 0x7f) out += ch;
    else out += `\\u{${cp.toString(16)}}`;
  }
  return out;
}

/**
 * Launch verification, run right before every spawn (never cached): the
 * spec's shape, then the add-on launcher rules (servers/shared/resolve-
 * command.js) — `node`/`npm`/`npx` are the gateway's own; any other bare
 * name only from root-owned system directories; an absolute launcher must
 * be root-owned or match the spec's `command_sha256`; relative launchers
 * and floating uv/uvx git sources are refused. The verified real path is
 * what gets executed.
 * @returns {{ ok: true, command: string, args: string[], envVars: string[] } | { ok: false, reason: string }}
 */
export function verifyBackendLaunch(connRef, opts = {}) {
  const r = parseLaunchSpec(connRef);
  if (!r.ok) return r;
  const rc = resolveAddonCommand(r.spec.command, { ...opts, sha256: r.spec.command_sha256 });
  if (rc.missing || typeof rc.command !== "string") return { ok: false, reason: rc.reason || "launcher could not be verified" };
  const argProblem = checkLauncherArgs(rc.command, r.spec.args);
  if (argProblem) return { ok: false, reason: argProblem };
  return { ok: true, command: rc.command, args: r.spec.args, envVars: r.spec.envVars };
}

/**
 * Owner action: approve the row's current connection_ref. `expectedHash` is
 * the hash of the connection_ref the owner was shown (refHash): the approval
 * only lands if the row still carries exactly that text. Runs the launcher
 * check now (it hashes, bounded), pins file contents, records a fresh nonce
 * for this row in `<CROW_HOME>/secrets/data-backend-approvals.json` FIRST, and
 * only then stores the keyed value in the row — under this machine's approval
 * key, made if it is not there yet.
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function approveBackend(db, id, expectedHash, { crowHome } = {}) {
  const { rows } = await db.execute({
    sql: "SELECT id, connection_ref FROM data_backends WHERE id = ? AND backend_type = 'mcp_server'",
    args: [id],
  });
  if (!rows.length) return { ok: false, reason: "backend not found" };
  const rowId = rows[0].id;
  const ref = rows[0].connection_ref;
  const refuse = async (reason) => {
    await db.execute({
      sql: "UPDATE data_backends SET last_error = ?, updated_at = datetime('now') WHERE id = ?",
      args: [`Not approved: ${reason}`, rowId],
    });
    return { ok: false, reason };
  };
  const parsed = parseStoredSpec(ref);
  if (!parsed.ok) return refuse(parsed.reason);
  if (expectedHash !== undefined && expectedHash !== refHash(ref)) return refuse("it changed since the page loaded; review it again");
  const launch = verifyBackendLaunch(parsed.spec);
  if (!launch.ok) return refuse(launch.reason);
  const pin = approvalHash(ref);
  if (!pin) return refuse(`a file it runs cannot be pinned (missing, not a regular file, or over ${MAX_PINNED_FILE_BYTES / (1024 * 1024)} MB)`);
  // A key that cannot be made means nothing can be approved: without it no
  // row would ever pass isApproved, so never store an unapprovable value.
  let key = readApprovalKey({ crowHome });
  if (!key) {
    try {
      key = ensureApprovalKey({ crowHome });
    } catch {
      return refuse("Crow could not create its approval key; nothing was approved");
    }
  }
  // The nonce is recorded FIRST: a value whose nonce is not on record verifies
  // for nothing, so a failure here must leave the row unapproved rather than
  // half-approved. A fresh nonce also voids the row's previous value.
  const nonce = newApprovalNonce();
  try {
    await setApprovalNonce(rowId, nonce, { crowHome });
  } catch {
    return refuse("Crow could not record its approval; nothing was approved");
  }
  const value = hmacFor(key, rowId, nonce, pin);
  await db.execute({
    sql: "UPDATE data_backends SET approved_ref_sha256 = ?, status = 'disconnected', last_error = NULL, updated_at = datetime('now') WHERE id = ?",
    args: [value, rowId],
  });
  return { ok: true };
}

/**
 * The last check before a spawn, synchronous so nothing can run between it
 * and the spawn that follows in the same tick: parse the freshly read row's
 * stored text with the one parser, recompute the approval hash (re-reading
 * the pinned files), run the launcher check (re-hashing a pinned launcher),
 * and hand back what to execute — the verified real launcher path, and the
 * real path of every pinned file argument in place of the name it was given,
 * so a symlink re-pointed after the check cannot redirect what runs.
 * Residual window (same as add-ons): a same-uid process rewriting a file in
 * the instant between this check and exec.
 * @returns {{ ok: true, command: string, args: string[], envVars: string[] } | { ok: false, reason: string }}
 */
export function prepareSpawn(row, cwd = process.cwd(), { crowHome } = {}) {
  const parsed = parseStoredSpec(row && row.connection_ref);
  if (!parsed.ok) return parsed;
  if (!isApproved(row, { crowHome })) return { ok: false, reason: "not approved as it stands (its command or a file it runs changed)" };
  const launch = verifyBackendLaunch(parsed.spec);
  if (!launch.ok) return launch;
  const real = new Map(pinnedFiles(parsed.spec, cwd).map((f) => [f.path, f.real]));
  return { ok: true, command: launch.command, args: parsed.spec.args.map((a) => real.get(a) ?? a), envVars: launch.envVars };
}

/**
 * Owner action: withdraw an approval (the row stays, it is no longer started).
 * The row's nonce is removed from the record FIRST, so a value copied back into
 * the column afterwards verifies for nothing, and again AFTER the column write,
 * which closes the window in which an approval lands between the clear and the
 * UPDATE (that approval's nonce would otherwise stay on record with its value
 * erased from the row — a value that verifies again if it is written back).
 *
 * If the record cannot be written the column is still cleared (a leftover
 * nonce alone approves nothing) but the stop is not permanent: a value put back
 * into the row would verify again. The row's last_error says so, and the
 * `partial` result tells the caller to show it. `clearNonce` is the record
 * write (a seam for the failure case).
 * @returns {Promise<boolean | { ok: true, partial: true }>} true when the row was
 *   stopped; { ok: true, partial: true } when it was stopped but the record write
 *   failed; false when no such mcp_server row was stopped (nothing changed).
 */
export async function revokeBackendApproval(db, id, { crowHome, clearNonce = clearApprovalNonce } = {}) {
  const dropNonce = async () => {
    try {
      await clearNonce(id, { crowHome });
      return true;
    } catch {
      console.warn(`[data-backend-approval] could not update the approval record for backend #${id}; the approval is withdrawn anyway`);
      return false;
    }
  };
  let recordOk = await dropNonce();
  const r = await db.execute({
    sql: "UPDATE data_backends SET approved_ref_sha256 = NULL, status = ?, updated_at = datetime('now') WHERE id = ? AND backend_type = 'mcp_server'",
    args: [PENDING_STATUS, id],
  });
  const stopped = (r.rowsAffected ?? 0) > 0;
  if (!stopped) return false;
  // After the column write, so an approval that landed in between loses its nonce too.
  // This second attempt is what the result reports on: it ran last, so the record as
  // it stands now is the one it wrote (or failed to write).
  recordOk = await dropNonce();
  if (!recordOk) {
    await db.execute({
      sql: "UPDATE data_backends SET last_error = ?, updated_at = datetime('now') WHERE id = ? AND backend_type = 'mcp_server'",
      args: [REVOKE_PARTIAL_MESSAGE, id],
    });
    return { ok: true, partial: true };
  }
  return true;
}

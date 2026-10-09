/**
 * Data-backend approval — an `mcp_server` backend is a command the gateway
 * will execute, so registering one must not be enough to run it.
 *
 * - An AI client or bot (the crow_register_backend MCP tool) can only create
 *   a row in `pending_approval`.
 * - The dashboard owner approves it on the Projects page (session-authed,
 *   CSRF-checked POST). Approval runs the launcher check and stores, in
 *   `approved_ref_sha256`, one SHA-256 over the exact `connection_ref` text
 *   AND the current contents of every non-root-owned file the command line
 *   names (the launcher, and any argument that is an existing file — the
 *   script an interpreter runs).
 * - The gateway starts a row only while that hash still matches: any later
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
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { resolveAddonCommand, checkLauncherArgs, sha256File } from "./resolve-command.js";
import { buildBotBaseEnv } from "./bot-env.js";

export const PENDING_STATUS = "pending_approval";

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

/**
 * True when `row` (an mcp_server data_backends row) is owner-approved as it
 * stands — command line AND pinned file contents. Hashes files: call it at
 * start, never while rendering a page.
 */
export function isApproved(row) {
  if (!row || typeof row.approved_ref_sha256 !== "string") return false;
  return row.approved_ref_sha256 === approvalHash(row.connection_ref);
}

/** Display only (no file reads): an approval is on record; it is re-checked at start. */
export function hasApproval(row) {
  return !!row && typeof row.approved_ref_sha256 === "string" && row.approved_ref_sha256.length === 64;
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

/** parseLaunchSpec on the stored connection_ref text. */
export function parseStoredSpec(connectionRef) {
  let ref;
  try { ref = JSON.parse(String(connectionRef ?? "")); } catch { return { ok: false, reason: "connection_ref is not valid JSON" }; }
  return parseLaunchSpec(ref);
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
 * check now (it hashes, bounded) and pins file contents.
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function approveBackend(db, id, expectedHash) {
  const { rows } = await db.execute({
    sql: "SELECT id, connection_ref FROM data_backends WHERE id = ? AND backend_type = 'mcp_server'",
    args: [id],
  });
  if (!rows.length) return { ok: false, reason: "backend not found" };
  const ref = rows[0].connection_ref;
  const refuse = async (reason) => {
    await db.execute({
      sql: "UPDATE data_backends SET last_error = ?, updated_at = datetime('now') WHERE id = ?",
      args: [`Not approved: ${reason}`, id],
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
  await db.execute({
    sql: "UPDATE data_backends SET approved_ref_sha256 = ?, status = 'disconnected', last_error = NULL, updated_at = datetime('now') WHERE id = ?",
    args: [pin, id],
  });
  return { ok: true };
}

/** Owner action: withdraw an approval (the row stays, it is no longer started). */
export async function revokeBackendApproval(db, id) {
  const r = await db.execute({
    sql: "UPDATE data_backends SET approved_ref_sha256 = NULL, status = ?, updated_at = datetime('now') WHERE id = ? AND backend_type = 'mcp_server'",
    args: [PENDING_STATUS, id],
  });
  return (r.rowsAffected ?? 0) > 0;
}

/**
 * Data-backend approval — an `mcp_server` backend is a command the gateway
 * will execute, so registering one must not be enough to run it.
 *
 * - An AI client or bot (the crow_register_backend MCP tool) can only create
 *   a row in `pending_approval`.
 * - The dashboard owner approves it on the Projects page (session-authed,
 *   CSRF-checked POST). Approval stores the SHA-256 of the exact
 *   `connection_ref` text in `approved_ref_sha256`.
 * - The gateway starts a row only while that hash still matches: any later
 *   edit of the command, args or env-var names voids the approval.
 * - Rows never arrive from peers: data_backends is not an instance-sync
 *   table, and project clone bundles carry backend manifests without
 *   inserting them.
 */
import { createHash } from "node:crypto";

export const PENDING_STATUS = "pending_approval";

export function refHash(connectionRef) {
  return createHash("sha256").update(String(connectionRef ?? ""), "utf8").digest("hex");
}

/** True when `row` (an mcp_server data_backends row) is owner-approved as it stands. */
export function isApproved(row) {
  return !!row && typeof row.approved_ref_sha256 === "string"
    && row.approved_ref_sha256 === refHash(row.connection_ref);
}

// The launch spec is exactly what the gateway spawns: command, args and the
// env-var NAMES passed through. Nothing else in connection_ref is used (no
// cwd, no env values), so any other key is refused rather than shown-but-
// ignored or ignored-but-hashed. Limits keep the approval view complete: a
// spec too long to show in full is refused, never truncated.
export const SPEC_KEYS = Object.freeze(["command", "args", "envVars"]);
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
  return { ok: true, spec: { command, args, envVars } };
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
 * shown as \u{hex}. Returns plain text; HTML-escape it before rendering.
 */
export function visibleText(str) {
  let out = "";
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (cp === 0x20) out += "\u2423";
    else if (cp > 0x20 && cp < 0x7f) out += ch;
    else out += `\\u{${cp.toString(16)}}`;
  }
  return out;
}

/**
 * Launch-command verification hook. Every approved backend passes through
 * here right before it is spawned. Today it checks the spec's shape; when
 * the add-on launcher verification (servers/shared/resolve-command.js)
 * lands, call its resolver here so backends get the same root-owned /
 * pinned launcher rules as add-ons.
 * @returns {{ ok: true, command: string, args: string[], envVars: string[] } | { ok: false, reason: string }}
 */
export function verifyBackendLaunch(connRef) {
  const r = parseLaunchSpec(connRef);
  return r.ok ? { ok: true, ...r.spec } : r;
}

/**
 * Owner action: approve the row's current connection_ref. When `expectedHash`
 * is given (the hash of the command the owner was shown), the approval only
 * lands if the row still carries exactly that command.
 */
export async function approveBackend(db, id, expectedHash) {
  const { rows } = await db.execute({
    sql: "SELECT id, connection_ref FROM data_backends WHERE id = ? AND backend_type = 'mcp_server'",
    args: [id],
  });
  if (!rows.length) return false;
  if (!parseStoredSpec(rows[0].connection_ref).ok) return false;
  if (expectedHash !== undefined && expectedHash !== refHash(rows[0].connection_ref)) return false;
  await db.execute({
    sql: "UPDATE data_backends SET approved_ref_sha256 = ?, status = 'disconnected', last_error = NULL, updated_at = datetime('now') WHERE id = ?",
    args: [refHash(rows[0].connection_ref), id],
  });
  return true;
}

/** Owner action: withdraw an approval (the row stays, it is no longer started). */
export async function revokeBackendApproval(db, id) {
  const r = await db.execute({
    sql: "UPDATE data_backends SET approved_ref_sha256 = NULL, status = ?, updated_at = datetime('now') WHERE id = ? AND backend_type = 'mcp_server'",
    args: [PENDING_STATUS, id],
  });
  return (r.rowsAffected ?? 0) > 0;
}

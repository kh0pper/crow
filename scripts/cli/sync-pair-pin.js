#!/usr/bin/env node
/**
 * `sync-pair-pin` — list, fingerprint and clear this instance's sync
 * pair-binding pin (PT-2a). The documented rollback escape hatch: if a peer
 * was pair-bound and then legitimately downgraded (older Crow, a rollback),
 * the owner clears the pin here and the peer syncs unbound again until its
 * next bound handshake re-pins it.
 *
 * Usage (this instance's env: CROW_DATA_DIR / CROW_DB_PATH, CROW_PEER_TOKENS_PATH):
 *   node scripts/cli/sync-pair-pin.js --list
 *   node scripts/cli/sync-pair-pin.js --fingerprint <peer-id>
 *   node scripts/cli/sync-pair-pin.js --clear <peer-id>
 *
 * LOCAL only: it never touches the peer, the credential store or any synced
 * row, and it refuses to run unless the caller owns the database file (so a
 * `sudo` run cannot leave root-owned -wal/-shm files under a live gateway).
 * The fingerprint is sha256(K_pb)[:8]; the key itself is never printed.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve as resolvePath, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createDbClient } from "../../servers/db.js";
import { resolveInstanceDataDir } from "../../servers/shared/crow-home.js";
import { ENROLL_ID_RE } from "../../servers/shared/enroll-guard.js";
import { defaultPairKey, pairSubkey } from "../../servers/shared/sync-pair-binding.js";
import { SYNC_PB_KEY_PREFIX, SYNC_PB_CLEARED_PREFIX } from "../../servers/shared/self-dial-address.js";
import { createNotification } from "../../servers/shared/notifications.js";

const USAGE = `Usage:
  node scripts/cli/sync-pair-pin.js --list
  node scripts/cli/sync-pair-pin.js --fingerprint <peer-id>
  node scripts/cli/sync-pair-pin.js --clear <peer-id>`;

/** sha256(K_pb)[:8] for a peer, or null when we hold no usable pair key. */
function fingerprint(peerId) {
  const key = defaultPairKey(peerId);
  if (!key) return null;
  return createHash("sha256").update(pairSubkey(key)).digest("hex").slice(0, 8);
}

function parse(argv) {
  const acts = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") acts.push({ act: "list" });
    else if (a === "--clear" || a === "--fingerprint") acts.push({ act: a.slice(2), peerId: argv[++i] });
    else return { error: `unknown argument ${JSON.stringify(String(a).slice(0, 40))}` };
  }
  if (acts.length !== 1) return { error: "give exactly one of --list, --clear <id>, --fingerprint <id>" };
  return acts[0];
}

async function localId(env) {
  const p = join(resolveInstanceDataDir(env), "instance-id");
  return existsSync(p) ? readFileSync(p, "utf-8").trim() : "";
}

async function peerRow(db, peerId) {
  if (typeof peerId !== "string" || !ENROLL_ID_RE.test(peerId)) return null;
  const { rows } = await db.execute({ sql: "SELECT id, name FROM crow_instances WHERE id = ?", args: [peerId] });
  return rows[0] || null;
}

async function overrideValue(db, id, key) {
  const { rows } = await db.execute({
    sql: "SELECT value FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ? LIMIT 1",
    args: [key, id],
  });
  return rows[0] ? String(rows[0].value) : null;
}

async function list(db, id, out) {
  const { rows } = await db.execute({ sql: "SELECT id FROM crow_instances WHERE trusted = 1 AND id != ? ORDER BY id", args: [id] });
  out("peerId  pinned  cleared-at  fingerprint-or-\"no key\"\n");
  for (const { id: peerId } of rows) {
    const pinned = Number(await overrideValue(db, id, `${SYNC_PB_KEY_PREFIX}${peerId}`)) >= 1;
    const cleared = (await overrideValue(db, id, `${SYNC_PB_CLEARED_PREFIX}${peerId}`)) || "-";
    out(`${peerId}  ${pinned ? "yes" : "no"}  ${cleared}  ${fingerprint(peerId) || "no key"}\n`);
  }
  return 0;
}

async function clear(db, id, row, out) {
  const pinKey = `${SYNC_PB_KEY_PREFIX}${row.id}`;
  const r = await db.execute({
    sql: "DELETE FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?",
    args: [pinKey, id],
  });
  if (!Number(r.rowsAffected ?? 0)) {
    out(`nothing to clear: ${row.id} has no pair-binding pin on this instance\n`);
    return 2;
  }
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO dashboard_settings_overrides (key, instance_id, value, updated_at)
          VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT(key, instance_id) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    args: [`${SYNC_PB_CLEARED_PREFIX}${row.id}`, id, now],
  });
  const msg = `pair-binding pin cleared for ${row.name} by the local CLI`;
  try {
    await createNotification(db, { title: msg, type: "system", source: "sync-pair-pin", priority: "normal" });
  } catch (err) {
    out(`warning: could not write the notification: ${err?.message || err}\n`);
  }
  console.error(`[sync-pair-pin] ${now} ${msg} (${row.id})`);
  out(`removed ${pinKey} for ${row.name} (${row.id}); recorded sync_pair_cleared:${row.id} = ${now}\n`);
  return 0;
}

/**
 * Run the CLI. `uid` is a test seam (defaults to process.getuid()). Returns
 * the exit code: 0 ok, 1 refused or bad input, 2 nothing matched.
 */
export async function main({ argv = process.argv.slice(2), env = process.env, uid = process.getuid?.(), stdout = process.stdout, stderr = process.stderr } = {}) {
  const out = (s) => stdout.write(s);
  const fail = (s) => { stderr.write(`${s}\n`); return 1; };
  const args = parse(argv);
  if (args.error) return fail(`${args.error}\n${USAGE}`);
  const dbPath = env.CROW_DB_PATH || resolvePath(resolveInstanceDataDir(env), "crow.db");
  let owner;
  try { owner = statSync(dbPath).uid; } catch { return fail(`cannot read the database at ${dbPath}`); }
  if (uid !== owner) return fail(`refusing: run this as the owner of ${dbPath} (uid ${owner}), not uid ${uid} (a sudo run would leave root-owned -wal/-shm files)`);

  // The credential store and data dir resolve from process.env; apply ours for the call.
  const keys = ["CROW_DATA_DIR", "CROW_DB_PATH", "CROW_PEER_TOKENS_PATH"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  let db;
  try {
    const id = await localId(env);
    if (!id) return fail("this instance has no instance-id yet (start its gateway once)");
    db = createDbClient(dbPath);
    if (args.act === "list") return await list(db, id, out);
    const row = await peerRow(db, args.peerId);
    if (!row) return fail(`${JSON.stringify(String(args.peerId ?? "").slice(0, 60))} is not a known peer of this instance`);
    if (args.act === "fingerprint") {
      const fp = fingerprint(row.id);
      if (!fp) return fail(`no pair key for ${row.id} in the credential store`);
      out(`${fp}\n`);
      return 0;
    }
    return await clear(db, id, row, out);
  } catch (err) {
    return fail(`sync-pair-pin failed: ${err?.message || err}`);
  } finally {
    try { db?.close?.(); } catch {}
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (err) => { console.error(err?.message || err); process.exit(1); });
}

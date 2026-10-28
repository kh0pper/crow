/**
 * Model roles: the snapshot pi reads, `$CROW_HOME/model-roles.json`.
 *
 * pi has no DB access, so the gateway writes each role's resolution (the full
 * walk), its chain, its filtered candidates and whether it lands in the cloud
 * to a mode-0600 file. The write is atomic and never follows a link: a fresh
 * temp file is created with O_EXCL (a planted temp path is refused, not
 * followed), fsynced, then renamed over the target (rename replaces a symlink
 * at the target instead of writing through it), then the directory is fsynced.
 * A reader sees the old file or the new one, never a partial one.
 *
 * The pi sub-agent map rides along only on the host-default home (~/.crow):
 * a co-hosted instance's pi is not this host's pi.
 */
import { open, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { CORE_ROLES, MEDIA_CAPABILITIES, SUBAGENT_MAP_KEY, resolveRoleKey, roleCandidates, isCloudKey } from "./model-roles.js";
import { loadRoleContext } from "./model-roles-store.js";
import { isDefaultCrowHome } from "./crow-home.js";
import { roleSnapshotPath } from "./model-roles-env.js";
import { readSetting } from "../gateway/dashboard/settings/registry.js";

/** Where pi looks for the snapshot: one definition, shared with the bridge. */
export { roleSnapshotPath };

export const ROLE_SNAPSHOT_VERSION = 1;

const EMPTY = Object.freeze({ resolved: null, chain: [], candidates: [], cloud: false });

/**
 * Pure: a RoleContext -> the snapshot object. Every core role plus every
 * custom role with a definition. A media role has no chat-style resolver yet
 * and is always empty.
 */
export function buildRoleSnapshot(ctx, { instanceId = null, now = new Date(), subagents = null } = {}) {
  const roles = {};
  const media = new Set(CORE_ROLES.filter((r) => MEDIA_CAPABILITIES.includes(r.capability)).map((r) => r.id));
  const ids = [...CORE_ROLES.map((r) => r.id), ...Object.keys(ctx?.customDefs || {})];
  for (const id of ids) {
    if (media.has(id)) { roles[id] = { ...EMPTY, chain: [], candidates: [] }; continue; }
    const r = resolveRoleKey(`role:${id}`, ctx);
    roles[id] = {
      resolved: r.key,
      chain: [...(r.chain || [])],
      candidates: roleCandidates(id, ctx),
      cloud: r.key ? isCloudKey(r.key, { providers: ctx.providers }) : false,
    };
  }
  const out = {
    version: ROLE_SNAPSHOT_VERSION,
    instance_id: instanceId,
    generated_at: new Date(now).toISOString(),
    roles,
  };
  if (subagents != null) out.subagents = subagents;
  return out;
}

function parseObject(raw) {
  if (raw == null) return null;
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Build and atomically publish the snapshot. `tmpSuffix` is a test seam only.
 * Rejects on any error (a planted temp path gives EEXIST); the temp file is
 * removed if this call created it.
 * @returns {Promise<{path:string}>}
 */
export async function writeRoleSnapshot(db, { path = roleSnapshotPath(), tmpSuffix } = {}) {
  const ctx = await loadRoleContext(db);
  const subagents = isDefaultCrowHome() ? parseObject(await readSetting(db, SUBAGENT_MAP_KEY)) : null;
  const snap = buildRoleSnapshot(ctx, { instanceId: ctx.ownInstanceId(), now: new Date(), subagents });
  const body = JSON.stringify(snap, null, 2) + "\n";

  const tmp = `${path}.tmp-${tmpSuffix ?? randomBytes(6).toString("hex")}`;
  let created = false;
  let fh = null;
  try {
    fh = await open(tmp, "wx", 0o600);
    created = true;
    await fh.chmod(0o600); // independent of the umask
    await fh.writeFile(body, "utf8");
    await fh.sync();
    await fh.close();
    fh = null;
    await rename(tmp, path);
    created = false;
    const dh = await open(dirname(path), "r");
    try { await dh.sync(); } finally { await dh.close(); }
    return { path };
  } catch (err) {
    if (fh) { try { await fh.close(); } catch { /* already closed */ } }
    // Never unlink a temp path someone else planted (EEXIST): it is not ours.
    if (created) { try { await unlink(tmp); } catch { /* gone */ } }
    throw err;
  }
}

let timer = null;

/**
 * Debounced, unref'd rewrite. Each run opens one client from dbFactory and
 * closes it in finally. Never throws.
 */
export function scheduleRoleSnapshot(dbFactory, { delayMs = 2000, path } = {}) {
  try {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      let db = null;
      try {
        db = dbFactory();
        await writeRoleSnapshot(db, path ? { path } : {});
      } catch (err) {
        console.warn(`[roles] snapshot write failed: ${err?.message}`);
      } finally {
        if (db) { try { db.close(); } catch { /* already closed */ } }
      }
    }, delayMs);
    timer.unref?.();
  } catch (err) {
    console.warn(`[roles] snapshot schedule failed: ${err?.message}`);
  }
}

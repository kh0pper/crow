#!/usr/bin/env node
/**
 * Smoke test: scoped-settings resolution + SYNC_ALLOWLIST enforcement.
 *
 * Uses an in-memory libsql db so it runs without touching ~/.crow/data.
 * Exercises:
 *   1. global write → readSetting returns value
 *   2. local write → readSetting returns local override
 *   3. deleteLocalSetting → readSetting returns global again
 *   4. non-allowlisted key at scope=global with allowLocalFallback=false throws NotSyncable
 *   5. non-allowlisted key at scope=global with default opts silently downgrades to local
 *   6. isSyncable matches prefixes and exact keys
 *
 * Usage: node scripts/smoke/settings-scope.js
 * Exits 0 on pass, non-zero on fail.
 */

import { createClient } from "@libsql/client";
import {
  readSetting,
  writeSetting,
  deleteLocalSetting,
  getSettingScope,
} from "../../servers/gateway/dashboard/settings/registry.js";
import { isSyncable } from "../../servers/gateway/dashboard/settings/sync-allowlist.js";

const db = createClient({ url: ":memory:" });

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

async function setup() {
  await db.execute(`
    CREATE TABLE dashboard_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      lamport_ts INTEGER DEFAULT 0
    )
  `);
  await db.execute(`
    CREATE TABLE dashboard_settings_overrides (
      key TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      lamport_ts INTEGER DEFAULT 0,
      PRIMARY KEY (key, instance_id)
    )
  `);
}

async function main() {
  console.log("== settings-scope smoke ==");
  await setup();

  // 1. allowlist membership
  assert(isSyncable("ai_profiles"), "isSyncable('ai_profiles') true");
  assert(isSyncable("integration_foo"), "isSyncable('integration_foo') true (prefix match)");
  assert(isSyncable("companion_persona"), "isSyncable('companion_persona') true (prefix match)");
  assert(!isSyncable("password_hash"), "isSyncable('password_hash') false");
  assert(!isSyncable(""), "isSyncable('') false");

  // 2. global write + read
  await writeSetting(db, "ai_profiles", "[\"globalA\"]");
  const v1 = await readSetting(db, "ai_profiles");
  assert(v1 === "[\"globalA\"]", `readSetting after global write → ${v1}`);
  assert((await getSettingScope(db, "ai_profiles")) === "global", "scope='global' after global write");

  // 3. local override
  await writeSetting(db, "ai_profiles", "[\"localB\"]", { scope: "local" });
  const v2 = await readSetting(db, "ai_profiles");
  assert(v2 === "[\"localB\"]", `readSetting after local write → ${v2} (local wins)`);
  assert((await getSettingScope(db, "ai_profiles")) === "local", "scope='local' after local write");

  // 4. delete local → restore global
  await deleteLocalSetting(db, "ai_profiles");
  const v3 = await readSetting(db, "ai_profiles");
  assert(v3 === "[\"globalA\"]", `readSetting after deleteLocal → ${v3}`);
  assert((await getSettingScope(db, "ai_profiles")) === "global", "scope='global' after deleteLocal");

  // 5. fail-closed on NotSyncable
  let threw = false;
  try {
    await writeSetting(db, "password_hash", "secret", { scope: "global", allowLocalFallback: false });
  } catch (err) {
    threw = err.code === "NotSyncable";
  }
  assert(threw, "writeSetting('password_hash', scope=global, allowLocalFallback=false) throws NotSyncable");

  // 6. silent fallback (preserves upsertSetting behavior)
  await writeSetting(db, "password_hash", "secret");
  const scope = await getSettingScope(db, "password_hash");
  assert(scope === "local", `password_hash silently downgrades to local scope (got ${scope})`);

  // 7. vision_profiles is allowlisted (Phase 1)
  assert(isSyncable("vision_profiles"), "isSyncable('vision_profiles') true (Phase 1)");
  await writeSetting(db, "vision_profiles", "[]", { scope: "local" });
  const vpScope = await getSettingScope(db, "vision_profiles");
  assert(vpScope === "local", `vision_profiles first-write local scope (got ${vpScope})`);
  const vpVal = await readSetting(db, "vision_profiles");
  assert(vpVal === "[]", `vision_profiles read-with-override → ${vpVal}`);

  // 8. resolve-provider: pointer-mode fallbacks + orchestrator default
  const { resolveOrchestratorDefault, listProviders } =
    await import("../../servers/gateway/ai/resolve-provider.js");
  const providers = listProviders();
  assert(providers.length > 0, `listProviders() returned ${providers.length} providers`);
  const def = resolveOrchestratorDefault();
  assert(!!def.baseUrl && !!def.model, `resolveOrchestratorDefault() → ${def.provider_id}/${def.model}`);

  console.log("\nPASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

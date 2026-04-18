#!/usr/bin/env node
/**
 * Smoke: verify pointer-mode profile → adapter resolution.
 *
 * Reads ai_profiles from the live DB, picks the first pointer-mode entry
 * (provider_id set, legacy baseUrl/apiKey stripped), and calls
 * createAdapterFromProfile(profile, model, db). A healthy result carries
 * a concrete apiKey (non-"none") and the provider row's baseUrl.
 *
 * Usage: node scripts/smoke/pointer-profile-adapter.js
 * Exits 0 on pass, non-zero on fail.
 */

import { createDbClient } from "../../servers/db.js";
import { getAiProfiles, createAdapterFromProfile } from "../../servers/gateway/ai/provider.js";

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const db = createDbClient();
let results = [];
try {
  const profiles = await getAiProfiles(db, { includeKeys: true });
  if (profiles.length === 0) fail("no ai_profiles configured — can't smoke pointer-mode path");
  const pointer = profiles.filter((p) => p?.provider_id);
  if (pointer.length === 0) fail("no pointer-mode profiles (all still direct-mode?)");

  for (const p of pointer) {
    // Verify legacy direct fields really are stripped
    if ("apiKey" in p && p.apiKey) {
      fail(`profile ${p.id} still has apiKey set — v3 strip didn't run`);
    }
    if ("baseUrl" in p && p.baseUrl) {
      fail(`profile ${p.id} still has baseUrl set — v3 strip didn't run`);
    }
    const { adapter, config } = await createAdapterFromProfile(p, p.defaultModel || p.model_id, db);
    if (!adapter) fail(`adapter missing for profile ${p.id}`);
    if (!config?.baseUrl) fail(`config.baseUrl missing for profile ${p.id}`);
    if (!config?.model) fail(`config.model missing for profile ${p.id}`);
    results.push({ id: p.id, name: p.name, provider: config.provider, baseUrl: config.baseUrl, model: config.model });
  }
} finally {
  db.close();
}

console.log(`PASS: resolved ${results.length} pointer-mode profile(s):`);
for (const r of results) {
  console.log(`  ${r.id}  ${r.name}  →  ${r.provider} @ ${r.baseUrl}  model=${r.model}`);
}
process.exit(0);

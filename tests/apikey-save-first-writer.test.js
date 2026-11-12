/**
 * The three options a generated-value save needs on top of the API-key card's save
 * (servers/gateway/bundle-apikey-save.js): `origin`, `propagate` and `firstWriterWins`.
 *
 * The card types a key a person brought: origin "typed", an overwrite is what they asked
 * for, and a docker bundle's gateway env gets the value. A run that MINTS a value (Crow's
 * API-token hand-over) wants the opposite, and this file pins that down:
 *
 *   1. with no option given, nothing changes — the card's save is the same call it was;
 *   2. `origin` is what the keychain row records;
 *   3. `propagate: false` writes the bundle's .env but never the gateway's own env;
 *   4. `firstWriterWins: true` stops before anything when the extension already holds a
 *      value (`hasValue`), writes the keychain row atomically (`remember`, and a null result
 *      writes nothing else at all), re-reads the bundle's own MCP entry (`mcpValue`) before
 *      writing it, and re-reads the bundle's .env before writing THAT — a real value there is
 *      kept and the save still answers ok (the keychain and MCP entry are already written),
 *      and a .env it cannot read at all is kept the same way.
 *      The two abandoned writes before the keychain are the same fixed 409 `has_value`.
 *
 * Every seam is injected: no keychain, no database, no mcp-addons.json, no containers.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { saveApiKey, API_KEY_SAVE_REFUSALS } = await import("../servers/gateway/bundle-apikey-save.js");

const TMP = mkdtempSync(join(tmpdir(), "crow-apikey-fw-"));
after(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

/** Distinctive enough that any leak into an answer is unmistakable. */
const VALUE = "sk-gen-VALUE-123456";

const MANIFEST = {
  id: "fw-demo",
  name: "Demo App",
  type: "mcp-server",
  env_vars: [
    { name: "DEMO_API_KEY", description: "the app's key", required: true, secret: true },
    { name: "DEMO_GENERATED", description: "minted by Crow", required: false, secret: true, generate: "secret" },
    { name: "DEMO_PLAIN", description: "not a secret", required: false },
  ],
};

/** A bundle dir with (optionally) an existing .env the save would update. */
function bundleDir(envText = "OTHER=1\n") {
  const dir = mkdtempSync(join(TMP, "bundle-"));
  mkdirSync(dir, { recursive: true });
  if (envText !== null) writeFileSync(join(dir, ".env"), envText, { mode: 0o600 });
  return dir;
}

function seamDeps({ dir = null, ...over } = {}) {
  const calls = { save: [], remember: [], env: [], propagate: [], hasValue: [], mcpValue: [] };
  const deps = {
    bundleDir: dir || join(TMP, "no-such-bundle"),
    findInvalidEnv: () => null,
    envPatternViolation: () => null,
    openDb: () => ({ close() {} }),
    ensureWriteKey: async () => ({ id: "key-1", seed: Buffer.alloc(32) }),
    save: async (_db, _key, entry) => { calls.save.push(entry); return { id: 1, created: true }; },
    remember: async (_db, _key, entry) => { calls.remember.push(entry); return 7; },
    hasValue: async (id, key) => { calls.hasValue.push([id, key]); return false; },
    mcpValue: (id, key) => { calls.mcpValue.push([id, key]); return ""; },
    applyEnv: async (id, values) => { calls.env.push({ id, values }); return true; },
    propagate: (id, values) => { calls.propagate.push({ id, values }); return true; },
    needsConfig: () => [],
    now: () => Date.parse("2026-11-12T09:00:00Z"),
    warn: () => {},
    ...over,
  };
  return { deps, calls };
}

const save = (deps, extra = {}) => saveApiKey({ bundleId: "fw-demo", manifest: MANIFEST, envKey: "DEMO_API_KEY", value: VALUE, deps, ...extra });

// ── 1. no option given = today's save ───────────────────────────────────────────────

test("with no new option, the card's save is exactly what it was: typed, overwriting, propagated", async () => {
  const dir = bundleDir("OTHER=1\nDEMO_API_KEY=\n");
  const { deps, calls } = seamDeps({ dir });
  const out = await save(deps);
  assert.deepEqual(out, { ok: true, needs_restart: true, needs_config: [] });
  assert.equal(calls.save.length, 1, "the overwriting keychain write is the one used");
  assert.equal(calls.remember.length, 0, "the atomic first-writer-wins write is opt-in");
  assert.equal(calls.save[0].origin, "typed");
  assert.equal(calls.save[0].secret, VALUE);
  assert.equal(calls.hasValue.length, 0, "nothing asks whether a value already exists");
  assert.equal(calls.mcpValue.length, 0);
  assert.deepEqual(calls.env.map((c) => c.values), [{ DEMO_API_KEY: VALUE }]);
  assert.equal(calls.propagate.length, 1, "the gateway env gets the key, as before");
  assert.match(readFileSync(join(dir, ".env"), "utf8"), /DEMO_API_KEY=sk-gen-VALUE-123456/);
  assert.equal(JSON.stringify(out).includes(VALUE), false);
});

// ── 2. origin ───────────────────────────────────────────────────────────────────────

test("origin is what the keychain row records, on both write paths", async () => {
  const { deps, calls } = seamDeps();
  await save(deps, { origin: "generated" });
  assert.equal(calls.save[0].origin, "generated");

  const first = seamDeps();
  await save(first.deps, { origin: "generated", firstWriterWins: true });
  assert.equal(first.calls.remember[0].origin, "generated");
  assert.equal(first.calls.remember[0].label, "Demo App - DEMO_API_KEY");
  assert.equal(first.calls.save.length, 0, "a first-writer-wins save never takes the overwriting path");
});

// ── 3. propagate ────────────────────────────────────────────────────────────────────

test("propagate: false writes the bundle's .env but never the gateway's own env", async () => {
  const dir = bundleDir("DEMO_API_KEY=\n");
  const { deps, calls } = seamDeps({ dir });
  const out = await save(deps, { propagate: false });
  assert.equal(calls.propagate.length, 0, "the gateway env is not touched");
  assert.match(readFileSync(join(dir, ".env"), "utf8"), /DEMO_API_KEY=sk-gen-VALUE-123456/, "the bundle's own .env still gets it");
  assert.equal(out.ok, true);
  // Only the MCP entry was written, so a restart is still what applies it.
  assert.equal(out.needs_restart, true);
  const quiet = seamDeps({ dir, applyEnv: async () => false });
  const stillOk = await save(quiet.deps, { propagate: false });
  assert.equal(stillOk.needs_restart, false, "nothing written past the keychain needs a restart");
  assert.equal(quiet.calls.propagate.length, 0);
});

// ── 4. firstWriterWins ──────────────────────────────────────────────────────────────

test("firstWriterWins: a value the extension already has stops the save before anything is written", async () => {
  const dir = bundleDir("OTHER=1\nDEMO_API_KEY=\n");
  const { deps, calls } = seamDeps({ dir, hasValue: async (id, key) => { calls.hasValue.push([id, key]); return true; } });
  const out = await save(deps, { firstWriterWins: true });
  assert.deepEqual(out, { ok: false, status: 409, error: API_KEY_SAVE_REFUSALS.has_value });
  assert.equal(out.error, "This extension already has a value for that key; Crow left it alone.");
  assert.deepEqual(calls.hasValue, [["fw-demo", "DEMO_API_KEY"]]);
  assert.equal(calls.save.length + calls.remember.length, 0, "no keychain write");
  assert.equal(calls.env.length, 0, "no MCP entry write");
  assert.equal(calls.propagate.length, 0);
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), "OTHER=1\nDEMO_API_KEY=\n", "the .env is untouched");
  assert.equal(JSON.stringify(out).includes(VALUE), false);
  // The check comes first: even a value this save would have refused is "already set".
  const empty = await save({ ...deps, hasValue: async () => true }, { firstWriterWins: true, value: "" });
  assert.equal(empty.error, API_KEY_SAVE_REFUSALS.has_value);
});

test("firstWriterWins: a keychain write that another writer won writes nothing else at all", async () => {
  const dir = bundleDir("DEMO_API_KEY=\n");
  const { deps, calls } = seamDeps({ dir, remember: async (_db, _key, entry) => { calls.remember.push(entry); return null; } });
  const out = await save(deps, { firstWriterWins: true });
  assert.deepEqual(out, { ok: false, status: 409, error: API_KEY_SAVE_REFUSALS.has_value });
  assert.equal(calls.remember.length, 1);
  assert.equal(calls.save.length, 0);
  assert.equal(calls.env.length, 0, "the MCP entry was not written");
  assert.equal(calls.propagate.length, 0);
  assert.equal(calls.mcpValue.length, 0, "nothing is re-read after a lost race");
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), "DEMO_API_KEY=\n", "the .env was not written");
});

test("firstWriterWins: the MCP entry is re-read (not hasValue), and a value found there is left alone", async () => {
  const dir = bundleDir("DEMO_API_KEY=\n");
  const { deps, calls } = seamDeps({ dir, mcpValue: (id, key) => { calls.mcpValue.push([id, key]); return "someone-elses-key"; } });
  const out = await save(deps, { firstWriterWins: true });
  assert.deepEqual(out, { ok: false, status: 409, error: API_KEY_SAVE_REFUSALS.has_value });
  assert.deepEqual(calls.hasValue, [["fw-demo", "DEMO_API_KEY"]], "hasValue is asked exactly once — before the write");
  assert.deepEqual(calls.mcpValue, [["fw-demo", "DEMO_API_KEY"]], "and the entry is re-read right before step 2");
  assert.equal(calls.remember.length, 1);
  assert.equal(calls.env.length, 0, "the entry the operator already had is not overwritten");
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), "DEMO_API_KEY=\n");
});

test("firstWriterWins: a placeholder in the MCP entry is not a value — the save finishes", async () => {
  for (const placeholder of ["", "   ", "/path/to/token", "change-me"]) {
    // A fresh .env per iteration: an earlier iteration's write is a REAL value now, and a
    // first-writer-wins save would (rightly) leave it alone.
    const dir = bundleDir("DEMO_API_KEY=\n");
    const { deps, calls } = seamDeps({ dir, mcpValue: () => placeholder });
    const out = await save(deps, { firstWriterWins: true });
    assert.equal(out.ok, true, JSON.stringify(placeholder));
    assert.equal(out.needs_restart, true);
    assert.equal(calls.remember.length, 1);
    assert.deepEqual(calls.env.map((c) => c.values), [{ DEMO_API_KEY: VALUE }], JSON.stringify(placeholder));
    assert.equal(calls.propagate.length, 1, "propagate defaults to true for the new path too");
    assert.equal(calls.hasValue.length, 1);
  }
});

test("firstWriterWins: a hasValue that cannot answer is not a refusal", async () => {
  const { deps, calls } = seamDeps({ hasValue: async () => { throw new Error("no such table: crow_keychain"); } });
  const out = await save(deps, { firstWriterWins: true });
  assert.equal(out.ok, true, "a fresh home with no keychain table still saves");
  assert.equal(calls.remember.length, 1);
});

test("firstWriterWins: a real value already in the bundle's .env is left alone, and the save still answers ok", async () => {
  const dir = bundleDir("OTHER=1\nDEMO_API_KEY=the-operators-own-key\n");
  const { deps, calls } = seamDeps({ dir });
  const out = await save(deps, { firstWriterWins: true });
  // The keychain row and the MCP entry were written BEFORE the .env is read, so the .env is
  // skipped rather than refused — the add-on keeps the operator's value (known, harmless).
  assert.equal(out.ok, true, "not a failure: the earlier writes stand");
  assert.equal(out.needs_restart, true, "the MCP entry was written, so a restart applies it");
  assert.equal(calls.remember.length, 1, "the keychain row stays");
  assert.deepEqual(calls.env.map((c) => c.values), [{ DEMO_API_KEY: VALUE }], "the MCP entry is written");
  assert.equal(
    readFileSync(join(dir, ".env"), "utf8"),
    "OTHER=1\nDEMO_API_KEY=the-operators-own-key\n",
    "the operator's value is not overwritten",
  );
  assert.equal(calls.propagate.length, 0, "nothing was written to the .env, so the gateway env is untouched");
  assert.equal(JSON.stringify(out).includes(VALUE), false);
});

test("firstWriterWins: a .env that cannot be read is KEPT, and the save still answers ok", async () => {
  // A .env the save cannot inspect is never replaced on a guess: it is treated exactly like
  // one holding the operator's own value (skip the write, keep the earlier keychain/MCP
  // writes). Mode 000 is the unreadable file; run as root it reads fine and holds a real
  // value, which is the same "keep" answer.
  const dir = bundleDir(null);
  const envPath = join(dir, ".env");
  const original = "DEMO_API_KEY=the-operators-own-key\n";
  writeFileSync(envPath, original, { mode: 0o000 });
  const { deps, calls } = seamDeps({ dir });
  const out = await save(deps, { firstWriterWins: true });
  assert.equal(out.ok, true, "an .env Crow cannot read is not a failure");
  assert.equal(out.needs_restart, true, "the MCP entry was written, so a restart applies it");
  assert.equal(calls.remember.length, 1, "the keychain row is written");
  assert.deepEqual(calls.env.map((c) => c.values), [{ DEMO_API_KEY: VALUE }], "the MCP entry is written");
  assert.equal(calls.propagate.length, 0, "nothing was written to the .env, so the gateway env is untouched");
  chmodSync(envPath, 0o600); // read it back: Crow could not, this test can
  assert.equal(readFileSync(envPath, "utf8"), original, "the file is left exactly as it was");
  assert.equal(JSON.stringify(out).includes(VALUE), false);
});

test("firstWriterWins: a placeholder in the .env is not a value — the .env write happens", async () => {
  for (const placeholder of ["", "change-me", "/path/to/token"]) {
    const dir = bundleDir(`OTHER=1\nDEMO_API_KEY=${placeholder}\n`);
    const { deps, calls } = seamDeps({ dir });
    const out = await save(deps, { firstWriterWins: true });
    assert.equal(out.ok, true, JSON.stringify(placeholder));
    assert.match(readFileSync(join(dir, ".env"), "utf8"), /DEMO_API_KEY=sk-gen-VALUE-123456/, JSON.stringify(placeholder));
    assert.equal(calls.propagate.length, 1, JSON.stringify(placeholder));
  }
});

test("firstWriterWins: the .env is re-read only on that path — a typed save still overwrites", async () => {
  const dir = bundleDir("DEMO_API_KEY=the-operators-own-key\n");
  const { deps } = seamDeps({ dir });
  const out = await save(deps);
  assert.equal(out.ok, true);
  assert.match(readFileSync(join(dir, ".env"), "utf8"), /DEMO_API_KEY=sk-gen-VALUE-123456/, "the card's save still overwrites");
});

test("firstWriterWins refuses the same env names as the card, before asking about a value", async () => {
  const { deps, calls } = seamDeps();
  for (const [envKey, re] of [["NOT_DECLARED", /does not declare/], ["DEMO_GENERATED", /generates that value/], ["DEMO_PLAIN", /not a secret/]]) {
    const out = await saveApiKey({ bundleId: "fw-demo", manifest: MANIFEST, envKey, value: VALUE, deps, firstWriterWins: true });
    assert.equal(out.ok, false);
    assert.match(out.error, re);
  }
  assert.equal(calls.hasValue.length, 0, "the declaration is checked first");
});
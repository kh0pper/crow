/**
 * Campaigns + tax get generated data keys (recovery keys, queue item 30, decided 2026-10-16):
 * generated at install, saved to the keychain, reaching the MCP child through its
 * mcp-addons entry and the dashboard panels in the same order. Tax uploads are stored
 * encrypted; an install still on the example key published in the repo moves to a new key.
 * Scratch CROW_HOME / CROW_DATA_DIR; no docker, no network.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { rmScratch } from "./helpers/safe-rm.js";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TMP_HOME = mkdtempSync(join(tmpdir(), "crow-ctkeys-home-"));
process.env.CROW_HOME = TMP_HOME;
const TMP_DATA = mkdtempSync(join(tmpdir(), "crow-ctkeys-data-"));
process.env.CROW_DATA_DIR = TMP_DATA;
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
delete process.env.CROW_TAX_ENCRYPTION_KEY;
delete process.env.CROW_CAMPAIGNS_ENCRYPTION_KEY;
execFileSync(process.execPath, ["scripts/init-db.js"], { env: process.env, stdio: "pipe" });
const HOME = process.env.CROW_HOME;
after(() => { for (const d of [TMP_HOME, TMP_DATA]) rmScratch(d); });

const REPO = fileURLToPath(new URL("..", import.meta.url));
const manifestOf = (id) => JSON.parse(readFileSync(join(REPO, "bundles", id, "manifest.json"), "utf8"));
const specOf = (id, k) => manifestOf(id).env_vars.find((v) => v.name === k);
const S = await import("../servers/gateway/bundle-env-secrets.js");
const { validateManifest } = await import("../scripts/lib/bundle-contract.mjs");
const D = await import("../bundles/tax/server/documents-crypto.js");
const EXAMPLE = "change-this-to-a-strong-passphrase";

test("both data keys are generated, saved to the keychain, and reach only their own MCP entry", () => {
  for (const [id, k] of [["campaigns", "CROW_CAMPAIGNS_ENCRYPTION_KEY"], ["tax", "CROW_TAX_ENCRYPTION_KEY"]]) {
    const v = specOf(id, k);
    assert.equal(v.generate, "secret", `${id} generate`);
    assert.equal(v.keychain, true, `${id} keychain`);
    assert.equal(v.keychain_label, "data encryption key");
    assert.ok(manifestOf(id).server.envKeys.includes(k), `${id}: in server.envKeys, so the MCP entry gets it`);
    assert.equal(S.gatewayGeneratedKeys(manifestOf(id)).includes(k), false, `${id}: never the shared gateway .env`);
    assert.deepEqual(validateManifest(manifestOf(id), join(REPO, "bundles", id)).errors || [], [], `${id} manifest contract`);
  }
  assert.doesNotMatch(readFileSync(join(REPO, "bundles", "tax", ".env.example"), "utf8"), /^CROW_TAX_ENCRYPTION_KEY=/m);
});

test("the tax manifest says honestly what is and is not encrypted", () => {
  const notes = manifestOf("tax").notes;
  assert.match(notes, /returns and uploaded documents are encrypted at rest/);
  assert.match(notes, /stored unencrypted/);
  assert.doesNotMatch(notes, /PII is encrypted at rest/);
});

test("an install still on the example key published in the repo gets a new key; the old one moves to the previous slot", () => {
  const m = manifestOf("tax");
  const destDir = mkdtempSync(join(tmpdir(), "crow-ctkeys-dest-"));
  writeFileSync(join(destDir, ".env"), `CROW_TAX_ENCRYPTION_KEY=${EXAMPLE}\n`);
  const plan = S.planGeneratedEnv("tax", m, { destDir, crowHome: HOME });
  assert.notEqual(plan.env.CROW_TAX_ENCRYPTION_KEY, EXAMPLE);
  assert.ok(plan.minted.CROW_TAX_ENCRYPTION_KEY, "the new key is minted, so it goes to the keychain");
  assert.equal(plan.env.CROW_TAX_ENCRYPTION_KEY_PREVIOUS, EXAMPLE, "returns saved with it still open and move to the new key");
  assert.deepEqual(plan.replaced, ["CROW_TAX_ENCRYPTION_KEY"]);
  // A previous slot already in use is never overwritten (it may hold the only copy of an older key).
  writeFileSync(join(destDir, ".env"), `CROW_TAX_ENCRYPTION_KEY=${EXAMPLE}\nCROW_TAX_ENCRYPTION_KEY_PREVIOUS=older-key-1234567890\n`);
  const kept = S.planGeneratedEnv("tax", m, { destDir, crowHome: HOME });
  assert.equal(kept.env.CROW_TAX_ENCRYPTION_KEY, EXAMPLE);
  assert.equal(kept.env.CROW_TAX_ENCRYPTION_KEY_PREVIOUS, undefined);
  assert.deepEqual(kept.replaceSkipped, ["CROW_TAX_ENCRYPTION_KEY"], "the install log says why it was left");
  // A typed key of the user's own is kept as it is.
  writeFileSync(join(destDir, ".env"), "CROW_TAX_ENCRYPTION_KEY=my-own-key-0987654321\n");
  assert.equal(S.planGeneratedEnv("tax", m, { destDir, crowHome: HOME }).env.CROW_TAX_ENCRYPTION_KEY, "my-own-key-0987654321");
  rmSync(destDir, { recursive: true, force: true });
});

test("replace_values_sha256 is validated: hex digests, and it needs generate + previous_key", () => {
  const base = { id: "x", name: "X", version: "1.0.0", type: "mcp-server", category: "misc", description: "d", server: { command: "node", args: ["s.js"] } };
  const bad = validateManifest({ ...base, env_vars: [{ name: "K", secret: true, replace_values_sha256: ["nothex"] }] }, "/nonexistent").errors.join("\n");
  assert.match(bad, /replace_values_sha256 must be/);
  const lone = validateManifest({ ...base, env_vars: [{ name: "K", secret: true, generate: "secret", replace_values_sha256: ["a".repeat(64)] }] }, "/nonexistent").errors.join("\n");
  assert.match(lone, /needs generate and previous_key/);
});

function writeAddons(obj) {
  writeFileSync(join(HOME, "mcp-addons.json"), JSON.stringify(obj), { mode: 0o600 });
}

test("the campaigns panel reads its key in the MCP child's order: the instance's MCP entry first, then the gateway env", async () => {
  const { campaignsKey } = await import("../bundles/campaigns/server/key.js");
  writeAddons({ campaigns: { env: { CROW_CAMPAIGNS_ENCRYPTION_KEY: "from-entry" } } });
  assert.equal(campaignsKey({ CROW_HOME: HOME }), "from-entry");
  assert.equal(campaignsKey({ CROW_HOME: HOME, CROW_CAMPAIGNS_ENCRYPTION_KEY: "from-gateway-env" }), "from-entry", "the entry wins, as in proxy.js");
  writeAddons({});
  assert.equal(campaignsKey({ CROW_HOME: HOME, CROW_CAMPAIGNS_ENCRYPTION_KEY: "from-gateway-env" }), "from-gateway-env");
});

// --- the tax panel, mounted as the gateway mounts it ---
const TAX_KEY = "tax-key-" + "t".repeat(40);
const PDF = Buffer.from("%PDF-1.4\n% fake 1099 with SSN 000-00-0000\n%%EOF\n");
const { createDbClient } = await import("../servers/db.js");

async function mountTax() {
  const { default: taxRouter, taxKeys } = await import("../bundles/tax/panel/routes.js");
  const app = express();
  app.use((req, res, next) => { res.redirectAfterPost = (u) => res.redirect(303, u); next(); });
  app.use(taxRouter((req, res, next) => next()));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  after(() => server.close());
  return { base: `http://127.0.0.1:${server.address().port}`, taxKeys };
}

test("tax panel: an upload is stored ONLY encrypted (key from the MCP entry, none in the gateway env); delete removes it", async () => {
  writeAddons({ tax: { env: { CROW_TAX_ENCRYPTION_KEY: TAX_KEY } } });
  const docs = join(HOME, "tax-documents");
  // A document stored before this change: plain, in the documents folder.
  mkdirSync(docs, { recursive: true });
  const old = join(docs, "100-old-w2.pdf");
  writeFileSync(old, PDF);
  const db0 = createDbClient();
  await db0.execute(`CREATE TABLE IF NOT EXISTS tax_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL, doc_type TEXT NOT NULL, owner TEXT DEFAULT 'taxpayer', file_path TEXT NOT NULL, status TEXT DEFAULT 'uploaded', return_id TEXT, extracted_data TEXT, confidence TEXT, warnings TEXT, uploaded_at TEXT DEFAULT (datetime('now')), ingested_at TEXT)`);
  await db0.execute({ sql: "INSERT INTO tax_documents (filename, doc_type, file_path) VALUES ('old-w2.pdf', 'w2', ?)", args: [old] });
  db0.close();

  const { base, taxKeys } = await mountTax();
  assert.equal(taxKeys().key, TAX_KEY);

  // The panel's start-up pass encrypts the old document (verified, then the plain file goes).
  for (let i = 0; i < 100 && existsSync(old); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(existsSync(old), false, "the plain document was encrypted at start-up");

  const fd = new FormData();
  fd.append("doc_type", "1099-int");
  fd.append("document", new Blob([PDF], { type: "application/pdf" }), "my 1099.pdf");
  const res = await fetch(`${base}/api/tax/upload`, { method: "POST", body: fd });
  assert.equal(res.status, 201, await res.clone().text());
  const body = await res.json();
  const stored = readdirSync(docs).filter((f) => !f.startsWith("."));
  assert.equal(stored.length, 2);
  for (const f of stored) {
    assert.match(f, /\.enc$/);
    const buf = readFileSync(join(docs, f));
    assert.equal(D.isEncryptedDocument(buf), true);
    assert.equal(buf.includes(Buffer.from("000-00-0000")), false, "no plaintext on disk");
    assert.ok((await D.decryptDocument(buf, [TAX_KEY])).plain.equals(PDF));
  }

  const del = await fetch(`${base}/api/tax/documents/${body.id}/delete`, { method: "POST", headers: { accept: "application/json" } });
  assert.equal(del.status, 200);
  assert.equal(readdirSync(docs).filter((f) => !f.startsWith(".")).length, 1);
});

test("tax panel: delete never removes a file outside the documents folder, whatever the row says", async () => {
  const { base } = await mountTax();
  const outside = join(HOME, "not-a-tax-document.txt");
  writeFileSync(outside, "keep me");
  const db = createDbClient();
  await db.execute({ sql: "INSERT INTO tax_documents (filename, doc_type, file_path) VALUES ('x', 'w2', ?)", args: [outside] });
  const id = Number((await db.execute("SELECT max(id) AS id FROM tax_documents")).rows[0].id);
  db.close();
  await fetch(`${base}/api/tax/documents/${id}/delete`, { method: "POST", headers: { accept: "application/json" } });
  assert.equal(readFileSync(outside, "utf8"), "keep me");
});

test("tax panel: no key yet → an upload is refused, nothing is written", async () => {
  writeAddons({});
  const { base } = await mountTax();
  const count = () => readdirSync(join(HOME, "tax-documents")).filter((f) => !f.startsWith(".")).length;
  const before = count();
  const fd = new FormData();
  fd.append("doc_type", "w2");
  fd.append("document", new Blob([PDF], { type: "application/pdf" }), "w2.pdf");
  const res = await fetch(`${base}/api/tax/upload`, { method: "POST", body: fd });
  assert.equal(res.status, 409);
  assert.equal(count(), before);
});

test("the MCP ingest tool opens a stored encrypted document with the tax key", async () => {
  const { ingestDocument } = await import("../bundles/tax/engine/ingest/index.js");
  const p = join(HOME, "tax-documents", "x.pdf.0123abcd.enc");
  D.writePrivateAtomic(p, await D.encryptDocument(PDF, TAX_KEY));
  // The fake PDF has no fields, so extraction fails — but only AFTER it was decrypted.
  await assert.rejects(ingestDocument(p, "w2", { keys: [TAX_KEY] }), /All extraction methods failed/);
  await assert.rejects(ingestDocument(p, "w2", { keys: ["wrong-" + "w".repeat(40)] }), /different tax key/);
  // The path comes from the AI: nothing but a bounded regular .pdf/.enc file is ever read.
  await assert.rejects(ingestDocument("/dev/zero", "w2"), /Only PDF files/);
  const { symlinkSync } = await import("node:fs");
  const dev = join(HOME, "zero.pdf");
  symlinkSync("/dev/zero", dev);
  await assert.rejects(ingestDocument(dev, "w2"), /Not a regular file/);
});

test("a version bump ships tax's engine/ and pdf/ to the installed copy (the panel imports the installed engine)", () => {
  const src = readFileSync(join(REPO, "servers", "gateway", "routes", "bundles.js"), "utf8");
  const nonDocker = src.match(/: \["server", "panel", "skills", "curriculum"[^\]]*\]/)[0];
  assert.match(nonDocker, /"engine"/);
  assert.match(nonDocker, /"pdf"/);
});

// tests/llm-cloud-token.test.js — the per-boot cloud-door token (roles phase 2
// Task 14): rotated every boot, file 0600 outside <crowHome>/secrets/ (bots
// must read it; bwrap hides secrets/), and accepted for the cloud door only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, statSync, readFileSync, readdirSync } from "node:fs";
import { rmScratch } from "./helpers/safe-rm.js";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { createDbClient } from "../servers/db.js";
import {
  rotateLlmCloudToken, validateLlmCloudToken, llmCloudTokenPath,
  generateModelsToken, generateLocalToken, generateBoardToken,
  generatePhoneToken, generateArtifactsToken, generateKioskAnnounceToken,
} from "../servers/gateway/local-token.js";

const home = mkdtempSync(join(tmpdir(), "llm-cloud-token-"));
const dataDir = join(home, "data");
execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dataDir }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
const prev = process.env.CROW_HOME;
process.env.CROW_HOME = home;
const db = createDbClient(join(dataDir, "crow.db"));
after(() => {
  if (prev === undefined) delete process.env.CROW_HOME; else process.env.CROW_HOME = prev;
  try { db.close(); } catch {}
  rmScratch(home);
});

test("each rotation gives a new 64-hex token and only the latest validates", async () => {
  const a = await rotateLlmCloudToken(db);
  const b = await rotateLlmCloudToken(db);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.match(b, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
  assert.equal(await validateLlmCloudToken(db, a), false, "the previous token is dead");
  assert.equal(await validateLlmCloudToken(db, b), true);
  assert.equal(await validateLlmCloudToken(db, b + "x"), false);
  assert.equal(await validateLlmCloudToken(db, ""), false);
  assert.equal(await validateLlmCloudToken(db, undefined), false);
});

test("the file is 0600, holds the latest token, and lives outside <crowHome>/secrets/", async () => {
  const t = await rotateLlmCloudToken(db);
  const p = llmCloudTokenPath();
  assert.equal(p, join(home, "llm-cloud-token"));
  const rel = relative(home, p);
  assert.ok(!(rel === "secrets" || rel.startsWith("secrets" + sep)), "not under secrets/ (bwrap hides it from bots)");
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.equal(readFileSync(p, "utf8").trim(), t);
  const leftovers = readdirSync(home).filter((n) => n.startsWith("llm-cloud-token") && n !== "llm-cloud-token");
  assert.deepEqual(leftovers, [], "no temp file left behind by the atomic write");
});

test("no other token kind validates at the cloud door, the models token included", async () => {
  await rotateLlmCloudToken(db);
  const others = {
    models: await generateModelsToken(db),
    local: await generateLocalToken(db),
    board: await generateBoardToken(db),
    phone: await generatePhoneToken(db),
    artifacts: await generateArtifactsToken(db),
    kiosk: await generateKioskAnnounceToken(db),
  };
  for (const [kind, tok] of Object.entries(others)) {
    assert.equal(await validateLlmCloudToken(db, tok), false, `${kind} token must not open the cloud door`);
  }
});

test("boot wiring: the cloud-door token is rotated (not ensured) at every boot, with its own DB client", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "servers", "gateway", "boot", "mcp-mounts.js"), "utf8");
  const call = src.indexOf("rotateLlmCloudToken(");
  assert.ok(call > 0, "rotateLlmCloudToken is called at boot");
  const phone = src.indexOf("const phoneServerDir");
  assert.ok(phone < 0 || call < phone, "the call sits before (outside) the phone-bundle branch");
  const block = src.slice(src.lastIndexOf("try {", src.lastIndexOf("try {", call) - 1), call);
  assert.match(block, /createDbClient\(\)/, "with its own DB client");
  assert.doesNotMatch(src, /ensureLlmCloudToken/, "no idempotent ensure: a fresh token every start");
});

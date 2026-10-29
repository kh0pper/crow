// tests/llm-cloud-token.test.js — the per-boot cloud-door token (roles phase 2
// Task 14): rotated every boot, file 0600 outside <crowHome>/secrets/ (bots
// must read it; bwrap hides secrets/), and accepted for the cloud door only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, statSync, readFileSync, readdirSync, chmodSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { rmScratch } from "./helpers/safe-rm.js";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { createDbClient } from "../servers/db.js";
import {
  rotateLlmCloudToken, validateLlmCloudToken, llmCloudTokenPath, LLM_CLOUD_TOKEN_KEYS,
  generateModelsToken, generateLocalToken, generateBoardToken,
  generatePhoneToken, generateArtifactsToken, generateKioskAnnounceToken,
  validateModelsToken, validateLocalToken, validateBoardToken,
  validatePhoneToken, validateArtifactsToken, validateKioskAnnounceToken,
} from "../servers/gateway/local-token.js";
import { readSetting } from "../servers/gateway/dashboard/settings/registry.js";
import { rotateCloudDoorTokenAtBoot } from "../servers/gateway/boot/mcp-mounts.js";

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

test("only sha256(token) is stored in the setting, never the raw token", async () => {
  const t = await rotateLlmCloudToken(db);
  const stored = await readSetting(db, LLM_CLOUD_TOKEN_KEYS.HASH);
  assert.notEqual(stored, t);
  assert.ok(!String(stored).includes(t), "the raw token does not appear in the setting");
  assert.equal(stored, createHash("sha256").update(t).digest("hex"));
});

test("a failed file write leaves the old token and the old hash matching", async (t) => {
  if (process.getuid && process.getuid() === 0) { t.skip("root ignores directory permissions"); return; }
  const before = await rotateLlmCloudToken(db);
  const hashBefore = await readSetting(db, LLM_CLOUD_TOKEN_KEYS.HASH);
  chmodSync(home, 0o500); // the temp file cannot be created in <crowHome>
  try {
    await assert.rejects(() => rotateLlmCloudToken(db));
  } finally {
    chmodSync(home, 0o700);
  }
  assert.equal(await readSetting(db, LLM_CLOUD_TOKEN_KEYS.HASH), hashBefore, "hash untouched");
  assert.equal(readFileSync(llmCloudTokenPath(), "utf8").trim(), before, "file untouched");
  assert.equal(await validateLlmCloudToken(db, before), true, "the old token still validates");
  assert.deepEqual(readdirSync(home).filter((n) => n.endsWith(".tmp")), [], "no temp file left");
});

test("a failed rename puts the old hash back", async () => {
  const before = await rotateLlmCloudToken(db);
  // A non-empty directory where the file goes makes the rename fail.
  rmSync(llmCloudTokenPath());
  mkdirSync(llmCloudTokenPath());
  writeFileSync(join(llmCloudTokenPath(), "x"), "x");
  try {
    await assert.rejects(() => rotateLlmCloudToken(db));
    assert.equal(await validateLlmCloudToken(db, before), true, "the old hash was restored");
    assert.deepEqual(readdirSync(home).filter((n) => n.endsWith(".tmp")), [], "no temp file left");
  } finally {
    rmSync(llmCloudTokenPath(), { recursive: true, force: true });
  }
  await rotateLlmCloudToken(db); // leave a normal file for later tests
});

test("final F3a: a failed rename whose hash restore also fails warns with the error message only", async () => {
  await rotateLlmCloudToken(db);
  rmSync(llmCloudTokenPath());
  mkdirSync(llmCloudTokenPath());
  writeFileSync(join(llmCloudTokenPath(), "x"), "x");
  // A DB whose first write (the new hash) lands and every later write fails.
  let writes = 0;
  const flaky = {
    execute(q) {
      const sql = typeof q === "string" ? q : q.sql;
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql) && ++writes > 1) return Promise.reject(new Error("restore write refused"));
      return db.execute(q);
    },
  };
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.map(String).join(" "));
  try {
    await assert.rejects(() => rotateLlmCloudToken(flaky));
  } finally {
    console.warn = orig;
    rmSync(llmCloudTokenPath(), { recursive: true, force: true });
  }
  assert.equal(warns.length, 1, JSON.stringify(warns));
  assert.match(warns[0], /restore write refused/);
  assert.match(warns[0], /llm-cloud-token|cloud/i);
  assert.ok(!/[0-9a-f]{64}/.test(warns[0]), "no token or hash in the line");
  await rotateLlmCloudToken(db); // leave a normal file and hash for later tests
});

test("the cloud token opens nothing else: every other validator refuses it", async () => {
  const cloud = await rotateLlmCloudToken(db);
  const validators = {
    models: validateModelsToken, local: validateLocalToken, board: validateBoardToken,
    phone: validatePhoneToken, artifacts: validateArtifactsToken, kiosk: validateKioskAnnounceToken,
  };
  for (const [kind, validate] of Object.entries(validators)) {
    assert.equal(await validate(db, cloud), false, `the ${kind} validator refuses the cloud token`);
  }
});

function fakeLog() {
  const lines = { log: [], warn: [] };
  return { lines, log: (m) => lines.log.push(m), warn: (m) => lines.warn.push(m) };
}

test("boot step: rotates with its own DB client and closes it", async () => {
  let closed = 0;
  const log = fakeLog();
  const before = readFileSync(llmCloudTokenPath(), "utf8").trim();
  const ok = await rotateCloudDoorTokenAtBoot({
    createDb: () => new Proxy(db, {
      get: (target, k) => (k === "close" ? () => { closed++; } : (typeof target[k] === "function" ? target[k].bind(target) : target[k])),
    }),
    log,
  });
  assert.equal(ok, true);
  assert.equal(closed, 1);
  const after = readFileSync(llmCloudTokenPath(), "utf8").trim();
  assert.notEqual(after, before, "a fresh token every boot");
  assert.equal(await validateLlmCloudToken(db, after), true);
  assert.deepEqual(log.lines.warn, []);
});

test("boot step: a throwing rotation is logged and boot continues", async () => {
  let closed = 0;
  const log = fakeLog();
  const ok = await rotateCloudDoorTokenAtBoot({
    createDb: () => ({ close: () => { closed++; } }),
    rotate: async () => { throw new Error("disk full"); },
    log,
  });
  assert.equal(ok, false, "resolves instead of throwing");
  assert.equal(closed, 1, "the DB client is still closed");
  assert.deepEqual(log.lines.warn, ["[gateway] rotateLlmCloudToken failed: disk full"]);
  const failingDb = await rotateCloudDoorTokenAtBoot({ createDb: () => { throw new Error("no db"); }, log });
  assert.equal(failingDb, false, "a DB client that cannot open does not throw either");
});

test("boot calls the rotation step from mountMcpServers", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "servers", "gateway", "boot", "mcp-mounts.js"), "utf8");
  const body = src.slice(src.indexOf("export async function mountMcpServers("));
  assert.match(body, /await rotateCloudDoorTokenAtBoot\(\)/);
});

/**
 * Item 2a-FU Finding 3: peer-credentials.js must honor CROW_HOME.
 *
 * peer-tokens.json is an INSTANCE-scoped resource. Every other instance-home
 * resource resolves via `process.env.CROW_HOME || homedir()/.crow` (see
 * servers/gateway/bundles-config.js). peer-credentials.js hardcoded
 * homedir()/.crow, so a process running with CROW_HOME=<instance> but without
 * CROW_PEER_TOKENS_PATH silently read (and signed with) ANOTHER instance's
 * credentials — producing missing_peer_credentials locally and hmac_mismatch
 * at the peer. These tests pin the resolution order:
 *
 *   CROW_PEER_TOKENS_PATH > CROW_HOME/peer-tokens.json > homedir()/.crow/peer-tokens.json
 *
 * PEER_TOKENS_PATH is computed at module load (the gateway loads .env before
 * importing), so each case sets env FIRST and then dynamically imports the
 * module with a `?t=` cache-busting query (same pattern as
 * tests/db-journal-mode.test.js).
 *
 * Safety: HOME is pointed at a scratch dir for the whole file so that no
 * regression (or the pre-fix RED run) can ever read or write the real
 * ~/.crow/peer-tokens.json.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
  readFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve, dirname } from "node:path";

const ENV_KEYS = ["HOME", "CROW_HOME", "CROW_PEER_TOKENS_PATH"];
const savedEnv = {};
const dirs = [];

before(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

after(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function makeTempDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

// Per-case fake home. Safety net: even if the module (or a regression) falls
// back to homedir(), it lands in a scratch dir — never the operator's real
// ~/.crow. os.homedir() on Linux reads $HOME at call time.
function makeFakeHome() {
  return makeTempDir("peer-creds-fakehome-");
}

// Fresh import per case: PEER_TOKENS_PATH is a module-load-time constant, so
// env must be set BEFORE the import, and the ESM cache busted with ?t=.
let _seq = 0;
async function freshModule({ home, crowHome, tokensPath }) {
  delete process.env.CROW_HOME;
  delete process.env.CROW_PEER_TOKENS_PATH;
  process.env.HOME = home;
  if (crowHome !== undefined) process.env.CROW_HOME = crowHome;
  if (tokensPath !== undefined) process.env.CROW_PEER_TOKENS_PATH = tokensPath;
  _seq++;
  return import(`../servers/shared/peer-credentials.js?t=${_seq}`);
}

const SAMPLE = {
  "crow:aaaaaaaaaa": {
    auth_token: "a".repeat(64),
    signing_key: "b".repeat(64),
    created_at: "2026-01-01T00:00:00.000Z",
    rotated_at: null,
  },
};

function writeTokensFile(path, creds) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

test("CROW_HOME set: loads peer-tokens.json from CROW_HOME, not homedir", async () => {
  const fakeHome = makeFakeHome();
  const crowHome = makeTempDir("peer-creds-home-");
  writeTokensFile(join(crowHome, "peer-tokens.json"), SAMPLE);
  // Decoy in the homedir fallback location — must NOT be read.
  writeTokensFile(join(fakeHome, ".crow", "peer-tokens.json"), {
    "crow:decoy": { auth_token: "f".repeat(64), signing_key: "f".repeat(64) },
  });

  const mod = await freshModule({ home: fakeHome, crowHome });
  assert.equal(mod.peerTokensPath(), resolve(crowHome, "peer-tokens.json"));
  const all = mod.loadPeerCreds();
  assert.deepEqual(Object.keys(all), ["crow:aaaaaaaaaa"]);
  assert.equal(mod.getPeerCreds("crow:aaaaaaaaaa").auth_token, "a".repeat(64));
  assert.equal(mod.getPeerCreds("crow:decoy"), null);
});

test("CROW_HOME set, file absent: returns empty — no fallthrough to homedir", async () => {
  const fakeHome = makeFakeHome();
  const crowHome = makeTempDir("peer-creds-absent-");
  // Populate the homedir fallback location; the module must NOT find it.
  writeTokensFile(join(fakeHome, ".crow", "peer-tokens.json"), SAMPLE);

  const mod = await freshModule({ home: fakeHome, crowHome });
  assert.equal(mod.peerTokensPath(), resolve(crowHome, "peer-tokens.json"));
  assert.deepEqual(mod.loadPeerCreds(), {});
  assert.equal(mod.getPeerCreds("crow:aaaaaaaaaa"), null);
});

test("CROW_PEER_TOKENS_PATH wins over CROW_HOME", async () => {
  const crowHome = makeTempDir("peer-creds-losing-home-");
  const explicitDir = makeTempDir("peer-creds-explicit-");
  const explicitPath = join(explicitDir, "custom-peer-tokens.json");
  writeTokensFile(explicitPath, SAMPLE);
  // Decoy at the CROW_HOME-derived path — must NOT be read.
  writeTokensFile(join(crowHome, "peer-tokens.json"), {
    "crow:decoy": { auth_token: "f".repeat(64), signing_key: "f".repeat(64) },
  });

  const mod = await freshModule({ home: makeFakeHome(), crowHome, tokensPath: explicitPath });
  assert.equal(mod.peerTokensPath(), explicitPath);
  assert.deepEqual(Object.keys(mod.loadPeerCreds()), ["crow:aaaaaaaaaa"]);
});

test("write path: setPeerCreds writes into CROW_HOME, creating the dir, mode 0600", async () => {
  const scratch = makeTempDir("peer-creds-write-");
  // A CROW_HOME that does not exist yet — ensureDir must create it.
  const crowHome = join(scratch, "instance-home");
  assert.equal(existsSync(crowHome), false);

  const fakeHome = makeFakeHome();
  const mod = await freshModule({ home: fakeHome, crowHome });
  const entry = mod.setPeerCreds("crow:bbbbbbbbbb", {
    auth_token: "c".repeat(64),
    signing_key: "d".repeat(64),
  });
  assert.equal(entry.auth_token, "c".repeat(64));

  const written = join(crowHome, "peer-tokens.json");
  assert.equal(existsSync(written), true, "file must land under CROW_HOME");
  assert.equal(statSync(written).mode & 0o777, 0o600);
  const onDisk = JSON.parse(readFileSync(written, "utf-8"));
  assert.equal(onDisk["crow:bbbbbbbbbb"].signing_key, "d".repeat(64));
  // And nothing leaked into the homedir fallback location.
  assert.equal(existsSync(join(fakeHome, ".crow", "peer-tokens.json")), false);
});

test("write path: explicit CROW_PEER_TOKENS_PATH — ensureDir creates THAT file's parent", async () => {
  const scratch = makeTempDir("peer-creds-write-explicit-");
  const explicitPath = join(scratch, "deep", "nested", "tokens.json");
  assert.equal(existsSync(dirname(explicitPath)), false);

  const mod = await freshModule({ home: makeFakeHome(), tokensPath: explicitPath });
  mod.setPeerCreds("crow:cccccccccc", {
    auth_token: "e".repeat(64),
    signing_key: "0".repeat(64),
  });
  assert.equal(existsSync(explicitPath), true);
  assert.equal(statSync(explicitPath).mode & 0o777, 0o600);
});

test("default (no vars): derives homedir()/.crow/peer-tokens.json — path derivation only", async () => {
  // HOME points at a scratch dir, so homedir() is scratch — this asserts pure
  // derivation without ever touching the operator's real home.
  const fakeHome = makeFakeHome();
  const mod = await freshModule({ home: fakeHome });
  assert.equal(homedir(), fakeHome, "safety net: homedir must be the scratch dir");
  assert.equal(
    mod.peerTokensPath(),
    resolve(fakeHome, ".crow", "peer-tokens.json"),
  );
});

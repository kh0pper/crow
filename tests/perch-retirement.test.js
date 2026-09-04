/**
 * Track 3, Task 17 — perch-hub bundle/panel/supervisor retirement.
 *
 * Three things this guards:
 *   1. The filesystem migration (perch-hub-retirement-migration.js) removes
 *      the vendored payload dir, the minted perch-token file, and the
 *      installed.json entry — present-and-absent, and safe to run twice.
 *   2. The gateway boots clean in a scratch env with none of the retired
 *      perch-hub modules on disk (the whole point of this wave: a missed
 *      importer is boot-breaking).
 *   3. A grep-based guard: nothing under servers/ still imports the deleted
 *      perch-runtime.js or panels/perch.js.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import http from "node:http";
import { createClient } from "@libsql/client";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------- migration */

function freshScratchHome() {
  const dir = mkdtempSync(join(tmpdir(), "perch-retirement-migration-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_HOME: dir, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: ROOT,
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return {
    dir,
    db,
    cleanup() {
      try { db.close(); } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seedPerchHubDebris(dir) {
  const payloadDir = join(dir, "bundles", "perch-hub", "payload", "hub");
  mkdirSync(payloadDir, { recursive: true });
  writeFileSync(join(payloadDir, "server.mjs"), "// vendored hub stub\n");
  writeFileSync(join(dir, "perch-token"), "deadbeef".repeat(4));
  writeFileSync(
    join(dir, "installed.json"),
    JSON.stringify([
      { id: "perch-hub", type: "bundle", version: "0.1.0" },
      { id: "browser", type: "bundle", version: "0.1.0" },
    ], null, 2),
  );
}

test("migration removes the payload dir, token file, and installed.json entry when present, and guards on a second run", async () => {
  const { dir, db, cleanup } = freshScratchHome();
  try {
    const { migratePerchHubRetirement } = await import("../servers/gateway/dashboard/settings/migrations/perch-hub-retirement-migration.js");
    seedPerchHubDebris(dir);

    const result = await migratePerchHubRetirement(db, dir);
    assert.ok(!result.skipped, "first run must actually migrate");
    assert.equal(result.removedPayloadDir, true);
    assert.equal(result.removedTokenFile, true);
    assert.equal(result.removedInstalledEntry, true);

    assert.equal(existsSync(join(dir, "bundles", "perch-hub")), false, "payload dir must be gone");
    assert.equal(existsSync(join(dir, "perch-token")), false, "token file must be gone");
    const installed = JSON.parse(readFileSync(join(dir, "installed.json"), "utf8"));
    assert.deepEqual(installed.map((i) => i.id), ["browser"], "only the perch-hub entry must be dropped");

    // Second run no-ops (guard flag).
    const second = await migratePerchHubRetirement(db, dir);
    assert.equal(second.skipped, "already_migrated");
  } finally {
    cleanup();
  }
});

test("migration is a safe no-op when none of the perch-hub debris is present", async () => {
  const { dir, db, cleanup } = freshScratchHome();
  try {
    const { migratePerchHubRetirement } = await import("../servers/gateway/dashboard/settings/migrations/perch-hub-retirement-migration.js");
    // No bundles/perch-hub, no perch-token, no installed.json at all.
    const result = await migratePerchHubRetirement(db, dir);
    assert.ok(!result.skipped, "first run must still record the guard flag");
    assert.equal(result.removedPayloadDir, false);
    assert.equal(result.removedTokenFile, false);
    assert.equal(result.removedInstalledEntry, false);

    const second = await migratePerchHubRetirement(db, dir);
    assert.equal(second.skipped, "already_migrated");
  } finally {
    cleanup();
  }
});

// I14 (final review): the ORIGINAL migration only stripped the perch-hub
// entry when installed.json parsed to an ARRAY, but routes/bundles.js's own
// getInstalled() still supports the legacy object-map form ({id: {...}}
// keyed by bundle id) — on such a host the entry survived here, yet the
// done-flag was still written (this migration never re-runs), so
// Extensions permanently listed a bundle whose files were already deleted.
test("migration strips the perch-hub entry from a LEGACY object-map installed.json (not just an array)", async () => {
  const { dir, db, cleanup } = freshScratchHome();
  try {
    const { migratePerchHubRetirement } = await import("../servers/gateway/dashboard/settings/migrations/perch-hub-retirement-migration.js");
    // The legacy object-map shape: keyed by bundle id, NOT an array —
    // exactly what routes/bundles.js's getInstalled() still normalizes.
    writeFileSync(
      join(dir, "installed.json"),
      JSON.stringify({
        "perch-hub": { type: "bundle", version: "0.1.0" },
        "browser": { type: "bundle", version: "0.1.0" },
      }, null, 2),
    );

    const result = await migratePerchHubRetirement(db, dir);
    assert.equal(result.removedInstalledEntry, true, "the entry must be found and removed on the legacy object-map shape too");

    const installed = JSON.parse(readFileSync(join(dir, "installed.json"), "utf8"));
    assert.ok(Array.isArray(installed), "the rewrite normalizes to an array — the SAME convention bundles.js's own saveInstalled() follows");
    assert.deepEqual(installed.map((i) => i.id), ["browser"], "only the perch-hub entry must be dropped, on either shape");

    // Second run must genuinely no-op — proves the flag was correctly
    // earned this time (the OLD bug wrote the flag even when it failed to
    // remove the entry, permanently masking the leftover).
    const second = await migratePerchHubRetirement(db, dir);
    assert.equal(second.skipped, "already_migrated");
  } finally {
    cleanup();
  }
});

test("migration leaves a legacy object-map installed.json with no perch-hub key untouched", async () => {
  const { dir, db, cleanup } = freshScratchHome();
  try {
    const { migratePerchHubRetirement } = await import("../servers/gateway/dashboard/settings/migrations/perch-hub-retirement-migration.js");
    writeFileSync(
      join(dir, "installed.json"),
      JSON.stringify({ "browser": { type: "bundle", version: "0.1.0" } }, null, 2),
    );
    const result = await migratePerchHubRetirement(db, dir);
    assert.equal(result.removedInstalledEntry, false, "nothing to remove — must not rewrite the file unnecessarily");
  } finally {
    cleanup();
  }
});

test("migration leaves a present installed.json with no perch-hub row untouched", async () => {
  const { dir, db, cleanup } = freshScratchHome();
  try {
    const { migratePerchHubRetirement } = await import("../servers/gateway/dashboard/settings/migrations/perch-hub-retirement-migration.js");
    writeFileSync(join(dir, "installed.json"), JSON.stringify([{ id: "browser", type: "bundle", version: "0.1.0" }], null, 2));
    const result = await migratePerchHubRetirement(db, dir);
    assert.equal(result.removedInstalledEntry, false, "nothing to remove — must not rewrite the file unnecessarily");
    const installed = JSON.parse(readFileSync(join(dir, "installed.json"), "utf8"));
    assert.deepEqual(installed.map((i) => i.id), ["browser"]);
  } finally {
    cleanup();
  }
});

/* ------------------------------------------------------------- boot smoke */

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
          res.resume();
          res.on("end", () => resolve());
        });
        req.on("error", reject);
        req.setTimeout(2000, () => { req.destroy(); reject(new Error("timeout")); });
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`gateway never became healthy on port ${port}`);
}

test("gateway boots clean in a scratch env with no perch-hub modules on disk", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "perch-retirement-boot-"));
  const crowHome = join(dataDir, "crow-home");
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dataDir, CROW_HOME: crowHome },
    stdio: "pipe",
    cwd: ROOT,
  });

  const port = await freePort();
  const env = {
    ...process.env,
    CROW_DATA_DIR: dataDir,
    CROW_HOME: crowHome,
    CROW_GATEWAY_URL: `http://127.0.0.1:${port}`,
    PORT: String(port),
  };

  const child = spawn(process.execPath, ["servers/gateway/index.js", "--no-auth"], { env, cwd: ROOT, stdio: "pipe" });
  let stderrBuf = "";
  child.stderr.on("data", (b) => { stderrBuf += b.toString(); });
  child.stdout.resume();

  t.after(() => {
    try { child.kill("SIGKILL"); } catch {}
    rmSync(dataDir, { recursive: true, force: true });
  });

  await waitForHealth(port);
  assert.doesNotMatch(stderrBuf, /perch-runtime|panels\/perch\.js|Cannot find module.*perch/i,
    `boot log mentions a retired perch module: ${stderrBuf}`);
});

/* ---------------------------------------------------------- grep guard */

const IMPORT_PATTERN = /from\s+["'][^"']*perch-runtime(\.js)?["']|from\s+["'][^"']*panels\/perch\.js["']/;

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

test("no source file under servers/ imports the retired perch-runtime.js or panels/perch.js", () => {
  const hits = [];
  for (const f of walk(join(ROOT, "servers"))) {
    const src = readFileSync(f, "utf8");
    if (IMPORT_PATTERN.test(src)) hits.push(relative(ROOT, f));
  }
  assert.deepEqual(hits, [], `these files still import a retired perch-hub module: ${hits.join(", ")}`);
});

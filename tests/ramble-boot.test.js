/**
 * Fix round 1, I-5: the Ramble transport starts only where the Ramble bundle
 * is INSTALLED. It used to fall back to the repo copy every checkout has, so
 * every sharing-enabled gateway of the user ran Ramble and wrote game state
 * from the shared-identity DMs. Without the bundle, only the tables are made.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { bootRamble, installedRambleServerDir } from "../servers/gateway/boot/ramble-boot.js";

const REPO_SERVER_DIR = new URL("../bundles/ramble/server", import.meta.url).pathname;

function scratchHome() { return mkdtempSync(join(tmpdir(), "crow-ramble-boot-")); }

async function tables(db) {
  const { rows } = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ramble_%'");
  return rows.map((r) => r.name);
}

test("NOT installed: the transport is never started, even though the repo copy exists; the tables are created", async () => {
  const home = scratchHome();
  try {
    const db = createClient({ url: ":memory:" });
    let started = 0;
    const out = await bootRamble({
      crowHome: home, repoServerDir: REPO_SERVER_DIR, db,
      startTransport: async () => { started += 1; return {}; },
    });
    assert.deepEqual(out, { started: false, reason: "not-installed" });
    assert.equal(started, 0, "a checkout is not an install");
    const t = await tables(db);
    assert.ok(t.includes("ramble_eggs") && t.includes("ramble_trades"),
      "replicated ramble_* ops must still have somewhere to land");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("INSTALLED: the transport starts from the installed copy, never the repo copy", async () => {
  const home = scratchHome();
  try {
    const installed = join(home, "bundles", "ramble", "server");
    mkdirSync(installed, { recursive: true });
    const dirs = [];
    const out = await bootRamble({
      crowHome: home, repoServerDir: REPO_SERVER_DIR, db: createClient({ url: ":memory:" }),
      startTransport: async (dir) => { dirs.push(dir); return { stop() {} }; },
    });
    assert.equal(out.started, true);
    assert.deepEqual(dirs, [installed]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("installedRambleServerDir: null without an install, the server dir with one", () => {
  const home = scratchHome();
  try {
    assert.equal(installedRambleServerDir(home), null);
    mkdirSync(join(home, "bundles", "ramble", "server"), { recursive: true });
    assert.equal(installedRambleServerDir(home), join(home, "bundles", "ramble", "server"));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

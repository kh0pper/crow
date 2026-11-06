/**
 * N3-4 phase 1 — the install path really rings the bell (one per install).
 *
 * The unit half lives in tests/bundle-first-admin-notice.test.js; this drives
 * the REAL runInstallJob against a scratch CROW_HOME + a real crow.db, because
 * the whole point of the finding is that installing uptime-kuma told the
 * operator nothing beyond "Installed: Uptime Kuma".
 *
 * Fails on the code before this change: runInstallJob never looked at
 * `firstAdmin`, so the notifications table held only the generic install row.
 *
 * Scratch CROW_HOME/CROW_DATA_DIR, no compose file in the fixtures (nothing for
 * docker to do), no ports (no ufw/tailscale calls).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const TMP_HOME = mkdtempSync(join(tmpdir(), "crow-fa-bell-home-"));
const TMP_DATA = join(TMP_HOME, "data");
const TMP_BUNDLES = mkdtempSync(join(tmpdir(), "crow-fa-bell-bundles-"));
mkdirSync(TMP_DATA, { recursive: true });
process.env.CROW_HOME = TMP_HOME;
process.env.CROW_DATA_DIR = TMP_DATA;
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";

execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: TMP_DATA },
  stdio: "pipe",
  cwd: join(import.meta.dirname, ".."),
});

const {
  runInstallJob,
  _createJobForTest,
  _finishJobForTest,
  _setAppBundlesForTest,
  _setRestartHookForTest,
} = await import("../servers/gateway/routes/bundles.js");

_setAppBundlesForTest(TMP_BUNDLES);
_setRestartHookForTest(() => {});

after(() => {
  _setRestartHookForTest(null);
  for (const d of [TMP_HOME, TMP_BUNDLES]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

/** A source manifest in the fixture bundles root, as the installer copies from. */
function sourceManifest(id, extra) {
  const dir = join(TMP_BUNDLES, id);
  mkdirSync(dir, { recursive: true });
  const manifest = { id, name: `${id} app`, type: "bundle", version: "0.1.0", webUI: { port: 4599, path: "/", label: id }, ...extra };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** The bell rows this install path wrote (kind-tagged), newest last. */
async function firstAdminBells() {
  const db = createClient({ url: "file:" + join(TMP_DATA, "crow.db") });
  try {
    const { rows } = await db.execute({
      sql: "SELECT title, body, action_url, metadata FROM notifications WHERE metadata LIKE ? ORDER BY id",
      args: ['%"kind":"bundle-first-admin"%'],
    });
    return rows.map((r) => ({ ...r, metadata: JSON.parse(r.metadata) }));
  } finally {
    db.close();
  }
}

async function install(id, manifest, installedSnapshot = []) {
  const job = _createJobForTest(id, "install");
  try {
    const out = await runInstallJob(id, {}, { job, installedSnapshot, consentVerified: false, manifest });
    assert.equal(out.ok, true, `install failed: ${out.reason}`);
    return out;
  } finally {
    _finishJobForTest(job, "complete");
  }
}

test("installing a finish-setup app rings ONE bell, naming it and linking its Extensions page", async () => {
  const manifest = sourceManifest("fx-kuma", { firstAdmin: { mode: "finish-setup" } });
  await install("fx-kuma", manifest);

  const bells = await firstAdminBells();
  assert.equal(bells.length, 1, "exactly one bell");
  assert.equal(bells[0].title, "Finish fx-kuma app's setup now");
  assert.match(bells[0].body, /can claim fx-kuma app's admin account/);
  assert.equal(bells[0].action_url, "/dashboard/extensions?q=fx-kuma");
  assert.deepEqual(bells[0].metadata, { kind: "bundle-first-admin", bundle: "fx-kuma", mode: "finish-setup" });
});

test("a crow app and a no-login app ring none", async () => {
  await install("fx-flux", sourceManifest("fx-flux", {
    firstAdmin: { mode: "crow" },
    env_vars: [{ name: "FX_ADMIN_PASSWORD", generate: "secret", keychain: true, secret: true }],
  }));
  await install("fx-dx", sourceManifest("fx-dx", { firstAdmin: { mode: "none" } }));
  assert.equal((await firstAdminBells()).filter((b) => b.metadata.bundle !== "fx-kuma").length, 0);
});

test("a reinstall over the SAME install record does not ring a second time", async () => {
  const manifest = sourceManifest("fx-kuma", { firstAdmin: { mode: "finish-setup" } });
  // The router re-validates and hands the snapshot it read — installed.json as
  // it stands, with this bundle's existing record and installedAt.
  const installedSnapshot = JSON.parse(readFileSync(join(TMP_HOME, "installed.json"), "utf8"));
  assert.ok(installedSnapshot.some((i) => i.id === "fx-kuma"), "the first install recorded it");
  await install("fx-kuma", manifest, installedSnapshot);
  const bells = (await firstAdminBells()).filter((b) => b.metadata.bundle === "fx-kuma");
  assert.equal(bells.length, 1, "still one bell for this install");
});
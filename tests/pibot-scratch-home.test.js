/**
 * The scratch-home isolation every bridge-spawning test uses
 * (tests/helpers/pi-scratch-home.mjs) must win over a HOME that was ALREADY
 * hostile: a Crow home whose bundles/ holds a bundle installed as a symlink
 * into a directory outside this checkout — the real-box shape that made
 * tests/pibot-tools-envelope.test.js fail 8/8 from a worktree that is not the
 * main checkout, with
 *
 *   A bot could not start: bundles/<id> is a link that leads outside the Crow
 *   folders, so Crow can't hide it. It is in the Crow home /home/x/.crow
 *
 * This file builds that home first, then imports the helper exactly as every
 * spawning test does. The assertions need no bubblewrap: the first one is the
 * portable regression (the co-host scan finds the hostile home before the
 * helper runs, and must not find it after), the second is the spawn itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmScratch } from "./helpers/safe-rm.js";

// ---- BEFORE any isolation: the hostile home, in the shape the suite runs with
// (HOME holds the co-host, CROW_HOME is a separate scratch instance).
const APP_ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const HOSTILE_HOME = mkdtempSync(join(tmpdir(), "crow-hostile-home-"));
const HOSTILE_CROW = join(HOSTILE_HOME, ".crow");
const OUTSIDE = join(HOSTILE_HOME, "bundle-installed-elsewhere");
const INSTANCE = mkdtempSync(join(tmpdir(), "crow-hostile-instance-"));
process.on("exit", () => {
  for (const d of [HOSTILE_HOME, INSTANCE]) { try { rmScratch(d); } catch { /* gone */ } }
});
mkdirSync(join(HOSTILE_CROW, "secrets"), { recursive: true, mode: 0o700 });
mkdirSync(join(HOSTILE_CROW, "bundles"), { recursive: true });
mkdirSync(OUTSIDE, { recursive: true });
writeFileSync(join(OUTSIDE, ".env"), "fake-bundle-env\n");
symlinkSync(OUTSIDE, join(HOSTILE_CROW, "bundles", "installed-elsewhere"));
process.env.HOME = HOSTILE_HOME;
process.env.CROW_HOME = join(INSTANCE, "home");
process.env.CROW_DATA_DIR = join(INSTANCE, "data");
delete process.env.CROW_DB_PATH;
mkdirSync(process.env.CROW_HOME, { recursive: true });
mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });

// The helper under test: imported first, the way every spawning test imports it.
const { SCRATCH_HOME } = await import("./helpers/pi-scratch-home.mjs");
const { instanceSecretsDirs } = await import("../servers/shared/secret-values.js");
const { secretFilesFor } = await import("../scripts/pi-bots/hidden_files.mjs");

test("the hostile home really is the refusing shape (the fixture is not a no-op)", () => {
  const listed = secretFilesFor({ crowHome: HOSTILE_CROW, appRoot: APP_ROOT });
  assert.ok(listed.includes(join(HOSTILE_CROW, "bundles", "installed-elsewhere", ".env")),
    "a bundle link leading outside every trusted root is listed by its link path — what the bridge refuses on");
});

test("the helper moved HOME to scratch, and the co-host scan no longer sees the hostile home", () => {
  assert.notEqual(SCRATCH_HOME, HOSTILE_HOME, "the helper really made its own home");
  assert.equal(process.env.HOME, SCRATCH_HOME);
  const real = (p) => { try { return realpathSync(p); } catch { return p; } };
  const found = instanceSecretsDirs().map(real);
  assert.ok(!found.includes(real(join(HOSTILE_CROW, "secrets"))),
    "the hostile home's secrets dir must not be in the scan: " + found.join(", "));
});

test("a real PiRpc spawn after that isolation still starts", async () => {
  const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");
  const dir = mkdtempSync(join(tmpdir(), "crow-hostile-spawn-"));
  try {
    mkdirSync(join(dir, "sessions"), { recursive: true });
    const out = join(dir, "argv.json");
    const stub = join(dir, "stub-pi.mjs");
    writeFileSync(stub,
      'import { writeFileSync } from "node:fs";\n' +
      'writeFileSync(process.env.CROW_TEST_ARGV_OUT, JSON.stringify(process.argv.slice(2)));\n' +
      'process.exit(0);\n');
    const pi = new PiRpc({
      def: { tools: { pi_builtin: ["read"], crow_mcp: [] } },
      sessionDir: dir,
      resolved: { provider: "p", model: "m", key: "p/m" },
      nodeBin: process.execPath,
      cliPath: stub,
      extraEnv: { CROW_TEST_ARGV_OUT: out },
    });
    try {
      for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
    } finally {
      try { pi.close(); } catch { /* already exited */ }
    }
    assert.ok(existsSync(out), "the stub recorded its argv, so pi really started");
  } finally {
    rmScratch(dir);
  }
});
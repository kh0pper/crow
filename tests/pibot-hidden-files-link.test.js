/**
 * A Crow home that is itself a symlink (linked onto another disk) is still
 * masked: the bridge resolves its roots first, so the masks sit at the real
 * path. Fake values only; scratch dirs under os.tmpdir().
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const k of Object.keys(process.env)) if (/^(PI_|PIBOT_)/.test(k)) delete process.env[k];
const USER_HOME = mkdtempSync(join(tmpdir(), "crow-hidden-linkhome-user-"));
const DISK = mkdtempSync(join(tmpdir(), "crow-hidden-linkhome-disk-"));
process.env.HOME = USER_HOME;
const REAL = join(DISK, "crow-home");
mkdirSync(join(REAL, "data"), { recursive: true });
const CROW = join(USER_HOME, ".crow");
symlinkSync(REAL, CROW);
process.env.CROW_HOME = CROW;
process.env.CROW_DATA_DIR = join(CROW, "data");
delete process.env.CROW_DB_PATH;

// The co-host scan must not read the HOST's /etc (a dev box with a declared
// extra Crow home would change this spawn): point its /etc half at scratch,
// empty dirs. $HOME is the scratch home above, so the per-user unit dir stays.
const SCAN_UNITS = join(USER_HOME, "scan-units");
const SCAN_ENV = join(USER_HOME, "scan-etc-crow");
mkdirSync(SCAN_UNITS, { recursive: true });
mkdirSync(SCAN_ENV, { recursive: true });
const { _setSystemScanDirsForTest } = await import("../servers/shared/secret-values.js");
_setSystemScanDirsForTest({ unitDirs: [SCAN_UNITS], envFileDirs: [SCAN_ENV] });

const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");
const { probePiSandbox, _resetPiSandboxForTest } = await import("../scripts/pi-bots/pi_sandbox.mjs");
_resetPiSandboxForTest();
const SANDBOX = probePiSandbox({ force: true });
const noSandbox = SANDBOX.ok ? false : "pi sandbox unavailable here: " + SANDBOX.reason;

test("a symlinked CROW_HOME is masked through its resolved root", { skip: noSandbox }, async () => {
  writeFileSync(join(REAL, ".env"), "fake-env-value\n");
  writeFileSync(join(REAL, "board-token"), "fake-board-token\n");
  const dir = mkdtempSync(join(tmpdir(), "crow-hidden-linkhome-"));
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const stub = join(dir, "stub-pi.mjs");
  writeFileSync(stub, [
    'import { readFileSync } from "node:fs";',
    `const files = ${JSON.stringify({ viaLink: join(CROW, ".env"), viaReal: join(REAL, ".env"), board: join(CROW, "board-token") })};`,
    'const len = (p) => { try { return readFileSync(p).length; } catch (e) { return e.code || -1; } };',
    'const out = {}; for (const [k, p] of Object.entries(files)) out[k] = len(p);',
    'process.stdout.write(JSON.stringify({ type: "report", len: out }) + "\\n");',
    "setTimeout(() => process.exit(0), 50);",
  ].join("\n"));
  const prev = process.env.CROW_PI_SANDBOX;
  process.env.CROW_PI_SANDBOX = "auto";
  try {
    const pi = new PiRpc({ def: {}, sessionDir: dir, resolved: { provider: "p", model: "m", key: "p/m" },
      nodeBin: process.execPath, cliPath: stub, diagLog: () => {} });
    const r = await pi.waitFor((m) => m.type === "report", 10000, "report");
    await pi.exited;
    assert.deepEqual(r.len, { viaLink: 0, viaReal: 0, board: 0 });
    assert.ok(pi.sandboxMaskedFiles.includes(join(realpathSync(REAL), ".env")));
  } finally {
    if (prev === undefined) delete process.env.CROW_PI_SANDBOX; else process.env.CROW_PI_SANDBOX = prev;
  }
});

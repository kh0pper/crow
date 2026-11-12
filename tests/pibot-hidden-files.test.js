/**
 * Secret files the default-tier bot sandbox masks by file (hideFiles).
 * Fake values only; scratch dirs under os.tmpdir(). The bridge test sets its
 * own scratch HOME/CROW_HOME before bridge.mjs is imported.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { symlinkSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync,
  existsSync, linkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secretFilesFor, secretPinDirsFor, unmaskableRefusal, SSH_NOT_HIDDEN_REFUSAL,
  BUNDLE_ENV_READABLE, ROOT_SECRET_FILES, isAddonsFileName } from "../scripts/pi-bots/hidden_files.mjs";

test("secretFilesFor: root token files, the appRoot .env and every non-allow-listed bundle .env", () => {
  const root = mkdtempSync(join(tmpdir(), "crow-hidden-files-"));
  const crowHome = join(root, ".crow");
  const appRoot = join(root, "app");
  mkdirSync(join(crowHome, "bundles", "browser"), { recursive: true });
  mkdirSync(join(crowHome, "bundles", "workspace"), { recursive: true });
  mkdirSync(join(crowHome, "bundles", "other"), { recursive: true });
  mkdirSync(join(crowHome, "bundles", "x.migrated-2026"), { recursive: true });
  mkdirSync(join(crowHome, "bundles", "nodotenv"), { recursive: true });
  mkdirSync(appRoot, { recursive: true });
  try {
    // Only .env files that really exist are candidates now: a bundle dir
    // without one contributes nothing.
    for (const id of ["browser", "workspace", "other", "x.migrated-2026"]) {
      writeFileSync(join(crowHome, "bundles", id, ".env"), "fake-bundle-env\n");
    }
    const files = secretFilesFor({ crowHome, appRoot });
    for (const n of [".env", ".keystore-env", "board-token", "phone-token", "artifacts-token"]) {
      assert.ok(files.includes(join(crowHome, n)), "root file " + n);
    }
    assert.ok(!ROOT_SECRET_FILES.includes(".env"), "the plain .env is handled by the .env* name rule");
    assert.ok(ROOT_SECRET_FILES.includes("artifacts-token"));
    assert.ok(files.includes(join(appRoot, ".env")), "the repo checkout's .env");
    assert.ok(files.includes(join(crowHome, "bundles", "other", ".env")), "a bundle with no in-sandbox reader");
    assert.ok(files.includes(join(crowHome, "bundles", "x.migrated-2026", ".env")), "a stale bundle copy is a secret too");
    assert.ok(!files.includes(join(crowHome, "bundles", "browser", ".env")), "the browser tool reads its own .env");
    assert.ok(!files.includes(join(crowHome, "bundles", "workspace", ".env")), "the workspace tool reads its own .env");
    assert.ok(!files.some((f) => f.startsWith(join(crowHome, "bundles", "nodotenv") + "/")), "a bundle dir with no .env has nothing to mask");
    for (const n of ["models-token", "llm-cloud-token", "kiosk-announce-token", "studio-agent-token"]) {
      assert.ok(!files.includes(join(crowHome, n)), n + " has a reader inside the sandbox");
    }
    assert.equal(new Set(files).size, files.length, "deduped");
    assert.deepEqual(BUNDLE_ENV_READABLE, ["browser", "workspace"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("secretFilesFor: a .env backup at each ROOT is listed (and refused if it is a link), a .env.example at each root and in a bundle is not", () => {
  const root = mkdtempSync(join(tmpdir(), "crow-hidden-rootevns-"));
  const crowHome = join(root, ".crow");
  const appRoot = join(root, "app");
  try {
    for (const r of [crowHome, appRoot]) {
      mkdirSync(join(r, "bundles", "alpha"), { recursive: true });
      writeFileSync(join(r, ".env.bak-20260929-x"), "fake-root-backup\n");
      writeFileSync(join(r, ".env.example"), "FAKE_KEY=\n");
      writeFileSync(join(r, "bundles", "alpha", ".env.bak-20260929-x"), "fake-bundle-backup\n");
      writeFileSync(join(r, "bundles", "alpha", ".env.example"), "FAKE_KEY=\n");
    }
    const files = secretFilesFor({ crowHome, appRoot });
    for (const r of [crowHome, appRoot]) {
      assert.ok(files.includes(join(r, ".env.bak-20260929-x")), "a backup copy at the root is a secret: " + r);
      assert.ok(files.includes(join(r, ".env")), "and the plain .env is still listed: " + r);
      assert.ok(files.includes(join(r, "bundles", "alpha", ".env.bak-20260929-x")), "and in a bundle dir: " + r);
      assert.ok(!files.includes(join(r, ".env.example")), "a .example template is documentation, not a secret: " + r);
      assert.ok(!files.includes(join(r, "bundles", "alpha", ".env.example")), "in a bundle dir too: " + r);
    }
    assert.equal(new Set(files).size, files.length, "deduped");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("isAddonsFileName: mcp-addons.json and every mcp-addons.json.<suffix> copy, the writers' .mcp-addons.json.tmp-* files, but not the .example template or a look-alike", () => {
  for (const n of ["mcp-addons.json", "mcp-addons.json.bak", "mcp-addons.json.bak-20261111",
    "mcp-addons.json.bak.1781654126", "mcp-addons.json.pre-fed-gov-data-20260511",
    "mcp-addons.json.pre-test-contamination-20260711",
    // A temp file the gateway's writePrivateFile, or migrate-linked's
    // writeAtomicPrivate, holds beside the file until it renames it over it.
    ".mcp-addons.json.tmp-12345-ab12cd34", ".mcp-addons.json.tmp-12345-lx9k2"]) {
    assert.equal(isAddonsFileName(n), true, n);
  }
  for (const n of ["mcp-addons.example.json", ".mcp-addons.example.json", "xmcp-addons.json",
    "mcp-addons.jsonx", ".env"]) {
    assert.equal(isAddonsFileName(n), false, n);
  }
});

test("secretFilesFor: mcp-addons.json, every backup copy and a writer's temp file at the CROW HOME root only, not the .example template and never at appRoot", () => {
  const root = mkdtempSync(join(tmpdir(), "crow-hidden-addons-"));
  const crowHome = join(root, ".crow");
  const appRoot = join(root, "app");
  mkdirSync(crowHome, { recursive: true });
  mkdirSync(appRoot, { recursive: true });
  const fake = '{"fake-addon":{"env":{"FAKE_KEY":"fake-value"}}}\n';
  const copies = ["mcp-addons.json", "mcp-addons.json.bak-20261111", "mcp-addons.json.bak.1781654126",
    "mcp-addons.json.pre-test-contamination-20260711"];
  // The gateway's writer (writePrivateFile) holds this name until it renames it
  // over mcp-addons.json: full add-on env, so it is a secret of its own.
  const tmpName = ".mcp-addons.json.tmp-12345-ab12cd34";
  try {
    for (const n of [...copies, "mcp-addons.example.json", tmpName]) writeFileSync(join(crowHome, n), fake);
    // The repo checkout never holds one, so even one sitting there is not ours to mask.
    writeFileSync(join(appRoot, "mcp-addons.json"), fake);
    writeFileSync(join(appRoot, tmpName), fake);
    const files = secretFilesFor({ crowHome, appRoot });
    for (const n of copies) assert.ok(files.includes(join(crowHome, n)), "listed: " + n);
    assert.ok(files.includes(join(crowHome, tmpName)), "the writer's temp file is listed: " + tmpName);
    assert.ok(!files.includes(join(crowHome, "mcp-addons.example.json")), "the .example template is documentation");
    assert.ok(!files.some((f) => f.startsWith(appRoot + "/") && f.includes("mcp-addons")),
      "nothing named mcp-addons* under appRoot");
    assert.equal(new Set(files).size, files.length, "deduped");
    // Listed even when it does not exist: wrapPiSpawn skips a file it cannot stat.
    const emptyHome = join(root, "empty-crow");
    mkdirSync(emptyHome, { recursive: true });
    assert.ok(secretFilesFor({ crowHome: emptyHome }).includes(join(emptyHome, "mcp-addons.json")),
      "the plain file is listed whether it exists or not");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("secretFilesFor: a symlinked mcp-addons.json backup leaving the roots is listed under its own name, so the spawn is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "crow-hidden-addonslink-"));
  const crowHome = join(root, ".crow");
  const outside = join(root, "outside");
  mkdirSync(crowHome, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "real.json"), '{"fake-addon":{"env":{"FAKE_KEY":"fake-value"}}}\n');
  const link = join(crowHome, "mcp-addons.json.bak-x");
  symlinkSync(join(outside, "real.json"), link);
  try {
    const files = secretFilesFor({ crowHome });
    assert.ok(files.includes(link), "listed under its own link name");
    assert.ok(!files.includes(join(outside, "real.json")), "never the path behind an outside link");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("secretFilesFor: no appRoot and a missing bundles dir -> no bundle entries, no throw", () => {
  const root = mkdtempSync(join(tmpdir(), "crow-hidden-nobundles-"));
  const crowHome = join(root, ".crow");
  mkdirSync(crowHome, { recursive: true });
  try {
    const files = secretFilesFor({ crowHome });
    assert.ok(!files.some((f) => f.includes("/bundles/")));
    assert.ok(!files.includes(join(root, ".env")));
    assert.ok(files.includes(join(crowHome, ".env")));
    assert.deepEqual(secretFilesFor({ crowHome, readdir: () => { throw new Error("no dir"); } })
      .filter((f) => f.includes("/bundles/")), [], "a readdir error means none");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- bridge level: what a spawn really masks ----

for (const k of Object.keys(process.env)) if (/^(PI_|PIBOT_)/.test(k)) delete process.env[k];
const USER_HOME = mkdtempSync(join(tmpdir(), "crow-hidden-user-"));
process.env.HOME = USER_HOME;
const CROW = join(USER_HOME, ".crow");
mkdirSync(CROW, { recursive: true });
process.env.CROW_HOME = CROW;
process.env.CROW_DATA_DIR = join(CROW, "data");
delete process.env.CROW_DB_PATH;
mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });
const REAL_CROW = realpathSync(CROW);

const { PiRpc, homeMatchesResolved, logUnhideableOnce, _resetUnhideableLogForTest } = await import("../scripts/pi-bots/bridge.mjs");
const { probePiSandbox, _resetPiSandboxForTest } = await import("../scripts/pi-bots/pi_sandbox.mjs");

_resetPiSandboxForTest();
const SANDBOX = probePiSandbox({ force: true });
const noSandbox = SANDBOX.ok ? false : "pi sandbox unavailable here: " + SANDBOX.reason;

test("homeMatchesResolved: two nulls are a refusal, not agreement", () => {
  assert.equal(homeMatchesResolved("/home/u/.crow", "/home/u/.crow"), true);
  assert.equal(homeMatchesResolved("/home/u/.crow", "/home/u/.crow-r4"), false, "a moved home");
  assert.equal(homeMatchesResolved(null, null), false, "both unresolved is not a match");
  assert.equal(homeMatchesResolved(null, "/home/u/.crow"), false, "nothing resolved is not a match");
  assert.equal(homeMatchesResolved("/home/u/.crow", null), false, "a home the resolver cannot see is not a match");
});

test("logUnhideableOnce: one line per path per hour, and the entry is dropped once an hour has passed", () => {
  _resetUnhideableLogForTest();
  const lines = [];
  const orig = console.error;
  console.error = (...a) => { lines.push(a.map(String).join(" ")); };
  const t0 = 1_700_000_000_000;
  const HOUR = 3600_000;
  try {
    logUnhideableOnce("/a/.env", "line one", t0);
    logUnhideableOnce("/a/.env", "line one", t0 + 60_000);
    assert.equal(lines.length, 1, "the same path within the hour logs once");
    logUnhideableOnce("/b/.env", "line two", t0 + 60_001);
    assert.equal(lines.length, 2, "a different path has its own entry");
    logUnhideableOnce("/a/.env", "line one", t0 + HOUR - 1);
    assert.equal(lines.length, 2, "just inside the hour still logs nothing");
    logUnhideableOnce("/a/.env", "line one", t0 + HOUR);
    assert.equal(lines.length, 3, "an hour later the old entry is dropped and it logs again");
    logUnhideableOnce("/a/.env", "line one", t0 + HOUR + 60_000);
    assert.equal(lines.length, 3, "and the fresh entry is within the hour again");
    assert.ok(lines.every((l) => l.startsWith("[pi-bots] ")), "every line is the bridge's journal prefix");
  } finally {
    console.error = orig;
    _resetUnhideableLogForTest();
  }
});

test("sandboxed spawn: root secrets and other bundles' .env are masked; models-token and browser/.env stay readable", { skip: noSandbox }, async () => {
  const dotenv = join(CROW, ".env");
  const keystore = join(CROW, ".keystore-env");
  const board = join(CROW, "board-token");
  const models = join(CROW, "models-token");
  const browserEnv = join(CROW, "bundles", "browser", ".env");
  const otherEnv = join(CROW, "bundles", "other", ".env");
  mkdirSync(join(CROW, "bundles", "browser"), { recursive: true });
  mkdirSync(join(CROW, "bundles", "other"), { recursive: true });
  for (const [p, v] of [[dotenv, "fake-env-value\n"], [keystore, "fake-keystore-value\n"], [board, "fake-board-token\n"],
    [models, "fake-models-token\n"], [browserEnv, "fake-browser-token\n"], [otherEnv, "fake-other-secret\n"]]) {
    writeFileSync(p, v, { mode: 0o600 });
  }
  const dir = mkdtempSync(join(tmpdir(), "crow-hidden-spawn-"));
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const stub = join(dir, "stub-pi.mjs");
  // ~/.ssh is hidden as a dir
  mkdirSync(join(USER_HOME, ".ssh"), { recursive: true });
  const sshKey = join(USER_HOME, ".ssh", "id_fake");
  writeFileSync(sshKey, "fake-ssh-key\n", { mode: 0o600 });
  const files = { dotenv, keystore, board, models, browserEnv, otherEnv, sshKey };
  writeFileSync(stub, [
    'import { readFileSync } from "node:fs";',
    `const files = ${JSON.stringify(files)};`,
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
    for (const k of ["dotenv", "keystore", "board", "otherEnv"]) {
      assert.equal(r.len[k], 0, k + " reads empty inside");
    }
    assert.equal(r.len.sshKey, "ENOENT", "~/.ssh is hidden");
    assert.equal(r.len.models, readFileSync(models).length, "models-token stays readable");
    assert.equal(r.len.browserEnv, readFileSync(browserEnv).length, "the browser bundle's .env stays readable");
    const masked = pi.sandboxMaskedFiles;
    for (const p of [dotenv, keystore, board, otherEnv]) {
      assert.ok(masked.includes(join(REAL_CROW, p.slice(CROW.length))), "masked: " + p);
    }
    assert.equal(masked.includes(join(REAL_CROW, "models-token")), false);
    assert.equal(masked.includes(join(REAL_CROW, "bundles", "browser", ".env")), false);
  } finally {
    if (prev === undefined) delete process.env.CROW_PI_SANDBOX; else process.env.CROW_PI_SANDBOX = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
/** The error a spawn is refused with, or null when it started. */
async function spawnOutcome() {
  const dir = mkdtempSync(join(tmpdir(), "crow-hidden-refuse-"));
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const stub = join(dir, "stub-pi.mjs");
  writeFileSync(stub, 'process.stdout.write(JSON.stringify({ type: "report" }) + "\\n"); setTimeout(() => process.exit(0), 50);');
  const prev = process.env.CROW_PI_SANDBOX;
  process.env.CROW_PI_SANDBOX = "auto";
  try {
    const pi = new PiRpc({ def: {}, sessionDir: dir, resolved: { provider: "p", model: "m", key: "p/m" },
      nodeBin: process.execPath, cliPath: stub, diagLog: () => {} });
    await pi.waitFor((m) => m.type === "report", 10000, "report");
    await pi.exited;
    return null;
  } catch (e) { return e; } finally {
    if (prev === undefined) delete process.env.CROW_PI_SANDBOX; else process.env.CROW_PI_SANDBOX = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a bundle link into a hidden folder (env/, secrets/) refuses with the plain sentence about the hidden folder", { skip: noSandbox }, async () => {
  // The target is a dir under env/, which is hidden WHOLE: the .env behind the
  // link is never maskable there, so the link itself is the refusal.
  const target = join(CROW, "env", "sub");
  mkdirSync(target, { recursive: true });
  mkdirSync(join(CROW, "bundles"), { recursive: true });
  writeFileSync(join(target, ".env"), "fake-hidden-folder-env\n");
  const link = join(CROW, "bundles", "viasecret");
  symlinkSync(target, link);
  try {
    const e = await spawnOutcome();
    assert.ok(e, "the spawn is refused");
    assert.equal(e.message, "A bot could not start: env/sub/.env is a link into a hidden folder, so Crow can't hide it. Remove the link.");
    assert.ok(!e.message.includes("fake-hidden-folder-env"), "no content in the message");
  } finally { rmSync(link, { force: true }); rmSync(join(CROW, "env"), { recursive: true, force: true }); }
});

test("a bundle dir swapped for a symlink to a dir with a .env refuses the spawn, naming the link folder and its home, and no content", { skip: noSandbox }, async () => {
  const target = mkdtempSync(join(tmpdir(), "crow-hidden-linktarget-"));
  writeFileSync(join(target, ".env"), "fake-linked-env-content\n");
  const link = join(CROW, "bundles", "swapped");
  symlinkSync(target, link);
  try {
    const e = await spawnOutcome();
    assert.ok(e, "the spawn is refused");
    assert.equal(e.message, "A bot could not start: bundles/swapped is a link that leads outside the Crow folders, so Crow can't hide it. It is in the Crow home " + REAL_CROW + ". Remove the link.");
    assert.ok(!e.message.includes("fake-linked-env-content"), "no content in the message");
  } finally { rmSync(link, { force: true }); rmSync(target, { recursive: true, force: true }); }
});

test("a bundle-folder link in a SECOND Crow home names the link folder and that home", { skip: noSandbox }, async () => {
  // A co-hosted home is found by the shape of its secrets dir under $HOME.
  const otherHome = join(USER_HOME, ".crow-r4");
  const target = mkdtempSync(join(tmpdir(), "crow-hidden-secondtarget-"));
  mkdirSync(join(otherHome, "secrets"), { recursive: true });
  mkdirSync(join(otherHome, "bundles"), { recursive: true });
  writeFileSync(join(target, ".env"), "fake-second-home-env\n");
  const link = join(otherHome, "bundles", "x");
  symlinkSync(target, link);
  try {
    const e = await spawnOutcome();
    assert.ok(e, "the spawn is refused");
    assert.equal(e.message, "A bot could not start: bundles/x is a link that leads outside the Crow folders, so Crow can't hide it. It is in the Crow home " + realpathSync(otherHome) + ". Remove the link.");
    assert.ok(!e.message.includes("fake-second-home-env"), "no content in the message");
  } finally {
    rmSync(link, { force: true });
    rmSync(otherHome, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("a bundle symlink with nothing behind it is ignored", { skip: noSandbox }, async () => {
  const target = mkdtempSync(join(tmpdir(), "crow-hidden-emptylink-"));
  const link = join(CROW, "bundles", "emptylink");
  symlinkSync(target, link);
  try { assert.equal(await spawnOutcome(), null, "the spawn starts"); }
  finally { rmSync(link, { force: true }); rmSync(target, { recursive: true, force: true }); }
});

test("a symlinked .env refuses the spawn", { skip: noSandbox }, async () => {
  const target = mkdtempSync(join(tmpdir(), "crow-hidden-envtarget-"));
  writeFileSync(join(target, "real"), "fake-env-content\n");
  const link = join(CROW, ".env");
  rmSync(link, { force: true });
  symlinkSync(join(target, "real"), link);
  try {
    const e = await spawnOutcome();
    assert.ok(e, "the spawn is refused");
    assert.match(e.message, /A bot could not start: \.env is a link/);
    assert.ok(!e.message.includes("fake-env-content"));
  } finally { rmSync(link, { force: true }); rmSync(target, { recursive: true, force: true }); }
});

test("secretFilesFor / secretPinDirsFor: a symlinked bundle is listed only with a .env behind it; the bundles dir and each real bundle dir of BOTH roots are pinned", () => {
  const root = mkdtempSync(join(tmpdir(), "crow-hidden-pins-"));
  const crowHome = join(root, ".crow");
  const appRoot = join(root, "app");
  const elsewhere = join(root, "elsewhere");
  mkdirSync(join(crowHome, "bundles", "real"), { recursive: true });
  mkdirSync(join(crowHome, "bundles", "browser"), { recursive: true });
  mkdirSync(join(appRoot, "bundles", "real"), { recursive: true });
  mkdirSync(join(appRoot, "bundles", "browser"), { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  mkdirSync(join(root, "empty"), { recursive: true });
  symlinkSync(elsewhere, join(crowHome, "bundles", "withenv"));
  writeFileSync(join(elsewhere, ".env"), "fake\n");
  symlinkSync(join(root, "empty"), join(crowHome, "bundles", "noenv"));
  writeFileSync(join(crowHome, "bundles", "real", ".env"), "fake-real-env\n");
  try {
    const files = secretFilesFor({ crowHome });
    assert.ok(files.includes(join(crowHome, "bundles", "real", ".env")));
    assert.ok(files.includes(join(crowHome, "bundles", "withenv", ".env")), "listed so the spawn is refused");
    assert.ok(!files.includes(join(crowHome, "bundles", "noenv", ".env")));
    const pins = secretPinDirsFor({ crowHome, appRoot });
    assert.deepEqual(pins.sort(), [
      join(crowHome, "bundles"), join(crowHome, "bundles", "browser"), join(crowHome, "bundles", "real"),
      join(appRoot, "bundles"), join(appRoot, "bundles", "browser"), join(appRoot, "bundles", "real"),
    ].sort());
    assert.deepEqual(secretPinDirsFor({ crowHome }), [join(crowHome, "bundles"), join(crowHome, "bundles", "browser"), join(crowHome, "bundles", "real")],
      "no appRoot: only the Crow home's are pinned");
    assert.equal(new Set(pins).size, pins.length, "deduped");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unmaskableRefusal: one plain sentence per cause (hard link, outside, hidden folder, link out, link inside)", () => {
  assert.equal(unmaskableRefusal("bundles/x/.env", "hardlink"),
    "A bot could not start: bundles/x/.env has another name on disk, so Crow can't hide it. Remove the extra link.");
  assert.equal(unmaskableRefusal("/outside/.env", "outside"),
    "A bot could not start: /outside/.env is outside the Crow folders, so Crow can't hide it.");
  assert.equal(unmaskableRefusal("env/sub/.env", "hidden-dir"),
    "A bot could not start: env/sub/.env is a link into a hidden folder, so Crow can't hide it. Remove the link.");
  assert.equal(unmaskableRefusal("bundles/x", "link-out"),
    "A bot could not start: bundles/x is a link that leads outside the Crow folders, so Crow can't hide it. Remove the link.",
    "no home known: the sentence leaves it out");
  assert.equal(unmaskableRefusal("bundles/x", "link-out", { home: "/home/u/.crow" }),
    "A bot could not start: bundles/x is a link that leads outside the Crow folders, so Crow can't hide it. It is in the Crow home /home/u/.crow. Remove the link.");
  assert.equal(unmaskableRefusal(".env", "link-inside"),
    "A bot could not start: .env is a link or sits behind one, so Crow can't hide it. Remove the link.");
  assert.equal(unmaskableRefusal(".env", undefined), unmaskableRefusal(".env", "link-inside"),
    "an unknown cause falls back to the plain link sentence");
  assert.equal(SSH_NOT_HIDDEN_REFUSAL, "A bot could not start: Crow could not hide ~/.ssh.");
  // The bridge throws that exported sentence rather than a copy of its own
  // (the ~/.ssh refusal is not reachable in a unit test: forcing bwrap to fail
  // one mask needs a host that has bwrap).
  const bridge = readFileSync(join(import.meta.dirname, "..", "scripts", "pi-bots", "bridge.mjs"), "utf8");
  assert.ok(bridge.includes("new Error(SSH_NOT_HIDDEN_REFUSAL)"), "the bridge throws the shared sentence");
  assert.ok(!bridge.includes("Crow could not hide ~/.ssh."), "and holds no copy of it");
});

test("secretFilesFor: a CO-HOSTED home's bundle link into appRoot/bundles lists the resolved .env under appRoot when appRoot is passed", () => {
  const root = mkdtempSync(join(tmpdir(), "crow-hidden-cohost-"));
  const appRoot = join(root, "app");
  const coHome = join(root, "co-home");
  mkdirSync(join(appRoot, "bundles", "shared"), { recursive: true });
  writeFileSync(join(appRoot, "bundles", "shared", ".env"), "fake\n");
  mkdirSync(join(coHome, "bundles"), { recursive: true });
  symlinkSync(join(appRoot, "bundles", "shared"), join(coHome, "bundles", "alias"));
  try {
    // Without appRoot the link target is outside every root the caller trusts,
    // so the file is listed at the link path and the spawn would be refused.
    assert.ok(secretFilesFor({ crowHome: coHome }).includes(join(coHome, "bundles", "alias", ".env")));
    // With appRoot (bridge passes it for every home) the same file is listed at
    // its resolved path, which is under a trusted root: masked, not refused.
    const files = secretFilesFor({ crowHome: coHome, appRoot });
    assert.ok(files.includes(join(appRoot, "bundles", "shared", ".env")));
    assert.ok(!files.includes(join(coHome, "bundles", "alias", ".env")), "not under the link path");
    assert.equal(files.filter((f) => f === join(appRoot, "bundles", "shared", ".env")).length, 1, "deduped");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- app-root bundles, resolved bundle links (unit level) ----

test("secretFilesFor: appRoot bundles are listed too, .env and .env.<tag>, but not .environment or x.env", () => {
  const root = mkdtempSync(join(tmpdir(), "crow-hidden-approot-"));
  const crowHome = join(root, ".crow");
  const appRoot = join(root, "app");
  try {
    for (const r of [crowHome, appRoot]) {
      for (const id of ["alpha", ...BUNDLE_ENV_READABLE]) {
        mkdirSync(join(r, "bundles", id), { recursive: true });
        writeFileSync(join(r, "bundles", id, ".env"), "fake-env\n");
      }
      writeFileSync(join(r, "bundles", "alpha", ".env.bak-20260929"), "fake-env-backup\n");
      writeFileSync(join(r, "bundles", "alpha", ".environment"), "fake-not-an-env-file\n");
      writeFileSync(join(r, "bundles", "alpha", "x.env"), "fake-wrong-name\n");
    }
    const files = secretFilesFor({ crowHome, appRoot });
    for (const r of [crowHome, appRoot]) {
      assert.ok(files.includes(join(r, "bundles", "alpha", ".env")), "the bundle .env under " + r);
      assert.ok(files.includes(join(r, "bundles", "alpha", ".env.bak-20260929")), "a .env.<tag> copy is a secret too under " + r);
      for (const id of BUNDLE_ENV_READABLE) {
        assert.ok(!files.includes(join(r, "bundles", id, ".env")), id + " reads its own .env under " + r);
      }
    }
    assert.ok(!files.some((f) => f.endsWith(".environment")), ".environment is not an env file");
    assert.ok(!files.some((f) => f.endsWith("x.env")), "only a name starting with .env counts");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("secretFilesFor: a bundle link into another trusted root lists the resolved path once; one leading outside lists the link path only with a .env behind it", () => {
  const root = mkdtempSync(join(tmpdir(), "crow-hidden-bundlelink-"));
  const crowHome = join(root, ".crow");
  const appRoot = join(root, "app");
  const outsideEnv = join(root, "outside-env");
  const outsideEmpty = join(root, "outside-empty");
  try {
    mkdirSync(join(appRoot, "bundles", "real"), { recursive: true });
    writeFileSync(join(appRoot, "bundles", "real", ".env"), "fake-app-env\n");
    writeFileSync(join(appRoot, "bundles", "real", ".env.bak-20260929"), "fake-app-env-backup\n");
    mkdirSync(join(crowHome, "bundles"), { recursive: true });
    mkdirSync(outsideEnv, { recursive: true });
    mkdirSync(outsideEmpty, { recursive: true });
    writeFileSync(join(outsideEnv, ".env"), "fake-outside-env\n");
    symlinkSync(join(appRoot, "bundles", "real"), join(crowHome, "bundles", "alias"));
    symlinkSync(outsideEnv, join(crowHome, "bundles", "outside"));
    symlinkSync(outsideEmpty, join(crowHome, "bundles", "outside-empty"));
    const files = secretFilesFor({ crowHome, appRoot });
    for (const n of [".env", ".env.bak-20260929"]) {
      const resolved = join(appRoot, "bundles", "real", n);
      assert.ok(files.includes(resolved), "listed at its resolved path: " + n);
      assert.equal(files.filter((f) => f === resolved).length, 1, "and only once: " + n);
      assert.ok(!files.includes(join(crowHome, "bundles", "alias", n)), "not under a link that stays inside the roots: " + n);
    }
    assert.ok(files.includes(join(crowHome, "bundles", "outside", ".env")), "outside every root: the link path, so the spawn is refused");
    assert.ok(!files.includes(join(outsideEnv, ".env")), "never the path behind an outside link");
    assert.ok(!files.some((f) => f.includes("outside-empty")), "an outside link with no .env behind it is ignored");
    assert.equal(new Set(files).size, files.length, "deduped");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- bridge level: hard links, links inside a root, the dir masks, the journal line ----

/** Spawn with a stub pi that reports the byte length of each file and the listing of each dir it sees inside. */
async function spawnReport({ files = {}, dirs = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "crow-hidden-report-"));
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const stub = join(dir, "stub-pi.mjs");
  writeFileSync(stub, [
    'import { readFileSync, readdirSync } from "node:fs";',
    `const files = ${JSON.stringify(files)};`,
    `const dirs = ${JSON.stringify(dirs)};`,
    'const len = (p) => { try { return readFileSync(p).length; } catch (e) { return e.code || -1; } };',
    'const list = (p) => { try { return readdirSync(p); } catch (e) { return e.code || -1; } };',
    'const out = { len: {}, list: {} };',
    'for (const [k, p] of Object.entries(files)) out.len[k] = len(p);',
    'for (const [k, p] of Object.entries(dirs)) out.list[k] = list(p);',
    'process.stdout.write(JSON.stringify({ type: "report", len: out.len, list: out.list }) + "\\n");',
    "setTimeout(() => process.exit(0), 50);",
  ].join("\n"));
  const prev = process.env.CROW_PI_SANDBOX;
  process.env.CROW_PI_SANDBOX = "auto";
  try {
    const pi = new PiRpc({ def: {}, sessionDir: dir, resolved: { provider: "p", model: "m", key: "p/m" },
      nodeBin: process.execPath, cliPath: stub, diagLog: () => {} });
    const r = await pi.waitFor((m) => m.type === "report", 10000, "report");
    await pi.exited;
    return { report: r, masked: pi.sandboxMaskedFiles };
  } finally {
    if (prev === undefined) delete process.env.CROW_PI_SANDBOX; else process.env.CROW_PI_SANDBOX = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a bundle .env with another hard link refuses the spawn, naming the path and no content", { skip: noSandbox }, async () => {
  const bundleDir = join(CROW, "bundles", "hardlinked");
  mkdirSync(bundleDir, { recursive: true });
  const envFile = join(bundleDir, ".env");
  writeFileSync(envFile, "fake-hardlinked-secret\n", { mode: 0o600 });
  // A second name on disk (masking one leaves the other readable).
  linkSync(envFile, join(bundleDir, "env-extra-name"));
  try {
    const e = await spawnOutcome();
    assert.ok(e, "the spawn is refused");
    assert.equal(e.message, "A bot could not start: bundles/hardlinked/.env has another name on disk, so Crow can't hide it. Remove the extra link.");
    assert.ok(!e.message.includes("fake-hardlinked-secret"), "no content in the message");
  } finally { rmSync(bundleDir, { recursive: true, force: true }); }
});

test("a bundle link resolving inside the Crow home is not refused, and the resolved .env reads empty inside", { skip: noSandbox }, async () => {
  const real = join(CROW, "bundles", "real");
  const alias = join(CROW, "bundles", "alias");
  mkdirSync(real, { recursive: true });
  writeFileSync(join(real, ".env"), "fake-linked-real-env\n", { mode: 0o600 });
  symlinkSync(real, alias);
  try {
    const { report, masked } = await spawnReport({ files: { viaAlias: join(alias, ".env"), viaReal: join(real, ".env") } });
    assert.equal(report.len.viaReal, 0, "the real .env reads empty inside");
    assert.equal(report.len.viaAlias, 0, "and through the link too");
    assert.ok(masked.includes(join(REAL_CROW, "bundles", "real", ".env")), "masked at its resolved path");
  } finally { rmSync(alias, { force: true }); rmSync(real, { recursive: true, force: true }); }
});

test("~/.ssh is created 0700 when it is missing and lists empty inside", { skip: noSandbox }, async () => {
  const sshDir = join(USER_HOME, ".ssh");
  rmSync(sshDir, { recursive: true, force: true });
  const { report } = await spawnReport({ dirs: { ssh: sshDir } });
  assert.ok(existsSync(sshDir), "the bridge created the folder before the spawn");
  assert.equal(statSync(sshDir).mode & 0o777, 0o700, "0700");
  assert.deepEqual(report.list.ssh, [], "empty inside");
});

test("the instance env/ and android-keystore/ folders list empty inside", { skip: noSandbox }, async () => {
  const envDir = join(CROW, "env");
  const keyDir = join(CROW, "android-keystore");
  mkdirSync(envDir, { recursive: true });
  mkdirSync(keyDir, { recursive: true });
  writeFileSync(join(envDir, "compose.env"), "fake-compose-value\n", { mode: 0o600 });
  writeFileSync(join(keyDir, "fake-release.jks"), "fake-keystore-bytes\n", { mode: 0o600 });
  try {
    const { report } = await spawnReport({ dirs: { env: envDir, keystore: keyDir } });
    assert.deepEqual(report.list.env, [], "env/ is empty inside");
    assert.deepEqual(report.list.keystore, [], "android-keystore/ is empty inside");
  } finally { rmSync(envDir, { recursive: true, force: true }); rmSync(keyDir, { recursive: true, force: true }); }
});

test("the add-on registry and its backups read empty inside a sandboxed spawn; mcp-addons.example.json stays readable", { skip: noSandbox }, async () => {
  const addons = join(CROW, "mcp-addons.json");
  const addonsBackup = join(CROW, "mcp-addons.json.bak-20261111");
  const addonsExample = join(CROW, "mcp-addons.example.json");
  const fake = '{"fake-addon":{"env":{"FAKE_KEY":"fake-value"}}}\n';
  for (const p of [addons, addonsBackup, addonsExample]) writeFileSync(p, fake, { mode: 0o600 });
  try {
    const { report, masked } = await spawnReport({ files: { addons, addonsBackup, addonsExample } });
    assert.equal(report.len.addons, 0, "mcp-addons.json reads empty inside");
    assert.equal(report.len.addonsBackup, 0, "its .bak-<date> copy reads empty inside");
    assert.equal(report.len.addonsExample, readFileSync(addonsExample).length,
      "the .example template is documentation and stays readable");
    for (const p of ["mcp-addons.json", "mcp-addons.json.bak-20261111"]) {
      assert.ok(masked.includes(join(REAL_CROW, p)), "masked: " + p);
    }
    assert.equal(masked.includes(join(REAL_CROW, "mcp-addons.example.json")), false,
      "the .example template is not masked");
  } finally {
    for (const p of [addons, addonsBackup, addonsExample]) rmSync(p, { force: true });
  }
});

test("two refused spawns at one path log the journal line once, and both still refuse", { skip: noSandbox }, async () => {
  const target = mkdtempSync(join(tmpdir(), "crow-hidden-logonce-"));
  writeFileSync(join(target, ".env"), "fake-logonce-env\n");
  const link = join(CROW, "bundles", "logonce");
  symlinkSync(target, link);
  const expected = "A bot could not start: bundles/logonce is a link that leads outside the Crow folders, so Crow can't hide it. It is in the Crow home " + REAL_CROW + ". Remove the link.";
  const lines = [];
  const orig = console.error;
  console.error = (...a) => { lines.push(a.map(String).join(" ")); };
  try {
    const first = await spawnOutcome();
    const second = await spawnOutcome();
    assert.ok(first, "the first spawn is refused");
    assert.ok(second, "the second spawn is refused too");
    assert.equal(first.message, expected);
    assert.equal(second.message, expected, "the error still reaches the failed turn");
    const logged = lines.filter((l) => l.includes("A bot could not start: bundles/logonce is a link"));
    assert.equal(logged.length, 1, "the journal line is written once for both spawns: " + JSON.stringify(logged));
  } finally {
    console.error = orig;
    rmSync(link, { force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("secretFilesFor: a symlinked .env is masked at its real path, skipped behind a hidden dir, ignored when dangling, listed by name when it leaves the roots", () => {
  const root = mkdtempSync(join(tmpdir(), "crow-hidden-envlink-"));
  const crowHome = join(root, ".crow");
  const outside = join(root, "outside");
  mkdirSync(join(crowHome, "env"), { recursive: true });
  mkdirSync(join(crowHome, "shared"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  for (const id of ["viahidden", "inroot", "dangling", "leaves"]) mkdirSync(join(crowHome, "bundles", id), { recursive: true });
  writeFileSync(join(crowHome, "env", "cuda.env"), "fake\n");
  writeFileSync(join(crowHome, "shared", "x.env"), "fake\n");
  writeFileSync(join(outside, "y.env"), "fake\n");
  symlinkSync(join(crowHome, "env", "cuda.env"), join(crowHome, "bundles", "viahidden", ".env"));
  symlinkSync(join(crowHome, "shared", "x.env"), join(crowHome, "bundles", "inroot", ".env"));
  symlinkSync(join(root, "nowhere"), join(crowHome, "bundles", "dangling", ".env"));
  symlinkSync(join(outside, "y.env"), join(crowHome, "bundles", "leaves", ".env"));
  try {
    const files = secretFilesFor({ crowHome, hiddenDirs: [join(crowHome, "env")] });
    assert.ok(!files.some((f) => f.includes("viahidden")) && !files.includes(join(crowHome, "env", "cuda.env")), "already behind a hidden dir");
    assert.ok(files.includes(join(crowHome, "shared", "x.env")), "masked at the real path");
    assert.ok(!files.some((f) => f.includes("dangling")));
    assert.ok(files.includes(join(crowHome, "bundles", "leaves", ".env")), "listed by its own name, so the spawn is refused");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

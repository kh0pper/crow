/**
 * Secret files the default-tier bot sandbox masks by file (hideFiles).
 * Fake values only; scratch dirs under os.tmpdir(). The bridge test sets its
 * own scratch HOME/CROW_HOME before bridge.mjs is imported.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { symlinkSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync,
  existsSync, linkSync, lstatSync, statSync, readdirSync, renameSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { secretFilesFor, secretPinDirsFor, unmaskableRefusal, SSH_NOT_HIDDEN_REFUSAL,
  SSH_DIR_REL, GNUPG_DIR_REL, GCLOUD_DIR_REL, HIDDEN_SECRET_DIRS, HIDDEN_SECRET_FILES, HIDDEN_DIR_STATE_PREFIX,
  HIDDEN_DIR_RESET_COMMAND, GNUPG_NOT_HIDDEN_REFUSAL, SSH_LINK_REFUSAL, GNUPG_LINK_REFUSAL,
  GCLOUD_NOT_HIDDEN_REFUSAL, GCLOUD_LINK_REFUSAL, gcloudNotHiddenRefusal, secretDirNotHiddenRefusal,
  secretNotHiddenRefusal, secretLinkRefusal, resolveHiddenSecretPath, resolveHiddenSecretFile,
  resolveHiddenSecretDir, readHiddenDirMemory, hiddenDirStatePath, resetHiddenDirIdentity,
  reConfirmRefusal, hiddenDirStateRefusal, hiddenDirResetCommand, DEFAULT_CROW_HOME_REL,
  innerEntryProblem, secretInnerLinkRefusal, secretInnerUnreadableRefusal, secretInnerTooManyRefusal,
  INNER_LINK_MAX_ENTRIES,
  BUNDLE_ENV_READABLE, ROOT_SECRET_FILES, isAddonsFileName } from "../scripts/pi-bots/hidden_files.mjs";
import { OPERATOR_SECRET_PATHS, OPERATOR_SECRET_DIRS, OPERATOR_SECRET_FILES,
  operatorSecretKind, operatorSecretPath, operatorSecretPaths } from "../servers/shared/operator-secret-paths.js";

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

test("isAddonsFileName: any name starting with mcp-addons (or .mcp-addons) at the root, every copy shape and temp file included, but not the .example template or a look-alike", () => {
  for (const n of ["mcp-addons.json", "mcp-addons.json.bak", "mcp-addons.json.bak-20261111",
    "mcp-addons.json.bak.1781654126", "mcp-addons.json.pre-fed-gov-data-20260511",
    "mcp-addons.json.pre-test-contamination-20260711",
    // Copies in other shapes, and an editor's backup.
    "mcp-addons.json~", "mcp-addons.json-2026-11-01", "mcp-addons.bak.json", "mcp-addons-old.json",
    // A temp file the gateway's writePrivateFile, or migrate-linked's
    // writeAtomicPrivate, holds beside the file until it renames it over it,
    // and the no-dot one scripts/ops/pin-addon-command.mjs writes.
    ".mcp-addons.json.tmp-12345-ab12cd34", ".mcp-addons.json.tmp-12345-lx9k2",
    "mcp-addons.json.tmp-1234",
    // Over-masking is the safe direction: a look-alike suffix inside the name
    // still counts.
    "mcp-addons.jsonx"]) {
    assert.equal(isAddonsFileName(n), true, n);
  }
  // The exemption is on the `.example.json` suffix, not on the name, so the
  // dotted template is exempt as well.
  for (const n of ["mcp-addons.example.json", ".mcp-addons.example.json", "xmcp-addons.json",
    ".env"]) {
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

// ---- resolveHiddenSecretDir: one walk, one identity memory (no bubblewrap) ----
//
// ~/.ssh, ~/.gnupg and ~/.config/gcloud are resolved by ONE helper, exercised
// here directly: every component below HOME is lstat'ed (a symlinked ~/.config
// is a refusal, not a mask on a decoy), a folder seen for the first time is
// remembered by (dev, ino), and one remembered and then missing or replaced
// refuses the spawn until the operator re-confirms.

/** A scratch home, its empty secrets dir and the identity record's path. */
function homeRig() {
  const root = mkdtempSync(join(tmpdir(), "crow-hidden-resolve-"));
  const home = join(root, "home");
  const secrets = join(root, "crow", "secrets");
  mkdirSync(home, { recursive: true });
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  const real = realpathSync(home);
  return { root, home: real, crowHome: join(root, "crow"), statePath: hiddenDirStatePath(join(root, "crow"), real) };
}

test("resolveHiddenSecretDir: the first sight records dev:ino 0600, and the next spawn accepts the same folder", () => {
  const rig = homeRig();
  const gcloud = join(rig.home, ".config", "gcloud");
  mkdirSync(gcloud, { recursive: true });
  try {
    const first = resolveHiddenSecretDir(rig.home, GCLOUD_DIR_REL, { statePath: rig.statePath });
    assert.equal(first.refusal, null);
    assert.equal(first.dir, gcloud, "the resolved folder");
    assert.equal(first.absent, false);
    assert.equal(first.remembered, false, "the first sight is new");
    assert.ok(existsSync(rig.statePath), "the first sight is recorded");
    assert.equal(statSync(rig.statePath).mode & 0o777, 0o600, "0600");
    assert.deepEqual(readHiddenDirMemory(rig.statePath).dirs[GCLOUD_DIR_REL], { dev: first.dev, ino: first.ino });
    assert.deepEqual(readdirSync(join(rig.root, "crow", "secrets")), [rig.statePath.slice(join(rig.root, "crow", "secrets").length + 1)],
      "one record and no temp file left behind");
    assert.ok(readdirSync(join(rig.root, "crow", "secrets"))[0].startsWith(HIDDEN_DIR_STATE_PREFIX), "the per-home record name");
    const second = resolveHiddenSecretDir(rig.home, GCLOUD_DIR_REL, { statePath: rig.statePath });
    assert.equal(second.refusal, null, "an unchanged folder starts");
    assert.equal(second.remembered, true);
    assert.equal(second.ino, first.ino);
    assert.deepEqual(resolveHiddenSecretDir(rig.home, SSH_DIR_REL, { statePath: rig.statePath }),
      { rel: SSH_DIR_REL, label: "~/.ssh", kind: "dir", dir: null, path: null, absent: true, remembered: false, refusal: null, cause: null },
      "an absent folder that was never seen is nothing to hide, and is not recorded");
  } finally { rmSync(rig.root, { recursive: true, force: true }); }
});

test("resolveHiddenSecretDir: a symlinked ~/.config refuses the gcloud folder (the mask would land on a decoy)", () => {
  const rig = homeRig();
  const decoy = join(rig.root, "decoy");
  mkdirSync(join(decoy, "gcloud"), { recursive: true });
  symlinkSync(decoy, join(rig.home, ".config"));
  try {
    const r = resolveHiddenSecretDir(rig.home, GCLOUD_DIR_REL, { statePath: rig.statePath });
    assert.equal(r.refusal, GCLOUD_LINK_REFUSAL, "one fixed sentence for the folder");
    assert.equal(r.dir, null, "no folder is handed to the mask");
    assert.equal(r.remembered, false);
    assert.ok(!r.refusal.includes(rig.root), "no path in the sentence (never the decoy)");
    assert.ok(!r.refusal.includes("gcloud/"));
    assert.equal(r.refusal, resolveHiddenSecretDir(rig.home, GCLOUD_DIR_REL).refusal,
      "the same sentence with no record at all");
    assert.equal(existsSync(rig.statePath), false, "a refused folder is never recorded");
  } finally { rmSync(rig.root, { recursive: true, force: true }); }
});

test("resolveHiddenSecretDir: a symlinked ~/.ssh and ~/.gnupg refuse with their own sentence, and a component that is a file refuses too", () => {
  const rig = homeRig();
  const real = join(rig.root, "real-dir");
  mkdirSync(real, { recursive: true });
  try {
    symlinkSync(real, join(rig.home, SSH_DIR_REL));
    assert.equal(resolveHiddenSecretDir(rig.home, SSH_DIR_REL, { statePath: rig.statePath }).refusal, SSH_LINK_REFUSAL);
    symlinkSync(real, join(rig.home, GNUPG_DIR_REL));
    assert.equal(resolveHiddenSecretDir(rig.home, GNUPG_DIR_REL, { statePath: rig.statePath }).refusal, GNUPG_LINK_REFUSAL);
    // ~/.config is a plain FILE: the folder cannot be there, and it is not the
    // shape Crow will mask either way.
    writeFileSync(join(rig.home, ".config"), "not a folder\n");
    assert.equal(resolveHiddenSecretDir(rig.home, GCLOUD_DIR_REL, { statePath: rig.statePath }).refusal, GCLOUD_LINK_REFUSAL);
    assert.equal(existsSync(rig.statePath), false, "nothing was recorded");
  } finally { rmSync(rig.root, { recursive: true, force: true }); }
});

test("resolveHiddenSecretDir: a remembered folder that is gone refuses, names the re-confirm remedy, and the reset clears it", () => {
  const rig = homeRig();
  const gcloud = join(rig.home, ".config", "gcloud");
  mkdirSync(gcloud, { recursive: true });
  try {
    assert.equal(resolveHiddenSecretDir(rig.home, GCLOUD_DIR_REL, { statePath: rig.statePath }).refusal, null);
    rmSync(gcloud, { recursive: true });
    const gone = resolveHiddenSecretDir(rig.home, GCLOUD_DIR_REL, { statePath: rig.statePath });
    assert.equal(gone.refusal, reConfirmRefusal(GCLOUD_DIR_REL, "missing", rig.statePath));
    assert.match(gone.refusal, /is gone now/);
    assert.match(gone.refusal, /--reset/, "the operator is told the remedy");
    assert.match(gone.refusal, new RegExp(rig.statePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "and the file to delete");
    assert.ok(!gone.refusal.includes("device"), "no internals in the sentence");
    assert.equal(resetHiddenDirIdentity(rig.statePath), true, "the operator's re-confirm removes the record");
    const after = resolveHiddenSecretDir(rig.home, GCLOUD_DIR_REL, { statePath: rig.statePath });
    assert.equal(after.refusal, null, "an absent folder with no record is nothing to hide again");
    assert.equal(after.absent, true);
    mkdirSync(gcloud, { recursive: true });
    const again = resolveHiddenSecretDir(rig.home, GCLOUD_DIR_REL, { statePath: rig.statePath });
    assert.equal(again.refusal, null, "the re-confirmed folder starts again");
    assert.equal(again.remembered, false, "and is recorded fresh");
    assert.deepEqual(readHiddenDirMemory(rig.statePath).dirs[GCLOUD_DIR_REL], { dev: again.dev, ino: again.ino });
  } finally { rmSync(rig.root, { recursive: true, force: true }); }
});

test("resolveHiddenSecretDir: a replaced folder (a new inode at the same path) refuses; the reset accepts the new folder", () => {
  const rig = homeRig();
  const gcloud = join(rig.home, ".config", "gcloud");
  mkdirSync(gcloud, { recursive: true });
  try {
    const first = resolveHiddenSecretDir(rig.home, GCLOUD_DIR_REL, { statePath: rig.statePath });
    assert.equal(first.refusal, null);
    rmSync(gcloud, { recursive: true });
    // The filesystem may hand the freed inode number to the next mkdir, so the
    // decoy is grown behind a filler until it really is a different inode.
    let now = null;
    for (let i = 0; i < 5; i++) {
      mkdirSync(join(rig.home, ".config", "filler-" + i));
      mkdirSync(gcloud);
      now = statSync(gcloud);
      if (now.ino !== first.ino) break;
      rmSync(gcloud, { recursive: true });
    }
    assert.notEqual(now.ino, first.ino, "precondition: a different folder really is at the path");
    const replaced = resolveHiddenSecretDir(rig.home, GCLOUD_DIR_REL, { statePath: rig.statePath });
    assert.equal(replaced.refusal, reConfirmRefusal(GCLOUD_DIR_REL, "replaced", rig.statePath));
    assert.match(replaced.refusal, /it was replaced/);
    assert.equal(replaced.dir, null);
    assert.equal(resetHiddenDirIdentity(rig.statePath), true);
    const after = resolveHiddenSecretDir(rig.home, GCLOUD_DIR_REL, { statePath: rig.statePath });
    assert.equal(after.refusal, null, "the re-confirmed folder starts");
    assert.equal(after.remembered, false, "and is recorded fresh");
    assert.deepEqual(readHiddenDirMemory(rig.statePath).dirs[GCLOUD_DIR_REL], { dev: now.dev, ino: now.ino });
  } finally { rmSync(rig.root, { recursive: true, force: true }); }
});

test("resolveHiddenSecretDir: an absent folder that was never seen is nothing to hide and is never created", () => {
  const rig = homeRig();
  try {
    for (const rel of HIDDEN_SECRET_DIRS) {
      const r = resolveHiddenSecretDir(rig.home, rel, { statePath: rig.statePath });
      assert.equal(r.absent, true, rel);
      assert.equal(r.refusal, null, rel);
      assert.equal(r.dir, null, rel);
    }
    assert.equal(existsSync(join(rig.home, ".config")), false, "nothing was created on the way");
    assert.equal(existsSync(join(rig.home, GCLOUD_DIR_REL)), false);
    assert.equal(existsSync(rig.statePath), false, "and nothing was recorded");
  } finally { rmSync(rig.root, { recursive: true, force: true }); }
});

test("resolveHiddenSecretDir: an unreadable or corrupt record refuses (fail closed), and the reset clears it", () => {
  const rig = homeRig();
  mkdirSync(join(rig.home, GNUPG_DIR_REL), { recursive: true });
  const corrupt = [
    "{not json",
    "[]",
    '"a string"',
    '{"version":1}',
    '{"version":99,"dirs":{}}',
    '{"version":1,"dirs":[]}',
    '{"version":1,"dirs":{".gnupg":{"dev":1}}}',
    '{"version":1,"dirs":{".gnupg":{"dev":"1","ino":2}}}',
  ];
  try {
    for (const body of corrupt) {
      writeFileSync(rig.statePath, body, { mode: 0o600 });
      const r = resolveHiddenSecretDir(rig.home, GNUPG_DIR_REL, { statePath: rig.statePath });
      assert.equal(r.refusal, hiddenDirStateRefusal(rig.statePath, "unreadable"), body);
      assert.match(r.refusal, /--reset/, "the same remedy");
      assert.equal(r.dir, null, "never handed to the mask");
    }
    // A DIRECTORY where the record belongs cannot be read either.
    rmSync(rig.statePath, { force: true });
    mkdirSync(rig.statePath);
    assert.equal(resolveHiddenSecretDir(rig.home, GNUPG_DIR_REL, { statePath: rig.statePath }).refusal,
      hiddenDirStateRefusal(rig.statePath, "unreadable"));
    rmSync(rig.statePath, { recursive: true, force: true });
    const after = resolveHiddenSecretDir(rig.home, GNUPG_DIR_REL, { statePath: rig.statePath });
    assert.equal(after.refusal, null, "a deleted record is a fresh start");
    assert.equal(after.remembered, false);
    assert.ok(existsSync(rig.statePath), "and the folder is recorded again");
  } finally { rmSync(rig.root, { recursive: true, force: true }); }
});

test("resolveHiddenSecretDir: a record Crow cannot WRITE refuses with its own sentence, not the unreadable one", () => {
  const rig = homeRig();
  const gcloud = join(rig.home, GCLOUD_DIR_REL);
  const secrets = dirname(rig.statePath);
  mkdirSync(gcloud, { recursive: true });
  chmodSync(secrets, 0o500);
  try {
    // Running as root would ignore the mode: probe instead of assuming.
    let writable = true;
    try { writeFileSync(join(secrets, "probe"), ""); rmSync(join(secrets, "probe"), { force: true }); } catch { writable = false; }
    const r = resolveHiddenSecretDir(rig.home, GCLOUD_DIR_REL, { statePath: rig.statePath });
    if (!writable) {
      assert.equal(r.cause, "record");
      assert.equal(r.recordWhy, "not writable", "the reason travels with the result, so the bell can say which");
      assert.match(r.refusal, /could not write its record/);
      assert.ok(!r.refusal.includes("unreadable"), "never the read sentence");
      assert.ok(!r.refusal.includes("--reset"), "a reset fails for the same reason the write did");
      assert.equal(existsSync(rig.statePath), false, "nothing was recorded");
    } else {
      assert.equal(r.refusal, null, "a writable secrets dir records as usual");
    }
  } finally {
    chmodSync(secrets, 0o700);
    rmSync(rig.root, { recursive: true, force: true });
  }
});

test("resolveHiddenSecretDir: HOME may itself be a symlink: it is resolved once as the anchor, and both spellings agree", () => {
  const rig = homeRig();
  const realHome = join(rig.root, "real-home");
  mkdirSync(join(realHome, SSH_DIR_REL), { recursive: true });
  symlinkSync(realHome, join(rig.root, "linked-home"));
  try {
    const viaLink = resolveHiddenSecretDir(join(rig.root, "linked-home"), SSH_DIR_REL, { statePath: rig.statePath });
    assert.equal(viaLink.refusal, null, "a link ABOVE the home is not the attack");
    assert.equal(viaLink.dir, join(realpathSync(realHome), SSH_DIR_REL), "masked at the resolved path");
    const viaReal = resolveHiddenSecretDir(realHome, SSH_DIR_REL, { statePath: rig.statePath });
    assert.equal(viaReal.refusal, null);
    assert.equal(viaReal.remembered, true, "one folder, one record: the anchor is resolved the same way");
    assert.equal(viaReal.ino, viaLink.ino);
  } finally { rmSync(rig.root, { recursive: true, force: true }); }
});

test("hidden-dir-memory CLI: --list shows what is recorded, --reset forgets it, and a corrupt record exits non-zero", () => {
  const rig = homeRig();
  const crowHome = rig.crowHome;
  const statePath = rig.statePath;
  const script = join(import.meta.dirname, "..", "scripts", "pi-bots", "hidden-dir-memory.mjs");
  const run = (...args) => spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8", env: { ...process.env, CROW_HOME: crowHome },
  });
  try {
    mkdirSync(join(rig.home, GCLOUD_DIR_REL), { recursive: true });
    const recorded = resolveHiddenSecretDir(rig.home, GCLOUD_DIR_REL, { statePath });
    assert.equal(recorded.refusal, null);
    const listed = run("--list");
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /~\/\.config\/gcloud/);
    assert.match(listed.stdout, new RegExp(String(recorded.ino)));
    const reset = run("--reset");
    assert.equal(reset.status, 0, reset.stderr);
    assert.equal(existsSync(statePath), false, "the record is gone");
    assert.equal(run("--reset").status, 0, "a second reset is quiet");
    writeFileSync(statePath, "{broken", { mode: 0o600 });
    const bad = run("--list");
    assert.equal(bad.status, 1, "a corrupt record is reported, never guessed at");
    assert.match(bad.stderr, /--reset/);
    assert.equal(run("--nonsense").status, 2);
    assert.equal(run("--help").status, 0);
    assert.equal(HIDDEN_DIR_RESET_COMMAND, "node scripts/pi-bots/hidden-dir-memory.mjs --reset");
  } finally { rmSync(rig.root, { recursive: true, force: true }); }
});

test("hidden-dir-memory CLI: --crow-home acts on THAT instance's record only, so a co-hosted bell cannot reset the default instance's", () => {
  const rig = homeRig();
  const defaultCrow = rig.crowHome;
  const coCrow = join(rig.root, "crow-r4");
  const coState = hiddenDirStatePath(coCrow, rig.home);
  mkdirSync(join(coCrow, "secrets"), { recursive: true, mode: 0o700 });
  const script = join(import.meta.dirname, "..", "scripts", "pi-bots", "hidden-dir-memory.mjs");
  // The shell here resolves the DEFAULT instance (CROW_HOME); the flag has to win.
  const run = (...args) => spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8", env: { ...process.env, CROW_HOME: defaultCrow },
  });
  try {
    mkdirSync(join(rig.home, GCLOUD_DIR_REL), { recursive: true });
    mkdirSync(join(rig.home, GNUPG_DIR_REL), { recursive: true });
    assert.equal(resolveHiddenSecretDir(rig.home, GCLOUD_DIR_REL, { statePath: rig.statePath }).refusal, null);
    assert.equal(resolveHiddenSecretDir(rig.home, GNUPG_DIR_REL, { statePath: coState }).refusal, null);
    assert.ok(existsSync(rig.statePath) && existsSync(coState), "one record in each instance");
    const listed = run("--list", "--crow-home", coCrow);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /~\/\.gnupg/);
    assert.ok(!/\.config\/gcloud/.test(listed.stdout), "the default instance's record is not listed");
    assert.match(run("--list", "--crow-home=" + coCrow).stdout, /~\/\.gnupg/, "the = form works too");
    const reset = run("--reset", "--crow-home", coCrow);
    assert.equal(reset.status, 0, reset.stderr);
    assert.equal(existsSync(coState), false, "the co-hosted instance's record is gone");
    assert.equal(existsSync(rig.statePath), true, "the default instance's record is untouched");
    // A flag with no value is a usage error, never a silent reset of the default home.
    assert.equal(run("--reset", "--crow-home").status, 2);
    assert.equal(existsSync(rig.statePath), true, "still untouched");
  } finally { rmSync(rig.root, { recursive: true, force: true }); }
});

test("hiddenDirResetCommand: the default home keeps the bare command; a co-hosted home is named ~-relative with --crow-home", () => {
  const root = mkdtempSync(join(tmpdir(), "crow-hidden-reset-cmd-"));
  const home = realpathSync(root);
  try {
    assert.equal(hiddenDirResetCommand(), HIDDEN_DIR_RESET_COMMAND, "no home known: the plain command");
    assert.equal(hiddenDirResetCommand({ crowHome: join(home, DEFAULT_CROW_HOME_REL), homeDir: home }), HIDDEN_DIR_RESET_COMMAND,
      "the default instance needs no flag");
    const co = hiddenDirResetCommand({ crowHome: join(home, ".crow-r4"), homeDir: home });
    assert.equal(co, HIDDEN_DIR_RESET_COMMAND + " --crow-home ~/.crow-r4", "a co-hosted instance names its own home");
    assert.ok(!co.includes(home), "and never the absolute path");
    assert.equal(hiddenDirResetCommand({ crowHome: join(home, "srv", "crow-x"), homeDir: home }),
      HIDDEN_DIR_RESET_COMMAND + " --crow-home ~/srv/crow-x", "anywhere below the home folder");
    // Outside the operator's home folder there is no ~-relative spelling, and a
    // bell never carries an absolute path: the operator passes --crow-home.
    assert.equal(hiddenDirResetCommand({ crowHome: "/srv/crow-x", homeDir: home }), HIDDEN_DIR_RESET_COMMAND);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("resolveHiddenSecretDir: a refusal on a co-hosted instance names THAT instance's reset command", () => {
  // The operator's real home is what the ~-relative form is relative to; no
  // directory is created there, only the path is spelled out.
  const homeDir = realpathSync(homedir());
  const coCrowHome = join(homeDir, ".crow-r4");
  for (const cause of ["missing", "record"]) {
    const rig = homeRig();
    const gcloud = join(rig.home, GCLOUD_DIR_REL);
    mkdirSync(gcloud, { recursive: true });
    try {
      assert.equal(resolveHiddenSecretDir(rig.home, GCLOUD_DIR_REL, { statePath: rig.statePath }).refusal, null);
      if (cause === "missing") rmSync(gcloud, { recursive: true });
      else writeFileSync(rig.statePath, "{broken", { mode: 0o600 });
      const co = resolveHiddenSecretDir(rig.home, GCLOUD_DIR_REL, { statePath: rig.statePath, crowHome: coCrowHome });
      assert.equal(co.cause, cause);
      assert.ok(co.refusal.includes("--crow-home ~/.crow-r4"), co.refusal);
      assert.ok(!co.refusal.includes(coCrowHome), "the instance home is named ~-relative, never absolute");
      assert.equal(co.refusal, cause === "missing"
        ? reConfirmRefusal(GCLOUD_DIR_REL, "missing", rig.statePath, "dir", { crowHome: coCrowHome })
        : hiddenDirStateRefusal(rig.statePath, "unreadable", { crowHome: coCrowHome }));
      // With no Crow home known, the same refusal keeps the plain command: the
      // default instance's.
      const plain = resolveHiddenSecretDir(rig.home, GCLOUD_DIR_REL, { statePath: rig.statePath });
      assert.equal(plain.refusal, cause === "missing"
        ? reConfirmRefusal(GCLOUD_DIR_REL, "missing", rig.statePath)
        : hiddenDirStateRefusal(rig.statePath, "unreadable"));
      assert.ok(!plain.refusal.includes("--crow-home"));
    } finally { rmSync(rig.root, { recursive: true, force: true }); }
  }
});

test("innerEntryProblem: a link is found by lstat, a folder past the cap is refused, and one that cannot be listed is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "crow-hidden-inner-"));
  try {
    const dir = join(root, "folder");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "real-file"), "fake\n");
    assert.equal(innerEntryProblem(dir), null, "real entries are fine");
    symlinkSync(join(dir, "real-file"), join(dir, "link"));
    assert.deepEqual(innerEntryProblem(dir), { cause: "inner-link", name: "link" });
    rmSync(join(dir, "link"));
    assert.deepEqual(innerEntryProblem(dir, 1), { cause: "inner-many", count: 2 }, "past the cap: refused, never half-checked");
    assert.equal(INNER_LINK_MAX_ENTRIES, 1000, "the shipped cap");
    const full = join(root, "full");
    mkdirSync(full);
    for (let i = 0; i <= INNER_LINK_MAX_ENTRIES; i++) writeFileSync(join(full, "f" + i), "");
    assert.deepEqual(innerEntryProblem(full), { cause: "inner-many", count: INNER_LINK_MAX_ENTRIES + 1 });
    assert.deepEqual(innerEntryProblem(join(root, "absent")), { cause: "inner-unreadable" }, "an entry Crow cannot inspect is never assumed clean");
    assert.match(secretInnerUnreadableRefusal(SSH_DIR_REL), /could not look inside ~\/\.ssh/);
    assert.match(secretInnerTooManyRefusal(SSH_DIR_REL, 1001), /~\/\.ssh holds 1001 entries/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("resolveHiddenSecretDir: a link directly inside a secret folder refuses on the first sight (and is never recorded), and on every later one", () => {
  const rig = homeRig();
  const gcloud = join(rig.home, GCLOUD_DIR_REL);
  const inside = "application_default_credentials.json";
  mkdirSync(join(rig.root, "keys"), { recursive: true });
  writeFileSync(join(rig.root, "keys", "fake.json"), '{"fake":"adc"}\n');
  mkdirSync(gcloud, { recursive: true });
  try {
    // The whole-folder mask hides the link's NAME, not what it points at: the
    // file behind it stays readable in the sandbox.
    symlinkSync(join(rig.root, "keys", "fake.json"), join(gcloud, inside));
    const first = resolveHiddenSecretDir(rig.home, GCLOUD_DIR_REL, { statePath: rig.statePath });
    assert.equal(first.cause, "inner-link", "the first sight is who makes a decoy trusted, so it is refused");
    assert.equal(first.refusal, secretInnerLinkRefusal(GCLOUD_DIR_REL, inside));
    assert.equal(first.innerName, inside, "the entry the operator knows, and the link's name in it");
    assert.equal(first.dir, null, "nothing is handed to the mask");
    assert.ok(!first.refusal.includes(rig.root), "the link's target is never named");
    assert.equal(existsSync(rig.statePath), false, "a folder with a link in it is never recorded");
    // The operator's fix: a real file in the folder. Then it starts and is recorded.
    rmSync(join(gcloud, inside));
    writeFileSync(join(gcloud, inside), '{"fake":"adc"}\n', { mode: 0o600 });
    const after = resolveHiddenSecretDir(rig.home, GCLOUD_DIR_REL, { statePath: rig.statePath });
    assert.equal(after.refusal, null);
    assert.ok(existsSync(rig.statePath), "recorded now");
    // A link added to a folder Crow already records refuses the NEXT spawn too: a
    // key moved out through a link is exactly as readable as one in a decoy.
    symlinkSync(join(rig.root, "keys", "fake.json"), join(gcloud, "link-added-later"));
    const later = resolveHiddenSecretDir(rig.home, GCLOUD_DIR_REL, { statePath: rig.statePath });
    assert.equal(later.cause, "inner-link");
    assert.equal(later.innerName, "link-added-later");
    assert.equal(later.remembered, true, "the identity still matches: it is the link, not the folder, that refuses");
  } finally { rmSync(rig.root, { recursive: true, force: true }); }
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
/** The record the bridge keeps of the operator's secret folders for THIS scratch
 *  instance, and the operator's re-confirm. A test that removes or replaces one
 *  of the three folders (~/.ssh, ~/.gnupg, ~/.config/gcloud) forgets it, so the
 *  next spawn records again — exactly what an operator does (the bridge reads
 *  and writes it through the anchored secrets dir: the same file). */
const HIDDEN_DIR_MEMORY = hiddenDirStatePath(CROW, USER_HOME);
function forgetHiddenDirs() { rmSync(HIDDEN_DIR_MEMORY, { force: true }); }
// The co-host scan must not read the HOST's /etc (a dev box with a declared
// extra Crow home would change these spawns): point its /etc half at scratch,
// empty dirs. $HOME is the scratch home above, so the per-user unit dir stays.
const SCAN_UNITS = join(USER_HOME, "scan-units");
const SCAN_ENV = join(USER_HOME, "scan-etc-crow");
mkdirSync(SCAN_UNITS, { recursive: true });
mkdirSync(SCAN_ENV, { recursive: true });
const { _setSystemScanDirsForTest } = await import("../servers/shared/secret-values.js");
_setSystemScanDirsForTest({ unitDirs: [SCAN_UNITS], envFileDirs: [SCAN_ENV] });

const { PiRpc, homeMatchesResolved, logUnhideableOnce, _resetUnhideableLogForTest, CROW_DB } = await import("../scripts/pi-bots/bridge.mjs");
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

test("a .env listed inside a hidden folder (env/) refuses with the hidden-folder sentence, naming the file's own path", { skip: noSandbox }, async () => {
  // The bundle link is resolved by the listing, so the candidate IS the file at
  // its real path (env/sub/.env): the file itself sits in a folder hidden WHOLE,
  // not behind a link, so the sentence names the file's own relative path.
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

test("a root .env that is a link into a hidden folder refuses, naming the LINK (.env), not the file it points at", { skip: noSandbox }, async () => {
  // env/ is hidden WHOLE, so a link leading into it is the refusal. The link is
  // on the candidate's own path, so the sentence names the LINK below its root
  // (the way a link-out names its link), never the target behind it.
  const target = join(CROW, "env", "sub");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "real.env"), "fake-linked-hidden-env\n", { mode: 0o600 });
  const link = join(CROW, ".env");
  rmSync(link, { force: true });
  symlinkSync(join(target, "real.env"), link);
  try {
    const e = await spawnOutcome();
    assert.ok(e, "the spawn is refused");
    assert.equal(e.message, "A bot could not start: .env is a link into a hidden folder, so Crow can't hide it. Remove the link.");
    assert.ok(!e.message.includes("fake-linked-hidden-env"), "no content in the message");
    assert.ok(!e.message.includes("real.env"), "and not the file the link leads to");
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

test("secretFilesFor / secretPinDirsFor: a bundle entry that is a dangling (or looping) symlink is skipped, never a throw", () => {
  // An operator's home really holds entries like this (a bundle removed under a
  // link, a half-migrated install). The bundle scan must step over them: a dir
  // scan that threw here would fail every bot spawn, and a co-hosted home is
  // scanned too, so one odd entry there would take down another instance.
  const root = mkdtempSync(join(tmpdir(), "crow-hidden-dangling-bundle-"));
  const crowHome = join(root, ".crow");
  const bundles = join(crowHome, "bundles");
  mkdirSync(bundles, { recursive: true });
  mkdirSync(join(bundles, "real"), { recursive: true });
  writeFileSync(join(bundles, "real", ".env"), "fake-real-env\n");
  symlinkSync(join(root, "nowhere"), join(bundles, "gone-bundle"));
  symlinkSync(join(bundles, "loop-b"), join(bundles, "loop-a"));
  symlinkSync(join(bundles, "loop-a"), join(bundles, "loop-b"));
  symlinkSync(join(crowHome, "manifest-elsewhere.json"), join(bundles, "file-link"));
  writeFileSync(join(crowHome, "manifest-elsewhere.json"), "{}\n");
  try {
    const files = secretFilesFor({ crowHome });
    assert.ok(files.includes(join(bundles, "real", ".env")), "the real bundle is still masked");
    for (const odd of ["gone-bundle", "loop-a", "loop-b", "file-link"]) {
      assert.ok(!files.some((f) => f.includes(join("bundles", odd))), "no candidate from " + odd);
    }
    assert.deepEqual(secretPinDirsFor({ crowHome }), [bundles, join(bundles, "real")],
      "only the real dirs are pinned (a link is never pinned)");
    assert.doesNotThrow(() => secretFilesFor({ crowHome }), "a second scan is just as quiet");
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
  assert.equal(SSH_NOT_HIDDEN_REFUSAL, secretNotHiddenRefusal(SSH_DIR_REL), "one sentence per entry, built from its name");
  // The bridge asks the shared rule for every entry of the list and throws what
  // it answers, rather than a copy of any sentence (the refusal is not reachable
  // in a unit test: forcing bwrap to fail one mask needs a host that has bwrap).
  const bridge = readFileSync(join(import.meta.dirname, "..", "scripts", "pi-bots", "bridge.mjs"), "utf8");
  assert.ok(bridge.includes("secretDirNotHiddenRefusal({ dir: secret.dir, refusal: secretNotHiddenRefusal(secret.rel), masked: launch.masked })"),
    "the bridge asks the shared rule with its launch's mask list, for every entry of the list");
  assert.ok(!bridge.includes("Crow could not hide ~/.ssh."), "and holds no copy of it");
});

test("GCLOUD_NOT_HIDDEN_REFUSAL: the shared sentence, decided by gcloudNotHiddenRefusal, only for a folder that exists", () => {
  assert.equal(GCLOUD_DIR_REL, ".config/gcloud", "the Google Cloud CLI's credential folder, below the home");
  assert.equal(GCLOUD_NOT_HIDDEN_REFUSAL, "A bot could not start: Crow could not hide ~/.config/gcloud.");
  // BEHAVIOUR, not a regex over the bridge: the refusal rule is one function, so
  // it is exercised directly. A host with no gcloud CLI must start exactly as
  // before; a folder the launch reports masked is fine; a folder that was found
  // and is not in the mask list refuses; a launch that reports no mask list at
  // all is not trusted.
  assert.equal(gcloudNotHiddenRefusal({ gcloudDir: null, masked: [] }), null, "no gcloud CLI on this host: nothing to refuse");
  assert.equal(gcloudNotHiddenRefusal(), null, "no folder at all is never a refusal");
  assert.equal(gcloudNotHiddenRefusal({ gcloudDir: "/h/.config/gcloud", masked: ["/h/.config/gcloud", "/x"] }), null, "masked: the spawn runs");
  assert.equal(gcloudNotHiddenRefusal({ gcloudDir: "/h/.config/gcloud", masked: ["/x"] }), GCLOUD_NOT_HIDDEN_REFUSAL, "found but not masked: refused");
  assert.equal(gcloudNotHiddenRefusal({ gcloudDir: "/h/.config/gcloud", masked: undefined }), GCLOUD_NOT_HIDDEN_REFUSAL, "a launch that reports nothing is not trusted");
  // ~/.gnupg is hidden whole on the default tier too, and gets the same
  // hidden-or-refuse rule (one generic function, two named sentences).
  assert.equal(GNUPG_NOT_HIDDEN_REFUSAL, "A bot could not start: Crow could not hide ~/.gnupg.");
  assert.equal(secretDirNotHiddenRefusal({ dir: null, refusal: GNUPG_NOT_HIDDEN_REFUSAL, masked: [] }), null, "no gpg on this host: nothing to refuse");
  assert.equal(secretDirNotHiddenRefusal({ dir: "/h/.gnupg", refusal: GNUPG_NOT_HIDDEN_REFUSAL, masked: ["/h/.gnupg"] }), null, "masked: the spawn runs");
  assert.equal(secretDirNotHiddenRefusal({ dir: "/h/.gnupg", refusal: GNUPG_NOT_HIDDEN_REFUSAL, masked: [] }), GNUPG_NOT_HIDDEN_REFUSAL, "found but not masked: refused");
  assert.equal(secretDirNotHiddenRefusal({ dir: "/h/.gnupg", refusal: GNUPG_NOT_HIDDEN_REFUSAL, masked: undefined }), GNUPG_NOT_HIDDEN_REFUSAL, "a launch that reports nothing is not trusted");
  assert.equal(gcloudNotHiddenRefusal({ gcloudDir: "/h/.config/gcloud", masked: [] }),
    secretDirNotHiddenRefusal({ dir: "/h/.config/gcloud", refusal: GCLOUD_NOT_HIDDEN_REFUSAL, masked: [] }), "gcloud is the same rule");
  // Wiring only, and the one thing the helper cannot prove: the bridge asks the
  // shared rule with THIS launch's own mask list (forcing bwrap to fail a single
  // mask needs a real bwrap host, so the end-to-end refusal stays the
  // orchestrator's to run; the spawn tests below cover the other half — the
  // folder hidden when it exists, and never created when it does not).
  const bridge = readFileSync(join(import.meta.dirname, "..", "scripts", "pi-bots", "bridge.mjs"), "utf8");
  assert.ok(bridge.includes("secretDirNotHiddenRefusal({ dir: secret.dir, refusal: secretNotHiddenRefusal(secret.rel), masked: launch.masked })"),
    "the bridge asks the shared rule with its launch's mask list");
  assert.ok(bridge.includes("HIDDEN_SECRET_DIRS.map(resolveSecretDir)"), "every folder of the list is resolved, not a hand-written three");
  assert.ok(bridge.includes("HIDDEN_SECRET_FILES.map((rel) => resolveSecretPath(rel, \"file\"))"),
    "and every file of the list too");
  assert.ok(!bridge.includes("Crow could not hide ~/.gnupg."), "and holds no copy of that sentence");
  assert.ok(!bridge.includes("Crow could not hide ~/.config/gcloud."), "and holds no copy of the sentence");
  assert.ok(!/mkdirSync\([^)]*gcloud/.test(bridge), "Crow never creates ~/.config/gcloud");
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
    // `masked` is every path the launch masked (a folder by tmpfs included),
    // `maskedFiles` only the --dev-bind /dev/null ones.
    return { report: r, masked: pi.sandboxMasked, maskedFiles: pi.sandboxMaskedFiles };
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
  forgetHiddenDirs(); // an operator removing ~/.ssh on purpose re-confirms first
  try {
    const { report } = await spawnReport({ dirs: { ssh: sshDir } });
    assert.ok(existsSync(sshDir), "the bridge created the folder before the spawn");
    assert.equal(statSync(sshDir).mode & 0o777, 0o700, "0700");
    assert.deepEqual(report.list.ssh, [], "empty inside");
    assert.deepEqual(readHiddenDirMemory(HIDDEN_DIR_MEMORY).dirs[SSH_DIR_REL],
      { dev: statSync(sshDir).dev, ino: statSync(sshDir).ino }, "the folder it created is recorded");
  } finally { forgetHiddenDirs(); }
});

test("~/.config/gcloud is hidden whole when it exists: the gcloud credentials are unreadable inside", { skip: noSandbox }, async () => {
  const gcloudDir = join(USER_HOME, GCLOUD_DIR_REL);
  mkdirSync(join(gcloudDir, "legacy_credentials"), { recursive: true });
  const adc = join(gcloudDir, "application_default_credentials.json");
  writeFileSync(adc, '{"fake":"application-default-credentials"}\n', { mode: 0o600 });
  try {
    const { report } = await spawnReport({ dirs: { gcloud: gcloudDir }, files: { adc } });
    assert.deepEqual(report.list.gcloud, [], "~/.config/gcloud is an empty tmpfs inside");
    assert.equal(report.len.adc, "ENOENT", "a bot cannot read application_default_credentials.json inside");
    assert.equal(readFileSync(adc, "utf8").includes("application-default-credentials"), true, "the file on disk keeps its content");
    assert.deepEqual(readHiddenDirMemory(HIDDEN_DIR_MEMORY).dirs[GCLOUD_DIR_REL],
      { dev: statSync(gcloudDir).dev, ino: statSync(gcloudDir).ino }, "the folder's identity was recorded");
  } finally {
    rmSync(gcloudDir, { recursive: true, force: true });
    forgetHiddenDirs();
  }
});

test("~/.config/gcloud is never created when it is missing, and the spawn still starts", { skip: noSandbox }, async () => {
  const gcloudDir = join(USER_HOME, GCLOUD_DIR_REL);
  rmSync(gcloudDir, { recursive: true, force: true });
  forgetHiddenDirs();
  try {
    const { report } = await spawnReport({ dirs: { gcloud: gcloudDir } });
    assert.equal(report.list.gcloud, "ENOENT", "nothing is there inside either");
    assert.equal(existsSync(gcloudDir), false, "Crow did not create it (no gcloud CLI on this host)");
    assert.equal(readHiddenDirMemory(HIDDEN_DIR_MEMORY).dirs[GCLOUD_DIR_REL], undefined,
      "and an absent folder is not recorded");
  } finally { rmSync(gcloudDir, { recursive: true, force: true }); forgetHiddenDirs(); }
});

test("~/.config/gcloud that is a SYMLINK refuses the spawn: the mask follows the link, and a bot could re-point it", { skip: noSandbox }, async () => {
  assert.equal(GCLOUD_LINK_REFUSAL, "A bot could not start: ~/.config/gcloud is a link, or sits behind one, so Crow can't hide the credentials in it. Replace it with a real folder.");
  const gcloudDir = join(USER_HOME, GCLOUD_DIR_REL);
  const realDir = join(USER_HOME, "real-gcloud");
  rmSync(gcloudDir, { recursive: true, force: true });
  rmSync(realDir, { recursive: true, force: true });
  forgetHiddenDirs();
  mkdirSync(join(USER_HOME, ".config"), { recursive: true });
  mkdirSync(realDir, { recursive: true });
  const adc = join(realDir, "application_default_credentials.json");
  writeFileSync(adc, '{"fake":"application-default-credentials"}\n', { mode: 0o600 });
  symlinkSync(realDir, gcloudDir);
  try {
    const e = await spawnOutcome();
    assert.ok(e, "the spawn is refused");
    assert.equal(e.message, GCLOUD_LINK_REFUSAL, "one fixed sentence, so the fix is obvious");
    assert.ok(!e.message.includes("application-default-credentials"), "no content in the message");
  } finally {
    rmSync(gcloudDir, { force: true });
    rmSync(realDir, { recursive: true, force: true });
    forgetHiddenDirs();
  }
});

test("a symlinked ~/.config refuses the spawn: the gcloud mask would land on a decoy the bot could plant", async () => {
  // ~/.config is writable inside the default sandbox, so a bot can swap it for
  // a link to a folder of its own. The old check lstat'ed only the LAST
  // component (~/.config/gcloud), so this shape was masked at the decoy and the
  // real credentials folder stayed readable on the host.
  const decoy = mkdtempSync(join(tmpdir(), "crow-hidden-configdecoy-"));
  mkdirSync(join(decoy, "gcloud"), { recursive: true });
  const adc = join(decoy, "gcloud", "application_default_credentials.json");
  writeFileSync(adc, '{"fake":"application-default-credentials"}\n', { mode: 0o600 });
  const configDir = join(USER_HOME, ".config");
  rmSync(configDir, { recursive: true, force: true });
  forgetHiddenDirs();
  symlinkSync(decoy, configDir);
  try {
    const e = await spawnOutcome();
    assert.ok(e, "the spawn is refused");
    assert.equal(e.message, GCLOUD_LINK_REFUSAL, "the gcloud sentence, whatever link it is behind");
    assert.ok(!e.message.includes(decoy), "no decoy path in the sentence");
    assert.ok(!e.message.includes("application-default-credentials"), "no content in the sentence");
    assert.equal(lstatSync(configDir).isSymbolicLink(), true, "and nothing was created over the link");
  } finally {
    rmSync(configDir, { force: true });
    rmSync(decoy, { recursive: true, force: true });
    forgetHiddenDirs();
  }
});

test("a symlinked ~/.ssh refuses the spawn instead of being mkdir'ed over", async () => {
  assert.equal(SSH_LINK_REFUSAL, "A bot could not start: ~/.ssh is a link, or sits behind one, so Crow can't hide the keys in it. Replace it with a real folder.");
  const sshDir = join(USER_HOME, SSH_DIR_REL);
  const realDir = mkdtempSync(join(tmpdir(), "crow-hidden-sshlink-"));
  writeFileSync(join(realDir, "id_fake"), "fake-ssh-key\n", { mode: 0o600 });
  rmSync(sshDir, { recursive: true, force: true });
  forgetHiddenDirs();
  symlinkSync(realDir, sshDir);
  try {
    const e = await spawnOutcome();
    assert.ok(e, "the spawn is refused");
    assert.equal(e.message, SSH_LINK_REFUSAL);
    assert.ok(!e.message.includes("fake-ssh-key"), "no content in the sentence");
    assert.equal(lstatSync(sshDir).isSymbolicLink(), true, "the link is untouched (an EEXIST mkdir proved nothing before)");
  } finally {
    rmSync(sshDir, { force: true });
    rmSync(realDir, { recursive: true, force: true });
    forgetHiddenDirs();
  }
});

test("a gcloud folder Crow remembered is refused once it is gone, until the operator re-confirms", async () => {
  const gcloudDir = join(USER_HOME, GCLOUD_DIR_REL);
  rmSync(gcloudDir, { recursive: true, force: true });
  forgetHiddenDirs();
  mkdirSync(gcloudDir, { recursive: true });
  writeFileSync(join(gcloudDir, "application_default_credentials.json"), '{"fake":"adc"}\n', { mode: 0o600 });
  try {
    assert.equal(await spawnOutcome(), null, "the first sight starts and records");
    assert.ok(existsSync(HIDDEN_DIR_MEMORY), "the identity record exists");
    assert.equal(statSync(HIDDEN_DIR_MEMORY).mode & 0o777, 0o600, "0600");
    assert.deepEqual(readHiddenDirMemory(HIDDEN_DIR_MEMORY).dirs[GCLOUD_DIR_REL],
      { dev: statSync(gcloudDir).dev, ino: statSync(gcloudDir).ino }, "recorded by dev:ino");
    // The folder goes missing (or is renamed away) after Crow hid it once.
    rmSync(gcloudDir, { recursive: true });
    const e = await spawnOutcome();
    assert.ok(e, "the spawn is refused: a hidden folder disappearing is the tamper signal");
    assert.equal(e.message, reConfirmRefusal(GCLOUD_DIR_REL, "missing", HIDDEN_DIR_MEMORY));
    assert.match(e.message, /is gone now/);
    assert.match(e.message, /--reset/, "the operator is told the remedy");
    // The remedy: forget the record; the next spawn records whatever is there.
    assert.equal(resetHiddenDirIdentity(HIDDEN_DIR_MEMORY), true);
    assert.equal(await spawnOutcome(), null, "after the re-confirm the spawn starts again");
    assert.equal(existsSync(gcloudDir), false, "and gcloud is still never created");
    assert.equal(readHiddenDirMemory(HIDDEN_DIR_MEMORY).dirs[GCLOUD_DIR_REL], undefined,
      "an absent folder is not recorded");
  } finally {
    rmSync(gcloudDir, { recursive: true, force: true });
    forgetHiddenDirs();
  }
});

test("a gcloud folder REPLACED by another folder (a new inode) is refused, until the operator re-confirms", async () => {
  const gcloudDir = join(USER_HOME, GCLOUD_DIR_REL);
  rmSync(gcloudDir, { recursive: true, force: true });
  forgetHiddenDirs();
  mkdirSync(gcloudDir, { recursive: true });
  try {
    assert.equal(await spawnOutcome(), null, "the first sight starts and records");
    const recorded = readHiddenDirMemory(HIDDEN_DIR_MEMORY).dirs[GCLOUD_DIR_REL];
    assert.deepEqual(recorded, { dev: statSync(gcloudDir).dev, ino: statSync(gcloudDir).ino });
    // rm + mkdir at the same path. The freed inode number may be handed to the
    // next mkdir, so grow a filler first until the folder really is a new one.
    rmSync(gcloudDir, { recursive: true });
    let now = null;
    for (let i = 0; i < 5; i++) {
      mkdirSync(join(USER_HOME, ".config", "filler-" + i));
      mkdirSync(gcloudDir);
      now = statSync(gcloudDir);
      if (now.ino !== recorded.ino) break;
      rmSync(gcloudDir, { recursive: true });
    }
    assert.notEqual(now.ino, recorded.ino, "precondition: a different folder is at the path");
    const e = await spawnOutcome();
    assert.ok(e, "the spawn is refused");
    assert.equal(e.message, reConfirmRefusal(GCLOUD_DIR_REL, "replaced", HIDDEN_DIR_MEMORY));
    assert.match(e.message, /it was replaced/);
    assert.equal(resetHiddenDirIdentity(HIDDEN_DIR_MEMORY), true);
    assert.equal(await spawnOutcome(), null, "the re-confirmed folder starts");
    assert.deepEqual(readHiddenDirMemory(HIDDEN_DIR_MEMORY).dirs[GCLOUD_DIR_REL],
      { dev: now.dev, ino: now.ino }, "and the new folder is recorded");
  } finally {
    rmSync(gcloudDir, { recursive: true, force: true });
    forgetHiddenDirs();
  }
});

test("an unreadable identity record refuses the spawn (fail closed) with the same remedy", async () => {
  const gcloudDir = join(USER_HOME, GCLOUD_DIR_REL);
  rmSync(gcloudDir, { recursive: true, force: true });
  forgetHiddenDirs();
  try {
    for (const body of ["{not json", '{"version":1,"dirs":[]}', '{"version":7,"dirs":{}}']) {
      writeFileSync(HIDDEN_DIR_MEMORY, body, { mode: 0o600 });
      const e = await spawnOutcome();
      assert.ok(e, "the spawn is refused: " + body);
      assert.equal(e.message, hiddenDirStateRefusal(HIDDEN_DIR_MEMORY, "unreadable"));
      assert.match(e.message, /--reset/, "the same remedy");
    }
    rmSync(HIDDEN_DIR_MEMORY, { force: true });
    assert.equal(await spawnOutcome(), null, "a deleted record is a fresh start");
  } finally {
    rmSync(gcloudDir, { recursive: true, force: true });
    forgetHiddenDirs();
  }
});

test("~/.gnupg is hidden whole when it exists, and never created when it does not", { skip: noSandbox }, async () => {
  const gnupgDir = join(USER_HOME, GNUPG_DIR_REL);
  rmSync(gnupgDir, { recursive: true, force: true });
  forgetHiddenDirs();
  try {
    const absent = await spawnReport({ dirs: { gnupg: gnupgDir } });
    assert.equal(absent.report.list.gnupg, "ENOENT", "nothing there, nothing inside either");
    assert.equal(existsSync(gnupgDir), false, "Crow did not create it (no gpg on this host)");
    mkdirSync(join(gnupgDir, "private-keys-v1.d"), { recursive: true });
    const key = join(gnupgDir, "private-keys-v1.d", "fake.key");
    writeFileSync(key, "fake-gpg-key-material\n", { mode: 0o600 });
    const hidden = await spawnReport({ dirs: { gnupg: gnupgDir }, files: { key } });
    assert.deepEqual(hidden.report.list.gnupg, [], "~/.gnupg is an empty tmpfs inside");
    assert.equal(hidden.report.len.key, "ENOENT", "a bot cannot read a gpg private key inside");
  } finally {
    rmSync(gnupgDir, { recursive: true, force: true });
    forgetHiddenDirs();
  }
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

test("a root .env.bak-<date> copy reads empty inside a sandboxed spawn and keeps its content on disk", { skip: noSandbox }, async () => {
  // The .env* name rule covers a backup copy beside the real file: it is a
  // secret of its own, masked at its own name like the plain .env.
  const backup = join(CROW, ".env.bak-20261101");
  const value = "fake-env-backup-value\n";
  writeFileSync(backup, value, { mode: 0o600 });
  try {
    const { report, masked } = await spawnReport({ files: { backup } });
    assert.equal(report.len.backup, 0, "the backup copy reads empty inside");
    assert.ok(masked.includes(join(REAL_CROW, ".env.bak-20261101")), "masked at its own name");
    assert.equal(readFileSync(backup, "utf8"), value, "the file on disk keeps its content");
  } finally { rmSync(backup, { force: true }); }
});

test("the add-on registry and its backups read empty inside a sandboxed spawn; mcp-addons.example.json stays readable", { skip: noSandbox }, async () => {
  const addons = join(CROW, "mcp-addons.json");
  const addonsBackup = join(CROW, "mcp-addons.json.bak-20261111");
  const addonsExample = join(CROW, "mcp-addons.example.json");
  const addonsTmp = join(CROW, ".mcp-addons.json.tmp-x");
  const addonsTmpNoDot = join(CROW, "mcp-addons.json.tmp-1234");
  const fake = '{"fake-addon":{"env":{"FAKE_KEY":"fake-value"}}}\n';
  for (const p of [addons, addonsBackup, addonsExample, addonsTmp, addonsTmpNoDot]) writeFileSync(p, fake, { mode: 0o600 });
  try {
    const { report, masked } = await spawnReport({ files: { addons, addonsBackup, addonsExample, addonsTmp, addonsTmpNoDot } });
    assert.equal(report.len.addons, 0, "mcp-addons.json reads empty inside");
    assert.equal(report.len.addonsBackup, 0, "its .bak-<date> copy reads empty inside");
    assert.equal(report.len.addonsTmp, 0, "its temp file reads empty inside");
    assert.equal(report.len.addonsTmpNoDot, 0, "its no-dot temp file reads empty inside");
    assert.equal(report.len.addonsExample, readFileSync(addonsExample).length,
      "the .example template is documentation and stays readable");
    for (const p of ["mcp-addons.json", "mcp-addons.json.bak-20261111", ".mcp-addons.json.tmp-x",
      "mcp-addons.json.tmp-1234"]) {
      assert.ok(masked.includes(join(REAL_CROW, p)), "masked: " + p);
    }
    assert.equal(masked.includes(join(REAL_CROW, "mcp-addons.example.json")), false,
      "the .example template is not masked");
  } finally {
    for (const p of [addons, addonsBackup, addonsExample, addonsTmp, addonsTmpNoDot]) rmSync(p, { force: true });
  }
});

test("mcp-addons.json with another hard link refuses the spawn, naming it and no content", { skip: noSandbox }, async () => {
  const addons = join(CROW, "mcp-addons.json");
  const extra = join(CROW, "addons-copy");
  const fake = '{"fake-addon":{"env":{"FAKE_KEY":"fake-hardlinked-value"}}}\n';
  writeFileSync(addons, fake, { mode: 0o600 });
  // A second name on disk (masking one leaves the other readable). The extra
  // name does NOT match the add-on rule, so only the hard link on the registry
  // itself can be the reason for the refusal.
  linkSync(addons, extra);
  try {
    const e = await spawnOutcome();
    assert.ok(e, "the spawn is refused");
    assert.equal(e.message, "A bot could not start: mcp-addons.json has another name on disk, so Crow can't hide it. Remove the extra link.");
    assert.ok(!e.message.includes("fake-hardlinked-value"), "no content in the message");
  } finally { rmSync(extra, { force: true }); rmSync(addons, { force: true }); }
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

// ---- ONE list of operator credential locations, folders and files ----------
//
// OPERATOR_SECRET_PATHS (servers/shared/operator-secret-paths.js) is the only
// place these paths are named. Everything below is table-driven over it, so a
// new entry is covered here the moment it is added — folders (hidden whole,
// like ~/.config/gcloud) and files (masked with an empty one) alike.

/** A stable key for a rel, for the spawn stub's report. */
const keyOf = (rel) => rel.replace(/[^a-z0-9]+/gi, "_");

/** The path of one entry below `home`. */
const entryPath = (home, rel) => join(home, ...rel.split("/"));

test("the one list: both kinds come from OPERATOR_SECRET_PATHS, and the helpers make one path per entry", () => {
  assert.deepEqual(HIDDEN_SECRET_DIRS, OPERATOR_SECRET_DIRS, "the bot helper hides exactly the list's folders");
  assert.deepEqual(HIDDEN_SECRET_FILES, OPERATOR_SECRET_FILES, "and masks exactly its files");
  for (const rel of [SSH_DIR_REL, GNUPG_DIR_REL, GCLOUD_DIR_REL]) {
    assert.ok(HIDDEN_SECRET_DIRS.includes(rel), "the folders that shipped first are still in it: " + rel);
    assert.equal(operatorSecretKind(rel), "dir", rel);
  }
  for (const rel of [".aws", ".azure", ".kube", ".config/gh", ".terraform.d"]) {
    assert.ok(HIDDEN_SECRET_DIRS.includes(rel), "a folder hidden whole: " + rel);
  }
  for (const rel of [".docker/config.json", ".netrc", ".npmrc", ".pgpass", ".config/containers/auth.json"]) {
    assert.ok(HIDDEN_SECRET_FILES.includes(rel), "a file masked with an empty one: " + rel);
    assert.equal(operatorSecretKind(rel), "file", rel);
  }
  assert.equal(operatorSecretKind(".not-on-the-list"), null);
  assert.deepEqual(operatorSecretPaths("/h"), OPERATOR_SECRET_PATHS.map(({ rel }) => join("/h", rel)));
  assert.equal(operatorSecretPath("/h/", ".netrc"), join("/h", ".netrc"), "one separator, never two");
  assert.ok(Object.isFrozen(OPERATOR_SECRET_PATHS), "nobody appends to the list at run time");
  // The sentences are built from the entry's name, so a new entry needs no new
  // sentence, and the three that shipped first keep the exact wording.
  assert.equal(secretNotHiddenRefusal(GCLOUD_DIR_REL), GCLOUD_NOT_HIDDEN_REFUSAL);
  assert.equal(secretNotHiddenRefusal(GNUPG_DIR_REL), GNUPG_NOT_HIDDEN_REFUSAL);
  assert.equal(secretLinkRefusal(SSH_DIR_REL, "dir"), SSH_LINK_REFUSAL, "the keys sentence for ~/.ssh");
  assert.equal(secretLinkRefusal(GCLOUD_DIR_REL, "dir"), GCLOUD_LINK_REFUSAL, "the credentials sentence for a folder");
  assert.equal(secretLinkRefusal(".netrc", "file"),
    "A bot could not start: ~/.netrc is a link, or sits behind one, so Crow can't hide the credentials in it. Replace it with a real file.");
  assert.equal(secretLinkRefusal(".aws", "dir"),
    "A bot could not start: ~/.aws is a link, or sits behind one, so Crow can't hide the credentials in it. Replace it with a real folder.");
});

test("every entry of the list: present is returned, absent is never created, and only a FOLDER is remembered — a file rewrite is no re-confirm", () => {
  for (const { rel, kind } of OPERATOR_SECRET_PATHS) {
    const rig = homeRig();
    const target = entryPath(rig.home, rel);
    const resolve = () => (kind === "file" ? resolveHiddenSecretFile : resolveHiddenSecretDir)(rig.home, rel, { statePath: rig.statePath });
    try {
      // Absent: nothing is there, nothing is created, nothing is recorded.
      const absent = resolve();
      assert.equal(absent.absent, true, rel);
      assert.equal(absent.refusal, null, rel);
      assert.equal(absent.path, null, rel);
      assert.equal(existsSync(target), false, "an absent entry is never created: " + rel);
      assert.equal(existsSync(rig.statePath), false, "and never recorded: " + rel);
      // Present: the folder, or the file itself.
      mkdirSync(dirname(target), { recursive: true });
      if (kind === "dir") mkdirSync(target); else writeFileSync(target, "fake-credential\n", { mode: 0o600 });
      const present = resolve();
      assert.equal(present.refusal, null, rel);
      assert.equal(present.path, target, rel);
      assert.equal(present.dir, kind === "dir" ? target : null, "a file is not a folder: " + rel);
      assert.equal(present.kind, kind, rel);
      assert.equal(present.remembered, false, rel);
      if (kind === "dir") {
        assert.deepEqual(readHiddenDirMemory(rig.statePath).dirs[rel], { dev: present.dev, ino: present.ino },
          "a FOLDER is recorded by dev:ino, 0600, in the instance's record: " + rel);
      } else {
        // A FILE carries no identity memory: `npm config set` / `docker login`
        // rename a new inode over it every day, and that must not stop every bot.
        assert.equal(readHiddenDirMemory(rig.statePath).dirs[rel], undefined,
          "a FILE is never recorded (an ordinary rewrite would become a refusal): " + rel);
        assert.equal(existsSync(rig.statePath), false, "and writing nothing means no record file at all: " + rel);
      }
      // Gone.
      rmSync(target, { recursive: kind === "dir" });
      const gone = resolve();
      if (kind === "dir") {
        // The tamper signal, with the re-confirm remedy.
        assert.equal(gone.refusal, reConfirmRefusal(rel, "missing", rig.statePath, kind), rel);
        assert.equal(gone.cause, "missing", rel);
        assert.match(gone.refusal, /--reset/, rel);
        assert.equal(resetHiddenDirIdentity(rig.statePath), true, rel);
        assert.equal(resolve().refusal, null, "after the re-confirm an absent entry is nothing to hide: " + rel);
      } else {
        assert.equal(gone.refusal, null, "a credential FILE that is gone is nothing to mask: " + rel);
        assert.equal(gone.absent, true, rel);
        assert.equal(gone.cause, null, rel);
      }
    } finally { rmSync(rig.root, { recursive: true, force: true }); }
  }
});

test("a FILE rewritten under a new inode (npm config set, docker login) is masked on the next spawn, never refused", () => {
  // The availability rule: an ordinary operator rewrite must not stop every bot.
  // The name is kept, the inode changes — exactly what an atomic rename does.
  const rig = homeRig();
  const rels = HIDDEN_SECRET_FILES;
  const before = {};
  const resolve = (rel) => resolveHiddenSecretFile(rig.home, rel, { statePath: rig.statePath });
  try {
    for (const rel of rels) {
      const p = entryPath(rig.home, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, "fake-old-token\n", { mode: 0o600 });
      const first = resolve(rel);
      assert.equal(first.refusal, null, rel);
      before[rel] = first.ino;
    }
    for (const rel of rels) {
      const p = entryPath(rig.home, rel);
      // The rename shape: write a temp file in the same folder, then rename it
      // over the old name (a new inode at the same path).
      const tmp = p + ".tmp-1234";
      writeFileSync(tmp, "fake-new-token\n", { mode: 0o600 });
      renameSync(tmp, p);
      const again = resolve(rel);
      assert.equal(again.refusal, null, "a rewritten credential file never needs a re-confirm: " + rel);
      assert.equal(again.path, p, rel);
      assert.notEqual(again.ino, before[rel], "precondition: a new inode is at the path: " + rel);
      assert.equal(readHiddenDirMemory(rig.statePath).dirs[rel], undefined, "and still nothing is recorded: " + rel);
    }
    // A legacy record that still holds a file entry (written by an older build)
    // cannot refuse one either: the entry is dropped when the record is read.
    writeFileSync(rig.statePath, JSON.stringify({ version: 1, home: rig.home,
      dirs: { [rels[0]]: { dev: 1, ino: 1 } } }, null, 2), { mode: 0o600 });
    assert.deepEqual(readHiddenDirMemory(rig.statePath).dirs, {}, "an old file entry is forgotten, not compared");
    assert.equal(resolve(rels[0]).refusal, null, "so the spawn is not refused for it");
  } finally { rmSync(rig.root, { recursive: true, force: true }); }
});

test("a FOLDER keeps its identity through an ordinary tool flow: files written inside it (gcloud auth login) change nothing it remembers", () => {
  // Only the folder's OWN dev:ino is remembered — never contents, sizes or
  // mtimes — so `gcloud auth login` writing files INSIDE ~/.config/gcloud must
  // not trip the re-confirm. (The folder's inode is unchanged by that.)
  const rig = homeRig();
  const dir = entryPath(rig.home, GCLOUD_DIR_REL);
  mkdirSync(dir, { recursive: true });
  try {
    const first = resolveHiddenSecretDir(rig.home, GCLOUD_DIR_REL, { statePath: rig.statePath });
    assert.equal(first.refusal, null);
    assert.deepEqual(readHiddenDirMemory(rig.statePath).dirs[GCLOUD_DIR_REL], { dev: first.dev, ino: first.ino },
      "the record holds the folder's identity and nothing else");
    // A login: new files, subfolders and mtimes inside the folder.
    writeFileSync(join(dir, "credentials.db"), "fake-gcloud-db\n", { mode: 0o600 });
    mkdirSync(join(dir, "legacy_credentials"));
    writeFileSync(join(dir, "legacy_credentials", "fake.json"), '{"fake":"adc"}\n', { mode: 0o600 });
    writeFileSync(join(dir, "application_default_credentials.json"), '{"fake":"adc"}\n', { mode: 0o600 });
    const again = resolveHiddenSecretDir(rig.home, GCLOUD_DIR_REL, { statePath: rig.statePath });
    assert.equal(again.refusal, null, "a normal token refresh inside the folder is not a tamper signal");
    assert.equal(again.remembered, true, "the folder is still the remembered one");
    assert.equal(again.ino, first.ino, "the same folder, so the same inode");
    assert.deepEqual(readHiddenDirMemory(rig.statePath).dirs[GCLOUD_DIR_REL], { dev: first.dev, ino: first.ino },
      "and the record did not change");
  } finally { rmSync(rig.root, { recursive: true, force: true }); }
});

test("every entry of the list: a symlinked leaf or a symlinked component refuses the spawn, in one fixed sentence, with nothing recorded", () => {
  for (const { rel, kind } of OPERATOR_SECRET_PATHS) {
    // A symlinked LEAF (the last component alone).
    const rig = homeRig();
    const target = entryPath(rig.home, rel);
    const decoy = join(rig.root, "decoy-" + keyOf(rel));
    try {
      mkdirSync(decoy, { recursive: true });
      if (kind === "dir") { mkdirSync(decoy, { recursive: true }); } else { writeFileSync(join(decoy, "x"), "fake\n"); }
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(kind === "dir" ? decoy : join(decoy, "x"), target);
      const r = resolveHiddenSecretPath(rig.home, rel, { kind, statePath: rig.statePath });
      assert.equal(r.refusal, secretLinkRefusal(rel, kind), "one sentence, whatever the link points at: " + rel);
      assert.equal(r.path, null, "no path is handed to the mask: " + rel);
      assert.ok(!r.refusal.includes(rig.root), "no decoy path in the sentence: " + rel);
      assert.equal(existsSync(rig.statePath), false, "a refused entry is never recorded: " + rel);
      assert.equal(lstatSync(target).isSymbolicLink(), true, "and nothing is created over the link: " + rel);
    } finally { rmSync(rig.root, { recursive: true, force: true }); }
  }
  // A symlinked COMPONENT: ~/.config itself (or ~/.docker) is a link, so the
  // mask would land on a decoy a bot could plant and re-point.
  for (const { rel, kind } of OPERATOR_SECRET_PATHS.filter((p) => p.rel.includes("/"))) {
    const rig = homeRig();
    const decoy = join(rig.root, "decoy-component-" + keyOf(rel));
    const top = join(rig.home, rel.split("/")[0]);
    try {
      const inner = entryPath(decoy, rel.split("/").slice(1).join("/"));
      mkdirSync(dirname(inner), { recursive: true });
      if (kind === "dir") mkdirSync(inner); else writeFileSync(inner, "fake-credential\n");
      symlinkSync(decoy, top);
      const r = resolveHiddenSecretPath(rig.home, rel, { kind, statePath: rig.statePath });
      assert.equal(r.refusal, secretLinkRefusal(rel, kind), "a link anywhere on the way refuses: " + rel);
      assert.equal(r.path, null, rel);
      assert.equal(existsSync(rig.statePath), false, rel);
    } finally { rmSync(rig.root, { recursive: true, force: true }); }
  }
});

test("every entry of the list is unreachable inside a sandboxed spawn: folders list empty, files read empty, and the disk keeps its content", { skip: noSandbox }, async () => {
  const files = {};
  const dirs = {};
  const created = [];
  for (const { rel, kind } of OPERATOR_SECRET_PATHS) {
    const p = entryPath(USER_HOME, rel);
    mkdirSync(dirname(p), { recursive: true });
    if (kind === "dir") { mkdirSync(p, { recursive: true }); writeFileSync(join(p, "fake-credential"), "fake-credential\n", { mode: 0o600 }); }
    else writeFileSync(p, "fake-credential\n", { mode: 0o600 });
    created.push(p);
    if (kind === "dir") {
      dirs[keyOf(rel)] = p;
      // A FILE inside the folder too: an empty listing alone would not prove the
      // folder is hidden (an empty folder lists empty as well), a read of the
      // content that was really written does.
      files[keyOf(rel) + "_inner"] = join(p, "fake-credential");
    } else files[keyOf(rel)] = p;
  }
  forgetHiddenDirs();
  try {
    // `masked` is the launch's FULL mask list (folders by tmpfs, files by
    // --dev-bind /dev/null); `maskedFiles` holds the file masks alone, so a
    // folder is never in it.
    const { report, masked, maskedFiles } = await spawnReport({ files, dirs });
    for (const { rel, kind } of OPERATOR_SECRET_PATHS) {
      const key = keyOf(rel);
      const p = entryPath(USER_HOME, rel);
      if (kind === "dir") {
        assert.deepEqual(report.list[key], [], "a folder hidden whole lists empty inside: " + rel);
        assert.equal(report.len[key + "_inner"], "ENOENT", "and a file inside it cannot be read inside: " + rel);
        assert.ok(masked.includes(realpathSync(p)), "and the launch reports it masked: " + rel);
        assert.equal(maskedFiles.includes(realpathSync(p)), false, "a folder is masked by a tmpfs, not as a file: " + rel);
      } else {
        assert.equal(report.len[key], 0, "a file reads empty inside: " + rel);
        assert.ok(masked.includes(realpathSync(p)), "and the launch reports it masked: " + rel);
        assert.ok(maskedFiles.includes(realpathSync(p)), "a file mask is in the file-mask list too: " + rel);
        assert.equal(readFileSync(p, "utf8"), "fake-credential\n", "the operator's file keeps its content: " + rel);
      }
    }
    assert.deepEqual(readHiddenDirMemory(HIDDEN_DIR_MEMORY).dirs[SSH_DIR_REL],
      { dev: statSync(join(USER_HOME, SSH_DIR_REL)).dev, ino: statSync(join(USER_HOME, SSH_DIR_REL)).ino },
      "the FOLDER it hid is recorded (a file entry never is)");
    for (const rel of HIDDEN_SECRET_FILES) {
      assert.equal(readHiddenDirMemory(HIDDEN_DIR_MEMORY).dirs[rel], undefined,
        "no file entry in the record: " + rel);
    }
  } finally {
    for (const p of created) rmSync(p, { recursive: true, force: true });
    forgetHiddenDirs();
  }
});

test("every entry of the list is never created when absent, and the spawn still starts (~/.ssh is the one exception)", { skip: noSandbox }, async () => {
  for (const { rel } of OPERATOR_SECRET_PATHS) rmSync(entryPath(USER_HOME, rel), { recursive: true, force: true });
  forgetHiddenDirs();
  try {
    const files = {};
    const dirs = {};
    for (const { rel, kind } of OPERATOR_SECRET_PATHS) {
      if (kind === "dir") dirs[keyOf(rel)] = entryPath(USER_HOME, rel); else files[keyOf(rel)] = entryPath(USER_HOME, rel);
    }
    const { report } = await spawnReport({ files, dirs });
    for (const { rel, kind } of OPERATOR_SECRET_PATHS) {
      const key = keyOf(rel);
      const p = entryPath(USER_HOME, rel);
      if (rel === SSH_DIR_REL) {
        assert.equal(existsSync(p), true, "~/.ssh is created empty: its mask must always apply");
        assert.equal(statSync(p).mode & 0o777, 0o700, "0700");
        continue;
      }
      assert.equal(kind === "dir" ? report.list[key] : report.len[key], "ENOENT", "nothing there, inside either: " + rel);
      assert.equal(existsSync(p), false, "Crow did not create it: " + rel);
    }
  } finally {
    for (const { rel } of OPERATOR_SECRET_PATHS) rmSync(entryPath(USER_HOME, rel), { recursive: true, force: true });
    forgetHiddenDirs();
  }
});

test("the Python guard mirrors the operator list (parsed from local_paths.py)", () => {
  // The google-workspace add-on's guard runs in another language, inside its own
  // bundle, and must refuse a path even when it is not walled — so it keeps its
  // own copy. This parses that copy out and holds the two in step, in both
  // directions: a path only one layer knows about is the dangerous direction.
  const py = readFileSync(join(import.meta.dirname, "..", "bundles", "google-workspace",
    "google_workspace_mcp", "local_paths.py"), "utf8");
  const block = py.match(/_PRIVATE_PATTERNS = \(([\s\S]*?)\n\)/);
  assert.ok(block, "_PRIVATE_PATTERNS is where the Python guard keeps its list");
  const mirrored = [...block[1].matchAll(/\("~([^"*]+)",/g)].map((m) => m[1].replace(/^\//, ""));
  assert.ok(mirrored.length >= OPERATOR_SECRET_PATHS.length, "parsed " + mirrored.length + " Python entries");
  assert.deepEqual([...mirrored].sort(), OPERATOR_SECRET_PATHS.map((p) => p.rel).sort(),
    "the Python guard and OPERATOR_SECRET_PATHS name the same paths");
  // The one Python-only entry is the glob for a second account's sign-in folder.
  assert.ok(block[1].includes("google-workspace-mcp*"), "the sign-in sibling glob stays Python-only");
});

// ---- the operator bell a refused spawn raises --------------------------------
//
// A refusal stops EVERY bot on the instance, and the operator does not read a
// channel bot's failed turn. So the same refusal rings the in-app bell: one
// `notifications` row (hidden-dir-alert.mjs), deduped per entry per 24 h, and —
// when the store cannot be used at all — a file in the DB-free alert spool the
// gateway drains into the same bell.

const { bellHiddenDirRefusal, spoolHiddenDirRefusal, notifyHiddenDirRefusal, hiddenDirAlertText,
  HIDDEN_DIR_ALERT_SOURCE, HIDDEN_DIR_ALERT_COOLDOWN_MS, HIDDEN_DIR_ALERT_ACTION_URL } =
  await import("../scripts/pi-bots/hidden-dir-alert.mjs");
const { _setAlertsRootForTest, alertsDirs } = await import("../servers/shared/alert-spool.js");
const Database = (await import("better-sqlite3")).default;

/** A scratch crow.db with just the two tables the bell touches. */
function bellStore(dir = null) {
  const root = dir || mkdtempSync(join(tmpdir(), "crow-hidden-bell-"));
  mkdirSync(root, { recursive: true });
  const dbPath = join(root, "crow.db");
  const conn = new Database(dbPath);
  conn.exec(`
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL DEFAULT 'system', source TEXT, title TEXT NOT NULL, body TEXT,
      priority TEXT DEFAULT 'normal', action_url TEXT, metadata TEXT,
      is_read INTEGER DEFAULT 0, is_dismissed INTEGER DEFAULT 0, snoozed_until TEXT,
      schedule_id INTEGER, expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
  `);
  conn.close();
  return {
    root, dbPath,
    rows() { const c = new Database(dbPath, { readonly: true }); try { return c.prepare("SELECT * FROM notifications ORDER BY id").all(); } finally { c.close(); } },
    setPrefs(json) { const c = new Database(dbPath); try { c.prepare("INSERT OR REPLACE INTO dashboard_settings (key, value) VALUES ('notification_prefs', ?)").run(json); } finally { c.close(); } },
  };
}

test("hiddenDirAlertText: names the entry ~-relative and the exact reset command, and never a path", () => {
  for (const cause of ["missing", "replaced", "link", "unmasked", "record"]) {
    const { title, body } = hiddenDirAlertText({ rel: GCLOUD_DIR_REL, kind: "dir", cause });
    assert.match(title, /^A bot could not start: ~\/\.config\/gcloud$/, cause);
    assert.ok(body.includes(HIDDEN_DIR_RESET_COMMAND), "the operator gets the exact command: " + cause);
    assert.ok(!/\/(home|Users|root)\//.test(body), "no absolute path in the bell: " + cause);
    assert.ok(!body.includes(USER_HOME), "not even the scratch home: " + cause);
    if (cause === "link") {
      assert.match(body, /Remove the link \(or, if you use that tool, replace it with a real folder\), then run /,
        "a link that should not be there is removed, not replaced: the tool case is the parenthetical");
    }
    if (cause === "missing") assert.match(body, /is gone now/);
    if (cause === "replaced") assert.match(body, /it was replaced/);
    if (cause === "record") assert.match(body, /is unreadable/, "a record Crow cannot READ says so");
  }
  const file = hiddenDirAlertText({ rel: ".netrc", kind: "file", cause: "replaced" });
  assert.match(file.body, /is not the file Crow hid the last time/, "a file entry keeps its noun");
  assert.match(hiddenDirAlertText({ rel: ".netrc", kind: "file", cause: "link" }).body,
    /replace it with a real file/, "and its own noun in the remedy");
});

test("hiddenDirAlertText: each cause gets the remedy that fits it, and a co-hosted instance gets its own command", () => {
  const link = hiddenDirAlertText({ rel: SSH_DIR_REL, kind: "dir", cause: "link" });
  assert.ok(link.body.includes(HIDDEN_DIR_RESET_COMMAND + " and start the bot again."), link.body);
  const innerLink = hiddenDirAlertText({ rel: SSH_DIR_REL, kind: "dir", cause: "inner-link", entry: "id_rsa" });
  assert.match(innerLink.body, /~\/\.ssh\/id_rsa/, "the link's name in the folder is named");
  assert.match(innerLink.body, /Replace the link with a real file in the folder/);
  assert.ok(innerLink.body.includes(HIDDEN_DIR_RESET_COMMAND), "with the re-confirm command");
  const unreadableFolder = hiddenDirAlertText({ rel: SSH_DIR_REL, kind: "dir", cause: "inner-link" });
  assert.match(unreadableFolder.body, /could not look inside ~\/\.ssh/);
  assert.match(unreadableFolder.body, /Make the folder readable/, "a different remedy: there is no link to remove");
  const many = hiddenDirAlertText({ rel: SSH_DIR_REL, kind: "dir", cause: "inner-many", count: 1001 });
  assert.match(many.body, /holds 1001 entries/);
  assert.match(many.body, /Move the folder's contents aside/);
  const unreadableRecord = hiddenDirAlertText({ rel: GCLOUD_DIR_REL, kind: "dir", cause: "record" });
  const unwritableRecord = hiddenDirAlertText({ rel: GCLOUD_DIR_REL, kind: "dir", cause: "record", recordWhy: "not writable" });
  assert.match(unreadableRecord.body, /is unreadable/);
  assert.match(unwritableRecord.body, /could not write its record/);
  assert.ok(!unwritableRecord.body.includes("unreadable"), "the two record causes are not one sentence");
  assert.match(unwritableRecord.body, /secrets folder is writable/, "and the remedy is the permissions, not a reset");
  assert.ok(!unwritableRecord.body.includes(HIDDEN_DIR_RESET_COMMAND), "a reset cannot fix an unwritable record");
  for (const t of [link, innerLink, unreadableFolder, many, unreadableRecord, unwritableRecord]) {
    assert.ok(!/\/(home|Users|root)\//.test(t.body), "no absolute path in any of them: " + t.body);
    assert.ok(!t.body.includes(USER_HOME));
  }
  // The instance that refused, not the shell's default: ~-relative, no path.
  const homeDir = realpathSync(homedir());
  const co = hiddenDirAlertText({ rel: GCLOUD_DIR_REL, kind: "dir", cause: "missing", crowHome: join(homeDir, ".crow-r4") });
  assert.ok(co.body.includes(HIDDEN_DIR_RESET_COMMAND + " --crow-home ~/.crow-r4"), co.body);
  assert.ok(!co.body.includes(homeDir), "never the absolute home");
});

test("bellHiddenDirRefusal: the row carries the refusing instance's command and the link's name, and an unwritable record is not offered a reset", () => {
  const store = bellStore();
  const homeDir = realpathSync(homedir());
  try {
    assert.equal(bellHiddenDirRefusal({ dbPath: store.dbPath, rel: SSH_DIR_REL, kind: "dir", cause: "inner-link",
      entry: "id_rsa", crowHome: join(homeDir, ".crow-r4") }).written, true);
    const row = store.rows()[0];
    assert.ok(row.body.includes(HIDDEN_DIR_RESET_COMMAND + " --crow-home ~/.crow-r4"), row.body);
    assert.ok(!row.body.includes(homeDir), "no absolute path in the bell");
    const meta = JSON.parse(row.metadata);
    assert.equal(meta.cause, "inner-link");
    assert.equal(meta.hidden_entry, "id_rsa", "which entry inside the folder, never what it points at");
    assert.equal(meta.hidden_rel, SSH_DIR_REL);
    assert.equal(bellHiddenDirRefusal({ dbPath: store.dbPath, rel: GCLOUD_DIR_REL, kind: "dir",
      cause: "record", recordWhy: "not writable" }).written, true);
    const second = store.rows()[1];
    assert.match(second.body, /could not write its record/);
    assert.ok(!second.body.includes(HIDDEN_DIR_RESET_COMMAND), "a reset fails for the same reason the write did");
    assert.equal(JSON.parse(second.metadata).hidden_record, "not writable");
  } finally { rmSync(store.root, { recursive: true, force: true }); }
});

test("bellHiddenDirRefusal: one high-priority system bell per entry per 24 h, a second entry gets its own", () => {
  const store = bellStore();
  const t0 = Date.parse("2026-03-01T12:00:00.000Z");
  try {
    const first = bellHiddenDirRefusal({ dbPath: store.dbPath, rel: GCLOUD_DIR_REL, kind: "dir", cause: "missing", nowMs: t0 });
    assert.equal(first.written, true);
    const rows = store.rows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, "system");
    assert.equal(rows[0].priority, "high");
    assert.equal(rows[0].source, HIDDEN_DIR_ALERT_SOURCE);
    assert.equal(rows[0].action_url, HIDDEN_DIR_ALERT_ACTION_URL);
    assert.equal(rows[0].title, "A bot could not start: ~/" + GCLOUD_DIR_REL);
    const meta = JSON.parse(rows[0].metadata);
    assert.equal(meta.hidden_rel, GCLOUD_DIR_REL);
    assert.equal(meta.cause, "missing");
    // The same entry again inside the window: no second bell.
    const again = bellHiddenDirRefusal({ dbPath: store.dbPath, rel: GCLOUD_DIR_REL, kind: "dir", cause: "missing", nowMs: t0 + 60_000 });
    assert.equal(again.written, false);
    assert.equal(again.reason, "deduped");
    assert.equal(store.rows().length, 1, "still one row");
    // A DIFFERENT entry has its own window.
    assert.equal(bellHiddenDirRefusal({ dbPath: store.dbPath, rel: SSH_DIR_REL, kind: "dir", cause: "link", nowMs: t0 + 60_001 }).written, true);
    assert.equal(store.rows().length, 2);
    // Past the 24 h window the same entry rings again (the condition is still there).
    assert.equal(bellHiddenDirRefusal({ dbPath: store.dbPath, rel: GCLOUD_DIR_REL, kind: "dir", cause: "missing", nowMs: t0 + HIDDEN_DIR_ALERT_COOLDOWN_MS + 60_000 }).written, true);
    assert.equal(store.rows().length, 3);
  } finally { rmSync(store.root, { recursive: true, force: true }); }
});

test("bellHiddenDirRefusal: the operator's 'system' preference silences it, and a missing store is reported, never created", () => {
  const store = bellStore();
  try {
    store.setPrefs(JSON.stringify({ types_enabled: ["attention"] }));
    const off = bellHiddenDirRefusal({ dbPath: store.dbPath, rel: GCLOUD_DIR_REL, kind: "dir", cause: "missing" });
    assert.equal(off.written, false);
    assert.equal(off.reason, "disabled", "a silenced type is a choice, not a failure");
    assert.equal(store.rows().length, 0);
    // No store file at all: the refusal must not CREATE one.
    const missing = join(store.root, "nope", "crow.db");
    const none = bellHiddenDirRefusal({ dbPath: missing, rel: GCLOUD_DIR_REL, kind: "dir", cause: "missing" });
    assert.equal(none.written, false);
    assert.equal(none.reason, "error");
    assert.equal(existsSync(missing), false, "a refused spawn never creates crow.db");
    assert.equal(bellHiddenDirRefusal({ rel: GCLOUD_DIR_REL }).reason, "no-store", "no path, no store");
  } finally { rmSync(store.root, { recursive: true, force: true }); }
});

test("notifyHiddenDirRefusal: the spool is the fallback only, one file per entry per 24 h, and never a duplicate bell", () => {
  const store = bellStore();
  const alerts = mkdtempSync(join(tmpdir(), "crow-hidden-bell-spool-"));
  _setAlertsRootForTest(join(alerts, "alerts"));
  const t0 = Date.parse("2026-03-01T12:00:00.000Z");
  try {
    // With a usable store: a row, and no spool file (one event, one bell).
    const bell = notifyHiddenDirRefusal({ dbPath: store.dbPath, rel: GCLOUD_DIR_REL, kind: "dir", cause: "missing", nowMs: t0 });
    assert.equal(bell.written, true);
    assert.equal(bell.spooled, false);
    assert.equal(existsSync(alertsDirs().pending), false, "no spool file when the bell was written");
    // With no store: the DB-free spool, once per entry per window.
    const spooled = notifyHiddenDirRefusal({ dbPath: join(store.root, "absent", "crow.db"), rel: GCLOUD_DIR_REL, kind: "dir", cause: "missing", nowMs: t0 });
    assert.equal(spooled.written, false);
    assert.equal(spooled.spooled, true);
    const pending = readdirSync(alertsDirs().pending).sort();
    assert.equal(pending.length, 1, "one spool file: " + JSON.stringify(pending));
    const record = JSON.parse(readFileSync(join(alertsDirs().pending, pending[0]), "utf8"));
    assert.match(record.title, /A bot could not start: ~\/\.config\/gcloud/);
    assert.match(record.body, /--reset/);
    assert.ok(!record.body.includes(store.root), "no absolute path in the spooled bell");
    // A refusal loop inside the window rewrites the same file.
    notifyHiddenDirRefusal({ dbPath: join(store.root, "absent", "crow.db"), rel: GCLOUD_DIR_REL, kind: "dir", cause: "missing", nowMs: t0 + 60_000 });
    assert.equal(readdirSync(alertsDirs().pending).length, 1, "the loop does not flood the spool");
    // A different entry, and the next window, each get a file of their own.
    assert.ok(spoolHiddenDirRefusal({ rel: SSH_DIR_REL, kind: "dir", cause: "link", nowMs: t0 }));
    assert.ok(spoolHiddenDirRefusal({ rel: GCLOUD_DIR_REL, kind: "dir", cause: "missing", nowMs: t0 + HIDDEN_DIR_ALERT_COOLDOWN_MS + 60_000 }));
    assert.equal(readdirSync(alertsDirs().pending).length, 3);
    // A silenced preference does not spool either (it would bell anyway).
    store.setPrefs(JSON.stringify({ types_enabled: ["attention"] }));
    const off = notifyHiddenDirRefusal({ dbPath: store.dbPath, rel: GNUPG_DIR_REL, kind: "dir", cause: "missing", nowMs: t0 });
    assert.equal(off.reason, "disabled");
    assert.equal(off.spooled, false);
    assert.equal(readdirSync(alertsDirs().pending).length, 3);
  } finally {
    _setAlertsRootForTest(null);
    rmSync(alerts, { recursive: true, force: true });
    rmSync(store.root, { recursive: true, force: true });
  }
});

test("a refused spawn rings the bell, naming the entry and the reset command, once per entry", async () => {
  // End to end through the bridge: a remembered gcloud folder disappears, the
  // next spawn is refused, and the operator's bell gets a row for it.
  const store = bellStore(dirname(CROW_DB));
  const gcloudDir = join(USER_HOME, GCLOUD_DIR_REL);
  const gnupgDir = join(USER_HOME, GNUPG_DIR_REL);
  rmSync(gcloudDir, { recursive: true, force: true });
  forgetHiddenDirs();
  mkdirSync(gcloudDir, { recursive: true });
  try {
    assert.equal(await spawnOutcome(), null, "the first sight starts and records");
    assert.deepEqual(store.rows(), [], "a good spawn rings nothing");
    rmSync(gcloudDir, { recursive: true });
    const e = await spawnOutcome();
    assert.ok(e, "the spawn is refused");
    const rows = store.rows();
    assert.equal(rows.length, 1, "the operator sees it in the bell: " + JSON.stringify(rows));
    assert.equal(rows[0].source, HIDDEN_DIR_ALERT_SOURCE);
    assert.equal(rows[0].priority, "high");
    assert.equal(rows[0].title, "A bot could not start: ~/" + GCLOUD_DIR_REL);
    assert.ok(rows[0].body.includes(HIDDEN_DIR_RESET_COMMAND), "with the exact reset command");
    assert.ok(!rows[0].body.includes(CROW), "and no absolute path");
    assert.equal(JSON.parse(rows[0].metadata).hidden_rel, GCLOUD_DIR_REL);
    assert.equal(JSON.parse(rows[0].metadata).cause, "missing");
    // Every turn of every bot refuses while the folder stays gone: one bell.
    assert.ok(await spawnOutcome(), "still refused");
    assert.equal(store.rows().length, 1, "deduped per entry per 24 h");
    // A DIFFERENT entry gets its own bell. (The dedupe is per folder, so a link
    // appearing where the same folder used to be stays inside that folder's
    // window — the operator already has its bell.)
    rmSync(gnupgDir, { recursive: true, force: true });
    symlinkSync(join(USER_HOME, "decoy-gnupg"), gnupgDir);
    assert.ok(await spawnOutcome(), "a symlinked folder is refused");
    assert.equal(store.rows().length, 2, "a second entry has its own window");
    assert.equal(JSON.parse(store.rows()[1].metadata).hidden_rel, GNUPG_DIR_REL);
    assert.equal(JSON.parse(store.rows()[1].metadata).cause, "link");
    assert.match(store.rows()[1].body, /Remove the link \(or, if you use that tool, replace it with a real folder\)/);
  } finally {
    rmSync(gcloudDir, { recursive: true, force: true });
    rmSync(gnupgDir, { force: true });
    rmSync(store.dbPath, { force: true });
    forgetHiddenDirs();
  }
});

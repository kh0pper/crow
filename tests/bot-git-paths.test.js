/**
 * Per-bot git access, task A1: the key dir path helpers, the shape check every
 * reader applies before trusting a key dir, and the shared-uid policy switch.
 *
 * Everything runs in scratch CROW_HOMEs (mkdtempSync) — the anchors, the dirs
 * and the keys here are test material, never a real ~/.crow, and no key
 * material is committed: the "keys" are empty files whose only job is to have
 * an inode, an owner and a mode.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmScratch } from "./helpers/safe-rm.js";

const HOME = mkdtempSync(join(tmpdir(), "bot-git-paths-"));
process.env.CROW_HOME = HOME;
const dirs = [HOME];
after(() => { for (const d of dirs) rmScratch(d); });

const P = await import("../servers/shared/bot-git/paths.js");

/** A fresh key dir tree: <root>/secrets/bot-git/<id>/id_ed25519, modes as asked. */
function fixture({ botGitMode = 0o700, dirMode = 0o700, keyMode = 0o600, key = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "bot-git-keydir-"));
  dirs.push(root);
  const secrets = join(root, "secrets");
  const botGit = join(secrets, "bot-git");
  const dir = join(botGit, "b1");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(secrets, 0o700);
  chmodSync(botGit, botGitMode);
  chmodSync(dir, dirMode);
  const keyPath = join(dir, "id_ed25519");
  if (key) {
    writeFileSync(keyPath, "", { mode: keyMode });
    chmodSync(keyPath, keyMode);
  }
  return { root, secrets, botGit, dir, keyPath };
}

test("gitAllowedForInstance: the R13 policy switch, shipped as the operator's ruling", () => {
  const table = { accepted: [true, true, true], "single-bot": [false, true, false] };
  try {
    for (const [policy, want] of Object.entries(table)) {
      P._setGitSharedUidPolicyForTest(policy);
      const got = [0, 1, 2].map((n) => P.gitAllowedForInstance({ enabledPiBotCount: n }));
      assert.deepEqual(got, want, policy + " with 0/1/2 enabled bots");
    }
  } finally {
    P._setGitSharedUidPolicyForTest(null);
  }
  // PR C ships the ACCEPTED value: the operator ruled that the shared uid risk
  // is acceptable for v1, and the Bot Builder card states it plainly. Under
  // that policy the enabled-bot count is not consulted at all.
  assert.equal(P.GIT_SHARED_UID_POLICY, "accepted");
  assert.deepEqual(P.GIT_UID_POLICIES, ["accepted", "single-bot"]);
  assert.equal(P.gitAllowedForInstance({ enabledPiBotCount: 1 }), true);
  assert.equal(P.gitAllowedForInstance({ enabledPiBotCount: 0 }), true, "accepted: the count does not gate it");
  assert.equal(P.gitAllowedForInstance({ enabledPiBotCount: 2 }), true, "accepted: two bots are allowed");
  assert.equal(P.gitAllowedForInstance(), true, "accepted: no count at all is still allowed");
  // The fail-closed value stays reachable (and stays fail-closed) for the switch.
  try {
    P._setGitSharedUidPolicyForTest("single-bot");
    assert.equal(P.gitAllowedForInstance({ enabledPiBotCount: "1" }), false, "a string count is not a count");
    assert.equal(P.gitAllowedForInstance(), false, "no count at all fails closed");
  } finally {
    P._setGitSharedUidPolicyForTest(null);
  }
});

test("isValidGitBotId: the engine's charset, no dot names, no separators", () => {
  for (const id of ["a", "bot.1", "bot_1-x", "A1", "b".repeat(64)]) {
    assert.equal(P.isValidGitBotId(id), true, id);
  }
  for (const id of [".", "..", "-x", "a/b", "a\\b", "a b", "", "a\nb", ".hidden", "b".repeat(65), null, undefined, 7, {}]) {
    assert.equal(P.isValidGitBotId(id), false, String(id));
  }
});

test("isSafeKeyPath: what git can be told in a command string, nothing else", () => {
  for (const p of [
    "/home/u/.crow/secrets/bot-git/b1/id_ed25519",
    "/srv/crow-2/secrets/bot-git/a.b/known_hosts",
    "/opt/crow+2/secrets/bot-git/b_1/gitconfig",
  ]) {
    assert.equal(P.isSafeKeyPath(p), true, p);
  }
  for (const p of [
    "", "relative/path", "./x", "/a b/id", '/a/"q"/id', "/a/$HOME/id", "/a/id\n", "/a/../b", "/a/b/..",
    "/a/`x`/id", "/a/id'", "/a/id;x", "/a/id$x", "/a/~x/id", null, 5,
  ]) {
    assert.equal(P.isSafeKeyPath(p), false, JSON.stringify(p));
  }
});

test("botGitDirReal and botGitAnchored stay inside the anchored secrets dir", () => {
  const real = P.botGitDirReal("bot.1");
  assert.equal(real, join(realpathSync(join(HOME, "secrets")), "bot-git", "bot.1"));
  assert.equal(P.botGitDirReal(".."), null);
  assert.equal(P.botGitDirReal("a/b"), null);

  const anchored = P.botGitAnchored("bot.1", "id_ed25519");
  assert.match(anchored, /^\/proc\/self\/fd\/\d+\/bot-git\/bot\.1\/id_ed25519$/);
  assert.equal(P.botGitAnchored("..", "id_ed25519"), null);
  assert.equal(P.botGitAnchored("bot.1", "../other"), null);
  assert.equal(P.botGitAnchored("bot.1", "a/b"), null);
  assert.equal(P.botGitAnchored("bot.1", ".."), null);
});

test("childVisiblePath: the real path a CHILD process may open, or null", () => {
  // A /proc/self/fd/<fd>/… path means nothing outside this process (an fd
  // number is per process), so anything handed to ssh/ssh-keygen/git must be the
  // real path of the same inode.
  const dir = join(HOME, "secrets", "bot-git", "childpath");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const anchoredDir = P.botGitAnchored("childpath");
  assert.match(anchoredDir, /^\/proc\/self\/fd\/\d+\/bot-git\/childpath$/);

  const real = P.childVisiblePath(anchoredDir, { directory: true });
  assert.equal(real, join(realpathSync(join(HOME, "secrets")), "bot-git", "childpath"));
  assert.ok(!real.includes("/proc/self/fd"), "a child can open it: " + real);
  assert.equal(statSync(real).ino, lstatSync(anchoredDir).ino, "the same inode on both sides");

  // A file is not a directory when one is required; a missing name has no real path.
  writeFileSync(join(dir, "id_ed25519"), "", { mode: 0o600 });
  assert.equal(P.childVisiblePath(P.botGitAnchored("childpath", "id_ed25519"), { directory: true }), null);
  assert.equal(P.childVisiblePath(P.botGitAnchored("childpath", "missing")), null);

  // A symlink is refused even when it resolves to the right dir.
  const link = join(HOME, "secrets", "bot-git", "linkbot");
  symlinkSync(dir, link);
  assert.equal(P.childVisiblePath(P.botGitAnchored("linkbot"), { directory: true }), null);

  assert.equal(P.childVisiblePath(null), null);
  assert.equal(P.childVisiblePath(""), null);
  assert.equal(P.childVisiblePath("/nonexistent/childpath"), null);
});

test("checkKeyDir accepts a 0700 dir holding one 0600 key", () => {
  const f = fixture();
  assert.deepEqual(P.checkKeyDir(f.dir, { uid: process.getuid() }), { ok: true });
});

test("checkKeyDir refuses a key dir that is not under bot-git/, or misnamed", () => {
  const f = fixture();
  assert.equal(P.checkKeyDir(join(f.secrets, "b1"), { uid: process.getuid() }).ok, false);
  const odd = join(f.botGit, "-x");
  mkdirSync(odd, { mode: 0o700 });
  writeFileSync(join(odd, "id_ed25519"), "", { mode: 0o600 });
  chmodSync(join(odd, "id_ed25519"), 0o600);
  assert.equal(P.checkKeyDir(odd, { uid: process.getuid() }).ok, false, "a dash name is not a bot id");
  assert.equal(P.checkKeyDir(f.dir + "/.", { uid: process.getuid() }).ok, false, "not normalised");
  assert.equal(P.checkKeyDir("relative/bot-git/b1", { uid: process.getuid() }).ok, false, "not absolute");
});

test("checkKeyDir refuses when bot-git/ itself is a symlink", () => {
  const f = fixture({ key: false });
  const elsewhere = join(f.root, "elsewhere-bot-git", "b1");
  mkdirSync(elsewhere, { recursive: true, mode: 0o700 });
  writeFileSync(join(elsewhere, "id_ed25519"), "", { mode: 0o600 });
  chmodSync(join(elsewhere, "id_ed25519"), 0o600);
  rmSync(f.dir, { recursive: true, force: true });
  rmSync(f.botGit, { recursive: true, force: true });
  symlinkSync(join(f.root, "elsewhere-bot-git"), f.botGit);
  const r = P.checkKeyDir(f.dir, { uid: process.getuid() });
  assert.equal(r.ok, false);
  assert.match(r.reason, /symlink/);
});

test("checkKeyDir refuses a symlinked secrets dir or key dir", () => {
  const f = fixture({ key: false });
  // secrets/ becomes a link to a real tree beside it
  const realSecrets = join(f.root, "real-secrets");
  mkdirSync(join(realSecrets, "bot-git", "b1"), { recursive: true, mode: 0o700 });
  writeFileSync(join(realSecrets, "bot-git", "b1", "id_ed25519"), "", { mode: 0o600 });
  chmodSync(join(realSecrets, "bot-git", "b1", "id_ed25519"), 0o600);
  rmSync(f.secrets, { recursive: true, force: true });
  symlinkSync(realSecrets, f.secrets);
  const viaSecrets = P.checkKeyDir(join(f.secrets, "bot-git", "b1"), { uid: process.getuid() });
  assert.equal(viaSecrets.ok, false);
  assert.match(viaSecrets.reason, /symlink/);

  // the key dir itself is a link to a valid-looking dir
  const g = fixture({ key: false });
  rmSync(g.dir, { recursive: true, force: true });
  symlinkSync(join(realSecrets, "bot-git", "b1"), g.dir);
  const viaDir = P.checkKeyDir(g.dir, { uid: process.getuid() });
  assert.equal(viaDir.ok, false);
  assert.match(viaDir.reason, /symlink/);
});

test("checkKeyDir refuses group/other access on bot-git/ or the key dir", () => {
  const looseBotGit = fixture({ botGitMode: 0o755 });
  const r1 = P.checkKeyDir(looseBotGit.dir, { uid: process.getuid() });
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /0755/);

  const looseDir = fixture({ dirMode: 0o750 });
  const r2 = P.checkKeyDir(looseDir.dir, { uid: process.getuid() });
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /0750/);
});

test("checkKeyDir refuses a symlinked, hard-linked, loose, missing or foreign key", () => {
  const linked = fixture({ key: false });
  writeFileSync(join(linked.root, "real-key"), "", { mode: 0o600 });
  chmodSync(join(linked.root, "real-key"), 0o600);
  symlinkSync(join(linked.root, "real-key"), linked.keyPath);
  const viaLink = P.checkKeyDir(linked.dir, { uid: process.getuid() });
  assert.equal(viaLink.ok, false);
  assert.match(viaLink.reason, /symlink/);

  const hard = fixture();
  linkSync(hard.keyPath, join(hard.dir, "id_ed25519.copy"));
  const viaHardLink = P.checkKeyDir(hard.dir, { uid: process.getuid() });
  assert.equal(viaHardLink.ok, false);
  assert.match(viaHardLink.reason, /hard-linked/);

  const loose = fixture({ keyMode: 0o640 });
  const viaMode = P.checkKeyDir(loose.dir, { uid: process.getuid() });
  assert.equal(viaMode.ok, false);
  assert.match(viaMode.reason, /0640/);

  const missing = fixture({ key: false });
  const viaMissing = P.checkKeyDir(missing.dir, { uid: process.getuid() });
  assert.equal(viaMissing.ok, false);
  assert.match(viaMissing.reason, /missing/);

  const foreign = fixture();
  const otherUid = process.getuid() === 0 ? 1 : process.getuid() + 1;
  const viaOwner = P.checkKeyDir(foreign.dir, { uid: otherUid });
  assert.equal(viaOwner.ok, false);
  assert.match(viaOwner.reason, /another user/);

  // a re-written key of the right shape is accepted again (the check is of the
  // inode, not of a remembered one)
  const swapped = fixture();
  unlinkSync(swapped.keyPath);
  writeFileSync(swapped.keyPath, "", { mode: 0o600 });
  chmodSync(swapped.keyPath, 0o600);
  assert.deepEqual(P.checkKeyDir(swapped.dir, { uid: process.getuid() }), { ok: true });
});
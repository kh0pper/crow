/**
 * The secrets dir's ancestor invariant (bot containment Phase 1, Task 9).
 *
 * Every tree is a scratch dir under the OS temp dir; the real home, the real
 * ~/.crow and the real /etc/group are never read (the modes and owners that
 * need another uid come from the stat seam, and the group member lists from
 * the groupMembers seam). The suite's umask may create 0775 dirs, so every case
 * under test normalises the paths it does not care about to 0755.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, chmodSync, lstatSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SA = await import("../servers/shared/secrets-ancestors.js");

/** A fresh T/a/b/secrets tree; the mkdtemp root is 0700. */
function tree(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "crow-secrets-ancestors-")));
  const secrets = join(root, "T", "a", "b", "secrets");
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, top: join(root, "T"), a: join(root, "T", "a"), b: join(root, "T", "a", "b"), secrets };
}

const PLAIN_MODE = 0o040755;
/** The stat seam's answer for every path a case does not care about. */
const plain = (p) => ({ ...lstatSync(p), mode: PLAIN_MODE });
const withAt = (path, over) => (p) => (p === path ? { ...lstatSync(p), ...over } : plain(p));

test("clean tree is ok: 0755/0750 ancestors owned by this uid, no findings", (t) => {
  const T = tree(t);
  chmodSync(T.top, 0o750);
  // The real modes are read; the group is stubbed so a box whose own group has
  // other members cannot change the answer.
  const r = SA.checkSecretsAncestors({ secretsDir: T.secrets, groupMembers: () => ["owner"], ownerName: "owner" });
  assert.deepEqual(r.findings, []);
  assert.equal(r.ok, true);
});

test("the ancestors walked are the secrets dir's, not the dir itself: a 0700 secrets dir inside a 0777 parent fires on the parent", (t) => {
  const T = tree(t);
  assert.equal(lstatSync(T.secrets).mode & 0o777, 0o700, "the dir itself is untouched by the check");
  const r = SA.checkSecretsAncestors({ secretsDir: T.secrets, stat: withAt(T.a, { mode: 0o040777 }) });
  assert.deepEqual(r.findings, [{ path: T.a, why: "world-writable without sticky" }]);
  assert.equal(r.ok, false);
});

test("a symlinked secrets dir is judged where it really is", (t) => {
  const T = tree(t);
  const alias = join(tmpdir(), "crow-secrets-alias-" + process.pid + "-" + Math.random().toString(16).slice(2));
  symlinkSync(T.secrets, alias);
  t.after(() => rmSync(alias, { force: true }));
  const r = SA.checkSecretsAncestors({ secretsDir: alias, stat: withAt(T.top, { mode: 0o040777 }) });
  assert.deepEqual(r.findings, [{ path: T.top, why: "world-writable without sticky" }], "the real ancestor, not the link's parent");
});

test("world-writable ancestor fires; the sticky bit excuses it", (t) => {
  const T = tree(t);
  assert.deepEqual(SA.checkSecretsAncestors({ secretsDir: T.secrets, stat: withAt(T.a, { mode: 0o040777 }) }).findings,
    [{ path: T.a, why: "world-writable without sticky" }]);
  assert.deepEqual(SA.checkSecretsAncestors({ secretsDir: T.secrets, stat: withAt(T.a, { mode: 0o041777 }) }).findings, [],
    "sticky: nobody can rename what is not theirs");
});

test("bot-uid owner fires (the bot owns the ancestor and can chmod it)", (t) => {
  const T = tree(t);
  const botUid = 54321;
  const stat = withAt(T.a, { uid: botUid });
  assert.deepEqual(SA.checkSecretsAncestors({ secretsDir: T.secrets, botUid, stat }).findings,
    [{ path: T.a, why: "writable by the bot uid" }], "the more specific bot-uid rule wins");
  // Without a configured bot uid nobody is "the bot", but a foreign non-root
  // owner is still a finding of its own (F2): the owner can chmod it.
  assert.deepEqual(SA.checkSecretsAncestors({ secretsDir: T.secrets, stat }).findings,
    [{ path: T.a, why: "owned by another user" }], "no CROW_BOT_UID: the owner is just another user");
});

test("F2: a 0755 ancestor owned by another non-root user is a finding; root-owned and our own are not", (t) => {
  const T = tree(t);
  const me = typeof process.getuid === "function" ? process.getuid() : 1000;
  const other = me === 4321 ? 4322 : 4321;
  const mode0755 = 0o040755;
  assert.deepEqual(SA.checkSecretsAncestors({ secretsDir: T.secrets, ownerUid: me, stat: withAt(T.a, { uid: other, mode: mode0755 }) }).findings,
    [{ path: T.a, why: "owned by another user" }]);
  assert.deepEqual(SA.checkSecretsAncestors({ secretsDir: T.secrets, ownerUid: me, stat: withAt(T.a, { uid: 0, mode: mode0755 }) }).findings,
    [], "root owns / and /home on every normal host: not a finding");
  assert.deepEqual(SA.checkSecretsAncestors({ secretsDir: T.secrets, ownerUid: me, stat: withAt(T.a, { uid: me, mode: mode0755 }) }).findings,
    [], "our own ancestor");
});

test("bot group fires: a 0775 ancestor whose group is one the bot writes with", (t) => {
  const T = tree(t);
  const stat = withAt(T.a, { gid: 4321, mode: 0o040775 });
  const r = SA.checkSecretsAncestors({ secretsDir: T.secrets, botUid: 54321, botGids: [4321, 4322], stat });
  assert.deepEqual(r.findings, [{ path: T.a, why: "group-writable by the bot's group" }]);
});

test("shared group fires: another member of this user's own group can write the ancestor", (t) => {
  const T = tree(t);
  const stat = withAt(T.a, { gid: 4322, mode: 0o040775 });
  const many = () => ["owner", "someone"];
  const onlyOwner = () => ["owner"];
  assert.deepEqual(SA.checkSecretsAncestors({ secretsDir: T.secrets, stat, groupMembers: many, ownerName: "owner" }).findings,
    [{ path: T.a, why: "group-writable by a group with other members" }]);
  // Today's ~/.crow case: 0775, but the group has no other member.
  assert.deepEqual(SA.checkSecretsAncestors({ secretsDir: T.secrets, stat, groupMembers: onlyOwner, ownerName: "owner" }).findings, []);
});

test("a group-writable ancestor with the sticky bit is not a finding", (t) => {
  const T = tree(t);
  const stat = withAt(T.a, { gid: 4323, mode: 0o041775 });
  assert.deepEqual(SA.checkSecretsAncestors({ secretsDir: T.secrets, stat, groupMembers: () => ["owner", "someone"], ownerName: "owner" }).findings, []);
});

test("unstatable ancestor fires: cannot stat", (t) => {
  const T = tree(t);
  const stat = (p) => { if (p === T.a) throw new Error("EACCES"); return plain(p); };
  assert.deepEqual(SA.checkSecretsAncestors({ secretsDir: T.secrets, stat }).findings, [{ path: T.a, why: "cannot stat" }]);
});

test("a path that does not exist under the secrets dir is `cannot stat` (the caller creates the dir first, F4)", (t) => {
  const T = tree(t);
  const absent = join(T.b, "not-made-yet", "secrets");
  const r = SA.checkSecretsAncestors({ secretsDir: absent });
  assert.deepEqual(r.findings, [{ path: join(T.b, "not-made-yet"), why: "cannot stat" }],
    "anchoring makes the dir first, so an ENOENT here is a vanished path, not first boot");
  assert.equal(r.ok, false);
  // The real first boot (a fresh CROW_HOME) is covered by
  // tests/secret-values.test.js: anchorSecretsDir creates the dir, then judges.
  const made = join(T.b, "made", "secrets");
  mkdirSync(made, { recursive: true, mode: 0o700 });
  assert.deepEqual(SA.checkSecretsAncestors({ secretsDir: made }).findings, []);
});

test("secretsAncestorsReport: refused only when CROW_BOT_UID is set and something is open", (t) => {
  const T = tree(t);
  const botOwned = (p) => (p === T.a ? { ...lstatSync(p), uid: 54321 } : plain(p));
  const worldWritable = (p) => (p === T.a ? { ...lstatSync(p), mode: 0o040777 } : plain(p));
  const guarded = SA.secretsAncestorsReport({ env: { CROW_BOT_UID: "54321" }, secretsDir: T.secrets, stat: botOwned });
  assert.equal(guarded.refused, true);
  assert.equal(guarded.botUid, 54321);
  const warned = SA.secretsAncestorsReport({ env: {}, secretsDir: T.secrets, stat: worldWritable });
  assert.equal(warned.refused, false, "Phase 1: a warning, not a refusal");
  assert.equal(warned.ok, false);
  const clean = SA.secretsAncestorsReport({ env: { CROW_BOT_UID: "54321" }, secretsDir: T.secrets, stat: plain });
  assert.deepEqual({ ok: clean.ok, refused: clean.refused }, { ok: true, refused: false });
  assert.deepEqual(SA.botGidsFromEnv({ CROW_BOT_GIDS: "1, 2, x" }), [1, 2]);
  assert.deepEqual(SA.botGidsFromEnv({}), []);
});

test("groupMembersFromFiles reads NAMES only, and an unknown gid has none", () => {
  const members = SA.groupMembersFromFiles(typeof process.getgid === "function" ? process.getgid() : 0);
  assert.ok(Array.isArray(members));
  for (const m of members) assert.equal(typeof m, "string");
  assert.deepEqual(SA.groupMembersFromFiles(4294967294), []);
});
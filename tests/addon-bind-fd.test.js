/**
 * The checked open of a bind source (scripts/addon-sandbox/bind-fd.mjs).
 *
 * A bind source that lives in a tree add-on code can write is opened one
 * component at a time from `/` and bound by fd, never by name: any symlink in
 * the path refuses, every component must be owned by root or the gateway uid,
 * and the real path read back through /proc/self/fd is checked again against
 * the caller's refuse list. Every failure is a ContainRefused with no fd left
 * open.
 *
 * Real scratch dirs under mkdtemp (realpath'd), so nothing here depends on the
 * host's own layout.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { closeSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContainRefused } from "../scripts/pi-bots/pi_contain.mjs";
import { openCheckedBindSource } from "../scripts/addon-sandbox/bind-fd.mjs";

const T = realpathSync(mkdtempSync(join(tmpdir(), "addon-bind-fd-")));
after(() => rmSync(T, { recursive: true, force: true }));

const UID = process.getuid();
const mk = (...p) => { const d = join(...p); mkdirSync(d, { recursive: true }); return d; };
/** How many fds this process holds right now (so a refusal can be shown to leak none). */
const fdCount = () => readdirSync("/proc/self/fd").length;
/** The target of an open fd, as the kernel reports it. */
const targetOf = (fd) => readlinkSync("/proc/self/fd/" + fd);

test("a plain owned dir opens, and the fd's target is its real path", () => {
  const dir = mk(T, "plain", "data");
  const before = fdCount();
  const opened = openCheckedBindSource(dir, { uid: UID });
  try {
    assert.equal(opened.isDir, true);
    assert.equal(opened.realPath, dir);
    assert.equal(targetOf(opened.fd), dir, "the fd's own target is the checked path");
    assert.equal(fdCount(), before + 1, "only the leaf fd is handed back; intermediates are closed");
  } finally {
    closeSync(opened.fd);
  }
  assert.equal(fdCount(), before, "closing the returned fd leaves nothing behind");
});

test("a plain owned file opens with expect: 'file' and reports isDir false", () => {
  const dir = mk(T, "plain", "files");
  const file = join(dir, "token.json");
  writeFileSync(file, "{}");
  const opened = openCheckedBindSource(file, { uid: UID, expect: "file" });
  try {
    assert.equal(opened.isDir, false);
    assert.equal(opened.realPath, file);
  } finally { closeSync(opened.fd); }
});

test("a symlinked component refuses: a symlinked parent and a symlinked leaf", () => {
  const real = mk(T, "links", "real", "data");
  writeFileSync(join(real, "token.json"), "{}");
  const parentLink = join(T, "links", "parent-link");
  symlinkSync(join(T, "links", "real"), parentLink);
  const leafLink = join(T, "links", "leaf-link.json");
  symlinkSync(join(real, "token.json"), leafLink);

  assert.throws(() => openCheckedBindSource(join(parentLink, "data"), { uid: UID }),
    (e) => e instanceof ContainRefused && /a symlink in the path/.test(e.message), "a symlinked parent");
  assert.throws(() => openCheckedBindSource(leafLink, { uid: UID }),
    (e) => e instanceof ContainRefused && /a symlink in the path/.test(e.message), "a symlinked leaf");
  assert.throws(() => openCheckedBindSource(join(T, "links", "real", "data", "..", "..", "parent-link"), { uid: UID }),
    (e) => e instanceof ContainRefused && /a symlink in the path/.test(e.message), "a symlink after '..' is normalised in");
});

test("a component owned by another user refuses", (t) => {
  if (UID === 0) { t.skip("this process is root, and root owns every scratch file"); return; }
  const dir = mk(T, "owner", "data");
  assert.throws(() => openCheckedBindSource(dir, { uid: UID + 100000 }),
    (e) => e instanceof ContainRefused && /owned by another user/.test(e.message));
  // Inside the home the rule is stricter (uid only, never root), so a home path
  // owned by another uid refuses even where root would be accepted.
  assert.throws(() => openCheckedBindSource(dir, { uid: UID + 100000, home: T }),
    (e) => e instanceof ContainRefused && /owned by another user/.test(e.message));
});

test("a source the refuse list rejects refuses with the list's reason", () => {
  const home = mk(T, "home", "alex");
  const secrets = mk(home, ".crow", "secrets");
  const refuse = (p) => (p === join(home, ".crow", "secrets") ? "a Crow secret is never bound (" + p + ")" : null);
  assert.throws(() => openCheckedBindSource(secrets, { uid: UID, home, refuse }),
    (e) => e instanceof ContainRefused && /a Crow secret is never bound/.test(e.message));
  // The same dir is fine once the list allows it: the refusal came from the list.
  const opened = openCheckedBindSource(secrets, { uid: UID, home, refuse: () => null });
  try { assert.equal(opened.realPath, secrets); } finally { closeSync(opened.fd); }
});

test("the refuse list sees the real path, not the name that was asked for", () => {
  const dir = mk(T, "realpath-check", "data");
  const seen = [];
  const opened = openCheckedBindSource(dir + "/", { uid: UID, refuse: (p) => { seen.push(p); return null; } });
  try {
    assert.deepEqual(seen, [dir], "the callback gets the normalised, read-back path");
    assert.equal(opened.realPath, dir);
  } finally { closeSync(opened.fd); }
});

test("every failure is a ContainRefused and leaves no fd open", () => {
  const dir = mk(T, "shapes", "dir");
  const file = join(mk(T, "shapes", "files"), "f.txt");
  writeFileSync(file, "x");
  const before = fdCount();
  const cases = [
    [join(T, "shapes", "missing"), { expect: "dir" }, "a missing leaf"],
    [join(T, "shapes", "missing", "deeper"), {}, "a missing parent"],
    [dir, { expect: "file" }, "a dir where a file was expected"],
    [file, { expect: "dir" }, "a file where a dir was expected"],
    ["", {}, "no path at all"],
    [dir, { expect: "symlink" }, "an unknown expectation"],
  ];
  for (const [p, opts, why] of cases) {
    assert.throws(() => openCheckedBindSource(p, { uid: UID, ...opts }), ContainRefused, why);
  }
  assert.equal(fdCount(), before, "no partial result: every fd the failed opens touched is closed");
});

test("a source that disappears between the open and the read-back refuses", () => {
  // Simulated through the refuse list: the caller's last check runs on the path
  // read back from the kernel and can still keep the bind off.
  const dir = mk(T, "changed", "data");
  assert.throws(() => openCheckedBindSource(dir, { uid: UID, refuse: () => "the path changed while it was opened" }),
    (e) => e instanceof ContainRefused && /the path changed/.test(e.message));
});
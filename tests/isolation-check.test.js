// Queue item 19 (steps 0-1): a read-only, booleans-only report of what this
// process can open that belongs to another instance or to the operator. The
// probes open and immediately close; they never read contents.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canOpen, probeForeignProc, processFacts, secretEnvNames, formatIsolationLine } from "../servers/shared/isolation-check.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "crow-iso-")));
const kids = [];
after(() => {
  for (const k of kids) { try { k.kill("SIGKILL"); } catch {} }
  try { chmodSync(join(scratch, "locked"), 0o700); } catch {}
  rmSync(scratch, { recursive: true, force: true });
});
const isRoot = process.getuid && process.getuid() === 0;

test("canOpen: true for an openable dir or file, false for a locked or missing one", { skip: isRoot && "root opens everything" }, () => {
  const open = join(scratch, "open"); mkdirSync(open);
  const file = join(scratch, "f.txt"); writeFileSync(file, "x");
  const locked = join(scratch, "locked"); mkdirSync(locked); chmodSync(locked, 0o000);
  assert.equal(canOpen(open), true);
  assert.equal(canOpen(file), true);
  assert.equal(canOpen(locked), false);
  assert.equal(canOpen(join(scratch, "missing")), false);
});

test("probeForeignProc: an unsandboxed same-uid process can open a sibling's /proc root and environ (the gap PrivateUsers closes)", async () => {
  const kid = spawn("sleep", ["30"], { stdio: "ignore" });
  kids.push(kid);
  await new Promise((r) => setTimeout(r, 100));
  const r = probeForeignProc([kid.pid]);
  assert.equal(r.length, 1);
  assert.equal(r[0].pid, kid.pid);
  assert.equal(typeof r[0].root, "boolean");
  assert.equal(typeof r[0].environ, "boolean");
  if (!isRoot && processFacts().userNamespace === "init") {
    assert.equal(r[0].root, true);
    assert.equal(r[0].environ, true);
  }
  assert.deepEqual(probeForeignProc([2 ** 22 + 7]), [], "a pid that does not exist is dropped");
});

test("processFacts: booleans and names only", () => {
  const f = processFacts();
  assert.equal(typeof f.noNewPrivs, "boolean");
  assert.ok(["init", "private"].includes(f.userNamespace));
  assert.ok(Array.isArray(f.rootEquivalentGroups));
});

test("secretEnvNames: extracts secret-like NAMES from systemctl show Environment= output", () => {
  const out = 'PATH=/usr/bin NODE_ENV=production KB_FEEDBACK_REMOTE_TOKEN=abc "MY_PASSWORD=x y" CROW_PEER_TOKENS_PATH=/p PORT=1';
  assert.deepEqual(secretEnvNames(out), ["KB_FEEDBACK_REMOTE_TOKEN", "MY_PASSWORD"]);
  assert.deepEqual(secretEnvNames(""), []);
});

test("formatIsolationLine never includes a path's contents, only counts and booleans", () => {
  const line = formatIsolationLine({
    sensitiveOpenable: ["/x/.ssh"], foreignProc: [{ pid: 5, root: false, environ: false }],
    facts: { noNewPrivs: true, userNamespace: "private", rootEquivalentGroups: ["docker"] },
  });
  assert.match(line, /^\[isolation\] /);
  assert.match(line, /sensitive paths openable: 1 \(\/x\/\.ssh\)/);
  assert.match(line, /foreign \/proc root openable: no/);
  assert.match(line, /user namespace: private/);
  assert.match(line, /root-equivalent groups: docker/);
});

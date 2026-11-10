// The add-on's network entry (scripts/pi-bots/pi_netns_entry.mjs) for a walled
// run that has no relay socket: a `none` network profile has no socket and no
// ports, so the entry listens on nothing and hands the command exactly the fds
// the spawner named. A run that names ports (or a proxy port) without a socket
// is a usage error, because there is nothing for those listeners to reach.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../scripts/pi-bots/pi_netns_entry.mjs", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "addon-netns-entry-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;

/** What the child prints: every fd number it holds, and where each one points. */
const FD_REPORT = "const fs=require('fs');const out={};"
  + "for (const fd of fs.readdirSync('/proc/self/fd')) { try { out[fd]=fs.readlinkSync('/proc/self/fd/' + fd) } catch (e) { out[fd]=e.code } }"
  + "process.stdout.write(JSON.stringify(out))";

/**
 * Run the entry the way the walled spawn does: stdio plus the two extra fds a
 * plan and the info pipe arrive on (3 and 4 here), each its own file so the
 * caller knows exactly what an inherited fd would point at.
 */
function runEntry(argv) {
  const mkExtra = (label) => {
    const at = join(scratch, label + "-" + (++n) + ".txt");
    writeFileSync(at, "");
    return { at, fd: openSync(at, "r+") };
  };
  const a = mkExtra("plan");
  const b = mkExtra("info");
  // The parent's own copies, read before the child exists: an inherited fd in
  // the child would read back to the same two paths.
  const extraTargets = [readlinkSync(`/proc/self/fd/${a.fd}`), readlinkSync(`/proc/self/fd/${b.fd}`)];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY, ...argv], { stdio: ["pipe", "pipe", "pipe", a.fd, b.fd] });
    closeSync(a.fd); // the child holds its own copies from here
    closeSync(b.fd);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code, sig) => resolve({ code, sig, out, err, extraTargets }));
  });
}

test("a run with no relay socket hands the command only the fds it was given", async () => {
  const r = await runEntry(["--fds", "0,1,2", "--", process.execPath, "-e", FD_REPORT]);
  assert.equal(r.code, 0, r.err);
  const held = JSON.parse(r.out);
  for (const fd of ["0", "1", "2"]) assert.ok(fd in held, "fd " + fd + " is the child's: " + r.out);
  const inherited = Object.entries(held).filter(([, target]) => r.extraTargets.includes(target));
  assert.deepEqual(inherited, [], "neither extra fd is inherited: " + r.out);
});

test("the command's exit status is the entry's exit status", async () => {
  const r = await runEntry(["--fds", "0,1,2", "--", "/bin/sh", "-c", "exit 7"]);
  assert.equal(r.code, 7, r.err);
});

test("ports or a proxy port without a relay socket is a usage error", async () => {
  for (const argv of [["--ports", "8000"], ["--proxy-port", "39080"]]) {
    const r = await runEntry([...argv, "--", "/bin/true"]);
    assert.equal(r.code, 2, JSON.stringify(argv) + " exits 2: " + r.err);
  }
});
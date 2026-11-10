// The add-on's network entry (scripts/pi-bots/pi_netns_entry.mjs) for a walled
// run that has no relay socket: a `none` network profile has no socket and no
// ports, so the entry listens on nothing and hands the command exactly the fds
// the spawner named. A run that names ports (or a proxy port) without a socket
// is a usage error, because there is nothing for those listeners to reach.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../scripts/pi-bots/pi_netns_entry.mjs", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "addon-netns-entry-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;

/**
 * Run the entry the way the walled spawn does: stdio plus the two extra fds a
 * plan and the info pipe arrive on (3 and 4 here). Only the child's own output
 * is read back, so nothing here depends on the entry's fd numbers.
 */
function runEntry(argv) {
  const extra = join(scratch, "extra-" + (++n) + ".txt");
  writeFileSync(extra, "");
  return new Promise((resolve, reject) => {
    const fd = openSync(extra, "r+");
    const child = spawn(process.execPath, [ENTRY, ...argv], { stdio: ["pipe", "pipe", "pipe", fd, "pipe"] });
    closeSync(fd); // the child holds its own copy from here
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code, sig) => resolve({ code, sig, out, err }));
  });
}

test("a run with no relay socket hands the command only the fds it was given", async () => {
  const r = await runEntry(["--fds", "0,1,2", "--", "/bin/sh", "-c", "ls /proc/self/fd"]);
  assert.equal(r.code, 0, r.err);
  const fds = r.out.split(/\s+/).filter(Boolean).map(Number).sort((a, b) => a - b);
  for (const fd of [0, 1, 2]) assert.ok(fds.includes(fd), "fd " + fd + " is the child's: " + r.out);
  const extra = fds.filter((fd) => fd >= 3);
  assert.equal(extra.length, 1, "only the directory fd `ls` opens itself, so neither 3 nor 4 is inherited: " + r.out);
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
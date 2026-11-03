// Containment PR 6: the network entry process (pi_netns_entry.mjs) and the fds
// it hands pi. node opens its epoll, io_uring and internal pipes in the lowest
// free slots before main() runs, so "every open fd 0..9" handed pi node's own;
// the spawner now names the fds it really wired (`--fds`), and the entry passes
// only those.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { openSync, closeSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { wrapPiSpawn } from "../scripts/pi-bots/pi_sandbox.mjs";

const ENTRY = fileURLToPath(new URL("../scripts/pi-bots/pi_netns_entry.mjs", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "crow-netns-entry-"));
const MARKER = join(scratch, "marker-fd7.txt");
writeFileSync(MARKER, "MARK7");
after(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
/** A minimal contain plan input: no system binds and no engine, so the plan is
 *  small and the test stays argv-level (nothing is run under bubblewrap). */
function planInput(net = null) {
  const dir = join(scratch, "s" + (++n));
  mkdirSync(dir, { recursive: true });
  return { home: homedir(), sessionDir: dir, cwd: dir, systemDirs: [], net };
}

const PROBE = 'const fs=require("node:fs");const r=(n)=>{try{return fs.readlinkSync("/proc/self/fd/"+n)}catch(e){return "none"}};'
  + "process.stdout.write(r(7)+\"|\"+r(9));";

/**
 * Run the entry with the marker FILE on fd 7 (an extra inherited fd, exactly the
 * shape node's own epoll/pipes have) and read what the CHILD sees on fd 7 and
 * fd 9. Listing /proc/self/fd cannot answer this: a node child opens a dozen fds
 * of its own in the low slots, so the marker's identity is the only proof — and
 * readlink(2) is the only way to identify an fd without risking a blocking
 * read(2) on one of node's own eventfds.
 */
function childFds(fdsArg) {
  return new Promise((resolve, reject) => {
    const fd = openSync(MARKER, "r");
    const c = spawn(process.execPath, [ENTRY, "--sock", join(scratch, "unused.sock"), "--fds", fdsArg, "--",
      process.execPath, "-e", PROBE],
    { stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", fd], timeout: 20000 });
    closeSync(fd); // the child holds its own copy from here
    let out = "", err = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { err += d; });
    c.on("error", reject);
    c.on("exit", (code, sig) => resolve({ code, sig, out: out.trim(), err }));
  });
}

test("the entry hands the child only the fds the spawner named", async () => {
  const named = await childFds("0,1,2");
  assert.equal(named.code, 0, named.err);
  assert.doesNotMatch(named.out, /marker-fd7/, "an extra inherited fd (7) is NOT handed on: " + named.out);
  // Control: the marker really was on fd 7 in the entry, and naming it passes it.
  const control = await childFds("0,1,2,7");
  assert.equal(control.code, 0, control.err);
  assert.match(control.out, /^[^|]*marker-fd7\.txt\|/, "the same fd IS inherited when the spawner names it: " + control.out);
});

test("an fd the spawner named but did not open is 'ignore', never another fd", async () => {
  // fd 9 is named but was never opened for the entry; fd 7 IS open there. The
  // old code ("every open fd 0..9") would hand the child the marker at 7.
  const r = await childFds("0,1,2,9");
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /marker-fd7/, "neither slot gets the marker: " + r.out);
});

test("a named slot holding the entry's own event-loop fd is never handed on", async () => {
  // Name every slot 0..12: some of them are the entry node's own eventpoll /
  // io_uring / eventfd fds (anon_inode:), which must come out "ignore".
  const r = await childFds("0,1,2,3,4,5,6,8,9,10,11,12");
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /anon_inode/, "no event-loop fd of the entry reaches the child: " + r.out);
});

test("wrapPiSpawn puts the --fds list (stdio plus the caller's fds) into the entry argv", () => {
  const prev = process.env.CROW_PI_SANDBOX;
  process.env.CROW_PI_SANDBOX = "contain";
  try {
    const probe = { ok: true, bwrap: "/usr/bin/bwrap", pidns: true, reason: null };
    const launch = wrapPiSpawn("/n/node", ["/x/cli.mjs"], {
      mode: "contain", probe, botId: "netns-fds", infoFd: 3, seccompFd: 6,
      contain: planInput({ relayDir: join(scratch, "relay"), loopbackPorts: [3001] }),
      passFds: [4, 5, 6],
    });
    const a = launch.args;
    assert.ok(a.some((x) => x.endsWith("pi_netns_entry.mjs")), "the network entry runs pi: " + a.join(" "));
    const i = a.indexOf("--fds");
    assert.ok(i > 0, "the entry is told which fds to pass: " + a.join(" "));
    assert.equal(a[i + 1], "0,1,2,4,5", "stdio plus the caller's fds, never the info fd (3) or the seccomp fd (6)");
    assert.match(launch.tier, /^contain/);
  } finally {
    if (prev === undefined) delete process.env.CROW_PI_SANDBOX; else process.env.CROW_PI_SANDBOX = prev;
  }
});

test("without a relay (host network) no --fds and no entry are added", () => {
  const prev = process.env.CROW_PI_SANDBOX;
  process.env.CROW_PI_SANDBOX = "contain";
  try {
    const probe = { ok: true, bwrap: "/usr/bin/bwrap", pidns: true, reason: null };
    const launch = wrapPiSpawn("/n/node", ["/x/cli.mjs"], {
      mode: "contain", probe, botId: "netns-off", infoFd: 3, contain: planInput(null), passFds: [4],
    });
    assert.equal(launch.args.includes("--fds"), false);
    assert.equal(launch.args.some((x) => x.endsWith("pi_netns_entry.mjs")), false);
    assert.match(launch.tier, /-hostnet$/);
  } finally {
    if (prev === undefined) delete process.env.CROW_PI_SANDBOX; else process.env.CROW_PI_SANDBOX = prev;
  }
});
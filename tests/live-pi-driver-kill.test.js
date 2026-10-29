/**
 * Process-tree kill for the live pi driver. These tests spawn real processes; every one is
 * registered for cleanup so a failing test never leaves a stray sleeper behind.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { descendants, killTree, survivorsByMarker, bootSecNow, KILL_GRACE_MS } from "../scripts/lib/live-pi-driver.mjs";

const spawned = new Set();
const track = (pid) => { if (pid > 1) spawned.add(pid); return pid; };
test.after(() => { for (const pid of spawned) { try { process.kill(pid, "SIGKILL"); } catch {} } });

const alive = (pid) => {
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "")[0] !== "Z"; } catch { return false; }
};
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error("until: timed out");
};

// A node child that spawns a detached grandchild and prints its pid, then idles.
const PARENT_SRC = (extra = "") => `
const { spawn } = require("node:child_process");
${extra}
const g = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { detached: true, stdio: "ignore" });
console.log(g.pid);
setTimeout(()=>{},60000);`;

async function startTree(src, opts = {}) {
  const child = spawn(process.execPath, ["-e", src], { stdio: ["ignore", "pipe", "ignore"], ...opts });
  track(child.pid);
  const grand = await new Promise((res, rej) => {
    let buf = "";
    child.stdout.on("data", (d) => { buf += d; const m = buf.match(/^(\d+)\n/); if (m) res(Number(m[1])); });
    child.on("error", rej);
    child.on("exit", () => rej(new Error("child exited early")));
  });
  track(grand);
  return { child, grand };
}

test("KILL_GRACE_MS is 5000", () => assert.equal(KILL_GRACE_MS, 5000));

test("descendants parses comm with spaces and parens", () => {
  const files = {
    "/proc/10/stat": "10 (init) S 1 10 10 0 -1",
    "/proc/20/stat": "20 (pi (bot) x) S 10 20 20 0 -1 4194560",
    "/proc/30/stat": "30 (a) b) S 20 30 20 0 -1",
    "/proc/40/stat": "40 (other) S 1 40 40 0 -1",
  };
  const readProc = (p) => { if (p in files) return files[p]; const e = new Error("nope"); e.code = "ENOENT"; throw e; };
  const listPids = () => [10, 20, 30, 40];
  assert.deepEqual(descendants(10, { readProc, listPids }).sort((a, b) => a - b), [20, 30]);
  assert.deepEqual(descendants(40, { readProc, listPids }), []);
});

test("kills a detached grandchild in its own group", async () => {
  const { child, grand } = await startTree(PARENT_SRC());
  assert.ok(alive(grand));
  const { survivors } = await killTree(child.pid, { graceMs: 300 });
  assert.equal(survivors.length, 0);
  assert.equal(alive(grand), false);
  assert.equal(alive(child.pid), false);
});

test("a sibling outside the tree survives (R3)", async () => {
  const { child } = await startTree(PARENT_SRC());
  const sib = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)", "pi", "--mode", "rpc"], { detached: true, stdio: "ignore" });
  track(sib.pid);
  await until(() => existsSync(`/proc/${sib.pid}/stat`));
  await killTree(child.pid, { graceMs: 300 });
  assert.ok(alive(sib.pid), "sibling pi was killed");
  sib.kill("SIGKILL");
});

test("SIGTERM-ignoring process is SIGKILLed after grace", async () => {
  const { child, grand } = await startTree(PARENT_SRC(`process.on("SIGTERM", () => {});`));
  const t0 = Date.now();
  const { survivors } = await killTree(child.pid, { graceMs: 300 });
  assert.equal(survivors.length, 0);
  assert.equal(alive(child.pid), false);
  assert.equal(alive(grand), false);
  assert.ok(Date.now() - t0 >= 250, "should have waited out the grace");
});

test("includeRoot false spares the root", async () => {
  const { child, grand } = await startTree(PARENT_SRC());
  const { survivors } = await killTree(child.pid, { graceMs: 300, includeRoot: false });
  assert.equal(survivors.length, 0);
  assert.ok(alive(child.pid), "root should survive");
  assert.equal(alive(grand), false);
  child.kill("SIGKILL");
});

test("own pid: refused as a root, allowed for its descendants only (the child's parent-death cleanup)", async () => {
  await assert.rejects(killTree(process.pid), /killTree refuses pid/);
  const kid = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { detached: true, stdio: "ignore" });
  track(kid.pid);
  await until(() => alive(kid.pid));
  const { survivors } = await killTree(process.pid, { graceMs: 300, includeRoot: false });
  assert.equal(survivors.length, 0);
  assert.equal(alive(kid.pid), false);
});

test("re-walk catches a late child", async () => {
  // On SIGTERM the root spawns a NEW detached grandchild and keeps running; only a re-walk finds it.
  const src = `
const { spawn } = require("node:child_process");
process.on("SIGTERM", () => {
  const g = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { detached: true, stdio: "ignore" });
  require("node:fs").writeFileSync(process.env.LATE_FILE, String(g.pid));
});
console.log("0");
setTimeout(()=>{},60000);`;
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "lpd-kill-"));
  const lateFile = join(dir, "late");
  try {
    const { child } = await startTree(src, { env: { ...process.env, LATE_FILE: lateFile } });
    const { survivors } = await killTree(child.pid, { graceMs: 300 });
    const late = Number(readFileSync(lateFile, "utf8"));
    track(late);
    assert.equal(survivors.length, 0);
    assert.equal(alive(late), false, "late grandchild survived");
    assert.equal(alive(child.pid), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const statLine = (ticks) => `9 (x y) S 1 9 9 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 ${ticks} 0 0`;
const eacces = () => Object.assign(new Error("EACCES"), { code: "EACCES" });
const fixture = (ticks) => (p) => {
  if (p.endsWith("/environ")) throw eacces();
  if (p.endsWith("/status")) return `Uid:\t${process.getuid()}\t0\t0\t0\n`;
  if (p.endsWith("/stat")) return statLine(ticks);
  throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
};

test("survivorsByMarker finds exact marker only (any age) and skips other users / vanished", () => {
  const me = process.getuid();
  const err = (code) => Object.assign(new Error(code), { code });
  const readProc = (p) => {
    if (p === "/proc/11/environ") return "A=1\0CROW_EVAL_RUN_ID=run-1\0";
    if (p === "/proc/12/environ") return "CROW_EVAL_RUN_ID=run-10\0";
    if (p === "/proc/13/environ") return "XCROW_EVAL_RUN_ID=run-1\0";
    if (p === "/proc/15/environ") throw err("EACCES");
    if (p === "/proc/16/environ") throw err("ENOENT");
    if (p === "/proc/15/status") return `Uid:\t${me + 1}\t0\t0\t0\n`;
    throw err("ENOENT");
  };
  assert.deepEqual(survivorsByMarker("run-1", { sinceBootSec: 1e9, readProc, listPids: () => [11, 12, 13, 15, 16] }), [11]);
});

test("unreadable old process is not a survivor", () => {
  // started at tick 100 (<= 1 s at any plausible CLK_TCK), run began at 50 s since boot
  assert.deepEqual(survivorsByMarker("r", { sinceBootSec: 50, readProc: fixture(100), listPids: () => [9] }), []);
});

test("unreadable new process is a survivor", () => {
  assert.deepEqual(survivorsByMarker("r", { sinceBootSec: 50, readProc: fixture(1e9), listPids: () => [9] }), [9]);
});

test("unreadable new zombie is not a survivor", () => {
  // A same-uid zombie's environ is EACCES as well; it is dead and holds nothing.
  const zombie = (p) => (p.endsWith("/stat") ? statLine(1e9).replace(") S ", ") Z ") : fixture(1e9)(p));
  assert.deepEqual(survivorsByMarker("r", { sinceBootSec: 50, readProc: zombie, listPids: () => [9] }), []);
});

test("survivorsByMarker requires sinceBootSec", () => {
  assert.throws(() => survivorsByMarker("r", {}), /sinceBootSec/);
});

test("bootSecNow reads /proc/uptime field 1", () => {
  assert.equal(bootSecNow(() => "1234.56 9999.00\n"), 1234.56);
  assert.ok(bootSecNow() > 0);
});

test("survivorsByMarker sees a real process carrying the marker", async () => {
  const id = `lpd-${process.pid}-${Date.now()}`;
  const since = bootSecNow();
  const p = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore", env: { ...process.env, CROW_EVAL_RUN_ID: id } });
  track(p.pid);
  await until(() => existsSync(`/proc/${p.pid}/environ`));
  assert.ok(survivorsByMarker(id, { sinceBootSec: since }).includes(p.pid));
  p.kill("SIGKILL");
  await until(() => !survivorsByMarker(id, { sinceBootSec: since }).includes(p.pid));
});

test("long-lived unreadable processes are excluded on this box", () => {
  assert.deepEqual(survivorsByMarker(randomUUID(), { sinceBootSec: bootSecNow() }), []);
});

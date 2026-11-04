// The satellite agent's RAM budget (SAT-6, spec §6.4): booted with no extensions in a scratch
// SAT_HOME, idle for 30 s of real time (RSS settles over time, so no test-timing shortcut), its
// resident set (/proc/<pid>/status VmRSS) is at most 110 MB. The agent is spawned the way its
// unit starts it and waited for on its own readiness line, never a sleep.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO = join(import.meta.dirname, "..");
const AGENT = join(REPO, "servers", "satellite", "index.js");
const UID = String(typeof process.getuid === "function" ? process.getuid() : 0);
export const RSS_BUDGET_MB = 110;
export const IDLE_MS = 30000;

const dirs = [];
const kids = new Set();
after(() => {
  for (const k of kids) { try { k.kill("SIGKILL"); } catch {} }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const vmRssMb = (pid) => Number(/^VmRSS:\s+(\d+)\s*kB/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))[1]) / 1024;

test(`the idle agent with no extensions stays within ${RSS_BUDGET_MB} MB RSS`, { timeout: 120000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "satrss-home-"));
  dirs.push(home);
  const env = {
    PATH: process.env.PATH, HOME: home, CROW_HOME: join(home, ".crow-satellite"), CROW_PROFILE: "satellite",
    CROW_SATELLITE_PORT: "0", CROW_SERVE_PEER_UIDS: UID,
  };
  const child = spawn(process.execPath, [AGENT], { env, cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  kids.add(child);
  let out = "";
  let err = "";
  child.stderr.on("data", (d) => { err += d; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no readiness line\n${out}\n${err}`)), 30000);
    child.stdout.on("data", (d) => {
      out += d;
      const m = out.match(/listening on 127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`agent exited ${code}\n${out}\n${err}`)); });
  });
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  const atBoot = vmRssMb(child.pid);

  await new Promise((r) => setTimeout(r, IDLE_MS));
  assert.equal(child.exitCode, null, "still running");
  const idle = vmRssMb(child.pid);
  console.log(`satellite agent RSS: ${atBoot.toFixed(1)} MB at boot, ${idle.toFixed(1)} MB after ${IDLE_MS / 1000} s idle (budget ${RSS_BUDGET_MB} MB)`);
  assert.ok(idle <= RSS_BUDGET_MB, `RSS ${idle.toFixed(1)} MB > ${RSS_BUDGET_MB} MB`);

  await new Promise((resolve) => { child.on("exit", resolve); child.kill("SIGTERM"); });
  kids.delete(child);
});

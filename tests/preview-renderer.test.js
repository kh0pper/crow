/**
 * The preview renderer's guard, build, lifecycle and ownership
 * (servers/gateway/preview/renderer.js), against a fake docker, a fake pipe child and a
 * fake clock: no real Docker, no real waits. The live behaviour is in
 * tests/preview-renderer-live.test.js (Docker-gated).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, realpathSync, cpSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

import {
  createPreviewRenderer, setPreviewsEnabled, previewImageTag, PREVIEW_MANIFEST, SANDBOX_STDERR_RE,
  _setPreviewRendererForTest,
} from "../servers/gateway/preview/renderer.js";
import { _setPreviewSeccompPathForTest } from "../servers/gateway/compose-guard.js";
import themeSection from "../servers/gateway/dashboard/settings/sections/theme.js";
import onboardingPanel, { STEP_KEYS } from "../servers/gateway/dashboard/panels/onboarding.js";
import { t } from "../servers/gateway/dashboard/shared/i18n.js";

const DIR = fileURLToPath(new URL("../servers/gateway/preview/container/", import.meta.url)).replace(/\/$/, "");
const SECCOMP = realpathSync(join(DIR, "seccomp-chrome.json"));
const SCRATCH = mkdtempSync(join(tmpdir(), "crow-preview-renderer-"));
const CROW_HOME = join(SCRATCH, "home");
after(() => {
  _setPreviewSeccompPathForTest(null);
  _setPreviewRendererForTest(null);
  rmSync(SCRATCH, { recursive: true, force: true });
});

const DAY = 24 * 3600_000;
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// ---- a fake clock -----------------------------------------------------------------------

function fakeClock(start = Date.UTC(2026, 9, 27)) {
  let t = start;
  let q = [];
  let seq = 0;
  return {
    now: () => t,
    timers: {
      setTimeout(fn, ms) { const h = { at: t + Math.max(0, Number(ms) || 0), fn, seq: seq++, unref() { return h; } }; q.push(h); return h; },
      clearTimeout(h) { q = q.filter((x) => x !== h); },
    },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        await flush();
        q.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const next = q[0];
        if (!next || next.at > end) break;
        q.shift();
        t = next.at;
        next.fn();
      }
      t = end;
      await flush();
    },
  };
}

// ---- a fake settings db (the readSetting / upsertSetting SQL) -------------------------

function settingsDb(initial = {}) {
  const global = new Map(Object.entries(initial));
  const local = new Map();
  return {
    global, local,
    get: (k) => (local.has(k) ? local.get(k) : global.get(k) ?? null),
    async execute(q) {
      const sql = typeof q === "string" ? q : q.sql;
      const args = (typeof q === "string" ? [] : q.args) || [];
      if (/^\s*SELECT value FROM dashboard_settings_overrides/i.test(sql)) return { rows: local.has(args[0]) ? [{ value: local.get(args[0]) }] : [] };
      if (/^\s*SELECT value FROM dashboard_settings WHERE key/i.test(sql)) return { rows: global.has(args[0]) ? [{ value: global.get(args[0]) }] : [] };
      if (/INSERT INTO dashboard_settings_overrides/i.test(sql)) { local.set(args[0], args[2]); return { rows: [] }; }
      if (/INSERT INTO dashboard_settings /i.test(sql)) { global.set(args[0], args[1]); return { rows: [] }; }
      if (/DELETE FROM dashboard_settings_overrides/i.test(sql)) { local.delete(args[0]); return { rows: [] }; }
      return { rows: [] };
    },
  };
}

// ---- a fake browser child --------------------------------------------------------------

class FakeChild extends EventEmitter {
  constructor(clock, { stdoutJunk = null, stderrFirst = null, exitBeforeAnswer = null, ignoreEof = false } = {}) {
    super();
    this.clock = clock;
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.killed = null;
    this.ignoreEof = ignoreEof;
    this.broken = stdoutJunk !== null || exitBeforeAnswer !== null; // never answers CDP
    let buf = Buffer.alloc(0);
    this.stdin.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      for (let i; (i = buf.indexOf(0)) !== -1;) {
        const msg = JSON.parse(buf.subarray(0, i).toString("utf8"));
        buf = buf.subarray(i + 1);
        if (this.exitCode !== null || this.signalCode !== null || this.broken) continue;
        const result = msg.method === "Browser.getVersion" ? { product: "HeadlessChrome/1", userAgent: "HeadlessChrome" } : { ok: msg.method };
        this.stdout.write(JSON.stringify({ id: msg.id, result }) + "\0");
      }
    });
    this.stdin.on("end", () => { if (!this.ignoreEof) this._exit(0, null); });
    setImmediate(() => {
      if (stderrFirst) this.stderr.write(stderrFirst);
      if (stdoutJunk) this.stdout.write(stdoutJunk);
      if (exitBeforeAnswer !== null) {
        this.stderr.write(exitBeforeAnswer);
        this._exit(1, null);
      }
    });
  }
  kill(sig = "SIGTERM") {
    this.killed = { sig, at: this.clock.now() };
    this._exit(null, sig);
    return true;
  }
  _exit(code, sig) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = sig;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => { this.emit("exit", code, sig); setImmediate(() => this.emit("close", code, sig)); });
  }
}

// ---- a fake docker ----------------------------------------------------------------------

/** The renderer's model, as `docker compose config` would print it for this env. */
function modelFor(env, cwd) {
  return {
    name: "crow-preview-x",
    services: {
      renderer: {
        build: { context: cwd, dockerfile: "Dockerfile" },
        cap_drop: ["ALL"], command: null, entrypoint: null,
        environment: { CROW_PREVIEW_ARTIFACT_HOST: env.CROW_PREVIEW_ARTIFACT_HOST },
        image: env.CROW_PREVIEW_IMAGE, init: true,
        labels: { "crow.component": "preview-renderer", "crow.home": env.CROW_PREVIEW_HOME, "crow.instance": env.CROW_PREVIEW_INSTANCE },
        mem_limit: "805306368", network_mode: "none", pids_limit: 512, pull_policy: "never", read_only: true,
        security_opt: ["no-new-privileges:true", `seccomp=${env.CROW_PREVIEW_SECCOMP}`],
        shm_size: "268435456", stdin_open: true, tmpfs: ["/tmp:size=256m,mode=1777"], user: "10001:10001",
      },
    },
  };
}

function fakeDocker(clock, opts = {}) {
  const log = [];
  const containers = opts.containers || []; // { name, labels, image, running }
  const images = opts.images || {};          // tag → created ms
  const children = [];
  const filtersOf = (args) => args.flatMap((a, i) => (args[i - 1] === "--filter" ? [a] : []));
  const matches = (c, filters) => filters.every((f) => {
    const [k, v] = f.split("=", 2).length === 2 ? [f.slice(0, f.indexOf("=")), f.slice(f.indexOf("=") + 1)] : [f, ""];
    if (k === "label") { const [lk, lv] = [v.slice(0, v.indexOf("=")), v.slice(v.indexOf("=") + 1)]; return c.labels[lk] === lv; }
    if (k === "ancestor") return c.image === v;
    if (k === "name") return c.name.includes(v);
    return false;
  });
  const docker = {
    log, containers, images, children,
    async exec(args, { cwd, env } = {}) {
      log.push({ args, cwd, env });
      if (args[0] === "info") return { code: opts.info === false ? 1 : 0, stdout: "", stderr: "" };
      if (args[0] === "compose") {
        const verb = args[args.indexOf("-f") + 2];
        if (verb === "config") {
          const m = modelFor(env, cwd);
          if (opts.refuse) m.services.renderer.cap_add = ["SYS_ADMIN"];
          return { code: 0, stdout: JSON.stringify(m), stderr: "" };
        }
        if (verb === "build") {
          const code = opts.buildCode ? opts.buildCode() : 0;
          if (opts.buildGate) await opts.buildGate;
          if (code === 0) images[env.CROW_PREVIEW_IMAGE] = clock.now();
          return { code, stdout: "", stderr: code ? "build broke" : "" };
        }
      }
      if (args[0] === "image" && args[1] === "inspect") {
        const tag = args[args.length - 1];
        return tag in images ? { code: 0, stdout: new Date(images[tag]).toISOString() + "\n", stderr: "" } : { code: 1, stdout: "", stderr: "No such image" };
      }
      if (args[0] === "image" && args[1] === "rm") { delete images[args[args.length - 1]]; return { code: 0, stdout: "", stderr: "" }; }
      if (args[0] === "rm") {
        for (const n of args.slice(2)) { const i = containers.findIndex((c) => c.name === n); if (i !== -1) containers.splice(i, 1); }
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "ps") {
        const all = args.includes("-a");
        const rows = containers.filter((c) => (all || c.running) && matches(c, filtersOf(args)));
        return { code: 0, stdout: rows.map((c) => c.name).join("\n") + (rows.length ? "\n" : ""), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    spawn(args, { cwd, env } = {}) {
      log.push({ args, cwd, env, spawn: true });
      const child = new FakeChild(clock, (opts.child && opts.child(children.length)) || {});
      child.args = args;
      child.cwd = cwd;
      children.push(child);
      const name = args[args.indexOf("--name") + 1];
      const c = { name, labels: { "crow.component": "preview-renderer", "crow.instance": env.CROW_PREVIEW_INSTANCE, "crow.home": env.CROW_PREVIEW_HOME }, image: env.CROW_PREVIEW_IMAGE, running: true };
      containers.push(c);
      child.once("exit", () => { c.running = false; });
      return child;
    },
  };
  return docker;
}

const verbs = (log) => log.map((e) => (e.args[0] === "compose" ? e.args[e.args.indexOf("-f") + 2] : e.args.slice(0, e.args[0] === "image" ? 2 : 1).join(" ")));
const composeVerbs = (log) => log.filter((e) => e.args[0] === "compose").map((e) => e.args[e.args.indexOf("-f") + 2]);

const ORIGIN = () => ({ baseUrl: "http://artifacts.example.test:3060" });

/** A renderer with previews on and the image already built (unless told otherwise). */
function setup({ enabled = true, imageReady = true, dockerOpts = {}, containerDir, ...over } = {}) {
  const clock = fakeClock();
  const docker = fakeDocker(clock, dockerOpts);
  const db = settingsDb(enabled ? { previews_enabled: "true" } : {});
  const r = createPreviewRenderer({
    crowHome: CROW_HOME, db, docker, now: clock.now, timers: clock.timers, inContainer: () => false,
    instanceId: "instance-under-test", originInfo: ORIGIN, ...(containerDir ? { containerDir } : {}), ...over,
  });
  if (imageReady) docker.images[previewImageTag(containerDir)] = clock.now() - DAY;
  return { clock, docker, db, r };
}

// ---- the invocation ---------------------------------------------------------------------

test("the exact invocation", async () => {
  const { docker, r } = setup();
  const lease = await r.acquire();
  assert.ok(lease.cdp, JSON.stringify(lease));
  const spawns = docker.log.filter((e) => e.spawn);
  assert.equal(spawns.length, 1);
  const { args, cwd } = spawns[0];
  const name = args[args.indexOf("--name") + 1];
  assert.match(name, /^crow-preview-[0-9a-f]{8}-[0-9a-f]{8}$/);
  const label = name.split("-")[2];
  assert.deepEqual(args, ["compose", "-p", `crow-preview-${label}`, "-f", join(DIR, "compose.yml"), "run", "--rm", "-T", "-q", "--no-deps", "--pull", "never", "--name", name, "renderer"]);
  assert.ok(isAbsolute(args[4]));
  assert.equal(cwd, DIR);
  for (const e of docker.log) assert.ok(!e.args.includes("--build"), `no --build: ${e.args.join(" ")}`);
  assert.equal(r.state(), "running");
  lease.release();
  await r.stop();
});

test("names are unique per run", async () => {
  const { docker, r } = setup();
  (await r.acquire()).release();
  await r.stop();
  (await r.acquire()).release();
  await r.stop();
  const names = docker.log.filter((e) => e.spawn).map((e) => e.args[e.args.indexOf("--name") + 1]);
  assert.equal(names.length, 2);
  assert.notEqual(names[0], names[1]);
});

test("the guard runs before every build and run", async () => {
  let open;
  const buildGate = new Promise((res) => { open = res; });
  const { docker, r } = setup({ imageReady: false, dockerOpts: { buildGate } });
  assert.deepEqual(await r.acquire(), { off: "building" });
  assert.equal(r.buildState(), "building");
  open();
  await flush();
  assert.equal(r.buildState(), "ready");
  const lease = await r.acquire();
  assert.ok(lease.cdp);
  assert.deepEqual(composeVerbs(docker.log), ["config", "build", "config", "run"]);
  lease.release();
  await r.stop();

  // A refusal: nothing is run.
  const refused = setup({ dockerOpts: { refuse: true } });
  assert.deepEqual(await refused.r.acquire(), { off: "start_failed" });
  assert.equal(refused.r.lastOff(), "start_failed");
  assert.deepEqual(composeVerbs(refused.docker.log), ["config"]);
  assert.equal(refused.docker.log.filter((e) => e.spawn).length, 0);
  // …and a refused build is a failed build.
  const refusedBuild = setup({ imageReady: false, dockerOpts: { refuse: true } });
  assert.deepEqual(await refusedBuild.r.acquire(), { off: "building" });
  await flush();
  assert.equal(refusedBuild.r.buildState(), "failed");
  assert.deepEqual(await refusedBuild.r.acquire(), { off: "build_failed" });
  assert.deepEqual(composeVerbs(refusedBuild.docker.log), ["config"]);
});

test("CROW_PREVIEW_SECCOMP is absolute", async () => {
  const { docker, r } = setup({ imageReady: false });
  await r.acquire();
  await flush();
  const lease = await r.acquire();
  lease.release();
  await r.stop();
  const composeCalls = docker.log.filter((e) => e.args[0] === "compose");
  assert.ok(composeCalls.length >= 4);
  for (const { env } of composeCalls) {
    assert.equal(isAbsolute(env.CROW_PREVIEW_SECCOMP), true);
    assert.equal(env.CROW_PREVIEW_SECCOMP, SECCOMP);
    for (const k of ["CROW_PREVIEW_IMAGE", "CROW_PREVIEW_SECCOMP", "CROW_PREVIEW_INSTANCE", "CROW_PREVIEW_HOME", "CROW_PREVIEW_ARTIFACT_HOST", "CROW_HOME"]) {
      assert.ok(env[k], `${k} is set`);
    }
    assert.match(env.CROW_PREVIEW_INSTANCE, /^[0-9a-f]{8}$/);
    assert.match(env.CROW_PREVIEW_HOME, /^[0-9a-f]{8}$/);
    assert.equal(env.CROW_PREVIEW_IMAGE, previewImageTag());
    assert.equal(env.CROW_PREVIEW_ARTIFACT_HOST, "artifacts.example.test");
    assert.equal(env.COMPOSE_FILE, undefined);
  }
});

test("an artifact host that isn't a plain hostname is start_failed, nothing spawned", async () => {
  for (const baseUrl of ["http://a,b.example.test:3060", "http://[::1]:3060", null]) {
    const { docker, r } = setup({ originInfo: () => (baseUrl ? { baseUrl } : null) });
    assert.deepEqual(await r.acquire(), { off: "start_failed" }, String(baseUrl));
    assert.equal(docker.log.filter((e) => e.args[0] === "compose" || e.spawn).length, 0);
  }
});

test("stdout that isn't CDP is start_failed", async () => {
  const { docker, r } = setup({ dockerOpts: { child: () => ({ stdoutJunk: "Creating…\n", ignoreEof: true }) } });
  assert.deepEqual(await r.acquire(), { off: "start_failed" });
  assert.equal(r.state(), "stopped");
  const name = docker.children[0].args[docker.children[0].args.indexOf("--name") + 1];
  assert.ok(docker.children[0].killed, "the compose child is killed");
  assert.ok(docker.log.some((e) => e.args[0] === "rm" && e.args.includes(name)), "and its container removed by name");
});

test("stderr is drained into a 64 KB tail", async () => {
  const noise = randomBytes(512 * 1024).toString("hex"); // 1 MiB of ASCII
  const { r } = setup({ dockerOpts: { child: () => ({ stderrFirst: noise }) } });
  const lease = await r.acquire();
  assert.ok(lease.cdp, JSON.stringify(lease));
  await flush();
  assert.equal(r.stderrTail().length, 65536);
  assert.equal(r.stderrTail(), noise.slice(-65536));
  lease.release();
  await r.stop();
});

test("sandbox detection", async () => {
  for (const stderr of ["Failed to move to new namespace: PID namespaces supported, Network namespace supported, but failed: errno = Operation not permitted",
    "[1:1:FATAL:zygote_host_impl_linux.cc(128)] Check failed: . ",
    "No usable sandbox! If you are running on Ubuntu 23.10+ …"]) {
    assert.ok(SANDBOX_STDERR_RE.test(stderr));
    const { docker, r } = setup({ dockerOpts: { child: () => ({ exitBeforeAnswer: stderr }) } });
    assert.deepEqual(await r.acquire(), { off: "sandbox_unavailable" }, stderr);
    const spawns = docker.log.filter((e) => e.spawn);
    assert.equal(spawns.length, 1, "never retried");
    assert.ok(!spawns[0].args.includes("--no-sandbox"));
    assert.equal(r.lastOff(), "sandbox_unavailable");
  }
  const { docker, r } = setup({ dockerOpts: { child: () => ({ exitBeforeAnswer: "out of memory" }) } });
  assert.deepEqual(await r.acquire(), { off: "start_failed" });
  assert.equal(docker.log.filter((e) => e.spawn).length, 1);
});

test("a containerized gateway reports no_docker and runs nothing", async () => {
  const { docker, r } = setup({ inContainer: () => true });
  assert.deepEqual(await r.acquire(), { off: "no_docker" });
  assert.deepEqual(await r.sweep(), { removed: [] });
  assert.deepEqual(docker.log, []);
});

test("docker info failing is no_docker", async () => {
  const { docker, r } = setup({ dockerOpts: { info: false } });
  assert.deepEqual(await r.acquire(), { off: "no_docker" });
  assert.deepEqual(verbs(docker.log), ["info"]);
});

test("acquire before start", async () => {
  const { docker, r } = setup();
  const [a, b] = await Promise.all([r.acquire(), r.acquire()]);
  assert.ok(a.cdp && b.cdp);
  assert.equal(a.cdp, b.cdp);
  assert.equal(docker.log.filter((e) => e.spawn).length, 1);
  a.release();
  b.release();
  await r.stop();
});

test("a stop in flight, then acquire: the render waits and the renderer restarts", async () => {
  const { clock, docker, r } = setup({ dockerOpts: { child: (i) => ({ ignoreEof: i === 0 }) } });
  (await r.acquire()).release();
  await clock.advance(121_000);
  const stopping = r.tick();
  await flush();
  assert.equal(r.state(), "stopping");
  const later = r.acquire();
  await clock.advance(5_000); // the first child ignores EOF: killed at 5 s
  assert.equal(await stopping, "stopped");
  const lease = await later;
  assert.ok(lease.cdp, JSON.stringify(lease));
  assert.equal(r.state(), "running");
  assert.deepEqual(await lease.cdp.send("Page.navigate", { url: "about:blank" }), { ok: "Page.navigate" });
  const v = verbs(docker.log);
  const firstRm = v.indexOf("rm");
  const secondRun = v.lastIndexOf("run");
  assert.ok(firstRm !== -1 && secondRun > firstRm, v.join(","));
  assert.equal(docker.log.filter((e) => e.spawn).length, 2);
  lease.release();
  await r.stop();
});

test("idle counts from the last release", async () => {
  const { clock, r } = setup();
  const lease = await r.acquire();
  await clock.advance(10 * 60_000);
  assert.equal(await r.tick(), "kept", "a held lease is never idled");
  lease.release();
  await clock.advance(90_000);
  assert.equal(await r.tick(), "kept");
  await clock.advance(31_000);
  assert.equal(await r.tick(), "stopped");
  assert.equal(r.state(), "stopped");
  assert.equal(await r.tick(), "idle");
});

test("a stop closes stdin, waits 5 s, kills, then removes by name", async () => {
  const { clock, docker, r } = setup({ dockerOpts: { child: () => ({ ignoreEof: true }) } });
  (await r.acquire()).release();
  const child = docker.children[0];
  const name = child.args[child.args.indexOf("--name") + 1];
  let stdinEnded = false;
  child.stdin.on("finish", () => { stdinEnded = true; });
  const t0 = clock.now();
  const stop = r.stop();
  await flush();
  assert.equal(stdinEnded, true, "stdin is closed first");
  await clock.advance(4_900);
  assert.equal(child.killed, null, "not killed before 5 s");
  await clock.advance(100);
  await stop;
  assert.equal(child.killed.sig, "SIGKILL");
  assert.ok(Math.abs(child.killed.at - t0 - 5_000) <= 100, `killed at ${child.killed.at - t0} ms`);
  const tail = docker.log.slice(docker.log.findIndex((e) => e.args[0] === "rm"));
  assert.deepEqual(tail[0].args, ["rm", "-f", name]);
  assert.equal(tail[1].args[0], "ps", "then the sweep");
  assert.equal(r.state(), "stopped");
});

test("the sweep removes only our labels", async () => {
  const { docker, r } = setup();
  const lease = await r.acquire();
  const live = docker.containers[0];
  const ours = { ...live.labels };
  docker.containers.push(
    { name: "crow-preview-aaaaaaaa-00000001", labels: ours, image: live.image, running: false },
    { name: "crow-preview-bbbbbbbb-00000002", labels: { ...ours, "crow.instance": "bbbbbbbb" }, image: live.image, running: true },
    { name: "crow-preview-cccccccc-00000003", labels: { ...ours, "crow.home": "cccccccc" }, image: live.image, running: false },
  );
  assert.deepEqual(await r.sweep(), { removed: ["crow-preview-aaaaaaaa-00000001"] });
  const ps = docker.log.filter((e) => e.args[0] === "ps").pop().args;
  assert.ok(ps.includes("-a"));
  assert.ok(ps.includes("label=crow.component=preview-renderer"));
  assert.ok(ps.includes(`label=crow.instance=${ours["crow.instance"]}`));
  assert.ok(ps.includes(`label=crow.home=${ours["crow.home"]}`));
  assert.deepEqual(docker.containers.map((c) => c.name).sort(), [live.name, "crow-preview-bbbbbbbb-00000002", "crow-preview-cccccccc-00000003"].sort());
  lease.release();
  await r.stop();
});

test("the build is separate and backs off", async () => {
  let failing = true;
  const { clock, docker, r } = setup({ imageReady: false, dockerOpts: { buildCode: () => (failing ? 1 : 0) } });
  assert.deepEqual(await r.acquire(), { off: "building" });
  await flush();
  assert.equal(r.buildState(), "failed");
  assert.deepEqual(await r.acquire(), { off: "build_failed" });
  await clock.advance(9 * 60_000);
  assert.deepEqual(await r.acquire(), { off: "build_failed" });
  assert.equal(composeVerbs(docker.log).filter((v) => v === "build").length, 1, "no rebuild inside 10 min");
  failing = false;
  await clock.advance(60_001);
  assert.deepEqual(await r.acquire(), { off: "building" });
  await flush();
  assert.equal(composeVerbs(docker.log).filter((v) => v === "build").length, 2, "then a retry");
  assert.equal(r.buildState(), "ready");
  const lease = await r.acquire();
  assert.ok(lease.cdp);
  lease.release();
  await r.stop();
});

test("while the build runs, acquire is building and starts nothing", async () => {
  let open;
  const gate = new Promise((res) => { open = res; });
  const { docker, r } = setup({ imageReady: false, dockerOpts: { buildGate: gate } });
  assert.deepEqual(await r.acquire(), { off: "building" });
  assert.deepEqual(await r.acquire(), { off: "building" });
  assert.equal(composeVerbs(docker.log).filter((v) => v === "build").length, 1);
  open();
  await flush();
  assert.equal(r.buildState(), "ready");
});

test("a stale or changed image is rebuilt", async () => {
  // 31 days old: rebuilt.
  {
    const { clock, docker, r } = setup({ imageReady: false });
    docker.images[previewImageTag()] = clock.now() - 31 * DAY;
    assert.deepEqual(await r.acquire(), { off: "building" });
    await flush();
    assert.equal(composeVerbs(docker.log).filter((v) => v === "build").length, 1);
  }
  // A changed Dockerfile is a new tag: rebuilt.
  {
    const copy = join(SCRATCH, "container-copy");
    cpSync(DIR, copy, { recursive: true });
    _setPreviewSeccompPathForTest(join(copy, "seccomp-chrome.json"));
    try {
      const { docker, r } = setup({ containerDir: copy });
      const before = previewImageTag(copy);
      const lease = await r.acquire();
      assert.ok(lease.cdp, JSON.stringify(lease));
      lease.release();
      await r.stop();
      assert.equal(composeVerbs(docker.log).filter((v) => v === "build").length, 0);
      appendFileSync(join(copy, "Dockerfile"), "\n# changed\n");
      assert.notEqual(previewImageTag(copy), before);
      assert.deepEqual(await r.acquire(), { off: "building" });
      await flush();
      assert.equal(composeVerbs(docker.log).filter((v) => v === "build").length, 1);
      assert.equal(docker.log.filter((e) => e.args[0] === "compose").pop().env.CROW_PREVIEW_IMAGE, previewImageTag(copy));
    } finally {
      _setPreviewSeccompPathForTest(null);
    }
  }
});

test("three timeouts trip the breaker", async () => {
  const { clock, r } = setup();
  for (let i = 0; i < 2; i++) (await r.acquire()).release({ timedOut: true });
  (await r.acquire()).release(); // any other release resets the count
  for (let i = 0; i < 3; i++) (await r.acquire()).release({ timedOut: true });
  assert.deepEqual(await r.acquire(), { off: "origin_unreachable" });
  assert.equal(r.lastOff(), "origin_unreachable");
  await clock.advance(5 * 60_000 - 1_000);
  assert.deepEqual(await r.acquire(), { off: "origin_unreachable" });
  await clock.advance(1_001);
  const lease = await r.acquire();
  assert.ok(lease.cdp, JSON.stringify(lease));
  lease.release();
  await r.stop();
});

test("previews not enabled is not_enabled, with no docker call at all", async () => {
  const { docker, r } = setup({ enabled: false });
  assert.deepEqual(await r.acquire(), { off: "not_enabled" });
  assert.deepEqual(docker.log, []);
});

// ---- the switches -----------------------------------------------------------------------

function fakeRes() {
  return { redirected: null, redirectAfterPost(u) { this.redirected = u; }, setHeader() {}, send() {} };
}

test("the off switch stops it, and removes the image only on request", async () => {
  const { docker, db, r } = setup();
  _setPreviewRendererForTest(r);
  try {
    const html = await themeSection.render({ db, lang: "en" });
    assert.ok(html.includes(t("settings.previews", "en")));
    assert.ok(html.includes(t("settings.previewsRemoveImage", "en")));
    assert.match(html, /name="previews" value="true" checked/);

    const lease = await r.acquire();
    const name = docker.children[0].args[docker.children[0].args.indexOf("--name") + 1];
    lease.release();
    assert.equal(r.state(), "running");

    const res = fakeRes();
    assert.equal(await themeSection.handleAction({ req: { body: { action: "update_previews" } }, res, db, action: "update_previews" }), true);
    assert.equal(db.get("previews_enabled"), "false");
    assert.equal(r.state(), "stopped");
    assert.ok(docker.log.some((e) => e.args[0] === "rm" && e.args.includes(name)));
    assert.ok(!verbs(docker.log).includes("image rm"), "the image stays unless asked");
    assert.ok(res.redirected);
    assert.deepEqual(await r.acquire(), { off: "not_enabled" });

    const html2 = await themeSection.render({ db, lang: "en" });
    assert.doesNotMatch(html2, /name="previews" value="true" checked/);

    await themeSection.handleAction({ req: { body: { action: "update_previews", previews_remove_image: "true" } }, res: fakeRes(), db, action: "update_previews" });
    const rm = docker.log.filter((e) => e.args[0] === "image" && e.args[1] === "rm");
    assert.equal(rm.length, 1);
    assert.equal(rm[0].args[rm[0].args.length - 1], previewImageTag());
    assert.equal(r.buildState(), "absent");

    // Not while any instance's preview container is running that image.
    docker.images[previewImageTag()] = Date.now();
    docker.containers.push({ name: "crow-preview-dddddddd-00000004", labels: { "crow.component": "preview-renderer", "crow.instance": "dddddddd", "crow.home": "dddddddd" }, image: previewImageTag(), running: true });
    const out = await r.removeImage();
    assert.equal(out.removed, false);
    assert.equal(docker.log.filter((e) => e.args[0] === "image" && e.args[1] === "rm").length, 1);

    // Back on: written, and the build is kicked.
    await themeSection.handleAction({ req: { body: { action: "update_previews", previews: "true" } }, res: fakeRes(), db, action: "update_previews" });
    assert.equal(db.get("previews_enabled"), "true");
  } finally {
    _setPreviewRendererForTest(null);
  }
});

async function renderStep(query, db) {
  let captured = "";
  const layout = ({ content }) => content;
  const res = { send(h) { captured = h; }, setHeader() {} };
  const out = await onboardingPanel.handler({ method: "GET", query, headers: {} }, res, { layout, lang: "en", db, resolveStarterProviderFn: async () => null });
  return typeof out === "string" ? out : captured;
}

test("onboarding shows the toggle on, and finishing it writes previews_enabled=\"true\"", async () => {
  const { docker, db, r } = setup({ enabled: false, imageReady: false });
  _setPreviewRendererForTest(r);
  try {
    const starter = STEP_KEYS.indexOf("starter");
    const html = await renderStep({ step: String(starter) }, db);
    assert.ok(html.includes(t("onboarding.previews", "en")));
    assert.match(html, /<input type="checkbox" name="previews" value="on" checked/);
    assert.match(html, /form="onboarding-previews-form"/, "Next submits the toggle");
    assert.equal(db.get("previews_enabled"), null, "showing the step writes nothing");

    await renderStep({ step: String(starter + 1), previews_seen: "1", previews: "on" }, db);
    assert.equal(db.get("previews_enabled"), null, "not until onboarding is finished");
    await renderStep({ step: String(STEP_KEYS.indexOf("done")) }, db);
    assert.equal(db.get("previews_enabled"), "true");
    await flush();
    assert.equal(composeVerbs(docker.log).filter((v) => v === "build").length, 1, "the image builds in the background");

    // Turned off at the starter step: finishing leaves previews off.
    const off = setup({ enabled: false, imageReady: false });
    _setPreviewRendererForTest(off.r);
    await renderStep({ step: String(starter + 1), previews_seen: "1" }, off.db);
    await renderStep({ step: String(STEP_KEYS.indexOf("done")) }, off.db);
    assert.notEqual(off.db.get("previews_enabled"), "true");
    assert.deepEqual(composeVerbs(off.docker.log), []);
  } finally {
    _setPreviewRendererForTest(null);
  }
});

test("an existing instance after upgrade has previews off and builds nothing", async () => {
  const { docker, db, r } = setup({ enabled: false, imageReady: false });
  db.global.set("onboarding_completed_at", "2026-06-11T00:00:00Z");
  _setPreviewRendererForTest(r);
  try {
    await r.sweep(); // the boot sweep
    await renderStep({ step: String(STEP_KEYS.indexOf("done")) }, db); // a replayed done step changes nothing
    assert.deepEqual(await r.acquire(), { off: "not_enabled" });
    assert.equal(db.get("previews_enabled"), null);
    const v = composeVerbs(docker.log);
    assert.ok(!v.includes("build") && !v.includes("run"), v.join(","));
    assert.equal(docker.log.filter((e) => e.spawn).length, 0);
  } finally {
    _setPreviewRendererForTest(null);
  }
});

test("Turn on previews starts the build", async () => {
  const buildGate = new Promise(() => {}); // still building
  const { docker, db, r } = setup({ enabled: false, imageReady: false, dockerOpts: { buildGate } });
  await setPreviewsEnabled(db, true);
  assert.equal(db.get("previews_enabled"), "true");
  assert.deepEqual(await r.acquire(), { off: "building" });
  assert.deepEqual(await r.acquire(), { off: "building" });
  assert.equal(composeVerbs(docker.log).filter((v) => v === "build").length, 1);
  await setPreviewsEnabled(db, false);
  assert.equal(db.get("previews_enabled"), "false");
});

test("the manifest the guard sees is the core preview one", () => {
  assert.deepEqual(PREVIEW_MANIFEST, { id: "crow-preview", origin: "core" });
  assert.match(previewImageTag(), /^crow-preview-renderer:[0-9a-f]{12}$/);
});

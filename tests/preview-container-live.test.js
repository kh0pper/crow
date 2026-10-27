/**
 * The preview renderer's container, live (Docker-gated): the image is built from
 * servers/gateway/preview/container/ and started exactly as the gateway will start it
 * (`docker compose run … renderer`, CDP over the child's stdin/stdout). Checks that CDP
 * answers over the pipe, that seccomp is on, that Chromium's own sandbox comes up under
 * the profile, that there is no network, and that nothing in /etc/chromium.d disables
 * the sandbox.
 *
 * Runs only with CROW_REQUIRE_DOCKER=1 (required on the box before the preview renderer
 * merges); without it every case skips, even where Docker is present. With it, missing
 * Docker is a failure.
 *
 * Self-contained on purpose: it speaks NUL-framed CDP inline and does not use the
 * renderer's own code. Every container it starts is removed in `after` (by name, then by
 * a label sweep).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { previewImageTag } from "../servers/gateway/preview/renderer.js";

const DIR = fileURLToPath(new URL("../servers/gateway/preview/container/", import.meta.url));
const COMPOSE = realpathSync(join(DIR, "compose.yml"));
const SECCOMP = realpathSync(join(DIR, "seccomp-chrome.json"));
const IMAGE = previewImageTag();
const LABEL = randomBytes(4).toString("hex");
const NAME = `crow-preview-${LABEL}-${randomBytes(4).toString("hex")}`;
const ENV = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^DOCKER_[A-Z_]+$/.test(k))),
  CROW_PREVIEW_IMAGE: IMAGE,
  CROW_PREVIEW_SECCOMP: SECCOMP,
  CROW_PREVIEW_INSTANCE: LABEL,
  CROW_PREVIEW_HOME: "00000000",
  CROW_PREVIEW_ARTIFACT_HOST: "artifacts.example.test",
};

const docker = (args, opts = {}) => spawnSync("docker", args, { encoding: "utf8", env: ENV, timeout: 60_000, ...opts });
// Opt-in only: without CROW_REQUIRE_DOCKER=1 every case skips, even where Docker is
// present (CI's suite job has Docker; a cold build of this image does not belong there).
// HAVE_DOCKER is true only when the run opted in AND Docker is usable.
const REQUIRED = process.env.CROW_REQUIRE_DOCKER === "1";
const HAVE_DOCKER = REQUIRED && docker(["version", "--format", "{{.Server.Version}}"]).status === 0 && docker(["compose", "version"]).status === 0;
if (REQUIRED && !HAVE_DOCKER) {
  test("Docker is available (CROW_REQUIRE_DOCKER=1)", () => assert.fail("CROW_REQUIRE_DOCKER=1 but `docker` / `docker compose` is not usable here"));
}
const live = (name, fn) => test(name, { skip: HAVE_DOCKER ? false : (REQUIRED ? "Docker not available" : "Docker-gated: set CROW_REQUIRE_DOCKER=1 to run") }, fn);

let child = null;
let stderr = "";
let buffered = Buffer.alloc(0);
const waiters = [];
let nextId = 1;

function onData(chunk) {
  buffered = Buffer.concat([buffered, chunk]);
  for (let i; (i = buffered.indexOf(0)) !== -1;) {
    const msg = JSON.parse(buffered.subarray(0, i).toString("utf8"));
    buffered = buffered.subarray(i + 1);
    const w = waiters.findIndex((x) => x.id === msg.id);
    if (w !== -1) waiters.splice(w, 1)[0].resolve(msg);
  }
}
function cdp(method, params = {}, timeoutMs = 20_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`CDP ${method} timed out; stderr:\n${stderr.slice(-2000)}`)), timeoutMs);
    waiters.push({ id, resolve: (m) => { clearTimeout(t); resolve(m); } });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\0");
  });
}
const exec = (...cmd) => docker(["exec", NAME, ...cmd]);

function sweep() {
  if (!HAVE_DOCKER) return;
  docker(["rm", "-f", NAME]);
  const ids = docker(["ps", "-aq", "--filter", "label=crow.component=preview-renderer", "--filter", `label=crow.instance=${LABEL}`]).stdout.split(/\s+/).filter(Boolean);
  if (ids.length) docker(["rm", "-f", ...ids]);
}

before(async () => {
  if (!HAVE_DOCKER) return;
  const build = docker(["compose", "-p", `crow-preview-${LABEL}`, "-f", COMPOSE, "build", "renderer"], { cwd: DIR, timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(build.status, 0, `docker compose build failed:\n${build.stdout}\n${build.stderr}`);
  child = spawn("docker", ["compose", "-p", `crow-preview-${LABEL}`, "-f", COMPOSE, "run", "--rm", "-T", "-q", "--no-deps", "--pull", "never", "--name", NAME, "renderer"], { cwd: DIR, env: ENV, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.on("data", onData);
  child.stderr.on("data", (c) => { stderr += c; });
  child.stdin.on("error", () => {});
}, { timeout: 16 * 60_000 });

after(async () => {
  if (child && child.exitCode === null) {
    child.stdin.end();
    await new Promise((r) => { const t = setTimeout(() => { child.kill("SIGKILL"); r(); }, 5000); child.once("exit", () => { clearTimeout(t); r(); }); });
  }
  sweep();
  if (HAVE_DOCKER) {
    const left = docker(["ps", "-aq", "--filter", `label=crow.instance=${LABEL}`]).stdout.trim();
    assert.equal(left, "", "every test container is gone");
  }
});

live("CDP answers over the pipe", async () => {
  const r = await cdp("Browser.getVersion", {}, 60_000);
  assert.ok(r.result, JSON.stringify(r));
  assert.match(r.result.product, /Chrome/);
  assert.match(r.result.userAgent, /HeadlessChrome/);
  const inspect = docker(["inspect", "--format", "{{json .Config.Labels}} {{.HostConfig.NetworkMode}}", NAME]);
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.match(inspect.stdout, /"crow.component":"preview-renderer"/);
  assert.match(inspect.stdout, / none\n?$/);
});

live("seccomp is on", async () => {
  await cdp("Browser.getVersion", {}, 60_000);
  const r = exec("cat", "/proc/1/status");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Seccomp:\t2$/m);
  // The browser process too, not only the init.
  const ps = exec("sh", "-c", "for p in /proc/[0-9]*; do c=$(tr '\\0' ' ' < $p/cmdline 2>/dev/null); case \"$c\" in /usr/lib/chromium/chromium*) case \"$c\" in *--type=*) ;; *) grep '^Seccomp:' $p/status;; esac;; esac; done");
  assert.match(ps.stdout, /^Seccomp:\t2$/m, ps.stderr);
});

live("the sandbox is on", async () => {
  // A page means a renderer process.
  const t = await cdp("Target.createTarget", { url: "about:blank" });
  assert.ok(t.result?.targetId, JSON.stringify(t));
  let rows = [];
  for (let i = 0; i < 50; i++) {
    const r = exec("sh", "-c", "for p in /proc/[0-9]*; do c=$(tr '\\0' ' ' < $p/cmdline 2>/dev/null); case \"$c\" in /usr/lib/chromium/chromium*) echo \"${p#/proc/}|$(readlink $p/ns/user)|$c\";; esac; done");
    rows = r.stdout.split("\n").filter(Boolean).map((l) => { const [pid, ns, ...c] = l.split("|"); return { pid, ns, cmd: c.join("|") }; });
    if (rows.some((x) => /--type=renderer/.test(x.cmd))) break;
    await new Promise((res) => setTimeout(res, 200));
  }
  const browser = rows.find((x) => !/--type=/.test(x.cmd));
  const renderer = rows.find((x) => /--type=renderer/.test(x.cmd));
  assert.ok(browser && renderer, `browser and renderer processes: ${JSON.stringify(rows)}\nstderr:\n${stderr.slice(-2000)}`);
  assert.match(browser.ns, /^user:\[\d+\]$/, JSON.stringify(browser));
  assert.match(renderer.ns, /^user:\[\d+\]$/, JSON.stringify(renderer));
  assert.notEqual(renderer.ns, browser.ns, "the renderer runs in its own user namespace");
  await cdp("Target.closeTarget", { targetId: t.result.targetId });
});

live("no network", async () => {
  const dns = exec("getent", "hosts", "example.com");
  assert.notEqual(dns.status, 0, `getent resolved: ${dns.stdout}`);
  const net = exec("ls", "/sys/class/net");
  assert.equal(net.status, 0, net.stderr);
  assert.deepEqual(net.stdout.split(/\s+/).filter(Boolean), ["lo"]);
});

live("nothing in /etc/chromium.d disables the sandbox", async () => {
  const r = docker(["run", "--rm", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--security-opt", `seccomp=${SECCOMP}`, "--read-only", "--user", "10001:10001",
    "--label", "crow.component=preview-renderer", "--label", `crow.instance=${LABEL}`,
    "--entrypoint", "grep", IMAGE, "-r", "no-sandbox", "/etc/chromium.d"]);
  assert.equal(r.status, 1, `grep found a match or failed: status ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.equal(r.stdout, "");
});

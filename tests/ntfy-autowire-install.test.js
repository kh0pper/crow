/** ntfy autowire through the real install job (fake docker runner, scratch CROW_HOME before import). */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-aw-home-"));
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-aw-data-"));
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
delete process.env.NTFY_TOPIC;
writeFileSync(join(process.env.CROW_DATA_DIR, "instance-id"), "0867ac2809dedd885ba7769b21966f8e");

// Any push the install job sends goes to this stand-in, never a host's real ntfy.
const pushes = [];
const sink = http.createServer((req, res) => { pushes.push(req.headers.authorization); res.end("{}"); });
sink.listen(0, "127.0.0.1");
await new Promise((r) => sink.once("listening", r));
process.env.NTFY_HOST = "127.0.0.1";
process.env.NTFY_PORT = String(sink.address().port);

const B = await import("../servers/gateway/routes/bundles.js");
const { readStoredNtfyConfig } = await import("../servers/gateway/push/ntfy-config.js");

const FIXTURES = mkdtempSync(join(tmpdir(), "crow-aw-app-"));
B._setAppBundlesForTest(FIXTURES);
after(() => {
  B._setComposeRunnerForTest(null); B._setDockerRunnerForTest(null);
  sink.close();
  rmSync(process.env.CROW_HOME, { recursive: true, force: true });
  rmSync(FIXTURES, { recursive: true, force: true });
});

function fixture(id) {
  const dir = join(FIXTURES, id);
  mkdirSync(dir, { recursive: true });
  const m = { id, name: id, description: "d", type: "bundle", category: "infrastructure", version: "1.1.0", docker: { composefile: "docker-compose.yml" }, autowire: "ntfy-push" };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
  writeFileSync(join(dir, "docker-compose.yml"), "services:\n  ntfy:\n    image: busybox:1.36\n");
  return m;
}

function dockerFake() {
  const calls = [];
  const users = new Set();
  let n = 0;
  const runner = async (cmd, args) => {
    calls.push(args.join(" "));
    if (args[0] === "ps") return { stdout: "", stderr: "" };
    if (args[0] === "compose") throw new Error("no compose here");
    if (args[0] === "inspect") return { stdout: "true\n", stderr: "" };
    if (args[0] === "exec") {
      const sub = args.slice(args.indexOf("ntfy") + 1);
      if (sub[0] === "user" && sub[1] === "list") return { stdout: [...users].map((u) => `user ${u} (role: user, tier: none)`).join("\n"), stderr: "" };
      if (sub[0] === "user" && sub[1] === "add") { users.add(sub[2]); return { stdout: "added", stderr: "" }; }
      if (sub[0] === "access") return { stdout: "ok", stderr: "" };
      if (sub[0] === "token" && sub[1] === "add") return { stdout: `token tk_t${++n} created for user ${sub.at(-1)}, never expires`, stderr: "" };
      if (sub[0] === "token" && sub[1] === "list") return { stdout: "", stderr: "" };
    }
    throw new Error(`unexpected docker ${args.join(" ")}`);
  };
  return { runner, calls };
}

test("installing a bundle that declares autowire provisions this instance's push login", async () => {
  const m = fixture("aw-ntfy");
  const { runner, calls } = dockerFake();
  B._setDockerRunnerForTest(runner);
  B._setComposeRunnerForTest(async () => ({ stdout: "", stderr: "" }));
  const job = B._createJobForTest("aw-ntfy", "install");
  const out = await B.runInstallJob("aw-ntfy", {}, { job, installedSnapshot: [], consentVerified: false, manifest: m });
  assert.equal(out.ok, true, out.reason);
  const cfg = readStoredNtfyConfig();
  assert.equal(cfg.topic, "crow-0867ac2809");
  assert.equal(cfg.publisherToken, "tk_t1");
  assert.equal(cfg.subscriberToken, "tk_t2");
  assert.ok(calls.some((c) => c.startsWith("exec -e NTFY_PASSWORD crow-ntfy ntfy user add crow-0867ac2809-pub")));
  assert.ok(job.log.some((l) => /topic crow-0867ac2809 ready/.test(l)), "logged in the install job");
});

test("an env-configured gateway keeps its NTFY_* setup on install", async () => {
  rmSync(join(process.env.CROW_DATA_DIR, "ntfy-push.json"), { force: true });
  const m = fixture("aw-ntfy2");
  const { runner, calls } = dockerFake();
  B._setDockerRunnerForTest(runner);
  B._setComposeRunnerForTest(async () => ({ stdout: "", stderr: "" }));
  process.env.NTFY_TOPIC = "casey";
  try {
    const job = B._createJobForTest("aw-ntfy2", "install");
    const out = await B.runInstallJob("aw-ntfy2", {}, { job, installedSnapshot: [], consentVerified: false, manifest: m });
    assert.equal(out.ok, true, out.reason);
    assert.equal(calls.filter((c) => c.startsWith("exec")).length, 0);
    assert.equal(existsSync(join(process.env.CROW_DATA_DIR, "ntfy-push.json")), false);
  } finally {
    delete process.env.NTFY_TOPIC;
  }
});

/**
 * Bot bash policy "auto" — crow's spawn half, and pi-lab diagnostics.
 *
 *   - bash "auto" + a resolved classifier: PI_BOT_PERMISSION_POLICY carries
 *     classifier {url, model, timeout_ms} and nothing else (no key);
 *   - bash "auto" with no usable classifier: no classifier key (pi-lab then
 *     asks every command in Perch and refuses in channels);
 *   - any other policy: no classifier key, even when the stored def carried
 *     one (only the bridge may set it — a peer patch cannot aim a bot's
 *     safety check at a server of its choosing);
 *   - "[pi-lab/...]" stderr lines (MCP start failures, auto decisions) reach
 *     the gateway log; other stderr does not.
 *
 * PiRpc nodeBin/cliPath seam with a stub child; no real pi.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const k of Object.keys(process.env)) if (/^(PI_|PIBOT_)/.test(k)) delete process.env[k];
process.env.CROW_PI_SANDBOX = "off";

const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");
const { createStderrDiag } = await import("../scripts/pi-bots/pi-stderr-diag.mjs");

function scratch() {
  const d = mkdtempSync(join(tmpdir(), "crow-bba-spawn-"));
  mkdirSync(join(d, "sessions"), { recursive: true });
  return d;
}
function stub(dir, stderrLines = []) {
  const p = join(dir, "stub-pi.mjs");
  writeFileSync(p, [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(join(dir, "env.json"))}, JSON.stringify({ policy: process.env.PI_BOT_PERMISSION_POLICY }));`,
    ...stderrLines.map((l) => `process.stderr.write(${JSON.stringify(l + "\n")});`),
    "setTimeout(() => process.exit(0), 50);",
  ].join("\n"));
  return p;
}
async function spawnPolicy(def, extra = {}, stderrLines = [], logs = []) {
  // default: a live Perch chat (ask/auto run only there)
  if (!("extraEnv" in extra)) extra = { ...extra, extraEnv: { PI_BOT_INTERACTIVE: "1" } };
  const dir = scratch();
  const pi = new PiRpc(Object.assign({
    def, sessionDir: dir, resolved: { provider: "p", model: "m", key: "p/m" },
    nodeBin: process.execPath, cliPath: stub(dir, stderrLines), diagLog: (l) => logs.push(l),
  }, extra));
  await new Promise((r) => pi.proc.on("exit", r));
  await new Promise((r) => setTimeout(r, 20));
  const f = join(dir, "env.json");
  assert.ok(existsSync(f), "stub ran");
  return JSON.parse(JSON.parse(readFileSync(f, "utf8")).policy);
}
const SEL = { ok: true, providerId: "crow-voice", model: "qwen3.5-4b", url: "http://127.0.0.1:8011/v1", source: "auto" };

test("auto + classifier: policy carries url/model/timeout only", async () => {
  const p = await spawnPolicy({ permission_policy: { bash: "auto", write_paths: [] } }, { botClassifier: SEL });
  assert.equal(p.bash, "auto");
  assert.deepEqual(p.classifier, { url: "http://127.0.0.1:8011/v1", model: "qwen3.5-4b", timeout_ms: 6000 });
});

test("auto without a usable classifier: no classifier key (pi-lab fails closed)", async () => {
  const p = await spawnPolicy({ permission_policy: { bash: "auto", write_paths: [] } }, { botClassifier: { ok: false, reason: "none" } });
  assert.equal(p.bash, "auto");
  assert.equal("classifier" in p, false);
});

test("a def-supplied classifier is always dropped", async () => {
  const evil = { url: "http://100.64.20.9:9/v1", model: "yes-man" };
  const a = await spawnPolicy({ permission_policy: { bash: "auto", write_paths: [], classifier: evil } }, { botClassifier: null });
  assert.equal("classifier" in a, false);
  const b = await spawnPolicy({ permission_policy: { bash: "deny", write_paths: [], classifier: evil } }, { botClassifier: SEL });
  assert.equal("classifier" in b, false);
  assert.equal(b.bash, "deny");
});

test("deny/allowlist policies are unchanged (no classifier key)", async () => {
  const p = await spawnPolicy({ permission_policy: { bash: "allowlist", bash_allow: ["ls"], write_paths: [] } }, { botClassifier: SEL });
  assert.equal("classifier" in p, false);
});

test("[pi-lab/...] stderr lines reach the gateway log; other stderr does not", async () => {
  const logs = [];
  await spawnPolicy({ permission_policy: { bash: "deny", write_paths: [] } }, { diagLabel: "hank" }, [
    "[pi-lab/mcp-client] google-workspace: spawn uvx ENOENT",
    "some unrelated pi noise",
    "[pi-lab/bot-bash-auto] outcome=deny verdict=RISKY source=classifier ms=210 prog=curl chars=40 interactive=0",
  ], logs);
  assert.deepEqual(logs, [
    "[pi-bots hank] [pi-lab/mcp-client] google-workspace: spawn uvx ENOENT",
    "[pi-bots hank] [pi-lab/bot-bash-auto] outcome=deny verdict=RISKY source=classifier ms=210 prog=curl chars=40 interactive=0",
  ]);
});

test("diag forwarder: split chunks, control chars stripped, capped, rate-limited", () => {
  const out = [];
  const on = createStderrDiag({ label: "b/../x", emit: (l) => out.push(l), maxLines: 2 });
  on("[pi-lab/mcp-client] a: one\n[pi-lab/mcp");
  on("-client] b: t\u001bwo\n");
  on("[pi-lab/x] three\n[pi-lab/x] four\n");
  assert.equal(out[0], "[pi-bots b_.._x] [pi-lab/mcp-client] a: one");
  assert.equal(out[1], "[pi-bots b_.._x] [pi-lab/mcp-client] b: t wo");
  assert.match(out[2], /suppressed/);
  assert.equal(out.length, 3);
  const long = [];
  createStderrDiag({ label: "b", emit: (l) => long.push(l) })("[pi-lab/x] " + "y".repeat(1000) + "\n");
  assert.ok(long[0].length < 480);
});

test("runtime Perch-only: ask/auto run as deny for a bot that also answers on another channel", async () => {
  for (const type of ["gmail", "discord", "telegram", "slack", "crow-messages", "glasses", "companion"]) {
    const p = await spawnPolicy({ gateways: [{ type }], permission_policy: { bash: "auto", write_paths: [] } }, { botClassifier: SEL });
    assert.equal(p.bash, "deny", type);
    assert.equal("classifier" in p, false, type);
  }
  const ask = await spawnPolicy({ gateways: [{ type: "gmail" }], permission_policy: { bash: "ask", write_paths: [] } }, {});
  assert.equal(ask.bash, "deny");
  const perch = await spawnPolicy({ gateways: [{ type: "perch" }], permission_policy: { bash: "auto", write_paths: [] } }, { botClassifier: SEL });
  assert.equal(perch.bash, "auto");
  assert.ok(perch.classifier);
  const allow = await spawnPolicy({ gateways: [{ type: "gmail" }], permission_policy: { bash: "allowlist", bash_allow: ["ls"], write_paths: [] } }, {});
  assert.equal(allow.bash, "allowlist", "the command list is not affected");
});

test("runtime Perch-only reads the same accessor: odd gateway shapes and non-interactive turns run as deny", async () => {
  for (const gateways of [{ type: "gmail" }, "discord", [{}], [null], [{ type: " Slack " }]]) {
    const p = await spawnPolicy({ gateways, permission_policy: { bash: "auto", write_paths: [] } }, { botClassifier: SEL, extraEnv: { PI_BOT_INTERACTIVE: "1" } });
    assert.equal(p.bash, "deny", JSON.stringify(gateways));
  }
  // a Perch-only bot outside a live Perch chat (a board job, a channel turn): deny
  const job = await spawnPolicy({ permission_policy: { bash: "auto", write_paths: [] } }, { botClassifier: SEL, extraEnv: {} });
  assert.equal(job.bash, "deny");
  const live = await spawnPolicy({ gateways: [{ type: "PERCH" }], permission_policy: { bash: "ask", write_paths: [] } }, { extraEnv: { PI_BOT_INTERACTIVE: "1" } });
  assert.equal(live.bash, "ask");
});

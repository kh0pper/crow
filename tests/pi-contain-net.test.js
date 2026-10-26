// Queue item 19, step 2c: a contained PiRpc child has no network of its own.
// Its allowed loopback ports exist inside (relayed), everything else on the
// host's loopback, LAN and abstract sockets does not, and the HTTPS proxy is
// the relay (which refuses private targets).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probePiSandbox, _resetPiSandboxForTest } from "../scripts/pi-bots/pi_sandbox.mjs";

_resetPiSandboxForTest();
const SANDBOX = probePiSandbox({ force: true });
const skip = SANDBOX.ok && SANDBOX.pidns !== false ? false : "bubblewrap with a PID namespace unavailable";
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "crow-pi-net-test-")));
const saved = Object.fromEntries(["CROW_PI_CONTAIN_BOTS", "PI_CODING_AGENT_DIR", "CROW_GATEWAY_PORT", "CROW_PI_SANDBOX"].map((k) => [k, process.env[k]]));
const servers = [];
after(() => {
  for (const s of servers) s.close();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(scratch, { recursive: true, force: true });
});
const listen = (srv, host = "127.0.0.1", path = null) => new Promise((r) => { servers.push(srv); path ? srv.listen(path, r) : srv.listen(0, host, () => r(srv.address().port)); });

test("integration: allowed loopback port reachable inside; other loopback ports, direct IPs and abstract sockets are not; the proxy is the relay", { skip, timeout: 60000 }, async () => {
  const gw = await listen(createServer((c) => c.end("GATEWAY")));
  const other = await listen(createServer((c) => c.end("OTHER")));
  const abstractName = "\0crow-net-test-" + process.pid;
  await listen(createServer((c) => c.end("ABSTRACT")), null, abstractName);
  process.env.CROW_GATEWAY_PORT = String(gw);
  process.env.CROW_PI_CONTAIN_BOTS = "net-test-bot";
  delete process.env.CROW_PI_SANDBOX;
  const agent = join(scratch, "agent"); mkdirSync(agent, { recursive: true }); writeFileSync(join(agent, "settings.json"), "{}");
  process.env.PI_CODING_AGENT_DIR = agent;
  const session = join(scratch, "session"); mkdirSync(join(session, "sessions"), { recursive: true });
  const stub = join(scratch, "stub-pi.mjs");
  writeFileSync(stub, `
import { connect } from "node:net";
const P = JSON.parse(process.env.CROW_TEST_NET);
const tryConn = (opts) => new Promise((res) => { const s = connect(opts); let b = ""; s.on("data", (d) => b += d); s.on("end", () => res(b || "EMPTY"));
  s.on("error", (e) => res("ERR:" + e.code)); setTimeout(() => { s.destroy(); res(b || "TIMEOUT"); }, 3000); });
const proxyTry = () => new Promise((res) => { const u = new URL(process.env.HTTPS_PROXY); const s = connect({ host: u.hostname, port: Number(u.port) });
  let b = ""; s.on("connect", () => s.write("CONNECT 10.0.0.1:443 HTTP/1.1\\r\\nHost: 10.0.0.1:443\\r\\n\\r\\n")); s.on("data", (d) => { b += d; s.destroy(); res(b.split("\\r\\n")[0]); });
  s.on("error", (e) => res("ERR:" + e.code)); setTimeout(() => res(b || "TIMEOUT"), 3000); });
const r = {
  gw: await tryConn({ host: "127.0.0.1", port: P.gw }),
  other: await tryConn({ host: "127.0.0.1", port: P.other }),
  direct: await tryConn({ host: "1.1.1.1", port: 443 }),
  abstract: await tryConn({ path: P.abstract }),
  proxy: await proxyTry(),
  proxyEnv: !!process.env.HTTPS_PROXY && process.env.NODE_USE_ENV_PROXY === "1" && !!process.env.no_proxy,
};
process.stdout.write(JSON.stringify({ type: "report", ...r }) + "\\n");
process.stdin.resume();
`);
  const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");
  const pi = new PiRpc({
    def: { bot_id: "net-test-bot", permission_policy: { bash: "deny", write_paths: [] },
      spawn_env: { CROW_TEST_NET: JSON.stringify({ gw, other, abstract: abstractName }) } },
    sessionDir: session, resolved: { provider: "p", model: "m", key: "p/m" }, nodeBin: process.execPath, cliPath: stub,
  });
  try {
    assert.match(pi.sandboxTier, /^contain/);
    assert.doesNotMatch(pi.sandboxTier, /hostnet/);
    const r = await pi.waitFor((m) => m.type === "report", 30000, "report");
    assert.equal(r.gw, "GATEWAY", "the spawner's gateway port is relayed in");
    assert.notEqual(r.other, "OTHER", "another host loopback port is not reachable: " + r.other);
    assert.match(r.direct, /^ERR:(ENETUNREACH|EHOSTUNREACH|ECONNREFUSED)/, "no route out of the namespace: " + r.direct);
    assert.notEqual(r.abstract, "ABSTRACT", "host abstract sockets are not reachable: " + r.abstract);
    assert.match(r.proxy, /^HTTP\/1\.1 403/, "the proxy is the relay, and it refuses a private target");
    assert.equal(r.proxyEnv, true);
    await new Promise((res) => setTimeout(res, 300));
    const { readFileSync } = await import("node:fs");
    const piCmd = readFileSync("/proc/" + pi.piPid + "/cmdline", "utf8");
    assert.ok(piCmd.includes("stub-pi.mjs") && !piCmd.includes("pi_netns_entry.mjs"), "piPid is pi itself, past the entry: " + piCmd.replace(/\0/g, " "));
  } finally {
    await pi.close();
  }
});

test("reaper: outer bwrap -> namespace init -> network entry -> pi counts as ONE pi, leased by the outer pid", async () => {
  const { listBridgePi } = await import("../scripts/pi-bots/pi_lifecycle.mjs");
  const cli = "/x/node_modules/@earendil-works/pi-coding-agent/dist/cli.js --mode rpc --no-approve";
  const ps = [
    `100 1 50 1000 /usr/bin/bwrap --tmpfs / --unshare-net -- /n/node /a/scripts/pi-bots/pi_netns_entry.mjs --sock /run/crow-net/relay.sock -- /n/node ${cli}`,
    `101 100 50 900 /usr/bin/bwrap --tmpfs / --unshare-net -- /n/node /a/scripts/pi-bots/pi_netns_entry.mjs --sock /run/crow-net/relay.sock -- /n/node ${cli}`,
    `102 101 50 40000 /n/node /a/scripts/pi-bots/pi_netns_entry.mjs --sock /run/crow-net/relay.sock --ports 3001 -- /n/node ${cli}`,
    `103 102 50 300000 /n/node ${cli}`,
  ].join("\n");
  const procs = listBridgePi({ _psOutput: ps });
  assert.equal(procs.length, 1, JSON.stringify(procs));
  assert.equal(procs[0].pid, 100);
  assert.equal(procs[0].innerPid, 103);
  assert.equal(procs[0].rssKb, 300000);
});

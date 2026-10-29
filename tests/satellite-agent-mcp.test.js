// The satellite's MCP endpoint and lazy add-on MCP children (SAT-6, spec §5.2, §7.0 item 4,
// §7.3, §9.3): POST /satellite/v1/mcp/<bundle> is a stateless JSON MCP endpoint, signed whole;
// tools/list answers from tool_cache (filled at install, refreshed on a version change) without
// a child; tools/call starts the bundle's stdio child on first use, shares it between callers,
// stops it after the idle time (SIGTERM, SIGKILL after the grace), never runs more than two, and
// admits a child only above the MemAvailable floor. The caller in _meta is the signed caller,
// never the client's; results are text only and capped at 256 KiB.
// The child is tests/fixtures/sat-fake-mcp-server.mjs; docker is never used (no compose).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";

const CROW_HOME = mkdtempSync(join(tmpdir(), "satmcp-crow-"));
process.env.CROW_HOME = CROW_HOME;
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "satmcp-data-"));
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
actAsServe();

const P = await import("../servers/shared/satellite-protocol.js");
const { satelliteFetch } = await import("../servers/gateway/satellites/client.js");
const { issueCert } = await import("../servers/gateway/satellites/certs.js");
const { fakeIdentity } = await import("./helpers/fake-satellite.js");
const { startAgent } = await import("../servers/satellite/agent.js");
const { ensureSatelliteKey, writeCert, writePinned } = await import("../servers/satellite/keys.js");
const { readTextOrNull } = await import("../servers/satellite/status.js");
const H = await import("../servers/satellite/mcp-host.js");

const FIXTURE = join(import.meta.dirname, "fixtures", "sat-fake-mcp-server.mjs");
const dirs = [CROW_HOME, process.env.CROW_DATA_DIR];
const agents = [];
after(async () => {
  for (const a of agents) await a.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const identity = fakeIdentity();
const HOST = "satellite.example.ts.net";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pairedHome() {
  const home = tmp("satmcp-home-");
  const key = ensureSatelliteKey(home);
  const mgmt = P.generateKeypair();
  const c = issueCert({
    identity, instanceId: "inst-primary", primaryUrl: "https://crow.example.ts.net:8444",
    satellite_id: key.satellite_id, satellite_pubkey: key.ed25519_pub, mgmt_pubkey: mgmt.pubHex, now: Date.now(),
  });
  writePinned(home, {
    crow_id: c.payload.crow_id, root_pubkey: c.payload.root_pubkey, mgmt_pubkey: c.payload.mgmt_pubkey,
    primary_url: c.payload.primary_url, primary_instance_id: c.payload.primary_instance_id, target_sha: null,
  });
  writeCert(home, c);
  return { home, key, mgmt };
}

/** A compose-less MCP bundle in the agent's checkout whose server is the fake MCP fixture. */
function appBundle(home, id, { version = "1.0.0", memMb = 40, minRamMb = 120 } = {}) {
  const dir = join(home, "app", "bundles", id);
  mkdirSync(join(dir, "server"), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    id, name: id, version, type: "bundle",
    satellite: { min_ram_mb: minRamMb }, mcp: { mem_mb: memMb },
    server: { command: "node", args: ["server/index.js"], envKeys: [] },
  }, null, 2));
  writeFileSync(join(dir, "server", "index.js"), `import ${JSON.stringify(pathToFileURL(FIXTURE).href)};\n`);
}

const meminfo = (mb) => `MemTotal: 999424 kB\nMemAvailable: ${mb * 1024} kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n`;

async function boot({ s = pairedHome(), memMb = 800, bundles = ["demo"], mcpOptions = {}, setup } = {}) {
  for (const id of bundles) appBundle(s.home, id);
  if (setup) setup(s.home);
  const mem = { mb: memMb };
  const a = await startAgent({
    env: { CROW_HOME: s.home, CROW_SATELLITE_PORT: "0" }, out: () => {}, authLog: () => {}, sha: "a".repeat(40),
    mcpOptions,
    bundleDeps: {
      composeRunner: async () => { throw new Error("compose must not run"); },
      dockerRunner: async () => ({ stdout: "" }),
      readText: (p) => (p === "/proc/meminfo" ? meminfo(mem.mb) : readTextOrNull(p)),
      npmRunner: async () => { throw new Error("npm must not run"); },
    },
  });
  agents.push(a);
  return { ...s, a, mem };
}

const serveFetch = (port) => async (url, init = {}) => {
  const u = new URL(url);
  return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { ...init, headers: { ...init.headers, ...serveHeaders(null, "100.64.20.5") } });
};
const call = (t, method, path, body, { caller = "owner-local", maxBytes = 1024 * 1024 } = {}) => satelliteFetch(
  { id: t.a.satelliteId, tailnet_host: HOST, satellite_pubkey: t.a.key.ed25519_pub },
  { method, path: `/satellite/v1/${path}`, body, caller, maxBytes, timeoutMs: 30000, fetchImpl: serveFetch(t.a.port), mgmtKey: { ed25519_priv: t.mgmt.privHex } },
);
let rpcId = 1;
async function rpc(t, bundle, method, params = {}, opts = {}) {
  const id = rpcId++;
  const r = await call(t, "POST", `mcp/${bundle}`, { jsonrpc: "2.0", id, method, params }, opts);
  return { ...r, id };
}
const callTool = (t, bundle, name, args = {}, opts = {}) => rpc(t, bundle, "tools/call", { name, arguments: args, ...(opts.meta ? { _meta: opts.meta } : {}) }, opts);
const textOf = (r) => r.json.result.content.map((c) => c.text).join("");

async function waitFor(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function install(t, id) {
  const r = await call(t, "POST", "bundles/install", { id });
  assert.equal(r.status, 202, JSON.stringify(r.json));
  const job = await waitFor(async () => { const j = await call(t, "GET", `jobs/${r.json.job_id}`); return j.json.status !== "running" && j.json; }, "install job");
  assert.equal(job.status, "complete", JSON.stringify(job.log));
  return job;
}

/** A per-test child log ("start <pid>" / "term <pid>"), read through the env the child inherits. */
function childLog() {
  const p = join(tmp("satmcp-log-"), "children.log");
  writeFileSync(p, "");
  process.env.FAKE_MCP_LOG = p;
  return { path: p, lines: (kind) => readFileSync(p, "utf8").split("\n").filter((l) => l.startsWith(`${kind} `)) };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ── pure pieces ─────────────────────────────────────────────────────────────

test("callerMeta: the signed caller overwrites crow.dev/*; client crow.dev/* keys and progressToken are dropped", () => {
  const client = { "crow.dev/caller": "owner-local", "crow.dev/bot_id": "evil", "crow.dev/project": "p", keep: 1, progressToken: 7 };
  assert.deepEqual(H.callerMeta("bot:b1", client), { keep: 1, "crow.dev/caller": "bot", "crow.dev/bot_id": "b1" });
  assert.deepEqual(H.callerMeta("owner-remote", client), { keep: 1, "crow.dev/caller": "owner-remote" });
  assert.deepEqual(H.callerMeta("owner-local", null), { "crow.dev/caller": "owner-local" });
});

test("shapeResult: text kept, others dropped with one note; oversize → isError result too large (N KiB)", () => {
  const r = H.shapeResult({ content: [{ type: "text", text: "a" }, { type: "image", data: "x", mimeType: "image/png" }, { type: "audio", data: "y", mimeType: "audio/wav" }] }, 1);
  assert.equal(r.content.length, 2);
  assert.equal(r.content[0].text, "a");
  assert.ok(r.content.every((c) => c.type === "text"));
  assert.match(r.content[1].text, /2 non-text items dropped/);
  assert.ok(!r.content[1].text.includes("\n"));
  const big = H.shapeResult({ content: [{ type: "text", text: "x".repeat(P.RESULT_CAP_BYTES) }] }, 1);
  assert.equal(big.isError, true);
  assert.match(big.content[0].text, /^result too large \(\d+ KiB\)$/);
  // The cap is on the whole JSON-RPC answer: just under it passes.
  const ok = H.shapeResult({ content: [{ type: "text", text: "x".repeat(P.RESULT_CAP_BYTES - 200) }] }, 1);
  assert.equal(ok.isError, undefined);
});

test("admission constants are the spec's", () => {
  assert.equal(H.IDLE_STOP_MS, 600000);
  assert.equal(H.KILL_GRACE_MS, 5000);
  assert.equal(H.MAX_CHILDREN, 2);
  assert.equal(H.CHILD_NODE_OPTIONS, "--max-old-space-size=48");
  assert.equal(H.CHILD_FLOOR_MB, 32);
  assert.equal(H.LOW_MEMORY_TEXT, "This server is low on memory right now");
});

// ── over the signed endpoint ────────────────────────────────────────────────

test("install caches tools/list (+sha256) and stops the child; status lists it; tools/list is answered from cache without a child", async () => {
  const log = childLog();
  const t = await boot();
  await install(t, "demo");
  assert.equal(log.lines("start").length, 1, "the install started the child once");
  await waitFor(() => t.a.mcpHost.pids("demo").length === 0, "the caching child to stop");

  const row = t.a.db.prepare("SELECT * FROM tool_cache WHERE bundle = ?").get("demo");
  assert.equal(row.version, "1.0.0");
  const cached = JSON.parse(row.tools_json);
  assert.equal(row.sha256, P.sha256Hex(P.canonicalJson(cached)));
  assert.deepEqual(cached.map((x) => x.name).sort(), ["demo_big", "demo_echo", "demo_flood", "demo_mixed", "demo_progress", "demo_slow"]);

  const st = await call(t, "GET", "status");
  assert.deepEqual(st.json.tools, { demo: { version: "1.0.0", sha256: row.sha256 } });

  const r = await rpc(t, "demo", "tools/list");
  assert.equal(r.status, 200);
  assert.equal(r.json.id, r.id);
  assert.deepEqual(r.json.result.tools, cached, "exactly the cached tools");
  assert.equal(P.sha256Hex(P.canonicalJson(r.json.result.tools)), row.sha256);
  assert.equal(log.lines("start").length, 1, "tools/list never starts a child");
  assert.deepEqual(t.a.mcpHost.pids("demo"), []);

  const init = await rpc(t, "demo", "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "crow", version: "1" } });
  assert.equal(init.status, 200);
  assert.ok(init.json.result.capabilities.tools);
  assert.equal(log.lines("start").length, 1, "initialize never starts a child");
});

test("tools/call starts the child lazily with the 48 MB heap cap; concurrent callers share it; the signed caller overwrites _meta", async () => {
  const log = childLog();
  const t = await boot();
  await install(t, "demo");
  await waitFor(() => t.a.mcpHost.pids("demo").length === 0, "the caching child to stop");
  const starts = log.lines("start").length;

  const r = await callTool(t, "demo", "demo_echo", { x: "hi" }, {
    caller: "bot:b1", meta: { "crow.dev/caller": "owner-local", "crow.dev/bot_id": "evil", "crow.dev/other": "x", keep: "y" },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const e = JSON.parse(textOf(r));
  assert.equal(e.node_options, "--max-old-space-size=48");
  assert.deepEqual(e.args, { x: "hi" });
  assert.equal(e.meta["crow.dev/caller"], "bot");
  assert.equal(e.meta["crow.dev/bot_id"], "b1");
  assert.equal(e.meta["crow.dev/other"], undefined, "client-supplied crow.dev/* keys are dropped");
  assert.equal(e.meta.keep, "y");
  assert.equal(log.lines("start").length, starts + 1, "first call started the child");
  assert.deepEqual(t.a.mcpHost.pids("demo"), [e.pid]);

  const o = JSON.parse(textOf(await callTool(t, "demo", "demo_echo", {}, { caller: "owner-remote", meta: { "crow.dev/bot_id": "evil" } })));
  assert.equal(o.meta["crow.dev/caller"], "owner-remote");
  assert.equal(o.meta["crow.dev/bot_id"], undefined);
  assert.equal(o.pid, e.pid, "same child");

  const [s1, s2] = await Promise.all([callTool(t, "demo", "demo_slow", { ms: 300 }), callTool(t, "demo", "demo_slow", { ms: 300 }, { caller: "bot:b2" })]);
  assert.equal(textOf(s1), "slow done");
  assert.equal(textOf(s2), "slow done");
  assert.equal(log.lines("start").length, starts + 1, "concurrent callers share one child");
});

test("results: text only (non-text dropped with a note), 256 KiB cap, notifications dropped, unknown tools refused", async () => {
  childLog();
  const t = await boot();
  await install(t, "demo");

  const m = await callTool(t, "demo", "demo_mixed");
  assert.equal(m.json.result.content.length, 2);
  assert.ok(m.json.result.content.every((c) => c.type === "text"));
  assert.equal(m.json.result.content[0].text, "kept");
  assert.match(m.json.result.content[1].text, /2 non-text items dropped/);

  const ok = await callTool(t, "demo", "demo_big", { bytes: 1000 });
  assert.equal(textOf(ok).length, 1000);
  const big = await callTool(t, "demo", "demo_big", { bytes: 300000 });
  assert.equal(big.status, 200);
  assert.equal(big.json.result.isError, true);
  assert.match(textOf(big), /^result too large \(29\d KiB\)$/);

  const p = await callTool(t, "demo", "demo_progress", {}, { meta: { progressToken: "tok" } });
  assert.equal(p.status, 200);
  assert.equal(p.json.jsonrpc, "2.0");
  assert.equal(p.json.id, p.id, "one JSON-RPC answer, no notifications");
  assert.equal(textOf(p), "progress done");

  const u = await callTool(t, "demo", "nope_tool");
  assert.ok(u.json.error, "a tool that is not in the cached list is refused");
});

test("GET and DELETE on the MCP endpoint are 405; unknown or MCP-less bundles 404", async () => {
  childLog();
  const t = await boot();
  await install(t, "demo");
  for (const method of ["GET", "DELETE"]) {
    const r = await call(t, method, "mcp/demo");
    assert.equal(r.status, 405, method);
    assert.equal(r.json.error, "method_not_allowed");
  }
  assert.equal((await rpc(t, "ghost", "tools/list")).status, 404);
  assert.equal((await rpc(t, "BAD!", "tools/list")).status, 404);
});

test("idle stop: the child gets SIGTERM after the idle time; a child that ignores it is SIGKILLed after the grace", async () => {
  const log = childLog();
  const t = await boot({ mcpOptions: { idleMs: 300, killGraceMs: 400 } });
  await install(t, "demo");
  await waitFor(() => t.a.mcpHost.pids("demo").length === 0, "the caching child to stop");
  const pid = JSON.parse(textOf(await callTool(t, "demo", "demo_echo"))).pid;
  await waitFor(() => !alive(pid) && t.a.mcpHost.pids("demo").length === 0, "idle stop");
  assert.ok(log.lines("term").some((l) => l === `term ${pid}`), "stopped with SIGTERM");

  process.env.FAKE_MCP_IGNORE_TERM = "1";
  try {
    const pid2 = JSON.parse(textOf(await callTool(t, "demo", "demo_echo"))).pid;
    const t0 = Date.now();
    await waitFor(() => log.lines("term").some((l) => l === `term ${pid2}`), "SIGTERM to the stubborn child");
    assert.ok(alive(pid2), "still alive right after SIGTERM");
    await waitFor(() => !alive(pid2), "SIGKILL after the grace");
    assert.ok(Date.now() - t0 >= 300, "the grace was waited");
  } finally {
    delete process.env.FAKE_MCP_IGNORE_TERM;
  }
});

test("at most two children: a third bundle waits for none, evicts an idle child, and is refused while both are busy", async () => {
  childLog();
  const t = await boot({ bundles: ["demo", "demo-b", "demo-c"] });
  for (const id of ["demo", "demo-b", "demo-c"]) await install(t, id);
  await waitFor(() => ["demo", "demo-b", "demo-c"].every((id) => t.a.mcpHost.pids(id).length === 0), "caching children to stop");

  const slowA = callTool(t, "demo", "demo_slow", { ms: 1500 });
  const slowB = callTool(t, "demo-b", "demo_slow", { ms: 1500 });
  await waitFor(() => t.a.mcpHost.pids("demo").length && t.a.mcpHost.pids("demo-b").length, "two children up");
  const busy = await callTool(t, "demo-c", "demo_echo");
  assert.equal(busy.json.result.isError, true);
  assert.equal(textOf(busy), H.BUSY_TEXT);
  await Promise.all([slowA, slowB]);

  const c = await callTool(t, "demo-c", "demo_echo");
  assert.equal(c.json.result.isError, undefined, JSON.stringify(c.json));
  const running = ["demo", "demo-b", "demo-c"].filter((id) => t.a.mcpHost.pids(id).length);
  assert.equal(running.length, 2, "an idle child was stopped to make room");
  assert.ok(running.includes("demo-c"));
});

test("admission: own child needs MemAvailable ≥ 32 MB; a second bundle's child needs mcp.mem_mb + 32", async () => {
  childLog();
  const t = await boot({ bundles: ["demo", "demo-b"] });
  await install(t, "demo");
  await install(t, "demo-b");
  await waitFor(() => !t.a.mcpHost.pids("demo").length && !t.a.mcpHost.pids("demo-b").length, "caching children to stop");

  t.mem.mb = 31;
  const low = await callTool(t, "demo", "demo_echo");
  assert.equal(low.json.result.isError, true);
  assert.equal(textOf(low), "This server is low on memory right now");
  assert.deepEqual(t.a.mcpHost.pids("demo"), [], "no child was started");

  t.mem.mb = 32;
  assert.equal((await callTool(t, "demo", "demo_echo")).json.result.isError, undefined);

  t.mem.mb = 71; // demo-b's mcp.mem_mb is 40: 40 + 32 = 72
  const second = await callTool(t, "demo-b", "demo_echo");
  assert.equal(textOf(second), "This server is low on memory right now");
  t.mem.mb = 72;
  assert.equal((await callTool(t, "demo-b", "demo_echo")).json.result.isError, undefined);
});

test("the install gate counts a running MCP child's RSS in its bundle's current use", async () => {
  childLog();
  const t = await boot({ bundles: ["demo"], memMb: 300 });
  appBundle(t.home, "demo-next", { minRamMb: 100 });
  await install(t, "demo"); // reservation 120
  await waitFor(() => !t.a.mcpHost.pids("demo").length, "the caching child to stop");
  // 300 − 96 − headroom(120 − 0) = 84 < 100: refused while the child is down.
  const refused = await call(t, "POST", "bundles/install", { id: "demo-next" });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error, "insufficient_memory");
  // With the child up (> 16 MB RSS) the headroom shrinks below 104: the same install fits.
  await callTool(t, "demo", "demo_echo");
  const rss = Number(/^VmRSS:\s+(\d+)/m.exec(readFileSync(`/proc/${t.a.mcpHost.pids("demo")[0]}/status`, "utf8"))[1]) / 1024;
  assert.ok(rss > 16, `child RSS ${rss} MB`);
  const fits = await call(t, "POST", "bundles/install", { id: "demo-next" });
  assert.equal(fits.status, 202, JSON.stringify(fits.json));
});

test("a bundle version change refreshes the cache at boot; uninstall drops it", async () => {
  childLog();
  const t = await boot();
  await install(t, "demo");
  const before = t.a.db.prepare("SELECT sha256 FROM tool_cache WHERE bundle = 'demo'").get().sha256;
  await t.a.close();

  const inst = join(t.home, "installed.json");
  const list = JSON.parse(readFileSync(inst, "utf8"));
  list.find((b) => b.id === "demo").version = "1.1.0";
  writeFileSync(inst, JSON.stringify(list));
  process.env.FAKE_MCP_VARIANT = "v2";
  let t2;
  try {
    t2 = await boot({ s: { home: t.home, key: t.key, mgmt: t.mgmt }, bundles: [] });
    const st = await waitFor(async () => { const s = await call(t2, "GET", "status"); return s.json.tools?.demo?.version === "1.1.0" && s.json; }, "the refreshed cache");
    assert.notEqual(st.tools.demo.sha256, before);
    const r = await rpc(t2, "demo", "tools/list");
    assert.ok(r.json.result.tools.some((x) => x.name === "demo_new"));
  } finally {
    delete process.env.FAKE_MCP_VARIANT;
  }

  const u = await call(t2, "POST", "bundles/uninstall", { id: "demo" });
  await waitFor(async () => (await call(t2, "GET", `jobs/${u.json.job_id}`)).json.status === "complete", "uninstall");
  assert.equal(t2.a.db.prepare("SELECT COUNT(*) AS n FROM tool_cache WHERE bundle = 'demo'").get().n, 0);
  assert.deepEqual((await call(t2, "GET", "status")).json.tools, {});
  assert.ok(existsSync(inst));
});

// ── review fixes (round 1) ──────────────────────────────────────────────────

test("a child flooding stdout without a newline is SIGKILLed at 2 × the cap; the call answers isError; the agent stays bounded", async () => {
  childLog();
  const t = await boot();
  await install(t, "demo");
  const pid = JSON.parse(textOf(await callTool(t, "demo", "demo_echo"))).pid;
  globalThis.gc?.();
  const before = process.memoryUsage();
  const r = await callTool(t, "demo", "demo_flood", { mb: 64 });
  assert.equal(r.status, 200);
  assert.equal(r.json.result.isError, true);
  assert.equal(textOf(r), H.OVERFLOW_TEXT);
  await waitFor(() => !alive(pid), "the flooding child to be killed");
  assert.deepEqual(t.a.mcpHost.pids("demo"), []);
  const after = process.memoryUsage();
  const grewMb = (after.rss - before.rss) / (1024 * 1024);
  assert.ok(grewMb < 32, `the agent's RSS grew ${grewMb.toFixed(1)} MB for a 64 MB flood`);
  assert.ok((after.heapUsed - before.heapUsed) / (1024 * 1024) < 32, "heap stays bounded");
  assert.equal(H.STDOUT_BACKLOG_MAX, 2 * P.RESULT_CAP_BYTES);
  // The next call starts a fresh child.
  assert.equal((await callTool(t, "demo", "demo_echo")).json.result.isError, undefined);
});

test("BoundedStdioTransport counts bytes since the last newline across chunks", () => {
  const tr = new H.BoundedStdioTransport({ command: "true", maxBacklog: 100 });
  const got = [];
  tr.onmessage = (m) => got.push(m);
  tr._data(Buffer.from('{"jsonrpc":"2.0",'));
  tr._data(Buffer.from('"id":1,"result":{}}\n{"jsonrpc"'));
  assert.equal(got.length, 1, "a message split over chunks is framed");
  assert.equal(tr.overflowed, false);
  const t2 = new H.BoundedStdioTransport({ command: "true", maxBacklog: 10 });
  t2._data(Buffer.from("12345678"));
  assert.equal(t2.overflowed, false);
  t2._data(Buffer.from("90abc\n"));
  assert.equal(t2.overflowed, true, "8 + 5 bytes before the newline is over 10");
});

test("a tool list over the cap is never cached: the install job reports it and no row is written", async () => {
  childLog();
  process.env.FAKE_MCP_VARIANT = "huge";
  try {
    const t = await boot();
    const job = await install(t, "demo");
    assert.ok(job.log.some((l) => /tool list too large \(\d+ KiB, the cap is 256 KiB\); not cached/.test(l)), JSON.stringify(job.log));
    assert.equal(t.a.db.prepare("SELECT COUNT(*) AS n FROM tool_cache WHERE bundle = 'demo'").get().n, 0);
    assert.deepEqual((await call(t, "GET", "status")).json.tools, {});
    await waitFor(() => t.a.mcpHost.pids("demo").length === 0, "the caching child to stop");
  } finally {
    delete process.env.FAKE_MCP_VARIANT;
  }
});

test("paused (an update installing dependencies): children stop, calls answer busy, tools/list still answers; resume restores", async () => {
  childLog();
  const t = await boot();
  await install(t, "demo");
  const pid = JSON.parse(textOf(await callTool(t, "demo", "demo_echo"))).pid;
  await t.a.mcpHost.pause();
  assert.ok(!alive(pid), "the running child was stopped");
  const r = await callTool(t, "demo", "demo_echo");
  assert.equal(r.json.result.isError, true);
  assert.equal(textOf(r), H.BUSY_TEXT);
  assert.deepEqual(t.a.mcpHost.pids("demo"), [], "no child starts while paused");
  assert.ok((await rpc(t, "demo", "tools/list")).json.result.tools.length > 0, "the cache still answers");
  t.a.mcpHost.resume();
  assert.equal((await callTool(t, "demo", "demo_echo")).json.result.isError, undefined);
});

test("batches are supported: each tools/call's _meta is overwritten with the signed caller; an oversize batch answer is JSON-RPC errors in a signed 200", async () => {
  childLog();
  const t = await boot();
  await install(t, "demo");
  const evil = { "crow.dev/caller": "owner-local", "crow.dev/bot_id": "evil" };
  const batch = [1, 2].map((id) => ({ jsonrpc: "2.0", id: 9000 + id, method: "tools/call", params: { name: "demo_echo", arguments: {}, _meta: evil } }));
  const r = await call(t, "POST", "mcp/demo", batch, { caller: "bot:b9" });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json));
  assert.deepEqual(r.json.map((m) => m.id).sort(), [9001, 9002]);
  for (const m of r.json) {
    const e = JSON.parse(m.result.content[0].text);
    assert.equal(e.meta["crow.dev/caller"], "bot");
    assert.equal(e.meta["crow.dev/bot_id"], "b9");
  }

  const big = [1, 2].map((id) => ({ jsonrpc: "2.0", id: 9100 + id, method: "tools/call", params: { name: "demo_big", arguments: { bytes: 200000 } } }));
  const o = await call(t, "POST", "mcp/demo", big);
  assert.equal(o.status, 200);
  assert.ok(Array.isArray(o.json));
  assert.deepEqual(o.json.map((m) => m.id).sort(), [9101, 9102]);
  for (const m of o.json) {
    assert.equal(m.jsonrpc, "2.0");
    assert.match(m.error.message, /^result too large \(\d+ KiB\)$/);
  }
  assert.deepEqual(H.oversizeAnswer({ jsonrpc: "2.0", id: 5, method: "tools/call" }, 300), { jsonrpc: "2.0", id: 5, error: { code: -32603, message: "result too large (300 KiB)" } });
});

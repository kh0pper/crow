// Satellite install gate and compose rules (SAT-3, spec §7.0 items 2–3, §7.1, K5). Pure
// arithmetic and model checks; every /proc, cgroup and docker read is injected.
import { test } from "node:test";
import assert from "node:assert/strict";

const G = await import("../servers/satellite/gate.js");
const { checkSatelliteComposeModel } = await import("../servers/satellite/compose-rules.js");

const MB = 1024 * 1024;
const meminfo = (availMb) => `MemTotal:  999424 kB\nMemFree:  10000 kB\nMemAvailable: ${availMb * 1024} kB\nSwapTotal: 4000000 kB\nSwapFree: 4000000 kB\n`;
const sat = (min, mem = 40, extra = {}) => ({ id: "x", satellite: { min_ram_mb: min }, mcp: { mem_mb: mem }, ...extra });

// ── manifest eligibility ─────────────────────────────────────────────────────

test("manifest: not satellite-eligible unless it says so; satellite:true without min_ram_mb is 'not measured'", () => {
  assert.equal(G.satelliteManifestProblem({ id: "a" }).code, "not_satellite");
  assert.equal(G.satelliteManifestProblem({ id: "a", satellite: false }).code, "not_satellite");
  const unmeasured = G.satelliteManifestProblem({ id: "a", satellite: true });
  assert.equal(unmeasured.code, "not_measured");
  assert.match(unmeasured.reason, /not measured for small servers yet/);
  assert.equal(G.satelliteManifestProblem({ id: "a", satellite: { min_ram_mb: "200" }, mcp: { mem_mb: 40 } }).code, "not_measured");
  assert.equal(G.satelliteManifestProblem(sat(200)), null);
  assert.equal(G.satelliteRamMb(sat(200)), 200);
  assert.equal(G.satelliteRamMb({ satellite: true, requires: { min_ram_mb: 64 } }), null, "the general min_ram_mb is never used on satellites");
});

test("manifest: GPU, model, desktop and browser bundles are never satellite bundles", () => {
  for (const m of [
    sat(100, 40, { host_grants: { gpu: true } }),
    sat(100, 40, { type: "model" }),
    sat(100, 40, { category: "ai-models" }),
    sat(100, 40, { id: "browser" }),
    sat(100, 40, { requires: { gpu: true } }),
    sat(100, 40, { category: "desktop" }),
  ]) assert.equal(G.satelliteManifestProblem(m)?.code, "never_satellite", JSON.stringify(m));
});

// ── readers ──────────────────────────────────────────────────────────────────

test("readers: MemAvailable in MB (swap ignored), cgroup memory.current per container, VmRSS", () => {
  assert.equal(G.memAvailableMb(meminfo(447)), 447);
  assert.equal(G.memAvailableMb("MemTotal: 1 kB\n"), null);
  assert.equal(G.parseVmRssMb("Name: node\nVmRSS:\t   51200 kB\n"), 50);
  assert.equal(G.parseVmRssMb("Name: x\n"), 0);
});

test("current use = Σ container memory.current of the compose project + the MCP child's RSS", async () => {
  const calls = [];
  const files = {
    [`/sys/fs/cgroup/system.slice/docker-${"a".repeat(64)}.scope/memory.current`]: String(100 * MB),
    [`/sys/fs/cgroup/docker/${"b".repeat(64)}/memory.current`]: String(20 * MB), // the cgroupfs driver's layout
    "/proc/4242/status": "VmRSS:\t  30720 kB\n",
  };
  const use = await G.bundleCurrentUseMb({
    project: "gitea",
    dockerRunner: async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: `${"a".repeat(64)}\n${"b".repeat(64)}\nnot-an-id\n` }; },
    readText: (p) => files[p] ?? null,
    mcpPids: () => [4242],
  });
  assert.equal(use, 150);
  assert.deepEqual(calls[0].slice(0, 4), ["docker", "ps", "-q", "--no-trunc"]);
  assert.ok(calls[0].includes("label=com.docker.compose.project=gitea"));
});

test("current use: docker unreachable counts 0 (the whole reservation stays held)", async () => {
  const use = await G.bundleCurrentUseMb({ project: "p", dockerRunner: async () => { throw new Error("no docker"); }, readText: () => null, mcpPids: () => [] });
  assert.equal(use, 0);
});

// ── the arithmetic ───────────────────────────────────────────────────────────

test("gate: MemAvailable − 96 − Σ headroom ≥ min_ram_mb", () => {
  assert.equal(G.SAT_HOST_RESERVE_MB, 96);
  assert.deepEqual(G.gateDecision({ needMb: 240, memAvailableMb: 336, installed: [] }), { ok: true, need_mb: 240, free_mb: 240 });
  const r = G.gateDecision({ needMb: 241, memAvailableMb: 336, installed: [] });
  assert.equal(r.ok, false);
  assert.equal(r.code, "insufficient_memory");
  assert.equal(r.shortfall_mb, 1);
  assert.match(r.reason, /short by 1 MB/);
});

test("gate: two installed bundles, headroom = max(0, reservation − use), never double counted", () => {
  // A reserves 200 and uses 150 (MemAvailable already reflects the 150): only 50 more is held.
  // B reserves 100 but uses 120: it holds nothing more (max 0, not −20).
  const installed = [{ id: "a", reservationMb: 200, useMb: 150 }, { id: "b", reservationMb: 100, useMb: 120 }];
  const ok = G.gateDecision({ needMb: 100, memAvailableMb: 246, installed });
  assert.deepEqual(ok, { ok: true, need_mb: 100, free_mb: 100 });
  const no = G.gateDecision({ needMb: 101, memAvailableMb: 246, installed });
  assert.equal(no.ok, false);
  assert.equal(no.shortfall_mb, 1);
  // Subtracting full reservations would have refused at 300 short.
  assert.equal(G.gateDecision({ needMb: 100, memAvailableMb: 246, installed: installed.map((b) => ({ ...b, useMb: 0 })) }).shortfall_mb, 250);
});

test("gate: a bundle stopped right now still holds its whole reservation", () => {
  const r = G.gateDecision({ needMb: 4, memAvailableMb: 300, installed: [{ id: "a", reservationMb: 200, useMb: 0 }] });
  assert.deepEqual(r, { ok: true, need_mb: 4, free_mb: 4 });
  assert.equal(G.gateDecision({ needMb: 5, memAvailableMb: 300, installed: [{ id: "a", reservationMb: 200, useMb: 0 }] }).shortfall_mb, 1);
});

test("runGate: reads meminfo + every installed satellite bundle's use, skips the bundle being installed", async () => {
  const manifests = { a: sat(200), self: sat(64), plain: { id: "plain" } };
  const r = await G.runGate({
    manifest: { ...sat(100), id: "self" },
    installed: [{ id: "a", compose_project: "a" }, { id: "self" }, { id: "plain" }],
    manifestFor: (id) => manifests[id],
    readText: (p) => (p === "/proc/meminfo" ? meminfo(400) : null),
    currentUseMb: async (b) => (b.id === "a" ? 180 : 999),
  });
  // 400 − 96 − (200 − 180) = 284 ≥ 100.
  assert.deepEqual(r, { ok: true, need_mb: 100, free_mb: 284 });
  const r2 = await G.runGate({ manifest: { id: "n", satellite: true }, installed: [], manifestFor: () => null, readText: () => meminfo(900), currentUseMb: async () => 0 });
  assert.equal(r2.code, "not_measured");
  const r3 = await G.runGate({ manifest: sat(10), installed: [], manifestFor: () => null, readText: () => null, currentUseMb: async () => 0 });
  assert.equal(r3.code, "memory_unknown");
});

// ── compose rules ────────────────────────────────────────────────────────────

const svc = (over = {}) => ({ image: "x:1", mem_limit: "536870912", oom_score_adj: 500, ports: [{ target: 3000, published: "3040", host_ip: "127.0.0.1", protocol: "tcp" }], ...over });
const model = (s, extra = {}) => ({ name: "p", services: { app: s }, ...extra });

test("compose rules: the G1 shape passes", () => {
  assert.deepEqual(checkSatelliteComposeModel(model(svc())), { valid: true });
  assert.deepEqual(checkSatelliteComposeModel(model(svc({ ports: undefined, mem_limit: "512m" }))), { valid: true });
});

test("compose rules: host network, privileged, docker socket, non-loopback ports are refused", () => {
  const cases = [
    [svc({ network_mode: "host" }), /host network/],
    [svc({ privileged: true }), /privileged/],
    [svc({ volumes: [{ type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock", read_only: true }] }), /Docker socket/],
    [svc({ volumes: [{ type: "bind", source: "/run/docker.sock", target: "/s" }] }), /Docker socket/],
    [svc({ use_api_socket: true }), /Docker socket/],
    [svc({ ports: [{ target: 3000, published: "3040", protocol: "tcp" }] }), /127\.0\.0\.1/],
    [svc({ ports: [{ target: 3000, published: "3040", host_ip: "0.0.0.0" }] }), /127\.0\.0\.1/],
    [svc({ ports: [{ target: 3000, published: "3040", host_ip: "100.64.20.7" }] }), /127\.0\.0\.1/],
    [svc({ ports: [{ target: 3000, host_ip: "::1" }] }), /127\.0\.0\.1/],
  ];
  for (const [s, re] of cases) {
    const r = checkSatelliteComposeModel(model(s));
    assert.equal(r.valid, false, JSON.stringify(s));
    assert.match(r.reason, re);
  }
  const hostNet = checkSatelliteComposeModel(model(svc(), { networks: { lan: { driver: "macvlan" } } }));
  assert.equal(hostNet.valid, false);
  assert.match(hostNet.reason, /host network/);
});

test("compose rules: mem_limit required, oom_score_adj ≥ 300 required", () => {
  for (const [s, re] of [
    [svc({ mem_limit: undefined }), /mem_limit/],
    [svc({ mem_limit: "0" }), /mem_limit/],
    [svc({ mem_limit: "lots" }), /mem_limit/],
    [svc({ oom_score_adj: undefined }), /oom_score_adj/],
    [svc({ oom_score_adj: 299 }), /oom_score_adj/],
    [svc({ oom_score_adj: "500" }), /oom_score_adj/],
  ]) {
    const r = checkSatelliteComposeModel(model(s));
    assert.equal(r.valid, false, JSON.stringify(s));
    assert.match(r.reason, re);
  }
  assert.equal(checkSatelliteComposeModel(model(svc({ oom_score_adj: 300 }))).valid, true);
  assert.equal(checkSatelliteComposeModel({ name: "p", services: {} }).valid, false, "a model with no services is not a bundle");
  assert.equal(checkSatelliteComposeModel(null).valid, false);
});

/**
 * published-ports-signal.test.js — plan PR S5a.
 *
 * The snapshot reader + classifier (published-ports.js) and the
 * `publishedPorts` nest signal, driven by fixtures under
 * tests/fixtures/published-ports/. Every address is a documentation
 * placeholder (192.0.2.x / 198.51.100.x / 100.64.20.x / fd7a:115c:a1e0::20 /
 * 172.17.0.1 for a Docker bridge).
 *
 * What the tests pin, in the plan's order: the snapshot states (missing,
 * unreadable, malformed, future-dated, stale), the severity table (wildcard,
 * empty host, bridge, LAN, tailnet with/without the rule, port-only = fenced,
 * loopback silent), the Docker floor, the facts/conf hash mismatch, the rule
 * `-d` mismatch, fail-closed on an unknown shape, the M4 blind-spot list, the
 * M6 allowlist (first-party version-pinned only), the faster-whisper :8005 and
 * kokoro :8880 overlay shapes, the settings key staying local, and the Spanish
 * strings.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DOCKER_FLOOR,
  PUBLISHED_PORTS_ALLOWLIST_KEY,
  classifyHostIp,
  inspectPublishedPorts,
  loadPublishSnapshot,
  parseAllowlistSetting,
  parseDockerVersion,
  parseFenceRule,
  readManifestAllowlist,
} from "../servers/gateway/dashboard/panels/nest/published-ports.js";
import {
  collectHealthSignals,
  invalidateHealthCache,
  _setDiskReader,
  _setTailscaleReader,
} from "../servers/gateway/dashboard/panels/nest/health-signals.js";
import { t, translations } from "../servers/gateway/dashboard/shared/i18n.js";
import {
  SYNC_ALLOWLIST,
  INSTANCE_SCOPE_KEYS,
  isSyncable,
  isInstanceScope,
} from "../servers/gateway/dashboard/settings/sync-allowlist.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/published-ports/", import.meta.url));

// Sibling signals are neutralized exactly as tests/external-engines-signal.test.js
// does, so a `warn` under test can only come from publishedPorts.
process.env.CROW_BACKUP_DIR = "/tmp/__crow_test_nonexistent_backup_dir__";
_setTailscaleReader(() => { throw new Error("no tailscale"); });
_setDiskReader(() => "Avail Size\n500000M 1000000M\n");
delete process.env.MINIO_ENDPOINT;
delete process.env.CROW_DASHBOARD_PUBLIC;
delete process.env.CROW_CSRF_STRICT;

const NOW = Date.parse("2026-11-04T12:00:00Z");
const MIN = 60_000;

// An empty bundle-source dir for both sides, so a host that happens to have a
// bundle installed can never change what these tests read.
const NO_BUNDLES = mkdtempSync(join(tmpdir(), "crow-pp-nobundles-"));

const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

/** Write a snapshot with taken_at set relative to NOW; returns its path. */
function writeSnapshot(snapshot, { ageMs = 0, nowMs = NOW } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "crow-published-ports-"));
  const path = join(dir, "snapshot.json");
  writeFileSync(path, JSON.stringify({ ...snapshot, taken_at: new Date(nowMs - ageMs).toISOString() }));
  return path;
}

function auditOf(snapshot, opts = {}) {
  const { ageMs = 0, nowMs = NOW, ...rest } = opts;
  return inspectPublishedPorts({
    nowMs,
    snapshotPath: writeSnapshot(snapshot, { ageMs, nowMs }),
    repoBundlesDir: NO_BUNDLES,
    installedBundlesDir: NO_BUNDLES,
    ...rest,
  });
}

/** A minimal snapshot around one container's port bindings. */
function snapshotWith(portBindings, { networkMode = "default", labels = {}, rawRules = { v4: [], v6: [] }, docker = { version: "28.0.1" }, fence = {}, extraContainers = [] } = {}) {
  return {
    docker,
    fence,
    tailscale: { v4: "100.64.20.5", v6: "fd7a:115c:a1e0::20" },
    containers: [
      { id: "001122334455", name: "crow-example", labels, host_config: { network_mode: networkMode, port_bindings: portBindings }, networks: ["bridge"] },
      ...extraContainers,
    ],
    listeners: [],
    raw_rules: rawRules,
  };
}

const addressedRule = (addr, port, extra = "") =>
  `-A CROW-ENGINE-FENCE -d ${addr} -p tcp -m tcp --dport ${port} ! -i tailscale0 -m comment --comment "crow-engine-fence:e1:g4" -j DROP${extra}`;
const portOnlyRule = (port) =>
  `-A CROW-ENGINE-FENCE -p tcp -m tcp --dport ${port} -m addrtype --dst-type LOCAL ! -i tailscale0 -m comment --comment "crow-engine-fence:e1:g4:portonly" -j DROP`;

const db = { async execute() { return { rows: [] }; } };

function allowlistDb(raw) {
  return {
    async execute({ sql, args }) {
      if (typeof sql === "string" && sql.includes("dashboard_settings") && Array.isArray(args) && args[0] === PUBLISHED_PORTS_ALLOWLIST_KEY) {
        return { rows: [{ value: raw }] };
      }
      return { rows: [] };
    },
  };
}

async function signalOf(snapshotPath, { nowMs = NOW, lang = "en", allowlistRaw = null, publishedPorts = {} } = {}) {
  invalidateHealthCache();
  const result = await collectHealthSignals(
    allowlistRaw == null ? db : allowlistDb(allowlistRaw),
    { now: () => nowMs, lang, publishedPorts: { snapshotPath, repoBundlesDir: NO_BUNDLES, installedBundlesDir: NO_BUNDLES, ...publishedPorts } },
  );
  return {
    result,
    card: result.details.find((d) => d.id === "publishedPorts"),
    issues: result.issues.filter((i) => i.id === "publishedPorts" || i.id.startsWith("published-ports:")),
  };
}

// ─── Snapshot reader ────────────────────────────────────────────────────────

test("snapshot: missing file → status missing, no rows, never thrown", () => {
  const path = join(mkdtempSync(join(tmpdir(), "crow-pp-missing-")), "absent.json");
  const loaded = loadPublishSnapshot({ snapshotPath: path, nowMs: NOW });
  assert.equal(loaded.status, "missing");
  assert.equal(loaded.snapshot, null);
});

test("snapshot: unreadable file → status unreadable", () => {
  const loaded = loadPublishSnapshot({
    snapshotPath: "/nonexistent/snapshot.json",
    nowMs: NOW,
    readFile: () => { const err = new Error("denied"); err.code = "EACCES"; throw err; },
  });
  assert.equal(loaded.status, "unreadable");
});

test("snapshot: malformed JSON → status malformed", () => {
  const path = join(FIXTURES, "malformed.json");
  assert.equal(loadPublishSnapshot({ snapshotPath: path, nowMs: NOW }).status, "malformed");
});

test("snapshot: a document without taken_at is malformed (never ok)", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-pp-notime-"));
  const path = join(dir, "snapshot.json");
  writeFileSync(path, JSON.stringify({ containers: [] }));
  assert.equal(loadPublishSnapshot({ snapshotPath: path, nowMs: NOW }).status, "malformed");
});

test("snapshot: older than 15 minutes → stale", () => {
  const path = writeSnapshot(fixture("fenced-tailnet.json"), { ageMs: 16 * MIN });
  assert.equal(loadPublishSnapshot({ snapshotPath: path, nowMs: NOW }).status, "stale");
});

test("snapshot: taken_at in the future → future", () => {
  const path = writeSnapshot(fixture("fenced-tailnet.json"), { ageMs: -60 * MIN });
  assert.equal(loadPublishSnapshot({ snapshotPath: path, nowMs: NOW }).status, "future");
});

test("snapshot: the path comes from CROW_PUBLISH_SNAPSHOT", () => {
  const saved = process.env.CROW_PUBLISH_SNAPSHOT;
  process.env.CROW_PUBLISH_SNAPSHOT = "/tmp/__crow_test_publish_snapshot_xyz__.json";
  try {
    assert.equal(loadPublishSnapshot({ nowMs: NOW }).status, "missing");
    assert.equal(loadPublishSnapshot({ nowMs: NOW }).path, "/tmp/__crow_test_publish_snapshot_xyz__.json");
  } finally {
    if (saved == null) delete process.env.CROW_PUBLISH_SNAPSHOT;
    else process.env.CROW_PUBLISH_SNAPSHOT = saved;
  }
});

// ─── Rule parser ─────────────────────────────────────────────────────────────

test("rule parser: addressed and port-only spellings, and non-fence lines", () => {
  const addressed = parseFenceRule(addressedRule("100.64.20.5/32", 8003));
  assert.equal(addressed.port, 8003);
  assert.equal(addressed.addr, "100.64.20.5");
  assert.equal(addressed.portOnly, false);
  assert.equal(addressed.iface, "tailscale0");
  assert.equal(addressed.id, "e1");

  const portOnly = parseFenceRule(portOnlyRule(8003));
  assert.equal(portOnly.portOnly, true);
  assert.equal(portOnly.addr, null);
  assert.equal(portOnly.dstTypeLocal, true);

  assert.equal(parseFenceRule("-A PREROUTING -j CROW-ENGINE-FENCE"), null);
  assert.equal(parseFenceRule("-A DOCKER-USER -p tcp -m tcp --dport 8030 -j RETURN"), null);
  assert.equal(parseFenceRule(""), null);
});

test("an untagged DROP, or one without an interface pin, does not count as a fence", () => {
  const untagged = "-A CROW-ENGINE-FENCE -d 100.64.20.5/32 -p tcp -m tcp --dport 8003 -j DROP";
  const noIface = "-A CROW-ENGINE-FENCE -d 100.64.20.5/32 -p tcp -m tcp --dport 8003 -m comment --comment \"crow-engine-fence:e1:g4\" -j DROP";
  assert.equal(parseFenceRule(untagged), null, "another program's DROP is not our fence");
  assert.equal(parseFenceRule(noIface).iface, null);

  const audit = auditOf(snapshotWith(
    { "8003/tcp": [{ HostIp: "100.64.20.5", HostPort: "8003" }] },
    { rawRules: { v4: [untagged, noIface], v6: [] } },
  ));
  assert.equal(audit.publishes[0].severity, "warn");
  assert.equal(audit.publishes[0].code, "unfenced");
});

// ─── Severity table ──────────────────────────────────────────────────────────

test("HostIp spellings classify as the plan's table says", () => {
  assert.equal(classifyHostIp("").kind, "empty");
  assert.equal(classifyHostIp("0.0.0.0").kind, "wildcard");
  assert.equal(classifyHostIp("::").kind, "wildcard");
  assert.equal(classifyHostIp("[::]").kind, "wildcard");
  assert.equal(classifyHostIp("::ffff:0.0.0.0").kind, "wildcard");
  assert.equal(classifyHostIp("*").kind, "wildcard");
  assert.equal(classifyHostIp("127.0.0.1").kind, "loopback");
  assert.equal(classifyHostIp("::1").kind, "loopback");
  assert.equal(classifyHostIp("::ffff:127.0.0.1").kind, "loopback");
  assert.equal(classifyHostIp("100.64.20.5").kind, "tailnet");
  assert.equal(classifyHostIp("fd7a:115c:a1e0::20").kind, "tailnet");
  assert.equal(classifyHostIp("172.17.0.1").kind, "bridge");
  assert.equal(classifyHostIp("192.0.2.10").kind, "lan");
  assert.equal(classifyHostIp("198.51.100.7").kind, "lan");
  assert.equal(classifyHostIp("some-host-name").kind, "unknown");
});

test("wildcard / empty host / LAN publishes warn; loopback is silent", () => {
  const audit = auditOf(fixture("wildcard-engine.json"));
  const empty = audit.publishes.find((p) => p.port === 8011);
  assert.equal(empty.code, "empty-host");
  assert.equal(empty.severity, "warn");
  assert.equal(empty.id, "published-ports:b2c3d4e5f6a7:8011");

  const lan = audit.publishes.find((p) => p.port === 8080);
  assert.equal(lan.code, "lan");
  assert.equal(lan.severity, "warn");

  const bridged = auditOf(fixture("bridge-and-loopback.json"));
  assert.equal(bridged.publishes.find((p) => p.port === 9000).code, "bridge");
  assert.equal(bridged.publishes.find((p) => p.port === 8012), undefined, "a loopback publish is silent");
  assert.equal(bridged.loopbackCount, 1);
});

test("wildcard spellings all warn (0.0.0.0, ::, multiple bindings per port)", () => {
  const audit = auditOf(snapshotWith({
    "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }, { HostIp: "::", HostPort: "8080" }, { HostIp: "127.0.0.1", HostPort: "8080" }],
  }));
  const wild = audit.publishes.filter((p) => p.code === "wildcard");
  assert.equal(wild.length, 2, "both wildcard bindings are reported");
  assert.equal(audit.publishes.find((p) => p.kind === "loopback"), undefined, "the loopback binding stays silent");
});

test("tailnet-address publish WITH the addressed rule → info, fenced", () => {
  const audit = auditOf(fixture("fenced-tailnet.json"));
  assert.equal(audit.trusted, true);
  assert.equal(audit.publishes.length, 2, "v4 and v6 are both listed");
  for (const p of audit.publishes) {
    assert.equal(p.severity, "info");
    assert.equal(p.code, "fenced");
    assert.equal(p.fenced, "addressed");
  }
  assert.equal(audit.fence.ruleCount, 2);
});

test("tailnet-address publish WITHOUT the rule → warn", () => {
  const audit = auditOf(fixture("unfenced-tailnet.json"));
  assert.equal(audit.publishes.length, 2);
  for (const p of audit.publishes) {
    assert.equal(p.severity, "warn");
    assert.equal(p.code, "unfenced");
  }
});

test("M3: a port-only rule counts as fenced (info), for v4 and v6", () => {
  const audit = auditOf(snapshotWith(
    { "8011/tcp": [{ HostIp: "100.64.20.5", HostPort: "8011" }, { HostIp: "fd7a:115c:a1e0::20", HostPort: "8011" }] },
    { rawRules: { v4: [portOnlyRule(8011)], v6: [portOnlyRule(8011)] } },
  ));
  assert.equal(audit.publishes.length, 2);
  for (const p of audit.publishes) {
    assert.equal(p.severity, "info");
    assert.equal(p.code, "fenced-port-only");
    assert.equal(p.fenced, "port-only");
  }
});

test("a rule pinned to a different tailnet address → warn (address mismatch)", () => {
  const audit = auditOf(snapshotWith(
    { "8003/tcp": [{ HostIp: "100.64.20.5", HostPort: "8003" }] },
    { rawRules: { v4: [addressedRule("100.64.20.9/32", 8003)], v6: [] } },
  ));
  assert.equal(audit.publishes[0].code, "address-mismatch");
  assert.equal(audit.publishes[0].severity, "warn");
});

test("a UDP publish on the tailnet address cannot be fenced → warn", () => {
  const audit = auditOf(snapshotWith(
    { "8880/udp": [{ HostIp: "100.64.20.5", HostPort: "8880" }] },
    { rawRules: { v4: [addressedRule("100.64.20.5/32", 8880)], v6: [] } },
  ));
  assert.equal(audit.publishes[0].proto, "udp");
  assert.equal(audit.publishes[0].code, "unfenced-protocol");
});

test("an unreadable HostIp is flagged, never dropped (fail closed)", () => {
  const audit = auditOf(snapshotWith({ "7000/tcp": [{ HostIp: "printer.local", HostPort: "7000" }] }));
  assert.equal(audit.publishes.length, 1);
  assert.equal(audit.publishes[0].code, "unknown-host");
  assert.equal(audit.publishes[0].severity, "warn");
});

test("long syntax and lowercase inspect keys are read the same way", () => {
  const audit = auditOf(snapshotWith({
    "8007/tcp": [{ host_ip: "198.51.100.7", host_port: "8007" }],
  }));
  assert.equal(audit.publishes[0].hostIp, "198.51.100.7");
  assert.equal(audit.publishes[0].code, "lan");
});

test("v6 publish with a v6 addressed rule is fenced", () => {
  const audit = auditOf(snapshotWith(
    { "8003/tcp": [{ HostIp: "fd7a:115c:a1e0::20", HostPort: "8003" }] },
    { rawRules: { v4: [], v6: [addressedRule("fd7a:115c:a1e0::20/128", 8003)] } },
  ));
  assert.equal(audit.publishes[0].severity, "info");
  assert.equal(audit.publishes[0].fenced, "addressed");
});

test("host-network containers: Crow-labelled warns, another one is listed as info", () => {
  const audit = auditOf(fixture("host-network.json"));
  const engine = audit.publishes.find((p) => p.name === "crow-engine-host-net");
  const other = audit.publishes.find((p) => p.name === "other-host-net");
  assert.equal(engine.code, "host-network-engine");
  assert.equal(engine.severity, "warn");
  assert.equal(other.code, "host-network");
  assert.equal(other.severity, "info");
});

test("docker below the floor warns; an unreadable version is info", () => {
  assert.equal(parseDockerVersion("28.0.1"), 28);
  assert.equal(parseDockerVersion("27.5.1"), 27);
  assert.equal(parseDockerVersion("nonsense"), null);
  assert.equal(DOCKER_FLOOR, 28);

  const old = auditOf(fixture("old-docker-loopback.json"));
  assert.equal(old.docker.belowFloor, true);
  assert.equal(old.publishes.length, 0, "the loopback publish itself stays silent");

  const unreadable = auditOf(snapshotWith({}, { docker: {} }));
  assert.equal(unreadable.docker.belowFloor, null);
});

test("a facts/conf/docker-flags hash mismatch is reported", () => {
  const audit = auditOf(snapshotWith({}, {
    fence: { conf_sha256: "aaaa", conf_saved_sha256: "bbbb", docker_flags_sha256: "cccc", docker_flags_saved_sha256: "cccc" },
  }));
  assert.deepEqual(audit.fence.hashMismatch, ["conf"]);
});

test("M4 blind spots: host networking and userland-proxy are inspected when the snapshot says so", () => {
  const readable = auditOf(fixture("fenced-tailnet.json"));
  const uninspected = readable.blindSpots.filter((b) => !b.inspected).map((b) => b.code);
  assert.deepEqual(uninspected.sort(), ["other-netns", "rootless-or-podman"]);

  const withoutProxyFlag = auditOf(snapshotWith({}, { docker: { version: "28.0.1" } }));
  assert.ok(withoutProxyFlag.blindSpots.some((b) => b.code === "userland-proxy-false" && !b.inspected));

  const missing = inspectPublishedPorts({ nowMs: NOW, snapshotPath: "/tmp/__crow_no_snapshot__.json" });
  assert.equal(missing.hasRows, false);
  assert.equal(missing.blindSpots.filter((b) => !b.inspected).length, 4, "with no snapshot nothing was inspected");
});

// ─── Allowlists (M6) ─────────────────────────────────────────────────────────

test("the operator allowlist setting parses ports, protocols and container selectors", () => {
  assert.deepEqual(parseAllowlistSetting(null), []);
  assert.deepEqual(parseAllowlistSetting(""), []);
  assert.deepEqual(parseAllowlistSetting("not a list"), []);
  assert.deepEqual(parseAllowlistSetting('["443","8005/udp","crow-caddy:80"]'), [
    { selector: null, port: 443, proto: null },
    { selector: null, port: 8005, proto: "udp" },
    { selector: "crow-caddy", port: 80, proto: null },
  ]);
  assert.equal(parseAllowlistSetting("8080, 8081").length, 2);
  assert.deepEqual(parseAllowlistSetting('["70000","0","abc"]'), []);
});

test("an allowlisted publish is info, listed, never hidden", async () => {
  const path = writeSnapshot(fixture("wildcard-engine.json"));
  const { card, issues } = await signalOf(path, { allowlistRaw: '["8011"]' });
  const allowlisted = issues.find((i) => i.id === "published-ports:b2c3d4e5f6a7:8011");
  assert.ok(allowlisted, "the allowlisted port still gets an entry");
  assert.equal(allowlisted.severity, "info");
  assert.match(allowlisted.label, /allowlist/);
  assert.ok(card, "the card still renders");
  // The LAN publish is not allowlisted and stays a warn.
  assert.equal(issues.find((i) => i.id === "published-ports:c3d4e5f6a7b8:8080").severity, "warn");
});

test("a first-party, version-pinned bundle can allowlist its own ports", () => {
  const root = mkdtempSync(join(tmpdir(), "crow-pp-manifests-"));
  const repoDir = join(root, "repo");
  const installedDir = join(root, "installed");
  for (const dir of [repoDir, installedDir]) {
    mkdirSync(join(dir, "caddy"), { recursive: true });
    writeFileSync(join(dir, "caddy", "manifest.json"), JSON.stringify({ id: "caddy", version: "1.2.3", publishedPortsAllowlist: [80, 443] }));
  }
  const snapshot = snapshotWith(
    { "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "80" }], "443/tcp": [{ HostIp: "0.0.0.0", HostPort: "443" }] },
    { labels: { "crow.bundle": "caddy" } },
  );
  const audit = auditOf(snapshot, { repoBundlesDir: repoDir, installedBundlesDir: installedDir });
  for (const port of [80, 443]) {
    const entry = audit.publishes.find((p) => p.port === port);
    assert.equal(entry.code, "allowlisted", `port ${port}`);
    assert.equal(entry.severity, "info");
    assert.equal(entry.allowlisted, true);
  }

  const manifest = readManifestAllowlist("caddy", { repoDir, installedDir });
  assert.equal(manifest.qualifies, true);
  assert.deepEqual(manifest.ports.map((p) => p.port), [80, 443]);
});

test("a third-party or edited manifest cannot self-allowlist", () => {
  const root = mkdtempSync(join(tmpdir(), "crow-pp-thirdparty-"));
  const repoDir = join(root, "repo");
  const installedDir = join(root, "installed");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(join(installedDir, "some-service"), { recursive: true });
  writeFileSync(join(installedDir, "some-service", "manifest.json"),
    JSON.stringify({ id: "some-service", version: "2.0.0", publishedPortsAllowlist: [8080] }));

  const snapshot = snapshotWith(
    { "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }] },
    { labels: { "crow.bundle": "some-service" } },
  );
  const thirdParty = auditOf(snapshot, { repoBundlesDir: repoDir, installedBundlesDir: installedDir });
  assert.equal(thirdParty.publishes[0].severity, "warn");
  assert.equal(thirdParty.publishes[0].code, "wildcard");
  assert.equal(readManifestAllowlist("some-service", { repoDir, installedDir }).qualifies, false);

  // First-party id, but the installed copy is not the repo's version.
  mkdirSync(join(repoDir, "caddy"), { recursive: true });
  writeFileSync(join(repoDir, "caddy", "manifest.json"), JSON.stringify({ id: "caddy", version: "1.2.3", publishedPortsAllowlist: [80] }));
  mkdirSync(join(installedDir, "caddy"), { recursive: true });
  writeFileSync(join(installedDir, "caddy", "manifest.json"), JSON.stringify({ id: "caddy", version: "1.2.4", publishedPortsAllowlist: [80] }));
  assert.equal(readManifestAllowlist("caddy", { repoDir, installedDir }).qualifies, false);

  // First-party and version-pinned, but the installed copy opts out of refresh.
  writeFileSync(join(installedDir, "caddy", "manifest.json"), JSON.stringify({ id: "caddy", version: "1.2.3", refresh: false, publishedPortsAllowlist: [80] }));
  assert.equal(readManifestAllowlist("caddy", { repoDir, installedDir }).qualifies, false);
});

test("a first-party manifest with no allowlist field allowlists nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "crow-pp-nofield-"));
  for (const dir of ["repo", "installed"]) {
    mkdirSync(join(root, dir, "caddy"), { recursive: true });
    writeFileSync(join(root, dir, "caddy", "manifest.json"), JSON.stringify({ id: "caddy", version: "1.0.0" }));
  }
  const manifest = readManifestAllowlist("caddy", { repoDir: join(root, "repo"), installedDir: join(root, "installed") });
  assert.equal(manifest.qualifies, true);
  assert.deepEqual(manifest.ports, []);
});

// ─── The tailnet overlay publishes (not engines) ─────────────────────────────

test("faster-whisper :8005 fenced and kokoro :8880 unfenced are audited like any other publish", () => {
  const audit = auditOf(fixture("overlay-tailnet.json"));
  const whisper = audit.publishes.find((p) => p.port === 8005);
  const kokoro = audit.publishes.find((p) => p.port === 8880);
  assert.equal(whisper.severity, "info");
  assert.equal(whisper.code, "fenced");
  assert.equal(kokoro.severity, "warn");
  assert.equal(kokoro.code, "unfenced");
  assert.equal(kokoro.id, "published-ports:e5f6a7b8c9d0:8880");
});

// ─── The signal ──────────────────────────────────────────────────────────────

test("signal: no snapshot → info 'unknown', never ok-looking and never a warn", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "crow-pp-nosnap-")), "absent.json");
  const { card, issues, result } = await signalOf(path);
  assert.equal(card.state, "info");
  assert.match(card.value, /unknown/);
  assert.equal(issues.filter((i) => i.severity === "warn").length, 0, "no snapshot never warns by itself");
  assert.ok(issues.length >= 1, "the unknown state is explained");
  assert.equal(result.ok, true, "an unknown audit does not fail the nest");
});

test("signal: the detail lists the M4 shapes it could not inspect", async () => {
  const { card } = await signalOf(writeSnapshot(fixture("fenced-tailnet.json")));
  assert.match(card.value, /not inspected:/);
  assert.match(card.value, /rootless or podman/);
  assert.match(card.value, /other network namespaces/);
  assert.doesNotMatch(card.value, /host networking/, "host networking WAS inspected for these containers");
});

test("signal: a fenced tailnet publish is info only", async () => {
  const { card, issues } = await signalOf(writeSnapshot(fixture("fenced-tailnet.json")));
  assert.equal(card.state, "info");
  const publishIssues = issues.filter((i) => i.id.startsWith("published-ports:"));
  assert.equal(publishIssues.length, 1, "one issue id per (container, port), v4 and v6 merged");
  assert.equal(publishIssues[0].severity, "info");
  assert.equal(publishIssues[0].id, "published-ports:a1b2c3d4e5f6:8003");
});

test("signal: an unfenced tailnet publish warns with the per-container issue id", async () => {
  const { card, issues, result } = await signalOf(writeSnapshot(fixture("unfenced-tailnet.json")));
  assert.equal(card.state, "warn");
  const warn = issues.find((i) => i.id === "published-ports:a1b2c3d4e5f6:8011");
  assert.ok(warn, "the issue id is published-ports:<short-id>:<port>");
  assert.equal(warn.severity, "warn");
  assert.match(warn.label, /tailnet address 100\.64\.20\.5/);
  assert.equal(result.ok, false);
});

test("signal: a stale snapshot with a tailnet publish warns 'fence unknown'", async () => {
  const { issues } = await signalOf(writeSnapshot(fixture("unfenced-tailnet.json"), { ageMs: 40 * MIN }), { nowMs: NOW });
  const warn = issues.find((i) => i.id === "published-ports:a1b2c3d4e5f6:8011");
  assert.equal(warn.severity, "warn");
  assert.match(warn.label, /stale/i);
});

test("signal: a malformed snapshot is info 'unknown'", async () => {
  const { card } = await signalOf(join(FIXTURES, "malformed.json"));
  assert.equal(card.state, "info");
  assert.match(card.value, /unknown/);
});

test("signal: docker below the floor and a hash mismatch each get their own issue", async () => {
  const old = await signalOf(writeSnapshot(fixture("old-docker-loopback.json")));
  const floor = old.issues.find((i) => i.id === "published-ports:docker-floor");
  assert.ok(floor, "the Docker floor issue id");
  assert.equal(floor.severity, "warn");
  assert.match(floor.label, /27\.5\.1/);

  const hashes = await signalOf(writeSnapshot(snapshotWith({}, {
    fence: { conf_sha256: "aaaa", conf_saved_sha256: "bbbb" },
  })));
  const mismatch = hashes.issues.find((i) => i.id === "published-ports:fence-hashes");
  assert.ok(mismatch);
  assert.equal(mismatch.severity, "warn");
});

test("signal: everything on loopback → ok, no issues", async () => {
  const { card, issues } = await signalOf(writeSnapshot(snapshotWith(
    { "8007/tcp": [{ HostIp: "127.0.0.1", HostPort: "8007" }] },
    { docker: { version: "28.0.1", userland_proxy: true } },
  )));
  assert.equal(card.state, "ok");
  assert.equal(issues.length, 0);
});

test("signal: never throws, and a throwing inspector degrades to off", async () => {
  await assert.doesNotReject(async () => {
    await signalOf(undefined, { publishedPorts: { inspect: () => { throw new Error("boom"); } } });
  });
  const { card } = await signalOf(undefined, { publishedPorts: { inspect: () => { throw new Error("boom"); } } });
  assert.equal(card.state, "off");
});

test("signal: a failing db read for the allowlist does not break the audit", async () => {
  invalidateHealthCache();
  const result = await collectHealthSignals(
    { async execute() { throw new Error("no db"); } },
    { now: () => NOW, publishedPorts: { snapshotPath: writeSnapshot(fixture("fenced-tailnet.json")) } },
  );
  const card = result.details.find((d) => d.id === "publishedPorts");
  assert.equal(card.state, "info", "the audit still ran, without an allowlist");
});

test("signal: Spanish rendering uses the translated strings", async () => {
  const { card, issues } = await signalOf(writeSnapshot(fixture("unfenced-tailnet.json")), { lang: "es" });
  assert.equal(card.label, "Puertos publicados");
  const warn = issues.find((i) => i.id === "published-ports:a1b2c3d4e5f6:8011");
  assert.match(warn.label, /dirección de tailnet/);
});

// ─── i18n and the settings key ───────────────────────────────────────────────

test("every publishedPorts string has a Spanish translation", () => {
  const keys = Object.keys(translations).filter((k) => k.startsWith("signals.publishedPorts."));
  assert.ok(keys.length >= 20, `expected the full key set, found ${keys.length}`);
  for (const key of keys) {
    const entry = translations[key];
    assert.equal(typeof entry.en, "string", `${key} has English`);
    assert.equal(typeof entry.es, "string", `${key} has Spanish`);
    assert.ok(entry.es.trim().length > 0, `${key} Spanish is not empty`);
    assert.notEqual(t(key, "es"), key, `${key} resolves in es`);
  }
});

test("published_ports_allowlist is a LOCAL settings key: never in the sync allowlist", () => {
  assert.equal(PUBLISHED_PORTS_ALLOWLIST_KEY, "published_ports_allowlist");
  assert.equal(isSyncable(PUBLISHED_PORTS_ALLOWLIST_KEY), false);
  assert.equal(Object.keys(SYNC_ALLOWLIST).includes(PUBLISHED_PORTS_ALLOWLIST_KEY), false);
  // Not instance-scope either: nothing to declare in the settings registry, and
  // the two lists stay disjoint (tests/instance-scope-keys.test.js).
  assert.equal(isInstanceScope(PUBLISHED_PORTS_ALLOWLIST_KEY), false);
  assert.equal(Object.keys(INSTANCE_SCOPE_KEYS).includes(PUBLISHED_PORTS_ALLOWLIST_KEY), false);
});
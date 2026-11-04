/**
 * publish-snapshot-script.test.js — plan PR S5b.
 *
 * Drives scripts/fence/crow-publish-snapshot against FAKE `docker`, `ss`,
 * `iptables`, `ip6tables`, `systemctl` and `tailscale` binaries on PATH in a
 * temp dir: no root, no real docker, no real firewall, no real unit.
 *
 * The fake `docker` is the important one: it RENDERS the Go-template subset the
 * script uses (`{{json .A.B}}` / `{{.A.B}}`) against the full inspect fixture,
 * which carries secrets in `Config.Env`, `Config.Cmd`, `Config.Entrypoint` and a
 * mount source. A template that asked for any of those would print the secret
 * and fail the secret test — so that test is about the script's field selection,
 * not about a canned string someone remembered to strip.
 *
 * The golden run's output is then fed to the S5a reader
 * (servers/gateway/dashboard/panels/nest/published-ports.js): the snapshot
 * shape and the reader's parser have to agree, or the audit sees nothing.
 *
 * Every address is a documentation placeholder (100.64.20.x /
 * fd7a:115c:a1e0::20 / 172.17.0.x / 172.20.0.x).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMPOSE_WORKDIR_LABEL,
  DEFAULT_PUBLISH_SNAPSHOT_PATH,
  PUBLISH_SNAPSHOT_ENV,
  inspectPublishedPorts,
  loadPublishSnapshot,
} from "../servers/gateway/dashboard/panels/nest/published-ports.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(REPO, "scripts", "fence", "crow-publish-snapshot");
const UNIT = join(REPO, "scripts", "fence", "crow-publish-snapshot.service");
const TIMER = join(REPO, "scripts", "fence", "crow-publish-snapshot.timer");
const DOC = join(REPO, "docs", "guide", "engine-fence.md");
const FIXTURES = fileURLToPath(new URL("./fixtures/publish-snapshot/", import.meta.url));

// An empty bundle-source dir on both sides, so a host that happens to have a
// bundle installed can never change what the audit reads.
const NO_BUNDLES = mkdtempSync(join(tmpdir(), "crow-ps-nobundles-"));

const ID_35B = "aaaabbbbcccc1111aaaabbbbcccc1111aaaabbbbcccc1111aaaabbbbcccc1111";
const ID_EMBED = "dddddeeeeffff2222dddddeeeeffff2222dddddeeeeffff2222dddddeeeeffff2222";

// The secrets the inspect fixtures carry in the fields the script must never ask
// for. Each one is asserted present in the fixture (so the test is not vacuous)
// and absent from the snapshot.
const SECRETS = [
  "FAKE-ENV-SECRET-4a7d2c",
  "FAKE-ENV-TOKEN-18ce40",
  "FAKE-CMD-SECRET-91be35",
  "FAKE-ENTRYPOINT-SECRET-77cc10",
  "FAKE-MOUNT-SECRET-2f9a88",
];

/** The gateway user's group, as this test's own group (chgrp needs a name). */
const GROUP = execFileSync("id", ["-gn"], { encoding: "utf8" }).trim();

// ─── Fakes ───────────────────────────────────────────────────────────────────

const FAKE_DOCKER = String.raw`#!/usr/bin/env node
// Fake docker: renders the template the script asks for against the FULL inspect
// fixture, so asking for Config.Env / Cmd / Entrypoint / Mounts would leak.
const fs = require("node:fs");
const path = require("node:path");

const dir = process.env.FAKE_FIXTURES;
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, "docker " + args.join(" ") + "\n");

if (fs.existsSync(path.join(dir, "fail-docker"))) {
  process.stderr.write("fake docker: cannot connect to the daemon\n");
  process.exit(1);
}

const lookup = (doc, dotted) => dotted.split(".").reduce((node, key) => (node == null ? undefined : node[key]), doc);
const render = (template, doc) => String(template || "").replace(/\{\{\s*(json\s+)?\.([A-Za-z0-9_.]+)\s*\}\}/g, (m, asJson, dotted) => {
  const found = lookup(doc, dotted);
  if (asJson) return JSON.stringify(found === undefined ? null : found);
  return found === undefined ? "<no value>" : String(found);
});
const flag = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? null : args[i + 1];
};
const out = (text) => process.stdout.write(String(text).replace(/\n*$/, "\n"));
const fixture = (name) => fs.readFileSync(path.join(dir, name), "utf8");

const sub = args[0];
if (sub === "version") {
  out(render(flag("--format"), JSON.parse(fixture("docker-server-version.json"))));
  process.exit(0);
}
if (sub === "info") {
  out(render(flag("--format"), JSON.parse(fixture("docker-info.json"))));
  process.exit(0);
}
if (sub === "ps") {
  out(fixture("docker-ps.txt"));
  process.exit(0);
}
if (sub === "inspect") {
  const id = args[args.length - 1];
  const file = path.join(dir, "inspect-" + id + ".json");
  if (!fs.existsSync(file)) {
    process.stderr.write("fake docker: no such container " + id + "\n");
    process.exit(1);
  }
  out(render(flag("--format"), JSON.parse(fs.readFileSync(file, "utf8"))));
  process.exit(0);
}
process.stderr.write("fake docker: unsupported " + args.join(" ") + "\n");
process.exit(64);
`;

const bashFake = ({ label, fixture, failMarker }) => `#!/usr/bin/env bash
set -u
printf '${label} %s\\n' "$*" >> "$FAKE_LOG"
if [ -n "${failMarker}" ] && [ -f "$FAKE_FIXTURES/${failMarker}" ]; then
  echo "${label}: fake failure" >&2
  exit 1
fi
cat "$FAKE_FIXTURES/${fixture}"
`;

const FAKE_SYSTEMCTL = `#!/usr/bin/env bash
set -u
printf 'systemctl %s\\n' "$*" >> "$FAKE_LOG"
cat "$FAKE_FIXTURES/fence-unit.txt"
`;

const FAKE_TAILSCALE = `#!/usr/bin/env bash
set -u
printf 'tailscale %s\\n' "$*" >> "$FAKE_LOG"
if [ -f "$FAKE_FIXTURES/fail-tailscale" ]; then
  echo "Tailscale is stopped." >&2
  exit 1
fi
case "$*" in
  "ip -4") cat "$FAKE_FIXTURES/tailscale-v4.txt" ;;
  "ip -6") cat "$FAKE_FIXTURES/tailscale-v6.txt" ;;
  *) echo "tailscale: unsupported call" >&2; exit 1 ;;
esac
`;

/**
 * A scratch box: fake binaries, a writable copy of the fixtures (so a test can
 * drop a failure marker), and an output directory.
 */
function setup({ fixtures = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "crow-publish-snapshot-"));
  const bin = join(root, "bin");
  const fixtureDir = join(root, "fixtures");
  const outDir = join(root, "out");
  const log = join(root, "calls.log");
  for (const dir of [bin, fixtureDir, outDir]) mkdirSync(dir, { recursive: true });
  cpSync(FIXTURES, fixtureDir, { recursive: true });
  for (const [name, body] of Object.entries(fixtures)) writeFileSync(join(fixtureDir, name), body);

  const fake = (name, body) => {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  };
  fake("docker", FAKE_DOCKER);
  fake("ss", bashFake({ label: "ss", fixture: "ss-ltn.txt", failMarker: "fail-ss" }));
  fake("iptables", bashFake({ label: "iptables", fixture: "iptables-raw-v4.txt", failMarker: "fail-iptables" }));
  fake("ip6tables", bashFake({ label: "ip6tables", fixture: "ip6tables-raw-v6.txt", failMarker: "fail-ip6tables" }));
  fake("systemctl", FAKE_SYSTEMCTL);
  fake("tailscale", FAKE_TAILSCALE);
  writeFileSync(log, "");

  return { root, bin, fixtures: fixtureDir, outDir, out: join(outDir, "snapshot.json"), log };
}

function envOf(ctx, extra = {}) {
  return {
    PATH: `${ctx.bin}:${process.env.PATH}`,
    HOME: ctx.root,
    FAKE_FIXTURES: ctx.fixtures,
    FAKE_LOG: ctx.log,
    // The host's own values must never reach the script under test.
    [PUBLISH_SNAPSHOT_ENV]: "",
    CROW_SNAPSHOT_GROUP: "",
    ...extra,
  };
}

const run = (ctx, args = [], extra = {}) =>
  spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: envOf(ctx, extra), timeout: 60_000 });

const readSnapshot = (ctx) => JSON.parse(readFileSync(ctx.out, "utf8"));
const calls = (ctx) => readFileSync(ctx.log, "utf8").split("\n").filter(Boolean);

/** A full run with a group (so no warning) writing ctx.out. */
function snapshotOf(ctx) {
  const r = run(ctx, ["--output", ctx.out, "--group", GROUP]);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  return readSnapshot(ctx);
}

// ─── Golden output and the S5a reader ────────────────────────────────────────

test("golden: the snapshot has the fields the audit reads, and the audit parses it", () => {
  const ctx = setup();
  const doc = snapshotOf(ctx);

  assert.ok(Number.isFinite(Date.parse(doc.taken_at)), "taken_at parses");
  assert.equal(doc.docker.version, "28.0.1");
  assert.equal(doc.docker.firewall_backend, "nftables", "the backend Driver is unwrapped");
  assert.equal(doc.docker.userland_proxy, true, "the blind-spot flag is inspectable");
  assert.deepEqual(doc.errors, []);

  assert.equal(doc.containers.length, 2, "running containers are listed");
  const engine = doc.containers.find((c) => c.name === "crow-engine-35b");
  assert.ok(engine, "the container name has no leading slash");
  assert.equal(engine.id, "aaaabbbbcccc", "the id is short");
  assert.deepEqual(engine.host_config.port_bindings, {
    "8003/tcp": [{ HostIp: "100.64.20.5", HostPort: "8003" }],
  });
  assert.equal(engine.host_config.network_mode, "default");
  assert.deepEqual(engine.networks, ["crow-eng-example"]);

  assert.deepEqual(doc.fence, { unit_active: true, unit_state: "active" });
  assert.equal(doc.tailscale.v4, "100.64.20.5");
  assert.equal(doc.tailscale.v6, "fd7a:115c:a1e0::20");

  // `ss -ltn` rows: address and port only.
  const rows = doc.listeners;
  for (const [address, port] of [
    ["0.0.0.0", 8005],
    ["::", 8005],
    ["127.0.0.1", 53],
    ["100.64.20.5", 8003],
    ["fd7a:115c:a1e0::20", 8003],
  ]) {
    assert.ok(rows.some((row) => row.address === address && row.port === port), `${address}:${port}`);
  }
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ["address", "port"], "no process names");

  assert.deepEqual(doc.raw_rules.v4, [
    "-P PREROUTING ACCEPT",
    "-A PREROUTING -j CROW-ENGINE-FENCE",
    '-A CROW-ENGINE-FENCE -d 100.64.20.5/32 -p tcp -m tcp --dport 8003 ! -i tailscale0 -m comment --comment "crow-engine-fence:35b:g7" -j DROP',
  ]);
  assert.deepEqual(doc.raw_rules.v6, ["-P PREROUTING ACCEPT", "-A PREROUTING -j CROW-ENGINE-FENCE"]);

  // …and the S5a reader agrees: fresh, trusted, the fenced tailnet publish is
  // info, the loopback one is silent.
  const loaded = loadPublishSnapshot({ snapshotPath: ctx.out, nowMs: Date.now() });
  assert.equal(loaded.status, "ok");

  const audit = inspectPublishedPorts({
    nowMs: Date.now(),
    snapshotPath: ctx.out,
    repoBundlesDir: NO_BUNDLES,
    installedBundlesDir: NO_BUNDLES,
  });
  assert.equal(audit.status, "ok");
  assert.equal(audit.trusted, true);
  assert.equal(audit.containerCount, 2);
  assert.equal(audit.docker.version, "28.0.1");
  assert.equal(audit.docker.belowFloor, false);
  assert.equal(audit.fence.unitActive, true);
  assert.equal(audit.fence.ruleCount, 1);
  const fenced = audit.publishes.find((p) => p.port === 8003);
  assert.equal(fenced.kind, "tailnet");
  assert.equal(fenced.severity, "info");
  assert.equal(fenced.code, "fenced");
  assert.equal(audit.publishes.filter((p) => p.port === 8007).length, 0, "a loopback publish is silent");
});

test("golden: only the crow.* and compose identity labels are kept", () => {
  const ctx = setup();
  const doc = snapshotOf(ctx);
  assert.equal(doc.containers.length, 2);
  for (const container of doc.containers) {
    assert.ok(container.labels["crow.runtime"], `${container.name} carries crow.runtime`);
    assert.ok(container.labels["com.docker.compose.project"], `${container.name} carries the compose project`);
    assert.match(
      container.labels[COMPOSE_WORKDIR_LABEL],
      /^\/home\/crow\/\.crow\/bundles\//,
      `${container.name} carries the compose working dir the allowlist identity needs`,
    );
    for (const key of Object.keys(container.labels)) {
      assert.ok(key.startsWith("crow.") || key === "com.docker.compose.project" || key === COMPOSE_WORKDIR_LABEL, key);
    }
  }
  const engine = doc.containers.find((c) => c.name === "crow-engine-35b");
  assert.equal(engine.labels["org.opencontainers.image.vendor"], undefined, "an unrelated label is not copied");
});

test("secrets in Config.Env, Cmd, Entrypoint and a mount source never reach the snapshot", () => {
  const inspectFixture = readFileSync(join(FIXTURES, `inspect-${ID_35B}.json`), "utf8");

  // The fixtures really do carry them, so an absence below means something.
  for (const secret of SECRETS) assert.ok(inspectFixture.includes(secret), `fixture carries ${secret}`);

  const ctx = setup();
  snapshotOf(ctx);
  const text = readFileSync(ctx.out, "utf8");
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `leaked: ${secret}`);
  for (const key of ['"Env"', '"Hostname"', '"Cmd"', '"Entrypoint"', '"Mounts"', '"Binds"']) {
    assert.ok(!text.includes(key), `leaked field ${key}`);
  }

  // …because the inspect template never asked for them.
  const inspects = calls(ctx).filter((line) => line.startsWith("docker inspect"));
  assert.equal(inspects.length, 2, "one inspect per running container");
  for (const line of inspects) {
    assert.doesNotMatch(line, /Config\.Env|Config\.Cmd|Config\.Entrypoint|\.Mounts|HostConfig\.Binds/, line);
    assert.match(line, /--format /);
  }
});

test("the commands the script runs are the read-only ones, with no -p and no process names", () => {
  const ctx = setup();
  snapshotOf(ctx);
  const log = calls(ctx);
  for (const expected of [
    "ss -ltn",
    "iptables -t raw -S",
    "ip6tables -t raw -S",
    "systemctl is-active crow-engine-fence",
    "tailscale ip -4",
    "tailscale ip -6",
  ]) {
    assert.ok(log.includes(expected), `ran: ${expected}`);
    assert.equal(log.filter((line) => line === expected).length, 1, `${expected} runs once`);
  }
  assert.equal(log.filter((line) => line.startsWith("docker version --format ")).length, 1);
  assert.equal(log.filter((line) => line.startsWith("docker info --format ")).length, 2);
  assert.equal(log.filter((line) => line === "docker ps -q --no-trunc").length, 1);
  // `ss` is never asked for processes (-p) and never for a wider table.
  for (const line of log.filter((l) => l.startsWith("ss "))) {
    assert.doesNotMatch(line, /-[a-zA-Z]*p/, "no -p: no process names");
    assert.equal(line, "ss -ltn");
  }
});

test("an inactive fence unit is written as a fact, not omitted", () => {
  const ctx = setup({ fixtures: { "fence-unit.txt": "inactive\n" } });
  const doc = snapshotOf(ctx);
  assert.deepEqual(doc.fence, { unit_active: false, unit_state: "inactive" });
});

// ─── Failure handling ───────────────────────────────────────────────────────

test("a failing docker: the snapshot is still written, the section is null, an error is recorded", () => {
  const ctx = setup();
  writeFileSync(join(ctx.fixtures, "fail-docker"), "");
  const doc = snapshotOf(ctx);

  assert.equal(doc.docker.version, null);
  assert.equal(doc.docker.firewall_backend, null);
  assert.equal(doc.docker.userland_proxy, null);
  assert.equal(doc.containers, null, "an unreadable container list is null, never an empty list");
  assert.ok(doc.errors.length >= 3, "each failed command is one entry");
  assert.ok(doc.errors.some((e) => e.command.startsWith("docker")), "the errors name the command");

  // The sections that did read are still there.
  assert.equal(doc.raw_rules.v4.length, 3);
  assert.equal(doc.tailscale.v4, "100.64.20.5");
  assert.equal(doc.fence.unit_active, true);

  // Fail closed at the reader: a null container list can never read as
  // "nothing is published beyond loopback".
  const loaded = loadPublishSnapshot({ snapshotPath: ctx.out, nowMs: Date.now() });
  assert.notEqual(loaded.status, "ok");
  const audit = inspectPublishedPorts({
    nowMs: Date.now(),
    snapshotPath: ctx.out,
    repoBundlesDir: NO_BUNDLES,
    installedBundlesDir: NO_BUNDLES,
  });
  assert.equal(audit.hasRows, false);
});

test("a failing iptables nulls only the raw rules: the tailnet publish then reads as unfenced", () => {
  const ctx = setup();
  writeFileSync(join(ctx.fixtures, "fail-iptables"), "");
  const doc = snapshotOf(ctx);

  assert.equal(doc.raw_rules.v4, null);
  assert.ok(Array.isArray(doc.raw_rules.v6), "the other family is untouched");
  assert.equal(doc.containers.length, 2);
  assert.ok(doc.errors.some((e) => e.command === "iptables -t raw -S"));

  const audit = inspectPublishedPorts({
    nowMs: Date.now(),
    snapshotPath: ctx.out,
    repoBundlesDir: NO_BUNDLES,
    installedBundlesDir: NO_BUNDLES,
  });
  assert.equal(audit.status, "ok", "the rest of the snapshot is still usable");
  assert.equal(audit.publishes.find((p) => p.port === 8003).severity, "warn", "no rule, so it warns");
  assert.equal(audit.publishes.find((p) => p.port === 8003).code, "unfenced");
});

test("a failing or empty tailscale is null plus an error, and the rest of the run continues", () => {
  const failing = setup();
  writeFileSync(join(failing.fixtures, "fail-tailscale"), "");
  const failed = snapshotOf(failing);
  assert.equal(failed.tailscale.v4, null);
  assert.equal(failed.tailscale.v6, null);
  assert.ok(failed.errors.some((e) => e.command === "tailscale ip -4"));
  assert.equal(failed.containers.length, 2);

  const loggedOut = setup({ fixtures: { "tailscale-v6.txt": "" } });
  const empty = snapshotOf(loggedOut);
  assert.equal(empty.tailscale.v4, "100.64.20.5");
  assert.equal(empty.tailscale.v6, null, "no v6 address is null, not an empty string");
  assert.ok(empty.errors.some((e) => e.command === "tailscale ip -6"), "an absent family is recorded");
});

// ─── Write semantics ────────────────────────────────────────────────────────

test("the file is written to a temp name beside the target and renamed into place", () => {
  const ctx = setup();
  writeFileSync(ctx.out, '{"taken_at":"2000-01-01T00:00:00Z"}\n');
  const before = statSync(ctx.out).ino;

  const doc = snapshotOf(ctx);
  assert.ok(doc.containers.length > 0);
  assert.notEqual(statSync(ctx.out).ino, before, "the old file was replaced, not rewritten in place");
  assert.deepEqual(
    readdirSync(ctx.outDir).filter((name) => name.startsWith(".")),
    [],
    "no temp file is left behind",
  );

  const mode = statSync(ctx.out).mode & 0o777;
  assert.equal(mode, 0o640, "the snapshot is 0640");
  assert.equal(statSync(ctx.outDir).mode & 0o777, 0o750, "its directory is 0750 for the given group");

  // The same two steps, at the source level: a temp file in the target's own
  // directory (so the rename cannot cross a filesystem) and a rename.
  const script = readFileSync(SCRIPT, "utf8");
  assert.match(script, /mktemp "\$OUTPUT_DIR\/\.crow-publish-snapshot\.XXXXXX"/);
  assert.match(script, /mv -f -- "\$TMP_JSON" "\$OUTPUT"/);
  assert.match(script, /^umask 0077$/m);
});

test("an unwritable group fails loudly and leaves the previous snapshot in place", () => {
  const ctx = setup();
  snapshotOf(ctx);
  const before = readFileSync(ctx.out, "utf8");

  const r = run(ctx, ["--output", ctx.out], { CROW_SNAPSHOT_GROUP: "crow-no-such-group-4f2a" });
  assert.notEqual(r.status, 0, "a group that cannot be applied is not a silent success");
  assert.match(r.stderr, /crow-no-such-group-4f2a/);
  assert.equal(readFileSync(ctx.out, "utf8"), before, "the old snapshot survives");
  assert.deepEqual(readdirSync(ctx.outDir).filter((name) => name.startsWith(".")), [], "no temp file is left behind");
});

test("the output path comes from --output or CROW_PUBLISH_SNAPSHOT, and the default matches the reader", () => {
  const ctx = setup();
  const viaEnv = run(ctx, [], { [PUBLISH_SNAPSHOT_ENV]: ctx.out, CROW_SNAPSHOT_GROUP: GROUP });
  assert.equal(viaEnv.status, 0, viaEnv.stderr);
  assert.ok(existsSync(ctx.out));

  const other = join(ctx.outDir, "second.json");
  const viaArg = run(ctx, ["--output", other, "--group", GROUP]);
  assert.equal(viaArg.status, 0, viaArg.stderr);
  assert.ok(existsSync(other));

  assert.equal(DEFAULT_PUBLISH_SNAPSHOT_PATH, "/var/lib/crow-fence/snapshot.json");
  assert.match(readFileSync(SCRIPT, "utf8"), /^DEFAULT_OUTPUT=\/var\/lib\/crow-fence\/snapshot\.json$/m);
});

test("without a group the snapshot is still written, and the warning says what that means", () => {
  const ctx = setup();
  const r = run(ctx, ["--output", ctx.out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /no --group given/);
  assert.equal(readFileSync(ctx.out, "utf8").length > 0, true);
  assert.equal(statSync(ctx.out).mode & 0o777, 0o640);
});

test("unknown options are refused, and --help writes nothing", () => {
  const ctx = setup();
  const bad = run(ctx, ["--nonsense"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown option/);

  const help = run(ctx, ["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--group/);
  assert.deepEqual(readdirSync(ctx.outDir), []);
});

// ─── The unit and the timer ─────────────────────────────────────────────────

function directives(text) {
  const out = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";") || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    (out[key] ||= []).push(line.slice(eq + 1).trim());
  }
  return out;
}
const first = (dirs, key) => (dirs[key] || [])[0] ?? null;

test("unit lint: root oneshot, StateDirectory, the exact capability set, no User=, no strict sandbox", () => {
  const text = readFileSync(UNIT, "utf8");
  const dirs = directives(text);

  assert.equal(first(dirs, "Type"), "oneshot");
  assert.equal(first(dirs, "ExecStart"), "/usr/local/sbin/crow-publish-snapshot");
  assert.equal(first(dirs, "StateDirectory"), "crow-fence");
  assert.equal(first(dirs, "StateDirectoryMode"), "0750");
  assert.equal(first(dirs, "NoNewPrivileges"), "yes");
  assert.equal(first(dirs, "CapabilityBoundingSet"), "CAP_NET_ADMIN CAP_NET_RAW CAP_CHOWN");
  assert.ok(Number(first(dirs, "TimeoutStartSec")?.replace(/\D/g, "")) > 0, "a start timeout");

  // Root, and nothing is added to anybody's groups.
  assert.equal(dirs.User, undefined, "no User=: the unit runs as root");
  assert.equal(dirs.Group, undefined);
  assert.equal(dirs.SupplementaryGroups, undefined);
  assert.doesNotMatch(text, /\b(?:usermod|gpasswd|groupadd|adduser)\b/);

  // Sandbox: NOT strict by default — iptables must be able to create
  // /run/xtables.lock, which a strict namespace would not allow.
  for (const value of dirs.ProtectSystem || []) assert.notEqual(value, "strict");

  // Every ReadWritePaths entry is either created by this unit or `-`-prefixed
  // (a missing path with a `-` prefix is ignored by systemd; a missing one
  // without it fails the unit with 226/NAMESPACE).
  const created = [];
  for (const [key, prefix] of [
    ["RuntimeDirectory", "/run"],
    ["StateDirectory", "/var/lib"],
    ["LogsDirectory", "/var/log"],
    ["CacheDirectory", "/var/cache"],
  ]) {
    for (const value of dirs[key] || []) created.push(`${prefix}/${value}`);
  }
  for (const value of dirs.ReadWritePaths || []) {
    if (value.startsWith("-")) continue;
    assert.ok(
      created.some((path) => value === path || value.startsWith(`${path}/`)),
      `ReadWritePaths=${value} is neither created by the unit nor -prefixed`,
    );
  }

  // No lifecycle side effects: a snapshot job never stops or restarts anything.
  assert.equal(dirs.ExecStartPre, undefined);
  assert.equal(dirs.ExecStop, undefined);
  assert.equal(dirs.ExecStopPost, undefined);
  assert.equal(dirs.RequiredBy, undefined);
  assert.equal(dirs.Wants?.includes("docker.service"), false, "it never pulls docker up");

  // The group is the installer's, never a literal here.
  assert.equal(first(dirs, "EnvironmentFile"), "-/etc/crow/publish-snapshot.env");
});

test("timer lint: every 5 minutes, monotonic, drives the snapshot service", () => {
  const dirs = directives(readFileSync(TIMER, "utf8"));
  assert.equal(first(dirs, "OnUnitActiveSec"), "5min");
  assert.equal(first(dirs, "Unit"), "crow-publish-snapshot.service");
  assert.equal(first(dirs, "WantedBy"), "timers.target");
  assert.equal(dirs.OnCalendar, undefined, "no wall-clock minute that every host would share");
});

// ─── Shipped-file hygiene and the doc ───────────────────────────────────────

test("the script, unit and timer carry no address literal, no tailnet name and no group name", () => {
  for (const file of [SCRIPT, UNIT, TIMER]) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /\b\d{1,3}(?:\.\d{1,3}){3}\b/, `${file}: no IPv4 literal`);
    assert.doesNotMatch(text, /ts\.net/i, `${file}: no tailnet name`);
    assert.doesNotMatch(text, /:\d{4,5}\b\s*$/, `${file}: no address:port literal`);
  }
});

test("the install doc covers the snapshot: paths, group, timer, removal, and no URL", () => {
  const text = readFileSync(DOC, "utf8");
  for (const needle of [
    "crow-publish-snapshot",
    "crow-publish-snapshot.timer",
    "/var/lib/crow-fence/snapshot.json",
    "StateDirectory",
    "<group>",
    "disable --now crow-publish-snapshot.timer",
  ]) {
    assert.ok(text.includes(needle), `the doc names ${needle}`);
  }
  assert.doesNotMatch(text, /https?:\/\//, "no URL");
});
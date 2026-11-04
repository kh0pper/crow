/**
 * engine-fence-script.test.js — plan PR S4.
 *
 * Drives scripts/fence/crow-engine-fence against FAKE `iptables`, `ip6tables`,
 * `iptables-restore`, `ip6tables-restore`, `tailscale`, `docker`, `systemctl`
 * and `flock` binaries on PATH in a temp dir: no root, no real firewall, no
 * real daemon, no real tailnet, no unit installed.
 *
 * The fakes are a small model, not canned output: the restore fakes keep the
 * chain they were handed (normalising `-d <addr>` to the `/32` and `/128` a real
 * `iptables -S` prints), the `iptables` fake serves `-S` from that model and
 * tracks the PREROUTING jump with a marker file, and its `-C` answers from the
 * marker. That is what makes "apply twice gives identical `-S`" and "the state
 * file is not rewritten when nothing changed" real assertions rather than
 * comparisons of two constants.
 *
 * The key cross-check is the last one in that group: the fake's live `-S` lines
 * are fed to the S5a reader
 * (servers/gateway/dashboard/panels/nest/published-ports.js), which must report
 * the tailnet-address publish as FENCED — addressed and port-only both. The
 * fence and the audit agree on the tag, the chain, the jump and the rule
 * spelling, or the audit calls a fenced engine unfenced.
 *
 * Every address is a documentation placeholder (100.64.20.x /
 * fd7a:115c:a1e0::20 / 192.0.2.x).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import {
  chmodSync,
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

import { inspectPublishedPorts } from "../servers/gateway/dashboard/panels/nest/published-ports.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(REPO, "scripts", "fence", "crow-engine-fence");
const SERVICE = join(REPO, "scripts", "fence", "crow-engine-fence.service");
const WANTEDBY = join(REPO, "scripts", "fence", "crow-engine-fence-wantedby.service");
const REAPPLY = join(REPO, "scripts", "fence", "crow-engine-fence-reapply.service");
const TIMER = join(REPO, "scripts", "fence", "crow-engine-fence-reapply.timer");
const CONF_EXAMPLE = join(REPO, "scripts", "fence", "engine-fence.conf.example");
const DOC = join(REPO, "docs", "guide", "engine-fence.md");

// An empty bundle-source dir on both sides, so a host that happens to have a
// bundle installed can never change what the audit reads.
const NO_BUNDLES = mkdtempSync(join(tmpdir(), "crow-ef-nobundles-"));

/** The group the state directory is handed to (chgrp needs a real name). */
const GROUP = execFileSync("id", ["-gn"], { encoding: "utf8" }).trim();

const BASE_CONF = `interface tailscale0
bridge crow-eng-ex
publish tailnet 8003
publish port-only 8030
publish lan 192.0.2.10 8011 consumer 192.0.2.20
`;

const TAILNET_V4 = "100.64.20.5";
const TAILNET_V6 = "fd7a:115c:a1e0::20";
const CROW_ENGINE_FENCE = "CROW-ENGINE-FENCE";

// ─── Fakes ──────────────────────────────────────────────────────────────────

const FAKE_IPTABLES = String.raw`#!/usr/bin/env bash
set -u
fam=FAMILY
printf '%s %s\n' "$fam" "$*" >> "$FAKE_LOG"
model="$FAKE_FIXTURES/model-$fam.txt"
jump="$FAKE_FIXTURES/jump-$fam"
if [ "$1" = "--version" ]; then
  if [ -f "$FAKE_FIXTURES/no-$fam" ]; then
    echo "$fam: not installed" >&2
    exit 127
  fi
  cat "$FAKE_FIXTURES/version-$fam.txt"
  exit 0
fi
table=filter
if [ "$1" = "-t" ]; then
  table=$2
  shift 2
fi
cmd=$1
shift
case "$table/$cmd" in
  raw/-S)
    if [ "$#" -ge 1 ]; then
      if [ -f "$model" ]; then grep -F -- "-A $1 " "$model" || true; fi
      exit 0
    fi
    echo "-P PREROUTING ACCEPT"
    if [ -f "$jump" ]; then echo "-A PREROUTING -j CROW-ENGINE-FENCE"; fi
    if [ -f "$model" ]; then cat "$model"; fi
    exit 0
    ;;
  raw/-C)
    if [ -f "$jump" ]; then exit 0; fi
    exit 1
    ;;
  raw/-I)
    touch "$jump"
    exit 0
    ;;
  filter/-S)
    if [ -f "$FAKE_FIXTURES/old-rules.txt" ]; then cat "$FAKE_FIXTURES/old-rules.txt"; fi
    exit 0
    ;;
esac
echo "fake $fam: unsupported $table $cmd" >&2
exit 64
`;

const FAKE_RESTORE = String.raw`#!/usr/bin/env bash
set -u
fam=FAMILY
printf '%s-restore %s\n' "$fam" "$*" >> "$FAKE_LOG"
if [ -f "$FAKE_FIXTURES/fail-restore-$fam" ]; then
  echo "fake restore: refused" >&2
  exit 1
fi
stdin=$(cat)
printf '%s\n' "$stdin" > "$FAKE_FIXTURES/restore-input-$fam.txt"
model="$FAKE_FIXTURES/model-$fam.txt"
: > "$model.new"
while IFS= read -r line; do
  case "$line" in
    "-A CROW-ENGINE-FENCE "*)
      line=$(printf '%s' "$line" | sed -E \
        -e 's#([[:space:]]-d[[:space:]]+)([0-9]+\.[0-9.]+)([[:space:]]|$)#\1\2/32\3#' \
        -e 's#([[:space:]]-d[[:space:]]+)([0-9A-Fa-f:]+)([[:space:]]|$)#\1\2/128\3#')
      printf '%s\n' "$line" >> "$model.new"
      ;;
  esac
done <<< "$stdin"
mv -f "$model.new" "$model"
exit 0
`;

const FAKE_TAILSCALE = String.raw`#!/usr/bin/env bash
set -u
printf 'tailscale %s\n' "$*" >> "$FAKE_LOG"
counter="$FAKE_FIXTURES/tailscale-calls-$2"
n=$(cat "$counter" 2>/dev/null || echo 0)
n=$((n + 1))
printf '%s\n' "$n" > "$counter"
if [ -f "$FAKE_FIXTURES/fail-tailscale" ]; then
  echo "Tailscale is not running" >&2
  exit 1
fi
case "$*" in
  "ip -4")
    if [ -f "$FAKE_FIXTURES/empty-first4" ] && [ "$n" -le 2 ]; then exit 0; fi
    cat "$FAKE_FIXTURES/tailscale-v4.txt"
    ;;
  "ip -6")
    if [ -f "$FAKE_FIXTURES/empty-first6" ] && [ "$n" -le 2 ]; then exit 0; fi
    cat "$FAKE_FIXTURES/tailscale-v6.txt"
    ;;
  *)
    echo "fake tailscale: unsupported $*" >&2
    exit 1
    ;;
esac
`;

const FAKE_DOCKER = String.raw`#!/usr/bin/env bash
set -u
printf 'docker %s\n' "$*" >> "$FAKE_LOG"
if [ -f "$FAKE_FIXTURES/docker-hang" ]; then
  : > "$FAKE_FIXTURES/docker-was-called"
  sleep 5
fi
case "$1" in
  info)
    if [ -f "$FAKE_FIXTURES/fail-docker-info" ]; then
      echo "Cannot connect to the Docker daemon" >&2
      exit 1
    fi
    cat "$FAKE_FIXTURES/docker-info.txt"
    ;;
  network)
    case "$2" in
      ls) cat "$FAKE_FIXTURES/docker-networks.txt" ;;
      inspect)
        if [ -f "$FAKE_FIXTURES/fail-network-inspect" ]; then
          echo "no such network" >&2
          exit 1
        fi
        cat "$FAKE_FIXTURES/docker-network-inspect.txt"
        ;;
      *) exit 64 ;;
    esac
    ;;
  ps) cat "$FAKE_FIXTURES/docker-ps.txt" ;;
  inspect) cat "$FAKE_FIXTURES/port-bindings.txt" ;;
  *) exit 64 ;;
esac
`;

const FAKE_SYSTEMCTL = String.raw`#!/usr/bin/env bash
set -u
printf 'systemctl %s\n' "$*" >> "$FAKE_LOG"
echo active
exit 0
`;

const FAKE_FLOCK = String.raw`#!/usr/bin/env bash
set -u
printf 'flock %s\n' "$*" >> "$FAKE_LOG"
exit 0
`;

const FAKE_DOCKER_UNIT = `[Unit]
Description=Docker Application Container Engine
[Service]
ExecStart=/usr/bin/dockerd -H fd:// --iptables=false
`;

const DEFAULT_FIXTURES = {
  "version-iptables.txt": "iptables v1.8.9 (nf_tables)\n",
  "version-ip6tables.txt": "ip6tables v1.8.9 (nf_tables)\n",
  "docker-info.txt": '{"Driver":"iptables"}\n',
  "docker-networks.txt": "abc123def456\n",
  "docker-network-inspect.txt": "crow-eng-ex|docker\n",
  "docker-ps.txt": "aaaabbbbcccc\n",
  "port-bindings.txt": `${TAILNET_V4}|8003\n`,
  "tailscale-v4.txt": `${TAILNET_V4}\n`,
  "tailscale-v6.txt": `${TAILNET_V6}\n`,
  "old-rules.txt": "",
  "docker.service": FAKE_DOCKER_UNIT,
};

/**
 * A scratch box: fake binaries, the fixture dir the fakes read (and the tests
 * write failure markers into), the conf, the daemon.json, and the state dir.
 */
function setup({ conf = BASE_CONF, fixtures = {}, daemonJson = '{"log-driver":"json-file"}\n' } = {}) {
  const root = mkdtempSync(join(tmpdir(), "crow-engine-fence-"));
  const bin = join(root, "bin");
  const dir = join(root, "fixtures");
  const stateDir = join(root, "run");
  const dropin = join(root, "dropin");
  for (const d of [bin, dir, stateDir, dropin]) {
    mkdirSync(d, { recursive: true });
    chmodSync(d, 0o750);
  }
  for (const [name, body] of Object.entries({ ...DEFAULT_FIXTURES, ...fixtures })) {
    if (body === null) continue;
    writeFileSync(join(dir, name), body);
  }
  writeFileSync(join(dir, "daemon.json"), daemonJson);
  writeFileSync(join(dropin, "10-fence.conf"), "[Service]\nEnvironment=DOCKER_OPTS=\n");

  const fake = (name, body) => {
    writeFileSync(join(bin, name), body.replace(/FAMILY/g, name.replace(/-restore$/, "")));
    chmodSync(join(bin, name), 0o755);
  };
  fake("iptables", FAKE_IPTABLES);
  fake("ip6tables", FAKE_IPTABLES);
  fake("iptables-restore", FAKE_RESTORE);
  fake("ip6tables-restore", FAKE_RESTORE);
  fake("tailscale", FAKE_TAILSCALE);
  fake("docker", FAKE_DOCKER);
  fake("systemctl", FAKE_SYSTEMCTL);
  fake("flock", FAKE_FLOCK);

  const ctx = {
    root,
    bin,
    fixtures: dir,
    stateDir,
    dropin,
    log: join(root, "calls.log"),
    conf: join(root, "etc", "engine-fence.conf"),
    facts: join(root, "etc", "engine-fence.facts.json"),
    state: join(stateDir, "state.json"),
    daemonJson: join(dir, "daemon.json"),
    unit: join(dir, "docker.service"),
  };
  mkdirSync(join(root, "etc"), { recursive: true });
  writeFileSync(ctx.conf, conf);
  writeFileSync(ctx.log, "");
  return ctx;
}

function envOf(ctx, extra = {}) {
  return {
    PATH: `${ctx.bin}:${process.env.PATH}`,
    HOME: ctx.root,
    TMPDIR: join(ctx.root, "tmp"),
    FAKE_FIXTURES: ctx.fixtures,
    FAKE_LOG: ctx.log,
    CROW_ENGINE_FENCE_CONF: ctx.conf,
    CROW_ENGINE_FENCE_FACTS: ctx.facts,
    CROW_ENGINE_FENCE_STATE: ctx.state,
    CROW_ENGINE_FENCE_GROUP: GROUP,
    CROW_ENGINE_FENCE_DAEMON_JSON: ctx.daemonJson,
    CROW_ENGINE_FENCE_DOCKER_DROPIN_DIR: ctx.dropin,
    CROW_ENGINE_FENCE_DOCKER_UNIT: ctx.unit,
    CROW_ENGINE_FENCE_TAILSCALE_WAIT: "0",
    CROW_ENGINE_FENCE_LOCK_WAIT: "5",
    ...extra,
  };
}

const run = (ctx, args = [], extra = {}) =>
  spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: envOf(ctx, extra),
    timeout: 60_000,
  });

const calls = (ctx) => readFileSync(ctx.log, "utf8").split("\n").filter(Boolean);
const clearCalls = (ctx) => writeFileSync(ctx.log, "");
const dockerCalls = (ctx) => calls(ctx).filter((line) => line.startsWith("docker "));

const restoreInput = (ctx, fam = "iptables") =>
  readFileSync(join(ctx.fixtures, `restore-input-${fam}.txt`), "utf8").trimEnd().split("\n");

const rulesOf = (ctx, fam = "iptables") => {
  const lines = restoreInput(ctx, fam);
  assert.equal(lines[0], "*raw", "the transaction declares the raw table");
  assert.equal(lines[1], ":CROW-ENGINE-FENCE - [0:0]", "the chain is declared");
  assert.equal(lines.at(-1), "COMMIT", "one transaction, one COMMIT");
  return lines.slice(2, -1);
};

/** The live chain, as a real `iptables -t raw -S` would print it. */
function liveRules(ctx, fam = "iptables") {
  const r = spawnSync("bash", ["-c", `iptables=${fam === "iptables" ? "iptables" : "ip6tables"}; "$iptables" -t raw -S`], {
    encoding: "utf8",
    env: envOf(ctx),
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split("\n").filter(Boolean);
}

const factsOf = (ctx) => JSON.parse(readFileSync(ctx.facts, "utf8"));
const stateOf = (ctx) => JSON.parse(readFileSync(ctx.state, "utf8"));

/** check + apply, asserting both succeeded. */
function applyGolden(ctx) {
  const r = run(ctx, ["apply"]);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  return r;
}

// ─── Usage and the conf ─────────────────────────────────────────────────────

test("--help lists the six commands and writes nothing", () => {
  const ctx = setup();
  const help = run(ctx, ["--help"]);
  assert.equal(help.status, 0);
  for (const word of ["check", "apply --boot", "status", "remove <id>", "swap-check", "interface"]) {
    assert.ok(help.stdout.includes(word), `help names ${word}`);
  }
  assert.deepEqual(calls(ctx), []);
  assert.equal(existsSync(ctx.state), false);
});

test("an unknown command is a usage error", () => {
  const ctx = setup();
  const r = run(ctx, ["frobnicate"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command/);
});

test("a missing conf refuses before anything else", () => {
  const ctx = setup();
  spawnSync("rm", ["-f", ctx.conf]);
  const r = run(ctx, ["check"]);
  assert.equal(r.status, 10);
  assert.match(r.stderr, /no conf at/);
  assert.deepEqual(dockerCalls(ctx), []);
  assert.equal(existsSync(join(ctx.fixtures, "restore-input-iptables.txt")), false);
});

// ─── check: the interactive facts ───────────────────────────────────────────

test("check reads the flavour, the backend and the bridge, and saves the facts file", () => {
  const ctx = setup();
  const r = run(ctx, ["check"]);
  assert.equal(r.status, 0, r.stderr);

  const facts = factsOf(ctx);
  assert.equal(facts.backend.iptables_flavour, "nf_tables");
  assert.equal(facts.backend.docker_firewall_backend, "iptables");
  assert.equal(facts.bridges["crow-eng-ex"].label_ok, true);
  assert.equal(facts.bridges["crow-eng-ex"].network_id, "abc123def456");
  assert.match(facts.conf_sha256, /^[0-9a-f]{64}$/);
  assert.match(facts.docker_flags_sha256, /^[0-9a-f]{64}$/);
  assert.ok(Number.isFinite(Date.parse(facts.saved_at)));
  assert.equal(statSync(ctx.facts).mode & 0o777, 0o640);

  const log = calls(ctx);
  assert.ok(log.includes("docker info --format {{json .FirewallBackend}}"), "the backend comes from docker info");
  assert.ok(log.includes("docker network ls --format {{.ID}}"), "the networks are enumerated");
  assert.equal(log.filter((l) => l.startsWith("docker network inspect")).length, 1);
  // check never touches a rule.
  assert.equal(log.filter((l) => l.includes("-restore")).length, 0);
});

test("refusals are distinct and leave no rule behind", () => {
  const cases = [
    { name: "unknown iptables flavour", fixtures: { "version-iptables.txt": "iptables v1.8.9 (pf)\n" }, code: 13, re: /unknown iptables flavour/ },
    { name: "unreadable docker", fixtures: { "fail-docker-info": "" }, code: 14, re: /cannot read the Docker firewall backend/ },
    { name: "nftables backend", fixtures: { "docker-info.txt": '{"Driver":"nftables"}\n' }, code: 15, re: /nftables/ },
    { name: "unknown backend", fixtures: { "docker-info.txt": '{"Driver":"something-else"}\n' }, code: 15, re: /unknown Docker firewall backend/ },
    { name: "missing bridge network", fixtures: { "docker-network-inspect.txt": "br-other|docker\n" }, code: 16, re: /no Docker network uses the bridge name/ },
    { name: "unreadable network inspect", fixtures: { "fail-network-inspect": "" }, code: 16, re: /cannot inspect Docker network/ },
  ];
  for (const c of cases) {
    const ctx = setup({ fixtures: c.fixtures });
    const r = run(ctx, ["apply"]);
    assert.equal(r.status, c.code, `${c.name}: ${r.stderr}`);
    assert.match(r.stderr, c.re, c.name);
    assert.equal(existsSync(join(ctx.fixtures, "restore-input-iptables.txt")), false, `${c.name}: no rule was loaded`);
    assert.equal(existsSync(ctx.facts), false, `${c.name}: no facts written on a refusal`);
  }
});

test("the conf is validated before any rule is touched", () => {
  const bad = [
    { conf: "interface tailscale0\nnonsense 1\n", code: 11, re: /unknown directive/ },
    { conf: "publish tailnet 8003\n", code: 11, re: /no 'interface' directive/ },
    { conf: "interface tailscale0\n", code: 11, re: /no 'publish' directive/ },
    { conf: "interface tailscale0\npublish tailnet 99999\n", code: 11, re: /not a port/ },
    { conf: "interface tailscale0\npublish tailnet 8003\npublish port-only 8003\n", code: 12, re: /published twice/ },
    { conf: "interface tailscale0\npublish port-only 8030\nbridge docker0\n", code: 12, re: /can never be exempted/ },
    { conf: "interface tailscale0\npublish lan 0.0.0.0 8011 consumer 192.0.2.20\n", code: 12, re: /wildcard or empty address/ },
    { conf: "interface tailscale0\npublish lan 192.0.2.10 8011\n", code: 12, re: /needs a consumer list/ },
    { conf: "interface tailscale0\npublish tailnet 8003 consumer 192.0.2.20\n", code: 12, re: /carries no source exemptions/ },
    { conf: "interface tailscale0\npublish port-only 8030 consumer 192.0.2.20\n", code: 12, re: /no destination to scope a consumer/ },
    { conf: "interface tailscale0\npublish lan 192.0.2.10 8011 consumer 192.0.2.0/24\n", code: 12, re: /confirm-range/ },
    { conf: "interface tailscale0\npublish lan 127.0.0.1 8011 consumer 192.0.2.20\n", code: 12, re: /loopback/ },
  ];
  for (const c of bad) {
    const ctx = setup({ conf: c.conf });
    const r = run(ctx, ["apply"]);
    assert.equal(r.status, c.code, `${c.conf}: ${r.stderr}`);
    assert.match(r.stderr, c.re);
    assert.equal(existsSync(join(ctx.fixtures, "restore-input-iptables.txt")), false);
    assert.deepEqual(dockerCalls(ctx), [], "a bad conf is refused before docker is asked anything");
  }
});

test("a consumer range is accepted only with the operator's confirm-range token", () => {
  const ctx = setup({
    conf: "interface tailscale0\npublish lan 192.0.2.10 8011 consumer 192.0.2.0/24 confirm-range\n",
  });
  const r = run(ctx, ["apply"]);
  assert.equal(r.status, 0, r.stderr);
  const drop = rulesOf(ctx).find((line) => line.endsWith("-j DROP"));
  assert.match(drop, /-d 192\.0\.2\.10/);
  assert.ok(rulesOf(ctx).some((line) => line.includes("-s 192.0.2.0/24")), "the range is the exemption");
});

// ─── apply: the rule text ───────────────────────────────────────────────────

test("apply builds the approved rules: interface-pinned, tagged, exemptions first, v4 and v6", () => {
  const ctx = setup();
  applyGolden(ctx);

  const v4 = rulesOf(ctx);
  // 8003 tailnet: lo, bridge, DROP.
  assert.match(v4[0], /^-A CROW-ENGINE-FENCE -d 100\.64\.20\.5 -p tcp -m tcp --dport 8003 -i lo -m comment --comment "crow-engine-fence:tailnet-8003:g\d+:exempt-lo" -j RETURN$/);
  assert.match(v4[1], /^-A CROW-ENGINE-FENCE -d 100\.64\.20\.5 -p tcp -m tcp --dport 8003 -i crow-eng-ex .* -j RETURN$/);
  assert.match(v4[2], /^-A CROW-ENGINE-FENCE -d 100\.64\.20\.5 -p tcp -m tcp --dport 8003 ! -i tailscale0 -m comment --comment "crow-engine-fence:tailnet-8003:g\d+" -j DROP$/);
  // 8030 port-only: the addrtype match, no destination.
  assert.ok(!v4[3].includes(" -d "), v4[3]);
  assert.match(v4[3], /^-A CROW-ENGINE-FENCE -p tcp -m tcp --dport 8030 -m addrtype --dst-type LOCAL -i lo /);
  assert.match(v4[5], /^-A CROW-ENGINE-FENCE -p tcp -m tcp --dport 8030 -m addrtype --dst-type LOCAL ! -i tailscale0 -m comment --comment "crow-engine-fence:portonly-8030:g\d+:portonly" -j DROP$/);
  // 8011 LAN: the consumer RETURN comes before the DROP.
  assert.equal(v4.length, 10);
  assert.match(v4[8], /--dport 8011 -s 192\.0\.2\.20 .* -j RETURN$/);
  assert.match(v4[9], /^-A CROW-ENGINE-FENCE -d 192\.0\.2\.10 -p tcp -m tcp --dport 8011 ! -i tailscale0 -m comment --comment "crow-engine-fence:lan-8011:g\d+" -j DROP$/);

  // Every DROP is directly preceded by its last exemption: line indices, not
  // just presence.
  for (let i = 0; i < v4.length; i++) {
    if (!v4[i].endsWith("-j DROP")) continue;
    assert.ok(v4[i - 1].endsWith("-j RETURN"), `an exemption precedes the drop at ${i}`);
  }
  assert.equal(v4.filter((line) => line.endsWith("-j RETURN")).length, 7, "lo and bridge RETURNs for every publish, plus the consumer");

  // v6: the tailnet address and the port-only rule, and no v4 LAN rule.
  const v6 = rulesOf(ctx, "ip6tables");
  assert.ok(v6.some((line) => line.includes("-d fd7a:115c:a1e0::20") && line.endsWith("-j DROP")));
  assert.ok(v6.some((line) => line.includes("--dport 8030") && line.includes("addrtype") && line.endsWith("-j DROP")));
  assert.equal(v6.filter((line) => line.includes("8011")).length, 0, "a v4 LAN address makes no v6 rule");
});

test("no rule carries conntrack, a source match or a second protocol", () => {
  const ctx = setup();
  applyGolden(ctx);
  for (const fam of ["iptables", "ip6tables"]) {
    const text = restoreInput(ctx, fam).join("\n");
    assert.doesNotMatch(text, /-m conntrack|--ctstate|--ctorigdstport/, `${fam}: no connection state`);
    assert.doesNotMatch(text, /-p udp/, `${fam}: engines are TCP`);
    assert.match(text, /! -i tailscale0/, `${fam}: every DROP is interface-pinned`);
    // A tailnet publish carries no source exemptions: only the LAN publish does.
    for (const line of text.split("\n")) {
      if (line.includes("--dport 8003") || line.includes("--dport 8030")) {
        assert.ok(!/-s /.test(line), `${fam}: no source match on a tailnet/port-only publish: ${line}`);
      }
    }
  }
});

test("the chain is filled before it is jumped to, once", () => {
  const ctx = setup();
  applyGolden(ctx);
  const log = calls(ctx);
  const restoreAt = log.findIndex((line) => line.startsWith("iptables-restore"));
  const insertAt = log.findIndex((line) => line === "iptables -t raw -I PREROUTING 1 -j CROW-ENGINE-FENCE");
  assert.ok(restoreAt >= 0, "the chain is loaded");
  assert.ok(insertAt > restoreAt, "the jump comes after the COMMIT");
  assert.equal(log.filter((line) => line === "iptables -t raw -I PREROUTING 1 -j CROW-ENGINE-FENCE").length, 1);
  assert.equal(log.filter((line) => line === "ip6tables -t raw -I PREROUTING 1 -j CROW-ENGINE-FENCE").length, 1);
  assert.equal(log.filter((line) => line.startsWith("iptables-restore")).length, 1, "one transaction per family");
  assert.equal(log.filter((line) => line.startsWith("ip6tables-restore")).length, 1);
  assert.ok(log.includes("iptables -t raw -C PREROUTING -j CROW-ENGINE-FENCE"), "the jump is checked first");
});

test("apply is idempotent: identical transaction, identical -S, no second insert", () => {
  const ctx = setup();
  applyGolden(ctx);
  const firstV4 = restoreInput(ctx, "iptables").join("\n");
  const firstV6 = restoreInput(ctx, "ip6tables").join("\n");
  const liveBefore = liveRules(ctx);

  const second = run(ctx, ["apply"]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(restoreInput(ctx, "iptables").join("\n"), firstV4, "the same v4 transaction");
  assert.equal(restoreInput(ctx, "ip6tables").join("\n"), firstV6, "the same v6 transaction");
  assert.deepEqual(liveRules(ctx), liveBefore, "the live chain is unchanged");
  assert.equal(
    calls(ctx).filter((line) => line === "iptables -t raw -I PREROUTING 1 -j CROW-ENGINE-FENCE").length,
    1,
    "the jump is inserted once",
  );
  assert.equal(stateOf(ctx).generation, stateOf(ctx).generation, "the generation is stable across applies");
});

test("the tailnet address is resolved at apply time and appears nowhere in the script", () => {
  const script = readFileSync(SCRIPT, "utf8");
  assert.doesNotMatch(script, /\b\d{1,3}(?:\.\d{1,3}){3}\b/, "no IPv4 literal in the script");
  assert.doesNotMatch(script, /ts\.net/i, "no tailnet name in the script");
  assert.doesNotMatch(script, /fd[0-9a-f]{2}:/i, "no ULA literal in the script");

  const ctx = setup();
  applyGolden(ctx);
  assert.match(restoreInput(ctx, "iptables").join("\n"), /-d 100\.64\.20\.5 /);

  // Change the address the fake reports: the rules follow it.
  writeFileSync(join(ctx.fixtures, "tailscale-v4.txt"), "100.64.20.9\n");
  const again = run(ctx, ["apply"]);
  assert.equal(again.status, 0, again.stderr);
  const text = restoreInput(ctx, "iptables").join("\n");
  assert.match(text, /-d 100\.64\.20\.9 /);
  assert.doesNotMatch(text, /100\.64\.20\.5/, "the old address is gone");
});

// ─── The state file ─────────────────────────────────────────────────────────

test("the state file is 0640 root:<group> inside a 0750 <group> directory (F1)", () => {
  const ctx = setup();
  applyGolden(ctx);

  assert.equal(statSync(ctx.stateDir).mode & 0o777, 0o750, "the RuntimeDirectory is 0750");
  assert.equal(statSync(ctx.state).mode & 0o777, 0o640, "the state file is 0640");
  const group = execFileSync("stat", ["-c", "%G", ctx.state], { encoding: "utf8" }).trim();
  assert.equal(group, GROUP, "the gateway's group can read it");
  assert.equal(execFileSync("stat", ["-c", "%G", ctx.stateDir], { encoding: "utf8" }).trim(), GROUP);

  const state = stateOf(ctx);
  assert.match(state.generation, /^g\d+$/);
  assert.ok(Number.isFinite(Date.parse(state.applied_at)));
  assert.deepEqual(state.backend, { iptables_flavour: "nf_tables", docker_firewall_backend: "iptables" });
  assert.deepEqual(state.tailnet, { v4: TAILNET_V4, v6: TAILNET_V6 });
  assert.equal(state.rules.length, 5, "8003 v4/v6, 8030 v4/v6, 8011 v4");

  const addressed = state.rules.find((r) => r.id === "tailnet-8003" && r.family === "v4");
  assert.equal(addressed.addr, TAILNET_V4);
  assert.equal(addressed.kind, "addressed");
  assert.equal(addressed.port, 8003);
  assert.equal(addressed.if, "tailscale0");
  assert.deepEqual(addressed.exempt, ["lo", "crow-eng-ex"]);

  const portOnly = state.rules.find((r) => r.id === "portonly-8030" && r.family === "v4");
  assert.equal(portOnly.addr, null);
  assert.equal(portOnly.kind, "port-only");

  const lan = state.rules.find((r) => r.id === "lan-8011");
  assert.deepEqual(lan.exempt, ["lo", "crow-eng-ex", "192.0.2.20"]);

  // No process names, no environment, no address beyond the resolved tailnet one.
  const text = readFileSync(ctx.state, "utf8");
  assert.doesNotMatch(text, /PATH|HOME=|env|command/i);
});

// ─── The S5a cross-check ────────────────────────────────────────────────────

test("the live -S lines are recognised as FENCED by the S5a reader (addressed and port-only)", () => {
  const ctx = setup();
  applyGolden(ctx);

  const v4live = liveRules(ctx);
  const v6live = liveRules(ctx, "v6");
  const files = readdirSync(ctx.fixtures).sort();
  assert.ok(v4live.filter((line) => line.includes(CROW_ENGINE_FENCE)).length >= 3, `live v4: ${JSON.stringify(v4live)} files: ${JSON.stringify(files)}`);
  assert.ok(v6live.filter((line) => line.includes(CROW_ENGINE_FENCE)).length >= 3, `live v6: ${JSON.stringify(v6live)}`);

  const snapshot = {
    taken_at: new Date().toISOString(),
    docker: { version: "28.0.1", firewall_backend: "iptables" },
    fence: { unit_active: true },
    tailscale: { v4: TAILNET_V4, v6: TAILNET_V6 },
    containers: [
      {
        id: "aaaabbbbcccc",
        name: "crow-engine-35b",
        labels: { "crow.runtime": "docker" },
        host_config: { network_mode: "default", port_bindings: { "8003/tcp": [{ HostIp: TAILNET_V4, HostPort: "8003" }] } },
        networks: ["crow-eng-ex"],
      },
      {
        id: "dddddeeeeffff",
        name: "crow-engine-migrating",
        labels: { "crow.runtime": "docker" },
        host_config: { network_mode: "default", port_bindings: { "8030/tcp": [{ HostIp: TAILNET_V6, HostPort: "8030" }] } },
        networks: ["crow-eng-ex"],
      },
    ],
    listeners: [],
    raw_rules: { v4: v4live, v6: v6live },
  };
  const path = join(ctx.root, "snapshot.json");
  writeFileSync(path, JSON.stringify(snapshot));

  const audit = inspectPublishedPorts({
    nowMs: Date.now(),
    snapshotPath: path,
    repoBundlesDir: NO_BUNDLES,
    installedBundlesDir: NO_BUNDLES,
  });
  assert.equal(audit.status, "ok");
  assert.equal(audit.trusted, true);
  assert.equal(audit.fence.ruleCount > 0, true);

  const v4 = audit.publishes.find((p) => p.containerId === "aaaabbbbcccc");
  assert.equal(v4.kind, "tailnet");
  assert.equal(v4.severity, "info", JSON.stringify(v4));
  assert.equal(v4.code, "fenced");
  assert.equal(v4.fenced, "addressed");

  const portOnly = audit.publishes.find((p) => p.containerId === "dddddeeeeffff");
  assert.equal(portOnly.kind, "tailnet");
  assert.equal(portOnly.severity, "info", JSON.stringify(portOnly));
  assert.equal(portOnly.code, "fenced-port-only", "a port-only rule counts as fenced (M3/N3)");
  assert.equal(portOnly.fenced, "port-only");
});

// ─── The boot path ──────────────────────────────────────────────────────────

test("apply --boot makes zero docker calls", () => {
  const cases = [
    { name: "good conf with bridges", conf: BASE_CONF, fixtures: {} },
    { name: "no bridges", conf: "interface tailscale0\npublish tailnet 8003\n", fixtures: {} },
    { name: "no daemon.json (Docker default backend)", conf: BASE_CONF, fixtures: {}, daemonJson: null },
    { name: "explicit iptables backend", conf: BASE_CONF, fixtures: {}, daemonJson: '{"firewall-backend":"iptables"}\n' },
    { name: "stale facts hash", conf: BASE_CONF, fixtures: {}, mutate: (ctx) => writeFileSync(ctx.conf, BASE_CONF + "# edited\n") },
    { name: "nftables backend", conf: BASE_CONF, fixtures: {}, daemonJson: '{"firewall-backend":"nftables"}\n' },
  ];
  for (const c of cases) {
    const ctx = setup({ conf: c.conf, fixtures: c.fixtures, ...(c.daemonJson === null ? {} : { daemonJson: c.daemonJson ?? '{"log-driver":"json-file"}\n' }) });
    if (c.daemonJson === null) spawnSync("rm", ["-f", ctx.daemonJson]);
    const checked = run(ctx, ["check"]);
    assert.equal(checked.status, 0, `${c.name}: ${checked.stderr}`);
    if (c.mutate) c.mutate(ctx);
    clearCalls(ctx);
    const r = run(ctx, ["apply", "--boot"]);
    assert.deepEqual(dockerCalls(ctx), [], `${c.name}: the fake docker's call log stays empty`);
    // A stale conf and an nftables backend are refusals; the rest apply.
    assert.ok([0, 15, 18].includes(r.status), `${c.name}: exit ${r.status} ${r.stderr}`);
  }
});

test("apply --boot never waits on a docker that would block", () => {
  const ctx = setup({ fixtures: { "docker-hang": "" } });
  const checked = run(ctx, ["check"]);
  assert.equal(checked.status, 0, checked.stderr);
  spawnSync("rm", ["-f", join(ctx.fixtures, "docker-hang"), join(ctx.fixtures, "docker-was-called")]);
  writeFileSync(join(ctx.fixtures, "docker-hang"), "");
  clearCalls(ctx);
  const started = Date.now();
  const r = run(ctx, ["apply", "--boot"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - started < 10_000, "boot mode did not wait for docker");
  assert.equal(existsSync(join(ctx.fixtures, "docker-was-called")), false, "docker was never invoked");
});

test("boot mode refuses a missing or stale facts file, naming the command to run", () => {
  const missing = setup();
  const r1 = run(missing, ["apply", "--boot"]);
  assert.equal(r1.status, 17);
  assert.match(r1.stderr, /crow-engine-fence check/);
  assert.equal(existsSync(join(missing.fixtures, "restore-input-iptables.txt")), false);

  const stale = setup();
  assert.equal(run(stale, ["check"]).status, 0);
  writeFileSync(stale.conf, BASE_CONF + "# the operator edited the conf\n");
  const r2 = run(stale, ["apply", "--boot"]);
  assert.equal(r2.status, 18);
  assert.match(r2.stderr, /the conf changed since the last check/);
  assert.match(r2.stderr, /crow-engine-fence check/);

  const flags = setup();
  assert.equal(run(flags, ["check"]).status, 0);
  writeFileSync(flags.daemonJson, '{"firewall-backend":"iptables","log-driver":"local"}\n');
  const r3 = run(flags, ["apply", "--boot"]);
  assert.equal(r3.status, 18);
  assert.match(r3.stderr, /Docker firewall flags changed/);
});

test("an unresolvable tailnet address yields port-only rules and a successful unit", () => {
  for (const fixture of [{ "tailscale-v4.txt": "", "tailscale-v6.txt": "" }, { "tailscale-v4.txt": "not-an-address\n", "tailscale-v6.txt": "garbage\n" }, { "fail-tailscale": "" }]) {
    const ctx = setup({ fixtures: fixture });
    assert.equal(run(ctx, ["check"]).status, 0);
    const r = run(ctx, ["apply", "--boot"]);
    assert.equal(r.status, 0, `${JSON.stringify(fixture)}: ${r.stderr}`);
    assert.match(r.stderr, /port-only/);

    for (const fam of ["iptables", "ip6tables"]) {
      const rules = rulesOf(ctx, fam);
      const drops = rules.filter((line) => line.endsWith("-j DROP"));
      assert.equal(drops.length, fam === "iptables" ? 3 : 2, `${fam}: one DROP per publish in that family`);
      for (const line of drops) {
        if (line.includes("8011")) continue; // a `publish lan` never falls back: its address is in the conf
        assert.doesNotMatch(line, / -d /, `${fam}: no destination match in the fallback`);
        assert.match(line, /-m addrtype --dst-type LOCAL/, `${fam}: LOCAL destinations only`);
        assert.match(line, /! -i tailscale0/);
        assert.match(line, /:portonly" -j DROP$/);
      }
      const lan = drops.find((line) => line.includes("8011"));
      if (fam === "iptables") {
        assert.match(lan, /-d 192\.0\.2\.10/);
        assert.doesNotMatch(lan, /portonly/);      } else {
        assert.equal(lan, undefined, "a v4 LAN address makes no v6 rule");
      }
      assert.equal(rules.filter((line) => line.endsWith("-j RETURN")).length, fam === "iptables" ? 7 : 4, "lo and bridge RETURNs stay");
    }
    const state = stateOf(ctx);
    assert.equal(state.tailnet.v4, null);
    assert.equal(
      state.rules.filter((rule) => rule.id !== "lan-8011").every((rule) => rule.kind === "port-only"),
      true,
      "the tailnet publishes fall back; a publish lan never does",
    );
  }
});

test("the re-apply runs upgrade port-only rules to addressed ones, then do nothing", () => {
  const ctx = setup({ fixtures: { "empty-first4": "", "empty-first6": "" } });
  assert.equal(run(ctx, ["check"]).status, 0);

  const first = run(ctx, ["apply", "--boot"]);
  assert.equal(first.status, 0, first.stderr);
  assert.ok(rulesOf(ctx).some((line) => line.includes(":portonly")), "run 1 is port-only");
  assert.equal(stateOf(ctx).tailnet.v4, null);

  const second = run(ctx, ["apply", "--boot"]);
  assert.equal(second.status, 0, second.stderr);
  assert.ok(rulesOf(ctx).some((line) => line.includes(":portonly")), "run 2 is still port-only");

  const third = run(ctx, ["apply", "--boot"]);
  assert.equal(third.status, 0, third.stderr);
  const v4 = rulesOf(ctx);
  assert.ok(v4.some((line) => line.includes("-d 100.64.20.5") && line.endsWith("-j DROP")), "run 3 is addressed");
  assert.equal(stateOf(ctx).tailnet.v4, TAILNET_V4);

  // Addressed: the next run is a real no-op — the same rules, and no rewrite of
  // the state file (a rewrite would make every snapshot look stale to S6b).
  const before = statSync(ctx.state).ino;
  const beforeText = readFileSync(ctx.state, "utf8");
  const liveBefore = liveRules(ctx);
  const fourth = run(ctx, ["apply", "--boot"]);
  assert.equal(fourth.status, 0, fourth.stderr);
  assert.deepEqual(liveRules(ctx), liveBefore);
  assert.equal(statSync(ctx.state).ino, before, "the state file was not replaced");
  assert.equal(readFileSync(ctx.state, "utf8"), beforeText, "applied_at did not move");

  const help = readFileSync(REAPPLY, "utf8");
  assert.doesNotMatch(help.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).join("\n"), /systemctl|Requires=|PartOf=/);
});

test("facts for a bridge are required by boot mode, and a missing Crow label refuses", () => {
  const unlabelled = setup({ fixtures: { "docker-network-inspect.txt": "crow-eng-ex|\n" } });
  assert.equal(run(unlabelled, ["check"]).status, 0, "check records the fact");
  assert.equal(factsOf(unlabelled).bridges["crow-eng-ex"].label_ok, false);
  const r1 = run(unlabelled, ["apply", "--boot"]);
  assert.equal(r1.status, 16);
  assert.match(r1.stderr, /has no recorded Crow label/);

  const forgotten = setup();
  assert.equal(run(forgotten, ["check"]).status, 0);
  const text = readFileSync(forgotten.facts, "utf8").replace(/"bridges": \{[\s\S]*?\n  \},/, '"bridges": {},');
  writeFileSync(forgotten.facts, text);
  const r2 = run(forgotten, ["apply", "--boot"]);
  assert.equal(r2.status, 16);
  assert.match(r2.stderr, /knows nothing about the bridge/);
});

test("without ip6tables no v6 rule is written and the run still succeeds", () => {
  const ctx = setup({ fixtures: { "no-ip6tables": "" } });
  assert.equal(run(ctx, ["check"]).status, 0);
  const r = run(ctx, ["apply", "--boot"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /ip6tables is not installed/);
  assert.equal(existsSync(join(ctx.fixtures, "restore-input-ip6tables.txt")), false);
  assert.equal(stateOf(ctx).rules.every((rule) => rule.family === "v4"), true);
});

test("a failing restore leaves the rules as they were and says so", () => {
  const ctx = setup({ fixtures: { "fail-restore-iptables": "" } });
  assert.equal(run(ctx, ["check"]).status, 0);
  const r = run(ctx, ["apply", "--boot"]);
  assert.equal(r.status, 19);
  assert.match(r.stderr, /live rules were left as they were/);
  assert.equal(existsSync(join(ctx.fixtures, "jump-iptables")), false, "no jump was added");
});

// ─── status ─────────────────────────────────────────────────────────────────

test("status prints the rules, the addresses and the generation, and warns on a conf mismatch", () => {
  const ctx = setup();
  applyGolden(ctx);
  const r = run(ctx, ["status"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^generation: g\d+$/m);
  assert.match(r.stdout, new RegExp(`^tailnet: v4 ${TAILNET_V4.replace(/\./g, "\\.")}$`, "m"));
  assert.match(r.stdout, /^tailnet: v6 fd7a:115c:a1e0::20$/m);
  assert.match(r.stdout, /-A CROW-ENGINE-FENCE -d 100\.64\.20\.5\/32/, "the live rules are printed");
  assert.match(r.stdout, /to change rules: crow-engine-fence apply/);
  assert.match(r.stdout, /never: systemctl restart crow-engine-fence/);
  assert.doesNotMatch(r.stdout, /WARN/);

  writeFileSync(ctx.conf, BASE_CONF + "# edited\n");
  const stale = run(ctx, ["status"]);
  assert.equal(stale.status, 0);
  assert.match(stale.stdout, /WARN: the conf changed since the last check/);
});

test("status says port-only when there is no tailnet address", () => {
  const ctx = setup({ fixtures: { "tailscale-v4.txt": "", "tailscale-v6.txt": "" } });
  assert.equal(run(ctx, ["check"]).status, 0);
  assert.equal(run(ctx, ["apply", "--boot"]).status, 0);
  const r = run(ctx, ["status"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /port-only \(tailnet address unresolved\)/);
  assert.match(r.stdout, /^tailnet: v4 none$/m);
});

// ─── remove ─────────────────────────────────────────────────────────────────

test("remove edits the live rules only: one id, the others stay, the conf is untouched", () => {
  const ctx = setup();
  applyGolden(ctx);
  const confBefore = readFileSync(ctx.conf, "utf8");

  const r = run(ctx, ["remove", "tailnet-8003"]);
  assert.equal(r.status, 0, r.stderr);
  const v4 = rulesOf(ctx);
  assert.equal(v4.some((line) => line.includes("crow-engine-fence:tailnet-8003:")), false, "the id is gone");
  assert.ok(v4.some((line) => line.includes("crow-engine-fence:portonly-8030:")), "8030 survives");
  assert.ok(v4.some((line) => line.includes("crow-engine-fence:lan-8011:")), "8011 survives");
  assert.equal(readFileSync(ctx.conf, "utf8"), confBefore, "the conf is the operator's file");
  assert.equal(stateOf(ctx).rules.some((rule) => rule.id === "tailnet-8003"), false, "the state follows the live rules");

  const status = run(ctx, ["status"]);
  assert.match(status.stdout, /WARN: tailnet-8003 is in the conf but no live rule carries its tag/);
});

test("remove refuses an id that is not live", () => {
  const ctx = setup();
  applyGolden(ctx);
  const r = run(ctx, ["remove", "tailnet-9999"]);
  assert.equal(r.status, 20);
  assert.match(r.stderr, /no live rule is tagged/);
  assert.equal(run(ctx, ["remove"]).status, 2);
});

// ─── swap-check ─────────────────────────────────────────────────────────────

const OLD_RULES = `-A DOCKER-USER -m comment --comment "crow-engine-fence" -m conntrack --ctorigdstport 8030 -j RETURN
-A DOCKER-USER -m comment --comment "crow-engine-fence" -m conntrack --ctorigdstport 8030 -j DROP
`;

test("swap-check refuses a narrower destination coverage", () => {
  // New set: an addressed rule for 8030 on the tailnet address only. The live
  // publish is wildcard, so the old DOCKER-USER rule covers more destinations.
  const addressed = setup({
    conf: "interface tailscale0\npublish tailnet 8030\n",
    fixtures: { "old-rules.txt": OLD_RULES, "port-bindings.txt": "0.0.0.0|8030\n" },
  });
  const r1 = run(addressed, ["swap-check"]);
  assert.equal(r1.status, 20, r1.stdout);
  assert.match(r1.stdout, /port 8030: NOT COVERED/);
  assert.match(r1.stdout, /keep the old rules/);

  // A port-only rule covers every destination the old rule did.
  const portOnly = setup({
    conf: "interface tailscale0\npublish port-only 8030\n",
    fixtures: { "old-rules.txt": OLD_RULES, "port-bindings.txt": "0.0.0.0|8030\n" },
  });
  const r2 = run(portOnly, ["swap-check"]);
  assert.equal(r2.status, 0, r2.stdout);
  assert.match(r2.stdout, /port 8030: COVERED/);
  assert.match(r2.stdout, /delete the old rules by hand/);

  // An old port that the conf does not publish at all is a refusal.
  const missing = setup({
    conf: "interface tailscale0\npublish tailnet 8003\n",
    fixtures: { "old-rules.txt": OLD_RULES.replace(/8030/g, "8040") },
  });
  const r3 = run(missing, ["swap-check"]);
  assert.equal(r3.status, 20);
  assert.match(r3.stdout, /port 8040: MISSING from the conf/);

  // An addressed rule that matches the live address is covered too.
  const exact = setup({
    conf: "interface tailscale0\npublish tailnet 8030\n",
    fixtures: { "old-rules.txt": OLD_RULES, "port-bindings.txt": `${TAILNET_V4}|8030\n` },
  });
  const r4 = run(exact, ["swap-check"]);
  assert.equal(r4.status, 0, r4.stdout);
  assert.match(r4.stdout, /COVERED \(addressed rules for every live address\)/);
});

test("nothing in the script deletes a rule", () => {
  const script = readFileSync(SCRIPT, "utf8");
  for (const line of script.split("\n")) {
    assert.doesNotMatch(line, /\b(?:iptables|ip6tables)\b.*(?:^|\s)(?:-D|--delete|--delete-chain|-X|-F|--flush)(?:\s|$)/, line);
  }
  assert.doesNotMatch(script, /iptables-save|iptables-restore\s+[^-]/);
});

// ─── Units ──────────────────────────────────────────────────────────────────

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
const activeLines = (text) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith(";"));

test("unit lint: fail closed, no ExecStop, a RuntimeDirectory, CAP_CHOWN, no strict sandbox", () => {
  const dirs = directives(readFileSync(SERVICE, "utf8"));
  assert.equal(first(dirs, "Before"), "docker.service");
  assert.match(first(dirs, "After") ?? "", /tailscaled\.service/);
  assert.equal(first(dirs, "RequiredBy"), "docker.service");
  assert.equal(first(dirs, "Type"), "oneshot");
  assert.equal(first(dirs, "RemainAfterExit"), "yes");
  assert.equal(first(dirs, "ExecStart"), "/usr/local/sbin/crow-engine-fence apply --boot");
  assert.equal(dirs.ExecStop, undefined, "no ExecStop: stopping docker must not drop the fence");
  assert.equal(dirs.ExecStopPost, undefined);
  assert.equal(dirs.ExecStartPre, undefined, "no ExecStartPre: check talks to docker");
  assert.equal(first(dirs, "RuntimeDirectory"), "crow-engine-fence");
  assert.equal(first(dirs, "RuntimeDirectoryMode"), "0750");
  assert.match(first(dirs, "CapabilityBoundingSet") ?? "", /CAP_CHOWN/);
  assert.match(first(dirs, "CapabilityBoundingSet") ?? "", /CAP_NET_ADMIN/);
  for (const value of dirs.ProtectSystem || []) assert.notEqual(value, "strict");
  assert.equal(first(dirs, "NoNewPrivileges"), "yes");
  assert.equal(first(dirs, "EnvironmentFile"), "-/etc/crow/engine-fence.env");
  assert.equal(dirs.User, undefined, "root");
  assert.equal(dirs.Group, undefined);
  assert.equal(dirs.SupplementaryGroups, undefined);

  // Every ReadWritePaths entry is created by the unit or `-`-prefixed.
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
    assert.ok(created.some((path) => value === path || value.startsWith(`${path}/`)), `ReadWritePaths=${value}`);
  }
});

test("unit lint: the wantedby variant differs only in its [Install] line", () => {
  const a = directives(readFileSync(SERVICE, "utf8"));
  const b = directives(readFileSync(WANTEDBY, "utf8"));
  assert.equal(first(b, "RequiredBy"), null);
  assert.equal(first(b, "WantedBy"), "docker.service");
  assert.equal(first(a, "WantedBy"), null);
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key === "RequiredBy" || key === "WantedBy") continue;
    assert.deepEqual(b[key] ?? null, a[key] ?? null, `${key} matches the default unit`);
  }
});

test("unit lint: the re-apply unit declares no RuntimeDirectory and restarts nothing", () => {
  const text = readFileSync(REAPPLY, "utf8");
  const dirs = directives(text);
  assert.equal(dirs.RuntimeDirectory, undefined, "the fence unit owns /run/crow-engine-fence");
  assert.equal(dirs.RuntimeDirectoryPreserve, undefined);
  assert.equal(dirs.Requires, undefined, "no Requires= on docker or the fence");
  assert.equal(dirs.PartOf, undefined);
  assert.equal(dirs.BindsTo, undefined);
  assert.equal(dirs.ExecStop, undefined);
  assert.equal(first(dirs, "ExecStart"), "/usr/local/sbin/crow-engine-fence apply --boot");
  for (const line of activeLines(text)) assert.doesNotMatch(line, /systemctl/, line);
  for (const line of activeLines(readFileSync(SERVICE, "utf8"))) assert.doesNotMatch(line, /systemctl/, line);
  for (const line of activeLines(readFileSync(WANTEDBY, "utf8"))) assert.doesNotMatch(line, /systemctl/, line);

  const timer = directives(readFileSync(TIMER, "utf8"));
  assert.equal(first(timer, "Unit"), "crow-engine-fence-reapply.service");
  assert.equal(first(timer, "WantedBy"), "timers.target");
  assert.ok(first(timer, "OnBootSec"), "a fast trigger after boot");
  assert.ok(first(timer, "OnUnitInactiveSec"), "a repeating trigger");
  for (const line of activeLines(readFileSync(TIMER, "utf8"))) assert.doesNotMatch(line, /systemctl/, line);
});

// ─── Hygiene and the doc ────────────────────────────────────────────────────

const DOC_RANGES = /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\./;

test("the shipped files carry no address literal, no tailnet name and no real host", () => {
  for (const file of [SCRIPT, SERVICE, WANTEDBY, REAPPLY, TIMER]) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /\b\d{1,3}(?:\.\d{1,3}){3}\b/, `${file}: no IPv4 literal`);
    assert.doesNotMatch(text, /ts\.net/i, `${file}: no tailnet name`);
    assert.doesNotMatch(text, /\b(?:fd[0-9a-f]{2}|fe80):/i, `${file}: no v6 literal`);
    assert.doesNotMatch(text, /https?:\/\//, `${file}: no URL`);
  }
  const conf = readFileSync(CONF_EXAMPLE, "utf8");
  for (const m of conf.matchAll(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/g)) {
    assert.match(m[1], DOC_RANGES, `${m[1]} must be a documentation range`);
  }
  assert.doesNotMatch(conf, /ts\.net/i);
});

test("the boot path contains no docker command word", () => {
  const script = readFileSync(SCRIPT, "utf8");
  const start = script.indexOf("# ─── boot path");
  const end = script.indexOf("# ─── end of the boot path");
  assert.ok(start > 0 && end > start, "the boot path is marked");
  const region = script.slice(start, end);
  for (const line of activeLines(region)) {
    assert.doesNotMatch(line, /(^|[^A-Za-z0-9_.-])docker[ \t]/, line);
    assert.doesNotMatch(line, /docker_call/, line);
  }
});

test("the install doc covers the fence: install, the two units, break-glass, re-apply, removal", () => {
  const text = readFileSync(DOC, "utf8");
  for (const needle of [
    "crow-engine-fence",
    "crow-engine-fence.service",
    "crow-engine-fence-wantedby.service",
    "crow-engine-fence-reapply.service",
    "crow-engine-fence-reapply.timer",
    "engine-fence.conf.example",
    "/etc/crow/engine-fence.conf",
    "/etc/crow/engine-fence.facts.json",
    "/run/crow-engine-fence/state.json",
    "systemctl disable crow-engine-fence",
    "never `mask`",
    "crow-engine-fence apply",
    "never `systemctl restart crow-engine-fence`",
    "CROW_ENGINE_FENCE_GROUP",
    "remove <id>",
  ]) {
    assert.ok(text.includes(needle), `the doc names ${needle}`);
  }
  assert.doesNotMatch(text, /https?:\/\//, "no URL");
  assert.doesNotMatch(text, /ts\.net/i, "no tailnet name");
});

// ─── Housekeeping ───────────────────────────────────────────────────────────

test("no temp file is left behind in the state directory", () => {
  const ctx = setup();
  applyGolden(ctx);
  assert.deepEqual(readdirSync(ctx.stateDir).filter((name) => name.startsWith(".state.")), []);
  assert.deepEqual(readdirSync(join(ctx.root, "etc")).filter((name) => name.startsWith(".engine-fence-facts.")), []);
});
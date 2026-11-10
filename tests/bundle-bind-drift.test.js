/**
 * Fix-it detector: an installed docker bundle runs with wider port binds than its
 * compose file now declares (security audit N8-1) — tests/bundle-bind-drift.test.js
 *
 * The compose refresh changes the installed file, but a running container keeps
 * the binds it was created with until the bundle is restarted. The detector
 * compares the installed compose's published ports (with `${VAR}` resolved from
 * the bundle's .env, the same way the rest of the bundle code expands them) with
 * the running containers' published binds (`docker inspect`), and raises one
 * "restart to apply" card per drifting bundle. It never restarts anything.
 *
 * Docker is never real here: every call goes through the detector's injected
 * runner. CROW_HOME is set to a scratch dir BEFORE the dynamic imports, so the
 * detector's defaults never read the real ~/.crow.
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

function put(root, relPath, content) {
  const p = join(root, relPath);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

let home;
let detector;
let SOURCE;
let COMPOSE_EDITED_SOURCE;
let LINK_REMEDIES;
let linkRemedyTarget;
let BOOT_CHECK_DETECTORS;
const silent = { warn() {}, log() {} };

before(async () => {
  home = mkdtempSync(join(tmpdir(), "crowhome-binddrift-"));
  process.env.CROW_HOME = home;
  const mod = await import("../servers/gateway/fix-it/detectors/bundle-bind-drift.js");
  detector = mod.default;
  SOURCE = mod.SOURCE;
  COMPOSE_EDITED_SOURCE = mod.COMPOSE_EDITED_SOURCE;
  const idx = await import("../servers/gateway/fix-it/index.js");
  LINK_REMEDIES = idx.LINK_REMEDIES;
  linkRemedyTarget = idx.linkRemedyTarget;
  BOOT_CHECK_DETECTORS = idx.BOOT_CHECK_DETECTORS;
});

after(() => {
  delete process.env.CROW_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
});

beforeEach(() => {
  rmSync(join(home, "bundles"), { recursive: true, force: true });
  rmSync(join(home, "installed.json"), { force: true });
});

/** An installed docker bundle in the scratch Crow home. */
function bundle(id, compose, { name = "Web", env = null } = {}) {
  put(home, `bundles/${id}/manifest.json`, JSON.stringify({
    id, name, version: "1.0.0", type: "bundle", docker: { composefile: "docker-compose.yml" },
  }));
  put(home, `bundles/${id}/docker-compose.yml`, compose);
  if (env !== null) put(home, `bundles/${id}/.env`, env);
}

function setInstalled(entries) {
  put(home, "installed.json", JSON.stringify(entries));
}

/** A store that records what the detector did, instead of a database. */
function fakeStore() {
  const upserts = [];
  const resolved = [];
  return {
    upserts,
    resolved,
    async upsertItem(item) { upserts.push(item); return { id: upserts.length, notify: false }; },
    async resolveByKey(source, key) { resolved.push(`${source}|${key}`); },
    async listBySource() { return []; },
    async recordDuplicate() {},
    async recordSuppressed() {},
    async markResolved() {},
  };
}

/** A `docker` CLI stand-in: `ps`/`inspect` answers from the fixture, never a real daemon. */
function dockerStub({ ps = ["container1"], inspect = [] } = {}) {
  const calls = [];
  const runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (args[0] === "ps") return { stdout: ps.join("\n"), stderr: "" };
    if (args[0] === "inspect") return { stdout: JSON.stringify(inspect), stderr: "" };
    return { stdout: "", stderr: "" };
  };
  runner.calls = calls;
  return runner;
}

/** One container's published ports, as `docker inspect` reports them. */
const inspected = (ports) => [{ NetworkSettings: { Ports: ports } }];

const WIDE = "0.0.0.0";

describe("fixed port publishes: running wider than compose", () => {
  const compose = 'services:\n  web:\n    image: x\n    ports:\n      - "127.0.0.1:8555:5000"\n';

  test("a running 0.0.0.0 bind while compose binds 127.0.0.1 → one card naming the bind", async () => {
    bundle("drift-wide", compose);
    setInstalled([{ id: "drift-wide" }]);
    const store = fakeStore();
    const runner = dockerStub({ inspect: inspected({ "5000/tcp": [{ HostIp: WIDE, HostPort: "8555" }] }) });

    await detector.check(store, { crowHome: home, runner, log: silent });

    assert.equal(store.upserts.length, 1);
    const card = store.upserts[0];
    assert.equal(card.source, SOURCE);
    assert.equal(card.dedupKey, "bundle:drift-wide");
    assert.equal(card.title, "Restart Web to apply its updated network settings");
    assert.match(card.why, /Web is still reachable on 0\.0\.0\.0:8555 from other devices/);
    assert.match(card.why, /keep it on this computer only/);
    assert.match(card.why, /Restart it on the Extensions page/);
    assert.deepEqual(card.remedies, [{ actionId: "open-extensions-page", kind: "link", label: "Open Extensions" }]);
    // The containers were looked up by the bundle's compose project label.
    assert.match(runner.calls[0].args.join(" "), /com\.docker\.compose\.project=drift-wide/);
    assert.equal(typeof runner.calls[0].opts.timeout, "number", "every docker call is time-bounded");
    assert.equal(typeof runner.calls[1].opts.timeout, "number");
  });

  test("running on the compose's own specific IP → no card, the card resolves itself", async () => {
    bundle("drift-equal", compose);
    setInstalled([{ id: "drift-equal" }]);
    const store = fakeStore();
    const runner = dockerStub({ inspect: inspected({ "5000/tcp": [{ HostIp: "127.0.0.1", HostPort: "8555" }] }) });

    await detector.check(store, { crowHome: home, runner, log: silent });

    assert.deepEqual(store.upserts, []);
    assert.ok(store.resolved.includes(`${SOURCE}|bundle:drift-equal`));
  });

  test("running narrower than a compose that publishes on every interface → no card", async () => {
    bundle("drift-narrow", 'services:\n  web:\n    ports:\n      - "8555:5000"\n');
    setInstalled([{ id: "drift-narrow" }]);
    const store = fakeStore();
    const runner = dockerStub({ inspect: inspected({ "5000/tcp": [{ HostIp: "127.0.0.1", HostPort: "8555" }] }) });

    await detector.check(store, { crowHome: home, runner, log: silent });

    assert.deepEqual(store.upserts, []);
  });

  test("a published port the compose no longer has → a card", async () => {
    bundle("drift-extra", compose);
    setInstalled([{ id: "drift-extra" }]);
    const store = fakeStore();
    const runner = dockerStub({
      inspect: inspected({
        "5000/tcp": [{ HostIp: "127.0.0.1", HostPort: "8555" }],
        "9000/tcp": [{ HostIp: WIDE, HostPort: "9000" }],
      }),
    });

    await detector.check(store, { crowHome: home, runner, log: silent });

    assert.equal(store.upserts.length, 1);
    assert.match(store.upserts[0].why, /0\.0\.0\.0:9000/);
    assert.match(store.upserts[0].why, /no longer publish that port/);
  });

  test("long-syntax ports with host_ip are read too", async () => {    bundle("drift-long", [
      "services:",
      "  web:",
      "    ports:",
      "      - target: 80",
      '        published: "8080"',
      "        host_ip: 127.0.0.1",
      "        protocol: tcp",
      "",
    ].join("\n"));
    setInstalled([{ id: "drift-long" }]);
    const store = fakeStore();
    const runner = dockerStub({ inspect: inspected({ "80/tcp": [{ HostIp: WIDE, HostPort: "8080" }] }) });

    await detector.check(store, { crowHome: home, runner, log: silent });

    assert.equal(store.upserts.length, 1);
    assert.match(store.upserts[0].why, /0\.0\.0\.0:8080/);
  });

  test("the same container port on tcp and udp is tracked separately", async () => {
    bundle("drift-proto", [
      "services:",
      "  web:",
      "    ports:",
      '      - "127.0.0.1:8555:8555/tcp"',
      '      - "127.0.0.1:8555:8555/udp"',
      "",
    ].join("\n"));
    setInstalled([{ id: "drift-proto" }]);
    const store = fakeStore();
    const runner = dockerStub({
      inspect: inspected({
        "8555/tcp": [{ HostIp: WIDE, HostPort: "8555" }],
        "8555/udp": [{ HostIp: "127.0.0.1", HostPort: "8555" }],
      }),
    });

    await detector.check(store, { crowHome: home, runner, log: silent });

    assert.equal(store.upserts.length, 1, "only the protocol that is still wide drifts");
    assert.equal(store.upserts[0].context.containerPort, "8555/tcp");
  });
});

describe("${VAR} resolution from the bundle .env", () => {
  test("the default in ${VAR:-127.0.0.1} counts as the expected bind", async () => {
    bundle("drift-default", 'services:\n  web:\n    ports:\n      - "${BIND:-127.0.0.1}:8555:5000"\n');
    setInstalled([{ id: "drift-default" }]);
    const store = fakeStore();
    const runner = dockerStub({ inspect: inspected({ "5000/tcp": [{ HostIp: WIDE, HostPort: "8555" }] }) });

    await detector.check(store, { crowHome: home, runner, log: silent });

    assert.equal(store.upserts.length, 1);
    assert.match(store.upserts[0].why, /0\.0\.0\.0:8555/);
  });

  test("a value from the bundle .env wins over the default", async () => {
    bundle("drift-env", 'services:\n  web:\n    ports:\n      - "${BIND:-0.0.0.0}:8555:5000"\n', { env: "BIND=127.0.0.1\n" });
    setInstalled([{ id: "drift-env" }]);
    const store = fakeStore();
    const runner = dockerStub({ inspect: inspected({ "5000/tcp": [{ HostIp: WIDE, HostPort: "8555" }] }) });

    await detector.check(store, { crowHome: home, runner, log: silent });

    assert.equal(store.upserts.length, 1);
  });
});

describe("nothing to say", () => {
  test("docker unavailable → no card, one log line", async () => {
    bundle("drift-nodocker", 'services:\n  web:\n    ports:\n      - "127.0.0.1:8555:5000"\n');
    setInstalled([{ id: "drift-nodocker" }]);
    const store = fakeStore();
    const lines = [];
    const runner = async () => { throw new Error("docker: not found"); };

    await detector.check(store, { crowHome: home, runner, log: { warn: (m) => lines.push(m) } });

    assert.deepEqual(store.upserts, []);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /docker is not reachable/);
  });

  test("a satellite-hosted bundle is skipped", async () => {
    bundle("drift-sat", 'services:\n  web:\n    ports:\n      - "127.0.0.1:8555:5000"\n');
    setInstalled([{ id: "drift-sat", mode: "satellite", host: "sat-1" }]);
    const store = fakeStore();
    const runner = dockerStub({ inspect: inspected({ "5000/tcp": [{ HostIp: WIDE, HostPort: "8555" }] }) });

    await detector.check(store, { crowHome: home, runner, log: silent });

    assert.deepEqual(store.upserts, []);
    assert.equal(runner.calls.length, 0, "no docker call for a bundle hosted elsewhere");
  });

  test("`only` limits the pass to the bundle that was just restarted", async () => {
    bundle("drift-only", 'services:\n  web:\n    ports:\n      - "127.0.0.1:8555:5000"\n');
    bundle("drift-other", 'services:\n  web:\n    ports:\n      - "127.0.0.1:8555:5000"\n');
    setInstalled([{ id: "drift-only" }, { id: "drift-other" }]);
    const store = fakeStore();
    const runner = dockerStub({ inspect: inspected({ "5000/tcp": [{ HostIp: WIDE, HostPort: "8555" }] }) });

    await detector.check(store, { crowHome: home, runner, only: ["drift-only"], log: silent });

    assert.equal(store.upserts.length, 1);
    assert.equal(store.upserts[0].context.bundle, "drift-only");
  });
});

describe("an owner-edited compose", () => {
  test("gets its own card saying where the changes belong", async () => {
    bundle("drift-edited", 'services:\n  web:\n    ports:\n      - "0.0.0.0:8555:5000"\n');
    put(home, "bundles/drift-edited/.crow-compose.edited", '{"compose":"docker-compose.yml"}\n');
    setInstalled([{ id: "drift-edited" }]);
    const store = fakeStore();
    const runner = dockerStub({ inspect: inspected({ "5000/tcp": [{ HostIp: WIDE, HostPort: "8555" }] }) });

    await detector.check(store, { crowHome: home, runner, log: silent });

    const card = store.upserts.find((c) => c.source === COMPOSE_EDITED_SOURCE);
    assert.ok(card, "the compose-edited card is raised");
    assert.equal(card.title, "Web's compose file has local changes");
    assert.match(card.why, /Crow did not update it/);
    assert.match(card.why, /docker-compose\.override\.yml/);
    assert.match(card.why, /remove them from the compose file so Crow can update it/);
    assert.deepEqual(card.remedies, [{ actionId: "open-extensions-page", kind: "link", label: "Open Extensions" }]);
  });

  test("the card resolves once the edit note is gone", async () => {
    bundle("drift-clean", 'services:\n  web:\n    ports:\n      - "127.0.0.1:8555:5000"\n');
    setInstalled([{ id: "drift-clean" }]);
    const store = fakeStore();
    const runner = dockerStub({ inspect: inspected({ "5000/tcp": [{ HostIp: "127.0.0.1", HostPort: "8555" }] }) });

    await detector.check(store, { crowHome: home, runner, log: silent });

    assert.deepEqual(store.upserts, []);
    assert.ok(store.resolved.includes(`${COMPOSE_EDITED_SOURCE}|bundle:drift-clean`));
  });
});

describe("the card's remedy and boot wiring", () => {
  test("the link action maps to the Extensions page in code, never a stored href", () => {
    assert.equal(LINK_REMEDIES["open-extensions-page"], "/dashboard/extensions");
    assert.equal(linkRemedyTarget({ actionId: "open-extensions-page", kind: "link" }), "/dashboard/extensions");
    assert.equal(linkRemedyTarget({ actionId: "https://example.invalid", kind: "link" }), null);
  });

  test("the drift check runs through the gateway's boot checks", () => {
    assert.ok(BOOT_CHECK_DETECTORS.some((d) => d.source === SOURCE));
  });
});
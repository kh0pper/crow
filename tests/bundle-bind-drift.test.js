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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
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
let REPO_DRIFT_SOURCE;
let COMPOSE_NEEDS_CONFIG_SOURCE;
let LINK_REMEDIES;
let linkRemedyTarget;
let BOOT_CHECK_DETECTORS;
let restoreCompose;
let setOwnerCheck;
let setAppBundles;
let originalAppBundles;
let sha256;
const silent = { warn() {}, log() {} };

before(async () => {
  home = mkdtempSync(join(tmpdir(), "crowhome-binddrift-"));
  process.env.CROW_HOME = home;
  const mod = await import("../servers/gateway/fix-it/detectors/bundle-bind-drift.js");
  detector = mod.default;
  SOURCE = mod.SOURCE;
  COMPOSE_EDITED_SOURCE = mod.COMPOSE_EDITED_SOURCE;
  REPO_DRIFT_SOURCE = mod.REPO_DRIFT_SOURCE;
  COMPOSE_NEEDS_CONFIG_SOURCE = mod.COMPOSE_NEEDS_CONFIG_SOURCE;
  const idx = await import("../servers/gateway/fix-it/index.js");
  LINK_REMEDIES = idx.LINK_REMEDIES;
  linkRemedyTarget = idx.linkRemedyTarget;
  BOOT_CHECK_DETECTORS = idx.BOOT_CHECK_DETECTORS;
  const remedy = await import("../servers/gateway/fix-it/remedies/restore-bundle-compose.js");
  restoreCompose = remedy.default;
  setOwnerCheck = remedy._setOwnerCheckForTest;
  ({ _setAppBundlesForTest: setAppBundles } = await import("../servers/gateway/bundles-config.js"));
  ({ APP_BUNDLES: originalAppBundles } = await import("../servers/gateway/bundles-config.js"));
  ({ sha256 } = await import("../servers/gateway/bundle-compose-state.js"));
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
    assert.match(card.why, /Move your changes into docker-compose\.override\.yml and restore the compose file/);
    assert.match(card.why, /docker-compose\.yml\.bak when Crow restores it/);
    // The restore action is owner-gated inside the remedy, never by the card.
    assert.deepEqual(card.remedies, [
      { actionId: "restore-bundle-compose", kind: "instant", label: "Restore Crow's compose", args: { bundle: "drift-edited" } },
      { actionId: "open-extensions-page", kind: "link", label: "Open Extensions" },
    ]);
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

// ---------------------------------------------------------------------------
// A card only for a publish that is actually reachable from other devices, and
// only for a real port (a range is not one port).
// ---------------------------------------------------------------------------
describe("only wide publishes are carded", () => {
  const compose = 'services:\n  web:\n    image: x\n    ports:\n      - "127.0.0.1:8555:5000"\n';

  test("an extra port bound to 127.0.0.1 is never carded", async () => {
    bundle("drift-extra-loopback", compose);
    setInstalled([{ id: "drift-extra-loopback" }]);
    const store = fakeStore();
    const runner = dockerStub({
      inspect: inspected({
        "5000/tcp": [{ HostIp: "127.0.0.1", HostPort: "8555" }],
        "9000/tcp": [{ HostIp: "127.0.0.1", HostPort: "9000" }],
      }),
    });

    await detector.check(store, { crowHome: home, runner, log: silent });

    assert.deepEqual(store.upserts, [], "a loopback extra port is nobody's business");
    assert.ok(store.resolved.includes(`${SOURCE}|bundle:drift-extra-loopback`));
  });

  test("a port range is skipped, never carded port by port", async () => {
    bundle("drift-range", compose);
    setInstalled([{ id: "drift-range" }]);
    const store = fakeStore();
    const runner = dockerStub({
      inspect: inspected({
        "5000/tcp": [{ HostIp: "127.0.0.1", HostPort: "8555" }],
        "8000-8002/tcp": [{ HostIp: WIDE, HostPort: "8000-8002" }],
      }),
    });

    await detector.check(store, { crowHome: home, runner, log: silent });

    assert.deepEqual(store.upserts, [], "a range is not compared port by port");
  });

  test("two services sharing a container port do not mask each other", async () => {
    bundle("drift-services", [
      "services:",
      "  web:",
      "    image: x",
      "    ports:",
      '      - "127.0.0.1:8555:5000"',
      "  api:",
      "    image: x",
      "    ports:",
      '      - "0.0.0.0:8600:5000"',
      "",
    ].join("\n"));
    setInstalled([{ id: "drift-services" }]);
    const rows = (binds) => [{
      Config: { Labels: { "com.docker.compose.service": binds.service } },
      NetworkSettings: { Ports: { "5000/tcp": [{ HostIp: binds.hostIp, HostPort: binds.hostPort }] } },
    }];
    const store = fakeStore();
    // `web` runs wide although ITS OWN port is declared on loopback; `api`'s wide
    // bind is what its own file declares. Only `web` drifts.
    const runner = dockerStub({
      inspect: [...rows({ service: "web", hostIp: WIDE, hostPort: "8555" }), ...rows({ service: "api", hostIp: WIDE, hostPort: "8600" })],
    });

    await detector.check(store, { crowHome: home, runner, log: silent });

    assert.equal(store.upserts.length, 1);
    assert.equal(store.upserts[0].context.bind, "0.0.0.0:8555");
    assert.equal(store.upserts[0].context.containerPort, "5000/tcp");
  });

  test("an override is part of the live model: a port it widens is not drift", async () => {
    bundle("drift-override-wide", 'services:\n  web:\n    image: x\n    ports:\n      - "127.0.0.1:8555:5000"\n');
    put(home, "bundles/drift-override-wide/docker-compose.override.yml", 'services:\n  web:\n    ports:\n      - "0.0.0.0:8555:5000"\n');
    setInstalled([{ id: "drift-override-wide" }]);
    const store = fakeStore();
    const runner = dockerStub({
      inspect: [{
        Config: { Labels: { "com.docker.compose.service": "web" } },
        NetworkSettings: { Ports: { "5000/tcp": [{ HostIp: WIDE, HostPort: "8555" }] } },
      }],
    });

    await detector.check(store, { crowHome: home, runner, log: silent });

    assert.deepEqual(store.upserts, [], "the owner widened it in the override on purpose");
  });

  test("a wide bind of a service the file does not publish at all is an extra port", async () => {
    bundle("drift-services-extra", [
      "services:",
      "  web:",
      "    image: x",
      "    ports:",
      '      - "127.0.0.1:8555:5000"',
      "  api:",
      "    image: x",
      "",
    ].join("\n"));
    setInstalled([{ id: "drift-services-extra" }]);
    const store = fakeStore();
    const runner = dockerStub({
      inspect: [{
        Config: { Labels: { "com.docker.compose.service": "api" } },
        NetworkSettings: { Ports: { "5000/tcp": [{ HostIp: WIDE, HostPort: "9600" }] } },
      }],
    });

    await detector.check(store, { crowHome: home, runner, log: silent });

    assert.equal(store.upserts.length, 1, "web's loopback declaration must not bless api's wide bind");
    assert.equal(store.upserts[0].context.bind, "0.0.0.0:9600");
  });
});

// ---------------------------------------------------------------------------
// The repo's compose is compared too: when the installed file is one Crow could
// not refresh, a restart cannot fix the bind — the OWNER's file keeps it open.
// ---------------------------------------------------------------------------
describe("the repo compose is tighter than an unrefreshable installed one", () => {
  const REPO_COMPOSE = 'services:\n  web:\n    image: x\n    ports:\n      - "127.0.0.1:8555:5000"\n';
  const INSTALLED_WIDE = 'services:\n  web:\n    image: x\n    ports:\n      - "0.0.0.0:8555:5000"\n';

  function repoBundle(id, compose = REPO_COMPOSE) {
    const root = mkdtempSync(join(tmpdir(), `crowrepo-binddrift-${id}-`));
    put(root, `${id}/manifest.json`, JSON.stringify({ id, name: "Web", version: "1.0.0", type: "bundle", docker: { composefile: "docker-compose.yml" } }));
    put(root, `${id}/docker-compose.yml`, compose);
    return root;
  }

  test("an edited compose + a wide running bind the repo closes → a separate card", async () => {
    const id = "drift-repo-edited";
    bundle(id, INSTALLED_WIDE);
    put(home, `bundles/${id}/.crow-compose.edited`, '{"compose":"docker-compose.yml"}\n');
    setInstalled([{ id }]);
    const store = fakeStore();
    const runner = dockerStub({ inspect: inspected({ "5000/tcp": [{ HostIp: WIDE, HostPort: "8555" }] }) });

    await detector.check(store, { crowHome: home, repoBundlesDir: repoBundle(id), runner, log: silent });

    const card = store.upserts.find((c) => c.source === REPO_DRIFT_SOURCE);
    assert.ok(card, "the repo-drift card is raised");
    assert.equal(card.dedupKey, `bundle:${id}:repo`);
    assert.equal(card.why, "Web is published to other devices; Crow now ships it on this computer only. "
      + "Restart won't change that while its compose file has local changes — see the other card.");
  });

  test("the unknown verdict gets the same card, worded for what Crow knows", async () => {
    const id = "drift-repo-unknown";
    bundle(id, INSTALLED_WIDE);
    const root = repoBundle(id);
    put(home, `bundles/${id}/.crow-compose.state.json`, `${JSON.stringify({
      installedSha: sha256(Buffer.from(INSTALLED_WIDE, "utf8")),
      repoComposeSha: sha256(Buffer.from(REPO_COMPOSE, "utf8")),
      verdict: "unknown",
    })}\n`);
    setInstalled([{ id }]);
    const store = fakeStore();
    const runner = dockerStub({ inspect: inspected({ "5000/tcp": [{ HostIp: WIDE, HostPort: "8555" }] }) });

    await detector.check(store, { crowHome: home, repoBundlesDir: root, runner, log: silent });

    const card = store.upserts.find((c) => c.source === REPO_DRIFT_SOURCE);
    assert.ok(card);
    assert.match(card.why, /Crow cannot tell whether the installed compose file has local changes/);
  });

  test("a port the owner declared in an override file is skipped (widened on purpose)", async () => {
    const id = "drift-repo-override";
    bundle(id, INSTALLED_WIDE);
    put(home, `bundles/${id}/docker-compose.override.yml`, 'services:\n  web:\n    ports:\n      - "0.0.0.0:8555:5000"\n');
    put(home, `bundles/${id}/.crow-compose.edited`, '{"compose":"docker-compose.yml"}\n');
    setInstalled([{ id }]);
    const store = fakeStore();
    const runner = dockerStub({ inspect: inspected({ "5000/tcp": [{ HostIp: WIDE, HostPort: "8555" }] }) });

    await detector.check(store, { crowHome: home, repoBundlesDir: repoBundle(id), runner, log: silent });

    assert.equal(store.upserts.filter((c) => c.source === REPO_DRIFT_SOURCE).length, 0);
    assert.ok(store.resolved.includes(`${REPO_DRIFT_SOURCE}|bundle:${id}:repo`));
  });

  test("a port the installed file already narrows is the restart card's job, not this one", async () => {
    const id = "drift-repo-narrowed";
    // The owner edited something else: their file already binds 127.0.0.1, so a
    // restart DOES fix this port — the "a restart won't change that" card would lie.
    bundle(id, REPO_COMPOSE);
    put(home, `bundles/${id}/.crow-compose.edited`, '{"compose":"docker-compose.yml"}\n');
    setInstalled([{ id }]);
    const store = fakeStore();
    const runner = dockerStub({ inspect: inspected({ "5000/tcp": [{ HostIp: WIDE, HostPort: "8555" }] }) });

    await detector.check(store, { crowHome: home, repoBundlesDir: repoBundle(id), runner, log: silent });

    assert.equal(store.upserts.filter((c) => c.source === REPO_DRIFT_SOURCE).length, 0);
    assert.equal(store.upserts.filter((c) => c.source === SOURCE).length, 1, "the restart card covers it");
  });

  test("no verdict (not edited, not unknown) → no repo card", async () => {
    const id = "drift-repo-current";
    bundle(id, INSTALLED_WIDE);
    setInstalled([{ id }]);
    const store = fakeStore();
    const runner = dockerStub({ inspect: inspected({ "5000/tcp": [{ HostIp: WIDE, HostPort: "8555" }] }) });

    await detector.check(store, { crowHome: home, repoBundlesDir: repoBundle(id), runner, log: silent });

    assert.equal(store.upserts.filter((c) => c.source === REPO_DRIFT_SOURCE).length, 0);
    assert.ok(store.resolved.includes(`${REPO_DRIFT_SOURCE}|bundle:${id}:repo`));
  });
});

// ---------------------------------------------------------------------------
// The shipped compose was not copied because Start would break on a missing key.
// ---------------------------------------------------------------------------
describe("a compose refresh kept back for configuration", () => {
  test("raises a card naming the key, and resolves once the note is gone", async () => {
    const id = "drift-needs-config";
    bundle(id, 'services:\n  web:\n    ports:\n      - "127.0.0.1:8555:5000"\n');
    put(home, `bundles/${id}/.crow-compose.needs-config`, `${JSON.stringify({ compose: "docker-compose.yml", missing: ["WEB_PORT"] })}\n`);
    setInstalled([{ id }]);
    const store = fakeStore();
    const runner = dockerStub({ inspect: inspected({ "5000/tcp": [{ HostIp: "127.0.0.1", HostPort: "8555" }] }) });

    await detector.check(store, { crowHome: home, runner, log: silent });

    const card = store.upserts.find((c) => c.source === COMPOSE_NEEDS_CONFIG_SOURCE);
    assert.ok(card);
    assert.equal(card.title, "Web's settings file was not updated");
    assert.equal(card.why, "Crow could not update Web's settings file: it needs WEB_PORT set first (Configure on its Extensions card).");
    assert.equal(card.context.key, "WEB_PORT");

    rmSync(join(home, `bundles/${id}/.crow-compose.needs-config`), { force: true });
    const second = fakeStore();
    await detector.check(second, { crowHome: home, runner, log: silent });
    assert.equal(second.upserts.filter((c) => c.source === COMPOSE_NEEDS_CONFIG_SOURCE).length, 0);
    assert.ok(second.resolved.includes(`${COMPOSE_NEEDS_CONFIG_SOURCE}|bundle:${id}`));
  });
});

// ---------------------------------------------------------------------------
// Ids reach a `join`: an id that is not a bundle id is dropped first.
// ---------------------------------------------------------------------------
describe("hostile or malformed installed records", () => {
  test("an id that is not a bundle id is skipped before any join", async () => {
    setInstalled([{ id: "../escape" }, { id: 7 }, { id: "drift-satellite-ok", mode: "satellite", host: "sat-1" }]);
    const store = fakeStore();
    const runner = dockerStub({ inspect: [] });

    await detector.check(store, { crowHome: home, runner, log: silent });

    assert.deepEqual(store.upserts, []);
    assert.equal(runner.calls.length, 0, "no docker call for a record the detector cannot use");
  });
});

// ---------------------------------------------------------------------------
// The restore action: owner only, keeps the owner's file as <compose>.bak.
// ---------------------------------------------------------------------------
describe("the restore-compose remedy", () => {
  const REPO_COMPOSE = 'services:\n  web:\n    image: x\n    ports:\n      - "127.0.0.1:8555:5000"\n';
  const OWNER_COMPOSE = 'services:\n  web:\n    image: x\n    ports:\n      - "0.0.0.0:8555:5000"\n    # mine\n';

  function fixture() {
    const repoRoot = mkdtempSync(join(tmpdir(), "crowrepo-restore-"));
    put(repoRoot, "restore-me/manifest.json", JSON.stringify({ id: "restore-me", name: "Web", version: "1.0.0", type: "bundle", docker: { composefile: "docker-compose.yml" } }));
    put(repoRoot, "restore-me/docker-compose.yml", REPO_COMPOSE);
    put(home, "bundles/restore-me/manifest.json", JSON.stringify({ id: "restore-me", version: "1.0.0", type: "bundle", docker: { composefile: "docker-compose.yml" } }));
    put(home, "bundles/restore-me/docker-compose.yml", OWNER_COMPOSE);
    put(home, "bundles/restore-me/.crow-compose.edited", '{"compose":"docker-compose.yml"}\n');
    return repoRoot;
  }

  test("refuses without the owner's own session, and changes nothing", async () => {
    const repoRoot = fixture();
    setAppBundles(repoRoot);
    try {
      const out = await restoreCompose({ bundle: "restore-me" }, { db: null, item: null });
      assert.equal(out.resolved, false);
      assert.match(out.message, /Only the owner/);
      assert.equal(readFileSync(join(home, "bundles/restore-me/docker-compose.yml"), "utf8"), OWNER_COMPOSE);
      assert.equal(existsSync(join(home, "bundles/restore-me/docker-compose.yml.bak")), false);
    } finally { setAppBundles(originalAppBundles); }
  });

  test("writes <compose>.bak, puts Crow's copy back, records it and clears the note", async () => {
    const repoRoot = fixture();
    setAppBundles(repoRoot);
    setOwnerCheck(async () => true);
    try {
      const out = await restoreCompose({ bundle: "restore-me" }, { db: null, item: null });
      assert.equal(out.resolved, true);
      assert.equal(readFileSync(join(home, "bundles/restore-me/docker-compose.yml.bak"), "utf8"), OWNER_COMPOSE, "the owner's copy is kept");
      assert.equal(readFileSync(join(home, "bundles/restore-me/docker-compose.yml"), "utf8"), REPO_COMPOSE);
      assert.equal(readFileSync(join(home, "bundles/restore-me/.crow-compose.sha256"), "utf8").trim(), sha256(Buffer.from(REPO_COMPOSE, "utf8")));
      assert.deepEqual(JSON.parse(readFileSync(join(home, "bundles/restore-me/.crow-compose.state.json"), "utf8")), {
        installedSha: sha256(Buffer.from(REPO_COMPOSE, "utf8")),
        repoComposeSha: sha256(Buffer.from(REPO_COMPOSE, "utf8")),
        verdict: "match",
      });
      assert.equal(existsSync(join(home, "bundles/restore-me/.crow-compose.edited")), false);
    } finally {
      setAppBundles(originalAppBundles);
      setOwnerCheck(null);
    }
  });

  test("refuses a bundle id that is not a bundle id", async () => {
    const out = await restoreCompose({ bundle: "../escape" }, { db: null, item: null });
    assert.equal(out.resolved, false);
  });
});
/**
 * The derived add-on profile (scripts/addon-sandbox/profile.mjs), the manifest
 * `sandbox` block's schema, and the `ownerSet` provenance the gateway records
 * in mcp-addons.json.
 *
 * Pure: scratch dirs under mkdtemp; bundles.js is imported only after CROW_HOME
 * points at a scratch dir (the same way tests/mcp-addons-secret-skip.test.js does).
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import {
  collectPastDefaults,
  composePortsFrom,
  deriveProfile,
  isLoopbackHost,
  parseHostValue,
  profileFor,
  scanCrowDb,
} from "../scripts/addon-sandbox/profile.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const NO_INSTALLED = join(REPO, "no-such-installed-bundles");

let B, scratch;
before(async () => {
  scratch = mkdtempSync(join(tmpdir(), "addon-profile-"));
  process.env.CROW_HOME = scratch;
  B = await import("../servers/gateway/routes/bundles.js");
});

// --- fixtures --------------------------------------------------------------

const BASE_MANIFEST = {
  id: "demo",
  name: "Demo",
  description: "a demo add-on",
  type: "bundle",
  category: "test",
  server: { command: "node", args: ["server/index.js"], envKeys: ["DEMO_URL"] },
  env_vars: [{ name: "DEMO_URL", default: "http://localhost:8000" }],
  ports: [],
  webUI: null,
};

function composePublishing(...lines) {
  return ["services:", "  app:", "    ports:", ...lines.map((l) => `      - ${l}`), ""].join("\n");
}

const unpublished = (manifest) => composePortsFrom("", manifest);

// --- hosts ---------------------------------------------------------------

test("no sandbox block: an owner-set URL field becomes an owner host, internet on", () => {
  const profile = deriveProfile(BASE_MANIFEST, { env: { DEMO_URL: "http://localhost:8000" }, ownerSet: ["DEMO_URL"] }, {});
  assert.equal(profile.network.internet, true);
  assert.deepEqual(profile.network.hosts, [
    { host: "localhost", port: 8000, scheme: "http", from: "DEMO_URL", source: "owner" },
  ]);
});

test("a default that is this add-on's own loopback publish counts as its own service", () => {
  const composePorts = composePortsFrom(composePublishing('"127.0.0.1:8000:8000"'), BASE_MANIFEST);
  assert.deepEqual(composePorts, [8000]);
  const profile = deriveProfile(BASE_MANIFEST, {}, { composePorts });
  assert.deepEqual(profile.network.hosts, [
    { host: "localhost", port: 8000, scheme: "http", from: "DEMO_URL", source: "default-own-service" },
  ]);
  assert.deepEqual(profile.refused, []);
});

test("a default with no matching publish is refused, not added", () => {
  const profile = deriveProfile(BASE_MANIFEST, {}, { composePorts: unpublished(BASE_MANIFEST) });
  assert.deepEqual(profile.network.hosts, []);
  assert.deepEqual(profile.refused, [
    { what: "host:DEMO_URL", reason: "a default address that is not this add-on's own published service" },
  ]);
});

test("a manifest's ports and webUI.port never make a port this add-on's own service", () => {
  const manifest = {
    ...BASE_MANIFEST,
    ports: [8000],
    webUI: { port: 8000, label: "X" },
  };
  const elsewhere = composePublishing('"127.0.0.1:8001:8001"');
  const unlisted = deriveProfile(manifest, {}, { composePorts: composePortsFrom(elsewhere, manifest) });
  assert.deepEqual(unlisted.network.hosts, []);
  assert.deepEqual(unlisted.refused, [
    { what: "host:DEMO_URL", reason: "a default address that is not this add-on's own published service" },
  ]);
  assert.deepEqual(unlisted.labelParts.map((p) => p.kind), ["internet", "own-folder"]);

  // The label still comes from webUI, but only a real publish makes the host count.
  const published = composePortsFrom(composePublishing('"127.0.0.1:8000:8000"'), manifest);
  assert.deepEqual(published, [8000]);
  const own = deriveProfile(manifest, {}, { composePorts: published });
  assert.deepEqual(own.network.hosts, [
    { host: "localhost", port: 8000, scheme: "http", from: "DEMO_URL", source: "default-own-service" },
  ]);
  assert.deepEqual(own.refused, []);
  assert.equal(own.label.en[1], "reach X on this computer");
});

test("a compose-published default is this add-on's own service only for a repo-sourced profile", () => {
  const composePorts = composePortsFrom(composePublishing('"127.0.0.1:8000:8000"'), BASE_MANIFEST);
  const repo = deriveProfile(BASE_MANIFEST, {}, { composePorts, source: "repo" });
  assert.deepEqual(repo.network.hosts, [
    { host: "localhost", port: 8000, scheme: "http", from: "DEMO_URL", source: "default-own-service" },
  ]);
  assert.deepEqual(repo.refused, []);

  // The installed copy's compose could have been written by anything: the port is only a
  // promise, and the wall reaches it through this add-on's own running compose project.
  const installed = deriveProfile(BASE_MANIFEST, {}, { composePorts, source: "installed" });
  assert.deepEqual(installed.network.hosts, [
    { host: "localhost", port: 8000, scheme: "http", from: "DEMO_URL", source: "default-installed-compose" },
  ]);
  assert.deepEqual(installed.refused, []);
  // Both sources label the same way.
  assert.deepEqual(installed.labelParts.map((p) => p.kind), repo.labelParts.map((p) => p.kind));
});

test("a default that names Crow's gateway port is refused, whatever the policy source", () => {
  const manifest = { ...BASE_MANIFEST, env_vars: [{ name: "DEMO_URL", default: "http://localhost:3001" }] };
  const composePorts = composePortsFrom(composePublishing('"127.0.0.1:3001:3001"'), manifest);
  assert.deepEqual(composePorts, [3001]);
  for (const source of ["repo", "installed"]) {
    const profile = deriveProfile(manifest, {}, { composePorts, source, gatewayPort: 3001 });
    assert.deepEqual(profile.network.hosts, [], `${source}: not added`);
    assert.deepEqual(profile.refused, [
      { what: "host:DEMO_URL", reason: "a default address never names Crow's gateway port" },
    ], `${source}: refused with its own reason`);
  }
});

test("a default naming a port nothing publishes (127.0.0.1:2019) is refused", () => {
  const manifest = { ...BASE_MANIFEST, env_vars: [{ name: "DEMO_URL", default: "http://127.0.0.1:2019" }] };
  const profile = deriveProfile(manifest, {}, { composePorts: composePortsFrom(composePublishing('"127.0.0.1:8000:8000"'), manifest) });
  assert.deepEqual(profile.network.hosts, []);
  assert.deepEqual(profile.refused, [
    { what: "host:DEMO_URL", reason: "a default address that is not this add-on's own published service" },
  ]);
});

test("an internet-only default is covered by the internet, so it is not refused", () => {
  const manifest = { ...BASE_MANIFEST, env_vars: [{ name: "DEMO_URL", default: "https://api.example.net/v1" }] };
  const profile = deriveProfile(manifest, {}, { composePorts: unpublished(manifest) });
  assert.deepEqual(profile.network.hosts, []);
  assert.deepEqual(profile.refused, []);
  assert.equal(profile.network.internet, true);
});

test("a sandbox network block naming an unset field refuses it instead of adding it", () => {
  const manifest = {
    ...BASE_MANIFEST,
    env_vars: [{ name: "NOPE", required: true }],
    sandbox: { network: { internet: false, hosts: ["env:NOPE"] } },
  };
  const profile = deriveProfile(manifest, {}, {});
  assert.equal(profile.network.internet, false);
  assert.deepEqual(profile.network.hosts, []);
  assert.deepEqual(profile.refused, [{ what: "host:NOPE", reason: "the field NOPE is not set" }]);
});

test("a sandbox network block naming a field that is not an address refuses it", () => {
  const manifest = {
    ...BASE_MANIFEST,
    env_vars: [{ name: "DEMO_URL", default: "not an address" }],
    sandbox: { network: { hosts: ["env:DEMO_URL"] } },
  };
  const profile = deriveProfile(manifest, {}, {});
  assert.deepEqual(profile.network.hosts, []);
  assert.deepEqual(profile.refused, [{ what: "host:DEMO_URL", reason: "the field DEMO_URL is not a host address" }]);
});

// --- schema -----------------------------------------------------------------

test("the manifest schema takes env: hosts only, and a literal host is an error", () => {
  const schema = JSON.parse(readFileSync(join(REPO, "registry", "manifest.schema.json"), "utf8"));
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const base = { id: "acme", name: "Acme", description: "an add-on", type: "mcp-server", category: "test" };

  assert.equal(validate({ ...base, sandbox: { network: { hosts: ["localhost:8000"] } } }), false);
  assert.equal(validate({ ...base, sandbox: { network: { hosts: ["http://localhost:8000"] } } }), false);
  assert.equal(validate({ ...base, sandbox: { network: { hosts: ["env:ACME_URL"], internet: true } } }), true);
  assert.equal(validate({
    ...base,
    sandbox: {
      network: "none",
      doors: ["acme"],
      files: { read: ["env:ACME_KEY_FILE"], write: ["env:ACME_OUT_DIR"], oauthDir: "env:ACME_TOKEN_DIR" },
      crowDb: false,
      ownEnvFile: true,
    },
  }), true);
  assert.equal(validate({ ...base, sandbox: { network: "somewhere" } }), false);
  assert.equal(validate({ ...base, sandbox: { unknownField: true } }), false);
});

// --- doors ----------------------------------------------------------------

test("a manifest can only name its own door set; another id's doors are refused", () => {
  const manifest = { ...BASE_MANIFEST, id: "notstudio", sandbox: { doors: ["studio"] } };
  const profile = deriveProfile(manifest, {}, {});
  assert.deepEqual(profile.doors, []);
  assert.deepEqual(profile.refused.filter((r) => r.what.startsWith("door:")), [
    { what: "door:studio", reason: "an add-on can only name its own door set" },
  ]);
});

test("a manifest naming its own door set keeps it; an unknown one is refused", () => {
  const kiosk = deriveProfile({ ...BASE_MANIFEST, id: "kiosk" }, {}, {});
  assert.deepEqual(kiosk.doors, ["kiosk"]);
  const bogus = deriveProfile({ ...BASE_MANIFEST, id: "demo", sandbox: { doors: ["demo"] } }, {}, {});
  assert.deepEqual(bogus.doors, []);
  assert.deepEqual(bogus.refused.filter((r) => r.what.startsWith("door:")), [
    { what: "door:demo", reason: "no such door set" },
  ]);
});

test("doors and state dirs are first-party only, whatever id a third-party bundle claims", () => {
  // A third-party bundle carrying a first-party id gets neither.
  const kioskInstalled = deriveProfile({ ...BASE_MANIFEST, id: "kiosk" }, {}, { source: "installed" });
  assert.deepEqual(kioskInstalled.doors, []);
  const browserInstalled = deriveProfile({ ...BASE_MANIFEST, id: "browser" }, {}, { source: "installed" });
  assert.deepEqual(browserInstalled.files.state, []);

  // Its own manifest asking for that door is refused, not granted.
  const claimed = deriveProfile(
    { ...BASE_MANIFEST, id: "kiosk", sandbox: { doors: ["kiosk"] } },
    {},
    { source: "installed" },
  );
  assert.deepEqual(claimed.doors, []);
  assert.deepEqual(claimed.refused.filter((r) => r.what.startsWith("door:")), [
    { what: "door:kiosk", reason: "doors are for first-party add-ons only" },
  ]);

  // The same ids read from the repo copy keep theirs.
  const kioskRepo = deriveProfile({ ...BASE_MANIFEST, id: "kiosk" }, {}, { source: "repo" });
  assert.deepEqual(kioskRepo.doors, ["kiosk"]);
  const browserRepo = deriveProfile({ ...BASE_MANIFEST, id: "browser" }, {}, { source: "repo" });
  assert.deepEqual(browserRepo.files.state, ["browser-sessions", "browser-downloads", "browser-exports"]);
});

test("an id that names an Object.prototype member gets no doors and no state dirs", () => {
  for (const id of ["__proto__", "constructor", "toString"]) {
    const plain = deriveProfile({ ...BASE_MANIFEST, id }, {}, { source: "repo" });
    assert.deepEqual(plain.doors, [], `${id}: no door for a prototype member`);
    assert.deepEqual(plain.files.state, [], `${id}: no state dirs for a prototype member`);

    const named = deriveProfile({ ...BASE_MANIFEST, id, sandbox: { doors: [id] } }, {}, { source: "repo" });
    assert.deepEqual(named.doors, [], `${id}: a named door is still no door`);
    assert.deepEqual(named.refused.filter((r) => r.what.startsWith("door:")), [
      { what: `door:${id}`, reason: "no such door set" },
    ]);
  }
});

// --- files ----------------------------------------------------------------

test("a file field is bound only when the owner chose the path", () => {
  const manifest = {
    ...BASE_MANIFEST,
    id: "acme",
    sandbox: {
      files: { read: ["env:DATA_FILE"], write: ["env:OUT_DIR"], oauthDir: "env:TOKEN_DIR" },
    },
    env_vars: [
      { name: "DATA_FILE", default: "/srv/acme/in.json" },
      { name: "OUT_DIR", default: "/srv/acme/out" },
      { name: "TOKEN_DIR", default: "/srv/acme/tokens" },
    ],
  };

  // The manifest default is not a choice, so nothing is bound and each says why.
  const defaulted = deriveProfile(manifest, {}, {});
  assert.deepEqual(defaulted.files, { read: [], write: [], oauthDir: null, state: [] });
  assert.deepEqual(defaulted.labelParts.map((p) => p.kind), ["internet", "own-folder"]);
  const fileRefusals = defaulted.refused.filter((r) => r.what.startsWith("file:"));
  assert.deepEqual(fileRefusals.map((r) => r.what).sort(), ["file:DATA_FILE", "file:OUT_DIR", "file:TOKEN_DIR"]);
  for (const refusal of fileRefusals) assert.equal(refusal.reason, "a default path the owner did not choose");

  // The same values, held as owner-entered, are bound.
  const owned = deriveProfile(manifest, {
    env: { DATA_FILE: "/srv/acme/in.json", OUT_DIR: "/srv/acme/out", TOKEN_DIR: "/srv/acme/tokens" },
    ownerSet: ["DATA_FILE", "OUT_DIR", "TOKEN_DIR"],
  }, {});
  assert.deepEqual(owned.files, {
    read: [{ from: "DATA_FILE", path: "/srv/acme/in.json", source: "owner" }],
    write: [{ from: "OUT_DIR", path: "/srv/acme/out", source: "owner" }],
    oauthDir: { from: "TOKEN_DIR", path: "/srv/acme/tokens", source: "owner" },
    state: [],
  });
  assert.deepEqual(owned.refused, []);
  assert.deepEqual(owned.labelParts.map((p) => p.kind), ["internet", "own-folder", "oauth-dir"]);
});

// --- crow.db scan ---------------------------------------------------------

test("the crow.db scan sees real imports and not the app-root existence probe", () => {
  assert.equal(scanCrowDb(join(REPO, "bundles", "funkwhale", "server")), true, "funkwhale's relative import");
  assert.equal(scanCrowDb(join(REPO, "bundles", "kiosk", "server")), false, "kiosk only probes with existsSync");
  assert.equal(scanCrowDb(join(REPO, "bundles", "meta-glasses", "server")), true, "meta-glasses' pathToFileURL(join(…))");
});

test("a declared crowDb:false contradicted by the scan stays true and is refused", () => {
  const manifest = { ...BASE_MANIFEST, sandbox: { crowDb: false } };
  const profile = deriveProfile(manifest, {}, { crowDbScan: true });
  assert.equal(profile.crowDb, true);
  assert.ok(profile.refused.some((r) => r.what === "crowDb" && r.reason === "profile error: the server code opens crow.db"));
  assert.equal(profile.label.en.at(-1), "can read Crow's stored keys and change its database");
});

// --- compose ports --------------------------------------------------------

test("compose ports: only 127.0.0.1 over TCP, with ${VAR:-default} resolved", () => {
  const text = [
    "services:",
    "  app:",
    "    ports:",
    '      - "${CROW_TAILSCALE_IP:-127.0.0.1}:8003:8000"',
    '      - "0.0.0.0:443:443"',
    "      - 127.0.0.1:8555:8555/udp",
    '      - "${X:?set}:9:9"',
    '      - "${UNSET_ONLY}"',
    "      - 127.0.0.1:9100:8000",
    "      - 8080:80",
    "    environment:",
    "      - LISTED_ELSEWHERE=1",
    "",
  ].join("\n");
  assert.deepEqual(composePortsFrom(text, { ports: [], webUI: null }), [8003, 9100]);
});

test("compose ports: a manifest's ports and webUI.port never add one", () => {
  assert.deepEqual(composePortsFrom("", { ports: [8000], webUI: { port: 8000 } }), []);
  assert.deepEqual(composePortsFrom("", { ports: [5006, 5006], webUI: { port: 5006 } }), []);
  // A list item outside a ports block is not a publish.
  assert.deepEqual(composePortsFrom("services:\n  app:\n    command:\n      - 127.0.0.1:9999:9999\n", { ports: [], webUI: null }), []);
});

// --- addresses ------------------------------------------------------------

test("loopback and address parsing", () => {
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("api.localhost"), true);
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("127.9.9.9"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("[::1]"), true);
  assert.equal(isLoopbackHost("128.0.0.1"), false);
  assert.equal(isLoopbackHost("10.0.0.1"), false);

  assert.deepEqual(parseHostValue("http://localhost:8000"), { host: "localhost", port: 8000, scheme: "http" });
  assert.deepEqual(parseHostValue("https://api.example.net"), { host: "api.example.net", port: 443, scheme: "https" });
  assert.deepEqual(parseHostValue("wss://example.net:8443/x"), { host: "example.net", port: 8443, scheme: "wss" });
  assert.deepEqual(parseHostValue("http://[::1]:9000"), { host: "::1", port: 9000, scheme: "http" });
  assert.deepEqual(parseHostValue("services.internal:7800"), { host: "services.internal", port: 7800, scheme: "tcp" });
  assert.deepEqual(parseHostValue("[::1]:7800"), { host: "::1", port: 7800, scheme: "tcp" });
  assert.equal(parseHostValue(""), null);
  assert.equal(parseHostValue("localhost"), null);
  assert.equal(parseHostValue("ftp://example.net/x"), null);
  assert.equal(parseHostValue("http://example.net:70000"), null);
});

// --- ownerSet provenance --------------------------------------------------

const OWNER_MANIFEST = {
  id: "acme",
  name: "Acme",
  description: "an add-on",
  type: "mcp-server",
  category: "test",
  server: { command: "node", args: ["server/index.js"], envKeys: ["X", "G", "D"] },
  env_vars: [{ name: "X", required: true }, { name: "D", default: "the-default" }, { name: "G", generate: "secret" }],
};

test("mcpAddonEntryFor records the owner-entered keys only", () => {
  const edited = B.mcpAddonEntryFor(OWNER_MANIFEST, { X: "typed" }, { edited: ["X"], owner: true });
  assert.deepEqual(edited.ownerSet, ["X"]);

  // A requested value equal to its manifest default, not edited: not the owner's.
  const atDefault = B.mcpAddonEntryFor(OWNER_MANIFEST, { D: "the-default" }, { owner: true });
  assert.equal("ownerSet" in atDefault, false);

  // A value that differs from the default is owner-entered even without the form's list.
  const differs = B.mcpAddonEntryFor(OWNER_MANIFEST, { D: "typed-instead" }, { owner: true });
  assert.deepEqual(differs.ownerSet, ["D"]);

  // A generated key is minted by Crow, never typed.
  const generated = B.mcpAddonEntryFor(OWNER_MANIFEST, { G: "s3cret-value" }, { generatedKeys: ["G"], owner: true });
  assert.equal("ownerSet" in generated, false);

  // A key with no default at all, not edited: the form just re-sent a filled field.
  const noDefault = B.mcpAddonEntryFor(OWNER_MANIFEST, { X: "typed" }, { owner: true });
  assert.equal("ownerSet" in noDefault, false);

  // Without the caller's proof that this is the local owner's own write: no provenance.
  assert.equal("ownerSet" in B.mcpAddonEntryFor(OWNER_MANIFEST, { X: "typed" }, { edited: ["X"] }), false);

  // Nothing owner-entered: the field is absent, so old entries keep their shape.
  assert.equal("ownerSet" in B.mcpAddonEntryFor(OWNER_MANIFEST), false);
});

test("applyEnvToMcpAddons records the owner-typed keys it writes", () => {
  const path = join(scratch, "mcp-addons-configure.json");
  writeFileSync(path, JSON.stringify({ acme: { command: "node", args: [], env: { D: "the-default" } } }));
  assert.equal(B.applyEnvToMcpAddons("acme", { X: "typed", D: "the-default" }, path, OWNER_MANIFEST, { edited: ["X"], owner: true }), true);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).acme.ownerSet, ["X"]);
});

test("applyEnvToMcpAddons seeds a legacy entry from the past-defaults rule", () => {
  // A legacy value that equals the current manifest default is not the owner's.
  const equalsDefault = join(scratch, "mcp-addons-legacy-1.json");
  writeFileSync(equalsDefault, JSON.stringify({ acme: { command: "node", args: [], env: { D: "the-default" } } }));
  B.applyEnvToMcpAddons("acme", { D: "typed-instead" }, equalsDefault, OWNER_MANIFEST, { owner: true });
  assert.deepEqual(JSON.parse(readFileSync(equalsDefault, "utf8")).acme.ownerSet, ["D"]);

  // A legacy value matching no default at all was owner-entered, and survives a save that
  // writes the current default over it.
  const otherValue = join(scratch, "mcp-addons-legacy-2.json");
  writeFileSync(otherValue, JSON.stringify({ acme: { command: "node", args: [], env: { D: "typed-before-this-change" } } }));
  B.applyEnvToMcpAddons("acme", { D: "the-default" }, otherValue, OWNER_MANIFEST, { owner: true });
  assert.deepEqual(JSON.parse(readFileSync(otherValue, "utf8")).acme.ownerSet, ["D"]);
});

test("a legacy value that matches an older shipped default counts as a default, not as owner-set", () => {
  const manifest = { ...OWNER_MANIFEST, env_vars: [{ name: "DEMO_URL", default: "http://localhost:8000" }] };
  const pastDefaults = { DEMO_URL: ["http://127.0.0.1:8080", "http://localhost:8000"] };
  const composePorts = [8080];

  const older = deriveProfile(manifest, { env: { DEMO_URL: "http://127.0.0.1:8080" } }, { pastDefaults, composePorts });
  assert.deepEqual(older.network.hosts, [
    { host: "127.0.0.1", port: 8080, scheme: "http", from: "DEMO_URL", source: "default-own-service" },
  ]);

  const typed = deriveProfile(manifest, { env: { DEMO_URL: "http://127.0.0.1:9999" } }, { pastDefaults, composePorts });
  assert.deepEqual(typed.network.hosts, [
    { host: "127.0.0.1", port: 9999, scheme: "http", from: "DEMO_URL", source: "owner" },
  ]);
});

test("collectPastDefaults collects every version's defaults, sorted, and skips an unparsable one", () => {
  const repoRoot = mkdtempSync(join(scratch, "repo-"));
  mkdirSync(join(repoRoot, "bundles", "demo"), { recursive: true });
  writeFileSync(join(repoRoot, "bundles", "demo", "manifest.json"), JSON.stringify({
    id: "demo",
    env_vars: [{ name: "B_URL", default: "http://localhost:2" }],
  }));
  const versions = {
    aaaa: JSON.stringify({ id: "demo", env_vars: [{ name: "B_URL", default: "http://localhost:1" }, { name: "A_URL", default: "http://localhost:3" }] }),
    bbbb: "{ this version does not parse",
  };
  const runGit = (args) => {
    if (args[0] === "log") return "aaaa\nbbbb\n";
    if (args[0] === "show") return versions[String(args[1]).split(":")[0]];
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
  assert.deepEqual(collectPastDefaults({ repoRoot, runGit }), {
    demo: { A_URL: ["http://localhost:3"], B_URL: ["http://localhost:1", "http://localhost:2"] },
  });
});

// --- policy source --------------------------------------------------

test("the repo copy wins over an edited installed copy, and the difference is recorded", () => {
  const appBundlesDir = mkdtempSync(join(scratch, "app-"));
  const installedBundlesDir = mkdtempSync(join(scratch, "installed-"));
  const repoManifest = {
    id: "demo",
    name: "Demo",
    description: "demo",
    type: "bundle",
    category: "test",
    env_vars: [{ name: "DEMO_URL", default: "http://localhost:8000" }],
  };
  const installedManifest = { ...repoManifest, sandbox: { network: "none" } };
  mkdirSync(join(appBundlesDir, "demo"), { recursive: true });
  mkdirSync(join(installedBundlesDir, "demo"), { recursive: true });
  writeFileSync(join(appBundlesDir, "demo", "manifest.json"), JSON.stringify(repoManifest));
  writeFileSync(join(installedBundlesDir, "demo", "manifest.json"), JSON.stringify(installedManifest));

  const profile = profileFor({ id: "demo", entry: {}, appBundlesDir, installedBundlesDir });
  assert.equal(profile.source, "repo");
  // The installed copy says "none"; the repo copy (no block) says internet.
  assert.equal(profile.network.internet, true);
  assert.deepEqual(profile.refused, [
    { what: "installed manifest differs", reason: "first-party policy is read from the repo copy" },
    { what: "host:DEMO_URL", reason: "a default address that is not this add-on's own published service" },
  ]);
});

test("state dirs come from the core allowlist for first-party ids only", () => {
  const appBundlesDir = mkdtempSync(join(scratch, "app-state-"));
  const installedBundlesDir = mkdtempSync(join(scratch, "installed-state-"));
  const manifest = (id) => ({ id, name: id, description: id, type: "bundle", category: "test", env_vars: [] });

  mkdirSync(join(appBundlesDir, "android"), { recursive: true });
  writeFileSync(join(appBundlesDir, "android", "manifest.json"), JSON.stringify(manifest("android")));
  mkdirSync(join(appBundlesDir, "browser"), { recursive: true });
  writeFileSync(join(appBundlesDir, "browser", "manifest.json"), JSON.stringify(manifest("browser")));
  mkdirSync(join(installedBundlesDir, "browser"), { recursive: true });
  writeFileSync(join(installedBundlesDir, "browser", "manifest.json"), JSON.stringify(manifest("browser")));

  const android = profileFor({ id: "android", entry: {}, appBundlesDir, installedBundlesDir });
  assert.deepEqual(android.files.state, []);

  const repoBrowser = profileFor({ id: "browser", entry: {}, appBundlesDir, installedBundlesDir });
  assert.equal(repoBrowser.source, "repo");
  assert.deepEqual(repoBrowser.files.state, ["browser-sessions", "browser-downloads", "browser-exports"]);

  // The same id read from the installed copy only: no state dirs, no doors.
  const installedOnly = profileFor({ id: "browser", entry: {}, appBundlesDir: join(scratch, "no-app-bundles"), installedBundlesDir });
  assert.equal(installedOnly.source, "installed");
  assert.deepEqual(installedOnly.files.state, []);
});

// --- labels ---------------------------------------------------------

test("labels: one sentence per part, in a fixed order, and never the word 'contained'", () => {
  const paperless = profileFor({ id: "paperless", entry: {}, appBundlesDir: join(REPO, "bundles"), installedBundlesDir: NO_INSTALLED });
  assert.deepEqual(paperless.label.en, [
    "use the internet",
    "reach Paperless-ngx on this computer",
    "keep files in its own folder",
  ]);
  assert.deepEqual(paperless.label.es, [
    "usar internet",
    "acceder a Paperless-ngx en este equipo",
    "guardar archivos en su propia carpeta",
  ]);

  const studio = profileFor({ id: "studio", entry: {}, appBundlesDir: join(REPO, "bundles"), installedBundlesDir: NO_INSTALLED });
  assert.equal(studio.crowDb, true);
  assert.equal(studio.label.en.length, studio.labelParts.length);
  assert.equal(studio.label.en.at(-1), "can read Crow's stored keys and change its database");
  assert.equal(studio.label.es.at(-1), "puede leer las claves guardadas de Crow y cambiar su base de datos");
  assert.ok(studio.labelParts.some((p) => p.kind === "own-folder"));

  for (const profile of [paperless, studio]) {
    for (const phrase of [...profile.label.en, ...profile.label.es]) {
      assert.doesNotMatch(phrase, /contained/i);
    }
  }
});

test("an own-folder, an oauth dir and a crowDb part appear in that order", () => {
  const manifest = {
    ...BASE_MANIFEST,
    id: "acme",
    sandbox: {
      network: { internet: false, hosts: ["env:DEMO_URL"] },
      files: { oauthDir: "env:DEMO_DIR" },
    },
    env_vars: [
      { name: "DEMO_URL" },
      { name: "DEMO_DIR", default: "~/.config/acme" },
    ],
  };
  const profile = deriveProfile(
    manifest,
    { env: { DEMO_URL: "acme-api.internal:7800", DEMO_DIR: "~/.config/acme" }, ownerSet: ["DEMO_URL", "DEMO_DIR"] },
    { crowDbScan: true },
  );
  assert.deepEqual(profile.labelParts.map((p) => p.kind), ["network-host", "own-folder", "oauth-dir", "crow-db"]);
  assert.deepEqual(profile.network.hosts, [
    { host: "acme-api.internal", port: 7800, scheme: "tcp", from: "DEMO_URL", source: "owner" },
  ]);
  assert.deepEqual(profile.files.oauthDir, { from: "DEMO_DIR", path: "~/.config/acme", source: "owner" });
  assert.equal(profile.label.en[0], "reach acme-api.internal:7800 on your network");
  assert.equal(profile.label.en[2], "use the sign-in folder you chose");
});

// --- the id profileFor is asked about --------------------------------------

test("profileFor refuses an id that is not an add-on id, before it joins it onto a path", () => {
  const appBundlesDir = join(REPO, "bundles");
  for (const id of ["../x", "a/b", "__proto__"]) {
    assert.throws(
      () => profileFor({ id, entry: {}, appBundlesDir, installedBundlesDir: NO_INSTALLED }),
      /^Error: invalid add-on id$/,
      `${id} is not an add-on id`,
    );
  }
  for (const id of ["", "Demo", "demo_x", ".hidden", null, undefined, 42]) {
    assert.throws(() => profileFor({ id, entry: {}, appBundlesDir, installedBundlesDir: NO_INSTALLED }), /invalid add-on id/);
  }
  // A real id still goes through, so the guard is on the id, not on profileFor itself.
  const kiosk = profileFor({ id: "kiosk", entry: {}, appBundlesDir, installedBundlesDir: NO_INSTALLED });
  assert.equal(kiosk.id, "kiosk");
});

test("profileFor refuses a manifest whose own id is not the one asked for", () => {
  const appBundlesDir = mkdtempSync(join(scratch, "app-mismatch-"));
  // The directory is named 'demo', the manifest claims 'other'.
  mkdirSync(join(appBundlesDir, "demo"), { recursive: true });
  writeFileSync(join(appBundlesDir, "demo", "manifest.json"), JSON.stringify({ ...BASE_MANIFEST, id: "other" }));
  assert.throws(
    () => profileFor({ id: "demo", entry: {}, appBundlesDir, installedBundlesDir: NO_INSTALLED }),
    /^Error: manifest id does not match$/,
  );

  // The same tree, asked for by the id its manifest carries, is served.
  mkdirSync(join(appBundlesDir, "other"), { recursive: true });
  writeFileSync(join(appBundlesDir, "other", "manifest.json"), JSON.stringify({ ...BASE_MANIFEST, id: "other" }));
  const matched = profileFor({ id: "other", entry: {}, appBundlesDir, installedBundlesDir: NO_INSTALLED });
  assert.equal(matched.id, "other");
  assert.equal(matched.source, "repo");
});